// Spaced review of English learning cards with FSRS-6 ("Review rules" in docs/design/learn-review-fsrs.md): pure functions, no database, no clock of
// their own. services/learn.js stores what they return; services/learn-schedule.js replays a card's answers through them. Times are milliseconds since
// 1970; intervals are days. The memory model itself (stability, difficulty, the forgetting curve) is services/learn-fsrs.js.
//
// - Grades: again / hard / good are the FSRS ratings 1 / 2 / 3 (this app has no Easy).
// - again keeps a relearning step: the card is due again in 10 minutes (interval 0) with the stability after forgetting; the answer after it is a
//   same-day review (the short-term formula) and schedules it by FSRS again.
// - hard / good: the interval of the new stability at the desired retention, whole days, at least 1, at most MAX_INTERVAL; due = answer time +
//   that many days. No fuzz, and no "good after hard" ordering between the grades: the interval depends on the stability alone, so replaying the
//   answers or rescheduling from the stored stability gives the same due date (the deterministic rule of the sync).
// - Elapsed days: whole 24-hour days since the previous answer (floor). ts-fsrs counts UTC calendar days; whole days are the same on every engine
//   whatever its clock's time zone, and less than a day is the same-day review of FSRS.
// - ease is no longer used for the schedule: it is kept unchanged (older versions in the sync still read it).
const fsrs = require('./learn-fsrs');

const DAY = 24 * 60 * 60 * 1000;
const AGAIN_MS = 10 * 60 * 1000; // "again": shown again in 10 minutes
const EASE_START = 2.5;
const MAX_INTERVAL = 365;
const GRADES = ['again', 'hard', 'good'];
const RATINGS = Object.freeze({ again: 1, hard: 2, good: 3 });
const MISTAKE_DAYS = 30;
// The desired retention (the Learn setting `desired_retention`): the probability of recall a card is scheduled at.
const RETENTIONS = Object.freeze([0.85, 0.9, 0.95]);
const DEFAULT_RETENTION = 0.9;
const retentionOf = value => (RETENTIONS.includes(value) ? value : DEFAULT_RETENTION);

const finite = value => typeof value === 'number' && Number.isFinite(value);
const elapsedDays = (from, to) => Math.max(0, Math.floor((to - from) / DAY));

// The stored FSRS state of a card, or null when it has none (fsrs_stability / fsrs_difficulty NULL).
function storedMemory(card) {
  if (!card || !finite(card.fsrs_stability) || !finite(card.fsrs_difficulty)) return null;
  if (card.fsrs_stability < fsrs.S_MIN || card.fsrs_difficulty < 1) return null;
  return { stability: card.fsrs_stability, difficulty: card.fsrs_difficulty };
}
// An estimate from the older review state, for a card answered before whose answers are not all here (a company computer's cache, a state from an
// older peer whose answers did not arrive yet): stability = the interval (at retention 0.9 the interval is the stability), the first "again"
// stability when the interval is 0; difficulty from the ease, 2.5 -> D0(good), 1.3 -> 10.
function legacyMemory(card) {
  const goodD = fsrs.clamp(fsrs.initDifficulty(RATINGS.good), 1, 10);
  const ease = finite(card.ease) ? card.ease : EASE_START;
  const stability = finite(card.interval_days) && card.interval_days > 0 ? card.interval_days : fsrs.initStability(RATINGS.again);
  return { stability: fsrs.roundTo(stability, 8), difficulty: fsrs.roundTo(fsrs.clamp(goodD + ((EASE_START - ease) * (10 - goodD)) / 1.2, 1, 10), 8) };
}
// The memory state an answer builds on: the stored one, else none for a card never answered, else the estimate.
function memoryOf(card) {
  const stored = storedMemory(card);
  if (stored) return stored;
  if (!(card.reps > 0) || !finite(card.last_at)) return null;
  return legacyMemory(card);
}

// The schedule after an answer with `grade` at time `at` that left `stability`: { interval_days, due_at }.
function scheduleFor(grade, stability, at, retention) {
  if (grade === 'again') return { interval_days: 0, due_at: at + AGAIN_MS };
  const days = fsrs.nextInterval(stability, retentionOf(retention), { maxInterval: MAX_INTERVAL });
  return { interval_days: days, due_at: at + days * DAY };
}

// The scheduling fields of a card after one answer: { due_at, interval_days, ease, reps, lapses, last_result, last_at, last_correct, fsrs_stability,
// fsrs_difficulty }. `retention`: the desired retention (default 0.9).
function applyAnswer(card, grade, correct, now, { retention = DEFAULT_RETENTION } = {}) {
  if (!GRADES.includes(grade)) throw new Error(`Unknown grade: ${grade}`);
  const memory = memoryOf(card);
  const t = memory ? elapsedDays(card.last_at, now) : 0;
  const next = fsrs.nextState(memory, t, RATINGS[grade]);
  return {
    ...scheduleFor(grade, next.stability, now, retention),
    ease: finite(card.ease) && card.ease > 0 ? card.ease : EASE_START,
    reps: (card.reps || 0) + 1, lapses: (card.lapses || 0) + (grade === 'again' ? 1 : 0),
    last_result: grade, last_at: now, last_correct: correct ? 1 : 0,
    fsrs_stability: next.stability, fsrs_difficulty: next.difficulty,
  };
}

