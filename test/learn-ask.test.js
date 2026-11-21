// Learn: ask the model about a practice card ("Ask about a question" in docs/design/learn-english.md; services/learn-ask.js, routes/learn.js,
// services/learn-merge.js, services/learn-sync.js, services/learn-sync-store.js): the system prompt before and after Check (hints only, then the
// answer), privacy, the checks, storing only an answer that arrived, the newest 20 messages, one ask per card, the rate limit, the routes (a streamed
// answer as NDJSON, errors before and inside the stream, a page that goes away), and the messages between engines. Every `converse` here is a stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-ask-data-'));
delete process.env.TAGENT_HOME;
const express = require('express');
const Database = require('better-sqlite3');
const { createLearn } = require('../services/learn');
const { createLearnRouter } = require('../routes/learn');
const { createLearnSync } = require('../services/learn-sync');
const merge = require('../services/learn-merge');
const { MAX_CHAT_MESSAGES } = require('../services/learn-sync-store');
const { createLearnAsk, systemPrompt, RATE_LIMIT, RATE_WINDOW_MS } = require('../services/learn-ask');

const NOW = Date.UTC(2026, 10, 21, 4, 0, 0);
const TZ = 'UTC';
// Chinese meanings, sentences and questions (user content), written with escapes.
const ZH_WORD = '\u90e8\u7f72';
const ZH_SENTENCE = '\u6211\u4eec\u4eca\u5929\u90e8\u7f72\u65b0\u7248\u672c';
const ZH_QUESTION = '\u8fd9\u4e2a\u8bcd\u662f\u4ec0\u4e48\u8bcd\u6027\uff1f';

