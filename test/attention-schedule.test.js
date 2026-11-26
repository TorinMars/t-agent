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

// ---- Yearly rules: birthdays and anniversaries, solar or lunar ("Yearly dates" in docs/design/attention-schedules.md) ----
const lunar = require('../lib/lunar');
const yearly = (rule, extra = {}, tz = TPE) => s.normalizeSchedule({ kind: 'repeat', rule: { freq: 'yearly', time: '09:00', ...rule }, ...extra }, { tz });

test('lunar dates come from Intl: known days, a leap month, day 30 of a 29-day month', () => {
  assert.deepEqual(lunar.lunarOf('2026-11-15'), { year: 2026, month: 10, day: 7, leap: false });
  assert.deepEqual(lunar.lunarOf('2026-11-12'), { year: 2026, month: 10, day: 4, leap: false });
  assert.deepEqual(lunar.lunarOf('2025-07-25'), { year: 2025, month: 6, day: 1, leap: true }, 'Intl writes the leap month as 6bis');
  assert.deepEqual(lunar.lunarOf('2026-01-10'), { year: 2025, month: 11, day: 22, leap: false }, 'January before the new year is the lunar year before');
  assert.equal(lunar.lunarOf('2026-02-30'), null);
  assert.equal(dateOf(lunar.dayOf(2025, 6, 1, true)), '2025-07-25');
  assert.equal(lunar.dayOf(2026, 6, 1, true), null, '2026 has no leap month 6');
  assert.equal(dateOf(lunar.dayOf(2025, 6, 30)), '2025-07-24', 'month 6 of 2025 has 30 days');
  assert.equal(dateOf(lunar.dayOf(2025, 2, 30)), '2025-03-28', 'month 2 of 2025 has 29 days: its day 29');
  assert.deepEqual(lunar.lunarLabel('6', '1', 1), { month: 6, day: 1, leap: true });
});
const dateOf = ms => (ms === null ? null : new Date(ms).toISOString().slice(0, 10));

test('a yearly solar rule: next and after, Feb 29 on Feb 28 in a common year, the time across daylight saving time', () => {
  const birthday = yearly({ month: 11, day: 15, occasion: 'birthday', year: 1964 });
  assert.deepEqual(s.upcoming(birthday, at('2026-11-10T00:00:00Z'), 2), ['2026-11-15T01:00:00.000Z', '2027-11-15T01:00:00.000Z']);
  assert.equal(iso(s.nextOccurrence(birthday, at('2026-11-15T01:00:00Z'))), '2027-11-15T01:00:00.000Z', 'after its time: next year');
  assert.deepEqual(s.upcoming(yearly({ month: 2, day: 29 }), at('2026-11-20T00:00:00Z'), 3), ['2027-02-28T01:00:00.000Z', '2028-02-29T01:00:00.000Z', '2029-02-28T01:00:00.000Z']);
  assert.equal(iso(s.nextOccurrence(yearly({ month: 3, day: 14, time: '02:30' }, {}, NY), at('2027-01-01T00:00:00Z'))), '2027-03-14T07:00:00.000Z', 'the missing hour moves forward');
  const ended = yearly({ month: 1, day: 1 }, { ends: { kind: 'on', date: '2027-06-30' } });
  assert.deepEqual(s.upcoming(ended, at('2026-11-20T00:00:00Z'), 3), ['2027-01-01T01:00:00.000Z']);
});

