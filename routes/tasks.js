const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { randomUUID } = require('crypto');
const db = require('../db');
const requireAuth = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

const ownerFilter = (req) => req.session.user.login;

router.get('/', (req, res) => {
  const uid = ownerFilter(req);
  const { status } = req.query;
  let tasks;
  if (status) {
    tasks = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND status = ? ORDER BY sort_order ASC, created_at DESC').all(uid, status);
  } else {
    tasks = db.prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY sort_order ASC, created_at DESC').all(uid);
  }
  res.json(tasks);
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

function autoCreateTaskFiles(title, userWorkDir) {
  const slug = titleToSlug(title);
  const base = userWorkDir || DEFAULT_BASE;
  const dir = path.join(base, slug);
  const mdFile = path.join(dir, 'DESIGN.md');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(mdFile)) {
    fs.writeFileSync(mdFile, `# ${title}\n`, 'utf8');
  }
  ensureTaskCompanionDocuments(title, dir);
  return { work_dir: dir, md_path: mdFile };
}

// 在当前任务目录补齐固定文档；已有文件保持原样，不做覆盖。
function ensureTaskCompanionDocuments(title, taskDir) {
  fs.mkdirSync(taskDir, { recursive: true });
  const readmeFile = path.join(taskDir, 'README.md');
  const agentFile = path.join(taskDir, 'AGENT.md');
  if (!fs.existsSync(readmeFile)) {
    fs.writeFileSync(readmeFile, `# ${title}\n\n## 项目说明\n\n`, 'utf8');
  }
  if (!fs.existsSync(agentFile)) {
    fs.writeFileSync(agentFile, '# AGENT.md\n\n## 工作约定\n\n', 'utf8');
  }
}

router.post('/', (req, res) => {
  const uid = ownerFilter(req);
  let { title, md_path, work_dir, status, priority, due_date, sort_order } = req.body;

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

  // 只填了标题、未指定 md_path 时，自动创建目录和 md 文件
  if (!md_path) {
    try {
      const created = autoCreateTaskFiles(title, req.session.user.work_dir || null);
      md_path = created.md_path;
      if (!work_dir) work_dir = created.work_dir;
    } catch (err) {
      console.error('[tasks] autoCreateTaskFiles error:', err.message);
    }
  } else {
    // 手动指定技术方案时，也在当前 Task 目录自动补齐 README 与 AGENT.md。
    try {
      ensureTaskCompanionDocuments(title, work_dir || path.dirname(md_path));
      if (!fs.existsSync(md_path)) {
        fs.mkdirSync(path.dirname(md_path), { recursive: true });
        fs.writeFileSync(md_path, `# ${title}\n`, 'utf8');
      }
    } catch (err) {
      return res.status(500).json({ error: `Failed to create task documents: ${err.message}` });
    }
  }

  const info = db.prepare(`
    INSERT INTO tasks (title, status, priority, due_date, md_path, work_dir, sort_order, user_id)
    VALUES (@title, @status, @priority, @due_date, @md_path, @work_dir, @sort_order, @user_id)
  `).run({ title, status: status || 'todo', priority: priority || 'normal', due_date: due_date || null, md_path: md_path || null, work_dir: work_dir || null, sort_order: sort_order || 0, user_id: uid });

  res.status(201).json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/reorder', (req, res) => {
  const uid = ownerFilter(req);
  const items = req.body; // [{ id, sort_order }]
  if (!Array.isArray(items)) return res.status(400).json({ error: 'body must be array' });
  const stmt = db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ? AND user_id = ?');
  const update = db.transaction(() => items.forEach(({ id, sort_order }) => stmt.run(sort_order, id, uid)));
  update();
  res.json({ success: true });
});

router.put('/:id', (req, res) => {
  const uid = ownerFilter(req);
  const { id } = req.params;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, uid);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  let { title, status, priority, due_date, md_path, work_dir, sort_order } = req.body;

  if (md_path !== undefined && md_path !== null) {
    if (!md_path.startsWith('/') && !(/^[A-Za-z]:\\/.test(md_path))) {
      return res.status(400).json({ error: 'md_path must be an absolute path' });
    }
    if (!md_path.endsWith('.md')) return res.status(400).json({ error: 'md_path must end with .md' });
    // 更新了 md_path 但未传 work_dir，自动推导
    if (work_dir === undefined) work_dir = path.dirname(md_path);
  }

  db.prepare(`
    UPDATE tasks SET
      title      = COALESCE(@title, title),
      status     = COALESCE(@status, status),
      priority   = COALESCE(@priority, priority),
      due_date   = CASE WHEN @due_date_set = 1 THEN @due_date ELSE due_date END,
      md_path    = CASE WHEN @md_path_set = 1 THEN @md_path ELSE md_path END,
      work_dir   = CASE WHEN @work_dir_set = 1 THEN @work_dir ELSE work_dir END,
      sort_order = COALESCE(@sort_order, sort_order),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @id AND user_id = @user_id
  `).run({
    id, user_id: uid,
    title: title !== undefined ? title : null,
    status: status !== undefined ? status : null,
    priority: priority !== undefined ? priority : null,
    due_date: due_date !== undefined ? due_date : null,
    due_date_set: due_date !== undefined ? 1 : 0,
    md_path: md_path !== undefined ? md_path : null,
    md_path_set: md_path !== undefined ? 1 : 0,
    work_dir: work_dir !== undefined ? work_dir : null,
    work_dir_set: work_dir !== undefined ? 1 : 0,
    sort_order: sort_order !== undefined ? sort_order : null,
  });

  res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
});

