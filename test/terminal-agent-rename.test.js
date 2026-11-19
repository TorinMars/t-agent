// "Rename reaches the agent" in docs/design/terminals.md, through the real routes: PATCH …/terminals/:id on this machine, and through the
// remote proxy to an Engine's /v1 (a K01 terminal renamed from T01, where the Engine types it). routes/terminal.js runs for real with node-pty
// mocked, so the shells, the activity trackers (driven by the agent's hook reports) and the rows are the real ones; the PTY records its input.
// The rename is typed at once, idle or running, and waits only while the agent asks a permission question or does not own the foreground.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-agent-rename-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'agent-rename-test-secret-agent-rename-test-secret';
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(process.env.TASKS_BASE_DIR, { recursive: true });
process.env.HOME = home;

const mockModule = (request, exports) => {
  const resolved = require.resolve(request);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
mockModule('../middleware/auth', (req, res, next) => { req.session = { user: { login: 'owner', work_dir: process.env.TASKS_BASE_DIR } }; next(); });
mockModule('../lib/node-pty-runtime', { repairSpawnHelperPermissions() {} });
mockModule('../services/terminal-reaper', { reap: async () => {}, reapSync() {} });
const shells = [];
mockModule('node-pty', { spawn(shell, args, options) {
  const pty = { options, input: [], pid: 0, process: path.basename(shell),
    onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; },
    write(text) { this.input.push(text); }, pause() {}, resume() {}, resize() {},
    kill() { this.exit && this.exit(); },
  };
  shells.push(pty);
  return pty;
} });

const express = require('express');
const db = require('../db');
const { createAccessToken } = require('../services/engine-auth');
const { encryptToken } = require('../lib/token-crypto');
const engineTasks = require('../services/engine-tasks');
const terminal = require('../routes/terminal');
const { CLEAR_PROMPT } = require('../lib/agent-rename');

terminal.setHookEndpoint('http://127.0.0.1:4567/hooks/terminal-activity');
const servers = [];
const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); servers.push(server); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let local, proxy, remoteId;

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.emit('close'); }
}

test.before(async () => {
  const localApp = express();
  localApp.use(express.json());
  localApp.use('/api/tasks', require('../routes/tasks'));
  local = await listen(localApp);
  const engineApp = express();
  engineApp.use(express.json());
  engineApp.use('/v1', require('../routes/engine-v1'));
  const engine = await listen(engineApp);
  const token = createAccessToken(db, { principalId: 'owner' }).token;
  remoteId = db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
    .run('owner', 'K01', engine, encryptToken(token, process.env.SESSION_SECRET)).lastInsertRowid;
  const proxyApp = express();
  proxyApp.use(express.json());
  proxyApp.use('/api/remote-servers', require('../routes/remote-servers'));
  proxy = await listen(proxyApp);
});

test.after(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); })));
  terminal.shutdownTerminals();
  terminal.setHookEndpoint(null);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

