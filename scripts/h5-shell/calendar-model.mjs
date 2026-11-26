// The calendar view of T-Attention ("Calendar view" in docs/design/page-attention-calendar.md), pure: no DOM, no requests, no clock of its own (every
// "today" is passed in), so test/attention-calendar-model.test.js runs it in Node. Only the T-Attention chunk imports it (AttentionCalendar.jsx), so
// the occurrences of services/attention-schedule.js and the lunar dates of lib/lunar.js (both CommonJS, bundled by esbuild as attention-model.mjs
// bundles lib/attention-home.js) are not part of the first screen.
//
// - monthGrid(year, month): the weeks of a month, Sunday first (both languages), 35 cells (42 when the month needs six rows).
// - calendarEvents(items, from, to): every item of every engine (as the list has them) laid on its days: a schedule expanded with `occurrencesIn`
//   (once, every repeat rule, yearly solar and lunar dates), an item with a due date and no schedule on that day as a to do. Closed items are left out.
// - dayEvents: one day's events in the agenda's order; noDateItems: the open items with neither a schedule nor a due date ("N to do without a date").
// - Words: the English month and day names, the lunar date as parts the dictionaries turn into Chinese words, "turns 62", "8th anniversary".
import scheduleRules from '../../services/attention-schedule.js';
import lunar from '../../lib/lunar.js';
import { CLOSED_STATUSES, compareItems, keyOf, scheduleOf } from './attention-model.mjs';
import { yearlyRule } from './attention-schedule.mjs';

const pad2 = n => String(n).padStart(2, '0');
export const dateKey = (year, month, day) => `${year}-${pad2(month)}-${pad2(day)}`;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const partsOf = text => { const match = DATE_RE.exec(String(text || '')); return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : null; };
export const partsOfDate = partsOf; // 'YYYY-MM-DD' -> { year, month, day } or null
const utc = text => { const p = partsOf(text); return p ? Date.UTC(p.year, p.month - 1, p.day) : NaN; };
const fromUtc = ms => new Date(ms).toISOString().slice(0, 10);
const DAY_MS = 24 * 60 * 60 * 1000;
// A date moved by whole days ('YYYY-MM-DD' in, 'YYYY-MM-DD' out; no time zone involved).
export const addDays = (text, days) => fromUtc(utc(text) + days * DAY_MS);
// 0 = Sunday ... 6 = Saturday.
export const weekdayOf = text => new Date(utc(text)).getUTCDay();
export const daysBetween = (from, to) => Math.round((utc(to) - utc(from)) / DAY_MS);

// English names; the Chinese ones are in i18n-zh-ui.js (month titles and day titles are templates there: "November {1}", "{1}, Nov {2}").
export const MONTHS = [
  ['January', 'Jan'], ['February', 'Feb'], ['March', 'Mar'], ['April', 'Apr'], ['May', 'May'], ['June', 'Jun'],
  ['July', 'Jul'], ['August', 'Aug'], ['September', 'Sep'], ['October', 'Oct'], ['November', 'Nov'], ['December', 'Dec'],
].map(([long, short], index) => ({ n: index + 1, long, short }));
// Sunday first: the order of the grid's columns in both languages (the user's decision, 2026-11-26).
export const WEEK = [
  { long: 'Sunday', short: 'Sun', letter: 'S' }, { long: 'Monday', short: 'Mon', letter: 'M' }, { long: 'Tuesday', short: 'Tue', letter: 'T' },
  { long: 'Wednesday', short: 'Wed', letter: 'W' }, { long: 'Thursday', short: 'Thu', letter: 'T' }, { long: 'Friday', short: 'Fri', letter: 'F' },
  { long: 'Saturday', short: 'Sat', letter: 'S' },
];

// ── The month grid ──
// { year, month, first, last, cells: [{ date, day, inMonth, weekday }] }: whole weeks from the Sunday on or before the 1st, 5 rows (6 when the
// month reaches into a sixth week); `first` / `last` are the first and last dates drawn (the range to expand).
export function monthGrid(year, month) {
  const start = dateKey(year, month, 1);
  const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lead = weekdayOf(start);
  const rows = Math.max(5, Math.ceil((lead + length) / 7));
  const first = addDays(start, -lead);
  const cells = [];
  for (let i = 0; i < rows * 7; i += 1) {
    const date = addDays(first, i);
    const p = partsOf(date);
    cells.push({ date, day: p.day, inMonth: p.month === month && p.year === year, weekday: i % 7 });
  }
  return { year, month, first, last: cells[cells.length - 1].date, cells };
}
// The month `delta` months after { year, month }.
export function shiftMonth({ year, month }, delta) {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}
export const monthOf = date => { const p = partsOf(date); return p ? { year: p.year, month: p.month } : null; };

