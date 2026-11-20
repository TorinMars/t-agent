// The phonetic transcription of an English word (IPA, American English, between slashes, such as /ɪkˈspaɪər/) for the Learn page ("Phonetic
// transcription" in docs/design/learn-english.md). The pronunciations come from the CMU Pronouncing Dictionary, bundled as a compact data file
// (vendor/cmudict/, built by scripts/build-phonetics.js, whose header describes the format) and converted from ARPAbet to IPA here. Nothing is
// asked of an outside service. The file is read the first time a word is looked up, not at start, and the table is let go again after
// `idleMs` without a lookup, so a server that does not practise words keeps no memory for it. A word with no entry gives ''.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const DATA_FILE = path.join(__dirname, '..', 'vendor', 'cmudict', 'cmudict-7479086.txt.br');
const IDLE_MS = 10 * 60 * 1000;

const VOWELS = {
  AA: 'ɑ', AE: 'æ', AH: 'ʌ', AO: 'ɔ', AW: 'aʊ', AY: 'aɪ', EH: 'ɛ', ER: 'ɜr', EY: 'eɪ', IH: 'ɪ', IY: 'i', OW: 'oʊ', OY: 'ɔɪ', UH: 'ʊ', UW: 'u',
};
const UNSTRESSED = { AH: 'ə', ER: 'ər' };
const CONSONANTS = {
  B: 'b', CH: 'tʃ', D: 'd', DH: 'ð', F: 'f', G: 'ɡ', HH: 'h', JH: 'dʒ', K: 'k', L: 'l', M: 'm', N: 'n', NG: 'ŋ', P: 'p', R: 'r', S: 's', SH: 'ʃ',
  T: 't', TH: 'θ', V: 'v', W: 'w', Y: 'j', Z: 'z', ZH: 'ʒ',
};
// The consonant groups that can begin an English syllable: a stress mark goes before the longest of them that ends the consonants before the vowel.
const ONSETS = new Set([
  'P R', 'P L', 'B R', 'B L', 'T R', 'D R', 'K R', 'K L', 'G R', 'G L', 'F R', 'F L', 'TH R', 'SH R', 'V R',
  'S P', 'S T', 'S K', 'S M', 'S N', 'S L', 'S W', 'S F', 'T W', 'D W', 'K W', 'G W', 'TH W', 'HH W',
  'P Y', 'B Y', 'K Y', 'G Y', 'F Y', 'V Y', 'M Y', 'N Y', 'HH Y', 'L Y',
  'S P R', 'S P L', 'S T R', 'S K R', 'S K W', 'S P Y', 'S K Y', 'S K L',
]);
const onsetOk = group => group.length === 0 || (group.length === 1 ? group[0] !== 'NG' : ONSETS.has(group.join(' ')));

const isVowel = phone => /\d$/.test(phone);

// ARPAbet phones (with stress digits, as in CMUdict) -> IPA without the slashes. `mark`: put a stress mark even when there is one vowel only
// (a part of a hyphenated word); a word of one syllable has none otherwise, as in dictionaries.
function arpabetToIpa(phones, { mark = false } = {}) {
  const list = phones.map(phone => String(phone).toUpperCase());
  const vowels = list.map((phone, index) => (isVowel(phone) ? index : -1)).filter(index => index >= 0);
  const marks = new Map(); // phone index -> mark
  if (vowels.length > 1 || mark) {
    let previousVowel = -1;
    for (const at of vowels) {
      const stress = list[at].slice(-1);
      if (stress === '1' || stress === '2' || (mark && vowels.length === 1)) {
        let start = at;
        const before = list.slice(previousVowel + 1, at);
        // The longest legal onset that ends right before the vowel (at the start of the word every consonant before the vowel belongs to it).
        let size = previousVowel < 0 ? before.length : 0;
        if (previousVowel >= 0) for (let take = before.length; take > 0; take -= 1) if (onsetOk(before.slice(before.length - take))) { size = take; break; }
        start = at - size;
        marks.set(start, stress === '2' ? 'ˌ' : 'ˈ');
      }
      previousVowel = at;
    }
  }
  let out = '';
  list.forEach((phone, index) => {
    if (marks.has(index)) out += marks.get(index);
    if (isVowel(phone)) {
      const base = phone.slice(0, -1);
      const stress = phone.slice(-1);
      let sound = stress === '0' && UNSTRESSED[base] ? UNSTRESSED[base] : VOWELS[base] || '';
      // A diphthong before an R that ends the syllable gets a schwa, as dictionaries write it: fire /faɪər/, expire /ɪkˈspaɪər/, our /aʊər/.
      if ((base === 'AY' || base === 'AW' || base === 'OY') && list[index + 1] === 'R' && !(list[index + 2] && isVowel(list[index + 2]))) sound += 'ə';
      out += sound;
    } else out += CONSONANTS[phone] || '';
  });
  return out;
}

