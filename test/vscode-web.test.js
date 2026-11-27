// The VS Code process manager of "Open in VS Code" (services/vscode-web.js, docs/design/vscode-web.md). Every test runs the fake CLI of
// test-support/fake-vscode-cli.js through a `code` shim in a temp folder: no real VS Code, no download, no network. VS Code listens on a Unix
// socket in the temp data folder (or a loopback port in the fallback test).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tvsc-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const Database = require('better-sqlite3');
const WebSocket = require('ws');
const { writeCodeShim } = require('../test-support/fake-vscode-cli');
const { createVscodeWeb, cleanLocation, filterResponseHeaders, redactor, ENABLED_KEY, IDLE_KEY, LICENSE_KEY } = require('../services/vscode-web');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const shim = writeCodeShim(path.join(root, 'bin'));
const ENGINE = '11111111-2222-3333-4444-555555555555';
const HOST = { host: 't.example.com', proto: 'https' };
let counter = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, { timeout = 10_000, step = 20 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(step);
  }
  throw new Error('timed out');
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A manager over its own database and data folder. `fake`: the FAKE_VSCODE_* switches; `license`: accept the license first.
function fixture(t, { fake = {}, license = true, cli = shim, dataRoot: givenRoot = null, ...options } = {}) {
  counter += 1;
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const dataRoot = givenRoot || path.join(root, `d${counter}`);
  const pidFile = path.join(root, `pid${counter}`);
  const argsFile = path.join(root, `args${counter}`);
  const logs = [];
  const log = { info: line => logs.push(line), warn: line => logs.push(line) };
  const env = { ...process.env, FAKE_VSCODE_PID_FILE: pidFile, FAKE_VSCODE_ARGS_FILE: argsFile, ...fake };
  const manager = createVscodeWeb({
    db, dataRoot, engineId: ENGINE, findCli: async () => cli, env, terminalUser: false, log, readyPollMs: 50, killGraceMs: 300, ...options,
  });
  if (license) manager.acceptLicense();
  t.after(async () => { await manager.stop(); db.close(); });
  const pid = () => Number(fs.readFileSync(pidFile, 'utf8'));
  const args = () => JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  return { db, manager, dataRoot, logs, pid, args };
}
const ready = manager => until(() => manager.status().state === 'ready' && manager.status());

