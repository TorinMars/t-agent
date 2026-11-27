'use strict';
// VS Code in the browser, on the page's own origin: `/vscode/<engine id>/...` (HTTP and WebSocket) is passed to VS Code on that engine. See
// "VS Code in the browser: the page server" in docs/design/vscode-web-proxy.md.
//
// - Launch: the page's start route (routes/tasks.js for this engine, routes/remote-servers.js for a remote one) adds `open_url` with a single-use
//   ticket (`tvl_`, 30 s, in memory). The first GET with `ta_launch=<ticket>` exchanges it for the httpOnly cookie `ta_vscode` (Path=/vscode/<id>/,
//   SameSite=Lax, Secure on HTTPS), bound to the session that asked, and redirects to the same address without the ticket.
// - Every other request needs that cookie and a session that is still signed in. Anything else gets the same 404 as an unknown address.
// - Transports: this engine in-process (services/vscode-local-transport.js), a remote engine over HTTP(S) with its Engine token, or a service link's
//   tunnel (lib/service-link-tunnel.js), both to `/v1/vscode/web/<base64url of the public host><browser path>` (Contract B of the engine).
// - Only a short allowlist of request headers goes on (never cookie, origin, forwarded or x-* headers), and only the tunnel's response headers come back.
//
// Nothing here logs a query string, a ticket, a cookie or a token.
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const { sendNotFound } = require('../lib/login-gate');
const { closeWebSocket } = require('../lib/websocket-close');
const { isTunnelBase, linkIdOf, getHub, ALLOWED_RESPONSE_HEADERS } = require('../lib/service-link-tunnel');

const ENGINE_ID = /^[A-Za-z0-9-]{1,64}$/;
const PUBLIC_HOST = /^[A-Za-z0-9.\-[\]:]{1,255}$/;
const COOKIE_NAME = 'ta_vscode';
const TICKET_PARAM = 'ta_launch';
const TICKET_PREFIX = 'tvl_';
const COOKIE_PREFIX = 'tvc_';
// The request headers VS Code needs, all within the tunnel's allowlist; content-length only matters to a direct request (the tunnel frames bodies itself).
// Not accept-encoding: VS Code answers uncompressed, and this server compresses text for the browser.
const FORWARDED_REQUEST_HEADERS = ['content-type', 'content-length', 'accept', 'range', 'if-none-match'];
const BODYLESS = new Set(['GET', 'HEAD']);
const MAX_TUNNEL_WS_MESSAGE = 32 * 1024 * 1024; // the tunnel's limit of one WebSocket message (lib/service-link-tunnel.js)
const WS_HIGH_WATER = 4 * 1024 * 1024;
const WS_LOW_WATER = 1024 * 1024;
const MAX_PENDING_TICKETS = 1000;

const DEFAULTS = Object.freeze({
  ticketTtlMs: 30_000,
  headTimeoutMs: 30_000,
  tunnelConcurrency: 24, // of the 128 streams a tunnel has, shared with terminals and everything else
  sweepMs: 30_000,
  sessionCheckMs: 1_000,
});

const safeCode = (value, fallback = 'REMOTE_CONNECTION_FAILED') => (typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value) ? value : fallback);
const randomToken = prefix => `${prefix}${crypto.randomBytes(24).toString('base64url')}`;
const unref = timer => { if (timer && timer.unref) timer.unref(); return timer; };