// ── Words ──
export const monthTitle = (year, month) => `${MONTHS[month - 1].long} ${year}`; // "November 2026"
// "Thursday, Nov 26" (long) or "Thu, Nov 26" (short).
export function dayTitle(date, { short = false } = {}) {
  const p = partsOf(date);
  if (!p) return '';
  const day = WEEK[weekdayOf(date)];
  return `${short ? day.short : day.long}, ${MONTHS[p.month - 1].short} ${p.day}`;
}
export function ordinal(n) {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${suffix}`;
}
// The number of a birthday or an anniversary on a date: the date's (solar) year minus the year it began (`rule.year`); null without a year or
// before it.
export function yearsOn(rule, date) {
  const p = partsOf(date);
  if (!rule || !Number.isInteger(rule.year) || !p) return null;
  const n = p.year - rule.year;
  return n >= 0 ? n : null;
}
// "turns 62" (a birthday), "8th anniversary" (an anniversary; the first year "0th" is left out), else null. Each is a template of i18n-zh-ui.js.
export function occasionText(occasion, years) {
  if (years === null || years === undefined) return null;
  if (occasion === 'birthday') return `turns ${years}`;
  if (occasion === 'anniversary' && years > 0) return `${ordinal(years)} anniversary`;
  return null;
}
// A lunar date as the parts the page draws: `month` and `day` are English keys whose Chinese is a word (i18n-zh-extra.js: "lunar month 10" -> the
// tenth month's name, "lunar day 7" -> the seventh day's), `numbers` the English form ("10/7", "leap 6/1").
export function lunarParts(value) {
  if (!value || !Number.isInteger(value.month) || !Number.isInteger(value.day)) return null;
  const leap = Boolean(value.leap);
  return { month: `lunar ${leap ? 'leap ' : ''}month ${value.month}`, day: `lunar day ${value.day}`, numbers: `${leap ? 'leap ' : ''}${value.month}/${value.day}`, leap, first: value.day === 1 };
}
export const lunarOfDate = date => lunar.lunarOf(date);

// ── Events ──
// The kind of an item on the calendar: 'once' | 'repeat' | 'birthday' | 'anniversary' (a yearly rule with that occasion) | 'todo' (a due date and
// no schedule) | null (none: the "No date" list, or a closed item).
export function kindOf(item) {
  if (!item || CLOSED_STATUSES.includes(item.status)) return null;
  return eventKind(item);
}
// The kind of an item whatever its status (the search lists finished items too): as `kindOf`, null for no date at all.
export function eventKind(item) {
  if (!item) return null;
  const schedule = scheduleOf(item);
  if (schedule && schedule.kind === 'once') return 'once';
  if (schedule && schedule.kind === 'repeat') {
    const rule = schedule.rule || {};
    if (rule.freq === 'yearly' && (rule.occasion === 'birthday' || rule.occasion === 'anniversary')) return rule.occasion;
    return 'repeat';
  }
  return DATE_RE.test(item.due_date || '') ? 'todo' : null;
}
// The agenda's order of the kinds after the timed events: the birthdays and anniversaries (all day), then the to-dos.
const KIND_RANK = { once: 0, repeat: 0, birthday: 1, anniversary: 1, todo: 2 };
// A Map 'YYYY-MM-DD' -> [event] of the days from `from` to `to` (both included; at most 400 days, as `occurrencesIn`). An event is { key, item, kind,
// date, time ('HH:mm' or null), years (the occasion's number on that day, or null), lunar (the rule's lunar date for a lunar rule, else null),
// duration (whole minutes, `schedule.duration`, or null: drawn 1 hour long), allDay (true for a to do, a birthday, an anniversary and a schedule with
// `all_day`: the all-day row of the week and day views; then `time` is null) }.
// The days are those of the schedule's own zone and the time its wall time there (the owner engine's), as the edit view shows them.
export function calendarEvents(items, from, to) {
  const out = new Map();
  const put = event => { if (!out.has(event.date)) out.set(event.date, []); out.get(event.date).push(event); };
  for (const item of items || []) {
    if (!item || item.id == null) continue;
    const kind = kindOf(item);
    if (!kind) continue;
    if (kind === 'todo') {
      if (item.due_date >= from && item.due_date <= to) put({ key: keyOf(item), item, kind, date: item.due_date, time: null, years: null, lunar: null, duration: null, allDay: true });
      continue;
    }
    const schedule = scheduleOf(item);
    const rule = schedule.rule || {};
    const allDay = kind === 'birthday' || kind === 'anniversary' || schedule.all_day === true;
    const time = allDay ? null : schedule.kind === 'once' ? String(schedule.at || '').slice(11, 16) || null : rule.time || null;
    const duration = !allDay && Number.isInteger(schedule.duration) && schedule.duration > 0 ? schedule.duration : null;
    const lunarRule = rule.freq === 'yearly' && rule.calendar === 'lunar' ? { month: rule.month, day: rule.day, leap: Boolean(rule.leap) } : null;
    for (const date of scheduleRules.occurrencesIn(schedule, from, to)) {
      put({ key: keyOf(item), item, kind, date, time, years: rule.freq === 'yearly' ? yearsOn(rule, date) : null, lunar: lunarRule, duration, allDay: allDay || !time });
    }
  }
  for (const list of out.values()) list.sort(compareEvents);
  return out;
}
function compareEvents(a, b) {
  const rank = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (rank) return rank;
  if (a.time !== b.time) return a.time === null ? 1 : b.time === null ? -1 : a.time < b.time ? -1 : 1;
  return compareItems(a.item, b.item);
}
// One day's events, in the agenda's order: the timed ones by time, then birthdays and anniversaries, then the to-dos.
export const dayEvents = (events, date) => (events && events.get(date)) || [];
// The events of the days after `date` (not including it) up to `to`, in date order, at most `count` ("Coming up" on a computer).
export function comingUp(events, date, count = 5) {
  const days = [...(events || new Map()).keys()].filter(day => day > date).sort();
  const out = [];
  for (const day of days) {
    for (const event of events.get(day)) { out.push(event); if (out.length >= count) return out; }
  }
  return out;
}
// The open items with no date at all (no schedule, no due date), in the list's order: the "N to do without a date" row.
export const noDateItems = items => (items || []).filter(item => item && item.id != null && !CLOSED_STATUSES.includes(item.status) && !scheduleOf(item) && !DATE_RE.test(item.due_date || '')).sort(compareItems);
// The accessible name of a day's button: "Thursday, Nov 26: Call the dentist, Water the plants" or "Thursday, Nov 26: nothing" (the English parts
// are translated by the page; the titles are the person's).
export function dayLabelParts(date, events) {
  return { day: dayTitle(date), titles: (events || []).map(event => String(event.item.title || '')) };
}

// ── New event: birthdays and anniversaries ──
// The saved title: "<Name>'s birthday", "<Name> anniversary"; a name that already ends with that word stays as typed.
export function occasionTitle(occasion, name) {
  const text = String(name || '').trim();
  if (!text) return '';
  if (occasion === 'birthday') return /birthday$/i.test(text) ? text : `${text}'s birthday`;
  if (occasion === 'anniversary') return /anniversary$/i.test(text) ? text : `${text} anniversary`;
  return text;
}
// The form of a birthday or an anniversary ({ calendar: 'solar' | 'lunar', month, day, leap, year } as strings and a boolean) as its schedule, or
// { error } (an English sentence): `yearlyRule` of attention-schedule.mjs (the edit view's "Every year" uses the same) at 09:00. The owner engine
// adds its zone.
export function yearlySchedule(occasion, form) {
  const made = yearlyRule({ ...(form || {}), occasion, time: '09:00' });
  return made.error ? made : { schedule: { kind: 'repeat', rule: made.rule } };
}
// The next day of a yearly schedule on or after `today` ('YYYY-MM-DD'), looking up to 100 years ahead (a leap month can be years away): the
// "Next birthday" card. -> { date, years, lunar } or null.
export function nextYearly(schedule, today) {
  if (!schedule || !schedule.rule) return null;
  let from = today;
  for (let i = 0; i < 92; i += 1) {
    const to = addDays(from, scheduleRules.RANGE_DAYS - 1);
    const [date] = scheduleRules.occurrencesIn(schedule, from, to);
    if (date) return { date, years: yearsOn(schedule.rule, date), lunar: lunar.lunarOf(date) };
    from = addDays(to, 1);
  }
  return null;
}
