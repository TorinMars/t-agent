// The app list follows the engine: the Engine's /v1/apps (Bearer token, programs can self-register), the local /api/apps, and the Client's proxy to remote engines.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-apps-engine-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'apps-engine-test-secret-apps-engine-test-secret';

const SECRET = 'SUPER-SECRET-TOKEN-123';
fs.mkdirSync(path.join(root, 'home'));
fs.writeFileSync(path.join(root, 'home', 'rpc.sock'), '');
fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify([
  { name: 'web', pm_id: 0, pid: 4194000, monit: { cpu: 1, memory: 1048576 }, pm2_env: { status: 'online', pm_uptime: Date.now(), restart_time: 0, pm_exec_path: '/srv/web.js', env: { API_TOKEN: SECRET } } },
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
  exports(req, res, next) {
    if (req.get('Authorization') === 'Bearer session-denied') return res.status(401).json({ error: 'AUTH_REQUIRED' });
    req.session = { user: { login: 'owner', work_dir: path.join(root, 'tasks') } }; next();
  },
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

let engine, local, proxy, ownerToken, ownerRemote, legacyRemote;

test.before(async () => {
  const engineApp = express();
  engineApp.use(express.json());
  engineApp.use('/v1', require('../routes/engine-v1'));
  engine = await listen(engineApp);

  const localApp = express();
  localApp.use(express.json());
  localApp.use('/api/apps', require('../routes/apps').createAppsRouter());
  local = await listen(localApp);

  ownerToken = createAccessToken(db, { role: 'owner', principalId: 'owner' }).token;
  const add = (name, base, token) => db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
    .run('owner', name, base, encryptToken(token, process.env.SESSION_SECRET)).lastInsertRowid;
  ownerRemote = add('owner-engine', engine, ownerToken);
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

const json = { 'Content-Type': 'application/json' };
const engineCall = (suffix, { method = 'GET', body, token = ownerToken } = {}) => fetch(`${engine}/v1/apps${suffix}`, {
  method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? json : {}) }, body: body ? JSON.stringify(body) : undefined });
const proxyCall = (id, suffix, { method = 'GET', body } = {}) => fetch(`${proxy}/api/remote-servers/${id}/apps${suffix}`, {
  method, headers: body ? json : {}, body: body ? JSON.stringify(body) : undefined });

test('The Engine declares the app-list capability, and access fails with no token or an invalid token', async () => {
  const info = await (await fetch(`${engine}/v1/info`, { headers: { Authorization: `Bearer ${ownerToken}` } })).json();
  assert.ok(info.capabilities.includes('apps:manage'));
  assert.equal((await engineCall('', { token: null })).status, 401);
  assert.equal((await engineCall('', { token: 'tae_invalid' })).status, 401);
  assert.equal((await engineCall('/register', { method: 'POST', body: { name: 'x' }, token: null })).status, 401);
});

test('The list auto-registers PM2 processes and does not leak their environment variables', async () => {
  const response = await engineCall('');
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes(SECRET));
  const data = JSON.parse(text);
  const web = data.apps.find(app => app.name === 'web');
  assert.equal(web.source, 'pm2');
  assert.equal(web.pm2.id, 0);
  assert.equal(web.pm2_state, 'online');
  assert.ok(Array.isArray(data.host_ips));
});

test('Programs self-register with a token: idempotent, returns 201/200, invalid content gets 400 with an error code', async () => {
  const first = await engineCall('/register', { method: 'POST', body: { name: 'billing-api', port: 7001, description: 'Billing service' } });
  assert.equal(first.status, 201);
  const created = await first.json();
  assert.equal(created.created, true);
  assert.equal(created.app.source, 'api');

  const again = await engineCall('/register', { method: 'POST', body: { name: 'billing-api', port: 7002 } });
  assert.equal(again.status, 200);
  const updated = await again.json();
  assert.equal(updated.created, false);
  assert.equal(updated.app.id, created.app.id);
  assert.equal(updated.app.port, 7002);
  assert.equal(updated.app.description, 'Billing service');

  const evil = await engineCall('/register', { method: 'POST', body: { name: 'evil', url: 'javascript:alert(1)' } });
  assert.equal(evil.status, 400);
  const body = await evil.json();
  assert.equal(body.error, 'APP_URL_INVALID');
  assert.equal(typeof body.message, 'string');
  assert.equal((await engineCall('/register', { method: 'POST', body: { port: 1 } })).status, 400);
  const listed = await (await engineCall('')).json();
  assert.ok(!listed.apps.some(app => app.name === 'evil'));
});

test('Add, edit and delete manually; same name gives 409; not found gives 404; deleting a service still in PM2 only hides it and it can be restored', async () => {
  const created = await engineCall('', { method: 'POST', body: { name: 'blog', port: 8080, domain: 'blog.example.com', scheme: 'https' } });
  assert.equal(created.status, 201);
  const { app } = await created.json();
  const dup = await engineCall('', { method: 'POST', body: { name: 'BLOG' } });
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).error, 'APP_NAME_TAKEN');

  const put = await engineCall(`/${app.id}`, { method: 'PUT', body: { port: 8081 } });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).app.port, 8081);
  assert.equal((await engineCall('/99999', { method: 'PUT', body: { port: 1 } })).status, 404);
  assert.equal((await engineCall('/abc', { method: 'DELETE' })).status, 404);

  const removed = await (await engineCall(`/${app.id}`, { method: 'DELETE' })).json();
  assert.deepEqual(removed, { deleted: true, hidden: false });

  const web = (await (await engineCall('')).json()).apps.find(item => item.name === 'web');
  assert.deepEqual(await (await engineCall(`/${web.id}`, { method: 'DELETE' })).json(), { deleted: false, hidden: true });
  const afterHide = await (await engineCall('')).json();
  assert.ok(!afterHide.apps.some(item => item.name === 'web'));
  assert.equal(afterHide.hidden_count, 1);
  assert.equal((await (await engineCall('/restore-hidden', { method: 'POST', body: {} })).json()).restored, 1);
  assert.ok((await (await engineCall('')).json()).apps.some(item => item.name === 'web'));
});

