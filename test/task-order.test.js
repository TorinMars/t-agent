// The shared task order: one list of `<instance id>:<task id>` keys per owner, the page API, the link-only Engine API, last writer wins between linked
// services, the push after a local change and the pull when a link comes online. The first part runs in this process; the last tests run real server.js
// processes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-task-order-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'task-order-test-secret-task-order-test-secret';
// The session owner is the X-Test-Login header, 'owner' without it.
const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports(req, res, next) { req.session = { user: { login: req.get('x-test-login') || 'owner' } }; next(); } };

const express = require('express');
const Database = require('better-sqlite3');
const db = require('../db');
const { createTaskOrder, parseOrder, mergeOrder, STATE_KEY, MAX_KEYS } = require('../services/task-order');
const { createTaskOrderRouter } = require('../routes/task-order');
const { createAccessToken } = require('../services/engine-auth');
const { encryptToken } = require('../lib/token-crypto');
const { STATE_KEY: LINKS_KEY } = require('../services/service-links');
const { request } = require('../services/remote-client');
const clientOrigin = require('../middleware/client-origin');
const { totp } = require('../services/client-auth');

const SECRET = process.env.SESSION_SECRET;
const servers = [];
const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); servers.push(server); });
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };

async function call(base, method, route, body, headers = HEADERS) {
  const response = await fetch(base + route, { method, redirect: 'manual', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000) });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

async function until(check, label, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 150));

function memoryDb() {
  const memory = new Database(':memory:');
  memory.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);');
  return memory;
}

// A linked service that is not this process: its stored order, and every request it got.
function fakePeer({ order = [], updated_at = 0, status = 200 } = {}) {
  const state = { order, updated_at, status, calls: [] };
  const app = express();
  app.use(express.json());
  app.get('/v1/task-order', (req, res) => {
    state.calls.push('GET');
    if (state.status !== 200) return res.status(state.status).json({ error: 'NOPE' });
    res.json({ order: state.order, updated_at: state.updated_at });
  });
  app.put('/v1/task-order', (req, res) => {
    state.calls.push(`PUT ${JSON.stringify(req.body)}`);
    if (state.status !== 200) return res.status(state.status).json({ error: 'NOPE' });
    if (req.body.updated_at > state.updated_at) Object.assign(state, { order: req.body.order, updated_at: req.body.updated_at });
    res.json({ order: state.order, updated_at: state.updated_at });
  });
  state.ready = listen(app).then(url => Object.assign(state, { url }));
  return state;
}

// The part of services/service-links.js the order uses.
function fakeLinks(peers) {
  const listeners = new Set();
  return {
    peers: () => peers,
    onChange: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    emit: id => { for (const listener of listeners) listener(id); },
    noteUnauthorized() {},
    listeners,
  };
}
const peerOf = (state, extra = {}) => ({ id: 'link-1', name: 'Peer', online: true, remoteServerId: 1, baseUrl: state.url, token: 'tae_peer', ...extra });

let client, engine;
test.before(async () => {
  const web = express(); web.use(express.json());
  web.use('/api', clientOrigin);
  web.use('/api/task-order', createTaskOrderRouter());
  web.use('/api/system', require('../routes/system'));
  web.use('/api/remote-servers', require('../routes/remote-servers'));
  client = await listen(web);
  const app = express(); app.use(express.json()); app.use('/v1', require('../routes/engine-v1')); engine = await listen(app);
});
test.after(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});
test.beforeEach(() => db.prepare('DELETE FROM system_state WHERE key = ?').run(STATE_KEY));

// ---- The list ----

test('a list is valid keys, de-duplicated keeping the first, at most 5000 distinct', () => {
  assert.deepEqual(parseOrder(['abc-1:2', 'abc-1:1', 'abc-1:2', 'X:0']), ['abc-1:2', 'abc-1:1', 'X:0']);
  const bad = [undefined, null, 'a:1', {}, [1], [''], ['a'], ['a:'], [':1'], ['a:1x'], ['a b:1'], ['a_b:1'], ['a:-1'], ['a:1.5'], [`${'a'.repeat(65)}:1`], ['a:1234567890123'], ['a:1 '], ['\u4efb\u52a1:1']];
  for (const value of bad) assert.throws(() => parseOrder(value), { message: 'INVALID_TASK_ORDER', statusCode: 400 }, JSON.stringify(value));
  assert.equal(parseOrder([`${'a'.repeat(64)}:123456789012`]).length, 1, 'the longest key');
  const full = Array.from({ length: MAX_KEYS }, (_, i) => `m:${i}`);
  assert.equal(parseOrder(full).length, MAX_KEYS, 'exactly 5000');
  assert.equal(parseOrder([...full, ...full]).length, MAX_KEYS, 'duplicates do not count');
  assert.throws(() => parseOrder([...full, 'm:5000']), { message: 'INVALID_TASK_ORDER' }, '5001 distinct keys');
});

