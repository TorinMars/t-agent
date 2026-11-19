# Learn English

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

## Learn English

Practice of the person's own English: the sentences they send with "Chinese → English, then send" and the words they look up with tap to translate become study cards, plus a starter word list. Progress is kept on the server, per owner, so the phone and the computer of the same person share it. Meanings come from the translation service the person already set up; no other outside service is used.

- **Server**: `services/learn.js` (cards, queues, mistakes, summary, settings, meanings, starter import), `services/learn-review.js` (the review rules, pure), `services/learn-starter.js` (the starter lists, English only), `routes/learn.js` (`/api/learn`). Tables `learn_cards` and `learn_reviews` in `db/schema.sql` (schema 13).
- **Page**: `public/js/learn-collect.js` (the collection hooks, about 2 KB, a classic script combined with the others, not part of the MUI first screen); the Learn page itself is a lazy chunk of the MUI shell (`screen-learn.jsx`, with the grading in `learn-grade.mjs`).
- **Tests**: `test/learn-review.test.js` (the rules), `test/learn.test.js` (checks, routes, owners, meanings, starter, gates), the 12 → 13 migration and the refusal by an older app in `test/data-home.test.js`, `scripts/test-h5-learn-collect-browser.cjs` (the hooks in real Chromium).

### Data

- `learn_cards`: `id`, `owner` (the page login, `req.session.user.login`), `kind` (`word` | `sentence`), `en`, `norm`, `zh` (`''` until a meaning is fetched), `source` (`translation` | `lookup` | `starter` | `manual`), `context` (where it came from, the task title, at most 120 characters), `created_at`, `due_at`, `interval_days` (real), `ease` (2.5 to start), `reps` (answers given), `lapses` (answers graded again), `last_result`, `last_at`, `last_correct`, `suspended`. Times are milliseconds on the server's clock; the API sends them as ISO 8601 strings.
- One card per owner, kind and `norm` (unique): `norm` is the text trimmed, inner spaces collapsed and lower-cased, so a sentence keeps its case but is compared without it. A word is kept in lower case unless it has two or more capitals (API, OAuth); a curly apostrophe is made straight.
- `learn_reviews`: one row per answer (`card_id` with `ON DELETE CASCADE`, `owner`, `at`, `mode`, `grade`, `correct`, `answer` cut to 500 characters).
- Settings: `system_state` key `learn_v1:<owner>`, `{ collect, daily_goal, starter }`, default `{ collect: true, daily_goal: 20, starter: 'dev' }`. Not part of the settings sync (the cards are not either).
- A learning card counts as user data for the empty-home check (`lib/data-home.js`), except starter words never answered.

### Review rules

`services/learn-review.js`, pure functions with the time passed in:

- A new card is due at once (interval 0). Starter words are the exception: they become due 10 a day (`STARTER_PER_DAY`), so the list does not fill the first review.
- **good**: the interval times the ease, taken to the nearest step of 1, 3, 7, 15, 30 days (a tie takes the longer step) when that step is longer than the interval now; with the starting ease that is exactly 1 → 3 → 7 → 15 → 30. When the nearest step is not longer (a low ease), the product itself to 0.1 day. Past 45 days, the product in whole days. At most 365 days. The ease is unchanged.
- **hard**: the interval times 1.2, at least 1 day; ease − 0.15.
- **again**: interval 0, due in 10 minutes; ease − 0.2; lapses + 1. The ease never goes below 1.3.
- Every answer adds one to `reps` and sets `last_result`, `last_at` and `last_correct` (the `correct` of the answer; the grade alone decides the schedule).
- **Mistake**: the last answer was wrong, or `lapses` > 0 and a wrong answer in the last 30 days.
- **Days** are calendar days in the server's time zone (`Intl.DateTimeFormat`, so a day with a clock change is one day). Streak: consecutive days with at least one answer, ending today, or yesterday while nothing was answered yet today. Done today: answers today. New today: cards created today.

### API

