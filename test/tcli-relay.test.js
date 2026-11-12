// routes/tcli.js: the local relay /api/tcli/oss (terminal hook token, this machine only, the agent-access switch, remove confirm, streamed
// upload and download through the real Express routes with a fake ali-oss client), the Engine routes /v1/oss/files, forwarding to a linked
// provider (a second app with the Engine routes) and 501 for a provider without `oss:files`, and the switch routes /api/oss/agent-access.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { createOssImages } = require('../services/oss-images');
const { createOssFiles } = require('../services/oss-files');
const { createOssAgentSettings } = require('../services/oss-agent-settings');
const WebSocket = require('ws');
const { createTcliRelayRouter, createOssFilesEngineRouter, CAPABILITY } = require('../routes/tcli');
const { getHub, startTunnelClient, tunnelBase, TUNNEL_WS_OPTIONS, LEGACY_REQUEST_BODY_BYTES } = require('../lib/service-link-tunnel');
const { createOssRouter } = require('../routes/oss');
const { request: remoteRequest } = require('../services/remote-client');
const { createFakeOss, memoryDb, CONFIG, SECRET } = require('./helpers/fake-oss');

const OWNER = 'owner';
const HOOK = { task: '7', terminal: 'term-1', token: 'a'.repeat(64) };
const hookHeaders = (hook = HOOK) => ({ 'X-T-Agent-Task': hook.task, 'X-T-Agent-Terminal': hook.terminal, 'X-T-Agent-Token': hook.token });
const verifyToken = (task, terminal, token) => task === 7 && terminal === HOOK.terminal && token === HOOK.token;

// One engine: its database, fake bucket, OSS services and switch.
function engine({ configured = true } = {}) {
  const db = memoryDb();
  db.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY, user_id TEXT)');
  db.prepare('INSERT INTO tasks (id, user_id) VALUES (7, ?)').run(OWNER);
  const fake = createFakeOss();
  const images = createOssImages({ db, sessionSecret: 'test-secret', createClient: options => fake.createClient(options) });
  if (configured) images.saveConfig(OWNER, CONFIG);
  return { db, fake, images, files: createOssFiles({ images }), settings: createOssAgentSettings({ db }) };
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  test.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

// The relay app as server.js mounts it: the relay first, then whatever comes after (here: a marker that shows the request was passed on).
async function relayApp(local, { linked = null, isLocal, request = remoteRequest } = {}) {
  const app = express();
  app.use('/api/tcli', createTcliRelayRouter({
    db: local.db, verifyToken, files: () => local.files, settings: () => local.settings, owner: () => OWNER,
    linked: () => linked, request, ...(isLocal ? { isLocal } : {}),
  }));
  app.use((req, res) => res.status(418).json({ error: 'PASSED_ON' }));
  return listen(app);
}

// A provider: /v1/info and /v1/oss/files behind a stand-in for requireEngineAuth('engine:admin').
async function providerApp(remote, { capabilities = [CAPABILITY], ossRoutes = true } = {}) {
  const app = express();
  const auth = (req, res, next) => (req.get('authorization') === 'Bearer link-token' ? next() : res.status(401).json({ error: 'ENGINE_TOKEN_INVALID' }));
  app.get('/v1/info', auth, (req, res) => res.json({ name: 'Studio', capabilities }));
  if (ossRoutes) app.use('/v1/oss/files', auth, createOssFilesEngineRouter({ files: () => remote.files, settings: () => remote.settings, owner: () => OWNER }));
  return listen(app);
}

async function call(base, method, route, { headers = hookHeaders(), body, query } = {}) {
  const url = new URL(`/api/tcli/oss${route}`, base);
  for (const [name, value] of Object.entries(query || {})) url.searchParams.set(name, value);
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) init.body = body;
    else { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  }
  const response = await fetch(url, init);
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, body: payload, headers: response.headers };
}

// A raw request (for a missing Content-Length or a body that is only announced).
function raw(base, method, path, headers, write) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, base), { method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
    });
    req.on('error', error => (error.code === 'EPIPE' || error.code === 'ECONNRESET' ? null : reject(error)));
    write(req);
  });
}

