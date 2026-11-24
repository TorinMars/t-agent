// Usage time on the server (services/usage-time.js, services/usage-time-clock.js, routes/usage-time.js; "Usage time and memories" in
// docs/design/usage-time.md): the beats (checks, caps, the switch, the rollup per day, hour and key), the session clocks with a fake activity feed,
// the summary numbers and their change from the previous period, time zones and day boundaries, tasks and devices, export and Clear.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const time = require('../services/usage-time');
const { createUsageClock } = require('../services/usage-time-clock');
const { createMemories } = require('../services/usage-memories');
const { createUsageTimeRouters } = require('../routes/usage-time');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
// Tuesday 2026-11-24 12:00 UTC (20:00 in Taipei).
const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const HOUR = time.HOUR;
const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const K01 = 'bbbbbbbb-0000-4000-8000-000000000002';
const T5 = `${ME}|5`;
const S5 = `${ME}|5|k1`;

function database() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}
function setup({ now = NOW, linked = () => [] } = {}) {
  const db = database();
  const clock = { at: now };
  const usage = time.createUsageTime({ db, now: () => clock.at, identity: () => ({ instance_id: ME, name: 'T01' }), linked });
  return { db, clock, usage };
}
const beat = (extra = {}) => ({ at: NOW - 1000, surface: 'sessions', kind: 'claude', task: T5, session: S5, seconds: 15, ...extra });
const rows = db => db.prepare('SELECT day, hour, surface, kind, task, session, client, page_s, working_s, waiting_s FROM usage_time ORDER BY start, surface, task').all();

test('beats are checked whole: unknown fields, too many, too long, odd surfaces or ids refuse the batch and store nothing', () => {
  const { db, usage } = setup();
  const bad = [
    {}, { beats: 'x' }, { beats: [], secret: 1 }, { beats: Array.from({ length: 41 }, () => beat()) },
    { beats: [beat({ seconds: 31 })] }, { beats: [beat({ seconds: 0 })] }, { beats: [beat({ seconds: 1.5 })] },
    { beats: [beat({ surface: 'terminal' })] }, { beats: [beat({ kind: 'vim' })] }, { beats: [beat({ title: 'Acme' })] },
    { beats: [beat({ task: 'local|5' })] }, { beats: [beat({ session: `${ME}|5` })] }, { beats: [beat({ task: `${K01}|5` })] },
    { beats: [beat({ text: 'rm -rf /' })] }, { beats: [beat({ at: 'now' })] }, { client: 'a b', beats: [beat()] },
  ];
  for (const body of bad) assert.throws(() => usage.recordBeats(body), { message: 'INVALID_USAGE_TIME' }, JSON.stringify(body).slice(0, 80));
  assert.equal(db.prepare('SELECT COUNT(*) FROM usage_time').pluck().get(), 0);
  // The caps themselves are allowed.
  assert.deepEqual(usage.recordBeats({ beats: Array.from({ length: 40 }, () => beat({ seconds: 30 })) }), { ok: true, accepted: 40, enabled: true });
});

