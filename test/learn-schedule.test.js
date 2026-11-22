// The FSRS state of stored cards (services/learn-schedule.js, services/learn.js, services/learn-sync.js, services/learn-sync-store.js; "Replay, sync
// and migration" and "Desired retention" in docs/design/learn-review-fsrs.md): the `next` and `retrievability` fields of the API, an answer on a card
// without a state (replayed, or estimated when its answers are not all here), the desired retention (checked, rescheduling in one transaction,
// synced), the schema 21 -> 22 replay on a fixture database, and two databases joined by pages: both answered while apart end with the same state
// both ways, an older peer's state is recomputed from the answers once they are here, a company computer keeps its home's state. Fake clocks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// db/index.js (required by the sync services) refuses to run a test on the real ~/.tagent: a temporary data folder first.
process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-schedule-data-'));
delete process.env.TAGENT_HOME;
const express = require('express');
const Database = require('better-sqlite3');
const { createLearn } = require('../services/learn');
const { createLearnRouter } = require('../routes/learn');
const { createLearnSync } = require('../services/learn-sync');
const syncStore = require('../services/learn-sync-store');
const schedule = require('../services/learn-schedule');
const review = require('../services/learn-review');

const NOW = Date.UTC(2026, 10, 23, 4, 0, 0);
const { DAY } = review;
const TZ = 'UTC';
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const lookupPhonetic = () => '';

function database(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-schedule-'));
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}
function side(t, name, { company = false } = {}) {
  const db = database(t);
  const clock = { now: NOW };
  const learn = createLearn({ db, now: () => clock.now, timeZone: TZ, lookupWord: null, lookupPhonetic });
  learn.saveSettings('me', { starter: null });
  const sync = createLearnSync({
    db, identity: () => ({ instance_id: `engine-${name}`, name }), owner: () => 'me', learn, now: () => clock.now, timeZone: TZ,
    linkKeys: { publicKey: () => 'x', linkKey: () => Buffer.alloc(32) }, log: { warn() {}, info() {} }, intervalMs: 0,
  });
  return { name, db, clock, learn, sync, instanceId: `engine-${name}`, company };
}
// Every row of `from` to `to`, as the pull of a normal machine does (a company computer applies without new change numbers and replays nothing).
const send = (from, to, { strip = false } = {}) => {
  const page = from.sync.exportPage(0, 1000, { reviews: !to.company });
  // An older peer (schema 21) sends no FSRS state and no desired retention.
  if (strip) {
    page.cards = page.cards.map(({ fsrs_stability, fsrs_difficulty, ...card }) => card);
    if (page.settings && page.settings.value) { const { desired_retention, ...value } = page.settings.value; page.settings = { ...page.settings, value }; }
  }
  return to.sync.applyPage(page, from.instanceId, { bump: !to.company });
};
const STATE = ['due_at', 'interval_days', 'reps', 'lapses', 'last_result', 'last_at', 'last_correct', 'fsrs_stability', 'fsrs_difficulty'];
const stateOf = (s, norm) => {
  const row = s.db.prepare("SELECT * FROM learn_cards WHERE owner = 'me' AND norm = ?").get(norm);
  return row && Object.fromEntries(STATE.map(field => [field, row[field]]));
};
const cardId = (s, norm) => s.db.prepare("SELECT id FROM learn_cards WHERE owner = 'me' AND norm = ?").pluck().get(norm);
const add = (s, en) => s.learn.addCard('me', { kind: 'word', en, source: 'manual' }).card;
const answer = (s, norm, grade) => s.learn.answer('me', cardId(s, norm), { mode: 'review', grade, correct: grade !== 'again' }).card;

