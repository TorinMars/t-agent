// Chat-style Claude / Codex conversations of a task: /api/tasks/:id/agent/...
const express = require('express');
const db = require('../db');
const requireAuth = require('../middleware/auth');
const { getAgentChat } = require('../services/agent-chat');
const { listSessions } = require('../lib/agent-sessions');

function createAgentChatRouter({ service = getAgentChat(), authenticate = requireAuth, ownerOf = req => req.session.user.login } = {}) {
  const router = express.Router({ mergeParams: true });
  router.use(authenticate);

  const taskOf = req => db.prepare('SELECT id, work_dir, archived_at FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, ownerOf(req));
  const handle = run => async (req, res) => {
    const task = taskOf(req);
    if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
    try { res.json(await run(task, req, res)); }
    catch (error) { res.status(error.statusCode || 400).json({ error: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'AGENT_CHAT_FAILED' }); }
  };

  // What would give an agent work is refused while the task is archived (services/task-archive.js); reading a chat, renaming it or deleting it is not.
  const whileActive = run => handle((task, req, res) => {
    if (task.archived_at) throw Object.assign(new Error('TASK_ARCHIVED'), { statusCode: 409 });
    return run(task, req, res);
  });

  router.get('/conversations', handle(task => service.list(task.id)));
  router.post('/conversations', whileActive((task, req) => service.create(task, req.body || {})));
  router.get('/sessions', handle((task, req) => listSessions(req.query.agent, task.work_dir)));
  router.get('/conversations/:cid', handle((task, req) => service.snapshot(task, req.params.cid)));
  router.patch('/conversations/:cid', handle((task, req) => {
    const body = req.body || {};
    let result = { success: true };
    if (body.title !== undefined) service.rename(task, req.params.cid, body.title);
    if (body.mode !== undefined) result = service.setMode(task, req.params.cid, body.mode);
    if (body.model !== undefined || body.effort !== undefined) result = service.setPreferences(task, req.params.cid, { model: body.model, effort: body.effort });
    if (body.translate !== undefined) result = service.setTranslate(task, req.params.cid, body.translate);
    if (body.collapseKeyboard !== undefined) result = service.setCollapseKeyboard(task, req.params.cid, body.collapseKeyboard);
    if (body.opened !== undefined) result = service.setOpened(task, req.params.cid, { surface: body.surface, opened: body.opened });
    return result;
  }));
  // The same as PATCH { opened, surface }, for a network path that lets POST through but not PATCH (the phone page tries this first).
  router.post('/conversations/:cid/opened', handle((task, req) => service.setOpened(task, req.params.cid, { surface: (req.body || {}).surface, opened: (req.body || {}).opened })));
  // The queued messages of the chat, replaced as a whole (POST, because some network paths let POST through but not PUT or PATCH).
  router.post('/conversations/:cid/queue', handle((task, req) => service.setQueue(task, req.params.cid, (req.body || {}).queue)));
  // The queue is changed by operations (all POST, for the same reason); the Client sends the queued messages itself when a turn ends.
  router.post('/conversations/:cid/queue/add', whileActive((task, req) => service.queueAdd(task, req.params.cid, req.body || {})));
  router.post('/conversations/:cid/queue/:eid/remove', handle((task, req) => service.queueRemove(task, req.params.cid, req.params.eid)));
  router.post('/conversations/:cid/queue/:eid/edit', handle((task, req) => service.queueEdit(task, req.params.cid, req.params.eid, (req.body || {}).text)));
  router.post('/conversations/:cid/queue/:eid/send', whileActive((task, req) => service.queueSendNow(task, req.params.cid, req.params.eid)));
  // A new conversation that continues from a message of this one: { itemId } -> { conversation, draft }.
  router.post('/conversations/:cid/fork', whileActive((task, req) => service.fork(task, req.params.cid, req.body || {})));
  router.post('/conversations/:cid/limits/refresh', handle((task, req) => service.refreshUsage(task, req.params.cid)));
  router.get('/conversations/:cid/commands', handle((task, req) => service.listCommands(task, req.params.cid)));
  router.get('/conversations/:cid/models', handle((task, req) => service.listModels(task, req.params.cid)));
  router.delete('/conversations/:cid', handle((task, req) => service.remove(task, req.params.cid)));
  router.post('/conversations/:cid/messages', whileActive((task, req) => service.sendMessage(task, req.params.cid, req.body || {})));
  router.post('/conversations/:cid/interrupt', handle((task, req) => service.interrupt(task, req.params.cid)));
  // { viewer, foreground }: the page that follows the events with ?viewer=<id> shows the chat (or not); see reportPresence in services/agent-chat.js.
  router.post('/conversations/:cid/presence', handle((task, req) => service.reportPresence(task, req.params.cid, req.body || {})));
  router.post('/conversations/:cid/permissions/:rid', handle((task, req) => service.answerPermission(task, req.params.cid, req.params.rid, req.body || {})));

  // Server-sent events: every change of the conversation after `after`. A client whose `after` is older than the kept events gets `reset` and reloads.
  router.get('/conversations/:cid/events', (req, res) => {
    const task = taskOf(req);
    if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
    const after = Number.parseInt(req.query.after, 10) || 0;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    let unsubscribe;
    try {
      unsubscribe = service.subscribe(task, req.params.cid, after, event => res.write(`data: ${JSON.stringify(event)}\n\n`), { viewer: typeof req.query.viewer === 'string' ? req.query.viewer : undefined });
    } catch (error) {
      res.write(`event: gone\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
      return res.end();
    }
    if (!unsubscribe) { res.write('event: reset\ndata: {}\n\n'); return res.end(); }
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  });

  router.service = service;
  return router;
}

// /api/agent-chat/summary: what the agents of the signed-in person are doing, over all their tasks. The current pages do not read it; a tab still open from
// before the counters left the top bar does (it would otherwise keep showing old numbers until it is reloaded).
function createAgentChatSummaryRouter({ service = getAgentChat(), authenticate = requireAuth, ownerOf = req => req.session.user.login } = {}) {
  const router = express.Router();
  router.use(authenticate);
  router.get('/summary', (req, res) => res.set('Cache-Control', 'no-store').json(service.summary(ownerOf(req))));
  return router;
}

module.exports = { createAgentChatRouter, createAgentChatSummaryRouter };
