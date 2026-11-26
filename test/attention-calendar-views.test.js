// The year, month, week and day views of the T-Attention calendar (scripts/h5-shell/calendar-views.mjs), its search (calendar-search.mjs) and the
// Duration / Ends at / All day fields of the When form (attention-schedule.mjs; "Views", "Search" and "Duration and all day" in
// docs/design/page-attention-calendar.md). Dates are plain 'YYYY-MM-DD' texts and "today" / "now" are passed in, so nothing depends on the clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const dir = path.join(__dirname, '..', 'scripts', 'h5-shell');
const load = async () => ({
  ...(await import(pathToFileURL(path.join(dir, 'attention-model.mjs')).href)),
  ...(await import(pathToFileURL(path.join(dir, 'attention-schedule.mjs')).href)),
  ...(await import(pathToFileURL(path.join(dir, 'calendar-model.mjs')).href)),
  ...(await import(pathToFileURL(path.join(dir, 'calendar-views.mjs')).href)),
  ...(await import(pathToFileURL(path.join(dir, 'calendar-search.mjs')).href)),
});
const TZ = 'Asia/Taipei';
const item = (id, title, extra = {}) => ({ id, key: `local:${id}`, engine: 'local', title, status: 'todo', priority: 'none', sort_order: id, schedule: null, due_date: null, ...extra });
const once = (at, extra = {}) => ({ kind: 'once', at, tz: TZ, ...extra });
const repeat = (rule, extra = {}) => ({ kind: 'repeat', rule, tz: TZ, ...extra });
const yearly = (rule, extra = {}) => repeat({ freq: 'yearly', calendar: 'solar', time: '09:00', ...rule }, extra);
const MOM = yearly({ calendar: 'lunar', month: 10, day: 7, occasion: 'birthday', year: 1964 });
const WEDDING = yearly({ month: 11, day: 12, occasion: 'anniversary', year: 2018 });
const ANN = yearly({ month: 3, day: 9, occasion: 'birthday', year: 1993 });
const LEO = yearly({ month: 6, day: 8, occasion: 'birthday', year: 2019 });

test('the view key, the week (Sunday first), the twelve months of a year and the move by each unit', async () => {
  const { CAL_VIEWS, CAL_VIEW_KEY, calViewOf, weekOf, yearMonths, shiftView } = await load();
  assert.deepEqual(CAL_VIEWS, ['year', 'month', 'week', 'day']);
  assert.equal(CAL_VIEW_KEY, 'h5-attention-cal-view');
  assert.equal(calViewOf('week'), 'week');
  assert.equal(calViewOf(null), 'month', 'month when nothing was chosen');
  assert.equal(calViewOf('agenda'), 'month');
  assert.deepEqual(weekOf('2026-11-27'), { first: '2026-11-22', last: '2026-11-28', days: ['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28'] });
  assert.equal(weekOf('2026-11-22').first, '2026-11-22', 'a Sunday starts its own week');
  assert.deepEqual(weekOf('2026-12-31').days.slice(-3), ['2026-12-31', '2027-01-01', '2027-01-02'], 'a week across the new year');
  const months = yearMonths(2026);
  assert.equal(months.length, 12);
  assert.equal(months[1].first, '2026-02-01', 'February 2026 starts on a Sunday');
  assert.equal(months[1].cells.length, 35);
  assert.equal(months[7].cells.length, 42, 'August 2026 needs six weeks');
  assert.equal(shiftView('day', '2026-11-30', 1), '2026-12-01');
  assert.equal(shiftView('week', '2026-11-27', -1), '2026-11-20');
  assert.equal(shiftView('month', '2026-01-31', 1), '2026-02-28', 'the last day of a shorter month');
  assert.equal(shiftView('month', '2026-12-15', 1), '2027-01-15');
  assert.equal(shiftView('year', '2028-02-29', 1), '2029-02-28');
  assert.equal(shiftView('year', '2026-11-27', -1), '2025-11-27');
});

