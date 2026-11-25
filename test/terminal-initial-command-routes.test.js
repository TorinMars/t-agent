// The initial command over HTTP ("Initial command" in docs/design/terminals.md): POST /api/tasks/:id/terminals refuses a bad one with 400, the
// Engine's /v1/info lists 'terminal:initial-command', and the Client's proxy forwards `command` to an Engine that lists it and refuses (501
// INITIAL_COMMAND_UNSUPPORTED) one that does not, before anything is made. Temporary data folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-initial-command-routes-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'initial-command-test-secret-initial-command-test-secret';
const workRoot = path.join(root, 'tasks');
fs.mkdirSync(workRoot, { recursive: true });

const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports(req, res, next) { req.session = { user: { login: 'owner', work_dir: workRoot } }; next(); },
};

const express = require('express');
const db = require('../db');
const terminal = require('../routes/terminal');
const engineTasks = require('../services/engine-tasks');
const { createAccessToken } = require('../services/engine-auth');
const { encryptToken } = require('../lib/token-crypto');

const servers = [];
const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); servers.push(server); });
let local, engine, proxy, auth, newId, oldId;
const received = [];

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
  // Two stand-in Engines: one that lists the capability (it records what it was sent), an older one that does not.
  const fake = capabilities => {
    const app = express();
    app.use(express.json());
    app.get('/v1/info', (req, res) => res.json({ capabilities }));
    app.post('/v1/tasks/:id/terminals', (req, res) => { received.push({ capabilities, body: req.body }); res.status(201).json({ terminal_id: 'made', title: 'Terminal 2', agent: null }); });
    return listen(app);
  };
  const remote = base => db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
    .run('owner', base, base, encryptToken(token, process.env.SESSION_SECRET)).lastInsertRowid;
  newId = remote(await fake(['tasks:read', 'terminal:execute', 'terminal:initial-command']));
  oldId = remote(await fake(['tasks:read', 'terminal:execute']));
  const proxyApp = express();
  proxyApp.use(express.json());
  proxyApp.use('/api/remote-servers', require('../routes/remote-servers'));
  proxy = await listen(proxyApp);
});

test.after(async () => {
  terminal.shutdownTerminals();
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); })));
  db.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function call(method, url, body, headers = {}) {
  const response = await fetch(url, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: parsed };
}

test('the local route takes a command for a plain terminal and refuses a bad one', async () => {
  const task = engineTasks.createTask('owner', { title: 'local' });
  const made = await call('POST', `${local}/api/tasks/${task.id}/terminals`, { command: 'npm run dev', title: 'dev' });
  assert.equal(made.status, 201);
  assert.equal(made.body.title, 'dev');
  const bad = async (body, error) => {
    const answer = await call('POST', `${local}/api/tasks/${task.id}/terminals`, body);
    assert.deepEqual([answer.status, answer.body.error], [400, error], JSON.stringify(body).slice(0, 60));
  };
  await bad({ command: 'x'.repeat(4001) }, 'INITIAL_COMMAND_TOO_LONG');
  await bad({ command: ['ls'] }, 'INVALID_INITIAL_COMMAND');
  await bad({ agent: 'claude', command: 'ls' }, 'INITIAL_COMMAND_NOT_A_TERMINAL');
  await bad({ agent: 'notebook', command: 'ls' }, 'INITIAL_COMMAND_NOT_A_TERMINAL');
  assert.equal((await call('GET', `${local}/api/tasks/${task.id}/terminals`)).body.length, 1, 'only the good one was made');
});

test('the Engine lists terminal:initial-command and takes the field on /v1', async () => {
  const info = await call('GET', `${engine}/v1/info`, undefined, auth);
  assert.ok(info.body.capabilities.includes('terminal:initial-command'));
  const task = engineTasks.createTask('owner', { title: 'engine' });
  assert.equal((await call('POST', `${engine}/v1/tasks/${task.id}/terminals`, { command: 'ls' }, auth)).status, 201);
  const refused = await call('POST', `${engine}/v1/tasks/${task.id}/terminals`, { agent: 'codex', command: 'ls' }, auth);
  assert.deepEqual([refused.status, refused.body.error], [400, 'INITIAL_COMMAND_NOT_A_TERMINAL']);
});

test('the proxy forwards the command to an Engine that can run it and refuses an older one', async () => {
  const made = await call('POST', `${proxy}/api/remote-servers/${newId}/tasks/1/terminals`, { command: 'make watch', title: 'w', extra: 'dropped' });
  assert.equal(made.status, 201);
  assert.deepEqual(received.at(-1).body, { title: 'w', command: 'make watch' }, 'name and command are forwarded, nothing else');
  const count = received.length;
  const old = await call('POST', `${proxy}/api/remote-servers/${oldId}/tasks/1/terminals`, { command: 'make watch' });
  assert.deepEqual([old.status, old.body.error], [501, 'INITIAL_COMMAND_UNSUPPORTED']);
  assert.equal(received.length, count, 'nothing was made on the older Engine');
  // Without a command (or a blank one) the older Engine is used as before.
  assert.equal((await call('POST', `${proxy}/api/remote-servers/${oldId}/tasks/1/terminals`, { command: '  ' })).status, 201);
  assert.equal((await call('POST', `${proxy}/api/remote-servers/${oldId}/tasks/1/terminals`, {})).status, 201);
});
