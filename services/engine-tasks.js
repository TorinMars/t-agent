const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const config = require('../config');

const DEFAULT_BASE = process.env.TASKS_BASE_DIR || path.join(os.homedir(), 'tasks');

function publicTask(task) {
  if (!task) return null;
  const { user_id, share_token, ...result } = task;
  return result;
}

function allowedRoots() {
  const roots = config.engineWorkspaceRoots.length ? config.engineWorkspaceRoots : [DEFAULT_BASE];
  return roots.map(root => canonicalPath(path.resolve(root)));
}

function canonicalPath(target) {
  let ancestor = target;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  try {
    const realAncestor = fs.realpathSync.native(ancestor);
    return path.resolve(realAncestor, path.relative(ancestor, target));
  } catch {
    return path.resolve(target);
  }
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertWorkspacePath(value) {
  const target = canonicalPath(path.resolve(String(value)));
  if (!allowedRoots().some(root => isInside(root, target))) {
    const error = new Error('WORKSPACE_PATH_NOT_ALLOWED');
    error.statusCode = 400;
    throw error;
  }
  return target;
}

function titleToSlug(title) {
  return String(title)
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9一-鿿\-_\.]/g, '')
    .replace(/^-+|-+$/g, '') || 'task';
}

function ensureDocuments(title, taskDir, technicalPath) {
  fs.mkdirSync(taskDir, { recursive: true });
  const documents = [
    [technicalPath, `# ${title}\n`],
    [path.join(taskDir, 'README.md'), `# ${title}\n\n## 项目说明\n\n`],
    [path.join(taskDir, 'AGENT.md'), '# AGENT.md\n\n## 工作约定\n\n'],
  ];
  for (const [file, initial] of documents) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, initial, 'utf8');
  }
}

function ownedTask(principalId, id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, principalId);
}

function listTasks(principalId, status) {
  if (status) {
    return db.prepare(`SELECT * FROM tasks WHERE user_id = ? AND status = ?
      ORDER BY sort_order ASC, created_at DESC`).all(principalId, status).map(publicTask);
  }
  return db.prepare(`SELECT * FROM tasks WHERE user_id = ?
    ORDER BY sort_order ASC, created_at DESC`).all(principalId).map(publicTask);
}

function createTask(principalId, input = {}) {
  let title = typeof input.title === 'string' ? input.title.trim() : '';
  let mdPath = input.md_path ? assertWorkspacePath(input.md_path) : null;
  let workDir = input.work_dir ? assertWorkspacePath(input.work_dir) : null;
  if (mdPath && path.extname(mdPath).toLowerCase() !== '.md') throw Object.assign(new Error('MD_PATH_INVALID'), { statusCode: 400 });
  if (mdPath && !title) title = path.basename(mdPath, '.md');
  if (!title) throw Object.assign(new Error('TITLE_REQUIRED'), { statusCode: 400 });

  if (!workDir && mdPath) workDir = path.dirname(mdPath);
  if (!workDir) workDir = assertWorkspacePath(path.join(DEFAULT_BASE, titleToSlug(title)));
  if (!mdPath) mdPath = path.join(workDir, 'DESIGN.md');
  mdPath = assertWorkspacePath(mdPath);
  ensureDocuments(title, workDir, mdPath);

  const result = db.prepare(`INSERT INTO tasks
    (title, status, priority, due_date, md_path, work_dir, sort_order, user_id)
    VALUES (@title, @status, @priority, @due_date, @md_path, @work_dir, @sort_order, @user_id)`).run({
    title,
    status: input.status || 'todo',
    priority: input.priority || 'normal',
    due_date: input.due_date || null,
    md_path: mdPath,
    work_dir: workDir,
    sort_order: Number.isFinite(input.sort_order) ? input.sort_order : 0,
    user_id: principalId,
  });
  return publicTask(ownedTask(principalId, result.lastInsertRowid));
}

function updateTask(principalId, id, input = {}) {
  const task = ownedTask(principalId, id);
  if (!task) throw Object.assign(new Error('TASK_NOT_FOUND'), { statusCode: 404 });
  const values = {
    title: input.title === undefined ? task.title : String(input.title).trim(),
    status: input.status === undefined ? task.status : input.status,
    priority: input.priority === undefined ? task.priority : input.priority,
    due_date: input.due_date === undefined ? task.due_date : input.due_date || null,
    md_path: input.md_path === undefined ? task.md_path : (input.md_path ? assertWorkspacePath(input.md_path) : null),
    work_dir: input.work_dir === undefined ? task.work_dir : (input.work_dir ? assertWorkspacePath(input.work_dir) : null),
    sort_order: input.sort_order === undefined ? task.sort_order : input.sort_order,
    id: task.id,
    user_id: principalId,
  };
  if (!values.title) throw Object.assign(new Error('TITLE_REQUIRED'), { statusCode: 400 });
  if (values.md_path && path.extname(values.md_path).toLowerCase() !== '.md') {
    throw Object.assign(new Error('MD_PATH_INVALID'), { statusCode: 400 });
  }
  db.prepare(`UPDATE tasks SET title=@title, status=@status, priority=@priority,
    due_date=@due_date, md_path=@md_path, work_dir=@work_dir, sort_order=@sort_order,
    updated_at=CURRENT_TIMESTAMP WHERE id=@id AND user_id=@user_id`).run(values);
  return publicTask(ownedTask(principalId, id));
}

