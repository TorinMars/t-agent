const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');
const Database = require('better-sqlite3');
const { createAttentionService } = require('../services/attention');
const { createAttentionRoutes } = require('../routes/attention');

const ROOT = path.resolve(__dirname, '..');
const LOGIN = '/torin/hide/login';

// A real server.js on a temporary data folder (the gates, the session and the mount order are the ones that ship).
async function startServer(t, accessMode) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-attention-http-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', ACCESS_MODE: accessMode, SESSION_SECRET: 'attention-http-test-secret-'.repeat(3), T_AGENT_DATA_DIR: temp, T_AGENT_DB_PATH: path.join(temp, 'db.sqlite'), TASKS_BASE_DIR: path.join(temp, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) await new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); });
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Client startup timed out: ${output}`)), 10000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Client exited before becoming ready: ${output}`)); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      const found = output.match(/Server running at http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timer); resolve(Number(found[1])); }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const call = (route, { method = 'GET', headers = {}, body } = {}) => fetch(base + route, {
    method, redirect: 'manual',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  // A token made straight in the database (in remote mode no browser session exists to make one).
  const makeToken = name => {
    const db = new Database(path.join(temp, 'db.sqlite'));
    try { return createAttentionService({ db }).createToken({ name }); } finally { db.close(); }
  };
  return { base, call, makeToken };
}

const XHR = { 'X-Requested-With': 'XMLHttpRequest' };
const bearer = token => ({ Authorization: `Bearer ${token}` });

// Collects a server-sent events body; until(pattern) waits until the text read so far matches.
function sse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = { text: '', reader, ended: false };
  state.until = async (want, timeoutMs = 5000) => {
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
  return state;
}
const changesIn = text => [...text.matchAll(/event: change\ndata: (.*)\n\n/g)].map(match => JSON.parse(match[1]));

test('browser session: CRUD, 409, events, upsert by ref, same-origin rule, tokens and the token boundary', { timeout: 30000 }, async t => {
  const { call } = await startServer(t, 'local');

  // Mutations by the browser session need same-origin proof, like every other /api route.
  assert.equal((await call('/api/attention', { method: 'POST', body: { title: 'x' } })).status, 403);
  const evil = await call('/api/attention', { method: 'POST', headers: { ...XHR, Origin: 'https://evil.example' }, body: { title: 'x' } });
  assert.equal(evil.status, 403);
  assert.equal((await evil.json()).error, 'CLIENT_ORIGIN_REQUIRED');

  const created = await call('/api/attention', { method: 'POST', headers: XHR, body: { title: 'Ship it', priority: 'high', external_ref: 'cli:1', meta: { cwd: '/w' } } });
  assert.equal(created.status, 201);
  const item = await created.json();
  assert.equal(item.source, 'user');
  assert.deepEqual(item.meta, { cwd: '/w' });
  assert.equal(created.headers.get('cache-control'), 'no-store');

  const duplicate = await call('/api/attention', { method: 'POST', headers: XHR, body: { title: 'again', external_ref: 'cli:1' } });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: 'EXTERNAL_REF_EXISTS', message: 'A task with this external_ref already exists', id: item.id });

  const invalid = await call('/api/attention', { method: 'POST', headers: XHR, body: { title: 'x', link_url: 'javascript:alert(1)' } });
  assert.equal(invalid.status, 400);
  const invalidBody = await invalid.json();
  assert.equal(invalidBody.error, 'VALIDATION_FAILED');
  assert.match(invalidBody.message, /link_url/);

  const patched = await call(`/api/attention/${item.id}`, { method: 'PATCH', headers: XHR, body: { status: 'done' } });
  assert.equal(patched.status, 200);
  assert.ok((await patched.json()).completed_at);
  const detail = await (await call(`/api/attention/${item.id}`)).json();
  assert.equal(detail.item.status, 'done');
  assert.deepEqual(detail.events.map(event => [event.type, event.actor]), [['status', 'user'], ['created', 'user']]);
  assert.equal((await call('/api/attention/999999')).status, 404);
  assert.equal((await call('/api/attention/abc')).status, 404);

  const ref = encodeURIComponent('claude:session/1');
  const upCreated = await call(`/api/attention/by-ref/${ref}`, { method: 'PUT', headers: XHR, body: { title: 'from prompt', status: 'working' } });
  assert.equal(upCreated.status, 201);
  const upItem = await upCreated.json();
  assert.equal(upItem.external_ref, 'claude:session/1');
  const upUpdated = await call(`/api/attention/by-ref/${ref}`, { method: 'PUT', headers: XHR, body: { status: 'waiting_user', attention_reason: 'Allow Bash?' } });
  assert.equal(upUpdated.status, 200);
  assert.equal((await upUpdated.json()).id, upItem.id);

  const byRef = await call(`/api/attention/by-ref/${ref}`);
  assert.equal(byRef.status, 200);
  const byRefBody = await byRef.json();
  assert.equal(byRefBody.item.id, upItem.id);
  assert.equal(byRefBody.item.status, 'waiting_user');
  assert.deepEqual(byRefBody.events.map(event => event.type), ['status', 'created'], 'newest first, like GET /:id');
  const missingRef = await call(`/api/attention/by-ref/${encodeURIComponent('claude:none/x')}`);
  assert.equal(missingRef.status, 404);
  assert.deepEqual(await missingRef.json(), { error: 'NOT_FOUND', message: 'Task not found' });

  const listed = await (await call('/api/attention')).json();
  assert.deepEqual(listed.items.map(entry => entry.title), ['from prompt'], 'done items are hidden by default');
  assert.equal((await (await call('/api/attention?include_done=1')).json()).items.length, 2);
  assert.equal((await (await call('/api/attention?status=done')).json()).items[0].id, item.id);
  assert.equal((await call('/api/attention?status=nope')).status, 400);

  assert.equal((await call(`/api/attention/${item.id}`, { method: 'DELETE' })).status, 403, 'a delete needs same-origin proof too');
  assert.equal((await call(`/api/attention/${item.id}`, { method: 'DELETE', headers: XHR })).status, 204);
  assert.equal((await call(`/api/attention/${item.id}`)).status, 404);

  // Tokens: made and revoked by the browser session, shown once.
  assert.equal((await call('/api/attention/tokens', { method: 'POST', body: { name: 'cli' } })).status, 403);
  const tokenResponse = await call('/api/attention/tokens', { method: 'POST', headers: XHR, body: { name: 'cli' } });
  assert.equal(tokenResponse.status, 201);
  const { id: tokenId, token } = await tokenResponse.json();
  assert.match(token, /^tatt_[A-Za-z0-9_-]{43}$/);
  const tokenList = await (await call('/api/attention/tokens')).json();
  assert.equal(tokenList.tokens.length, 1);
  assert.equal(JSON.stringify(tokenList).includes(token), false);
  assert.deepEqual(Object.keys(tokenList.tokens[0]).sort(), ['created_at', 'id', 'last_used_at', 'name', 'revoked_at']);

  // A token works without cookies and without same-origin proof.
  const viaToken = await call('/api/attention', { method: 'POST', headers: bearer(token), body: { title: 'by token' } });
  assert.equal(viaToken.status, 201);
  const tokenItem = await viaToken.json();
  assert.equal(tokenItem.source, 'cli', 'a token without a source creates as cli');
  assert.equal(viaToken.headers.get('set-cookie'), null, 'no session cookie for a token');
  const bySource = await call(`/api/attention/${tokenItem.id}`, { method: 'PATCH', headers: bearer(token), body: { status: 'review', source: 'claude' } });
  assert.equal(bySource.status, 200);
  const tokenEvents = (await (await call(`/api/attention/${tokenItem.id}`, { headers: bearer(token) })).json()).events;
  assert.deepEqual(tokenEvents.map(event => event.actor), ['claude', 'cli'], 'actor: body.source, else the token name');
  assert.ok((await (await call('/api/attention/tokens')).json()).tokens[0].last_used_at);

  // The token cannot manage tokens, in any spelling.
  for (const route of ['/api/attention/tokens', '/api/attention/tokens/', '/api/attention/TOKENS', `/api/attention/tokens/${tokenId}`, '/api/attention/%74okens']) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const response = await call(route, { method, headers: bearer(token), ...(method === 'POST' ? { body: { name: 'x' } } : {}) });
      assert.ok([403, 404].includes(response.status), `${method} ${route}: ${response.status}`);
      assert.notEqual(response.status, 201);
    }
  }
  assert.equal((await (await call('/api/attention/tokens')).json()).tokens.length, 1, 'no token was made with a token');
  // An unknown address under /api/attention with a token is a JSON 404, never another route.
  const unknown = await call('/api/attention/x/y', { headers: bearer(token) });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, 'NOT_FOUND');

  // Local-only mode refuses requests that are not direct local ones; a token is its own credential and still gets through, only for /api/attention.
  const proxied = { 'X-Forwarded-For': '203.0.113.9' };
  assert.equal((await call('/api/attention', { headers: proxied })).status, 404);
  assert.equal((await call('/api/attention', { headers: { ...proxied, ...bearer(token) } })).status, 200);
  assert.equal((await call('/api/tasks', { headers: { ...proxied, ...bearer(token) } })).status, 404);

  // Wrong or revoked tokens: 401 JSON.
  const wrong = await call('/api/attention', { headers: bearer(`tatt_${'A'.repeat(43)}`) });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error, 'TOKEN_INVALID');
  assert.equal((await call('/api/attention', { headers: { Authorization: 'Bearer' } })).status, 401);
  assert.equal((await call(`/api/attention/tokens/${tokenId}`, { method: 'DELETE', headers: XHR })).status, 204);
  assert.ok((await (await call('/api/attention/tokens')).json()).tokens[0].revoked_at);
  assert.equal((await call('/api/attention', { headers: bearer(token) })).status, 401, 'a revoked token is refused');
  assert.equal((await call('/api/attention/tokens/999', { method: 'DELETE', headers: XHR })).status, 404);

  // Failed attempts are rate limited per address.
  const attacker = { 'X-Forwarded-For': '198.51.100.7' };
  let last;
  for (let i = 0; i < 21; i += 1) last = await call('/api/attention', { headers: { ...attacker, ...bearer(`tatt_${String(i).padStart(43, 'x')}`) } });
  assert.equal(last.status, 429);
  assert.equal((await last.json()).error, 'TOO_MANY_ATTEMPTS');
  assert.ok(Number(last.headers.get('retry-after')) > 0);
});

