// POST /api/system/restart and the `restart` field of the version and update-status answers.
// Nothing here exits or restarts anything: the exit and the timer are injected, and the real update manager runs in a sandbox with its own fake `process`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');
const { createServerRestart, RESTART_EXIT_CODE, RESTART_DELAY_MS } = require('../lib/server-restart');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-system-restart-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');

// The router opens the database and the engine name lazily, on each request; this file is its own process, so the stubs stay in place.
function stub(name, exports) {
  const resolved = require.resolve(name);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
const world = { supervisor: 'pm2', applying: false, exits: [], timers: [], logs: [], applies: [], session: { user: { login: 'local' } } };
const restart = createServerRestart({
  supervisor: () => world.supervisor,
  isApplying: () => world.applying,
  bootId: 'boot-1',
  log: (stage, text) => world.logs.push([stage, text]),
  exit: code => world.exits.push(code),
  schedule: (fn, ms) => world.timers.push({ fn, ms }),
});
stub('../services/update-manager', {
  bootId: 'boot-1',
  readLocalManifest: () => ({ app_version: '1.2.3' }),
  publicState: () => ({ status: 'current', boot_id: 'boot-1' }),
  restartSupport: () => restart.support(),
  requestRestart: () => restart.request(),
  restartPending: () => restart.pending(),
  apply: options => { world.applies.push(options); return Promise.resolve(); },
});
stub('../middleware/auth', (req, res, next) => next());
// Only the instance id of /api/system/version is read from it.
stub('../db', { prepare: () => ({ get: () => ({ value: 'instance-1' }) }) });
stub('../services/engine-name', { engineNameState: () => ({ name: 'test-engine' }) });

let server;
let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  // The same-origin check server.js puts in front of every /api route.
  app.use('/api', require('../middleware/client-origin'));
  app.use((req, res, next) => { req.session = world.session; next(); });
  app.use('/api/system', require('../routes/system'));
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  fs.rmSync(root, { recursive: true, force: true });
});

