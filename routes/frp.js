const express = require('express');
const path = require('node:path');
const clientOrigin = require('../middleware/client-origin');
const { createFrpService, FrpError } = require('../services/frp');

function defaultService() {
  const config = require('../config');
  const dataDir = process.env.T_AGENT_DATA_DIR ? path.resolve(process.env.T_AGENT_DATA_DIR) : path.join(__dirname, '..', 'data');
  return createFrpService({ db: require('../db'), secret: config.sessionSecret, dataDir, localPort: config.port, localHost: config.host });
}

// Manages the frpc process on the machine running the Client. Local only, not proxied through an Engine.
function createFrpRouter(options = {}) {
  const service = options.service || defaultService();
  const router = express.Router();
  router.use(clientOrigin, options.requireAuth || require('../middleware/auth'));
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const wrap = handler => (req, res, next) => {
    try { res.json(handler(req)); } catch (error) { next(error); }
  };
  router.get('/', wrap(() => service.view()));
  router.put('/config', wrap(req => service.update(req.body)));
  router.post('/start', wrap(() => service.start()));
  router.post('/detect', wrap(() => service.detect()));
  router.post('/install', wrap(() => service.install()));
  router.post('/stop', wrap(() => service.stop()));
  router.post('/regenerate-port', wrap(() => service.regenerate()));

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof FrpError) return res.status(error.statusCode).json({ error: error.code, message: error.message });
    console.error('[frp]', error && error.message);
    return res.status(500).json({ error: 'FRP_UNAVAILABLE', message: 'The tunnel service is temporarily unavailable' });
  });
  router.service = service;
  return router;
}

module.exports = { createFrpRouter };
