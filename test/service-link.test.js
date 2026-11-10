// Service links: the 6-digit code, the join on both sides, unlink and the revoked state. The first half drives two services over in-memory databases;
// the second half runs two real server.js processes with separate throwaway data folders.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const WebSocket = require('ws');
const { createServiceLinks, CODE, STATE_KEY } = require('../services/service-links');
const { createAccessToken } = require('../services/engine-auth');

const SECRET = 'service-link-test-secret-'.repeat(3);
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
const INSTANCE_B = '22222222-2222-4222-8222-222222222222';
const PEER_TOKEN = `tae_${'p'.repeat(40)}`;
const HTTP_ERROR = (code, statusCode) => Object.assign(new Error(code), { statusCode });

function fakeTunnel() {
  const online = new Set();
  const listeners = [];
  const clients = [];
  const dropped = [];
  const hub = {
    accept() {},
    isOnline: id => online.has(id),
    drop(id, reason) { dropped.push([id, reason]); if (online.delete(id)) listeners.forEach(fn => fn({ linkId: id, online: false })); },
    onChange: fn => listeners.push(fn),
  };
  return {
    clients, dropped,
    tunnelBase: id => `http://link-${id}.tunnel.invalid`,
    isTunnelBase: url => /tunnel\.invalid$/.test(url),
    linkIdOf: url => url.slice(12, 48),
    getHub: () => hub,
    startTunnelClient(options) {
      const client = { ...options, stopped: false, stop() { client.stopped = true; } };
      clients.push(client);
      return client;
    },
    emit(id, up) { if (up) online.add(id); else online.delete(id); listeners.forEach(fn => fn({ linkId: id, online: up })); },
  };
}

function fixture(t, instanceId, { request, database } = {}) {
  const db = database || new Database(':memory:');
  if (!database) { db.exec(SCHEMA); t.after(() => db.close()); }
  const clock = { now: 1_000_000_000_000 };
  const tunnel = fakeTunnel();
  const service = createServiceLinks({
    db, sessionSecret: SECRET, tunnel, request: request || (async () => { throw new Error('UNEXPECTED_REQUEST'); }), now: () => clock.now,
    identity: () => ({ instance_id: instanceId, name: instanceId === INSTANCE_A ? 'service-a' : 'service-b', version: '9.9.9' }),
    log: { error() {} },
  });
  service.start({ port: 4100 });
  return { db, service, tunnel, clock };
}

// The joiner B, whose requests reach the initiator A's service directly.
function linkedPair(t) {
  const calls = [];
  const a = fixture(t, INSTANCE_A);
  const failNext = {};
  const b = fixture(t, INSTANCE_B, {
    async request(base, route, token, options = {}) {
      calls.push({ base, route, token, options });
      if (failNext.route === route) throw failNext.error;
      if (route === '/v1/health') return { ok: true, capabilities: ['service-links'] };
      if (route === '/v1/service-links/join') {
        try { return a.service.acceptJoin(options.body); }
        catch (error) { throw HTTP_ERROR(error.message, error.statusCode); }
      }
      if (/\/unlink$/.test(route)) return '';
      if (route === '/v1/info') return { engine_version: '9.9.9' };
      throw HTTP_ERROR('REMOTE_HTTP_404', 404);
    },
  });
  return { a, b, calls, failNext };
}

