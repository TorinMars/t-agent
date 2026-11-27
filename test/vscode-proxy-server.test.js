'use strict';
// VS Code in the browser in the real server.js (a test server on a free port with its own data folder): /vscode/ sits before the session and the login
// gate, answers the login gate's 404 without its cookie (logged in or not, HTTP and WebSocket), never sets the page's session cookie, and leaves /api as
// it was. The launch itself needs the engine's VS Code manager and is covered in test/vscode-proxy.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { totp } = require('../services/client-auth');

const LOGIN = '/torin/hide/login';

test('the /vscode mount in server.js: the same 404 without its cookie, no page session, /api unchanged', { timeout: 30000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-vscode-server-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', SESSION_SECRET: 'vscode-server-test-secret-'.repeat(3), T_AGENT_DATA_DIR: temp, T_AGENT_DB_PATH: path.join(temp, 'db.sqlite'), TASKS_BASE_DIR: path.join(temp, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) await new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); });
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`startup timed out: ${output}`)), 15000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`exited: ${output}`)); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Server running at http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (route, { cookie, body, method, headers = {} } = {}) => {
    const response = await fetch(base + route, {
      method: method || (body ? 'POST' : 'GET'), redirect: 'manual',
      headers: { 'X-Requested-With': 'XMLHttpRequest', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, text, headers: response.headers, cookie: (/(?:^|[,\s])(connect\.sid=[^;]+)/.exec(response.headers.get('set-cookie') || '') || [])[1] };
  };
  const shape = answer => ({ status: answer.status, text: answer.text.replace(/Cannot (GET|POST) \S+/, 'Cannot $1 <path>'), type: answer.headers.get('content-type'), csp: answer.headers.get('content-security-policy'), vary: answer.headers.get('vary') });

  // Logged out: the same 404 as any closed address, and no session cookie.
  const closed = shape(await call('/api/tasks'));
  assert.equal(closed.status, 404);
  for (const route of ['/vscode/engine-1/', '/vscode/engine-1/?folder=%2Ftmp&ta_launch=tvl_made-up', '/vscode/engine-1/static/a.js']) {
    const answer = await call(route, { headers: { accept: 'text/html' } });
    assert.deepEqual(shape(answer), closed, route);
    assert.equal(answer.headers.get('set-cookie'), null, `${route} sets no cookie`);
  }

  // Log in (the authenticator is bound on this machine), then the page session is not a VS Code credential.
  const start = await call(`${LOGIN}/setup/start`, { body: {} });
  const confirm = await call(`${LOGIN}/setup/confirm`, { cookie: start.cookie, body: { code: totp(JSON.parse(start.text).secret, Math.floor(Date.now() / 30000)) } });
  assert.equal(confirm.status, 200, confirm.text);
  const session = confirm.cookie;
  assert.equal((await call('/api/tasks', { cookie: session })).status, 200, '/api works with the session');
  const signedIn = await call('/vscode/engine-1/', { cookie: session, headers: { accept: 'text/html' } });
  assert.equal(signedIn.status, 404, 'not the redirect home a logged-in page visit to an unknown address gets');
  assert.equal(signedIn.headers.get('set-cookie'), null, 'the session is neither touched nor renewed');
  assert.equal(shape(signedIn).text, closed.text);

  // The start route without the engine's manager in this build fails with a code, not a stack or a path.
  const created = await call('/api/tasks', { cookie: session, body: { title: 'vscode wiring' } });
  assert.equal(created.status, 201, created.text);
  const task = JSON.parse(created.text);
  const launch = await call(`/api/tasks/${task.id}/terminals/default/vscode`, { cookie: session, body: {} });
  assert.match(JSON.parse(launch.text).error, /^[A-Z0-9_]+$/);

  // WebSocket: with the session but without the VS Code cookie, the same refusal as an unknown address.
  const status = await new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/vscode/engine-1/ws`, { origin: base, headers: { Cookie: session } });
    ws.on('unexpected-response', (req, res) => { res.resume(); resolve(res.statusCode); });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('error', () => {});
  });
  assert.equal(status, 404);
});
