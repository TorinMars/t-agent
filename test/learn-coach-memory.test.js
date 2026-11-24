// Learn: the English coach's memory and its sync ("Memory", "Rolling summary" and "Sync" in docs/design/learn-english-coach.md;
// services/learn-coach.js, services/learn-merge.js, services/learn-sync.js): the notes (40 at most, the secrets filter, the end date, the newest 20
// in the prompt in a stable order), their merge (newer wins, a tombstone wins a tie), the summary (fold after the answer, facts only, the window
// that moves only with a fold, reset), its merge, and two databases: the coach conversation, practice messages, proposal states, notes and the
// summary reach the other engine; the coach is never pruned with the chats.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-coach-memory-data-'));
delete process.env.TAGENT_HOME;
const Database = require('better-sqlite3');
const { createLearn } = require('../services/learn');
const { createLearnSync } = require('../services/learn-sync');
const merge = require('../services/learn-merge');
const syncStore = require('../services/learn-sync-store');
const { createLearnCoach, MAX_NOTES, HISTORY } = require('../services/learn-coach');

const NOW = Date.UTC(2026, 10, 24, 4, 0, 0);
const TZ = 'UTC';

function database(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-coach-memory-'));
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}
const meta = '\n<<meta>>{"cards":[],"mistakes":[],"suggestions":[]}';

function side(t, { name = 'A', instanceId = 'engine-a', script = null, fold = null } = {}) {
  const db = database(t);
  const clock = { now: NOW };
  const learn = createLearn({ db, now: () => clock.now, timeZone: TZ, lookupWord: null, lookupPhonetic: () => '' });
  learn.saveSettings('me', { starter: null });
  const sync = createLearnSync({
    db, identity: () => ({ instance_id: instanceId, name }), owner: () => 'me', learn, now: () => clock.now, timeZone: TZ,
    linkKeys: { publicKey: () => 'x', linkKey: () => Buffer.alloc(32) }, log: { warn() {}, info() {} }, intervalMs: 0,
  });
  const requests = [];
  const folds = [];
  const coach = createLearnCoach({
    db, learn, sync, timeZone: TZ, now: () => clock.now, isConfigured: () => true, activeModel: () => ({ provider: 'stub', model: 'x' }),
    converse: async (owner, system, messages, options) => { folds.push({ system, messages, options }); return fold ? fold(messages) : `Summary ${folds.length}: the person practises spelling.`; },
    converseTools: async (owner, system, messages, options) => {
      requests.push({ system, messages, options });
      const step = script ? script({ system, messages, options }, requests.length - 1) : null;
      if (step) return step;
      const text = `Answer on ${name}.${meta}`;
      if (options.onDelta) options.onDelta(text);
      return { content: text, toolCalls: [] };
    },
  });
  return { db, clock, learn, sync, coach, requests, folds, instanceId, name };
}
const rememberScript = texts => (request, index) => (index === 0 ? { content: '', toolCalls: texts.map((text, at) => ({ id: `call_${at}`, name: 'remember', arguments: JSON.stringify(typeof text === 'string' ? { text } : text) })) } : null);
const toolResults = request => request.messages.filter(item => item.role === 'tool').map(item => JSON.parse(item.content));

test('notes: at most 40 live notes (a 41st is refused to the model), secrets are never kept, an end date ends a note in the prompt', async t => {
  const ctx = side(t, { script: rememberScript(['Goal: spoken English for meetings', { text: 'Interview on 2026-12-01', until: '2026-12-01' }, { text: 'Old plan', until: '2026-11-01' }]) });
  await ctx.coach.send('me', { text: 'Remember these' });
  assert.equal(ctx.coach.notes('me').notes.length, 3);
  ctx.requests.length = 0;
  await ctx.coach.send('me', { text: 'Next' });
  assert.match(ctx.requests[0].system, /- Goal: spoken English for meetings\n- Interview on 2026-12-01 \(until 2026-12-01\)/);
  assert.doesNotMatch(ctx.requests[0].system, /Old plan/, 'past its day: not in the prompt (still listed)');

  for (let index = ctx.coach.notes('me').notes.length; index < MAX_NOTES; index += 1) {
    ctx.db.prepare("INSERT INTO learn_coach_notes (owner, uid, text, created_at, updated_at) VALUES ('me', ?, ?, ?, ?)").run(`fill-${String(index).padStart(5, '0')}`, `Note ${index}`, NOW + index, NOW + index);
  }
  const again = createLearnCoach({
    db: ctx.db, learn: ctx.learn, timeZone: TZ, now: () => ctx.clock.now, isConfigured: () => true, converse: async () => '',
    converseTools: async (owner, system, messages) => (messages.some(item => item.role === 'tool') ? { content: `Ok.${meta}`, toolCalls: [] } : { content: '', toolCalls: [{ id: 'call_n', name: 'remember', arguments: '{"text":"One more"}' }] }),
  });
  const seen = [];
  await again.send('me', { text: 'Remember one more' }, { onEvent: line => seen.push(line) });
  assert.equal(seen.filter(line => line.type === 'remembered').length, 0);
  assert.equal(again.notes('me').notes.length, MAX_NOTES);

  // The prompt has the newest 20 live notes, oldest first, the same order every time.
  const prompt = (await (async () => { const requests = []; const probe = createLearnCoach({ db: ctx.db, learn: ctx.learn, timeZone: TZ, now: () => ctx.clock.now, isConfigured: () => true, converse: async () => '', converseTools: async (o, system) => { requests.push(system); return { content: `Ok.${meta}`, toolCalls: [] }; } }); await probe.send('me', { text: 'a' }); await probe.send('me', { text: 'b' }); return requests; })());
  assert.equal(prompt[0], prompt[1]);
  const listed = prompt[0].split('\n').filter(line => line.startsWith('- Note '));
  assert.ok(listed.length <= 20 && listed.length > 10);
  assert.equal(listed[listed.length - 1], '- Note 39', 'the newest last');
});

