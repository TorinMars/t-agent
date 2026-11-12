// T-Attention HTTP API, mounted at /api/attention (see "T-Attention" in DESIGN.md).
//
// Two ways in:
//  - the browser session: `router`, mounted after the /api session check (middleware/auth.js) and the same-origin rule for mutations
//    (middleware/client-origin.js), like every other browser API;
//  - `Authorization: Bearer tatt_...` (the CLI and listener plugins): `bearer`, mounted in server.js before the session, the access gate and
//    the login gate. It answers every Bearer request to /api/attention* itself and never passes one on, so a token reaches this router and nothing
//    else: not the token endpoints (/api/attention/tokens*, browser session only), no other /api route and no page. No cookie is read or set, there is
//    no same-origin check (a token is not sent by a browser on its own), failed attempts are rate limited per address, and every failure is 401 JSON.
//  - `claim` (POST /api/attention/pairing/claim): the one public endpoint, mounted in server.js before `bearer`, the session and the gates. It
//    takes a pairing code made on the page (POST /pairing, browser session) and answers a new token once; wrong codes are rate limited per
//    address (pairingClaims: 5 wrong codes in a minute lock the address out for a minute).
const os = require('node:os');
const express = require('express');
const { AttentionError } = require('../services/attention');

const TOKEN_PATH = /^\/tokens(?:\/|$)/i;
const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i;

function sendError(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: code, message, ...extra });
}

// An AttentionError as its JSON answer (with `id` / `children` when it has them); anything else is logged and answered 500.
function sendFailure(res, error) {
  if (error instanceof AttentionError) return sendError(res, error.statusCode, error.code, error.message, { ...(error.id !== undefined ? { id: error.id } : {}), ...(Array.isArray(error.children) ? { children: error.children } : {}) });
  console.error(`T-Attention API: ${error.stack || error.message}`);
  return sendError(res, 500, 'INTERNAL_ERROR', 'The attention service failed');
}
const wrap = handler => (req, res) => {
  try { return handler(req, res); } catch (error) { return sendFailure(res, error); }
};
const idOf = value => (/^\d{1,15}$/.test(String(value)) ? Number(value) : null);
const isTrue = value => ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
// The list filters of GET / (the same on /api/attention and /v1/attention). parent=<id>: only the children of that item.
const listQuery = query => ({ status: query.status, q: query.q, limit: query.limit, includeDone: isTrue(query.include_done), parent: query.parent });