Behind the page login and the same-origin check like every `/api` route (the router checks both again itself). JSON; English error messages, Chinese in `public/js/i18n-zh-server.js`; a refused check is 400, a card of another owner or no card 404, a duplicate text on PATCH 409.

- `GET /summary` → `{ due, new_today, done_today, goal, streak, words, sentences, mistakes, collecting, starter }`. It imports the chosen starter list first if it never was.
- `GET /queue?mode=review|spell|build|dictation|say|fill|mistakes&limit=20` (limit 1–100) → `{ cards }`. review: due cards of both kinds, oldest due first; spell: word cards, due first, then the rest by least recently practised (never practised first); build, dictation, say, fill: sentence cards in the same order; mistakes: mistake cards, most recently answered first. Suspended cards never. A word without a meaning asks for it first (4 at a time, no more asks after the first failure); spell leaves out a word whose meaning cannot be found.
- `POST /cards { kind, en, zh?, source, context? }` → `{ card, created }`. A duplicate returns the card there, filling an empty meaning. Checks: a word 1–40 characters, letters with a hyphen or an apostrophe; a sentence 1–300 characters, at least three words (links do not count), no Chinese, not code-like (braces, two semicolons, `=>`, `&&`, `||`, a fence, `::`, `$(`, a slash command or prompt sign at the start, `name = ...`, or more than one character in seven a symbol outside sentence punctuation); `zh` at most 500. While `collect` is off, a card of source `translation` or `lookup` is not kept: `{ card: null, created: false, collecting: false }`.
- `POST /cards/:id/answer { mode, grade: 'again'|'hard'|'good', correct, answer? }` → `{ card }`.
- `PATCH /cards/:id { zh?, en?, suspended? }` → `{ card }` (en checked again).
- `GET /cards?kind=&q=&limit=50&offset=0` (limit 1–200) → `{ cards, total }`, newest first; `q` searches the English and the meaning (`%` and `_` are plain characters). Untouched starter words are left out while no starter list is chosen.
- `POST /meaning { word }` → `{ zh }`: a word card's meaning if it has one, else this service's cache (1,000 words), else the translator once (`translateWord` of `services/translator.js`, through the linked service that shares one like `POST /api/translate/word`); a word card without a meaning gets it. No translator: 503 "Translation service not configured yet"; other translator errors keep their status and message.
- `POST /starter { list: 'dev' }` → `{ added }`: imports the list once (nothing when a starter word of the owner exists; words the person already has are kept) and chooses it.
- `GET /settings`, `PUT /settings { collect?, daily_goal? (1–200), starter? ('dev' | null) }` → the settings. Choosing a list imports it; `starter: null` hides the starter words never answered (the answered ones stay); choosing it again shows them again.

### Collection hooks

`public/js/learn-collect.js` (`window.LearnCollect`), loaded before `word-translate.js` and `h5.js`:

- The switch is read once per page load, at the first use (`GET /api/learn/settings`); `LearnCollect.set(on)` sets it (the Learn page calls it after `PUT /settings`). A failed read counts as off and is tried again next time. The server checks the switch again.
- Translate-and-send (`submitBox` in `h5.js`, the one path of the computer row, the phone and the columns): after the English was sent and only when the translator really translated (`translated` is not false), `LearnCollect.sentence(english, typed Chinese, task title)`. "Send as typed" never collects.
- Tap to translate (`word-translate.js`): when a meaning is shown, `LearnCollect.word(base form or the tapped word, meaning)`.
- Both are fire and forget: nothing is awaited, a failure is dropped silently, a text that cannot be a card (fewer than three words, braces, longer than 300; not a plain word) is not sent, and the same text is sent once per page load.

### Starter list

`services/learn-starter.js`: "Programmer English" (`dev`), about 320 English words of software work (deploy, merge, refactor, latency, timeout, dependency, regression, idempotent, ...) in a rough order of how early a developer meets them. English only (Chinese lives only in the dictionaries, `test/i18n.test.js`); meanings come through `/meaning` when a word first comes up. Another list is one more entry in `STARTER_LISTS`.
