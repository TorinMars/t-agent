// The desktop window's one request per tick (GET /api/attention/widget/tick, "T-Attention desktop window (macOS)" in docs/design/attention-desktop-window.md) and the kept
// list behind it: the database queries and remote requests of a tick in which nothing changed (none), the list again after a local change,
// after a terminal starts, after the remote TTL and after the window's own change, the etag, the preferences and the notices in the same
// answer; the finished items read with `recent_finished` (services/attention.js list, routes/attention.js) and its index; GET /items as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-widget-tick-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'widget-tick-test-secret-widget-tick-test-secret-0123';
fs.mkdirSync(process.env.TASKS_BASE_DIR, { recursive: true });

const express = require('express');
const Database = require('better-sqlite3');
const db = require('../db');
const { defaultService, createAttentionService } = require('../services/attention');
const { createAttentionRoutes } = require('../routes/attention');
const { RemoteAttentionError } = require('../services/remote-attention');
const { createWidgetSettings } = require('../services/attention-widget');
const { createWidgetNotices } = require('../services/widget-notices');
const { createAttentionWidgetRoutes } = require('../routes/attention-widget');

const OWNER = 'owner';
const TOKEN = 'widget-token-0123456789-abcdefghijklmnopqrstuv';
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const FINISHED = ['done', 'failed', 'cancelled'];
const service = defaultService();
const servers = [];
test.after(() => { for (const server of servers) server.close(); fs.rmSync(root, { recursive: true, force: true }); });

