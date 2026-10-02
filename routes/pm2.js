const express = require('express');
const clientOrigin = require('../middleware/client-origin');
const { createPm2Manager, Pm2Error } = require('../services/pm2-manager');

// 管理运行 Client 的这台机器上的 PM2 进程。
function createPm2Router(options = {}) {
  const manager = options.manager || createPm2Manager();
  const router = express.Router();
  router.use(clientOrigin, options.requireAuth || require('../middleware/auth'));
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const parseId = value => (/^\d{1,9}$/.test(String(value)) ? Number(value) : NaN);
  const wrap = handler => async (req, res, next) => {
    try { res.json(await handler(req)); } catch (error) { next(error); }
  };

  router.get('/status', wrap(() => manager.status()));
  router.get('/:id/logs', wrap(req => manager.logs(parseId(req.params.id), String(req.query.stream || 'out'), req.query.lines)));
  router.post('/:id/:action', wrap(async req => ({ process: await manager.control(parseId(req.params.id), req.params.action) })));

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof Pm2Error) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    return res.status(500).json({ error: 'PM2 管理服务暂时不可用' });
  });
  return router;
}

module.exports = { createPm2Router };