test('the API: `retrievability` on every card, `next` on queue cards, an answer stores the FSRS state', async t => {
  const A = side(t, 'A');
  const card = add(A, 'merge');
  assert.equal(card.retrievability, null, 'a new card');
  const { cards } = await A.learn.queue('me', 'review');
  assert.deepEqual(cards[0].next, { again: 600000, hard: DAY, good: 2 * DAY });
  const answered = answer(A, 'merge', 'good');
  assert.equal(answered.retrievability, 1);
  assert.equal(answered.interval_days, 2);
  assert.deepEqual(A.db.prepare('SELECT fsrs_stability, fsrs_difficulty FROM learn_cards WHERE id = ?').get(card.id), { fsrs_stability: 2.3065, fsrs_difficulty: 2.11810397 });
  A.clock.now = NOW + 2 * DAY;
  const due = (await A.learn.queue('me', 'review')).cards[0];
  // Due after 2 whole days (the interval of S = 2.3065 rounded): the probability of recall then, a little over the desired retention.
  assert.equal(due.retrievability, require('../services/learn-fsrs').roundTo(require('../services/learn-fsrs').retrievability(2, 2.3065), 4));
  assert.ok(due.retrievability >= 0.9 && due.retrievability < 0.92);
  assert.equal(due.next.again, 600000);
  assert.ok(due.next.hard < due.next.good && due.next.hard >= DAY, JSON.stringify(due.next));
  // The preview is what the answer does.
  const good = answer(A, 'merge', 'good');
  assert.equal(Date.parse(good.due_at) - A.clock.now, due.next.good);
  assert.equal((await A.learn.list('me', {})).cards[0].retrievability, 1, 'the card list has it too');
});

test('an answer on a card without a stored state: the replay of its answers when they are all here, else an estimate from the old state', t => {
  const A = side(t, 'A');
  add(A, 'merge');
  add(A, 'deploy');
  answer(A, 'merge', 'good');
  A.clock.now = NOW + 2 * DAY;
  answer(A, 'merge', 'hard');
  const expected = stateOf(A, 'merge');
  // The state is wiped (as after a state from an older version) and the card answered again: the same as answering on the stored state.
  A.clock.now = NOW + 6 * DAY;
  const withState = review.applyAnswer(A.db.prepare("SELECT * FROM learn_cards WHERE norm = 'merge'").get(), 'good', true, A.clock.now);
  A.db.prepare("UPDATE learn_cards SET fsrs_stability = NULL, fsrs_difficulty = NULL, interval_days = 40, ease = 1.3 WHERE norm = 'merge'").run();
  answer(A, 'merge', 'good');
  const after = stateOf(A, 'merge');
  assert.equal(after.fsrs_stability, withState.fsrs_stability);
  assert.equal(after.due_at, withState.due_at);
  assert.equal(after.reps, 3);
  assert.notEqual(expected.fsrs_stability, after.fsrs_stability);
  // A card whose answers are not here (reps 5, no answer: a company computer's cache): estimated from its interval and ease, nothing lost.
  A.db.prepare("UPDATE learn_cards SET reps = 5, interval_days = 30, ease = 2.5, last_at = ?, last_result = 'good' WHERE norm = 'deploy'").run(NOW - 24 * DAY);
  const estimated = answer(A, 'deploy', 'good');
  assert.equal(estimated.reps, 6);
  assert.ok(estimated.interval_days > 30, `${estimated.interval_days}`);
});

