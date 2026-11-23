// "English chat" on the Learn page: the pure parts in scripts/h5-shell/learn-chat.mjs (the starter chips, the topic of a typed question, the
// corrections markup, the meta-line guard, the row line, the merges, the context of an added card, the Enter key). See "English chat on the page" in
// docs/design/learn-english-chat.md.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-learn-chat-'));

const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../scripts/h5-shell/learn-chat.mjs');

test('the starter chips: three fill the input, two send with their topic', async () => {
  const { CHAT_CHIPS, chipFill } = await load();
  assert.deepEqual(CHAT_CHIPS.map(chip => [chip.label, chip.action, chip.topic || null]), [
    ['Review my journal entry', 'fill', null],
    ['How is my journaling going?', 'send', 'journal'],
    ['How do I say … in English?', 'fill', null],
    ['Check my sentence', 'fill', null],
    ['Words I keep getting wrong', 'send', 'mistakes'],
  ]);
  const byId = id => CHAT_CHIPS.find(chip => chip.id === id);
  assert.deepEqual(chipFill(byId('journal-review')), { text: 'Please review my journal entry:\n', caret: 32 });
  assert.deepEqual(chipFill(byId('how-say')), { text: 'How do I say "" in English?', caret: 14 }, 'the caret between the quotes');
  assert.deepEqual(chipFill(byId('check')), { text: 'Please check my sentence: ', caret: 26 });
  // A translated template keeps its caret mark wherever the translation puts it.
  assert.deepEqual(chipFill(byId('how-say'), () => '\u201c{1}\u201d\u7528\u82f1\u8bed\u600e\u4e48\u8bf4\uff1f'), { text: '\u201c\u201d\u7528\u82f1\u8bed\u600e\u4e48\u8bf4\uff1f', caret: 1 });
});

test('a typed question names the journal or the mistakes topic only when it is about them', async () => {
  const { chatTopic } = await load();
  assert.equal(chatTopic('How is my Journal going?'), 'journal');
  assert.equal(chatTopic('Do I keep a good diary habit?'), 'journal');
  assert.equal(chatTopic('\u6211\u7684\u65e5\u8bb0\u5199\u5f97\u600e\u4e48\u6837\uff1f'), 'journal');
  assert.equal(chatTopic('\u6211\u6700\u8fd1\u6709\u4ec0\u4e48\u4e60\u60ef\uff1f'), 'journal');
  assert.equal(chatTopic('Which mistakes do I make?'), 'mistakes');
  assert.equal(chatTopic('What do I keep getting wrong?'), 'mistakes');
  assert.equal(chatTopic('\u6211\u6700\u5e38\u9519\u7684\u5355\u8bcd'), 'mistakes');
  assert.equal(chatTopic('What does "slot" mean?'), null);
  assert.equal(chatTopic(''), null);
  // A journal entry sent for review, or any long text, names no topic even with those words in it (the server's rule too).
  assert.equal(chatTopic('Please review my journal entry:\nToday I wrote in my journal and got the tests wrong.'), null);
  assert.equal(chatTopic(`My diary habit. ${'word '.repeat(120)}`), null);
});

test('the meta line never shows: cut when complete, held back while it may be starting', async () => {
  const { visibleAnswer } = await load();
  assert.equal(visibleAnswer('Good plan.\n<<meta>>{"cards":[]}'), 'Good plan.');
  assert.equal(visibleAnswer('Good plan.\n<<meta>>{"car', { streaming: true }), 'Good plan.');
  assert.equal(visibleAnswer('Good plan.\n<<me', { streaming: true }), 'Good plan.');
  assert.equal(visibleAnswer('Good plan.\n<', { streaming: true }), 'Good plan.');
  assert.equal(visibleAnswer('a <b', { streaming: true }), 'a <b', 'only a start of <<meta>> is held back');
  assert.equal(visibleAnswer('Good plan.\n', { streaming: false }), 'Good plan.\n', 'a finished answer keeps its text as it is');
  assert.equal(visibleAnswer(''), '');
});

