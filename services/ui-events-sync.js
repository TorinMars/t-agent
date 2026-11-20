// Usage data across linked devices ("Merged across linked devices" and "Company computer" in docs/design/usage-data.md): the button presses every
// engine records (services/ui-events.js) are one set on every normal machine joined by service links, and a company computer hands its own presses
// over to a normal machine and keeps none. The same pattern as the Learn sync (services/learn-sync.js), with simpler rows:
//
// - Rows: a press is identified by a random uid and never changes (a union by uid); a seen control by key + surface + layout (the earliest
//   first_seen and the latest last_seen win); the clear mark (the last "Clear", { at, by }) by its time, a tie to the greater instance id. A press at
//   or before the clear mark, or older than the retention, is refused.
// - Change numbers: every row written here, locally or from a peer, gets the next number of the database (services/ui-events.js). A device asks a
//   peer for the rows after the highest number of that peer it has (`have`, kept per link), one page at a time, and sends its own rows after the
//   number the peer reports. A receiver applies a row only when it changes something, so an echo stops at once, and what it applied gets new
//   numbers, so it goes on to its other peers (a chain A–B–C reaches C).
// - Transport: GET /v1/info must list `usage:sync`; GET /v1/usage-sync, POST /v1/usage-sync/pull, PUT /v1/usage-sync, GET /v1/usage-sync/summary.
//   Rows travel only inside the settings sync's AES-256-GCM envelopes, with a key derived from that link's settings-sync key and their own
//   additional data.
// - Company computer (services/device-tier.js): it syncs only with its home (the online normal linked machine with the oldest link), never pulls,
//   pushes its presses soon after they are recorded and deletes them once the home has them. Its summary and export are the home's. Normal machines
//   never sync with it themselves. With no normal machine linked it keeps its data as a normal machine would.
const crypto = require('crypto');
const { seal, open } = require('./settings-sync');
const { readState, writeState, isPlainObject } = require('./settings-sync-store');
const usage = require('./ui-events');

const CAPABILITY = 'usage:sync';
const ROUTE = '/v1/usage-sync';
const PEERS_KEY = 'ui_usage_sync_peers_v1';
const HOME_KEY = 'ui_usage_home_v1';
const PAGE_SIZE = 500;
const MAX_PAGE = 2000;
const MAX_PAGES_PER_ROUND = 500;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const DEBOUNCE_MS = 10_000;
const COMPANY_DEBOUNCE_MS = 2000;
const REQUEST_TIMEOUT_MS = 15_000;
const READ_WAIT_MS = 4000;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const INSTANCE_ID = usage.INSTANCE_ID;
const UID = /^[A-Za-z0-9-]{1,64}$/;
const VERSION = /^[\x20-\x7e]{1,32}$/;

const fault = (code, statusCode = 400) => Object.assign(new Error(code), { statusCode });
const errorCode = error => (error && /^[A-Z0-9_]{1,64}$/.test(error.message || '') ? error.message : 'USAGE_SYNC_FAILED');
const aadOf = (direction, sender, linkId) => Buffer.from(`t-agent usage-sync v1|${direction}|${sender}|${linkId}`);
const usageKeyFrom = linkKey => Buffer.from(crypto.hkdfSync('sha256', linkKey, Buffer.alloc(0), Buffer.from('t-agent usage-sync v1'), 32));
const int = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
// Version a is later than version b (time, then the greater instance id).
const later = (aAt, aBy, bAt, bBy) => aAt > bAt || (aAt === bAt && String(aBy || '') > String(bBy || ''));