// Server-sent events of the change bus: `retry`, `event: change` with { kind, item, previous, event, ... } for every change, a comment line every
// heartbeatMs. `active()` is asked at every heartbeat; false ends the stream (a revoked token). Returns the stream's handle ({ close }).
function serveChangeStream(req, res, service, { heartbeatMs, active = () => true, onClose = () => {} }) {
  res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n: connected\n\n');
  let closed = false;
  const stream = {
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(timer);
      onClose(stream);
      res.end();
    },
  };
  const unsubscribe = service.onChange(change => {
    if (!closed) res.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`);
  });
  const timer = setInterval(() => {
    if (!active()) return stream.close();
    res.write(': heartbeat\n\n');
  }, heartbeatMs);
  if (timer.unref) timer.unref();
  req.on('close', () => stream.close());
  return stream;
}

// The JSON parser of the token paths (here and /v1/attention): 400 INVALID_JSON, 413 BODY_TOO_LARGE. A body an earlier parser read is left as it is.
function createJsonParser() {
  const parse = express.json({ limit: '256kb' });
  return (req, res, next) => parse(req, res, error => {
    if (!error) return next();
    if (error.status === 413) return sendError(res, 413, 'BODY_TOO_LARGE', 'The request body is too large');
    return sendError(res, 400, 'INVALID_JSON', 'The request body is not valid JSON');
  });
}

// Sliding count per key inside a window; used for failed token attempts (per address) and for requests per token.
function createCounter({ windowMs, max, now = Date.now }) {
  const hits = new Map();
  function prune(key, at) {
    const list = (hits.get(key) || []).filter(time => at - time < windowMs);
    if (list.length) hits.set(key, list); else hits.delete(key);
    return list;
  }
  return {
    limited(key) { return prune(key, now()).length >= max; },
    add(key) { const at = now(); const list = prune(key, at); list.push(at); hits.set(key, list); },
    retryAfter(key) { const list = prune(key, now()); return list.length ? Math.max(1, Math.ceil((list[0] + windowMs - now()) / 1000)) : 1; },
  };
}

function createAttentionRoutes({ service, summary = null, plugins = null, installer = null, market = null, instanceId = null, pairingClaims = { windowMs: 60 * 1000, max: 5, lockMs: 60 * 1000, requests: 30 }, heartbeatMs = 25000, failedAuth = { windowMs: 15 * 60 * 1000, max: 20 }, tokenRequests = { windowMs: 60 * 1000, max: 600 }, now = Date.now } = {}) {
  if (!service) throw new Error('createAttentionRoutes needs the attention service');
  const failures = createCounter({ ...failedAuth, now });
  const perToken = createCounter({ ...tokenRequests, now });
  const streams = new Set();
  const router = express.Router();

  // Who acts: 'user' for the browser; for a token the body's source when it sends one, else the token's name.
  function actor(req) {
    const auth = req.attentionAuth;
    if (!auth || auth.kind !== 'token') return 'user';
    const source = req.body && typeof req.body.source === 'string' && req.body.source.trim();
    return source || auth.name;
  }
  // A token that creates an item without a source is a command-line caller, not the person in the browser (used on create only).
  const defaultSource = req => (req.attentionAuth.kind === 'token' ? 'cli' : 'user');
  // A terminal token's T-Agent terminal: its creates and updates tie the item to that terminal (tieToTerminal in services/attention.js).
  const tagentOf = req => (req.attentionAuth.kind === 'token' && req.attentionAuth.tagent) || null;
  const sessionOnly = (req, res, next) => (req.attentionAuth && req.attentionAuth.kind === 'session' ? next() : sendError(res, 403, 'TOKEN_NOT_ALLOWED', 'An attention token cannot manage tokens; use the browser'));

  router.use((req, res, next) => {
    if (!req.attentionAuth) req.attentionAuth = { kind: 'session' };
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Tokens: the browser session only.
  router.get('/tokens', sessionOnly, wrap((req, res) => res.json({ tokens: service.listTokens() })));
  router.post('/tokens', sessionOnly, wrap((req, res) => res.status(201).json(service.createToken({ name: req.body && req.body.name, market: req.body ? req.body.market : undefined }))));
  router.delete('/tokens/:id', sessionOnly, wrap((req, res) => {
    const id = idOf(req.params.id);
    if (id === null) return sendError(res, 404, 'NOT_FOUND', 'Token not found');
    service.revokeToken(id);
    for (const stream of streams) if (stream.tokenId === id) stream.close();
    return res.status(204).end();
  }));
  router.all(/^\/tokens(?:\/.*)?$/i, (req, res) => sendError(res, 404, 'NOT_FOUND', 'Not found'));

  // AI summary (services/attention-summary.js): the browser session only.
  const owner = req => req.session.user.login;
  const needSummary = (req, res, next) => (summary ? next() : sendError(res, 404, 'NOT_FOUND', 'Not found'));
  router.get('/settings/summary', sessionOnly, needSummary, wrap((req, res) => res.json(summary.getSettings(owner(req)))));
  router.put('/settings/summary', sessionOnly, needSummary, wrap((req, res) => res.json(summary.saveSettings(owner(req), req.body))));
  // The first-run guide's flags (services/attention-guide.js): the browser session only, per owner.
  const needGuide = (req, res, next) => (typeof service.getGuide === 'function' ? next() : sendError(res, 404, 'NOT_FOUND', 'Not found'));
  router.get('/settings/guide', sessionOnly, needGuide, wrap((req, res) => res.json(service.getGuide(owner(req)))));
  router.put('/settings/guide', sessionOnly, needGuide, wrap((req, res) => res.json(service.saveGuide(owner(req), req.body))));
  router.all(/^\/settings(?:\/.*)?$/i, sessionOnly, (req, res) => sendError(res, 404, 'NOT_FOUND', 'Not found'));
  // Starts a new summary in the background: 202 { started } (false while one already runs for the item); the result arrives as a change event.
  router.post('/:id/summarize', sessionOnly, needSummary, wrap((req, res) => {
    const id = idOf(req.params.id);
    if (id === null) return sendError(res, 404, 'NOT_FOUND', 'Task not found');
    const { started } = summary.summarize(owner(req), id);
    return res.status(202).json({ started });
  }));

  // Plugin overview (services/attention-plugins.js): the browser session and tokens. A token has no user, so the notifier part is the
  // single user's (the owner of background events).
  router.get('/plugins', wrap((req, res) => {
    if (!plugins) return sendError(res, 404, 'NOT_FOUND', 'Not found');
    const who = req.attentionAuth.kind === 'session' && req.session && req.session.user ? req.session.user.login : undefined;
    return res.json(plugins.overview(who));
  }));

  // Manifest settings of one notifier plugin (services/attention-notify.js): the browser session only, since a tatt_ token has no user and
  // the values may hold secrets (they come back as { set: true } only). GET → { name, enabled, values, schema, test, customUi };
  // PUT { enabled?, values? } → the same; POST …/test → { ok, message }.
  const settingsOnly = (req, res, next) => (req.attentionAuth && req.attentionAuth.kind === 'session' ? next() : sendError(res, 403, 'TOKEN_NOT_ALLOWED', 'An attention token cannot change plugin settings; use the browser'));
  const pluginCall = handler => async (req, res) => {
    if (!plugins || typeof plugins.getConfig !== 'function') return sendError(res, 404, 'NOT_FOUND', 'Not found');
    try { return res.json(await handler(req)); } catch (error) {
      if (error && error.name === 'NotifyError') return sendError(res, error.statusCode || 400, error.statusCode === 404 ? 'NOT_FOUND' : 'INVALID_SETTINGS', error.message);
      console.error(`T-Attention plugin settings: ${error && (error.stack || error.message)}`);
      return sendError(res, 500, 'INTERNAL_ERROR', 'The plugin settings failed');
    }
  };
  router.get('/plugins/:name/config', settingsOnly, pluginCall(req => plugins.getConfig(req.params.name, owner(req))));
  router.put('/plugins/:name/config', settingsOnly, pluginCall(req => plugins.saveConfig(req.params.name, owner(req), req.body)));
  router.post('/plugins/:name/test', settingsOnly, pluginCall(req => plugins.test(req.params.name, owner(req))));
  // One-click install of the claude listener on this machine (services/attention-plugins.js createListenerInstaller): the browser session only.
  const asyncWrap = handler => (req, res) => Promise.resolve().then(() => handler(req, res)).catch(error => {
    if (error instanceof AttentionError) return sendError(res, error.statusCode, error.code, error.message);
    if (error && error.name === 'ListenerInstallError') return sendError(res, 409, error.code, error.message);
    if (error && error.code === 'NOT_READY') return sendError(res, 503, 'NOT_READY', error.message);
    console.error(`T-Attention install: ${error && (error.stack || error.message)}`);
    return sendError(res, 500, 'INSTALL_FAILED', 'The install failed; see the server log');
  });
  const needInstaller = (req, res, next) => (installer ? next() : sendError(res, 404, 'NOT_FOUND', 'Not found'));
  router.post('/plugins/claude/install', sessionOnly, needInstaller, asyncWrap(async (req, res) => res.json(await installer.install())));
  router.post('/plugins/claude/uninstall', sessionOnly, needInstaller, asyncWrap(async (req, res) => res.json(await installer.uninstall())));

  // Plugin marketplace (services/attention-market.js): the browser session, or a token with the 'market' scope ("Can manage plugins").
  // Every other token (terminal tokens too) gets 403 TOKEN_NOT_ALLOWED.
  const marketAccess = (req, res, next) => {
    const auth = req.attentionAuth;
    if (auth.kind === 'session' || (auth.kind === 'token' && Array.isArray(auth.scopes) && auth.scopes.includes('market'))) return next();
    return sendError(res, 403, 'TOKEN_NOT_ALLOWED', 'This token cannot manage plugins; make a token with "Can manage plugins" under Settings -> T-Attention -> CLI tokens');
  };
  const marketCall = handler => (req, res) => {
    if (!market) return sendError(res, 404, 'NOT_FOUND', 'Not found');
    return Promise.resolve().then(() => handler(req)).then(result => res.json(result)).catch(error => {
      if (error && error.name === 'MarketError') return sendError(res, error.statusCode || 400, error.code, error.message);
      console.error(`T-Attention market: ${error && (error.stack || error.message)}`);
      return sendError(res, 500, 'INTERNAL_ERROR', 'The plugin marketplace failed; see the server log');
    });
  };
  const queryText = value => (typeof value === 'string' ? value : undefined);
  router.get('/market', marketAccess, marketCall(req => market.list({ q: queryText(req.query.q), kind: queryText(req.query.kind) })));
  router.get('/market/sources', marketAccess, marketCall(() => market.getSources()));
  router.put('/market/sources', marketAccess, marketCall(req => market.saveSources(req.body)));
  router.post('/market/prepare', marketAccess, marketCall(req => market.prepare(req.body)));
  router.post('/market/install', marketAccess, marketCall(req => market.install(req.body)));
  router.get('/market/updates', marketAccess, marketCall(() => market.checkUpdates()));
  router.delete('/market/plugins/:name', marketAccess, marketCall(req => market.remove(req.params.name, { purge: ['1', 'true', 'yes'].includes(String(req.query.purge || '').toLowerCase()) })));
  router.post('/market/link', marketAccess, marketCall(req => market.link(req.body)));
  router.delete('/market/link/:name', marketAccess, marketCall(req => market.unlink(req.params.name)));
  router.post('/market/reload', marketAccess, marketCall(req => market.reload(req.body)));
  router.all(/^\/market(?:\/.*)?$/i, (req, res) => sendError(res, 404, 'NOT_FOUND', 'Not found'));

  // Pairing codes for another machine (`t-attention pair`): made, read and ended from the browser session; claimed through `claim` below.
  const pairingCommand = (code, url) => `t-attention pair ${code} --url ${url}`;
  router.post('/pairing', sessionOnly, wrap((req, res) => {
    const origin = (req.body && typeof req.body.origin === 'string' && req.body.origin) || `${req.protocol}://${req.get('host')}`;
    const created = service.createPairing({ url: origin });
    return res.status(201).json({ code: created.code, expiresAt: created.expiresAt, url: created.url, command: pairingCommand(created.code, created.url) });
  }));
  router.get('/pairing', sessionOnly, wrap((req, res) => res.json(service.pairingStatus())));
  router.delete('/pairing', sessionOnly, wrap((req, res) => res.json(service.cancelPairing())));
  router.all(/^\/pairing(?:\/.*)?$/i, (req, res) => sendError(res, 404, 'NOT_FOUND', 'Not found'));

  // Server-sent events: `event: change` with { kind, item, previous, event } for every change, a comment line every heartbeatMs.
  // A token's stream ends when the token is revoked.
  router.get('/stream', (req, res) => {
    const tokenId = req.attentionAuth.kind === 'token' ? req.attentionAuth.id : null;
    const stream = serveChangeStream(req, res, service, {
      heartbeatMs,
      active: () => tokenId === null || service.tokenActive(tokenId),
      onClose: closing => streams.delete(closing),
    });
    stream.tokenId = tokenId;
    streams.add(stream);
  });

  router.get('/', wrap((req, res) => {
    // `host`: this machine's name, as the Claude listener writes it into context.host (os.hostname()). The page opens the files of a context only
    // when they are on this machine. `instance_id`: this Engine's own identity (engine_identity, the first part of a shared task order key), so a
    // page that lists the items of several services can key them `<instance_id>:<id>`.
    res.json({ items: service.list(listQuery(req.query)), host: os.hostname(), ...(instanceId ? { instance_id: instanceId() } : {}) });
  }));

  router.post('/', wrap((req, res) => res.status(201).json(service.create(req.body, { actor: actor(req), defaultSource: defaultSource(req), tagent: tagentOf(req) }))));

  router.get('/by-ref/:ref', wrap((req, res) => {
    const found = service.detailByRef(req.params.ref);
    if (!found) return sendError(res, 404, 'NOT_FOUND', 'Task not found');
    return res.json(found);
  }));

  router.put('/by-ref/:ref', wrap((req, res) => {
    const { created, item } = service.upsertByRef(req.params.ref, req.body, { actor: actor(req), defaultSource: defaultSource(req), tagent: tagentOf(req) });
    res.status(created ? 201 : 200).json(item);
  }));

  router.get('/:id', wrap((req, res) => {
    const id = idOf(req.params.id);
    const found = id === null ? null : service.detail(id);
    if (!found) return sendError(res, 404, 'NOT_FOUND', 'Task not found');
    return res.json(found);
  }));

  router.patch('/:id', wrap((req, res) => {
    const id = idOf(req.params.id);
    if (id === null) return sendError(res, 404, 'NOT_FOUND', 'Task not found');
    return res.json(service.update(id, req.body, { actor: actor(req), tagent: tagentOf(req) }));
  }));

  // { before | after | position, status?, reason? } -> { item, items } (see move in services/attention.js).
  router.post('/:id/move', wrap((req, res) => {
    const id = idOf(req.params.id);
    if (id === null) return sendError(res, 404, 'NOT_FOUND', 'Task not found');
    return res.json(service.move(id, req.body, { actor: actor(req) }));
  }));

  router.delete('/:id', wrap((req, res) => {
    const id = idOf(req.params.id);
    if (id === null) return sendError(res, 404, 'NOT_FOUND', 'Task not found');
    service.remove(id, { actor: actor(req) });
    return res.status(204).end();
  }));

  router.use((req, res) => sendError(res, 404, 'NOT_FOUND', 'Not found'));

  // Bearer requests to /api/attention*. Requests without an Authorization: Bearer header go on to the session path unchanged.
  function bearer(req, res, next) {
    const header = req.get('authorization');
    if (!header || !/^Bearer(?:[ \t]|$)/i.test(header)) return next();
    res.set('Cache-Control', 'no-store');
    let decoded;
    try { decoded = decodeURIComponent(req.path); } catch { return sendError(res, 404, 'NOT_FOUND', 'Not found'); }
    const key = `ip:${req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'}`;
    if (failures.limited(key)) {
      res.set('Retry-After', String(failures.retryAfter(key)));
      return sendError(res, 429, 'TOO_MANY_ATTEMPTS', 'Too many failed token attempts; try again later');
    }
    const match = BEARER.exec(header);
    const auth = match ? service.verifyToken(match[1]) : null;
    if (!auth) {
      failures.add(key);
      return sendError(res, 401, 'TOKEN_INVALID', 'The attention token is missing, wrong or revoked');
    }
    if (TOKEN_PATH.test(req.path) || TOKEN_PATH.test(decoded)) return sendError(res, 403, 'TOKEN_NOT_ALLOWED', 'An attention token cannot manage tokens; use the browser');
    const tokenKey = `token:${auth.id}`;
    if (perToken.limited(tokenKey)) {
      res.set('Retry-After', String(perToken.retryAfter(tokenKey)));
      return sendError(res, 429, 'RATE_LIMITED', 'Too many requests with this token; try again later');
    }
    perToken.add(tokenKey);
    req.attentionAuth = { kind: 'token', id: auth.id, name: auth.name, scopes: Array.isArray(auth.scopes) ? auth.scopes : [], tagent: auth.tagent || null };
    // Ends here in every case: an unmatched address is a JSON 404, never the session path, the gates or the pages.
    parseJson(req, res, () => router(req, res, error => (error ? sendFailure(res, error) : sendError(res, 404, 'NOT_FOUND', 'Not found'))));
  }
  const parseJson = createJsonParser();

  // POST /api/attention/pairing/claim { code, name } -> { url, token }. No session and no token (a Bearer header is ignored: the code is the
  // credential and works once). Per address: at most pairingClaims.requests requests a minute, and pairingClaims.max wrong codes inside
  // windowMs lock it out for lockMs.
  const claimFailures = createCounter({ windowMs: pairingClaims.windowMs, max: pairingClaims.max, now });
  const claimRequests = createCounter({ windowMs: 60 * 1000, max: pairingClaims.requests, now });
  const claimLocks = new Map();
  const parseClaim = express.json({ limit: '4kb' });
  function claim(req, res) {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST');
    const key = `ip:${req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'}`;
    const lockedUntil = claimLocks.get(key) || 0;
    if (lockedUntil > now()) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((lockedUntil - now()) / 1000))));
      return sendError(res, 429, 'TOO_MANY_ATTEMPTS', 'Too many wrong pairing codes; try again in a minute');
    }
    claimLocks.delete(key);
    if (claimRequests.limited(key)) {
      res.set('Retry-After', String(claimRequests.retryAfter(key)));
      return sendError(res, 429, 'RATE_LIMITED', 'Too many pairing requests; try again later');
    }
    claimRequests.add(key);
    parseClaim(req, res, error => {
      if (error) return sendError(res, 400, 'INVALID_JSON', 'The request body is not valid JSON');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      try {
        const result = service.claimPairing({ code: body.code, name: body.name });
        return res.status(201).json({ url: result.url, token: result.token, name: result.name });
      } catch (failure) {
        if (failure instanceof AttentionError && failure.code === 'PAIRING_INVALID') {
          claimFailures.add(key);
          if (claimFailures.limited(key)) claimLocks.set(key, now() + pairingClaims.lockMs);
          return sendError(res, 400, failure.code, failure.message);
        }
        if (failure instanceof AttentionError) return sendError(res, failure.statusCode, failure.code, failure.message);
        console.error(`T-Attention pairing: ${failure.stack || failure.message}`);
        return sendError(res, 500, 'INTERNAL_ERROR', 'The attention service failed');
      }
    });
  }

  function closeStreams() { for (const stream of [...streams]) stream.close(); }

  return { router, bearer, claim, closeStreams };
}

