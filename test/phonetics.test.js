// The phonetic transcription of the Learn page (services/phonetics.js, scripts/build-phonetics.js; "Phonetic transcription" in
// docs/design/learn-english.md): ARPAbet to IPA, the data file's format on a tiny fixture, the lookup (known words, an unknown word, case, a
// hyphenated word, a possessive), the idle release with a fake timer, a missing file, and the bundled file against its pinned checksums.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-phonetics-'));

const { arpabetToIpa, parseData, createPhonetics, cleanPhonetic, lookupPhonetic, DATA_FILE } = require('../services/phonetics');
const { encode } = require('../scripts/build-phonetics');

const ROOT = path.join(__dirname, '..');
const FIXTURE = [
  ';;; a CMUdict-style fixture',
  'expire IH0 K S P AY1 R',
  'expire(2) EH0 K S P AY1 ER0',
  'merge M ER1 JH',
  'follow F AA1 L OW0',
  'up AH1 P',
  'check CH EH1 K',
  'in IH0 N',
  'server S ER1 V ER0',
  "server's S ER1 V ER0 Z",
  'cache K AE1 SH',
  'timeout T AY1 M AW2 T',
  'aalborg AO1 L B AO0 R G # place, danish',
  'x-ray EH1 K S R EY2',
  'R2D2 AA1 R T UW1 D IY1 T UW1',
].join('\n');

const fixture = (options = {}) => createPhonetics({ read: () => encode(FIXTURE, 'test'), idleMs: 0, ...options });

test('ARPAbet becomes American IPA with stress marks before the syllable', () => {
  assert.equal(arpabetToIpa(['IH0', 'K', 'S', 'P', 'AY1', 'R']), 'ɪkˈspaɪər', 'a diphthong before a final R gets a schwa; the mark goes before "sp"');
  assert.equal(arpabetToIpa(['M', 'ER1', 'JH']), 'mɜrdʒ', 'one syllable: no mark');
  assert.equal(arpabetToIpa(['M', 'ER1', 'JH'], { mark: true }), 'ˈmɜrdʒ');
  assert.equal(arpabetToIpa(['T', 'AY1', 'M', 'AW2', 'T']), 'ˈtaɪˌmaʊt', 'a secondary stress');
  assert.equal(arpabetToIpa(['AH0', 'B', 'AW1', 'T']), 'əˈbaʊt', 'an unstressed AH is a schwa');
  assert.equal(arpabetToIpa(['K', 'AH0', 'M', 'P', 'Y', 'UW1', 'T', 'ER0']), 'kəmˈpjutər', 'the onset "pj"; an unstressed ER is "ər"');
  assert.equal(arpabetToIpa(['P', 'AY1', 'R', 'AH0', 'T']), 'ˈpaɪrət', 'no schwa when a vowel follows the R');
  assert.equal(arpabetToIpa(['S', 'T', 'R', 'IH1', 'NG']), 'strɪŋ');
  assert.equal(arpabetToIpa(['D', 'IH0', 'P', 'L', 'OY1']), 'dɪˈplɔɪ');
  assert.equal(arpabetToIpa(['G', 'IH1', 'T']), 'ɡɪt', 'the IPA g');
});

