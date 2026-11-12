// tcli, the command line of agent sessions in T-Agent terminals (scripts/tcli.js; "tcli (agent command line)" in DESIGN.md). Two routers with the
// same OSS routes (list, stat, object GET / PUT, copy, move, remove, sign):
//  - relay: /api/tcli/oss/* on this machine, for tcli. No browser login: the credential is the terminal's hook token in X-T-Agent-Task,
//    X-T-Agent-Terminal and X-T-Agent-Token (lib/terminal-relay-auth.js, as for the peer file relay), and only requests from this machine are
//    taken; any other request is passed on untouched. Mounted in server.js before the body parsers, the session and the gates, so an upload is
//    streamed as it comes. When this engine has no OSS of its own and a linked service provides OSS upload (services/linked-capabilities.js),
//    the call goes on to that service's /v1/oss/files with the link's token, streams included.
//  - engine: /v1/oss/files/* (routes/engine-v1.js, behind requireEngineAuth('engine:admin'), capability `oss:files`), this engine's own bucket only,
//    so a linked service never chains further.
// Both apply the agent-access switch of their own engine (services/oss-agent-settings.js). Errors are JSON { error, message }.
const http = require('http');
const https = require('https');
const express = require('express');
const { ERRORS, OssFilesError, errorBody, MAX_PUT_BYTES } = require('../services/oss-files');
const { fromThisMachine, isTerminalRequest, verifyTerminalRequest } = require('../lib/terminal-relay-auth');

const CAPABILITY = 'oss:files';
const ENGINE_BASE = '/v1/oss/files';
const META_TIMEOUT_MS = 30_000;
const INFO_TIMEOUT_MS = 3_000;
const TRANSFER_IDLE_MS = 10 * 60_000; // a linked transfer that stops moving for this long is cut
const CAPABILITY_CACHE_MS = 60_000;
const SMALL_ANSWER_BYTES = 64 * 1024;
const JSON_LIMIT = '2mb'; // 1000 keys of up to 1023 bytes

const RELAY_ERRORS = {
  TCLI_AUTH_REQUIRED: [401, 'The terminal headers X-T-Agent-Task, X-T-Agent-Terminal and X-T-Agent-Token are required'],
  TCLI_AUTH_INVALID: [403, 'The terminal token is not valid'],
};

function sendError(res, error) {
  const { status, body } = errorBody(error);
  if (error && error.provider) body.provider = error.provider;
  res.status(status).set('Cache-Control', 'no-store').json(body);
}

// Content-Length, else `?size=` (the tunnel of a service link drops Content-Length and sends the body in chunks).
function uploadSize(req) {
  const header = req.get('content-length');
  const query = typeof req.query.size === 'string' ? req.query.size : undefined;
  const parse = value => (/^\d{1,13}$/.test(value) ? Number(value) : NaN);
  const fromHeader = header === undefined ? undefined : parse(header);
  const fromQuery = query === undefined ? undefined : parse(query);
  if (Number.isNaN(fromHeader) || Number.isNaN(fromQuery)) throw new OssFilesError('INVALID_ARGUMENT', 'The size must be a whole number');
  if (fromHeader !== undefined && fromQuery !== undefined && fromHeader !== fromQuery) throw new OssFilesError('INVALID_ARGUMENT', 'Content-Length and size disagree');
  const size = fromHeader !== undefined ? fromHeader : fromQuery;
  if (size === undefined) throw new OssFilesError('LENGTH_REQUIRED');
  if (size > MAX_PUT_BYTES) throw new OssFilesError('TOO_LARGE', 'tcli uploads at most 1 GiB per object');
  return size;
}

