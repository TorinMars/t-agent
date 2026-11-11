const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createAutoUpdate, MAX_ATTEMPTS, MAX_RESTARTS, RESTART_DID_NOT_HELP, TICK_MS } = require('../services/auto-update');
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
    restartPending: false,
    calls: [],
    restarts: [],
    snapshot: quietSnapshot,
    result: async () => ({ stage: 'restarting', remote_version: box.update.remote_version }),
    restartResult: async () => ({ stage: 'restarting', version: box.update.local_version }),
  };
  box.auto = createAutoUpdate({
    readStore: () => box.store,
    writeStore: value => { box.store = value; },
    updateState: () => box.update,
    isApplying: () => box.applying,
    restartPending: () => box.restartPending,
    apply: options => { box.calls.push(options); return box.result(); },
    restart: options => { box.restarts.push(options); return box.restartResult(); },
    bootId: overrides.bootId || 'boot-1',
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

test('a pending restart from the page skips the tick: no update starts, with or without the quiet gate', async () => {
  const box = harness();
  box.restartPending = true;
  box.update.restart_required = false;
  await box.auto.tick();
  assert.equal(box.calls.length, 0, 'an update that needs no restart waits as well');
  box.update.restart_required = true;
  await box.auto.tick();
  box.clock += QUIET * 2;
  await box.auto.tick();
  assert.equal(box.calls.length, 0, 'nor one whose quiet window has passed');
  assert.equal(box.store, null, 'no attempt is recorded');
  box.restartPending = false;
  await box.auto.tick();
  box.clock += QUIET;
  await box.auto.tick();
  assert.equal(box.calls.length, 1, 'the scheduler works again once nothing is pending');
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
  const remote = { ...require('../VERSION.json'), app_version: world.remoteVersion || '99.0.0' };
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
      if (file.startsWith('npm') && world.npmFails) throw new Error('NPM_INSTALLING_FAILED');
      if (file === process.execPath && world.ptyFails) throw new Error('NODE_PTY_LOAD_FAILED');
      if (file !== 'git') return '';
      if (args[0] === 'show') return JSON.stringify(remote);
      if (args[0] === 'diff' && world.diffFails) throw new Error('GIT_DIFF_FAILED');
      if (args[0] === 'diff') return args.includes('package-lock.json') ? world.lock || '' : world.changed;
      if (args[0] === 'rev-list') return '0 1';
      if (args[0] === 'rev-parse') return world.head || 'running';
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
// Versions are equal and HEAD has server code the running commit lacks: restart_pending.
const pendingWorld = (over = {}) => ({ ...newWorld('services/x.js'), remoteVersion: require('../VERSION.json').app_version, head: 'head-1', ...over });
const afterQuiet = async tick => {
  const realNow = Date.now;
  Date.now = () => realNow() + QUIET + 1000;
  try { tick(); await flush(); } finally { Date.now = realNow; }
};
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

test('update manager: restart pending restarts through server-restart after npm ci when the lock file changed', async () => {
  const world = pendingWorld({ lock: 'package-lock.json' });
  const manager = loadManager(world);
  manager.setIdleProbe(() => quietSnapshot());
  await manager.check();
  const before = manager.publicState();
  assert.equal(before.status, 'restart_pending');
  assert.equal(before.restart_target, 'head-1');
  assert.equal(before.auto_update.state, 'waiting');
  assert.equal(before.auto_update.action, 'restart');
  manager.start();
  world.timers.length = 0;
  const tick = world.intervals.get(TICK_MS);
  tick();
  await flush();
  assert.equal(world.commands.some(entry => entry[0].startsWith('npm')), false, 'the quiet window is still running');
  await afterQuiet(tick);
  const npm = world.commands.findIndex(entry => entry[0].startsWith('npm'));
  const pty = world.commands.findIndex(entry => entry[0] === process.execPath);
  assert.ok(npm >= 0 && world.commands[npm].includes('ci'), 'npm ci ran');
  assert.ok(pty > npm, 'node-pty is checked after npm ci');
  assert.equal(ran(world, 'merge'), false, 'nothing is merged');
  assert.deepEqual(world.timers, [750], 'the exit of lib/server-restart.js is scheduled');
  assert.equal(manager.restartPending(), true, 'pending() blocks updates until the exit');
  await assert.rejects(manager.apply(), /RESTART_PENDING/);
  const status = manager.publicState();
  assert.equal(status.stage, 'restarting');
  assert.equal(status.auto_update.state, 'applying');
  assert.equal(status.auto_update.action, 'restart');

  const next = loadManager(world).publicState();
  assert.equal(next.status, 'current');
  assert.equal(next.auto_update.last_auto_version, require('../VERSION.json').app_version);
  assert.equal(next.auto_update.last_auto_action, 'restart');
  assert.equal(next.auto_update.last_auto_boot, manager.bootId, 'the new process names the one that restarted itself');
  assert.notEqual(next.boot_id, manager.bootId);
});

test('update manager: restart pending without a lock file change skips npm ci', async () => {
  const world = pendingWorld();
  const manager = loadManager(world);
  manager.setIdleProbe(() => quietSnapshot());
  await manager.check();
  manager.start();
  world.timers.length = 0;
  const tick = world.intervals.get(TICK_MS);
  tick();
  await flush();
  await afterQuiet(tick);
  assert.equal(world.commands.some(entry => entry[0].startsWith('npm')), false);
  assert.ok(world.commands.some(entry => entry[0] === process.execPath), 'node-pty is still checked');
  assert.deepEqual(world.timers, [750]);
});

test('update manager: a failed npm ci or node-pty check gives up without a restart', async () => {
  for (const [over, code] of [[{ lock: 'package-lock.json', npmFails: true }, 'NPM_INSTALLING_FAILED'], [{ ptyFails: true }, 'NODE_PTY_LOAD_FAILED']]) {
    const world = pendingWorld(over);
    const manager = loadManager(world);
    manager.setIdleProbe(() => quietSnapshot());
    await manager.check();
    manager.start();
    world.timers.length = 0;
    const tick = world.intervals.get(TICK_MS);
    tick();
    await flush();
    await afterQuiet(tick);
    assert.deepEqual(world.timers, [], `${code}: no exit is scheduled`);
    assert.equal(manager.restartPending(), false);
    const status = manager.publicState();
    assert.equal(status.status, 'restart_pending', 'the old code keeps running and the status says so');
    assert.equal(status.error, code);
    assert.equal(status.auto_update.state, 'gave_up');
    assert.equal(status.auto_update.action, 'restart');
    assert.equal(status.auto_update.last_error, code);
    assert.equal(status.auto_update.last_auto_version, null);
  }
});

test('update manager: HEAD moved since the check, or git cannot tell: no restart and nothing counted', async () => {
  for (const change of [world => { world.head = 'head-2'; }, world => { world.changed = null; world.diffFails = true; }]) {
    const world = pendingWorld();
    const manager = loadManager(world);
    manager.setIdleProbe(() => quietSnapshot());
    await manager.check();
    manager.start();
    world.timers.length = 0;
    const tick = world.intervals.get(TICK_MS);
    tick();
    await flush();
    change(world);
    await afterQuiet(tick);
    assert.deepEqual(world.timers, []);
    assert.equal(world.commands.some(entry => entry[0] === process.execPath), false, 'nothing was prepared');
    const status = manager.publicState();
    assert.equal(status.auto_update.state, 'waiting', 'the next check decides again');
    assert.equal(JSON.parse(world.rows.get('update_auto') || '{}').restart || null, null);
  }
});

test('update manager: a restart accepted from the page stops the automatic restart', async () => {
  const world = pendingWorld();
  const manager = loadManager(world);
  manager.setIdleProbe(() => quietSnapshot());
  await manager.check();
  manager.start();
  world.timers.length = 0;
  const tick = world.intervals.get(TICK_MS);
  tick();
  await flush();
  manager.requestRestart();
  world.commands.length = 0;
  await afterQuiet(tick);
  assert.deepEqual(world.timers, [750], 'only the exit of the restart from the page');
  assert.equal(world.commands.some(entry => entry[0] === process.execPath), false, 'nothing was prepared');
  assert.equal(manager.publicState().auto_update.last_auto_action, null);
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

// Code on disk that is newer than the running process: status restart_pending with the target a restart would load.
function pendingHarness(overrides = {}) {
  const box = harness(overrides);
  box.update = { status: 'restart_pending', local_version: '2.0.0', remote_version: '2.0.0', restart_target: 'abc123' };
  return box;
}
// The same store, read by the process that a restart started.
const nextProcess = (box, bootId) => {
  const next = pendingHarness({ store: box.store, bootId });
  next.clock = box.clock;
  next.update = { ...box.update };
  return next;
};

test('restart pending: an idle service restarts after the quiet window, through the restart injected for it', async () => {
  const box = pendingHarness();
  await box.auto.tick();
  assert.equal(box.state().state, 'waiting');
  assert.equal(box.state().action, 'restart');
  assert.equal(box.state().quiet_until, new Date(box.clock + QUIET).toISOString());
  box.clock += QUIET - 1;
  await box.auto.tick();
  assert.equal(box.restarts.length, 0);
  box.clock += 1;
  await box.auto.tick();
  assert.deepEqual(box.restarts, [{ target: 'abc123' }]);
  assert.equal(box.calls.length, 0, 'no update is applied');
  assert.equal(box.state().state, 'applying');
  assert.equal(box.state().action, 'restart');
  const saved = box.saved();
  assert.equal(saved.last_auto_version, '2.0.0', 'the version that runs after the restart');
  assert.equal(saved.last_auto_action, 'restart');
  assert.equal(saved.last_auto_boot, 'boot-1', 'the process that restarted itself');
  assert.ok(saved.last_auto_at);
  assert.deepEqual({ ...saved.restart, last_at: 0 }, { target: 'abc123', count: 1, last_at: 0, boot: 'boot-1', restarted: true, gave_up: false, last_error: null });
});

test('restart pending: any idle reason resets the quiet window', async () => {
  const reasons = [
    { terminals: [{ state: 'running', subagents: 0, foreground: ['zsh'], shell: 'zsh' }], chat: { running: 0, queued: 0 }, inputs: [] },
    { terminals: [{ state: 'idle', subagents: 2, foreground: ['zsh'], shell: 'zsh' }], chat: { running: 0, queued: 0 }, inputs: [] },
    { terminals: [{ state: 'idle', subagents: 0, foreground: ['vim'], shell: 'zsh' }], chat: { running: 0, queued: 0 }, inputs: [] },
    { terminals: [], chat: { running: 0, queued: 1 }, inputs: [] },
    { terminals: [], chat: { running: 0, queued: 0 }, inputs: [Number.MAX_SAFE_INTEGER] },
  ];
  for (const snapshot of reasons) {
    const box = pendingHarness();
    await box.auto.tick();
    box.clock += QUIET - 1000;
    box.snapshot = () => snapshot;
    await box.auto.tick();
    assert.equal(box.state().waiting_for.length, 1, JSON.stringify(snapshot));
    assert.equal(box.state().quiet_until, null);
    assert.equal(box.state().action, 'restart');
    box.snapshot = quietSnapshot;
    box.clock += 2000;
    await box.auto.tick();
    assert.equal(box.restarts.length, 0, 'the window starts again');
    box.clock += QUIET;
    await box.auto.tick();
    assert.equal(box.restarts.length, 1);
  }
});

test('restart pending: the probe is read again immediately before restarting', async () => {
  const box = pendingHarness();
  await box.auto.tick();
  box.clock += QUIET;
  let reads = 0;
  box.snapshot = () => (reads++ === 0 ? quietSnapshot() : busySnapshot());
  await box.auto.tick();
  assert.equal(reads, 2);
  assert.equal(box.restarts.length, 0);
  assert.equal(box.state().waiting_for[0].code, 'chat_running');
  assert.equal(box.store, null, 'nothing counted');
});

test('restart pending: a target that is no longer pending at the last check is not counted', async () => {
  const box = pendingHarness();
  box.restartResult = async () => ({ stage: 'stale' });
  await box.auto.tick();
  box.clock += QUIET;
  await box.auto.tick();
  assert.equal(box.restarts.length, 1);
  assert.equal(box.saved().restart, null);
  assert.equal(box.saved().last_auto_version, null);
  assert.equal(box.state().state, 'waiting');
});

test('restart pending: a failed preparation (npm ci, node-pty) gives up for that target without restarting', async () => {
  for (const code of ['NPM_INSTALLING_FAILED', 'NODE_PTY_LOAD_FAILED']) {
    const box = pendingHarness();
    box.restartResult = async () => { throw new Error(code); };
    await box.auto.tick();
    box.clock += QUIET;
    await box.auto.tick();
    assert.equal(box.restarts.length, 1);
    assert.equal(box.state().state, 'gave_up');
    assert.equal(box.state().action, 'restart');
    assert.equal(box.state().last_error, code);
    assert.equal(box.saved().last_auto_version, null, 'not reported as a restart');
    box.clock += QUIET * 10;
    await box.auto.tick();
    await box.auto.tick();
    assert.equal(box.restarts.length, 1, 'never again for this target');
  }
});

test('restart pending: a busy lock or a restart from the page meanwhile is not a failure', async () => {
  const box = pendingHarness();
  box.restartResult = async () => { throw new Error('RESTART_PENDING'); };
  await box.auto.tick();
  box.clock += QUIET;
  await box.auto.tick();
  assert.equal(box.restarts.length, 1);
  assert.equal(box.saved().restart, null);
  assert.equal(box.state().state, 'waiting');
  assert.equal(box.state().last_error, null);
});

test('restart pending: at most two restarts per target, one quiet window apart, then RESTART_DID_NOT_HELP', async () => {
  const first = pendingHarness({ bootId: 'boot-1' });
  await first.auto.tick();
  first.clock += QUIET;
  await first.auto.tick();
  assert.equal(first.restarts.length, 1);

  // The new process still finds the same target pending: one more try, after its own quiet window.
  const second = nextProcess(first, 'boot-2');
  assert.equal(second.state().state, 'waiting');
  assert.equal(second.state().last_error, null);
  await second.auto.tick();
  second.clock += QUIET - 1;
  await second.auto.tick();
  assert.equal(second.restarts.length, 0, 'not before a whole quiet window');
  second.clock += 1;
  await second.auto.tick();
  assert.equal(second.restarts.length, 1);
  assert.equal(second.saved().restart.count, MAX_RESTARTS);

  const third = nextProcess(second, 'boot-3');
  assert.equal(third.state().state, 'gave_up', 'known before the first tick');
  assert.equal(third.state().last_error, RESTART_DID_NOT_HELP);
  await third.auto.tick();
  third.clock += QUIET * 5;
  await third.auto.tick();
  assert.equal(third.restarts.length, 0);
  assert.equal(third.saved().restart.gave_up, true);
  assert.equal(third.saved().restart.last_error, RESTART_DID_NOT_HELP);
  assert.equal(third.state().state, 'gave_up');
  assert.equal(third.state().action, 'restart');
});

test('restart pending: a new target starts a new count', async () => {
  const box = pendingHarness();
  box.store = JSON.stringify({ enabled: true, restart: { target: 'abc123', count: MAX_RESTARTS, last_at: 0, boot: 'boot-0', restarted: true, gave_up: true, last_error: RESTART_DID_NOT_HELP } });
  assert.equal(box.state().state, 'gave_up');
  box.update.restart_target = 'def456';
  assert.equal(box.state().state, 'waiting');
  await box.auto.tick();
  box.clock += QUIET;
  await box.auto.tick();
  assert.deepEqual(box.restarts, [{ target: 'def456' }]);
  assert.equal(box.saved().restart.target, 'def456');
  assert.equal(box.saved().restart.count, 1);
});

test('restart pending: an available update takes precedence and runs the update flow', async () => {
  const box = pendingHarness();
  box.update = { status: 'available', remote_version: '3.0.0', local_version: '2.0.0', restart_target: 'abc123', restart_required: true };
  await box.auto.tick();
  assert.equal(box.state().action, 'update');
  box.clock += QUIET;
  await box.auto.tick();
  assert.equal(box.calls.length, 1);
  assert.equal(box.restarts.length, 0);
  assert.equal(box.saved().last_auto_action, 'update');
  assert.equal(box.saved().last_auto_boot, 'boot-1', 'the update restarted this process');
});

test('restart pending: the quiet window of an update does not carry over to a restart', async () => {
  const box = pendingHarness();
  box.update = { status: 'available', remote_version: '3.0.0', restart_required: true };
  await box.auto.tick();
  box.clock += QUIET - 1;
  box.update = { status: 'restart_pending', local_version: '2.0.0', remote_version: '2.0.0', restart_target: 'abc123' };
  await box.auto.tick();
  box.clock += 1;
  await box.auto.tick();
  assert.equal(box.restarts.length, 0, 'a fresh window for the restart');
  assert.equal(box.state().quiet_until, new Date(box.clock - 1 + QUIET).toISOString());
});

test('restart pending: a pending restart from the page skips the tick', async () => {
  const box = pendingHarness();
  await box.auto.tick();
  box.restartPending = true;
  box.clock += QUIET * 2;
  await box.auto.tick();
  assert.equal(box.restarts.length, 0);
  assert.equal(box.store, null);
  box.restartPending = false;
  await box.auto.tick();
  assert.equal(box.restarts.length, 1, 'the wait kept its start');
});

test('restart pending: unsupported, switched off, applying or without a target does nothing', async () => {
  for (const options of [{ supervisor: null }, { checksEnabled: false }]) {
    const box = pendingHarness(options);
    await box.auto.tick();
    box.clock += QUIET * 2;
    await box.auto.tick();
    assert.equal(box.restarts.length, 0);
    assert.equal(box.state().state, 'unsupported');
    assert.equal(box.state().action, null);
  }
  const off = pendingHarness();
  off.auto.setEnabled(false);
  await off.auto.tick();
  off.clock += QUIET * 2;
  await off.auto.tick();
  assert.equal(off.restarts.length, 0);
  assert.equal(off.state().state, 'off');
  const busy = pendingHarness();
  busy.applying = true;
  await busy.auto.tick();
  busy.clock += QUIET * 2;
  await busy.auto.tick();
  assert.equal(busy.restarts.length, 0);
  const unknown = pendingHarness();
  unknown.update.restart_target = null;
  await unknown.auto.tick();
  unknown.clock += QUIET * 2;
  await unknown.auto.tick();
  assert.equal(unknown.restarts.length, 0);
  assert.equal(unknown.state().state, 'idle');
});

test('a frontend-only automatic update names no replaced process', async () => {
  const box = harness();
  box.update.restart_required = false;
  box.result = async () => ({ stage: 'completed', remote_version: '2.0.0' });
  await box.auto.tick();
  assert.equal(box.saved().last_auto_action, 'update');
  assert.equal(box.saved().last_auto_boot, null, 'a manual restart later must not look automatic to the page');
});
