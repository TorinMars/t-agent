const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readState, writeState, isPlainObject, settingChanged } = require('./settings-sync-store');

// Usage data ("Usage data" in docs/design/usage-data.md): the presses of the page's buttons that the page sends in batches (scripts/h5-shell/usage-track.mjs),
// stored in this server's database (tables ui_events and ui_controls, schema 12; the sync columns schema 16), kept RETENTION_DAYS days, never sent to
// an outside service. The rows are one set for the person: each engine records here and services/ui-events-sync.js merges them with the linked
// normal engines (a company computer hands its rows over and keeps none). Each press says which engine recorded it (`engine`, '' for this one) and on
// which kind of client (`client`: phone, computer, mac-app). The switch "Record button use" (system_state `ui_usage_v1`, on by default) is one choice
// for every linked engine: the settings sync group `usage-record`.

const DAY = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 90;
const STATE_KEY = 'ui_usage_v1';
// The last "Clear" of the merged set ({ at, by, seq }): every engine deletes the presses up to `at` and refuses older ones that arrive later.
const CLEAR_KEY = 'ui_usage_clear_v1';
// The names of the engines that recorded presses ({ <instance id>: name }), learned from the sync pages, so a summary names an engine of a chain.
const NAMES_KEY = 'ui_usage_engines_v1';
const SYNC_GROUP = 'usage-record';
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
const CLIENTS = Object.freeze(['phone', 'computer', 'mac-app']);
const INSTANCE_ID = /^[A-Za-z0-9-]{1,64}$/;
// The client kind of a row: as recorded, or (a row from before schema 16) read from its layout.
const CLIENT_SQL = "COALESCE(client, CASE layout WHEN 'narrow' THEN 'phone' ELSE 'computer' END)";

const appVersion = () => {
  try { return String(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'VERSION.json'), 'utf8')).app_version || ''); } catch { return ''; }
};
const invalid = () => Object.assign(new Error('INVALID_UI_EVENTS'), { statusCode: 400 });
const onlyFields = (value, allowed) => isPlainObject(value) && Object.keys(value).every(key => allowed.has(key));