test('a new list keeps the keys it does not have where they were, and over the cap drops those from the end', () => {
  assert.deepEqual(mergeOrder(['b:2', 'a:1'], ['a:1', 'x:9', 'b:2', 'y:8']), ['b:2', 'y:8', 'a:1', 'x:9'], 'each unknown key follows the key before it');
  assert.deepEqual(mergeOrder(['a:1'], ['z:0', 'a:1']), ['z:0', 'a:1'], 'with nothing before it, at the start');
  assert.deepEqual(mergeOrder(['a:1', 'b:2'], []), ['a:1', 'b:2']);
  const mine = Array.from({ length: MAX_KEYS - 1 }, (_, i) => `m:${i}`);
  const merged = mergeOrder(mine, ['old:1', ...mine, 'old:2', 'old:3']);
  assert.equal(merged.length, MAX_KEYS);
  assert.deepEqual([merged[0], merged.includes('old:2'), merged.includes('old:3')], ['old:1', false, false], 'the unknown keys at the end go first');
  assert.ok(mine.every(key => merged.includes(key)), 'never a key of the new list');
});

// ---- Page API ----

test('GET starts empty; PUT validates, saves per owner, and updated_at always increases', async () => {
  const memory = memoryDb();
  const clock = { now: 1000 };
  const web = express(); web.use(express.json());
  web.use('/api', clientOrigin);
  web.use('/api/task-order', createTaskOrderRouter({ service: createTaskOrder({ db: memory, now: () => clock.now }) }));
  const base = await listen(web);
  const as = login => ({ ...HEADERS, 'X-Test-Login': login });

  assert.deepEqual(await call(base, 'GET', '/api/task-order'), { status: 200, body: { order: [], updated_at: 0 } });
  for (const body of [{}, { order: 'a:1' }, { order: null }, { order: [1] }, { order: ['a:x'] }, { order: Array.from({ length: MAX_KEYS + 1 }, (_, i) => `a:${i}`) }]) {
    assert.deepEqual(await call(base, 'PUT', '/api/task-order', body), { status: 400, body: { error: 'INVALID_TASK_ORDER' } }, JSON.stringify(body).slice(0, 60));
  }
  assert.equal(memory.prepare('SELECT COUNT(*) AS c FROM system_state').get().c, 0, 'nothing was saved');

  assert.deepEqual(await call(base, 'PUT', '/api/task-order', { order: ['i-a:2', 'i-b:7', 'i-a:2'] }), { status: 200, body: { order: ['i-a:2', 'i-b:7'], updated_at: 1000 } });
  assert.deepEqual((await call(base, 'PUT', '/api/task-order', { order: ['i-b:7', 'i-a:2'] })).body, { order: ['i-b:7', 'i-a:2'], updated_at: 1001 }, 'the same millisecond still moves on');
  clock.now = 500; // the clock went back
  assert.equal((await call(base, 'PUT', '/api/task-order', { order: ['i-a:2'] })).body.updated_at, 1002);
  assert.deepEqual((await call(base, 'GET', '/api/task-order')).body, { order: ['i-b:7', 'i-a:2'], updated_at: 1002 }, 'a key the list left out stays');

  assert.deepEqual((await call(base, 'GET', '/api/task-order', undefined, as('someone'))).body, { order: [], updated_at: 0 }, 'per owner');
  clock.now = 5000;
  assert.deepEqual((await call(base, 'PUT', '/api/task-order', { order: ['s:1'] }, as('someone'))).body, { order: ['s:1'], updated_at: 5000 });
  assert.deepEqual(Object.keys(JSON.parse(memory.prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY).value)).sort(), ['owner', 'someone'], 'one key');

  const foreign = await call(base, 'PUT', '/api/task-order', { order: [] }, { 'Content-Type': 'application/json', Origin: 'https://attacker.test' });
  assert.deepEqual(foreign, { status: 403, body: { error: 'CLIENT_ORIGIN_REQUIRED' } });
  assert.equal((await call(base, 'PUT', '/api/task-order', { order: [] }, { 'Content-Type': 'application/json' })).status, 403, 'a write needs same-origin proof');
});

