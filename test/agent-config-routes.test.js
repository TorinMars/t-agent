const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const { encryptToken } = require('../lib/token-crypto');
const { createClientRouter, createEngineRouter } = require('../routes/agent-config');
const { createAgentConfig } = require('../services/agent-config');

const SECRET = 'secret';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-acr-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function database() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE remote_servers (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, name TEXT NOT NULL, base_url TEXT NOT NULL,
      token_cipher TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
  const add = (owner, name, url) => db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)').run(owner, name, url, encryptToken(`tok-${name}`, SECRET)).lastInsertRowid;
  return { db, add };
}
async function listen(app) {
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body) => {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { call, close: () => server.close() };
}

test('Push: the local machine writes files directly; remote ones call the Engine with their own effective values (default + override); an old Engine reports unsupported; the result is recorded in the state', async () => {
  const { db, add } = database();
  const okId = add('me', 'Server A', 'http://a.test');
  const oldId = add('me', 'Old server', 'http://old.test');
  add('someone-else', 'Someone else’s', 'http://x.test');
  const calls = [];
  const remoteRequest = async (base, pathname, token, options = {}) => {
    calls.push({ base, pathname, token, method: options.method || 'GET', body: options.body });
    if (base === 'http://old.test') throw Object.assign(new Error('REMOTE_HTTP_404'), { statusCode: 404 });
    return { changed: Object.keys(options.body.values), tool: options.body.tool };
  };
  const app = express();
  app.use(express.json());
  app.use('/api/agent-config', createClientRouter({ db, sessionSecret: SECRET, service: createAgentConfig({ env: {}, home }), remoteRequest, requireAuth: (req, res, next) => { req.session = { user: { login: 'me' } }; next(); } }));
  const { call, close } = await listen(app);
  try {
    const overview = await call('GET', '/api/agent-config');
    assert.deepEqual(overview.body.servers.map(item => item.name), ['This machine', 'Server A', 'Old server']);
    assert.equal(overview.body.schema.claude[0].key, 'permission');

    assert.equal((await call('PUT', '/api/agent-config/defaults', { tool: 'claude', values: { model: 'sonnet', permission: 'plan' } })).status, 200);
    assert.equal((await call('PUT', `/api/agent-config/servers/${okId}`, { tool: 'claude', values: { model: 'opus' } })).status, 200);
    assert.equal((await call('PUT', '/api/agent-config/servers/999', { tool: 'claude', values: {} })).status, 404);
    assert.equal((await call('PUT', '/api/agent-config/defaults', { tool: 'claude', values: { bogus: '1' } })).status, 400);

    const pushed = await call('POST', '/api/agent-config/push', {});
    assert.equal(pushed.status, 200);
    const byName = Object.fromEntries(pushed.body.results.map(item => [item.name, item]));
    assert.equal(byName['This machine'].ok, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8')).model, 'sonnet');
    assert.equal(byName['Server A'].ok, true);
    assert.deepEqual(calls.find(item => item.base === 'http://a.test').body, { tool: 'claude', values: { model: 'opus', permission: 'plan' } });
    assert.equal(calls.find(item => item.base === 'http://a.test').token, 'tok-Server A');
    assert.equal(calls.some(item => item.base === 'http://x.test'), false);
    assert.equal(byName['Old server'].ok, false);
    assert.equal(byName['Old server'].tools.claude.error, 'AGENT_CONFIG_UNSUPPORTED');
    assert.equal(byName['Old server'].tools.codex.skipped, true);

    const after = (await call('GET', '/api/agent-config')).body;
    assert.equal(after.status.local.ok, true);
    assert.equal(after.status[oldId].ok, false);

    const current = await call('GET', '/api/agent-config/servers/local/current');
    assert.equal(current.body.claude.model, 'sonnet');
    assert.equal((await call('GET', `/api/agent-config/servers/${oldId}/current`)).status, 501);
  } finally { close(); }
});

test('Engine endpoint: read current values, write, reject invalid content', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-acr-engine-'));
  const app = express();
  app.use(express.json());
  app.use('/v1/agent-config', createEngineRouter({ service: createAgentConfig({ env: {}, home: dir }), guard: (req, res, next) => next() }));
  const { call, close } = await listen(app);
  try {
    assert.equal((await call('PUT', '/v1/agent-config', { tool: 'codex', values: { model: 'gpt-x', sandbox: 'read-only' } })).body.changed.length, 2);
    assert.equal((await call('GET', '/v1/agent-config')).body.codex.sandbox, 'read-only');
    assert.equal((await call('PUT', '/v1/agent-config', { tool: 'codex', values: { sandbox: 'nope' } })).status, 400);
    assert.equal((await call('PUT', '/v1/agent-config', { tool: 'zsh', values: {} })).status, 400);
  } finally { close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