function get(manager, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = manager.request({ method: 'GET', path: `/vscode/${ENGINE}${route}`, headers, host: HOST.host }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('no CLI: VSCODE_NOT_INSTALLED, and nothing is started', async t => {
  const { manager } = fixture(t, { cli: null });
  const answer = await manager.ensure(HOST);
  assert.equal(answer.state, 'error');
  assert.equal(answer.error, 'VSCODE_NOT_INSTALLED');
  assert.equal(answer.base_path, `/vscode/${ENGINE}`);
  assert.equal(answer.engine_id, ENGINE);
  assert.equal(manager.status().state, 'stopped', 'a refused start does not change the state');
  assert.equal((await manager.check()).error, 'VSCODE_NOT_INSTALLED');
  assert.equal(manager.socketTarget(), null);
});

test('an old CLI without --server-base-path, or without serve-web: VSCODE_SERVE_WEB_UNSUPPORTED', async t => {
  for (const fake of [{ FAKE_VSCODE_OLD: '1' }, { FAKE_VSCODE_NO_SERVE_WEB: '1' }]) {
    const { manager } = fixture(t, { fake });
    const answer = await manager.ensure(HOST);
    assert.equal(answer.error, 'VSCODE_SERVE_WEB_UNSUPPORTED', JSON.stringify(fake));
    assert.equal(manager.status().state, 'stopped');
  }
});

test('the license must be confirmed once per engine before the first start, and the confirmation is stored', async t => {
  const { manager, db } = fixture(t, { license: false });
  assert.equal(manager.settings().license_accepted, false);
  assert.equal((await manager.check()).error, 'VSCODE_LICENSE_REQUIRED');
  assert.equal((await manager.ensure(HOST)).error, 'VSCODE_LICENSE_REQUIRED');
  assert.deepEqual(manager.acceptLicense(), { accepted: true });
  assert.equal(JSON.parse(db.prepare('SELECT value FROM system_state WHERE key = ?').get(LICENSE_KEY).value).accepted, true);
  assert.equal(manager.settings().license_accepted, true);
  assert.equal((await manager.ensure(HOST)).state, 'starting');
  await ready(manager);
});

test('the switch: off refuses a start with VSCODE_DISABLED and stops a running VS Code; settings are validated', async t => {
  const { manager, db, pid } = fixture(t);
  assert.deepEqual(manager.settings(), { enabled: true, idle_minutes: 30, license_accepted: true });
  await manager.ensure(HOST);
  await ready(manager);
  const running = pid();
  const stopped = [];
  manager.onStop(() => stopped.push('stop'));
  assert.deepEqual(await manager.setSettings({ enabled: false, idle_minutes: 5 }), { enabled: false, idle_minutes: 5, license_accepted: true });
  assert.equal(manager.status().state, 'stopped');
  await until(() => !alive(running));
  assert.deepEqual(stopped, ['stop']);
  assert.equal((await manager.ensure(HOST)).error, 'VSCODE_DISABLED');
  assert.equal((await manager.check()).error, 'VSCODE_DISABLED');
  assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM system_state WHERE key = ?').get(ENABLED_KEY).value), { enabled: false });
  assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM system_state WHERE key = ?').get(IDLE_KEY).value), { minutes: 5 });
  for (const bad of [{ enabled: 'no' }, { idle_minutes: 0 }, { idle_minutes: 1441 }, { idle_minutes: 2.5 }]) {
    await assert.rejects(manager.setSettings(bad), /INVALID_VSCODE_SETTINGS/, JSON.stringify(bad));
  }
  await manager.setSettings({ enabled: true });
  assert.equal((await manager.ensure(HOST)).state, 'starting');
  await ready(manager);
});

test('a bad public host or scheme is refused before anything starts', async t => {
  const { manager } = fixture(t);
  for (const bad of [{}, { host: 'a b', proto: 'https' }, { host: 'x.com/evil', proto: 'https' }, { host: 'x.com', proto: 'ftp' }]) {
    await assert.rejects(manager.ensure(bad), /INVALID_VSCODE_HOST/);
  }
  assert.equal(manager.status().state, 'stopped');
});

test('start -> ready: the flags, the data folders under the data home, the socket and the token file', async t => {
  const { manager, dataRoot, args } = fixture(t);
  const first = await manager.ensure(HOST);
  assert.equal(first.state, 'starting');
  assert.equal(first.error, undefined);
  const answer = await ready(manager);
  assert.deepEqual(Object.keys(answer).sort(), ['base_path', 'engine_id', 'state']);
  const argv = args();
  const flag = name => argv[argv.indexOf(name) + 1];
  assert.equal(argv[0], 'serve-web');
  assert.ok(argv.includes('--accept-server-license-terms'));
  assert.ok(argv.includes('--disable-telemetry'));
  assert.equal(flag('--server-base-path'), `/vscode/${ENGINE}`);
  assert.equal(flag('--server-data-dir'), path.join(dataRoot, 'vscode', 'server'));
  assert.equal(flag('--cli-data-dir'), path.join(dataRoot, 'vscode', 'cli'));
  assert.ok(!argv.includes('--connection-token'), 'the token is never on the command line');
  const tokenFile = flag('--connection-token-file');
  assert.equal(path.dirname(tokenFile), path.join(dataRoot, 'vscode', 'run'));
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dataRoot, 'vscode', 'run')).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(tokenFile, 'utf8').length, 64);
  assert.deepEqual(manager.socketTarget(), { socketPath: flag('--socket-path') });
  assert.ok(fs.existsSync(flag('--socket-path')));
  const page = await get(manager, '/?folder=%2Ftmp');
  assert.equal(page.status, 200);
  assert.match(page.body, /folder=\/tmp/);
  assert.equal(page.headers['set-cookie'], undefined);
  assert.equal(page.headers['service-worker-allowed'], undefined);
  assert.ok(!page.rawHeaders.map(name => String(name).toLowerCase()).includes('set-cookie'));
});

