// 访问模式：身份验证器 + 允许外网访问（remote）/ 仅本机访问、无需验证（local）；全新安装第一次选择，之后可在设置里切换。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const { createClientAuth, totp } = require('../services/client-auth');
const { createAccessGate, upgradeAllowed } = require('../lib/access-gate');

function fixture(options = {}) {
  const database = new Database(':memory:');
  const auth = createClientAuth(database, { sessionSecret: 'test-only-secret-'.repeat(4), ownerId: 'local', ...options });
  return { database, auth };
}
const loopbackRequest = (extra = {}) => ({ headers: { host: '127.0.0.1:3000' }, socket: { remoteAddress: '127.0.0.1' }, session: {}, method: 'GET', path: '/', ...extra });

test('访问模式的判定：全新为 unset，绑定过为 remote，保存的选择优先，ACCESS_MODE 只做初始值', t => {
  const fresh = fixture(); t.after(() => fresh.database.close());
  assert.equal(fresh.auth.accessMode(), 'unset');
  assert.deepEqual(fresh.auth.ready({}), { mode: 'unset', setupRequired: true, loginRequired: true });
  assert.equal(fixture({ initialMode: 'local' }).auth.accessMode(), 'local', 'seed from env');
  assert.equal(fixture({ initialMode: 'bogus' }).auth.accessMode(), 'unset');

  const session = {};
  const setup = fresh.auth.beginSetup(session, 'ip');
  fresh.auth.confirmSetup(session, totp(setup.secret, Math.floor(Date.now() / 30000)), 'ip');
  assert.equal(fresh.auth.accessMode(), 'remote', 'binding the authenticator enables remote access');

  assert.throws(() => fresh.auth.setAccessMode('everything'), /INVALID_ACCESS_MODE/);
  fresh.auth.setAccessMode('local');
  assert.equal(fresh.auth.accessMode(), 'local', 'a saved choice wins over the bound-implies-remote default');
});

test('仅本机模式：不需要绑定，只有被标记可信的本机会话视为已登录，切回 remote 后标记失效', t => {
  const { database, auth } = fixture(); t.after(() => database.close());
  auth.setAccessMode('local');
  assert.deepEqual(auth.ready({}), { mode: 'local', setupRequired: false, loginRequired: true });
  assert.equal(auth.authenticated({ clientAuth: { ownerId: 'local', expiresAt: Date.now() + 1000 } }), false, 'a forged remote-style grant is not enough');
  const trusted = { localTrusted: true, cookie: {} };
  assert.equal(auth.authenticated(trusted), true);
  assert.equal(auth.renew(trusted), true, 'renew must not touch a missing clientAuth grant');
  database.exec('CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess TEXT, expired INTEGER)');
  database.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('live', JSON.stringify({ localTrusted: true }), Date.now() + 60000);
  database.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('anon', JSON.stringify({}), Date.now() + 60000);
  assert.equal(auth.sessionActive('live'), true, 'open terminals of a trusted local session stay connected');
  assert.equal(auth.sessionActive('anon'), false);
  auth.setAccessMode('remote');
  assert.equal(auth.authenticated(trusted), false, 'trust flag is ignored once remote access is on');
  assert.equal(auth.sessionActive('live'), false, 'and open terminals are dropped by the periodic check');
});

test('门禁：remote 放行所有请求；local / unset 只放行本机直连，转发、隧道和非回环 Host 都是 404', () => {
  let mode = 'remote';
  const gate = createAccessGate({ getMode: () => mode });
  const run = req => { const out = { next: false, status: null }; const res = { status(code) { out.status = code; return this; }, set() { return this; }, type() { return this; }, send() {} }; gate(req, res, () => { out.next = true; }); return out; };
  const remote = { headers: { host: 'client.example.test' }, socket: { remoteAddress: '203.0.113.9' }, session: {}, method: 'GET', path: '/' };
  assert.equal(run(remote).next, true);
  for (mode of ['local', 'unset']) {
    assert.equal(run(remote).status, 404, `${mode}: remote address`);
    assert.equal(run(loopbackRequest({ headers: { host: 'client.example.test' } })).status, 404, `${mode}: DNS rebinding Host`);
    assert.equal(run(loopbackRequest({ headers: { host: '127.0.0.1:3000', 'x-forwarded-for': '203.0.113.9' } })).status, 404, `${mode}: forwarded through a tunnel/proxy`);
    assert.equal(upgradeAllowed(remote, mode), false);
    assert.equal(upgradeAllowed(loopbackRequest(), mode), true);
  }
  mode = 'local';
  const local = loopbackRequest();
  assert.equal(run(local).next, true);
  assert.equal(local.session.localTrusted, true, 'local requests become trusted sessions');
  mode = 'unset';
  const unset = loopbackRequest();
  assert.equal(run(unset).next, true);
  assert.equal(unset.session.localTrusted, undefined, 'unset mode does not grant trust');
  assert.equal(upgradeAllowed(remote, 'remote'), true);
});

