const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createAutoUpdate, MAX_ATTEMPTS, TICK_MS } = require('../services/auto-update');
const { detectSupervisor } = require('../lib/update-supervisor');

const QUIET = 10 * 60_000;
const INTERVAL = 30 * 60_000;
const quietSnapshot = () => ({ terminals: [], chat: { running: 0, queued: 0 }, inputs: [] });
const busySnapshot = () => ({ terminals: [], chat: { running: 1, queued: 0 }, inputs: [] });

function harness(overrides = {}) {
  const box = {
    clock: 1_000_000,
    store: overrides.store === undefined ? null : overrides.store,
    update: { status: 'available', remote_version: '2.0.0', restart_required: true },
    applying: false,
    calls: [],
    snapshot: quietSnapshot,
    result: async () => ({ stage: 'restarting', remote_version: box.update.remote_version }),
  };
  box.auto = createAutoUpdate({
    readStore: () => box.store,
    writeStore: value => { box.store = value; },
    updateState: () => box.update,
    isApplying: () => box.applying,
    apply: options => { box.calls.push(options); return box.result(); },
    log() {},
    supervisor: () => (overrides.supervisor === undefined ? 'pm2' : overrides.supervisor),
    checksEnabled: overrides.checksEnabled !== false,
    checkIntervalMs: INTERVAL,
    quietMs: QUIET,
    now: () => box.clock,
    setIntervalFn: () => ({ unref() {} }),
  });
  if (overrides.probe !== false) box.auto.setIdleProbe(() => box.snapshot());
  box.state = () => box.auto.publicState();
  box.fail = code => { box.result = async () => { throw new Error(code); }; };
  box.saved = () => JSON.parse(box.store);
  return box;
}

test('restart update: applies after the quiet window, never with force', async () => {
  const box = harness();
  await box.auto.tick();
  assert.equal(box.state().state, 'waiting');
  assert.equal(box.state().quiet_until, new Date(box.clock + QUIET).toISOString());
  assert.equal(box.calls.length, 0);
  box.clock += QUIET - 1;
  await box.auto.tick();
  assert.equal(box.calls.length, 0);
  box.clock += 1;
  await box.auto.tick();
  assert.equal(box.calls.length, 1);
  assert.equal('force' in box.calls[0], false);
});

test('any reason resets the quiet window and hides quiet_until', async () => {
  const box = harness();
  await box.auto.tick();
  box.clock += QUIET - 1000;
  box.snapshot = busySnapshot;
  await box.auto.tick();
  assert.deepEqual(box.state().waiting_for, [{ code: 'chat_running', count: 1 }]);
  assert.equal(box.state().quiet_until, null);
  box.snapshot = quietSnapshot;
  box.clock += 2000;
  await box.auto.tick();
  assert.equal(box.calls.length, 0, 'the window starts again');
  assert.deepEqual(box.state().waiting_for, []);
  box.clock += QUIET;
  await box.auto.tick();
  assert.equal(box.calls.length, 1);
});

test('the probe is read again immediately before applying', async () => {
  const box = harness();
  await box.auto.tick();
  box.clock += QUIET;
  let reads = 0;
  box.snapshot = () => (reads++ === 0 ? quietSnapshot() : busySnapshot());
  await box.auto.tick();
  assert.equal(reads, 2);
  assert.equal(box.calls.length, 0);
  assert.equal(box.state().waiting_for[0].code, 'chat_running');
});

test('no probe, or one that throws, means nothing restarts', async () => {
  const none = harness({ probe: false });
  await none.auto.tick();
  none.clock += QUIET * 2;
  await none.auto.tick();
  assert.equal(none.calls.length, 0);
  assert.equal(none.state().last_error, 'IDLE_PROBE_UNAVAILABLE');
  const broken = harness();
  broken.snapshot = () => { throw new Error('boom'); };
  await broken.auto.tick();
  broken.clock += QUIET * 2;
  await broken.auto.tick();
  assert.equal(broken.calls.length, 0);
  assert.equal(broken.state().last_error, 'IDLE_PROBE_FAILED');
});

