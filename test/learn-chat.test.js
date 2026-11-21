// Learn: the English chat (docs/design/learn-english-chat.md; services/learn-chat.js, routes/learn.js, services/learn-merge.js, services/learn-sync.js,
// services/learn-sync-store.js): the limits (100 messages, the newest 50 chats that are not journal chats, journal chats never pruned), the meta line
// (never streamed or stored, checked, missing or broken), the journal flag by the model and by the person, the topics (journal and mistakes
// summaries, nothing otherwise), the prompt (American English, level, the history that fits), the routes (NDJSON, refusals, an error line, a page
// that goes away), PATCH and DELETE, the summary's count, and the chats between two databases. Every `converse` here is a stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-chat-data-'));
delete process.env.TAGENT_HOME;
const express = require('express');
const Database = require('better-sqlite3');
const { createLearn } = require('../services/learn');
const { createLearnRouter } = require('../routes/learn');
const { createLearnSync } = require('../services/learn-sync');
const merge = require('../services/learn-merge');
const { MAX_CONVOS, MAX_CONVO_MESSAGES } = require('../services/learn-sync-store');
const {
  createLearnChat, systemPrompt, splitMeta, metaFilter, fitHistory, topicsOf, journalSummary, dayParts, MAX_PROMPT, RATE_LIMIT, RATE_WINDOW_MS,
} = require('../services/learn-chat');

// Saturday 2026-11-21 04:00 UTC.
const NOW = Date.UTC(2026, 10, 21, 4, 0, 0);
const TZ = 'UTC';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Chinese meanings and questions (user content), written with escapes.
const ZH = '\u4e16\u754c';
const ZH_QUESTION = '\u8fd9\u4e2a\u8bcd\u600e\u4e48\u7528\uff1f';
const ZH_DIARY = '\u6211\u7684\u65e5\u8bb0\u5199\u5f97\u600e\u4e48\u6837\uff1f';
const ZH_MISTAKES = '\u6211\u7ecf\u5e38\u62fc\u9519\u54ea\u4e9b\u8bcd\uff1f';

function database(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-chat-'));
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

const metaLine = (value = {}) => `\n<<meta>>${JSON.stringify({ cards: [], mistakes: [], journal: false, title: '', ...value })}`;
// A model that answers with `answer(call)` (a string or an array of pieces), streamed through onDelta when given, recording the calls. `gate`: a
// promise the answer waits for after its first piece; `fail(call)`: throw after the first piece.
function stubModel({ answer = () => ['It is ', 'a **verb**.', metaLine({ title: 'A verb' })], gate = null, fail = null } = {}) {
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
    return pieces.join('');
  };
  return { calls, converse };
}

function setup(t, options = {}) {
  const db = options.db || database(t);
  const clock = { now: options.now || NOW };
  const learn = createLearn({ db, now: () => clock.now, timeZone: TZ, lookupWord: null, lookupPhonetic: () => '' });
  learn.saveSettings('me', { starter: null });
  const model = stubModel(options);
  const state = { configured: options.configured !== false };
  const chat = createLearnChat({
    db, learn, converse: model.converse, isConfigured: () => state.configured, now: () => clock.now, timeZone: TZ,
    rateLimit: options.rateLimit || 1000, sync: options.sync || null,
  });
  return { db, clock, learn, chat, model, state };
}
const convos = db => db.prepare("SELECT * FROM learn_convos WHERE owner = 'me' ORDER BY updated_at, uid").all();
const messagesOf = (db, uid) => db.prepare("SELECT * FROM learn_convo_messages WHERE owner = 'me' AND convo_uid = ? ORDER BY at, uid").all(uid);
const send = (ctx, body, options) => { ctx.clock.now += 1000; return ctx.chat.send('me', body, options); };

