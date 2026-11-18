// What the activity of the terminals costs (routes/terminal.js): the activity snapshot (sent to every open activity stream on every change)
// reads no file, the desktop window's activity list (read every 5 s) reads the agents' session files at most once per SESSION_NAMES_MS, and
// the hot paths prepare their SQL statements once. The PTYs are stand-ins; the agents' session files are real files in a temporary home.
const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-snapshot-cost-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(process.env.TASKS_BASE_DIR, { recursive: true });
process.env.HOME = home;

const db = require('../db');
const tasks = require('../services/engine-tasks');

const shells = [];
const terminalPath = path.resolve(__dirname, '../routes/terminal.js');
const mod = { exports: {} };
const context = {
  module: mod, __dirname: path.dirname(terminalPath), process, console, URL,
  setInterval, clearInterval, setTimeout, clearTimeout, Buffer,
  require(name) {
    if (name === '../lib/node-pty-runtime') return { repairSpawnHelperPermissions() {} };
    if (name === 'node-pty') return { spawn(shell, args, options) {
      const pty = { options, pid: 0, onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; },
        write() {}, pause() {}, resume() {}, resize() {}, kill() { this.exit(); } };
      shells.push(pty);
      return pty;
    } };
    if (name === '../services/terminal-reaper') return { reap: async () => {}, reapSync() {} };
    return require(name.startsWith('.') ? path.resolve(path.dirname(terminalPath), name) : name);
  },
};
// The module sees this file's Date, so a mocked clock (mock.timers) moves it too.
Object.defineProperty(context, 'Date', { get: () => globalThis.Date });
vm.runInNewContext(fs.readFileSync(terminalPath, 'utf8'), context);
const terminal = mod.exports;
// Moves the clock of the module (and of lib/agent-sessions.js) ahead by `ms` from now on.
let ahead = 0;
function clockAhead(ms) {
  ahead += ms;
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: Date.now() + ahead });
}
terminal.setHookEndpoint('http://127.0.0.1:4567/hooks/terminal-activity');

class Socket extends EventEmitter {
  readyState = 1;
  send() {}
  close() { this.readyState = 3; this.emit('close'); }
}
const OWNER = 'owner';
function open(taskId, terminalId) {
  terminal.handleWs(new Socket(), { url: `/terminal/ws?taskId=${taskId}&terminalId=${terminalId}&clientId=test` }, { login: OWNER });
  return shells[shells.length - 1].options.env.TA_HOOK_TOKEN;
}

