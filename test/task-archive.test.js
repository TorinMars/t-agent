// Archiving a task (schema 10): reversible, nothing is destroyed, the task is inert until restored, and it leaves every list unless asked for.
// The local routes, the Engine routes and the Client's remote proxy are the real ones; only the PTY and the chat agent are fakes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-archive-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'task-archive-test-secret-task-archive-test-secret';
const workRoot = path.join(root, 'tasks');
fs.mkdirSync(workRoot, { recursive: true });

const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports(req, res, next) { req.session = { user: { login: 'owner', work_dir: workRoot } }; next(); },
};

// No real shell: `shells` is every PTY the terminal module starts.
const shells = [];
const stubModule = (name, exports) => { const file = require.resolve(name); require.cache[file] = { id: file, filename: file, loaded: true, exports }; };
stubModule('../lib/node-pty-runtime', { repairSpawnHelperPermissions() {} });
stubModule('node-pty', { spawn(shell, args, options) {
  const pty = { pid: process.pid, options, killed: false, onData() {}, onExit(fn) { this.exit = fn; }, write() {}, pause() {}, resume() {}, resize() {}, kill() { this.killed = true; this.exit?.(); } };
  shells.push(pty);
  return pty;
} });

// A chat agent that works until it is stopped.
const turns = [];
const chatModule = require('../services/agent-chat');
const db = require('../db');
const chat = chatModule.createAgentChat({ db, adapters: { claude: {
  MODES: { ask: {}, full: {} }, DEFAULT_MODE: 'ask',
  loadHistory: async () => [],
  listModels: async () => [],
  runTurn: ({ signal, prompt }) => new Promise(resolve => {
    turns.push({ prompt, signal });
    signal.addEventListener('abort', () => resolve({ ok: false }));
  }),
} } });
chatModule.getAgentChat = () => chat;

const WebSocket = require('ws');
const express = require('express');
const { createAccessToken } = require('../services/engine-auth');
const { encryptToken } = require('../lib/token-crypto');
const { asOlderTask } = require('../test-support/older-tasks');
const engineTasks = require('../services/engine-tasks');
const terminal = require('../routes/terminal');
const { handleRemoteTerminalUpgrade } = require('../services/remote-terminal-proxy');

const servers = [];
const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); servers.push(server); });
let local, engine, proxy, old, token, auth, remoteId, oldRemoteId;
const oldEngineHits = [];

test.before(async () => {
  const localApp = express();
  localApp.use(express.json());
  localApp.use('/api/tasks/:id/agent', require('../routes/agent-chat').createAgentChatRouter({ service: chat }));
  localApp.use('/api/tasks', require('../routes/tasks'));
  local = await listen(localApp);

  const engineApp = express();
  engineApp.use(express.json());
  engineApp.use('/v1', require('../routes/engine-v1'));
  engine = await listen(engineApp);
  token = createAccessToken(db, { principalId: 'owner' }).token;
  auth = { Authorization: `Bearer ${token}` };

  // An Engine from before archiving: no capability, no routes, and a task list that ignores `archived`.
  const oldApp = express();
  oldApp.use((req, res, next) => { oldEngineHits.push(`${req.method} ${req.url}`); next(); });
  oldApp.get('/v1/info', (req, res) => res.json({ capabilities: ['tasks:read', 'tasks:write'] }));
  oldApp.get('/v1/tasks', (req, res) => res.json([{ id: 1, title: 'not archived at all' }]));
  old = await listen(oldApp);

  const remote = base => db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
    .run('owner', base, base, encryptToken(token, process.env.SESSION_SECRET)).lastInsertRowid;
  remoteId = remote(engine);
  oldRemoteId = remote(old);
  const proxyApp = express();
  proxyApp.use(express.json());
  proxyApp.use('/api/remote-servers', require('../routes/remote-servers'));
  proxy = await listen(proxyApp);
});

