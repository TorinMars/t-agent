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
//   GET   /api/learn/settings, PUT /api/learn/settings { collect?, daily_goal?, starter?, audio_*? } -> settings
//   GET   /api/learn/status                           -> { company_computer, cache_only, home_name, home_online, waiting }
//   GET   /api/learn/mistakes?limit=50&before=<ISO>   -> { mistakes: [{ uid, at, mode, tag, hinted, expected, written, card }], more }
//   GET   /api/learn/reports                          -> { reports, since: { from, mistakes, answers }, model: { ready, label, name }, running, auto }
//   GET   /api/learn/reports/:uid                     -> { report }
//   POST  /api/learn/reports { lang }                 -> { report }   (asks the translation model; 503 without one, 409 while one runs)
//   POST  /api/learn/cards/find { refs: [{ kind, en }] } -> { cards }  (the cards of a report's findings on this engine)
// ("Mistakes" and "Mistake reports" in docs/design/learn-english.md; services/learn-analysis.js.)
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
// `analysis`: the mistake analysis (services/learn-analysis.js), or null for none (a test that hands in its own service gets none unless it hands one in).
function createLearnRouter({ service = null, lookupWord = null, sync, analysis, requireAuth = require('../middleware/auth'), clientOrigin = require('../middleware/client-origin') } = {}) {
  const router = express.Router();
  router.use(clientOrigin, requireAuth);
  let syncService = sync === undefined ? (service ? null : undefined) : sync;
  const learnSync = () => {
    if (syncService === undefined) syncService = require('../services/learn-sync').getLearnSync();
    return syncService;
  };
  const cacheOnly = () => { const current = learnSync(); return Boolean(current && current.cacheOnly()); };
  const learn = () => service || (service = require('../services/learn').createLearn({ lookupWord: lookupWord || translatorLookup(), cacheOnly }));
  let analysisService = analysis === undefined ? (service ? null : undefined) : analysis;
  const analyzer = () => {
    if (analysisService === undefined) analysisService = require('../services/learn-analysis').getLearnAnalysis();
    if (!analysisService) throw Object.assign(new Error('Mistake analysis is not available'), { statusCode: 503 });
    return analysisService;
  };
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
  // ---- Mistakes and reports: on a company computer read and made on its home (the wrong answers and the reports are personal data) ----
  router.get('/mistakes', handle(async req => {
    if (!cacheOnly()) return learn().mistakes(owner(req), req.query);
    await fresh();
    const query = new URLSearchParams();
    for (const key of ['limit', 'before']) if (typeof req.query[key] === 'string') query.set(key, req.query[key]);
    try { return await learnSync().askHome(`mistakes?${query}`); } catch (error) {
      if (error.statusCode !== 503) throw error;
      // The home is away: the wrong answers that wait here, said as such.
      return { ...learn().mistakes(owner(req), req.query), offline: true };
    }
  }));
  router.get('/reports', handle(async req => {
    if (!cacheOnly()) return analyzer().view(owner(req));
    try { return await learnSync().askHome('reports'); } catch (error) {
      if (error.statusCode !== 503) throw error;
      return { reports: [], since: null, model: { ready: false, label: '', name: '' }, running: false, auto: learn().settings(owner(req)).analysis_auto, offline: true };
    }
  }));
  router.get('/reports/:uid', handle(req => (cacheOnly() ? learnSync().askHome(`report?uid=${encodeURIComponent(req.params.uid)}`) : learn().report(owner(req), req.params.uid))));
  router.post('/reports', handle(async req => {
    const body = req.body && typeof req.body === 'object' ? { lang: req.body.lang } : {};
    if (cacheOnly()) return learnSync().askHome('analyze', { method: 'POST', body, timeout: 100_000 });
    return analyzer().analyze(owner(req), body);
  }));
  router.post('/cards/find', handle(async req => { await fresh(); return learn().findCards(owner(req), req.body); }));
  router.get('/settings', handle(req => learn().settings(owner(req))));
  router.put('/settings', handle(req => (cacheOnly() ? learnSync().viaHome('settings', req.body) : learn().saveSettings(owner(req), req.body))));
  return router;
}

module.exports = { createLearnRouter };
