// English learning on the server (services/learn.js, routes/learn.js; "Learn English" in docs/design/learn-english.md): the checks of a card, the
// duplicate rule, answers, the queues of every mode, mistakes, the day's numbers, settings, the starter list, meanings through the translator (cached,
// 503 without one), the login and same-origin gates and the separation of owners. Each test uses its own database file in a temporary folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const { createLearn, checkEnglish, codeLike } = require('../services/learn');
// The audio settings with their defaults ("Audio" in docs/design/learn-english-page.md).
const AUDIO = { audio_words: true, audio_sentences: true, audio_sentences_at: 'after', audio_repeat: 2, audio_pause: 2, audio_speed: 'normal', audio_stop_on_typing: true,
  // The mistake analysis settings ("Mistake reports" in docs/design/learn-english.md), kept with them.
  analysis_auto: true, report_seen: '', report_lang: 'en', pick_words: true,
  // The desired retention of the review ("Desired retention" in docs/design/learn-review-fsrs.md).
  desired_retention: 0.9,
  // New words a day and the words added for one day ("New words a day" in docs/design/learn-review-fsrs.md).
  new_per_day: 10, extra_new: { day: '', count: 0 } };
const { createLearnRouter } = require('../routes/learn');
const { STARTER_LISTS, STARTER_PER_DAY } = require('../services/learn-starter');
const { TranslatorError } = require('../services/translator');
const { DAY } = require('../services/learn-review');

const NOW = Date.UTC(2026, 10, 19, 4, 0, 0); // 12:00 in Shanghai, the time zone these tests use for "today"
const TZ = 'Asia/Shanghai';
const ZH = '\u5408\u5e76'; // a Chinese meaning
const ZH_SENTENCE = '\u8bf7\u4fee\u590d\u767b\u5f55\u95ee\u9898';

