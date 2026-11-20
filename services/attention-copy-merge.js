// The rules of the T-Attention read copies (docs/design/attention-copies.md), pure: no database, no clock of their own (every time is passed in), so
// test/attention-copy.test.js checks them with a fake clock.
//
// - A copy row is one item of one owner engine: { owner, id, rev, deleted, item, event, at }. Only the owner changes its items, so a copy never merges
//   fields: the row with the higher `rev` (the owner's hybrid clock, in ms) wins whole, and a tombstone (deleted) wins over an older item.
// - Actions on a copy whose owner is offline: the safe ones (fields of the item and a note) are queued on this engine and shown at once
//   (`project`); the others are refused (`queueRule`). When the owner is back each queued change is checked against the owner's current item
//   (`resolveQueued`): a field the owner changed meanwhile wins over the queued change, which is then dropped whole.
const STATUSES = Object.freeze(['todo', 'working', 'waiting_user', 'review', 'done', 'failed', 'cancelled']);
const INSTANCE_ID = /^[A-Za-z0-9-]{1,64}$/;
const MAX_ITEM_BYTES = 64 * 1024;
// The fields a queued change may set: what the row buttons, the circle and the edit view send, and nothing that needs the owner's tree or order.
const SAFE_FIELDS = Object.freeze(['title', 'notes', 'status', 'priority', 'due_date', 'attention_reason', 'link_url', 'link_label', 'custom_status', 'result']);
// Body keys of a PATCH that are never queued (the tree, the order, the identity and the agent's own data): the change is refused while the owner is offline.
const UNSAFE_FIELDS = Object.freeze(['parent_id', 'parent_ref', 'sort_order', 'external_ref', 'source', 'meta', 'context', 'excerpt']);
const EVENT_KEYS = Object.freeze(['type', 'actor', 'at', 'from_status', 'to_status']);
// A copy change older than this when it arrives is history, not news: it is shown, but the page gives no reminder for it.
const QUIET_MS = 60 * 1000;

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const positiveId = value => Number.isSafeInteger(value) && value > 0;

// The owner's next version: never lower than the last one, also when the clock went back.
const nextRev = (last, nowMs) => Math.max(Math.floor(nowMs), (Number.isSafeInteger(last) ? last : 0) + 1);

// What a change event keeps in a copy: the kind of change and who made it (never its data, which may name context keys), and the two markers of the
// published change (a reorder, the end of a plain Claude turn).
function slimEvent(event, extra = {}) {
  const out = {};
  if (isPlainObject(event)) for (const key of EVENT_KEYS) if (typeof event[key] === 'string' && event[key].length <= 200) out[key] = event[key];
  if (extra.reorder === true) out.reorder = true;
  if (extra.plain_turn_end === true) out.plain_turn_end = true;
  return Object.keys(out).length ? out : null;
}

// A copy row sent by a peer, checked; null when it is not one. `item` is kept as the owner listed it (the owner validated it), within a size limit,
// and with a matching id, a title and a known status.
function rowFromPeer(raw) {
  if (!isPlainObject(raw)) return null;
  const { owner, id, rev, deleted, item, event, at } = raw;
  if (typeof owner !== 'string' || !INSTANCE_ID.test(owner) || !positiveId(id) || !Number.isSafeInteger(rev) || rev < 0) return null;
  if (typeof at !== 'string' || at.length > 40 || Number.isNaN(Date.parse(at))) return null;
  if (deleted === true) return { owner, id, rev, deleted: true, item: null, event: slimEvent(event, isPlainObject(event) ? event : {}), at };
  if (!isPlainObject(item) || item.id !== id || typeof item.title !== 'string' || !item.title || item.title.length > 300 || !STATUSES.includes(item.status)) return null;
  if (Buffer.byteLength(JSON.stringify(item), 'utf8') > MAX_ITEM_BYTES) return null;
  return { owner, id, rev, deleted: false, item, event: slimEvent(event, isPlainObject(event) ? event : {}), at };
}

// Whether an incoming row replaces the stored one: the owner's later version wins (the same version is the same row: nothing to do).
const wins = (incoming, stored) => !stored || incoming.rev > stored.rev;

// The kind of copy change a replacement is, for the stream: created, updated or deleted.
function changeKind(incoming, stored) {
  if (incoming.deleted) return 'deleted';
  return stored && !stored.deleted ? 'updated' : 'created';
}

// A copy change that is history when it arrives (the owner made it more than QUIET_MS before): no reminder on a page.
const isQuiet = (at, nowMs, quietMs = QUIET_MS) => {
  const made = Date.parse(at || '');
  return !Number.isFinite(made) || nowMs - made > quietMs;
};

