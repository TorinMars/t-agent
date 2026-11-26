// The search of T-Attention ("Search" in docs/design/page-attention-calendar.md), pure: no DOM, no clock of its own (`today` is passed in), so
// test/attention-calendar-views.test.js runs it in Node. Only the T-Attention chunk imports it (AttentionSearch.jsx).
//
// - What is searched: the title, the notes, the result and the custom status of every item the list has (all linked engines), and for a lunar
//   yearly rule its lunar date as text ("lunar 10/7", "10/7", "lunar leap 6/1"; the page adds the Chinese words through `extra`). Case does not
//   matter, the text is NFKC-normalised (full-width letters and digits match), every word of the query must be found (in any field).
// - Filters: All, Schedules (once and repeating), Birthdays, Anniversaries, To do (a due date or no date at all); "Include finished" adds the
//   closed items.
// - Groups: Next up (by the next day of each item, soonest first), Earlier this year and Earlier (an item whose days are past), No date, Finished.
import scheduleRules from '../../services/attention-schedule.js';
import { CLOSED_STATUSES, compareItems, keyOf, scheduleOf } from './attention-model.mjs';
import { addDays, eventKind, partsOfDate, yearsOn } from './calendar-model.mjs';

export const SEARCH_FILTERS = [
  { value: 'all', label: 'All' }, { value: 'schedules', label: 'Schedules' }, { value: 'birthday', label: 'Birthdays' },
  { value: 'anniversary', label: 'Anniversaries' }, { value: 'todo', label: 'To do' },
];
export const SEARCH_GROUPS = { next: 'Next up', earlier: 'Earlier this year', older: 'Earlier', none: 'No date', finished: 'Finished' };

export const normalize = text => String(text ?? '').normalize('NFKC').toLowerCase();
// The words of a query (spaces of any width split them); [] for an empty query.
export const searchTerms = query => normalize(query).split(/\s+/).filter(Boolean);

// The lunar date of a lunar yearly rule as the texts a person may type: "lunar 10/7", "10/7", "lunar leap 6/1", "leap 6/1".
export function lunarSearchText(schedule) {
  const rule = schedule && schedule.rule;
  if (!rule || rule.freq !== 'yearly' || rule.calendar !== 'lunar') return [];
  const numbers = `${rule.leap ? 'leap ' : ''}${Number(rule.month)}/${Number(rule.day)}`;
  return [`lunar ${numbers}`, numbers];
}
// The texts of an item that a query is matched against (normalised): the person's fields, the lunar date, and `extra(item)` (the page: the lunar date
// in Chinese words).
export function itemTexts(item, extra = () => []) {
  const fields = [item.title, item.notes, item.result, item.custom_status, ...lunarSearchText(scheduleOf(item)), ...(extra(item) || [])];
  return fields.filter(text => text !== null && text !== undefined && String(text) !== '').map(normalize);
}
export const matches = (item, terms, extra) => {
  if (!terms.length) return false;
  const texts = itemTexts(item, extra).join('\n');
  return terms.every(term => texts.includes(term));
};
// Whether an item passes a filter (its kind whatever its status: `eventKind`; null is no date).
export function passes(item, filter) {
  const kind = eventKind(item);
  if (filter === 'schedules') return kind === 'once' || kind === 'repeat';
  if (filter === 'birthday' || filter === 'anniversary') return kind === filter;
  if (filter === 'todo') return kind === 'todo' || kind === null;
  return true;
}

// The first day of a schedule on or after `from` (up to `windows` ranges of 400 days: a lunar leap month can be years away), or null.
export function nextDayOf(schedule, from, windows = 3) {
  let start = from;
  for (let i = 0; i < windows; i += 1) {
    const to = addDays(start, scheduleRules.RANGE_DAYS - 1);
    const [date] = scheduleRules.occurrencesIn(schedule, start, to);
    if (date) return date;
    start = addDays(to, 1);
  }
  return null;
}
// The last day of a schedule from `from` to `to` (both included), or null.
export function lastDayOf(schedule, from, to) {
  if (to < from) return null;
  const list = scheduleRules.occurrencesIn(schedule, from, to);
  return list.length ? list[list.length - 1] : null;
}

