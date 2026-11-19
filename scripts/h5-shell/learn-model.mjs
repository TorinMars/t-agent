// The rules of the Learn page that need no DOM (pure functions with unit tests): which exercise a card gets, the word tiles of "Build the sentence",
// the gap of "Fill the gap", the time estimate of the home, the order of a mixed session, the keys of a computer. See "The Learn page" in
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
