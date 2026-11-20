// English learning ("Learn English" in docs/design/learn-english.md): the cards of an owner (their own translated sentences, the words they looked up,
// the starter list), spaced review (services/learn-review.js), the practice queues, the mistakes, the day's numbers and the settings. Stored in
// learn_cards and learn_reviews (schema 13) and the system_state key `learn_v1:<owner>`. Meanings come from the translator the person already set
// up, through `lookupWord` (routes/learn.js hands in the same path as POST /api/translate/word); no other outside service is called.
// Every change stamps the hybrid clock and the change number of the sync (services/learn-sync-store.js, "Sync across linked devices" there): the
// content clock for an edit, the review-state clock for an answer, a random id for an answer, and a move record when a card's text changes.
// A word card's phonetic transcription (`phonetic`, schema 15) comes from the bundled dictionary (services/phonetics.js) and, for a word it does not
// have, from the translator's answer; like a filled-in meaning it keeps the content clock ("Phonetic transcription" in docs/design/learn-english.md).
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
const MAX_ANSWER = 500;
const MAX_LIMIT = 100;
const MEANING_CACHE_SIZE = 1000;
const MEANING_CONCURRENCY = 4;
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
const SETTINGS_FIELDS = new Set(['collect', 'daily_goal', 'starter', ...Object.keys(AUDIO_SETTINGS)]);
const DEFAULT_SETTINGS = { collect: true, daily_goal: 20, starter: 'dev', ...Object.fromEntries(Object.entries(AUDIO_SETTINGS).map(([key, field]) => [key, field.default])) };

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

// The JSON of a card for the page. Times are ISO 8601 strings.
function cardJson(row) {
  return {
    id: row.id, kind: row.kind, en: row.en, zh: row.zh, phonetic: row.phonetic || '', source: row.source, context: row.context,
    due_at: iso(row.due_at), interval_days: row.interval_days, ease: row.ease, reps: row.reps, lapses: row.lapses,
    last_result: row.last_result || null, last_at: iso(row.last_at), suspended: Boolean(row.suspended), created_at: iso(row.created_at),
  };
}

const settingsKey = owner => `learn_v1:${owner}`;
// The version of an owner's learning settings for the sync: { at, by, seq } (hybrid clock, '' for this device, change number).
const settingsVersionKey = owner => `learn_v1_sync:${owner}`;

