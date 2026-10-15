const express = require('express');
const path = require('node:path');
const clientOrigin = require('../middleware/client-origin');
const { createFrpService, FrpError } = require('../services/frp');

function defaultService() {
  const config = require('../config');
  const dataDir = process.env.T_AGENT_DATA_DIR ? path.resolve(process.env.T_AGENT_DATA_DIR) : path.join(__dirname, '..', 'data');
  return createFrpService({ db: require('../db'), secret: config.sessionSecret, dataDir, localPort: config.port, localHost: config.host });
}

// 管理运行 Client 的这台机器上的 frpc 进程。只支持本机，不经 Engine 代理。
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
  router.post('/install', wrap(() => service.install()));
  router.post('/stop', wrap(() => service.stop()));
  router.post('/regenerate-port', wrap(() => service.regenerate()));

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof FrpError) return res.status(error.statusCode).json({ error: error.code, message: error.message });
    console.error('[frp]', error && error.message);
    return res.status(500).json({ error: 'FRP_UNAVAILABLE', message: '内网穿透服务暂时不可用' });
  });
  router.service = service;
  return router;
}

module.exports = { createFrpRouter };
