const express = require('express');

// Usage data of the page ("Usage data" in docs/design/usage-data.md; services/ui-events.js, merged across linked devices by
// services/ui-events-sync.js). Behind the page login like every /api route:
//   GET    /api/ui-events/settings          -> { enabled }            the switch "Record button use" (on by default; one choice for every linked engine)
//   PUT    /api/ui-events/settings {enabled} -> { enabled }
//   POST   /api/ui-events {page, sent, events, seen} -> { accepted, enabled }   a batch of the page (also sent with navigator.sendBeacon)
//   GET    /api/ui-events/summary?days=30&layout=wide|narrow&engine=<instance id>&client=phone|computer|mac-app
//                                           -> top keys, unused controls, next-click pairs, the split per engine and client, the store, where it is kept
//   GET    /api/ui-events/export            -> every stored row of the merged set as a JSON download
//   DELETE /api/ui-events                   -> { cleared }            deletes every row, here and (through the sync) on every linked engine
// On a company computer that hands its presses over, the summary and the export are those of its home (services/ui-events-sync.js).
const ALONE = Object.freeze({ company_computer: false, hands_over: false, home_name: null, home_online: null, waiting: 0, shared_with: [] });

function createUiEventsRouter({ service = null, sync = null, requireAuth = require('../middleware/auth') } = {}) {
  const router = express.Router();
  router.use(requireAuth);
  const usage = () => service || (service = require('../services/ui-events').createUiEvents());
  // The sync of this server (a getter, null when it is turned off).
  const syncer = () => (typeof sync === 'function' ? sync() : sync) || null;
  const handsOver = () => { const current = syncer(); return Boolean(current && current.handsOver()); };
  const where = () => { const current = syncer(); return current ? current.where() : { ...ALONE }; };
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
    const { clientOf } = require('../services/ui-events');
    try { res.json(usage().record(req.body, { client: clientOf(req.get('user-agent')) })); } catch (error) { fail(res, error); }
  });

  router.get('/summary', async (req, res) => {
    const query = require('../services/ui-events').summaryQuery(req.query);
    if (!query) return res.status(400).json({ error: 'INVALID_UI_EVENTS_QUERY' });
    try {
      if (handsOver()) return res.json(await syncer().companySummary(query));
      return res.json({ ...usage().summary(query), where: where() });
    } catch (error) { return fail(res, error); }
  });

  router.get('/export', async (req, res) => {
    const day = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="t-agent-usage-${day}.json"`);
    // Written in pieces as the rows are read; an error after the first piece can only cut the download short.
    try {
      const write = part => res.write(part);
      if (handsOver()) await syncer().companyExport(write);
      else usage().exportTo(write);
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
