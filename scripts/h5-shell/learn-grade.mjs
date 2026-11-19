// Grading of the Learn page's answers, in the browser (pure functions, no DOM): the word-by-word diff of a typed or built sentence against the card's
// English, tolerant of case, extra spaces and punctuation around words, with the usual mistake named (a missing or extra article, a plural -s, a
// third-person -s, a past tense -ed, a spelling slip, the word order); the letter check of a spelled word; and the grade suggested after an answer.
// See "Grading" in docs/design/learn-english-page.md.

// Punctuation that may stand before or after a word and is not part of it (quotes, brackets, sentence marks). Inner apostrophes and hyphens stay.
const EDGE = /^[\s"'`([{<\u2018\u201c\u00ab]+|[\s"'`)\]}>.,!?;:\u2019\u201d\u00bb\u2026\u3002\uff0c\uff01\uff1f\uff1b\uff1a]+$/g;
// One spelling for apostrophes and dashes, so a phone's curly apostrophe matches the card's straight one.
const unify = text => String(text || '').replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u2010\u2011\u2012\u2013]/g, '-');

// The comparable form of one word: no punctuation around it, lower case.
export function normWord(word) {
  return unify(word).replace(EDGE, '').toLowerCase();
}

// The words of a sentence: { text (as written, without the punctuation around it), norm }. Pieces that are only punctuation are dropped.
export function wordsOf(sentence) {
  return unify(sentence).split(/\s+/).map(piece => ({ text: piece.replace(EDGE, ''), norm: normWord(piece) })).filter(word => word.norm);
}

// The same sentence, whatever the case, the spaces and the punctuation around words.
export const sameSentence = (a, b) => {
  const x = wordsOf(a);
  const y = wordsOf(b);
  return x.length === y.length && x.every((word, index) => word.norm === y[index].norm);
};

// Longest common subsequence of two lists of normalized words: the pairs [i, j] of words kept in order.
function commonPairs(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { pairs.push([i, j]); i += 1; j += 1; } else if (table[i + 1][j] >= table[i][j + 1]) i += 1; else j += 1;
  }
  return pairs;
}

// Levenshtein distance, for "a spelling slip" (small words are never called a slip).
export function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const kept = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = kept;
    }
  }
  return prev[b.length];
}

// The word-by-word diff of `answer` against `expected`. `ops`, in the order of the expected sentence:
//   { type: 'same', expected, answer }   the word is right (the answer's own spelling is kept for display)
//   { type: 'wrong', expected, answer }  a word in its place that is not the one expected
//   { type: 'missing', expected }        a word the answer left out
//   { type: 'extra', answer }            a word the answer has and the sentence does not
// `right` counts the 'same' words, `total` the expected words; `correct` is true when every word matches (case and punctuation aside).
export function diffWords(expected, answer) {
  const want = wordsOf(expected);
  const got = wordsOf(answer);
  const pairs = commonPairs(want.map(word => word.norm), got.map(word => word.norm));
  const ops = [];
  let i = 0;
  let j = 0;
  const flush = (untilI, untilJ) => {
    const missing = want.slice(i, untilI);
    const extra = got.slice(j, untilJ);
    // Between two anchors, a left-out word and an added word side by side are one word replaced by another.
    const paired = Math.min(missing.length, extra.length);
    for (let k = 0; k < paired; k += 1) ops.push({ type: 'wrong', expected: missing[k].text, answer: extra[k].text });
    for (let k = paired; k < extra.length; k += 1) ops.push({ type: 'extra', answer: extra[k].text });
    for (let k = paired; k < missing.length; k += 1) ops.push({ type: 'missing', expected: missing[k].text });
    i = untilI;
    j = untilJ;
  };
  for (const [wi, gj] of pairs) {
    flush(wi, gj);
    ops.push({ type: 'same', expected: want[wi].text, answer: got[gj].text });
    i = wi + 1;
    j = gj + 1;
  }
  flush(want.length, got.length);
  const right = ops.filter(op => op.type === 'same').length;
  const correct = right === want.length && got.length === want.length;
  return { ops, right, total: want.length, correct, hints: correct ? [] : hintsOf(ops, want, got) };
}

