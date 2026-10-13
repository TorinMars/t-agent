const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { randomUUID } = require('crypto');
const db = require('../db');
const requireAuth = require('../middleware/auth');
const { serveFileWatch } = require('../lib/file-watch-sse');
const { resolveAsset, validateMdPath } = require('../services/task-assets');
const terminal = require('./terminal');
const documents = require('../services/task-documents');
const { createTaskFilesRouter } = require('./task-files');
const taskStore = require('../services/task-store');
const engineTasks = require('../services/engine-tasks');

const router = express.Router();

router.use(requireAuth);

const ownerFilter = (req) => req.session.user.login;
const storeOf = (req) => taskStore.forOwner(db, ownerFilter(req));
const taskOf = (req) => engineTasks.ownedTask(ownerFilter(req), req.params.id);

router.use('/:id/files', createTaskFilesRouter({
  getTask: req => taskOf(req),
}));

router.get('/', (req, res) => {
  const uid = ownerFilter(req);
  const tasks = storeOf(req).listTasks(req.query.status || undefined).map(task => ({ ...task, user_id: uid }));
  res.json(tasks.map(documents.resolveTask));
});

// 将任务标题转换为合法的目录/文件名
function titleToSlug(title) {
  return title
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9一-鿿\-_\.]/g, '')
    .replace(/^-+|-+$/g, '') || 'task';
}

// 自动为任务创建目录和 md 文件（仅当未指定 md_path 时调用）
// 优先用用户自己的 work_dir，其次读环境变量 TASKS_BASE_DIR，最后回退 ~/tasks
const os = require('os');
const DEFAULT_BASE = process.env.TASKS_BASE_DIR || path.join(os.homedir(), 'tasks');

router.post('/', (req, res) => {
  const uid = ownerFilter(req);
  let { title, md_path, work_dir, status, priority, due_date, sort_order } = req.body;
  let overrides;
  try { overrides = documents.pathOverrides(req.body); }
  catch (error) { return res.status(400).json({ error: error.message }); }

  if (md_path) {
    if (!md_path.startsWith('/') && !(/^[A-Za-z]:\\/.test(md_path))) {
      return res.status(400).json({ error: 'md_path must be an absolute path' });
    }
    if (!md_path.endsWith('.md')) {
      return res.status(400).json({ error: 'md_path must end with .md' });
    }
    if (!title) title = path.basename(md_path, '.md');
    if (!work_dir) work_dir = path.dirname(md_path);
  }

  if (!title) return res.status(400).json({ error: 'title is required' });

  if (work_dir && !path.isAbsolute(work_dir)) return res.status(400).json({ error: 'work_dir must be an absolute path' });
  if (!work_dir) work_dir = path.join(storeOf(req).root, titleToSlug(title));
  if (!md_path) md_path = path.join(work_dir, 'DESIGN.md');
  md_path = documents.documentPath({ work_dir, md_path }, 'technical');
  try {
    documents.ensureDocuments({ title, work_dir, md_path, ...overrides });
  } catch (err) {
    return res.status(500).json({ error: `Failed to create task documents: ${err.message}` });
  }

  const created = storeOf(req).createTask({
    ...overrides, title, status: status || 'todo', priority: priority || 'normal', due_date: due_date || null,
    md_path: md_path || null, work_dir, sort_order: sort_order || 0,
  });
  res.status(201).json({ ...created, user_id: uid });
});

router.put('/reorder', (req, res) => {
  const uid = ownerFilter(req);
  const items = req.body; // [{ id, sort_order }]
  if (!Array.isArray(items)) return res.status(400).json({ error: 'body must be array' });
  storeOf(req).reorder(items);
  res.json({ success: true });
});

