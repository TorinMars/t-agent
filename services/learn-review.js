// Spaced review of English learning cards ("Review rules" in docs/design/learn-english.md): pure functions, no database, no clock of their own.
// services/learn.js stores what they return. Times are milliseconds since 1970; intervals are days (real numbers).

const DAY = 24 * 60 * 60 * 1000;
const AGAIN_MS = 10 * 60 * 1000; // "again": shown again in 10 minutes
const EASE_START = 2.5;
const EASE_FLOOR = 1.3;
const HARD_FACTOR = 1.2;
const MAX_INTERVAL = 365;
// The steps a "good" answer climbs with the starting ease: 1, 3, 7, 15, 30 days. A good answer multiplies the interval by the ease and takes the
// step nearest to the result (a tie takes the longer step), as long as that step is longer than the interval now. With the starting ease that gives
// exactly 1 -> 3 (2.5) -> 7 (7.5) -> 15 (17.5) -> 30 (37.5); after 30 days (once the product is past 1.5 x 30) it is the product in whole days.
// A card whose ease went down climbs more slowly: when the nearest step is not longer than the interval now, the product itself (to 0.1 day) is used.
const LADDER = [1, 3, 7, 15, 30];
const LADDER_END = LADDER[LADDER.length - 1] * 1.5;
const GRADES = ['again', 'hard', 'good'];
const MISTAKE_DAYS = 30;

const tenth = value => Math.round(value * 10) / 10;
// Ease to two decimals, so 2.5 - 0.15 - 0.15 is 2.2 and not 2.1999999999999997.
const hundredth = value => Math.round(value * 100) / 100;

function goodInterval(interval, ease) {
  const raw = Math.max(1, interval * ease);
  if (raw <= LADDER_END) {
    let best = LADDER[0];
    for (const step of LADDER) if (Math.abs(step - raw) <= Math.abs(best - raw)) best = step;
    if (best > interval) return best;
    return Math.min(MAX_INTERVAL, tenth(raw));
  }
  return Math.min(MAX_INTERVAL, Math.round(raw));
}

// The scheduling fields of a card after one answer: { due_at, interval_days, ease, reps, lapses, last_result, last_at, last_correct }.
function applyAnswer(card, grade, correct, now) {
  if (!GRADES.includes(grade)) throw new Error(`Unknown grade: ${grade}`);
  const interval = Number.isFinite(card.interval_days) && card.interval_days > 0 ? card.interval_days : 0;
  const ease = Number.isFinite(card.ease) && card.ease > 0 ? card.ease : EASE_START;
  const next = { reps: (card.reps || 0) + 1, lapses: card.lapses || 0, last_result: grade, last_at: now, last_correct: correct ? 1 : 0 };
  if (grade === 'again') {
    Object.assign(next, { interval_days: 0, ease: hundredth(Math.max(EASE_FLOOR, ease - 0.2)), lapses: next.lapses + 1, due_at: now + AGAIN_MS });
  } else if (grade === 'hard') {
    const days = Math.min(MAX_INTERVAL, tenth(Math.max(1, interval * HARD_FACTOR)));
    Object.assign(next, { interval_days: days, ease: hundredth(Math.max(EASE_FLOOR, ease - 0.15)), due_at: now + days * DAY });
  } else {
    const days = goodInterval(interval, ease);
    Object.assign(next, { interval_days: days, ease, due_at: now + days * DAY });
  }
  return next;
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
// answered right at least KNOWN_RIGHT times with the last answer right, or a review interval of KNOWN_DAYS days or more. `right`: the number of right
// answers in the history; `card`: its review state (last_correct, interval_days).
const KNOWN_RIGHT = 2;
const KNOWN_DAYS = 21;
function isKnown(card, right) {
  if (!card) return false;
  if (Number.isFinite(card.interval_days) && card.interval_days >= KNOWN_DAYS) return true;
  return Number(right) >= KNOWN_RIGHT && (card.last_correct === 1 || card.last_correct === true);
}

module.exports = {
  DAY, AGAIN_MS, EASE_START, EASE_FLOOR, MAX_INTERVAL, LADDER, GRADES, MISTAKE_DAYS, KNOWN_RIGHT, KNOWN_DAYS,
  goodInterval, applyAnswer, isMistake, isKnown, dayKey, previousDay, streak, countToday,
};
