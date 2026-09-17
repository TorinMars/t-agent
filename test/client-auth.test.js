const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createClientAuth, base32, totp, matchStep, safeReturnTo, isLocalInitialization, SESSION_TTL } = require('../services/client-auth');

function fixture() {
  const database = new Database(':memory:');
  let time = 1700000000000;
  const options = { sessionSecret: 'test-only-secret-'.repeat(4), ownerId: 'local', now: () => time };
  const auth = createClientAuth(database, options);
  return { database, auth, options, now: () => time, advance: ms => { time += ms; } };
}
function bind(f) {
  const session = {};
  const setup = f.auth.beginSetup(session, true, 'owner');
  const result = f.auth.confirmSetup(session, totp(setup.secret, Math.floor(f.now() / 30000)), 'owner', true);
  session.clientAuth = result.auth;
  return { session, setup, result };
}

test('TOTP matches all RFC 6238 SHA-1 test vectors', () => {
  const secret = base32(Buffer.from('12345678901234567890'));
  for (const [seconds, expected] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
    assert.equal(totp(secret, Math.floor(seconds / 30), 8), expected);
  }
  assert.equal(matchStep(secret, 'not-a-code'), null);
});

test('unbound initialization persists and old auto-login sessions never authorize', t => {
  const f = fixture(); t.after(() => f.database.close());
  assert.deepEqual(f.auth.status({ user: { login: 'local' } }), { bound: false, authenticated: false });
  for (const local of [false, undefined, 'true', 1]) assert.throws(() => f.auth.beginSetup({}, local, 'attacker'), /AUTH_INITIALIZATION_LOCAL_ONLY/);
  const { session, setup } = bind(f);
  assert.equal(f.auth.authenticated(session), true);
  assert.equal(f.auth.authenticated({ user: { login: 'local' } }), false);
  const row = f.database.prepare('SELECT * FROM client_auth').get();
  assert.equal(row.secret_cipher.includes(setup.secret), false);
  const restarted = createClientAuth(f.database, f.options);
  assert.equal(restarted.authenticated(session), true);
  assert.throws(() => restarted.beginSetup({}, true, 'attacker'), /AUTH_REQUIRED/);
  f.advance(SESSION_TTL);
  assert.equal(restarted.authenticated(session), false);
});

test('binding requires proof, is expiring and cannot race another first binding', t => {
  const f = fixture(); t.after(() => f.database.close());
  const first = {}, second = {};
  const a = f.auth.beginSetup(first, true, 'a');
  const b = f.auth.beginSetup(second, true, 'b');
  assert.throws(() => f.auth.confirmSetup(first, 'invalid', 'a', true), /AUTH_CODE_INVALID/);
  assert.equal(f.auth.status().bound, false);
  const code = totp(a.secret, Math.floor(f.now() / 30000));
  assert.throws(() => f.auth.confirmSetup(first, code, 'remote'), /AUTH_INITIALIZATION_LOCAL_ONLY/);
  assert.equal(f.auth.status().bound, false);
  f.auth.confirmSetup(first, code, 'a', true);
  assert.throws(() => f.auth.confirmSetup(second, totp(b.secret, Math.floor(f.now() / 30000)), 'b', true), /AUTH_SETUP_CHANGED/);
  const other = fixture(); t.after(() => other.database.close());
  const pending = {};
  const setup = other.auth.beginSetup(pending, true, 'owner');
  other.advance(10 * 60 * 1000);
  assert.throws(() => other.auth.confirmSetup(pending, totp(setup.secret, Math.floor(other.now() / 30000)), 'owner', true), /AUTH_SETUP_EXPIRED/);
  other.advance(5 * 60 * 1000);
  assert.doesNotThrow(() => other.auth.beginSetup({}, true, 'owner'));
});

test('TOTP and recovery codes are one-use; rebinding revokes sessions and old recovery codes', t => {
  const f = fixture(); t.after(() => f.database.close());
  const { session, setup, result } = bind(f);
  const code = totp(setup.secret, Math.floor(f.now() / 30000));
  assert.throws(() => f.auth.authenticate(code, 'login'), /AUTH_CODE_INVALID/);
  f.advance(30000);
  const nextCode = totp(setup.secret, Math.floor(f.now() / 30000));
  const grant = f.auth.authenticate(nextCode, 'login');
  assert.equal(f.auth.authenticated({ clientAuth: grant }), true);
  assert.throws(() => f.auth.authenticate(nextCode, 'login'), /AUTH_CODE_INVALID/);
  const recoveryGrant = f.auth.authenticate(result.recoveryCodes[0].toUpperCase(), 'recovery');
  assert.equal(recoveryGrant.recovery, true);
  assert.throws(() => f.auth.authenticate(result.recoveryCodes[0], 'recovery'), /AUTH_CODE_INVALID/);
  const replacing = { clientAuth: recoveryGrant };
  const replacement = f.auth.beginSetup(replacing, undefined, 'owner');
  const confirmed = f.auth.confirmSetup(replacing, totp(replacement.secret, Math.floor(f.now() / 30000)), 'owner');
  assert.equal(f.auth.authenticated(session), false);
  assert.equal(f.auth.authenticated({ clientAuth: confirmed.auth }), true);
  assert.throws(() => f.auth.authenticate(result.recoveryCodes[1], 'recovery'), /AUTH_CODE_INVALID/);
  const hashes = f.database.prepare('SELECT recovery_hashes FROM client_auth').get().recovery_hashes;
  assert.equal(hashes.includes(confirmed.recoveryCodes[0]), false);
});

