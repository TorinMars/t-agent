const crypto = require('crypto');
const { readState, writeState, isPlainObject, settingChanged } = require('./settings-sync-store');

// Usage time ("Usage time and memories" in docs/design/usage-time.md): how long the person used the page and how long the agents of their sessions
// worked or waited for them, in seconds, never text. Two writers, one table (usage_time, schema 25):
// - the page's beats (POST /api/usage-time/beats): 15-second steps while the page is visible and the person did something in the last 2 minutes;
// - the session clocks of this engine (services/usage-time-clock.js): agent_working and waiting_you per terminal, flushed every 60 s.
// A row is one key (UTC day and hour, surface, kind, task, session, client) of one origin engine, identified by a random uid. Only its origin adds
// seconds to it (a revision number goes up with each change); a peer keeps the copy with the larger revision. Sums over rows never count a second
// twice: every second is in exactly one origin row. A company computer deletes its rows once its home has them; its next seconds go to a new row
// (a new uid), which the home adds to the one it already has.
// The memories (services/usage-memories.js) share this file's change counter and clear marks, so one sync (services/usage-time-sync.js) carries
// both tables.

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const RETENTION_DAYS = 730;
const MAX_BEATS = 40;
const MAX_BEAT_SECONDS = 30;
const MAX_ROW_SECONDS = 3600;
const SURFACES = Object.freeze(['sessions', 'learn', 'mindmaps', 'attention', 'settings', 'other']);
const KINDS = Object.freeze(['claude', 'codex', 'opencode', 'terminal', 'notebook']);
const CLIENTS = Object.freeze(['phone', 'computer', 'mac-app']);
const INSTANCE_ID = /^[A-Za-z0-9-]{1,64}$/;
// Engine-neutral ids, as the shared page state names them: `<instance>|<task>` and `<instance>|<task>|<terminal>`.
const TASK = /^[A-Za-z0-9-]{1,64}\|\d{1,12}$/;
const SESSION = /^[A-Za-z0-9-]{1,64}\|\d{1,12}\|[A-Za-z0-9_.:-]{1,80}$/;
const DAY_TEXT = /^\d{4}-\d{2}-\d{2}$/;
// Waits by length, for the median wait without keeping each wait: upper edges in seconds (the last bucket has none).
const WAIT_EDGES = Object.freeze([15, 30, 60, 120, 180, 300, 600, 900, 1800, 3600, 7200]);

// system_state keys.
const RECORD_KEY = 'usage_time_record_v1'; // the "Record time" switch { enabled } (settings sync group usage-time-record), on by default
const DIGEST_KEY = 'usage_memories_digest_v1'; // the "Write a weekly digest" switch { enabled } (settings sync group usage-memories-digest), off by default
const SEQ_KEY = 'usage_time_seq_v1'; // the newest change number, kept when rows are deleted so the numbers never go back
const TIME_CLEAR_KEY = 'usage_time_clear_v1'; // the last Clear of the time tab { at, by, seq }
const MEMORIES_CLEAR_KEY = 'usage_memories_clear_v1'; // the last Clear of the memories tab { at, by, seq }
const NAMES_KEY = 'usage_time_engines_v1'; // the names of the engines whose rows are here (a cache from the sync pages)
const RECORD_GROUP = 'usage-time-record';
const DIGEST_GROUP = 'usage-memories-digest';

const fault = (code, statusCode = 400) => Object.assign(new Error(code), { statusCode });
const invalid = () => fault('INVALID_USAGE_TIME', 400);
const onlyFields = (value, allowed) => isPlainObject(value) && Object.keys(value).every(key => allowed.has(key));
const newUid = () => crypto.randomBytes(16).toString('hex');
const int = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const blank = value => (value === null || value === undefined ? '' : value);
const orNull = value => (value === '' || value === null || value === undefined ? null : value);

