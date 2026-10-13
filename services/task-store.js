// 基于文件的任务存储：不再使用数据库保存任务、待办和分组。
//
//   <工作目录>/.t-agent/groups.json    分组定义
//   <工作目录>/.t-agent/projects.json  额外加载的项目路径（位于工作目录之外）
//   <工作目录>/.t-agent/state.json     自增 ID 与迁移标记
//   <项目目录>/.t-agent/task.json      任务元信息（扫描只读取这个文件）
//
// 工作目录根下的每个一级子目录自动成为任务；没有元信息文件的目录会在首次扫描时初始化。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const META_DIR = '.t-agent';
const META_FILE = 'task.json';
const SKIP_DIRS = new Set(['node_modules']);
const CACHE_MS = 1500;

const INITIAL_GROUPS = Object.freeze([
  { key: 'personal', name: '个人任务', sort_order: 0, is_system: false },
  { key: 'doing', name: '进行中', sort_order: 1000, is_system: true },
  { key: 'todo', name: '待办', sort_order: 2000, is_system: true },
  { key: 'done', name: '已完成', sort_order: 3000, is_system: true },
]);

function serviceError(code, statusCode = 400) {
  return Object.assign(new Error(code), { statusCode });
}

function defaultRoot() {
  return path.resolve(process.env.TASKS_BASE_DIR || path.join(os.homedir(), 'tasks'));
}

// 当前账号的工作目录：用户设置优先，其次 TASKS_BASE_DIR，最后 ~/tasks。
function rootFor(database, owner) {
  let custom = null;
  try {
    const row = database && owner ? database.prepare('SELECT work_dir FROM users WHERE username = ?').get(owner) : null;
    custom = row && row.work_dir;
  } catch { /* users 表不可用时回退到默认值 */ }
  return path.resolve(custom || defaultRoot());
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

// 区分“不存在”（需要初始化）和“存在但读不了/不合法”（不能覆盖，要提示用户处理）。
function readMeta(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { return error.code === 'ENOENT' ? { missing: true } : { invalid: `无法读取：${error.code || error.message}` }; }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { invalid: '内容不是 JSON 对象' };
    return { meta: value };
  } catch (error) { return { invalid: `JSON 解析失败：${error.message}` }; }
}

const now = () => new Date().toISOString();
const metaPath = dir => path.join(dir, META_DIR, META_FILE);

function titleToSlug(title) {
  return String(title).replace(/\s+/g, '-').replace(/[^a-zA-Z0-9一-鿿\-_.]/g, '').replace(/^-+|-+$/g, '') || 'task';
}

function isDirectory(target) {
  try { return fs.statSync(target).isDirectory(); } catch { return false; }
}

