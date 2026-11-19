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

function createLearnRouter({ service = null, lookupWord = null, requireAuth = require('../middleware/auth'), clientOrigin = require('../middleware/client-origin') } = {}) {
  const router = express.Router();
  router.use(clientOrigin, requireAuth);
  const learn = () => service || (service = require('../services/learn').createLearn({ lookupWord: lookupWord || translatorLookup() }));
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

  router.get('/summary', handle(req => learn().summary(owner(req))));
  router.get('/queue', handle(req => learn().queue(owner(req), req.query.mode, req.query.limit)));
  router.get('/cards', handle(req => learn().list(owner(req), req.query)));
  router.post('/cards', handle(req => learn().addCard(owner(req), req.body)));
  router.post('/cards/:id/answer', handle(req => learn().answer(owner(req), req.params.id, req.body)));
  router.patch('/cards/:id', handle(req => learn().updateCard(owner(req), req.params.id, req.body)));
  router.post('/meaning', handle(req => learn().meaning(owner(req), req.body && req.body.word)));
  router.post('/starter', handle(req => learn().starter(owner(req), req.body)));
  router.get('/settings', handle(req => learn().settings(owner(req))));
  router.put('/settings', handle(req => learn().saveSettings(owner(req), req.body)));
  return router;
}

module.exports = { createLearnRouter };
