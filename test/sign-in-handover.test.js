// One login for linked engines (services/sign-in-handover.js): issue on A, redeem on B, and every refusal (replay, expiry, wrong target, revoked
// link, tampered token, wrong nonce, the switch off, a login without an authenticator code). See "One login for linked engines" in
// docs/design/failover-and-one-login.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-sign-in-handover-'));
const Database = require('better-sqlite3');
const { createSignInHandover, handoverKey, nonceHash, cleanAddresses, CAPABILITY } = require('../services/sign-in-handover');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const LINK = '11111111-2222-4333-8444-555555555555';
const T_A = 'tae_issued_by_A_to_B_aaaaaaaaaaaa'; // A issued it, B holds it
const T_B = 'tae_issued_by_B_to_A_bbbbbbbbbbbb'; // B issued it, A holds it
const T0 = Date.parse('2026-11-20T10:00:00.000Z');

function database(issuedHash) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE engine_access_tokens (id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL, revoked_at TEXT)`);
  db.prepare('INSERT INTO engine_access_tokens (id, token_hash) VALUES (1, ?)').run(issuedHash);
  return db;
}

// One engine of a pair. `peer`: what its link knows of the other one.
function engine({ me, peerName, peerInstance, peerToken, issuedToken, role = 'initiator', clock, mode = 'remote', bound = true, request = null }) {
  const db = database(sha(issuedToken));
  const state = { online: true, revoked: false, peers: true };
  const logs = [];
  const link = () => ({ id: LINK, role, owner_id: 'owner', peer_instance_id: peerInstance, issued_token_id: 1, revoked: state.revoked, peer_url: role === 'joiner' ? 'http://peer.lan:3000' : null });
  const serviceLinks = {
    peers: () => (state.revoked || !state.peers ? [] : [{ id: LINK, name: peerName, online: state.online, remoteServerId: 7, instanceId: peerInstance, baseUrl: 'http://peer', token: peerToken }]),
    linkForServer: id => (id === 7 ? link() : null),
    noteUnauthorized() {},
  };
  const auth = { mode, bound };
  const service = createSignInHandover({
    db, serviceLinks, request: (...args) => request(...args),
    identity: () => ({ instance_id: me, name: me.toUpperCase() }),
    clientAuth: {
      accessMode: () => auth.mode,
      authenticated: session => Boolean(session && session.ok),
      status: () => ({ bound: auth.bound }),
    },
    owner: () => 'owner',
    ownAddresses: () => [{ kind: 'local', url: 'http://127.0.0.1:3000' }, { kind: 'lan', url: `http://${me}.lan:3000` }, { kind: 'remote', url: `https://${me}.example.com` }],
    now: () => clock.now,
    log: { log: line => logs.push(line), warn: line => logs.push(line), error: line => logs.push(line) },
  });
  return { db, state, auth, service, logs };
}

// A (initiator) and B (joiner) joined by one link; A's calls reach B's /v1 answers directly.
function pair({ capability = true } = {}) {
  const clock = { now: T0 };
  const calls = [];
  const a = engine({ me: 'inst-a', peerName: 'B', peerInstance: 'inst-b', peerToken: T_B, issuedToken: T_A, clock, request: async (base, route, token) => {
    calls.push(route);
    assert.equal(token, T_B);
    if (route === '/v1/info') return { capabilities: capability ? [CAPABILITY] : [] };
    if (route === '/v1/sign-in-handover') return b.service.describeForPeer();
    throw Object.assign(new Error('NOT_FOUND'), { statusCode: 404 });
  } });
  const b = engine({ me: 'inst-b', peerName: 'A', peerInstance: 'inst-a', peerToken: T_A, issuedToken: T_B, role: 'joiner', clock, request: async () => ({}) });
  return { a, b, clock, calls };
}

const NONCE = 'n'.repeat(43);
const session = { ok: true };
const issue = (a, extra = {}) => a.service.issue({ ownerId: 'owner', session, target: 'inst-b', nonceHash: nonceHash(NONCE), ...extra });
const refusal = code => error => { assert.equal(error.message, code); return true; };

