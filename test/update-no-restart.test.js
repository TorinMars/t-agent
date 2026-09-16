const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const filename = require.resolve('../services/update-manager');
const realRequire = createRequire(filename);

for (const changed of ['public/js/mobile.js', 'services/engine-tasks.js']) {
  test(`update execution chooses restart correctly for ${changed}`, async () => {
    const commands = [], timers = [];
    let backups = 0;
    const remote = { ...require('../VERSION.json'), app_version: '99.0.0' };
    const mocks = {
      fs: { ...fs, mkdirSync() {} },
      child_process: { execFileSync: () => 'running' },
      '../db': { prepare: () => ({ get() {}, run() {} }), backup: async () => { backups++; } },
      '../config': { gitRemote: 'origin', gitBranch: 'main', updateCheckIntervalMs: 1000 },
      '../lib/update-command': { logUpdate() {}, runUpdateCommand: async (file, args) => {
        commands.push([file, ...args]);
        if (file !== 'git') return '';
        if (args[0] === 'show') return JSON.stringify(remote);
        if (args[0] === 'diff') return changed;
        if (args[0] === 'rev-list') return '0 1';
        if (args[0] === 'rev-parse') return 'running';
        return '';
      } },
      '../lib/git-update-workspace': { prepareWorkspace: async () => null },
    };
    const context = { require: name => mocks[name] || realRequire(name), module: { exports: {} },
      __dirname: path.dirname(filename), process: { env: {}, platform: process.platform, execPath: process.execPath },
      setTimeout: (fn, delay) => { timers.push(delay); return { unref() {} }; }, console };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context);
    const state = await context.module.exports.apply();
    assert.equal(backups, 1);
    assert.ok(commands.some(command => command[1] === 'merge'));
    const hot = changed.startsWith('public/');
    assert.equal(state.stage, hot ? 'completed' : 'restarting');
    assert.equal(commands.some(command => command[0].startsWith('npm')), !hot);
    assert.equal(timers.length, hot ? 0 : 1);
  });
}