test('the meta line: never streamed, wherever the pieces are cut; stripped from the stored text; checked; missing or broken is no error', async t => {
  const full = `Hello **world**, use <b> and a << b.\nA second line.${metaLine({ cards: [{ kind: 'word', en: 'world', zh: ZH }] })}`;
  const text = 'Hello **world**, use <b> and a << b.\nA second line.';
  // Every cut into two and three pieces: the pieces sent are the text, never a part of the meta line.
  for (let a = 1; a < full.length; a += 1) {
    for (const b of [a + 1, a + 7, full.length - 3]) {
      if (b <= a || b >= full.length) continue;
      const sent = [];
      const push = metaFilter(piece => sent.push(piece));
      for (const piece of [full.slice(0, a), full.slice(a, b), full.slice(b)]) push(piece);
      assert.equal(sent.join(''), text, `cut at ${a}, ${b}`);
      assert.ok(sent.every(piece => piece.length > 0));
    }
  }
  // Without a meta line every piece comes through, except trailing white space; a held "<<" comes once it is not the start of the line.
  const sent = [];
  const push = metaFilter(piece => sent.push(piece));
  push('a <<');
  assert.deepEqual(sent, ['a']);
  push('b>> and <<met');
  push('x');
  assert.equal(sent.join(''), 'a <<b>> and <<metx');
  assert.deepEqual(splitMeta(full), { text, meta: { cards: [{ kind: 'word', en: 'world', zh: ZH }], mistakes: [], journal: false, title: '' } });
  assert.deepEqual(splitMeta('Just text.  '), { text: 'Just text.', meta: null });
  assert.deepEqual(splitMeta('Text.\n<<meta>>{"cards": [oops'), { text: 'Text.', meta: null });
  assert.deepEqual(splitMeta('Text.\n<<meta>>[1, 2]'), { text: 'Text.', meta: null });

  // The checks of the meta against the answer.
  const answer = 'You can say **ship it** or "We roll back the release today." A **rollback** is safe.';
  const meta = merge.cleanMeta({
    cards: [
      { kind: 'word', en: 'rollback', zh: ZH },
      { kind: 'word', en: 'Rollback', zh: ZH }, // the same card again
      { kind: 'sentence', en: 'We roll back the release today.', zh: ZH },
      { kind: 'word', en: 'deploy', zh: ZH }, // not in the answer
      { kind: 'word', en: 'ship it', zh: ZH }, // not a word
      { kind: 'sentence', en: 'ship it', zh: ZH }, // fewer than three words
      { kind: 'word', en: 'safe', zh: '' }, // no meaning
      { kind: 'word', en: 'safe', zh: 'x'.repeat(501) },
      { kind: 'phrase', en: 'safe', zh: ZH },
      'safe',
    ],
    mistakes: ['article', 'article', '', 'x'.repeat(81), 3, 'tense', 'word order', 'plural', 'spelling', 'one too many'],
    journal: 'yes',
  }, answer);
  assert.deepEqual(meta, {
    cards: [{ kind: 'word', en: 'rollback', zh: ZH }, { kind: 'sentence', en: 'We roll back the release today.', zh: ZH }],
    mistakes: ['article', 'tense', 'word order', 'plural', 'spelling'],
  });
  assert.equal(merge.cleanMeta({ cards: Array.from({ length: 8 }, (_, index) => ({ kind: 'word', en: `w${'a'.repeat(index)}`, zh: ZH })) }, Array.from({ length: 8 }, (_, index) => `w${'a'.repeat(index)}`).join(' ')).cards.length, 5);
  assert.deepEqual(merge.cleanMeta('nope', answer), { cards: [], mistakes: [] });
  assert.deepEqual(merge.cleanMeta({ journal: true }, answer), { cards: [], mistakes: [], journal: true });

  // Through the service: the stored and streamed text is without the line; a broken or missing meta names the chat after the question.
  const ctx = setup(t, { answer: () => ['Use **rollback**', ' here.\n<', '<meta>>{"cards":[{"kind":"word","en":"rollback","zh":"', ZH, '"}],"mistakes":["article"],"journal":false,"title":"Rollbacks"}'] });
  const pieces = [];
  const result = await send(ctx, { chat: null, question: 'How do I say it?' }, { onDelta: piece => pieces.push(piece) });
  assert.equal(pieces.join(''), 'Use **rollback** here.');
  assert.ok(!pieces.some(piece => piece.includes('<')));
  assert.equal(result.messages[1].text, 'Use **rollback** here.');
  assert.deepEqual(result.messages[1].cards, [{ kind: 'word', en: 'rollback', zh: ZH, added: false }]);
  assert.deepEqual(result.messages[1].mistakes, ['article']);
  assert.deepEqual(result.messages[0].cards, []);
  assert.equal(result.chat.title, 'Rollbacks');
  assert.equal(messagesOf(ctx.db, result.chat.uid)[1].text, 'Use **rollback** here.');
  // A card added since shows as added.
  ctx.learn.addCard('me', { kind: 'word', en: 'Rollback', zh: ZH, source: 'manual' });
  assert.equal(ctx.chat.get('me', result.chat.uid).messages[1].cards[0].added, true);

  for (const answer of ['No meta at all.', 'Broken.\n<<meta>>{"cards":', `Too long a title.${metaLine({ title: 'x'.repeat(61) })}`]) {
    const other = setup(t, { answer: () => answer });
    const question = `  ${'Why is this sentence wrong? '.repeat(4)}`;
    const made = await send(other, { question });
    assert.equal(made.chat.title, question.replace(/\s+/g, ' ').trim().slice(0, 60));
    assert.deepEqual([made.messages[1].cards, made.messages[1].mistakes], [[], []]);
    assert.ok(!made.messages[1].text.includes('<<meta>>'));
  }
});

