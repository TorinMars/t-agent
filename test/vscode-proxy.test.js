'use strict';
// VS Code in the browser, the page server's part (services/vscode-proxy.js, routes/vscode-web.js). Everything runs on loopback in this process: a fake
// VS Code origin, a fake engine that implements Contract B in front of it, a real service link tunnel to that engine, and the in-process transport
// with a fake manager. No VS Code, no network, no download.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const express = require('express');
const WebSocket = require('ws');

process.env.T_AGENT_DATA_DIR = process.env.T_AGENT_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-proxy-test-'));
delete process.env.TAGENT_HOME;

const { TUNNEL_WS_OPTIONS, tunnelBase, createHub, startTunnelClient } = require('../lib/service-link-tunnel');
const { createVscodeProxy, parseBrowserTarget, rewriteLocation, createLimiter, publicOrigin } = require('../services/vscode-proxy');
const localTransport = require('../services/vscode-local-transport');
const { createVscodeWebRouter, handleVscodeUpgrade } = require('../routes/vscode-web');
const { sendNotFound } = require('../lib/login-gate');
const { closeWebSocket } = require('../lib/websocket-close');

const ENGINE_TOKEN = 'tae_fake-engine-token';
const LINK_TOKEN = 'link-token';
const LOCAL = 'local-engine';
const DIRECT = 'direct-engine';
const TUNNEL = 'tunnel-engine';
const TARGETS = { [LOCAL]: { kind: 'local' }, [DIRECT]: { kind: 'remote', serverId: 1 }, [TUNNEL]: { kind: 'remote', serverId: 2 } };
const BIG = 33 * 1024 * 1024;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, message = 'condition', timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const closeServer = server => (server.listening ? new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) : Promise.resolve());

// Joins two WebSockets, close codes included.
function join(a, b) {
  a.on('message', (data, binary) => { if (b.readyState === WebSocket.OPEN) b.send(data, { binary }); });
  b.on('message', (data, binary) => { if (a.readyState === WebSocket.OPEN) a.send(data, { binary }); });
  a.on('close', (code, reason) => closeWebSocket(b, code, reason));
  b.on('close', (code, reason) => closeWebSocket(a, code, reason));
  a.on('error', () => b.terminate());
  b.on('error', () => a.terminate());
}

// What VS Code serves under --server-base-path /vscode/<id>: the workbench, static files, a redirect with its token, a slow answer, an upload and a
// WebSocket echo ("big" makes it send a message over the tunnel's limit).
async function startVscodeOrigin() {
  const seen = [];
  const wss = new WebSocket.WebSocketServer({ noServer: true });
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    const match = /^\/vscode\/([A-Za-z0-9-]+)(\/[^?]*)(\?.*)?$/.exec(req.url);
    if (!match) { res.writeHead(404); res.end('no'); return; }
    const [, id, rest] = match;
    if (rest === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'vscode-tkn=secret', 'x-internal': '1', 'service-worker-allowed': '/' });
      res.end(`<html>workbench ${'x'.repeat(4000)}</html>`);
      return;
    }
    if (rest.startsWith('/static/')) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(`// ${decodeURIComponent(rest)}`); return; }
    if (rest === '/redirect') { res.writeHead(302, { location: `http://127.0.0.1:9/vscode/${id}/target?x=1&tkn=secret` }); res.end(); return; }
    if (rest === '/relative') { res.writeHead(302, { location: 'target?y=2' }); res.end(); return; }
    if (rest === '/away') { res.writeHead(302, { location: 'https://evil.example/x' }); res.end(); return; }
    if (rest === '/slow') {
      const ms = Number(new URL(req.url, 'http://x').searchParams.get('ms') || 300);
      const timer = setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('slow'); }, ms);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (rest === '/upload' && req.method === 'POST') {
      let bytes = 0;
      req.on('data', chunk => { bytes += chunk.length; });
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ bytes, type: req.headers['content-type'] })); });
      return;
    }
    res.writeHead(404);
    res.end('missing');
  });
  server.on('upgrade', (req, socket, head) => {
    seen.push({ upgrade: true, url: req.url, headers: req.headers });
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('message', (data, binary) => {
        if (!binary && data.toString() === 'big') { ws.send(Buffer.alloc(BIG, 1)); return; }
        ws.send(data, { binary });
      });
    });
  });
  const port = await listen(server);
  return { port, seen, server, wss };
}