test('a yearly lunar rule: the 2026-11-15 sample, a leap month only in a year that has it, day 30 falls back to 29, quick', () => {
  const started = Date.now();
  const tenSeven = yearly({ calendar: 'lunar', month: 10, day: 7 });
  assert.deepEqual(s.upcoming(tenSeven, at('2026-11-01T00:00:00Z'), 3), ['2026-11-15T01:00:00.000Z', '2027-11-04T01:00:00.000Z', '2028-11-22T01:00:00.000Z']);
  assert.equal(iso(s.nextOccurrence(tenSeven, at('2026-11-12T00:00:00Z'))), '2026-11-15T01:00:00.000Z', 'on 2026-11-12 (10/4) the next is three days later');
  const leap = yearly({ calendar: 'lunar', month: 6, day: 1, leap: true });
  assert.deepEqual(s.upcoming(leap, at('2025-01-01T00:00:00Z'), 2), ['2025-07-25T01:00:00.000Z', '2036-07-23T01:00:00.000Z'], 'leap month 6: 2025, then 2036');
  assert.deepEqual(s.upcoming(yearly({ calendar: 'lunar', month: 6, day: 1 }), at('2025-06-01T00:00:00Z'), 2), ['2025-06-25T01:00:00.000Z', '2026-07-14T01:00:00.000Z'], 'the plain month 6, not the leap one');
  assert.deepEqual(s.occurrencesIn(yearly({ calendar: 'lunar', month: 2, day: 30 }), '2025-01-01', '2025-12-31'), ['2025-03-28']);
  // A leap month that does not come in YEARLY_YEARS: the preview says so instead of "ends before its next time".
  assert.match(s.preview({ kind: 'repeat', rule: { freq: 'yearly', calendar: 'lunar', month: 12, day: 1, leap: true, time: '09:00' } }, at('2026-11-20T00:00:00Z'), { tz: TPE }).error, /does not come in the next 100 years/);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

test('a yearly rule is validated and kept in its canonical form', () => {
  const value = s.normalizeSchedule({ kind: 'repeat', tz: TPE, rule: { time: '09:00', year: 2018, occasion: 'anniversary', leap: true, day: 1, month: 6, calendar: 'lunar', freq: 'yearly' } });
  assert.equal(JSON.stringify(value.rule), '{"freq":"yearly","calendar":"lunar","month":6,"day":1,"leap":true,"occasion":"anniversary","year":2018,"time":"09:00"}');
  assert.equal(JSON.stringify(yearly({ month: 2, day: 29, leap: false }).rule), '{"freq":"yearly","calendar":"solar","month":2,"day":29,"time":"09:00"}', 'calendar written, leap false left out');
  const refuses = (rule, pattern) => assert.throws(() => yearly(rule), error => error instanceof s.ScheduleError && pattern.test(error.message), JSON.stringify(rule));
  refuses({ month: 2, day: 30 }, /^There is no day 30 in month 2$/);
  refuses({ month: 4, day: 31 }, /no day 31 in month 4/);
  refuses({ month: 13, day: 1 }, /month from 1 to 12/);
  refuses({ day: 1 }, /month from 1 to 12/);
  refuses({ month: 1, day: 32 }, /1 to 31/);
  refuses({ calendar: 'lunar', month: 1, day: 31 }, /lunar date must be a day from 1 to 30/);
  refuses({ calendar: 'hebrew', month: 1, day: 1 }, /'solar' or 'lunar'/);
  refuses({ month: 1, day: 1, leap: true }, /only for a lunar date/);
  refuses({ calendar: 'lunar', month: 1, day: 1, leap: 'yes' }, /must be true/);
  refuses({ month: 1, day: 1, occasion: 'wedding' }, /'birthday' or 'anniversary'/);
  refuses({ month: 1, day: 1, year: 1899 }, /1900 to 2100/);
  refuses({ month: 1, day: 1, interval: 2 }, /only for the rule every/);
  assert.throws(() => repeat({ freq: 'monthly', day: 3, month: 4, time: '09:00' }), /schedule.rule.month is only for the rule yearly/);
  assert.throws(() => repeat({ freq: 'daily', occasion: 'birthday', time: '09:00' }), /schedule.rule.occasion is only for the rule yearly/);
});

test('the sentence of a yearly rule', () => {
  assert.equal(s.describe(yearly({ month: 11, day: 15 })), 'Every year on 11-15 at 09:00');
  assert.equal(s.describe(yearly({ calendar: 'lunar', month: 10, day: 7, occasion: 'birthday', year: 1964 })), 'Every year on lunar month 10, day 7 at 09:00 · birthday');
  assert.equal(s.describe(yearly({ calendar: 'lunar', month: 6, day: 1, leap: true, occasion: 'anniversary' })), 'Every year on lunar leap month 6, day 1 at 09:00 · anniversary');
  assert.deepEqual(s.preview({ kind: 'repeat', rule: { freq: 'yearly', month: 2, day: 29, time: '08:00' } }, at('2026-11-20T00:00:00Z'), { tz: TPE }),
    { next: ['2027-02-28T00:00:00.000Z', '2028-02-29T00:00:00.000Z', '2029-02-28T00:00:00.000Z'], text: 'Every year on 02-29 at 08:00' });
});

test('occurrencesIn: the days of once and every repeat in a range, with starts, ends and the 400-day cap', () => {
  const once = s.normalizeSchedule({ kind: 'once', at: '2026-12-01T10:00' }, { tz: TPE });
  assert.deepEqual(s.occurrencesIn(once, '2026-11-01', '2026-12-31'), ['2026-12-01']);
  assert.deepEqual(s.occurrencesIn(once, '2026-12-02', '2026-12-31'), []);
  const weekly = repeat({ freq: 'weekly', days: [1, 4], time: '09:00' }, { starts: '2026-11-05' });
  assert.deepEqual(s.occurrencesIn(weekly, '2026-11-01', '2026-11-16'), ['2026-11-05', '2026-11-09', '2026-11-12', '2026-11-16']);
  assert.deepEqual(s.occurrencesIn(repeat({ freq: 'monthly', day: 31, time: '09:00' }, { starts: '2026-12-01', ends: { kind: 'on', date: '2027-03-15' } }), '2026-11-01', '2027-12-31'),
    ['2026-12-31', '2027-01-31', '2027-02-28']);
  assert.deepEqual(s.occurrencesIn(repeat({ freq: 'every', interval: 3, time: '09:00' }), '2026-11-18', '2026-11-27'), ['2026-11-20', '2026-11-23', '2026-11-26']);
  assert.deepEqual(s.occurrencesIn(repeat({ freq: 'weekdays', time: '09:00' }), '2026-11-27', '2026-12-01'), ['2026-11-27', '2026-11-30', '2026-12-01']);
  // Ends after N: N occurrences from the first one on or after starts.
  const three = repeat({ freq: 'weekly', days: [1], time: '09:00' }, { starts: '2026-11-01', ends: { kind: 'after', count: 3 } });
  assert.deepEqual(s.occurrencesIn(three, '2026-11-10', '2026-12-31'), ['2026-11-16']);
  assert.deepEqual(s.occurrencesIn(three, '2026-11-01', '2026-12-31'), ['2026-11-02', '2026-11-09', '2026-11-16']);
  // Yearly, solar and lunar, over two years (the range is cut at 400 days: 2026-01-01 .. 2027-02-04).
  assert.deepEqual(s.occurrencesIn(yearly({ month: 2, day: 29 }), '2027-01-01', '2028-12-31'), ['2027-02-28']);
  assert.deepEqual(s.occurrencesIn(yearly({ month: 2, day: 29 }), '2027-12-01', '2028-12-31'), ['2028-02-29'], 'a leap year keeps Feb 29');
  assert.deepEqual(s.occurrencesIn(yearly({ calendar: 'lunar', month: 10, day: 7 }), '2026-01-01', '2027-12-31'), ['2026-11-15']);
  assert.deepEqual(s.occurrencesIn(yearly({ calendar: 'lunar', month: 10, day: 7 }), '2027-01-01', '2027-12-31'), ['2027-11-04']);
  assert.deepEqual(s.occurrencesIn(yearly({ calendar: 'lunar', month: 6, day: 1, leap: true }), '2026-01-01', '2026-12-31'), [], 'no leap month 6 in 2026');
  const daily = repeat({ freq: 'daily', time: '09:00' });
  const capped = s.occurrencesIn(daily, '2026-01-01', '2027-12-31');
  assert.deepEqual([capped.length, capped[0], capped.at(-1)], [s.RANGE_DAYS, '2026-01-01', '2027-02-04']);
  assert.deepEqual(s.occurrencesIn(daily, '2026-12-01', '2026-11-01'), [], 'a range backwards');
  assert.deepEqual(s.occurrencesIn(daily, 'tomorrow', '2026-11-01'), []);
  assert.deepEqual(s.occurrencesIn(null, '2026-11-01', '2026-11-30'), []);
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
    'Every year on 11-15 at 09:00 \u00b7 birthday', 'Every year on lunar month 10, day 7 at 09:00', 'Every year on lunar leap month 6, day 1 at 09:00 \u00b7 anniversary',
    'There is no day 30 in month 2', 'This date does not come in the next 100 years',
  ]) {
    const zh = t(text);
    assert.ok(HAN.test(zh), `${text} -> ${zh}`);
    assert.doesNotMatch(zh.replace(/schedule\.rule\.days|colour/g, ''), /\b(Every|at|until|ends|times|Monday|Script|session)\b/, `${text} -> ${zh}`);
  }
  assert.equal(t('Every Monday and Thursday at 09:00'), '\u6bcf\u5468\u4e00\u548c\u5468\u56db 09:00');
  assert.equal(t('Every year on lunar leap month 6, day 1 at 09:00'), '\u6bcf\u5e74\u519c\u5386\u95f06\u67081\u65e5 09:00', 'the leap template, not the plain one');
});
