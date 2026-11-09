// A new task has no terminal until the person creates one, on every path that makes a task; a task made earlier keeps its implicit `default` terminal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-no-default-'));
process.env.T_AGENT_DATA_DIR = root;
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
const express = require('express');
const auth = require.resolve('../middleware/auth');
require.cache[auth] = { id: auth, filename: auth, loaded: true, exports: (req, res, next) => { req.session = { user: { login: 'owner' } }; next(); } };
const db = require('../db');
const engine = require('../services/engine-tasks');
const workspace = require('../services/workspace-tools');
const { createAccessToken } = require('../services/engine-auth');
const { asOlderTask } = require('../test-support/older-tasks');

// routes/terminal.js with a fake node-pty: `shells` is every PTY it starts.
const shells = [];
const terminalPath = path.resolve(__dirname, '../routes/terminal.js');
const mod = { exports: {} };
vm.runInNewContext(fs.readFileSync(terminalPath, 'utf8'), {
  module: mod, __dirname: path.dirname(terminalPath), process, console, URL, setInterval, clearInterval, Buffer,
  require(name) {
    if (name === '../lib/node-pty-runtime') return { repairSpawnHelperPermissions() {} };
    if (name === 'node-pty') return { spawn(shell, args, options) {
      const pty = { pid: 1, options, input: [], onData() {}, onExit(fn) { this.exit = fn; }, write(text) { this.input.push(text); }, pause() {}, resume() {}, resize() {}, kill() { this.exit(); } };
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
  ping() {}
  close(code, reason) { this.readyState = 3; this.code = code; this.reason = reason; this.emit('close'); }
}
function attach(task, id) {
  const ws = new Socket();
  terminal.handleWs(ws, { url: `/terminal/ws?taskId=${task.id}${id == null ? '' : `&terminalId=${id}`}&clientId=test` }, { login: 'owner' });
  return ws;
}
const ids = task => Array.from(terminal.listTerminals(task.id), row => row.terminal_id); // an array of this realm (the module runs in a vm)

function assertNoTerminal(task, label) {
  const before = shells.length;
  assert.deepEqual(ids(task), [], `${label}: nothing is listed`);
  for (const id of ['default', null, 'ghost']) {
    const ws = attach(task, id);
    assert.equal(ws.code, 1008, `${label}: an attach to ${id} is refused`);
    assert.equal(ws.reason, 'TERMINAL_NOT_FOUND', label);
  }
  assert.equal(shells.length, before, `${label}: no PTY was started`);
}

let server;
let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', require('../routes/tasks'));
  app.use('/v1', require('../routes/engine-v1'));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const post = (url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('a task made by the local route has no terminal and starts no PTY', async () => {
  const response = await post('/api/tasks', { title: 'local new' });
  assert.equal(response.status, 201);
  assertNoTerminal(await response.json(), 'local');
});

test('a task made through the Engine API has no terminal, and no ticket is given for `default`', async () => {
  const headers = { Authorization: `Bearer ${createAccessToken(db, { role: 'operator', principalId: 'owner' }).token}` };
  const response = await post('/v1/tasks', { title: 'engine new' }, headers);
  assert.equal(response.status, 201);
  const task = await response.json();
  assertNoTerminal(task, 'engine');
  assert.equal((await post('/v1/terminal-sessions', { task_id: task.id, terminal_id: 'default' }, headers)).status, 404);
  assert.equal((await post('/v1/terminal-sessions', { task_id: task.id }, headers)).status, 404, 'no terminal named: `default` is assumed and refused');
});

test('a task made by the task service or by the bulk import has no terminal', () => {
  assertNoTerminal(engine.createTask('owner', { title: 'service new' }), 'service');
  const parent = path.join(root, 'workspace');
  fs.mkdirSync(path.join(parent, 'imported'), { recursive: true });
  const [imported] = workspace.importDirs(db, 'owner', parent, [path.join(parent, 'imported')]);
  assertNoTerminal(imported, 'import');
});

test('the first terminal is created on request, is called Terminal 1 and attaches; deleting it leaves no terminal and no new shell', () => {
  const task = engine.createTask('owner', { title: 'first terminal' });
  const row = terminal.createTerminal(task.id);
  assert.equal(row.title, 'Terminal 1');
  const before = shells.length;
  assert.deepEqual(ids(task), [row.terminal_id]);
  const ws = attach(task, row.terminal_id);
  assert.equal(ws.readyState, 1, 'attached');
  assert.equal(shells.length, before + 1, 'the attach of the created terminal starts its shell');
  terminal.controlSession(task.id, 'delete', row.terminal_id);
  assertNoTerminal(task, 'after the last terminal was deleted');
});

test('an agent session can be the first one of a task', () => {
  const task = engine.createTask('owner', { title: 'agent first' });
  const row = terminal.createTerminal(task.id, { agent: 'claude' });
  assert.deepEqual([row.agent, row.title], ['claude', 'Claude 1']);
  assert.deepEqual(ids(task), [row.terminal_id], 'no plain terminal next to it');
  terminal.closeTaskTerminals(task.id);
});

test('a task made earlier keeps its default terminal: an older client that names it, or names none, still attaches', () => {
  const task = asOlderTask(db, engine.createTask('owner', { title: 'older' }));
  assert.deepEqual(ids(task), ['default']);
  const before = shells.length;
  const ws = attach(task, 'default');
  assert.equal(ws.readyState, 1, 'attached');
  assert.equal(shells.length, before + 1);
  assert.equal(attach(task, null).readyState, 1, 'no id named: the same terminal (the same client takes it over)');
  assert.equal(shells.length, before + 1);
  terminal.controlSession(task.id, 'delete', 'default');
  assertNoTerminal(task, 'an older task after its default was deleted');
});