test('relay auth: the hook token is the only credential; requests without the headers or from another machine are passed on', async () => {
  const local = engine();
  const base = await relayApp(local);
  assert.deepEqual((await call(base, 'GET', '/list', { headers: {} })).body, { error: 'PASSED_ON' });
  assert.equal((await call(base, 'GET', '/list', { headers: { 'X-T-Agent-Task': '7' } })).body.error, 'TCLI_AUTH_REQUIRED');
  assert.equal((await call(base, 'GET', '/list', { headers: { 'X-T-Agent-Token': HOOK.token } })).status, 401);
  for (const headers of [
    hookHeaders({ ...HOOK, token: 'b'.repeat(64) }), hookHeaders({ ...HOOK, terminal: 'other' }), hookHeaders({ ...HOOK, task: '8' }), hookHeaders({ ...HOOK, task: 'x7' }),
  ]) {
    assert.deepEqual((await call(base, 'GET', '/list', { headers })).body, { error: 'TCLI_AUTH_INVALID', message: 'The terminal token is not valid' });
  }
  // A token that verifies but names a task that is gone.
  local.db.prepare('DELETE FROM tasks').run();
  assert.equal((await call(base, 'GET', '/list')).status, 403);
  local.db.prepare('INSERT INTO tasks (id, user_id) VALUES (7, ?)').run(OWNER);
  assert.equal((await call(base, 'GET', '/list')).status, 200);
  // Through a proxy on this machine every visitor would look local: a forwarded request is not taken.
  assert.equal((await call(base, 'GET', '/list', { headers: { ...hookHeaders(), 'X-Forwarded-For': '203.0.113.9' } })).status, 418);
  const remoteBase = await relayApp(local, { isLocal: () => false });
  assert.equal((await call(remoteBase, 'GET', '/list')).status, 418, 'not from this machine: passed on untouched');
  assert.deepEqual((await call(base, 'GET', '/nope')).body.error, 'UNKNOWN_ROUTE', 'an unknown relay path is not passed on to the login gate');
});

test('relay: the agent-access switch off answers 403 OSS_AGENT_ACCESS_OFF for every route', async () => {
  const local = engine();
  const base = await relayApp(local);
  local.settings.setEnabled(false);
  for (const [method, route, body] of [['GET', '/list'], ['GET', '/stat'], ['GET', '/object'], ['PUT', '/object', Buffer.from('x')], ['POST', '/copy', {}], ['POST', '/remove', { keys: ['a'], confirm: true }], ['POST', '/sign', {}]]) {
    const answer = await call(base, method, route, { body, query: { key: 'a' } });
    assert.deepEqual(answer.body, { error: 'OSS_AGENT_ACCESS_OFF', message: 'OSS access for agent sessions is turned off on this engine' }, `${method} ${route}`);
    assert.equal(answer.status, 403);
  }
  local.settings.setEnabled(true);
  assert.equal((await call(base, 'GET', '/list')).status, 200);
});

