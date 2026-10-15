// The update check compares the remote version with the on-disk VERSION.json. When the on-disk code is newer than the running process (manual git pull, an update that failed halfway,
// a forced repository restore ...) it must report "restart needed", not "already up to date".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const filename = require.resolve('../services/update-manager');
const realRequire = createRequire(filename);
const current = require('../VERSION.json');
const manifest = version => ({ ...current, app_version: version });

function load({ gitInstall = true, runningCommit = 'running-commit', diffs = {}, diffError = null, remoteVersion = current.app_version,
  startupVersion = null, persisted = null } = {}) {
  const versionPath = path.join(path.dirname(filename), '..', 'VERSION.json');
  let versionReads = 0;
  const mocks = {
    fs: {
      ...fs,
      mkdirSync() {},
      existsSync: target => (String(target).endsWith(`${path.sep}.git`) ? gitInstall : fs.existsSync(target)),
      // The version read when the module loads (process start) may differ from the one on disk now.
      readFileSync: (target, ...rest) => {
        if (target === versionPath && startupVersion && versionReads++ === 0) return JSON.stringify(manifest(startupVersion));
        return fs.readFileSync(target, ...rest);
      },
    },
    child_process: { execFileSync: () => { if (!runningCommit) throw new Error('not a git repository'); return runningCommit; } },
    https: { get(url, options, callback) {
      const req = new EventEmitter(); req.destroy = () => {};
      setImmediate(() => {
        const res = new EventEmitter(); res.statusCode = 200; res.headers = {}; res.resume = () => {};
        callback(res); res.emit('data', Buffer.from(JSON.stringify(manifest(remoteVersion)))); res.emit('end');
      });
      return req;
    } },
    '../db': { prepare: () => ({ get: () => (persisted ? { value: JSON.stringify(persisted) } : undefined), run() {} }) },
    '../config': { gitRemote: 'origin', gitBranch: 'main', updateCheckIntervalMs: 1000, githubVersionUrl: '', githubToken: '', updateRepository: 'TorinMars/t-agent', updateRef: 'main' },
    '../lib/update-command': { logUpdate() {}, recentLog: () => [], clearLog() {}, runUpdateCommand: async (file, args) => {
      if (file !== 'git') return '';
      if (args[0] === 'show') return JSON.stringify(manifest(remoteVersion));
      if (args[0] === 'diff') {
        const target = args[4];
        if (target === 'HEAD' && diffError) throw diffError;
        return diffs[target] || '';
      }
      return '';
    } },
    '../lib/git-update-workspace': { prepareWorkspace: async () => null, trackedChanges: async () => [], dirtyError: () => new Error('WORKTREE_DIRTY') },
  };
  const context = { require: name => mocks[name] || realRequire(name), module: { exports: {} }, __dirname: path.dirname(filename),
    process: { env: {}, platform: process.platform, execPath: process.execPath }, setTimeout: () => ({ unref() {} }), setInterval: () => ({ unref() {} }), console, Buffer, URL, URLSearchParams };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context);
  return context.module.exports;
}

const RESTART_FILE = 'services/apps-service.js\0';

test('Git install: same version but the on-disk code is newer than the running process and needs a restart → restart_pending, not up to date', async () => {
  const updates = load({ diffs: { HEAD: RESTART_FILE, 'origin/main': RESTART_FILE } });
  const state = await updates.check({ force: true });
  assert.equal(state.status, 'restart_pending');
  assert.equal(state.restart_pending, true);
  assert.equal(state.local_version, current.app_version);
  assert.equal(state.remote_version, current.app_version);
  assert.match(state.message, /restart the service for it to take effect/);
  assert.ok(state.message.includes(current.app_version));
  assert.notEqual(state.message, 'Already up to date');
});

test('When only hot-updatable files such as the frontend changed no restart is needed → still current', async () => {
  const hot = 'public/js/app.js\0README.md\0docs/HANDOFF.md\0';
  const state = await load({ diffs: { HEAD: hot, 'origin/main': hot } }).check({ force: true });
  assert.equal(state.status, 'current');
  assert.equal(state.restart_pending, false);
  assert.equal(state.message, 'Already up to date');
});

test('The on-disk code is identical to the running code → current', async () => {
  const state = await load().check({ force: true });
  assert.equal(state.status, 'current');
  assert.equal(state.restart_pending, false);
});

test('When the remote has a higher version it is still available (and flags that the running code is behind the disk)', async () => {
  const state = await load({ remoteVersion: '99.0.0', diffs: { HEAD: RESTART_FILE, 'origin/main': RESTART_FILE } }).check({ force: true });
  assert.equal(state.status, 'available');
  assert.equal(state.restart_pending, true);
  assert.equal(state.remote_version, '99.0.0');
});

test('If the start commit cannot be obtained, or git errors while deciding whether a restart is needed, the check result is unaffected', async () => {
  const noCommit = await load({ runningCommit: null }).check({ force: true });
  assert.equal(noCommit.status, 'current');
  assert.equal(noCommit.restart_pending, false);

  const failing = await load({ diffError: new Error('bad object'), diffs: { 'origin/main': '' } }).check({ force: true });
  assert.equal(failing.status, 'current', 'A failure of the auxiliary check must not fail the whole check');
  assert.equal(failing.error, null);
});

test('Package install: version at start differs from disk → restart_pending; same → current', async () => {
  const pending = await load({ gitInstall: false, startupVersion: '1.0.0' }).check({ force: true });
  assert.equal(pending.status, 'restart_pending');
  assert.equal(pending.running_version, '1.0.0');
  assert.match(pending.message, /1\.0\.0/);

  const same = await load({ gitInstall: false }).check({ force: true });
  assert.equal(same.status, 'current');
  assert.equal(same.running_version, current.app_version);
});

test('After the service restarts, the previously saved “restart needed” state is cleared and decided again at the next check', () => {
  const stale = { status: 'restart_pending', restart_pending: true, message: 'restart needed', local_version: current.app_version, remote_version: current.app_version };
  const state = load({ persisted: stale }).publicState();
  assert.equal(state.status, 'current');
  assert.equal(state.restart_pending, false);
  assert.equal(state.message, 'Already up to date');
});
