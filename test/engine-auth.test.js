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

test('new role tokens include file scopes and legacy role tokens gain only their matching file scopes', () => {
  const db = testDb();
  const reader = createPairingCode(db, { role: 'readonly', principalId: 'reader' });
  const readerToken = exchangePairingCode(db, reader.code).token;
  assert.equal(hasScope(authenticateAccessToken(db, readerToken).scopes, 'files:read'), true);
  assert.equal(hasScope(authenticateAccessToken(db, readerToken).scopes, 'files:write'), false);

  const legacy = 'tae_legacy';
  db.prepare(`INSERT INTO engine_access_tokens
    (principal_id, name, token_hash, token_prefix, role, scopes)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    'operator', 'legacy', require('../services/engine-auth').hashSecret(legacy), 'tae_legacy', 'operator',
    'tasks:read,tasks:write,documents:read,documents:write,todos:read,todos:write,terminal:execute,runs:execute',
  );
  assert.equal(hasScope(authenticateAccessToken(db, legacy).scopes, 'files:write'), true);

  const restricted = 'tae_restricted';
  db.prepare(`INSERT INTO engine_access_tokens
    (principal_id, name, token_hash, token_prefix, role, scopes)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    'operator', 'restricted', require('../services/engine-auth').hashSecret(restricted), 'tae_restr', 'operator', 'tasks:read',
  );
  const restrictedAuth = authenticateAccessToken(db, restricted);
  assert.equal(hasScope(restrictedAuth.scopes, 'files:read'), false);
  assert.equal(hasScope(restrictedAuth.scopes, 'files:write'), false);
  db.close();
});
