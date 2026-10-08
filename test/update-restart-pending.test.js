// 检查更新是拿远程版本和“磁盘上的 VERSION.json”比较的。磁盘代码比运行中的进程新（手动 git pull、上次更新中途失败、
// 强制恢复仓库……）时，必须报“需要重启”，而不是“已是最新版本”。
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
      // 模块加载时（进程启动）读到的版本号可以和现在磁盘上的不同。
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
    '../lib/update-command': { logUpdate() {}, runUpdateCommand: async (file, args) => {
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

test('Git 安装：版本一致但磁盘代码比运行中的进程新且需要重启 → restart_pending，而不是已是最新', async () => {
  const updates = load({ diffs: { HEAD: RESTART_FILE, 'origin/main': RESTART_FILE } });
  const state = await updates.check({ force: true });
  assert.equal(state.status, 'restart_pending');
  assert.equal(state.restart_pending, true);
  assert.equal(state.local_version, current.app_version);
  assert.equal(state.remote_version, current.app_version);
  assert.match(state.message, /需要重启服务才会生效/);
  assert.ok(state.message.includes(current.app_version));
  assert.notEqual(state.message, '已是最新版本');
});

test('只改了前端等热更新文件时不需要重启 → 仍是 current', async () => {
  const hot = 'public/js/app.js\0README.md\0docs/HANDOFF.md\0';
  const state = await load({ diffs: { HEAD: hot, 'origin/main': hot } }).check({ force: true });
  assert.equal(state.status, 'current');
  assert.equal(state.restart_pending, false);
  assert.equal(state.message, '已是最新版本');
});

test('磁盘上的代码和运行中的完全一致 → current', async () => {
  const state = await load().check({ force: true });
  assert.equal(state.status, 'current');
  assert.equal(state.restart_pending, false);
});

test('远程有更高版本时仍是 available（并标出运行中的代码已经落后于磁盘）', async () => {
  const state = await load({ remoteVersion: '99.0.0', diffs: { HEAD: RESTART_FILE, 'origin/main': RESTART_FILE } }).check({ force: true });
  assert.equal(state.status, 'available');
  assert.equal(state.restart_pending, true);
  assert.equal(state.remote_version, '99.0.0');
});

test('拿不到启动提交，或判断是否需要重启时 git 出错，都不影响检查结果', async () => {
  const noCommit = await load({ runningCommit: null }).check({ force: true });
  assert.equal(noCommit.status, 'current');
  assert.equal(noCommit.restart_pending, false);

  const failing = await load({ diffError: new Error('bad object'), diffs: { 'origin/main': '' } }).check({ force: true });
  assert.equal(failing.status, 'current', '辅助判断失败时不能让整个检查失败');
  assert.equal(failing.error, null);
});

test('安装包方式：启动时的版本号和磁盘上不同 → restart_pending；相同 → current', async () => {
  const pending = await load({ gitInstall: false, startupVersion: '1.0.0' }).check({ force: true });
  assert.equal(pending.status, 'restart_pending');
  assert.equal(pending.running_version, '1.0.0');
  assert.match(pending.message, /1\.0\.0/);

  const same = await load({ gitInstall: false }).check({ force: true });
  assert.equal(same.status, 'current');
  assert.equal(same.running_version, current.app_version);
});

test('服务重启后，上次保存的“需要重启”状态会被清掉，等下一次检查再判断', () => {
  const stale = { status: 'restart_pending', restart_pending: true, message: '需要重启', local_version: current.app_version, remote_version: current.app_version };
  const state = load({ persisted: stale }).publicState();
  assert.equal(state.status, 'current');
  assert.equal(state.restart_pending, false);
  assert.equal(state.message, '已是最新版本');
});
