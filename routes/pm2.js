const express = require('express');
const clientOrigin = require('../middleware/client-origin');
const { createPm2Manager, Pm2Error } = require('../services/pm2-manager');

const parseId = value => (/^\d{1,9}$/.test(String(value)) ? Number(value) : NaN);

// 本机路由与 Engine 的 /v1/pm2 共用：只做 PM2 操作，鉴权由调用方的中间件负责。
function createPm2Handlers(manager = createPm2Manager()) {
  return {
    status: () => manager.status(),
    logs: req => manager.logs(parseId(req.params.id), String(req.query.stream || 'out'), req.query.lines),
    control: async req => ({ process: await manager.control(parseId(req.params.id), req.params.action) }),
  };
}

// 管理运行 Client 的这台机器上的 PM2 进程；远程 Engine 所在机器通过 Engine 接口（/v1/pm2）管理。
function createPm2Router(options = {}) {
  const handlers = createPm2Handlers(options.manager);
  const router = express.Router();
  router.use(clientOrigin, options.requireAuth || require('../middleware/auth'));
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const wrap = handler => async (req, res, next) => {
    try { res.json(await handler(req)); } catch (error) { next(error); }
  };

  router.get('/status', wrap(handlers.status));
  router.get('/:id/logs', wrap(handlers.logs));
  router.post('/:id/:action', wrap(handlers.control));

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof Pm2Error) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    return res.status(500).json({ error: 'PM2 管理服务暂时不可用' });
  });
  return router;
}

module.exports = { createPm2Router, createPm2Handlers };
