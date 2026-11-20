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
const { STARTER_LISTS } = require('./learn-starter');

const CAPABILITY = 'learn:sync';
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
    const version = settingsVersion(name);
    const settingsValue = version.seq > after ? readState(db, learnModule.settingsKey(name)) : null;
    const rows = [
      ...cards.map(row => ({ type: 'card', seq: row.sync_seq, row })),
      ...answers.map(row => ({ type: 'review', seq: row.sync_seq, row })),
      ...moves.map(row => ({ type: 'move', seq: row.sync_seq, row })),
      ...(settingsValue !== null ? [{ type: 'settings', seq: version.seq }] : []),
    ].sort((a, b) => a.seq - b.seq);
    const taken = rows.slice(0, limit);
    const more = rows.length > limit || [cards, answers, moves].some(list => list.length >= limit);
    const page = { cards: [], reviews: [], moves: [], settings: null, after, next: more ? taken[taken.length - 1].seq : Math.max(newest, after), more };
    const ids = new Set();
    const self = me();
    const addCard = row => { if (row && !ids.has(row.id)) { ids.add(row.id); page.cards.push(merge.cardToPeer(row, self)); } };
    for (const entry of taken) {
      if (entry.type === 'card') addCard(entry.row);
      else if (entry.type === 'review') page.reviews.push(merge.reviewToPeer(entry.row));
      else if (entry.type === 'move') page.moves.push(merge.moveToPeer(entry.row, self));
      else page.settings = { value: settingsValue, at: version.at, by: version.by || self };
    }
    for (const entry of taken) {
      if (entry.type === 'review') addCard(db.prepare('SELECT * FROM learn_cards WHERE id = ?').get(entry.row.card_id));
      if (entry.type === 'move') addCard(cardFollowing(entry.row.kind, entry.row.moved_to));
    }
    return page;
  }

  // ---- Applying rows ----
  // Applies a page from `sender` in one transaction and returns how many rows changed something. `bump`: what changed gets new change numbers, so it
  // goes on to the other peers (false on a company computer, which passes nothing on).
  function applyPage(payload, sender, { bump = true } = {}) {
    if (!isPlainObject(payload)) throw fault('INVALID_LEARN_SYNC', 400);
    const list = key => (Array.isArray(payload[key]) ? payload[key] : []);
    if (list('cards').length + list('reviews').length + list('moves').length > MAX_PAGE * 3) throw fault('LEARN_SYNC_TOO_LARGE', 413);
    prepare();
    const self = me();
    const name = o();
    const seqFor = current => (bump ? syncStore.nextSeq(db) : current);
    let applied = 0;
    const writeCard = (id, card, currentSeq) => db.prepare(`UPDATE learn_cards SET created_at = @created_at, en = @en, zh = @zh, phonetic = @phonetic, source = @source,
      context = @context, suspended = @suspended, content_at = @content_at, content_by = @content_by, due_at = @due_at, interval_days = @interval_days,
      ease = @ease, reps = @reps, lapses = @lapses, last_result = @last_result, last_at = @last_at, last_correct = @last_correct, state_at = @state_at,
      state_by = @state_by, sync_seq = @sync_seq WHERE id = @id`).run({ ...card, content_by: own(card.content_by), state_by: own(card.state_by), sync_seq: seqFor(currentSeq), id });

    function applyCard(raw) {
      const card = merge.cardFromPeer(raw, sender);
      if (!card) return;
      syncStore.observe(db, card.content_at);
      syncStore.observe(db, card.state_at);
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
          last_at, last_correct, suspended, content_at, content_by, state_at, state_by, sync_seq) VALUES (@owner, @kind, @en, @norm, @zh, @phonetic, @source, @context,
          @created_at, @due_at, @interval_days, @ease, @reps, @lapses, @last_result, @last_at, @last_correct, @suspended, @content_at, @content_by, @state_at,
          @state_by, @sync_seq)`).run({ ...card, owner: name, content_by: own(card.content_by), state_by: own(card.state_by), sync_seq: bump ? syncStore.nextSeq(db) : 0 });
        applied += 1;
        return;
      }
      const result = merge.mergeCard(merge.resolved(local, self), card, { follow });
      if (!result.changed) return;
      writeCard(local.id, result.card, local.sync_seq);
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
        db.prepare('UPDATE learn_reviews SET card_id = ? WHERE card_id = ?').run(target.id, card.id);
        db.prepare('DELETE FROM learn_cards WHERE id = ?').run(card.id);
      }
      db.prepare(`INSERT INTO learn_card_moves (owner, kind, norm, moved_to, at, by, sync_seq) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (owner, kind, norm) DO UPDATE SET moved_to = excluded.moved_to, at = excluded.at, by = excluded.by, sync_seq = excluded.sync_seq`)
        .run(name, move.kind, move.norm, move.moved_to, move.at, own(move.by), bump ? syncStore.nextSeq(db) : (existing ? existing.sync_seq : 0));
      applied += 1;
    }

    function applyReview(raw) {
      const answer = merge.reviewFromPeer(raw);
      if (!answer || db.prepare('SELECT 1 FROM learn_reviews WHERE uid = ?').get(answer.uid)) return;
      const card = cardFollowing(answer.kind, answer.norm);
      if (!card) return;
      db.prepare('INSERT INTO learn_reviews (card_id, owner, at, mode, grade, correct, answer, uid, sync_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(card.id, name, answer.at, answer.mode, answer.grade, answer.correct, answer.answer, answer.uid, bump ? syncStore.nextSeq(db) : 0);
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
      const hasValue = readState(db, learnModule.settingsKey(name)) !== null;
      if (hasValue && !merge.later(raw.at, by, local.at, local.by || self)) return;
      writeState(db, learnModule.settingsKey(name), value);
      writeState(db, learnModule.settingsVersionKey(name), { at: raw.at, by: own(by), seq: bump ? syncStore.nextSeq(db) : local.seq });
      applied += 1;
    }

    db.transaction(() => {
      for (const raw of list('cards')) applyCard(raw);
      for (const raw of list('moves')) applyMove(raw);
      for (const raw of list('reviews')) applyReview(raw);
      if (payload.settings) applySettings(payload.settings);
    })();
    return applied;
  }

  // ---- A company computer hands its answers over ----
  // The answers the home has (change number up to `acked`) leave this machine; the cards stay as the cache.
  function dropHandedOver(acked) {
    if (!cacheOnly() || !acked) return 0;
    return db.prepare('DELETE FROM learn_reviews WHERE owner = ? AND sync_seq <= ?').run(o(), acked).changes;
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
      have: haveOf(state, link.peer_instance_id || state.instance_id || (isPlainObject(state.have) ? state.have.instance_id : ''), 'full'),
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
    const had = haveOf(state, given.instance_id, 'full');
    const have = int(payload.after) <= had ? Math.max(had, int(payload.next)) : had;
    updatePeer(peer.id, () => ({ supported: true, instance_id: given.instance_id, have: { seq: have, mode: 'full', instance_id: given.instance_id } }));
    if (applied) fanOut();
    return { applied, have };
  }
  // The routes a company computer calls on its home: the summary, the settings and the starter list live on the normal machines.
  function engineHome(link, action, body) {
    requirePeer(link);
    refuseOnCompany();
    const name = owner();
    if (action === 'summary') return service().summary(name);
    if (action === 'settings') return service().saveSettings(name, body);
    if (action === 'starter') return service().starter(name, body);
    throw fault('NOT_FOUND', 404);
  }

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
      const peerCompany = Boolean(info && info.company_computer === true);
      updatePeer(peer.id, () => ({ supported, company: peerCompany }));
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
      const mode = cardsOnly ? 'cards' : 'full';
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
    start, stop, syncAll, syncPeer, refresh, status, cacheOnly, companySummary, viaHome, waiting,
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

module.exports = { createLearnSync, getLearnSync, syncEnabled, aadOf, learnKeyFrom, CAPABILITY, ROUTE, PEERS_KEY, HOME_KEY, PAGE_SIZE };
