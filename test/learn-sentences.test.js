// Learn: a sentence for every word ("A sentence for every word" in docs/design/learn-english.md; services/learn-sentences.js, services/learn-pick.js,
// services/learn.js, services/learn-merge.js, services/learn-sync.js): which words share a sentence and who keeps it, the check of a generated
// sentence, the day's budget, the pick with a stubbed `converse` (the first keeps the person's sentence, the others get their own, a bad answer asked
// again once, then none), no translator, a company computer, a failure of the model, the cards that already share one (10 a day, newest first), a
// new pick that never swaps a sentence back, an edited word, and the sync (the same sentence on every engine, an older peer never undoes it). No
// test calls a real model: every `chat` and `converse` here is a stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-sentences-data-'));
delete process.env.TAGENT_HOME;
const Database = require('better-sqlite3');
const { createLearn } = require('../services/learn');
const merge = require('../services/learn-merge');
const { createLearnSync } = require('../services/learn-sync');
const { createLearnPick } = require('../services/learn-pick');
const { readState } = require('../services/settings-sync-store');
const {
  sharedGroups, needingSentence, checkGenerated, buildSentencePrompt, budgetLeft, wholeWordPlaces, dayStateKey, PER_DAY,
} = require('../services/learn-sentences');

const NOW = Date.UTC(2026, 10, 24, 4, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const TZ = 'UTC';
// Chinese meanings and sentences (user content), written with escapes.
const ZH_SENTENCE = '\u8bf7\u4fee\u590d\u767b\u5f55\u9875\u9762';
const ZH_GENERATED = '\u8fd9\u662f\u4e00\u4e2a\u4f8b\u53e5';
const ZH_WORD = '\u90e8\u7f72';
const S1 = 'We need a resilient deploy step before the release.';

function database(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-sentences-'));
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

// A good example sentence for a word (8 words, the word once).
const good = word => JSON.stringify({ sentence: `Our team will ${word} the new plan next week.`, zh: ZH_GENERATED });

// `answers(word, attempt)`: the raw answer of the sentence model (a string), or throws.
function setup(t, { answers = word => good(word), picks = {}, configured = true } = {}) {
  const db = database(t);
  const clock = { now: NOW };
  const learn = createLearn({ db, now: () => clock.now, timeZone: TZ, lookupWord: null, lookupPhonetic: () => '' });
  learn.saveSettings('me', { starter: null });
  learn.saveLevel('me', { level: 'B1', label: 'intermediate', reason: 'Fine.', answers: 10, mistakes: 2, report_at: null, updated_at: NOW });
  const calls = [];
  const converse = async (owner, system, messages, options) => {
    const message = JSON.parse(messages[0].content);
    const attempt = messages.filter(item => item.role === 'user').length;
    calls.push({ owner, system, messages, message, attempt, options });
    return answers(message.word, attempt);
  };
  const chat = async (owner, system, user) => {
    const message = JSON.parse(user);
    return JSON.stringify({ sentences: message.sentences.map(item => ({ id: item.id, words: picks[item.text] || [] })) });
  };
  const state = { configured, company: false };
  const logs = [];
  const pick = createLearnPick({
    db, learn, chat, converse, isConfigured: () => state.configured, company: () => state.company, owner: () => 'me', now: () => clock.now,
    log: { warn: message => logs.push(message), info() {} }, afterSentenceMs: 1, lookupPhonetic: () => '', onNewWords: () => {},
  });
  t.after(() => pick.stop());
  return { db, clock, learn, pick, calls, state, logs };
}
const sentence = (ctx, en, zh = ZH_SENTENCE) => ctx.learn.addCard('me', { kind: 'sentence', en, zh, source: 'translation', context: 'Fix login' }).card;
const card = (ctx, en) => ctx.db.prepare("SELECT * FROM learn_cards WHERE owner = 'me' AND kind = 'word' AND norm = ?").get(en.toLowerCase());
// A word card asked inside `context`, as an older version stored it (several words of one sentence share it).
function wordIn(ctx, en, context, createdAt) {
  ctx.db.prepare(`INSERT INTO learn_cards (owner, kind, en, norm, zh, source, context, created_at, due_at, content_at, sync_seq)
    VALUES ('me', 'word', ?, ?, ?, 'translation', ?, ?, ?, ?, ?)`).run(en, en.toLowerCase(), ZH_WORD, context, createdAt, createdAt, createdAt, createdAt);
  return card(ctx, en);
}

test('which words share a sentence: the card made first keeps it, then the word that stands first, then the smaller word; the others newest first', () => {
  const cards = [
    { id: 1, en: 'release', context: S1, created_at: 5 },
    { id: 2, en: 'deploy', context: S1, created_at: 5 },
    { id: 3, en: 'resilient', context: S1, created_at: 5 },
    { id: 4, en: 'alone', context: 'A sentence with only one picked word in it.', created_at: 1 },
    { id: 5, en: 'branch', context: '', created_at: 1 },
  ];
  const groups = sharedGroups(cards);
  assert.equal(groups.length, 1, 'a sentence of one word and an empty context are no group');
  assert.equal(groups[0].keeper.en, 'resilient', 'the same time: the word that stands first in the sentence');
  assert.deepEqual(groups[0].others.map(item => item.en), ['deploy', 'release'], 'newest first: the same time, the larger id first');
  // A card made earlier keeps it, wherever its word stands.
  assert.equal(sharedGroups([...cards.slice(0, 3), { id: 9, en: 'step', context: S1, created_at: 1 }])[0].keeper.en, 'step');
  // Ids differ between engines: the keeper does not depend on them.
  assert.equal(sharedGroups(cards.map(item => ({ ...item, id: 100 - item.id })))[0].keeper.en, 'resilient');
  const needed = needingSentence(cards);
  assert.deepEqual(needed.map(item => item.card.en), ['deploy', 'release']);
  assert.deepEqual(needed[0].avoid.sort(), ['release', 'resilient'], 'none of the other words of the sentence');
});

test('the check of a generated sentence: the word once in the same form, 6 to 16 words, none of the other words, a Chinese translation, the card rules', () => {
  const ok = checkGenerated(good('deploy'), { word: 'deploy', avoid: ['release'] });
  assert.deepEqual(ok, { ok: true, en: 'Our team will deploy the new plan next week.', zh: ZH_GENERATED });
  assert.equal(checkGenerated(`Sure: ${good('deploy')} Hope it helps.`, { word: 'deploy' }).ok, true, 'text around the object');
  const reason = (sentenceText, options = {}, zh = ZH_GENERATED) => checkGenerated(JSON.stringify({ sentence: sentenceText, zh }), { word: 'deploy', ...options }).reason;
  assert.match(reason('We deploy on Monday and deploy again on Friday.'), /exactly once/);
  assert.match(reason('We deployed the new service on a Friday.'), /exactly once/, 'another form of the word');
  assert.match(reason('Deploy-ready builds wait for the release on Friday.'), /exactly once/, 'a part of a longer word');
  assert.equal(checkGenerated(JSON.stringify({ sentence: 'Deploy the new build to the test servers today.', zh: ZH_GENERATED }), { word: 'deploy' }).ok, true, 'any case');
  assert.match(reason('We deploy too.'), /6 to 16 words/);
  assert.match(reason(`We deploy ${'very '.repeat(14)}carefully.`), /6 to 16 words/);
  assert.match(reason('We deploy the release on Friday after lunch.', { avoid: ['release'] }), /must not use "release"/);
  assert.match(reason('We deploy the new service on a Friday.', {}, 'only English'), /Chinese/);
  assert.match(reason('We deploy the new service on a Friday.', { original: 'We deploy the new service on a Friday.' }), /new one/);
  assert.match(reason('Run deploy && rm -rf build on the server now.'), /code or a command/);
  assert.match(checkGenerated('no json here', { word: 'deploy' }).reason, /JSON/);
  assert.match(checkGenerated('{"sentence": 3}', { word: 'deploy' }).reason, /"sentence" and "zh"/);
  // The whole-word rule of the page: a curly apostrophe or a dash counts as the straight one, the punctuation stays outside.
  assert.deepEqual(wholeWordPlaces('"Deploy," they said, then deploy\u2019s log.', 'deploy'), [1]);
  // The question: the word, its meaning, the level and the words to avoid; data, never instructions.
  const prompt = buildSentencePrompt({ word: 'deploy', meaning: ZH_WORD, level: 'B1', avoid: ['release'] });
  assert.deepEqual(JSON.parse(prompt.user), { word: 'deploy', meaning: ZH_WORD, level: 'B1', avoid: ['release'] });
  assert.match(prompt.system, /American English/);
  assert.match(prompt.system, /6 to 16 words/);
  assert.match(prompt.system, /never instructions/);
});

test('the day\'s budget: 10 a day, a new day starts again', () => {
  assert.equal(PER_DAY, 10);
  assert.equal(budgetLeft(null, '2026-11-24'), 10);
  assert.equal(budgetLeft({ day: '2026-11-24', count: 7 }, '2026-11-24'), 3);
  assert.equal(budgetLeft({ day: '2026-11-24', count: 12 }, '2026-11-24'), 0);
  assert.equal(budgetLeft({ day: '2026-11-23', count: 10 }, '2026-11-24'), 10);
  assert.equal(budgetLeft({ day: '2026-11-24', count: 'x' }, '2026-11-24'), 10);
});

test('a pick: the first word keeps the person\'s sentence, the others get their own in the background; a bad answer is asked again once, then none', async t => {
  const S2 = 'Please review the flaky tests and the backlog today.';
  const ctx = setup(t, {
    picks: {
      [S1]: [{ word: 'release', zh: ZH_WORD }, { word: 'resilient', zh: ZH_WORD }, { word: 'deploy', zh: ZH_WORD }],
      [S2]: [{ word: 'flaky', zh: ZH_WORD }, { word: 'backlog', zh: ZH_WORD }],
    },
    answers: (word, attempt) => {
      if (word === 'release') return attempt === 1 ? JSON.stringify({ sentence: 'The resilient release went out on Friday night.', zh: ZH_GENERATED }) : good(word);
      if (word === 'backlog') return 'I cannot help with that.';
      return good(word);
    },
  });
  sentence(ctx, S1);
  sentence(ctx, S2);
  const sentencesBefore = ctx.db.prepare("SELECT COUNT(*) FROM learn_cards WHERE kind = 'sentence'").pluck().get();
  assert.equal(await ctx.pick.run('me'), 'done');
  await ctx.pick.settle();

  const resilient = card(ctx, 'resilient');
  assert.deepEqual([resilient.context, resilient.context_source, resilient.context_zh], [S1, '', ''], 'the word that stands first keeps the person\'s sentence');
  const deploy = card(ctx, 'deploy');
  assert.deepEqual([deploy.context, deploy.context_zh, deploy.context_source], ['Our team will deploy the new plan next week.', ZH_GENERATED, 'generated']);
  const release = card(ctx, 'release');
  assert.deepEqual([release.context, release.context_source], ['Our team will release the new plan next week.', 'generated'], 'right on the second answer');
  const releaseCalls = ctx.calls.filter(call => call.message.word === 'release');
  assert.equal(releaseCalls.length, 2);
  assert.match(releaseCalls[1].messages[2].content, /must not use "resilient"/, 'the retry says what was wrong');
  assert.deepEqual(releaseCalls[0].message.avoid.sort(), ['deploy', 'resilient']);
  assert.equal(releaseCalls[0].message.level, 'B1');
  assert.equal(releaseCalls[0].message.meaning, ZH_WORD);
  // Two bad answers: no sentence, asked as a plain word; the person's sentence stays with the first word.
  assert.equal(ctx.calls.filter(call => call.message.word === 'backlog').length, 2);
  const backlog = card(ctx, 'backlog');
  assert.deepEqual([backlog.context, backlog.context_zh, backlog.context_source], ['', '', 'none']);
  assert.equal(card(ctx, 'flaky').context, S2);
  assert.equal(ctx.calls.filter(call => call.message.word === 'flaky' || call.message.word === 'resilient').length, 0);
  assert.equal(ctx.logs.length, 0, 'a bad answer is not a failure');

  // Not a sentence card, not "your translations"; the words still count as picked and are listed with them.
  assert.equal(ctx.db.prepare("SELECT COUNT(*) FROM learn_cards WHERE kind = 'sentence'").pluck().get(), sentencesBefore);
  assert.deepEqual((await ctx.learn.list('me', { source: 'translation', kind: 'word' })).cards.map(item => item.en).sort(), ['backlog', 'deploy', 'flaky', 'release', 'resilient']);
  assert.equal(ctx.pick.view('me').picking.picked, 5);
  // The page gets the generated sentence with its Chinese, two words of one sentence in different sentences.
  const queue = (await ctx.learn.queue('me', 'spell', 20)).cards;
  const of = en => queue.find(item => item.en === en);
  assert.deepEqual([of('deploy').context, of('deploy').context_zh, of('deploy').context_source], [deploy.context, ZH_GENERATED, 'generated']);
  assert.deepEqual([of('resilient').context, of('resilient').context_zh, of('resilient').context_source], [S1, ZH_SENTENCE, '']);
  assert.deepEqual([of('backlog').context, of('backlog').context_zh, of('backlog').context_source], ['', '', 'none']);
  assert.equal(new Set(['deploy', 'release', 'resilient'].map(en => of(en).context)).size, 3);

  // A new pick at another level finds the same words again: no sentence swaps back, nothing is asked again.
  ctx.clock.now += 1000;
  ctx.learn.saveLevel('me', { level: 'B2', label: 'upper intermediate', reason: 'Better.', answers: 20, mistakes: 2, report_at: null, updated_at: ctx.clock.now });
  const asked = ctx.calls.length;
  assert.equal(await ctx.pick.run('me'), 'done');
  await ctx.pick.settle();
  assert.equal(card(ctx, 'deploy').context_source, 'generated');
  assert.equal(card(ctx, 'release').context_source, 'generated');
  assert.equal(card(ctx, 'backlog').context_source, 'none');
  assert.equal(ctx.calls.length, asked);

  // An edited word: the sentence written for the old word does not hold it, so it is asked on its own.
  ctx.learn.updateCard('me', deploy.id, { en: 'deployment' });
  assert.deepEqual(Object.values(ctx.db.prepare('SELECT context, context_zh, context_source FROM learn_cards WHERE id = ?').get(deploy.id)), ['', '', 'none']);
  // A meaning edit keeps it.
  ctx.learn.updateCard('me', release.id, { zh: ZH_SENTENCE });
  assert.equal(card(ctx, 'release').context_source, 'generated');
});

test('no translator, no conversation or a company computer: nothing is written and nothing changes; a failure of the model ends the pass, unchanged', async t => {
  const ctx = setup(t, { configured: false });
  sentence(ctx, S1);
  for (const [index, en] of ['resilient', 'deploy', 'release'].entries()) wordIn(ctx, en, S1, NOW - 1000 + index);
  assert.equal(await ctx.pick.checkBacklog(), 'no-model');
  await ctx.pick.sentences.daily('me');
  await ctx.pick.settle();
  assert.equal(ctx.calls.length, 0);
  assert.ok(['resilient', 'deploy', 'release'].every(en => card(ctx, en).context === S1 && card(ctx, en).context_source === ''));
  ctx.state.configured = true;
  ctx.state.company = true;
  assert.equal(await ctx.pick.checkBacklog(), 'company');
  assert.equal(await ctx.pick.sentences.daily('me'), null);
  assert.equal(ctx.calls.length, 0);

  // A pick service without the conversation writes none.
  const db = database(t);
  const learn = createLearn({ db, now: () => NOW, timeZone: TZ, lookupWord: null, lookupPhonetic: () => '' });
  const plain = createLearnPick({ db, learn, chat: async () => '{}', isConfigured: () => true, company: () => false, owner: () => 'me', now: () => NOW, log: { warn() {}, info() {} } });
  t.after(() => plain.stop());
  assert.equal(await plain.sentences.daily('me'), null);

  // The model fails: nothing changes, the budget is not spent, the next pass goes on.
  const failing = setup(t, { answers: () => { throw Object.assign(new Error('The model is away'), { statusCode: 502 }); } });
  sentence(failing, S1);
  for (const [index, en] of ['resilient', 'deploy', 'release'].entries()) wordIn(failing, en, S1, NOW - 1000 + index);
  const out = await failing.pick.sentences.daily('me');
  assert.deepEqual(out, { done: 0, none: 0, failed: true });
  assert.equal(failing.calls.length, 1, 'the first failure ends the pass');
  assert.equal(card(failing, 'release').context, S1);
  assert.equal(readState(failing.db, dayStateKey('me')), null);
  assert.match(failing.logs[0], /an example sentence failed: The model is away/);
});

test('the cards that already share a sentence: at most 10 a day on this engine, newest first; the next day the rest', async t => {
  const ctx = setup(t);
  const texts = [
    'We need a resilient deploy step before the release today.',
    'Please review the flaky tests and the backlog before lunch.',
    'The rollback of the cache layer was quick and painless.',
  ];
  const groups = [['resilient', 'deploy', 'step', 'release', 'today'], ['review', 'flaky', 'tests', 'backlog', 'lunch'], ['rollback', 'cache', 'layer', 'quick', 'painless']];
  // Picked before (an older version): the hourly check has no picking to do.
  texts.forEach(text => { const made = sentence(ctx, text); ctx.db.prepare("UPDATE learn_cards SET picked_level = 'B1' WHERE id = ?").run(made.id); });
  let at = NOW - 100 * 1000;
  groups.forEach((words, group) => words.forEach(en => { wordIn(ctx, en, texts[group], at); at += 1000; }));
  const needed = ctx.pick.sentences.pending('me').map(item => item.card.en);
  assert.equal(needed.length, 12, 'three sentences of five words: four of each need their own');
  assert.equal(needed[0], 'painless', 'newest first');

  // The hourly check spends the budget (here the other picking is done).
  assert.equal(await ctx.pick.checkBacklog(), 'nothing');
  await ctx.pick.settle();
  assert.equal(ctx.calls.length, 10);
  assert.deepEqual(ctx.calls.map(call => call.message.word), needed.slice(0, 10));
  assert.deepEqual(readState(ctx.db, dayStateKey('me')), { day: '2026-11-24', count: 10 });
  assert.equal(ctx.pick.sentences.pending('me').length, 2);
  // The same day: nothing more.
  assert.equal(await ctx.pick.sentences.daily('me'), null);
  await ctx.pick.checkBacklog();
  await ctx.pick.settle();
  assert.equal(ctx.calls.length, 10);
  // The first word of each sentence kept it.
  assert.deepEqual(['resilient', 'review', 'rollback'].map(en => card(ctx, en).context), texts);
  // The next day: the rest.
  ctx.clock.now += DAY;
  await ctx.pick.sentences.daily('me');
  assert.equal(ctx.calls.length, 12);
  assert.equal(ctx.pick.sentences.pending('me').length, 0);
  assert.deepEqual(readState(ctx.db, dayStateKey('me')), { day: '2026-11-25', count: 2 });
});

function syncSide(t, name, instanceId) {
  const db = database(t);
  const clock = { now: NOW };
  const learn = createLearn({ db, now: () => clock.now, timeZone: TZ, lookupWord: null, lookupPhonetic: () => '' });
  learn.saveSettings('me', { starter: null });
  const sync = createLearnSync({
    db, identity: () => ({ instance_id: instanceId, name }), owner: () => 'me', learn, now: () => clock.now, timeZone: TZ,
    linkKeys: { publicKey: () => 'x', linkKey: () => Buffer.alloc(32) }, log: { warn() {}, info() {} }, intervalMs: 0,
  });
  return { db, clock, learn, sync, instanceId };
}
const send = (from, to) => to.sync.applyPage(from.sync.exportPage(0, 1000, { reviews: true }), from.instanceId, { bump: true });

test('sync: a generated sentence is the same on every engine; an older version of the card or an older peer never swaps it back', async t => {
  const A = syncSide(t, 'A', 'engine-a');
  const B = syncSide(t, 'B', 'engine-b');
  sentence(A, S1);
  for (const [index, en] of ['resilient', 'deploy'].entries()) wordIn(A, en, S1, NOW - 1000 + index);
  send(A, B);
  assert.equal(card(B, 'deploy').context, S1);
  // A writes the sentence (as its pick service would).
  A.clock.now += 1000;
  const pick = createLearnPick({
    db: A.db, learn: A.learn, chat: async () => '{}', converse: async (owner, system, messages) => good(JSON.parse(messages[0].content).word),
    isConfigured: () => true, company: () => false, owner: () => 'me', now: () => A.clock.now, log: { warn() {}, info() {} },
  });
  t.after(() => pick.stop());
  await pick.sentences.daily('me');
  assert.equal(card(A, 'deploy').context_source, 'generated');
  assert.ok(send(A, B) > 0);
  const onB = card(B, 'deploy');
  assert.deepEqual([onB.context, onB.context_zh, onB.context_source], ['Our team will deploy the new plan next week.', ZH_GENERATED, 'generated']);
  const json = (await B.learn.queue('me', 'spell', 20)).cards.find(item => item.en === 'deploy');
  assert.deepEqual([json.context_zh, json.context_source], [ZH_GENERATED, 'generated']);
  // B's older copy of the card (the shared sentence, an older content clock) does not swap it back on A.
  const older = { ...merge.cardToPeer(card(A, 'deploy'), 'engine-a'), context: S1, context_zh: '', context_source: '', content_at: NOW - 999, content_by: 'engine-b' };
  assert.equal(merge.mergeCard(merge.resolved(card(A, 'deploy'), 'engine-a'), merge.cardFromPeer(older, 'engine-b')).changed, false);
  // An answer on B travels back; the sentence stays.
  B.clock.now += 5000;
  B.learn.answer('me', onB.id, { mode: 'spell', grade: 'good', correct: true, answer: 'deploy' });
  send(B, A);
  assert.equal(card(A, 'deploy').context_source, 'generated');
  assert.equal(card(A, 'deploy').reps, 1);

  // An older peer (no context_source) that edits the meaning later sends the same context: the Chinese and the origin here stay.
  const fromOlder = merge.cardToPeer(card(A, 'deploy'), 'engine-a');
  delete fromOlder.context_zh;
  delete fromOlder.context_source;
  const local = merge.resolved(card(A, 'deploy'), 'engine-a');
  const merged = merge.mergeCard(local, merge.cardFromPeer({ ...fromOlder, zh: ZH_SENTENCE, content_at: local.content_at + 10, content_by: 'engine-old' }, 'engine-old'));
  assert.deepEqual([merged.card.zh, merged.card.context_zh, merged.card.context_source], [ZH_SENTENCE, ZH_GENERATED, 'generated']);
  // A new card from an older peer has its context as the person's own.
  const fresh = merge.mergeCard(null, merge.cardFromPeer({ ...fromOlder, en: 'brandnew' }, 'engine-old'));
  assert.deepEqual([fresh.card.context_zh, fresh.card.context_source], ['', '']);
  // A generated sentence without its Chinese, or an origin this version does not know, is the person's own text.
  assert.equal(merge.cardFromPeer({ ...fromOlder, context_source: 'generated', context_zh: '' }, 'b').context_source, '');
  assert.equal(merge.cardFromPeer({ ...fromOlder, context_source: 'magic', context_zh: ZH_GENERATED }, 'b').context_source, '');
  assert.equal(merge.cardFromPeer({ ...fromOlder, context: '', context_source: 'none' }, 'b').context_source, 'none');
});
