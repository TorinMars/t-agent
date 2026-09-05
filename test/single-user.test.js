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

test('升级为单用户模式时沿用已有的第一个用户及工作目录', () => {
  const database = testDb();
  database.prepare('INSERT INTO users (username, salt, hash, work_dir) VALUES (?, ?, ?, ?)')
    .run('torin', 'legacy', 'legacy', '/Users/torin/tasks');

  const user = ensureSingleUser(database, '');
  assert.deepEqual(user, {
    login: 'torin', name: '本地用户', avatar_url: '', work_dir: '/Users/torin/tasks',
  });
  assert.equal(database.prepare("SELECT value FROM system_state WHERE key = 'single_user_id'").get().value, 'torin');
  database.close();
});

test('全新安装自动建立无需密码的本地身份', () => {
  const database = testDb();
  const user = ensureSingleUser(database, 'local');
  assert.equal(user.login, 'local');
  assert.equal(database.prepare('SELECT hash FROM users WHERE username = ?').get('local').hash, 'password-auth-disabled');

  // 保存后的身份稳定，不受随后出现的其他用户影响。
  database.prepare('INSERT INTO users (username, salt, hash) VALUES (?, ?, ?)').run('other', 'x', 'x');
  assert.equal(ensureSingleUser(database, '').login, 'local');
  database.close();
});

test('没有用户记录时优先继承已有任务的数据归属', () => {
  const database = testDb();
  database.prepare('INSERT INTO tasks (id, user_id) VALUES (1, ?), (2, ?)').run('legacy-owner', 'legacy-owner');
  assert.equal(ensureSingleUser(database, '').login, 'legacy-owner');
  database.close();
});