const stores = new Map();
function createStore(rootInput) {
  const root = path.resolve(rootInput);
  const stateFile = path.join(root, META_DIR, 'state.json');
  const groupsFile = path.join(root, META_DIR, 'groups.json');
  const projectsFile = path.join(root, META_DIR, 'projects.json');
  let cache = null;

  const readState = () => ({ next_task_id: 1, ...readJson(stateFile, {}) });
  const writeState = state => writeJson(stateFile, state);
  const invalidate = () => { cache = null; };

  // ---------- 额外项目路径 ----------
  function listProjectPaths() {
    const value = readJson(projectsFile, { paths: [] });
    return (Array.isArray(value.paths) ? value.paths : []).filter(item => typeof item === 'string' && path.isAbsolute(item)).map(item => path.resolve(item));
  }
  function saveProjectPaths(paths) {
    writeJson(projectsFile, { paths: [...new Set(paths.map(item => path.resolve(item)))] });
  }
  function isInsideRoot(dir) {
    return path.dirname(path.resolve(dir)) === root;
  }
  function registerProject(dir) {
    if (isInsideRoot(dir)) return;
    const paths = listProjectPaths();
    if (!paths.includes(path.resolve(dir))) saveProjectPaths([...paths, dir]);
  }
  function unregisterProject(dir) {
    const target = path.resolve(dir);
    const paths = listProjectPaths();
    if (paths.includes(target)) saveProjectPaths(paths.filter(item => item !== target));
  }

  // ---------- 元信息 ----------
  function toTask(meta, dir) {
    return {
      id: meta.id,
      title: meta.title,
      status: meta.status,
      priority: meta.priority || 'normal',
      due_date: meta.due_date || null,
      md_path: meta.md_path || null,
      technical_path: meta.technical_path || null,
      readme_path: meta.readme_path || null,
      agent_path: meta.agent_path || null,
      sort_order: Number(meta.sort_order) || 0,
      share_token: meta.share_token || null,
      work_dir: dir,
      created_at: meta.created_at,
      updated_at: meta.updated_at,
    };
  }

  function nextId(state) {
    const id = state.next_task_id;
    state.next_task_id = id + 1;
    return id;
  }

  // 读取一个目录的元信息，没有则初始化。返回 null 表示目录不可用或已被移除。
  function loadDir(dir, state, seen, issues) {
    if (!isDirectory(dir)) return null;
    const file = metaPath(dir);
    const read = readMeta(file);
    if (read.invalid) {
      issues.push({ type: 'invalid-meta', path: dir, name: path.basename(dir), message: `任务元信息文件不可用（${read.invalid}）`, suggestion: `修复或删除 ${file} 后会重新初始化；这个目录暂不显示为任务` });
      return null;
    }
    let meta = read.meta;
    let dirty = false;
    if (!meta) {
      const stamp = now();
      meta = { version: 1, title: path.basename(dir), status: 'todo', priority: 'normal', created_at: stamp, updated_at: stamp };
      dirty = true;
    }
    if (meta.deleted) return null;
    if (!Number.isInteger(meta.id) || meta.id < 1 || seen.has(meta.id)) { meta.id = nextId(state); dirty = true; }
    if (meta.id >= state.next_task_id) state.next_task_id = meta.id + 1;
    if (!meta.title) { meta.title = path.basename(dir); dirty = true; }
    if (!meta.status) { meta.status = 'todo'; dirty = true; }
    if (!meta.created_at) { meta.created_at = meta.updated_at || now(); dirty = true; }
    if (!meta.updated_at) { meta.updated_at = meta.created_at; dirty = true; }
    if (dirty) { try { writeJson(file, meta); } catch { /* 目录只读时仍然展示，但无法保存修改 */ } }
    seen.add(meta.id);
    return { meta, dir };
  }

  function scan() {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.entries;
    fs.mkdirSync(root, { recursive: true });
    const state = readState();
    const startNext = state.next_task_id;
    const dirs = [];
    const issues = [];
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(root, entry.name);
        if (entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(full))) {
          if (SKIP_DIRS.has(entry.name)) {
            issues.push({ type: 'unexpected-entry', path: full, name: entry.name, message: '工作目录根下只应放任务目录，这个目录不是任务', suggestion: '建议移出工作目录或删除' });
          } else dirs.push(full);
        } else if (entry.isSymbolicLink()) {
          issues.push({ type: 'invalid-entry', path: full, name: entry.name, message: '符号链接已失效或不指向目录', suggestion: '建议删除这个链接' });
        } else {
          issues.push({ type: 'unexpected-file', path: full, name: entry.name, message: '工作目录根下只应放任务目录，这是一个文件', suggestion: '建议移走或删除这个文件' });
        }
      }
    } catch (error) { issues.push({ type: 'unreadable-root', path: root, name: path.basename(root), message: `工作目录无法读取（${error.code || error.message}）`, suggestion: '检查目录是否存在、当前运行账号是否有读取权限' }); }
    dirs.sort();
    for (const extra of listProjectPaths()) {
      if (dirs.includes(extra)) continue;
      if (!isDirectory(extra)) {
        issues.push({ type: 'missing-project', path: extra, name: path.basename(extra), message: '指定加载的项目路径已不存在', suggestion: '如果已经删除了，可以从列表中移除这条记录' });
        continue;
      }
      dirs.push(extra);
    }

    const seen = new Set();
    const entries = [];
    for (const dir of dirs) {
      const loaded = loadDir(dir, state, seen, issues);
      if (loaded) entries.push(loaded);
    }
    if (state.next_task_id !== startNext) writeState(state);
    cache = { at: Date.now(), entries, issues };
    return entries;
  }

  // 工作目录里发现的不合法内容（随扫描一起得出，不额外读盘）。
  function getIssues() {
    scan();
    return cache ? cache.issues : [];
  }

  function entryById(id) {
    const numeric = Number(id);
    if (!Number.isInteger(numeric)) return null;
    return scan().find(entry => entry.meta.id === numeric) || null;
  }

  function saveEntry(entry) {
    entry.meta.updated_at = now();
    writeJson(metaPath(entry.dir), entry.meta);
    invalidate();
  }

  // ---------- 任务 ----------
  function listTasks(status) {
    return scan().map(entry => toTask(entry.meta, entry.dir))
      .filter(task => !status || task.status === status)
      .sort((a, b) => a.sort_order - b.sort_order || String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id);
  }

  function getTask(id) {
    const entry = entryById(id);
    return entry ? toTask(entry.meta, entry.dir) : null;
  }

  function findByShareToken(token) {
    if (!token) return null;
    const entry = scan().find(item => item.meta.share_token === token);
    return entry ? toTask(entry.meta, entry.dir) : null;
  }

  // 在指定目录创建（或接管）任务。目录已有元信息时沿用，只补充传入的字段。
  function createTask(input) {
    const dir = path.resolve(input.work_dir);
    fs.mkdirSync(dir, { recursive: true });
    const state = readState();
    const file = metaPath(dir);
    const read = readMeta(file);
    if (read.invalid) throw serviceError('TASK_META_INVALID', 409);
    const existing = read.meta || null;
    const stamp = now();
    const meta = existing && typeof existing === 'object' ? existing : { version: 1, created_at: stamp };
    const adopted = Boolean(existing) && !meta.deleted;
    delete meta.deleted;
    if (!adopted || input.title) meta.title = input.title || meta.title || path.basename(dir);
    if (!adopted || input.status) meta.status = input.status || meta.status || 'todo';
    if (!adopted || input.priority) meta.priority = input.priority || meta.priority || 'normal';
    if (input.due_date !== undefined && input.due_date !== null) meta.due_date = input.due_date;
    if (!adopted || Number.isFinite(input.sort_order)) meta.sort_order = Number.isFinite(input.sort_order) ? input.sort_order : (meta.sort_order || 0);
    for (const field of ['md_path', 'technical_path', 'readme_path', 'agent_path']) {
      if (input[field] !== undefined) meta[field] = input[field] || null;
    }
    const seen = new Set(scan().map(entry => entry.meta.id));
    if (!Number.isInteger(meta.id) || meta.id < 1 || seen.has(meta.id)) meta.id = nextId(state);
    else if (meta.id >= state.next_task_id) state.next_task_id = meta.id + 1;
    meta.updated_at = stamp;
    writeJson(file, meta);
    writeState(state);
    registerProject(dir);
    invalidate();
    return toTask(meta, dir);
  }

  function updateTask(id, changes) {
    const entry = entryById(id);
    if (!entry) return null;
    const meta = entry.meta;
    for (const field of ['title', 'status', 'priority', 'due_date', 'sort_order', 'md_path', 'technical_path', 'readme_path', 'agent_path']) {
      if (changes[field] !== undefined) meta[field] = changes[field];
    }
    const nextDir = changes.work_dir ? path.resolve(changes.work_dir) : entry.dir;
    if (nextDir !== entry.dir) {
      // 更换项目目录：元信息跟着搬过去，旧目录的元信息文件删除。
      const targetMeta = readJson(metaPath(nextDir), null);
      if (targetMeta && targetMeta.id !== meta.id) throw serviceError('WORK_DIR_ALREADY_A_TASK', 409);
      fs.mkdirSync(nextDir, { recursive: true });
      meta.updated_at = now();
      writeJson(metaPath(nextDir), meta);
      try { fs.unlinkSync(metaPath(entry.dir)); } catch { /* 忽略 */ }
      unregisterProject(entry.dir);
      registerProject(nextDir);
      invalidate();
      return getTask(meta.id);
    }
    saveEntry(entry);
    return toTask(meta, entry.dir);
  }

  function setShareToken(id, token) {
    const entry = entryById(id);
    if (!entry) return null;
    entry.meta.share_token = token;
    saveEntry(entry);
    return token;
  }

  function reorder(items) {
    for (const { id, sort_order } of items) {
      const entry = entryById(id);
      if (!entry) continue;
      entry.meta.sort_order = sort_order;
      entry.meta.updated_at = now();
      writeJson(metaPath(entry.dir), entry.meta);
    }
    invalidate();
  }

  // 移除任务：打上 deleted 标记（不删除目录内容），避免下次扫描又被自动加回来。
  function removeTask(id) {
    const entry = entryById(id);
    if (!entry) return false;
    entry.meta.deleted = true;
    entry.meta.updated_at = now();
    writeJson(metaPath(entry.dir), entry.meta);
    unregisterProject(entry.dir);
    invalidate();
    return true;
  }

  // ---------- 待办 ----------
  const publicTodo = todo => ({ id: todo.id, task_id: undefined, content: todo.content, completed: Boolean(todo.completed), sort_order: todo.sort_order, created_at: todo.created_at, updated_at: todo.updated_at });
  const sortTodos = todos => [...todos].sort((a, b) => Number(a.completed) - Number(b.completed) || a.sort_order - b.sort_order || String(a.created_at).localeCompare(String(b.created_at)));

  function listTodos(taskId) {
    const entry = entryById(taskId);
    if (!entry) return null;
    return sortTodos(entry.meta.todos || []).map(todo => ({ ...publicTodo(todo), task_id: entry.meta.id }));
  }

  function createTodo(taskId, content) {
    const entry = entryById(taskId);
    if (!entry) return null;
    const todos = entry.meta.todos = entry.meta.todos || [];
    const id = Math.max(Number(entry.meta.next_todo_id) || 1, ...todos.map(todo => todo.id + 1));
    const stamp = now();
    const todo = { id, content, completed: false, sort_order: Math.max(-1, ...todos.map(item => item.sort_order)) + 1, created_at: stamp, updated_at: stamp };
    todos.push(todo);
    entry.meta.next_todo_id = id + 1;
    saveEntry(entry);
    return { ...publicTodo(todo), task_id: entry.meta.id };
  }

  function updateTodo(taskId, todoId, changes) {
    const entry = entryById(taskId);
    const todo = entry && (entry.meta.todos || []).find(item => item.id === Number(todoId));
    if (!todo) return null;
    if (changes.content !== undefined) todo.content = changes.content;
    if (changes.completed !== undefined) todo.completed = Boolean(changes.completed);
    todo.updated_at = now();
    saveEntry(entry);
    return { ...publicTodo(todo), task_id: entry.meta.id };
  }

  function deleteTodo(taskId, todoId) {
    const entry = entryById(taskId);
    if (!entry) return false;
    const before = (entry.meta.todos || []).length;
    entry.meta.todos = (entry.meta.todos || []).filter(item => item.id !== Number(todoId));
    if (entry.meta.todos.length === before) return false;
    saveEntry(entry);
    return true;
  }

  // ---------- 分组 ----------
  function readGroups() {
    const value = readJson(groupsFile, null);
    if (value && Array.isArray(value.groups)) return value;
    const created = { next_id: INITIAL_GROUPS.length + 1, groups: INITIAL_GROUPS.map((group, index) => ({ id: index + 1, ...group })) };
    writeJson(groupsFile, created);
    return created;
  }
  function ensureSystemGroups(data) {
    let changed = false;
    for (const group of INITIAL_GROUPS.filter(item => item.is_system)) {
      if (!data.groups.some(item => item.key === group.key)) { data.groups.push({ id: data.next_id++, ...group }); changed = true; }
    }
    if (changed) writeJson(groupsFile, data);
    return data;
  }
  function publicGroup(group, counts) {
    return { id: group.id, key: group.key, name: group.name, sort_order: group.sort_order, is_system: Boolean(group.is_system), task_count: counts[group.key] || 0 };
  }
  function listGroups() {
    const data = ensureSystemGroups(readGroups());
    const counts = {};
    for (const entry of scan()) counts[entry.meta.status] = (counts[entry.meta.status] || 0) + 1;
    return [...data.groups].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id).map(group => publicGroup(group, counts));
  }
  function normalizeName(value) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name) throw serviceError('GROUP_NAME_REQUIRED');
    if (name.length > 40) throw serviceError('GROUP_NAME_TOO_LONG');
    return name;
  }
  function assertGroupKey(key) {
    const group = listGroups().find(item => item.key === String(key || ''));
    if (!group) throw serviceError('TASK_GROUP_NOT_FOUND', 404);
    return group;
  }
  function createGroup(input = {}) {
    const name = normalizeName(input.name);
    const data = ensureSystemGroups(readGroups());
    if (data.groups.some(group => group.name === name)) throw serviceError('GROUP_NAME_ALREADY_EXISTS', 409);
    const order = Math.max(0, ...data.groups.filter(group => !group.is_system && group.sort_order < 1000).map(group => group.sort_order)) + 10;
    const group = { id: data.next_id++, key: `group_${randomUUID().replace(/-/g, '')}`, name, sort_order: order, is_system: false };
    data.groups.push(group);
    writeJson(groupsFile, data);
    return listGroups().find(item => item.id === group.id);
  }
  function updateGroup(id, input = {}) {
    const data = ensureSystemGroups(readGroups());
    const group = data.groups.find(item => item.id === Number(id));
    if (!group) throw serviceError('TASK_GROUP_NOT_FOUND', 404);
    if (group.is_system) throw serviceError('SYSTEM_GROUP_IMMUTABLE', 400);
    const name = normalizeName(input.name);
    if (data.groups.some(item => item.id !== group.id && item.name === name)) throw serviceError('GROUP_NAME_ALREADY_EXISTS', 409);
    group.name = name;
    writeJson(groupsFile, data);
    return listGroups().find(item => item.id === group.id);
  }
  function deleteGroup(id) {
    const data = ensureSystemGroups(readGroups());
    const group = data.groups.find(item => item.id === Number(id));
    if (!group) throw serviceError('TASK_GROUP_NOT_FOUND', 404);
    if (group.is_system) throw serviceError('SYSTEM_GROUP_IMMUTABLE', 400);
    if (scan().some(entry => entry.meta.status === group.key)) throw serviceError('TASK_GROUP_NOT_EMPTY', 409);
    data.groups = data.groups.filter(item => item.id !== group.id);
    writeJson(groupsFile, data);
  }

  // ---------- 旧数据库迁移 ----------
  // 只执行一次：把数据库里的任务、待办、分组写成文件。数据库表原样保留，便于回退。
  function migrateFromDatabase(database, rowFilter = () => true, owners = []) {
    const state = readState();
    if (state.migrated_from_db) return { migrated: 0, skipped: 0, already: true };
    let migrated = 0;
    let skipped = 0;
    const taken = new Set();
    const ownerList = owners.length ? owners : [null];
    const taskTable = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    if (taskTable) {
      const rows = database.prepare('SELECT * FROM tasks ORDER BY id ASC').all().filter(rowFilter);
      const hasTodos = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_todos'").get();
      for (const row of rows) {
        const dir = row.work_dir || (row.md_path ? path.dirname(row.md_path) : null);
        if (!dir || !path.isAbsolute(dir) || !isDirectory(dir) || taken.has(path.resolve(dir))) { skipped += 1; continue; }
        const file = metaPath(dir);
        const existing = readJson(file, null);
        const todos = hasTodos ? database.prepare('SELECT * FROM task_todos WHERE task_id = ? ORDER BY sort_order ASC, id ASC').all(row.id) : [];
        const stamp = now();
        const iso = value => (value ? new Date(String(value).includes('T') ? value : `${value}Z`).toISOString() : stamp);
        // 目录里已有元信息的以文件为准，不覆盖。
        const meta = existing && typeof existing === 'object' && !existing.deleted ? existing : {
          version: 1,
          id: row.id,
          title: row.title,
          status: row.status || 'todo',
          priority: row.priority || 'normal',
          due_date: row.due_date || null,
          sort_order: row.sort_order || 0,
          share_token: row.share_token || null,
          md_path: row.md_path || null,
          technical_path: row.technical_path || null,
          readme_path: row.readme_path || null,
          agent_path: row.agent_path || null,
          created_at: iso(row.created_at),
          updated_at: iso(row.updated_at),
          todos: todos.map(todo => ({ id: todo.id, content: todo.content, completed: Boolean(todo.completed), sort_order: todo.sort_order, created_at: iso(todo.created_at), updated_at: iso(todo.updated_at) })),
          next_todo_id: Math.max(1, ...todos.map(todo => todo.id + 1)),
        };
        if (Number.isInteger(meta.id) && meta.id >= state.next_task_id) state.next_task_id = meta.id + 1;
        writeJson(file, meta);
        taken.add(path.resolve(dir));
        registerProject(dir);
        migrated += 1;
      }
    }
    const groupTable = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_groups'").get();
    if (groupTable && !fs.existsSync(groupsFile)) {
      const owner = ownerList.find(item => item && database.prepare('SELECT 1 FROM task_groups WHERE owner_id = ?').get(item))
        || (database.prepare('SELECT owner_id FROM task_groups GROUP BY owner_id ORDER BY COUNT(*) DESC LIMIT 1').get() || {}).owner_id;
      const rows = owner ? database.prepare('SELECT * FROM task_groups WHERE owner_id = ? ORDER BY id ASC').all(owner) : [];
      if (rows.length) {
        writeJson(groupsFile, {
          next_id: Math.max(...rows.map(group => group.id)) + 1,
          groups: rows.map(group => ({ id: group.id, key: group.group_key, name: group.name, sort_order: group.sort_order, is_system: Boolean(group.is_system) })),
        });
      }
    }
    state.migrated_from_db = now();
    writeState(state);
    invalidate();
    return { migrated, skipped, already: false };
  }

  return {
    root, scan, invalidate,
    listProjectPaths, getIssues, unregisterProject, registerProject,
    listTasks, getTask, findByShareToken, createTask, updateTask, setShareToken, reorder, removeTask,
    listTodos, createTodo, updateTodo, deleteTodo,
    listGroups, assertGroupKey, createGroup, updateGroup, deleteGroup,
    migrateFromDatabase,
  };
}