test('relay: list, stat, copy, move, sign and remove (confirm required) on the own bucket', async () => {
  const local = engine();
  const base = await relayApp(local);
  local.fake.store('docs/a.md', Buffer.from('# a'), { type: 'text/markdown' });
  local.fake.store('docs/sub/b.md', Buffer.from('# b'));
  const list = await call(base, 'GET', '/list', { query: { prefix: 'docs/' } });
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.deepEqual(list.body.objects.map(object => object.key), ['docs/a.md']);
  assert.deepEqual(list.body.prefixes, ['docs/sub/']);
  const recursive = await call(base, 'GET', '/list', { query: { prefix: 'docs/', delimiter: '', max: '1' } });
  assert.deepEqual(recursive.body.objects.map(object => object.key), ['docs/a.md']);
  assert.equal(recursive.body.truncated, true);
  assert.equal((await call(base, 'GET', '/list', { query: { max: '5000' } })).body.error, 'INVALID_ARGUMENT');

  assert.equal((await call(base, 'GET', '/stat', { query: { key: 'docs/a.md' } })).body.content_type, 'text/markdown');
  const missing = await call(base, 'GET', '/stat', { query: { key: 'missing' } });
  assert.deepEqual([missing.status, missing.body], [404, { error: 'NOT_FOUND', message: 'The object does not exist' }]);
  assert.equal((await call(base, 'GET', '/stat', { query: { key: '../etc' } })).body.error, 'INVALID_KEY');
  assert.equal((await call(base, 'GET', '/stat')).status, 400);

  assert.equal((await call(base, 'POST', '/copy', { body: { src: 'docs/a.md', dst: 'c.md' } })).body.dst, 'c.md');
  assert.equal((await call(base, 'POST', '/move', { body: { src: 'c.md', dst: 'd.md' } })).body.moved, true);
  assert.equal(local.fake.objects.has('c.md'), false);
  const signed = await call(base, 'POST', '/sign', { body: { key: 'd.md', expires: 120 } });
  assert.match(signed.body.url, /^https:\/\/.*x-oss-expires=120/);
  assert.equal((await call(base, 'POST', '/sign', { body: { key: 'd.md', method: 'PUT' } })).status, 400);

  assert.deepEqual((await call(base, 'POST', '/remove', { body: { keys: ['d.md'] } })).body, { error: 'CONFIRM_REQUIRED', message: 'Removing objects needs "confirm": true' });
  assert.equal((await call(base, 'POST', '/remove', { body: { keys: ['d.md'], confirm: 'yes' } })).status, 400);
  assert.equal(local.fake.objects.has('d.md'), true, 'nothing removed without confirm');
  assert.deepEqual((await call(base, 'POST', '/remove', { body: { keys: ['d.md'], confirm: true } })).body, { deleted: ['d.md'], failed: [] });
  assert.equal((await call(base, 'POST', '/copy', { body: Buffer.from('{not json'), headers: { ...hookHeaders(), 'Content-Type': 'application/json' } })).body.error, 'INVALID_ARGUMENT');
});

test('relay: a streamed upload and download through the real routes; active types stored as bytes; size rules', async () => {
  const local = engine();
  const base = await relayApp(local);
  const body = crypto.randomBytes(3 * 1024 * 1024 + 17);
  const put = await call(base, 'PUT', '/object', { query: { key: 'out/data.bin' }, body, headers: { ...hookHeaders(), 'Content-Type': 'application/zip' } });
  assert.equal(put.status, 200);
  assert.equal(put.body.key, 'out/data.bin');
  assert.equal(put.body.size, body.length);
  assert.equal(put.body.content_type, 'application/zip');
  assert.match(put.body.url, /^https:\/\//);
  assert.deepEqual(local.fake.objects.get('out/data.bin').body, body);

  const got = await call(base, 'GET', '/object', { query: { key: 'out/data.bin' } });
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, body);
  assert.equal(got.headers.get('content-length'), String(body.length));
  assert.equal(got.headers.get('content-type'), 'application/zip');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.match(got.headers.get('etag'), /^"[0-9A-F]{32}"$/);
  assert.deepEqual((await call(base, 'GET', '/object', { query: { key: 'missing.bin' } })).body.error, 'NOT_FOUND');

  const page = await call(base, 'PUT', '/object', { query: { key: 'evil.html' }, body: Buffer.from('<script>alert(1)</script>'), headers: { ...hookHeaders(), 'Content-Type': 'text/html' } });
  assert.equal(page.body.content_type, 'application/octet-stream');
  assert.equal(local.fake.objects.get('evil.html').type, 'application/octet-stream');

  // A JSON upload is stored as bytes, not parsed (the relay is mounted before the body parsers, and has none on this route).
  const jsonFile = Buffer.from('{"a":1}');
  assert.equal((await call(base, 'PUT', '/object', { query: { key: 'data.json' }, body: jsonFile, headers: { ...hookHeaders(), 'Content-Type': 'application/json' } })).status, 200);
  assert.deepEqual(local.fake.objects.get('data.json').body, jsonFile);

  const chunked = await raw(base, 'PUT', '/api/tcli/oss/object?key=x.bin', { ...hookHeaders(), 'Transfer-Encoding': 'chunked' }, req => { req.write('abc'); req.end(); });
  assert.deepEqual(chunked, { status: 411, body: { error: 'LENGTH_REQUIRED', message: 'The upload needs a Content-Length header' } });
  const huge = await raw(base, 'PUT', '/api/tcli/oss/object?key=x.bin', { ...hookHeaders(), 'Content-Length': String(1024 * 1024 * 1024 + 1) }, req => { req.write('abc'); });
  assert.equal(huge.status, 413);
  assert.equal(huge.body.error, 'TOO_LARGE');
  assert.equal((await call(base, 'PUT', '/object', { query: { key: '/abs' }, body: Buffer.from('x') })).body.error, 'INVALID_KEY');
  assert.equal(local.fake.objects.has('x.bin'), false);
});