// The kind of client from the User-Agent of the request that sent the batch (the agent itself is never stored): the Mac app adds
// " T-AgentApp/<version>" (apps/macos/MainWindow.swift), a phone or a tablet says so, anything else is a computer.
function clientOf(userAgent) {
  const agent = typeof userAgent === 'string' ? userAgent : '';
  if (/\bT-AgentApp\//.test(agent)) return 'mac-app';
  if (/\b(iPhone|iPad|iPod|Android|Mobile)\b/.test(agent)) return 'phone';
  return 'computer';
}

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

// ---- Schema 16: the sync columns, and the change numbers ----
// ui_events gets `uid` (a random id, the identity of a press on every engine), `engine` (the instance id of the engine that recorded it, '' for
// this one), `client` and `sync_seq`; ui_controls gets `sync_seq`. Added to an older database before schema.sql runs, because schema.sql makes
// indexes on them. Rows from before get a random uid, engine '' (recorded here), no client (read from the layout) and change numbers in their order.
function ensureSchema(db) {
  const columns = table => db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
  const events = columns('ui_events');
  const controls = columns('ui_controls');
  if (!events.length || !controls.length) return;
  db.transaction(() => {
    if (!events.includes('uid')) db.exec('ALTER TABLE ui_events ADD COLUMN uid TEXT');
    if (!events.includes('engine')) db.exec("ALTER TABLE ui_events ADD COLUMN engine TEXT NOT NULL DEFAULT ''");
    if (!events.includes('client')) db.exec('ALTER TABLE ui_events ADD COLUMN client TEXT');
    if (!events.includes('sync_seq')) db.exec('ALTER TABLE ui_events ADD COLUMN sync_seq INTEGER NOT NULL DEFAULT 0');
    if (!controls.includes('sync_seq')) db.exec('ALTER TABLE ui_controls ADD COLUMN sync_seq INTEGER NOT NULL DEFAULT 0');
    if (!events.includes('uid')) db.exec('UPDATE ui_events SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL');
    if (!events.includes('sync_seq')) db.exec('UPDATE ui_events SET sync_seq = id');
    if (!controls.includes('sync_seq')) db.exec('UPDATE ui_controls SET sync_seq = rowid + (SELECT COALESCE(MAX(id), 0) FROM ui_events)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_ui_events_uid ON ui_events (uid)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_ui_events_seq ON ui_events (sync_seq)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_ui_controls_seq ON ui_controls (sync_seq)');
  })();
}

// One change counter per database, over both tables (and the clear mark): every row written here, recorded or merged, gets the next number, so a
// peer asks for "everything after N". Rows are deleted (retention, a company computer's hand-over), so the newest number is also kept in
// `ui_usage_seq_v1` before a delete: the numbers never go back, or a peer that has "up to N" would never ask for the new rows below N.
const SEQ_KEY = 'ui_usage_seq_v1';
const counters = new WeakMap();
function counterOf(db) {
  let state = counters.get(db);
  if (state) return state;
  ensureSchema(db);
  const max = sql => Number(db.prepare(sql).pluck().get()) || 0;
  const mark = readState(db, CLEAR_KEY);
  const kept = readState(db, SEQ_KEY);
  state = { seq: Math.max(max('SELECT MAX(sync_seq) FROM ui_events'), max('SELECT MAX(sync_seq) FROM ui_controls'), Number(mark && mark.seq) || 0, Number(kept && kept.seq) || 0) };
  counters.set(db, state);
  return state;
}
const nextSeq = db => { const state = counterOf(db); state.seq += 1; return state.seq; };
const maxSeq = db => counterOf(db).seq;
// Before rows are deleted: the newest number is kept.
const keepSeq = db => writeState(db, SEQ_KEY, { seq: maxSeq(db) });

// The query of a summary (GET /api/ui-events/summary and the home's /v1/usage-sync/summary): { days, layout, engine, client } or null when invalid.
function summaryQuery(query = {}) {
  const days = query.days === undefined ? 30 : Number(query.days);
  const pick = name => (query[name] === undefined || query[name] === '' ? null : query[name]);
  const layout = pick('layout');
  const engine = pick('engine');
  const client = pick('client');
  if (!Number.isInteger(days) || days < 1 || days > 90) return null;
  if (layout !== null && !ENUMS.layout.includes(layout)) return null;
  if (engine !== null && (typeof engine !== 'string' || !INSTANCE_ID.test(engine))) return null;
  if (client !== null && !CLIENTS.includes(client)) return null;
  return { days, layout, engine, client };
}
const newUid = () => crypto.randomBytes(16).toString('hex');

// The hook for the sync: called after presses were stored or the set was cleared here (services/ui-events-sync.js pushes them a moment later).
const listeners = new Set();
function usageChanged(db) {
  for (const listener of listeners) {
    try { listener(db); } catch { /* the next round sends it anyway */ }
  }
}
function onUsageChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readClear(db) {
  const value = readState(db, CLEAR_KEY);
  return isPlainObject(value) && Number.isSafeInteger(value.at) ? { at: value.at, by: typeof value.by === 'string' ? value.by : '', seq: Number(value.seq) || 0 } : null;
}
function readNames(db) {
  const value = readState(db, NAMES_KEY);
  return isPlainObject(value) ? value : {};
}
const writeClear = (db, mark) => writeState(db, CLEAR_KEY, mark);
const writeNames = (db, names) => writeState(db, NAMES_KEY, names);

function createUiEvents({ db = require('../db'), now = Date.now, version = appVersion, identity = null } = {}) {
  ensureSchema(db);
  // This engine: { instance_id, name } (services/engine-identity.js), read when a summary or an export names engines.
  const self = () => {
    if (identity) return identity();
    try { const { engine_id: instanceId, name } = require('./engine-identity').getEngineIdentity(); return { instance_id: instanceId, name }; } catch { return { instance_id: '', name: '' }; }
  };
  const insertEvent = db.prepare(`INSERT INTO ui_events (at, page, key, detail, surface, view, layout, input, pane, device, state, version, uid, engine, client, sync_seq)
    VALUES (@at, @page, @key, @detail, @surface, @view, @layout, @input, @pane, @device, @state, @version, @uid, '', @client, @sync_seq)`);
  const upsertSeen = db.prepare(`INSERT INTO ui_controls (key, surface, layout, first_seen, last_seen, sync_seq) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key, surface, layout) DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen), sync_seq = excluded.sync_seq`);

  const enabled = () => {
    const value = readState(db, STATE_KEY);
    return !(isPlainObject(value) && value.enabled === false);
  };
  const setEnabled = on => { writeState(db, STATE_KEY, { enabled: Boolean(on) }); settingChanged(SYNC_GROUP); return enabled(); };

  // Stores a batch. The page's clock may be off: each time is moved by the difference between the server's time and the batch's `sent`, and an
  // event that is still more than a day old or in the future is dropped. While the switch is off nothing is stored. `client`: the kind of client
  // that sent it (clientOf, from the request).
  function record(batch, { client = 'computer' } = {}) {
    const checked = checkBatch(batch);
    if (!enabled()) return { accepted: 0, enabled: false };
    const at = now();
    const skew = at - checked.sent;
    const ver = version().slice(0, 32) || null;
    const kind = CLIENTS.includes(client) ? client : 'computer';
    const cleared = readClear(db);
    let accepted = 0;
    db.transaction(() => {
      for (const event of checked.events) {
        const when = Math.round(event.at + skew);
        if (when < at - DAY || when > at + 60 * 1000 || (cleared && when <= cleared.at)) continue;
        insertEvent.run({ at: when, page: checked.page, key: event.key, detail: event.detail || null, surface: event.surface, view: event.view, layout: event.layout, input: event.input, pane: event.pane ? 1 : 0, device: event.device, state: event.state || null, version: ver, uid: newUid(), client: kind, sync_seq: nextSeq(db) });
        accepted += 1;
      }
      for (const item of checked.seen) upsertSeen.run(item.key, item.surface, item.layout, at, at, nextSeq(db));
    })();
    if (accepted || checked.seen.length) usageChanged(db);
    return { accepted, enabled: true };
  }

  // Rows older than RETENTION_DAYS days go (events, and controls not seen since then). Each engine does this itself; the sync refuses older rows.
  function prune() {
    const before = now() - RETENTION_DAYS * DAY;
    keepSeq(db);
    const events = db.prepare('DELETE FROM ui_events WHERE at < ?').run(before).changes;
    const controls = db.prepare('DELETE FROM ui_controls WHERE last_seen < ?').run(before).changes;
    return { events, controls };
  }

  // Clears the merged set: every row here goes, and the clear mark (its time and change number) travels with the sync, so every linked engine deletes
  // the presses up to that time too.
  function clear() {
    let cleared = 0;
    db.transaction(() => {
      cleared = db.prepare('DELETE FROM ui_events').run().changes;
      db.prepare('DELETE FROM ui_controls').run();
      writeState(db, CLEAR_KEY, { at: now(), by: '', seq: nextSeq(db) });
    })();
    usageChanged(db);
    return { cleared };
  }

  // The size of the two tables and their indexes on disk (SQLite's dbstat), or an estimate from the row lengths where dbstat is missing.
  function bytes() {
    try {
      const row = db.prepare(`SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name IN ('ui_events', 'idx_ui_events_at', 'idx_ui_events_uid', 'idx_ui_events_seq', 'ui_controls',
        'sqlite_autoindex_ui_controls_1', 'idx_ui_controls_seq')`).get();
      return Number(row && row.bytes) || 0;
    } catch {
      const row = db.prepare("SELECT SUM(length(key) + length(surface) + length(page) + IFNULL(length(detail), 0) + 96) AS bytes FROM ui_events").get();
      return Number(row && row.bytes) || 0;
    }
  }

  // The instance id of a stored `engine` ('' is this engine) and its name.
  function engineOf(stored) {
    const me = self();
    const id = stored || me.instance_id || '';
    const name = !stored ? (me.name || null) : (typeof readNames(db)[stored] === 'string' ? readNames(db)[stored] : null);
    return { id, name, self: !stored };
  }

  // What the Settings group shows and what an assistant reads to improve the page (GET /api/ui-events/summary), over the merged set:
  // - top: the most pressed keys of the last `days` days (optionally of one layout, one engine, one client kind), each with its count per surface and
  //   per layout, and the most common details (a preset command, a menu action);
  // - unused: controls that the pages showed in that time and that were never pressed there (per key and surface, with the layouts; the controls
  //   are one list for every engine, so with an engine chosen these are the controls not pressed on that engine);
  // - next: for each key, the key pressed most often next, within 30 seconds in the same page load;
  // - engines / clients: the presses of the window per engine and per client kind (with the other filters), to split the set;
  // - data: the whole store (count, first time, retention, size).
  function summary({ days = 30, layout = null, engine = null, client = null, limit = 10 } = {}) {
    const at = now();
    const since = at - days * DAY;
    const me = self();
    const stored = engine === null ? null : (engine === me.instance_id || engine === '' ? '' : engine);
    const filters = { layout: ['layout = ?', layout], engine: ['engine = ?', stored], client: [`${CLIENT_SQL} = ?`, client] };
    const whereOf = (skip = null) => {
      const parts = ['at >= ?'];
      const args = [since];
      for (const [name, [sql, value]] of Object.entries(filters)) {
        if (name === skip || value === null || value === undefined) continue;
        parts.push(sql);
        args.push(value);
      }
      return { where: parts.join(' AND '), args };
    };
    const { where, args } = whereOf();
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
    const seenArgs = layout ? [since, layout] : [since];
    const unusedMap = new Map();
    for (const row of db.prepare(`SELECT key, surface, layout, first_seen, last_seen FROM ui_controls WHERE ${seenWhere} ORDER BY key, surface, layout`).all(...seenArgs)) {
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

    const perEngine = whereOf('engine');
    const engines = db.prepare(`SELECT engine, COUNT(*) AS n FROM ui_events WHERE ${perEngine.where} GROUP BY engine`).all(...perEngine.args)
      .map(row => ({ ...engineOf(row.engine), count: row.n }))
      .sort((a, b) => b.count - a.count || String(a.name || a.id).localeCompare(String(b.name || b.id)));
    const perClient = whereOf('client');
    const clients = Object.fromEntries(CLIENTS.map(kind => [kind, 0]));
    for (const row of db.prepare(`SELECT ${CLIENT_SQL} AS kind, COUNT(*) AS n FROM ui_events WHERE ${perClient.where} GROUP BY kind`).all(...perClient.args)) clients[row.kind] = row.n;

    const all = db.prepare('SELECT COUNT(*) AS n, MIN(at) AS first FROM ui_events').get();
    return {
      enabled: enabled(), days, layout: layout || null, engine: engine || null, client: client || null, since, total, top: topList, unused, next, engines, clients,
      data: { count: all.n, first_at: all.first === null ? null : all.first, retention_days: RETENTION_DAYS, bytes: bytes() },
    };
  }

  // Every stored row (at most RETENTION_DAYS days), for GET /api/ui-events/export, with the engine that recorded it (instance id and name) and the
  // client kind. `write` gets the JSON in pieces, so a large store is never one string.
  function exportTo(write) {
    write(`{"exported_at":${JSON.stringify(new Date(now()).toISOString())},"retention_days":${RETENTION_DAYS},"events":[`);
    let first = true;
    const engines = new Map();
    const engineFor = stored => { if (!engines.has(stored)) engines.set(stored, engineOf(stored)); return engines.get(stored); };
    for (const row of db.prepare(`SELECT at, page, key, detail, surface, view, layout, input, pane, device, state, version, engine, ${CLIENT_SQL} AS client FROM ui_events ORDER BY at, id`).iterate()) {
      const who = engineFor(row.engine);
      write(`${first ? '' : ','}${JSON.stringify({ ...row, pane: Boolean(row.pane), engine: who.id, engine_name: who.name, time: new Date(row.at).toISOString() })}`);
      first = false;
    }
    write('],"controls":');
    write(JSON.stringify(db.prepare('SELECT key, surface, layout, first_seen, last_seen FROM ui_controls ORDER BY key, surface, layout').all()));
    write('}');
  }

  return { enabled, setEnabled, record, prune, clear, summary, exportTo, db };
}

// Deletes old rows at start and once a day (an unref'd timer: it never keeps the process alive).
function startRetention(service, { every = DAY } = {}) {
  const run = () => { try { service.prune(); } catch (error) { console.warn(`Usage data: could not delete old rows (${error.message})`); } };
  run();
  const timer = setInterval(run, every);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

// Settings sync across linked devices (services/settings-sync.js, group usage-record): { enabled } once the switch was set, else null (on by default).
function exportForSync({ db }) {
  const stored = readState(db, STATE_KEY);
  return isPlainObject(stored) && typeof stored.enabled === 'boolean' ? { enabled: stored.enabled } : null;
}
function importFromSync({ db }, owner, value) {
  if (value !== null && !(isPlainObject(value) && typeof value.enabled === 'boolean')) throw Object.assign(new Error('INVALID_SYNC_VALUE'), { statusCode: 400 });
  writeState(db, STATE_KEY, value && { enabled: value.enabled });
}

module.exports = {
  createUiEvents, startRetention, checkBatch, clientOf, summaryQuery, ensureSchema, nextSeq, maxSeq, keepSeq, newUid, usageChanged, onUsageChanged, readClear, writeClear, readNames, writeNames,
  exportForSync, importFromSync,
  RETENTION_DAYS, MAX_EVENTS, MAX_SEEN, STATE_KEY, CLEAR_KEY, NAMES_KEY, SEQ_KEY, SYNC_GROUP, CLIENTS, CLIENT_SQL, ENUMS, KEY, SURFACE, DETAIL, PAGE, INSTANCE_ID, DAY,
};
