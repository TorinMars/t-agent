// The calendar view of T-Attention on the page (scripts/h5-shell/calendar-model.mjs; "Calendar view" in docs/design/page-attention-calendar.md) and the
// yearly rule of the When form (scripts/h5-shell/attention-schedule.mjs) and of the list's row line (attention-model.mjs): the Sunday-first month
// grid, the events of every item on its days (once, repeats, yearly solar and lunar dates, to-dos by due date), the year numbers, the lunar words,
// the "No date" list and the forms. Dates are plain 'YYYY-MM-DD' texts, so nothing depends on the clock or the zone of the machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const dir = path.join(__dirname, '..', 'scripts', 'h5-shell');
const load = async () => ({
  ...(await import(pathToFileURL(path.join(dir, 'attention-model.mjs')).href)),
  ...(await import(pathToFileURL(path.join(dir, 'attention-schedule.mjs')).href)),
  ...(await import(pathToFileURL(path.join(dir, 'calendar-model.mjs')).href)),
});
const item = (id, title, extra = {}) => ({ id, key: `local:${id}`, engine: 'local', title, status: 'todo', priority: 'none', sort_order: id, schedule: null, due_date: null, ...extra });
const yearly = (rule, extra = {}) => ({ kind: 'repeat', rule: { freq: 'yearly', calendar: 'solar', time: '09:00', ...rule }, tz: 'Asia/Taipei', ...extra });
const MOM = yearly({ calendar: 'lunar', month: 10, day: 7, occasion: 'birthday', year: 1964 });
const WEDDING = yearly({ month: 11, day: 12, occasion: 'anniversary', year: 2018 });

