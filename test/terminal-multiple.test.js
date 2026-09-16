const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-multiple-'));
process.env.T_AGENT_DATA_DIR = root;
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
const db = require('../db');
const tasks = require('../services/engine-tasks');
const shells = [];
const terminalPath = path.resolve(__dirname, '../routes/terminal.js');
const mod = { exports: {} };
vm.runInNewContext(fs.readFileSync(terminalPath, 'utf8'), {
  module: mod, __dirname: path.dirname(terminalPath), process, console, URL,
  setInterval, clearInterval,
  require(name) {
    if (name === '../lib/node-pty-runtime') return { repairSpawnHelperPermissions() {} };
    if (name === 'node-pty') return { spawn(shell, args, options) {
      const pty = { options, input: [], killed: false,
        onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; },
        write(text) { this.input.push(text); }, resize() {},
        kill() { this.killed = true; this.exit(); },
      };
      shells.push(pty);
      return pty;
    } };
    return require(name.startsWith('.') ? path.resolve(path.dirname(terminalPath), name) : name);
  },
});
const terminal = mod.exports;
class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(data) { this.sent.push(data); }
  close(code, reason) { this.readyState = 3; this.code = code; this.reason = reason; this.emit('close'); }
}
const task = tasks.createTask('owner', { title: 'multiple' });
function connect(id, owner = 'owner') {
  const ws = new Socket();
  terminal.handleWs(ws, { url: `/terminal/ws?taskId=${task.id}&terminalId=${id}` }, { login: owner });
  return ws;
}
test.after(() => {
  terminal.closeTaskTerminals(task.id);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('independent shells preserve histories across switching; control only affects the selected terminal', () => {
  const added = terminal.createTerminal(task.id);
  const first = connect('default');
  const second = connect(added.terminal_id);
  assert.equal(shells.length, 2);
  assert.equal(first.readyState, 1);
  assert.equal(shells[1].options.cwd, task.work_dir);
  first.emit('message', 'first command');
  second.emit('message', 'second command');
  assert.deepEqual(shells.map(s => s.input), [['first command'], ['second command']]);
  shells[0].data('FIRST HISTORY');
  shells[1].data('SECOND HISTORY');
  assert.deepEqual(first.sent, ['FIRST HISTORY']);
  assert.deepEqual(second.sent, ['SECOND HISTORY']);
  second.close(1000, 'switch');
  assert.equal(shells[1].killed, false);
  const reconnected = connect(added.terminal_id);
  assert.equal(shells.length, 2);
  assert.equal(JSON.parse(reconnected.sent[0]).data, 'SECOND HISTORY');
  terminal.controlSession(task.id, 'restart-workdir', added.terminal_id);
  assert.equal(shells[0].killed, false);
  assert.equal(shells[1].killed, true);
  const restarted = connect(added.terminal_id);
  assert.equal(shells.length, 3);
  assert.equal(restarted.sent.length, 0);
  shells[1].data('late output from old shell');
  restarted.close(1000, 'switch');
  assert.equal(connect(added.terminal_id).sent.length, 0);
  assert.equal(first.readyState, 1);
  terminal.controlSession(task.id, 'close', added.terminal_id);
  shells[0].data(' STILL RUNNING');
  assert.equal(first.sent.at(-1), ' STILL RUNNING');
  terminal.controlSession(task.id, 'close');
  assert.equal(db.prepare('SELECT buffer FROM terminal_logs WHERE task_id = ?').get(task.id).buffer, 'FIRST HISTORY STILL RUNNING');
});

test('terminal IDs cannot address other tasks or bypass ownership', () => {
  const other = tasks.createTask('owner', { title: 'other' });
  const foreign = terminal.createTerminal(other.id);
  assert.throws(() => terminal.controlSession(task.id, 'close', foreign.terminal_id), /TERMINAL_NOT_FOUND/);
  assert.throws(() => terminal.assertTerminal(task.id, '../escape'), /INVALID_TERMINAL_ID/);
  const count = shells.length;
  assert.equal(connect(foreign.terminal_id).code, 1008);
  assert.equal(connect('default', 'stranger').code, 1008);
  assert.equal(shells.length, count);
  assert.equal(terminal.listTerminals(task.id).length, 2);
});
