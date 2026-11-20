// The mind map sync between linked services (services/mindmap-sync.js; "Mind maps on every engine" in docs/design/mind-maps.md).
//   GET  /v1/mindmap-sync                                                -> { instance_id, public_key, company, max_seq, have }
//   POST /v1/mindmap-sync/pull { instance_id, public_key, after, max_bytes } -> { instance_id, sealed }: a page of entries after `after`
//   POST /v1/mindmap-sync/pull { instance_id, public_key, ids }          -> { instance_id, sealed }: those entries (a company computer reading a map)
//   POST /v1/mindmap-sync/pull { instance_id, public_key, list: true }   -> { instance_id, sealed }: every map's summary (a company computer's list)
//   PUT  /v1/mindmap-sync { instance_id, public_key, sealed }             -> { applied, have }
// Only a token issued for a live service link gets in (403 LINKED_ONLY for any other Engine token), like /v1/learn-sync. Maps only ever travel inside
// the sealed envelopes. 404 with the sync turned off; 409 MINDMAP_COMPANY_COMPUTER on a company computer, which takes part only through its home.
// The body goes through the server's global JSON parser (32 MB; a page holds one map of up to 8 MB at most, plus small ones up to the page size).
const express = require('express');

const CODE = /^[A-Z0-9_]{1,64}$/;
function send(res, error, next) {
  const status = error && error.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) return res.status(status).json({ error: CODE.test(error.message || '') ? error.message : 'INVALID_MINDMAP_SYNC' });
  return next(error);
}

function createEngineMindmapSyncRouter(options = {}) {
  const {
    service = () => require('../services/mindmap-sync').getMindmapSync(),
    serviceLinks = () => require('../services/service-links').getServiceLinks(),
    requireEngineAuth = require('../middleware/engine-auth'),
    enabled = () => require('../services/mindmap-sync').syncEnabled(),
  } = options;
  const router = express.Router();
  router.use((req, res, next) => (enabled() ? next() : res.status(404).json({ error: 'NOT_FOUND' })));
  router.use(requireEngineAuth(), (req, res, next) => {
    const link = serviceLinks().linkForToken(req.engineAuth.tokenId);
    if (!link || link.revoked) return res.status(403).json({ error: 'LINKED_ONLY' });
    req.serviceLink = link;
    next();
  });
  const handle = run => async (req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json(await run(req)); } catch (error) { send(res, error, next); }
  };
  router.get('/', handle(req => service().engineDescribe(req.serviceLink)));
  router.post('/pull', handle(req => service().enginePull(req.serviceLink, req.body)));
  router.put('/', handle(req => service().enginePush(req.serviceLink, req.body)));
  return router;
}

module.exports = { createEngineMindmapSyncRouter };
