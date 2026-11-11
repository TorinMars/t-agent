// Mind maps shared across connected services: /v1/mindmaps on the owning service, the Client's proxy /api/remote-servers/:id/mindmaps, and two real
// server.js processes linked by a service link (one direction direct, the other through the reverse tunnel).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-mindmap-share-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'mindmap-share-test-secret-mindmap-share-test-secret';
fs.mkdirSync(process.env.TASKS_BASE_DIR, { recursive: true });

// The proxy's browser session: the /api gates are tested with the real server.js below.
const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports(req, res, next) { req.session = { user: { login: 'owner' } }; next(); },
};

const express = require('express');
const db = require('../db');
const { createAccessToken } = require('../services/engine-auth');
const { encryptToken } = require('../lib/token-crypto');
const { getMindmapService, LIMITS } = require('../services/mindmap');
const { createMindmapRouter } = require('../routes/mindmap');

const MISSING = '11111111-1111-4111-8111-111111111111';
const LINK_ID = '33333333-3333-4333-8333-333333333333';
const mapsDir = path.join(process.env.T_AGENT_DATA_DIR, 'mindmaps');

const servers = [];
const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); servers.push(server); });

// A topic text that makes the serialised data exactly `bytes` long.
function dataOf(bytes) {
  const shell = JSON.stringify({ root: { topic: '' } }).length;
  return { root: { topic: 'a'.repeat(bytes - shell) } };
}

async function call(method, url, body, headers = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: response.status, body: parsed };
}

let engine, local, proxy, auth, token;
const ids = {};
const engineHits = [];
const oldHits = [];

test.before(async () => {
  // The owning service: /v1 as server.js mounts it, with no body parser in front of /v1/mindmaps; /api/mindmaps on the same service instance.
  const engineApp = express();
  engineApp.use((req, res, next) => { engineHits.push(`${req.method} ${req.url}`); next(); });
  engineApp.use('/v1', require('../routes/engine-v1'));
  engine = await listen(engineApp);
  const localApp = express();
  localApp.use('/api/mindmaps', createMindmapRouter({ service: getMindmapService() }));
  local = await listen(localApp);
  token = createAccessToken(db, { principalId: 'owner' }).token;
  auth = { Authorization: `Bearer ${token}` };

  // An Engine from before shared mind maps.
  const oldApp = express();
  oldApp.use((req, res, next) => { oldHits.push(`${req.method} ${req.url}`); next(); });
  oldApp.get('/v1/info', (req, res) => res.json({ capabilities: ['tasks:read', 'tasks:write'] }));
  const old = await listen(oldApp);

  // An Engine whose /v1/info works but whose map routes fail the way a storage error does.
  const brokenApp = express();
  brokenApp.get('/v1/info', (req, res) => res.json({ capabilities: ['mindmaps'] }));
  brokenApp.use('/v1/mindmaps', (req, res) => res.status(500).json({ error: 'MINDMAP_STORAGE_FAILED', message: 'The mind map storage failed', path: '/secret' }));
  const broken = await listen(brokenApp);

  // A closed port.
  const closed = await listen(express());
  await new Promise(resolve => servers.pop().close(resolve));

  const remote = base => db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
    .run('owner', base, base, encryptToken(token, process.env.SESSION_SECRET)).lastInsertRowid;
  ids.engine = remote(engine);
  ids.old = remote(old);
  ids.broken = remote(broken);
  ids.closed = remote(closed);
  ids.tunnel = remote(`tunnel://${LINK_ID}`);

  const proxyApp = express();
  proxyApp.use('/api/remote-servers', require('../routes/remote-servers'));
  proxy = await listen(proxyApp);
});

test.after(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); })));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- /v1/mindmaps ----

test('/v1/info advertises mindmaps', async () => {
  const info = await call('GET', `${engine}/v1/info`, undefined, auth);
  assert.ok(info.body.capabilities.includes('mindmaps'));
});