// Opens a terminal's shell as the page's socket does; `foreground` is what the fake PTY reports as its foreground program.
function open(taskId, terminalId, foreground) {
  terminal.handleWs(new Socket(), { url: `/terminal/ws?taskId=${taskId}&terminalId=${terminalId}&clientId=test` }, { login: 'owner' });
  const pty = shells[shells.length - 1];
  pty.process = foreground;
  const report = event => assert.equal(terminal.reportHook(taskId, terminalId, pty.options.env.TA_HOOK_TOKEN, event), 204);
  return { pty, report, mark: pty.input.length };
}
async function rename(base, taskId, terminalId, title) {
  const response = await fetch(`${base}/${taskId}/terminals/${terminalId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
  });
  assert.equal(response.status, 200);
  return response.json();
}
const typedSince = session => session.pty.input.slice(session.mark);
const expected = name => [CLEAR_PROMPT, `/rename ${name}`, '\r'];

test('idle Claude: the rename is typed at once, Enter on its own; the answer and the row are as before', async () => {
  const task = engineTasks.createTask('owner', { title: 'Agent rename idle' });
  const claude = terminal.createTerminal(task.id, { agent: 'claude' });
  const session = open(task.id, claude.terminal_id, 'claude');
  session.report('start');
  session.report('stop'); // finished its turn: back at the prompt
  await sleep(600); // the settle time of that activity change passes with nothing pending
  session.mark = session.pty.input.length;
  assert.deepEqual(await rename(`${local}/api/tasks`, task.id, claude.terminal_id, 'MAIN-CC'), { terminal_id: claude.terminal_id, title: 'MAIN-CC' });
  // The clear keys go first (at once); the command and Enter follow as separate writes. How many have arrived when the route answers depends on
  // the machine's load, so only the order and the final writes are checked.
  assert.deepEqual(typedSince(session)[0], CLEAR_PROMPT, 'the input box is cleared first, at once');
  const deadline = Date.now() + 3000;
  while (typedSince(session).length < 3 && Date.now() < deadline) await sleep(25);
  assert.deepEqual(typedSince(session), expected('MAIN-CC'));
  const row = terminal.listTerminals(task.id).find(item => item.terminal_id === claude.terminal_id);
  assert.equal(row.title, 'MAIN-CC');
});

test('running Claude: typed at once; at a permission question it waits, the newest name wins, sent once answered', async () => {
  const task = engineTasks.createTask('owner', { title: 'Agent rename busy' });
  const claude = terminal.createTerminal(task.id, { agent: 'claude' });
  const session = open(task.id, claude.terminal_id, 'claude');
  session.report('start');
  await rename(`${local}/api/tasks`, task.id, claude.terminal_id, 'While working');
  await sleep(300);
  assert.deepEqual(typedSince(session), expected('While working'));
  session.report('attention'); // a permission question: typing would answer it
  await sleep(600);
  session.mark = session.pty.input.length;
  await rename(`${local}/api/tasks`, task.id, claude.terminal_id, 'First name');
  await rename(`${local}/api/tasks`, task.id, claude.terminal_id, 'Second name');
  await sleep(800);
  assert.deepEqual(typedSince(session), []);
  session.report('start'); // answered: the agent works again
  await sleep(900);
  assert.deepEqual(typedSince(session), expected('Second name'));
});

test('a plain shell, a Claude terminal whose shell owns the foreground, and a terminal that is not running get nothing', async () => {
  const task = engineTasks.createTask('owner', { title: 'Agent rename none' });
  const plain = terminal.createTerminal(task.id);
  const shell = open(task.id, plain.terminal_id, 'zsh');
  await rename(`${local}/api/tasks`, task.id, plain.terminal_id, 'Just a shell');
  const exited = terminal.createTerminal(task.id, { agent: 'claude' });
  const claudeGone = open(task.id, exited.terminal_id, 'zsh'); // Claude exited: the shell is back in the foreground
  await rename(`${local}/api/tasks`, task.id, exited.terminal_id, 'Not at its prompt');
  const closed = terminal.createTerminal(task.id, { agent: 'claude' }); // never opened: no shell
  assert.deepEqual(await rename(`${local}/api/tasks`, task.id, closed.terminal_id, 'Closed'), { terminal_id: closed.terminal_id, title: 'Closed' });
  await sleep(2500); // one poll of the waiting rename
  assert.deepEqual(typedSince(shell), []);
  assert.deepEqual(typedSince(claudeGone), []);
  terminal.controlSession(task.id, 'close', exited.terminal_id); // the waiting rename goes with the shell
});

test('Codex through the remote proxy: the Engine that runs the terminal types the rename', async () => {
  const task = engineTasks.createTask('owner', { title: 'Agent rename remote' });
  const codex = terminal.createTerminal(task.id, { agent: 'codex' });
  const session = open(task.id, codex.terminal_id, 'codex');
  const answer = await rename(`${proxy}/api/remote-servers/${remoteId}/tasks`, task.id, codex.terminal_id, 'Review PR');
  assert.equal(answer.title, 'Review PR');
  await sleep(300);
  assert.deepEqual(typedSince(session), expected('Review PR'));
});
