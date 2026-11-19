// The shared page state: what the page remembers about the person (the recent sessions, the chosen tabs, the columns, collapsed groups, ...), kept
// on the server per owner and the same on every engine joined by service links, company computers included. See docs/design/shared-page-state.md.
//
// - Store: system_state `page_state_v1:<owner>` { state, clock }; the merge rules are services/page-state-merge.js (per entry and per key, the later
//   version wins; deletes are tombstones). `clock` is a hybrid clock: a change takes max(now, newest seen + 1), and every time read from a peer moves it.
// - Page: read() and change(body) (routes/page-state.js, /api/page-state). A change is stamped here, merged, stored and pushed to the peers 200 ms
//   later (debounced, so a burst of changes is one round). Every answer has `version` (the stored clock, raised by every save), so a page can tell an
//   older answer from a newer one.
// - Live pages: follow(owner, listener) gives an open page of this engine the new answer 50 ms after any save (a change from a page, a merge from a
//   peer), "The page push" in docs/design/shared-page-state.md; routes/tasks.js sends it on the page's activity stream (`event: page-state`).
// - Peers: one small document, so a round exchanges it whole. GET /v1/info must list `page-state:sync` (an older peer is skipped);
//   GET /v1/page-state?public_key= gives the peer's digest (an HMAC of its state under the link's key); equal digests end the round; else the
//   peer's state is pulled (POST /v1/page-state/pull), merged here, and the merged state is sent (PUT /v1/page-state) when it still differs. A side
//   that changed by a merge starts a round with its other peers (fan-out), so a chain A–B–C reaches C, and an echo stops at the digest check.
// - Rounds also run at start, when a link comes online and every 5 minutes. The state travels only inside the settings sync's AES-256-GCM
//   envelopes, with a key derived from that link's settings-sync key and its own additional data.
// - Per-task visibility (services/task-visibility.js): the entries of this engine's tasks that a link may not see are left out of what that link
//   gets (and of the digest made for it).
const crypto = require('crypto');
const merge = require('./page-state-merge');
const { seal, open } = require('./settings-sync');
const { readState, writeState, isPlainObject } = require('./settings-sync-store');

const CAPABILITY = 'page-state:sync';
const ROUTE = '/v1/page-state';
const PEERS_KEY = 'page_state_peers_v1';
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const DEBOUNCE_MS = 200; // a page change reaches the linked engines' pages in about a second (the page waits 800 ms, then this, then one round)
const INFO_TTL_MS = 5 * 60 * 1000; // a round after a change skips /v1/info when it listed the capability this recently (a full round always asks)
const FOLLOW_MS = 50; // a burst of saves is one push to the pages
const PUSH_MAX = 256 * 1024; // a larger state is announced as { read: true } and the page reads it
const REQUEST_TIMEOUT_MS = 15_000;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;

const fault = (code, statusCode = 400) => Object.assign(new Error(code), { statusCode });
const errorCode = error => (error && /^[A-Z0-9_]{1,64}$/.test(error.message || '') ? error.message : 'PAGE_STATE_SYNC_FAILED');
const aadOf = (direction, sender, linkId) => Buffer.from(`t-agent page-state v1|${direction}|${sender}|${linkId}`);
const pageKeyFrom = linkKey => Buffer.from(crypto.hkdfSync('sha256', linkKey, Buffer.alloc(0), Buffer.from('t-agent page-state v1'), 32));
const stateKey = owner => `page_state_v1:${owner}`;

