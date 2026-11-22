// Spaced review of English learning cards with FSRS-6 (services/learn-review.js; "Review rules" in docs/design/learn-review-fsrs.md): the grades as
// FSRS ratings, a new card, the relearning step of again, a same-day review, the cap, the desired retention, the replay of a card's answers, the
// estimate for a card without a state, the preview of the grade buttons, the retrievability, what counts as a mistake, and the streak and "today"
// in the server's time zone. Pure functions with the time passed in.
const test = require('node:test');
const assert = require('node:assert/strict');
const review = require('../services/learn-review');
const fsrs = require('../services/learn-fsrs');

const { DAY, applyAnswer } = review;
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const fresh = () => ({ interval_days: 0, ease: 2.5, reps: 0, lapses: 0, last_at: null, fsrs_stability: null, fsrs_difficulty: null });
const answer = (card, grade, at = NOW, options) => ({ ...card, ...applyAnswer(card, grade, grade !== 'again', at, options) });

test('the first answer of a new card initializes the FSRS state: again 10 minutes, hard 1 day, good 2 days', () => {
  const good = applyAnswer(fresh(), 'good', true, NOW);
  assert.equal(good.fsrs_stability, 2.3065, 'S0(good) = w2');
  assert.equal(good.fsrs_difficulty, 2.11810397, 'D0(good)');
  assert.equal(good.interval_days, 2);
  assert.equal(good.due_at, NOW + 2 * DAY);
  assert.deepEqual([good.reps, good.lapses, good.last_result, good.last_at, good.last_correct, good.ease], [1, 0, 'good', NOW, 1, 2.5]);
  const hard = applyAnswer(fresh(), 'hard', true, NOW);
  assert.deepEqual([hard.fsrs_stability, hard.fsrs_difficulty, hard.interval_days, hard.due_at], [1.2931, 5.11217071, 1, NOW + DAY]);
  const again = applyAnswer(fresh(), 'again', false, NOW);
  assert.deepEqual([again.fsrs_stability, again.fsrs_difficulty, again.interval_days, again.due_at], [0.212, 6.4133, 0, NOW + 10 * 60 * 1000]);
  assert.deepEqual([again.lapses, again.last_correct], [1, 0]);
});

test('good answers on their due day grow the interval by FSRS, capped at 365 days', () => {
  let card = fresh();
  let at = NOW;
  const intervals = [];
  for (let i = 0; i < 9; i += 1) { card = answer(card, 'good', at); intervals.push(card.interval_days); at = card.due_at; }
  // The intervals of ts-fsrs FSRS-6.test.ts "ivl_history" (good x6: 0, 2, 11, 46, 163, 498) after its 10-minute learning step, which keeps S0(good):
  // this app has no learning step for good, and caps at 365.
  assert.deepEqual(intervals.slice(0, 5), [2, 11, 46, 163, 365]);
  for (let i = 1; i < intervals.length; i += 1) assert.ok(intervals[i] >= intervals[i - 1], 'good never shortens the interval when answered on time');
  assert.equal(intervals[intervals.length - 1], 365, 'at most a year');
  assert.ok(card.fsrs_stability > 365, 'the stability itself is not capped');
  assert.equal(card.ease, 2.5, 'the ease is kept as it is');
});

test('hard: the hard penalty gives a shorter interval than good, at least a day', () => {
  const start = answer(fresh(), 'good');
  const hard = applyAnswer(start, 'hard', true, start.due_at);
  const good = applyAnswer(start, 'good', true, start.due_at);
  assert.ok(hard.fsrs_stability < good.fsrs_stability);
  assert.ok(hard.interval_days >= 1 && hard.interval_days < good.interval_days);
  assert.ok(hard.fsrs_difficulty > good.fsrs_difficulty, 'hard makes the card harder');
});

