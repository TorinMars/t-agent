const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-sync-api-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.SESSION_SECRET = 'file-sync-api-test-secret';
const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports(req, res, next) { req.session = { user: { login: 'owner' } }; next(); } };
const express = require('express');
const db = require('../db');
const { createAccessToken } = require('../services/engine-auth');
const { encryptToken } = require('../lib/token-crypto');
const servers = [];
async function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => { servers.push(server); resolve(`http://127.0.0.1:${server.address().port}`); });
  });
}
const requestJson = (url, token, method = 'GET', body) => fetch(url, {
  method,
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

test('Engine 鉴权、主节点清单与已有连接代理', async t => {
  t.after(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); })));
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  const app = express(); app.use(express.json()); app.use('/v1', require('../routes/engine-v1'));
  const engine = await listen(app);
  const token = createAccessToken(db, { principalId: 'owner' }).token;
  assert.equal((await requestJson(`${engine}/v1/file-sync/manifest`)).status, 401);
  const info = await (await requestJson(`${engine}/v1/info`, token)).json();
  assert.ok(info.capabilities.includes('file-sync:manage'));
  const file = path.join(root, 'settings.json');
  fs.writeFileSync(file, '{"setting":true}\n');
  const saved = await requestJson(`${engine}/v1/file-sync/files`, token, 'PUT', { files: [file] });
  assert.equal(saved.status, 200);
  const manifest = await (await requestJson(`${engine}/v1/file-sync/manifest`, token)).json();
  assert.equal(manifest.files[0].path, file);
  assert.equal(Buffer.from(manifest.files[0].content, 'base64').toString(), '{"setting":true}\n');
  const heartbeat = { instance_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: '配置节点', generation: manifest.generation, last_sync_at: new Date().toISOString() };
  assert.equal((await requestJson(`${engine}/v1/file-sync/heartbeat`, null, 'POST', heartbeat)).status, 401);
  assert.equal((await requestJson(`${engine}/v1/file-sync/heartbeat`, token, 'POST', heartbeat)).status, 200);
  const roster = await (await requestJson(`${engine}/v1/file-sync`, token)).json();
  assert.equal(roster.children[0].name, '配置节点');
  assert.equal(roster.children[0].online, true);

  const id = db.prepare('INSERT INTO remote_servers (owner_id,name,base_url,token_cipher) VALUES (?,?,?,?)')
    .run('owner', 'peer', engine, encryptToken(token, process.env.SESSION_SECRET)).lastInsertRowid;
  const proxyApp = express(); proxyApp.use(express.json()); proxyApp.use('/api/remote-servers', require('../routes/remote-servers'));
  const proxy = await listen(proxyApp);
  const response = await requestJson(`${proxy}/api/remote-servers/${id}/file-sync`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).role, 'master');
  assert.equal((await requestJson(`${proxy}/api/remote-servers/${id}/file-sync/servers`)).status, 200);
  assert.equal((await requestJson(`${engine}/v1/file-sync/heartbeat`, token, 'DELETE', heartbeat)).status, 200);
  assert.deepEqual((await (await requestJson(`${engine}/v1/file-sync`, token)).json()).children, []);
});
