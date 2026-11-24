// The merge rules of the English learning sync ("Sync across linked devices" in docs/design/learn-english.md): pure functions, no database, no clock.
//
// A card is one per kind and normalized text on every device. It has two versions, each a hybrid clock time and the instance id of the device that
// made it: the content (en, zh, phonetic, source, context, suspended), changed by an edit, and the review state (due_at, interval_days, ease, reps, lapses,
// last_result, last_at, last_correct), changed by an answer. Each half goes to the later version on its own, a tie to the greater instance id, so an
// answer on one device and a meaning edit on another both survive. A meaning or a phonetic transcription is never replaced by an empty one (an older
// peer, schema 14, sends none), and created_at is the earliest. Schema 19: the pick of a sentence (picked_level, picked_skipped, picked_at) is a third
// part with its own clock: the later pick wins, and a peer without it (older) sends none, so it never undoes one. Schema 22: the FSRS state
// (fsrs_stability, fsrs_difficulty) is part of the review state; a peer without it (older) sends none, which is kept as NULL (not computed), and
// services/learn-sync.js then recomputes the card from its answers ("Replay, sync and migration" in docs/design/learn-review-fsrs.md). Schema 23: the
// parts and the tip of a word (parts, tip) are content like phonetic: never replaced by empty ones, a moved card's never come over, and a peer without
// them (older) sends none ("Keeps slipping" in docs/design/learn-review-fsrs.md). Schema 25: the Chinese and the origin of a word's context
// (context_zh, context_source: an example sentence of its own) are content that goes with the context, under the same clock, so a sentence written
// on one engine is the one of every engine and an older version never swaps it back. A peer without them (older) sends none: when it sends the same
// context, the ones here are kept ("A sentence for every word" in docs/design/learn-english.md).
const {
  normalize, checkEnglish, KINDS, SOURCES, MODES, AUDIO_SETTINGS, CHECKED_SETTINGS, MISTAKE_TAGS, MAX_EXPECTED, LEVELS, MAX_PICK_CONTEXT, MAX_LEVEL_LABEL, MAX_LEVEL_REASON,
  MAX_ZH: MAX_CARD_ZH, KEPT_SETTINGS, storedParts, checkTip, cleanExtraNew,
} = require('./learn');
const { GRADES } = require('./learn-review');
const { cleanPhonetic } = require('./phonetics');

const CONTENT = ['en', 'zh', 'phonetic', 'parts', 'tip', 'source', 'context', 'context_zh', 'context_source', 'suspended'];
// The origins of a word's context: the person's own text, an example sentence written for it, none (the model gave no good one).
const CONTEXT_SOURCES = ['', 'generated', 'none'];
// The content fields that are '' (not NULL) when a row or a peer has none.
const TEXT_DEFAULT = new Set(['phonetic', 'parts', 'tip', 'context_zh', 'context_source']);
const STATE = ['due_at', 'interval_days', 'ease', 'reps', 'lapses', 'last_result', 'last_at', 'last_correct', 'fsrs_stability', 'fsrs_difficulty'];
const PICKED = ['picked_level', 'picked_skipped', 'picked_at'];
const FIELDS = ['created_at', ...CONTENT, 'content_at', 'content_by', ...STATE, 'state_at', 'state_by', ...PICKED];
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
  // An older peer (no context_source) with the same context: the sentence's Chinese and origin here stay.
  if (incoming.context_source === null && incoming.context === local.context) incoming = { ...incoming, context_zh: local.context_zh || '', context_source: local.context_source || '' };
  const contentFromPeer = !follow && later(incoming.content_at, incoming.content_by, local.content_at, local.content_by);
  const stateFromPeer = later(incoming.state_at, incoming.state_by, local.state_at, local.state_by);
  const content = contentFromPeer ? incoming : local;
  const other = contentFromPeer ? local : incoming;
  // The pick of a moved card was that of its old text: it never comes over.
  const pickedFromPeer = !follow && (int(incoming.picked_at) !== int(local.picked_at) ? int(incoming.picked_at) > int(local.picked_at)
    : String(incoming.picked_level || '') > String(local.picked_level || ''));
  const card = {
    created_at: Math.min(local.created_at, incoming.created_at),
    ...pick(content, [...CONTENT, 'content_at', 'content_by']),
    zh: content.zh || other.zh || '',
    // A moved card's transcription is that of its old text: it never comes over.
    phonetic: content.phonetic || (follow ? '' : other.phonetic) || '',
    // The parts and the tip likewise (they are those of the card's text).
    parts: content.parts || (follow ? '' : other.parts) || '',
    tip: content.tip || (follow ? '' : other.tip) || '',
    ...pick(stateFromPeer ? incoming : local, [...STATE, 'state_at', 'state_by']),
    ...pickedOf(pickedFromPeer ? incoming : local),
  };
  // The same content version with a longer context that starts with the one here: an older version (before schema 19) cut a picked word's sentence to
  // 120 characters; the whole sentence comes back when the version that has it is read again.
  if (!follow && incoming.content_at === local.content_at && incoming.content_by === local.content_by && local.context
    && typeof incoming.context === 'string' && incoming.context.length > local.context.length && incoming.context.startsWith(local.context)) card.context = incoming.context;
  const before = { ...local, ...pickedOf(local) };
  // A field a row does not have (undefined, an older row) and NULL are the same ('' for the text fields of TEXT_DEFAULT).
  const value = (row, field) => (row[field] === undefined || row[field] === null ? (TEXT_DEFAULT.has(field) ? '' : null) : row[field]);
  return { card, changed: FIELDS.some(field => value(card, field) !== value(before, field)) };
}