const joinBody = (extra = {}) => ({ code: '000000', name: 'service-b', instance_id: INSTANCE_B, access_token: PEER_TOKEN, ...extra });
const count = (db, table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const activeTokens = db => db.prepare('SELECT * FROM engine_access_tokens WHERE revoked_at IS NULL').all();
const refused = (fn, code) => assert.throws(fn, error => error.message === code);
const refusedAsync = (promise, code) => assert.rejects(promise, error => error.message === code);
const wrongCode = code => (code === '123456' ? '654321' : '123456');
const browserJoin = (b, code, extra = {}) => b.service.join({ url: 'http://a.example.test:3000', code, confirm: true, ownerId: 'local', ...extra });

test('the code is six digits, as a string, valid for ten minutes, and only its hash is kept', t => {
  const a = fixture(t, INSTANCE_A);
  for (let index = 0; index < 50; index += 1) {
    const created = a.service.createCode('local');
    assert.match(created.code, /^\d{6}$/);
    assert.equal(typeof created.code, 'string');
    assert.equal(created.expires_in_seconds, 600);
  }
  assert.equal(count(a.db, 'engine_pairing_codes'), 0, 'held in memory, not in the Engine pairing table');
  assert.equal(CODE.maxFailures, 5);
});

test('a code works once, issues a token and stores the peer as an offline tunnel row', t => {
  const a = fixture(t, INSTANCE_A);
  const { code } = a.service.createCode('local');
  const answer = a.service.acceptJoin(joinBody({ code }));
  assert.deepEqual(Object.keys(answer).sort(), ['access_token', 'instance_id', 'link_id', 'name', 'tunnel_token', 'version']);
  assert.match(answer.access_token, /^tae_/);
  assert.match(answer.tunnel_token, /^tsl_/);
  assert.equal(answer.instance_id, INSTANCE_A);

  const row = a.db.prepare('SELECT * FROM remote_servers').get();
  assert.equal(row.owner_id, 'local');
  assert.equal(row.status, 'offline');
  assert.equal(row.base_url, a.tunnel.tunnelBase(answer.link_id));
  const stored = a.db.prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY).value;
  assert.equal(stored.includes(answer.tunnel_token), false, 'the tunnel token is stored hashed');
  assert.equal(activeTokens(a.db)[0].principal_id, 'local');
  assert.match(activeTokens(a.db)[0].name, /^Service link: /);

  refused(() => a.service.acceptJoin(joinBody({ code, instance_id: INSTANCE_B.replace(/2/g, '3') })), 'INVALID_CODE');
  assert.equal(activeTokens(a.db).length, 1);
});

test('an expired code is refused', t => {
  const a = fixture(t, INSTANCE_A);
  const { code } = a.service.createCode('local');
  a.clock.now += CODE.ttlMs;
  refused(() => a.service.acceptJoin(joinBody({ code })), 'INVALID_CODE');
  assert.equal(count(a.db, 'remote_servers'), 0);
});

test('a code works up to its last millisecond', t => {
  const a = fixture(t, INSTANCE_A);
  const { code } = a.service.createCode('local');
  a.clock.now += CODE.ttlMs - 1;
  assert.ok(a.service.acceptJoin(joinBody({ code })).link_id);
});

test('a new code replaces the old one', t => {
  const a = fixture(t, INSTANCE_A);
  const first = a.service.createCode('local').code;
  let second = a.service.createCode('local').code;
  while (second === first) second = a.service.createCode('local').code;
  refused(() => a.service.acceptJoin(joinBody({ code: first })), 'INVALID_CODE');
  assert.ok(a.service.acceptJoin(joinBody({ code: second })).link_id);
});

test('five wrong codes end the active code, even for the right code afterwards, and a new code starts again', t => {
  const a = fixture(t, INSTANCE_A);
  const { code } = a.service.createCode('local');
  const wrong = wrongCode(code);
  for (let index = 0; index < 4; index += 1) refused(() => a.service.acceptJoin(joinBody({ code: wrong })), 'INVALID_CODE');
  // Four are not enough: the right code still works up to the cap.
  const probe = a.service.acceptJoin(joinBody({ code }));
  assert.ok(probe.link_id);

  const next = a.service.createCode('local').code;
  const nextWrong = wrongCode(next);
  for (let index = 0; index < 5; index += 1) refused(() => a.service.acceptJoin(joinBody({ code: nextWrong, instance_id: INSTANCE_A.replace(/1/g, '4') })), 'INVALID_CODE');
  refused(() => a.service.acceptJoin(joinBody({ code: next, instance_id: INSTANCE_A.replace(/1/g, '4') })), 'INVALID_CODE');
  assert.equal(count(a.db, 'remote_servers'), 1, 'nothing was created after the cap');

  const fresh = a.service.createCode('local').code;
  assert.ok(a.service.acceptJoin(joinBody({ code: fresh, instance_id: INSTANCE_A.replace(/1/g, '4') })).link_id);
});

test('a malformed code is refused and does not count as a failure', t => {
  const a = fixture(t, INSTANCE_A);
  const { code } = a.service.createCode('local');
  const malformed = ['', '12345', '1234567', 'abcdef', '12 456', 123456, null, undefined, 'TA-AAAA-BBBB-CCCC', { $gt: '' }];
  for (let round = 0; round < 3; round += 1) {
    for (const value of malformed) refused(() => a.service.acceptJoin(joinBody({ code: value })), 'INVALID_CODE');
  }
  assert.ok(a.service.acceptJoin(joinBody({ code })).link_id, 'the code survived thirty malformed attempts');
});

