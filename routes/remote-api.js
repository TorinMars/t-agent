const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const requireRemoteAuth = require('../middleware/remote-auth');
const updates = require('../services/update-manager');

const router = express.Router();
router.use(requireRemoteAuth('tasks:read'));

const taskStore = require('../services/task-store');
const storeOf = req => taskStore.forOwner(db, req.remoteAuth.userId);
function ownedTask(req) {
  return storeOf(req).getTask(req.params.id);
}

const { documentPath } = require('../services/task-documents');

router.get('/capabilities', (req, res) => {
  let version = {};
  try { version = updates.readLocalManifest(); } catch {}
  res.json({
    instance_id: process.env.INSTANCE_ID || require('os').hostname(),
    app_version: version.app_version || null,
    api_version: 1,
    capabilities: ['tasks:read', 'documents:read', 'todos:read'],
  });
});

router.get('/tasks', (req, res) => {
  res.json(storeOf(req).listTasks().map(task => ({
    id: task.id, title: task.title, status: task.status, priority: task.priority, due_date: task.due_date,
    sort_order: task.sort_order, created_at: task.created_at, updated_at: task.updated_at,
    has_technical: 1, has_document_root: 1,
  })));
});

router.get('/tasks/:id/document/:kind', (req, res) => {
  const task = ownedTask(req);
  if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
  const file = documentPath(task, req.params.kind);
  if (!file) return res.status(404).json({ error: 'DOCUMENT_NOT_FOUND' });
  try { res.type('text/plain').send(fs.readFileSync(file, 'utf8')); }
  catch { res.status(404).json({ error: 'DOCUMENT_NOT_FOUND' }); }
});

router.get('/tasks/:id/todos', (req, res) => {
  const task = ownedTask(req);
  if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
  res.json(storeOf(req).listTodos(task.id).map(({ task_id, ...todo }) => todo));
});

module.exports = router;
