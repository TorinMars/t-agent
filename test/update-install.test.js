// What an update runs and what it prints (services/update-manager.js): `npm ci` without the dev dependencies and no build, and a version check whose
// Git commands stay out of the service log. The update manager is the real one, with its git, npm, database and exit mocked as in update-no-restart.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const filename = require.resolve('../services/update-manager');
const realRequire = createRequire(filename);

// `changed` is what `git diff --name-only` answers: a server file makes the update install and restart.
function loadManager({ changed = 'services/engine-tasks.js', env = {} } = {}) {
  const calls = [];
  const remote = { ...require('../VERSION.json'), app_version: '99.0.0' };
  const mocks = {
    fs: { ...fs, mkdirSync() {} },
    child_process: { execFileSync: () => 'running' },
    '../db': { prepare: () => ({ get() {}, run() {} }), backup: async () => {} },
    '../config': { gitRemote: 'origin', gitBranch: 'main', updateCheckIntervalMs: 1000 },
    '../lib/update-command': {
      logUpdate() {}, recentLog: () => [], clearLog() {},
      runUpdateCommand: async (file, args, options, settings = {}) => {
        calls.push({ file, args, options, settings });
        if (file !== 'git') return '';
        if (args[0] === 'show') return JSON.stringify(remote);
        if (args[0] === 'diff') return changed;
        if (args[0] === 'rev-list') return '0 1';
        if (args[0] === 'rev-parse') return 'running';
        return '';
      },
      runWithProgress: (label, run) => run(() => {}),
    },
    // The backup folder comes from the data folder; a test must never resolve the real ~/.tagent.
    '../lib/data-home': { prepare: () => ({ backupsDir: path.join(os.tmpdir(), 'update-install-backups') }) },
    '../lib/git-update-workspace': { prepareWorkspace: async () => null, trackedChanges: async () => [], dirtyError: changes => Object.assign(new Error('WORKTREE_DIRTY'), { details: changes.join(',') }) },
  };
  const context = {
    require: name => mocks[name] || realRequire(name), module: { exports: {} }, __dirname: path.dirname(filename),
    process: { env, platform: process.platform, execPath: process.execPath },
    setTimeout: () => ({ unref() {} }), console,
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context);
  return { manager: context.module.exports, calls };
}

const isNpm = call => /^npm(\.cmd)?$/.test(call.file);
const flush = async () => { for (let index = 0; index < 20; index += 1) await new Promise(resolve => setImmediate(resolve)); };

test('an update installs only what the service runs: one npm ci without the dev dependencies, then the node-pty check, and no build', async () => {
  const { manager, calls } = loadManager();
  const state = await manager.apply();
  assert.equal(state.stage, 'restarting');
  const npm = calls.filter(isNpm);
  assert.equal(npm.length, 1, 'npm runs once: there is no build step');
  assert.deepEqual([...npm[0].args], ['ci', '--omit=dev', '--ignore-scripts=false']);
  assert.equal(npm[0].settings.stage, 'installing');
  assert.equal(npm[0].settings.errorCode, 'NPM_INSTALLING_FAILED');
  assert.equal(npm[0].settings.streamOutput, true, 'the output is followed line by line, for the progress text');
  assert.equal(typeof npm[0].settings.onOutput, 'function');
  assert.equal(npm[0].options.env.npm_config_loglevel, 'http', 'a line for every download, so the dialog can tell a stalled download');
  const verify = calls.findIndex(call => call.file === process.execPath && String(call.args[0]).endsWith(path.join('scripts', 'verify-node-pty.js')));
  assert.ok(verify > calls.indexOf(npm[0]), 'node-pty is checked after the install');
});

test('npm settings of the service environment reach the install, so include=dev can keep the dev dependencies in a checkout that is developed in', async () => {
  const { manager, calls } = loadManager({ env: { npm_config_include: 'dev', npm_config_loglevel: 'warn' } });
  await manager.apply();
  const npm = calls.find(isNpm);
  assert.equal(npm.options.env.npm_config_include, 'dev');
  assert.equal(npm.options.env.npm_config_loglevel, 'warn', 'a log level the user set is kept');
});

test('a frontend-only update runs no npm at all', async () => {
  const { manager, calls } = loadManager({ changed: 'public/js/mobile.js' });
  const state = await manager.apply();
  assert.equal(state.stage, 'completed');
  assert.equal(calls.some(isNpm), false);
});

test('a version check keeps its Git commands out of the service log; the same commands inside an update are printed', async () => {
  const { manager, calls } = loadManager();
  const checked = await manager.check();
  await flush();
  assert.equal(checked.status, 'available');
  const checkCalls = calls.splice(0);
  assert.deepEqual([...new Set(checkCalls.map(call => call.file))], ['git']);
  for (const command of ['fetch', 'show', 'diff']) assert.ok(checkCalls.some(call => call.args[0] === command), `the check runs git ${command}`);
  assert.deepEqual(checkCalls.filter(call => call.settings.quiet !== true).map(call => call.args.join(' ')), [], 'every command of the check is quiet');

  await manager.apply();
  assert.ok(calls.filter(call => call.file === 'git').length >= checkCalls.length, 'the update checks again, then fetches and merges');
  assert.deepEqual(calls.filter(call => call.settings.quiet).map(call => `${call.file} ${call.args.join(' ')}`), [], 'nothing an update runs is quiet');
});
