// The merge rules of the English learning sync ("Sync across linked devices" in docs/design/learn-english.md): pure functions, no database, no clock.
//
// A card is one per kind and normalized text on every device. It has two versions, each a hybrid clock time and the instance id of the device that
// made it: the content (en, zh, phonetic, source, context, suspended), changed by an edit, and the review state (due_at, interval_days, ease, reps, lapses,
// last_result, last_at, last_correct), changed by an answer. Each half goes to the later version on its own, a tie to the greater instance id, so an
// answer on one device and a meaning edit on another both survive. A meaning or a phonetic transcription is never replaced by an empty one (an older
// peer, schema 14, sends none), and created_at is the earliest.
const { normalize, checkEnglish, KINDS, SOURCES, MODES, AUDIO_SETTINGS, REPORT_SETTINGS, MISTAKE_TAGS, MAX_EXPECTED } = require('./learn');
const { GRADES } = require('./learn-review');
const { cleanPhonetic } = require('./phonetics');

const CONTENT = ['en', 'zh', 'phonetic', 'source', 'context', 'suspended'];
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
    // A moved card's transcription is that of its old text: it never comes over.
    phonetic: content.phonetic || (follow ? '' : other.phonetic) || '',
    ...pick(stateFromPeer ? incoming : local, [...STATE, 'state_at', 'state_by']),
  };
  return { card, changed: FIELDS.some(field => card[field] !== local[field]) };
}

function pick(row, fields) {
  const out = {};
  for (const field of fields) out[field] = row[field] === undefined ? (field === 'phonetic' ? '' : null) : row[field];
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
    kind: raw.kind, norm: normalize(en), en, zh, phonetic: raw.kind === 'word' ? cleanPhonetic(raw.phonetic) : '', source: raw.source, context, suspended: raw.suspended ? 1 : 0,
    created_at: raw.created_at, content_at: raw.content_at, content_by: by(raw.content_by),
    due_at: raw.due_at, interval_days: raw.interval_days, ease: raw.ease, reps: raw.reps, lapses: raw.lapses,
    last_result: raw.last_result, last_at: raw.last_at, last_correct: raw.last_correct === null ? null : (raw.last_correct ? 1 : 0),
    state_at: raw.state_at, state_by: by(raw.state_by),
  };
}

// A card row of this device in the form a peer gets (`me`: this device's instance id, for the versions it made itself, stored as '').
function cardToPeer(row, me) {
  return {
    kind: row.kind, en: row.en, zh: row.zh, phonetic: row.phonetic || '', source: row.source, context: row.context, suspended: Boolean(row.suspended),
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

// An answer as a peer sent it: { uid, kind, norm, at, mode, grade, correct, answer, expected, tag, hinted }, or null. The detail of a wrong answer
// (schema 16) is optional: an older peer sends none, a tag this version does not know is kept as none.
function reviewFromPeer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.uid !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(raw.uid) || !KINDS.includes(raw.kind) || !normOk(raw.norm)) return null;
  if (!time(raw.at) || !MODES.includes(raw.mode) || !GRADES.includes(raw.grade) || typeof raw.correct !== 'boolean') return null;
  if (!(raw.answer === null || raw.answer === undefined || typeof raw.answer === 'string')) return null;
  const expected = typeof raw.expected === 'string' && raw.expected.trim() ? raw.expected.replace(/\s+/g, ' ').trim().slice(0, MAX_EXPECTED) : null;
  return {
    uid: raw.uid, kind: raw.kind, norm: raw.norm, at: raw.at, mode: raw.mode, grade: raw.grade, correct: raw.correct ? 1 : 0,
    answer: typeof raw.answer === 'string' ? raw.answer.slice(0, MAX_ANSWER) : null,
    expected: raw.correct ? null : expected, tag: !raw.correct && MISTAKE_TAGS.includes(raw.tag) ? raw.tag : '', hinted: !raw.correct && raw.hinted === true ? 1 : 0,
  };
}
const reviewToPeer = row => ({
  uid: row.uid, kind: row.kind, norm: row.norm, at: row.at, mode: row.mode, grade: row.grade, correct: Boolean(row.correct), answer: row.answer === undefined ? null : row.answer,
  expected: row.expected || null, tag: row.tag || '', hinted: Boolean(row.hinted),
});