router.delete('/:id', (req, res) => {
  const uid = ownerFilter(req);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.get('/:id/md', (req, res) => {
  const uid = ownerFilter(req);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!task.md_path || !task.md_path.endsWith('.md')) return res.status(404).json({ error: 'No md_path' });
  try {
    res.type('text/plain').send(fs.readFileSync(task.md_path, 'utf8'));
  } catch (err) {
    res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: 'Failed to read file' });
  }
});

function getTaskDocumentPath(task, kind) {
  if (kind === 'technical') return task.md_path || null;
  const rootDir = task.work_dir || (task.md_path ? path.dirname(task.md_path) : null);
  if (!rootDir) return null;
  if (kind === 'readme') return path.join(rootDir, 'README.md');
  if (kind === 'agent') return path.join(rootDir, 'AGENT.md');
  return null;
}

router.get('/:id/document/:kind', (req, res) => {
  const uid = ownerFilter(req);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const filePath = getTaskDocumentPath(task, req.params.kind);
  if (!filePath) return res.status(404).json({ error: 'Document path is not configured' });
  try {
    res.type('text/plain').send(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: err.code === 'ENOENT' ? 'Document not found' : 'Failed to read document' });
  }
});

router.put('/:id/document/:kind', (req, res) => {
  const uid = ownerFilter(req);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, uid);
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
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!['readme', 'agent'].includes(req.params.kind)) {
    return res.status(400).json({ error: 'Only README.md and AGENT.md can be created here' });
  }
  const filePath = getTaskDocumentPath(task, req.params.kind);
  if (!filePath) return res.status(400).json({ error: 'Task work directory is not configured' });
  const title = req.params.kind === 'readme' ? task.title : 'AGENT.md';
  const section = req.params.kind === 'readme' ? '项目说明' : '工作约定';
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, `# ${title}\n\n## ${section}\n\n`, 'utf8');
    res.status(201).json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create document' });
  }
});

