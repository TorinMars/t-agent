// The numbers of the Learn page's Progress view (GET /api/learn/stats; "Learn progress statistics" in docs/design/learn-english-stats.md). Read
// only: nothing is stored. Days are calendar days in the person's time zone, exactly like the streak of the summary (services/learn-review.js
// dayKey / streak). The answer:
//   { streak, best_streak, week: { answers, right, prev_answers, prev_right }, daily: [{ day, answers, right }], weekly: [{ week_start, answers,
//     right_first }], memory: { new, learning, young, mature }, total_cards, due: [{ day, count }] }
// - streak: the summary's streak (consecutive days with an answer, ending today or yesterday); best_streak: the longest run of such days ever (never
//   less than streak).
// - week: the last 7 days including today, and the 7 days before (a rolling week, so a Monday morning is not an empty week); `right` counts the
//   answers that were right.
// - daily: the last 30 days, oldest first, today last, days without answers included as zeros.
// - weekly: the last 12 calendar weeks (Monday to Sunday), oldest first, the current week last. `answers` is the number of first answers of a card on a
//   day (a card answered three times on one day counts once) and `right_first` how many of those first answers were right, so right_first / answers is
//   the share right the first time.
// - memory and total_cards: the cards that are shown at all (not suspended, not an untouched starter word while no starter list is chosen), as the
//   summary counts them. new: never answered. The others by how long they are expected to stay remembered: the FSRS stability (`fsrs_stability`, days)
//   where the column exists and is set, else the review interval (interval_days): under 1 day learning, 1 to under 21 days young, 21 days or more
//   mature.
// - due: the next 14 days from today, by the day of due_at; a card already overdue counts on today. Only cards answered before (new cards are not
//   brought back by the schedule; the daily new words come from the goal).
const review = require('./learn-review');

const DAYS = 30;
const WEEKS = 12;
const DUE_DAYS = 14;
const ROLLING = 7;
const YOUNG_DAYS = 1;
const MATURE_DAYS = 21;
const QUARTER = 15 * 60 * 1000; // every time zone offset is a multiple of 15 minutes: one moment per stretch is enough to know the day
const visible = "suspended = 0 AND NOT (source = 'starter' AND reps = 0 AND @starter IS NULL)";

// A YYYY-MM-DD day moved by `count` days (calendar arithmetic, like review.previousDay).
function addDays(key, count) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + count)).toISOString().slice(0, 10);
}
// The Monday of the week of a YYYY-MM-DD day.
function mondayOf(key) {
  const [year, month, day] = key.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 Sunday
  return addDays(key, -((weekday + 6) % 7));
}
// The longest run of consecutive days in a set of YYYY-MM-DD days.
function longestRun(days) {
  const sorted = [...days].sort();
  let best = 0;
  let run = 0;
  let previous = null;
  for (const day of sorted) {
    run = previous && addDays(previous, 1) === day ? run + 1 : 1;
    if (run > best) best = run;
    previous = day;
  }
  return best;
}
const memoryBucket = days => (days < YOUNG_DAYS ? 'learning' : days < MATURE_DAYS ? 'young' : 'mature');

function createLearnStats({ db = require('../db'), now = Date.now, timeZone } = {}) {
  // Whether the FSRS stability column is there (a newer schema); asked on each call, as a migration may add it while the server runs.
  const hasStability = () => db.prepare('PRAGMA table_info(learn_cards)').all().some(column => column.name === 'fsrs_stability');

  function stats(owner, { starter = null } = {}) {
    const at = now();
    const today = review.dayKey(at, timeZone);
    const firstDaily = addDays(today, -(DAYS - 1));
    const thisMonday = mondayOf(today);
    const firstWeek = addDays(thisMonday, -7 * (WEEKS - 1));
    const firstRolling = addDays(today, -(2 * ROLLING - 1));
    const earliest = [firstDaily, firstWeek, firstRolling].sort()[0];
    // Answers from a little before the earliest day needed (a day is at most 26 hours of the clock), then kept by their day.
    const since = at - ((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${earliest}T00:00:00Z`)) / review.DAY + 2) * review.DAY;
    const wordAnswers = "FROM learn_reviews r JOIN learn_cards c ON c.id = r.card_id WHERE r.owner = ? AND c.kind = 'word'";
    const answers = db.prepare(`SELECT r.card_id, r.at, r.correct ${wordAnswers} AND r.at >= ? ORDER BY r.at, r.id`).all(owner, since);

    const daily = new Map();
    for (let index = 0; index < DAYS; index += 1) daily.set(addDays(firstDaily, index), { answers: 0, right: 0 });
    const weekly = new Map();
    for (let index = 0; index < WEEKS; index += 1) weekly.set(addDays(firstWeek, 7 * index), { answers: 0, right_first: 0 });
    const lastWeekStart = addDays(today, -(ROLLING - 1));
    const week = { answers: 0, right: 0, prev_answers: 0, prev_right: 0 };
    const firstOfDay = new Set(); // `${card}|${day}` already counted for "right the first time"
    for (const row of answers) {
      const day = review.dayKey(row.at, timeZone);
      if (day < earliest || day > today) continue;
      const right = row.correct ? 1 : 0;
      const slot = daily.get(day);
      if (slot) { slot.answers += 1; slot.right += right; }
      if (day >= lastWeekStart) { week.answers += 1; week.right += right; } else if (day >= firstRolling) { week.prev_answers += 1; week.prev_right += right; }
      const key = `${row.card_id}|${day}`;
      if (!firstOfDay.has(key)) {
        firstOfDay.add(key);
        const bucket = weekly.get(mondayOf(day));
        if (bucket) { bucket.answers += 1; bucket.right_first += right; }
      }
    }

    // The streak like the summary's, and the longest run over the whole history (one moment per 15-minute stretch).
    const stretches = db.prepare(`SELECT DISTINCT (r.at / ${QUARTER}) * ${QUARTER} ${wordAnswers}`).pluck().all(owner);
    const streak = review.streak(stretches, at, timeZone);
    const answerDays = new Set(stretches.map(time => review.dayKey(time, timeZone)));
    const bestStreak = Math.max(streak, longestRun(answerDays));

    const params = { owner, starter };
    const strength = hasStability() ? 'COALESCE(fsrs_stability, interval_days)' : 'interval_days';
    const cards = db.prepare(`SELECT reps, ${strength} AS strength, due_at FROM learn_cards WHERE owner = @owner AND kind = 'word' AND ${visible}`).all(params);
    const memory = { new: 0, learning: 0, young: 0, mature: 0 };
    const due = new Map();
    for (let index = 0; index < DUE_DAYS; index += 1) due.set(addDays(today, index), 0);
    for (const card of cards) {
      if (!card.reps) { memory.new += 1; continue; }
      memory[memoryBucket(Number(card.strength) || 0)] += 1;
      const day = card.due_at <= at ? today : review.dayKey(card.due_at, timeZone);
      const bucket = day < today ? today : day;
      if (due.has(bucket)) due.set(bucket, due.get(bucket) + 1);
    }

    return {
      practice_kind: 'word',
      streak,
      best_streak: bestStreak,
      week,
      daily: [...daily].map(([day, value]) => ({ day, ...value })),
      weekly: [...weekly].map(([weekStart, value]) => ({ week_start: weekStart, ...value })),
      memory,
      total_cards: cards.length,
      due: [...due].map(([day, count]) => ({ day, count })),
    };
  }
  return { stats };
}

module.exports = { createLearnStats, addDays, mondayOf, longestRun, DAYS, WEEKS, DUE_DAYS, MATURE_DAYS, YOUNG_DAYS };