// The browser path, checked and re-encoded segment by segment, its query without the ticket, and the ticket. Null for anything that is not a plain
// path under /vscode/<engine id>/: `..`, `.`, empty inner segments, encoded separators (%2f, %5c), an encoded `%` and control characters are refused.
function parseBrowserTarget(rawUrl) {
  const raw = String(rawUrl || '');
  const question = raw.indexOf('?');
  const rawPath = question < 0 ? raw : raw.slice(0, question);
  const rawQuery = question < 0 ? '' : raw.slice(question + 1);
  const match = /^\/vscode\/([A-Za-z0-9-]{1,64})(\/[^?#]*)$/.exec(rawPath);
  if (!match) return null;
  const engineId = match[1];
  const parts = match[2].slice(1).split('/');
  const clean = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '' && index === parts.length - 1) { clean.push(''); continue; }
    let decoded;
    try { decoded = decodeURIComponent(part); } catch { return null; }
    // eslint-disable-next-line no-control-regex
    if (!decoded || decoded === '.' || decoded === '..' || /[/\\%\x00-\x1f\x7f]/.test(decoded)) return null;
    clean.push(encodeURIComponent(decoded));
  }
  let launch = null;
  const kept = [];
  for (const pair of rawQuery ? rawQuery.split('&') : []) {
    const name = pair.split('=')[0];
    let decodedName = name;
    try { decodedName = decodeURIComponent(name.replace(/\+/g, ' ')); } catch { /* kept as it is */ }
    if (decodedName === TICKET_PARAM) { launch = pair.slice(name.length + 1); continue; }
    if (pair) kept.push(pair);
  }
  // A request line takes printable ASCII only (the tunnel refuses anything else), and a fragment never belongs in it.
  const query = kept.length ? `?${kept.join('&').replace(/[^\x21-\x7e]|[#\\]/g, ch => encodeURIComponent(ch))}` : '';
  return { engineId, basePath: `/vscode/${engineId}`, path: `/vscode/${engineId}/${clean.join('/')}`, query, launch };
}

// The host and protocol the browser used, the way Express reads them with `trust proxy` set to one hop (server.js), for Express requests and raw upgrade
// requests alike. Null when the host is not a plain host name.
function publicOrigin(req, { trustProxy = true } = {}) {
  const headers = req.headers || {};
  const first = value => String(Array.isArray(value) ? value[0] : value || '').split(',')[0].trim();
  const host = (trustProxy && headers['x-forwarded-host'] ? first(headers['x-forwarded-host']) : first(headers.host));
  const encrypted = Boolean(req.socket && req.socket.encrypted);
  let proto = encrypted ? 'https' : 'http';
  if (trustProxy && headers['x-forwarded-proto']) proto = first(headers['x-forwarded-proto']).toLowerCase() === 'https' ? 'https' : 'http';
  if (!PUBLIC_HOST.test(host)) return null;
  return { host, proto };
}

function cookieValues(header) {
  const values = [];
  for (const part of String(header || '').split(';')) {
    const item = part.trim();
    if (item.startsWith(`${COOKIE_NAME}=`)) values.push(item.slice(COOKIE_NAME.length + 1));
  }
  return values;
}

function pickRequestHeaders(headers) {
  const picked = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string' && value.length <= 8192 && !/[^\t\x20-\x7e]/.test(value)) picked[name] = value;
  }
  return picked;
}

