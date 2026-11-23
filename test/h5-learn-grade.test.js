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

test('a wrong spelling is lined up under the right one by the closest match', async () => {
  const { alignSpelling, spellCheck } = await load();
  const row = (result, side) => result.columns.map(column => column[side] || '_').join('');
  const kinds = result => result.columns.map(column => column.kind[0]).join('');

  const incident = alignSpelling('incident', 'encedant');
  assert.equal(row(incident, 'want'), 'incident');
  assert.equal(row(incident, 'got'), 'encedant', 'the same length: by position');
  assert.equal(kinds(incident), 'wsswswss');
  assert.deepEqual([incident.different, incident.missing, incident.extra], [3, 0, 0]);

  const environment = alignSpelling('environment', 'enviroment');
  assert.equal(row(environment, 'want'), 'environment');
  assert.equal(row(environment, 'got'), 'enviro_ment', 'the missing n leaves its own column; the rest stays right');
  assert.equal(environment.columns[6].kind, 'missing');
  assert.equal(environment.columns[6].want, 'n');
  assert.deepEqual([environment.different, environment.missing, environment.extra], [0, 1, 0]);

  const writing = alignSpelling('writing', 'writtin');
  assert.equal(row(writing, 'want'), 'writ_ing');
  assert.equal(row(writing, 'got'), 'writtin_');
  assert.equal(kinds(writing), 'ssssessm');
  assert.deepEqual([writing.different, writing.missing, writing.extra], [0, 1, 1]);

  const cased = alignSpelling('Expire', ' eXPIRE ');
  assert.equal(kinds(cased), 'ssssss', 'case and spaces around aside');
  assert.equal(cased.columns[0].want, 'E', 'the word as written');
  assert.equal(cased.columns[1].got, 'X', 'the answer as typed');
  assert.deepEqual([cased.different, cased.missing, cased.extra], [0, 0, 0]);

  const empty = alignSpelling('cat', '');
  assert.equal(kinds(empty), 'mmm');
  assert.deepEqual([empty.different, empty.missing, empty.extra], [0, 3, 0]);
  assert.equal(alignSpelling('', 'ab').extra, 2);
  assert.deepEqual(alignSpelling('', '').columns, []);

  assert.equal(kinds(alignSpelling('ab', 'ba')), 'ww', 'a tie: by position, not an extra and a missing letter');
  assert.equal(spellCheck('incident', 'encedant').right, 5, 'the letter check itself is unchanged');
});

test('the line under a wrong spelling says what differs, in whole translated sentences', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { spellingNote } = await load();
  assert.equal(spellingNote({}), null);
  assert.deepEqual(spellingNote({ different: 3 }), { template: '{1} letters different', values: [3] });
  assert.deepEqual(spellingNote({ different: 1 }), { template: '1 letter different', values: [] });
  assert.deepEqual(spellingNote({ missing: 1 }), { template: '1 letter missing', values: [] });
  assert.deepEqual(spellingNote({ missing: 2 }), { template: '{1} letters missing', values: [2] });
  assert.deepEqual(spellingNote({ extra: 1 }), { template: '1 extra letter', values: [] });
  assert.deepEqual(spellingNote({ extra: 2 }), { template: '{1} extra letters', values: [2] });
  assert.deepEqual(spellingNote({ extra: 1, missing: 1 }), { template: '1 extra letter, {1} missing', values: [1] });
  assert.deepEqual(spellingNote({ different: 2, extra: 1, missing: 3 }), { template: '{1} letters different, {2} extra, {3} missing', values: [2, 1, 3] });
  const dictionary = fs.readFileSync(path.join(__dirname, '../public/js/i18n-zh-extra.js'), 'utf8');
  for (const different of [0, 1, 2]) {
    for (const extra of [0, 1, 2]) {
      for (const missing of [0, 1, 2]) {
        const note = spellingNote({ different, extra, missing });
        if (note) assert.ok(dictionary.includes(`'${note.template}':`), `a Chinese translation for "${note.template}"`);
      }
    }
  }
});

