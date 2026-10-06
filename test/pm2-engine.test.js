// PM2 管理跟随引擎：Engine 的 /v1/pm2（仅 owner Token）以及 Client 的 /api/remote-servers/:id/pm2 代理。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-pm2-engine-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'pm2-engine-test-secret-pm2-engine-test-secret';

const SECRET = 'SUPER-SECRET-TOKEN-123';
fs.mkdirSync(path.join(root, 'home'));
fs.writeFileSync(path.join(root, 'home', 'rpc.sock'), '');
const outLog = path.join(root, 'app-out.log');
fs.writeFileSync(outLog, ['line 1', 'line 2', 'line 3'].join('\n') + '\n');
fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify([
  { name: 'app', pm_id: 0, pid: 111, monit: { cpu: 1, memory: 1048576 }, pm2_env: { status: 'online', pm_uptime: Date.now(), restart_time: 0, pm_exec_path: '/srv/app.js', pm_out_log_path: outLog, env: { API_TOKEN: SECRET } } },
]));
fs.writeFileSync(path.join(root, 'pm2'), `#!/usr/bin/env node
const fs = require('fs'); const dir = ${JSON.stringify(root)};
const state = JSON.parse(fs.readFileSync(dir + '/state.json', 'utf8')); const [cmd, id] = process.argv.slice(2);
if (cmd === 'jlist') console.log(JSON.stringify(state));
else { const p = state.find(x => String(x.pm_id) === id); p.pm2_env.status = { start: 'online', restart: 'online', reload: 'online', stop: 'stopped' }[cmd]; fs.writeFileSync(dir + '/state.json', JSON.stringify(state)); }
`, { mode: 0o755 });
process.env.T_AGENT_PM2_BIN = path.join(root, 'pm2');
process.env.PM2_HOME = path.join(root, 'home');

const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports(req, res, next) { req.session = { user: { login: 'owner', work_dir: path.join(root, 'tasks') } }; next(); },
};

const express = require('express');
const db = require('../db');
const { createAccessToken } = require('../services/engine-auth');
const { encryptToken } = require('../lib/token-crypto');

const servers = [];
function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('listening', () => { servers.push(server); resolve(`http://127.0.0.1:${server.address().port}`); });
    server.once('error', reject);
  });
}

let engine, ownerToken, requestedOperatorToken, proxy, ownerRemote, legacyRemote;

test.before(async () => {
  const engineApp = express();
  engineApp.use(express.json());
  engineApp.use('/v1', require('../routes/engine-v1'));
  engine = await listen(engineApp);

  ownerToken = createAccessToken(db, { role: 'owner', principalId: 'owner' }).token;
  requestedOperatorToken = createAccessToken(db, { role: 'operator', principalId: 'owner' }).token;
  const add = (name, base, token) => db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
    .run('owner', name, base, encryptToken(token, process.env.SESSION_SECRET)).lastInsertRowid;
  ownerRemote = add('owner-engine', engine, ownerToken);

  // 旧版 Engine 没有 /v1/pm2：任何未知路径都是通用 404。
  const legacyApp = express();
  legacyApp.use((req, res) => res.status(404).type('text/plain').send('Not Found'));
  legacyRemote = add('legacy-engine', await listen(legacyApp), ownerToken);

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

const engineCall = (token, suffix, method = 'GET') => fetch(`${engine}/v1/pm2${suffix}`, { method, headers: { Authorization: `Bearer ${token}` } });
const proxyCall = (id, suffix, method = 'GET') => fetch(`${proxy}/api/remote-servers/${id}/pm2${suffix}`, { method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}) });

test('Engine advertises PM2 management', async () => {
  const info = await (await fetch(`${engine}/v1/info`, { headers: { Authorization: `Bearer ${ownerToken}` } })).json();
  assert.ok(info.capabilities.includes('pm2:manage'));
});

test('every Engine token can use the PM2 routes, a missing or invalid token cannot', async () => {
  // 所有连接都是管理权限：即使以 operator 请求的令牌也可以。
  assert.equal((await engineCall(requestedOperatorToken, '/status')).status, 200);
  assert.equal((await engineCall('tae_invalid', '/status')).status, 401);
  assert.equal((await fetch(`${engine}/v1/pm2/status`)).status, 401);
});

test('Engine lists processes without leaking their environment and controls them', async () => {
  const listed = await engineCall(ownerToken, '/status');
  assert.equal(listed.status, 200);
  const text = await listed.text();
  assert.ok(!text.includes(SECRET), 'process env must never be returned');
  const data = JSON.parse(text);
  assert.equal(data.installed, true);
  assert.equal(data.processes[0].name, 'app');

  const stopped = await (await engineCall(ownerToken, '/0/stop', 'POST')).json();
  assert.equal(stopped.process.status, 'stopped');
  const started = await (await engineCall(ownerToken, '/0/start', 'POST')).json();
  assert.equal(started.process.status, 'online');

  const logs = await (await engineCall(ownerToken, '/0/logs?stream=out&lines=2')).json();
  assert.deepEqual(logs.lines, ['line 2', 'line 3']);

  const bad = await engineCall(ownerToken, '/0/delete', 'POST');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'PM2_BAD_ACTION');
});

test('the Client proxy forwards PM2 requests to the selected Engine', async () => {
  const listed = await proxyCall(ownerRemote, '/status');
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).processes[0].name, 'app');

  const restarted = await (await proxyCall(ownerRemote, '/0/restart', 'POST')).json();
  assert.equal(restarted.process.status, 'online');

  const logs = await (await proxyCall(ownerRemote, '/0/logs?stream=out&lines=1')).json();
  assert.deepEqual(logs.lines, ['line 3']);
});

test('the proxy reports unsupported Engines and unknown connections', async () => {
  const legacy = await proxyCall(legacyRemote, '/status');
  assert.equal(legacy.status, 501);
  assert.equal((await legacy.json()).error, 'PM2_UNSUPPORTED');

  const missing = await proxyCall(99999, '/status');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'REMOTE_NOT_FOUND');
});