test('a bad instance id or token is refused without counting against the code', t => {
  const a = fixture(t, INSTANCE_A);
  const { code } = a.service.createCode('local');
  const wrong = wrongCode(code);
  for (let index = 0; index < 8; index += 1) {
    refused(() => a.service.acceptJoin(joinBody({ code: wrong, instance_id: 'nope' })), 'INVALID_REQUEST');
    refused(() => a.service.acceptJoin(joinBody({ code: wrong, access_token: 'plain' })), 'INVALID_REQUEST');
  }
  assert.ok(a.service.acceptJoin(joinBody({ code })).link_id);
});

test('self-link and already-linked do not burn the code or leave a token', t => {
  const a = fixture(t, INSTANCE_A);
  const { code } = a.service.createCode('local');
  refused(() => a.service.acceptJoin(joinBody({ code, instance_id: INSTANCE_A })), 'SELF_LINK');
  assert.equal(count(a.db, 'engine_access_tokens'), 0);
  assert.equal(count(a.db, 'remote_servers'), 0);
  assert.ok(a.service.acceptJoin(joinBody({ code })).link_id, 'the same code still works after SELF_LINK');

  const again = a.service.createCode('local').code;
  refused(() => a.service.acceptJoin(joinBody({ code: again })), 'ALREADY_LINKED');
  assert.equal(activeTokens(a.db).length, 1);
  assert.equal(count(a.db, 'remote_servers'), 1);
  assert.ok(a.service.acceptJoin(joinBody({ code: again, instance_id: INSTANCE_A.replace(/1/g, '5') })).link_id, 'and after ALREADY_LINKED');
});

test('a wrong code gets INVALID_CODE even from a self-link attempt, so it cannot probe this service', t => {
  const a = fixture(t, INSTANCE_A);
  const { code } = a.service.createCode('local');
  refused(() => a.service.acceptJoin(joinBody({ code: wrongCode(code), instance_id: INSTANCE_A })), 'INVALID_CODE');
});

test('join needs confirm: true', async t => {
  const { a, b, calls } = linkedPair(t);
  const { code } = a.service.createCode('local');
  await refusedAsync(browserJoin(b, code, { confirm: undefined }), 'CONFIRM_REQUIRED');
  await refusedAsync(browserJoin(b, code, { confirm: 'true' }), 'CONFIRM_REQUIRED');
  assert.equal(calls.length, 0, 'no request left this service');
});

test('a successful join stores the peer, keeps secrets out of the public object and starts the tunnel', async t => {
  const { a, b } = linkedPair(t);
  const { code } = a.service.createCode('local');
  const link = await browserJoin(b, code);
  assert.deepEqual(Object.keys(link).sort(), ['created_at', 'id', 'last_seen_at', 'name', 'online', 'peer_url', 'remote_server_id', 'role', 'state']);
  assert.equal(link.role, 'joiner');
  assert.equal(link.peer_url, 'http://a.example.test:3000');
  assert.equal(link.name, 'service-a');
  assert.equal(link.state, 'offline');
  assert.equal(b.db.prepare('SELECT base_url FROM remote_servers').get().base_url, 'http://a.example.test:3000');
  assert.equal(b.tunnel.clients.length, 1);
  assert.equal(b.tunnel.clients[0].url, 'http://a.example.test:3000');
  assert.equal(b.tunnel.clients[0].localPort, 4100);
  assert.match(b.tunnel.clients[0].token, /^tsl_/);
  const stored = b.db.prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY).value;
  assert.equal(stored.includes(b.tunnel.clients[0].token), false, 'the tunnel token is encrypted at rest');
  for (const side of [a, b]) assert.doesNotMatch(JSON.stringify(side.service.list('local')), /tae_|tsl_|token/i);
});

test('any failed join leaves nothing on the joiner', async t => {
  const empty = b => {
    assert.equal(count(b.db, 'engine_access_tokens'), 0, 'no local token, not even a revoked one');
    assert.equal(count(b.db, 'remote_servers'), 0);
    assert.deepEqual(b.service.list('local'), []);
  };
  for (const [route, error, expected] of [
    ['/v1/health', new Error('ECONNREFUSED'), 'LINK_UNREACHABLE'],
    ['/v1/service-links/join', HTTP_ERROR('INVALID_CODE', 400), 'INVALID_CODE'],
    ['/v1/service-links/join', HTTP_ERROR('SELF_LINK', 409), 'SELF_LINK'],
    ['/v1/service-links/join', HTTP_ERROR('ALREADY_LINKED', 409), 'ALREADY_LINKED'],
    ['/v1/service-links/join', HTTP_ERROR('REMOTE_HTTP_404', 404), 'LINK_UNSUPPORTED'],
    ['/v1/service-links/join', new Error('REMOTE_TIMEOUT'), 'LINK_UNREACHABLE'],
  ]) {
    const { a, b, failNext } = linkedPair(t);
    const { code } = a.service.createCode('local');
    failNext.route = route;
    failNext.error = error;
    await refusedAsync(browserJoin(b, code), expected);
    empty(b);
  }
});