// ---- 真实服务：首次选择、仅本机模式、切换 ----
async function startServer(t, extraEnv = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-access-mode-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', SESSION_SECRET: 'access-mode-test-secret-'.repeat(3), T_AGENT_DATA_DIR: temp, T_AGENT_DB_PATH: path.join(temp, 'db.sqlite'), TASKS_BASE_DIR: path.join(temp, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false', ACCESS_MODE: '', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) await new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); });
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const { port } = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`startup timed out: ${output}`)), 8000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`exited: ${output}`)); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => { output += chunk; const m = output.match(/Server running at http:\/\/localhost:(\d+)/); if (m) { clearTimeout(timer); resolve({ port: Number(m[1]) }); } });
  });
  const raw = (route, { method, body, cookie, host } = {}) => new Promise((resolve, reject) => {
    const headers = { Host: host || `127.0.0.1:${port}`, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } : {}) };
    const request = http.request({ host: '127.0.0.1', port, path: route, method: method || (body ? 'POST' : 'GET'), headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: response.statusCode, headers: response.headers, text, json, cookie: (response.headers['set-cookie'] || [])[0]?.split(';')[0] });
      });
    });
    request.on('error', reject);
    request.end(body ? JSON.stringify(body) : undefined);
  });
  return { raw, port };
}
const LOGIN = '/torin/hide/login';

test('全新安装：非本机一律 404；本机选“仅本机访问”后无需验证即可使用', { timeout: 30000 }, async t => {
  const { raw } = await startServer(t);
  assert.equal((await raw(`${LOGIN}/status`)).json.mode, 'unset');
  for (const route of ['/', '/web', `${LOGIN}/status`, '/api/tasks', '/v1/info', '/health']) {
    assert.equal((await raw(route, { host: 'client.example.test' })).status, 404, `uninitialized, non-local: ${route}`);
  }
  // 非本机不能替用户选择；本机选择生效。
  const attacker = await raw(`${LOGIN}/mode`, { body: { mode: 'local' }, host: 'client.example.test' });
  assert.equal(attacker.status, 404);
  assert.equal((await raw(`${LOGIN}/mode`, { body: { mode: 'bogus' } })).json.error, 'INVALID_ACCESS_MODE');
  const chosen = await raw(`${LOGIN}/mode`, { body: { mode: 'local' } });
  assert.equal(chosen.status, 200);
  assert.deepEqual(chosen.json, { mode: 'local', redirect: '/web' });
  const cookie = chosen.cookie;
  assert.ok(cookie);

  // 无需验证：页面、接口、设置信息都可用。
  assert.equal((await raw('/web', { cookie })).status, 200);
  assert.equal((await raw('/api/tasks', { cookie })).status, 200);
  const me = (await raw('/auth/me', { cookie })).json;
  assert.equal(me.access_mode, 'local');
  assert.equal(me.authenticator_bound, false);
  // 即使本机，Host 不是回环名（DNS rebinding）或经代理转发也不行。
  assert.equal((await raw('/web', { cookie, host: 'client.example.test' })).status, 404);
  assert.equal((await raw('/api/tasks', { cookie, host: 'evil.test:3000' })).status, 404);
  assert.equal((await raw('/v1/info', { host: 'client.example.test' })).status, 404);
});

test('仅本机 → 身份验证器 + 外网：先绑定，绑定成功才开放外网；再切回仅本机会立即断开', { timeout: 40000 }, async t => {
  const { raw } = await startServer(t, { ACCESS_MODE: 'local' });
  const first = await raw('/web');
  assert.equal(first.status, 200, 'seeded local mode needs no choice and no login');
  const cookie = first.cookie;
  assert.equal((await raw('/api/tasks', { cookie, host: 'client.example.test' })).status, 404, 'still local-only');

  const needBinding = await raw('/auth/mode', { cookie, body: { mode: 'remote' } });
  assert.equal(needBinding.status, 409);
  assert.equal(needBinding.json.error, 'AUTHENTICATOR_BINDING_REQUIRED');
  assert.equal((await raw('/auth/status', { cookie })).json.mode, 'local', 'not switched until binding completes');

  const start = await raw(`${LOGIN}/setup/start`, { cookie, body: {} });
  assert.equal(start.status, 200);
  const confirm = await raw(`${LOGIN}/setup/confirm`, { cookie: start.cookie || cookie, body: { code: totp(start.json.secret, Math.floor(Date.now() / 30000)) } });
  assert.equal(confirm.status, 200);
  const remoteCookie = confirm.cookie;

  // 现在是 remote：外网 Host 能到达登录页，但没登录仍看不到任何功能。
  assert.equal((await raw(`${LOGIN}/status`, { host: 'client.example.test' })).json.mode, 'remote');
  assert.equal((await raw('/api/tasks', { host: 'client.example.test' })).status, 404);
  assert.equal((await raw('/api/tasks', { cookie: remoteCookie, host: 'client.example.test' })).status, 200);
  // 旧的“本机可信”会话在 remote 下不再有效。
  assert.equal((await raw('/api/tasks', { cookie, host: 'client.example.test' })).status, 404);

  // remote → local：需要已登录；切换后外网立即 404。
  assert.equal((await raw('/auth/mode', { body: { mode: 'local' } })).status, 404, 'login gate hides it from anonymous visitors');
  const back = await raw('/auth/mode', { cookie: remoteCookie, body: { mode: 'local' }, host: 'client.example.test' });
  assert.equal(back.status, 200);
  assert.equal(back.json.locked_out, true, 'a non-local browser is told it will lose access');
  assert.equal((await raw('/api/tasks', { cookie: remoteCookie, host: 'client.example.test' })).status, 404);
  assert.equal((await raw('/api/tasks', { cookie: remoteCookie })).status, 200, 'the same browser on the machine itself still works');
});
