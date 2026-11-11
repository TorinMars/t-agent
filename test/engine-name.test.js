// Engine names: one name per Engine, kept by that Engine, renamed here or from another machine, and followed by every machine that reads its /v1/info.
// The first part drives the routers in this process (the Engine and the Client share one database here); the last test runs two real server.js processes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-engine-name-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'engine-name-test-secret-engine-name-test-secret';
process.env.ENGINE_NAME = 'default-engine';
const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports(req, res, next) { req.session = { user: { login: 'owner' } }; next(); } };

const express = require('express');
const db = require('../db');
const engineName = require('../services/engine-name');
const { createRemoteInfo, REFRESH_MS } = require('../services/remote-info');
const { createAccessToken } = require('../services/engine-auth');
const { encryptToken } = require('../lib/token-crypto');
const { getServiceLinks, STATE_KEY } = require('../services/service-links');
const clientOrigin = require('../middleware/client-origin');

const SECRET = process.env.SESSION_SECRET;
// "Build machine" in Chinese, written with escapes: the name is user content and must work in any language.
const CHINESE = '\u6784\u5efa\u673a';
const servers = [];
const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); servers.push(server); });
let engine, client, token;

// A remote Engine that is not this process: its name, capabilities and delay are set by each test, and every request is counted.
function fakeEngine({ name = 'Fake engine', capabilities = ['tasks:read'], delayMs = 0, refuseRename = null } = {}) {
  const state = { name, capabilities, delayMs, refuseRename, calls: [] };
  const app = express();
  app.use(express.json());
  app.get('/v1/info', async (req, res) => {
    state.calls.push('GET /v1/info');
    if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs));
    res.json({ engine_id: 'fake', name: state.name, engine_version: '1.0.0', capabilities: state.capabilities });
  });
  app.put('/v1/engine-name', (req, res) => {
    state.calls.push(`PUT /v1/engine-name ${JSON.stringify(req.body)}`);
    if (!state.capabilities.includes('engine-name')) return res.status(404).json({ error: 'NOT_FOUND' });
    if (state.refuseRename) return res.status(state.refuseRename.status).json({ error: state.refuseRename.error });
    state.name = req.body.name || 'fake-default';
    res.json({ name: state.name, default_name: 'fake-default', custom: Boolean(req.body.name) });
  });
  state.ready = listen(app).then(url => Object.assign(state, { url }));
  return state;
}

const addRow = (baseUrl, name, rowToken = token) => Number(db.prepare(`INSERT INTO remote_servers (owner_id, name, base_url, token_cipher, status)
  VALUES ('owner', ?, ?, ?, 'online')`).run(name, baseUrl, encryptToken(rowToken, SECRET)).lastInsertRowid);
const rowName = id => db.prepare('SELECT name FROM remote_servers WHERE id = ?').get(id).name;

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
const v1 = (method, route, body, auth = token) => call(engine, method, `/v1${route}`, body, auth ? { Authorization: `Bearer ${auth}` } : {});
const api = (method, route, body, headers) => call(client, method, `/api${route}`, body, headers);

test.before(async () => {
  const app = express(); app.use(express.json()); app.use('/v1', require('../routes/engine-v1')); engine = await listen(app);
  token = createAccessToken(db, { principalId: 'owner' }).token;
  const web = express(); web.use(express.json());
  // The same-origin check of server.js, in front of the browser routes as there.
  web.use('/api', clientOrigin);
  web.use('/api/system', require('../routes/system'));
  web.use('/api/remote-servers', require('../routes/remote-servers'));
  client = await listen(web);
});
test.after(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});
test.beforeEach(() => engineName.setEngineName(db, null));