test('a hand-over issued on A signs B in once; the second use is refused', async () => {
  const { a, b, calls } = pair();
  const handed = await issue(a);
  assert.deepEqual(calls, ['/v1/info', '/v1/sign-in-handover']);
  assert.equal(handed.name, 'B');
  assert.equal(handed.expires_in, 60);
  assert.deepEqual(handed.addresses, ['http://inst-b.lan:3000', 'https://inst-b.example.com']); // B's loopback address is never offered
  const accepted = b.service.redeem({ token: handed.token, nonce: NONCE, ip: '10.0.0.5' });
  assert.deepEqual(accepted, { from: { name: 'A', instance_id: 'inst-a' } });
  assert.throws(() => b.service.redeem({ token: handed.token, nonce: NONCE, ip: '10.0.0.5' }), refusal('HANDOVER_USED'));
  // Nothing in the logs of either side holds the token or the nonce.
  for (const line of [...a.logs, ...b.logs]) {
    assert.ok(!line.includes(handed.token) && !line.includes(handed.token.split('.')[1]) && !line.includes(NONCE), line);
  }
  assert.ok(a.logs.some(line => /hand-over to B issued/.test(line)));
  assert.ok(b.logs.some(line => /from A accepted/.test(line)));
  assert.ok(b.logs.some(line => /refused: HANDOVER_USED/.test(line)));
});

test('a used hand-over stays used after a restart (the ids are stored, not held in memory)', async () => {
  const { a, b } = pair();
  const handed = await issue(a);
  b.service.redeem({ token: handed.token, nonce: NONCE });
  const used = JSON.parse(b.db.prepare("SELECT value FROM system_state WHERE key = 'sign_in_handover_used_v1'").get().value);
  assert.equal(Object.keys(used).length, 1);
});

test('expiry: 60 s after it was made the hand-over is refused', async () => {
  const { a, b, clock } = pair();
  const handed = await issue(a);
  clock.now = T0 + 60_000;
  assert.throws(() => b.service.redeem({ token: handed.token, nonce: NONCE }), refusal('HANDOVER_EXPIRED'));
  clock.now = T0 + 59_000;
  assert.doesNotThrow(() => b.service.redeem({ token: handed.token, nonce: NONCE }));
});

test('wrong target: a hand-over made for B is refused by another engine with the same link keys', async () => {
  const { a, clock } = pair();
  const handed = await issue(a);
  const other = engine({ me: 'inst-c', peerName: 'A', peerInstance: 'inst-a', peerToken: T_A, issuedToken: T_B, role: 'joiner', clock, request: async () => ({}) });
  assert.throws(() => other.service.redeem({ token: handed.token, nonce: NONCE }), refusal('HANDOVER_WRONG_TARGET'));
  // A itself holds the same key, but the token names A as its issuer, not as the peer of the link.
  assert.throws(() => a.service.redeem({ token: handed.token, nonce: NONCE }), refusal('HANDOVER_INVALID'));
});

test('revoked link: refused when the link is revoked or gone, or the token B issued for it was revoked', async () => {
  const { a, b } = pair();
  const first = await issue(a);
  b.state.revoked = true;
  assert.throws(() => b.service.redeem({ token: first.token, nonce: NONCE }), refusal('HANDOVER_LINK_REVOKED'));
  b.state.revoked = false;
  b.db.prepare("UPDATE engine_access_tokens SET revoked_at = '2026-11-20' WHERE id = 1").run();
  assert.throws(() => b.service.redeem({ token: first.token, nonce: NONCE }), refusal('HANDOVER_LINK_REVOKED'));
  // And A makes none for a link it no longer has.
  a.state.peers = false;
  await assert.rejects(issue(a), refusal('HANDOVER_NOT_LINKED'));
});