test('an older peer, whose health answer has no capability, gets LINK_UNSUPPORTED', async t => {
  const b = fixture(t, INSTANCE_B, { request: async () => ({ ok: true }) });
  await refusedAsync(browserJoin(b, '123456'), 'LINK_UNSUPPORTED');
  assert.equal(count(b.db, 'engine_access_tokens'), 0);
});

test('a failure after the peer accepted asks the peer to let go and leaves nothing', async t => {
  const { a, b, calls } = linkedPair(t);
  b.tunnel.startTunnelClient = () => { throw new Error('boom'); };
  const { code } = a.service.createCode('local');
  await refusedAsync(browserJoin(b, code), 'LINK_JOIN_FAILED');
  assert.equal(count(b.db, 'engine_access_tokens'), 0);
  assert.equal(count(b.db, 'remote_servers'), 0);
  assert.deepEqual(b.service.list('local'), []);
  assert.ok(calls.some(call => /^\/v1\/service-links\/.+\/unlink$/.test(call.route)), 'the peer was told');
});

test('an address already saved as a plain Engine is refused before the code is spent', async t => {
  const { a, b } = linkedPair(t);
  b.db.prepare("INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES ('local', 'x', 'http://a.example.test:3000', 'c')").run();
  const { code } = a.service.createCode('local');
  await refusedAsync(browserJoin(b, code), 'REMOTE_ALREADY_EXISTS');
  assert.equal(count(b.db, 'engine_access_tokens'), 0);
  assert.ok(a.service.acceptJoin(joinBody({ code })).link_id, 'the code was not spent');
});

test('the tunnel token authenticates only its own live link', async t => {
  const a = fixture(t, INSTANCE_A);
  const { code } = a.service.createCode('local');
  const answer = a.service.acceptJoin(joinBody({ code }));
  assert.equal(a.service.authenticateTunnel(`Bearer ${answer.tunnel_token}`), answer.link_id);
  assert.equal(a.service.authenticateTunnel('Bearer tsl_wrong'), null);
  assert.equal(a.service.authenticateTunnel(`Bearer ${answer.access_token}`), null, 'the Engine token is not a tunnel token');
  assert.equal(a.service.authenticateTunnel(undefined), null);
  await a.service.unlink(answer.link_id);
  assert.equal(a.service.authenticateTunnel(`Bearer ${answer.tunnel_token}`), null, 'gone with the link');
});

test('tunnel state moves the Engine row: online, version refresh, offline, and no stale online after a restart', async t => {
  const { a, b } = linkedPair(t);
  const { code } = a.service.createCode('local');
  const link = await browserJoin(b, code);
  const client = b.tunnel.clients[0];
  const row = () => b.db.prepare('SELECT * FROM remote_servers').get();

  client.onState({ online: true });
  assert.equal(b.service.list('local')[0].state, 'online');
  assert.equal(row().status, 'online');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(row().remote_version, '9.9.9');
  assert.ok(b.service.list('local')[0].last_seen_at);

  client.onState({ online: false });
  assert.equal(b.service.list('local')[0].state, 'offline');
  assert.equal(row().status, 'offline');
  assert.equal(row().last_error, 'LINK_OFFLINE');

  client.onState({ online: true });
  assert.equal(row().status, 'online');
  assert.equal(row().last_error, null);

  // The next process over the same database.
  const restarted = fixture(t, INSTANCE_B, { database: b.db });
  assert.equal(restarted.service.list('local')[0].id, link.id, 'the link survives');
  assert.equal(row().status, 'offline', 'the row does not keep the online of the previous run');
  assert.equal(restarted.tunnel.clients.length, 1, 'the joiner starts its tunnel again');
});