test('the range and the title of each view', async () => {
  const { viewRange, viewTitle } = await load();
  assert.deepEqual(viewRange('year', '2026-11-27'), { from: '2026-01-01', to: '2026-12-31' });
  assert.deepEqual(viewRange('month', '2026-11-27'), { from: '2026-11-01', to: '2026-12-05' });
  assert.deepEqual(viewRange('week', '2026-11-27'), { from: '2026-11-22', to: '2026-11-28' });
  assert.deepEqual(viewRange('day', '2026-11-27'), { from: '2026-11-27', to: '2026-11-27' });
  assert.equal(viewTitle('year', '2026-11-27'), '2026');
  assert.equal(viewTitle('month', '2026-11-27'), 'November 2026');
  assert.equal(viewTitle('week', '2026-11-27'), 'Nov 22 – 28, 2026');
  assert.equal(viewTitle('week', '2026-12-01'), 'Nov 29 – Dec 5, 2026');
  assert.equal(viewTitle('week', '2026-12-29'), 'Dec 27, 2026 – Jan 2, 2027');
  assert.equal(viewTitle('day', '2026-11-27'), 'Nov 27, 2026');
});

test('events carry their duration and all day: a timed block is as long as its duration, all-day items go to the all-day row', async () => {
  const { calendarEvents, dayEvents, allDayEvents, endOf, timeRange, durationText } = await load();
  const items = [
    item(1, 'Code review', { schedule: once('2026-11-27T10:30', { duration: 90 }) }),
    item(2, 'Piano lesson', { schedule: repeat({ freq: 'weekly', days: [5], time: '15:00' }) }),
    item(3, 'Holiday', { schedule: once('2026-11-27T09:00', { all_day: true }) }),
    item(4, 'Send the invoice', { due_date: '2026-11-27' }),
    item(5, "Mom's birthday", { schedule: MOM }),
  ];
  const day = dayEvents(calendarEvents(items, '2026-11-01', '2026-11-30'), '2026-11-27');
  const of = key => day.find(event => event.key === key);
  assert.equal(of('local:1').duration, 90);
  assert.equal(of('local:1').allDay, false);
  assert.equal(endOf(of('local:1')), 12 * 60, 'ends at 12:00');
  assert.equal(timeRange(of('local:1')), '10:30–12:00');
  assert.equal(of('local:2').duration, null);
  assert.equal(endOf(of('local:2')), 16 * 60, 'no duration: one hour');
  assert.equal(timeRange(of('local:2')), null, 'only the start is written without a duration');
  assert.equal(of('local:3').time, null);
  assert.equal(of('local:3').allDay, true);
  assert.deepEqual(allDayEvents(day).map(event => event.key), ['local:3', 'local:4']);
  const birthday = dayEvents(calendarEvents(items, '2026-11-01', '2026-11-30'), '2026-11-15');
  assert.deepEqual(allDayEvents(birthday).map(event => [event.key, event.kind]), [['local:5', 'birthday']]);
  assert.deepEqual([15, 45, 60, 90, 120, 80].map(durationText), ['15 min', '45 min', '1 hour', '1.5 hours', '2 hours', '1 h 20 min']);
});

test('the time grid: blocks from start and duration, at least 30 minutes drawn, overlapping ones side by side, never past midnight', async () => {
  const { timedLayout } = await load();
  const ev = (key, time, duration = null, extra = {}) => ({ key, time, duration, allDay: false, kind: 'once', item: { title: key }, ...extra });
  const blocks = timedLayout([
    ev('a', '10:00', 90), ev('b', '10:30', 30), ev('c', '12:00', 15), ev('d', '13:00'), ev('e', '23:30', 120),
    ev('f', '08:00', null, { allDay: true }), ev('g', null),
  ]);
  const by = key => blocks.find(block => block.event.key === key);
  assert.deepEqual(blocks.map(block => block.event.key), ['a', 'b', 'c', 'd', 'e'], 'all-day events are not blocks');
  assert.deepEqual([by('a').start, by('a').end, by('a').col, by('a').cols], [600, 690, 0, 2]);
  assert.deepEqual([by('b').start, by('b').end, by('b').col, by('b').cols], [630, 660, 1, 2], 'the overlapping pair shares the width');
  assert.deepEqual([by('c').start, by('c').end, by('c').cols], [720, 750, 1], '15 minutes are drawn as 30');
  assert.deepEqual([by('d').start, by('d').end, by('d').cols], [780, 840, 1], 'no duration: one hour');
  assert.equal(by('e').end, 1440, 'cut at midnight');
  // Three in a chain: the third reuses the first column once it is free.
  const chain = timedLayout([ev('x', '09:00', 60), ev('y', '09:30', 60), ev('z', '10:00', 60)]);
  assert.deepEqual(chain.map(block => [block.event.key, block.col, block.cols]), [['x', 0, 2], ['y', 1, 2], ['z', 0, 2]]);
});

