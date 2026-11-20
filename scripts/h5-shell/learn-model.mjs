// The rules of the Learn page that need no DOM (pure functions with unit tests): which exercise a card gets, the word tiles of "Build the sentence",
// the gap of "Fill the gap", a word asked inside its sentence in Spell, the notes of "MY LEVEL" and "WORDS FROM MY TRANSLATIONS" in Learn settings,
// the time estimate of the home, the order of a mixed session, the keys of a computer. See "The Learn page" in
// docs/design/learn-english-page.md.
import { normWord, wordsOf } from './learn-grade.mjs';

// The practice modes of the page, in the order of the home. `kind`: the cards it takes; `queue`: the /api/learn/queue mode; `limit`: cards per session.
export const MODES = [
  { id: 'spell', kind: 'word', label: 'Spell the word', note: 'See the meaning or hear it, type the word', icon: 'learnSpell', limit: 20 },
  { id: 'build', kind: 'sentence', label: 'Build the sentence', note: 'Chinese + word tiles → the full sentence', icon: 'learnBuild', limit: 10 },
  { id: 'dictation', kind: 'sentence', label: 'Dictation', note: 'Hear a sentence, type what you hear', icon: 'learnDictation', limit: 10, needs: 'tts' },
  { id: 'say', kind: 'sentence', label: 'Say it', note: 'Read aloud; voice input checks you', icon: 'voice', limit: 10, needs: 'voice' },
  { id: 'fill', kind: 'sentence', label: 'Fill the gap', note: 'One word missing from your own sentence', icon: 'learnFill', limit: 10 },
];
export const modeOf = id => MODES.find(mode => mode.id === id) || null;
// The modes this browser can offer: Dictation needs speech output, Say it a way to hear the person.
export const availableModes = ({ tts = false, voice = false } = {}) => MODES.filter(mode => !mode.needs || (mode.needs === 'tts' ? tts : voice));

// The exercise a card gets in a mixed session (Review, Mistakes, free practice): a word is spelled, a sentence is built.
export const exerciseOf = (card, mode) => (mode === 'review' || mode === 'mistakes' || mode === 'mixed' ? (card.kind === 'word' ? 'spell' : 'build') : mode);

// About 20 seconds a card: "about 6 min" for 18 cards; at least one minute while anything is due.
export const minutesFor = due => (due > 0 ? Math.max(1, Math.round((due * 20) / 60)) : 0);

// Progress to the daily goal, 0..1.
export const goalProgress = (done, goal) => (goal > 0 ? Math.max(0, Math.min(1, (Number(done) || 0) / goal)) : 0);