test('the initiator follows the hub', async t => {
  const a = fixture(t, INSTANCE_A);
  const { code } = a.service.createCode('local');
  const { link_id: id } = a.service.acceptJoin(joinBody({ code }));
  a.tunnel.emit(id, true);
  assert.equal(a.db.prepare('SELECT status FROM remote_servers').get().status, 'online');
  assert.equal(a.service.list('local')[0].online, true);
  a.tunnel.emit(id, false);
  assert.equal(a.db.prepare('SELECT status FROM remote_servers').get().status, 'offline');

  const restarted = fixture(t, INSTANCE_A, { database: a.db });
  assert.equal(restarted.service.list('local')[0].role, 'initiator');
  assert.equal(restarted.tunnel.clients.length, 0, 'the initiator opens no tunnel');
});

test('with no links nothing starts', t => {
  const b = fixture(t, INSTANCE_B);
  assert.equal(b.tunnel.clients.length, 0);
  assert.equal(count(b.db, 'system_state'), 0, 'not even an empty state row');
});

test('unlink from the joiner tells the initiator, then cleans the token, the row and the record on both sides', async t => {
  const { a, b, calls } = linkedPair(t);
  const { code } = a.service.createCode('local');
  const link = await browserJoin(b, code);
  const tokenOnA = activeTokens(a.db)[0];
  // The initiator's handler for the notice the joiner sends.
  a.service.peerUnlink(link.id, tokenOnA.id);
  assert.equal(activeTokens(a.db).length, 0);
  assert.equal(count(a.db, 'remote_servers'), 0);
  assert.deepEqual(a.service.list('local'), []);
  assert.deepEqual(a.tunnel.dropped, [[link.id, 'LINK_REVOKED']]);

  await b.service.unlink(link.id);
  assert.ok(calls.some(call => call.route === `/v1/service-links/${link.id}/unlink` && call.options.timeoutMs <= 5000), 'told directly, with a short limit');
  assert.equal(activeTokens(b.db).length, 0);
  assert.equal(count(b.db, 'remote_servers'), 0);
  assert.deepEqual(b.service.list('local'), []);
  assert.equal(b.tunnel.clients[0].stopped, true);
});

test('unlink still cleans locally when the peer cannot be told', async t => {
  const { a, b, failNext } = linkedPair(t);
  const { code } = a.service.createCode('local');
  const link = await browserJoin(b, code);
  failNext.route = `/v1/service-links/${link.id}/unlink`;
  failNext.error = new Error('ECONNREFUSED');
  await b.service.unlink(link.id);
  assert.equal(activeTokens(b.db).length, 0);
  assert.equal(count(b.db, 'remote_servers'), 0);
});

test('the initiator notifies through the notice path only while the tunnel is up', async t => {
  const calls = [];
  const a = fixture(t, INSTANCE_A, { request: async (base, route) => { calls.push({ base, route }); return ''; } });
  const { code } = a.service.createCode('local');
  const first = a.service.acceptJoin(joinBody({ code }));
  a.tunnel.emit(first.link_id, true);
  await new Promise(resolve => setImmediate(resolve));
  calls.length = 0;
  await a.service.unlink(first.link_id);
  assert.deepEqual(calls.map(call => call.route), [`/v1/service-link-notice/${first.link_id}/unlink`]);
  assert.equal(calls[0].base, a.tunnel.tunnelBase(first.link_id));

  const second = a.service.acceptJoin(joinBody({ code: a.service.createCode('local').code }));
  calls.length = 0;
  await a.service.unlink(second.link_id);
  assert.deepEqual(calls, [], 'offline: nobody to tell');
  assert.equal(activeTokens(a.db).length, 0);
});

test('the peer notice is accepted only from the token issued for that link', async t => {
  const a = fixture(t, INSTANCE_A);
  const { code } = a.service.createCode('local');
  const { link_id: id } = a.service.acceptJoin(joinBody({ code }));
  const other = createAccessToken(a.db, { name: 'someone else', principalId: 'local' });
  refused(() => a.service.peerUnlink(id, other.id), 'LINK_NOT_FOUND');
  refused(() => a.service.peerUnlink('no-such-link', activeTokens(a.db)[0].id), 'LINK_NOT_FOUND');
  assert.equal(a.service.list('local').length, 1);
});

