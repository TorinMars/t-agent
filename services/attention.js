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
const crypto = require('crypto');

const STATUSES = Object.freeze(['todo', 'working', 'waiting_user', 'review', 'done', 'failed', 'cancelled']);
const FINISHED = new Set(['done', 'failed', 'cancelled']);
const PRIORITIES = Object.freeze(['high', 'medium', 'low', 'none']);
const ACTIVITY_KINDS = Object.freeze(['prompt', 'permission', 'question', 'resumed', 'turn_end', 'error', 'session_end', 'note']);
const PENDING_KINDS = Object.freeze(['permission', 'question', 'error']);
const LIMITS = Object.freeze({ customStatus: 100, result: 500, contextBytes: 32768, excerptBytes: 8192, activityText: 500, contextFiles: 50, summaryText: 600, title: 300, notes: 20000, externalRef: 200, attentionReason: 500, linkUrl: 2000, linkLabel: 200, source: 64, metaBytes: 8192, tokenName: 80, listDefault: 200, listMax: 1000, events: 100 });
// The fields a create / update body may carry. Anything else in a body is ignored (newer callers may send more).
const FIELDS = ['title', 'notes', 'status', 'priority', 'due_date', 'source', 'external_ref', 'attention_reason', 'link_url', 'link_label', 'meta', 'sort_order', 'parent_id', 'custom_status', 'result'];
// The groups an item is shown and ordered in (the page's sections; "Needs you" shows waiting_user and review). A move stays inside one group.
const GROUPS = Object.freeze(['waiting_user', 'review', 'working', 'todo', 'finished']);
const groupOf = status => (FINISHED.has(status) ? 'finished' : status);
const statusesOf = group => (group === 'finished' ? [...FINISHED] : [group]);
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
};

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
// The whole body: the stored fields, the context patch, the activity entry and the excerpt.
function readBody(body) {
  const fields = readFields(body);
  return { fields, context: contextPatch(body.context), activity: activity(body.activity), excerpt: excerpt(body.excerpt), plainTurnEnd: body.plain_turn_end === true };
}
const parseJson = value => { if (!value) return null; try { return JSON.parse(value); } catch { return null; } };
const contextKeysChanged = (before, after) => [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
  .filter(key => JSON.stringify((before || {})[key]) !== JSON.stringify((after || {})[key])).sort();

function rowToItem(row) {
  if (!row) return null;
  return { ...row, meta: parseJson(row.meta), context: parseJson(row.context) };
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
}

function createAttentionService({ db, now = () => new Date() } = {}) {
  if (!db) throw new Error('createAttentionService needs a database');
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
  // plain_turn_end (body field, see "T-Attention" in DESIGN.md) is copied onto this one published change and never stored, so no later change inherits it.
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

  function list({ status, q, limit, includeDone = false, parent } = {}) {
    const where = [];
    const params = [];
    if (parent !== undefined && parent !== null && parent !== '') {
      const id = idValue(parent);
      if (id === null) throw invalid('parent must be a task id');
      where.push('parent_id = ?');
      params.push(id);
    }
    let statuses = null;
    if (status !== undefined && status !== null && status !== '') {
      statuses = (Array.isArray(status) ? status : String(status).split(',')).map(value => String(value).trim()).filter(Boolean);
      for (const value of statuses) if (!STATUSES.includes(value)) throw invalid(`status must be one of: ${STATUSES.join(', ')}`);
    }
    if (statuses && statuses.length) {
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    } else if (!includeDone) {
      where.push(`status NOT IN (${[...FINISHED].map(() => '?').join(',')})`);
      params.push(...FINISHED);
    }
    if (q !== undefined && q !== null && String(q).trim()) {
      const pattern = `%${String(q).trim().slice(0, 200).replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
      where.push("(title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR attention_reason LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern, pattern);
    }
    let max = LIMITS.listDefault;
    if (limit !== undefined && limit !== null && limit !== '') {
      max = Number(limit);
      if (!Number.isInteger(max) || max < 1) throw invalid(`limit must be an integer between 1 and ${LIMITS.listMax}`);
      max = Math.min(max, LIMITS.listMax);
    }
    const sql = `SELECT * FROM attention_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY sort_order DESC, id DESC LIMIT ?`;
    return db.prepare(sql).all(...params, max).map(rowToItem);
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

  // Inside a transaction. fields: validated (readFields).
  function insertItem({ fields: given, context, activity: entry }, actor, defaultSource) {
    const fields = resolveParent(given);
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
      context: null,
      sort_order: order,
      created_at: at,
      updated_at: at,
      completed_at: FINISHED.has(status) ? at : null,
    };
    const mergedContext = mergeContext(null, context);
    row.context = mergedContext ? JSON.stringify(mergedContext) : null;
    const columns = Object.keys(row);
    const id = db.prepare(`INSERT INTO attention_items (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...columns.map(column => row[column])).lastInsertRowid;
    const item = get(id);
    const data = {};
    for (const field of FIELDS) if (fields[field] !== undefined && fields[field] !== null) data[field] = field === 'meta' ? item.meta : fields[field];
    if (mergedContext) data.context = Object.keys(mergedContext).sort();
    const event = writeEvent(item.id, at, actorOf(actor), 'created', null, status, data);
    const activityEvent = entry ? writeEvent(item.id, at, actorOf(actor), 'activity', status, status, entry) : null;
    return { kind: 'created', item, previous: null, event, activity: activityEvent };
  }

  // Inside a transaction. Returns null when nothing changed. extra: more keys for the event's data (a move's placement and reason).
  function updateRow(before, { fields: given, context, activity: entry }, actor, extra = null) {
    const fields = resolveParent(given);
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
    const beforeContext = parseJson(before.context);
    const afterContext = mergeContext(beforeContext, context);
    const changedKeys = contextKeysChanged(beforeContext, afterContext);
    if (changedKeys.length) changes.context = afterContext ? JSON.stringify(afterContext) : null;
    const at = stamp();
    if (!Object.keys(changes).length) {
      if (!entry) return null;
      // Only an activity: the item is unchanged, the timeline gets its row and the change is published.
      const item = rowToItem(before);
      const activityEvent = writeEvent(before.id, at, actorOf(actor), 'activity', before.status, before.status, entry);
      return { kind: 'updated', item, previous: item, event: activityEvent, activity: activityEvent };
    }
    const statusChanged = changes.status !== undefined && changes.status !== before.status;
    if (statusChanged) changes.completed_at = FINISHED.has(changes.status) ? at : null;
    changes.updated_at = at;
    const columns = Object.keys(changes);
    db.prepare(`UPDATE attention_items SET ${columns.map(column => `${column} = ?`).join(', ')} WHERE id = ?`).run(...columns.map(column => changes[column]), before.id);
    const item = get(before.id);
    const data = {};
    for (const field of Object.keys(changes)) if (FIELDS.includes(field)) data[field] = field === 'meta' ? item.meta : changes[field];
    if (changedKeys.length) data.context = changedKeys;
    if (extra) Object.assign(data, extra);
    const event = writeEvent(before.id, at, actorOf(actor), statusChanged ? 'status' : 'updated', before.status, item.status, data);
    const activityEvent = entry ? writeEvent(before.id, at, actorOf(actor), 'activity', item.status, item.status, entry) : null;
    return { kind: 'updated', item, previous: rowToItem(before), event, activity: activityEvent };
  }

  function create(body, { actor, defaultSource } = {}) {
    const parts = readBody(body);
    const change = db.transaction(() => insertItem(parts, actor, defaultSource))();
    emit(change, parts);
    return change.item;
  }

  function update(id, body, { actor } = {}) {
    const parts = readBody(body);
    const change = db.transaction(() => {
      const before = selectItem.get(Number(id));
      if (!before) throw new AttentionError('NOT_FOUND', 'Task not found', 404);
      return updateRow(before, parts, actor) || { unchanged: true, item: rowToItem(before) };
    })();
    if (!change.unchanged) emit(change, parts);
    return change.item;
  }

  // The listener path: create the item of this external_ref when it is missing, else update it. Returns { created, item }.
  function upsertByRef(ref, body, { actor, defaultSource } = {}) {
    const externalRef = VALIDATORS.external_ref(ref);
    if (!externalRef) throw invalid('external_ref cannot be empty');
    const parts = readBody(body);
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
    const entry = { id: `terminal:${terminalSeq}`, name: `terminal ${key}`.slice(0, LIMITS.tokenName), hash: hashToken(token), key };
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
    if (terminal) return { id: terminal.id, name: terminal.name, kind: 'terminal', scopes: [] };
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

  return { list, get, sourceStats, getByRef, events, detail, detailByRef, create, update, upsertByRef, remove, move, onChange, onChangeInternal, listTokens, createToken, revokeToken, verifyToken, tokenActive,
    issueTerminalToken, revokeTerminalToken, terminalTokenCount, createPairing, pairingStatus, cancelPairing, claimPairing, getGuide: guide.get, saveGuide: guide.save };
}

// The service of this server's database, made on first use (so requiring this file does not open the database).
let shared = null;
function defaultService() {
  if (!shared) shared = createAttentionService({ db: require('../db') });
  return shared;
}

module.exports = {
  createAttentionService, defaultService, ensureTreeColumns, groupOf, GROUPS, AttentionError, PAIRING, TOKEN_SCOPES, ACTIVITY_KINDS, PENDING_KINDS, STATUSES, PRIORITIES, FINISHED, LIMITS, TOKEN_PATTERN, hashToken,
  // In-process subscribers (notifiers) of this server's list.
  onChange: fn => defaultService().onChange(fn),
};
