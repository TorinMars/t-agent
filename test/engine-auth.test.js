const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  createPairingCode,
  exchangePairingCode,
  authenticateAccessToken,
  hasScope,
} = require('../services/engine-auth');

function testDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE engine_access_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      principal_id TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      role TEXT NOT NULL,
      scopes TEXT NOT NULL,
      last_used_at DATETIME,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at DATETIME
    );
    CREATE TABLE engine_pairing_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      principal_id TEXT NOT NULL,
      code_hash TEXT NOT NULL UNIQUE,
      code_prefix TEXT NOT NULL,
      role TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      consumed_at DATETIME
    );
  `);
  return db;
}

test('配对码只能换取一次访问 Token', () => {
  const db = testDb();
  const pairing = createPairingCode(db, { role: 'operator', principalId: 'owner' });
  assert.match(pairing.code, /^TA-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const access = exchangePairingCode(db, pairing.code, { clientName: 'test' });
  assert.match(access.token, /^tae_/);
  const authenticated = authenticateAccessToken(db, access.token);
  assert.equal(authenticated.principal_id, 'owner');
  assert.equal(hasScope(authenticated.scopes, 'tasks:write'), true);
  assert.equal(hasScope(authenticated.scopes, 'engine:admin'), false);

  assert.throws(
    () => exchangePairingCode(db, pairing.code, { clientName: 'again' }),
    /PAIRING_CODE_INVALID_OR_EXPIRED/,
  );
  db.close();
});

test('owner Token 具有所有 scope', () => {
  const db = testDb();
  const pairing = createPairingCode(db, { role: 'owner' });
  const access = exchangePairingCode(db, pairing.code);
  const authenticated = authenticateAccessToken(db, access.token);
  assert.equal(hasScope(authenticated.scopes, 'engine:admin'), true);
  assert.equal(hasScope(authenticated.scopes, 'future:capability'), true);
  db.close();
});