test('corrections markup: deletions, insertions and bold in the rest', async () => {
  const { answerParts, correctedText } = await load();
  assert.deepEqual(answerParts('Today I [-have deployed-]{+deployed+} the **new** page.'), [
    { text: 'Today I ' }, { text: 'have deployed', del: true }, { text: 'deployed', ins: true }, { text: ' the ' }, { text: 'new', bold: true }, { text: ' page.' },
  ]);
  assert.deepEqual(answerParts('It was [-very-] slow'), [{ text: 'It was ' }, { text: 'very', del: true }, { text: ' slow' }]);
  // Unclosed markers (a stream half way) and markers across a line break stay as written.
  assert.deepEqual(answerParts('It was [-ver'), [{ text: 'It was [-ver' }]);
  assert.deepEqual(answerParts('Why: with a past time (*on Friday*) use the simple past.'), [{ text: 'Why: with a past time (' }, { text: 'on Friday', italic: true }, { text: ') use the simple past.' }]);
  assert.deepEqual(answerParts('[-a\nb-]'), [{ text: '[-a\nb-]' }]);
  assert.deepEqual(answerParts(''), []);
  assert.equal(correctedText('the tests [-was-]{+were+} **flaky**'), 'the tests were flaky');
});

test('a word card added from an answer takes the sentence it stands in as its context', async () => {
  const { cardContext, cardKey } = await load();
  const answer = 'Yes: **fit in** = make time for it.\nCan you slot me in at 3? It works.';
  assert.equal(cardContext({ kind: 'word', en: 'slot' }, answer), 'Can you slot me in at 3?');
  assert.equal(cardContext({ kind: 'sentence', en: 'Can you slot me in at 3?' }, answer), '');
  assert.equal(cardContext({ kind: 'word', en: 'flaky' }, 'The tests [-was-]{+were+} flaky.'), 'The tests were flaky.');
  assert.equal(cardContext({ kind: 'word', en: 'absent' }, answer), '');
  assert.equal(cardContext({ kind: 'word', en: 'long' }, `long ${'word '.repeat(60)}`).length, 120);
  assert.equal(cardKey({ kind: 'word', en: ' Slot ' }), 'word:slot');
});

test('the row line of a chat: the time of its last message and the count', async () => {
  const { chatLine } = await load();
  const at = new Date(2026, 10, 21, 22, 5).toISOString();
  assert.deepEqual(chatLine({ updated_at: at, count: 6 }), { time: '11-21 22:05', messages: ['{1} messages', 6] });
  assert.deepEqual(chatLine({ updated_at: at, count: 1 }), { time: '11-21 22:05', messages: ['1 message'] });
  assert.deepEqual(chatLine({ count: 0 }), { time: '', messages: ['{1} messages', 0] });
});

test('stored messages merge by uid, oldest first; the chats list keeps the newest first', async () => {
  const { mergeChat, putChat } = await load();
  const m = (uid, at, extra = {}) => ({ uid, role: 'user', text: uid, at, ...extra });
  const merged = mergeChat([m('b', '2026-11-21T10:00:02Z'), m('a', '2026-11-21T10:00:01Z')], [m('b', '2026-11-21T10:00:02Z', { cards: [{ added: true }] }), m('c', '2026-11-21T10:00:03Z')]);
  assert.deepEqual(merged.map(item => item.uid), ['a', 'b', 'c']);
  assert.deepEqual(merged[1].cards, [{ added: true }], 'the newer copy of a message wins');
  const list = [{ uid: 'x', updated_at: '2026-11-21T09:00:00Z', title: 'X' }, { uid: 'y', updated_at: '2026-11-21T08:00:00Z', title: 'Y' }];
  assert.deepEqual(putChat(list, { uid: 'y', updated_at: '2026-11-21T11:00:00Z' }).map(item => [item.uid, item.title]), [['y', 'Y'], ['x', 'X']]);
  assert.deepEqual(putChat(list, { uid: 'z', updated_at: '2026-11-21T12:00:00Z', title: '' }).map(item => item.uid), ['z', 'x', 'y']);
  assert.deepEqual(putChat(list, { uid: 'x' }, { remove: true }).map(item => item.uid), ['y']);
});

test('Enter sends on a computer, never on a touch screen or during an IME composition', async () => {
  const { enterSends } = await load();
  assert.equal(enterSends({ key: 'Enter' }, { keys: true }), true);
  assert.equal(enterSends({ key: 'Enter', shiftKey: true }, { keys: true }), false);
  assert.equal(enterSends({ key: 'Enter', isComposing: true }, { keys: true }), false);
  assert.equal(enterSends({ key: 'Enter', keyCode: 229 }, { keys: true }), false);
  assert.equal(enterSends({ key: 'Enter' }, { keys: false }), false);
  assert.equal(enterSends({ key: 'a' }, { keys: true }), false);
});