test('a second ensure reuses the running process', async t => {
  const { manager, pid } = fixture(t);
  await manager.ensure(HOST);
  const both = await Promise.all([manager.ensure(HOST), manager.ensure(HOST)]);
  assert.ok(both.every(answer => answer.state === 'starting' || answer.state === 'ready'));
  await ready(manager);
  const first = pid();
  const target = manager.socketTarget();
  assert.equal((await manager.ensure(HOST)).state, 'ready');
  await sleep(200);
  assert.equal(pid(), first);
  assert.deepEqual(manager.socketTarget(), target);
});

test('slow start: starting while the CLI downloads and while <base>/ is not ready yet, then ready', async t => {
  const { manager } = fixture(t, { fake: { FAKE_VSCODE_DELAY_MS: '600', FAKE_VSCODE_NOT_READY_MS: '600' } });
  await manager.ensure(HOST);
  await sleep(300);
  assert.equal(manager.status().state, 'starting');
  assert.throws(() => manager.request({ path: `/vscode/${ENGINE}/`, host: HOST.host }), /VSCODE_NOT_RUNNING/);
  await sleep(600);
  assert.equal(manager.status().state, 'starting', 'listening, but <base>/ still answers 503');
  await ready(manager);
});

test('readiness has a deadline: a VS Code that never answers 200 ends in VSCODE_START_FAILED and is killed', async t => {
  const { manager, pid } = fixture(t, { fake: { FAKE_VSCODE_NOT_READY_MS: '600000' }, readyTimeoutMs: 800 });
  await manager.ensure(HOST);
  const answer = await until(() => manager.status().state === 'error' && manager.status());
  assert.equal(answer.error, 'VSCODE_START_FAILED');
  await until(() => !alive(pid()));
});

test('a crash at start ends in error with the output kept, the token redacted; a crash while running too; a new ensure restarts', async t => {
  const { manager, logs } = fixture(t, { fake: { FAKE_VSCODE_EXIT: '1' } });
  await manager.ensure(HOST);
  const answer = await until(() => manager.status().state === 'error' && manager.status());
  assert.equal(answer.error, 'VSCODE_START_FAILED');
  assert.match(answer.detail, /could not start the server \(token <redacted>\)/);
  assert.ok(!/[0-9a-f]{64}/.test(JSON.stringify(answer) + logs.join('\n')), 'no token in the status or the logs');

  const crash = fixture(t, { fake: { FAKE_VSCODE_EXIT_AFTER_MS: '500' } });
  const stops = [];
  crash.manager.onStop(() => stops.push(1));
  await crash.manager.ensure(HOST);
  await ready(crash.manager);
  const after = await until(() => crash.manager.status().state === 'error' && crash.manager.status());
  assert.equal(after.error, 'VSCODE_START_FAILED');
  assert.match(after.detail, /exited with code 3/);
  assert.deepEqual(stops, [1]);
  assert.equal(crash.manager.socketTarget(), null);
  assert.equal((await crash.manager.ensure(HOST)).state, 'starting', 'an error is not sticky');
  await ready(crash.manager);
});

test('the token never appears in the status, the kept output or the logs', async t => {
  const { manager, logs, args } = fixture(t, { fake: { FAKE_VSCODE_LEAK_TOKEN: '1' } });
  await manager.ensure(HOST);
  await ready(manager);
  const argv = args();
  const token = fs.readFileSync(argv[argv.indexOf('--connection-token-file') + 1], 'utf8');
  const texts = [JSON.stringify(manager.status()), JSON.stringify(await manager.check()), JSON.stringify(manager.socketTarget()), logs.join('\n'),
    JSON.stringify(manager.settings())];
  for (const text of texts) assert.ok(!text.includes(token), text);
  const r = redactor(token);
  assert.equal(r(`a ${token} b ?tkn=${token}&x=1 vscode-tkn=${token};`), 'a <redacted> b ?tkn=<redacted>&x=1 vscode-tkn=<redacted>;');
});