function database(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-ask-'));
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

// A model that answers every question with `answer(call)` (a string or an array of pieces), streamed through onDelta when given, recording the calls.
// `gate`: a promise the answer waits for (to hold an ask open); `fail(call)`: an error to throw after the first piece.
function stubModel({ answer = () => ['It is ', 'a **verb**.'], gate = null, fail = null } = {}) {
  const calls = [];
  const converse = async (owner, system, messages, options) => {
    const call = { owner, system, messages, options };
    calls.push(call);
    const pieces = [].concat(answer(call));
    for (const [index, piece] of pieces.entries()) {
      if (options.signal && options.signal.aborted) throw Object.assign(new Error('The question was cancelled'), { statusCode: 499 });
      if (options.onDelta) options.onDelta(piece);
      if (index === 0 && gate) await gate;
      if (index === 0 && fail && fail(call)) throw Object.assign(new Error('DeepSeek returned an error (HTTP 500)'), { statusCode: 502 });
    }
    if (options.signal && options.signal.aborted) throw Object.assign(new Error('The question was cancelled'), { statusCode: 499 });
    return pieces.join('');
  };
  return { calls, converse };
}

function setup(t, options = {}) {
  const db = database(t);
  const clock = { now: NOW };
  const learn = createLearn({ db, now: () => clock.now, timeZone: TZ, lookupWord: null, lookupPhonetic: () => '' });
  learn.saveSettings('me', { starter: null });
  const model = stubModel(options);
  const state = { configured: options.configured !== false };
  const ask = createLearnAsk({ db, learn, converse: model.converse, isConfigured: () => state.configured, now: () => clock.now });
  return { db, clock, learn, ask, model, state };
}
const word = (ctx, en = 'deploy', extra = {}) => ctx.learn.addCard('me', { kind: 'word', en, zh: ZH_WORD, source: 'manual', ...extra }).card;
const sentenceCard = (ctx, en = 'We deploy the new version today.') => ctx.learn.addCard('me', { kind: 'sentence', en, zh: ZH_SENTENCE, source: 'translation', context: 'Release v2 of billing' }).card;
const chatsOf = (db, cardId) => db.prepare('SELECT * FROM learn_chats WHERE card_id = ? ORDER BY at, uid').all(cardId);
const before = { checked: false };

test('the prompt: before Check the right answer is given only for hints and never to be written; after Check the answer, the person\'s answer and the result', () => {
  const card = { kind: 'word', en: 'deploy', zh: ZH_WORD, phonetic: '/d\u026a\u02c8pl\u0254\u026a/', context: 'We deploy the new version today.', context_zh: ZH_SENTENCE };
  const hints = systemPrompt({ card, mode: 'spell', state: { checked: false, answer: '', correct: null, helped: false, expected: '' }, level: { level: 'B1', label: 'intermediate' } });
  assert.match(hints, /English tutor for a Chinese-speaking software developer/);
  assert.match(hints, /language of the person's question/);
  assert.match(hints, /at most about 120 words/);
  assert.match(hints, /\*\*bold\*\*/);
  assert.match(hints, /no headings, no tables/);
  assert.match(hints, /The card: the English word "deploy"\./);
  assert.ok(hints.includes(ZH_WORD) && hints.includes(ZH_SENTENCE) && hints.includes('/d\u026a\u02c8pl\u0254\u026a/'));
  assert.match(hints, /asked inside this sentence: "We deploy the new version today\."/);
  assert.match(hints, /Spell: the person sees the Chinese meaning/);
  assert.match(hints, /estimated English level: B1 \(intermediate\)/);
  assert.match(hints, /NOT checked their answer yet\. The right answer \(the word\) is "deploy"/);
  assert.match(hints, /Never write the right answer, never spell it or list its letters/);
  assert.match(hints, /Give hints only/);
  assert.doesNotMatch(hints, /The person answered/);

  const after = systemPrompt({ card, mode: 'spell', state: { checked: true, answer: 'deplot', correct: false, helped: true, expected: '' } });
  assert.match(after, /has checked their answer\. The right answer is "deploy"\./);
  assert.match(after, /The person answered "deplot"\./);
  assert.match(after, /Their answer was wrong\./);
  assert.match(after, /used help/);
  assert.doesNotMatch(after, /Never write/);
  assert.doesNotMatch(after, /level/, 'no level when none is known');
  assert.match(systemPrompt({ card, mode: 'spell', state: { checked: true, answer: '', correct: false, helped: false, expected: '' } }), /gave no answer/);

  // A sentence: the English and the Chinese; Fill the gap names the missing word as the answer.
  const sentence = { kind: 'sentence', en: 'We deploy the new version today.', zh: ZH_SENTENCE, phonetic: '', context: '', context_zh: '' };
  const fill = systemPrompt({ card: sentence, mode: 'fill', state: { checked: false, answer: '', correct: null, helped: false, expected: 'deploy' } });
  assert.match(fill, /The card: the English sentence "We deploy the new version today\."/);
  assert.match(fill, /The right answer \(the missing word\) is "deploy"/);
  assert.match(fill, /Fill the gap/);
  assert.match(systemPrompt({ card: sentence, mode: 'build', state: { checked: false, answer: '', correct: null, helped: false, expected: '' } }), /The right answer \(the sentence\) is "We deploy/);
});

test('asking: the answer streams, the question and the answer are stored together, earlier messages go to the model, and privacy holds', async t => {
  const ctx = setup(t);
  ctx.learn.saveLevel('me', { level: 'B2', label: 'upper intermediate', reason: 'r', answers: 10, mistakes: 1, report_at: null, updated_at: NOW });
  sentenceCard(ctx);
  // A word asked inside one of the person's sentences, and one whose context is a task title.
  const inSentence = word(ctx, 'deploy', { context: 'We deploy the new version today.' });
  const fromTask = word(ctx, 'rollback', { context: 'Fix the billing service of Alice' });
  assert.deepEqual(ctx.ask.history('me', inSentence.id), { messages: [], translator: true });

  const pieces = [];
  const result = await ctx.ask.ask('me', inSentence.id, { question: `  ${ZH_QUESTION}\n`, mode: 'spell', state: before }, { onDelta: piece => pieces.push(piece) });
  assert.deepEqual(pieces, ['It is ', 'a **verb**.']);
  assert.deepEqual(result.messages.map(item => [item.role, item.text]), [['user', ZH_QUESTION], ['assistant', 'It is a **verb**.']]);
  assert.ok(result.messages.every(item => /^[0-9a-f-]{36}$/.test(item.uid) && item.at === new Date(Date.parse(item.at)).toISOString()));
  assert.ok(Date.parse(result.messages[1].at) > Date.parse(result.messages[0].at), 'the answer after the question');
  assert.deepEqual(ctx.ask.history('me', inSentence.id).messages, result.messages);

  const first = ctx.model.calls[0];
  assert.equal(first.owner, 'me', 'asked with the owner\'s model');
  assert.deepEqual(first.messages, [{ role: 'user', content: ZH_QUESTION }]);
  assert.deepEqual([first.options.maxTokens, typeof first.options.onDelta], [800, 'function']);
  assert.match(first.system, /B2 \(upper intermediate\)/);
  assert.ok(first.system.includes(ZH_SENTENCE), 'the Chinese of the word\'s sentence');
  // Privacy: no time, no login, no task title.
  assert.doesNotMatch(first.system, /2026|\bme\b|T\d\d:/);

  // The next question has the earlier messages before it.
  ctx.clock.now += 1000;
  await ctx.ask.ask('me', inSentence.id, { question: 'Why?', mode: 'spell', state: { checked: true, answer: 'deplot', correct: false } });
  assert.deepEqual(ctx.model.calls[1].messages, [
    { role: 'user', content: ZH_QUESTION }, { role: 'assistant', content: 'It is a **verb**.' }, { role: 'user', content: 'Why?' },
  ]);
  assert.match(ctx.model.calls[1].system, /The person answered "deplot"/);
  assert.equal(ctx.ask.history('me', inSentence.id).messages.length, 4);

  await ctx.ask.ask('me', fromTask.id, { question: 'A hint?', mode: 'review', state: before });
  const third = ctx.model.calls[2].system;
  assert.doesNotMatch(third, /billing|Alice/, 'a context that is not one of the person\'s sentences is never sent');
  assert.doesNotMatch(third, /asked inside this sentence/);
  // A sentence card's own context (the task title) is never sent either.
  const sentenceId = ctx.db.prepare("SELECT id FROM learn_cards WHERE kind = 'sentence'").pluck().get();
  await ctx.ask.ask('me', sentenceId, { question: 'Explain the grammar', mode: 'build', state: before });
  assert.doesNotMatch(ctx.model.calls[3].system, /Release v2|billing/);
  assert.ok(ctx.model.calls[3].system.includes(ZH_SENTENCE));
});

test('asking: the checks come before the model; a failed or cancelled ask stores nothing; one ask per card; the rate limit; only the newest 20 are kept', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ctx = setup(t, { gate });
  const card = word(ctx);
  const other = word(ctx, 'merge');
  const refused = async (body, status, message, id = card.id) => {
    await assert.rejects(ctx.ask.ask('me', id, body), error => error.statusCode === status && error.message === message);
  };
  await refused(null, 400, 'Invalid question');
  await refused({ question: '  ', mode: 'spell' }, 400, 'Enter your question');
  await refused({ question: 'x'.repeat(501), mode: 'spell' }, 400, 'The question cannot exceed 500 characters');
  await refused({ question: 'Why?', mode: 'chat' }, 400, 'Unknown practice mode');
  await refused({ question: 'Why?', mode: 'spell', state: 'checked' }, 400, 'Invalid question state');
  await refused({ question: 'Why?', mode: 'spell', state: { checked: 'yes' } }, 400, 'Invalid question state');
  await refused({ question: 'Why?', mode: 'spell', state: before }, 404, 'Card not found', 999);
  await assert.rejects(ctx.ask.ask('other-owner', card.id, { question: 'Why?', mode: 'spell', state: before }), error => error.statusCode === 404);
  ctx.state.configured = false;
  await refused({ question: 'Why?', mode: 'spell', state: before }, 503, 'Translation service not configured yet');
  assert.equal(ctx.ask.history('me', card.id).translator, false);
  ctx.state.configured = true;
  assert.equal(ctx.model.calls.length, 0, 'no refusal asked the model');
  assert.equal(ctx.ask.ask('me', card.id, { question: 'x'.repeat(500), mode: 'spell' }) instanceof Promise, true, 'a question of 500 characters and no state is fine');

  // One ask per card at a time: the first is held open by the gate.
  await refused({ question: 'Again?', mode: 'spell', state: before }, 409, 'Another question about this card is being answered');
  assert.equal(ctx.ask.running('me', card.id), true);
  release();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ctx.ask.running('me', card.id), false);
  assert.equal(chatsOf(ctx.db, card.id).length, 2);

  // The model fails after the first piece: nothing is stored. A cancelled ask stores nothing either.
  const failing = setup(t, { fail: () => true });
  const failCard = word(failing);
  await assert.rejects(failing.ask.ask('me', failCard.id, { question: 'Why?', mode: 'spell', state: before }, { onDelta() {} }), error => error.statusCode === 502);
  const controller = new AbortController();
  await assert.rejects(failing.ask.ask('me', failCard.id, { question: 'Why?', mode: 'spell' }, { signal: controller.signal, onDelta: () => controller.abort() }), error => error.statusCode === 499);
  assert.equal(chatsOf(failing.db, failCard.id).length, 0);
  // The translator's own "not set up" (409 there) is 503 here.
  const noModel = setup(t);
  const noModelCard = word(noModel);
  noModel.model.calls.length = 0;
  const translatorRefuses = createLearnAsk({
    db: noModel.db, learn: noModel.learn, isConfigured: () => true,
    converse: async () => { throw Object.assign(new Error('Translation service not configured yet'), { statusCode: 409 }); },
  });
  await assert.rejects(translatorRefuses.ask('me', noModelCard.id, { question: 'Why?', mode: 'spell' }), error => error.statusCode === 503);

  // At most RATE_LIMIT asks a minute per owner (refused ones before the limit do not count), on a fake clock.
  const busy = setup(t);
  const cards = [word(busy, 'alpha'), word(busy, 'beta')];
  for (let index = 0; index < RATE_LIMIT; index += 1) {
    busy.clock.now += 100;
    await busy.ask.ask('me', cards[0].id, { question: `Q${index}`, mode: 'spell', state: before });
  }
  await assert.rejects(busy.ask.ask('me', cards[0].id, { question: 'One more', mode: 'spell', state: before }),
    error => error.statusCode === 429 && error.message === 'Too many questions in a minute. Wait a moment and ask again.');
  busy.clock.now += RATE_WINDOW_MS;
  await busy.ask.ask('me', cards[0].id, { question: 'Later', mode: 'spell', state: before });

  // Only the newest 20 messages of a card are kept (10 questions and answers), the oldest go first; at most 20 go to the model.
  const counted = chatsOf(busy.db, cards[0].id);
  assert.equal(counted.length, MAX_CHAT_MESSAGES);
  assert.equal(counted[counted.length - 2].text, 'Later');
  assert.ok(!counted.some(row => row.text === 'Q0'), 'the oldest question was pruned');
  busy.clock.now += RATE_WINDOW_MS;
  await busy.ask.ask('me', cards[0].id, { question: 'Last', mode: 'spell', state: before });
  assert.equal(busy.model.calls[busy.model.calls.length - 1].messages.length, MAX_CHAT_MESSAGES + 1);
  await busy.ask.ask('me', cards[1].id, { question: 'Other card', mode: 'spell', state: before });

  // Deleting a card deletes its messages.
  busy.db.prepare('DELETE FROM learn_cards WHERE id = ?').run(cards[0].id);
  assert.equal(chatsOf(busy.db, cards[0].id).length, 0);
  assert.equal(busy.db.prepare('SELECT COUNT(*) FROM learn_chats WHERE card_id = ?').pluck().get(cards[1].id) > 0, true);
  assert.equal(other.kind, 'word');
});

async function serve(t, ctx, ask = ctx.ask) {
  const app = express();
  app.use(express.json());
  app.use('/api/learn', createLearnRouter({ service: ctx.learn, ask, sync: null, analysis: null, pick: null, requireAuth: (req, res, next) => { req.session = { user: { login: 'me' } }; next(); }, clientOrigin: (req, res, next) => next() }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api/learn`;
  return async (method, url, body, options = {}) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), ...options });
    const text = await response.text();
    const type = response.headers.get('content-type') || '';
    return { status: response.status, type, body: /ndjson/.test(type) ? text.split('\n').filter(Boolean).map(line => JSON.parse(line)) : (text ? JSON.parse(text) : null) };
  };
}

test('the routes: GET the messages, POST streams NDJSON deltas and a done line; refusals are JSON; a model failure mid-way is an error line', async t => {
  const ctx = setup(t, { fail: call => call.messages[call.messages.length - 1].content === 'Break' });
  const card = word(ctx);
  const call = await serve(t, ctx);
  assert.deepEqual((await call('GET', `/cards/${card.id}/ask`)).body, { messages: [], translator: true });
  assert.equal((await call('GET', '/cards/999/ask')).status, 404);

  const asked = await call('POST', `/cards/${card.id}/ask`, { question: 'Give me a hint', mode: 'spell', state: before });
  assert.equal(asked.status, 200);
  assert.match(asked.type, /^application\/x-ndjson/);
  assert.deepEqual(asked.body.slice(0, 2), [{ delta: 'It is ' }, { delta: 'a **verb**.' }]);
  const done = asked.body[2];
  assert.equal(done.done, true);
  assert.deepEqual(done.messages.map(item => [item.role, item.text]), [['user', 'Give me a hint'], ['assistant', 'It is a **verb**.']]);
  assert.equal(asked.body.length, 3);
  assert.deepEqual((await call('GET', `/cards/${card.id}/ask`)).body.messages, done.messages);

  for (const [body, status, error] of [
    [{ question: '', mode: 'spell' }, 400, 'Enter your question'],
    [{ question: 'Why?', mode: 'nope' }, 400, 'Unknown practice mode'],
  ]) {
    const refused = await call('POST', `/cards/${card.id}/ask`, body);
    assert.deepEqual([refused.status, refused.body], [status, { error }]);
    assert.match(refused.type, /application\/json/);
  }
  assert.equal((await call('POST', '/cards/999/ask', { question: 'Why?', mode: 'spell' })).status, 404);
  ctx.state.configured = false;
  const off = await call('POST', `/cards/${card.id}/ask`, { question: 'Why?', mode: 'spell' });
  assert.deepEqual([off.status, off.body], [503, { error: 'Translation service not configured yet' }]);
  ctx.state.configured = true;

  const broken = await call('POST', `/cards/${card.id}/ask`, { question: 'Break', mode: 'spell', state: before });
  assert.equal(broken.status, 200);
  assert.deepEqual(broken.body, [{ delta: 'It is ' }, { error: 'DeepSeek returned an error (HTTP 500)', status: 502 }]);
  assert.equal(chatsOf(ctx.db, card.id).length, 2, 'nothing stored for the broken answer');

  // A model that fails before its first piece: the usual JSON error.
  const early = setup(t);
  const earlyCard = word(early);
  const earlyAsk = createLearnAsk({ db: early.db, learn: early.learn, isConfigured: () => true,
    converse: async () => { throw Object.assign(new Error('The DeepSeek API key is invalid or lacks permission'), { statusCode: 502 }); } });
  const earlyCall = await serve(t, early, earlyAsk);
  const refusedEarly = await earlyCall('POST', `/cards/${earlyCard.id}/ask`, { question: 'Why?', mode: 'spell' });
  assert.deepEqual([refusedEarly.status, refusedEarly.body], [502, { error: 'The DeepSeek API key is invalid or lacks permission' }]);

  // Without the service at all: 503.
  const none = await serve(t, early, null);
  assert.equal((await none('GET', `/cards/${earlyCard.id}/ask`)).status, 503);
});

test('the routes: a page that goes away mid-answer cancels the model\'s call, and nothing is stored', async t => {
  let cancelled = null;
  const ctx = setup(t);
  const card = word(ctx);
  const seen = new Promise(resolve => { cancelled = resolve; });
  const ask = createLearnAsk({
    db: ctx.db, learn: ctx.learn, isConfigured: () => true,
    converse: async (owner, system, messages, options) => {
      options.onDelta('Start');
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      cancelled(true);
      throw Object.assign(new Error('The question was cancelled'), { statusCode: 499 });
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/learn', createLearnRouter({ service: ctx.learn, ask, sync: null, analysis: null, pick: null, requireAuth: (req, res, next) => { req.session = { user: { login: 'me' } }; next(); }, clientOrigin: (req, res, next) => next() }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/learn/cards/${card.id}/ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Why?', mode: 'spell' }), signal: controller.signal,
  });
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.equal(first, '{"delta":"Start"}\n');
  controller.abort();
  assert.equal(await seen, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(chatsOf(ctx.db, card.id).length, 0);
  assert.equal(ask.running('me', card.id), false);
});

// ---- Between engines ----
function syncSide(t, name, instanceId) {
  const db = database(t);
  const clock = { now: NOW };
  const learn = createLearn({ db, now: () => clock.now, timeZone: TZ, lookupWord: null, lookupPhonetic: () => '' });
  learn.saveSettings('me', { starter: null });
  const sync = createLearnSync({
    db, identity: () => ({ instance_id: instanceId, name }), owner: () => 'me', learn, now: () => clock.now, timeZone: TZ,
    linkKeys: { publicKey: () => 'x', linkKey: () => Buffer.alloc(32) }, log: { warn() {}, info() {} }, intervalMs: 0,
  });
  const model = stubModel({ answer: call => `Answer on ${name} to ${call.messages[call.messages.length - 1].content}` });
  const ask = createLearnAsk({ db, learn, sync, converse: model.converse, isConfigured: () => true, now: () => clock.now });
  return { db, clock, learn, sync, ask, instanceId };
}
const send = (from, to, { reviews = true, bump = true } = {}) => to.sync.applyPage(from.sync.exportPage(0, 1000, { reviews }), from.instanceId, { bump });
const texts = (side, en = 'deploy') => side.db.prepare("SELECT m.role, m.text FROM learn_chats m JOIN learn_cards c ON c.id = m.card_id WHERE c.norm = ? ORDER BY m.at, m.uid").all(en).map(row => `${row.role}:${row.text}`);

test('sync: the messages of a card reach every normal engine by its text, a union by uid, the newest 20 after a merge; never a company computer', async t => {
  const A = syncSide(t, 'A', 'engine-a');
  const B = syncSide(t, 'B', 'engine-b');
  const onA = word(A);
  send(A, B);
  await A.ask.ask('me', onA.id, { question: 'Hint?', mode: 'spell' });
  assert.ok(send(A, B) > 0);
  assert.deepEqual(texts(B), ['user:Hint?', 'assistant:Answer on A to Hint?']);
  const onB = B.db.prepare("SELECT id FROM learn_cards WHERE norm = 'deploy'").pluck().get();
  assert.notEqual(onB, undefined);
  assert.deepEqual(B.ask.history('me', onB).messages.map(item => item.uid), A.ask.history('me', onA.id).messages.map(item => item.uid), 'the same uids');
  assert.equal(send(A, B), 0, 'nothing changes the second time');
  assert.equal(B.db.prepare("SELECT by FROM learn_chats LIMIT 1").pluck().get(), 'engine-a');

  // Both ask while apart: the union, in the order of the hybrid clock, on both sides.
  A.clock.now = NOW + 1000;
  B.clock.now = NOW + 2000;
  await A.ask.ask('me', onA.id, { question: 'From A', mode: 'spell' });
  await B.ask.ask('me', onB, { question: 'From B', mode: 'spell' });
  send(A, B);
  send(B, A);
  assert.deepEqual(texts(A), texts(B));
  assert.deepEqual(texts(A).filter(item => item.startsWith('user:')), ['user:Hint?', 'user:From A', 'user:From B']);

  // Past 20 on both sides: the same newest 20 everywhere after the merge.
  for (let index = 0; index < 9; index += 1) {
    A.clock.now += 10;
    B.clock.now += 10;
    await A.ask.ask('me', onA.id, { question: `A${index}`, mode: 'spell' });
    await B.ask.ask('me', onB, { question: `B${index}`, mode: 'spell' });
  }
  send(A, B);
  send(B, A);
  assert.equal(texts(A).length, MAX_CHAT_MESSAGES);
  assert.deepEqual(texts(A), texts(B));
  assert.ok(!texts(A).includes('user:Hint?'), 'the oldest went');
  assert.equal(send(A, B) + send(B, A), 0, 'a pruned message that comes again is not kept');

  // A company computer's pull (cards only) carries none; its own messages from before it was marked go to the home and leave it.
  const C = syncSide(t, 'C', 'engine-c');
  C.sync.applyPage(A.sync.exportPage(0, 1000, { reviews: false }), A.instanceId, { bump: false });
  assert.equal(C.db.prepare('SELECT COUNT(*) FROM learn_chats').pluck().get(), 0);
  assert.equal(A.sync.exportPage(0, 1000, { reviews: false }).chats.length, 0);

  // Messages that do not check are not applied; an older peer's page without `chats` is fine.
  assert.equal(B.sync.applyPage({ chats: [{ uid: 'bad uid!', kind: 'word', norm: 'deploy', role: 'user', text: 'x', at: 1 }, { uid: 'chat-0001', kind: 'word', norm: 'deploy', role: 'system', text: 'x', at: 1 }] }, 'engine-z'), 0);
  assert.equal(merge.chatFromPeer({ uid: 'chat-0002', kind: 'word', norm: 'deploy', role: 'assistant', text: 'y'.repeat(3000), at: 5 }, 'engine-z').text.length, 2000);
  assert.equal(merge.chatFromPeer({ uid: 'chat-0003', kind: 'word', norm: 'deploy', role: 'user', text: 'y'.repeat(3000), at: 5 }, 'engine-z').text.length, 500);
  assert.equal(merge.chatFromPeer({ uid: 'chat-0004', kind: 'word', norm: 'Deploy', role: 'user', text: 'y', at: 5 }, 'engine-z'), null, 'norm as it is kept');
  const { chats, ...older } = A.sync.exportPage(0, 1000);
  assert.ok(chats.length > 0);
  assert.equal(B.sync.applyPage(older, A.instanceId), 0);
});

test('sync: the messages follow a card whose text changed, and a message for a card that is not there waits for it', async t => {
  const A = syncSide(t, 'A', 'engine-a');
  const B = syncSide(t, 'B', 'engine-b');
  const card = word(A, 'deplyo');
  send(A, B);
  const onB = B.db.prepare("SELECT id FROM learn_cards WHERE norm = 'deplyo'").pluck().get();
  await B.ask.ask('me', onB, { question: 'Asked on B', mode: 'spell' });
  // A fixes the text; B's messages under the old text come along when the move arrives, and A gets them by the new text.
  A.clock.now = NOW + 5000;
  A.learn.updateCard('me', card.id, { en: 'deploy' });
  await A.ask.ask('me', card.id, { question: 'Asked on A', mode: 'spell' });
  send(A, B);
  assert.deepEqual(texts(B).filter(item => item.startsWith('user:')), ['user:Asked on B', 'user:Asked on A']);
  assert.equal(B.db.prepare("SELECT COUNT(*) FROM learn_cards WHERE norm = 'deplyo'").pluck().get(), 0);
  send(B, A);
  assert.deepEqual(texts(A), texts(B));
  // A message whose card this engine does not have is not stored (it comes with its card in a later page).
  const C = syncSide(t, 'C', 'engine-c');
  const page = A.sync.exportPage(0, 1000);
  assert.equal(C.sync.applyPage({ chats: page.chats }, A.instanceId), 0);
  assert.ok(C.sync.applyPage(page, A.instanceId) > 0);
  assert.deepEqual(texts(C), texts(A));
});
