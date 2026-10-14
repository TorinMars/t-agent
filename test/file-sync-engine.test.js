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
  // 文件同步不再借用引擎连接：这些接口已移除。
  for (const [method, route] of [['GET', 'servers'], ['POST', 'pairing'], ['POST', 'connect']]) {
    assert.equal((await requestJson(`${engine}/v1/file-sync/${route}`, token, method, method === 'POST' ? {} : undefined)).status, 404, route);
  }

  // 同步配对码：主服务器生成，从服务器用它换取只能访问同步接口的令牌，不是引擎令牌。
  const service = require('../services/file-sync-instance');
  const code = service.createSyncCode();
  assert.match(code, /^TA-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const exchanged = await requestJson(`${engine}/v1/file-sync/pair`, null, 'POST', { code, name: '从服务器', instance_id: heartbeat.instance_id });
  assert.equal(exchanged.status, 200);
  const syncToken = (await exchanged.json()).access_token;
  assert.match(syncToken, /^tfs_/);
  assert.equal((await requestJson(`${engine}/v1/file-sync/manifest`, syncToken)).status, 200);
  assert.equal((await requestJson(`${engine}/v1/file-sync/heartbeat`, syncToken, 'POST', heartbeat)).status, 200);
  assert.equal((await requestJson(`${engine}/v1/file-sync`, syncToken)).status, 401, '同步令牌不能管理清单和角色');
  assert.equal((await requestJson(`${engine}/v1/file-sync/files`, syncToken, 'PUT', { files: [] })).status, 401);
  assert.equal((await requestJson(`${engine}/v1/info`, syncToken)).status, 401, '也不能访问引擎其他接口');
  assert.equal((await requestJson(`${engine}/v1/file-sync/pair`, null, 'POST', { code })).status, 400, '配对码只能使用一次');
  assert.equal((await requestJson(`${engine}/v1/file-sync/pair`, null, 'POST', { code: 'bad' })).status, 400);
  // 主服务器生成连接字符串（需要管理令牌，同步令牌不行）；字符串里的配对码可以换同步令牌。
  assert.equal((await requestJson(`${engine}/v1/file-sync/invite`, null, 'POST', { master_url: engine })).status, 401);
  assert.equal((await requestJson(`${engine}/v1/file-sync/invite`, syncToken, 'POST', { master_url: engine })).status, 401);
  const derived = await (await requestJson(`${engine}/v1/file-sync/invite`, token, 'POST', {})).json();
  assert.equal(JSON.parse(Buffer.from(derived.connection_string.slice(6), 'base64url').toString()).u, engine, '不填地址时按收到请求的地址生成');
  const invite = await (await requestJson(`${engine}/v1/file-sync/invite`, token, 'POST', { master_url: engine })).json();
  assert.match(invite.connection_string, /^TAFS1:/);
  const inviteCode = JSON.parse(Buffer.from(invite.connection_string.slice(6), 'base64url').toString()).c;
  assert.equal((await requestJson(`${engine}/v1/file-sync/join`, token, 'POST', { connection_string: invite.connection_string })).status, 409, '主服务器不能用字符串连接');
  assert.equal((await requestJson(`${engine}/v1/file-sync/pair`, null, 'POST', { code: inviteCode })).status, 200);
  for (const route of ['adopt', 'associate', 'refresh-code']) {
    assert.equal((await requestJson(`${engine}/v1/file-sync/${route}`, token, 'POST', {})).status, 404, route);
  }
  assert.equal((await requestJson(`${engine}/v1/file-sync/heartbeat`, syncToken, 'DELETE', heartbeat)).status, 200);
  assert.equal((await requestJson(`${engine}/v1/file-sync/manifest`, syncToken)).status, 401, '从服务器注销后令牌被吊销');
  assert.equal((await requestJson(`${engine}/v1/file-sync/heartbeat`, token, 'DELETE', heartbeat)).status, 200);
  assert.deepEqual((await (await requestJson(`${engine}/v1/file-sync`, token)).json()).children, []);
});
