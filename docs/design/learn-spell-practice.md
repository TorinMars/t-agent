# Spell: type it yourself and English input

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md). The Learn page itself (Spell the word, the page's
> own keyboard, the keys of a computer) is in [learn-english-page.md](learn-english-page.md); the Mac app's side of the input source switch is
> "English input while spelling" in [mac-app.md](mac-app.md). Also here: the compact practice layout of a phone.

## Type it yourself

Code: `PracticeRow` / `usePractice` in `Learn.jsx`, the state in `learn-practice.mjs`; Spell, so also Review and Mistakes word
cards and the sentence layout; not a word that keeps slipping, which has its own steps.

After every answer (right, wrong, I don't know) a row
under the result (`.h5-learn-practice`, a quiet box at 5% of the text colour, 8px radius; in the meaning layout inside the Feedback card between
the result, whose `role="status"` is now an inner box, and the grades; in the sentence layout under the centred result, above a computer's
grades): "TYPE IT YOURSELF" (overline, text.secondary) with the count at the right (`#h5-learn-practice-count`, caption, `role="status"`
`aria-live="polite"`: "Typed right 2 times", success light just after a round), empty slots of the right word (`slotLayout` of the word's length
in the row's measured width, so the same sizing rule as the answer), and a caption under them (`#h5-learn-practice-note`): "Practice only, not
graded", on a computer "Practice only, not graded · Enter takes Good · 1 2 3 grade" with the offered grade and the keys as `<kbd>`. The focus
goes to the row's field at once (`#h5-learn-practice-input`, a hidden input over the slots like the answer's, `aria-label` "Type the word
yourself", the row a `role="group"` with the same name; the offered grade is still contained but no longer focused, `focus` of `Grades`) and the
row is scrolled into sight above a phone's pinned grades. A right letter stays (success light over a success-light line); a wrong key shows in
its slot in error light on a 16% error tint for `PRACTICE_FLASH_MS` (400 ms) and is not kept, with "Not that letter" (error light) under the
row until the next right key; Backspace takes the last kept letter back; the word complete counts a round ("Typed right N times", "Again? Just
keep typing") and the row empties after `PRACTICE_ROUND_MS` (600 ms; a key in that pause starts the next round at once). The next slot has the
primary line while the field has the focus. Case does not matter; apostrophes and hyphens are typed (a curly apostrophe or a dash matches the
straight key); **the space of a phrase is filled in by itself** (`autoChar`): the letter keyboard has no Space, and the answer field drops spaces
too, so a Space key only for phrases was not added; a typed space is ignored. Not graded, nothing is sent, the review schedule does not change;
the count lives only while the card is shown. The page's own keyboard stays open and types into the row (`useLearnKeys` gets the row's field and
change once the answer is checked; the row's field has `inputmode="none"` like the answer's and types only at its end); a hardware keyboard and an
input method work too (below). The field's text is turned into keys by the change (`practiceChange`: what was taken away at the end is Backspace,
what was added are keys), so typing, the page's keys and a composition all go the same way. Not in this version: a setting to turn the row
off, counting the rounds in Progress.

## English input

Code: `learn-input.mjs`, `useLatinInput` in `Learn.jsx`; on the Spell answer field and the "Type it yourself" field.

- A phone or tablet without a keyboard: nothing to switch, the page's letter keyboard types English letters only.
- A browser on a computer (or a tablet with a keyboard) cannot switch the system's input method, so keys typed while one composes count as
  letters. During a composition the field keeps the input method's own text (the controlled value follows the field, so the input method keeps
  working) while the letters go to the slots (`createComposer`): the composition's Latin letters when it has only those (pinyin as typed, its
  separators `'` and spaces and full-width letters handled), else, when it shows Chinese (a candidate, Sogou's partly converted text, WeType-like
  input methods that show Chinese at once), the longest of the letters seen and the letters of the keys pressed (keydown `code` KeyA..KeyZ while
  `isComposing`, keyCode 229 or key `Process`; the keydown before compositionstart counts too). The text the input method commits is dropped
  and the letters stay (Enter that commits the letters gives the same). A value an input method changed without a composition is mended
  (`cleanTyped`: its CJK text out, the keys' letters in its place); Safari's input event after compositionend is taken as the same letters.
  `maxlength` is off while composing. The first composition (or input method key) of a Learn session shows above the letters an info Alert,
  `role="status"`, `#h5-learn-ime-notice`: "Chinese input is on. Your letters still count; to switch, press Ctrl+Space (on a Mac Caps Lock or
  Ctrl+Space)." (the keys as `<kbd>`, not translated) with OK (`#h5-learn-ime-ok`, keeps the field's focus); it stays on the next cards until OK
  and does not come back after OK while Learn is open (page state only, nothing stored, so no browser key).
