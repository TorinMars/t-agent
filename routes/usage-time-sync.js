// The usage time and memories sync between linked services (services/usage-time-sync.js; "Sync across linked devices" in docs/design/usage-time.md).
//   GET    /v1/usage-sync/time                                     -> { instance_id, public_key, company, max_seq, have }
//   POST   /v1/usage-sync/time/pull { instance_id, public_key, after, limit } -> { instance_id, sealed }
//   PUT    /v1/usage-sync/time { instance_id, public_key, sealed }  -> { applied, have }
//   GET    /v1/usage-sync/time/summary|task|day|memories?...       -> what a company computer shows (as /api/usage-time/... and /api/memories)
//   PATCH  /v1/usage-sync/time/memories/:uid, DELETE ...            -> a company computer's edit or delete of a memory kept here
// Only a token issued for a live service link gets in (403 LINKED_ONLY). 404 with the sync turned off; 409 USAGE_COMPANY_COMPUTER on a company
// computer, which takes part only through its home.
const express = require('express');

const CODE = /^[A-Z0-9_]{1,64}$/;
function send(res, error, next) {
  const status = error && error.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) return res.status(status).json({ error: CODE.test(error.message || '') ? error.message : 'INVALID_USAGE_TIME_SYNC' });
  return next(error);
}

function createEngineUsageTimeSyncRouter(options = {}) {
  const {
    service = () => require('../services/usage-time-sync').getUsageTimeSync(),
    serviceLinks = () => require('../services/service-links').getServiceLinks(),
    requireEngineAuth = require('../middleware/engine-auth'),
    enabled = () => require('../services/usage-time-sync').syncEnabled(),
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
  for (const what of ['summary', 'task', 'day', 'memories']) router.get(`/${what}`, handle(req => service().engineRead(req.serviceLink, what, { ...req.query })));
  router.patch('/memories/:uid', handle(req => service().engineMemory(req.serviceLink, 'PATCH', req.params.uid, req.body)));
  router.delete('/memories/:uid', handle(req => service().engineMemory(req.serviceLink, 'DELETE', req.params.uid)));
  return router;
}

module.exports = { createEngineUsageTimeSyncRouter };