// `cacheOnly()`: this machine is a company computer whose learning data lives on a normal machine (services/learn-sync.js); it then imports no
// starter list of its own (the cards come from that machine). `lookupPhonetic(word)`: the dictionary's transcription or '' (tests hand in a fixture).
function createLearn({ db = require('../db'), now = Date.now, timeZone, lookupWord = null, cacheOnly = () => false, lookupPhonetic = phonetics.lookupPhonetic } = {}) {
  const meanings = new Map(); // `${owner}|${word}` -> zh, least recently used first
  const askedPhonetic = new Set(); // `${owner}|${norm}` the translator was asked for a transcription (once per word while the server runs)
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
      return { card: cardJson(existing), created: false };
    }
    const at = now();
    const { lastInsertRowid } = db.transaction(() => {
      // The text comes back after a move away from it: the card lives here again.
      db.prepare('DELETE FROM learn_card_moves WHERE owner = ? AND kind = ? AND norm = ?').run(owner, body.kind, norm);
      return db.prepare(`INSERT INTO learn_cards (owner, kind, en, norm, zh, phonetic, source, context, created_at, due_at, interval_days, ease, content_at, sync_seq)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`).run(owner, body.kind, en, norm, zh, phonetic, source, context, at, at, review.EASE_START, stamp(), seq());
    })();
    changed();
    return { card: cardJson(getCard(owner, lastInsertRowid)), created: true };
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
    if (body.suspended !== undefined) {
      if (typeof body.suspended !== 'boolean') throw bad('Invalid card change');
      next.suspended = body.suspended ? 1 : 0;
    }
    const at = stamp();
    db.transaction(() => {
      db.prepare(`UPDATE learn_cards SET zh = @zh, en = @en, norm = @norm, suspended = @suspended, phonetic = @phonetic, content_at = @at, content_by = '', sync_seq = @seq
        WHERE id = @id`).run({ ...next, at, seq: seq(), id: row.id });
      if (next.norm !== row.norm) {
        // The card leaves its old text: a move record tells the linked devices that still have it there (services/learn-sync.js).
        db.prepare('DELETE FROM learn_card_moves WHERE owner = ? AND kind = ? AND norm = ?').run(owner, row.kind, next.norm);
        db.prepare(`INSERT INTO learn_card_moves (owner, kind, norm, moved_to, at, by, sync_seq) VALUES (?, ?, ?, ?, ?, '', ?)
          ON CONFLICT (owner, kind, norm) DO UPDATE SET moved_to = excluded.moved_to, at = excluded.at, by = '', sync_seq = excluded.sync_seq`)
          .run(owner, row.kind, row.norm, next.norm, at, seq());
      }
    })();
    changed();
    return { card: cardJson(getCard(owner, row.id)) };
  }

  function answer(owner, id, body) {
    const row = mustCard(owner, id);
    if (!isPlainObject(body)) throw bad('Invalid answer');
    if (!MODES.includes(body.mode)) throw bad('Unknown practice mode');
    if (!review.GRADES.includes(body.grade)) throw bad('The grade must be again, hard or good');
    if (typeof body.correct !== 'boolean') throw bad('Invalid answer');
    if (body.answer !== undefined && body.answer !== null && typeof body.answer !== 'string') throw bad('Invalid answer');
    const text = typeof body.answer === 'string' ? body.answer.slice(0, MAX_ANSWER) : null;
    const at = now();
    const next = review.applyAnswer(row, body.grade, body.correct, at);
    db.transaction(() => {
      db.prepare(`UPDATE learn_cards SET due_at = @due_at, interval_days = @interval_days, ease = @ease, reps = @reps, lapses = @lapses,
        last_result = @last_result, last_at = @last_at, last_correct = @last_correct, state_at = @state_at, state_by = '', sync_seq = @seq WHERE id = @id`)
        .run({ ...next, state_at: stamp(), seq: seq(), id: row.id });
      db.prepare('INSERT INTO learn_reviews (card_id, owner, at, mode, grade, correct, answer, uid, sync_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(row.id, owner, at, body.mode, body.grade, body.correct ? 1 : 0, text, syncStore.reviewId(), seq());
    })();
    changed();
    return { card: cardJson(getCard(owner, row.id)) };
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
      if (!lookupWord) throw new LearnError('Translation service not configured yet', 503);
      const entry = await lookupWord(owner, word);
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
  // server runs (a few at a time; stops after the first failure); a word nobody knows keeps ''.
  async function fillPhonetics(owner, rows, { ask = false } = {}) {
    const todo = [];
    for (const row of rows) {
      if (row.kind !== 'word' || row.phonetic) continue;
      const found = lookupPhonetic(row.en);
      if (found) { row.phonetic = found; storePhonetic(owner, row.norm, found); } else if (ask && lookupWord && !askedPhonetic.has(`${owner}|${row.norm}`)) todo.push(row);
    }
    let failed = false;
    const worker = async () => {
      while (todo.length && !failed) {
        const row = todo.shift();
        askedPhonetic.add(`${owner}|${row.norm}`);
        if (askedPhonetic.size > MEANING_CACHE_SIZE) askedPhonetic.delete(askedPhonetic.values().next().value);
        try {
          const found = translatorPhonetic(row.en, await lookupWord(owner, row.en));
          if (found) { row.phonetic = found; storePhonetic(owner, row.norm, found); }
        } catch { failed = true; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MEANING_CONCURRENCY, todo.length) }, worker));
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
    await fillMeanings(owner, rows);
    if (mode === 'spell') rows = rows.filter(row => row.zh).slice(0, limit);
    await fillPhonetics(owner, rows, { ask: true });
    return { cards: rows.map(cardJson) };
  }

  async function list(owner, query = {}) {
    const kind = query.kind === undefined || query.kind === '' ? null : query.kind;
    if (kind !== null && !KINDS.includes(kind)) throw bad('The kind must be word or sentence');
    const limit = query.limit === undefined || query.limit === '' ? 50 : Number(query.limit);
    const offset = query.offset === undefined || query.offset === '' ? 0 : Number(query.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) throw bad('Invalid list range');
    const q = typeof query.q === 'string' ? collapse(query.q).slice(0, 100).toLowerCase() : '';
    const like = `%${q.replace(/[\\%_]/g, char => `\\${char}`)}%`;
    const where = `owner = @owner AND (@kind IS NULL OR kind = @kind) AND (@q = '' OR norm LIKE @like ESCAPE '\\' OR zh LIKE @like ESCAPE '\\')
      AND NOT (source = 'starter' AND reps = 0 AND @starter IS NULL)`;
    const params = { owner, kind, q, like, starter: settings(owner).starter, limit, offset };
    const total = db.prepare(`SELECT COUNT(*) FROM learn_cards WHERE ${where}`).pluck().get(params);
    const rows = db.prepare(`SELECT * FROM learn_cards WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`).all(params);
    await fillPhonetics(owner, rows); // the dictionary only: a list never asks the translator
    return { cards: rows.map(cardJson), total };
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
    if (added) changed();
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

  return { settings, saveSettings, addCard, updateCard, answer, summary, meaning, queue, list, starter };
}

module.exports = {
  createLearn, LearnError, checkEnglish, codeLike, wordForm, normalize, settingsKey, settingsVersionKey,
  MODES, SENTENCE_MODES, KINDS, SOURCES, DEFAULT_SETTINGS, AUDIO_SETTINGS,
};
