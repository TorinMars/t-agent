# The Learn page: practising English with your own material

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md). The server side (cards, spaced review, meanings,
> the starter list, the collection hooks) is in [learn-english.md](learn-english.md).

## The Learn page

- **Destination**: "Learn" in the navigation rail after Mind maps (`#h5-nav-learn`) and in the phone's bottom navigation after Mind maps
  (`#h5-bnav-learn`), library icon `read` (an open book). `state.learnOpen` (store), `ui.actions.openLearn()` / `closeLearn()` (h5.js);
  `railView` / `phoneView` in `columns.mjs` mark it current; any other destination (or Settings) closes it first; Sessions returns. See
  [page-navigation.md](page-navigation.md).
- **Chunk**: `Learn.jsx` with `learn-grade.mjs`, `learn-model.mjs`, `learn-speech.mjs` and `learn-icons.mjs` is the lazy chunk
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
  Again; right with help: Hard; right: Good, `suggestedGrade`). `POST /api/learn/cards/:id/answer { mode, grade, correct, answer }` (mode is the
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
- **Mistakes**: `GET /queue?mode=mistakes&limit=50` as a list (English, Chinese, word or sentence, times forgotten) and Practise them.
- **Your material**: `GET /cards?kind=&q=&limit=50&offset=` with a search field (250 ms), All / Words / Sentences, "N cards", Show more; each
  row: the English, the meaning or "No meaning yet", kind and source; Edit meaning (`PATCH { zh }`) and Suspend / Restore (`PATCH { suspended }`).
  Nothing is deleted from here.
- **Learn settings**: Collect study material (`PUT { collect }`, then `window.LearnCollect.set(on)` so the page stops or starts collecting at
  once), Daily goal 1 to 200 (saved on Enter or blur), Starter list: Programmer English (on: `POST /starter` then `PUT { starter: 'dev' }`; off:
  `PUT { starter: null }`, which hides the starter words not practised yet), and where word meanings come from, with Open Settings.
- Card text (English and Chinese) is user content: drawn with `translate="no"`, so the Chinese interface never translates a word of a card
  that happens to be a dictionary key; hint words go into the translated templates the same way (`Fmt`).
- MD2 through the theme: cards with the 8px radius, typography variants only (h4 due count, h5 titles and prompts, subtitle1 mode names, body2,
  caption, overline section titles), palette tokens (success / error light for the diff, warning for the streak), 40px tiles (44px in touch
  mode), 44px targets in touch mode.

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
- `spellCheck` compares a spelled word letter by letter; `suggestedGrade` offers the grade.

## Audio

- Learn settings → Audio (`#h5-learn-audio-card`, shared in `learn_v1` like the other learning settings, synced to every linked engine, changed on the
  home from a company computer): Play words automatically (`#h5-learn-audio-words`), Play sentences automatically (`#h5-learn-audio-sentences`),
  Sentences play After the answer / When the card appears (`#h5-learn-audio-when`, off with the sentences), Repeat 1× 2× 3× 5×, Pause between
  repeats 1 s 2 s 3 s, Speed Slow / Normal, Stop when I start typing. Switches and MUI toggle button groups in list rows, each saved at once.
- When a card plays by itself (`autoPlays` in `learn-audio.mjs`): a word (Spell, a word in Review or Mistakes) when it appears, with the repeat, and
  once more after the answer; Dictation always at the start (listening is the task); Say it the model at the start; Build the sentence, Fill the
  gap and a sentence in Review as chosen (after the answer by default, because hearing it first gives the answer away).
- The player (`createPlayer`, pure, with fake timers in `test/h5-learn-audio.test.js`; one per session, `useAudio` / `useCardAudio` in `Learn.jsx`)
  reads with `speakOnce` (learn-speech.mjs) and waits for each reading's end, then the pause. While it plays, Hear it / Play shows "Playing 1 of 2"
  with a Stop text button (`#h5-learn-stop`); pressing Hear it / Play plays again with the same repeat (Slow too, slowly). Typing (a key, the page's
  keyboard, a tile typed after) lets the reading end and skips the repeats after it when the switch is on. Leaving the card, answering and Stop
  cancel what is pending, so nothing of one card is heard over the next. A reading whose end never comes is let go after a time from its length.
- A browser that refuses sound before the first tap (`not-allowed`, or an automatic play that has not started after 2.5 s: iOS): the button
  becomes "Tap to play" (`#h5-learn-tap-play`) once per page load; later automatic plays are not watched.

## Speech

- Reading aloud (`learn-speech.mjs`): `speechSynthesis` with an en-US voice when there is one (else any English voice; while the voices are not
  listed yet, `lang = 'en-US'`); `canSpeak()` decides whether Hear it, Play / Slow and the Dictation mode are shown at all.
- Say it hears the person in one of two ways, decided when the page opens (`voiceWay`): the page's own voice input (`window.VoiceInput.attach`
  with the box and the microphone, click to start and stop, the text typed into the box) while it is turned on in Settings; else the browser's
  `SpeechRecognition` / `webkitSpeechRecognition` in en-US (one phrase per press, the text replaces the box). When the server has no speech
  service, voice input's `onNotConfigured` switches to the browser's recognition if there is one. With neither, the Say it mode is hidden (and a
  card due for Say it or Dictation is built instead). The box can always be typed in.

## Tests

- Unit: `test/h5-learn-audio.test.js` (the settings, `autoPlays`, the player: repeat and pause, Stop, a new play, typing, a lost end, a refusal),
  `test/h5-learn-grade.test.js` (tolerance, the diff, each hint, letters, grades, `typedInFull`), `test/h5-learn-model.test.js` (`slotLayout`, modes and what a
  browser offers, the estimate, tiles and distractors, Hint, the gap, the masked context, a mixed session, the keys), `test/h5-columns.test.js`
  (the destination in `railDestinations` / `phoneDestinations`, `railView` / `phoneView`), `test/page-bundles.test.js` (the chunk, not in the
  first screen).
- `scripts/test-h5-learn-browser.cjs` (mocked `/api/learn`; 1440x900 and 390x844 touch): the destination on the rail and the bottom navigation,
  the home numbers, every mode answered right and wrong with the diff and the hints, the bodies posted for Again / Hard / Good, the keys, Hint,
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
