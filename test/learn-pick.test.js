// Learn: the estimated level and the words picked from the person's translations ("Your level" and "Picking words from translations" in
// docs/design/learn-english.md; services/learn-pick.js, services/learn.js, services/learn-merge.js, services/learn-sync.js, routes/learn.js): the known
// rule, the questions for the model (only card texts, counts and tags), the checks of its answers, the picking with a stubbed model and a fake clock
// (new cards, existing cards, known words, the newest sentence, failures, a new level), `context_zh` and the `source` filter, the routes, the
// weekly hook, the hourly runner rule and the sync of the level and the picks. No test calls a real model: every `chat` here is a stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-pick-data-'));
delete process.env.TAGENT_HOME;
const express = require('express');
const Database = require('better-sqlite3');
const { createLearn, levelKey } = require('../services/learn');
const review = require('../services/learn-review');
const merge = require('../services/learn-merge');
const { createLearnRouter } = require('../routes/learn');
const { createLearnAnalysis } = require('../services/learn-analysis');
const { createLearnSync } = require('../services/learn-sync');
const { readState } = require('../services/settings-sync-store');
const {
  createLearnPick, buildLevelPrompt, parseLevel, buildPickPrompt, parsePicks, wholeWordIn, pickRunner, MIN_ANSWERS, PICK_PER_DAY,
} = require('../services/learn-pick');