test('a revoked peer shows revoked, stops retrying, loses its token here and can be removed', async t => {
  const { a, b, calls } = linkedPair(t);
  const { code } = a.service.createCode('local');
  const link = await browserJoin(b, code);
  const client = b.tunnel.clients[0];
  client.onState({ online: false, error: 'LINK_REVOKED' });

  const listed = b.service.list('local')[0];
  assert.equal(listed.state, 'revoked');
  assert.equal(listed.online, false);
  assert.equal(client.stopped, true, 'no more retries');
  assert.equal(activeTokens(b.db).length, 0, 'the token issued to the peer ended too');
  const row = b.db.prepare('SELECT * FROM remote_servers').get();
  assert.equal(row.status, 'unauthorized');
  assert.equal(row.last_error, 'LINK_REVOKED');

  // A later tunnel event cannot bring it back.
  client.onState({ online: true });
  assert.equal(b.service.list('local')[0].state, 'revoked');

  calls.length = 0;
  await b.service.unlink(link.id);
  assert.deepEqual(calls, [], 'a revoked peer is not called');
  assert.equal(count(b.db, 'remote_servers'), 0);
  assert.deepEqual(b.service.list('local'), []);

  // A restart does not start the tunnel of a revoked link either.
  const c = linkedPair(t);
  const again = await browserJoin(c.b, c.a.service.createCode('local').code);
  c.b.service.markRevoked(again.id);
  const restarted = fixture(t, INSTANCE_B, { database: c.b.db });
  assert.equal(restarted.tunnel.clients.length, 0);
  assert.equal(restarted.service.list('local')[0].state, 'revoked');
});

test('a 401 seen by the Engines check marks the link revoked', async t => {
  const { a, b } = linkedPair(t);
  const link = await browserJoin(b, a.service.createCode('local').code);
  b.service.noteUnauthorized(link.remote_server_id);
  assert.equal(b.service.list('local')[0].state, 'revoked');
  b.service.noteUnauthorized(99999);
});

test('a token issued for a link is recognisable in token lists', async t => {
  const { a, b } = linkedPair(t);
  const link = await browserJoin(b, a.service.createCode('local').code);
  const rows = b.db.prepare('SELECT id, name FROM engine_access_tokens').all();
  const marked = b.service.markTokens([...rows, { id: 777, name: 'plain' }]);
  assert.equal(marked[0].service_link_id, link.id);
  assert.match(marked[0].name, /^Service link: service-a$/);
  assert.equal(marked[1].service_link_id, null);
  assert.equal(b.service.linkForToken(rows[0].id).id, link.id);
  assert.equal(b.service.linkForServer(link.remote_server_id).id, link.id);
});

// ---- Two real services ----
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };

async function startService(t, { dir, secret = SECRET } = {}) {
  const temp = dir || fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-service-link-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', SESSION_SECRET: secret, T_AGENT_DATA_DIR: temp, T_AGENT_DB_PATH: path.join(temp, 'db.sqlite'), TASKS_BASE_DIR: path.join(temp, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false', ACCESS_MODE: 'local' },
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
  const service = {
    port, temp, stop, url: `http://127.0.0.1:${port}`,
    async call(method, route, body, headers = HEADERS) {
      const response = await fetch(`${service.url}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      return { status: response.status, body: parsed, text };
    },
    database() {
      const database = new Database(path.join(temp, 'db.sqlite'), { readonly: true });
      t.after(() => database.close());
      return database;
    },
  };
  t.after(async () => {
    await stop();
    if (!dir) fs.rmSync(temp, { recursive: true, force: true });
  });
  return service;
}

async function until(check, label) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

async function linkServices(a, b) {
  const made = await a.call('POST', '/api/service-links/code', {});
  assert.equal(made.status, 201);
  const joined = await b.call('POST', '/api/service-links/join', { url: a.url, code: made.body.code, confirm: true });
  assert.equal(joined.status, 201, joined.text);
  const linkOf = async side => (await side.call('GET', '/api/service-links')).body.links.find(link => link.id === joined.body.id);
  await until(async () => (await linkOf(a))?.online && (await linkOf(b))?.online, 'both sides online');
  return { id: joined.body.id, linkOf };
}

const tunnelStatus = (url, token) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`${url.replace('http', 'ws')}/v1/service-links/tunnel`, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
  socket.on('unexpected-response', (request, response) => { resolve(response.statusCode); request.destroy(); });
  socket.on('open', () => { socket.terminate(); resolve(101); });
  socket.on('error', reject);
});

test('two real services: join, list, gates, restart, and removal through the Engines route', async t => {
  const a = await startService(t);
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-service-link-'));
  t.after(() => fs.rmSync(dirB, { recursive: true, force: true }));
  let b = await startService(t, { dir: dirB });

  assert.deepEqual((await a.call('GET', '/api/service-links')).body, { links: [], supported: true });
  assert.ok((await a.call('GET', '/v1/health')).body.capabilities.includes('service-links'));

  const made = await a.call('POST', '/api/service-links/code', {});
  assert.equal(made.status, 201);
  assert.deepEqual(Object.keys(made.body).sort(), ['code', 'expires_in_seconds']);
  assert.match(made.body.code, /^\d{6}$/);

  assert.deepEqual((await b.call('POST', '/api/service-links/join', { url: a.url, code: made.body.code })).body, { error: 'CONFIRM_REQUIRED' });
  // The linking code is not an Engine pairing code.
  const pair = await a.call('POST', '/v1/pair', { code: made.body.code });
  assert.equal(pair.status, 400);
  assert.equal(pair.body.error, 'PAIRING_CODE_INVALID');
  // And an Engine pairing code is not a linking code.
  const plain = await a.call('POST', '/api/remote-tokens/pairing', {});
  assert.equal((await a.call('POST', '/v1/service-links/join', { code: plain.body.code, instance_id: INSTANCE_B, access_token: PEER_TOKEN })).body.error, 'INVALID_CODE');
  assert.equal((await b.call('POST', '/api/service-links/join', { url: a.url, code: plain.body.code, confirm: true })).body.error, 'INVALID_CODE');

  // The browser gates of the neighbouring routes.
  assert.equal((await a.call('POST', '/api/service-links/code', {}, { 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await a.call('GET', '/api/service-links', undefined, { Origin: 'http://evil.example.test' })).status, 403);

  const joined = await b.call('POST', '/api/service-links/join', { url: a.url, code: made.body.code, confirm: true });
  assert.equal(joined.status, 201, joined.text);
  const id = joined.body.id;
  const linkOf = async side => (await side.call('GET', '/api/service-links')).body.links.find(link => link.id === id);
  await until(async () => (await linkOf(a))?.online && (await linkOf(b))?.online, 'both sides online');

  const onA = await linkOf(a);
  const onB = await linkOf(b);
  assert.equal(onA.role, 'initiator');
  assert.equal(onA.peer_url, null);
  assert.equal(onB.role, 'joiner');
  assert.equal(onB.peer_url, a.url);
  for (const side of [a, b]) {
    for (const route of ['/api/service-links', '/api/remote-servers', '/api/remote-tokens']) {
      assert.doesNotMatch((await side.call('GET', route)).text, /tae_[A-Za-z0-9_-]{20}|tsl_/, `${route} shows no secret`);
    }
  }

  // Joining the same service again is refused on this side, before any request.
  assert.equal((await b.call('POST', '/api/service-links/join', { url: a.url, code: made.body.code, confirm: true })).body.error, 'ALREADY_LINKED');
  const servers = (await a.call('GET', '/api/remote-servers')).body;
  assert.equal(servers.length, 1);
  assert.equal(servers[0].status, 'online');

  const tokens = (await a.call('GET', '/api/remote-tokens')).body;
  const issued = tokens.find(token => token.service_link_id === id);
  assert.ok(issued);
  assert.match(issued.name, /^Service link: /);

  // Tunnel authentication.
  assert.equal(await tunnelStatus(a.url, 'tsl_wrong'), 401);
  assert.equal(await tunnelStatus(a.url, null), 401);
  assert.equal((await a.call('GET', '/v1/info', undefined, { Authorization: 'Bearer tsl_anything' })).status, 401, 'a tunnel token has no Engine authority');

  // A linked row's address cannot be edited.
  const rowOnB = onB.remote_server_id;
  assert.deepEqual((await b.call('PUT', `/api/remote-servers/${rowOnB}`, { url: 'http://127.0.0.1:1', name: 'x' })).body, { error: 'LINK_MANAGED' });
  assert.deepEqual((await b.call('POST', `/api/remote-servers/${rowOnB}/test`, { url: 'http://127.0.0.1:1' })).body, { error: 'LINK_MANAGED' });

  // A restart keeps the link and brings the tunnel back.
  await b.stop();
  await until(async () => !(await linkOf(a)).online, 'A saw B go away');
  assert.equal((await a.call('GET', '/api/remote-servers')).body[0].status, 'offline');
  b = await startService(t, { dir: dirB });
  await until(async () => (await linkOf(a)).online && (await linkOf(b))?.online, 'online again after the restart');
  assert.equal((await a.call('GET', '/api/remote-servers')).body[0].status, 'online');

  // Removal through the Engines list is an unlink on both sides.
  const removed = await b.call('DELETE', `/api/remote-servers/${rowOnB}`);
  assert.equal(removed.status, 200);
  assert.deepEqual((await b.call('GET', '/api/service-links')).body.links, []);
  assert.deepEqual((await b.call('GET', '/api/remote-servers')).body, []);
  await until(async () => (await a.call('GET', '/api/service-links')).body.links.length === 0, 'A heard the unlink');
  assert.deepEqual((await a.call('GET', '/api/remote-servers')).body, []);
  assert.equal(a.database().prepare('SELECT COUNT(*) n FROM engine_access_tokens WHERE revoked_at IS NULL AND name LIKE ?').get('Service link:%').n, 0);
  assert.equal(b.database().prepare('SELECT COUNT(*) n FROM engine_access_tokens WHERE revoked_at IS NULL AND name LIKE ?').get('Service link:%').n, 0);
  // Linking again works once both sides are clean.
  assert.equal((await linkServices(a, b)).id.length, 36);
});

test('two real services: the initiator unlinks, and revoking a link token is an unlink', async t => {
  const a = await startService(t);
  const b = await startService(t);
  const first = await linkServices(a, b);

  const deleted = await a.call('DELETE', `/api/service-links/${first.id}`);
  assert.equal(deleted.status, 204);
  assert.deepEqual((await a.call('GET', '/api/service-links')).body.links, []);
  assert.deepEqual((await a.call('GET', '/api/remote-servers')).body, []);
  // Through the real tunnel the notice removes B's side; without it B learns from the tunnel token failing. Either way B stops.
  const peer = await until(async () => {
    const link = await first.linkOf(b);
    return !link || link.state === 'revoked' ? { link } : null;
  }, 'B learned');
  if (peer.link) {
    assert.equal((await b.call('GET', '/api/remote-servers')).body[0].status, 'unauthorized');
    assert.equal((await b.call('DELETE', `/api/service-links/${first.id}`)).status, 204);
  }
  assert.deepEqual((await b.call('GET', '/api/service-links')).body.links, []);
  assert.deepEqual((await b.call('GET', '/api/remote-servers')).body, []);
  assert.equal((await a.call('DELETE', `/api/service-links/${first.id}`)).status, 404);

  // Revoking the token in A's list, then the same result.
  const second = await linkServices(a, b);
  const issued = (await a.call('GET', '/api/remote-tokens')).body.find(token => token.service_link_id === second.id);
  assert.equal((await a.call('DELETE', `/api/remote-tokens/${issued.id}`)).status, 200);
  assert.deepEqual((await a.call('GET', '/api/service-links')).body.links, []);
  assert.deepEqual((await a.call('GET', '/api/remote-servers')).body, []);
  await until(async () => { const link = await second.linkOf(b); return !link || link.state === 'revoked'; }, 'B learned of the revoked token');
  const leftover = await second.linkOf(b);
  if (leftover) assert.equal((await b.call('DELETE', `/api/service-links/${second.id}`)).status, 204);

  // The same through the Engine API, with a token of the owner.
  const third = await linkServices(a, b);
  const admin = (await a.call('POST', '/api/remote-tokens', { name: 'admin' })).body.token;
  const bearer = { ...HEADERS, Authorization: `Bearer ${admin}` };
  const listed = (await a.call('GET', '/v1/tokens', undefined, bearer)).body;
  const engineIssued = listed.find(token => token.service_link_id === third.id);
  assert.match(engineIssued.name, /^Service link: /);
  assert.equal(listed.find(token => token.name === 'admin').service_link_id, null);
  assert.equal((await a.call('DELETE', `/v1/tokens/${engineIssued.id}`, undefined, bearer)).status, 200);
  assert.deepEqual((await a.call('GET', '/api/service-links')).body.links, []);
});

test('the join route shares the pairing rate limit', async t => {
  const a = await startService(t);
  const statuses = [];
  for (let index = 0; index < 11; index += 1) statuses.push((await a.call('POST', '/v1/service-links/join', { code: 'nope' })).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(400));
  assert.equal(statuses[10], 429);
  assert.equal((await a.call('POST', '/v1/service-links/join', { code: 'nope' })).body.error, 'PAIRING_RATE_LIMITED');
  assert.equal((await a.call('POST', '/v1/pair', { code: 'nope' })).status, 429, 'one counter with /v1/pair');
});