test('This machine /api/apps: requires origin and login, CRUD works, responses are not cached', async () => {
  const headers = { 'X-Requested-With': 'XMLHttpRequest' };
  assert.equal((await fetch(`${local}/api/apps`, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${local}/api/apps`, { headers: { ...headers, Authorization: 'Bearer session-denied' } })).status, 401);
  const listed = await fetch(`${local}/api/apps`, { headers });
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get('cache-control'), 'no-store');
  const created = await fetch(`${local}/api/apps`, { method: 'POST', headers: { ...headers, ...json }, body: JSON.stringify({ name: 'local-one', port: 4321 }) });
  assert.equal(created.status, 201);
  const { app } = await created.json();
  assert.equal((await fetch(`${local}/api/apps/${app.id}`, { method: 'DELETE', headers })).status, 200);
  const bad = await fetch(`${local}/api/apps`, { method: 'POST', headers: { ...headers, ...json }, body: JSON.stringify({ name: 'bad', domain: 'javascript:alert(1)' }) });
  assert.equal(bad.status, 400);
});

test('The Client proxy forwards app requests to the selected engine and passes error codes through; an old engine returns 501', async () => {
  const listed = await proxyCall(ownerRemote, '');
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray((await listed.json()).apps));

  const created = await proxyCall(ownerRemote, '', { method: 'POST', body: { name: 'proxied', port: 6000 } });
  assert.equal(created.status, 200, 'The proxy keeps using res.json and does not pass the upstream 201 through');
  const { app } = await created.json();
  const dup = await proxyCall(ownerRemote, '', { method: 'POST', body: { name: 'proxied' } });
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).error, 'APP_NAME_TAKEN');
  const put = await proxyCall(ownerRemote, `/${app.id}`, { method: 'PUT', body: { port: 6001 } });
  assert.equal((await put.json()).app.port, 6001);
  const missing = await proxyCall(ownerRemote, '/424242', { method: 'PUT', body: { port: 1 } });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'APP_NOT_FOUND');
  assert.deepEqual(await (await proxyCall(ownerRemote, `/${app.id}`, { method: 'DELETE' })).json(), { deleted: true, hidden: false });
  assert.equal((await (await proxyCall(ownerRemote, '/restore-hidden', { method: 'POST', body: {} })).json()).restored >= 0, true);

  const legacy = await proxyCall(legacyRemote, '');
  assert.equal(legacy.status, 501);
  assert.equal((await legacy.json()).error, 'APPS_UNSUPPORTED');
  const gone = await proxyCall(99999, '');
  assert.equal(gone.status, 404);
  assert.equal((await gone.json()).error, 'REMOTE_NOT_FOUND');
});
