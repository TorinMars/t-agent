const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('node:http');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');
const { totp, SESSION_TTL } = require('../services/client-auth');

test('Client HTTP opt-in requires the exact true environment value', () => {
  for (const value of ['', 'false', 'TRUE', '1', 'true']) {
    const result = spawnSync(process.execPath, ['-e', "process.stdout.write(String(require('./config').clientAllowHttp))"], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, CLIENT_ALLOW_HTTP: value }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, String(value === 'true'));
  }
});

for (const [environment, allowHttp] of [['test', 'false'], ['production', 'false'], ['production', 'true']]) test(`Desktop HTTP and WebSocket authentication cannot be bypassed (${environment}, HTTP ${allowHttp})`, { timeout: 20000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-client-auth-test-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', NODE_ENV: environment, CLIENT_ALLOW_HTTP: allowHttp, SESSION_SECRET: 'integration-test-secret-'.repeat(3), T_AGENT_DATA_DIR: temp, T_AGENT_DB_PATH: path.join(temp, 'db.sqlite'), TASKS_BASE_DIR: path.join(temp, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false' },
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
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Client exited before becoming ready: ${output}`)); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
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
  for (const route of ['/', '/web']) {
    const response = await call(route);
    assert.equal(response.status, 302);
    assert.match(response.headers.get('location'), /^\/auth\/setup\?/);
  }
  assert.equal((await call('/index%2ehtml')).status, 302);
  for (const route of ['/api/tasks', '/api/local-ip', '/api/system/version', '/api/oss/config', '/auth/me']) {
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
  assert.equal(confirmed.redirect, '/web');
  assert.equal((await call('/api/tasks')).status, 401);
  assert.equal((await call('/api/oss/config')).status, 401);
  assert.equal((await call('/api/oss/images', { body: {} })).status, 401);
  assert.equal((await call('/api/tasks', { cookie: setupCookie })).status, 401);
  const meResponse = await call('/auth/me', { cookie: boundCookie });
  assert.equal(meResponse.status, 200);
  assert.equal((await meResponse.json()).effective_work_dir, path.join(temp, 'tasks'));
  const customWorkDir = path.join(temp, 'custom-tasks');
  assert.equal((await call('/auth/settings', { cookie: boundCookie, method: 'PUT', body: { work_dir: customWorkDir } })).status, 200);
  const customSettings = await (await call('/auth/me', { cookie: boundCookie })).json();
  assert.equal(customSettings.work_dir, customWorkDir);
  assert.equal(customSettings.effective_work_dir, customWorkDir);
  assert.equal((await call('/auth/settings', { cookie: boundCookie, method: 'PUT', body: { work_dir: null } })).status, 200);
  assert.equal((await (await call('/auth/me', { cookie: boundCookie })).json()).effective_work_dir, path.join(temp, 'tasks'));

  // A full Client also serves the standard Engine protocol on the same port.
  const pairingResponse = await call('/api/remote-tokens/pairing', { cookie: boundCookie, body: { role: 'operator' } });
  assert.equal(pairingResponse.status, 201);
  const pairing = await pairingResponse.json();
  const exchange = await call('/v1/pair', { body: { code: pairing.code, client_name: 'Another Client' } });
  assert.equal(exchange.status, 201);
  const access = await exchange.json();
  const engineHeaders = { Authorization: `Bearer ${access.access_token}` };
  assert.equal((await call('/v1/pair', { body: { code: pairing.code } })).status, 400);
  const engineInfo = await call('/v1/info', { headers: engineHeaders });
  assert.equal(engineInfo.status, 200);
  assert.equal((await engineInfo.json()).role, 'operator');
  const createdResponse = await call('/v1/tasks', { headers: engineHeaders, body: { title: 'Created by another Client', work_dir: path.join(temp, 'remote-created') } });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const localTasks = await (await call('/api/tasks', { cookie: boundCookie })).json();
  assert.ok(localTasks.some(task => task.id === created.id), 'Engine and Client share the local task owner');
  assert.equal((await call(`/v1/tasks/${created.id}`, { method: 'DELETE', headers: engineHeaders })).status, 200);
  const tokens = await (await call('/api/remote-tokens', { cookie: boundCookie })).json();
  const token = tokens.find(item => item.name === 'Another Client');
  assert.ok(token);
  assert.equal((await call(`/api/remote-tokens/${token.id}`, { method: 'DELETE', cookie: boundCookie, headers: { 'X-Requested-With': 'XMLHttpRequest' } })).status, 200);
  assert.equal((await call('/v1/info', { headers: engineHeaders })).status, 401);

  const refreshedCookie = meResponse.headers.get('set-cookie');
  assert.ok(refreshedCookie, 'active HTTP request reissues the rolling cookie');
  const expiry = Date.parse(refreshedCookie.match(/Expires=([^;]+)/)[1]);
  assert.ok(Math.abs(expiry - Date.now() - SESSION_TTL) < 5000, 'cookie lasts 30 days from this request');
  for (const route of ['/h5', '/h5.html']) {
    const legacy = await call(route, { cookie: boundCookie });
    assert.equal(legacy.status, 302);
    assert.equal(legacy.headers.get('location'), '/web');
  }
  const web = await call('/web', { cookie: boundCookie });
  const webHtml = await web.text();
  assert.match(webHtml, /width=1280, user-scalable=yes/);
  assert.doesNotMatch(webHtml, /mobile-client|h5-client|mobile\.js|mobile\.css/);
  assert.match(webHtml, /src="\/vendor\/monaco\/monaco.js/);
  assert.equal(web.headers.get('cache-control'), 'no-store');
  const phone = await call('/', { cookie: boundCookie, headers: { 'User-Agent': 'iPhone Mobile' } });
  assert.equal(phone.status, 200);
  assert.match(await phone.text(), /width=1280, user-scalable=yes/);
  assert.equal((await call('/index.html')).headers.get('location'), '/web');
  assert.equal((await call('/auth/settings', { cookie: boundCookie, body: { work_dir: null }, method: 'PUT', headers: { Origin: 'https://attacker.test' } })).status, 403);

  const loginHeaders = allowHttp === 'true' ? { Host: 'client.example.test', Origin: 'http://client.example.test' } : {};
  const loginResponse = await call('/auth/login', { headers: loginHeaders, body: { code: confirmed.recovery_codes[0], return_to: '/h5' } });
  assert.equal(loginResponse.status, 200);
  assert.match(loginResponse.headers.get('set-cookie'), /HttpOnly/);
  assert.match(loginResponse.headers.get('set-cookie'), /SameSite=Strict/);
  assert.doesNotMatch(loginResponse.headers.get('set-cookie'), /; Secure/);
  const recoveryCookie = cookieOf(loginResponse);
  if (allowHttp === 'true') {
    // A browser can store this cookie on a non-loopback HTTP origin and reuse it.
    for (const route of ['/auth/me', '/api/tasks', '/web']) {
      const response = await call(route, { cookie: recoveryCookie, headers: loginHeaders });
      assert.equal(response.status, 200);
      assert.ok(response.headers.get('set-cookie'), 'rolling HTTP cookie remains usable');
      assert.doesNotMatch(response.headers.get('set-cookie'), /; Secure/);
    }
    assert.equal((await call('/auth/settings', { cookie: recoveryCookie, method: 'PUT', body: { work_dir: null }, headers: { ...loginHeaders, Origin: 'http://attacker.test' } })).status, 403);
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(base.replace('http:', 'ws:') + '/terminal/ws', {
        origin: loginHeaders.Origin, headers: { Host: loginHeaders.Host, Cookie: recoveryCookie },
      });
      ws.on('error', reject);
      ws.on('unexpected-response', (_, response) => { response.resume(); ws.terminate(); reject(new Error(`Authenticated WebSocket rejected: ${response.statusCode}`)); });
      // No task requested: reaching the terminal handler proves session authentication.
      ws.on('close', (code, reason) => { assert.equal(code, 1008); assert.equal(reason.toString(), 'missing taskId'); resolve(); });
    });
    await rejectWs('/v1/terminal-sessions/1/stream?ticket=invalid', loginHeaders.Origin, 401);
  }
  assert.equal((await call('/auth/login', { body: { code: confirmed.recovery_codes[0] } })).status, 401);
  const replacementResponse = await call('/auth/setup/start', { cookie: recoveryCookie, headers: loginHeaders, body: {} });
  assert.equal(replacementResponse.status, 200);
  assert.ok(replacementResponse.headers.get('set-cookie'));
  assert.doesNotMatch(replacementResponse.headers.get('set-cookie'), /; Secure/);
  const replacement = await replacementResponse.json();
  assert.equal(replacement.replacing, true);
  const replacementConfirmed = await call('/auth/setup/confirm', { cookie: recoveryCookie, headers: loginHeaders, body: { code: totp(replacement.secret, Math.floor(Date.now() / 30000)) } });
  assert.equal(replacementConfirmed.status, 200);
  assert.ok(replacementConfirmed.headers.get('set-cookie'));
  assert.doesNotMatch(replacementConfirmed.headers.get('set-cookie'), /; Secure/);
  const newCookie = cookieOf(replacementConfirmed);
  assert.equal((await call('/auth/me', { cookie: newCookie, headers: loginHeaders })).status, 200);
  const replacementResult = await replacementConfirmed.json();
  const httpsLogin = await call('/auth/login', { body: { code: replacementResult.recovery_codes[0] }, headers: { Host: 'client.example.test', 'X-Forwarded-Proto': 'https' } });
  assert.equal(httpsLogin.status, 200);
  assert.match(httpsLogin.headers.get('set-cookie'), /; Secure/);
  if (environment === 'production' && allowHttp !== 'true') {
    const httpLogin = await call('/auth/login', { body: { code: replacementResult.recovery_codes[1] }, headers: { Host: 'client.example.test' } });
    assert.equal(httpLogin.status, 200);
    assert.equal(httpLogin.headers.get('set-cookie'), null);
  }
  assert.equal((await call('/auth/me', { cookie: boundCookie })).status, 401);
  assert.equal((await call('/auth/logout', { cookie: newCookie, body: {} })).status, 200);
  assert.equal((await call('/auth/me', { cookie: newCookie })).status, 401);
});