// A small seeded random generator (mulberry32), so the tiles of a card and its gap stay the same while it is shown and in the tests.
export function seeded(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle(list, random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
// A number from a card's id (ids may be numbers or strings).
export const seedOf = value => [...String(value)].reduce((hash, char) => (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0, 7);

// Words too common to be a gap or a distractor.
const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'is', 'are', 'was', 'were', 'be',
  'been', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'we', 'he', 'she', 'they', 'me', 'my', 'your', 'our', 'their', 'his', 'her', 'do',
  'does', 'did', 'not', 'no', 'so', 'if', 'as', 'can', 'will', 'please', 'up', 'out', 'then', 'than', 'there', 'here', 'what', 'when', 'which', 'who']);
const contentWord = word => word.norm.length >= 3 && /^[a-z][a-z'-]*$/.test(word.norm) && !STOP.has(word.norm);

// The tiles of "Build the sentence": every word of the sentence (as written, without the punctuation around it) plus up to `extra` distractors taken
// from the other cards' sentences (content words that are not in this sentence), shuffled. Each tile: { id, text, distractor }.
export function tilesFor(card, others = [], { extra = 3 } = {}) {
  const random = seeded(seedOf(card.id));
  const own = wordsOf(card.en);
  const inSentence = new Set(own.map(word => word.norm));
  const pool = [];
  for (const other of others) {
    if (!other || other.id === card.id || other.kind !== 'sentence') continue;
    for (const word of wordsOf(other.en)) if (contentWord(word) && !inSentence.has(word.norm) && !pool.some(item => item.norm === word.norm)) pool.push(word);
  }
  const distractors = shuffle(pool, random).slice(0, Math.max(0, extra));
  const tiles = [...own.map(word => ({ text: word.text, distractor: false })), ...distractors.map(word => ({ text: word.text, distractor: true }))];
  return shuffle(tiles, random).map((tile, index) => ({ ...tile, id: index }));
}

// The answer of "Build the sentence": the placed tiles, then what was typed after them.
export const builtAnswer = (tiles, placed, typed = '') => [...placed.map(id => (tiles.find(tile => tile.id === id) || {}).text || ''), String(typed || '').trim()].filter(Boolean).join(' ');

// The next word of the sentence that is not placed yet in order (the Hint of "Build the sentence"): the id of an unused tile with that word, or null.
export function hintTile(card, tiles, placed) {
  const want = wordsOf(card.en);
  const have = placed.map(id => normWord((tiles.find(tile => tile.id === id) || {}).text || ''));
  let at = 0;
  while (at < have.length && at < want.length && have[at] === want[at].norm) at += 1;
  if (at < have.length || at >= want.length) return null; // a wrong tile is placed (take it back first), or the sentence is complete
  const free = tiles.find(tile => !placed.includes(tile.id) && normWord(tile.text) === want[at].norm);
  return free ? free.id : null;
}

// The gap of "Fill the gap": one content word of the sentence (the same one for a card each time), with the text before and after it.
// Null when the sentence has no word to take out.
export function gapFor(card) {
  const pieces = String(card.en || '').trim().split(/(\s+)/);
  const candidates = [];
  pieces.forEach((piece, index) => {
    if (/^\s*$/.test(piece)) return;
    const word = { text: piece, norm: normWord(piece) };
    if (contentWord(word)) candidates.push(index);
  });
  if (!candidates.length) return null;
  const at = candidates[Math.floor(seeded(seedOf(card.id))() * candidates.length)];
  const piece = pieces[at];
  const core = normWord(piece);
  // Keep the punctuation around the word outside the gap ("expires." -> gap + ".").
  const start = piece.toLowerCase().indexOf(core);
  const lead = start > 0 ? piece.slice(0, start) : '';
  const word = piece.slice(lead.length, lead.length + core.length);
  const trail = piece.slice(lead.length + core.length);
  return { word, before: pieces.slice(0, at).join('') + lead, after: trail + pieces.slice(at + 1).join('') };
}

// The context line of a word card: its context with the word itself replaced by a gap ("after the session cookie ___"), or '' when there is none.
export function maskedContext(card) {
  const context = String(card.context || '').trim();
  if (!context) return '';
  const word = String(card.en || '').trim();
  if (!word) return context;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return context.replace(new RegExp(`\\b${escaped}\\w*`, 'gi'), '___');
}

// Where a word stands in a sentence as a whole word, whatever the case: the index of its first letter, or -1. A curly apostrophe or a typographic
// dash counts as the straight one. Next to the match there is no letter or digit, nor an apostrophe or hyphen that joins it to one ("session" is not
// in "session's" or "sessions"; "'expires'" in quotes is found).
const unifyChar = char => (/[\u2018\u2019\u02bc]/.test(char) ? "'" : /[\u2010\u2011\u2012\u2013]/.test(char) ? '-' : char);
const letterLike = char => Boolean(char) && /[\p{L}\p{N}]/u.test(char);
const joiner = char => char === "'" || char === '-';
export function findWholeWord(text, word) {
  const source = [...String(text || '')].map(unifyChar);
  const want = [...String(word || '').trim()].map(unifyChar).map(char => char.toLowerCase());
  if (!want.length || want.length > source.length) return -1;
  // Indexes into the original string (a character outside the BMP is two code units there).
  const offsets = [];
  let offset = 0;
  for (const char of String(text || '')) { offsets.push(offset); offset += char.length; }
  for (let i = 0; i + want.length <= source.length; i += 1) {
    if (!want.every((char, k) => source[i + k].toLowerCase() === char)) continue;
    const before = source[i - 1];
    const after = source[i + want.length];
    const openBefore = !letterLike(before) && !(joiner(before) && letterLike(source[i - 2]));
    const openAfter = !letterLike(after) && !(joiner(after) && letterLike(source[i + want.length + 1]));
    if (openBefore && openAfter) return offsets[i];
  }
  return -1;
}

// Spell asks a word from the person's translations inside its sentence ("Spell" in docs/design/learn-english-page.md): exactly when the card has
// the Chinese of that sentence (`context_zh`, from the server) and the word stands in its `context` as a whole word. Returns the sentence split at
// the word, { before, word (as written in the sentence), after, zh }, with the punctuation around the word kept outside it; else null (the meaning
// layout of today, with "Used in" for any other context).
export function sentenceGap(card) {
  if (!card || card.kind === 'sentence') return null;
  const zh = String(card.context_zh || '').trim();
  const context = String(card.context || '').trim();
  const word = String(card.en || '').trim();
  if (!zh || !context || !word) return null;
  const at = findWholeWord(context, word);
  if (at < 0) return null;
  return { before: context.slice(0, at), word: context.slice(at, at + word.length), after: context.slice(at + word.length), zh };
}

// "11-21 09:00" in the browser's time zone ('' for a missing or broken time).
export function shortDateTime(iso) {
  const date = new Date(iso || '');
  if (!iso || Number.isNaN(date.getTime())) return '';
  const two = n => String(n).padStart(2, '0');
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}
const monthDay = iso => shortDateTime(iso).slice(0, 5);

// The caption under the estimated level in Learn settings ("MY LEVEL"): what it was estimated from and when, as translated templates with their
// values, joined with " · " by the page. `level`: the `level` of GET /api/learn/level.
export function levelNote(level) {
  if (!level) return [];
  const answers = Number(level.answers) || 0;
  const mistakes = Number(level.mistakes) || 0;
  const report = monthDay(level.report_at);
  const parts = [report
    ? { template: 'From {1} answers, {2} mistakes and the report of {3}', values: [answers, mistakes, report] }
    : { template: 'From {1} answers and {2} mistakes', values: [answers, mistakes] }];
  const updated = shortDateTime(level.updated_at);
  if (updated) parts.push({ template: 'updated {1}', values: [updated] });
  return parts;
}

// The line under "Picked so far" ("WORDS FROM MY TRANSLATIONS"): "57 words from 91 sentences · 12 skipped (you know them)", and "· 3 waiting" while
// sentences wait to be picked at the current level. `picking`: the `picking` of GET /api/learn/level.
export function pickedNote(picking) {
  if (!picking) return [];
  const n = key => Math.max(0, Number(picking[key]) || 0);
  const parts = [
    { template: '{1} words from {2} sentences', values: [n('picked'), n('sentences')] },
    { template: '{1} skipped (you know them)', values: [n('skipped')] },
  ];
  if (n('pending') > 0) parts.push({ template: '{1} waiting', values: [n('pending')] });
  return parts;
}

// The letter slots of Spell on one line: at the normal size (36px wide, a gap of 8px, a 24px letter) while the word fits the width; else the slots, the
// gaps and the letters shrink together down to SLOT_MIN wide with a 14px letter; only a word longer than that wraps, in rows of even length (never one
// letter alone on a line), each row as large as it fits. Returns { slot, gap, font, height, rows } (rows: the number of letters on each line).
export const SLOT = 36;
export const SLOT_GAP = 8;
export const SLOT_MIN = 18;
export function slotLayout(count, width) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const room = Number(width) > 0 ? Number(width) : Infinity;
  const sized = (perRow, rows) => {
    const slot = Math.min(SLOT, room / (perRow + ((perRow - 1) * SLOT_GAP) / SLOT));
    const scale = slot / SLOT;
    const even = Array.from({ length: rows }, (_, row) => Math.floor(n / rows) + (row < n % rows ? 1 : 0));
    return { slot: Math.floor(slot * 10) / 10, gap: Math.max(2, Math.floor(SLOT_GAP * scale * 10) / 10), font: Math.max(14, Math.round(24 * scale)), height: Math.max(30, Math.round(44 * scale)), rows: even };
  };
  for (let rows = 1; rows <= n; rows += 1) {
    const perRow = Math.ceil(n / rows);
    const fit = sized(perRow, rows);
    if (fit.slot >= SLOT_MIN || perRow === 1) return fit;
  }
  return sized(1, n);
}

// A mixed session: words and sentences taken in turn (free practice when nothing is due), at most `limit` cards, no card twice.
export function mixCards(lists, limit = 20) {
  const seen = new Set();
  const out = [];
  const queues = lists.map(list => [...(list || [])]);
  while (out.length < limit && queues.some(queue => queue.length)) {
    for (const queue of queues) {
      const card = queue.shift();
      if (card && !seen.has(card.id)) { seen.add(card.id); out.push(card); }
      if (out.length >= limit) break;
    }
  }
  return out;
}

// The keys of an exercise on a computer: Enter checks (and, once checked, continues with the offered grade); 1 / 2 / 3 grade a checked answer.
// Returns { action: 'check' | 'grade', grade? } or null.
export function exerciseKey({ key, checked, inField = false, modifiers = false }) {
  if (modifiers) return null;
  if (key === 'Enter') return checked ? { action: 'grade' } : { action: 'check' };
  if (!checked || inField) return null;
  const grade = { 1: 'again', 2: 'hard', 3: 'good' }[key];
  return grade ? { action: 'grade', grade } : null;
}
