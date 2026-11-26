// Learn: the practice plans of the English coach ("Practice plans" in docs/design/learn-english-coach.md; services/learn-plan.js) from a seeded
// database: today's spelling from the real spell queue with the wrong words first, the mistakes series (its steps, the order by how often a word
// was wrong, the worst words again, the retest), more new words (the allowance raised only at Start), plans narrowed to named words, an empty plan,
// and a started plan with the cards as GET /queue gives them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-plan-data-'));
delete process.env.TAGENT_HOME;
const Database = require('better-sqlite3');
const { createLearn } = require('../services/learn');
const { createLearnPlan } = require('../services/learn-plan');

const NOW = Date.UTC(2026, 10, 24, 4, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const ZH = '\u5206\u5f00';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-plan-'));
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const clock = { now: NOW - 10 * DAY };
  const learn = createLearn({ db, now: () => clock.now, timeZone: 'UTC', lookupWord: null, lookupPhonetic: () => '' });
  learn.saveSettings('me', { starter: null });
  return { db, clock, learn, plan: createLearnPlan({ db, learn, now: () => clock.now }) };
}
const add = (ctx, kind, en) => ctx.learn.addCard('me', { kind, en, zh: ZH }).card;
const wrong = (ctx, card, times) => { for (let index = 0; index < times; index += 1) { ctx.clock.now += 60_000; ctx.learn.answer('me', card.id, { mode: 'spell', grade: 'again', correct: false, answer: 'x' }); } };

test('word selection ranks by error rate and fills the new-word selection within the allowance', t => {
  const ctx = setup(t);
  const rare = add(ctx, 'word', 'receive');
  const frequent = add(ctx, 'word', 'deploy');
  const perfect = add(ctx, 'word', 'archive');
  const fresh = add(ctx, 'word', 'merge');
  add(ctx, 'sentence', 'We should merge the branch.');
  wrong(ctx, frequent, 2);
  wrong(ctx, rare, 1);
  for (const card of [frequent, frequent, perfect]) ctx.learn.answer('me', card.id, { mode: 'spell', grade: 'good', correct: true });
  ctx.clock.now = NOW;
  const select = (source, count) => ctx.plan.selectWords('me', { source, count }).map(row => row.id);
  assert.deepEqual(select('highest_error_rate'), [rare.id, frequent.id]);
  assert.deepEqual(select('new'), [fresh.id]);
  assert.deepEqual(select('highest_error_rate', 1), [rare.id]);
  assert.deepEqual(new Set(select('reviewed')), new Set([rare.id, frequent.id, perfect.id]));
  const newToday = Array.from({ length: 6 }, (_, index) => add(ctx, 'word', `word${String.fromCharCode(97 + index)}`));
  ctx.learn.saveSettings('me', { new_per_day: 5 });
  assert.deepEqual(select('new', 20), [fresh, ...newToday.slice(0, 4)].map(card => card.id));
  ctx.learn.updateCard('me', rare.id, { suspended: true });
  assert.deepEqual(select('highest_error_rate'), [frequent.id]);
});

test('an empty database: every plan is empty (no steps, no words), so no Start button is offered', async t => {
  const ctx = setup(t);
  for (const kind of ['today_spelling', 'review', 'mistakes_series', 'more_new_words', 'dictation', 'fill_gap']) {
    const plan = await ctx.plan.buildPlan('me', kind);
    assert.deepEqual([plan.kind, plan.steps, plan.words, plan.minutes], [kind, [], 0, 0], kind);
  }
  await assert.rejects(ctx.plan.buildPlan('me', 'build'), { message: 'Unknown practice plan' });
});

test('today\'s spelling: the spell queue (due words, then today\'s new ones), the words now in Mistakes first; the numbers are the queue\'s', async t => {
  const ctx = setup(t);
  const words = ['necessary', 'receive', 'separate', 'definitely'].map(en => add(ctx, 'word', en));
  add(ctx, 'sentence', 'Please merge the branch.');
  wrong(ctx, words[2], 1); // separate: in Mistakes now
  ctx.clock.now = NOW;
  const plan = await ctx.plan.buildPlan('me', 'today_spelling');
  const queue = (await ctx.learn.queue('me', 'spell', 50)).cards.map(card => card.id);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].mode, 'spell');
  assert.deepEqual([...plan.steps[0].card_ids].sort(), [...queue].sort(), 'the same cards as the spell queue');
  assert.equal(plan.steps[0].card_ids[0], words[2].id, 'the wrong word first');
  assert.deepEqual([plan.words, plan.wrong_first, plan.title], [queue.length, 1, "Today's spelling"]);
  assert.ok(plan.minutes >= 1);
  // New words a day: with 2 a day the plan follows the queue.
  ctx.learn.saveSettings('me', { new_per_day: 5 });
  const fewer = await ctx.plan.buildPlan('me', 'today_spelling', { count: 2 });
  assert.equal(fewer.words, 2);
});

