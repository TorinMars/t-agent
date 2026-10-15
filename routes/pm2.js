const express = require('express');
const clientOrigin = require('../middleware/client-origin');
const { createPm2Manager, Pm2Error } = require('../services/pm2-manager');

const parseId = value => (/^\d{1,9}$/.test(String(value)) ? Number(value) : NaN);

// Shared by the local routes and the Engine's /v1/pm2: PM2 operations only; authentication is the caller's middleware's job.
function createPm2Handlers(manager = createPm2Manager()) {
  return {
    status: () => manager.status(),
    logs: req => manager.logs(parseId(req.params.id), String(req.query.stream || 'out'), req.query.lines),
    control: async req => ({ process: await manager.control(parseId(req.params.id), req.params.action) }),
  };
}

// Manages PM2 processes on the machine running the Client; the machine of a remote Engine is managed through the Engine endpoint (/v1/pm2).
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
    return res.status(500).json({ error: 'PM2 management is temporarily unavailable' });
  });
  return router;
}

module.exports = { createPm2Router, createPm2Handlers };
