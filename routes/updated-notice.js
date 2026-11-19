// "Updated to v…" (services/updated-notice.js; "Notice after an update" in docs/design/update-check-and-versions.md).
//
// Page (mounted under /api/system, behind the session and same-origin gates of /api, per owner):
//   GET  /api/system/updated-notice -> { show: false } | { show: true, version, previous_version, updated_at, engine_name, notes: [{ version, note }],
//                                      linked: [{ id, name, version }] }
//   POST /api/system/updated-notice { version, linked?: [{ id, version }] } -> { acknowledged, linked: [{ id, acknowledged }] } (400 INVALID_UPDATED_NOTICE)
// Linked services (capability `updated-notice`; only a token issued for a live service link gets in, 403 LINKED_ONLY for any other Engine token):
//   GET  /v1/updated-notice         -> { pending: false, name } | { pending: true, version, previous_version, updated_at, name }
//   POST /v1/updated-notice/ack { version } -> { acknowledged }
const express = require('express');

const CODE = /^[A-Z0-9_]{1,64}$/;
function send(res, error, next) {
  const status = error && error.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) return res.status(status).json({ error: CODE.test(error.message || '') ? error.message : 'INVALID_UPDATED_NOTICE' });
  return next(error);
}

// The page's routes; the router that mounts them (routes/system.js) has already checked the session.
function createUpdatedNoticeRouter({ service = () => require('../services/updated-notice').getUpdatedNotice() } = {}) {
  const router = express.Router();
  const owner = req => req.session.user.login;
  router.get('/', async (req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json(await service().view(owner(req))); } catch (error) { send(res, error, next); }
  });
  router.post('/', async (req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json(await service().acknowledge(owner(req), req.body || {})); } catch (error) { send(res, error, next); }
  });
  return router;
}

function createEngineUpdatedNoticeRouter(options = {}) {
  const {
    service = () => require('../services/updated-notice').getUpdatedNotice(),
    serviceLinks = () => require('../services/service-links').getServiceLinks(),
    requireEngineAuth = require('../middleware/engine-auth'),
  } = options;
  const router = express.Router();
  router.use(requireEngineAuth(), (req, res, next) => {
    const link = serviceLinks().linkForToken(req.engineAuth.tokenId);
    if (!link || link.revoked) return res.status(403).json({ error: 'LINKED_ONLY' });
    next();
  });
  router.get('/', (req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json(service().engineDescribe()); } catch (error) { send(res, error, next); }
  });
  router.post('/ack', (req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json(service().engineAcknowledge(req.body || {})); } catch (error) { send(res, error, next); }
  });
  return router;
}

module.exports = { createUpdatedNoticeRouter, createEngineUpdatedNoticeRouter };
