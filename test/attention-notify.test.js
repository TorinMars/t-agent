// T-Attention notifiers (services/attention-notify.js): rules, modes, dedupe, quiet hours, rate limits, delayed calls and error isolation.
// The attention bus and the notifier are fakes; time and timers are driven by the test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const Database = require('better-sqlite3');
const notify = require('../services/attention-notify');

// start() without an injected bus loads the real services/attention.js, which opens the database of the data folder.
// A test process must name its own folder (lib/data-home.js refuses otherwise, so this file needs it where nothing exports one, as in CI).
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-attention-notify-'));
process.env.T_AGENT_DATA_DIR = dataDir;
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const SECRET = 'attention-notify-test-secret-0123456789';
const makeDb = () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  return db;
};
function fakeBus() {
  const listeners = new Set();
  return { onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); }, emit: change => { for (const fn of listeners) fn(change); }, size: () => listeners.size };
}
function fakeTimers() {
  let seq = 0;
  const list = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; list.set(id, { fn, ms }); return id; },
    clearTimeout: id => list.delete(id),
    fire() { const all = [...list.values()]; list.clear(); for (const timer of all) timer.fn(); return all.length; },
    count: () => list.size,
  };
}
function fakeNotifier(name = 'fake', behaviour = {}) {
  const calls = [];
  return {
    calls,
    plugin: {
      name, label: 'Fake', configFields: [],
      ready: config => behaviour.ready ? behaviour.ready(config) : true,
      async notify(args) { calls.push(args); if (behaviour.notify) return behaviour.notify(args); return { outcome: 'sent' }; },
      async test() { return { ok: true }; },
    },
  };
}
function setup({ notifiers, clock = { now: Date.parse('2026-11-08T12:00:00Z') }, ...extra } = {}) {
  const db = makeDb();
  const bus = fakeBus();
  const timers = fakeTimers();
  const logs = [];
  const fake = fakeNotifier();
  const service = notify.createAttentionNotify({
    db, sessionSecret: SECRET, onChange: bus.onChange, getOwner: () => 'owner', notifiers: notifiers || [fake.plugin],
    log: (level, message) => logs.push(`${level} ${message}`), now: () => clock.now, timers, ...extra,
  });
  return { db, bus, timers, logs, fake, service, clock };
}
const item = (id, status, extra = {}) => ({ id, title: `Item ${id}`, status, source: 'claude', attention_reason: null, link_url: null, ...extra });
const change = (kind, next, previous, actor = 'claude') => ({ kind, item: next, previous, event: { actor } });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('only the statuses in the rules notify, and only when the status changes', async () => {
  const { bus, fake, service } = setup();
  bus.emit(change('created', item(1, 'working'), null));
  bus.emit(change('updated', item(1, 'waiting_user'), item(1, 'working')));
  bus.emit(change('updated', item(1, 'waiting_user', { title: 'new title' }), item(1, 'waiting_user')));
  bus.emit(change('created', item(2, 'failed'), null));
  bus.emit(change('created', item(3, 'review'), null));
  bus.emit(change('updated', item(4, 'done'), item(4, 'review')));
  await settle();
  assert.deepEqual(fake.calls.map(call => [call.item.id, call.item.status, call.mode, call.reason]), [[1, 'waiting_user', 'message', 'status'], [2, 'failed', 'message', 'status'], [3, 'review', 'message', 'status']]);
  service.saveRules('owner', { statuses: ['done'] });
  bus.emit(change('updated', item(5, 'done'), item(5, 'review')));
  bus.emit(change('updated', item(6, 'waiting_user'), item(6, 'working')));
  await settle();
  assert.deepEqual(fake.calls.slice(3).map(call => call.item.id), [5]);
});

test('the default rules notify only on entering waiting_user, failed or review: never working, done, todo or cancelled', async () => {
  const { bus, fake, service } = setup();
  assert.deepEqual(service.getRules('owner').statuses, ['waiting_user', 'failed', 'review']);
  bus.emit(change('created', item(1, 'working'), null));
  bus.emit(change('updated', item(1, 'done'), item(1, 'working')));
  bus.emit(change('created', item(2, 'todo'), null));
  bus.emit(change('updated', item(2, 'cancelled'), item(2, 'todo')));
  bus.emit(change('updated', item(3, 'working'), item(3, 'review')));
  await settle();
  assert.equal(fake.calls.length, 0);
  bus.emit(change('updated', item(3, 'review'), item(3, 'working')));
  await settle();
  assert.deepEqual(fake.calls.map(call => [call.item.id, call.item.status]), [[3, 'review']]);
});

