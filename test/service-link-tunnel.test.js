'use strict';
// Real HTTP and WebSocket servers on loopback; the transport is never mocked. "B" is the local server behind startTunnelClient, "A" the server that accepts the tunnel.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const WebSocket = require('ws');

process.env.T_AGENT_DATA_DIR = process.env.T_AGENT_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-test-'));
delete process.env.TAGENT_HOME;

const {
  TUNNEL_WS_OPTIONS, tunnelBase, isTunnelBase, linkIdOf, getHub, createHub, startTunnelClient, checkTunnelTarget, checkTunnelHeaders,
} = require('../lib/service-link-tunnel');
const { request, normalizeBaseUrl } = require('../services/remote-client');
const { streamRemote } = require('../services/remote-stream');

const TOKEN = 'link-token';
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

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}

// B's local server. Counts everything that reaches it, so a refusal can be proved to have made no request.
async function startLocal(t, handler = (req, res) => res.end('ok'), onSocket = () => {}) {
  const hits = { http: 0, upgrade: 0, requests: [] };
  const wss = new WebSocket.WebSocketServer({ noServer: true });
  const server = http.createServer((req, res) => {
    hits.http += 1;
    hits.requests.push({ url: req.url, headers: req.headers, remote: req.socket.remoteAddress });
    handler(req, res);
  });
  server.on('upgrade', (req, socket, head) => {
    hits.upgrade += 1;
    hits.requests.push({ url: req.url, headers: req.headers, remote: req.socket.remoteAddress });
    wss.handleUpgrade(req, socket, head, ws => onSocket(ws, req));
  });
  const port = await listen(server);
  t.after(() => { for (const ws of wss.clients) ws.terminate(); return closeServer(server); });
  return { port, hits, server };
}

// A's server: the upgrade route the lifecycle code will own, in its smallest form.
async function startAcceptor(t, hub, linkId, { status = null } = {}) {
  const wss = new WebSocket.WebSocketServer({ noServer: true, ...TUNNEL_WS_OPTIONS });
  const state = { attempts: 0, times: [], sockets: [], status };
  const server = http.createServer((req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    state.attempts += 1;
    state.times.push(Date.now());
    if (state.status) {
      socket.write(`HTTP/1.1 ${state.status} Refused\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}` || new URL(req.url, 'http://a').pathname !== '/v1/service-links/tunnel') {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      state.sockets.push(ws);
      hub.accept(linkId, ws);
    });
  });
  const port = await listen(server);
  t.after(() => { for (const ws of wss.clients) ws.terminate(); return closeServer(server); });
  return { port, state, url: `http://127.0.0.1:${port}`, server };
}

// A and B joined by a real tunnel.
async function startLink(t, { handler, onSocket, hub = createHub(), client = {} } = {}) {
  const linkId = crypto.randomUUID();
  const local = await startLocal(t, handler, onSocket);
  const acceptor = await startAcceptor(t, hub, linkId);
  const states = [];
  const tunnel = startTunnelClient({ url: acceptor.url, token: TOKEN, linkId, localPort: local.port, onState: state => states.push(state), ...client });
  t.after(() => tunnel.stop());
  await until(() => hub.isOnline(linkId), 'the tunnel to come online');
  return { hub, linkId, local, acceptor, tunnel, states, base: tunnelBase(linkId) };
}

// Calls through the hub directly, for hubs with test limits.
function hubCall(hub, linkId, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(pathname, `${tunnelBase(linkId)}/`);
    const req = hub.request(target, options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('timeout', () => req.destroy(new Error('REMOTE_TIMEOUT')));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function openSocket(hub, linkId, pathname, options) {
  return new Promise((resolve, reject) => {
    const socket = hub.openWebSocket(linkId, pathname, options);
    const messages = [];
    socket.closedWith = new Promise(done => socket.on('close', (code, reason) => done({ code, reason: reason.toString() })));
    socket.on('message', (data, binary) => messages.push({ data, binary }));
    socket.messages = messages;
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

// A hostile or broken A: speaks the raw protocol to a real startTunnelClient.
async function startRawPeer(t, { handler, onSocket, client = {} } = {}) {
  const linkId = crypto.randomUUID();
  const local = await startLocal(t, handler, onSocket);
  const wss = new WebSocket.WebSocketServer({ noServer: true });
  const server = http.createServer();
  let peer = null;
  const frames = [];
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => {
      peer = ws;
      ws.on('message', (data, isBinary) => frames.push(isBinary ? data : JSON.parse(data.toString())));
      ws.send(JSON.stringify({ t: 'hello', v: 1, side: 'hub', window: 512 * 1024 }));
    });
  });
  const port = await listen(server);
  const states = [];
  const tunnel = startTunnelClient({ url: `http://127.0.0.1:${port}`, token: TOKEN, linkId, localPort: local.port, onState: state => states.push(state), ...client });
  t.after(async () => { tunnel.stop(); for (const ws of wss.clients) ws.terminate(); await closeServer(server); });
  await until(() => states.some(state => state.online), 'the client hello');
  const answer = id => until(() => frames.find(frame => frame.id === id && ['err', 'head', 'open'].includes(frame.t)), `an answer for stream ${id}`);
  return { local, frames, states, answer, peer: () => peer, send: frame => peer.send(typeof frame === 'string' || Buffer.isBuffer(frame) ? frame : JSON.stringify(frame)) };
}

function dataFrame(id, kind, payload) {
  const header = Buffer.alloc(5);
  header[0] = kind;
  header.writeUInt32BE(id, 1);
  return Buffer.concat([header, payload]);
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

test('tunnel bases are built and recognised strictly', () => {
  const id = crypto.randomUUID();
  assert.equal(tunnelBase(id), `tunnel://${id}`);
  assert.equal(isTunnelBase(`tunnel://${id}`), true);
  assert.equal(linkIdOf(`tunnel://${id}`), id);
  for (const bad of ['tunnel://x', 'tunnel://', `http://${id}`, `tunnel://${id}/`, `tunnel://${id.toUpperCase()}`, null, undefined, 7]) {
    assert.equal(isTunnelBase(bad), false, String(bad));
    assert.equal(linkIdOf(bad), null, String(bad));
  }
  for (const bad of ['', 'x', `${id}/`, '00000000-0000-0000-0000-000000000000', `${id}\n`]) assert.throws(() => tunnelBase(bad), /INVALID_LINK_ID/);
});

test('normalizeBaseUrl still refuses a tunnel address from user input', () => {
  assert.throws(() => normalizeBaseUrl(`tunnel://${crypto.randomUUID()}`), /INVALID_REMOTE_URL/);
  assert.throws(() => normalizeBaseUrl('TUNNEL://x'), /INVALID_REMOTE_URL/);
});

test('editing a linked server keeps its tunnel base whatever the form sends', async () => {
  const { inspectRemoteAddress } = require('../services/remote-server-settings');
  const { encryptToken } = require('../lib/token-crypto');
  const base = tunnelBase(crypto.randomUUID());
  const row = { base_url: base, token_cipher: encryptToken('engine-token', 'secret') };
  const calls = [];
  const requestFn = async (url, pathname, token) => { calls.push({ url, pathname, token }); return { engine_version: '1' }; };
  const inspected = await inspectRemoteAddress(row, { url: 'http://evil.example', port: 80 }, 'secret', requestFn);
  assert.equal(inspected.baseUrl, base);
  assert.deepEqual(calls, [{ url: base, pathname: '/v1/info', token: 'engine-token' }]);
  await assert.rejects(inspectRemoteAddress({ ...row, base_url: 'http://127.0.0.1:1' }, { url: base }, 'secret', requestFn), /INVALID_REMOTE_URL/);
});

test('a drop reason that is not a code is replaced before it crosses the tunnel', async t => {
  const hub = createHub();
  const link = await startLink(t, { hub, client: { retryMinMs: 60_000, retryMaxMs: 60_000 } });
  hub.drop(link.linkId, 'a free text reason');
  await until(() => link.states.some(state => state.error === 'TUNNEL_DROPPED'), 'the state');
});

// ---------------------------------------------------------------------------
// remote-client.js over the tunnel: same results, same errors
// ---------------------------------------------------------------------------

test('request() over a tunnel returns JSON, text and the error shape of a direct call', async t => {
  const link = await startLink(t, {
    hub: getHub(),
    handler(req, res) {
      if (req.url === '/v1/json') return res.setHeader('content-type', 'application/json').end(JSON.stringify({ hello: 'world', auth: req.headers.authorization }));
      if (req.url === '/v1/text') return res.end('plain words');
      if (req.url === '/v1/coded') return res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'TASK_ARCHIVED' }));
      if (req.url === '/v1/unauth') return res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'ENGINE_TOKEN_INVALID' }));
      if (req.url === '/v1/plain500') return res.writeHead(500).end('oops');
      if (req.url === '/v1/garbage') return res.end('{not json');
      return res.writeHead(404).end();
    },
  });
  t.after(() => getHub().drop(link.linkId));
  assert.deepEqual(await request(link.base, '/v1/json', 'engine-token'), { hello: 'world', auth: 'Bearer engine-token' });
  assert.equal(await request(link.base, '/v1/text', null, { expectText: true }), 'plain words');
  await assert.rejects(request(link.base, '/v1/coded', 't'), error => error.message === 'TASK_ARCHIVED' && error.statusCode === 409);
  await assert.rejects(request(link.base, '/v1/unauth', 't'), error => error.message === 'ENGINE_TOKEN_INVALID' && error.statusCode === 401);
  await assert.rejects(request(link.base, '/v1/plain500', 't'), error => error.message === 'REMOTE_HTTP_500' && error.statusCode === 500);
  await assert.rejects(request(link.base, '/v1/garbage', 't'), /INVALID_REMOTE_RESPONSE/);
});