test('the desired retention: checked, saved with the settings, and a change reschedules the answered cards in one transaction', async t => {
  const A = side(t, 'A');
  add(A, 'merge');
  add(A, 'deploy');
  add(A, 'rollback');
  answer(A, 'merge', 'good');
  A.clock.now = NOW + 2 * DAY;
  answer(A, 'merge', 'good');
  answer(A, 'deploy', 'again');
  const before = { merge: stateOf(A, 'merge'), deploy: stateOf(A, 'deploy'), rollback: stateOf(A, 'rollback') };
  assert.equal(A.learn.settings('me').desired_retention, 0.9);

  const app = express();
  app.use(express.json());
  app.use('/api/learn', createLearnRouter({ service: A.learn, requireAuth: (req, res, next) => { req.session = { user: { login: 'me' } }; next(); }, clientOrigin: (req, res, next) => next() }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const put = async body => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/learn/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  for (const value of [0.8, 1, '0.9', null, 0.91]) {
    const refused = await put({ desired_retention: value });
    assert.equal(refused.status, 400, JSON.stringify(value));
    assert.equal(refused.body.error, 'The desired retention must be 0.85, 0.9 or 0.95');
  }
  assert.deepEqual(stateOf(A, 'merge'), before.merge, 'a refused value changes nothing');

  const saved = await put({ desired_retention: 0.95 });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.desired_retention, 0.95);
  const merge = stateOf(A, 'merge');
  assert.ok(merge.interval_days < before.merge.interval_days, `${merge.interval_days} < ${before.merge.interval_days}`);
  assert.equal(merge.due_at, merge.last_at + merge.interval_days * DAY);
  assert.equal(merge.fsrs_stability, before.merge.fsrs_stability, 'the stability stays');
  assert.deepEqual(stateOf(A, 'deploy'), before.deploy, 'again keeps its 10 minutes');
  assert.deepEqual(stateOf(A, 'rollback'), before.rollback, 'a new card is not touched');
  // The next answer uses it.
  A.clock.now = Date.parse(new Date(merge.due_at).toISOString());
  const next = answer(A, 'merge', 'good');
  const at90 = review.applyAnswer({ ...merge, ease: 2.5 }, 'good', true, A.clock.now);
  assert.ok(next.interval_days < at90.interval_days);
  // Back to 0.9: the dates of 0.9 again (from the stability), and the same as a replay.
  await put({ desired_retention: 0.9 });
  const row = A.db.prepare("SELECT * FROM learn_cards WHERE norm = 'merge'").get();
  assert.equal(row.due_at, schedule.replayed(A.db, row, 0.9).due_at);
  // One transaction: a failing reschedule leaves the settings as they were.
  const original = schedule.reschedule;
  schedule.reschedule = () => { throw new Error('boom'); };
  t.after(() => { schedule.reschedule = original; });
  assert.throws(() => A.learn.saveSettings('me', { desired_retention: 0.85 }), /boom/);
  assert.equal(A.learn.settings('me').desired_retention, 0.9);
  schedule.reschedule = original;
});

test('schema 21 -> 22: every card with all its answers is replayed, a changed one gets a new clock and change number; the others stay as they are', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-schedule-migrate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new Database(path.join(dir, 'db.sqlite'));
  t.after(() => db.close());
  db.exec(SCHEMA);
  // A schema 21 database: the cards without the FSRS columns, with states of the old rules (SM-2 like ladder: good 1 -> 3 days).
  db.exec('ALTER TABLE learn_cards DROP COLUMN fsrs_stability; ALTER TABLE learn_cards DROP COLUMN fsrs_difficulty');
  const card = db.prepare(`INSERT INTO learn_cards (owner, kind, en, norm, source, created_at, due_at, interval_days, ease, reps, lapses, last_result, last_at,
    last_correct, content_at, state_at, sync_seq) VALUES ('me', 'word', ?, ?, 'manual', 1, ?, ?, ?, ?, ?, ?, ?, ?, 5, ?, ?)`);
  const answerRow = db.prepare("INSERT INTO learn_reviews (card_id, owner, at, mode, grade, correct, uid, sync_seq) VALUES (?, 'me', ?, 'review', ?, ?, ?, ?)");
  // merge: good, good a day later -> the old rules gave 3 days; FSRS gives 7 (later).
  const merge = card.run('merge', 'merge', NOW + 4 * DAY, 3, 2.5, 2, 0, 'good', NOW + DAY, 1, NOW + DAY, 10).lastInsertRowid;
  answerRow.run(merge, NOW, 'good', 1, 'u-merge-1', 11);
  answerRow.run(merge, NOW + DAY, 'good', 1, 'u-merge-2', 12);
  // deploy: good, then hard 10 days later -> the old rules: 12 days... stored here as 30 so that FSRS is earlier.
  const deploy = card.run('deploy', 'deploy', NOW + 40 * DAY, 30, 2.35, 2, 0, 'hard', NOW + 10 * DAY, 1, NOW + 10 * DAY, 13).lastInsertRowid;
  answerRow.run(deploy, NOW, 'good', 1, 'u-deploy-1', 14);
  answerRow.run(deploy, NOW + 10 * DAY, 'hard', 1, 'u-deploy-2', 15);
  // partial: reps 4 with one answer here (a company computer's cache): kept. fresh: no answers: stays new.
  const partial = card.run('partial', 'partial', NOW + 9 * DAY, 9, 2.5, 4, 0, 'good', NOW, 1, NOW, 16).lastInsertRowid;
  answerRow.run(partial, NOW, 'good', 1, 'u-partial-1', 17);
  card.run('fresh', 'fresh', NOW, 0, 2.5, 0, 0, null, null, null, 0, 18);
  db.prepare("INSERT INTO system_state (key, value) VALUES ('learn_v1_sync:me', ?)").run(JSON.stringify({ at: 0, by: '', seq: 500 }));
  const before = db.prepare('SELECT * FROM learn_cards ORDER BY id').all();

  const stats = syncStore.ensureSyncSchema(db);
  assert.deepEqual(stats, { replayed: 2, changed: 2, earlier: 1, later: 1, skipped: 1 });
  assert.equal(syncStore.ensureSyncSchema(db), null, 'a second run changes nothing');
  db.exec(SCHEMA);
  const rows = Object.fromEntries(db.prepare('SELECT * FROM learn_cards ORDER BY id').all().map(row => [row.norm, row]));
  const replayOf = (id, row) => review.replay(db.prepare('SELECT at, grade, correct, uid FROM learn_reviews WHERE card_id = ?').all(id), { ease: row.ease });
  for (const [norm, id] of [['merge', merge], ['deploy', deploy]]) {
    const expected = replayOf(id, rows[norm]);
    for (const field of STATE) assert.equal(rows[norm][field], expected[field], `${norm} ${field}`);
    assert.ok(rows[norm].state_at > NOW + 10 * DAY && rows[norm].state_by === '', `${norm}: a new review-state clock`);
    assert.ok(rows[norm].sync_seq > 500, `${norm}: a change number after every stored one, the settings version too`);
  }
  assert.equal(rows.merge.interval_days, 7);
  assert.ok(rows.deploy.due_at < before[1].due_at);
  assert.equal(rows.deploy.ease, 2.35, 'the ease is kept');
  for (const norm of ['partial', 'fresh']) {
    const old = before.find(row => row.norm === norm);
    for (const field of ['due_at', 'interval_days', 'reps', 'state_at', 'sync_seq']) assert.equal(rows[norm][field], old[field], `${norm} ${field}`);
    assert.equal(rows[norm].fsrs_stability, null);
  }
  // The hybrid clock starts after the migration's.
  assert.ok(syncStore.stamp(db, NOW) > rows.merge.state_at);
});