test('nothing is sent while the session of the item is in the foreground on this engine; in the background it is', async () => {
  const shown = new Set(['7:term-a']);
  const asked = [];
  const { bus, fake, service } = setup({ host: 'this-mac', isForeground: (taskId, terminalId) => { asked.push([taskId, terminalId]); return shown.has(`${taskId}:${terminalId}`); } });
  const tagent = (task, terminal) => ({ tagent: { task_id: task, terminal_id: terminal } });
  bus.emit(change('updated', item(1, 'review', { context: tagent('7', 'term-a') }), item(1, 'working')));
  await settle();
  assert.equal(fake.calls.length, 0, 'open on screen: no message');
  const skipped = service.recent()[0];
  assert.equal(skipped.outcome, 'foreground');
  assert.equal(skipped.detail, 'the session is open on screen');
  assert.deepEqual(asked, [['7', 'term-a']]);
  // The same item later, in the background: it is sent (the skip did not count as sent for the 10-minute dedupe).
  shown.clear();
  bus.emit(change('updated', item(1, 'working', { context: tagent('7', 'term-a') }), item(1, 'review')));
  bus.emit(change('updated', item(1, 'review', { context: tagent('7', 'term-a') }), item(1, 'working')));
  await settle();
  assert.deepEqual(fake.calls.map(call => call.item.id), [1]);
  assert.equal(service.recent()[0].outcome, 'sent');
  // Without context.tagent (made by hand, the CLI outside a T-Agent terminal, another listener) it is always sent.
  shown.add('7:term-a');
  bus.emit(change('created', item(2, 'waiting_user'), null));
  bus.emit(change('created', item(3, 'failed', { context: { cwd: '/x' } }), null));
  // A session of another machine (context.host) is never this engine's terminal, even with the same ids.
  bus.emit(change('created', item(4, 'waiting_user', { context: { host: 'other-pc', ...tagent('7', 'term-a') } }), null));
  // This machine's name counts as this engine.
  bus.emit(change('created', item(5, 'waiting_user', { context: { host: 'this-mac', ...tagent('7', 'term-a') } }), null));
  await settle();
  assert.deepEqual(fake.calls.map(call => call.item.id), [1, 2, 3, 4]);
  assert.equal(service.recent().find(entry => entry.item_id === 5).outcome, 'foreground');
});

test('a foreground check that throws counts as background; the default is never foreground', async () => {
  const thrower = setup({ isForeground: () => { throw new Error('boom'); } });
  thrower.bus.emit(change('created', item(1, 'review', { context: { tagent: { task_id: '1', terminal_id: 'a' } } }), null));
  const plain = setup();
  plain.bus.emit(change('created', item(1, 'review', { context: { tagent: { task_id: '1', terminal_id: 'a' } } }), null));
  await settle();
  assert.equal(thrower.fake.calls.length, 1);
  assert.equal(plain.fake.calls.length, 1);
});

test('a delayed call checks the foreground again when it is due', async () => {
  let shown = false;
  const items = new Map();
  const { bus, fake, timers, service } = setup({ isForeground: () => shown, getItem: id => items.get(id) });
  service.saveRules('owner', { callDelayMinutes: 5, modes: { fake: { waiting_user: 'call' } } });
  const context = { tagent: { task_id: '3', terminal_id: 'b' } };
  items.set(1, item(1, 'waiting_user', { context }));
  items.set(2, item(2, 'waiting_user', { context }));
  bus.emit(change('created', items.get(1), null));
  assert.equal(service.recent()[0].outcome, 'call_scheduled', 'in the background at the change: the call is planned');
  shown = true; // the person opened the session before the call was due
  timers.fire();
  await settle();
  assert.equal(fake.calls.length, 0);
  assert.equal(service.recent()[0].outcome, 'foreground');
  shown = false;
  bus.emit(change('created', items.get(2), null));
  timers.fire();
  await settle();
  assert.deepEqual(fake.calls.map(call => [call.item.id, call.mode, call.reason]), [[2, 'call', 'still']]);
  service.stop();
});

