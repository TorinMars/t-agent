# The Learn page: practising English with your own material

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md). The server side (cards, spaced review, meanings,
> the starter list, the collection hooks) is in [learn-english.md](learn-english.md).

## The Learn page

- **Destination**: "Learn" in the navigation rail after Mind maps (`#h5-nav-learn`) and in the phone's bottom navigation after Mind maps
  (`#h5-bnav-learn`), library icon `read` (an open book). `state.learnOpen` (store), `ui.actions.openLearn()` / `closeLearn()` (h5.js);
  `railView` / `phoneView` in `columns.mjs` mark it current; any other destination (or Settings) closes it first; Sessions returns. See
  [page-navigation.md](page-navigation.md).
- **Chunk**: `Learn.jsx` with `LearnAsk.jsx`, `LearnChat.jsx`, `LearnProgress.jsx`, `learn-progress.mjs`, `learn-chat.mjs`, `learn-grade.mjs`, `learn-model.mjs`, `learn-speech.mjs` and `learn-icons.mjs` is the lazy chunk
  `screen-learn.jsx` (`LearnScreen` in `lazy-screens.jsx`, preloaded from the two destination buttons). The first screen only got the two
  destinations, the `learn` icon, the store key and the back layer: 775,336 -> 777,246 bytes (budget 778,240, `test/page-bundles.test.js`, which
  also checks that the page is not in the first download). The page's keyboard (below) reuses the terminal's `Keyboard` of `Osk.jsx`, which is in
  the first screen already; its letter layout and the editing live in the chunk: 777,246 -> 777,481 bytes. The key feel (`key-feedback.mjs`) is a
  chunk loaded at the first key press: 778,014 -> 778,144 bytes.
- **Computer**: a page right of the rail (`#h5-learn`, a region, `left: NAV_WIDTH`, z-index 1255 over either view, under the rail and the
  modals), like Settings. Left, a 420px column with the home; right, the open mode, list or panel, and "How learning works" while none is open.
  Escape closes the open mode, then the page; the back button closes the page (entry.jsx layer); the focus goes into the page and back to the
  opener.
- **Phone**: the home is a full-screen MUI dialog (`#h5-learn`, a back arrow `#h5-learn-close`), each mode a second one sliding in from the right
  (`#h5-learn-mode`, back arrow `#h5-learn-back`, title and "7 / 20 · from your translations"). Both are back layers (back.mjs) and end at the
  bottom navigation; their root is `top: 0; height: calc(var(--h5-height) - var(--h5-bnav-space))`, so while the system keyboard is up (the bar
  steps aside and `--h5-height` is the visual viewport, h5.js `fitViewport`) they end at the top of the keyboard. A mode's actions (Check, I
  don't know, Hint, then the grades) are pinned at the bottom of its page, so the answer field and Check stay in sight above the keyboard.