// Every file system call that touches a file or a folder while `run` works.
const FS_CALLS = ['openSync', 'readSync', 'readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'realpathSync'];
function fsCalls(run) {
  const spies = FS_CALLS.map(name => mock.method(fs, name));
  try {
    const value = run();
    const calls = {};
    FS_CALLS.forEach((name, index) => { if (spies[index].mock.callCount()) calls[name] = spies[index].mock.callCount(); });
    return { value, calls };
  } finally { for (const spy of spies) spy.mock.restore(); }
}

const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const task = tasks.createTask(OWNER, { title: 'Snapshot task' });
const claudeFolder = path.join(home, '.claude', 'projects', task.work_dir.replace(/[^A-Za-z0-9]/g, '-'));
fs.mkdirSync(claudeFolder, { recursive: true });
// Session files of other conversations in the same folder: the old snapshot read each of them on every call.
for (let n = 0; n < 20; n += 1) fs.writeFileSync(path.join(claudeFolder, `aaaaaaaa-00${String(n).padStart(2, '0')}.jsonl`), jsonl([{ type: 'user', message: { content: `other ${n}` } }]));

const claude = terminal.createTerminal(task.id, { agent: 'claude' });
const plain = terminal.createTerminal(task.id);
const sessionId = db.prepare('SELECT agent_session_id FROM task_terminals WHERE terminal_id = ?').get(claude.terminal_id).agent_session_id;
fs.writeFileSync(path.join(claudeFolder, `${sessionId}.jsonl`), jsonl([{ type: 'user', message: { content: 'first prompt' } }, { type: 'ai-title', aiTitle: 'Fixing the build' }]));
const tokens = { claude: open(task.id, claude.terminal_id), plain: open(task.id, plain.terminal_id), default: open(task.id, 'default') };
assert.equal(terminal.reportHook(task.id, claude.terminal_id, tokens.claude, 'start'), 204);
assert.equal(terminal.reportHook(task.id, plain.terminal_id, tokens.plain, 'start'), 204);
assert.equal(terminal.reportHook(task.id, plain.terminal_id, tokens.plain, 'stop'), 204);

test.after(() => {
  mock.timers.reset();
  terminal.shutdownTerminals();
  terminal.setHookEndpoint(null);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('the activity snapshot reads no file and lists no folder, and still answers what the terminal list has', () => {
  const expected = { [task.id]: { [claude.terminal_id]: 'running', [plain.terminal_id]: 'done' } };
  const { value, calls } = fsCalls(() => terminal.activitySnapshot([task.id, 999999]));
  assert.deepEqual(JSON.parse(JSON.stringify(value)), JSON.parse(JSON.stringify(expected)), 'the idle default terminal is left out');
  assert.deepEqual(calls, {}, 'no fs call (before: the folder listing and two reads of each of the 21 session files, on every call)');
  // A string task id (as a query parameter gives it) finds the same terminals.
  assert.deepEqual(Object.keys(terminal.activitySnapshot([String(task.id)])), [String(task.id)]);
  // A busy shell of a terminal that is no longer listed is not counted.
  db.prepare('INSERT INTO task_terminals (task_id, terminal_id, title) VALUES (?, ?, ?)').run(task.id, 'h5-legacy', 'Phone');
  const phoneToken = open(task.id, 'h5-legacy');
  assert.equal(terminal.reportHook(task.id, 'h5-legacy', phoneToken, 'start'), 204);
  assert.equal(terminal.activitySnapshot([task.id])[task.id]['h5-legacy'], undefined, 'a legacy phone shell is not in the list');
  terminal.controlSession(task.id, 'delete', 'h5-legacy');
});

test('the desktop window\'s activity list names the agent terminal after its session, reading the session files at most once in 15 s', () => {
  // The names of the last listing (createTerminal made one before the session had a file) are kept for 15 s: move past them.
  clockAhead(16_000);
  const first = fsCalls(() => terminal.liveTerminalActivity());
  const titleOf = list => Object.fromEntries(list.map(entry => [entry.terminal_id, [entry.title, entry.agent, entry.state]]));
  assert.deepEqual(titleOf(first.value), {
    [claude.terminal_id]: ['Fixing the build', 'claude', 'running'],
    [plain.terminal_id]: [plain.title, null, 'done'],
  });
  assert.ok(first.calls.readdirSync >= 1, 'the names are older than 15 s: the session folder is listed');
  for (let call = 0; call < 3; call += 1) { // the window reads the activity every 5 s
    const again = fsCalls(() => terminal.liveTerminalActivity());
    assert.deepEqual(again.value, first.value, 'the same answer');
    assert.deepEqual(again.calls, {}, 'a call within 15 s reads no session file and lists no folder (before: the folder listing, a stat of each of the 21 files and a read of each changed one, every 5 s)');
  }

  // A rename shows at once: the name the person gave is read from the terminal's row.
  terminal.renameTerminal(task.id, claude.terminal_id, 'Sidebar name');
  const renamed = fsCalls(() => terminal.liveTerminalActivity());
  assert.equal(titleOf(renamed.value)[claude.terminal_id][0], 'Sidebar name');
  assert.deepEqual(renamed.calls, {});
  db.prepare('UPDATE task_terminals SET title_custom = 0 WHERE terminal_id = ?').run(claude.terminal_id);
});

test('the session names are listed again once they are older than 15 s', () => {
  fs.appendFileSync(path.join(claudeFolder, `${sessionId}.jsonl`), jsonl([{ type: 'custom-title', customTitle: 'Renamed in Claude' }]));
  assert.equal(terminal.liveTerminalActivity().find(entry => entry.terminal_id === claude.terminal_id).title, 'Fixing the build', 'within 15 s: the known name');
  clockAhead(16_000);
  const later = fsCalls(() => terminal.liveTerminalActivity());
  assert.ok(later.calls.readdirSync >= 1, 'listed again');
  assert.equal(later.value.find(entry => entry.terminal_id === claude.terminal_id).title, 'Renamed in Claude');
});

test('the hot paths prepare their SQL once: no db.prepare on later calls', () => {
  const run = () => {
    terminal.activitySnapshot([task.id]);
    terminal.liveTerminalActivity();
    terminal.listTerminals(task.id);
    terminal.terminalInfo(task.id, claude.terminal_id);
    terminal.isLocalTerminal(task.id, plain.terminal_id);
    terminal.assertTerminal(task.id, plain.terminal_id);
    terminal.updateIdleTerminals();
  };
  run(); // the first use prepares them
  const prepare = mock.method(db, 'prepare');
  try {
    for (let n = 0; n < 5; n += 1) run();
    assert.equal(prepare.mock.callCount(), 0, 'before: 27 db.prepare per round');
  } finally { prepare.mock.restore(); }
});