test('the offered grade: Good when right, Hard when right with help, Again when wrong', async () => {
  const { suggestedGrade } = await load();
  assert.equal(suggestedGrade({ correct: true }), 'good');
  assert.equal(suggestedGrade({ correct: true, helped: true }), 'hard');
  assert.equal(suggestedGrade({ correct: false, helped: true }), 'again');
  assert.equal(suggestedGrade({ correct: false, near: true }), 'hard', 'one letter off: Hard');
  assert.equal(suggestedGrade({ correct: true, near: true }), 'good');
});

test('one letter off: a wrong, missing, extra or swapped letter in a word of 4 letters or more', async () => {
  const { nearMiss, swapDistance } = await load();
  assert.equal(swapDistance('expire', 'expier'), 1, 'two adjacent letters swapped are one edit');
  assert.equal(swapDistance('kitten', 'sitting'), 3);
  assert.equal(nearMiss('extension', 'extention'), true, 'a wrong letter');
  assert.equal(nearMiss('environment', 'enviroment'), true, 'a missing letter');
  assert.equal(nearMiss('expire', 'expirez'), true, 'an extra letter');
  assert.equal(nearMiss('expire', 'expier'), true, 'two letters swapped');
  assert.equal(nearMiss('code', 'cdoe'), true, 'four letters are enough');
  assert.equal(nearMiss('Expire ', 'expirE'), false, 'the same word (case and spaces aside) is right, not almost');
  assert.equal(nearMiss('cat', 'cut'), false, 'a word of 3 letters is never almost');
  assert.equal(nearMiss('expire', 'axpirr'), false, 'two letters off');
  assert.equal(nearMiss('extension', 'extnesoin'), false);
  assert.equal(nearMiss('expire', ''), false, 'an empty answer');
  assert.equal(nearMiss('wasn\u2019t', "wasnt"), true, 'a curly apostrophe is the straight one');
});

test('the spelling pattern behind a wrong word, in templates with a Chinese translation', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { spellingPattern } = await load();
  const not = (right, wrong) => ({ template: '{1}, not {2} here', values: [right, wrong] });
  assert.deepEqual(spellingPattern('extension', 'extention'), not('-sion', '-tion'));
  assert.deepEqual(spellingPattern('function', 'funcsion'), not('-tion', '-sion'));
  assert.deepEqual(spellingPattern('consistent', 'consistant'), not('-ent', '-ant'));
  assert.deepEqual(spellingPattern('relevant', 'relevent'), not('-ant', '-ent'));
  assert.deepEqual(spellingPattern('dependency', 'dependancy'), not('-ency', '-ancy'), 'the longer ending is named');
  assert.deepEqual(spellingPattern('existence', 'existance'), not('-ence', '-ance'));
  assert.deepEqual(spellingPattern('visible', 'visable'), not('-ible', '-able'));
  assert.deepEqual(spellingPattern('independently', 'independantly'), not('-ent', '-ant'), 'inside the word too');
  assert.deepEqual(spellingPattern('receive', 'recieve'), not('ei', 'ie'));
  assert.deepEqual(spellingPattern('believe', 'beleive'), not('ie', 'ei'));
  assert.deepEqual(spellingPattern('occurrence', 'occurence'), { template: 'Double {1}', values: ['r'] });
  assert.deepEqual(spellingPattern('across', 'accross'), { template: 'Only one {1}', values: ['c'] });
  assert.deepEqual(spellingPattern('Extension', 'EXTENTION'), not('-sion', '-tion'), 'case aside');
  assert.equal(spellingPattern('expire', 'expier'), null, 'no known pattern');
  assert.equal(spellingPattern('extension', 'extension'), null);
  assert.equal(spellingPattern('extension', ''), null);
  const dictionary = fs.readFileSync(path.join(__dirname, '../public/js/i18n-zh-extra.js'), 'utf8');
  for (const template of ['{1}, not {2} here', 'Double {1}', 'Only one {1}']) assert.ok(dictionary.includes(`'${template}':`), `a Chinese translation for "${template}"`);
});

