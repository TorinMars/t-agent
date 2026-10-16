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

test('The first read creates four compatible groups, and the three status groups cannot be modified', () => {
  const database = testDb();
  const initial = groups.listGroups(database, 'owner');
  assert.deepEqual(initial.map(group => group.key), ['personal', 'doing', 'todo', 'done']);
  assert.deepEqual(initial.filter(group => group.is_system).map(group => group.key), ['doing', 'todo', 'done']);

  const todo = initial.find(group => group.key === 'todo');
  assert.throws(() => groups.updateGroup(database, 'owner', todo.id, { name: 'New to-do' }), /SYSTEM_GROUP_IMMUTABLE/);
  assert.throws(() => groups.deleteGroup(database, 'owner', todo.id), /SYSTEM_GROUP_IMMUTABLE/);
  database.close();
});

test('Custom groups support create, rename and deleting an empty group', () => {
  const database = testDb();
  const created = groups.createGroup(database, 'owner', { name: 'Client project' });
  assert.equal(created.name, 'Client project');
  assert.equal(created.is_system, false);
  assert.match(created.key, /^group_[a-f0-9]{32}$/);

  const renamed = groups.updateGroup(database, 'owner', created.id, { name: 'Key client' });
  assert.equal(renamed.name, 'Key client');
  groups.deleteGroup(database, 'owner', created.id);
  assert.equal(groups.listGroups(database, 'owner').some(group => group.id === created.id), false);
  database.close();
});

test('A custom group that has tasks cannot be deleted', () => {
  const database = testDb();
  const created = groups.createGroup(database, 'owner', { name: 'has tasks' });
  database.prepare('INSERT INTO tasks (title, status, user_id) VALUES (?, ?, ?)')
    .run('Test task', created.key, 'owner');

  const listed = groups.listGroups(database, 'owner').find(group => group.id === created.id);
  assert.equal(listed.task_count, 1);
  assert.throws(() => groups.deleteGroup(database, 'owner', created.id), /TASK_GROUP_NOT_EMPTY/);

  database.prepare('DELETE FROM tasks WHERE user_id = ? AND status = ?').run('owner', created.key);
  groups.deleteGroup(database, 'owner', created.id);
  database.close();
});

test('Legacy Chinese default group names are renamed to English, custom names are kept', () => {
  const database = testDb();
  const insert = database.prepare('INSERT INTO task_groups (owner_id, group_key, name, sort_order, is_system) VALUES (?, ?, ?, ?, ?)');
  insert.run('owner', 'personal', '\u4e2a\u4eba\u4efb\u52a1', 0, 0);
  insert.run('owner', 'doing', '\u8fdb\u884c\u4e2d', 1000, 1);
  insert.run('owner', 'todo', 'My backlog', 2000, 1);
  insert.run('owner', 'done', '\u5df2\u5b8c\u6210', 3000, 1);
  const names = Object.fromEntries(groups.listGroups(database, 'owner').map(group => [group.key, group.name]));
  assert.deepEqual(names, { personal: 'Personal tasks', doing: 'In progress', todo: 'My backlog', done: 'Done' });
  database.close();
});