// The engine's Contract B in its smallest form: Bearer token, `/v1/vscode/web/<hostB64><browser path>` to the origin with X-Forwarded-Host, and a
// terminal-like echo socket for the starvation test.
async function startFakeEngine(originPort) {
  const seen = [];
  const prefix = /^\/v1\/vscode\/web\/([A-Za-z0-9_-]+)(\/.*)$/;
  const wss = new WebSocket.WebSocketServer({ noServer: true });
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    const match = prefix.exec(req.url);
    if (!match || req.headers.authorization !== `Bearer ${ENGINE_TOKEN}`) { res.writeHead(401); res.end(); return; }
    const host = Buffer.from(match[1], 'base64url').toString();
    const headers = { 'x-forwarded-host': host };
    for (const name of ['content-type', 'accept', 'range', 'if-none-match', 'content-length', 'transfer-encoding']) if (req.headers[name]) headers[name] = req.headers[name];
    const upstream = http.request({ host: '127.0.0.1', port: originPort, method: req.method, path: match[2], headers }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    seen.push({ upgrade: true, url: req.url, headers: req.headers });
    if (req.url.startsWith('/v1/terminal-sessions/')) {
      wss.handleUpgrade(req, socket, head, ws => ws.on('message', (data, binary) => ws.send(data, { binary })));
      return;
    }
    const match = prefix.exec(req.url);
    if (!match || req.headers.authorization !== `Bearer ${ENGINE_TOKEN}`) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    const upstream = new WebSocket(`ws://127.0.0.1:${originPort}${match[2]}`);
    upstream.on('open', () => wss.handleUpgrade(req, socket, head, ws => join(ws, upstream)));
    upstream.on('error', () => socket.destroy());
  });
  const port = await listen(server);
  return { port, seen, server, wss };
}

// The fake VS Code manager behind services/vscode-local-transport.js: an in-process call that reaches the origin directly.
function fakeManager(originPort) {
  const calls = [];
  return {
    calls,
    start: async args => { calls.push({ start: args }); return { state: 'ready', engine_id: LOCAL, base_path: `/vscode/${LOCAL}`, open_path: `/vscode/${LOCAL}/?folder=%2Ftmp`, folder: '/tmp' }; },
    status: async () => ({ state: 'ready', engine_id: LOCAL, open_path: `/vscode/${LOCAL}/?folder=%2Ftmp` }),
    acceptLicense: async () => ({ accepted: true }),
    request({ method, path: target, headers, body, host, proto, signal }) {
      calls.push({ method, path: target, headers, host, proto });
      return new Promise((resolve, reject) => {
        const upstream = http.request({ host: '127.0.0.1', port: originPort, method, path: target, headers, signal }, res => resolve({ status: res.statusCode, headers: res.headers, body: res }));
        upstream.on('error', reject);
        if (body) body.pipe(upstream); else upstream.end();
      });
    },
    openWebSocket({ path: target, host }) {
      calls.push({ ws: target, host });
      return new WebSocket(`ws://127.0.0.1:${originPort}${target}`);
    },
  };
}

// Service A's side of a link (the acceptor) and B's tunnel client in front of the fake engine.
async function startTunnel(hub, enginePort) {
  const linkId = crypto.randomUUID();
  const wss = new WebSocket.WebSocketServer({ noServer: true, ...TUNNEL_WS_OPTIONS });
  const server = http.createServer((req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.authorization !== `Bearer ${LINK_TOKEN}`) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => hub.accept(linkId, ws));
  });
  const port = await listen(server);
  const client = startTunnelClient({ url: `http://127.0.0.1:${port}`, token: LINK_TOKEN, linkId, localPort: enginePort });
  await until(() => hub.isOnline(linkId), 'the tunnel to come online');
  return { linkId, server, wss, client };
}

async function startPage(proxy) {
  const app = express();
  app.set('trust proxy', 1);
  app.use('/vscode', createVscodeWebRouter({ proxy: () => proxy }));
  // Stands for /api behind its own gate: the VS Code cookie is never one of its credentials.
  app.get('/api/ping', (req, res) => (req.headers['x-test-login'] === 'yes' ? res.json({ ok: true }) : sendNotFound(req, res)));
  app.use((req, res) => sendNotFound(req, res));
  const wss = new WebSocket.WebSocketServer({ noServer: true });
  const server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => {
    if (!handleVscodeUpgrade(req, socket, head, wss, { proxy: () => proxy })) socket.destroy();
  });
  const port = await listen(server);
  return { port, server, wss };
}

