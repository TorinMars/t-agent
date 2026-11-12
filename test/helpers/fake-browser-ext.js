// A fake T-Agent browser extension for tests (no real browser): an HTTP server with the bridge's upgrade (services/browser-bridge.js) and a
// `ws` client that says hello and answers commands with a handler.
const http = require('node:http');
const WebSocket = require('ws');
const { createBrowserBridge, METHODS } = require('../../services/browser-bridge');

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

function memoryDb() {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
  db.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY, user_id TEXT)');
  return db;
}

// An HTTP server whose upgrades go to the bridge, plus whatever Express app is given for plain requests.
async function bridgeServer({ app = null, bridgeOptions = {}, db = memoryDb() } = {}) {
  const bridge = createBrowserBridge({ db, serverName: () => 'T01', isLocal: () => true, log: () => {}, ...bridgeOptions });
  const server = http.createServer(app || ((req, res) => { res.statusCode = 404; res.end(); }));
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname === '/api/browser-ext/ws') bridge.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    bridge.closeAll();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  return { bridge, server, base, db, close, wsUrl: `${base.replace('http', 'ws')}/api/browser-ext/ws` };
}

// Opens a socket. Resolves with { ws, messages, closed (a promise of { code, reason }), status (for a refused upgrade) }.
function openSocket(wsUrl, { origin = ORIGIN, headers = {} } = {}) {
  return new Promise(resolve => {
    const ws = new WebSocket(wsUrl, { headers: { ...(origin ? { Origin: origin } : {}), ...headers } });
    const messages = [];
    let closedResolve;
    const closed = new Promise(done => { closedResolve = done; });
    ws.on('message', data => messages.push(JSON.parse(data.toString())));
    ws.on('close', (code, reason) => closedResolve({ code, reason: reason.toString() }));
    ws.on('unexpected-response', (req, res) => { resolve({ ws, messages, closed, status: res.statusCode }); ws.terminate(); });
    ws.on('error', () => {});
    ws.on('open', () => resolve({ ws, messages, closed, status: 101 }));
  });
}

const waitFor = async (check, { timeoutMs = 3000, stepMs = 10 } = {}) => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
};

// A connected fake extension: hello with the token, then every `cmd` goes to `handler(method, params, cmd)`, which returns a result, throws
// { code, message } for an error answer, or returns `fakeExtension.SILENT` to never answer.
const SILENT = Symbol('silent');
async function fakeExtension(wsUrl, token, { handler = () => ({}), methods = METHODS, protocol = 1, version = '1.0.0', origin } = {}) {
  const socket = await openSocket(wsUrl, { origin });
  const commands = [];
  socket.ws.on('message', async data => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'cmd') return;
    commands.push(message);
    try {
      const result = await handler(message.method, message.params, message);
      if (result === SILENT) return;
      socket.ws.send(JSON.stringify({ type: 'result', id: message.id, ok: true, result }));
    } catch (error) {
      socket.ws.send(JSON.stringify({ type: 'result', id: message.id, ok: false, error: { code: error.code || 'INTERNAL', message: error.message } }));
    }
  });
  socket.ws.send(JSON.stringify({ type: 'hello', token, version, protocol, browser: { name: 'Chrome', user_agent: 'Mozilla/5.0 Test' }, methods }));
  const first = await Promise.race([waitFor(() => socket.messages[0], { timeoutMs: 3000 }), socket.closed.then(close => ({ type: 'closed', ...close }))]);
  return {
    ...socket, commands, welcome: first,
    event: (event, data) => socket.ws.send(JSON.stringify({ type: 'event', event, data })),
    send: message => socket.ws.send(JSON.stringify(message)),
    close: () => socket.ws.close(),
  };
}
fakeExtension.SILENT = SILENT;

module.exports = { ORIGIN, memoryDb, bridgeServer, openSocket, fakeExtension, waitFor, SILENT };
