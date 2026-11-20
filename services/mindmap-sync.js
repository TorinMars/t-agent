// Mind maps on every engine ("Mind maps on every engine" in docs/design/mind-maps.md): every normal machine joined by service links keeps a copy of
// every map (services/mindmap.js keeps the files, services/mindmap-merge.js decides), and a company computer keeps a cache of the maps opened there
// and hands its own changes over to a normal machine. The pattern of the Learn and usage data syncs (services/learn-sync.js, services/ui-events-sync.js):
//
// - Change numbers: every entry written in the folder, here or from a peer, gets the next number (services/mindmap.js). A device asks a peer for the
//   entries after the highest number of that peer it has (`have`, kept per link), one page at a time, a page cut by bytes (maps can be large; one map
//   always fits), and sends its own entries after the number the peer reports. A receiver applies an entry only when it changes something, so an echo
//   stops at once, and what it applied gets new numbers, so it goes on to its other peers (a chain A–B–C reaches C).
// - When: a save here pushes DEBOUNCE_MS after the last change (at most MAX_WAIT_MS after the first one), also when a link comes online, at start and
//   every SYNC_INTERVAL_MS.
// - Transport: GET /v1/info must list `mindmaps:sync` (an older peer is skipped: its maps stay where they are, listed by the page as before).
//   GET /v1/mindmap-sync, POST /v1/mindmap-sync/pull, PUT /v1/mindmap-sync (routes/mindmap-sync.js), link tokens only. Entries travel only inside
//   AES-256-GCM envelopes with a key derived from that link's settings-sync key and their own additional data.
// - Company computer (services/device-tier.js): it syncs only with its home (the online normal linked machine with the oldest link), never pulls the
//   whole set: it pushes its own changes soon after they are made, reads the list and each map it opens through the home (keeping the opened ones as
//   its cache), and drops what its home has that it did not open lately. Normal machines never sync with it themselves. With no normal machine
//   linked it keeps its maps as a normal machine would.
const crypto = require('crypto');
const { readState, writeState, isPlainObject } = require('./settings-sync-store');
const { MindmapError } = require('./mindmap');

const CAPABILITY = 'mindmaps:sync';
const ROUTE = '/v1/mindmap-sync';
const PEERS_KEY = 'mindmap_sync_peers_v1';
const HOME_KEY = 'mindmap_home_v1';
const PAGE_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const PAGE_ROWS = 500;
const MAX_PAGES_PER_ROUND = 500;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const DEBOUNCE_MS = 3000;
const MAX_WAIT_MS = 15_000;
const COMPANY_DEBOUNCE_MS = 200;
const REQUEST_TIMEOUT_MS = 60_000;
const READ_WAIT_MS = 4000;
const RETRY_MS = 15_000; // a round that failed (a link that was reset while it came up) is tried again this long after, once
const CACHE_DAYS = 14;
const DAY = 24 * 60 * 60 * 1000;
// An envelope holds a page: one map of up to 8 MB always fits, as JSON, encrypted and in base64url.
const MAX_ENVELOPE_CHARS = 40 * 1024 * 1024;
const MAX_ANSWER_BYTES = 48 * 1024 * 1024;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const INSTANCE_ID = /^[A-Za-z0-9-]{1,64}$/;
const B64URL = /^[A-Za-z0-9_-]*$/;

const fault = (code, statusCode = 400) => Object.assign(new Error(code), { statusCode });
const errorCode = error => (error && /^[A-Z0-9_]{1,64}$/.test(error.message || '') ? error.message : 'MINDMAP_SYNC_FAILED');
const aadOf = (direction, sender, linkId) => Buffer.from(`t-agent mindmap-sync v1|${direction}|${sender}|${linkId}`);
const mapKeyFrom = linkKey => Buffer.from(crypto.hkdfSync('sha256', linkKey, Buffer.alloc(0), Buffer.from('t-agent mindmap-sync v1'), 32));
const int = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

