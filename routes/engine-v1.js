const express = require('express');
const db = require('../db');
const config = require('../config');
const requireEngineAuth = require('../middleware/engine-auth');
const tasks = require('../services/engine-tasks');
const { exchangePairingCode, createAccessToken } = require('../services/engine-auth');
const { getEngineIdentity } = require('../services/engine-identity');
const { createTerminalTicket } = require('../services/terminal-tickets');

const router = express.Router();
const pairingAttempts = new Map();

function errorResponse(res, error) {
  const code = /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'ENGINE_REQUEST_FAILED';
  res.status(error.statusCode || 400).json({ error: code });
}

function principal(req) {
  return req.engineAuth.principalId;
}

function rateLimitPairing(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (pairingAttempts.get(key) || []).filter(time => now - time < 60_000);
  if (recent.length >= 10) return res.status(429).json({ error: 'PAIRING_RATE_LIMITED' });
  recent.push(now);
  pairingAttempts.set(key, recent);
  next();
}

router.get('/health', (req, res) => {
  res.json({ ok: true });
});

router.post('/pair', rateLimitPairing, (req, res) => {
  try {
    const created = exchangePairingCode(db, req.body.code, {
      clientName: req.body.client_name || '客户端',
    });
    res.status(201).json({
      access_token: created.token,
      token_type: 'Bearer',
      role: created.role,
      scopes: created.scopes.split(','),
      ...getEngineIdentity(),
    });
  } catch (error) { errorResponse(res, error); }
});

function infoHandler(req, res) {
  let version = {};
  try { version = require('../services/update-manager').readLocalManifest(); } catch {}
  res.json({
    ...getEngineIdentity(),
    engine_version: version.app_version || require('../package.json').version,
    api_version: 1,
    role: req.engineAuth.role,
    capabilities: [
      'tasks:read', 'tasks:write',
      'documents:read', 'documents:write',
      'todos:read', 'todos:write',
      'terminal:interactive', 'token:pairing',
    ],
  });
}

router.get('/info', requireEngineAuth(), infoHandler);
router.get('/capabilities', requireEngineAuth(), infoHandler);

router.get('/tasks', requireEngineAuth('tasks:read'), (req, res) => {
  try { res.json(tasks.listTasks(principal(req), req.query.status)); }
  catch (error) { errorResponse(res, error); }
});

router.post('/tasks', requireEngineAuth('tasks:write'), (req, res) => {
  try { res.status(201).json(tasks.createTask(principal(req), req.body)); }
  catch (error) { errorResponse(res, error); }
});

router.patch('/tasks/:id', requireEngineAuth('tasks:write'), (req, res) => {
  try { res.json(tasks.updateTask(principal(req), req.params.id, req.body)); }
  catch (error) { errorResponse(res, error); }
});

router.put('/tasks/:id', requireEngineAuth('tasks:write'), (req, res) => {
  try { res.json(tasks.updateTask(principal(req), req.params.id, req.body)); }
  catch (error) { errorResponse(res, error); }
});

router.delete('/tasks/:id', requireEngineAuth('tasks:write'), (req, res) => {
  try { tasks.deleteTask(principal(req), req.params.id); res.json({ success: true }); }
  catch (error) { errorResponse(res, error); }
});

router.get('/tasks/:id/documents/:kind', requireEngineAuth('documents:read'), (req, res) => {
  try { res.type('text/plain').send(tasks.readDocument(principal(req), req.params.id, req.params.kind)); }
  catch (error) { errorResponse(res, error); }
});

// 兼容现有客户端的 document 单数路径。
router.get('/tasks/:id/document/:kind', requireEngineAuth('documents:read'), (req, res) => {
  try { res.type('text/plain').send(tasks.readDocument(principal(req), req.params.id, req.params.kind)); }
  catch (error) { errorResponse(res, error); }
});

router.put('/tasks/:id/documents/:kind', requireEngineAuth('documents:write'), (req, res) => {
  try { tasks.writeDocument(principal(req), req.params.id, req.params.kind, req.body.content); res.json({ success: true }); }
  catch (error) { errorResponse(res, error); }
});

router.put('/tasks/:id/document/:kind', requireEngineAuth('documents:write'), (req, res) => {
  try { tasks.writeDocument(principal(req), req.params.id, req.params.kind, req.body.content); res.json({ success: true }); }
  catch (error) { errorResponse(res, error); }
});

router.get('/tasks/:id/todos', requireEngineAuth('todos:read'), (req, res) => {
  try { res.json(tasks.listTodos(principal(req), req.params.id)); }
  catch (error) { errorResponse(res, error); }
});

router.post('/tasks/:id/todos', requireEngineAuth('todos:write'), (req, res) => {
  try { res.status(201).json(tasks.createTodo(principal(req), req.params.id, req.body)); }
  catch (error) { errorResponse(res, error); }
});

router.patch('/tasks/:id/todos/:todoId', requireEngineAuth('todos:write'), (req, res) => {
  try { res.json(tasks.updateTodo(principal(req), req.params.id, req.params.todoId, req.body)); }
  catch (error) { errorResponse(res, error); }
});

router.put('/tasks/:id/todos/:todoId', requireEngineAuth('todos:write'), (req, res) => {
  try { res.json(tasks.updateTodo(principal(req), req.params.id, req.params.todoId, req.body)); }
  catch (error) { errorResponse(res, error); }
});

router.delete('/tasks/:id/todos/:todoId', requireEngineAuth('todos:write'), (req, res) => {
  try { tasks.deleteTodo(principal(req), req.params.id, req.params.todoId); res.json({ success: true }); }
  catch (error) { errorResponse(res, error); }
});

router.post('/terminal-sessions', requireEngineAuth('terminal:execute'), (req, res) => {
  const task = tasks.ownedTask(principal(req), req.body.task_id);
  if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
  const created = createTerminalTicket({ principalId: principal(req), taskId: task.id });
  res.status(201).json({
    session_id: String(task.id),
    ...created,
    websocket_path: `/v1/terminal-sessions/${task.id}/stream?ticket=${encodeURIComponent(created.ticket)}`,
  });
});

router.get('/tokens', requireEngineAuth('engine:admin'), (req, res) => {
  const rows = db.prepare(`SELECT id, name, token_prefix, role, scopes, last_used_at, created_at
    FROM engine_access_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC`).all();
  res.json(rows);
});

router.post('/tokens', requireEngineAuth('engine:admin'), (req, res) => {
  const created = createAccessToken(db, {
    name: req.body.name,
    role: req.body.role,
    principalId: config.engineOwnerId,
  });
  res.status(201).json(created);
});

router.delete('/tokens/:id', requireEngineAuth('engine:admin'), (req, res) => {
  if (Number(req.params.id) === Number(req.engineAuth.tokenId)) {
    return res.status(400).json({ error: 'CANNOT_REVOKE_CURRENT_TOKEN' });
  }
  const result = db.prepare(`UPDATE engine_access_tokens SET revoked_at = CURRENT_TIMESTAMP
    WHERE id = ? AND revoked_at IS NULL`).run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'TOKEN_NOT_FOUND' });
  res.json({ success: true });
});

module.exports = router;
