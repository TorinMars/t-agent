const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { encryptToken } = require('../lib/token-crypto');
const remoteUpdates = require('../services/remote-engine-updates');

test('Client 使用服务端保存的 Token 调用 Engine 更新接口', async () => {
  const secret = 'remote-update-secret';
  const server = {
    base_url: 'https://engine.example.com',
    token_cipher: encryptToken('tae_owner-token', secret),
  };
  const calls = [];
  const request = async (...args) => {
    calls.push(args);
    return { status: 'available', local_version: '2.3.2', remote_version: '2.4.0' };
  };

  await remoteUpdates.getStatus(server, secret, request);
  await remoteUpdates.check(server, secret, request);
  await remoteUpdates.apply(server, secret, request);

  assert.deepEqual(calls, [
    ['https://engine.example.com', '/v1/update/status', 'tae_owner-token'],
    ['https://engine.example.com', '/v1/update/check', 'tae_owner-token', { method: 'POST', body: {}, timeoutMs: 150_000 }],
    ['https://engine.example.com', '/v1/update/apply', 'tae_owner-token', { method: 'POST', body: { confirm: true } }],
  ]);
});

test('Engine 恢复后同步 Client 中记录的远程版本', () => {
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE remote_servers (
    id INTEGER PRIMARY KEY,
    remote_version TEXT,
    status TEXT,
    last_checked_at DATETIME,
    last_error TEXT,
    updated_at DATETIME
  )`);
  database.prepare("INSERT INTO remote_servers (id, remote_version, status, last_error) VALUES (1, '2.3.2', 'offline', 'REMOTE_TIMEOUT')").run();

  remoteUpdates.syncServerVersion(database, 1, {
    status: 'current',
    local_manifest: { app_version: '2.4.0' },
  });

  assert.deepEqual(database.prepare('SELECT remote_version, status, last_error FROM remote_servers WHERE id = 1').get(), {
    remote_version: '2.4.0',
    status: 'online',
    last_error: null,
  });
  database.close();
});