test('/v1/mindmaps needs an Engine token, checked before any body is read', async () => {
  const nineMb = JSON.stringify({ data: dataOf(9 * 1024 * 1024) });
  for (const [method, route, body] of [['GET', ''], ['POST', '', { title: 'x' }], ['POST', '', nineMb], ['GET', `/${MISSING}`], ['PUT', `/${MISSING}`, nineMb], ['DELETE', `/${MISSING}`]]) {
    const missing = await call(method, `${engine}/v1/mindmaps${route}`, body);
    assert.equal(missing.status, 401, `${method} ${route}`);
    assert.equal(missing.body.error, 'ENGINE_TOKEN_REQUIRED');
    const wrong = await call(method, `${engine}/v1/mindmaps${route}`, body, { Authorization: 'Bearer tae_wrong' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error, 'ENGINE_TOKEN_INVALID');
  }
});

test('/v1/mindmaps has the contract of /api/mindmaps and the same maps', async () => {
  const v1 = `${engine}/v1/mindmaps`;
  const created = await call('POST', v1, { title: 'Shared', data: { root: { topic: '\u601d\u7ef4' } } }, auth);
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.body).sort(), ['created_at', 'data', 'id', 'revision', 'title', 'updated_at']);
  assert.equal(created.body.revision, 1);
  const { id } = created.body;

  // One service instance behind both paths.
  assert.deepEqual((await call('GET', `${local}/api/mindmaps/${id}`)).body, created.body);
  assert.deepEqual((await call('GET', `${v1}/${id}`, undefined, auth)).body, created.body);
  assert.deepEqual((await call('GET', v1, undefined, auth)).body, (await call('GET', `${local}/api/mindmaps`)).body);
  const listed = (await call('GET', v1, undefined, auth)).body;
  assert.deepEqual(Object.keys(listed), ['maps']);
  assert.deepEqual(Object.keys(listed.maps[0]).sort(), ['created_at', 'id', 'revision', 'size', 'title', 'updated_at']);

  const saved = await call('PUT', `${v1}/${id}`, { revision: 1, data: { root: { topic: 'v1' } } }, auth);
  assert.equal(saved.status, 200);
  assert.deepEqual(Object.keys(saved.body).sort(), ['id', 'revision', 'title', 'updated_at']);
  assert.equal(saved.body.revision, 2);
  // A save through /api with the old revision is a conflict, whichever path made the newer one.
  const conflict = await call('PUT', `${local}/api/mindmaps/${id}`, { revision: 1, title: 'Stale' });
  assert.equal(conflict.status, 409);
  const v1Conflict = await call('PUT', `${v1}/${id}`, { revision: 1, title: 'Stale' }, auth);
  assert.deepEqual(v1Conflict, conflict);
  assert.deepEqual(v1Conflict.body, { error: 'MINDMAP_CONFLICT', message: 'The mind map changed elsewhere; reload it before saving', current_revision: 2 });

  // Bad bodies, ids and titles answer as they do on /api.
  for (const [method, route, body, headers] of [
    ['POST', '', 'not json', { 'Content-Type': 'application/json' }],
    ['POST', '', 'title=x', { 'Content-Type': 'application/x-www-form-urlencoded' }],
    ['POST', '', { title: '' }],
    ['PUT', `/${id}`, { revision: 2 }],
    ['PUT', `/${id}`, { title: 'x' }],
    ['GET', `/${MISSING}`],
    ['GET', '/NOT-A-UUID'],
    ['DELETE', `/${MISSING}`],
  ]) {
    const viaApi = await call(method, `${local}/api/mindmaps${route}`, body, headers);
    const viaV1 = await call(method, `${v1}${route}`, body, { ...headers, ...auth });
    assert.deepEqual(viaV1, viaApi, `${method} ${route}`);
    assert.ok(viaV1.status >= 400);
  }

  const removed = await call('DELETE', `${v1}/${id}`, undefined, auth);
  assert.equal(removed.status, 204);
  assert.equal(removed.body, null);
  assert.equal((await call('GET', `${local}/api/mindmaps/${id}`)).body.error, 'MINDMAP_NOT_FOUND');
  assert.ok(fs.readdirSync(path.join(mapsDir, 'trash')).some(name => name.startsWith(`${id}-`)), 'the deleted map is in the trash');
});

