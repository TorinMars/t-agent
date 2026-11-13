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
// messageDelay: the minutes a message waits; most tests send at once (0), the delay tests pass a number, and `null` keeps the stored default.
function setup({ notifiers, clock = { now: Date.parse('2026-11-08T12:00:00Z') }, messageDelay = 0, ...extra } = {}) {
  const db = makeDb();
  const bus = fakeBus();
  const timers = fakeTimers();
  const logs = [];
  const fake = fakeNotifier();
  const service = notify.createAttentionNotify({
    db, sessionSecret: SECRET, onChange: bus.onChange, getOwner: () => 'owner', notifiers: notifiers || [fake.plugin],
    log: (level, message) => logs.push(`${level} ${message}`), now: () => clock.now, timers, ...extra,
  });
  if (messageDelay !== null) service.saveRules('owner', { messageDelayMinutes: messageDelay });
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
test('with the real attention service: one notification per status, the summary update (actor summary) adds none, a delayed message and call carry it', async () => {
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
  // The default rules: the message waits 3 minutes, and the summary update (same status) neither sends nor drops it.
  assert.equal(service.getRules('owner').messageDelayMinutes, 3);
  assert.equal(fake.calls.length, 0, 'the message waits');
  attention.update(created.id, { context: { summary: { text: 'Doing: a\nProgress: b\nNeeds: c', at: '2026-11-08T12:00:05.000Z', model: 'm' } } }, { actor: 'summary' });
  await settle();
  assert.equal(timers.count(), 1, 'the summary update notifies nobody and keeps the waiting message');
  timers.fire();
  await settle();
  assert.deepEqual(fake.calls.map(call => [call.item.id, call.item.status, call.mode, call.reason]), [[created.id, 'waiting_user', 'message', 'still']]);
  assert.equal(fake.calls[0].item.context.pending.text, 'Allow npm test?');
  assert.equal(fake.calls[0].item.context.summary.text, 'Doing: a\nProgress: b\nNeeds: c', 'the message carries what arrived during the wait');
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

// ---- One Telegram sender for linked devices: deliver() with a relay (services/attention-relay.js; the full flow is test/attention-notify-relay.test.js) ----
function fakeRelay({ target = { peer: { name: 'A', online: true }, name: 'A' }, send } = {}) {
  const sent = [];
  return {
    sent,
    handles: name => name === 'telegram',
    target: async name => (name === 'telegram' ? target : null),
    send: async (peer, payload) => { sent.push({ peer, payload }); if (send) return send(payload); return { outcome: 'sent' }; },
    sendTest: async () => ({ ok: true, outcome: 'sent' }),
    view: () => ({ sender: target ? { name: target.name, self: false, online: true } : null }),
  };
}

test('with a sender on another device, Telegram is relayed there and never sent here; other notifiers are untouched', async () => {
  const telegram = fakeNotifier('telegram');
  const other = fakeNotifier('fake');
  const relay = fakeRelay();
  const { bus, service } = setup({ notifiers: [telegram.plugin, other.plugin], relay });
  bus.emit(change('updated', item(1, 'waiting_user', { link_url: '/h5', context: { excerpt: 'secret transcript', pending: { text: 'Approve' } } }), item(1, 'working')));
  await settle();
  assert.equal(telegram.calls.length, 0);
  assert.equal(other.calls.length, 1, 'a notifier that is not relayed sends here as before');
  assert.equal(relay.sent.length, 1);
  assert.deepEqual(relay.sent[0].payload, { notifier: 'telegram', mode: 'message', reason: 'status', item: { id: 1, title: 'Item 1', status: 'waiting_user', source: 'claude', attention_reason: null, context: { pending: { text: 'Approve' } } }, link: '' });
  const entry = service.recent().find(row => row.notifier === 'telegram');
  assert.equal(entry.outcome, 'relayed');
  assert.equal(entry.via, 'A');
  // The rate limit is the sender's: this device does not count relayed deliveries.
  service.saveRules('owner', { rateLimit: { message: 1 } });
  for (const id of [2, 3, 4]) bus.emit(change('updated', item(id, 'failed'), item(id, 'working')));
  await settle();
  assert.equal(relay.sent.length, 4);
  // The plugin row says who sends.
  const row = service.overview('owner').find(entry => entry.name === 'telegram');
  assert.deepEqual([row.configured, row.summary], [true, 'Sent through A']);
});

test('a relay that fails is logged, retried once after 30 s, and the plugin here is never used instead', async () => {
  const telegram = fakeNotifier('telegram');
  let failing = true;
  const relay = fakeRelay({ send: () => { if (failing) throw Object.assign(new Error('REMOTE_HTTP_500'), { code: 'REMOTE_HTTP_500', offline: false }); return { outcome: 'call_timeout' }; } });
  const { bus, service, timers } = setup({ notifiers: [telegram.plugin], relay });
  service.saveRules('owner', { modes: { telegram: { waiting_user: 'call' } } });
  bus.emit(change('updated', item(1, 'waiting_user'), item(1, 'working')));
  await settle();
  assert.equal(service.recent()[0].outcome, 'relay_failed');
  assert.equal(service.recent()[0].detail, 'REMOTE_HTTP_500; one retry in 30 s');
  assert.equal(timers.count(), 1);
  failing = false;
  timers.fire();
  await settle();
  assert.equal(service.recent()[0].outcome, 'relayed');
  assert.equal(service.recent()[0].detail, 'call_timeout');
  assert.equal(relay.sent.at(-1).payload.mode, 'call');
  assert.equal(telegram.calls.length, 0);
  // No sender elsewhere (this device sends, or nobody does): the plugin here, as before.
  const local = setup({ notifiers: [telegram.plugin], relay: fakeRelay({ target: null }) });
  local.bus.emit(change('updated', item(2, 'waiting_user'), item(2, 'working')));
  await settle();
  assert.equal(telegram.calls.length, 1);
  assert.equal(telegram.calls[0].origin, undefined);
});

// ---- The wait before a message (messageDelayMinutes) ----
const MINUTE = 60 * 1000;
test('a message waits messageDelayMinutes (default 3) and is sent if the item is still in that status; waiting_user waits too', async () => {
  const items = new Map();
  const { bus, fake, timers, service, clock } = setup({ messageDelay: null, getItem: id => items.get(id) });
  assert.equal(service.getRules('owner').messageDelayMinutes, 3, 'the default');
  for (const [id, status] of [[1, 'waiting_user'], [2, 'review'], [3, 'failed']]) {
    items.set(id, item(id, status));
    bus.emit(change('updated', items.get(id), item(id, 'working')));
  }
  await settle();
  assert.equal(fake.calls.length, 0, 'nothing at once, also not for "Needs you"');
  assert.equal(timers.count(), 3);
  assert.deepEqual(service.recent().slice(0, 3).map(entry => [entry.item_id, entry.outcome, entry.detail]), [[3, 'message_scheduled', '3 min'], [2, 'message_scheduled', '3 min'], [1, 'message_scheduled', '3 min']]);
  assert.equal(service.pendingCount(), 3);
  // What arrived during the wait is in the message (the current item from getItem).
  items.set(2, item(2, 'review', { context: { summary: { text: 'Done: the fix' } } }));
  clock.now += 3 * MINUTE;
  timers.fire();
  await settle();
  assert.deepEqual(fake.calls.map(call => [call.item.id, call.item.status, call.mode, call.reason]), [[1, 'waiting_user', 'message', 'still'], [2, 'review', 'message', 'still'], [3, 'failed', 'message', 'still']]);
  assert.equal(fake.calls[1].item.context.summary.text, 'Done: the fix');
  assert.equal(service.pendingCount(), 0);
  // 0 = at once: no timer.
  service.saveRules('owner', { messageDelayMinutes: 0 });
  items.set(4, item(4, 'review'));
  bus.emit(change('created', items.get(4), null));
  await settle();
  assert.deepEqual([fake.calls.at(-1).item.id, fake.calls.at(-1).reason, timers.count()], [4, 'status', 0]);
});

test('a waiting message is dropped when the item changes status, is handled by the user, is deleted or is gone, or the rules or the plugin change', async () => {
  const items = new Map();
  const { bus, fake, timers, service } = setup({ messageDelay: 5, getItem: id => items.get(id) });
  const enter = (id, status = 'waiting_user') => { items.set(id, item(id, status)); bus.emit(change('updated', items.get(id), item(id, 'working'))); };
  enter(1); enter(2); enter(3); enter(4); enter(5); enter(6, 'review');
  assert.equal(timers.count(), 6);
  // 1: the user answered the prompt, the agent works again.
  items.set(1, item(1, 'working'));
  bus.emit(change('updated', items.get(1), item(1, 'waiting_user')));
  // 2: the user edited it in the page (same status).
  bus.emit(change('updated', items.get(2), items.get(2), 'user'));
  // 3: deleted.
  bus.emit(change('deleted', items.get(3), items.get(3), 'user'));
  items.delete(3);
  // A listener refreshing the same status keeps the wait.
  bus.emit(change('updated', item(4, 'waiting_user', { context: { last_reply: 'x' } }), items.get(4)));
  assert.equal(timers.count(), 3, 'three waits were dropped at once');
  assert.deepEqual(service.recent().filter(entry => entry.outcome === 'cancelled').map(entry => [entry.item_id, entry.detail]).sort(), [[1, 'the status changed'], [2, 'you changed the item'], [3, 'the item was deleted']]);
  // 4: gone without a bus event (getItem has nothing); 5: in another status already; 6: the rules no longer send review.
  items.delete(4);
  items.set(5, item(5, 'done'));
  service.saveRules('owner', { modes: { fake: { review: 'off' } } });
  timers.fire();
  await settle();
  assert.equal(fake.calls.length, 0);
  const why = service.recent().filter(entry => entry.outcome === 'cancelled').map(entry => [entry.item_id, entry.detail]);
  assert.deepEqual(why.filter(([id]) => id >= 4).sort(), [[4, 'the item is gone'], [5, 'the status changed'], [6, 'the rules changed']]);
  // The plugin switched off while it waited.
  const plugin = setup({ messageDelay: 2 });
  plugin.bus.emit(change('created', item(7, 'failed'), null));
  plugin.service.savePluginConfig('fake', 'owner', { enabled: false });
  plugin.timers.fire();
  await settle();
  assert.equal(plugin.fake.calls.length, 0);
  assert.equal(plugin.service.recent()[0].detail, 'the plugin was turned off');
});

test('a waiting message is not sent when the session is on screen when it is due, or was at some moment during the wait', async () => {
  let now = false;
  let seenFrom = null; // isForeground with `since` says true when the session was on screen at or after this time
  const asked = [];
  const { bus, fake, timers, service, clock } = setup({
    messageDelay: 3,
    isForeground: (taskId, terminalId, since) => { asked.push(since); return now || (since !== undefined && seenFrom !== null && seenFrom >= since); },
  });
  const context = { tagent: { task_id: '9', terminal_id: 'term-z' } };
  bus.emit(change('created', item(1, 'review', { context }), null));
  assert.deepEqual(asked, [undefined], 'at the change: is it on screen now');
  const scheduledAt = clock.now;
  clock.now += 3 * MINUTE;
  now = true;
  timers.fire();
  await settle();
  assert.equal(fake.calls.length, 0);
  assert.deepEqual([service.recent()[0].outcome, service.recent()[0].detail], ['foreground', 'the session was open on screen during the wait']);
  assert.equal(asked.at(-1), scheduledAt, 'at the end: on screen since the wait began');
  // Seen for a moment in the middle of the wait, away again at the end.
  now = false;
  bus.emit(change('created', item(2, 'review', { context }), null));
  clock.now += MINUTE;
  seenFrom = clock.now;
  clock.now += 2 * MINUTE;
  timers.fire();
  await settle();
  assert.equal(fake.calls.length, 0, 'the person could already see the result');
  assert.equal(service.recent()[0].outcome, 'foreground');
  // Not seen during the wait: sent. A foreground skip does not count as sent, so the dedupe does not hold it back.
  bus.emit(change('created', item(3, 'review', { context }), null));
  clock.now += 3 * MINUTE;
  timers.fire();
  await settle();
  assert.deepEqual(fake.calls.map(call => call.item.id), [3]);
  // On screen at the change: skipped at once, nothing waits.
  now = true;
  bus.emit(change('created', item(4, 'review', { context }), null));
  assert.equal(timers.count(), 0);
  assert.equal(service.recent()[0].outcome, 'foreground');
});

test('dedupe and the hourly limit count only what is actually sent; quiet hours are checked again when the wait ends', async () => {
  const { bus, fake, timers, service, clock } = setup({ messageDelay: 3 });
  service.saveRules('owner', { rateLimit: { message: 1 } });
  const flip = id => { bus.emit(change('updated', item(id, 'working'), item(id, 'review'))); bus.emit(change('updated', item(id, 'review'), item(id, 'working'))); };
  bus.emit(change('created', item(1, 'review'), null));
  flip(1); // dropped and planned again: the dropped wait was never sent, so it neither dedupes nor uses the limit
  flip(1);
  assert.equal(timers.count(), 1);
  clock.now += 3 * MINUTE;
  timers.fire();
  await settle();
  assert.deepEqual(fake.calls.map(call => call.item.id), [1]);
  // Sent once: the same item and status within 10 minutes is a duplicate at the change (nothing waits).
  flip(1);
  assert.equal(timers.count(), 0);
  assert.equal(service.recent()[0].outcome, 'duplicate');
  // The limit (1 per hour) was used by the one that went out: the next waits, then is refused when due.
  bus.emit(change('created', item(2, 'review'), null));
  timers.fire();
  await settle();
  assert.equal(fake.calls.length, 1);
  assert.equal(service.recent()[0].outcome, 'rate_limited');
  // Quiet hours that begin during the wait.
  clock.now += 2 * 60 * MINUTE;
  bus.emit(change('created', item(3, 'review'), null));
  service.saveRules('owner', { quietHours: { enabled: true, start: '00:00', end: '23:59', timeZone: 'UTC' } });
  timers.fire();
  await settle();
  assert.equal(fake.calls.length, 1);
  assert.equal(service.recent()[0].outcome, 'quiet_hours');
});

test('a call keeps its own delay; with mode call the message delay does not apply', async () => {
  const { bus, fake, timers, service } = setup({ messageDelay: 3 });
  service.saveRules('owner', { modes: { fake: { waiting_user: 'call' } }, callDelayMinutes: 0 });
  bus.emit(change('created', item(1, 'waiting_user'), null));
  await settle();
  assert.deepEqual(fake.calls.map(call => [call.item.id, call.mode, call.reason]), [[1, 'call', 'status']], 'the call goes at once');
  service.saveRules('owner', { callDelayMinutes: 7 });
  bus.emit(change('created', item(2, 'waiting_user'), null));
  assert.deepEqual([service.recent()[0].outcome, service.recent()[0].detail], ['call_scheduled', '7 min']);
  timers.fire();
  await settle();
  assert.deepEqual(fake.calls.slice(1).map(call => [call.item.id, call.mode, call.reason]), [[2, 'call', 'still']]);
});

test('the message delay is validated, and rules without it (saved or synced by an older version) get the default', () => {
  const { db, service } = setup({ messageDelay: null });
  assert.equal(service.saveRules('owner', { messageDelayMinutes: '10' }).messageDelayMinutes, 10);
  assert.equal(service.saveRules('owner', { messageDelayMinutes: 0 }).messageDelayMinutes, 0);
  assert.equal(service.saveRules('owner', { messageDelayMinutes: 120 }).messageDelayMinutes, 120);
  assert.equal(service.saveRules('owner', { statuses: ['review'] }).messageDelayMinutes, 120, 'a save without it keeps it');
  for (const bad of [-1, 121, 2.5, 'soon']) assert.throws(() => service.saveRules('owner', { messageDelayMinutes: bad }), /The delay before a message must be a whole number of minutes from 0 to 120/);
  // An older device's rules object (no messageDelayMinutes), as the settings sync stores it.
  const older = { statuses: ['failed', 'review'], modes: {}, callDelayMinutes: 4, quietHours: { enabled: false, start: '22:00', end: '08:00', timeZone: '' }, rateLimit: { message: 20, call: 6 }, publicUrl: '' };
  notify.importRulesFromSync({ db, sessionSecret: SECRET }, 'owner', older);
  const rules = service.getRules('owner');
  assert.deepEqual([rules.messageDelayMinutes, rules.callDelayMinutes, rules.statuses], [3, 4, ['failed', 'review']]);
  // A value an older or broken device stored out of range falls back too.
  notify.importRulesFromSync({ db, sessionSecret: SECRET }, 'owner', { ...older, messageDelayMinutes: 999, callDelayMinutes: 'x' });
  assert.deepEqual([service.getRules('owner').messageDelayMinutes, service.getRules('owner').callDelayMinutes], [3, 0]);
  // The field travels with the synced rules, and an older device keeps it when it saves (normalizeRules keeps what it does not know).
  service.saveRules('owner', { messageDelayMinutes: 8 });
  assert.equal(notify.exportRulesForSync({ db, sessionSecret: SECRET }, 'owner').messageDelayMinutes, 8);
  const kept = notify.normalizeRules({ statuses: ['failed'] }, { ...notify.defaultRules(), messageDelayMinutes: 8 }, ['fake']);
  assert.equal(kept.messageDelayMinutes, 8);
});

// ---- On screen: the terminal of THIS server whatever the host name, and the agent chat that runs the session ----
test('a terminal of this server is on screen whatever host name the listener wrote; an unknown terminal of another host is not asked', async () => {
  const shown = new Set(['7:3c1e0a52-1111-4222-8333-444455556666']);
  const local = new Set(['7:3c1e0a52-1111-4222-8333-444455556666']);
  const asked = [];
  let hostName = '192.168.1.224';
  const { bus, fake, service } = setup({
    host: () => hostName,
    isForeground: (taskId, terminalId) => { asked.push(`${taskId}:${terminalId}`); return shown.has(`${taskId}:${terminalId}`); },
    isLocalTerminal: (taskId, terminalId) => local.has(`${taskId}:${terminalId}`),
  });
  const ctx = (hostWritten, terminal = '3c1e0a52-1111-4222-8333-444455556666') => ({ context: { host: hostWritten, tagent: { task_id: '7', terminal_id: terminal } } });
  // The regression: the listener wrote the name the Mac had then (an IP from DHCP); the server's name is another one now. The terminal is local.
  bus.emit(change('created', item(1, 'review', ctx('192.168.1.245')), null));
  await settle();
  assert.equal(fake.calls.length, 0);
  assert.equal(service.recent()[0].outcome, 'foreground');
  // A terminal this server does not know, written on another machine: never this engine's, the presence is not even asked.
  asked.length = 0;
  bus.emit(change('created', item(2, 'review', ctx('other-pc', '9a9a9a9a-0000-4000-8000-000000000000')), null));
  await settle();
  assert.deepEqual(fake.calls.map(call => call.item.id), [2]);
  assert.deepEqual(asked, []);
  // The host name is read at the check, not once: an unknown terminal with the name this machine has NOW is asked.
  hostName = 'torins-mac';
  bus.emit(change('created', item(3, 'review', ctx('torins-mac', 'b0b0b0b0-0000-4000-8000-000000000000')), null));
  await settle();
  assert.deepEqual(asked, ['7:b0b0b0b0-0000-4000-8000-000000000000']);
  assert.deepEqual(fake.calls.map(call => call.item.id), [2, 3], 'asked, and not on screen');
});

test('an item whose session runs in an agent chat of this server is on screen while the chat is', async () => {
  let chatShown = true;
  const asked = [];
  const { bus, fake, service } = setup({ isSessionForeground: (agent, sessionId, since) => { asked.push([agent, sessionId, since]); return chatShown && sessionId === 'sess-chat-1'; } });
  const session = id => ({ context: { session: { agent: 'claude', id, resume: 'claude --resume x' } } });
  bus.emit(change('created', item(1, 'waiting_user', session('sess-chat-1')), null));
  bus.emit(change('created', item(2, 'waiting_user', session('sess-terminal-2')), null));
  await settle();
  assert.deepEqual(fake.calls.map(call => call.item.id), [2]);
  assert.equal(service.recent().find(entry => entry.item_id === 1).outcome, 'foreground');
  assert.deepEqual(asked.map(([agent, id]) => [agent, id]), [['claude', 'sess-chat-1'], ['claude', 'sess-terminal-2']]);
  chatShown = false;
  bus.emit(change('created', item(3, 'review', session('sess-chat-1')), null));
  await settle();
  assert.deepEqual(fake.calls.map(call => call.item.id), [2, 3]);
  // A check that throws counts as not on screen.
  const thrower = setup({ isSessionForeground: () => { throw new Error('boom'); } });
  thrower.bus.emit(change('created', item(1, 'review', session('sess-chat-1')), null));
  await settle();
  assert.equal(thrower.fake.calls.length, 1);
});