// The order answers are replayed in: by time, a tie by uid (the same on every engine).
const answerOrder = (a, b) => (a.at - b.at) || (String(a.uid || '') < String(b.uid || '') ? -1 : String(a.uid || '') > String(b.uid || '') ? 1 : 0);
// The state of a card from its answers [{ at, grade, correct, uid }] alone, from a new card: the fields of applyAnswer, or null for no answers.
// `ease`: the card's ease, kept as it is.
function replay(answers, { retention = DEFAULT_RETENTION, ease = EASE_START } = {}) {
  const list = (answers || []).filter(answer => GRADES.includes(answer.grade) && finite(answer.at)).sort(answerOrder);
  if (!list.length) return null;
  let card = { reps: 0, lapses: 0, ease, last_at: null, fsrs_stability: null, fsrs_difficulty: null };
  for (const answer of list) card = { ...card, ...applyAnswer(card, answer.grade, Boolean(answer.correct), answer.at, { retention }) };
  return card;
}

// The due date of a card with a stored stability at another desired retention, from its last answer: { interval_days, due_at }, or null when it
// has no FSRS state. A card whose last answer was "again" keeps its 10 minutes.
function rescheduled(card, retention) {
  const memory = storedMemory(card);
  if (!memory || !finite(card.last_at) || !GRADES.includes(card.last_result)) return null;
  return scheduleFor(card.last_result, memory.stability, card.last_at, retention);
}

// What each grade would do now: { again, hard, good } in milliseconds from `now` until the card is due (for the grade buttons).
function preview(card, now, retention = DEFAULT_RETENTION) {
  const out = {};
  for (const grade of GRADES) out[grade] = applyAnswer(card, grade, grade !== 'again', now, { retention }).due_at - now;
  return out;
}

// The probability of recalling the card now (0..1, 4 decimals) from its stored FSRS state and its last answer; null for a card without one. The
// elapsed time is real (not whole days) here, so it falls through the day.
function retrievability(card, now) {
  const memory = storedMemory(card);
  if (!memory || !finite(card.last_at)) return null;
  return fsrs.roundTo(fsrs.retrievability(Math.max(0, now - card.last_at) / DAY, memory.stability), 4);
}

// A mistake: the last answer was wrong, or the card was failed before (lapses) and has a wrong answer in the last 30 days.
function isMistake(card, lastWrongAt, now) {
  if (card.last_correct === 0) return true;
  return (card.lapses || 0) > 0 && Number.isFinite(lastWrongAt) && lastWrongAt >= now - MISTAKE_DAYS * DAY;
}

// The calendar day of a moment as YYYY-MM-DD, in the given IANA time zone or, without one, in the server's own (the process's TZ).
const formats = new Map();
function dayKey(ms, timeZone) {
  const id = timeZone || '';
  let format = formats.get(id);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' });
    formats.set(id, format);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
// The day before a YYYY-MM-DD day (calendar arithmetic: a day with a clock change is still one day).
function previousDay(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

// Consecutive days with at least one answer, ending today, or yesterday while nothing was answered yet today (the streak is not lost until the day ends).
function streak(answerTimes, now, timeZone) {
  const days = new Set();
  for (const at of answerTimes) days.add(dayKey(at, timeZone));
  let day = dayKey(now, timeZone);
  if (!days.has(day)) day = previousDay(day);
  let count = 0;
  while (days.has(day)) { count += 1; day = previousDay(day); }
  return count;
}

// How many of the times fall on the same day as `now`.
function countToday(times, now, timeZone) {
  const today = dayKey(now, timeZone);
  let count = 0;
  for (const at of times) if (dayKey(at, timeZone) === today) count += 1;
  return count;
}

// A word the person knows, so picking words from their translations skips it ("Picking words from translations" in docs/design/learn-english.md):
// answered right at least KNOWN_RIGHT times with the last answer right, or remembered long: a stability of KNOWN_DAYS days or more when the card
// has an FSRS state, else (a card from before it) a review interval of KNOWN_DAYS days or more. `right`: the number of right answers in the history;
// `card`: its review state (last_correct, fsrs_stability, interval_days).
const KNOWN_RIGHT = 2;
const KNOWN_DAYS = 21;
function isKnown(card, right) {
  if (!card) return false;
  const memory = storedMemory(card);
  if (memory ? memory.stability >= KNOWN_DAYS : finite(card.interval_days) && card.interval_days >= KNOWN_DAYS) return true;
  return Number(right) >= KNOWN_RIGHT && (card.last_correct === 1 || card.last_correct === true);
}

module.exports = {
  DAY, AGAIN_MS, EASE_START, MAX_INTERVAL, GRADES, RATINGS, MISTAKE_DAYS, KNOWN_RIGHT, KNOWN_DAYS, RETENTIONS, DEFAULT_RETENTION,
  retentionOf, elapsedDays, storedMemory, legacyMemory, memoryOf, scheduleFor, applyAnswer, answerOrder, replay, rescheduled, preview, retrievability,
  isMistake, isKnown, dayKey, previousDay, streak, countToday,
};
