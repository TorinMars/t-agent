// The FSRS state of the stored cards ("Replay, sync and migration" in docs/design/learn-review-fsrs.md): the state of a card is the replay of its
// answers (learn_reviews of the card, by time, through services/learn-review.js) at the owner's desired retention. Used by services/learn.js (an
// answer on a card without a stored state), services/learn-sync.js (the cards a merge touched) and services/learn-sync-store.js (the schema 22
// migration). Plain database helpers: the caller holds the transaction.
//
// A card's history here is complete when it has at least one answer and at least as many answers as `reps` (the answers given, counted by
// whoever made the review state). It is not complete on a company computer (its answers leave once its home has them) or while a peer's answers
// are still on their way; such a card keeps the state it has, so no progress is ever lost, and a card with no answer stays new.
const review = require('./learn-review');
const { readState, isPlainObject } = require('./settings-sync-store');

// The review-state columns the replay sets (services/learn-merge.js STATE, the half of a card an answer changes).
const STATE_FIELDS = ['due_at', 'interval_days', 'ease', 'reps', 'lapses', 'last_result', 'last_at', 'last_correct', 'fsrs_stability', 'fsrs_difficulty'];

// The desired retention of an owner: `desired_retention` of the learning settings (system_state `learn_v1:<owner>`, services/learn.js settingsKey).
function retentionOf(db, owner) {
  let value = null;
  try { value = readState(db, `learn_v1:${owner}`); } catch { value = null; } // a database before system_state: the default
  return review.retentionOf(isPlainObject(value) ? value.desired_retention : undefined);
}

const answersOf = (db, cardId) => db.prepare('SELECT at, grade, correct, uid FROM learn_reviews WHERE card_id = ? ORDER BY at, uid').all(cardId);

// The state of a card row replayed from its answers here, or null when its history is not complete (above).
function replayed(db, row, retention = retentionOf(db, row.owner)) {
  const answers = answersOf(db, row.id);
  if (!answers.length || answers.length < (Number(row.reps) || 0)) return null;
  return review.replay(answers, { retention, ease: row.ease });
}

const same = (a, b) => (a === null || a === undefined ? b === null || b === undefined : a === b);
// Whether the replayed state differs from the row; `scheduleDiffers`: in the fields an older version reads too (all but the FSRS state).
const differs = (row, state) => STATE_FIELDS.some(field => !same(row[field], state[field]));
const OLDER_FIELDS = STATE_FIELDS.filter(field => !field.startsWith('fsrs_'));
const scheduleDiffers = (row, state) => OLDER_FIELDS.some(field => !same(row[field], state[field]));

// Writes a replayed state into the card. `extra`: more columns to set (sync_seq, state_at, state_by).
function writeReplayed(db, id, state, extra = {}) {
  const fields = [...STATE_FIELDS, ...Object.keys(extra)];
  db.prepare(`UPDATE learn_cards SET ${fields.map(field => `${field} = @${field}`).join(', ')} WHERE id = @id`)
    .run({ ...Object.fromEntries(STATE_FIELDS.map(field => [field, state[field] === undefined ? null : state[field]])), ...extra, id });
}

// The due dates of the owner's cards with an FSRS state at another desired retention, from their stability and last answer; returns how many
// changed. No clock and no change number: every engine reschedules when the setting reaches it (the same stability gives the same date).
function reschedule(db, owner, retention) {
  const rows = db.prepare(`SELECT id, due_at, interval_days, last_result, last_at, fsrs_stability, fsrs_difficulty FROM learn_cards
    WHERE owner = ? AND kind = 'word' AND fsrs_stability IS NOT NULL AND last_at IS NOT NULL`).all(owner);
  const update = db.prepare('UPDATE learn_cards SET due_at = ?, interval_days = ? WHERE id = ?');
  let changed = 0;
  for (const row of rows) {
    const next = review.rescheduled(row, retention);
    if (!next || (next.due_at === row.due_at && next.interval_days === row.interval_days)) continue;
    update.run(next.due_at, next.interval_days, row.id);
    changed += 1;
  }
  return changed;
}

// Schema 21 -> 22 (services/learn-sync-store.js ensureSyncSchema calls it once, when it adds the columns): every card with a complete history gets
// the state of its replay. A card whose state changed gets the review-state clock `clock` (this device) and a new change number (`nextSeq()`), so
// the linked engines that do not compute it (an older version, a company computer) take the replayed schedule; an engine of this version that
// replays the same answers gets the same state, so the sync changes nothing there. Returns { replayed, changed, earlier, later, skipped }:
// cards replayed, of them those whose state changed and whose due date moved earlier or later, and cards with answers left as they are.
function migrate(db, { clock, nextSeq }) {
  const rows = db.prepare('SELECT * FROM learn_cards WHERE EXISTS (SELECT 1 FROM learn_reviews r WHERE r.card_id = learn_cards.id) ORDER BY id').all();
  const retentions = new Map();
  const stats = { replayed: 0, changed: 0, earlier: 0, later: 0, skipped: 0 };
  for (const row of rows) {
    if (!retentions.has(row.owner)) retentions.set(row.owner, retentionOf(db, row.owner));
    const state = replayed(db, row, retentions.get(row.owner));
    if (!state) { stats.skipped += 1; continue; }
    stats.replayed += 1;
    if (!differs(row, state)) continue;
    stats.changed += 1;
    if (state.due_at < row.due_at) stats.earlier += 1;
    else if (state.due_at > row.due_at) stats.later += 1;
    writeReplayed(db, row.id, state, { state_at: clock, state_by: '', sync_seq: nextSeq() });
  }
  return stats;
}

module.exports = { STATE_FIELDS, retentionOf, answersOf, replayed, differs, scheduleDiffers, writeReplayed, reschedule, migrate };
