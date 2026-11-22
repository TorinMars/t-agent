// The pure rules of Learn's Progress view and the grade intervals (scripts/h5-shell/learn-progress.mjs): the interval text, the tiles' deltas, the
// ticks and scales of the charts, the column shape, the pointer helpers. See "Progress" and "Grade intervals" in docs/design/learn-english-page.md.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../scripts/h5-shell/learn-progress.mjs');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('the interval of a grade: min under an hour, h under a day, days, then months and years', async () => {
  const { intervalParts, intervalEnglish } = await load();
  assert.equal(intervalEnglish(10 * MIN), '10 min');
  assert.equal(intervalEnglish(20 * 1000), '1 min', 'never 0 min');
  assert.equal(intervalEnglish(59 * MIN), '59 min');
  assert.equal(intervalEnglish(59.7 * MIN), '1 h', 'a rounded 60 min is an hour');
  assert.equal(intervalEnglish(5 * HOUR), '5 h');
  assert.equal(intervalEnglish(23.6 * HOUR), '1 day', 'a rounded 24 h is a day');
  assert.equal(intervalEnglish(DAY), '1 day');
  assert.equal(intervalEnglish(2 * DAY), '2 days');
  assert.equal(intervalEnglish(60 * DAY), '60 days');
  assert.equal(intervalEnglish(61 * DAY), '2 mo', 'past 60 days: 30-day months');
  assert.equal(intervalEnglish(200 * DAY), '7 mo');
  assert.equal(intervalEnglish(365 * DAY), '12 mo');
  assert.equal(intervalEnglish(400 * DAY), '1.1 yr');
  assert.equal(intervalEnglish(730 * DAY), '2 yr');
  assert.equal(intervalEnglish(4000 * DAY), '11 yr');
  assert.deepEqual(intervalParts(2 * DAY), ['{1} days', 2], 'a template and its number for the translation');
  assert.equal(intervalParts(-1), null);
  assert.equal(intervalParts('x'), null);
});

test('the grade intervals of a queue card, none without `next` (an older server)', async () => {
  const { gradeIntervals } = await load();
  assert.deepEqual(gradeIntervals({ again: 600000, hard: 2 * DAY, good: 5 * DAY }), { again: ['{1} min', 10], hard: ['{1} days', 2], good: ['{1} days', 5] });
  assert.equal(gradeIntervals(undefined), null);
  assert.equal(gradeIntervals(null), null);
  assert.equal(gradeIntervals({ again: 600000, good: DAY }), null, 'a grade without a time: no intervals at all');
});

test('the tiles: streak and best, answers vs last week, right in points, remembered of all', async () => {
  const { tiles, deltaParts, percent } = await load();
  const stats = { streak: 5, best_streak: 12, week: { answers: 143, right: 109, prev_answers: 105, prev_right: 77 }, memory: { new: 182, learning: 64, young: 66, mature: 118 }, total_cards: 430 };
  const tile = tiles(stats);
  assert.deepEqual(tile.streak, { value: 5, unit: '{1} days', best: 12 });
  assert.deepEqual(tile.answers, { value: 143, delta: 38 });
  assert.equal(tile.right.value, 76);
  assert.equal(tile.right.delta, 3, '76% now, 73% the week before');
  assert.deepEqual(tile.remembered, { value: 118, total: 430 });
  assert.deepEqual(deltaParts(38), ['+{1} vs last', 38]);
  assert.deepEqual(deltaParts(-7), ['−{1} vs last', 7]);
  assert.deepEqual(deltaParts(0), ['same as last week', 0]);
  assert.deepEqual(deltaParts(3, { points: true }), ['+{1} points vs last', 3]);
  assert.deepEqual(deltaParts(-2, { points: true }), ['−{1} points vs last', 2]);
  assert.equal(deltaParts(null), null);
  // One day, a best below the streak (an old copy), nothing last week, nothing at all.
  assert.deepEqual(tiles({ streak: 1, best_streak: 0 }).streak, { value: 1, unit: '{1} day', best: 1 });
  assert.equal(tiles({ week: { answers: 10, right: 5, prev_answers: 0, prev_right: 0 } }).right.delta, null);
  const none = tiles(null);
  assert.equal(none.right.value, null);
  assert.equal(none.answers.delta, 0);
  assert.equal(percent(1, 3), 33);
  assert.equal(percent(1, 0), null);
});

