const fs = require('fs');
const path = require('path');
const { readState, writeState, isPlainObject } = require('./settings-sync-store');

// Usage data ("Usage data" in docs/design/usage-data.md): the presses of the page's buttons that the page sends in batches (scripts/h5-shell/usage-track.mjs),
// stored on this server only (tables ui_events and ui_controls, schema 12), kept RETENTION_DAYS days, never sent anywhere. The switch "Record button use"
// is per server (system_state `ui_usage_v1`, on by default) and shared by every page of this server.

const DAY = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 90;
const STATE_KEY = 'ui_usage_v1';
const MAX_EVENTS = 100;
const MAX_SEEN = 200;
const BATCH_FIELDS = new Set(['page', 'sent', 'events', 'seen']);
const EVENT_FIELDS = new Set(['at', 'key', 'detail', 'surface', 'view', 'layout', 'input', 'pane', 'device', 'state']);
const SEEN_FIELDS = new Set(['key', 'surface', 'layout']);
const PAGE = /^[a-z0-9]{6,32}$/;
const KEY = /^[A-Za-z][A-Za-z0-9_:#*./-]{0,79}$/;
const DETAIL = /^[\x20-\x7e]{1,48}$/;
const SURFACE = /^[a-z][a-z0-9-]{0,23}(?::[A-Za-z0-9#*_-]{1,48})?$/;
const ENUMS = { view: ['sessions', 'columns', 'maps'], layout: ['wide', 'narrow'], input: ['pointer', 'touch'], device: ['local', 'remote'] };

const appVersion = () => {
  try { return String(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'VERSION.json'), 'utf8')).app_version || ''); } catch { return ''; }
};
const invalid = () => Object.assign(new Error('INVALID_UI_EVENTS'), { statusCode: 400 });
const onlyFields = (value, allowed) => isPlainObject(value) && Object.keys(value).every(key => allowed.has(key));

function validEvent(event) {
  if (!onlyFields(event, EVENT_FIELDS)) return false;
  if (!Number.isFinite(event.at) || typeof event.key !== 'string' || !KEY.test(event.key) || typeof event.surface !== 'string' || !SURFACE.test(event.surface)) return false;
  if (event.detail !== undefined && (typeof event.detail !== 'string' || !DETAIL.test(event.detail))) return false;
  if (event.state !== undefined && event.state !== 'on' && event.state !== 'off') return false;
  if (typeof event.pane !== 'boolean') return false;
  return Object.entries(ENUMS).every(([field, values]) => values.includes(event[field]));
}
const validSeen = item => onlyFields(item, SEEN_FIELDS) && typeof item.key === 'string' && KEY.test(item.key) && typeof item.surface === 'string' && SURFACE.test(item.surface) && ENUMS.layout.includes(item.layout);

// A batch of the page, checked whole: anything unknown, too long or of the wrong kind refuses the batch (INVALID_UI_EVENTS, 400).
function checkBatch(batch) {
  if (!onlyFields(batch, BATCH_FIELDS) || typeof batch.page !== 'string' || !PAGE.test(batch.page) || !Number.isFinite(batch.sent)) throw invalid();
  const events = batch.events === undefined ? [] : batch.events;
  const seen = batch.seen === undefined ? [] : batch.seen;
  if (!Array.isArray(events) || events.length > MAX_EVENTS || !events.every(validEvent)) throw invalid();
  if (!Array.isArray(seen) || seen.length > MAX_SEEN || !seen.every(validSeen)) throw invalid();
  return { page: batch.page, sent: batch.sent, events, seen };
}

