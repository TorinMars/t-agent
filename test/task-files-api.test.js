const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-file-api-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'task-files-test-secret-task-files-test-secret';

const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports(req, res, next) { req.session = { user: { login: 'owner' } }; next(); },
};

const db = require('../db');
const { createEngineApp } = require('../apps/engine/app');
const { createAccessToken } = require('../services/engine-auth');
const { encryptToken } = require('../lib/token-crypto');

let localServer;
let engineServer;
let localBase;
let engineBase;
let task;
let operator;
let reader;

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

async function jsonRequest(base, route, { method = 'GET', token, body } = {}) {
  const response = await fetch(base + route, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  return { response, payload };
}

test.before(async () => {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'one\n');
  const id = db.prepare('INSERT INTO tasks (title, user_id, work_dir, md_path) VALUES (?, ?, ?, ?)')
    .run('files', 'owner', workspace, path.join(workspace, 'DESIGN.md')).lastInsertRowid;
  task = { id, workspace };
  operator = createAccessToken(db, { role: 'operator', principalId: 'owner' }).token;
  reader = createAccessToken(db, { role: 'readonly', principalId: 'owner' }).token;

  const localApp = express();
  localApp.use(express.json({ limit: '6mb' }));
  localApp.use('/api/tasks', require('../routes/tasks'));
  localApp.use('/api/remote-servers', require('../routes/remote-servers'));
  localServer = await listen(localApp);
  localBase = `http://127.0.0.1:${localServer.address().port}`;

  engineServer = await listen(createEngineApp());
  engineBase = `http://127.0.0.1:${engineServer.address().port}`;
});

test.after(async () => {
  if (localServer) await new Promise(resolve => localServer.close(resolve));
  if (engineServer) await new Promise(resolve => engineServer.close(resolve));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('local task file endpoints expose the locked contract and structured errors', async () => {
  const listed = await jsonRequest(localBase, `/api/tasks/${task.id}/files`);
  assert.equal(listed.response.status, 200);
  assert.equal(listed.payload.root, task.workspace);
  assert.equal(listed.payload.writable, true);
  assert.equal(listed.payload.entries.find(entry => entry.name === 'notes.txt').type, 'file');

  const opened = await jsonRequest(localBase, `/api/tasks/${task.id}/files/content?path=notes.txt`);
  assert.equal(opened.response.status, 200);
  assert.equal(opened.payload.content, 'one\n');

  const saved = await jsonRequest(localBase, `/api/tasks/${task.id}/files/content`, {
    method: 'PUT', body: { path: 'notes.txt', content: 'two\n', revision: opened.payload.revision },
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.payload.content, 'two\n');

  const conflict = await jsonRequest(localBase, `/api/tasks/${task.id}/files/content`, {
    method: 'PUT', body: { path: 'notes.txt', content: 'three\n', revision: opened.payload.revision },
  });
  assert.equal(conflict.response.status, 409);
  assert.deepEqual(conflict.payload, { error: 'FILE_CONFLICT' });

  const traversal = await jsonRequest(localBase, `/api/tasks/${task.id}/files/content?path=${encodeURIComponent('../secret')}`);
  assert.equal(traversal.response.status, 400);
  assert.deepEqual(traversal.payload, { error: 'FILE_PATH_INVALID' });
  assert.equal((await jsonRequest(localBase, '/api/tasks/999999/files')).response.status, 404);
});

test('Engine advertises file capabilities and enforces read and write scopes', async () => {
  const info = await jsonRequest(engineBase, '/v1/info', { token: reader });
  assert.equal(info.payload.capabilities.includes('files:read'), true);
  assert.equal(info.payload.capabilities.includes('files:write'), true);

  const readerList = await jsonRequest(engineBase, `/v1/tasks/${task.id}/files`, { token: reader });
  assert.equal(readerList.response.status, 200);
  assert.equal(readerList.payload.writable, false);
  const denied = await jsonRequest(engineBase, `/v1/tasks/${task.id}/files`, {
    method: 'POST', token: reader, body: { path: 'denied.txt', type: 'file' },
  });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.payload.error, 'ENGINE_SCOPE_REQUIRED');
  assert.equal(denied.payload.required_scope, 'files:write');

  const operatorList = await jsonRequest(engineBase, `/v1/tasks/${task.id}/files`, { token: operator });
  assert.equal(operatorList.payload.writable, true);
  const created = await jsonRequest(engineBase, `/v1/tasks/${task.id}/files`, {
    method: 'POST', token: operator, body: { path: 'created.txt', type: 'file' },
  });
  assert.equal(created.response.status, 201);
  assert.deepEqual(created.payload, { path: 'created.txt' });
});

test('remote proxy forwards supported file APIs and returns FILES_UNSUPPORTED for old Engines', async () => {
  const supportedId = db.prepare(`INSERT INTO remote_servers
    (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)`)
    .run('owner', 'supported', engineBase, encryptToken(operator, process.env.SESSION_SECRET)).lastInsertRowid;
  const proxied = await jsonRequest(localBase, `/api/remote-servers/${supportedId}/tasks/${task.id}/files`);
  assert.equal(proxied.response.status, 200);
  assert.equal(proxied.payload.entries.some(entry => entry.name === 'notes.txt'), true);

  const largeContent = '\n'.repeat(5 * 1024 * 1024);
  fs.writeFileSync(path.join(task.workspace, 'large.txt'), largeContent);
  const large = await jsonRequest(localBase, `/api/remote-servers/${supportedId}/tasks/${task.id}/files/content?path=large.txt`);
  assert.equal(large.response.status, 200);
  assert.equal(large.payload.content, largeContent);

  const oldApp = express();
  oldApp.get('/v1/info', (req, res) => res.json({ capabilities: ['tasks:read'] }));
  const oldServer = await listen(oldApp);
  try {
    const oldBase = `http://127.0.0.1:${oldServer.address().port}`;
    const oldId = db.prepare(`INSERT INTO remote_servers
      (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)`)
      .run('owner', 'old', oldBase, encryptToken('old-token', process.env.SESSION_SECRET)).lastInsertRowid;
    const unsupported = await jsonRequest(localBase, `/api/remote-servers/${oldId}/tasks/1/files`);
    assert.equal(unsupported.response.status, 501);
    assert.deepEqual(unsupported.payload, { error: 'FILES_UNSUPPORTED' });
  } finally {
    await new Promise(resolve => oldServer.close(resolve));
  }
});
