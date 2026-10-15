// Access-mode gate: in local-only mode and while no mode has been chosen (unset), only direct access from this machine is accepted;
// every other address (including requests forwarded by a reverse proxy / tunnel, or whose Host is not a loopback name) gets a 404 identical to a non-existent route.
// In local-only mode, sessions from this machine are marked as trusted and no authenticator is needed.
const { isLocalInitialization } = require('../services/client-auth');
const { sendNotFound } = require('./login-gate');

function createAccessGate({ getMode }) {
  return function accessGate(req, res, next) {
    const mode = getMode();
    if (mode === 'remote') return next();
    if (!isLocalInitialization(req)) return sendNotFound(req, res);
    if (mode === 'local' && req.session && req.session.localTrusted !== true) req.session.localTrusted = true;
    next();
  };
}

// WebSocket upgrade requests have no Express response object, so they are checked separately.
function upgradeAllowed(req, mode) {
  return mode === 'remote' || isLocalInitialization(req);
}

module.exports = { createAccessGate, upgradeAllowed };
