// Rules and skills sync (services/rule-sync.js). Two routers: the Engine API a source pushes to (/v1/rule-sync, admin tokens: a service link's token is one)
// and the browser's settings (/api/rule-sync, the normal login). See "Rules and skills sync" in DESIGN.md.
const express = require('express');
const { RuleSyncError } = require('../services/rule-sync');

const defaultService = () => require('../services/rule-sync').getRuleSync();
// The bundle carries up to 20 MiB of files as base64. server.js parses /v1 bodies up to 32 MB first; this parser is for the router on its own.
const BUNDLE_LIMIT = '30mb';

function sendError(res, error) {
  if (error instanceof RuleSyncError) return res.status(error.statusCode).json({ error: error.code, ...error.extra });
  if (error && error.type === 'entity.too.large') return res.status(413).json({ error: 'RULE_SYNC_TOO_LARGE', limit: 'total' });
  console.error('[rule-sync]', error && error.message);
  return res.status(500).json({ error: 'RULE_SYNC_FAILED' });
}
const handle = handler => async (req, res) => {
  try { res.json(await handler(req)); } catch (error) { sendError(res, error); }
};

// GET /status and PUT /bundle. A receiver has no route that reads its rules or skills: it only accepts pushes.
function createEngineRouter({ getService = defaultService, guard = require('../middleware/engine-auth')('engine:admin') } = {}) {
  const router = express.Router();
  router.get('/status', guard, handle(() => getService().receiverStatus()));
  router.put('/bundle', guard, express.json({ limit: BUNDLE_LIMIT }), handle(req => getService().receive(req.body)));
  router.use((error, req, res, next) => (res.headersSent ? next(error) : sendError(res, error)));
  return router;
}

function createBrowserRouter({ getService = defaultService, requireAuth = require('../middleware/auth'), clientOrigin = require('../middleware/client-origin') } = {}) {
  const router = express.Router();
  router.use(clientOrigin, requireAuth);
  router.use(express.json({ limit: '64kb' }));
  router.get('/', handle(() => getService().overview()));
  router.put('/', handle(req => getService().update(req.body)));
  router.post('/create-shared', handle(() => getService().createShared()));
  router.post('/push', handle(() => getService().pushNow()));
  router.post('/reset-source', handle(() => getService().resetSource()));
  router.post('/remove-import', handle(() => getService().removeImport()));
  return router;
}

module.exports = { createEngineRouter, createBrowserRouter, BUNDLE_LIMIT };