test('the name starts as the default, can be set, and an empty or null name resets it', () => {
  assert.deepEqual(engineName.engineNameState(db), { name: 'default-engine', default_name: 'default-engine', custom: false });
  assert.deepEqual(engineName.setEngineName(db, 'Studio Mac'), { name: 'Studio Mac', default_name: 'default-engine', custom: true });
  assert.equal(require('../services/engine-identity').getEngineIdentity().name, 'Studio Mac');
  engineName.setEngineName(db, engineName.parseEngineName('   '));
  assert.equal(engineName.engineNameState(db).custom, false);
  engineName.setEngineName(db, 'Again');
  engineName.setEngineName(db, engineName.nameFromBody({ name: null }));
  assert.deepEqual(engineName.engineNameState(db), { name: 'default-engine', default_name: 'default-engine', custom: false });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM engine_identity WHERE key = 'instance_id'").get().n, 1, 'the instance id row is untouched');
});

test('a name is trimmed, 1 to 60 characters of any language, with no control characters or line breaks', () => {
  assert.equal(engineName.parseEngineName('  Build box  '), 'Build box');
  assert.equal(engineName.parseEngineName(CHINESE), CHINESE);
  assert.equal(engineName.parseEngineName('x'.repeat(60)), 'x'.repeat(60));
  assert.equal(engineName.parseEngineName('\u{1F680}'.repeat(60)), '\u{1F680}'.repeat(60), 'characters, not UTF-16 units');
  assert.equal(engineName.parseEngineName(''), null);
  const refused = value => assert.throws(() => engineName.parseEngineName(value), error => error.message === 'INVALID_ENGINE_NAME' && error.statusCode === 400, JSON.stringify(value));
  for (const value of ['x'.repeat(61), 'a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u007fb', 'a\u0085b', 'a\u2028b', 'a\u2029b', 42, true, {}, ['x']]) refused(value);
  assert.throws(() => engineName.nameFromBody({}), /INVALID_ENGINE_NAME/, 'the field must be there');
  assert.throws(() => engineName.nameFromBody(null), /INVALID_ENGINE_NAME/);
});

test('GET and PUT /api/system/engine-name, the same-origin check, and engine_name in /api/system/version', async () => {
  assert.deepEqual((await api('GET', '/system/engine-name')).body, { name: 'default-engine', default_name: 'default-engine', custom: false });
  const saved = await api('PUT', '/system/engine-name', { name: ` ${CHINESE} ` }, { 'X-Requested-With': 'XMLHttpRequest' });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { name: CHINESE, default_name: 'default-engine', custom: true });
  assert.equal((await api('GET', '/system/version')).body.engine_name, CHINESE);

  for (const body of [{ name: 'a\nb' }, { name: 'x'.repeat(61) }, {}, { name: 5 }]) {
    const refused = await api('PUT', '/system/engine-name', body, { 'X-Requested-With': 'XMLHttpRequest' });
    assert.deepEqual([refused.status, refused.body], [400, { error: 'INVALID_ENGINE_NAME' }], JSON.stringify(body));
  }
  assert.equal((await api('PUT', '/system/engine-name', { name: 'x' })).status, 403, 'a write without same-origin proof');
  assert.equal((await api('PUT', '/system/engine-name', { name: 'x' }, { Origin: 'http://evil.example.test' })).status, 403);
  assert.equal((await api('GET', '/system/engine-name', undefined, { Origin: 'http://evil.example.test' })).status, 403);
  assert.equal(engineName.engineNameState(db).name, CHINESE, 'refused writes changed nothing');

  const reset = await api('PUT', '/system/engine-name', { name: '' }, { 'X-Requested-With': 'XMLHttpRequest' });
  assert.deepEqual(reset.body, { name: 'default-engine', default_name: 'default-engine', custom: false });
});

