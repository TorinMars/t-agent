const express = require('express');
const path = require('path');
const QRCode = require('qrcode');
const db = require('../db');
const { ensureSingleUser } = require('../services/single-user');
const { effectiveWorkDir, saveWorkDir } = require('../services/work-dir');
const requireAuth = require('../middleware/auth');
const { getClientAuth, safeReturnTo, isSecureClientCookie, isLocalInitialization, SESSION_TTL } = require('../services/client-auth');
const { clientCookieSameSite } = require('../lib/client-embedding');
const config = require('../config');

const router = express.Router();
router.use(require('../middleware/client-origin'));

function saveLogin(req, res, auth, callback) {
  req.session.regenerate(error => {
    if (error) return callback(error);
    req.session.clientAuth = auth;
    req.session.user = ensureSingleUser();
    req.session.cookie.maxAge = SESSION_TTL;
    req.session.cookie.secure = isSecureClientCookie(req);
    req.session.cookie.sameSite = clientCookieSameSite(req, require('../config').clientFrameOrigins);
    req.session.save(saveError => callback(saveError));
  });
}

function errorResponse(res, error) {
  if (error.status === 429) res.set('Retry-After', '900');
  res.status(error.status || 500).json({ error: error.status ? error.message : 'AUTH_OPERATION_FAILED' });
}

router.get('/status', (req, res) => res.json({ ...getClientAuth().status(req.session), mode: getClientAuth().accessMode() }));

// Access mode: local = local access only, no verification; remote = authenticator + external access allowed.
// · First time (not chosen): choosing local must come from this machine; choosing remote only starts the binding flow and takes effect once binding succeeds.
// · Already chosen: must be logged in. remote→local takes effect immediately and disconnects other devices; local→remote needs an authenticator bound first (if already bound, verify one code).
router.post('/mode', (req, res) => {
  const auth = getClientAuth();
  const mode = req.body && req.body.mode;
  const current = auth.accessMode();
  const fail = (status, code, extra = {}) => res.status(status).json({ error: code, ...extra });
  if (!['local', 'remote'].includes(mode)) return fail(400, 'INVALID_ACCESS_MODE');
  if (current === 'unset') {
    if (mode === 'remote') return res.json({ mode: 'unset', redirect: `${req.baseUrl}/setup` });
    if (!isLocalInitialization(req)) return fail(403, 'LOCAL_ACCESS_REQUIRED');
    auth.setAccessMode('local');
    req.session.localTrusted = true;
    return req.session.save(error => (error ? errorResponse(res, error) : res.json({ mode: 'local', redirect: '/' })));
  }
  if (!auth.authenticated(req.session)) return fail(401, 'AUTH_REQUIRED');
  if (mode === current) return res.json({ mode, redirect: '/' });
  if (mode === 'local') {
    auth.setAccessMode('local');
    if (req.app.locals.disconnectAllClientSessions) req.app.locals.disconnectAllClientSessions();
    const local = isLocalInitialization(req);
    if (local) req.session.localTrusted = true;
    return req.session.save(error => (error ? errorResponse(res, error) : res.json({ mode: 'local', redirect: local ? '/' : null, locked_out: !local })));
  }
  // local → remote
  if (!auth.status(req.session).bound) return fail(409, 'AUTHENTICATOR_BINDING_REQUIRED', { redirect: `${config.loginPath}/setup?return_to=/` });
  try {
    const grant = auth.authenticate(req.body.code, req.ip);
    auth.setAccessMode('remote');
    saveLogin(req, res, grant, error => (error ? errorResponse(res, error) : res.json({ mode: 'remote', redirect: '/' })));
  } catch (error) { errorResponse(res, error); }
});
for (const route of ['/', '/login', '/setup']) {
  router.get(route, (req, res) => {
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.set('Referrer-Policy', 'no-referrer');
    res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
  });
}

router.post('/setup/start', async (req, res) => {
  try {
    const setup = getClientAuth().beginSetup(req.session, req.ip);
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
    saveLogin(req, res, auth, error => {
      if (error) return errorResponse(res, error);
      res.json({ success: true, recovery_codes: recoveryCodes, redirect: safeReturnTo(req.body.return_to) });
    });
  } catch (error) { errorResponse(res, error); }
});

router.post('/login', (req, res) => {
  try {
    const auth = getClientAuth().authenticate(req.body.code, req.ip);
    saveLogin(req, res, auth, error => {
      if (error) return errorResponse(res, error);
      res.json({ success: true, redirect: auth.recovery ? `${req.baseUrl}/setup?return_to=${encodeURIComponent(safeReturnTo(req.body.return_to))}` : safeReturnTo(req.body.return_to) });
    });
  } catch (error) { errorResponse(res, error); }
});

// PUT /auth/settings — update the working path
router.put('/settings', requireAuth, (req, res) => {
  let finalWorkDir;
  try { finalWorkDir = saveWorkDir(db, req.session.user.login, (req.body || {}).work_dir); }
  catch (error) { return res.status(error.status || 400).json(error.body || { error: 'INVALID_WORK_DIRECTORY' }); }
  req.session.user.work_dir = finalWorkDir;
  res.json({ success: true, work_dir: finalWorkDir });
});

// POST /auth/logout
router.post('/logout', (req, res) => {
  const sid = req.sessionID;
  req.session.destroy(error => {
    if (error) return errorResponse(res, error);
    if (req.app.locals.disconnectClientSession) req.app.locals.disconnectClientSession(sid);
    res.clearCookie(require('../config').clientSessionCookieName, { path: '/' });
    res.json({ success: true });
  });
});

// GET /auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({
    ...req.session.user,
    effective_work_dir: effectiveWorkDir(req.session.user.work_dir),
    authenticator_bound: getClientAuth().status(req.session).bound,
    access_mode: getClientAuth().accessMode(),
    listen_host: config.host,
  });
});

module.exports = router;
