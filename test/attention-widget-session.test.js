// The T-Attention desktop window and the agent terminals ("T-Attention desktop window (macOS)" in docs/design/attention-desktop-window.md): `session` on every item of GET /items
// (this machine and a connected service), POST /items/:key/reply (every error, and the bytes that reach the PTY: a bracketed paste, then Enter on its
// own about 150 ms later) and GET /activity (running, waiting, done; the order and `since`). routes/terminal.js runs for real with node-pty mocked, so
// the shells, the activity trackers and the task_terminals rows are the real ones; the data folder and HOME are temporary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-widget-session-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'widget-session-test-secret-widget-session-test-secret';
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(process.env.TASKS_BASE_DIR, { recursive: true });
process.env.HOME = home;

const express = require('express');
const db = require('../db');
const tasks = require('../services/engine-tasks');
const { createAttentionService } = require('../services/attention');
const { createWidgetSettings } = require('../services/attention-widget');
const { createAttentionWidgetRoutes } = require('../routes/attention-widget');

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
        write(text) { this.input.push({ text, at: Date.now() }); }, pause() {}, resume() {}, resize() {},
        kill() { this.killed = true; this.exit(); },
      };
      shells.push(pty);
      return pty;
    } };
    if (name === '../services/terminal-reaper') return { reap: async () => {}, reapSync() {} };
    return require(name.startsWith('.') ? path.resolve(path.dirname(terminalPath), name) : name);
  },
});
const terminal = mod.exports;
terminal.setHookEndpoint('http://127.0.0.1:4567/hooks/terminal-activity');

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.emit('close'); }
}
const OWNER = 'owner';
const TOKEN = 'widget-token-0123456789-abcdefghijklmnopqrstuv';
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const service = createAttentionService({ db });
const servers = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test.after(() => {
  for (const server of servers) server.close();
  terminal.shutdownTerminals();
  terminal.setHookEndpoint(null);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

// Opens the shell of a terminal as the page's socket does; returns its fake PTY and its hook token.
function open(taskId, terminalId) {
  terminal.handleWs(new Socket(), { url: `/terminal/ws?taskId=${taskId}&terminalId=${terminalId}&clientId=test` }, { login: OWNER });
  const pty = shells[shells.length - 1];
  return { pty, token: pty.options.env.TA_HOOK_TOKEN };
}
const report = (taskId, terminalId, token, event) => assert.equal(terminal.reportHook(taskId, terminalId, token, event), 204);

// A connected service whose items carry context (the rows of its T-Attention, as services/remote-attention.js returns them).
function fakeRemote(items) {
  return { call: async (row, { method, path: pathname = '' }) => {
    if (method === 'GET' && pathname.startsWith('?')) {
      const statuses = new URLSearchParams(pathname.slice(1)).get('status');
      return { items: items.filter(item => (statuses ? statuses.split(',').includes(item.status) : !['done', 'failed', 'cancelled'].includes(item.status))) };
    }
    throw new Error(`not mocked: ${method} ${pathname}`);
  } };
}

async function widgetApp({ remoteItems = [], ...rest } = {}) {
  const routes = createAttentionWidgetRoutes({
    service, db, settings: createWidgetSettings({ db }), owner: () => OWNER,
    launcher: { verifyToken: value => value === TOKEN, setEnabled: async () => {}, status: async () => ({}) },
    remote: fakeRemote(remoteItems), hiddenDevices: () => [],
    localName: () => 'Studio Mac', localInstanceId: () => 'local-instance', remoteInstanceId: row => `instance-${row.name}`,
    terminalInfo: terminal.terminalInfo, liveTerminals: terminal.liveTerminalIds, sendToTerminal: terminal.sendToTerminal, liveActivity: terminal.liveTerminalActivity,
    ...rest,
  });
  const app = express();
  app.use('/api/attention/widget', routes.bearer);
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/api/attention/widget`;
}
async function call(method, url, body) {
  const response = await fetch(url, { method, headers: { ...AUTH, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const task = tasks.createTask(OWNER, { title: 'Widget session task' });
const remoteId = Number(db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher, enabled) VALUES (?, ?, ?, ?, ?)').run(OWNER, 'Laptop', 'http://laptop.test', 'x', 1).lastInsertRowid);
const tie = (title, taskId, terminalId, extra = {}) => service.create({ title, status: 'waiting_user', context: { tagent: { task_id: String(taskId), terminal_id: terminalId } }, ...extra }, { actor: 'user' });

test('items: session from context.tagent, with agent and live for this machine, unknown for a connected service, null without a terminal', async () => {
  const claude = terminal.createTerminal(task.id, { agent: 'claude' });
  const plain = terminal.createTerminal(task.id);
  open(task.id, claude.terminal_id);
  const live = tie('Claude asks', task.id, claude.terminal_id);
  const closed = tie('Plain shell, not running', task.id, plain.terminal_id);
  const none = service.create({ title: 'No terminal', status: 'todo' }, { actor: 'user' });
  const broken = service.create({ title: 'Odd terminal id', status: 'todo', context: { tagent: { task_id: 'x', terminal_id: 'a b' } } }, { actor: 'user' });
  const base = await widgetApp({ remoteItems: [
    { id: 4, title: 'Remote agent', status: 'waiting_user', sort_order: 1, context: { tagent: { task_id: '31', terminal_id: 'term-9' } } },
    { id: 5, title: 'Remote, no context', status: 'todo', sort_order: 0 },
  ] });
  const answer = await call('GET', `${base}/items`);
  assert.equal(answer.status, 200);
  const byKey = new Map(answer.body.items.map(item => [item.key, item]));
  assert.deepEqual(byKey.get(`local:${live.id}`).session, {
    engine: 'local', task_id: String(task.id), terminal_id: claude.terminal_id, agent: 'claude', live: true,
    open_path: `/?openTerminal=local:${task.id}:${claude.terminal_id}`,
  });
  assert.deepEqual(byKey.get(`local:${closed.id}`).session, {
    engine: 'local', task_id: String(task.id), terminal_id: plain.terminal_id, agent: null, live: false,
    open_path: `/?openTerminal=local:${task.id}:${plain.terminal_id}`,
  });
  assert.equal(byKey.get(`local:${none.id}`).session, null);
  assert.equal(byKey.get(`local:${broken.id}`).session, null, 'a tagent that does not name a terminal is no session');
  assert.deepEqual(byKey.get(`remote:${remoteId}:4`).session, {
    engine: `remote:${remoteId}`, task_id: '31', terminal_id: 'term-9', agent: null, live: null,
    open_path: `/?openTerminal=remote:${remoteId}:31:term-9`,
  });
  assert.equal(byKey.get(`remote:${remoteId}:5`).session, null);
  // The answers of the actions carry it too.
  const handled = await call('POST', `${base}/items/local:${live.id}/handled`, {});
  assert.equal(handled.status, 200);
  assert.equal(handled.body.session.live, true);
  for (const id of [live.id, closed.id, none.id, broken.id]) service.remove(id, { actor: 'user' });
  terminal.controlSession(task.id, 'delete', claude.terminal_id);
  terminal.controlSession(task.id, 'delete', plain.terminal_id);
});

test('reply: a bracketed paste, then Enter on its own about 150 ms later, and a note on the item', async () => {
  const codex = terminal.createTerminal(task.id, { agent: 'codex' });
  const { pty } = open(task.id, codex.terminal_id);
  const item = tie('Codex asks', task.id, codex.terminal_id);
  const base = await widgetApp();
  const before = pty.input.length;
  const sent = Date.now();
  const answer = await call('POST', `${base}/items/local:${item.id}/reply`, { text: '  Use the second one\nand run the tests\r\nthen stop\x1b[201~\x07  ' });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { ok: true });
  const typed = () => pty.input.slice(before);
  assert.deepEqual(typed().map(entry => entry.text), ['\x1b[200~Use the second one\rand run the tests\rthen stop[201~\x1b[201~'],
    'one paste: line breaks as \\r, control characters (an ESC that would end the paste) removed, the ends trimmed, no Enter yet');
  await sleep(60);
  assert.equal(typed().length, 1, 'no Enter within the first 60 ms');
  await sleep(200);
  assert.deepEqual(typed().map(entry => entry.text).slice(1), ['\r'], 'then Enter, alone');
  const gap = typed()[1].at - typed()[0].at;
  assert.ok(gap >= 140 && gap < 1000, `Enter about 150 ms after the paste (${gap} ms)`);
  assert.ok(typed()[0].at - sent < 1000);
  const notes = service.events(item.id).filter(event => event.type === 'activity');
  assert.equal(notes.length, 1);
  assert.deepEqual(notes[0].data, { kind: 'note', text: 'Replied from the desktop window' });
  assert.equal(notes[0].actor, 'user');
  service.remove(item.id, { actor: 'user' });
  terminal.controlSession(task.id, 'delete', codex.terminal_id);
});

test('reply errors: text, a remote item, no session, a terminal that is not running, an unknown item', async () => {
  const shell = terminal.createTerminal(task.id, { agent: 'claude' });
  const item = tie('Not running', task.id, shell.terminal_id);
  const loose = service.create({ title: 'No terminal', status: 'todo' }, { actor: 'user' });
  let sends = 0;
  const base = await widgetApp({ sendToTerminal: (...args) => { sends += 1; return terminal.sendToTerminal(...args); } });
  const expect = async (key, body, status, error, message) => {
    const answer = await call('POST', `${base}/items/${key}/reply`, body);
    assert.equal(answer.status, status, `${key} ${JSON.stringify(body)}`);
    assert.equal(answer.body.error, error);
    if (message) assert.equal(answer.body.message, message);
  };
  for (const body of [{}, { text: '' }, { text: '   \n ' }, { text: 7 }, { text: 'x'.repeat(4001) }]) {
    await expect(`local:${item.id}`, body, 400, 'VALIDATION_FAILED', 'text must be 1 to 4000 characters');
  }
  await expect(`remote:${remoteId}:4`, { text: 'hello' }, 409, 'REPLY_REMOTE', 'Replies go only to terminals on this machine');
  await expect(`local:${loose.id}`, { text: 'hello' }, 409, 'NO_SESSION', 'This task has no agent terminal');
  await expect(`local:${item.id}`, { text: 'hello' }, 409, 'TERMINAL_NOT_RUNNING', "The agent's terminal is not running");
  await expect('local:999999', { text: 'hello' }, 404, 'NOT_FOUND');
  await expect('bogus', { text: 'hello' }, 404, 'NOT_FOUND');
  assert.equal(sends, 1, 'only the item with a terminal is tried');
  assert.equal(service.events(item.id).filter(event => event.type === 'activity').length, 0, 'no note when nothing was sent');
  // 4000 characters are accepted (the terminal now runs).
  const { pty } = open(task.id, shell.terminal_id);
  const before = pty.input.length;
  assert.equal((await call('POST', `${base}/items/local:${item.id}/reply`, { text: 'y'.repeat(4000) })).status, 200);
  assert.equal(pty.input[before].text, `\x1b[200~${'y'.repeat(4000)}\x1b[201~`);
  // A shell that exits before the Enter gets none.
  pty.exit();
  await sleep(250);
  assert.equal(pty.input.length, before + 1, 'no Enter into a shell that ended');
  assert.equal(terminal.sendToTerminal(task.id, shell.terminal_id, 'late'), false);
  assert.equal(terminal.sendToTerminal(task.id, '../x', 'bad id'), false);
  service.remove(item.id, { actor: 'user' });
  service.remove(loose.id, { actor: 'user' });
  terminal.controlSession(task.id, 'delete', shell.terminal_id);
});

test('activity: the live terminals that are not idle, running first, then waiting, then done, newest change first, with since', async () => {
  const other = tasks.createTask(OWNER, { title: 'Second task' });
  const made = {
    idle: terminal.createTerminal(task.id),
    doneOld: terminal.createTerminal(task.id, { agent: 'claude' }),
    running: terminal.createTerminal(task.id, { agent: 'codex' }),
    waiting: terminal.createTerminal(other.id, { agent: 'claude' }),
    doneNew: terminal.createTerminal(other.id, { agent: 'codex', title: 'Named one' }),
    runningNew: terminal.createTerminal(other.id),
  };
  const ownerOf = name => (['idle', 'doneOld', 'running'].includes(name) ? task.id : other.id);
  const tokens = {};
  for (const [name, row] of Object.entries(made)) tokens[name] = open(ownerOf(name), row.terminal_id).token;
  const go = (name, event) => report(ownerOf(name), made[name].terminal_id, tokens[name], event);
  const t0 = Date.now();
  go('doneOld', 'start'); go('doneOld', 'stop');
  await sleep(15);
  go('running', 'start');
  await sleep(15);
  go('waiting', 'start'); go('waiting', 'attention');
  await sleep(15);
  go('doneNew', 'start'); go('doneNew', 'stop');
  await sleep(15);
  go('runningNew', 'start');
  const base = await widgetApp();
  const answer = await call('GET', `${base}/activity`);
  assert.equal(answer.status, 200);
  assert.ok(Date.parse(answer.body.updated_at));
  const list = answer.body.terminals;
  assert.deepEqual(list.map(entry => [entry.terminal_id, entry.state]), [
    [made.runningNew.terminal_id, 'running'], [made.running.terminal_id, 'running'],
    [made.waiting.terminal_id, 'waiting'],
    [made.doneNew.terminal_id, 'done'], [made.doneOld.terminal_id, 'done'],
  ], 'the idle terminal is left out');
  const first = list[0];
  assert.deepEqual(Object.keys(first).sort(), ['agent', 'engine', 'open_path', 'since', 'state', 'task_id', 'task_title', 'terminal_id', 'title']);
  assert.deepEqual(list[3], {
    engine: 'local', task_id: String(other.id), task_title: 'Second task', terminal_id: made.doneNew.terminal_id, title: 'Named one', agent: 'codex',
    state: 'done', since: list[3].since, open_path: `/?openTerminal=local:${other.id}:${made.doneNew.terminal_id}`,
  });
  assert.equal(list[2].waiting_kind, 'accept', 'a question names its kind (an attention without one: accept)');
  assert.equal(list[1].task_title, 'Widget session task');
  assert.equal(list[1].title, made.running.title);
  assert.match(made.running.title, /^Codex \d+$/);
  assert.equal(list[0].agent, null);
  for (const entry of list) assert.ok(Date.parse(entry.since) >= t0 - 5 && Date.parse(entry.since) <= Date.now(), entry.since);
  assert.ok(Date.parse(list[0].since) > Date.parse(list[1].since), 'newest change first within a state');
  // The person opened the done terminal: acknowledged, idle, gone from the list; a terminal that ends is gone too.
  terminal.acknowledgeActivity(other.id, made.doneNew.terminal_id);
  terminal.controlSession(task.id, 'close', made.running.terminal_id);
  const after = (await call('GET', `${base}/activity`)).body.terminals.map(entry => entry.terminal_id);
  assert.deepEqual(after, [made.runningNew.terminal_id, made.waiting.terminal_id, made.doneOld.terminal_id]);
  // At most 50.
  const many = Array.from({ length: 60 }, (_, index) => ({ task_id: '1', task_title: 'T', terminal_id: `t${index}`, title: `T${index}`, agent: null, state: 'done', since: 1000 + index }));
  const capped = (await call('GET', `${await widgetApp({ liveActivity: () => many })}/activity`)).body.terminals;
  assert.equal(capped.length, 50);
  assert.equal(capped[0].terminal_id, 't59');
  assert.equal(capped[0].since, new Date(1059).toISOString());
  for (const [name, row] of Object.entries(made)) terminal.controlSession(ownerOf(name), 'delete', row.terminal_id);
});
