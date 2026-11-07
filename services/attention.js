// T-Attention (attention hub): one central list of work items that agents, services and the person create and update.
// Tables attention_items, attention_events and attention_tokens (db/schema.sql, schema 9). Self-contained: it never reads or changes tasks, terminals or chats.
//
// - Every change writes its event row in the same transaction and is then published on the in-process bus: onChange(fn) -> unsubscribe,
//   fn({ kind: 'created' | 'updated' | 'deleted', item, previous, event }). Notifiers and the SSE stream subscribe to it.
// - A change that changes nothing (a listener sending the same state again) writes no event, keeps updated_at and is not published.
// - completed_at is set when the status becomes done / failed / cancelled and cleared when it leaves them.
// - Tokens ('tatt_' + 32 random bytes base64url) are stored as sha256 hashes only; the token itself is returned once, at creation.
const crypto = require('crypto');

const STATUSES = Object.freeze(['todo', 'working', 'waiting_user', 'review', 'done', 'failed', 'cancelled']);
const FINISHED = new Set(['done', 'failed', 'cancelled']);
const PRIORITIES = Object.freeze(['high', 'medium', 'low', 'none']);
const LIMITS = Object.freeze({ title: 300, notes: 20000, externalRef: 200, attentionReason: 500, linkUrl: 2000, linkLabel: 200, source: 64, metaBytes: 8192, tokenName: 80, listDefault: 200, listMax: 1000, events: 100 });
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
  for (const field of FIELDS) if (Object.prototype.hasOwnProperty.call(body, field)) out[field] = VALIDATORS[field](body[field]);
  return out;
}

function rowToItem(row) {
  if (!row) return null;
  let parsed = null;
  if (row.meta) { try { parsed = JSON.parse(row.meta); } catch { parsed = null; } }
  return { ...row, meta: parsed };
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
  const stamp = () => now().toISOString();
  const actorOf = value => (typeof value === 'string' && value.trim() ? value.trim().slice(0, LIMITS.source) : 'user');

  const selectItem = db.prepare('SELECT * FROM attention_items WHERE id = ?');
  const selectByRef = db.prepare('SELECT * FROM attention_items WHERE external_ref = ?');
  const insertEvent = db.prepare('INSERT INTO attention_events (item_id, at, actor, type, from_status, to_status, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const selectEvent = db.prepare('SELECT * FROM attention_events WHERE id = ?');

  function emit(change) {
    for (const listener of [...listeners]) {
      try { listener(change); } catch (error) { console.warn(`T-Attention: a change listener failed: ${error.message}`); }
    }
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

  // Inside a transaction. fields: validated (readFields).
  function insertItem(fields, actor, defaultSource) {
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
      sort_order: order,
      created_at: at,
      updated_at: at,
      completed_at: FINISHED.has(status) ? at : null,
    };
    const columns = Object.keys(row);
    const id = db.prepare(`INSERT INTO attention_items (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...columns.map(column => row[column])).lastInsertRowid;
    const item = get(id);
    const data = {};
    for (const field of FIELDS) if (fields[field] !== undefined && fields[field] !== null) data[field] = field === 'meta' ? item.meta : fields[field];
    const event = writeEvent(item.id, at, actorOf(actor), 'created', null, status, data);
    return { kind: 'created', item, previous: null, event };
  }

  // Inside a transaction. Returns null when nothing changed.
  function updateRow(before, fields, actor) {
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
    if (!Object.keys(changes).length) return null;
    const at = stamp();
    const statusChanged = changes.status !== undefined && changes.status !== before.status;
    if (statusChanged) changes.completed_at = FINISHED.has(changes.status) ? at : null;
    changes.updated_at = at;
    const columns = Object.keys(changes);
    db.prepare(`UPDATE attention_items SET ${columns.map(column => `${column} = ?`).join(', ')} WHERE id = ?`).run(...columns.map(column => changes[column]), before.id);
    const item = get(before.id);
    const data = {};
    for (const field of Object.keys(changes)) if (FIELDS.includes(field)) data[field] = field === 'meta' ? item.meta : changes[field];
    const event = writeEvent(before.id, at, actorOf(actor), statusChanged ? 'status' : 'updated', before.status, item.status, data);
    return { kind: 'updated', item, previous: rowToItem(before), event };
  }

  function create(body, { actor, defaultSource } = {}) {
    const fields = readFields(body);
    const change = db.transaction(() => insertItem(fields, actor, defaultSource))();
    emit(change);
    return change.item;
  }

  function update(id, body, { actor } = {}) {
    const fields = readFields(body);
    const change = db.transaction(() => {
      const before = selectItem.get(Number(id));
      if (!before) throw new AttentionError('NOT_FOUND', 'Task not found', 404);
      return updateRow(before, fields, actor) || { unchanged: true, item: rowToItem(before) };
    })();
    if (!change.unchanged) emit(change);
    return change.item;
  }

  // The listener path: create the item of this external_ref when it is missing, else update it. Returns { created, item }.
  function upsertByRef(ref, body, { actor, defaultSource } = {}) {
    const externalRef = VALIDATORS.external_ref(ref);
    if (!externalRef) throw invalid('external_ref cannot be empty');
    const fields = readFields(body);
    delete fields.external_ref; // the address names the item; a different body value cannot move it
    const change = db.transaction(() => {
      const before = selectByRef.get(externalRef);
      if (!before) return insertItem({ ...fields, external_ref: externalRef }, actor, defaultSource);
      return updateRow(before, fields, actor) || { unchanged: true, item: rowToItem(before) };
    })();
    if (!change.unchanged) emit(change);
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

  return { list, get, getByRef, events, detail, create, update, upsertByRef, remove, onChange, listTokens, createToken, revokeToken, verifyToken, tokenActive };
}

// The service of this server's database, made on first use (so requiring this file does not open the database).
let shared = null;
function defaultService() {
  if (!shared) shared = createAttentionService({ db: require('../db') });
  return shared;
}

module.exports = {
  createAttentionService, defaultService, AttentionError, STATUSES, PRIORITIES, FINISHED, LIMITS, TOKEN_PATTERN, hashToken,
  // In-process subscribers (notifiers) of this server's list.
  onChange: fn => defaultService().onChange(fn),
};