test('login gate: a logged-out request reaches /api/attention only with a token, and the token opens nothing else', { timeout: 30000 }, async t => {
  const { call, makeToken } = await startServer(t, 'remote');
  const { token } = makeToken('listener');
  assert.equal((await call('/api/attention')).status, 404, 'logged out without a token: the gate 404');
  const listed = await call('/api/attention', { headers: bearer(token) });
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), { items: [], host: require('node:os').hostname() }, 'the list names this machine (context.host of a listener here)');
  const upsert = await call(`/api/attention/by-ref/${encodeURIComponent('claude:abc')}`, { method: 'PUT', headers: bearer(token), body: { title: 'hello', status: 'working', source: 'claude' } });
  assert.equal(upsert.status, 201);
  assert.equal((await upsert.json()).source, 'claude');
  assert.equal((await call('/api/attention', { method: 'POST', headers: bearer(token), body: '{"title":' })).status, 400, 'bad JSON is a JSON 400');
  const found = await call(`/api/attention/by-ref/${encodeURIComponent('claude:abc')}`, { headers: bearer(token) });
  assert.equal(found.status, 200);
  const foundBody = await found.json();
  assert.equal(foundBody.item.external_ref, 'claude:abc');
  assert.equal(foundBody.events.length, 1);
  const notThere = await call(`/api/attention/by-ref/${encodeURIComponent('claude:a/b')}`, { headers: bearer(token) });
  assert.equal(notThere.status, 404);
  assert.equal((await notThere.json()).error, 'NOT_FOUND');
  assert.equal((await call(`/api/attention/by-ref/${encodeURIComponent('claude:abc')}`)).status, 404, 'logged out without a token: the gate 404');

  for (const route of ['/api/tasks', '/api/system/version', '/api/task-groups', '/api/remote-servers', '/api/bookmarks', '/api/attentionx', '/js/h5.js', '/manifest.json', '/auth/me']) {
    const response = await call(route, { headers: bearer(token) });
    assert.equal(response.status, 404, route);
  }
  for (const page of ['/', '/h5']) {
    const response = await call(page, { headers: bearer(token) });
    assert.equal(response.status, 302, page);
    assert.match(response.headers.get('location'), new RegExp(`^${LOGIN}\\?return_to=`));
  }
  assert.equal((await call('/api/attention/tokens', { headers: bearer(token) })).status, 403);
  assert.equal((await call('/api/attention/tokens')).status, 404, 'tokens need a logged-in browser session');
  assert.equal((await call('/api/attention', { headers: bearer('tatt_wrong') })).status, 401);
});

