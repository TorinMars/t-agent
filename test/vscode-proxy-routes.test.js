'use strict';
// The page's start, status and licence routes of VS Code in the browser: routes/tasks.js (this engine, through services/vscode-local-transport.js with
// a fake manager) and routes/remote-servers.js (a fake remote engine that answers Contract A). No VS Code, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-vscode-routes-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'vscode-routes-test-secret-vscode-routes-test-secret';
delete process.env.TAGENT_HOME;

const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports(req, res, next) { req.session = { user: { login: 'owner' } }; req.sessionID = 'sid-routes'; next(); },
};

const express = require('express');
const db = require('../db');
const tasks = require('../services/engine-tasks');
const { encryptToken } = require('../lib/token-crypto');
const localTransport = require('../services/vscode-local-transport');

const ENGINE_TOKEN = 'tae_routes-engine-token';
const servers = [];
const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); servers.push(server); });

const engineCalls = [];
let capabilities = ['vscode:web'];
let page;
let remoteId;
let otherId;
let task;

test.before(async () => {
  const engine = express();
  engine.use(express.json());
  engine.use((req, res, next) => (req.headers.authorization === `Bearer ${ENGINE_TOKEN}` ? next() : res.status(401).json({ error: 'UNAUTHORIZED' })));
  engine.get('/v1/info', (req, res) => res.json({ engine_version: '1.0.0', capabilities }));
  const answer = { state: 'ready', engine_id: 'remote-engine', base_path: '/vscode/remote-engine', open_path: '/vscode/remote-engine/?folder=%2Fsrv%2Fproj', folder: '/srv/proj' };
  engine.all('/v1/tasks/:id/terminals/:terminalId/vscode', (req, res) => {
    engineCalls.push({ method: req.method, url: req.url, body: req.body });
    if (req.params.id === '404') return res.status(404).json({ error: 'TASK_NOT_FOUND' });
    if (req.params.terminalId === 'license') return res.json({ state: 'error', error: 'VSCODE_LICENSE_REQUIRED', engine_id: 'remote-engine' });
    res.json(req.method === 'GET' ? { ...answer, state: 'starting' } : answer);
  });
  engine.post('/v1/tasks/:id/terminals/:terminalId/vscode/accept-license', (req, res) => { engineCalls.push({ method: 'POST', url: req.url }); res.json({ accepted: true }); });
  const engineBase = await listen(engine);
  const insert = owner => db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)').run(owner, 'Engine', engineBase, encryptToken(ENGINE_TOKEN, process.env.SESSION_SECRET)).lastInsertRowid;
  remoteId = insert('owner');
  otherId = insert('other');
  task = tasks.createTask('owner', { title: 'vscode routes' });

  const client = express();
  client.set('trust proxy', 1);
  client.use(express.json());
  client.use('/api/tasks', require('../routes/tasks'));
  client.use('/api/remote-servers', require('../routes/remote-servers'));
  page = await listen(client);
});