const int = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const pickedOf = row => ({ picked_level: LEVELS.includes(row.picked_level) ? row.picked_level : '', picked_skipped: int(row.picked_skipped), picked_at: int(row.picked_at) });

function pick(row, fields) {
  const out = {};
  for (const field of fields) out[field] = row[field] === undefined || (row[field] === null && TEXT_DEFAULT.has(field)) ? (TEXT_DEFAULT.has(field) ? '' : null) : row[field];
  return out;
}

const time = value => Number.isSafeInteger(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : null);
// An FSRS value from a peer: a number in its range, else NULL (not computed; also what an older peer, which sends none, gives).
const fsrsValue = (value, min, max) => (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null);

// A card as a peer sent it, checked and made into the local form (norm computed here, suspended and last_correct as 0 / 1), or null when it is not a
// card this version can keep (a text the checks refuse, a field of the wrong type). `sender`: the instance id that sent it, for a version with no device.
function cardFromPeer(raw, sender) {
  if (!raw || typeof raw !== 'object' || !KINDS.includes(raw.kind)) return null;
  let en;
  try { en = checkEnglish(raw.kind, raw.en); } catch { return null; }
  const zh = raw.zh === undefined || raw.zh === null ? '' : text(raw.zh, MAX_ZH);
  // A word picked from a translation has its whole sentence as context (schema 19); other contexts keep the shorter limit.
  const context = raw.context === undefined || raw.context === null ? '' : text(raw.context, raw.kind === 'word' ? MAX_PICK_CONTEXT : MAX_CONTEXT);
  if (zh === null || context === null || !SOURCES.includes(raw.source) || typeof raw.suspended !== 'boolean') return null;
  if (![raw.created_at, raw.content_at, raw.state_at, raw.due_at].every(time) || !(raw.last_at === null || time(raw.last_at))) return null;
  if (!Number.isFinite(raw.interval_days) || raw.interval_days < 0 || raw.interval_days > 400) return null;
  if (!Number.isFinite(raw.ease) || raw.ease < 1 || raw.ease > 10 || !count(raw.reps) || !count(raw.lapses)) return null;
  if (!(raw.last_result === null || GRADES.includes(raw.last_result)) || !(raw.last_correct === null || typeof raw.last_correct === 'boolean')) return null;
  const by = value => (typeof value === 'string' && INSTANCE_ID.test(value) ? value : sender);
  return {
    kind: raw.kind, norm: normalize(en), en, zh, phonetic: raw.kind === 'word' ? cleanPhonetic(raw.phonetic) : '', source: raw.source, context, suspended: raw.suspended ? 1 : 0,
    // Schema 23: parts that do not give the word exactly, or a tip that is not one line of English, are not kept.
    parts: raw.kind === 'word' ? storedParts(en, raw.parts) : '', tip: raw.kind === 'word' ? checkTip(raw.tip) : '',
    // Schema 25: the origin of the context (null: an older peer that sends none, see mergeCard) and the Chinese of a generated sentence.
    ...contextOf(raw, context),
    created_at: raw.created_at, content_at: raw.content_at, content_by: by(raw.content_by),
    due_at: raw.due_at, interval_days: raw.interval_days, ease: raw.ease, reps: raw.reps, lapses: raw.lapses,
    last_result: raw.last_result, last_at: raw.last_at, last_correct: raw.last_correct === null ? null : (raw.last_correct ? 1 : 0),
    fsrs_stability: fsrsValue(raw.fsrs_stability, 0.001, 36500), fsrs_difficulty: fsrsValue(raw.fsrs_difficulty, 1, 10),
    state_at: raw.state_at, state_by: by(raw.state_by),
    // Schema 19: a peer without the pick (an older version) sends none: '' at clock 0, which never wins over a pick here.
    ...(raw.kind === 'sentence' && time(raw.picked_at) ? pickedOf(raw) : { picked_level: '', picked_skipped: 0, picked_at: 0 }),
  };
}

// The origin and the Chinese of a word's context as a peer sent them: { context_zh, context_source }. An origin this version does not know, or a
// generated sentence without its Chinese, counts as the person's own text; none sent (an older peer): context_source null (mergeCard keeps the local).
function contextOf(raw, context) {
  if (raw.context_source === undefined) return { context_zh: '', context_source: raw.kind === 'word' ? null : '' };
  if (raw.kind !== 'word') return { context_zh: '', context_source: '' };
  if (!context) return { context_zh: '', context_source: raw.context_source === 'none' ? 'none' : '' };
  const zh = raw.context_source === 'generated' ? text(raw.context_zh, MAX_ZH) : '';
  return zh ? { context_zh: zh, context_source: 'generated' } : { context_zh: '', context_source: '' };
}

