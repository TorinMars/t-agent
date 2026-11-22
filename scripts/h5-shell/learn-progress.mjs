// The pure rules of Learn's Progress view and of the grade buttons' intervals (scripts/h5-shell/LearnProgress.jsx, Learn.jsx `Grades`): the text of an
// interval, the stat tiles' deltas, the scales and ticks of the charts and the shape of a column. No React, no DOM, so test/h5-learn-progress.test.js
// runs them in Node. See "Progress" and "Grade intervals" in docs/design/learn-english-page.md.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// When a grade brings the card back, as [template, number] for the page's tf(): under an hour "N min", under a day "N h", then "N days" ("1 day"),
// past 60 days "N mo" (30-day months), past 365 days "N yr" (to one decimal under 10 years). `ms`: milliseconds until the card is due again.
export function intervalParts(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return null;
  const minutes = Math.max(1, Math.round(value / MINUTE));
  if (minutes < 60) return ['{1} min', minutes];
  const hours = Math.round(value / HOUR);
  if (hours < 24) return ['{1} h', hours];
  const days = Math.max(1, Math.round(value / DAY));
  if (days === 1) return ['1 day', 1];
  if (days <= 60) return ['{1} days', days];
  if (days <= 365) return ['{1} mo', Math.round(days / 30)];
  const years = days / 365;
  return ['{1} yr', years < 10 ? Math.round(years * 10) / 10 : Math.round(years)];
}
// The interval in English (tests, and the shape the page's tf() fills in).
export const intervalEnglish = ms => {
  const parts = intervalParts(ms);
  return parts ? parts[0].replace('{1}', String(parts[1])) : '';
};
// The interval of each grade of a queue card, or null when the server sent none (an older server): { again, hard, good } of [template, number].
export function gradeIntervals(next) {
  if (!next || typeof next !== 'object') return null;
  const out = {};
  for (const grade of ['again', 'hard', 'good']) {
    const parts = intervalParts(next[grade]);
    if (!parts) return null;
    out[grade] = parts;
  }
  return out;
}

const int = value => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0);
// A share in whole percent, or null without answers.
export const percent = (part, whole) => (int(whole) > 0 ? Math.round((int(part) / int(whole)) * 100) : null);

// The four stat tiles from GET /api/learn/stats: [template, number] parts the page translates; `delta` null when there is nothing to compare.
// - streak: the days in a row and the best run;  - answers: this week's answers and the change from the week before;
// - right: the share right this week and the change in percentage points;  - remembered: the cards remembered well (memory.mature) of all.
export function tiles(stats) {
  const s = stats || {};
  const week = s.week || {};
  const answers = int(week.answers);
  const prevAnswers = int(week.prev_answers);
  const right = percent(week.right, week.answers);
  const prevRight = percent(week.prev_right, week.prev_answers);
  const streak = int(s.streak);
  return {
    streak: { value: streak, unit: streak === 1 ? '{1} day' : '{1} days', best: Math.max(streak, int(s.best_streak)) },
    answers: { value: answers, delta: answers - prevAnswers },
    right: { value: right, delta: right !== null && prevRight !== null ? right - prevRight : null },
    remembered: { value: int(s.memory && s.memory.mature), total: int(s.total_cards) },
  };
}
// "+38 vs last" / "−38 vs last" / "same as last": [template, number] (the minus sign is U+2212, as in print).
export function deltaParts(delta, { points = false } = {}) {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return null;
  if (delta === 0) return ['same as last week', 0];
  if (points) return delta > 0 ? ['+{1} points vs last', delta] : ['−{1} points vs last', -delta];
  return delta > 0 ? ['+{1} vs last', delta] : ['−{1} vs last', -delta];
}

// Whether there is anything to chart: an answer ever (best_streak counts every answer day) or in the 30 days or 12 weeks the charts show.
export function hasAnswers(stats) {
  if (!stats) return false;
  if (int(stats.best_streak) > 0 || int(stats.streak) > 0) return true;
  const sum = list => (Array.isArray(list) ? list.reduce((total, item) => total + int(item && item.answers), 0) : 0);
  return sum(stats.daily) > 0 || sum(stats.weekly) > 0;
}

