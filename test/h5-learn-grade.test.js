// Grading of the Learn page (scripts/h5-shell/learn-grade.mjs): the word-by-word diff, its tolerance, the mistakes it names, the letter check of a
// spelled word and the grade it offers. See "Grading" in docs/design/learn-english-page.md.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../scripts/h5-shell/learn-grade.mjs');
const SENTENCE = 'Please fix the login redirect loop after the session cookie expires.';
const kinds = result => result.hints.map(hint => hint.kind);

test('words are compared without case, extra spaces or the punctuation around them', async () => {
  const { diffWords, normWord, wordsOf, sameSentence } = await load();
  assert.equal(normWord('"Expires."'), 'expires');
  assert.equal(normWord('don’t'), "don't", 'a curly apostrophe is the straight one');
  assert.equal(normWord('re-run,'), 're-run', 'inner hyphens stay');
  assert.deepEqual(wordsOf('  Hello ,  world! ').map(word => word.text), ['Hello', 'world'], 'a lone comma is no word');
  const result = diffWords(SENTENCE, '  please FIX the login   redirect loop after the session cookie expires ');
  assert.equal(result.correct, true);
  assert.equal(result.right, 11);
  assert.equal(result.total, 11);
  assert.deepEqual(result.hints, []);
  assert.equal(sameSentence('It works.', 'it works'), true);
  assert.equal(sameSentence('It works.', 'it work'), false);
});

test('the diff marks a replaced word, a missing word and an extra word, in the order of the sentence', async () => {
  const { diffWords } = await load();
  const result = diffWords(SENTENCE, 'Please fix the login redirect loop after the session cookie expire.');
  assert.equal(result.correct, false);
  assert.equal(result.right, 10);
  assert.deepEqual(result.ops.at(-1), { type: 'wrong', expected: 'expires', answer: 'expire' });
  assert.equal(result.ops.filter(op => op.type === 'same').length, 10);

  const missing = diffWords('Run the tests again', 'Run tests again');
  assert.deepEqual(missing.ops.map(op => op.type), ['same', 'missing', 'same', 'same']);
  assert.equal(missing.ops[1].expected, 'the');

  const extra = diffWords('Run tests again', 'Run all the tests again');
  assert.deepEqual(extra.ops.map(op => op.type), ['same', 'extra', 'extra', 'same', 'same']);
  assert.equal(extra.right, 3);
  assert.equal(extra.correct, false, 'extra words make it wrong even when every expected word is there');

  const empty = diffWords('Run tests', '');
  assert.deepEqual(empty.ops.map(op => op.type), ['missing', 'missing']);
  assert.equal(empty.right, 0);
});

test('articles: missing, not needed, or the wrong one', async () => {
  const { diffWords } = await load();
  assert.deepEqual(kinds(diffWords('Open the file', 'Open file')), ['article-missing']);
  assert.deepEqual(kinds(diffWords('Restart the server', 'Restart the the server')), ['article-extra']);
  assert.deepEqual(kinds(diffWords('Write a test', 'Write test')), ['article-missing']);
  const wrong = diffWords('It is an error', 'It is a error');
  assert.deepEqual(kinds(wrong), ['article-wrong']);
  assert.deepEqual([wrong.hints[0].word, wrong.hints[0].other], ['an', 'a']);
});

test('a missing -s is a third person -s after a subject and before an object, and a plural -s after a determiner or number', async () => {
  const { diffWords } = await load();
  assert.deepEqual(kinds(diffWords(SENTENCE, SENTENCE.replace('expires', 'expire'))), ['third-person'], 'the last word after a noun is the verb');
  assert.deepEqual(kinds(diffWords('It returns the value', 'It return the value')), ['third-person'], 'after "it"');
  assert.deepEqual(kinds(diffWords('The user clicks the button', 'The user click the button')), ['third-person'], 'before "the"');
  assert.deepEqual(kinds(diffWords('The build fails', 'The build fail')), ['third-person'], 'a noun phrase that starts the sentence');
  assert.deepEqual(kinds(diffWords('Fix the login tests', 'Fix the login test')), ['plural'], 'a noun phrase after a verb');
  assert.deepEqual(kinds(diffWords('Delete two files', 'Delete two file')), ['plural'], 'after a number');
  assert.deepEqual(kinds(diffWords('Fix the tests now', 'Fix the test now')), ['plural'], 'after "the"');
  assert.deepEqual(kinds(diffWords('Fix these bugs', 'Fix these bug')), ['plural']);
  assert.deepEqual(kinds(diffWords('Add new entries', 'Add new entry')), ['plural'], '-ies and -y');
  assert.deepEqual(kinds(diffWords('Fix the box', 'Fix the boxes')), ['plural'], 'an -s too many');
  const extra = diffWords('Fix the box', 'Fix the boxes').hints[0];
  assert.equal(extra.extra, true);
});