// The day a result is shown with and its group: an open item's next day (Next up), else its last day (this year: Earlier this year; before it:
// Earlier); a to do its due day; nothing: No date; a closed item: Finished (with its day, when it has one).
function placeOf(item, today) {
  const schedule = scheduleOf(item);
  const closed = CLOSED_STATUSES.includes(item.status);
  const year = today.slice(0, 4);
  let date = null;
  let next = false;
  if (schedule) {
    const yearly = schedule.rule && schedule.rule.freq === 'yearly';
    date = nextDayOf(schedule, today, yearly ? 92 : 3);
    next = Boolean(date);
    if (!date) date = lastDayOf(schedule, `${year}-01-01`, addDays(today, -1)) || (schedule.kind === 'once' ? String(schedule.at || '').slice(0, 10) || null : null);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(item.due_date || '')) {
    date = item.due_date;
    next = date >= today;
  }
  const group = closed ? 'finished' : !date ? 'none' : next ? 'next' : date.slice(0, 4) === year ? 'earlier' : 'older';
  return { date, group };
}

// The results of a query: { count, groups: [{ key, title, results: [{ key, item, kind, date, years }] }] } in the order Next up, Earlier this year,
// Earlier, No date, Finished; an empty group is left out. Next up by day (soonest first), the past groups by day (latest first), No date and Finished
// in the list's order (Finished by its day, latest first, when it has one). `years`: the number of a birthday or anniversary on that day.
export function searchItems(items, query, { filter = 'all', finished = false, today, extra } = {}) {
  const terms = searchTerms(query);
  const out = { next: [], earlier: [], older: [], none: [], finished: [] };
  if (!terms.length) return { count: 0, groups: [] };
  for (const item of items || []) {
    if (!item || item.id == null) continue;
    if (!finished && CLOSED_STATUSES.includes(item.status)) continue;
    if (!passes(item, filter) || !matches(item, terms, extra)) continue;
    const { date, group } = placeOf(item, today);
    const schedule = scheduleOf(item);
    const rule = schedule && schedule.rule;
    out[group].push({ key: keyOf(item), item, kind: eventKind(item) || 'none', date, years: rule && rule.freq === 'yearly' && date ? yearsOn(rule, date) : null });
  }
  const byDay = dir => (a, b) => (a.date === b.date ? compareItems(a.item, b.item) : !a.date ? 1 : !b.date ? -1 : (a.date < b.date ? -1 : 1) * dir);
  out.next.sort(byDay(1));
  out.earlier.sort(byDay(-1));
  out.older.sort(byDay(-1));
  out.none.sort((a, b) => compareItems(a.item, b.item));
  out.finished.sort(byDay(-1));
  const groups = Object.keys(out).filter(key => out[key].length).map(key => ({ key, title: SEARCH_GROUPS[key], results: out[key] }));
  return { count: groups.reduce((sum, group) => sum + group.results.length, 0), groups };
}

// A text cut into the parts a query matches: [{ text, hit }] (the original letters kept; the match is found on the normalised text, which has the
// same length for the letters, digits and Chinese characters people type; when NFKC changes the length the text is not cut).
export function highlightParts(text, query) {
  const source = String(text ?? '');
  const terms = searchTerms(query);
  const folded = normalize(source);
  if (!terms.length || folded.length !== source.length) return [{ text: source, hit: false }];
  const marks = new Array(source.length).fill(false);
  for (const term of terms) {
    let at = folded.indexOf(term);
    while (at >= 0) { for (let i = at; i < at + term.length; i += 1) marks[i] = true; at = folded.indexOf(term, at + term.length); }
  }
  const parts = [];
  for (let i = 0; i < source.length; i += 1) {
    const last = parts[parts.length - 1];
    if (last && last.hit === marks[i]) last.text += source[i];
    else parts.push({ text: source[i], hit: marks[i] });
  }
  return parts;
}
// The month and day of the date block of a result: { month: 'Nov', day: 15, year } or null.
export function dateBlock(date) {
  const p = partsOfDate(date);
  return p ? { month: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][p.month - 1], day: p.day, year: p.year } : null;
}