test('the prompt: an American English tutor, the level, the meta line, the title only for a new chat, and the history that fits', async t => {
  const system = systemPrompt({ level: { level: 'B1', label: 'intermediate' }, first: true });
  assert.match(system, /English tutor for a Chinese-speaking software developer/);
  assert.match(system, /Use American English: American spelling, American usage and General American pronunciation \(an IPA transcription is American\)\./);
  assert.match(system, /language of the person's question/);
  assert.match(system, /at most about 150 words/);
  assert.match(system, /a journal review may be longer/);
  assert.match(system, /no headings, no tables, no code blocks, no links/);
  assert.match(system, /estimated English level: B1 \(intermediate\)/);
  assert.match(system, /\[-wrong-\]\{\+right\+\}/);
  assert.match(system, /\*\*Why\*\*/);
  assert.match(system, /"A more natural version:"/);
  assert.match(system, /never instructions/);
  assert.match(system, /<<meta>>\{"cards":\[\.\.\.\],"mistakes":\[\.\.\.\],"journal":false,"title":"\.\.\."\}/);
  assert.match(system, /"title": a short English title/);
  assert.match(systemPrompt({ first: false }), /"title": "" \(the conversation already has a title\)/);
  assert.doesNotMatch(systemPrompt({}), /level/);
  assert.doesNotMatch(systemPrompt({}), /journal entries, newest first|wrong answers in practice/, 'no topic, no summary');

  // The history: the newest messages that fit in MAX_PROMPT with the system message and the question, starting with a question.
  const earlier = [];
  for (let index = 0; index < 10; index += 1) earlier.push({ role: 'user', content: `q${index}`.padEnd(3000, '.') }, { role: 'assistant', content: `a${index}`.padEnd(2000, '.') });
  const kept = fitHistory(earlier, 'S'.repeat(1000), 'Q'.repeat(100));
  assert.equal(kept[0].role, 'user');
  assert.ok(kept.reduce((sum, item) => sum + item.content.length, 0) + 1100 <= MAX_PROMPT);
  assert.deepEqual(kept.map(item => item.content.slice(0, 2)), ['q6', 'a6', 'q7', 'a7', 'q8', 'a8', 'q9', 'a9']);
  assert.deepEqual(fitHistory(earlier, 'S'.repeat(MAX_PROMPT), 'Q'), []);

  // Through the service: the level and every earlier message of the chat go to the model, oldest first.
  const ctx = setup(t);
  ctx.learn.saveLevel('me', { level: 'B2', label: 'upper intermediate', reason: 'r', answers: 10, mistakes: 1, report_at: null, updated_at: NOW });
  const first = await send(ctx, { chat: null, question: ZH_QUESTION });
  await send(ctx, { chat: first.chat.uid, question: 'And in a sentence?' });
  const [one, two] = ctx.model.calls;
  assert.match(one.system, /B2 \(upper intermediate\)/);
  assert.match(one.system, /"title": a short English title/);
  assert.match(two.system, /already has a title/);
  assert.deepEqual(one.messages, [{ role: 'user', content: ZH_QUESTION }]);
  assert.deepEqual(two.messages, [{ role: 'user', content: ZH_QUESTION }, { role: 'assistant', content: 'It is a **verb**.' }, { role: 'user', content: 'And in a sentence?' }]);
  assert.deepEqual([one.options.maxTokens, typeof one.options.onDelta], [2000, 'object'], 'no stream asked for without onDelta');
  assert.doesNotMatch(one.system, /2026|\bme\b/, 'no time, no login');
});

test('limits: 100 messages a chat, then 409 before the model; the newest 50 chats that are not journal chats; journal chats are never pruned', async t => {
  const ctx = setup(t);
  const made = await send(ctx, { question: 'First' });
  const uid = made.chat.uid;
  // 96 more messages written straight into the table, then two sends fill it to 100.
  const insert = ctx.db.prepare("INSERT INTO learn_convo_messages (owner, uid, convo_uid, role, text, at) VALUES ('me', ?, ?, ?, 'x', ?)");
  for (let index = 0; index < 96; index += 1) insert.run(`seed-${String(index).padStart(4, '0')}`, uid, index % 2 ? 'assistant' : 'user', NOW + 1 + index);
  await send(ctx, { chat: uid, question: 'Last one' });
  assert.equal(messagesOf(ctx.db, uid).length, MAX_CONVO_MESSAGES);
  const calls = ctx.model.calls.length;
  await assert.rejects(send(ctx, { chat: uid, question: 'One more' }), error => error.statusCode === 409 && error.message === 'This chat is full. Start a new one.');
  assert.equal(ctx.model.calls.length, calls, 'the model was not asked');
  assert.equal(messagesOf(ctx.db, uid).length, MAX_CONVO_MESSAGES, 'nothing pruned');

  // Two journal chats first (the oldest of all), then 52 others: the two oldest others are pruned as tombstones; the journal chats stay.
  const pruning = setup(t, { answer: call => `Fine.${metaLine({ journal: /^Today/.test(call.messages[call.messages.length - 1].content) })}` });
  const journals = [await send(pruning, { question: 'Today I worked from home.' }), await send(pruning, { question: 'Today I fixed a bug.' })];
  assert.ok(journals.every(item => item.chat.journal === true && item.chat.journal_by === 'model'));
  const others = [];
  for (let index = 0; index < MAX_CONVOS + 2; index += 1) others.push(await send(pruning, { question: `Question ${index}` }));
  const rows = convos(pruning.db);
  const alive = rows.filter(row => !row.deleted);
  assert.equal(alive.filter(row => !row.journal).length, MAX_CONVOS);
  assert.equal(alive.filter(row => row.journal).length, 2, 'journal chats are never pruned');
  const pruned = rows.filter(row => row.deleted);
  assert.deepEqual(pruned.map(row => row.uid).sort(), [others[0].chat.uid, others[1].chat.uid].sort());
  assert.ok(pruned.every(row => row.deleted_by === 'prune' && row.deleted_at === row.updated_at + 1 && messagesOf(pruning.db, row.uid).length === 0));
  await assert.rejects(Promise.resolve().then(() => pruning.chat.get('me', others[0].chat.uid)), error => error.statusCode === 404);
  await assert.rejects(send(pruning, { chat: others[0].chat.uid, question: 'Again' }), error => error.statusCode === 404 && error.message === 'Chat not found');
  assert.equal(pruning.chat.list('me').chats.length, MAX_CONVOS + 2);
  assert.equal(pruning.learn.summary('me').chats, MAX_CONVOS + 2, 'the summary counts the chats');
  // A journal chat the person says is not one is pruned when it is too many.
  const patched = pruning.chat.update('me', journals[0].chat.uid, { journal: false });
  assert.equal(patched.chat.deleted, true);
  assert.equal(pruning.chat.list('me').chats.length, MAX_CONVOS + 1);
});

test('the journal flag: set by the model\'s meta, cleared or set by the person, whose choice the model never changes', async t => {
  const ctx = setup(t, { answer: call => `Reviewed.${metaLine({ journal: !/^Why/.test(call.messages[call.messages.length - 1].content), mistakes: ['tense'] })}` });
  const made = await send(ctx, { question: 'Please review my journal entry:\nYesterday I go to the office.' });
  assert.deepEqual([made.chat.journal, made.chat.journal_by], [true, 'model']);
  // A follow-up question that is not an entry does not clear it.
  await send(ctx, { chat: made.chat.uid, question: 'Why "went"?' });
  assert.equal(ctx.chat.get('me', made.chat.uid).chat.journal, true);
  // The person clears it; the next entry leaves it cleared.
  assert.deepEqual(ctx.chat.update('me', made.chat.uid, { journal: false }).chat.journal_by, 'person');
  await send(ctx, { chat: made.chat.uid, question: 'Today I am write code.' });
  assert.deepEqual([ctx.chat.get('me', made.chat.uid).chat.journal, ctx.chat.get('me', made.chat.uid).chat.journal_by], [false, 'person']);
  // A plain chat the person marks.
  const plain = setup(t);
  const other = await send(plain, { question: 'What is a gerund?' });
  assert.deepEqual([other.chat.journal, other.chat.journal_by], [false, '']);
  assert.deepEqual([plain.chat.update('me', other.chat.uid, { journal: true }).chat.journal, convos(plain.db)[0].journal_by], [true, 'person']);
});

test('topics: the journal summary (dates, weekday, part of day, lengths, tags, totals), the mistakes summary, and nothing otherwise', async t => {
  // The parts of the day in the time zone.
  assert.deepEqual(dayParts(Date.UTC(2026, 10, 21, 8, 30), 'UTC'), { date: '2026-11-21', weekday: 'Saturday', part: 'morning' });
  assert.equal(dayParts(Date.UTC(2026, 10, 21, 13), 'UTC').part, 'afternoon');
  assert.equal(dayParts(Date.UTC(2026, 10, 21, 19), 'UTC').part, 'evening');
  assert.equal(dayParts(Date.UTC(2026, 10, 21, 23), 'UTC').part, 'late night');
  assert.equal(dayParts(Date.UTC(2026, 10, 21, 2), 'UTC').part, 'late night');
  assert.deepEqual(dayParts(Date.UTC(2026, 10, 21, 23), 'Asia/Taipei'), { date: '2026-11-22', weekday: 'Sunday', part: 'morning' });

  // What asks for a topic.
  assert.deepEqual(topicsOf('How is my journaling going?', 'journal'), ['journal']);
  assert.deepEqual(topicsOf('Is my diary habit good?', undefined), ['journal']);
  assert.deepEqual(topicsOf(ZH_DIARY, undefined), ['journal']);
  assert.deepEqual(topicsOf('Which words do I keep getting wrong?', undefined), ['mistakes']);
  assert.deepEqual(topicsOf(ZH_MISTAKES, undefined), ['mistakes']);
  assert.deepEqual(topicsOf('What is a gerund?', undefined), []);
  assert.deepEqual(topicsOf('Please review my journal entry:\nToday my habit was wrong.', undefined), [], 'an entry for review is not a question about the habit');
  assert.deepEqual(topicsOf(`My journal: ${'word '.repeat(120)}`, undefined), [], 'a long text is not a question');

  // The summary itself, with totals.
  const at = (day, hour) => Date.UTC(2026, 10, day, hour);
  const summary = journalSummary([
    { at: at(1, 8), words: 40, mistakes: ['tense', 'article'] },
    { at: at(3, 23), words: 60, mistakes: ['tense'] },
    { at: at(8, 13), words: 80, mistakes: ['article'] },
    { at: at(15, 19), words: 100, mistakes: ['plural'] },
    { at: at(18, 9), words: 120, mistakes: [] },
    { at: at(20, 20), words: 140, mistakes: ['plural'] },
  ], { now: NOW, timeZone: TZ });
  assert.equal(summary.entries, 6);
  assert.deepEqual([summary.first_date, summary.last_date], ['2026-11-01', '2026-11-20']);
  assert.equal(summary.entries_per_week, Math.round((6 / ((at(20, 20) - at(1, 8)) / (7 * DAY))) * 10) / 10);
  assert.equal(summary.entries_last_4_weeks, 6);
  assert.equal(summary.average_words, 90);
  assert.deepEqual(summary.by_month, [{ month: '2026-11', entries: 6, average_words: 90 }]);
  assert.deepEqual(summary.common_mistakes, [{ tag: 'article', count: 2 }, { tag: 'plural', count: 2 }, { tag: 'tense', count: 2 }]);
  assert.deepEqual(summary.mistakes_gone_in_last_4, ['tense'], 'tense is not in the newest 4');
  assert.deepEqual(summary.list[0], { date: '2026-11-20', weekday: 'Friday', part: 'evening', words: 140, mistakes: ['plural'] });
  assert.deepEqual(summary.list[4], { date: '2026-11-03', weekday: 'Tuesday', part: 'late night', words: 60, mistakes: ['tense'] });
  assert.deepEqual(journalSummary([], { now: NOW, timeZone: TZ }), { entries: 0, note: 'No journal entries yet.' });
  assert.equal(journalSummary(Array.from({ length: 70 }, (_, index) => ({ at: NOW - index * DAY, words: 1, mistakes: [] })), { now: NOW, timeZone: TZ }).list.length, 60);

  // Through the service: two journal chats (one marked by the person without a flagged entry), a plain chat; asking about the journal adds the summary.
  const ctx = setup(t, {
    answer: call => {
      const last = call.messages[call.messages.length - 1].content;
      return `OK.${metaLine({ journal: /^Please review/.test(last), mistakes: /go/.test(last) ? ['past tense'] : [] })}`;
    },
    now: Date.UTC(2026, 10, 19, 0, 0), // the hybrid clock never goes back: the test starts before the entries
  });
  ctx.clock.now = Date.UTC(2026, 10, 19, 22, 30); // Thursday, late night
  await ctx.chat.send('me', { question: 'Please review my journal entry:\nYesterday I go to the office and fix two bugs.' });
  ctx.clock.now = Date.UTC(2026, 10, 20, 7, 0); // Friday, morning
  const marked = await ctx.chat.send('me', { question: 'I wrote some lines today about work.' });
  ctx.chat.update('me', marked.chat.uid, { journal: true });
  ctx.clock.now = NOW;
  await ctx.chat.send('me', { question: 'What is a gerund?' });
  assert.doesNotMatch(ctx.model.calls[2].system, /journal entries, newest first|wrong answers in practice/, 'nothing when not asked');
  await ctx.chat.send('me', { question: 'How is my journaling going?', topic: 'journal' });
  const journalPrompt = ctx.model.calls[3].system;
  const json = JSON.parse(journalPrompt.split('\n').find(line => line.startsWith('{"entries"')));
  assert.equal(json.entries, 2);
  assert.deepEqual(json.list, [
    { date: '2026-11-20', weekday: 'Friday', part: 'morning', words: 7, mistakes: [] },
    { date: '2026-11-19', weekday: 'Thursday', part: 'late night', words: 10, mistakes: ['past tense'] },
  ]);
  assert.doesNotMatch(journalPrompt, /wrong answers in practice/);
  assert.doesNotMatch(journalPrompt, /office|bugs/, 'the summary has no text of the entries');

  // The mistakes summary: the cards of the recent wrong answers with their tags and the newest report's summary; no times.
  const card = ctx.learn.addCard('me', { kind: 'word', en: 'receive', zh: ZH, source: 'manual' }).card;
  const sentence = ctx.learn.addCard('me', { kind: 'sentence', en: 'We deploy the new version today.', zh: ZH, source: 'manual' }).card;
  ctx.learn.answer('me', card.id, { mode: 'spell', grade: 'again', correct: false, answer: 'recieve', tag: 'letter-order' });
  ctx.learn.answer('me', card.id, { mode: 'spell', grade: 'again', correct: false, answer: 'receve', tag: 'missing-letter' });
  ctx.learn.answer('me', sentence.id, { mode: 'build', grade: 'again', correct: false, answer: 'We deploys', tag: 'verb-form' });
  ctx.learn.answer('me', sentence.id, { mode: 'build', grade: 'good', correct: true });
  ctx.db.prepare(`INSERT INTO learn_reports (owner, uid, created_at, covers_from, covers_until, body) VALUES ('me', 'report-0001', 1, 0, 1, ?)`)
    .run(JSON.stringify({ summary: 'You mix up ie and ei.', kinds: [], findings: [] }));
  await ctx.chat.send('me', { question: 'Words I keep getting wrong', topic: 'mistakes' });
  const mistakesPrompt = ctx.model.calls[4].system;
  const data = JSON.parse(mistakesPrompt.split('\n').find(line => line.startsWith('{"wrong_answers"')));
  assert.deepEqual(data, {
    wrong_answers: 3,
    cards: [{ kind: 'sentence', text: 'We deploy the new version today.', wrong: 1, tags: { 'verb-form': 1 } }, { kind: 'word', text: 'receive', wrong: 2, tags: { 'missing-letter': 1, 'letter-order': 1 } }],
    report: 'You mix up ie and ei.',
  });
  assert.doesNotMatch(mistakesPrompt, /journal entries, newest first/);
  assert.doesNotMatch(mistakesPrompt, /recieve|2026/, 'no written answer, no time');
  // A typed question in Chinese asks the same.
  await ctx.chat.send('me', { question: ZH_MISTAKES });
  assert.match(ctx.model.calls[5].system, /wrong answers in practice/);
  await assert.rejects(ctx.chat.send('me', { question: 'Hi', topic: 'weather' }), error => error.statusCode === 400 && error.message === 'Unknown chat topic');
});

test('the checks come before the model; a failed or cancelled send stores nothing; one answer at a time per chat; the rate limit', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ctx = setup(t, { gate, rateLimit: RATE_LIMIT });
  const refused = async (body, status, message) => {
    await assert.rejects(ctx.chat.send('me', body), error => error.statusCode === status && error.message === message);
  };
  await refused(null, 400, 'Invalid question');
  await refused({ question: '  ' }, 400, 'Enter your question');
  await refused({ question: 'x'.repeat(4001) }, 400, 'The question cannot exceed 4000 characters');
  await refused({ chat: 'not a uid!', question: 'Hi' }, 404, 'Chat not found');
  await refused({ chat: '00000000-0000-0000-0000-000000000000', question: 'Hi' }, 404, 'Chat not found');
  ctx.state.configured = false;
  await refused({ question: 'Hi' }, 503, 'Translation service not configured yet');
  assert.equal(ctx.chat.list('me').translator, false);
  ctx.state.configured = true;
  assert.equal(ctx.model.calls.length, 0);

  // One answer at a time in a chat: the first is held open by the gate (a question of 4000 characters is fine).
  const first = ctx.chat.send('me', { question: 'x'.repeat(4000) }, { onChat: chat => { ctx.firstChat = chat; } });
  assert.equal(ctx.firstChat.title, '', 'the chat before it is named');
  assert.equal(ctx.chat.running('me', ctx.firstChat.uid), true);
  assert.equal(convos(ctx.db).length, 0, 'a new chat is stored only with its answer');
  release();
  const made = await first;
  assert.equal(made.chat.uid, ctx.firstChat.uid);
  // The same in an existing chat: a second send while the first is being answered is refused.
  const busyCtx = setup(t);
  const started = await busyCtx.chat.send('me', { question: 'Start' });
  let unblock;
  const slow = createLearnChat({
    db: busyCtx.db, learn: busyCtx.learn, isConfigured: () => true, now: () => busyCtx.clock.now, timeZone: TZ,
    converse: async () => { await new Promise(resolve => { unblock = resolve; }); return 'Done.'; },
  });
  const pending = slow.send('me', { chat: started.chat.uid, question: 'Slow' });
  await assert.rejects(slow.send('me', { chat: started.chat.uid, question: 'Again' }), error => error.statusCode === 409 && error.message === 'Another question in this chat is being answered');
  await new Promise(resolve => setImmediate(resolve));
  unblock();
  await pending;
  assert.equal(messagesOf(busyCtx.db, started.chat.uid).length, 4);

  // The model fails after its first piece, or the send is cancelled: nothing is stored.
  const failing = setup(t, { fail: () => true });
  await assert.rejects(failing.chat.send('me', { question: 'Hi' }, { onDelta() {} }), error => error.statusCode === 502);
  const controller = new AbortController();
  await assert.rejects(failing.chat.send('me', { question: 'Hi' }, { signal: controller.signal, onDelta: () => controller.abort() }), error => error.statusCode === 499);
  assert.equal(convos(failing.db).length, 0);
  // An answer that is only the meta line is no answer.
  const empty = setup(t, { answer: () => metaLine() });
  await assert.rejects(empty.chat.send('me', { question: 'Hi' }), error => error.statusCode === 502 && error.message === 'The model gave no answer');

  // At most RATE_LIMIT sends a minute per owner, on a fake clock.
  const busy = setup(t, { rateLimit: RATE_LIMIT });
  for (let index = 0; index < RATE_LIMIT; index += 1) { busy.clock.now += 100; await busy.chat.send('me', { question: `Q${index}` }); }
  await assert.rejects(busy.chat.send('me', { question: 'One more' }), error => error.statusCode === 429 && error.message === 'Too many questions in a minute. Wait a moment and ask again.');
  busy.clock.now += RATE_WINDOW_MS;
  await busy.chat.send('me', { question: 'Later' });
});