router.get('/:id/todos', (req, res) => {
  const uid = ownerFilter(req);
  const task = db.prepare('SELECT id FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const todos = db.prepare(`
    SELECT * FROM task_todos WHERE task_id = ?
    ORDER BY completed ASC, sort_order ASC, created_at ASC
  `).all(task.id);
  res.json(todos.map(todo => ({ ...todo, completed: Boolean(todo.completed) })));
});

router.post('/:id/todos', (req, res) => {
  const uid = ownerFilter(req);
  const task = db.prepare('SELECT id FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
  if (!content) return res.status(400).json({ error: 'content is required' });
  const nextOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM task_todos WHERE task_id = ?').get(task.id).value;
  const info = db.prepare('INSERT INTO task_todos (task_id, content, sort_order) VALUES (?, ?, ?)').run(task.id, content, nextOrder);
  const todo = db.prepare('SELECT * FROM task_todos WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ ...todo, completed: Boolean(todo.completed) });
});

router.put('/:id/todos/:todoId', (req, res) => {
  const uid = ownerFilter(req);
  const todo = db.prepare(`
    SELECT td.* FROM task_todos td
    JOIN tasks t ON t.id = td.task_id
    WHERE td.id = ? AND td.task_id = ? AND t.user_id = ?
  `).get(req.params.todoId, req.params.id, uid);
  if (!todo) return res.status(404).json({ error: 'Todo not found' });
  const contentSet = req.body.content !== undefined;
  const content = contentSet && typeof req.body.content === 'string' ? req.body.content.trim() : null;
  if (contentSet && !content) return res.status(400).json({ error: 'content is required' });
  const completedSet = req.body.completed !== undefined;
  db.prepare(`
    UPDATE task_todos SET
      content = CASE WHEN @content_set = 1 THEN @content ELSE content END,
      completed = CASE WHEN @completed_set = 1 THEN @completed ELSE completed END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({
    id: todo.id,
    content_set: contentSet ? 1 : 0,
    content,
    completed_set: completedSet ? 1 : 0,
    completed: req.body.completed ? 1 : 0,
  });
  const updated = db.prepare('SELECT * FROM task_todos WHERE id = ?').get(todo.id);
  res.json({ ...updated, completed: Boolean(updated.completed) });
});

router.delete('/:id/todos/:todoId', (req, res) => {
  const uid = ownerFilter(req);
  const todo = db.prepare(`
    SELECT td.id FROM task_todos td
    JOIN tasks t ON t.id = td.task_id
    WHERE td.id = ? AND td.task_id = ? AND t.user_id = ?
  `).get(req.params.todoId, req.params.id, uid);
  if (!todo) return res.status(404).json({ error: 'Todo not found' });
  db.prepare('DELETE FROM task_todos WHERE id = ?').run(todo.id);
  res.json({ success: true });
});

router.get('/:id/file', (req, res) => {
  const uid = ownerFilter(req);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!task || !task.md_path) return res.status(404).json({ error: 'No md_path' });
  const rel = req.query.path;
  if (!rel || rel.includes('..')) return res.status(400).json({ error: 'Invalid path' });
  const filePath = path.join(path.dirname(task.md_path), rel);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(filePath);
});

router.post('/:id/share', (req, res) => {
  const uid = ownerFilter(req);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!task.md_path) return res.status(400).json({ error: 'Task has no md file' });

  let token = task.share_token;
  if (!token) {
    token = randomUUID();
    db.prepare('UPDATE tasks SET share_token = ? WHERE id = ?').run(token, task.id);
  }
  res.json({ token, url: `/share/${token}` });
});

router.post('/:id/reveal', (req, res) => {
  const uid = ownerFilter(req);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!task || !task.md_path) return res.status(404).json({ error: 'No md_path' });
  exec(`open -R "${task.md_path}"`, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

router.post('/:id/vscode', (req, res) => {
  const uid = ownerFilter(req);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, uid);
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
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!task || !task.md_path || !task.md_path.endsWith('.md')) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let watcher;
  try {
    watcher = fs.watch(task.md_path, { persistent: false }, (event) => {
      if (event === 'change') res.write('data: changed\n\n');
    });
  } catch (e) {
    res.write('data: error\n\n');
    return res.end();
  }

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(heartbeat); watcher.close(); });
});

router.get('/:id/document/:kind/watch', (req, res) => {
  const uid = ownerFilter(req);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!task) return res.status(404).end();
  const filePath = getTaskDocumentPath(task, req.params.kind);
  if (!filePath) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let watcher;
  try {
    watcher = fs.watch(filePath, { persistent: false }, event => {
      if (event === 'change') res.write('data: changed\n\n');
    });
  } catch (e) {
    res.write('data: error\n\n');
    return res.end();
  }
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(heartbeat); watcher.close(); });
});

router.post('/validate-path', (req, res) => {
  const { md_path } = req.body;
  if (!md_path) return res.status(400).json({ error: 'md_path is required' });
  if (!md_path.startsWith('/') && !(/^[A-Za-z]:\\/.test(md_path))) return res.json({ valid: false, error: 'Must be an absolute path' });
  if (!md_path.endsWith('.md')) return res.json({ valid: false, error: 'Must end with .md' });
  if (!fs.existsSync(md_path)) return res.json({ valid: false, error: 'File does not exist' });
  res.json({ valid: true, filename: path.basename(md_path, '.md'), work_dir: path.dirname(md_path) });
});

module.exports = router;
