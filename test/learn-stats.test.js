// Learn: the numbers of the Progress view ("Learn progress statistics" in docs/design/learn-english-stats.md; services/learn-stats.js, GET
// /api/learn/stats in routes/learn.js): streak and best streak, the rolling week, 30 days, 12 Monday weeks with "right the first time", memory
// strength by the FSRS stability or (without it) the review interval, the next 14 days, all in the person's time zone with a fake clock; the route,
// and the company computer that reads the home's numbers (with the cards here while the home is away or older).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-stats-data-'));
delete process.env.TAGENT_HOME;
const express = require('express');
const Database = require('better-sqlite3');
const { createLearn } = require('../services/learn');
const { createLearnStats, addDays, mondayOf, longestRun } = require('../services/learn-stats');
const { createLearnRouter } = require('../routes/learn');

const TZ = 'Asia/Taipei';
const TODAY = '2026-11-23'; // a Monday
const at = (day, time) => Date.parse(`${day}T${time}:00+08:00`);
const NOW = at(TODAY, '12:00');
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

function database(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-stats-'));
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

let serial = 0;
function addCard(db, { owner = 'me', source = 'manual', reps = 1, interval = 0, due = NOW, suspended = 0 } = {}) {
  serial += 1;
  const en = `word${serial}`;
  return Number(db.prepare(`INSERT INTO learn_cards (owner, kind, en, norm, source, created_at, due_at, interval_days, reps, suspended)
    VALUES (?, 'word', ?, ?, ?, ?, ?, ?, ?, ?)`).run(owner, en, en, source, NOW - 100 * DAY, due, interval, reps, suspended).lastInsertRowid);
}
function addAnswer(db, card, when, correct, owner = 'me') {
  serial += 1;
  db.prepare("INSERT INTO learn_reviews (card_id, owner, at, mode, grade, correct, uid) VALUES (?, ?, ?, 'spell', ?, ?, ?)")
    .run(card, owner, when, correct ? 'good' : 'again', correct ? 1 : 0, `uid-${serial}`);
}

// The fixture: cards of every memory bucket and due day, and answers over the last months (Taipei days).
function setup(t) {
  const db = database(t);
  const clock = { now: NOW };
  const learn = createLearn({ db, now: () => clock.now, timeZone: TZ, lookupWord: null, onNewWords() {} });
  learn.saveSettings('me', { starter: null });
  const cards = {
    new1: addCard(db, { reps: 0 }),
    new2: addCard(db, { reps: 0 }),
    hiddenStarter: addCard(db, { source: 'starter', reps: 0 }),
    starter: addCard(db, { source: 'starter', reps: 2, interval: 3, due: at(addDays(TODAY, 1), '12:00') }),
    suspended: addCard(db, { reps: 3, interval: 30, suspended: 1 }),
    learning: addCard(db, { reps: 1, interval: 0, due: NOW + 10 * MIN }),
    young: addCard(db, { reps: 2, interval: 3, due: at(addDays(TODAY, 3), '12:00') }),
    young2: addCard(db, { reps: 4, interval: 20.9, due: at(addDays(TODAY, 13), '23:30') }),
    mature: addCard(db, { reps: 6, interval: 21, due: at(addDays(TODAY, 14), '00:30') }),
    mature2: addCard(db, { reps: 7, interval: 40, due: NOW - 5 * DAY }),
    other: addCard(db, { owner: 'someone', reps: 3, interval: 30 }),
  };
  const A = cards.learning;
  const B = cards.young;
  const C = cards.mature2;
  const D = cards.mature;
  addAnswer(db, A, at(TODAY, '09:00'), false);
  addAnswer(db, A, at(TODAY, '09:05'), true);
  addAnswer(db, B, at(TODAY, '01:00'), true); // still the 22nd in UTC
  addAnswer(db, A, at('2026-11-22', '10:00'), true);
  addAnswer(db, B, at('2026-11-21', '20:00'), true);
  addAnswer(db, C, at('2026-11-19', '08:00'), false);
  addAnswer(db, C, at('2026-11-12', '08:00'), true);
  addAnswer(db, C, at('2026-11-12', '09:00'), true);
  for (const day of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']) addAnswer(db, D, at(day, '10:00'), true);
  addAnswer(db, D, at('2026-08-01', '10:00'), true);
  addAnswer(db, cards.other, at(TODAY, '10:00'), true, 'someone');
  return { db, clock, learn, cards };
}

test('day helpers: adding days, the Monday of a week, the longest run', () => {
  assert.equal(addDays('2026-11-23', -30), '2026-10-24');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(mondayOf('2026-11-23'), '2026-11-23');
  assert.equal(mondayOf('2026-11-29'), '2026-11-23');
  assert.equal(mondayOf('2026-11-22'), '2026-11-16');
  assert.equal(longestRun(new Set(['2026-10-01', '2026-10-03', '2026-10-04', '2026-10-05', '2026-11-30'])), 3);
  assert.equal(longestRun(new Set()), 0);
});

test('streak, best streak and the rolling week', t => {
  const { learn } = setup(t);
  const stats = learn.stats('me');
  assert.equal(stats.streak, 3, 'the 21st, 22nd and 23rd');
  assert.equal(stats.best_streak, 5, 'October 1 to 5');
  assert.equal(learn.summary('me').streak, stats.streak, 'the same streak as the summary');
  assert.deepEqual(stats.week, { answers: 6, right: 4, prev_answers: 2, prev_right: 2 });
});

test('the last 30 days follow the time zone and include the days without answers', t => {
  const { db, learn } = setup(t);
  const { daily } = learn.stats('me');
  assert.equal(daily.length, 30);
  assert.equal(daily[0].day, '2026-10-25');
  assert.equal(daily[29].day, TODAY);
  const by = Object.fromEntries(daily.map(item => [item.day, item]));
  assert.deepEqual(by[TODAY], { day: TODAY, answers: 3, right: 2 });
  assert.deepEqual(by['2026-11-22'], { day: '2026-11-22', answers: 1, right: 1 });
  assert.deepEqual(by['2026-11-19'], { day: '2026-11-19', answers: 1, right: 0 });
  assert.deepEqual(by['2026-11-12'], { day: '2026-11-12', answers: 2, right: 2 });
  assert.deepEqual(by['2026-11-20'], { day: '2026-11-20', answers: 0, right: 0 });
  assert.equal(daily.reduce((sum, item) => sum + item.answers, 0), 8, "only this owner's answers of these days");
  // In UTC the answer at 01:00 Taipei time is on the 22nd.
  const utc = createLearnStats({ db, now: () => NOW, timeZone: 'UTC' }).stats('me');
  assert.equal(utc.daily.find(item => item.day === TODAY).answers, 2);
  assert.equal(utc.daily.find(item => item.day === '2026-11-22').answers, 2);
});

test('12 Monday weeks count the first answer of each card on a day', t => {
  const { learn } = setup(t);
  const { weekly } = learn.stats('me');
  assert.equal(weekly.length, 12);
  assert.equal(weekly[0].week_start, '2026-09-07');
  assert.equal(weekly[11].week_start, TODAY);
  const by = Object.fromEntries(weekly.map(item => [item.week_start, item]));
  assert.deepEqual(by[TODAY], { week_start: TODAY, answers: 2, right_first: 1 }, 'wrong then right the same day: not right the first time');
  assert.deepEqual(by['2026-11-16'], { week_start: '2026-11-16', answers: 3, right_first: 2 }, 'the same card on the next day counts again');
  assert.deepEqual(by['2026-11-09'], { week_start: '2026-11-09', answers: 1, right_first: 1 }, 'two answers of a card on one day count once');
  assert.deepEqual(by['2026-09-28'], { week_start: '2026-09-28', answers: 4, right_first: 4 });
  assert.deepEqual(by['2026-10-05'], { week_start: '2026-10-05', answers: 1, right_first: 1 });
  assert.equal(weekly.reduce((sum, item) => sum + item.answers, 0), 11, 'August is before the 12 weeks');
});

test('memory strength by the review interval without the FSRS column, and the next 14 days', t => {
  const { learn } = setup(t);
  const stats = learn.stats('me');
  assert.deepEqual(stats.memory, { new: 2, learning: 1, young: 3, mature: 2 }, 'suspended and hidden starter cards left out');
  assert.equal(stats.total_cards, 8);
  assert.equal(stats.due.length, 14);
  assert.equal(stats.due[0].day, TODAY);
  assert.equal(stats.due[13].day, '2026-12-06');
  assert.deepEqual(stats.due.map(item => item.count), [2, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 'overdue on today; new cards and day 15 left out');
});

test('a starter list chosen shows the untouched starter words as new', t => {
  const { learn, db } = setup(t);
  const stats = createLearnStats({ db, now: () => NOW, timeZone: TZ }).stats('me', { starter: 'dev' });
  assert.equal(stats.memory.new, 3);
  assert.equal(stats.total_cards, 9);
  assert.equal(learn.stats('me').memory.new, 2);
});

test('the FSRS stability wins over the interval where it is set', t => {
  const { db, learn, cards } = setup(t);
  // Schema 22 (FSRS) has the column; an older schema gets it here, so both cases read the same.
  if (!db.prepare('PRAGMA table_info(learn_cards)').all().some(column => column.name === 'fsrs_stability')) db.exec('ALTER TABLE learn_cards ADD COLUMN fsrs_stability REAL');
  db.prepare('UPDATE learn_cards SET fsrs_stability = NULL').run();
  db.prepare('UPDATE learn_cards SET fsrs_stability = ? WHERE id = ?').run(5, cards.learning);
  db.prepare('UPDATE learn_cards SET fsrs_stability = ? WHERE id = ?').run(0.5, cards.mature);
  assert.deepEqual(learn.stats('me').memory, { new: 2, learning: 1, young: 4, mature: 1 }, 'NULL stability falls back to interval_days');
  db.prepare('UPDATE learn_cards SET fsrs_stability = ? WHERE id = ?').run(21, cards.young2);
  assert.deepEqual(learn.stats('me').memory, { new: 2, learning: 1, young: 3, mature: 2 });
});

test('no answers and no cards: zeros of the right lengths', t => {
  const db = database(t);
  const stats = createLearnStats({ db, now: () => NOW, timeZone: TZ }).stats('me');
  assert.equal(stats.streak, 0);
  assert.equal(stats.best_streak, 0);
  assert.deepEqual(stats.week, { answers: 0, right: 0, prev_answers: 0, prev_right: 0 });
  assert.equal(stats.daily.length, 30);
  assert.equal(stats.weekly.length, 12);
  assert.ok(stats.daily.every(item => item.answers === 0 && item.right === 0));
  assert.deepEqual(stats.memory, { new: 0, learning: 0, young: 0, mature: 0 });
  assert.equal(stats.total_cards, 0);
  assert.ok(stats.due.every(item => item.count === 0));
});

async function serve(t, learn, sync = null) {
  const app = express();
  app.use(express.json());
  app.use('/api/learn', createLearnRouter({ service: learn, sync, requireAuth: (req, res, next) => { req.session = { user: { login: 'me' } }; next(); }, clientOrigin: (req, res, next) => next() }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/learn`;
  return async url => {
    const response = await fetch(base + url);
    return { status: response.status, body: await response.json() };
  };
}

test('GET /api/learn/stats answers the numbers of the page login', async t => {
  const { learn } = setup(t);
  const get = await serve(t, learn);
  const response = await get('/stats');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, learn.stats('me'));
});

test('a company computer reads the numbers of its home, and the cards here while it is away or older', async t => {
  const { learn } = setup(t);
  const calls = [];
  const sync = {
    cacheOnly: () => true, refreshed: 0, answer: null,
    async refresh() { sync.refreshed += 1; },
    status: () => ({ company_computer: true, cache_only: true, home_name: 'T01', home_online: true, waiting: 0 }),
    async askHome(route, options) { calls.push({ route, options }); if (sync.answer instanceof Error) throw sync.answer; return sync.answer; },
  };
  const get = await serve(t, learn, sync);
  const home = { practice_kind: 'word', streak: 9, best_streak: 12, week: { answers: 1, right: 1, prev_answers: 0, prev_right: 0 }, daily: [], weekly: [], memory: { new: 0, learning: 0, young: 0, mature: 0 }, total_cards: 0, due: [] };
  sync.answer = home;
  let response = await get('/stats');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, home);
  assert.equal(calls[0].route, 'stats');
  assert.equal(calls[0].options.offline, 'Your progress is kept on a normal computer, which cannot be reached right now');
  assert.equal(sync.refreshed, 1, 'the cards here are brought up to date first');

  sync.answer = Object.assign(new Error('away'), { statusCode: 503 });
  response = await get('/stats');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ...learn.stats('me'), offline: true, home_older: false });

  sync.answer = Object.assign(new Error('NOT_FOUND'), { statusCode: 404 });
  response = await get('/stats');
  assert.deepEqual(response.body, { ...learn.stats('me'), offline: false, home_older: true });

  sync.answer = Object.assign(new Error('Refused'), { statusCode: 409 });
  response = await get('/stats');
  assert.equal(response.status, 409);
  assert.deepEqual(response.body, { error: 'Refused' });
});