// The routes of both routers, on `backendFor(req)`: this engine's bucket (localBackend) or a linked service's (remoteBackend).
function mountOssRoutes(router, backendFor) {
  const json = express.json({ limit: JSON_LIMIT });
  const answer = run => async (req, res) => {
    try {
      const backend = await backendFor(req);
      res.set('Cache-Control', 'no-store').json(await run(backend, req.body || {}, req));
    } catch (error) { sendError(res, error); }
  };
  router.get('/list', answer((backend, body, req) => backend.list({ prefix: req.query.prefix, delimiter: req.query.delimiter, marker: req.query.marker, max: req.query.max })));
  router.get('/stat', answer((backend, body, req) => backend.stat(req.query.key)));
  router.get('/object', async (req, res) => {
    try { await (await backendFor(req)).download(req.query.key, req, res); }
    catch (error) { if (res.headersSent) res.destroy(); else sendError(res, error); }
  });
  router.put('/object', async (req, res) => {
    try {
      const size = uploadSize(req);
      const backend = await backendFor(req);
      const contentType = req.get('content-type') || 'application/octet-stream';
      res.set('Cache-Control', 'no-store').json(await backend.upload(req.query.key, req, { size, contentType }));
    } catch (error) {
      // The rest of a refused body is not read: the connection ends after the answer.
      if (!req.complete) res.set('Connection', 'close');
      sendError(res, error);
    }
  });
  router.post('/copy', json, answer((backend, body) => backend.copy(body.src, body.dst)));
  router.post('/move', json, answer((backend, body) => backend.move(body.src, body.dst)));
  router.post('/remove', json, answer((backend, body) => {
    if (body.confirm !== true) throw new OssFilesError('CONFIRM_REQUIRED');
    return backend.remove(body.keys);
  }));
  router.post('/sign', json, answer((backend, body) => backend.sign(body.key, { expires: body.expires, method: body.method })));
  // A body the JSON parser refused.
  router.use((error, req, res, next) => {
    if (error && error.type === 'entity.too.large') return sendError(res, new OssFilesError('TOO_LARGE', 'The request body is too large'));
    if (error && error.type) return sendError(res, new OssFilesError('INVALID_ARGUMENT', 'Invalid JSON body'));
    next(error);
  });
}

function localBackend(files, owner) {
  return {
    list: query => files.list(owner, query),
    stat: key => files.stat(owner, key),
    async download(key, req, res) {
      const object = await files.get(owner, key);
      res.status(200).set({ 'Content-Type': object.content_type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (object.size !== null) res.set('Content-Length', String(object.size));
      if (object.etag) res.set('ETag', `"${object.etag}"`);
      if (object.last_modified) res.set('Last-Modified', object.last_modified);
      res.on('close', () => object.stream.destroy());
      object.stream.on('error', () => res.destroy());
      object.stream.pipe(res);
    },
    upload: (key, req, { size, contentType }) => files.put(owner, key, req, { size, contentType }),
    copy: (src, dst) => files.copy(owner, src, dst),
    move: (src, dst) => files.move(owner, src, dst),
    remove: keys => files.remove(owner, keys),
    sign: (key, options) => files.sign(owner, key, options),
  };
}

// ── Linked provider ──
function transportFor(target) {
  const { TUNNEL_PROTOCOL, getHub } = require('../lib/service-link-tunnel');
  return target.protocol === TUNNEL_PROTOCOL ? getHub() : target.protocol === 'https:' ? https : http;
}

// The largest upload a provider behind a service link tunnel takes: what its tunnel client announced (a T-Agent from before streamed request
// bodies announces nothing and takes 64 MiB), or null when it is not a tunnel. An offline tunnel is the provider being offline.
function tunnelUploadLimit(peer) {
  const { isTunnelBase, linkIdOf, getHub } = require('../lib/service-link-tunnel');
  if (!isTunnelBase(peer.baseUrl)) return null;
  const limit = getHub().requestBodyLimit(linkIdOf(peer.baseUrl));
  if (limit === null) throw providerFailure(peer, 0);
  return limit;
}

// An error answer of the provider as one of ours: its OSS codes pass through, a refused token is the link failing, anything else is a failure.
function providerFailure(peer, status, parsed) {
  let error;
  if (!status) error = new OssFilesError('LINKED_PROVIDER_OFFLINE');
  else if (parsed && typeof parsed.error === 'string' && ERRORS[parsed.error]) {
    error = new OssFilesError(parsed.error, typeof parsed.message === 'string' && parsed.message ? parsed.message.slice(0, 500) : undefined);
    if (typeof parsed.oss_code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(parsed.oss_code)) error.ossCode = parsed.oss_code;
  } else if (status === 401 || status === 403) error = new OssFilesError('LINKED_PROVIDER_UNAUTHORIZED');
  else error = new OssFilesError('OSS_REQUEST_FAILED');
  error.provider = peer.name || null;
  return error;
}

function readSmall(response) {
  return new Promise(resolve => {
    const chunks = [];
    let length = 0;
    response.on('data', chunk => {
      length += chunk.length;
      if (length <= SMALL_ANSWER_BYTES) chunks.push(chunk);
    });
    response.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
    });
    response.on('error', () => resolve(null));
  });
}