test('frontend-only update: applied at once, whatever is going on', async () => {
  const box = harness();
  box.update.restart_required = false;
  box.snapshot = busySnapshot;
  box.result = async () => ({ stage: 'completed', remote_version: '2.0.0' });
  await box.auto.tick();
  assert.deepEqual(box.calls, [{ expectNoRestart: true }]);
  assert.equal(box.state().last_auto_version, '2.0.0');
  assert.ok(box.state().last_auto_at);
});

test('an unknown restart_required goes through the gate', async () => {
  const box = harness();
  delete box.update.restart_required;
  box.snapshot = busySnapshot;
  await box.auto.tick();
  assert.equal(box.calls.length, 0);
});

test('a target that starts to need a restart is not a failure', async () => {
  const box = harness();
  box.update.restart_required = false;
  box.fail('AUTO_RESTART_REQUIRED');
  await box.auto.tick();
  assert.equal(box.saved().attempts, null);
  assert.equal(box.state().last_error, null);
});

test('a dirty worktree stops for that version at once', async () => {
  const box = harness();
  box.update.restart_required = false;
  box.fail('WORKTREE_DIRTY');
  await box.auto.tick();
  assert.equal(box.state().state, 'gave_up');
  assert.equal(box.state().last_error, 'WORKTREE_DIRTY');
  box.clock += INTERVAL * 5;
  await box.auto.tick();
  assert.equal(box.calls.length, 1);
});

test('other failures retry at most three times, one interval apart, and are not reported as success', async () => {
  const box = harness();
  box.update.restart_required = false;
  box.fail('NPM_INSTALLING_FAILED');
  await box.auto.tick();
  assert.equal(box.calls.length, 1);
  assert.equal(box.state().last_auto_version, null);
  await box.auto.tick();
  box.clock += INTERVAL - 1;
  await box.auto.tick();
  assert.equal(box.calls.length, 1, 'not before one interval');
  assert.equal(box.state().state, 'waiting');
  for (let attempt = 2; attempt <= MAX_ATTEMPTS + 2; attempt += 1) {
    box.clock += INTERVAL + 1;
    await box.auto.tick();
  }
  assert.equal(box.calls.length, MAX_ATTEMPTS);
  assert.equal(box.state().state, 'gave_up');
  assert.equal(box.state().last_auto_version, null);
});

test('a retry is spaced even when the quiet window is already over', async () => {
  const box = harness();
  box.fail('NPM_INSTALLING_FAILED');
  await box.auto.tick();
  box.clock += QUIET;
  await box.auto.tick();
  assert.equal(box.calls.length, 1);
  assert.equal(box.state().quiet_until, null, 'the attempt restarted the window');
  await box.auto.tick();
  box.clock += QUIET;
  await box.auto.tick();
  assert.equal(box.calls.length, 1, 'quiet again, but one interval has not passed');
  assert.equal(box.state().quiet_until, new Date(box.saved().attempts.last_at + INTERVAL).toISOString());
});

test('a newer remote version starts a new count', async () => {
  const box = harness();
  box.update.restart_required = false;
  box.fail('WORKTREE_DIRTY');
  await box.auto.tick();
  assert.equal(box.state().state, 'gave_up');
  box.update.remote_version = '2.0.1';
  assert.equal(box.state().state, 'waiting');
  await box.auto.tick();
  assert.equal(box.calls.length, 2);
  assert.equal(box.saved().attempts.version, '2.0.1');
  assert.equal(box.saved().attempts.count, 1);
});

test('attempts are saved before the update starts, so a crash still counts', async () => {
  const box = harness();
  box.update.restart_required = false;
  let during = null;
  box.result = async () => { during = box.saved().attempts; return { stage: 'completed' }; };
  await box.auto.tick();
  assert.equal(during.count, 1);
  assert.equal(box.saved().attempts, null, 'a success clears them');
});

