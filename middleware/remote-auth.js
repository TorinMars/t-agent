const crypto = require('crypto');
const db = require('../db');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = function requireRemoteAuth(requiredScope) {
  return (req, res, next) => {
    const authorization = req.get('authorization') || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ error: 'REMOTE_TOKEN_REQUIRED' });
    const row = db.prepare(`
      SELECT * FROM remote_access_tokens
      WHERE token_hash = ? AND revoked_at IS NULL
    `).get(hashToken(match[1]));
    if (!row) return res.status(401).json({ error: 'REMOTE_TOKEN_INVALID' });
    const scopes = new Set(row.scopes.split(',').map(value => value.trim()).filter(Boolean));
    if (requiredScope && !scopes.has(requiredScope)) return res.status(403).json({ error: 'REMOTE_SCOPE_REQUIRED' });
    db.prepare('UPDATE remote_access_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
    req.remoteAuth = { tokenId: row.id, userId: row.user_id, scopes };
    next();
  };
};

module.exports.hashToken = hashToken;