test('tampered: a changed payload, a changed signature, a wrong nonce or a token signed with another key is refused', async () => {
  const { a, b } = pair();
  const handed = await issue(a);
  const [body, mac] = handed.token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  const forged = Buffer.from(JSON.stringify({ ...payload, exp: payload.exp + 3_600_000 })).toString('base64url');
  assert.throws(() => b.service.redeem({ token: `${forged}.${mac}`, nonce: NONCE }), refusal('HANDOVER_INVALID'));
  const flipped = mac.slice(0, -2) + (mac.endsWith('AA') ? 'BB' : 'AA');
  assert.throws(() => b.service.redeem({ token: `${body}.${flipped}`, nonce: NONCE }), refusal('HANDOVER_INVALID'));
  assert.throws(() => b.service.redeem({ token: handed.token, nonce: 'm'.repeat(43) }), refusal('HANDOVER_INVALID'));
  assert.throws(() => b.service.redeem({ token: 'not-a-token', nonce: NONCE }), refusal('HANDOVER_INVALID'));
  assert.throws(() => b.service.redeem({ token: handed.token }), refusal('HANDOVER_INVALID'));
  const wrongKey = handoverKey(LINK, ['x', 'y']);
  const otherMac = crypto.createHmac('sha256', wrongKey).update(`v1.${body}`).digest('base64url');
  assert.throws(() => b.service.redeem({ token: `${body}.${otherMac}`, nonce: NONCE }), refusal('HANDOVER_INVALID'));
  // None of them used the real one up.
  assert.doesNotThrow(() => b.service.redeem({ token: handed.token, nonce: NONCE }));
});

test('switch off: B refuses to redeem, and A does not issue one for B', async () => {
  const { a, b } = pair();
  const handed = await issue(a);
  b.service.setAccepting(false);
  assert.equal(b.service.accepting(), false);
  assert.throws(() => b.service.redeem({ token: handed.token, nonce: NONCE }), refusal('HANDOVER_OFF'));
  await assert.rejects(issue(a), refusal('HANDOVER_OFF_THERE'));
  b.service.setAccepting(true);
  assert.equal(b.db.prepare("SELECT 1 FROM system_state WHERE key = 'sign_in_handover_v1'").get(), undefined); // on is no row
  assert.throws(() => b.service.setAccepting('yes'), refusal('VALIDATION_FAILED'));
});

test('B\'s stricter rule: a local-only login of A is not handed over, and B in local mode accepts none', async () => {
  const { a, b, clock } = pair();
  a.auth.mode = 'local';
  await assert.rejects(issue(a), refusal('HANDOVER_CODE_REQUIRED'));
  // A token that claims a local login, signed with the right key, is refused by B too.
  const key = handoverKey(LINK, [sha(T_A), sha(T_B)]);
  const body = Buffer.from(JSON.stringify({ v: 1, iss: 'inst-a', aud: 'inst-b', lnk: LINK, jti: 'j1', iat: clock.now, exp: clock.now + 60_000, lvl: 'local', nh: nonceHash(NONCE) })).toString('base64url');
  const token = `${body}.${crypto.createHmac('sha256', key).update(`v1.${body}`).digest('base64url')}`;
  assert.throws(() => b.service.redeem({ token, nonce: NONCE }), refusal('HANDOVER_CODE_REQUIRED'));
  a.auth.mode = 'remote';
  const handed = await issue(a);
  b.auth.mode = 'local';
  assert.throws(() => b.service.redeem({ token: handed.token, nonce: NONCE }), refusal('HANDOVER_NOT_AVAILABLE'));
  b.auth.mode = 'remote';
  b.auth.bound = false;
  assert.throws(() => b.service.redeem({ token: handed.token, nonce: NONCE }), refusal('HANDOVER_NOT_AVAILABLE'));
});

