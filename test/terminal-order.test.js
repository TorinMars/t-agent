// The shared order of a task's terminals (PUT …/terminals/order, "Terminal order" in DESIGN.md): stored per task, listed by every GET …/terminals,
// on this machine, through the Engine API and through the Client's remote proxy. The routes are the real ones; no shell is started.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-terminal-order-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'terminal-order-test-secret-terminal-order-test';
const workRoot = path.join(root, 'tasks');
fs.mkdirSync(workRoot, { recursive: true });

const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports(req, res, next) { req.session = { user: { login: 'owner', work_dir: workRoot } }; next(); },
};

const express = require('express');
const db = require('../db');
const { createAccessToken } = require('../services/engine-auth');
const { encryptToken } = require('../lib/token-crypto');
const { asOlderTask } = require('../test-support/older-tasks');
const engineTasks = require('../services/engine-tasks');
const terminal = require('../routes/terminal');

const servers = [];
const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); servers.push(server); });
let local, engine, proxy, auth, remoteId, oldRemoteId;
const oldEngineHits = [];

test.before(async () => {
  const localApp = express();
  localApp.use(express.json());
  localApp.use('/api/tasks', require('../routes/tasks'));
  local = await listen(localApp);

  const engineApp = express();
  engineApp.use(express.json());
  engineApp.use('/v1', require('../routes/engine-v1'));
  engine = await listen(engineApp);
  const token = createAccessToken(db, { principalId: 'owner' }).token;
  auth = { Authorization: `Bearer ${token}` };

  // An Engine from before the terminal order: no capability and no route.
  const oldApp = express();
  oldApp.use((req, res, next) => { oldEngineHits.push(`${req.method} ${req.url}`); next(); });
  oldApp.get('/v1/info', (req, res) => res.json({ capabilities: ['tasks:read', 'tasks:write', 'terminal:multiple'] }));
  const old = await listen(oldApp);

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
const ids = rows => rows.map(row => row.terminal_id);
const listLocal = async task => ids((await call('GET', `${local}/api/tasks/${task.id}/terminals`)).body);
const putLocal = (task, order) => call('PUT', `${local}/api/tasks/${task.id}/terminals/order`, { order });
const stored = task => {
  const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(`terminal_order_v1:${task.id}`);
  return row ? JSON.parse(row.value) : null;
};

test('a stored order is answered and listed; a new terminal goes last; unknown ids are ignored and missing ones keep their order after', async () => {
  const task = newTask('order');
  const [a, b, c] = [terminal.createTerminal(task.id).terminal_id, terminal.createTerminal(task.id).terminal_id, terminal.createTerminal(task.id).terminal_id];
  assert.deepEqual(await listLocal(task), [a, b, c], 'creation order before anything is stored');

  const put = await putLocal(task, [c, a, b]);
  assert.equal(put.status, 200);
  assert.deepEqual(put.body, { order: [c, a, b] });
  assert.deepEqual(await listLocal(task), [c, a, b]);

  const d = terminal.createTerminal(task.id).terminal_id;
  assert.deepEqual(await listLocal(task), [c, a, b, d], 'a terminal the order does not name comes last');

  // `b` first; `nope` is no terminal; a duplicate counts once; c, a and d are left out and keep their relative order after b.
  const partial = await putLocal(task, ['nope', b, b]);
  assert.deepEqual(partial.body, { order: [b, c, a, d] });
  assert.deepEqual(await listLocal(task), [b, c, a, d]);
  assert.deepEqual(stored(task), [b, c, a, d]);

  assert.deepEqual((await putLocal(task, [])).body, { order: [b, c, a, d] }, 'an empty list changes nothing');
});

test('a deleted terminal leaves the stored order; a deleted task loses its row', async () => {
  const task = newTask('delete');
  const [a, b] = [terminal.createTerminal(task.id).terminal_id, terminal.createTerminal(task.id).terminal_id];
  await putLocal(task, [b, a]);
  assert.equal((await call('POST', `${local}/api/tasks/${task.id}/terminal/control`, { action: 'delete', terminal_id: b })).status, 200);
  assert.deepEqual(stored(task), [a]);
  assert.deepEqual(await listLocal(task), [a]);
  assert.equal((await call('POST', `${local}/api/tasks/${task.id}/terminal/control`, { action: 'delete', terminal_id: a })).status, 200);
  assert.equal(stored(task), null, 'nothing left: no row');

  const gone = newTask('gone');
  const x = terminal.createTerminal(gone.id).terminal_id;
  await putLocal(gone, [x]);
  assert.equal((await call('DELETE', `${local}/api/tasks/${gone.id}`)).status, 200);
  assert.equal(stored(gone), null);

  const engineGone = newTask('engine gone');
  await putLocal(engineGone, [terminal.createTerminal(engineGone.id).terminal_id]);
  assert.equal((await call('DELETE', `${engine}/v1/tasks/${engineGone.id}`, undefined, auth)).status, 200);
  assert.equal(stored(engineGone), null);
});

test('the default terminal of an older task is ordered like the others', async () => {
  const task = asOlderTask(db, newTask('older'));
  const a = terminal.createTerminal(task.id).terminal_id;
  assert.deepEqual(await listLocal(task), ['default', a]);
  assert.deepEqual((await putLocal(task, [a, 'default'])).body, { order: [a, 'default'] });
  assert.deepEqual(await listLocal(task), [a, 'default']);
});

test('invalid bodies are 400 INVALID_TERMINAL_ORDER; an unknown or foreign task is 404; an archived task is 409', async () => {
  const task = newTask('invalid');
  terminal.createTerminal(task.id);
  for (const body of [{}, { order: 'x' }, { order: [1] }, { order: [null] }, { order: { a: 1 } }, { order: Array(501).fill('x') }, { order: ['x'.repeat(129)] }]) {
    const answer = await call('PUT', `${local}/api/tasks/${task.id}/terminals/order`, body);
    assert.equal(answer.status, 400, JSON.stringify(body).slice(0, 60));
    assert.deepEqual(answer.body, { error: 'INVALID_TERMINAL_ORDER' });
  }
  assert.equal(stored(task), null, 'nothing was written');

  const theirs = newTask('theirs', 'someone-else');
  for (const id of [theirs.id, 999999]) {
    assert.deepEqual(await call('PUT', `${local}/api/tasks/${id}/terminals/order`, { order: [] }), { status: 404, body: { error: 'TASK_NOT_FOUND' } });
    assert.deepEqual(await call('PUT', `${engine}/v1/tasks/${id}/terminals/order`, { order: [] }, auth), { status: 404, body: { error: 'TASK_NOT_FOUND' } });
  }

  const archived = newTask('archived');
  const a = terminal.createTerminal(archived.id).terminal_id;
  assert.equal((await call('POST', `${local}/api/tasks/${archived.id}/archive`)).status, 200);
  assert.deepEqual(await putLocal(archived, [a]), { status: 409, body: { error: 'TASK_ARCHIVED' } });
  assert.deepEqual(await call('PUT', `${engine}/v1/tasks/${archived.id}/terminals/order`, { order: [a] }, auth), { status: 409, body: { error: 'TASK_ARCHIVED' } });
});

test('the Engine API stores the same order with a token, advertises terminals:order, and refuses without a token', async () => {
  const info = await call('GET', `${engine}/v1/info`, undefined, auth);
  assert.ok(info.body.capabilities.includes('terminals:order'));

  const task = newTask('engine');
  const [a, b] = [terminal.createTerminal(task.id).terminal_id, terminal.createTerminal(task.id).terminal_id];
  assert.equal((await call('PUT', `${engine}/v1/tasks/${task.id}/terminals/order`, { order: [b, a] })).status, 401);
  const put = await call('PUT', `${engine}/v1/tasks/${task.id}/terminals/order`, { order: [b, a] }, auth);
  assert.deepEqual(put, { status: 200, body: { order: [b, a] } });
  assert.deepEqual(ids((await call('GET', `${engine}/v1/tasks/${task.id}/terminals`, undefined, auth)).body), [b, a]);
  assert.deepEqual(await listLocal(task), [b, a], 'this machine lists the order the Engine API stored');
  assert.deepEqual((await call('PUT', `${engine}/v1/tasks/${task.id}/terminals/order`, { order: 'x' }, auth)).body, { error: 'INVALID_TERMINAL_ORDER' });
});

test('the remote proxy forwards the order to an Engine that has it and answers 501 for an older one without sending it', async () => {
  const task = newTask('proxy');
  const [a, b, c] = [terminal.createTerminal(task.id).terminal_id, terminal.createTerminal(task.id).terminal_id, terminal.createTerminal(task.id).terminal_id];
  const base = `${proxy}/api/remote-servers/${remoteId}/tasks/${task.id}/terminals`;
  assert.deepEqual(await call('PUT', `${base}/order`, { order: [c, b, a], extra: true }), { status: 200, body: { order: [c, b, a] } });
  assert.deepEqual(ids((await call('GET', base)).body), [c, b, a]);
  assert.deepEqual(await call('PUT', `${base}/order`, { order: [1] }), { status: 400, body: { error: 'INVALID_TERMINAL_ORDER' } });
  assert.deepEqual(await call('PUT', `${proxy}/api/remote-servers/${remoteId}/tasks/999999/terminals/order`, { order: [] }), { status: 404, body: { error: 'TASK_NOT_FOUND' } });

  oldEngineHits.length = 0;
  assert.deepEqual(await call('PUT', `${proxy}/api/remote-servers/${oldRemoteId}/tasks/1/terminals/order`, { order: [] }), { status: 501, body: { error: 'TERMINAL_ORDER_UNSUPPORTED' } });
  assert.deepEqual(oldEngineHits, ['GET /v1/info'], 'only the capability was read');
  assert.deepEqual(await call('PUT', `${proxy}/api/remote-servers/424242/tasks/1/terminals/order`, { order: [] }), { status: 404, body: { error: 'REMOTE_NOT_FOUND' } });
});

test('the order survives a restart of the service', async () => {
  const task = newTask('restart');
  const [a, b, c] = [terminal.createTerminal(task.id).terminal_id, terminal.createTerminal(task.id).terminal_id, terminal.createTerminal(task.id).terminal_id];
  await putLocal(task, [b, c, a]);
  // A new process on the same data folder: the database and the terminal module start from scratch.
  const script = `const t = require(${JSON.stringify(path.resolve(__dirname, '../routes/terminal'))}); process.stdout.write(JSON.stringify(t.listTerminals(${task.id}).map(r => r.terminal_id))); process.exit(0);`;
  const out = execFileSync(process.execPath, ['-e', script], { env: { ...process.env }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), [b, c, a]);
});
