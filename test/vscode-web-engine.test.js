// "Open in VS Code" on the engine, through the real /v1 router (routes/engine-v1.js, routes/vscode-web-engine.js): Contract A (status, start,
// license, stop, settings) and Contract B (the proxied HTTP and WebSocket traffic) of docs/design/vscode-web.md. VS Code is the fake CLI of
// test-support/fake-vscode-cli.js (VSCODE_CLI_PATH points at a `code` shim in a temp folder): no real VS Code, no download, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tvse-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'vscode-web-engine-test-secret-vscode-web-engine-test';
const { writeCodeShim } = require('../test-support/fake-vscode-cli');
// The engine's own finder takes VSCODE_CLI_PATH first, so the real `code` of this machine is never looked at.
process.env.VSCODE_CLI_PATH = writeCodeShim(path.join(root, 'bin'));
for (const name of Object.keys(process.env)) if (name.startsWith('FAKE_VSCODE_')) delete process.env[name];

const express = require('express');
const WebSocket = require('ws');
const db = require('../db');
const { createAccessToken } = require('../services/engine-auth');
const { getServiceLinks } = require('../services/service-links');
const { getVscodeWeb } = require('../services/vscode-web');
const { handleVscodeUpgrade, authorizeBearer, parseWebTarget } = require('../routes/vscode-web-engine');

const WORK = path.join(root, 'tasks', 'project');
const SUB = path.join(WORK, 'sub');
fs.mkdirSync(SUB, { recursive: true });
const OWNER = 'owner';
const PUBLIC_HOST = 't.example.com';
const HOST_B64 = Buffer.from(PUBLIC_HOST).toString('base64url');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let base;
let port;
let token;
let linkToken;
let taskId;
let hiddenTaskId;
let terminalId;
const servers = [];

