// The remote terminal proxy (services/remote-terminal-proxy.js) forwards the page's binary control frames to the owner Engine unchanged, so the
// `presence` message reaches the Engine whose terminal it is (its T-Attention notifiers check it). The Engine routes, the ticket check and the
// proxy are the real ones; only the PTY is a fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-remote-presence-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'remote-presence-test-secret-remote-presence-test';
fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
const shells = [];
const stubModule = (name, exports) => { const file = require.resolve(name); require.cache[file] = { id: file, filename: file, loaded: true, exports }; };
stubModule('../lib/node-pty-runtime', { repairSpawnHelperPermissions() {} });
stubModule('node-pty', { spawn(shell, args, options) {
  const pty = { pid: process.pid, options, input: [], killed: false, onData() {}, onExit(fn) { this.exit = fn; }, write(text) { this.input.push(text); }, pause() {}, resume() {}, resize() {}, kill() { this.killed = true; this.exit?.(); } };
  shells.push(pty);
  return pty;
} });
const db = require('../db');
const WebSocket = require('ws');
const express = require('express');
const { createAccessToken } = require('../services/engine-auth');
const { encryptToken } = require('../lib/token-crypto');
const { consumeTerminalTicket } = require('../services/terminal-tickets');
const engineTasks = require('../services/engine-tasks');
const terminal = require('../routes/terminal');
const { handleRemoteTerminalUpgrade } = require('../services/remote-terminal-proxy');

const servers = [];
test.after(async () => {
  for (const row of db.prepare('SELECT id FROM tasks').all()) terminal.closeTaskTerminals(row.id);
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); })));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
const listen = server => new Promise(resolve => { servers.push(server); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });

test('a presence frame sent through the remote proxy reaches the Engine as a control; text stays input', async () => {
  // The Engine: /v1 routes and the terminal stream upgrade as server.js does it (ticket -> handleWs).
  const engineApp = express();
  engineApp.use(express.json());
  engineApp.use('/v1', require('../routes/engine-v1'));
  const engineServer = http.createServer(engineApp);
  const engineWss = new WebSocket.Server({ noServer: true });
  engineServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://engine.local');
    const match = url.pathname.match(/^\/v1\/terminal-sessions\/(\d+)\/stream$/);
    const authorization = match && consumeTerminalTicket(url.searchParams.get('ticket'));
    if (!authorization) { socket.destroy(); return; }
    engineWss.handleUpgrade(req, socket, head, ws => terminal.handleWs(ws, req, { login: authorization.principalId }, authorization.taskId, authorization.terminalId));
  });
  const enginePort = await listen(engineServer);
  const engine = `http://127.0.0.1:${enginePort}`;
  const token = createAccessToken(db, { principalId: 'owner' }).token;
  const remoteId = db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
    .run('owner', 'engine', engine, encryptToken(token, process.env.SESSION_SECRET)).lastInsertRowid;
  const task = engineTasks.createTask('owner', { title: 'remote presence' });
  const terminalId = terminal.createTerminal(task.id).terminal_id;
  // The Client: the proxy's upgrade.
  const gateway = http.createServer();
  const wss = new WebSocket.Server({ noServer: true });
  gateway.on('upgrade', (req, socket, head) => { void handleRemoteTerminalUpgrade(req, socket, head, wss, { login: 'owner' }); });
  const gatewayPort = await listen(gateway);
  const client = new WebSocket(`ws://127.0.0.1:${gatewayPort}/api/remote-servers/${remoteId}/terminal/ws?taskId=${task.id}&terminalId=${terminalId}&clientId=page&proto=2`);
  await new Promise((resolve, reject) => { client.once('message', resolve); client.once('error', reject); }); // the history snapshot
  const until = async (check, what) => {
    for (let i = 0; i < 100 && !check(); i += 1) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(check(), what);
  };
  client.send(Buffer.from(JSON.stringify({ type: 'presence', foreground: true })), { binary: true });
  await until(() => terminal.isTerminalForeground(task.id, terminalId), 'the Engine got the presence');
  client.send(Buffer.from(JSON.stringify({ type: 'presence', foreground: false })), { binary: true });
  await until(() => !terminal.isTerminalForeground(task.id, terminalId), 'and its change');
  client.send(Buffer.from(JSON.stringify({ type: 'presence', foreground: true })), { binary: true });
  client.send('echo hi', { binary: false });
  const shell = shells.at(-1);
  await until(() => shell.input.length === 1, 'text input arrived');
  assert.deepEqual(shell.input, ['echo hi'], 'the control frames never reached the PTY');
  assert.equal(terminal.isTerminalForeground(task.id, terminalId), true);
  client.close();
  await until(() => !terminal.isTerminalForeground(task.id, terminalId), 'closing the page socket ends the presence on the Engine');
});