test('a manual update in progress stops the wait and is left alone', async () => {
  const box = harness();
  await box.auto.tick();
  box.applying = true;
  box.clock += QUIET * 2;
  await box.auto.tick();
  assert.equal(box.calls.length, 0);
  assert.equal(box.state().quiet_until, null);
  box.applying = false;
  await box.auto.tick();
  assert.equal(box.calls.length, 0, 'the window starts again');
});

test('only status available is acted on, and no pending update reads as idle', async () => {
  const box = harness();
  box.update.status = 'current';
  await box.auto.tick();
  assert.equal(box.calls.length, 0);
  assert.equal(box.state().state, 'idle');
  assert.deepEqual(box.state().waiting_for, []);
});

test('unsupervised: unsupported and never applied', async () => {
  const box = harness({ supervisor: null });
  box.update.restart_required = false;
  await box.auto.tick();
  assert.equal(box.calls.length, 0);
  assert.equal(box.state().state, 'unsupported');
  assert.equal(box.state().supported, false);
  assert.equal(box.state().unsupported_reason, 'NO_PROCESS_MANAGER');
});

test('checks disabled: unsupported with its own reason', () => {
  const box = harness({ checksEnabled: false });
  assert.equal(box.state().unsupported_reason, 'CHECKS_DISABLED');
  assert.equal(box.state().state, 'unsupported');
});

test('the switch is on by default, is saved, and stops the wait', async () => {
  const box = harness();
  assert.equal(box.state().enabled, true);
  await box.auto.tick();
  box.auto.setEnabled(false);
  assert.equal(box.state().state, 'off');
  assert.equal(box.state().quiet_until, null);
  box.clock += QUIET * 2;
  await box.auto.tick();
  assert.equal(box.calls.length, 0);
  const again = harness({ store: box.store });
  assert.equal(again.state().enabled, false);
  assert.equal(again.state().state, 'off');
});

test('detectSupervisor believes the environment only with proof of how the process started', () => {
  const facts = { hasIpc: false, ppid: 500, platform: 'linux', readFile: () => { throw new Error('no such file'); } };
  assert.equal(detectSupervisor({ ...facts, env: {} }), null);
  assert.equal(detectSupervisor({ ...facts, env: { pm_id: '0' }, hasIpc: true }), 'pm2');
  assert.equal(detectSupervisor({ ...facts, env: { pm_id: '0' } }), null, 'inherited from a terminal of a PM2 service');
  assert.equal(detectSupervisor({ ...facts, env: { pm_id: '0', autorestart: 'false' }, hasIpc: true }), null);
  assert.equal(detectSupervisor({ ...facts, env: { INVOCATION_ID: 'x' }, readFile: () => 'systemd\n' }), 'systemd');
  assert.equal(detectSupervisor({ ...facts, env: { INVOCATION_ID: 'x' }, readFile: () => 'zsh\n' }), null, 'inherited from a shell');
  const mac = { ...facts, platform: 'darwin', ppid: 1 };
  assert.equal(detectSupervisor({ ...mac, env: { XPC_SERVICE_NAME: 'com.tagent.client' } }), 'launchd');
  assert.equal(detectSupervisor({ ...mac, ppid: 700, env: { XPC_SERVICE_NAME: 'com.tagent.client' } }), null);
  assert.equal(detectSupervisor({ ...mac, env: { XPC_SERVICE_NAME: '0' } }), null);
  assert.equal(detectSupervisor({ ...mac, env: { XPC_SERVICE_NAME: 'application.com.apple.Terminal.1' } }), null);
  assert.equal(detectSupervisor({ ...mac, env: {} }), null);
});