function storeFor(root) {
  const key = path.resolve(root);
  if (!stores.has(key)) stores.set(key, createStore(key));
  return stores.get(key);
}

// 当前账号的任务存储；数据库只用来查账号设置的工作目录和一次性迁移。
function forOwner(database, owner) {
  return storeFor(rootFor(database, owner));
}

// 所有已知工作目录（各账号的设置 + 默认值），用于分享链接这类不带账号的查询。
function allStores(database) {
  const roots = new Set([defaultRoot()]);
  try {
    for (const row of database.prepare("SELECT work_dir FROM users WHERE work_dir IS NOT NULL AND work_dir != ''").all()) roots.add(path.resolve(row.work_dir));
  } catch { /* 忽略 */ }
  return [...roots].map(root => storeFor(root));
}

// 启动时迁移：每个工作目录一次。
function migrateAll(database) {
  const results = [];
  for (const store of allStores(database)) {
    const owned = row => rootFor(database, row.user_id) === store.root;
    let owners = [];
    try { owners = database.prepare('SELECT username FROM users').all().map(row => row.username).filter(owner => rootFor(database, owner) === store.root); } catch { /* 忽略 */ }
    results.push({ root: store.root, ...store.migrateFromDatabase(database, owned, owners) });
  }
  return results;
}

module.exports = { META_DIR, META_FILE, INITIAL_GROUPS, rootFor, storeFor, forOwner, allStores, migrateAll, titleToSlug, defaultRoot };
