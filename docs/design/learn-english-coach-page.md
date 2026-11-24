# Learn English: the coach, the page

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md). The server side of the coach (the tools, the views,
> the storage, the HTTP API) is in [learn-english-coach.md](learn-english-coach.md); the rest of the Learn page in
> [learn-english-page.md](learn-english-page.md).

The English chat becomes ONE continuous conversation with a coach. The approved design is the board "English coach in chat" (frames 1, 2, 3, 3b,
3c, 3d, 4 and its explanation column). Code: `scripts/h5-shell/LearnCoach.jsx` (the view, the cards, the Coach settings group), the series runner
`SeriesSession` in `Learn.jsx`, the pure parts in `learn-coach.mjs` (stream lines, cards, divider, suggestions, usage, notes) and `learn-series.mjs`
(the practice series). Same content on a phone and a computer.

## Which chat opens

- `#h5-learn-mode-chat` opens the view `{ kind: 'chat' }`. `useCoachSupport` asks `GET /api/learn/coach?limit=1` once per page load: a 404 (an
  engine without the coach, also an HTML 404) keeps the old English chat (`ChatView`, "English chat on the page" in
  [learn-english-chat.md](learn-english-chat.md)) unchanged; any other answer (also a network failure, which then shows the coach's own error with
  Try again) opens the coach. The local engine's `/info` has no capabilities on the page, so the route itself is the test.
