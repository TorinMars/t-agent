const express = require('express');
const service = require('../services/file-sync-instance');
const requireAuth = require('../middleware/auth');
const requireEngineAuth = require('../middleware/engine-auth');

function reply(res, error) {
  const code = /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'SYNC_FAILED';
  res.status(error.statusCode || 400).json({ error: code });
}
const adoptAttempts = new Map();
function rateLimitAdopt(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (adoptAttempts.get(key) || []).filter(time => now - time < 60_000);
  if (recent.length >= 10) return res.status(429).json({ error: 'PAIRING_RATE_LIMITED' });
  recent.push(now);
  adoptAttempts.set(key, recent);
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
  router.post('/refresh-code', auth, handler(() => { service.pairingCode(true); return service.status(); }));
  router.post('/associate', auth, handler(req => service.associate({
    slaveUrl: req.body.slave_url, slaveCode: req.body.code, masterUrl: req.body.master_url,
  })));
  router.post('/resolve', auth, handler(req => service.resolveConflict(req.body.path)));
  if (!browser) {
    // 凭从服务器界面上显示的配对码接受关联，因此不要求 Token；限流并在猜错多次后换码。
    router.post('/adopt', rateLimitAdopt, handler(req => service.adopt({
      code: req.body.code, masterUrl: req.body.master_url, masterCode: req.body.master_code,
    })));
    // 从服务器用主服务器给的一次性同步配对码换取文件同步令牌；同样不要求 Token，限流。
    router.post('/pair', rateLimitAdopt, handler(req => service.exchangeSyncCode(req.body || {})));
    // 同步接口接受文件同步令牌；2.46.0 之前的从服务器还在用引擎令牌，仍可使用。
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
