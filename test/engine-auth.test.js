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

test('配对码只能换取一次访问 Token，且它就是管理权限', () => {
  const db = testDb();
  const pairing = createPairingCode(db, { principalId: 'owner' });
  assert.match(pairing.code, /^TA-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const access = exchangePairingCode(db, pairing.code, { clientName: 'test' });
  assert.match(access.token, /^tae_/);
  const authenticated = authenticateAccessToken(db, access.token);
  assert.equal(authenticated.principal_id, 'owner');
  assert.equal(hasScope(authenticated.scopes, 'tasks:write'), true);
  assert.equal(hasScope(authenticated.scopes, 'engine:admin'), true);
  assert.equal(authenticated.role, 'owner');

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

test('requested roles are ignored: every token, including previously issued restricted ones, is an administrator', () => {
  const db = testDb();
  const reader = createPairingCode(db, { role: 'readonly', principalId: 'reader' });
  assert.equal(reader.role, 'owner');
  const readerAuth = authenticateAccessToken(db, exchangePairingCode(db, reader.code).token);
  assert.equal(readerAuth.role, 'owner');
  for (const scope of ['files:read', 'files:write', 'engine:admin', 'pm2:manage']) assert.equal(hasScope(readerAuth.scopes, scope), true, scope);

  // 以前签发、数据库里仍是受限角色的令牌同样按管理权限处理（不改库）。
  const hashSecret = require('../services/engine-auth').hashSecret;
  const insert = db.prepare(`INSERT INTO engine_access_tokens
    (principal_id, name, token_hash, token_prefix, role, scopes) VALUES (?, ?, ?, ?, ?, ?)`);
  insert.run('operator', 'legacy', hashSecret('tae_legacy'), 'tae_legacy', 'operator', 'tasks:read,tasks:write');
  insert.run('operator', 'restricted', hashSecret('tae_restricted'), 'tae_restr', 'readonly', 'tasks:read');
  for (const token of ['tae_legacy', 'tae_restricted']) {
    const auth = authenticateAccessToken(db, token);
    assert.equal(auth.role, 'owner', token);
    assert.equal(hasScope(auth.scopes, 'files:write'), true, token);
    assert.equal(hasScope(auth.scopes, 'engine:admin'), true, token);
  }
  assert.equal(db.prepare("SELECT role FROM engine_access_tokens WHERE token_prefix = 'tae_restr'").get().role, 'readonly', 'stored data is left untouched');
  db.close();
});
