// "Type it yourself" after a Spell answer (pure functions, no DOM): empty slots of the right word that the person fills letter by letter. A right
// letter stays, a wrong key is shown for a moment in its slot and not kept, Backspace takes the last kept letter back, and the word typed in full
// counts one round ("Typed right 2 times") before the row empties for the next. Not graded and never sent. Case does not matter, a curly apostrophe
// or a dash counts as the straight one, and a space of a phrase is filled in by itself (the letter keyboard has no Space). See "Type it yourself" in
// docs/design/learn-spell-practice.md.

// How long a wrong key stays in its slot, and how long the full word stays before the row empties.
export const PRACTICE_FLASH_MS = 400;
export const PRACTICE_ROUND_MS = 600;

const unify = ch => String(ch || '').replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u2010-\u2014\u2212]/g, '-').toLowerCase();
// The characters filled in by themselves: spaces (a phrase).
export const autoChar = ch => /\s/.test(ch);
const skipAuto = (letters, at) => {
  let next = at;
  while (next < letters.length && autoChar(letters[next])) next += 1;
  return next;
};

// A new row for `word`. `kept`: how many characters of the word are typed; `flash`: the wrong key shown now ({ at, ch }); `done`: the word is
// complete (the row shows it until the next round); `note`: the line under the row (idle, wrong: "Not that letter", again: "Again? Just keep typing").
export function practiceStart(word, count = 0) {
  const letters = [...String(word || '').trim()];
  return { letters, kept: skipAuto(letters, 0), count, flash: null, done: false, note: 'idle' };
}

// The row after one key: a single character, or 'Backspace'. Anything else (Shift, a space) changes nothing.
export function practiceKey(state, key) {
  if (!state || !state.letters.length) return state;
  if (key === 'Backspace') {
    if (state.done) return practiceNewRound(state);
    let at = state.kept;
    while (at > 0 && autoChar(state.letters[at - 1])) at -= 1;
    return { ...state, kept: Math.max(0, at - 1), flash: null, note: 'idle' };
  }
  const ch = String(key || '');
  if ([...ch].length !== 1 || autoChar(ch)) return state;
  const base = state.done ? practiceNewRound(state) : state;
  if (unify(ch) === unify(base.letters[base.kept])) {
    const kept = skipAuto(base.letters, base.kept + 1);
    const done = kept >= base.letters.length;
    return { ...base, kept, flash: null, done, count: base.count + (done ? 1 : 0), note: done ? 'again' : 'idle' };
  }
  return { ...base, flash: { at: base.kept, ch }, note: 'wrong' };
}

// The wrong key goes from its slot (the note stays until the next right key).
export const practiceClearFlash = state => (state.flash ? { ...state, flash: null } : state);

// The next round: the slots empty again, the count kept.
export const practiceNewRound = state => ({ ...state, kept: skipAuto(state.letters, 0), done: false, flash: null });

// What the row's field holds: the characters typed so far (the field is a hidden input over the slots).
export const practiceText = state => state.letters.slice(0, state.kept).join('');

// Each slot: { ch, kind } with kind kept (a right letter), flash (the wrong key now), caret (the next one), auto (a space) or empty.
export function practiceSlots(state) {
  return state.letters.map((ch, at) => {
    if (autoChar(ch)) return { ch: '', kind: 'auto' };
    if (at < state.kept) return { ch, kind: 'kept' };
    if (state.flash && state.flash.at === at) return { ch: state.flash.ch, kind: 'flash' };
    if (at === state.kept && !state.done) return { ch: '', kind: 'caret' };
    return { ch: '', kind: 'empty' };
  });
}

// How a field's text changed: the characters taken away at the end and the ones added after the common start (the page's keyboard, typing and an
// input method all come as a new text).
export function textChanges(before, after) {
  const a = [...String(before || '')];
  const b = [...String(after || '')];
  let same = 0;
  while (same < a.length && same < b.length && a[same] === b[same]) same += 1;
  return { back: a.length - same, add: b.slice(same) };
}

// Apply a changed text to the row: Backspace for each character taken away, then each added character as a key.
export function practiceChange(state, before, after) {
  const { back, add } = textChanges(before, after);
  let next = state;
  for (let i = 0; i < back; i += 1) next = practiceKey(next, 'Backspace');
  for (const ch of add) next = practiceKey(next, ch);
  return next;
}
