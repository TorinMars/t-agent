// Usage time and memories across linked devices ("Sync across linked devices" in docs/design/usage-time.md): the rows of usage_time and memories
// (services/usage-time.js, services/usage-memories.js) are one set on every normal machine joined by service links, and a company computer hands
// its own rows over to a normal machine and keeps none. The pattern of the usage data sync (services/ui-events-sync.js), with its own routes
// (/v1/usage-sync/time), capability (`usage:time`) and change counter:
//
// - Time rows: a row is one key of one origin engine (uid). Only the origin changes it, raising `rev`; a receiver takes a copy only when its rev is
//   larger than the one it has, so an echo, a chain or a page sent twice never adds a second twice. A company computer deletes its rows once the
//   home has them; its later seconds of the same key go to a new row (a new uid), which the home adds to the first one.
// - Memories: a union by uid; the newer updated_at wins, a tombstone wins a tie, then the greater engine id.
// - Clear marks (one per tab): the later wins. Time: every row of the hours up to the mark goes, and a row last changed by then is refused. Memories:
//   every row last changed by then becomes a tombstone, and a live row last changed by then is refused.
// - Change numbers: every row written here, recorded or merged, gets the next number of the database; a device asks a peer for the rows after the
//   highest number of that peer it has (kept per link) and sends its own after the number the peer reports; what it applied gets new numbers, so it
//   goes on to its other peers. Pages of at most 500 rows (2,000 asked).
// - Transport: GET /v1/info must list `usage:time` and `usage:sync` (an older peer, or one with the sync off, is skipped); link tokens only. The
//   pages travel only inside the settings sync's AES-256-GCM envelopes (HKDF info `t-agent usage-time v1`).
// - Company computer (services/device-tier.js): it syncs only with its home (the online normal linked machine with the oldest link), never pulls,
//   pushes its rows soon after they are written and deletes them once the home has them. Its summary, task and day views, memories list and export
//   are the home's; an edit or a delete of a memory the home keeps is done there (PATCH / DELETE /v1/usage-sync/time/memories/:uid).
const crypto = require('crypto');
const { seal, open } = require('./settings-sync');
const { readState, writeState, isPlainObject } = require('./settings-sync-store');
const time = require('./usage-time');
const memoriesModule = require('./usage-memories');

const CAPABILITY = 'usage:time';
const ROUTE = '/v1/usage-sync/time';
const PEERS_KEY = 'usage_time_sync_peers_v1';
const HOME_KEY = 'usage_time_home_v1';
const PAGE_SIZE = 500;
const MAX_PAGE = 2000;
const MAX_PAGES_PER_ROUND = 500;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const DEBOUNCE_MS = 10_000;
const COMPANY_DEBOUNCE_MS = 2000;
const REQUEST_TIMEOUT_MS = 15_000;
const READ_WAIT_MS = 4000;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const INSTANCE_ID = time.INSTANCE_ID;
const UID = /^[A-Za-z0-9-]{1,64}$/;
const DAY_TEXT = /^\d{4}-\d{2}-\d{2}$/;
const WEEK = /^\d{4}-W\d{2}$/;
const SOURCES = ['', 'auto', 'person', 'model'];

const fault = (code, statusCode = 400) => Object.assign(new Error(code), { statusCode });
const errorCode = error => (error && /^[A-Z0-9_]{1,64}$/.test(error.message || '') ? error.message : 'USAGE_TIME_SYNC_FAILED');
const aadOf = (direction, sender, linkId) => Buffer.from(`t-agent usage-time v1|${direction}|${sender}|${linkId}`);
const keyFrom = linkKey => Buffer.from(crypto.hkdfSync('sha256', linkKey, Buffer.alloc(0), Buffer.from('t-agent usage-time v1'), 32));
const int = time.int;
const later = (aAt, aBy, bAt, bBy) => aAt > bAt || (aAt === bAt && String(aBy || '') > String(bBy || ''));
const seconds = value => Number.isSafeInteger(value) && value >= 0 && value <= time.MAX_ROW_SECONDS;

