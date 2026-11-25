// /api/access: the access log of this machine for Settings → Account and access → Devices and sign-ins (services/access-log.js, "Access log" in
// docs/design/access-log.md). Behind the page's session and origin checks (server.js mounts it under /api). The current device is the one the
// session was bound to at login, or the X-TA-Device header of this request.
const express = require('express');
const { deviceIdOf } = require('../services/access-log');

function createAccessRouter({ service, mode = () => 'remote' } = {}) {
  const router = express.Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const current = req => (req.session && req.session.access && req.session.access.deviceId) || deviceIdOf(req);
  const wrap = handler => (req, res) => {
    try { res.json(handler(req)); } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.code, message: error.message });
      console.error('[access]', error && error.message);
      return res.status(500).json({ error: 'ACCESS_LOG_FAILED', message: 'The access log is not available.' });
    }
  };

  router.get('/devices', wrap(req => {
    const accessMode = mode();
    return {
      mode: accessMode, can_sign_out: accessMode === 'remote', current_device: current(req) || null,
      alerts: { enabled: service().alertsEnabled() }, ip_note: service().ipNote(req),
      devices: service().devices({ current: current(req) }),
    };
  }));
  router.get('/events', wrap(req => service().events({ before: req.query.before, limit: req.query.limit })));
  router.post('/devices/:id/rename', wrap(req => ({ device: service().rename(req.params.id, req.body && req.body.name) })));
  router.post('/devices/:id/confirm', wrap(req => ({ device: service().confirm(req.params.id, { current: current(req) }) })));
  router.post('/devices/:id/revoke', wrap(req => ({ ok: true, ...service().revoke(req.params.id, { current: current(req) }) })));
  router.delete('/devices/:id', wrap(req => ({ ok: service().forget(req.params.id, { current: current(req) }) })));
  router.get('/settings', wrap(() => ({ access_alerts: service().alertsEnabled() })));
  router.put('/settings', wrap(req => ({ access_alerts: service().setAlertsEnabled(req.body && req.body.access_alerts) })));
  return router;
}

module.exports = { createAccessRouter };
