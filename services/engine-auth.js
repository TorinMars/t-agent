const crypto = require('crypto');

const ROLE_SCOPES = Object.freeze({
  readonly: ['tasks:read', 'documents:read', 'todos:read'],
  operator: [
    'tasks:read', 'tasks:write',
    'documents:read', 'documents:write',
    'todos:read', 'todos:write',
    'terminal:execute', 'runs:execute',
  ],
  owner: ['*'],
});

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeRole(role) {
  return Object.hasOwn(ROLE_SCOPES, role) ? role : 'operator';
}

function roleScopes(role) {
  return [...ROLE_SCOPES[normalizeRole(role)]];
}

function hasScope(scopes, required) {
  if (!required) return true;
  const values = scopes instanceof Set ? scopes : new Set(scopes || []);
  return values.has('*') || values.has(required);
}

function createAccessToken(db, { name = '客户端', role = 'operator', principalId = 'engine' } = {}) {
  const normalizedRole = normalizeRole(role);
  const token = `tae_${crypto.randomBytes(32).toString('base64url')}`;
  const scopes = roleScopes(normalizedRole).join(',');
  const result = db.prepare(`
    INSERT INTO engine_access_tokens
      (principal_id, name, token_hash, token_prefix, role, scopes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    String(principalId || 'engine'),
    String(name || '客户端').trim().slice(0, 80),
    hashSecret(token),
    token.slice(0, 12),
    normalizedRole,
    scopes,
  );
  return { id: Number(result.lastInsertRowid), token, token_prefix: token.slice(0, 12), role: normalizedRole, scopes };
}

function randomPairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  const parts = [];
  for (let group = 0; group < 3; group += 1) {
    let part = '';
    for (let index = 0; index < 4; index += 1) {
      part += alphabet[bytes[group * 4 + index] % alphabet.length];
    }
    parts.push(part);
  }
  return `TA-${parts.join('-')}`;
}

function createPairingCode(db, { role = 'operator', ttlMinutes = 10, principalId = 'engine' } = {}) {
  const normalizedRole = normalizeRole(role);
  const safeTtl = Math.min(60, Math.max(1, Number.parseInt(ttlMinutes, 10) || 10));
  db.prepare(`DELETE FROM engine_pairing_codes
    WHERE consumed_at IS NOT NULL OR expires_at <= CURRENT_TIMESTAMP`).run();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomPairingCode();
    try {
      const result = db.prepare(`
        INSERT INTO engine_pairing_codes (principal_id, code_hash, code_prefix, role, expires_at)
        VALUES (?, ?, ?, ?, datetime('now', ?))
      `).run(String(principalId || 'engine'), hashSecret(code), code.slice(0, 7), normalizedRole, `+${safeTtl} minutes`);
      return { id: Number(result.lastInsertRowid), code, role: normalizedRole, expires_in_seconds: safeTtl * 60 };
    } catch (error) {
      if (error.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
    }
  }
  throw new Error('PAIRING_CODE_GENERATION_FAILED');
}

function exchangePairingCode(db, code, { clientName = '客户端', principalId } = {}) {
  const value = String(code || '').trim().toUpperCase();
  if (!/^TA-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(value)) {
    throw new Error('PAIRING_CODE_INVALID');
  }

  return db.transaction(() => {
    const row = db.prepare(`
      SELECT * FROM engine_pairing_codes
      WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP
    `).get(hashSecret(value));
    if (!row) throw new Error('PAIRING_CODE_INVALID_OR_EXPIRED');
    const updated = db.prepare(`UPDATE engine_pairing_codes SET consumed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND consumed_at IS NULL`).run(row.id);
    if (!updated.changes) throw new Error('PAIRING_CODE_ALREADY_USED');
    return createAccessToken(db, { name: clientName, role: row.role, principalId: principalId || row.principal_id });
  })();
}

function authenticateAccessToken(db, token) {
  const value = String(token || '');
  if (!value.startsWith('tae_')) return null;
  const row = db.prepare(`SELECT * FROM engine_access_tokens
    WHERE token_hash = ? AND revoked_at IS NULL`).get(hashSecret(value));
  if (!row) return null;
  db.prepare('UPDATE engine_access_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
  return { ...row, scopes: new Set(String(row.scopes).split(',').map(item => item.trim()).filter(Boolean)) };
}

module.exports = {
  ROLE_SCOPES,
  hashSecret,
  normalizeRole,
  roleScopes,
  hasScope,
  createAccessToken,
  createPairingCode,
  exchangePairingCode,
  authenticateAccessToken,
};
