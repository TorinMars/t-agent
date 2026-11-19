'use strict';
// The relay of the link shims (scripts/clipboard-shims/open, xdg-open, ta-browser; "Links opened by programs" in docs/design/terminals.md
// and docs/design/open-links.md): a program in a T-Agent terminal opened a web link, and the link goes to the page that shows that terminal
// instead of the browser of this machine.
//  - POST /api/tcli/open-link { url } -> 200 { delivered: true } when a page showing the terminal took it;
//    200 { delivered: false, reason } when none did (no page attached, the page shows another terminal, no answer in time, a link that only
//    works on this machine): the shim then runs the real open / xdg-open as before;
//    400 { error: 'INVALID_URL' }, 429 { error: 'TOO_MANY_LINKS', delivered: false } (more than RATE_MAX links in RATE_WINDOW_MS from one terminal).
// The credential is the terminal's hook token (lib/terminal-relay-auth.js), taken only from this machine; a request without the X-T-Agent-*
// headers is passed on untouched. server.js mounts it with the other tcli relays, before the body parsers, the session and the gates.
// Links are never logged.
const express = require('express');
const { fromThisMachine, isTerminalRequest, verifyTerminalRequest } = require('../lib/terminal-relay-auth');

const MAX_URL = 4096;
const RATE_MAX = 5;
const RATE_WINDOW_MS = 10_000;
const RELAY_ERRORS = {
  TCLI_AUTH_REQUIRED: [401, 'The terminal headers X-T-Agent-Task, X-T-Agent-Terminal and X-T-Agent-Token are required'],
  TCLI_AUTH_INVALID: [403, 'The terminal token is not valid'],
};

// A host that only means this machine: on another device it would reach that device instead.
function loopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
    || host === '0.0.0.0' || host === '::1' || host === '::' || /^::ffff:127\./.test(host);
}

// Checks a link: { ok: true, url } or { ok: false, reason }. reason 'invalid' is refused with 400; 'local-only' (the link's own host is this
// machine, for example a dev server on localhost) and 'local-callback' (a login whose redirect_uri / callback goes back to a server on this
// machine, as the OAuth logins of Claude Code and Codex do) are not offered to a page: they only work in the browser of this machine.
function checkLink(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_URL || !/^https?:\/\//i.test(value) || /[\u0000- \u007f-\u009f]/.test(value)) {
    return { ok: false, reason: 'invalid' };
  }
  let url;
  try { url = new URL(value); } catch { return { ok: false, reason: 'invalid' }; }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return { ok: false, reason: 'invalid' };
  if (loopbackHost(url.hostname)) return { ok: false, reason: 'local-only' };
  for (const [name, param] of url.searchParams) {
    if (!/redirect|callback|return/i.test(name) || !/^https?:\/\//i.test(param)) continue;
    try { if (loopbackHost(new URL(param).hostname)) return { ok: false, reason: 'local-callback' }; } catch { /* not a URL */ }
  }
  return { ok: true, url: value };
}

// At most `max` links per terminal in `windowMs`; answers whether one more is allowed (and counts it).
function createRateLimit({ max = RATE_MAX, windowMs = RATE_WINDOW_MS, now = Date.now } = {}) {
  const recent = new Map(); // terminal key -> times
  return key => {
    const at = now();
    const kept = (recent.get(key) || []).filter(time => at - time < windowMs);
    if (kept.length >= max) { recent.set(key, kept); return false; }
    kept.push(at);
    recent.set(key, kept);
    if (recent.size > 1000) for (const [other, times] of recent) if (!times.some(time => at - time < windowMs)) recent.delete(other);
    return true;
  };
}

// options: db, verifyToken (routes/terminal.js verifyHookToken), isLocal, offer(taskId, terminalId, url) -> Promise<{ delivered, reason? }>
// (routes/terminal.js offerLink), allow (the rate limit).
function createOpenLinkRelayRouter({
  db = require('../db'),
  verifyToken = (...args) => require('./terminal').verifyHookToken(...args),
  isLocal = fromThisMachine,
  offer = (...args) => require('./terminal').offerLink(...args),
  allow = createRateLimit(),
} = {}) {
  const router = express.Router();
  router.use('/open-link', (req, res, next) => {
    if (!isTerminalRequest(req, isLocal)) return next('router');
    res.set('Cache-Control', 'no-store');
    const { error, task } = verifyTerminalRequest(req, { db, verifyToken });
    if (error) {
      const [status, message] = RELAY_ERRORS[`TCLI_${error}`];
      if (!req.complete) res.set('Connection', 'close');
      return res.status(status).json({ error: `TCLI_${error}`, message });
    }
    req.linkTerminal = { taskId: task.id, terminalId: req.get('x-t-agent-terminal') };
    return next();
  });
  const routes = express.Router();
  routes.use(express.json({ limit: '16kb' }));
  routes.post('/', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const link = checkLink(body.url);
    if (!link.ok && link.reason === 'invalid') return res.status(400).json({ error: 'INVALID_URL', message: 'Only one http or https link of at most 4096 characters is accepted' });
    if (!link.ok) return res.json({ delivered: false, reason: link.reason });
    const { taskId, terminalId } = req.linkTerminal;
    if (!allow(`${taskId}:${terminalId}`)) return res.status(429).json({ error: 'TOO_MANY_LINKS', message: 'Too many links from this terminal; try again in a few seconds', delivered: false });
    try {
      const answer = await offer(taskId, terminalId, link.url);
      return res.json(answer && answer.delivered ? { delivered: true } : { delivered: false, reason: (answer && answer.reason) || 'no-viewer' });
    } catch {
      return res.json({ delivered: false, reason: 'no-viewer' });
    }
  });
  routes.use((req, res) => res.status(404).json({ error: 'UNKNOWN_ROUTE', message: 'Use POST /api/tcli/open-link' }));
  routes.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error && error.type === 'entity.too.large') return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: 'The request is too large' });
    if (error && error.type) return res.status(400).json({ error: 'INVALID_REQUEST', message: 'Invalid JSON body' });
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Internal error' });
  });
  router.use('/open-link', routes);
  return router;
}

module.exports = { createOpenLinkRelayRouter, checkLink, loopbackHost, createRateLimit, MAX_URL, RATE_MAX, RATE_WINDOW_MS };