// ---- Time zones ----
const formatters = new Map();
function zoneOf(tz) {
  if (typeof tz === 'string' && tz && tz.length <= 64) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { /* the system's below */ }
  }
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
function partsIn(ms, tz) {
  let format = formatters.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    formatters.set(tz, format);
  }
  const out = {};
  for (const part of format.formatToParts(new Date(ms))) out[part.type] = part.value;
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(out.weekday) + 1; // 1 = Monday
  return { year: Number(out.year), month: Number(out.month), day: Number(out.day), hour: Number(out.hour), minute: Number(out.minute), second: Number(out.second), weekday };
}
const pad = n => String(n).padStart(2, '0');
// The local date (YYYY-MM-DD) of a time in a zone.
function localDay(ms, tz) { const p = partsIn(ms, tz); return `${p.year}-${pad(p.month)}-${pad(p.day)}`; }
// The time of local midnight of the day that contains `ms`.
function localMidnight(ms, tz) {
  const p = partsIn(ms, tz);
  const wall = Date.UTC(p.year, p.month - 1, p.day);
  let guess = wall;
  for (let i = 0; i < 3; i += 1) {
    const q = partsIn(guess, tz);
    const offset = Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second) - guess;
    const next = wall - offset;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}
// The local midnight `days` days after the one of `ms` (DST safe: steps from noon).
const midnightPlus = (ms, days, tz) => localMidnight(localMidnight(ms, tz) + days * DAY + 12 * HOUR, tz);
// The ISO week of a time in a zone: 'YYYY-Www', with the local Monday 00:00 it starts at.
function isoWeek(ms, tz) {
  const p = partsIn(ms, tz);
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const weekday = p.weekday;
  date.setUTCDate(date.getUTCDate() + 4 - weekday); // the Thursday of this week
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / DAY + 1) / 7);
  return { week: `${date.getUTCFullYear()}-W${pad(week)}`, start: midnightPlus(ms, 1 - weekday, tz) };
}
const WEEK = /^(\d{4})-W(\d{2})$/;
// The local Monday 00:00 of an ISO week ('YYYY-Www'), or null.
function weekStart(week, tz) {
  const match = WEEK.exec(String(week || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const n = Number(match[2]);
  if (n < 1 || n > 53) return null;
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Weekday = new Date(jan4).getUTCDay() || 7;
  const monday = jan4 + ((1 - jan4Weekday) + (n - 1) * 7) * DAY;
  const start = localMidnight(monday + 12 * HOUR, tz);
  return isoWeek(start + 12 * HOUR, tz).week === week ? start : null;
}

// The UTC day and hour of a time, and the start of that hour.
function hourOf(ms) {
  const start = Math.floor(ms / HOUR) * HOUR;
  const date = new Date(start);
  return { day: date.toISOString().slice(0, 10), hour: date.getUTCHours(), start };
}

// ---- Ids ----
// A task and session pair as stored ('' for none), or null when either is not an engine-neutral id or they do not belong together.
function cleanRefs(task, session) {
  const t = task === undefined || task === null ? '' : task;
  const s = session === undefined || session === null ? '' : session;
  if (typeof t !== 'string' || typeof s !== 'string') return null;
  if (t && !TASK.test(t)) return null;
  if (s && !SESSION.test(s)) return null;
  if (s && t && !s.startsWith(`${t}|`)) return null;
  return { task: t || (s ? s.split('|').slice(0, 2).join('|') : ''), session: s };
}

// ---- The change counter (both tables and the clear marks) ----
const counters = new WeakMap();
function counterOf(db) {
  let state = counters.get(db);
  if (state) return state;
  const max = sql => { try { return Number(db.prepare(sql).pluck().get()) || 0; } catch { return 0; } };
  const marks = [readState(db, TIME_CLEAR_KEY), readState(db, MEMORIES_CLEAR_KEY), readState(db, SEQ_KEY)].map(value => Number(value && value.seq) || 0);
  state = { seq: Math.max(max('SELECT MAX(sync_seq) FROM usage_time'), max('SELECT MAX(sync_seq) FROM memories'), ...marks) };
  counters.set(db, state);
  return state;
}
const nextSeq = db => { const state = counterOf(db); state.seq += 1; return state.seq; };
const maxSeq = db => counterOf(db).seq;
const keepSeq = db => writeState(db, SEQ_KEY, { seq: maxSeq(db) });

function markOf(value) {
  return isPlainObject(value) && Number.isSafeInteger(value.at) ? { at: value.at, by: typeof value.by === 'string' ? value.by : '', seq: Number(value.seq) || 0 } : null;
}
const readTimeClear = db => markOf(readState(db, TIME_CLEAR_KEY));
const readMemoriesClear = db => markOf(readState(db, MEMORIES_CLEAR_KEY));
const writeTimeClear = (db, mark) => writeState(db, TIME_CLEAR_KEY, mark);
const writeMemoriesClear = (db, mark) => writeState(db, MEMORIES_CLEAR_KEY, mark);
function readNames(db) { const value = readState(db, NAMES_KEY); return isPlainObject(value) ? value : {}; }
const writeNames = (db, names) => writeState(db, NAMES_KEY, names);

// The sync's hook: called after rows were written or a tab was cleared here.
const listeners = new Set();
function usageTimeChanged(db) { for (const listener of listeners) { try { listener(db); } catch { /* the next round sends it anyway */ } } }
function onUsageTimeChanged(listener) { listeners.add(listener); return () => listeners.delete(listener); }

// ---- Wait histograms ----
const emptyHist = () => WAIT_EDGES.map(() => 0).concat(0);
function parseHist(text) {
  if (!text) return emptyHist();
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value) && value.length === WAIT_EDGES.length + 1 && value.every(n => Number.isSafeInteger(n) && n >= 0)) return value;
  } catch { /* empty below */ }
  return emptyHist();
}
const bucketOf = seconds => { const index = WAIT_EDGES.findIndex(edge => seconds < edge); return index < 0 ? WAIT_EDGES.length : index; };
// The median of the waits counted in a histogram (seconds; inside its bucket by linear interpolation), or null without waits.
function medianOf(hist) {
  const total = hist.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const half = total / 2;
  let seen = 0;
  for (let i = 0; i < hist.length; i += 1) {
    if (!hist[i]) continue;
    if (seen + hist[i] >= half) {
      const low = i === 0 ? 0 : WAIT_EDGES[i - 1];
      const high = i < WAIT_EDGES.length ? WAIT_EDGES[i] : low * 2;
      return Math.round(low + ((half - seen) / hist[i]) * (high - low));
    }
    seen += hist[i];
  }
  return null;
}

