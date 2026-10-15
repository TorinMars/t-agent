const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureSingleUser } = require('../services/single-user');

function testDb() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      work_dir TEXT
    );
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, user_id TEXT);
    CREATE TABLE remote_servers (id INTEGER PRIMARY KEY, owner_id TEXT);
  `);
  return database;
}

test('When upgrading to single-user mode the first existing user and working directory are kept', () => {
  const database = testDb();
  database.prepare('INSERT INTO users (username, salt, hash, work_dir) VALUES (?, ?, ?, ?)')
    .run('torin', 'legacy', 'legacy', '/Users/torin/tasks');

  const user = ensureSingleUser(database, '');
  assert.deepEqual(user, {
    login: 'torin', name: 'Local user', avatar_url: '', work_dir: '/Users/torin/tasks',
  });
  assert.equal(database.prepare("SELECT value FROM system_state WHERE key = 'single_user_id'").get().value, 'torin');
  database.close();
});

test('A fresh install creates a local identity that needs no password', () => {
  const database = testDb();
  const user = ensureSingleUser(database, 'local');
  assert.equal(user.login, 'local');
  assert.equal(database.prepare('SELECT hash FROM users WHERE username = ?').get('local').hash, 'password-auth-disabled');

  // After saving, the identity is stable and unaffected by other users that appear later.
  database.prepare('INSERT INTO users (username, salt, hash) VALUES (?, ?, ?)').run('other', 'x', 'x');
  assert.equal(ensureSingleUser(database, '').login, 'local');
  database.close();
});

test('With no user records, the data ownership of existing tasks is inherited first', () => {
  const database = testDb();
  database.prepare('INSERT INTO tasks (id, user_id) VALUES (1, ?), (2, ?)').run('legacy-owner', 'legacy-owner');
  assert.equal(ensureSingleUser(database, '').login, 'legacy-owner');
  database.close();
});

test('The default local does not hide the tasks and remote connections of the old account', () => {
  const database = testDb();
  database.prepare('INSERT INTO users (username, salt, hash) VALUES (?, ?, ?)').run('local', 'x', 'x');
  database.prepare('INSERT INTO users (username, salt, hash, work_dir) VALUES (?, ?, ?, ?)')
    .run('torin', 'legacy', 'legacy', '/Users/torin/tasks');
  database.prepare("INSERT INTO system_state (key, value) VALUES ('single_user_id', 'local')").run();
  database.prepare('INSERT INTO tasks (id, user_id) VALUES (1, ?)').run('torin');
  database.prepare('INSERT INTO remote_servers (id, owner_id) VALUES (1, ?)').run('torin');

  const user = ensureSingleUser(database, 'local');
  assert.equal(user.login, 'torin');
  assert.equal(user.work_dir, '/Users/torin/tasks');
  assert.equal(database.prepare("SELECT value FROM system_state WHERE key = 'single_user_id'").get().value, 'torin');
  database.close();
});

test('With only an old remote connection, its account ownership is inherited too', () => {
  const database = testDb();
  database.prepare("INSERT INTO system_state (key, value) VALUES ('single_user_id', 'local')").run();
  database.prepare('INSERT INTO remote_servers (id, owner_id) VALUES (1, ?)').run('remote-owner');

  assert.equal(ensureSingleUser(database, 'local').login, 'remote-owner');
  database.close();
});