// ---- Mistake reports (schema 16; "Mistake reports" in docs/design/learn-english.md) ----
const REPORT_UID = /^[A-Za-z0-9-]{8,64}$/;
const MAX_REPORT_BODY = 64 * 1024;
const shortText = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
// The body of a report, checked and cut to its sizes: { summary, kinds: [{ kind, count }], findings: [{ title, cause, action, cards: [{ kind, en }] }] },
// or null when it is not one. Used for a report from a peer and (through services/learn-analysis.js) for one made here.
function reportBody(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const summary = shortText(raw.summary, 600);
  if (!summary || !Array.isArray(raw.kinds) || !Array.isArray(raw.findings)) return null;
  const kinds = raw.kinds.slice(0, 20).filter(item => item && typeof item.kind === 'string' && count(item.count))
    .map(item => ({ kind: shortText(item.kind, 40), count: item.count })).filter(item => item.kind);
  const findings = raw.findings.slice(0, 8).filter(item => item && typeof item === 'object').map(item => ({
    title: shortText(item.title, 120), cause: shortText(item.cause, 600), action: shortText(item.action, 600),
    cards: (Array.isArray(item.cards) ? item.cards : []).slice(0, 60).filter(card => card && KINDS.includes(card.kind) && typeof card.en === 'string' && card.en.trim())
      .map(card => ({ kind: card.kind, en: card.en.replace(/\s+/g, ' ').trim().slice(0, 300) })),
  })).filter(item => item.title && (item.cause || item.action));
  return { summary, kinds, findings };
}
// A report as a peer sent it, checked, or null.
function reportFromPeer(raw, sender) {
  if (!raw || typeof raw !== 'object' || typeof raw.uid !== 'string' || !REPORT_UID.test(raw.uid)) return null;
  if (![raw.created_at, raw.covers_from, raw.covers_until].every(time) || raw.covers_from > raw.covers_until || !count(raw.mistakes) || !count(raw.answers)) return null;
  if (JSON.stringify(raw.body || null).length > MAX_REPORT_BODY) return null;
  const body = reportBody(raw.body);
  if (!body) return null;
  return {
    uid: raw.uid, created_at: raw.created_at, covers_from: raw.covers_from, covers_until: raw.covers_until, auto: raw.auto === true ? 1 : 0,
    lang: raw.lang === 'zh' ? 'zh' : 'en', mistakes: raw.mistakes, answers: raw.answers, model: shortText(raw.model, 80), body,
    by: typeof raw.by === 'string' && INSTANCE_ID.test(raw.by) ? raw.by : sender,
  };
}
const reportToPeer = (row, me) => {
  let body = null;
  try { body = JSON.parse(row.body); } catch { body = null; }
  return {
    uid: row.uid, created_at: row.created_at, covers_from: row.covers_from, covers_until: row.covers_until, auto: Boolean(row.auto), lang: row.lang,
    mistakes: row.mistakes, answers: row.answers, model: row.model || '', body, by: row.by || me,
  };
};
// Two engines made a report with the same id (the automatic one of a week, made on both while they could not see each other): the earlier one is
// kept everywhere, a tie to the smaller engine id. True when `incoming` should replace `local`.
const reportWins = (incoming, local) => (incoming.created_at !== local.created_at ? incoming.created_at < local.created_at : String(incoming.by) < String(local.by));

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
  // The audio settings: a value this version does not know is left out (the default here), so a newer peer's choice never stops the sync.
  for (const [key, field] of Object.entries(AUDIO_SETTINGS)) if (field.values.includes(value[key])) out[key] = value[key];
  for (const [key, field] of Object.entries(REPORT_SETTINGS)) if (value[key] !== undefined && field.check(value[key])) out[key] = value[key];
  return out;
}

module.exports = {
  later, mergeCard, cardFromPeer, cardToPeer, resolved, reviewFromPeer, reviewToPeer, moveFromPeer, moveToPeer, settingsFromPeer,
  reportBody, reportFromPeer, reportToPeer, reportWins,
  CONTENT, STATE, FIELDS,
};