test('again: a relearning step of 10 minutes with the stability after forgetting (the FSRS-6 cap), then FSRS again', () => {
  let card = fresh();
  for (const at of [NOW, NOW + 2 * DAY, NOW + 12 * DAY]) card = answer(card, 'good', at);
  const before = card;
  const lapse = answer(card, 'again', before.due_at);
  assert.equal(lapse.interval_days, 0);
  assert.equal(lapse.due_at, before.due_at + 10 * 60 * 1000);
  assert.equal(lapse.lapses, 1);
  assert.equal(lapse.last_correct, 0);
  const cap = fsrs.roundTo(before.fsrs_stability / Math.exp(fsrs.DEFAULT_W[17] * fsrs.DEFAULT_W[18]), 8);
  assert.ok(lapse.fsrs_stability <= cap && lapse.fsrs_stability < before.fsrs_stability, 'forgetting lowers the stability, at most to the cap');
  // The answer 10 minutes later is a same-day review: the short-term formula, never lower for good.
  const relearned = answer(lapse, 'good', lapse.due_at);
  const sameDay = fsrs.shortTermStability(lapse.fsrs_stability, 3);
  assert.equal(relearned.fsrs_stability, sameDay);
  assert.ok(relearned.fsrs_stability >= lapse.fsrs_stability);
  assert.equal(relearned.interval_days, fsrs.nextInterval(sameDay, 0.9, { maxInterval: 365 }));
  assert.ok(relearned.interval_days >= 1);
});

test('a same-day review uses the short-term stability (w17 to w19), whole 24-hour days count as elapsed', () => {
  const first = answer(fresh(), 'good');
  const sameDay = applyAnswer(first, 'good', true, NOW + 23 * 60 * 60 * 1000);
  assert.equal(sameDay.fsrs_stability, fsrs.shortTermStability(2.3065, 3));
  const nextDay = applyAnswer(first, 'good', true, NOW + DAY);
  assert.equal(nextDay.fsrs_stability, fsrs.recallStability(first.fsrs_difficulty, 2.3065, fsrs.retrievability(1, 2.3065), 3));
  assert.equal(review.elapsedDays(NOW, NOW + DAY - 1), 0);
  assert.equal(review.elapsedDays(NOW, NOW + 3 * DAY + 5), 3);
  assert.equal(review.elapsedDays(NOW + 10, NOW), 0, 'a previous answer in the future (another clock) counts as now');
});

test('the desired retention: 0.95 gives shorter intervals than 0.9, 0.85 longer; anything else is 0.9', () => {
  const card = answer(answer(fresh(), 'good'), 'good', NOW + 2 * DAY);
  const at = card.due_at;
  const days = retention => applyAnswer(card, 'good', true, at, { retention }).interval_days;
  assert.ok(days(0.95) < days(0.9) && days(0.9) < days(0.85), `${days(0.95)} ${days(0.9)} ${days(0.85)}`);
  assert.equal(days(0.5), days(0.9), 'an unknown retention is the default');
  assert.deepEqual([...review.RETENTIONS], [0.85, 0.9, 0.95]);
  // The stability does not depend on the retention: only the due date does.
  assert.equal(applyAnswer(card, 'good', true, at, { retention: 0.95 }).fsrs_stability, applyAnswer(card, 'good', true, at).fsrs_stability);
  // Rescheduling from the stored stability gives the due date the answer would have given at that retention.
  const done = { ...card, ...applyAnswer(card, 'good', true, at) };
  assert.equal(review.rescheduled(done, 0.95).due_at, applyAnswer(card, 'good', true, at, { retention: 0.95 }).due_at);
  assert.deepEqual(review.rescheduled(answer(card, 'again', at), 0.95), { interval_days: 0, due_at: at + 10 * 60 * 1000 }, 'again keeps its 10 minutes');
  assert.equal(review.rescheduled(fresh(), 0.95), null, 'a new card has nothing to reschedule');
});

