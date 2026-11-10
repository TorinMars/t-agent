// The terminal side of the automatic update's idle check: routes/terminal.js reports what lib/update-idle.js needs, and a binding counts only when a new
// shell would really find the session. node-pty is mocked; the data folder and HOME are temporary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-update-idle-'));
process.env.T_AGENT_DATA_DIR = root;
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
const home = path.join(root, 'home');
fs.mkdirSync(home);
process.env.HOME = home;

const db = require('../db');
const tasks = require('../services/engine-tasks');
const { idleBlockers } = require('../lib/update-idle');
const { recentInputTimes } = require('../lib/terminal-recent-input');

const shells = [];
const terminalPath = path.resolve(__dirname, '../routes/terminal.js');
const mod = { exports: {} };
vm.runInNewContext(fs.readFileSync(terminalPath, 'utf8'), {
  module: mod, __dirname: path.dirname(terminalPath), process, console, URL,
  setInterval, clearInterval, setTimeout, clearTimeout, Buffer,
  require(name) {
    if (name === '../lib/node-pty-runtime') return { repairSpawnHelperPermissions() {} };
    if (name === 'node-pty') return { spawn(shell, args, options) {
      const pty = { options, process: path.basename(shell), input: [],
        onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; },
        write(text) { this.input.push(text); }, pause() {}, resume() {}, resize() {},
        kill() { this.exit(); },
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
  send() {}
  close() { this.readyState = 3; this.emit('close'); }
}

const task = tasks.createTask('owner', { title: 'idle check' });
const claudeFolder = path.join(home, '.claude', 'projects', path.resolve(task.work_dir).replace(/[^A-Za-z0-9]/g, '-'));

function open(id) {
  const ws = new Socket();
  terminal.handleWs(ws, { url: `/terminal/ws?taskId=${task.id}&terminalId=${id}&clientId=test` }, { login: 'owner' });
  return { ws, pty: shells[shells.length - 1] };
}
const sessionOf = id => db.prepare('SELECT agent_session_id FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(task.id, id).agent_session_id;
function writeSession(id) {
  fs.mkdirSync(claudeFolder, { recursive: true });
  fs.writeFileSync(path.join(claudeFolder, `${id}.jsonl`), `${JSON.stringify({ type: 'user', message: { content: 'hello' } })}\n`);
}
const rowOf = pty => terminal.updateIdleTerminals()[shells.indexOf(pty)];

test.after(() => {
  terminal.closeTaskTerminals(task.id);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test.beforeEach(() => { for (const pty of shells.splice(0)) pty.kill(); });

test('a plain shell is reported with its shell in the foreground and blocks nothing', () => {
  const { pty } = open(terminal.createTerminal(task.id).terminal_id);
  const row = rowOf(pty);
  assert.equal(row.agent, null);
  assert.equal(row.resumable, false);
  assert.equal(row.state, 'idle');
  assert.deepEqual(idleBlockers({ terminals: [row], chat: {}, inputs: [] }, { quietMs: 1000, now: Date.now() }), []);
});

test('a Claude terminal is resumable only when the file of its session exists', () => {
  const created = terminal.createTerminal(task.id, { agent: 'claude' });
  const { pty } = open(created.terminal_id);
  pty.process = 'claude';
  assert.equal(rowOf(pty).agent, 'claude');
  assert.equal(rowOf(pty).resumable, false, 'bound, but the session never got a message: there is no file to resume');
  writeSession(sessionOf(created.terminal_id));
  assert.equal(rowOf(pty).resumable, true);
  assert.deepEqual(idleBlockers({ terminals: [rowOf(pty)], chat: {}, inputs: [] }, { quietMs: 1000, now: Date.now() }), []);
});

test('a binding is no use when something else owns the foreground', () => {
  const created = terminal.createTerminal(task.id, { agent: 'claude' });
  const { pty } = open(created.terminal_id);
  writeSession(sessionOf(created.terminal_id));
  pty.process = 'vim';
  assert.equal(rowOf(pty).resumable, false);
  assert.deepEqual(idleBlockers({ terminals: [rowOf(pty)], chat: {}, inputs: [] }, { quietMs: 1000, now: Date.now() }), [{ code: 'terminal_program', count: 1 }]);
});

test('claude started by hand in a plain terminal has no binding', () => {
  const { pty } = open(terminal.createTerminal(task.id).terminal_id);
  pty.process = 'claude';
  assert.equal(rowOf(pty).agent, null);
  assert.deepEqual(idleBlockers({ terminals: [rowOf(pty)], chat: {}, inputs: [] }, { quietMs: 1000, now: Date.now() }), [{ code: 'terminal_program', count: 1 }]);
});

test('typing is noted as recent input, a resize is not', () => {
  const { ws, pty } = open(terminal.createTerminal(task.id).terminal_id);
  const before = recentInputTimes().length;
  ws.emit('message', Buffer.from('{"type":"resize","cols":80,"rows":24}'), false);
  assert.equal(recentInputTimes().length, before);
  ws.emit('message', Buffer.from('ls\r'), false);
  assert.equal(recentInputTimes().length, before + 1);
  assert.deepEqual(pty.input, ['ls\r']);
});
