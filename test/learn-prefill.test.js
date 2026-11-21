// Learn: the meanings and transcriptions of word cards translated ahead of time ("Meanings are translated ahead of time" in
// docs/design/learn-english.md; services/learn.js prefill(), services/learn-prefill.js): every empty meaning and transcription filled and stored with
// the content clock kept, cards that have a meaning left alone, the stop at the first failure, a word whose answer could not be read, nothing on a
// company computer, the run a moment after new words (one for several), the cap of a run, the election between linked engines and the timers.
// No test calls a real model: every translator here is a stub, and the timers are fakes the test fires.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-prefill-data-'));
delete process.env.TAGENT_HOME;
const Database = require('better-sqlite3');
const { createLearn } = require('../services/learn');
const { createLearnPrefill } = require('../services/learn-prefill');
const { STARTER_LISTS } = require('../services/learn-starter');

const NOW = Date.UTC(2026, 10, 21, 4, 0, 0);
const TZ = 'UTC';
const ZH = '\u542b\u4e49'; // a Chinese meaning (user content), written with escapes
// The bundled dictionary of these tests: it knows two words.
const DICTIONARY = { deploy: '/d\u026a\u02c8pl\u0254\u026a/', merge: '/m\u025c\u02d0d\u0292/' };
const lookupPhonetic = word => DICTIONARY[word.toLowerCase()] || '';
// The translator's transcription of a word the dictionary does not know.
const translated = word => `/${word}/`;

