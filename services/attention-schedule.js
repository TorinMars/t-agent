// T-Attention schedules ("Scheduled and recurring tasks" in docs/design/attention-schedules.md), pure: no database and no clock of its own (every time is
// passed in), so test/attention-schedule.test.js checks it with fixed clocks and fixed zones.
//
// - A schedule is { kind: 'once', at: 'YYYY-MM-DDTHH:mm', tz } or { kind: 'repeat', rule: { freq, days?, day?, interval?, time }, starts?, ends?, tz }.
//   Wall times are local to `tz` (the IANA zone of the owner engine when it was saved). normalizeSchedule validates a body value and returns the
//   canonical form (fixed key order, no empty parts, `ends: never` left out), so the same schedule sent again compares equal and changes nothing.
// - Time zones and daylight saving time: a wall time is turned into an instant with Intl (localToUtc). A wall time that does not exist (the clock
//   jumps forward over it) moves to the next minute that exists; one that happens twice (the clock goes back) is the first of the two, so it fires once.
// - nextOccurrence(schedule, afterMs, { runs }) is the first fire time after afterMs (a once schedule: its time while it has not fired, also in the
//   past, so it fires at once), null when nothing is left (`ends` reached). describe() is the English sentence the page and the CLI show.
const CAPABILITY = 'attention:schedule';
const FREQS = Object.freeze(['daily', 'weekdays', 'weekly', 'monthly', 'every']);
const DAY_NAMES = Object.freeze(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const SCAN_DAYS = 400; // enough for every rule: monthly, every N <= 365 days
const MAX_MISSED = 10000;
const PROMPT_MAX = 4000;
const SCRIPT_MAX = 4000;
const SCRIPT_TIMEOUT_DEFAULT = 30; // minutes
const SCRIPT_TIMEOUT_MAX = 720;
const TERMINAL_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

class ScheduleError extends Error {
  constructor(message) { super(message); this.code = 'VALIDATION_FAILED'; }
}
const invalid = message => new ScheduleError(message);
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const pad = value => String(value).padStart(2, '0');

// ---- Time zones ----
const formatters = new Map();
function formatterOf(tz) {
  let formatter = formatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(tz, formatter);
  }
  return formatter;
}
function validZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { formatterOf(tz); return true; } catch { return false; }
}
// The wall clock of an instant in a zone: { y, m, d, hh, mm }.
function wallOf(ms, tz) {
  const parts = {};
  for (const part of formatterOf(tz).formatToParts(new Date(ms))) parts[part.type] = part.value;
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), hh: Number(parts.hour) % 24, mm: Number(parts.minute), ss: Number(parts.second) };
}
const wallKey = w => Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm); // a wall time as a number that orders like the wall time
// The zone's offset at an instant, in ms (local - UTC).
const offsetAt = (ms, tz) => { const w = wallOf(ms, tz); return wallKey(w) + w.ss * 1000 - Math.floor(ms / 1000) * 1000; };

// The instant of a local wall time (y, m, d, hh, mm) in tz. Ambiguous (the clock goes back): the earlier one. Missing (the clock jumps forward): the
// first minute after the gap.
function localToUtc(y, m, d, hh, mm, tz) {
  const target = Date.UTC(y, m - 1, d, hh, mm);
  const offsets = [...new Set([offsetAt(target - DAY_MS, tz), offsetAt(target, tz), offsetAt(target + DAY_MS, tz)])];
  const exact = offsets.map(offset => target - offset).filter(ms => wallKey(wallOf(ms, tz)) === target).sort((a, b) => a - b);
  if (exact.length) return exact[0];
  // A gap: the smallest instant whose wall time is at or after the target, between the two candidates (a binary search over minutes).
  const candidates = offsets.map(offset => target - offset).sort((a, b) => a - b);
  let low = candidates[0] - DAY_MS;
  let high = candidates[candidates.length - 1] + DAY_MS;
  low = Math.floor(low / MINUTE_MS);
  high = Math.ceil(high / MINUTE_MS);
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (wallKey(wallOf(mid * MINUTE_MS, tz)) >= target) high = mid; else low = mid + 1;
  }
  return low * MINUTE_MS;
}

