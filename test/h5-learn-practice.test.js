// "Type it yourself" after a Spell answer (scripts/h5-shell/learn-practice.mjs) and English input while spelling (scripts/h5-shell/learn-input.mjs):
// the practice row's state, the letters of an input method's composition and the Mac app's input source messages. See "Type it yourself" and
// "English input" in docs/design/learn-spell-practice.md.
const test = require('node:test');
const assert = require('node:assert/strict');

const practice = () => import('../scripts/h5-shell/learn-practice.mjs');
const input = () => import('../scripts/h5-shell/learn-input.mjs');
const typeAll = (step, state, keys) => [...keys].reduce(step, state);
// Chinese text an input method commits (escaped: the source stays English, see test/i18n.test.js).
const NE = '\u5462';
const NIHAO = '\u4f60\u597d';

test('a right letter stays, a wrong key flashes and is not kept, the full word counts a round', async () => {
  const { practiceStart, practiceKey, practiceSlots, practiceText, practiceClearFlash, practiceNewRound } = await practice();
  let state = practiceStart('necessary');
  assert.deepEqual(practiceSlots(state).map(slot => slot.kind), ['caret', 'empty', 'empty', 'empty', 'empty', 'empty', 'empty', 'empty', 'empty']);
  state = typeAll(practiceKey, state, 'nec');
  assert.equal(practiceText(state), 'nec');
  assert.equal(state.note, 'idle');
  state = practiceKey(state, 'a');
  assert.equal(practiceText(state), 'nec', 'a wrong key is not kept');
  assert.deepEqual(state.flash, { at: 3, ch: 'a' });
  assert.equal(state.note, 'wrong');
  assert.deepEqual(practiceSlots(state).slice(2, 5), [{ ch: 'c', kind: 'kept' }, { ch: 'a', kind: 'flash' }, { ch: '', kind: 'empty' }]);
  state = practiceClearFlash(state);
  assert.equal(state.flash, null);
  assert.equal(state.note, 'wrong', 'the note stays until the next right key');
  state = practiceKey(state, 'E');
  assert.equal(practiceText(state), 'nece', 'case does not matter');
  assert.equal(state.note, 'idle');
  state = practiceKey(state, 'Backspace');
  assert.equal(practiceText(state), 'nec');
  state = typeAll(practiceKey, state, 'essary');
  assert.equal(state.done, true);
  assert.equal(state.count, 1);
  assert.equal(state.note, 'again');
  assert.ok(practiceSlots(state).every(slot => slot.kind === 'kept'));
  state = practiceNewRound(state);
  assert.equal(practiceText(state), '');
  assert.equal(state.count, 1, 'the count stays');
  state = typeAll(practiceKey, state, 'necessary');
  assert.equal(state.count, 2);
  // A key while the full word is still shown starts the next round with it.
  state = practiceKey(state, 'n');
  assert.equal(practiceText(state), 'n');
  assert.equal(state.done, false);
});

test('keys that are not one character, Shift and a space change nothing; Backspace at the start stays there', async () => {
  const { practiceStart, practiceKey, practiceText } = await practice();
  const start = practiceStart('code');
  assert.equal(practiceKey(start, 'Shift'), start);
  assert.equal(practiceKey(start, ' '), start);
  assert.equal(practiceText(practiceKey(start, 'Backspace')), '');
  assert.equal(practiceStart('').letters.length, 0);
  assert.deepEqual(practiceKey(practiceStart(''), 'a').letters, []);
});

test('apostrophes and hyphens are typed, a curly one matches the straight key, a space of a phrase fills in by itself', async () => {
  const { practiceStart, practiceKey, practiceText, practiceSlots } = await practice();
  let state = typeAll(practiceKey, practiceStart('don\u2019t'), "don't");
  assert.equal(state.done, true);
  state = typeAll(practiceKey, practiceStart('follow-up'), 'follow-up');
  assert.equal(state.done, true);
  state = typeAll(practiceKey, practiceStart('look up'), 'look');
  assert.equal(practiceText(state), 'look ', 'the space comes by itself');
  assert.deepEqual(practiceSlots(state).slice(3, 6).map(slot => slot.kind), ['kept', 'auto', 'caret']);
  state = practiceKey(state, 'Backspace');
  assert.equal(practiceText(state), 'loo', 'Backspace takes the letter before the space');
  state = typeAll(practiceKey, state, 'kup');
  assert.equal(state.done, true);
});

test('a changed field text becomes keys: added letters, Backspace, a replaced end', async () => {
  const { practiceStart, practiceChange, practiceText, textChanges } = await practice();
  assert.deepEqual(textChanges('nec', 'nece'), { back: 0, add: ['e'] });
  assert.deepEqual(textChanges('nec', 'ne'), { back: 1, add: [] });
  assert.deepEqual(textChanges('nec', 'nex'), { back: 1, add: ['x'] });
  let state = practiceStart('incident');
  state = practiceChange(state, '', 'ins');
  assert.equal(practiceText(state), 'in', 'the wrong s is not kept');
  state = practiceChange(state, 'ins', 'insc');
  assert.equal(practiceText(state), 'inc');
  state = practiceChange(state, 'inc', 'in');
  assert.equal(practiceText(state), 'in');
});

