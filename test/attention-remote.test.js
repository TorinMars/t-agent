// T-Attention shared across connected services: /v1/attention on the owning service, the Client's proxy /api/remote-servers/:id/attention, and two real
// server.js processes linked by a service link (one direction direct, the other through the reverse tunnel).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-attention-remote-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'attention-remote-test-secret-attention-remote-test-secret';
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
const { defaultService, AttentionError } = require('../services/attention');
const { createAttentionRoutes, createEngineAttentionRouter } = require('../routes/attention');
const { setSharedSummary } = require('../services/attention-summary');
const { getEngineIdentity } = require('../services/engine-identity');
const { checkTunnelTarget } = require('../lib/service-link-tunnel');

const LINK_ID = '44444444-4444-4444-8444-444444444444';
const servers = [];
const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); servers.push(server); });

async function call(method, url, body, headers = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: response.status, body: parsed, headers: response.headers };
}
const plain = ({ status, body }) => ({ status, body });

// Collects a server-sent events body; until(pattern) waits until the text read so far matches.
async function openStream(url, headers = {}) {
  const controller = new AbortController();
  const response = await fetch(url, { headers: { Accept: 'text/event-stream', ...headers }, signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = { status: response.status, type: response.headers.get('content-type'), text: '', ended: false, close: () => controller.abort() };
  state.until = async (want, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (!want.test(state.text)) {
      if (state.ended) throw new Error(`stream ended before ${want}: ${state.text}`);
      if (Date.now() > deadline) throw new Error(`stream did not deliver ${want}: ${state.text}`);
      const { value, done } = await reader.read();
      if (done) state.ended = true;
      if (value) state.text += decoder.decode(value, { stream: true });
    }
    return state.text;
  };
  state.waitEnd = async (timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (!state.ended && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) state.ended = true;
      if (value) state.text += decoder.decode(value, { stream: true });
    }
    return state.ended;
  };
  // The parsed `change` events received so far.
  state.changes = () => [...state.text.matchAll(/event: change\ndata: (.+)\n/g)].map(match => JSON.parse(match[1]));
  return state;
}

let engine, local, proxy, auth, token, tokenId, summaryOn = false;
const ids = {};
const engineHits = [];
const oldHits = [];
const summarized = [];

test.before(async () => {
  // The owning service: /v1 as server.js mounts it, with no body parser in front of /v1/attention; /api/attention on the same service instance.
  const engineApp = express();
  engineApp.use((req, res, next) => { engineHits.push(`${req.method} ${req.url}`); next(); });
  engineApp.use('/v1', require('../routes/engine-v1'));
  engine = await listen(engineApp);
  const localApp = express();
  localApp.use(express.json());
  localApp.use('/api/attention', createAttentionRoutes({ service: defaultService(), instanceId: () => getEngineIdentity().engine_id }).router);
  local = await listen(localApp);
  ({ token, id: tokenId } = createAccessToken(db, { principalId: 'owner' }));
  auth = { Authorization: `Bearer ${token}` };

  // An Engine from before shared T-Attention.
  const oldApp = express();
  oldApp.use((req, res, next) => { oldHits.push(`${req.method} ${req.url}`); next(); });
  oldApp.get('/v1/info', (req, res) => res.json({ capabilities: ['tasks:read', 'mindmaps'] }));
  const old = await listen(oldApp);

  // A closed port.
  const closed = await listen(express());
  await new Promise(resolve => servers.pop().close(resolve));

  const remote = base => db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
    .run('owner', base, base, encryptToken(token, process.env.SESSION_SECRET)).lastInsertRowid;
  ids.engine = remote(engine);
  ids.old = remote(old);
  ids.closed = remote(closed);
  ids.tunnel = remote(`tunnel://${LINK_ID}`);

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

// ---- /v1/attention ----

test('/v1/info advertises attention:remote', async () => {
  const info = await call('GET', `${engine}/v1/info`, undefined, auth);
  assert.ok(info.body.capabilities.includes('attention:remote'));
});

test('/v1/attention needs an Engine token, checked before any body is read', async () => {
  for (const [method, route, body] of [['GET', ''], ['GET', '/stream'], ['POST', '', '{"title":'], ['GET', '/1'], ['PATCH', '/1', '{bad'], ['DELETE', '/1'], ['POST', '/1/move', '{'], ['POST', '/1/summarize'], ['GET', '/tokens']]) {
    const missing = await call(method, `${engine}/v1/attention${route}`, body);
    assert.equal(missing.status, 401, `${method} ${route}`);
    assert.equal(missing.body.error, 'ENGINE_TOKEN_REQUIRED');
    const wrong = await call(method, `${engine}/v1/attention${route}`, body, { Authorization: 'Bearer tae_wrong' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error, 'ENGINE_TOKEN_INVALID');
    // A T-Attention CLI token is not an Engine token.
    assert.equal((await call(method, `${engine}/v1/attention${route}`, body, { Authorization: 'Bearer tatt_x' })).status, 401);
  }
  assert.deepEqual(plain(await call('POST', `${engine}/v1/attention`, '{"title":', auth)), { status: 400, body: { error: 'INVALID_JSON', message: 'The request body is not valid JSON' } });
});

test('/v1/attention has the item contract of /api/attention, on the same items, with actor user', async () => {
  const v1 = `${engine}/v1/attention`;
  const parent = await call('POST', v1, { title: 'Release \u53d1\u5e03', priority: 'high' }, auth);
  assert.equal(parent.status, 201);
  assert.equal(parent.headers.get('cache-control'), 'no-store');
  assert.equal(parent.body.source, 'user');
  const child = await call('POST', v1, { title: 'Write notes', parent_id: parent.body.id, custom_status: 'In Progress' }, auth);
  assert.equal(child.status, 201);
  assert.equal(child.body.parent_id, parent.body.id);

  // One service instance behind both paths; the list names the host and this Engine.
  const listed = await call('GET', v1, undefined, auth);
  assert.deepEqual(listed.body, (await call('GET', `${local}/api/attention`)).body);
  assert.deepEqual(Object.keys(listed.body).sort(), ['host', 'instance_id', 'items']);
  assert.equal(listed.body.host, os.hostname());
  assert.equal(listed.body.instance_id, getEngineIdentity().engine_id);
  assert.deepEqual((await call('GET', `${v1}?parent=${parent.body.id}`, undefined, auth)).body.items.map(item => item.id), [child.body.id]);
  assert.deepEqual((await call('GET', `${v1}?q=notes&status=todo&limit=5`, undefined, auth)).body.items.map(item => item.id), [child.body.id]);

  // PATCH takes every field the local PATCH takes, an activity and the tree fields included.
  const patched = await call('PATCH', `${v1}/${child.body.id}`, { status: 'waiting_user', attention_reason: 'Approve it', result: 'Drafted', custom_status: 'Blocked', activity: { kind: 'note', text: 'Asked from another device' } }, auth);
  assert.equal(patched.status, 200);
  assert.equal(patched.body.status, 'waiting_user');
  assert.equal(patched.body.result, 'Drafted');
  assert.equal(patched.body.custom_status, 'Blocked');
  const detail = await call('GET', `${v1}/${child.body.id}`, undefined, auth);
  assert.deepEqual(detail.body, (await call('GET', `${local}/api/attention/${child.body.id}`)).body);
  assert.deepEqual(Object.keys(detail.body).sort(), ['events', 'item']);
  assert.ok(detail.body.events.length >= 3);
  assert.ok(detail.body.events.every(event => event.actor === 'user'), 'a write over /v1 is the person on another device');
  assert.ok(detail.body.events.some(event => event.type === 'activity' && event.data.text === 'Asked from another device'));

  // Move, with a status change in the same call.
  const moved = await call('POST', `${v1}/${child.body.id}/move`, { position: 'top', status: 'working' }, auth);
  assert.equal(moved.status, 200);
  assert.equal(moved.body.item.status, 'working');
  assert.ok(Array.isArray(moved.body.items));

  // The owner's errors, as the local API answers them.
  assert.deepEqual(plain(await call('PATCH', `${v1}/${child.body.id}`, { priority: 'urgent' }, auth)).status, 400);
  assert.equal((await call('PATCH', `${v1}/${child.body.id}`, { priority: 'urgent' }, auth)).body.error, 'VALIDATION_FAILED');
  assert.deepEqual(plain(await call('DELETE', `${v1}/${parent.body.id}`, undefined, auth)), { status: 409, body: { error: 'HAS_CHILDREN', message: 'This task has subtasks; delete them or give them another parent first', children: [child.body.id] } });
  assert.deepEqual(plain(await call('GET', `${v1}/999999`, undefined, auth)), { status: 404, body: { error: 'NOT_FOUND', message: 'Task not found' } });
  assert.equal((await call('GET', `${v1}/abc`, undefined, auth)).status, 404);

  // Delete, child first.
  assert.equal((await call('DELETE', `${v1}/${child.body.id}`, undefined, auth)).status, 204);
  assert.equal((await call('DELETE', `${v1}/${parent.body.id}`, undefined, auth)).status, 204);
  assert.equal((await call('GET', `${local}/api/attention/${parent.body.id}`)).status, 404);
});

test('/v1/attention exposes no tokens, settings, plugins, market, pairing, by-ref or skill installer', async () => {
  for (const [method, route] of [['GET', '/tokens'], ['POST', '/tokens'], ['GET', '/settings/summary'], ['PUT', '/settings/guide'], ['GET', '/plugins'], ['GET', '/market'],
    ['POST', '/pairing'], ['GET', '/by-ref/x'], ['PUT', '/by-ref/x'], ['POST', '/skill/install'], ['POST', '/plugins/claude/install']]) {
    const answer = await call(method, `${engine}/v1/attention${route}`, method === 'GET' ? undefined : {}, auth);
    assert.equal(answer.status, 404, `${method} ${route}`);
    assert.equal(answer.body.error, 'NOT_FOUND');
  }
});

test('/v1/attention/:id/summarize follows the owner\'s summary setting', async () => {
  const item = (await call('POST', `${engine}/v1/attention`, { title: 'Summarize me' }, auth)).body;
  setSharedSummary(null);
  assert.equal((await call('POST', `${engine}/v1/attention/${item.id}/summarize`, undefined, auth)).status, 404, 'no summary on this server');
  setSharedSummary({
    summarize(user, id) {
      if (!summaryOn) throw new AttentionError('SUMMARY_DISABLED', 'The AI summary is switched off; turn it on in Settings first', 409);
      summarized.push({ user, id });
      return { started: true, promise: null };
    },
  });
  assert.deepEqual(plain(await call('POST', `${engine}/v1/attention/${item.id}/summarize`, undefined, auth)), { status: 409, body: { error: 'SUMMARY_DISABLED', message: 'The AI summary is switched off; turn it on in Settings first' } });
  summaryOn = true;
  assert.deepEqual(plain(await call('POST', `${engine}/v1/attention/${item.id}/summarize`, undefined, auth)), { status: 202, body: { started: true } });
  assert.equal(summarized.at(-1).id, item.id);
  assert.equal(typeof summarized.at(-1).user, 'string');
  await call('DELETE', `${engine}/v1/attention/${item.id}`, undefined, auth);
});

test('/v1/attention/stream sends the owner\'s changes', async () => {
  const stream = await openStream(`${engine}/v1/attention/stream`, auth);
  assert.equal(stream.status, 200);
  assert.match(stream.type, /text\/event-stream/);
  await stream.until(/retry: 3000/);
  const made = (await call('POST', `${local}/api/attention`, { title: 'Made on the owner' })).body;
  await stream.until(/Made on the owner/);
  const [change] = stream.changes();
  assert.equal(change.kind, 'created');
  assert.equal(change.item.id, made.id);
  stream.close();
  await call('DELETE', `${local}/api/attention/${made.id}`);
});

test('the /v1 stream ends when its token stops being active, and the scopes are checked', async () => {
  let active = true;
  const service = defaultService();
  const scoped = scopes => (req, res, next) => { req.engineAuth = { tokenId: 7, scopes }; next(); };
  const app = express();
  app.use('/full', createEngineAttentionRouter({ service, authenticate: scoped(new Set(['*'])), tokenActive: id => id === 7 && active, heartbeatMs: 40 }));
  app.use('/read', createEngineAttentionRouter({ service, authenticate: scoped(['attention:read']) }));
  app.use('/none', createEngineAttentionRouter({ service, authenticate: scoped(['tasks:read']) }));
  const base = await listen(app);

  const stream = await openStream(`${base}/full/stream`);
  await stream.until(/: heartbeat/);
  active = false;
  assert.equal(await stream.waitEnd(), true, 'a revoked token or removed link ends the stream at the next heartbeat');

  assert.equal((await call('GET', `${base}/read`)).status, 200);
  assert.deepEqual(plain(await call('POST', `${base}/read`, { title: 'x' })), { status: 403, body: { error: 'ENGINE_SCOPE_REQUIRED', required_scope: 'attention:write' } });
  assert.deepEqual(plain(await call('GET', `${base}/none/stream`)), { status: 403, body: { error: 'ENGINE_SCOPE_REQUIRED', required_scope: 'attention:read' } });
  assert.equal((await call('DELETE', `${base}/none/1`)).status, 403);
});

test('the service-link tunnel lets the /v1/attention paths through', () => {
  for (const target of ['/v1/attention', '/v1/attention?status=todo&include_done=1', '/v1/attention/12', '/v1/attention/12/move', '/v1/attention/12/summarize', '/v1/attention/stream']) {
    assert.equal(checkTunnelTarget(target), target);
  }
});

// ---- The proxy ----

test('every proxy route is forwarded to the owner\'s /v1/attention and answers what it answers', async () => {
  const via = `${proxy}/api/remote-servers/${ids.engine}/attention`;
  engineHits.length = 0;
  const created = await call('POST', via, { title: 'From the proxy', status: 'working' });
  assert.equal(created.status, 201);
  assert.equal((await call('GET', `${local}/api/attention/${created.body.id}`)).body.item.title, 'From the proxy');
  const child = (await call('POST', via, { title: 'Child', parent_id: created.body.id })).body;

  const listed = await call('GET', `${via}?status=working&q=proxy&limit=10&include_done=1&ignored=1`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.items.map(item => item.id), [created.body.id]);
  assert.equal(listed.body.instance_id, getEngineIdentity().engine_id);
  assert.deepEqual((await call('GET', `${via}?parent=${created.body.id}`)).body.items.map(item => item.id), [child.id]);
  assert.deepEqual((await call('GET', `${via}/${created.body.id}`)).body, (await call('GET', `${local}/api/attention/${created.body.id}`)).body);

  const patched = await call('PATCH', `${via}/${created.body.id}`, { status: 'review', result: 'Ready', activity: { kind: 'note', text: 'via proxy' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.status, 'review');
  const moved = await call('POST', `${via}/${child.id}/move`, { position: 'bottom' });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.item.id, child.id);

  // The owner's errors pass through with their status, code, message and fields.
  assert.deepEqual(plain(await call('PATCH', `${via}/${created.body.id}`, { priority: 'urgent' })).status, 400);
  assert.equal((await call('PATCH', `${via}/${created.body.id}`, { priority: 'urgent' })).body.error, 'VALIDATION_FAILED');
  assert.equal(typeof (await call('POST', via, {})).body.message, 'string');
  assert.deepEqual(plain(await call('DELETE', `${via}/${created.body.id}`)), { status: 409, body: { error: 'HAS_CHILDREN', message: 'This task has subtasks; delete them or give them another parent first', children: [child.id] } });
  assert.deepEqual(plain(await call('GET', `${via}/999999`)), { status: 404, body: { error: 'NOT_FOUND', message: 'Task not found' } });
  summaryOn = false;
  assert.deepEqual(plain(await call('POST', `${via}/${created.body.id}/summarize`)), { status: 409, body: { error: 'SUMMARY_DISABLED', message: 'The AI summary is switched off; turn it on in Settings first' } });
  summaryOn = true;
  assert.deepEqual(plain(await call('POST', `${via}/${created.body.id}/summarize`)), { status: 202, body: { started: true } });

  assert.deepEqual(plain(await call('DELETE', `${via}/${child.id}`)), { status: 204, body: null });
  assert.equal((await call('DELETE', `${via}/${created.body.id}`)).status, 204);
  assert.equal((await call('GET', `${local}/api/attention/${created.body.id}`)).status, 404);

  // Only the item routes, with the query keys of the list.
  const forwarded = engineHits.filter(hit => !hit.startsWith('GET /v1/info'));
  assert.ok(forwarded.includes('GET /v1/attention?status=working&q=proxy&limit=10&include_done=1'), forwarded.join('\n'));
  for (const route of [`POST /v1/attention`, `PATCH /v1/attention/${created.body.id}`, `POST /v1/attention/${child.id}/move`, `POST /v1/attention/${created.body.id}/summarize`, `DELETE /v1/attention/${child.id}`]) {
    assert.ok(forwarded.includes(route), route);
  }
  assert.ok(engineHits.filter(hit => hit === 'GET /v1/info').length <= 1, 'the capability is read once and kept for a while');
});

test('a bad item id is "not found" without a request, and unknown remotes are 404', async () => {
  engineHits.length = 0;
  for (const [method, route] of [['GET', '/abc'], ['PATCH', '/1.5'], ['DELETE', '/-1'], ['POST', '/x/move'], ['POST', '/x/summarize']]) {
    assert.deepEqual(plain(await call(method, `${proxy}/api/remote-servers/${ids.engine}/attention${route}`, method === 'GET' || method === 'DELETE' ? undefined : {})),
      { status: 404, body: { error: 'NOT_FOUND', message: 'Task not found' } }, `${method} ${route}`);
  }
  assert.deepEqual(engineHits, []);
  for (const route of ['', '/1', '/stream']) {
    assert.deepEqual(plain(await call('GET', `${proxy}/api/remote-servers/999999/attention${route}`)), { status: 404, body: { error: 'REMOTE_NOT_FOUND' } });
  }
});

test('an Engine without attention:remote answers 501 before anything is sent', async () => {
  oldHits.length = 0;
  for (const [method, route, body] of [['GET', ''], ['GET', '/stream'], ['POST', '', { title: 'x' }], ['GET', '/1'], ['PATCH', '/1', { title: 'x' }], ['DELETE', '/1'], ['POST', '/1/move', { position: 'top' }], ['POST', '/1/summarize']]) {
    assert.deepEqual(plain(await call(method, `${proxy}/api/remote-servers/${ids.old}/attention${route}`, body)), { status: 501, body: { error: 'ATTENTION_REMOTE_UNSUPPORTED' } }, `${method} ${route}`);
  }
  assert.deepEqual(oldHits, ['GET /v1/info'], 'only /v1/info, read once for all of them');
});

test('an offline Engine gets 502 with the connection code', async () => {
  for (const [id, code] of [[ids.closed, 'REMOTE_CONNECTION_FAILED'], [ids.tunnel, 'REMOTE_OFFLINE']]) {
    for (const [method, route, body] of [['GET', ''], ['GET', '/stream'], ['POST', '', { title: 'x' }], ['PATCH', '/1', { title: 'x' }]]) {
      assert.deepEqual(plain(await call(method, `${proxy}/api/remote-servers/${id}/attention${route}`, body)), { status: 502, body: { error: code } }, `${code} ${method} ${route}`);
    }
  }
});

test('the proxied stream delivers the owner\'s changes', async () => {
  const stream = await openStream(`${proxy}/api/remote-servers/${ids.engine}/attention/stream`);
  assert.equal(stream.status, 200);
  assert.match(stream.type, /text\/event-stream/);
  await stream.until(/retry: 3000/);
  const made = (await call('POST', `${local}/api/attention`, { title: 'Seen through the proxy' })).body;
  await call('PATCH', `${local}/api/attention/${made.id}`, { status: 'waiting_user', attention_reason: 'Look' });
  await stream.until(/"kind":"updated"/);
  const kinds = stream.changes().filter(change => change.item.id === made.id).map(change => change.kind);
  assert.deepEqual(kinds, ['created', 'updated']);
  stream.close();
  await call('DELETE', `${local}/api/attention/${made.id}`);
});

// ---- Two real services ----

const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };

async function startService(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-attention-remote-real-'));
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
  return { url, call: (method, route, body, headers = HEADERS) => call(method, `${url}${route}`, body, headers) };
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

test('two real services: items are edited in place on their owner, directly and through the tunnel', { timeout: 120000 }, async t => {
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

  // A's item, read and edited from B (direct).
  const mine = await a.call('POST', '/api/attention', { title: 'On A' });
  assert.equal(mine.status, 201);
  const fromB = await b.call('GET', `/api/remote-servers/${aOnB}/attention`);
  assert.equal(fromB.status, 200);
  assert.deepEqual(fromB.body, (await a.call('GET', '/api/attention')).body);
  assert.equal((await b.call('PATCH', `/api/remote-servers/${aOnB}/attention/${mine.body.id}`, { status: 'review' })).body.status, 'review');
  assert.equal((await a.call('GET', `/api/attention/${mine.body.id}`)).body.item.status, 'review');

  // B's items, created, edited, moved and deleted from A through the tunnel, with B's stream events reaching A.
  const viaTunnel = `/api/remote-servers/${bOnA}/attention`;
  const stream = await openStream(`${a.url}${viaTunnel}/stream`, { 'X-Requested-With': 'XMLHttpRequest' });
  assert.equal(stream.status, 200);
  await stream.until(/retry: 3000/);
  const parent = await a.call('POST', viaTunnel, { title: 'Parent on B' });
  assert.equal(parent.status, 201, JSON.stringify(parent.body));
  const child = await a.call('POST', viaTunnel, { title: 'Child on B', parent_id: parent.body.id });
  assert.equal(child.status, 201);
  const edited = await a.call('PATCH', `${viaTunnel}/${child.body.id}`, { status: 'waiting_user', attention_reason: 'Approve', activity: { kind: 'question', text: 'Go on?' } });
  assert.equal(edited.status, 200);
  const moved = await a.call('POST', `${viaTunnel}/${child.body.id}/move`, { position: 'top', status: 'working' });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.item.status, 'working');
  const onB = (await b.call('GET', `/api/attention/${child.body.id}`)).body;
  assert.equal(onB.item.status, 'working');
  assert.equal(onB.item.parent_id, parent.body.id);
  assert.ok(onB.events.every(event => event.actor === 'user'));
  assert.deepEqual(await a.call('DELETE', `${viaTunnel}/${parent.body.id}`).then(plain), { status: 409, body: { error: 'HAS_CHILDREN', message: 'This task has subtasks; delete them or give them another parent first', children: [child.body.id] } });
  assert.equal((await a.call('PATCH', `${viaTunnel}/${child.body.id}`, { status: 'nope' })).body.error, 'VALIDATION_FAILED');
  // A change made on B itself reaches A's stream too.
  await b.call('PATCH', `/api/attention/${parent.body.id}`, { notes: 'Edited on B' });
  assert.equal((await a.call('DELETE', `${viaTunnel}/${child.body.id}`)).status, 204);
  await stream.until(/"kind":"deleted"/);
  const changes = stream.changes();
  assert.deepEqual(changes.map(change => change.kind), ['created', 'created', 'updated', 'updated', 'updated', 'deleted']);
  assert.equal(changes[4].item.notes, 'Edited on B');
  stream.close();
  assert.equal((await a.call('DELETE', `${viaTunnel}/${parent.body.id}`)).status, 204);
  assert.deepEqual((await b.call('GET', '/api/attention?include_done=1')).body.items, []);

  // Nothing was copied: each list holds only its own items, and the list answers name their own Engine.
  const listA = (await a.call('GET', '/api/attention?include_done=1')).body;
  assert.deepEqual(listA.items.map(item => item.id), [mine.body.id]);
  const listB = (await b.call('GET', '/api/attention')).body;
  assert.notEqual(listA.instance_id, listB.instance_id);
  assert.equal((await a.call('GET', viaTunnel)).body.instance_id, listB.instance_id);
  // The proxy keeps the browser gates of the other /api routes.
  assert.equal((await a.call('POST', viaTunnel, { title: 'x' }, { 'Content-Type': 'application/json', Origin: 'http://evil.example.test' })).status, 403);
});
