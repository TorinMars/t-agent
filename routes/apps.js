const express = require('express');
const clientOrigin = require('../middleware/client-origin');
const { createAppsService } = require('../services/apps-service');
const { createPm2Manager } = require('../services/pm2-manager');
const { AppsError } = require('../services/apps-registry');

const parseId = value => (/^\d{1,9}$/.test(String(value)) ? Number(value) : NaN);

// Shared by the local routes (/api/apps) and the Engine routes (/v1/apps): business logic only; authentication is the caller's middleware's job.
// Every handler returns { status, body }.
function createAppsHandlers(service) {
  const idOf = req => {
    const id = parseId(req.params.id);
    if (!Number.isInteger(id)) throw new AppsError('APP_NOT_FOUND', 'App not found', 404);
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

// Errors only return a stable error code and a message, never internal details.
function sendError(res, error) {
  if (error instanceof AppsError) return res.status(error.statusCode).json({ error: error.code, message: error.message });
  console.error('[apps]', error && error.message);
  return res.status(500).json({ error: 'APPS_UNAVAILABLE', message: 'The app list service is temporarily unavailable' });
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

// Mount the app endpoints on any router (reused by the local routes and the Engine routes). guard is the authentication middleware in front of every route.
function mountAppsRoutes(router, handlers, ...guard) {
  router.get('/', ...guard, route(handlers.list));
  router.post('/', ...guard, route(handlers.create));
  // fixed paths must come before /:id
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