// The real update manager with its git, npm, database and exit mocked, as in update-no-restart.test.js.
const filename = require.resolve('../services/update-manager');
const realRequire = createRequire(filename);
function loadManager(world) {
  const remote = { ...require('../VERSION.json'), app_version: '99.0.0' };
  const mocks = {
    fs: { ...fs, mkdirSync() {} },
    child_process: { execFileSync: () => 'running' },
    '../db': {
      prepare: sql => ({
        get: key => (world.rows.has(key) ? { value: world.rows.get(key) } : undefined),
        run: (key, value) => { assert.match(sql, /INSERT INTO system_state/); world.rows.set(key, value); },
      }),
      backup: async () => {},
    },
    '../config': { gitRemote: 'origin', gitBranch: 'main', updateCheckEnabled: true, updateCheckIntervalMs: INTERVAL, updateCheckStartupDelayMs: 1000, updateAutoQuietMs: QUIET },
    '../lib/update-command': { logUpdate() {}, recentLog: () => [], clearLog() {}, runUpdateCommand: async (file, args) => {
      world.commands.push([file, ...args]);
      if (file !== 'git') return '';
      if (args[0] === 'show') return JSON.stringify(remote);
      if (args[0] === 'diff') return world.changed;
      if (args[0] === 'rev-list') return '0 1';
      if (args[0] === 'rev-parse') return 'running';
      return '';
    }, runWithProgress: (label, run) => run(() => {}) },
    '../lib/data-home': { prepare: () => ({ backupsDir: path.join(require('node:os').tmpdir(), 'auto-update-backups') }) },
    '../lib/git-update-workspace': {
      prepareWorkspace: async (git, force) => { world.prepared.push(force); return null; },
      trackedChanges: async () => world.dirty,
      dirtyError: changes => Object.assign(new Error('WORKTREE_DIRTY'), { details: changes.join(',') }),
    },
  };
  const context = {
    require: name => mocks[name] || realRequire(name), module: { exports: {} }, __dirname: path.dirname(filename),
    process: { env: { pm_id: '0' }, send() {}, ppid: 2, platform: process.platform, execPath: process.execPath },
    setTimeout: (fn, delay) => { world.timers.push(delay); return { unref() {} }; },
    setInterval: (fn, delay) => { world.intervals.set(delay, fn); return { unref() {} }; },
    console,
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context);
  return context.module.exports;
}
const newWorld = changed => ({ rows: new Map(), commands: [], timers: [], intervals: new Map(), prepared: [], dirty: [], changed });
const flush = async () => { for (let i = 0; i < 50; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const ran = (world, command) => world.commands.some(entry => entry.includes(command));

test('update manager: a frontend-only update found by a check is applied without a restart', async () => {
  const world = newWorld('public/js/app.js');
  const manager = loadManager(world);
  manager.start();
  world.timers.length = 0;
  await manager.check();
  await flush();
  const status = manager.publicState();
  assert.equal(status.status, 'current');
  assert.equal(status.auto_update.last_auto_version, '99.0.0');
  assert.equal(ran(world, 'merge'), true);
  assert.equal(world.commands.some(entry => entry[0].startsWith('npm')), false);
  assert.deepEqual(world.timers, [], 'no exit is scheduled');
  assert.deepEqual(world.prepared, [false]);
});

test('update manager: the restart path waits, restarts, and the new process knows it was automatic', async () => {
  const world = newWorld('services/x.js');
  const manager = loadManager(world);
  manager.setIdleProbe(() => quietSnapshot());
  await manager.check();
  assert.equal(manager.publicState().auto_update.state, 'waiting');
  manager.start();
  world.timers.length = 0;
  const tick = world.intervals.get(TICK_MS);
  assert.ok(tick, 'the minute timer is set');
  tick();
  await flush();
  assert.equal(ran(world, 'merge'), false, 'the quiet window is still running');
  assert.notEqual(manager.publicState().auto_update.quiet_until, null);
  const realNow = Date.now;
  Date.now = () => realNow() + QUIET + 1000;
  try {
    tick();
    await flush();
  } finally { Date.now = realNow; }
  assert.equal(ran(world, 'merge'), true);
  assert.deepEqual(world.prepared, [false], 'never forced');
  assert.deepEqual(world.timers, [750], 'the exit is scheduled');
  assert.equal(manager.publicState().auto_update.state, 'applying');

  const next = loadManager(world).publicState();
  assert.equal(next.status, 'current');
  assert.equal(next.auto_update.last_auto_version, '99.0.0');
  assert.ok(next.auto_update.last_auto_at);
  assert.equal(next.auto_update.state, 'idle');
});

test('update manager: a dirty worktree stops auto update and force is not used', async () => {
  const world = newWorld('public/js/app.js');
  world.dirty = ['server.js'];
  const manager = loadManager(world);
  manager.start();
  await manager.check();
  await flush();
  const status = manager.publicState();
  assert.equal(status.status, 'blocked');
  assert.equal(status.auto_update.state, 'gave_up');
  assert.equal(status.auto_update.last_error, 'WORKTREE_DIRTY');
  assert.equal(status.auto_update.last_auto_version, null);
  assert.deepEqual(world.prepared, []);
});

test('update manager: a frontend update whose target starts to need a restart stays available', async () => {
  const world = newWorld('public/js/app.js');
  const manager = loadManager(world);
  await manager.check();
  world.changed = 'services/x.js';
  world.commands.length = 0;
  manager.start();
  world.intervals.get(TICK_MS)();
  await flush();
  const status = manager.publicState();
  assert.equal(ran(world, 'merge'), false);
  assert.equal(status.status, 'available');
  assert.equal(status.restart_required, true);
  assert.equal(status.auto_update.state, 'waiting');
  assert.equal(status.auto_update.last_error, null);
});

test('update manager: the setting has its own row and survives a restart', () => {
  const world = newWorld('public/js/app.js');
  const manager = loadManager(world);
  manager.setAutoUpdateEnabled(false);
  assert.equal(JSON.parse(world.rows.get('update_auto')).enabled, false);
  assert.equal(world.rows.has('update_state'), false);
  world.rows.set('update_state', JSON.stringify({ status: 'restart_pending' }));
  assert.equal(loadManager(world).publicState().auto_update.enabled, false);
});

function routeApp(stubs) {
  const express = require('express');
  const targets = { '../services/update-manager': stubs.updates, '../middleware/auth': (req, res, next) => next() };
  const saved = new Map();
  for (const [name, exports] of Object.entries(targets)) {
    const resolved = require.resolve(name);
    saved.set(resolved, require.cache[resolved]);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
  }
  const routerPath = require.resolve('../routes/system');
  delete require.cache[routerPath];
  const router = require('../routes/system');
  delete require.cache[routerPath];
  for (const [resolved, entry] of saved) {
    if (entry) require.cache[resolved] = entry; else delete require.cache[resolved];
  }
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = stubs.session; next(); });
  app.use('/api/system', router);
  return app;
}

test('POST /api/system/auto-update: admin only, booleans only, answers the status', async () => {
  const set = [];
  const stubs = { session: {}, updates: { setAutoUpdateEnabled: value => set.push(value), publicState: () => ({ status: 'idle', auto_update: { enabled: set.at(-1) } }) } };
  const server = http.createServer(routeApp(stubs));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/api/system/auto-update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    let response = await post({ enabled: true });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'UPDATE_ADMIN_REQUIRED' });
    assert.deepEqual(set, []);

    stubs.session.user = { login: 'local' };
    for (const body of [{}, { enabled: 'true' }, { enabled: 1 }, { enabled: null }]) {
      response = await post(body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.deepEqual(await response.json(), { error: 'INVALID_AUTO_UPDATE' });
    }
    assert.deepEqual(set, []);

    response = await post({ enabled: false });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'idle', auto_update: { enabled: false }, is_update_admin: true });
    assert.deepEqual(set, [false]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
