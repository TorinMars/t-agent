// English learning ("Learn English" in docs/design/learn-english.md): the cards of an owner (their own translated sentences, the words they looked up,
// the starter list), spaced review (services/learn-review.js), the practice queues, the mistakes, the day's numbers and the settings. Stored in
// learn_cards and learn_reviews (schema 13) and the system_state key `learn_v1:<owner>`. Meanings come from the translator the person already set
// up, through `lookupWord` (routes/learn.js hands in the same path as POST /api/translate/word); no other outside service is called.
// Every change stamps the hybrid clock and the change number of the sync (services/learn-sync-store.js, "Sync across linked devices" there): the
// content clock for an edit, the review-state clock for an answer, a random id for an answer, and a move record when a card's text changes.
// A word card's phonetic transcription (`phonetic`, schema 15) comes from the bundled dictionary (services/phonetics.js) and, for a word it does not
// have, from the translator's answer; like a filled-in meaning it keeps the content clock ("Phonetic transcription" in docs/design/learn-english.md).
// A word picked from a translated sentence (services/learn-pick.js) has that sentence as its context; every card JSON carries `context_zh`, the Chinese
// of the sentence card whose English is the card's context ("Picking words from translations" in docs/design/learn-english.md). The estimated level
// of the person is kept in `learn_level_v1:<owner>` and synced like the settings.
const { readState, writeState, isPlainObject } = require('./settings-sync-store');
const syncStore = require('./learn-sync-store');
const review = require('./learn-review');
const { STARTER_LISTS, STARTER_PER_DAY } = require('./learn-starter');
const phonetics = require('./phonetics');

const KINDS = ['word', 'sentence'];
const SOURCES = ['translation', 'lookup', 'starter', 'manual'];
const MODES = ['review', 'spell', 'build', 'dictation', 'say', 'fill', 'mistakes'];
const SENTENCE_MODES = ['build', 'dictation', 'say', 'fill'];
const COLLECTED = ['translation', 'lookup']; // the sources the "collect" switch controls
const MAX_SENTENCE = 300;
const MAX_WORD = 40;
const MAX_ZH = 500;
const MAX_CONTEXT = 120;
// A word picked from a translation has the whole sentence as its context: up to the sentence limit (other contexts keep MAX_CONTEXT).
const MAX_PICK_CONTEXT = MAX_SENTENCE;
// The levels an estimate can give (CEFR), lowest first ("Your level" in docs/design/learn-english.md).
const LEVELS = ['A2', 'B1', 'B2', 'C1'];
const MAX_LEVEL_LABEL = 40;
const MAX_LEVEL_REASON = 200;
const MAX_ANSWER = 500;
const MAX_LIMIT = 100;
const MEANING_CACHE_SIZE = 1000;
const MEANING_CONCURRENCY = 4;
// A practice queue waits for the meanings and transcriptions of its first cards only (the one shown first and the next); the others are looked up
// in the background, so a list of new words does not wait for the translator once per word ("Practice queues load fast" in
// docs/design/learn-english.md).
const QUEUE_HEAD = 2;
// The word cards translated ahead of time in one call of prefill() (services/learn-prefill.js calls it batch after batch; "Meanings are translated
// ahead of time" in docs/design/learn-english.md).
const PREFILL_BATCH = 40;
// The audio of the practice ("Audio" in docs/design/learn-english-page.md): each field with its default and its allowed values. Shared like the other
// learning settings (the same on every device and linked engine).
const AUDIO_SETTINGS = {
  audio_words: { default: true, values: [true, false] }, // a word is read when its card appears and once more after the answer
  audio_sentences: { default: true, values: [true, false] },
  audio_sentences_at: { default: 'after', values: ['after', 'start'] }, // Build, Fill the gap and a sentence in Review (Dictation and Say it: at the start)
  audio_repeat: { default: 2, values: [1, 2, 3, 5] },
  audio_pause: { default: 2, values: [1, 2, 3] }, // seconds between repeats
  audio_speed: { default: 'normal', values: ['normal', 'slow'] },
  audio_stop_on_typing: { default: true, values: [true, false] },
};
// The mistake analysis ("Mistake reports" in docs/design/learn-english.md): the weekly automatic report on or off, the report the person last opened
// (so the Learn home offers a new automatic one once, on every device) and the language reports are written in (the page's language, sent by the page).
const REPORT_SETTINGS = {
  analysis_auto: { default: true, check: value => typeof value === 'boolean' },
  report_seen: { default: '', check: value => typeof value === 'string' && /^[A-Za-z0-9-]{0,64}$/.test(value) },
  report_lang: { default: 'en', check: value => value === 'en' || value === 'zh' },
};
// Words from the person's translations ("Picking words from translations" in docs/design/learn-english.md): on by default.
const PICK_SETTINGS = {
  pick_words: { default: true, check: value => typeof value === 'boolean' },
};
// The fields checked by a rule (REPORT_SETTINGS and PICK_SETTINGS), read, saved and merged the same way.
const CHECKED_SETTINGS = { ...REPORT_SETTINGS, ...PICK_SETTINGS };
const SETTINGS_FIELDS = new Set(['collect', 'daily_goal', 'starter', ...Object.keys(AUDIO_SETTINGS), ...Object.keys(CHECKED_SETTINGS)]);
const DEFAULT_SETTINGS = {
  collect: true, daily_goal: 20, starter: 'dev', ...Object.fromEntries(Object.entries(AUDIO_SETTINGS).map(([key, field]) => [key, field.default])),
  ...Object.fromEntries(Object.entries(CHECKED_SETTINGS).map(([key, field]) => [key, field.default])),
};
// The first tag of a wrong answer, from the page's checker (scripts/h5-shell/learn-grade.mjs MISTAKE_TAGS, the same list).
const MISTAKE_TAGS = ['letter-order', 'double-letter', 'missing-letter', 'extra-letter', 'wrong-letter', 'spelling', 'article', 'plural', 'tense',
  'verb-form', 'word-order', 'missing-word', 'extra-word', 'wrong-word', 'listening', 'pronunciation', 'unknown', 'other'];
const MAX_EXPECTED = 300;
const MISTAKES_PAGE = 200;