test('rules are stored encrypted per user and validated', () => {
  const { db, service } = setup();
  const saved = service.saveRules('owner', { publicUrl: 'https://tasks.example.com/', modes: { fake: { failed: 'call', review: 'off' } }, quietHours: { enabled: true, start: '22:00', end: '07:30', timeZone: 'Asia/Shanghai' } });
  assert.equal(saved.publicUrl, 'https://tasks.example.com');
  assert.deepEqual(service.getRules('owner').modes, { fake: { failed: 'call', review: 'off' } });
  assert.deepEqual(service.getRules('other').statuses, ['waiting_user', 'failed', 'review'], 'defaults for another user');
  assert.equal(db.prepare('SELECT value FROM system_state').get().value.includes('tasks.example.com'), false, 'stored encrypted');
  assert.throws(() => service.saveRules('owner', { statuses: ['nope'] }), /status/);
  assert.throws(() => service.saveRules('owner', { modes: { fake: { failed: 'shout' } } }), /mode/);
  assert.throws(() => service.saveRules('owner', { modes: { other: { failed: 'call' } } }), /notifier/);
  assert.throws(() => service.saveRules('owner', { quietHours: { enabled: true, start: '25:00', end: '07:00' } }), /times/);
  assert.throws(() => service.saveRules('owner', { quietHours: { timeZone: 'Mars/Base' } }), /time zone/);
  assert.throws(() => service.saveRules('owner', { publicUrl: 'javascript:alert(1)' }), /http/);
  assert.throws(() => service.saveRules('owner', { callDelayMinutes: -1 }), /delay/);
  assert.equal(service.saveRules('owner', { publicUrl: '' }).publicUrl, '', 'clearing the address');
});

test('per status mode: off skips, call rings, and the link is made absolute with the public address', async () => {
  const { bus, fake, service } = setup();
  service.saveRules('owner', { modes: { fake: { waiting_user: 'call', review: 'off' } }, publicUrl: 'https://t.example.com' });
  bus.emit(change('created', item(1, 'waiting_user', { link_url: '/?attention=1' }), null));
  bus.emit(change('created', item(2, 'review'), null));
  bus.emit(change('created', item(3, 'failed', { link_url: 'https://github.com/x/y/pull/1' }), null));
  bus.emit(change('created', item(4, 'failed', { link_url: '//evil.example.com' }), null));
  await settle();
  assert.deepEqual(fake.calls.map(call => [call.item.id, call.mode, call.link]), [
    [1, 'call', 'https://t.example.com/?attention=1'], [3, 'message', 'https://github.com/x/y/pull/1'], [4, 'message', 'https://t.example.com/'],
  ]);
});

test('the same item and status is not sent again within 10 minutes', async () => {
  const { bus, fake, clock, service } = setup();
  const flip = () => { bus.emit(change('updated', item(1, 'working'), item(1, 'waiting_user'))); bus.emit(change('updated', item(1, 'waiting_user'), item(1, 'working'))); };
  bus.emit(change('created', item(1, 'waiting_user'), null));
  flip();
  clock.now += 9 * 60 * 1000;
  flip();
  await settle();
  assert.equal(fake.calls.length, 1);
  assert.ok(service.recent().some(entry => entry.outcome === 'duplicate'));
  clock.now += 2 * 60 * 1000;
  flip();
  await settle();
  assert.equal(fake.calls.length, 2, 'after 10 minutes it is sent again');
});

test('a later change that only adds context.summary (same status) does not notify again, nor cancel a delayed call', async () => {
  const { bus, fake, timers, service } = setup();
  const waiting = item(1, 'waiting_user', { context: { pending: { kind: 'question', text: 'Which database?' } } });
  bus.emit(change('updated', waiting, item(1, 'working')));
  const summarized = { ...waiting, context: { ...waiting.context, summary: { text: 'Doing: x\nProgress: y\nNeeds: z', at: '2026-11-08T12:00:05Z', model: 'm' } } };
  bus.emit(change('updated', summarized, waiting, 'summary'));
  await settle();
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].item.context.pending.text, 'Which database?', 'the item with its context reaches the notifier');
  service.saveRules('owner', { callDelayMinutes: 2, modes: { fake: { review: 'call' } } });
  const review = item(2, 'review');
  bus.emit(change('updated', review, item(2, 'working')));
  bus.emit(change('updated', { ...review, context: { summary: { text: 'a' } } }, review, 'summary'));
  assert.equal(timers.count(), 1, 'the planned call is kept');
  timers.fire();
  await settle();
  assert.deepEqual(fake.calls.slice(1).map(call => [call.item.id, call.mode]), [[2, 'call']]);
});