test('request() sends a body larger than one frame in chunks and receives one back', async t => {
  let received = 0;
  let contentType = '';
  const link = await startLink(t, {
    hub: getHub(),
    handler(req, res) {
      contentType = req.headers['content-type'];
      const chunks = [];
      req.on('data', chunk => { received += chunk.length; chunks.push(chunk); });
      req.on('end', () => res.setHeader('content-type', 'application/json').end(Buffer.concat(chunks)));
    },
  });
  t.after(() => getHub().drop(link.linkId));
  const payload = { text: 'x'.repeat(3 * 1024 * 1024) };
  const answer = await request(link.base, '/v1/echo', 't', { method: 'POST', body: payload, timeoutMs: 15_000 });
  assert.equal(answer.text.length, payload.text.length);
  assert.equal(received, Buffer.byteLength(JSON.stringify(payload)));
  assert.equal(contentType, 'application/json');
});

test('maxBytes stays the limit of the caller and cancels the stream', async t => {
  let closed = false;
  const link = await startLink(t, {
    hub: getHub(),
    handler(req, res) {
      res.on('close', () => { closed = true; });
      const chunk = Buffer.alloc(128 * 1024, 97);
      const timer = setInterval(() => res.write(chunk), 2);
      res.on('close', () => clearInterval(timer));
    },
  });
  t.after(() => getHub().drop(link.linkId));
  await assert.rejects(request(link.base, '/v1/huge', 't', { maxBytes: 512 * 1024, expectText: true }), /REMOTE_RESPONSE_TOO_LARGE/);
  await until(() => closed, 'the local response to be cancelled');
  await until(() => getHub().streamCount(link.linkId) === 0, 'the stream to be released');
});

test('a call that takes longer than timeoutMs fails with REMOTE_TIMEOUT and cancels the local request', async t => {
  let closed = false;
  const link = await startLink(t, { hub: getHub(), handler(req) { req.on('close', () => { closed = true; }); } });
  t.after(() => getHub().drop(link.linkId));
  const started = Date.now();
  await assert.rejects(request(link.base, '/v1/slow', 't', { timeoutMs: 100 }), /REMOTE_TIMEOUT/);
  assert.ok(Date.now() - started < 2000);
  await until(() => closed, 'the local request to be cancelled');
});

test('a call to a link without a tunnel fails at once with REMOTE_OFFLINE', async () => {
  const started = Date.now();
  await assert.rejects(request(tunnelBase(crypto.randomUUID()), '/v1/info', 't'), error => error.message === 'REMOTE_OFFLINE' && error.statusCode === undefined);
  assert.ok(Date.now() - started < 500);
});

// ---------------------------------------------------------------------------
// remote-stream.js over the tunnel
// ---------------------------------------------------------------------------

async function startStreamApp(t, linkBase, pathname, options) {
  const app = express();
  app.get('/stream', (req, res) => streamRemote(req, res, linkBase, 'engine-token', pathname, options));
  const server = http.createServer(app);
  const port = await listen(server);
  t.after(() => closeServer(server));
  return port;
}

test('an SSE stream arrives event by event and the browser leaving cancels it', async t => {
  let localClosed = false;
  let writer = null;
  const link = await startLink(t, {
    hub: getHub(),
    handler(req, res) {
      assert.equal(req.headers.accept, 'text/event-stream');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      writer = res;
      res.on('close', () => { localClosed = true; });
    },
  });
  t.after(() => getHub().drop(link.linkId));
  const port = await startStreamApp(t, link.base, '/v1/events', { sse: true });
  const received = [];
  const client = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/stream' }, res => {
      res.setEncoding('utf8');
      res.on('data', text => received.push(text));
      res.on('error', () => {});
      resolve({ req, res });
    });
    req.on('error', reject);
  });
  assert.equal(client.res.statusCode, 200);
  assert.equal(client.res.headers['content-type'], 'text/event-stream');
  await until(() => received.join('').includes('data: one'), 'the first event');
  writer.write('data: two\n\n');
  await until(() => received.join('').includes('data: two'), 'the second event');
  client.req.destroy();
  await until(() => localClosed, 'the local stream to be cancelled');
  await until(() => getHub().streamCount(link.linkId) === 0, 'the stream to be released');
});

test('a raw file stream passes the Range request and its answer headers', async t => {
  const link = await startLink(t, {
    hub: getHub(),
    handler(req, res) {
      assert.equal(req.headers.range, 'bytes=2-4');
      res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 2-4/10', 'accept-ranges': 'bytes', 'content-length': '3', 'set-cookie': 'sid=secret', 'x-other': '1' });
      res.end('cde');
    },
  });
  t.after(() => getHub().drop(link.linkId));
  const port = await startStreamApp(t, link.base, '/v1/fs/raw?path=%2Ftmp%2Fa.mp4', { raw: true, sandbox: true });
  const { status, headers, body } = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/stream', headers: { range: 'bytes=2-4' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
  assert.equal(status, 206);
  assert.equal(body, 'cde');
  assert.equal(headers['content-range'], 'bytes 2-4/10');
  assert.equal(headers['accept-ranges'], 'bytes');
  assert.equal(headers['set-cookie'], undefined);
  assert.equal(headers['x-other'], undefined);
});

test('a stream to an offline link answers 502 with the code', async t => {
  const port = await startStreamApp(t, tunnelBase(crypto.randomUUID()), '/v1/events', { sse: true });
  const { status, body } = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/stream' }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    }).on('error', reject);
  });
  assert.equal(status, 502);
  assert.deepEqual(JSON.parse(body), { error: 'REMOTE_OFFLINE' });
});

// ---------------------------------------------------------------------------
// WebSocket streams
// ---------------------------------------------------------------------------