test('rate limits survive restart, expire, and weak session secrets cannot enroll', t => {
  const f = fixture(); t.after(() => f.database.close());
  for (let i = 0; i < 10; i++) assert.throws(() => f.auth.beginSetup({}, false, 'attacker'), /AUTH_INITIALIZATION_LOCAL_ONLY/);
  const restarted = createClientAuth(f.database, f.options);
  assert.throws(() => restarted.beginSetup({}, true, 'attacker'), /AUTH_RATE_LIMITED/);
  f.advance(15 * 60 * 1000);
  const again = createClientAuth(f.database, f.options);
  assert.doesNotThrow(() => again.beginSetup({}, true, 'attacker'));
  const weak = createClientAuth(f.database, { ...f.options, sessionSecret: 'dev-secret-change-me' });
  assert.throws(() => weak.beginSetup({}, true, 'owner'), /SESSION_SECRET_TOO_WEAK/);
});

test('first enrollment requires a direct loopback peer and Host, never forwarded IPs', () => {
  const request = (peer, host, headers = {}) => ({ socket: { remoteAddress: peer }, headers: { host, ...headers } });
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    for (const host of ['localhost', 'localhost:3000', '127.0.0.1:3000', '[::1]:3000']) assert.equal(isLocalInitialization(request(peer, host)), true);
  }
  for (const peer of ['192.168.1.1', '203.0.113.1', undefined]) assert.equal(isLocalInitialization(request(peer, 'localhost')), false);
  for (const host of ['client.example.test', 'localhost.attacker.test', '192.168.1.1:3000', '127.0.0.1@attacker.test', undefined]) assert.equal(isLocalInitialization(request('127.0.0.1', host)), false);
  for (const header of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']) {
    assert.equal(isLocalInitialization(request('127.0.0.1', 'localhost', { [header]: '127.0.0.1' })), false);
    assert.equal(isLocalInitialization(request('127.0.0.1', 'localhost', { [header]: '' })), false);
  }
  assert.equal(isLocalInitialization({ ip: '127.0.0.1', headers: { host: 'localhost' } }), false);
});

test('return targets are restricted to actual Client pages', () => {
  for (const value of ['https://attacker.test', '//attacker.test', '/auth/logout', '/h5?x=1', undefined]) assert.equal(safeReturnTo(value), '/');
  assert.equal(safeReturnTo('/h5'), '/web');
  for (const value of ['/', '/web']) assert.equal(safeReturnTo(value), value);
});

test('active sessions slide by 30 days without granting recent verification', t => {
  const f = fixture(); t.after(() => f.database.close());
  const { session } = bind(f);
  session.cookie = {};
  const verifiedAt = session.clientAuth.authenticatedAt;
  assert.equal(SESSION_TTL, 30 * 24 * 60 * 60 * 1000);
  f.advance(29 * 24 * 60 * 60 * 1000);
  assert.equal(f.auth.renew(session), true);
  assert.equal(session.clientAuth.expiresAt, f.now() + SESSION_TTL);
  assert.equal(session.cookie.maxAge, SESSION_TTL);
  assert.equal(session.clientAuth.authenticatedAt, verifiedAt);
  assert.throws(() => f.auth.beginSetup(session, true, 'owner'), /AUTH_RECENT_VERIFICATION_REQUIRED/);
  f.advance(SESSION_TTL);
  assert.equal(f.auth.renew(session), false);
  assert.equal(f.auth.authenticated(session), false);
});

test('valid old sessions migrate on use while revoked sessions cannot renew', t => {
  const f = fixture(); t.after(() => f.database.close());
  const { session } = bind(f);
  session.clientAuth.expiresAt = f.now() + 12 * 60 * 60 * 1000;
  f.advance(60 * 60 * 1000);
  assert.equal(f.auth.renew(session), true);
  assert.equal(session.clientAuth.expiresAt, f.now() + SESSION_TTL);
  session.clientAuth.version = 'revoked';
  const expiry = session.clientAuth.expiresAt;
  assert.equal(f.auth.renew(session), false);
  assert.equal(session.clientAuth.expiresAt, expiry);
});
