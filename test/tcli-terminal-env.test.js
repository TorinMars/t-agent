// tcli in T-Agent terminals: routes/terminal.js gives every shell that has TA_HOOK_URL and TA_HOOK_TOKEN also TA_TCLI, the absolute path of
// this install's scripts/tcli.js, and drops an inherited TA_TCLI (a server started inside another T-Agent terminal). node-pty is mocked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-tcli-env-'));
process.env.T_AGENT_DATA_DIR = root;
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
const home = path.join(root, 'home');
fs.mkdirSync(home);
process.env.HOME = home;
process.env.TA_TCLI = '/outer/install/scripts/tcli.js';
process.env.TA_HOOK_URL = 'http://outer.invalid/hooks/terminal-activity?task=1&terminal=x';
process.env.TA_HOOK_TOKEN = 'outer-token';
const db = require('../db');
const tasks = require('../services/engine-tasks');
const shells = [];
const terminalPath = path.resolve(__dirname, '../routes/terminal.js');
const mod = { exports: {} };
vm.runInNewContext(fs.readFileSync(terminalPath, 'utf8'), {
  module: mod, __dirname: path.dirname(terminalPath), process, console, URL,
  setInterval, clearInterval, setTimeout, clearTimeout, Buffer,
  require(name) {
    if (name === '../lib/node-pty-runtime') return { repairSpawnHelperPermissions() {} };
    if (name === 'node-pty') return { spawn(shell, args, options) {
      const pty = { options, input: [], onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; },
        write(text) { this.input.push(text); }, pause() {}, resume() {}, resize() {}, kill() { this.exit(); } };
      shells.push(pty);
      return pty;
    } };
    return require(name.startsWith('.') ? path.resolve(path.dirname(terminalPath), name) : name);
  },
});
const terminal = mod.exports;
class Socket extends EventEmitter {
  readyState = 1;
  send() {}
  close() { this.readyState = 3; this.emit('close'); }
}
const task = tasks.createTask('owner', { title: 'tcli env' });
const open = id => {
  terminal.handleWs(new Socket(), { url: `/terminal/ws?taskId=${task.id}&terminalId=${id}&clientId=test` }, { login: 'owner' });
  return shells.at(-1).options.env;
};

test.after(() => {
  terminal.closeTaskTerminals(task.id);
  terminal.setHookEndpoint(null);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('without the hook endpoint there is no TA_TCLI, and an inherited one is dropped', () => {
  terminal.setHookEndpoint(null);
  const row = terminal.createTerminal(task.id);
  const env = open(row.terminal_id);
  assert.equal(env.TA_TCLI, undefined);
  assert.equal(env.TA_HOOK_URL, undefined);
  terminal.controlSession(task.id, 'delete', row.terminal_id);
});

test('with the hook endpoint every shell gets TA_TCLI next to its own TA_HOOK_URL and TA_HOOK_TOKEN', () => {
  terminal.setHookEndpoint('http://127.0.0.1:4567/hooks/terminal-activity');
  const row = terminal.createTerminal(task.id);
  const env = open(row.terminal_id);
  const cli = path.resolve(__dirname, '../scripts/tcli.js');
  assert.equal(env.TA_TCLI, cli);
  assert.ok(path.isAbsolute(env.TA_TCLI));
  assert.ok(fs.statSync(cli).mode & 0o111, 'tcli is executable');
  assert.equal(env.TA_HOOK_URL, `http://127.0.0.1:4567/hooks/terminal-activity?task=${task.id}&terminal=${row.terminal_id}`);
  assert.ok(terminal.verifyHookToken(task.id, row.terminal_id, env.TA_HOOK_TOKEN), 'the token tcli sends is this terminal\'s hook token');
  terminal.controlSession(task.id, 'delete', row.terminal_id);
});
