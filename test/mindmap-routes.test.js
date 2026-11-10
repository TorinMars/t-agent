const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');
const { totp } = require('../services/client-auth');
const { createMindmapService, LIMITS } = require('../services/mindmap');
const { createMindmapRouter } = require('../routes/mindmap');

const LOGIN = '/torin/hide/login';
const MISSING = '11111111-1111-4111-8111-111111111111';
const JSON_HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };

// The router alone on a real HTTP server, without any body parser in front, as server.js mounts it.
async function listen(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-mindmap-routes-'));
  const service = createMindmapService({ dataDir, log: () => {}, ...options });
  const app = express();
  app.use('/api/mindmaps', createMindmapRouter({ service }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/mindmaps`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const send = (method, route, body, headers = JSON_HEADERS) => fetch(base + route, { method, headers, body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body) });
  const call = async (method, route, body, headers) => {
    const response = await send(method, route, body, headers);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { call, send, service, dataDir };
}

test('the API contract: create, read, save, list and delete', async t => {
  const { call, dataDir } = await listen(t);
  const created = await call('POST', '', { title: 'Plan', data: { root: {} } });
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.body).sort(), ['created_at', 'data', 'id', 'revision', 'title', 'updated_at']);
  assert.equal(created.body.revision, 1);
  const { id } = created.body;

  const read = await call('GET', `/${id}`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, created.body);

  const saved = await call('PUT', `/${id}`, { revision: 1, data: { root: { topic: 'x' } } });
  assert.equal(saved.status, 200);
  assert.deepEqual(Object.keys(saved.body).sort(), ['id', 'revision', 'title', 'updated_at']);
  assert.equal(saved.body.revision, 2);

  const conflict = await call('PUT', `/${id}`, { revision: 1, title: 'Stale' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'MINDMAP_CONFLICT');
  assert.equal(conflict.body.current_revision, 2);
  assert.equal(conflict.body.message, 'The mind map changed elsewhere; reload it before saving');

  const list = await call('GET', '');
  assert.equal(list.status, 200);
  assert.deepEqual(Object.keys(list.body), ['maps']);
  assert.deepEqual(Object.keys(list.body.maps[0]).sort(), ['created_at', 'id', 'revision', 'size', 'title', 'updated_at']);

  const removed = await call('DELETE', `/${id}`);
  assert.equal(removed.status, 204);
  assert.equal(removed.body, null);
  assert.deepEqual((await call('GET', '')).body, { maps: [] });
  assert.equal((await call('GET', `/${id}`)).body.error, 'MINDMAP_NOT_FOUND');
  assert.equal((await call('DELETE', `/${id}`)).status, 404);
  assert.equal(fs.readdirSync(path.join(dataDir, 'mindmaps', 'trash')).length, 1);
});

test('POST without a body or fields uses the defaults', async t => {
  const { call } = await listen(t);
  for (const body of [undefined, {}]) {
    const created = await call('POST', '', body);
    assert.equal(created.status, 201);
    assert.equal(created.body.title, 'Untitled map');
    assert.equal(created.body.data, null);
  }
});

test('newest update comes first', async t => {
  const { call } = await listen(t);
  const first = (await call('POST', '', { title: 'First' })).body;
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = (await call('POST', '', { title: 'Second' })).body;
  await new Promise(resolve => setTimeout(resolve, 5));
  await call('PUT', `/${first.id}`, { revision: 1, title: 'First again' });
  assert.deepEqual((await call('GET', '')).body.maps.map(map => map.id), [first.id, second.id]);
});

test('concurrent PUTs over HTTP: one wins and the rest conflict', async t => {
  const { call } = await listen(t);
  const { id } = (await call('POST', '', { title: 'Race' })).body;
  const results = await Promise.all(Array.from({ length: 12 }, (_, n) => call('PUT', `/${id}`, { revision: 1, data: { n } })));
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.equal(results.filter(result => result.status === 409 && result.body.current_revision === 2).length, 11);
  assert.equal((await call('GET', `/${id}`)).body.revision, 2);
});

test('path traversal in the id is not found and reads nothing', async t => {
  const { call, dataDir } = await listen(t);
  fs.writeFileSync(path.join(dataDir, 'secret.json'), JSON.stringify({ id: 'secret', title: 'Secret', data: null, revision: 1, created_at: 'x', updated_at: 'x' }));
  for (const route of ['/..%2Fsecret', '/..%2F..%2Fsecret.json', '/%2e%2e%2fsecret', '/trash', '/not-a-uuid', `/${MISSING.toUpperCase()}`, `/${MISSING}.json`]) {
    for (const method of ['GET', 'DELETE']) {
      const result = await call(method, route);
      assert.equal(result.status, 404, `${method} ${route}`);
      assert.equal(result.body.error, 'MINDMAP_NOT_FOUND');
    }
    assert.equal((await call('PUT', route, { revision: 1, title: 'x' })).body.error, 'MINDMAP_NOT_FOUND', route);
  }
  assert.ok(fs.existsSync(path.join(dataDir, 'secret.json')));
});

test('bad bodies are 400 INVALID_MINDMAP', async t => {
  const { call } = await listen(t);
  const { id } = (await call('POST', '', { title: 'Keep' })).body;
  const cases = [
    ['POST', '', '{not json'], ['POST', '', '[]'], ['POST', '', '"text"'], ['POST', '', { title: '' }], ['POST', '', { title: 5 }],
    ['POST', '', { title: 'a\nb' }], ['POST', '', { title: 'x'.repeat(201) }], ['POST', '', { data: [] }], ['POST', '', { data: 'x' }], ['POST', '', { data: null }],
    ['PUT', `/${id}`, {}], ['PUT', `/${id}`, { title: 'x' }], ['PUT', `/${id}`, { revision: 1 }], ['PUT', `/${id}`, { revision: 'one', title: 'x' }],
    ['PUT', `/${id}`, { revision: 1, data: [] }], ['PUT', `/${id}`, '{not json'],
  ];
  for (const [method, route, body] of cases) {
    const result = await call(method, route, body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(result.body.error, 'INVALID_MINDMAP', JSON.stringify(body));
  }
  assert.equal((await call('GET', `/${id}`)).body.revision, 1);
});

test('a body that is not JSON is refused, not taken for an empty map', async t => {
  const { call, service } = await listen(t);
  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    const result = await call('POST', '', 'title=Form', { 'Content-Type': contentType, 'X-Requested-With': 'XMLHttpRequest' });
    assert.equal(result.status, 400, contentType);
    assert.equal(result.body.error, 'INVALID_MINDMAP', contentType);
  }
  assert.deepEqual(await service.list(), []);
});

test('the size limit is 413 MINDMAP_TOO_LARGE, for the data and for the body', async t => {
  const { call, service } = await listen(t);
  const wrap = '{"x":""}'.length;
  const fits = await call('POST', '', { title: '\u5927', data: { x: 'a'.repeat(LIMITS.dataBytes - wrap) } });
  assert.equal(fits.status, 201);
  // Just over the data limit, still inside the parser limit: refused by the service.
  const justOver = await call('POST', '', { data: { x: 'a'.repeat(LIMITS.dataBytes - wrap + 1) } });
  assert.equal(justOver.status, 413);
  assert.equal(justOver.body.error, 'MINDMAP_TOO_LARGE');
  // Far over: refused by the parser.
  const farOver = await call('PUT', `/${fits.body.id}`, { revision: 1, data: { x: 'a'.repeat(9 * 1024 * 1024) } });
  assert.equal(farOver.status, 413);
  assert.equal(farOver.body.error, 'MINDMAP_TOO_LARGE');
  assert.equal((await service.list()).length, 1);
  assert.equal((await call('GET', `/${fits.body.id}`)).body.revision, 1);
});

test('the map limit is 409 MINDMAP_LIMIT', async t => {
  const { call } = await listen(t, { maxMaps: 1 });
  assert.equal((await call('POST', '', {})).status, 201);
  const refused = await call('POST', '', {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'MINDMAP_LIMIT');
});

test('Chinese title and content round trip over HTTP', async t => {
  const { call } = await listen(t);
  const title = '\u601d\u7ef4\u5bfc\u56fe';
  const data = { root: { topic: '\u6839\u8282\u70b9' } };
  const { id } = (await call('POST', '', { title, data })).body;
  const read = await call('GET', `/${id}`);
  assert.equal(read.body.title, title);
  assert.deepEqual(read.body.data, data);
  assert.equal((await call('GET', '')).body.maps[0].title, title);
});

test('a corrupt file does not take down the list', async t => {
  const { call, dataDir } = await listen(t);
  const good = (await call('POST', '', { title: 'Good' })).body;
  const broken = (await call('POST', '', { title: 'Broken' })).body;
  fs.writeFileSync(path.join(dataDir, 'mindmaps', `${broken.id}.json`), '{"oops');
  const list = await call('GET', '');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.maps.map(map => map.id), [good.id]);
  assert.equal((await call('GET', `/${broken.id}`)).status, 404);
});

test('a storage failure is a generic 500 that names no path or content', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-mindmap-routes-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  // A file where the mindmaps folder should be makes every operation fail.
  fs.writeFileSync(path.join(dataDir, 'mindmaps'), '');
  const app = express();
  app.use('/api/mindmaps', createMindmapRouter({ service: createMindmapService({ dataDir, log: () => {} }) }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const errors = t.mock.method(console, 'error', () => {});
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/mindmaps`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'MINDMAP_STORAGE_FAILED', message: 'The mind map storage failed' });
  assert.equal(errors.mock.callCount(), 1);
  assert.ok(!String(errors.mock.calls[0].arguments[0]).includes(dataDir), 'the log line names no path');
});