test('idle: no request and no open WebSocket for the idle time stops VS Code; an open WebSocket keeps it', async t => {
  const { manager, pid } = fixture(t, { idleMs: 400, idleCheckMs: 50 });
  await manager.ensure(HOST);
  await ready(manager);
  const ws = manager.openWebSocket({ path: `/vscode/${ENGINE}/ws`, host: HOST.host });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await sleep(700);
  assert.equal(manager.status().state, 'ready', 'an open WebSocket keeps VS Code');
  const first = pid();
  ws.close();
  await until(() => manager.status().state === 'stopped', { timeout: 3000 });
  await until(() => !alive(first));
});

test('stop ends the process group, escalating to SIGKILL, and removes the socket and the token file', async t => {
  const { manager, pid, args } = fixture(t, { fake: { FAKE_VSCODE_IGNORE_TERM: '1' } });
  await manager.ensure(HOST);
  await ready(manager);
  const running = pid();
  const argv = args();
  assert.ok(alive(running));
  assert.deepEqual(await manager.stop(), { state: 'stopped' });
  assert.ok(!alive(running));
  assert.ok(!fs.existsSync(argv[argv.indexOf('--connection-token-file') + 1]));
  assert.ok(!fs.existsSync(argv[argv.indexOf('--socket-path') + 1]));
  assert.equal(manager.status().state, 'stopped');
  assert.throws(() => manager.request({ path: `/vscode/${ENGINE}/`, host: HOST.host }), error => error.message === 'VSCODE_NOT_RUNNING' && error.statusCode === 503);
});

test('shutdown (process exit) kills a running VS Code synchronously', async t => {
  const { manager, pid } = fixture(t);
  await manager.ensure(HOST);
  await ready(manager);
  const running = pid();
  manager.shutdown();
  await until(() => !alive(running));
  assert.equal(manager.status().state, 'stopped');
});

test('a VS Code left by an earlier T-Agent that ended without its exit handler is ended at the next start', async t => {
  const earlier = fixture(t);
  await earlier.manager.ensure(HOST);
  await ready(earlier.manager);
  const orphan = earlier.pid();
  assert.ok(fs.existsSync(path.join(earlier.dataRoot, 'vscode', 'serve-web.pid')));
  const next = fixture(t, { dataRoot: earlier.dataRoot });
  await next.manager.ensure(HOST);
  await until(() => !alive(orphan));
  await ready(next.manager);
  assert.notEqual(next.pid(), orphan);
});

test('without --socket-path the CLI listens on a loopback port, read from its output', async t => {
  const { manager, args } = fixture(t, { fake: { FAKE_VSCODE_NO_SOCKET: '1' } });
  await manager.ensure(HOST);
  await ready(manager);
  const argv = args();
  assert.ok(!argv.includes('--socket-path'));
  assert.equal(argv[argv.indexOf('--host') + 1], '127.0.0.1');
  const target = manager.socketTarget();
  assert.equal(target.host, '127.0.0.1');
  assert.ok(target.port > 0);
  assert.equal((await get(manager, '/static/a.txt')).body, '0123456789abcdefghij');
});

