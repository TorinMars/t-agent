// One login for linked engines (services/sign-in-handover.js; "One login for linked engines" in docs/design/failover-and-one-login.md).
//
// Page (behind the session and the same-origin gates of /api, like every setting and every change):
//   GET  /api/sign-in-handover/settings        -> { accept }        this engine accepts hand-overs from its linked engines (device scope, default on)
//   PUT  /api/sign-in-handover/settings        { accept }           (a linked engine's switch: /api/device-settings/<id>/sign-in-handover/settings)
//   GET  /api/sign-in-handover/peers           -> { instance_id, name, accepting, peers: [{ instance_id, name, online, supported, accepting, addresses }] }
//   POST /api/sign-in-handover                 { target, nonce_hash } -> { token, name, instance_id, addresses, expires_in }
// The hand-over itself is made only by this POST: never by a GET, and the token is in the answer body, never in a URL the server sees.
// Linked engines: GET /v1/sign-in-handover -> { accepting, addresses } (link tokens only, like /v1/settings-sync).
const express = require('express');

const CODE = /^[A-Z0-9_]{1,64}$/;
function send(res, error) {
  const status = error && error.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 600) return res.status(status).json({ error: CODE.test(error.message || '') ? error.message : 'HANDOVER_FAILED' });
  return res.status(500).json({ error: 'HANDOVER_FAILED' });
}

// The switch alone, for this page and (mounted again by routes/device-settings.js) for a linked engine's page.
function createSettingsRouter({ service = () => require('../services/sign-in-handover').getSignInHandover() } = {}) {
  const router = express.Router();
  router.get('/settings', (req, res) => res.set('Cache-Control', 'no-store').json({ accept: service().accepting() }));
  router.put('/settings', (req, res) => {
    try { res.json({ accept: service().setAccepting((req.body || {}).accept) }); } catch (error) { send(res, error); }
  });
  return router;
}

function createSignInHandoverRouter({ service = () => require('../services/sign-in-handover').getSignInHandover() } = {}) {
  const router = express.Router();
  router.use(createSettingsRouter({ service }));
  router.get('/peers', async (req, res) => {
    try { res.set('Cache-Control', 'no-store').json(await service().peersFor(req.session.user.login)); } catch (error) { send(res, error); }
  });
  router.post('/', async (req, res) => {
    const body = req.body || {};
    try {
      res.set('Cache-Control', 'no-store').status(201).json(await service().issue({ ownerId: req.session.user.login, session: req.session, target: body.target, nonceHash: body.nonce_hash }));
    } catch (error) { send(res, error); }
  });
  return router;
}

function createEngineSignInHandoverRouter(options = {}) {
  const {
    service = () => require('../services/sign-in-handover').getSignInHandover(),
    serviceLinks = require('../services/service-links').getServiceLinks(),
    requireEngineAuth = require('../middleware/engine-auth'),
  } = options;
  const router = express.Router();
  router.use(requireEngineAuth(), (req, res, next) => {
    const link = serviceLinks.linkForToken(req.engineAuth.tokenId);
    if (!link || link.revoked) return res.status(403).json({ error: 'LINKED_ONLY' });
    next();
  });
  router.get('/', (req, res) => res.set('Cache-Control', 'no-store').json(service().describeForPeer()));
  return router;
}

module.exports = { createSignInHandoverRouter, createEngineSignInHandoverRouter, createSettingsRouter };