router.put('/:id', (req, res) => {
  const uid = ownerFilter(req);
  const { id } = req.params;
  const task = taskOf(req);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  let { title, status, priority, due_date, md_path, work_dir, sort_order } = req.body;
  let overrides;
  try { overrides = documents.pathOverrides(req.body, task); }
  catch (error) { return res.status(400).json({ error: error.message }); }

  if (md_path !== undefined && md_path !== null) {
    if (!md_path.startsWith('/') && !(/^[A-Za-z]:\\/.test(md_path))) {
      return res.status(400).json({ error: 'md_path must be an absolute path' });
    }
    if (!md_path.endsWith('.md')) return res.status(400).json({ error: 'md_path must end with .md' });
    // 更新了 md_path 但未传 work_dir，自动推导
    if (work_dir === undefined) work_dir = path.dirname(md_path);
  }

  if (work_dir && !path.isAbsolute(work_dir)) return res.status(400).json({ error: 'work_dir must be an absolute path' });
  if (work_dir !== undefined || md_path !== undefined || ['technical_path', 'readme_path', 'agent_path'].some(key => req.body[key] !== undefined)) {
    const root = work_dir || task.work_dir || (md_path && path.dirname(md_path));
    md_path = documents.updatedTechnicalPath(task, root, md_path === undefined ? task.md_path : md_path);
    work_dir = root;
    try { documents.ensureDocuments({ title: title || task.title, work_dir, md_path, ...overrides }); }
    catch (err) { return res.status(500).json({ error: `Failed to create task documents: ${err.message}` }); }
  }

  const updated = storeOf(req).updateTask(task.id, {
    ...overrides,
    ...(title !== undefined ? { title } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(due_date !== undefined ? { due_date } : {}),
    ...(md_path !== undefined ? { md_path } : {}),
    ...(work_dir !== undefined ? { work_dir } : {}),
    ...(sort_order !== undefined ? { sort_order } : {}),
  });
  res.json({ ...updated, user_id: uid });
});

router.get('/terminal-activity', (req, res) => {
  const ids = storeOf(req).listTasks().map(row => row.id);
  res.json(terminal.activitySnapshot(ids));
});

router.post('/:id/terminal/ack', (req, res) => {
  const task = taskOf(req);
  if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
  try {
    res.json(terminal.acknowledgeActivity(task.id, req.body && req.body.terminal_id));
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message || 'TERMINAL_ACK_FAILED' });
  }
});

router.get('/:id/terminals', (req, res) => {
  const task = taskOf(req);
  if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
  res.status(200).json(terminal.listTerminals(task.id));
});

router.post('/:id/terminals', (req, res) => {
  const task = taskOf(req);
  if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
  res.status(201).json(terminal.createTerminal(task.id));
});

router.post('/:id/terminal/control', (req, res) => {
  const uid = ownerFilter(req);
  const task = taskOf(req);
  if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
  try {
    res.json(terminal.controlSession(task.id, req.body && req.body.action, req.body && req.body.terminal_id));
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message || 'TERMINAL_CONTROL_FAILED' });
  }
});

router.delete('/:id', (req, res) => {
  const uid = ownerFilter(req);
  const task = documents.resolveTask(taskOf(req));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  terminal.closeTaskTerminals(task.id);
  storeOf(req).removeTask(task.id);
  res.json({ success: true });
});

router.get('/:id/md', (req, res) => {
  const uid = ownerFilter(req);
  const task = documents.resolveTask(taskOf(req));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  task.md_path = getTaskDocumentPath(task, 'technical');
  if (!task.md_path || !task.md_path.endsWith('.md')) return res.status(404).json({ error: 'No md_path' });
  try {
    documents.ensureDocument(task, 'technical');
    res.type('text/plain').send(fs.readFileSync(task.md_path, 'utf8'));
  } catch (err) {
    res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: 'Failed to read file' });
  }
});

const getTaskDocumentPath = documents.documentPath;

router.get('/:id/document/:kind', (req, res) => {
  const uid = ownerFilter(req);
  const task = documents.resolveTask(taskOf(req));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const filePath = getTaskDocumentPath(task, req.params.kind);
  if (!filePath) return res.status(404).json({ error: 'Document path is not configured' });
  try {
    documents.ensureDocument(task, req.params.kind);
    res.type('text/plain').send(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: err.code === 'ENOENT' ? 'Document not found' : 'Failed to read document' });
  }
});

router.put('/:id/document/:kind', (req, res) => {
  const uid = ownerFilter(req);
  const task = documents.resolveTask(taskOf(req));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!['technical', 'readme', 'agent'].includes(req.params.kind)) {
    return res.status(400).json({ error: 'Invalid document kind' });
  }
  const filePath = getTaskDocumentPath(task, req.params.kind);
  if (!filePath) return res.status(400).json({ error: 'Document path is not configured' });
  const content = req.body.content;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content must be a string' });
  if (Buffer.byteLength(content, 'utf8') > 5 * 1024 * 1024) {
    return res.status(413).json({ error: 'Document is too large (maximum 5MB)' });
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save document' });
  }
});

