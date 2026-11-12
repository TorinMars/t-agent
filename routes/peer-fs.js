// Peer file access (read only; services/peer-fs.js, "Peer file access" in DESIGN.md). Three routers:
//  - engine: /v1/peer-fs/{info,list,read,search} on the Engine whose files are read, behind requireEngineAuth('files:read') (routes/engine-v1.js).
//    When this Engine's switch (services/peer-fs-settings.js) is off, every route answers 403 PEER_FS_DISABLED.
//  - relay: /api/peer-fs/{engines,list,read,search} on the Engine that runs the Claude / Codex session, for its `t-agent-peers` MCP server
//    (scripts/peer-mcp.js). No browser login: the credential is the terminal's hook token (routes/terminal.js) in X-T-Agent-Task,
//    X-T-Agent-Terminal and X-T-Agent-Token, and only requests from this machine are taken. Mounted in server.js before the session and the
//    gates; a request without any of these headers, or from another machine, is passed on untouched (so it meets the login gate like any route).
//    The requests go to the linked Engine's /v1/peer-fs with the stored token, through services/remote-client.js (tunnel:// included).
//  - settings: GET / PUT /api/peer-fs/settings `{ enabled }`, behind the browser login like the other settings.
const express = require('express');
const { ERRORS, errorBody, failure, createPeerFs } = require('../services/peer-fs');
const { fromThisMachine, isTerminalRequest, verifyTerminalRequest } = require('../lib/terminal-relay-auth');

const CAPABILITY = 'peer-fs:read';
const INFO_TIMEOUT_MS = 3000;
const READ_TIMEOUT_MS = 15_000;
const SEARCH_TIMEOUT_MS = 20_000;
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

// Codes of the relay itself (the codes of services/peer-fs.js pass through unchanged).
const RELAY_ERRORS = {
  PEER_FS_AUTH_REQUIRED: [401, 'The terminal headers X-T-Agent-Task, X-T-Agent-Terminal and X-T-Agent-Token are required'],
  PEER_FS_AUTH_INVALID: [403, 'The terminal token is not valid'],
  PEER_FS_DISABLED: [403, 'File access for linked engines is turned off on this engine'],
  ENGINE_REQUIRED: [400, 'Name the linked engine to read from'],
  ENGINE_NOT_FOUND: [404, 'No linked engine has this id or name'],
  PEER_FS_UNSUPPORTED: [501, 'The linked engine is too old to share its files; update it first'],
  ENGINE_OFFLINE: [502, 'The linked engine cannot be reached'],
  ENGINE_UNAUTHORIZED: [502, 'The linked engine did not accept the token of this engine'],
};

function sendFsError(res, error) {
  const { status, body } = errorBody(error);
  res.status(status).json(body);
}

function sendRelayError(res, code) {
  const [status, message] = RELAY_ERRORS[code];
  res.status(status).json({ error: code, message });
}

const defaultSettings = () => require('../services/peer-fs-settings').peerFsSettings();

// \u2500\u2500 Engine side \u2500\u2500
// `tasksFor(req)` gives the non-archived tasks the caller may see (per-task visibility of a service link applied by the caller).
function createPeerFsEngineRouter({ peerFs = createPeerFs(), settings = defaultSettings, tasksFor = () => [], identity = () => require('../services/engine-identity').getEngineIdentity() } = {}) {
  const router = express.Router();
  router.use((req, res, next) => (settings().enabled() ? next() : sendFsError(res, failure('PEER_FS_DISABLED'))));
  const handle = run => async (req, res) => {
    try { res.json(await run(req)); }
    catch (error) { sendFsError(res, error); }
  };
  router.get('/info', handle(async req => ({
    name: identity().name,
    home: peerFs.home(),
    platform: process.platform,
    tasks: tasksFor(req).map(task => ({ id: task.id, title: task.title, work_dir: task.work_dir || null })),
  })));
  router.get('/list', handle(req => peerFs.list(req.query.path)));
  router.get('/read', handle(req => peerFs.read(req.query.path, { offset: req.query.offset, limit: req.query.limit })));
  router.get('/search', handle(req => peerFs.search(req.query.path, req.query)));
  return router;
}

// \u2500\u2500 Local relay \u2500\u2500
// The terminal credential and the this-machine rule are shared with the tcli relay (lib/terminal-relay-auth.js).
const RELAY_PATHS = ['/engines', '/list', '/read', '/search'];
const FORWARD_KEYS = {
  list: ['path'],
  read: ['path', 'offset', 'limit'],
  search: ['path', 'pattern', 'glob', 'ignore_case', 'regex'],
};

function defaultRequest(...args) {
  return require('../services/remote-client').request(...args);
}

function defaultTokenOf(row) {
  const { decryptToken } = require('../lib/token-crypto');
  return decryptToken(row.token_cipher, require('../config').sessionSecret);
}

