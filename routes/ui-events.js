const express = require('express');

// Usage data of the page ("Usage data" in docs/design/usage-data.md; services/ui-events.js). Behind the page login like every /api route:
//   GET    /api/ui-events/settings          -> { enabled }            the switch "Record button use" of this server (on by default)
//   PUT    /api/ui-events/settings {enabled} -> { enabled }
//   POST   /api/ui-events {page, sent, events, seen} -> { accepted, enabled }   a batch of the page (also sent with navigator.sendBeacon)
//   GET    /api/ui-events/summary?days=30&layout=wide|narrow   -> top keys, unused controls, next-click pairs, the store's size
//   GET    /api/ui-events/export            -> every stored row as a JSON download
//   DELETE /api/ui-events                   -> { cleared }            deletes every row
function createUiEventsRouter({ service = null, requireAuth = require('../middleware/auth') } = {}) {
  const router = express.Router();
  router.use(requireAuth);
  const usage = () => service || (service = require('../services/ui-events').createUiEvents());
  const fail = (res, error) => {
    if (error && error.statusCode === 400) return res.status(400).json({ error: error.message });
    console.warn(`Usage data: ${error && error.message}`);
    return res.status(500).json({ error: 'UI_EVENTS_FAILED' });
  };

  router.get('/settings', (req, res) => {
    try { res.json({ enabled: usage().enabled() }); } catch (error) { fail(res, error); }
  });
  router.put('/settings', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'enabled') || typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'INVALID_UI_EVENTS_SETTING' });
    try { res.json({ enabled: usage().setEnabled(body.enabled) }); } catch (error) { fail(res, error); }
  });

  router.post('/', (req, res) => {
    try { res.json(usage().record(req.body)); } catch (error) { fail(res, error); }
  });

  router.get('/summary', (req, res) => {
    const days = req.query.days === undefined ? 30 : Number(req.query.days);
    const layout = req.query.layout === undefined || req.query.layout === '' ? null : req.query.layout;
    if (!Number.isInteger(days) || days < 1 || days > 90 || (layout !== null && layout !== 'wide' && layout !== 'narrow')) return res.status(400).json({ error: 'INVALID_UI_EVENTS_QUERY' });
    try { res.json(usage().summary({ days, layout })); } catch (error) { fail(res, error); }
  });

  router.get('/export', (req, res) => {
    const day = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="t-agent-usage-${day}.json"`);
    // Written in pieces as the rows are read; an error after the first piece can only cut the download short.
    try {
      usage().exportTo(part => res.write(part));
      res.end();
    } catch (error) {
      if (!res.headersSent) fail(res, error);
      else res.destroy(error);
    }
  });

  router.delete('/', (req, res) => {
    try { res.json(usage().clear()); } catch (error) { fail(res, error); }
  });
  return router;
}

module.exports = { createUiEventsRouter };
