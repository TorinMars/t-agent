// One Telegram sender for linked devices (services/attention-relay.js with services/attention-notify.js): a device that is not the sender makes its own
// decisions and relays the final delivery to the sender over POST /v1/attention/notify-relay. The first part runs two or three in-process devices, each
// with its real notify service, relay, Engine router and HTTP client on loopback, with fake service links, a fake bus, fake timers and a fake plugin
// named telegram (never the real Telegram API). The last test runs two real server.js processes linked by a real service-link tunnel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const express = require('express');
const Database = require('better-sqlite3');
const notify = require('../services/attention-notify');
const { createAttentionRelay, createEngineRouter, relayItem, CAPABILITY, STATE_KEY } = require('../services/attention-relay');
const { request: realRequest } = require('../services/remote-client');
const { checkTunnelTarget } = require('../lib/service-link-tunnel');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-attention-relay-'));
process.env.T_AGENT_DATA_DIR = process.env.T_AGENT_DATA_DIR || dataDir;
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const SECRET = 'attention-relay-test-secret-0123456789';
const SESSION = '1AgAOMTQ5LjE1NC4xNjcuNTAB-RELAY-SESSION-SECRET';
const API_HASH = 'fedcba9876543210fedcba9876543210';
const ID = { A: '11111111-1111-4111-8111-111111111111', B: '22222222-2222-4222-8222-222222222222', C: '33333333-3333-4333-8333-333333333333' };
const settle = async (rounds = 10) => { for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve)); };
async function until(check, label, ms = 4000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function fakeTimers() {
  let seq = 0;
  const list = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; list.set(id, { fn, ms }); return id; },
    clearTimeout: id => list.delete(id),
    fire() { const all = [...list.values()]; list.clear(); for (const timer of all) timer.fn(); return all; },
    count: () => list.size,
    delays: () => [...list.values()].map(timer => timer.ms),
  };
}
function fakeBus() {
  const listeners = new Set();
  return { onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); }, emit: change => { for (const fn of listeners) fn(change); } };
}
const item = (id, status, extra = {}) => ({ id, title: `Item ${id}`, status, source: 'claude', attention_reason: null, link_url: null, ...extra });
const change = (next, previous = null, actor = 'claude') => ({ kind: previous ? 'updated' : 'created', item: next, previous, event: { actor } });