test('the secrets filter and the note checks', () => {
  for (const secret of ['My password is hunter2', 'pwd: 1234', 'api key sk-abcdef1234567890', 'token ghp_abcdefghijklmnop1234', 'card 4111 1111 1111 1111',
    'AKIAABCDEFGHIJKLMNOP', 'secret: xyz', '-----BEGIN PRIVATE KEY-----', 'aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgc3RyaW5n', '\u5bc6\u7801\u662f 123']) {
    assert.equal(merge.looksSecret(secret), true, secret);
    assert.equal(merge.noteText(secret).reason, 'secret');
  }
  for (const fine of ['Job interview in March, in English', 'Prefers short answers', 'Works on a React app', 'Level B1; wants C1 by 2027']) assert.equal(merge.looksSecret(fine), false, fine);
  assert.deepEqual(merge.noteText('  two\n lines  '), { text: 'two lines', reason: '' });
  assert.equal(merge.noteText('x'.repeat(201)).reason, 'long');
  assert.equal(merge.noteText('').reason, 'empty');
  assert.equal(merge.noteUntil('2027-02-30'), null);
  assert.equal(merge.noteUntil('2027-03-31'), '2027-03-31');
});

test('the merge of notes and of the summary (pure)', () => {
  const note = (fields = {}) => ({ uid: 'note-00001', text: 'A', until: null, created_at: 1, updated_at: 10, deleted: 0, by: 'engine-a', ...fields });
  assert.equal(merge.noteWins(note({ updated_at: 11 }), note()), true, 'newer wins');
  assert.equal(merge.noteWins(note({ updated_at: 9, deleted: 1 }), note()), false, 'an older tombstone loses');
  assert.equal(merge.noteWins(note({ deleted: 1, by: 'engine-0' }), note()), true, 'a tombstone wins a tie');
  assert.equal(merge.noteWins(note({ deleted: 0, text: 'B' }), note({ deleted: 1 })), false);
  assert.equal(merge.noteWins(note(), null), true);
  assert.equal(merge.noteFromPeer({ ...note({ text: 'password: x' }), deleted: false }, 'engine-z'), null, 'a secret from a peer is not kept');
  assert.equal(merge.noteFromPeer({ ...note(), deleted: true, text: '' }, 'engine-z').deleted, 1);

  const summary = (fields = {}) => ({ text: 'S', covers_at: 100, updated_at: 200, reset_at: 0, by: 'engine-a', ...fields });
  assert.equal(merge.mergeSummary(summary(), summary({ text: 'T', covers_at: 150, updated_at: 160 })).text, 'T', 'the newer covers_at wins');
  assert.equal(merge.mergeSummary(summary(), summary({ text: 'T', covers_at: 90, updated_at: 300 })).text, 'S');
  assert.equal(merge.mergeSummary(summary(), summary({ text: 'T', updated_at: 250 })).text, 'T', 'a tie: the newer fold');
  const reset = merge.mergeSummary(summary(), summary({ text: '', covers_at: 0, updated_at: 500, reset_at: 500, by: 'engine-b' }));
  assert.deepEqual([reset.text, reset.covers_at, reset.reset_at], ['', 0, 500], 'a newer reset voids the older summary');
  const after = merge.mergeSummary(reset, summary({ text: 'New', covers_at: 600, updated_at: 700 }));
  assert.deepEqual([after.text, after.reset_at], ['New', 500], 'a fold after the reset holds');
  assert.equal(merge.mergeSummary(null, summary()).text, 'S');
});