test('PUT /v1/engine-name needs an Engine token, has a capability in /v1/info, and /v1/info reports the name', async () => {
  const info = await v1('GET', '/info');
  assert.ok(info.body.capabilities.includes('engine-name'));
  assert.equal(info.body.name, 'default-engine');
  assert.equal((await v1('PUT', '/engine-name', { name: 'Remote' }, null)).status, 401);
  assert.equal((await v1('PUT', '/engine-name', { name: 'Remote' }, 'tae_not-a-real-token-at-all')).status, 401);
  assert.equal(engineName.engineNameState(db).custom, false);

  const renamed = await v1('PUT', '/engine-name', { name: 'Renamed from afar' });
  assert.deepEqual(renamed.body, { name: 'Renamed from afar', default_name: 'default-engine', custom: true });
  assert.equal((await v1('GET', '/info')).body.name, 'Renamed from afar');
  assert.equal((await v1('GET', '/capabilities')).body.name, 'Renamed from afar');
  assert.deepEqual((await v1('PUT', '/engine-name', { name: 'a\nb' })).body, { error: 'INVALID_ENGINE_NAME' });
  assert.deepEqual((await v1('PUT', '/engine-name', { name: null })).body.custom, false);
});

test('renaming a remote row on an Engine with the capability renames the Engine, and the row takes its answer', async () => {
  const id = addRow(engine, 'Typed name');
  const before = (await api('GET', '/remote-servers')).body.find(row => row.id === id);
  assert.equal(before.can_rename, true);
  assert.equal(before.name_source, 'local', 'not known until the Engine was read');

  const renamed = await api('PUT', `/remote-servers/${id}/name`, { name: '  Lab Engine ' }, { 'X-Requested-With': 'XMLHttpRequest' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.name, 'Lab Engine');
  assert.equal(renamed.body.name_source, 'engine');
  assert.equal(renamed.body.can_rename, true);
  assert.equal(engineName.engineNameState(db).name, 'Lab Engine', 'the Engine itself was renamed');
  assert.equal((await v1('GET', '/info')).body.name, 'Lab Engine');

  const reset = await api('PUT', `/remote-servers/${id}/name`, { name: '' }, { 'X-Requested-With': 'XMLHttpRequest' });
  assert.equal(reset.body.name, 'default-engine', 'reset to the Engine default');
  assert.equal(engineName.engineNameState(db).custom, false);
  assert.deepEqual((await api('PUT', `/remote-servers/${id}/name`, { name: 'a\nb' }, { 'X-Requested-With': 'XMLHttpRequest' })).body, { error: 'INVALID_ENGINE_NAME' });
  assert.equal((await api('PUT', '/remote-servers/999999/name', { name: 'x' }, { 'X-Requested-With': 'XMLHttpRequest' })).status, 404);
  assert.equal((await api('PUT', `/remote-servers/${id}/name`, { name: 'x' })).status, 403, 'same-origin proof');
});

test('an Engine without the capability is renamed only here, keeps that name after info reads, and an offline one is 502', async () => {
  const old = fakeEngine({ name: 'Old engine name' });
  await old.ready;
  const id = addRow(old.url, 'Typed name', 'tae_fake');
  const renamed = await api('PUT', `/remote-servers/${id}/name`, { name: CHINESE }, { 'X-Requested-With': 'XMLHttpRequest' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, CHINESE);
  assert.equal(renamed.body.name_source, 'local');
  assert.ok(!old.calls.some(entry => entry.startsWith('PUT')), 'no rename was sent to it');
  assert.deepEqual((await api('PUT', `/remote-servers/${id}/name`, { name: '' }, { 'X-Requested-With': 'XMLHttpRequest' })).body, { error: 'INVALID_ENGINE_NAME' }, 'nothing to reset to');

  // Check, the capability read of the page and the archive capability check all read /v1/info: none of them takes the name it reports.
  assert.equal((await api('POST', `/remote-servers/${id}/check`, {}, { 'X-Requested-With': 'XMLHttpRequest' })).status, 200);
  assert.equal((await api('GET', `/remote-servers/${id}/info`)).body.name, 'Old engine name');
  assert.equal(rowName(id), CHINESE);

  const gone = addRow('http://127.0.0.1:1', 'Offline', 'tae_fake');
  const offline = await api('PUT', `/remote-servers/${gone}/name`, { name: 'x' }, { 'X-Requested-With': 'XMLHttpRequest' });
  assert.equal(offline.status, 502);
  assert.equal(rowName(gone), 'Offline');
});

test('the remote error of a rename is passed through', async () => {
  const strict = fakeEngine({ name: 'Strict', capabilities: ['engine-name'], refuseRename: { status: 403, error: 'INSUFFICIENT_SCOPE' } });
  await strict.ready;
  const id = addRow(strict.url, 'Typed', 'tae_fake');
  const refused = await api('PUT', `/remote-servers/${id}/name`, { name: 'New' }, { 'X-Requested-With': 'XMLHttpRequest' });
  assert.deepEqual([refused.status, refused.body], [403, { error: 'INSUFFICIENT_SCOPE' }]);
  assert.equal(rowName(id), 'Strict');
});

function addLink(serverId, name) {
  const current = db.prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY);
  const list = current ? JSON.parse(current.value).links : [];
  const link = {
    id: `00000000-0000-4000-8000-${String(serverId).padStart(12, '0')}`, role: 'joiner', owner_id: 'owner', name, peer_instance_id: null,
    peer_url: 'http://peer.example.test', remote_server_id: serverId, issued_token_id: -1, tunnel_token_hash: null, tunnel_token_cipher: null,
    created_at: new Date().toISOString(), last_seen_at: null, revoked: false,
  };
  db.prepare(`INSERT INTO system_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(STATE_KEY, JSON.stringify({ links: [...list, link] }));
  return link;
}
const linkName = link => getServiceLinks().list('owner').find(entry => entry.id === link.id).name;

test('a linked row can be renamed, but its address and credential still cannot be edited', async () => {
  const peer = fakeEngine({ name: 'Peer', capabilities: ['engine-name'] });
  await peer.ready;
  const id = addRow(peer.url, 'Peer', 'tae_fake');
  const link = addLink(id, 'Peer');
  const renamed = await api('PUT', `/remote-servers/${id}/name`, { name: 'Peer renamed' }, { 'X-Requested-With': 'XMLHttpRequest' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.name, 'Peer renamed');
  assert.equal(peer.name, 'Peer renamed', 'the peer was renamed');
  assert.equal(linkName(link), 'Peer renamed', 'the link record follows');
  assert.deepEqual((await api('PUT', `/remote-servers/${id}`, { url: 'http://127.0.0.1:2', name: 'x' }, { 'X-Requested-With': 'XMLHttpRequest' })).body, { error: 'LINK_MANAGED' });
  assert.deepEqual((await api('POST', `/remote-servers/${id}/test`, { url: 'http://127.0.0.1:2' }, { 'X-Requested-With': 'XMLHttpRequest' })).body, { error: 'LINK_MANAGED' });
});

test('every info read of a row with the capability updates the row and link names, and losing the capability makes the name local again', async () => {
  const peer = fakeEngine({ name: 'First', capabilities: ['engine-name', 'tasks:archive', 'files:read', 'fs:read-any', 'files:raw'] });
  await peer.ready;
  const id = addRow(peer.url, 'Typed', 'tae_fake');
  const link = addLink(id, 'Typed');
  const sends = [
    ['POST', `/remote-servers/${id}/check`, {}],
    ['GET', `/remote-servers/${id}/info`],
    ['GET', `/remote-servers/${id}/tasks?archived=1`],
    ['GET', `/remote-servers/${id}/tasks/1/files`],
    ['GET', `/remote-servers/${id}/fs/content?path=/x`],
    ['GET', `/remote-servers/${id}/fs/raw?path=/x`],
  ];
  for (const [index, [method, route, body]] of sends.entries()) {
    peer.name = `Name ${index}`;
    await api(method, route, body, { 'X-Requested-With': 'XMLHttpRequest' });
    assert.equal(rowName(id), `Name ${index}`, route);
    assert.equal(linkName(link), `Name ${index}`, route);
  }
  const listed = (await api('GET', '/remote-servers')).body.find(row => row.id === id);
  assert.equal(listed.name_source, 'engine');

  // A name the Engine reports that this side would refuse is ignored, and the row stays engine-named.
  peer.name = 'bad\nname';
  await api('GET', `/remote-servers/${id}/info`);
  assert.equal(rowName(id), 'Name 5');
  assert.equal((await api('GET', '/remote-servers')).body.find(row => row.id === id).name_source, 'engine');

  peer.capabilities = ['tasks:read'];
  peer.name = 'Not followed';
  await api('GET', `/remote-servers/${id}/info`);
  assert.equal(rowName(id), 'Name 5');
  assert.equal((await api('GET', '/remote-servers')).body.find(row => row.id === id).name_source, 'local');
});

test('connecting saves an Engine with the capability under its own name, and the form name is for one without it', async () => {
  const named = fakeEngine({ name: 'Self named', capabilities: ['engine-name'] });
  const plain = fakeEngine({ name: 'Ignored', capabilities: ['tasks:read'] });
  await Promise.all([named.ready, plain.ready]);
  const first = await api('POST', '/remote-servers', { url: named.url, token: 'tae_fake', name: 'Form name' }, { 'X-Requested-With': 'XMLHttpRequest' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.deepEqual([first.body.name, first.body.name_source], ['Self named', 'engine']);
  const second = await api('POST', '/remote-servers', { url: plain.url, token: 'tae_fake', name: 'Form name' }, { 'X-Requested-With': 'XMLHttpRequest' });
  assert.deepEqual([second.body.name, second.body.name_source], ['Form name', 'local']);
});

test('the background refresh: at most once a minute per row, after the answer, names only', async () => {
  // The unit, with a clock.
  const clock = { now: 1_000_000 };
  const deferred = [];
  const synced = [];
  const reads = [];
  const reader = createRemoteInfo({
    now: () => clock.now, defer: fn => deferred.push(fn),
    request: async (base, route, credential, options) => { reads.push([base, route, credential, options]); return { name: `n-${base}`, capabilities: ['engine-name'] }; },
    sync: (id, info) => synced.push([id, info.name]),
  });
  const rows = [{ id: 1, enabled: 1, base_url: 'a' }, { id: 2, enabled: 0, base_url: 'b' }, { id: 3, enabled: 1, base_url: 'c' }];
  const targetOf = row => { if (row.id === 3) throw new Error('UNDECRYPTABLE'); return { baseUrl: row.base_url, token: 't' }; };
  assert.equal(reader.refreshStale(rows, targetOf), 2, 'disabled rows are skipped');
  assert.equal(reads.length, 0, 'nothing is read before the answer is out');
  deferred.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reads, [['a', '/v1/info', 't', { timeoutMs: 5000 }]], 'a row whose token cannot be read is skipped');
  assert.deepEqual(synced, [[1, 'n-a']]);
  clock.now += REFRESH_MS - 1;
  assert.equal(reader.refreshStale(rows, targetOf), 0);
  clock.now += 1;
  assert.equal(reader.refreshStale(rows, targetOf), 2);
  // Any read of the row counts, not only the background one.
  clock.now += REFRESH_MS;
  await reader.read({ baseUrl: 'a', token: 't', serverId: 1 });
  assert.equal(reader.refreshStale(rows, () => ({ baseUrl: 'x', token: 't' })), 1);
  // A failed read is not retried before the minute is over either.
  const failing = createRemoteInfo({ now: () => clock.now, defer: fn => fn(), request: async () => { throw new Error('REMOTE_OFFLINE'); }, sync: () => assert.fail('no sync') });
  assert.equal(failing.refreshStale([{ id: 9, enabled: 1 }], () => ({ baseUrl: 'z', token: 't' })), 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failing.refreshStale([{ id: 9, enabled: 1 }], () => ({ baseUrl: 'z', token: 't' })), 0);

  // Through the route, with a slow Engine: the list answers at once with the old name, the new one is there afterwards, and a second list asks nothing.
  const slow = fakeEngine({ name: 'Slow new name', capabilities: ['engine-name'], delayMs: 700 });
  await slow.ready;
  const id = addRow(slow.url, 'Slow old name', 'tae_fake');
  const started = Date.now();
  const listed = await api('GET', '/remote-servers');
  assert.ok(Date.now() - started < 500, `the answer did not wait (${Date.now() - started} ms)`);
  assert.equal(listed.body.find(row => row.id === id).name, 'Slow old name');
  await api('GET', '/remote-servers');
  const deadline = Date.now() + 5000;
  while (rowName(id) !== 'Slow new name' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(rowName(id), 'Slow new name');
  assert.equal((await api('GET', '/remote-servers')).body.find(row => row.id === id).name_source, 'engine');
  assert.deepEqual(slow.calls, ['GET /v1/info'], 'one read for three lists within the minute');
});

// ---- Two real services ----
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };

async function startService(t, name) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-engine-name-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', SESSION_SECRET: SECRET, T_AGENT_DATA_DIR: temp, T_AGENT_DB_PATH: path.join(temp, 'db.sqlite'), TASKS_BASE_DIR: path.join(temp, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false', ACCESS_MODE: 'local', ENGINE_NAME: name },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no start: ${output}`)), 20000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Server running at http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once('exit', code => reject(new Error(`exited ${code}: ${output}`)));
  });
  const url = `http://127.0.0.1:${port}`;
  t.after(async () => {
    if (child.exitCode === null) await new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); });
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return { url, call: (method, route, body, headers = HEADERS) => call(url, method, route, body, headers) };
}