// ---- Engine API ----

function addRemoteRow(baseUrl, name) {
  return Number(db.prepare(`INSERT INTO remote_servers (owner_id, name, base_url, token_cipher, status) VALUES ('owner', ?, ?, ?, 'online')`)
    .run(name, baseUrl, encryptToken('tae_unused_token_value', SECRET)).lastInsertRowid);
}
// A link record whose issued token is `tokenId`, the way services/service-links.js stores it.
function addLink({ serverId, tokenId, peerInstanceId = null, revoked = false }) {
  const current = db.prepare('SELECT value FROM system_state WHERE key = ?').get(LINKS_KEY);
  const list = current ? JSON.parse(current.value).links : [];
  const link = {
    id: `00000000-0000-4000-8000-${String(serverId).padStart(12, '0')}`, role: 'joiner', owner_id: 'owner', name: 'Peer', peer_instance_id: peerInstanceId,
    peer_url: `http://peer-${serverId}.example.test`, remote_server_id: serverId, issued_token_id: tokenId, tunnel_token_hash: null, tunnel_token_cipher: null,
    created_at: new Date().toISOString(), last_seen_at: null, revoked,
  };
  db.prepare('INSERT INTO system_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(LINKS_KEY, JSON.stringify({ links: [...list, link] }));
  return link;
}

test('/v1/task-order takes only a service-link token, and its PUT keeps the newer list', async () => {
  const plain = createAccessToken(db, { principalId: 'owner' });
  const linked = createAccessToken(db, { principalId: 'owner', name: 'Service link: Peer' });
  addLink({ serverId: addRemoteRow('http://peer-a.example.test', 'Peer A'), tokenId: linked.id });
  const revokedToken = createAccessToken(db, { principalId: 'owner' });
  addLink({ serverId: addRemoteRow('http://peer-b.example.test', 'Peer B'), tokenId: revokedToken.id, revoked: true });
  const v1 = (method, body, token) => call(engine, method, '/v1/task-order', body, { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) });

  assert.equal((await v1('GET')).status, 401, 'no token');
  assert.deepEqual(await v1('GET', undefined, plain.token), { status: 403, body: { error: 'LINKED_ONLY' } }, 'a plain Engine token, admin or not');
  assert.deepEqual(await v1('PUT', { order: ['p:1'], updated_at: 9 }, plain.token), { status: 403, body: { error: 'LINKED_ONLY' } });
  assert.deepEqual(await v1('GET', undefined, revokedToken.token), { status: 403, body: { error: 'LINKED_ONLY' } }, 'a revoked link');
  assert.deepEqual(await v1('GET', undefined, linked.token), { status: 200, body: { order: [], updated_at: 0 } });

  for (const body of [{ order: ['p:1'] }, { order: ['p:1'], updated_at: -1 }, { order: ['p:1'], updated_at: 1.5 }, { order: ['p:1'], updated_at: '9' }, { order: ['bad'], updated_at: 9 }, { updated_at: 9 }]) {
    assert.deepEqual(await v1('PUT', body, linked.token), { status: 400, body: { error: 'INVALID_TASK_ORDER' } }, JSON.stringify(body));
  }
  assert.deepEqual((await v1('PUT', { order: ['p:1', 'p:2'], updated_at: 100 }, linked.token)).body, { order: ['p:1', 'p:2'], updated_at: 100 });
  assert.deepEqual((await v1('PUT', { order: ['p:2'], updated_at: 100 }, linked.token)).body, { order: ['p:1', 'p:2'], updated_at: 100 }, 'the same time is not newer');
  assert.deepEqual((await v1('PUT', { order: ['p:2', 'p:1'], updated_at: 50 }, linked.token)).body, { order: ['p:1', 'p:2'], updated_at: 100 }, 'an older list answers the stored one');
  assert.deepEqual((await v1('PUT', { order: ['p:2', 'p:3'], updated_at: 200 }, linked.token)).body, { order: ['p:1', 'p:2', 'p:3'], updated_at: 200 }, 'a newer one wins and keeps the keys it did not have');
  // The page of this service sees the peer's list, as the owner the browser session gets.
  assert.deepEqual((await call(client, 'GET', '/api/task-order')).body, { order: ['p:1', 'p:2', 'p:3'], updated_at: 200 });
  const info = await call(engine, 'GET', '/v1/info', undefined, { Authorization: `Bearer ${plain.token}` });
  assert.ok(info.body.capabilities.includes('task-order'));
  // The tunnel's path rules let it through as it is, so the initiator reaches the joiner's route too.
  const { checkTunnelTarget } = require('../lib/service-link-tunnel');
  assert.equal(checkTunnelTarget('/v1/task-order'), '/v1/task-order');
});

