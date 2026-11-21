// "Ask about this question" on the Learn page: the pure parts in scripts/h5-shell/learn-model.mjs (the chips, the caption, the state sent, the kind,
// the language and **bold** of a message, the NDJSON lines, the merge of stored messages). See "Ask about this question" in
// docs/design/learn-english-page.md.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-learn-ask-'));

const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../scripts/h5-shell/learn-model.mjs');

test('the chips before Check give hints only, after Check they ask about the answer', async () => {
  const { askChips } = await load();
  assert.deepEqual(askChips({ kind: 'word', checked: false }), ['Give me a hint', 'What part of speech fits?', 'Other example sentences', 'How do I remember it?']);
  assert.deepEqual(askChips({ kind: 'sentence', checked: false }), ['Give me a hint', 'Explain the grammar', 'Other example sentences', 'How do I remember it?']);
  assert.deepEqual(askChips({ kind: 'word', checked: true, correct: false }), ['Why was my answer wrong?', 'Explain the grammar', 'Other example sentences', 'How do I remember it?']);
  assert.deepEqual(askChips({ kind: 'sentence', checked: true, correct: true }), ['Explain the grammar', 'Other example sentences', 'How do I remember it?']);
});

test('the caption says what the model sees', async () => {
  const { askCaption } = await load();
  assert.deepEqual(askCaption({ checked: false, gap: true }), ['The sentence with the gap \u00b7 your answer is not shown yet']);
  assert.deepEqual(askCaption({ checked: false, gap: false }), ['Not checked yet: hints only']);
  assert.deepEqual(askCaption({ checked: true, answer: ' expiers ', correct: false }), ['Your answer: {1} \u00b7 wrong', 'expiers']);
  assert.deepEqual(askCaption({ checked: true, answer: 'expires', correct: true }), ['Your answer: {1} \u00b7 right', 'expires']);
  assert.deepEqual(askCaption({ checked: true, answer: '', correct: false }), ['Your answer: {1} \u00b7 wrong', '\u2014'], 'given up with nothing typed');
});

test('the state sent with a question, and the kind of the card', async () => {
  const { askState, askKind } = await load();
  assert.deepEqual(askState(null, 'exp'), { checked: false }, 'before Check the answer is not sent');
  assert.deepEqual(askState({ correct: false, helped: true }, 'expiers'), { checked: true, answer: 'expiers', correct: false, helped: true });
  assert.equal(askState({ correct: true }, 'x'.repeat(600)).answer.length, 500);
  assert.deepEqual(askState(null, '', ' merge '), { checked: false, expected: 'merge' }, "Fill the gap's word, before Check too");
  assert.deepEqual(askState({ correct: false }, 'merged', 'merge'), { checked: true, answer: 'merged', correct: false, helped: false, expected: 'merge' });
  assert.equal(askState(null, '', 'y'.repeat(400)).expected.length, 300);
  assert.equal(askKind({ kind: 'word' }, 'spell'), 'word');
  assert.equal(askKind({ kind: 'sentence' }, 'build'), 'sentence');
  assert.equal(askKind({ kind: 'word' }, 'fill'), 'sentence');
});

test('the language of a message: Chinese when it has a CJK character', async () => {
  const { textLang } = await load();
  assert.equal(textLang('Why the -s?'), 'en');
  assert.equal(textLang('\u4e3a\u4ec0\u4e48\u8fd9\u91cc\u8981\u52a0 s?'), 'zh');
  assert.equal(textLang('expire \u2192 expires\uff0c\u8bb0\u6cd5'), 'zh');
  assert.equal(textLang(''), 'en');
});

test('**bold** is the only markup; anything else stays text', async () => {
  const { boldParts } = await load();
  assert.deepEqual(boldParts('**expire** keeps its e'), [{ text: 'expire', bold: true }, { text: ' keeps its e', bold: false }]);
  assert.deepEqual(boldParts('add **-s**: **e**.'), [{ text: 'add ', bold: false }, { text: '-s', bold: true }, { text: ': ', bold: false }, { text: 'e', bold: true }, { text: '.', bold: false }]);
  assert.deepEqual(boldParts('half **open'), [{ text: 'half **open', bold: false }], 'an unclosed run while it streams');
  assert.deepEqual(boldParts('<b>x</b>\nline'), [{ text: '<b>x</b>\nline', bold: false }]);
  // *italic* (models use it for examples): drawn in italics, not shown with its stars; not inside a word, not with spaces at its ends.
  assert.deepEqual(boldParts('with a past time (*on Friday*) use'), [{ text: 'with a past time (', bold: false }, { text: 'on Friday', bold: false, italic: true }, { text: ') use', bold: false }]);
  assert.deepEqual(boldParts('**bold** and *it*'), [{ text: 'bold', bold: true }, { text: ' and ', bold: false }, { text: 'it', bold: false, italic: true }]);
  assert.deepEqual(boldParts('2*3*4 and a * b * c'), [{ text: '2*3*4 and a * b * c', bold: false }]);
  assert.deepEqual(boldParts('half *open'), [{ text: 'half *open', bold: false }]);
  assert.deepEqual(boldParts('a ** b'), [{ text: 'a ** b', bold: false }]);
  assert.deepEqual(boldParts(''), []);
});

test('the NDJSON stream is read line by line, the unfinished rest kept', async () => {
  const { ndjsonLines } = await load();
  assert.deepEqual(ndjsonLines('{"delta":"The "}\n{"delta":"sub'), { items: [{ delta: 'The ' }], rest: '{"delta":"sub' });
  assert.deepEqual(ndjsonLines('{"delta":"x"}\n\nnot json\n{"done":true,"messages":[]}\n'), { items: [{ delta: 'x' }, { done: true, messages: [] }], rest: '' });
  assert.deepEqual(ndjsonLines(''), { items: [], rest: '' });
});

test('stored messages merge by uid, oldest first, the newest 20 kept', async () => {
  const { mergeMessages } = await load();
  const msg = (uid, at, role = 'user') => ({ uid, role, text: uid, at });
  assert.deepEqual(mergeMessages([msg('b', 2), msg('a', 1)], [msg('a', 1), msg('c', 3)]).map(item => item.uid), ['a', 'b', 'c']);
  assert.deepEqual(mergeMessages([msg('y', 5), msg('x', 5)]).map(item => item.uid), ['x', 'y'], 'the same time: by uid');
  const many = Array.from({ length: 25 }, (_, index) => msg(`m${String(index).padStart(2, '0')}`, index));
  const kept = mergeMessages(many);
  assert.equal(kept.length, 20);
  assert.equal(kept[0].uid, 'm05');
  assert.deepEqual(mergeMessages(null, [null, { text: 'no uid' }]), []);
  const iso = (uid, at) => ({ uid, role: 'user', text: uid, at });
  assert.deepEqual(mergeMessages([iso('late', '2026-11-21T10:00:05.000Z'), iso('early', '2026-11-21T09:59:59.000Z')]).map(item => item.uid), ['early', 'late'], 'ISO times from the server');
});
