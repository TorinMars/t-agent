const express = require('express');
const db = require('../db');
const requireAuth = require('../middleware/auth');
const { createAccessToken, createPairingCode } = require('../services/engine-auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const rows = db.prepare(`SELECT id, name, token_prefix, scopes, last_used_at, created_at
    FROM engine_access_tokens WHERE principal_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`).all(req.session.user.login);
  res.json(rows);
});

router.post('/', (req, res) => {
  const name = typeof req.body.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 80) : '远程连接';
  const created = createAccessToken(db, {
    name,
    role: req.body.role || 'operator',
    principalId: req.session.user.login,
  });
  res.status(201).json({ ...created, name });
});

router.post('/pairing', (req, res) => {
  res.status(201).json(createPairingCode(db, {
    role: req.body.role || 'operator',
    principalId: req.session.user.login,
  }));
});

router.delete('/:id', (req, res) => {
  const result = db.prepare(`UPDATE engine_access_tokens SET revoked_at = CURRENT_TIMESTAMP
    WHERE id = ? AND principal_id = ? AND revoked_at IS NULL`).run(req.params.id, req.session.user.login);
  if (!result.changes) return res.status(404).json({ error: 'TOKEN_NOT_FOUND' });
  res.json({ success: true });
});

module.exports = router;