test('quiet hours skip notifications, also over midnight and in the chosen time zone', async () => {
  assert.equal(notify.inQuietHours({ enabled: true, start: '22:00', end: '08:00', timeZone: 'UTC' }, new Date('2026-11-08T23:30:00Z')), true);
  assert.equal(notify.inQuietHours({ enabled: true, start: '22:00', end: '08:00', timeZone: 'UTC' }, new Date('2026-11-08T07:59:00Z')), true);
  assert.equal(notify.inQuietHours({ enabled: true, start: '22:00', end: '08:00', timeZone: 'UTC' }, new Date('2026-11-08T08:00:00Z')), false);
  assert.equal(notify.inQuietHours({ enabled: true, start: '12:00', end: '13:00', timeZone: 'Asia/Shanghai' }, new Date('2026-11-08T04:30:00Z')), true, '12:30 in Shanghai');
  assert.equal(notify.inQuietHours({ enabled: false, start: '00:00', end: '23:59', timeZone: 'UTC' }, new Date()), false);
  const { bus, fake, service } = setup({ clock: { now: Date.parse('2026-11-08T23:00:00Z') } });
  service.saveRules('owner', { quietHours: { enabled: true, start: '22:00', end: '08:00', timeZone: 'UTC' } });
  bus.emit(change('created', item(1, 'failed'), null));
  await settle();
  assert.equal(fake.calls.length, 0);
  assert.equal(service.recent()[0].outcome, 'quiet_hours');
});

test('rate limits per notifier: messages and calls per hour, a refused call becomes a message', async () => {
  const { bus, fake, clock, service } = setup();
  service.saveRules('owner', { rateLimit: { message: 3, call: 1 }, modes: { fake: { review: 'call' } } });
  for (let id = 1; id <= 5; id += 1) bus.emit(change('created', item(id, 'failed'), null));
  await settle();
  assert.equal(fake.calls.length, 3);
  assert.equal(service.recent().filter(entry => entry.outcome === 'rate_limited').length, 2);
  clock.now += 61 * 60 * 1000;
  bus.emit(change('created', item(10, 'review'), null));
  bus.emit(change('created', item(11, 'review'), null));
  await settle();
  assert.deepEqual(fake.calls.slice(3).map(call => [call.item.id, call.mode, call.reason]), [[10, 'call', 'status'], [11, 'message', 'call_failed']]);
  assert.equal(fake.calls[4].error, 'call limit reached');
});

test('a failed call falls back to a message, and errors are isolated from the bus', async () => {
  const failing = fakeNotifier('fake', { notify: args => { if (args.mode === 'call') return { fallback: 'message', error: 'The privacy settings of account 2 do not allow calls from account 1' }; return { outcome: 'sent' }; } });
  const broken = fakeNotifier('broken', { notify: () => { throw new Error('boom'); } });
  const { bus, service, logs } = setup({ notifiers: [broken.plugin, failing.plugin] });
  service.saveRules('owner', { modes: { fake: { failed: 'call' } } });
  assert.doesNotThrow(() => bus.emit(change('created', item(1, 'failed'), null)));
  await settle();
  assert.deepEqual(failing.calls.map(call => [call.mode, call.reason]), [['call', 'status'], ['message', 'call_failed']]);
  assert.equal(broken.calls.length, 1);
  assert.ok(service.recent().some(entry => entry.notifier === 'broken' && entry.outcome === 'error' && entry.detail === 'boom'));
  assert.ok(service.recent().some(entry => entry.notifier === 'fake' && entry.outcome === 'fallback_sent'));
  assert.ok(logs.some(line => line.startsWith('warn broken item 1 failed message: error')));
  // A throwing rules lookup (for example a broken database) is caught too.
  const db = makeDb();
  const bus2 = fakeBus();
  notify.createAttentionNotify({ db, sessionSecret: SECRET, onChange: bus2.onChange, getOwner: () => { throw new Error('no owner'); }, notifiers: [failing.plugin], log: () => {} });
  assert.doesNotThrow(() => bus2.emit(change('created', item(1, 'failed'), null)));
});

