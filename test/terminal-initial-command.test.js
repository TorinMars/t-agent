// The initial command of a new plain terminal ("Initial command" in docs/design/terminals.md): validation in createTerminal (type, length, kinds),
// and the typing into a fake PTY: nothing before the shell's first output, then each line followed by Enter once the output went quiet; the
// fallback for a shell that prints nothing; a restarted shell does not type it again. Temporary data folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-initial-command-'));
process.env.T_AGENT_DATA_DIR = root;
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
const db = require('../db');
const tasks = require('../test-support/older-tasks').olderTasks(require('../services/engine-tasks'), db);
const shells = [];
const terminalPath = path.resolve(__dirname, '../routes/terminal.js');
const mod = { exports: {} };
vm.runInNewContext(fs.readFileSync(terminalPath, 'utf8'), {
  module: mod, __dirname: path.dirname(terminalPath), process, console, URL,
  setInterval, clearInterval, setTimeout, clearTimeout, Buffer,
  require(name) {
    if (name === '../lib/node-pty-runtime') return { repairSpawnHelperPermissions() {} };
    if (name === 'node-pty') return { spawn(shell, args, options) {
      const pty = { options, input: [], killed: false, pid: 0,
        onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; },
        write(text) { this.input.push(text); }, pause() {}, resume() {}, resize() {},
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
  close(code, reason) { this.readyState = 3; this.code = code; this.reason = reason; this.emit('close'); }
}
const task = tasks.createTask('owner', { title: 'initial command' });
const connect = id => {
  const ws = new Socket();
  terminal.handleWs(ws, { url: `/terminal/ws?taskId=${task.id}&terminalId=${id}&clientId=test` }, { login: 'owner' });
  return ws;
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const typed = pty => pty.input.filter(text => typeof text === 'string' && text.endsWith('\r'));
test.after(() => {
  terminal.closeTaskTerminals(task.id);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('validation: a string of at most 4,000 characters, CR LF normalised and trimmed; refused for the agent kinds and the notebook', () => {
  const code = fn => { try { fn(); return null; } catch (error) { return [error.statusCode, error.message]; } };
  assert.equal(terminal.INITIAL_COMMAND_MAX, 4000);
  assert.deepEqual(code(() => terminal.createTerminal(task.id, { command: 42 })), [400, 'INVALID_INITIAL_COMMAND']);
  assert.deepEqual(code(() => terminal.createTerminal(task.id, { command: 'x'.repeat(4001) })), [400, 'INITIAL_COMMAND_TOO_LONG']);
  for (const agent of ['claude', 'codex', 'opencode', 'notebook']) {
    assert.deepEqual(code(() => terminal.createTerminal(task.id, { agent, command: 'ls' })), [400, 'INITIAL_COMMAND_NOT_A_TERMINAL'], agent);
  }
  const before = terminal.listTerminals(task.id).length;
  const ok = terminal.createTerminal(task.id, { command: `  ${'y'.repeat(4000)}  ` }); // the ends are trimmed before the limit
  assert.equal(ok.agent, null);
  // An empty or blank command is no command: an agent session with one is still made.
  const claude = terminal.createTerminal(task.id, { agent: 'claude', command: '  \r\n ' });
  assert.equal(claude.agent, 'claude');
  assert.equal(terminal.listTerminals(task.id).length, before + 2, 'nothing was made for the refused ones');
});

test('the command is typed line by line after the first output and a quiet moment, never logged', async () => {
  const logged = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const name of Object.keys(original)) console[name] = (...args) => { logged.push(args.join(' ')); };
  try {
    const made = terminal.createTerminal(task.id, { command: 'cd docs\r\n\x1b[Anpm run dev\x07\rexit-not-really' });
    const ws = connect(made.terminal_id);
    const pty = shells.at(-1);
    assert.deepEqual(typed(pty), [], 'nothing is typed before the shell said anything');
    await wait(100);
    assert.deepEqual(typed(pty), [], 'still nothing without output');
    pty.data('Last login: today\r\n');
    await wait(100);
    pty.data('~/task % ');
    await wait(150);
    assert.deepEqual(typed(pty), [], 'output keeps it waiting');
    await wait(250);
    assert.deepEqual(typed(pty), ['cd docs\r', '[Anpm run dev\r', 'exit-not-really\r'], 'each line with Enter, control characters dropped');
    pty.data('more output');
    await wait(300);
    assert.equal(typed(pty).length, 3, 'typed once');
    ws.close(1000, 'done');
    // A restart of that terminal starts a new shell without the command.
    terminal.controlSession(task.id, 'restart-workdir', made.terminal_id);
    connect(made.terminal_id);
    const again = shells.at(-1);
    assert.notEqual(again, pty);
    again.data('% ');
    await wait(400);
    assert.deepEqual(typed(again), [], 'a new shell of the same terminal does not run it again');
  } finally { Object.assign(console, original); }
  assert.ok(!logged.some(line => line.includes('npm run dev')), 'the command is not logged');
});

test('a shell that prints nothing gets the command after the fallback wait', async () => {
  const made = terminal.createTerminal(task.id, { command: 'echo quiet' });
  connect(made.terminal_id);
  const pty = shells.at(-1);
  await wait(2500);
  assert.deepEqual(typed(pty), [], 'not before the fallback');
  await wait(800);
  assert.deepEqual(typed(pty), ['echo quiet\r'], 'typed after about 3 seconds');
});

test('a plain terminal without a command types nothing', async () => {
  const made = terminal.createTerminal(task.id, {});
  connect(made.terminal_id);
  const pty = shells.at(-1);
  pty.data('% ');
  await wait(400);
  assert.deepEqual(typed(pty), []);
});
