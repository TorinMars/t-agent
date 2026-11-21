// The English learning sync between linked services (services/learn-sync.js; "Sync across linked devices" in docs/design/learn-english.md).
//   GET  /v1/learn-sync                                     -> { instance_id, public_key, company, max_seq, have }
//   POST /v1/learn-sync/pull { instance_id, public_key, after, limit, cards_only } -> { instance_id, sealed }
//   PUT  /v1/learn-sync { instance_id, public_key, sealed }  -> { applied, have }
//   GET  /v1/learn-sync/summary, PUT /v1/learn-sync/settings, POST /v1/learn-sync/starter: what a company computer asks its home (the summary, the
//   settings and the starter list live on the normal machines); the same answers as /api/learn.
//   GET  /v1/learn-sync/mistakes?limit=&before=, GET /v1/learn-sync/reports, GET /v1/learn-sync/report?uid=, POST /v1/learn-sync/analyze { lang }:
//   the wrong answers and the mistake reports of the home for a company computer's page (an analysis runs on the home).
//   GET  /v1/learn-sync/level, POST /v1/learn-sync/level-check: the estimated level and the picking of the home for a company computer's page (an
//   estimate runs on the home; the same answers as GET /api/learn/level and POST /api/learn/level/check).
//   GET  /v1/learn-sync/ask?kind=&norm=, POST /v1/learn-sync/ask { kind, norm, question, mode, state }: the questions about a card for a company
//   computer's page (the card named by kind and normalized text; the model is asked on the home, and the answer comes as one JSON { messages }).
// Only a token issued for a live service link gets in (403 LINKED_ONLY for any other Engine token), like /v1/settings-sync. Rows only ever travel
// inside the sealed envelopes. 404 with the sync turned off; 409 LEARN_COMPANY_COMPUTER on a company computer, which takes part only through its home.
const express = require('express');

const CODE = /^[A-Z0-9_]{1,64}$/;
function send(res, error, next) {
  const status = error && error.statusCode;
  // A refusal of the learning service (a check of the settings, an unknown starter list) keeps its English message, as /api/learn answers it.
  if (error instanceof require('../services/learn').LearnError && Number.isInteger(status)) return res.status(status).json({ error: error.message });
  if (Number.isInteger(status) && status >= 400 && status < 500) return res.status(status).json({ error: CODE.test(error.message || '') ? error.message : 'INVALID_LEARN_SYNC' });
  return next(error);
}

function createEngineLearnSyncRouter(options = {}) {
  const {
    service = () => require('../services/learn-sync').getLearnSync(),
    serviceLinks = () => require('../services/service-links').getServiceLinks(),
    requireEngineAuth = require('../middleware/engine-auth'),
    enabled = () => require('../services/learn-sync').syncEnabled(),
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
  router.get('/summary', handle(req => service().engineHome(req.serviceLink, 'summary')));
  router.put('/settings', handle(req => service().engineHome(req.serviceLink, 'settings', req.body)));
  router.post('/starter', handle(req => service().engineHome(req.serviceLink, 'starter', req.body)));
  router.get('/mistakes', handle(req => service().engineHome(req.serviceLink, 'mistakes', { limit: req.query.limit, before: req.query.before })));
  router.get('/reports', handle(req => service().engineHome(req.serviceLink, 'reports')));
  router.get('/report', handle(req => service().engineHome(req.serviceLink, 'report', { uid: req.query.uid })));
  router.post('/analyze', handle(req => service().engineHome(req.serviceLink, 'analyze', req.body)));
  router.get('/level', handle(req => service().engineHome(req.serviceLink, 'level')));
  router.post('/level-check', handle(req => service().engineHome(req.serviceLink, 'level-check')));
  router.get('/ask', handle(req => service().engineHome(req.serviceLink, 'ask-history', { kind: req.query.kind, norm: req.query.norm })));
  router.post('/ask', handle(req => service().engineHome(req.serviceLink, 'ask', req.body)));
  return router;
}

module.exports = { createEngineLearnSyncRouter };