test('stream: session and token both get change events; the stream ends when its token is revoked; heartbeats', { timeout: 30000 }, async t => {
  const { call } = await startServer(t, 'local');
  const { token, id } = await (await call('/api/attention/tokens', { method: 'POST', headers: XHR, body: { name: 'watcher' } })).json();

  const sessionResponse = await call('/api/attention/stream');
  assert.equal(sessionResponse.status, 200);
  assert.match(sessionResponse.headers.get('content-type'), /^text\/event-stream/);
  const tokenResponse = await call('/api/attention/stream', { headers: bearer(token) });
  assert.equal(tokenResponse.status, 200);
  const sessionStream = sse(sessionResponse);
  const tokenStream = sse(tokenResponse);
  await sessionStream.until(/: connected/);
  await tokenStream.until(/: connected/);

  const made = await (await call('/api/attention', { method: 'POST', headers: XHR, body: { title: 'watched' } })).json();
  await call(`/api/attention/${made.id}`, { method: 'PATCH', headers: bearer(token), body: { status: 'waiting_user', attention_reason: 'needs you' } });

  const tokenChanges = changesIn(await tokenStream.until(/"kind":"updated"/));
  assert.deepEqual(tokenChanges.map(change => change.kind), ['created', 'updated']);
  assert.equal(tokenChanges[1].item.status, 'waiting_user');
  assert.equal(tokenChanges[1].previous.status, 'todo');
  assert.equal(tokenChanges[1].event.type, 'status');
  assert.equal(tokenChanges[1].event.actor, 'watcher');

  await call(`/api/attention/${made.id}`, { method: 'DELETE', headers: XHR });
  assert.deepEqual(changesIn(await sessionStream.until(/"kind":"deleted"/)).map(change => change.kind), ['created', 'updated', 'deleted']);
  sessionStream.reader.cancel();

  // Revoking a token closes its open stream at once.
  assert.equal((await call(`/api/attention/tokens/${id}`, { method: 'DELETE', headers: XHR })).status, 204);
  assert.equal(await tokenStream.waitEnd(), true);
  assert.equal((await call('/api/attention/stream', { headers: bearer(token) })).status, 401);
});

