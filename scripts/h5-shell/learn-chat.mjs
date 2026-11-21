// The parts of "English chat" on the Learn page that need no DOM (pure functions with unit tests): the starter chips of a new chat, the topic
// sent with a question, the corrections markup of a reviewed journal entry, the page's own guard against a model meta line, the row line of a chat,
// the merge of stored messages and of the chats list, the context of a card added from an answer, and the Enter key of the input. See
// "English chat" in docs/design/learn-english-page.md.
import { boldParts, findWholeWord, shortDateTime } from './learn-model.mjs';

export const CHAT_QUESTION_MAX = 4000;
// A chat holds at most this many messages (the server answers 409 "This chat is full. Start a new one." after it; nothing is ever pruned).
export const CHAT_MESSAGES_MAX = 100;
export const CHAT_TITLE_MAX = 60;
// The context the server keeps for a card added by hand (services/learn.js MAX_CONTEXT).
export const CARD_CONTEXT_MAX = 120;
export const CHAT_FULL = 'This chat is full. Start a new one.';

// The starter chips of a new chat, English dictionary keys. `fill` puts a translated template into the input (the caret at `{1}`, else at the end;
// `after` is added untranslated after the template) and focuses it; `send` sends the label as shown, with its topic.
export const CHAT_CHIPS = [
  { id: 'journal-review', label: 'Review my journal entry', action: 'fill', template: 'Please review my journal entry:', after: '\n' },
  { id: 'journal-habit', label: 'How is my journaling going?', action: 'send', topic: 'journal' },
  { id: 'how-say', label: 'How do I say … in English?', action: 'fill', template: 'How do I say "{1}" in English?' },
  { id: 'check', label: 'Check my sentence', action: 'fill', template: 'Please check my sentence:', after: ' ' },
  { id: 'mistakes', label: 'Words I keep getting wrong', action: 'send', topic: 'mistakes' },
];

// The text a `fill` chip puts into the input and where the caret goes: { text, caret }. `translate` is the page's t().
export function chipFill(chip, translate = text => text) {
  const shown = String(translate(chip.template || ''));
  const at = shown.indexOf('{1}');
  const text = (at >= 0 ? shown.slice(0, at) + shown.slice(at + 3) : shown) + (chip.after || '');
  return { text, caret: at >= 0 ? at : text.length };
}

// The topic sent with a typed question (the server may add a summary only when it is asked for): the journal habit (journal, diary, habit, and the
// Chinese words for diary and habit) or the mistakes (mistake, wrong, keep getting, and the Chinese for mistake); null for anything else.
const JOURNAL_RE = /journal|diary|habit|\u65e5\u8bb0|\u4e60\u60ef/i;
const MISTAKES_RE = /mistake|wrong|keep getting|\u9519/i;
// Like the server (services/learn-chat.js): a long text or a journal entry sent for review is never a question about the habit or the mistakes,
// even when it contains those words, so a review does not pull in the journal summary.
const MAX_TOPIC_QUESTION = 500;
const REVIEW_PREFIX = /^\s*please review my journal entry\s*:?\s*/i;
export function chatTopic(question) {
  const text = String(question || '');
  if (text.length > MAX_TOPIC_QUESTION || REVIEW_PREFIX.test(text)) return null;
  if (JOURNAL_RE.test(text)) return 'journal';
  if (MISTAKES_RE.test(text)) return 'mistakes';
  return null;
}

// The page's own guard against the model's meta line (the server strips it; a stream or an older server must still never show it): a complete
// `<<meta>>…` to the end of the text is cut away, and a trailing piece that could be the start of `<<meta>>` is held back while the answer streams.
const META = '<<meta>>';
export function visibleAnswer(text, { streaming = false } = {}) {
  let out = String(text || '');
  const at = out.indexOf(META);
  if (at >= 0) out = out.slice(0, at);
  else if (streaming) {
    for (let length = Math.min(META.length - 1, out.length); length > 0; length -= 1) {
      if (out.endsWith(META.slice(0, length))) { out = out.slice(0, -length); break; }
    }
  }
  return at >= 0 || streaming ? out.replace(/\s+$/, '') : out;
}

