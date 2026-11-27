'use strict';
// The page server's way to VS Code on THIS engine: an in-process call to the engine's VS Code manager (services/vscode-web.js, getVscodeWeb()), with
// no token and no HTTP hop. A remote engine is reached over HTTP or a service link instead (services/vscode-proxy.js). This module only adapts the
// manager's interface to the calls the proxy and the page routes make, so a change of that interface stays here. See "Transports" in
// docs/design/vscode-web-proxy.md for the shape each call is expected to have.
//
// start / status / acceptLicense({ taskId, terminalId, host, proto, owner }) -> the Contract A answer
//   ({ state, error?, detail?, folder, base_path, open_path, engine_id }, or { accepted: true }); a refusal rejects with an Error whose message is the
//   code (TASK_NOT_FOUND, VSCODE_DISABLED, ...) and whose statusCode is the HTTP status.
// request({ method, path, headers, body, host, proto, signal }) -> Promise<{ status, headers, body }>: `path` is the browser path under
//   /vscode/<engine id>/ with its query (the same string VS Code's --server-base-path serves), `headers` already filtered to the allowlist,
//   `body` a readable stream or null, `signal` aborts it; `body` of the answer is a readable stream.
// openWebSocket({ path, headers, host, proto }) -> an object that behaves like a `ws` WebSocket (open, message, close, error; send, close,
//   terminate, readyState, bufferedAmount), bridged to the browser by the proxy so that logout can close it (clientSessionId on the browser side).

const { PassThrough } = require('node:stream');

let override = null;
let vscodeOverride = null; // tests: a manager made with createVscodeWeb (services/vscode-web.js) behind the real adapter

// The real manager has a slightly different shape (docs/design/vscode-web.md, "The local transport"): the Contract A answer is built by
// routes/vscode-web-engine.js from a task row, `request` takes a callback and the body is piped in, and there is no `upgrade` here (the page server
// holds the browser's socket itself and bridges through `openWebSocket`). This object is the real manager as the proxy sees it.
function realManager() {
  const vscode = vscodeOverride || require('./vscode-web').getVscodeWeb();
  const answer = ({ taskId, terminalId, host, proto, owner }, start) => {
    const task = require('../db').prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(taskId, owner);
    if (!task) throw Object.assign(new Error('TASK_NOT_FOUND'), { statusCode: 404 });
    return require('../routes/vscode-web-engine').vscodeTerminalAnswer({ task, terminalId, start, body: { host, proto } });
  };
  return {
    start: async args => answer(args, true),
    status: async args => answer(args, false),
    acceptLicense: async () => { vscode.acceptLicense(); return { accepted: true }; },
    request: ({ method, path: target, headers, body, host, signal }) => new Promise((resolve, reject) => {
      let req;
      try {
        req = vscode.request({ method, path: target, headers, host }, res => {
          // The manager already reads `res` (its idle timer listens to 'data'), so a late reader would miss the first chunks: hand out a buffered copy.
          const body = new PassThrough();
          res.on('error', error => body.destroy(error));
          res.pipe(body);
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      } catch (error) { reject(error); return; }
      req.on('error', reject);
      if (signal) {
        if (signal.aborted) req.destroy(); else signal.addEventListener('abort', () => req.destroy(), { once: true });
      }
      if (body && typeof body.pipe === 'function') body.pipe(req); else req.end(body || undefined);
    }),
    openWebSocket: args => vscode.openWebSocket(args),
  };
}

function manager() {
  return override || realManager();
}

// Tests replace the manager with a fake one; null restores the real one.
function setManagerForTests(fake) {
  override = fake || null;
}

function setVscodeForTests(vscode) {
  vscodeOverride = vscode || null;
}

module.exports = {
  start: args => manager().start(args),
  status: args => manager().status(args),
  acceptLicense: args => manager().acceptLicense(args),
  request: args => manager().request(args),
  openWebSocket: args => manager().openWebSocket(args),
  setManagerForTests,
  setVscodeForTests,
};