function database(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-'));
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

// A clock the test moves; a translator that answers "meaning of <word>" and counts its calls (or fails as told).
function setup(t, { lookup = true } = {}) {
  const db = database(t);
  const clock = { now: NOW };
  const calls = [];
  let failure = null;
  const lookupWord = lookup ? async (owner, word) => {
    calls.push({ owner, word });
    if (failure) throw failure;
    return { word, meaning: `${ZH}:${word}` };
  } : async () => { throw new TranslatorError('Translation service not configured yet', 409); };
  const service = createLearn({ db, now: () => clock.now, timeZone: TZ, lookupWord });
  return { db, clock, calls, service, fail: error => { failure = error; } };
}

async function serve(t, service, { login = true } = {}) {
  const app = express();
  app.use(express.json({ limit: '32mb' }));
  // The page login: the owner is the login of the session, set by the test with the X-Test-Owner header.
  const requireAuth = (req, res, next) => {
    if (!login) return res.status(401).json({ error: 'AUTH_REQUIRED' });
    req.session = { user: { login: req.get('X-Test-Owner') || 'me' } };
    next();
  };
  app.use('/api/learn', createLearnRouter({ service, requireAuth }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/learn`;
  return async (method, url, body, { owner = 'me', headers = {} } = {}) => {
    const response = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-Test-Owner': owner, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
}
const sentence = (en, extra = {}) => ({ kind: 'sentence', en, zh: ZH_SENTENCE, source: 'translation', context: 'Fix login', ...extra });
const word = (en, extra = {}) => ({ kind: 'word', en, source: 'lookup', ...extra });
// Most tests do not want the starter list in their numbers.
const noStarter = async call => assert.equal((await call('PUT', '/settings', { starter: null })).status, 200);

test('sentences and words are checked: sizes, kinds, sources, word letters, at least three words, no code, no links only, no Chinese', () => {
  assert.equal(checkEnglish('sentence', '  Please   fix the\nlogin page.  '), 'Please fix the login page.');
  assert.equal(checkEnglish('word', 'Merge'), 'merge', 'a word is kept in lower case');
  assert.equal(checkEnglish('word', 'OAuth'), 'OAuth', 'an acronym keeps its capitals');
  assert.equal(checkEnglish('word', 'wasn\u2019t'), "wasn't", 'a curly apostrophe is made straight');
  assert.equal(checkEnglish('word', 'trade-off'), 'trade-off');
  for (const [kind, en, reason] of [
    ['word', '', /Enter the English text/], ['word', 'a'.repeat(41), /at most 40/], ['word', 'two words', /letters/], ['word', 'x2', /letters/], ['word', '-dash', /letters/],
    ['sentence', 'Fix it', /three words/], ['sentence', 'x'.repeat(301), /at most 300/], ['sentence', `see ${'\u4e2d\u6587'} here please`, /English/],
    ['sentence', 'https://example.com/a/b/c https://example.com/d', /three words/],
    ['sentence', 'if (ok) { return value; }', /code/], ['sentence', 'const a = 1; const b = 2; done', /code/], ['sentence', 'npm test && npm run build now', /code/],
    ['sentence', '/clear the whole session now', /code/], ['sentence', '$ git push origin main', /code/], ['sentence', 'x = compute(a, b) and more', /code/],
  ]) assert.throws(() => checkEnglish(kind, en), reason, `${kind} ${en}`);
  assert.equal(codeLike('Please fix the login redirect loop after the session cookie expires.'), false);
  assert.equal(codeLike('Open https://example.com/docs and read the setup part.'), false, 'a link inside a sentence is fine');
  assert.equal(codeLike('Run the tests, then tell me which ones fail (if any).'), false);
  assert.equal(codeLike('a+b*c/d%e^f|g~h<i>j'), true, 'mostly symbols');
});

test('a card is created once per owner, kind and text; adding it again returns it and fills an empty meaning', async t => {
  const { service, db } = setup(t);
  const call = await serve(t, service);
  await noStarter(call);
  const first = await call('POST', '/cards', sentence('Please fix the login page.', { zh: '' }));
  assert.equal(first.status, 200);
  assert.equal(first.body.created, true);
  const card = first.body.card;
  assert.deepEqual(Object.keys(card).sort(), ['context', 'context_zh', 'created_at', 'due_at', 'ease', 'en', 'id', 'interval_days', 'kind', 'last_at', 'last_result', 'lapses', 'phonetic', 'reps', 'retrievability', 'source', 'suspended', 'zh'].sort());
  assert.equal(card.en, 'Please fix the login page.');
  assert.equal(card.zh, '');
  assert.equal(card.context, 'Fix login');
  assert.equal(card.due_at, new Date(NOW).toISOString(), 'a new card is due now');
  assert.equal(card.interval_days, 0);
  assert.equal(card.ease, 2.5);
  assert.equal(card.suspended, false);
  assert.equal(card.last_result, null);

  const again = await call('POST', '/cards', sentence('  please FIX the   login page. ', { zh: ZH_SENTENCE }));
  assert.equal(again.body.created, false, 'case and spaces do not make another card');
  assert.equal(again.body.card.id, card.id);
  assert.equal(again.body.card.en, 'Please fix the login page.', 'the first text is kept');
  assert.equal(again.body.card.zh, ZH_SENTENCE, 'the empty meaning is filled');
  const third = await call('POST', '/cards', sentence('Please fix the login page.', { zh: 'other' }));
  assert.equal(third.body.card.zh, ZH_SENTENCE, 'a meaning that is there is not replaced');

  assert.equal((await call('POST', '/cards', word('Merge'))).body.created, true);
  assert.equal((await call('POST', '/cards', word('merge'))).body.created, false);
  assert.equal(db.prepare('SELECT COUNT(*) FROM learn_cards').pluck().get(), 2);

  for (const body of [{}, [], { kind: 'phrase', en: 'merge' }, word('merge', { source: 'web' }), word('two words'), sentence('Fix it'), sentence('ok', { zh: 'x'.repeat(501) }), word('merge', { zh: 5 })]) {
    const result = await call('POST', '/cards', body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(typeof result.body.error, 'string');
  }
  assert.equal(db.prepare('SELECT COUNT(*) FROM learn_cards').pluck().get(), 2, 'nothing was stored by the refused ones');
});

test('collected material is not kept while collecting is off; cards added by hand still are', async t => {
  const { service, db } = setup(t);
  const call = await serve(t, service);
  await noStarter(call);
  assert.deepEqual((await call('PUT', '/settings', { collect: false })).body, { collect: false, daily_goal: 20, starter: null, ...AUDIO });
  assert.deepEqual((await call('POST', '/cards', sentence('Please fix the login page.'))).body, { card: null, created: false, collecting: false });
  assert.deepEqual((await call('POST', '/cards', word('merge'))).body, { card: null, created: false, collecting: false });
  assert.equal(db.prepare('SELECT COUNT(*) FROM learn_cards').pluck().get(), 0);
  assert.equal((await call('POST', '/cards', word('merge', { source: 'manual' }))).body.created, true);
  assert.equal((await call('GET', '/summary')).body.collecting, false);
});

test('an answer applies the review rules, is logged, and its answer text is capped at 500 characters', async t => {
  const { service, db, clock } = setup(t);
  const call = await serve(t, service);
  await noStarter(call);
  const { card } = (await call('POST', '/cards', word('merge', { zh: ZH }))).body;
  const good = await call('POST', `/cards/${card.id}/answer`, { mode: 'spell', grade: 'good', correct: true, answer: 'merge' });
  assert.equal(good.status, 200);
  // FSRS-6 at the desired retention 0.9: a first good gives the stability S0(good) = 2.3065 days, 2 whole days.
  assert.equal(good.body.card.interval_days, 2);
  assert.equal(good.body.card.due_at, new Date(NOW + 2 * DAY).toISOString());
  assert.equal(good.body.card.retrievability, 1, 'just answered');
  assert.equal(good.body.card.reps, 1);
  assert.equal(good.body.card.last_result, 'good');
  assert.equal(good.body.card.last_at, new Date(NOW).toISOString());
  clock.now += DAY;
  const second = await call('POST', `/cards/${card.id}/answer`, { mode: 'review', grade: 'good', correct: true });
  assert.equal(second.body.card.interval_days, 7, 'good a day later: S = 7.3 days');
  assert.ok(second.body.card.retrievability === 1, 'just answered');
  const wrong = await call('POST', `/cards/${card.id}/answer`, { mode: 'review', grade: 'again', correct: false, answer: 'x'.repeat(900) });
  assert.equal(wrong.body.card.interval_days, 0);
  assert.equal(wrong.body.card.lapses, 1);
  assert.equal(wrong.body.card.ease, 2.5, 'the ease is no longer used and stays as it is');
  assert.equal(wrong.body.card.due_at, new Date(clock.now + 10 * 60 * 1000).toISOString());
  const rows = db.prepare('SELECT mode, grade, correct, length(answer) AS size FROM learn_reviews ORDER BY id').all();
  assert.deepEqual(rows.map(row => ({ ...row })), [
    { mode: 'spell', grade: 'good', correct: 1, size: 5 },
    { mode: 'review', grade: 'good', correct: 1, size: null },
    { mode: 'review', grade: 'again', correct: 0, size: 500 },
  ]);
  for (const body of [{ mode: 'spell', grade: 'easy', correct: true }, { mode: 'write', grade: 'good', correct: true }, { mode: 'spell', grade: 'good' }, { mode: 'spell', grade: 'good', correct: true, answer: 5 }]) {
    assert.equal((await call('POST', `/cards/${card.id}/answer`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call('POST', '/cards/999/answer', { mode: 'spell', grade: 'good', correct: true })).status, 404);
  assert.equal((await call('POST', '/cards/abc/answer', { mode: 'spell', grade: 'good', correct: true })).status, 404);
});

test('the queue of each mode: review takes due cards of both kinds, spell words, the sentence modes sentences; suspended cards never', async t => {
  const { service, clock } = setup(t);
  const call = await serve(t, service);
  await noStarter(call);
  const add = async (body, minutes) => { clock.now = NOW + minutes * 60 * 1000; return (await call('POST', '/cards', body)).body.card; };
  const s1 = await add(sentence('First sentence to practise today.'), 0);
  const w1 = await add(word('merge', { zh: ZH }), 1);
  const s2 = await add(sentence('Second sentence to practise today.'), 2);
  const w2 = await add(word('deploy', { zh: ZH }), 3);
  const s3 = await add(sentence('Third sentence that is suspended.'), 4);
  await call('PATCH', `/cards/${s3.id}`, { suspended: true });
  clock.now = NOW + 10 * 60 * 1000;
  // w1 answered good: due tomorrow, no longer in the review.
  await call('POST', `/cards/${w1.id}/answer`, { mode: 'spell', grade: 'good', correct: true });
  const ids = async (mode, limit, extra = '') => (await call('GET', `/queue?mode=${mode}${limit ? `&limit=${limit}` : ''}${extra}`)).body.cards.map(card => card.id);
  assert.deepEqual(await ids('review'), [s1.id, s2.id, w2.id], 'due cards, oldest due first');
  assert.deepEqual(await ids('review', 2), [s1.id, s2.id], 'the limit');
  assert.deepEqual(await ids('spell'), [w2.id], 'words: the due and the new ones; a learnt word that is not due is not given');
  assert.deepEqual(await ids('spell', 0, '&extra=practice'), [w2.id, w1.id], 'with extra=practice the learnt words that are not due follow');
  for (const mode of ['build', 'dictation', 'say', 'fill']) assert.deepEqual(await ids(mode), [s1.id, s2.id], mode);
  // s1 practised now (due again in 10 minutes, so not due yet): only the other sentence is given; with extra=practice s1 after it.
  await call('POST', `/cards/${s1.id}/answer`, { mode: 'build', grade: 'again', correct: false });
  assert.deepEqual(await ids('build'), [s2.id]);
  assert.deepEqual(await ids('build', 0, '&extra=practice'), [s2.id, s1.id]);
  assert.deepEqual(await ids('build', 0, '&extra=other'), [s2.id], 'another extra adds nothing');
  assert.deepEqual(await ids('mistakes'), [s1.id]);
  for (const query of ['?mode=other', '', '?mode=review&limit=0', '?mode=review&limit=101', '?mode=review&limit=two']) assert.equal((await call('GET', `/queue${query}`)).status, 400, query);
});

test('a word without a meaning asks the translator once; spell leaves out words without one while the translator fails', async t => {
  const { service, calls, fail } = setup(t);
  const call = await serve(t, service);
  await noStarter(call);
  await call('POST', '/cards', word('latency'));
  await call('POST', '/cards', word('timeout', { zh: ZH }));
  const first = (await call('GET', '/queue?mode=spell')).body.cards;
  assert.deepEqual(first.map(card => [card.en, card.zh]), [['latency', `${ZH}:latency`], ['timeout', ZH]]);
  assert.deepEqual(calls.map(c => c.word), ['latency']);
  await call('GET', '/queue?mode=spell');
  assert.equal(calls.length, 1, 'the meaning is kept in the card');
  // The translator fails: the queue does not know yet (the new word is past the first two cards, looked up in the background, which fails);
  // from then on a word without a meaning is left out of spell, but stays in the review.
  fail(new TranslatorError('Translation timed out; please retry', 504));
  await call('POST', '/cards', word('throughput'));
  assert.deepEqual((await call('GET', '/queue?mode=spell')).body.cards.map(card => [card.en, card.zh]), [['latency', `${ZH}:latency`], ['timeout', ZH], ['throughput', '']]);
  await service.settle();
  assert.deepEqual((await call('GET', '/queue?mode=spell')).body.cards.map(card => card.en), ['latency', 'timeout']);
  assert.ok((await call('GET', '/queue?mode=review')).body.cards.some(card => card.en === 'throughput' && card.zh === ''));
  // It works again (a /meaning of the page): the word is back.
  fail(null);
  assert.equal((await call('POST', '/meaning', { word: 'throughput' })).body.zh, `${ZH}:throughput`);
  assert.deepEqual((await call('GET', '/queue?mode=spell')).body.cards.map(card => card.en), ['latency', 'timeout', 'throughput']);
});

test('a queue waits for the first two cards only: the others get their meanings in the background, and the page and the fill ask once', async t => {
  const db = database(t);
  const calls = [];
  const gates = new Map();
  // A slow translator: each word answers when the test opens its gate.
  const lookupWord = (owner, word) => {
    calls.push(word);
    return new Promise(resolve => gates.set(word, () => resolve({ word, meaning: `${ZH}:${word}` })));
  };
  const service = createLearn({ db, now: () => NOW, timeZone: TZ, lookupWord });
  service.saveSettings('me', { starter: null });
  for (const en of ['alpha', 'bravo', 'charlie', 'delta', 'echo']) service.addCard('me', word(en));
  const queued = service.queue('me', 'spell', 20);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['alpha', 'bravo'], 'only the first two are asked before the answer');
  gates.get('alpha')();
  gates.get('bravo')();
  const cards = (await queued).cards;
  assert.deepEqual(cards.map(card => [card.en, card.zh]), [['alpha', `${ZH}:alpha`], ['bravo', `${ZH}:bravo`], ['charlie', ''], ['delta', ''], ['echo', '']]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.slice(2), ['charlie', 'delta', 'echo'], 'the rest in the background');
  // The page shows charlie before the fill is done: its /meaning joins the lookup in progress instead of asking again.
  const meaning = service.meaning('me', 'charlie');
  for (const en of ['charlie', 'delta', 'echo']) gates.get(en)();
  assert.equal((await meaning).zh, `${ZH}:charlie`);
  await service.settle();
  assert.equal(calls.filter(en => en === 'charlie').length, 1);
  assert.deepEqual(db.prepare("SELECT en, zh FROM learn_cards WHERE owner = 'me' ORDER BY id").all().map(row => row.zh), ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map(en => `${ZH}:${en}`), 'stored on the cards');
});

test('/meaning: the translator once per word (a card, or the cache), errors passed on, 503 when no translator is set up', async t => {
  const { service, calls, fail } = setup(t);
  const call = await serve(t, service);
  await noStarter(call);
  assert.deepEqual((await call('POST', '/meaning', { word: 'Rebase' })).body, { zh: `${ZH}:rebase`, phonetic: '' });
  assert.deepEqual((await call('POST', '/meaning', { word: 'rebase' })).body, { zh: `${ZH}:rebase`, phonetic: '' });
  assert.equal(calls.length, 1, 'cached: the same word is translated once');
  // A word card without a meaning gets it.
  const { card } = (await call('POST', '/cards', word('rollback'))).body;
  await call('POST', '/meaning', { word: 'rollback' });
  assert.equal((await call('GET', '/cards?kind=word')).body.cards.find(item => item.id === card.id).zh, `${ZH}:rollback`);
  assert.equal(calls.length, 2);
  // A meaning edited by the person is what /meaning answers.
  await call('PATCH', `/cards/${card.id}`, { zh: 'mine' });
  assert.equal((await call('POST', '/meaning', { word: 'rollback' })).body.zh, 'mine');
  assert.equal(calls.length, 2);
  for (const body of [{}, { word: 'two words' }, { word: 5 }]) assert.equal((await call('POST', '/meaning', body)).status, 400, JSON.stringify(body));
  fail(new TranslatorError('Translation timed out; please retry', 504));
  assert.deepEqual(await call('POST', '/meaning', { word: 'outage' }), { status: 504, body: { error: 'Translation timed out; please retry' } });

  const none = setup(t, { lookup: false });
  const bare = await serve(t, none.service);
  assert.deepEqual(await bare('POST', '/meaning', { word: 'merge' }), { status: 503, body: { error: 'Translation service not configured yet' } });
});

test('phonetic transcriptions: from the dictionary, else from the page or the translator (once), kept on the card without a new content time', async t => {
  const db = database(t);
  const calls = [];
  const lookupWord = async (owner, word) => {
    calls.push(word);
    if (word === 'idempotent') return { word, base: 'idempotent', phonetic: '/aɪˈdɛmpətənt/', meaning: `${ZH}:${word}` };
    if (word === 'grokked') return { word, base: 'grok', phonetic: '/ɡrɑk/', meaning: `${ZH}:${word}` };
    return { word, meaning: `${ZH}:${word}` };
  };
  const service = createLearn({ db, now: () => NOW, timeZone: TZ, lookupWord });
  const call = await serve(t, service);
  await noStarter(call);
  // A word in the dictionary gets it when it is added; a sentence never has one.
  const expire = (await call('POST', '/cards', word('Expire'))).body.card;
  assert.equal(expire.phonetic, '/ɪkˈspaɪər/');
  assert.equal((await call('POST', '/cards', sentence('Please fix the login page.'))).body.card.phonetic, '');
  // The dictionary wins over what the page sends; a word it does not have keeps the page's (checked) one.
  assert.equal((await call('POST', '/cards', word('deploy', { phonetic: '/wrong/' }))).body.card.phonetic, '/dɪˈplɔɪ/');
  assert.equal((await call('POST', '/cards', word('kubectl', { phonetic: 'kuːb kənˈtroʊl' }))).body.card.phonetic, '/kuːb kənˈtroʊl/');
  assert.equal((await call('POST', '/cards', word('yaml', { phonetic: '<b>x</b>' }))).body.card.phonetic, '');
  assert.equal((await call('POST', '/cards', word('jq', { phonetic: 5 }))).status, 400);
  // A word nobody knows yet: the spell queue asks the translator once while the server runs, and keeps its answer for the word itself only.
  db.prepare("INSERT INTO learn_cards (owner, kind, en, norm, zh, source, created_at, due_at) VALUES ('me', 'word', 'idempotent', 'idempotent', 'x', 'manual', 1, 1), ('me', 'word', 'grokked', 'grokked', 'y', 'manual', 1, 1)").run();
  const before = db.prepare("SELECT content_at, sync_seq FROM learn_cards WHERE norm = 'idempotent'").get();
  const queued = (await call('GET', '/queue?mode=spell')).body.cards;
  assert.equal(queued.find(card => card.en === 'idempotent').phonetic, '/aɪˈdɛmpətənt/');
  assert.equal(queued.find(card => card.en === 'grokked').phonetic, '', 'the translator named another form: not kept');
  assert.equal(queued.find(card => card.en === 'yaml').phonetic, '');
  const after = db.prepare("SELECT content_at, sync_seq, phonetic FROM learn_cards WHERE norm = 'idempotent'").get();
  assert.equal(after.content_at, before.content_at, 'the content clock is kept (an empty transcription never wins in the merge)');
  assert.ok(after.sync_seq > before.sync_seq, 'a new change number, so the linked devices get it');
  const asked = calls.length;
  await call('GET', '/queue?mode=spell');
  assert.equal(calls.length, asked, 'not asked again');
  // The material list reads the dictionary only.
  db.prepare("INSERT INTO learn_cards (owner, kind, en, norm, source, created_at, due_at) VALUES ('me', 'word', 'latency', 'latency', 'manual', 2, 2), ('me', 'word', 'frobnicate', 'frobnicate', 'manual', 2, 2)").run();
  const listed = (await call('GET', '/cards?kind=word')).body.cards;
  assert.equal(listed.find(card => card.en === 'latency').phonetic, '/ˈleɪtənsi/');
  assert.equal(calls.length, asked, 'the list never asks the translator');
  assert.equal(db.prepare("SELECT phonetic FROM learn_cards WHERE norm = 'latency'").get().phonetic, '/ˈleɪtənsi/', 'stored');
  // A text edit to another word takes that word's transcription.
  assert.equal((await call('PATCH', `/cards/${expire.id}`, { en: 'merge' })).body.card.phonetic, '/mɜrdʒ/');
  // /meaning answers it too.
  assert.equal((await call('POST', '/meaning', { word: 'cache' })).body.phonetic, '/kæʃ/');
});

test('the material list: kind filter, search in English and Chinese, paging, newest first', async t => {
  const { service, clock } = setup(t);
  const call = await serve(t, service);
  await noStarter(call);
  for (const [index, body] of [word('merge', { zh: ZH }), word('deploy'), sentence('Please merge the branch now.'), sentence('Deploy the 100% build today.')].entries()) {
    clock.now = NOW + index * 1000;
    await call('POST', '/cards', body);
  }
  const list = async query => (await call('GET', `/cards${query}`)).body;
  assert.deepEqual((await list('')).cards.map(card => card.en), ['Deploy the 100% build today.', 'Please merge the branch now.', 'deploy', 'merge']);
  assert.equal((await list('')).total, 4);
  assert.deepEqual((await list('?kind=word')).cards.map(card => card.en), ['deploy', 'merge']);
  assert.deepEqual((await list('?q=MERGE')).cards.map(card => card.en), ['Please merge the branch now.', 'merge']);
  assert.deepEqual((await list(`?q=${encodeURIComponent(ZH)}`)).cards.map(card => card.en), ['merge'], 'the meaning is searched too');
  assert.deepEqual((await list('?q=100%25')).cards.map(card => card.en), ['Deploy the 100% build today.'], 'a % is a character, not a wildcard');
  assert.deepEqual((await list('?q=_')).cards, []);
  const page = await list('?limit=2&offset=1');
  assert.deepEqual(page.cards.map(card => card.en), ['Please merge the branch now.', 'deploy']);
  assert.equal(page.total, 4);
  for (const query of ['?kind=phrase', '?limit=0', '?limit=201', '?offset=-1']) assert.equal((await call('GET', `/cards${query}`)).status, 400, query);
});

test('PATCH changes the meaning, the text (checked, no duplicate) and suspension; nothing else', async t => {
  const { service } = setup(t);
  const call = await serve(t, service);
  await noStarter(call);
  const a = (await call('POST', '/cards', sentence('Please fix the login page.'))).body.card;
  const b = (await call('POST', '/cards', sentence('Please fix the logout page.'))).body.card;
  const changed = await call('PATCH', `/cards/${a.id}`, { zh: ` ${ZH} `, en: 'Please fix the  login form.', suspended: true });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.card.zh, ZH);
  assert.equal(changed.body.card.en, 'Please fix the login form.');
  assert.equal(changed.body.card.suspended, true);
  assert.equal((await call('PATCH', `/cards/${a.id}`, { en: b.en.toUpperCase() })).status, 409, 'the text of another card');
  for (const body of [{ en: 'Fix it' }, { suspended: 'yes' }, { reps: 5 }, { zh: 'x'.repeat(501) }]) assert.equal((await call('PATCH', `/cards/${a.id}`, body)).status, 400, JSON.stringify(body));
  assert.equal((await call('PATCH', '/cards/12345', { zh: ZH })).status, 404);
  assert.equal((await call('PATCH', `/cards/${a.id}`, { suspended: false })).body.card.suspended, false);
});

test('the summary: due, new and done today, the goal, the streak in the server\'s time zone, counts and mistakes', async t => {
  const { service, clock } = setup(t);
  const call = await serve(t, service);
  await noStarter(call);
  await call('PUT', '/settings', { daily_goal: 5 });
  // Yesterday (Shanghai): one card made and answered. Today: two cards made, three answers.
  clock.now = NOW - DAY;
  const old = (await call('POST', '/cards', word('merge', { zh: ZH }))).body.card;
  await call('POST', `/cards/${old.id}/answer`, { mode: 'spell', grade: 'good', correct: true });
  clock.now = NOW;
  const s = (await call('POST', '/cards', sentence('Please fix the login page.'))).body.card;
  const w = (await call('POST', '/cards', word('deploy', { zh: ZH }))).body.card;
  await call('POST', `/cards/${s.id}/answer`, { mode: 'build', grade: 'again', correct: false });
  await call('POST', `/cards/${w.id}/answer`, { mode: 'spell', grade: 'good', correct: true });
  await call('POST', `/cards/${old.id}/answer`, { mode: 'review', grade: 'hard', correct: true });
  assert.deepEqual((await call('GET', '/summary')).body, {
    // new_today: the cards first answered today (merge was first answered yesterday); three answers at one moment: 15 seconds, 0 minutes.
    due: 0, new_per_day: 10, new_today: 2, new_left: 8, done_today: 3, minutes_today: 0, goal: 5, streak: 2, words: 2, sentences: 1, mistakes: 1,
    collecting: true, starter: null, new_report: null, chats: 0,
    // Where the data is kept (services/learn-sync.js): a normal machine, nothing waiting.
    device: { company_computer: false, cache_only: false, home_name: null, home_online: null, waiting: 0, offline_copy_at: null },
  });
  clock.now = NOW + 11 * 60 * 1000;
  assert.equal((await call('GET', '/summary')).body.due, 1, 'the "again" card is due after 10 minutes');
  // Two days later with no answers in between: the streak is over.
  clock.now = NOW + 2 * DAY;
  const later = (await call('GET', '/summary')).body;
  assert.equal(later.streak, 0);
  assert.equal(later.done_today, 0);
  assert.equal(later.new_today, 0);
});

test('mistakes: a wrong last answer, or a failed card with a wrong answer in the last 30 days', async t => {
  const { service, clock } = setup(t);
  const call = await serve(t, service);
  await noStarter(call);
  const card = (await call('POST', '/cards', word('merge', { zh: ZH }))).body.card;
  await call('POST', `/cards/${card.id}/answer`, { mode: 'spell', grade: 'again', correct: false });
  assert.deepEqual((await call('GET', '/queue?mode=mistakes')).body.cards.map(c => c.id), [card.id]);
  await call('POST', `/cards/${card.id}/answer`, { mode: 'spell', grade: 'good', correct: true });
  assert.equal((await call('GET', '/summary')).body.mistakes, 1, 'right now, but failed with a wrong answer this month');
  clock.now = NOW + 31 * DAY;
  assert.equal((await call('GET', '/summary')).body.mistakes, 0, 'the wrong answer is more than 30 days old');
  await call('PATCH', `/cards/${card.id}`, { suspended: true });
  await call('POST', `/cards/${card.id}/answer`, { mode: 'spell', grade: 'hard', correct: false });
  assert.deepEqual((await call('GET', '/queue?mode=mistakes')).body.cards, [], 'a suspended card is never in a queue');
});

test('settings: defaults, checks, and the starter list imported once with its words due a few a day', async t => {
  const { service, db, clock } = setup(t);
  const call = await serve(t, service);
  assert.deepEqual((await call('GET', '/settings')).body, { collect: true, daily_goal: 20, starter: 'dev', ...AUDIO });
  for (const body of [{ daily_goal: 0 }, { daily_goal: 201 }, { daily_goal: 2.5 }, { collect: 'yes' }, { starter: 'medicine' }, { theme: 'dark' }, [],
    { audio_repeat: 4 }, { audio_pause: 0 }, { audio_speed: 'fast' }, { audio_words: 'on' }, { audio_sentences_at: 'never' }, { audio_stop_on_typing: 1 },
    { new_per_day: 7 }, { new_per_day: '10' }, { new_per_day: 0 }]) {
    assert.equal((await call('PUT', '/settings', body)).status, 400, JSON.stringify(body));
  }
  // The audio settings are saved one at a time and read back.
  const audio = (await call('PUT', '/settings', { audio_repeat: 5, audio_pause: 1, audio_speed: 'slow', audio_sentences_at: 'start', audio_words: false, audio_stop_on_typing: false })).body;
  assert.deepEqual(audio, { collect: true, daily_goal: 20, starter: 'dev', ...AUDIO, audio_repeat: 5, audio_pause: 1, audio_speed: 'slow', audio_sentences_at: 'start', audio_words: false, audio_stop_on_typing: false });
  assert.deepEqual((await call('GET', '/settings')).body, audio);
  await call('PUT', '/settings', AUDIO);
  const words = STARTER_LISTS.dev.words;
  assert.ok(words.length >= 280 && words.length <= 340, `about 300 words: ${words.length}`);
  for (const item of words) assert.match(item, /^[a-z][a-z'-]{0,39}$/, 'English words only');
  // The first summary imports the chosen list.
  const first = (await call('GET', '/summary')).body;
  assert.equal(first.words, words.length);
  assert.equal(first.due, STARTER_PER_DAY, 'only a few starter words a day are due');
  assert.equal(first.starter, 'dev');
  assert.equal(first.new_today, 0, 'new today counts first answers, not imported cards');
  assert.equal(first.new_left, 10);
  assert.deepEqual((await call('POST', '/starter', { list: 'dev' })).body, { added: 0 }, 'already imported');
  clock.now = NOW + DAY;
  // Two days of starter words are due, but at most today's new words left (new_per_day 10) count.
  assert.equal((await call('GET', '/summary')).body.due, Math.min(2 * STARTER_PER_DAY, 10));
  assert.equal((await call('PUT', '/settings', { new_per_day: 30 })).body.new_per_day, 30);
  assert.equal((await call('GET', '/summary')).body.due, 2 * STARTER_PER_DAY);
  // The words added for a day are changed by POST /new-words only: PUT /settings takes the field and keeps the stored value.
  assert.deepEqual((await call('PUT', '/settings', { new_per_day: 10, extra_new: { day: '2026-11-20', count: 40 } })).body.extra_new, { day: '', count: 0 });
  // A word the person already had is kept as theirs.
  const fresh = setup(t);
  const other = await serve(t, fresh.service);
  await other('PUT', '/settings', { starter: null });
  await other('POST', '/cards', word('merge', { zh: ZH }));
  assert.deepEqual((await other('POST', '/starter', { list: 'dev' })).body, { added: words.length - 1 });
  assert.deepEqual((await other('POST', '/starter', { list: 'dev' })).body, { added: 0 });
  assert.equal((await other('GET', '/settings')).body.starter, 'dev', 'importing chooses the list');
  assert.equal(fresh.db.prepare("SELECT source FROM learn_cards WHERE norm = 'merge'").pluck().get(), 'lookup');
  assert.equal((await other('POST', '/starter', { list: 'other' })).status, 400);
  // No starter list: the untouched starter words are hidden, the practised ones stay.
  const starterCard = db.prepare("SELECT id FROM learn_cards WHERE owner = 'me' AND norm = 'deploy'").pluck().get();
  await call('POST', `/cards/${starterCard}/answer`, { mode: 'spell', grade: 'good', correct: true });
  await call('PUT', '/settings', { starter: null });
  const hidden = (await call('GET', '/summary')).body;
  assert.equal(hidden.words, 1);
  assert.equal((await call('GET', '/cards')).body.total, 1);
  await call('PUT', '/settings', { starter: 'dev' });
  assert.equal((await call('GET', '/summary')).body.words, words.length, 'chosen again: the same words come back, none twice');
  assert.equal(db.prepare("SELECT COUNT(*) FROM learn_cards WHERE owner = 'me'").pluck().get(), words.length);
});

test('owners are kept apart: cards, queues, answers, settings and summaries', async t => {
  const { service } = setup(t);
  const call = await serve(t, service);
  await noStarter(call);
  await call('PUT', '/settings', { starter: null }, { owner: 'other' });
  const mine = (await call('POST', '/cards', word('merge', { zh: ZH }))).body.card;
  const theirs = (await call('POST', '/cards', word('merge'), { owner: 'other' })).body;
  assert.equal(theirs.created, true, 'the same word is a card of its own for another owner');
  assert.notEqual(theirs.card.id, mine.id);
  assert.equal(theirs.card.zh, '');
  assert.equal((await call('POST', `/cards/${mine.id}/answer`, { mode: 'spell', grade: 'good', correct: true }, { owner: 'other' })).status, 404);
  assert.equal((await call('PATCH', `/cards/${mine.id}`, { zh: 'x' }, { owner: 'other' })).status, 404);
  assert.deepEqual((await call('GET', '/cards', undefined, { owner: 'other' })).body.cards.map(card => card.id), [theirs.card.id]);
  await call('PUT', '/settings', { collect: false, daily_goal: 3 }, { owner: 'other' });
  assert.deepEqual((await call('GET', '/settings')).body, { collect: true, daily_goal: 20, starter: null, ...AUDIO });
  await call('POST', `/cards/${mine.id}/answer`, { mode: 'spell', grade: 'again', correct: false });
  assert.equal((await call('GET', '/summary', undefined, { owner: 'other' })).body.done_today, 0);
  assert.equal((await call('GET', '/summary', undefined, { owner: 'other' })).body.mistakes, 0);
  assert.deepEqual((await call('GET', '/queue?mode=review', undefined, { owner: 'other' })).body.cards.map(card => card.id), [theirs.card.id]);
});

test('every route needs the page login, and changes need the same-origin proof', async t => {
  const { service } = setup(t);
  const locked = await serve(t, service, { login: false });
  for (const [method, url, body] of [['GET', '/summary'], ['GET', '/queue?mode=review'], ['GET', '/cards'], ['POST', '/cards', word('merge')], ['POST', '/cards/1/answer', {}], ['PATCH', '/cards/1', {}], ['POST', '/meaning', { word: 'merge' }], ['POST', '/starter', { list: 'dev' }], ['GET', '/settings'], ['PUT', '/settings', {}]]) {
    assert.equal((await locked(method, url, body)).status, 401, `${method} ${url}`);
  }
  const call = await serve(t, service);
  const noProof = await call('POST', '/cards', word('merge'), { headers: { 'X-Requested-With': '' } });
  assert.deepEqual(noProof, { status: 403, body: { error: 'CLIENT_ORIGIN_REQUIRED' } });
  const crossSite = await call('PUT', '/settings', { collect: false }, { headers: { Origin: 'https://evil.example' } });
  assert.equal(crossSite.status, 403);
  assert.equal((await call('GET', '/settings')).body.collect, true);
});

test('every English error message of the learning routes has a Chinese translation', () => {
  const source = ['services/learn.js', 'routes/learn.js', 'services/learn-analysis.js', 'services/learn-sync.js'].map(file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')).join('\n');
  const dictionary = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'i18n-zh-server.js'), 'utf8');
  const messages = new Set();
  for (const match of source.matchAll(/(?:bad|LearnError)\((['`])([^'`]+)\1/g)) {
    let n = 0;
    messages.add(match[2].replace(/\$\{[^}]+\}/g, () => `{${++n}}`)); // `at most ${MAX_WORD} characters` is the template 'at most {1} characters'
  }
  messages.add('Learning data is not available right now');
  assert.ok(messages.size >= 15, [...messages].join(' | '));
  for (const message of messages) assert.ok(dictionary.includes(JSON.stringify(message)), `missing Chinese text for: ${message}`);
});