// One device: its database, notify service with a fake telegram plugin, relay, and an HTTP server with /v1/info and the relay's Engine router.
// older: a device of a version before the relay (no relay, no routes, no capability).
async function makeDevice(t, name, { ready = false, older = false, capabilities = older ? ['attention:remote'] : [CAPABILITY], clock = { now: Date.parse('2026-11-12T12:00:00Z') }, isForeground } = {}) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  const bus = fakeBus();
  const timers = fakeTimers();
  const logs = [];
  const log = (level, message) => logs.push(`${level} ${message}`);
  const calls = [];
  const tests = [];
  const device = { name, instanceId: ID[name], ready, calls, tests, logs, db, bus, timers, clock, links: [], received: [], peersOf: [] };
  const plugin = {
    name: 'telegram', label: 'Telegram', configFields: [],
    ready: () => device.ready,
    async notify(args) { calls.push(args); return device.notifyAnswer ? device.notifyAnswer(args) : { outcome: 'sent' }; },
    async test(config, options) { tests.push(options); return { ok: true, outcome: 'sent' }; },
  };
  device.service = notify.createAttentionNotify({
    db, sessionSecret: SECRET, onChange: bus.onChange, getOwner: () => 'owner', notifiers: [plugin], log, now: () => clock.now, timers,
    ...(isForeground ? { isForeground } : {}),
  });
  device.service.saveRules('owner', { messageDelayMinutes: 0 }); // these tests are about the relay: messages go at once
  // The service links of this device: peers() as services/service-links.js gives them, linkForToken() for the tokens this device issued.
  const listeners = new Set();
  device.serviceLinks = {
    peers: () => device.peersOf.map(peer => ({ ...peer })),
    linkForToken: token => device.links.find(link => link.token === token) || null,
    onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    emit: id => { for (const fn of listeners) fn(id); },
    noteUnauthorized() {},
  };
  device.requests = [];
  const request = (baseUrl, pathname, token, opts = {}) => { device.requests.push({ pathname, method: opts.method || 'GET', body: opts.body, token }); return realRequest(baseUrl, pathname, token, opts); };
  device.relay = createAttentionRelay({ db, notify: device.service, serviceLinks: device.serviceLinks, request, identity: () => ({ instance_id: device.instanceId, name }), now: () => clock.now, log });
  if (!older) { device.service.setRelay(device.relay); device.relay.start(); }
  const app = express();
  app.use((req, res, next) => {
    // The path is taken now: a router changes req.url while it runs.
    const entry = { method: req.method, path: req.path, raw: '', auth: req.get('authorization') || '' };
    device.received.push(entry);
    req.on('data', chunk => { entry.raw += chunk; });
    next();
  });
  app.get('/v1/info', (req, res) => res.json({ engine_version: 'test', capabilities: device.capabilities }));
  device.capabilities = capabilities;
  const fakeEngineAuth = () => (req, res, next) => {
    const match = /^Bearer\s+(\S+)$/.exec(req.get('authorization') || '');
    if (!match) return res.status(401).json({ error: 'ENGINE_TOKEN_REQUIRED' });
    req.engineAuth = { tokenId: match[1] };
    next();
  };
  if (!older) app.use('/v1/attention/notify-relay', createEngineRouter({ getRelay: () => device.relay, serviceLinks: device.serviceLinks, requireEngineAuth: fakeEngineAuth }));
  // The browser API, with a stand-in for the session.
  app.use('/api/attention-notify', device.service.createRouter({ clientOrigin: (req, res, next) => next(), requireAuth: (req, res, next) => { req.session = { user: { login: 'owner' } }; next(); } }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  device.url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { device.service.stop(); device.relay.stop(); return new Promise(resolve => server.close(resolve)); });
  device.call = async (method, route, body) => {
    const response = await fetch(`${device.url}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return device;
}
// A service link between two devices, in both directions.
function link(a, b, { online = true } = {}) {
  for (const [from, to] of [[a, b], [b, a]]) {
    const token = `tae_${from.name}-to-${to.name}-link-token`;
    from.peersOf.push({ id: `link-${from.name}-${to.name}`, name: to.name, online, remoteServerId: from.peersOf.length + 1, instanceId: to.instanceId, baseUrl: to.url, token });
    to.links.push({ id: `link-${to.name}-${from.name}`, token, peer_instance_id: from.instanceId, name: from.name, revoked: false });
  }
}
const setOnline = (device, peerName, online) => { device.peersOf.find(peer => peer.name === peerName).online = online; device.serviceLinks.emit(`link-${device.name}-${peerName}`); };
const relayPosts = device => device.received.filter(entry => entry.method === 'POST' && entry.path === '/v1/attention/notify-relay');

test('a device that is not the sender relays the delivery to the sender, which sends it with "From <device>"', async t => {
  const a = await makeDevice(t, 'A', { ready: true });
  const b = await makeDevice(t, 'B');
  link(a, b);
  b.bus.emit(change(item(7, 'waiting_user', { link_url: '/h5?task=3', context: { pending: { text: 'Approve the command' }, excerpt: 'never sent' } }), item(7, 'working')));
  await until(() => a.calls.length === 1 && b.service.recent().some(entry => entry.outcome === 'relayed'), 'A sent it');
  assert.equal(b.calls.length, 0, 'B sends nothing itself');
  const sent = a.calls[0];
  assert.deepEqual(sent.origin, { name: 'B' });
  assert.equal(sent.mode, 'message');
  assert.equal(sent.reason, 'status');
  assert.equal(sent.item.id, 7);
  assert.equal(sent.item.status, 'waiting_user');
  assert.equal(sent.item.context.pending.text, 'Approve the command');
  assert.equal(sent.item.context.excerpt, undefined, 'the excerpt never travels');
  const relayed = b.service.recent().find(entry => entry.outcome === 'relayed');
  assert.equal(relayed.via, 'A');
  assert.equal(relayed.detail, 'sent');
  const onA = a.service.recent().find(entry => entry.item_id === 7);
  assert.equal(onA.outcome, 'sent');
  assert.equal(onA.origin, 'B');
  assert.equal(relayPosts(a).length, 1);
  // The page of each device says who sends.
  const viewB = (await b.call('GET', '/api/attention-notify/config')).body.relay;
  assert.deepEqual(viewB.sender, { name: 'A', self: false, online: true });
  assert.equal(viewB.me.ready, false);
  assert.equal(viewB.conflict, false);
  await a.relay.refreshStale();
  const viewA = (await a.call('GET', '/api/attention-notify/config')).body.relay;
  assert.deepEqual(viewA.sender, { name: 'A', self: true, online: true });
  assert.deepEqual(viewA.relaying, [{ name: 'B', online: true }], 'A lists the devices that relay through it');
  // The plugin list of B says Telegram is handled through A.
  const row = b.service.overview('owner').find(entry => entry.name === 'telegram');
  assert.equal(row.configured, true);
  assert.equal(row.summary, 'Sent through A');
});

test('the foreground rule, quiet hours and dedupe are decided on the origin, before anything is relayed', async t => {
  let foreground = true;
  const a = await makeDevice(t, 'A', { ready: true });
  const b = await makeDevice(t, 'B', { isForeground: () => foreground });
  link(a, b);
  const onScreen = item(1, 'waiting_user', { context: { tagent: { task_id: 3, terminal_id: 't1' } } });
  await Promise.all(b.service.handle(change(onScreen, item(1, 'working'))));
  assert.equal(b.service.recent()[0].outcome, 'foreground');
  assert.equal(relayPosts(a).length, 0, 'nothing reached the sender');
  foreground = false;
  // Quiet hours on B: nothing is relayed. The sender's own quiet hours do not apply to a relayed delivery.
  b.service.saveRules('owner', { quietHours: { enabled: true, start: '00:00', end: '23:59', timeZone: 'UTC' } });
  await Promise.all(b.service.handle(change(item(2, 'failed'), item(2, 'working'))));
  assert.equal(b.service.recent()[0].outcome, 'quiet_hours');
  assert.equal(relayPosts(a).length, 0);
  b.service.saveRules('owner', { quietHours: { enabled: false } });
  a.service.saveRules('owner', { quietHours: { enabled: true, start: '00:00', end: '23:59', timeZone: 'UTC' } });
  // Dedupe on B: the same item and status twice in 10 minutes is relayed once.
  await Promise.all(b.service.handle(change(item(3, 'review'), item(3, 'working'))));
  await Promise.all(b.service.handle(change(item(3, 'review'), item(3, 'working'))));
  assert.equal(b.service.recent()[0].outcome, 'duplicate');
  assert.equal(relayPosts(a).length, 1);
  assert.equal(a.calls.length, 1, 'sent by A although A is in its own quiet hours');
});

test('the sender applies its own rate limit, and its dedupe key holds the origin', async t => {
  const a = await makeDevice(t, 'A', { ready: true });
  const b = await makeDevice(t, 'B');
  const c = await makeDevice(t, 'C');
  link(a, b);
  link(a, c);
  a.service.saveRules('owner', { rateLimit: { message: 2 } });
  b.service.saveRules('owner', { rateLimit: { message: 200 } });
  await Promise.all(b.service.handle(change(item(1, 'waiting_user'), item(1, 'working'))));
  await Promise.all(c.service.handle(change(item(1, 'waiting_user'), item(1, 'working'))));
  assert.equal(a.calls.length, 2, 'item 1 of B and item 1 of C are different items');
  assert.deepEqual(a.calls.map(call => call.origin.name).sort(), ['B', 'C']);
  await Promise.all(b.service.handle(change(item(2, 'waiting_user'), item(2, 'working'))));
  assert.equal(a.calls.length, 2, 'over the limit of the sender');
  assert.equal(b.service.recent()[0].outcome, 'relayed');
  assert.equal(b.service.recent()[0].detail, 'rate_limited');
  // The same delivery from the same origin twice (a retry whose first answer was lost) is sent once.
  const linkB = a.links.find(entry => entry.name === 'B');
  a.service.saveRules('owner', { rateLimit: { message: 50 } });
  const body = { notifier: 'telegram', mode: 'message', reason: 'status', item: relayItem(item(9, 'failed')), link: '' };
  assert.equal((await a.relay.accept(linkB, body)).outcome, 'sent');
  assert.equal((await a.relay.accept(linkB, body)).outcome, 'duplicate');
  // The origin is the link, never what the body says.
  await a.relay.accept(linkB, { ...body, item: relayItem(item(10, 'failed')), origin: { instance_id: ID.C, name: 'Spoofed' } });
  assert.equal(a.calls.at(-1).origin.name, 'B');
  // A malformed relay is refused.
  for (const bad of [{ ...body, notifier: 'email' }, { ...body, mode: 'off' }, { ...body, reason: 'call_failed' }, { ...body, item: { id: 1 } }]) {
    await assert.rejects(a.relay.accept(linkB, bad), error => error.statusCode === 400);
  }
});

test('a sender that is offline: relay_offline, one retry after 30 s, and never a send from the origin', async t => {
  const a = await makeDevice(t, 'A', { ready: true });
  const b = await makeDevice(t, 'B', { ready: true }); // logged in too, but A was chosen
  link(a, b);
  await a.relay.useThisDevice();
  await b.relay.refreshStale();
  assert.equal(b.relay.readChoice().instance_id, ID.A);
  setOnline(b, 'A', false);
  await Promise.all(b.service.handle(change(item(4, 'waiting_user'), item(4, 'working'))));
  assert.equal(b.service.recent()[0].outcome, 'relay_offline');
  assert.match(b.service.recent()[0].detail, /REMOTE_OFFLINE; one retry in 30 s/);
  assert.equal(b.calls.length, 0, 'B does not send although it is logged in');
  assert.deepEqual(b.timers.delays(), [30000]);
  b.timers.fire();
  await until(() => b.service.recent()[0].detail === 'REMOTE_OFFLINE', 'the retry failed too');
  assert.equal(b.service.recent()[0].outcome, 'relay_offline');
  assert.equal(b.timers.count(), 0, 'no second retry');
  assert.equal(b.calls.length, 0);
  assert.equal(a.calls.length, 0);
  // A status change drops a retry that is waiting.
  await Promise.all(b.service.handle(change(item(5, 'waiting_user'), item(5, 'working'))));
  assert.equal(b.timers.count(), 1);
  b.service.handle(change(item(5, 'done'), item(5, 'waiting_user')));
  assert.equal(b.timers.count(), 0);
  // Back online: the retry reaches A.
  await Promise.all(b.service.handle(change(item(6, 'failed'), item(6, 'working'))));
  setOnline(b, 'A', true);
  b.timers.fire();
  await until(() => a.calls.length === 1, 'the retry was sent by A');
  assert.equal(a.calls[0].item.id, 6);
  assert.equal(b.service.recent()[0].outcome, 'relayed');
});

test('an error answer of the sender is relay_failed and is retried once', async t => {
  const a = await makeDevice(t, 'A', { ready: true });
  const b = await makeDevice(t, 'B');
  link(a, b);
  a.notifyAnswer = () => { throw Object.assign(new Error('Telegram could not be reached'), { name: 'NotifyError', statusCode: 502 }); };
  await Promise.all(b.service.handle(change(item(1, 'waiting_user'), item(1, 'working'))));
  assert.equal(b.service.recent()[0].outcome, 'relay_failed', 'the sender tried and failed');
  assert.equal(b.timers.count(), 0, 'the sender did its own work: no retry');
  // The sender refuses (it is not the sender any more): relay_failed with one retry.
  b.relay.acceptChoice({ instance_id: ID.A, updated_at: 5 });
  a.relay.acceptChoice({ instance_id: ID.C, updated_at: 6 });
  a.peersOf.push({ id: 'link-A-C', name: 'C', online: false, remoteServerId: 9, instanceId: ID.C, baseUrl: 'http://127.0.0.1:9', token: 'tae_x' });
  await Promise.all(b.service.handle(change(item(2, 'waiting_user'), item(2, 'working'))));
  assert.equal(b.service.recent()[0].outcome, 'relay_failed');
  assert.match(b.service.recent()[0].detail, /^NOT_SENDER; one retry in 30 s$/);
  assert.equal(b.timers.count(), 1);
});

test('a delayed call waits on the origin and only the final call is relayed', async t => {
  const a = await makeDevice(t, 'A', { ready: true });
  const b = await makeDevice(t, 'B');
  link(a, b);
  b.service.saveRules('owner', { modes: { telegram: { waiting_user: 'call' } }, callDelayMinutes: 5 });
  await Promise.all(b.service.handle(change(item(8, 'waiting_user'), item(8, 'working'))));
  assert.equal(b.service.recent()[0].outcome, 'call_scheduled');
  assert.equal(relayPosts(a).length, 0, 'nothing is relayed while the call waits');
  assert.deepEqual(b.timers.delays(), [300000]);
  b.timers.fire();
  await until(() => a.calls.length === 1, 'the call was relayed');
  assert.equal(a.calls[0].mode, 'call');
  assert.equal(a.calls[0].reason, 'still');
  assert.equal(relayPosts(a).length, 1);
  // A call cancelled on the origin is never relayed.
  await Promise.all(b.service.handle(change(item(9, 'waiting_user'), item(9, 'working'))));
  b.service.handle(change(item(9, 'done'), item(9, 'waiting_user')));
  assert.equal(b.timers.fire().length, 0);
  await settle();
  assert.equal(relayPosts(a).length, 1);
});

test('the sender switch: two logged-in devices agree on one, "Use this device" moves it, and the old sender stops', async t => {
  const a = await makeDevice(t, 'A', { ready: true });
  const b = await makeDevice(t, 'B', { ready: true });
  link(a, b);
  await a.relay.refreshStale();
  await b.relay.refreshStale();
  // No choice yet: both pick the same device (the smallest instance id) and the page asks to choose.
  const before = { a: (await a.call('GET', '/api/attention-notify/relay')).body, b: (await b.call('GET', '/api/attention-notify/relay')).body };
  assert.equal(before.a.sender.self, true);
  assert.deepEqual(before.b.sender, { name: 'A', self: false, online: true });
  assert.equal(before.a.conflict, true);
  assert.equal(before.b.conflict, true);
  // The scope label of the settings sheet (GET /api/settings-sync `telegram`) says the same, and that someone must choose.
  assert.deepEqual(a.relay.summary(), { sender_name: 'A', self: true, conflict: true });
  assert.deepEqual(b.relay.summary(), { sender_name: 'A', self: false, conflict: true });
  await Promise.all(a.service.handle(change(item(1, 'waiting_user'), item(1, 'working'))));
  await Promise.all(b.service.handle(change(item(1, 'waiting_user'), item(1, 'working'))));
  assert.deepEqual(a.calls.map(call => call.origin ? call.origin.name : 'own'), ['own', 'B']);
  assert.equal(b.calls.length, 0);
  // B takes over from its page.
  const switched = await b.call('PUT', '/api/attention-notify/relay/sender', { use: 'self' });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.told, 1);
  assert.equal(switched.body.relay.sender.self, true);
  assert.equal(switched.body.relay.explicit, true);
  assert.deepEqual(b.relay.summary(), { sender_name: 'B', self: true, conflict: false });
  assert.equal(a.relay.readChoice().instance_id, ID.B, 'A got the choice');
  const put = a.received.find(entry => entry.method === 'PUT' && entry.path === '/v1/attention/notify-relay/sender');
  assert.ok(put);
  assert.equal(JSON.parse(put.raw).instance_id, ID.B);
  // A stops: its own item goes to B now.
  await Promise.all(a.service.handle(change(item(2, 'failed'), item(2, 'working'))));
  assert.equal(a.calls.length, 2, 'A sent nothing more');
  assert.equal(b.calls.length, 1);
  assert.deepEqual(b.calls[0].origin, { name: 'A' });
  assert.equal(a.service.recent()[0].outcome, 'relayed');
  assert.equal(a.service.recent()[0].via, 'B');
  // An older choice that arrives later loses; a newer one wins (last writer wins).
  const stored = b.relay.readChoice();
  assert.deepEqual(a.relay.acceptChoice({ instance_id: ID.A, updated_at: stored.updated_at - 1 }), stored);
  assert.equal(a.relay.readChoice().instance_id, ID.B);
  // A device that was offline during the switch catches up when its link comes up (both sides compare).
  const c = await makeDevice(t, 'C');
  link(b, c, { online: false });
  setOnline(c, 'B', true);
  await until(() => c.relay.readChoice().instance_id === ID.B, 'C learned the choice from B');
  // A device that is not set up cannot take over.
  const refused = await c.call('PUT', '/api/attention-notify/relay/sender', { use: 'self' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'Log in to Telegram on this device and choose account 2 first');
  // The chosen device logs out: the others fall back to a device that is set up.
  b.ready = false;
  b.serviceLinks.emit('link-B-A');
  a.serviceLinks.emit('link-A-B');
  await a.relay.refreshStale();
  await Promise.all(a.service.handle(change(item(3, 'failed'), item(3, 'working'))));
  assert.equal(a.calls.length, 3, 'A sends again: B has no Telegram any more');
  assert.equal(a.calls[2].origin, undefined);
});

test('a linked device of an older version is never the sender and is told nothing', async t => {
  const a = await makeDevice(t, 'A', { ready: true, older: true });
  const b = await makeDevice(t, 'B');
  link(a, b);
  await Promise.all(b.service.handle(change(item(1, 'waiting_user'), item(1, 'working'))));
  assert.equal(relayPosts(a).length, 0);
  assert.equal(b.service.recent()[0].outcome, 'skipped', 'B behaves as before: its own plugin, not set up');
  assert.equal(b.service.recent()[0].detail, 'not set up');
  // B gets its own login: it sends itself, and the switch tells A nothing.
  b.ready = true;
  await Promise.all(b.service.handle(change(item(2, 'waiting_user'), item(2, 'working'))));
  assert.equal(b.calls.length, 1);
  await b.relay.useThisDevice();
  assert.equal(a.received.filter(entry => entry.path.startsWith('/v1/attention/notify-relay')).length, 0, 'A was only asked for /v1/info');
  // A, the older device, still sends its own items itself (nothing here changes it).
  await Promise.all(a.service.handle(change(item(3, 'waiting_user'), item(3, 'working'))));
  assert.equal(a.calls.length, 1);
});

test('the test message of a device that is not the sender goes through the sender', async t => {
  const a = await makeDevice(t, 'A', { ready: true });
  const b = await makeDevice(t, 'B', { ready: true });
  link(a, b);
  await a.relay.useThisDevice();
  const viaRelay = await b.call('POST', '/api/attention-notify/relay/test', { kind: 'message' });
  assert.equal(viaRelay.status, 200);
  assert.deepEqual(viaRelay.body, { ok: true, outcome: 'sent', via: 'A' });
  // The plugin's own test button too, although B is logged in.
  const viaPlugin = await b.call('POST', '/api/attention-notify/telegram/test', { kind: 'call' });
  assert.equal(viaPlugin.status, 200);
  assert.equal(viaPlugin.body.via, 'A');
  assert.equal(b.tests.length, 0, 'B never used its own login');
  assert.deepEqual(a.tests.map(entry => [entry.kind, entry.origin.name]), [['message', 'B'], ['call', 'B']]);
  // And the manifest test of the plugin list.
  assert.deepEqual(await b.service.testPlugin('telegram', 'owner'), { ok: true, message: 'Test sent' });
  // The sender offline: an error the page can show.
  setOnline(b, 'A', false);
  const offline = await b.call('POST', '/api/attention-notify/relay/test', { kind: 'message' });
  assert.equal(offline.status, 502);
  assert.equal(offline.body.error, 'The sender device is offline; try again when it is online');
  // On the sender, the relay test route says it sends itself.
  assert.equal((await a.call('POST', '/api/attention-notify/relay/test', {})).status, 409);
});

test('secrets never travel in a relay payload or reach a log', async t => {
  const a = await makeDevice(t, 'A', { ready: true });
  const b = await makeDevice(t, 'B', { ready: true });
  link(a, b);
  // B has its own Telegram login stored (the plugin's own store), but A is the sender.
  b.service.saveRules('owner', { publicUrl: 'https://b.example.com' });
  b.db.prepare('INSERT INTO system_state (key, value) VALUES (?, ?)').run('attention-notify:telegram:owner', require('../lib/token-crypto').encryptToken(JSON.stringify({ session: SESSION, apiHash: API_HASH, apiId: 1 }), SECRET));
  await a.relay.useThisDevice();
  const withSecrets = item(1, 'waiting_user', {
    link_url: '/h5?task=1', title: 'Deploy',
    context: { pending: { text: 'Approve' }, excerpt: `transcript ${SESSION}`, tagent: { task_id: 1, terminal_id: 'x', token: 'ta-terminal-token' }, cwd: '/w', token: 'context-token' },
  });
  await Promise.all(b.service.handle(change(withSecrets, item(1, 'working'))));
  await b.call('POST', '/api/attention-notify/relay/test', { kind: 'message' });
  const posts = relayPosts(a);
  assert.equal(posts.length, 1);
  const payload = JSON.parse(posts[0].raw);
  assert.deepEqual(Object.keys(payload).sort(), ['item', 'link', 'mode', 'notifier', 'reason']);
  assert.equal(payload.link, 'https://b.example.com/h5?task=1');
  assert.deepEqual(Object.keys(payload.item.context).sort(), ['cwd', 'pending']);
  for (const entry of a.received) {
    for (const secret of [SESSION, API_HASH, 'ta-terminal-token', 'context-token', 'transcript']) assert.equal(entry.raw.includes(secret), false, `${secret} in ${entry.path}`);
  }
  const allLogs = [...a.logs, ...b.logs].join('\n');
  for (const secret of [SESSION, API_HASH, 'tae_B-to-A-link-token', 'tae_A-to-B-link-token', 'Deploy', 'Approve']) assert.equal(allLogs.includes(secret), false, `${secret} in a log`);
  assert.match(allLogs, /telegram item 1 waiting_user message: relayed via A \(sent\)/);
  assert.match(allLogs, /telegram item 1 waiting_user message: sent from B/);
});

test('the Engine routes take only link tokens, and the paths go through the tunnel', async t => {
  const a = await makeDevice(t, 'A', { ready: true });
  const b = await makeDevice(t, 'B');
  link(a, b);
  const asB = { Authorization: 'Bearer tae_B-to-A-link-token', 'Content-Type': 'application/json' };
  const status = await (await fetch(`${a.url}/v1/attention/notify-relay/status`, { headers: asB })).json();
  assert.deepEqual(status, { instance_id: ID.A, notifiers: { telegram: { ready: true } }, sender: { telegram: { instance_id: null, updated_at: 0 } }, effective: { telegram: ID.A } });
  assert.equal(JSON.stringify(status).includes('session'), false);
  const other = await fetch(`${a.url}/v1/attention/notify-relay/status`, { headers: { Authorization: 'Bearer tae_some-admin-token' } });
  assert.equal(other.status, 403);
  assert.deepEqual(await other.json(), { error: 'LINKED_ONLY' });
  assert.equal((await fetch(`${a.url}/v1/attention/notify-relay/status`)).status, 401);
  const big = await fetch(`${a.url}/v1/attention/notify-relay`, { method: 'POST', headers: asB, body: JSON.stringify({ notifier: 'telegram', padding: 'x'.repeat(70 * 1024) }) });
  assert.equal(big.status, 413);
  const badSender = await fetch(`${a.url}/v1/attention/notify-relay/sender`, { method: 'PUT', headers: asB, body: JSON.stringify({ instance_id: 'x y', updated_at: 1 }) });
  assert.equal(badSender.status, 400);
  for (const route of ['', '/status', '/sender', '/test']) assert.equal(checkTunnelTarget(`/v1/attention/notify-relay${route}`), `/v1/attention/notify-relay${route}`);
  // The stored choice is plain JSON in system_state under its key.
  await a.relay.useThisDevice();
  assert.equal(JSON.parse(a.db.prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY).value).instance_id, ID.A);
});

test('without linked devices nothing changes: Telegram sends here, and the page gets no sender to show', async t => {
  const a = await makeDevice(t, 'A', { ready: true });
  await Promise.all(a.service.handle(change(item(1, 'waiting_user'), item(1, 'working'))));
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0].origin, undefined);
  const view = (await a.call('GET', '/api/attention-notify/config')).body.relay;
  assert.equal(view.linked, 0);
  assert.deepEqual(view.sender, { name: 'A', self: true, online: true });
  assert.deepEqual(a.relay.summary(), { sender_name: 'A', self: true, conflict: false });
  a.ready = false;
  assert.equal(a.relay.summary(), null, 'no device has Telegram: nothing to name');
  assert.equal(a.requests.length, 0, 'no request to anyone');
});

// ---- Two real services ----
const PRELOAD = path.join(__dirname, 'fixtures', 'attention-fake-telegram.js');
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };

async function startService(t, { ready }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-relay-'));
  const notifierLog = path.join(temp, 'notifier.jsonl');
  fs.writeFileSync(notifierLog, '');
  const child = spawn(process.execPath, ['-r', PRELOAD, 'server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', SESSION_SECRET: SECRET, T_AGENT_DATA_DIR: temp, TAGENT_HOME: temp, T_AGENT_DB_PATH: path.join(temp, 'db.sqlite'),
      TASKS_BASE_DIR: path.join(temp, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false', ACCESS_MODE: 'local',
      TA_FAKE_NOTIFIER_LOG: notifierLog, TA_FAKE_TELEGRAM_READY: ready ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no start: ${output}`)), 20000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Server running at http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once('exit', code => reject(new Error(`exited ${code}: ${output}`)));
  });
  const stop = () => (child.exitCode !== null ? Promise.resolve() : new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); }));
  t.after(async () => { await stop(); fs.rmSync(temp, { recursive: true, force: true }); });
  const service = {
    url: `http://127.0.0.1:${port}`,
    output: () => output,
    deliveries: () => fs.readFileSync(notifierLog, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)),
    async call(method, route, body) {
      const response = await fetch(`${service.url}${route}`, { method, headers: HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      return { status: response.status, body: parsed, text };
    },
  };
  return service;
}

