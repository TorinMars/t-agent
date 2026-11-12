// Settings sync across linked devices (services/settings-sync.js). See "Settings sync across linked devices" in DESIGN.md.
//
// Page: GET /api/settings-sync -> { supported, scopes, keys, peers, telegram } (which setting groups are shared, per device or Telegram's, how far each
// shared one has reached, and `telegram` { sender_name, self, conflict } of the device that sends Telegram now, or null when none has it: from the cache
// of services/attention-relay.js, never a wait), POST /api/settings-sync/now -> a round with every online linked peer, then the same answer. Behind the session and the
// same-origin gates of /api. No value, key or hash is in either answer. With the sync turned off: { supported: false }, every group 'device'.
// Linked services: GET /v1/settings-sync[?public_key=], POST /v1/settings-sync/pull { instance_id, public_key, keys } -> { instance_id, sealed },
// PUT /v1/settings-sync { instance_id, public_key, sealed } -> { applied, ignored }. Only a token issued for a live service link gets in, like
// /v1/task-order; any other Engine token is 403 LINKED_ONLY. Values are only ever inside the sealed envelopes.
const express = require('express');

const CODE = /^[A-Z0-9_]{1,64}$/;
function send(res, error, next) {
  const status = error && error.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) return res.status(status).json({ error: CODE.test(error.message || '') ? error.message : 'INVALID_SETTINGS_SYNC' });
  return next(error);
}

// Who sends Telegram, for the scope label: null without a relay (or when it fails), so the label keeps its general text.
function telegramSender(relay) {
  try { return relay && typeof relay.summary === 'function' ? relay.summary('telegram') : null; } catch { return null; }
}

function createSettingsSyncRouter({
  service = require('../services/settings-sync').getSettingsSync(),
  requireAuth = require('../middleware/auth'),
  getRelay = () => require('../services/attention-relay').getDefaultRelay(),
} = {}) {
  const router = express.Router();
  router.use(requireAuth);
  const { syncEnabled, SCOPES } = require('../services/settings-sync');
  const answer = () => ({ ...service.view(), telegram: telegramSender(getRelay()) });
  // Turned off on this service (SETTINGS_SYNC_ENABLED=false): every setting stays on this device.
  const off = () => ({ supported: false, scopes: Object.fromEntries(Object.entries(SCOPES).map(([group, scope]) => [group, scope === 'shared' ? 'device' : scope])), keys: [], peers: [] });
  router.get('/', (req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json(syncEnabled() ? answer() : off()); } catch (error) { send(res, error, next); }
  });
  router.post('/now', async (req, res, next) => {
    try {
      if (!syncEnabled()) return res.set('Cache-Control', 'no-store').json(off());
      await service.syncAll();
      res.set('Cache-Control', 'no-store').json(answer());
    } catch (error) { send(res, error, next); }
  });
  return router;
}

function createEngineSettingsSyncRouter(options = {}) {
  const {
    service = require('../services/settings-sync').getSettingsSync(),
    serviceLinks = require('../services/service-links').getServiceLinks(),
    requireEngineAuth = require('../middleware/engine-auth'),
  } = options;
  const router = express.Router();
  router.use((req, res, next) => (require('../services/settings-sync').syncEnabled() ? next() : res.status(404).json({ error: 'NOT_FOUND' })));
  router.use(requireEngineAuth(), (req, res, next) => {
    const link = serviceLinks.linkForToken(req.engineAuth.tokenId);
    if (!link || link.revoked) return res.status(403).json({ error: 'LINKED_ONLY' });
    req.serviceLink = link;
    next();
  });
  router.get('/', (req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json(service.engineDescribe(req.serviceLink, req.query.public_key)); }
    catch (error) { send(res, error, next); }
  });
  router.post('/pull', (req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json(service.enginePull(req.serviceLink, req.body)); }
    catch (error) { send(res, error, next); }
  });
  router.put('/', (req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json(service.enginePush(req.serviceLink, req.body)); }
    catch (error) { send(res, error, next); }
  });
  return router;
}

module.exports = { createSettingsSyncRouter, createEngineSettingsSyncRouter };