test('a notifier that is not set up is skipped', async () => {
  const off = fakeNotifier('fake', { ready: () => false });
  const { bus, service } = setup({ notifiers: [off.plugin] });
  bus.emit(change('created', item(1, 'failed'), null));
  await settle();
  assert.equal(off.calls.length, 0);
  assert.equal(service.recent()[0].outcome, 'skipped');
});

test('a delayed call rings only if the item is still in that status, and is cancelled when it changes', async () => {
  const { bus, fake, timers, service } = setup();
  service.saveRules('owner', { callDelayMinutes: 5, modes: { fake: { waiting_user: 'call' } } });
  bus.emit(change('created', item(1, 'waiting_user'), null));
  bus.emit(change('created', item(2, 'waiting_user'), null));
  bus.emit(change('created', item(3, 'waiting_user'), null));
  bus.emit(change('created', item(4, 'waiting_user'), null));
  assert.equal(timers.count(), 4);
  assert.equal(service.pendingCount(), 4);
  bus.emit(change('updated', item(1, 'working'), item(1, 'waiting_user'))); // handled: status changed
  bus.emit(change('deleted', item(2, 'waiting_user'), item(2, 'waiting_user'))); // deleted
  bus.emit(change('updated', item(3, 'waiting_user', { notes: 'seen' }), item(3, 'waiting_user'), 'user')); // the user edited it
  bus.emit(change('updated', item(4, 'waiting_user', { attention_reason: 'again' }), item(4, 'waiting_user'), 'claude')); // the agent only refreshed it
  assert.equal(service.pendingCount(), 1);
  assert.equal(fake.calls.length, 0, 'nothing before the delay');
  timers.fire();
  await settle();
  assert.deepEqual(fake.calls.map(call => [call.item.id, call.mode, call.reason]), [[4, 'call', 'still']]);
  service.stop();
});

test('stop() unsubscribes and drops pending calls', () => {
  const { bus, timers, service } = setup();
  service.saveRules('owner', { callDelayMinutes: 1, modes: { fake: { failed: 'call' } } });
  bus.emit(change('created', item(1, 'failed'), null));
  assert.equal(bus.size(), 1);
  service.stop();
  assert.equal(bus.size(), 0);
  assert.equal(timers.count(), 0);
});

test('plugins are loaded from plugins/notifiers/<name>/ and broken ones are skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notifiers-'));
  const write = (name, manifest, code) => { fs.mkdirSync(path.join(dir, name)); fs.writeFileSync(path.join(dir, name, 'manifest.json'), JSON.stringify(manifest)); if (code) fs.writeFileSync(path.join(dir, name, 'index.js'), code); };
  write('good', { name: 'good', version: '1', kind: 'notifier' }, "module.exports = { name: 'good', label: 'Good', configFields: [], notify: async () => {}, test: async () => {} };");
  write('listener', { name: 'listener', version: '1', kind: 'listener' }, 'module.exports = {};');
  write('nameless', { name: 'other', version: '1', kind: 'notifier' }, "module.exports = { name: 'nameless', notify() {}, test() {} };");
  write('noindex', { name: 'noindex', version: '1', kind: 'notifier' });
  const logs = [];
  const found = notify.loadNotifiers(dir, (level, message) => logs.push(message));
  assert.deepEqual(found.map(plugin => plugin.name), ['good']);
  assert.equal(logs.length, 2);
  assert.deepEqual(notify.loadNotifiers(path.join(dir, 'missing')), []);
  const real = notify.loadNotifiers();
  assert.deepEqual(real.map(plugin => plugin.name), ['telegram'], 'the bundled Telegram plugin loads (without connecting)');
});

test('start() works without services/attention.js and with an injected bus', () => {
  const db = makeDb();
  const service = notify.start({ db, sessionSecret: SECRET, notifiers: [], log: () => {} });
  assert.equal(typeof service.createRouter, 'function');
  const bus = fakeBus();
  const wired = notify.start({ db, sessionSecret: SECRET, onChange: bus.onChange, notifiers: [], log: () => {} });
  assert.equal(bus.size(), 1);
  wired.stop();
});