// The data file's text -> Map word -> ARPAbet phones (string with spaces).
function parseData(text) {
  const lines = String(text).split('\n');
  const header = lines[0] || '';
  if (!header.startsWith('#cmudict ')) throw new Error('Not a phonetics data file');
  const symbols = header.split(' ').slice(2);
  const table = new Map();
  let previous = '';
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const space = line.indexOf(' ');
    const word = previous.slice(0, Number(line[0])) + line.slice(1, space);
    let phones = '';
    for (let at = space + 1; at < line.length; at += 1) phones += (phones ? ' ' : '') + symbols[line.charCodeAt(at) - 48];
    table.set(word, phones);
    previous = word;
  }
  return table;
}

const SIBILANT = new Set(['S', 'Z', 'SH', 'ZH', 'CH', 'JH']);
const VOICELESS = new Set(['P', 'T', 'K', 'F', 'TH']);
// The possessive of a word ("server's"): its phones plus -s, -z or -ɪz.
const possessive = phones => {
  const last = phones[phones.length - 1];
  return [...phones, ...(SIBILANT.has(last) ? ['IH0', 'Z'] : VOICELESS.has(last) ? ['S'] : ['Z'])];
};

// `file`: the data file; `read`: reads it (tests pass a fixture); `now` and timers for the idle release.
function createPhonetics({ file = DATA_FILE, read = null, idleMs = IDLE_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let table = null;
  let failed = false;
  let idle = null;
  const load = () => {
    if (table || failed) return table;
    try {
      const text = read ? read() : zlib.brotliDecompressSync(fs.readFileSync(file)).toString('utf8');
      table = parseData(text);
    } catch (error) {
      failed = true; // a missing or broken file: every word has no entry (logged once)
      console.warn(`[phonetics] the pronunciation data could not be read (${error.message}); words are shown without a transcription`);
    }
    return table;
  };
  const touch = () => {
    if (!idleMs) return;
    if (idle) clearTimer(idle);
    idle = setTimer(() => { table = null; idle = null; }, idleMs);
    if (idle && typeof idle.unref === 'function') idle.unref();
  };
  const phonesOf = (data, word) => {
    const found = data.get(word);
    if (found) return found.split(' ');
    if (word.endsWith("'s") && data.has(word.slice(0, -2))) return possessive(data.get(word.slice(0, -2)).split(' '));
    return null;
  };

  // The transcription of one word ('' when the dictionary does not have it): case does not matter, a curly apostrophe is a straight one, and a
  // hyphenated word missing as a whole is made of its parts (each part needs an entry; the first keeps the main stress, the others get a secondary one).
  function lookup(value) {
    const word = String(value || '').trim().toLowerCase().replace(/’/g, "'");
    if (!/^[a-z][a-z'-]*$/.test(word) || word.length > 40) return '';
    const data = load();
    touch();
    if (!data) return '';
    const whole = phonesOf(data, word);
    if (whole) return `/${arpabetToIpa(whole)}/`;
    const parts = word.split('-').filter(Boolean);
    if (parts.length < 2) return '';
    const sounds = [];
    for (const [index, part] of parts.entries()) {
      const phones = phonesOf(data, part);
      if (!phones) return '';
      const ipa = arpabetToIpa(phones, { mark: true });
      sounds.push(index ? ipa.replace(/ˈ/g, 'ˌ') : ipa);
    }
    return `/${sounds.join('')}/`;
  }
  return { lookup, loaded: () => Boolean(table) };
}

let shared = null;
const lookupPhonetic = word => { if (!shared) shared = createPhonetics(); return shared.lookup(word); };

// A transcription from somewhere else (the translator's model, a linked device): IPA between slashes, one line, at most 60 characters; else ''.
function cleanPhonetic(value) {
  if (typeof value !== 'string') return '';
  let text = value.trim().replace(/\s+/g, ' ');
  if (!text) return '';
  if (!text.startsWith('/')) text = `/${text}`;
  if (!text.endsWith('/') || text.length < 3) text = `${text}/`;
  if (text.length > 60 || /[<>{}\\\u0000-\u001f]/.test(text) || /[\u3400-\u9fff]/.test(text) || !/^\/[^/]+\/$/.test(text)) return '';
  return text;
}

module.exports = { arpabetToIpa, parseData, createPhonetics, lookupPhonetic, cleanPhonetic, DATA_FILE };