test('a word in parts: the card\'s own parts, else a syllable split that spells the word again', async () => {
  const { splitParts, partsOf } = await load();
  const split = word => splitParts(word).join('\u00b7');
  assert.equal(split('temporarily'), 'tem\u00b7po\u00b7ra\u00b7ri\u00b7ly');
  assert.equal(split('extension'), 'ex\u00b7ten\u00b7sion');
  assert.equal(split('function'), 'func\u00b7tion', '-tion is a part of its own');
  assert.equal(split('expire'), 'ex\u00b7pire', 'a final silent e stays with the part before');
  assert.equal(split('table'), 'ta\u00b7ble', 'a final consonant + le is a part');
  assert.equal(split('regression'), 're\u00b7gres\u00b7sion', 'a consonant + r starts a part');
  assert.equal(split('teacher'), 'tea\u00b7cher', 'ch stays together');
  assert.equal(split('ship'), 'ship', 'one vowel group: one part');
  assert.equal(split('rhythm'), 'rhythm');
  assert.equal(split("can't"), "can't", 'an apostrophe stays inside its word');
  assert.deepEqual(splitParts(''), []);
  for (const word of ['temporarily', 'responsibility', 'environment', 'trade-off', 'log in', 'Yesterday', 'queueing', 'strengths', 'a', 'beautiful', 'children']) {
    assert.equal(splitParts(word).join(''), word, `the parts of "${word}" spell it`);
    assert.ok(splitParts(word).every(Boolean), 'no empty part');
  }
  assert.deepEqual(partsOf({ en: 'temporarily', parts: ['tem', 'po', 'rar', 'i', 'ly'] }), ['tem', 'po', 'rar', 'i', 'ly'], 'the translator\'s parts');
  assert.deepEqual(partsOf({ en: 'temporarily', parts: ['tem', 'po'] }), splitParts('temporarily'), 'parts that do not spell the word are not used');
  assert.deepEqual(partsOf({ en: 'expire', parts: null }), ['ex', 'pire']);
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

test('the first tag of a wrong answer: letters of a spelled word, grammar of a sentence, listening, and an answer left empty', async () => {
  const { mistakeTag } = await load();
  const tag = (mode, expected, answer, extra = {}) => mistakeTag({ mode, expected, answer, ...extra });
  assert.equal(tag('spell', 'expire', 'expier'), 'letter-order');
  assert.equal(tag('spell', 'necessary', 'neccesary'), 'double-letter');
  assert.equal(tag('spell', 'occurred', 'occured'), 'double-letter');
  assert.equal(tag('spell', 'merge', 'merg'), 'missing-letter');
  assert.equal(tag('spell', 'merge', 'merges'), 'extra-letter');
  assert.equal(tag('spell', 'deploy', 'deplay'), 'wrong-letter');
  assert.equal(tag('spell', 'idempotent', 'idenpotant'), 'spelling');
  assert.equal(tag('spell', 'deploy', 'rollback'), 'wrong-word');
  assert.equal(tag('spell', 'deploy', '  '), 'unknown');
  assert.equal(tag('spell', 'deploy', 'depl', { gaveUp: true }), 'unknown', '"I don\'t know"');
  // Fill the gap: another form of the gap word is grammar (from the whole sentence, as the page sends it).
  assert.equal(tag('fill', 'Please fix the loop after the session cookie expires.', 'Please fix the loop after the session cookie expire.'), 'verb-form');
  assert.equal(tag('fill', 'merged', 'merge'), 'tense');
  // Sentences.
  assert.equal(tag('build', 'He has already left.', 'He already left.'), 'tense');
  assert.equal(tag('dictation', 'I look forward to hearing from you.', 'I look forward to hear from you.'), 'verb-form');
  assert.equal(tag('build', 'Please fix the login page now.', 'Please fix login page now.'), 'article');
  assert.equal(tag('build', 'Run the tests before you merge.', 'Run the test before you merge.'), 'plural');
  assert.equal(tag('build', 'Run the tests again before you merge.', 'Run again the tests before you merge.'), 'word-order');
  assert.equal(tag('dictation', 'Deploy the staging server tonight.', 'Deploy the staging service tonight.'), 'listening');
  assert.equal(tag('say', 'Deploy the staging server tonight.', 'Deploy the staging service tonight.'), 'pronunciation');
  assert.equal(tag('build', 'Deploy the staging server tonight.', 'Deploy the staging service tonight.'), 'wrong-word');
  assert.equal(tag('build', 'Deploy the staging server tonight.', 'Deploy the staging server.'), 'missing-word');
  assert.equal(tag('build', 'Deploy the staging server.', 'Deploy the staging server now.'), 'extra-word');
});