// ---- Calendar dates (plain dates as UTC midnights) ----
const dateMs = text => { const [y, m, d] = text.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const dateText = ms => new Date(ms).toISOString().slice(0, 10);
const isoDow = ms => ((new Date(ms).getUTCDay() + 6) % 7) + 1; // Monday = 1
const daysInMonth = ms => { const date = new Date(ms); return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate(); };
function validDate(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const ms = dateMs(text);
  return Number.isFinite(ms) && dateText(ms) === text;
}
const validTime = text => typeof text === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(text);
const localDateOf = (ms, tz) => { const w = wallOf(ms, tz); return Date.UTC(w.y, w.m - 1, w.d); };

// ---- Validation ----
function only(value, keys, name) {
  for (const key of Object.keys(value)) if (!keys.includes(key) && value[key] !== undefined) throw invalid(`${name} has an unknown field: ${key}`);
}
const given = value => value !== undefined && value !== null && value !== '';

// A schedule body value -> the canonical schedule, or null (none). `tz`: the zone used when the value names none; `starts`: the first day of an
// "every N days" rule that names none (the anchor its days are counted from).
function normalizeSchedule(value, { tz, starts } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (!isPlainObject(value)) throw invalid('schedule must be a JSON object');
  only(value, ['kind', 'at', 'rule', 'starts', 'ends', 'tz'], 'schedule');
  const zone = given(value.tz) ? value.tz : tz;
  if (!validZone(zone)) throw invalid('schedule.tz must be an IANA time zone, for example Asia/Taipei');
  if (value.kind === 'once') {
    if (given(value.rule) || given(value.starts) || given(value.ends)) throw invalid('A schedule that happens once has only a time (at)');
    if (typeof value.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value.at) || !validDate(value.at.slice(0, 10)) || !validTime(value.at.slice(11))) {
      throw invalid('schedule.at must be a date and time in the form YYYY-MM-DDTHH:mm');
    }
    return { kind: 'once', at: value.at, tz: zone };
  }
  if (value.kind !== 'repeat') throw invalid("schedule.kind must be 'once' or 'repeat'");
  if (given(value.at)) throw invalid('A repeating schedule has a rule, not a time (at)');
  if (!isPlainObject(value.rule)) throw invalid('A repeating schedule needs a rule');
  const raw = value.rule;
  only(raw, ['freq', 'days', 'day', 'interval', 'time'], 'schedule.rule');
  if (!FREQS.includes(raw.freq)) throw invalid(`schedule.rule.freq must be one of: ${FREQS.join(', ')}`);
  if (!validTime(raw.time)) throw invalid('schedule.rule.time must be a time in the form HH:mm');
  const rule = { freq: raw.freq };
  const extra = { days: 'weekly', day: 'monthly', interval: 'every' };
  for (const [key, freq] of Object.entries(extra)) if (given(raw[key]) && raw.freq !== freq) throw invalid(`schedule.rule.${key} is only for the rule ${freq}`);
  if (raw.freq === 'weekly') {
    if (!Array.isArray(raw.days) || !raw.days.length) throw invalid('A weekly rule needs at least one day (schedule.rule.days, Monday = 1)');
    if (raw.days.some(day => !Number.isInteger(day) || day < 1 || day > 7)) throw invalid('schedule.rule.days must be days 1 to 7 (Monday = 1)');
    rule.days = [...new Set(raw.days)].sort((a, b) => a - b);
  }
  if (raw.freq === 'monthly') {
    if (!Number.isInteger(raw.day) || raw.day < 1 || raw.day > 31) throw invalid('schedule.rule.day must be a day of the month from 1 to 31');
    rule.day = raw.day;
  }
  if (raw.freq === 'every') {
    if (!Number.isInteger(raw.interval) || raw.interval < 1 || raw.interval > 365) throw invalid('schedule.rule.interval must be a number of days from 1 to 365');
    rule.interval = raw.interval;
  }
  rule.time = raw.time;
  const out = { kind: 'repeat', rule };
  if (given(value.starts)) {
    if (!validDate(value.starts)) throw invalid('schedule.starts must be a date in the form YYYY-MM-DD');
    out.starts = value.starts;
  } else if (raw.freq === 'every') {
    if (!validDate(starts)) throw invalid('An every-N-days rule needs schedule.starts');
    out.starts = starts;
  }
  if (given(value.ends)) {
    if (!isPlainObject(value.ends)) throw invalid('schedule.ends must be a JSON object');
    only(value.ends, ['kind', 'date', 'count'], 'schedule.ends');
    const ends = value.ends;
    if (ends.kind === 'on') {
      if (given(ends.count)) throw invalid('schedule.ends.count is only for ends after N times');
      if (!validDate(ends.date)) throw invalid('schedule.ends.date must be a date in the form YYYY-MM-DD');
      if (out.starts && ends.date < out.starts) throw invalid('The schedule cannot end before it starts');
      out.ends = { kind: 'on', date: ends.date };
    } else if (ends.kind === 'after') {
      if (given(ends.date)) throw invalid('schedule.ends.date is only for ends on a date');
      if (!Number.isInteger(ends.count) || ends.count < 1 || ends.count > 9999) throw invalid('schedule.ends.count must be a number from 1 to 9999');
      out.ends = { kind: 'after', count: ends.count };
    } else if (ends.kind === 'never') {
      if (given(ends.date) || given(ends.count)) throw invalid('An end of never has no date or count');
    } else {
      throw invalid("schedule.ends.kind must be 'never', 'on' or 'after'");
    }
  }
  out.tz = zone;
  return out;
}

