// Foreground presence of terminals (lib/terminal-presence.js, the `presence` control message of routes/terminal.js handleWs): reported per socket,
// dropped when the socket closes, rate capped, and never written to the PTY.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createPresence } = require('../lib/terminal-presence');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-presence-'));
process.env.T_AGENT_DATA_DIR = root;
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
const db = require('../db');
const tasks = require('../test-support/older-tasks').olderTasks(require('../services/engine-tasks'), db);
const shells = [];
const terminalPath = path.resolve(__dirname, '../routes/terminal.js');
const mod = { exports: {} };
vm.runInNewContext(fs.readFileSync(terminalPath, 'utf8'), {
  module: mod, __dirname: path.dirname(terminalPath), process, console, URL,
  setInterval, clearInterval, Buffer,
  require(name) {
    if (name === '../lib/node-pty-runtime') return { repairSpawnHelperPermissions() {} };
    if (name === 'node-pty') return { spawn(shell, args, options) {
      const pty = { options, input: [], killed: false,
        onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; },
        write(text) { this.input.push(text); }, pause() {}, resume() {}, resize(cols, rows) { this.size = [cols, rows]; },
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
  bufferedAmount = 0;
  send(data) { this.sent.push(data); }
  ping() {}
  close(code, reason) { if (this.readyState === 3) return; this.readyState = 3; this.code = code; this.reason = reason; this.emit('close'); }
}
const task = tasks.createTask('owner', { title: 'presence' });
function connect(id, client = 'page-1', extra = '&proto=2') {
  const ws = new Socket();
  terminal.handleWs(ws, { url: `/terminal/ws?taskId=${task.id}&terminalId=${id}&clientId=${client}${extra}` }, { login: 'owner' });
  return ws;
}
const control = (ws, message) => ws.emit('message', Buffer.from(typeof message === 'string' ? message : JSON.stringify(message)), true);
test.after(() => {
  terminal.closeTaskTerminals(task.id);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('presence on and off over the socket; closing drops it; nothing reaches the PTY', () => {
  const added = terminal.createTerminal(task.id);
  const id = added.terminal_id;
  const ws = connect(id);
  const shell = shells.at(-1);
  assert.equal(terminal.isTerminalForeground(task.id, id), false, 'unknown until the page says');
  control(ws, { type: 'presence', foreground: true });
  assert.equal(terminal.isTerminalForeground(task.id, id), true);
  assert.equal(terminal.isTerminalForeground(String(task.id), id), true, 'the ids of context.tagent are strings');
  assert.deepEqual(terminal.presenceSnapshot()[`${task.id}:${id}`], { sockets: 1, foreground: true });
  control(ws, { type: 'presence', foreground: false });
  assert.equal(terminal.isTerminalForeground(task.id, id), false);
  control(ws, { type: 'presence', foreground: true });
  control(ws, { type: 'presence', foreground: 'yes' }); // not a boolean: ignored
  assert.equal(terminal.isTerminalForeground(task.id, id), true);
  // A different terminal of the same task is not in the foreground.
  assert.equal(terminal.isTerminalForeground(task.id, 'default'), false);
  assert.equal(terminal.isTerminalForeground(task.id, undefined), false);
  ws.close(1000, 'gone');
  assert.equal(terminal.isTerminalForeground(task.id, id), false, 'a closed socket drops out');
  assert.equal(terminal.presenceSnapshot()[`${task.id}:${id}`], undefined);
  assert.deepEqual(shell.input, [], 'presence and malformed controls are never typed into the shell');
});

test('a replacing socket of the same page starts unknown; a takeover drops the old one; unknown controls are still ignored', () => {
  const id = terminal.createTerminal(task.id).terminal_id;
  const first = connect(id, 'page-a');
  const shell = shells.at(-1);
  control(first, { type: 'presence', foreground: true });
  const second = connect(id, 'page-a'); // reconnect of the same page: the old socket is closed
  assert.equal(first.readyState, 3);
  assert.equal(terminal.isTerminalForeground(task.id, id), false);
  control(first, { type: 'presence', foreground: true }); // a late frame of the closed socket
  assert.equal(terminal.isTerminalForeground(task.id, id), false);
  control(second, { type: 'presence', foreground: true });
  assert.equal(terminal.isTerminalForeground(task.id, id), true);
  const other = connect(id, 'page-b', '&proto=2&takeover=1');
  assert.equal(second.readyState, 3);
  assert.equal(terminal.isTerminalForeground(task.id, id), false, 'another device took it over and has not said yet');
  control(other, { type: 'something-new', foreground: true });
  control(other, '{not json');
  assert.equal(terminal.isTerminalForeground(task.id, id), false);
  other.emit('message', Buffer.from('echo typed'), false);
  assert.deepEqual(shell.input, ['echo typed'], 'only the text frame is input');
  other.close();
});

test('a flood of presence messages is ignored after the per-socket cap', () => {
  const id = terminal.createTerminal(task.id).terminal_id;
  const ws = connect(id, 'page-flood');
  const shell = shells.at(-1);
  for (let i = 0; i < 20; i += 1) control(ws, { type: 'presence', foreground: i % 2 === 1 });
  assert.equal(terminal.isTerminalForeground(task.id, id), true, 'the 20th (true) was accepted');
  for (let i = 0; i < 50; i += 1) control(ws, { type: 'presence', foreground: false });
  assert.equal(terminal.isTerminalForeground(task.id, id), true, 'the rest of the flood is ignored');
  assert.deepEqual(shell.input, []);
  ws.close();
  assert.equal(terminal.isTerminalForeground(task.id, id), false);
});

test('an old text-protocol page: a presence text frame is a control, not input', () => {
  const id = terminal.createTerminal(task.id).terminal_id;
  const ws = connect(id, 'page-old', '');
  const shell = shells.at(-1);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'presence', foreground: true })), false);
  assert.equal(terminal.isTerminalForeground(task.id, id), true);
  assert.deepEqual(shell.input, []);
  ws.close();
});

test('the presence tracker: one foreground socket keeps the terminal in the foreground; closed sockets never count; the window resets', () => {
  const clock = { at: 0 };
  const presence = createPresence({ now: () => clock.at, windowMs: 1000, max: 3 });
  const a = { readyState: 1 }, b = { readyState: 1 };
  presence.report('1:x', a, true);
  presence.report('1:x', b, false);
  assert.equal(presence.isForeground('1:x'), true);
  presence.report('1:x', a, false);
  assert.equal(presence.isForeground('1:x'), false);
  presence.report('1:x', b, true);
  assert.equal(presence.isForeground('1:x'), true);
  b.readyState = 2; // closing
  assert.equal(presence.isForeground('1:x'), false);
  presence.drop('1:x', a);
  assert.deepEqual(presence.snapshot(), {});
  const c = { readyState: 1 };
  assert.equal(presence.report('2:y', c, true), true);
  assert.equal(presence.report('2:y', c, false), true);
  assert.equal(presence.report('2:y', c, true), true);
  assert.equal(presence.report('2:y', c, false), false, 'over the cap');
  assert.equal(presence.isForeground('2:y'), true);
  clock.at = 1500;
  assert.equal(presence.report('2:y', c, false), true, 'a new window');
  assert.equal(presence.isForeground('2:y'), false);
});