- **Home** (`GET /api/learn/summary`, `GET /api/learn/settings`): the due count (h4) with "cards due today · about N min" (20 seconds a card,
  `minutesFor`), the goal bar (done today / goal), "N-day streak · D of G done" with the fire icon, and Start review (`#h5-learn-start`); with
  nothing due "Nothing due today" and Practise anyway (`#h5-learn-free`, a mixed session from the spell and build queues). Then PRACTICE: one card
  per mode (`#h5-learn-mode-<id>`) with its count ("42 words", "26 sentences"; the noun is an exact dictionary key, never a "{1} words"
  template), and Mistakes (`#h5-learn-mode-mistakes`, the summary's count); YOUR MATERIAL (`#h5-learn-material`), Learn settings and How
  learning works. Without cards: "No study cards yet", what will appear here, and Add the starter list (`POST /starter` then `PUT /settings
  { starter: 'dev' }`).
- **On a company computer** ("Company computer" in [learn-english.md](learn-english.md)): while `device` of the summary says `cache_only` and
  not `home_online`, an MD2 info Alert at the top of the home (`#h5-learn-home-away`): "T01 can't be reached. Your answers are kept on this
  computer for now and moved to T01 when it is back." (without a `home_name`: "Your other computer can't be reached. …"), and under the numbers,
  when `offline_copy_at` is set, "The counts are those of the last copy from T01 plus what you answered here." (`#h5-learn-offline-counts`).
  On a computer the home column stays beside the open mode, so the banner stays in view; a phone's mode page does not repeat it. With the home
  online nothing is shown (the server hands the waiting answers over). Learn settings keep the reason of a failed change in view
  (`#h5-learn-settings-error`, an error Alert with the server's message, such as the 503 "Learning settings are kept on a normal computer, which
  cannot be reached right now", besides the toast) until the next change works; the switches and the goal show the stored values again.
- **Modes** (`MODES` in `learn-model.mjs`; a session fetches `GET /queue?mode=…&limit=` 20 for words, 10 for sentences):
  - Review: the due cards of both kinds, each in the mode that fits (`exerciseOf`): a word is spelled, a sentence is built. Mistakes and free
    practice work the same way.
  - Spell the word: the meaning and, when the page can read aloud, the phonetic transcription under it next to Hear it (`#h5-learn-phonetic`; the sound is offered there already, so it gives nothing more away) (or, without a meaning, `POST /meaning`; a 503 shows "Word meanings need a translator…" with Open Settings, which
    closes Learn and opens Settings on Voice and translation), the card's context with the word as a gap, Hear it, Show first letter, a box per
    letter over one transparent input, I don't know. **Automatic check**: once the typed letters reach the word's length the answer is checked by
    itself after `AUTO_CHECK_MS` (300 ms, so the last letter is seen; `typedInFull` in `learn-grade.mjs`, `useAutoCheck`); any change in that pause
    (Backspace) starts over; Check stays for a shorter answer; the same with the computer's keys and the page's keyboard. The grade is still the
    person's. **One line** (`slotLayout` in `learn-model.mjs`): the slots stay on one line at 36px with 8px gaps while the word fits the measured width
    (ResizeObserver); else slots, gaps and letters shrink together down to 18px slots with a 14px letter; only a longer word wraps, in rows of even
    length (`.h5-learn-letter-row`; 16 letters: one line at 390px, 8 + 8 at 320px), each row as large as it fits.
    **The right spelling above yours** (after a wrong answer only; a right answer stays one green row and "I don't know" shows the word in one
    primary row): the slots become two rows, the right spelling on top (`.h5-learn-letter-want`) and what was typed under it
    (`.h5-learn-letter-got`), each letter in the same column, both with `data-kind` same / wrong / missing / extra (`.h5-learn-letters` gets
    `data-aligned="true"`). The rows are lined up by the closest match, not by position (`alignSpelling` in `learn-grade.mjs`: an edit-distance
    alignment; on a tie a substitution first, so words of the same length line up by position; gaps land as late as the matches allow), so one
    missing letter does not turn the rest red; "N of M letters right" on the result counts the columns the rows agree on (10 of 11 for one
    missing letter, not the positional count). Top row: an agreeing letter in the text colour over a quiet line, a differing or missing one in
    success light over a success-light line, an empty dashed quiet slot above an extra letter. Bottom row: right letters success light, wrong and
    extra ones error light, an empty error-light dashed slot for a missing letter. The column count (it can exceed the word's length; the typed
    answer is still cut to the word's length) goes to `slotLayout`, and a long word wraps the two rows as pairs (`.h5-learn-letter-pair`) so the
    columns stay aligned. Under the rows `#h5-learn-spell-note` replaces "N letters · type with the keyboard" (the meaning layout only; the
    sentence layout says the result there): "3 letters different", "1 letter missing", "2 extra letters", combined as one sentence with only
    the first part naming the letters ("1 extra letter, 1 missing"; order different, extra, missing; `spellingNote`, every template in
    `i18n-zh-extra.js`). The rows are `aria-hidden` like the slots; the result card still says the right word and "You wrote: …". The same on
    the phone and the computer.
    **Spell the word inside its sentence** (a word picked from the person's translations, "Words from your translations" in
    [learn-english.md](learn-english.md); Spell, Review and Mistakes alike, since all of them use `SpellExercise`): exactly when the card's
    `context_zh` (the Chinese of the sentence card whose English is the card's `context`) is not empty and the word stands in `context` as a whole
    word (`sentenceGap` / `findWholeWord` in `learn-model.mjs`: case-insensitive, a curly apostrophe or dash counts as the straight one, no letter,
    digit or joining apostrophe / hyphen next to it, the punctuation around it outside the gap; the first such place). The prompt card then shows
    "Fill in the word" with a small chip "your translation" (`#h5-learn-from-translation`: caption type, the primary colour on its 12% tint), the
    sentence in the h6 size at the regular weight (`#h5-learn-sentence`, `translate="no"`) with a gap where the word goes (`#h5-learn-gap`: a 2px
    primary underline about as wide as the word, 0.55em a letter, 2.5em to 12em; `aria-label` "blank"), the Chinese under it (body2,
    text.secondary, `lang="zh"`, `#h5-learn-sentence-zh`), a divider, "The word: <meaning>" (`#h5-learn-word-meaning`; or the lookup's states as in
    the meaning layout), Hear it and Show first letter. The letter slots, the page's keyboard and the automatic check are the same. **Sound**: every
    sound of this card is the whole English sentence (its `context`), not the word alone: the automatic play when it appears and once more after
    Check (as for any word: Play words automatically, the repeat, the pause, the speed and Stop when I start typing apply), and Hear it, which keeps
    its label and look ("Playing 1 of 2" with Stop while the sentence plays). Any other word card plays the word. The
    transcription waits for the answer here (frame 1 of the design has none next to Hear it). After Check the word as written in the sentence fills
    the gap (`#h5-learn-sentence-word`, medium weight, underlined, success light when right, error light when wrong or given up: the right word
    either way), the helpers go, under the divider the word with its transcription and its meaning on one line (`WordLine` with the meaning as its
    child, `#h5-learn-feedback-phonetic`, `#h5-learn-meaning`), and under the letters, instead of the Feedback card, the result (`#h5-learn-feedback`,
    `role="status"`, centred: "Correct" in success light or "Not quite" in error light, then "You wrote: …" and "N of M letters right" for a wrong
    answer); the grades stay pinned at the bottom on a phone and come right under the result on a computer. Every other word card (a starter word,
    whose context is the list's title; a word whose form is not in its context; an older server without `context_zh`) keeps the meaning layout with
    its context as "Used in" (`maskedContext`).
  - Build the sentence: the Chinese and where it came from, the English words as tiles shuffled with up to three distractors from the other
    sentences of the session (`tilesFor`, seeded by the card id); tap to place, tap a placed tile to take it back, or type after the tiles
    (Backspace in the empty field takes the last tile back); Hint places the next word in order (taking back wrong tiles first); Skip (computer).
  - Dictation: the sentence is read on start; Play and Slow (0.65); type it; the Chinese shows after Check.
  - Say it: the sentence and its Chinese, Hear it, a microphone (`#h5-learn-mic`) that fills an editable box; see "Speech".
  - Fill the gap: one content word taken out (`gapFor`, the same for a card), typed into the gap; Show first letter; Hear it counts as help. The
    gap word's length is known, so it checks by itself at the last letter like Spell.
- **Words and wrapping**: a word with its transcription after it (`WordLine`: the Spell feedback `#h5-learn-feedback-phonetic`, the material list, Mistakes;
  `translate="no"`, `lang="en-US-fonipa"`, no wrap inside it). Text uses `overflow-wrap: break-word`, so a word breaks only when it alone is wider
  than the line, and sentences wrap between words.
- **After Check**: a card "Right" / "Not quite" with the word-by-word diff (struck red: the answer's wrong or extra word; green: the missing or
  right word), "Word by word: 10 of 11 right" and the named mistakes, then Again / Hard / Good. The offered one is contained and focused (wrong:
  Again; right with help: Hard; right: Good, `suggestedGrade`); each button can show when that grade brings the card back (see "Grade intervals"
  below). `POST /api/learn/cards/:id/answer { mode, grade, correct, answer }` (mode is the
  exercise shown: spell, build, dictation, say or fill; answer capped at 500 characters), then the next card; a failed post stays with a notice.
  At the end: "Session done", answered and right, Back to Learn, Practise more.
- **The page's own keyboard** (touch screen; `useLearnKeys` and `LearnKeys` in `Learn.jsx`, `#h5-learn-keys`): without a hardware keyboard (input
  mode not `pointer` and no `hasKeyboard`) the answer fields of Spell, Fill the gap, Dictation and Build have `inputmode="none"` (like the xterm
  textarea), so the system keyboard never opens; T-Agent's keyboard (the terminal's `Keyboard` of `Osk.jsx`: same look, Shift one-shot or caps
  lock on a double tap, Backspace repeating after 400 ms every 60 ms, keys that never take the focus) sits at the bottom of the mode, where the
  system keyboard would be. Single words (`data-kind="letters"`): `qwertyuiop` / `asdfghjkl` / Shift `zxcvbnm` Backspace / apostrophe, hyphen and
  Hide at the right; no Space, no digits. Sentences (`data-kind="full"`): the terminal's full layout (letters, `123`, `#+=`, Space, Backspace)
  with Hide where Enter is: Check (then the grades) is right above it, so Enter is left out. It opens by itself when a card starts (the field gets
  the focus, as on a computer) except in Build, where the tiles come first and a tap on the answer opens it; Hide closes it (pressed on click, not
  on pointerdown, so the rest of the tap cannot land on the bottom navigation that comes back); a tap on the letters or the field opens it again.
  A key edits the field at its caret through the exercise's own change handling (the React state, never the DOM value), the caret is put back
  after the new value is drawn, and Backspace in Build's empty field takes the last tile back. While it is open on a phone `state.learnKeys` is
  true, the bottom navigation steps aside as for the terminal keyboard (BottomNav.jsx), the page reaches the bottom of the screen and the pinned
  actions stay right above the keys. It stays open after Check (the keys do nothing then) so the layout does not jump between cards. Say it keeps
  the system keyboard for its box. A computer (or a touch device where a hardware key was seen) has no page keyboard. Not tried on a real iPhone
  or Android phone.
- **Key feel** (`key-feedback.mjs`, a chunk of its own loaded at the first key press by `Osk.jsx` `feel`, so the first screen carries about 130
  bytes; the terminal's keyboard and the Learn keyboards alike): a haptic tick on each pointerdown (`navigator.vibrate(8)` on Android; on iOS 17.4+,
  which has no Vibration API, a visually hidden `<input type="checkbox" switch>` toggled through its `<label>`, the focus put back; feature-detected,
  never throws; a held Backspace ticks once), and while a character key is held a bubble above it with the character 1.5 times larger
  (`.h5-key-bubble`: one element fixed in the viewport and appended to `<body>`, so no box clips it and nothing moves; the key's colour one step
  lighter made opaque, 8px radius, elevation 4, at least 1.3 key widths, clamped to the keyboard's width; `aria-hidden`; not for Shift, Backspace,
  Space, Enter, the layer keys or Hide). Not tried on a real phone: the iOS switch haptic and Android vibration are only checked as calls.
- **Focus**: the buttons that play or help (Hear it, Play, Slow, the sound icon button, Show first letter, Hint; `keepFocus`) never take the focus
  from the answer field: `mousedown` is cancelled (as with the terminal's keys) and, should a browser move the focus anyway, a pointer press gives
  it back to the field that had it, so the caret stays where it was; a button reached with Tab keeps its focus.
- **Keys of a computer** (`exerciseKey`): Enter checks, Enter again takes the offered grade; 1 / 2 / 3 grade a checked answer (the fields are
  read-only then); Enter on a focused button is the button's own.
- **Mistakes** (`LearnMistakes.jsx`, in the same chunk): the card "Why do I get these wrong?" (`#h5-learn-analyze-card`): "38 mistakes since the last report (11-13). The analysis uses your translation model." with Analyze (contained, `#h5-learn-analyze`; off with no new mistakes, no model or a run going on; "Analyzing your mistakes…" with an indeterminate bar while `POST /reports { lang }` waits), Last report and All reports; without a usable model an info Alert with Open Settings (`#h5-learn-analyze-no-model`) and Analyze off; a failed run in an error Alert in the card (`#h5-learn-analyze-error`). Then "Mistakes, newest first" with Practise them (`GET /queue?mode=mistakes`) and every wrong answer (`GET /mistakes`, 50 at a time, Show more): what was asked for (success light), "You wrote: …" or "You didn't know it" (error light), the time (today, yesterday, 11-18), a mode chip (the mode's name), the tag chip (warning, outlined) and "with help". On a company computer whose home is away an info Alert says only this computer's mistakes are shown.
- **A report** (`#h5-learn-report`): "11-13 – 11-20 · 38 mistakes in 212 answers", the summary (subtitle1), the kinds as rows of label, determinate bar (relative to the largest) and count; then per finding its title, "Cause · …", "What to do · …" and the first three cards "+N"; "Practise these N cards" (`POST /cards/find` with the findings' cards, then a session in the Mistakes mode). The model's text is `translate="no"`. All reports lists them (range, count, Weekly / Asked for, two lines of summary). A report opened from Mistakes goes back there (`parent` of the view). Opening an automatic report sets `report_seen` (`PUT /settings`), so the home's line goes away on every device.
- **Home line**: while `summary.new_report` is set, an info Alert under the numbers "Your weekly mistake report is ready (38 mistakes)." with View (`#h5-learn-new-report`).
- **Report language**: after `GET /settings`, when the server has `report_lang` and it differs from the page's language (`I18n.get()`), the page sets it, so the weekly report is written in the language the person reads.
- **Your material**: `GET /cards?kind=&q=&source=&limit=50&offset=` with a search field (250 ms), All / Words / Sentences, "N cards", Show more; each
  row: the English, the meaning or "No meaning yet", kind and source; Edit meaning (`PATCH { zh }`) and Suspend / Restore (`PATCH { suspended }`).
  Nothing is deleted from here. Opened from "Picked so far" in Learn settings (`{ kind: 'material', source: 'translation', parent: settings }`) it
  starts on Words with `source=translation` and shows the chip "From your translations" (`#h5-learn-source-filter`, the library `close` icon as its
  delete icon) that clears the source filter; its back arrow returns to Learn settings. Words that were already cards (a starter word that got a
  sentence as its context) keep their source, so they are counted in "Picked so far" but not in this filtered list.
- **Learn settings**, top to bottom: MY LEVEL, WORDS FROM MY TRANSLATIONS, PRACTICE, REVIEW SCHEDULE, AUDIO and the translator card. The section titles are MD2
  overlines in text.secondary like the rest of the Learn page (the design drew them in the primary colour).
  - **MY LEVEL** (`LevelSettings`, `GET /api/learn/level` when the settings open: `{ level: { level, label, reason, answers, mistakes, report_at,
    updated_at } | null, picking: { enabled, picked, skipped, sentences, pending, running }, translator }`): a card `#h5-learn-level-card` with "Your
    level (estimated)", the level in h4 (`#h5-learn-level`) with its label (body2, text.secondary), the reason (body2), and the caption
    `#h5-learn-level-note` "From 155 answers, 43 mistakes and the report of 11-16 · updated 11-21 09:00" (without a report "From N answers and M
    mistakes"; `levelNote` in `learn-model.mjs`, dates in the browser's time zone). The label and the reason are the model's English, drawn with
    `translate="no"`. Without a level "Not estimated yet" (h6, `#h5-learn-level-none`). The text button `#h5-learn-level-check` "Check again" (or
    "Check now" without a level) posts `POST /api/learn/level/check`; while it waits the button is off and says "Checking…", an indeterminate bar
    shows (`#h5-learn-level-busy`) and the card is `aria-busy`; the answer replaces level and counts. A failure (409 a run going on, 502 an
    unreadable answer, 503 no translator) is shown like the other failed changes (`#h5-learn-settings-error` and a toast); a 503 also turns the
    button into the translator notice. With `translator: false` the existing translator notice (`#h5-learn-level-no-translator`, Open Settings)
    stands where the button was; a level synced from another engine is still shown. An engine without the route (an older version) says the
    server's message in the card (`#h5-learn-level-error`) and the rest of the settings work.
  - **WORDS FROM MY TRANSLATIONS** (`#h5-learn-pick-card`): the switch "Pick words from my translations" (`#h5-learn-pick-words`, `PUT /settings
    { pick_words }`, on unless the stored value is `false`; shared like the other learning settings), "Picked so far" with `#h5-learn-picked` "57
    words from 91 sentences · 12 skipped (you know them)" and "· 3 waiting" while `pending` > 0 (`pickedNote`; "—" when the counts could not be
    read) and the text button View (`#h5-learn-picked-view`, Your material on these words, above), then the caption `#h5-learn-pick-privacy` "Your
    sentences and a summary of your answers go to the translation model you set up (the same one that translated them). Nothing else is sent."
  - **PRACTICE**: Collect study material (`PUT { collect }`, then `window.LearnCollect.set(on)` so the page stops or starts collecting at
  once), Daily goal 1 to 200 (saved on Enter or blur), Starter list: Programmer English (on: `POST /starter` then `PUT { starter: 'dev' }`; off:
  `PUT { starter: null }`, which hides the starter words not practised yet), Analyze my mistakes every week (`#h5-learn-analysis-auto`, `PUT { analysis_auto }`, shared), and where word meanings come from, with Open Settings.
  - **REVIEW SCHEDULE** (`ScheduleSettings`, `#h5-learn-schedule-card`): the row "Remember" with "How sure you want to be when a card comes back"
    and a toggle button group 85% / 90% / 95% (`ChoiceRow` `#h5-learn-retention`, buttons `data-value="0.85|0.9|0.95"`), saved at once with
    `PUT /settings { desired_retention }` (shared, learn_v1, like the rest), then the caption "Cards are scheduled with FSRS, a model of how memory
    fades, from your own answers. Higher means more reviews; 90% is a good balance." The section is shown only when the server's settings have a
    numeric `desired_retention` (an older server without FSRS has none). The FSRS scheduling itself is the server's (the FSRS branch,
    `services/learn-fsrs.js`).
- **Progress** (`ProgressView` in `LearnProgress.jsx`, view `{ kind: 'progress' }`; data `GET /api/learn/stats`, [learn-english-stats.md](learn-english-stats.md)):
  opened from the text button "Progress" (`#h5-learn-progress`, library icon bar-chart `learnChart`, 18px start icon) at the bottom of the home's
  Today card. A phone shows it full screen like the other views, a computer in the Learn right pane. The bar has the text button "Table"
  (`#h5-learn-progress-table`, `aria-pressed`; "Charts" while the tables show), passed to `ViewFrame` as its new `action`.
  - Four stat tiles (`#h5-learn-progress-tiles`, a grid of `minmax(148px, 1fr)`: two per row on a phone, four on a computer): Streak "N days" with
    "best M"; This week, the answers with "answers · +N vs last" / "−N vs last" / "same as last week"; Right this week "76%" with "+3 points vs last"
    ("–" and "no answers to compare" without answers); Remembered well = `memory.mature` "of N cards" (`tiles` / `deltaParts` in `learn-progress.mjs`).
  - Four chart cards (`#h5-learn-progress-charts`, `minmax(300px, 1fr)`: one per row on a phone, two on a computer), in this order: "Answers per day"
    / "Last 30 days" (columns), "Right answers by week" / "Share of answers right the first time, last 12 weeks" (a line, `right_first / answers`
    per week, a week without answers breaks it), "Memory strength" / "How long each card is expected to stay remembered (FSRS)" (four bars: New
    never answered, Learning under 1 day, Getting there 1 to 21 days, Remembered well 21 days or more; relative to the largest group, the count at
    the right), "Due in the next 14 days" / "Cards the schedule brings back each day" (columns, the first labelled Today).
  - Drawn as inline SVG in the component (no chart library), following the dataviz rules: one hue, the theme's primary, for every mark (single
    series, so no legend: the titles name them); columns at most 24px wide with about a third of the slot as air, a 4px rounded top and a square
    foot (`columnLayout`, `columnPath`); a 2px line over a 10% wash; the end dot r 4 with a 2px ring in the card's own colour (the 1dp overlay
    mixed into the paper, `mixColor`); a hairline solid grid in the divider colour; clean y ticks (`niceTicks`: 1, 2 or 5 times a power of ten,
    compact from 10,000); x labels on the first, middle and last slots (`labelSlots`, short dates in the page's language, `shortDay`); the line's
    last value as its only direct label; all text in text.primary / text.secondary, never the series colour.
  - Tooltips (`.h5-learn-chart-tip`, grey 800, the value line strong, kept inside the card): on every column (the whole slot is the hit target, so
    an empty day has one too: "Nov 17 · 40 answers" / "31 right (78%)", "No answers"), on the line (the nearest week with a crosshair: "76% right
    the first time" / "Week of Nov 17 · 100 cards"), on the memory rows (with the share of all cards) and on the due columns ("21 cards" / "Today,
    with the overdue ones"). A mouse shows the slot under it and clears on leaving; a tap shows the slot tapped and a second tap clears; each chart
    is focusable: focus shows the last slot, the arrow keys move, Escape clears. The hovered column turns a lighter primary.
  - "Table" shows every chart as an MUI table (`#h5-learn-table-daily|weekly|memory|due`, newest first for the days and weeks), the tiles stay.
  - Loading "Loading…", a failed load an error alert with Retry (`#h5-learn-progress-error`); with no answers at all (`hasAnswers`: no best
    streak and nothing in the 30 days or 12 weeks) one card "Answer a few cards and your progress shows here." instead of the charts, and no
    Table. On a company computer whose home is away (or older) the server answers from the cards there with `offline` / `home_older`, and an info
    alert says the numbers come from this computer (`#h5-learn-progress-offline`).
- **Grade intervals** (`Grades` in `Learn.jsx`, used after every answer in every mode, `gradeIntervals` / `intervalParts` in `learn-progress.mjs`):
  a queue card of the FSRS server has `next: { again, hard, good }` (milliseconds until due for each grade; again is 600000) and
  `retrievability`. When `next` is there, each button shows its interval under the label in caption size (`.h5-learn-grade-when`): under an hour
  "N min", under a day "N h", then "N days" ("1 day"), past 60 days "N mo" (30-day months), past 365 days "N yr" (one decimal under 10 years);
  the button's `aria-label` is "Good, 5 days". The three buttons share the row (`flex: 1`, at most 200px each on a computer, never wrapping), keep
  the 44px touch targets and fit a 320px phone; the suggested grade stays contained and focused, Enter and 1 / 2 / 3 work as before. Without
  `next` (an older server) the buttons stay the plain labels. "How learning works" describes FSRS instead of the old 1 / 3 / 7 / 15 / 30 days.
- Card text (English and Chinese) is user content: drawn with `translate="no"`, so the Chinese interface never translates a word of a card
  that happens to be a dictionary key; hint words go into the translated templates the same way (`Fmt`).
- MD2 through the theme: cards with the 8px radius, typography variants only (h4 due count, h5 titles and prompts, subtitle1 mode names, body2,
  caption, overline section titles), palette tokens (success / error light for the diff, warning for the streak), 40px tiles (44px in touch
  mode), 44px targets in touch mode.

## Ask about this question

A conversation with the translation model about the card on screen (the server side, the prompt and the storage are "Ask about a card" in
[learn-english.md](learn-english.md)). `LearnAsk.jsx` (in the Learn chunk; the pure parts in `learn-model.mjs`), `useAsk` in `Learn.jsx`.

- **Ask** (`#h5-learn-ask-open`): a text button with the library icon `message` (`learnAsk`) at the end of the card's button row, right-aligned:
  Spell's helper row (after Check, in the sentence layout, alone), Dictation's Play / Slow row, and a row at the bottom of the prompt card in Build,
  Say it and Fill the gap. Review and Mistakes use the same exercises. It keeps the field's focus like the other helpers (`keepFocus`). It always
  says "Ask"; the earlier messages are shown inside.
- **Phone**: an MD2 modal bottom sheet (MUI `Drawer` anchor bottom, `#h5-learn-ask`, `data-layout="sheet"`, `role="dialog"`): top at
  `min(150px, 18vh)`, bottom at the bottom of `--h5-height` (so above the system keyboard), 8px top corners, a 32% black scrim, a handle, over
  the Learn pages (`zIndex.modal + 1`). A back layer by itself (a modal); Escape and the scrim close it.
- **Computer** (the wide layout): a 380px side panel at the right of the window (`data-layout="side"`, `role="complementary"`, fixed inside
  `#h5-learn`, no scrim). On a window at least 1200px wide the pane makes room for it (`:has()` padding), so the card stays fully usable; on a
  narrower one it covers the card's right part. Its input gets the focus when it opens (hardware keyboard only); Escape closes the panel before
  Learn closes the mode.
- **Content** (both the same): title "Ask about this question" (h6), a caption (`askCaption`: before Check "The sentence with the gap · your
  answer is not shown yet" for Fill the gap and Spell inside its sentence, else "Not checked yet: hints only"; after it "Your answer: expiers ·
  wrong" / "· right", "—" for an empty answer), Close (text button), "Try one, or type your own (Chinese or English):", the chips (`askChips`,
  outlined MUI Chips sent at once with their shown, possibly Chinese, text: before Check "Give me a hint", "What part of speech fits?" (word)
  or "Explain the grammar" (sentence), "Other example sentences", "How do I remember it?"; after Check "Why was my answer wrong?" (when wrong)
  first, then "Explain the grammar", "Other example sentences", "How do I remember it?"), "N earlier questions" (overline, the questions stored
  when the panel first opened for this card), the conversation (`role="log"`), before Check the caption "Before you check, the answer is not given
  away, only hints.", and the input ("Ask about this word or sentence", after Check "Ask a follow-up"; at most 500 characters, Enter sends,
  Shift+Enter a new line) with the send icon button (`aria-label` "Send"; it never takes the focus from the input).
- **Bubbles** (`.h5-learn-ask-msg`, `data-role`): the person's on the right (primary at 16%), the model's on the left (the 8dp surface overlay),
  body2, 8px radius, `lang` from the text (`textLang`: a CJK character makes it `zh`), `translate="no"`, `white-space: pre-wrap`; `**bold**`
  (`boldParts`) is the only markup, the rest is React text.
- **Requests**: `GET /api/learn/cards/:id/ask` each time it opens (not while an answer is on its way), merged into what is shown
  (`mergeMessages`: union by uid, ordered by the ISO `at` then uid, newest 20). `POST` with `{ question, mode: <the exercise>, state }`
  (`askState`: `{ checked: false }` before Check; after it `answer`, `correct`, `helped`; plus `expected`, at most 300 characters, when the
  exercise asks for something other than the card's English: Fill the gap's word). An `application/x-ndjson` answer is read as it comes
  (`ndjsonLines`): the `delta`s grow a temporary model bubble (`data-streaming`), the `done` line's stored messages replace it; any other answer
  is read as JSON `{ messages }` (a company computer asking its home). Closing the sheet or panel aborts the request (nothing is stored).
- **Errors**: a JSON error before the stream (a model failure before its first text: 502 / 504; 409 another question about the card runs; 429
  too many in a minute; any other 503, such as a company computer whose home went away) or an `{"error"}` line half way: the question stays,
  an error Alert with the server's message (translated by the server dictionary) and Try again (`#h5-learn-ask-retry`, asks the same question).
  The 503 "Translation service not configured yet" (or `translator: false` from GET) shows the translator notice with Open Settings ("Asking
  about a question needs a translator…"), puts a typed question back into the input and turns off the chips and Send. GET with `offline: true`
  says "Questions are answered by your normal computer, which cannot be reached right now.", with `home_older: true` "Your normal computer needs
  an update to answer questions." (a short line, `#h5-learn-ask-away`, instead of the notice; chips and Send off). A failed GET shows an error
  Alert with Try again.
- **Keys and focus**: typing in the panel never reaches the exercise (its own input; Session's keys skip `.h5-learn-ask`, and while the phone's
  sheet is open the card's keys are off altogether). Closing gives the focus back to the exercise field (on a touch screen only to a field with
  `inputmode="none"`, so the system keyboard does not open); the sheet's own focus restore is off.

## English chat

The person's own conversations with the translation model about English, not tied to a card: words, grammar, how to say something, their
English journal entries and their journaling habit (the server side, the prompt, the meta line, the storage and the sync are "English chat" in
[learn-english.md](learn-english.md)). `LearnChat.jsx` (in the Learn chunk; the pure parts in `learn-chat.mjs`). The approved design is the board
"Learn · English chat: your own questions, journal and habits" (frames 1 to 7). Same content on a phone and a computer.

- **Home entry** (frame 1): after Mistakes the overline "Ask" and a mode card `#h5-learn-mode-chat` "English chat" (library icon `message`,
  `learnAsk`), "Ask anything about English: words, grammar, how to say something", and "N chats": `chats` of `GET /api/learn/summary` when the
  server sends it, else the length of `GET /api/learn/chats`, read again with each new summary (`useChatCount`). It opens the view
  `{ kind: 'chat' }` (a new chat).
- **Phone** (frames 2, 3, 5, 6): the view is a Learn mode page (`#h5-learn-mode`) with its own app bar: back arrow (`#h5-learn-back`, to the
  home), "English chat" with the open chat's title as the subtitle (`#h5-learn-chat-title`, "New chat" until the first answer names it) and the
  Journal tag before it, then the icon buttons Earlier chats (`#h5-learn-chat-history`, library `reload time`, Ant Design's history,
  `learnHistory`), New chat (`#h5-learn-chat-new`, `add`) and, once the chat exists, its menu (`#h5-learn-chat-more`, `taskMore`). Below, the
  conversation (`#h5-learn-chat`, `data-layout="phone"`) and the input pinned at the bottom (above the system keyboard, like every Learn page).
- **Earlier chats** (frame 4, phone only): the view `{ kind: 'chats', parent }`, its own screen: back arrow (to the chat it came from; the back
  button and Escape do the same: `PhoneLearn` closes it to `parent`, not to the home), "Earlier chats", New chat, the rows, and the caption
  "Kept on the server and on your other machines." (`#h5-learn-chats-note`).
- **Computer** (frame 7): the view fills Learn's right pane (`.h5-learn-pane` without padding): a 260px chats list (`#h5-learn-chats`: "Chats",
  a "New chat" text button with the plus icon, the rows, the same caption) and the conversation (`data-layout="wide"`: the title in h6 with the
  Journal tag, the menu, Close; the messages; the input). Picking a row or New chat changes the conversation in place (an answer on its way is
  cancelled). The input takes the focus when a chat opens (hardware keyboard or mouse). Escape closes the menu or a dialog first, then the view.
- **Rows** (`.h5-learn-chat-row`, `data-uid`, the open one `aria-current`): the Journal tag, the title (body2, medium), and
  "11-21 22:05 · 6 messages" (`chatLine`: the time of the last message in the browser's zone, "1 message" / "{1} messages"); newest first.
- **New chat** (frame 3, `#h5-learn-chat-start`): the message icon, "Ask anything about English" (h6), "Words, grammar, how to say something,
  your journal entries and your learning habits. Ask in Chinese or English.", "Try one:" and the chips (`CHAT_CHIPS`): "Review my journal entry"
  puts "Please review my journal entry:" and a line break into the input, "How do I say … in English?" puts `How do I say "" in English?` with the
  caret between the quotes, "Check my sentence" puts "Please check my sentence: " (each translated, `chipFill`; the input gets the focus; nothing
  is sent); "How is my journaling going?" and "Words I keep getting wrong" send their shown text at once with `topic` `journal` / `mistakes`. Above
  the input the privacy caption "Your questions and your level go to the translation model you set up. A short summary of your recent mistakes or
  your journal is added only when you ask about them." (`#h5-learn-chat-privacy`).
- **Messages** (`.h5-learn-chat-msg`, as Ask's bubbles): the person's on the right, the model's on the left, `lang` per text, line breaks,
  `**bold**`, and the corrections of a reviewed journal entry (frame 5): `[-wrong-]` as a `<del>` in the error colour (struck through) and
  `{+right+}` as an `<ins>` in the success colour, underlined (`answerParts`; never across a line break; an unclosed marker stays as written).
  A trailing `<<meta>>` line is never shown: the server strips it, and the page cuts a complete one and holds back a piece that could be its start
  while streaming (`visibleAnswer`).
- **Add to my cards** (frame 2): under a model message with `cards`, the caption "Add to my cards" once and an outlined primary chip per card,
  "+ <en>"; a tap posts `POST /api/learn/cards { kind, en, zh, context, source: 'manual' }` (`context`: for a word the sentence of the answer it
  stands in, as corrected, at most 120 characters, `cardContext`; '' for a sentence) and the chip turns "✓ <en>" (`data-added`). Cards the server
  marks `added` start as ✓; a card added once is ✓ in every message of the view (`cardKey`: kind and text). A failure shows an error Alert under
  that message's chips.
- **Input**: multiline (up to 6 lines, then it scrolls), "Ask anything about English" (with messages "Reply or write more"), at most 4000
  characters; Send (`#h5-learn-chat-send`, `aria-label` "Send", never takes the focus). On a computer (a mouse or a hardware keyboard seen) Enter
  sends and Shift+Enter is a new line; on a touch screen Enter is a new line and the button sends (`enterSends`; an IME composition never sends).
  The Learn keyboard is not used here. A typed question about the journal or mistakes (`chatTopic`: journal, diary, habit and the Chinese for
  diary and habit; mistake, wrong, keep getting and the Chinese for mistake) is sent with that `topic` too.
- **Sending** (`POST /api/learn/chats/send { chat: uid | null, question, topic? }`): the question and a growing model bubble (`data-streaming`);
  the first NDJSON line `{"chat"}` names a new chat (the page keeps its uid, adds it to the list and shows the menu), `delta`s grow the bubble,
  `done` replaces the temporary bubbles with the stored messages and updates the chat (its title from the first answer). A plain JSON answer
  `{ chat, messages }` (a company computer asking its home) is taken the same way. When a new chat's first answer fails, the chat is dropped
  again (nothing is stored).
- **Menu** (`#h5-learn-chat-menu`): "Mark as journal entry" / "Not a journal entry" (`PATCH { journal }`; the person's choice wins over the
  model's), "Rename" (a form dialog "Rename chat", the title filled in, at most 60 characters, Cancel / Save contained, `PATCH { title }`),
  "Delete" (a confirmation "Delete this chat?", "It is deleted on all your machines. Cards you added from it stay.", Cancel / Delete in the
  error colour, `DELETE`; then a new chat).
- **Errors** (as Ask): a JSON error before the first piece or an `{"error"}` line half way keeps the question with an error Alert and Try again
  (`#h5-learn-chat-retry`, the same question and topic). 409 "This chat is full. Start a new one." (or a chat that already holds 100 messages)
  shows an info Alert `#h5-learn-chat-full` with New chat, and the question waits in the input for the new chat. The 503 "Translation service not
  configured yet" (or `translator: false` from GET) shows the translator notice ("English chat needs a translator…"), the question back in the
  input, chips and Send off. `GET /chats` with `offline: true` / `home_older: true` (a company computer whose home cannot answer) shows Ask's
  lines ("Questions are answered by your normal computer, which cannot be reached right now." / "…needs an update…") with chips and Send off.
  The other routes of a company computer answer 503 "Your English chats are kept on a normal computer, which cannot be reached right now" or
  409 "…needs an update first" and show as an error Alert; a 409 "Another question in this chat is being answered" too (only the exact "This
  chat is full…" text gets New chat). A chat that is gone (404 "Chat not found" from GET, PATCH or DELETE) is left: a new chat in its place and
  the list read again. `PATCH { journal: false }` may answer the chat as `deleted` (one non-journal chat too many, pruned at once): the same, plus
  the notice "This chat was removed: only the newest 50 chats are kept.". A refused title (400 "A chat title has 1 to 60 characters") shows in
  the rename dialog. Deltas are joined exactly as they come (the server holds back trailing white space); only the display holds back a
  possible `<<meta>>` start.

## Grading

- `scripts/h5-shell/learn-grade.mjs` (pure, `test/h5-learn-grade.test.js`): `wordsOf` drops the punctuation around words and compares in lower
  case (a curly apostrophe is a straight one; inner hyphens and apostrophes stay), so case, extra spaces and the final full stop never count.
  `diffWords` aligns the words by their longest common subsequence; between two anchors a left-out word and an added word side by side are one
  word replaced (`wrong`), the rest `missing` / `extra`. `correct` means every word matches and nothing is extra.
- Hints (`hintsOf`, at most one per word, `hintText` gives the English template): article missing / not needed / the wrong one (a, an, the);
  -s added or missing, called a third person -s when the word is a verb (after he / she / it …, before an object word, or ending a noun phrase
  that starts the sentence or a clause: "after the session cookie expires") and a plural -s otherwise; past tense -ed (also -ied and a doubled
  consonant); a spelling slip (edit distance 1, or 2 for words longer than 7; not for words of 3 letters or fewer); the word order (the same
  words in another order, or a word missing in one place and extra in another).
- `spellCheck` compares a spelled word letter by letter (the stored answer, the "N of M letters right" line and the mistake tag use it);
  `alignSpelling` lines the right spelling up above a wrong one by the closest match and counts the different, missing and extra letters, and
  `spellingNote` turns the counts into the line under the two rows (see "Spell the word"); `suggestedGrade` offers the grade.
- `mistakeTag` gives a wrong answer its first tag (see "Mistakes" in [learn-english.md](learn-english.md)); the session sends it with `expected` and `hinted` for a wrong answer only.

## Audio

- Learn settings → Audio (`#h5-learn-audio-card`, shared in `learn_v1` like the other learning settings, synced to every linked engine, changed on the
  home from a company computer): Play words automatically (`#h5-learn-audio-words`), Play sentences automatically (`#h5-learn-audio-sentences`),
  Sentences play After the answer / When the card appears (`#h5-learn-audio-when`, off with the sentences), Repeat 1× 2× 3× 5×, Pause between
  repeats 1 s 2 s 3 s, Speed Slow / Normal, Stop when I start typing. Switches and MUI toggle button groups in list rows, each saved at once.
- When a card plays by itself (`autoPlays` in `learn-audio.mjs`): a word (Spell, a word in Review or Mistakes) when it appears, with the repeat, and
  once more after the answer (a word asked inside its sentence plays that whole sentence instead, Hear it too; see "Spell the word"); Dictation always at the start (listening is the task); Say it the model at the start; Build the sentence, Fill the
  gap and a sentence in Review as chosen (after the answer by default, because hearing it first gives the answer away).
- The player (`createPlayer`, pure, with fake timers in `test/h5-learn-audio.test.js`; one per session, `useAudio` / `useCardAudio` in `Learn.jsx`)
  reads with `speakOnce` (learn-speech.mjs) and waits for each reading's end, then the pause. While it plays, Hear it / Play shows "Playing 1 of 2"
  with a Stop text button (`#h5-learn-stop`); pressing Hear it / Play plays again with the same repeat (Slow too, slowly). Typing (a key, the page's
  keyboard, a tile typed after) lets the reading end and skips the repeats after it when the switch is on. Leaving the card, answering and Stop
  cancel what is pending, so nothing of one card is heard over the next. A reading whose end never comes is let go after a time from its length.
  An end reported while the browser is still reading (`speechSynthesis.speaking` / `pending`, `isSpeaking` in learn-speech.mjs; some browsers
  report the end of a whole sentence early) does not start the next repeat: every repeat begins with a cancel and would cut the sentence off (the
  user's report, 2026-11-21: "it starts the second pass before the sentence has finished"). The player looks again every 200 ms and starts the
  pause only when the browser has stopped, giving up after the longest time a reading can take.
- A browser that refuses sound before the first tap (`not-allowed`, or an automatic play that has not started after 2.5 s: iOS): the button
  becomes "Tap to play" (`#h5-learn-tap-play`) once per page load; later automatic plays are not watched.

## Speech

- Reading aloud (`learn-speech.mjs`): `speechSynthesis`, always American English (the user's rule, 2026-11-21: American pronunciation). Every
  utterance has `lang = 'en-US'`; `pickVoice` takes, among the en-US voices only, a natural one by name first (Samantha, Ava, Allison, Susan, Tom,
  Alex, Google US English, Microsoft Aria / Jenny / Guy / Ava / Andrew / Emma / Brian), then the browser's default en-US voice, then one on this
  device, then any en-US voice, and never a macOS novelty voice (Albert, Bells, Zarvox, ...). It never sets a British, Australian or Indian voice:
  without an en-US voice the utterance keeps only its language and the browser picks. `canSpeak()` (any English voice, or none listed yet) decides
  whether Hear it, Play / Slow and the Dictation mode are shown at all. The transcriptions are American IPA too (see "Phonetic transcription" in
  learn-english.md), and the Ask tutor is told to use American spelling, usage and pronunciation. Tests: `test/h5-learn-speech.test.js`.
- Say it hears the person in one of two ways, decided when the page opens (`voiceWay`): the page's own voice input (`window.VoiceInput.attach`
  with the box and the microphone, click to start and stop, the text typed into the box) while it is turned on in Settings; else the browser's
  `SpeechRecognition` / `webkitSpeechRecognition` in en-US (one phrase per press, the text replaces the box). When the server has no speech
  service, voice input's `onNotConfigured` switches to the browser's recognition if there is one. With neither, the Say it mode is hidden (and a
  card due for Say it or Dictation is built instead). The box can always be typed in.

## Tests

- `scripts/test-h5-learn-progress-browser.cjs` (mocked `/api/learn/stats`, a queue with `next`, settings with `desired_retention`; 1440x900,
  390x844 and 320x640 touch): the Progress button opens the view in the pane and full screen, the tiles, the four charts (thin columns, the line's
  last value, the memory values, one hue), two charts per row on a computer and one on a phone, tooltips on hover, tap and focus (columns, an
  empty day, the line with its crosshair, the memory rows, the due chart with the arrow keys), Table and Charts, a failed load with Retry, the
  empty state, the grade intervals with Enter and a card without `next`, the buttons in one row with 44px targets at 390 and 320px, REVIEW
  SCHEDULE saving `desired_retention` and hidden on an older server, How learning works; `H5_SHOT_DIR` saves `progress-*.png`, `grades-*.png`,
  `schedule-desktop.png`. Unit: `test/h5-learn-progress.test.js` (the interval text, the tiles' deltas, ticks, the column shape, the pointer
  helpers, dates and colours).

- `scripts/test-h5-learn-mistakes-browser.cjs` (mocked API, 1440x900 and 390x844 touch): the home line and View, a report (range, summary, bars, findings), marked seen, Practise these N cards, the Mistakes list with chips, Show more, Analyze (the body, the wait, the report), a model error, All reports, the weekly switch, the language told once, the page without a model, no sideways scroll at 390px; `H5_SHOT_DIR` saves `mistakes-*.png`.
- Unit: `test/h5-learn-grade.test.js` also has `mistakeTag`. `test/h5-learn-audio.test.js` (the settings, `autoPlays`, the player: repeat and pause, Stop, a new play, typing, a lost end, a refusal),
  `test/h5-learn-grade.test.js` (tolerance, the diff, each hint, letters, the alignment and its line, grades, `typedInFull`), `test/h5-learn-model.test.js` (`slotLayout`, modes and what a
  browser offers, the estimate, tiles and distractors, Hint, the gap, the masked context, a mixed session, the keys), `test/h5-columns.test.js`
  (the destination in `railDestinations` / `phoneDestinations`, `railView` / `phoneView`), `test/page-bundles.test.js` (the chunk, not in the
  first screen).
- `scripts/test-h5-learn-pick-browser.cjs` (mocked `/api/learn` as in "Words from your translations" of [learn-english.md](learn-english.md), Asia/Taipei
  time zone; 390x844 touch and 1440x900): Spell inside the sentence (chip, sentence and gap width, Chinese, divider, "The word:", helpers, no
  transcription before the answer, the letters and the page keyboard), its sound the whole sentence at the start, on Hear it ("Playing 1 of 2", Stop)
  and once after Check, never the word alone, the automatic check filling the gap in the success colour with the word, its
  transcription and meaning, "Correct" and the pinned grades; a word whose meaning is looked up, given up (error colour, "Not quite"); a starter word
  (its sound the word, at the start and on Hear it) and a word not in its sentence in the meaning layout with "Used in"; Learn settings: the level card and its caption, Check again (busy, the new
  level, "waiting"), a 409 in the error Alert, the switch's `PUT`, View with `source=translation&kind=word`, the chip that clears it and back to
  the settings, the privacy caption, no sideways scroll, the 16px gutter; no level yet and Check now; no translator; a 503 from Check; an engine
  without the route; on a computer a wrong answer typed with the keys, the grades under the result and Enter, Review using the layout, View in the
  pane. `H5_SHOT_DIR` saves `learn-pick-spell.png`, `learn-pick-checked.png`, `learn-pick-settings.png` (frames 1, 2 and 4 of the design) and
  `learn-pick-desktop.png`. Unit: `test/h5-learn-model.test.js` (`findWholeWord`, `sentenceGap`, `levelNote`, `pickedNote`, `shortDateTime`).
- `scripts/test-h5-learn-ask-browser.cjs` (mocked `/api/learn/cards/:id/ask`, a fetch stand-in feeding the stream piece by piece; 390x844 touch
  and 1440x900): Ask in Spell's helper row and in Build's prompt card; the sheet (top, bottom, corners, scrim, title, caption, Close, the hint
  chips, the earlier messages with `lang` and bold, the hints note, Send's name); typing in the sheet not reaching the letters; a chip streamed
  into a growing bubble then replaced by the stored messages; Close returning the focus; after Check the caption, the chips and a follow-up
  answered as JSON with its `state`; a JSON 502 before the stream, a 429, a company computer's 503 and an error half way, each with Try again; the
  translator notice; the card's keys off while the sheet is open; the side panel (380px, the card making room and staying usable, Enter sending
  without checking, Escape closing only the panel and the focus back); Fill the gap's `expected`; the offline and home-too-old lines.
  `H5_SHOT_DIR` saves `learn-ask-sheet.png`, `learn-ask-checked.png`, `learn-ask-desktop.png`. Unit: `test/h5-learn-ask.test.js`.
- `scripts/test-h5-learn-chat-browser.cjs` (mocked `/api/learn/chats` and `/api/learn/cards`, a fetch stand-in feeding the stream piece by
  piece; 390x844 touch and 1440x900): the home entry after Mistakes with its count (from GET /chats, or from the summary), the new chat (title,
  icon buttons and their names, the chips, the privacy caption, a multiline input, no Learn keyboard), the three fill chips (text and caret, no
  request), Enter on a touch screen not sending, a send chip streamed (its `topic`, the first `chat` line showing the menu, a held-back and a
  complete `<<meta>>` never shown, `done` naming the chat), the menu (mark and unmark, rename), Earlier chats (rows, Journal tags, the row lines,
  the note, back to the chat), Add to my cards (✓ from `added`, a tap and its body, an error), Delete (Cancel, the error colour, the request, a
  new chat), the corrections drawn, a 502 with Try again, a 409 with New chat keeping the question, a company computer's JSON answer, a typed
  question's topic and the translator notice, the offline line, back to the home; on a computer the 260px list beside the conversation, the
  focus, picking a row, Shift+Enter and Enter, the chat moving to the top, the menu and Escape, New chat in place, Escape closing the view.
  `H5_SHOT_DIR` saves `learn-chat-home.png`, `-new`, `-streaming`, `-earlier`, `-conversation`, `-journal` and `-desktop`. Unit:
  `test/h5-learn-chat.test.js` (chips and `chipFill`, `chatTopic`, `visibleAnswer`, `answerParts`, `cardContext`, `chatLine`, the merges,
  `enterSends`).
- `scripts/test-h5-learn-browser.cjs` (mocked `/api/learn`; 1440x900 and 390x844 touch): the destination on the rail and the bottom navigation,
  the home numbers, every mode answered right and wrong with the diff and the hints (Spell's two rows of a wrong answer: by position, a missing
  letter at 390px, an extra and a missing letter wrapped as two pairs at 320px, their kinds, colours, lines and the line under them), the bodies posted for Again / Hard / Good, the keys, Hint,
  Skip, the end of a session, no translator and its link, Mistakes, the material list (search, kind, edit, suspend, restore), the settings
  (`PUT` bodies, `window.LearnCollect`), Escape, Sessions and another destination leaving the page, the back button, the empty states, a browser
  without speech, the focus kept by Hear it, Show first letter, Hint and Slow (computer and phone), no page keyboard on a computer; on a phone the
  page ending at the bar, the letter keyboard of Spell (layout, `inputmode`, keys at the caret, Shift, Backspace and its repeat, Hide and the tap
  that opens it again, the bottom navigation away, Check above the keys), the full keyboard of Build (opened by a tap, Backspace taking a tile
  back) and Dictation (layers, the caret), and Say it's Check above the system keyboard. A company computer at 390px: the banner and the
  offline counts only while the home cannot be reached, and a 503 of the settings shown in the panel. Auto-check, phonetics and audio (390px touch,
  speech stubbed with start and end events): the word played twice with a 1 s pause, "Playing 1 of 2" and Stop, typing skips the repeat, Stop
  cancels it, the key bubble (character, place, clamped at both edges, above the top row, gone on pointerup / pointercancel, none for Backspace)
  with one `navigator.vibrate` per press and none for a held Backspace's repeats, the focus kept; a short answer waits, Backspace in the pause
  cancels, the last letter checks by itself, the transcription with the word, the word once more after the answer; Fill the gap checks at its last
  letter and plays after the answer, Build plays nothing before it; every Audio setting saved by its `PUT`, then "When the card appears" and Slow
  playing Build at the start slowly; a 16-letter word on one line at 390px and in 8 + 8 at 320px; "Tap to play" when speech is refused; a computer
  checking at the last letter with its keys. `scripts/test-h5-osk-browser.cjs` checks the bubble and the ticks on the terminal's keyboard.
  `H5_SHOT_DIR` saves screenshots.