test('WebSocket messages keep their type in both directions, also when larger than a frame', async t => {
  const seen = [];
  const link = await startLink(t, {
    onSocket(ws) {
      ws.on('message', (data, binary) => {
        seen.push({ data: Buffer.from(data), binary });
        ws.send(data, { binary });
      });
    },
  });
  const socket = await openSocket(link.hub, link.linkId, '/v1/terminal-sessions/1/stream?ticket=abc');
  socket.send(Buffer.from('text message'), { binary: false });
  socket.send(Buffer.from([0, 1, 2, 255]), { binary: true });
  const big = crypto.randomBytes(300 * 1024);
  socket.send(big, { binary: true });
  socket.send('a string is text');
  socket.send(Buffer.alloc(0), { binary: true });
  await until(() => socket.messages.length === 5, 'all echoes');
  assert.equal(socket.messages[0].binary, false);
  assert.equal(socket.messages[0].data.toString(), 'text message');
  assert.equal(socket.messages[1].binary, true);
  assert.deepEqual([...socket.messages[1].data], [0, 1, 2, 255]);
  assert.equal(socket.messages[2].binary, true);
  assert.ok(socket.messages[2].data.equals(big));
  assert.equal(socket.messages[3].binary, false);
  assert.equal(socket.messages[3].data.toString(), 'a string is text');
  assert.equal(socket.messages[4].data.length, 0);
  assert.equal(seen[2].data.length, big.length);
  assert.equal(link.local.hits.requests[0].url, '/v1/terminal-sessions/1/stream?ticket=abc');
  socket.close(1000, 'done');
  assert.deepEqual(await socket.closedWith, { code: 1000, reason: 'done' });
});

test('a refused terminal closes with 1008 and its reason', async t => {
  const link = await startLink(t, { onSocket(ws) { ws.close(1008, 'TASK_ARCHIVED'); } });
  const socket = await openSocket(link.hub, link.linkId, '/v1/terminal-sessions/1/stream?ticket=abc');
  assert.deepEqual(await socket.closedWith, { code: 1008, reason: 'TASK_ARCHIVED' });
  assert.equal(socket.readyState, WebSocket.CLOSED);
});

test('output queued before a close still arrives before the close', async t => {
  const link = await startLink(t, {
    onSocket(ws) {
      ws.send(Buffer.alloc(200 * 1024, 65), { binary: true });
      ws.send('last line');
      ws.close(1008, 'TASK_ARCHIVED');
    },
  });
  const socket = await openSocket(link.hub, link.linkId, '/v1/terminal-sessions/1/stream?ticket=abc');
  const closed = await socket.closedWith;
  assert.deepEqual(closed, { code: 1008, reason: 'TASK_ARCHIVED' });
  assert.equal(socket.messages.length, 2);
  assert.equal(socket.messages[1].data.toString(), 'last line');
});

test('a close from A reaches B with its code and reason', async t => {
  let closed = null;
  const link = await startLink(t, { onSocket(ws) { ws.on('close', (code, reason) => { closed = { code, reason: reason.toString() }; }); } });
  const socket = await openSocket(link.hub, link.linkId, '/v1/terminal-sessions/1/stream?ticket=abc');
  socket.close(4100, 'bye');
  assert.deepEqual(await socket.closedWith, { code: 4100, reason: 'bye' });
  await until(() => closed, 'the local close');
  assert.deepEqual(closed, { code: 4100, reason: 'bye' });
});

test('a local refusal of the upgrade fails the socket like a failed handshake', async t => {
  const link = await startLink(t);
  link.local.server.removeAllListeners('upgrade');
  link.local.server.on('upgrade', (req, socket) => { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); });
  await assert.rejects(openSocket(link.hub, link.linkId, '/v1/terminal-sessions/1/stream?ticket=expired'), /REMOTE_CONNECTION_FAILED/);
});

test('a WebSocket whose handshake does not finish times out', async t => {
  const link = await startLink(t);
  link.local.server.removeAllListeners('upgrade');
  // Never answers, but notices when the other end goes away so that the server can close.
  link.local.server.on('upgrade', (req, socket) => { socket.on('error', () => {}); socket.on('end', () => socket.destroy()); socket.resume(); });
  await assert.rejects(openSocket(link.hub, link.linkId, '/v1/terminal-sessions/1/stream?ticket=abc', { handshakeTimeout: 80 }), /REMOTE_TIMEOUT/);
});

test('the real terminal proxy runs over a tunnel: output, input, and a 1008 close reach the browser', async t => {
  // The proxy needs the real database for its remote_servers row.
  const db = require('../db');
  const config = require('../config');
  const { encryptToken } = require('../lib/token-crypto');
  const { handleRemoteTerminalUpgrade } = require('../services/remote-terminal-proxy');
  const inputs = [];
  const link = await startLink(t, {
    hub: getHub(),
    handler(req, res) {
      if (req.method === 'POST' && req.url === '/v1/terminal-sessions') {
        assert.equal(req.headers.authorization, 'Bearer engine-token');
        return res.setHeader('content-type', 'application/json').end(JSON.stringify({ websocket_path: '/v1/terminal-sessions/5/stream?ticket=one%2Dtime' }));
      }
      return res.writeHead(404).end();
    },
    onSocket(ws) {
      ws.send('prompt$ ');
      ws.on('message', (data, binary) => {
        inputs.push({ text: data.toString(), binary });
        if (data.toString() === 'quit') ws.close(1008, 'TASK_ARCHIVED');
      });
    },
  });
  t.after(() => getHub().drop(link.linkId));
  const owner = `owner-${link.linkId}`;
  const { lastInsertRowid: serverId } = db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
    .run(owner, 'linked', link.base, encryptToken('engine-token', config.sessionSecret));
  const browserSide = new WebSocket.WebSocketServer({ noServer: true });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => { handleRemoteTerminalUpgrade(req, socket, head, browserSide, { login: owner }); });
  const port = await listen(server);
  t.after(() => { for (const ws of browserSide.clients) ws.terminate(); return closeServer(server); });

  const browser = new WebSocket(`ws://127.0.0.1:${port}/api/remote-servers/${serverId}/terminal/ws?taskId=5`);
  const output = [];
  const closed = new Promise(resolve => browser.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  browser.on('message', (data, binary) => output.push({ text: data.toString(), binary }));
  await new Promise((resolve, reject) => { browser.once('open', resolve); browser.once('error', reject); });
  await until(() => output.length, 'the terminal output');
  assert.deepEqual(output[0], { text: 'prompt$ ', binary: false });
  assert.equal(link.local.hits.requests.at(-1).url, '/v1/terminal-sessions/5/stream?ticket=one%2Dtime');
  browser.send(Buffer.from([1, 2]), { binary: true });
  browser.send('quit');
  assert.deepEqual(await closed, { code: 1008, reason: 'TASK_ARCHIVED' });
  assert.deepEqual(inputs.map(item => item.binary), [true, false]);
});

// ---------------------------------------------------------------------------
// Tunnel health
// ---------------------------------------------------------------------------

test('a dead tunnel fails everything pending quickly and goes offline', async t => {
  const hub = createHub({ heartbeatMs: 40 });
  const changes = [];
  hub.onChange(change => changes.push(change));
  const link = await startLink(t, { hub, handler() { /* never answers */ }, client: { heartbeatMs: 60_000 } });
  const pending = hubCall(hub, link.linkId, '/v1/slow');
  const socket = await openSocket(hub, link.linkId, '/v1/terminal-sessions/1/stream?ticket=a').catch(error => error);
  // The peer goes silent without closing: no pong, no data, no FIN.
  link.acceptor.state.sockets[0]._socket.pause();
  const started = Date.now();
  await assert.rejects(pending, /REMOTE_OFFLINE/);
  assert.ok(Date.now() - started < 1500, 'the failure must come from the heartbeat, soon');
  assert.equal(hub.isOnline(link.linkId), false);
  assert.deepEqual(changes.at(-1), { linkId: link.linkId, online: false });
  if (socket.closedWith) assert.equal((await socket.closedWith).code, 1006);
});

test('drop closes the tunnel and fails what is pending at once', async t => {
  const hub = createHub();
  const link = await startLink(t, { handler() { /* never answers */ } , hub });
  const pending = hubCall(hub, link.linkId, '/v1/slow');
  await until(() => link.local.hits.http === 1, 'the request to arrive');
  const socket = await openSocket(hub, link.linkId, '/v1/terminal-sessions/1/stream?ticket=a');
  hub.drop(link.linkId, 'LINK_REVOKED');
  await assert.rejects(pending, /REMOTE_OFFLINE/);
  assert.equal((await socket.closedWith).code, 1006);
  assert.equal(hub.isOnline(link.linkId), false);
  await until(() => link.states.some(state => state.error === 'LINK_REVOKED'), 'the client to see the drop reason');
});

