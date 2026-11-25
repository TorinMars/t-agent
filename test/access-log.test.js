// The access log (services/access-log.js, lib/client-ip.js, routes/access.js; "Access log" in docs/design/access-log.md): the client address
// behind the SSH tunnel and a VPS proxy, the device names, the detection rules and their rate limits, retention, sign-out, the routes, and that the
// "is this request local" checks of the login did not change.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const express = require('express');

const { clientAddress, clientIp, normalizeIp, isLoopback, networkOf, isLoopbackHost, lastOfChain } = require('../lib/client-ip');
const accessLog = require('../services/access-log');
const { createAccessLog, deviceName, deviceIdOf, RETENTION_DAYS } = accessLog;
const { isLocalInitialization } = require('../services/client-auth');
const { fromThisMachine } = require('../lib/terminal-relay-auth');
const { createAccessRouter } = require('../routes/access');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
function memoryDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expired INTEGER NOT NULL)');
  return db;
}
const req = ({ peer = '203.0.113.5', headers = {}, url = '/api/tasks' } = {}) => ({ socket: { remoteAddress: peer, localAddress: '127.0.0.1' }, headers, url, get: name => headers[name.toLowerCase()] });
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const D1 = 'device1aaaaaa';
const D2 = 'device2bbbbbb';
const D3 = 'device3cccccc';