test('stream heartbeats, and a token stream also ends at the next heartbeat when the token was revoked elsewhere', { timeout: 10000 }, async t => {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8'));
  const service = createAttentionService({ db });
  const routes = createAttentionRoutes({ service, heartbeatMs: 50 });
  const app = express();
  app.use('/api/attention', routes.bearer);
  app.use(express.json());
  app.use('/api/attention', routes.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { routes.closeStreams(); server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/attention`;
  const { token, id } = service.createToken({ name: 't' });
  const response = await fetch(`${base}/stream`, { headers: bearer(token) });
  const stream = sse(response);
  assert.match(await stream.until(/: heartbeat/), /retry: 3000/);
  service.revokeToken(id); // not through the route: the heartbeat check notices
  assert.equal(await stream.waitEnd(), true);
});

test('the per-token request limit answers 429', { timeout: 10000 }, async t => {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8'));
  const service = createAttentionService({ db });
  const routes = createAttentionRoutes({ service, tokenRequests: { windowMs: 60000, max: 3 } });
  const app = express();
  app.use('/api/attention', routes.bearer);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.close(); db.close(); });
  const { token } = service.createToken({ name: 't' });
  const statuses = [];
  for (let i = 0; i < 4; i += 1) statuses.push((await fetch(`http://127.0.0.1:${server.address().port}/api/attention`, { headers: bearer(token) })).status);
  assert.deepEqual(statuses, [200, 200, 200, 429]);
});