test('the rolling summary: folded after the answer when the history outgrows its window, facts only, the window moves only with a fold; reset', async t => {
  const ctx = side(t);
  const long = index => `Question ${index}: ${'about phrasal verbs and the present perfect '.repeat(40)}`;
  for (let index = 0; index < 12; index += 1) { ctx.clock.now += 1000; await ctx.coach.send('me', { text: long(index) }); await ctx.coach.settle(); }
  assert.ok(ctx.folds.length >= 1, 'folded');
  const [first] = ctx.folds;
  assert.equal(first.options.temperature, 0.2);
  assert.match(first.system, /Facts only/);
  assert.match(first.messages[0].content, /^Summary so far:\n\(none\)\n\nNew messages:\nPerson: Question 0/);
  const row = ctx.db.prepare("SELECT * FROM learn_coach_summary WHERE owner = 'me'").get();
  assert.match(row.text, /^Summary \d+: the person practises spelling\.$/);
  const coveredAt = row.covers_at;
  assert.ok(coveredAt > 0);
  // The next requests: the summary in the system message, only the messages after it, and the same prefix twice in a row.
  ctx.requests.length = 0;
  ctx.clock.now += 1000;
  await ctx.coach.send('me', { text: 'short one' });
  await ctx.coach.settle();
  ctx.clock.now += 1000;
  await ctx.coach.send('me', { text: 'short two' });
  const [one, two] = ctx.requests;
  assert.match(one.system, /Summary of the earlier conversation \(data\):\nSummary \d+/);
  const historyChars = one.messages.slice(0, -1).reduce((sum, item) => sum + item.content.length, 0);
  assert.ok(historyChars <= HISTORY);
  assert.equal(one.system, two.system, 'no fold between them: the same system message');
  assert.deepEqual(two.messages.slice(0, one.messages.length - 1), one.messages.slice(0, -1), 'the stable prefix');
  assert.ok(!one.messages.some(item => item.content.startsWith('Question 0:')), 'folded messages are not sent again');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) FROM learn_convo_messages WHERE convo_uid = 'coach'").pluck().get(), 28, 'the messages themselves are never deleted');

  // Reset: the summary is void; the next send folds again from the start.
  ctx.coach.resetSummary('me');
  ctx.requests.length = 0;
  ctx.clock.now += 1000;
  await ctx.coach.send('me', { text: 'after reset' });
  assert.doesNotMatch(ctx.requests[0].system, /Summary of the earlier conversation/);
  await ctx.coach.settle();
  const again = ctx.db.prepare("SELECT * FROM learn_coach_summary WHERE owner = 'me'").get();
  assert.ok(again.text && again.updated_at >= again.reset_at, 'folded again after the reset');
});

const exchange = (from, to) => to.sync.applyPage(from.sync.exportPage(0, 1000), from.instanceId, { bump: true });
const both = (A, B) => exchange(A, B) + exchange(B, A);