test.after(async () => {
  localTransport.setManagerForTests(null);
  require('../services/vscode-proxy').getVscodeProxy().stop();
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function call(method, url, { headers = {} } = {}) {
  const response = await fetch(page + url, { method, headers: { 'content-type': 'application/json', ...headers }, ...(method === 'GET' ? {} : { body: '{}' }), signal: AbortSignal.timeout(8000) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test('this engine: start goes to the manager with the public host and comes back with a single-use open_url', async () => {
  const calls = [];
  localTransport.setManagerForTests({
    start: async args => { calls.push(['start', args]); return { state: 'ready', engine_id: 'local-engine', base_path: '/vscode/local-engine', open_path: '/vscode/local-engine/?folder=%2Ftmp%2Fa', folder: '/tmp/a' }; },
    status: async args => { calls.push(['status', args]); return { state: 'starting', engine_id: 'local-engine' }; },
    acceptLicense: async args => { calls.push(['accept', args]); return { accepted: true }; },
  });
  const started = await call('POST', `/api/tasks/${task.id}/terminals/default/vscode`, { headers: { 'x-forwarded-host': 't.example.com', 'x-forwarded-proto': 'https' } });
  assert.equal(started.status, 200);
  assert.equal(started.headers.get('cache-control'), 'no-store');
  assert.match(started.body.open_url, /^\/vscode\/local-engine\/\?folder=%2Ftmp%2Fa&ta_launch=tvl_[A-Za-z0-9_-]{32}$/);
  assert.equal(started.body.state, 'ready');
  assert.deepEqual(calls[0], ['start', { taskId: task.id, terminalId: 'default', host: 't.example.com', proto: 'https', owner: 'owner' }]);

  const status = await call('GET', `/api/tasks/${task.id}/terminals/default/vscode`);
  assert.equal(status.body.state, 'starting');
  assert.equal(status.body.open_url, undefined, 'no ticket before VS Code is ready');
  assert.deepEqual((await call('POST', `/api/tasks/${task.id}/terminals/default/vscode/accept-license`)).body, { accepted: true });
  assert.equal(calls.at(-1)[0], 'accept');

  const missing = await call('POST', '/api/tasks/999999/terminals/default/vscode');
  assert.deepEqual([missing.status, missing.body], [404, { error: 'TASK_NOT_FOUND' }]);

  localTransport.setManagerForTests({ start: async () => { throw Object.assign(new Error('VSCODE_NOT_INSTALLED'), { statusCode: 409 }); } });
  const refused = await call('POST', `/api/tasks/${task.id}/terminals/default/vscode`);
  assert.deepEqual([refused.status, refused.body], [409, { error: 'VSCODE_NOT_INSTALLED' }]);
  localTransport.setManagerForTests({ start: async () => { throw new Error('something with /a/path in it'); } });
  assert.deepEqual((await call('POST', `/api/tasks/${task.id}/terminals/default/vscode`)).body, { error: 'VSCODE_START_FAILED' });
});

test('a remote engine: Contract A with its token and the public host, open_url only when ready, its errors passed on', async () => {
  capabilities = ['vscode:web'];
  engineCalls.length = 0;
  const started = await call('POST', `/api/remote-servers/${remoteId}/tasks/7/terminals/t-1/vscode`, { headers: { 'x-forwarded-host': 'page.example.com' } });
  assert.equal(started.status, 200);
  assert.match(started.body.open_url, /^\/vscode\/remote-engine\/\?folder=%2Fsrv%2Fproj&ta_launch=tvl_/);
  assert.deepEqual(engineCalls[0], { method: 'POST', url: '/v1/tasks/7/terminals/t-1/vscode', body: { host: 'page.example.com', proto: 'http' } });

  const status = await call('GET', `/api/remote-servers/${remoteId}/tasks/7/terminals/t-1/vscode`);
  assert.equal(status.body.state, 'starting');
  assert.equal(status.body.open_url, undefined);

  const license = await call('POST', `/api/remote-servers/${remoteId}/tasks/7/terminals/license/vscode`);
  assert.equal(license.body.error, 'VSCODE_LICENSE_REQUIRED');
  assert.equal(license.body.open_url, undefined);
  assert.deepEqual((await call('POST', `/api/remote-servers/${remoteId}/tasks/7/terminals/t-1/vscode/accept-license`)).body, { accepted: true });

  const missing = await call('POST', `/api/remote-servers/${remoteId}/tasks/404/terminals/t-1/vscode`);
  assert.deepEqual([missing.status, missing.body], [404, { error: 'TASK_NOT_FOUND' }]);
  const other = await call('POST', `/api/remote-servers/${otherId}/tasks/7/terminals/t-1/vscode`);
  assert.deepEqual([other.status, other.body], [404, { error: 'REMOTE_NOT_FOUND' }]);
});

test('a remote engine without the capability answers 501 and is not asked to start', async () => {
  capabilities = ['files:read'];
  engineCalls.length = 0;
  const answer = await call('POST', `/api/remote-servers/${remoteId}/tasks/7/terminals/t-1/vscode`);
  assert.deepEqual([answer.status, answer.body], [501, { error: 'VSCODE_WEB_UNSUPPORTED' }]);
  assert.equal(engineCalls.length, 0);
  capabilities = ['vscode:web'];
});