router.post('/:id/document/:kind', (req, res) => {
  const uid = ownerFilter(req);
  const task = documents.resolveTask(taskOf(req));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!['readme', 'agent'].includes(req.params.kind)) {
    return res.status(400).json({ error: 'Only README.md and AGENTS.md can be created here' });
  }
  const filePath = getTaskDocumentPath(task, req.params.kind);
  if (!filePath) return res.status(400).json({ error: 'Task work directory is not configured' });
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    documents.ensureDocument(task, req.params.kind);
    res.status(201).json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create document' });
  }
});

router.get('/:id/todos', (req, res) => {
  const todos = storeOf(req).listTodos(req.params.id);
  if (!todos) return res.status(404).json({ error: 'Task not found' });
  res.json(todos);
});

router.post('/:id/todos', (req, res) => {
  if (!taskOf(req)) return res.status(404).json({ error: 'Task not found' });
  const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
  if (!content) return res.status(400).json({ error: 'content is required' });
  res.status(201).json(storeOf(req).createTodo(req.params.id, content));
});

router.put('/:id/todos/:todoId', (req, res) => {
  const store = storeOf(req);
  const todo = (store.listTodos(req.params.id) || []).find(item => item.id === Number(req.params.todoId));
  if (!todo) return res.status(404).json({ error: 'Todo not found' });
  const contentSet = req.body.content !== undefined;
  const content = contentSet && typeof req.body.content === 'string' ? req.body.content.trim() : null;
  if (contentSet && !content) return res.status(400).json({ error: 'content is required' });
  res.json(store.updateTodo(req.params.id, todo.id, {
    ...(contentSet ? { content } : {}),
    ...(req.body.completed !== undefined ? { completed: Boolean(req.body.completed) } : {}),
  }));
});

router.delete('/:id/todos/:todoId', (req, res) => {
  if (!storeOf(req).deleteTodo(req.params.id, req.params.todoId)) return res.status(404).json({ error: 'Todo not found' });
  res.json({ success: true });
});

router.get('/:id/file', (req, res) => {
  const uid = ownerFilter(req);
  const task = documents.resolveTask(taskOf(req));
  if (!task || !task.md_path) return res.status(404).json({ error: 'No md_path' });
  const asset = resolveAsset(task, req.query.path);
  if (asset.error) return res.status(asset.status).json({ error: asset.error });
  res.sendFile(asset.file);
});

router.post('/:id/share', (req, res) => {
  const uid = ownerFilter(req);
  const task = documents.resolveTask(taskOf(req));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!task.md_path) return res.status(400).json({ error: 'Task has no md file' });

  let token = task.share_token;
  if (!token) {
    token = randomUUID();
    storeOf(req).setShareToken(task.id, token);
  }
  res.json({ token, url: `/share/${token}` });
});

router.post('/:id/reveal', (req, res) => {
  const uid = ownerFilter(req);
  const task = documents.resolveTask(taskOf(req));
  if (!task || !task.md_path) return res.status(404).json({ error: 'No md_path' });
  exec(`open -R "${task.md_path}"`, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

router.post('/:id/vscode', (req, res) => {
  const uid = ownerFilter(req);
  const task = documents.resolveTask(taskOf(req));
  if (!task || !task.md_path) return res.status(404).json({ error: 'No md_path' });
  // 硬编码常见安装路径，兼容 LaunchAgent 精简 PATH 环境
  const codeBin = [
    '/opt/homebrew/bin/code',
    '/usr/local/bin/code',
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
  ].find(p => fs.existsSync(p)) || 'code';
  const openTarget = task.work_dir || path.dirname(task.md_path);
  exec(`"${codeBin}" "${openTarget}"`, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

router.get('/:id/md/watch', (req, res) => {
  const uid = ownerFilter(req);
  const task = documents.resolveTask(taskOf(req));
  if (!task || !task.md_path || !task.md_path.endsWith('.md')) return res.status(404).end();

  serveFileWatch(req, res, task.md_path);
});

router.get('/:id/document/:kind/watch', (req, res) => {
  const uid = ownerFilter(req);
  const task = documents.resolveTask(taskOf(req));
  if (!task) return res.status(404).end();
  const filePath = getTaskDocumentPath(task, req.params.kind);
  if (!filePath) return res.status(404).end();

  serveFileWatch(req, res, filePath);
});

router.post('/validate-path', (req, res) => {
  const result = validateMdPath(req.body.md_path);
  if (result.status) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

module.exports = router;
