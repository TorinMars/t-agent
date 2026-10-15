const express = require('express');
const service = require('../services/file-sync-instance');
const requireAuth = require('../middleware/auth');
const requireEngineAuth = require('../middleware/engine-auth');

function reply(res, error) {
  const code = /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'SYNC_FAILED';
  res.status(error.statusCode || 400).json({ error: code });
}
const pairAttempts = new Map();
function rateLimitPair(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (pairAttempts.get(key) || []).filter(time => now - time < 60_000);
  if (recent.length >= 10) return res.status(429).json({ error: 'PAIRING_RATE_LIMITED' });
  recent.push(now);
  pairAttempts.set(key, recent);
  next();
}
function handler(action) {
  return async (req, res) => {
    try { res.json(await action(req)); }
    catch (error) { reply(res, error); }
  };
}
function mount(router, auth, browser = false) {
  router.get('/', auth, handler(() => service.status()));
  router.post('/run', auth, handler(async () => { await service.tick(); return service.status(); }));
  router.put('/files', auth, handler(req => service.setFiles(req.body.files)));
  router.put('/path', auth, handler(req => service.setPath(req.body)));
  router.post('/disconnect', auth, handler(() => service.disconnect()));
  router.put('/role', auth, handler(req => service.setRole(req.body.role)));
  router.post('/unpair', auth, handler(() => service.unpair()));
  // The master generates a connection string; the slave pastes it to connect (the master is on the public network, so the slave always connects out to it).
  router.post('/invite', auth, handler(req => service.createInvite(req.body.master_url || `${req.protocol}://${req.get('host')}`)));
  router.post('/join', auth, handler(req => service.joinInvite(req.body.connection_string)));
  router.post('/resolve', auth, handler(req => service.resolveConflict(req.body.path)));
  if (!browser) {
    // The slave exchanges the one-time sync pairing code in the connection string for a file-sync token; authenticated by the pairing code, no Token required, rate limited.
    router.post('/pair', rateLimitPair, handler(req => service.exchangeSyncCode(req.body || {})));
    // Sync endpoints accept the file-sync token; slaves from before 2.46.0 still use an engine token, which keeps working.
    const syncAuth = (req, res, next) => {
      const match = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
      if (match && service.verifyToken(match[1])) return next();
      return auth(req, res, next);
    };
    router.get('/manifest', syncAuth, handler(() => service.manifest()));
    router.put('/file', syncAuth, handler(req => service.receive(req.body)));
    router.post('/heartbeat', syncAuth, handler(req => service.registerChild(req.body)));
    router.delete('/heartbeat', syncAuth, handler(req => service.unregisterChild(req.body)));
  }
}
const browser = express.Router();
mount(browser, requireAuth, true);
const engine = express.Router();
mount(engine, requireEngineAuth('engine:admin'));
module.exports = { browser, engine };