const ARTICLES = new Set(['a', 'an', 'the']);
// Words before a noun that ask for its plural ("two files", "these tests").
const PLURAL_CUES = new Set(['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'many', 'several', 'few', 'both', 'these', 'those',
  'multiple', 'all', 'some', 'various', 'other', 'more', 'most', 'fewer', 'our', 'their', 'your', 'my', 'his', 'her', 'its', 'the', 'no', 'any']);
// Subjects that take a third-person -s on the verb after them.
const SINGULAR_SUBJECTS = new Set(['he', 'she', 'it', 'this', 'that', 'who', 'which', 'what', 'everyone', 'someone', 'nobody', 'something', 'nothing',
  'everything', 'each', 'one']);
// Words that usually follow a verb (its object or its complement): a word with a missing -s before them is a verb.
const AFTER_VERB = new Set(['a', 'an', 'the', 'to', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'this', 'that', 'these', 'those', 'me', 'him', 'us',
  'them', 'it', 'up', 'down', 'out', 'on', 'off', 'in', 'into', 'with', 'from', 'for', 'when', 'if', 'because', 'and', 'but']);

const stripS = word => (word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.endsWith('es') && /(s|x|z|ch|sh)es$/.test(word) ? word.slice(0, -2) : word.endsWith('s') ? word.slice(0, -1) : null);
const pastOf = word => [`${word}ed`, `${word}d`, word.endsWith('y') ? `${word.slice(0, -1)}ied` : null, /[^aeiou][aeiou][bdgkmnpt]$/.test(word) ? `${word}${word.at(-1)}ed` : null].filter(Boolean);
// `long` is the word with the ending, `short` without: true when `long` is `short` plus a plural / third-person -s.
const addsS = (long, short) => long !== short && stripS(long) === short;
const addsEd = (long, short) => long !== short && pastOf(short).includes(long);

const DETERMINERS = new Set(['the', 'a', 'an', 'this', 'that', 'my', 'your', 'his', 'her', 'its', 'our', 'their']);
// Words that start a clause, so a noun phrase after them is its subject ("after the session cookie expires").
const CLAUSE_START = new Set(['after', 'before', 'when', 'if', 'because', 'and', 'but', 'that', 'until', 'once', 'while', 'since', 'unless', 'so', 'or']);

// Whether the -s word at `index` of the expected sentence is a verb (third person) rather than a noun (plural), from its neighbours: after a
// subject pronoun, before an object, or at the end of a noun phrase that starts the sentence or a clause; else a noun.
function isVerbS(want, index) {
  const prev = index > 0 ? want[index - 1].norm : '';
  const next = index + 1 < want.length ? want[index + 1].norm : '';
  if (PLURAL_CUES.has(prev) && !SINGULAR_SUBJECTS.has(prev)) return false;
  if (SINGULAR_SUBJECTS.has(prev)) return true;
  if (AFTER_VERB.has(next)) return true;
  for (let j = index - 1; j >= Math.max(0, index - 4); j -= 1) {
    if (!DETERMINERS.has(want[j].norm)) continue;
    return j === 0 || CLAUSE_START.has(want[j - 1].norm);
  }
  return false;
}