test('PATCH and DELETE: the title and the journal flag by the person; a delete leaves a tombstone without messages', async t => {
  const ctx = setup(t);
  const made = await send(ctx, { question: 'What is a gerund?' });
  const uid = made.chat.uid;
  for (const [body, message] of [
    [null, 'Invalid chat change'], [{}, 'Invalid chat change'], [{ colour: 'red' }, 'Invalid chat change'], [{ journal: 'yes' }, 'Invalid chat change'],
    [{ title: '' }, 'A chat title has 1 to 60 characters'], [{ title: 'x'.repeat(61) }, 'A chat title has 1 to 60 characters'], [{ title: 5 }, 'A chat title has 1 to 60 characters'],
  ]) assert.throws(() => ctx.chat.update('me', uid, body), error => error.statusCode === 400 && error.message === message, JSON.stringify(body));
  assert.throws(() => ctx.chat.update('me', 'missing-uid', { title: 'x' }), error => error.statusCode === 404);
  const before = convos(ctx.db)[0];
  const renamed = ctx.chat.update('me', uid, { title: '  Gerunds   and infinitives ' });
  assert.equal(renamed.chat.title, 'Gerunds and infinitives');
  const after = convos(ctx.db)[0];
  assert.ok(after.title_at > before.title_at && after.sync_seq > before.sync_seq);
  assert.equal(after.journal_by, '', 'the flag is untouched by a rename');
  // A new answer keeps the person's title.
  await send(ctx, { chat: uid, question: 'More?' });
  assert.equal(ctx.chat.get('me', uid).chat.title, 'Gerunds and infinitives');
  assert.equal(ctx.chat.get('me', uid).chat.count, 4);

  assert.deepEqual(ctx.chat.remove('me', uid), { ok: true });
  const tomb = convos(ctx.db)[0];
  assert.deepEqual([tomb.deleted, tomb.deleted_by, tomb.deleted_at > tomb.updated_at], [1, 'person', true]);
  assert.equal(messagesOf(ctx.db, uid).length, 0);
  assert.equal(ctx.chat.list('me').chats.length, 0);
  assert.equal(ctx.learn.summary('me').chats, 0);
  assert.throws(() => ctx.chat.remove('me', uid), error => error.statusCode === 404);
  assert.throws(() => ctx.chat.get('me', uid), error => error.statusCode === 404);
});

