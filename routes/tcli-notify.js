'use strict';
// The relay of `tcli notify` (scripts/tcli-notify.js; "tcli (agent command line)" in docs/design/tcli.md and "Direct messages" under "T-Attention notifiers" in docs/design/attention-notifiers.md):
// an agent session in a T-Agent terminal tells the user something on the configured notifiers (Telegram, email ... every plugin with `direct: true`).
//  - POST /api/tcli/notify { text, title?, via?: [names] | 'all', link? } -> 200 { results: [{ notifier, outcome, detail?, via? }] }
//  - GET  /api/tcli/notify/status -> { agentMessages, quietHours: { enabled, start, end, timeZone, active }, notifiers: [{ name, label, enabled, ready, via? }] }
// The credential is the terminal's hook token (lib/terminal-relay-auth.js), taken only from this machine; a request without the X-T-Agent-* headers
// is passed on untouched. server.js mounts it with the other tcli relays, before the body parsers, the session and the gates.
// `from` is made here from the terminal (the task title and the terminal's name), never taken from the body. The link is the page under the rules'
// publicUrl (the page has no address of one terminal; without a publicUrl there is no link) unless the command gave one.
// The rules switch "Let agent sessions send messages (tcli notify)" (agentMessages) off: 403 NOTIFY_AGENT_ACCESS_OFF (from sendDirect). Errors are
// JSON { error, message }.
const express = require('express');
const { fromThisMachine, isTerminalRequest, verifyTerminalRequest } = require('../lib/terminal-relay-auth');

const JSON_LIMIT = '16kb';
const RELAY_ERRORS = {
  TCLI_AUTH_REQUIRED: [401, 'The terminal headers X-T-Agent-Task, X-T-Agent-Terminal and X-T-Agent-Token are required'],
  TCLI_AUTH_INVALID: [403, 'The terminal token is not valid'],
};

const oneLine = (value, max) => String(value || '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// "<task title> · <terminal name>" of the terminal that asks, or what is known of it.
function describeTerminal(db, terminalName, taskId, terminalId) {
  let task = '';
  try { const row = db.prepare('SELECT title FROM tasks WHERE id = ?').get(taskId); task = oneLine(row && row.title, 120); } catch { task = ''; }
  let terminal = '';
  try { terminal = oneLine(terminalName(taskId, terminalId), 60); } catch { terminal = ''; }
  return [task, terminal].filter(Boolean).join(' · ');
}

// The name the page shows for a terminal (routes/terminal.js listTerminals: the person's name, or the agent session's name).
function defaultTerminalName(taskId, terminalId) {
  const row = require('./terminal').listTerminals(taskId).find(entry => entry.terminal_id === terminalId);
  return row ? row.title : '';
}

function sendError(res, error) {
  const status = Number.isInteger(error && error.statusCode) ? error.statusCode : 500;
  const known = error && (error.code || error.name === 'NotifyError');
  const code = error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : status >= 500 ? 'NOTIFY_FAILED' : 'INVALID_REQUEST';
  const message = known && error.message ? String(error.message).slice(0, 300) : 'The message could not be sent';
  res.status(status).set('Cache-Control', 'no-store').json({ error: code, message });
}

// options: db, verifyToken (routes/terminal.js verifyHookToken), isLocal, notify() -> the attention-notify service (sendDirect, directStatus,
// rules), owner() -> the single user, terminalName(taskId, terminalId).
function createNotifyRelayRouter({
  db = require('../db'),
  verifyToken = (...args) => require('./terminal').verifyHookToken(...args),
  isLocal = fromThisMachine,
  notify,
  owner = () => require('../services/single-user').ensureSingleUser().login,
  terminalName = defaultTerminalName,
} = {}) {
  const router = express.Router();
  const service = () => {
    const value = typeof notify === 'function' ? notify() : null;
    if (!value) throw Object.assign(new Error('Notifications are not available on this T-Agent'), { statusCode: 503, code: 'NOTIFY_UNAVAILABLE' });
    return value;
  };

  router.use('/notify', (req, res, next) => {
    if (!isTerminalRequest(req, isLocal)) return next('router');
    const { error, task } = verifyTerminalRequest(req, { db, verifyToken });
    if (error) {
      const [status, message] = RELAY_ERRORS[`TCLI_${error}`];
      if (!req.complete) res.set('Connection', 'close');
      return res.status(status).json({ error: `TCLI_${error}`, message });
    }
    req.tcliTerminal = { taskId: task.id, terminalId: req.get('x-t-agent-terminal') };
    next();
  });

  const routes = express.Router();
  routes.use(express.json({ limit: JSON_LIMIT }));
  routes.get('/status', async (req, res) => {
    try { res.set('Cache-Control', 'no-store').json(await service().directStatus(owner())); }
    catch (error) { sendError(res, error); }
  });
  routes.post('/', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const notifier = service();
      const who = owner();
      const from = describeTerminal(db, terminalName, req.tcliTerminal.taskId, req.tcliTerminal.terminalId);
      let link = body.link;
      if (link === undefined || link === null || link === '') {
        const base = (notifier.rules(who) || {}).publicUrl;
        link = base ? `${base}/` : '';
      }
      const answer = await notifier.sendDirect({ owner: who, title: body.title, text: body.text, from, link, via: body.via });
      res.set('Cache-Control', 'no-store').json(answer);
    } catch (error) { sendError(res, error); }
  });
  routes.use((req, res) => res.status(404).json({ error: 'UNKNOWN_ROUTE', message: 'tcli has no such notify route; update tcli or T-Agent' }));
  // A body the JSON parser refused.
  routes.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error && error.type === 'entity.too.large') return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: 'The message is too large (at most 16 KB)' });
    if (error && error.type) return res.status(400).json({ error: 'INVALID_REQUEST', message: 'Invalid JSON body' });
    return sendError(res, error);
  });
  router.use('/notify', routes);
  return router;
}

module.exports = { createNotifyRelayRouter, describeTerminal, RELAY_ERRORS };
