// "Open in VS Code" on the engine (docs/design/vscode-web.md): the proxied browser traffic of Contract B and the shared answer of Contract A.
//
//   ALL /v1/vscode/web/<hostB64>/<rest...>   (mounted at /vscode/web by routes/engine-v1.js; Bearer token, scope terminal:execute)
//   WebSocket upgrade on the same path       (server.js calls handleVscodeUpgrade before the fallthrough that destroys unknown sockets)
//
// <hostB64> is the base64url of the public host the browser sees (X-Forwarded-Host). <rest> is everything after /vscode/<engine id>/ in the
// browser's address; VS Code runs with --server-base-path /vscode/<engine id>, so the path is passed on as it is. The token check, the header rules
// and the VS Code connection token are in services/vscode-web.js (request / upgrade). server.js keeps the body parsers off /v1/vscode/, so a body
// is streamed through untouched.
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const requireEngineAuth = require('../middleware/engine-auth');
const { getVscodeWeb, HOST_PATTERN } = require('../services/vscode-web');

const SCOPE = 'terminal:execute';

// `/<hostB64>/<rest>?query` -> { host, rest } or null. `rest` is '' or starts with / or ?, and keeps its raw encoding and query.
function parseWebTarget(url) {
  const match = /^\/([A-Za-z0-9_-]{1,400})([/?].*)?$/s.exec(String(url || ''));
  if (!match) return null;
  let host;
  try { host = Buffer.from(match[1], 'base64url').toString('utf8'); } catch { return null; }
  if (!HOST_PATTERN.test(host)) return null;
  const rest = match[2] || '/';
  return { host, rest: rest.startsWith('?') ? `/${rest}` : rest };
}

// The browser path VS Code serves for `rest` (its query included).
const vscodePath = (manager, rest) => `${manager.basePath()}${rest}`;

function createVscodeWebEngineRouter({ getManager = getVscodeWeb, authenticate = requireEngineAuth(SCOPE) } = {}) {
  const router = express.Router();
  router.use(authenticate, (req, res) => {
    const manager = getManager();
    const target = parseWebTarget(req.url);
    if (!target) return res.status(404).json({ error: 'VSCODE_PATH_INVALID' });
    let upstream;
    try {
      upstream = manager.request({ method: req.method, path: vscodePath(manager, target.rest), headers: req.headers, host: target.host }, answer => {
        // The engine's own frame-ancestors policy is not VS Code's: the page server sets the browser's headers.
        res.removeHeader('Content-Security-Policy');
        res.status(answer.statusCode);
        for (const [name, value] of Object.entries(answer.headers)) res.setHeader(name, value);
        answer.pipe(res);
        answer.on('error', () => res.destroy());
      });
    } catch (error) {
      return res.status(error.statusCode || 503).json({ error: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'VSCODE_NOT_RUNNING' });
    }
    upstream.on('error', () => {
      if (!res.headersSent) res.status(502).json({ error: 'VSCODE_PROXY_FAILED' });
      else res.destroy();
    });
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
    return undefined;
  });
  return router;
}

// The Bearer check of requireEngineAuth (middleware/engine-auth.js) for an upgrade request: { ok } or { status }.
function authorizeBearer(header, scope = SCOPE, { lookup = null } = {}) {
  const { authenticateAccessToken, hasScope } = require('../services/engine-auth');
  const match = /^Bearer\s+(.+)$/i.exec(String(header || ''));
  if (!match) return { status: 401 };
  const token = lookup ? lookup(match[1]) : authenticateAccessToken(require('../db'), match[1]);
  if (!token) return { status: 401 };
  if (!hasScope(token.scopes, scope)) return { status: 403 };
  return { ok: true, token };
}

const PREFIX = /^\/v1\/vscode\/web(?=\/)/i;
function handleVscodeUpgrade(req, socket, head, { getManager = getVscodeWeb, lookup = null } = {}) {
  const refuse = (status, text) => {
    if (!socket.destroyed) { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); socket.destroy(); }
  };
  const auth = authorizeBearer(req.headers.authorization, SCOPE, { lookup });
  if (!auth.ok) return refuse(auth.status, auth.status === 403 ? 'Forbidden' : 'Unauthorized');
  const target = PREFIX.test(req.url) ? parseWebTarget(req.url.replace(PREFIX, '')) : null;
  if (!target) return refuse(404, 'Not Found');
  const manager = getManager();
  return manager.upgrade(req, socket, head, { path: vscodePath(manager, target.rest), host: target.host });
}

const isDirectory = dir => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } };

// The folder VS Code opens for a terminal: its own work dir, else the task folder, else the home folder of the terminal user. Never from the client.
// Throws TERMINAL_NOT_FOUND (404) for a terminal the task does not have.
function resolveFolder(task, terminalId) {
  const terminal = require('./terminal');
  const id = terminal.assertTerminal(task.id, terminalId);
  const candidates = [terminal.terminalWorkDir(task, id), task.work_dir, task.md_path && path.dirname(task.md_path)];
  const found = candidates.find(dir => dir && path.isAbsolute(dir) && isDirectory(dir));
  if (found) return path.resolve(found);
  const user = require('../lib/terminal-user').resolveTerminalUser().user;
  return user ? user.home : os.homedir();
}

// The answer of Contract A for a task row this caller may see: GET (start false) reads the status, POST (start true) starts VS Code with
// `body` { host, proto }. Also the answer of the page server's local route (/api/tasks/:id/terminals/:terminalId/vscode).
async function vscodeTerminalAnswer({ task, terminalId, start = false, body = {}, manager = getVscodeWeb() }) {
  const folder = resolveFolder(task, terminalId);
  const status = start ? await manager.ensure({ host: body && body.host, proto: body && body.proto }) : await manager.check();
  const answer = { ...status, folder, open_path: `${status.base_path}/?folder=${encodeURIComponent(folder)}` };
  // The browser's VS Code reads the token from its own `vscode-tkn` cookie: the page server sets it when it exchanges the launch ticket and takes it
  // out of the answer before the browser sees it ("The connection token" in docs/design/vscode-web-proxy.md).
  const tkn = status.state === 'ready' && typeof manager.connectionToken === 'function' ? manager.connectionToken() : null;
  if (tkn) answer.connection_token = tkn;
  return answer;
}

module.exports = { createVscodeWebEngineRouter, handleVscodeUpgrade, authorizeBearer, parseWebTarget, resolveFolder, vscodeTerminalAnswer, SCOPE };
