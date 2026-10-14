// 导入/清理工作目录跟随引擎：Engine 的 /v1/workspace/*、Client 对远程引擎的代理，旧版 Engine 返回 501。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-workspace-engine-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'workspace-engine-test-secret-workspace-engine';
fs.mkdirSync(path.join(root, 'tasks', 'remote-only'), { recursive: true });

const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports(req, res, next) { req.session = { user: { login: 'owner' } }; next(); } };

const express = require('express');
const db = require('../db');
const { createAccessToken } = require('../services/engine-auth');
const { encryptToken } = require('../lib/token-crypto');

const servers = [];
const listen = app => new Promise(resolve => {
  const server = app.listen(0, '127.0.0.1', () => { servers.push(server); resolve(`http://127.0.0.1:${server.address().port}`); });
});
let engine, proxy, token, remoteId, legacyId;

test.before(async () => {
  const engineApp = express();
  engineApp.use(express.json());
  engineApp.use('/v1', require('../routes/engine-v1'));
  engine = await listen(engineApp);
  token = createAccessToken(db, { role: 'owner', principalId: 'owner' }).token;
  const add = (name, base) => db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
    .run('owner', name, base, encryptToken(token, process.env.SESSION_SECRET)).lastInsertRowid;
  remoteId = add('engine', engine);
  const legacy = express();
  legacy.use((req, res) => res.status(404).type('text/plain').send('Not Found'));
  legacyId = add('legacy', await listen(legacy));
  const proxyApp = express();
  proxyApp.use(express.json());
  proxyApp.use('/api/remote-servers', require('../routes/remote-servers'));
  proxy = await listen(proxyApp);
});

test.after(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); })));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const auth = { Authorization: `Bearer ${token}` };
const names = data => data.items.map(item => item.name);

test('Engine 声明能力，未授权不能访问', async () => {
  const info = await (await fetch(`${engine}/v1/info`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.ok(info.capabilities.includes('workspace:manage'));
  assert.equal((await fetch(`${engine}/v1/workspace/unmanaged`)).status, 401);
});

test('Engine 列出并导入它自己工作目录里未管理的目录', async () => {
  const listed = await (await fetch(`${engine}/v1/workspace/unmanaged`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.deepEqual(names(listed), ['remote-only']);
  const imported = await fetch(`${engine}/v1/workspace/import`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: [listed.items[0].path] }),
  });
  assert.equal(imported.status, 201);
  const after = await (await fetch(`${engine}/v1/workspace/unmanaged`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.deepEqual(names(after), []);
});

test('清理接口必须带 confirm，经代理也一样', async () => {
  const overview = await fetch(`${proxy}/api/remote-servers/${remoteId}/workspace/cleanup`);
  assert.equal(overview.status, 200);
  assert.ok(Array.isArray((await overview.json()).items));
  const refused = await fetch(`${proxy}/api/remote-servers/${remoteId}/workspace/cleanup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repos: [] }),
  });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error, 'CONFIRM_REQUIRED');
});

test('代理转发到远程 Engine，旧版 Engine 返回 501', async () => {
  fs.mkdirSync(path.join(root, 'tasks', 'second'));
  const viaProxy = await (await fetch(`${proxy}/api/remote-servers/${remoteId}/workspace/unmanaged`)).json();
  assert.deepEqual(names(viaProxy), ['second']);
  const legacy = await fetch(`${proxy}/api/remote-servers/${legacyId}/workspace/unmanaged`);
  assert.equal(legacy.status, 501);
  assert.equal((await legacy.json()).error, 'WORKSPACE_UNSUPPORTED');
});
