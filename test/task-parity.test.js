// The same task operations must behave alike on the local Client routes (/api/tasks),
// on an Engine (/v1/tasks) and through the Client's remote proxy
// (/api/remote-servers/:id/tasks). The browser uses one UI for all three.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-parity-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'task-parity-test-secret-task-parity-test-secret';

const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports(req, res, next) { req.session = { user: { login: 'owner', work_dir: path.join(root, 'tasks') } }; next(); },
};

const express = require('express');
const db = require('../db');
const { createAccessToken } = require('../services/engine-auth');
const { encryptToken } = require('../lib/token-crypto');

const servers = [];
function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('listening', () => { servers.push(server); resolve(`http://127.0.0.1:${server.address().port}`); });
    server.once('error', reject);
  });
}

let local, engine, proxy, engineToken, remoteId;

test.before(async () => {
  const localApp = express();
  localApp.use(express.json());
  localApp.use('/api/tasks', require('../routes/tasks'));
  local = await listen(localApp);

  const engineApp = express();
  engineApp.use(express.json());
  engineApp.use('/v1', require('../routes/engine-v1'));
  engine = await listen(engineApp);

  engineToken = createAccessToken(db, { role: 'operator', principalId: 'owner' }).token;
  remoteId = db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
    .run('owner', 'engine', engine, encryptToken(engineToken, process.env.SESSION_SECRET)).lastInsertRowid;
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

// Each backend exposes the same task routes under a different prefix.
const backends = () => [
  { name: 'local', base: local, tasks: '/api/tasks', headers: {} },
  { name: 'engine', base: engine, tasks: '/v1/tasks', headers: { Authorization: `Bearer ${engineToken}` } },
  { name: 'proxy', base: proxy, tasks: `/api/remote-servers/${remoteId}/tasks`, headers: {} },
];

async function call(backend, suffix, { method = 'GET', body } = {}) {
  const response = await fetch(backend.base + backend.tasks + suffix, {
    method,
    headers: { ...backend.headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return response;
}

async function createTask(backend, title) {
  const workDir = path.join(root, 'work', `${backend.name}-${title}`);
  fs.mkdirSync(workDir, { recursive: true });
  const response = await call(backend, '', { method: 'POST', body: { title, work_dir: workDir } });
  assert.equal(response.status, 201, `${backend.name} create`);
  return { ...(await response.json()), work_dir: workDir };
}

test('reorder updates sort_order on every backend', async () => {
  for (const backend of backends()) {
    const a = await createTask(backend, 'order-a');
    const b = await createTask(backend, 'order-b');
    const response = await call(backend, '/reorder', { method: 'PUT', body: [{ id: a.id, sort_order: 5 }, { id: b.id, sort_order: 2 }] });
    assert.equal(response.status, 200, `${backend.name} reorder`);
    const listed = await (await call(backend, '')).json();
    assert.equal(listed.find(task => task.id === a.id).sort_order, 5, backend.name);
    assert.equal(listed.find(task => task.id === b.id).sort_order, 2, backend.name);
    assert.equal((await call(backend, '/reorder', { method: 'PUT', body: { not: 'an array' } })).status, 400, backend.name);
  }
});

test('validate-path agrees on valid, missing and wrong-extension paths', async () => {
  const file = path.join(root, 'notes', 'plan.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# plan');
  for (const backend of backends()) {
    const ok = await (await call(backend, '/validate-path', { method: 'POST', body: { md_path: file } })).json();
    assert.deepEqual(ok, { valid: true, filename: 'plan', work_dir: path.dirname(file) }, backend.name);
    const missing = await (await call(backend, '/validate-path', { method: 'POST', body: { md_path: file + 'x.md' } })).json();
    assert.equal(missing.valid, false, backend.name);
    const relative = await (await call(backend, '/validate-path', { method: 'POST', body: { md_path: 'rel.md' } })).json();
    assert.match(relative.error, /absolute/, backend.name);
    assert.equal((await call(backend, '/validate-path', { method: 'POST', body: {} })).status, 400, backend.name);
  }
});

test('relative files next to the technical document are served, traversal is refused', async () => {
  for (const backend of backends()) {
    const task = await createTask(backend, 'assets');
    fs.writeFileSync(path.join(task.work_dir, 'diagram.txt'), 'binary-ish content');
    const ok = await call(backend, `/${task.id}/file?path=diagram.txt`);
    assert.equal(ok.status, 200, backend.name);
    assert.equal(await ok.text(), 'binary-ish content', backend.name);
    assert.equal((await call(backend, `/${task.id}/file?path=${encodeURIComponent('../secret')}`)).status, 400, backend.name);
    assert.equal((await call(backend, `/${task.id}/file?path=missing.png`)).status, 404, backend.name);
    if (backend.name !== 'local') {
      assert.equal(ok.headers.get('content-security-policy'), 'sandbox', `${backend.name} sandboxes task files`);
    }
  }
});

test('README and AGENTS.md can be created when missing, technical document cannot', async () => {
  for (const backend of backends()) {
    const task = await createTask(backend, 'docs');
    fs.rmSync(path.join(task.work_dir, 'README.md'), { force: true });
    const created = await call(backend, `/${task.id}/document/readme`, { method: 'POST', body: {} });
    assert.equal(created.status, 201, `${backend.name} create readme`);
    assert.ok(fs.existsSync(path.join(task.work_dir, 'README.md')), `${backend.name} wrote README.md`);
    assert.equal((await call(backend, `/${task.id}/document/agent`, { method: 'POST', body: {} })).status, 201, `${backend.name} create agent`);
    assert.equal((await call(backend, `/${task.id}/document/readme`)).status, 200, backend.name);
    assert.equal((await call(backend, `/${task.id}/document/technical`, { method: 'POST', body: {} })).status, 400, backend.name);
  }
});

test('documents are editable and todos have full CRUD on every backend', async () => {
  for (const backend of backends()) {
    const task = await createTask(backend, 'edit');
    const saved = await call(backend, `/${task.id}/document/technical`, { method: 'PUT', body: { content: '# edited' } });
    assert.equal(saved.status, 200, `${backend.name} save document`);
    assert.equal(await (await call(backend, `/${task.id}/document/technical`)).text(), '# edited', backend.name);

    const todo = await (await call(backend, `/${task.id}/todos`, { method: 'POST', body: { content: 'first' } })).json();
    assert.equal(todo.content, 'first', backend.name);
    const toggled = await (await call(backend, `/${task.id}/todos/${todo.id}`, { method: 'PUT', body: { completed: true } })).json();
    assert.equal(toggled.completed, true, backend.name);
    const renamed = await (await call(backend, `/${task.id}/todos/${todo.id}`, { method: 'PUT', body: { content: 'renamed' } })).json();
    assert.equal(renamed.content, 'renamed', backend.name);
    assert.equal((await call(backend, `/${task.id}/todos/${todo.id}`, { method: 'DELETE' })).status, 200, backend.name);
    assert.deepEqual(await (await call(backend, `/${task.id}/todos`)).json(), [], backend.name);
  }
});

test('task fields can be edited and tasks deleted on every backend', async () => {
  for (const backend of backends()) {
    const task = await createTask(backend, 'fields');
    const updated = await (await call(backend, `/${task.id}`, { method: 'PUT', body: { title: 'renamed', priority: 'high', due_date: '2030-01-02', status: 'doing' } })).json();
    assert.equal(updated.title, 'renamed', backend.name);
    assert.equal(updated.priority, 'high', backend.name);
    assert.equal(updated.due_date, '2030-01-02', backend.name);
    assert.equal(updated.status, 'doing', backend.name);
    assert.equal((await call(backend, `/${task.id}`, { method: 'DELETE' })).status, 200, backend.name);
    assert.equal((await call(backend, `/${task.id}/todos`)).status, 404, backend.name);
  }
});

test('document change events reach the browser through every backend', async () => {
  for (const backend of backends()) {
    const task = await createTask(backend, 'watch');
    const file = path.join(task.work_dir, 'DESIGN.md');
    const events = await new Promise((resolve, reject) => {
      const url = new URL(backend.base + backend.tasks + `/${task.id}/document/technical/watch`);
      const request = http.get(url, { headers: backend.headers }, response => {
        assert.match(response.headers['content-type'], /text\/event-stream/, backend.name);
        let received = '';
        response.on('data', chunk => {
          received += chunk;
          if (received.includes('data: changed')) { request.destroy(); resolve(received); }
        });
        setTimeout(() => fs.appendFileSync(file, '\nchanged\n'), 150);
      });
      request.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
      setTimeout(() => { request.destroy(); reject(new Error(`${backend.name}: no change event`)); }, 5000);
    });
    assert.match(events, /data: changed/, backend.name);
  }
});

test('Engine info advertises the parity capabilities and the proxy relays them', async () => {
  const direct = await (await fetch(`${engine}/v1/info`, { headers: { Authorization: `Bearer ${engineToken}` } })).json();
  for (const capability of ['tasks:reorder', 'documents:create', 'documents:watch', 'files:assets', 'paths:validate', 'terminal:activity']) {
    assert.ok(direct.capabilities.includes(capability), capability);
  }
  const relayed = await (await fetch(`${proxy}/api/remote-servers/${remoteId}/info`)).json();
  assert.deepEqual(relayed.capabilities, direct.capabilities);
  assert.equal(relayed.role, 'owner');
});

test('terminal activity is exposed by the local routes, the Engine and the proxy', async () => {
  const task = await createTask({ ...backends()[1] }, 'activity');
  assert.deepEqual(await (await fetch(`${engine}/v1/terminal-activity`, { headers: { Authorization: `Bearer ${engineToken}` } })).json(), {});
  assert.deepEqual(await (await fetch(`${proxy}/api/remote-servers/${remoteId}/terminal-activity`)).json(), {});
  const ack = await fetch(`${proxy}/api/remote-servers/${remoteId}/tasks/${task.id}/terminal/ack`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ terminal_id: 'default' }),
  });
  assert.equal(ack.status, 200);
  assert.equal((await fetch(`${engine}/v1/tasks/${task.id}/terminal/ack`, { method: 'POST', headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
});

test('every Engine token can edit through the proxy, whatever role was requested', async () => {
  const requestedReadonly = createAccessToken(db, { role: 'readonly', principalId: 'owner' }).token;
  const id = db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
    .run('owner', 'reader', engine.replace('127.0.0.1', 'localhost'), encryptToken(requestedReadonly, process.env.SESSION_SECRET)).lastInsertRowid;
  const task = await createTask(backends()[1], 'admin-check');
  const base = `${proxy}/api/remote-servers/${id}/tasks/${task.id}`;
  const put = await fetch(`${base}/document/technical`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'x' }) });
  assert.equal(put.status, 200);
  const todo = await fetch(`${base}/todos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'x' }) });
  assert.equal(todo.status, 201);
  const info = await (await fetch(`${proxy}/api/remote-servers/${id}/info`)).json();
  assert.equal(info.role, 'owner');
});