test('a newer tunnel replaces an older one and fails only what the older one carried', async t => {
  const hub = createHub();
  const changes = [];
  hub.onChange(change => changes.push(change));
  const link = await startLink(t, { hub, handler() { /* never answers */ }, client: { retryMinMs: 60_000, retryMaxMs: 60_000 } });
  const pending = hubCall(hub, link.linkId, '/v1/slow');
  await until(() => link.local.hits.http === 1, 'the request to arrive');
  const second = startTunnelClient({ url: link.acceptor.url, token: TOKEN, linkId: link.linkId, localPort: link.local.port, retryMinMs: 60_000, retryMaxMs: 60_000 });
  t.after(() => second.stop());
  await assert.rejects(pending, /REMOTE_OFFLINE/);
  await until(() => link.states.some(state => state.error === 'TUNNEL_REPLACED'), 'the old client to see the replacement');
  assert.equal(hub.isOnline(link.linkId), true);
  assert.deepEqual(changes, [{ linkId: link.linkId, online: true }]);
  link.local.server.removeAllListeners('request');
  link.local.server.on('request', (req, res) => res.end('from the newer tunnel'));
  assert.equal((await hubCall(hub, link.linkId, '/v1/next')).body, 'from the newer tunnel');
});

test('a connection that never says hello does not displace a working tunnel', async t => {
  const hub = createHub({ helloTimeoutMs: 60 });
  const link = await startLink(t, { hub });
  const silent = new WebSocket(`ws://127.0.0.1:${link.acceptor.port}/v1/service-links/tunnel`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  silent.on('error', () => {});
  await new Promise(resolve => silent.once('open', resolve));
  const closed = new Promise(resolve => silent.once('close', resolve));
  assert.equal((await hubCall(hub, link.linkId, '/v1/ok')).body, 'ok');
  await closed;
  assert.equal(hub.isOnline(link.linkId), true);
});

test('the client reconnects with growing delays and stops when told to', async t => {
  const hub = createHub();
  const linkId = crypto.randomUUID();
  const local = await startLocal(t);
  const acceptor = await startAcceptor(t, hub, linkId, { status: 503 });
  const states = [];
  const tunnel = startTunnelClient({ url: acceptor.url, token: TOKEN, linkId, localPort: local.port, onState: state => states.push(state), retryMinMs: 20, retryMaxMs: 80, retryJitter: 0 });
  t.after(() => tunnel.stop());
  await until(() => acceptor.state.attempts >= 5, 'five attempts');
  const gaps = acceptor.state.times.slice(1).map((time, index) => time - acceptor.state.times[index]);
  assert.ok(gaps[0] >= 15 && gaps[0] < 70, `first gap ${gaps[0]}`);
  assert.ok(gaps[1] >= 35, `second gap ${gaps[1]}`);
  assert.ok(gaps[2] >= 70, `third gap ${gaps[2]}`);
  assert.ok(gaps[3] < 200, `the gap is capped: ${gaps[3]}`);
  assert.equal(states[0].error, 'TUNNEL_HTTP_503');
  assert.equal(states[0].online, false);

  // The server comes back: the client gets online by itself.
  acceptor.state.status = null;
  await until(() => hub.isOnline(linkId), 'the reconnect');
  await until(() => states.at(-1).online === true, 'the online state');
  assert.equal(states.at(-1).error, null);

  tunnel.stop();
  await until(() => !hub.isOnline(linkId), 'the stop to reach the hub');
  const attempts = acceptor.state.attempts;
  await delay(150);
  assert.equal(acceptor.state.attempts, attempts);
});

test('401 and 403 stop the client for good and report LINK_REVOKED', async t => {
  for (const status of [401, 403]) {
    const linkId = crypto.randomUUID();
    const local = await startLocal(t);
    const acceptor = await startAcceptor(t, createHub(), linkId, { status });
    const states = [];
    const tunnel = startTunnelClient({ url: acceptor.url, token: TOKEN, linkId, localPort: local.port, onState: state => states.push(state), retryMinMs: 5, retryMaxMs: 10 });
    t.after(() => tunnel.stop());
    await until(() => states.length, 'the state');
    await delay(80);
    assert.equal(acceptor.state.attempts, 1);
    assert.deepEqual(states, [{ online: false, error: 'LINK_REVOKED' }]);
  }
});

test('the client connects with the token in the header, wss for https, and refuses a bad configuration', () => {
  const linkId = crypto.randomUUID();
  const base = { url: 'http://127.0.0.1:1', token: 't', linkId, localPort: 1 };
  assert.throws(() => startTunnelClient({ ...base, url: 'ftp://x' }), /INVALID_REMOTE_URL/);
  assert.throws(() => startTunnelClient({ ...base, url: 'http://user:pw@x' }), /INVALID_REMOTE_URL/);
  assert.throws(() => startTunnelClient({ ...base, linkId: 'x' }), /INVALID_LINK_ID/);
  assert.throws(() => startTunnelClient({ ...base, token: '' }), /INVALID_LINK_TOKEN/);
  assert.throws(() => startTunnelClient({ ...base, localPort: 0 }), /INVALID_REMOTE_PORT/);
});

// ---------------------------------------------------------------------------
// Limits and flow control
// ---------------------------------------------------------------------------

test('the stream limit of B refuses further streams without a local request', async t => {
  const hub = createHub();
  const link = await startLink(t, { hub, handler() { /* holds the streams open */ }, client: { maxStreams: 2 } });
  const first = hubCall(hub, link.linkId, '/v1/a').catch(error => error);
  const second = hubCall(hub, link.linkId, '/v1/b').catch(error => error);
  await until(() => link.local.hits.http === 2, 'two streams');
  await assert.rejects(hubCall(hub, link.linkId, '/v1/c'), /TUNNEL_TOO_MANY_STREAMS/);
  assert.equal(link.local.hits.http, 2);
  hub.drop(link.linkId);
  assert.equal((await first).message, 'REMOTE_OFFLINE');
  assert.equal((await second).message, 'REMOTE_OFFLINE');
});

test('the stream limit of A answers without using the tunnel', async t => {
  const hub = createHub({ maxStreams: 1 });
  const link = await startLink(t, { hub, handler() { /* holds the stream open */ } });
  const first = hubCall(hub, link.linkId, '/v1/a').catch(error => error);
  await until(() => link.local.hits.http === 1, 'one stream');
  await assert.rejects(hubCall(hub, link.linkId, '/v1/b'), /REMOTE_TUNNEL_BUSY/);
  await assert.rejects(openSocket(hub, link.linkId, '/v1/terminal-sessions/1/stream?ticket=a'), /REMOTE_TUNNEL_BUSY/);
  assert.equal(link.local.hits.http, 1);
  hub.drop(link.linkId);
  await first;
});

// A local server that writes as fast as the socket takes it, for as long as it is left to.
function floodingHandler(counter) {
  return (req, res) => {
    if (req.url !== '/v1/flood') return res.end('fast');
    const chunk = Buffer.alloc(64 * 1024, 120);
    const pushMore = () => {
      for (;;) {
        counter.written += chunk.length;
        if (!res.write(chunk)) break;
      }
    };
    res.on('drain', pushMore);
    res.on('close', () => { counter.closed = true; });
    pushMore();
    return undefined;
  };
}

test('a reader that does not read stops the sender after a bounded amount, and other streams keep working', async t => {
  const hub = createHub({ heartbeatMs: 60_000 });
  const counter = { written: 0, closed: false };
  const link = await startLink(t, { hub, handler: floodingHandler(counter) });
  let unread = null;
  const request1 = hub.request(new URL('/v1/flood', `${link.base}/`), {}, res => { unread = res; });
  request1.on('error', () => {});
  request1.end();
  await until(() => unread, 'the flood to start');
  await delay(300);
  const writtenOnce = counter.written;
  await delay(200);
  // Everything above the window sits in the operating system's socket buffers of the loopback hop; it must stop, not keep growing.
  assert.equal(counter.written, writtenOnce, 'the local writer is held back');
  assert.ok(writtenOnce < 32 * 1024 * 1024, `bounded: ${writtenOnce}`);

  for (let index = 0; index < 5; index += 1) {
    const started = Date.now();
    assert.equal((await hubCall(hub, link.linkId, '/v1/fast', { timeout: 2000 })).body, 'fast');
    assert.ok(Date.now() - started < 1000);
  }
  request1.destroy();
  await until(() => counter.closed, 'the cancel to reach the local stream');
});

test('a stream that is being read at full speed does not starve another stream', async t => {
  const hub = createHub();
  const counter = { written: 0, closed: false };
  const link = await startLink(t, { hub, handler: floodingHandler(counter) });
  let bytes = 0;
  const flood = hub.request(new URL('/v1/flood', `${link.base}/`), {}, res => res.on('data', chunk => { bytes += chunk.length; }));
  flood.on('error', () => {});
  flood.end();
  await until(() => bytes > 1024 * 1024, 'the flood to be flowing');
  for (let index = 0; index < 10; index += 1) {
    const started = Date.now();
    assert.equal((await hubCall(hub, link.linkId, '/v1/fast', { timeout: 3000 })).body, 'fast');
    assert.ok(Date.now() - started < 1500, 'the small call gets its turn');
  }
  assert.ok(bytes > 2 * 1024 * 1024, `the flood kept flowing: ${bytes}`);
  flood.destroy();
});

test('a noisy terminal waits for a slow browser instead of growing memory on A', async t => {
  const hub = createHub();
  let sent = 0;
  let localSocket = null;
  const link = await startLink(t, {
    hub,
    onSocket(ws) {
      localSocket = ws;
      const chunk = Buffer.alloc(32 * 1024, 110);
      const timer = setInterval(() => {
        if (ws.bufferedAmount > 1024 * 1024) return;
        for (let index = 0; index < 8; index += 1) { sent += chunk.length; ws.send(chunk); }
      }, 1);
      ws.on('close', () => clearInterval(timer));
    },
  });
  const socket = await openSocket(hub, link.linkId, '/v1/terminal-sessions/1/stream?ticket=a');
  let received = 0;
  socket.on('message', data => { received += data.length; });
  socket.limitBy({ bufferedAmount: 64 * 1024 * 1024 });
  await delay(400);
  const atStop = received;
  await delay(250);
  assert.ok(received - atStop <= 2 * 1024 * 1024, `the output stops: ${received - atStop}`);
  assert.ok(received <= 2 * 1024 * 1024, `about one window was delivered: ${received}`);
  assert.ok(sent > 0 && localSocket);
  socket.terminate();
});

// ---------------------------------------------------------------------------
// Malformed frames
// ---------------------------------------------------------------------------

const GARBAGE = [
  'this is not JSON',
  '[]',
  'null',
  '{}',
  JSON.stringify({ t: 'hello', v: 1, side: 'client', window: 512 * 1024 }),
  JSON.stringify({ t: 'head', id: 0 }),
  JSON.stringify({ t: 'head', id: 'x' }),
  JSON.stringify({ t: 'credit', id: 1, n: -5 }),
  JSON.stringify({ t: 'nonsense', id: 999 }),
  Buffer.alloc(0),
  Buffer.from([1, 2]),
  dataFrame(999, 1, Buffer.from('for no stream')),
  dataFrame(0, 1, Buffer.from('x')),
  Buffer.from([9, 0, 0, 0, 1, 7]),
];

test('garbage from B closes the tunnel, fails what is pending and does not crash', async t => {
  const hub = createHub();
  const linkId = crypto.randomUUID();
  const acceptor = await startAcceptor(t, hub, linkId);
  for (const garbage of GARBAGE) {
    const ws = new WebSocket(`ws://127.0.0.1:${acceptor.port}/v1/service-links/tunnel`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    ws.on('error', () => {});
    const closed = new Promise(resolve => ws.once('close', resolve));
    await new Promise(resolve => ws.once('open', resolve));
    ws.send(JSON.stringify({ t: 'hello', v: 1, side: 'client', linkId, window: 512 * 1024 }));
    await until(() => hub.isOnline(linkId), 'the hello');
    const pending = hubCall(hub, linkId, '/v1/x').catch(error => error);
    await delay(5);
    ws.send(garbage);
    await closed;
    assert.equal(hub.isOnline(linkId), false, String(garbage).slice(0, 40));
    assert.equal((await pending).message, 'REMOTE_OFFLINE');
  }
});

test('a frame larger than the limit closes the tunnel', async t => {
  const hub = createHub();
  const link = await startLink(t, { hub });
  const socket = link.acceptor.state.sockets[0];
  const raw = new WebSocket(`ws://127.0.0.1:${link.acceptor.port}/v1/service-links/tunnel`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  raw.on('error', () => {});
  const closed = new Promise(resolve => raw.once('close', resolve));
  await new Promise(resolve => raw.once('open', resolve));
  raw.send(Buffer.alloc(TUNNEL_WS_OPTIONS.maxPayload + 1));
  await closed;
  assert.ok(socket);
  assert.equal(hub.isOnline(link.linkId), true, 'the other tunnel is unaffected');
});

test('a wrong protocol version is refused with a clear code', async t => {
  const hub = createHub();
  const linkId = crypto.randomUUID();
  const acceptor = await startAcceptor(t, hub, linkId);
  const ws = new WebSocket(`ws://127.0.0.1:${acceptor.port}/v1/service-links/tunnel`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  ws.on('error', () => {});
  const closed = new Promise(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  await new Promise(resolve => ws.once('open', resolve));
  ws.send(JSON.stringify({ t: 'hello', v: 99, side: 'client', linkId, window: 512 * 1024 }));
  assert.deepEqual(await closed, { code: 4406, reason: 'TUNNEL_VERSION_MISMATCH' });
  assert.equal(hub.isOnline(linkId), false);
});

test('a hello with another link id is refused', async t => {
  const hub = createHub();
  const linkId = crypto.randomUUID();
  const acceptor = await startAcceptor(t, hub, linkId);
  const ws = new WebSocket(`ws://127.0.0.1:${acceptor.port}/v1/service-links/tunnel`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  ws.on('error', () => {});
  const closed = new Promise(resolve => ws.once('close', resolve));
  await new Promise(resolve => ws.once('open', resolve));
  ws.send(JSON.stringify({ t: 'hello', v: 1, side: 'client', linkId: crypto.randomUUID(), window: 512 * 1024 }));
  await closed;
  assert.equal(hub.isOnline(linkId), false);
});

test('garbage from A closes the tunnel on B, which reconnects and makes no request', async t => {
  for (const garbage of GARBAGE.filter(item => !(typeof item === 'string' && item.includes('"client"')))) {
    const peer = await startRawPeer(t, { client: { retryMinMs: 60_000, retryMaxMs: 60_000 } });
    peer.send(garbage);
    await until(() => peer.states.some(state => state.online === false), `a closed tunnel after ${String(garbage).slice(0, 40)}`);
    assert.equal(peer.local.hits.http, 0);
  }
});

test('a peer that breaks flow control loses the tunnel', async t => {
  const peer = await startRawPeer(t, {
    handler(req) { req.on('data', () => {}); },
    client: { retryMinMs: 60_000, retryMaxMs: 60_000, streamWindowBytes: 128 * 1024 },
  });
  peer.send({ t: 'http', id: 1, method: 'POST', path: '/v1/x', headers: {}, body: true });
  const chunk = Buffer.alloc(60 * 1024, 1);
  for (let index = 0; index < 4; index += 1) peer.send(dataFrame(1, 1, chunk));
  await until(() => peer.states.some(state => state.online === false), 'the tunnel to close');
});

// ---------------------------------------------------------------------------
// B's boundary: every path and header on the list, with proof that no local request was made
// ---------------------------------------------------------------------------

const FORBIDDEN_PATHS = [
  // Not under /v1
  '/', '/api/tasks', '/api/remote/v1/tasks', '/auth/login', '/torin/hide/login', '/health', '/terminal/ws', '/hooks/terminal-activity', '/h5', '/share/x', '/v2/tasks',
  '/v1', '/v1/', '/V1/tasks', '/v1x/tasks', 'v1/tasks', '',
  // Path traversal
  '/v1/../api/tasks', '/v1/tasks/../../api/tasks', '/v1/./tasks', '/v1/tasks/.', '/v1/tasks/..',
  // Encoded traversal and separators
  '/v1/%2e%2e/api/tasks', '/v1/%2E%2E/api/tasks', '/v1/.%2e/api/tasks', '/v1/%2e./api/tasks', '/v1/tasks%2f..%2f..%2fapi', '/v1/tasks%2F1', '/v1/tasks/%2e',
  '/v1/%252e%252e/api', '/v1/%252f', '/v1/%25', '/v1/tasks%5c..%5capi', '/v1/%5C',
  // Backslashes
  '/v1\\..\\api', '/v1/tasks\\1', '\\v1\\tasks', '/v1/tasks?x=\\',
  // Absolute URLs and hosts
  'http://127.0.0.1:1/v1/tasks', 'https://evil.example/v1/tasks', '//evil.example/v1/tasks', 'evil.example/v1/tasks', '/v1//tasks', '/v1/tasks//1', '/v1/http://evil.example/x',
  '/v1/@evil.example', '/v1/evil.example:80/x', '/v1/a:b',
  // Control characters and other bytes that do not belong in a request line
  '/v1/tasks\r\nX-Evil: 1', '/v1/tasks\n', '/v1/tasks\t', '/v1/tasks 1', '/v1/tasks%00', '/v1/tasks%0a', '/v1/tasks%0d%0aX: 1', '/v1/tasks%7f', '/v1/tasks?x=\r\n', '/v1/café',
  '/v1/tasks#fragment', '/v1/%', '/v1/%zz', '/v1/%c0%ae%c0%ae',
  // A route the tunnel must never reach, in the forms Express would accept or a client could try
  '/v1/pair', '/v1/pair/', '/v1/PAIR', '/v1/Pair', '/v1/pair?x=1', '/v1/pair/extra', '/v1/p%61ir', '/v1/P%41IR',
  '/v1/service-links', '/v1/service-links/', '/v1/service-links/tunnel', '/v1/service-links/codes', '/v1/SERVICE-LINKS/tunnel', '/v1/service%2Dlinks/tunnel',
  '/v1/file-sync/pair', '/v1/FILE-SYNC/Pair',
];

const FORBIDDEN_HEADERS = [
  ['connection', 'keep-alive'], ['Connection', 'close'], ['keep-alive', 'timeout=5'], ['proxy-authenticate', 'x'], ['proxy-authorization', 'x'], ['proxy-connection', 'x'], ['te', 'trailers'], ['trailer', 'x'],
  ['transfer-encoding', 'chunked'], ['upgrade', 'websocket'], ['host', 'evil.example'], ['Host', '127.0.0.1'], ['HOST', 'localhost'], ['cookie', 'sid=1'], ['Cookie', 'sid=1'],
  ['x-forwarded-for', '1.2.3.4'], ['x-forwarded-host', 'evil.example'], ['x-forwarded-proto', 'https'], ['x-forwarded-port', '443'], ['X-Forwarded-Anything', 'x'], ['forwarded', 'for=1.2.3.4'], ['x-real-ip', '1.2.3.4'],
  ['origin', 'http://127.0.0.1'], ['referer', 'http://127.0.0.1/'], ['sec-fetch-site', 'same-origin'], ['x-requested-with', 'XMLHttpRequest'], ['x-ta-token', 'x'], ['content-length', '3'], ['accept-encoding', 'gzip'],
  ['sec-websocket-protocol', 'x'], ['user-agent', 'x'], ['__proto__x', 'x'],
];

const FORBIDDEN_HEADER_SETS = [
  { authorization: 'Bearer a\r\nX-Evil: 1' },
  { authorization: 'Basic abc' },
  { accept: 'text/plain\nX: y' },
  { range: 7 },
  { accept: ['a', 'b'] },
  { 'if-none-match': null },
  { Accept: 'a', accept: 'b' },
  { authorization: `Bearer ${'x'.repeat(9000)}` },
];

const ALLOWED_PATHS = [
  '/v1/tasks',
  '/v1/health',
  '/v1/tasks/1/files/raw?path=a%2Fb%20c&x=..',
  '/v1/terminal-sessions/7/stream?ticket=a.b_c-d%2Be',
  '/v1/tasks/ab%20c/todos',
  '/v1/pairing-notes',
  '/v1/file-sync/manifest',
];

test('checkTunnelTarget refuses every forbidden target and keeps the real ones', () => {
  for (const target of FORBIDDEN_PATHS) assert.throws(() => checkTunnelTarget(target), /TUNNEL_PATH_FORBIDDEN/, JSON.stringify(target));
  assert.throws(() => checkTunnelTarget(null), /TUNNEL_PATH_FORBIDDEN/);
  assert.throws(() => checkTunnelTarget(`/v1/${'a'.repeat(9000)}`), /TUNNEL_PATH_FORBIDDEN/);
  for (const target of ALLOWED_PATHS) assert.equal(checkTunnelTarget(target), target);
});

test('checkTunnelHeaders accepts exactly the allowlist', () => {
  const allowed = {
    Authorization: 'Bearer token', 'content-type': 'application/json', accept: '*/*', range: 'bytes=0-1', 'if-none-match': '"x"', 'last-event-id': '7',
  };
  assert.deepEqual(checkTunnelHeaders(allowed), {
    authorization: 'Bearer token', 'content-type': 'application/json', accept: '*/*', range: 'bytes=0-1', 'if-none-match': '"x"', 'last-event-id': '7',
  });
  assert.deepEqual(checkTunnelHeaders(undefined), {});
  for (const [name, value] of FORBIDDEN_HEADERS) assert.throws(() => checkTunnelHeaders({ [name]: value }), /TUNNEL_HEADER_FORBIDDEN/, name);
  for (const headers of FORBIDDEN_HEADER_SETS) assert.throws(() => checkTunnelHeaders(headers), /TUNNEL_HEADER_FORBIDDEN/, JSON.stringify(headers).slice(0, 60));
  assert.throws(() => checkTunnelHeaders('a'), /TUNNEL_HEADER_FORBIDDEN/);
  assert.throws(() => checkTunnelHeaders(['a']), /TUNNEL_HEADER_FORBIDDEN/);
});

test('B refuses every forbidden HTTP path without making a local request', async t => {
  const peer = await startRawPeer(t);
  let id = 0;
  for (const target of FORBIDDEN_PATHS) {
    id += 1;
    peer.send({ t: 'http', id, method: 'GET', path: target, headers: {}, body: false });
    const answer = await peer.answer(id);
    assert.deepEqual(answer, { t: 'err', id, code: 'TUNNEL_PATH_FORBIDDEN' }, JSON.stringify(target));
  }
  assert.equal(peer.local.hits.http, 0);

  // The same channel does make requests when the target is allowed, so the zero above means something.
  id += 1;
  peer.send({ t: 'http', id, method: 'GET', path: '/v1/tasks', headers: { authorization: 'Bearer t' }, body: false });
  assert.equal((await peer.answer(id)).t, 'head');
  assert.equal(peer.local.hits.http, 1);
  assert.equal(peer.local.hits.requests[0].headers.authorization, 'Bearer t');
  assert.equal(peer.states.at(-1).online, true, 'refusals do not end the tunnel');
});

test('B refuses every forbidden header without making a local request', async t => {
  const peer = await startRawPeer(t);
  let id = 0;
  const sets = [...FORBIDDEN_HEADERS.map(([name, value]) => ({ [name]: value })), ...FORBIDDEN_HEADER_SETS, 'text', ['a']];
  for (const headers of sets) {
    id += 1;
    peer.send({ t: 'http', id, method: 'GET', path: '/v1/tasks', headers, body: false });
    assert.deepEqual(await peer.answer(id), { t: 'err', id, code: 'TUNNEL_HEADER_FORBIDDEN' }, JSON.stringify(headers).slice(0, 60));
  }
  assert.equal(peer.local.hits.http, 0);
});

test('B refuses other methods without making a local request', async t => {
  const peer = await startRawPeer(t);
  let id = 0;
  for (const method of ['CONNECT', 'TRACE', 'OPTIONS', 'get', 'PROPFIND', '', 7, null]) {
    id += 1;
    peer.send({ t: 'http', id, method, path: '/v1/tasks', headers: {}, body: false });
    assert.deepEqual(await peer.answer(id), { t: 'err', id, code: 'TUNNEL_METHOD_FORBIDDEN' });
  }
  assert.equal(peer.local.hits.http, 0);
});

test('B refuses every forbidden WebSocket path and header without opening a local socket', async t => {
  const peer = await startRawPeer(t);
  let id = 0;
  for (const target of FORBIDDEN_PATHS) {
    id += 1;
    peer.send({ t: 'ws', id, path: target, headers: {} });
    assert.deepEqual(await peer.answer(id), { t: 'err', id, code: 'TUNNEL_PATH_FORBIDDEN' }, JSON.stringify(target));
  }
  for (const [name, value] of FORBIDDEN_HEADERS) {
    id += 1;
    peer.send({ t: 'ws', id, path: '/v1/terminal-sessions/1/stream?ticket=a', headers: { [name]: value } });
    assert.deepEqual(await peer.answer(id), { t: 'err', id, code: 'TUNNEL_HEADER_FORBIDDEN' }, name);
  }
  assert.equal(peer.local.hits.upgrade, 0);
  assert.equal(peer.local.hits.http, 0);

  id += 1;
  peer.send({ t: 'ws', id, path: '/v1/terminal-sessions/1/stream?ticket=a', headers: {} });
  assert.equal((await peer.answer(id)).t, 'open');
  assert.equal(peer.local.hits.upgrade, 1);
});

test('a request from the tunnel carries only the allowed headers and looks like plain loopback', async t => {
  const peer = await startRawPeer(t);
  peer.send({ t: 'http', id: 1, method: 'GET', path: '/v1/tasks', headers: { authorization: 'Bearer t', accept: 'application/json', range: 'bytes=0-1' }, body: false });
  await peer.answer(1);
  const { headers, remote } = peer.local.hits.requests[0];
  assert.deepEqual(Object.keys(headers).sort(), ['accept', 'authorization', 'connection', 'host', 'range'].sort());
  assert.equal(headers.host, `127.0.0.1:${peer.local.server.address().port}`);
  assert.equal(headers.connection, 'close');
  assert.equal(remote, '127.0.0.1');
});

test('a stream id cannot be reused and a body larger than the limit is refused', async t => {
  let closed = false;
  const peer = await startRawPeer(t, {
    handler(req) { req.on('data', () => {}); req.on('close', () => { closed = true; }); },
    client: { maxRequestBodyBytes: 64 * 1024 + 10 },
  });
  peer.send({ t: 'http', id: 1, method: 'POST', path: '/v1/up', headers: {}, body: true });
  peer.send(dataFrame(1, 1, Buffer.alloc(64 * 1024, 1)));
  await until(() => peer.local.hits.http === 1, 'the request to reach the local server');
  peer.send(dataFrame(1, 1, Buffer.alloc(64 * 1024, 1)));
  assert.deepEqual(await peer.answer(1), { t: 'err', id: 1, code: 'TUNNEL_BODY_TOO_LARGE' });
  await until(() => closed, 'the local request to stop');
  peer.send({ t: 'http', id: 1, method: 'GET', path: '/v1/x', headers: {}, body: false });
  await until(() => peer.states.some(state => state.online === false), 'a reused id to close the tunnel');
});

test('a cancel from A stops the local request', async t => {
  let closed = false;
  const peer = await startRawPeer(t, {
    handler(req, res) { res.write('start'); res.on('close', () => { closed = true; }); },
  });
  peer.send({ t: 'http', id: 1, method: 'GET', path: '/v1/x', headers: {}, body: false });
  assert.equal((await peer.answer(1)).t, 'head');
  peer.send({ t: 'cancel', id: 1 });
  await until(() => closed, 'the local response to close');
});

test('a tunnel that dies stops every local request and socket on B', async t => {
  let requestClosed = false;
  let socketClosed = false;
  const peer = await startRawPeer(t, {
    handler(req, res) { res.write('start'); res.on('close', () => { requestClosed = true; }); },
    onSocket(ws) { ws.on('close', () => { socketClosed = true; }); },
    client: { retryMinMs: 60_000, retryMaxMs: 60_000 },
  });
  peer.send({ t: 'http', id: 1, method: 'GET', path: '/v1/x', headers: {}, body: false });
  peer.send({ t: 'ws', id: 2, path: '/v1/terminal-sessions/1/stream?ticket=a', headers: {} });
  await peer.answer(1);
  await peer.answer(2);
  peer.peer().terminate();
  await until(() => requestClosed && socketClosed, 'local work to stop');
});

// ---------------------------------------------------------------------------
// What the real gates do with a tunnelled request
// ---------------------------------------------------------------------------

test('the access gate lets a tunnelled /v1 request through as local without marking it trusted, and no cookie crosses', async t => {
  const { createAccessGate, upgradeAllowed } = require('../lib/access-gate');
  const session = require('express-session');
  const app = express();
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false, name: 'sid' }));
  app.use(createAccessGate({ getMode: () => 'local' }));
  let seen = null;
  app.get('/v1/check', (req, res) => {
    seen = { localTrusted: req.session.localTrusted, upgradeAllowed: upgradeAllowed(req, 'local'), forwardedFor: req.headers['x-forwarded-for'] };
    req.session.visited = true; // so the server hands out a cookie, which the tunnel must withhold
    res.json({ ok: true });
  });
  const hub = createHub();
  const linkId = crypto.randomUUID();
  const server = http.createServer(app);
  const localPort = await listen(server);
  t.after(() => closeServer(server));
  const acceptor = await startAcceptor(t, hub, linkId);
  const tunnel = startTunnelClient({ url: acceptor.url, token: TOKEN, linkId, localPort });
  t.after(() => tunnel.stop());
  await until(() => hub.isOnline(linkId), 'the tunnel');

  const answer = await hubCall(hub, linkId, '/v1/check');
  assert.equal(answer.status, 200);
  assert.deepEqual(seen, { localTrusted: undefined, upgradeAllowed: true, forwardedFor: undefined });
  assert.equal(answer.headers['set-cookie'], undefined);

  // The same server, called directly, does hand out a cookie: the tunnel is what withholds it.
  const direct = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: localPort, path: '/v1/check' }, res => { res.resume(); res.on('end', () => resolve(res.headers)); }).on('error', reject);
  });
  assert.ok(direct['set-cookie']);
});