test('the now line and the first scroll: an hour before now today (at most 16:00), 8:00 on other days', async () => {
  const { nowMinutes, scrollHour, nowColumn, weekOf } = await load();
  assert.equal(nowMinutes(new Date(2026, 10, 27, 12, 40)), 760);
  assert.equal(scrollHour('2026-11-27', '2026-11-27', 760), 11);
  assert.equal(scrollHour('2026-11-27', '2026-11-27', 30), 0);
  assert.equal(scrollHour('2026-11-27', '2026-11-27', 23 * 60), 16);
  assert.equal(scrollHour('2026-11-28', '2026-11-27', 760), 8);
  assert.equal(nowColumn(weekOf('2026-11-27').days, '2026-11-27'), 5, 'Friday');
  assert.equal(nowColumn(weekOf('2026-12-04').days, '2026-11-27'), -1);
});

test('the year marks: a day with a birthday or an anniversary is special, any other day with something is busy', async () => {
  const { calendarEvents, yearMarks } = await load();
  const items = [item(1, 'Mom', { schedule: MOM }), item(2, 'Wedding', { schedule: WEDDING }), item(3, 'Review', { schedule: repeat({ freq: 'monthly', day: 12, time: '09:00' }) }), item(4, 'Rent', { due_date: '2026-11-28' })];
  const marks = yearMarks(calendarEvents(items, '2026-01-01', '2026-12-31'));
  assert.equal(marks.get('2026-11-15'), 'special', "Mom's lunar birthday");
  assert.equal(marks.get('2026-11-12'), 'special', 'the anniversary wins over the monthly review the same day');
  assert.equal(marks.get('2026-10-12'), 'busy');
  assert.equal(marks.get('2026-11-28'), 'busy');
  assert.equal(marks.get('2026-11-13'), undefined);
  assert.equal([...marks.values()].filter(mark => mark === 'busy').length, 11 + 1, 'eleven other monthly reviews and the rent');
});

