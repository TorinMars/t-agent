// The form of "When" and "Then" in the T-Attention edit view, the sessions a prompt can go to and "Send now" ("Scheduled and recurring tasks" in
// docs/design/page-attention.md). Pure logic, no DOM and no requests (test/attention-schedule-model.test.js). Only the T-Attention chunk
// (Attention.jsx) imports it, so none of it is part of the first screen; the sections and the row line, which the list needs, are in
// attention-model.mjs.
import { scheduleOf, thenOf } from './attention-model.mjs';

// The choices of the "Repeats" select, in its order. "Every week" rather than "Weekly", whose Chinese is already taken by the Learn page's reports.
export const FREQUENCIES = [
  { value: 'daily', label: 'Every day' }, { value: 'weekdays', label: 'Weekdays' }, { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Every month' }, { value: 'every', label: 'Every N days' },
];
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
    starts: (schedule && schedule.starts) || (schedule && schedule.kind === 'repeat' ? '' : dayKey(now)), // a saved repeat without a start keeps none
    endsKind: ends.kind === 'on' || ends.kind === 'after' ? ends.kind : 'never', endsDate: ends.date || '', endsCount: String(ends.count || 10),
    then: then.kind, session: then.kind === 'prompt' ? sessionValue(then.task_id, then.terminal_id) : '', prompt: then.kind === 'prompt' ? String(then.text || '') : '',
    scriptTask: then.kind === 'script' && then.task_id != null ? String(then.task_id) : '', script: then.kind === 'script' ? String(then.script || '') : '',
    timeoutMin: String((then.kind === 'script' && then.timeout_min) || 30),
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const inRange = (text, min, max) => { const value = Number(text); return Number.isInteger(value) && value >= min && value <= max ? value : null; };
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
    const rule = { freq: form.freq, time: form.time };
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
