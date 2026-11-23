// Learn at a calmer pace ("New words a day" and "Keeps slipping" in docs/design/learn-review-fsrs.md): the cap of new cards in every queue but
// mistakes, extra=practice, new_today from first answers, POST /new-words (raised today, reset the next day), the summary's due, new_left and
// minutes_today, the leech rule with its different-days exit, the parts and the tip from a fake chat model (checked, stored once, filled in the
// background, never blocking), the schema 23 columns on an older database, and a hard answer that was wrong (not a lapse).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const learnModule = require('../services/learn');
const { createLearn, checkParts, storedParts, checkTip, parseSpelling, studyMinutes, mergeExtraNew, cleanExtraNew } = learnModule;
const { createLearnRouter } = require('../routes/learn');
const { DAY, AGAIN_MS } = require('../services/learn-review');
const syncStore = require('../services/learn-sync-store');
const schedule = require('../services/learn-schedule');

const NOW = Date.UTC(2026, 10, 19, 4, 0, 0); // 12:00 in Shanghai, the time zone of "today" here
const TZ = 'Asia/Shanghai';
const ZH = '\u5408\u5e76';
const ZH_SENTENCE = '\u8bf7\u4fee\u590d\u767b\u5f55\u95ee\u9898';
const MINUTE = 60 * 1000;

