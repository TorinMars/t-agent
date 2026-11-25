const express = require('express');

// English learning ("API" in docs/design/learn-english.md; services/learn.js). Behind the page login and the same-origin check like every /api route
// (server.js), and again here, so the router is safe wherever it is mounted. Every card belongs to the login of the page.
//   GET   /api/learn/summary                          -> { due, new_per_day, new_today, new_left, done_today, minutes_today, goal, streak, words, sentences,
//                                                          mistakes, collecting, starter, new_report, chats }
//   GET   /api/learn/queue?mode=review|spell|build|dictation|say|fill|mistakes&limit=20&extra=practice -> { cards }  (each with `next`: { again, hard,
//         good } ms, `is_new`, `missed`, `leech`, `parts` (string[] | null) and `tip`; due cards, then new ones up to new_left, then with extra=practice
//         the learnt ones not due; "New words a day" and "Keeps slipping" in docs/design/learn-review-fsrs.md)
//   POST  /api/learn/new-words { count: 1..50 }       -> { new_per_day, new_today, new_left }  (today's allowance raised; on a company computer made on its home)
//   POST  /api/learn/cards { kind, en, zh?, source, context? } -> { card, created }
//   POST  /api/learn/cards/:id/answer { mode, grade, correct, answer? } -> { card }
//   PATCH /api/learn/cards/:id { zh?, en?, suspended? }  -> { card }
//   GET   /api/learn/cards?kind=word|sentence&source=&q=&limit=50&offset=0 -> { cards, total }  (every card has `context_zh`)
//   POST  /api/learn/meaning { word }                   -> { zh }   (the configured translator; 503 when there is none)
//   POST  /api/learn/starter { list: 'dev' }            -> { added }
//   GET   /api/learn/settings, PUT /api/learn/settings { collect?, daily_goal?, starter?, audio_*?, desired_retention?, new_per_day? } -> settings
//   GET   /api/learn/stats                            -> { streak, best_streak, week, daily, weekly, memory, total_cards, due }  (the Progress view;
//         "Learn progress statistics" in docs/design/learn-english-stats.md; services/learn-stats.js)
//   GET   /api/learn/status                           -> { company_computer, cache_only, home_name, home_online, waiting }
//   GET   /api/learn/mistakes?limit=50&before=<ISO>   -> { mistakes: [{ uid, at, mode, tag, hinted, expected, written, card }], more }
//   GET   /api/learn/reports                          -> { reports, since: { from, mistakes, answers }, model: { ready, label, name }, running, auto }
//   GET   /api/learn/reports/:uid                     -> { report }
//   POST  /api/learn/reports { lang }                 -> { report }   (asks the translation model; 503 without one, 409 while one runs)
//   POST  /api/learn/cards/find { refs: [{ kind, en }] } -> { cards }  (the cards of a report's findings on this engine)
// ("Mistakes" and "Mistake reports" in docs/design/learn-english.md; services/learn-analysis.js.)
//   GET   /api/learn/level                            -> { level: { level, label, reason, answers, mistakes, report_at, updated_at } | null,
//                                                          picking: { enabled, picked, skipped, sentences, pending, running }, translator }
//   POST  /api/learn/level/check                      -> the same after a new estimate (503 without a model, 409 while one runs, 502 for a bad answer)
// ("Your level" and "Picking words from translations" in docs/design/learn-english.md; services/learn-pick.js.)
//   GET   /api/learn/cards/:id/ask                    -> { messages: [{ uid, role: 'user'|'assistant', text, at }], translator }  (oldest first)
//   POST  /api/learn/cards/:id/ask { question, mode, state: { checked, answer?, correct?, helped?, expected? } }
//         -> application/x-ndjson: {"delta":"..."} lines, then {"done":true,"messages":[question, answer]} or {"error":"...","status":N} (nothing stored);
//            a refusal before the first piece is the usual JSON error (400, 404, 409 busy, 429, 503 no translator, 502 the model). On a company computer
//            the home answers it in one piece: plain JSON { messages }.
// ("Ask about a question" in docs/design/learn-english.md; services/learn-ask.js.)
//   GET   /api/learn/chats                            -> { chats: [{ uid, title, journal, journal_by, created_at, updated_at, count }], translator }
//   GET   /api/learn/chats/:uid                       -> { chat, messages: [{ uid, role, text, at, cards: [{ kind, en, zh, added }], mistakes }] }
//   POST  /api/learn/chats/send { chat: uid | null, question, topic?: 'journal' | 'mistakes' }
//         -> application/x-ndjson: {"chat":{...}} first, {"delta":"..."} lines, then {"done":true,"chat":{...},"messages":[question, answer]} or
//            {"error":"...","status":N} (nothing stored); a refusal before the first piece is the usual JSON error. On a company computer the home
//            answers it in one piece: plain JSON { chat, messages }.
//   PATCH /api/learn/chats/:uid { title?, journal? }  -> { chat };  DELETE /api/learn/chats/:uid -> { ok: true }
// ("English chat" in docs/design/learn-english-chat.md; services/learn-chat.js.)
//   GET   /api/learn/coach?before=&limit=50          -> { messages: [{ uid, role: 'user'|'assistant'|'practice', text, at, meta }], has_more, tools_ok,
//                                                          translator, settings: { memory, read_answers, read_text, economy, engine }, claude_ready,
//                                                          claude_reason, can_answer } (claude=1: Claude's sign-in is checked first, without a turn)
//   POST  /api/learn/coach/send { text }, POST /api/learn/coach/practice-result { plan_id, message_uid, proposal_id?, steps, done, total, right,
//         missed, seconds, stopped? } -> application/x-ndjson: {"type":"status","text"}, {"delta"} lines, {"type":"remembered","note"},
//         {"type":"proposals","proposals"}, then {"done":true,"message","messages","tools","usage"} or {"error","status"}; refusals as JSON.
//   POST  /api/learn/coach/proposals/:id/run { message_uid } -> { ok, result, undo: { token, expires_at }, proposal }; .../cancel -> { ok, proposal }
//   POST  /api/learn/coach/undo { token }; POST /api/learn/coach/plans/start { message_uid, proposal_id } -> { plan, stale } | { empty: true }
//   GET   /api/learn/coach/notes; PATCH|DELETE /api/learn/coach/notes/:uid; POST /api/learn/coach/summary/reset
// ("The coach" in docs/design/learn-english-coach.md; services/learn-coach.js. On a company computer its home answers, in one piece.)
//   GET   /api/learn/speech/status                    -> { ready, reason: null | 'no_key' | 'offline' | 'home_older', voices: ['stella', 'tide'] }
//   GET   /api/learn/speech?text=&voice=stella|tide   -> audio/wav (Cache-Control private): the text read by DeepSeek with the translation service's
//         DeepSeek key (400 bad text or voice, 409 no DeepSeek key, 422 DeepSeek could not read it, 502 / 503 / 504 DeepSeek failed). On a company
//         computer made on its home (its key and cache), the audio coming over the link as base64. ("DeepSeek voice" in
//         docs/design/learn-english-voice.md; services/learn-speech.js.)
// The summary also has `device` (the status, plus `offline_copy_at`). On a company computer whose data lives on a normal machine (services/learn-sync.js,
// "Company computer" in docs/design/learn-english.md) the reads first sync with that machine, the summary comes from it (or, while it is away, from the
// cards here and the last copy of its numbers), and settings and the starter list are changed there (503 while it cannot be reached).

