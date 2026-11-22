// OpenCode terminals across engines (docs/design/opencode-terminals.md): the Engine API advertises `terminal:opencode`, makes OpenCode terminals and lists
// OpenCode sessions; the Client's remote proxy refuses an OpenCode terminal on an older Engine (501 OPENCODE_UNSUPPORTED) before anything is sent.
// The routes are the real ones; no shell is started, and opencode's database is a fixture in a temporary home.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-opencode-engine-')));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'opencode-engine-test-secret-opencode-engine-test';
process.env.HOME = path.join(root, 'home');
for (const key of ['XDG_DATA_HOME', 'OPENCODE_DB']) delete process.env[key];
const workRoot = path.join(root, 'tasks');
fs.mkdirSync(workRoot, { recursive: true });

const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports(req, res, next) { req.session = { user: { login: 'owner', work_dir: workRoot } }; next(); },
};

const express = require('express');
const Database = require('better-sqlite3');
const db = require('../db');
const { createAccessToken } = require('../services/engine-auth');
const { encryptToken } = require('../lib/token-crypto');
const engineTasks = require('../services/engine-tasks');
const { sessionFiles } = require('../lib/agent-sessions');

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

  // An Engine from before OpenCode terminals: no capability (it would make a plain shell for the agent).
  const oldApp = express();
  oldApp.use(express.json());
  oldApp.use((req, res, next) => { oldEngineHits.push(`${req.method} ${req.url}`); next(); });
  oldApp.get('/v1/info', (req, res) => res.json({ capabilities: ['tasks:read', 'tasks:write', 'terminal:multiple', 'terminals:order'] }));
  oldApp.post('/v1/tasks/:id/terminals', (req, res) => res.status(201).json({ terminal_id: 'x', title: 'Terminal 2', agent: null }));
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

function addSession(dir, id, title) {
  const file = path.join(process.env.HOME, '.local', 'share', 'opencode', 'opencode.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const handle = new Database(file);
  handle.exec(`CREATE TABLE IF NOT EXISTS session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL,
    title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer)`);
  handle.prepare("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'global', 'calm-fox', ?, ?, '1.19.6', 1, 2)")
    .run(id, fs.realpathSync(dir), title);
  handle.close();
  sessionFiles.clear();
}

test('the Engine API advertises terminal:opencode, makes OpenCode terminals and lists OpenCode sessions', async () => {
  const info = await call('GET', `${engine}/v1/info`, undefined, auth);
  assert.ok(info.body.capabilities.includes('terminal:opencode'));
  const task = engineTasks.createTask('owner', { title: 'engine opencode' });
  const made = await call('POST', `${engine}/v1/tasks/${task.id}/terminals`, { agent: 'opencode' }, auth);
  assert.equal(made.status, 201);
  assert.equal(made.body.agent, 'opencode');
  assert.match(made.body.title, /^OpenCode \d+$/);
  addSession(task.work_dir, 'ses_dfb2ee3277777JJJJJJJJJJJJJ', 'Engine session');
  assert.deepEqual((await call('GET', `${engine}/v1/tasks/${task.id}/agent-sessions?agent=opencode`, undefined, auth)).body.map(entry => [entry.id, entry.title]),
    [['ses_dfb2ee3277777JJJJJJJJJJJJJ', 'Engine session']]);
  assert.deepEqual((await call('GET', `${local}/api/tasks/${task.id}/agent-sessions?agent=opencode`)).body.map(entry => entry.id), ['ses_dfb2ee3277777JJJJJJJJJJJJJ'], 'this machine lists them the same');
  assert.deepEqual(await call('GET', `${local}/api/tasks/${task.id}/agent-sessions?agent=gemini`), { status: 400, body: { error: 'INVALID_AGENT' } });
});

test('the proxy makes an OpenCode terminal on an Engine that has it and refuses an older one without sending anything', async () => {
  const task = engineTasks.createTask('owner', { title: 'proxy opencode' });
  const made = await call('POST', `${proxy}/api/remote-servers/${remoteId}/tasks/${task.id}/terminals`, { agent: 'opencode' });
  assert.equal(made.status, 201);
  assert.equal(made.body.agent, 'opencode');
  addSession(task.work_dir, 'ses_dfb2ee3278888KKKKKKKKKKKKK', 'Through the proxy');
  assert.deepEqual((await call('GET', `${proxy}/api/remote-servers/${remoteId}/tasks/${task.id}/agent-sessions?agent=opencode`)).body.map(entry => entry.title), ['Through the proxy']);

  oldEngineHits.length = 0;
  assert.deepEqual(await call('POST', `${proxy}/api/remote-servers/${oldRemoteId}/tasks/1/terminals`, { agent: 'opencode' }), { status: 501, body: { error: 'OPENCODE_UNSUPPORTED' } });
  assert.deepEqual(oldEngineHits, ['GET /v1/info'], 'only the capability was asked');
  const codex = await call('POST', `${proxy}/api/remote-servers/${oldRemoteId}/tasks/1/terminals`, { agent: 'codex' });
  assert.equal(codex.status, 201, 'other agents go through as before');
  assert.deepEqual(oldEngineHits, ['GET /v1/info', 'POST /v1/tasks/1/terminals'], 'without a capability check');
});