// A card row of this device in the form a peer gets (`me`: this device's instance id, for the versions it made itself, stored as '').
function cardToPeer(row, me) {
  return {
    kind: row.kind, en: row.en, zh: row.zh, phonetic: row.phonetic || '', parts: row.parts || '', tip: row.tip || '', source: row.source, context: row.context,
    context_zh: row.context_zh || '', context_source: row.context_source || '',
    suspended: Boolean(row.suspended), created_at: row.created_at, content_at: row.content_at, content_by: row.content_by || me,
    due_at: row.due_at, interval_days: row.interval_days, ease: row.ease, reps: row.reps, lapses: row.lapses,
    last_result: row.last_result || null, last_at: row.last_at === null || row.last_at === undefined ? null : row.last_at,
    last_correct: row.last_correct === null || row.last_correct === undefined ? null : Boolean(row.last_correct),
    fsrs_stability: Number.isFinite(row.fsrs_stability) ? row.fsrs_stability : null, fsrs_difficulty: Number.isFinite(row.fsrs_difficulty) ? row.fsrs_difficulty : null,
    state_at: row.state_at, state_by: row.state_by || me,
    picked_level: row.picked_level || '', picked_skipped: int(row.picked_skipped), picked_at: int(row.picked_at),
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

// ---- The questions about a card (schema 20; "Ask about a question" in docs/design/learn-english.md) ----
// A message is made once and never changed: a union by uid. Its card is named by kind and normalized text, like an answer's.
const CHAT_UID = /^[A-Za-z0-9-]{8,64}$/;
const MAX_QUESTION = 500;
const MAX_CHAT_TEXT = 2000;
// A message as a peer sent it: { uid, kind, norm, role, text, at, by }, or null (a question is cut to 500 characters, an answer to 2000).
function chatFromPeer(raw, sender) {
  if (!raw || typeof raw !== 'object' || typeof raw.uid !== 'string' || !CHAT_UID.test(raw.uid) || !KINDS.includes(raw.kind) || !normOk(raw.norm)) return null;
  if (raw.role !== 'user' && raw.role !== 'assistant') return null;
  if (typeof raw.text !== 'string' || !raw.text.trim() || !time(raw.at)) return null;
  return {
    uid: raw.uid, kind: raw.kind, norm: raw.norm, role: raw.role, text: raw.text.trim().slice(0, raw.role === 'user' ? MAX_QUESTION : MAX_CHAT_TEXT), at: raw.at,
    by: typeof raw.by === 'string' && INSTANCE_ID.test(raw.by) ? raw.by : sender,
  };
}
const chatToPeer = (row, me) => ({ uid: row.uid, kind: row.kind, norm: row.norm, role: row.role, text: row.text, at: row.at, by: row.by || me });

// ---- The English chats (schema 21; "Sync" in docs/design/learn-english-chat.md) ----
// A chat (learn_convos) has three parts with their own clocks: the title (the newer wins, a tie to the greater title), the journal flag (the person's
// choice always wins over the model's, then the newer, then on), and the tombstone (the newer delete or prune). updated_at is the newest message,
// created_at the earliest. The chat is deleted while its newest tombstone is newer than its newest message, except that a prune never removes a
// journal chat: so a message written elsewhere after a delete or a prune brings the chat back, and nothing newer than a tombstone is lost.
// Messages are made once and never changed: a union by uid.
const MAX_CONVO_QUESTION = 4000;
const MAX_CONVO_ANSWER = 6000;
const MAX_CONVO_TITLE = 60;
const MAX_META_CARDS = 5;
const MAX_META_MISTAKES = 5;
const MAX_META_EN = 300;
const MAX_MISTAKE_TAG = 80;
const JOURNAL_BY = ['', 'model', 'person'];
const DELETED_BY = ['', 'prune', 'person'];
const collapseText = value => String(value).replace(/\s+/g, ' ').trim();
const straight = value => String(value).replace(/[\u2018\u2019]/g, "'").toLowerCase();

// A title as it is kept: one line, 1..60 characters, else ''.
function convoTitle(value) {
  if (typeof value !== 'string') return '';
  const title = collapseText(value);
  return title.length <= MAX_CONVO_TITLE ? title : '';
}

// The meta of an answer, checked against the answer's `text`: { cards: [{ kind, en, zh }], mistakes: [tag], journal? }. A card: kind word | sentence,
// `en` as written (one line, 1..300 characters) that the card rules accept (services/learn.js checkEnglish: the word rule for a word) and that is in
// the answer (ignoring case), `zh` 1..500 characters, each card once, at most 5. A mistake tag: one line of 1..80 characters, each once, at most 5.
// What does not check is dropped; anything that is not an object is no meta at all.
function cleanMeta(raw, text) {
  const out = { cards: [], mistakes: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const answer = straight(text || '');
  const seen = new Set();
  for (const card of Array.isArray(raw.cards) ? raw.cards : []) {
    if (out.cards.length >= MAX_META_CARDS) break;
    if (!card || typeof card !== 'object' || !KINDS.includes(card.kind) || typeof card.en !== 'string' || typeof card.zh !== 'string') continue;
    const en = collapseText(card.en);
    const zh = card.zh.trim();
    if (!en || en.length > MAX_META_EN || !zh || zh.length > MAX_CARD_ZH || !answer.includes(straight(en))) continue;
    let norm;
    try { norm = normalize(checkEnglish(card.kind, en)); } catch { continue; }
    if (seen.has(`${card.kind}|${norm}`)) continue;
    seen.add(`${card.kind}|${norm}`);
    out.cards.push({ kind: card.kind, en, zh });
  }
  for (const tag of Array.isArray(raw.mistakes) ? raw.mistakes : []) {
    if (out.mistakes.length >= MAX_META_MISTAKES) break;
    if (typeof tag !== 'string') continue;
    const value = collapseText(tag);
    if (value && value.length <= MAX_MISTAKE_TAG && !out.mistakes.includes(value)) out.mistakes.push(value);
  }
  if (raw.journal === true) out.journal = true;
  return out;
}

// Whether a chat with these fields is deleted (see above).
const convoDeleted = convo => convo.deleted_at > 0 && convo.deleted_at > convo.updated_at && !(convo.deleted_by === 'prune' && convo.journal);

// A chat as a peer sent it, checked, or null: { uid, title, title_at, journal (0 / 1), journal_by, journal_at, created_at, updated_at, deleted_at,
// deleted_by, by } (`deleted` is computed by mergeConvo).
function convoFromPeer(raw, sender) {
  if (!raw || typeof raw !== 'object' || typeof raw.uid !== 'string' || !convoUid(raw.uid)) return null;
  if (![raw.title_at, raw.journal_at, raw.created_at, raw.updated_at, raw.deleted_at].every(time) || typeof raw.journal !== 'boolean') return null;
  if (!JOURNAL_BY.includes(raw.journal_by) || !DELETED_BY.includes(raw.deleted_by) || typeof raw.title !== 'string') return null;
  return {
    uid: raw.uid, title: convoTitle(raw.title), title_at: raw.title_at, journal: raw.journal ? 1 : 0, journal_by: raw.journal_by, journal_at: raw.journal_at,
    created_at: raw.created_at, updated_at: raw.updated_at, deleted: raw.deleted === true, deleted_at: raw.deleted_at, deleted_by: raw.deleted_by,
    by: typeof raw.by === 'string' && INSTANCE_ID.test(raw.by) ? raw.by : sender,
  };
}
const convoToPeer = (row, me) => ({
  uid: row.uid, title: row.title, title_at: row.title_at, journal: Boolean(row.journal), journal_by: row.journal_by, journal_at: row.journal_at,
  created_at: row.created_at, updated_at: row.updated_at, deleted: Boolean(row.deleted), deleted_at: row.deleted_at, deleted_by: row.deleted_by, by: row.by || me,
});

const CONVO_FIELDS = ['title', 'title_at', 'journal', 'journal_by', 'journal_at', 'created_at', 'updated_at', 'deleted', 'deleted_at', 'deleted_by'];
// The merge of a local chat (or null) and one from a peer: { convo, changed }, the merged fields of CONVO_FIELDS.
function mergeConvo(local, incoming) {
  const base = local || { ...incoming, title: '', title_at: -1, journal: 0, journal_by: '', journal_at: -1, deleted_at: 0, deleted_by: '' };
  const titleFromPeer = later(incoming.title_at, incoming.title, base.title_at, base.title);
  const rank = convo => JOURNAL_BY.indexOf(convo.journal_by);
  const journalFromPeer = rank(incoming) !== rank(base) ? rank(incoming) > rank(base)
    : incoming.journal_at !== base.journal_at ? incoming.journal_at > base.journal_at : incoming.journal > base.journal;
  const tombFromPeer = incoming.deleted_at !== base.deleted_at ? incoming.deleted_at > base.deleted_at
    : DELETED_BY.indexOf(incoming.deleted_by) > DELETED_BY.indexOf(base.deleted_by);
  const convo = {
    ...pick(titleFromPeer ? incoming : base, ['title', 'title_at']),
    ...pick(journalFromPeer ? incoming : base, ['journal', 'journal_by', 'journal_at']),
    ...pick(tombFromPeer ? incoming : base, ['deleted_at', 'deleted_by']),
    created_at: local ? Math.min(local.created_at, incoming.created_at) : incoming.created_at,
    updated_at: local ? Math.max(local.updated_at, incoming.updated_at) : incoming.updated_at,
  };
  if (convo.title_at < 0) { convo.title = ''; convo.title_at = 0; }
  if (convo.journal_at < 0) convo.journal_at = 0;
  convo.deleted = convoDeleted(convo) ? 1 : 0;
  return { convo, changed: !local || CONVO_FIELDS.some(field => convo[field] !== local[field]) };
}

// A message of a chat as a peer sent it, checked, or null: { uid, convo_uid, role, text, at, meta (JSON text, '' for a question), by }.
// The coach conversation (docs/design/learn-english-coach.md) also has `practice` messages (a practice result the page sent; never typed by the
// person), and its meta is the coach's (cleanCoachMeta).
function convoMessageFromPeer(raw, sender) {
  if (!raw || typeof raw !== 'object' || typeof raw.uid !== 'string' || !CHAT_UID.test(raw.uid) || typeof raw.convo_uid !== 'string' || !convoUid(raw.convo_uid)) return null;
  const coach = raw.convo_uid === COACH_UID;
  if (!(raw.role === 'user' || raw.role === 'assistant' || (coach && raw.role === 'practice')) || typeof raw.text !== 'string' || !raw.text.trim() || !time(raw.at)) return null;
  const text = raw.text.trim().slice(0, raw.role === 'assistant' ? MAX_CONVO_ANSWER : MAX_CONVO_QUESTION);
  let meta = '';
  if (coach && raw.role !== 'user') meta = JSON.stringify(cleanCoachMeta(raw.meta, text, raw.role));
  else if (raw.role === 'assistant') meta = JSON.stringify(cleanMeta(raw.meta, text));
  return { uid: raw.uid, convo_uid: raw.convo_uid, role: raw.role, text, at: raw.at, meta, by: typeof raw.by === 'string' && INSTANCE_ID.test(raw.by) ? raw.by : sender };
}
const parseMeta = value => { try { return value ? JSON.parse(value) : null; } catch { return null; } };
const convoMessageToPeer = (row, me) => ({
  uid: row.uid, convo_uid: row.convo_uid, role: row.role, text: row.text, at: row.at, meta: row.role === 'user' ? null : parseMeta(row.meta), by: row.by || me,
});

// ---- The English coach (schema 24; "Storage" and "Sync" in docs/design/learn-english-coach.md) ----
const COACH_UID = 'coach';
const convoUid = value => value === COACH_UID || CHAT_UID.test(value);
const PROPOSAL_ID = /^[A-Za-z0-9-]{8,64}$/;
const PROPOSAL_KINDS = ['practice', 'settings', 'cards', 'reminder'];
const PROPOSAL_STATES = ['open', 'done', 'cancelled', 'undone'];
// The coach offers word spelling only (today's spelling, review, mistakes, new words); `dictation` and `fill_gap` stay readable for plans saved before.
const OFFER_KINDS = ['today_spelling', 'review', 'mistakes_series', 'more_new_words'];
const PLAN_KINDS = [...OFFER_KINDS, 'dictation', 'fill_gap'];
const STEP_MODES = ['spell', 'fill', 'dictation', 'retest', 'review'];
// The screens of Learn a coach answer can open with a button (the tool open_screen; "Screens the coach opens" in docs/design/learn-english-coach.md).
// The screens the coach may open now: practice is word spelling only; the other modes stay readable for answers saved before (`READABLE_SCREENS`).
const COACH_SCREENS = ['mistakes', 'reports', 'progress', 'material', 'settings', 'how', 'spell'];
const READABLE_SCREENS = [...COACH_SCREENS, 'review', 'practice', 'dictation', 'fill', 'say'];
const MAX_SUGGESTIONS = 4;
const MAX_SUGGESTION = 60;
const MAX_BATCH = 50;
const MAX_NOTE = 200;
const MAX_SUMMARY = 3000;
// The learning settings a coach may propose to change (what the person could change in Learn settings; never the coach's own switches).
const COACH_CHANGES = ['new_per_day', 'daily_goal', 'desired_retention', 'audio_words', 'audio_sentences', 'audio_sentences_at', 'audio_repeat', 'audio_pause', 'audio_speed',
  'audio_stop_on_typing', 'collect', 'pick_words', 'analysis_auto'];
const settingOk = (key, value) => {
  if (key === 'daily_goal') return Number.isInteger(value) && value >= 1 && value <= 200;
  if (key === 'collect') return typeof value === 'boolean';
  if (AUDIO_SETTINGS[key]) return AUDIO_SETTINGS[key].values.includes(value);
  return Boolean(CHECKED_SETTINGS[key]) && CHECKED_SETTINGS[key].check(value);
};
// A batch of setting changes, checked: { key: value } with only COACH_CHANGES keys and allowed values, or null.
function cleanChanges(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [key, value] of Object.entries(raw)) if (COACH_CHANGES.includes(key) && settingOk(key, value)) out[key] = value;
  return Object.keys(out).length ? out : null;
}
const oneLine = (value, max) => (typeof value === 'string' ? collapseText(value).slice(0, max) : '');
const cardRefOf = raw => {
  if (!raw || typeof raw !== 'object' || !KINDS.includes(raw.kind)) return null;
  try { return { kind: raw.kind, en: checkEnglish(raw.kind, raw.en) }; } catch { return null; }
};
const ids = (value, max) => (Array.isArray(value) ? value.filter(id => Number.isSafeInteger(id) && id > 0).slice(0, max) : []);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// A plan of a practice series (services/learn-plan.js buildPlan), checked, or null.
function cleanPlan(raw) {
  if (!raw || typeof raw !== 'object' || !PLAN_KINDS.includes(raw.kind)) return null;
  const steps = (Array.isArray(raw.steps) ? raw.steps : []).slice(0, 6).filter(step => step && STEP_MODES.includes(step.mode))
    .map(step => ({ mode: step.mode, card_ids: ids(step.card_ids, 200) }));
  return {
    kind: raw.kind, title: oneLine(raw.title, 80), steps, words: count(raw.words) ? Math.min(raw.words, 500) : 0, minutes: count(raw.minutes) ? Math.min(raw.minutes, 600) : 0,
    notes: oneLine(raw.notes, 300), ...(count(raw.count) && raw.count > 0 ? { count: Math.min(raw.count, 50) } : {}),
    ...(Array.isArray(raw.words_list) ? { words_list: raw.words_list.filter(word => typeof word === 'string' && word.trim()).slice(0, MAX_BATCH).map(word => oneLine(word, 40)) } : {}),
  };
}

// A proposal of a coach answer, checked: { id, kind, state, state_at, ...payload }, or null.
function cleanProposal(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !PROPOSAL_ID.test(raw.id) || !PROPOSAL_KINDS.includes(raw.kind)) return null;
  const base = { id: raw.id, kind: raw.kind, state: PROPOSAL_STATES.includes(raw.state) ? raw.state : 'open', state_at: time(raw.state_at) ? raw.state_at : 0 };
  // `auto`: a small change the page runs at once (with Undo) instead of waiting for a tap: a settings change, or cards added / changed without a removal.
  if (raw.auto === true && (raw.kind === 'settings' || (raw.kind === 'cards' && !(Array.isArray(raw.remove) && raw.remove.length)))) base.auto = true;
  if (raw.kind === 'practice') {
    const plan = cleanPlan(raw.plan);
    return plan ? { ...base, plan } : null;
  }
  if (raw.kind === 'settings') {
    const changes = cleanChanges(raw.changes);
    if (!changes) return null;
    const before = cleanChanges(raw.before) || {};
    return { ...base, changes, before };
  }
  if (raw.kind === 'cards') {
    const add = [];
    for (const card of Array.isArray(raw.add) ? raw.add.slice(0, MAX_BATCH) : []) {
      const ref = cardRefOf(card);
      const zh = card && typeof card.zh === 'string' ? card.zh.trim().slice(0, MAX_CARD_ZH) : '';
      if (ref) add.push({ ...ref, zh });
    }
    const update = [];
    for (const card of Array.isArray(raw.update) ? raw.update.slice(0, MAX_BATCH) : []) {
      const ref = cardRefOf(card);
      const zh = card && typeof card.zh === 'string' ? card.zh.trim().slice(0, MAX_CARD_ZH) : '';
      if (ref && zh) update.push({ ...ref, zh, before: card && typeof card.before === 'string' ? card.before.slice(0, MAX_CARD_ZH) : '' });
    }
    const remove = (Array.isArray(raw.remove) ? raw.remove.slice(0, MAX_BATCH) : []).map(cardRefOf).filter(Boolean);
    if (!add.length && !update.length && !remove.length) return null;
    return { ...base, add, update, remove };
  }
  // reminder
  if (typeof raw.time !== 'string' || !HHMM.test(raw.time)) return null;
  const days = Array.isArray(raw.days) ? [...new Set(raw.days.filter(day => Number.isInteger(day) && day >= 1 && day <= 7))].sort((a, b) => a - b) : [];
  const text = oneLine(raw.text, 120);
  if (!text) return null;
  return { ...base, time: raw.time, days, text, ...(typeof raw.tz === 'string' && raw.tz.length <= 64 ? { tz: raw.tz } : {}) };
}

// A practice result (the page's summary of a series), checked.
function cleanPractice(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const num = (field, max) => (count(value[field]) ? Math.min(value[field], max) : 0);
  return {
    plan_id: typeof value.plan_id === 'string' && PROPOSAL_ID.test(value.plan_id) ? value.plan_id : '',
    kind: PLAN_KINDS.includes(value.kind) ? value.kind : '',
    done: num('done', 1000), total: num('total', 1000), right: num('right', 1000), seconds: num('seconds', 86400),
    stopped: value.stopped === true,
    steps: (Array.isArray(value.steps) ? value.steps : []).slice(0, 6).filter(step => step && STEP_MODES.includes(step.mode))
      .map(step => ({ mode: step.mode, done: count(step.done) ? Math.min(step.done, 1000) : 0, right: count(step.right) ? Math.min(step.right, 1000) : 0 })),
    missed: (Array.isArray(value.missed) ? value.missed : []).slice(0, 50).filter(item => item && typeof item.en === 'string' && item.en.trim())
      .map(item => ({ en: oneLine(item.en, 300), typed: typeof item.typed === 'string' ? oneLine(item.typed, 300) : '' })),
  };
}

// The meta of a message of the coach conversation: an assistant answer { cards, mistakes, suggestions, proposals, remembered, tools, usage, notice? }
// (cards and mistakes as cleanMeta), a practice result { practice }. What does not check is dropped.
function cleanCoachMeta(raw, text, role = 'assistant') {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (role === 'practice') return { practice: cleanPractice(value.practice) };
  const out = cleanMeta(value, text);
  out.suggestions = [];
  for (const item of Array.isArray(value.suggestions) ? value.suggestions : []) {
    const line = oneLine(item, MAX_SUGGESTION);
    if (line && !out.suggestions.includes(line) && out.suggestions.length < MAX_SUGGESTIONS) out.suggestions.push(line);
  }
  const seen = new Set();
  out.proposals = (Array.isArray(value.proposals) ? value.proposals : []).slice(0, 8).map(cleanProposal).filter(item => item && !seen.has(item.id) && seen.add(item.id));
  out.remembered = (Array.isArray(value.remembered) ? value.remembered : []).slice(0, 5).filter(note => note && typeof note.uid === 'string' && CHAT_UID.test(note.uid))
    .map(note => ({ uid: note.uid, text: oneLine(note.text, MAX_NOTE), until: noteUntil(note.until) }));
  out.screens = [...new Set((Array.isArray(value.screens) ? value.screens : []).filter(screen => READABLE_SCREENS.includes(screen)))].slice(0, 3);
  out.tools = value.tools !== false;
  if (value.usage && typeof value.usage === 'object') {
    const usage = {};
    for (const key of ['calls', 'tool_rounds', 'prompt_tokens', 'completion_tokens']) if (count(value.usage[key])) usage[key] = value.usage[key];
    if (Object.keys(usage).length) out.usage = usage;
  }
  const notice = oneLine(value.notice, 200);
  if (notice) out.notice = notice;
  return out;
}

// Two metas of one coach answer (here and from a peer): everything as it was made, except the state of each proposal, where the newer state wins
// (a tie to the later state in PROPOSAL_STATES). Returns { meta, changed }.
function mergeCoachMeta(local, incoming) {
  const base = local && typeof local === 'object' ? local : {};
  const theirs = new Map((incoming && Array.isArray(incoming.proposals) ? incoming.proposals : []).map(item => [item.id, item]));
  let changed = false;
  const proposals = (Array.isArray(base.proposals) ? base.proposals : []).map(item => {
    const other = theirs.get(item.id);
    if (!other) return item;
    const newer = other.state_at !== item.state_at ? other.state_at > item.state_at : PROPOSAL_STATES.indexOf(other.state) > PROPOSAL_STATES.indexOf(item.state);
    if (!newer || other.state === item.state) return item;
    changed = true;
    return { ...item, state: other.state, state_at: other.state_at };
  });
  return { meta: { ...base, proposals }, changed };
}

// ---- The coach's notes ----
// The secrets a note never keeps: passwords, tokens, API keys, private keys, card numbers and long random strings.
const SECRET = [
  /pass(?:word|wd|code)|\bpwd\b|\u5bc6\u7801|\u53e3\u4ee4/i, /\btoken\b|\bsecret\b|api[ _-]?key|private[ _-]?key|access[ _-]?key|\u5bc6\u94a5/i,
  /\b(?:sk|pk|rk|ghp|gho|ghs|xox[abps])[-_][A-Za-z0-9_-]{8,}/, /\bAKIA[0-9A-Z]{12,}/, /-----BEGIN/,
  /\b(?:\d[ -]?){13,19}\b/, /[A-Za-z0-9+/_-]{32,}/,
];
const looksSecret = value => SECRET.some(pattern => pattern.test(value));
// A note's `until`: a real date YYYY-MM-DD, else null.
function noteUntil(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}
// The text of a note: one line of 1..200 characters without a secret, else '' (with `reason`: 'empty' | 'long' | 'secret').
function noteText(value) {
  if (typeof value !== 'string') return { text: '', reason: 'empty' };
  const text = collapseText(value);
  if (!text) return { text: '', reason: 'empty' };
  if (text.length > MAX_NOTE) return { text: '', reason: 'long' };
  if (looksSecret(text)) return { text: '', reason: 'secret' };
  return { text, reason: '' };
}
// A note as a peer sent it, checked, or null: { uid, text, until, created_at, updated_at, deleted (0 / 1), by }. A note with a secret (an older
// rule let it through) is not kept.
function noteFromPeer(raw, sender) {
  if (!raw || typeof raw !== 'object' || typeof raw.uid !== 'string' || !CHAT_UID.test(raw.uid) || !time(raw.created_at) || !time(raw.updated_at)) return null;
  const deleted = raw.deleted === true;
  const checked = noteText(raw.text);
  if (!deleted && !checked.text) return null;
  return {
    uid: raw.uid, text: deleted ? '' : checked.text, until: deleted ? null : noteUntil(raw.until), created_at: raw.created_at, updated_at: raw.updated_at,
    deleted: deleted ? 1 : 0, by: typeof raw.by === 'string' && INSTANCE_ID.test(raw.by) ? raw.by : sender,
  };
}
const noteToPeer = (row, me) => ({
  uid: row.uid, text: row.text, until: row.until || null, created_at: row.created_at, updated_at: row.updated_at, deleted: Boolean(row.deleted), by: row.by || me,
});
// Whether the note from a peer replaces the one here (both with `by` filled in): the newer change; at a tie a tombstone, then the greater engine id.
function noteWins(incoming, local) {
  if (!local) return true;
  if (incoming.updated_at !== local.updated_at) return incoming.updated_at > local.updated_at;
  if (incoming.deleted !== local.deleted) return incoming.deleted > local.deleted;
  return String(incoming.by) > String(local.by) && (incoming.text !== local.text || incoming.until !== local.until);
}

// ---- The rolling summary ----
// A summary as a peer sent it, checked, or null: { text, covers_at, updated_at, reset_at, by }.
function summaryFromPeer(raw, sender) {
  if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string' || ![raw.covers_at, raw.updated_at, raw.reset_at].every(time)) return null;
  return {
    text: raw.text.trim().slice(0, MAX_SUMMARY), covers_at: raw.covers_at, updated_at: raw.updated_at, reset_at: raw.reset_at,
    by: typeof raw.by === 'string' && INSTANCE_ID.test(raw.by) ? raw.by : sender,
  };
}
const summaryToPeer = (row, me) => ({ text: row.text, covers_at: row.covers_at, updated_at: row.updated_at, reset_at: row.reset_at, by: row.by || me });
// The merge of the summary here (or null) and a peer's: the newest reset of both holds; a summary folded before it is void (empty, covering
// nothing); of the others the one that covers the newer message wins, then the newer fold, then the greater engine id. Returns the merged row.
function mergeSummary(local, incoming) {
  const resetAt = Math.max(local ? local.reset_at : 0, incoming.reset_at);
  const valid = row => (row && row.updated_at >= resetAt && row.text ? row : null);
  const a = valid(local);
  const b = valid(incoming);
  let best = a || b;
  if (a && b) {
    const newer = b.covers_at !== a.covers_at ? b.covers_at > a.covers_at : b.updated_at !== a.updated_at ? b.updated_at > a.updated_at : String(b.by) > String(a.by);
    best = newer ? b : a;
  }
  if (!best) return { text: '', covers_at: 0, updated_at: Math.max(local ? local.updated_at : 0, incoming.updated_at), reset_at: resetAt, by: incoming.reset_at >= (local ? local.reset_at : 0) ? incoming.by : local.by };
  return { text: best.text, covers_at: best.covers_at, updated_at: best.updated_at, reset_at: resetAt, by: best.by };
}

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
  for (const [key, field] of Object.entries(CHECKED_SETTINGS)) if (value[key] !== undefined && field.check(value[key])) out[key] = value[key];
  // The new words added for a day (schema of the value: services/learn.js cleanExtraNew); one that is not valid is left out.
  if (value.extra_new !== undefined && cleanExtraNew(value.extra_new).day) out.extra_new = cleanExtraNew(value.extra_new);
  return out;
}