function createPageState(options) {
  const {
    db, serviceLinks = null, request = null,
    identity, // () => { instance_id, name }
    owner = () => require('./single-user').ensureSingleUser().login,
    linkKeys = null, // { publicKey(), linkKey(peer, publicKey) }: the settings sync's key pair and link keys
    enabled = () => true,
    visibility = () => require('./task-visibility').getTaskVisibility(), // { isDenied(taskId, linkId) }
    now = Date.now, log = console,
    intervalMs = SYNC_INTERVAL_MS, debounceMs = DEBOUNCE_MS, timeoutMs = REQUEST_TIMEOUT_MS, infoTtlMs = INFO_TTL_MS, followMs = FOLLOW_MS,
  } = options;
  const me = () => identity().instance_id;
  const listeners = new Set();

  // ---- Stored state ----
  function load(name) {
    const row = readState(db, stateKey(name));
    const state = merge.cleanState(row && row.state);
    const clock = row && Number.isSafeInteger(row.clock) ? row.clock : 0;
    return { state, clock: Math.max(clock, merge.newestAt(state)) };
  }
  function save(name, state, clock) {
    writeState(db, stateKey(name), { state, clock: Math.max(clock, merge.newestAt(state)) });
    for (const listener of listeners) { try { listener(name); } catch { /* a listener never stops a save */ } }
  }
  // The state as one link may get it: without the entries of this engine's tasks that the link may not see.
  function stateFor(linkId, state) {
    let rules = null;
    try { rules = visibility(); } catch { rules = null; }
    if (!rules || typeof rules.isDenied !== 'function') return state;
    const self = me();
    const recent = {};
    for (const [id, entry] of Object.entries(state.recent)) {
      let denied = false;
      try { denied = entry.instance === self && rules.isDenied(Number(entry.task), linkId); } catch { denied = false; }
      if (!denied) recent[id] = entry;
    }
    return { recent, keys: state.keys };
  }
  const digestOf = (key, state) => crypto.createHmac('sha256', key).update(merge.stableJson(state)).digest('hex').slice(0, 32);

  // ---- The page ----
  // { instance_id, version, recent, keys }: what the page reads (pageView in page-state-merge.js), with this engine's own instance id and the
  // version of the stored state (its clock, which every save raises).
  const viewOf = ({ state, clock }) => ({ instance_id: me(), version: clock, ...merge.pageView(state) });
  function read(name) {
    return viewOf(load(name));
  }
  // A change from the page (`changeState` in page-state-merge.js), stamped now. Answers the new view.
  function change(name, body) {
    const { state, clock } = load(name);
    const at = Math.max(now(), clock + 1);
    const result = merge.merge(state, merge.changeState(body, { at, by: me() }), now());
    if (!result.changed) return viewOf({ state, clock });
    save(name, result.state, at);
    schedule();
    return viewOf({ state: result.state, clock: Math.max(at, merge.newestAt(result.state)) });
  }
  // Merges a state from a peer; true when something changed here.
  function absorb(incoming) {
    const name = owner();
    const { state, clock } = load(name);
    const theirs = merge.cleanState(incoming);
    const result = merge.merge(state, theirs, now());
    if (!result.changed) return false;
    save(name, result.state, Math.max(clock + 1, merge.newestAt(theirs)));
    return true;
  }
  // An open page follows the state (routes/tasks.js, the page's activity stream): `listener(text)` gets the JSON of the page's answer (as GET
  // /api/page-state: the view, its version and the peers) followMs after a save of `name`'s state, a burst of saves being one call; a state larger
  // than PUSH_MAX is announced as {"read":true} and the page reads it. Any later key of the state rides on it as it is. Returns the stop function.
  function follow(name, listener) {
    let wait = null;
    const off = onChange(changed => {
      if (changed !== name || wait) return;
      wait = setTimeout(() => {
        wait = null;
        let text;
        try { text = JSON.stringify({ ...read(name), peers: peers() }); } catch { return; }
        try { listener(text.length > PUSH_MAX ? '{"read":true}' : text); } catch { /* a closed stream */ }
      }, followMs);
      if (wait.unref) wait.unref();
    });
    return () => { off(); clearTimeout(wait); wait = null; };
  }

  // ---- Peers ----
  function readPeers() {
    const value = readState(db, PEERS_KEY);
    return isPlainObject(value) ? value : {};
  }
  function updatePeer(id, change) {
    const peers = readPeers();
    peers[id] = { ...(isPlainObject(peers[id]) ? peers[id] : {}), ...change };
    const live = new Set(livePeers().map(peer => peer.id));
    if (serviceLinks) for (const key of Object.keys(peers)) if (!live.has(key)) delete peers[key];
    writeState(db, PEERS_KEY, peers);
  }
  const livePeers = () => {
    if (!serviceLinks) return [];
    try { return serviceLinks.peers(); } catch { return []; }
  };
  const onlinePeers = () => livePeers().filter(peer => peer.online);
  // The linked engines and whether this state reaches them now: [{ name, online, supported, last_sync_at }] (supported: null until first asked).
  function peers() {
    const states = readPeers();
    return livePeers().map(peer => {
      const state = isPlainObject(states[peer.id]) ? states[peer.id] : {};
      return { name: peer.name, online: Boolean(peer.online), supported: typeof state.supported === 'boolean' ? state.supported : null, last_sync_at: state.last_sync_at || null };
    });
  }
  function pageKey(peer, publicKey) {
    if (typeof publicKey !== 'string' || !PUBLIC_KEY.test(publicKey)) throw fault('PAGE_STATE_BAD_KEY', 400);
    return pageKeyFrom(linkKeys.linkKey(peer, publicKey));
  }

  // ---- Engine side (link tokens only; routes/page-state.js checks the token) ----
  const peerForLink = link => livePeers().find(peer => peer.id === link.id) || null;
  function requirePeer(link) {
    if (!enabled() || !linkKeys) throw fault('NOT_FOUND', 404);
    const peer = peerForLink(link);
    if (!peer) throw fault('LINKED_ONLY', 403);
    return peer;
  }
  function checkSender(link, body) {
    const given = isPlainObject(body) ? body : {};
    if (typeof given.public_key !== 'string' || !PUBLIC_KEY.test(given.public_key)) throw fault('PAGE_STATE_BAD_KEY', 400);
    if (typeof given.instance_id !== 'string' || !merge.INSTANCE.test(given.instance_id)) throw fault('INVALID_PAGE_STATE', 400);
    if (link.peer_instance_id && link.peer_instance_id !== given.instance_id) throw fault('INVALID_PAGE_STATE', 400);
    return given;
  }
  // GET /v1/page-state?public_key=: { instance_id, public_key, digest } (digest null without a valid key).
  function engineDescribe(link, publicKey) {
    const peer = requirePeer(link);
    let digest = null;
    try { digest = publicKey ? digestOf(pageKey(peer, publicKey), stateFor(link.id, load(owner()).state)) : null; } catch { digest = null; }
    return { instance_id: me(), public_key: linkKeys.publicKey(), digest };
  }
  // POST /v1/page-state/pull { instance_id, public_key } -> { instance_id, sealed }: the whole state.
  function enginePull(link, body) {
    const peer = requirePeer(link);
    const given = checkSender(link, body);
    const key = pageKey(peer, given.public_key);
    return { instance_id: me(), sealed: seal(key, { state: stateFor(link.id, load(owner()).state) }, aadOf('pull', me(), link.id)) };
  }
  // PUT /v1/page-state { instance_id, public_key, sealed } -> { changed }: the peer's state merged here.
  function enginePush(link, body) {
    const peer = requirePeer(link);
    const given = checkSender(link, body);
    const payload = open(pageKey(peer, given.public_key), given.sealed, aadOf('push', given.instance_id, link.id));
    const changed = absorb(payload.state);
    updatePeer(peer.id, { supported: true, instance_id: given.instance_id });
    if (changed) fanOut();
    return { changed };
  }

  // ---- Failures in the log (once per link and reason, once when it works again, codes only) ----
  const reported = new Map();
  function report(key, what, error = null) {
    const reason = error ? errorCode(error) : null;
    const before = reported.get(key) || null;
    if (reason === before) return;
    if (reason) { reported.set(key, reason); log.warn(`[page-state] ${what} failed: ${reason}`); } else {
      reported.delete(key);
      (log.info || log.warn).call(log, `[page-state] ${what} works again (it failed with ${before})`);
    }
  }

  // ---- Rounds ----
  // One round with one peer; true when it changed this side. `fresh` false (the push after a change): /v1/info is skipped when it listed the
  // capability within infoTtlMs (one request less on the way to the other engine's pages); any failure forgets that.
  const listedAt = new Map(); // peer id -> when /v1/info last listed the capability
  async function round(peer, fresh = true) {
    const call = (route, opts = {}) => request(peer.baseUrl, route, peer.token, { timeoutMs, ...opts });
    let changed = false;
    try {
      const seen = listedAt.get(peer.id);
      if (fresh || seen === undefined || now() - seen >= infoTtlMs) {
        listedAt.delete(peer.id);
        const info = await call('/v1/info');
        const supported = Boolean(info && Array.isArray(info.capabilities) && info.capabilities.includes(CAPABILITY));
        updatePeer(peer.id, { supported });
        if (!supported) { report(peer.id, `sync with ${peer.name}`); return false; }
        listedAt.set(peer.id, now());
      }
      const mine = linkKeys.publicKey();
      const theirs = await call(`${ROUTE}?public_key=${encodeURIComponent(mine)}`);
      if (!theirs || typeof theirs.instance_id !== 'string' || !merge.INSTANCE.test(theirs.instance_id)) throw fault('PAGE_STATE_BAD_ANSWER', 502);
      const key = pageKey(peer, theirs.public_key);
      const self = me();
      if (theirs.digest !== digestOf(key, stateFor(peer.id, load(owner()).state))) {
        const answer = await call(`${ROUTE}/pull`, { method: 'POST', body: { instance_id: self, public_key: mine } });
        const payload = open(key, answer && answer.sealed, aadOf('pull', theirs.instance_id, peer.id));
        changed = absorb(payload.state);
        const merged = stateFor(peer.id, load(owner()).state);
        if (digestOf(key, merge.cleanState(payload.state)) !== digestOf(key, merged)) {
          await call(ROUTE, { method: 'PUT', body: { instance_id: self, public_key: mine, sealed: seal(key, { state: merged }, aadOf('push', self, peer.id)) } });
        }
      }
      updatePeer(peer.id, { instance_id: theirs.instance_id, last_sync_at: new Date(now()).toISOString(), last_error: null });
      report(peer.id, `sync with ${peer.name}`);
    } catch (error) {
      listedAt.delete(peer.id);
      if (error && error.statusCode === 401 && serviceLinks && typeof serviceLinks.noteUnauthorized === 'function') {
        try { serviceLinks.noteUnauthorized(peer.remoteServerId); } catch { /* the next call tries again */ }
      }
      report(peer.id, `sync with ${peer.name}`, error);
      try { updatePeer(peer.id, { last_error: errorCode(error) }); } catch { /* logged above */ }
    }
    return changed;
  }

  const running = new Map();
  const again = new Map(); // peer id -> whether a round asked meanwhile was a fresh one
  function syncPeer(peer, fresh = true) {
    if (running.has(peer.id)) { again.set(peer.id, Boolean(again.get(peer.id)) || fresh); return running.get(peer.id); }
    const work = (async () => {
      let changed = false;
      let full = fresh;
      for (;;) {
        const current = onlinePeers().find(candidate => candidate.id === peer.id) || peer;
        changed = (await round(current, full)) || changed;
        if (!again.has(peer.id)) break;
        full = again.get(peer.id);
        again.delete(peer.id);
      }
      return changed;
    })().catch(error => { report(peer.id, `sync with ${peer.name}`, error); return false; }).finally(() => running.delete(peer.id));
    running.set(peer.id, work);
    return work;
  }
  async function syncAll({ fresh = true } = {}) {
    if (!enabled() || !request || !linkKeys) return;
    const results = await Promise.all(onlinePeers().map(peer => syncPeer(peer, fresh)));
    if (results.some(Boolean)) fanOut();
  }
  const syncInBackground = (fresh = true) => syncAll({ fresh }).then(() => report('rounds', 'a sync round'), error => report('rounds', 'a sync round', error)).catch(() => {});

  let timer = null;
  let started = false;
  function schedule() {
    if (!started) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; syncInBackground(false); }, debounceMs);
    if (timer.unref) timer.unref();
  }
  const fanOut = schedule;

  // ---- Life ----
  let interval = null;
  const unsubscribe = [];
  function start() {
    if (started) return;
    started = true;
    if (!serviceLinks || !request) return;
    unsubscribe.push(serviceLinks.onChange(id => {
      const peer = onlinePeers().find(candidate => candidate.id === id);
      if (peer) syncPeer(peer).then(changed => { if (changed) fanOut(); });
    }));
    if (intervalMs > 0) {
      interval = setInterval(() => syncInBackground(true), intervalMs);
      if (interval.unref) interval.unref();
    }
    setImmediate(() => syncInBackground(true));
  }
  function stop() {
    started = false;
    while (unsubscribe.length) unsubscribe.pop()();
    if (interval) clearInterval(interval);
    interval = null;
    if (timer) clearTimeout(timer);
    timer = null;
  }
  const onChange = listener => { listeners.add(listener); return () => listeners.delete(listener); };

  return { start, stop, read, change, follow, peers, syncAll, syncPeer, engineDescribe, enginePull, enginePush, peerStates: readPeers, onChange };
}

// Off with SETTINGS_SYNC_ENABLED=false (it uses the settings sync's link keys): then the page state stays on this engine.
const syncEnabled = () => require('../config').settingsSyncEnabled !== false;

let singleton = null;
function getPageState() {
  if (singleton) return singleton;
  const db = require('../db');
  const settingsSync = require('./settings-sync').getSettingsSync();
  singleton = createPageState({
    db, serviceLinks: require('./service-links').getServiceLinks(),
    request: (...args) => require('./remote-client').request(...args),
    identity: () => { const { engine_id: instanceId, name } = require('./engine-identity').getEngineIdentity(); return { instance_id: instanceId, name }; },
    linkKeys: { publicKey: () => settingsSync.publicKey(), linkKey: (peer, publicKey) => settingsSync.linkKey(peer, publicKey) },
    enabled: syncEnabled,
  });
  return singleton;
}

module.exports = { createPageState, getPageState, syncEnabled, aadOf, pageKeyFrom, CAPABILITY, ROUTE, PEERS_KEY, PUSH_MAX, stateKey };
