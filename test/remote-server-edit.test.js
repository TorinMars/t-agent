const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { encryptToken } = require('../lib/token-crypto');
const { inspectRemoteAddress, persistRemoteServerEdit } = require('../services/remote-server-settings');

function testDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE remote_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    token_cipher TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unknown',
    remote_version TEXT,
    last_checked_at DATETIME,
    last_error TEXT,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(owner_id, base_url)
  )`);
  return db;
}

test('编辑远程连接沿用已保存 Token，验证成功后再更新地址', async () => {
  const db = testDb();
  const secret = 'remote-edit-test-secret';
  const token = 'tae_saved-token';
  db.prepare(`INSERT INTO remote_servers (owner_id, name, base_url, token_cipher)
    VALUES (?, ?, ?, ?)`).run('tester', '旧名称', 'http://127.0.0.1:13500', encryptToken(token, secret));
  const row = db.prepare('SELECT * FROM remote_servers').get();

  const requested = [];
  const requestFn = async (...args) => {
    requested.push(args);
    return { engine_version: '9.8.7' };
  };
  const body = { name: 'HTTPS Engine', url: 'https://tasks.example.com', port: '' };
  const { baseUrl, capabilities } = await inspectRemoteAddress(row, body, secret, requestFn);

  assert.equal(baseUrl, 'https://tasks.example.com');
  assert.deepEqual(requested, [['https://tasks.example.com', '/v1/info', token]]);
  persistRemoteServerEdit(db, row, 'tester', body, baseUrl, capabilities);

  const updated = db.prepare('SELECT name, base_url, status, remote_version, last_error FROM remote_servers').get();
  assert.deepEqual(updated, {
    name: 'HTTPS Engine',
    base_url: 'https://tasks.example.com',
    status: 'online',
    remote_version: '9.8.7',
    last_error: null,
  });
  db.close();
});

test('新地址验证失败时不会修改原连接', async () => {
  const db = testDb();
  const secret = 'remote-edit-test-secret';
  db.prepare(`INSERT INTO remote_servers (owner_id, name, base_url, token_cipher)
    VALUES (?, ?, ?, ?)`).run('tester', '原连接', 'http://127.0.0.1:13500', encryptToken('tae_token', secret));
  const row = db.prepare('SELECT * FROM remote_servers').get();

  await assert.rejects(
    inspectRemoteAddress(row, { url: 'https://bad.example.com' }, secret, async () => {
      throw new Error('REMOTE_CONNECTION_FAILED');
    }),
    /REMOTE_CONNECTION_FAILED/,
  );
  assert.deepEqual(
    db.prepare('SELECT name, base_url FROM remote_servers').get(),
    { name: '原连接', base_url: 'http://127.0.0.1:13500' },
  );
  db.close();
});
