const express = require('express');

// Usage time and memories of the page ("API" in docs/design/usage-time.md; services/usage-time.js, services/usage-memories.js,
// services/usage-digest.js; merged across linked devices by services/usage-time-sync.js). Behind the page login like every /api route.
// /api/usage-time:
//   GET    /settings                       -> { usage_time_record, usage_memories_digest }   (both shared across the linked engines)
//   PUT    /settings { usage_time_record?, usage_memories_digest? } -> the same
//   POST   /beats { client?, sent?, beats: [{ at, surface, kind, task, session, seconds }] } -> { ok, accepted, enabled }   (also by sendBeacon)
//   GET    /summary?range=today|week|30d&device=all|<instance id>&tz=  -> tiles, days, tasks, kinds, devices, data, where
//   GET    /task?task=<id>&range=&device=&tz=                          -> the task's sessions
//   GET    /day?day=YYYY-MM-DD&device=&tz=                             -> that day's tasks and their sessions
//   GET    /export?table=time|memories&format=json|csv                 -> a download
//   DELETE /?table=time|memories                                       -> { cleared }   (Clear of one tab, on every linked engine)
// /api/memories:
//   GET    /?q=&kind=all|event|note|digest&before=<at>&limit=50 -> { items, has_more, digest_on, where }
//   POST   / { text, task?, session?, private? }  -> the note (201)
//   PATCH  /:uid { text?, private? }             -> the note
//   DELETE /:uid                                -> { deleted, uid }   (a tombstone)
//   POST   /event { event, task?, session? }      -> { item, duplicate }   (the events only the page knows)
//   POST   /digest { week? }                      -> the digest; a provider error is answered and nothing is stored
// On a company computer that hands its data over, the reads, the export and the edits of memories kept there are those of its home.
const ALONE = Object.freeze({ company_computer: false, hands_over: false, home_name: null, home_online: null, waiting: 0, shared_with: [] });
const CODE = /^[A-Z0-9_]{1,64}$/;

function createUsageTimeRouters({ usage, memories, digest = null, sync = null, requireAuth = require('../middleware/auth') } = {}) {
  const syncer = () => (typeof sync === 'function' ? sync() : sync) || null;
  const handsOver = () => { const current = syncer(); return Boolean(current && current.handsOver()); };
  const where = () => { const current = syncer(); return current ? current.where() : { ...ALONE }; };
  const fail = (res, error) => {
    const status = error && error.statusCode;
    if (Number.isInteger(status) && status >= 400 && status < 500 && CODE.test(error.message || '')) return res.status(status).json({ error: error.message });
    if (Number.isInteger(status) && status === 503 && CODE.test(error.message || '')) return res.status(503).json({ error: error.message });
    console.warn(`Usage time: ${error && error.message}`);
    return res.status(500).json({ error: 'USAGE_TIME_FAILED' });
  };
  const read = (what, query, local) => (handsOver() ? syncer().companyRead(what, query, local) : Promise.resolve({ ...local(), where: where() }));

  const time = express.Router();
  time.use(requireAuth);
  time.get('/settings', (req, res) => { try { res.json(usage.settings()); } catch (error) { fail(res, error); } });
  time.put('/settings', (req, res) => { try { res.json(usage.setSettings(req.body)); } catch (error) { fail(res, error); } });
  time.post('/beats', (req, res) => {
    const { clientOf } = require('../services/ui-events');
    try { res.json(usage.recordBeats(req.body, { client: clientOf(req.get('user-agent')) })); } catch (error) { fail(res, error); }
  });
  const query = req => ({ ...req.query });
  time.get('/summary', async (req, res) => {
    try { const q = query(req); res.json(await read('summary', q, () => usage.summary(q))); } catch (error) { fail(res, error); }
  });
  time.get('/task', async (req, res) => {
    try { const q = query(req); res.json(await read('task', q, () => usage.task(q))); } catch (error) { fail(res, error); }
  });
  time.get('/day', async (req, res) => {
    try { const q = query(req); res.json(await read('day', q, () => usage.day(q))); } catch (error) { fail(res, error); }
  });
  time.get('/export', async (req, res) => {
    const table = req.query.table === undefined ? 'time' : req.query.table;
    const format = req.query.format === undefined ? 'json' : req.query.format;
    if (!['time', 'memories'].includes(table) || !['json', 'csv'].includes(format)) return res.status(400).json({ error: 'INVALID_USAGE_TIME_QUERY' });
    const day = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="t-agent-${table === 'time' ? 'usage-time' : 'memories'}-${day}.${format}"`);
    try {
      const write = part => res.write(part);
      if (handsOver()) await syncer().companyExport(table, format, write);
      else if (table === 'memories') memories.exportMemories(write, format);
      else usage.exportTime(write, format);
      return res.end();
    } catch (error) {
      if (!res.headersSent) return fail(res, error);
      return res.destroy(error);
    }
  });
  time.delete('/', (req, res) => {
    const table = req.query.table;
    if (table !== 'time' && table !== 'memories') return res.status(400).json({ error: 'INVALID_USAGE_TIME_QUERY' });
    try { return res.json(table === 'time' ? usage.clearTime() : memories.clear()); } catch (error) { return fail(res, error); }
  });

  const notes = express.Router();
  notes.use(requireAuth);
  notes.get('/', async (req, res) => {
    try { const q = query(req); delete q.uid; res.json(await read('memories', q, () => memories.list(q))); } catch (error) { fail(res, error); }
  });
  notes.post('/', (req, res) => { try { res.status(201).json(memories.addNote(req.body)); } catch (error) { fail(res, error); } });
  notes.post('/event', (req, res) => { try { res.json(memories.addPageEvent(req.body)); } catch (error) { fail(res, error); } });
  notes.post('/digest', async (req, res) => {
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'week') || (body.week !== undefined && typeof body.week !== 'string')) return res.status(400).json({ error: 'INVALID_MEMORY' });
    if (!digest) return res.status(404).json({ error: 'NOT_FOUND' });
    if (handsOver()) return res.status(409).json({ error: 'USAGE_COMPANY_COMPUTER' });
    try { return res.json(await digest.write(body.week || null)); } catch (error) {
      if (error && CODE.test(error.message || '') && Number.isInteger(error.statusCode) && error.statusCode < 500) return res.status(error.statusCode).json({ error: error.message });
      // The translation service's own reason (an English sentence, translated on the page like other server messages).
      const status = error && error.statusCode === 409 ? 409 : 502;
      return res.status(status).json({ error: 'DIGEST_FAILED', message: String((error && error.message) || 'The model gave no answer').slice(0, 300) });
    }
  });
  const edit = method => async (req, res) => {
    try {
      if (handsOver()) return res.json(await syncer().companyMemory(method, req.params.uid, req.body));
      return res.json(method === 'DELETE' ? memories.remove(req.params.uid) : memories.editNote(req.params.uid, req.body));
    } catch (error) { return fail(res, error); }
  };
  notes.patch('/:uid', edit('PATCH'));
  notes.delete('/:uid', edit('DELETE'));

  return { time, memories: notes };
}

module.exports = { createUsageTimeRouters };