const env = {};
test.before(async () => {
  env.origin = await startVscodeOrigin();
  env.engine = await startFakeEngine(env.origin.port);
  env.hub = createHub();
  env.tunnel = await startTunnel(env.hub, env.engine.port);
  env.manager = fakeManager(env.origin.port);
  localTransport.setManagerForTests(env.manager);
  env.active = new Set(['sid-1', 'sid-2']);
  env.clock = 0;
  env.servers = {
    1: { baseUrl: `http://127.0.0.1:${env.engine.port}`, token: ENGINE_TOKEN },
    2: { baseUrl: tunnelBase(env.tunnel.linkId), token: ENGINE_TOKEN },
  };
  env.proxy = createVscodeProxy({
    hub: env.hub,
    sessionActive: sid => env.active.has(sid),
    sessionExpiry: () => Date.UTC(2030, 0, 1),
    resolveRemote: (serverId, owner) => (owner === 'owner' ? env.servers[serverId] || null : null),
    now: () => Date.now() + env.clock,
    sweepMs: 0,
    sessionCheckMs: 0,
  });
  env.page = await startPage(env.proxy);
});

test.after(async () => {
  localTransport.setManagerForTests(null);
  env.proxy.stop();
  env.tunnel.client.stop();
  for (const part of [env.page, env.engine, env.origin, env.tunnel]) {
    for (const ws of part.wss.clients) ws.terminate();
    await closeServer(part.server);
  }
});

function call(pathname, { method = 'GET', headers = {}, body = null, port = env.page.port, agent } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers, agent }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function readyAnswer(engineId) {
  return { state: 'ready', engine_id: engineId, base_path: `/vscode/${engineId}`, open_path: `/vscode/${engineId}/?folder=%2Ftmp%2Fproj`, folder: '/tmp/proj' };
}

async function launch(engineId, { sid = 'sid-1', headers = {} } = {}) {
  const answer = env.proxy.launchAnswer(readyAnswer(engineId), { sessionId: sid, owner: 'owner', target: TARGETS[engineId] });
  const first = await call(answer.open_url, { headers });
  assert.equal(first.status, 302, `${engineId}: the ticket is exchanged`);
  const setCookie = first.headers['set-cookie'][0];
  return { answer, first, setCookie, cookie: setCookie.split(';')[0] };
}