test('/v1/mindmaps keeps the 8 MB limit with its own parser', async () => {
  const v1 = `${engine}/v1/mindmaps`;
  const full = await call('POST', v1, { data: dataOf(LIMITS.dataBytes) }, auth);
  assert.equal(full.status, 201);
  assert.equal(JSON.stringify(full.body.data).length, LIMITS.dataBytes);
  const over = await call('PUT', `${v1}/${full.body.id}`, { revision: 1, data: dataOf(LIMITS.dataBytes + 1) }, auth);
  assert.equal(over.status, 413);
  assert.equal(over.body.error, 'MINDMAP_TOO_LARGE');
  const overParser = await call('PUT', `${v1}/${full.body.id}`, { revision: 1, data: dataOf(9 * 1024 * 1024) }, auth);
  assert.deepEqual(overParser.body, { error: 'MINDMAP_TOO_LARGE', message: 'The mind map is too large (limit: 8 MB)' });
  assert.equal((await call('DELETE', `${v1}/${full.body.id}`, undefined, auth)).status, 204);
});

test('/v1/mindmaps keeps the map limit', async () => {
  const before = fs.readdirSync(mapsDir).filter(name => name.endsWith('.json')).length;
  const filler = [];
  for (let index = before; index < LIMITS.maps; index += 1) {
    const id = `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    filler.push(id);
    fs.writeFileSync(path.join(mapsDir, `${id}.json`), JSON.stringify({ id, title: 'x', data: null, revision: 1, created_at: 'a', updated_at: 'a' }));
  }
  try {
    const refused = await call('POST', `${engine}/v1/mindmaps`, { title: 'one too many' }, auth);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'MINDMAP_LIMIT');
    assert.deepEqual(await call('POST', `${proxy}/api/remote-servers/${ids.engine}/mindmaps`, { title: 'one too many' }), refused);
  } finally {
    for (const id of filler) fs.rmSync(path.join(mapsDir, `${id}.json`), { force: true });
  }
});

// ---- The Client's proxy ----

test('the proxy passes the owning service\'s answers through unchanged', async () => {
  const base = `${proxy}/api/remote-servers/${ids.engine}/mindmaps`;
  const created = await call('POST', base, { title: 'Through the proxy', data: { root: {} } });
  assert.equal(created.status, 201);
  const { id } = created.body;
  assert.deepEqual((await call('GET', `${local}/api/mindmaps/${id}`)).body, created.body, 'the map is stored on the owning service');
  assert.deepEqual(await call('GET', `${base}/${id}`), await call('GET', `${local}/api/mindmaps/${id}`));
  assert.deepEqual(await call('GET', base), await call('GET', `${local}/api/mindmaps`));

  // No body at all (Content-Length 0 with the JSON type): the defaults, as on /api/mindmaps.
  const empty = await call('POST', base, undefined, { 'Content-Type': 'application/json' });
  assert.equal(empty.status, 201);
  assert.equal(empty.body.title, 'Untitled map');
  assert.equal(empty.body.data, null);

  const saved = await call('PUT', `${base}/${id}`, { revision: 1, title: 'Renamed' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 2);
  const conflict = await call('PUT', `${base}/${id}`, { revision: 1, title: 'Stale' });
  assert.deepEqual(conflict, { status: 409, body: { error: 'MINDMAP_CONFLICT', message: 'The mind map changed elsewhere; reload it before saving', current_revision: 2 } });
  assert.deepEqual(await call('PUT', `${base}/${id}`, { revision: 2, title: '' }), await call('PUT', `${local}/api/mindmaps/${id}`, { revision: 2, title: '' }));
  assert.deepEqual(await call('GET', `${base}/${MISSING}`), { status: 404, body: { error: 'MINDMAP_NOT_FOUND', message: 'Mind map not found' } });

  const removed = await call('DELETE', `${base}/${id}`);
  assert.equal(removed.status, 204);
  assert.equal(removed.body, null);
  assert.equal((await call('DELETE', `${base}/${id}`)).status, 404);
  await call('DELETE', `${base}/${empty.body.id}`);
});

test('the proxy refuses a bad map id before forwarding', async () => {
  const base = `${proxy}/api/remote-servers/${ids.engine}/mindmaps`;
  const before = engineHits.length;
  // (Dot segments are resolved by the URL before any request, so they never reach a map route.)
  for (const bad of ['NOT-A-UUID', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', '11111111-1111-1111-8111-111111111111', `${MISSING}x`, 'a%2Fb']) {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const answer = await call(method, `${base}/${bad}`, method === 'PUT' ? { revision: 1, title: 'x' } : undefined);
      assert.deepEqual(answer, { status: 404, body: { error: 'MINDMAP_NOT_FOUND', message: 'Mind map not found' } }, `${method} ${bad}`);
    }
  }
  assert.equal(engineHits.length, before, 'nothing was forwarded');
});

test('the proxy accepts an 8 MB map and refuses a bigger one before forwarding', async () => {
  const base = `${proxy}/api/remote-servers/${ids.engine}/mindmaps`;
  const full = await call('POST', base, { title: 'Big', data: dataOf(LIMITS.dataBytes) });
  assert.equal(full.status, 201);
  const read = await call('GET', `${base}/${full.body.id}`);
  assert.equal(read.status, 200);
  assert.equal(JSON.stringify(read.body.data).length, LIMITS.dataBytes);
  const saved = await call('PUT', `${base}/${full.body.id}`, { revision: 1, data: dataOf(LIMITS.dataBytes) });
  assert.equal(saved.status, 200);

  const before = engineHits.length;
  for (const bytes of [LIMITS.dataBytes + 1, 9 * 1024 * 1024, 33 * 1024 * 1024]) {
    for (const [method, route, body] of [['POST', '', { data: dataOf(bytes) }], ['PUT', `/${full.body.id}`, { revision: 2, data: dataOf(bytes) }]]) {
      const answer = await call(method, `${base}${route}`, body);
      assert.deepEqual(answer, { status: 413, body: { error: 'MINDMAP_TOO_LARGE', message: 'The mind map is too large (limit: 8 MB)' } }, `${method} ${bytes}`);
    }
  }
  assert.deepEqual(await call('POST', base, 'not json', { 'Content-Type': 'application/json' }), { status: 400, body: { error: 'INVALID_MINDMAP', message: 'The request is not a valid mind map' } });
  assert.equal(engineHits.length, before, 'nothing was forwarded');
  assert.equal((await call('DELETE', `${base}/${full.body.id}`)).status, 204);
});

test('an Engine without the capability gets 501 and no map request', async () => {
  const base = `${proxy}/api/remote-servers/${ids.old}/mindmaps`;
  for (const [method, route, body] of [['GET', ''], ['POST', '', { title: 'x' }], ['GET', `/${MISSING}`], ['PUT', `/${MISSING}`, { revision: 1, title: 'x' }], ['DELETE', `/${MISSING}`]]) {
    assert.deepEqual(await call(method, `${base}${route}`, body), { status: 501, body: { error: 'MINDMAPS_UNSUPPORTED' } }, `${method} ${route}`);
  }
  assert.deepEqual([...new Set(oldHits)], ['GET /v1/info']);
});

test('an offline Engine gets 502 with the connection code, and errors keep only the safe fields', async () => {
  for (const [id, code] of [[ids.closed, 'REMOTE_CONNECTION_FAILED'], [ids.tunnel, 'REMOTE_OFFLINE']]) {
    for (const [method, route, body] of [['GET', ''], ['POST', '', { title: 'x' }], ['PUT', `/${MISSING}`, { revision: 1, title: 'x' }]]) {
      assert.deepEqual(await call(method, `${proxy}/api/remote-servers/${id}/mindmaps${route}`, body), { status: 502, body: { error: code } }, `${code} ${method}`);
    }
  }
  assert.deepEqual(await call('GET', `${proxy}/api/remote-servers/${ids.broken}/mindmaps`),
    { status: 500, body: { error: 'MINDMAP_STORAGE_FAILED', message: 'The mind map storage failed' } });
  assert.deepEqual(await call('GET', `${proxy}/api/remote-servers/999999/mindmaps`), { status: 404, body: { error: 'REMOTE_NOT_FOUND' } });
});

// ---- Two real services ----

const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };

async function startService(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-mindmap-share-real-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', SESSION_SECRET: process.env.SESSION_SECRET, T_AGENT_DATA_DIR: temp, T_AGENT_DB_PATH: path.join(temp, 'db.sqlite'), TASKS_BASE_DIR: path.join(temp, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false', ACCESS_MODE: 'local' },
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
  const stop = () => (child.exitCode !== null ? Promise.resolve() : new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); }));
  t.after(async () => {
    await stop();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${port}`;
  return { url, temp, call: (method, route, body, headers = HEADERS) => call(method, `${url}${route}`, body, headers) };
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

// A body sent with chunked transfer encoding and no Content-Length.
async function sendChunked(url, method, text, headers) {
  const bytes = Buffer.from(text);
  const stream = new ReadableStream({
    start(controller) {
      for (let start = 0; start < bytes.length; start += 256 * 1024) controller.enqueue(bytes.subarray(start, start + 256 * 1024));
      controller.close();
    },
  });
  const response = await fetch(url, { method, headers, body: stream, duplex: 'half' });
  return { status: response.status, body: await response.json() };
}

test('two real services: maps are edited in place on their owner, directly and through the tunnel', { timeout: 120000 }, async t => {
  const a = await startService(t);
  const b = await startService(t);
  const made = await a.call('POST', '/api/service-links/code', {});
  assert.equal(made.status, 201);
  const joined = await b.call('POST', '/api/service-links/join', { url: a.url, code: made.body.code, confirm: true });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  const linkOf = async side => (await side.call('GET', '/api/service-links')).body.links.find(link => link.id === joined.body.id);
  await until(async () => (await linkOf(a))?.online && (await linkOf(b))?.online, 'both sides online');
  const aOnB = (await linkOf(b)).remote_server_id; // B calls A directly
  const bOnA = (await linkOf(a)).remote_server_id; // A calls B through the tunnel

  // A's map, edited from B (direct).
  const mine = await a.call('POST', '/api/mindmaps', { title: 'On A', data: { root: { topic: 'a' } } });
  assert.equal(mine.status, 201);
  assert.deepEqual(await b.call('GET', `/api/remote-servers/${aOnB}/mindmaps`), await a.call('GET', '/api/mindmaps'));
  assert.deepEqual((await b.call('GET', `/api/remote-servers/${aOnB}/mindmaps/${mine.body.id}`)).body, mine.body);
  const editedFromB = await b.call('PUT', `/api/remote-servers/${aOnB}/mindmaps/${mine.body.id}`, { revision: 1, data: { root: { topic: 'from B' } } });
  assert.equal(editedFromB.status, 200);
  assert.equal(editedFromB.body.revision, 2);
  assert.deepEqual((await a.call('GET', `/api/mindmaps/${mine.body.id}`)).body.data, { root: { topic: 'from B' } });
  assert.deepEqual(await b.call('PUT', `/api/remote-servers/${aOnB}/mindmaps/${mine.body.id}`, { revision: 1, title: 'Stale' }),
    { status: 409, body: { error: 'MINDMAP_CONFLICT', message: 'The mind map changed elsewhere; reload it before saving', current_revision: 2 } });
  assert.deepEqual((await b.call('GET', '/api/mindmaps')).body, { maps: [] }, 'nothing was copied to B');

  // B's 8 MB map, read and edited from A through the tunnel.
  const big = await b.call('POST', '/api/mindmaps', { title: 'On B', data: dataOf(LIMITS.dataBytes) });
  assert.equal(big.status, 201);
  const viaTunnel = `/api/remote-servers/${bOnA}/mindmaps`;
  const read = await a.call('GET', `${viaTunnel}/${big.body.id}`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, big.body);
  const saved = await a.call('PUT', `${viaTunnel}/${big.body.id}`, { revision: 1, data: dataOf(LIMITS.dataBytes - 1) });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.revision, 2);
  assert.equal(JSON.stringify((await b.call('GET', `/api/mindmaps/${big.body.id}`)).body.data).length, LIMITS.dataBytes - 1);
  assert.deepEqual(await a.call('PUT', `${viaTunnel}/${big.body.id}`, { revision: 1, title: 'Stale' }),
    { status: 409, body: { error: 'MINDMAP_CONFLICT', message: 'The mind map changed elsewhere; reload it before saving', current_revision: 2 } });
  assert.equal((await a.call('PUT', `${viaTunnel}/${big.body.id}`, { revision: 2, data: dataOf(LIMITS.dataBytes + 1) })).status, 413);

  // A chunked 8 MB body: to the proxy on A (forwarded through the tunnel), and to B's /v1 with B's token for A.
  const chunked = await sendChunked(`${a.url}${viaTunnel}/${big.body.id}`, 'PUT', JSON.stringify({ revision: 2, data: dataOf(LIMITS.dataBytes) }), HEADERS);
  assert.equal(chunked.status, 200, JSON.stringify(chunked.body));
  assert.equal(chunked.body.revision, 3);
  const minted = await b.call('POST', '/api/remote-tokens', { name: 'mindmap test' });
  assert.equal(minted.status, 201);
  const bearer = { 'Content-Type': 'application/json', Authorization: `Bearer ${minted.body.token}` };
  const direct = await sendChunked(`${b.url}/v1/mindmaps/${big.body.id}`, 'PUT', JSON.stringify({ revision: 3, data: dataOf(LIMITS.dataBytes) }), bearer);
  assert.equal(direct.status, 200);
  assert.equal(direct.body.revision, 4);

  // server.js keeps its 32 MB parser off /v1/mindmaps: without a token nothing is read, with one the route's own limit answers in JSON.
  const huge = JSON.stringify({ revision: 4, data: dataOf(33 * 1024 * 1024) });
  assert.equal((await b.call('PUT', `/v1/mindmaps/${big.body.id}`, huge, { 'Content-Type': 'application/json' })).status, 401);
  assert.deepEqual(await b.call('PUT', `/v1/mindmaps/${big.body.id}`, huge, bearer), { status: 413, body: { error: 'MINDMAP_TOO_LARGE', message: 'The mind map is too large (limit: 8 MB)' } });
  assert.deepEqual(await a.call('PUT', `${viaTunnel}/${big.body.id}`, huge), { status: 413, body: { error: 'MINDMAP_TOO_LARGE', message: 'The mind map is too large (limit: 8 MB)' } });
  // The proxy keeps the browser gates of the other /api routes.
  assert.equal((await a.call('POST', viaTunnel, { title: 'x' }, { 'Content-Type': 'application/json', Origin: 'http://evil.example.test' })).status, 403);

  // Create and delete through the tunnel; the deleted map lands in B's trash.
  const created = await a.call('POST', viaTunnel, { title: 'Made from A' });
  assert.equal(created.status, 201);
  assert.equal((await b.call('GET', `/api/mindmaps/${created.body.id}`)).body.title, 'Made from A');
  assert.equal((await a.call('DELETE', `${viaTunnel}/${created.body.id}`)).status, 204);
  assert.equal((await b.call('GET', `/api/mindmaps/${created.body.id}`)).status, 404);
  assert.ok(fs.readdirSync(path.join(b.temp, 'mindmaps', 'trash')).some(name => name.startsWith(`${created.body.id}-`)));
  assert.deepEqual((await a.call('GET', '/api/mindmaps')).body.maps.map(map => map.id), [mine.body.id], 'nothing was copied to A');
});