function deleteTask(principalId, id) {
  const result = db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(id, principalId);
  if (!result.changes) throw Object.assign(new Error('TASK_NOT_FOUND'), { statusCode: 404 });
}

function documentPath(task, kind) {
  if (kind === 'technical') return task.md_path;
  const root = task.work_dir || (task.md_path && path.dirname(task.md_path));
  if (!root) return null;
  if (kind === 'readme') return path.join(root, 'README.md');
  if (kind === 'agent') return path.join(root, 'AGENT.md');
  return null;
}

function readDocument(principalId, id, kind) {
  const task = ownedTask(principalId, id);
  if (!task) throw Object.assign(new Error('TASK_NOT_FOUND'), { statusCode: 404 });
  const file = documentPath(task, kind);
  if (!file) throw Object.assign(new Error('DOCUMENT_NOT_FOUND'), { statusCode: 404 });
  assertWorkspacePath(file);
  try { return fs.readFileSync(file, 'utf8'); }
  catch { throw Object.assign(new Error('DOCUMENT_NOT_FOUND'), { statusCode: 404 }); }
}

function writeDocument(principalId, id, kind, content) {
  if (typeof content !== 'string') throw Object.assign(new Error('CONTENT_REQUIRED'), { statusCode: 400 });
  if (Buffer.byteLength(content, 'utf8') > 5 * 1024 * 1024) {
    throw Object.assign(new Error('DOCUMENT_TOO_LARGE'), { statusCode: 413 });
  }
  const task = ownedTask(principalId, id);
  if (!task) throw Object.assign(new Error('TASK_NOT_FOUND'), { statusCode: 404 });
  const file = documentPath(task, kind);
  if (!file) throw Object.assign(new Error('DOCUMENT_NOT_FOUND'), { statusCode: 404 });
  assertWorkspacePath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function listTodos(principalId, taskId) {
  const task = ownedTask(principalId, taskId);
  if (!task) throw Object.assign(new Error('TASK_NOT_FOUND'), { statusCode: 404 });
  return db.prepare(`SELECT * FROM task_todos WHERE task_id = ?
    ORDER BY completed ASC, sort_order ASC, created_at ASC`).all(task.id)
    .map(todo => ({ ...todo, completed: Boolean(todo.completed) }));
}

function createTodo(principalId, taskId, input = {}) {
  const task = ownedTask(principalId, taskId);
  if (!task) throw Object.assign(new Error('TASK_NOT_FOUND'), { statusCode: 404 });
  const content = typeof input.content === 'string' ? input.content.trim() : '';
  if (!content) throw Object.assign(new Error('CONTENT_REQUIRED'), { statusCode: 400 });
  const order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 value FROM task_todos WHERE task_id = ?').get(task.id).value;
  const result = db.prepare('INSERT INTO task_todos (task_id, content, sort_order) VALUES (?, ?, ?)').run(task.id, content, order);
  const todo = db.prepare('SELECT * FROM task_todos WHERE id = ?').get(result.lastInsertRowid);
  return { ...todo, completed: Boolean(todo.completed) };
}

function updateTodo(principalId, taskId, todoId, input = {}) {
  const task = ownedTask(principalId, taskId);
  if (!task) throw Object.assign(new Error('TASK_NOT_FOUND'), { statusCode: 404 });
  const todo = db.prepare('SELECT * FROM task_todos WHERE id = ? AND task_id = ?').get(todoId, task.id);
  if (!todo) throw Object.assign(new Error('TODO_NOT_FOUND'), { statusCode: 404 });
  const content = input.content === undefined ? todo.content : String(input.content).trim();
  if (!content) throw Object.assign(new Error('CONTENT_REQUIRED'), { statusCode: 400 });
  const completed = input.completed === undefined ? todo.completed : (input.completed ? 1 : 0);
  db.prepare(`UPDATE task_todos SET content = ?, completed = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`).run(content, completed, todo.id);
  const updated = db.prepare('SELECT * FROM task_todos WHERE id = ?').get(todo.id);
  return { ...updated, completed: Boolean(updated.completed) };
}

function deleteTodo(principalId, taskId, todoId) {
  const task = ownedTask(principalId, taskId);
  if (!task) throw Object.assign(new Error('TASK_NOT_FOUND'), { statusCode: 404 });
  const result = db.prepare('DELETE FROM task_todos WHERE id = ? AND task_id = ?').run(todoId, task.id);
  if (!result.changes) throw Object.assign(new Error('TODO_NOT_FOUND'), { statusCode: 404 });
}

module.exports = {
  allowedRoots,
  assertWorkspacePath,
  ownedTask,
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  readDocument,
  writeDocument,
  listTodos,
  createTodo,
  updateTodo,
  deleteTodo,
};
