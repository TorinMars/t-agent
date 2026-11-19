// Usage data on the server (services/ui-events.js, routes/ui-events.js; "Usage data" in docs/design/usage-data.md): the switch, the checks of a batch,
// the caps, the login, retention, the summary (top keys, unused controls, next-click pairs), export and clear.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const { createUiEvents, startRetention, DAY } = require('../services/ui-events');
const { createUiEventsRouter } = require('../routes/ui-events');

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
function database() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  return db;
}
const event = (key, extra = {}) => ({ at: NOW, key, surface: 'bottom-row', view: 'sessions', layout: 'wide', input: 'pointer', pane: false, device: 'local', ...extra });
const batch = (events, extra = {}) => ({ page: 'abc123', sent: NOW, events, ...extra });

async function serve(service, { login = true } = {}) {
  const app = express();
  app.use(express.json({ limit: '32mb' }));
  const requireAuth = (req, res, next) => (login ? next() : res.status(401).json({ error: 'AUTH_REQUIRED' }));
  app.use('/api/ui-events', createUiEventsRouter({ service, requireAuth }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/ui-events`;
  const call = async (method, url = '', body) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  };
  return { call, close: () => new Promise(resolve => server.close(resolve)) };
}

test('the switch is on by default, per server, and only takes { enabled: boolean }', async () => {
  const db = database();
  const { call, close } = await serve(createUiEvents({ db, now: () => NOW }));
  try {
    assert.deepEqual((await call('GET', '/settings')).body, { enabled: true });
    assert.deepEqual((await call('PUT', '/settings', { enabled: false })).body, { enabled: false });
    assert.deepEqual((await call('GET', '/settings')).body, { enabled: false });
    for (const body of [{}, { enabled: 'no' }, { enabled: true, extra: 1 }, [true]]) assert.equal((await call('PUT', '/settings', body)).status, 400, JSON.stringify(body));
    assert.deepEqual((await call('PUT', '/settings', { enabled: true })).body, { enabled: true });
  } finally { await close(); }
});

test('every route needs the page login', async () => {
  const { call, close } = await serve(createUiEvents({ db: database(), now: () => NOW }), { login: false });
  try {
    for (const [method, url, body] of [['GET', '/settings'], ['PUT', '/settings', { enabled: false }], ['POST', '', batch([event('h5-cycle')])], ['GET', '/summary'], ['GET', '/export'], ['DELETE', '']]) {
      assert.equal((await call(method, url, body)).status, 401, `${method} ${url}`);
    }
  } finally { await close(); }
});

test('a batch is checked whole: unknown fields, long or odd strings, wrong kinds and too many entries are refused, nothing is stored', async () => {
  const db = database();
  const { call, close } = await serve(createUiEvents({ db, now: () => NOW, version: () => '2.138.1' }));
  try {
    const bad = [
      [], {}, // (a bare null never gets here: the JSON parser refuses it) batch([event('h5-cycle')], { page: 'x' }), batch([event('h5-cycle')], { secret: 'Acme' }), batch([event('h5-cycle')], { sent: 'now' }),
      batch([event('h5-cycle', { title: 'Acme merger' })]), batch([event('h5-cycle', { text: 'hunter2' })]), batch([event('Acme merger plan')]),
      batch([event('h5-cycle', { key: 'x'.repeat(81) })]), batch([event('h5-cycle', { surface: 'dialog:Secret plan' })]), batch([event('h5-cycle', { detail: 'café' })]),
      batch([event('h5-cycle', { detail: 'x'.repeat(49) })]), batch([event('h5-cycle', { view: 'other' })]), batch([event('h5-cycle', { layout: 'tablet' })]),
      batch([event('h5-cycle', { pane: 1 })]), batch([event('h5-cycle', { device: 'K01' })]), batch([event('h5-cycle', { state: 'maybe' })]), batch([event('h5-cycle', { at: 'x' })]),
      batch(Array.from({ length: 101 }, () => event('h5-cycle'))), batch([], { seen: Array.from({ length: 201 }, () => ({ key: 'h5-cycle', surface: 'header', layout: 'wide' })) }),
      batch([], { seen: [{ key: 'h5-cycle', surface: 'header', layout: 'wide', label: 'Recent' }] }),
    ];
    for (const body of bad) assert.deepEqual(await call('POST', '', body).then(r => [r.status, r.body]), [400, { error: 'INVALID_UI_EVENTS' }], JSON.stringify(body).slice(0, 80));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ui_events').get().n, 0);
    // The caps themselves are allowed.
    assert.deepEqual((await call('POST', '', batch(Array.from({ length: 100 }, () => event('h5-cycle'))))).body, { accepted: 100, enabled: true });
    const row = db.prepare('SELECT * FROM ui_events LIMIT 1').get();
    assert.equal(row.version, '2.138.1', 'the server stamps its version');
    assert.equal(row.page, 'abc123');
  } finally { await close(); }
});

test('times follow the server clock; stale events are dropped; nothing is stored while the switch is off', async () => {
  const db = database();
  const service = createUiEvents({ db, now: () => NOW });
  const { call, close } = await serve(service);
  try {
    // The page's clock is an hour behind: its times are moved forward by the difference.
    const behind = NOW - 60 * 60 * 1000;
    assert.equal((await call('POST', '', { page: 'abc123', sent: behind, events: [event('h5-cycle', { at: behind - 5000 }), event('h5-more', { at: behind - 2 * DAY })] })).body.accepted, 1);
    assert.equal(db.prepare('SELECT at FROM ui_events').get().at, NOW - 5000);
    await call('PUT', '/settings', { enabled: false });
    assert.deepEqual((await call('POST', '', batch([event('h5-cycle')]))).body, { accepted: 0, enabled: false });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ui_events').get().n, 1);
  } finally { await close(); }
});

test('rows older than 90 days are deleted at start and on the daily timer', async t => {
  const db = database();
  let now = NOW;
  const service = createUiEvents({ db, now: () => now });
  service.record(batch([event('h5-cycle')], { seen: [{ key: 'h5-cycle', surface: 'bottom-row', layout: 'wide' }] }));
  now = NOW + 30 * DAY;
  service.record({ page: 'def456', sent: now, events: [event('h5-more', { at: now })] });
  now = NOW + 91 * DAY;
  t.mock.timers.enable({ apis: ['setInterval'] });
  const stop = startRetention(service, { every: DAY });
  assert.deepEqual(db.prepare('SELECT key FROM ui_events').all().map(row => row.key), ['h5-more'], 'the old row went at start');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ui_controls').get().n, 0, 'a control not seen for 90 days went too');
  now = NOW + 121 * DAY;
  t.mock.timers.tick(DAY);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ui_events').get().n, 0, 'and the next day the other one');
  stop();
  t.mock.timers.reset();
});

test('the summary: top keys per surface and layout, seen controls never pressed, next-click pairs within 30 s of one page load, and the store', async () => {
  const db = database();
  const service = createUiEvents({ db, now: () => NOW });
  const at = seconds => NOW - 600000 + seconds * 1000;
  // Page one (computer): commands then send, three times; a press 40 s later does not pair.
  service.record({ page: 'pageone1', sent: NOW, events: [
    event('h5-commands', { at: at(0) }), event('h5-add-menu-command', { at: at(2), surface: 'menu:commands', detail: '/compact' }), event('h5-translate-button', { at: at(5) }),
    event('h5-commands', { at: at(10) }), event('h5-add-menu-command', { at: at(12), surface: 'menu:commands', detail: '/clear' }), event('h5-translate-button', { at: at(14) }),
    event('h5-commands', { at: at(20) }), event('h5-translate-button', { at: at(22) }), event('h5-cycle', { at: at(62) }),
  ], seen: [
    { key: 'h5-commands', surface: 'bottom-row', layout: 'wide' }, { key: 'h5-design', surface: 'bottom-row', layout: 'wide' },
    { key: 'h5-expand-all', surface: 'menu:task-list-menu', layout: 'wide' }, { key: 'key:Tab', surface: 'key-row', layout: 'narrow' },
  ] });
  // Page two (phone): the Tab key was pressed there, and the phone's commands button.
  service.record({ page: 'pagetwo2', sent: NOW, events: [event('key:Escape', { at: at(1), surface: 'key-row', layout: 'narrow', input: 'touch' }), event('h5-commands', { at: at(3), layout: 'narrow', surface: 'tool-row', input: 'touch' })],
    seen: [{ key: 'h5-commands', surface: 'tool-row', layout: 'narrow' }, { key: 'key:Escape', surface: 'key-row', layout: 'narrow' }, { key: 'h5-design', surface: 'tool-row', layout: 'narrow' }] });
  // An old press of h5-design (40 days ago) does not count as use in the last 30 days.
  db.prepare("INSERT INTO ui_events (at, page, key, surface, view, layout, input, pane, device) VALUES (?, 'old', 'h5-design', 'bottom-row', 'sessions', 'wide', 'pointer', 0, 'local')").run(NOW - 40 * DAY);

  const all = service.summary({ days: 30 });
  assert.equal(all.total, 11);
  assert.deepEqual(all.top.slice(0, 3).map(entry => [entry.key, entry.count]), [['h5-commands', 4], ['h5-translate-button', 3], ['h5-add-menu-command', 2]]);
  const commands = all.top[0];
  assert.deepEqual(commands.surfaces, [{ surface: 'bottom-row', count: 3 }, { surface: 'tool-row', count: 1 }]);
  assert.deepEqual(commands.layouts, { wide: 3, narrow: 1 });
  assert.deepEqual(all.top[2].details, [{ detail: '/clear', count: 1 }, { detail: '/compact', count: 1 }]);
  assert.deepEqual(all.unused.map(entry => [entry.key, entry.surface, entry.layouts]), [
    ['h5-design', 'bottom-row', ['wide']], ['h5-design', 'tool-row', ['narrow']], ['h5-expand-all', 'menu:task-list-menu', ['wide']], ['key:Tab', 'key-row', ['narrow']],
  ]);
  const next = Object.fromEntries(all.next.map(entry => [entry.key, [entry.next, entry.count, entry.followed]]));
  assert.deepEqual(next['h5-commands'], ['h5-add-menu-command', 2, 3], 'commands is followed by a saved command twice, by send once');
  assert.deepEqual(next['h5-add-menu-command'], ['h5-translate-button', 2, 2]);
  assert.deepEqual(next['key:Escape'], ['h5-commands', 1, 1], 'pairs stay inside one page load');
  assert.equal(next['h5-translate-button'][0], 'h5-commands', 'send pairs with the next commands, and not with the cycle press 40 s later');
  assert.equal(next['h5-translate-button'][2], 2);
  assert.deepEqual(all.data.count, 12);
  assert.equal(all.data.first_at, NOW - 40 * DAY);
  assert.equal(all.data.retention_days, 90);
  assert.ok(all.data.bytes > 0);

  const phone = service.summary({ days: 30, layout: 'narrow' });
  assert.equal(phone.total, 2);
  assert.deepEqual(phone.unused.map(entry => entry.key), ['h5-design', 'key:Tab']);
  assert.equal(service.summary({ days: 90 }).unused.some(entry => entry.key === 'h5-design' && entry.surface === 'bottom-row'), false, 'within 90 days h5-design was used');
});

test('summary query, export and clear through the route', async () => {
  const db = database();
  const service = createUiEvents({ db, now: () => NOW });
  service.record(batch([event('h5-cycle'), event('h5-more', { state: 'on' })], { seen: [{ key: 'h5-cycle', surface: 'bottom-row', layout: 'wide' }] }));
  const { call, close } = await serve(service);
  try {
    for (const query of ['?days=0', '?days=91', '?days=x', '?layout=tablet']) assert.equal((await call('GET', `/summary${query}`)).status, 400, query);
    const summary = await call('GET', '/summary?days=30&layout=wide');
    assert.equal(summary.status, 200);
    assert.equal(summary.body.total, 2);
    assert.equal(summary.body.layout, 'wide');
    const exported = await call('GET', '/export');
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition'), /attachment; filename="t-agent-usage-\d{4}-\d{2}-\d{2}\.json"/);
    assert.equal(exported.body.retention_days, 90);
    assert.deepEqual(exported.body.events.map(row => [row.key, row.pane, row.state]), [['h5-cycle', false, null], ['h5-more', false, 'on']]);
    assert.equal(exported.body.events[0].time, new Date(NOW).toISOString());
    assert.deepEqual(exported.body.controls.map(row => row.key), ['h5-cycle']);
    assert.deepEqual((await call('DELETE', '')).body, { cleared: 2 });
    assert.equal((await call('GET', '/summary')).body.data.count, 0);
    assert.deepEqual((await call('GET', '/export')).body.events, []);
    assert.deepEqual((await call('GET', '/export')).body.controls, []);
  } finally { await close(); }
});