// ---- Beats ----
const BATCH_FIELDS = new Set(['client', 'sent', 'beats']);
const BEAT_FIELDS = new Set(['at', 'surface', 'kind', 'task', 'session', 'seconds']);
function checkBeats(body) {
  if (!onlyFields(body, BATCH_FIELDS) || !Array.isArray(body.beats) || body.beats.length > MAX_BEATS) throw invalid();
  if (body.client !== undefined && body.client !== null && (typeof body.client !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(body.client))) throw invalid();
  if (body.sent !== undefined && !Number.isFinite(body.sent)) throw invalid();
  const beats = body.beats.map(beat => {
    if (!onlyFields(beat, BEAT_FIELDS) || !Number.isFinite(beat.at) || !SURFACES.includes(beat.surface)) throw invalid();
    if (!Number.isInteger(beat.seconds) || beat.seconds < 1 || beat.seconds > MAX_BEAT_SECONDS) throw invalid();
    if (beat.kind !== undefined && beat.kind !== null && !KINDS.includes(beat.kind)) throw invalid();
    const refs = cleanRefs(beat.task, beat.session);
    if (!refs) throw invalid();
    return { at: beat.at, surface: beat.surface, kind: blank(beat.kind), task: refs.task, session: refs.session, seconds: beat.seconds };
  });
  return { client: CLIENTS.includes(body.client) ? body.client : null, sent: Number.isFinite(body.sent) ? body.sent : null, beats };
}

