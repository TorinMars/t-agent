// The shared task order (services/task-order.js). See "Shared task order" in DESIGN.md.
//
// Page: GET /api/task-order -> { order: [key, ...], updated_at }, PUT { order } -> the stored value. Behind the session and same-origin gates of /api, per
// owner, like routes/task-list-prefs.js.
// Linked services: GET /v1/task-order and PUT { order, updated_at } (stored only when newer). Only a token issued for a live service link gets in, like
// /v1/linked-services; any other Engine token is 403 LINKED_ONLY. A PUT here is never sent on to another service.
const express = require('express');

const send = (res, error, next) => (error && error.statusCode === 400 ? res.status(400).json({ error: error.message }) : next(error));

function createTaskOrderRouter({ service = require('../services/task-order').getTaskOrder(), requireAuth = require('../middleware/auth') } = {}) {
  const router = express.Router();
  router.use(requireAuth);
  const owner = req => req.session.user.login;
  router.get('/', (req, res) => res.set('Cache-Control', 'no-store').json(service.get(owner(req))));
  router.put('/', (req, res, next) => {
    try { res.json(service.setLocal(owner(req), req.body && req.body.order)); }
    catch (error) { send(res, error, next); }
  });
  return router;
}

function createEngineTaskOrderRouter(options = {}) {
  const {
    service = require('../services/task-order').getTaskOrder(),
    serviceLinks = require('../services/service-links').getServiceLinks(),
    requireEngineAuth = require('../middleware/engine-auth'),
    // The account a browser session gets, so that the order the page saved is the one a peer reads.
    owner = () => require('../services/single-user').ensureSingleUser().login,
  } = options;
  const router = express.Router();
  router.use(requireEngineAuth(), (req, res, next) => {
    const link = serviceLinks.linkForToken(req.engineAuth.tokenId);
    if (!link || link.revoked) return res.status(403).json({ error: 'LINKED_ONLY' });
    next();
  });
  router.get('/', (req, res) => res.set('Cache-Control', 'no-store').json(service.get(owner())));
  router.put('/', (req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json(service.accept(owner(), req.body)); }
    catch (error) { send(res, error, next); }
  });
  return router;
}

module.exports = { createTaskOrderRouter, createEngineTaskOrderRouter };