// T-Attention of this service for the other services connected to it: /v1/attention (routes/engine-v1.js), see "Shared across connected services"
// under "T-Attention" in DESIGN.md. The same service instance and the same shapes as /api/attention, for the item routes only: no tokens, settings,
// plugins, market, pairing, skill installer or by-ref. The item stays here; the other service reads and edits it in place.
// - `authenticate` (the Engine token, middleware/engine-auth.js) runs first, before any body is read; reads then need the scope `attention:read`,
//   writes `attention:write` (every Engine token is admin, `*`, which has both).
// - Event actor: 'user'. An Engine token is the same person on another device, as in the browser; it is not a CLI or listener token.
// - The stream ends when `tokenActive(tokenId)` turns false (the token was revoked or its service link removed), checked at every heartbeat.
// - `getService` / `getSummary` are asked on each request, so the router can be made when routes/engine-v1.js loads, before server.js made the summary.
function createEngineAttentionRouter({ service = null, getService = null, summary = null, getSummary = null, authenticate, instanceId = () => null, tokenActive = () => true, owner = () => require('../services/single-user').ensureSingleUser().login, heartbeatMs = 25000 } = {}) {
  if (!service && !getService) throw new Error('createEngineAttentionRouter needs the attention service');
  if (typeof authenticate !== 'function') throw new Error('createEngineAttentionRouter needs authenticate');
  const items = () => service || getService();
  const summaryOf = () => (getSummary ? getSummary() : summary);
  const actor = { actor: 'user' };
  const streams = new Set();
  const router = express.Router();
  const parseJson = createJsonParser();
  const scope = required => (req, res, next) => {
    const scopes = req.engineAuth && req.engineAuth.scopes;
    const values = scopes instanceof Set ? scopes : new Set(scopes || []);
    if (values.has('*') || values.has(required)) return next();
    return res.status(403).json({ error: 'ENGINE_SCOPE_REQUIRED', required_scope: required });
  };
  const read = scope('attention:read');
  const write = scope('attention:write');

  router.use(authenticate);
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  router.get('/stream', read, (req, res) => {
    const tokenId = req.engineAuth.tokenId;
    streams.add(serveChangeStream(req, res, items(), { heartbeatMs, active: () => tokenActive(tokenId), onClose: closing => streams.delete(closing) }));
  });
  router.get('/', read, wrap((req, res) => res.json({ items: items().list(listQuery(req.query)), host: os.hostname(), instance_id: instanceId() })));
  router.post('/', write, parseJson, wrap((req, res) => res.status(201).json(items().create(req.body, { ...actor, defaultSource: 'user' }))));
  router.get('/:id', read, wrap((req, res) => {
    const id = idOf(req.params.id);
    const found = id === null ? null : items().detail(id);
    if (!found) return sendError(res, 404, 'NOT_FOUND', 'Task not found');
    return res.json(found);
  }));
  router.patch('/:id', write, parseJson, wrap((req, res) => {
    const id = idOf(req.params.id);
    if (id === null) return sendError(res, 404, 'NOT_FOUND', 'Task not found');
    return res.json(items().update(id, req.body, actor));
  }));
  router.post('/:id/move', write, parseJson, wrap((req, res) => {
    const id = idOf(req.params.id);
    if (id === null) return sendError(res, 404, 'NOT_FOUND', 'Task not found');
    return res.json(items().move(id, req.body, actor));
  }));
  // The owner's own summary setting decides (409 SUMMARY_DISABLED when it is off there); the summary runs and is stored on the owner.
  router.post('/:id/summarize', write, wrap((req, res) => {
    const id = idOf(req.params.id);
    const current = summaryOf();
    if (!current) return sendError(res, 404, 'NOT_FOUND', 'Not found');
    if (id === null) return sendError(res, 404, 'NOT_FOUND', 'Task not found');
    const { started } = current.summarize(owner(), id);
    return res.status(202).json({ started });
  }));
  router.delete('/:id', write, wrap((req, res) => {
    const id = idOf(req.params.id);
    if (id === null) return sendError(res, 404, 'NOT_FOUND', 'Task not found');
    items().remove(id, actor);
    return res.status(204).end();
  }));
  router.use((req, res) => sendError(res, 404, 'NOT_FOUND', 'Not found'));

  router.closeStreams = () => { for (const stream of [...streams]) stream.close(); };
  return router;
}

module.exports = { createAttentionRoutes, createEngineAttentionRouter, createCounter };