test('the mistakes series is word spelling only: spell (most often wrong first), then the retest; sentences are not offered', async t => {
  const ctx = setup(t);
  const occurred = add(ctx, 'word', 'occurred');
  const separate = add(ctx, 'word', 'separate');
  const receive = add(ctx, 'word', 'receive');
  const sentence = add(ctx, 'sentence', 'Keep the two lists separate.');
  add(ctx, 'sentence', 'This one has no wrong word.');
  wrong(ctx, separate, 2);
  wrong(ctx, receive, 1);
  wrong(ctx, occurred, 3);
  ctx.clock.now = NOW;
  const plan = await ctx.plan.buildPlan('me', 'mistakes_series');
  assert.deepEqual(plan.steps.map(step => step.mode), ['spell', 'retest']);
  assert.deepEqual(plan.steps[0].card_ids, [occurred.id, separate.id, receive.id], 'the most often wrong first');
  assert.deepEqual(plan.steps[1].card_ids, plan.steps[0].card_ids, 'the retest has every word (the page keeps the ones missed again)');
  assert.deepEqual([plan.words, plan.title], [3, 'Your mistakes']);
  assert.equal(sentence.kind, 'sentence');
  // Named words: only those ("Practise the 2 I missed").
  const named = await ctx.plan.buildPlan('me', 'mistakes_series', { words: ['receive', separate.id] });
  assert.deepEqual(named.steps[0].card_ids, [separate.id, receive.id]);
  const spellNamed = await ctx.plan.buildPlan('me', 'today_spelling', { words: ['receive', 'unknownword'] });
  assert.deepEqual(spellNamed.steps, [{ mode: 'spell', card_ids: [receive.id] }]);
});

test('more new words: the next new words, the allowance raised only when the plan is started; a started plan has the queue\'s cards', async t => {
  const ctx = setup(t);
  ctx.learn.saveSettings('me', { new_per_day: 5 });
  const words = Array.from({ length: 12 }, (_, index) => add(ctx, 'word', `word${String.fromCharCode(97 + index)}`));
  ctx.clock.now = NOW;
  // Today's five are used up.
  for (const card of words.slice(0, 5)) ctx.learn.answer('me', card.id, { mode: 'spell', grade: 'good', correct: true });
  assert.equal(ctx.learn.pace('me').new_left, 0);
  const plan = await ctx.plan.buildPlan('me', 'more_new_words');
  assert.deepEqual([plan.words, plan.count], [5, 5]);
  assert.equal(ctx.learn.pace('me').new_left, 0, 'nothing raised by a proposal');
  const started = await ctx.plan.startPlan('me', plan, { id: 'plan-00001', raise: true });
  assert.equal(ctx.learn.pace('me').new_left, 5, 'raised by the Start');
  assert.equal(started.plan.steps[0].cards.length, 5);
  assert.ok(started.plan.steps[0].cards.every(card => card.is_new && card.next && card.zh === ZH));
  assert.equal(started.stale, false);
  // Started again later (an old button): read again, not raised again.
  await ctx.plan.startPlan('me', plan, { id: 'plan-00002', raise: false });
  assert.equal(ctx.learn.settings('me').extra_new.count, 5);
  for (const card of started.plan.steps[0].cards) ctx.learn.answer('me', card.id, { mode: 'spell', grade: 'good', correct: true });
  assert.deepEqual(await ctx.plan.startPlan('me', plan, { id: 'plan-00004', raise: false }), { empty: true });
  // A plan whose cards are gone: empty.
  const spell = await ctx.plan.buildPlan('me', 'today_spelling', { words: [words[6].id] });
  ctx.learn.updateCard('me', words[6].id, { suspended: true });
  assert.deepEqual(await ctx.plan.startPlan('me', { ...spell, words_list: [words[6].en] }, { id: 'plan-00003' }), { empty: true });
});

test('review is word spelling; dictation and fill the gap (plans saved before) still follow their queues', async t => {
  const ctx = setup(t);
  const one = add(ctx, 'sentence', 'Please merge the branch.');
  const two = add(ctx, 'sentence', 'The build is green.');
  const word = ctx.learn.addCard('me', { kind: 'word', en: 'deploy', zh: ZH, context: 'We can deploy the new build.' }).card;
  ctx.clock.now = NOW;
  const dictation = await ctx.plan.buildPlan('me', 'dictation');
  assert.deepEqual(dictation.steps, [{ mode: 'dictation', card_ids: (await ctx.learn.queue('me', 'dictation', 10)).cards.map(card => card.id) }]);
  assert.deepEqual(dictation.steps[0].card_ids, [word.id]);
  const fill = await ctx.plan.buildPlan('me', 'fill_gap', { count: 1 });
  assert.deepEqual(fill.steps[0].card_ids, [word.id]);
  const review = await ctx.plan.buildPlan('me', 'review');
  // Review spells the due WORDS only (no sentence card in it).
  assert.ok(review.steps.every(step => step.mode === 'spell'));
  const wordsOnly = new Set(review.steps.flatMap(step => step.card_ids));
  assert.ok(![...wordsOnly].some(id => [one.id, two.id].includes(id)), 'no sentence cards in a review');
});