test('the data file: a header with the symbols, front-coded sorted words, first pronunciations only, possessives left to the lookup', () => {
  const text = encode(FIXTURE, 'test');
  const lines = text.trim().split('\n');
  assert.match(lines[0], /^#cmudict test AA1 /);
  assert.ok(!text.includes('(2)'), 'no second pronunciation');
  assert.ok(!text.includes("server's"), 'a possessive of a word that is there is derived');
  assert.ok(!/r2d2/i.test(text), 'only letters, apostrophes and hyphens');
  const table = parseData(text);
  assert.equal(table.get('expire'), 'IH0 K S P AY1 R');
  assert.equal(table.get('aalborg'), 'AO1 L B AO0 R G', 'a comment is dropped');
  assert.equal(table.get('x-ray'), 'EH1 K S R EY2');
  assert.equal(table.size, 11);
  assert.throws(() => parseData('not a data file'), /Not a phonetics data file/);
});

test('lookup: known words, an unknown word, case, a curly apostrophe, a hyphenated word made of its parts, a possessive', () => {
  const phonetics = fixture();
  assert.equal(phonetics.loaded(), false, 'nothing is read before the first lookup');
  assert.equal(phonetics.lookup('expire'), '/ɪkˈspaɪər/');
  assert.equal(phonetics.loaded(), true);
  assert.equal(phonetics.lookup('Expire'), '/ɪkˈspaɪər/', 'case does not matter');
  assert.equal(phonetics.lookup('  MERGE '), '/mɜrdʒ/');
  assert.equal(phonetics.lookup('idempotent'), '', 'a word with no entry');
  assert.equal(phonetics.lookup('x-ray'), '/ˈɛksˌreɪ/', 'a hyphenated word in the dictionary as a whole');
  assert.equal(phonetics.lookup('follow-up'), '/ˈfɑloʊˌʌp/', 'made of its parts: the first keeps the main stress');
  assert.equal(phonetics.lookup('check-in'), '/ˈtʃɛkˌɪn/');
  assert.equal(phonetics.lookup('follow-nothing'), '', 'every part needs an entry');
  assert.equal(phonetics.lookup("server's"), '/ˈsɜrvərz/');
  assert.equal(phonetics.lookup('server’s'), '/ˈsɜrvərz/', 'a curly apostrophe');
  assert.equal(phonetics.lookup("cache's"), '/ˈkæʃɪz/', 'after a sibilant: -ɪz');
  for (const bad of ['', 'two words', 'x2', '-up', null, 'a'.repeat(41)]) assert.equal(phonetics.lookup(bad), '', String(bad));
});

test('the table is let go after a while without a lookup and read again on the next one', () => {
  let reads = 0;
  const timers = [];
  const phonetics = createPhonetics({
    read: () => { reads += 1; return encode(FIXTURE, 'test'); }, idleMs: 1000,
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: timer => { timer.cleared = true; },
  });
  phonetics.lookup('merge');
  phonetics.lookup('cache');
  assert.equal(reads, 1);
  assert.equal(timers.filter(timer => !timer.cleared).length, 1, 'one pending release');
  timers.find(timer => !timer.cleared).fn();
  assert.equal(phonetics.loaded(), false);
  assert.equal(phonetics.lookup('merge'), '/mɜrdʒ/');
  assert.equal(reads, 2);
});

test('a missing data file gives no transcription and does not throw', t => {
  const warn = t.mock.method(console, 'warn', () => {});
  const phonetics = createPhonetics({ file: path.join(os.tmpdir(), 'no-such-phonetics-file.br'), idleMs: 0 });
  assert.equal(phonetics.lookup('merge'), '');
  assert.equal(phonetics.lookup('cache'), '');
  assert.equal(warn.mock.callCount(), 1, 'logged once');
});

test('a transcription from elsewhere is cleaned: slashes added, odd text refused', () => {
  assert.equal(cleanPhonetic('/rɪˈzɑlv/'), '/rɪˈzɑlv/');
  assert.equal(cleanPhonetic(' rɪˈzɑlv '), '/rɪˈzɑlv/');
  for (const bad of ['', '  ', 5, null, '/a/b/', `/${'a'.repeat(70)}/`, '/<b>/', '/\u4e2d/']) assert.equal(cleanPhonetic(bad), '', String(bad));
});

test('the bundled data: the pinned file and licence match the manifest, and common words have their transcription', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/vendor-libs.json'), 'utf8'));
  const [item] = manifest.data;
  assert.equal(path.join(ROOT, item.file), DATA_FILE);
  assert.ok(item.url.includes('@') && /^[0-9a-f]{64}$/.test(item.sha256), 'a pinned source with its hash');
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  assert.equal(sha(zlib.brotliDecompressSync(fs.readFileSync(DATA_FILE))), item.content_sha256, 'run node scripts/fetch-vendor.js after changing the build');
  assert.equal(sha(fs.readFileSync(path.join(ROOT, item.license))), item.license_sha256);
  assert.match(fs.readFileSync(path.join(ROOT, item.license), 'utf8'), /Carnegie Mellon University/);
  assert.ok(fs.statSync(DATA_FILE).size < 700 * 1024, 'the data file stays small');
  assert.equal(lookupPhonetic('expire'), '/ɪkˈspaɪər/');
  assert.equal(lookupPhonetic('deploy'), '/dɪˈplɔɪ/');
  assert.equal(lookupPhonetic('latency'), '/ˈleɪtənsi/');
});