test('the local transport: request() and openWebSocket() add the token and the forwarded headers, and keep paths inside the base path', async t => {
  const { manager } = fixture(t);
  await manager.ensure({ host: 'page.example.org:8443', proto: 'http' });
  await ready(manager);
  const seen = JSON.parse((await new Promise((resolve, reject) => {
    const req = manager.request({ path: `/vscode/${ENGINE}/headers`, host: 'page.example.org:8443',
      headers: { cookie: 'ta_vscode=abc; connect.sid=xyz', authorization: 'Bearer nope', 'accept-encoding': 'gzip', 'x-forwarded-for': '1.2.3.4', accept: 'text/html' } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.end();
  })));
  assert.deepEqual(seen.cookie_names, ['vscode-tkn']);
  assert.equal(seen.token_ok, true);
  assert.equal(seen.authorization, undefined);
  assert.equal(seen['accept-encoding'], undefined);
  assert.equal(seen['x-forwarded-for'], undefined);
  assert.equal(seen['x-forwarded-host'], 'page.example.org:8443');
  assert.equal(seen['x-forwarded-proto'], 'http');
  assert.equal(seen.accept, 'text/html');
  for (const bad of ['/elsewhere/', `/vscode/${ENGINE}x/`, `/vscode/${ENGINE}/%2e%2e/x`, `/vscode/${ENGINE}/a/../b`]) {
    assert.throws(() => manager.request({ path: bad, host: HOST.host }), /VSCODE_PATH_INVALID/, bad);
  }
  const ws = manager.openWebSocket({ path: `/vscode/${ENGINE}/ws`, host: 'page.example.org:8443' });
  const messages = [];
  ws.on('message', data => messages.push(String(data)));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send('ping');
  await until(() => messages.length >= 2);
  assert.deepEqual(JSON.parse(messages[0]), { hello: true, origin: 'http://page.example.org:8443', forwarded_host: 'page.example.org:8443' });
  assert.equal(messages[1], 'ping');
  const closed = new Promise(resolve => ws.once('close', resolve));
  await manager.stop();
  await closed;
  assert.equal(ws.readyState, WebSocket.CLOSED, 'stop closes the open WebSockets');
});

test('response headers: Location loses the token and VS Code\'s own address; cookies and the service worker scope are dropped', () => {
  assert.equal(cleanLocation(`http://localhost/vscode/${ENGINE}/?tkn=secret&x=1`), `/vscode/${ENGINE}/?x=1`);
  assert.equal(cleanLocation('http://127.0.0.1:8123/vscode/a/?tkn=s'), '/vscode/a/');
  assert.equal(cleanLocation('/vscode/a/b?tkn=s#h'), '/vscode/a/b#h');
  assert.equal(cleanLocation('https://marketplace.visualstudio.com/x?tkn=s'), 'https://marketplace.visualstudio.com/x');
  assert.deepEqual(filterResponseHeaders({ 'set-cookie': ['a=b'], 'service-worker-allowed': '/', connection: 'keep-alive', 'content-type': 'text/html', location: '/x?tkn=1' }),
    { 'content-type': 'text/html', location: '/x' });
});

test('an HTTP request to a stopped VS Code is refused before any socket is opened', async t => {
  const { manager } = fixture(t);
  assert.throws(() => manager.request({ path: `/vscode/${ENGINE}/`, host: HOST.host }), /VSCODE_NOT_RUNNING/);
  assert.throws(() => manager.openWebSocket({ path: `/vscode/${ENGINE}/ws`, host: HOST.host }), /VSCODE_NOT_RUNNING/);
  // The raw upgrade answers 503 on the socket itself.
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => manager.upgrade(req, socket, head, { path: `/vscode/${ENGINE}/ws`, host: HOST.host }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/x`);
  const status = await new Promise(resolve => ws.once('unexpected-response', (req, res) => resolve(res.statusCode)));
  assert.equal(status, 503);
});

test('connectionToken(): only while ready, never in status(), and it is the token VS Code was started with', async t => {
  const { manager, args } = fixture(t);
  assert.equal(manager.connectionToken(), null, 'stopped');
  await manager.ensure(HOST);
  await ready(manager);
  const token = manager.connectionToken();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(manager.status()).includes(token));
  const argv = args();
  assert.ok(!argv.join(' ').includes(token), 'not on the command line');
  await manager.stop();
  assert.equal(manager.connectionToken(), null, 'stopped again');
});
