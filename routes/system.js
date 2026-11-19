const express = require('express');
const requireAuth = require('../middleware/auth');
const updates = require('../services/update-manager');
const engineName = require('../services/engine-name');

// Loaded on first use, like the update manager's own state, so that loading this router opens no database.
const db = () => require('../db');

const instanceId = () => {
  const row = db().prepare("SELECT value FROM engine_identity WHERE key = 'instance_id'").get();
  return row ? row.value : null;
};

const router = express.Router();
router.use(requireAuth);

function isAdmin(req) {
  // The Client is a single-user application, so the local user can always run updates.
  return Boolean(req.session.user);
}

// `engine_name` is this machine's name, so the page needs no second call to show it. `instance_id` is this machine's own identity (engine_identity), the
// first part of the keys of its tasks in the shared task order (services/task-order.js).
router.get('/version', (req, res) => {
  let manifest;
  try { manifest = updates.readLocalManifest(); }
  catch { return res.status(500).json({ error: 'INVALID_LOCAL_VERSION' }); }
  res.json({ ...manifest, boot_id: updates.bootId, is_update_admin: isAdmin(req), engine_name: engineName.engineNameState(db()).name, instance_id: instanceId(), restart: updates.restartSupport() });
});

// The name of this Engine (services/engine-name.js), which every machine connected to it shows. Behind the session and same-origin gates of /api.
router.get('/engine-name', (req, res) => {
  res.json(engineName.engineNameState(db()));
});

router.put('/engine-name', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'ENGINE_ADMIN_REQUIRED' });
  let name;
  try { name = engineName.nameFromBody(req.body); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  res.json(engineName.setEngineName(db(), name));
});

router.get('/update-status', (req, res) => {
  res.json({ ...updates.publicState(), is_update_admin: isAdmin(req), restart: updates.restartSupport() });
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
  if (updates.restartPending()) return res.status(409).json({ error: 'RESTART_PENDING' });
  updates.apply({ force: req.body.force === true }).catch(error => console.error('[apply-update]', error.message));
  res.status(202).json({ accepted: true, status: updates.publicState() });
});

// Restart this service (lib/server-restart.js): 202 { accepted, boot_id } with the current boot_id, then exit 75 for the process manager.
// Every terminal ends; the page reloads once a different boot_id answers. Browser-only: there is no /v1 twin.
router.post('/restart', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'UPDATE_ADMIN_REQUIRED' });
  if (!req.body || req.body.confirm !== true) return res.status(400).json({ error: 'CONFIRMATION_REQUIRED' });
  try { res.status(202).json(updates.requestRestart()); }
  catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('[restart]', error.message);
    res.status(500).json({ error: 'RESTART_FAILED' });
  }
});

router.post('/auto-update', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'UPDATE_ADMIN_REQUIRED' });
  if (!req.body || typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'INVALID_AUTO_UPDATE' });
  updates.setAutoUpdateEnabled(req.body.enabled);
  res.json({ ...updates.publicState(), is_update_admin: isAdmin(req) });
});

// For the "Mac app" card of Settings: this server's web addresses (the ones app.json lists, services/app-info.js) and the T-Agent
// app installed on this Mac. Read only. `app` is null when this server does not run on macOS. `server` names the version and the
// folder the build command runs in, `autobuild` the state of the automatic rebuild after an update.
// The version compared with the app's is the one this process runs (app.json), else the one on disk.
let macApp = null;
const runningVersion = () => {
  const info = require('../services/app-info').sharedPublisher()?.current();
  if (info && info.version) return info.version;
  try { return updates.readLocalManifest().app_version || null; } catch { return null; }
};
router.get('/app-info', async (req, res) => {
  const appInfo = require('../services/app-info');
  const rebuild = require('../services/mac-app-autobuild').sharedAutobuild();
  if (!macApp) {
    macApp = appInfo.createMacAppProbe({
      serverVersion: runningVersion,
      sourceHash: () => (rebuild ? rebuild.currentHash() : null),
      refreshKey: () => { const state = rebuild && rebuild.state(); return state ? `${state.state}:${state.at}` : null; },
    });
  }
  const publisher = appInfo.sharedPublisher();
  const info = publisher ? publisher.refresh() : null;
  let app = null;
  try { app = await macApp.probe(); } catch { app = null; }
  res.set('Cache-Control', 'no-store');
  res.json({
    addresses: info && Array.isArray(info.addresses) ? info.addresses : [],
    app,
    server: { version: runningVersion(), install_dir: info ? info.install_dir : require('../lib/data-home').INSTALL_DIR },
    // The automatic rebuild of the installed app after an update (services/mac-app-autobuild.js); null off macOS or before the server listens.
    autobuild: app && rebuild ? rebuild.state() : null,
  });
});

// Tests replace the lookup of the installed app (services/app-info.js createMacAppProbe).
router.setMacAppProbe = probe => { macApp = probe; };

module.exports = router;
