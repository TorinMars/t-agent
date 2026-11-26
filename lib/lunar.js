// The Chinese lunisolar calendar for yearly T-Attention schedules ("Lunar dates" in docs/design/attention-schedules.md), pure: only Intl with the
// calendar `en-u-ca-chinese` (no table, no dependency), so the server and the page (bundled by esbuild) share it. No Node-only modules.
//
// - lunarOf('YYYY-MM-DD') -> { year, month, day, leap } of that solar day (year: the solar year the lunar year starts in; leap: a leap month,
//   which Intl writes as "6bis"), or null for a date that is not valid.
// - monthStart(year, month, leap) -> the UTC midnight ms of day 1 of that lunar month, or null when the year has no such (leap) month.
// - dayOf(year, month, day, leap) -> the UTC midnight ms of that lunar date in lunar year `year`; day 30 of a 29-day month is its day 29; a leap
//   month that the year does not have -> null.
// Every conversion is cached (one Intl call per solar day, one search per lunar year and month).
const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 20000;
let formatter = null;
const days = new Map();
const starts = new Map();

function format(ms) {
  if (!formatter) formatter = new Intl.DateTimeFormat('en-u-ca-chinese', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });
  const parts = {};
  for (const part of formatter.formatToParts(new Date(ms))) parts[part.type] = part.value;
  return parts;
}

// The lunar date of a UTC midnight (ms).
function lunarOfMs(ms) {
  let value = days.get(ms);
  if (value) return value;
  const parts = format(ms);
  const monthText = String(parts.month || '');
  const month = parseInt(monthText, 10);
  const leap = /bis$/i.test(monthText);
  const day = parseInt(parts.day, 10);
  const solar = new Date(ms);
  // relatedYear is the solar year the lunar year starts in; without it (an older engine), months 11 and 12 seen in January or February belong to
  // the year before.
  const related = parseInt(parts.relatedYear, 10);
  const year = Number.isFinite(related) ? related : solar.getUTCFullYear() - (month >= 11 && solar.getUTCMonth() <= 1 ? 1 : 0);
  value = Object.freeze({ year, month, day, leap });
  if (days.size >= CACHE_MAX) days.clear();
  days.set(ms, value);
  return value;
}

function lunarOf(dateText) {
  if (typeof dateText !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return null;
  const [y, m, d] = dateText.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== dateText) return null;
  return { ...lunarOfMs(ms) };
}

const remember = (key, value) => {
  if (starts.size >= 4000) starts.clear();
  starts.set(key, value);
  return value;
};

// Day 1 of the lunar year `year`: its new year is between January 21 and February 20, so January 21 is in its first month or one or two months
// before it.
function newYear(year) {
  const key = `new:${year}`;
  if (starts.has(key)) return starts.get(key);
  let start = Date.UTC(year, 0, 21);
  start -= (lunarOfMs(start).day - 1) * DAY_MS;
  for (let i = 0; i < 3 && lunarOfMs(start).year !== year; i += 1) {
    let next = start + 29 * DAY_MS;
    if (lunarOfMs(next).day !== 1) next += DAY_MS;
    start = next;
  }
  remember(key, start);
  return start;
}

// Day 1 (UTC midnight ms) of lunar month `month` (leap: the leap month of that number) in lunar year `year`, or null when the year has no such
// month. A guess from the new year, then whole months forward or back (a few Intl calls, not a table of the year).
function monthStart(year, month, leap = false) {
  const key = `${year}:${month}:${leap ? 1 : 0}`;
  if (starts.has(key)) return starts.get(key);
  // A year with a leap month has 13 months (383 to 385 days); one without has 353 to 355: no leap month to look for.
  if (leap && newYear(year + 1) - newYear(year) < 370 * DAY_MS) return remember(key, null);
  const target = month * 2 + (leap ? 1 : 0);
  let mid = newYear(year) + (Math.round((month - 1) * 29.53) + 14) * DAY_MS;
  let found = null;
  let previous = 0;
  for (let i = 0; i < 8; i += 1) {
    const here = lunarOfMs(mid);
    const start = mid - (here.day - 1) * DAY_MS;
    const order = (here.year - year) * 100 + here.month * 2 + (here.leap ? 1 : 0);
    if (order === target) { found = start; break; }
    const step = order < target ? 1 : -1;
    if (previous && step !== previous) break; // stepped over it: the year has no such month
    previous = step;
    mid = start + (step > 0 ? 44 : -15) * DAY_MS; // the middle of the next or the previous month
  }
  return remember(key, found);
}

// The length of the lunar month that starts on `start`: 29 or 30 days.
const monthLength = start => (lunarOfMs(start + 29 * DAY_MS).day === 1 ? 29 : 30);

function dayOf(year, month, day, leap = false) {
  const start = monthStart(year, month, leap);
  if (start === null) return null;
  return start + (Math.min(day, day >= 30 ? monthLength(start) : day) - 1) * DAY_MS;
}

// The parts the page turns into words ("lunar month 10, day 7", "leap month 6"): the numbers, checked, with leap a boolean.
function lunarLabel(month, day, leap = false) {
  return { month: Number(month), day: Number(day), leap: Boolean(leap) };
}

module.exports = { lunarOf, lunarOfMs, newYear, monthStart, monthLength, dayOf, lunarLabel };