test.before(async () => {
  token = createAccessToken(db, { principalId: OWNER }).token;
  const link = createAccessToken(db, { principalId: OWNER, name: 'Service link: peer' });
  linkToken = link.token;
  taskId = Number(db.prepare('INSERT INTO tasks (title, user_id, work_dir) VALUES (?, ?, ?)').run('Project', OWNER, WORK).lastInsertRowid);
  hiddenTaskId = Number(db.prepare('INSERT INTO tasks (title, user_id, work_dir) VALUES (?, ?, ?)').run('Hidden', OWNER, WORK).lastInsertRowid);
  // A terminal of its own directory: VS Code opens that one, not the task's.
  terminalId = require('../routes/terminal').createTerminal(taskId, {}).terminal_id;
  db.prepare('UPDATE task_terminals SET work_dir = ? WHERE task_id = ? AND terminal_id = ?').run(SUB, taskId, terminalId);
  // One service link whose token is `link`, which may not see the hidden task (services/task-visibility.js reads this row on first use).
  const links = getServiceLinks();
  links.linkForToken = id => (Number(id) === link.id ? { id: 'L1', name: 'peer' } : null);
  links.ids = () => ['L1'];
  db.prepare("INSERT INTO system_state (key, value) VALUES ('task_link_visibility_v1', ?)").run(JSON.stringify({ [hiddenTaskId]: ['L1'] }));

  const app = express();
  const OWN = /^\/v1\/vscode(?:\/|$)/i; // as server.js OWN_PARSERS: the proxied bodies are streamed, not parsed
  app.use((req, res, next) => (OWN.test(req.path) ? next() : express.json({ limit: '32mb' })(req, res, next)));
  app.use('/v1', require('../routes/engine-v1'));
  const server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => {
    if (/^\/v1\/vscode\/web\//i.test(new URL(req.url, 'http://x').pathname)) return handleVscodeUpgrade(req, socket, head);
    return socket.destroy();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  await getVscodeWeb().stop();
  for (const server of servers) server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function call(method, route, { body, auth = token, headers = {}, raw = false } = {}) {
  const response = await fetch(base + route, {
    method,
    headers: { ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  let parsed = buffer.toString('utf8');
  if (!raw) { try { parsed = JSON.parse(parsed); } catch { /* text */ } }
  return { status: response.status, headers: response.headers, body: parsed };
}
const vscodeRoute = (task = taskId, terminal = terminalId) => `/v1/tasks/${task}/terminals/${terminal}/vscode`;
const web = rest => `/v1/vscode/web/${HOST_B64}${rest}`;
async function untilReady() {
  for (let i = 0; i < 400; i += 1) {
    const answer = await call('GET', vscodeRoute());
    if (answer.body.state === 'ready') return answer.body;
    if (answer.body.state === 'error') throw new Error(`VS Code failed: ${JSON.stringify(answer.body)}`);
    await sleep(25);
  }
  throw new Error('VS Code did not become ready');
}

test('/v1/info lists vscode:web', async () => {
  const info = await call('GET', '/v1/info');
  assert.ok(info.body.capabilities.includes('vscode:web'));
});

test('the parsing of /v1/vscode/web/<hostB64>/<rest>', () => {
  assert.deepEqual(parseWebTarget(`/${HOST_B64}/static/a.txt?x=1`), { host: PUBLIC_HOST, rest: '/static/a.txt?x=1' });
  assert.deepEqual(parseWebTarget(`/${HOST_B64}`), { host: PUBLIC_HOST, rest: '/' });
  assert.deepEqual(parseWebTarget(`/${HOST_B64}?folder=%2Fa`), { host: PUBLIC_HOST, rest: '/?folder=%2Fa' });
  assert.equal(parseWebTarget(`/${Buffer.from('evil.com/x').toString('base64url')}/`), null);
  assert.equal(parseWebTarget(`/${Buffer.from('a b').toString('base64url')}/`), null);
  assert.equal(parseWebTarget('/not+base64/'), null);
});

test('authentication: 401 without a token or with a bad one, on every route and on the upgrade; 403 without terminal:execute', async () => {
  for (const [method, route] of [['GET', vscodeRoute()], ['POST', vscodeRoute()], ['POST', `${vscodeRoute()}/accept-license`], ['POST', '/v1/vscode/stop'],
    ['GET', web('/')], ['POST', web('/echo')], ['GET', '/v1/vscode/settings']]) {
    assert.equal((await call(method, route, { auth: null })).status, 401, `${method} ${route}`);
    assert.equal((await call(method, route, { auth: 'tae_wrong' })).status, 401, `${method} ${route}`);
  }
  const refused = await new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${web('/ws')}`);
    ws.once('unexpected-response', (req, res) => resolve(res.statusCode));
    ws.once('error', () => {});
  });
  assert.equal(refused, 401);
  // Every token of today has all scopes (services/engine-auth.js); the scope check itself, with a token that lacks terminal:execute.
  const lookup = value => (value === 'limited' ? { id: 1, scopes: ['tasks:read'] } : null);
  assert.equal(authorizeBearer('Bearer limited', 'terminal:execute', { lookup }).status, 403);
  assert.equal(authorizeBearer('Bearer other', 'terminal:execute', { lookup }).status, 401);
  assert.equal(authorizeBearer('', 'terminal:execute', { lookup }).status, 401);
  assert.equal(authorizeBearer('Bearer x', 'terminal:execute', { lookup: () => ({ id: 2, scopes: ['*'] }) }).ok, true);
  const status = await new Promise(resolve => {
    const server = http.createServer();
    server.on('upgrade', (req, socket, head) => handleVscodeUpgrade(req, socket, head, { lookup }));
    server.listen(0, '127.0.0.1', () => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}${web('/ws')}`, { headers: { Authorization: 'Bearer limited' } });
      ws.once('unexpected-response', (req, res) => { resolve(res.statusCode); server.close(); });
      ws.once('error', () => {});
    });
  });
  assert.equal(status, 403);
});

test('a task the link may not see is 404 TASK_NOT_FOUND on the start, status and license routes; a missing task and terminal too', async () => {
  for (const method of ['GET', 'POST']) {
    const answer = await call(method, vscodeRoute(hiddenTaskId, 'default'), { auth: linkToken, body: method === 'POST' ? { host: PUBLIC_HOST, proto: 'https' } : undefined });
    assert.equal(answer.status, 404);
    assert.deepEqual(answer.body, { error: 'TASK_NOT_FOUND' });
  }
  assert.deepEqual((await call('POST', `${vscodeRoute(hiddenTaskId, 'default')}/accept-license`, { auth: linkToken })).body, { error: 'TASK_NOT_FOUND' });
  // The owner's own token still sees it, and the link sees the other task.
  assert.equal((await call('GET', vscodeRoute(hiddenTaskId, 'default'))).status, 200);
  assert.equal((await call('GET', vscodeRoute(), { auth: linkToken })).status, 200);
  assert.equal((await call('GET', vscodeRoute(99999, 'default'))).status, 404);
  const terminal = await call('GET', vscodeRoute(taskId, 'no-such-terminal'));
  assert.equal(terminal.status, 404);
  assert.equal(terminal.body.error, 'TERMINAL_NOT_FOUND');
});

test('stopped: the proxy answers 503 VSCODE_NOT_RUNNING and the upgrade 503', async () => {
  const answer = await call('GET', web('/'));
  assert.equal(answer.status, 503);
  assert.deepEqual(answer.body, { error: 'VSCODE_NOT_RUNNING' });
  const status = await new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${web('/ws')}`, { headers: { Authorization: `Bearer ${token}` } });
    ws.once('unexpected-response', (req, res) => resolve(res.statusCode));
    ws.once('error', () => {});
  });
  assert.equal(status, 503);
});

test('settings: GET and PUT /v1/vscode/settings (its own body parser), validated', async () => {
  assert.deepEqual((await call('GET', '/v1/vscode/settings')).body, { enabled: true, idle_minutes: 30, license_accepted: false });
  assert.deepEqual((await call('PUT', '/v1/vscode/settings', { body: { idle_minutes: 45 } })).body, { enabled: true, idle_minutes: 45, license_accepted: false });
  const bad = await call('PUT', '/v1/vscode/settings', { body: { idle_minutes: -1 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'INVALID_VSCODE_SETTINGS');
  await call('PUT', '/v1/vscode/settings', { body: { enabled: false } });
  assert.equal((await call('POST', vscodeRoute(), { body: { host: PUBLIC_HOST, proto: 'https' } })).body.error, 'VSCODE_DISABLED');
  await call('PUT', '/v1/vscode/settings', { body: { enabled: true, idle_minutes: 30 } });
});

test('Contract A: the license first, then start -> ready, with the folder of the terminal; Contract B through the route', async () => {
  const before = await call('GET', vscodeRoute());
  assert.equal(before.status, 200);
  assert.equal(before.headers.get('cache-control'), 'no-store');
  const engineId = before.body.engine_id;
  assert.deepEqual(before.body, {
    state: 'error', error: 'VSCODE_LICENSE_REQUIRED', detail: '', base_path: `/vscode/${engineId}`, engine_id: engineId,
    folder: SUB, open_path: `/vscode/${engineId}/?folder=${encodeURIComponent(SUB)}`,
  });
  assert.equal((await call('POST', vscodeRoute(), { body: { host: PUBLIC_HOST, proto: 'https' } })).body.error, 'VSCODE_LICENSE_REQUIRED');
  const badHost = await call('POST', vscodeRoute(), { body: { host: 'evil.com/x', proto: 'https' } });
  assert.equal(badHost.status, 400);
  assert.equal(badHost.body.error, 'INVALID_VSCODE_HOST');
  assert.deepEqual((await call('POST', `${vscodeRoute()}/accept-license`)).body, { accepted: true });
  const started = await call('POST', vscodeRoute(), { body: { host: PUBLIC_HOST, proto: 'https', folder: '/etc' } });
  assert.equal(started.status, 200);
  assert.ok(['starting', 'ready'].includes(started.body.state));
  assert.equal(started.body.folder, SUB, 'the folder comes from the terminal, never from the body');
  const ready = await untilReady();
  assert.equal(ready.state, 'ready');
  assert.equal(ready.error, undefined);
  assert.ok(!JSON.stringify(ready).includes('tkn'));

  // HTML, with VS Code's cookie and service worker scope taken out.
  const page = await call('GET', web(`/?folder=${encodeURIComponent(SUB)}`), { raw: true });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.body, new RegExp(`folder=${SUB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(page.headers.get('set-cookie'), null);
  assert.equal(page.headers.get('service-worker-allowed'), null);
  assert.equal(page.headers.get('content-security-policy'), null, 'the engine\'s own frame-ancestors policy is not added');
  // The base path without its slash, and the query on it.
  assert.equal((await call('GET', `/v1/vscode/web/${HOST_B64}?folder=%2Ftmp`, { raw: true })).status, 200);

  // A static file, HEAD and Range.
  const file = await call('GET', web('/static/a.txt'), { raw: true });
  assert.equal(file.status, 200);
  assert.equal(file.body, '0123456789abcdefghij');
  assert.equal(file.headers.get('etag'), '"fake-etag"');
  const head = await call('HEAD', web('/static/a.txt'), { raw: true });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '20');
  assert.equal(head.body, '');
  const range = await call('GET', web('/static/a.txt'), { raw: true, headers: { Range: 'bytes=2-5' } });
  assert.equal(range.status, 206);
  assert.equal(range.body, '2345');
  assert.equal(range.headers.get('content-range'), 'bytes 2-5/20');

  // A POST body, streamed whole (not parsed by the JSON parser): a small JSON one and a 3 MB one.
  const small = await call('POST', web('/echo'), { body: Buffer.from('{"a":1}'), headers: { 'Content-Type': 'application/json' } });
  assert.deepEqual(small.body, { length: 7, text: '{"a":1}', type: 'application/json' });
  const big = await call('POST', web('/echo'), { body: Buffer.alloc(3 * 1024 * 1024, 120), headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal(big.body.length, 3 * 1024 * 1024);

  // A redirect: the token is taken out of Location, and VS Code's own address becomes a path.
  const redirect = await call('GET', web('/redirect'), { raw: true });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), `/vscode/${engineId}/?x=1`);

  // Request headers: only the allowlist, the VS Code cookie, and the forwarded host and scheme.
  const seen = (await call('GET', web('/headers'), { headers: { Cookie: 'connect.sid=abc; ta_vscode=x', 'Accept-Encoding': 'gzip, br', 'X-Forwarded-For': '9.9.9.9', 'Accept-Language': 'zh-CN' } })).body;
  assert.deepEqual(seen.cookie_names, ['vscode-tkn']);
  assert.equal(seen.token_ok, true);
  assert.equal(seen.authorization, undefined, 'the engine token never reaches VS Code');
  assert.equal(seen['accept-encoding'], undefined, 'an uncompressed body is asked for');
  assert.equal(seen['x-forwarded-for'], undefined);
  assert.equal(seen['x-forwarded-host'], PUBLIC_HOST);
  assert.equal(seen['x-forwarded-proto'], 'https');
  assert.equal(seen['accept-language'], 'zh-CN');

  // A path that tries to leave the base path.
  const escape = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: web('/%2e%2e/x'), headers: { Authorization: `Bearer ${token}` } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(escape, 404);

  // The WebSocket echo through the upgrade.
  const ws = new WebSocket(`ws://127.0.0.1:${port}${web('/ws')}`, { headers: { Authorization: `Bearer ${token}`, Cookie: 'connect.sid=abc' } });
  const messages = [];
  ws.on('message', (data, binary) => messages.push(binary ? Buffer.from(data) : String(data)));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send('hello');
  ws.send(Buffer.from([1, 2, 3]), { binary: true });
  for (let i = 0; i < 200 && messages.length < 3; i += 1) await sleep(10);
  assert.deepEqual(JSON.parse(messages[0]), { hello: true, origin: `https://${PUBLIC_HOST}`, forwarded_host: PUBLIC_HOST });
  assert.equal(messages[1], 'hello');
  assert.deepEqual([...messages[2]], [1, 2, 3]);

  // Stop: the socket closes, the proxy answers 503 again.
  const closed = new Promise(resolve => ws.once('close', resolve));
  assert.deepEqual((await call('POST', '/v1/vscode/stop')).body, { state: 'stopped' });
  await closed;
  assert.equal((await call('GET', web('/'))).status, 503);
  assert.equal((await call('GET', vscodeRoute())).body.state, 'stopped');
});