// A redirect of VS Code points at its own base path, maybe on another host (127.0.0.1, or the X-Forwarded-Host it was given). It becomes a path on
// this origin under the same base; anything that leads elsewhere is dropped. A `tkn` parameter (VS Code's connection token) never reaches the browser.
function rewriteLocation(value, target) {
  if (typeof value !== 'string' || !value) return null;
  let url;
  try { url = new URL(value, `http://vscode.invalid${target.path}`); } catch { return null; }
  if (url.pathname !== target.basePath && !url.pathname.startsWith(`${target.basePath}/`)) return null;
  url.searchParams.delete('tkn');
  url.searchParams.delete(TICKET_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

// At most `max` jobs run at once; the rest wait in order. `enqueue` returns the release (or the cancel, while the job still waits).
function createLimiter(max) {
  let active = 0;
  const waiting = [];
  const next = () => {
    while (active < max && waiting.length) {
      const job = waiting.shift();
      active += 1;
      job.state = 'running';
      job.start();
    }
  };
  return {
    get active() { return active; },
    get waiting() { return waiting.length; },
    enqueue(start) {
      const job = { state: 'waiting', start };
      const release = () => {
        if (job.state === 'running') { job.state = 'done'; active -= 1; next(); }
        else if (job.state === 'waiting') { job.state = 'done'; const index = waiting.indexOf(job); if (index >= 0) waiting.splice(index, 1); }
      };
      waiting.push(job);
      process.nextTick(next);
      return release;
    },
  };
}

function defaultResolveRemote(serverId, owner) {
  const db = require('../db');
  const config = require('../config');
  const { decryptToken } = require('../lib/token-crypto');
  const row = db.prepare('SELECT * FROM remote_servers WHERE id = ? AND owner_id = ?').get(serverId, owner);
  if (!row) return null;
  return { baseUrl: row.base_url, token: decryptToken(row.token_cipher, config.sessionSecret) };
}

function defaultSessionActive(sid) {
  return Boolean(sid) && require('./client-auth').getClientAuth().sessionActive(sid);
}

function defaultSessionExpiry(sid) {
  try {
    const row = require('../db').prepare('SELECT expired FROM sessions WHERE sid = ?').get(sid);
    return row && Number.isFinite(Number(row.expired)) ? Number(row.expired) : null;
  } catch { return null; }
}

function createVscodeProxy(options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const localTransport = options.localTransport || require('./vscode-local-transport');
  const resolveRemote = options.resolveRemote || defaultResolveRemote;
  const sessionActive = options.sessionActive || defaultSessionActive;
  const sessionExpiry = options.sessionExpiry || defaultSessionExpiry;
  const hub = () => options.hub || getHub();
  const now = options.now || Date.now;

  const tickets = new Map(); // ticket -> { sessionId, owner, engineId, target, expiresAt }
  const cookies = new Map(); // cookie value -> { sessionId, owner, engineId, target }
  const sockets = new Set(); // browser sides of open WebSockets, with .vscodeSessionId
  const limiters = new Map(); // link id -> limiter

  function pruneTickets() {
    const time = now();
    for (const [ticket, record] of tickets) if (record.expiresAt <= time) tickets.delete(ticket);
  }

  function issueTicket({ sessionId, owner, engineId, target, connectionToken }) {
    pruneTickets();
    if (tickets.size >= MAX_PENDING_TICKETS) tickets.delete(tickets.keys().next().value);
    const ticket = randomToken(TICKET_PREFIX);
    tickets.set(ticket, { sessionId, owner, engineId, target, connectionToken, expiresAt: now() + settings.ticketTtlMs });
    return ticket;
  }

  function consumeTicket(value) {
    const key = String(value || '');
    const record = tickets.get(key);
    tickets.delete(key);
    if (!record || record.expiresAt <= now()) return null;
    return record;
  }

  // The Contract A answer of an engine, plus `open_url` once VS Code is ready. `target`: { kind: 'local' } or { kind: 'remote', serverId }.
  function launchAnswer(answer, { sessionId, owner, target }) {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return answer;
    const out = { ...answer };
    delete out.open_url;
    delete out.connection_token; // never in the JSON the browser reads: it goes into a cookie when the ticket is exchanged
    if (answer.state !== 'ready' || !sessionId) return out;
    const engineId = answer.engine_id;
    const openPath = answer.open_path;
    if (typeof engineId !== 'string' || !ENGINE_ID.test(engineId) || typeof openPath !== 'string') return out;
    if (!openPath.startsWith(`/vscode/${engineId}/`) || /[^\x21-\x7e]|[#\\]/.test(openPath)) return out;
    const connectionToken = typeof answer.connection_token === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(answer.connection_token) ? answer.connection_token : '';
    const ticket = issueTicket({ sessionId, owner, engineId, target, connectionToken });
    out.open_url = `${openPath}${openPath.includes('?') ? '&' : '?'}${TICKET_PARAM}=${ticket}`;
    return out;
  }

  function authenticate(cookieHeader, engineId) {
    for (const value of cookieValues(cookieHeader)) {
      const record = cookies.get(value);
      if (!record || record.engineId !== engineId) continue;
      if (!sessionActive(record.sessionId)) { cookies.delete(value); continue; }
      return record;
    }
    return null;
  }

  function forgetSession(sid) {
    for (const [value, record] of cookies) if (record.sessionId === sid) cookies.delete(value);
    for (const [ticket, record] of tickets) if (record.sessionId === sid) tickets.delete(ticket);
    for (const ws of [...sockets]) if (ws.vscodeSessionId === sid) closeWebSocket(ws, 1008, 'Authentication required');
  }

  function forgetAll() {
    cookies.clear();
    tickets.clear();
    for (const ws of [...sockets]) closeWebSocket(ws, 1008, 'Authenticator changed');
  }

  // Cookies, tickets and sockets of sessions that ended (logout, expiry, a device signed out) go away even when nothing asks again.
  function sweep() {
    pruneTickets();
    const checked = new Map();
    const active = sid => { if (!checked.has(sid)) checked.set(sid, sessionActive(sid)); return checked.get(sid); };
    for (const [value, record] of cookies) if (!active(record.sessionId)) cookies.delete(value);
    for (const ws of [...sockets]) if (!active(ws.vscodeSessionId)) closeWebSocket(ws, 1008, 'Authentication required');
  }
  const sweepTimer = settings.sweepMs > 0 ? unref(setInterval(sweep, settings.sweepMs)) : null;

  function limiterFor(linkId) {
    if (!limiters.has(linkId)) limiters.set(linkId, createLimiter(settings.tunnelConcurrency));
    return limiters.get(linkId);
  }

  // Where a record's requests go: { kind: 'local' } or { kind: 'direct' | 'tunnel', baseUrl, token, linkId }. Null when the remote row is gone.
  function transportFor(record) {
    if (record.target && record.target.kind === 'local') return { kind: 'local' };
    if (!record.target || record.target.kind !== 'remote') return null;
    const remote = resolveRemote(record.target.serverId, record.owner);
    if (!remote || !remote.baseUrl || !remote.token) return null;
    if (isTunnelBase(remote.baseUrl)) return { kind: 'tunnel', baseUrl: remote.baseUrl, token: remote.token, linkId: linkIdOf(remote.baseUrl) };
    return { kind: 'direct', baseUrl: remote.baseUrl, token: remote.token };
  }

  const enginePath = (origin, target) => `/v1/vscode/web/${Buffer.from(origin.host).toString('base64url')}${target.path}${target.query}`;

  // The login gate's 404, with the full path: inside the router mounted at /vscode, req.path has lost that prefix.
  function notFound(req, res) {
    const url = String(req.originalUrl || req.url || '');
    return sendNotFound({ method: req.method, path: url.split('?')[0] }, res);
  }

  // The first visit with a ticket: the cookie, then the same address without the ticket.
  function exchange(req, res, target) {
    const ticket = (req.method === 'GET' || req.method === 'HEAD') ? consumeTicket(target.launch) : null;
    if (!ticket || ticket.engineId !== target.engineId || !sessionActive(ticket.sessionId)) return notFound(req, res);
    // The browser replaces the cookie of this path, so an older value of this session for this engine is no use any more.
    for (const [value, record] of cookies) if (record.sessionId === ticket.sessionId && record.engineId === ticket.engineId) cookies.delete(value);
    const value = randomToken(COOKIE_PREFIX);
    cookies.set(value, { sessionId: ticket.sessionId, owner: ticket.owner, engineId: ticket.engineId, target: ticket.target });
    const parts = [`${COOKIE_NAME}=${value}`, `Path=${target.basePath}/`, 'HttpOnly', 'SameSite=Lax'];
    const expires = sessionExpiry(ticket.sessionId);
    if (expires) parts.push(`Expires=${new Date(expires).toUTCString()}`);
    const origin = publicOrigin(req);
    if (req.secure || (origin && origin.proto === 'https')) parts.push('Secure');
    res.statusCode = 302;
    const cookiesOut = [parts.join('; ')];
    // VS Code's own client reads `vscode-tkn` from the browser's cookies for its connection handshake (without it: "Unauthorized client refused: auth
    // mismatch"). Scoped to this engine's path; not HttpOnly because VS Code's script reads it. Requests still get the token from the engine, never from here.
    if (ticket.connectionToken) {
      const tkn = [`vscode-tkn=${ticket.connectionToken}`, `Path=${target.basePath}/`, 'SameSite=Lax'];
      if (expires) tkn.push(`Expires=${new Date(expires).toUTCString()}`);
      if (parts.includes('Secure')) tkn.push('Secure');
      cookiesOut.push(tkn.join('; '));
    }
    res.setHeader('Set-Cookie', cookiesOut);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Location', `${target.path}${target.query}`);
    res.end();
  }

  function sendHead(res, target, status, headers) {
    res.statusCode = status;
    for (const name of ALLOWED_RESPONSE_HEADERS) {
      const value = headers[name];
      if (typeof value !== 'string' || /[^\t\x20-\x7e\x80-\xff]/.test(value)) continue;
      if (name === 'location') {
        const location = rewriteLocation(value, target);
        if (location) res.setHeader('Location', location);
        continue;
      }
      res.setHeader(name, value);
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }

  // `compress`: a middleware (compression) run only once the request is authenticated, so that a refused request gets exactly the 404 of any
  // unknown address, without the Vary header compression adds.
  function handleHttp(req, res, { compress = null } = {}) {
    const target = parseBrowserTarget(req.originalUrl || req.url);
    if (!target) return notFound(req, res);
    if (target.launch !== null) return exchange(req, res, target);
    const record = authenticate(req.headers.cookie, target.engineId);
    if (!record) return notFound(req, res);
    const origin = publicOrigin(req);
    const transport = origin && transportFor(record);
    if (!transport) return notFound(req, res);
    if (compress) return compress(req, res, () => forward(req, res, target, origin, transport));
    return forward(req, res, target, origin, transport);
  }

  function forward(req, res, target, origin, transport) {
    const method = String(req.method || 'GET').toUpperCase();
    const headers = pickRequestHeaders(req.headers);
    let finished = false;
    let release = () => {};
    let cancelUpstream = () => {};

    const done = () => {
      clearTimeout(timer);
      release();
      release = () => {};
    };
    const fail = (status, code) => {
      if (finished) return;
      finished = true;
      done();
      cancelUpstream();
      if (!res.headersSent) res.status(status).json({ error: code });
      else res.destroy();
    };
    // The 30 s cover a wait in the tunnel's queue too: the head of the answer must be here by then. After the head there is no limit (a download).
    const timer = unref(setTimeout(() => fail(504, 'REMOTE_TIMEOUT'), settings.headTimeoutMs));
    res.on('close', () => {
      if (!finished) { finished = true; cancelUpstream(); }
      done();
    });

    const onHead = (status, responseHeaders, body) => {
      if (finished) { if (body && body.destroy) body.destroy(); return; }
      clearTimeout(timer);
      sendHead(res, target, status, responseHeaders || {});
      if (!body || method === 'HEAD') { if (body && body.resume) body.resume(); finished = true; done(); res.end(); return; }
      body.on('error', () => { finished = true; done(); res.destroy(); });
      body.on('end', () => { finished = true; done(); });
      body.pipe(res);
    };

    if (transport.kind === 'local') {
      const controller = new AbortController();
      cancelUpstream = () => controller.abort();
      Promise.resolve()
        .then(() => localTransport.request({
          method, path: `${target.path}${target.query}`, headers, body: BODYLESS.has(method) ? null : req,
          host: origin.host, proto: origin.proto, signal: controller.signal,
        }))
        .then(answer => {
          if (!answer || !Number.isInteger(answer.status)) throw new Error('VSCODE_PROXY_FAILED');
          onHead(answer.status, lowerKeys(answer.headers), answer.body);
        })
        .catch(error => fail(502, safeCode(error && error.message)));
      return;
    }

    const start = () => {
      if (finished) return;
      const url = new URL(enginePath(origin, target), `${transport.baseUrl}/`);
      const client = transport.kind === 'tunnel' ? hub() : url.protocol === 'https:' ? https : http;
      const upstream = client.request(url, { method, headers: { ...headers, authorization: `Bearer ${transport.token}` } }, response => {
        onHead(response.statusCode, response.headers, response);
      });
      cancelUpstream = () => upstream.destroy();
      upstream.on('error', error => fail(502, safeCode(error && error.message)));
      if (BODYLESS.has(method)) upstream.end();
      else {
        req.on('aborted', () => upstream.destroy());
        req.pipe(upstream);
      }
    };
    if (transport.kind === 'tunnel') release = limiterFor(transport.linkId).enqueue(start);
    else start();
  }

  function rejectUpgrade(socket, status, text) {
    if (socket.destroyed) return;
    socket.write(`HTTP/1.1 ${status} ${text}\r\n\r\n`);
    socket.destroy();
  }

  // An upgrade under /vscode/. Returns true when the path is one of ours (it has then been answered).
  function handleUpgrade(req, socket, head, wss) {
    const raw = String(req.url || '');
    if (!/^\/vscode(?:\/|$|\?)/i.test(raw)) return false;
    const target = parseBrowserTarget(raw);
    if (!target || target.launch !== null) { rejectUpgrade(socket, 404, 'Not Found'); return true; }
    // The same origin check as the terminals (server.js browserUpgrade): a page of another site cannot open these sockets with the cookie.
    const originHeader = req.headers.origin;
    if (!originHeader || ![`http://${req.headers.host}`, `https://${req.headers.host}`].includes(originHeader)) { rejectUpgrade(socket, 403, 'Forbidden'); return true; }
    const record = authenticate(req.headers.cookie, target.engineId);
    const origin = publicOrigin(req);
    const transport = record && origin && transportFor(record);
    if (!transport) { rejectUpgrade(socket, 404, 'Not Found'); return true; }

    let upstream;
    try {
      if (transport.kind === 'local') {
        upstream = localTransport.openWebSocket({ path: `${target.path}${target.query}`, headers: {}, host: origin.host, proto: origin.proto });
      } else if (transport.kind === 'tunnel') {
        upstream = hub().openWebSocket(transport.linkId, enginePath(origin, target), {
          headers: { authorization: `Bearer ${transport.token}` }, handshakeTimeout: settings.headTimeoutMs,
        });
      } else {
        const url = new URL(enginePath(origin, target), `${transport.baseUrl}/`);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        upstream = new WebSocket(url, {
          headers: { Authorization: `Bearer ${transport.token}` }, handshakeTimeout: settings.headTimeoutMs, perMessageDeflate: false, followRedirects: false,
        });
      }
    } catch {
      rejectUpgrade(socket, 502, 'Bad Gateway');
      return true;
    }
    if (!upstream) { rejectUpgrade(socket, 502, 'Bad Gateway'); return true; }

    let settled = false;
    upstream.once('open', () => {
      settled = true;
      // Again after the engine's handshake: the person may have logged out meanwhile.
      if (!sessionActive(record.sessionId) || socket.destroyed) {
        closeWebSocket(upstream, 1008, 'Authentication required');
        rejectUpgrade(socket, 404, 'Not Found');
        return;
      }
      wss.handleUpgrade(req, socket, head, downstream => {
        // clientSessionId: server.js closes the sockets of a session on logout and in its 30 s check, as it does for terminals.
        downstream.clientSessionId = record.sessionId;
        downstream.vscodeSessionId = record.sessionId;
        sockets.add(downstream);
        downstream.once('close', () => sockets.delete(downstream));
        bridge(downstream, upstream, { tunnelled: transport.kind === 'tunnel', sessionId: record.sessionId });
      });
    });
    upstream.once('error', () => {
      if (!settled) { settled = true; rejectUpgrade(socket, 502, 'Bad Gateway'); }
    });
    upstream.once('close', () => {
      if (!settled) { settled = true; rejectUpgrade(socket, 502, 'Bad Gateway'); }
    });
    return true;
  }

  // Both directions, with flow control: a side whose peer holds too much unsent data is paused until it has sent most of it.
  function bridge(downstream, upstream, { tunnelled, sessionId }) {
    if (tunnelled && typeof upstream.limitBy === 'function') upstream.limitBy(downstream);
    let checkedAt = now();
    const closeBoth = (code = 1000, reason = '') => {
      closeWebSocket(downstream, code, reason);
      closeWebSocket(upstream, code, reason);
    };
    const holdWhileFull = (reader, writer) => {
      if (typeof reader.pause !== 'function' || writer.bufferedAmount <= WS_HIGH_WATER || reader.vscodePaused) return;
      reader.vscodePaused = true;
      reader.pause();
      const poll = unref(setInterval(() => {
        if (writer.readyState !== WebSocket.OPEN || reader.readyState !== WebSocket.OPEN || writer.bufferedAmount <= WS_LOW_WATER) {
          clearInterval(poll);
          reader.vscodePaused = false;
          if (reader.readyState === WebSocket.OPEN) reader.resume();
        }
      }, 20));
    };
    downstream.on('message', (data, binary) => {
      if (downstream.readyState !== WebSocket.OPEN) return;
      if (now() - checkedAt >= settings.sessionCheckMs) {
        checkedAt = now();
        if (!sessionActive(sessionId)) { closeBoth(1008, 'Authentication required'); return; }
      }
      // A message the tunnel cannot carry closes like one that is too big for the engine would (1009), instead of the tunnel's backlog close.
      if (tunnelled && data.length > MAX_TUNNEL_WS_MESSAGE) { closeBoth(1009, 'Message too big'); return; }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
      holdWhileFull(downstream, upstream);
    });
    upstream.on('message', (data, binary) => {
      if (downstream.readyState !== WebSocket.OPEN) return;
      downstream.send(data, { binary });
      // The tunnel holds its credit back by itself (limitBy above); a direct or local socket is paused.
      if (!tunnelled) holdWhileFull(upstream, downstream);
    });
    downstream.on('close', (code, reason) => closeWebSocket(upstream, code, reason));
    upstream.on('close', (code, reason) => closeWebSocket(downstream, code, reason));
    downstream.on('error', () => closeBoth(1011, 'Client connection error'));
    upstream.on('error', () => closeBoth(1011, 'Engine connection error'));
  }

  return {
    launchAnswer,
    handleHttp,
    handleUpgrade,
    forgetSession,
    forgetAll,
    sweep,
    publicOrigin: req => publicOrigin(req),
    stop() { if (sweepTimer) clearInterval(sweepTimer); },
    // For tests and diagnostics: sizes only, never values.
    stats: () => ({ tickets: tickets.size, cookies: cookies.size, sockets: sockets.size, tunnel: Object.fromEntries([...limiters].map(([id, limiter]) => [id, { active: limiter.active, waiting: limiter.waiting }])) }),
  };
}

function lowerKeys(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  return out;
}

let shared = null;
function getVscodeProxy() {
  if (!shared) shared = createVscodeProxy();
  return shared;
}

module.exports = {
  createVscodeProxy, getVscodeProxy, parseBrowserTarget, publicOrigin, rewriteLocation, createLimiter,
  COOKIE_NAME, TICKET_PARAM, FORWARDED_REQUEST_HEADERS,
};
