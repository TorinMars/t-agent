// Chat-style Claude / Codex conversations of a task: /api/tasks/:id/agent/...
const express = require('express');
const db = require('../db');
const requireAuth = require('../middleware/auth');
const { getAgentChat } = require('../services/agent-chat');
const { listSessions } = require('../lib/agent-sessions');

function createAgentChatRouter({ service = getAgentChat(), authenticate = requireAuth, ownerOf = req => req.session.user.login } = {}) {
  const router = express.Router({ mergeParams: true });
  router.use(authenticate);

  const taskOf = req => db.prepare('SELECT id, work_dir FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, ownerOf(req));
  const handle = run => async (req, res) => {
    const task = taskOf(req);
    if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
    try { res.json(await run(task, req, res)); }
    catch (error) { res.status(error.statusCode || 400).json({ error: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'AGENT_CHAT_FAILED' }); }
  };

  router.get('/conversations', handle(task => service.list(task.id)));
  router.post('/conversations', handle((task, req) => service.create(task, req.body || {})));
  router.get('/sessions', handle((task, req) => listSessions(req.query.agent, task.work_dir)));
  router.get('/conversations/:cid', handle((task, req) => service.snapshot(task, req.params.cid)));
  router.patch('/conversations/:cid', handle((task, req) => {
    const body = req.body || {};
    let result = { success: true };
    if (body.title !== undefined) service.rename(task, req.params.cid, body.title);
    if (body.mode !== undefined) result = service.setMode(task, req.params.cid, body.mode);
    if (body.model !== undefined || body.effort !== undefined) result = service.setPreferences(task, req.params.cid, { model: body.model, effort: body.effort });
    return result;
  }));
  router.get('/conversations/:cid/models', handle((task, req) => service.listModels(task, req.params.cid)));
  router.delete('/conversations/:cid', handle((task, req) => service.remove(task, req.params.cid)));
  router.post('/conversations/:cid/messages', handle((task, req) => service.sendMessage(task, req.params.cid, req.body || {})));
  router.post('/conversations/:cid/interrupt', handle((task, req) => service.interrupt(task, req.params.cid)));
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
      unsubscribe = service.subscribe(task, req.params.cid, after, event => res.write(`data: ${JSON.stringify(event)}\n\n`));
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

module.exports = { createAgentChatRouter };