test('past tense -ed, a spelling slip, and the word order', async () => {
  const { diffWords } = await load();
  assert.deepEqual(kinds(diffWords('I fixed the bug yesterday', 'I fix the bug yesterday')), ['past-tense']);
  assert.deepEqual(kinds(diffWords('We tried again', 'We try again')), ['past-tense'], '-ied and -y');
  assert.deepEqual(kinds(diffWords('The build stopped', 'The build stop')), ['past-tense'], 'a doubled consonant');
  assert.deepEqual(kinds(diffWords('Check the configuration', 'Check the configuratoin')), ['spelling']);
  assert.deepEqual(kinds(diffWords('Check the log', 'Check the dog')), [], 'a short word is not called a slip');
  const order = diffWords('Please fix the login loop now', 'Please fix the loop login now');
  assert.ok(kinds(order).includes('order'));
  assert.equal(order.correct, false);
  const moved = diffWords(SENTENCE, 'Please fix the login redirect loop the session cookie expires after');
  assert.deepEqual(kinds(moved), ['order']);
  assert.equal(moved.hints[0].word, 'after');
});

test('every hint has an English template for the page to translate', async () => {
  const { hintText } = await load();
  assert.deepEqual(hintText({ kind: 'third-person', word: 'expires' }), ['"{1}": third person -s', 'expires']);
  assert.deepEqual(hintText({ kind: 'plural', word: 'box', extra: true }), ['"{1}": no plural -s here', 'box']);
  assert.deepEqual(hintText({ kind: 'article-wrong', word: 'an', other: 'a' }), ['"{1}", not "{2}"', 'an', 'a']);
  assert.deepEqual(hintText({ kind: 'order', word: '' }), ['Word order']);
  for (const kind of ['article-missing', 'article-extra', 'past-tense', 'spelling']) assert.match(hintText({ kind, word: 'x' })[0], /\{1\}/);
});

test('a spelled word is checked letter by letter, case aside', async () => {
  const { spellCheck } = await load();
  const right = spellCheck('expire', 'Expire ');
  assert.equal(right.ok, true);
  assert.equal(right.right, 6);
  const wrong = spellCheck('expire', 'expier');
  assert.equal(wrong.ok, false);
  assert.deepEqual(wrong.letters.map(letter => letter.ok), [true, true, true, true, false, false]);
  assert.equal(wrong.letters[4].typed, 'e');
  const short = spellCheck('expire', 'exp');
  assert.equal(short.letters[5].typed, '');
  assert.equal(short.right, 3);
});

test('the offered grade: Good when right, Hard when right with help, Again when wrong', async () => {
  const { suggestedGrade } = await load();
  assert.equal(suggestedGrade({ correct: true }), 'good');
  assert.equal(suggestedGrade({ correct: true, helped: true }), 'hard');
  assert.equal(suggestedGrade({ correct: false, helped: true }), 'again');
});

test('edit distance', async () => {
  const { editDistance } = await load();
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('', 'abc'), 3);
  assert.equal(editDistance('same', 'same'), 0);
});

test('the automatic check: when the typed letters reach the length of the word (spaces, case and a curly apostrophe do not count)', async () => {
  const { typedInFull, AUTO_CHECK_MS } = await load();
  assert.equal(AUTO_CHECK_MS, 300);
  assert.equal(typedInFull('expir', 'expire'), false, 'a shorter answer waits for Check');
  assert.equal(typedInFull('expire', 'expire'), true);
  assert.equal(typedInFull('EXPIRE', 'expire'), true);
  assert.equal(typedInFull('expira', 'expire'), true, 'a wrong last letter is checked too');
  assert.equal(typedInFull(' exp ire ', 'expire'), true);
  assert.equal(typedInFull('wasn’t', "wasn't"), true);
  assert.equal(typedInFull('trade-off', 'trade-off'), true);
  assert.equal(typedInFull('', ''), false);
});
