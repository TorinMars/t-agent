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
  async waitFor(count) {
    for (let i = 0; this.sent.length < count && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(this.sent.length >= count, 'timed out waiting for terminal output');
  }
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

test('independent shells preserve histories across switching; control only affects the selected terminal', async () => {
  const added = terminal.createTerminal(task.id);
  const first = connect('default');
  const second = connect(added.terminal_id);
  assert.equal(shells.length, 2);
  assert.equal(first.readyState, 1);
  assert.equal(shells[1].options.cwd, task.work_dir);
  first.emit('message', 'first command');
  second.emit('message', 'second command');
  assert.deepEqual(shells.map(s => s.input), [['first command'], ['second command']]);
  await Promise.all([first.waitFor(1), second.waitFor(1)]);
  first.sent.length = 0; second.sent.length = 0;
  shells[0].data('FIRST HISTORY');
  shells[1].data('SECOND HISTORY');
  await Promise.all([first.waitFor(1), second.waitFor(1)]);
  assert.deepEqual(first.sent, ['FIRST HISTORY']);
  assert.deepEqual(second.sent, ['SECOND HISTORY']);
  second.close(1000, 'switch');
  assert.equal(shells[1].killed, false);
  const reconnected = connect(added.terminal_id);
  assert.equal(shells.length, 2);
  await reconnected.waitFor(1);
  assert.match(JSON.parse(reconnected.sent[0]).data, /SECOND HISTORY/);
  terminal.controlSession(task.id, 'restart-workdir', added.terminal_id);
  assert.equal(shells[0].killed, false);
  assert.equal(shells[1].killed, true);
  const restarted = connect(added.terminal_id);
  assert.equal(shells.length, 3);
  await restarted.waitFor(1);
  assert.doesNotMatch(JSON.parse(restarted.sent[0]).data, /SECOND HISTORY/);
  shells[1].data('late output from old shell');
  restarted.close(1000, 'switch');
  const empty = connect(added.terminal_id);
  await empty.waitFor(1);
  assert.doesNotMatch(JSON.parse(empty.sent[0]).data, /SECOND HISTORY/);
  assert.equal(first.readyState, 1);
  terminal.controlSession(task.id, 'close', added.terminal_id);
  shells[0].data(' STILL RUNNING');
  await first.waitFor(2);
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

test('deleting an extra terminal stops its shell and permanently removes its history and tab', () => {
  const added = terminal.createTerminal(task.id);
  const ws = connect(added.terminal_id);
  const shell = shells.at(-1);
  shell.data('history to delete');
  terminal.controlSession(task.id, 'delete', added.terminal_id);
  assert.equal(shell.killed, true);
  assert.equal(ws.readyState, 3);
  assert.equal(db.prepare('SELECT * FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(task.id, added.terminal_id), undefined);
  shell.data('late output');
  shell.exit();
  assert.equal(terminal.listTerminals(task.id).some(row => row.terminal_id === added.terminal_id), false);
  assert.equal(connect(added.terminal_id).code, 1008);
  assert.throws(() => terminal.controlSession(task.id, 'delete', 'default'), /DEFAULT_TERMINAL_CANNOT_DELETE/);
  const closed = terminal.createTerminal(task.id);
  terminal.controlSession(task.id, 'close', closed.terminal_id);
  terminal.controlSession(task.id, 'delete', closed.terminal_id);
  assert.throws(() => terminal.assertTerminal(task.id, closed.terminal_id), /TERMINAL_NOT_FOUND/);
});

test('history controls are scoped, bounded and never passed to PTY; snapshot precedes live bytes', async () => {
  const added = terminal.createTerminal(task.id);
  db.prepare('UPDATE task_terminals SET buffer = ? WHERE task_id = ? AND terminal_id = ?')
    .run(Array.from({ length: 2000 }, (_, i) => `old-${i}\r\n`).join(''), task.id, added.terminal_id);
  const ws = connect(added.terminal_id);
  const shell = shells.at(-1);
  shell.data('LIVE-A'); shell.data('LIVE-B');
  await ws.waitFor(3);
  const history = JSON.parse(ws.sent[0]);
  assert.equal(history.type, 'history');
  assert.doesNotMatch(history.data, /LIVE-|old-100\r/);
  assert.deepEqual(ws.sent.slice(1), ['LIVE-A', 'LIVE-B']);
  const request = { type: 'history-page', ...history.archive, requestId: 'r' };
  ws.emit('message', JSON.stringify(request));
  const page = JSON.parse(ws.sent.at(-1));
  assert.match(page.data, /old-1999/);
  assert.doesNotMatch(page.data, /LIVE-/);
  assert.ok(page.data.split('\n').filter(Boolean).length <= 500);
  ws.emit('message', JSON.stringify({ ...request, id: 'foreign' }));
  assert.equal(JSON.parse(ws.sent.at(-1)).error, 'INVALID_HISTORY_REQUEST');
  ws.emit('message', '{"type":"history-page",broken');
  ws.emit('message', JSON.stringify({ type: 'history-future' }));
  assert.deepEqual(shell.input, []);
  const next = connect(added.terminal_id);
  await next.waitFor(1);
  const before = next.sent.length;
  ws.emit('message', JSON.stringify(request));
  assert.equal(next.sent.length, before);
  next.emit('message', JSON.stringify(request));
  assert.equal(JSON.parse(next.sent.at(-1)).error, 'INVALID_HISTORY_REQUEST');
  db.prepare('UPDATE tasks SET user_id = ? WHERE id = ?').run('other-owner', task.id);
  next.emit('message', JSON.stringify(request));
  assert.equal(next.code, 1008);
  assert.deepEqual(shell.input, []);
  db.prepare('UPDATE tasks SET user_id = ? WHERE id = ?').run('owner', task.id);
  terminal.controlSession(task.id, 'delete', added.terminal_id);
});

test('natural PTY exit drains final live bytes and snapshot before closing', async () => {
  const added = terminal.createTerminal(task.id);
  const ws = connect(added.terminal_id);
  const shell = shells.at(-1);
  shell.data('last-line');
  shell.exit();
  await ws.waitFor(2);
  for (let i = 0; ws.readyState === 1 && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(JSON.parse(ws.sent[0]).type, 'history');
  assert.equal(ws.sent[1], 'last-line');
  assert.equal(ws.reason, 'terminal exited');
  assert.equal(db.prepare('SELECT buffer FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(task.id, added.terminal_id).buffer, 'last-line');
  terminal.controlSession(task.id, 'delete', added.terminal_id);
});
