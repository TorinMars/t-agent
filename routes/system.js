const express = require('express');
const requireAuth = require('../middleware/auth');
const updates = require('../services/update-manager');

const router = express.Router();
router.use(requireAuth);

function isAdmin(req) {
  // Client 是单用户应用，本地用户始终可以执行更新。
  return Boolean(req.session.user);
}

router.get('/version', (req, res) => {
  try { res.json({ ...updates.readLocalManifest(), is_update_admin: isAdmin(req) }); }
  catch { res.status(500).json({ error: 'INVALID_LOCAL_VERSION' }); }
});

router.get('/update-status', (req, res) => {
  res.json({ ...updates.publicState(), is_update_admin: isAdmin(req) });
});

router.post('/check-update', async (req, res) => {
  try { res.json({ ...(await updates.check({ force: true })), is_update_admin: isAdmin(req) }); }
  catch (error) { res.status(502).json({ error: error.message || 'UPDATE_CHECK_FAILED', status: updates.publicState() }); }
});

router.post('/update-notified', (req, res) => {
  res.json(updates.markNotified(req.body && req.body.version));
});

router.post('/apply-update', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'UPDATE_ADMIN_REQUIRED' });
  if (!req.body || req.body.confirm !== true) return res.status(400).json({ error: 'UPDATE_CONFIRMATION_REQUIRED' });
  updates.apply().catch(error => console.error('[apply-update]', error.message));
  res.status(202).json({ accepted: true, status: updates.publicState() });
});

module.exports = router;
