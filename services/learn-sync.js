// English learning across linked devices ("Sync across linked devices" and "Company computer" in docs/design/learn-english.md): the cards, the
// review history and the learning settings are one set on every normal machine joined by service links, and a company computer keeps only a cache
// of the cards and the answers that wait for a normal machine.
//
// - Rows: a card is identified by kind + normalized text (its local id stays local), an answer by a random uid, a move (a card's text changed) by
//   its old kind + text. Merge rules: services/learn-merge.js (two clocks per card, last writer wins per half, a meaning never replaced by an empty one;
//   answers a union by uid; settings last writer wins).
// - Change numbers: every row written here, locally or from a peer, gets the next number of the database (services/learn-sync-store.js). A device
//   asks a peer for the rows after the highest number of that peer it has (`have`, kept per link), one page at a time, and sends its own rows after
//   the number the peer reports. A receiver applies a row only when it changes something, so an echo stops at once, and what it applied gets new
//   numbers, so it goes on to its other peers (a chain A–B–C reaches C).
// - Transport: GET /v1/info must list `learn:sync`; GET /v1/learn-sync, POST /v1/learn-sync/pull, PUT /v1/learn-sync. Rows travel only inside the
//   settings sync's AES-256-GCM envelopes, with a key derived from that link's settings-sync key and their own additional data.
// - Company computer (services/device-tier.js): it syncs only with its home (the online normal linked machine with the oldest link), pulls cards and
//   settings but never answers, pushes its own changes at once, and deletes its answers once the home has them. Normal machines never sync with it
//   themselves. With no normal machine linked it keeps its data as a normal machine would, and moves nothing.
const crypto = require('crypto');
const syncStore = require('./learn-sync-store');
const merge = require('./learn-merge');
const { seal, open } = require('./settings-sync');
const { readState, writeState, isPlainObject } = require('./settings-sync-store');
const learnModule = require('./learn');
const review = require('./learn-review');
const replaySchedule = require('./learn-schedule');
const { STARTER_LISTS } = require('./learn-starter');

const CAPABILITY = 'learn:sync';
// learn:reports: the peer keeps the detail of wrong answers and the mistake reports (schema 17), and answers the home routes of the reports. The
// weekly report is made by the normal engine with the smallest instance id among the online ones that have it ("Mistake reports" in
// docs/design/learn-english.md).
const REPORTS_CAPABILITY = 'learn:reports';
// learn:pick: the peer picks words from the translated sentences and keeps the estimated level (schema 19); the backlog of sentences is picked by the
// normal engine with the smallest instance id among the online ones that have it ("Picking words from translations" in docs/design/learn-english.md).
const PICK_CAPABILITY = 'learn:pick';
// The kind of pull a normal machine keeps its `have` for. It was 'full' before schema 16, 'full-16' before schema 19, 'full-19' before schema 20 and
// 'full-20' before schema 21: a new name makes every link read the other side once from the start after the update, so what an older version left
// out (the reports and the detail of wrong answers; the level, the picks of the sentences and the whole sentence of a picked word; the questions
// about a card; the English chats) comes over (rows that change nothing are not applied again).
const FULL = 'full-21';
const ROUTE = '/v1/learn-sync';
const PEERS_KEY = 'learn_sync_peers_v1';
const HOME_KEY = 'learn_home_v1';
const PAGE_SIZE = 200;
const MAX_PAGE = 1000;
const MAX_PAGES_PER_ROUND = 500;
const MAX_HOPS = 8;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const DEBOUNCE_MS = 2000;
const COMPANY_DEBOUNCE_MS = 200;
const REQUEST_TIMEOUT_MS = 15_000;
const READ_WAIT_MS = 4000;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const INSTANCE_ID = /^[A-Za-z0-9-]{1,64}$/;

const fault = (code, statusCode = 400) => Object.assign(new Error(code), { statusCode });
const errorCode = error => (error && /^[A-Z0-9_]{1,64}$/.test(error.message || '') ? error.message : 'LEARN_SYNC_FAILED');
const aadOf = (direction, sender, linkId) => Buffer.from(`t-agent learn-sync v1|${direction}|${sender}|${linkId}`);
const learnKeyFrom = linkKey => Buffer.from(crypto.hkdfSync('sha256', linkKey, Buffer.alloc(0), Buffer.from('t-agent learn-sync v1'), 32));
const int = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