function remoteBackend(peer, request) {
  const target = (route, query) => {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(query || {})) if (typeof value === 'string') search.set(name, value);
    const text = search.toString();
    return `${ENGINE_BASE}${route}${text ? `?${text}` : ''}`;
  };
  async function call(method, route, { query, body } = {}) {
    try {
      return await request(peer.baseUrl, target(route, query), peer.token, { method, ...(body ? { body } : {}), timeoutMs: META_TIMEOUT_MS, maxBytes: 8 * 1024 * 1024 });
    } catch (error) {
      throw providerFailure(peer, error.statusCode, error.peerBody);
    }
  }
  // One streamed request to the provider; resolves with its response once the head has come.
  function open(method, path, headers, timeoutMs) {
    const url = new URL(path, `${peer.baseUrl}/`);
    let upstream;
    const response = new Promise((resolve, reject) => {
      upstream = transportFor(url).request(url, { method, headers: { Authorization: `Bearer ${peer.token}`, ...headers }, timeout: timeoutMs }, resolve);
      upstream.on('timeout', () => upstream.destroy(new Error('REMOTE_TIMEOUT')));
      upstream.on('error', reject);
    });
    return { upstream, response };
  }
  return {
    list: query => call('GET', '/list', { query }),
    stat: key => call('GET', '/stat', { query: { key } }),
    async download(key, req, res) {
      const { upstream, response: pending } = open('GET', target('/object', { key }), { Accept: '*/*' }, META_TIMEOUT_MS);
      upstream.end();
      let response;
      try { response = await pending; } catch { throw providerFailure(peer, 0); }
      if (response.statusCode !== 200) throw providerFailure(peer, response.statusCode, await readSmall(response));
      // The head came: from here on the transfer may take as long as it needs, while it keeps moving.
      upstream.setTimeout(TRANSFER_IDLE_MS);
      res.status(200).set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      for (const name of ['content-type', 'content-length', 'etag', 'last-modified']) if (response.headers[name]) res.set(name, response.headers[name]);
      res.on('close', () => upstream.destroy());
      response.on('error', () => res.destroy());
      response.pipe(res);
    },
    async upload(key, req, { size, contentType }) {
      const tunnelLimit = tunnelUploadLimit(peer);
      if (tunnelLimit !== null && size > tunnelLimit) {
        const mib = Math.floor(tunnelLimit / (1024 * 1024));
        throw Object.assign(new OssFilesError('TOO_LARGE', `Through its service link tunnel the linked service takes at most ${mib} MiB per object; update T-Agent there to upload up to 1 GiB`), { provider: peer.name || null });
      }
      const { upstream, response: pending } = open('PUT', target('/object', { key, size: String(size) }), {
        'Content-Type': contentType, 'Content-Length': String(size), Accept: 'application/json',
      }, TRANSFER_IDLE_MS);
      let answered = false;
      pending.then(() => { answered = true; }, () => {});
      // Backpressure on both transports: a direct connection's socket, or the tunnel stream's credit (write() is false once a window is queued).
      req.on('data', chunk => {
        if (upstream.write(chunk) === false && typeof req.pause === 'function') {
          req.pause();
          upstream.once('drain', () => req.resume());
        }
      });
      req.on('end', () => upstream.end());
      req.on('close', () => { if (!req.complete && !answered) upstream.destroy(new Error('CLIENT_GONE')); });
      let response;
      try { response = await pending; } catch { throw providerFailure(peer, 0); }
      const parsed = await readSmall(response);
      if (response.statusCode !== 200) throw providerFailure(peer, response.statusCode, parsed);
      if (!parsed || typeof parsed !== 'object') throw providerFailure(peer, 502, null);
      return parsed;
    },
    copy: (src, dst) => call('POST', '/copy', { body: { src, dst } }),
    move: (src, dst) => call('POST', '/move', { body: { src, dst } }),
    remove: keys => call('POST', '/remove', { body: { keys, confirm: true } }),
    sign: (key, { expires, method } = {}) => call('POST', '/sign', { body: { key, expires, method } }),
  };
}