test('a replay of the answers gives the state of the answers given one by one, in time order, whatever order they come in', () => {
  const answers = [
    { at: NOW, grade: 'good', correct: 1, uid: 'b' }, { at: NOW + 2 * DAY, grade: 'again', correct: 0, uid: 'c' },
    { at: NOW + 2 * DAY + 600000, grade: 'hard', correct: 1, uid: 'd' }, { at: NOW + 5 * DAY, grade: 'good', correct: 1, uid: 'e' },
  ];
  let card = fresh();
  for (const item of answers) card = { ...card, ...applyAnswer(card, item.grade, Boolean(item.correct), item.at) };
  const replayed = review.replay([...answers].reverse());
  for (const field of ['due_at', 'interval_days', 'ease', 'reps', 'lapses', 'last_result', 'last_at', 'last_correct', 'fsrs_stability', 'fsrs_difficulty']) {
    assert.equal(replayed[field], card[field], field);
  }
  assert.deepEqual([replayed.reps, replayed.lapses], [4, 1]);
  assert.equal(review.replay([]), null, 'no answers: no state (the card stays new)');
  assert.equal(review.replay(answers, { ease: 2.2 }).ease, 2.2, 'the ease of the card is kept');
  // A tie in time is ordered by uid, the same on every engine.
  const tie = [{ at: NOW, grade: 'good', correct: 1, uid: 'z' }, { at: NOW, grade: 'again', correct: 0, uid: 'a' }];
  assert.deepEqual(review.replay(tie), review.replay([...tie].reverse()));
  assert.equal(review.replay(tie).last_result, 'good');
});

test('a card answered before without an FSRS state: the stored state is used when there is one, else an estimate from the interval and the ease', () => {
  const legacy = { interval_days: 15, ease: 2.5, reps: 4, lapses: 0, last_at: NOW - 15 * DAY, last_result: 'good', last_correct: 1, fsrs_stability: null, fsrs_difficulty: null };
  assert.deepEqual(review.memoryOf(legacy), { stability: 15, difficulty: fsrs.initDifficulty(3) });
  assert.equal(review.legacyMemory({ ...legacy, ease: 1.3 }).difficulty, 10);
  assert.equal(review.legacyMemory({ ...legacy, interval_days: 0 }).stability, 0.212, 'after again: the first again stability');
  assert.equal(review.memoryOf({ ...legacy, reps: 0 }), null, 'never answered: a new card');
  const next = applyAnswer(legacy, 'good', true, NOW);
  assert.ok(next.interval_days > 15, 'answered on time after 15 days: longer');
  assert.deepEqual(review.memoryOf({ ...legacy, fsrs_stability: 4, fsrs_difficulty: 6 }), { stability: 4, difficulty: 6 });
});

test('the preview of the grade buttons and the retrievability', () => {
  assert.deepEqual(review.preview(fresh(), NOW), { again: 600000, hard: DAY, good: 2 * DAY });
  const card = answer(fresh(), 'good');
  const preview = review.preview(card, card.due_at);
  assert.equal(preview.again, 600000);
  assert.ok(preview.hard >= DAY && preview.hard < preview.good);
  assert.equal(review.retrievability(fresh(), NOW), null, 'a new card');
  assert.equal(review.retrievability(card, NOW), 1);
  assert.equal(review.retrievability(card, NOW + 2.3065 * DAY), 0.9, 'R(S, S) = 0.9');
  assert.ok(review.retrievability(card, NOW + 12 * 60 * 60 * 1000) < 1, 'it falls through the day');
});

test('a word is known: right twice with the last right, or a stability of 21 days (an interval of 21 days without an FSRS state)', () => {
  assert.equal(review.isKnown({ last_correct: 0, fsrs_stability: 21, fsrs_difficulty: 5, interval_days: 3 }, 0), true);
  assert.equal(review.isKnown({ last_correct: 0, fsrs_stability: 20.9, fsrs_difficulty: 5, interval_days: 30 }, 0), false, 'the stability decides when there is one');
  assert.equal(review.isKnown({ last_correct: 0, fsrs_stability: null, interval_days: 21 }, 0), true);
  assert.equal(review.isKnown({ last_correct: 1, fsrs_stability: 2, fsrs_difficulty: 5 }, 2), true);
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
