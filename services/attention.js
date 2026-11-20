// T-Attention (attention hub): one central list of work items that agents, services and the person create and update.
// Tables attention_items, attention_events and attention_tokens (db/schema.sql, schema 9; parent_id, custom_status and result since schema 11).
// Self-contained: it never reads or changes tasks, terminals or chats.
//
// - Tree: parent_id names another item (or null). An unknown parent or one that would make a cycle is refused and nothing is applied; an item
//   with children cannot be deleted (409 HAS_CHILDREN). Statuses of parents and children are independent. A body may give parent_ref (an
//   external_ref) instead of parent_id; it is resolved inside the transaction.
// - Order: inside a status group (GROUPS: waiting_user, review, working, todo, finished = done | failed | cancelled) items are shown by
//   sort_order DESC, then id DESC. move() places an item (and its descendants in the same group) before / after another item of the group or at
//   its top / bottom, optionally changing its status in the same transaction, and renumbers the group where needed.
//
// - Every change writes its event row in the same transaction and is then published on the in-process bus: onChange(fn) -> unsubscribe,
//   fn({ kind: 'created' | 'updated' | 'deleted', item, previous, event }). Notifiers and the SSE stream subscribe to it.
// - A change that changes nothing (a listener sending the same state again) writes no event, keeps updated_at and is not published.
// - completed_at is set when the status becomes done / failed / cancelled and cleared when it leaves them.
// - context (a JSON object, at most 32 KiB) is merged shallowly: a key set to null removes it. Its text values are cut to their limits (they come
//   from prompts and replies), other wrong values are refused. Events record only the names of the context keys that changed.
// - activity ({kind, text}) on a create / update is stored as an 'activity' event in the same transaction, for the timeline.
// - excerpt (the end of a session transcript, at most 8 KiB) is never stored or published: only in-process subscribers of onChangeInternal
//   (the AI summary) get it with the change.
// - Tokens ('tatt_' + 32 random bytes base64url) are stored as sha256 hashes only; the token itself is returned once, at creation.
// - Terminal tokens (the same format) are made for each shell T-Agent starts (routes/terminal.js: TA_ATTENTION_TOKEN) and live in memory only,
//   as sha256 hashes: they are not in attention_tokens, not in the token list, and end when the terminal closes or the server stops (the
//   shells end with it, so a server start never finds one left over).
// - Pairing codes (6 digits, 10 minutes, one at a time, single use) let another machine get a normal token: createPairing on the page,
//   claimPairing from `t-attention pair`. They live in memory only, as sha256 hashes; too many wrong codes end the active one.
// - Schedules (schema 18, "Scheduled and recurring tasks" in docs/design/attention-schedules.md): schedule, then_action, next_at, schedule_state, runs,
//   last_fired_at and last_done_at. Saving a schedule computes next_at (services/attention-schedule.js); fireDue() (the timer of
//   services/attention-scheduler.js, on this engine only) and runNow() fire an item: the firing is written in one transaction before it is published,
//   so a firing is never notified twice, also across a restart. A recurring item that is done goes back to To do for its next time (one row).
const crypto = require('crypto');
const scheduling = require('./attention-schedule');

const STATUSES = Object.freeze(['todo', 'working', 'waiting_user', 'review', 'done', 'failed', 'cancelled']);
const FINISHED = new Set(['done', 'failed', 'cancelled']);
const PRIORITIES = Object.freeze(['high', 'medium', 'low', 'none']);
const ACTIVITY_KINDS = Object.freeze(['prompt', 'permission', 'question', 'resumed', 'turn_end', 'error', 'session_end', 'note']);
const PENDING_KINDS = Object.freeze(['permission', 'question', 'error']);
const LIMITS = Object.freeze({ customStatus: 100, result: 500, contextBytes: 32768, excerptBytes: 8192, activityText: 500, contextFiles: 50, summaryText: 600, title: 300, notes: 20000, externalRef: 200, attentionReason: 500, linkUrl: 2000, linkLabel: 200, source: 64, metaBytes: 8192, tokenName: 80, listDefault: 200, listMax: 1000, events: 100 });
// The fields a create / update body may carry. Anything else in a body is ignored (newer callers may send more).
const FIELDS = ['title', 'notes', 'status', 'priority', 'due_date', 'source', 'external_ref', 'attention_reason', 'link_url', 'link_label', 'meta', 'sort_order', 'parent_id', 'custom_status', 'result', 'schedule', 'then_action'];
// The JSON columns of an item (returned parsed).
const JSON_FIELDS = new Set(['meta', 'schedule', 'then_action']);
// The schedule columns the server keeps (not settable by a body): the next fire time, waiting | due, and the history of the runs.
const SCHEDULE_COLUMNS = ['next_at', 'schedule_state', 'runs', 'last_fired_at', 'last_done_at'];
// The note a prompt firing leaves when it could not send (English; Chinese in public/js/i18n-zh-server.js). {1} is HH:mm on the owner engine.
const PROMPT_NOTES = {
  busy: time => `The session was busy at ${time}; the prompt was not sent`,
  stopped: time => `The session was not running at ${time}; the prompt was not sent`,
  gone: time => `The session was not found at ${time}; the prompt was not sent`,
};
// The notes a script run leaves when it did not end well ({1}: its exit status or minutes, then HH:mm).
const SCRIPT_NOTES = {
  exit: (exit, time) => `Script failed (exit ${exit}) at ${time}`,
  timeout: (minutes, time) => `Script stopped after ${minutes} min at ${time}`,
  ended: (_, time) => `Script stopped at ${time}`,
  start: (_, time) => `Script could not start at ${time}`,
};
// A note of a firing (cleared again when a later run goes well or the run is done).
const PROMPT_NOTE = /^(The session was (busy|not running|not found) at \d\d:\d\d; the prompt was not sent|Script (failed \(exit \d+\)|stopped after \d+ min|stopped|could not start) at \d\d:\d\d)$/;
// The script terminals one item keeps (older ones are removed when a run starts).
const SCRIPT_RUNS_KEPT = 5;
// The groups an item is shown and ordered in (the page's sections; "Needs you" shows waiting_user and review). A move stays inside one group.
const GROUPS = Object.freeze(['waiting_user', 'review', 'working', 'todo', 'finished']);
const groupOf = status => (FINISHED.has(status) ? 'finished' : status);
const statusesOf = group => (group === 'finished' ? [...FINISHED] : [group]);
const OPEN_STATUSES = Object.freeze(STATUSES.filter(status => !FINISHED.has(status)));
const TOKEN_PATTERN = /^tatt_[A-Za-z0-9_-]{43}$/;
// Control characters other than tab, line feed and carriage return.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const CONTROL_OR_BREAK = /[\u0000-\u001f\u007f]/;

class AttentionError extends Error {
  constructor(code, message, statusCode = 400, extra = {}) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    Object.assign(this, extra);
  }
}

const invalid = message => new AttentionError('VALIDATION_FAILED', message);
const hashToken = token => crypto.createHash('sha256').update(String(token)).digest('hex');

// Each validator gets the raw body value and returns the stored value. Optional text fields take '' or null as "none".
function text(name, max, { required = false, singleLine = false } = {}) {
  return value => {
    if (value === undefined || value === null || (value === '' && !required)) {
      if (required) throw invalid(`${name} cannot be empty`);
      return null;
    }
    if (typeof value !== 'string') throw invalid(`${name} must be text`);
    const trimmed = singleLine ? value.trim() : value;
    if (required && !trimmed.trim()) throw invalid(`${name} cannot be empty`);
    if (!trimmed) return null;
    if (trimmed.length > max) throw invalid(`${name} cannot exceed ${max} characters`);
    if ((singleLine ? CONTROL_OR_BREAK : CONTROL).test(trimmed)) throw invalid(singleLine ? `${name} cannot contain line breaks or control characters` : `${name} contains disallowed control characters`);
    return trimmed;
  };
}

function oneOf(name, values) {
  return value => {
    if (typeof value !== 'string' || !values.includes(value)) throw invalid(`${name} must be one of: ${values.join(', ')}`);
    return value;
  };
}

function dueDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid('due_date must be a date in the form YYYY-MM-DD');
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw invalid('due_date must be a date in the form YYYY-MM-DD');
  return value;
}

