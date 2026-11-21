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
// (`picked_level`, `picked_skipped`, `picked_at`; not picked yet), and schema 20 the table `learn_chats` (the questions about a card).
function ensureSyncSchema(db) {
  const columns = table => db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
  const cards = columns('learn_cards');
  if (!cards.length) return;
  const addCard = [];
  for (const [name, type] of [['content_at', 'INTEGER NOT NULL DEFAULT 0'], ['content_by', "TEXT NOT NULL DEFAULT ''"], ['state_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['state_by', "TEXT NOT NULL DEFAULT ''"], ['sync_seq', 'INTEGER NOT NULL DEFAULT 0'], ['phonetic', "TEXT NOT NULL DEFAULT ''"],
    // Schema 19: the pick of a sentence card (the level it was picked at, the known words it met, the clock of the pick).
    ['picked_level', "TEXT NOT NULL DEFAULT ''"], ['picked_skipped', 'INTEGER NOT NULL DEFAULT 0'], ['picked_at', 'INTEGER NOT NULL DEFAULT 0']]) {
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
  })();
}

// The questions about a card and their answers ("Ask about a question" in docs/design/learn-english.md): only the newest MAX_CHAT_MESSAGES of a card
// are kept, ordered by time then uid, the same order on every engine, so the union of two engines pruned the same way is the same set.
const MAX_CHAT_MESSAGES = 20;
const CHAT_ORDER = 'at DESC, uid DESC';
function pruneChats(db, cardId) {
  return db.prepare(`DELETE FROM learn_chats WHERE card_id = ? AND uid NOT IN (SELECT uid FROM learn_chats WHERE card_id = ? ORDER BY ${CHAT_ORDER} LIMIT ?)`)
    .run(cardId, cardId, MAX_CHAT_MESSAGES).changes;
}

function stateOf(db) {
  let state = clocks.get(db);
  if (state) return state;
  ensureSyncSchema(db);
  const max = sql => Number(db.prepare(sql).pluck().get()) || 0;
  state = {
    clock: Math.max(max('SELECT MAX(MAX(content_at), MAX(state_at)) FROM learn_cards'), max('SELECT MAX(at) FROM learn_card_moves'), max('SELECT MAX(at) FROM learn_chats')),
    seq: Math.max(max('SELECT MAX(sync_seq) FROM learn_cards'), max('SELECT MAX(sync_seq) FROM learn_reviews'), max('SELECT MAX(sync_seq) FROM learn_card_moves'),
      max('SELECT MAX(sync_seq) FROM learn_reports'), max('SELECT MAX(sync_seq) FROM learn_chats')),
  };
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

module.exports = { MAX_CHAT_MESSAGES, pruneChats, ensureSyncSchema, observe, observeSeq, stamp, nextSeq, maxSeq, reviewId, learnChanged, onLearnChanged };