const OFFLINE = 'ATTENTION_OWNER_OFFLINE';
const refusal = message => ({ refuse: { status: 409, error: OFFLINE, message } });
// What may happen to an action on the item of an owner that is offline: { queue: { fields, activity } } or { refuse: { status, error, message } }.
// method + sub: 'PATCH' '' (the item), 'DELETE' '', 'POST' '/move', 'POST' '/summarize', 'POST' with no item (a new item on that engine).
function queueRule(method, sub, body, { hasItem = true } = {}) {
  if (!hasItem) return refusal('Tasks can only be added while the device they go to is online');
  if (method === 'DELETE') return refusal('A task can only be deleted while the device it belongs to is online');
  if (method === 'POST' && sub === '/move') return refusal('The order can only be changed while the device the task belongs to is online');
  if (method === 'POST' && sub === '/summarize') return refusal('A summary can only be made while the device the task belongs to is online');
  if (method !== 'PATCH' || sub) return refusal('This can only be done while the device the task belongs to is online');
  if (!isPlainObject(body)) return { refuse: { status: 400, error: 'VALIDATION_FAILED', message: 'The request body must be a JSON object' } };
  if (UNSAFE_FIELDS.some(key => Object.prototype.hasOwnProperty.call(body, key))) return refusal('This change can only be made while the device the task belongs to is online');
  const fields = {};
  for (const key of SAFE_FIELDS) if (Object.prototype.hasOwnProperty.call(body, key)) fields[key] = body[key] === '' ? null : body[key];
  let activity = null;
  if (body.activity !== undefined && body.activity !== null) {
    if (!isPlainObject(body.activity) || body.activity.kind !== 'note' || (body.activity.text !== undefined && typeof body.activity.text !== 'string')) {
      return refusal('This change can only be made while the device the task belongs to is online');
    }
    activity = { kind: 'note', text: String(body.activity.text || '').slice(0, 500) };
  }
  if (!Object.keys(fields).length && !activity) return { refuse: { status: 400, error: 'VALIDATION_FAILED', message: 'Nothing to change' } };
  if (fields.status !== undefined && !STATUSES.includes(fields.status)) return { refuse: { status: 400, error: 'VALIDATION_FAILED', message: `status must be one of: ${STATUSES.join(', ')}` } };
  if (fields.title !== undefined && (typeof fields.title !== 'string' || !fields.title.trim())) return { refuse: { status: 400, error: 'VALIDATION_FAILED', message: 'title cannot be empty' } };
  return { queue: { fields, activity } };
}

// The item as it will be once the queued changes are applied (in order), for the page to show at once. A new object.
function project(item, entries) {
  if (!item) return item;
  const out = { ...item };
  for (const entry of entries || []) for (const [key, value] of Object.entries((entry && entry.fields) || {})) out[key] = value;
  return out;
}

// The values a queued change starts from: those of the shown item (the copy with the earlier queued changes applied), for each field it sets.
function baseOf(shown, fields) {
  const base = {};
  for (const key of Object.keys(fields || {})) base[key] = shown && shown[key] !== undefined ? shown[key] : null;
  return base;
}

const same = (a, b) => (a === undefined ? null : a) === (b === undefined ? null : b);
// A queued change against the owner's current item: { apply: { body } } (the fields that still differ, and the note), { noop: true } (the owner
// already has it all) or { drop: 'newer' } (a field the change sets was changed on the owner since the change was made: the owner's change wins,
// and the queued change is dropped whole, its note too). A gone item is { drop: 'gone' }.
function resolveQueued(entry, current) {
  if (!current) return { drop: 'gone' };
  const fields = (entry && entry.fields) || {};
  const base = (entry && entry.base) || {};
  const body = {};
  for (const [key, value] of Object.entries(fields)) {
    if (same(current[key], value)) continue; // already so on the owner
    if (!same(current[key], base[key])) return { drop: 'newer' };
    body[key] = value;
  }
  if (entry && entry.activity) body.activity = entry.activity;
  return Object.keys(body).length ? { apply: { body } } : { noop: true };
}

module.exports = {
  STATUSES, INSTANCE_ID, SAFE_FIELDS, UNSAFE_FIELDS, QUIET_MS, OFFLINE, MAX_ITEM_BYTES,
  nextRev, slimEvent, rowFromPeer, wins, changeKind, isQuiet, queueRule, project, baseOf, resolveQueued, isPlainObject,
};
