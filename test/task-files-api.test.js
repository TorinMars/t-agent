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

let localServer;
let localBase;
let task;

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

  const localApp = express();
  localApp.use(express.json({ limit: '6mb' }));
  localApp.use('/api/tasks', require('../routes/tasks'));
  localServer = await listen(localApp);
  localBase = `http://127.0.0.1:${localServer.address().port}`;
});

test.after(async () => {
  if (localServer) await new Promise(resolve => localServer.close(resolve));
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