// A time row from a peer, checked like one written here, or null.
function timeFromPeer(raw) {
  if (!isPlainObject(raw)) return null;
  const { uid, engine, client, day, hour, start, surface, kind, task, session, page_s: page, working_s: working, waiting_s: waiting, waits, rev, updated_at: updatedAt } = raw;
  if (typeof uid !== 'string' || !UID.test(uid) || typeof engine !== 'string' || !INSTANCE_ID.test(engine)) return null;
  if (typeof day !== 'string' || !DAY_TEXT.test(day) || !Number.isInteger(hour) || hour < 0 || hour > 23 || start !== Date.parse(`${day}T00:00:00Z`) + hour * time.HOUR) return null;
  if (client !== '' && !time.CLIENTS.includes(client)) return null;
  if (surface !== '' && !time.SURFACES.includes(surface)) return null;
  if (kind !== '' && !time.KINDS.includes(kind)) return null;
  const refs = time.cleanRefs(task, session);
  if (!refs || refs.task !== task) return null;
  if (!seconds(page) || !seconds(working) || !seconds(waiting)) return null;
  if (waits !== '' && (typeof waits !== 'string' || JSON.stringify(time.parseHist(waits)) !== waits)) return null;
  if (!Number.isSafeInteger(rev) || rev < 1 || !Number.isSafeInteger(updatedAt) || updatedAt < 0) return null;
  return { uid, engine, client, day, hour, start, surface, kind, task, session, page_s: page, working_s: working, waiting_s: waiting, waits, rev, updated_at: updatedAt };
}
// A memory from a peer, or null.
function memoryFromPeer(raw) {
  if (!isPlainObject(raw)) return null;
  const { uid, at, kind, event, ref, text, task, session, source, week, sources, engine, by, updated_at: updatedAt } = raw;
  const deleted = raw.deleted === true;
  if (typeof uid !== 'string' || !UID.test(uid) || !Number.isSafeInteger(at) || at < 0 || !memoriesModule.KINDS.includes(kind)) return null;
  if (typeof text !== 'string' || text.length > (kind === 'note' ? memoriesModule.MAX_NOTE : memoriesModule.MAX_TEXT) || (!deleted && !text.trim())) return null;
  if (event !== '' && (typeof event !== 'string' || !memoriesModule.EVENT.test(event))) return null;
  if (typeof ref !== 'string' || !/^[\x20-\x7e]{0,160}$/.test(ref) || !SOURCES.includes(source)) return null;
  if (week !== '' && (typeof week !== 'string' || !WEEK.test(week))) return null;
  if (sources !== '' && (typeof sources !== 'string' || sources.length > 200)) return null;
  const refs = time.cleanRefs(task, session);
  if (!refs || refs.task !== task) return null;
  if (typeof engine !== 'string' || !INSTANCE_ID.test(engine) || typeof by !== 'string' || !INSTANCE_ID.test(by)) return null;
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0 || typeof raw.private !== 'boolean') return null;
  return { uid, at, kind, event, ref, text: deleted ? '' : text, task, session, source, week, sources: deleted ? '' : sources, private: raw.private ? 1 : 0, engine, deleted: deleted ? 1 : 0, updated_at: updatedAt, by };
}

