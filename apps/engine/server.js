require('dotenv').config();
const http = require('http');
const WebSocket = require('ws');
const { createEngineApp } = require('./app');
const terminal = require('../../routes/terminal');
const { consumeTerminalTicket, pruneExpiredTickets } = require('../../services/terminal-tickets');

const host = process.env.ENGINE_HOST || '127.0.0.1';
const port = Number.parseInt(process.env.ENGINE_PORT || process.env.PORT || '3100', 10);
const app = createEngineApp();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://engine.local');
  const match = url.pathname.match(/^\/v1\/terminal-sessions\/(\d+)\/stream$/);
  if (!match) {
    socket.destroy();
    return;
  }
  pruneExpiredTickets();
  const authorization = consumeTerminalTicket(url.searchParams.get('ticket'));
  if (!authorization || Number(match[1]) !== authorization.taskId) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    terminal.handleWs(ws, req, { login: authorization.principalId }, authorization.taskId);
  });
});

server.listen(port, host, () => {
  console.log(`T-Agent Engine listening on http://${host}:${port}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down Engine`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