test('anything to chart: an answer ever, in the 30 days or in the 12 weeks', async () => {
  const { hasAnswers } = await load();
  assert.equal(hasAnswers(null), false);
  assert.equal(hasAnswers({ streak: 0, best_streak: 0, daily: [{ answers: 0 }], weekly: [{ answers: 0 }] }), false);
  assert.equal(hasAnswers({ best_streak: 2, daily: [], weekly: [] }), true);
  assert.equal(hasAnswers({ daily: [{ answers: 0 }, { answers: 3 }] }), true);
  assert.equal(hasAnswers({ weekly: [{ answers: 1 }] }), true);
});

test('clean y ticks from 0 and their text', async () => {
  const { niceTicks, tickText } = await load();
  assert.deepEqual(niceTicks(40), { top: 40, ticks: [0, 10, 20, 30, 40] });
  assert.deepEqual(niceTicks(21), { top: 30, ticks: [0, 10, 20, 30] });
  assert.deepEqual(niceTicks(3), { top: 3, ticks: [0, 1, 2, 3] });
  assert.deepEqual(niceTicks(7), { top: 8, ticks: [0, 2, 4, 6, 8] });
  assert.deepEqual(niceTicks(0), { top: 1, ticks: [0, 1] }, 'an empty chart still has an axis');
  assert.deepEqual(niceTicks(130), { top: 150, ticks: [0, 50, 100, 150] });
  for (const max of [1, 2, 5, 9, 13, 48, 99, 101, 999, 4321]) {
    const { top, ticks } = niceTicks(max);
    assert.ok(top >= max, `${max}: the top reaches the largest value`);
    assert.ok(ticks.every(Number.isInteger), `${max}: whole numbers`);
    assert.ok(ticks.length >= 2 && ticks.length <= 6, `${max}: ${ticks.length} ticks`);
  }
  assert.equal(tickText(1200), '1,200');
  assert.equal(tickText(20000, 40000), '20K');
  assert.equal(tickText(12500, 20000), '12.5K');
});

test('columns: at most 24px, never the whole slot, a rounded top and a square foot', async () => {
  const { columnLayout, columnPath } = await load();
  const wide = columnLayout(14, 700);
  assert.equal(wide.step, 50);
  assert.equal(wide.bar, 24, 'capped at 24px');
  assert.equal(wide.x(0), 13);
  assert.equal(wide.center(1), 75);
  const narrow = columnLayout(30, 300);
  assert.equal(narrow.step, 10);
  assert.equal(narrow.bar, 7, 'a third of the slot is air');
  assert.ok(columnLayout(30, 60).bar >= 2, 'never thinner than 2px');
  assert.equal(columnPath(10, 20, 24, 120), 'M10,120V24Q10,20 14,20H30Q34,20 34,24V120Z');
  assert.equal(columnPath(10, 118, 24, 120), 'M10,120V120Q10,118 12,118H32Q34,118 34,120V120Z', 'a short column gets a smaller radius');
  assert.equal(columnPath(10, 120, 24, 120), '', 'zero draws nothing');
});

test('the pointer: the slot under it, the nearest point with a value, the runs of a line', async () => {
  const { slotAt, nearestPoint, runs, labelSlots, weeklyShares } = await load();
  assert.equal(slotAt(0, 30, 300), 0);
  assert.equal(slotAt(155, 30, 300), 15);
  assert.equal(slotAt(-20, 30, 300), 0);
  assert.equal(slotAt(999, 30, 300), 29);
  assert.equal(nearestPoint(0, [50, 60, 70], 200), 0);
  assert.equal(nearestPoint(120, [50, 60, 70], 200), 1);
  assert.equal(nearestPoint(120, [50, null, 70], 200), 2, 'a week without answers is skipped');
  assert.equal(nearestPoint(10, [null, null], 200), -1);
  assert.deepEqual(runs([1, 2, null, 4, null, null, 7, 8]), [[0, 1], [3], [6, 7]]);
  assert.deepEqual(labelSlots(30), [0, 14, 29]);
  assert.deepEqual(labelSlots(14), [0, 6, 13]);
  assert.deepEqual(labelSlots(2), [0, 1]);
  assert.deepEqual(weeklyShares([{ answers: 4, right_first: 3 }, { answers: 0, right_first: 0 }]), [75, null]);
});

test('dates and colours', async () => {
  const { shortDay, mixColor } = await load();
  assert.equal(shortDay('2026-11-17'), 'Nov 17');
  assert.equal(shortDay('2026-03-01'), 'Mar 1', 'a calendar day, whatever the time zone');
  assert.match(shortDay('2026-11-17', 'zh'), /^11\u670817\u65e5$/);
  assert.equal(shortDay('nope'), '');
  assert.equal(mixColor('#121212', '#ffffff', 0.05), '#1e1e1e', 'the 1dp card of the dark theme');
  assert.equal(mixColor('#000', '#fff', 0.5), '#808080');
});