const WORD = /^[A-Za-z][A-Za-z'-]{0,39}$/;
const LETTER_WORD = /[A-Za-z][A-Za-z'-]*/g;
const URL = /\b(?:https?:\/\/|www\.)\S+/gi;
const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;

class LearnError extends Error {
  constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; }
}
const bad = message => new LearnError(message, 400);

const collapse = value => String(value).replace(/\s+/g, ' ').trim();
const normalize = text => collapse(text).toLowerCase();
// A word as it is kept: curly apostrophes made straight; lower case, except a word with two or more capitals (an acronym such as API or OAuth).
function wordForm(value) {
  const word = collapse(value).replace(/\u2019/g, "'");
  return (word.match(/[A-Z]/g) || []).length >= 2 ? word : word.toLowerCase();
}

// Text that is code, a command or a link rather than an English sentence: braces, two or more semicolons, an arrow or a shell operator, a fence, a
// slash command, a prompt sign at the start, or more than one character in seven that is a symbol outside ordinary sentence punctuation.
function codeLike(text) {
  if (/[{}]/.test(text) || (text.match(/;/g) || []).length >= 2) return true;
  if (/=>|&&|\|\||```|<\/|::|\$\(/.test(text)) return true;
  if (/^\s*(?:[/$#>]|\w+\s*=\s)/.test(text)) return true;
  const symbols = (text.replace(URL, '').match(/[^A-Za-z0-9\s.,!?'"\u2019()\-:]/g) || []).length;
  return symbols * 7 > text.length;
}

// Checks the English text of a card of that kind and returns it as it is kept, or throws a LearnError with the reason.
function checkEnglish(kind, value) {
  if (typeof value !== 'string') throw bad('Enter the English text');
  if (kind === 'word') {
    const word = wordForm(value);
    if (!word) throw bad('Enter the English text');
    if (word.length > MAX_WORD) throw bad(`A word can have at most ${MAX_WORD} characters`);
    if (!WORD.test(word)) throw bad('A word can only have letters, a hyphen or an apostrophe');
    return word;
  }
  const sentence = collapse(value);
  if (!sentence) throw bad('Enter the English text');
  if (sentence.length > MAX_SENTENCE) throw bad(`A sentence can have at most ${MAX_SENTENCE} characters`);
  if (CJK.test(sentence)) throw bad('The sentence must be English');
  if ((sentence.replace(URL, ' ').match(LETTER_WORD) || []).length < 3) throw bad('A sentence needs at least three words');
  if (codeLike(sentence)) throw bad('This looks like code or a command, not a sentence');
  return sentence;
}
function checkMeaning(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw bad('Invalid meaning');
  const text = value.trim();
  if (text.length > MAX_ZH) throw bad(`The meaning can have at most ${MAX_ZH} characters`);
  return text;
}
// Where a card came from (a task title): one line, cut to MAX_CONTEXT characters.
function checkContext(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw bad('Invalid context');
  return collapse(value).slice(0, MAX_CONTEXT);
}
const checkId = value => {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new LearnError('Card not found', 404);
  return id;
};
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
// SQL on a learn_cards row: a word asked inside one of the owner's translated sentences (its context is the English of a translation sentence card).
const FROM_TRANSLATION = `(learn_cards.kind = 'word' AND learn_cards.context <> '' AND EXISTS (SELECT 1 FROM learn_cards s WHERE s.owner = learn_cards.owner
  AND s.kind = 'sentence' AND s.source = 'translation' AND s.en = learn_cards.context))`;

// The detail kept with an answer: for a wrong one what was asked for (the page sends the gap word of Fill the gap; else the card's text), the first tag
// of the page's checker (a tag this version does not know is kept as none) and whether help was used; for a right one none.
function mistakeDetail(body, row) {
  if (body.correct) return { expected: null, tag: '', hinted: 0 };
  if (body.expected !== undefined && body.expected !== null && typeof body.expected !== 'string') throw bad('Invalid answer');
  if (body.tag !== undefined && body.tag !== null && typeof body.tag !== 'string') throw bad('Invalid answer');
  const expected = typeof body.expected === 'string' && collapse(body.expected) ? collapse(body.expected).slice(0, MAX_EXPECTED) : row.en;
  return { expected, tag: MISTAKE_TAGS.includes(body.tag) ? body.tag : '', hinted: body.hinted === true ? 1 : 0 };
}
// A wrong answer for the Mistakes list and the analysis. Answers from before schema 17 have no tag and expect the card's text.
function mistakeJson(row) {
  return {
    uid: row.uid, at: iso(row.at), mode: row.mode, tag: row.tag || '', hinted: Boolean(row.hinted), expected: row.expected || row.en, written: row.answer || '',
    card: { id: row.card_id, kind: row.kind, en: row.en },
  };
}
// A stored report as the page gets it: the numbers, and with `full` the summary, the kinds and the findings.
function reportJson(row, { full = true } = {}) {
  let body = {};
  try { body = JSON.parse(row.body); } catch { body = {}; }
  const out = {
    uid: row.uid, created_at: iso(row.created_at), covers_from: iso(row.covers_from), covers_until: iso(row.covers_until), auto: Boolean(row.auto), lang: row.lang,
    mistakes: row.mistakes, answers: row.answers, summary: typeof body.summary === 'string' ? body.summary : '',
  };
  if (full) Object.assign(out, { kinds: Array.isArray(body.kinds) ? body.kinds : [], findings: Array.isArray(body.findings) ? body.findings : [], model: row.model || '' });
  return out;
}

// The JSON of a card for the page. Times are ISO 8601 strings. `contexts`: the Chinese of the sentence cards by their English (contextZh below), so a
// word asked inside one of the person's sentences carries that sentence's Chinese as `context_zh` ('' for every other card).
function cardJson(row, contexts = null) {
  return {
    id: row.id, kind: row.kind, en: row.en, zh: row.zh, phonetic: row.phonetic || '', source: row.source, context: row.context,
    context_zh: row.kind === 'word' && row.context && contexts ? contexts.get(row.context) || '' : '',
    due_at: iso(row.due_at), interval_days: row.interval_days, ease: row.ease, reps: row.reps, lapses: row.lapses,
    last_result: row.last_result || null, last_at: iso(row.last_at), suspended: Boolean(row.suspended), created_at: iso(row.created_at),
  };
}

const settingsKey = owner => `learn_v1:${owner}`;
// The estimated English level of an owner with its sync version: { level, label, reason, answers, mistakes, report_at, updated_at, at, by, seq }
// (times in ms; `at` the hybrid clock, `by` '' for this device, `seq` its change number). The newest estimate wins in the sync.
const levelKey = owner => `learn_level_v1:${owner}`;
// A stored level as the page gets it, or null.
function levelJson(value) {
  if (!isPlainObject(value) || !LEVELS.includes(value.level)) return null;
  return {
    level: value.level, label: typeof value.label === 'string' ? value.label : '', reason: typeof value.reason === 'string' ? value.reason : '',
    answers: Number.isSafeInteger(value.answers) ? value.answers : 0, mistakes: Number.isSafeInteger(value.mistakes) ? value.mistakes : 0,
    report_at: iso(value.report_at), updated_at: iso(value.updated_at),
  };
}
// The version of an owner's learning settings for the sync: { at, by, seq } (hybrid clock, '' for this device, change number).
const settingsVersionKey = owner => `learn_v1_sync:${owner}`;

// `cacheOnly()`: this machine is a company computer whose learning data lives on a normal machine (services/learn-sync.js); it then imports no
// starter list of its own (the cards come from that machine). `lookupPhonetic(word)`: the dictionary's transcription or '' (tests hand in a fixture).
// `onNewWords(owner)`: new word cards were stored (a starter list, an added word, a word with another text); by default the background translation
// of services/learn-prefill.js is told, which does nothing unless the server started it.
function createLearn({
  db = require('../db'), now = Date.now, timeZone, lookupWord = null, cacheOnly = () => false, lookupPhonetic = phonetics.lookupPhonetic,
  onNewWords = owner => require('./learn-prefill').afterNewWords(owner),
} = {}) {
  const meanings = new Map(); // `${owner}|${word}` -> zh, least recently used first
  const askedPhonetic = new Set(); // `${owner}|${norm}` the translator was asked for a transcription (once per word while the server runs)
  const lookingUp = new Map(); // `${owner}|${norm}` -> the meaning lookup in progress, so the queue's background fill and the page's /meaning ask once
  let translatorDown = false; // the last meaning lookup failed: until one works again, a queue leaves out words that have no meaning yet
  let background = Promise.resolve(); // the queue's last background fill (tests wait for it with settle())
  const unreadableWords = new Set(); // `${owner}|${norm}` whose translator answer could not be read: prefill() leaves them to the queue while the server runs
  const newWords = owner => { try { onNewWords(owner); } catch { /* the hourly run translates them */ } };
  const stamp = () => syncStore.stamp(db, now());
  const seq = () => syncStore.nextSeq(db);
  const changed = () => syncStore.learnChanged(db);
  function settingsChanged(owner) {
    writeState(db, settingsVersionKey(owner), { at: stamp(), by: '', seq: seq() });
    changed();
  }

  function settings(owner) {
    const stored = readState(db, settingsKey(owner));
    const value = isPlainObject(stored) ? stored : {};
    return {
      collect: typeof value.collect === 'boolean' ? value.collect : DEFAULT_SETTINGS.collect,
      daily_goal: Number.isInteger(value.daily_goal) && value.daily_goal >= 1 && value.daily_goal <= 200 ? value.daily_goal : DEFAULT_SETTINGS.daily_goal,
      starter: value.starter === null || Object.hasOwn(STARTER_LISTS, value.starter) ? value.starter : DEFAULT_SETTINGS.starter,
      ...Object.fromEntries(Object.entries(AUDIO_SETTINGS).map(([key, field]) => [key, field.values.includes(value[key]) ? value[key] : field.default])),
      ...Object.fromEntries(Object.entries(CHECKED_SETTINGS).map(([key, field]) => [key, field.check(value[key]) ? value[key] : field.default])),
    };
  }
  function saveSettings(owner, body) {
    if (!isPlainObject(body) || Object.keys(body).some(key => !SETTINGS_FIELDS.has(key))) throw bad('Invalid learning settings');
    const next = settings(owner);
    if (body.collect !== undefined) {
      if (typeof body.collect !== 'boolean') throw bad('Invalid learning settings');
      next.collect = body.collect;
    }
    if (body.daily_goal !== undefined) {
      if (!Number.isInteger(body.daily_goal) || body.daily_goal < 1 || body.daily_goal > 200) throw bad('The daily goal must be a whole number from 1 to 200');
      next.daily_goal = body.daily_goal;
    }
    if (body.starter !== undefined) {
      if (body.starter !== null && !Object.hasOwn(STARTER_LISTS, body.starter)) throw bad('Unknown starter list');
      next.starter = body.starter;
    }
    for (const [key, field] of Object.entries(AUDIO_SETTINGS)) {
      if (body[key] === undefined) continue;
      if (!field.values.includes(body[key])) throw bad('Invalid audio setting');
      next[key] = body[key];
    }
    for (const [key, field] of Object.entries(CHECKED_SETTINGS)) {
      if (body[key] === undefined) continue;
      if (!field.check(body[key])) throw bad('Invalid learning settings');
      next[key] = body[key];
    }
    writeState(db, settingsKey(owner), next);
    settingsChanged(owner);
    if (next.starter) importStarter(owner, next.starter);
    return next;
  }

  // Cards that are shown at all: not suspended, and not an untouched starter word while no starter list is chosen.
  const visible = "suspended = 0 AND NOT (source = 'starter' AND reps = 0 AND @starter IS NULL)";
  const getCard = (owner, id) => db.prepare('SELECT * FROM learn_cards WHERE owner = ? AND id = ?').get(owner, id);
  const mustCard = (owner, id) => {
    const row = getCard(owner, checkId(id));
    if (!row) throw new LearnError('Card not found', 404);
    return row;
  };

  // The Chinese of the sentence cards whose English is the context of one of these word cards: Map en -> zh (a join at read time, so a meaning edited
  // on the sentence shows at once and nothing more is stored or synced).
  function contextZh(owner, rows) {
    const wanted = [...new Set(rows.filter(row => row.kind === 'word' && row.context).map(row => row.context))];
    if (!wanted.length) return new Map();
    const found = db.prepare("SELECT en, zh FROM learn_cards WHERE owner = ? AND kind = 'sentence' AND en IN (SELECT value FROM json_each(?))").all(owner, JSON.stringify(wanted));
    return new Map(found.map(row => [row.en, row.zh]));
  }
  const cardsJson = (owner, rows) => { const contexts = contextZh(owner, rows); return rows.map(row => cardJson(row, contexts)); };
  const oneCard = (owner, row) => cardsJson(owner, [row])[0];

  // A card is created once per owner, kind and normalized text; adding it again returns the card there, with an empty meaning filled in.
  function addCard(owner, body) {
    if (!isPlainObject(body)) throw bad('Invalid card');
    if (!KINDS.includes(body.kind)) throw bad('The kind must be word or sentence');
    const source = body.source === undefined ? 'manual' : body.source;
    if (!SOURCES.includes(source)) throw bad('Unknown card source');
    const en = checkEnglish(body.kind, body.en);
    const zh = checkMeaning(body.zh);
    const context = checkContext(body.context);
    if (body.phonetic !== undefined && body.phonetic !== null && typeof body.phonetic !== 'string') throw bad('Invalid card');
    // A word's transcription: the dictionary's first, else the one the page got with the meaning (tap to translate asks the translator for it).
    const phonetic = body.kind === 'word' ? (lookupPhonetic(en) || phonetics.cleanPhonetic(body.phonetic)) : '';
    // Collected material (a translation, a looked-up word) is not kept while the person turned collecting off, also when a page still thinks it is on.
    if (COLLECTED.includes(source) && !settings(owner).collect) return { card: null, created: false, collecting: false };
    const norm = normalize(en);
    const existing = db.prepare('SELECT * FROM learn_cards WHERE owner = ? AND kind = ? AND norm = ?').get(owner, body.kind, norm);
    if (existing) {
      if ((!existing.zh && zh) || (!existing.phonetic && phonetic)) {
        // A filled-in meaning or transcription keeps the content clock: an empty one never wins over a filled one in the merge, so it reaches every
        // device anyway.
        existing.zh = existing.zh || zh;
        existing.phonetic = existing.phonetic || phonetic;
        db.prepare('UPDATE learn_cards SET zh = ?, phonetic = ?, sync_seq = ? WHERE id = ?').run(existing.zh, existing.phonetic, seq(), existing.id);
        changed();
      }
      return { card: oneCard(owner, existing), created: false };
    }
    const at = now();
    const { lastInsertRowid } = db.transaction(() => {
      // The text comes back after a move away from it: the card lives here again.
      db.prepare('DELETE FROM learn_card_moves WHERE owner = ? AND kind = ? AND norm = ?').run(owner, body.kind, norm);
      return db.prepare(`INSERT INTO learn_cards (owner, kind, en, norm, zh, phonetic, source, context, created_at, due_at, interval_days, ease, content_at, sync_seq)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`).run(owner, body.kind, en, norm, zh, phonetic, source, context, at, at, review.EASE_START, stamp(), seq());
    })();
    changed();
    if (body.kind === 'word' && (!zh || !phonetic)) newWords(owner);
    return { card: oneCard(owner, getCard(owner, lastInsertRowid)), created: true };
  }

  function updateCard(owner, id, body) {
    const row = mustCard(owner, id);
    if (!isPlainObject(body) || Object.keys(body).some(key => !['zh', 'en', 'suspended'].includes(key))) throw bad('Invalid card change');
    const next = { zh: row.zh, en: row.en, norm: row.norm, suspended: row.suspended, phonetic: row.phonetic || '' };
    if (body.zh !== undefined) next.zh = checkMeaning(body.zh);
    if (body.en !== undefined) {
      next.en = checkEnglish(row.kind, body.en);
      next.norm = normalize(next.en);
      const other = db.prepare('SELECT id FROM learn_cards WHERE owner = ? AND kind = ? AND norm = ? AND id <> ?').get(owner, row.kind, next.norm, row.id);
      if (other) throw new LearnError('A card with this text already exists', 409);
      if (next.norm !== row.norm) next.phonetic = row.kind === 'word' ? lookupPhonetic(next.en) : ''; // another word: its own transcription
    }
    // A sentence with another text is picked again (its words were those of the old text).
    const repick = row.kind === 'sentence' && next.norm !== row.norm;
    if (body.suspended !== undefined) {
      if (typeof body.suspended !== 'boolean') throw bad('Invalid card change');
      next.suspended = body.suspended ? 1 : 0;
    }
    const at = stamp();
    db.transaction(() => {
      db.prepare(`UPDATE learn_cards SET zh = @zh, en = @en, norm = @norm, suspended = @suspended, phonetic = @phonetic, content_at = @at, content_by = '', sync_seq = @seq
        WHERE id = @id`).run({ ...next, at, seq: seq(), id: row.id });
      if (repick) db.prepare("UPDATE learn_cards SET picked_level = '', picked_skipped = 0, picked_at = ? WHERE id = ?").run(at, row.id);
      if (next.norm !== row.norm) {
        // The card leaves its old text: a move record tells the linked devices that still have it there (services/learn-sync.js).
        db.prepare('DELETE FROM learn_card_moves WHERE owner = ? AND kind = ? AND norm = ?').run(owner, row.kind, next.norm);
        db.prepare(`INSERT INTO learn_card_moves (owner, kind, norm, moved_to, at, by, sync_seq) VALUES (?, ?, ?, ?, ?, '', ?)
          ON CONFLICT (owner, kind, norm) DO UPDATE SET moved_to = excluded.moved_to, at = excluded.at, by = '', sync_seq = excluded.sync_seq`)
          .run(owner, row.kind, row.norm, next.norm, at, seq());
      }
    })();
    changed();
    if (row.kind === 'word' && next.norm !== row.norm && (!next.zh || !next.phonetic)) newWords(owner);
    return { card: oneCard(owner, getCard(owner, row.id)) };
  }

  function answer(owner, id, body) {
    const row = mustCard(owner, id);
    if (!isPlainObject(body)) throw bad('Invalid answer');
    if (!MODES.includes(body.mode)) throw bad('Unknown practice mode');
    if (!review.GRADES.includes(body.grade)) throw bad('The grade must be again, hard or good');
    if (typeof body.correct !== 'boolean') throw bad('Invalid answer');
    if (body.answer !== undefined && body.answer !== null && typeof body.answer !== 'string') throw bad('Invalid answer');
    const text = typeof body.answer === 'string' ? body.answer.slice(0, MAX_ANSWER) : null;
    // A wrong answer keeps what was asked for (the word, the sentence, or the gap word of Fill the gap), the first tag of the page's checker and
    // whether help was used: the Mistakes list and the analysis read them ("Mistakes" in docs/design/learn-english.md). A right one keeps none.
    const detail = mistakeDetail(body, row);
    const at = now();
    const next = review.applyAnswer(row, body.grade, body.correct, at);
    db.transaction(() => {
      db.prepare(`UPDATE learn_cards SET due_at = @due_at, interval_days = @interval_days, ease = @ease, reps = @reps, lapses = @lapses,
        last_result = @last_result, last_at = @last_at, last_correct = @last_correct, state_at = @state_at, state_by = '', sync_seq = @seq WHERE id = @id`)
        .run({ ...next, state_at: stamp(), seq: seq(), id: row.id });
      db.prepare('INSERT INTO learn_reviews (card_id, owner, at, mode, grade, correct, answer, uid, sync_seq, expected, tag, hinted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(row.id, owner, at, body.mode, body.grade, body.correct ? 1 : 0, text, syncStore.reviewId(), seq(), detail.expected, detail.tag, detail.hinted);
    })();
    changed();
    return { card: oneCard(owner, getCard(owner, row.id)) };
  }

  // The mistake cards of an owner (see review.isMistake), most recently answered first.
  function mistakeRows(owner, starter) {
    const at = now();
    const rows = db.prepare(`SELECT *, (SELECT MAX(r.at) FROM learn_reviews r WHERE r.card_id = learn_cards.id AND r.correct = 0) AS last_wrong_at
      FROM learn_cards WHERE owner = @owner AND ${visible} AND (last_correct = 0 OR lapses > 0) ORDER BY last_at DESC, id DESC`).all({ owner, starter });
    return rows.filter(row => review.isMistake(row, row.last_wrong_at, at));
  }

  function summary(owner) {
    const current = settings(owner);
    if (current.starter) importStarter(owner, current.starter);
    const at = now();
    const params = { owner, starter: current.starter, now: at };
    const count = sql => db.prepare(sql).pluck().get(params);
    const recentReviews = db.prepare('SELECT at FROM learn_reviews WHERE owner = ? AND at >= ?').pluck().all(owner, at - 2 * review.DAY);
    const recentCards = db.prepare('SELECT created_at FROM learn_cards WHERE owner = ? AND created_at >= ?').pluck().all(owner, at - 2 * review.DAY);
    // The streak needs one moment per stretch of 15 minutes at most (every time zone offset is a multiple of 15 minutes), not every answer.
    const quarter = 15 * 60 * 1000;
    const stretches = db.prepare(`SELECT DISTINCT (at / ${quarter}) * ${quarter} FROM learn_reviews WHERE owner = ? AND at >= ?`).pluck().all(owner, at - 400 * review.DAY);
    return {
      due: count(`SELECT COUNT(*) FROM learn_cards WHERE owner = @owner AND ${visible} AND due_at <= @now`),
      new_today: review.countToday(recentCards, at, timeZone),
      done_today: review.countToday(recentReviews, at, timeZone),
      goal: current.daily_goal,
      streak: review.streak(stretches, at, timeZone),
      words: count(`SELECT COUNT(*) FROM learn_cards WHERE owner = @owner AND ${visible} AND kind = 'word'`),
      sentences: count(`SELECT COUNT(*) FROM learn_cards WHERE owner = @owner AND ${visible} AND kind = 'sentence'`),
      mistakes: mistakeRows(owner, current.starter).length,
      collecting: current.collect,
      starter: current.starter,
      new_report: newReport(owner, current),
      // The English chats that are not deleted ("English chat" in docs/design/learn-english-chat.md).
      chats: count('SELECT COUNT(*) FROM learn_convos WHERE owner = @owner AND deleted = 0'),
    };
  }

  // The meaning of an English word in Chinese, from a card that already has it, from this service's cache, or from the translator (once per word).
  async function meaning(owner, value) {
    const word = typeof value === 'string' ? wordForm(value) : '';
    if (!WORD.test(word)) throw bad('Enter an English word');
    const norm = word.toLowerCase();
    const card = db.prepare("SELECT id, zh, phonetic FROM learn_cards WHERE owner = ? AND kind = 'word' AND norm = ?").get(owner, norm);
    if (card && card.zh) return { zh: card.zh, phonetic: card.phonetic || lookupPhonetic(word) };
    const key = `${owner}|${norm}`;
    let zh = meanings.get(key);
    let phonetic = lookupPhonetic(word);
    if (zh === undefined) {
      if (!lookupWord) { translatorDown = true; throw new LearnError('Translation service not configured yet', 503); }
      let pending = lookingUp.get(key);
      if (!pending) {
        pending = lookupWord(owner, word).finally(() => lookingUp.delete(key));
        lookingUp.set(key, pending);
      }
      let entry;
      try { entry = await pending; } catch (error) { translatorDown = true; throw error; }
      translatorDown = false;
      zh = collapse((entry && entry.meaning) || '').slice(0, MAX_ZH);
      if (!zh) throw new LearnError('The translation service gave an answer that could not be read', 502);
      if (!phonetic) phonetic = translatorPhonetic(word, entry);
    } else meanings.delete(key);
    meanings.set(key, zh);
    if (meanings.size > MEANING_CACHE_SIZE) meanings.delete(meanings.keys().next().value);
    if (db.prepare("UPDATE learn_cards SET zh = ?, sync_seq = ? WHERE owner = ? AND kind = 'word' AND norm = ? AND zh = ''").run(zh, seq(), owner, norm).changes) changed();
    if (phonetic) storePhonetic(owner, norm, phonetic);
    return { zh, phonetic };
  }

  // The translator's transcription of the word itself (not of another form it named as the dictionary form), checked; else ''.
  function translatorPhonetic(word, entry) {
    if (!entry || (entry.base && String(entry.base).trim().toLowerCase() !== word.toLowerCase())) return '';
    return phonetics.cleanPhonetic(entry.phonetic);
  }
  // A transcription for a word card that has none; keeps the content clock (an empty one never wins in the merge).
  function storePhonetic(owner, norm, phonetic) {
    if (db.prepare("UPDATE learn_cards SET phonetic = ?, sync_seq = ? WHERE owner = ? AND kind = 'word' AND norm = ? AND phonetic = ''").run(phonetic, seq(), owner, norm).changes) changed();
  }
  // Fills the transcriptions of word cards from the dictionary. `ask`: a word the dictionary does not have is asked of the translator once while the
  // server runs (a few at a time; stops after the first failure); a word nobody knows keeps ''. Returns the first failure of the translator or null.
  async function fillPhonetics(owner, rows, { ask = false } = {}) {
    const todo = [];
    for (const row of rows) {
      if (row.kind !== 'word' || row.phonetic) continue;
      const found = lookupPhonetic(row.en);
      if (found) { row.phonetic = found; storePhonetic(owner, row.norm, found); } else if (ask && lookupWord && !askedPhonetic.has(`${owner}|${row.norm}`)) todo.push(row);
    }
    let failed = null;
    const worker = async () => {
      while (todo.length && !failed) {
        const row = todo.shift();
        markAsked(owner, row.norm);
        try {
          const found = translatorPhonetic(row.en, await lookupWord(owner, row.en));
          if (found) { row.phonetic = found; storePhonetic(owner, row.norm, found); }
        } catch (error) { failed = failed || error || new Error('failed'); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MEANING_CONCURRENCY, todo.length) }, worker));
    return failed;
  }
  // The translator was asked about this word while the server runs (for its transcription, or with its meaning, whose answer carries one).
  function markAsked(owner, norm) {
    askedPhonetic.add(`${owner}|${norm}`);
    if (askedPhonetic.size > MEANING_CACHE_SIZE) askedPhonetic.delete(askedPhonetic.values().next().value);
  }

  // Fills the empty meanings of word cards, a few at a time. Stops asking after the first failure (no translator, the service away): those cards keep ''.
  async function fillMeanings(owner, rows) {
    const todo = rows.filter(row => row.kind === 'word' && !row.zh);
    let failed = false;
    const worker = async () => {
      while (todo.length && !failed) {
        const row = todo.shift();
        try { row.zh = (await meaning(owner, row.en)).zh; } catch { failed = true; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MEANING_CONCURRENCY, todo.length) }, worker));
  }

  // ---- Translated ahead of time ("Meanings are translated ahead of time" in docs/design/learn-english.md; services/learn-prefill.js runs it) ----
  // The word cards of the owner that still miss something this service can fill: a meaning (unless its answer could not be read), or a transcription
  // the dictionary has or the translator was not asked for yet. In practice order: the cards shown first, due first (oldest due first), then the one
  // practised least recently (or never), like the spell queue; hidden ones (suspended, an untouched starter word with no list chosen) last.
  function prefillRows(owner) {
    const rows = db.prepare(`SELECT * FROM learn_cards WHERE owner = @owner AND kind = 'word' AND (zh = '' OR phonetic = '')
      ORDER BY (${visible}) DESC, (due_at <= @now) DESC, CASE WHEN due_at <= @now THEN due_at END ASC, last_at ASC NULLS FIRST, id ASC`)
      .all({ owner, starter: settings(owner).starter, now: now() });
    return rows.filter(row => {
      const key = `${owner}|${row.norm}`;
      if (!row.zh) return Boolean(lookupWord) && !unreadableWords.has(key);
      return Boolean(lookupPhonetic(row.en)) || (Boolean(lookupWord) && !askedPhonetic.has(key));
    });
  }
  // How many word cards of the owner have no meaning yet (for the log of services/learn-prefill.js).
  const missingMeanings = owner => Number(db.prepare("SELECT COUNT(*) FROM learn_cards WHERE owner = ? AND kind = 'word' AND zh = ''").pluck().get(owner)) || 0;
  // Translates up to `max` of those cards now: the meanings through meaning() (its cache, its one lookup per word and its update that keeps the
  // content clock, so a filled meaning reaches every linked engine: an empty one never wins in the merge), MEANING_CONCURRENCY at a time, then the
  // transcriptions (the dictionary, else the translator). Stops at the first failure of the translator; a word whose answer could not be read is
  // left for the queue and the page and the others go on. Nothing on a company computer (its cards come filled from its home).
  // Returns { tried, filled, left, failed, error }: the cards taken, those that got a meaning or a transcription, the cards still to do, and
  // whether it stopped at a failure (with that error).
  async function prefill(owner, { max = PREFILL_BATCH } = {}) {
    if (cacheOnly()) return { tried: 0, filled: 0, left: 0, failed: false, error: null };
    const rows = prefillRows(owner).slice(0, Math.max(0, max));
    const before = rows.map(row => `${row.zh}|${row.phonetic}`);
    const todo = rows.filter(row => !row.zh);
    let error = null;
    const worker = async () => {
      while (todo.length && !error) {
        const row = todo.shift();
        try {
          const found = await meaning(owner, row.en);
          row.zh = found.zh;
          if (found.phonetic && !row.phonetic) row.phonetic = found.phonetic;
          markAsked(owner, row.norm);
        } catch (failure) {
          if (failure instanceof LearnError && failure.statusCode === 502) unreadableWords.add(`${owner}|${row.norm}`);
          else error = failure || new Error('failed');
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MEANING_CONCURRENCY, todo.length) }, worker));
    if (!error) error = await fillPhonetics(owner, rows, { ask: true });
    const filled = rows.filter((row, index) => `${row.zh}|${row.phonetic}` !== before[index]).length;
    return { tried: rows.length, filled, left: prefillRows(owner).length, failed: Boolean(error), error };
  }

  async function queue(owner, mode, limitValue) {
    if (!MODES.includes(mode)) throw bad('Unknown practice mode');
    const limit = limitValue === undefined || limitValue === '' ? 20 : Number(limitValue);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw bad(`The limit must be a whole number from 1 to ${MAX_LIMIT}`);
    const current = settings(owner);
    if (current.starter) importStarter(owner, current.starter);
    const params = { owner, starter: current.starter, now: now(), limit };
    let rows;
    if (mode === 'mistakes') rows = mistakeRows(owner, current.starter).slice(0, limit);
    else if (mode === 'review') {
      rows = db.prepare(`SELECT * FROM learn_cards WHERE owner = @owner AND ${visible} AND due_at <= @now ORDER BY due_at ASC, id ASC LIMIT @limit`).all(params);
    } else {
      const kind = mode === 'spell' ? 'word' : 'sentence';
      // Due cards first (oldest due first), then the others, the one practised least recently (or never) first.
      const pick = take => db.prepare(`SELECT * FROM learn_cards WHERE owner = @owner AND ${visible} AND kind = '${kind}'
        ORDER BY (due_at <= @now) DESC, CASE WHEN due_at <= @now THEN due_at END ASC, last_at ASC NULLS FIRST, id ASC LIMIT @take`).all({ ...params, take });
      // Spell needs the meaning: a word without one is asked for it first and left out when none can be found, so a few more are read.
      rows = pick(mode === 'spell' ? limit * 2 : limit);
    }
    // The first cards are made ready now; the rest in the background (the page asks /meaning for a card that is still without one when it is shown).
    const head = rows.slice(0, QUEUE_HEAD);
    await fillMeanings(owner, head);
    // Spell needs the meaning: while the translator fails (or there is none), a word without one is left out, as the page could not show it.
    if (mode === 'spell') rows = rows.filter(row => row.zh || !translatorDown).slice(0, limit);
    await fillPhonetics(owner, rows.slice(0, QUEUE_HEAD), { ask: true });
    await fillPhonetics(owner, rows); // the dictionary only: no waiting
    const rest = rows.slice(QUEUE_HEAD).filter(row => row.kind === 'word' && (!row.zh || !row.phonetic));
    if (rest.length && !translatorDown) {
      background = background.then(async () => { await fillMeanings(owner, rest); await fillPhonetics(owner, rest, { ask: true }); }).catch(() => {});
    }
    return { cards: cardsJson(owner, rows) };
  }

  // `source`: the cards of one source; `translation` also gives the words asked inside one of the person's translated sentences (their context is
  // the English of a translation sentence card), so "View" in the Learn settings lists every word picked from a translation.
  async function list(owner, query = {}) {
    const kind = query.kind === undefined || query.kind === '' ? null : query.kind;
    if (kind !== null && !KINDS.includes(kind)) throw bad('The kind must be word or sentence');
    const limit = query.limit === undefined || query.limit === '' ? 50 : Number(query.limit);
    const offset = query.offset === undefined || query.offset === '' ? 0 : Number(query.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) throw bad('Invalid list range');
    const source = query.source === undefined || query.source === '' ? null : query.source;
    if (source !== null && !SOURCES.includes(source)) throw bad('Unknown card source');
    const q = typeof query.q === 'string' ? collapse(query.q).slice(0, 100).toLowerCase() : '';
    const like = `%${q.replace(/[\\%_]/g, char => `\\${char}`)}%`;
    const where = `owner = @owner AND (@kind IS NULL OR kind = @kind) AND (@q = '' OR norm LIKE @like ESCAPE '\\' OR zh LIKE @like ESCAPE '\\')
      AND (@source IS NULL OR source = @source OR (@source = 'translation' AND ${FROM_TRANSLATION}))
      AND NOT (source = 'starter' AND reps = 0 AND @starter IS NULL)`;
    const params = { owner, kind, source, q, like, starter: settings(owner).starter, limit, offset };
    const total = db.prepare(`SELECT COUNT(*) FROM learn_cards WHERE ${where}`).pluck().get(params);
    const rows = db.prepare(`SELECT * FROM learn_cards WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`).all(params);
    await fillPhonetics(owner, rows); // the dictionary only: a list never asks the translator
    return { cards: cardsJson(owner, rows), total };
  }

  // Imports a starter list once: words already there (from the list or from the person) are kept as they are. The new words become due
  // STARTER_PER_DAY a day, so the list does not fill the first review with hundreds of cards.
  function importStarter(owner, id) {
    const list = STARTER_LISTS[id];
    if (!list) throw bad('Unknown starter list');
    // A company computer gets the starter words of the normal machine with the other cards.
    if (cacheOnly()) return 0;
    if (db.prepare("SELECT 1 FROM learn_cards WHERE owner = ? AND source = 'starter' LIMIT 1").get(owner)) return 0;
    const at = now();
    // Both clocks stay 0: the same list imported on two linked devices is the same cards, and any real answer or edit wins over it.
    const insert = db.prepare(`INSERT OR IGNORE INTO learn_cards (owner, kind, en, norm, zh, source, context, created_at, due_at, interval_days, ease, sync_seq)
      VALUES (?, 'word', ?, ?, '', 'starter', ?, ?, ?, 0, ?, ?)`);
    let added = 0;
    db.transaction(() => {
      list.words.forEach(word => {
        const due = at + Math.floor(added / STARTER_PER_DAY) * review.DAY;
        added += insert.run(owner, word, word.toLowerCase(), list.title, at, due, review.EASE_START, seq()).changes;
      });
    })();
    if (added) { changed(); newWords(owner); }
    return added;
  }
  function starter(owner, body) {
    if (!isPlainObject(body) || !Object.hasOwn(STARTER_LISTS, body.list)) throw bad('Unknown starter list');
    const added = importStarter(owner, body.list);
    const current = settings(owner);
    if (current.starter !== body.list) {
      writeState(db, settingsKey(owner), { ...current, starter: body.list });
      settingsChanged(owner);
    }
    return { added };
  }

  // ---- Mistakes and reports ("Mistakes" and "Mistake reports" in docs/design/learn-english.md) ----
  const MISTAKE_SELECT = `SELECT r.uid, r.at, r.mode, r.answer, r.expected, r.tag, r.hinted, c.id AS card_id, c.kind, c.en
    FROM learn_reviews r JOIN learn_cards c ON c.id = r.card_id WHERE r.owner = @owner AND r.correct = 0`;
  // The wrong answers, newest first, a page at a time (`before`: the time of the last one shown).
  function mistakes(owner, query = {}) {
    const limit = query.limit === undefined || query.limit === '' ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MISTAKES_PAGE) throw bad('Invalid list range');
    const before = query.before ? Date.parse(query.before) : NaN;
    const rows = db.prepare(`${MISTAKE_SELECT} AND (@before IS NULL OR r.at < @before) ORDER BY r.at DESC, r.id DESC LIMIT @take`)
      .all({ owner, before: Number.isFinite(before) ? before : null, take: limit + 1 });
    return { mistakes: rows.slice(0, limit).map(mistakeJson), more: rows.length > limit };
  }
  // The newest report (the one that covers until the latest time), or null.
  const lastReport = owner => db.prepare('SELECT * FROM learn_reports WHERE owner = ? ORDER BY covers_until DESC, created_at DESC LIMIT 1').get(owner) || null;
  // What happened since the last report: { from, mistakes, answers, last } (from = the time the last report covers until, 0 before the first one).
  function sinceReport(owner) {
    const last = lastReport(owner);
    const from = last ? last.covers_until : 0;
    const count = sql => Number(db.prepare(sql).pluck().get(owner, from)) || 0;
    return {
      from, last: last ? reportJson(last, { full: false }) : null,
      mistakes: count('SELECT COUNT(*) FROM learn_reviews WHERE owner = ? AND correct = 0 AND at > ?'),
      answers: count('SELECT COUNT(*) FROM learn_reviews WHERE owner = ? AND at > ?'),
    };
  }
  // The wrong answers after `from` (at most `max`, the newest), with the counts of the whole stretch, for an analysis.
  function mistakesSince(owner, from, max) {
    const rows = db.prepare(`${MISTAKE_SELECT} AND r.at > @from ORDER BY r.at DESC, r.id DESC LIMIT @max`).all({ owner, from, max });
    const count = sql => Number(db.prepare(sql).pluck().get(owner, from)) || 0;
    return {
      mistakes: rows.map(mistakeJson), total: count('SELECT COUNT(*) FROM learn_reviews WHERE owner = ? AND correct = 0 AND at > ?'),
      answers: count('SELECT COUNT(*) FROM learn_reviews WHERE owner = ? AND at > ?'),
    };
  }
  const reports = owner => ({ reports: db.prepare('SELECT * FROM learn_reports WHERE owner = ? ORDER BY covers_until DESC, created_at DESC LIMIT 50').all(owner).map(row => reportJson(row, { full: false })) });
  function report(owner, uid) {
    const row = typeof uid === 'string' ? db.prepare('SELECT * FROM learn_reports WHERE owner = ? AND uid = ?').get(owner, uid) : null;
    if (!row) throw new LearnError('Report not found', 404);
    return { report: reportJson(row) };
  }
  const lastAutoReport = owner => db.prepare('SELECT * FROM learn_reports WHERE owner = ? AND auto = 1 ORDER BY created_at DESC LIMIT 1').get(owner) || null;
  const hasReport = (owner, uid) => Boolean(db.prepare('SELECT 1 FROM learn_reports WHERE owner = ? AND uid = ?').get(owner, uid));
  // Stores a report made here (services/learn-analysis.js has checked it): { uid, created_at, covers_from, covers_until, auto, lang, mistakes, answers,
  // model, body: { summary, kinds, findings } }. It syncs like an answer: made once, never changed.
  function saveReport(owner, value) {
    db.prepare(`INSERT INTO learn_reports (owner, uid, created_at, covers_from, covers_until, auto, lang, mistakes, answers, model, body, by, sync_seq)
      VALUES (@owner, @uid, @created_at, @covers_from, @covers_until, @auto, @lang, @mistakes, @answers, @model, @body, '', @seq)`)
      .run({ ...value, owner, auto: value.auto ? 1 : 0, body: JSON.stringify(value.body), seq: seq() });
    changed();
    return report(owner, value.uid);
  }
  // The cards behind a report's findings, by kind and text (the ids differ between engines): the ones this engine has, following a changed text.
  function findCards(owner, body) {
    const refs = isPlainObject(body) && Array.isArray(body.refs) ? body.refs.slice(0, 200) : null;
    if (!refs) throw bad('Invalid card list');
    const out = [];
    const seen = new Set();
    for (const ref of refs) {
      if (!isPlainObject(ref) || !KINDS.includes(ref.kind) || typeof ref.en !== 'string') continue;
      let norm = normalize(ref.en);
      let row = null;
      for (let hops = 0; hops <= 8 && !row; hops += 1) {
        row = db.prepare('SELECT * FROM learn_cards WHERE owner = ? AND kind = ? AND norm = ?').get(owner, ref.kind, norm) || null;
        if (row) break;
        const move = db.prepare('SELECT moved_to FROM learn_card_moves WHERE owner = ? AND kind = ? AND norm = ?').get(owner, ref.kind, norm);
        if (!move) break;
        norm = move.moved_to;
      }
      if (row && !row.suspended && !seen.has(row.id)) { seen.add(row.id); out.push(row); }
    }
    return { cards: cardsJson(owner, out) };
  }
  // The newest automatic report the person has not opened yet, for the one line on the Learn home; else null.
  function newReport(owner, current = settings(owner)) {
    const last = lastReport(owner);
    return last && last.auto && last.uid !== current.report_seen ? { uid: last.uid, created_at: iso(last.created_at), mistakes: last.mistakes } : null;
  }

  // ---- The estimated level ("Your level" in docs/design/learn-english.md; services/learn-pick.js estimates it) ----
  // The stored level with its version, or null.
  function storedLevel(owner) {
    const value = readState(db, levelKey(owner));
    return isPlainObject(value) && LEVELS.includes(value.level) ? value : null;
  }
  // Stores a new estimate made here: { level, label, reason, answers, mistakes, report_at, updated_at } (checked by services/learn-pick.js).
  function saveLevel(owner, value) {
    writeState(db, levelKey(owner), {
      level: value.level, label: String(value.label).slice(0, MAX_LEVEL_LABEL), reason: String(value.reason).slice(0, MAX_LEVEL_REASON),
      answers: value.answers, mistakes: value.mistakes, report_at: Number.isSafeInteger(value.report_at) ? value.report_at : null, updated_at: value.updated_at,
      at: stamp(), by: '', seq: seq(),
    });
    changed();
    return levelJson(storedLevel(owner));
  }

  return {
    settings, saveSettings, addCard, updateCard, answer, summary, meaning, queue, list, starter, storedLevel, saveLevel,
    // The identity of a card on every engine (its id is local): { id, kind, norm }, or 404 (services/learn-ask.js asks a company computer's home by it).
    cardRef: (owner, id) => { const row = mustCard(owner, id); return { id: row.id, kind: row.kind, norm: row.norm }; },
    level: owner => levelJson(storedLevel(owner)),
    settle: () => background, // the queue's background fill has ended (tests)
    mistakes, sinceReport, mistakesSince, reports, report, hasReport, saveReport, findCards, newReport, lastReport, lastAutoReport,
    prefill, missingMeanings,
  };
}

// The meaning of one word through the translator the person set up, by the same path as POST /api/translate/word: this Client's own translator, or the
// linked service that shares one (services/linked-capabilities.js).
function translatorLookup() {
  const { createTranslator, TIMEOUT_MS } = require('./translator');
  const { getLinkedCapabilities, TIMEOUT_MARGIN_MS } = require('./linked-capabilities');
  const translator = createTranslator({ db: require('../db'), sessionSecret: require('../config').sessionSecret });
  const linked = getLinkedCapabilities();
  return (owner, word) => linked.run('translate', {
    configured: () => translator.isConfigured(owner),
    local: () => translator.translateWord(owner, { word }),
    route: '/translate/word', body: { word, context: '' }, timeoutMs: TIMEOUT_MS + TIMEOUT_MARGIN_MS,
  });
}
// The learning service of this server's database with the translator, shared by the routes (routes/learn.js) and the translation ahead of time
// (services/learn-prefill.js), so a word both want is asked of the translator once and the meanings they found are one cache.
let shared = null;
function sharedLearn() {
  if (!shared) shared = createLearn({ lookupWord: translatorLookup(), cacheOnly: () => Boolean(require('./learn-sync').getLearnSync().cacheOnly()) });
  return shared;
}

module.exports = {
  createLearn, sharedLearn, translatorLookup, LearnError, checkEnglish, codeLike, wordForm, normalize, settingsKey, settingsVersionKey, levelKey, levelJson, FROM_TRANSLATION,
  MODES, SENTENCE_MODES, KINDS, SOURCES, DEFAULT_SETTINGS, AUDIO_SETTINGS, REPORT_SETTINGS, PICK_SETTINGS, CHECKED_SETTINGS, MISTAKE_TAGS, MAX_EXPECTED,
  LEVELS, MAX_CONTEXT, MAX_PICK_CONTEXT, MAX_LEVEL_LABEL, MAX_LEVEL_REASON, MAX_ZH, WORD, collapse, PREFILL_BATCH,
};