const LEVEL_OFFLINE = 'Your level is kept on a normal computer, which cannot be reached right now';
const ASK_OFFLINE = 'Questions about a card are answered on a normal computer, which cannot be reached right now';
const HOME_OLDER = 'The normal computer that keeps your learning data needs an update first';
const STATS_OFFLINE = 'Your progress is kept on a normal computer, which cannot be reached right now';
const CHAT_OFFLINE = 'Your English chats are kept on a normal computer, which cannot be reached right now';
const COACH_OFFLINE = 'Your English coach is on a normal computer, which cannot be reached right now';
const SPEECH_OFFLINE = 'The DeepSeek voice is on a normal computer, which cannot be reached right now';

// `sync`: the learning sync of this server (services/learn-sync.js), or null for none (a test that hands in its own service gets none by default).
// `analysis`: the mistake analysis (services/learn-analysis.js), or null for none (a test that hands in its own service gets none unless it hands one in).
// `pick`: the level and the picking (services/learn-pick.js), or null for none (like `analysis`). `ask`: the questions about a card
// (services/learn-ask.js), or null for none (like `analysis`). `chat`: the English chats (services/learn-chat.js), or null for none (like `analysis`).
function createLearnRouter({ service = null, lookupWord = null, sync, analysis, pick, ask, chat, coach, speech, requireAuth = require('../middleware/auth'), clientOrigin = require('../middleware/client-origin') } = {}) {
  const router = express.Router();
  router.use(clientOrigin, requireAuth);
  let syncService = sync === undefined ? (service ? null : undefined) : sync;
  const learnSync = () => {
    if (syncService === undefined) syncService = require('../services/learn-sync').getLearnSync();
    return syncService;
  };
  const cacheOnly = () => { const current = learnSync(); return Boolean(current && current.cacheOnly()); };
  // The server's own router shares the learning service with the translation ahead of time (services/learn.js sharedLearn); the meaning of a word comes
  // from the translator the person set up, by the same path as POST /api/translate/word (services/learn.js translatorLookup).
  const learn = () => service || (service = lookupWord || sync !== undefined
    ? require('../services/learn').createLearn({ lookupWord: lookupWord || require('../services/learn').translatorLookup(), cacheOnly })
    : require('../services/learn').sharedLearn());
  let analysisService = analysis === undefined ? (service ? null : undefined) : analysis;
  const analyzer = () => {
    if (analysisService === undefined) analysisService = require('../services/learn-analysis').getLearnAnalysis();
    if (!analysisService) throw Object.assign(new Error('Mistake analysis is not available'), { statusCode: 503 });
    return analysisService;
  };
  let pickService = pick === undefined ? (service ? null : undefined) : pick;
  const picker = () => {
    if (pickService === undefined) pickService = require('../services/learn-pick').getLearnPick();
    return pickService;
  };
  let askService = ask === undefined ? (service ? null : undefined) : ask;
  const asker = () => {
    if (askService === undefined) askService = require('../services/learn-ask').getLearnAsk();
    if (!askService) throw Object.assign(new Error('Asking about a card is not available'), { statusCode: 503 });
    return askService;
  };
  let chatService = chat === undefined ? (service ? null : undefined) : chat;
  const chatter = () => {
    if (chatService === undefined) chatService = require('../services/learn-chat').getLearnChat();
    if (!chatService) throw Object.assign(new Error('The English chat is not available'), { statusCode: 503 });
    return chatService;
  };
  let coachService = coach === undefined ? (service ? null : undefined) : coach;
  const coacher = () => {
    if (coachService === undefined) coachService = require('../services/learn-coach').getLearnCoach();
    if (!coachService) throw Object.assign(new Error('The English coach is not available'), { statusCode: 503 });
    return coachService;
  };
  let speechService = speech === undefined ? (service ? null : undefined) : speech;
  const speaker = () => {
    if (speechService === undefined) speechService = require('../services/learn-speech').getLearnSpeech();
    if (!speechService) throw Object.assign(new Error('The DeepSeek voice is not available'), { statusCode: 503 });
    return speechService;
  };
  const mustPicker = () => {
    const current = picker();
    if (!current) throw Object.assign(new Error('Level estimate is not available'), { statusCode: 503 });
    return current;
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
  // The Progress view: on a company computer the numbers of its home; while the home is away (503) or older (404), the cards and answers here, said as such.
  router.get('/stats', handle(async req => {
    if (!cacheOnly()) return learn().stats(owner(req));
    await fresh();
    try { return await learnSync().askHome('stats', { offline: STATS_OFFLINE }); } catch (error) {
      if (error.statusCode !== 503 && error.statusCode !== 404) throw error;
      return { ...learn().stats(owner(req)), offline: error.statusCode === 503, home_older: error.statusCode === 404 };
    }
  }));
  router.get('/queue', handle(async req => { await fresh(); return learn().queue(owner(req), req.query.mode, req.query.limit, { extra: req.query.extra }); }));
  router.post('/new-words', handle(req => (cacheOnly() ? learnSync().viaHome('new-words', req.body) : learn().addNewWords(owner(req), req.body))));
  router.get('/cards', handle(async req => { await fresh(); return learn().list(owner(req), req.query); }));
  router.post('/cards', handle(req => {
    const result = learn().addCard(owner(req), req.body);
    // A new translated sentence: its words are picked a moment later, in the background (on a company computer by its home, once handed over).
    if (result.created && result.card && result.card.kind === 'sentence' && result.card.source === 'translation' && !cacheOnly()) {
      try { const current = picker(); if (current) current.afterSentence(owner(req)); } catch { /* the hourly check picks it */ }
    }
    return result;
  }));
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
  router.put('/settings', handle(req => {
    if (cacheOnly()) return learnSync().viaHome('settings', req.body);
    const saved = learn().saveSettings(owner(req), req.body);
    // Picking turned on: the sentences waiting are picked in the background.
    if (req.body && req.body.pick_words === true) { try { const current = picker(); if (current) current.kick(owner(req)); } catch { /* the hourly check */ } }
    return saved;
  }));
  // ---- The level and the words from translations: on a company computer read and estimated on its home (the copy here while it is away) ----
  router.get('/level', handle(async req => {
    if (!cacheOnly()) return mustPicker().view(owner(req));
    try { return await learnSync().askHome('level', { offline: LEVEL_OFFLINE }); } catch (error) {
      // Away (503) or an older version without the level (404): the synced copy here, said as such.
      if (error.statusCode !== 503 && error.statusCode !== 404) throw error;
      return { ...mustPicker().view(owner(req)), translator: false, offline: error.statusCode === 503, home_older: error.statusCode === 404 };
    }
  }));
  router.post('/level/check', handle(async req => {
    if (!cacheOnly()) return mustPicker().check(owner(req));
    try { return await learnSync().askHome('level-check', { method: 'POST', body: {}, timeout: 100_000, offline: LEVEL_OFFLINE }); } catch (error) {
      if (error.statusCode === 404) throw Object.assign(new Error('The normal computer that keeps your learning data needs an update first'), { statusCode: 409 });
      throw error;
    }
  }));
  // ---- Questions about a card: on a company computer asked of its home (the conversations are personal data, like the answers) ----
  // The card named on the home by its kind and normalized text (ids differ per engine).
  const homeRef = req => { const ref = learn().cardRef(owner(req), req.params.id); return { kind: ref.kind, norm: ref.norm }; };
  router.get('/cards/:id/ask', handle(async req => {
    if (!cacheOnly()) return asker().history(owner(req), req.params.id);
    await fresh();
    const ref = homeRef(req);
    try { return await learnSync().askHome(`ask?kind=${encodeURIComponent(ref.kind)}&norm=${encodeURIComponent(ref.norm)}`, { offline: ASK_OFFLINE }); } catch (error) {
      // Away: no messages and no model, said as such; a home without this version (404 that is not "Card not found") the same with home_older.
      if (error.statusCode === 503) return { messages: [], translator: false, offline: true };
      if (error.statusCode === 404 && error.message !== 'Card not found') return { messages: [], translator: false, home_older: true };
      throw error;
    }
  }));
  async function companyAsk(req) {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const send = () => learnSync().askHome('ask', {
      method: 'POST', body: { ...homeRef(req), question: body.question, mode: body.mode, state: body.state }, timeout: 100_000, offline: ASK_OFFLINE,
    });
    try { return await send(); } catch (error) {
      if (error.statusCode !== 404) throw error;
      if (error.message !== 'Card not found') throw Object.assign(new Error(HOME_OLDER), { statusCode: 409 });
      // A card made here a moment ago may not be on the home yet: one round, then once more.
      await learnSync().refresh();
      return send();
    }
  }
  router.post('/cards/:id/ask', async (req, res) => {
    if (cacheOnly()) {
      try { res.set('Cache-Control', 'no-store').json(await companyAsk(req)); } catch (error) { fail(res, error); }
      return;
    }
    let service;
    try { service = asker(); } catch (error) { fail(res, error); return; }
    await streamed(req, res, ({ onDelta, signal }) => service.ask(owner(req), req.params.id, req.body, { onDelta, signal }), result => ({ done: true, messages: result.messages }));
  });

  // An answer streamed as application/x-ndjson ("Ask about a question" and "English chat"): the response starts with the first piece (after the
  // `head()` lines), so a refusal or a model that fails before it is the usual JSON error; a failure after it is an error line. When the page closes
  // the request (or goes away) the model's call is cancelled and nothing is stored.
  async function streamed(req, res, run, doneLine, head = () => []) {
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    let started = false;
    const line = value => res.write(`${JSON.stringify(value)}\n`);
    const start = () => {
      if (started) return;
      started = true;
      res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
      res.flushHeaders();
      for (const value of head()) line(value);
    };
    try {
      const result = await run({ onDelta: text => { start(); line({ delta: text }); }, onEvent: value => { start(); line(value); }, signal: controller.signal });
      start();
      line(doneLine(result));
      res.end();
    } catch (error) {
      if (controller.signal.aborted) { if (!res.writableEnded) res.end(); return; }
      if (!started) { fail(res, error); return; }
      // The model failed after the first piece: said in the stream, with the status the JSON error would have had.
      const status = error && error.statusCode;
      if (Number.isInteger(status) && status >= 400 && status <= 599) line({ error: error.message, status });
      else { console.warn(`Learn: ${error && error.message}`); line({ error: 'Learning data is not available right now', status: 500 }); }
      res.end();
    }
  }

  // ---- The English chats: on a company computer kept and answered on its home (personal data, like the answers) ----
  // A refusal of the home: a 404 that is not "Chat not found" means a home without this version.
  const homeChat = async (route, options = {}) => {
    try { return await learnSync().askHome(route, { offline: CHAT_OFFLINE, ...options }); } catch (error) {
      if (error.statusCode === 404 && error.message !== 'Chat not found') throw Object.assign(new Error(HOME_OLDER), { statusCode: 409 });
      throw error;
    }
  };
  const chatBody = req => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
  router.get('/chats', handle(async req => {
    if (!cacheOnly()) return chatter().list(owner(req));
    try { return await learnSync().askHome('chats', { offline: CHAT_OFFLINE }); } catch (error) {
      // Away: no chats and no model, said as such; a home without this version the same with home_older.
      if (error.statusCode === 503) return { chats: [], translator: false, offline: true };
      if (error.statusCode === 404) return { chats: [], translator: false, home_older: true };
      throw error;
    }
  }));
  router.get('/chats/:uid', handle(req => (cacheOnly() ? homeChat(`chat?uid=${encodeURIComponent(req.params.uid)}`) : chatter().get(owner(req), req.params.uid))));
  router.patch('/chats/:uid', handle(req => (cacheOnly()
    ? homeChat('chat-update', { method: 'POST', body: { ...chatBody(req), uid: req.params.uid } })
    : chatter().update(owner(req), req.params.uid, req.body))));
  router.delete('/chats/:uid', handle(req => (cacheOnly()
    ? homeChat('chat-delete', { method: 'POST', body: { uid: req.params.uid } })
    : chatter().remove(owner(req), req.params.uid))));
  router.post('/chats/send', async (req, res) => {
    if (cacheOnly()) {
      const body = chatBody(req);
      try {
        res.set('Cache-Control', 'no-store').json(await homeChat('chat-send', { method: 'POST', body: { chat: body.chat, question: body.question, topic: body.topic }, timeout: 130_000 }));
      } catch (error) { fail(res, error); }
      return;
    }
    let service;
    try { service = chatter(); } catch (error) { fail(res, error); return; }
    let chatLine = null;
    await streamed(req, res, ({ onDelta, signal }) => service.send(owner(req), req.body, { onChat: value => { chatLine = value; }, onDelta, signal }),
      result => ({ done: true, chat: result.chat, messages: result.messages }), () => (chatLine ? [{ chat: chatLine }] : []));
  });
  // ---- The DeepSeek voice: on a company computer made on its home, which has the key and the cache ----
  router.get('/speech/status', handle(async req => {
    if (!cacheOnly()) return speaker().status(owner(req));
    const { VOICES } = require('../services/learn-speech');
    try { return await learnSync().askHome('speech-status', { offline: SPEECH_OFFLINE }); } catch (error) {
      // Away, or a home without the voice: not ready, said why (the page reads with this device's voices).
      if (error.statusCode === 503) return { ready: false, reason: 'offline', voices: [...VOICES] };
      if (error.statusCode === 404) return { ready: false, reason: 'home_older', voices: [...VOICES] };
      throw error;
    }
  }));
  router.get('/speech', async (req, res) => {
    try {
      const { checkRequest, isWav } = require('../services/learn-speech');
      const asked = { text: req.query.text, voice: req.query.voice };
      let audio;
      if (cacheOnly()) {
        const { text, voice } = checkRequest(asked);
        let answer;
        try { answer = await learnSync().askHome(`speech?${new URLSearchParams({ text, voice })}`, { offline: SPEECH_OFFLINE, timeout: 45_000 }); } catch (error) {
          if (error.statusCode === 404) throw Object.assign(new Error(HOME_OLDER), { statusCode: 409 });
          throw error;
        }
        audio = answer && typeof answer.audio === 'string' ? Buffer.from(answer.audio, 'base64') : null;
        if (!isWav(audio)) throw Object.assign(new Error('The DeepSeek voice is not available right now'), { statusCode: 502 });
      } else {
        audio = await speaker().speak(owner(req), asked);
      }
      res.status(200).set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=604800', 'X-Content-Type-Options': 'nosniff' }).send(audio);
    } catch (error) { fail(res, error); }
  });
  // ---- The English coach: on a company computer kept and answered on its home (personal data, like the chats) ----
  const homeCoach = async (route, options = {}) => {
    try { return await learnSync().askHome(route, { offline: COACH_OFFLINE, ...options }); } catch (error) {
      if (error.statusCode === 404 && !/not found/i.test(error.message)) throw Object.assign(new Error(HOME_OLDER), { statusCode: 409 });
      throw error;
    }
  };
  const coachPost = (action, body, timeout) => homeCoach(`coach-${action}`, { method: 'POST', body, ...(timeout ? { timeout } : {}) });
  router.get('/coach', handle(async req => {
    if (!cacheOnly()) { const service = coacher(); return typeof service.look === 'function' ? service.look(owner(req), req.query) : service.view(owner(req), req.query); }
    const query = new URLSearchParams();
    for (const key of ['before', 'limit', 'claude']) if (typeof req.query[key] === 'string') query.set(key, req.query[key]);
    try { return await learnSync().askHome(`coach?${query}`, { offline: COACH_OFFLINE }); } catch (error) {
      if (error.statusCode !== 503 && error.statusCode !== 404) throw error;
      const current = learn().settings(owner(req));
      return {
        messages: [], has_more: false, tools_ok: false, translator: false,
        settings: { memory: current.coach_memory, read_answers: current.coach_read_answers, read_text: current.coach_read_text, economy: current.coach_economy, engine: current.coach_engine },
        claude_ready: null, claude_reason: 'away', can_answer: false,
        offline: error.statusCode === 503, home_older: error.statusCode === 404,
      };
    }
  }));
  const coachStream = (name, action) => async (req, res) => {
    if (cacheOnly()) {
      try { res.set('Cache-Control', 'no-store').json(await coachPost(action, chatBody(req), 160_000)); } catch (error) { fail(res, error); }
      return;
    }
    let service;
    try { service = coacher(); } catch (error) { fail(res, error); return; }
    await streamed(req, res, ({ onDelta, onEvent, signal }) => service[name](owner(req), req.body, { onDelta, onEvent, signal }),
      result => ({ done: true, message: result.message, messages: result.messages, tools: result.tools, usage: result.usage }));
  };
  router.post('/coach/send', coachStream('send', 'send'));
  router.post('/coach/practice-result', coachStream('practiceResult', 'practice'));
  router.post('/coach/proposals/:id/run', handle(req => (cacheOnly()
    ? coachPost('run', { id: req.params.id, message_uid: chatBody(req).message_uid })
    : coacher().runProposal(owner(req), req.params.id, chatBody(req)))));
  router.post('/coach/proposals/:id/cancel', handle(req => (cacheOnly()
    ? coachPost('cancel', { id: req.params.id, message_uid: chatBody(req).message_uid })
    : coacher().cancelProposal(owner(req), req.params.id, chatBody(req)))));
  router.post('/coach/undo', handle(req => (cacheOnly() ? coachPost('undo', { token: chatBody(req).token }) : coacher().undo(owner(req), chatBody(req)))));
  router.post('/coach/plans/start', handle(async req => {
    const body = { message_uid: chatBody(req).message_uid, proposal_id: chatBody(req).proposal_id };
    if (!cacheOnly()) return coacher().startPlan(owner(req), body);
    // The home's cards carry the home's ids: each is the card here of the same kind and text (the answers are posted here).
    await fresh();
    const answer = await coachPost('plan-start', body);
    if (!answer || !answer.plan) return answer;
    const steps = [];
    for (const step of answer.plan.steps || []) {
      const refs = (step.cards || []).map(card => ({ kind: card.kind, en: card.en }));
      const { cards } = learn().findCards(owner(req), { refs });
      const local = await learn().practiceCards(owner(req), cards.map(card => card.id));
      if (local.length) steps.push({ mode: step.mode, cards: local });
    }
    if (!steps.length) return { empty: true };
    return { ...answer, plan: { ...answer.plan, steps } };
  }));
  router.get('/coach/notes', handle(req => (cacheOnly() ? coachPost('notes', {}) : coacher().notes(owner(req)))));
  router.patch('/coach/notes/:uid', handle(req => (cacheOnly()
    ? coachPost('note-update', { ...chatBody(req), uid: req.params.uid })
    : coacher().updateNote(owner(req), req.params.uid, req.body))));
  router.delete('/coach/notes/:uid', handle(req => (cacheOnly() ? coachPost('note-delete', { uid: req.params.uid }) : coacher().deleteNote(owner(req), req.params.uid))));
  router.post('/coach/summary/reset', handle(req => (cacheOnly() ? coachPost('summary-reset', {}) : coacher().resetSummary(owner(req)))));
  return router;
}

module.exports = { createLearnRouter };
