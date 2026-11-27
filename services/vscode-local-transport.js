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

let override = null;

function manager() {
  if (override) return override;
  return require('./vscode-web').getVscodeWeb();
}

// Tests replace the manager with a fake one; null restores the real one.
function setManagerForTests(fake) {
  override = fake || null;
}

module.exports = {
  start: args => manager().start(args),
  status: args => manager().status(args),
  acceptLicense: args => manager().acceptLicense(args),
  request: args => manager().request(args),
  openWebSocket: args => manager().openWebSocket(args),
  setManagerForTests,
};
