// The form of "When" and "Then" in the T-Attention edit view, the sessions a prompt can go to and "Send now" ("Scheduled and recurring tasks" in
// docs/design/page-attention.md). Pure logic, no DOM and no requests (test/attention-schedule-model.test.js). Only the T-Attention chunk
// (Attention.jsx) imports it, so none of it is part of the first screen; the sections and the row line, which the list needs, are in
// attention-model.mjs.
import { CLOSED_STATUSES, scheduleLine, scheduleOf, thenOf } from './attention-model.mjs';

// The choices of the "Repeats" select, in its order. "Every week" rather than "Weekly", whose Chinese is already taken by the Learn page's reports.
export const FREQUENCIES = [
  { value: 'daily', label: 'Every day' }, { value: 'weekdays', label: 'Weekdays' }, { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Every month' }, { value: 'every', label: 'Every N days' }, { value: 'yearly', label: 'Every year' },
];
// "Every year" (birthdays, anniversaries, solar or lunar dates) only on an engine that lists this capability ("Yearly dates" in
// docs/design/attention-schedules.md); an item that already has a yearly rule keeps the choice wherever it is edited.
export const YEARLY_CAPABILITY = 'attention:yearly';
// Whether an engine takes yearly rules: this machine always (the page and its engine are one version); another engine when its `/info` lists the
// capability (`sources` of h5.js, `capabilities` read for every linked engine); null while that is not known yet.
export function yearlyOn(sources, engine) {
  if (engine === 'local') return true;
  const source = (Array.isArray(sources) ? sources : []).find(entry => entry && entry.key === engine);
  if (!source || !Array.isArray(source.capabilities)) return null;
  return source.capabilities.includes(YEARLY_CAPABILITY);
}
// The occasions of a yearly rule ("What it is" in the edit view), the first is none.
export const OCCASIONS = [{ value: '', label: 'A yearly reminder' }, { value: 'birthday', label: 'Birthday' }, { value: 'anniversary', label: 'Anniversary' }];
const FREQ_VALUES = new Set(FREQUENCIES.map(entry => entry.value));
// The engines whose items carry a schedule: their edit view has "When" and "Then".
export const hasSchedule = items => (items || []).some(item => item && Object.prototype.hasOwnProperty.call(item, 'schedule'));

// The row buttons of a scheduled task that waits for the person (Needs you, its time came): a prompt whose session was busy (or gone) has "Send now";
// a script that failed (another exit code, or stopped at its time limit) has "Open terminal" (the terminal of that run, `context.tagent`) and
// "Run again". Both of the latter two run `POST <engine>/:id/run-now`. -> a list of English labels.
export function retryActions(item) {
  if (!item || item.status !== 'waiting_user' || item.schedule_state !== 'due') return [];
  const kind = thenOf(item).kind;
  return kind === 'prompt' ? ['Send now'] : kind === 'script' ? ['Open terminal', 'Run again'] : [];
}
// The terminal a failed script ran in (`context.tagent` of the item, which the owner points at it), as `ui.actions.openRow` takes it: its task's row
// of the one task list on the item's own engine (`ref`, else its id) and the terminal id; null when that task is not listed. The terminal is new, so the
// task list may not list it yet: it is opened whether or not the task's sessions show it.
export function scriptTerminal(context, engine, tasks) {
  const tagent = context && context.tagent;
  if (!tagent || tagent.task_id == null || !tagent.terminal_id) return null;
  const row = (tasks || []).find(entry => entry && entry.source === engine && String(entry.id) === String(tagent.task_id));
  return row ? { taskId: row.ref != null ? row.ref : row.id, terminalId: String(tagent.terminal_id) } : null;
}

// ── The sessions a prompt can go to: the sessions of the item's OWNER engine, from the one task list (state.taskList.tasks, each row with its
// `source`, the engine key) ──
// The terminal rows of a task row when the task list knows them (an open task), else null.
const listedTerminals = row => {
  const list = row && row.sessions;
  const known = list && !list.note && Array.isArray(list.rows) ? list.rows.filter(entry => entry && entry.kind === 'terminal') : null;
  return known ? known.map(entry => ({ id: String(entry.id), title: entry.title || '', agent: entry.agent || null })) : null;
};
// The tasks of `engine` in the task list, each with its sessions: the ones the task list lists, else the ones read for the edit view (`read`, a map
// '<task id>' -> [{ id, title, agent }]), else null (not known yet). -> [{ taskId, title, sessions }]
export function sessionTasks(tasks, engine, read = new Map()) {
  return (tasks || []).filter(row => row && row.source === engine && row.id != null && !row.stale).map(row => ({
    taskId: row.id, title: String(row.title || ''), sessions: listedTerminals(row) || read.get(String(row.id)) || null,
  }));
}
// What a row line names (`scheduleLine`'s `targetName`): a prompt's session (its name in the task list, or as read, else its task's title), a
// script's task (its title); '' when not known.
export function targetName(then, tasks, engine, read = new Map()) {
  if (!then || (then.kind !== 'prompt' && then.kind !== 'script')) return '';
  const task = sessionTasks(tasks, engine, read).find(entry => String(entry.taskId) === String(then.task_id));
  if (!task) return '';
  if (then.kind === 'script') return task.title;
  const session = (task.sessions || []).find(entry => entry.id === String(then.terminal_id));
  return (session && session.title) || task.title;
}
export const sessionValue = (taskId, terminalId) => (taskId == null || !terminalId ? '' : `${taskId}|${terminalId}`);

// ── The form of "When" and "Then" ──
const pad2 = n => String(n).padStart(2, '0');
const isoDay = date => (date.getDay() + 6) % 7 + 1; // Monday = 1
const dayKey = date => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
// The fields of the form from the item (or the defaults for a task without a schedule, from `now`): strings and lists, as the inputs hold them.
export function scheduleForm(item, now = new Date()) {
  const schedule = scheduleOf(item);
  const rule = (schedule && schedule.rule) || {};
  const ends = (schedule && schedule.ends) || {};
  const then = schedule ? thenOf(item) : { kind: 'remind' };
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const at = schedule && schedule.kind === 'once' && typeof schedule.at === 'string' ? schedule.at : '';
  return {
    when: schedule ? schedule.kind : 'none',
    onceDate: at.slice(0, 10) || dayKey(tomorrow), onceTime: at.slice(11, 16) || '09:00',
    freq: FREQ_VALUES.has(rule.freq) ? rule.freq : 'weekly', time: rule.time || '09:00',
    days: Array.isArray(rule.days) && rule.days.length ? [...rule.days].map(Number) : [isoDay(now)],
    day: String(rule.day || now.getDate()), interval: String(rule.interval || 2),
    // Every year: the calendar, the month and day (lunar ones in the lunar calendar), a leap month, what it is and the year it began.
    calendar: rule.calendar === 'lunar' ? 'lunar' : 'solar', month: String(rule.freq === 'yearly' && rule.month ? rule.month : now.getMonth() + 1),
    yearDay: String(rule.freq === 'yearly' && rule.day ? rule.day : now.getDate()), leap: Boolean(rule.leap), occasion: rule.occasion || '',
    year: Number.isInteger(rule.year) ? String(rule.year) : '',
    starts: (schedule && schedule.starts) || (schedule && schedule.kind === 'repeat' ? '' : dayKey(now)), // a saved repeat without a start keeps none
    endsKind: ends.kind === 'on' || ends.kind === 'after' ? ends.kind : 'never', endsDate: ends.date || '', endsCount: String(ends.count || 10),
    then: then.kind, session: then.kind === 'prompt' ? sessionValue(then.task_id, then.terminal_id) : '', prompt: then.kind === 'prompt' ? String(then.text || '') : '',
    scriptTask: then.kind === 'script' && then.task_id != null ? String(then.task_id) : '', script: then.kind === 'script' ? String(then.script || '') : '',
    timeoutMin: String((then.kind === 'script' && then.timeout_min) || 30),
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const inRange = (text, min, max) => { const value = Number(text); return String(text ?? '').trim() !== '' && Number.isInteger(value) && value >= min && value <= max ? value : null; };
// A yearly rule from its fields ({ calendar, month, day, leap, occasion, year, time }, strings as the inputs hold them): `{ rule }` in the server's
// canonical key order, or `{ error }` (an English sentence). A solar date must exist at least in a leap year (2-29 yes, 2-30 no); a lunar day is 1 to
// 30; the year it began is optional (1900 to 2100).
export function yearlyRule(fields) {
  const calendar = fields && fields.calendar === 'lunar' ? 'lunar' : 'solar';
  const month = inRange(fields && fields.month, 1, 12);
  if (month === null) return { error: 'Choose the month' };
  const day = inRange(fields.day, 1, calendar === 'lunar' ? 30 : 31);
  if (day === null) return { error: calendar === 'lunar' ? 'The lunar day is 1 to 30' : 'The day of the month is 1 to 31' };
  if (calendar === 'solar' && day > new Date(Date.UTC(2024, month, 0)).getUTCDate()) return { error: 'This month has no such day' };
  if (!TIME_RE.test(fields.time || '')) return { error: 'Choose a time' };
  const rule = { freq: 'yearly', calendar, month, day };
  if (calendar === 'lunar' && fields.leap) rule.leap = true;
  if (fields.occasion === 'birthday' || fields.occasion === 'anniversary') rule.occasion = fields.occasion;
  if (String(fields.year ?? '').trim() !== '') {
    const year = inRange(fields.year, 1900, 2100);
    if (year === null) return { error: 'The year is 1900 to 2100' };
    rule.year = year;
  }
  rule.time = fields.time;
  return { rule };
}
// The form as the body of a save: `{ schedule, then_action }`, or `{ error }` (an English sentence) when it cannot be saved. No date clears both. The
// time zone is left to the owner engine, which takes its own when it saves (the page does not know the owner's zone).
export function scheduleFromForm(form) {
  if (!form || form.when === 'none' || form.when === undefined) return { schedule: null, then_action: null };
  let schedule;
  if (form.when === 'once') {
    if (!DATE_RE.test(form.onceDate || '') || !TIME_RE.test(form.onceTime || '')) return { error: 'Choose a date and a time' };
    schedule = { kind: 'once', at: `${form.onceDate}T${form.onceTime}` };
  } else {
    if (!FREQ_VALUES.has(form.freq)) return { error: 'Choose how often it repeats' };
    if (!TIME_RE.test(form.time || '')) return { error: 'Choose a time' };
    let rule = { freq: form.freq, time: form.time };
    if (form.freq === 'yearly') {
      const made = yearlyRule({ calendar: form.calendar, month: form.month, day: form.yearDay, leap: form.leap, occasion: form.occasion, year: form.year, time: form.time });
      if (made.error) return { error: made.error };
      rule = made.rule;
    }
    if (form.freq === 'weekly') {
      const days = [...new Set((form.days || []).map(Number).filter(day => day >= 1 && day <= 7))].sort((a, b) => a - b);
      if (!days.length) return { error: 'Choose at least one day' };
      rule.days = days;
    }
    if (form.freq === 'monthly') { const day = inRange(form.day, 1, 31); if (day === null) return { error: 'The day of the month is 1 to 31' }; rule.day = day; }
    if (form.freq === 'every') { const interval = inRange(form.interval, 1, 365); if (interval === null) return { error: 'Repeat every 1 to 365 days' }; rule.interval = interval; }
    schedule = { kind: 'repeat', rule };
    if (form.starts) { if (!DATE_RE.test(form.starts)) return { error: 'Choose the start date' }; schedule.starts = form.starts; }
    if (form.endsKind === 'on') {
      if (!DATE_RE.test(form.endsDate || '')) return { error: 'Choose the end date' };
      if (form.starts && form.endsDate < form.starts) return { error: 'The end date is before the start' };
      schedule.ends = { kind: 'on', date: form.endsDate };
    } else if (form.endsKind === 'after') {
      const count = inRange(form.endsCount, 1, 9999);
      if (count === null) return { error: 'End after 1 to 9999 times' };
      schedule.ends = { kind: 'after', count };
    }
  }
  if (form.then === 'script') {
    if (!form.scriptTask) return { error: 'Choose the task the script runs in' };
    const script = String(form.script || '').trim();
    if (!script) return { error: 'Write the script to run' };
    if (script.length > 4000) return { error: 'The script is longer than 4000 characters' };
    const timeout = inRange(form.timeoutMin, 1, 720);
    if (timeout === null) return { error: 'The time limit is 1 to 720 minutes' };
    const task = String(form.scriptTask);
    return { schedule, then_action: { kind: 'script', task_id: Number.isFinite(Number(task)) ? Number(task) : task, script, timeout_min: timeout } };
  }
  if (form.then !== 'prompt') return { schedule, then_action: { kind: 'remind' } };
  const [task, ...terminal] = String(form.session || '').split('|');
  if (!task || !terminal.length || !terminal.join('|')) return { error: 'Choose a session for the prompt' };
  const text = String(form.prompt || '').trim();
  if (!text) return { error: 'Write the prompt to send' };
  if (text.length > 4000) return { error: 'The prompt is longer than 4000 characters' };
  return { schedule, then_action: { kind: 'prompt', task_id: Number.isFinite(Number(task)) ? Number(task) : task, terminal_id: terminal.join('|'), text } };
}
// Two schedules (or actions) compared by what they mean: the zone, an end of "never" and the fields the server adds are left out, the days sorted.
function sameSchedule(schedule) {
  if (!schedule) return null;
  if (schedule.kind === 'once') return { kind: 'once', at: String(schedule.at || '').slice(0, 16) };
  const rule = schedule.rule || {};
  const out = { kind: 'repeat', freq: rule.freq, time: rule.time };
  if (rule.freq === 'weekly') out.days = [...new Set((rule.days || []).map(Number))].sort((a, b) => a - b);
  if (rule.freq === 'monthly') out.day = Number(rule.day);
  if (rule.freq === 'every') out.interval = Number(rule.interval);
  if (rule.freq === 'yearly') {
    Object.assign(out, { calendar: rule.calendar === 'lunar' ? 'lunar' : 'solar', month: Number(rule.month), day: Number(rule.day), leap: Boolean(rule.leap), occasion: rule.occasion || '' });
    out.year = Number.isInteger(rule.year) ? rule.year : null;
  }
  if (schedule.starts) out.starts = schedule.starts;
  const ends = schedule.ends || {};
  if (ends.kind === 'on') out.ends = `on ${ends.date}`;
  if (ends.kind === 'after') out.ends = `after ${Number(ends.count)}`;
  return out;
}
function sameThen(then) {
  if (then && then.kind === 'prompt') return { kind: 'prompt', task: String(then.task_id), terminal: String(then.terminal_id), text: String(then.text || '') };
  if (then && then.kind === 'script') return { kind: 'script', task: String(then.task_id), script: String(then.script || ''), timeout: Number(then.timeout_min) || 30 };
  return { kind: 'remind' };
}

// The schedule part of the PATCH body of the edit view: `schedule` and `then_action` only when they changed (compared by meaning), {} when neither did.
// A form that cannot be saved gives {} too: the edit view shows `scheduleFromForm`'s error first.
export function schedulePatch(item, form) {
  if (!form || form.when === undefined) return {};
  const made = scheduleFromForm(form);
  if (made.error) return {};
  const out = {};
  const schedule = scheduleOf(item);
  if (JSON.stringify(sameSchedule(made.schedule)) !== JSON.stringify(sameSchedule(schedule))) out.schedule = made.schedule;
  if (JSON.stringify(sameThen(made.then_action)) !== JSON.stringify(sameThen(schedule ? thenOf(item) : null))) out.then_action = made.then_action;
  return out;
}

// ── The row line of a yearly rule (`rowLine`): here, in the T-Attention chunk, so the first screen (attention-model.mjs) does not grow ──
// A yearly rule's date: MM-DD as the other row lines write dates (solar, `{ raw: '11-15' }`) or `{ lunar: { month, day, leap }, raw }` (drawn as
// "lunar 10/7", in Chinese the month and day words; `raw` is the English for `tokensText`).
const yearlyDate = rule => (rule.calendar === 'lunar'
  ? { lunar: { month: Number(rule.month), day: Number(rule.day), leap: Boolean(rule.leap) }, raw: `lunar ${rule.leap ? 'leap ' : ''}${Number(rule.month)}/${Number(rule.day)}` }
  : { raw: `${pad2(Number(rule.month) || 1)}-${pad2(Number(rule.day) || 1)}` });
// The year number of a birthday or an anniversary on its next day (`occasionYears`): the solar year of that day minus the year it began; "turns 62",
// "8th anniversary" (the tokens of `occasionTokens`, templates of i18n-zh-ui.js).
const ordinalOf = n => { const tens = n % 100; return `${n}${tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`; };
export function occasionTokens(occasion, years) {
  if (!Number.isInteger(years) || years < 0) return [];
  if (occasion === 'birthday') return [`turns ${years}`];
  if (occasion === 'anniversary' && years > 0) return [`${ordinalOf(years)} anniversary`];
  return [];
}
// A yearly item's line: Every year · <the day it comes next, this device's date> · <the lunar date of a lunar rule> · turns 62 (· due now), then
// done and the action as for every rule. The day comes from `next_at` (`last_fired_at` while it is due: that is the day it came).
function yearlyParts(item, schedule, now) {
  const rule = schedule.rule;
  const at = Date.parse((item.schedule_state === 'due' ? item.last_fired_at : item.next_at) || '');
  const day = Number.isFinite(at) ? new Date(at) : null;
  const parts = [['Every year']];
  if (day) parts.push([{ raw: `${pad2(day.getMonth() + 1)}-${pad2(day.getDate())}` }]);
  else if (rule.calendar !== 'lunar') parts.push([yearlyDate(rule)]);
  if (rule.calendar === 'lunar') parts.push([yearlyDate(rule)]);
  const years = Number.isInteger(rule.year) ? (day || now).getFullYear() - rule.year : null;
  const occasion = occasionTokens(rule.occasion, years);
  if (occasion.length) parts.push(occasion);
  if (item.schedule_state === 'due') parts.push(['due now']);
  else if (!day && !CLOSED_STATUSES.includes(item.status)) parts.push(['no next time']);
  return parts;
}
// The row line of an item (`scheduleLine` of attention-model.mjs, with the same options): a yearly rule's first parts are `yearlyParts` instead of
// its rule and next time; the done time and the action stay.
const TIME_PARTS = new Set(['next', 'due now', 'no next time']);
export function rowLine(item, options = {}) {
  const line = scheduleLine(item, options);
  const schedule = line && scheduleOf(item);
  if (!schedule || schedule.kind !== 'repeat' || !schedule.rule || schedule.rule.freq !== 'yearly') return line;
  const rest = line.parts.slice(1).filter(part => !TIME_PARTS.has(part[0]));
  return { ...line, parts: [...yearlyParts(item, schedule, options.now || new Date()), ...rest] };
}
// The rule in a few words for the calendar's agenda: `ruleTokens`, but "Every year" and its time for a yearly rule.
export const yearlyWords = schedule => ['Every year', { raw: String((schedule.rule || {}).time || '') }];