const defaultFiles = () => require('../services/oss-files').ossFiles();
const defaultSettings = () => require('../services/oss-agent-settings').ossAgentSettings();
const defaultOwner = () => require('../services/single-user').ensureSingleUser().login;
const defaultRequest = (...args) => require('../services/remote-client').request(...args);

// ── Local relay (mounted at /api/tcli) ──
function createTcliRelayRouter({
  db = require('../db'),
  verifyToken = (...args) => require('./terminal').verifyHookToken(...args),
  isLocal = fromThisMachine,
  files = defaultFiles,
  settings = defaultSettings,
  // The account a browser session gets, so the stored "Image and file upload" configuration is the one the Settings page shows.
  owner = defaultOwner,
  linked = () => require('../services/linked-capabilities').getLinkedCapabilities(),
  request = defaultRequest,
  now = Date.now,
} = {}) {
  const router = express.Router();
  const capable = new Map(); // peer id -> time the capability was seen

  router.use('/oss', (req, res, next) => {
    if (!isTerminalRequest(req, isLocal)) return next('router');
    const { error } = verifyTerminalRequest(req, { db, verifyToken });
    if (error) {
      const [status, message] = RELAY_ERRORS[`TCLI_${error}`];
      if (!req.complete) res.set('Connection', 'close');
      return res.status(status).json({ error: `TCLI_${error}`, message });
    }
    if (!settings().enabled()) {
      if (!req.complete) res.set('Connection', 'close');
      return sendError(res, new OssFilesError('OSS_AGENT_ACCESS_OFF'));
    }
    next();
  });

  async function checkCapability(peer) {
    const seen = capable.get(peer.id);
    if (seen !== undefined && now() - seen < CAPABILITY_CACHE_MS) return;
    let info;
    try { info = await request(peer.baseUrl, '/v1/info', peer.token, { timeoutMs: INFO_TIMEOUT_MS }); }
    catch (error) { throw providerFailure(peer, error.statusCode === 401 || error.statusCode === 403 ? error.statusCode : 0); }
    if (!info || !Array.isArray(info.capabilities) || !info.capabilities.includes(CAPABILITY)) {
      capable.delete(peer.id);
      throw Object.assign(new OssFilesError('OSS_FILES_UNSUPPORTED'), { provider: peer.name || null });
    }
    capable.set(peer.id, now());
  }

  // This engine's own bucket first; only without one does a linked provider get the call (and never a refused one: a failure of the own
  // bucket stays here).
  async function backendFor() {
    const service = files();
    const id = owner();
    const links = linked && linked();
    if (!links || service.isConfigured(id)) return localBackend(service, id);
    const peer = await links.providerFor('oss');
    if (!peer) return localBackend(service, id);
    await checkCapability(peer);
    return remoteBackend(peer, request);
  }

  const oss = express.Router();
  mountOssRoutes(oss, backendFor);
  // An authenticated request for a route tcli does not have is answered here, not passed on to the login gate.
  oss.use((req, res) => res.status(404).json({ error: 'UNKNOWN_ROUTE', message: 'tcli has no such route; update tcli or T-Agent' }));
  router.use('/oss', oss);
  return router;
}

// ── Engine routes (mounted at /v1/oss/files, after requireEngineAuth('engine:admin')) ──
function createOssFilesEngineRouter({ files = defaultFiles, settings = defaultSettings, owner = defaultOwner } = {}) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (settings().enabled()) return next();
    if (!req.complete) res.set('Connection', 'close');
    sendError(res, new OssFilesError('OSS_AGENT_ACCESS_OFF'));
  });
  mountOssRoutes(router, async () => localBackend(files(), owner()));
  return router;
}

module.exports = { CAPABILITY, RELAY_ERRORS, createTcliRelayRouter, createOssFilesEngineRouter };
