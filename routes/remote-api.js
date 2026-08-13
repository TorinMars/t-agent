const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const requireRemoteAuth = require('../middleware/remote-auth');
const updates = require('../services/update-manager');

const router = express.Router();
router.use(requireRemoteAuth('tasks:read'));

function ownedTask(req) {
  return db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, req.remoteAuth.userId);
}

function documentPath(task, kind) {
  if (kind === 'technical') return task.md_path || null;
  const root = task.work_dir || (task.md_path ? path.dirname(task.md_path) : null);
  if (!root) return null;
  if (kind === 'readme') return path.join(root, 'README.md');
  if (kind === 'agent') return path.join(root, 'AGENT.md');
  return null;
}

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
  const tasks = db.prepare(`
    SELECT id, title, status, priority, due_date, sort_order, created_at, updated_at,
           CASE WHEN md_path IS NULL THEN 0 ELSE 1 END AS has_technical,
           CASE WHEN work_dir IS NULL AND md_path IS NULL THEN 0 ELSE 1 END AS has_document_root
    FROM tasks WHERE user_id = ? ORDER BY sort_order ASC, created_at DESC
  `).all(req.remoteAuth.userId);
  res.json(tasks);
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
  const todos = db.prepare(`SELECT id, content, completed, sort_order, created_at, updated_at
    FROM task_todos WHERE task_id = ? ORDER BY completed ASC, sort_order ASC, created_at ASC`).all(task.id);
  res.json(todos.map(todo => ({ ...todo, completed: Boolean(todo.completed) })));
});

module.exports = router;
