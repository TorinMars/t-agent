// Spaced review of English learning cards (services/learn-review.js; "Review rules" in docs/design/learn-english.md): the intervals of good, hard and
// again, the ease floor, what counts as a mistake, and the streak and "today" in the server's time zone.
const test = require('node:test');
const assert = require('node:assert/strict');
const review = require('../services/learn-review');

const { DAY, applyAnswer } = review;
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const fresh = () => ({ interval_days: 0, ease: 2.5, reps: 0, lapses: 0 });
const answer = (card, grade, correct = grade !== 'again', at = NOW) => ({ ...card, ...applyAnswer(card, grade, correct, at) });

test('the first good answer of a new card schedules it for tomorrow and keeps the ease', () => {
  const next = applyAnswer(fresh(), 'good', true, NOW);
  assert.equal(next.interval_days, 1);
  assert.equal(next.due_at, NOW + DAY);
  assert.equal(next.ease, 2.5);
  assert.equal(next.reps, 1);
  assert.equal(next.lapses, 0);
  assert.equal(next.last_result, 'good');
  assert.equal(next.last_at, NOW);
  assert.equal(next.last_correct, 1);
});

test('good answers climb 1, 3, 7, 15, 30 days with the starting ease, then grow by the ease up to a year', () => {
  let card = fresh();
  const intervals = [];
  for (let i = 0; i < 8; i += 1) { card = answer(card, 'good'); intervals.push(card.interval_days); }
  assert.deepEqual(intervals.slice(0, 5), [1, 3, 7, 15, 30]);
  assert.deepEqual(intervals.slice(5), [75, 188, 365], 'past the steps: the product in whole days, at most 365');
  assert.equal(card.ease, 2.5, 'good never changes the ease');
});

test('hard: 1.2 times the interval (at least a day), the ease down by 0.15', () => {
  const card = { ...fresh(), interval_days: 10, ease: 2.5 };
  const next = applyAnswer(card, 'hard', true, NOW);
  assert.equal(next.interval_days, 12);
  assert.equal(next.due_at, NOW + 12 * DAY);
  assert.equal(next.ease, 2.35);
  assert.equal(applyAnswer(fresh(), 'hard', true, NOW).interval_days, 1, 'a new card answered hard comes back tomorrow');
  assert.equal(applyAnswer({ ...fresh(), interval_days: 1 }, 'hard', true, NOW).interval_days, 1.2);
});

test('again: back in 10 minutes with interval 0, the ease down by 0.2 and one more lapse', () => {
  const card = { ...fresh(), interval_days: 15, ease: 2.5, reps: 4, lapses: 1 };
  const next = applyAnswer(card, 'again', false, NOW);
  assert.equal(next.interval_days, 0);
  assert.equal(next.due_at, NOW + 10 * 60 * 1000);
  assert.equal(next.ease, 2.3);
  assert.equal(next.lapses, 2);
  assert.equal(next.reps, 5);
  assert.equal(next.last_correct, 0);
  // After "again" the card starts the steps from the beginning.
  assert.equal(applyAnswer({ ...card, ...next }, 'good', true, NOW).interval_days, 1);
});

test('the ease never goes below 1.3, and a low ease climbs more slowly', () => {
  let card = fresh();
  for (let i = 0; i < 10; i += 1) card = answer(card, 'again');
  assert.equal(card.ease, 1.3);
  for (let i = 0; i < 10; i += 1) card = answer(card, 'hard');
  assert.equal(card.ease, 1.3);
  const intervals = [];
  for (let i = 0; i < 4; i += 1) { card = answer(card, 'good'); intervals.push(card.interval_days); }
  // From hard's interval (1.2^9 = 5.2 days): 5.2 x 1.3 = 6.7 -> step 7, 7 x 1.3 = 9.1 (step 7 is not longer), 11.8 -> step 15, 19.5 -> step 15 is not longer -> 19.5.
  assert.deepEqual(intervals, [7, 9.1, 15, 19.5]);
  for (let i = 1; i < intervals.length; i += 1) assert.ok(intervals[i] > intervals[i - 1], 'good always lengthens the interval');
});

test('an unknown grade is refused', () => {
  assert.throws(() => applyAnswer(fresh(), 'easy', true, NOW), /Unknown grade/);
});