function fakeAttention() {
  const items = [];
  const listeners = new Set();
  return {
    items,
    create(body) { const item = { id: items.length + 1, status: 'todo', ...body }; items.push(item); return item; },
    get(id) { return items.find(item => item.id === id) || null; },
    update(id, body) { const item = items.find(entry => entry.id === id); Object.assign(item, body); for (const fn of listeners) fn({ item }); return item; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
function setup({ mode = 'remote', trusted = false, start = 1_000_000 } = {}) {
  const db = memoryDb();
  const clock = { now: start };
  const attention = fakeAttention();
  const ended = [];
  const state = { mode };
  const log = createAccessLog({ db, now: () => clock.now, attention: () => attention, mode: () => state.mode, trusted: () => trusted, endSession: sid => ended.push(sid), log: { warn() {} } });
  return { db, clock, attention, ended, state, log };
}
const events = db => db.prepare('SELECT kind, device_id, ip, detail FROM access_events ORDER BY id').all();

// ---- The client address ----

test('clientIp: a direct peer is used as it is, and its forwarding headers are never read', () => {
  assert.equal(clientIp(req({ peer: '203.0.113.5' })), '203.0.113.5');
  assert.deepEqual(clientAddress(req({ peer: '198.51.100.7', headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' } }), { trusted: true }), { ip: '198.51.100.7', via: 'direct' }, 'a spoofed XFF from a non-loopback peer is ignored');
  assert.equal(clientIp(req({ peer: '::ffff:192.168.1.20' })), '192.168.1.20', 'an IPv4-mapped peer is shown as IPv4');
  assert.equal(clientIp(req({ peer: '2001:DB8::1' })), '2001:db8::1');
});

test('clientIp: through the tunnel (loopback peer) the right-most address of X-Forwarded-For is the proxy\'s, when a proxy is set up', () => {
  const chain = { 'x-forwarded-for': '6.6.6.6, 10.0.0.1, 203.0.113.9' };
  assert.deepEqual(clientAddress(req({ peer: '127.0.0.1', headers: chain }), { trusted: true }), { ip: '203.0.113.9', via: 'proxy' }, 'a client cannot choose the right-most entry');
  assert.deepEqual(clientAddress(req({ peer: '::1', headers: { 'x-forwarded-for': '203.0.113.9:51234' } }), { trusted: () => true }), { ip: '203.0.113.9', via: 'proxy' }, 'a port is stripped');
  assert.equal(clientIp(req({ peer: '::ffff:127.0.0.1', headers: { 'x-forwarded-for': '[2001:db8::5]:443' } }), { trusted: true }), '2001:db8::5', 'bracketed IPv6 with a port');
  assert.equal(clientIp(req({ peer: '127.0.0.1', headers: { 'x-forwarded-for': '::ffff:198.51.100.4' } }), { trusted: true }), '198.51.100.4', 'a mapped address in the chain');
  assert.equal(clientIp(req({ peer: '127.0.0.1', headers: { 'x-real-ip': '198.51.100.3' } }), { trusted: true }), '198.51.100.3', 'X-Real-IP when there is no XFF');
  assert.equal(clientIp(req({ peer: '127.0.0.1', headers: { forwarded: 'for=192.0.2.60;proto=http, for="[2001:db8::7]:4711"' } }), { trusted: true }), '2001:db8::7', 'the right-most for= of Forwarded');
  assert.equal(clientIp(req({ peer: '127.0.0.1', headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.2' } }), { trusted: false }), '127.0.0.1', 'no proxy set up: the headers are not used');
  assert.equal(clientAddress(req({ peer: '127.0.0.1', headers: { 'x-forwarded-for': '1.2.3.4' } }), { trusted: false }).via, 'untrusted');
  assert.deepEqual(clientAddress(req({ peer: '127.0.0.1' }), { trusted: true }), { ip: '127.0.0.1', via: 'loopback' }, 'no header: this machine or a tunnel that does not pass the address');
});

test('clientIp: garbage is never taken for an address', () => {
  for (const value of ['', 'unknown', 'not-an-ip, ', '999.1.1.1', '1.2.3', 'abc::xyz', '<script>', 'x'.repeat(5000)]) {
    assert.equal(clientIp(req({ peer: '127.0.0.1', headers: { 'x-forwarded-for': value } }), { trusted: true }), '127.0.0.1', JSON.stringify(value.slice(0, 20)));
  }
  assert.equal(lastOfChain('198.51.100.1, garbage'), null, 'garbage where the proxy\'s entry should be: nothing further left is trusted');
  assert.equal(lastOfChain('198.51.100.1, '), '198.51.100.1', 'an empty trailing entry is skipped');
  assert.equal(clientIp(req({ peer: '' })), 'unknown');
  for (const value of ['', null, 42, '1.2.3.4.5', '[::1', 'fe80::1%en0']) assert.equal(normalizeIp(value), value === 'fe80::1%en0' ? 'fe80::1' : null, String(value));
});

test('networks, loopback and hosts', () => {
  assert.equal(networkOf('203.0.113.9'), '203.0.113');
  assert.equal(networkOf('2001:db8:1:2:3::9'), '2001:0db8:0001:0002');
  assert.equal(networkOf('2001:db8:1:2::'), networkOf('2001:db8:1:2:ffff::1'));
  assert.ok(isLoopback('127.5.0.1') && isLoopback('::1') && isLoopback('::ffff:127.0.0.1') && !isLoopback('10.0.0.1'));
  assert.ok(isLoopbackHost('localhost:3000') && isLoopbackHost('127.0.0.1') && isLoopbackHost('[::1]:3000') && !isLoopbackHost('torinmoon.icu'));
});

test('the "is this request local" checks of the login still treat any forwarding header as not local', () => {
  const local = req({ peer: '127.0.0.1', headers: { host: '127.0.0.1:3000' } });
  assert.equal(isLocalInitialization(local), true);
  assert.equal(fromThisMachine(local), true);
  for (const header of ['x-forwarded-for', 'x-real-ip', 'forwarded']) {
    const forwarded = req({ peer: '127.0.0.1', headers: { host: '127.0.0.1:3000', [header]: '127.0.0.1' } });
    assert.equal(isLocalInitialization(forwarded), false, header);
    assert.equal(fromThisMachine(forwarded), false, header);
  }
  assert.equal(isLocalInitialization(req({ peer: '127.0.0.1', headers: { host: 'torinmoon.icu' } })), false, 'a tunnel with another Host is not local');
});

// ---- Device ids and names ----

test('device ids come from X-TA-Device or the websocket query, and malformed ones are refused', () => {
  assert.equal(deviceIdOf(req({ headers: { 'x-ta-device': D1 } })), D1);
  assert.equal(deviceIdOf(req({ url: `/terminal/ws?taskId=1&device=${D2}` })), D2);
  for (const bad of ['short', 'has space inside!', 'x'.repeat(65), '../../etc']) assert.equal(deviceIdOf(req({ headers: { 'x-ta-device': bad } })), null, bad);
});

test('device names are one line derived from the User-Agent', () => {
  assert.equal(deviceName(IPHONE), 'iPhone · Safari');
  assert.equal(deviceName(MAC_CHROME), 'Mac · Chrome');
  assert.equal(deviceName(`${IPHONE.replace('Version/18.1', 'CriOS/131.0')}`), 'iPhone · Chrome');
  assert.equal(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) T-AgentApp/2.166.1'), 'T-Agent Mac App');
  assert.equal(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0'), 'Windows · Edge');
  assert.equal(deviceName('Mozilla/5.0 (Linux; Android 14) Gecko/131.0 Firefox/131.0'), 'Android · Firefox');
  assert.equal(deviceName(''), 'Unknown device');
});

// ---- Detection ----

test('the first device of a fresh install is learned silently; a new device later raises one alert', () => {
  const { db, log, attention } = setup();
  assert.deepEqual(log.seen({ deviceId: D1, ip: '203.0.113.5', userAgent: MAC_CHROME, force: true }), { created: true, newIp: false, alerted: false });
  assert.equal(log.device(D1).confirmed, true);
  assert.equal(attention.items.length, 0);
  const second = log.seen({ deviceId: D2, ip: '198.51.100.9', userAgent: IPHONE, force: true });
  assert.equal(second.alerted, true);
  assert.equal(log.device(D2).confirmed, false);
  assert.equal(attention.items.length, 1);
  assert.equal(attention.items[0].title, 'New device signed in: iPhone · Safari, IP 198.51.100.9. Was it you?');
  assert.equal(attention.items[0].status, 'waiting_user');
  assert.equal(attention.items[0].source, 'access-log');
  assert.deepEqual(events(db).map(row => row.kind), ['new_device', 'new_device']);
  assert.match(events(db)[0].detail, /first device/);
  const stored = JSON.stringify(db.prepare('SELECT * FROM access_devices').all());
  assert.doesNotMatch(stored, /Mozilla|AppleWebKit/, 'the raw User-Agent is never kept');
});

test('a session signed in before the access log started is learned silently; local mode and a switched-off setting never alert', () => {
  const remote = setup();
  remote.log.seen({ deviceId: D1, ip: '203.0.113.5', force: true });
  assert.equal(remote.log.seen({ deviceId: D2, ip: '203.0.113.6', carried: true, force: true }).alerted, false);
  assert.equal(remote.log.device(D2).confirmed, true);
  remote.log.setAlertsEnabled(false);
  assert.equal(remote.log.seen({ deviceId: D3, ip: '203.0.113.7', force: true }).alerted, false);
  assert.equal(remote.log.device(D3).confirmed, false, 'still not confirmed, only not alerted');
  assert.throws(() => remote.log.setAlertsEnabled('no'), /access_alerts must be true or false/);

  const local = setup({ mode: 'local' });
  local.log.seen({ deviceId: D1, ip: '127.0.0.1', force: true });
  assert.equal(local.log.seen({ deviceId: D2, ip: '127.0.0.1', force: true }).alerted, false);
  assert.equal(local.attention.items.length, 0);
});

test('a known device from a new address: an event always, an alert only outside the /24 or /64 of its earlier addresses, at most one an hour', () => {
  const { db, log, attention, clock } = setup();
  log.seen({ deviceId: D1, ip: '203.0.113.5', force: true });
  assert.deepEqual(log.seen({ deviceId: D1, ip: '203.0.113.77', force: true }), { created: false, newIp: true, alerted: false }, 'the same /24');
  assert.deepEqual(log.seen({ deviceId: D1, ip: '198.51.100.1', force: true }), { created: false, newIp: true, alerted: true }, 'another network');
  assert.match(attention.items[0].title, /^Known device signed in from a new address: .+, IP 198\.51\.100\.1\. Was it you\?$/);
  clock.now += 10 * 60 * 1000;
  assert.equal(log.seen({ deviceId: D1, ip: '192.0.2.1', force: true }).alerted, false, 'rate limit: one alert per device per hour');
  clock.now += 61 * 60 * 1000;
  assert.equal(log.seen({ deviceId: D1, ip: '100.64.0.1', force: true }).alerted, true, 'an hour later it alerts again');
  assert.equal(log.seen({ deviceId: D1, ip: '127.0.0.1', force: true }).alerted, false, 'a loopback address never alerts');
  const v6 = setup();
  v6.log.seen({ deviceId: D1, ip: '2001:db8:1:2::5', force: true });
  assert.equal(v6.log.seen({ deviceId: D1, ip: '2001:db8:1:2::9', force: true }).alerted, false, 'the same /64');
  assert.equal(v6.log.seen({ deviceId: D1, ip: '2001:db8:9:9::1', force: true }).alerted, true);
  assert.equal(log.device(D1).ips_seen_count, 6);
  assert.equal(events(db).filter(row => row.kind === 'new_ip').length, 5);
});

test('a device row is written at most once per 10 minutes for the same address', () => {
  const { db, log, clock } = setup();
  log.seen({ deviceId: D1, ip: '203.0.113.5' });
  clock.now += 60 * 1000;
  assert.deepEqual(log.seen({ deviceId: D1, ip: '203.0.113.5' }), { throttled: true });
  assert.equal(log.device(D1).last_seen, 1_000_000);
  clock.now += 10 * 60 * 1000;
  log.seen({ deviceId: D1, ip: '203.0.113.5' });
  assert.equal(log.device(D1).last_seen, clock.now);
  assert.equal(events(db).length, 1, 'touches write no events');
});

test('five wrong codes from one address within 10 minutes raise one alert; a refused attempt is "blocked"', () => {
  const { db, log, attention, clock } = setup();
  const from = req({ peer: '198.51.100.66', headers: { 'x-ta-device': D2 } });
  for (let i = 0; i < 4; i += 1) assert.equal(log.loginFailed(from).alerted, false);
  assert.equal(log.loginFailed(from).alerted, true);
  assert.equal(attention.items.length, 1);
  assert.equal(attention.items[0].title, '5 wrong codes from IP 198.51.100.66 in 10 minutes');
  assert.equal(log.loginFailed(from).alerted, false, 'one alert per address per hour');
  clock.now += 11 * 60 * 1000;
  assert.equal(log.loginFailed(req({ peer: '198.51.100.67' })).alerted, false, 'another address counts on its own');
  log.loginFailed(from, { limited: true });
  assert.equal(events(db).at(-1).kind, 'blocked');
  assert.equal(events(db).filter(row => row.kind === 'login_failed').length, 7);
});

// ---- Sessions, sign-out ----

function session(db, sid, sess, expired = 9e15) {
  db.prepare('INSERT INTO sessions (sid, sess, expired) VALUES (?, ?, ?)').run(sid, JSON.stringify(sess), expired);
}

test('a request binds its session to the device; a signed-out device loses its login and is refused until it logs in again', () => {
  const { db, log, ended, clock, attention } = setup();
  const me = { clientAuth: { authenticatedAt: clock.now + 1 } };
  clock.now += 5;
  assert.equal(log.onRequest(req({ headers: { 'x-ta-device': D1, 'user-agent': MAC_CHROME } }), me), 'bound');
  assert.equal(me.access.deviceId, D1);
  assert.equal(log.onRequest(req({ headers: {} }), me), 'seen', 'a bound session needs no header');
  const phone = {};
  log.loginOk(req({ peer: '198.51.100.9', headers: { 'x-ta-device': D2, 'user-agent': IPHONE } }), phone, { detail: '' });
  assert.equal(phone.access.deviceId, D2);
  assert.equal(attention.items.length, 1, 'the new device signed in: one alert');
  session(db, 'sid-phone', { ...phone, clientAuth: { ok: 1 } });
  session(db, 'sid-phone-2', { access: { deviceId: D2, boundAt: 1 } });
  session(db, 'sid-me', { access: me.access });
  assert.equal(log.devices({ current: D1 }).find(row => row.id === D2).sessions, 2);

  assert.throws(() => log.revoke(D1, { current: D1 }), error => error.code === 'ACCESS_CURRENT_DEVICE' && error.statusCode === 409);
  assert.throws(() => log.revoke('nonexistent1', { current: D1 }), error => error.code === 'ACCESS_DEVICE_NOT_FOUND' && error.statusCode === 404);
  clock.now += 5;
  const result = log.revoke(D2, { current: D1 });
  assert.equal(result.sessions_ended, 2);
  assert.deepEqual(ended.sort(), ['sid-phone', 'sid-phone-2']);
  assert.deepEqual(db.prepare('SELECT sid FROM sessions').pluck().all(), ['sid-me'], 'only the other device\'s sessions are deleted');
  assert.equal(events(db).at(-1).kind, 'revoked');

  // A session of it that is still around (a copy held in memory) or a session that names it later: the login is taken off.
  const comeback = { clientAuth: { authenticatedAt: 1 }, access: { deviceId: D2, boundAt: phone.access.boundAt } };
  assert.equal(log.onRequest(req({ headers: {} }), comeback), 'blocked');
  assert.equal(comeback.clientAuth, undefined);
  const borrowed = { clientAuth: { authenticatedAt: 1 } };
  assert.equal(log.onRequest(req({ headers: { 'x-ta-device': D2 } }), borrowed), 'blocked', 'an unbound session cannot take the id of a signed-out device');
  assert.equal(events(db).filter(row => row.kind === 'blocked').length, 1, 'blocked is written once an hour per device');

  // Logging in with a code again welcomes it back.
  clock.now += 5;
  const again = {};
  log.loginOk(req({ peer: '198.51.100.9', headers: { 'x-ta-device': D2 } }), again);
  assert.equal(log.device(D2).revoked_at, null);
  assert.equal(log.onRequest(req({ headers: {} }), again), 'seen');
});

test('in local access mode there is nothing to sign out', () => {
  const { log } = setup({ mode: 'local' });
  log.seen({ deviceId: D1, ip: '127.0.0.1', force: true });
  assert.throws(() => log.revoke(D1, { current: D2 }), error => error.code === 'ACCESS_NO_LOGIN' && error.statusCode === 409);
});

test('rename, confirm ("It was me", also from the T-Attention alert) and forget', () => {
  const { db, log, attention } = setup();
  log.watchAttention(attention);
  log.seen({ deviceId: D1, ip: '203.0.113.5', force: true });
  log.seen({ deviceId: D2, ip: '198.51.100.9', userAgent: IPHONE, force: true });
  log.seen({ deviceId: D3, ip: '192.0.2.9', userAgent: IPHONE, force: true });
  assert.equal(log.rename(D2, '  My phone ').name, 'My phone');
  assert.equal(log.rename(D2, '').name, 'iPhone · Safari', 'empty goes back to the derived name');
  for (const bad of ['x'.repeat(61), 'two\nlines', 42]) assert.throws(() => log.rename(D2, bad), /one line of at most 60/);
  const confirmed = log.confirm(D2);
  assert.equal(confirmed.confirmed, true);
  assert.equal(attention.items[0].status, 'done', 'its alert is closed');
  attention.update(2, { status: 'done' });
  assert.equal(log.device(D3).confirmed, true, 'marking the alert done is "It was me"');
  assert.throws(() => log.forget(D1, { current: D1 }), /Use Log out instead/);
  assert.equal(log.forget(D2, { current: D1 }), true);
  assert.throws(() => log.device(D2), /not in the access log/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM access_events WHERE device_id = ?').get(D2).n, 0, 'its events go too');
});

test('events page newest first with a cursor', () => {
  const { log } = setup();
  for (let i = 0; i < 7; i += 1) log.loginFailed(req({ peer: `198.51.100.${i}` }));
  const first = log.events({ limit: 3 });
  assert.equal(first.events.length, 3);
  assert.equal(first.more, true);
  assert.equal(first.events[0].ip, '198.51.100.6');
  const next = log.events({ before: first.events.at(-1).id, limit: 3 });
  assert.deepEqual(next.events.map(row => row.ip), ['198.51.100.3', '198.51.100.2', '198.51.100.1']);
  const last = log.events({ before: next.events.at(-1).id, limit: 3 });
  assert.equal(last.events.length, 1);
  assert.equal(last.more, false);
  assert.equal(log.events({ limit: 'x' }).events.length, 7);
});

test('retention: events and addresses older than 90 days go, devices stay', () => {
  const { db, log, clock } = setup();
  log.seen({ deviceId: D1, ip: '203.0.113.5', force: true });
  log.loginFailed(req({ peer: '198.51.100.1' }));
  clock.now += (RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;
  log.seen({ deviceId: D1, ip: '192.0.2.1', force: true });
  assert.deepEqual(log.prune(), { events: 2, ips: 1 });
  assert.deepEqual(events(db).map(row => row.kind), ['new_ip']);
  assert.equal(log.device(D1).last_ip, '192.0.2.1');
  assert.equal(log.device(D1).ips_seen_count, 1);
});

test('the settings sync adapter of access-alerts round-trips and refuses a bad value', () => {
  const { db, log } = setup();
  assert.equal(accessLog.exportForSync({ db }), null, 'on by default, nothing stored');
  log.setAlertsEnabled(false);
  assert.deepEqual(accessLog.exportForSync({ db }), { enabled: false });
  accessLog.importFromSync({ db }, 'owner', { enabled: true });
  assert.equal(log.alertsEnabled(), true);
  accessLog.importFromSync({ db }, 'owner', null);
  assert.equal(accessLog.exportForSync({ db }), null);
  assert.throws(() => accessLog.importFromSync({ db }, 'owner', { enabled: 'yes' }), /INVALID_SYNC_VALUE/);
});

// ---- The routes ----

async function withRouter(t, { mode = 'remote', sessionOf = () => ({}) } = {}) {
  const ctx = setup({ mode });
  const app = express();
  app.use(express.json());
  app.use((request, res, next) => { request.session = sessionOf(request); next(); });
  app.use('/api/access', createAccessRouter({ service: () => ctx.log, mode: () => ctx.state.mode }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/access`;
  const call = async (method, route, body, headers = {}) => {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { ...ctx, call };
}

test('GET /api/access/devices names the current device and the mode; the actions answer the documented errors', async t => {
  const ctx = await withRouter(t, { sessionOf: () => ({ access: { deviceId: D1, boundAt: 1 } }) });
  ctx.log.seen({ deviceId: D1, ip: '127.0.0.1', force: true });
  ctx.clock.now += 1000;
  ctx.log.seen({ deviceId: D2, ip: '198.51.100.9', userAgent: IPHONE, force: true });
  const list = await ctx.call('GET', '/devices', undefined, { Host: 'torinmoon.icu' });
  assert.equal(list.status, 200);
  assert.equal(list.body.mode, 'remote');
  assert.equal(list.body.can_sign_out, true);
  assert.equal(list.body.current_device, D1);
  assert.deepEqual(list.body.alerts, { enabled: true });
  assert.equal(list.body.ip_note, null, 'fetch sets its own Host; the tunnel note is checked in the unit below');
  assert.deepEqual(list.body.devices.map(row => [row.id, row.current, row.confirmed, row.loopback]), [[D2, false, false, false], [D1, true, true, true]]);
  assert.deepEqual((await ctx.call('POST', `/devices/${D1}/revoke`)).body.error, 'ACCESS_CURRENT_DEVICE');
  assert.deepEqual((await ctx.call('DELETE', `/devices/${D1}`)).status, 409);
  assert.equal((await ctx.call('POST', '/devices/nonexistent1/rename', { name: 'x' })).status, 404);
  assert.equal((await ctx.call('POST', `/devices/${D2}/rename`, { name: 'Phone' })).body.device.name, 'Phone');
  assert.equal((await ctx.call('POST', `/devices/${D2}/confirm`)).body.device.confirmed, true);
  const revoked = await ctx.call('POST', `/devices/${D2}/revoke`);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.ok, true);
  assert.equal(typeof revoked.body.device.revoked_at, 'number');
  assert.deepEqual((await ctx.call('PUT', '/settings', { access_alerts: false })).body, { access_alerts: false });
  assert.deepEqual((await ctx.call('GET', '/settings')).body, { access_alerts: false });
  assert.equal((await ctx.call('PUT', '/settings', { access_alerts: 'off' })).body.error, 'ACCESS_SETTINGS_INVALID');
  const page = await ctx.call('GET', '/events?limit=2');
  assert.equal(page.body.events.length, 2);
  assert.equal(page.body.events[0].kind, 'revoked');
  assert.equal(page.body.more, true);
  assert.equal((await ctx.call('DELETE', `/devices/${D2}`)).body.ok, true);
  ctx.state.mode = 'local';
  const local = await ctx.call('GET', '/devices');
  assert.equal(local.body.can_sign_out, false);
});

test('the tunnel note: a loopback request with another Host and no forwarding header, or forwarding headers that are not used', () => {
  const { log } = setup();
  assert.equal(log.ipNote(req({ peer: '127.0.0.1', headers: { host: 'torinmoon.icu' } })), 'tunnel_no_forward');
  assert.equal(log.ipNote(req({ peer: '127.0.0.1', headers: { host: '127.0.0.1:3000' } })), null, 'this machine');
  assert.equal(log.ipNote(req({ peer: '127.0.0.1', headers: { host: 'torinmoon.icu', 'x-forwarded-for': '198.51.100.1' } })), 'untrusted_forward', 'no proxy set up here');
  const trusted = setup({ trusted: true });
  assert.equal(trusted.log.ipNote(req({ peer: '127.0.0.1', headers: { host: 'torinmoon.icu', 'x-forwarded-for': '198.51.100.1' } })), null);
  assert.equal(trusted.log.ipNote(req({ peer: '203.0.113.5', headers: { host: 'torinmoon.icu' } })), null, 'a direct visitor');
});