// Clean y ticks for counts from 0: a step of 1, 2 or 5 times a power of ten so that `count` steps (about) reach the largest value. { top, ticks }.
export function niceTicks(max, count = 4) {
  const top = Math.max(0, Number(max) || 0);
  if (top <= 0) return { top: 1, ticks: [0, 1] };
  const rough = top / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map(factor => factor * power).find(candidate => candidate >= rough && Number.isInteger(candidate)) || Math.max(1, Math.ceil(rough));
  const whole = Math.max(1, Math.round(step));
  const end = Math.ceil(top / whole) * whole;
  const ticks = [];
  for (let value = 0; value <= end; value += whole) ticks.push(value);
  return { top: end, ticks };
}
// A tick in full under 10,000 and compact from there (10K, 12.5K), one style per axis.
export function tickText(value, top = value) {
  if (top >= 10000) {
    const k = value / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
  }
  return Math.round(value).toLocaleString('en-US');
}

// The columns of a chart `width` wide (the plot area) with `n` slots: each slot `step` wide, the column at most 24px and never the whole slot (at
// least 2px of air on each side, about a third of the slot); `x(i)` is the column's left edge, `center(i)` the slot's middle.
export function columnLayout(n, width) {
  const count = Math.max(1, n);
  const step = Math.max(0, width) / count;
  const bar = Math.max(2, Math.min(24, step - Math.max(2, step * 0.3)));
  return { step, bar, x: i => i * step + (step - bar) / 2, center: i => i * step + step / 2 };
}
// The outline of a column from the baseline `base` up to `top`: a 4px rounded top (less on a short column), square at the baseline.
export function columnPath(x, top, width, base, radius = 4) {
  const height = base - top;
  if (!(height > 0)) return '';
  const r = Math.min(radius, height, width / 2);
  const f = value => Math.round(value * 100) / 100;
  return `M${f(x)},${f(base)}V${f(top + r)}Q${f(x)},${f(top)} ${f(x + r)},${f(top)}H${f(x + width - r)}Q${f(x + width)},${f(top)} ${f(x + width)},${f(top + r)}V${f(base)}Z`;
}
// The index of the slot under a pointer at `offset` px into the plot area (clamped to the slots).
export const slotAt = (offset, n, width) => Math.max(0, Math.min(n - 1, Math.floor((offset / Math.max(1, width)) * n)));
// The point nearest to `offset` px along a line of `n` points spread over `width` (the first at 0, the last at width), skipping points without a
// value; -1 when none has one.
export function nearestPoint(offset, values, width) {
  const n = values.length;
  let best = -1;
  let distance = Infinity;
  for (let i = 0; i < n; i += 1) {
    if (values[i] === null || values[i] === undefined) continue;
    const x = n === 1 ? width / 2 : (i / (n - 1)) * width;
    const d = Math.abs(x - offset);
    if (d < distance) { distance = d; best = i; }
  }
  return best;
}
// The runs of consecutive points that have a value (a week without answers breaks the line): [[i, ...], ...].
export function runs(values) {
  const out = [];
  let current = null;
  values.forEach((value, i) => {
    if (value === null || value === undefined) { current = null; return; }
    if (!current) { current = []; out.push(current); }
    current.push(i);
  });
  return out;
}
// The slots that get an x label: the first, the middle and the last (fewer for fewer slots).
export function labelSlots(n) {
  if (n <= 0) return [];
  if (n === 1) return [0];
  if (n === 2) return [0, 1];
  return [0, Math.floor((n - 1) / 2), n - 1];
}

// The weekly share right the first time, one value per week (null for a week without answers).
export const weeklyShares = weekly => (Array.isArray(weekly) ? weekly.map(week => percent(week && week.right_first, week && week.answers)) : []);

// A YYYY-MM-DD day as a short date in the page's language ("Nov 17"; zh-CN month and day), read as a calendar day (no time zone shift).
export function shortDay(day, lang = 'en') {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
}

// An opaque colour: `top` laid over `base` at `amount` (0..1), both #rrggbb. The dark theme draws a card's elevation as a white overlay on the paper,
// so the 2px ring around a line's end dot uses the card's real colour.
export function mixColor(base, top, amount) {
  const parse = hex => {
    const value = String(hex).replace('#', '');
    const full = value.length === 3 ? value.split('').map(c => c + c).join('') : value;
    return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
  };
  const a = parse(base);
  const b = parse(top);
  return `#${a.map((channel, i) => Math.round(channel + (b[i] - channel) * amount).toString(16).padStart(2, '0')).join('')}`;
}