test('a mistake: the last answer was wrong, or a failed card with a wrong answer in the last 30 days', () => {
  assert.equal(review.isMistake({ last_correct: 0, lapses: 0 }, null, NOW), true);
  assert.equal(review.isMistake({ last_correct: 1, lapses: 0 }, null, NOW), false);
  assert.equal(review.isMistake({ last_correct: 1, lapses: 1 }, NOW - 5 * DAY, NOW), true, 'failed before, wrong 5 days ago');
  assert.equal(review.isMistake({ last_correct: 1, lapses: 1 }, NOW - 31 * DAY, NOW), false, 'the wrong answer is older than 30 days');
  assert.equal(review.isMistake({ last_correct: null, lapses: 0 }, null, NOW), false, 'never answered');
});

test('the streak counts days with an answer, ending today or yesterday, and "today" follows the time zone', () => {
  const at = (day, hour) => Date.UTC(2026, 10, day, hour);
  // Answers at 10:00 UTC on 16, 17, 18 and 19 November; none on the 15th.
  const times = [at(14, 10), at(16, 10), at(17, 10), at(17, 11), at(18, 10), at(19, 10)];
  assert.equal(review.streak(times, at(19, 12), 'UTC'), 4);
  assert.equal(review.streak(times.slice(0, -1), at(19, 12), 'UTC'), 3, 'nothing yet today: the streak up to yesterday still counts');
  assert.equal(review.streak(times.slice(0, -2), at(19, 12), 'UTC'), 0, 'yesterday missed: the streak is over');
  assert.equal(review.streak([], at(19, 12), 'UTC'), 0);

  // The same moments on a server in Shanghai (UTC+8) and in Los Angeles (UTC-8): 20:00 UTC on the 18th is already the 19th in Shanghai.
  const late = [at(17, 20), at(18, 20)];
  assert.equal(review.dayKey(at(18, 20), 'Asia/Shanghai'), '2026-11-19');
  assert.equal(review.dayKey(at(18, 20), 'America/Los_Angeles'), '2026-11-18');
  // 15:00 UTC on the 18th is 23:00 in Shanghai and 07:00 in Los Angeles; at 22:00 UTC it is the 19th in Shanghai and still the 18th in Los Angeles.
  assert.equal(review.countToday([at(18, 15)], at(18, 22), 'Asia/Shanghai'), 0, 'Shanghai: that answer was yesterday');
  assert.equal(review.countToday([at(18, 15)], at(18, 22), 'America/Los_Angeles'), 1, 'Los Angeles: that answer was today');
  assert.equal(review.streak(late, at(19, 2), 'Asia/Shanghai'), 2);
  assert.equal(review.streak(late, at(19, 2), 'America/Los_Angeles'), 2);
  assert.equal(review.streak([at(17, 15), at(18, 15)], at(18, 22), 'Asia/Shanghai'), 2, 'Shanghai: the 17th and the 18th, ending yesterday');
  // India is 5:30 ahead: a day boundary that is not on a whole hour.
  assert.equal(review.dayKey(Date.UTC(2026, 10, 18, 18, 29), 'Asia/Kolkata'), '2026-11-18');
  assert.equal(review.dayKey(Date.UTC(2026, 10, 18, 18, 31), 'Asia/Kolkata'), '2026-11-19');
});

test('a day with a clock change is still one day of the streak', () => {
  // Europe/Berlin leaves summer time on 25 October 2026 (that day has 25 hours).
  const local = (day, hour) => Date.UTC(2026, 9, day, hour - 1); // CET = UTC+1 after the change, CEST = UTC+2 before
  const times = [Date.UTC(2026, 9, 24, 8), local(25, 9), local(26, 9)];
  assert.equal(review.streak(times, local(26, 20), 'Europe/Berlin'), 3);
  assert.equal(review.previousDay('2026-03-01'), '2026-02-28');
  assert.equal(review.previousDay('2026-01-01'), '2025-12-31');
});

test('without a time zone the server\'s own is used', () => {
  const now = Date.now();
  const local = new Date(now);
  const expected = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
  assert.equal(review.dayKey(now), expected);
});