// http(s) addresses without credentials, or a page path of this app ('/...', not '//host' and no backslash).
function linkUrl(value) {
  const url = text('link_url', LIMITS.linkUrl, { singleLine: true })(value);
  if (url === null) return null;
  if (url.startsWith('/')) {
    if (url.startsWith('//') || url.includes('\\')) throw invalid('link_url must be an http(s) address or a page path starting with /');
    return url;
  }
  let parsed;
  try { parsed = new URL(url); } catch { throw invalid('link_url must be an http(s) address or a page path starting with /'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw invalid('link_url must be an http(s) address or a page path starting with /');
  if (parsed.username || parsed.password) throw invalid('link_url cannot contain a user name or password');
  return url;
}

function meta(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('meta must be a JSON object');
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > LIMITS.metaBytes) throw invalid(`meta cannot exceed ${LIMITS.metaBytes} bytes of JSON`);
  return json;
}

function sortOrder(value) {
  if (!Number.isSafeInteger(value)) throw invalid('sort_order must be an integer');
  return value;
}

// A task id: a positive integer (a JSON number, or digits in a string).
function idValue(value) {
  if (typeof value === 'string' && /^\d{1,15}$/.test(value.trim())) value = Number(value.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parentId(value) {
  if (value === undefined || value === null || value === '') return null;
  const id = idValue(value);
  if (id === null) throw invalid('parent_id must be a task id');
  return id;
}

function source(value) {
  const name = text('source', LIMITS.source, { singleLine: true })(value);
  if (name === null) return null;
  if (!/^[A-Za-z0-9._:@-]+$/.test(name)) throw invalid('source may only contain letters, digits and . _ : @ -');
  return name;
}

const VALIDATORS = {
  title: text('title', LIMITS.title, { required: true, singleLine: true }),
  notes: text('notes', LIMITS.notes),
  status: oneOf('status', STATUSES),
  priority: oneOf('priority', PRIORITIES),
  due_date: dueDate,
  source,
  external_ref: text('external_ref', LIMITS.externalRef, { singleLine: true }),
  attention_reason: text('attention_reason', LIMITS.attentionReason),
  link_url: linkUrl,
  link_label: text('link_label', LIMITS.linkLabel, { singleLine: true }),
  meta,
  sort_order: sortOrder,
  parent_id: parentId,
  custom_status: text('custom_status', LIMITS.customStatus, { singleLine: true }),
  result: text('result', LIMITS.result, { singleLine: true }),
  // Checked here, made canonical in the transaction (resolveSchedule: the zone and the first day of an older value are kept when they are not sent).
  schedule: value => ({ raw: value, checked: scheduleCheck(value) }),
  then_action: value => { const action = scheduleCall(() => scheduling.normalizeThenAction(value)); return action ? JSON.stringify(action) : null; },
};
// A schedule error as the service's 400.
function scheduleCall(fn) {
  try { return fn(); } catch (error) { if (error instanceof scheduling.ScheduleError) throw invalid(error.message); throw error; }
}
function scheduleCheck(value) {
  return scheduleCall(() => scheduling.normalizeSchedule(value, { tz: 'UTC', starts: '2000-01-01' }));
}

// The fields present in a body, validated. Unknown fields are ignored; a body that is not an object is refused.
function readFields(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('The request body must be a JSON object');
  const out = {};
  // context, activity and excerpt are read by readBody.
  for (const field of FIELDS) if (Object.prototype.hasOwnProperty.call(body, field)) out[field] = VALIDATORS[field](body[field]);
  // parent_ref: the parent named by its external_ref, resolved to parent_id inside the transaction ('' or null: no parent).
  if (Object.prototype.hasOwnProperty.call(body, 'parent_ref')) {
    if (Object.prototype.hasOwnProperty.call(body, 'parent_id')) throw invalid('Give parent_id or parent_ref, not both');
    const ref = text('parent_ref', LIMITS.externalRef, { singleLine: true })(body.parent_ref);
    out.parent_id = ref === null ? null : { ref };
  }
  return out;
}

// Context values. Text is cut to its limit (it comes from prompts, replies and tool input) after control characters other than tab and line
// breaks are dropped; a wrong type or an unknown enum value is refused.
function clip(name, max) {
  return value => {
    if (typeof value !== 'string') throw invalid(`context.${name} must be text`);
    return value.replace(new RegExp(CONTROL.source, 'g'), '').slice(0, max);
  };
}
function isoTime(name) {
  return value => {
    if (typeof value !== 'string' || value.length > 40 || Number.isNaN(Date.parse(value))) throw invalid(`context.${name} must be an ISO 8601 time`);
    return value;
  };
}
function count(name) {
  return value => {
    if (!Number.isSafeInteger(value) || value < 0) throw invalid(`context.${name} must be a whole number of 0 or more`);
    return value;
  };
}
function plainObject(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${name ? `context.${name}` : 'context'} must be a JSON object`);
  return value;
}
// Known keys of an object value: missing optional keys are left out, unknown keys are dropped.
function shape(name, parts, { nullable = true, required = [] } = {}) {
  return value => {
    if (value === null && nullable) return null;
    plainObject(name, value);
    const out = {};
    for (const [key, check] of Object.entries(parts)) {
      if (value[key] === undefined || value[key] === null) {
        if (required.includes(key)) throw invalid(`context.${name}.${key} is required`);
        continue;
      }
      out[key] = check(value[key]);
    }
    return out;
  };
}
const CONTEXT_KEYS = {
  goal: clip('goal', 2000),
  latest_prompt: clip('latest_prompt', 2000),
  last_reply: clip('last_reply', 2000),
  pending: shape('pending', {
    kind: value => { if (!PENDING_KINDS.includes(value)) throw invalid(`context.pending.kind must be one of: ${PENDING_KINDS.join(', ')}`); return value; },
    text: clip('pending.text', 1000), tool: clip('pending.tool', 200), command: clip('pending.command', 1000),
  }, { required: ['kind'] }),
  files: value => {
    if (!Array.isArray(value)) throw invalid('context.files must be a list');
    return value.slice(0, LIMITS.contextFiles).map(entry => shape('files', { path: clip('files.path', 1000), added: count('files.added'), deleted: count('files.deleted') }, { nullable: false, required: ['path'] })(entry));
  },
  cwd: clip('cwd', 1000),
  branch: clip('branch', 200),
  host: clip('host', 200),
  started_at: isoTime('started_at'),
  turn_started_at: isoTime('turn_started_at'),
  turns: count('turns'),
  session: shape('session', { agent: clip('session.agent', 32), id: clip('session.id', 200), resume: clip('session.resume', 2000) }, { nullable: false }),
  tagent: shape('tagent', { task_id: clip('tagent.task_id', 64), terminal_id: clip('tagent.terminal_id', 64) }),
  summary: shape('summary', { text: clip('summary.text', LIMITS.summaryText), at: isoTime('summary.at'), model: clip('summary.model', 80) }, { required: ['text'] }),
};
// A context patch: { key: value | null }, null removes the key. Unknown keys are dropped.
function contextPatch(value) {
  if (value === undefined) return undefined;
  if (value === null) return null; // clears the whole context
  plainObject('', value);
  const patch = {};
  for (const [key, check] of Object.entries(CONTEXT_KEYS)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    patch[key] = value[key] === null ? null : check(value[key]);
  }
  return patch;
}
function mergeContext(current, patch) {
  if (patch === undefined) return current;
  if (patch === null) return null;
  const next = { ...(current || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]; else next[key] = value;
  }
  if (!Object.keys(next).length) return null;
  if (Buffer.byteLength(JSON.stringify(next), 'utf8') > LIMITS.contextBytes) throw invalid(`context cannot exceed ${LIMITS.contextBytes} bytes of JSON`);
  return next;
}
function activity(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('activity must be a JSON object');
  if (!ACTIVITY_KINDS.includes(value.kind)) throw invalid(`activity.kind must be one of: ${ACTIVITY_KINDS.join(', ')}`);
  const textValue = value.text === undefined || value.text === null ? '' : value.text;
  if (typeof textValue !== 'string') throw invalid('activity.text must be text');
  return { kind: value.kind, text: textValue.replace(new RegExp(CONTROL.source, 'g'), '').slice(0, LIMITS.activityText) };
}
// The end of the session transcript: the last 8 KiB are kept (in memory only).
function excerpt(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw invalid('excerpt must be text');
  const clean = value.replace(new RegExp(CONTROL.source, 'g'), '');
  const bytes = Buffer.from(clean, 'utf8');
  if (bytes.length <= LIMITS.excerptBytes) return clean;
  return bytes.subarray(bytes.length - LIMITS.excerptBytes).toString('utf8').replace(/^\uFFFD+/, ''); // a cut character at the start is dropped
}
// The whole body: the stored fields, the context patch, the activity entry and the excerpt. tagent: the T-Agent terminal of the terminal
// token that sends it (verifyToken), or null; see tieToTerminal.
function readBody(body, tagent = null) {
  const fields = readFields(body);
  return { fields, context: contextPatch(body.context), activity: activity(body.activity), excerpt: excerpt(body.excerpt), plainTurnEnd: body.plain_turn_end === true, tagent };
}
// A write with a terminal token ties the item to that terminal: context.tagent is set from the token when the item has none and the patch does
// not name it (also not to remove it) and does not clear the whole context. An existing tagent is never overwritten. Returns the context patch.
function tieToTerminal(patch, current, tagent) {
  if (!tagent || patch === null || (current && current.tagent)) return patch;
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'tagent')) return patch;
  return { ...(patch || {}), tagent: { task_id: tagent.task_id, terminal_id: tagent.terminal_id } };
}
const parseJson = value => { if (!value) return null; try { return JSON.parse(value); } catch { return null; } };
const contextKeysChanged = (before, after) => [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
  .filter(key => JSON.stringify((before || {})[key]) !== JSON.stringify((after || {})[key])).sort();

// An item as every answer, stream and copy carries it: the JSON columns parsed, and schedule_text (the schedule in one English sentence).
function rowToItem(row) {
  if (!row) return null;
  const schedule = parseJson(row.schedule);
  const item = { ...row, meta: parseJson(row.meta), context: parseJson(row.context) };
  if (Object.prototype.hasOwnProperty.call(row, 'schedule')) {
    item.schedule = schedule;
    item.then_action = parseJson(row.then_action);
    item.schedule_text = schedule ? scheduling.describe(schedule) : null;
    // The script runs of the item, oldest first, at most SCRIPT_RUNS_KEPT: { terminal_id, at, ended_at?, outcome?, exit?, duration_ms? }.
    item.script_runs = Array.isArray(parseJson(row.script_runs)) ? parseJson(row.script_runs) : [];
    // The exit status of the last script run that ended (null: none yet, or it was stopped: the time limit, a terminal that ended first).
    const ended = item.script_runs.filter(run => run && run.ended_at);
    item.last_exit = ended.length && Number.isInteger(ended[ended.length - 1].exit) && ended[ended.length - 1].outcome === 'exit' ? ended[ended.length - 1].exit : null;
  }
  return item;
}

// The statuses a list is asked for ('a,b' or an array), [] for none.
function statusList(status) {
  if (status === undefined || status === null || status === '') return [];
  return (Array.isArray(status) ? status : String(status).split(',')).map(value => String(value).trim()).filter(Boolean);
}

// recentFinished of a list (`recent_finished` of GET /api/attention and /v1/attention): how many of the items finished last the list also returns,
// or null: not asked for, or a list that decides about finished items itself (a status filter, includeDone). The routes put the number into
// their answer, so a caller knows that the list has them; a service older than this parameter ignores it and answers without the number.
function recentFinishedOf({ status, includeDone = false, recentFinished } = {}) {
  if (recentFinished === undefined || recentFinished === null || recentFinished === '') return null;
  const count = Number(recentFinished);
  if (!Number.isInteger(count) || count < 1) throw invalid(`recent_finished must be an integer between 1 and ${LIMITS.listMax}`);
  return includeDone || statusList(status).length ? null : Math.min(count, LIMITS.listMax);
}

function rowToEvent(row) {
  if (!row) return null;
  let data = null;
  if (row.data) { try { data = JSON.parse(row.data); } catch { data = null; } }
  return { ...row, data };
}

const PAIRING = Object.freeze({ ttlMs: 10 * 60 * 1000, maxFailures: 20 });

// The address a paired machine is given: an http(s) origin without user name, password, query or fragment.
function pairingUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch { throw invalid('origin must be the http(s) address of this page'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw invalid('origin must be the http(s) address of this page');
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
}

// scopes (attention_tokens.scopes, space separated): extra permissions; 'market' = "Can manage plugins" (/api/attention/market). Off by default.
const TOKEN_SCOPES = Object.freeze(['market']);
const scopesOf = row => String((row && row.scopes) || '').split(/\s+/).filter(scope => TOKEN_SCOPES.includes(scope));
const tokenView = row => ({ id: row.id, name: row.name, created_at: row.created_at, last_used_at: row.last_used_at, revoked_at: row.revoked_at, market: scopesOf(row).includes('market') });

// Schema 11: the tree and outcome columns of attention_items (db/index.js runs this at start; the service runs it too, for a database made
// from an older schema.sql). parent_id refers to another item; deleting a parent that still has children is refused (the service answers 409
// before the database would).
function ensureTreeColumns(db) {
  const columns = db.prepare('PRAGMA table_info(attention_items)').all().map(column => column.name);
  if (!columns.includes('parent_id')) db.exec('ALTER TABLE attention_items ADD COLUMN parent_id INTEGER REFERENCES attention_items(id)');
  if (!columns.includes('custom_status')) db.exec('ALTER TABLE attention_items ADD COLUMN custom_status TEXT');
  if (!columns.includes('result')) db.exec('ALTER TABLE attention_items ADD COLUMN result TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_attention_items_parent ON attention_items (parent_id)');
  // The items finished last (list with recentFinished). db/schema.sql makes it at every start; here for a database made from an older schema.sql.
  // An index only: no schema generation, an older version reads and writes the table as before.
  db.exec('CREATE INDEX IF NOT EXISTS idx_attention_items_completed ON attention_items (completed_at)');
}

// Schema 18: the schedule columns of attention_items (db/index.js runs this at start, the service too). Nullable columns and runs with a default, so the
// items of an older database simply have no schedule; any lower schema works. The index on next_at is made here, not in schema.sql (which runs before
// the column exists on an older database): the timer reads the items due from it.
function ensureScheduleColumns(db) {
  const columns = db.prepare('PRAGMA table_info(attention_items)').all().map(column => column.name);
  for (const column of ['schedule', 'then_action', 'next_at', 'schedule_state', 'last_fired_at', 'last_done_at', 'script_runs']) {
    if (!columns.includes(column)) db.exec(`ALTER TABLE attention_items ADD COLUMN ${column} TEXT`);
  }
  if (!columns.includes('runs')) db.exec('ALTER TABLE attention_items ADD COLUMN runs INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS idx_attention_items_next ON attention_items (next_at)');
}

// timeZone(): the IANA zone of this engine (a new schedule is kept in it). sessions: the terminals of this engine (routes/terminal.js; set later
// with setSessions): { check(taskId, terminalId) -> 'idle' | 'busy' | 'stopped' | 'gone', send(taskId, terminalId, text) -> boolean (a prompt),
// scriptTask(taskId) -> 'ok' | 'archived' | 'gone', runScript(taskId, { title, script, timeoutMs, onEnd }) -> { terminal_id } (a script run),
// removeTerminal(taskId, terminalId) }.
function createAttentionService({ db, now = () => new Date(), timeZone = scheduling.systemZone, sessions = null } = {}) {
  if (!db) throw new Error('createAttentionService needs a database');
  ensureScheduleColumns(db);
  let promptSessions = sessions;
  // attention_tokens.scopes was added after schema 9 shipped (db/index.js adds it at start; a database made from an older schema.sql gets it here).
  if (!db.prepare('PRAGMA table_info(attention_tokens)').all().some(column => column.name === 'scopes')) db.exec('ALTER TABLE attention_tokens ADD COLUMN scopes TEXT');
  ensureTreeColumns(db);
  const listeners = new Set();
  const internalListeners = new Set();
  const stamp = () => now().toISOString();
  // The first-run guide's per-owner flags (services/attention-guide.js), served by GET / PUT /api/attention/settings/guide.
  const guide = require('./attention-guide').createAttentionGuide({ db, now, AttentionError });
  const actorOf = value => (typeof value === 'string' && value.trim() ? value.trim().slice(0, LIMITS.source) : 'user');

  const selectItem = db.prepare('SELECT * FROM attention_items WHERE id = ?');
  const selectByRef = db.prepare('SELECT * FROM attention_items WHERE external_ref = ?');
  const insertEvent = db.prepare('INSERT INTO attention_events (item_id, at, actor, type, from_status, to_status, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const selectEvent = db.prepare('SELECT * FROM attention_events WHERE id = ?');

  // Public subscribers get the change; in-process ones of onChangeInternal also get the request's excerpt (never stored or sent to a page).
  // plain_turn_end (body field, see "T-Attention" in docs/design/architecture-features-and-page.md) is copied onto this one published change and never stored, so no later change inherits it.
  function emit(rawChange, extra = null) {
    const { excerpt: transcript = null, plainTurnEnd = false } = extra || {};
    const change = plainTurnEnd ? { ...rawChange, plain_turn_end: true } : rawChange;
    for (const listener of [...listeners]) {
      try { listener(change); } catch (error) { console.warn(`T-Attention: a change listener failed: ${error.message}`); }
    }
    for (const listener of [...internalListeners]) {
      try { listener({ ...change, excerpt: transcript }); } catch (error) { console.warn(`T-Attention: a change listener failed: ${error.message}`); }
    }
  }

  function onChangeInternal(fn) {
    if (typeof fn !== 'function') throw new TypeError('onChangeInternal needs a function');
    internalListeners.add(fn);
    return () => { internalListeners.delete(fn); };
  }

  function onChange(fn) {
    if (typeof fn !== 'function') throw new TypeError('onChange needs a function');
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }

  function writeEvent(itemId, at, actor, type, fromStatus, toStatus, data) {
    const id = insertEvent.run(itemId, at, actor, type, fromStatus || null, toStatus || null, data ? JSON.stringify(data) : null).lastInsertRowid;
    return rowToEvent(selectEvent.get(id));
  }

  // The list, sort_order DESC, then id DESC. Without a status filter and without includeDone it has the open items only; they are asked for by
  // name (status IN the open statuses), so the query walks idx_attention_items_status and its cost follows the open items: NOT IN the finished
  // ones reads the whole table, and the finished items are most of it.
  // recentFinished (that default list only, see recentFinishedOf): after the open items come the items finished last, at most that many, newest
  // first (completed_at DESC, then the list's order), under the same parent and q filters. They are read along idx_attention_items_completed,
  // from its newest end; `+status` keeps the planner off the status index (with statistics it could pick it, and then read and sort every
  // finished item to find the newest).
  function list({ status, q, limit, includeDone = false, parent, recentFinished } = {}) {
    const filters = [];
    const filterParams = [];
    if (parent !== undefined && parent !== null && parent !== '') {
      const id = idValue(parent);
      if (id === null) throw invalid('parent must be a task id');
      filters.push('parent_id = ?');
      filterParams.push(id);
    }
    const statuses = statusList(status);
    for (const value of statuses) if (!STATUSES.includes(value)) throw invalid(`status must be one of: ${STATUSES.join(', ')}`);
    const recent = recentFinishedOf({ status, includeDone, recentFinished });
    if (q !== undefined && q !== null && String(q).trim()) {
      const pattern = `%${String(q).trim().slice(0, 200).replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
      filters.push("(title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR attention_reason LIKE ? ESCAPE '\\')");
      filterParams.push(pattern, pattern, pattern);
    }
    let max = LIMITS.listDefault;
    if (limit !== undefined && limit !== null && limit !== '') {
      max = Number(limit);
      if (!Number.isInteger(max) || max < 1) throw invalid(`limit must be an integer between 1 and ${LIMITS.listMax}`);
      max = Math.min(max, LIMITS.listMax);
    }
    const wanted = statuses.length ? statuses : (includeDone ? null : OPEN_STATUSES);
    const where = [...(wanted ? [`status IN (${wanted.map(() => '?').join(',')})`] : []), ...filters];
    const sql = `SELECT * FROM attention_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY sort_order DESC, id DESC LIMIT ?`;
    const items = db.prepare(sql).all(...(wanted || []), ...filterParams, max).map(rowToItem);
    if (recent === null) return items;
    const finished = [...FINISHED];
    const finishedSql = `SELECT * FROM attention_items WHERE ${[`+status IN (${finished.map(() => '?').join(',')})`, ...filters].join(' AND ')}
      ORDER BY completed_at DESC, sort_order DESC, id DESC LIMIT ?`;
    return [...items, ...db.prepare(finishedSql).all(...finished, ...filterParams, recent).map(rowToItem)];
  }

  function get(id) {
    return rowToItem(selectItem.get(Number(id)));
  }

  // For the plugin overview: the open items written by one source (a listener's name) and the time of its newest item change or event.
  function sourceStats(name) {
    const finished = [...FINISHED];
    const open = db.prepare(`SELECT COUNT(*) AS n FROM attention_items WHERE source = ? AND status NOT IN (${finished.map(() => '?').join(',')})`).get(name, ...finished).n;
    const last = db.prepare(`SELECT MAX(at) AS at FROM (
      SELECT MAX(updated_at) AS at FROM attention_items WHERE source = ?
      UNION ALL SELECT MAX(e.at) AS at FROM attention_events e JOIN attention_items i ON i.id = e.item_id WHERE i.source = ?)`).get(name, name).at;
    return { itemCount: Number(open) || 0, lastEventAt: last || null };
  }

  function getByRef(ref) {
    return rowToItem(selectByRef.get(String(ref)));
  }

  function events(id, limit = LIMITS.events) {
    return db.prepare('SELECT * FROM attention_events WHERE item_id = ? ORDER BY id DESC LIMIT ?').all(Number(id), Math.min(Number(limit) || LIMITS.events, LIMITS.events)).map(rowToEvent);
  }

  function detail(id) {
    const item = get(id);
    if (!item) return null;
    return { item, events: events(id) };
  }

  function detailByRef(ref) {
    const item = typeof ref === 'string' && ref ? getByRef(ref) : null;
    return item ? { item, events: events(item.id) } : null;
  }

  // Inside a transaction: parent_ref ({ ref }) becomes the id of the item with that external_ref.
  function resolveParent(fields) {
    if (!fields.parent_id || typeof fields.parent_id !== 'object') return fields;
    const parent = selectByRef.get(fields.parent_id.ref);
    if (!parent) throw invalid('Unknown parent');
    return { ...fields, parent_id: parent.id };
  }

  // Inside a transaction: the parent must exist and must not be the item itself or one of its descendants.
  function checkParent(itemId, parent) {
    if (parent === null || parent === undefined) return;
    let row = selectItem.get(parent);
    if (!row) throw invalid('Unknown parent');
    const seen = new Set();
    while (row && !seen.has(row.id)) {
      if (row.id === itemId) throw invalid('Parent cycle');
      seen.add(row.id);
      row = row.parent_id === null || row.parent_id === undefined ? null : selectItem.get(row.parent_id);
    }
  }

  // ---- Schedules ----
  const iso = ms => new Date(ms).toISOString();
  const zone = () => { const tz = timeZone(); return scheduling.validZone(tz) ? tz : 'UTC'; };
  // The canonical schedule of a body value (JSON text, or null), against the item's current one: a value that names no zone or no first day keeps
  // those of the current schedule when it is the same schedule then (so the page sending it back changes nothing); else it gets this engine's
  // zone and today as its first day.
  function resolveSchedule(raw, beforeText) {
    const previous = parseJson(beforeText);
    if (previous) {
      let kept = null;
      try { kept = scheduling.normalizeSchedule(raw, { tz: previous.tz, starts: previous.starts }); } catch { kept = null; } // checked again below
      if (kept && JSON.stringify(kept) === beforeText) return beforeText;
    }
    const tz = zone();
    const fresh = scheduleCall(() => scheduling.normalizeSchedule(raw, { tz, starts: scheduling.dateText(scheduling.localDateOf(now().getTime(), tz)) }));
    return fresh ? JSON.stringify(fresh) : null;
  }
  // A prompt must name a session of this engine, a script a task of it that is in use (when the sessions are known here).
  function checkPrompt(text) {
    const action = parseJson(text);
    if (action && action.kind === 'script' && promptSessions && typeof promptSessions.scriptTask === 'function') {
      const state = promptSessions.scriptTask(Number(action.task_id));
      if (state === 'archived') throw invalid('The script names a task that is archived; restore it first');
      if (state !== 'ok') throw invalid('The script names a task that does not exist on this device');
      return;
    }
    if (!action || action.kind !== 'prompt' || !promptSessions || typeof promptSessions.check !== 'function') return;
    let state = 'gone';
    try { state = promptSessions.check(Number(action.task_id), action.terminal_id); } catch { state = 'gone'; }
    if (state === 'gone') throw invalid('The prompt names a session that does not exist on this device');
  }
  // The columns a new or changed schedule sets: { next_at, schedule_state, runs } and the status To do for a closed item.
  function scheduleStart(scheduleText, status, atMs) {
    const schedule = parseJson(scheduleText);
    if (!schedule) return { next_at: null, schedule_state: null };
    const next = scheduling.nextOccurrence(schedule, atMs, { runs: 0 });
    if (next === null) throw invalid('The schedule ends before its next time');
    return { next_at: iso(next), schedule_state: 'waiting', runs: 0, ...(FINISHED.has(status) ? { status: 'todo' } : {}) };
  }
  // A status change of a scheduled item: done of a recurring item puts it back for its next time (one row); done, failed or cancelled otherwise end
  // what is left to fire; an item opened again picks up its next time. Returns the extra columns, and recurringDone.
  function scheduleStatus(before, status, at, atMs) {
    const schedule = parseJson(before.schedule);
    if (!schedule || status === before.status) return {};
    if (status === 'done' && schedule.kind === 'repeat') {
      // Done while it waits (before its time): this time is skipped; done while it is due: the next time after now.
      const from = before.schedule_state === 'waiting' && before.next_at ? Math.max(atMs, Date.parse(before.next_at)) : atMs;
      const next = scheduling.nextOccurrence(schedule, from, { runs: before.runs || 0 });
      if (next === null) return { last_done_at: at, next_at: null, schedule_state: null };
      return {
        last_done_at: at, next_at: iso(next), schedule_state: 'waiting', status: 'todo', recurringDone: true,
        ...(before.attention_reason && PROMPT_NOTE.test(before.attention_reason) ? { attention_reason: null } : {}),
      };
    }
    if (FINISHED.has(status)) return { next_at: null, schedule_state: null, ...(status === 'done' ? { last_done_at: at } : {}) };
    if (FINISHED.has(before.status) && !before.next_at) {
      const next = scheduling.nextOccurrence(schedule, atMs, { runs: before.runs || 0 });
      if (next !== null) return { next_at: iso(next), schedule_state: 'waiting' };
    }
    return {};
  }
  const isScript = text => { const action = parseJson(text); return Boolean(action && action.kind === 'script'); };
  const scriptNeedsPerson = () => new AttentionError('SCRIPT_NEEDS_PERSON', 'Only you can set or change a script: use the page or a CLI token made in Settings', 403);
  // The event data of a changed field (the JSON ones parsed).
  const dataOf = (field, value) => (JSON_FIELDS.has(field) ? parseJson(value) : value);

  // Inside a transaction. fields: validated (readFields).
  function insertItem({ fields: given, context, activity: entry, tagent }, actor, defaultSource) {
    const fields = resolveParent(given);
    if (fields.schedule !== undefined) fields.schedule = resolveSchedule(fields.schedule.raw, null);
    if (tagent && isScript(fields.then_action)) throw scriptNeedsPerson();
    if (fields.then_action) checkPrompt(fields.then_action);
    if (!fields.title) throw invalid('title cannot be empty');
    checkParent(null, fields.parent_id);
    if (fields.external_ref && selectByRef.get(fields.external_ref)) {
      const existing = selectByRef.get(fields.external_ref);
      throw new AttentionError('EXTERNAL_REF_EXISTS', 'A task with this external_ref already exists', 409, { id: existing.id });
    }
    const at = stamp();
    const status = fields.status || 'todo';
    const order = fields.sort_order !== undefined ? fields.sort_order : (db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM attention_items').get().next);
    const row = {
      title: fields.title,
      notes: fields.notes ?? null,
      status,
      priority: fields.priority || 'none',
      due_date: fields.due_date ?? null,
      source: fields.source || defaultSource || 'user',
      external_ref: fields.external_ref ?? null,
      attention_reason: fields.attention_reason ?? null,
      link_url: fields.link_url ?? null,
      link_label: fields.link_label ?? null,
      meta: fields.meta ?? null,
      parent_id: fields.parent_id ?? null,
      custom_status: fields.custom_status ?? null,
      result: fields.result ?? null,
      schedule: fields.schedule ?? null,
      then_action: fields.then_action ?? null,
      context: null,
      sort_order: order,
      created_at: at,
      updated_at: at,
      completed_at: FINISHED.has(status) ? at : null,
    };
    if (row.schedule) {
      Object.assign(row, scheduleStart(row.schedule, status, now().getTime()));
      row.completed_at = FINISHED.has(row.status) ? at : null;
    }
    const mergedContext = mergeContext(null, tieToTerminal(context, null, tagent));
    row.context = mergedContext ? JSON.stringify(mergedContext) : null;
    const columns = Object.keys(row);
    const id = db.prepare(`INSERT INTO attention_items (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...columns.map(column => row[column])).lastInsertRowid;
    const item = get(id);
    const data = {};
    for (const field of FIELDS) if (fields[field] !== undefined && fields[field] !== null) data[field] = dataOf(field, fields[field]);
    if (row.next_at) data.next_at = row.next_at;
    if (mergedContext) data.context = Object.keys(mergedContext).sort();
    const event = writeEvent(item.id, at, actorOf(actor), 'created', null, item.status, data);
    const activityEvent = entry ? writeEvent(item.id, at, actorOf(actor), 'activity', item.status, item.status, entry) : null;
    return { kind: 'created', item, previous: null, event, activity: activityEvent };
  }

  // Inside a transaction. Returns null when nothing changed. extra: more keys for the event's data (a move's placement and reason).
  function updateRow(before, { fields: given, context, activity: entry, tagent }, actor, extra = null) {
    const fields = resolveParent(given);
    if (fields.schedule !== undefined) fields.schedule = resolveSchedule(fields.schedule.raw, before.schedule);
    const changes = {};
    for (const [field, value] of Object.entries(fields)) {
      if (field === 'title' && value === null) throw invalid('title cannot be empty');
      if (field === 'source' && value === null) continue; // source cannot be emptied
      if (before[field] !== value) changes[field] = value;
    }
    if (changes.parent_id !== undefined) checkParent(before.id, changes.parent_id);
    if (changes.external_ref) {
      const other = selectByRef.get(changes.external_ref);
      if (other && other.id !== before.id) throw new AttentionError('EXTERNAL_REF_EXISTS', 'A task with this external_ref already exists', 409, { id: other.id });
    }
    // A script is set or changed only by the person (the page, a linked engine, a CLI token made in Settings), never with a terminal's own token,
    // which is what agents use: also not its schedule.
    if (tagent && (isScript(before.then_action) || isScript(changes.then_action)) && (changes.then_action !== undefined || changes.schedule !== undefined)) throw scriptNeedsPerson();
    if (changes.then_action) checkPrompt(changes.then_action);
    const beforeContext = parseJson(before.context);
    const afterContext = mergeContext(beforeContext, tieToTerminal(context, beforeContext, tagent));
    const changedKeys = contextKeysChanged(beforeContext, afterContext);
    if (changedKeys.length) changes.context = afterContext ? JSON.stringify(afterContext) : null;
    const atMs = now().getTime();
    const at = iso(atMs);
    // Schedules: a new or cleared schedule, or a status change of a scheduled item (scheduleStart, scheduleStatus).
    let recurringDone = false;
    if (changes.schedule !== undefined) {
      Object.assign(changes, scheduleStart(changes.schedule, changes.status !== undefined ? changes.status : before.status, atMs));
    } else if (changes.status !== undefined) {
      const { recurringDone: done = false, ...more } = scheduleStatus(before, changes.status, at, atMs);
      recurringDone = done;
      Object.assign(changes, more);
    }
    for (const column of [...SCHEDULE_COLUMNS, 'status', 'attention_reason']) {
      if (changes[column] !== undefined && changes[column] === before[column] && !(column === 'status' && recurringDone)) delete changes[column];
    }
    if (!Object.keys(changes).length) {
      if (!entry) return null;
      // Only an activity: the item is unchanged, the timeline gets its row and the change is published.
      const item = rowToItem(before);
      const activityEvent = writeEvent(before.id, at, actorOf(actor), 'activity', before.status, before.status, entry);
      return { kind: 'updated', item, previous: item, event: activityEvent, activity: activityEvent };
    }
    const statusChanged = changes.status !== undefined && changes.status !== before.status;
    if (statusChanged) changes.completed_at = FINISHED.has(changes.status) ? at : null;
    if (recurringDone && changes.status === before.status) delete changes.status;
    changes.updated_at = at;
    const columns = Object.keys(changes);
    db.prepare(`UPDATE attention_items SET ${columns.map(column => `${column} = ?`).join(', ')} WHERE id = ?`).run(...columns.map(column => changes[column]), before.id);
    const item = get(before.id);
    const data = {};
    for (const field of Object.keys(changes)) if (FIELDS.includes(field)) data[field] = dataOf(field, changes[field]);
    for (const column of ['next_at', 'schedule_state']) if (changes[column] !== undefined) data[column] = changes[column];
    if (changedKeys.length) data.context = changedKeys;
    if (extra) Object.assign(data, extra);
    // The done of a recurring item is on the timeline as a status change to done (the run is done), while the item itself is back in To do.
    if (recurringDone) Object.assign(data, { status: 'done', recurring: true });
    const event = writeEvent(before.id, at, actorOf(actor), statusChanged || recurringDone ? 'status' : 'updated', before.status, recurringDone ? 'done' : item.status, data);
    const activityEvent = entry ? writeEvent(before.id, at, actorOf(actor), 'activity', item.status, item.status, entry) : null;
    return { kind: 'updated', item, previous: rowToItem(before), event, activity: activityEvent };
  }

  // tagent (create, update, upsertByRef): the terminal of a terminal token (routes/attention.js), see tieToTerminal.
  function create(body, { actor, defaultSource, tagent } = {}) {
    const parts = readBody(body, tagent);
    const change = db.transaction(() => insertItem(parts, actor, defaultSource))();
    emit(change, parts);
    return change.item;
  }

  function update(id, body, { actor, tagent } = {}) {
    const parts = readBody(body, tagent);
    const change = db.transaction(() => {
      const before = selectItem.get(Number(id));
      if (!before) throw new AttentionError('NOT_FOUND', 'Task not found', 404);
      return updateRow(before, parts, actor) || { unchanged: true, item: rowToItem(before) };
    })();
    if (!change.unchanged) emit(change, parts);
    return change.item;
  }

  // The listener path: create the item of this external_ref when it is missing, else update it. Returns { created, item }.
  function upsertByRef(ref, body, { actor, defaultSource, tagent } = {}) {
    const externalRef = VALIDATORS.external_ref(ref);
    if (!externalRef) throw invalid('external_ref cannot be empty');
    const parts = readBody(body, tagent);
    delete parts.fields.external_ref; // the address names the item; a different body value cannot move it
    const change = db.transaction(() => {
      const before = selectByRef.get(externalRef);
      if (!before) return insertItem({ ...parts, fields: { ...parts.fields, external_ref: externalRef } }, actor, defaultSource);
      return updateRow(before, parts, actor) || { unchanged: true, item: rowToItem(before) };
    })();
    if (!change.unchanged) emit(change, parts);
    return { created: change.kind === 'created', item: change.item };
  }

  function remove(id, { actor } = {}) {
    const change = db.transaction(() => {
      const before = selectItem.get(Number(id));
      if (!before) throw new AttentionError('NOT_FOUND', 'Task not found', 404);
      const children = db.prepare('SELECT id FROM attention_items WHERE parent_id = ? ORDER BY id').all(before.id).map(row => row.id);
      if (children.length) throw new AttentionError('HAS_CHILDREN', 'This task has subtasks; delete them or give them another parent first', 409, { children });
      db.prepare('DELETE FROM attention_items WHERE id = ?').run(before.id);
      const item = rowToItem(before);
      // The item's events go with it (ON DELETE CASCADE), so the deleted event is only published, not stored.
      const event = { id: null, item_id: before.id, at: stamp(), actor: actorOf(actor), type: 'deleted', from_status: before.status, to_status: null, data: null };
      return { kind: 'deleted', item, previous: item, event };
    })();
    emit(change);
    return true;
  }

  // The body of a move: exactly one of before / after (a task id) or position ('top' | 'bottom'); optional status and reason.
  function readMove(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('The request body must be a JSON object');
    const given = ['before', 'after', 'position'].filter(key => body[key] !== undefined && body[key] !== null && body[key] !== '');
    if (given.length !== 1) throw invalid('Give exactly one of before, after or position');
    const placement = {};
    if (given[0] === 'position') {
      if (body.position !== 'top' && body.position !== 'bottom') throw invalid("position must be 'top' or 'bottom'");
      placement.position = body.position;
    } else {
      const target = idValue(body[given[0]]);
      if (target === null) throw invalid(`${given[0]} must be a task id`);
      placement[given[0]] = target;
    }
    const status = body.status === undefined || body.status === null || body.status === '' ? undefined : VALIDATORS.status(body.status);
    const reason = text('reason', LIMITS.activityText, { singleLine: true })(body.reason);
    return { placement, status, reason };
  }

  // The items of a group in display order.
  function groupRows(group) {
    const statuses = statusesOf(group);
    return db.prepare(`SELECT * FROM attention_items WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY sort_order DESC, id DESC`).all(...statuses);
  }
  // Depth-first: the item, then its descendants inside `rows` (children in display order). A child whose parent is not in `rows` (another
  // group) is not reached: it is a top-level row of its own group.
  function subtree(id, rows) {
    const children = new Map();
    for (const row of rows) {
      if (row.parent_id === null || row.parent_id === undefined) continue;
      if (!children.has(row.parent_id)) children.set(row.parent_id, []);
      children.get(row.parent_id).push(row.id);
    }
    const out = [];
    const seen = new Set();
    const visit = node => {
      if (seen.has(node)) return;
      seen.add(node);
      out.push(node);
      for (const child of children.get(node) || []) visit(child);
    };
    visit(id);
    return out;
  }

  // POST /:id/move. The item and its descendants in the group it ends up in are placed as one block; a status change and the placement are one
  // transaction. The group keeps its own sort_order values, reassigned in the new order (made strictly decreasing first, so ties are
  // renumbered), so only the items between the old and the new place change. The moved item gets an event (its data has sort_order, the status
  // when it changed, move: the placement, and reason) and a new updated_at; the other items whose sort_order changed keep updated_at and get
  // no event row. Every item whose sort_order or status changed is published as an 'updated' change with reorder: true (event null for the
  // others). Returns { item, items: [every item whose sort_order changed] }.
  function move(id, body, { actor } = {}) {
    const request = readMove(body);
    const result = db.transaction(() => {
      const before = selectItem.get(Number(id));
      if (!before) throw new AttentionError('NOT_FOUND', 'Task not found', 404);
      const status = request.status || before.status;
      const group = groupOf(status);
      const rows = groupRows(group).filter(row => row.id !== before.id);
      const members = [...rows, { ...before, status }];
      const block = subtree(before.id, members);
      const blockSet = new Set(block);
      const rest = rows.filter(row => !blockSet.has(row.id)).map(row => row.id);
      let at;
      if (request.placement.position) {
        at = request.placement.position === 'top' ? 0 : rest.length;
      } else {
        const targetId = request.placement.before || request.placement.after;
        const target = selectItem.get(targetId);
        if (!target) throw invalid('Unknown target');
        if (target.id === before.id) throw invalid('A task cannot be moved next to itself');
        if (groupOf(target.status) !== group) throw invalid('Target is in another group');
        if (blockSet.has(target.id)) throw invalid('A task cannot be moved next to its own subtask');
        at = rest.indexOf(target.id);
        if (request.placement.after) {
          // After the target and the descendants that follow it.
          const following = new Set(subtree(target.id, rows.filter(row => !blockSet.has(row.id))));
          at += 1;
          while (at < rest.length && following.has(rest[at])) at += 1;
        }
      }
      const order = [...rest.slice(0, at), ...block, ...rest.slice(at)];
      // The group's values, highest first, made strictly decreasing.
      const values = members.map(row => row.sort_order).sort((a, b) => b - a);
      for (let i = 1; i < values.length; i += 1) if (values[i] >= values[i - 1]) values[i] = values[i - 1] - 1;
      const byId = new Map(members.map(row => [row.id, row]));
      const moved = [];
      const ownValue = values[order.indexOf(before.id)];
      const placementData = { move: request.placement, ...(request.reason ? { reason: request.reason } : {}) };
      const fields = { sort_order: ownValue, ...(request.status ? { status: request.status } : {}) };
      const own = updateRow(before, { fields, context: undefined, activity: null }, actor, placementData);
      const others = [];
      order.forEach((itemId, index) => {
        if (itemId === before.id) return;
        const row = byId.get(itemId);
        if (row.sort_order === values[index]) return;
        db.prepare('UPDATE attention_items SET sort_order = ? WHERE id = ?').run(values[index], itemId);
        const item = get(itemId);
        others.push({ kind: 'updated', item, previous: rowToItem(row), event: null, reorder: true });
        moved.push(item);
      });
      if (own && own.previous.sort_order !== own.item.sort_order) moved.unshift(own.item);
      return { own, others, item: get(before.id), moved };
    })();
    if (result.own) emit({ ...result.own, reorder: true });
    for (const change of result.others) emit(change);
    return { item: result.item, items: result.moved };
  }

  // ---- Firing (the timer of services/attention-scheduler.js and POST /:id/run-now) ----
  // The action of a row: { kind: 'prompt' | 'script', ... } or null (remind me).
  const actionOf = row => { const action = parseJson(row.then_action); return action && (action.kind === 'prompt' || action.kind === 'script') ? action : null; };
  function promptState(action) {
    if (!promptSessions || typeof promptSessions.check !== 'function') return 'gone';
    try { return promptSessions.check(Number(action.task_id), action.terminal_id) || 'gone'; } catch { return 'gone'; }
  }
  const runsOf = row => { const runs = parseJson(row.script_runs); return Array.isArray(runs) ? runs : []; };
  const openRun = row => runsOf(row).find(run => !run.ended_at) || null;
  const topOrder = () => db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM attention_items').get().next;
  const zoneOf = row => (parseJson(row.schedule) || {}).tz || zone();
  const writeFields = (id, fields) => {
    const columns = Object.keys(fields);
    db.prepare(`UPDATE attention_items SET ${columns.map(column => `${column} = ?`).join(', ')} WHERE id = ?`).run(...columns.map(column => fields[column]), id);
  };
  const withTerminal = (row, taskId, terminalId) => JSON.stringify({ ...(parseJson(row.context) || {}), tagent: { task_id: String(taskId), terminal_id: String(terminalId) } });
  // A run that went well: a recurring item waits for its next time (To do), anything else is done.
  function runDone(before, fields, at) {
    fields.last_done_at = at;
    let status = before.status;
    const schedule = parseJson(before.schedule);
    const nextAt = fields.next_at !== undefined ? fields.next_at : before.next_at;
    if (schedule && schedule.kind === 'repeat' && nextAt) {
      if (FINISHED.has(status) || status === 'waiting_user' || status === 'working') status = 'todo';
      fields.schedule_state = 'waiting';
    } else {
      status = 'done';
      fields.schedule_state = null;
      fields.next_at = null;
    }
    if (before.attention_reason && PROMPT_NOTE.test(before.attention_reason)) fields.attention_reason = null;
    return status;
  }

  // Inside a transaction: one firing of `before`. outcome: 'remind', 'sent' (the prompt is typed after the commit), why a prompt was not sent
  // ('busy', 'stopped', 'gone'), 'script' (the script starts after the commit) or 'skipped' (its last script run still runs: only the next time moves
  // on). manual: run now (a recurring item keeps its next time). Returns the change to publish.
  function applyFiring(before, { outcome, manual, actor, atMs }) {
    const at = iso(atMs);
    const schedule = parseJson(before.schedule);
    const missed = !manual && schedule && before.next_at ? scheduling.occurrencesBetween(schedule, Date.parse(before.next_at), atMs) : 1;
    const runs = (before.runs || 0) + (outcome === 'skipped' ? 0 : 1);
    let next = null;
    if (schedule && schedule.kind === 'repeat') {
      next = manual && before.next_at && Date.parse(before.next_at) > atMs ? Date.parse(before.next_at) : scheduling.nextOccurrence(schedule, atMs, { runs });
    }
    const fields = { next_at: next === null ? null : iso(next) };
    let status = before.status;
    if (outcome === 'skipped') {
      if (next === null && before.schedule_state === 'waiting') fields.schedule_state = null;
    } else {
      fields.runs = runs;
      fields.last_fired_at = at;
      if (outcome === 'remind') {
        if (FINISHED.has(status)) status = 'todo';
        fields.schedule_state = schedule ? 'due' : null;
      } else if (outcome === 'sent') {
        status = runDone(before, fields, at);
      } else if (outcome === 'script') {
        status = 'working';
        fields.schedule_state = schedule ? 'due' : null;
        if (before.attention_reason && PROMPT_NOTE.test(before.attention_reason)) fields.attention_reason = null;
      } else {
        status = 'waiting_user';
        fields.schedule_state = schedule ? 'due' : null;
        fields.attention_reason = PROMPT_NOTES[outcome](scheduling.clockIn(atMs, zoneOf(before)));
      }
    }
    fields.status = status;
    if (status !== before.status) fields.completed_at = FINISHED.has(status) ? at : null;
    // A firing that brings the item to the person puts it at the top of its group.
    if (['remind', 'busy', 'stopped', 'gone'].includes(outcome) && (groupOf(status) !== groupOf(before.status) || before.schedule_state !== 'due')) fields.sort_order = topOrder();
    fields.updated_at = at;
    writeFields(before.id, fields);
    const item = get(before.id);
    const action = actionOf(before);
    const data = {
      runs, next_at: fields.next_at, action: action ? action.kind : 'remind', ...(outcome === 'remind' ? {} : { outcome: outcome === 'script' ? 'started' : outcome }),
      ...(missed > 1 ? { missed } : {}), ...(manual ? { manual: true } : {}),
    };
    const event = writeEvent(before.id, at, actorOf(actor), 'scheduled', before.status, item.status, data);
    if (outcome === 'sent') writeEvent(before.id, at, actorOf(actor), 'prompt_sent', item.status, item.status, { task_id: action.task_id, terminal_id: action.terminal_id });
    return { kind: 'updated', item, previous: rowToItem(before), event, ...(outcome === 'remind' ? { scheduled_due: true } : {}) };
  }

  // Inside a transaction: a change that ends a firing which did not go as planned (a prompt the session no longer took, a script that could not
  // start): Needs you with the note, due again.
  function failFiring(id, note, { actor, atMs, eventType = 'status', data = {} }) {
    const row = selectItem.get(Number(id));
    if (!row) return null;
    const at = iso(atMs);
    const fields = { status: 'waiting_user', attention_reason: note, updated_at: at, sort_order: topOrder(), ...(row.schedule ? { schedule_state: 'due' } : {}) };
    if (row.status !== 'waiting_user') fields.completed_at = null;
    writeFields(row.id, fields);
    const item = get(row.id);
    const event = writeEvent(row.id, at, actorOf(actor), eventType, row.status, item.status, { ...data, status: item.status, attention_reason: note });
    return { kind: 'updated', item, previous: rowToItem(row), event };
  }

  // One firing of an item; null when it is no longer due (another firing or a change came first). The firing is stored first; then the prompt is
  // typed or the script started, and then the change is published: a firing is never sent, run or notified twice.
  function fireItem(id, { manual = false, actor = 'schedule', atMs = now().getTime(), expectNextAt } = {}) {
    const first = selectItem.get(Number(id));
    if (!first) return null;
    const action = actionOf(first);
    let outcome = 'remind';
    if (action && action.kind === 'prompt') { const state = promptState(action); outcome = state === 'idle' ? 'sent' : state; }
    if (action && action.kind === 'script') outcome = openRun(first) ? 'skipped' : 'script';
    const change = db.transaction(() => {
      const before = selectItem.get(Number(id));
      if (!before) return null;
      if (!manual && (!before.next_at || before.next_at > iso(atMs) || before.next_at !== expectNextAt)) return null;
      if (JSON.stringify(actionOf(before)) !== JSON.stringify(action)) return null; // changed in between: the next round decides
      return applyFiring(before, { outcome, manual, actor, atMs });
    })();
    if (!change) return null;
    const after = [];
    if (outcome === 'sent') {
      let typed = false;
      try { typed = promptSessions.send(Number(action.task_id), action.terminal_id, action.text) === true; } catch { typed = false; }
      if (!typed) after.push(db.transaction(() => failFiring(id, PROMPT_NOTES.stopped(scheduling.clockIn(atMs, zoneOf(first))), { actor, atMs }))());
    }
    if (outcome === 'script') after.push(...startScript(id, action, { actor, atMs }));
    emit(change);
    for (const extra of after) if (extra) emit(extra);
    const last = after.filter(Boolean).at(-1);
    return (last || change).item;
  }

  // A script run: a new terminal of the task (sessions.runScript), recorded on the item (script_runs, context.tagent: "Open terminal" opens it);
  // the runs beyond the last SCRIPT_RUNS_KEPT lose their terminal. Returns the changes to publish.
  function startScript(id, action, { actor, atMs }) {
    const row = selectItem.get(Number(id));
    const time = scheduling.clockIn(atMs, zoneOf(row));
    let started = null;
    let failure = null;
    try {
      if (!promptSessions || typeof promptSessions.runScript !== 'function') throw new Error('Scripts cannot run on this device');
      started = promptSessions.runScript(Number(action.task_id), {
        title: `${row.title.slice(0, 30)} · ${time}`,
        script: action.script,
        timeoutMs: action.timeout_min * 60 * 1000,
        onEnd: result => { try { finishScript(id, result, { timeoutMin: action.timeout_min }); } catch (error) { console.warn(`T-Attention: a script run of item ${id} could not be recorded: ${error.message}`); } },
      });
    } catch (error) { failure = error; }
    if (!started || !started.terminal_id) {
      const note = SCRIPT_NOTES.start(null, time);
      return [db.transaction(() => failFiring(id, note, { actor, atMs, eventType: 'script_failed', data: { error: String((failure && failure.message) || 'not started').slice(0, 200) } }))()];
    }
    const removed = [];
    const change = db.transaction(() => {
      const current = selectItem.get(Number(id));
      if (!current) return null;
      const runs = [...runsOf(current), { terminal_id: started.terminal_id, task_id: String(action.task_id), at: iso(atMs) }];
      while (runs.length > SCRIPT_RUNS_KEPT) removed.push(runs.shift());
      writeFields(current.id, { script_runs: JSON.stringify(runs), context: withTerminal(current, action.task_id, started.terminal_id), updated_at: iso(atMs) });
      const item = get(current.id);
      const event = writeEvent(current.id, iso(atMs), actorOf(actor), 'updated', current.status, item.status, { context: ['tagent'], script_terminal: started.terminal_id });
      return { kind: 'updated', item, previous: rowToItem(current), event };
    })();
    for (const run of removed) { try { promptSessions.removeTerminal(Number(run.task_id || action.task_id), run.terminal_id); } catch { /* gone already */ } }
    return [change];
  }

  // The end of a script run (sessions.runScript's onEnd): exit 0 counts the run as done; another status, the time limit or a terminal that ended
  // first is Needs you with the note, due again, its terminal on the item. Only the open run of that terminal is ended, once.
  function finishScript(id, { outcome, exit = null, duration_ms: duration = null, terminal_id: terminalId } = {}, { timeoutMin = null, actor = 'schedule' } = {}) {
    const atMs = now().getTime();
    const at = iso(atMs);
    const change = db.transaction(() => {
      const before = selectItem.get(Number(id));
      if (!before) return null;
      const runs = runsOf(before);
      const run = runs.find(entry => entry.terminal_id === terminalId);
      if (!run || run.ended_at) return null;
      Object.assign(run, { ended_at: at, outcome, exit: Number.isInteger(exit) ? exit : null, duration_ms: Number.isFinite(duration) ? duration : null });
      const fields = { script_runs: JSON.stringify(runs), updated_at: at };
      const ok = outcome === 'exit' && exit === 0;
      let status;
      if (ok) {
        status = runDone(before, fields, at);
      } else {
        const time = scheduling.clockIn(atMs, zoneOf(before));
        status = 'waiting_user';
        fields.attention_reason = outcome === 'exit' ? SCRIPT_NOTES.exit(exit, time) : outcome === 'timeout' ? SCRIPT_NOTES.timeout(timeoutMin || (actionOf(before) || {}).timeout_min || 0, time) : SCRIPT_NOTES.ended(null, time);
        if (before.schedule) fields.schedule_state = 'due';
        fields.context = withTerminal(before, run.task_id || (actionOf(before) || {}).task_id, terminalId);
        fields.sort_order = topOrder();
      }
      fields.status = status;
      if (status !== before.status) fields.completed_at = FINISHED.has(status) ? at : null;
      writeFields(before.id, fields);
      const item = get(before.id);
      const data = { terminal_id: terminalId, outcome, exit: run.exit, duration_ms: run.duration_ms };
      const event = writeEvent(before.id, at, actorOf(actor), ok ? 'script_done' : 'script_failed', before.status, item.status, data);
      return { kind: 'updated', item, previous: rowToItem(before), event };
    })();
    if (change) emit(change);
    return change ? change.item : null;
  }

  // At start: a script run that was open when the server stopped (its shell ended with it) is ended as stopped.
  function recoverScripts() {
    const ended = [];
    for (const row of db.prepare("SELECT id, script_runs FROM attention_items WHERE script_runs IS NOT NULL AND script_runs LIKE '%terminal_id%'").all()) {
      const run = openRun(row);
      if (!run) continue;
      const item = finishScript(row.id, { outcome: 'ended', terminal_id: run.terminal_id });
      if (item) ended.push(item);
    }
    return ended;
  }

  // Every item whose time has come (next_at <= now), the oldest first. Times missed while the engine was off fire once (the event says how many).
  function fireDue(atMs = now().getTime()) {
    const due = db.prepare('SELECT id, next_at FROM attention_items WHERE next_at IS NOT NULL AND next_at <= ? ORDER BY next_at, id LIMIT 500').all(iso(atMs));
    const fired = [];
    for (const row of due) {
      try {
        const item = fireItem(row.id, { atMs, expectNextAt: row.next_at });
        if (item) fired.push(item);
      } catch (error) { console.warn(`T-Attention: item ${row.id} could not fire: ${error.message}`); }
    }
    return fired;
  }
  // The earliest next_at (ISO) or null: when the timer must look again.
  const nextDueAt = () => db.prepare('SELECT MIN(next_at) AS at FROM attention_items WHERE next_at IS NOT NULL').get().at || null;

  // POST /:id/run-now: a prompt is sent now when its session is idle (else 409 and nothing changes); a script runs again ("Run again"; only for the
  // person, and not while it still runs); a reminder fires now.
  function runNow(id, { actor, tagent = null } = {}) {
    const before = selectItem.get(Number(id));
    if (!before) throw new AttentionError('NOT_FOUND', 'Task not found', 404);
    const action = actionOf(before);
    if (!action && !before.schedule) throw invalid('This task has no schedule or prompt');
    if (action && action.kind === 'prompt') {
      const state = promptState(action);
      if (state === 'busy') throw new AttentionError('SESSION_BUSY', 'The session is busy; the prompt was not sent', 409);
      if (state === 'stopped') throw new AttentionError('SESSION_NOT_RUNNING', 'The session is not running; the prompt was not sent', 409);
      if (state !== 'idle') throw new AttentionError('SESSION_NOT_FOUND', 'The session was not found; the prompt was not sent', 409);
    }
    if (action && action.kind === 'script') {
      if (tagent) throw scriptNeedsPerson();
      if (openRun(before)) throw new AttentionError('SCRIPT_RUNNING', 'The script is still running', 409);
    }
    const item = fireItem(before.id, { manual: true, actor: actorOf(actor) });
    if (!item) throw new AttentionError('NOT_FOUND', 'Task not found', 404);
    return item;
  }

  // Tokens

  function listTokens() {
    return db.prepare('SELECT * FROM attention_tokens ORDER BY id DESC').all().map(tokenView);
  }

  // market: true gives the token the 'market' scope ("Can manage plugins").
  function createToken({ name, market = false } = {}) {
    const clean = text('name', LIMITS.tokenName, { required: true, singleLine: true })(name);
    if (market !== undefined && market !== null && typeof market !== 'boolean') throw invalid('market must be true or false');
    const token = `tatt_${crypto.randomBytes(32).toString('base64url')}`;
    const scopes = market === true ? 'market' : null;
    const id = db.prepare('INSERT INTO attention_tokens (name, token_hash, created_at, scopes) VALUES (?, ?, ?, ?)').run(clean, hashToken(token), stamp(), scopes).lastInsertRowid;
    return { id: Number(id), name: clean, token, market: market === true };
  }

  function revokeToken(id) {
    const row = db.prepare('SELECT * FROM attention_tokens WHERE id = ?').get(Number(id));
    if (!row) throw new AttentionError('NOT_FOUND', 'Token not found', 404);
    if (!row.revoked_at) db.prepare('UPDATE attention_tokens SET revoked_at = ? WHERE id = ?').run(stamp(), row.id);
    return tokenView(db.prepare('SELECT * FROM attention_tokens WHERE id = ?').get(row.id));
  }

  // Terminal tokens: key (task:terminal) -> { id, name, hash }; hash -> the same entry.
  const terminalByKey = new Map();
  const terminalByHash = new Map();
  let terminalSeq = 0;
  const terminalKey = (taskId, terminalId) => `${Number(taskId)}:${String(terminalId)}`;

  // A new token for the shell of this terminal; a previous one of the same terminal ends. Returns { id, name, token }.
  function issueTerminalToken({ taskId, terminalId } = {}) {
    const key = terminalKey(taskId, terminalId);
    revokeTerminalToken({ taskId, terminalId });
    const token = `tatt_${crypto.randomBytes(32).toString('base64url')}`;
    terminalSeq += 1;
    const entry = { id: `terminal:${terminalSeq}`, name: `terminal ${key}`.slice(0, LIMITS.tokenName), hash: hashToken(token), key, tagent: { task_id: String(Number(taskId)), terminal_id: String(terminalId) } };
    terminalByKey.set(key, entry);
    terminalByHash.set(entry.hash, entry);
    return { id: entry.id, name: entry.name, token };
  }

  function revokeTerminalToken({ taskId, terminalId } = {}) {
    const entry = terminalByKey.get(terminalKey(taskId, terminalId));
    if (!entry) return false;
    terminalByKey.delete(entry.key);
    terminalByHash.delete(entry.hash);
    return true;
  }

  const terminalTokenCount = () => terminalByKey.size;

  // Returns { id, name } for a valid, unrevoked token (and stores last_used_at), else null.
  function verifyToken(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
    const terminal = terminalByHash.get(hashToken(token));
    if (terminal) return { id: terminal.id, name: terminal.name, kind: 'terminal', scopes: [], tagent: { ...terminal.tagent } };
    const row = db.prepare('SELECT * FROM attention_tokens WHERE token_hash = ?').get(hashToken(token));
    if (!row || row.revoked_at) return null;
    db.prepare('UPDATE attention_tokens SET last_used_at = ? WHERE id = ?').run(stamp(), row.id);
    return { id: row.id, name: row.name, scopes: scopesOf(row) };
  }

  function tokenActive(id) {
    if (typeof id === 'string' && id.startsWith('terminal:')) return [...terminalByKey.values()].some(entry => entry.id === id);
    const row = db.prepare('SELECT revoked_at FROM attention_tokens WHERE id = ?').get(Number(id));
    return Boolean(row && !row.revoked_at);
  }

  // Pairing: one active code { hash, expiresAt, url, failures }; the last claim { name, at } for the page.
  let pairing = null;
  let lastClaim = null;
  const nowMs = () => now().getTime();

  // url: the address the page used (sent by the page); it is what the claiming machine gets back. Returns { code, expiresAt }.
  function createPairing({ url } = {}) {
    const address = pairingUrl(url);
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const expiresAt = nowMs() + PAIRING.ttlMs;
    pairing = { hash: hashToken(`pair:${code}`), expiresAt, url: address, failures: 0 };
    lastClaim = null;
    return { code, expiresAt: new Date(expiresAt).toISOString(), url: address };
  }

  function activePairing() {
    if (pairing && pairing.expiresAt <= nowMs()) pairing = null;
    return pairing;
  }

  function pairingStatus() {
    const active = activePairing();
    return { active: Boolean(active), expiresAt: active ? new Date(active.expiresAt).toISOString() : null, claimed: lastClaim };
  }

  function cancelPairing() { pairing = null; return pairingStatus(); }

  // Exchanges the active code for a new normal token named "claude listener (<name>)". The code ends on success (single use) and after
  // PAIRING.maxFailures wrong codes. Returns { url, token, name }; throws PAIRING_INVALID (400) for a wrong, used or expired code.
  function claimPairing({ code, name } = {}) {
    // The name is checked first, so a bad name never uses up the code.
    const machine = text('name', 60, { singleLine: true })(typeof name === 'string' && name.trim() ? name.trim().slice(0, 60) : 'another machine') || 'another machine';
    const active = activePairing();
    const given = typeof code === 'string' ? code.replace(/[\s-]/g, '') : '';
    const wrong = () => new AttentionError('PAIRING_INVALID', 'The pairing code is wrong, used or expired; create a new one on the page', 400);
    if (!active || !/^\d{6}$/.test(given)) {
      if (active) { active.failures += 1; if (active.failures >= PAIRING.maxFailures) pairing = null; }
      throw wrong();
    }
    const expected = Buffer.from(active.hash, 'hex');
    const actual = Buffer.from(hashToken(`pair:${given}`), 'hex');
    if (!crypto.timingSafeEqual(expected, actual)) {
      active.failures += 1;
      if (active.failures >= PAIRING.maxFailures) pairing = null;
      throw wrong();
    }
    pairing = null; // used: before the token exists, so a second claim cannot get another one
    const created = createToken({ name: `claude listener (${machine})` });
    lastClaim = { name: created.name, at: stamp() };
    return { url: active.url, token: created.token, name: created.name, id: created.id };
  }

  // POST /schedule/preview: the next three times and the sentence of a schedule, in this engine's zone unless it names one.
  const preview = schedule => scheduling.preview(schedule, now().getTime(), { tz: zone() });
  const setSessions = adapter => { promptSessions = adapter || null; };

  return { list, get, sourceStats, getByRef, events, detail, detailByRef, create, update, upsertByRef, remove, move, onChange, onChangeInternal, listTokens, createToken, revokeToken, verifyToken, tokenActive,
    fireDue, nextDueAt, runNow, finishScript, recoverScripts, preview, setSessions, timeZone: zone,
    issueTerminalToken, revokeTerminalToken, terminalTokenCount, createPairing, pairingStatus, cancelPairing, claimPairing, getGuide: guide.get, saveGuide: guide.save };
}

// The service of this server's database, made on first use (so requiring this file does not open the database).
let shared = null;
function defaultService() {
  if (!shared) shared = createAttentionService({ db: require('../db') });
  return shared;
}

module.exports = {
  createAttentionService, defaultService, ensureTreeColumns, ensureScheduleColumns, rowToItem, groupOf, GROUPS, AttentionError, PAIRING, TOKEN_SCOPES, ACTIVITY_KINDS, PENDING_KINDS, STATUSES, PRIORITIES, FINISHED, LIMITS, TOKEN_PATTERN, hashToken,
  recentFinishedOf,
  // In-process subscribers (notifiers) of this server's list.
  onChange: fn => defaultService().onChange(fn),
};
