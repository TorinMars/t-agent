const express = require('express');

// English learning ("API" in docs/design/learn-english.md; services/learn.js). Behind the page login and the same-origin check like every /api route
// (server.js), and again here, so the router is safe wherever it is mounted. Every card belongs to the login of the page.
//   GET   /api/learn/summary                          -> { due, new_today, done_today, goal, streak, words, sentences, mistakes, collecting, starter }
//   GET   /api/learn/queue?mode=review|spell|build|dictation|say|fill|mistakes&limit=20 -> { cards }
//   POST  /api/learn/cards { kind, en, zh?, source, context? } -> { card, created }
//   POST  /api/learn/cards/:id/answer { mode, grade, correct, answer? } -> { card }
//   PATCH /api/learn/cards/:id { zh?, en?, suspended? }  -> { card }
//   GET   /api/learn/cards?kind=word|sentence&q=&limit=50&offset=0 -> { cards, total }
//   POST  /api/learn/meaning { word }                   -> { zh }   (the configured translator; 503 when there is none)
//   POST  /api/learn/starter { list: 'dev' }            -> { added }
//   GET   /api/learn/settings, PUT /api/learn/settings { collect?, daily_goal?, starter? } -> settings
//   GET   /api/learn/status                           -> { company_computer, cache_only, home_name, home_online, waiting }
// The summary also has `device` (the status, plus `offline_copy_at`). On a company computer whose data lives on a normal machine (services/learn-sync.js,
// "Company computer" in docs/design/learn-english.md) the reads first sync with that machine, the summary comes from it (or, while it is away, from the
// cards here and the last copy of its numbers), and settings and the starter list are changed there (503 while it cannot be reached).

// The meaning of one word through the translator the person set up, by the same path as POST /api/translate/word: this Client's own translator, or the
// linked service that shares one (services/linked-capabilities.js).
function translatorLookup() {
  const { createTranslator, TIMEOUT_MS } = require('../services/translator');
  const { getLinkedCapabilities, TIMEOUT_MARGIN_MS } = require('../services/linked-capabilities');
  const translator = createTranslator({ db: require('../db'), sessionSecret: require('../config').sessionSecret });
  const linked = getLinkedCapabilities();
  return (owner, word) => linked.run('translate', {
    configured: () => translator.isConfigured(owner),
    local: () => translator.translateWord(owner, { word }),
    route: '/translate/word', body: { word, context: '' }, timeoutMs: TIMEOUT_MS + TIMEOUT_MARGIN_MS,
  });
}

// `sync`: the learning sync of this server (services/learn-sync.js), or null for none (a test that hands in its own service gets none by default).
function createLearnRouter({ service = null, lookupWord = null, sync, requireAuth = require('../middleware/auth'), clientOrigin = require('../middleware/client-origin') } = {}) {
  const router = express.Router();
  router.use(clientOrigin, requireAuth);
  let syncService = sync === undefined ? (service ? null : undefined) : sync;
  const learnSync = () => {
    if (syncService === undefined) syncService = require('../services/learn-sync').getLearnSync();
    return syncService;
  };
  const cacheOnly = () => { const current = learnSync(); return Boolean(current && current.cacheOnly()); };
  const learn = () => service || (service = require('../services/learn').createLearn({ lookupWord: lookupWord || translatorLookup(), cacheOnly }));
  // A company computer reads through its home: the cards here are brought up to date first (a few seconds at most; offline, the cache as it is).
  const fresh = async () => { if (cacheOnly()) await learnSync().refresh(); };
  const status = () => { const current = learnSync(); return current ? current.status() : { company_computer: false, cache_only: false, home_name: null, home_online: null, waiting: 0 }; };
  const owner = req => req.session.user.login;
  const fail = (res, error) => {
    const status = error && error.statusCode;
    // The translator's "not set up" (409 there) is 503 here: Learn cannot get a meaning until the person sets up the translation service.
    if (status === 409 && error.message === 'Translation service not configured yet') return res.status(503).json({ error: error.message });
    if (error && error.name === 'LinkedServiceError') return res.status(status).json(error.body);
    if (Number.isInteger(status) && status >= 400 && status <= 599) return res.status(status).json({ error: error.message });
    console.warn(`Learn: ${error && error.message}`);
    return res.status(500).json({ error: 'Learning data is not available right now' });
  };
  const handle = run => async (req, res) => {
    try { res.json(await run(req)); } catch (error) { fail(res, error); }
  };

  router.get('/summary', handle(async req => {
    if (cacheOnly()) return learnSync().companySummary(owner(req));
    return { ...learn().summary(owner(req)), device: { ...status(), offline_copy_at: null } };
  }));
  router.get('/status', handle(() => status()));
  router.get('/queue', handle(async req => { await fresh(); return learn().queue(owner(req), req.query.mode, req.query.limit); }));
  router.get('/cards', handle(async req => { await fresh(); return learn().list(owner(req), req.query); }));
  router.post('/cards', handle(req => learn().addCard(owner(req), req.body)));
  router.post('/cards/:id/answer', handle(req => learn().answer(owner(req), req.params.id, req.body)));
  router.patch('/cards/:id', handle(req => learn().updateCard(owner(req), req.params.id, req.body)));
  router.post('/meaning', handle(req => learn().meaning(owner(req), req.body && req.body.word)));
  router.post('/starter', handle(req => (cacheOnly() ? learnSync().viaHome('starter', req.body) : learn().starter(owner(req), req.body))));
  router.get('/settings', handle(req => learn().settings(owner(req))));
  router.put('/settings', handle(req => (cacheOnly() ? learnSync().viaHome('settings', req.body) : learn().saveSettings(owner(req), req.body))));
  return router;
}

module.exports = { createLearnRouter };