function createUsageTimeSync(options) {
  const {
    db, serviceLinks = null, request = null,
    identity, // () => { instance_id, name }
    linkKeys, // { publicKey(), linkKey(peer, publicKey) }
    tier = { isCompany: () => false },
    enabled = () => true,
    usage = null, memories = null,
    now = Date.now, log = console,
    intervalMs = SYNC_INTERVAL_MS, debounceMs = DEBOUNCE_MS, companyDebounceMs = COMPANY_DEBOUNCE_MS, timeoutMs = REQUEST_TIMEOUT_MS,
    pageSize = PAGE_SIZE, readWaitMs = READ_WAIT_MS,
  } = options;
  const me = () => identity().instance_id;
  const company = () => Boolean(tier.isCompany());
  const store = usage || time.createUsageTime({ db, now, identity });
  const notes = memories || memoriesModule.createMemories({ db, now, identity, usage: store });

  // ---- Stored state ----
  const readPeers = () => { const value = readState(db, PEERS_KEY); return isPlainObject(value) ? value : {}; };
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

  // ---- Links, tiers and the home ----
  const livePeers = () => { if (!serviceLinks) return []; try { return serviceLinks.peers(); } catch { return []; } };
  const onlinePeers = () => livePeers().filter(peer => peer.online);
  const normalPeers = () => { const states = readPeers(); return livePeers().filter(peer => states[peer.id] && states[peer.id].supported === true && states[peer.id].company === false); };
  const handsOver = () => Boolean(enabled()) && company() && normalPeers().length > 0;
  const homePeer = () => (handsOver() ? normalPeers().find(peer => peer.online) || null : null);
  function homeName() {
    const online = homePeer();
    if (online) return online.name;
    const last = readState(db, HOME_KEY);
    const normal = normalPeers();
    const known = last && normal.find(peer => peer.id === last.link_id);
    return (known || normal[0] || {}).name || null;
  }
  // The linked engines for the device chip: { instanceId, name, supported } (supported: they record time, from their last /v1/info; null: not asked yet).
  function linked() {
    const states = readPeers();
    return livePeers().map(peer => ({ instanceId: peer.instanceId || (states[peer.id] && states[peer.id].instance_id) || null, name: peer.name, supported: states[peer.id] && typeof states[peer.id].supported === 'boolean' ? states[peer.id].supported : null }));
  }
  function sealKey(peer, publicKey) {
    if (typeof publicKey !== 'string' || !PUBLIC_KEY.test(publicKey)) throw fault('USAGE_TIME_SYNC_BAD_KEY', 400);
    return keyFrom(linkKeys.linkKey(peer, publicKey));
  }
  function names() {
    const self = identity();
    return { ...time.readNames(db), ...(self.instance_id ? { [self.instance_id]: self.name || '' } : {}) };
  }

  // ---- Pages ----
  function exportPage(after, limit) {
    const self = me();
    const newest = time.maxSeq(db);
    const timeRows = db.prepare('SELECT * FROM usage_time WHERE sync_seq > ? ORDER BY sync_seq LIMIT ?').all(after, limit);
    const memoryRows = db.prepare('SELECT * FROM memories WHERE sync_seq > ? ORDER BY sync_seq LIMIT ?').all(after, limit);
    const timeMark = time.readTimeClear(db);
    const memoryMark = time.readMemoriesClear(db);
    const rows = [
      ...timeRows.map(row => ({ type: 'time', seq: row.sync_seq, row })),
      ...memoryRows.map(row => ({ type: 'memory', seq: row.sync_seq, row })),
      ...(timeMark && timeMark.seq > after ? [{ type: 'clear_time', seq: timeMark.seq, row: timeMark }] : []),
      ...(memoryMark && memoryMark.seq > after ? [{ type: 'clear_memories', seq: memoryMark.seq, row: memoryMark }] : []),
    ].sort((a, b) => a.seq - b.seq);
    const taken = rows.slice(0, limit);
    const more = rows.length > limit || [timeRows, memoryRows].some(list => list.length >= limit);
    const page = { time: [], memories: [], clear_time: null, clear_memories: null, names: names(), after, next: more ? taken[taken.length - 1].seq : Math.max(newest, after), more };
    for (const { type, row } of taken) {
      if (type === 'time') {
        page.time.push({
          uid: row.uid, engine: row.engine || self, client: row.client, day: row.day, hour: row.hour, start: row.start, surface: row.surface, kind: row.kind,
          task: row.task, session: row.session, page_s: row.page_s, working_s: row.working_s, waiting_s: row.waiting_s, waits: row.waits, rev: row.rev, updated_at: row.updated_at,
        });
      } else if (type === 'memory') {
        page.memories.push({
          uid: row.uid, at: row.at, kind: row.kind, event: row.event, ref: row.ref, text: row.text, task: row.task, session: row.session, source: row.source,
          week: row.week, sources: row.sources, private: Boolean(row.private), engine: row.engine || self, deleted: Boolean(row.deleted), updated_at: row.updated_at, by: row.by || self,
        });
      } else page[type] = { at: row.at, by: row.by || self };
    }
    return page;
  }

  // Applies a page from `sender` in one transaction; answers how many rows changed something (they get new change numbers and go on).
  function applyPage(payload, sender) {
    if (!isPlainObject(payload)) throw fault('INVALID_USAGE_TIME_SYNC', 400);
    const list = key => (Array.isArray(payload[key]) ? payload[key] : []);
    if (list('time').length + list('memories').length > MAX_PAGE * 2) throw fault('USAGE_TIME_SYNC_TOO_LARGE', 413);
    const self = me();
    const local = id => (id === self ? '' : id);
    const oldest = now() - time.RETENTION_DAYS * time.DAY;
    let applied = 0;
    db.transaction(() => {
      const markOf = raw => (isPlainObject(raw) && Number.isSafeInteger(raw.at) && raw.at >= 0 ? { at: raw.at, by: typeof raw.by === 'string' && INSTANCE_ID.test(raw.by) ? raw.by : sender } : null);
      // The clear marks first, so the rows they remove are not added again.
      const timeMark = markOf(payload.clear_time);
      if (timeMark) {
        const mark = time.readTimeClear(db);
        if (!mark || later(timeMark.at, timeMark.by, mark.at, mark.by || self)) {
          time.keepSeq(db);
          db.prepare('DELETE FROM usage_time WHERE start < ? OR updated_at <= ?').run(timeMark.at, timeMark.at);
          time.writeTimeClear(db, { at: timeMark.at, by: local(timeMark.by), seq: time.nextSeq(db) });
          applied += 1;
        }
      }
      const memoryMark = markOf(payload.clear_memories);
      if (memoryMark) {
        const mark = time.readMemoriesClear(db);
        if (!mark || later(memoryMark.at, memoryMark.by, mark.at, mark.by || self)) {
          for (const row of db.prepare('SELECT uid FROM memories WHERE deleted = 0 AND updated_at <= ?').all(memoryMark.at)) {
            db.prepare("UPDATE memories SET deleted = 1, text = '', sources = '', updated_at = ?, by = ?, sync_seq = ? WHERE uid = ?").run(memoryMark.at, local(memoryMark.by), time.nextSeq(db), row.uid);
          }
          time.writeMemoriesClear(db, { at: memoryMark.at, by: local(memoryMark.by), seq: time.nextSeq(db) });
          applied += 1;
        }
      }
      const timeFloor = (time.readTimeClear(db) || { at: -1 }).at;
      const getTime = db.prepare('SELECT rev FROM usage_time WHERE uid = ?');
      const putTime = db.prepare(`INSERT INTO usage_time (uid, engine, client, day, hour, start, surface, kind, task, session, page_s, working_s, waiting_s, waits, rev, updated_at, sync_seq)
        VALUES (@uid, @engine, @client, @day, @hour, @start, @surface, @kind, @task, @session, @page_s, @working_s, @waiting_s, @waits, @rev, @updated_at, @sync_seq)
        ON CONFLICT(uid) DO UPDATE SET page_s = excluded.page_s, working_s = excluded.working_s, waiting_s = excluded.waiting_s, waits = excluded.waits,
          rev = excluded.rev, updated_at = excluded.updated_at, sync_seq = excluded.sync_seq`);
      for (const item of list('time')) {
        const row = timeFromPeer(item);
        if (!row || row.start < oldest || row.updated_at <= timeFloor) continue;
        const current = getTime.get(row.uid);
        if (current && current.rev >= row.rev) continue;
        putTime.run({ ...row, engine: local(row.engine), sync_seq: time.nextSeq(db) });
        applied += 1;
      }
      const memoryFloor = (time.readMemoriesClear(db) || { at: -1 }).at;
      const getMemory = db.prepare('SELECT updated_at, deleted, by FROM memories WHERE uid = ?');
      const putMemory = db.prepare(`INSERT INTO memories (uid, at, kind, event, ref, text, task, session, source, week, sources, private, engine, deleted, updated_at, by, sync_seq)
        VALUES (@uid, @at, @kind, @event, @ref, @text, @task, @session, @source, @week, @sources, @private, @engine, @deleted, @updated_at, @by, @sync_seq)
        ON CONFLICT(uid) DO UPDATE SET at = excluded.at, kind = excluded.kind, event = excluded.event, ref = excluded.ref, text = excluded.text, task = excluded.task,
          session = excluded.session, source = excluded.source, week = excluded.week, sources = excluded.sources, private = excluded.private, engine = excluded.engine,
          deleted = excluded.deleted, updated_at = excluded.updated_at, by = excluded.by, sync_seq = excluded.sync_seq`);
      for (const item of list('memories')) {
        const row = memoryFromPeer(item);
        if (!row || (!row.deleted && row.updated_at <= memoryFloor)) continue;
        const current = getMemory.get(row.uid);
        if (current) {
          const mine = { at: current.updated_at, deleted: current.deleted, by: current.by || self };
          const wins = row.updated_at > mine.at || (row.updated_at === mine.at && (row.deleted > mine.deleted || (row.deleted === mine.deleted && String(row.by) > String(mine.by))));
          if (!wins) continue;
        }
        putMemory.run({ ...row, engine: local(row.engine), by: local(row.by), sync_seq: time.nextSeq(db) });
        applied += 1;
      }
      if (isPlainObject(payload.names)) {
        const known = time.readNames(db);
        let changed = false;
        for (const [id, name] of Object.entries(payload.names)) {
          if (id === self || !INSTANCE_ID.test(id) || typeof name !== 'string' || name.length > 128 || known[id] === name) continue;
          known[id] = name;
          changed = true;
        }
        if (changed) time.writeNames(db, known);
      }
    })();
    return applied;
  }

  function dropHandedOver(acked) {
    if (!handsOver() || !acked) return 0;
    let dropped = 0;
    db.transaction(() => {
      time.keepSeq(db);
      dropped = db.prepare('DELETE FROM usage_time WHERE sync_seq <= ?').run(acked).changes;
      dropped += db.prepare('DELETE FROM memories WHERE sync_seq <= ?').run(acked).changes;
    })();
    return dropped;
  }
  const waiting = () => (handsOver() ? (Number(db.prepare('SELECT COUNT(*) FROM usage_time').pluck().get()) || 0) + (Number(db.prepare('SELECT COUNT(*) FROM memories').pluck().get()) || 0) : 0);

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
    if (typeof given.public_key !== 'string' || !PUBLIC_KEY.test(given.public_key)) throw fault('USAGE_TIME_SYNC_BAD_KEY', 400);
    if (typeof given.instance_id !== 'string' || !INSTANCE_ID.test(given.instance_id)) throw fault('INVALID_USAGE_TIME_SYNC', 400);
    if (link.peer_instance_id && link.peer_instance_id !== given.instance_id) throw fault('INVALID_USAGE_TIME_SYNC', 400);
    return given;
  }
  const haveOf = (state, instanceId) => (isPlainObject(state.have) && state.have.instance_id === instanceId ? int(state.have.seq) : 0);
  const refuseOnCompany = () => { if (company()) throw fault('USAGE_COMPANY_COMPUTER', 409); };

  function engineDescribe(link) {
    const peer = requirePeer(link);
    const state = peerState(peer.id);
    return { instance_id: me(), public_key: linkKeys.publicKey(), company: company(), max_seq: time.maxSeq(db), have: haveOf(state, link.peer_instance_id || state.instance_id || (isPlainObject(state.have) ? state.have.instance_id : '')) };
  }
  function enginePull(link, body) {
    const peer = requirePeer(link);
    refuseOnCompany();
    const given = checkSender(link, body);
    const after = int(given.after);
    const limit = Math.min(MAX_PAGE, Math.max(1, int(given.limit) || pageSize));
    return { instance_id: me(), sealed: seal(sealKey(peer, given.public_key), exportPage(after, limit), aadOf('pull', me(), link.id)) };
  }
  function enginePush(link, body) {
    const peer = requirePeer(link);
    refuseOnCompany();
    const given = checkSender(link, body);
    const payload = open(sealKey(peer, given.public_key), given.sealed, aadOf('push', given.instance_id, link.id));
    const applied = applyPage(payload, given.instance_id);
    const had = haveOf(peerState(peer.id), given.instance_id);
    const have = int(payload.after) <= had ? Math.max(had, int(payload.next)) : had;
    updatePeer(peer.id, () => ({ supported: true, instance_id: given.instance_id, have: { seq: have, instance_id: given.instance_id } }));
    if (applied) fanOut();
    return { applied, have };
  }
  // The reads a company computer shows (the merged set lives on the normal machines): summary, task, day and the memories list.
  function engineRead(link, what, query) {
    requirePeer(link);
    refuseOnCompany();
    if (what === 'summary') return store.summary(query);
    if (what === 'task') return store.task(query);
    if (what === 'day') return store.day(query);
    if (what === 'memories') return notes.list(query);
    throw fault('NOT_FOUND', 404);
  }
  // A company computer's edit or delete of a memory kept here.
  function engineMemory(link, method, uid, body) {
    requirePeer(link);
    refuseOnCompany();
    const result = method === 'DELETE' ? notes.remove(uid) : notes.editNote(uid, body);
    return result;
  }

  // ---- Failures in the log (once per reason) ----
  const reported = new Map();
  function report(key, what, error = null) {
    const reason = error ? errorCode(error) : null;
    const before = reported.get(key) || null;
    if (reason === before) return;
    if (reason) { reported.set(key, reason); log.warn(`[usage-time-sync] ${what} failed: ${reason}`); } else {
      reported.delete(key);
      (log.info || log.warn).call(log, `[usage-time-sync] ${what} works again (it failed with ${before})`);
    }
  }

  // ---- Rounds ----
  const running = new Map();
  const again = new Set();
  let fullSerial = 0;
  const fullAt = new Map();
  async function round(peer) {
    const call = (route, opts = {}) => request(peer.baseUrl, route, peer.token, { timeoutMs, ...opts });
    let applied = 0;
    try {
      const info = await call('/v1/info');
      const caps = info && Array.isArray(info.capabilities) ? info.capabilities : [];
      const supported = caps.includes(CAPABILITY) && caps.includes('usage:sync');
      const peerCompany = Boolean(info && info.company_computer === true);
      const instanceId = info && typeof info.engine_id === 'string' && INSTANCE_ID.test(info.engine_id) ? info.engine_id : undefined;
      updatePeer(peer.id, () => ({ supported, company: peerCompany, ...(instanceId ? { instance_id: instanceId } : {}) }));
      const skip = () => { report(peer.id, `sync with ${peer.name}`); return 0; };
      if (!supported || peerCompany) return skip();
      if (company() && (!homePeer() || homePeer().id !== peer.id)) return skip();
      const theirs = await call(ROUTE);
      if (!theirs || typeof theirs.instance_id !== 'string' || !INSTANCE_ID.test(theirs.instance_id)) throw fault('USAGE_TIME_SYNC_BAD_ANSWER', 502);
      if (theirs.company) { updatePeer(peer.id, () => ({ company: true })); return skip(); }
      const key = sealKey(peer, theirs.public_key);
      const self = me();
      const mine = linkKeys.publicKey();
      const handing = company();
      const theirMax = int(theirs.max_seq);
      if (!handing) {
        let after = haveOf(peerState(peer.id), theirs.instance_id);
        if (after > theirMax) after = 0;
        for (let pages = 0; after < theirMax && pages < MAX_PAGES_PER_ROUND; pages += 1) {
          const answer = await call(`${ROUTE}/pull`, { method: 'POST', body: { instance_id: self, public_key: mine, after, limit: pageSize } });
          const payload = open(key, answer && answer.sealed, aadOf('pull', theirs.instance_id, peer.id));
          applied += applyPage(payload, theirs.instance_id);
          const next = int(payload.next);
          if (next <= after) break;
          after = next;
          updatePeer(peer.id, () => ({ instance_id: theirs.instance_id, have: { seq: after, instance_id: theirs.instance_id } }));
          if (!payload.more) break;
        }
      }
      let sent = int(theirs.have);
      if (sent > time.maxSeq(db)) sent = 0;
      for (let pages = 0; sent < time.maxSeq(db) && pages < MAX_PAGES_PER_ROUND; pages += 1) {
        const page = exportPage(sent, pageSize);
        const answer = await call(ROUTE, { method: 'PUT', body: { instance_id: self, public_key: mine, sealed: seal(key, page, aadOf('push', self, peer.id)) } });
        const have = int(answer && answer.have);
        if (have <= sent) break;
        sent = have;
        if (!page.more) break;
      }
      if (handing) {
        updatePeer(peer.id, () => ({ acked: sent }));
        dropHandedOver(sent);
        writeState(db, HOME_KEY, { link_id: peer.id, name: peer.name, at: now() });
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
      const home = homePeer();
      if (home && !((fullAt.get(home.id) || 0) > mark)) await syncPeer(home);
      return;
    }
    if (results.some(count => count > 0)) fanOut();
  }
  const syncInBackground = () => syncAll().then(() => report('rounds', 'a sync round'), error => report('rounds', 'a sync round', error)).catch(() => {});
  async function refresh() {
    const home = homePeer();
    if (!home || !request) return false;
    let timer;
    const wait = new Promise(resolve => { timer = setTimeout(() => resolve(false), readWaitMs); if (timer.unref) timer.unref(); });
    try { return await Promise.race([syncPeer(home).then(() => true), wait]); } finally { clearTimeout(timer); }
  }
  let timer = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; syncInBackground(); }, company() ? companyDebounceMs : debounceMs);
    if (timer.unref) timer.unref();
  }
  const fanOut = () => { if (started && !company()) schedule(); };

  // ---- The page ----
  function where() {
    const handing = handsOver();
    return {
      company_computer: company(), hands_over: handing, home_name: handing ? homeName() : null, home_online: handing ? Boolean(homePeer()) : null,
      waiting: handing ? waiting() : 0, shared_with: handing || !enabled() ? [] : normalPeers().map(peer => peer.name),
    };
  }
  // A read on a company computer: the home's while it can be reached (after handing the last rows over), else the rows waiting here.
  async function companyRead(what, query, fallback) {
    await refresh();
    const home = homePeer();
    if (home && request) {
      const params = new URLSearchParams(Object.entries(query || {}).filter(([, value]) => value !== null && value !== undefined).map(([name, value]) => [name, String(value)]));
      try {
        const answer = await request(home.baseUrl, `${ROUTE}/${what}?${params}`, home.token, { timeoutMs });
        if (isPlainObject(answer)) return { ...answer, where: where() };
      } catch (error) {
        if (error && error.statusCode === 400) throw error;
      }
    }
    return { ...fallback(), where: where() };
  }
  // An edit or a delete on a company computer: of a row still here, here; else on the home.
  async function companyMemory(method, uid, body) {
    if (notes.has(uid)) return method === 'DELETE' ? notes.remove(uid) : notes.editNote(uid, body);
    const home = homePeer();
    if (!home || !request) throw fault('USAGE_HOME_OFFLINE', 503);
    try {
      return await request(home.baseUrl, `${ROUTE}/memories/${encodeURIComponent(uid)}`, home.token, { method, ...(method === 'PATCH' ? { body } : {}), timeoutMs });
    } catch (error) {
      if (error && Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500 && /^[A-Z0-9_]+$/.test(error.message || '')) throw fault(error.message, error.statusCode);
      throw fault('USAGE_HOME_OFFLINE', 503);
    }
  }
  // The export on a company computer: the home's rows, read page by page through the sealed pull.
  async function companyExport(table, format, write) {
    await refresh();
    const home = homePeer();
    const localExport = () => (table === 'memories' ? notes.exportMemories(write, format) : store.exportTime(write, format));
    if (!home || !request) return localExport();
    const theirs = await request(home.baseUrl, ROUTE, home.token, { timeoutMs });
    if (!theirs || typeof theirs.instance_id !== 'string' || !INSTANCE_ID.test(theirs.instance_id)) throw fault('USAGE_TIME_SYNC_BAD_ANSWER', 502);
    const key = sealKey(home, theirs.public_key);
    const rows = new Map();
    const theirMax = int(theirs.max_seq);
    let after = 0;
    for (let pages = 0; after < theirMax && pages < MAX_PAGES_PER_ROUND; pages += 1) {
      const answer = await request(home.baseUrl, `${ROUTE}/pull`, home.token, { method: 'POST', body: { instance_id: me(), public_key: linkKeys.publicKey(), after, limit: MAX_PAGE }, timeoutMs });
      const payload = open(key, answer && answer.sealed, aadOf('pull', theirs.instance_id, home.id));
      if (isPlainObject(payload.names)) time.writeNames(db, { ...time.readNames(db), ...Object.fromEntries(Object.entries(payload.names).filter(([id, name]) => id !== me() && INSTANCE_ID.test(id) && typeof name === 'string' && name.length <= 128)) });
      for (const item of table === 'memories' ? (payload.memories || []) : (payload.time || [])) {
        const row = table === 'memories' ? memoryFromPeer(item) : timeFromPeer(item);
        if (row) rows.set(row.uid, { ...row, engine: row.engine === me() ? '' : row.engine });
      }
      const next = int(payload.next);
      if (next <= after || !payload.more) break;
      after = next;
    }
    const sorted = [...rows.values()].sort((a, b) => (table === 'memories' ? a.at - b.at : a.start - b.start) || a.uid.localeCompare(b.uid));
    return table === 'memories' ? notes.exportMemories(write, format, sorted) : store.exportTime(write, format, sorted);
  }

  // ---- Life ----
  let started = false;
  let interval = null;
  const unsubscribe = [];
  function start() {
    if (started) return;
    started = true;
    unsubscribe.push(time.onUsageTimeChanged(changedDb => { if (changedDb === db) schedule(); }));
    unsubscribe.push(require('./device-tier').onTierChange((value, changedDb) => { if (!changedDb || changedDb === db) syncInBackground(); }));
    if (serviceLinks && request) {
      unsubscribe.push(serviceLinks.onChange(id => {
        if (company()) return syncInBackground();
        const peer = onlinePeers().find(candidate => candidate.id === id);
        if (peer) syncPeer(peer);
        return undefined;
      }));
      if (intervalMs > 0) { interval = setInterval(syncInBackground, intervalMs); if (interval.unref) interval.unref(); }
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
    start, stop, syncAll, syncPeer, refresh, where, handsOver, waiting, linked, companyRead, companyMemory, companyExport,
    engineDescribe, enginePull, enginePush, engineRead, engineMemory, exportPage, applyPage, peerStates: readPeers,
  };
}

