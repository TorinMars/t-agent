// The routes of "When engines run different versions" (docs/design/update-check-and-versions.md): /v1/info's shared capabilities, the nudge a newer
// linked engine sends, "Update all" here and on a remote engine, and the page's read. The update manager is a stand-in: no check reaches GitHub or Git.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-version-skew-routes-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'version-skew-test-secret-version-skew-test-secret';
const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports(req, res, next) { req.session = { user: { login: 'owner' } }; next(); } };

const calls = { check: 0, whenIdle: 0 };
const updatesPath = require.resolve('../services/update-manager');
const fakeUpdates = {
  bootId: 'boot-test',
  runningVersion: '2.145.0',
  readLocalManifest: () => ({ app_version: '2.145.0' }),
  publicState: () => ({ status: 'current', local_version: '2.145.0', auto_update: { enabled: true, requested: false } }),
  check: async () => { calls.check += 1; return fakeUpdates.publicState(); },
  updateWhenIdle: async () => { calls.whenIdle += 1; return { status: 'available', local_version: '2.145.0', requested: true, auto_update: { requested: true, state: 'waiting' } }; },
  restartSupport: () => ({ supported: true, reason: null }),
  restartPending: () => false,
};
require.cache[updatesPath] = { id: updatesPath, filename: updatesPath, loaded: true, exports: fakeUpdates };

const express = require('express');
const db = require('../db');
const { createAccessToken } = require('../services/engine-auth');
const { encryptToken } = require('../lib/token-crypto');
const { STATE_KEY } = require('../services/service-links');
const clientOrigin = require('../middleware/client-origin');
const { SHARED_CAPABILITIES } = require('../services/version-skew');

const SECRET = process.env.SESSION_SECRET;
const servers = [];
const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); servers.push(server); });
let engine, client, plain, linked;

async function call(base, method, route, body, headers = {}) {
  const response = await fetch(base + route, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed };
}
const v1 = (method, route, body, auth) => call(engine, method, `/v1${route}`, body, { Authorization: `Bearer ${auth}` });
const api = (method, route, body) => call(client, method, `/api${route}`, body, { 'X-Requested-With': 'XMLHttpRequest' });

function addLink(tokenId) {
  const link = {
    id: '00000000-0000-4000-8000-000000000001', role: 'joiner', owner_id: 'owner', name: 'Peer', peer_instance_id: null,
    peer_url: 'http://peer.example.test', remote_server_id: 999, issued_token_id: tokenId, tunnel_token_hash: null, tunnel_token_cipher: null,
    created_at: new Date().toISOString(), last_seen_at: null, revoked: false,
  };
  db.prepare(`INSERT INTO system_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(STATE_KEY, JSON.stringify({ links: [link] }));
}

test.before(async () => {
  const app = express(); app.use(express.json()); app.use('/v1', require('../routes/engine-v1')); engine = await listen(app);
  plain = createAccessToken(db, { principalId: 'owner' }).token;
  const issued = createAccessToken(db, { principalId: 'owner' });
  linked = issued.token;
  addLink(Number(issued.id));
  const web = express(); web.use(express.json());
  web.use('/api', clientOrigin);
  web.use('/api/system', require('../routes/system'));
  web.use('/api/remote-servers', require('../routes/remote-servers'));
  client = await listen(web);
});
test.after(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test('/v1/info lists the shared capabilities and the two update capabilities', async () => {
  const info = await v1('GET', '/info', undefined, plain);
  assert.equal(info.status, 200);
  assert.deepEqual(info.body.shared_capabilities, SHARED_CAPABILITIES);
  assert.ok(info.body.capabilities.includes('update:nudge'));
  assert.ok(info.body.capabilities.includes('update:when-idle'));
  const local = require('../routes/engine-v1').localInfo();
  assert.equal(local.engine_version, '2.145.0');
  assert.deepEqual(local.capabilities, info.body.capabilities, 'the same list the peers read');
});

test('a nudge: link tokens only, and one forced check a minute', async () => {
  const refused = await v1('POST', '/update/nudge', {}, plain);
  assert.deepEqual([refused.status, refused.body], [403, { error: 'LINKED_ONLY' }]);
  const first = await v1('POST', '/update/nudge', {}, linked);
  assert.deepEqual([first.status, first.body], [202, { accepted: true, checking: true }]);
  const second = await v1('POST', '/update/nudge', {}, linked);
  assert.deepEqual(second.body, { accepted: true, checking: false });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls.check, 1);
});

test('"Update all" on this engine over /v1 and from the page needs the confirmation', async () => {
  const before = calls.whenIdle;
  assert.equal((await v1('POST', '/update/when-idle', {}, plain)).status, 400);
  const remote = await v1('POST', '/update/when-idle', { confirm: true }, plain);
  assert.equal(remote.status, 200);
  assert.equal(remote.body.requested, true);
  assert.equal((await api('POST', '/system/update-when-idle', {})).status, 400);
  const here = await api('POST', '/system/update-when-idle', { confirm: true });
  assert.equal(here.status, 200);
  assert.equal(here.body.auto_update.requested, true);
  assert.equal(calls.whenIdle, before + 2);
});

test('"Update all" through a remote row: the engine answers, and an older engine is 501 UPDATE_WHEN_IDLE_UNSUPPORTED', async () => {
  const newer = express(); newer.use(express.json());
  newer.post('/v1/update/when-idle', (req, res) => res.json({ status: 'available', local_version: '2.140.0', requested: req.body.confirm === true }));
  const older = express(); older.use(express.json());
  const rowFor = async (app, name) => {
    const url = await listen(app);
    return Number(db.prepare(`INSERT INTO remote_servers (owner_id, name, base_url, token_cipher, status) VALUES ('owner', ?, ?, ?, 'online')`).run(name, url, encryptToken('tae_x', SECRET)).lastInsertRowid);
  };
  const ok = await api('POST', `/remote-servers/${await rowFor(newer, 'New')}/update-when-idle`, {});
  assert.equal(ok.status, 200);
  assert.equal(ok.body.requested, true);
  const old = await api('POST', `/remote-servers/${await rowFor(older, 'Old')}/update-when-idle`, {});
  assert.deepEqual([old.status, old.body], [501, { error: 'UPDATE_WHEN_IDLE_UNSUPPORTED' }]);
});

test('the page reads this engine alone when no linked engine is online, and the update status has no skew', async () => {
  const view = await api('GET', '/system/version-skew');
  assert.equal(view.status, 200);
  assert.equal(view.body.newest, '2.145.0');
  assert.deepEqual(view.body.engines.map(engine => [engine.self, engine.version, engine.older]), [[true, '2.145.0', false]]);
  const status = await api('GET', '/system/update-status');
  assert.equal(status.body.version_skew, null);
});
