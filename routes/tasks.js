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
  const mdFile = path.join(dir, `${slug}.md`);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(mdFile)) {
    fs.writeFileSync(mdFile, `# ${title}\n`, 'utf8');
  }
  return { work_dir: dir, md_path: mdFile };
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
  }

  const info = db.prepare(`
    INSERT INTO tasks (title, status, priority, due_date, md_path, work_dir, sort_order, user_id)
    VALUES (@title, @status, @priority, @due_date, @md_path, @work_dir, @sort_order, @user_id)
  `).run({ title, status: status || 'todo', priority: priority || 'normal', due_date: due_date || null, md_path: md_path || null, work_dir: work_dir || null, sort_order: sort_order || 0, user_id: uid });

  res.status(201).json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid));
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

router.post('/validate-path', (req, res) => {
  const { md_path } = req.body;
  if (!md_path) return res.status(400).json({ error: 'md_path is required' });
  if (!md_path.startsWith('/') && !(/^[A-Za-z]:\\/.test(md_path))) return res.json({ valid: false, error: 'Must be an absolute path' });
  if (!md_path.endsWith('.md')) return res.json({ valid: false, error: 'Must end with .md' });
  if (!fs.existsSync(md_path)) return res.json({ valid: false, error: 'File does not exist' });
  res.json({ valid: true, filename: path.basename(md_path, '.md'), work_dir: path.dirname(md_path) });
});

module.exports = router;