test('beats roll up per UTC day, hour and key; a row is capped at an hour; stale, future and cleared beats are dropped', () => {
  const { db, clock, usage } = setup();
  usage.recordBeats({ beats: [beat(), beat(), beat({ at: NOW - HOUR - 1000 }), beat({ surface: 'learn', kind: null, task: null, session: null })] }, { client: 'phone' });
  assert.equal(rows(db).length, 3);
  const byHour = db.prepare("SELECT hour, SUM(page_s) AS s FROM usage_time WHERE surface = 'sessions' GROUP BY hour ORDER BY hour").all();
  assert.deepEqual(byHour, [{ hour: 10, s: 15 }, { hour: 11, s: 30 }], 'two beats of one hour and key are one row');
  assert.equal(db.prepare("SELECT COUNT(*) FROM usage_time WHERE surface = 'sessions' AND hour = 11").pluck().get(), 1);
  // The client kind: the batch's own, else the request's.
  usage.recordBeats({ beats: [beat()] }, { client: 'computer' });
  usage.recordBeats({ client: 'mac-app', beats: [beat()] }, { client: 'computer' });
  assert.deepEqual(db.prepare("SELECT client, page_s FROM usage_time WHERE hour = 11 AND surface = 'sessions' ORDER BY client").all(), [{ client: 'computer', page_s: 15 }, { client: 'mac-app', page_s: 15 }, { client: 'phone', page_s: 30 }]);
  // A row never holds more than an hour.
  for (let i = 0; i < 5; i += 1) usage.recordBeats({ beats: Array.from({ length: 40 }, () => beat({ seconds: 30, surface: 'other', task: null, session: null, kind: null })) });
  assert.equal(db.prepare("SELECT page_s FROM usage_time WHERE surface = 'other'").pluck().get(), 3600);
  // Older than a day, more than a minute ahead: dropped. `sent` moves the page's clock.
  assert.equal(usage.recordBeats({ beats: [beat({ at: NOW - 25 * HOUR }), beat({ at: NOW + 2 * 60 * 1000 })] }).accepted, 0);
  assert.equal(usage.recordBeats({ sent: NOW - 2 * HOUR, beats: [beat({ at: NOW - 2 * HOUR - 1000, surface: 'attention', task: null, session: null })] }).accepted, 1);
  assert.equal(db.prepare("SELECT hour FROM usage_time WHERE surface = 'attention'").pluck().get(), 11, 'moved to the server clock');
  // Clear: everything goes; a beat from before the Clear that arrives late is refused.
  assert.ok(usage.clearTime().cleared > 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM usage_time').pluck().get(), 0);
  clock.at = NOW + 5000;
  assert.equal(usage.recordBeats({ beats: [beat({ at: NOW - 10 })] }).accepted, 0);
  assert.equal(usage.recordBeats({ beats: [beat({ at: NOW + 4000 })] }).accepted, 1);
});

test('the switch: on by default, shared settings, and nothing is stored while it is off (beats and clocks)', () => {
  const { db, usage } = setup();
  assert.deepEqual(usage.settings(), { usage_time_record: true, usage_memories_digest: false });
  assert.deepEqual(usage.setSettings({ usage_time_record: false }), { usage_time_record: false, usage_memories_digest: false });
  assert.deepEqual(usage.recordBeats({ beats: [beat()] }), { ok: false, accepted: 0, enabled: false });
  assert.equal(usage.recordSession({ at: NOW, task: T5, session: S5, kind: 'claude', working: 30 }), false);
  assert.equal(db.prepare('SELECT COUNT(*) FROM usage_time').pluck().get(), 0);
  for (const body of [{}, { usage_time_record: 'no' }, { other: true }, []]) assert.throws(() => usage.setSettings(body), { message: 'INVALID_USAGE_TIME_SETTING' });
  assert.deepEqual(time.recordSync.exportForSync({ db }), { enabled: false });
  time.recordSync.importFromSync({ db }, 'me', { enabled: true });
  assert.equal(usage.recording(), true);
  assert.deepEqual(time.digestSync.exportForSync({ db }), null, 'off by default, never set');
  assert.throws(() => time.digestSync.importFromSync({ db }, 'me', { enabled: 'yes' }), { message: 'INVALID_SYNC_VALUE' });
});

// ---- The session clocks ----
function clockHarness({ start = NOW } = {}) {
  const { db, clock, usage } = setup({ now: start });
  clock.at = start;
  const live = new Map();
  const turns = [];
  const ticks = [];
  const timers = { setInterval: (fn, ms) => { ticks.push({ fn, ms }); return ticks.length; }, clearInterval() {} };
  const usageClock = createUsageClock({
    feed: () => [...live].map(([key, value]) => ({ task_id: Number(key.split('|')[0]), terminal_id: key.split('|')[1], ...value })),
    record: entry => usage.recordSession(entry), instanceId: () => ME, now: () => clock.at, onLongTurn: turn => turns.push(turn), timers,
  });
  const set = (key, state, agent = 'claude') => { if (state === 'idle') live.delete(key); else live.set(key, { state, agent }); usageClock.observe(); };
  const sums = () => db.prepare('SELECT session, kind, SUM(working_s) AS working, SUM(waiting_s) AS waiting FROM usage_time GROUP BY session, kind ORDER BY session').all();
  return { db, clock, usage, usageClock, set, sums, turns, ticks };
}

test('session clocks: Running time counts as agent working, a wait counts until the next input, written every 60 s and at the end', () => {
  const h = clockHarness();
  h.usageClock.start();
  assert.deepEqual(h.ticks.map(tick => tick.ms), [60000, 15000], 'a flush every minute and a look every 15 s');
  h.set('5|k1', 'running');
  h.clock.at += 90_000;
  h.ticks[0].fn(); // the minute's flush
  assert.deepEqual(h.sums(), [{ session: S5, kind: 'claude', working: 90, waiting: 0 }], 'written without any page');
  h.set('5|k1', 'waiting');
  h.clock.at += 40_000;
  h.usageClock.flush();
  assert.deepEqual(h.sums(), [{ session: S5, kind: 'claude', working: 90, waiting: 40 }]);
  h.clock.at += 20_000;
  h.usageClock.input(5, 'k1'); // the person answers: the wait ends here
  h.clock.at += 30_000; // the agent takes a moment to resume: not waiting for the person
  h.set('5|k1', 'running');
  h.clock.at += 10_000;
  h.set('5|k1', 'idle'); // the turn ends
  h.usageClock.ended(); // the terminal ends: written at once
  assert.deepEqual(h.sums(), [{ session: S5, kind: 'claude', working: 100, waiting: 60 }]);
  const waits = time.parseHist(h.db.prepare("SELECT waits FROM usage_time WHERE waits != ''").pluck().get());
  assert.equal(waits.reduce((a, b) => a + b, 0), 1, 'one finished wait');
  assert.equal(time.medianOf(waits), 90, 'a 60 s wait: the middle of its bucket, 60 to 120 s');
  assert.equal(h.usageClock.pendingCount(), 1, 'the rest of the current hour waits (under a second)');
  // Input to a terminal that does not wait changes nothing.
  h.usageClock.input(5, 'k1');
  h.usageClock.input(9, 'zz');
});

test('session clocks: a wait that stops without input ends there; hours are split; kinds follow the agent; a long turn is told once', () => {
  const start = Date.UTC(2026, 10, 24, 10, 50, 0);
  const h = clockHarness({ start });
  h.set('5|k1', 'running');
  h.set('7|nb', 'running', 'notebook');
  h.set('8|sh', 'waiting', null);
  h.clock.at = start + 40 * 60 * 1000; // 11:30, 40 minutes later
  h.set('5|k1', 'idle');
  h.set('8|sh', 'running', null); // it went on by itself (answered elsewhere): the wait ends without input
  h.usageClock.flush();
  const perHour = h.db.prepare("SELECT hour, session, kind, working_s, waiting_s FROM usage_time ORDER BY session, hour").all();
  assert.deepEqual(perHour, [
    { hour: 10, session: S5, kind: 'claude', working_s: 600, waiting_s: 0 },
    { hour: 11, session: S5, kind: 'claude', working_s: 1800, waiting_s: 0 },
    { hour: 10, session: `${ME}|7|nb`, kind: 'notebook', working_s: 600, waiting_s: 0 },
    { hour: 11, session: `${ME}|7|nb`, kind: 'notebook', working_s: 1800, waiting_s: 0 },
    { hour: 10, session: `${ME}|8|sh`, kind: 'terminal', working_s: 0, waiting_s: 600 },
    { hour: 11, session: `${ME}|8|sh`, kind: 'terminal', working_s: 0, waiting_s: 1800 },
  ]);
  assert.deepEqual(h.turns.map(turn => [turn.session, turn.seconds, turn.kind]), [[S5, 2400, 'claude']], 'the 40-minute turn, once');
  h.clock.at += 5 * 60 * 1000;
  h.usageClock.stop(); // shutdown writes the last seconds
  assert.equal(h.db.prepare("SELECT working_s FROM usage_time WHERE session = ? AND hour = 11").pluck().get(`${ME}|8|sh`), 300);
});

// ---- Queries ----
// A seeded week: rows of this week and the last one, on this engine and K01, page time, agents and waits.
function seed(usage, db) {
  const at = (day, hour) => Date.UTC(2026, 10, day, hour, 10, 0);
  const put = (when, values) => {
    const { day, hour, start } = time.hourOf(when);
    db.prepare(`INSERT INTO usage_time (uid, engine, client, day, hour, start, surface, kind, task, session, page_s, working_s, waiting_s, waits, rev, updated_at, sync_seq)
      VALUES (@uid, @engine, @client, @day, @hour, @start, @surface, @kind, @task, @session, @page_s, @working_s, @waiting_s, @waits, 1, @start, 0)`)
      .run({ uid: time.newUid(), engine: '', client: '', surface: '', kind: '', task: '', session: '', page_s: 0, working_s: 0, waiting_s: 0, waits: '', ...values, day, hour, start });
  };
  const hist = counts => JSON.stringify(time.WAIT_EDGES.map((_, i) => counts[i] || 0).concat(counts[time.WAIT_EDGES.length] || 0));
  // This week (Mon 23 / Tue 24, UTC hours).
  put(at(23, 2), { client: 'computer', surface: 'sessions', kind: 'claude', task: T5, session: S5, page_s: 1800 });
  put(at(23, 2), { kind: 'claude', task: T5, session: S5, working_s: 3600, waiting_s: 600, waits: hist({ 5: 3 }) });
  put(at(23, 3), { kind: 'claude', task: T5, session: S5, working_s: 3600 }); // nobody on the page
  put(at(24, 1), { client: 'phone', surface: 'learn', page_s: 900 });
  put(at(24, 3), { engine: K01, client: 'computer', surface: 'sessions', kind: 'codex', task: `${K01}|9`, session: `${K01}|9|c1`, page_s: 600, working_s: 1200, waits: hist({ 1: 1 }) });
  put(at(24, 4), { client: 'computer', surface: 'settings', page_s: 300 });
  // Last week, by the same time (Mon 16 / Tue 17).
  put(at(16, 2), { client: 'computer', surface: 'sessions', kind: 'claude', task: T5, session: S5, page_s: 600, working_s: 1000 });
  put(at(17, 1), { client: 'computer', surface: 'learn', page_s: 1200 });
  // Last week after the same time (Tue 17 20:00): not part of the comparison.
  put(at(17, 20), { client: 'computer', surface: 'learn', page_s: 3000 });
}

test('the summary of a seeded week: tiles with the change from last week, the median wait, days split sessions / learn / other, tasks, kinds, devices', () => {
  const { db, usage } = setup({ linked: () => [{ instanceId: K01, name: 'K01', supported: true }, { instanceId: 'cccccccc-0000-4000-8000-000000000003', name: 'M01', supported: false }] });
  db.prepare("INSERT INTO tasks (id, title) VALUES (5, 'Coach page')").run();
  db.prepare("INSERT INTO task_terminals (task_id, terminal_id, title) VALUES (5, 'k1', 'main dev')").run();
  seed(usage, db);
  const summary = usage.summary({ range: 'week', tz: 'UTC' });
  assert.equal(summary.since, Date.UTC(2026, 10, 23));
  assert.deepEqual(summary.tiles, {
    page_s: 1800 + 900 + 600 + 300, working_s: 3600 + 3600 + 1200, waiting_s: 600, learn_s: 900,
    page_delta: 3600 - 1800, working_delta: 8400 - 1000, waiting_delta: 600, learn_delta: 900 - 1200,
    median_wait_s: 220 /* 4 waits: one of 15-30 s, three of 180-300 s */, learn_days: 1, days_in_range: 2,
    away_working_s: Math.round(3600 * 0.5 + 3600 + 1200 * (1 - 600 / 3600)),
  });
  assert.deepEqual(summary.days, [{ day: '2026-11-23', sessions_s: 1800, learn_s: 0, other_s: 0 }, { day: '2026-11-24', sessions_s: 600, learn_s: 900, other_s: 300 }]);
  assert.deepEqual(summary.tasks, [
    { task: T5, title: 'Coach page', looked_s: 1800, worked_s: 7200, waiting_s: 600 },
    { task: `${K01}|9`, title: null, looked_s: 600, worked_s: 1200, waiting_s: 0 },
  ]);
  assert.deepEqual(summary.kinds, [{ kind: 'claude', share: 0.83 }, { kind: 'codex', share: 0.17 }]);
  assert.deepEqual(summary.devices.map(device => [device.name, device.self, device.supported]), [['T01', true, true], ['K01', false, true], ['M01', false, false]]);
  // One device: only its rows.
  const onlyK = usage.summary({ range: 'week', device: K01, tz: 'UTC' });
  assert.deepEqual([onlyK.tiles.page_s, onlyK.tiles.working_s], [600, 1200]);
  assert.equal(usage.summary({ range: 'week', device: ME, tz: 'UTC' }).tiles.page_s, 3000);
  // Today and 30 days.
  const today = usage.summary({ range: 'today', tz: 'UTC' });
  assert.deepEqual([today.tiles.page_s, today.tiles.learn_delta, today.tiles.page_delta, today.days.length], [1800, 900, 1800 - 1800, 1]);
  const month = usage.summary({ range: '30d', tz: 'UTC' });
  assert.equal(month.days.length, 30);
  assert.equal(month.tiles.page_s, 3600 + 600 + 1200 + 3000);
  for (const query of [{ range: 'year' }, { range: 'week', device: 'K 01' }]) assert.throws(() => usage.summary(query), { message: 'INVALID_USAGE_TIME_QUERY' });
  // A task's sessions and a day's tasks.
  const task = usage.task({ task: T5, range: 'week', tz: 'UTC' });
  assert.deepEqual(task.sessions, [{ session: S5, title: 'main dev', kind: 'claude', looked_s: 1800, worked_s: 7200, waiting_s: 600 }]);
  const day = usage.day({ day: '2026-11-24', tz: 'UTC' });
  assert.deepEqual(day.tasks.map(entry => [entry.task, entry.sessions.length]), [[`${K01}|9`, 1]]);
  assert.deepEqual(day.surfaces, { sessions: 600, learn: 900, mindmaps: 0, attention: 0, settings: 300, other: 0 });
  for (const query of [{ day: '2026-13-01' }, { day: 'today' }]) assert.throws(() => usage.day(query), { message: 'INVALID_USAGE_TIME_QUERY' });
  assert.throws(() => usage.task({ task: '5' }), { message: 'INVALID_USAGE_TIME_QUERY' });
});

test('time zones and day boundaries: the same rows fall on other local days and weeks in Taipei than in UTC', () => {
  const { db, usage } = setup();
  seed(usage, db);
  // In Taipei (UTC+8) it is Tuesday 20:00; Mon 23 02:10 UTC is Monday 10:10 there, Tue 24 04:10 UTC is Tuesday 12:10.
  const taipei = usage.summary({ range: 'week', tz: 'Asia/Taipei' });
  assert.equal(taipei.since, Date.UTC(2026, 10, 22, 16));
  assert.deepEqual(taipei.days.map(entry => entry.day), ['2026-11-23', '2026-11-24']);
  // The learn row of Tue 24 01:10 UTC is Tue 09:10 in Taipei; last week's learn row at Tue 17 20:10 UTC is Wed 04:10 in Taipei: later than now - 7 days.
  assert.equal(taipei.tiles.learn_delta, 900 - 1200);
  // In Los Angeles (UTC-8) it is Tuesday 04:00: the rows of Mon 23 02:10 UTC are Sunday the 22nd, last week.
  const la = usage.summary({ range: 'week', tz: 'America/Los_Angeles' });
  assert.deepEqual(la.days.map(entry => entry.day), ['2026-11-23', '2026-11-24']);
  assert.equal(la.days[0].sessions_s, 600, 'Monday 02:10 UTC is Sunday evening there (last week); K01\'s Tuesday 03:10 UTC is Monday there');
  assert.equal(la.tiles.page_s, 900 + 600 + 300);
  // An unknown zone falls back to the server's own.
  assert.equal(typeof usage.summary({ range: 'today', tz: 'Mars/Base' }).tz, 'string');
  // Helpers: local midnight across a DST change and ISO weeks.
  assert.equal(time.localMidnight(Date.UTC(2026, 2, 8, 12), 'America/New_York'), Date.UTC(2026, 2, 8, 5));
  assert.equal(time.midnightPlus(Date.UTC(2026, 2, 8, 5), 1, 'America/New_York'), Date.UTC(2026, 2, 9, 4));
  assert.deepEqual(time.isoWeek(NOW, 'UTC'), { week: '2026-W48', start: Date.UTC(2026, 10, 23) });
  assert.equal(time.weekStart('2026-W01', 'UTC'), Date.UTC(2025, 11, 29));
  assert.equal(time.weekStart('2026-W60', 'UTC'), null);
});

test('task titles: this engine\'s task list, and the last list read from a linked engine (as the page shows it)', () => {
  const { db, usage } = setup();
  db.prepare("INSERT INTO tasks (id, title) VALUES (5, 'Coach page')").run();
  db.prepare("INSERT INTO remote_servers (id, owner_id, name, base_url, token_cipher) VALUES (7, 'me', 'K01', 'http://k01', 'x')").run();
  db.prepare("INSERT INTO system_state (key, value) VALUES ('remote_engine_instances_v1', ?)").run(JSON.stringify({ 7: K01 }));
  require('../services/linked-last-tasks').createLinkedLastTasks({ db }).remember(7, [{ id: 9, title: 'Release notes', status: 'todo' }]);
  assert.equal(usage.taskTitle(T5), 'Coach page');
  assert.equal(usage.taskTitle(`${K01}|9`), 'Release notes');
  assert.equal(usage.taskTitle(`${K01}|10`), null);
  assert.equal(usage.taskTitle(`${ME}|99`), null);
});

// ---- Routes ----
async function serve({ login = true, digest = null } = {}) {
  const { db, clock, usage } = setup();
  const memories = createMemories({ db, now: () => clock.at, usage });
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => (login ? next() : res.status(401).json({ error: 'AUTH_REQUIRED' }));
  const routers = createUsageTimeRouters({ usage, memories, digest, requireAuth });
  app.use('/api/usage-time', routers.time);
  app.use('/api/memories', routers.memories);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let parsed = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* a CSV */ }
    return { status: response.status, body: parsed, headers: response.headers };
  };
  return { db, clock, usage, memories, call, close: () => new Promise(resolve => server.close(resolve)) };
}