- **The link `/h5?learn=coach`** (the coach's reminder in T-Attention): `public/js/h5.js` takes it out of the address at start (like `openTerminal`) and
  calls `ui.actions.openLearn('chat')`, which sets the store's `learnTarget`; Learn opens the coach for it once and clears it.
- **A company computer whose home is away** (`GET /coach` with `offline` or `home_older`): an info Alert "Your English coach is on a normal computer,
  which cannot be reached right now" (or "…needs an update first"), no starters, nothing can be sent. `translator: false` on the GET shows the
  translator notice at once.
- With the coach the home card reads "Your coach: practice, your progress and any English question" and shows no count of chats.

## The conversation

- **Phone**: a Learn mode page with its app bar (back arrow, "English chat", the menu `#h5-learn-coach-more`), the conversation
  (`#h5-learn-coach[data-layout="phone"]`) and the input at the bottom. While the coach is open on a phone the bottom navigation steps aside
  (`state.learnCoach`, set by `Coach`, read by BottomNav.jsx like a keyboard: no room kept), so the input sits at the bottom of the window with the
  safe-area inset and the message list keeps at least 55% of a 390x844 window; the header's back arrow returns (the bar is back on the Learn home).
  Only the coach does this: the old chat, the series and the other Learn pages keep the bar. **Computer**: the right pane without padding, the title in h6 with the menu
  and Close (`#h5-learn-back`), the messages in a 760px column. No chats list, no New chat.
- **Pages**: `GET /api/learn/coach?limit=50`, newest page; scrolled to within 80px of the top with `has_more` it reads
  `?before=<at of the oldest>&limit=50` ("Loading earlier messages…") and keeps what was in view where it was. `tools_ok: false` shows the line below.
- **Messages**: the person's and her bubbles are the old chat's (`Bubble`: markdown-lite, `lang`, the `<<meta>>` guard); `meta.cards` give the
  "Add to my cards" chips as before. A `practice` message is a centred caption divider (`practiceLine`): "Spelling finished · 25 words · 8 min"
  (plan kinds `today_spelling`, `more_new_words`), "Practice finished · N words · M min" otherwise, "Stopped after 9 of 25" for `stopped`; the numbers
  are the result's `total` (the different cards the plan gave), `done` (of those, the cards answered) and `seconds` (at least 1 min).
- **Usage**: under an answer whose `meta.usage` (or the `done` line's `usage`) has `tool_rounds` > 0 or tokens, a caption "Looked at your data 3
  times", plus "3 calls · 18,400 tokens" when tokens are counted (`usageParts`). With more than one part it is one line of small grey text with
  only the first part and a small down arrow (`.h5-learn-coach-usage`, a button with `aria-expanded`); a tap shows the whole caption and a second
  tap folds it again. The tap area is 44px high without taking room (`::after`). A caption of one part is plain text.
- **Suggestions**: `meta.suggestions` of the newest answer (texts or `{ text }`, at most 4) as a strip of outlined chips right above the input
  (`#h5-learn-coach-next`, a group named "What next?", outside the message list; the first chip in the primary colour); a tap sends the text. On a
  phone one line that scrolls sideways (no wrap, scroll snap, no visible scrollbar); on a computer the chips wrap. 44px high for touch input,
  32px with a mouse. Only for the newest answer and not while one streams.
- **Empty**: "Your English coach", a line, and four starters that send at once ("Give me today's spelling practice", …).
- **Input**: "Reply or write more", multiline, at most 4,000 characters; Enter sends with a hardware keyboard or mouse (`enterSends`), the button
  on touch.

## Sending and the stream

`POST /api/learn/coach/send { text }` and `POST /api/learn/coach/practice-result` are read the same way (`streamCoach`, `coachLine`): `{ delta }`
grows her bubble (`data-streaming`); `{ type: 'status' }` shows "Looking at your answers…" (`#h5-learn-coach-status`) until the first delta;
`{ type: 'proposals' }` shows the cards (disabled until `done`); `{ type: 'remembered', note }` adds the Remembered line with Undo; `{ type: 'done' }`
(or `done: true`) carries `messages`, or `message` with `user` / `practice`, `tools` and `usage`. A question or result that `done` does not send
back stays as the page's own copy just before the answer; proposals, remembered notes and usage that came on the way are kept on the answer when
its meta lacks them. `tools: false` shows "This service cannot look up your data; she answers from a short summary." above the input. An error
line or a JSON error keeps the question (or the result divider) with an error Alert and Try again; 503 "Translation service not configured yet"
shows the translator notice. A plain JSON body (a company computer) is taken as `done`.

## The cards

- **Plan** (`proposalType` 'plan': kind `practice` or a plan kind, or `plan` / `steps`): one compact row (`.h5-learn-coach-plan-row`) of the icon
  of the plan kind, the title over one line "25 words · about 8 minutes" (the server's numbers, `planCaption`; both cut with an ellipsis) and the
  contained Start button (44px) at the right; under the row only what a plan has beyond that: for more than one step the numbered steps ("Spell each word", "Fill the gap inside a sentence",
  "Dictation", "A final retest of the words you missed again"), the notes. Start posts
  `plans/start { message_uid, proposal_id }`; `{ empty: true }`, no plan, or a plan this browser cannot run (only Dictation without speech) shows
  "Nothing left of this practice" on the card; else the series opens. The button stays usable (an old button reads the queue again).
- **Settings** ("SETTING": "New words a day: 10 → 15"; the from value is the card's `before`, else the learning settings now), **cards** ("ADD 6
  WORDS" with up to three chips and "+3"; "CHANGE N MEANINGS"; "REMOVE N CARDS" with the action in the error colour), **reminder** ("REMINDER IN
  T-ATTENTION": `Every day at 20:00 (Taipei time): "…". Tapping it opens this chat.`, weekdays named by the browser, the zone from the card's
  `time_zone` or the browser's) and **memory** ("NOTE TO REMEMBER"). Each has Cancel (text) and its action (contained: Change, Add all, Remove,
  Apply, Set it, Remember this). `proposals/:id/run { message_uid }` → the state "Changed" / "Added" / "Removed" / "Reminder set" / "Remembered",
  with Undo while the answer's `undo.token` lasts (at most 10 s, `undo.expires_at`); Undo posts `coach/undo { token }` → "Undone". Cancel posts
  `proposals/:id/cancel` → "Cancelled". After a settings or cards change the learning settings and the summary are read again.
- **Remembered**: "Remembered: job interview in March (until 31 Mar)" (`meta.remembered` of stored answers without Undo); for a note of this view
  Undo for 10 s: `coach/undo { token }` when the note carries `undo.token`, else `DELETE /coach/notes/:uid`; then "Removed from memory".

## The practice series

`SeriesSession` (Learn.jsx) runs the plan of `plans/start` (`{ id, steps: [{ mode, cards }] }`) in Learn's mode page (phone) or the right pane
(computer), with the existing exercises and `POST /cards/:id/answer` (grading, FSRS and counters unchanged). `learn-series.mjs`:

- **Exercise per card** (`seriesExercise`): `spell`, `review` (the step of a Review plan; title "Daily review") and `retest` spell a word, a sentence gets Fill the gap; `fill` takes a sentence, or a word
  inside its own `context` (the word is the gap, `exerciseCard` gives the exercise the sentence with `card.gap`; the answer stays the word card's),
  else the word is spelled; `dictation` only where the page can speak, else the step is left out. Build the sentence stays hidden.
- **Misses come back** (`seriesAnswer`): a card missed outside the retest goes into the retest step when the plan has one (each card once; the
  server's retest card list is not used: the page decides from the answers); without a retest it is added once after the last step's items. A
  retest with nothing missed is skipped.
- **Header**: the exercise's title ("Spell the word", "Fill the gap", "Dictation", "Final retest"); on a phone one line with "Step 2 of 4 ·
  from your chat" in caption size and the counter "7 / 9" at the end ("from your chat" alone for a one-step plan), the back arrow named "Back to
  chat" (no separate "Back to chat when done" chip; "Compact practice on a phone" in [learn-spell-practice.md](learn-spell-practice.md)); on a
  computer "Step 2 of 4 · 7 / 9 · from your chat"; the progress bar is the share answered.
- **Leaving** (back arrow, the back button, Escape: `leaveView` in Learn calls the series) asks nothing; the answers are kept. Leaving or the end
  returns to the coach with `{ kind: 'chat', result, planKind }`; the coach posts `practice-result` once (`seriesResult`: `plan_id`,
  `message_uid`, `proposal_id` and `kind` of the plan card, `steps: [{ mode, total, done, right }]` in items, `total` / `done` / `right` in different
  cards of the items the plan gave (a word asked in Spell and again in Fill the gap is one word; right: answered there and never wrong there),
  `missed: [{ en, typed }]` with the first wrong typing, `seconds`, `stopped: true` when left early) and shows its divider while her reply streams in. Nothing answered: nothing is
  posted.

## Menu and Earlier chats

The menu (`#h5-learn-coach-menu`): "Reset the summary" (`POST /coach/summary/reset`, a notice), "Earlier chats", "Coach settings" (Learn settings
scrolled to the Coach group; back returns to the coach). Earlier chats reuse the old chat view read-only: on a phone the list
(`{ kind: 'chats', readOnly }`, no New chat) and a chat (`{ kind: 'oldchat', uid }`: messages only, no input, no menu, back to the list); on a
computer the 260px list and the conversation in the pane ("Pick a chat to read it…", Close back to the coach).

## Coach settings

A group "Coach" in Learn settings, shown when the learning settings have `coach_memory` (a server with the coach): "Remember things about me"
(`coach_memory`) and the notes (`GET /coach/notes`): tap a line to edit in place (Enter or leaving saves `PATCH { text }`, one line, at most 200
characters; Escape cancels), × deletes with Undo ("Note deleted · Undo" in its place; the `DELETE` goes after 10 s or when the settings close), "N of
40 notes. …"; "Let the coach read my learning answers" (`coach_read_answers`), "Let the coach read my journal and chats" (`coach_read_text`), "Save
tokens" (`coach_economy`, off by default: "A shorter memory of the conversation and at most 3 lookups per answer"), "Reset the summary"; under the
card "What she reads is sent to your translation service to write the answer." The switches save through `PUT /api/learn/settings` like the other
learning settings (shared, synced); the first three are on unless false.

## Tests

`test/h5-learn-coach.test.js` (the series: exercises, steps, the retest, misses at the end, leaving, the result; the stream lines, merging, the
cards, the divider, suggestions, Remembered, notes, usage) and `scripts/test-h5-learn-coach-browser.cjs` (390x844 touch, with the checks of the compact layout: no bottom navigation, the message list at
least 55% of the window, the plan card in one row, the usage line opened by a tap, the chips in one line above the input; and 1440x900 against a
stub of the contract; a company computer whose home is away; an engine without the coach keeps the old chat), and end to end with the real server
`scripts/test-h5-learn-coach-e2e-browser.cjs` (see "Tests" in [learn-english-coach.md](learn-english-coach.md)). The old chat's own test (`scripts/test-h5-learn-chat-browser.cjs`) runs
against a stub without the coach route.
