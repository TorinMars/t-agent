const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseFrameOrigins, frameAncestors, clientCookieSameSite } = require('../lib/client-embedding');
const { totp } = require('../services/client-auth');

test('embedding requires explicit origins; wildcards, credentials and CSP injection are rejected', () => {
  assert.deepEqual(parseFrameOrigins(), []);
  assert.deepEqual(parseFrameOrigins(' https://Hub.Example.com:443, http://localhost:3000,https://hub.example.com '), ['https://hub.example.com', 'http://localhost:3000']);
  for (const value of ['*', 'https://*.example.com', 'javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com/clients', 'https://example.com?x=y', "https://example.com; script-src *"]) {
    assert.throws(() => parseFrameOrigins(value), /CLIENT_FRAME_ORIGINS/);
  }
  assert.equal(frameAncestors([]), "frame-ancestors 'self'");
  assert.equal(clientCookieSameSite({ secure: true }, []), 'strict');
  assert.equal(clientCookieSameSite({ secure: false }, ['https://hub.example.com']), 'strict');
  assert.equal(clientCookieSameSite({ secure: true }, ['https://hub.example.com']), 'none');
});

test('switcher is public, embedded Clients still authenticate and HTTPS cookies honor explicit opt-in', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-embedding-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'production', SESSION_SECRET: 'embedding-test-secret-'.repeat(3), T_AGENT_DATA_DIR: dir, T_AGENT_DB_PATH: path.join(dir, 'db.sqlite'), TASKS_BASE_DIR: path.join(dir, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false', CLIENT_ALLOW_HTTP: 'false', CLIENT_FRAME_ORIGINS: 'https://hub.example.com', CLIENT_SESSION_COOKIE_NAME: 'embedding-client.sid' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) await new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${output}`)), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(output)); });
    child.stderr.on('data', data => { output += data; });
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/Server running at http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  async function call(route, { body, cookie, headers = {} } = {}) {
    return fetch(base + route, { redirect: 'manual', method: body ? 'POST' : 'GET', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  for (const route of ['/clients', '/clients.html']) {
    const response = await call(route);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(await response.text(), /client-workspace/);
  }
  const embedded = await call('/web', { headers: { 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(embedded.status, 200);
  assert.equal(embedded.headers.get('content-security-policy'), "frame-ancestors 'self' https://hub.example.com");
  assert.match(await embedded.text(), /data-client-frame="auth-required"/);
  assert.equal((await call('/web')).status, 302);
  assert.equal((await call('/api/tasks')).status, 403);
  const authPage = await call('/auth/login');
  assert.match(authPage.headers.get('content-security-policy'), /frame-ancestors 'none'/);

  const start = await call('/auth/setup/start', { body: {} });
  assert.equal(start.status, 200);
  const setup = await start.json();
  const confirmation = await call('/auth/setup/confirm', { cookie: start.headers.get('set-cookie').split(';')[0], body: { code: totp(setup.secret, Math.floor(Date.now() / 30000)) } });
  assert.equal(confirmation.status, 200);
  const recovery = (await confirmation.json()).recovery_codes[0];
  assert.match(confirmation.headers.get('set-cookie'), /SameSite=Strict/);
  assert.match(confirmation.headers.get('set-cookie'), /^embedding-client\.sid=/);
  const cookie = confirmation.headers.get('set-cookie').split(';')[0];
  const ready = await call('/web', { cookie, headers: { 'Sec-Fetch-Dest': 'iframe', 'X-Forwarded-Proto': 'https' } });
  assert.equal(ready.status, 200);
  assert.match(await ready.text(), /\/js\/client-frame.js\?v=/);
  assert.match(ready.headers.get('set-cookie'), /SameSite=None/);
  assert.match(ready.headers.get('set-cookie'), /; Secure/);
  const login = await call('/auth/login', { body: { code: recovery }, headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /SameSite=None/);
  assert.match(login.headers.get('set-cookie'), /; Secure/);
  for (const headers of [{ Origin: 'https://hub.example.com' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await call('/api/tasks', { cookie, headers });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'CLIENT_ORIGIN_REQUIRED');
  }
  assert.equal((await call('/api/tasks', { cookie })).status, 200);
  const logout = await call('/auth/logout', { cookie, body: {} });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /^embedding-client\.sid=;/);
  assert.equal((await call('/api/tasks', { cookie })).status, 401);
});