function createLearnSync(options) {
  const {
    db, serviceLinks = null, request = null,
    identity, // () => { instance_id, name }
    owner = () => require('./single-user').ensureSingleUser().login,
    linkKeys, // { publicKey(), linkKey(peer, publicKey) }: the settings sync's key pair and link keys
    tier = { isCompany: () => false },
    enabled = () => true,
    learn = null, // the learning service of this database, for the routes a company computer calls on its home
    timeZone, now = Date.now, log = console,
    intervalMs = SYNC_INTERVAL_MS, debounceMs = DEBOUNCE_MS, companyDebounceMs = COMPANY_DEBOUNCE_MS, timeoutMs = REQUEST_TIMEOUT_MS,
    pageSize = PAGE_SIZE, readWaitMs = READ_WAIT_MS,
  } = options;
  const me = () => identity().instance_id;
  const own = by => (by === me() ? '' : by); // a version this device made is stored with ''
  const company = () => Boolean(tier.isCompany());
  let learnService = learn;
  const service = () => learnService || (learnService = learnModule.createLearn({ db, now, timeZone, cacheOnly }));

  // ---- Stored state ----
  function readPeers() {
    const value = readState(db, PEERS_KEY);
    return isPlainObject(value) ? value : {};
  }
  function updatePeer(id, change) {
    const peers = readPeers();
    const current = isPlainObject(peers[id]) ? peers[id] : {};
    peers[id] = { ...current, ...change(current) };
    if (serviceLinks) {
      const live = new Set(livePeers().map(peer => peer.id));
      for (const key of Object.keys(peers)) if (!live.has(key)) delete peers[key];
    }
    writeState(db, PEERS_KEY, peers);
    return peers[id];
  }
  const peerState = id => { const state = readPeers()[id]; return isPlainObject(state) ? state : {}; };

  // Settings from before this feature get a version (time 0, so a real change wins) and a change number, so they are sent once.
  let prepared = false;
  function prepare() {
    if (prepared) return;
    prepared = true;
    const name = owner();
    if (readState(db, learnModule.settingsKey(name)) !== null && readState(db, learnModule.settingsVersionKey(name)) === null) {
      writeState(db, learnModule.settingsVersionKey(name), { at: 0, by: '', seq: syncStore.nextSeq(db) });
    }
    // The change numbers kept in system_state: the counter starts after them.
    syncStore.observeSeq(db, settingsVersion(name).seq);
    const level = readState(db, learnModule.levelKey(name));
    if (isPlainObject(level)) { syncStore.observeSeq(db, int(level.seq)); syncStore.observe(db, int(level.at)); }
  }

  // ---- Links, tiers and the home ----
  const livePeers = () => {
    if (!serviceLinks) return [];
    try { return serviceLinks.peers(); } catch { return []; }
  };
  const onlinePeers = () => livePeers().filter(peer => peer.online);
  // The linked machines known to be normal and to have the sync (from their last /v1/info), oldest link first.
  const normalPeers = () => { const states = readPeers(); return livePeers().filter(peer => states[peer.id] && states[peer.id].supported === true && states[peer.id].company === false); };
  // A company computer with a normal machine to keep its data on: its learning data is a cache. Otherwise (a normal machine, every machine marked,
  // or no normal machine ever seen) the data stays here as it is.
  const cacheOnly = () => Boolean(enabled()) && company() && normalPeers().length > 0;
  // The home of a company computer: the online normal machine with the oldest link, or null while none is online.
  const homePeer = () => (cacheOnly() ? normalPeers().find(peer => peer.online) || null : null);
  // The name shown while the home is away: the last home, else the normal machine with the oldest link.
  function homeName() {
    const online = homePeer();
    if (online) return online.name;
    const last = readState(db, HOME_KEY);
    const normal = normalPeers();
    const known = last && normal.find(peer => peer.id === last.link_id);
    return (known || normal[0] || {}).name || null;
  }

  // ---- Keys ----
  function learnKey(peer, publicKey) {
    if (typeof publicKey !== 'string' || !PUBLIC_KEY.test(publicKey)) throw fault('LEARN_SYNC_BAD_KEY', 400);
    return learnKeyFrom(linkKeys.linkKey(peer, publicKey));
  }

  // ---- Reading rows ----
  const o = () => owner();
  const cardAt = (kind, norm) => db.prepare('SELECT * FROM learn_cards WHERE owner = ? AND kind = ? AND norm = ?').get(o(), kind, norm);
  const moveAt = (kind, norm) => db.prepare('SELECT * FROM learn_card_moves WHERE owner = ? AND kind = ? AND norm = ?').get(o(), kind, norm);
  // The card a text leads to now, following moves.
  function cardFollowing(kind, norm) {
    let key = norm;
    for (let hops = 0; hops <= MAX_HOPS; hops += 1) {
      const card = cardAt(kind, key);
      if (card) return card;
      const move = moveAt(kind, key);
      if (!move) return null;
      key = move.moved_to;
    }
    return null;
  }
  function settingsVersion(name) {
    const value = readState(db, learnModule.settingsVersionKey(name));
    return { at: int(value && value.at), by: value && typeof value.by === 'string' ? value.by : '', seq: int(value && value.seq) };
  }

  // The rows after change number `after`, at most `limit` (answers left out for a company computer): { cards, reviews, moves, settings, after, next,
  // more }. A card that an answer or a move in the page needs is added to the page, so the receiver always has it. `next` is the number to ask
  // after next time; with nothing more it is the newest number, so rows a page leaves out (answers) are not asked for again.
  function exportPage(after, limit, { reviews = true } = {}) {
    prepare();
    const name = o();
    const newest = syncStore.maxSeq(db);
    const cards = db.prepare('SELECT * FROM learn_cards WHERE owner = ? AND sync_seq > ? ORDER BY sync_seq LIMIT ?').all(name, after, limit);
    const answers = reviews ? db.prepare(`SELECT r.*, c.kind AS kind, c.norm AS norm FROM learn_reviews r JOIN learn_cards c ON c.id = r.card_id
      WHERE r.owner = ? AND r.sync_seq > ? ORDER BY r.sync_seq LIMIT ?`).all(name, after, limit) : [];
    const moves = db.prepare('SELECT * FROM learn_card_moves WHERE owner = ? AND sync_seq > ? ORDER BY sync_seq LIMIT ?').all(name, after, limit);
    // The mistake reports are personal like the answers: a company computer gets none.
    const reports = reviews ? db.prepare('SELECT * FROM learn_reports WHERE owner = ? AND sync_seq > ? ORDER BY sync_seq LIMIT ?').all(name, after, limit) : [];
    // The questions about a card and their answers: personal too.
    const chats = reviews ? db.prepare(`SELECT m.*, c.kind AS kind, c.norm AS norm FROM learn_chats m JOIN learn_cards c ON c.id = m.card_id
      WHERE m.owner = ? AND m.sync_seq > ? ORDER BY m.sync_seq LIMIT ?`).all(name, after, limit) : [];
    // The English chats and their messages: personal too.
    const convos = reviews ? db.prepare('SELECT * FROM learn_convos WHERE owner = ? AND sync_seq > ? ORDER BY sync_seq LIMIT ?').all(name, after, limit) : [];
    const convoMessages = reviews ? db.prepare('SELECT * FROM learn_convo_messages WHERE owner = ? AND sync_seq > ? ORDER BY sync_seq LIMIT ?').all(name, after, limit) : [];
    const version = settingsVersion(name);
    const settingsValue = version.seq > after ? readState(db, learnModule.settingsKey(name)) : null;
    // The estimated level: a read-only copy for a company computer too, like the settings.
    const levelValue = readState(db, learnModule.levelKey(name));
    const level = isPlainObject(levelValue) && int(levelValue.seq) > after && merge.levelFromPeer(levelValue) ? levelValue : null;
    const rows = [
      ...cards.map(row => ({ type: 'card', seq: row.sync_seq, row })),
      ...answers.map(row => ({ type: 'review', seq: row.sync_seq, row })),
      ...moves.map(row => ({ type: 'move', seq: row.sync_seq, row })),
      ...reports.map(row => ({ type: 'report', seq: row.sync_seq, row })),
      ...chats.map(row => ({ type: 'chat', seq: row.sync_seq, row })),
      ...convos.map(row => ({ type: 'convo', seq: row.sync_seq, row })),
      ...convoMessages.map(row => ({ type: 'convo_message', seq: row.sync_seq, row })),
      ...(settingsValue !== null ? [{ type: 'settings', seq: version.seq }] : []),
      ...(level ? [{ type: 'level', seq: int(level.seq) }] : []),
    ].sort((a, b) => a.seq - b.seq);
    const taken = rows.slice(0, limit);
    const more = rows.length > limit || [cards, answers, moves, reports, chats, convos, convoMessages].some(list => list.length >= limit);
    const page = {
      cards: [], reviews: [], moves: [], reports: [], chats: [], convos: [], convo_messages: [], settings: null, level: null, after,
      next: more ? taken[taken.length - 1].seq : Math.max(newest, after), more,
    };
    const ids = new Set();
    const self = me();
    const addCard = row => { if (row && !ids.has(row.id)) { ids.add(row.id); page.cards.push(merge.cardToPeer(row, self)); } };
    const convoIds = new Set();
    const addConvo = row => { if (row && !convoIds.has(row.uid)) { convoIds.add(row.uid); page.convos.push(merge.convoToPeer(row, self)); } };
    for (const entry of taken) {
      if (entry.type === 'card') addCard(entry.row);
      else if (entry.type === 'review') page.reviews.push(merge.reviewToPeer(entry.row));
      else if (entry.type === 'move') page.moves.push(merge.moveToPeer(entry.row, self));
      else if (entry.type === 'report') page.reports.push(merge.reportToPeer(entry.row, self));
      else if (entry.type === 'chat') page.chats.push(merge.chatToPeer(entry.row, self));
      else if (entry.type === 'convo') addConvo(entry.row);
      else if (entry.type === 'convo_message') page.convo_messages.push(merge.convoMessageToPeer(entry.row, self));
      else if (entry.type === 'level') page.level = { value: merge.levelFromPeer(level), at: int(level.at), by: level.by || self };
      else page.settings = { value: settingsValue, at: version.at, by: version.by || self };
    }
    for (const entry of taken) {
      if (entry.type === 'review' || entry.type === 'chat') addCard(db.prepare('SELECT * FROM learn_cards WHERE id = ?').get(entry.row.card_id));
      if (entry.type === 'move') addCard(cardFollowing(entry.row.kind, entry.row.moved_to));
      // A message goes with its chat, so the receiver always has the chat first.
      if (entry.type === 'convo_message') addConvo(db.prepare('SELECT * FROM learn_convos WHERE owner = ? AND uid = ?').get(name, entry.row.convo_uid));
    }
    return page;
  }

  // ---- Applying rows ----
  // Applies a page from `sender` in one transaction and returns how many rows changed something. `bump`: what changed gets new change numbers, so it
  // goes on to the other peers (false on a company computer, which passes nothing on).
  function applyPage(payload, sender, { bump = true } = {}) {
    if (!isPlainObject(payload)) throw fault('INVALID_LEARN_SYNC', 400);
    const list = key => (Array.isArray(payload[key]) ? payload[key] : []);
    if (list('cards').length + list('reviews').length + list('moves').length + list('reports').length + list('chats').length + list('convos').length
      + list('convo_messages').length > MAX_PAGE * 7) throw fault('LEARN_SYNC_TOO_LARGE', 413);
    prepare();
    const self = me();
    const name = o();
    const seqFor = current => (bump ? syncStore.nextSeq(db) : current);
    let applied = 0;
    // The cards whose review state or answers changed here: recomputed from their answers at the end (replayTouched).
    const touched = new Set();
    const writeCard = (id, card, currentSeq) => db.prepare(`UPDATE learn_cards SET created_at = @created_at, en = @en, zh = @zh, phonetic = @phonetic, source = @source,
      context = @context, suspended = @suspended, content_at = @content_at, content_by = @content_by, due_at = @due_at, interval_days = @interval_days,
      ease = @ease, reps = @reps, lapses = @lapses, last_result = @last_result, last_at = @last_at, last_correct = @last_correct,
      fsrs_stability = @fsrs_stability, fsrs_difficulty = @fsrs_difficulty, state_at = @state_at, state_by = @state_by, picked_level = @picked_level, picked_skipped = @picked_skipped, picked_at = @picked_at, sync_seq = @sync_seq WHERE id = @id`)
      .run({ ...card, content_by: own(card.content_by), state_by: own(card.state_by), sync_seq: seqFor(currentSeq), id });

    function applyCard(raw) {
      const card = merge.cardFromPeer(raw, sender);
      if (!card) return;
      syncStore.observe(db, card.content_at);
      syncStore.observe(db, card.state_at);
      syncStore.observe(db, card.picked_at);
      let key = card.norm;
      let follow = false;
      let local = cardAt(card.kind, key);
      for (let hops = 0; !local && hops < MAX_HOPS; hops += 1) {
        const move = moveAt(card.kind, key);
        if (!move) break;
        if (!follow && merge.later(card.content_at, card.content_by, move.at, move.by || self)) {
          // The text came back after the move (added or edited again later): the card lives at its text again.
          db.prepare('DELETE FROM learn_card_moves WHERE owner = ? AND kind = ? AND norm = ?').run(name, card.kind, key);
          break;
        }
        key = move.moved_to;
        follow = true;
        local = cardAt(card.kind, key);
      }
      if (!local) {
        if (follow) return; // the card it moved to is not here: nothing to merge into
        db.prepare(`INSERT INTO learn_cards (owner, kind, en, norm, zh, phonetic, source, context, created_at, due_at, interval_days, ease, reps, lapses, last_result,
          last_at, last_correct, fsrs_stability, fsrs_difficulty, suspended, content_at, content_by, state_at, state_by, picked_level, picked_skipped, picked_at,
          sync_seq) VALUES (@owner, @kind, @en, @norm, @zh, @phonetic, @source, @context, @created_at, @due_at, @interval_days, @ease, @reps, @lapses, @last_result,
          @last_at, @last_correct, @fsrs_stability, @fsrs_difficulty, @suspended, @content_at, @content_by, @state_at, @state_by, @picked_level, @picked_skipped,
          @picked_at, @sync_seq)`).run({ ...card, owner: name, content_by: own(card.content_by), state_by: own(card.state_by), sync_seq: bump ? syncStore.nextSeq(db) : 0 });
        applied += 1;
        return;
      }
      const result = merge.mergeCard(merge.resolved(local, self), card, { follow });
      if (!result.changed) return;
      writeCard(local.id, result.card, local.sync_seq);
      touched.add(local.id);
      applied += 1;
    }

    function applyMove(raw) {
      const move = merge.moveFromPeer(raw, sender);
      if (!move) return;
      syncStore.observe(db, move.at);
      const existing = moveAt(move.kind, move.norm);
      if (existing && !merge.later(move.at, move.by, existing.at, existing.by || self)) return;
      const card = cardAt(move.kind, move.norm);
      if (card && merge.later(card.content_at, card.content_by || self, move.at, move.by)) return; // changed here after the move: it stays
      if (card) {
        const target = cardFollowing(move.kind, move.moved_to);
        if (!target || target.id === card.id) return;
        const result = merge.mergeCard(merge.resolved(target, self), merge.resolved(card, self), { follow: true });
        if (result.changed) writeCard(target.id, result.card, target.sync_seq);
        if (db.prepare('UPDATE learn_reviews SET card_id = ? WHERE card_id = ?').run(target.id, card.id).changes || result.changed) touched.add(target.id);
        // The questions about the old text go with the card; the newest 20 of both are kept.
        if (db.prepare('UPDATE learn_chats SET card_id = ? WHERE card_id = ?').run(target.id, card.id).changes) syncStore.pruneChats(db, target.id);
        db.prepare('DELETE FROM learn_cards WHERE id = ?').run(card.id);
      }
      db.prepare(`INSERT INTO learn_card_moves (owner, kind, norm, moved_to, at, by, sync_seq) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (owner, kind, norm) DO UPDATE SET moved_to = excluded.moved_to, at = excluded.at, by = excluded.by, sync_seq = excluded.sync_seq`)
        .run(name, move.kind, move.norm, move.moved_to, move.at, own(move.by), bump ? syncStore.nextSeq(db) : (existing ? existing.sync_seq : 0));
      applied += 1;
    }

    function applyReview(raw) {
      const answer = merge.reviewFromPeer(raw);
      if (!answer) return;
      const existing = db.prepare('SELECT id, tag, expected, sync_seq FROM learn_reviews WHERE uid = ?').get(answer.uid);
      if (existing) {
        // An answer that came here through an older version lost its detail: it is filled in, never replaced (like a meaning).
        if (!existing.tag && existing.expected === null && (answer.tag || answer.expected)) {
          db.prepare('UPDATE learn_reviews SET expected = ?, tag = ?, hinted = ?, sync_seq = ? WHERE id = ?')
            .run(answer.expected, answer.tag, answer.hinted, bump ? syncStore.nextSeq(db) : existing.sync_seq, existing.id);
          applied += 1;
        }
        return;
      }
      const card = cardFollowing(answer.kind, answer.norm);
      if (!card) return;
      db.prepare('INSERT INTO learn_reviews (card_id, owner, at, mode, grade, correct, answer, uid, sync_seq, expected, tag, hinted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(card.id, name, answer.at, answer.mode, answer.grade, answer.correct, answer.answer, answer.uid, bump ? syncStore.nextSeq(db) : 0, answer.expected, answer.tag, answer.hinted);
      touched.add(card.id);
      applied += 1;
    }

    // A report is made once and never changed: a new one is copied; the same id from another engine (the automatic report of one week made on two)
    // keeps the earlier one everywhere.
    function applyReport(raw) {
      const value = merge.reportFromPeer(raw, sender);
      if (!value) return;
      const existing = db.prepare('SELECT created_at, by, sync_seq FROM learn_reports WHERE owner = ? AND uid = ?').get(name, value.uid);
      if (existing && !merge.reportWins(value, { created_at: existing.created_at, by: existing.by || self })) return;
      db.prepare(`INSERT INTO learn_reports (owner, uid, created_at, covers_from, covers_until, auto, lang, mistakes, answers, model, body, by, sync_seq)
        VALUES (@owner, @uid, @created_at, @covers_from, @covers_until, @auto, @lang, @mistakes, @answers, @model, @body, @by, @sync_seq)
        ON CONFLICT (owner, uid) DO UPDATE SET created_at = excluded.created_at, covers_from = excluded.covers_from, covers_until = excluded.covers_until,
        auto = excluded.auto, lang = excluded.lang, mistakes = excluded.mistakes, answers = excluded.answers, model = excluded.model, body = excluded.body,
        by = excluded.by, sync_seq = excluded.sync_seq`)
        .run({ ...value, owner: name, body: JSON.stringify(value.body), by: own(value.by), sync_seq: bump ? syncStore.nextSeq(db) : (existing ? existing.sync_seq : 0) });
      applied += 1;
    }

    // A question or an answer about a card: a new uid is stored with the card it names now (following moves), and the card keeps its newest 20; one
    // that is older than those 20 is not kept (it changed nothing).
    function applyChat(raw) {
      const message = merge.chatFromPeer(raw, sender);
      if (!message) return;
      syncStore.observe(db, message.at);
      if (db.prepare('SELECT 1 FROM learn_chats WHERE owner = ? AND uid = ?').get(name, message.uid)) return;
      const card = cardFollowing(message.kind, message.norm);
      if (!card) return;
      db.prepare('INSERT INTO learn_chats (owner, uid, card_id, role, text, at, by, sync_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(name, message.uid, card.id, message.role, message.text, message.at, own(message.by), bump ? syncStore.nextSeq(db) : 0);
      syncStore.pruneChats(db, card.id);
      if (db.prepare('SELECT 1 FROM learn_chats WHERE owner = ? AND uid = ?').get(name, message.uid)) applied += 1;
    }

    // An English chat ("Sync" in docs/design/learn-english-chat.md): merged part by part (services/learn-merge.js mergeConvo); a chat that ends deleted
    // loses its messages. When the peer had it deleted but it stays here (a message here is newer than its tombstone, or a prune met a journal
    // chat), the messages here get new change numbers, so the peer, which removed them, gets them back.
    let convosTouched = false;
    function applyConvo(raw) {
      const value = merge.convoFromPeer(raw, sender);
      if (!value) return;
      for (const time of [value.title_at, value.journal_at, value.deleted_at, value.updated_at]) syncStore.observe(db, time);
      const local = db.prepare('SELECT * FROM learn_convos WHERE owner = ? AND uid = ?').get(name, value.uid) || null;
      const { convo, changed } = merge.mergeConvo(local, value);
      if (bump && local && value.deleted && !convo.deleted) {
        for (const uid of db.prepare('SELECT uid FROM learn_convo_messages WHERE owner = ? AND convo_uid = ? ORDER BY at, uid').pluck().all(name, value.uid)) {
          db.prepare('UPDATE learn_convo_messages SET sync_seq = ? WHERE owner = ? AND uid = ?').run(syncStore.nextSeq(db), name, uid);
        }
      }
      if (!changed) return;
      const row = { ...convo, owner: name, uid: value.uid };
      if (local) {
        db.prepare(`UPDATE learn_convos SET title = @title, title_at = @title_at, journal = @journal, journal_by = @journal_by, journal_at = @journal_at,
          created_at = @created_at, updated_at = @updated_at, deleted = @deleted, deleted_at = @deleted_at, deleted_by = @deleted_by, sync_seq = @sync_seq
          WHERE owner = @owner AND uid = @uid`).run({ ...row, sync_seq: seqFor(local.sync_seq) });
      } else {
        db.prepare(`INSERT INTO learn_convos (owner, uid, title, title_at, journal, journal_by, journal_at, created_at, updated_at, deleted, deleted_at, deleted_by,
          by, sync_seq) VALUES (@owner, @uid, @title, @title_at, @journal, @journal_by, @journal_at, @created_at, @updated_at, @deleted, @deleted_at, @deleted_by,
          @by, @sync_seq)`).run({ ...row, by: own(value.by), sync_seq: bump ? syncStore.nextSeq(db) : 0 });
      }
      if (convo.deleted) db.prepare('DELETE FROM learn_convo_messages WHERE owner = ? AND convo_uid = ?').run(name, value.uid);
      convosTouched = true;
      applied += 1;
    }
    // A message of a chat: a new uid is stored when its chat is here and not deleted (it comes with its chat in the same page); the chat's last time
    // follows it.
    function applyConvoMessage(raw) {
      const message = merge.convoMessageFromPeer(raw, sender);
      if (!message) return;
      syncStore.observe(db, message.at);
      if (db.prepare('SELECT 1 FROM learn_convo_messages WHERE owner = ? AND uid = ?').get(name, message.uid)) return;
      const convo = db.prepare('SELECT deleted, updated_at FROM learn_convos WHERE owner = ? AND uid = ?').get(name, message.convo_uid);
      if (!convo || convo.deleted) return;
      db.prepare(`INSERT INTO learn_convo_messages (owner, uid, convo_uid, role, text, at, meta, by, sync_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(name, message.uid, message.convo_uid, message.role, message.text, message.at, message.meta, own(message.by), bump ? syncStore.nextSeq(db) : 0);
      if (message.at > convo.updated_at) db.prepare('UPDATE learn_convos SET updated_at = ? WHERE owner = ? AND uid = ?').run(message.at, name, message.convo_uid);
      convosTouched = true;
      applied += 1;
    }

    function applySettings(raw) {
      if (!isPlainObject(raw) || !Number.isSafeInteger(raw.at) || raw.at < 0) return;
      let value;
      try { value = merge.settingsFromPeer(raw.value, STARTER_LISTS); } catch { return; }
      if (value === null) return;
      const by = typeof raw.by === 'string' && INSTANCE_ID.test(raw.by) ? raw.by : sender;
      syncStore.observe(db, raw.at);
      const local = settingsVersion(name);
      const stored = readState(db, learnModule.settingsKey(name));
      const hasValue = stored !== null;
      if (hasValue && !merge.later(raw.at, by, local.at, local.by || self)) return;
      // An older peer does not know the desired retention and sends none: the one here stays (it is not reset to the default).
      if (value.desired_retention === undefined && isPlainObject(stored) && review.RETENTIONS.includes(stored.desired_retention)) value.desired_retention = stored.desired_retention;
      const before = replaySchedule.retentionOf(db, name);
      writeState(db, learnModule.settingsKey(name), value);
      const after = replaySchedule.retentionOf(db, name);
      if (after !== before) retentionChanged = after;
      writeState(db, learnModule.settingsVersionKey(name), { at: raw.at, by: own(by), seq: bump ? syncStore.nextSeq(db) : local.seq });
      applied += 1;
    }

    // The estimated level: the newest estimate wins (the later version, a tie to the greater instance id).
    function applyLevel(raw) {
      if (!isPlainObject(raw) || !Number.isSafeInteger(raw.at) || raw.at < 0) return;
      const value = merge.levelFromPeer(raw.value);
      if (!value) return;
      const by = typeof raw.by === 'string' && INSTANCE_ID.test(raw.by) ? raw.by : sender;
      syncStore.observe(db, raw.at);
      const local = readState(db, learnModule.levelKey(name));
      if (isPlainObject(local) && merge.levelFromPeer(local) && !merge.later(raw.at, by, int(local.at), local.by || self)) return;
      writeState(db, learnModule.levelKey(name), { ...value, at: raw.at, by: own(by), seq: bump ? syncStore.nextSeq(db) : int(local && local.seq) });
      applied += 1;
    }

    // A desired retention that came with the settings: the due dates of the cards follow it (every engine does the same from the same stability).
    let retentionChanged = null;
    // The touched cards with a complete history get the state of their replay, so two engines with the same answers have the same state whatever
    // order the answers came in. Not on a company computer (its cache takes its home's state: its answers are not all here). A state made by a
    // version that does not compute FSRS (an older peer: NULL with answers) whose schedule differs from the replay gets a new review-state clock
    // with it, so that peer takes it; any other replay keeps the clock: an engine with the same answers replays to the same state, and a replay
    // that only adds the FSRS state (a replayed schedule that came through an older peer, which drops it) changes nothing that peer reads, so
    // nothing goes back and forth.
    function replayTouched() {
      if (!bump || !touched.size) return;
      const retention = replaySchedule.retentionOf(db, name);
      for (const id of touched) {
        const row = db.prepare('SELECT * FROM learn_cards WHERE id = ?').get(id);
        if (!row) continue;
        const state = replaySchedule.replayed(db, row, retention);
        if (!state || !replaySchedule.differs(row, state)) continue;
        const older = (row.fsrs_stability === null || row.fsrs_stability === undefined) && (Number(row.reps) || 0) > 0 && replaySchedule.scheduleDiffers(row, state);
        replaySchedule.writeReplayed(db, row.id, state, { sync_seq: syncStore.nextSeq(db), ...(older ? { state_at: syncStore.stamp(db, now()), state_by: '' } : {}) });
        applied += 1;
      }
    }

    db.transaction(() => {
      for (const raw of list('cards')) applyCard(raw);
      for (const raw of list('moves')) applyMove(raw);
      for (const raw of list('reviews')) applyReview(raw);
      for (const raw of list('reports')) applyReport(raw);
      for (const raw of list('chats')) applyChat(raw);
      for (const raw of list('convos')) applyConvo(raw);
      for (const raw of list('convo_messages')) applyConvoMessage(raw);
      // The newest 50 chats that are not journal chats, the same on every engine after the merge.
      if (convosTouched && bump) syncStore.pruneConvos(db, name);
      if (payload.settings) applySettings(payload.settings);
      if (payload.level) applyLevel(payload.level);
      if (retentionChanged !== null) replaySchedule.reschedule(db, name, retentionChanged);
      replayTouched();
    })();
    return applied;
  }

  // ---- A company computer hands its answers over ----
  // The answers and the mistake reports the home has (change number up to `acked`) leave this machine; the cards stay as the cache.
  function dropHandedOver(acked) {
    if (!cacheOnly() || !acked) return 0;
    const reports = db.prepare('DELETE FROM learn_reports WHERE owner = ? AND sync_seq <= ?').run(o(), acked).changes;
    const chats = db.prepare('DELETE FROM learn_chats WHERE owner = ? AND sync_seq <= ?').run(o(), acked).changes;
    // The English chats it had from before it was marked (its page chats on the home since).
    const convos = db.prepare('DELETE FROM learn_convo_messages WHERE owner = ? AND sync_seq <= ?').run(o(), acked).changes
      + db.prepare('DELETE FROM learn_convos WHERE owner = ? AND sync_seq <= ?').run(o(), acked).changes;
    return reports + chats + convos + db.prepare('DELETE FROM learn_reviews WHERE owner = ? AND sync_seq <= ?').run(o(), acked).changes;
  }
  // How many changes of this company computer wait for a normal machine: its answers, and the cards it added or edited and the moves it made that the
  // home has not got (an answer's new review state goes with the answer and is not counted again).
  function waiting() {
    if (!cacheOnly()) return 0;
    const last = readState(db, HOME_KEY);
    const home = homePeer() || (last ? { id: last.link_id } : null);
    const acked = home ? int(peerState(home.id).acked) : 0;
    const name = o();
    const count = sql => Number(db.prepare(sql).pluck().get(name, acked)) || 0;
    return (Number(db.prepare('SELECT COUNT(*) FROM learn_reviews WHERE owner = ?').pluck().get(name)) || 0)
      + count("SELECT COUNT(*) FROM learn_cards WHERE owner = ? AND sync_seq > ? AND content_by = '' AND content_at > 0")
      + count("SELECT COUNT(*) FROM learn_card_moves WHERE owner = ? AND sync_seq > ? AND by = ''");
  }

  // ---- Engine side ----
  const peerForLink = link => livePeers().find(peer => peer.id === link.id) || null;
  function requirePeer(link) {
    if (!enabled()) throw fault('NOT_FOUND', 404);
    const peer = peerForLink(link);
    if (!peer) throw fault('LINKED_ONLY', 403);
    return peer;
  }
  function checkSender(link, body) {
    const given = isPlainObject(body) ? body : {};
    if (typeof given.public_key !== 'string' || !PUBLIC_KEY.test(given.public_key)) throw fault('LEARN_SYNC_BAD_KEY', 400);
    if (typeof given.instance_id !== 'string' || !INSTANCE_ID.test(given.instance_id)) throw fault('INVALID_LEARN_SYNC', 400);
    if (link.peer_instance_id && link.peer_instance_id !== given.instance_id) throw fault('INVALID_LEARN_SYNC', 400);
    return given;
  }
  // How far this device has the peer's rows (`have`), valid only for that instance and kind of pull.
  const haveOf = (state, instanceId, mode) => (isPlainObject(state.have) && state.have.instance_id === instanceId && state.have.mode === mode ? int(state.have.seq) : 0);
  const refuseOnCompany = () => { if (company()) throw fault('LEARN_COMPANY_COMPUTER', 409); };

  // GET /v1/learn-sync
  function engineDescribe(link) {
    const peer = requirePeer(link);
    prepare();
    const state = peerState(peer.id);
    return {
      instance_id: me(), public_key: linkKeys.publicKey(), company: company(), max_seq: syncStore.maxSeq(db),
      have: haveOf(state, link.peer_instance_id || state.instance_id || (isPlainObject(state.have) ? state.have.instance_id : ''), FULL),
    };
  }
  // POST /v1/learn-sync/pull { instance_id, public_key, after, limit, cards_only }
  function enginePull(link, body) {
    const peer = requirePeer(link);
    refuseOnCompany();
    const given = checkSender(link, body);
    const after = int(given.after);
    const limit = Math.min(MAX_PAGE, Math.max(1, int(given.limit) || pageSize));
    const key = learnKey(peer, given.public_key);
    const page = exportPage(after, limit, { reviews: given.cards_only !== true });
    return { instance_id: me(), sealed: seal(key, page, aadOf('pull', me(), link.id)) };
  }
  // PUT /v1/learn-sync { instance_id, public_key, sealed }: the peer's rows after `after` (inside the envelope). Answers how far this device has them.
  function enginePush(link, body) {
    const peer = requirePeer(link);
    refuseOnCompany();
    const given = checkSender(link, body);
    const key = learnKey(peer, given.public_key);
    const payload = open(key, given.sealed, aadOf('push', given.instance_id, link.id));
    const applied = applyPage(payload, given.instance_id, { bump: true });
    const state = peerState(peer.id);
    const had = haveOf(state, given.instance_id, FULL);
    const have = int(payload.after) <= had ? Math.max(had, int(payload.next)) : had;
    updatePeer(peer.id, () => ({ supported: true, instance_id: given.instance_id, have: { seq: have, mode: FULL, instance_id: given.instance_id } }));
    if (applied) fanOut();
    // A company computer collects sentences but never picks: its home picks the ones it hands over.
    if (applied && picker && state.company === true && Array.isArray(payload.cards)
      && payload.cards.some(card => isPlainObject(card) && card.kind === 'sentence' && card.source === 'translation')) {
      try { picker.afterSentence(owner()); } catch { /* the hourly check picks them */ }
    }
    return { applied, have };
  }
  // The routes a company computer calls on its home: the summary, the settings, the starter list, the wrong answers and the mistake reports live on
  // the normal machines (an analysis asked for there runs here, with this machine's translation model).
  function engineHome(link, action, body) {
    requirePeer(link);
    refuseOnCompany();
    const name = owner();
    if (action === 'summary') return service().summary(name);
    if (action === 'settings') {
      const saved = service().saveSettings(name, body);
      if (picker && isPlainObject(body) && body.pick_words === true) { try { picker.kick(name); } catch { /* the hourly check */ } }
      return saved;
    }
    if (action === 'level' || action === 'level-check') {
      if (!picker) throw fault('NOT_FOUND', 404);
      return action === 'level' ? picker.view(name) : picker.check(name);
    }
    if (action === 'starter') return service().starter(name, body);
    if (action === 'mistakes') return service().mistakes(name, isPlainObject(body) ? body : {});
    if (action === 'reports') return reportsView ? reportsView(name) : { reports: service().reports(name).reports };
    if (action === 'report') return service().report(name, isPlainObject(body) ? body.uid : null);
    if (action === 'analyze') {
      if (!analyzer) throw fault('NOT_FOUND', 404);
      return analyzer(name, isPlainObject(body) ? body : {});
    }
    // The questions about a card (services/learn-ask.js): the card is named by kind and text, as ids differ per engine; the model is asked here.
    if (action === 'ask-history' || action === 'ask') {
      if (!asker) throw fault('NOT_FOUND', 404);
      const given = isPlainObject(body) ? body : {};
      const card = typeof given.kind === 'string' && typeof given.norm === 'string' ? cardFollowing(given.kind, given.norm) : null;
      if (!card) throw new learnModule.LearnError('Card not found', 404);
      return action === 'ask-history' ? asker.history(name, card.id) : asker.ask(name, card.id, given);
    }
    // The English chats (services/learn-chat.js): kept and answered here; the chat named by its uid, the same on every engine.
    if (['chats', 'chat', 'chat-send', 'chat-update', 'chat-delete'].includes(action)) {
      if (!chatter) throw fault('NOT_FOUND', 404);
      const given = isPlainObject(body) ? body : {};
      if (action === 'chats') return chatter.list(name);
      if (action === 'chat') return chatter.get(name, given.uid);
      if (action === 'chat-send') return chatter.send(name, { chat: given.chat, question: given.question, topic: given.topic });
      if (action === 'chat-update') { const { uid, ...change } = given; return chatter.update(name, uid, change); }
      return chatter.remove(name, given.uid);
    }
    throw fault('NOT_FOUND', 404);
  }
  // services/learn-analysis.js hands in how it answers a company computer's page: the reports with the analysis state, and an analysis.
  let analyzer = null;
  let reportsView = null;
  function setAnalysis({ analyze, view }) { analyzer = analyze; reportsView = view; }
  // services/learn-pick.js hands in the level and the picking: { view, check, afterSentence, kick } for a company computer's page and for what it hands over.
  let picker = null;
  function setPicker(value) { picker = value; }
  // services/learn-ask.js hands in the questions about a card: { history(owner, cardId), ask(owner, cardId, body) } (the answer as one JSON).
  let asker = null;
  function setAsk(value) { asker = value; }
  // services/learn-chat.js hands in the English chats: { list, get, send (the answer as one JSON), update, remove }.
  let chatter = null;
  function setChat(value) { chatter = value; }

  // ---- Failures in the log (as in services/settings-sync.js: once per reason, once when it works again, codes only) ----
  const reported = new Map();
  function report(key, what, error = null) {
    const reason = error ? errorCode(error) : null;
    const before = reported.get(key) || null;
    if (reason === before) return;
    if (reason) { reported.set(key, reason); log.warn(`[learn-sync] ${what} failed: ${reason}`); } else {
      reported.delete(key);
      (log.info || log.warn).call(log, `[learn-sync] ${what} works again (it failed with ${before})`);
    }
  }

  // ---- Rounds ----
  const running = new Map();
  const again = new Set();
  let fullSerial = 0;
  const fullAt = new Map(); // link id -> the serial of its last complete round

  async function round(peer) {
    const call = (route, opts = {}) => request(peer.baseUrl, route, peer.token, { timeoutMs, ...opts });
    let applied = 0;
    try {
      const info = await call('/v1/info');
      const supported = Boolean(info && Array.isArray(info.capabilities) && info.capabilities.includes(CAPABILITY));
      const reports = Boolean(supported && info.capabilities.includes(REPORTS_CAPABILITY));
      const pick = Boolean(supported && info.capabilities.includes(PICK_CAPABILITY));
      const peerCompany = Boolean(info && info.company_computer === true);
      const peerInstance = info && typeof info.engine_id === 'string' && INSTANCE_ID.test(info.engine_id) ? info.engine_id : null;
      updatePeer(peer.id, current => ({ supported, reports, pick, company: peerCompany, instance_id: peerInstance || current.instance_id }));
      const skip = () => { report(peer.id, `sync with ${peer.name}`); return 0; };
      if (!supported) return skip();
      // A normal machine leaves a company computer to its own rounds; a company computer syncs with its home only.
      if (peerCompany) return skip();
      if (company() && (!homePeer() || homePeer().id !== peer.id)) return skip();
      const theirs = await call(ROUTE);
      if (!theirs || typeof theirs.instance_id !== 'string' || !INSTANCE_ID.test(theirs.instance_id)) throw fault('LEARN_SYNC_BAD_ANSWER', 502);
      if (theirs.company) { updatePeer(peer.id, () => ({ company: true })); return skip(); }
      const key = learnKey(peer, theirs.public_key);
      const self = me();
      const mine = linkKeys.publicKey();
      const cardsOnly = company();
      const mode = cardsOnly ? 'cards' : FULL;
      const theirMax = int(theirs.max_seq);

      // Pull: the peer's rows after what this device has of them.
      let after = haveOf(peerState(peer.id), theirs.instance_id, mode);
      if (after > theirMax) after = 0; // the peer's database is older than what we had (restored): from the start
      for (let pages = 0; after < theirMax && pages < MAX_PAGES_PER_ROUND; pages += 1) {
        const answer = await call(`${ROUTE}/pull`, { method: 'POST', body: { instance_id: self, public_key: mine, after, limit: pageSize, cards_only: cardsOnly } });
        const payload = open(key, answer && answer.sealed, aadOf('pull', theirs.instance_id, peer.id));
        applied += applyPage(payload, theirs.instance_id, { bump: !cardsOnly });
        const next = int(payload.next);
        if (next <= after) break;
        after = next;
        updatePeer(peer.id, () => ({ instance_id: theirs.instance_id, have: { seq: after, mode, instance_id: theirs.instance_id } }));
        if (!payload.more) break;
      }

      // Push: this device's rows after what the peer has of them.
      let sent = int(theirs.have);
      if (sent > syncStore.maxSeq(db)) sent = 0;
      for (let pages = 0; sent < syncStore.maxSeq(db) && pages < MAX_PAGES_PER_ROUND; pages += 1) {
        const page = exportPage(sent, pageSize, { reviews: true });
        const answer = await call(ROUTE, { method: 'PUT', body: { instance_id: self, public_key: mine, sealed: seal(key, page, aadOf('push', self, peer.id)) } });
        const have = int(answer && answer.have);
        if (have <= sent) break;
        sent = have;
        if (!page.more) break;
      }
      if (cardsOnly) {
        updatePeer(peer.id, () => ({ acked: sent }));
        dropHandedOver(sent);
        // The numbers of the home for the summary while it is away.
        try {
          const summary = await call(`${ROUTE}/summary`);
          if (isPlainObject(summary)) writeState(db, HOME_KEY, { link_id: peer.id, name: peer.name, summary, at: now() });
        } catch { /* the last copy stays */ }
      }
      updatePeer(peer.id, () => ({ last_sync_at: new Date(now()).toISOString(), last_error: null }));
      fullAt.set(peer.id, ++fullSerial);
      report(peer.id, `sync with ${peer.name}`);
    } catch (error) {
      if (error && error.statusCode === 401 && serviceLinks && typeof serviceLinks.noteUnauthorized === 'function') {
        try { serviceLinks.noteUnauthorized(peer.remoteServerId); } catch { /* the next call tries again */ }
      }
      report(peer.id, `sync with ${peer.name}`, error);
      try { updatePeer(peer.id, () => ({ last_error: errorCode(error), last_error_at: new Date(now()).toISOString() })); } catch { /* logged above */ }
    }
    return applied;
  }

  function syncPeer(peer) {
    if (running.has(peer.id)) { again.add(peer.id); return running.get(peer.id); }
    const work = (async () => {
      let applied = 0;
      do {
        again.delete(peer.id);
        const current = onlinePeers().find(candidate => candidate.id === peer.id) || peer;
        applied += await round(current);
      } while (again.has(peer.id));
      return applied;
    })().catch(error => { report(peer.id, `sync with ${peer.name}`, error); return 0; }).finally(() => running.delete(peer.id));
    running.set(peer.id, work);
    return work;
  }

  async function syncAll() {
    if (!enabled() || !request) return;
    const mark = fullSerial;
    const results = await Promise.all(onlinePeers().map(syncPeer));
    if (company()) {
      // A company computer learns which peers are normal from their /v1/info in the same pass: when its home was found only then, it syncs now.
      const home = homePeer();
      if (home && !((fullAt.get(home.id) || 0) > mark)) await syncPeer(home);
      return;
    }
    if (results.some(count => count > 0)) fanOut();
  }
  const syncInBackground = () => syncAll().then(() => report('rounds', 'a sync round'), error => report('rounds', 'a sync round', error)).catch(() => {});

  // A company computer reads through its home: before a page read the home is synced (at most `readWaitMs`), so answers given elsewhere show.
  async function refresh() {
    const home = homePeer();
    if (!home || !request) return false;
    let timer;
    const wait = new Promise(resolve => { timer = setTimeout(() => resolve(false), readWaitMs); if (timer.unref) timer.unref(); });
    try { return await Promise.race([syncPeer(home).then(() => true), wait]); } finally { clearTimeout(timer); }
  }

  // ---- Local changes ----
  let timer = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; syncInBackground(); }, company() ? companyDebounceMs : debounceMs);
    if (timer.unref) timer.unref();
  }
  const fanOut = () => { if (started && !company()) schedule(); };

  // ---- The page ----
  // { company_computer, home_name, home_online, waiting }: what the Learn page shows about where the data is kept.
  function status() {
    const cache = cacheOnly();
    return {
      company_computer: company(),
      cache_only: cache,
      home_name: cache ? homeName() : null,
      home_online: cache ? Boolean(homePeer()) : null,
      waiting: cache ? waiting() : 0,
    };
  }

  // The summary on a company computer: the home's, while it can be reached; else the cards here with the last copy of the home's numbers plus the
  // answers given here since.
  async function companySummary(name) {
    await refresh();
    const home = homePeer();
    if (home && request) {
      try {
        const summary = await request(home.baseUrl, `${ROUTE}/summary`, home.token, { timeoutMs });
        if (isPlainObject(summary)) {
          writeState(db, HOME_KEY, { link_id: home.id, name: home.name, summary, at: now() });
          return { ...summary, device: { ...status(), offline_copy_at: null } };
        }
      } catch { /* the copy below */ }
    }
    const local = service().summary(name);
    const last = readState(db, HOME_KEY);
    const copy = last && isPlainObject(last.summary) ? last.summary : null;
    const at = now();
    const localTimes = db.prepare('SELECT at FROM learn_reviews WHERE owner = ?').pluck().all(name);
    let doneToday = review.countToday(localTimes, at, timeZone);
    const days = new Set(localTimes.map(time => review.dayKey(time, timeZone)));
    if (copy) {
      const copyDay = review.dayKey(last.at, timeZone);
      if (copyDay === review.dayKey(at, timeZone)) doneToday += int(copy.done_today);
      // The days of the copy's streak: ending on the day of the copy when it had answers that day, else the day before.
      let day = int(copy.done_today) > 0 ? copyDay : review.previousDay(copyDay);
      for (let index = 0; index < int(copy.streak); index += 1) { days.add(day); day = review.previousDay(day); }
    }
    let day = review.dayKey(at, timeZone);
    if (!days.has(day)) day = review.previousDay(day);
    let streak = 0;
    while (days.has(day)) { streak += 1; day = review.previousDay(day); }
    return {
      ...local, done_today: doneToday, streak, mistakes: copy ? Math.max(int(copy.mistakes), local.mistakes) : local.mistakes,
      device: { ...status(), offline_copy_at: last && last.at ? new Date(last.at).toISOString() : null },
    };
  }

  // A read or an action of the mistake reports on a company computer, made on its home. `offline`: the message while the home cannot be reached.
  async function askHome(route, { method = 'GET', body, offline = 'Mistake reports are kept on a normal computer, which cannot be reached right now', timeout = timeoutMs } = {}) {
    const home = homePeer();
    if (!home || !request) throw new learnModule.LearnError(offline, 503);
    try { return await request(home.baseUrl, `${ROUTE}/${route}`, home.token, { method, body, timeoutMs: timeout }); } catch (error) {
      // The home answered (its refusal or the model's error, with its message); anything else means it cannot be reached.
      const status = error && error.statusCode;
      if (Number.isInteger(status) && status >= 400 && status < 600 && error.peerBody && typeof error.peerBody.error === 'string') {
        throw new learnModule.LearnError(error.peerBody.error, status);
      }
      throw new learnModule.LearnError(offline, 503);
    }
  }
  // The online normal peers that make reports, with their instance ids (the weekly report is made by the smallest id).
  const reportPeers = () => { const states = readPeers(); return normalPeers().filter(peer => peer.online && states[peer.id].reports === true).map(peer => ({ id: peer.id, name: peer.name, instance_id: states[peer.id].instance_id || null })); };
  // The online normal peers that pick words from translations (the backlog is picked by the smallest id).
  const pickPeers = () => { const states = readPeers(); return normalPeers().filter(peer => peer.online && states[peer.id].pick === true).map(peer => ({ id: peer.id, name: peer.name, instance_id: states[peer.id].instance_id || null })); };

  // A settings change or a starter list on a company computer is made on the home, then read back.
  async function viaHome(action, body) {
    const home = homePeer();
    if (!home || !request) throw new learnModule.LearnError('Learning settings are kept on a normal computer, which cannot be reached right now', 503);
    let answer;
    try { answer = await request(home.baseUrl, `${ROUTE}/${action}`, home.token, { method: action === 'starter' ? 'POST' : 'PUT', body, timeoutMs }); }
    catch (error) {
      const status = error && error.statusCode;
      if (Number.isInteger(status) && status >= 400 && status < 500 && error.peerBody && typeof error.peerBody.error === 'string') {
        throw new learnModule.LearnError(error.peerBody.error, status);
      }
      throw new learnModule.LearnError('Learning settings are kept on a normal computer, which cannot be reached right now', 503);
    }
    await refresh();
    return answer;
  }

  // ---- Life ----
  let started = false;
  let interval = null;
  const unsubscribe = [];
  function start() {
    if (started) return;
    started = true;
    try { prepare(); } catch (error) { log.warn(`[learn-sync] the settings version could not be prepared: ${errorCode(error)}`); }
    unsubscribe.push(syncStore.onLearnChanged(changedDb => { if (changedDb === db) schedule(); }));
    unsubscribe.push(require('./device-tier').onTierChange((value, changedDb) => { if (!changedDb || changedDb === db) syncInBackground(); }));
    if (serviceLinks && request) {
      unsubscribe.push(serviceLinks.onChange(id => {
        // A company computer's home can change with any link; a normal machine syncs the link that changed.
        if (company()) return syncInBackground();
        const peer = onlinePeers().find(candidate => candidate.id === id);
        if (peer) syncPeer(peer);
        return undefined;
      }));
      if (intervalMs > 0) {
        interval = setInterval(syncInBackground, intervalMs);
        if (interval.unref) interval.unref();
      }
      setImmediate(syncInBackground);
    }
  }
  function stop() {
    started = false;
    while (unsubscribe.length) unsubscribe.pop()();
    if (interval) clearInterval(interval);
    interval = null;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    start, stop, syncAll, syncPeer, refresh, status, cacheOnly, companySummary, viaHome, waiting, askHome, reportPeers, pickPeers, setAnalysis, setPicker, setAsk, setChat, me, company,
    engineDescribe, enginePull, enginePush, engineHome, exportPage, applyPage, peerStates: readPeers, service,
  };
}

// Off with SETTINGS_SYNC_ENABLED=false or LEARN_SYNC_ENABLED=false (config.learnSyncEnabled).
const syncEnabled = () => require('../config').learnSyncEnabled !== false;

let singleton = null;
function getLearnSync() {
  if (singleton) return singleton;
  const db = require('../db');
  const settingsSync = require('./settings-sync').getSettingsSync();
  singleton = createLearnSync({
    db, serviceLinks: require('./service-links').getServiceLinks(),
    request: (...args) => require('./remote-client').request(...args),
    identity: () => { const { engine_id: instanceId, name } = require('./engine-identity').getEngineIdentity(); return { instance_id: instanceId, name }; },
    linkKeys: { publicKey: () => settingsSync.publicKey(), linkKey: (peer, publicKey) => settingsSync.linkKey(peer, publicKey) },
    tier: require('./device-tier').getDeviceTier(),
    enabled: syncEnabled,
  });
  return singleton;
}

module.exports = { createLearnSync, getLearnSync, syncEnabled, aadOf, learnKeyFrom, CAPABILITY, REPORTS_CAPABILITY, PICK_CAPABILITY, ROUTE, PEERS_KEY, HOME_KEY, PAGE_SIZE };