// ---------------------------------------------------------------------------
// Streamed request bodies
// ---------------------------------------------------------------------------

const { Readable } = require('node:stream');
const { LEGACY_REQUEST_BODY_BYTES } = require('../lib/service-link-tunnel');

// A generated body of `total` bytes in 64 KiB chunks, each with its index in front, so lost, doubled or reordered chunks change the hash.
function generatedBody(total, chunkBytes = 64 * 1024) {
  const state = { produced: 0 };
  const stream = new Readable({
    read() {
      if (state.produced >= total) { this.push(null); return; }
      const size = Math.min(chunkBytes, total - state.produced);
      const chunk = Buffer.alloc(size, state.produced % 251);
      if (size >= 8) chunk.writeBigUInt64BE(BigInt(state.produced), 0);
      state.produced += size;
      this.push(chunk);
    },
  });
  state.stream = stream;
  return state;
}

async function hashOf(total) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of generatedBody(total).stream) hash.update(chunk);
  return hash.digest('hex');
}

// Sends `source` into a hub request the way routes/tcli.js does: write until write() is false, then wait for 'drain'.
function pumpInto(req, source) {
  source.on('data', chunk => {
    if (req.write(chunk) === false) {
      source.pause();
      req.once('drain', () => source.resume());
    }
  });
  source.on('end', () => req.end());
}