function createUsageTime({ db = require('../db'), now = Date.now, identity = null, titles = null, linked = null } = {}) {
  const self = () => {
    if (identity) return identity();
    try { const { engine_id: instanceId, name } = require('./engine-identity').getEngineIdentity(); return { instance_id: instanceId, name }; } catch { return { instance_id: '', name: '' }; }
  };

  // ---- Switches ----
  const recording = () => { const value = readState(db, RECORD_KEY); return !(isPlainObject(value) && value.enabled === false); };
  const digestOn = () => { const value = readState(db, DIGEST_KEY); return isPlainObject(value) && value.enabled === true; };
  const settings = () => ({ usage_time_record: recording(), usage_memories_digest: digestOn() });
  function setSettings(body) {
    const allowed = new Set(['usage_time_record', 'usage_memories_digest']);
    if (!onlyFields(body, allowed) || !Object.keys(body).length || Object.values(body).some(value => typeof value !== 'boolean')) throw fault('INVALID_USAGE_TIME_SETTING', 400);
    if (body.usage_time_record !== undefined) { writeState(db, RECORD_KEY, { enabled: body.usage_time_record }); settingChanged(RECORD_GROUP); }
    if (body.usage_memories_digest !== undefined) { writeState(db, DIGEST_KEY, { enabled: body.usage_memories_digest }); settingChanged(DIGEST_GROUP); }
    return settings();
  }

  // ---- Writing seconds into the local row of a key ----
  const findLocal = db.prepare(`SELECT * FROM usage_time WHERE engine = '' AND day = @day AND hour = @hour AND client = @client AND surface = @surface
    AND kind = @kind AND task = @task AND session = @session LIMIT 1`);
  const insertRow = db.prepare(`INSERT INTO usage_time (uid, engine, client, day, hour, start, surface, kind, task, session, page_s, working_s, waiting_s, waits, rev, updated_at, sync_seq)
    VALUES (@uid, '', @client, @day, @hour, @start, @surface, @kind, @task, @session, @page_s, @working_s, @waiting_s, @waits, 1, @updated_at, @sync_seq)`);
  const updateRow = db.prepare(`UPDATE usage_time SET page_s = @page_s, working_s = @working_s, waiting_s = @waiting_s, waits = @waits, rev = rev + 1,
    updated_at = @updated_at, sync_seq = @sync_seq WHERE uid = @uid`);
  // Adds seconds (and finished waits) to the row of a key. Each column is capped at an hour.
  function add(key, { page = 0, working = 0, waiting = 0, waits = [] } = {}) {
    const at = now();
    const where = { client: '', surface: '', kind: '', task: '', session: '', ...key };
    const current = findLocal.get(where);
    const hist = parseHist(current && current.waits);
    for (const seconds of waits) hist[bucketOf(seconds)] += 1;
    const values = {
      page_s: Math.min(MAX_ROW_SECONDS, (current ? current.page_s : 0) + page),
      working_s: Math.min(MAX_ROW_SECONDS, (current ? current.working_s : 0) + working),
      waiting_s: Math.min(MAX_ROW_SECONDS, (current ? current.waiting_s : 0) + waiting),
      waits: hist.some(Boolean) ? JSON.stringify(hist) : '',
      updated_at: at, sync_seq: nextSeq(db),
    };
    if (current) updateRow.run({ ...values, uid: current.uid });
    else insertRow.run({ ...where, ...values, uid: newUid() });
  }

  // POST /api/usage-time/beats. The page's clock may be off: with `sent`, each time is moved by the difference; a beat still more than a day old,
  // a minute ahead or not after the Clear of the time tab is dropped. Off: nothing is stored.
  function recordBeats(body, { client = 'computer' } = {}) {
    const checked = checkBeats(body);
    if (!recording()) return { ok: false, accepted: 0, enabled: false };
    const at = now();
    const skew = checked.sent === null ? 0 : at - checked.sent;
    const kind = checked.client || (CLIENTS.includes(client) ? client : 'computer');
    const cleared = readTimeClear(db);
    let accepted = 0;
    db.transaction(() => {
      for (const beat of checked.beats) {
        const when = Math.round(beat.at + skew);
        if (when < at - DAY || when > at + 60 * 1000 || (cleared && when <= cleared.at)) continue;
        const { day, hour, start } = hourOf(when);
        add({ day, hour, start, client: kind, surface: beat.surface, kind: beat.kind, task: beat.task, session: beat.session }, { page: beat.seconds });
        accepted += 1;
      }
    })();
    if (accepted) usageTimeChanged(db);
    return { ok: true, accepted, enabled: true };
  }

  // The session clocks (services/usage-time-clock.js): seconds of one session in one hour. Not stored while the switch is off.
  function recordSession({ at, task, session, kind, working = 0, waiting = 0, waits = [] }) {
    if (!recording()) return false;
    const refs = cleanRefs(task, session);
    if (!refs || (!working && !waiting && !waits.length)) return false;
    const cleared = readTimeClear(db);
    if (cleared && at <= cleared.at) return false;
    const { day, hour, start } = hourOf(at);
    db.transaction(() => add({ day, hour, start, kind: KINDS.includes(kind) ? kind : 'terminal', task: refs.task, session: refs.session }, { working, waiting, waits }))();
    usageTimeChanged(db);
    return true;
  }

  // ---- Retention and Clear ----
  function prune() {
    const before = now() - RETENTION_DAYS * DAY;
    keepSeq(db);
    return { time: db.prepare('DELETE FROM usage_time WHERE start < ?').run(before).changes };
  }
  // Clear of the time tab: every row goes here, and the clear mark travels with the sync (every linked engine deletes the rows of the hours up to it).
  function clearTime() {
    let cleared = 0;
    db.transaction(() => {
      keepSeq(db);
      cleared = db.prepare('DELETE FROM usage_time').run().changes;
      writeTimeClear(db, { at: now(), by: '', seq: nextSeq(db) });
    })();
    usageTimeChanged(db);
    return { cleared };
  }

  // ---- Names ----
  function engineName(stored) {
    const me = self();
    if (!stored || stored === me.instance_id) return me.name || null;
    const names = readNames(db);
    if (typeof names[stored] === 'string') return names[stored];
    const peer = (linked ? linked() : []).find(item => item.instanceId === stored);
    return peer ? peer.name : null;
  }
  // The title of an engine-neutral task id: this engine's task list, else the last list read from a linked engine (as the page shows it).
  function taskTitle(task) {
    if (!task) return null;
    if (titles) { try { return titles(task); } catch { return null; } }
    return defaultTitle(db, self().instance_id, task);
  }
  function sessionTitle(session) {
    if (!session) return null;
    const [instance, taskId, terminal] = session.split('|');
    if (instance !== self().instance_id) return null;
    try {
      const row = db.prepare('SELECT title FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(Number(taskId), terminal);
      return row ? row.title || null : (terminal === 'default' ? 'Terminal 1' : null);
    } catch { return null; }
  }

  // ---- Queries ----
  const RANGES = ['today', 'week', '30d'];
  // { range, since, until, prevSince, prevUntil, tz } for today / this week (from Monday) / the last 30 days, in the zone.
  function rangeOf(range, tz) {
    const at = now();
    const zone = zoneOf(tz);
    const midnight = localMidnight(at, zone);
    let since;
    let prevSince;
    let prevUntil;
    if (range === 'today') { since = midnight; prevSince = midnightPlus(midnight, -1, zone); prevUntil = prevSince + (at - since); }
    else if (range === 'week') { const weekday = partsIn(at, zone).weekday; since = midnightPlus(midnight, 1 - weekday, zone); prevSince = midnightPlus(since, -7, zone); prevUntil = prevSince + (at - since); }
    else { since = midnightPlus(midnight, -29, zone); prevSince = midnightPlus(since, -30, zone); prevUntil = since; }
    return { range, since, until: at, prevSince, prevUntil, tz: zone };
  }
  function deviceFilter(device) {
    if (device === null || device === undefined || device === '' || device === 'all') return null;
    const me = self().instance_id;
    return device === me ? '' : device;
  }
  const rowsBetween = (since, until, device, extra = '', args = []) => {
    const engine = deviceFilter(device);
    const where = ['start >= ?', 'start < ?'];
    const values = [Math.floor(since / HOUR) * HOUR, until];
    if (engine !== null) { where.push('engine = ?'); values.push(engine); }
    if (extra) { where.push(extra); values.push(...args); }
    return db.prepare(`SELECT * FROM usage_time WHERE ${where.join(' AND ')}`).all(...values);
  };
  const sum = (rows, pick) => rows.reduce((total, row) => total + pick(row), 0);
  const learnOf = row => (row.surface === 'learn' ? row.page_s : 0);
  // Agent seconds while no page was active: per hour, the working seconds times the part of that hour without page time (on any device).
  function awayWorking(rows) {
    const hours = new Map();
    for (const row of rows) {
      const entry = hours.get(row.start) || { page: 0, working: 0 };
      entry.page += row.page_s;
      entry.working += row.working_s;
      hours.set(row.start, entry);
    }
    let away = 0;
    for (const { page, working } of hours.values()) away += working * (1 - Math.min(1, page / 3600));
    return Math.round(away);
  }
  function totals(rows) {
    const hist = emptyHist();
    for (const row of rows) parseHist(row.waits).forEach((n, i) => { hist[i] += n; });
    return { page_s: sum(rows, row => row.page_s), working_s: sum(rows, row => row.working_s), waiting_s: sum(rows, row => row.waiting_s), learn_s: sum(rows, learnOf), hist };
  }
  function byTask(rows) {
    const tasks = new Map();
    for (const row of rows) {
      if (!row.task) continue;
      const entry = tasks.get(row.task) || { task: row.task, looked_s: 0, worked_s: 0, waiting_s: 0 };
      entry.looked_s += row.page_s;
      entry.worked_s += row.working_s;
      entry.waiting_s += row.waiting_s;
      tasks.set(row.task, entry);
    }
    return [...tasks.values()].sort((a, b) => (b.looked_s + b.worked_s) - (a.looked_s + a.worked_s) || a.task.localeCompare(b.task))
      .map(entry => ({ task: entry.task, title: taskTitle(entry.task), looked_s: entry.looked_s, worked_s: entry.worked_s, waiting_s: entry.waiting_s }));
  }
  function bySession(rows) {
    const sessions = new Map();
    for (const row of rows) {
      if (!row.session) continue;
      const entry = sessions.get(row.session) || { session: row.session, kind: row.kind || null, looked_s: 0, worked_s: 0, waiting_s: 0 };
      if (!entry.kind && row.kind) entry.kind = row.kind;
      entry.looked_s += row.page_s;
      entry.worked_s += row.working_s;
      entry.waiting_s += row.waiting_s;
      sessions.set(row.session, entry);
    }
    return [...sessions.values()].sort((a, b) => (b.looked_s + b.worked_s) - (a.looked_s + a.worked_s) || a.session.localeCompare(b.session))
      .map(entry => ({ session: entry.session, title: sessionTitle(entry.session), kind: entry.kind, looked_s: entry.looked_s, worked_s: entry.worked_s, waiting_s: entry.waiting_s }));
  }
  // The engines of the device chip: this one, the linked ones (whether they record time, from their /v1/info) and any other engine with rows here.
  function devices() {
    const me = self();
    const list = [{ id: me.instance_id, name: me.name || null, self: true, supported: true }];
    const seen = new Set([me.instance_id]);
    for (const peer of linked ? linked() : []) {
      if (!peer.instanceId || seen.has(peer.instanceId)) continue;
      seen.add(peer.instanceId);
      list.push({ id: peer.instanceId, name: peer.name || null, self: false, supported: typeof peer.supported === 'boolean' ? peer.supported : null });
    }
    for (const engine of db.prepare("SELECT DISTINCT engine FROM usage_time WHERE engine != ''").pluck().all()) {
      if (seen.has(engine)) continue;
      seen.add(engine);
      list.push({ id: engine, name: engineName(engine), self: false, supported: true });
    }
    return list;
  }

  // GET /api/usage-time/summary?range=today|week|30d&device=all|<instance id>&tz=
  function summary({ range = 'week', device = 'all', tz = null } = {}) {
    if (!RANGES.includes(range)) throw fault('INVALID_USAGE_TIME_QUERY', 400);
    if (device !== 'all' && device !== null && device !== undefined && device !== '' && !INSTANCE_ID.test(String(device))) throw fault('INVALID_USAGE_TIME_QUERY', 400);
    const window = rangeOf(range, tz);
    const rows = rowsBetween(window.since, window.until, device);
    const before = rowsBetween(window.prevSince, window.prevUntil, device);
    const current = totals(rows);
    const previous = totals(before);
    // Each local day of the range, split into sessions / learn / other page time.
    const days = [];
    for (let start = window.since; start < window.until; start = midnightPlus(start, 1, window.tz)) days.push({ day: localDay(start, window.tz), sessions_s: 0, learn_s: 0, other_s: 0 });
    const dayIndex = new Map(days.map((entry, index) => [entry.day, index]));
    const learnDays = new Set();
    for (const row of rows) {
      if (!row.page_s) continue;
      const day = localDay(Math.max(row.start, window.since), window.tz);
      const entry = days[dayIndex.get(day)];
      if (!entry) continue;
      if (row.surface === 'sessions') entry.sessions_s += row.page_s;
      else if (row.surface === 'learn') { entry.learn_s += row.page_s; learnDays.add(day); } else entry.other_s += row.page_s;
    }
    const kinds = new Map();
    for (const row of rows) if (row.kind) kinds.set(row.kind, (kinds.get(row.kind) || 0) + row.page_s + row.working_s);
    const kindTotal = [...kinds.values()].reduce((a, b) => a + b, 0);
    return {
      range, since: window.since, until: window.until, tz: window.tz, device: device && device !== '' ? device : 'all', enabled: recording(),
      tiles: {
        page_s: current.page_s, working_s: current.working_s, waiting_s: current.waiting_s, learn_s: current.learn_s,
        page_delta: current.page_s - previous.page_s, working_delta: current.working_s - previous.working_s,
        waiting_delta: current.waiting_s - previous.waiting_s, learn_delta: current.learn_s - previous.learn_s,
        median_wait_s: medianOf(current.hist), learn_days: learnDays.size, days_in_range: days.length, away_working_s: awayWorking(rows),
      },
      days,
      tasks: byTask(rows).slice(0, 50),
      kinds: kindTotal ? [...kinds].map(([kind, seconds]) => ({ kind, share: Math.round((seconds / kindTotal) * 100) / 100 })).sort((a, b) => b.share - a.share || a.kind.localeCompare(b.kind)) : [],
      devices: devices(),
      data: data(),
    };
  }
  // GET /api/usage-time/task?task=&range=&device=&tz=: the sessions of one task.
  function task({ task: id, range = 'week', device = 'all', tz = null } = {}) {
    if (typeof id !== 'string' || !TASK.test(id) || !RANGES.includes(range)) throw fault('INVALID_USAGE_TIME_QUERY', 400);
    const window = rangeOf(range, tz);
    const rows = rowsBetween(window.since, window.until, device, 'task = ?', [id]);
    const all = totals(rows);
    return { task: id, title: taskTitle(id), range, since: window.since, until: window.until, looked_s: all.page_s, worked_s: all.working_s, waiting_s: all.waiting_s, sessions: bySession(rows) };
  }
  // GET /api/usage-time/day?day=YYYY-MM-DD&device=&tz=: that local day's tasks, each with its sessions.
  function day({ day: date, device = 'all', tz = null } = {}) {
    if (typeof date !== 'string' || !DAY_TEXT.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) throw fault('INVALID_USAGE_TIME_QUERY', 400);
    const zone = zoneOf(tz);
    const since = localMidnight(Date.parse(`${date}T12:00:00Z`), zone);
    if (localDay(since, zone) !== date) throw fault('INVALID_USAGE_TIME_QUERY', 400);
    const until = midnightPlus(since, 1, zone);
    const rows = rowsBetween(since, until, device);
    const all = totals(rows);
    const tasks = byTask(rows).map(entry => ({ ...entry, sessions: bySession(rows.filter(row => row.task === entry.task)) }));
    const surfaces = Object.fromEntries(SURFACES.map(name => [name, sum(rows.filter(row => row.surface === name), row => row.page_s)]));
    return { day: date, since, until, tz: zone, page_s: all.page_s, worked_s: all.working_s, waiting_s: all.waiting_s, surfaces, tasks };
  }
  function data() {
    const row = db.prepare('SELECT COUNT(*) AS n, MIN(start) AS first FROM usage_time').get();
    return { count: row.n, first_at: row.first === null ? null : row.first, retention_days: RETENTION_DAYS };
  }

  // ---- Export ----
  const exportColumns = ['day', 'hour', 'start', 'engine', 'engine_name', 'client', 'surface', 'kind', 'task', 'session', 'page_s', 'working_s', 'waiting_s'];
  function exportRow(row) {
    const me = self();
    return {
      day: row.day, hour: row.hour, start: new Date(row.start).toISOString(), engine: row.engine || me.instance_id, engine_name: engineName(row.engine),
      client: orNull(row.client), surface: orNull(row.surface), kind: orNull(row.kind), task: orNull(row.task), session: orNull(row.session),
      page_s: row.page_s, working_s: row.working_s, waiting_s: row.waiting_s,
    };
  }
  // Every row of the time tab, in pieces (`write`), as JSON or CSV.
  function exportTime(write, format = 'json', rows = null) {
    const source = rows || db.prepare('SELECT * FROM usage_time ORDER BY start, uid').iterate();
    if (format === 'csv') {
      write(`${exportColumns.join(',')}\n`);
      for (const row of source) write(`${csvLine(exportColumns.map(column => exportRow(row)[column]))}\n`);
      return;
    }
    write(`{"exported_at":${JSON.stringify(new Date(now()).toISOString())},"retention_days":${RETENTION_DAYS},"time":[`);
    let first = true;
    for (const row of source) { write(`${first ? '' : ','}${JSON.stringify(exportRow(row))}`); first = false; }
    write(']}');
  }

  return {
    db, settings, setSettings, recording, digestOn, recordBeats, recordSession, prune, clearTime, summary, task, day, data, devices, exportTime, exportRow,
    taskTitle, sessionTitle, engineName, rangeOf, self,
  };
}

// A CSV line: quoted where needed, formula-looking cells prefixed with a quote so a spreadsheet does not run them.
function csvLine(values) {
  return values.map(value => {
    if (value === null || value === undefined) return '';
    let text = String(value);
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(',');
}

// The title of a task id from this database: this engine's tasks, else the cached task list of the linked engine with that instance id.
function defaultTitle(db, selfId, task) {
  const [instance, id] = task.split('|');
  if (instance === selfId) {
    const row = db.prepare('SELECT title FROM tasks WHERE id = ?').get(Number(id));
    return row ? row.title || null : null;
  }
  try {
    const { remoteInstanceIds } = require('./engine-name');
    const serverId = [...remoteInstanceIds(db)].find(([, value]) => value === instance);
    if (!serverId) return null;
    const known = require('./linked-last-tasks').createLinkedLastTasks({ db }).lastKnown(serverId[0]);
    const hit = known && known.tasks.find(item => String(item.id) === id);
    return hit ? hit.title : null;
  } catch { return null; }
}

// Deletes old rows at start and once a day (an unref'd timer).
function startRetention(service, { every = DAY } = {}) {
  const run = () => { try { service.prune(); } catch (error) { console.warn(`Usage time: could not delete old rows (${error.message})`); } };
  run();
  const timer = setInterval(run, every);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

// The settings sync groups usage-time-record and usage-memories-digest (services/settings-sync.js): { enabled } once set, else null (the default).
const switchSync = (read, write) => ({
  exportForSync: ({ db }) => { const stored = read(db); return isPlainObject(stored) && typeof stored.enabled === 'boolean' ? { enabled: stored.enabled } : null; },
  importFromSync: ({ db }, owner, value) => {
    if (value !== null && !(isPlainObject(value) && typeof value.enabled === 'boolean')) throw Object.assign(new Error('INVALID_SYNC_VALUE'), { statusCode: 400 });
    write(db, value && { enabled: value.enabled });
  },
});
const recordSync = switchSync(db => readState(db, RECORD_KEY), (db, value) => writeState(db, RECORD_KEY, value));
const digestSync = switchSync(db => readState(db, DIGEST_KEY), (db, value) => writeState(db, DIGEST_KEY, value));

module.exports = {
  createUsageTime, startRetention, checkBeats, cleanRefs, csvLine, defaultTitle,
  nextSeq, maxSeq, keepSeq, newUid, usageTimeChanged, onUsageTimeChanged, readTimeClear, readMemoriesClear, writeTimeClear, writeMemoriesClear, readNames, writeNames,
  parseHist, medianOf, bucketOf, hourOf, zoneOf, partsIn, localDay, localMidnight, midnightPlus, isoWeek, weekStart,
  recordSync, digestSync,
  DAY, HOUR, RETENTION_DAYS, MAX_BEATS, MAX_BEAT_SECONDS, MAX_ROW_SECONDS, SURFACES, KINDS, CLIENTS, INSTANCE_ID, TASK, SESSION, WAIT_EDGES, int, blank, orNull,
  RECORD_KEY, DIGEST_KEY, SEQ_KEY, TIME_CLEAR_KEY, MEMORIES_CLEAR_KEY, NAMES_KEY, RECORD_GROUP, DIGEST_GROUP,
};