test('the month grid starts on Sunday: November 2026 is 35 cells from Sunday Nov 1, October 2026 starts on a Thursday', async () => {
  const { monthGrid, weekdayOf, shiftMonth, WEEK } = await load();
  assert.deepEqual(WEEK.map(day => day.short), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  const november = monthGrid(2026, 11);
  assert.equal(november.cells.length, 35);
  assert.equal(november.first, '2026-11-01');
  assert.equal(november.cells[0].weekday, 0);
  assert.equal(november.last, '2026-12-05');
  assert.deepEqual(november.cells.filter(cell => cell.inMonth).map(cell => cell.day), Array.from({ length: 30 }, (x, i) => i + 1));
  assert.equal(weekdayOf('2026-10-01'), 4, 'Thursday');
  const october = monthGrid(2026, 10);
  assert.equal(october.first, '2026-09-27', 'the Sunday before');
  assert.equal(october.cells.findIndex(cell => cell.date === '2026-10-01'), 4);
  assert.equal(october.cells.length, 35);
  assert.equal(monthGrid(2026, 8).cells.length, 42, 'August 2026 starts on a Saturday and needs six weeks');
  assert.equal(monthGrid(2026, 2).cells.length, 35, 'February 2026 fits four weeks and is drawn with five rows');
  assert.deepEqual(shiftMonth({ year: 2026, month: 12 }, 1), { year: 2027, month: 1 });
  assert.deepEqual(shiftMonth({ year: 2026, month: 1 }, -1), { year: 2025, month: 12 });
});

test('events: every rule expanded on its days, to-dos on their due day, closed items left out, a day in the agenda order', async () => {
  const { calendarEvents, dayEvents, comingUp, monthGrid, kindOf } = await load();
  const items = [
    item(1, 'Call the dentist', { schedule: { kind: 'once', at: '2026-11-26T10:00', tz: 'Asia/Taipei' }, schedule_state: 'waiting' }),
    item(2, 'Water the plants', { schedule: { kind: 'repeat', rule: { freq: 'every', interval: 3, time: '18:00' }, starts: '2026-11-02', tz: 'Asia/Taipei' } }),
    item(3, 'Weekly review', { schedule: { kind: 'repeat', rule: { freq: 'weekly', days: [1], time: '09:00' }, tz: 'Asia/Taipei' } }),
    item(4, "Mom's birthday", { schedule: MOM }),
    item(5, 'Wedding anniversary', { schedule: WEDDING }),
    item(6, 'Send the invoice', { due_date: '2026-11-26' }),
    item(7, 'Renew passport', { due_date: '2026-11-20', status: 'done' }),
    item(8, 'Old once', { schedule: { kind: 'once', at: '2026-11-03T08:00', tz: 'Asia/Taipei' }, status: 'cancelled' }),
    item(9, 'No date at all'),
    item(10, 'Yearly reminder', { schedule: yearly({ month: 11, day: 30 }) }),
  ];
  assert.equal(kindOf(items[3]), 'birthday');
  assert.equal(kindOf(items[4]), 'anniversary');
  assert.equal(kindOf(items[9]), 'repeat', 'a yearly rule without an occasion is a repeat');
  assert.equal(kindOf(items[5]), 'todo');
  assert.equal(kindOf(items[6]), null, 'closed');
  assert.equal(kindOf(items[8]), null, 'no date');
  const grid = monthGrid(2026, 11);
  const events = calendarEvents(items, grid.first, grid.last);
  // Nov 26: the once at 10:00, the every-3-days at 18:00 (Nov 2, 5, ... 26), then the to do.
  assert.deepEqual(dayEvents(events, '2026-11-26').map(event => [event.item.title, event.kind, event.time]), [
    ['Call the dentist', 'once', '10:00'], ['Water the plants', 'repeat', '18:00'], ['Send the invoice', 'todo', null],
  ]);
  assert.deepEqual([...events.keys()].sort().filter(day => dayEvents(events, day).some(event => event.key === 'local:3')), ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30']);
  // The lunar birthday (lunar 10/7 is 2026-11-15), its number and its lunar date; the solar anniversary.
  const birthday = dayEvents(events, '2026-11-15').find(event => event.key === 'local:4');
  assert.deepEqual({ kind: birthday.kind, time: birthday.time, years: birthday.years, lunar: birthday.lunar }, { kind: 'birthday', time: null, years: 62, lunar: { month: 10, day: 7, leap: false } });
  const wedding = dayEvents(events, '2026-11-12').find(event => event.key === 'local:5');
  assert.equal(wedding.years, 8);
  assert.equal(wedding.lunar, null);
  // Nothing of the closed items, nothing of the item without a date.
  const all = [...events.values()].flat().map(event => event.key);
  for (const key of ['local:7', 'local:8', 'local:9']) assert.ok(!all.includes(key), key);
  // A day with timed events, an occasion and a to do: timed first (by time), then the occasion, then the to do.
  const mixed = calendarEvents([items[5], items[4], { ...items[0], schedule: { kind: 'once', at: '2026-11-12T07:30', tz: 'Asia/Taipei' } }], '2026-11-01', '2026-11-30');
  assert.deepEqual(dayEvents(mixed, '2026-11-12').map(event => event.kind), ['once', 'anniversary']);
  // Coming up: the events after a day, in date order.
  assert.deepEqual(comingUp(events, '2026-11-26', 3).map(event => [event.date, event.key]), [['2026-11-29', 'local:2'], ['2026-11-30', 'local:10'], ['2026-11-30', 'local:3']], 'the same time: the list order');
});

test('yearly dates: a lunar birthday moves in the solar calendar, a leap month only in its years, Feb 29 on Feb 28, ends honoured', async () => {
  const { calendarEvents, nextYearly, yearlySchedule } = await load();
  const days = (schedule, from, to) => [...calendarEvents([item(1, 'x', { schedule })], from, to).keys()];
  assert.deepEqual(days(MOM, '2026-01-01', '2026-12-31'), ['2026-11-15']);
  assert.deepEqual(days(MOM, '2027-01-01', '2027-12-31'), ['2027-11-04'], 'lunar 10/7 of 2027');
  assert.deepEqual(days(yearly({ month: 2, day: 29 }), '2027-01-01', '2027-12-31'), ['2027-02-28']);
  assert.deepEqual(days(yearly({ month: 2, day: 29 }), '2028-01-01', '2028-12-31'), ['2028-02-29']);
  assert.deepEqual(days(yearly({ month: 11, day: 15 }, { ends: { kind: 'on', date: '2026-12-31' } }), '2027-01-01', '2027-12-31'), []);
  const leap = yearlySchedule('birthday', { calendar: 'lunar', month: '6', day: '1', leap: true, year: '' }).schedule;
  assert.deepEqual(leap.rule, { freq: 'yearly', calendar: 'lunar', month: 6, day: 1, leap: true, occasion: 'birthday', time: '09:00' });
  assert.deepEqual(nextYearly(leap, '2026-11-26'), { date: '2036-07-23', years: null, lunar: { year: 2036, month: 6, day: 1, leap: true } }, 'leap month 6: 2025, then 2036');
  const next = nextYearly(MOM, '2026-11-26');
  assert.equal(next.date, '2027-11-04');
  assert.equal(next.years, 63);
});

test('words: month and day titles, year numbers, ordinals and the lunar parts', async () => {
  const { monthTitle, dayTitle, occasionText, ordinal, yearsOn, lunarParts, lunarOfDate, occasionTitle } = await load();
  assert.equal(monthTitle(2026, 11), 'November 2026');
  assert.equal(dayTitle('2026-11-26'), 'Thursday, Nov 26');
  assert.equal(dayTitle('2026-11-28', { short: true }), 'Sat, Nov 28');
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th']);
  assert.equal(occasionText('birthday', 62), 'turns 62');
  assert.equal(occasionText('anniversary', 8), '8th anniversary');
  assert.equal(occasionText('anniversary', 0), null, 'the year it began');
  assert.equal(occasionText('birthday', null), null);
  assert.equal(yearsOn({ year: 1964 }, '2026-11-15'), 62);
  assert.equal(yearsOn({}, '2026-11-15'), null);
  assert.equal(yearsOn({ year: 2030 }, '2026-11-15'), null, 'before it began');
  assert.deepEqual(lunarOfDate('2026-11-26'), { year: 2026, month: 10, day: 18, leap: false });
  assert.deepEqual(lunarParts({ month: 10, day: 7, leap: false }), { month: 'lunar month 10', day: 'lunar day 7', numbers: '10/7', leap: false, first: false });
  assert.deepEqual(lunarParts({ month: 6, day: 1, leap: true }), { month: 'lunar leap month 6', day: 'lunar day 1', numbers: 'leap 6/1', leap: true, first: true });
  assert.equal(occasionTitle('birthday', ' Mom '), "Mom's birthday");
  assert.equal(occasionTitle('birthday', "Dad's birthday"), "Dad's birthday", 'a name that already says it stays');
  assert.equal(occasionTitle('anniversary', 'Wedding'), 'Wedding anniversary');
});

test('the "No date" list: open items with neither a schedule nor a due date, in the list order', async () => {
  const { noDateItems } = await load();
  const items = [
    item(1, 'A'), item(2, 'B', { due_date: '2026-11-20' }), item(3, 'C', { schedule: MOM }), item(4, 'D', { status: 'done' }),
    item(5, 'E', { status: 'waiting_user' }), item(6, 'F', { sort_order: 99 }),
  ];
  assert.deepEqual(noDateItems(items).map(entry => entry.title), ['F', 'E', 'A']);
});

test('the form: "Every year" reads and saves a yearly rule; schedulePatch compares it by meaning', async () => {
  const { scheduleForm, scheduleFromForm, schedulePatch, yearlyRule, FREQUENCIES, yearlyOn } = await load();
  assert.ok(FREQUENCIES.some(entry => entry.value === 'yearly' && entry.label === 'Every year'));
  const saved = item(1, "Mom's birthday", { schedule: MOM, then_action: null });
  const form = scheduleForm(saved, new Date(2026, 10, 20, 10));
  assert.deepEqual({ when: form.when, freq: form.freq, calendar: form.calendar, month: form.month, yearDay: form.yearDay, leap: form.leap, occasion: form.occasion, year: form.year, time: form.time },
    { when: 'repeat', freq: 'yearly', calendar: 'lunar', month: '10', yearDay: '7', leap: false, occasion: 'birthday', year: '1964', time: '09:00' });
  assert.deepEqual(scheduleFromForm(form).schedule, { kind: 'repeat', rule: { freq: 'yearly', calendar: 'lunar', month: 10, day: 7, occasion: 'birthday', year: 1964, time: '09:00' } });
  assert.deepEqual(schedulePatch(saved, form), {}, 'the same rule (the zone left out) is no change');
  assert.deepEqual(schedulePatch(saved, { ...form, leap: true }).schedule.rule.leap, true);
  assert.deepEqual(schedulePatch(saved, { ...form, year: '' }).schedule.rule, { freq: 'yearly', calendar: 'lunar', month: 10, day: 7, occasion: 'birthday', time: '09:00' });
  const solar = schedulePatch(saved, { ...form, calendar: 'solar', month: '2', yearDay: '29', occasion: 'anniversary', leap: true });
  assert.deepEqual(solar.schedule.rule, { freq: 'yearly', calendar: 'solar', month: 2, day: 29, occasion: 'anniversary', year: 1964, time: '09:00' }, 'no leap for a solar date');
  // A new yearly rule from a task without a schedule: today's month and day.
  const fresh = scheduleForm(item(2, 'x'), new Date(2026, 10, 20, 10));
  assert.deepEqual([fresh.month, fresh.yearDay, fresh.calendar, fresh.occasion], ['11', '20', 'solar', '']);
  assert.deepEqual(scheduleFromForm({ ...fresh, when: 'repeat', freq: 'yearly', starts: '' }).schedule, { kind: 'repeat', rule: { freq: 'yearly', calendar: 'solar', month: 11, day: 20, time: '09:00' } });
  // The form's own errors.
  const errors = [
    [{ calendar: 'solar', month: '2', day: '30', time: '09:00' }, 'This month has no such day'],
    [{ calendar: 'solar', month: '13', day: '1', time: '09:00' }, 'Choose the month'],
    [{ calendar: 'lunar', month: '1', day: '31', time: '09:00' }, 'The lunar day is 1 to 30'],
    [{ calendar: 'solar', month: '4', day: '', time: '09:00' }, 'The day of the month is 1 to 31'],
    [{ calendar: 'solar', month: '4', day: '1', year: '1800', time: '09:00' }, 'The year is 1900 to 2100'],
  ];
  for (const [fields, error] of errors) assert.equal(yearlyRule(fields).error, error, JSON.stringify(fields));
  // The capability: this machine always, another engine when its /info lists it, unknown before.
  const sources = [{ key: 'local' }, { key: 'remote:7', capabilities: ['attention:remote', 'attention:schedule', 'attention:yearly'] }, { key: 'remote:8', capabilities: ['attention:remote'] }, { key: 'remote:9', capabilities: null }];
  assert.deepEqual(['local', 'remote:7', 'remote:8', 'remote:9', 'remote:10'].map(key => yearlyOn(sources, key)), [true, true, false, null, null]);
});

test('the list row of a yearly item: Every year · its next day · its lunar date · turns 62', async () => {
  const { rowLine: scheduleLine, lineText, yearlyWords } = await load();
  const now = new Date(2026, 10, 20, 10);
  const birthday = item(1, "Mom's birthday", { schedule: MOM, schedule_state: 'waiting', next_at: new Date(2027, 10, 4, 9).toISOString() });
  assert.equal(lineText(scheduleLine(birthday, { now })), 'Every year · 11-04 · lunar 10/7 · turns 63', 'the number of the NEXT birthday');
  assert.equal(scheduleLine(birthday, { now }).icon, 'sync');
  const wedding = item(2, 'Wedding anniversary', { schedule: WEDDING, schedule_state: 'waiting', next_at: new Date(2027, 10, 12, 9).toISOString() });
  assert.equal(lineText(scheduleLine(wedding, { now })), 'Every year · 11-12 · 9th anniversary');
  const due = { ...wedding, schedule_state: 'due', last_fired_at: new Date(2026, 10, 12, 9).toISOString() };
  assert.equal(lineText(scheduleLine(due, { now })), 'Every year · 11-12 · 8th anniversary · due now', 'while due, the day it came');
  const plain = item(3, 'Renew the domain', { schedule: yearly({ month: 3, day: 1 }), schedule_state: 'waiting', next_at: new Date(2027, 2, 1, 9).toISOString() });
  assert.equal(lineText(scheduleLine(plain, { now })), 'Every year · 03-01');
  assert.deepEqual(yearlyWords(MOM), ['Every year', { raw: '09:00' }]);
  const weekly = item(4, 'Weekly', { schedule: { kind: 'repeat', rule: { freq: 'weekly', days: [1], time: '09:00' }, tz: 'Asia/Taipei' }, schedule_state: 'waiting', next_at: new Date(2026, 10, 23, 9).toISOString() });
  assert.equal(lineText(scheduleLine(weekly, { now })), 'Every Monday 09:00 · next Mon 11-23 09:00', 'other rules as before');
});