test.after(async () => {
  for (const row of db.prepare('SELECT id FROM tasks').all()) { terminal.closeTaskTerminals(row.id); chat.stopTask(row.id); }
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); })));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function call(method, url, body, headers = {}) {
  const response = await fetch(url, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: parsed };
}
const newTask = (title, owner = 'owner') => engineTasks.createTask(owner, { title });
const row = id => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
const archive = id => call('POST', `${local}/api/tasks/${id}/archive`);
const restore = id => call('POST', `${local}/api/tasks/${id}/restore`);
const titles = rows => rows.map(item => item.title);
const liveSessionCount = () => shells.filter(item => !item.killed).length;

class Socket extends EventEmitter {
  readyState = 1;
  send() {}
  ping() {}
  terminate() { this.close(1006); }
  close(code, reason) { this.readyState = 3; this.code = code; this.reason = reason; this.emit('close'); }
}
function attach(task, id) {
  const ws = new Socket();
  terminal.handleWs(ws, { url: `/terminal/ws?taskId=${task.id}${id == null ? '' : `&terminalId=${id}`}&clientId=test` }, { login: 'owner' });
  return ws;
}

test('archive returns the row with archived_at and is idempotent; restore returns it with null and is idempotent', async () => {
  const task = newTask('round trip');
  const first = await archive(task.id);
  assert.equal(first.status, 200);
  assert.equal(first.body.id, task.id);
  assert.match(first.body.archived_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  db.prepare('UPDATE tasks SET archived_at = ? WHERE id = ?').run('2026-03-01T00:00:00.000Z', task.id);
  const second = await archive(task.id);
  assert.equal(second.status, 200);
  assert.equal(second.body.archived_at, '2026-03-01T00:00:00.000Z', 'already archived: unchanged');

  db.prepare('UPDATE tasks SET sort_order = 42 WHERE id = ?').run(task.id);
  const restored = await restore(task.id);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.archived_at, null);
  assert.equal(restored.body.sort_order, 0, 'ordered like a new task');
  db.prepare('UPDATE tasks SET sort_order = 42 WHERE id = ?').run(task.id);
  const again = await restore(task.id);
  assert.equal(again.status, 200);
  assert.equal(again.body.sort_order, 42, 'not archived: unchanged');
});

test('archive keeps the row, the share token, the to-dos, the terminal rows with their agent sessions, and the folder', async () => {
  const task = newTask('kept');
  db.prepare('UPDATE tasks SET share_token = ? WHERE id = ?').run('share-1', task.id);
  db.prepare("INSERT INTO task_todos (task_id, content) VALUES (?, 'todo')").run(task.id);
  db.prepare("INSERT INTO task_terminals (task_id, terminal_id, title, agent, agent_session_id) VALUES (?, 'c1', 'Claude 2', 'claude', 'session-1')").run(task.id);
  await archive(task.id);
  const kept = row(task.id);
  assert.equal(kept.share_token, 'share-1');
  assert.ok(fs.existsSync(kept.work_dir));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_todos WHERE task_id = ?').get(task.id).n, 1);
  assert.equal(db.prepare('SELECT agent_session_id FROM task_terminals WHERE task_id = ?').get(task.id).agent_session_id, 'session-1');
  const todos = await call('GET', `${local}/api/tasks/${task.id}/todos`);
  assert.equal(todos.status, 200, 'reading stays allowed');
  assert.equal(todos.body.length, 1);
  assert.equal((await call('GET', `${local}/api/tasks/${task.id}/document/technical`)).status, 200);
  assert.equal((await call('GET', `${local}/api/tasks/${task.id}/terminals`)).body.length, 1, 'the terminal stays listed');
  await restore(task.id);
  assert.equal(db.prepare('SELECT agent_session_id FROM task_terminals WHERE task_id = ?').get(task.id).agent_session_id, 'session-1', 'bound again after restore');
});