test('routes: every one needs the page login', async () => {
  const s = await serve({ login: false });
  try {
    for (const [method, url] of [['GET', '/api/usage-time/settings'], ['PUT', '/api/usage-time/settings'], ['POST', '/api/usage-time/beats'], ['GET', '/api/usage-time/summary'],
      ['GET', '/api/usage-time/task'], ['GET', '/api/usage-time/day'], ['GET', '/api/usage-time/export'], ['DELETE', '/api/usage-time?table=time'],
      ['GET', '/api/memories'], ['POST', '/api/memories'], ['PATCH', '/api/memories/x'], ['DELETE', '/api/memories/x'], ['POST', '/api/memories/event'], ['POST', '/api/memories/digest']]) {
      assert.equal((await s.call(method, url, {})).status, 401, `${method} ${url}`);
    }
  } finally { await s.close(); }
});

test('routes: beats from a phone, the summary with where, task and day, export as JSON and CSV, Clear per tab', async () => {
  const s = await serve();
  try {
    const phone = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148' };
    assert.deepEqual((await s.call('POST', '/api/usage-time/beats', { beats: [beat()] }, phone)).body, { ok: true, accepted: 1, enabled: true });
    assert.equal(s.db.prepare('SELECT client FROM usage_time').pluck().get(), 'phone');
    assert.deepEqual((await s.call('POST', '/api/usage-time/beats', { beats: [beat({ seconds: 99 })] })).body, { error: 'INVALID_USAGE_TIME' });
    const summary = (await s.call('GET', '/api/usage-time/summary?range=today&tz=UTC')).body;
    assert.equal(summary.tiles.page_s, 15);
    assert.deepEqual(summary.where, { company_computer: false, hands_over: false, home_name: null, home_online: null, waiting: 0, shared_with: [] });
    assert.equal((await s.call('GET', '/api/usage-time/summary?range=year')).status, 400);
    assert.equal((await s.call('GET', `/api/usage-time/task?task=${encodeURIComponent(T5)}&range=today`)).body.sessions.length, 1);
    assert.equal((await s.call('GET', '/api/usage-time/day?day=2026-11-24&tz=UTC')).body.page_s, 15);
    assert.deepEqual((await s.call('PUT', '/api/usage-time/settings', { usage_memories_digest: true })).body, { usage_time_record: true, usage_memories_digest: true });
    assert.equal((await s.call('PUT', '/api/usage-time/settings', { usage_memories_digest: 1 })).status, 400);

    const json = await s.call('GET', '/api/usage-time/export?table=time&format=json');
    assert.match(json.headers.get('content-disposition'), /t-agent-usage-time-\d{4}-\d{2}-\d{2}\.json/);
    assert.deepEqual(json.body.time.map(row => [row.engine, row.engine_name, row.client, row.page_s, row.task]), [[ME, 'T01', 'phone', 15, T5]]);
    assert.equal(json.body.time.some(row => 'uid' in row || 'rev' in row || 'sync_seq' in row), false);
    const csv = await s.call('GET', '/api/usage-time/export?table=time&format=csv');
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.equal(csv.body.split('\n')[0], 'day,hour,start,engine,engine_name,client,surface,kind,task,session,page_s,working_s,waiting_s');
    await s.call('POST', '/api/memories', { text: '=HYPERLINK("x"), with "quotes"' });
    const notesCsv = (await s.call('GET', '/api/usage-time/export?table=memories&format=csv')).body;
    assert.match(notesCsv, /"'=HYPERLINK\(""x""\), with ""quotes"""/, 'quoted, and a formula is not run by a spreadsheet');
    assert.equal((await s.call('GET', '/api/usage-time/export?table=other')).status, 400);

    assert.equal((await s.call('DELETE', '/api/usage-time')).status, 400, 'Clear names its tab');
    assert.deepEqual((await s.call('DELETE', '/api/usage-time?table=time')).body, { cleared: 1 });
    assert.equal(s.db.prepare('SELECT COUNT(*) FROM memories WHERE deleted = 0').pluck().get(), 1, 'the other tab is kept');
    assert.deepEqual((await s.call('DELETE', '/api/usage-time?table=memories')).body, { cleared: 1 });
    assert.equal((await s.call('GET', '/api/memories')).body.items.length, 0);
  } finally { await s.close(); }
});

test('nothing but seconds, kinds and ids is stored: no text field of a beat reaches the table', () => {
  const columns = new Database(':memory:');
  columns.exec(SCHEMA);
  const names = columns.prepare('PRAGMA table_info(usage_time)').all().map(column => column.name);
  assert.deepEqual(names, ['uid', 'engine', 'client', 'day', 'hour', 'start', 'surface', 'kind', 'task', 'session', 'page_s', 'working_s', 'waiting_s', 'waits', 'rev', 'updated_at', 'sync_seq']);
});