test('relay: no answer holds the secret, also when OSS fails with a message that does', async () => {
  const local = engine();
  const base = await relayApp(local);
  local.fake.failWith(Object.assign(new Error(`denied for ${SECRET}`), { status: 403, code: 'AccessDenied' }));
  const failed = await call(base, 'GET', '/list');
  assert.deepEqual(failed, { status: 502, body: { error: 'OSS_REQUEST_FAILED', message: 'The OSS request failed (AccessDenied)', oss_code: 'AccessDenied' }, headers: failed.headers });
  const notConfigured = await relayApp(engine({ configured: false }));
  assert.equal((await call(notConfigured, 'GET', '/list')).status, 409);
  assert.equal((await call(notConfigured, 'GET', '/list')).body.error, 'OSS_NOT_CONFIGURED');
});

test('linked provider: without an own bucket the call goes to the provider\'s /v1/oss/files, streams included; its switch and errors apply', async () => {
  const remote = engine();
  const providerBase = await providerApp(remote);
  const local = engine({ configured: false });
  const peer = { id: 'p1', name: 'Studio', baseUrl: providerBase, token: 'link-token' };
  let asked = 0;
  const linked = { async providerFor(feature) { asked += 1; assert.equal(feature, 'oss'); return peer; } };
  const base = await relayApp(local, { linked });

  remote.fake.store('shared/a.txt', Buffer.from('from the provider'), { type: 'text/plain' });
  const list = await call(base, 'GET', '/list', { query: { prefix: 'shared/' } });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.objects.map(object => object.key), ['shared/a.txt']);
  assert.equal((await call(base, 'GET', '/stat', { query: { key: 'shared/a.txt' } })).body.size, 17);

  const body = crypto.randomBytes(2 * 1024 * 1024 + 3);
  const put = await call(base, 'PUT', '/object', { query: { key: 'shared/up.bin' }, body, headers: { ...hookHeaders(), 'Content-Type': 'image/svg+xml' } });
  assert.equal(put.status, 200);
  assert.equal(put.body.size, body.length);
  assert.equal(put.body.content_type, 'application/octet-stream', 'the provider applies the active-content rule');
  assert.deepEqual(remote.fake.objects.get('shared/up.bin').body, body);
  const got = await call(base, 'GET', '/object', { query: { key: 'shared/up.bin' } });
  assert.deepEqual(got.body, body);
  assert.equal(got.headers.get('content-length'), String(body.length));

  assert.equal((await call(base, 'POST', '/copy', { body: { src: 'shared/a.txt', dst: 'shared/b.txt' } })).status, 200);
  assert.equal((await call(base, 'POST', '/move', { body: { src: 'shared/b.txt', dst: 'shared/c.txt' } })).body.moved, true);
  assert.match((await call(base, 'POST', '/sign', { body: { key: 'shared/c.txt' } })).body.url, /^https:\/\//);
  assert.equal((await call(base, 'POST', '/remove', { body: { keys: ['shared/c.txt'] } })).body.error, 'CONFIRM_REQUIRED', 'checked here before anything is sent');
  assert.deepEqual((await call(base, 'POST', '/remove', { body: { keys: ['shared/c.txt'], confirm: true } })).body, { deleted: ['shared/c.txt'], failed: [] });
  assert.equal(local.fake.calls.length, 0, 'the own (unconfigured) bucket is never called');

  // The provider's answers pass through with their code; its name is added.
  const missing = await call(base, 'GET', '/stat', { query: { key: 'shared/missing' } });
  assert.deepEqual([missing.status, missing.body.error, missing.body.provider], [404, 'NOT_FOUND', 'Studio']);
  assert.equal((await call(base, 'GET', '/object', { query: { key: 'shared/missing' } })).body.error, 'NOT_FOUND');
  remote.settings.setEnabled(false);
  const off = await call(base, 'GET', '/list');
  assert.deepEqual([off.status, off.body.error], [403, 'OSS_AGENT_ACCESS_OFF']);
  const offPut = await call(base, 'PUT', '/object', { query: { key: 'shared/x' }, body: Buffer.alloc(1024) });
  assert.deepEqual([offPut.status, offPut.body.error], [403, 'OSS_AGENT_ACCESS_OFF']);
  remote.settings.setEnabled(true);
  // This engine's own switch is checked first.
  local.settings.setEnabled(false);
  assert.equal((await call(base, 'GET', '/list')).body.error, 'OSS_AGENT_ACCESS_OFF');
  local.settings.setEnabled(true);
  assert.ok(asked > 0);

  // A token the provider refuses is the link failing.
  peer.token = 'wrong';
  const refused = await call(base, 'GET', '/list');
  assert.deepEqual([refused.status, refused.body.error], [502, 'LINKED_PROVIDER_UNAUTHORIZED']);
  peer.token = 'link-token';

  // An own bucket wins: the provider is not asked.
  local.images.saveConfig(OWNER, CONFIG);
  const before = asked;
  assert.equal((await call(base, 'GET', '/list')).status, 200);
  assert.equal(asked, before);
  assert.ok(local.fake.calls.some(entry => entry[0] === 'list'));
});