function database(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-prefill-'));
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = OFF'); // a throwaway database: no waiting for the disk on each of the many small writes
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

// A translator stub that answers "<ZH>:<word>" with a transcription (none for the words in `bare`), records every word asked, and fails while told.
function setup(t, { cacheOnly = false, onNewWords = () => {}, bare = [] } = {}) {
  const db = database(t);
  const calls = [];
  const state = { failure: null, unreadable: new Set() };
  const lookupWord = async (owner, word) => {
    calls.push(word);
    if (state.failure) throw state.failure;
    if (state.unreadable.has(word)) return { word, meaning: '' };
    return { word, meaning: `${ZH}:${word}`, phonetic: bare.includes(word) ? '' : translated(word) };
  };
  const learn = createLearn({ db, now: () => NOW, timeZone: TZ, lookupWord, lookupPhonetic, cacheOnly: () => cacheOnly, onNewWords });
  learn.saveSettings('me', { starter: null });
  return { db, learn, calls, state };
}
const word = en => ({ kind: 'word', en, source: 'manual' });
// Distinct valid words: w + the index in letters.
const nameOf = index => `w${index.toString(26).replace(/[0-9]/g, digit => 'qrstuvwxyz'[digit])}`;
const rowOf = (db, en) => db.prepare("SELECT * FROM learn_cards WHERE owner = 'me' AND kind = 'word' AND en = ?").get(en);

// Timers the test fires: every timeout and interval is kept with its delay.
function fakeTimers() {
  let next = 1;
  const pending = new Map();
  const add = (fn, ms, every) => { const handle = { id: next++, fn, ms, every, unrefed: false, unref() { this.unrefed = true; } }; pending.set(handle.id, handle); return handle; };
  const drop = handle => { if (handle) pending.delete(handle.id); };
  return {
    pending,
    setTimeout: (fn, ms) => add(fn, ms, false), clearTimeout: drop, setInterval: (fn, ms) => add(fn, ms, true), clearInterval: drop,
    timeouts: () => [...pending.values()].filter(handle => !handle.every),
    // Fires the timeouts due now (and removes them).
    fire() { for (const handle of this.timeouts()) { pending.delete(handle.id); handle.fn(); } },
  };
}
const quietLog = () => { const lines = []; return { lines, warn: line => lines.push(['warn', line]), info: line => lines.push(['info', line]) }; };

function scheduler(learn, options = {}) {
  const timers = fakeTimers();
  const log = quietLog();
  const prefill = createLearnPrefill({ learn, isConfigured: () => options.configured !== false, owner: () => 'me', log, timers, random: () => 0, ...options });
  return { prefill, timers, log };
}

test('prefill fills every empty meaning and transcription and stores them, keeping the content clock', async t => {
  const { db, learn, calls } = setup(t, { bare: ['quorum'] });
  for (const en of ['deploy', 'idempotent', 'quorum', 'latency']) learn.addCard('me', word(en));
  const before = Object.fromEntries(['deploy', 'idempotent', 'quorum', 'latency'].map(en => [en, rowOf(db, en)]));
  assert.equal(learn.missingMeanings('me'), 4);
  const result = await learn.prefill('me');
  assert.deepEqual({ ...result, error: undefined }, { tried: 4, filled: 4, left: 0, failed: false, error: undefined });
  assert.equal(learn.missingMeanings('me'), 0);
  for (const en of ['deploy', 'idempotent', 'quorum', 'latency']) {
    const row = rowOf(db, en);
    assert.equal(row.zh, `${ZH}:${en}`, `${en} has its meaning`);
    assert.equal(row.content_at, before[en].content_at, 'a filled meaning keeps the content clock (an empty one never wins in the merge)');
    assert.ok(row.sync_seq > before[en].sync_seq, 'the change goes to the linked engines');
  }
  assert.equal(rowOf(db, 'deploy').phonetic, DICTIONARY.deploy, 'the dictionary first');
  assert.equal(rowOf(db, 'idempotent').phonetic, translated('idempotent'), 'else the transcription of the meaning answer');
  assert.equal(rowOf(db, 'quorum').phonetic, '', 'a word nobody knows keeps none');
  // One question per word: the meaning answer counts as the transcription question too.
  assert.deepEqual([...calls].sort(), ['deploy', 'idempotent', 'latency', 'quorum']);
  // Nothing is left to do: another run asks nothing.
  assert.equal((await learn.prefill('me')).tried, 0);
  assert.equal(calls.length, 4);
});

test('prefill leaves cards that have a meaning alone and only asks for a missing transcription', async t => {
  const { db, learn, calls } = setup(t);
  learn.addCard('me', { ...word('merge'), zh: 'mine' });
  learn.addCard('me', { ...word('rollback'), zh: 'kept' });
  learn.addCard('me', word('throughput'));
  const result = await learn.prefill('me');
  assert.equal(result.failed, false);
  assert.equal(rowOf(db, 'merge').zh, 'mine');
  assert.equal(rowOf(db, 'rollback').zh, 'kept', 'a meaning there is never replaced');
  assert.equal(rowOf(db, 'rollback').phonetic, translated('rollback'), 'its transcription is asked of the translator');
  assert.equal(rowOf(db, 'throughput').zh, `${ZH}:throughput`);
  assert.deepEqual([...calls].sort(), ['rollback', 'throughput'], 'merge has both (the dictionary): not asked');
  // The transcription was asked once while the server runs: a later run does not ask again.
  await learn.prefill('me');
  assert.equal(calls.length, 2);
});

test('prefill takes the cards in practice order, at most max, and the hidden ones last', async t => {
  const { db, learn } = setup(t);
  for (const en of ['alpha', 'bravo', 'charlie', 'delta']) learn.addCard('me', word(en));
  db.prepare("UPDATE learn_cards SET suspended = 1 WHERE en = 'alpha'").run();
  db.prepare("UPDATE learn_cards SET due_at = ? WHERE en = 'delta'").run(NOW - 1000);
  db.prepare("UPDATE learn_cards SET due_at = ? WHERE en IN ('bravo', 'charlie')").run(NOW + 1000);
  db.prepare("UPDATE learn_cards SET last_at = ? WHERE en = 'bravo'").run(NOW - 5000);
  const result = await learn.prefill('me', { max: 2 });
  assert.equal(result.tried, 2);
  assert.equal(result.left, 2);
  assert.ok(rowOf(db, 'delta').zh, 'the due card first');
  assert.ok(rowOf(db, 'charlie').zh, 'then the one never practised');
  assert.equal(rowOf(db, 'bravo').zh, '');
  assert.equal(rowOf(db, 'alpha').zh, '', 'the suspended card last');
});

test('prefill stops at the first failure of the translator and reports what is left; the next call goes on', async t => {
  const { db, learn, calls, state } = setup(t);
  for (let index = 0; index < 12; index += 1) learn.addCard('me', word(nameOf(index)));
  state.failure = Object.assign(new Error('The translator is away'), { statusCode: 502 });
  const result = await learn.prefill('me');
  assert.equal(result.failed, true);
  assert.equal(result.error.message, 'The translator is away');
  assert.equal(result.filled, 0);
  assert.equal(result.left, 12);
  assert.ok(calls.length <= 4, `no more asks after the failure (asked ${calls.length})`);
  assert.equal(db.prepare("SELECT COUNT(*) FROM learn_cards WHERE zh = ''").pluck().get(), 12);
  state.failure = null;
  const again = await learn.prefill('me');
  assert.deepEqual([again.failed, again.filled, again.left], [false, 12, 0]);
});

test('a word whose answer could not be read is left to the queue; the others go on', async t => {
  const { db, learn, state } = setup(t);
  for (const en of ['alpha', 'bravo', 'charlie']) learn.addCard('me', word(en));
  state.unreadable.add('bravo');
  const result = await learn.prefill('me');
  assert.equal(result.failed, false);
  assert.equal(result.left, 0, 'not taken again while the server runs');
  assert.equal(rowOf(db, 'bravo').zh, '');
  assert.ok(rowOf(db, 'alpha').zh && rowOf(db, 'charlie').zh);
  assert.equal(result.error, null);
});

test('nothing on a company computer: prefill does nothing and the scheduler does not run', async t => {
  const { learn, calls } = setup(t, { cacheOnly: true });
  learn.addCard('me', word('latency'));
  assert.deepEqual({ ...(await learn.prefill('me')), error: undefined }, { tried: 0, filled: 0, left: 0, failed: false, error: undefined });
  const { prefill, timers } = scheduler(learn, { company: () => true });
  assert.equal(await prefill.check(), 'company');
  prefill.afterNewWords('me');
  assert.equal(timers.timeouts().length, 0, 'no run after new words either');
  assert.equal(calls.length, 0);
});

test('no translator set up: the scheduler waits', async t => {
  const { learn, calls } = setup(t);
  learn.addCard('me', word('latency'));
  const { prefill } = scheduler(learn, { configured: false });
  assert.equal(await prefill.check(), 'no-model');
  assert.equal(calls.length, 0);
});

test('a starter list and new words make one run a moment later, which translates all of them', async t => {
  let notify = () => {};
  const { db, learn, calls } = setup(t, { onNewWords: name => notify(name) });
  const { prefill, timers } = scheduler(learn, { maxPerRun: 1000 });
  notify = name => prefill.afterNewWords(name);
  const { added } = learn.starter('me', { list: 'dev' });
  assert.equal(added, STARTER_LISTS.dev.words.length);
  learn.addCard('me', word('quorum'));
  learn.addCard('me', { ...word('merge'), zh: 'has one' }); // a word with a meaning and a transcription: no reason for a run
  learn.addCard('me', { kind: 'sentence', en: 'We deploy the service today.', source: 'manual' });
  assert.equal(timers.timeouts().length, 1, 'several new words make one run');
  assert.equal(timers.timeouts()[0].ms, 5000);
  assert.equal(timers.timeouts()[0].unrefed, true);
  assert.equal(calls.length, 0, 'nothing is asked before the timer');
  timers.fire();
  await prefill.settle();
  assert.equal(db.prepare("SELECT COUNT(*) FROM learn_cards WHERE kind = 'word' AND zh = ''").pluck().get(), 0, 'every word has its meaning');
  assert.equal(calls.filter(en => en === 'quorum').length, 1);
  assert.equal(new Set(calls).size, calls.length, 'each word is asked once');
});

test('one run stops at its cap; the next run goes on from there', async t => {
  const { db, learn, calls } = setup(t);
  for (let index = 0; index < 60; index += 1) learn.addCard('me', word(nameOf(index)));
  const { prefill, log } = scheduler(learn, { batch: 10, maxPerRun: 25 });
  assert.equal(await prefill.run('me'), 'capped');
  assert.equal(calls.length, 25);
  assert.equal(db.prepare("SELECT COUNT(*) FROM learn_cards WHERE zh = ''").pluck().get(), 35);
  assert.ok(log.lines.some(([, line]) => line.includes('35 word cards still without a meaning')), 'a count in the log, no content');
  assert.equal(await prefill.run('me'), 'capped');
  assert.equal(await prefill.run('me'), 'done');
  assert.equal(db.prepare("SELECT COUNT(*) FROM learn_cards WHERE zh = ''").pluck().get(), 0);
  assert.equal(calls.length, 60);
});

test('a failure ends the run and is logged once per reason, without content; working again is logged once', async t => {
  const { learn, state } = setup(t);
  for (let index = 0; index < 5; index += 1) learn.addCard('me', word(nameOf(index)));
  state.failure = Object.assign(new Error('The translator is away'), { statusCode: 502 });
  const { prefill, log } = scheduler(learn);
  assert.equal(await prefill.run('me'), 'failed');
  assert.equal(await prefill.run('me'), 'failed');
  assert.deepEqual(log.lines, [['warn', '[learn-prefill] translating word cards ahead of time failed: The translator is away']]);
  state.failure = null;
  assert.equal(await prefill.run('me'), 'done');
  assert.deepEqual(log.lines.slice(1), [['info', '[learn-prefill] translating word cards ahead of time works again']]);
  assert.ok(!log.lines.some(([, line]) => line.includes(nameOf(0))));
});

test('with linked engines only the elected engine translates (the picking rule); with no peers this one does', async t => {
  const { learn, calls } = setup(t);
  learn.addCard('me', word('latency'));
  const peers = { list: [{ instance_id: 'a-engine' }] };
  const sync = { me: () => 'b-engine', pickPeers: () => peers.list, company: () => false };
  const { prefill } = scheduler(learn, { sync });
  assert.equal(await prefill.check(), 'other-engine', 'an engine with a smaller instance id translates');
  assert.equal(calls.length, 0);
  peers.list = [{ instance_id: 'c-engine' }];
  assert.equal(await prefill.check(), 'done');
  learn.addCard('me', word('quorum'));
  peers.list = [];
  assert.equal(await prefill.check(), 'done', 'no online peer that picks: this engine');
  assert.deepEqual(calls, ['latency', 'quorum']);
});

test('start: a first check a few minutes later (with jitter), then every hour; stop clears them', async t => {
  const { learn, calls } = setup(t);
  learn.addCard('me', word('latency'));
  const { prefill, timers } = scheduler(learn, { random: () => 0.5 });
  assert.equal(prefill.started(), false);
  prefill.start();
  assert.equal(prefill.started(), true);
  const handles = [...timers.pending.values()];
  assert.deepEqual(handles.map(handle => [handle.every, handle.ms, handle.unrefed]), [[false, 3 * 60 * 1000 + 30_000, true], [true, 60 * 60 * 1000, true]]);
  timers.fire();
  await prefill.settle();
  assert.deepEqual(calls, ['latency']);
  prefill.afterNewWords('me');
  prefill.stop();
  assert.equal(timers.pending.size, 0);
  assert.equal(prefill.started(), false);
});

test('the shared notifier does nothing until the server started the translation ahead of time', t => {
  const shared = require('../services/learn-prefill');
  assert.doesNotThrow(() => shared.afterNewWords('me'));
  t.after(() => shared.stopShared());
});
