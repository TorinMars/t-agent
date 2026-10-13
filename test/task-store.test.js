const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const taskStore = require('../services/task-store');

const roots = [];
function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-store-'));
  roots.push(root);
  return root;
}
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

const metaOf = dir => JSON.parse(fs.readFileSync(path.join(dir, '.t-agent', 'task.json'), 'utf8'));

test('工作目录根下的子目录自动成为任务，首次扫描时写入元信息', () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, 'alpha'));
  fs.mkdirSync(path.join(root, 'beta'));
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'loose-file.txt'), 'not a task');

  const store = taskStore.storeFor(root);
  const tasks = store.listTasks();
  assert.deepEqual(tasks.map(task => task.title).sort(), ['alpha', 'beta']);
  assert.ok(tasks.every(task => task.status === 'todo' && Number.isInteger(task.id)));
  assert.equal(metaOf(path.join(root, 'alpha')).title, 'alpha');
  assert.equal(new Set(tasks.map(task => task.id)).size, 2);

  // 之后放进来的目录同样自动加入
  fs.mkdirSync(path.join(root, 'gamma'));
  store.invalidate();
  assert.ok(store.listTasks().some(task => task.title === 'gamma'));
});

test('任务状态和属性保存在元信息文件里，重新加载仍然存在', () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, 'job'));
  const store = taskStore.storeFor(root);
  const [task] = store.listTasks();
  store.updateTask(task.id, { status: 'doing', priority: 'high', title: '新标题' });
  assert.equal(metaOf(path.join(root, 'job')).status, 'doing');

  const fresh = taskStore.storeFor(root, 'someone-else');
  fresh.invalidate();
  const reloaded = fresh.getTask(task.id);
  assert.equal(reloaded.status, 'doing');
  assert.equal(reloaded.title, '新标题');
});

test('可以通过指定路径加载工作目录之外的项目，并记录在 projects.json', () => {
  const root = workspace();
  const outside = workspace();
  const project = path.join(outside, 'external');
  fs.mkdirSync(project);
  const store = taskStore.storeFor(root);
  const created = store.createTask({ title: '外部项目', work_dir: project });
  assert.equal(created.work_dir, project);
  assert.deepEqual(store.listProjectPaths(), [project]);
  assert.ok(store.listTasks().some(task => task.id === created.id));

  // 目录里已有元信息时沿用，不改 ID
  const another = taskStore.storeFor(workspace());
  const adopted = another.createTask({ work_dir: project });
  assert.equal(adopted.id, created.id);
  assert.equal(adopted.title, '外部项目');
});

test('移除任务只打删除标记，不会被下次扫描重新加回来，目录内容保留', () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, 'gone'));
  fs.writeFileSync(path.join(root, 'gone', 'keep.txt'), 'data');
  const store = taskStore.storeFor(root);
  const [task] = store.listTasks();
  assert.equal(store.removeTask(task.id), true);
  store.invalidate();
  assert.equal(store.listTasks().length, 0);
  assert.equal(fs.readFileSync(path.join(root, 'gone', 'keep.txt'), 'utf8'), 'data');
});

test('复制出来的目录带着重复 ID 时，后出现的会重新分配', () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, 'one'));
  const store = taskStore.storeFor(root);
  store.listTasks();
  fs.cpSync(path.join(root, 'one'), path.join(root, 'two'), { recursive: true });
  store.invalidate();
  const ids = store.listTasks().map(task => task.id);
  assert.equal(new Set(ids).size, 2);
});

test('待办和分享令牌保存在元信息文件里', () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, 'todo-task'));
  const store = taskStore.storeFor(root);
  const [task] = store.listTasks();
  const todo = store.createTodo(task.id, '写测试');
  store.updateTodo(task.id, todo.id, { completed: true });
  store.setShareToken(task.id, 'token-123');
  const meta = metaOf(path.join(root, 'todo-task'));
  assert.equal(meta.todos[0].completed, true);
  assert.equal(meta.share_token, 'token-123');
  assert.equal(store.findByShareToken('token-123').id, task.id);
  assert.equal(store.deleteTodo(task.id, todo.id), true);
  assert.deepEqual(store.listTodos(task.id), []);
});

test('旧数据库迁移：写入元信息、保留 ID/分享令牌/待办/分组，只执行一次', () => {
  const root = workspace();
  const outside = workspace();
  const inside = path.join(root, 'legacy-in');
  const external = path.join(outside, 'legacy-out');
  fs.mkdirSync(inside);
  fs.mkdirSync(external);
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, status TEXT, priority TEXT, due_date TEXT, md_path TEXT,
      technical_path TEXT, readme_path TEXT, agent_path TEXT, sort_order INTEGER, work_dir TEXT, share_token TEXT, user_id TEXT,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE task_todos (id INTEGER PRIMARY KEY, task_id INTEGER, content TEXT, completed INTEGER, sort_order INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE task_groups (id INTEGER PRIMARY KEY, owner_id TEXT, group_key TEXT, name TEXT, sort_order INTEGER, is_system INTEGER);
  `);
  database.prepare("INSERT INTO tasks (id, title, status, priority, work_dir, share_token, user_id, created_at, updated_at) VALUES (7, '内部', 'doing', 'high', ?, 'share-7', 'owner', '2026-01-01 00:00:00', '2026-01-02 00:00:00')").run(inside);
  database.prepare("INSERT INTO tasks (id, title, status, work_dir, user_id) VALUES (9, '外部', 'done', ?, 'owner')").run(external);
  database.prepare("INSERT INTO tasks (id, title, status, work_dir, user_id) VALUES (11, '目录不存在', 'todo', ?, 'owner')").run(path.join(root, 'missing'));
  database.prepare("INSERT INTO task_todos (id, task_id, content, completed, sort_order) VALUES (3, 7, '旧待办', 1, 0)").run();
  database.prepare("INSERT INTO task_groups (id, owner_id, group_key, name, sort_order, is_system) VALUES (1, 'owner', 'personal', '个人任务', 0, 0), (2, 'owner', 'group_x', '自定义', 10, 0), (3, 'owner', 'doing', '进行中', 1000, 1)").run();

  const store = taskStore.storeFor(root);
  const result = store.migrateFromDatabase(database);
  assert.deepEqual({ migrated: result.migrated, skipped: result.skipped }, { migrated: 2, skipped: 1 });
  const tasks = store.listTasks();
  assert.deepEqual(tasks.map(task => task.id).sort((a, b) => a - b), [7, 9]);
  assert.equal(store.getTask(7).share_token, 'share-7');
  assert.equal(store.getTask(7).status, 'doing');
  assert.equal(store.listTodos(7)[0].content, '旧待办');
  assert.deepEqual(store.listProjectPaths(), [external]);
  assert.ok(store.listGroups().some(group => group.key === 'group_x'));
  assert.equal(metaOf(inside).title, '内部');

  // 迁移后新任务的 ID 不会和旧 ID 冲突，且第二次迁移不再执行
  assert.ok(store.createTask({ title: '新的', work_dir: path.join(root, 'fresh') }).id > 9);
  assert.equal(store.migrateFromDatabase(database).already, true);
  database.close();
});
