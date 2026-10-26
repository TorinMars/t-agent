// The environment check: GET /api/environment/check says which features of this machine will have problems.
const express = require('express');
const clientOrigin = require('../middleware/client-origin');
const { createEnvironmentCheck } = require('../services/environment-check');

function createEnvironmentRouter(options = {}) {
  const service = options.service || createEnvironmentCheck();
  const db = options.db || require('../db');
  const router = express.Router();
  router.use(clientOrigin, options.requireAuth || require('../middleware/auth'));

  // What the checks need to know about this person and this request: the settings of the image upload (without the secret), the login state,
  // whether the tunnel is set up, and the address the page was opened with.
  function contextOf(req) {
    const owner = req.session.user.login;
    let oss = null;
    try { oss = (options.ossFor || (user => require('../services/oss-images').createOssImages({ db, sessionSecret: require('../config').sessionSecret }).getConfig(user)))(owner); } catch { /* unreadable settings count as not set up */ }
    let frpConfigured = false;
    try { const row = db.prepare("SELECT value FROM system_state WHERE key = 'frp_config'").get(); frpConfigured = Boolean(row && JSON.parse(row.value).serverAddr); } catch { /* not set up */ }
    let clientAuth = null;
    try { clientAuth = (options.clientAuth || (() => require('../services/client-auth').getClientAuth()))(); } catch { /* the login state is unknown */ }
    return { origin: req.get('origin') || `${req.protocol}://${req.get('host')}`, oss, clientAuth, frpConfigured };
  }

  // A check starts a few processes (the agents, git, curl): a second request while one runs gets the same answer instead of starting more.
  const running = new Map();
  router.get('/check', async (req, res) => {
    const context = contextOf(req);
    const key = `${req.session.user.login}|${context.origin}`;
    if (!running.has(key)) running.set(key, service.run(context).finally(() => running.delete(key)));
    try { res.json(await running.get(key)); }
    catch { res.status(500).json({ error: 'The environment check failed' }); }
  });
  return router;
}

module.exports = { createEnvironmentRouter };