test('two real services over a service-link tunnel: an item on B that needs you is delivered once, by A, from B', async t => {
  const a = await startService(t, { ready: true });
  const b = await startService(t, { ready: false });
  // B joins A: A reaches B through the tunnel, B calls A directly.
  const made = await a.call('POST', '/api/service-links/code', {});
  assert.equal(made.status, 201, made.text);
  const joined = await b.call('POST', '/api/service-links/join', { url: a.url, code: made.body.code, confirm: true });
  assert.equal(joined.status, 201, joined.text);
  const linkOf = async side => (await side.call('GET', '/api/service-links')).body.links.find(entry => entry.id === joined.body.id);
  await until(async () => (await linkOf(a))?.online && (await linkOf(b))?.online, 'both sides online', 10000);
  const nameOfA = (await linkOf(b)).name;
  const nameOfB = (await linkOf(a)).name;
  await until(async () => ((await b.call('GET', '/api/attention-notify/config')).body.relay.sender || {}).name === nameOfA, 'B knows that A sends', 10000);
  // Messages at once (the default waits 3 minutes; the wait itself is tested in test/attention-notify.test.js).
  assert.equal((await b.call('PUT', '/api/attention-notify/config', { messageDelayMinutes: 0 })).status, 200);
  // An item on B enters waiting_user.
  const created = await b.call('POST', '/api/attention', { title: 'Relay me', status: 'working' });
  assert.equal(created.status, 201, created.text);
  const moved = await b.call('PATCH', `/api/attention/${created.body.id}`, { status: 'waiting_user', attention_reason: 'Needs approval' });
  assert.equal(moved.status, 200, moved.text);
  await until(() => a.deliveries().some(entry => entry.kind === 'notify'), 'A delivered', 10000);
  await new Promise(resolve => setTimeout(resolve, 500)); // nothing more arrives
  const onA = a.deliveries().filter(entry => entry.kind === 'notify');
  assert.equal(onA.length, 1, JSON.stringify(onA));
  assert.equal(onA[0].title, 'Relay me');
  assert.equal(onA[0].status, 'waiting_user');
  assert.deepEqual(onA[0].origin, { name: nameOfB });
  assert.match(onA[0].text, new RegExp(`From ${nameOfB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(b.deliveries().length, 0, 'B sent nothing itself');
  const recentB = (await b.call('GET', '/api/attention-notify/config')).body.recent;
  assert.equal(recentB[0].outcome, 'relayed');
  assert.equal(recentB[0].via, nameOfA);
  // The other way: A's own item stays on A; A is told it sends for B.
  await until(async () => ((await a.call('GET', '/api/attention-notify/config')).body.relay.relaying || []).length === 1, 'A lists B', 10000);
  // A test from B's page goes through A.
  const tested = await b.call('POST', '/api/attention-notify/relay/test', { kind: 'message' });
  assert.equal(tested.status, 200, tested.text);
  await until(() => a.deliveries().some(entry => entry.kind === 'test' && entry.origin && entry.origin.name === nameOfB), 'the test reached A');
  for (const side of [a, b]) assert.equal(/tae_|tsl_/.test(side.output()), false, 'no token in the server log');
});
