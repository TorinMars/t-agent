const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const requireAuth = require('../middleware/auth');
const { hashToken } = require('../middleware/remote-auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const rows = db.prepare(`SELECT id, name, token_prefix, scopes, last_used_at, created_at
    FROM remote_access_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`).all(req.session.user.login);
  res.json(rows);
});

router.post('/', (req, res) => {
  const name = typeof req.body.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 80) : '远程连接';
  const token = `txw_${crypto.randomBytes(32).toString('base64url')}`;
  const result = db.prepare(`INSERT INTO remote_access_tokens (user_id, name, token_hash, token_prefix, scopes)
    VALUES (?, ?, ?, ?, 'tasks:read')`).run(req.session.user.login, name, hashToken(token), token.slice(0, 12));
  res.status(201).json({ id: result.lastInsertRowid, name, token, token_prefix: token.slice(0, 12), scopes: 'tasks:read' });
});

router.delete('/:id', (req, res) => {
  const result = db.prepare(`UPDATE remote_access_tokens SET revoked_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ? AND revoked_at IS NULL`).run(req.params.id, req.session.user.login);
  if (!result.changes) return res.status(404).json({ error: 'TOKEN_NOT_FOUND' });
  res.json({ success: true });
});

module.exports = router;