async function until(check, label) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

test('two real services: A renames B, A sees it, B shows it itself, and A follows a rename made on B', async t => {
  const a = await startService(t, 'engine-a');
  const b = await startService(t, 'engine-b');
  const made = await a.call('POST', '/api/service-links/code', {});
  const joined = await b.call('POST', '/api/service-links/join', { url: a.url, code: made.body.code, confirm: true });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  const linkOf = async side => (await side.call('GET', '/api/service-links')).body.links.find(link => link.id === joined.body.id);
  await until(async () => (await linkOf(a))?.online && (await linkOf(b))?.online, 'both sides online');

  const rowOnA = (await linkOf(a)).remote_server_id;
  assert.equal((await linkOf(a)).name, 'engine-b');
  // Through the reverse tunnel: A reaches B only that way.
  const renamed = await a.call('PUT', `/api/remote-servers/${rowOnA}/name`, { name: `B ${CHINESE}` });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.deepEqual([renamed.body.name, renamed.body.name_source, renamed.body.can_rename], [`B ${CHINESE}`, 'engine', true]);
  assert.equal((await linkOf(a)).name, `B ${CHINESE}`);
  assert.deepEqual((await b.call('GET', '/api/system/engine-name')).body, { name: `B ${CHINESE}`, default_name: 'engine-b', custom: true });
  assert.equal((await b.call('GET', '/api/system/version')).body.engine_name, `B ${CHINESE}`);
  assert.deepEqual((await a.call('GET', '/api/system/engine-name')).body.name, 'engine-a', 'A itself is unchanged');

  // B renames itself; A follows on its next read of B's info.
  const self = await b.call('PUT', '/api/system/engine-name', { name: 'B by itself' });
  assert.equal(self.status, 200);
  assert.equal((await a.call('GET', `/api/remote-servers/${rowOnA}/info`)).body.name, 'B by itself');
  assert.equal((await a.call('GET', '/api/remote-servers')).body.find(row => row.id === rowOnA).name, 'B by itself');
  assert.equal((await linkOf(a)).name, 'B by itself');

  // The browser gates of the real server.
  assert.equal((await b.call('PUT', '/api/system/engine-name', { name: 'x' }, { 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await b.call('GET', '/api/system/engine-name', undefined, { Origin: 'http://evil.example.test' })).status, 403);
  assert.equal((await b.call('PUT', '/v1/engine-name', { name: 'x' }, { 'Content-Type': 'application/json' })).status, 401, 'no Engine token');
  assert.equal((await b.call('GET', '/api/system/engine-name')).body.name, 'B by itself');
});
