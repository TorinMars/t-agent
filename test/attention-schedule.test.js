// The schedule rules of T-Attention (services/attention-schedule.js), pure: fixed clocks and fixed zones, America/New_York across both daylight saving
// changes and Asia/Taipei (no daylight saving time), and the Chinese of the sentences.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-attention-schedule-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const s = require('../services/attention-schedule');

const NY = 'America/New_York';
const TPE = 'Asia/Taipei';
const at = text => Date.parse(text);
const iso = ms => (ms === null ? null : new Date(ms).toISOString());
const repeat = (rule, extra = {}, tz = TPE) => s.normalizeSchedule({ kind: 'repeat', rule, ...extra }, { tz, starts: '2026-11-20' });

test('local wall times become instants in their zone, also across daylight saving time', () => {
  assert.equal(iso(s.localToUtc(2026, 12, 1, 10, 0, TPE)), '2026-12-01T02:00:00.000Z');
  assert.equal(iso(s.localToUtc(2027, 1, 10, 9, 0, NY)), '2027-01-10T14:00:00.000Z', 'EST');
  assert.equal(iso(s.localToUtc(2027, 7, 10, 9, 0, NY)), '2027-07-10T13:00:00.000Z', 'EDT');
  // 2027-03-14 02:00 EST jumps to 03:00 EDT: 02:30 does not exist and moves to the next minute that does, 03:00 EDT.
  assert.equal(iso(s.localToUtc(2027, 3, 14, 2, 30, NY)), '2027-03-14T07:00:00.000Z');
  // 2027-11-07 01:30 happens twice (EDT, then EST): the first one.
  assert.equal(iso(s.localToUtc(2027, 11, 7, 1, 30, NY)), '2027-11-07T05:30:00.000Z');
});

test('a daily rule keeps its wall time across both changes, fires once on the doubled hour and skips the missing one forward', () => {
  const spring = repeat({ freq: 'daily', time: '02:30' }, {}, NY);
  assert.deepEqual(s.upcoming(spring, at('2027-03-12T12:00:00Z'), 4), ['2027-03-13T07:30:00.000Z', '2027-03-14T07:00:00.000Z', '2027-03-15T06:30:00.000Z', '2027-03-16T06:30:00.000Z']);
  const fall = repeat({ freq: 'daily', time: '01:30' }, {}, NY);
  assert.deepEqual(s.upcoming(fall, at('2027-11-05T12:00:00Z'), 4), ['2027-11-06T05:30:00.000Z', '2027-11-07T05:30:00.000Z', '2027-11-08T06:30:00.000Z', '2027-11-09T06:30:00.000Z']);
  // After the first 01:30 of the doubled night, the next time is the next day, not the second 01:30.
  assert.equal(iso(s.nextOccurrence(fall, at('2027-11-07T05:30:00Z'))), '2027-11-08T06:30:00.000Z');
  const nine = repeat({ freq: 'daily', time: '09:00' }, {}, NY);
  assert.deepEqual(s.upcoming(nine, at('2027-03-13T15:00:00Z'), 2), ['2027-03-14T13:00:00.000Z', '2027-03-15T13:00:00.000Z']);
});

test('weekdays, weekly, monthly (a short month uses its last day) and every N days from the first day', () => {
  const now = at('2026-11-20T00:00:00Z'); // Friday 08:00 in Taipei
  assert.deepEqual(s.upcoming(repeat({ freq: 'weekdays', time: '09:00' }), now, 3), ['2026-11-20T01:00:00.000Z', '2026-11-23T01:00:00.000Z', '2026-11-24T01:00:00.000Z']);
  assert.deepEqual(s.upcoming(repeat({ freq: 'weekly', days: [4, 1], time: '09:00' }), now, 3), ['2026-11-23T01:00:00.000Z', '2026-11-26T01:00:00.000Z', '2026-11-30T01:00:00.000Z']);
  assert.deepEqual(s.upcoming(repeat({ freq: 'monthly', day: 31, time: '09:00' }), at('2027-01-20T00:00:00Z'), 3), ['2027-01-31T01:00:00.000Z', '2027-02-28T01:00:00.000Z', '2027-03-31T01:00:00.000Z']);
  assert.deepEqual(s.upcoming(repeat({ freq: 'every', interval: 3, time: '09:00' }), now, 3), ['2026-11-20T01:00:00.000Z', '2026-11-23T01:00:00.000Z', '2026-11-26T01:00:00.000Z']);
  const later = repeat({ freq: 'daily', time: '09:00' }, { starts: '2026-12-24' });
  assert.equal(iso(s.nextOccurrence(later, now)), '2026-12-24T01:00:00.000Z', 'nothing before the first day');
});