test('search: every word in the title, notes, result or status, any case and width; lunar dates by their text; grouped Next up, Earlier this year, No date', async () => {
  const { searchItems, searchTerms, highlightParts, lunarSearchText } = await load();
  const items = [
    item(1, "Mom's birthday", { schedule: MOM }),
    item(2, "Ann's birthday", { schedule: ANN }),
    item(3, "Leo's birthday", { schedule: LEO }),
    item(4, 'Wedding anniversary', { schedule: WEDDING }),
    item(5, 'Call the dentist', { schedule: once('2026-11-26T10:00'), notes: 'Ask about the BIRTHDAY discount' }),
    item(6, 'Old errand', { due_date: '2026-03-02' }),
    item(7, 'Renew passport', { notes: 'birthday photo' }),
    item(8, 'Party', { schedule: once('2026-12-01T19:00'), status: 'done' }),
    item(9, '\u5988\u5988\u751f\u65e5', { schedule: MOM }),
    item(10, 'Deploy check', { schedule: repeat({ freq: 'weekly', days: [2], time: '08:00' }), result: 'birthday banner shipped' }),
  ];
  const today = '2026-11-27';
  assert.deepEqual(searchTerms('  Mom  \u3000BIRTHDAY '), ['mom', 'birthday'], 'a full-width space splits too');
  const all = searchItems(items, 'birthday', { today });
  assert.deepEqual(all.groups.map(group => [group.key, group.title, group.results.map(result => result.key)]), [
    ['next', 'Next up', ['local:10', 'local:2', 'local:3', 'local:1']],
    ['earlier', 'Earlier this year', ['local:5']],
    ['none', 'No date', ['local:7']],
  ]);
  assert.equal(all.count, 6);
  const mom = all.groups[0].results.find(result => result.key === 'local:1');
  assert.deepEqual([mom.date, mom.years, mom.kind], ['2027-11-04', 63, 'birthday'], 'the next one: lunar 10/7 is Nov 4 in 2027');
  const ann = all.groups[0].results.find(result => result.key === 'local:2');
  assert.deepEqual([ann.date, ann.years], ['2027-03-09', 34]);
  // Filters and finished items.
  assert.deepEqual(searchItems(items, 'birthday', { today, filter: 'birthday' }).groups.flatMap(group => group.results.map(result => result.key)), ['local:2', 'local:3', 'local:1']);
  assert.deepEqual(searchItems(items, 'e', { today, filter: 'anniversary' }).groups.flatMap(group => group.results.map(result => result.key)), ['local:4']);
  assert.deepEqual(searchItems(items, 'e', { today, filter: 'todo' }).groups.flatMap(group => group.results.map(result => result.key)), ['local:6', 'local:7']);
  assert.deepEqual(searchItems(items, 'party', { today }).groups, [], 'a finished item is left out');
  assert.deepEqual(searchItems(items, 'party', { today, finished: true }).groups.map(group => [group.key, group.results.map(result => result.date)]), [['finished', ['2026-12-01']]]);
  assert.deepEqual(searchItems(items, 'errand', { today }).groups.map(group => group.key), ['earlier']);
  // Lunar text, Chinese, several words, full width (the same day: the list's order).
  assert.deepEqual(lunarSearchText(MOM), ['lunar 10/7', '10/7']);
  assert.deepEqual(searchItems(items, 'lunar 10/7', { today }).groups.flatMap(group => group.results.map(result => result.key)), ['local:9', 'local:1']);
  assert.deepEqual(searchItems(items, '10/7', { today, filter: 'birthday' }).groups.flatMap(group => group.results.map(result => result.key)), ['local:9', 'local:1']);
  assert.deepEqual(searchItems(items, '\u751f\u65e5', { today }).groups.flatMap(group => group.results.map(result => result.key)), ['local:9']);
  const words = it => (it.schedule && it.schedule.rule && it.schedule.rule.calendar === 'lunar' ? ['\u519c\u5386\u5341\u6708\u521d\u4e03'] : []);
  assert.deepEqual(searchItems(items, '\u5341\u6708\u521d\u4e03', { today, extra: words }).groups.flatMap(group => group.results.map(result => result.key)), ['local:9', 'local:1'], 'the page adds the Chinese words');
  assert.deepEqual(searchItems(items, 'mom birthday', { today }).groups.flatMap(group => group.results.map(result => result.key)), ['local:1']);
  assert.deepEqual(searchItems(items, '\uff2d\uff2f\uff2d', { today }).groups.flatMap(group => group.results.map(result => result.key)), ['local:1'], 'full-width letters');
  assert.deepEqual(searchItems(items, '   ', { today }), { count: 0, groups: [] });
  // The matched text, highlighted in the original letters.
  assert.deepEqual(highlightParts("Mom's Birthday", 'birth mom'), [{ text: 'Mom', hit: true }, { text: "'s ", hit: false }, { text: 'Birth', hit: true }, { text: 'day', hit: false }]);
  assert.deepEqual(highlightParts('\u5988\u5988\u751f\u65e5', '\u751f\u65e5'), [{ text: '\u5988\u5988', hit: false }, { text: '\u751f\u65e5', hit: true }]);
  assert.deepEqual(highlightParts('Plain', ''), [{ text: 'Plain', hit: false }]);
});