test('linked provider: one without oss:files is 501 OSS_FILES_UNSUPPORTED, an unreachable one 502, an offline tunnel 502', async () => {
  const oldBase = await providerApp(engine(), { capabilities: ['peer-fs:read'], ossRoutes: false });
  const local = engine({ configured: false });
  const base = await relayApp(local, { linked: { providerFor: async () => ({ id: 'old', name: 'Old', baseUrl: oldBase, token: 'link-token' }) } });
  const old = await call(base, 'GET', '/list');
  assert.deepEqual([old.status, old.body.error, old.body.provider], [501, 'OSS_FILES_UNSUPPORTED', 'Old']);
  assert.equal((await call(base, 'PUT', '/object', { query: { key: 'a' }, body: Buffer.from('abc') })).status, 501);

  const offline = await relayApp(engine({ configured: false }), { linked: { providerFor: async () => ({ id: 'gone', name: 'Gone', baseUrl: 'http://127.0.0.1:1', token: 't' }) } });
  assert.deepEqual((await call(offline, 'GET', '/list')).body.error, 'LINKED_PROVIDER_OFFLINE');

  // No provider at all: this engine's own answer.
  const alone = await relayApp(engine({ configured: false }), { linked: { providerFor: async () => null } });
  assert.equal((await call(alone, 'GET', '/list')).body.error, 'OSS_NOT_CONFIGURED');

  // A provider behind a service link tunnel that is not up: offline before anything is sent.
  const tunnelPeer = { id: 'tun', name: 'Tunnel', baseUrl: 'tunnel://00000000-0000-4000-8000-000000000000', token: 'link-token' };
  const tunnel = await relayApp(engine({ configured: false }), {
    linked: { providerFor: async () => tunnelPeer },
    request: async (baseUrl, route) => { assert.equal(route, '/v1/info'); return { capabilities: [CAPABILITY] }; },
  });
  const offlinePut = await raw(tunnel, 'PUT', '/api/tcli/oss/object?key=big.bin', { ...hookHeaders(), 'Content-Length': '3' }, req => { req.end('abc'); });
  assert.deepEqual([offlinePut.status, offlinePut.body.error, offlinePut.body.provider], [502, 'LINKED_PROVIDER_OFFLINE', 'Tunnel']);
});

