// The merge rules of the English learning sync ("Sync across linked devices" in docs/design/learn-english.md): pure functions, no database, no clock.
//
// A card is one per kind and normalized text on every device. It has two versions, each a hybrid clock time and the instance id of the device that
// made it: the content (en, zh, source, context, suspended), changed by an edit, and the review state (due_at, interval_days, ease, reps, lapses,
// last_result, last_at, last_correct), changed by an answer. Each half goes to the later version on its own, a tie to the greater instance id, so an
// answer on one device and a meaning edit on another both survive. A meaning is never replaced by an empty one, and created_at is the earliest.
const { normalize, checkEnglish, KINDS, SOURCES, MODES } = require('./learn');
const { GRADES } = require('./learn-review');

const CONTENT = ['en', 'zh', 'source', 'context', 'suspended'];
const STATE = ['due_at', 'interval_days', 'ease', 'reps', 'lapses', 'last_result', 'last_at', 'last_correct'];
const FIELDS = ['created_at', ...CONTENT, 'content_at', 'content_by', ...STATE, 'state_at', 'state_by'];
const INSTANCE_ID = /^[A-Za-z0-9-]{1,64}$/;
const MAX_ZH = 500;
const MAX_CONTEXT = 120;
const MAX_ANSWER = 500;
const MAX_NORM = 300;

// Whether version (aAt, aBy) is later than (bAt, bBy).
const later = (aAt, aBy, bAt, bBy) => (aAt !== bAt ? aAt > bAt : String(aBy || '') > String(bBy || ''));

// The merge of a local card and one from a peer, both with every field of FIELDS (`by` filled in, never ''). `follow`: the peer's card is the same
// card under an older text (it was moved here), so only its review state and a missing meaning can come over, never its text.
// Returns { card, changed }: the merged fields, and whether they differ from the local card.
function mergeCard(local, incoming, { follow = false } = {}) {
  if (!local) return { card: pick(incoming, FIELDS), changed: true };
  const contentFromPeer = !follow && later(incoming.content_at, incoming.content_by, local.content_at, local.content_by);
  const stateFromPeer = later(incoming.state_at, incoming.state_by, local.state_at, local.state_by);
  const content = contentFromPeer ? incoming : local;
  const other = contentFromPeer ? local : incoming;
  const card = {
    created_at: Math.min(local.created_at, incoming.created_at),
    ...pick(content, [...CONTENT, 'content_at', 'content_by']),
    zh: content.zh || other.zh || '',
    ...pick(stateFromPeer ? incoming : local, [...STATE, 'state_at', 'state_by']),
  };
  return { card, changed: FIELDS.some(field => card[field] !== local[field]) };
}

function pick(row, fields) {
  const out = {};
  for (const field of fields) out[field] = row[field] === undefined ? null : row[field];
  return out;
}

const time = value => Number.isSafeInteger(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : null);

// A card as a peer sent it, checked and made into the local form (norm computed here, suspended and last_correct as 0 / 1), or null when it is not a
// card this version can keep (a text the checks refuse, a field of the wrong type). `sender`: the instance id that sent it, for a version with no device.
function cardFromPeer(raw, sender) {
  if (!raw || typeof raw !== 'object' || !KINDS.includes(raw.kind)) return null;
  let en;
  try { en = checkEnglish(raw.kind, raw.en); } catch { return null; }
  const zh = raw.zh === undefined || raw.zh === null ? '' : text(raw.zh, MAX_ZH);
  const context = raw.context === undefined || raw.context === null ? '' : text(raw.context, MAX_CONTEXT);
  if (zh === null || context === null || !SOURCES.includes(raw.source) || typeof raw.suspended !== 'boolean') return null;
  if (![raw.created_at, raw.content_at, raw.state_at, raw.due_at].every(time) || !(raw.last_at === null || time(raw.last_at))) return null;
  if (!Number.isFinite(raw.interval_days) || raw.interval_days < 0 || raw.interval_days > 400) return null;
  if (!Number.isFinite(raw.ease) || raw.ease < 1 || raw.ease > 10 || !count(raw.reps) || !count(raw.lapses)) return null;
  if (!(raw.last_result === null || GRADES.includes(raw.last_result)) || !(raw.last_correct === null || typeof raw.last_correct === 'boolean')) return null;
  const by = value => (typeof value === 'string' && INSTANCE_ID.test(value) ? value : sender);
  return {
    kind: raw.kind, norm: normalize(en), en, zh, source: raw.source, context, suspended: raw.suspended ? 1 : 0,
    created_at: raw.created_at, content_at: raw.content_at, content_by: by(raw.content_by),
    due_at: raw.due_at, interval_days: raw.interval_days, ease: raw.ease, reps: raw.reps, lapses: raw.lapses,
    last_result: raw.last_result, last_at: raw.last_at, last_correct: raw.last_correct === null ? null : (raw.last_correct ? 1 : 0),
    state_at: raw.state_at, state_by: by(raw.state_by),
  };
}