function createPeerFsRelayRouter({
  db = require('../db'),
  verifyToken = (...args) => require('./terminal').verifyHookToken(...args),
  settings = defaultSettings,
  request = defaultRequest,
  tokenOf = defaultTokenOf,
  isLocal = fromThisMachine,
  infoTimeoutMs = INFO_TIMEOUT_MS,
} = {}) {
  const router = express.Router();

  router.use(RELAY_PATHS, (req, res, next) => {
    if (!isTerminalRequest(req, isLocal)) return next('router');
    if (req.method !== 'GET') return next('router');
    const { error, task } = verifyTerminalRequest(req, { db, verifyToken });
    if (error) return sendRelayError(res, `PEER_FS_${error}`);
    if (!settings().enabled()) return sendRelayError(res, 'PEER_FS_DISABLED');
    req.peerFsOwner = task.user_id;
    next();
  });

  const engineRows = owner => db.prepare('SELECT * FROM remote_servers WHERE owner_id = ? AND enabled = 1 ORDER BY created_at ASC, id ASC').all(owner);

  // By id (as a string or number), else by name without regard to case.
  function findEngine(owner, value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const wanted = value.trim();
    const rows = engineRows(owner);
    if (/^\d+$/.test(wanted)) {
      const byId = rows.find(row => String(row.id) === String(Number(wanted)));
      if (byId) return byId;
    }
    const lower = wanted.toLowerCase();
    return rows.find(row => String(row.name || '').trim().toLowerCase() === lower) || null;
  }

  const capabilitiesOf = async (row, token) => {
    const info = await request(row.base_url, '/v1/info', token, { timeoutMs: infoTimeoutMs });
    return info && Array.isArray(info.capabilities) ? info.capabilities : [];
  };

  router.get('/engines', async (req, res) => {
    const rows = engineRows(req.peerFsOwner);
    const engines = await Promise.all(rows.map(async row => {
      const base = { id: String(row.id), name: row.name, online: false, supported: false, disabled: false, home: null, platform: null, tasks: [] };
      let token;
      try { token = tokenOf(row); } catch { return { ...base, error: 'ENGINE_UNAUTHORIZED' }; }
      try {
        const info = await request(row.base_url, '/v1/peer-fs/info', token, { timeoutMs: infoTimeoutMs });
        return {
          ...base, name: row.name || info.name, online: true, supported: true,
          home: typeof info.home === 'string' ? info.home : null,
          platform: typeof info.platform === 'string' ? info.platform : null,
          tasks: Array.isArray(info.tasks) ? info.tasks : [],
        };
      } catch (error) {
        if (!error.statusCode) return { ...base, error: 'ENGINE_OFFLINE' };
        const code = error.peerBody && error.peerBody.error;
        if (code === 'PEER_FS_DISABLED') return { ...base, online: true, supported: true, disabled: true };
        if (error.statusCode === 401) return { ...base, online: true, error: 'ENGINE_UNAUTHORIZED' };
        return { ...base, online: true, error: 'PEER_FS_UNSUPPORTED' };
      }
    }));
    res.json({ engines });
  });

  const forward = op => async (req, res) => {
    if (typeof req.query.engine !== 'string' || !req.query.engine.trim()) return sendRelayError(res, 'ENGINE_REQUIRED');
    const row = findEngine(req.peerFsOwner, req.query.engine);
    if (!row) return sendRelayError(res, 'ENGINE_NOT_FOUND');
    let token;
    try { token = tokenOf(row); } catch { return sendRelayError(res, 'ENGINE_UNAUTHORIZED'); }
    const query = new URLSearchParams();
    for (const key of FORWARD_KEYS[op]) {
      if (typeof req.query[key] === 'string') query.set(key, req.query[key]);
    }
    const search = query.toString();
    try {
      const body = await request(row.base_url, `/v1/peer-fs/${op}${search ? `?${search}` : ''}`, token, {
        timeoutMs: op === 'search' ? SEARCH_TIMEOUT_MS : READ_TIMEOUT_MS, maxBytes: MAX_ANSWER_BYTES,
      });
      res.json(body);
    } catch (error) {
      if (!error.statusCode) return sendRelayError(res, 'ENGINE_OFFLINE');
      const peer = error.peerBody || {};
      // An answer of the peer-fs API: passed on with its status, code and message.
      if (typeof peer.error === 'string' && ERRORS[peer.error]) {
        return res.status(error.statusCode).json({ error: peer.error, message: typeof peer.message === 'string' ? peer.message : ERRORS[peer.error][1] });
      }
      if (error.statusCode === 401) return sendRelayError(res, 'ENGINE_UNAUTHORIZED');
      // Anything else (a 404 page, a redirect to the login): an Engine from before this feature, or a real failure of a current one.
      let capabilities;
      try { capabilities = await capabilitiesOf(row, token); }
      catch (infoError) { return sendRelayError(res, infoError.statusCode ? 'PEER_FS_UNSUPPORTED' : 'ENGINE_OFFLINE'); }
      if (!capabilities.includes(CAPABILITY)) return sendRelayError(res, 'PEER_FS_UNSUPPORTED');
      const code = /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'PEER_FS_READ_FAILED';
      res.status(error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 502).json({ error: code });
    }
  };
  router.get('/list', forward('list'));
  router.get('/read', forward('read'));
  router.get('/search', forward('search'));
  return router;
}

// \u2500\u2500 Settings (browser session) \u2500\u2500
function createPeerFsSettingsRouter({ settings = defaultSettings } = {}) {
  const router = express.Router();
  router.get('/settings', (req, res) => res.json({ enabled: settings().enabled() }));
  router.put('/settings', (req, res) => {
    const enabled = req.body && req.body.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'enabled must be true or false' });
    res.json(settings().setEnabled(enabled));
  });
  return router;
}

module.exports = { CAPABILITY, RELAY_ERRORS, fromThisMachine, createPeerFsEngineRouter, createPeerFsRelayRouter, createPeerFsSettingsRouter };
