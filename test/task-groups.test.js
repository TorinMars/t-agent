const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const groups = require('../services/task-groups');

function testDb() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      user_id TEXT
    );
    CREATE TABLE task_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id TEXT NOT NULL,
      group_key TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(owner_id, group_key),
      UNIQUE(owner_id, name)
    );
  `);
  return database;
}

test('首次读取会建立四个兼容分组，三个状态分组不可修改', () => {
  const database = testDb();
  const initial = groups.listGroups(database, 'owner');
  assert.deepEqual(initial.map(group => group.key), ['personal', 'doing', 'todo', 'done']);
  assert.deepEqual(initial.filter(group => group.is_system).map(group => group.key), ['doing', 'todo', 'done']);

  const todo = initial.find(group => group.key === 'todo');
  assert.throws(() => groups.updateGroup(database, 'owner', todo.id, { name: '新的待办' }), /SYSTEM_GROUP_IMMUTABLE/);
  assert.throws(() => groups.deleteGroup(database, 'owner', todo.id), /SYSTEM_GROUP_IMMUTABLE/);
  database.close();
});

test('自定义分组支持新建、重命名和空分组删除', () => {
  const database = testDb();
  const created = groups.createGroup(database, 'owner', { name: '客户项目' });
  assert.equal(created.name, '客户项目');
  assert.equal(created.is_system, false);
  assert.match(created.key, /^group_[a-f0-9]{32}$/);

  const renamed = groups.updateGroup(database, 'owner', created.id, { name: '重点客户' });
  assert.equal(renamed.name, '重点客户');
  groups.deleteGroup(database, 'owner', created.id);
  assert.equal(groups.listGroups(database, 'owner').some(group => group.id === created.id), false);
  database.close();
});

test('有任务的自定义分组不能删除', () => {
  const database = testDb();
  const created = groups.createGroup(database, 'owner', { name: '有任务' });
  database.prepare('INSERT INTO tasks (title, status, user_id) VALUES (?, ?, ?)')
    .run('测试任务', created.key, 'owner');

  const listed = groups.listGroups(database, 'owner').find(group => group.id === created.id);
  assert.equal(listed.task_count, 1);
  assert.throws(() => groups.deleteGroup(database, 'owner', created.id), /TASK_GROUP_NOT_EMPTY/);

  database.prepare('DELETE FROM tasks WHERE user_id = ? AND status = ?').run('owner', created.key);
  groups.deleteGroup(database, 'owner', created.id);
  database.close();
});