// The settings sync's envelope (services/settings-sync.js) with room for a large map.
function seal(key, payload, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { v: 1, alg: 'A256GCM', iv: iv.toString('base64url'), data: data.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}
function open(key, envelope, aad) {
  const broken = () => fault('MINDMAP_SYNC_DECRYPT_FAILED', 400);
  if (!envelope || typeof envelope !== 'object' || envelope.v !== 1 || envelope.alg !== 'A256GCM') throw broken();
  const { iv, data, tag } = envelope;
  if (![iv, data, tag].every(part => typeof part === 'string' && B64URL.test(part))) throw broken();
  if (data.length > MAX_ENVELOPE_CHARS) throw fault('MINDMAP_SYNC_TOO_LARGE', 413);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8'));
    if (!isPlainObject(value)) throw Error();
    return value;
  } catch { throw broken(); }
}

const homeOffline = name => new MindmapError(503, 'MINDMAP_HOME_OFFLINE', `This map is kept on ${name || 'a normal computer'}, which can't be reached right now`);

function createMindmapSync(options) {
  const {
    db, service, serviceLinks = null, request = null,
    identity, // () => { instance_id, name }
    linkKeys, // { publicKey(), linkKey(peer, publicKey) }: the settings sync's key pair and link keys
    tier = { isCompany: () => false },
    enabled = () => true,
    now = Date.now, log = console,
    intervalMs = SYNC_INTERVAL_MS, debounceMs = DEBOUNCE_MS, maxWaitMs = MAX_WAIT_MS, companyDebounceMs = COMPANY_DEBOUNCE_MS, timeoutMs = REQUEST_TIMEOUT_MS,
    pageBytes = PAGE_BYTES, readWaitMs = READ_WAIT_MS, cacheDays = CACHE_DAYS, retryMs = RETRY_MS,
  } = options;
  const me = () => identity().instance_id;
  const company = () => Boolean(tier.isCompany());

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
  // A company computer with a normal machine to keep the maps on: a cache here. Otherwise the maps stay here.
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
  const homeLink = () => normalPeers().find(peer => peer.online) || null;
  // What the home has of this company computer's changes (entries up to that number have been handed over).
  const handedOver = () => {
    const home = homeLink() || normalPeers()[0];
    return home ? int(peerState(home.id).acked) : 0;
  };

  function mapKey(peer, publicKey) {
    if (typeof publicKey !== 'string' || !PUBLIC_KEY.test(publicKey)) throw fault('MINDMAP_SYNC_BAD_KEY', 400);
    return mapKeyFrom(linkKeys.linkKey(peer, publicKey));
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
    if (typeof given.public_key !== 'string' || !PUBLIC_KEY.test(given.public_key)) throw fault('MINDMAP_SYNC_BAD_KEY', 400);
    if (typeof given.instance_id !== 'string' || !INSTANCE_ID.test(given.instance_id)) throw fault('INVALID_MINDMAP_SYNC', 400);
    if (link.peer_instance_id && link.peer_instance_id !== given.instance_id) throw fault('INVALID_MINDMAP_SYNC', 400);
    return given;
  }
  const haveOf = (state, instanceId) => (isPlainObject(state.have) && state.have.instance_id === instanceId ? int(state.have.seq) : 0);
  const refuseOnCompany = () => { if (company()) throw fault('MINDMAP_COMPANY_COMPUTER', 409); };

  // GET /v1/mindmap-sync
  function engineDescribe(link) {
    const peer = requirePeer(link);
    const state = peerState(peer.id);
    return {
      instance_id: me(), public_key: linkKeys.publicKey(), company: company(), max_seq: service.maxSeq(),
      have: haveOf(state, link.peer_instance_id || state.instance_id || (isPlainObject(state.have) ? state.have.instance_id : '')),
    };
  }
  // POST /v1/mindmap-sync/pull { instance_id, public_key, after, max_bytes } -> a page of entries; { ..., ids } -> those entries; { ..., list: true }
  // -> the summaries of every map (what a company computer lists through its home).
  async function enginePull(link, body) {
    const peer = requirePeer(link);
    refuseOnCompany();
    const given = checkSender(link, body);
    const key = mapKey(peer, given.public_key);
    let payload;
    if (given.list === true) payload = { summaries: await service.exportSummaries() };
    else if (Array.isArray(given.ids)) payload = await service.exportIds(given.ids.slice(0, 100));
    else payload = await service.exportPage(int(given.after), { maxBytes: Math.min(MAX_PAGE_BYTES, Math.max(64 * 1024, int(given.max_bytes) || pageBytes)) });
    return { instance_id: me(), sealed: seal(key, payload, aadOf('pull', me(), link.id)) };
  }
  // PUT /v1/mindmap-sync { instance_id, public_key, sealed }: the peer's entries after `after` (inside the envelope). Answers how far this device has them.
  async function enginePush(link, body) {
    const peer = requirePeer(link);
    refuseOnCompany();
    const given = checkSender(link, body);
    const key = mapKey(peer, given.public_key);
    const payload = open(key, given.sealed, aadOf('push', given.instance_id, link.id));
    const list = name => (Array.isArray(payload[name]) ? payload[name] : []);
    if (list('maps').length + list('tombstones').length > PAGE_ROWS * 4) throw fault('MINDMAP_SYNC_TOO_LARGE', 413);
    const { applied } = await service.applyEntries([...list('maps'), ...list('tombstones')]);
    const had = haveOf(peerState(peer.id), given.instance_id);
    const have = int(payload.after) <= had ? Math.max(had, int(payload.next)) : had;
    updatePeer(peer.id, () => ({ supported: true, instance_id: given.instance_id, have: { seq: have, instance_id: given.instance_id } }));
    if (applied) fanOut();
    return { applied, have };
  }

  // ---- Failures in the log (once per reason, once when it works again, codes only) ----
  const reported = new Map();
  function report(key, what, error = null) {
    const reason = error ? errorCode(error) : null;
    const before = reported.get(key) || null;
    if (reason === before) return;
    if (reason) { reported.set(key, reason); log.warn(`[mindmap-sync] ${what} failed: ${reason}`); } else {
      reported.delete(key);
      (log.info || log.warn).call(log, `[mindmap-sync] ${what} works again (it failed with ${before})`);
    }
  }

  // ---- Rounds ----
  const running = new Map();
  const again = new Set();
  let fullSerial = 0;
  const fullAt = new Map();
  const call = (peer, route, opts = {}) => request(peer.baseUrl, route, peer.token, { timeoutMs, maxBytes: MAX_ANSWER_BYTES, ...opts });

  // The peer's description after its /v1/info: null when it is skipped (an older version, a company computer, not this company computer's home).
  async function describePeer(peer) {
    const info = await call(peer, '/v1/info');
    const supported = Boolean(info && Array.isArray(info.capabilities) && info.capabilities.includes(CAPABILITY));
    const peerCompany = Boolean(info && info.company_computer === true);
    updatePeer(peer.id, () => ({ supported, company: peerCompany }));
    if (!supported || peerCompany) return null;
    if (company() && (!homePeer() || homePeer().id !== peer.id)) return null;
    const theirs = await call(peer, ROUTE);
    if (!theirs || typeof theirs.instance_id !== 'string' || !INSTANCE_ID.test(theirs.instance_id)) throw fault('MINDMAP_SYNC_BAD_ANSWER', 502);
    if (theirs.company) { updatePeer(peer.id, () => ({ company: true })); return null; }
    return { ...theirs, key: mapKey(peer, theirs.public_key) };
  }

  async function pushTo(peer, theirs) {
    const self = me();
    let sent = int(theirs.have);
    if (sent > service.maxSeq()) sent = 0; // the peer had more of ours than we have (this folder was restored): from the start
    for (let pages = 0; sent < service.maxSeq() && pages < MAX_PAGES_PER_ROUND; pages += 1) {
      const page = await service.exportPage(sent, { maxBytes: pageBytes });
      const answer = await call(peer, ROUTE, { method: 'PUT', body: { instance_id: self, public_key: linkKeys.publicKey(), sealed: seal(theirs.key, page, aadOf('push', self, peer.id)) } });
      const have = int(answer && answer.have);
      if (have <= sent) break;
      sent = have;
      if (!page.more) break;
    }
    return sent;
  }

  // A failed round is tried again once after `retryMs` (a change made meanwhile would otherwise wait for the 5 minute round).
  const retries = new Map();
  function retryLater(peer) {
    if (!started || retryMs <= 0 || retries.has(peer.id)) return;
    const timer = setTimeout(() => {
      retries.delete(peer.id);
      const current = onlinePeers().find(candidate => candidate.id === peer.id);
      if (started && current) syncPeer(current);
    }, retryMs);
    if (timer.unref) timer.unref();
    retries.set(peer.id, timer);
  }

  async function round(peer) {
    let applied = 0;
    try {
      const theirs = await describePeer(peer);
      if (!theirs) { report(peer.id, `sync with ${peer.name}`); return 0; }
      const handing = company();
      const theirMax = int(theirs.max_seq);
      // Pull (normal machines only): the peer's entries after what this device has of them.
      if (!handing) {
        let after = haveOf(peerState(peer.id), theirs.instance_id);
        if (after > theirMax) after = 0; // the peer's folder is older than what we had (restored): from the start
        for (let pages = 0; after < theirMax && pages < MAX_PAGES_PER_ROUND; pages += 1) {
          const answer = await call(peer, `${ROUTE}/pull`, { method: 'POST', body: { instance_id: me(), public_key: linkKeys.publicKey(), after, max_bytes: pageBytes } });
          const payload = open(theirs.key, answer && answer.sealed, aadOf('pull', theirs.instance_id, peer.id));
          const list = name => (Array.isArray(payload[name]) ? payload[name] : []);
          applied += (await service.applyEntries([...list('maps'), ...list('tombstones')])).applied;
          const next = int(payload.next);
          if (next <= after) break;
          after = next;
          updatePeer(peer.id, () => ({ instance_id: theirs.instance_id, have: { seq: after, instance_id: theirs.instance_id } }));
          if (!payload.more) break;
        }
      }
      // Push: this device's entries after what the peer has of them.
      const sent = await pushTo(peer, theirs);
      if (handing) {
        updatePeer(peer.id, () => ({ acked: sent }));
        writeState(db, HOME_KEY, { link_id: peer.id, name: peer.name, at: now() });
        await evict(sent);
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
      retryLater(peer);
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

  // ---- Company computer: the cache ----
  // What the home has of this machine's changes leaves the cache unless the map was opened (or changed) here in the last `cacheDays` days.
  // Tombstones the home has go at once.
  async function evict(acked) {
    if (!handsOver()) return 0;
    const oldest = now() - cacheDays * DAY;
    const drop = [];
    for (const entry of await service.localEntries()) {
      if (entry.seq > acked) continue;
      if (entry.kind === 'tomb') { drop.push(entry.id); continue; }
      const edited = Date.parse(entry.summary.updated_at) || 0;
      if (Math.max(entry.opened_at, edited) < oldest) drop.push(entry.id);
    }
    return drop.length ? service.forget(drop) : 0;
  }

  // Waits for a promise at most `readWaitMs` (a slow home must not hold the page): false when it took longer.
  async function bounded(work) {
    let timer;
    const wait = new Promise(resolve => { timer = setTimeout(() => resolve(false), readWaitMs); if (timer.unref) timer.unref(); });
    try { return await Promise.race([work.then(() => true, () => false), wait]); } finally { clearTimeout(timer); }
  }

  // Asks the home for something (sealed), or null when it cannot be reached.
  async function askHome(body) {
    const home = homePeer();
    if (!home || !request) return null;
    try {
      const theirs = await describePeer(home);
      if (!theirs) return null;
      const answer = await call(home, `${ROUTE}/pull`, { method: 'POST', body: { instance_id: me(), public_key: linkKeys.publicKey(), ...body } });
      return open(theirs.key, answer && answer.sealed, aadOf('pull', theirs.instance_id, home.id));
    } catch (error) {
      report(home.id, `reading from ${home.name}`, error);
      return null;
    }
  }

  // A company computer brings some maps up to date from its home: its own waiting changes go first, then the home's entries of those ids replace
  // the cache (a map the home no longer has leaves the cache, unless a change of it waits here). True when the home answered.
  async function refreshIds(ids) {
    const home = homePeer();
    if (!home) return false;
    await bounded(syncPeer(home));
    let answer = null;
    const done = await bounded((async () => { answer = await askHome({ ids }); })());
    if (!done || !answer) return false;
    const acked = handedOver();
    await service.applyEntries([...(answer.maps || []), ...(answer.tombstones || [])], { cacheOnly: true, handedOver: acked });
    const missing = new Set(Array.isArray(answer.missing) ? answer.missing : []);
    if (missing.size) {
      const local = await service.localEntries();
      await service.forget(local.filter(entry => missing.has(entry.id) && entry.seq <= acked).map(entry => entry.id));
    }
    return true;
  }

  // ---- The page (/api/mindmaps; routes/mindmap.js) ----
  // Where the maps are, for the page: { enabled, company_computer, cache_only, home_name, home_online, waiting, engines, older }.
  // `engines`: the engines that keep this set (this one and the normal linked ones that sync), by instance id and name; `older`: the instance ids of
  // linked engines without the sync, whose maps the page still lists from them.
  async function where() {
    const handing = handsOver();
    const states = readPeers();
    const self = identity();
    let waiting = 0;
    if (handing) {
      const acked = handedOver();
      waiting = (await service.localEntries()).filter(entry => entry.seq > acked).length;
    }
    return {
      enabled: Boolean(enabled()),
      company_computer: company(),
      cache_only: handing,
      home_name: handing ? homeName() : null,
      home_online: handing ? Boolean(homePeer()) : null,
      waiting,
      engines: enabled() ? [{ instance_id: self.instance_id, name: self.name || '' }, ...normalPeers().map(peer => ({ instance_id: peer.instanceId || null, name: peer.name }))] : [],
      older: enabled() ? livePeers().filter(peer => states[peer.id] && states[peer.id].supported === false && peer.instanceId).map(peer => peer.instanceId) : [],
    };
  }

  // The list: this engine's copy; on a company computer the home's list (with the changes waiting here), or the cache while the home is away.
  async function pageList() {
    if (!handsOver()) return { maps: await service.list(), sync: await where() };
    let answer = null;
    if (homePeer()) {
      await bounded(syncPeer(homePeer()));
      await bounded((async () => { answer = await askHome({ list: true }); })());
    }
    const local = await service.list();
    if (!answer || !Array.isArray(answer.summaries)) return { maps: local, sync: await where() };
    const acked = handedOver();
    const entries = await service.localEntries();
    const waitingIds = new Set(entries.filter(entry => entry.seq > acked).map(entry => entry.id));
    const deletedHere = new Set(entries.filter(entry => entry.kind === 'tomb' && entry.seq > acked).map(entry => entry.id));
    const theirs = new Map(answer.summaries.filter(row => isPlainObject(row) && typeof row.id === 'string').map(row => [row.id, row]));
    // A cached map the home no longer has, with nothing waiting here: deleted on another engine.
    const gone = entries.filter(entry => entry.kind === 'map' && !theirs.has(entry.id) && !waitingIds.has(entry.id)).map(entry => entry.id);
    if (gone.length) await service.forget(gone);
    const mine = new Map(local.map(row => [row.id, row]));
    const maps = [];
    for (const [id, row] of theirs) {
      if (deletedHere.has(id)) continue;
      const here = mine.get(id);
      const { vv, ...summary } = row;
      maps.push(here && waitingIds.has(id) ? here : { id, title: String(summary.title || ''), revision: int(summary.revision), created_at: summary.created_at, updated_at: summary.updated_at, size: int(summary.size), by: summary.by || null, by_name: summary.by_name || null });
    }
    for (const row of local) if (!theirs.has(row.id) && waitingIds.has(row.id)) maps.push(row);
    maps.sort((a, b) => (a.updated_at === b.updated_at ? String(a.id).localeCompare(String(b.id)) : (a.updated_at < b.updated_at ? 1 : -1)));
    return { maps, sync: await where() };
  }

  // A map the page opens (or asks about): on a company computer read through the home first; a map it does not have and cannot read is 503.
  async function prepareRead(id, { opening = false } = {}) {
    if (!handsOver()) return;
    const fresh = homePeer() ? await refreshIds([id]) : false;
    const here = (await service.localEntries()).find(entry => entry.id === id && entry.kind === 'map');
    if (!here) {
      if (!fresh) throw homeOffline(homeName());
      return;
    }
    if (opening) await service.noteOpened(id);
  }
  const pageGet = async id => { await prepareRead(id, { opening: true }); return service.get(id); };
  const pageHead = async id => { await prepareRead(id); return service.head(id); };
  const pageUpdate = async (id, body) => { await prepareRead(id); return service.update(id, body); };
  const pageRemove = async id => { await prepareRead(id); return service.remove(id); };

  let timer = null;
  let firstWaiting = 0;
  function schedule() {
    if (!started) return;
    if (timer) clearTimeout(timer);
    const at = now();
    if (!firstWaiting) firstWaiting = at;
    const delay = company() ? companyDebounceMs : Math.max(0, Math.min(debounceMs, firstWaiting + maxWaitMs - at));
    timer = setTimeout(() => { timer = null; firstWaiting = 0; syncInBackground(); }, delay);
    if (timer.unref) timer.unref();
  }
  const fanOut = () => { if (started && !company()) schedule(); };

  // ---- Life ----
  let started = false;
  let interval = null;
  const unsubscribe = [];
  function start() {
    if (started) return;
    started = true;
    unsubscribe.push(service.onChanged(() => schedule()));
    unsubscribe.push(require('./device-tier').onTierChange((value, changedDb) => { if (!changedDb || changedDb === db) syncInBackground(); }));
    if (serviceLinks && request) {
      unsubscribe.push(serviceLinks.onChange(id => {
        if (company()) return syncInBackground();
        const peer = onlinePeers().find(candidate => candidate.id === id);
        if (peer) syncPeer(peer);
        return undefined;
      }));
      if (intervalMs > 0) {
        interval = setInterval(() => { void service.purgeTombs().catch(() => {}); syncInBackground(); }, intervalMs);
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
    for (const pending of retries.values()) clearTimeout(pending);
    retries.clear();
  }

  return {
    start, stop, syncAll, syncPeer, where, handsOver, refreshIds, evict,
    pageList, pageGet, pageHead, pageUpdate, pageRemove,
    engineDescribe, enginePull, enginePush, peerStates: readPeers,
  };
}

// Off with SETTINGS_SYNC_ENABLED=false or MINDMAP_SYNC_ENABLED=false (config.mindmapSyncEnabled).
const syncEnabled = () => require('../config').mindmapSyncEnabled !== false;

let singleton = null;
function getMindmapSync() {
  if (singleton) return singleton;
  const db = require('../db');
  const settingsSync = require('./settings-sync').getSettingsSync();
  const identity = () => { const { engine_id: instanceId, name } = require('./engine-identity').getEngineIdentity(); return { instance_id: instanceId, name }; };
  singleton = createMindmapSync({
    db, service: require('./mindmap').getMindmapService(),
    serviceLinks: require('./service-links').getServiceLinks(),
    request: (...args) => require('./remote-client').request(...args),
    identity,
    linkKeys: { publicKey: () => settingsSync.publicKey(), linkKey: (peer, publicKey) => settingsSync.linkKey(peer, publicKey) },
    tier: require('./device-tier').getDeviceTier(),
    enabled: syncEnabled,
  });
  return singleton;
}

module.exports = { createMindmapSync, getMindmapSync, syncEnabled, seal, open, aadOf, mapKeyFrom, CAPABILITY, ROUTE, PEERS_KEY, HOME_KEY, PAGE_BYTES };