// The estimated level of a peer ("Your level" in docs/design/learn-english.md): { level, label, reason, answers, mistakes, report_at, updated_at }
// checked, or null when it is not one (it is then not applied).
function levelFromPeer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !LEVELS.includes(value.level)) return null;
  const label = typeof value.label === 'string' ? value.label.replace(/\s+/g, ' ').trim().slice(0, MAX_LEVEL_LABEL) : '';
  const reason = typeof value.reason === 'string' ? value.reason.replace(/\s+/g, ' ').trim().slice(0, MAX_LEVEL_REASON) : '';
  if (!label || !reason || !count(value.answers) || !count(value.mistakes) || !time(value.updated_at)) return null;
  if (!(value.report_at === null || value.report_at === undefined || time(value.report_at))) return null;
  return { level: value.level, label, reason, answers: value.answers, mistakes: value.mistakes, report_at: time(value.report_at) ? value.report_at : null, updated_at: value.updated_at };
}

module.exports = {
  later, mergeCard, cardFromPeer, cardToPeer, resolved, reviewFromPeer, reviewToPeer, moveFromPeer, moveToPeer, settingsFromPeer, levelFromPeer,
  reportBody, reportFromPeer, reportToPeer, reportWins, chatFromPeer, chatToPeer, MAX_QUESTION, MAX_CHAT_TEXT,
  cleanMeta, convoTitle, convoDeleted, convoFromPeer, convoToPeer, mergeConvo, convoMessageFromPeer, convoMessageToPeer, parseMeta,
  MAX_CONVO_QUESTION, MAX_CONVO_ANSWER, MAX_CONVO_TITLE, MAX_META_CARDS, MAX_META_MISTAKES, MAX_MISTAKE_TAG,
  COACH_UID, COACH_SCREENS, READABLE_SCREENS, PROPOSAL_KINDS, PROPOSAL_STATES, PLAN_KINDS, OFFER_KINDS, STEP_MODES, COACH_CHANGES, MAX_NOTE, MAX_SUMMARY, MAX_BATCH, cleanChanges, cleanPlan, cleanProposal, cleanPractice,
  cleanCoachMeta, mergeCoachMeta, looksSecret, noteUntil, noteText, noteFromPeer, noteToPeer, noteWins, summaryFromPeer, summaryToPeer, mergeSummary,
  CONTENT, STATE, PICKED, FIELDS, KEPT_SETTINGS, CONTEXT_SOURCES,
};
