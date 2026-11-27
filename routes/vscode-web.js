'use strict';
// VS Code in the browser on the page's origin: `ALL /vscode/<engine id>/*` and its WebSocket upgrade (services/vscode-proxy.js). Mounted in server.js
// right after the access gate, without the page session and before the login gate: it authenticates itself with the `ta_vscode` cookie (or the
// launch ticket of the first visit) and answers everything else with the login gate's 404. Not under /api, whose gate wants X-Requested-With and sets
// no-store. Text answers are compressed here, since VS Code is asked for uncompressed ones (the tunnel drops content-encoding); only after the
// authentication, so that a refusal is exactly the 404 of an unknown address.
const express = require('express');
const compression = require('compression');
const { getVscodeProxy } = require('../services/vscode-proxy');

function createVscodeWebRouter({ proxy = getVscodeProxy } = {}) {
  const router = express.Router();
  const compress = compression();
  router.use((req, res) => proxy().handleHttp(req, res, { compress }));
  return router;
}

// server.js calls this for every upgrade before its fallthrough; true when the path was under /vscode/ and has been answered.
function handleVscodeUpgrade(req, socket, head, wss, { proxy = getVscodeProxy } = {}) {
  return proxy().handleUpgrade(req, socket, head, wss);
}

module.exports = { createVscodeWebRouter, handleVscodeUpgrade };
