// The T-Attention read copies between linked services (services/attention-copy.js; docs/design/attention-copies.md).
//   GET  /v1/attention-copy                                      -> { instance_id, public_key, max_seq, have }
//   POST /v1/attention-copy/pull { instance_id, public_key, after, limit } -> { instance_id, sealed }
//   PUT  /v1/attention-copy { instance_id, public_key, sealed }   -> { applied, have }
// Only a token issued for a live service link gets in (403 LINKED_ONLY for any other Engine token), like /v1/usage-sync. Rows only ever travel inside
// the sealed envelopes. 404 with the copies turned off.
const express = require('express');

const CODE = /^[A-Z0-9_]{1,64}$/;
function send(res, error, next) {
  const status = error && error.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) return res.status(status).json({ error: CODE.test(error.message || '') ? error.message : 'INVALID_ATTENTION_COPY' });
  return next(error);
}

function createEngineAttentionCopyRouter(options = {}) {
  const {
    service = () => require('../services/attention-copy').getAttentionCopy(),
    serviceLinks = () => require('../services/service-links').getServiceLinks(),
    requireEngineAuth = require('../middleware/engine-auth'),
    enabled = () => require('../services/attention-copy').syncEnabled(),
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
  return router;
}

module.exports = { createEngineAttentionCopyRouter };