const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); servers.push(server); });
async function call(method, url, body) {
  const response = await fetch(url, { method, headers: { ...AUTH, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

// Every statement this database runs while fn runs (all / get / run / iterate), with the SQL.
async function queries(fn) {
  const ran = [];
  const original = db.prepare;
  db.prepare = function prepare(sql, ...rest) {
    const statement = original.call(this, sql, ...rest);
    return new Proxy(statement, { get(target, name) {
      const value = Reflect.get(target, name, target);
      if (typeof value !== 'function') return value;
      return (...args) => { if (['all', 'get', 'run', 'iterate'].includes(name)) ran.push(sql); return value.apply(target, args); };
    } });
  };
  try { await fn(); } finally { db.prepare = original; }
  return ran;
}

// A connected service: `modern` answers `recent_finished` like this version, otherwise it ignores it like an older one.
function fakeRemote() {
  const engines = new Map();
  const add = (name, options = {}) => { const engine = { items: [], calls: [], modern: true, ...options }; engines.set(name, engine); return engine; };
  async function remoteCall(row, { method, path: pathname = '', body }) {
    const engine = engines.get(row.name);
    engine.calls.push({ method, path: pathname, body });
    if (engine.fail) throw new RemoteAttentionError(502, { error: 'REMOTE_CONNECTION_FAILED' });
    const [route, query = ''] = pathname.split('?');
    if (method === 'GET' && !route) {
      const params = new URLSearchParams(query);
      if (params.get('status')) return { items: engine.items.filter(item => params.get('status').split(',').includes(item.status)) };
      const open = engine.items.filter(item => !FINISHED.includes(item.status));
      const recent = Number(params.get('recent_finished'));
      if (!engine.modern || !recent) return { items: open };
      const finished = engine.items.filter(item => FINISHED.includes(item.status)).sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at))).slice(0, recent);
      return { items: [...open, ...finished], recent_finished: recent };
    }
    const id = Number(/^\/(\d+)/.exec(route)?.[1]);
    const item = engine.items.find(entry => entry.id === id);
    if (!item) throw new RemoteAttentionError(404, { error: 'NOT_FOUND', message: 'Task not found' });
    if (method === 'GET') return { item, events: [] };
    if (method === 'PATCH') { Object.assign(item, body); return item; }
    throw new RemoteAttentionError(404, { error: 'NOT_FOUND' });
  }
  return { add, engines, remote: { call: remoteCall } };
}
const remoteRow = name => Number(db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher, enabled) VALUES (?, ?, ?, ?, ?)').run(OWNER, name, `http://${name.toLowerCase()}.test`, 'x', 1).lastInsertRowid);
const reset = () => { db.prepare('DELETE FROM attention_items').run(); db.prepare('DELETE FROM remote_servers').run(); db.prepare("DELETE FROM system_state WHERE key LIKE 'attention_widget_%'").run(); };

async function widgetApp({ remote = fakeRemote().remote, ...rest } = {}) {
  const clock = { now: Date.parse('2026-11-18T10:00:00Z') };
  const settings = createWidgetSettings({ db });
  const live = new Set(); // '<task>:<terminal>' of the running shells
  const counts = { live: 0, activity: 0 };
  const routes = createAttentionWidgetRoutes({
    service, db, settings, remote, owner: () => OWNER, hiddenDevices: () => [],
    launcher: { verifyToken: value => value === TOKEN, setEnabled: async () => {}, status: async () => ({}) },
    localName: () => 'Studio Mac', localInstanceId: () => 'local-instance', remoteInstanceId: row => `instance-${row.name}`,
    notices: createWidgetNotices({ now: () => clock.now }),
    terminalInfo: () => { throw new Error('the list never asks one terminal at a time'); },
    liveTerminals: taskId => { counts.live += 1; return [...live].filter(key => key.startsWith(`${taskId}:`)).map(key => key.split(':')[1]); },
    liveActivity: () => { counts.activity += 1; return []; },
    now: () => new Date(clock.now),
    ...rest,
  });
  const app = express();
  app.use('/api/attention/widget', routes.bearer);
  app.use(express.json());
  app.use('/api/attention/widget/settings', (req, res, next) => { req.session = { user: { login: OWNER } }; next(); }, routes.settings);
  const base = `${await listen(app)}/api/attention/widget`;
  return { base, clock, live, counts, settings, routes };
}

test('recent_finished: the open items, then the items finished last by completed_at, under the same filters; ignored with a status or include_done', async () => {
  reset();
  const at = { now: Date.parse('2026-11-01T00:00:00Z') };
  const timed = createAttentionService({ db, now: () => new Date(at.now) });
  const parent = timed.create({ title: 'Parent', status: 'working' }, { actor: 'user' });
  const finished = [];
  for (let index = 0; index < 8; index += 1) {
    at.now += 60 * 1000;
    const item = timed.create({ title: `Finished ${index}`, status: 'todo', ...(index % 2 ? { parent_id: parent.id } : {}) }, { actor: 'user' });
    finished.push(item);
  }
  // Finished in another order than they were made (and than their sort_order): 5, 2, 7, 0, 6, 1, 4, 3.
  for (const index of [5, 2, 7, 0, 6, 1, 4, 3]) { at.now += 60 * 1000; timed.update(finished[index].id, { status: FINISHED[index % 3] }, { actor: 'user' }); }
  const open = timed.create({ title: 'Open one', status: 'review' }, { actor: 'user' });
  const titles = list => list.map(item => item.title);
  assert.deepEqual(titles(timed.list({ recentFinished: 3 })), ['Open one', 'Parent', 'Finished 3', 'Finished 4', 'Finished 1']);
  assert.deepEqual(titles(timed.list({})), ['Open one', 'Parent'], 'without it: the open items only, as before');
  assert.deepEqual(titles(timed.list({ parent: parent.id, recentFinished: 2 })), ['Finished 3', 'Finished 1']);
  assert.deepEqual(titles(timed.list({ q: 'Finished 7', recentFinished: 5 })), ['Finished 7']);
  assert.equal(timed.list({ status: 'done', recentFinished: 1 }).length, 3, 'a status filter decides itself');
  assert.equal(timed.list({ includeDone: true, recentFinished: 1 }).length, 10);
  assert.throws(() => timed.list({ recentFinished: 'x' }), /recent_finished must be an integer/);
  assert.throws(() => timed.list({ recentFinished: 0 }), /recent_finished must be an integer/);

  // Over HTTP (the same on /v1/attention): the answer names the number when the list has them.
  const app = express();
  app.use(express.json());
  app.use('/api/attention', (req, res, next) => { req.session = { user: { login: OWNER } }; next(); }, createAttentionRoutes({ service: timed }).router);
  const base = await listen(app);
  const get = async query => (await fetch(`${base}/api/attention${query}`)).json();
  const answer = await get('?recent_finished=2');
  assert.equal(answer.recent_finished, 2);
  assert.deepEqual(titles(answer.items), ['Open one', 'Parent', 'Finished 3', 'Finished 4']);
  assert.equal((await get('')).recent_finished, undefined);
  assert.equal((await get('?status=done&recent_finished=2')).recent_finished, undefined);
  assert.equal((await get('?recent_finished=-1')).error, 'VALIDATION_FAILED');
  assert.ok(open.id);
});

test('the finished items are read along idx_attention_items_completed, which an older database gets too', () => {
  const index = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_attention_items_completed'").get();
  assert.ok(index, 'db/index.js runs schema.sql at every start');
  // A database made before the index: the service adds it.
  const older = new Database(':memory:');
  older.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  older.exec('DROP INDEX idx_attention_items_completed');
  createAttentionService({ db: older });
  assert.ok(older.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_attention_items_completed'").get());
  const plans = [];
  const original = older.prepare;
  older.prepare = function prepare(sql) { if (/completed_at DESC/.test(sql)) plans.push(original.call(this, `EXPLAIN QUERY PLAN ${sql}`)); return original.call(this, sql); };
  const recorded = createAttentionService({ db: older });
  recorded.list({ recentFinished: 5 });
  older.prepare = original;
  assert.equal(plans.length, 1);
  const detail = plans[0].all(...FINISHED, 5).map(row => row.detail).join(' | ');
  assert.match(detail, /USING INDEX idx_attention_items_completed/, detail);
  assert.doesNotMatch(detail, /USE TEMP B-TREE FOR ORDER BY/, 'never a sort of every finished item');
  older.close();
});

test('tick: one answer with the list, notices, activity and prefs; nothing changed -> no query, no remote request and list null', async () => {
  reset();
  const fake = fakeRemote();
  const laptop = fake.add('Laptop');
  laptop.items.push({ id: 1, title: 'Remote open', status: 'waiting_user', sort_order: 5, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z' });
  for (let index = 0; index < 60; index += 1) laptop.items.push({ id: 100 + index, title: `Remote done ${index}`, status: 'done', sort_order: index, completed_at: `2026-11-02T00:${String(index).padStart(2, '0')}:00.000Z` });
  const laptopId = remoteRow('Laptop');
  const task = { id: 41 };
  const tied = service.create({ title: 'Tied to a terminal', status: 'waiting_user', context: { tagent: { task_id: String(task.id), terminal_id: 'term-a' } } }, { actor: 'user' });
  for (let index = 0; index < 5; index += 1) service.create({ title: `Local open ${index}`, status: 'todo', context: { tagent: { task_id: String(task.id), terminal_id: `term-${index}` } } }, { actor: 'user' });
  const { base, clock, counts, live } = await widgetApp({ remote: fake.remote });

  const first = await call('GET', `${base}/tick`);
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.body).sort(), ['activity', 'etag', 'list', 'notices', 'prefs', 'updated_at']);
  assert.match(first.body.etag, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(first.body.notices, { seq: 0, notices: [] });
  assert.deepEqual(first.body.prefs, { hotkeys: true, dim_when_idle: true, show_activity: true });
  assert.deepEqual(first.body.activity.terminals, []);
  assert.deepEqual(laptop.calls.map(entry => entry.path), ['?limit=1000&recent_finished=50', '?status=done,failed,cancelled&limit=1000'],
    'a service not known yet: both reads, in parallel');
  const items = first.body.list.items;
  assert.equal(items.filter(item => item.status === 'done').length, 50);
  assert.ok(!items.some(item => item.title === 'Remote done 9') && items.some(item => item.title === 'Remote done 10'), 'the 50 finished last');
  assert.deepEqual(first.body.list.engines.map(engine => engine.key), ['local', `remote:${laptopId}`]);
  assert.equal(items.find(item => item.key === `local:${tied.id}`).session.live, false);
  // GET /items answers the same list.
  const items2 = await call('GET', `${base}/items`);
  assert.deepEqual(items2.body.items, items);
  assert.deepEqual(items2.body.engines, first.body.list.engines);
  laptop.calls.length = 0;

  // Nothing changed: no query (the list, the engines, the agents, the prefs are kept), no remote request, list null with the same etag.
  let answer;
  clock.now += 5000;
  const ran = await queries(async () => { answer = await call('GET', `${base}/tick?items=${first.body.etag}&after=0`); });
  assert.deepEqual(ran, []);
  assert.deepEqual(laptop.calls, []);
  assert.equal(answer.body.list, null);
  assert.equal(answer.body.etag, first.body.etag);
  // Without the etag (or with another one) the list is sent again, still from what is kept.
  const again = await queries(async () => { answer = await call('GET', `${base}/tick?items=somethingelse`); });
  assert.deepEqual(again, []);
  assert.deepEqual(answer.body.list.items, items);

  // A terminal starts: the list changes at once (whether shells run is asked in memory; the agents are read in one query).
  live.add(`${task.id}:term-a`);
  const started = await queries(async () => { answer = await call('GET', `${base}/tick?items=${first.body.etag}`); });
  assert.equal(started.length, 1, started.join('\n'));
  assert.match(started[0], /FROM task_terminals WHERE task_id IN/);
  assert.notEqual(answer.body.etag, first.body.etag);
  assert.equal(answer.body.list.items.find(item => item.key === `local:${tied.id}`).session.live, true);
  assert.ok(counts.live >= 1);

  // A local change (the change bus): the local part is read again (one list query), the remote is not.
  const etag = answer.body.etag;
  service.update(tied.id, { title: 'Renamed here' }, { actor: 'user' });
  const changed = await queries(async () => { answer = await call('GET', `${base}/tick?items=${etag}`); });
  assert.deepEqual(changed.filter(sql => /attention_items/.test(sql)).length, 2, 'the open items and the finished ones');
  assert.deepEqual(laptop.calls, []);
  assert.equal(answer.body.list.items.find(item => item.key === `local:${tied.id}`).title, 'Renamed here');

  // activity=0: the terminals' activity is not asked.
  const before = counts.activity;
  answer = await call('GET', `${base}/tick?items=${answer.body.etag}&activity=0`);
  assert.equal(answer.body.activity, null);
  assert.equal(counts.activity, before);
  assert.equal((await call('GET', `${base}/tick?after=-1`)).status, 400);
});

test('tick: a failing activity read is no activity, not a failed tick', async () => {
  reset();
  service.create({ title: 'Still listed', status: 'todo' }, { actor: 'user' });
  const { base } = await widgetApp({ liveActivity: () => { throw new Error('terminals broke'); } });
  const errors = [];
  const original = console.error;
  console.error = line => errors.push(String(line));
  let answer;
  try { answer = await call('GET', `${base}/tick`); } finally { console.error = original; }
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.activity.terminals, []);
  assert.deepEqual(answer.body.list.items.map(item => item.title), ['Still listed']);
  assert.equal(errors.length, 1);
  assert.equal((await call('GET', `${base}/activity`)).status, 500, 'GET /activity answers as before');
});

test('tick: a remote is read again after its TTL, one request for a known new service, and at once after the window changed one of its items', async () => {
  reset();
  const fake = fakeRemote();
  const laptop = fake.add('Laptop');
  laptop.items.push({ id: 1, title: 'Remote one', status: 'waiting_user', sort_order: 2 }, { id: 2, title: 'Remote two', status: 'review', sort_order: 1 });
  const old = fake.add('Old', { modern: false });
  old.items.push({ id: 7, title: 'On an older service', status: 'todo', sort_order: 1 }, { id: 8, title: 'Done there', status: 'done', completed_at: '2026-11-01T00:00:00.000Z' });
  const laptopId = remoteRow('Laptop');
  remoteRow('Old');
  const { base, clock } = await widgetApp({ remote: fake.remote });
  let answer = await call('GET', `${base}/tick`);
  assert.ok(answer.body.list.items.some(item => item.title === 'Done there'), 'an older service: its finished items read as before');
  let etag = answer.body.etag;
  laptop.calls.length = 0;
  old.calls.length = 0;

  // Changed there, but within the TTL: not read, the window keeps its list.
  laptop.items[0].title = 'Changed remotely';
  clock.now += 9000;
  answer = await call('GET', `${base}/tick?items=${etag}`);
  assert.equal(answer.body.list, null);
  assert.equal(laptop.calls.length, 0);
  // At the TTL: one read of the new service, two of the older one (in parallel), and the change comes.
  clock.now += 1000;
  answer = await call('GET', `${base}/tick?items=${etag}`);
  assert.deepEqual(laptop.calls.map(entry => entry.path), ['?limit=1000&recent_finished=50']);
  assert.equal(old.calls.length, 2);
  assert.equal(answer.body.list.items.find(item => item.key === `remote:${laptopId}:1`).title, 'Changed remotely');
  etag = answer.body.etag;

  // The window's own change on that service: read again by the next tick, before the TTL.
  laptop.calls.length = 0;
  clock.now += 1000;
  const patched = await call('PATCH', `${base}/items/remote:${laptopId}:2`, { title: 'Renamed in the window' });
  assert.equal(patched.status, 200);
  answer = await call('GET', `${base}/tick?items=${etag}`);
  assert.deepEqual(laptop.calls.map(entry => entry.method + ' ' + entry.path), ['PATCH /2', 'GET ?limit=1000&recent_finished=50']);
  assert.equal(answer.body.list.items.find(item => item.key === `remote:${laptopId}:2`).title, 'Renamed in the window');
  // A refused action also has it read again.
  laptop.calls.length = 0;
  assert.equal((await call('POST', `${base}/items/remote:${laptopId}:1/confirm`, {})).status, 409);
  await call('GET', `${base}/tick?items=${answer.body.etag}`);
  assert.equal(laptop.calls.filter(entry => entry.method === 'GET' && entry.path.startsWith('?')).length, 1);

  // A failing service is named in failed, kept for the TTL, and tried again after it.
  laptop.fail = true;
  clock.now += 10000;
  answer = await call('GET', `${base}/tick`);
  assert.deepEqual(answer.body.list.failed, ['Laptop']);
  laptop.calls.length = 0;
  clock.now += 5000;
  answer = await call('GET', `${base}/tick`);
  assert.equal(laptop.calls.length, 0);
  assert.deepEqual(answer.body.list.failed, ['Laptop']);
  laptop.fail = false;
  clock.now += 5000;
  answer = await call('GET', `${base}/tick`);
  assert.deepEqual(answer.body.list.failed, []);
});

test('tick: a slow remote read that only its age asked for does not hold the tick; the next tick has it', async () => {
  reset();
  const fake = fakeRemote();
  const laptop = fake.add('Laptop');
  laptop.items.push({ id: 1, title: 'Before', status: 'todo', sort_order: 1 });
  remoteRow('Laptop');
  const { base, clock } = await widgetApp({ remote: fake.remote, tickWaitMs: 30 });
  let answer = await call('GET', `${base}/tick`);
  const etag = answer.body.etag;
  laptop.items[0].title = 'After';
  const original = fake.remote.call;
  let release;
  fake.remote.call = async (...args) => { await new Promise(resolve => { release = resolve; }); return original(...args); };
  clock.now += 10000;
  const started = Date.now();
  answer = await call('GET', `${base}/tick?items=${etag}`);
  assert.ok(Date.now() - started < 1000);
  assert.equal(answer.body.list, null, 'the part as it was meanwhile');
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  fake.remote.call = original;
  answer = await call('GET', `${base}/tick?items=${etag}`);
  assert.equal(answer.body.list.items[0].title, 'After');
});

test('tick: the prefs are kept, and a save on the settings card is in the next tick; notices come with after', async () => {
  reset();
  const { base, settings, routes } = await widgetApp();
  assert.equal((await call('GET', `${base}/tick`)).body.prefs.show_activity, true);
  // Saved somewhere else than the card: within the TTL the kept value stays.
  settings.save({ show_activity: false });
  assert.equal((await call('GET', `${base}/tick`)).body.prefs.show_activity, true);
  // Saved on the card (PUT /settings): at once.
  const app = express();
  app.use(express.json());
  app.use('/settings', (req, res, next) => { req.session = { user: { login: OWNER } }; next(); }, routes.settings);
  const card = await listen(app);
  const put = await fetch(`${card}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dim_when_idle: false }) });
  assert.equal(put.status, 200);
  const prefs = (await call('GET', `${base}/tick`)).body.prefs;
  assert.deepEqual(prefs, { hotkeys: true, dim_when_idle: false, show_activity: false });
  settings.save({ show_activity: true, dim_when_idle: true });
});

test('tick: notices after a seq, as GET /notices answers them', async () => {
  reset();
  const notices = createWidgetNotices({});
  const { base } = await widgetApp({ notices });
  notices.push({ kind: 'direct', title: 'One', text: 'first' });
  notices.push({ kind: 'direct', title: 'Two', text: 'second' });
  const answer = await call('GET', `${base}/tick?after=1`);
  assert.deepEqual(answer.body.notices, (await call('GET', `${base}/notices?after=1`)).body);
  assert.deepEqual(answer.body.notices.notices.map(notice => notice.title), ['Two']);
});

test('per minute with nothing changed: the old endpoints against /tick (queries and remote requests)', async () => {
  reset();
  const fake = fakeRemote();
  const laptop = fake.add('Laptop');
  for (let index = 0; index < 20; index += 1) laptop.items.push({ id: index + 1, title: `Remote ${index}`, status: index % 4 ? 'todo' : 'done', sort_order: index, completed_at: index % 4 ? null : `2026-11-01T00:00:${String(index).padStart(2, '0')}.000Z` });
  remoteRow('Laptop');
  for (let index = 0; index < 20; index += 1) service.create({ title: `Local ${index}`, status: 'waiting_user', context: { tagent: { task_id: '7', terminal_id: `t${index}` } } }, { actor: 'user' });
  const old = await widgetApp({ remote: fake.remote });
  await call('GET', `${old.base}/items`); // the remote is known from here on
  const minute = async (app, tick) => {
    laptop.calls.length = 0;
    const ran = await queries(async () => { for (let index = 0; index < 12; index += 1) { app.clock.now += 5000; await tick(app); } });
    return { queries: ran.length, remote: laptop.calls.length };
  };
  const before = await minute(old, async app => { for (const name of ['items', 'notices', 'activity', 'prefs']) await call('GET', `${app.base}/${name}`); });
  const fresh = await widgetApp({ remote: fake.remote });
  let etag = (await call('GET', `${fresh.base}/tick`)).body.etag;
  const after = await minute(fresh, async app => { etag = (await call('GET', `${app.base}/tick?items=${etag}`)).body.etag; });
  // The old endpoints: /items reads everything every time (still one query for all the terminals, no longer one per item).
  assert.equal(before.remote, 12);
  assert.ok(before.queries >= 12 * 4, JSON.stringify(before));
  // /tick: the remote every 10 s; the engines and prefs every 30 s, the agents every 60 s.
  assert.equal(after.remote, 6, JSON.stringify(after));
  assert.ok(after.queries <= 12, JSON.stringify(after));
  console.log(`# per minute, nothing changed: old endpoints ${before.queries} queries / ${before.remote} remote reads; tick ${after.queries} queries / ${after.remote} remote reads`);
});
