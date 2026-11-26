# Learn English: progress statistics

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

## Learn progress statistics

`GET /api/learn/stats` gives the numbers of the Learn page's Progress view (the page is described in [learn-english-page.md](learn-english-page.md)). It is read only (nothing is stored) and is computed by `services/learn-stats.js` (`createLearnStats({ db, now, timeZone })`, reached through `stats(owner)` of the learning service in `services/learn.js`). Behind the page login and the same-origin check like the rest of `/api/learn` ([learn-english.md](learn-english.md), "API").

Days are calendar days in the person's time zone, exactly like the streak of `GET /summary`: `dayKey` and `streak` of `services/learn-review.js` (the server's own zone unless one is handed in).

```
{ practice_kind: 'word', streak, best_streak,
  week: { answers, right, prev_answers, prev_right },
  daily:  [{ day: 'YYYY-MM-DD', answers, right }],            // 30 entries
  weekly: [{ week_start: 'YYYY-MM-DD', answers, right_first }], // 12 entries
  memory: { new, learning, young, mature },
  total_cards,
  due: [{ day: 'YYYY-MM-DD', count }] }                        // 14 entries
```

All figures use word cards and their answers. Answers recorded against old standalone sentences remain stored as history.

- `streak`: the summary's streak (consecutive days with at least one answer, ending today, or yesterday while nothing was answered yet today). `best_streak`: the longest run of such days in the whole history, never less than `streak` (one moment per 15-minute stretch is read, as for the streak).
- `week`: the last 7 days including today, and the 7 days before them (a rolling week, so the tile is not empty on a Monday morning). `answers` counts every answer, `right` the answers that were right.
- `daily`: the last 30 days, oldest first, today last; days without answers are there with zeros.
- `weekly`: the last 12 calendar weeks, Monday to Sunday, oldest first, the current week last. `answers` is the number of first answers of a card on a day (a card answered three times on one day counts once; the same card the next day counts again) and `right_first` how many of those first answers were right, so `right_first / answers` is the share right the first time.
- `memory` and `total_cards`: only the cards that are shown at all, as the summary counts them (not suspended, and not an untouched starter word while no starter list is chosen). `new`: never answered (`reps = 0`). The others by how long they are expected to stay remembered: the FSRS stability (`learn_cards.fsrs_stability`, days, schema 22) where the column exists and the value is set, else the review interval `interval_days`: under 1 day `learning`, 1 to under 21 days `young`, 21 days or more `mature`. The column is looked up on each call (`PRAGMA table_info`), so an older database and a card whose stability was not computed yet both fall back to the interval.
- `due`: the next 14 days from today, by the day of `due_at`; a card already overdue counts on today. Only cards answered before: new cards are not brought back by the schedule (the daily new words come from the goal), so the starter list does not fill today's column.

**Company computer.** The answers live on the normal machines, so a company computer ("Company computer" in [learn-english.md](learn-english.md)) first syncs, then asks its home (`GET /v1/learn-sync/stats`, the same answer, made by the home's `stats(owner)`). While the home cannot be reached (503) the cards and answers here are counted and the answer has `offline: true`; a home without this route or without word-only statistics gives the same with `home_older: true` (both flags are present in either fallback). Any other refusal of the home is passed on. The message while away is "Your progress is kept on a normal computer, which cannot be reached right now".

Tests: `test/learn-stats.test.js` (a fake clock in Asia/Taipei, a fixture database; the interval fallback and, after `ALTER TABLE ... ADD COLUMN fsrs_stability`, the stability; the route and the company computer with a stubbed sync).