test('two engines that answered the same card while apart end with the same state, whichever way the pages go first; nothing goes back and forth', t => {
  for (const order of ['AB', 'BA']) {
    const A = side(t, 'A');
    const B = side(t, 'B');
    add(A, 'merge');
    send(A, B);
    answer(A, 'merge', 'good');
    send(A, B);
    // Apart: A answers on day 2 and day 9, B on day 3 (the later review-state clock is B's after day 3 ... then A's day 9).
    A.clock.now = NOW + 2 * DAY; answer(A, 'merge', 'hard');
    B.clock.now = NOW + 3 * DAY; answer(B, 'merge', 'again');
    B.clock.now = NOW + 3 * DAY + 600000; answer(B, 'merge', 'good');
    A.clock.now = NOW + 9 * DAY; answer(A, 'merge', 'good');
    const [first, second] = order === 'AB' ? [[A, B], [B, A]] : [[B, A], [A, B]];
    send(...first);
    send(...second);
    send(...first);
    const a = stateOf(A, 'merge');
    assert.deepEqual(stateOf(B, 'merge'), a, `${order}: the same state on both`);
    assert.equal(a.reps, 5);
    assert.equal(a.lapses, 1);
    assert.equal(a.last_result, 'good');
    assert.equal(a.last_at, NOW + 9 * DAY);
    // It is the replay of the five answers in time order.
    const row = A.db.prepare("SELECT * FROM learn_cards WHERE norm = 'merge'").get();
    assert.equal(a.fsrs_stability, schedule.replayed(A.db, row).fsrs_stability);
    assert.equal(send(A, B) + send(B, A), 0, `${order}: once both agree, a page changes nothing`);
  }
});

