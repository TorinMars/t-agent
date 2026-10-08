const express = require('express');
const clientOrigin = require('../middleware/client-origin');
const { createAppsService } = require('../services/apps-service');
const { createPm2Manager } = require('../services/pm2-manager');
const { AppsError } = require('../services/apps-registry');

const parseId = value => (/^\d{1,9}$/.test(String(value)) ? Number(value) : NaN);

// 本机路由（/api/apps）和 Engine 路由（/v1/apps）共用：只做业务，鉴权由调用方的中间件负责。
// 每个处理函数返回 { status, body }。
function createAppsHandlers(service) {
  const idOf = req => {
    const id = parseId(req.params.id);
    if (!Number.isInteger(id)) throw new AppsError('APP_NOT_FOUND', '找不到这个应用', 404);
    return id;
  };
  return {
    list: async () => ({ status: 200, body: await service.list() }),
    create: async req => ({ status: 201, body: { app: service.registry.create(req.body) } }),
    update: async req => ({ status: 200, body: { app: service.registry.update(idOf(req), req.body) } }),
    remove: async req => ({ status: 200, body: await service.remove(idOf(req)) }),
    register: async req => {
      const { app, created } = service.registry.register(req.body);
      return { status: created ? 201 : 200, body: { app, created } };
    },
    restoreHidden: async () => ({ status: 200, body: { restored: service.registry.restoreHidden() } }),
  };
}

// 错误只返回稳定的错误码和中文说明，不暴露内部细节。
function sendError(res, error) {
  if (error instanceof AppsError) return res.status(error.statusCode).json({ error: error.code, message: error.message });
  console.error('[apps]', error && error.message);
  return res.status(500).json({ error: 'APPS_UNAVAILABLE', message: '应用列表服务暂时不可用' });
}

function route(handler) {
  return async (req, res) => {
    try {
      const { status, body } = await handler(req);
      res.status(status).json(body);
    } catch (error) { sendError(res, error); }
  };
}

function defaultService() {
  return createAppsService({ db: require('../db'), pm2Manager: createPm2Manager() });
}

// 在任意 router 上挂载应用接口（本机路由和 Engine 路由复用）。guard 是每条路由前的鉴权中间件。
function mountAppsRoutes(router, handlers, ...guard) {
  router.get('/', ...guard, route(handlers.list));
  router.post('/', ...guard, route(handlers.create));
  // 固定路径要放在 /:id 之前
  router.post('/register', ...guard, route(handlers.register));
  router.post('/restore-hidden', ...guard, route(handlers.restoreHidden));
  router.put('/:id', ...guard, route(handlers.update));
  router.delete('/:id', ...guard, route(handlers.remove));
  return router;
}

function createAppsRouter(options = {}) {
  const handlers = createAppsHandlers(options.service || defaultService());
  const router = express.Router();
  router.use(clientOrigin, options.requireAuth || require('../middleware/auth'));
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  return mountAppsRoutes(router, handlers);
}

module.exports = { createAppsRouter, createAppsHandlers, mountAppsRoutes, defaultService };