function database(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-pace-'));
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

// A clock the test moves, a translator that knows every word, and (when given) a fake chat model.
function setup(t, { chat = null } = {}) {
  const db = database(t);
  const clock = { now: NOW };
  const lookupWord = async (owner, word) => ({ word, meaning: `${ZH}:${word}` });
  const service = createLearn({ db, now: () => clock.now, timeZone: TZ, lookupWord, chat, onNewWords: () => {} });
  return { db, clock, service };
}

async function serve(t, service) {
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => { req.session = { user: { login: 'me' } }; next(); };
  app.use('/api/learn', createLearnRouter({ service, requireAuth }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/learn`;
  const call = async (method, url, body) => {
    const response = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  assert.equal((await call('PUT', '/settings', { starter: null })).status, 200);
  return call;
}

const word = (en, extra = {}) => ({ kind: 'word', en, zh: `${ZH}:${en}`, source: 'manual', ...extra });
const sentence = en => ({ kind: 'sentence', en, zh: ZH_SENTENCE, source: 'manual' });
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar'];
// Adds the words one millisecond apart (so their due dates keep this order) and returns their cards by text.
async function addWords(call, clock, words = WORDS) {
  const cards = {};
  for (const en of words) { cards[en] = (await call('POST', '/cards', word(en))).body.card; clock.now += 1; }
  return cards;
}
const queue = async (call, query) => (await call('GET', `/queue?${query}`)).body.cards;
const answer = (call, card, grade, correct = grade !== 'again', mode = 'spell') => call('POST', `/cards/${card.id}/answer`, { mode, grade, correct });

test('new words a day: spell, review and build give due cards, then at most new_left new ones; extra=practice adds the learnt cards not due', async t => {
  const { clock, db, service } = setup(t);
  const call = await serve(t, service);
  const cards = await addWords(call, clock);
  const sentences = [];
  for (let index = 0; index < 12; index += 1) { sentences.push((await call('POST', '/cards', sentence(`Sentence number ${index} for the practice.`))).body.card); clock.now += 1; }

  // Default 10 a day: 15 new words, 12 new sentences.
  const spell = await queue(call, 'mode=spell');
  assert.deepEqual(spell.map(card => card.en), WORDS.slice(0, 10), 'new words by due date, at most 10');
  assert.ok(spell.every(card => card.is_new === true && card.missed === 0 && card.leech === false && card.parts === null && card.tip === ''));
  assert.equal((await queue(call, 'mode=review')).length, 10, 'review: at most 10 new cards');
  assert.equal((await queue(call, 'mode=build')).length, 10, 'build: at most 10 new sentences');
  assert.equal((await queue(call, 'mode=fill&limit=4')).length, 4, 'the limit still applies');

  // Three words answered right: three new words met today, 7 left; they are not due, so they are not given again.
  for (const en of ['alpha', 'bravo', 'charlie']) await answer(call, cards[en], 'good');
  const after = await queue(call, 'mode=spell');
  assert.deepEqual(after.map(card => card.en), WORDS.slice(3, 10));
  // The sentence modes share the day's allowance: 7 new sentences left.
  assert.equal((await queue(call, 'mode=build')).length, 7);
  // Practice: due, new, then the learnt words not due, the least recently practised first.
  clock.now += 1000;
  await answer(call, cards.alpha, 'good');
  const practice = await queue(call, 'mode=spell&extra=practice');
  assert.deepEqual(practice.map(card => card.en), [...WORDS.slice(3, 10), 'bravo', 'charlie', 'alpha']);
  assert.deepEqual(practice.map(card => card.is_new), [...Array(7).fill(true), false, false, false]);

  // A word answered wrong is due again in 10 minutes: then it comes first, before the new words.
  await answer(call, cards.delta, 'again');
  clock.now += AGAIN_MS + 1000;
  const due = await queue(call, 'mode=spell');
  assert.equal(due[0].en, 'delta');
  assert.equal(due[0].is_new, false);
  assert.deepEqual(due.slice(1).map(card => card.en), WORDS.slice(4, 10), '4 new words met today: 6 left');
  assert.equal((await queue(call, 'mode=mistakes')).map(card => card.en).join(), 'delta', 'mistakes has no cap');

  // Review only takes new cards due now (a starter word due tomorrow waits); spell takes any new word.
  db.prepare("UPDATE learn_cards SET due_at = ? WHERE norm = 'echo'").run(clock.now + DAY);
  assert.equal((await call('PUT', '/settings', { new_per_day: 30 })).status, 200);
  const all = await queue(call, 'mode=spell&limit=50');
  assert.deepEqual(all.map(card => card.en), ['delta', ...WORDS.slice(5), 'echo'], 'echo is due last');
  const review = await queue(call, 'mode=review&limit=50');
  assert.ok(!review.some(card => card.en === 'echo'), 'review leaves out the new card that is not due');
  assert.equal(review.filter(card => card.is_new).length, 26 - 4, '30 a day: every new card due now (10 words and 12 sentences)');
});

test('new_today counts the cards whose first answer is today, once each; it starts again the next day', async t => {
  const { clock, service } = setup(t);
  const call = await serve(t, service);
  clock.now = NOW - DAY;
  const cards = await addWords(call, clock, ['alpha', 'bravo', 'charlie']);
  await answer(call, cards.alpha, 'good'); // first answered yesterday
  clock.now = NOW;
  await answer(call, cards.alpha, 'good'); // again today: not new today
  await answer(call, cards.bravo, 'again'); // made yesterday, first answered today
  await answer(call, cards.bravo, 'good'); // twice today: counted once
  const summary = (await call('GET', '/summary')).body;
  assert.deepEqual([summary.new_per_day, summary.new_today, summary.new_left], [10, 1, 9]);
  clock.now = NOW + DAY;
  assert.equal((await call('GET', '/summary')).body.new_today, 0);
  assert.equal((await call('GET', '/summary')).body.new_left, 10);
});

test('POST /new-words raises today\'s allowance, is kept in the settings, and is gone the next day', async t => {
  const { clock, service } = setup(t);
  const call = await serve(t, service);
  await addWords(call, clock);
  assert.deepEqual((await call('POST', '/new-words', { count: 5 })).body, { new_per_day: 10, new_today: 0, new_left: 15 });
  assert.equal((await queue(call, 'mode=spell')).length, 15);
  assert.deepEqual((await call('POST', '/new-words', { count: 5 })).body, { new_per_day: 10, new_today: 0, new_left: 20 });
  assert.deepEqual((await call('GET', '/settings')).body.extra_new, { day: '2026-11-19', count: 10 });
  for (const body of [{}, { count: 0 }, { count: 51 }, { count: 2.5 }, { count: '5' }, []]) assert.equal((await call('POST', '/new-words', body)).status, 400, JSON.stringify(body));
  const summary = (await call('GET', '/summary')).body;
  assert.deepEqual([summary.new_left, summary.due], [20, 15], 'due: the 15 new words, all within the allowance');
  // Changing new words a day keeps today's extra words.
  await call('PUT', '/settings', { new_per_day: 5 });
  assert.equal((await call('GET', '/summary')).body.new_left, 15);
  // The next day (Shanghai) the allowance is new_per_day again.
  clock.now = NOW + DAY;
  assert.equal((await call('GET', '/summary')).body.new_left, 5);
  assert.deepEqual((await call('POST', '/new-words', { count: 5 })).body.new_left, 10, 'a new day starts from new_per_day');
  assert.deepEqual((await call('GET', '/settings')).body.extra_new, { day: '2026-11-20', count: 5 });
});

test('the summary: due is the due cards that are not new plus the new ones Review would give; minutes_today from the answer times', async t => {
  const { clock, service } = setup(t);
  const call = await serve(t, service);
  const cards = await addWords(call, clock);
  // Yesterday's answer does not count today.
  clock.now = NOW - DAY;
  await answer(call, cards.oscar, 'good');
  clock.now = NOW;
  // Answers at 0 s, 60 s, 120 s, 10 min (a gap over 120 s: counted as 120 s, and a new run) and 10 min 90 s:
  // 15 + 60 + 60 + 120 + 15 + 90 = 360 s = 6 minutes.
  await answer(call, cards.alpha, 'again');
  clock.now = NOW + MINUTE;
  await answer(call, cards.bravo, 'again');
  clock.now = NOW + 2 * MINUTE;
  await answer(call, cards.charlie, 'good');
  clock.now = NOW + 10 * MINUTE;
  await answer(call, cards.delta, 'good');
  clock.now = NOW + 10 * MINUTE + 90 * 1000;
  await answer(call, cards.echo, 'good');
  clock.now = NOW + 15 * MINUTE;
  const summary = (await call('GET', '/summary')).body;
  assert.equal(summary.minutes_today, 6);
  assert.equal(summary.done_today, 5);
  // alpha and bravo are due again (not new); 5 new words met today, 5 left, 9 new words due: 2 + min(5, 9).
  assert.deepEqual([summary.new_today, summary.new_left, summary.due], [5, 5, 7]);
  assert.equal((await queue(call, 'mode=review&limit=50')).length, summary.due, 'the same number as Review gives');

  assert.equal(studyMinutes([]), 0);
  assert.equal(studyMinutes([NOW]), 0, 'one answer: 15 s');
  assert.equal(studyMinutes([NOW, NOW + 45 * 1000]), 1, '15 + 45 s');
  assert.equal(studyMinutes([NOW, NOW + 60 * MINUTE]), 2, '15 + 120 + 15 s');
});

test('keeps slipping: missed 4 times or more is a leech, until the last two answers are right on different days', async t => {
  const { clock, service } = setup(t);
  const call = await serve(t, service);
  const { temporarily } = await addWords(call, clock, ['temporarily']);
  const answerLater = (...args) => { clock.now += 1000; return answer(...args); }; // a second between answers
  const slip = async () => (await queue(call, 'mode=spell&extra=practice')).find(card => card.en === 'temporarily');
  for (let index = 0; index < 3; index += 1) await answerLater(call, temporarily, 'again');
  assert.deepEqual([(await slip()).missed, (await slip()).leech], [3, false]);
  await answerLater(call, temporarily, 'hard', false); // a wrong answer graded hard is missed too
  assert.deepEqual([(await slip()).missed, (await slip()).leech], [4, true]);
  assert.equal((await queue(call, 'mode=mistakes'))[0].leech, true, 'the mistakes queue has it too');
  await answerLater(call, temporarily, 'good');
  await answerLater(call, temporarily, 'good');
  assert.equal((await slip()).leech, true, 'two right answers on the same day do not end it');
  clock.now = NOW + DAY;
  await answerLater(call, temporarily, 'good');
  const card = await slip();
  assert.deepEqual([card.missed, card.leech], [4, false], 'right yesterday and today: it ends');
  clock.now = NOW + 2 * DAY;
  await answerLater(call, temporarily, 'again');
  assert.equal((await slip()).leech, true, 'missed again: a leech again');
});

test('parts and a tip for a leech word come from the chat model once, checked; the rest in the background; a failing model blocks nothing', async t => {
  const asked = [];
  const answers = {
    temporarily: { parts: ['tem', 'po', 'rar', 'i', 'ly'], tip: 'temporary + -ly. Keep the ar of temporary.' },
    extension: { parts: ['ex', 'ten', 'tion'], tip: '-sion, not -tion: extend \u2192 extension' }, // parts that do not give the word: not kept
    necessary: { parts: ['Nec', 'es', 'sar', 'y'], tip: '\u4e00\u4e2a' }, // a tip that is not English: not kept
    'trade-off': { parts: ['trade', 'off'], tip: '' },
  };
  let failing = false;
  const chat = async (owner, system, user, options) => {
    const en = user.replace(/^Word: /, '');
    asked.push(en);
    assert.equal(options.json, true);
    assert.match(system, /never invent a rule/);
    if (failing) throw new Error('model down');
    return `\`\`\`json\n${JSON.stringify(answers[en] || {})}\n\`\`\``;
  };
  const { clock, db, service } = setup(t, { chat });
  const call = await serve(t, service);
  const cards = await addWords(call, clock, ['temporarily', 'extension', 'necessary', 'trade-off', 'simple']);
  for (const en of ['temporarily', 'extension', 'necessary', 'trade-off']) for (let index = 0; index < 4; index += 1) await answer(call, cards[en], 'again');
  clock.now += AGAIN_MS + 1000;
  const versionOf = norm => db.prepare('SELECT content_at, sync_seq FROM learn_cards WHERE norm = ?').get(norm);
  const before = versionOf('temporarily');

  const first = await queue(call, 'mode=spell');
  assert.deepEqual(first.map(card => card.en), ['temporarily', 'extension', 'necessary', 'trade-off', 'simple']);
  // The first two were asked before the answer; the others in the background.
  assert.deepEqual(first[0].parts, ['tem', 'po', 'rar', 'i', 'ly']);
  assert.equal(first[0].tip, 'temporary + -ly. Keep the ar of temporary.');
  assert.deepEqual([first[1].parts, first[1].tip], [null, '-sion, not -tion: extend \u2192 extension']);
  await service.settle();
  assert.deepEqual(asked, ['temporarily', 'extension', 'necessary', 'trade-off'], 'the word that is not a leech is never asked');
  const stored = Object.fromEntries(db.prepare("SELECT norm, parts, tip FROM learn_cards WHERE kind = 'word'").all().map(row => [row.norm, [row.parts, row.tip]]));
  assert.deepEqual(stored.temporarily, ['tem\u00b7po\u00b7rar\u00b7i\u00b7ly', 'temporary + -ly. Keep the ar of temporary.']);
  assert.deepEqual(stored.extension, ['', '-sion, not -tion: extend \u2192 extension']);
  assert.deepEqual(stored.necessary, ['Nec\u00b7es\u00b7sar\u00b7y', ''], 'parts compared without case');
  assert.deepEqual(stored['trade-off'], ['trade\u00b7off', ''], 'hyphens aside');
  assert.deepEqual(stored.simple, ['', '']);
  const again = await queue(call, 'mode=spell');
  assert.deepEqual(again[3].parts, ['trade', 'off']);
  assert.equal(asked.length, 4, 'asked once per word');
  // A filled-in part keeps the content clock (an empty one never wins in the merge) and has a new change number for the sync.
  assert.equal(versionOf('temporarily').content_at, before.content_at);
  assert.ok(versionOf('temporarily').sync_seq > before.sync_seq);
  // Another text: the parts and the tip are gone (they were those of the old word).
  await call('PATCH', `/cards/${cards.temporarily.id}`, { en: 'temporary' });
  assert.deepEqual(Object.values(db.prepare('SELECT parts, tip FROM learn_cards WHERE id = ?').get(cards.temporarily.id)), ['', '']);

  // The model fails: the queue answers as usual, without parts, and asks no more for a while.
  failing = true;
  const more = await addWords(call, clock, ['separate', 'definitely']);
  for (const en of ['separate', 'definitely']) for (let index = 0; index < 4; index += 1) await answer(call, more[en], 'again');
  clock.now += AGAIN_MS + 1000;
  const down = await queue(call, 'mode=spell');
  assert.equal(down.find(card => card.en === 'separate').parts, null);
  await service.settle();
  const tries = asked.length;
  await queue(call, 'mode=spell');
  await service.settle();
  assert.equal(asked.length, tries, 'paused after the failure');
  // A service without a chat model gives the leech fields without asking anything.
  const plain = setup(t);
  const plainCall = await serve(t, plain.service);
  const lone = await addWords(plainCall, plain.clock, ['separate']);
  for (let index = 0; index < 4; index += 1) await answer(plainCall, lone.separate, 'again');
  const card = (await queue(plainCall, 'mode=mistakes'))[0];
  assert.deepEqual([card.leech, card.missed, card.parts, card.tip], [true, 4, null, '']);
});

test('the checks of parts and tips, and the merge of the new words added for a day', () => {
  assert.equal(checkParts('temporarily', ['tem', 'po', 'rar', 'i', 'ly']), 'tem\u00b7po\u00b7rar\u00b7i\u00b7ly');
  assert.equal(checkParts('Temporarily', ['TEM', 'po', 'rar', 'i', 'ly']), 'TEM\u00b7po\u00b7rar\u00b7i\u00b7ly', 'case aside');
  assert.equal(checkParts('trade-off', ['trade', 'off']), 'trade\u00b7off', 'hyphens aside');
  assert.equal(checkParts('trade-off', ['trade-', 'off']), 'trade-\u00b7off');
  for (const parts of [['tem', 'po', 'ra', 'ri', 'ly', 'x'], ['tem', 'po', 'ry'], [], 'tem-po', null, ['tem', 5], ['tem po', 'rarily'], Array(13).fill('a')]) {
    assert.equal(checkParts('temporarily', parts), '', JSON.stringify(parts));
  }
  assert.equal(storedParts('temporarily', 'tem\u00b7po\u00b7rar\u00b7i\u00b7ly'), 'tem\u00b7po\u00b7rar\u00b7i\u00b7ly');
  assert.equal(storedParts('temporary', 'tem\u00b7po\u00b7rar\u00b7i\u00b7ly'), '', 'parts of another word');
  assert.equal(checkTip('  Keep the\n ar.  '), 'Keep the ar.');
  assert.equal(checkTip('x'.repeat(201)), '');
  assert.equal(checkTip('\u4e2d\u6587'), '');
  assert.equal(checkTip(5), '');
  assert.deepEqual(parseSpelling('bug', 'Sure: {"parts": ["bug"], "tip": "One syllable."} done'), { parts: 'bug', tip: 'One syllable.' });
  assert.deepEqual(parseSpelling('bug', 'no json'), { parts: '', tip: '' });

  assert.deepEqual(cleanExtraNew({ day: '2026-11-19', count: 5 }), { day: '2026-11-19', count: 5 });
  for (const value of [null, {}, { day: 'today', count: 5 }, { day: '2026-11-19', count: 0 }, { day: '2026-11-19', count: 1.5 }]) assert.deepEqual(cleanExtraNew(value), { day: '', count: 0 });
  assert.deepEqual(mergeExtraNew({ day: '2026-11-19', count: 5 }, { day: '2026-11-19', count: 10 }), { day: '2026-11-19', count: 10 }, 'the same day: the larger');
  assert.deepEqual(mergeExtraNew({ day: '2026-11-20', count: 5 }, { day: '2026-11-19', count: 10 }), { day: '2026-11-20', count: 5 }, 'the later day');
  assert.deepEqual(mergeExtraNew(undefined, { day: '2026-11-19', count: 10 }), { day: '2026-11-19', count: 10 });
  assert.deepEqual(mergeExtraNew({ day: '2026-11-19', count: 10 }, 'bad'), { day: '2026-11-19', count: 10 });
});

test('a hard answer that was wrong (one letter off) is accepted, scheduled as hard by FSRS, not a lapse, and stays a mistake', async t => {
  const { clock, db, service } = setup(t);
  const call = await serve(t, service);
  const { alpha, bravo } = await addWords(call, clock, ['alpha', 'bravo']);
  const hard = await call('POST', `/cards/${alpha.id}/answer`, { mode: 'spell', grade: 'hard', correct: false, answer: 'alpah', tag: 'letter-order' });
  assert.equal(hard.status, 200);
  assert.equal(hard.body.card.lapses, 0, 'not a lapse: lapses count again only');
  assert.equal(hard.body.card.last_result, 'hard');
  assert.ok(hard.body.card.interval_days >= 1, 'scheduled by FSRS as hard: whole days, not the 10 minutes of again');
  assert.equal(Date.parse(hard.body.card.due_at), clock.now + hard.body.card.interval_days * DAY);
  const again = (await call('POST', `/cards/${bravo.id}/answer`, { mode: 'spell', grade: 'again', correct: false })).body.card;
  assert.deepEqual([again.lapses, Date.parse(again.due_at) - clock.now], [1, AGAIN_MS]);
  // The same as a hard answer graded right, apart from last_correct; the replay of its answers gives the same state.
  const row = db.prepare('SELECT * FROM learn_cards WHERE id = ?').get(alpha.id);
  assert.equal(row.last_correct, 0);
  const replayed = schedule.replayed(db, row);
  assert.deepEqual([replayed.due_at, replayed.lapses, replayed.last_correct], [row.due_at, 0, 0]);
  assert.ok((await queue(call, 'mode=mistakes')).some(card => card.id === alpha.id), 'it stays in Mistakes');
  assert.equal((await call('GET', '/mistakes')).body.mistakes.find(item => item.card.id === alpha.id).tag, 'letter-order');
});

test('schema 23: an older database gets the parts and tip columns, its cards kept as they were; a second run changes nothing', t => {
  const db = database(t);
  db.exec('ALTER TABLE learn_cards DROP COLUMN parts; ALTER TABLE learn_cards DROP COLUMN tip');
  db.prepare(`INSERT INTO learn_cards (owner, kind, en, norm, zh, phonetic, source, created_at, due_at, content_at, state_at, sync_seq)
    VALUES ('me', 'word', 'merge', 'merge', 'z', '/m/', 'manual', 1, 2, 3, 4, 5)`).run();
  syncStore.ensureSyncSchema(db);
  const columns = db.prepare('PRAGMA table_info(learn_cards)').all().map(column => column.name);
  assert.ok(columns.includes('parts') && columns.includes('tip'));
  const card = db.prepare('SELECT * FROM learn_cards').get();
  assert.deepEqual([card.en, card.zh, card.phonetic, card.parts, card.tip, card.content_at, card.state_at, card.sync_seq], ['merge', 'z', '/m/', '', '', 3, 4, 5]);
  syncStore.ensureSyncSchema(db);
  assert.equal(db.prepare('PRAGMA table_info(learn_cards)').all().filter(column => column.name === 'parts').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'VERSION.json'), 'utf8')).schema_version, 23);
});