test('an older peer: its state is recomputed from the answers once they are here, with a new clock so that it takes the replay; its settings keep the retention', t => {
  const A = side(t, 'A');
  const O = side(t, 'O'); // an older version, simulated: its pages carry no FSRS state and no desired retention
  add(A, 'merge');
  answer(A, 'merge', 'good');
  send(A, O);
  // O answers with the old rules (it does not know the FSRS columns): the interval of its ladder, no stability.
  O.clock.now = NOW + 2 * DAY;
  answer(O, 'merge', 'good');
  O.db.prepare("UPDATE learn_cards SET interval_days = 3, due_at = ?, fsrs_stability = NULL, fsrs_difficulty = NULL WHERE norm = 'merge'").run(O.clock.now + 3 * DAY);
  // Its card arrives without its answer first (a page boundary): the state is kept as it came, nothing is lost.
  const page = O.sync.exportPage(0, 1000);
  page.cards = page.cards.map(({ fsrs_stability, fsrs_difficulty, ...card }) => card);
  const answers = page.reviews;
  A.sync.applyPage({ ...page, reviews: [] }, O.instanceId, { bump: true });
  assert.deepEqual([stateOf(A, 'merge').interval_days, stateOf(A, 'merge').fsrs_stability], [3, null], 'no replay while an answer is missing');
  const clockBefore = A.db.prepare("SELECT state_at FROM learn_cards WHERE norm = 'merge'").pluck().get();
  // The answer comes: the card is the replay of both answers, with a newer review-state clock.
  A.sync.applyPage({ ...page, cards: [], reviews: answers }, O.instanceId, { bump: true });
  const row = A.db.prepare("SELECT * FROM learn_cards WHERE norm = 'merge'").get();
  const replay = schedule.replayed(A.db, row);
  assert.equal(row.fsrs_stability, replay.fsrs_stability);
  assert.equal(row.interval_days, replay.interval_days);
  assert.notEqual(row.interval_days, 3);
  assert.ok(row.state_at > clockBefore && row.state_by === '', 'a new clock: the older peer takes it');
  // The older peer takes A's schedule; what it sends back changes nothing here.
  send(A, O, { strip: true });
  assert.equal(stateOf(O, 'merge').due_at, row.due_at);
  assert.equal(send(O, A, { strip: true }), 0);
  // A replayed schedule that came through an older peer (which drops the FSRS state) to another engine: that one only adds the state, no new
  // clock, so nothing goes round the chain.
  const C = side(t, 'C');
  send(O, C, { strip: true }); // C has the card only through the older peer
  assert.deepEqual(stateOf(C, 'merge'), stateOf(A, 'merge'), 'C replays the answers to the same state, with the FSRS state');
  assert.equal(C.db.prepare("SELECT state_at FROM learn_cards WHERE norm = 'merge'").pluck().get(), row.state_at, 'the clock A gave it');

  // The desired retention travels with the settings and reschedules there; an older peer's settings (without it) keep the one here.
  A.learn.saveSettings('me', { desired_retention: 0.95 });
  const B = side(t, 'B');
  send(A, B);
  assert.equal(B.learn.settings('me').desired_retention, 0.95);
  assert.equal(stateOf(B, 'merge').due_at, stateOf(A, 'merge').due_at, 'the same due date at 0.95 on both');
  B.learn.saveSettings('me', { desired_retention: 0.85 });
  send(B, A);
  assert.equal(A.learn.settings('me').desired_retention, 0.85);
  assert.equal(stateOf(A, 'merge').due_at, stateOf(B, 'merge').due_at, 'rescheduled where the setting arrived');
  O.clock.now = NOW + 30 * DAY;
  O.learn.saveSettings('me', { daily_goal: 33 });
  send(O, A, { strip: true });
  assert.deepEqual([A.learn.settings('me').daily_goal, A.learn.settings('me').desired_retention], [33, 0.85]);
});

test('a company computer takes its home\'s state and replays nothing', t => {
  const H = side(t, 'H');
  const C = side(t, 'C', { company: true });
  add(H, 'merge');
  answer(H, 'merge', 'good');
  H.clock.now = NOW + 2 * DAY;
  answer(H, 'merge', 'good');
  send(H, C);
  assert.deepEqual(stateOf(C, 'merge'), stateOf(H, 'merge'), 'the cache has the home\'s state with its stability');
  // Its own answer builds on that stored state, like the home's would.
  C.clock.now = H.clock.now = NOW + 10 * DAY;
  const onC = answer(C, 'merge', 'good');
  const homeRow = H.db.prepare("SELECT * FROM learn_cards WHERE norm = 'merge'").get();
  assert.equal(Date.parse(onC.due_at), review.applyAnswer(homeRow, 'good', true, C.clock.now).due_at);
});