// A card row of this device in the form a peer gets (`me`: this device's instance id, for the versions it made itself, stored as '').
function cardToPeer(row, me) {
  return {
    kind: row.kind, en: row.en, zh: row.zh, source: row.source, context: row.context, suspended: Boolean(row.suspended),
    created_at: row.created_at, content_at: row.content_at, content_by: row.content_by || me,
    due_at: row.due_at, interval_days: row.interval_days, ease: row.ease, reps: row.reps, lapses: row.lapses,
    last_result: row.last_result || null, last_at: row.last_at === null || row.last_at === undefined ? null : row.last_at,
    last_correct: row.last_correct === null || row.last_correct === undefined ? null : Boolean(row.last_correct),
    state_at: row.state_at, state_by: row.state_by || me,
  };
}
// A local row with its versions' devices filled in, for mergeCard.
const resolved = (row, me) => ({ ...row, content_by: row.content_by || me, state_by: row.state_by || me });

const normOk = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_NORM && value === normalize(value);

// An answer as a peer sent it: { uid, kind, norm, at, mode, grade, correct, answer }, or null.
function reviewFromPeer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.uid !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(raw.uid) || !KINDS.includes(raw.kind) || !normOk(raw.norm)) return null;
  if (!time(raw.at) || !MODES.includes(raw.mode) || !GRADES.includes(raw.grade) || typeof raw.correct !== 'boolean') return null;
  if (!(raw.answer === null || raw.answer === undefined || typeof raw.answer === 'string')) return null;
  return { uid: raw.uid, kind: raw.kind, norm: raw.norm, at: raw.at, mode: raw.mode, grade: raw.grade, correct: raw.correct ? 1 : 0, answer: typeof raw.answer === 'string' ? raw.answer.slice(0, MAX_ANSWER) : null };
}
const reviewToPeer = row => ({ uid: row.uid, kind: row.kind, norm: row.norm, at: row.at, mode: row.mode, grade: row.grade, correct: Boolean(row.correct), answer: row.answer === undefined ? null : row.answer });

// A move as a peer sent it: { kind, norm, moved_to, at, by }, or null.
function moveFromPeer(raw, sender) {
  if (!raw || typeof raw !== 'object' || !KINDS.includes(raw.kind) || !normOk(raw.norm) || !normOk(raw.moved_to) || raw.norm === raw.moved_to || !time(raw.at)) return null;
  return { kind: raw.kind, norm: raw.norm, moved_to: raw.moved_to, at: raw.at, by: typeof raw.by === 'string' && INSTANCE_ID.test(raw.by) ? raw.by : sender };
}
const moveToPeer = (row, me) => ({ kind: row.kind, norm: row.norm, moved_to: row.moved_to, at: row.at, by: row.by || me });

// The learning settings of a peer (system_state learn_v1:<owner>), checked: { collect, daily_goal, starter }, or throws INVALID_SYNC_VALUE.
function settingsFromPeer(value, starterLists) {
  const invalid = () => { throw Object.assign(new Error('INVALID_SYNC_VALUE'), { statusCode: 400 }); };
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const out = {};
  if (value.collect !== undefined) { if (typeof value.collect !== 'boolean') invalid(); out.collect = value.collect; }
  if (value.daily_goal !== undefined) { if (!Number.isInteger(value.daily_goal) || value.daily_goal < 1 || value.daily_goal > 200) invalid(); out.daily_goal = value.daily_goal; }
  if (value.starter !== undefined) { if (value.starter !== null && !Object.hasOwn(starterLists, value.starter)) invalid(); out.starter = value.starter; }
  return out;
}

module.exports = {
  later, mergeCard, cardFromPeer, cardToPeer, resolved, reviewFromPeer, reviewToPeer, moveFromPeer, moveToPeer, settingsFromPeer,
  CONTENT, STATE, FIELDS,
};
