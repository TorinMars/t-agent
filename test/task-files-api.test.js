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

function createEngineApp() {
  const app = express();
  app.use(express.json({ limit: '32mb' }));
  app.use('/v1', require('../routes/engine-v1'));
  return app;
}
const db = require('../db');
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

test('Engine advertises file capabilities and every token can read and write files', async () => {
  const info = await jsonRequest(engineBase, '/v1/info', { token: reader });
  assert.equal(info.payload.capabilities.includes('files:read'), true);
  assert.equal(info.payload.capabilities.includes('files:write'), true);

  // every connection has admin rights: even a token requested as readonly can write files.
  for (const [name, token] of [['reader', reader], ['operator', operator]]) {
    const list = await jsonRequest(engineBase, `/v1/tasks/${task.id}/files`, { token });
    assert.equal(list.payload.writable, true, name);
    const created = await jsonRequest(engineBase, `/v1/tasks/${task.id}/files`, {
      method: 'POST', token, body: { path: `created-by-${name}.txt`, type: 'file' },
    });
    assert.equal(created.response.status, 201, name);
    assert.deepEqual(created.payload, { path: `created-by-${name}.txt` });
  }
  assert.equal((await jsonRequest(engineBase, `/v1/tasks/${task.id}/files`)).response.status, 401);
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

test('images of the working directory are served for Markdown previews: local, Engine and proxy; only real PNG/JPEG/GIF/WebP, no links, size-limited', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  fs.mkdirSync(path.join(task.workspace, 'docs', 'img'), { recursive: true });
  fs.writeFileSync(path.join(task.workspace, 'docs', 'img', 'shot.png'), png);
  fs.writeFileSync(path.join(task.workspace, 'fake.png'), 'not an image');
  fs.writeFileSync(path.join(task.workspace, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  fs.writeFileSync(path.join(task.workspace, 'big.png'), Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]));
  fs.symlinkSync(path.join(task.workspace, 'docs', 'img', 'shot.png'), path.join(task.workspace, 'link.png'));
  const known = db.prepare('SELECT id FROM remote_servers WHERE owner_id = ? AND base_url = ?').get('owner', engineBase);
  const supportedId = known ? known.id : db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
    .run('owner', 'images', engineBase, encryptToken(operator, process.env.SESSION_SECRET)).lastInsertRowid;
  const bases = [
    [`${localBase}/api/tasks/${task.id}/files/image`, {}],
    [`${engineBase}/v1/tasks/${task.id}/files/image`, { Authorization: `Bearer ${reader}` }],
    [`${localBase}/api/remote-servers/${supportedId}/tasks/${task.id}/files/image`, {}],
  ];
  for (const [base, headers] of bases) {
    const ok = await fetch(`${base}?path=${encodeURIComponent('docs/img/shot.png')}`, { headers });
    assert.equal(ok.status, 200, base);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.equal(ok.headers.get('content-security-policy'), 'sandbox');
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), png);
    const status = async name => { const response = await fetch(`${base}?path=${encodeURIComponent(name)}`, { headers }); await response.arrayBuffer(); return response.status; };
    assert.equal(await status('fake.png'), 415, 'the content must be an image');
    assert.equal(await status('logo.svg'), 415, 'no SVG');
    assert.equal(await status('notes.txt'), 415);
    assert.equal(await status('big.png'), 413, 'size limit');
    assert.equal(await status('link.png'), 415, 'no symbolic links');
    assert.equal(await status('../secret.png'), 400, 'inside the working directory only');
    assert.equal(await status('missing.png'), 404);
  }
  // A new endpoint is declared in /v1/info (API version unchanged), so a Client can tell an Engine that has it.
  const info = await (await fetch(`${engineBase}/v1/info`, { headers: { Authorization: `Bearer ${reader}` } })).json();
  assert.ok(info.capabilities.includes('files:image'));
  assert.equal(info.api_version, 1);
});