// A press from a peer, checked like one of the page (services/ui-events.js), or null.
function eventFromPeer(raw) {
  if (!isPlainObject(raw)) return null;
  const { uid, at, page, key, detail, surface, view, layout, input, pane, device, state, version, engine, client } = raw;
  if (typeof uid !== 'string' || !UID.test(uid) || !Number.isSafeInteger(at) || at < 0) return null;
  if (typeof page !== 'string' || !usage.PAGE.test(page) || typeof key !== 'string' || !usage.KEY.test(key) || typeof surface !== 'string' || !usage.SURFACE.test(surface)) return null;
  if (detail !== null && detail !== undefined && (typeof detail !== 'string' || !usage.DETAIL.test(detail))) return null;
  if (state !== null && state !== undefined && state !== 'on' && state !== 'off') return null;
  if (typeof pane !== 'boolean' || typeof engine !== 'string' || !INSTANCE_ID.test(engine)) return null;
  if (client !== null && client !== undefined && !usage.CLIENTS.includes(client)) return null;
  if (version !== null && version !== undefined && (typeof version !== 'string' || !VERSION.test(version))) return null;
  const fields = { view, layout, input, device };
  if (!Object.entries(fields).every(([field, value]) => usage.ENUMS[field].includes(value))) return null;
  return { uid, at, page, key, detail: detail || null, surface, view, layout, input, pane: pane ? 1 : 0, device, state: state || null, version: version || null, engine, client: client || null };
}
function controlFromPeer(raw) {
  if (!isPlainObject(raw)) return null;
  const { key, surface, layout, first_seen: first, last_seen: last } = raw;
  if (typeof key !== 'string' || !usage.KEY.test(key) || typeof surface !== 'string' || !usage.SURFACE.test(surface) || !usage.ENUMS.layout.includes(layout)) return null;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || last < first) return null;
  return { key, surface, layout, first_seen: first, last_seen: last };
}