// B's local server: hashes and counts a request body; `paused` holds the reader back until resumed.
function receivingHandler(received, { paused = false } = {}) {
  return (req, res) => {
    if (req.url !== '/v1/upload') return res.end('fast');
    const hash = crypto.createHash('sha256');
    received.req = req;
    received.complete = false;
    if (paused) req.pause();
    req.on('data', chunk => {
      if (received.bytes === 0) received.firstAt = Date.now();
      received.bytes += chunk.length;
      hash.update(chunk);
    });
    req.on('end', () => {
      received.complete = true;
      received.hash = hash.digest('hex');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ bytes: received.bytes }));
    });
    req.on('close', () => { received.closed = true; });
    return undefined;
  };
}

function startUpload(hub, linkId, onResponse = () => {}) {
  const req = hub.request(new URL('/v1/upload', `${tunnelBase(linkId)}/`), { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, timeout: 30_000 }, onResponse);
  return req;
}

test('B announces the body it takes in its hello; a B that announces nothing is held to the old 64 MiB', async t => {
  const hub = createHub();
  const link = await startLink(t, { hub, client: { maxRequestBodyBytes: 3 * 1024 * 1024 } });
  assert.equal(hub.requestBodyLimit(link.linkId), 3 * 1024 * 1024);
  assert.equal(hub.requestBodyLimit(crypto.randomUUID()), null, 'offline: unknown');
  const defaults = await startLink(t, { hub });
  assert.equal(hub.requestBodyLimit(defaults.linkId), 1024 * 1024 * 1024);

  // An older B: the same protocol version, a hello without maxBody.
  const linkId = crypto.randomUUID();
  const acceptor = await startAcceptor(t, hub, linkId);
  const old = new WebSocket(`ws://127.0.0.1:${acceptor.port}/v1/service-links/tunnel`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  t.after(() => old.terminate());
  old.on('open', () => old.send(JSON.stringify({ t: 'hello', v: 1, side: 'client', window: 512 * 1024, linkId })));
  await until(() => hub.isOnline(linkId), 'the old client hello');
  assert.equal(hub.requestBodyLimit(linkId), LEGACY_REQUEST_BODY_BYTES);
  assert.equal(LEGACY_REQUEST_BODY_BYTES, 64 * 1024 * 1024);
});

test('A stops a body above the limit B announced and cancels the stream', async t => {
  const hub = createHub();
  const received = { bytes: 0 };
  const link = await startLink(t, { hub, handler: receivingHandler(received), client: { maxRequestBodyBytes: 256 * 1024 } });
  const failure = new Promise(resolve => {
    const req = startUpload(hub, link.linkId);
    req.on('error', resolve);
    pumpInto(req, generatedBody(1024 * 1024).stream);
  });
  assert.equal((await failure).message, 'TUNNEL_BODY_TOO_LARGE');
  // The cancel may come before B's local request has even connected; either way B never sees a complete body.
  await delay(200);
  assert.ok(!received.req || received.closed, 'no local request is left open');
  assert.notEqual(received.complete, true);
  assert.ok(received.bytes <= 256 * 1024);
  await until(() => hub.streamCount(link.linkId) === 0, 'the stream to be released');
  assert.equal((await hubCall(hub, link.linkId, '/v1/fast')).body, 'fast');
});

test('a 256 MiB upload streams through: B reads it while A is still sending, and A never holds more than about one window', async t => {
  const total = 256 * 1024 * 1024;
  const hub = createHub({ heartbeatMs: 60_000 });
  const received = { bytes: 0 };
  const link = await startLink(t, { hub, handler: receivingHandler(received) });
  const body = generatedBody(total);
  let producedAtFirstByte = null;
  let maxQueued = 0;
  let maxBuffers = 0;
  const baseline = process.memoryUsage().arrayBuffers;
  const sampler = setInterval(() => {
    if (producedAtFirstByte === null && received.bytes > 0) producedAtFirstByte = body.produced;
    for (const channel of hub.tunnels.get(link.linkId).streams.values()) maxQueued = Math.max(maxQueued, channel.queuedBytes);
    maxBuffers = Math.max(maxBuffers, process.memoryUsage().arrayBuffers - baseline);
  }, 5);
  t.after(() => clearInterval(sampler));
  const answer = await new Promise((resolve, reject) => {
    const req = startUpload(hub, link.linkId, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    pumpInto(req, body.stream);
  });
  clearInterval(sampler);
  assert.deepEqual(answer, { status: 200, body: { bytes: total } });
  assert.equal(received.hash, await hashOf(total), 'every byte arrived once and in order');
  assert.ok(producedAtFirstByte !== null && producedAtFirstByte < 16 * 1024 * 1024, `B started reading after ${producedAtFirstByte} bytes were produced`);
  // One window (512 KiB) plus the chunk that crossed it.
  assert.ok(maxQueued <= 512 * 1024 + 64 * 1024, `queued on A at most ${maxQueued}`);
  // A and B run in this process: all their buffers together stay far below the body (garbage not yet collected counts too).
  assert.ok(maxBuffers < 96 * 1024 * 1024, `buffers grew by at most ${maxBuffers}`);
  await until(() => hub.streamCount(link.linkId) === 0, 'the stream to be released');
});

test('a receiver that stops reading holds the uploader back after a bounded amount, with a small window too', async t => {
  const total = 24 * 1024 * 1024;
  const hub = createHub({ heartbeatMs: 60_000, streamWindowBytes: 128 * 1024 });
  const received = { bytes: 0 };
  const link = await startLink(t, { hub, handler: receivingHandler(received, { paused: true }), client: { streamWindowBytes: 128 * 1024 } });
  const body = generatedBody(total);
  const answer = new Promise((resolve, reject) => {
    const req = startUpload(hub, link.linkId, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    pumpInto(req, body.stream);
  });
  await until(() => received.req, 'the request to reach B');
  await delay(300);
  const heldAt = body.produced;
  await delay(300);
  assert.equal(body.produced, heldAt, 'the producer on A waits');
  // What is in flight: about one window each on A and in the tunnel, and the loopback socket buffers of B's local hop.
  assert.ok(heldAt < 12 * 1024 * 1024, `held after ${heldAt} bytes`);
  // Meanwhile other streams on the same tunnel keep working.
  assert.equal((await hubCall(hub, link.linkId, '/v1/fast', { timeout: 2000 })).body, 'fast');
  received.req.resume();
  assert.equal(await answer, 200);
  assert.equal(received.bytes, total);
  assert.equal(received.hash, await hashOf(total));
});

test('an uploader that leaves mid-way cancels the local request on B, frees the stream, and the tunnel keeps working', async t => {
  const hub = createHub();
  const received = { bytes: 0 };
  const link = await startLink(t, { hub, handler: receivingHandler(received) });
  const req = startUpload(hub, link.linkId);
  const events = [];
  req.on('error', error => events.push(error.message));
  req.on('close', () => events.push('close'));
  const body = generatedBody(512 * 1024 * 1024);
  pumpInto(req, body.stream);
  await until(() => received.bytes > 2 * 1024 * 1024, 'part of the body to arrive');
  body.stream.pause();
  req.destroy();
  await until(() => received.closed, 'the local request to stop');
  assert.equal(received.complete, false, 'never seen as a complete body');
  await until(() => hub.streamCount(link.linkId) === 0, 'the stream to be released');
  assert.ok(events.includes('close'));
  assert.ok(body.produced < 64 * 1024 * 1024, 'nothing was read ahead');
  assert.equal((await hubCall(hub, link.linkId, '/v1/fast')).body, 'fast');
  assert.equal(hub.tunnels.get(link.linkId).sending.size, 0, 'nothing left in the pump');
});

test('a tunnel that dies mid-upload fails the request with REMOTE_OFFLINE and stops the local request on B', async t => {
  const hub = createHub();
  const received = { bytes: 0 };
  const link = await startLink(t, { hub, handler: receivingHandler(received) });
  const body = generatedBody(512 * 1024 * 1024);
  const failure = new Promise(resolve => {
    const req = startUpload(hub, link.linkId);
    req.on('error', resolve);
    pumpInto(req, body.stream);
  });
  await until(() => received.bytes > 2 * 1024 * 1024, 'part of the body to arrive');
  hub.drop(link.linkId);
  assert.equal((await failure).message, 'REMOTE_OFFLINE');
  body.stream.destroy();
  await until(() => received.closed, 'the local request to stop');
  assert.equal(received.complete, false);
});