const NOW = Date.UTC(2026, 10, 21, 4, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const TZ = 'UTC';
// Chinese meanings and sentences (user content), written with escapes.
const ZH_SENTENCE = '\u8bf7\u4fee\u590d\u767b\u5f55\u9875\u9762';
const ZH_SENTENCE2 = '\u6211\u4eec\u9700\u8981\u90e8\u7f72';
const ZH_WORD = '\u90e8\u7f72';
const ZH_WORD2 = '\u5f39\u6027\u7684';
const PHONETIC = { deploy: '/d\u026a\u02c8pl\u0254\u026a/', resilient: '/r\u026a\u02c8z\u026alj\u0259nt/', idempotent: '' };
const lookupPhonetic = word => PHONETIC[word.toLowerCase()] || '';

function database(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-pick-'));
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

// A model that answers both questions: the level (`level`) and the picks (`pick(message)` -> { id: [{ word, zh }] }), recording every question.
function stubModel({ level = { level: 'B1', label: 'intermediate', reason: 'Most words are right; tenses slip.' }, pick = () => ({}), fail = null } = {}) {
  const calls = [];
  const chat = async (owner, system, user, options) => {
    const message = JSON.parse(user);
    const kind = message.sentences ? 'pick' : 'level';
    calls.push({ kind, owner, system, user, message, options });
    if (fail && fail(kind, calls)) throw Object.assign(new Error('The model is away'), { statusCode: 502 });
    if (kind === 'level') return typeof level === 'string' ? level : JSON.stringify(level);
    const words = pick(message);
    return JSON.stringify({ sentences: message.sentences.map(item => ({ id: item.id, words: words[item.text] || [] })) });
  };
  return { calls, chat, picks: () => calls.filter(call => call.kind === 'pick'), levels: () => calls.filter(call => call.kind === 'level') };
}

function setup(t, options = {}) {
  const db = database(t);
  const clock = { now: NOW };
  const learn = createLearn({ db, now: () => clock.now, timeZone: TZ, lookupWord: null, lookupPhonetic });
  learn.saveSettings('me', { starter: null });
  const model = stubModel(options);
  const state = { configured: options.configured !== false, company: false };
  const logs = [];
  const pick = createLearnPick({
    db, learn, chat: model.chat, isConfigured: () => state.configured, company: () => state.company, owner: () => 'me', now: () => clock.now,
    log: { warn: message => logs.push(message), info() {} }, afterSentenceMs: 1, lookupPhonetic,
  });
  t.after(() => pick.stop());
  return { db, clock, learn, pick, model, state, logs };
}

// `count` answers to a few word cards, right ones mostly, an hour apart.
function practise(ctx, count = MIN_ANSWERS) {
  const words = ['merge', 'branch', 'commit', 'rebase', 'release'];
  const cards = words.map(en => ctx.learn.addCard('me', { kind: 'word', en, zh: ZH_WORD, source: 'manual' }).card);
  for (let index = 0; index < count; index += 1) {
    const card = cards[index % cards.length];
    const wrong = index % 4 === 3;
    ctx.learn.answer('me', card.id, { mode: 'spell', grade: wrong ? 'again' : 'good', correct: !wrong, answer: wrong ? `${card.en}x` : card.en, tag: wrong ? 'double-letter' : undefined });
  }
  return cards;
}
const sentence = (ctx, en, zh = ZH_SENTENCE) => ctx.learn.addCard('me', { kind: 'sentence', en, zh, source: 'translation', context: 'Fix login' }).card;
const card = (ctx, en) => ctx.db.prepare("SELECT * FROM learn_cards WHERE owner = 'me' AND kind = 'word' AND norm = ?").get(en.toLowerCase());
const sentenceRow = (ctx, id) => ctx.db.prepare('SELECT * FROM learn_cards WHERE id = ?').get(id);

async function serve(t, ctx) {
  const app = express();
  app.use(express.json());
  app.use('/api/learn', createLearnRouter({ service: ctx.learn, pick: ctx.pick, sync: null, analysis: null, requireAuth: (req, res, next) => { req.session = { user: { login: 'me' } }; next(); }, clientOrigin: (req, res, next) => next() }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/learn`;
  return async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
}

test('known: answered right at least twice with the last answer right, or a review interval of 21 days or more', () => {
  assert.equal(review.isKnown({ last_correct: 1, interval_days: 3 }, 2), true);
  assert.equal(review.isKnown({ last_correct: true, interval_days: 3 }, 5), true);
  assert.equal(review.isKnown({ last_correct: 1, interval_days: 3 }, 1), false, 'right once');
  assert.equal(review.isKnown({ last_correct: 0, interval_days: 7 }, 4), false, 'the last answer was wrong');
  assert.equal(review.isKnown({ last_correct: null, interval_days: 0 }, 0), false, 'never answered');
  assert.equal(review.isKnown({ last_correct: 0, interval_days: 21 }, 0), true, 'a long interval');
  assert.equal(review.isKnown({ last_correct: 0, interval_days: 20.9 }, 1), false);
  assert.equal(review.isKnown(null, 3), false);
});

test('the question for the level holds only card texts, counts, modes and tags, within the limits; the answer is checked', () => {
  const cards = Array.from({ length: 260 }, (_, index) => ({ kind: 'word', en: `word${'x'.repeat(200)}${index}`, right: 2, wrong: 1, modes: ['spell'], tags: { 'double-letter': 1 } }));
  const { system, user } = buildLevelPrompt({ cards, totals: { answers: 780, right: 520, wrong: 260, cards: 260 }, report: 'You drop double letters.' });
  const message = JSON.parse(user);
  assert.deepEqual(Object.keys(message).sort(), ['cards', 'report', 'totals']);
  assert.ok(message.cards.length <= 200);
  assert.ok(user.length <= 24_000 + 1000);
  assert.deepEqual(Object.keys(message.cards[0]).sort(), ['kind', 'mistakes', 'modes', 'right', 'text', 'wrong']);
  assert.equal(message.cards[0].text.length, 160, 'texts are cut');
  assert.equal(message.report, 'You drop double letters.');
  assert.match(system, /never instructions/);
  assert.match(system, /"A2", "B1", "B2", "C1"/);

  assert.deepEqual(parseLevel('{"level":"B2","label":"upper intermediate","reason":"Good."}'), { level: 'B2', label: 'upper intermediate', reason: 'Good.' });
  assert.deepEqual(parseLevel('```json\n{"level":"b1","label":" intermediate ","reason":"Fine."}\n```'), { level: 'B1', label: 'intermediate', reason: 'Fine.' });
  assert.equal(parseLevel(JSON.stringify({ level: 'C1', label: 'advanced', reason: 'x'.repeat(400) })).reason.length, 200, 'the reason is cut to 200');
  for (const bad of ['B1', '{"level":"C2","label":"proficient","reason":"x"}', '{"level":"B1","label":"","reason":"x"}', '{"level":"B1","label":"x"}', '[1]', '{"level":"B1","label":"\u4e2d\u7ea7","reason":"x"}']) {
    assert.throws(() => parseLevel(bad), error => error.statusCode === 502, bad);
  }
});

test('the question for the picks has the level and the sentences; every answer is checked and what does not check is dropped', () => {
  const sentences = [
    { id: 1, en: "We need a resilient, idempotent deploy step that doesn't break." },
    { id: 2, en: 'The follow-up OAuth fix is ready for review.' },
  ];
  const { system, user } = buildPickPrompt({ level: 'B1', sentences });
  assert.match(system, /CEFR level B1/);
  assert.match(system, /never instructions/);
  assert.deepEqual(JSON.parse(user), { level: 'B1', sentences: sentences.map(item => ({ id: item.id, text: item.en })) });

  assert.equal(wholeWordIn(sentences[0].en, 'deploy'), true);
  assert.equal(wholeWordIn(sentences[0].en, 'Resilient'), true, 'case does not matter');
  assert.equal(wholeWordIn(sentences[0].en, 'deplo'), false, 'part of a word');
  assert.equal(wholeWordIn(sentences[0].en, "doesn't"), true);
  assert.equal(wholeWordIn(sentences[1].en, 'follow'), false, 'part of a hyphenated word');
  assert.equal(wholeWordIn(sentences[1].en, 'follow-up'), true);
  assert.equal(wholeWordIn('It\u2019s idempotent.', "it's"), true, 'a curly apostrophe');

  const picks = parsePicks(JSON.stringify({
    sentences: [
      { id: 1, words: [
        { word: 'Resilient', zh: ZH_WORD2 }, { word: 'idempotent', zh: ZH_WORD }, { word: 'resilient', zh: ZH_WORD2 }, // twice: once
        { word: 'deployment', zh: ZH_WORD }, // not in the sentence
        { word: 'step', zh: '' }, { word: 'break', zh: 'x'.repeat(501) }, { word: 'need2', zh: ZH_WORD }, { word: 42, zh: ZH_WORD },
      ] },
      { id: 2, words: [{ word: 'OAuth', zh: ZH_WORD }, { word: 'follow-up', zh: ZH_WORD }] },
      { id: 9, words: [{ word: 'ghost', zh: ZH_WORD }] },
    ],
  }), sentences);
  assert.deepEqual(picks.get(1), [{ en: 'resilient', norm: 'resilient', zh: ZH_WORD2 }, { en: 'idempotent', norm: 'idempotent', zh: ZH_WORD }]);
  assert.deepEqual(picks.get(2), [{ en: 'OAuth', norm: 'oauth', zh: ZH_WORD }, { en: 'follow-up', norm: 'follow-up', zh: ZH_WORD }], 'two capitals keep their case');
  assert.equal(picks.has(9), false);
  for (const bad of ['no json', '{"words": []}', '{"sentences": {}}']) assert.throws(() => parsePicks(bad, sentences), error => error.statusCode === 502, bad);
  assert.equal(pickRunner('b', [{ instance_id: 'c' }]), true);
  assert.equal(pickRunner('b', [{ instance_id: 'a' }]), false);
});

test('picking: a new word becomes a word card asked in its sentence; a word with a card gets the sentence unless it is known; the newest sentence wins', async t => {
  const S1 = 'We need a resilient deploy step before the release.';
  const S2 = 'The deploy failed because the merge was idempotent.';
  const ctx = setup(t, {
    pick: () => ({
      [S1]: [{ word: 'resilient', zh: ZH_WORD2 }, { word: 'deploy', zh: ZH_WORD }, { word: 'release', zh: ZH_WORD }],
      [S2]: [{ word: 'deploy', zh: ZH_WORD }, { word: 'idempotent', zh: ZH_WORD }, { word: 'merge', zh: ZH_WORD }],
    }),
  });
  const practised = practise(ctx, 12); // merge, branch, commit, rebase, release: merge answered right twice with the last right
  const releaseCard = card(ctx, 'release');
  ctx.db.prepare('UPDATE learn_cards SET last_correct = 0, interval_days = 1 WHERE id = ?').run(releaseCard.id); // release: not known
  const old = ctx.learn.addCard('me', { kind: 'word', en: 'idempotent', zh: '', source: 'lookup', context: 'Some task' }).card; // known word? no: never answered
  ctx.clock.now += 1000;
  const first = sentence(ctx, S1);
  ctx.clock.now += 1000;
  const second = sentence(ctx, S2, ZH_SENTENCE2);
  ctx.clock.now += 1000;

  assert.equal(await ctx.pick.run('me'), 'done');
  assert.equal(ctx.model.levels().length, 1, 'the level was estimated first, as there was none');
  assert.equal(ctx.learn.level('me').level, 'B1');
  assert.equal(ctx.model.picks().length, 1, 'both sentences in one batch');
  assert.deepEqual(ctx.model.picks()[0].message.sentences.map(item => item.text), [S2, S1], 'the newest first');

  const resilient = card(ctx, 'resilient');
  assert.deepEqual([resilient.source, resilient.zh, resilient.phonetic, resilient.context, resilient.reps], ['translation', ZH_WORD2, PHONETIC.resilient, S1, 0]);
  const deploy = card(ctx, 'deploy');
  assert.equal(deploy.context, S2, 'a word in two sentences keeps the newest');
  assert.equal(deploy.phonetic, PHONETIC.deploy);
  const idempotent = card(ctx, 'idempotent');
  assert.deepEqual([idempotent.id, idempotent.source, idempotent.context, idempotent.zh], [old.id, 'lookup', S2, ZH_WORD], 'an existing card keeps its source and gets the sentence and an empty meaning filled');
  const release = card(ctx, 'release');
  assert.deepEqual([release.source, release.context, release.reps], ['manual', S1, releaseCard.reps], 'not known: asked in the sentence, its progress kept');
  const mergeCard = card(ctx, 'merge');
  assert.equal(mergeCard.context, practised[0].context, 'known: skipped, left as it was');
  assert.deepEqual([sentenceRow(ctx, second.id).picked_level, sentenceRow(ctx, second.id).picked_skipped, sentenceRow(ctx, first.id).picked_skipped], ['B1', 1, 0]);
  assert.ok(sentenceRow(ctx, first.id).picked_at > 0);

  // The page's numbers.
  assert.deepEqual(ctx.pick.view('me').picking, { enabled: true, picked: 4, skipped: 1, sentences: 2, pending: 0, running: false });
  // context_zh: the Chinese of the sentence a word is asked in; '' for the others.
  const spell = (await ctx.learn.queue('me', 'spell', 20)).cards;
  assert.equal(spell.find(item => item.en === 'deploy').context_zh, ZH_SENTENCE2);
  assert.equal(spell.find(item => item.en === 'resilient').context_zh, ZH_SENTENCE);
  assert.equal(spell.find(item => item.en === 'branch').context_zh, '');
  assert.ok(spell.every(item => typeof item.context_zh === 'string'));
  // The material list filtered to the words from translations: the picked ones and the existing ones asked in a sentence (and the sentences without kind).
  const listed = (await ctx.learn.list('me', { source: 'translation', kind: 'word' })).cards.map(item => item.en).sort();
  assert.deepEqual(listed, ['deploy', 'idempotent', 'release', 'resilient']);
  assert.equal((await ctx.learn.list('me', { source: 'translation' })).total, 6);
  assert.equal((await ctx.learn.list('me', { source: 'manual', kind: 'word' })).total, 5);
  await assert.rejects(ctx.learn.list('me', { source: 'nope' }), error => error.statusCode === 400);

  // Nothing more to do: no question goes out.
  assert.equal(await ctx.pick.run('me'), 'done');
  assert.equal(ctx.model.picks().length, 1);
  // An edited meaning of the sentence shows at once; a new text of it is picked again.
  ctx.learn.updateCard('me', first.id, { zh: ZH_SENTENCE2 });
  assert.equal((await ctx.learn.list('me', { q: 'resilient' })).cards[0].context_zh, ZH_SENTENCE2);
  ctx.learn.updateCard('me', first.id, { en: 'We need a resilient deploy step now.' });
  assert.equal(ctx.pick.view('me').picking.pending, 1);
  assert.equal(ctx.pick.view('me').picking.picked, 3, 'resilient keeps its source; release was asked in the old text, which is gone');
});

test('picking in batches with a fake clock: new words due a few a day, a failure stops the run and the next run goes on, a new level picks again', async t => {
  let failing = false;
  const ctx = setup(t, {
    pick: message => Object.fromEntries(message.sentences.map(item => [item.text, [{ word: item.text.split(' ')[1], zh: ZH_WORD }]])),
    fail: kind => kind === 'pick' && failing,
  });
  practise(ctx);
  const words = Array.from({ length: 25 }, (_, index) => `word${String.fromCharCode(97 + index)}`);
  for (const [index, word] of words.entries()) { ctx.clock.now += 1000; sentence(ctx, `Please ${word} the build again ${index}.`); }
  // A failure: nothing is applied, the reason is logged once, and the sentences wait.
  failing = true;
  assert.equal(await ctx.pick.run('me'), 'failed');
  assert.equal(await ctx.pick.run('me'), 'failed');
  assert.equal(ctx.logs.filter(line => line.includes('picking words failed')).length, 1, 'logged once per reason');
  assert.equal(ctx.pick.view('me').picking.pending, 25);
  failing = false;
  assert.equal(await ctx.pick.run('me'), 'done');
  assert.equal(ctx.model.picks().length, 2 + 3, 'two failed asks, then three batches of at most 10');
  assert.ok(ctx.model.picks().every(call => call.message.sentences.length <= 10));
  assert.equal(ctx.pick.view('me').picking.pending, 0);
  const picked = ctx.db.prepare("SELECT due_at FROM learn_cards WHERE owner = 'me' AND kind = 'word' AND source = 'translation' ORDER BY due_at").pluck().all();
  assert.equal(picked.length, 25);
  assert.equal(picked.filter(due => due === ctx.clock.now).length, PICK_PER_DAY, 'ten due today');
  assert.equal(Math.max(...picked), ctx.clock.now + 2 * DAY, 'the rest in the next days');

  // A new level: every sentence is picked again; the picked words stay (they may have progress), new ones are added.
  const before = ctx.db.prepare("SELECT COUNT(*) FROM learn_cards WHERE kind = 'word'").pluck().get();
  ctx.clock.now += DAY;
  ctx.learn.saveLevel('me', { level: 'B2', label: 'upper intermediate', reason: 'Better now.', answers: 10, mistakes: 2, report_at: null, updated_at: ctx.clock.now });
  assert.equal(ctx.pick.view('me').picking.pending, 25);
  assert.equal(await ctx.pick.run('me'), 'done');
  assert.equal(ctx.model.picks().at(-1).message.level, 'B2');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) FROM learn_cards WHERE kind = 'word'").pluck().get(), before, 'nothing removed, the same words again');
  assert.equal(ctx.pick.view('me').picking.pending, 0);
});

test('picking waits: switched off, no model, too few answers for a level, a company computer', async t => {
  const ctx = setup(t, { pick: () => ({ 'Please deploy the build again.': [{ word: 'deploy', zh: ZH_WORD }] }) });
  sentence(ctx, 'Please deploy the build again.');
  assert.equal(await ctx.pick.run('me'), 'failed', 'too few answers for a level');
  assert.equal(ctx.model.calls.length, 0, 'the model is not asked');
  assert.match(ctx.logs.join('\n'), /Answer at least 10 cards first/);
  practise(ctx);
  ctx.learn.saveSettings('me', { pick_words: false });
  assert.equal(ctx.learn.settings('me').pick_words, false);
  assert.equal(await ctx.pick.run('me'), 'off');
  assert.equal(ctx.pick.view('me').picking.enabled, false);
  assert.throws(() => ctx.learn.saveSettings('me', { pick_words: 'yes' }), error => error.statusCode === 400);
  ctx.learn.saveSettings('me', { pick_words: true });
  ctx.state.configured = false;
  assert.equal(await ctx.pick.run('me'), 'no-model');
  ctx.state.configured = true;
  ctx.state.company = true;
  assert.equal(await ctx.pick.run('me'), 'company');
  assert.equal(await ctx.pick.checkBacklog(), 'company');
  await assert.rejects(ctx.pick.check('me'), error => error.statusCode === 409);
  ctx.state.company = false;
  assert.equal(await ctx.pick.checkBacklog(), 'done');
  assert.equal(card(ctx, 'deploy').context, 'Please deploy the build again.');
  assert.equal(await ctx.pick.checkBacklog(), 'nothing');
});

test('the routes: GET /level and POST /level/check with a stubbed model; a new sentence is picked in the background; the errors are clear', async t => {
  const S = 'Our rollout needs a resilient plan.';
  const ctx = setup(t, { pick: () => ({ [S]: [{ word: 'rollout', zh: ZH_WORD }, { word: 'resilient', zh: ZH_WORD2 }] }) });
  const call = await serve(t, ctx);
  let view = (await call('GET', '/level')).body;
  assert.deepEqual(view, { level: null, picking: { enabled: true, picked: 0, skipped: 0, sentences: 0, pending: 0, running: false }, translator: true });
  const few = await call('POST', '/level/check');
  assert.equal(few.status, 400);
  assert.equal(few.body.error, 'Answer at least 10 cards first, so your level can be estimated');
  practise(ctx);
  // A report gives its summary to the question.
  ctx.learn.saveReport('me', { uid: 'report-0001', created_at: ctx.clock.now - DAY, covers_from: 0, covers_until: ctx.clock.now - DAY, auto: true, lang: 'en', mistakes: 2, answers: 10, model: 'Stub', body: { summary: 'Double letters slip.', kinds: [], findings: [] } });
  const checked = await call('POST', '/level/check');
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.deepEqual(checked.body.level, {
    level: 'B1', label: 'intermediate', reason: 'Most words are right; tenses slip.', answers: MIN_ANSWERS, mistakes: 2,
    report_at: new Date(ctx.clock.now - DAY).toISOString(), updated_at: new Date(ctx.clock.now).toISOString(),
  });
  const question = ctx.model.levels()[0];
  assert.equal(question.message.report, 'Double letters slip.');
  assert.deepEqual(question.message.totals, { answers: 10, right: 8, wrong: 2, cards: 5 });
  assert.deepEqual(question.message.cards.find(item => item.text === 'rebase'), { kind: 'word', text: 'rebase', right: 1, wrong: 1, modes: ['spell'], mistakes: { 'double-letter': 1 } });
  // Privacy: no time, no login, no written answer, no meaning.
  assert.doesNotMatch(question.user, /2026|\bme\b|rebasex|merge x/);
  assert.doesNotMatch(question.user, new RegExp(ZH_WORD));
  assert.equal(question.owner, 'me', 'asked with the owner\'s model');

  // A new translated sentence: picked a moment later, without delaying the save.
  const saved = await call('POST', '/cards', { kind: 'sentence', en: S, zh: ZH_SENTENCE, source: 'translation' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.card.context_zh, '');
  await ctx.pick.settle();
  view = (await call('GET', '/level')).body;
  assert.deepEqual(view.picking, { enabled: true, picked: 2, skipped: 0, sentences: 1, pending: 0, running: false });
  const rollout = (await call('GET', '/cards?source=translation&kind=word')).body.cards.find(item => item.en === 'rollout');
  assert.deepEqual([rollout.context, rollout.context_zh, rollout.source], [S, ZH_SENTENCE, 'translation']);
  // A sentence added by hand is not picked by itself.
  await call('POST', '/cards', { kind: 'sentence', en: 'This one was typed by hand.', zh: ZH_SENTENCE, source: 'manual' });
  await ctx.pick.settle();
  assert.equal(ctx.model.picks().length, 1);

  // The switch, with the other settings.
  assert.equal((await call('PUT', '/settings', { pick_words: false })).body.pick_words, false);
  assert.equal((await call('GET', '/settings')).body.pick_words, false);
  assert.equal((await call('PUT', '/settings', { pick_words: 1 })).status, 400);
  await call('PUT', '/settings', { pick_words: true });

  // One estimate at a time.
  let release;
  ctx.model.calls.length = 0;
  const slowChat = (owner, system, user) => (JSON.parse(user).sentences ? Promise.resolve('{"sentences": []}')
    : new Promise(resolve => { release = () => resolve('{"level":"B2","label":"upper intermediate","reason":"Better."}'); }));
  const slow = createLearnPick({ db: ctx.db, learn: ctx.learn, chat: slowChat, isConfigured: () => true, owner: () => 'me', now: () => ctx.clock.now, log: { warn() {}, info() {} } });
  const callSlow = await serve(t, { ...ctx, pick: slow });
  const first = callSlow('POST', '/level/check');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await callSlow('GET', '/level')).body.picking.running, true);
  const second = await callSlow('POST', '/level/check');
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'Your level is being estimated already');
  release();
  assert.equal((await first).body.level.level, 'B2');
  await slow.settle();
  // A bad answer: 502, the level stays as it was.
  const broken = createLearnPick({ db: ctx.db, learn: ctx.learn, chat: async () => 'You are good.', isConfigured: () => true, owner: () => 'me', now: () => ctx.clock.now, log: { warn() {}, info() {} } });
  const bad = await (await serve(t, { ...ctx, pick: broken }))('POST', '/level/check');
  assert.equal(bad.status, 502);
  assert.match(bad.body.error, /could not be read/);
  assert.equal(ctx.learn.level('me').level, 'B2');
  // No model: 503 with the translator's message; the view says so.
  ctx.state.configured = false;
  const none = await call('POST', '/level/check');
  assert.equal(none.status, 503);
  assert.equal(none.body.error, 'Translation service not configured yet');
  assert.equal((await call('GET', '/level')).body.translator, false);
  // The translator answering "not configured" (409) is the same.
  const notSet = createLearnPick({ db: ctx.db, learn: ctx.learn, chat: async () => { throw Object.assign(new Error('Translation service not configured yet'), { statusCode: 409 }); }, isConfigured: () => true, owner: () => 'me', now: () => ctx.clock.now, log: { warn() {}, info() {} } });
  assert.equal((await (await serve(t, { ...ctx, pick: notSet }))('POST', '/level/check')).status, 503);
});

test('the level again after each weekly mistake report, and a pick when it changed', async t => {
  const ctx = setup(t, { level: { level: 'B2', label: 'upper intermediate', reason: 'Fewer slips.' } });
  practise(ctx, 20);
  ctx.learn.saveLevel('me', { level: 'B1', label: 'intermediate', reason: 'Before.', answers: 1, mistakes: 0, report_at: null, updated_at: ctx.clock.now - DAY });
  // Ten new wrong answers make the weekly report due (services/learn-analysis.js).
  const wrong = ctx.learn.addCard('me', { kind: 'word', en: 'necessary', zh: ZH_WORD, source: 'manual' }).card;
  for (let index = 0; index < 10; index += 1) ctx.learn.answer('me', wrong.id, { mode: 'spell', grade: 'again', correct: false, answer: 'neccessary', tag: 'double-letter' });
  sentence(ctx, 'Please deploy the build again.');
  const analysis = createLearnAnalysis({
    learn: ctx.learn, chat: async () => JSON.stringify({ summary: 'Double letters.', findings: [] }), isConfigured: () => true, owner: () => 'me',
    now: () => ctx.clock.now, company: () => false, log: { warn() {}, info() {} },
  });
  analysis.onWeeklyReport(name => ctx.pick.afterReport(name));
  assert.equal(await analysis.checkWeekly(), 'done');
  await ctx.pick.settle();
  assert.equal(ctx.learn.level('me').level, 'B2');
  assert.equal(ctx.learn.level('me').report_at, new Date(ctx.clock.now).toISOString(), 'the new report was read');
  assert.equal(ctx.model.levels()[0].message.report, 'Double letters.');
  assert.equal(ctx.model.picks().length, 1, 'a new level: the sentences are picked again');
  assert.equal(ctx.pick.view('me').picking.pending, 0);
});

test('the hourly backlog runs on the normal engine with the smallest instance id among those that pick', async t => {
  const ctx = setup(t, { pick: () => ({}) });
  practise(ctx);
  sentence(ctx, 'Please deploy the build again.');
  const peers = [{ instance_id: 'aaa' }];
  const pick = createLearnPick({
    db: ctx.db, learn: ctx.learn, chat: ctx.model.chat, isConfigured: () => true, company: () => false, owner: () => 'me', now: () => ctx.clock.now,
    sync: { me: () => 'bbb', pickPeers: () => peers, company: () => false }, log: { warn() {}, info() {} },
  });
  assert.equal(await pick.checkBacklog(), 'other-engine');
  peers[0].instance_id = 'ccc';
  assert.equal(await pick.checkBacklog(), 'done');
  assert.equal(ctx.db.prepare("SELECT picked_level FROM learn_cards WHERE kind = 'sentence'").pluck().get(), 'B1');
});

// ---- Sync: two databases joined by pages (the transport is tested in test/learn-sync.test.js) ----
function syncSide(t, name, instanceId) {
  const db = database(t);
  const clock = { now: NOW };
  const learn = createLearn({ db, now: () => clock.now, timeZone: TZ, lookupWord: null, lookupPhonetic });
  learn.saveSettings('me', { starter: null });
  const sync = createLearnSync({
    db, identity: () => ({ instance_id: instanceId, name }), owner: () => 'me', learn, now: () => clock.now, timeZone: TZ,
    linkKeys: { publicKey: () => 'x', linkKey: () => Buffer.alloc(32) }, log: { warn() {}, info() {} }, intervalMs: 0,
  });
  return { db, clock, learn, sync, instanceId };
}
// Sends every row of `from` to `to` as the pull of a normal machine does.
const send = (from, to, { reviews = true } = {}) => to.sync.applyPage(from.sync.exportPage(0, 1000, { reviews }), from.instanceId, { bump: true });

test('sync: the level goes to every engine, the newest estimate wins both ways; a company computer gets a copy; the picks travel with the sentences', t => {
  const A = syncSide(t, 'A', 'engine-a');
  const B = syncSide(t, 'B', 'engine-b');
  A.learn.saveLevel('me', { level: 'B1', label: 'intermediate', reason: 'From A.', answers: 10, mistakes: 2, report_at: null, updated_at: NOW });
  assert.ok(send(A, B) > 0);
  assert.deepEqual(B.learn.level('me'), A.learn.level('me'));
  assert.equal(send(A, B), 0, 'nothing changes the second time');
  // Both estimate while apart: the later one wins on both sides, whichever way the pages go first.
  A.clock.now = NOW + 1000;
  B.clock.now = NOW + 2000;
  A.learn.saveLevel('me', { level: 'B2', label: 'upper intermediate', reason: 'From A again.', answers: 12, mistakes: 2, report_at: null, updated_at: A.clock.now });
  B.learn.saveLevel('me', { level: 'C1', label: 'advanced', reason: 'From B.', answers: 12, mistakes: 1, report_at: NOW, updated_at: B.clock.now });
  send(A, B);
  send(B, A);
  assert.equal(A.learn.level('me').level, 'C1');
  assert.deepEqual(A.learn.level('me'), B.learn.level('me'));
  assert.equal(readState(B.db, levelKey('me')).by, '', 'made on B: stored as this device');
  // A company computer's pull (cards only) still has the level, as a read-only copy.
  const C = syncSide(t, 'C', 'engine-c');
  C.sync.applyPage(A.sync.exportPage(0, 1000, { reviews: false }), A.instanceId, { bump: false });
  assert.equal(C.learn.level('me').level, 'C1');
  // A level that does not check is not applied.
  assert.equal(B.sync.applyPage({ level: { value: { level: 'C2', label: 'x', reason: 'x', answers: 1, mistakes: 0, updated_at: NOW }, at: NOW + 9e6, by: 'engine-z' } }, 'engine-z'), 0);
  assert.equal(B.learn.level('me').level, 'C1');

  // The pick of a sentence and the whole sentence of a picked word travel; the later pick wins.
  const long = `We need a resilient deploy step ${'and more words '.repeat(12)}today.`;
  assert.ok(long.length > 120 && long.length <= 300);
  const made = A.learn.addCard('me', { kind: 'sentence', en: long, zh: ZH_SENTENCE, source: 'translation' }).card;
  A.db.prepare("UPDATE learn_cards SET picked_level = 'B2', picked_skipped = 3, picked_at = ? WHERE id = ?").run(NOW + 5000, made.id);
  A.db.prepare(`INSERT INTO learn_cards (owner, kind, en, norm, zh, source, context, created_at, due_at, content_at, sync_seq)
    VALUES ('me', 'word', 'resilient', 'resilient', ?, 'translation', ?, ?, ?, ?, 999)`).run(ZH_WORD2, long, NOW, NOW, NOW + 6000);
  send(A, B);
  const onB = B.db.prepare("SELECT * FROM learn_cards WHERE kind = 'sentence' AND en = ?").get(long);
  assert.deepEqual([onB.picked_level, onB.picked_skipped, onB.picked_at], ['B2', 3, NOW + 5000]);
  assert.equal(B.db.prepare("SELECT context FROM learn_cards WHERE norm = 'resilient'").pluck().get(), long, 'the whole sentence (up to 300 characters)');
  B.db.prepare("UPDATE learn_cards SET picked_level = 'C1', picked_skipped = 1, picked_at = ?, sync_seq = 5000 WHERE id = ?").run(NOW + 7000, onB.id);
  send(B, A);
  assert.deepEqual(Object.values(A.db.prepare('SELECT picked_level, picked_skipped FROM learn_cards WHERE id = ?').get(made.id)), ['C1', 1]);
});

test('merge: an older peer without the pick never undoes one, and a cut context comes back whole from the same version', () => {
  const base = {
    kind: 'sentence', en: 'Please fix the login page.', zh: '', phonetic: '', source: 'translation', context: '', suspended: 0, created_at: 100, content_at: 10, content_by: 'a',
    due_at: 100, interval_days: 0, ease: 2.5, reps: 0, lapses: 0, last_result: null, last_at: null, last_correct: null, state_at: 0, state_by: 'a',
  };
  const local = { ...base, picked_level: 'B1', picked_skipped: 2, picked_at: 50 };
  const older = merge.cardFromPeer({ ...base, suspended: false }, 'b'); // no pick fields
  assert.deepEqual([older.picked_level, older.picked_at], ['', 0]);
  const kept = merge.mergeCard(local, older);
  assert.equal(kept.changed, false);
  assert.equal(kept.card.picked_level, 'B1');
  const later = merge.mergeCard(local, { ...older, picked_level: 'B2', picked_skipped: 0, picked_at: 60 });
  assert.deepEqual([later.changed, later.card.picked_level, later.card.picked_skipped], [true, 'B2', 0]);
  assert.equal(merge.mergeCard(local, { ...older, picked_level: 'B2', picked_at: 60 }, { follow: true }).card.picked_level, 'B1', 'a moved card brings no pick');
  assert.equal(merge.cardFromPeer({ ...base, suspended: false, picked_level: 'Z9', picked_skipped: 1, picked_at: 5 }, 'b').picked_level, '', 'an unknown level is none');

  const sentenceText = `We need a resilient deploy step ${'and more words '.repeat(12)}today.`;
  const word = { ...base, kind: 'word', en: 'resilient', context: sentenceText.slice(0, 120), picked_level: '', picked_skipped: 0, picked_at: 0 };
  const whole = merge.cardFromPeer({ ...word, context: sentenceText, suspended: false }, 'b');
  assert.equal(whole.context, sentenceText, 'a word card keeps a context of up to 300 characters');
  const restored = merge.mergeCard(word, whole);
  assert.deepEqual([restored.changed, restored.card.context], [true, sentenceText]);
  assert.equal(merge.mergeCard(word, { ...whole, context: `Another ${sentenceText}` }).card.context, word.context, 'only a context that starts with the one here');
  assert.equal(merge.cardFromPeer({ ...base, context: 'x'.repeat(200), suspended: false }, 'b').context.length, 120, 'other contexts keep 120');
  assert.equal(merge.levelFromPeer({ level: 'B1', label: 'intermediate', reason: 'Fine.', answers: 3, mistakes: 1, report_at: null, updated_at: 5 }).level, 'B1');
  assert.equal(merge.levelFromPeer({ level: 'B1', label: '', reason: 'Fine.', answers: 3, mistakes: 1, updated_at: 5 }), null);
});