// then_action body value -> null (remind me: the default), { kind: 'prompt', task_id, terminal_id, text } (a session of the owner engine) or
// { kind: 'script', task_id, script, timeout_min } (run in a new terminal of a task of the owner engine; the time limit defaults to 30 minutes).
function normalizeThenAction(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!isPlainObject(value)) throw invalid('then_action must be a JSON object');
  if (value.kind === 'remind') {
    only(value, ['kind'], 'then_action');
    return null;
  }
  if (value.kind === 'script') {
    only(value, ['kind', 'task_id', 'script', 'timeout_min'], 'then_action');
    const scriptTask = typeof value.task_id === 'string' && /^\d{1,15}$/.test(value.task_id) ? Number(value.task_id) : value.task_id;
    if (!Number.isSafeInteger(scriptTask) || scriptTask < 1) throw invalid('A script needs the task to run it in (then_action.task_id)');
    if (typeof value.script !== 'string' || !value.script.trim()) throw invalid('The script cannot be empty');
    if (value.script.length > SCRIPT_MAX) throw invalid(`The script cannot exceed ${SCRIPT_MAX} characters`);
    if (CONTROL.test(value.script)) throw invalid('The script contains disallowed control characters');
    const minutes = value.timeout_min === undefined || value.timeout_min === null || value.timeout_min === '' ? SCRIPT_TIMEOUT_DEFAULT : value.timeout_min;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > SCRIPT_TIMEOUT_MAX) throw invalid(`then_action.timeout_min must be a number of minutes from 1 to ${SCRIPT_TIMEOUT_MAX}`);
    return { kind: 'script', task_id: String(scriptTask), script: value.script, timeout_min: minutes };
  }
  if (value.kind !== 'prompt') throw invalid("then_action.kind must be 'remind', 'prompt' or 'script'");
  only(value, ['kind', 'task_id', 'terminal_id', 'text'], 'then_action');
  const taskId = typeof value.task_id === 'string' && /^\d{1,15}$/.test(value.task_id) ? Number(value.task_id) : value.task_id;
  if (!Number.isSafeInteger(taskId) || taskId < 1 || typeof value.terminal_id !== 'string' || !TERMINAL_ID.test(value.terminal_id)) {
    throw invalid('A prompt needs the session to send it to (then_action.task_id and then_action.terminal_id)');
  }
  if (typeof value.text !== 'string' || !value.text.trim()) throw invalid('The prompt cannot be empty');
  if (value.text.length > PROMPT_MAX) throw invalid(`The prompt cannot exceed ${PROMPT_MAX} characters`);
  if (CONTROL.test(value.text)) throw invalid('The prompt contains disallowed control characters');
  return { kind: 'prompt', task_id: String(taskId), terminal_id: value.terminal_id, text: value.text };
}

// ---- Occurrences ----
function matches(rule, day, starts) {
  switch (rule.freq) {
    case 'daily': return true;
    case 'weekdays': return isoDow(day) <= 5;
    case 'weekly': return rule.days.includes(isoDow(day));
    case 'monthly': return new Date(day).getUTCDate() === Math.min(rule.day, daysInMonth(day));
    case 'every': { const diff = Math.round((day - dateMs(starts)) / DAY_MS); return diff >= 0 && diff % rule.interval === 0; }
    default: return false;
  }
}
// The instant of the rule's time on a calendar day.
function onDay(schedule, day) {
  const date = new Date(day);
  const [hh, mm] = schedule.rule.time.split(':').map(Number);
  return localToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hh, mm, schedule.tz);
}
const onceAt = schedule => {
  const [date, time] = schedule.at.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return localToUtc(y, m, d, hh, mm, schedule.tz);
};

// The first occurrence of a repeating rule strictly after afterMs, ignoring a count end (ends after N); null when the end date is passed.
function nextRaw(schedule, afterMs) {
  const first = schedule.starts ? dateMs(schedule.starts) : -Infinity;
  const last = schedule.ends && schedule.ends.kind === 'on' ? dateMs(schedule.ends.date) : Infinity;
  let day = Math.max(localDateOf(afterMs, schedule.tz) - DAY_MS, first);
  for (let i = 0; i < SCAN_DAYS + 2; i += 1, day += DAY_MS) {
    if (day > last) return null;
    if (!matches(schedule.rule, day, schedule.starts)) continue;
    const at = onDay(schedule, day);
    if (at > afterMs) return at;
  }
  return null;
}