test('Duration, Ends at and All day: the form echoes them, each follows the other, an end after midnight is refused, the patch compares them', async () => {
  const { scheduleForm, scheduleFromForm, schedulePatch, durationChoice, formEnd, durationFromEnd, durationApplies, durationOn, MIDNIGHT_ERROR, rowLine, lineText } = await load();
  const NOW = new Date(2026, 10, 20, 9, 0);
  const timed = item(1, 'Review', { schedule: once('2026-11-27T10:30', { duration: 90 }) });
  const form = scheduleForm(timed, NOW);
  assert.deepEqual([form.duration, form.durationCustom, form.allDay], ['90', false, false]);
  assert.equal(durationChoice(form), '90');
  assert.equal(durationChoice({ duration: '50' }), 'custom');
  assert.equal(durationChoice({ duration: '' }), '');
  assert.equal(durationChoice({ duration: '60', durationCustom: true }), 'custom');
  assert.equal(formEnd(form), '12:00');
  assert.deepEqual(durationFromEnd(form, '11:15'), { duration: '45' });
  assert.deepEqual(durationFromEnd(form, '10:00'), { error: MIDNIGHT_ERROR }, 'an end before the start would be after midnight');
  assert.deepEqual(durationFromEnd(form, '10:30'), { error: MIDNIGHT_ERROR });
  assert.equal(formEnd({ ...form, onceTime: '23:00', duration: '90' }), null, 'past midnight');
  assert.equal(formEnd({ ...form, onceTime: '23:00', duration: '60' }), '00:00', 'midnight itself is the latest end');
  assert.deepEqual(durationFromEnd({ ...form, onceTime: '23:00' }, '00:00'), { duration: '60' });
  assert.equal(formEnd({ ...form, duration: '' }), '');
  assert.deepEqual(scheduleFromForm(form).schedule, { kind: 'once', at: '2026-11-27T10:30', duration: 90 });
  assert.deepEqual(scheduleFromForm({ ...form, onceTime: '23:00' }), { error: MIDNIGHT_ERROR });
  assert.deepEqual(scheduleFromForm({ ...form, endError: MIDNIGHT_ERROR }), { error: MIDNIGHT_ERROR }, 'a refused end is not saved as the old length');
  assert.deepEqual(scheduleFromForm({ ...form, duration: '2000' }), { error: 'The duration is 1 to 1439 minutes' });
  assert.deepEqual(scheduleFromForm({ ...form, duration: '' }).schedule, { kind: 'once', at: '2026-11-27T10:30' }, 'Not set keeps none');
  assert.deepEqual(scheduleFromForm({ ...form, allDay: true }).schedule, { kind: 'once', at: '2026-11-27T10:30', all_day: true }, 'all day: no duration');
  const weekly = { ...scheduleForm(null, NOW), when: 'repeat', freq: 'weekly', days: [5], time: '15:00', duration: '60' };
  assert.deepEqual(scheduleFromForm(weekly).schedule, { kind: 'repeat', rule: { freq: 'weekly', time: '15:00', days: [5] }, starts: '2026-11-20', duration: 60 });
  assert.equal(durationApplies({ when: 'repeat', freq: 'yearly', occasion: 'birthday' }), false, 'a birthday is all day by nature');
  assert.equal(durationApplies({ when: 'repeat', freq: 'yearly', occasion: '' }), true);
  assert.equal(durationApplies({ when: 'none' }), false);
  assert.equal(scheduleFromForm({ ...weekly, freq: 'yearly', occasion: 'birthday', month: '3', yearDay: '9' }).schedule.duration, undefined);
  // The patch: unchanged is nothing; a new length or all day is the schedule.
  assert.deepEqual(schedulePatch(timed, form), {});
  assert.deepEqual(schedulePatch(timed, { ...form, duration: '60' }).schedule, { kind: 'once', at: '2026-11-27T10:30', duration: 60 });
  assert.deepEqual(schedulePatch(timed, { ...form, allDay: true }).schedule, { kind: 'once', at: '2026-11-27T10:30', all_day: true });
  const plain = item(2, 'Plain', { schedule: once('2026-11-27T10:30') });
  assert.deepEqual(schedulePatch(plain, scheduleForm(plain, NOW)), {}, 'a schedule without a duration is echoed without one');
  // The capability.
  assert.equal(durationOn([], 'local'), true);
  assert.equal(durationOn([{ key: 'remote:7', capabilities: ['attention:duration'] }], 'remote:7'), true);
  assert.equal(durationOn([{ key: 'remote:7', capabilities: ['attention:yearly'] }], 'remote:7'), false);
  assert.equal(durationOn([{ key: 'remote:7' }], 'remote:7'), null);
  // The row line: the range, or all day.
  const now = new Date(2026, 10, 26, 8, 0);
  const at = (schedule, extra = {}) => ({ ...item(3, 'X', { schedule }), schedule_state: 'waiting', next_at: new Date(2026, 10, 27, 10, 30).toISOString(), ...extra });
  assert.equal(lineText(rowLine(at(once('2026-11-27T10:30', { duration: 60 })), { now })), 'Once · tomorrow 10:30–11:30');
  assert.equal(lineText(rowLine(at(once('2026-11-27T10:30', { all_day: true })), { now })), 'Once · tomorrow all day');
  assert.equal(lineText(rowLine(at(repeat({ freq: 'weekdays', time: '10:30' }, { duration: 90 })), { now })), 'Weekdays 10:30–12:00 · next tomorrow 10:30');
  assert.equal(lineText(rowLine(at(repeat({ freq: 'daily', time: '10:30' }, { all_day: true })), { now })), 'Every day all day · next tomorrow 10:30');
  assert.equal(lineText(rowLine(at(once('2026-11-27T10:30')), { now })), 'Once · tomorrow 10:30', 'no duration: as before');
});