// A real service link tunnel on the shared hub, as server.js runs it: the provider app is B's local server behind startTunnelClient.
async function tunnelTo(providerBase, client = {}) {
  const linkId = crypto.randomUUID();
  const wss = new WebSocket.WebSocketServer({ noServer: true, ...TUNNEL_WS_OPTIONS });
  const server = http.createServer((req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => getHub().accept(linkId, ws)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const tunnel = startTunnelClient({
    url: `http://127.0.0.1:${server.address().port}`, token: 'tunnel-token', linkId, localPort: Number(new URL(providerBase).port), ...client,
  });
  test.after(() => { tunnel.stop(); getHub().drop(linkId); for (const ws of wss.clients) ws.terminate(); server.closeAllConnections(); server.close(); });
  const deadline = Date.now() + 5000;
  while (!getHub().isOnline(linkId)) {
    if (Date.now() > deadline) throw new Error('the tunnel did not come up');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return { linkId, base: tunnelBase(linkId) };
}

const until = async (check, what) => {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

test('linked provider through a real service link tunnel: an upload over the old 64 MiB streams, comes back as a download, and an abort leaves nothing', async () => {
  const remote = engine();
  const providerBase = await providerApp(remote);
  const link = await tunnelTo(providerBase);
  const peer = { id: 'tun', name: 'Studio', baseUrl: link.base, token: 'link-token' };
  const base = await relayApp(engine({ configured: false }), { linked: { providerFor: async () => peer } });

  // Larger than the old limit of the tunnel; the size reaches the provider as ?size= (the tunnel drops Content-Length).
  const body = Buffer.alloc(LEGACY_REQUEST_BODY_BYTES + 3 * 1024 * 1024 + 5);
  crypto.randomFillSync(body, 0, 1024 * 1024);
  crypto.randomFillSync(body, body.length - 1024 * 1024);
  const put = await call(base, 'PUT', '/object', { query: { key: 'big/one.bin' }, body, headers: { ...hookHeaders(), 'Content-Type': 'application/zip' } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.size, body.length);
  assert.ok(remote.fake.objects.get('big/one.bin').body.equals(body));
  const got = await call(base, 'GET', '/object', { query: { key: 'big/one.bin' } });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-length'), String(body.length));
  assert.ok(got.body.equals(body), 'the download through the tunnel is the same bytes');
  assert.equal(getHub().streamCount(link.linkId), 0);

  // The terminal goes away half way: the provider never stores a half object, the stream is released, the tunnel keeps working.
  const announced = 32 * 1024 * 1024;
  await new Promise(resolve => {
    const req = http.request(new URL('/api/tcli/oss/object?key=big/half.bin', base), { method: 'PUT', headers: { ...hookHeaders(), 'Content-Length': String(announced) } });
    req.on('error', () => {});
    req.on('close', resolve);
    const chunk = Buffer.alloc(1024 * 1024, 7);
    let sent = 0;
    const more = () => {
      while (sent < 8 * 1024 * 1024) {
        sent += chunk.length;
        if (!req.write(chunk)) { req.once('drain', more); return; }
      }
      setTimeout(() => req.destroy(), 200);
    };
    more();
  });
  await until(() => getHub().streamCount(link.linkId) === 0, 'the tunnel stream to be released');
  await until(() => remote.fake.calls.filter(entry => entry[0] === 'putStream' && entry[1] === 'big/half.bin').length === 1, 'the provider to start the upload');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(remote.fake.objects.has('big/half.bin'), false, 'no half object');
  const list = await call(base, 'GET', '/list', { query: { prefix: 'big/' } });
  assert.deepEqual(list.body.objects.map(object => object.key), ['big/one.bin']);
});

test('linked provider through the tunnel of an older service: uploads over its 64 MiB are refused before anything is sent', async () => {
  const remote = engine();
  const providerBase = await providerApp(remote);
  // An older tunnel client takes 64 MiB; one that announces it is the same to this side.
  const link = await tunnelTo(providerBase, { maxRequestBodyBytes: LEGACY_REQUEST_BODY_BYTES });
  assert.equal(getHub().requestBodyLimit(link.linkId), LEGACY_REQUEST_BODY_BYTES);
  const peer = { id: 'old-tun', name: 'Older', baseUrl: link.base, token: 'link-token' };
  const base = await relayApp(engine({ configured: false }), { linked: { providerFor: async () => peer } });
  const tooBig = await raw(base, 'PUT', '/api/tcli/oss/object?key=big.bin', { ...hookHeaders(), 'Content-Length': String(LEGACY_REQUEST_BODY_BYTES + 1) }, req => { req.write('abc'); });
  assert.deepEqual([tooBig.status, tooBig.body.error, tooBig.body.provider], [413, 'TOO_LARGE', 'Older']);
  assert.match(tooBig.body.message, /at most 64 MiB per object; update T-Agent there/);
  assert.equal(remote.fake.calls.some(entry => entry[0] === 'putStream'), false, 'nothing was sent');
  // Within the limit it works as before.
  const small = Buffer.from('small file');
  assert.equal((await call(base, 'PUT', '/object', { query: { key: 'small.txt' }, body: small })).status, 200);
  assert.deepEqual(remote.fake.objects.get('small.txt').body, small);
});

test('engine routes /v1/oss/files: the provider\'s size comes from ?size= when the tunnel dropped Content-Length', async () => {
  const remote = engine();
  const providerBase = await providerApp(remote);
  const answer = await raw(providerBase, 'PUT', '/v1/oss/files/object?key=t.bin&size=6', { Authorization: 'Bearer link-token', 'Transfer-Encoding': 'chunked', 'Content-Type': 'text/plain' }, req => { req.write('abc'); req.write('def'); req.end(); });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.size, 6);
  assert.equal(remote.fake.objects.get('t.bin').body.toString(), 'abcdef');
  const short = await raw(providerBase, 'PUT', '/v1/oss/files/object?key=s.bin&size=6', { Authorization: 'Bearer link-token', 'Transfer-Encoding': 'chunked' }, req => { req.write('abc'); req.end(); });
  assert.equal(short.body.error, 'INCOMPLETE_BODY');
  const disagree = await raw(providerBase, 'PUT', '/v1/oss/files/object?key=d.bin&size=9', { Authorization: 'Bearer link-token', 'Content-Length': '3' }, req => { req.end('abc'); });
  assert.equal(disagree.body.error, 'INVALID_ARGUMENT');
  assert.equal((await fetch(`${providerBase}/v1/oss/files/list`)).status, 401, 'the token is checked first');
});

test('settings: GET / PUT /api/oss/agent-access behind the browser login', async () => {
  const local = engine();
  const app = express();
  app.use(express.json());
  app.use('/api/oss', createOssRouter({
    service: local.images, agentAccess: () => local.settings,
    requireAuth(req, res, next) {
      if (req.get('Authorization') !== 'test-session') return res.status(401).json({ error: 'AUTH_REQUIRED' });
      req.session = { user: { login: OWNER } };
      next();
    },
  }));
  const base = await listen(app);
  const headers = { Authorization: 'test-session', 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/api/oss/agent-access`)).status, 401);
  assert.equal((await fetch(`${base}/api/oss/agent-access`, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.deepEqual(await (await fetch(`${base}/api/oss/agent-access`, { headers })).json(), { enabled: true }, 'on by default');
  assert.deepEqual(await (await fetch(`${base}/api/oss/agent-access`, { method: 'PUT', headers, body: JSON.stringify({ enabled: false }) })).json(), { enabled: false });
  assert.equal(local.settings.enabled(), false);
  assert.deepEqual(await (await fetch(`${base}/api/oss/agent-access`, { headers })).json(), { enabled: false });
  const bad = await fetch(`${base}/api/oss/agent-access`, { method: 'PUT', headers, body: JSON.stringify({ enabled: 'no' }) });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'VALIDATION_FAILED');
});