test('ends: on a date (inclusive), after N runs, and a once schedule fires once, also when its time is past', () => {
  const now = at('2026-11-20T00:00:00Z');
  const until = repeat({ freq: 'daily', time: '09:00' }, { ends: { kind: 'on', date: '2026-11-21' } });
  assert.deepEqual(s.upcoming(until, now, 5), ['2026-11-20T01:00:00.000Z', '2026-11-21T01:00:00.000Z']);
  const twice = repeat({ freq: 'daily', time: '09:00' }, { ends: { kind: 'after', count: 2 } });
  assert.equal(s.upcoming(twice, now, 5).length, 2);
  assert.equal(s.nextOccurrence(twice, now, { runs: 2 }), null);
  const once = s.normalizeSchedule({ kind: 'once', at: '2026-11-01T10:00' }, { tz: TPE });
  assert.equal(iso(s.nextOccurrence(once, now)), '2026-11-01T02:00:00.000Z', 'a past time fires at once');
  assert.equal(s.nextOccurrence(once, now, { runs: 1 }), null);
  // Missed times while the engine was off: counted, so the firing can say how many.
  const daily = repeat({ freq: 'daily', time: '09:00' });
  assert.equal(s.occurrencesBetween(daily, at('2026-11-20T01:00:00Z'), at('2026-11-23T03:00:00Z')), 4);
  assert.equal(s.occurrencesBetween(daily, at('2026-11-20T01:00:00Z'), at('2026-11-20T01:00:30Z')), 1);
});

test('the canonical form: fixed order, days sorted and unique, ends never left out, the zone and first day filled in', () => {
  const value = s.normalizeSchedule({ tz: NY, ends: { kind: 'never' }, rule: { time: '07:05', days: [5, 1, 5], freq: 'weekly' }, kind: 'repeat' }, { tz: TPE });
  assert.equal(JSON.stringify(value), '{"kind":"repeat","rule":{"freq":"weekly","days":[1,5],"time":"07:05"},"tz":"America/New_York"}');
  assert.equal(s.normalizeSchedule({ kind: 'repeat', rule: { freq: 'every', interval: 2, time: '09:00' } }, { tz: TPE, starts: '2026-11-20' }).starts, '2026-11-20');
  assert.equal(s.normalizeSchedule(null), null);
});

test('a schedule that is not valid is refused with a clear English message', () => {
  const refuses = (value, pattern) => assert.throws(() => s.normalizeSchedule(value, { tz: TPE, starts: '2026-11-20' }), error => error instanceof s.ScheduleError && pattern.test(error.message), JSON.stringify(value));
  refuses({ kind: 'repeat', rule: { freq: 'weekly', days: [], time: '09:00' } }, /needs at least one day/);
  refuses({ kind: 'repeat', rule: { freq: 'daily', time: '24:00' } }, /HH:mm/);
  refuses({ kind: 'repeat', rule: { freq: 'daily', time: '09:00', day: 3 } }, /only for the rule monthly/);
  refuses({ kind: 'repeat', rule: { freq: 'hourly', time: '09:00' } }, /freq must be one of/);
  refuses({ kind: 'once', at: '2026-02-30T10:00' }, /YYYY-MM-DDTHH:mm/);
  refuses({ kind: 'once', at: '2026-12-01T10:00', colour: 'red' }, /unknown field: colour/);
  refuses({ kind: 'repeat', rule: { freq: 'daily', time: '09:00', extra: 1 } }, /schedule.rule has an unknown field/);
  refuses({ kind: 'repeat', rule: { freq: 'daily', time: '09:00' }, tz: 'Mars/Olympus' }, /IANA time zone/);
  refuses({ kind: 'repeat', rule: { freq: 'daily', time: '09:00' }, starts: '2026-12-10', ends: { kind: 'on', date: '2026-12-01' } }, /cannot end before it starts/);
  refuses({ kind: 'repeat', rule: { freq: 'monthly', day: 32, time: '09:00' } }, /1 to 31/);
  refuses({ kind: 'repeat', rule: { freq: 'every', interval: 0, time: '09:00' } }, /1 to 365/);
});