async function call(method, route, body, headers = { 'X-Requested-With': 'XMLHttpRequest' }) {
  const response = await fetch(base + route, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
const post = (body, headers) => call('POST', '/api/system/restart', body, headers);
const noExit = () => { assert.deepEqual(world.timers, []); assert.deepEqual(world.exits, []); };

test('a session without a user gets 403 UPDATE_ADMIN_REQUIRED and nothing is scheduled', async () => {
  world.session = {};
  try { assert.deepEqual(await post({ confirm: true }), { status: 403, body: { error: 'UPDATE_ADMIN_REQUIRED' } }); }
  finally { world.session = { user: { login: 'local' } }; }
  noExit();
});

test('without confirm: true the answer is 400 CONFIRMATION_REQUIRED', async () => {
  for (const body of [undefined, {}, { confirm: 'true' }, { confirm: 1 }, { confirm: false }]) {
    assert.deepEqual(await post(body), { status: 400, body: { error: 'CONFIRMATION_REQUIRED' } }, JSON.stringify(body));
  }
  noExit();
});

test('a cross-site or unmarked request is refused by the same-origin check', async () => {
  assert.deepEqual(await post({ confirm: true }, { Origin: 'https://evil.example' }), { status: 403, body: { error: 'CLIENT_ORIGIN_REQUIRED' } });
  assert.deepEqual(await post({ confirm: true }, { 'Sec-Fetch-Site': 'cross-site', 'X-Requested-With': 'XMLHttpRequest' }), { status: 403, body: { error: 'CLIENT_ORIGIN_REQUIRED' } });
  assert.deepEqual(await post({ confirm: true }, {}), { status: 403, body: { error: 'CLIENT_ORIGIN_REQUIRED' } });
  noExit();
});

test('with no process manager the answer is 409 NO_PROCESS_MANAGER, and both GET answers say restart is not supported', async () => {
  world.supervisor = null;
  try {
    assert.deepEqual(await post({ confirm: true }), { status: 409, body: { error: 'NO_PROCESS_MANAGER' } });
    const unsupported = { supported: false, reason: 'NO_PROCESS_MANAGER' };
    assert.deepEqual((await call('GET', '/api/system/version')).body.restart, unsupported);
    assert.deepEqual((await call('GET', '/api/system/update-status')).body.restart, unsupported);
  } finally { world.supervisor = 'pm2'; }
  noExit();
});

test('while an update is being applied the answer is 409 UPDATE_IN_PROGRESS', async () => {
  world.applying = true;
  try { assert.deepEqual(await post({ confirm: true }), { status: 409, body: { error: 'UPDATE_IN_PROGRESS' } }); }
  finally { world.applying = false; }
  noExit();
});

test('both GET answers carry restart: { supported: true, reason: null } under a process manager, next to their usual fields', async () => {
  const version = await call('GET', '/api/system/version');
  assert.equal(version.status, 200);
  assert.deepEqual(version.body, { app_version: '1.2.3', boot_id: 'boot-1', is_update_admin: true, engine_name: 'test-engine', instance_id: 'instance-1', restart: { supported: true, reason: null } });
  const status = await call('GET', '/api/system/update-status');
  assert.deepEqual(status.body, { status: 'current', boot_id: 'boot-1', is_update_admin: true, restart: { supported: true, reason: null } });
});

test('with no restart pending, POST /api/system/apply-update still starts the update', async () => {
  const answer = await call('POST', '/api/system/apply-update', { confirm: true });
  assert.equal(answer.status, 202);
  assert.equal(answer.body.accepted, true);
  assert.equal(world.applies.length, 1);
  world.applies.length = 0;
});

// Last: it leaves a restart requested.
test('a confirmed request answers 202 with the boot_id, logs once, and exits once with 75 after the delay', async () => {
  assert.deepEqual(await post({ confirm: true }), { status: 202, body: { accepted: true, boot_id: 'boot-1' } });
  assert.equal(world.timers.length, 1);
  assert.equal(world.timers[0].ms, RESTART_DELAY_MS);
  assert.equal(RESTART_DELAY_MS, 750);
  assert.deepEqual(world.exits, [], 'the answer goes out before the exit');
  assert.equal(world.logs.length, 1);
  assert.match(world.logs[0][1], /Restart requested/);

  // A second click before the exit answers the same and schedules nothing more.
  assert.deepEqual(await post({ confirm: true }), { status: 202, body: { accepted: true, boot_id: 'boot-1' } });
  assert.equal(world.timers.length, 1);
  assert.equal(world.logs.length, 1);

  // Until the exit no update may start: it would be cut off halfway.
  assert.deepEqual(await call('POST', '/api/system/apply-update', { confirm: true }), { status: 409, body: { error: 'RESTART_PENDING' } });
  assert.deepEqual(await call('POST', '/api/system/apply-update', { confirm: true, force: true }), { status: 409, body: { error: 'RESTART_PENDING' } });
  assert.deepEqual(world.applies, []);

  world.timers[0].fn();
  assert.deepEqual(world.exits, [RESTART_EXIT_CODE]);
  assert.equal(RESTART_EXIT_CODE, 75);
});

// The real update manager in a sandbox (as in auto-update.test.js): its git, database and process are fakes, so process.exit is only recorded.
const managerFile = require.resolve('../services/update-manager');
const realRequire = createRequire(managerFile);
function loadManager(env) {
  const sandbox = { exits: [], timers: [], fetches: 0, autoOptions: null };
  const realAuto = realRequire('./auto-update');
  const mocks = {
    // The real scheduler, with the options the manager gives it kept for the test.
    './auto-update': { ...realAuto, createAutoUpdate: options => { sandbox.autoOptions = options; return realAuto.createAutoUpdate(options); } },
    child_process: { execFileSync: () => 'running' },
    '../db': { prepare: () => ({ get: () => undefined, run() {} }), backup: async () => {} },
    '../config': { gitRemote: 'origin', gitBranch: 'main', updateCheckEnabled: true, updateCheckIntervalMs: 60_000, updateCheckStartupDelayMs: 1000, updateAutoQuietMs: 1000 },
    '../lib/update-command': {
      logUpdate() {}, recentLog: () => [], clearLog() {}, runWithProgress: (label, run) => run(() => {}),
      // The first git command of an update never ends, so the update stays in progress.
      runUpdateCommand: () => { sandbox.fetches += 1; return new Promise(() => {}); },
    },
  };
  const context = {
    require: name => mocks[name] || realRequire(name), module: { exports: {} }, __dirname: path.dirname(managerFile),
    process: { env, send() {}, ppid: 2, platform: process.platform, execPath: process.execPath, exit: code => sandbox.exits.push(code) },
    setTimeout: (fn, delay) => { sandbox.timers.push({ fn, delay }); return { unref() {} }; },
    setInterval: () => ({ unref() {} }),
    console,
  };
  vm.runInNewContext(fs.readFileSync(managerFile, 'utf8'), context);
  return { manager: context.module.exports, sandbox };
}

test('update manager: restartSupport follows detectSupervisor, and requestRestart exits the process with 75 after 750 ms', () => {
  const plain = loadManager({});
  assert.deepEqual(plain.manager.restartSupport(), { supported: false, reason: 'NO_PROCESS_MANAGER' });
  assert.throws(() => plain.manager.requestRestart(), error => error.message === 'NO_PROCESS_MANAGER' && error.statusCode === 409);
  assert.deepEqual(plain.sandbox.timers, []);

  const { manager, sandbox } = loadManager({ pm_id: '0' });
  assert.deepEqual(manager.restartSupport(), { supported: true, reason: null });
  assert.deepEqual(manager.requestRestart(), { accepted: true, boot_id: manager.bootId });
  assert.equal(sandbox.timers.length, 1);
  assert.equal(sandbox.timers[0].delay, 750);
  assert.deepEqual(sandbox.exits, []);
  sandbox.timers[0].fn();
  assert.deepEqual(sandbox.exits, [75]);
});

test('update manager: after an accepted restart apply() refuses with RESTART_PENDING and the scheduler is told a restart is pending', async () => {
  const { manager, sandbox } = loadManager({ pm_id: '0' });
  assert.equal(manager.restartPending(), false);
  assert.equal(sandbox.autoOptions.restartPending(), false);
  manager.requestRestart();
  assert.equal(manager.restartPending(), true);
  assert.equal(sandbox.autoOptions.restartPending(), true, 'the automatic update skips its ticks');
  await assert.rejects(manager.apply(), error => error.message === 'RESTART_PENDING' && error.statusCode === 409);
  await assert.rejects(manager.apply({ force: true }), /RESTART_PENDING/);
  assert.equal(sandbox.fetches, 0, 'no git command ran');
  assert.equal(manager.publicState().status === 'blocked', false, 'the refusal is not saved as a blocked update');
});

test('update manager: requestRestart is refused with UPDATE_IN_PROGRESS while apply() runs', async () => {
  const { manager, sandbox } = loadManager({ pm_id: '0' });
  manager.apply().catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(sandbox.fetches > 0, 'the update is running');
  assert.throws(() => manager.requestRestart(), error => error.message === 'UPDATE_IN_PROGRESS' && error.statusCode === 409);
  assert.deepEqual(sandbox.exits, []);
});