function createUsageSync(options) {
  const {
    db, serviceLinks = null, request = null,
    identity, // () => { instance_id, name }
    linkKeys, // { publicKey(), linkKey(peer, publicKey) }: the settings sync's key pair and link keys
    tier = { isCompany: () => false },
    enabled = () => true,
    service = null, // the usage data service of this database (services/ui-events.js), for the home's summary
    now = Date.now, log = console,
    intervalMs = SYNC_INTERVAL_MS, debounceMs = DEBOUNCE_MS, companyDebounceMs = COMPANY_DEBOUNCE_MS, timeoutMs = REQUEST_TIMEOUT_MS,
    pageSize = PAGE_SIZE, readWaitMs = READ_WAIT_MS,
  } = options;
  usage.ensureSchema(db);
  const me = () => identity().instance_id;
  const company = () => Boolean(tier.isCompany());
  let usageService = service;
  const local = () => usageService || (usageService = usage.createUiEvents({ db, now, identity }));

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

  // ---- Links, tiers and the home ----
  const livePeers = () => {
    if (!serviceLinks) return [];
    try { return serviceLinks.peers(); } catch { return []; }
  };
  const onlinePeers = () => livePeers().filter(peer => peer.online);
  // The linked machines known to be normal and to have the sync (from their last /v1/info), oldest link first.
  const normalPeers = () => { const states = readPeers(); return livePeers().filter(peer => states[peer.id] && states[peer.id].supported === true && states[peer.id].company === false); };
  // A company computer with a normal machine to keep the data on: it hands its presses over. Otherwise the data stays here.
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

  function usageKey(peer, publicKey) {
    if (typeof publicKey !== 'string' || !PUBLIC_KEY.test(publicKey)) throw fault('USAGE_SYNC_BAD_KEY', 400);
    return usageKeyFrom(linkKeys.linkKey(peer, publicKey));
  }

  // The names of the engines whose presses are here (this one, and what the pages from peers said).
  function names() {
    const self = identity();
    return { ...usage.readNames(db), ...(self.instance_id ? { [self.instance_id]: self.name || '' } : {}) };
  }

  // ---- Pages ----
  // The rows after change number `after`, at most `limit`: { events, controls, clear, names, after, next, more }. `next` is the number to ask after
  // next time (the newest number when nothing more is left).
  function exportPage(after, limit) {
    const self = me();
    const newest = usage.maxSeq(db);
    db.prepare('UPDATE ui_events SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL').run(); // a row written without one (an older path)
    const events = db.prepare('SELECT * FROM ui_events WHERE sync_seq > ? ORDER BY sync_seq LIMIT ?').all(after, limit);
    const controls = db.prepare('SELECT * FROM ui_controls WHERE sync_seq > ? ORDER BY sync_seq LIMIT ?').all(after, limit);
    const mark = usage.readClear(db);
    const rows = [
      ...events.map(row => ({ type: 'event', seq: row.sync_seq, row })),
      ...controls.map(row => ({ type: 'control', seq: row.sync_seq, row })),
      ...(mark && mark.seq > after ? [{ type: 'clear', seq: mark.seq }] : []),
    ].sort((a, b) => a.seq - b.seq);
    const taken = rows.slice(0, limit);
    const more = rows.length > limit || [events, controls].some(list => list.length >= limit);
    const page = { events: [], controls: [], clear: null, names: names(), after, next: more ? taken[taken.length - 1].seq : Math.max(newest, after), more };
    for (const entry of taken) {
      const { row } = entry;
      if (entry.type === 'event') {
        page.events.push({
          uid: row.uid, at: row.at, page: row.page, key: row.key, detail: row.detail, surface: row.surface, view: row.view, layout: row.layout, input: row.input,
          pane: Boolean(row.pane), device: row.device, state: row.state, version: row.version, engine: row.engine || self, client: row.client,
        });
      } else if (entry.type === 'control') {
        page.controls.push({ key: row.key, surface: row.surface, layout: row.layout, first_seen: row.first_seen, last_seen: row.last_seen });
      } else page.clear = { at: mark.at, by: mark.by || self };
    }
    return page;
  }

  // Applies a page from `sender` in one transaction and returns how many rows changed something. What changed gets new change numbers, so it goes
  // on to the other peers.
  function applyPage(payload, sender) {
    if (!isPlainObject(payload)) throw fault('INVALID_USAGE_SYNC', 400);
    const list = key => (Array.isArray(payload[key]) ? payload[key] : []);
    if (list('events').length + list('controls').length > MAX_PAGE * 2) throw fault('USAGE_SYNC_TOO_LARGE', 413);
    const self = me();
    const oldest = now() - usage.RETENTION_DAYS * usage.DAY;
    let applied = 0;
    db.transaction(() => {
      // The clear mark first, so the presses it removes are not added again.
      const raw = payload.clear;
      if (isPlainObject(raw) && Number.isSafeInteger(raw.at) && raw.at >= 0) {
        const by = typeof raw.by === 'string' && INSTANCE_ID.test(raw.by) ? raw.by : sender;
        const mark = usage.readClear(db);
        if (!mark || later(raw.at, by, mark.at, mark.by || self)) {
          usage.keepSeq(db);
          db.prepare('DELETE FROM ui_events WHERE at <= ?').run(raw.at);
          db.prepare('DELETE FROM ui_controls WHERE last_seen <= ?').run(raw.at);
          usage.writeClear(db, { at: raw.at, by: by === self ? '' : by, seq: usage.nextSeq(db) });
          applied += 1;
        }
      }
      const mark = usage.readClear(db);
      const floor = Math.max(oldest, mark ? mark.at + 1 : 0);
      const has = db.prepare('SELECT 1 FROM ui_events WHERE uid = ?').pluck();
      const insert = db.prepare(`INSERT INTO ui_events (at, page, key, detail, surface, view, layout, input, pane, device, state, version, uid, engine, client, sync_seq)
        VALUES (@at, @page, @key, @detail, @surface, @view, @layout, @input, @pane, @device, @state, @version, @uid, @engine, @client, @sync_seq)`);
      for (const item of list('events')) {
        const event = eventFromPeer(item);
        if (!event || event.at < floor || has.get(event.uid)) continue;
        insert.run({ ...event, engine: event.engine === self ? '' : event.engine, sync_seq: usage.nextSeq(db) });
        applied += 1;
      }
      const control = db.prepare('SELECT first_seen, last_seen FROM ui_controls WHERE key = ? AND surface = ? AND layout = ?');
      for (const item of list('controls')) {
        const seen = controlFromPeer(item);
        if (!seen || seen.last_seen < floor) continue;
        const current = control.get(seen.key, seen.surface, seen.layout);
        if (current && seen.first_seen >= current.first_seen && seen.last_seen <= current.last_seen) continue;
        db.prepare(`INSERT INTO ui_controls (key, surface, layout, first_seen, last_seen, sync_seq) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(key, surface, layout) DO UPDATE SET first_seen = MIN(first_seen, excluded.first_seen), last_seen = MAX(last_seen, excluded.last_seen), sync_seq = excluded.sync_seq`)
          .run(seen.key, seen.surface, seen.layout, seen.first_seen, seen.last_seen, usage.nextSeq(db));
        applied += 1;
      }
      // The names of the engines (not counted: a name alone is never sent on).
      if (isPlainObject(payload.names)) {
        const known = usage.readNames(db);
        let changed = false;
        for (const [id, name] of Object.entries(payload.names)) {
          if (id === self || !INSTANCE_ID.test(id) || typeof name !== 'string' || name.length > 128 || known[id] === name) continue;
          known[id] = name;
          changed = true;
        }
        if (changed) usage.writeNames(db, known);
      }
    })();
    return applied;
  }

  // A company computer hands its rows over: what the home has (change number up to `acked`) leaves this machine.
  function dropHandedOver(acked) {
    if (!handsOver() || !acked) return 0;
    let dropped = 0;
    db.transaction(() => {
      usage.keepSeq(db);
      dropped = db.prepare('DELETE FROM ui_events WHERE sync_seq <= ?').run(acked).changes;
      db.prepare('DELETE FROM ui_controls WHERE sync_seq <= ?').run(acked);
    })();
    return dropped;
  }
  // How many presses of this company computer wait for a normal machine (every one here: the handed-over ones are gone).
  const waiting = () => (handsOver() ? Number(db.prepare('SELECT COUNT(*) FROM ui_events').pluck().get()) || 0 : 0);

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
    if (typeof given.public_key !== 'string' || !PUBLIC_KEY.test(given.public_key)) throw fault('USAGE_SYNC_BAD_KEY', 400);
    if (typeof given.instance_id !== 'string' || !INSTANCE_ID.test(given.instance_id)) throw fault('INVALID_USAGE_SYNC', 400);
    if (link.peer_instance_id && link.peer_instance_id !== given.instance_id) throw fault('INVALID_USAGE_SYNC', 400);
    return given;
  }
  const haveOf = (state, instanceId) => (isPlainObject(state.have) && state.have.instance_id === instanceId ? int(state.have.seq) : 0);
  const refuseOnCompany = () => { if (company()) throw fault('USAGE_COMPANY_COMPUTER', 409); };

  // GET /v1/usage-sync
  function engineDescribe(link) {
    const peer = requirePeer(link);
    const state = peerState(peer.id);
    return {
      instance_id: me(), public_key: linkKeys.publicKey(), company: company(), max_seq: usage.maxSeq(db),
      have: haveOf(state, link.peer_instance_id || state.instance_id || (isPlainObject(state.have) ? state.have.instance_id : '')),
    };
  }
  // POST /v1/usage-sync/pull { instance_id, public_key, after, limit }
  function enginePull(link, body) {
    const peer = requirePeer(link);
    refuseOnCompany();
    const given = checkSender(link, body);
    const after = int(given.after);
    const limit = Math.min(MAX_PAGE, Math.max(1, int(given.limit) || pageSize));
    const key = usageKey(peer, given.public_key);
    return { instance_id: me(), sealed: seal(key, exportPage(after, limit), aadOf('pull', me(), link.id)) };
  }
  // PUT /v1/usage-sync { instance_id, public_key, sealed }: the peer's rows after `after` (inside the envelope). Answers how far this device has them.
  function enginePush(link, body) {
    const peer = requirePeer(link);
    refuseOnCompany();
    const given = checkSender(link, body);
    const key = usageKey(peer, given.public_key);
    const payload = open(key, given.sealed, aadOf('push', given.instance_id, link.id));
    const applied = applyPage(payload, given.instance_id);
    const had = haveOf(peerState(peer.id), given.instance_id);
    const have = int(payload.after) <= had ? Math.max(had, int(payload.next)) : had;
    updatePeer(peer.id, () => ({ supported: true, instance_id: given.instance_id, have: { seq: have, instance_id: given.instance_id } }));
    if (applied) fanOut();
    return { applied, have };
  }
  // GET /v1/usage-sync/summary?days&layout&engine&client: what a company computer shows (the merged set lives on the normal machines).
  function engineSummary(link, query) {
    requirePeer(link);
    refuseOnCompany();
    const parsed = usage.summaryQuery(query);
    if (!parsed) throw fault('INVALID_UI_EVENTS_QUERY', 400);
    return local().summary(parsed);
  }

  // ---- Failures in the log (once per reason, once when it works again, codes only) ----
  const reported = new Map();
  function report(key, what, error = null) {
    const reason = error ? errorCode(error) : null;
    const before = reported.get(key) || null;
    if (reason === before) return;
    if (reason) { reported.set(key, reason); log.warn(`[usage-sync] ${what} failed: ${reason}`); } else {
      reported.delete(key);
      (log.info || log.warn).call(log, `[usage-sync] ${what} works again (it failed with ${before})`);
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
      const supported = Boolean(info && Array.isArray(info.capabilities) && info.capabilities.includes(CAPABILITY));
      const peerCompany = Boolean(info && info.company_computer === true);
      updatePeer(peer.id, () => ({ supported, company: peerCompany }));
      const skip = () => { report(peer.id, `sync with ${peer.name}`); return 0; };
      if (!supported || peerCompany) return skip();
      if (company() && (!homePeer() || homePeer().id !== peer.id)) return skip();
      const theirs = await call(ROUTE);
      if (!theirs || typeof theirs.instance_id !== 'string' || !INSTANCE_ID.test(theirs.instance_id)) throw fault('USAGE_SYNC_BAD_ANSWER', 502);
      if (theirs.company) { updatePeer(peer.id, () => ({ company: true })); return skip(); }
      const key = usageKey(peer, theirs.public_key);
      const self = me();
      const mine = linkKeys.publicKey();
      const handing = company();
      const theirMax = int(theirs.max_seq);

      // Pull (normal machines only): the peer's rows after what this device has of them.
      if (!handing) {
        let after = haveOf(peerState(peer.id), theirs.instance_id);
        if (after > theirMax) after = 0; // the peer's database is older than what we had (restored): from the start
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

      // Push: this device's rows after what the peer has of them.
      let sent = int(theirs.have);
      if (sent > usage.maxSeq(db)) sent = 0;
      for (let pages = 0; sent < usage.maxSeq(db) && pages < MAX_PAGES_PER_ROUND; pages += 1) {
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
      // The home may be known only after this pass read the peers' /v1/info: then it is synced now.
      const home = homePeer();
      if (home && !((fullAt.get(home.id) || 0) > mark)) await syncPeer(home);
      return;
    }
    if (results.some(count => count > 0)) fanOut();
  }
  const syncInBackground = () => syncAll().then(() => report('rounds', 'a sync round'), error => report('rounds', 'a sync round', error)).catch(() => {});

  // A company computer hands its presses over before a read (at most `readWaitMs`), so its own last presses are in the home's summary.
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
  // Where the data is kept, for Settings → Usage data: { company_computer, hands_over, home_name, home_online, waiting, shared_with }.
  // `shared_with`: the normal linked machines that keep the same set (names), when this is a normal machine.
  function where() {
    const handing = handsOver();
    return {
      company_computer: company(),
      hands_over: handing,
      home_name: handing ? homeName() : null,
      home_online: handing ? Boolean(homePeer()) : null,
      waiting: handing ? waiting() : 0,
      shared_with: handing || !enabled() ? [] : normalPeers().map(peer => peer.name),
    };
  }

  // The summary on a company computer: the home's while it can be reached (after handing the last presses over), else the presses waiting here.
  async function companySummary(query) {
    await refresh();
    const home = homePeer();
    if (home && request) {
      const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== null && value !== undefined).map(([name, value]) => [name, String(value)]));
      try {
        const summary = await request(home.baseUrl, `${ROUTE}/summary?${params}`, home.token, { timeoutMs });
        if (isPlainObject(summary)) return { ...summary, where: where() };
      } catch { /* the presses here below */ }
    }
    return { ...local().summary(query), where: where() };
  }

  // The export on a company computer: the home's rows, read page by page through the sealed pull (the presses waiting here when it is away), in
  // the shape of exportTo of services/ui-events.js. `write` gets the JSON in pieces.
  async function companyExport(write) {
    await refresh();
    const home = homePeer();
    if (!home || !request) return local().exportTo(write);
    const theirs = await request(home.baseUrl, ROUTE, home.token, { timeoutMs });
    if (!theirs || typeof theirs.instance_id !== 'string' || !INSTANCE_ID.test(theirs.instance_id)) throw fault('USAGE_SYNC_BAD_ANSWER', 502);
    const key = usageKey(home, theirs.public_key);
    const controls = new Map();
    const seenNames = {};
    const theirMax = int(theirs.max_seq);
    write(`{"exported_at":${JSON.stringify(new Date(now()).toISOString())},"retention_days":${usage.RETENTION_DAYS},"events":[`);
    let first = true;
    let after = 0;
    for (let pages = 0; after < theirMax && pages < MAX_PAGES_PER_ROUND; pages += 1) {
      const answer = await request(home.baseUrl, `${ROUTE}/pull`, home.token, { method: 'POST', body: { instance_id: me(), public_key: linkKeys.publicKey(), after, limit: MAX_PAGE }, timeoutMs });
      const payload = open(key, answer && answer.sealed, aadOf('pull', theirs.instance_id, home.id));
      if (isPlainObject(payload.names)) Object.assign(seenNames, payload.names);
      for (const item of Array.isArray(payload.events) ? payload.events : []) {
        const event = eventFromPeer(item);
        if (!event) continue;
        const row = { ...event };
        delete row.uid; // not part of the export
        const client = row.client || (row.layout === 'narrow' ? 'phone' : 'computer');
        write(`${first ? '' : ','}${JSON.stringify({ ...row, client, pane: Boolean(row.pane), engine_name: typeof seenNames[row.engine] === 'string' ? seenNames[row.engine] : null, time: new Date(row.at).toISOString() })}`);
        first = false;
      }
      for (const item of Array.isArray(payload.controls) ? payload.controls : []) {
        const seen = controlFromPeer(item);
        if (seen) controls.set(`${seen.key}|${seen.surface}|${seen.layout}`, seen);
      }
      const next = int(payload.next);
      if (next <= after || !payload.more) break;
      after = next;
    }
    write('],"controls":');
    write(JSON.stringify([...controls.values()].sort((a, b) => `${a.key}|${a.surface}|${a.layout}`.localeCompare(`${b.key}|${b.surface}|${b.layout}`))));
    write('}');
    return undefined;
  }

  // ---- Life ----
  let started = false;
  let interval = null;
  const unsubscribe = [];
  function start() {
    if (started) return;
    started = true;
    unsubscribe.push(usage.onUsageChanged(changedDb => { if (changedDb === db) schedule(); }));
    unsubscribe.push(require('./device-tier').onTierChange((value, changedDb) => { if (!changedDb || changedDb === db) syncInBackground(); }));
    if (serviceLinks && request) {
      unsubscribe.push(serviceLinks.onChange(id => {
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
    start, stop, syncAll, syncPeer, refresh, where, handsOver, waiting, companySummary, companyExport,
    engineDescribe, enginePull, enginePush, engineSummary, exportPage, applyPage, peerStates: readPeers,
  };
}

// Off with SETTINGS_SYNC_ENABLED=false or USAGE_SYNC_ENABLED=false (config.usageSyncEnabled).
const syncEnabled = () => require('../config').usageSyncEnabled !== false;

let singleton = null;
function getUsageSync({ service = null } = {}) {
  if (singleton) return singleton;
  const db = require('../db');
  const settingsSync = require('./settings-sync').getSettingsSync();
  const identity = () => { const { engine_id: instanceId, name } = require('./engine-identity').getEngineIdentity(); return { instance_id: instanceId, name }; };
  singleton = createUsageSync({
    db, serviceLinks: require('./service-links').getServiceLinks(),
    request: (...args) => require('./remote-client').request(...args),
    identity,
    linkKeys: { publicKey: () => settingsSync.publicKey(), linkKey: (peer, publicKey) => settingsSync.linkKey(peer, publicKey) },
    tier: require('./device-tier').getDeviceTier(),
    enabled: syncEnabled,
    service,
  });
  return singleton;
}

module.exports = { createUsageSync, getUsageSync, syncEnabled, aadOf, usageKeyFrom, eventFromPeer, controlFromPeer, CAPABILITY, ROUTE, PEERS_KEY, HOME_KEY, PAGE_SIZE };
