# Spell: type it yourself and English input

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md). The Learn page itself (Spell the word, the page's
> own keyboard, the keys of a computer) is in [learn-english-page.md](learn-english-page.md); the Mac app's side of the input source switch is
> "English input while spelling" in [mac-app.md](mac-app.md).

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

## Tests

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
