// The year, month, week and day views of the T-Attention calendar ("Views" in docs/design/page-attention-calendar.md), pure: no DOM, no clock of its
// own (every "today" and "now" is passed in), so test/attention-calendar-views.test.js runs it in Node. Only the T-Attention chunk imports it.
//
// - The view: CAL_VIEWS, `calViewOf` (the shared page state key `h5-attention-cal-view`, month by default).
// - The days of a view (`weekOf`, `yearMonths`, `viewRange`), its title (`viewTitle`) and the move by its unit (`shiftView`).
// - The time grid of the week and day views: `timedLayout` (blocks by start and duration, overlapping ones side by side), `allDayEvents`, the end and
//   the range of an event, the "now" line and the hour the grid scrolls to.
// - The year: the days with something on them and those with a birthday or an anniversary (`yearMarks`).
import { MONTHS, addDays, dateKey, monthGrid, partsOfDate, weekdayOf } from './calendar-model.mjs';

export const CAL_VIEWS = ['year', 'month', 'week', 'day'];
// The chosen view of the calendar: the person's choice on every device and engine (the shared page state, as `h5-attention-view`).
export const CAL_VIEW_KEY = 'h5-attention-cal-view';
export const calViewOf = value => (CAL_VIEWS.includes(value) ? value : 'month');

const pad2 = n => String(n).padStart(2, '0');
const lengthOf = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

// The week (Sunday first) of a date: { first, last, days: ['YYYY-MM-DD' x 7] }.
export function weekOf(date) {
  const first = addDays(date, -weekdayOf(date));
  const days = Array.from({ length: 7 }, (unused, index) => addDays(first, index));
  return { first, last: days[6], days };
}
// The twelve months of a year as month grids (Sunday first, whole weeks; the mini months of the year view draw only the days of their month).
export const yearMonths = year => MONTHS.map(month => monthGrid(year, month.n));

// The same day `delta` units later: a year or a month keeps the day of the month (the last day when the month is shorter: Feb 29 -> Feb 28), a week
// is 7 days, a day 1.
export function shiftView(view, date, delta) {
  const p = partsOfDate(date);
  if (!p) return date;
  if (view === 'week') return addDays(date, 7 * delta);
  if (view === 'day') return addDays(date, delta);
  const index = p.year * 12 + (p.month - 1) + (view === 'year' ? 12 * delta : delta);
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return dateKey(year, month, Math.min(p.day, lengthOf(year, month)));
}
// The days a view draws, the range its events are expanded for: the whole year, the weeks of the month grid, the week, the day.
export function viewRange(view, date) {
  const p = partsOfDate(date);
  if (view === 'year') return { from: dateKey(p.year, 1, 1), to: dateKey(p.year, 12, 31) };
  if (view === 'week') { const week = weekOf(date); return { from: week.first, to: week.last }; }
  if (view === 'day') return { from: date, to: date };
  const grid = monthGrid(p.year, p.month);
  return { from: grid.first, to: grid.last };
}
// The title of a view, English (each form is a template of i18n-zh-ui.js): "2026", "November 2026", "Nov 22 – 28, 2026" (a week in one month),
// "Nov 29 – Dec 5, 2026" (two months), "Dec 27, 2026 – Jan 2, 2027" (two years), "Nov 27, 2026" (a day: its weekday is under the title).
export function viewTitle(view, date) {
  const p = partsOfDate(date);
  if (!p) return '';
  if (view === 'year') return String(p.year);
  if (view === 'month') return `${MONTHS[p.month - 1].long} ${p.year}`;
  if (view === 'day') return `${MONTHS[p.month - 1].short} ${p.day}, ${p.year}`;
  const week = weekOf(date);
  const a = partsOfDate(week.first);
  const b = partsOfDate(week.last);
  const short = m => MONTHS[m - 1].short;
  if (a.year !== b.year) return `${short(a.month)} ${a.day}, ${a.year} – ${short(b.month)} ${b.day}, ${b.year}`;
  if (a.month !== b.month) return `${short(a.month)} ${a.day} – ${short(b.month)} ${b.day}, ${b.year}`;
  return `${short(a.month)} ${a.day} – ${b.day}, ${b.year}`;
}