test('in the real server the API is behind the gates, and only its own parser reads the body', { timeout: 120000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-mindmap-server-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, TAGENT_HOME: '', HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', CLIENT_ALLOW_HTTP: 'false', SESSION_SECRET: 'integration-test-secret-'.repeat(3), T_AGENT_DATA_DIR: temp, T_AGENT_DB_PATH: path.join(temp, 'db.sqlite'), TASKS_BASE_DIR: path.join(temp, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) await new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); });
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Client startup timed out')), 15000);
    child.once('error', reject);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Client exited before becoming ready: ${output}`)); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = output.match(/Server running at http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const call = (route, { cookie, body, raw, headers = {}, method } = {}) => fetch(base + route, {
    method: method || (body || raw ? 'POST' : 'GET'),
    redirect: 'manual',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body || raw ? JSON_HEADERS : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : raw ? { body: raw } : {}),
  });
  const cookieOf = response => /(?:^|[,\s])(connect\.sid=[^;]+)/.exec(response.headers.get('set-cookie'))[1];

  // Logged out: the same 404 as any other protected address, whatever the body; a body is not even parsed, so its size cannot be observed.
  const huge = `{"data":{"x":"${'a'.repeat(33 * 1024 * 1024)}"}}`;
  for (const options of [{}, { method: 'POST', body: { title: 'x' } }, { raw: huge }, { method: 'PUT', body: { revision: 1, title: 'x' } }]) {
    assert.equal((await call('/api/mindmaps', options)).status, 404);
  }
  assert.equal((await call(`/api/mindmaps/${MISSING}`)).status, 404);
  assert.equal(fs.existsSync(path.join(temp, 'mindmaps')), false, 'nothing was stored or created while logged out');

  const start = await call(`${LOGIN}/setup/start`, { body: {} });
  const setup = await start.json();
  const confirm = await call(`${LOGIN}/setup/confirm`, { cookie: cookieOf(start), body: { code: totp(setup.secret, Math.floor(Date.now() / 30000)), return_to: '/h5' } });
  assert.equal(confirm.status, 200);
  const cookie = cookieOf(confirm);

  // The same-origin rule for mutations.
  const foreign = await call('/api/mindmaps', { cookie, body: { title: 'x' }, headers: { Origin: 'https://attacker.test' } });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error, 'CLIENT_ORIGIN_REQUIRED');
  const noProof = await fetch(`${base}/api/mindmaps`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noProof.status, 403);
  assert.equal((await call('/api/mindmaps', { cookie })).status, 200);

  // Signed in: the map lands in the data folder, with the file mode the contract says.
  const createdResponse = await call('/api/mindmaps', { cookie, body: { title: '\u601d\u7ef4', data: { root: {} } } });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const file = path.join(temp, 'mindmaps', `${created.id}.json`);
  assert.ok(fs.existsSync(file));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const rawPath = await call('/API/MINDMAPS', { cookie, raw: huge, headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  assert.equal(rawPath.status, 413, 'the global parser is skipped for every spelling Express routes here');

  // Bigger than the global 32 MB: still the route's own JSON answer.
  const overGlobal = await call('/api/mindmaps', { cookie, raw: huge });
  assert.equal(overGlobal.status, 413);
  assert.equal((await overGlobal.json()).error, 'MINDMAP_TOO_LARGE');
  const nineMb = `{"data":{"x":"${'a'.repeat(9 * 1024 * 1024)}"}}`;
  const overRoute = await call(`/api/mindmaps/${created.id}`, { cookie, raw: nineMb, method: 'PUT' });
  assert.equal(overRoute.status, 413);
  assert.equal((await overRoute.json()).error, 'MINDMAP_TOO_LARGE');

  // Other routes keep the global parser and its 32 MB limit: 9 MB is parsed and answered by the route, 33 MB is refused by the parser.
  assert.notEqual((await call('/api/tasks', { cookie, raw: nineMb })).status, 413);
  assert.equal((await call('/api/tasks', { cookie, raw: huge })).status, 413);
});
