// T-Attention (attention hub): one central list of work items that agents, services and the person create and update.
// Tables attention_items, attention_events and attention_tokens (db/schema.sql, schema 9). Self-contained: it never reads or changes tasks, terminals or chats.
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
const crypto = require('crypto');

const STATUSES = Object.freeze(['todo', 'working', 'waiting_user', 'review', 'done', 'failed', 'cancelled']);
const FINISHED = new Set(['done', 'failed', 'cancelled']);
const PRIORITIES = Object.freeze(['high', 'medium', 'low', 'none']);
const ACTIVITY_KINDS = Object.freeze(['prompt', 'permission', 'question', 'resumed', 'turn_end', 'error', 'session_end', 'note']);
const PENDING_KINDS = Object.freeze(['permission', 'question', 'error']);
const LIMITS = Object.freeze({ contextBytes: 32768, excerptBytes: 8192, activityText: 500, contextFiles: 50, summaryText: 600, title: 300, notes: 20000, externalRef: 200, attentionReason: 500, linkUrl: 2000, linkLabel: 200, source: 64, metaBytes: 8192, tokenName: 80, listDefault: 200, listMax: 1000, events: 100 });
// The fields a create / update body may carry. Anything else in a body is ignored (newer callers may send more).
const FIELDS = ['title', 'notes', 'status', 'priority', 'due_date', 'source', 'external_ref', 'attention_reason', 'link_url', 'link_label', 'meta', 'sort_order'];
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
};

// The fields present in a body, validated. Unknown fields are ignored; a body that is not an object is refused.
function readFields(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('The request body must be a JSON object');
  const out = {};
  // context, activity and excerpt are read by readBody.
  for (const field of FIELDS) if (Object.prototype.hasOwnProperty.call(body, field)) out[field] = VALIDATORS[field](body[field]);
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
  return { fields, context: contextPatch(body.context), activity: activity(body.activity), excerpt: excerpt(body.excerpt) };
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

const tokenView = row => ({ id: row.id, name: row.name, created_at: row.created_at, last_used_at: row.last_used_at, revoked_at: row.revoked_at });

function createAttentionService({ db, now = () => new Date() } = {}) {
  if (!db) throw new Error('createAttentionService needs a database');
  const listeners = new Set();
  const internalListeners = new Set();
  const stamp = () => now().toISOString();
  const actorOf = value => (typeof value === 'string' && value.trim() ? value.trim().slice(0, LIMITS.source) : 'user');

  const selectItem = db.prepare('SELECT * FROM attention_items WHERE id = ?');
  const selectByRef = db.prepare('SELECT * FROM attention_items WHERE external_ref = ?');
  const insertEvent = db.prepare('INSERT INTO attention_events (item_id, at, actor, type, from_status, to_status, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const selectEvent = db.prepare('SELECT * FROM attention_events WHERE id = ?');

  // Public subscribers get the change; in-process ones of onChangeInternal also get the request's excerpt (never stored or sent to a page).
  function emit(change, extra = null) {
    const { excerpt: transcript = null } = extra || {};
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

  function list({ status, q, limit, includeDone = false } = {}) {
    const where = [];
    const params = [];
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

  // Inside a transaction. fields: validated (readFields).
  function insertItem({ fields, context, activity: entry }, actor, defaultSource) {
    if (!fields.title) throw invalid('title cannot be empty');
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

  // Inside a transaction. Returns null when nothing changed.
  function updateRow(before, { fields, context, activity: entry }, actor) {
    const changes = {};
    for (const [field, value] of Object.entries(fields)) {
      if (field === 'title' && value === null) throw invalid('title cannot be empty');
      if (field === 'source' && value === null) continue; // source cannot be emptied
      if (before[field] !== value) changes[field] = value;
    }
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
      db.prepare('DELETE FROM attention_items WHERE id = ?').run(before.id);
      const item = rowToItem(before);
      // The item's events go with it (ON DELETE CASCADE), so the deleted event is only published, not stored.
      const event = { id: null, item_id: before.id, at: stamp(), actor: actorOf(actor), type: 'deleted', from_status: before.status, to_status: null, data: null };
      return { kind: 'deleted', item, previous: item, event };
    })();
    emit(change);
    return true;
  }

  // Tokens

  function listTokens() {
    return db.prepare('SELECT * FROM attention_tokens ORDER BY id DESC').all().map(tokenView);
  }

  function createToken({ name } = {}) {
    const clean = text('name', LIMITS.tokenName, { required: true, singleLine: true })(name);
    const token = `tatt_${crypto.randomBytes(32).toString('base64url')}`;
    const id = db.prepare('INSERT INTO attention_tokens (name, token_hash, created_at) VALUES (?, ?, ?)').run(clean, hashToken(token), stamp()).lastInsertRowid;
    return { id: Number(id), name: clean, token };
  }

  function revokeToken(id) {
    const row = db.prepare('SELECT * FROM attention_tokens WHERE id = ?').get(Number(id));
    if (!row) throw new AttentionError('NOT_FOUND', 'Token not found', 404);
    if (!row.revoked_at) db.prepare('UPDATE attention_tokens SET revoked_at = ? WHERE id = ?').run(stamp(), row.id);
    return tokenView(db.prepare('SELECT * FROM attention_tokens WHERE id = ?').get(row.id));
  }

  // Returns { id, name } for a valid, unrevoked token (and stores last_used_at), else null.
  function verifyToken(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
    const row = db.prepare('SELECT * FROM attention_tokens WHERE token_hash = ?').get(hashToken(token));
    if (!row || row.revoked_at) return null;
    db.prepare('UPDATE attention_tokens SET last_used_at = ? WHERE id = ?').run(stamp(), row.id);
    return { id: row.id, name: row.name };
  }

  function tokenActive(id) {
    const row = db.prepare('SELECT revoked_at FROM attention_tokens WHERE id = ?').get(Number(id));
    return Boolean(row && !row.revoked_at);
  }

  return { list, get, getByRef, events, detail, detailByRef, create, update, upsertByRef, remove, onChange, onChangeInternal, listTokens, createToken, revokeToken, verifyToken, tokenActive };
}

// The service of this server's database, made on first use (so requiring this file does not open the database).
let shared = null;
function defaultService() {
  if (!shared) shared = createAttentionService({ db: require('../db') });
  return shared;
}

module.exports = {
  createAttentionService, defaultService, AttentionError, ACTIVITY_KINDS, PENDING_KINDS, STATUSES, PRIORITIES, FINISHED, LIMITS, TOKEN_PATTERN, hashToken,
  // In-process subscribers (notifiers) of this server's list.
  onChange: fn => defaultService().onChange(fn),
};