test('then_action: remind is none, a prompt needs a session, a script a task; limits', () => {
  assert.equal(s.normalizeThenAction({ kind: 'remind' }), null);
  assert.deepEqual(s.normalizeThenAction({ kind: 'prompt', task_id: 7, terminal_id: 'abc-1', text: 'Run the tests' }), { kind: 'prompt', task_id: '7', terminal_id: 'abc-1', text: 'Run the tests' });
  assert.throws(() => s.normalizeThenAction({ kind: 'prompt', text: 'x' }), /needs the session/);
  assert.throws(() => s.normalizeThenAction({ kind: 'prompt', task_id: 1, terminal_id: 't', text: 'x'.repeat(4001) }), /cannot exceed 4000/);
  assert.deepEqual(s.normalizeThenAction({ kind: 'script', task_id: '3', script: 'npm test' }), { kind: 'script', task_id: '3', script: 'npm test', timeout_min: 30 });
  assert.throws(() => s.normalizeThenAction({ kind: 'script', task_id: 3, script: 'x', timeout_min: 721 }), /1 to 720/);
  assert.throws(() => s.normalizeThenAction({ kind: 'script', task_id: 3, script: '  ' }), /cannot be empty/);
  assert.throws(() => s.normalizeThenAction({ kind: 'shell' }), /must be 'remind', 'prompt' or 'script'/);
});

test('the sentence of a schedule, and the preview (three times, or the reason it is not valid)', () => {
  assert.equal(s.describe(repeat({ freq: 'weekly', days: [1], time: '09:00' })), 'Every Monday at 09:00');
  assert.equal(s.describe(repeat({ freq: 'weekly', days: [1, 3, 5], time: '09:00' })), 'Every Monday, Wednesday and Friday at 09:00');
  assert.equal(s.describe(repeat({ freq: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' })), 'Every weekday at 09:00');
  assert.equal(s.describe(repeat({ freq: 'every', interval: 3, time: '09:00' })), 'Every 3 days at 09:00 · starting 2026-11-20');
  assert.equal(s.describe(repeat({ freq: 'daily', time: '09:00' }, { ends: { kind: 'after', count: 5 } })), 'Every day at 09:00 · ends after 5 times');
  assert.equal(s.describe(s.normalizeSchedule({ kind: 'once', at: '2026-12-01T10:00' }, { tz: TPE })), 'Once on 2026-12-01 at 10:00');
  const preview = s.preview({ kind: 'repeat', rule: { freq: 'monthly', day: 15, time: '09:00' } }, at('2026-11-20T00:00:00Z'), { tz: TPE });
  assert.deepEqual(preview, { next: ['2026-12-15T01:00:00.000Z', '2027-01-15T01:00:00.000Z', '2027-02-15T01:00:00.000Z'], text: 'Every month on day 15 at 09:00' });
  assert.deepEqual(s.preview({ kind: 'repeat', rule: { freq: 'weekly', days: [], time: '09:00' } }, 0, { tz: TPE }).next, []);
  assert.match(s.preview({ kind: 'repeat', rule: { freq: 'daily', time: '09:00' }, ends: { kind: 'on', date: '2026-01-01' } }, at('2026-11-20T00:00:00Z'), { tz: TPE }).error, /ends before its next time/);
});

test('the sentences, notes and messages read as whole Chinese sentences', () => {
  const sandbox = { TALocalKeys: { get: () => 'zh', set() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['i18n.js', 'i18n-zh-ui.js', 'i18n-zh-server.js', 'i18n-zh-extra.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', file), 'utf8'), sandbox);
  const t = sandbox.I18n.t;
  const HAN = /[\u4e00-\u9fff]/;
  for (const text of [
    'Every Monday at 09:00', 'Every Monday and Thursday at 09:00', 'Every Monday, Tuesday, Wednesday, Thursday, Friday and Saturday at 09:00',
    'Every day at 09:00 · until 2027-01-31 · ends after 5 times', 'Every 3 days at 09:00 · starting 2026-11-20', 'Once on 2026-12-01 at 10:00',
    'The session was busy at 09:00; the prompt was not sent', 'Script failed (exit 2) at 09:01', 'Script stopped after 30 min at 09:31',
    'A weekly rule needs at least one day (schedule.rule.days, Monday = 1)', 'schedule has an unknown field: colour',
  ]) {
    const zh = t(text);
    assert.ok(HAN.test(zh), `${text} -> ${zh}`);
    assert.doesNotMatch(zh.replace(/schedule\.rule\.days|colour/g, ''), /\b(Every|at|until|ends|times|Monday|Script|session)\b/, `${text} -> ${zh}`);
  }
  assert.equal(t('Every Monday and Thursday at 09:00'), '\u6bcf\u5468\u4e00\u548c\u5468\u56db 09:00');
});
