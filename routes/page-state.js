// The shared page state (services/page-state.js; docs/design/shared-page-state.md).
//
// Page (behind the session and same-origin gates of /api, per owner):
//   GET /api/page-state -> { instance_id, recent: [{ instance, task, terminal, title, agent, used }], keys: { <name>: value | null }, peers }
//   PUT /api/page-state { recent?: [change], keys?: { <name>: value | null }, import?: { recent, keys } } -> the same as GET (400 INVALID_PAGE_STATE)
// Linked services (only a token issued for a live service link gets in, 403 LINKED_ONLY for any other Engine token; 404 with the sync off):
//   GET  /v1/page-state?public_key=                -> { instance_id, public_key, digest }
//   POST /v1/page-state/pull { instance_id, public_key } -> { instance_id, sealed }
//   PUT  /v1/page-state { instance_id, public_key, sealed } -> { changed }
const express = require('express');

const CODE = /^[A-Z0-9_]{1,64}$/;
function send(res, error, next) {
  const status = error && error.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) return res.status(status).json({ error: CODE.test(error.message || '') ? error.message : 'INVALID_PAGE_STATE' });
  return next(error);
}

function createPageStateRouter({ service = () => require('../services/page-state').getPageState(), requireAuth = require('../middleware/auth'), clientOrigin = require('../middleware/client-origin') } = {}) {
  const router = express.Router();
  router.use(clientOrigin, requireAuth);
  const owner = req => req.session.user.login;
  const answer = view => ({ ...view, peers: service().peers() });
  router.get('/', (req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json(answer(service().read(owner(req)))); } catch (error) { send(res, error, next); }
  });
  router.put('/', (req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json(answer(service().change(owner(req), req.body))); } catch (error) { send(res, error, next); }
  });
  return router;
}

function createEnginePageStateRouter(options = {}) {
  const {
    service = () => require('../services/page-state').getPageState(),
    serviceLinks = () => require('../services/service-links').getServiceLinks(),
    requireEngineAuth = require('../middleware/engine-auth'),
    enabled = () => require('../services/page-state').syncEnabled(),
  } = options;
  const router = express.Router();
  router.use((req, res, next) => (enabled() ? next() : res.status(404).json({ error: 'NOT_FOUND' })));
  router.use(requireEngineAuth(), (req, res, next) => {
    const link = serviceLinks().linkForToken(req.engineAuth.tokenId);
    if (!link || link.revoked) return res.status(403).json({ error: 'LINKED_ONLY' });
    req.serviceLink = link;
    next();
  });
  const handle = run => (req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json(run(req)); } catch (error) { send(res, error, next); }
  };
  router.get('/', handle(req => service().engineDescribe(req.serviceLink, typeof req.query.public_key === 'string' ? req.query.public_key : '')));
  router.post('/pull', handle(req => service().enginePull(req.serviceLink, req.body)));
  router.put('/', handle(req => service().enginePush(req.serviceLink, req.body)));
  return router;
}

module.exports = { createPageStateRouter, createEnginePageStateRouter };