// The mistakes named after Check, at most one per word: { kind, word, other? }. kinds: 'article-missing', 'article-extra', 'article-wrong',
// 'plural', 'third-person', 'past-tense', 'spelling', 'order'. `word` is the expected word (the answer's one for an extra word).
export function hintsOf(ops, want = [], got = []) {
  const hints = [];
  const missingWords = ops.filter(op => op.type === 'missing').map(op => normWord(op.expected));
  const extraWords = ops.filter(op => op.type === 'extra').map(op => normWord(op.answer));
  // A word that is missing in one place and extra in another was moved: the word order.
  const moved = new Set(missingWords.filter(word => extraWords.includes(word)));
  let wantIndex = 0;
  for (const op of ops) {
    const index = wantIndex;
    if (op.type !== 'extra') wantIndex += 1;
    if (op.type === 'same') continue;
    const expected = op.expected ? normWord(op.expected) : '';
    const answer = op.answer ? normWord(op.answer) : '';
    if (op.type === 'missing' && moved.has(expected)) continue;
    if (op.type === 'extra' && moved.has(answer)) continue;
    if (op.type === 'missing' && ARTICLES.has(expected)) { hints.push({ kind: 'article-missing', word: op.expected }); continue; }
    if (op.type === 'extra' && ARTICLES.has(answer)) { hints.push({ kind: 'article-extra', word: op.answer }); continue; }
    if (op.type !== 'wrong') continue;
    if (ARTICLES.has(expected) && ARTICLES.has(answer)) { hints.push({ kind: 'article-wrong', word: op.expected, other: op.answer }); continue; }
    if (addsS(expected, answer) || addsS(answer, expected)) {
      hints.push({ kind: isVerbS(want, index) ? 'third-person' : 'plural', word: op.expected, other: op.answer, extra: addsS(answer, expected) });
      continue;
    }
    if (addsEd(expected, answer) || addsEd(answer, expected)) { hints.push({ kind: 'past-tense', word: op.expected, other: op.answer, extra: addsEd(answer, expected) }); continue; }
    if (expected.length > 3 && editDistance(expected, answer) <= (expected.length > 7 ? 2 : 1)) { hints.push({ kind: 'spelling', word: op.expected, other: op.answer }); continue; }
  }
  // The order: the same words in another order, or words that were moved.
  const sorted = list => list.map(word => word.norm).sort().join(' ');
  const sameWords = want.length > 1 && want.length === got.length && sorted(want) === sorted(got);
  if (sameWords || moved.size) hints.push({ kind: 'order', word: moved.size ? [...moved][0] : '' });
  return hints;
}

// The English text of a hint, made of a template and its word(s), for the page to translate with `t()` (i18n templates with {1} and {2}).
export function hintText(hint) {
  switch (hint.kind) {
    case 'article-missing': return ['"{1}": article missing', hint.word];
    case 'article-extra': return ['"{1}": no article here', hint.word];
    case 'article-wrong': return ['"{1}", not "{2}"', hint.word, hint.other];
    case 'plural': return [hint.extra ? '"{1}": no plural -s here' : '"{1}": plural -s', hint.word];
    case 'third-person': return [hint.extra ? '"{1}": no third person -s here' : '"{1}": third person -s', hint.word];
    case 'past-tense': return [hint.extra ? '"{1}": not the past tense here' : '"{1}": past tense -ed', hint.word];
    case 'spelling': return ['"{1}": spelling', hint.word];
    case 'order': return hint.word ? ['"{1}": word order', hint.word] : ['Word order'];
    default: return [''];
  }
}

// The letter check of a spelled word: `ok` when it matches (case aside), and one entry per expected letter with what was typed in its place.
export function spellCheck(expected, answer) {
  const want = unify(expected).trim();
  const got = unify(answer).trim();
  const letters = [...want].map((char, index) => ({ char, typed: got[index] || '', ok: (got[index] || '').toLowerCase() === char.toLowerCase() }));
  return { ok: want.toLowerCase() === got.toLowerCase(), letters, right: letters.filter(letter => letter.ok).length, total: letters.length };
}

// The grade offered after an answer (Enter takes it): right without help is Good, right with help (a hint, the first letter) is Hard, wrong is Again.
export function suggestedGrade({ correct, helped = false }) {
  if (!correct) return 'again';
  return helped ? 'hard' : 'good';
}