- The T-Agent Mac app: when the Spell answer field or the practice field gets the focus the page posts `'english'` to
  `window.webkit.messageHandlers.tagentInputSource`, and `'restore'` 150 ms after it loses it (so the answer field to the row switches nothing),
  at once when Learn closes and on `pagehide` (`inputSourceBridge`: each state once; feature-detected, nothing outside the app). The app selects
  an English input source and puts the person's own back ("English input while spelling" in [mac-app.md](mac-app.md)). No notice in the app.
- Not tried with real input methods (macOS Pinyin, Sogou, WeType): Chromium's IME path is driven with CDP (`Input.imeSetComposition` /
  `insertText`) and WeType-like input with dispatched composition events; Safari's order of events is handled from its documented behaviour
  only.

## Compact practice on a phone

Code: `ViewFrame`, `useRevealFocus`, `AudioIcons`, `FirstLetterIcon`, `ClampText`, `PHONE_LETTER_ROWS` in `Learn.jsx`; the icons `learnStop`,
`learnSlow`, `learnHint` in `learn-icons.mjs`. Every practice page on a phone (Spell the word, Learn it in parts, Fill the gap, Dictation, a
coach's series), so the card keeps room while the page's letter keyboard is open (it was about a third of the screen):

- **Header on one line** (56px): back arrow, the title (subtitle1), then at the end "Step 1 of 4 · from your chat" / "from your translations" in
  caption, text.secondary (`.h5-learn-subtitle-note`, shrinks first with an ellipsis) and the counter "7 / 10" (body2, `.h5-learn-subtitle`). In
  a series the arrow is named "Back to chat" (aria-label and title); the "Back to chat when done" chip row is gone. A computer keeps its title
  row ("Step 1 of 4 · 7 / 10 · from your chat").
- **Keeps slipping** is a small tag (20px chip, warning on its 12% tint) in the top right corner of the card (the Prompt's badge), not a row.
- **While the keyboard is open** (`kb.compact`): the card's main text one step smaller (the meaning and the Chinese of a sentence h5 -> h6, the
  sentence of Spell's sentence layout h6 -> subtitle1), and a translation line (`#h5-learn-sentence-zh`, Fill the gap's Chinese) kept to two lines
  (`-webkit-line-clamp`); when it is cut it is a `role="button"` with `aria-expanded`, a tap shows all of it and another folds it, without taking
  the field's focus.
- **Sound**: one row of icon buttons (`.h5-learn-audio`): Hear it / Play (named "Playing 1 of 2" while it plays), Stop (disabled while nothing
  plays) and Play slowly, each a 44px target with aria-label and title, keeping the field's focus. **Show first letter** is a hint (bulb) icon
  button in the action row, next to "I don't know" (Spell) or at its start (Fill the gap). A computer keeps the text buttons.
- **Letter keyboard**: the original four rows (`qwertyuiop` / `asdfghjkl` / Shift `zxcvbnm` Backspace / `'` `-` Hide), the same on a phone and a larger touch screen. A three-row variant with Hide in the actions was tried in v2.164.0 and taken back.
- **Never cut by the actions**: the page scrolls, and the field with the focus is kept whole above the pinned actions (`revealInPage`): when a field
  gets the focus and whenever the page or its content changes size (the keyboard opens, a result appears), the page scrolls just enough for the
  whole answer box (the letter slots, the practice row, a text field with its label such as "Copy it once").
- Measured at 390x844 with the keyboard open: the content area above the pinned actions is about 66% of the screen (the test asks for 45%).

## Tests

- Compact practice on a phone: `scripts/test-h5-learn-practice-browser.cjs` (one-line 56px header, three rows of 44px keys, Hide in the
  actions, the content area at least 45% of 390x844 with the keyboard open; `learn-practice-compact.png`), `test-h5-learn-browser.cjs` (the
  phone letter layout, Hide keyboard, Show first letter in the actions, the audio row of 44px icons with Stop disabled when idle),
  `test-h5-learn-coach-browser.cjs` (the series header on one line, "Back to chat"), `test-h5-learn-pace-browser.cjs` (the tag in the card's
  corner, "Copy it once" whole above the actions), `test-h5-learn-pick-browser.cjs` (subtitle1 sentence, the translation clamped to two lines).
- `scripts/test-h5-learn-practice-browser.cjs` (mocked `/api/learn`; 390x844 touch with the page keyboard and 1440x900): "Type it yourself" after
  a right answer, a wrong one, I don't know in the sentence layout and a phrase (its space by itself); the focus in the row, `inputmode="none"`,
  the keyboard open, the row above the keyboard and the pinned grades, the slot size of the answer; a right letter kept, a wrong key in its slot in
  the error colour and not kept with "Not that letter", Backspace, the count ("Typed right 1 time", polite status, success colour) and the empty
  row after it, nothing sent; the grades tapped; on a computer the row between the result and the grades with the keys' line, letters never
  grading, 2 and 3 grading, Enter taking the offered grade, Review using the row; an input method through CDP (`Input.imeSetComposition` /
  `insertText`) in the answer field and in the row (pinyin letters count, the Chinese dropped, a wrong composed letter flashing), Enter's
  committed letters, WeType-like dispatched events (the keys' `code`), the notice (text, `role`, above the letters, once per session, OK keeping
  the focus); the Mac app's `tagentInputSource` stubbed: `english` on the focus, `restore` on blur, nothing between the answer and the row, no
  notice, `restore` when Learn closes; nothing posted outside the app. `H5_SHOT_DIR` saves `learn-practice-phone.png`,
  `learn-practice-wrong-key.png`, `learn-practice-desktop.png`, `learn-practice-ime.png`. Unit: `test/h5-learn-practice.test.js` (the row's state,
  apostrophes, hyphens and phrases, `textChanges`, the composition letters for Pinyin / Sogou / WeType-like input, `cleanTyped`, the Mac bridge,
  `exerciseKey` in the row).

## Letter boxes by syllable (v2.168.1)

The underlines of the sentence layout's gap are grouped by the word's syllables (`gapLayout(word, parts)` in `learn-model.mjs`, `SentenceGap` in `Learn.jsx`): the `parts` of `partsOf` (the card's own from the translator when they give the word back, else the rough vowel-group split) put a wider space (0.7em, 0.4em for a long word) before each part after the first; the gap stays within 12em. `data-parts` has the count of parts and `data-part-start` marks the first underline of each part. Every spelled word has it, not only a leech word; the plain Spell layout has no letter boxes, so it is unchanged. Since 2026-11-27 Fill the gap draws its gap the same way (`GapSlots` in `Learn.jsx`, `partsOf` of the gap word), with the typed letters in the slots; see "Fill the gap" in [learn-english-page.md](learn-english-page.md).

## Backfill of older words

On the computer that keeps your Learn data, run these commands from the matching T-Agent checkout. The script uses the usual data directory
(`TAGENT_HOME` or `T_AGENT_DATA_DIR`), the single user and that user's translation model.

```sh
node scripts/learn-sentences-backfill.js
node scripts/learn-sentences-backfill.js --apply
```

The first command previews the groups, cards and a few words. The second asks before saving. Use `--limit N` for a smaller batch,
`--delay-ms N` to change the pause between model calls (800 ms by default), `--owner NAME` to choose a different owner, or `--yes`
to skip the prompt. The script puts cards still being learned or due ahead of other learned cards. It keeps the original sentence on
the keeper. You can stop and rerun it. The three-failure cutoff leaves unfinished cards for a later run.

The script uses SQLite's guarded card update and the normal Learn sync stamps. A preview can run alongside the server. Stop the server
for apply so the two processes do not allocate overlapping Learn sync change numbers. After the server starts again, linked peers get
the new sentences at the next Learn sync.