// ── The time grid ──
export const DEFAULT_MINUTES = 60; // an item without a duration is drawn 1 hour long
export const MIN_SHOWN = 30; // and no block is drawn shorter than 30 minutes
export const DAY_MINUTES = 24 * 60;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const minutesOf = time => { const match = TIME_RE.exec(String(time || '')); return match ? Number(match[1]) * 60 + Number(match[2]) : null; };
export const timeOf = minutes => `${pad2(Math.floor(minutes / 60) % 24)}:${pad2(minutes % 60)}`;
// The end of a timed event in minutes after midnight (its duration, else 1 hour; never past midnight), or null for an all-day one.
export function endOf(event) {
  const start = minutesOf(event && event.time);
  if (start === null) return null;
  return Math.min(DAY_MINUTES, start + (Number.isInteger(event.duration) && event.duration > 0 ? event.duration : DEFAULT_MINUTES));
}
// "10:30–11:30" for an event with a duration (an en dash, as the row line), else null (the time alone is shown).
export function timeRange(event) {
  if (!event || !event.time || !Number.isInteger(event.duration)) return null;
  const end = endOf(event);
  return `${event.time}–${end >= DAY_MINUTES ? '24:00' : timeOf(end)}`;
}
// The events of the all-day row: to-dos, birthdays, anniversaries and schedules marked all day (and a schedule without a time).
export const allDayEvents = list => (list || []).filter(event => event.allDay || !event.time);
// The timed events of one day as blocks: { event, start, end (minutes; at least MIN_SHOWN after the start, never past midnight), col, cols }. Events
// that overlap (by the drawn block) form a cluster; each takes the first column free at its start, and every block of a cluster is 1/cols wide.
export function timedLayout(list) {
  const blocks = (list || []).filter(event => !(event.allDay || !event.time)).map(event => {
    const start = minutesOf(event.time);
    return { event, start, end: Math.min(DAY_MINUTES, Math.max(endOf(event), start + MIN_SHOWN)), col: 0, cols: 1 };
  }).filter(block => block.start !== null).sort((a, b) => a.start - b.start || b.end - a.end);
  let cluster = [];
  let columns = [];
  let clusterEnd = -1;
  const close = () => { for (const block of cluster) block.cols = columns.length; cluster = []; columns = []; };
  for (const block of blocks) {
    if (block.start >= clusterEnd) { close(); clusterEnd = -1; }
    let col = columns.findIndex(end => end <= block.start);
    if (col < 0) { col = columns.length; columns.push(block.end); } else columns[col] = block.end;
    block.col = col;
    cluster.push(block);
    clusterEnd = Math.max(clusterEnd, block.end);
  }
  close();
  return blocks;
}
// Minutes after midnight of a moment, in this device's time (the "now" line).
export const nowMinutes = now => now.getHours() * 60 + now.getMinutes();
// The hour the time grid scrolls to when it opens: an hour before now on today (never past 16:00 so the evening shows), else 8:00.
export const scrollHour = (date, todayDate, minutes) => (date === todayDate ? Math.max(0, Math.min(16, Math.floor(minutes / 60) - 1)) : 8);
// The week view shows today's "now" line in today's column; the day view on today. -> the column index or -1.
export const nowColumn = (days, todayDate) => days.indexOf(todayDate);

// ── The year ──
// A Map 'YYYY-MM-DD' -> 'special' (a birthday or an anniversary) | 'busy' (anything else) for the days of `events` (calendarEvents of the year).
export function yearMarks(events) {
  const out = new Map();
  for (const [date, list] of events || new Map()) {
    if (!list.length) continue;
    out.set(date, list.some(event => event.kind === 'birthday' || event.kind === 'anniversary') ? 'special' : 'busy');
  }
  return out;
}

// ── Durations in words ──
// "15 min", "1 hour", "1.5 hours", "2 hours", "1 h 20 min" (templates of i18n-zh-ui.js).
export function durationText(minutes) {
  if (!Number.isInteger(minutes) || minutes <= 0) return '';
  if (minutes < 60) return `${minutes} min`;
  if (minutes === 60) return '1 hour';
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  if (minutes % 30 === 0) return `${minutes / 60} hours`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
