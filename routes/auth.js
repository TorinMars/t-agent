const express = require('express');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const db = require('../db');
const { ensureSingleUser } = require('../services/single-user');
const requireAuth = require('../middleware/auth');
const { getClientAuth, safeReturnTo, SESSION_TTL } = require('../services/client-auth');

const router = express.Router();
router.use(require('../middleware/client-origin'));

function saveLogin(req, auth, callback) {
  req.session.regenerate(error => {
    if (error) return callback(error);
    req.session.clientAuth = auth;
    req.session.user = ensureSingleUser();
    req.session.cookie.maxAge = SESSION_TTL;
    req.session.save(callback);
  });
}

function errorResponse(res, error) {
  if (error.status === 429) res.set('Retry-After', '900');
  res.status(error.status || 500).json({ error: error.status ? error.message : 'AUTH_OPERATION_FAILED' });
}

router.get('/status', (req, res) => res.json(getClientAuth().status(req.session)));
for (const route of ['/login', '/setup']) {
  router.get(route, (req, res) => {
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.set('Referrer-Policy', 'no-referrer');
    res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
  });
}

router.post('/setup/start', async (req, res) => {
  try {
    const setup = getClientAuth().beginSetup(req.session, req.body.initialization_code, req.ip);
    const qr = await QRCode.toDataURL(setup.uri, { width: 256, margin: 2, errorCorrectionLevel: 'M' });
    req.session.save(error => {
      if (error) return errorResponse(res, error);
      res.json({ ...setup, qr });
    });
  } catch (error) { errorResponse(res, error); }
});

router.post('/setup/confirm', (req, res) => {
  try {
    const { auth, recoveryCodes } = getClientAuth().confirmSetup(req.session, req.body.code, req.ip);
    if (req.app.locals.disconnectAllClientSessions) req.app.locals.disconnectAllClientSessions();
    saveLogin(req, auth, error => {
      if (error) return errorResponse(res, error);
      res.json({ success: true, recovery_codes: recoveryCodes, redirect: safeReturnTo(req.body.return_to) });
    });
  } catch (error) { errorResponse(res, error); }
});

router.post('/login', (req, res) => {
  try {
    const auth = getClientAuth().authenticate(req.body.code, req.ip);
    saveLogin(req, auth, error => {
      if (error) return errorResponse(res, error);
      res.json({ success: true, redirect: auth.recovery ? `/auth/setup?return_to=${encodeURIComponent(safeReturnTo(req.body.return_to))}` : safeReturnTo(req.body.return_to) });
    });
  } catch (error) { errorResponse(res, error); }
});

// PUT /auth/settings — 更新工作路径
router.put('/settings', requireAuth, (req, res) => {
  const { work_dir } = req.body;
  if (work_dir !== null && work_dir !== undefined && typeof work_dir !== 'string') return res.status(400).json({ error: 'INVALID_WORK_DIRECTORY' });
  const username = req.session.user.login;

  let finalWorkDir = work_dir ? work_dir.trim() : null;
  if (finalWorkDir) {
    try {
      fs.mkdirSync(finalWorkDir, { recursive: true });
    } catch (e) {
      return res.status(400).json({ error: `工作目录创建失败: ${e.message}` });
    }
  }

  db.prepare('UPDATE users SET work_dir = ? WHERE username = ?').run(finalWorkDir, username);
  req.session.user.work_dir = finalWorkDir;
  res.json({ success: true, work_dir: finalWorkDir });
});

// POST /auth/logout
router.post('/logout', (req, res) => {
  const sid = req.sessionID;
  req.session.destroy(error => {
    if (error) return errorResponse(res, error);
    if (req.app.locals.disconnectClientSession) req.app.locals.disconnectClientSession(sid);
    res.clearCookie('connect.sid', { path: '/' });
    res.json({ success: true });
  });
});

// GET /auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ ...req.session.user, authenticator_bound: true });
});

module.exports = router;