test('two databases: the coach conversation (practice messages too), proposal states, notes and the summary travel; the coach is never pruned', async t => {
  const settingsScript = (request, index) => (index === 0 ? { content: '', toolCalls: [{ id: 'call_s', name: 'propose_settings', arguments: '{"changes":{"daily_goal":25}}' }] } : null);
  const A = side(t, { name: 'A', instanceId: 'engine-a', script: settingsScript });
  const B = side(t, { name: 'B', instanceId: 'engine-b' });
  const sent = await A.coach.send('me', { text: 'Set my goal to 25' });
  await A.coach.practiceResult('me', { done: 3, total: 3, right: 2, seconds: 60, missed: [{ en: 'separate', typed: 'seperate' }] });
  assert.ok(exchange(A, B) > 0);
  const onB = B.coach.view('me').messages;
  assert.deepEqual(onB.map(item => item.role), ['user', 'assistant', 'practice', 'assistant']);
  assert.equal(onB[1].meta.proposals[0].state, 'open');
  assert.equal(onB[2].meta.practice.missed[0].typed, 'seperate');
  assert.equal(exchange(A, B), 0, 'quiet the second time');

  // The proposal is run on B: its state reaches A (newer state wins), and the setting goes with the settings.
  B.clock.now += 5000;
  await B.coach.runProposal('me', onB[1].meta.proposals[0].id, { message_uid: onB[1].uid });
  exchange(B, A);
  assert.equal(A.coach.view('me').messages[1].meta.proposals[0].state, 'done');
  assert.equal(A.learn.settings('me').daily_goal, 25);
  await assert.rejects(A.coach.runProposal('me', onB[1].meta.proposals[0].id, { message_uid: onB[1].uid }), { statusCode: 409 }, 'not run twice');
  assert.equal(both(A, B), 0);

  // Notes: made on A, edited on B later, deleted on A earlier than the edit: the edit wins; a later delete wins.
  A.db.prepare("INSERT INTO learn_coach_notes (owner, uid, text, created_at, updated_at, sync_seq) VALUES ('me', 'note-00001', 'Likes short answers', ?, ?, ?)").run(NOW, NOW, syncStore.nextSeq(A.db));
  exchange(A, B);
  assert.equal(B.coach.notes('me').notes[0].text, 'Likes short answers');
  A.clock.now = NOW + 10_000;
  B.clock.now = NOW + 20_000;
  A.coach.deleteNote('me', 'note-00001');
  B.coach.updateNote('me', 'note-00001', { text: 'Likes very short answers' });
  both(A, B);
  assert.deepEqual([A.coach.notes('me').notes.map(note => note.text), B.coach.notes('me').notes.map(note => note.text)], [['Likes very short answers'], ['Likes very short answers']]);
  A.clock.now = NOW + 30_000;
  A.coach.deleteNote('me', 'note-00001');
  both(A, B);
  assert.equal(B.coach.notes('me').notes.length, 0);
  assert.equal(both(A, B), 0);

  // The summary: the one that covers the newer message wins on both; a reset travels.
  A.db.prepare("INSERT INTO learn_coach_summary (owner, text, covers_at, updated_at, reset_at, sync_seq) VALUES ('me', 'Summary from A', 100, ?, 0, ?)").run(NOW + 40_000, syncStore.nextSeq(A.db));
  B.db.prepare("INSERT INTO learn_coach_summary (owner, text, covers_at, updated_at, reset_at, sync_seq) VALUES ('me', 'Summary from B', 200, ?, 0, ?)").run(NOW + 30_000, syncStore.nextSeq(B.db));
  both(A, B);
  const summaryOn = S => S.db.prepare("SELECT text, covers_at FROM learn_coach_summary WHERE owner = 'me'").get();
  assert.deepEqual([summaryOn(A), summaryOn(B)].map(row => row.text), ['Summary from B', 'Summary from B']);
  B.clock.now = NOW + 50_000;
  B.coach.resetSummary('me');
  both(A, B);
  assert.equal(summaryOn(A).text, '');

  // 60 chats on A: the oldest are pruned, never the coach (even though it is older than all of them).
  for (let index = 0; index < 60; index += 1) {
    A.db.prepare("INSERT INTO learn_convos (owner, uid, created_at, updated_at, sync_seq) VALUES ('me', ?, ?, ?, ?)").run(`chat-${String(index).padStart(5, '0')}`, NOW + 100_000 + index, NOW + 100_000 + index, syncStore.nextSeq(A.db));
  }
  syncStore.pruneConvos(A.db, 'me');
  assert.equal(A.db.prepare("SELECT deleted FROM learn_convos WHERE uid = 'coach'").pluck().get(), 0);
  assert.equal(A.db.prepare("SELECT COUNT(*) FROM learn_convos WHERE deleted = 0 AND uid <> 'coach'").pluck().get(), syncStore.MAX_CONVOS);
  exchange(A, B);
  assert.equal(B.db.prepare("SELECT deleted FROM learn_convos WHERE uid = 'coach'").pluck().get(), 0);

  // What does not check is not applied: a practice message in another chat, a note with a secret.
  assert.equal(B.sync.applyPage({ convo_messages: [{ uid: 'msg-90001', convo_uid: 'chat-00059', role: 'practice', text: 'x', at: 5 }] }, 'engine-z'), 0);
  assert.equal(B.sync.applyPage({ coach_notes: [{ uid: 'note-90001', text: 'my password is x', created_at: 1, updated_at: 1, deleted: false }] }, 'engine-z'), 0);
  // A company computer's pull (cards only) carries none of it.
  const cardsOnly = A.sync.exportPage(0, 1000, { reviews: false });
  assert.deepEqual([cardsOnly.coach_notes.length, cardsOnly.coach_summary, cardsOnly.convo_messages.length], [0, null, 0]);
  assert.equal(sent.message.meta.proposals.length, 1);
  // The coach switches sync with the other learn settings, and an older peer that sends none keeps them.
  A.clock.now = NOW + 200_000;
  A.learn.saveSettings('me', { coach_read_text: false, coach_economy: true });
  exchange(A, B);
  assert.deepEqual([B.learn.settings('me').coach_read_text, B.learn.settings('me').coach_economy], [false, true]);
  const page = A.sync.exportPage(0, 1000);
  const { coach_read_text: _text, coach_economy: _economy, coach_memory: _memory, coach_read_answers: _answers, ...older } = page.settings.value;
  B.sync.applyPage({ settings: { ...page.settings, value: older, at: NOW + 300_000 } }, 'engine-old');
  assert.equal(B.learn.settings('me').coach_read_text, false, 'kept');
});
