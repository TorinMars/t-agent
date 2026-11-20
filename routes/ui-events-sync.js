// The usage data sync between linked services (services/ui-events-sync.js; "Merged across linked devices" in docs/design/usage-data.md).
//   GET  /v1/usage-sync                                      -> { instance_id, public_key, company, max_seq, have }
//   POST /v1/usage-sync/pull { instance_id, public_key, after, limit } -> { instance_id, sealed }
//   PUT  /v1/usage-sync { instance_id, public_key, sealed }   -> { applied, have }
//   GET  /v1/usage-sync/summary?days&layout&engine&client     -> the summary of the merged set, which a company computer shows (as /api/ui-events/summary)
// Only a token issued for a live service link gets in (403 LINKED_ONLY for any other Engine token), like /v1/learn-sync. Rows only ever travel
// inside the sealed envelopes. 404 with the sync turned off; 409 USAGE_COMPANY_COMPUTER on a company computer, which takes part only through its home.
const express = require('express');

const CODE = /^[A-Z0-9_]{1,64}$/;
function send(res, error, next) {
  const status = error && error.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) return res.status(status).json({ error: CODE.test(error.message || '') ? error.message : 'INVALID_USAGE_SYNC' });
  return next(error);
}

function createEngineUsageSyncRouter(options = {}) {
  const {
    service = () => require('../services/ui-events-sync').getUsageSync(),
    serviceLinks = () => require('../services/service-links').getServiceLinks(),
    requireEngineAuth = require('../middleware/engine-auth'),
    enabled = () => require('../services/ui-events-sync').syncEnabled(),
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
  router.get('/', handle(req => service().engineDescribe(req.serviceLink)));
  router.post('/pull', handle(req => service().enginePull(req.serviceLink, req.body)));
  router.put('/', handle(req => service().enginePush(req.serviceLink, req.body)));
  router.get('/summary', handle(req => service().engineSummary(req.serviceLink, req.query)));
  return router;
}

module.exports = { createEngineUsageSyncRouter };