async function serve(t, ctx, chat = ctx.chat) {
  const app = express();
  app.use(express.json());
  app.use('/api/learn', createLearnRouter({ service: ctx.learn, chat, sync: null, analysis: null, pick: null, ask: null, requireAuth: (req, res, next) => { req.session = { user: { login: 'me' } }; next(); }, clientOrigin: (req, res, next) => next() }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api/learn`;
  const call = async (method, url, body, options = {}) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), ...options });
    const text = await response.text();
    const type = response.headers.get('content-type') || '';
    return { status: response.status, type, body: /ndjson/.test(type) ? text.split('\n').filter(Boolean).map(line => JSON.parse(line)) : (text ? JSON.parse(text) : null) };
  };
  call.base = base;
  return call;
}

test('the routes: the list, a chat, a send as NDJSON (the chat first, deltas, done), refusals as JSON, an error line, PATCH, DELETE, the summary', async t => {
  const ctx = setup(t, {
    answer: call => (call.messages[call.messages.length - 1].content === 'Break' ? ['Part', ' two'] : ['A **gerund** is', ' a verb used as a noun.', metaLine({ title: 'Gerunds', cards: [{ kind: 'word', en: 'gerund', zh: ZH }] })]),
    fail: call => call.messages[call.messages.length - 1].content === 'Break',
  });
  const call = await serve(t, ctx);
  assert.deepEqual((await call('GET', '/chats')).body, { chats: [], translator: true });

  const sent = await call('POST', '/chats/send', { chat: null, question: 'What is a gerund?' });
  assert.equal(sent.status, 200);
  assert.match(sent.type, /^application\/x-ndjson/);
  const [head, ...rest] = sent.body;
  assert.deepEqual(Object.keys(head), ['chat']);
  assert.deepEqual([head.chat.title, head.chat.count, head.chat.journal], ['', 0, false]);
  assert.match(head.chat.uid, /^[0-9a-f-]{36}$/);
  assert.deepEqual(rest.slice(0, 2), [{ delta: 'A **gerund** is' }, { delta: ' a verb used as a noun.' }]);
  const done = rest[2];
  assert.equal(rest.length, 3);
  assert.equal(done.done, true);
  assert.deepEqual([done.chat.uid, done.chat.title, done.chat.count], [head.chat.uid, 'Gerunds', 2]);
  assert.deepEqual(done.messages.map(item => [item.role, item.text]), [['user', 'What is a gerund?'], ['assistant', 'A **gerund** is a verb used as a noun.']]);
  assert.deepEqual(done.messages[1].cards, [{ kind: 'word', en: 'gerund', zh: ZH, added: false }]);
  const uid = head.chat.uid;

  const listed = (await call('GET', '/chats')).body;
  assert.deepEqual(listed.chats, [done.chat]);
  assert.deepEqual(Object.keys(listed.chats[0]), ['uid', 'title', 'journal', 'journal_by', 'created_at', 'updated_at', 'count']);
  const opened = (await call('GET', `/chats/${uid}`)).body;
  assert.deepEqual(opened, { chat: done.chat, messages: done.messages });
  assert.equal((await call('GET', '/chats/nope-nope-nope')).status, 404);
  // Adding a chip's card is the existing route; the chip then shows as added.
  const added = await call('POST', '/cards', { kind: 'word', en: 'gerund', zh: ZH, context: 'A gerund is a verb used as a noun.' });
  assert.equal(added.status, 200);
  assert.equal(added.body.card.source, 'manual');
  assert.equal((await call('GET', `/chats/${uid}`)).body.messages[1].cards[0].added, true);

  for (const [body, status, error] of [
    [{ chat: null, question: '' }, 400, 'Enter your question'],
    [{ chat: null, question: 'Hi', topic: 'weather' }, 400, 'Unknown chat topic'],
    [{ chat: 'aaaaaaaa-0000', question: 'Hi' }, 404, 'Chat not found'],
  ]) {
    const refused = await call('POST', '/chats/send', body);
    assert.deepEqual([refused.status, refused.body], [status, { error }]);
    assert.match(refused.type, /application\/json/);
  }
  ctx.state.configured = false;
  const off = await call('POST', '/chats/send', { chat: uid, question: 'Hi' });
  assert.deepEqual([off.status, off.body], [503, { error: 'Translation service not configured yet' }]);
  ctx.state.configured = true;
  // A full chat: 409 with the message.
  const insert = ctx.db.prepare("INSERT INTO learn_convo_messages (owner, uid, convo_uid, role, text, at) VALUES ('me', ?, ?, 'user', 'x', ?)");
  const full = await call('POST', '/chats/send', { chat: null, question: 'Another' });
  const fullUid = full.body[0].chat.uid;
  for (let index = 0; index < 97; index += 1) insert.run(`fill-${String(index).padStart(4, '0')}`, fullUid, NOW + index);
  const refusedFull = await call('POST', '/chats/send', { chat: fullUid, question: 'More' });
  assert.deepEqual([refusedFull.status, refusedFull.body], [409, { error: 'This chat is full. Start a new one.' }]);

  const broken = await call('POST', '/chats/send', { chat: uid, question: 'Break' });
  assert.equal(broken.status, 200);
  assert.deepEqual(broken.body, [{ chat: { ...done.chat, count: 2 } }, { delta: 'Part' }, { error: 'DeepSeek returned an error (HTTP 500)', status: 502 }]);
  assert.equal(messagesOf(ctx.db, uid).length, 2, 'nothing stored for the broken answer');

  const patched = await call('PATCH', `/chats/${uid}`, { title: 'Grammar', journal: true });
  assert.equal(patched.status, 200);
  assert.deepEqual([patched.body.chat.title, patched.body.chat.journal, patched.body.chat.journal_by], ['Grammar', true, 'person']);
  assert.deepEqual((await call('PATCH', `/chats/${uid}`, { title: '' })).status, 400);
  assert.equal((await call('GET', '/summary')).body.chats, 2);
  assert.deepEqual((await call('DELETE', `/chats/${uid}`)).body, { ok: true });
  assert.equal((await call('DELETE', `/chats/${uid}`)).status, 404);
  assert.equal((await call('GET', '/summary')).body.chats, 1);

  // A model that fails before its first piece: the usual JSON error, nothing stored.
  const early = setup(t);
  const earlyChat = createLearnChat({ db: early.db, learn: early.learn, isConfigured: () => true, timeZone: TZ,
    converse: async () => { throw Object.assign(new Error('The DeepSeek API key is invalid or lacks permission'), { statusCode: 502 }); } });
  const earlyCall = await serve(t, early, earlyChat);
  const refusedEarly = await earlyCall('POST', '/chats/send', { chat: null, question: 'Hi' });
  assert.deepEqual([refusedEarly.status, refusedEarly.body], [502, { error: 'The DeepSeek API key is invalid or lacks permission' }]);
  assert.equal(convos(early.db).length, 0);
  // Without the service at all: 503.
  const none = await serve(t, early, null);
  assert.equal((await none('GET', '/chats')).status, 503);
});

test('the routes: a page that goes away mid-answer cancels the model\'s call, and nothing is stored', async t => {
  let cancelled = null;
  const seen = new Promise(resolve => { cancelled = resolve; });
  const ctx = setup(t);
  const chat = createLearnChat({
    db: ctx.db, learn: ctx.learn, isConfigured: () => true, timeZone: TZ,
    converse: async (owner, system, messages, options) => {
      options.onDelta('Start');
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      cancelled(true);
      throw Object.assign(new Error('The question was cancelled'), { statusCode: 499 });
    },
  });
  const call = await serve(t, ctx, chat);
  const controller = new AbortController();
  const response = await fetch(`${call.base}/chats/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat: null, question: 'Hi' }), signal: controller.signal,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let first = '';
  while ((first.match(/\n/g) || []).length < 2) first += decoder.decode((await reader.read()).value);
  const lines = first.split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(lines[0].chat && lines[0].chat.uid);
  assert.deepEqual(lines[1], { delta: 'Start' });
  controller.abort();
  assert.equal(await seen, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(convos(ctx.db).length, 0);
  assert.equal(chat.running('me', lines[0].chat.uid), false);
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
  const model = stubModel({ answer: call => `Answer on ${name} to ${call.messages[call.messages.length - 1].content}.${metaLine({ title: `Made on ${name}`, journal: /^Today/.test(call.messages[call.messages.length - 1].content) })}` });
  const chat = createLearnChat({ db, learn, sync, converse: model.converse, isConfigured: () => true, now: () => clock.now, timeZone: TZ, rateLimit: 1000 });
  return { db, clock, learn, sync, chat, instanceId, name };
}
const exchange = (from, to) => to.sync.applyPage(from.sync.exportPage(0, 1000), from.instanceId, { bump: true });
const both = (A, B) => exchange(A, B) + exchange(B, A);
const textsOf = (side, uid) => messagesOf(side.db, uid).map(row => `${row.role}:${row.text}`);
const stateOf = (side, uid) => {
  const row = side.db.prepare("SELECT title, title_at, journal, journal_by, journal_at, created_at, updated_at, deleted, deleted_at, deleted_by FROM learn_convos WHERE owner = 'me' AND uid = ?").get(uid);
  return row ? { ...row } : null;
};

test('sync: chats and messages reach the other engine (a union by uid), titles and journal flags by their clocks, tombstones, a chat brought back', async t => {
  const A = syncSide(t, 'A', 'engine-a');
  const B = syncSide(t, 'B', 'engine-b');
  A.clock.now += 1000;
  const made = await A.chat.send('me', { question: 'Hello' });
  const uid = made.chat.uid;
  assert.ok(exchange(A, B) > 0);
  assert.deepEqual(textsOf(B, uid), ['user:Hello', 'assistant:Answer on A to Hello.']);
  assert.deepEqual(B.chat.get('me', uid).chat, made.chat, 'the same chat');
  assert.equal(B.chat.get('me', uid).messages[1].text, 'Answer on A to Hello.');
  assert.equal(B.db.prepare("SELECT by FROM learn_convos WHERE uid = ?").pluck().get(uid), 'engine-a');
  assert.equal(exchange(A, B), 0, 'nothing changes the second time');

  // Both write while apart: the messages are a union, in the order of the hybrid clock, on both sides; updated_at is the newest.
  A.clock.now = NOW + 10_000;
  B.clock.now = NOW + 20_000;
  await A.chat.send('me', { chat: uid, question: 'From A' });
  await B.chat.send('me', { chat: uid, question: 'From B' });
  both(A, B);
  assert.deepEqual(textsOf(A, uid), textsOf(B, uid));
  assert.deepEqual(textsOf(A, uid).filter(item => item.startsWith('user:')), ['user:Hello', 'user:From A', 'user:From B']);
  assert.deepEqual(stateOf(A, uid), stateOf(B, uid));

  // The title: the newer rename wins on both sides.
  A.clock.now += 1000;
  A.chat.update('me', uid, { title: 'Older name' });
  B.clock.now += 5000;
  B.chat.update('me', uid, { title: 'Newer name' });
  both(A, B);
  assert.equal(A.chat.get('me', uid).chat.title, 'Newer name');
  assert.deepEqual(stateOf(A, uid), stateOf(B, uid));

  // The journal flag: the person's choice wins over the model's even when the model's is newer; between two choices of the person the newer.
  A.clock.now += 1000;
  A.chat.update('me', uid, { journal: false }); // the person, earlier
  B.clock.now += 5000;
  await B.chat.send('me', { chat: uid, question: 'Today I wrote tests.' }); // the model marks it, later
  assert.equal(stateOf(B, uid).journal_by, 'model');
  both(A, B);
  assert.deepEqual([stateOf(A, uid).journal, stateOf(A, uid).journal_by], [0, 'person']);
  assert.deepEqual(stateOf(A, uid), stateOf(B, uid));
  B.clock.now += 1000;
  B.chat.update('me', uid, { journal: true });
  both(A, B);
  assert.deepEqual([stateOf(A, uid).journal, stateOf(A, uid).journal_by], [1, 'person']);

  // A delete wins over everything older: the tombstone travels and the messages go.
  const other = await A.chat.send('me', { question: 'Second chat' });
  both(A, B);
  B.clock.now = Math.max(A.clock.now, B.clock.now) + 1000;
  B.chat.remove('me', other.chat.uid);
  exchange(B, A);
  assert.deepEqual([stateOf(A, other.chat.uid).deleted, stateOf(A, other.chat.uid).deleted_by], [1, 'person']);
  assert.equal(messagesOf(A.db, other.chat.uid).length, 0);
  assert.equal(A.chat.list('me').chats.some(item => item.uid === other.chat.uid), false);
  assert.equal(both(A, B), 0);

  // A message written on A after B deleted the chat (A had not seen the delete): newer than the tombstone, so the chat comes back on both, whole.
  const third = await A.chat.send('me', { question: 'Third chat' });
  both(A, B);
  B.clock.now = A.clock.now + 1000;
  B.chat.remove('me', third.chat.uid); // at B's clock
  A.clock.now = B.clock.now + 5000;
  await A.chat.send('me', { chat: third.chat.uid, question: 'Still here?' }); // later on A's clock
  exchange(B, A); // A gets the older tombstone: it stays, and its messages are sent again
  assert.equal(stateOf(A, third.chat.uid).deleted, 0);
  exchange(A, B);
  assert.equal(stateOf(B, third.chat.uid).deleted, 0, 'B has it again');
  assert.deepEqual(textsOf(B, third.chat.uid), textsOf(A, third.chat.uid));
  assert.equal(textsOf(B, third.chat.uid).length, 4, 'with the messages B had removed');
  assert.deepEqual(stateOf(A, third.chat.uid), stateOf(B, third.chat.uid));
  assert.equal(both(A, B), 0, 'and then it is quiet');

  // Rows that do not check are not applied; an older peer's page without the chats is fine.
  assert.equal(B.sync.applyPage({ convos: [{ uid: 'bad uid!' }, { ...merge.convoToPeer(stateOf(A, uid), 'engine-a'), uid: 'conv-0001', journal_by: 'robot' }] }, 'engine-z'), 0);
  assert.equal(B.sync.applyPage({ convo_messages: [{ uid: 'msg-00001', convo_uid: 'unknown-0001', role: 'user', text: 'x', at: 5 }] }, 'engine-z'), 0, 'a message without its chat waits');
  assert.equal(merge.convoMessageFromPeer({ uid: 'msg-00002', convo_uid: uid, role: 'assistant', text: 'y'.repeat(7000), at: 5 }, 'engine-z').text.length, 6000);
  assert.equal(merge.convoMessageFromPeer({ uid: 'msg-00003', convo_uid: uid, role: 'user', text: 'y'.repeat(7000), at: 5 }, 'engine-z').text.length, 4000);
  assert.equal(merge.convoMessageFromPeer({ uid: 'msg-00004', convo_uid: uid, role: 'system', text: 'y', at: 5 }, 'engine-z'), null);
  const { convos: _convos, convo_messages: _messages, ...older } = A.sync.exportPage(0, 1000);
  assert.ok(_convos.length > 0 && _messages.length > 0);
  assert.equal(B.sync.applyPage(older, A.instanceId), 0);
  // A company computer's pull (cards only) carries no chats.
  assert.deepEqual([A.sync.exportPage(0, 1000, { reviews: false }).convos.length, A.sync.exportPage(0, 1000, { reviews: false }).convo_messages.length], [0, 0]);
});

test('sync: after a merge the same newest 50 chats that are not journal chats are kept on both engines; journal chats are never pruned', async t => {
  const A = syncSide(t, 'A', 'engine-a');
  const B = syncSide(t, 'B', 'engine-b');
  // A journal chat on A, older than everything; then 30 chats on each side, interleaved in time.
  A.clock.now = NOW;
  const journal = await A.chat.send('me', { question: 'Today I learned about pruning.' });
  assert.equal(journal.chat.journal, true);
  for (let index = 0; index < 30; index += 1) {
    A.clock.now = NOW + 1000 + index * 20;
    B.clock.now = NOW + 1010 + index * 20;
    await A.chat.send('me', { question: `A${index}` });
    await B.chat.send('me', { question: `B${index}` });
  }
  both(A, B);
  exchange(A, B);
  const aliveOf = side => side.db.prepare("SELECT uid FROM learn_convos WHERE owner = 'me' AND deleted = 0 ORDER BY uid").pluck().all();
  assert.deepEqual(aliveOf(A), aliveOf(B));
  assert.equal(aliveOf(A).length, MAX_CONVOS + 1);
  assert.ok(aliveOf(A).includes(journal.chat.uid), 'the journal chat stays');
  const prunedTitles = A.db.prepare("SELECT c.uid FROM learn_convos c WHERE c.deleted = 1 AND c.deleted_by = 'prune'").pluck().all();
  assert.equal(prunedTitles.length, 10);
  assert.ok(prunedTitles.every(uid => messagesOf(A.db, uid).length === 0 && messagesOf(B.db, uid).length === 0));
  assert.equal(both(A, B), 0, 'quiet after the prune');
  // A new message in a pruned chat on one side (it had not seen the prune) brings it back on both; the next oldest is pruned instead.
  const pruned = A.db.prepare("SELECT uid, updated_at FROM learn_convos WHERE deleted = 1 ORDER BY updated_at DESC LIMIT 1").get();
  const C = syncSide(t, 'C', 'engine-c');
  C.sync.applyPage({ ...A.sync.exportPage(0, 1000), convos: [], convo_messages: [] }, A.instanceId);
  // C had the chat from before the prune: give it the chat and its messages as they were, then write in it.
  C.db.prepare(`INSERT INTO learn_convos (owner, uid, title, title_at, created_at, updated_at, by, sync_seq) VALUES ('me', ?, 'Old', 1, ?, ?, 'engine-a', 1)`).run(pruned.uid, pruned.updated_at, pruned.updated_at);
  C.clock.now = A.clock.now + 1000;
  await C.chat.send('me', { chat: pruned.uid, question: 'Back again' });
  exchange(C, A);
  exchange(A, B);
  assert.equal(stateOf(A, pruned.uid).deleted, 0);
  assert.equal(stateOf(B, pruned.uid).deleted, 0);
  assert.deepEqual(aliveOf(A), aliveOf(B));
  assert.equal(aliveOf(A).length, MAX_CONVOS + 1);
});
