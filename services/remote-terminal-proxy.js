const WebSocket = require('ws');
const db = require('../db');
const config = require('../config');
const { decryptToken } = require('../lib/token-crypto');
const { request } = require('./remote-client');

function rejectUpgrade(socket, status, message) {
  if (!socket.destroyed) {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }
}

async function handleRemoteTerminalUpgrade(req, socket, head, wss, user) {
  const url = new URL(req.url, 'http://client.local');
  const match = url.pathname.match(/^\/api\/remote-servers\/(\d+)\/terminal\/ws$/);
  if (!match) return false;
  const taskId = Number.parseInt(url.searchParams.get('taskId'), 10);
  if (!taskId) {
    rejectUpgrade(socket, 400, 'Bad Request');
    return true;
  }

  const server = db.prepare('SELECT * FROM remote_servers WHERE id = ? AND owner_id = ?')
    .get(match[1], user.login);
  if (!server) {
    rejectUpgrade(socket, 404, 'Not Found');
    return true;
  }

  try {
    const token = decryptToken(server.token_cipher, config.sessionSecret);
    const terminalSession = await request(server.base_url, '/v1/terminal-sessions', token, {
      method: 'POST',
      body: { task_id: taskId },
    });
    const upstreamUrl = new URL(terminalSession.websocket_path, `${server.base_url}/`);
    upstreamUrl.protocol = upstreamUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const upstream = new WebSocket(upstreamUrl, { handshakeTimeout: 10_000 });

    let settled = false;
    upstream.once('open', () => {
      settled = true;
      wss.handleUpgrade(req, socket, head, downstream => {
        const closeBoth = (code = 1000, reason = '') => {
          if (downstream.readyState === WebSocket.OPEN) downstream.close(code, reason);
          if (upstream.readyState === WebSocket.OPEN) upstream.close(code, reason);
        };
        downstream.on('message', (data, binary) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        });
        upstream.on('message', (data, binary) => {
          if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary });
        });
        downstream.on('close', (code, reason) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.close(code, reason.toString());
        });
        upstream.on('close', (code, reason) => {
          if (downstream.readyState === WebSocket.OPEN) downstream.close(code, reason.toString());
        });
        downstream.on('error', () => closeBoth(1011, 'Client connection error'));
        upstream.on('error', () => closeBoth(1011, 'Engine connection error'));
      });
    });
    upstream.once('error', () => {
      if (!settled) rejectUpgrade(socket, 502, 'Bad Gateway');
    });
  } catch {
    rejectUpgrade(socket, 502, 'Bad Gateway');
  }
  return true;
}

module.exports = { handleRemoteTerminalUpgrade };