test('a local change is answered at once and then pushed to every online peer; a newer answer from a peer is kept', async () => {
  const peer = await fakePeer().ready;
  const away = await fakePeer().ready;
  const memory = memoryDb();
  const clock = { now: 1000 };
  const links = fakeLinks([peerOf(peer), peerOf(away, { id: 'link-2', online: false })]);
  const order = createTaskOrder({ db: memory, serviceLinks: links, request, now: () => clock.now, intervalMs: 0 });

  assert.deepEqual(order.setLocal('owner', ['me:1', 'me:2']), { order: ['me:1', 'me:2'], updated_at: 1000 });
  assert.deepEqual(peer.calls, [], 'nothing was sent before the answer');
  await until(() => peer.calls.length === 1, 'the push');
  assert.deepEqual(peer.calls, ['PUT {"order":["me:1","me:2"],"updated_at":1000}']);
  assert.deepEqual(away.calls, [], 'an offline peer is left alone');
  assert.deepEqual([peer.order, peer.updated_at], [['me:1', 'me:2'], 1000]);

  // The peer has a newer list than the one sent (its clock is ahead): its answer is kept here.
  Object.assign(peer, { order: ['other:5', 'me:2'], updated_at: 9000 });
  order.setLocal('owner', ['me:2', 'me:1']);
  await until(() => order.get('owner').updated_at === 9000, 'the newer answer kept');
  assert.deepEqual(order.get('owner').order, ['other:5', 'me:2', 'me:1']);

  // A peer that fails never affects the answer.
  peer.status = 500;
  clock.now = 20000;
  assert.equal(order.setLocal('owner', ['me:1']).updated_at, 20000);
  await until(() => peer.calls.length === 3, 'the failed push');
  assert.equal(order.get('owner').updated_at, 20000);
});

test("a peer's list is stored and never sent on, so there is no loop", async () => {
  const peer = await fakePeer().ready;
  const order = createTaskOrder({ db: memoryDb(), serviceLinks: fakeLinks([peerOf(peer)]), request, intervalMs: 0 });
  assert.deepEqual(order.accept('owner', { order: ['x:1'], updated_at: 50 }), { order: ['x:1'], updated_at: 50 });
  await settle();
  assert.deepEqual(peer.calls, []);
});

test('a link coming online is read at once: the newer list is kept here, or ours is sent when ours is newer', async () => {
  const peer = await fakePeer({ order: ['b:1', 'b:2'], updated_at: 500 }).ready;
  const memory = memoryDb();
  const target = peerOf(peer, { online: false });
  const links = fakeLinks([target]);
  const order = createTaskOrder({ db: memory, serviceLinks: links, request, owner: () => 'owner', now: () => 100, intervalMs: 0 });
  order.start();
  try {
    links.emit('link-1');
    await settle();
    assert.deepEqual(peer.calls, [], 'an offline link is not read');

    target.online = true;
    links.emit('link-1');
    await until(() => order.get('owner').updated_at === 500, 'the pull');
    assert.deepEqual(order.get('owner'), { order: ['b:1', 'b:2'], updated_at: 500 });
    assert.deepEqual(peer.calls, ['GET'], 'theirs was newer: nothing to send');

    memory.prepare('DELETE FROM system_state').run();
    order.accept('owner', { order: ['a:9'], updated_at: 700 });
    links.emit('link-1');
    await until(() => peer.calls.length === 3, 'the push of the newer list');
    assert.deepEqual(peer.calls.slice(1), ['GET', 'PUT {"order":["a:9"],"updated_at":700}']);
    assert.deepEqual([peer.order, peer.updated_at], [['a:9'], 700]);

    links.emit('link-1');
    await until(() => peer.calls.length === 4, 'the same list');
    await settle();
    assert.equal(peer.calls.length, 4, 'the same time: nothing is sent');

    // An older peer without the route is read and ignored.
    peer.status = 404;
    links.emit('link-1');
    await until(() => peer.calls.length === 5, 'the old peer');
    assert.deepEqual(order.get('owner'), { order: ['a:9'], updated_at: 700 });
  } finally { order.stop(); }
  assert.equal(links.listeners.size, 0, 'stop lets go of the links');
});

