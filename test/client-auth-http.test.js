const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('node:http');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { totp, SESSION_TTL } = require('../services/client-auth');

for (const environment of ['test', 'production']) test(`Web/H5 HTTP and WebSocket authentication cannot be bypassed (${environment})`, { timeout: 20000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-client-auth-test-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', NODE_ENV: environment, SESSION_SECRET: 'integration-test-secret-'.repeat(3), T_AGENT_DATA_DIR: temp, T_AGENT_DB_PATH: path.join(temp, 'db.sqlite'), TASKS_BASE_DIR: path.join(temp, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) await new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); });
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const startup = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Client startup timed out')), 8000);
    child.once('error', reject);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Client exited before becoming ready')); });
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      const port = output.match(/Server running at http:\/\/localhost:(\d+)/);
      if (port) { clearTimeout(timer); resolve({ port: Number(port[1]) }); }
    });
  });
  const base = `http://127.0.0.1:${startup.port}`;
  async function call(route, { cookie, body, headers = {}, method } = {}) {
    const options = { method: method || (body ? 'POST' : 'GET'), headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } : {}), ...headers } };
    // Fetch normalizes Host; raw HTTP is needed to test DNS rebinding and proxies.
    if (headers.Host) return new Promise((resolve, reject) => {
      const request = http.request(base + route, options, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
      });
      request.on('error', reject);
      request.end(body ? JSON.stringify(body) : undefined);
    });
    return fetch(base + route, { redirect: 'manual', ...options, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  function cookieOf(response) { return response.headers.get('set-cookie').split(';')[0]; }
  async function rejectWs(route, origin, expected) {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(base.replace('http:', 'ws:') + route, { origin });
      ws.on('error', () => {});
      ws.on('open', () => { ws.terminate(); reject(new Error('Unauthenticated WebSocket was accepted')); });
      ws.on('unexpected-response', (_, response) => { assert.equal(response.statusCode, expected); response.resume(); ws.terminate(); resolve(); });
    });
  }
  for (const route of ['/', '/web', '/h5']) {
    const response = await call(route);
    assert.equal(response.status, 302);
    assert.match(response.headers.get('location'), /^\/auth\/setup\?/);
  }
  assert.equal((await call('/index%2ehtml')).status, 302);
  for (const route of ['/api/tasks', '/api/local-ip', '/api/system/version', '/auth/me']) {
    const response = await call(route);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'AUTHENTICATOR_BINDING_REQUIRED');
  }
  assert.equal((await call('/auth/login', { body: { username: 'local', password: '' } })).status, 403);
  assert.equal((await call('/auth/setup/start', { body: {}, headers: { Origin: 'https://attacker.test' } })).status, 403);
  assert.deepEqual(await (await call('/auth/status')).json(), { bound: false, authenticated: false, local_setup_allowed: true });
  for (const headers of [{ Host: 'client.example.test' }, { 'X-Forwarded-For': '127.0.0.1' }, { 'X-Real-IP': '127.0.0.1' }, { Forwarded: 'for=127.0.0.1' }]) {
    assert.equal((await (await call('/auth/status', { headers })).json()).local_setup_allowed, false);
    const response = await call('/auth/setup/start', { body: { local_setup_allowed: true, initialization_code: 'anything' }, headers });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'AUTH_INITIALIZATION_LOCAL_ONLY');
  }
  await rejectWs('/terminal/ws?taskId=1', base, 401);
  await rejectWs('/api/remote-servers/1/terminal/ws?taskId=1', base, 401);
  await rejectWs('/terminal/ws?taskId=1', 'https://attacker.test', 403);
  const protocol = await call('/api/remote/v1/capabilities');
  assert.equal((await protocol.json()).error, 'REMOTE_TOKEN_REQUIRED');
  assert.equal((await call('/v1/info')).status, 401);

  const startResponse = await call('/auth/setup/start', { body: {} });
  assert.equal(startResponse.status, 200);
  const setupCookie = cookieOf(startResponse);
  const setup = await startResponse.json();
  assert.match(setup.qr, /^data:image\/png;base64,/);
  const remoteConfirm = await call('/auth/setup/confirm', { cookie: setupCookie, headers: { Host: 'client.example.test' }, body: { code: totp(setup.secret, Math.floor(Date.now() / 30000)) } });
  assert.equal(remoteConfirm.status, 403);
  assert.equal((await remoteConfirm.json()).error, 'AUTH_INITIALIZATION_LOCAL_ONLY');
  assert.equal((await (await call('/auth/status')).json()).bound, false);
  const confirmResponse = await call('/auth/setup/confirm', { cookie: setupCookie, body: { code: totp(setup.secret, Math.floor(Date.now() / 30000)), return_to: '/h5' } });
  assert.equal(confirmResponse.status, 200);
  assert.match(confirmResponse.headers.get('set-cookie'), /SameSite=Strict/);
  assert.doesNotMatch(confirmResponse.headers.get('set-cookie'), /; Secure/);
  const boundCookie = cookieOf(confirmResponse);
  assert.notEqual(boundCookie, setupCookie);
  const confirmed = await confirmResponse.json();
  assert.equal(confirmed.recovery_codes.length, 8);
  assert.equal(confirmed.redirect, '/h5');
  assert.equal((await call('/api/tasks')).status, 401);
  assert.equal((await call('/api/tasks', { cookie: setupCookie })).status, 401);
  const meResponse = await call('/auth/me', { cookie: boundCookie });
  assert.equal(meResponse.status, 200);
  const refreshedCookie = meResponse.headers.get('set-cookie');
  assert.ok(refreshedCookie, 'active HTTP request reissues the rolling cookie');
  const expiry = Date.parse(refreshedCookie.match(/Expires=([^;]+)/)[1]);
  assert.ok(Math.abs(expiry - Date.now() - SESSION_TTL) < 5000, 'cookie lasts 30 days from this request');
  const h5 = await call('/h5', { cookie: boundCookie });
  assert.equal(h5.status, 200);
  const h5Html = await h5.text();
  assert.match(h5Html, /<body class="h5-client">/);
  assert.doesNotMatch(h5Html, /src="\/vendor\/monaco\/monaco.js"/);
  assert.equal(h5.headers.get('cache-control'), 'no-store');
  const web = await call('/web', { cookie: boundCookie });
  assert.doesNotMatch(await web.text(), /<body class="h5-client">/);
  const phone = await call('/', { cookie: boundCookie, headers: { 'User-Agent': 'iPhone Mobile' } });
  assert.equal(phone.headers.get('location'), '/h5');
  assert.equal((await call('/index.html')).headers.get('location'), '/web');
  assert.equal((await call('/auth/settings', { cookie: boundCookie, body: { work_dir: null }, method: 'PUT', headers: { Origin: 'https://attacker.test' } })).status, 403);

  const loginResponse = await call('/auth/login', { body: { code: confirmed.recovery_codes[0], return_to: '/h5' } });
  assert.equal(loginResponse.status, 200);
  const recoveryCookie = cookieOf(loginResponse);
  assert.equal((await call('/auth/login', { body: { code: confirmed.recovery_codes[0] } })).status, 401);
  const replacementResponse = await call('/auth/setup/start', { cookie: recoveryCookie, body: {} });
  const replacement = await replacementResponse.json();
  assert.equal(replacement.replacing, true);
  const replacementConfirmed = await call('/auth/setup/confirm', { cookie: recoveryCookie, body: { code: totp(replacement.secret, Math.floor(Date.now() / 30000)) } });
  assert.equal(replacementConfirmed.status, 200);
  const newCookie = cookieOf(replacementConfirmed);
  const replacementResult = await replacementConfirmed.json();
  const httpsLogin = await call('/auth/login', { body: { code: replacementResult.recovery_codes[0] }, headers: { Host: 'client.example.test', 'X-Forwarded-Proto': 'https' } });
  assert.equal(httpsLogin.status, 200);
  assert.match(httpsLogin.headers.get('set-cookie'), /; Secure/);
  if (environment === 'production') {
    const httpLogin = await call('/auth/login', { body: { code: replacementResult.recovery_codes[1] }, headers: { Host: 'client.example.test' } });
    assert.equal(httpLogin.status, 200);
    assert.equal(httpLogin.headers.get('set-cookie'), null);
  }
  assert.equal((await call('/auth/me', { cookie: boundCookie })).status, 401);
  assert.equal((await call('/auth/logout', { cookie: newCookie, body: {} })).status, 200);
  assert.equal((await call('/auth/me', { cookie: newCookie })).status, 401);
});