// Off with SETTINGS_SYNC_ENABLED=false or USAGE_SYNC_ENABLED=false (config.usageSyncEnabled), like the usage data sync.
const syncEnabled = () => require('../config').usageSyncEnabled !== false;

let singleton = null;
function getUsageTimeSync({ usage = null, memories = null } = {}) {
  if (singleton) return singleton;
  const db = require('../db');
  const settingsSync = require('./settings-sync').getSettingsSync();
  const identity = () => { const { engine_id: instanceId, name } = require('./engine-identity').getEngineIdentity(); return { instance_id: instanceId, name }; };
  singleton = createUsageTimeSync({
    db, serviceLinks: require('./service-links').getServiceLinks(),
    request: (...args) => require('./remote-client').request(...args),
    identity,
    linkKeys: { publicKey: () => settingsSync.publicKey(), linkKey: (peer, publicKey) => settingsSync.linkKey(peer, publicKey) },
    tier: require('./device-tier').getDeviceTier(),
    enabled: syncEnabled, usage, memories,
  });
  return singleton;
}

module.exports = { createUsageTimeSync, getUsageTimeSync, syncEnabled, aadOf, keyFrom, timeFromPeer, memoryFromPeer, CAPABILITY, ROUTE, PEERS_KEY, HOME_KEY, PAGE_SIZE };
