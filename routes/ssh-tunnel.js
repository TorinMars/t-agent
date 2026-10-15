const express = require('express');
const clientOrigin = require('../middleware/client-origin');
const { FrpError } = require('../services/frp');
const { createSshTunnelService } = require('../services/ssh-tunnel');

function defaultService() {
  const config = require('../config');
  return createSshTunnelService({ db: require('../db'), localPort: config.port, localHost: config.host });
}

// 管理运行 Client 的这台机器上的 ssh 反向隧道进程。只支持本机。
function createSshTunnelRouter(options = {}) {
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
  router.post('/stop', wrap(() => service.stop()));
  router.post('/regenerate-port', wrap(() => service.regenerate()));

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof FrpError) return res.status(error.statusCode).json({ error: error.code, message: error.message });
    console.error('[ssh-tunnel]', error && error.message);
    return res.status(500).json({ error: 'SSH_UNAVAILABLE', message: 'SSH 隧道服务暂时不可用' });
  });
  router.service = service;
  return router;
}

module.exports = { createSshTunnelRouter };
