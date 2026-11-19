// The rules of the Learn page (scripts/h5-shell/learn-model.mjs): modes, tiles, the gap, the estimate, a mixed session and the keys of a computer.
// See "The Learn page" in docs/design/learn-english-page.md.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../scripts/h5-shell/learn-model.mjs');
const card = (id, en, kind = 'sentence') => ({ id, kind, en, zh: '' });

test('the modes, and the ones a browser without speech output or voice input offers', async () => {
  const { MODES, availableModes, exerciseOf } = await load();
  assert.deepEqual(MODES.map(mode => mode.id), ['spell', 'build', 'dictation', 'say', 'fill']);
  assert.deepEqual(availableModes({ tts: true, voice: true }).map(mode => mode.id), ['spell', 'build', 'dictation', 'say', 'fill']);
  assert.deepEqual(availableModes({ tts: false, voice: false }).map(mode => mode.id), ['spell', 'build', 'fill']);
  assert.deepEqual(availableModes({ tts: true }).map(mode => mode.id), ['spell', 'build', 'dictation', 'fill']);
  assert.equal(exerciseOf(card(1, 'w', 'word'), 'review'), 'spell');
  assert.equal(exerciseOf(card(2, 'a b c'), 'review'), 'build');
  assert.equal(exerciseOf(card(2, 'a b c'), 'mistakes'), 'build');
  assert.equal(exerciseOf(card(2, 'a b c'), 'dictation'), 'dictation');
});

test('the estimate and the goal', async () => {
  const { minutesFor, goalProgress } = await load();
  assert.equal(minutesFor(18), 6);
  assert.equal(minutesFor(1), 1);
  assert.equal(minutesFor(0), 0);
  assert.equal(goalProgress(7, 20), 0.35);
  assert.equal(goalProgress(30, 20), 1);
  assert.equal(goalProgress(3, 0), 0);
});

test('tiles: every word of the sentence plus a few distractors from other sentences, shuffled the same way each time', async () => {
  const { tilesFor, builtAnswer } = await load();
  const main = card(7, 'Please fix the login redirect loop after the session cookie expires.');
  const others = [card(8, 'Deploy the staging server tonight.'), card(9, 'Update the README file.'), card(10, 'word', 'word')];
  const tiles = tilesFor(main, others);
  const own = tiles.filter(tile => !tile.distractor).map(tile => tile.text).sort();
  assert.deepEqual(own, ['Please', 'after', 'cookie', 'expires', 'fix', 'login', 'loop', 'redirect', 'session', 'the', 'the'].sort());
  const distractors = tiles.filter(tile => tile.distractor).map(tile => tile.text);
  assert.equal(distractors.length, 3);
  for (const word of distractors) assert.ok(['Deploy', 'staging', 'server', 'tonight', 'Update', 'README', 'file'].includes(word), word);
  assert.deepEqual(tilesFor(main, others), tiles, 'the same order for the same card');
  assert.deepEqual(tiles.map(tile => tile.id), tiles.map((_, index) => index));
  assert.notDeepEqual(tiles.filter(tile => !tile.distractor).map(tile => tile.text), main.en.replace('.', '').split(' '), 'shuffled');
  assert.equal(tilesFor(main, []).length, 11, 'no other cards: no distractors');
  const placed = ['Please', 'fix'].map(text => tiles.find(tile => tile.text === text).id);
  assert.equal(builtAnswer(tiles, placed, ' the login '), 'Please fix the login');
  assert.equal(builtAnswer(tiles, [], ''), '');
});

test('the hint of Build the sentence is the next word in order, and nothing while a wrong tile is placed', async () => {
  const { tilesFor, hintTile } = await load();
  const main = card(3, 'Run the tests again');
  const tiles = tilesFor(main, []);
  const id = text => tiles.find(tile => tile.text === text).id;
  assert.equal(tiles[hintTile(main, tiles, [])].text, 'Run');
  assert.equal(tiles[hintTile(main, tiles, [id('Run')])].text, 'the');
  assert.equal(hintTile(main, tiles, [id('tests')]), null, 'a wrong first tile');
  assert.equal(hintTile(main, tiles, [id('Run'), id('the'), id('tests'), id('again')]), null, 'complete');
});

test('the gap is one content word, the same for a card, with the punctuation outside it', async () => {
  const { gapFor } = await load();
  const main = card(11, 'Please fix the login redirect loop after the session cookie expires.');
  const gap = gapFor(main);
  assert.ok(['fix', 'login', 'redirect', 'loop', 'after', 'session', 'cookie', 'expires'].includes(gap.word), gap.word);
  assert.equal(gap.before + gap.word + gap.after, main.en);
  assert.deepEqual(gapFor(main), gap);
  const end = gapFor(card(1, 'it is expires.'));
  assert.deepEqual(end, { word: 'expires', before: 'it is ', after: '.' });
  assert.equal(gapFor(card(2, 'it is a an')), null, 'no content word');
});

test('the context of a word card hides the word', async () => {
  const { maskedContext } = await load();
  assert.equal(maskedContext({ en: 'expire', context: 'after the session cookie expires' }), 'after the session cookie ___');
  assert.equal(maskedContext({ en: 'expire', context: '' }), '');
  assert.equal(maskedContext({ en: 'a+b', context: 'x a+b y' }), 'x ___ y', 'regular expression characters in the word');
});

test('a mixed session takes words and sentences in turn, without repeats, up to the limit', async () => {
  const { mixCards } = await load();
  const words = [card(1, 'a', 'word'), card(2, 'b', 'word'), card(3, 'c', 'word')];
  const sentences = [card(4, 'x y z'), card(1, 'a', 'word')];
  assert.deepEqual(mixCards([words, sentences], 10).map(item => item.id), [1, 4, 2, 3]);
  assert.deepEqual(mixCards([words, sentences], 2).map(item => item.id), [1, 4]);
  assert.deepEqual(mixCards([[], null], 5), []);
});

test('the keys of a computer: Enter checks and then continues, 1 / 2 / 3 grade only a checked answer', async () => {
  const { exerciseKey } = await load();
  assert.deepEqual(exerciseKey({ key: 'Enter', checked: false }), { action: 'check' });
  assert.deepEqual(exerciseKey({ key: 'Enter', checked: true }), { action: 'grade' });
  assert.deepEqual(exerciseKey({ key: '1', checked: true }), { action: 'grade', grade: 'again' });
  assert.deepEqual(exerciseKey({ key: '2', checked: true }), { action: 'grade', grade: 'hard' });
  assert.deepEqual(exerciseKey({ key: '3', checked: true }), { action: 'grade', grade: 'good' });
  assert.equal(exerciseKey({ key: '3', checked: false }), null, 'typing a digit in an answer');
  assert.equal(exerciseKey({ key: '3', checked: true, inField: true }), null);
  assert.equal(exerciseKey({ key: 'Enter', checked: false, modifiers: true }), null);
  assert.equal(exerciseKey({ key: 'x', checked: true }), null);
});
