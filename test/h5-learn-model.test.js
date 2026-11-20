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

test('the letter slots of Spell stay on one line, shrinking together; a longer word wraps in rows of even length', async () => {
  const { slotLayout, SLOT, SLOT_MIN } = await load();
  const width = layout => layout.rows[0] * layout.slot + (layout.rows[0] - 1) * layout.gap;
  assert.deepEqual(slotLayout(6, 358), { slot: SLOT, gap: 8, font: 24, height: 44, rows: [6] }, 'a short word: the normal size');
  const sixteen = slotLayout(16, 358); // a 16-letter word on a 390px phone
  assert.deepEqual(sixteen.rows, [16]);
  assert.ok(sixteen.slot >= SLOT_MIN && sixteen.font >= 14 && width(sixteen) <= 358, JSON.stringify(sixteen));
  const narrow = slotLayout(16, 288); // a 320px phone: too long for the smallest slots, so two even rows
  assert.deepEqual(narrow.rows, [8, 8]);
  assert.ok(width(narrow) <= 288 && narrow.slot >= SLOT_MIN);
  assert.deepEqual(slotLayout(17, 288).rows, [9, 8], 'never one letter alone');
  for (const n of [1, 5, 12, 20, 25, 33, 40]) {
    for (const w of [240, 288, 358, 600]) {
      const layout = slotLayout(n, w);
      assert.equal(layout.rows.reduce((a, b) => a + b, 0), n);
      assert.ok(Math.max(...layout.rows) - Math.min(...layout.rows) <= 1, 'even rows');
      assert.ok(width(layout) <= w + 0.01, `${n} at ${w}: ${JSON.stringify(layout)}`);
      assert.ok(layout.slot <= SLOT && layout.font >= 14);
    }
  }
  assert.deepEqual(slotLayout(10, 0).rows, [10], 'before the width is known: one line');
});

test('a word is found in a sentence as a whole word, whatever the case, with curly apostrophes and dashes', async () => {
  const { findWholeWord } = await load();
  assert.equal(findWholeWord('The session cookie expires after thirty minutes.', 'expires'), 19);
  assert.equal(findWholeWord('Expires soon', 'expires'), 0, 'case does not count');
  assert.equal(findWholeWord('It expired, then it expires.', 'expires'), 20, 'the first whole match');
  assert.equal(findWholeWord('The session\u2019s cookie', 'session'), -1, "not inside session's");
  assert.equal(findWholeWord('All sessions end', 'session'), -1, 'not inside a longer word');
  assert.equal(findWholeWord('Please log-in again', 'log'), -1, 'not inside a hyphenated word');
  assert.equal(findWholeWord("We don\u2019t merge", "don't"), 3, 'a curly apostrophe matches the straight one');
  assert.equal(findWholeWord("It says 'expires' here", 'expires'), 9, 'a quote is not a joiner');
  assert.equal(findWholeWord('re-run the tests', 're-run'), 0);
  assert.equal(findWholeWord('expire', 'expires'), -1);
  assert.equal(findWholeWord('anything', ''), -1);
});

test('Spell asks a word inside its sentence only with the Chinese of the sentence and the word found in it', async () => {
  const { sentenceGap } = await load();
  const zh = '\u4f1a\u8bdd cookie \u4e09\u5341\u5206\u949f\u540e\u8fc7\u671f\u3002';
  const word = extra => ({ id: 1, kind: 'word', en: 'expires', zh: 'x', source: 'translation', context: 'The session cookie expires after thirty minutes, so please log in again.', context_zh: zh, ...extra });
  assert.deepEqual(sentenceGap(word()), { before: 'The session cookie ', word: 'expires', after: ' after thirty minutes, so please log in again.', zh });
  // The punctuation around the word stays outside the gap; the word keeps the case of the sentence.
  assert.deepEqual(sentenceGap(word({ context: 'Expires, then logs out.' })), { before: '', word: 'Expires', after: ', then logs out.', zh });
  assert.deepEqual(sentenceGap(word({ en: 'API', context: 'Call the "API".' })), { before: 'Call the "', word: 'API', after: '".', zh });
  const one = sentenceGap(word({ context: '  It expires.  ' }));
  assert.equal(one.before + one.word + one.after, 'It expires.', 'the context is trimmed');
  assert.equal(sentenceGap(word({ context_zh: '' })), null, 'no Chinese of the sentence: the meaning layout');
  assert.equal(sentenceGap(word({ context_zh: undefined })), null, 'an older server without the field');
  assert.equal(sentenceGap(word({ context: 'Programmer English' })), null, 'the word is not in its context (a starter list title)');
  assert.equal(sentenceGap(word({ context: 'It expired yesterday.' })), null, 'another form is not the word');
  assert.equal(sentenceGap(word({ en: '' })), null);
  assert.equal(sentenceGap(word({ kind: 'sentence' })), null, 'sentences are never asked this way');
  assert.equal(sentenceGap(null), null);
});

test('the notes of MY LEVEL and WORDS FROM MY TRANSLATIONS', async () => {
  const { levelNote, pickedNote, shortDateTime } = await load();
  const updated = new Date(2026, 10, 21, 9, 5).toISOString();
  const report = new Date(2026, 10, 16, 23, 30).toISOString();
  assert.equal(shortDateTime(updated), '11-21 09:05', 'in the browser time zone');
  assert.equal(shortDateTime(''), '');
  assert.equal(shortDateTime('not a date'), '');
  assert.deepEqual(levelNote({ level: 'B1', answers: 155, mistakes: 43, report_at: report, updated_at: updated }), [
    { template: 'From {1} answers, {2} mistakes and the report of {3}', values: [155, 43, '11-16'] },
    { template: 'updated {1}', values: ['11-21 09:05'] },
  ]);
  assert.deepEqual(levelNote({ level: 'A2', answers: 3, mistakes: 0, report_at: null, updated_at: updated }), [
    { template: 'From {1} answers and {2} mistakes', values: [3, 0] },
    { template: 'updated {1}', values: ['11-21 09:05'] },
  ]);
  assert.deepEqual(levelNote({ level: 'C1' }), [{ template: 'From {1} answers and {2} mistakes', values: [0, 0] }], 'no time: no "updated"');
  assert.deepEqual(levelNote(null), []);
  assert.deepEqual(pickedNote({ enabled: true, picked: 57, skipped: 12, sentences: 91, pending: 0, running: false }), [
    { template: '{1} words from {2} sentences', values: [57, 91] },
    { template: '{1} skipped (you know them)', values: [12] },
  ]);
  assert.deepEqual(pickedNote({ picked: 4, skipped: 0, sentences: 10, pending: 6 }).map(part => part.template).pop(), '{1} waiting');
  assert.deepEqual(pickedNote({ picked: 'x', sentences: -2 })[0].values, [0, 0], 'bad numbers read as 0');
  assert.deepEqual(pickedNote(null), []);
});