test('issue: only for a logged-in session, a well-formed nonce hash, an online linked engine that has the capability', async () => {
  const { a } = pair();
  await assert.rejects(a.service.issue({ ownerId: 'owner', session: {}, target: 'inst-b', nonceHash: nonceHash(NONCE) }), refusal('AUTH_REQUIRED'));
  await assert.rejects(issue(a, { nonceHash: 'short' }), refusal('VALIDATION_FAILED'));
  await assert.rejects(issue(a, { target: 'inst-x' }), refusal('HANDOVER_NOT_LINKED'));
  await assert.rejects(issue(a, { ownerId: 'someone-else' }), refusal('HANDOVER_NOT_LINKED'));
  a.state.online = false;
  await assert.rejects(issue(a), refusal('HANDOVER_TARGET_OFFLINE'));
  const old = pair({ capability: false });
  await assert.rejects(issue(old.a), refusal('HANDOVER_UNSUPPORTED'));
});

test('a clock up to 30 s apart is accepted; a token dated further ahead is not', async () => {
  const { a, b, clock } = pair();
  const handed = await issue(a);
  clock.now = T0 - 29_000;
  assert.doesNotThrow(() => b.service.redeem({ token: handed.token, nonce: NONCE }));
  const second = await (async () => { clock.now = T0 + 40_000; const made = await issue(a); clock.now = T0; return made; })();
  assert.throws(() => b.service.redeem({ token: second.token, nonce: NONCE }), refusal('HANDOVER_INVALID'));
});

test('too many refused hand-overs from one address are rate limited', () => {
  const { b } = pair();
  for (let i = 0; i < 20; i += 1) assert.throws(() => b.service.redeem({ token: 'x', nonce: NONCE, ip: '10.0.0.9' }));
  assert.throws(() => b.service.redeem({ token: 'x', nonce: NONCE, ip: '10.0.0.9' }), refusal('AUTH_RATE_LIMITED'));
  assert.throws(() => b.service.redeem({ token: 'x', nonce: NONCE, ip: '10.0.0.10' }), refusal('HANDOVER_INVALID'));
});

test('the linked engines\' addresses are read while they are online and kept while they are offline; the joiner adds the address it joined at', async () => {
  const { a, b } = pair();
  const first = await a.service.peersFor('owner');
  assert.equal(first.instance_id, 'inst-a');
  assert.deepEqual(first.peers, [{ instance_id: 'inst-b', name: 'B', online: true, supported: true, accepting: true, addresses: ['http://inst-b.lan:3000', 'https://inst-b.example.com'] }]);
  a.state.online = false;
  const offline = await a.service.peersFor('owner');
  assert.deepEqual(offline.peers[0].addresses, ['http://inst-b.lan:3000', 'https://inst-b.example.com']);
  assert.equal(offline.peers[0].online, false);
  assert.deepEqual(a.service.linkedAddresses(), [{ name: 'B', instance_id: 'inst-b', urls: ['http://inst-b.lan:3000', 'https://inst-b.example.com'] }]);
  // B is the joiner: A's address it joined at is one of A's addresses for B, even if A did not list it.
  const back = engine({ me: 'inst-b', peerName: 'A', peerInstance: 'inst-a', peerToken: T_A, issuedToken: T_B, role: 'joiner', clock: { now: T0 }, request: async (base, route) => (route === '/v1/info' ? { capabilities: [CAPABILITY] } : { accepting: true, addresses: ['http://127.0.0.1:3000'] }) });
  assert.deepEqual((await back.service.peersFor('owner')).peers[0].addresses, ['http://peer.lan:3000']);
  assert.equal(b.service.describeForPeer().accepting, true);
});

test('addresses: only http(s) addresses another browser can open', () => {
  assert.deepEqual(cleanAddresses(['http://127.0.0.1:3000', 'http://localhost:1', 'http://[::1]:3', 'ftp://x', 'http://u:p@x', 'http://x/?q=1', 'http://192.168.1.2:3000/', 'https://a.example.com/path', 'https://a.example.com']),
    ['http://192.168.1.2:3000', 'https://a.example.com']);
});