test('HTTP: config read and save, plugin routes and test, same-origin and errors as JSON', async () => {
  const fake = fakeNotifier();
  fake.plugin.routes = router => router.get('/hello', (req, res) => res.json({ owner: req.session.user.login }));
  fake.plugin.status = () => ({ loggedIn: false });
  const { service } = setup({ notifiers: [fake.plugin] });
  const app = express();
  app.use((req, res, next) => { req.session = { user: { login: 'owner' } }; next(); });
  app.use('/api/attention-notify', service.createRouter({ requireAuth: (req, res, next) => next() }));
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/attention-notify`;
  const send = (method, url, body, headers = {}) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...headers }, body: body ? JSON.stringify(body) : undefined });
  try {
    const first = await (await send('GET', '/config')).json();
    assert.deepEqual(first.rules.statuses, ['waiting_user', 'failed', 'review']);
    assert.deepEqual(first.notifiers.map(item => [item.name, item.status.loggedIn]), [['fake', false]]);
    const saved = await (await send('PUT', '/config', { callDelayMinutes: 3 })).json();
    assert.equal(saved.rules.callDelayMinutes, 3);
    const bad = await send('PUT', '/config', { statuses: ['x'] });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /status/);
    assert.deepEqual(await (await send('GET', '/fake/hello')).json(), { owner: 'owner' });
    assert.deepEqual(await (await send('POST', '/fake/test', { kind: 'message' })).json(), { ok: true });
    const cross = await send('PUT', '/config', {}, { Origin: 'https://evil.example.com' });
    assert.equal(cross.status, 403);
    const noHeader = await fetch(`${base}/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noHeader.status, 403, 'a mutation needs the same-origin proof');
  } finally { server.close(); }
});

// The real wire-up of server.js: services/attention.js publishes the changes and the notifier reads the current item for a delayed call.
test('with the real attention service: one notification per status, the summary update (actor summary) adds none, a delayed call carries it', async () => {
  const { createAttentionService } = require('../services/attention');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  const attention = createAttentionService({ db });
  const timers = fakeTimers();
  const fake = fakeNotifier();
  const service = notify.createAttentionNotify({
    db, sessionSecret: SECRET, onChange: attention.onChange, getItem: id => attention.get(id), getOwner: () => 'owner', notifiers: [fake.plugin],
    log: () => {}, timers,
  });
  const created = attention.upsertByRef('claude:s1', { title: 'Fix login', status: 'working', source: 'claude' }, { actor: 'claude' }).item;
  attention.upsertByRef('claude:s1', { status: 'waiting_user', context: { pending: { kind: 'permission', text: 'Allow npm test?', command: 'npm test' } } }, { actor: 'claude' });
  await settle();
  assert.deepEqual(fake.calls.map(call => [call.item.id, call.item.status, call.mode]), [[created.id, 'waiting_user', 'message']]);
  assert.equal(fake.calls[0].item.context.pending.text, 'Allow npm test?');
  attention.update(created.id, { context: { summary: { text: 'Doing: a\nProgress: b\nNeeds: c', at: '2026-11-08T12:00:05.000Z', model: 'm' } } }, { actor: 'summary' });
  await settle();
  assert.equal(fake.calls.length, 1, 'the summary update notifies nobody');
  // A delayed call for review: the summary that arrives after the status change is in the item the call gets.
  service.saveRules('owner', { callDelayMinutes: 2, modes: { fake: { review: 'call' } } });
  attention.upsertByRef('claude:s1', { status: 'review', context: { pending: null } }, { actor: 'claude' });
  attention.update(created.id, { context: { summary: { text: 'Doing: a\nProgress: done\nNeeds: review', at: '2026-11-08T12:01:00.000Z', model: 'm' } } }, { actor: 'summary' });
  assert.equal(timers.count(), 1, 'the planned call is kept after the summary update');
  timers.fire();
  await settle();
  assert.deepEqual(fake.calls.slice(1).map(call => [call.item.status, call.mode, call.item.context.summary.text]), [['review', 'call', 'Doing: a\nProgress: done\nNeeds: review']]);
  service.stop();
});
