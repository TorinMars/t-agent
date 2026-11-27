// The small pieces that services/learn.js and services/learn-sync.js share ("Sync across linked devices" in docs/design/learn-english.md): the
// schema of the sync columns, the hybrid clock of each database, the change sequence and the change hook. Nothing here talks to a peer.
//
// - Clock: one hybrid clock per database, in milliseconds. A local change takes max(now, newest seen + 1), so it is never behind a time read from a
//   card, a move or a peer. It starts from the newest time stored in learn_cards and learn_card_moves.
// - Sequence: every row the sync carries (a card, a review, a move) gets the next number of one counter per database (`sync_seq`) whenever it is
//   written here, by the person or by the sync. A peer asks for "everything after N", so a row written again is sent again.
// - The hook: learnChanged(db) after a local change; services/learn-sync.js of the same database pushes it to the linked peers a moment later.
const crypto = require('crypto');

const clocks = new WeakMap(); // db -> { clock, seq }
const listeners = new Set();

// The sync columns of schema 14 on an older database (13 had learn_cards and learn_reviews without them), and the indexes on them. Safe to run on
// every start: a column or an index that is there is left alone. Rows from before get: a content clock of 0 (they never beat a real edit), the
// time of the last answer as the review-state clock (so on the first merge the side answered last keeps its schedule), a random review id, and
// change numbers in their order of creation. Schema 15 adds `phonetic` (the transcription of a word, '' until it is looked up) the same way,
// schema 17 the detail of a wrong answer (`expected`, `tag`, `hinted`) and the table `learn_reports`, schema 19 the pick of a sentence
// (`picked_level`, `picked_skipped`, `picked_at`; not picked yet), schema 20 the table `learn_chats` (the questions about a card), schema 21
// the tables `learn_convos` and `learn_convo_messages` (the English chats), and schema 22 the FSRS state of a card (`fsrs_stability`,
// `fsrs_difficulty`; NULL: not computed), filled in once by replaying every card's answers (services/learn-schedule.js migrate; "Replay, sync and
// migration" in docs/design/learn-review-fsrs.md), schema 23 the parts and the tip of a word card (`parts`, `tip`; '' until known; "Keeps
// slipping" there), schema 24 the tables `learn_coach_notes` and `learn_coach_summary` (the English coach), and schema 25 the context of a word
// card of its own (`context_zh`, `context_source`; '' for the person's own text; "A sentence for every word" in docs/design/learn-english.md). Returns the counts of that replay when it ran now, else null.
function ensureSyncSchema(db) {
  const columns = table => db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
  const cards = columns('learn_cards');
  if (!cards.length) return null;
  const addCard = [];
  for (const [name, type] of [['content_at', 'INTEGER NOT NULL DEFAULT 0'], ['content_by', "TEXT NOT NULL DEFAULT ''"], ['state_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['state_by', "TEXT NOT NULL DEFAULT ''"], ['sync_seq', 'INTEGER NOT NULL DEFAULT 0'], ['phonetic', "TEXT NOT NULL DEFAULT ''"],
    // Schema 19: the pick of a sentence card (the level it was picked at, the known words it met, the clock of the pick).
    ['picked_level', "TEXT NOT NULL DEFAULT ''"], ['picked_skipped', 'INTEGER NOT NULL DEFAULT 0'], ['picked_at', 'INTEGER NOT NULL DEFAULT 0'],
    // Schema 22: the FSRS memory state of a card (derived from its answers; NULL until computed).
    ['fsrs_stability', 'REAL'], ['fsrs_difficulty', 'REAL'],
    // Schema 23: the parts (syllables, joined with a middle dot) and the spelling tip of a word that keeps slipping ('' until the model gave them).
    ['parts', "TEXT NOT NULL DEFAULT ''"], ['tip', "TEXT NOT NULL DEFAULT ''"],
    // Schema 25: the Chinese and the origin of a word card's context (an example sentence of its own; '' for the person's own text).
    ['context_zh', "TEXT NOT NULL DEFAULT ''"], ['context_source', "TEXT NOT NULL DEFAULT ''"]]) {
    if (!cards.includes(name)) addCard.push(`ALTER TABLE learn_cards ADD COLUMN ${name} ${type}`);
  }
  const reviews = columns('learn_reviews');
  const addReview = [];
  if (!reviews.includes('uid')) addReview.push('ALTER TABLE learn_reviews ADD COLUMN uid TEXT');
  if (!reviews.includes('sync_seq')) addReview.push('ALTER TABLE learn_reviews ADD COLUMN sync_seq INTEGER NOT NULL DEFAULT 0');
  // Schema 17: the detail of a wrong answer (what was asked for, the first tag, whether help was used) and the table of mistake reports.
  for (const [name, type] of [['expected', 'TEXT'], ['tag', "TEXT NOT NULL DEFAULT ''"], ['hinted', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!reviews.includes(name)) addReview.push(`ALTER TABLE learn_reviews ADD COLUMN ${name} ${type}`);
  }
  let replay = null;
  db.transaction(() => {
    for (const sql of addCard) db.exec(sql);
    if (!cards.includes('state_at')) db.exec('UPDATE learn_cards SET state_at = COALESCE(last_at, 0)');
    if (!cards.includes('sync_seq')) db.exec('UPDATE learn_cards SET sync_seq = id');
    for (const sql of addReview) db.exec(sql);
    if (!reviews.includes('uid')) db.exec('UPDATE learn_reviews SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL');
    if (!reviews.includes('sync_seq')) db.exec('UPDATE learn_reviews SET sync_seq = id + (SELECT COALESCE(MAX(id), 0) FROM learn_cards)');
    db.exec(`CREATE TABLE IF NOT EXISTS learn_card_moves (
      owner TEXT NOT NULL, kind TEXT NOT NULL, norm TEXT NOT NULL, moved_to TEXT NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL DEFAULT '',
      sync_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (owner, kind, norm))`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_learn_cards_seq ON learn_cards (owner, sync_seq)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_learn_reviews_uid ON learn_reviews (uid)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_learn_reviews_seq ON learn_reviews (owner, sync_seq)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_learn_card_moves_seq ON learn_card_moves (owner, sync_seq)');
    db.exec(`CREATE TABLE IF NOT EXISTS learn_reports (
      owner TEXT NOT NULL, uid TEXT NOT NULL, created_at INTEGER NOT NULL, covers_from INTEGER NOT NULL, covers_until INTEGER NOT NULL,
      auto INTEGER NOT NULL DEFAULT 0, lang TEXT NOT NULL DEFAULT 'en', mistakes INTEGER NOT NULL DEFAULT 0, answers INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, by TEXT NOT NULL DEFAULT '', sync_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (owner, uid))`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_learn_reports_seq ON learn_reports (owner, sync_seq)');
    db.exec(`CREATE TABLE IF NOT EXISTS learn_chats (
      owner TEXT NOT NULL, uid TEXT NOT NULL, card_id INTEGER NOT NULL REFERENCES learn_cards(id) ON DELETE CASCADE, role TEXT NOT NULL, text TEXT NOT NULL,
      at INTEGER NOT NULL, by TEXT NOT NULL DEFAULT '', sync_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (owner, uid))`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_learn_chats_card ON learn_chats (card_id, at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_learn_chats_seq ON learn_chats (owner, sync_seq)');
    // Schema 21: the English chats (db/schema.sql has the comments).
    db.exec(`CREATE TABLE IF NOT EXISTS learn_convos (
      owner TEXT NOT NULL, uid TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', title_at INTEGER NOT NULL DEFAULT 0, journal INTEGER NOT NULL DEFAULT 0,
      journal_by TEXT NOT NULL DEFAULT '', journal_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER NOT NULL DEFAULT 0, deleted_by TEXT NOT NULL DEFAULT '', by TEXT NOT NULL DEFAULT '',
      sync_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (owner, uid))`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_learn_convos_seq ON learn_convos (owner, sync_seq)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_learn_convos_updated ON learn_convos (owner, deleted, updated_at)');
    db.exec(`CREATE TABLE IF NOT EXISTS learn_convo_messages (
      owner TEXT NOT NULL, uid TEXT NOT NULL, convo_uid TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL,
      meta TEXT NOT NULL DEFAULT '', by TEXT NOT NULL DEFAULT '', sync_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (owner, uid))`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_learn_convo_messages_convo ON learn_convo_messages (owner, convo_uid, at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_learn_convo_messages_seq ON learn_convo_messages (owner, sync_seq)');
    // Schema 24: the English coach's notes and rolling summary (db/schema.sql has the comments).
    db.exec(`CREATE TABLE IF NOT EXISTS learn_coach_notes (
      owner TEXT NOT NULL, uid TEXT NOT NULL, text TEXT NOT NULL, until TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0, by TEXT NOT NULL DEFAULT '', sync_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (owner, uid))`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_learn_coach_notes_seq ON learn_coach_notes (owner, sync_seq)');
    db.exec(`CREATE TABLE IF NOT EXISTS learn_coach_summary (
      owner TEXT NOT NULL PRIMARY KEY, text TEXT NOT NULL DEFAULT '', covers_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
      reset_at INTEGER NOT NULL DEFAULT 0, by TEXT NOT NULL DEFAULT '', sync_seq INTEGER NOT NULL DEFAULT 0)`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_learn_coach_summary_seq ON learn_coach_summary (owner, sync_seq)');
    // Schema 22: every card's state from the replay of its answers, a changed one with a new review-state clock and change number after every one
    // stored (also those of the settings and the level in system_state), so the linked engines get it.
    if (!cards.includes('fsrs_stability')) {
      let seq = Math.max(newestSeq(db), storedSeqs(db));
      replay = require('./learn-schedule').migrate(db, { clock: Math.max(Date.now(), newestClock(db) + 1), nextSeq: () => { seq += 1; return seq; } });
    }
  })();
  return replay;
}

const newestOf = (db, sql) => Number(db.prepare(sql).pluck().get()) || 0;
// The newest hybrid clock time and the highest change number stored in the learning tables (the start of the clock and of the counter).
function newestClock(db) {
  return Math.max(newestOf(db, 'SELECT MAX(MAX(content_at), MAX(state_at)) FROM learn_cards'), newestOf(db, 'SELECT MAX(at) FROM learn_card_moves'),
    newestOf(db, 'SELECT MAX(at) FROM learn_chats'), newestOf(db, 'SELECT MAX(MAX(title_at), MAX(journal_at), MAX(deleted_at), MAX(updated_at)) FROM learn_convos'),
    newestOf(db, 'SELECT MAX(at) FROM learn_convo_messages'), newestOf(db, 'SELECT MAX(updated_at) FROM learn_coach_notes'),
    newestOf(db, 'SELECT MAX(MAX(updated_at), MAX(reset_at)) FROM learn_coach_summary'));
}
function newestSeq(db) {
  return Math.max(...['learn_cards', 'learn_reviews', 'learn_card_moves', 'learn_reports', 'learn_chats', 'learn_convos', 'learn_convo_messages', 'learn_coach_notes', 'learn_coach_summary']
    .map(table => newestOf(db, `SELECT MAX(sync_seq) FROM ${table}`)));
}
// The change numbers kept in system_state (the version of the learning settings and the level of each owner), which services/learn-sync.js
// observes later.
function storedSeqs(db) {
  const { readState } = require('./settings-sync-store');
  let best = 0;
  const seen = value => { if (value && Number.isSafeInteger(value.seq) && value.seq > best) best = value.seq; };
  for (const owner of db.prepare('SELECT DISTINCT owner FROM learn_cards').pluck().all()) {
    try {
      seen(readState(db, `learn_v1_sync:${owner}`));
      seen(readState(db, `learn_level_v1:${owner}`));
    } catch { /* no system_state yet (a very old database): nothing stored */ }
  }
  return best;
}

// Schema 29 ("Sentences at the start for everyone" in docs/design/learn-english-page.md): v2.174.2 made the whole sentence play when a card appears
// ('start') the default of `audio_sentences_at`, but the learning settings are stored whole, so anyone who had changed any learning setting before
// had 'after' stored as if they had chosen it. Once, when a database below schema 29 is migrated, every owner's stored 'after' becomes 'start'
// with a new version of the settings (the next hybrid clock time and change number), so the Learn sync carries it to the linked engines and it wins
// over the old copy of a peer that was not migrated yet (two engines that migrate apart both write 'start', so they agree). The schema number is the
// marker: a database at 29 is never looked at again, so an explicit "After the answer" chosen later stays. A company computer is skipped: its
// learning settings are a read-only copy of its home's, which migrates them. Returns how many owners were changed.
function migrateSentencesAtStart(db, { company = false, now = Date.now() } = {}) {
  if (company) return 0;
  const { readState, writeState } = require('./settings-sync-store');
  // The owners with learning settings stored (the key after `learn_v1:`).
  let owners;
  let levels;
  try {
    owners = db.prepare("SELECT substr(key, 10) FROM system_state WHERE substr(key, 1, 9) = 'learn_v1:'").pluck().all();
    levels = db.prepare("SELECT substr(key, 16) FROM system_state WHERE substr(key, 1, 15) = 'learn_level_v1:'").pluck().all();
  } catch { return 0; } // no system_state (a database made before it): nothing stored
  let changed = 0;
  db.transaction(() => {
    // The change numbers and clock times kept in system_state come first, so the new version is after every one a peer may have seen.
    for (const owner of new Set([...owners, ...levels])) {
      for (const value of [readState(db, `learn_v1_sync:${owner}`), readState(db, `learn_level_v1:${owner}`)]) {
        if (value && typeof value === 'object') { observeSeq(db, value.seq); observe(db, value.at); }
      }
    }
    for (const owner of owners) {
      const value = readState(db, `learn_v1:${owner}`);
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.audio_sentences_at !== 'after') continue;
      writeState(db, `learn_v1:${owner}`, { ...value, audio_sentences_at: 'start' });
      writeState(db, `learn_v1_sync:${owner}`, { at: stamp(db, now), by: '', seq: nextSeq(db) });
      changed += 1;
    }
  })();
  return changed;
}

// The questions about a card and their answers ("Ask about a question" in docs/design/learn-english.md): only the newest MAX_CHAT_MESSAGES of a card
// are kept, ordered by time then uid, the same order on every engine, so the union of two engines pruned the same way is the same set.
const MAX_CHAT_MESSAGES = 20;
const CHAT_ORDER = 'at DESC, uid DESC';
function pruneChats(db, cardId) {
  return db.prepare(`DELETE FROM learn_chats WHERE card_id = ? AND uid NOT IN (SELECT uid FROM learn_chats WHERE card_id = ? ORDER BY ${CHAT_ORDER} LIMIT ?)`)
    .run(cardId, cardId, MAX_CHAT_MESSAGES).changes;
}

// The English chats ("Storage and limits" in docs/design/learn-english-chat.md): at most MAX_CONVO_MESSAGES messages a chat (a send past it is
// refused; messages are never pruned), and the newest MAX_CONVOS chats that are not journal chats are kept. An older one becomes a tombstone made
// by a prune (`deleted_by` 'prune') at its own last time + 1, so the same chats are pruned the same way on every engine, and a message written to
// it elsewhere later brings it back (the newer message wins over the older tombstone). Journal chats are never pruned. Returns how many were pruned.
const MAX_CONVOS = 50;
const MAX_CONVO_MESSAGES = 100;
// The coach conversation (uid COACH_UID, docs/design/learn-english-coach.md) is never pruned and has no message limit.
const COACH_UID = 'coach';
function pruneConvos(db, owner) {
  const old = db.prepare(`SELECT uid, updated_at, deleted_at FROM learn_convos WHERE owner = ? AND deleted = 0 AND journal = 0 AND uid <> 'coach'
    ORDER BY updated_at DESC, uid DESC LIMIT -1 OFFSET ?`).all(owner, MAX_CONVOS);
  for (const row of old) {
    db.prepare(`UPDATE learn_convos SET deleted = 1, deleted_at = ?, deleted_by = 'prune', sync_seq = ? WHERE owner = ? AND uid = ?`)
      .run(Math.max(row.deleted_at, row.updated_at + 1), nextSeq(db), owner, row.uid);
    db.prepare('DELETE FROM learn_convo_messages WHERE owner = ? AND convo_uid = ?').run(owner, row.uid);
  }
  return old.length;
}

function stateOf(db) {
  let state = clocks.get(db);
  if (state) return state;
  ensureSyncSchema(db);
  state = { clock: newestClock(db), seq: newestSeq(db) };
  clocks.set(db, state);
  return state;
}

// A time read from a peer or a row: the clock never goes behind it.
function observe(db, time) {
  const state = stateOf(db);
  if (Number.isSafeInteger(time) && time > state.clock) state.clock = time;
}
// The time of a local change.
function stamp(db, now = Date.now()) {
  const state = stateOf(db);
  state.clock = Math.max(now, state.clock + 1);
  return state.clock;
}
const nextSeq = db => { const state = stateOf(db); state.seq += 1; return state.seq; };
// A change number stored outside the tables (the version of the settings and of the level in system_state): the counter never goes behind it, so a
// row written after a restart never reuses a number a peer already has.
const observeSeq = (db, value) => { const state = stateOf(db); if (Number.isSafeInteger(value) && value > state.seq) state.seq = value; };
const maxSeq = db => stateOf(db).seq;
const reviewId = () => crypto.randomUUID();

function learnChanged(db) {
  for (const listener of listeners) {
    try { listener(db); } catch { /* the next round sends it anyway */ }
  }
}
function onLearnChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

module.exports = { COACH_UID, MAX_CHAT_MESSAGES, pruneChats, MAX_CONVOS, MAX_CONVO_MESSAGES, pruneConvos, ensureSyncSchema, migrateSentencesAtStart, observe, observeSeq, stamp, nextSeq, maxSeq, reviewId, learnChanged, onLearnChanged };