test('the Latin letters of a composition: pinyin, separators, full width, a committed Chinese word', async () => {
  const { latinLetters, halfWidth, hasImeText, createComposer } = await input();
  assert.equal(latinLetters("ni'hao"), 'nihao');
  assert.equal(latinLetters('ni hao'), 'nihao');
  assert.equal(halfWidth('\uff4e\uff45'), 'ne');
  assert.equal(hasImeText(NE), true);
  assert.equal(hasImeText('caf\u00e9'), false, 'an accented letter is not input method text');
  // macOS Pinyin / Sogou: the pinyin is the composition, a space picks the Chinese word.
  let composer = createComposer('ex');
  assert.equal(composer.update('p'), 'exp');
  assert.equal(composer.update('pi'), 'expi');
  assert.equal(composer.update("pi'r"), 'expir');
  assert.equal(composer.end(NE), 'expir', 'the Chinese it would commit is dropped');
  // Enter commits the letters themselves.
  composer = createComposer('');
  composer.update('ne');
  assert.equal(composer.end('ne'), 'ne');
  // Backspace inside the composition.
  composer = createComposer('');
  composer.update('nex');
  assert.equal(composer.update('ne'), 'ne');
  assert.equal(composer.update(''), '');
  // A part already turned into Chinese (Sogou picks the first word): the letters seen are kept.
  composer = createComposer('');
  composer.update('nihao');
  assert.equal(composer.update(`${NIHAO.slice(0, 1)}hao`), 'nihao');
  assert.equal(composer.end(NIHAO), 'nihao');
  // In the middle of a word: the letters go where the caret was.
  composer = createComposer('nesary', 2, 2);
  assert.equal(composer.update('ces'), 'necessary');
});

test('an input method that shows Chinese at once (WeType-like): the letters of the keys pressed', async () => {
  const { createComposer, keyLetter, isImeKey } = await input();
  assert.equal(isImeKey({ key: 'Process', keyCode: 229 }), true);
  assert.equal(isImeKey({ isComposing: true, key: 'n' }), true);
  assert.equal(isImeKey({ key: 'n', keyCode: 78 }), false);
  assert.equal(keyLetter({ key: 'Process', code: 'KeyN' }), 'n');
  assert.equal(keyLetter({ key: 'Process', code: 'KeyN', shiftKey: true }), 'N');
  assert.equal(keyLetter({ key: 'Process', code: 'Space' }), '');
  assert.equal(keyLetter({ key: 'q', code: '' }), 'q');
  const composer = createComposer('', null, null, 'n');
  composer.key({ letter: 'e' });
  assert.equal(composer.update(NE), 'ne');
  composer.key({ letter: 'x' });
  composer.key({ back: true });
  assert.equal(composer.end(NE), 'ne');
});

test('a value changed by an input method without a composition: its text is dropped, the keys stand in for it', async () => {
  const { cleanTyped } = await input();
  assert.deepEqual(cleanTyped('ex'), { text: 'ex', ime: false });
  assert.deepEqual(cleanTyped(`ex${NE}`, 'pi'), { text: 'expi', ime: true });
  assert.deepEqual(cleanTyped(`${NE}x${NE}`, 'a'), { text: 'ax', ime: true });
  assert.deepEqual(cleanTyped(`ex${NE}`), { text: 'ex', ime: true });
  assert.deepEqual(cleanTyped('\uff45\uff58'), { text: 'ex', ime: false }, 'full-width letters become ASCII');
});

test('the Mac app input source: english on focus, restore a moment after the blur, once each, nothing outside the app', async () => {
  const { inputSourceBridge } = await input();
  const sent = [];
  const timers = [];
  const win = { webkit: { messageHandlers: { tagentInputSource: { postMessage: what => sent.push(what) } } } };
  const bridge = inputSourceBridge(win, { delay: 150, setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: id => { timers[id - 1] = null; } });
  assert.equal(bridge.available(), true);
  bridge.focus();
  bridge.focus();
  assert.deepEqual(sent, ['english'], 'once');
  bridge.blur();
  bridge.focus(); // the answer field to the practice row: no switch back in between
  timers.forEach(fn => fn && fn());
  assert.deepEqual(sent, ['english']);
  bridge.blur();
  timers.forEach(fn => fn && fn());
  assert.deepEqual(sent, ['english', 'restore']);
  bridge.focus();
  bridge.close();
  assert.deepEqual(sent, ['english', 'restore', 'english', 'restore']);
  const outside = inputSourceBridge({});
  assert.equal(outside.available(), false);
  outside.focus();
  outside.close();
  const broken = inputSourceBridge({ webkit: { messageHandlers: { tagentInputSource: { postMessage: () => { throw new Error('gone'); } } } } });
  assert.doesNotThrow(() => broken.focus());
});

test('exerciseKey: in the practice row letters are nothing, Enter takes the offered grade and 1 / 2 / 3 grade', async () => {
  const { exerciseKey } = await import('../scripts/h5-shell/learn-model.mjs');
  assert.equal(exerciseKey({ key: 'n', checked: true, inField: true, practice: true }), null);
  assert.equal(exerciseKey({ key: 'a', checked: true, inField: true, practice: true }), null);
  assert.deepEqual(exerciseKey({ key: 'Enter', checked: true, inField: true, practice: true }), { action: 'grade' });
  assert.deepEqual(exerciseKey({ key: '1', checked: true, inField: true, practice: true }), { action: 'grade', grade: 'again' });
  assert.deepEqual(exerciseKey({ key: '3', checked: true, inField: true, practice: true }), { action: 'grade', grade: 'good' });
  assert.equal(exerciseKey({ key: '1', checked: true, inField: true }), null, 'another field still types digits');
  assert.equal(exerciseKey({ key: '2', checked: true, inField: true, practice: true, modifiers: true }), null);
});
