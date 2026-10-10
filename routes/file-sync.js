const express = require('express');
const service = require('../services/file-sync-instance');
const db = require('../db');
const requireAuth = require('../middleware/auth');
const requireEngineAuth = require('../middleware/engine-auth');

function reply(res, error) {
  const code = /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'SYNC_FAILED';
  res.status(error.statusCode || 400).json({ error: code });
}
function handler(action) {
  return async (req, res) => {
    try { res.json(await action(req)); }
    catch (error) { reply(res, error); }
  };
}
function mount(router, auth, browser = false) {
  router.get('/', auth, handler(() => service.status()));
  router.get('/servers', auth, handler(() => db.prepare('SELECT id, name, base_url FROM remote_servers WHERE enabled = 1 ORDER BY name').all()));
  router.post('/run', auth, handler(async () => { await service.tick(); return service.status(); }));
  router.put('/files', auth, handler(req => service.setFiles(req.body.files)));
  router.put('/path', auth, handler(req => service.setPath(req.body)));
  router.post('/connect', auth, handler(req => service.connect(req.body.server_id)));
  router.post('/disconnect', auth, handler(() => service.disconnect()));
  router.post('/resolve', auth, handler(req => service.resolveConflict(req.body.path)));
  if (!browser) {
    router.get('/manifest', auth, handler(() => service.manifest()));
    router.put('/file', auth, handler(req => service.receive(req.body)));
    router.post('/heartbeat', auth, handler(req => service.registerChild(req.body)));
    router.delete('/heartbeat', auth, handler(req => service.unregisterChild(req.body)));
  }
}
const browser = express.Router();
mount(browser, requireAuth, true);
const engine = express.Router();
mount(engine, requireEngineAuth('engine:admin'));
module.exports = { browser, engine };
