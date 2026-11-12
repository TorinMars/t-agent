// Routes of the browser extension ("Browser extension" in DESIGN.md; services/browser-bridge.js, services/browser-recordings.js). Three routers:
//  - pair:  POST /api/browser-ext/pair, for the extension's options page. No login (the one-time code is the credential), so server.js mounts
//           it before the session and the gates. This machine only (anything else gets the 404 of an unknown route), and from an extension
//           page or a program without an Origin (a web page's Origin gets 403). CORS answers for chrome-extension:// origins.
//  - page:  /api/browser-ext (behind the login): GET (paired browsers, online state, the extension folder), POST /pair-code,
//           PATCH /:browser_id { name }, DELETE /:browser_id (revokes; the open socket is closed with 4401).
//  - relay: /api/tcli/browser/* for `tcli browser` (scripts/tcli-browser.js): the terminal hook token in X-T-Agent-Task, X-T-Agent-Terminal and
//           X-T-Agent-Token (lib/terminal-relay-auth.js) from this machine, mounted like the OSS relay before the body parsers and the gates.
//           A request without those headers, or not from this machine, is passed on untouched (and meets the login gate).
// Errors are JSON { error, message }. Answers are never cached and never logged.
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { fromThisMachine, isTerminalRequest, verifyTerminalRequest } = require('../lib/terminal-relay-auth');

const EXTENSION_DIR = path.resolve(__dirname, '..', 'extensions', 'chrome');
const RELAY_ERRORS = {
  AUTH_REQUIRED: [401, 'The terminal headers X-T-Agent-Task, X-T-Agent-Terminal and X-T-Agent-Token are required'],
  AUTH_INVALID: [403, 'The terminal token is not valid'],
};
const CMD_BODY_LIMIT = '8mb';

function sendError(res, error) {
  const status = Number.isInteger(error && error.status) ? error.status : 500;
  const code = (error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code)) ? error.code : 'INTERNAL_ERROR';
  const message = status >= 500 && code === 'INTERNAL_ERROR' ? 'Internal error' : String((error && error.message) || code);
  res.status(status).set('Cache-Control', 'no-store').json({ error: code, message });
}
const jsonErrors = (error, req, res, next) => {
  if (error && error.type === 'entity.too.large') return res.status(413).json({ error: 'TOO_LARGE', message: 'The request body is too large' });
  if (error && error.type) return res.status(400).json({ error: 'BAD_JSON', message: 'Invalid JSON body' });
  return next(error);
};

// ── Pairing (before the session and the gates) ──
function createBrowserPairRouter({ bridge, isLocal = fromThisMachine } = {}) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!isLocal(req)) return res.status(404).type('text').send('Not Found');
    const origin = req.get('origin');
    if (origin !== undefined && !/^chrome-extension:\/\/[a-z0-9-]{1,64}$/i.test(origin)) {
      return res.status(403).json({ error: 'ORIGIN_NOT_ALLOWED', message: 'Pairing is only accepted from the T-Agent browser extension' });
    }
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', 'POST');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.set('Access-Control-Max-Age', '600');
    }
    res.set('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED', message: 'Use POST' });
    return next();
  });
  router.post('/', express.json({ limit: '16kb' }), (req, res) => {
    try { res.json(bridge().pair(req.body || {})); } catch (error) { sendError(res, error); }
  });
  router.use(jsonErrors);
  return router;
}

// ── The page (behind the login) ──
function createBrowserPageRouter({ bridge, extensionDir = EXTENSION_DIR, localUrl = () => null } = {}) {
  const router = express.Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/', (req, res) => {
    const status = bridge().status();
    res.json({
      ...status,
      extension_dir: extensionDir,
      extension_present: fs.existsSync(path.join(extensionDir, 'manifest.json')),
      server_url: localUrl(),
    });
  });
  router.post('/pair-code', (req, res) => {
    try { res.json(bridge().createPairCode()); } catch (error) { sendError(res, error); }
  });
  router.patch('/:browserId', (req, res) => {
    try { res.json(bridge().rename(req.params.browserId, req.body && req.body.name)); } catch (error) { sendError(res, error); }
  });
  router.delete('/:browserId', (req, res) => {
    try { res.json(bridge().remove(req.params.browserId)); } catch (error) { sendError(res, error); }
  });
  return router;
}

// ── tcli relay (before the body parsers, the session and the gates) ──
function createBrowserRelayRouter({
  bridge,
  recordings,
  db = null,
  verifyToken = (...args) => require('./terminal').verifyHookToken(...args),
  isLocal = fromThisMachine,
} = {}) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!isTerminalRequest(req, isLocal)) return next('router');
    const { error, task } = verifyTerminalRequest(req, { db: db || require('../db'), verifyToken });
    if (error) {
      const [status, message] = RELAY_ERRORS[error];
      if (!req.complete) res.set('Connection', 'close');
      return res.status(status).json({ error: `TCLI_${error}`, message });
    }
    req.terminalContext = { task_id: task.id, terminal_id: req.get('x-t-agent-terminal') };
    res.set('Cache-Control', 'no-store');
    return next();
  });

  router.get('/status', (req, res) => res.json(bridge().status()));

  router.post('/cmd', express.json({ limit: CMD_BODY_LIMIT }), async (req, res) => {
    const body = req.body || {};
    const timeoutMs = body.timeout_ms === undefined ? undefined : Number(body.timeout_ms);
    if (timeoutMs !== undefined && !Number.isFinite(timeoutMs)) return res.status(400).json({ error: 'BAD_PARAMS', message: 'timeout_ms must be a number' });
    try {
      const result = await bridge().command(body.method, body.params === undefined ? {} : body.params, { timeoutMs, context: req.terminalContext });
      return res.json(result);
    } catch (error) { return sendError(res, error); }
  });

  router.get('/recordings', (req, res) => {
    try { res.json({ recordings: recordings().list() }); } catch (error) { sendError(res, error); }
  });
  router.get('/recordings/:id', (req, res) => {
    try { res.json(recordings().get(req.params.id)); } catch (error) { sendError(res, error); }
  });
  router.get('/recordings/:id/items', (req, res) => {
    let stream;
    try { stream = recordings().itemsStream(req.params.id); } catch (error) { return sendError(res, error); }
    res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    stream.on('error', () => res.destroy());
    res.on('close', () => { if (typeof stream.destroy === 'function') stream.destroy(); });
    return stream.pipe(res);
  });
  router.delete('/recordings/:id', (req, res) => {
    try { res.json(recordings().remove(req.params.id)); } catch (error) { sendError(res, error); }
  });

  router.use(jsonErrors);
  // An authenticated request for a route tcli does not have is answered here, not passed on to the login gate.
  router.use((req, res) => res.status(404).json({ error: 'UNKNOWN_ROUTE', message: 'tcli browser has no such route; update tcli or T-Agent' }));
  return router;
}

module.exports = { createBrowserPairRouter, createBrowserPageRouter, createBrowserRelayRouter, EXTENSION_DIR };