// An answer split into its parts for drawing: [{ text, bold?, del?, ins? }]. `[-wrong-]` is a deletion and `{+right+}` an insertion of a reviewed
// journal entry (never across a line break); **bold** is read in the rest. An unclosed marker stays as written (a stream that has sent only half of
// it shows the characters for a moment, never a broken layout).
const MARK_RE = /\[-([^\n]+?)-\]|\{\+([^\n]+?)\+\}/g;
export function answerParts(text) {
  const source = String(text || '');
  const out = [];
  const plain = piece => { for (const part of boldParts(piece)) out.push(part.bold ? { text: part.text, bold: true } : { text: part.text }); };
  let at = 0;
  MARK_RE.lastIndex = 0;
  for (let match = MARK_RE.exec(source); match; match = MARK_RE.exec(source)) {
    if (match.index > at) plain(source.slice(at, match.index));
    out.push(match[1] !== undefined ? { text: match[1], del: true } : { text: match[2], ins: true });
    at = match.index + match[0].length;
  }
  if (at < source.length) plain(source.slice(at));
  return out;
}

// The text of an answer as a reader sees it after the corrections: deletions dropped, insertions kept, no stars.
export const correctedText = text => answerParts(text).filter(part => !part.del).map(part => part.text).join('');

// The context of a card added from an answer: for a word the sentence of the answer it stands in (as corrected), cut to the server's limit; '' for
// a sentence card or a word that is not found.
export function cardContext(card, answer) {
  if (!card || card.kind !== 'word') return '';
  const word = String(card.en || '').trim();
  if (!word) return '';
  const sentences = correctedText(answer).split(/\n+|(?<=[.!?\u3002\uff01\uff1f])\s+/).map(item => item.trim()).filter(Boolean);
  const found = sentences.find(item => findWholeWord(item, word) >= 0) || sentences.find(item => item.toLowerCase().includes(word.toLowerCase()));
  return found ? found.slice(0, CARD_CONTEXT_MAX) : '';
}
// A card of an answer named by its kind and text (what makes it the same card on the server).
export const cardKey = card => `${card && card.kind}:${String((card && card.en) || '').trim().toLowerCase()}`;

// The line under a chat's title: "11-21 22:05 · 6 messages", as [template, ...values] for the page's translated templates ('' time is left out).
export function chatLine(chat) {
  const count = Math.max(0, Number(chat && chat.count) || 0);
  const time = shortDateTime(chat && (chat.updated_at || chat.created_at));
  const messages = count === 1 ? ['1 message'] : ['{1} messages', count];
  return { time, messages };
}

// The stored messages of a chat after an answer arrived or the chat was read again: a union by `uid`, oldest first (`at`, then `uid`).
const timeOf = at => (typeof at === 'number' ? at : Date.parse(at || '') || 0);
export function mergeChat(...lists) {
  const byUid = new Map();
  for (const list of lists) for (const item of list || []) if (item && item.uid) byUid.set(item.uid, { ...(byUid.get(item.uid) || {}), ...item });
  return [...byUid.values()].sort((a, b) => timeOf(a.at) - timeOf(b.at) || String(a.uid).localeCompare(String(b.uid)));
}

// The chats list with one chat put in (new or changed) or taken out (`remove`), newest message first.
export function putChat(list, chat, { remove = false } = {}) {
  const rest = (list || []).filter(item => item && item.uid !== (chat && chat.uid));
  const next = remove || !chat || !chat.uid ? rest : [...rest, { ...((list || []).find(item => item && item.uid === chat.uid) || {}), ...chat }];
  return next.sort((a, b) => timeOf(b.updated_at) - timeOf(a.updated_at) || String(b.uid).localeCompare(String(a.uid)));
}

// Enter in the input: on a computer (a hardware keyboard or a mouse) Enter sends and Shift+Enter is a new line; on a touch screen Enter is always a
// new line (the send button sends). An IME composition never sends.
export const enterSends = ({ key, shiftKey = false, altKey = false, ctrlKey = false, metaKey = false, isComposing = false, keyCode = 0 }, { keys = false } = {}) =>
  keys && key === 'Enter' && !shiftKey && !altKey && !ctrlKey && !metaKey && !isComposing && keyCode !== 229;