function openBrowserSocket(pathname, { cookie, origin = `http://127.0.0.1:${env.page.port}` } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  const ws = new WebSocket(`ws://127.0.0.1:${env.page.port}${pathname}`, { headers, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  ws.closedWith = new Promise(resolve => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  ws.refused = new Promise(resolve => ws.on('unexpected-response', (req, res) => { res.resume(); resolve(res.statusCode); }));
  ws.on('error', () => {});
  return ws;
}

const nextMessage = ws => new Promise(resolve => ws.once('message', (data, binary) => resolve({ data, binary })));

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

test('browser paths are re-encoded segment by segment, and dangerous segments are refused', () => {
  const ok = parseBrowserTarget('/vscode/eng-1/static/node_modules/@vscode/a b.js?folder=%2Ftmp&x=1');
  assert.equal(ok.path, '/vscode/eng-1/static/node_modules/%40vscode/a%20b.js');
  assert.equal(ok.query, '?folder=%2Ftmp&x=1');
  assert.equal(ok.launch, null);
  assert.equal(parseBrowserTarget('/vscode/eng-1/').path, '/vscode/eng-1/');
  const launchTarget = parseBrowserTarget('/vscode/eng-1/?folder=%2Fa&ta_launch=tvl_abc');
  assert.equal(launchTarget.launch, 'tvl_abc');
  assert.equal(launchTarget.query, '?folder=%2Fa');
  for (const bad of ['/vscode/eng-1', '/vscode/', '/vscode/eng_1/', '/VSCODE/eng-1/', '/vscode/eng-1/../api/x', '/vscode/eng-1/a/./b', '/vscode/eng-1/%2e%2e/x', '/vscode/eng-1/a%2fb',
    '/vscode/eng-1/a%2Fb', '/vscode/eng-1/a%5cb', '/vscode/eng-1/a%25b', '/vscode/eng-1/a%00b', '/vscode/eng-1/a//b', '/vscode/eng-1/%zz', '/vscode/eng-1/a\\b', '/api/vscode/eng-1/',
    `/vscode/${'a'.repeat(65)}/`]) {
    assert.equal(parseBrowserTarget(bad), null, bad);
  }
});

test('redirects stay on this origin under the engine base, without VS Code\'s token', () => {
  const target = parseBrowserTarget('/vscode/eng-1/a/b');
  assert.equal(rewriteLocation('http://127.0.0.1:8000/vscode/eng-1/x?y=1&tkn=secret#h', target), '/vscode/eng-1/x?y=1#h');
  assert.equal(rewriteLocation('https://t.example.com/vscode/eng-1/', target), '/vscode/eng-1/');
  assert.equal(rewriteLocation('c?d=1', target), '/vscode/eng-1/a/c?d=1');
  assert.equal(rewriteLocation('/vscode/eng-2/x', target), null);
  assert.equal(rewriteLocation('https://evil.example/x', target), null);
  assert.equal(rewriteLocation('//evil.example/vscode/eng-1x', target), null);
});

test('the public origin follows the forwarded headers of one proxy hop and refuses odd hosts', () => {
  assert.deepEqual(publicOrigin({ headers: { host: '127.0.0.1:3000' }, socket: {} }), { host: '127.0.0.1:3000', proto: 'http' });
  assert.deepEqual(publicOrigin({ headers: { host: 'a', 'x-forwarded-host': 't.example.com, b', 'x-forwarded-proto': 'https' }, socket: {} }), { host: 't.example.com', proto: 'https' });
  assert.equal(publicOrigin({ headers: { host: 'evil.example/x' }, socket: {} }), null);
});

test('the limiter runs at most its size at once and lets waiting jobs leave', async () => {
  const limiter = createLimiter(2);
  const started = [];
  const releases = [1, 2, 3, 4].map(n => limiter.enqueue(() => started.push(n)));
  await delay(1);
  assert.deepEqual(started, [1, 2]);
  releases[2](); // leaves the queue before it started
  releases[0]();
  await delay(1);
  assert.deepEqual(started, [1, 2, 4]);
  assert.equal(limiter.active, 2);
});

test('a launch answer gets open_url only when ready and only for a path under the engine base', () => {
  const proxy = createVscodeProxy({ sessionActive: () => true, sweepMs: 0 });
  const ready = proxy.launchAnswer(readyAnswer('eng-1'), { sessionId: 's', owner: 'o', target: { kind: 'local' } });
  assert.match(ready.open_url, /^\/vscode\/eng-1\/\?folder=%2Ftmp%2Fproj&ta_launch=tvl_[A-Za-z0-9_-]{32}$/);
  assert.equal(proxy.launchAnswer({ ...readyAnswer('eng-1'), state: 'starting' }, { sessionId: 's', owner: 'o', target: { kind: 'local' } }).open_url, undefined);
  assert.equal(proxy.launchAnswer({ ...readyAnswer('eng-1'), open_path: '//evil.example/vscode/eng-1/' }, { sessionId: 's', owner: 'o', target: { kind: 'local' } }).open_url, undefined);
  assert.equal(proxy.launchAnswer({ ...readyAnswer('eng-1'), engine_id: '../x' }, { sessionId: 's', owner: 'o', target: { kind: 'local' } }).open_url, undefined);
  assert.equal(proxy.launchAnswer({ ...readyAnswer('eng-1'), open_url: 'http://evil.example/', state: 'error' }, { sessionId: 's', owner: 'o', target: { kind: 'local' } }).open_url, undefined);
  assert.equal(proxy.stats().tickets, 1);
  proxy.stop();
});

// ---------------------------------------------------------------------------
// All three transports
// ---------------------------------------------------------------------------

for (const engineId of [LOCAL, DIRECT, TUNNEL]) {
  test(`${engineId}: launch, cookie scope, workbench, @ in a path, a rewritten redirect, an upload and a WebSocket`, async () => {
    const { first, setCookie, cookie } = await launch(engineId);
    // The redirect removes the ticket and keeps the folder.
    assert.equal(first.headers.location, `/vscode/${engineId}/?folder=%2Ftmp%2Fproj`);
    assert.equal(first.headers['cache-control'], 'no-store');
    const attributes = setCookie.split(';').map(part => part.trim());
    assert.match(attributes[0], /^ta_vscode=tvc_[A-Za-z0-9_-]{32}$/);
    assert.ok(attributes.includes(`Path=/vscode/${engineId}/`), setCookie);
    assert.ok(attributes.includes('HttpOnly'));
    assert.ok(attributes.includes('SameSite=Lax'));
    assert.ok(attributes.some(part => part.startsWith('Expires=')), 'it expires with the session');
    assert.ok(!attributes.includes('Secure'), 'no Secure on plain HTTP');

    const page = await call(first.headers.location, { headers: { cookie, 'accept-encoding': 'gzip', origin: 'http://evil.example', referer: 'http://evil.example/', 'x-custom': '1', 'user-agent': 'browser', 'x-requested-with': 'XMLHttpRequest' } });
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-encoding'], 'gzip', 'text answers are compressed for the browser');
    assert.match(zlib.gunzipSync(page.body).toString(), /^<html>workbench/);
    assert.equal(page.headers['set-cookie'], undefined, 'VS Code\'s own cookie never reaches the browser');
    assert.equal(page.headers['x-internal'], undefined);
    assert.equal(page.headers['service-worker-allowed'], undefined);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');

    // What reached the engine (or the manager): the allowlist only, never the browser's cookie, origin or x-* headers, and no accept-encoding.
    const sent = engineId === LOCAL ? env.manager.calls.filter(entry => entry.method).at(-1).headers : env.engine.seen.filter(entry => !entry.upgrade).at(-1).headers;
    for (const name of Object.keys(sent)) assert.ok(['authorization', 'accept', 'content-type', 'content-length', 'range', 'if-none-match', 'host', 'connection'].includes(name), `${engineId} got ${name}`);
    if (engineId !== LOCAL) {
      const seen = env.engine.seen.filter(entry => !entry.upgrade).at(-1);
      assert.equal(seen.headers.authorization, `Bearer ${ENGINE_TOKEN}`);
      assert.equal(seen.url, `/v1/vscode/web/${Buffer.from(`127.0.0.1:${env.page.port}`).toString('base64url')}/vscode/${engineId}/?folder=%2Ftmp%2Fproj`);
    } else {
      const last = env.manager.calls.filter(entry => entry.method).at(-1);
      assert.deepEqual([last.path, last.host, last.proto], [`/vscode/${LOCAL}/?folder=%2Ftmp%2Fproj`, `127.0.0.1:${env.page.port}`, 'http']);
    }

    const at = await call(`/vscode/${engineId}/static/node_modules/@vscode/codicons/codicon.js`, { headers: { cookie } });
    assert.equal(at.status, 200);
    assert.equal(at.body.toString(), `// /static/node_modules/@vscode/codicons/codicon.js`);
    assert.equal(env.origin.seen.at(-1).url, `/vscode/${engineId}/static/node_modules/%40vscode/codicons/codicon.js`);

    // `location` crosses every transport (the tunnel's allowlist has it) and comes back as a path under the base, without the token.
    const redirect = await call(`/vscode/${engineId}/redirect`, { headers: { cookie } });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.location, `/vscode/${engineId}/target?x=1`);
    assert.equal((await call(`/vscode/${engineId}/relative`, { headers: { cookie } })).headers.location, `/vscode/${engineId}/target?y=2`);
    const away = await call(`/vscode/${engineId}/away`, { headers: { cookie } });
    assert.equal(away.status, 302);
    assert.equal(away.headers.location, undefined, 'a redirect off the base is dropped');

    const upload = await call(`/vscode/${engineId}/upload`, { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream', 'content-length': String(200_000) }, body: Buffer.alloc(200_000, 7) });
    assert.deepEqual(JSON.parse(upload.body.toString()), { bytes: 200_000, type: 'application/octet-stream' });

    const ws = openBrowserSocket(`/vscode/${engineId}/ws?reconnection=false`, { cookie });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.refused.then(status => reject(new Error(`refused ${status}`))); });
    ws.send('hello');
    assert.equal((await nextMessage(ws)).data.toString(), 'hello');
    ws.send(Buffer.from([1, 2, 3]), { binary: true });
    const binary = await nextMessage(ws);
    assert.equal(binary.binary, true);
    assert.deepEqual([...binary.data], [1, 2, 3]);
    if (engineId !== LOCAL) {
      const upgrade = env.engine.seen.filter(entry => entry.upgrade && entry.url.includes('/vscode/web/')).at(-1);
      assert.equal(upgrade.headers.authorization, `Bearer ${ENGINE_TOKEN}`);
      assert.equal(upgrade.headers.cookie, undefined);
      assert.equal(upgrade.headers.origin, undefined);
    }
    ws.close(1000);
    assert.equal((await ws.closedWith).code, 1000);
  });
}

test('Secure is set on the cookie when the browser came over HTTPS', async () => {
  const { setCookie } = await launch(DIRECT, { headers: { 'x-forwarded-proto': 'https' } });
  assert.ok(setCookie.split(';').map(part => part.trim()).includes('Secure'), setCookie);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test('a .. or encoded separator segment is refused before any engine sees it', async () => {
  const { cookie } = await launch(DIRECT);
  const before = env.engine.seen.length;
  for (const bad of [`/vscode/${DIRECT}/../${DIRECT}/x`, `/vscode/${DIRECT}/a/%2e%2e/b`, `/vscode/${DIRECT}/a%2fb`, `/vscode/${DIRECT}/a%5cb`, `/vscode/${DIRECT}/a//b`, `/vscode/${DIRECT}/%252e`]) {
    const answer = await call(bad, { headers: { cookie } });
    assert.equal(answer.status, 404, bad);
  }
  assert.equal(env.engine.seen.length, before);
});

test('missing, wrong or logged-out cookies get the same 404 as an unknown address', async () => {
  const { cookie } = await launch(DIRECT, { sid: 'sid-2' });
  const target = `/vscode/${DIRECT}/`;
  const ok = await call(target, { headers: { cookie } });
  assert.equal(ok.status, 200);
  const strip = answer => ({ status: answer.status, body: answer.body.toString().replace(/Cannot GET \S+/, 'Cannot GET <path>'), headers: Object.fromEntries(Object.entries(answer.headers).filter(([name]) => !['date', 'connection', 'keep-alive', 'content-length', 'etag'].includes(name))) });
  const unknown = strip(await call('/somewhere/unknown'));
  assert.equal(unknown.status, 404);
  const answers = [
    await call(target),
    await call(target, { headers: { cookie: 'ta_vscode=tvc_made-up' } }),
    await call(`/vscode/${TUNNEL}/`, { headers: { cookie } }), // a cookie of another engine
    await call('/vscode/no-such-engine/'),
  ];
  env.active.delete('sid-2');
  answers.push(await call(target, { headers: { cookie } }));
  // The cookie of a session that ended is forgotten for good.
  env.active.add('sid-2');
  answers.push(await call(target, { headers: { cookie } }));
  for (const answer of answers) assert.deepEqual(strip(answer), unknown);
  assert.match(answers[0].body.toString(), new RegExp(`Cannot GET ${target}`));
});

test('a ticket works once, for its engine only, and not after 30 s', async () => {
  const answer = env.proxy.launchAnswer(readyAnswer(DIRECT), { sessionId: 'sid-1', owner: 'owner', target: TARGETS[DIRECT] });
  assert.equal((await call(answer.open_url)).status, 302);
  assert.equal((await call(answer.open_url)).status, 404, 'reuse is refused');

  const other = env.proxy.launchAnswer(readyAnswer(DIRECT), { sessionId: 'sid-1', owner: 'owner', target: TARGETS[DIRECT] });
  assert.equal((await call(other.open_url.replace(`/vscode/${DIRECT}/`, `/vscode/${TUNNEL}/`))).status, 404, 'a ticket is bound to its engine');
  assert.equal((await call(other.open_url)).status, 404, 'and the failed try used it up');

  const late = env.proxy.launchAnswer(readyAnswer(DIRECT), { sessionId: 'sid-1', owner: 'owner', target: TARGETS[DIRECT] });
  env.clock = 31_000;
  try { assert.equal((await call(late.open_url)).status, 404, 'expired'); } finally { env.clock = 0; }

  const loggedOut = env.proxy.launchAnswer(readyAnswer(DIRECT), { sessionId: 'sid-gone', owner: 'owner', target: TARGETS[DIRECT] });
  assert.equal((await call(loggedOut.open_url)).status, 404, 'a ticket of a session that ended');

  const posted = env.proxy.launchAnswer(readyAnswer(DIRECT), { sessionId: 'sid-1', owner: 'owner', target: TARGETS[DIRECT] });
  assert.equal((await call(posted.open_url, { method: 'POST' })).status, 404, 'only a page visit exchanges a ticket');
});

test('the VS Code cookie opens nothing under /api, and /api works as before', async () => {
  const { cookie } = await launch(DIRECT);
  assert.equal((await call('/api/ping', { headers: { cookie } })).status, 404);
  const ping = await call('/api/ping', { headers: { 'x-test-login': 'yes' } });
  assert.equal(ping.status, 200);
  assert.deepEqual(JSON.parse(ping.body.toString()), { ok: true });
});

test('a WebSocket needs the same-origin Origin header and the cookie', async () => {
  const { cookie } = await launch(DIRECT);
  assert.equal(await openBrowserSocket(`/vscode/${DIRECT}/ws`, { cookie, origin: null }).refused, 403);
  assert.equal(await openBrowserSocket(`/vscode/${DIRECT}/ws`, { cookie, origin: 'http://evil.example' }).refused, 403);
  assert.equal(await openBrowserSocket(`/vscode/${DIRECT}/ws`, {}).refused, 404);
  assert.equal(await openBrowserSocket(`/vscode/${DIRECT}/../x/ws`, { cookie }).refused, 404);
});

// ---------------------------------------------------------------------------
// Session end, limits and timeouts
// ---------------------------------------------------------------------------

test('logout closes an open VS Code WebSocket and refuses the cookie afterwards', async () => {
  env.active.add('sid-logout');
  const { cookie } = await launch(DIRECT, { sid: 'sid-logout' });
  const ws = openBrowserSocket(`/vscode/${DIRECT}/ws`, { cookie });
  await new Promise(resolve => ws.once('open', resolve));
  // What server.js does on POST /auth/logout (app.locals.disconnectClientSession) and in its 30 s check (clientSessionId).
  const downstream = [...env.page.wss.clients].find(client => client.clientSessionId === 'sid-logout');
  assert.ok(downstream, 'the browser side carries the session id');
  env.active.delete('sid-logout');
  env.proxy.forgetSession('sid-logout');
  assert.equal((await ws.closedWith).code, 1008);
  assert.equal((await call(`/vscode/${DIRECT}/`, { headers: { cookie } })).status, 404);

  env.active.add('sid-sweep');
  const second = await launch(TUNNEL, { sid: 'sid-sweep' });
  const other = openBrowserSocket(`/vscode/${TUNNEL}/ws`, { cookie: second.cookie });
  await new Promise(resolve => other.once('open', resolve));
  env.active.delete('sid-sweep');
  env.proxy.sweep(); // an expired session, or one signed out elsewhere, is found by the periodic sweep
  assert.equal((await other.closedWith).code, 1008);
});

test('over the tunnel a WebSocket message above 32 MiB closes with 1009, in both directions', async () => {
  const { cookie } = await launch(TUNNEL);
  const ws = openBrowserSocket(`/vscode/${TUNNEL}/ws`, { cookie });
  await new Promise(resolve => ws.once('open', resolve));
  ws.send(Buffer.alloc(BIG, 2));
  assert.equal((await ws.closedWith).code, 1009, 'from the browser');

  const back = openBrowserSocket(`/vscode/${TUNNEL}/ws`, { cookie });
  await new Promise(resolve => back.once('open', resolve));
  back.send('big');
  assert.equal((await back.closedWith).code, 1009, 'from the engine');
  await until(() => env.hub.streamCount(env.tunnel.linkId) === 0, 'the streams to be released');
});

test('200 parallel GETs over the tunnel wait their turn and do not starve a terminal stream', async () => {
  const { cookie } = await launch(TUNNEL);
  // 200 requests at once, over 64 connections (macOS accepts at most 128 waiting connections per listener, and other test files run alongside).
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  let maxStreams = 0;
  let maxWaiting = 0;
  const watch = setInterval(() => {
    maxStreams = Math.max(maxStreams, env.hub.streamCount(env.tunnel.linkId));
    maxWaiting = Math.max(maxWaiting, (env.proxy.stats().tunnel[env.tunnel.linkId] || {}).waiting || 0);
  }, 2);
  try {
    const gets = Array.from({ length: 200 }, () => call(`/vscode/${TUNNEL}/slow?ms=150`, { headers: { cookie }, agent }));
    await until(() => env.hub.streamCount(env.tunnel.linkId) >= 24, 'the tunnel to fill up');
    // A terminal stream opens and answers at once while the VS Code requests are queued.
    const started = Date.now();
    const terminal = env.hub.openWebSocket(env.tunnel.linkId, '/v1/terminal-sessions/1/stream?ticket=x', { handshakeTimeout: 2000 });
    await new Promise((resolve, reject) => { terminal.once('open', resolve); terminal.once('error', reject); });
    terminal.send('echo');
    const echoed = await new Promise(resolve => terminal.once('message', data => resolve(data.toString())));
    assert.equal(echoed, 'echo');
    assert.ok(Date.now() - started < 1000, `the terminal waited ${Date.now() - started} ms`);
    terminal.close(1000);
    const answers = await Promise.all(gets);
    assert.ok(answers.every(answer => answer.status === 200 && answer.body.toString() === 'slow'), 'every request is answered');
  } finally {
    clearInterval(watch);
    agent.destroy();
  }
  assert.ok(maxStreams <= 25, `at most 24 VS Code requests and the terminal at once, saw ${maxStreams}`);
  assert.ok(maxWaiting >= 30, `the rest waited in the queue, saw ${maxWaiting}`);
});

test('the head of an answer must arrive within the timeout', async () => {
  const proxy = createVscodeProxy({
    hub: env.hub, sessionActive: sid => env.active.has(sid), sessionExpiry: () => null,
    resolveRemote: serverId => env.servers[serverId], headTimeoutMs: 150, sweepMs: 0,
  });
  const page = await startPage(proxy);
  try {
    for (const engineId of [DIRECT, TUNNEL, LOCAL]) {
      const answer = proxy.launchAnswer(readyAnswer(engineId), { sessionId: 'sid-1', owner: 'owner', target: TARGETS[engineId] });
      const first = await call(answer.open_url, { port: page.port });
      const cookie = first.headers['set-cookie'][0].split(';')[0];
      const slow = await call(`/vscode/${engineId}/slow?ms=2000`, { port: page.port, headers: { cookie } });
      assert.equal(slow.status, 504, engineId);
      assert.deepEqual(JSON.parse(slow.body.toString()), { error: 'REMOTE_TIMEOUT' });
    }
    await until(() => env.hub.streamCount(env.tunnel.linkId) === 0, 'the timed-out tunnel stream to be cancelled');
  } finally {
    proxy.stop();
    await closeServer(page.server);
  }
});

test('a remote engine that is gone answers 502, and a row of another owner is the 404', async () => {
  const proxy = createVscodeProxy({
    sessionActive: () => true, sweepMs: 0,
    resolveRemote: serverId => (serverId === 3 ? { baseUrl: 'http://127.0.0.1:1', token: 'x' } : serverId === 4 ? { baseUrl: tunnelBase(crypto.randomUUID()), token: 'x' } : null),
  });
  const page = await startPage(proxy);
  try {
    for (const [serverId, status, code] of [[3, 502, 'REMOTE_CONNECTION_FAILED'], [4, 502, 'REMOTE_OFFLINE'], [5, 404, null]]) {
      const answer = proxy.launchAnswer(readyAnswer('gone'), { sessionId: 's', owner: 'owner', target: { kind: 'remote', serverId } });
      const first = await call(answer.open_url, { port: page.port });
      const cookie = first.headers['set-cookie'][0].split(';')[0];
      const result = await call('/vscode/gone/', { port: page.port, headers: { cookie } });
      assert.equal(result.status, status, String(serverId));
      if (code) assert.equal(JSON.parse(result.body.toString()).error, code);
    }
  } finally {
    proxy.stop();
    await closeServer(page.server);
  }
});
