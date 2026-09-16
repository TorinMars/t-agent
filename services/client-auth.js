const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SESSION_TTL = 12 * 60 * 60 * 1000;
const SETUP_TTL = 10 * 60 * 1000;
const ATTEMPT_WINDOW = 15 * 60 * 1000;

function base32(buffer) {
  let bits = 0, value = 0, result = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; result += ALPHABET[(value >>> bits) & 31]; }
  }
  if (bits) result += ALPHABET[(value << (5 - bits)) & 31];
  return result;
}

function decodeBase32(secret) {
  let bits = 0, value = 0;
  const result = [];
  for (const char of secret) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new Error('INVALID_AUTHENTICATOR_SECRET');
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) { bits -= 8; result.push((value >>> bits) & 255); }
  }
  return Buffer.from(result);
}

// RFC 6238: SHA-1, 30-second steps; Google/Microsoft/Authy compatible.
function totp(secret, step, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits)).padStart(digits, '0');
}

function matchStep(secret, code, now = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 30000);
  for (const candidate of [step, step - 1, step + 1]) {
    if (candidate >= 0 && crypto.timingSafeEqual(Buffer.from(totp(secret, candidate)), Buffer.from(code))) return candidate;
  }
  return null;
}

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function fail(code, status = 400) { const error = new Error(code); error.status = status; throw error; }
function safeReturnTo(value) { return ['/', '/web', '/h5'].includes(value) ? value : '/'; }

// Do not trust req.ip: reverse proxies and forwarded headers can make a remote
// request appear local. First enrollment requires a direct loopback connection
// and a loopback Host (also preventing DNS rebinding).
function isLocalInitialization(req) {
  const headers = req.headers || {};
  if (['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'].some(name => headers[name] !== undefined)) return false;
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket && req.socket.remoteAddress)
    && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(headers.host || '');
}