function createUiEvents({ db = require('../db'), now = Date.now, version = appVersion } = {}) {
  const insertEvent = db.prepare(`INSERT INTO ui_events (at, page, key, detail, surface, view, layout, input, pane, device, state, version)
    VALUES (@at, @page, @key, @detail, @surface, @view, @layout, @input, @pane, @device, @state, @version)`);
  const upsertSeen = db.prepare(`INSERT INTO ui_controls (key, surface, layout, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key, surface, layout) DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen)`);

  const enabled = () => {
    const value = readState(db, STATE_KEY);
    return !(isPlainObject(value) && value.enabled === false);
  };
  const setEnabled = on => { writeState(db, STATE_KEY, { enabled: Boolean(on) }); return enabled(); };

  // Stores a batch. The page's clock may be off: each time is moved by the difference between the server's time and the batch's `sent`, and an
  // event that is still more than a day old or in the future is dropped. While the switch is off nothing is stored.
  function record(batch) {
    const checked = checkBatch(batch);
    if (!enabled()) return { accepted: 0, enabled: false };
    const at = now();
    const skew = at - checked.sent;
    const ver = version().slice(0, 32) || null;
    let accepted = 0;
    db.transaction(() => {
      for (const event of checked.events) {
        const when = Math.round(event.at + skew);
        if (when < at - DAY || when > at + 60 * 1000) continue;
        insertEvent.run({ at: when, page: checked.page, key: event.key, detail: event.detail || null, surface: event.surface, view: event.view, layout: event.layout, input: event.input, pane: event.pane ? 1 : 0, device: event.device, state: event.state || null, version: ver });
        accepted += 1;
      }
      for (const item of checked.seen) upsertSeen.run(item.key, item.surface, item.layout, at, at);
    })();
    return { accepted, enabled: true };
  }

  // Rows older than RETENTION_DAYS days go (events, and controls not seen since then).
  function prune() {
    const before = now() - RETENTION_DAYS * DAY;
    const events = db.prepare('DELETE FROM ui_events WHERE at < ?').run(before).changes;
    const controls = db.prepare('DELETE FROM ui_controls WHERE last_seen < ?').run(before).changes;
    return { events, controls };
  }

  function clear() {
    let cleared = 0;
    db.transaction(() => {
      cleared = db.prepare('DELETE FROM ui_events').run().changes;
      db.prepare('DELETE FROM ui_controls').run();
    })();
    return { cleared };
  }

  // The size of the two tables and their indexes on disk (SQLite's dbstat), or an estimate from the row lengths where dbstat is missing.
  function bytes() {
    try {
      const row = db.prepare("SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name IN ('ui_events', 'idx_ui_events_at', 'ui_controls', 'sqlite_autoindex_ui_controls_1')").get();
      return Number(row && row.bytes) || 0;
    } catch {
      const row = db.prepare("SELECT SUM(length(key) + length(surface) + length(page) + IFNULL(length(detail), 0) + 48) AS bytes FROM ui_events").get();
      return Number(row && row.bytes) || 0;
    }
  }

  // What the Settings group shows and what an assistant reads to improve the page (GET /api/ui-events/summary):
  // - top: the most pressed keys of the last `days` days (optionally of one layout), each with its count per surface and per layout, and the most
  //   common details (a preset command, a menu action);
  // - unused: controls that the pages showed in that time and that were never pressed there (per key and surface, with the layouts);
  // - next: for each key, the key pressed most often next, within 30 seconds in the same page load;
  // - data: the whole store (count, first time, retention, size).
  function summary({ days = 30, layout = null, limit = 10 } = {}) {
    const at = now();
    const since = at - days * DAY;
    const where = layout ? 'at >= ? AND layout = ?' : 'at >= ?';
    const args = layout ? [since, layout] : [since];
    const total = db.prepare(`SELECT COUNT(*) AS n FROM ui_events WHERE ${where}`).get(...args).n;
    const byKey = new Map();
    for (const row of db.prepare(`SELECT key, surface, layout, COUNT(*) AS n FROM ui_events WHERE ${where} GROUP BY key, surface, layout`).all(...args)) {
      const entry = byKey.get(row.key) || { key: row.key, count: 0, surfaces: new Map(), layouts: { wide: 0, narrow: 0 }, details: [] };
      entry.count += row.n;
      entry.surfaces.set(row.surface, (entry.surfaces.get(row.surface) || 0) + row.n);
      entry.layouts[row.layout] = (entry.layouts[row.layout] || 0) + row.n;
      byKey.set(row.key, entry);
    }
    const top = [...byKey.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).slice(0, limit);
    const details = db.prepare(`SELECT detail, COUNT(*) AS n FROM ui_events WHERE ${where} AND key = ? AND detail IS NOT NULL GROUP BY detail ORDER BY n DESC, detail LIMIT 5`);
    const topList = top.map(entry => ({
      key: entry.key, count: entry.count,
      surfaces: [...entry.surfaces].map(([surface, count]) => ({ surface, count })).sort((a, b) => b.count - a.count || a.surface.localeCompare(b.surface)),
      layouts: entry.layouts,
      details: details.all(...args, entry.key).map(row => ({ detail: row.detail, count: row.n })),
    }));

    // Seen but never pressed in the window: compared per key, surface and layout, then joined per key and surface.
    const used = new Set(db.prepare(`SELECT DISTINCT key, surface, layout FROM ui_events WHERE ${where}`).all(...args).map(row => `${row.key}|${row.surface}|${row.layout}`));
    const seenWhere = layout ? 'last_seen >= ? AND layout = ?' : 'last_seen >= ?';
    const unusedMap = new Map();
    for (const row of db.prepare(`SELECT key, surface, layout, first_seen, last_seen FROM ui_controls WHERE ${seenWhere} ORDER BY key, surface, layout`).all(...args)) {
      if (used.has(`${row.key}|${row.surface}|${row.layout}`)) continue;
      const id = `${row.key}|${row.surface}`;
      const entry = unusedMap.get(id) || { key: row.key, surface: row.surface, layouts: [], first_seen: row.first_seen, last_seen: row.last_seen };
      entry.layouts.push(row.layout);
      entry.first_seen = Math.min(entry.first_seen, row.first_seen);
      entry.last_seen = Math.max(entry.last_seen, row.last_seen);
      unusedMap.set(id, entry);
    }
    const unused = [...unusedMap.values()];

    // Next-click pairs: the following press in the same page load, at most 30 s later.
    const pairs = db.prepare(`SELECT key, nxt, COUNT(*) AS n FROM (
        SELECT key, at, LEAD(key) OVER w AS nxt, LEAD(at) OVER w AS nat FROM ui_events WHERE ${where}
        WINDOW w AS (PARTITION BY page ORDER BY at, id)
      ) WHERE nxt IS NOT NULL AND nat - at <= 30000 GROUP BY key, nxt`).all(...args);
    const nextBy = new Map();
    for (const row of pairs) {
      const entry = nextBy.get(row.key) || { key: row.key, next: null, count: 0, followed: 0 };
      entry.followed += row.n;
      if (row.n > entry.count || (row.n === entry.count && row.nxt < entry.next)) { entry.next = row.nxt; entry.count = row.n; }
      nextBy.set(row.key, entry);
    }
    const next = [...nextBy.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).slice(0, 30);

    const all = db.prepare('SELECT COUNT(*) AS n, MIN(at) AS first FROM ui_events').get();
    return {
      enabled: enabled(), days, layout: layout || null, since, total, top: topList, unused, next,
      data: { count: all.n, first_at: all.first === null ? null : all.first, retention_days: RETENTION_DAYS, bytes: bytes() },
    };
  }

  // Every stored row (at most RETENTION_DAYS days), for GET /api/ui-events/export. `write` gets the JSON in pieces, so a large store is never one string.
  function exportTo(write) {
    write(`{"exported_at":${JSON.stringify(new Date(now()).toISOString())},"retention_days":${RETENTION_DAYS},"events":[`);
    let first = true;
    for (const row of db.prepare('SELECT at, page, key, detail, surface, view, layout, input, pane, device, state, version FROM ui_events ORDER BY at, id').iterate()) {
      write(`${first ? '' : ','}${JSON.stringify({ ...row, pane: Boolean(row.pane), time: new Date(row.at).toISOString() })}`);
      first = false;
    }
    write('],"controls":');
    write(JSON.stringify(db.prepare('SELECT key, surface, layout, first_seen, last_seen FROM ui_controls ORDER BY key, surface, layout').all()));
    write('}');
  }

  return { enabled, setEnabled, record, prune, clear, summary, exportTo };
}

// Deletes old rows at start and once a day (an unref'd timer: it never keeps the process alive).
function startRetention(service, { every = DAY } = {}) {
  const run = () => { try { service.prune(); } catch (error) { console.warn(`Usage data: could not delete old rows (${error.message})`); } };
  run();
  const timer = setInterval(run, every);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

module.exports = { createUiEvents, startRetention, checkBatch, RETENTION_DAYS, MAX_EVENTS, MAX_SEEN, STATE_KEY, DAY };