test('archive really ends the live terminals, and an archived task starts no shell until it is restored', async () => {
  const task = newTask('live terminals');
  const created = terminal.createTerminal(task.id);
  const before = shells.length;
  const socket = attach(task, created.terminal_id);
  assert.equal(shells.length, before + 1);
  const pty = shells.at(-1);
  await archive(task.id);
  assert.equal(pty.killed, true, 'the shell was killed');
  assert.equal(socket.code, 1000, 'the open socket was closed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(task.id, created.terminal_id).n, 1);

  const refused = attach(task, created.terminal_id);
  assert.equal(refused.code, 1008);
  assert.equal(refused.reason, 'TASK_ARCHIVED');
  assert.equal(attach(task, 'ghost').reason, 'TASK_ARCHIVED', 'also for a terminal that does not exist');
  assert.equal(attach(task, null).reason, 'TASK_ARCHIVED');

  const local409 = await call('POST', `${local}/api/tasks/${task.id}/terminals`, {});
  assert.deepEqual([local409.status, local409.body.error], [409, 'TASK_ARCHIVED']);
  const engine409 = await call('POST', `${engine}/v1/tasks/${task.id}/terminals`, {}, auth);
  assert.deepEqual([engine409.status, engine409.body.error], [409, 'TASK_ARCHIVED']);
  const ticket = await call('POST', `${engine}/v1/terminal-sessions`, { task_id: task.id, terminal_id: created.terminal_id }, auth);
  assert.deepEqual([ticket.status, ticket.body.error], [409, 'TASK_ARCHIVED']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_terminals WHERE task_id = ?').get(task.id).n, 1, 'no new terminal row');
  assert.equal(shells.length, before + 1, 'no PTY was started');

  await restore(task.id);
  const back = attach(task, created.terminal_id);
  assert.equal(back.readyState, 1, 'attached again');
  assert.equal(shells.length, before + 2, 'the shell starts on the first connect after restore');
  terminal.closeTaskTerminals(task.id);
});

test('an older task with the implicit default terminal is closed and refused too', async () => {
  const task = asOlderTask(db, newTask('older'));
  const before = shells.length;
  attach(task, 'default');
  assert.equal(shells.length, before + 1);
  await archive(task.id);
  assert.equal(shells.at(-1).killed, true);
  assert.equal(attach(task, 'default').reason, 'TASK_ARCHIVED');
  assert.equal(shells.length, before + 1);
});

test('the normal lists leave archived tasks out; ?archived=1 has only them, newest first', async () => {
  const visible = newTask('visible');
  const older = newTask('archived first');
  const newer = newTask('archived second');
  await archive(older.id);
  await archive(newer.id);
  db.prepare('UPDATE tasks SET archived_at = ? WHERE id = ?').run('2030-01-01T00:00:00.000Z', older.id);
  db.prepare('UPDATE tasks SET archived_at = ? WHERE id = ?').run('2030-01-02T00:00:00.000Z', newer.id);

  for (const [label, url, headers] of [['local', `${local}/api/tasks`, {}], ['engine', `${engine}/v1/tasks`, auth], ['proxy', `${proxy}/api/remote-servers/${remoteId}/tasks`, {}]]) {
    const list = await call('GET', url, undefined, headers);
    assert.equal(list.status, 200, label);
    assert.ok(titles(list.body).includes('visible'), label);
    assert.ok(!titles(list.body).includes('archived first'), `${label}: not listed`);
    assert.ok(list.body.every(item => !item.archived_at), label);
    // The page tells a server that cannot archive from one that can by this key being there (h5.js `loadTasks`).
    assert.ok(list.body.every(item => 'archived_at' in item && item.archived_at === null), `${label}: every row has the key, null while in use`);
    const archived = await call('GET', `${url}?archived=1`, undefined, headers);
    assert.equal(archived.status, 200, label);
    assert.deepEqual(titles(archived.body).slice(0, 2), ['archived second', 'archived first'], `${label}: newest archived_at first`);
    assert.ok(archived.body.every(item => item.archived_at), label);
    assert.ok(!titles(archived.body).includes('visible'), label);
  }
  const byStatus = await call('GET', `${local}/api/tasks?status=todo&archived=1`);
  assert.ok(titles(byStatus.body).includes('archived second'), 'status still filters');
  assert.equal(row(visible.id).archived_at, null);
});

test('the run state and sub-agent views only ask about tasks in use, on the local and Engine routes', async () => {
  const kept = newTask('watched');
  const gone = newTask('not watched');
  await archive(gone.id);
  const seen = [];
  const { activitySnapshot, subagentSnapshot } = terminal;
  terminal.activitySnapshot = ids => { seen.push(ids); return {}; };
  terminal.subagentSnapshot = ids => { seen.push(ids); return {}; };
  try {
    for (const [url, headers] of [[`${local}/api/tasks/terminal-activity`, {}], [`${local}/api/tasks/terminal-subagents`, {}], [`${engine}/v1/terminal-activity`, auth], [`${engine}/v1/terminal-subagents`, auth]]) {
      assert.equal((await call('GET', url, undefined, headers)).status, 200, url);
    }
  } finally { Object.assign(terminal, { activitySnapshot, subagentSnapshot }); }
  assert.equal(seen.length, 4);
  for (const ids of seen) {
    assert.ok(ids.includes(kept.id));
    assert.ok(!ids.includes(gone.id));
  }
});

test('reorder ignores an archived task on the local and Engine routes', async () => {
  const task = newTask('reorder');
  db.prepare('UPDATE tasks SET sort_order = 5 WHERE id = ?').run(task.id);
  await archive(task.id);
  assert.equal((await call('PUT', `${local}/api/tasks/reorder`, [{ id: task.id, sort_order: 90 }])).status, 200);
  assert.equal(row(task.id).sort_order, 5);
  assert.equal((await call('PUT', `${engine}/v1/tasks/reorder`, [{ id: task.id, sort_order: 91 }], auth)).status, 200);
  assert.equal(row(task.id).sort_order, 5);
});

test('delete works on an archived task', async () => {
  const task = newTask('delete local');
  await archive(task.id);
  assert.deepEqual((await call('DELETE', `${local}/api/tasks/${task.id}`)).body, { success: true });
  assert.equal(row(task.id), undefined);
  const remoteTask = newTask('delete engine');
  await archive(remoteTask.id);
  assert.equal((await call('DELETE', `${engine}/v1/tasks/${remoteTask.id}`, undefined, auth)).status, 200);
  assert.equal(row(remoteTask.id), undefined);
});

test('only the owner can archive or restore', async () => {
  const theirs = newTask('private', 'other');
  for (const [url, headers] of [[`${local}/api/tasks/${theirs.id}`, {}], [`${engine}/v1/tasks/${theirs.id}`, auth]]) {
    for (const action of ['archive', 'restore']) {
      const answer = await call('POST', `${url}/${action}`, undefined, headers);
      assert.deepEqual([answer.status, answer.body.error], [404, 'TASK_NOT_FOUND'], `${url}/${action}`);
    }
  }
  assert.equal(row(theirs.id).archived_at, null);
  assert.equal((await call('POST', `${local}/api/tasks/not-a-number/archive`)).status, 404);
  db.prepare('UPDATE tasks SET archived_at = ? WHERE id = ?').run('2030-01-01T00:00:00.000Z', theirs.id);
  assert.ok(!titles((await call('GET', `${local}/api/tasks?archived=1`)).body).includes('private'), 'not in the archive of another person');
});

test('the workspace tools keep an archived folder managed, never offer it for cleanup, and it still protects its parent', async () => {
  const task = newTask('workspace archived');
  const folder = row(task.id).work_dir;
  execFileSync('git', ['init', '-q'], { cwd: folder });
  const unmanaged = await call('GET', `${local}/api/tasks/workspace/unmanaged`);
  assert.ok(!unmanaged.body.items.some(item => item.path === folder), 'before archiving: managed');
  const offered = await call('GET', `${local}/api/tasks/workspace/cleanup`);
  assert.ok(offered.body.items.some(item => item.path === folder), 'before archiving: offered');

  await archive(task.id);
  for (const [url, headers] of [[`${local}/api/tasks/workspace`, {}], [`${engine}/v1/workspace`, auth]]) {
    const list = await call('GET', `${url}/unmanaged`, undefined, headers);
    assert.equal(list.status, 200);
    assert.ok(!list.body.items.some(item => item.path === folder), `${url}: an archived folder is not unmanaged`);
    const overview = await call('GET', `${url}/cleanup`, undefined, headers);
    assert.ok(!overview.body.items.some(item => item.path === folder), `${url}: not offered for cleanup`);
  }
  const imported = await call('POST', `${local}/api/tasks/workspace/import`, { paths: [folder] });
  assert.deepEqual([imported.status, imported.body.error], [400, 'PATH_NOT_IMPORTABLE']);
  const cleaned = await call('POST', `${local}/api/tasks/workspace/cleanup`, { confirm: true, repos: [{ task_id: task.id, path: folder }] });
  assert.deepEqual(cleaned.body.map(item => [item.ok, item.error]), [[false, 'TASK_ARCHIVED']]);
  assert.ok(fs.existsSync(path.join(folder, '.git')), 'the repository stays');

  // A repository in use that contains the folder of an archived task must not be cleaned, and the directory of the task cannot be deleted with another task.
  const parent = engineTasks.createTask('owner', { title: 'parent', work_dir: path.join(workRoot, 'parent') });
  execFileSync('git', ['init', '-q'], { cwd: row(parent.id).work_dir });
  const child = engineTasks.createTask('owner', { title: 'child', work_dir: path.join(workRoot, 'parent', 'child') });
  await archive(child.id);
  const overview = await call('GET', `${local}/api/tasks/workspace/cleanup`);
  const item = overview.body.items.find(entry => entry.path === row(parent.id).work_dir);
  assert.equal(item.safe, false);
  assert.match(item.reason, /other tasks/);
});

test('the Engine advertises tasks:archive, needs a token, and answers public rows', async () => {
  const info = await call('GET', `${engine}/v1/info`, undefined, auth);
  assert.ok(info.body.capabilities.includes('tasks:archive'));
  assert.equal(info.body.api_version, 1, 'additive: the protocol version stays');
  const task = newTask('engine round trip');
  assert.equal((await call('POST', `${engine}/v1/tasks/${task.id}/archive`)).status, 401);
  const archived = await call('POST', `${engine}/v1/tasks/${task.id}/archive`, undefined, auth);
  assert.equal(archived.status, 200);
  assert.ok(archived.body.archived_at);
  assert.equal(archived.body.user_id, undefined);
  assert.equal(archived.body.share_token, undefined);
  const stored = row(task.id).archived_at;
  const twice = await call('POST', `${engine}/v1/tasks/${task.id}/archive`, undefined, auth);
  assert.equal(twice.body.archived_at, stored, 'idempotent');
  const restored = await call('POST', `${engine}/v1/tasks/${task.id}/restore`, undefined, auth);
  assert.deepEqual([restored.status, restored.body.archived_at, restored.body.sort_order], [200, null, 0]);
  assert.equal((await call('POST', `${engine}/v1/tasks/999999/archive`, undefined, auth)).status, 404);
});

test('the proxy archives and restores on an Engine that supports it, with the same paths as the local routes', async () => {
  const task = newTask('through the proxy');
  const base = `${proxy}/api/remote-servers/${remoteId}/tasks`;
  const archived = await call('POST', `${base}/${task.id}/archive`);
  assert.equal(archived.status, 200);
  assert.ok(archived.body.archived_at);
  assert.ok(row(task.id).archived_at, 'it reached the Engine');
  assert.equal((await call('POST', `${base}/999999/archive`)).status, 404);
  const refused = await call('POST', `${base}/${task.id}/terminals`, {});
  assert.deepEqual([refused.status, refused.body.error], [409, 'TASK_ARCHIVED'], 'the code reaches the page');
  const restored = await call('POST', `${base}/${task.id}/restore`);
  assert.deepEqual([restored.status, restored.body.archived_at], [200, null]);
});

test('an older Engine gets a clean ARCHIVE_UNSUPPORTED, and its whole list is never shown as an archive', async () => {
  const base = `${proxy}/api/remote-servers/${oldRemoteId}/tasks`;
  for (const [method, url] of [['GET', `${base}?archived=1`], ['POST', `${base}/1/archive`], ['POST', `${base}/1/restore`]]) {
    const answer = await call(method, url);
    assert.deepEqual([answer.status, answer.body.error], [501, 'ARCHIVE_UNSUPPORTED'], url);
  }
  assert.ok(!oldEngineHits.some(hit => /archived|archive$|restore$/.test(hit)), 'nothing but /v1/info reached it');
  assert.deepEqual(titles((await call('GET', base)).body), ['not archived at all'], 'the normal list still works');
});

test('the terminal WebSocket of an archived remote task is opened and closed cleanly, so the page does not reconnect', async () => {
  const task = asOlderTask(db, newTask('remote socket'));
  await call('POST', `${engine}/v1/tasks/${task.id}/archive`, undefined, auth);
  const wss = new WebSocket.Server({ noServer: true });
  const gateway = http.createServer();
  gateway.on('upgrade', (req, socket, head) => { handleRemoteTerminalUpgrade(req, socket, head, wss, { login: 'owner' }); });
  servers.push(gateway);
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const before = shells.length;
  const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/api/remote-servers/${remoteId}/terminal/ws?taskId=${task.id}&terminalId=default`);
  const closed = await new Promise((resolve, reject) => {
    client.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    client.once('error', reject);
  });
  assert.deepEqual(closed, { code: 1008, reason: 'TASK_ARCHIVED' });
  assert.equal(shells.length, before);
});

test('agent chats: the running turn stops, the queue stays and is not sent, new work is refused, reading is not', async () => {
  const task = newTask('chat');
  const base = `${local}/api/tasks/${task.id}/agent/conversations`;
  const conversation = (await call('POST', base, { agent: 'claude' })).body;
  assert.ok(conversation.id);
  const sent = await call('POST', `${base}/${conversation.id}/messages`, { text: 'work' });
  assert.equal(sent.status, 200);
  assert.equal(turns.length, 1);
  const queued = await call('POST', `${base}/${conversation.id}/queue/add`, { body: { text: 'next' } });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  assert.equal(chat.activity().queued, 1);

  await archive(task.id);
  assert.equal(turns[0].signal.aborted, true, 'the running turn was stopped');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(turns.length, 1, 'the queued message was not sent');
  assert.equal(JSON.parse(db.prepare('SELECT queue FROM agent_conversations WHERE id = ?').get(conversation.id).queue).length, 1, 'the queue is kept');
  assert.equal(chat.activity().queued, 0, 'an archived queue does not hold back an update');
  assert.equal(chat.summary('owner').submitted, 0);

  for (const [url, body] of [[`${base}/${conversation.id}/messages`, { text: 'more' }], [base, { agent: 'claude' }], [`${base}/${conversation.id}/queue/add`, { body: { text: 'x' } }], [`${base}/${conversation.id}/queue/1/send`, {}], [`${base}/${conversation.id}/fork`, { itemId: 'x' }]]) {
    const answer = await call('POST', url, body);
    assert.deepEqual([answer.status, answer.body.error], [409, 'TASK_ARCHIVED'], url);
  }
  await assert.rejects(chat.sendMessage(task, conversation.id, { text: 'direct' }), /TASK_ARCHIVED/, 'the service refuses too');
  assert.equal((await call('GET', base)).status, 200, 'reading the chats stays allowed');
  assert.equal((await call('GET', `${base}/${conversation.id}`)).status, 200);
  const proxied = await call('POST', `${proxy}/api/remote-servers/${remoteId}/tasks/${task.id}/agent/conversations/${conversation.id}/messages`, { text: 'remote' });
  assert.deepEqual([proxied.status, proxied.body.error], [409, 'TASK_ARCHIVED'], 'also through the proxy');

  await restore(task.id);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(turns.length, 1, 'restore starts nothing by itself');
  assert.equal(chat.activity().queued, 1, 'the queue counts again');
});

test('no shell is left running by this file', () => {
  for (const item of db.prepare('SELECT id FROM tasks').all()) terminal.closeTaskTerminals(item.id);
  assert.equal(liveSessionCount(), 0);
});