// The next fire time (ms) after afterMs, or null. runs: the times it has fired since it was saved.
function nextOccurrence(schedule, afterMs, { runs = 0 } = {}) {
  if (!schedule) return null;
  if (schedule.kind === 'once') return runs > 0 ? null : onceAt(schedule);
  if (schedule.ends && schedule.ends.kind === 'after' && runs >= schedule.ends.count) return null;
  return nextRaw(schedule, afterMs);
}

// How many occurrences fell in [fromMs, toMs]: the times a firing at toMs stands for (1, or more after the engine was off).
function occurrencesBetween(schedule, fromMs, toMs) {
  if (!schedule || schedule.kind === 'once' || fromMs > toMs) return 1;
  let count = 1;
  let at = fromMs;
  while (count < MAX_MISSED) {
    const next = nextRaw(schedule, at);
    if (next === null || next > toMs) break;
    count += 1;
    at = next;
  }
  return count;
}

// The next `count` fire times after nowMs (a fresh schedule: nothing fired yet), as ISO UTC.
function upcoming(schedule, nowMs, count = 3) {
  const out = [];
  let after = nowMs;
  for (let runs = 0; out.length < count; runs += 1) {
    const at = nextOccurrence(schedule, after, { runs });
    if (at === null) break;
    out.push(new Date(at).toISOString());
    if (schedule.kind === 'once') break;
    after = at;
  }
  return out;
}

// HH:mm of an instant in a zone (the busy note of a prompt).
const clockIn = (ms, tz) => { const w = wallOf(ms, tz); return `${pad(w.hh)}:${pad(w.mm)}`; };

// ---- Text (English; Chinese in public/js/i18n-zh-extra.js, which has a template per sentence and the day names) ----
function dayList(days) {
  const names = days.map(day => DAY_NAMES[day - 1]);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
// "Every Monday at 09:00", "Once on 2026-12-01 at 10:00", parts after " · ": "starting <date>", "until <date>", "ends after <n> times".
function describe(schedule) {
  if (!schedule) return null;
  if (schedule.kind === 'once') return `Once on ${schedule.at.slice(0, 10)} at ${schedule.at.slice(11)}`;
  const { rule } = schedule;
  let head;
  if (rule.freq === 'daily' || (rule.freq === 'every' && rule.interval === 1) || (rule.freq === 'weekly' && rule.days.length === 7)) head = `Every day at ${rule.time}`;
  else if (rule.freq === 'weekdays' || (rule.freq === 'weekly' && rule.days.join() === '1,2,3,4,5')) head = `Every weekday at ${rule.time}`;
  else if (rule.freq === 'weekly') head = `Every ${dayList(rule.days)} at ${rule.time}`;
  else if (rule.freq === 'monthly') head = `Every month on day ${rule.day} at ${rule.time}`;
  else head = `Every ${rule.interval} days at ${rule.time}`;
  const parts = [head];
  if (schedule.starts) parts.push(`starting ${schedule.starts}`);
  if (schedule.ends && schedule.ends.kind === 'on') parts.push(`until ${schedule.ends.date}`);
  if (schedule.ends && schedule.ends.kind === 'after') parts.push(schedule.ends.count === 1 ? 'ends after 1 time' : `ends after ${schedule.ends.count} times`);
  return parts.join(' · ');
}

// POST /api/attention/schedule/preview: { next: [up to 3 ISO UTC], text } or { next: [], text: null, error } for a schedule that is not valid.
function preview(value, nowMs, { tz } = {}) {
  try {
    const schedule = normalizeSchedule(value, { tz, starts: dateText(localDateOf(nowMs, validZone(tz) ? tz : 'UTC')) });
    if (!schedule) return { next: [], text: null, error: 'schedule must be a JSON object' };
    const next = upcoming(schedule, nowMs);
    if (!next.length) return { next, text: describe(schedule), error: 'The schedule ends before its next time' };
    return { next, text: describe(schedule) };
  } catch (error) {
    if (error instanceof ScheduleError) return { next: [], text: null, error: error.message };
    throw error;
  }
}

// The zone of this machine (TZ in the environment, else the system's).
const systemZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

module.exports = {
  CAPABILITY, FREQS, DAY_NAMES, PROMPT_MAX, SCRIPT_MAX, SCRIPT_TIMEOUT_DEFAULT, SCRIPT_TIMEOUT_MAX, ScheduleError,
  normalizeSchedule, normalizeThenAction, nextOccurrence, occurrencesBetween, upcoming, describe, preview,
  localToUtc, localDateOf, dateText, clockIn, validZone, systemZone,
};
