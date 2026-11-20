#!/usr/bin/env node
// Builds the pronunciation data of the Learn page ("Phonetic transcription" in docs/design/learn-english.md) from the CMU Pronouncing Dictionary
// (cmudict.dict of github.com/cmusphinx/cmudict, BSD licence, vendor/cmudict/LICENSE). scripts/fetch-vendor.js downloads the pinned source named
// in the `data` part of scripts/vendor-libs.json, checks its SHA-256, calls `build` and checks the SHA-256 of the text it made.
//
// The data file (services/phonetics.js reads it; the contract):
// - Brotli-compressed UTF-8 text, lines separated by "\n".
// - Line 1: "#cmudict <version> <SYMBOL> <SYMBOL> ...": the ARPAbet symbols with their stress digit (AA0 ... ZH); the i-th symbol is written as the
//   character with the code 48 + i in the lines below.
// - Every other line: "<k><rest> <codes>", sorted by word: <k> is one digit, the number of leading characters shared with the word of the line before
//   (at most 9), <rest> the rest of the word, <codes> its first pronunciation, one character per symbol.
// - Words are lower case: letters, apostrophes and hyphens. A possessive "<word>'s" whose word is there is left out (services/phonetics.js derives it).
//
// node scripts/build-phonetics.js <cmudict.dict> <out.txt.br> [version]
const fs = require('node:fs');
const zlib = require('node:zlib');

const WORD = /^[a-z][a-z'-]*$/;

// The dictionary text -> the data file's text (not compressed).
function encode(source, version) {
  const entries = new Map();
  for (const line of String(source).split('\n')) {
    const clean = line.replace(/#.*/, '').trim();
    if (!clean) continue;
    const [word, ...phones] = clean.split(/\s+/);
    if (/\(\d+\)$/.test(word) || !WORD.test(word) || !phones.length || entries.has(word)) continue; // the first pronunciation only
    entries.set(word, phones);
  }
  for (const word of [...entries.keys()]) if (word.endsWith("'s") && entries.has(word.slice(0, -2))) entries.delete(word);
  const symbols = [...new Set([...entries.values()].flat())].sort();
  if (symbols.length > 70) throw new Error(`Too many phone symbols: ${symbols.length}`);
  const code = new Map(symbols.map((symbol, index) => [symbol, String.fromCharCode(48 + index)]));
  const lines = [`#cmudict ${version} ${symbols.join(' ')}`];
  let previous = '';
  for (const word of [...entries.keys()].sort()) {
    let shared = 0;
    while (shared < 9 && shared < previous.length && shared < word.length && previous[shared] === word[shared]) shared += 1;
    lines.push(`${shared}${word.slice(shared)} ${entries.get(word).map(phone => code.get(phone)).join('')}`);
    previous = word;
  }
  return `${lines.join('\n')}\n`;
}

const compress = text => zlib.brotliCompressSync(Buffer.from(text, 'utf8'), {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: text.length },
});

// The source file -> { text, file }: the data text (its SHA-256 is pinned in the manifest) and the compressed file to write.
function build(sourceBuffer, version) {
  const text = encode(sourceBuffer.toString('utf8'), version);
  return { text, file: compress(text) };
}

module.exports = { encode, build, compress };

if (require.main === module) {
  const [source, out, version = 'local'] = process.argv.slice(2);
  if (!source || !out) { console.error('Usage: node scripts/build-phonetics.js <cmudict.dict> <out.txt.br> [version]'); process.exit(1); }
  const { text, file } = build(fs.readFileSync(source), version);
  fs.writeFileSync(out, file);
  console.log(`${out}: ${text.split('\n').length - 2} words, ${file.length} bytes`);
}