function createClientAuth(database, { sessionSecret, ownerId, now = Date.now } = {}) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS client_auth (
      owner_id TEXT PRIMARY KEY, secret_cipher TEXT, version TEXT NOT NULL,
      last_step INTEGER NOT NULL DEFAULT -1,
      recovery_hashes TEXT NOT NULL DEFAULT '[]', bound_at TEXT
    );
    CREATE TABLE IF NOT EXISTS client_auth_attempts (
      attempt_key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
  `);
  database.prepare('INSERT OR IGNORE INTO client_auth (owner_id, version) VALUES (?, ?)').run(ownerId, crypto.randomUUID());
  const key = crypto.scryptSync(sessionSecret, 't-agent-client-auth-v1', 32);
  const read = () => database.prepare('SELECT * FROM client_auth WHERE owner_id = ?').get(ownerId);

  function encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }
  function decrypt(value) {
    const buffer = Buffer.from(value, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
    decipher.setAuthTag(buffer.subarray(12, 28));
    return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8');
  }
  function secureConfiguration() {
    if (!sessionSecret || sessionSecret.length < 32 || /^(dev-secret-change-me|your-random-secret-change-this)$/.test(sessionSecret)) fail('SESSION_SECRET_TOO_WEAK', 503);
  }
  function attempt(ip) {
    database.prepare('DELETE FROM client_auth_attempts WHERE expires_at <= ?').run(now());
    database.transaction(() => {
      for (const [attemptKey, limit] of [[hash(`ip:${ip}`), 10], ['global', 100]]) {
        const row = database.prepare('SELECT count FROM client_auth_attempts WHERE attempt_key = ?').get(attemptKey);
        if (row && row.count >= limit) fail('AUTH_RATE_LIMITED', 429);
      }
      for (const attemptKey of [hash(`ip:${ip}`), 'global']) {
        database.prepare(`INSERT INTO client_auth_attempts (attempt_key, count, expires_at) VALUES (?, 1, ?)
          ON CONFLICT(attempt_key) DO UPDATE SET count = count + 1`).run(attemptKey, now() + ATTEMPT_WINDOW);
      }
    })();
  }
  function authenticated(session) {
    const auth = session && session.clientAuth;
    const row = read();
    return Boolean(auth && row.secret_cipher && auth.ownerId === ownerId && auth.version === row.version && auth.expiresAt > now());
  }
  function sessionGrant(version) { return { ownerId, version, authenticatedAt: now(), expiresAt: now() + SESSION_TTL }; }
  function authenticate(code, ip) {
    secureConfiguration();
    attempt(ip);
    const row = read();
    if (!row.secret_cipher) fail('AUTHENTICATOR_BINDING_REQUIRED', 403);
    let recovery = false;
    if (typeof code === 'string' && /^[a-f0-9]{8}-[a-f0-9]{8}$/i.test(code)) {
      const hashes = JSON.parse(row.recovery_hashes);
      const index = hashes.indexOf(hash(code.toLowerCase()));
      if (index < 0) fail('AUTH_CODE_INVALID', 401);
      hashes.splice(index, 1);
      const result = database.prepare('UPDATE client_auth SET recovery_hashes = ? WHERE owner_id = ? AND recovery_hashes = ? AND version = ?')
        .run(JSON.stringify(hashes), ownerId, row.recovery_hashes, row.version);
      if (!result.changes) fail('AUTH_CODE_INVALID', 401);
      recovery = true;
    } else {
      const step = matchStep(decrypt(row.secret_cipher), code, now());
      if (step === null || step <= row.last_step) fail('AUTH_CODE_INVALID', 401);
      const result = database.prepare('UPDATE client_auth SET last_step = ? WHERE owner_id = ? AND last_step < ? AND version = ?')
        .run(step, ownerId, step, row.version);
      if (!result.changes) fail('AUTH_CODE_INVALID', 401);
    }
    database.prepare('DELETE FROM client_auth_attempts WHERE attempt_key = ?').run(hash(`ip:${ip}`));
    return { ...sessionGrant(row.version), recovery };
  }
  function beginSetup(session, localInitialization, ip) {
    secureConfiguration();
    const row = read();
    const replacing = Boolean(row.secret_cipher);
    if (replacing) {
      if (!authenticated(session)) fail('AUTH_REQUIRED', 401);
      if (now() - session.clientAuth.authenticatedAt > 5 * 60 * 1000) fail('AUTH_RECENT_VERIFICATION_REQUIRED', 401);
    } else {
      attempt(ip);
      if (localInitialization !== true) fail('AUTH_INITIALIZATION_LOCAL_ONLY', 403);
    }
    const secret = base32(crypto.randomBytes(20));
    session.authSetup = { cipher: encrypt(secret), version: row.version, replacing, expiresAt: now() + SETUP_TTL };
    const uri = `otpauth://totp/${encodeURIComponent(`T-Agent:${ownerId}`)}?secret=${secret}&issuer=T-Agent&algorithm=SHA1&digits=6&period=30`;
    return { secret, uri, replacing };
  }
  function confirmSetup(session, code, ip, localInitialization = false) {
    secureConfiguration();
    attempt(ip);
    const pending = session.authSetup;
    if (!pending || pending.expiresAt <= now()) fail('AUTH_SETUP_EXPIRED');
    if (!pending.replacing && localInitialization !== true) fail('AUTH_INITIALIZATION_LOCAL_ONLY', 403);
    if (pending.replacing && !authenticated(session)) fail('AUTH_REQUIRED', 401);
    const step = matchStep(decrypt(pending.cipher), code, now());
    if (step === null) fail('AUTH_CODE_INVALID', 401);
    const recoveryCodes = Array.from({ length: 8 }, () => {
      const value = crypto.randomBytes(8).toString('hex');
      return `${value.slice(0, 8)}-${value.slice(8)}`;
    });
    const version = crypto.randomUUID();
    const result = database.prepare(`UPDATE client_auth SET secret_cipher = ?, version = ?, last_step = ?, recovery_hashes = ?, bound_at = CURRENT_TIMESTAMP
      WHERE owner_id = ? AND version = ? AND (secret_cipher IS NOT NULL) = ?`).run(
      pending.cipher, version, step, JSON.stringify(recoveryCodes.map(hash)), ownerId, pending.version, pending.replacing ? 1 : 0,
    );
    if (!result.changes) fail('AUTH_SETUP_CHANGED', 409);
    delete session.authSetup;
    database.prepare('DELETE FROM client_auth_attempts WHERE attempt_key = ?').run(hash(`ip:${ip}`));
    return { auth: sessionGrant(version), recoveryCodes };
  }
  return {
    authenticated, authenticate, beginSetup, confirmSetup,
    sessionActive(sid) {
      const row = database.prepare('SELECT sess, expired FROM sessions WHERE sid = ?').get(sid);
      try { return Boolean(row && row.expired > now() && authenticated(JSON.parse(row.sess))); } catch { return false; }
    },
    status(session) { return { bound: Boolean(read().secret_cipher), authenticated: authenticated(session) }; },
  };
}

let singleton;
function getClientAuth() {
  if (!singleton) {
    const database = require('../db');
    const config = require('../config');
    singleton = createClientAuth(database, { sessionSecret: config.sessionSecret, ownerId: require('./single-user').ensureSingleUser(database).login });
  }
  return singleton;
}
module.exports = { createClientAuth, getClientAuth, totp, base32, matchStep, safeReturnTo, isLocalInitialization, SESSION_TTL };