test('every few minutes the online links are read', async () => {
  const peer = await fakePeer({ order: ['b:1'], updated_at: 500 }).ready;
  const order = createTaskOrder({ db: memoryDb(), serviceLinks: fakeLinks([peerOf(peer)]), request, owner: () => 'owner', intervalMs: 30 });
  order.start();
  try { await until(() => order.get('owner').updated_at === 500, 'the periodic pull'); }
  finally { order.stop(); }
});

// ---- Instance ids ----

test('instance_id: this machine in /api/system/version, a remote row from its /v1/info or its link record, null when unknown', async () => {
  const mine = db.prepare("SELECT value FROM engine_identity WHERE key = 'instance_id'").get().value;
  assert.equal((await call(client, 'GET', '/api/system/version')).body.instance_id, mine);

  const app = express();
  app.get('/v1/info', (req, res) => res.json({ engine_id: '11111111-2222-4333-8444-555555555555', name: 'Info engine', engine_version: '1.0.0', capabilities: ['tasks:read'] }));
  const infoUrl = await listen(app);
  const reported = addRemoteRow(infoUrl, 'Reports');
  const unknown = addRemoteRow('http://127.0.0.1:9/', 'Unknown');
  const linkedRow = addRemoteRow('http://peer-linked.example.test', 'Linked');
  addLink({ serverId: linkedRow, tokenId: -1, peerInstanceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });

  const rows = async () => Object.fromEntries((await call(client, 'GET', '/api/remote-servers')).body.map(row => [row.id, row.instance_id]));
  assert.equal((await rows())[reported], null, 'not read yet');
  assert.equal((await call(client, 'POST', `/api/remote-servers/${reported}/check`, {})).status, 200);
  const after = await rows();
  assert.deepEqual([after[reported], after[unknown], after[linkedRow]], ['11111111-2222-4333-8444-555555555555', null, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']);
  const one = (await call(client, 'POST', `/api/remote-servers/${reported}/check`, {})).body;
  assert.equal(one.instance_id, '11111111-2222-4333-8444-555555555555', 'single rows have it too');
});

// ---- Real services ----

function spawnService(t, env) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-task-order-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, TAGENT_HOME: '', HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', SESSION_SECRET: SECRET, T_AGENT_DATA_DIR: temp, T_AGENT_DB_PATH: path.join(temp, 'db.sqlite'), TASKS_BASE_DIR: path.join(temp, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) await new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); });
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no start: ${output}`)), 20000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Server running at http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`exited ${code}: ${output}`)); });
  });
}

test('in the real server the page route is behind the login and the same-origin rule', { timeout: 60000 }, async t => {
  const url = await spawnService(t, { CLIENT_ALLOW_HTTP: 'false' });
  assert.equal((await call(url, 'GET', '/api/task-order')).status, 404, 'logged out: the same 404 as any protected address');
  assert.equal((await call(url, 'PUT', '/api/task-order', { order: [] })).status, 404);

  const LOGIN = '/torin/hide/login';
  const post = (route, body, cookie) => fetch(url + route, { method: 'POST', redirect: 'manual', headers: { ...HEADERS, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const start = await post(`${LOGIN}/setup/start`, {});
  const setup = await start.json();
  const confirm = await post(`${LOGIN}/setup/confirm`, { code: totp(setup.secret, Math.floor(Date.now() / 30000)), return_to: '/h5' }, /(?:^|[,\s])(connect\.sid=[^;]+)/.exec(start.headers.get('set-cookie'))[1]);
  assert.equal(confirm.status, 200);
  const cookie = /(?:^|[,\s])(connect\.sid=[^;]+)/.exec(confirm.headers.get('set-cookie'))[1];

  assert.deepEqual(await call(url, 'PUT', '/api/task-order', { order: ['a:1'] }, { 'Content-Type': 'application/json', Origin: 'https://attacker.test', Cookie: cookie }), { status: 403, body: { error: 'CLIENT_ORIGIN_REQUIRED' } });
  assert.equal((await call(url, 'PUT', '/api/task-order', { order: ['a:1'] }, { 'Content-Type': 'application/json', Cookie: cookie })).status, 403, 'no same-origin proof');
  assert.deepEqual((await call(url, 'GET', '/api/task-order', undefined, { Cookie: cookie })).body, { order: [], updated_at: 0 });
  const saved = await call(url, 'PUT', '/api/task-order', { order: ['a:1'] }, { ...HEADERS, Cookie: cookie });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.order, ['a:1']);
});

test('two real services: an order made before linking reaches the other side, then a reorder on either side reaches the other, both ways through the link', { timeout: 90000 }, async t => {
  const [aUrl, bUrl] = await Promise.all([spawnService(t, { ACCESS_MODE: 'local', ENGINE_NAME: 'engine-a' }), spawnService(t, { ACCESS_MODE: 'local', ENGINE_NAME: 'engine-b' })]);
  const a = (method, route, body, headers) => call(aUrl, method, route, body, headers);
  const b = (method, route, body, headers) => call(bUrl, method, route, body, headers);
  const idA = (await a('GET', '/api/system/version')).body.instance_id;
  const idB = (await b('GET', '/api/system/version')).body.instance_id;
  assert.match(idA, /^[0-9a-f-]{36}$/);
  assert.notEqual(idA, idB);

  // Made on A while nothing is linked; a key of a third service is kept as it is.
  const first = await a('PUT', '/api/task-order', { order: [`${idB}:1`, 'third-service:4', `${idA}:1`] });
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const made = await a('POST', '/api/service-links/code', {});
  const joined = await b('POST', '/api/service-links/join', { url: aUrl, code: made.body.code, confirm: true });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  // The link coming online is read at once, on both sides.
  await until(async () => (await b('GET', '/api/task-order')).body.updated_at === first.body.updated_at, 'the order made before linking reaches B');
  assert.deepEqual((await b('GET', '/api/task-order')).body.order, [`${idB}:1`, 'third-service:4', `${idA}:1`]);

  // Each side's row of the other has its instance id.
  const rowOf = async (side, link) => (await side('GET', '/api/remote-servers')).body.find(row => row.id === link.remote_server_id);
  const linkOn = async side => (await side('GET', '/api/service-links')).body.links.find(link => link.id === joined.body.id);
  assert.equal((await rowOf(a, await linkOn(a))).instance_id, idB);
  assert.equal((await rowOf(b, await linkOn(b))).instance_id, idA);

  // A to B goes through the reverse tunnel.
  const onA = await a('PUT', '/api/task-order', { order: [`${idA}:1`, `${idB}:1`] });
  await until(async () => (await b('GET', '/api/task-order')).body.updated_at === onA.body.updated_at, 'A to B');
  assert.deepEqual((await b('GET', '/api/task-order')).body.order, [`${idA}:1`, `${idB}:1`, 'third-service:4']);
  // B to A goes to A's address directly.
  const onB = await b('PUT', '/api/task-order', { order: ['third-service:4', `${idB}:1`, `${idA}:1`, `${idB}:2`] });
  assert.ok(onB.body.updated_at > onA.body.updated_at);
  await until(async () => (await a('GET', '/api/task-order')).body.updated_at === onB.body.updated_at, 'B to A');
  assert.deepEqual((await a('GET', '/api/task-order')).body.order, ['third-service:4', `${idB}:1`, `${idA}:1`, `${idB}:2`]);

  // A plain Engine token of B is not a link token.
  const plain = await b('POST', '/api/remote-tokens', { name: 'Plain' });
  assert.equal(plain.status, 201);
  assert.deepEqual(await b('GET', '/v1/task-order', undefined, { Authorization: `Bearer ${plain.body.token}` }), { status: 403, body: { error: 'LINKED_ONLY' } });
});
