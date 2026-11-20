// When linked engines run different versions ("When engines run different versions" in docs/design/update-check-and-versions.md).
//
// - What is out of step: an engine is "older" when another engine of the set (this one and its online linked engines) runs a newer version. What it
//   lacks are the shared capabilities a newer engine lists in /v1/info and it does not: those are the features that keep something the same between
//   engines (SHARED_CAPABILITIES; a newer engine also sends its own list as `shared_capabilities`, so an older one learns names it does not know yet).
//   The page names the capabilities it knows and leaves the others unnamed.
// - `flag()` is what GET /api/system/update-status carries (`version_skew`): from the cache only, never waiting for a peer; a stale entry is read again
//   in the background. `view()` is GET /api/system/version-skew: every engine with its version, `older` and `missing`.
// - Nudge: when this engine sees an online linked engine on an older version that lists `update:nudge`, it asks that engine once to check for updates
//   now (POST /v1/update/nudge). That only starts the peer's own check: its "Update automatically when idle" switch and its idle rule still decide
//   whether and when it restarts. An engine that updated restarts, its links come back, it reads its peers again and nudges the ones left behind, so
//   they follow within minutes instead of at their next hourly check. An older peer without the capability is skipped.
// - Nothing is stored: the cache and the nudges sent live in memory (a restart reads and nudges again, at most once per peer and version).
const { compareSemver, parseSemver } = require('../lib/version-utils');

const NUDGE_CAPABILITY = 'update:nudge';
const WHEN_IDLE_CAPABILITY = 'update:when-idle';
// The capabilities whose features keep something the same between linked engines. Add a new sync's capability here.
const SHARED_CAPABILITIES = ['settings:sync', 'learn:sync', 'page-state:sync', 'task-order', 'updated-notice', 'notify:relay', 'environment:tools'];
const INFO_TTL_MS = 5 * 60_000;
const PEER_TIMEOUT_MS = 4000;
const NUDGE_GAP_MS = 6 * 60 * 60_000; // one nudge per peer and peer version in this time
const ONLINE_DELAY_MS = 3000; // a link that came up: read it a moment later, when its tunnel has settled
const NUDGE_CHECK_GAP_MS = 60_000; // the receiving side: at most one forced check a minute, however many peers nudge

const validVersion = version => typeof version === 'string' && Boolean(parseSemver(version));
const list = value => (Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.length <= 64) : []);

// The shared capabilities an engine really offers: its own list of shared ones (or ours, for an engine that sends none) that it also lists.
function sharedOf(engine) {
  const shared = Array.isArray(engine.shared) ? engine.shared : SHARED_CAPABILITIES;
  return shared.filter(name => engine.capabilities.includes(name));
}

// Pure: [{ id, instance_id, name, version, self, capabilities, shared }] -> the same engines (valid versions only) with `older` and `missing`, by name.
function compare(engines) {
  const known = engines.filter(engine => validVersion(engine.version));
  const rows = known.map(engine => {
    const newer = known.filter(other => compareSemver(other.version, engine.version) > 0);
    const missing = [...new Set(newer.flatMap(sharedOf))].filter(name => !engine.capabilities.includes(name));
    return { id: engine.id, instance_id: engine.instance_id || null, name: engine.name || '', version: engine.version, self: Boolean(engine.self), older: newer.length > 0, missing };
  });
  const newest = known.reduce((top, engine) => (!top || compareSemver(engine.version, top) > 0 ? engine.version : top), null);
  rows.sort((a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)));
  return { newest, engines: rows };
}

// The flag of the update status: one `<identity>@<version>` per engine that lacks something, so the page reads the details again when it changes.
const signature = engines => engines.filter(engine => engine.missing.length).map(engine => `${engine.instance_id || engine.id}@${engine.version}`).join(',') || null;

function createVersionSkew({
  serviceLinks, readInfo, request, local,
  now = Date.now, log = console, infoTtlMs = INFO_TTL_MS, onlineDelayMs = ONLINE_DELAY_MS,
  schedule = (fn, ms) => { const timer = setTimeout(fn, ms); if (timer.unref) timer.unref(); return timer; },
  cancel = timer => clearTimeout(timer),
}) {
  const cache = new Map(); // link id -> { info, at }
  const nudged = new Map(); // `<link id>|<peer version>` -> time of the nudge
  let refreshing = null;
  let timer = null;
  let stopListening = null;

  const online = () => { try { return serviceLinks.peers().filter(peer => peer.online); } catch { return []; } };
  const self = () => {
    const info = local();
    return { id: 'local', self: true, instance_id: info.instance_id || null, name: info.name || '', version: info.version, capabilities: list(info.capabilities), shared: SHARED_CAPABILITIES };
  };
  const engineOf = (peer, info) => ({
    id: peer.id, instance_id: info.instance_id || info.engine_id || peer.instanceId || null, name: peer.name || info.name || '',
    version: info.engine_version || info.app_version || null, capabilities: list(info.capabilities),
    shared: Array.isArray(info.shared_capabilities) ? list(info.shared_capabilities) : null,
  });

  async function nudge(peer, engine) {
    const mine = self().version;
    if (!validVersion(mine) || !validVersion(engine.version) || compareSemver(engine.version, mine) >= 0) return false;
    if (!engine.capabilities.includes(NUDGE_CAPABILITY)) return false; // an older peer that cannot be asked
    const key = `${peer.id}|${engine.version}`;
    const last = nudged.get(key);
    if (last !== undefined && now() - last < NUDGE_GAP_MS) return false;
    nudged.set(key, now());
    try {
      await request(peer.baseUrl, '/v1/update/nudge', peer.token, { method: 'POST', body: {}, timeoutMs: PEER_TIMEOUT_MS });
      log.log(`[version-skew] asked ${peer.name || peer.id} (v${engine.version}) to check for updates`);
      return true;
    } catch (error) {
      nudged.delete(key); // asked again at the next read
      log.warn(`[version-skew] ${peer.name || peer.id}: ${/^[A-Z0-9_]{1,64}$/.test((error && error.message) || '') ? error.message : 'REQUEST_FAILED'}`);
      return false;
    }
  }

  async function readPeer(peer) {
    try {
      const info = await readInfo(peer, { timeoutMs: PEER_TIMEOUT_MS });
      if (!info || typeof info !== 'object') throw new Error('INVALID_INFO');
      cache.set(peer.id, { info, at: now() });
      await nudge(peer, engineOf(peer, info));
    } catch {
      cache.delete(peer.id); // an engine that does not answer is not compared
    }
  }

  // Reads the online peers whose entry is stale (all of them with `force`). One round at a time.
  function refresh({ force = false } = {}) {
    if (refreshing) return refreshing;
    const due = online().filter(peer => {
      const entry = cache.get(peer.id);
      return force || !entry || now() - entry.at >= infoTtlMs;
    });
    if (!due.length) return Promise.resolve();
    refreshing = Promise.all(due.map(readPeer)).then(() => {}).finally(() => { refreshing = null; });
    return refreshing;
  }

  function snapshot() {
    const peers = online().flatMap(peer => {
      const entry = cache.get(peer.id);
      return entry ? [engineOf(peer, entry.info)] : [];
    });
    return compare([self(), ...peers]);
  }

  function flag() {
    void refresh().catch(() => {});
    try { return signature(snapshot().engines); } catch { return null; }
  }

  async function view() {
    await refresh();
    return snapshot();
  }

  function soon() {
    if (timer) cancel(timer);
    timer = schedule(() => { timer = null; void refresh().catch(() => {}); }, onlineDelayMs);
  }

  // A link that changes (comes up, goes away, is added or removed) is forgotten and the peers are read again a moment later.
  function start() {
    if (stopListening) return;
    stopListening = serviceLinks.onChange(id => { cache.delete(id); soon(); });
    soon();
  }

  function stop() {
    if (stopListening) stopListening();
    stopListening = null;
    if (timer) cancel(timer);
    timer = null;
  }

  return { refresh, snapshot, flag, view, start, stop, nudge };
}

// The receiving side of a nudge: a forced check, at most once a minute; the automatic update follows the check by itself.
function createNudgeReceiver({ check, now = Date.now, gapMs = NUDGE_CHECK_GAP_MS }) {
  let last = null;
  return function receive() {
    if (last !== null && now() - last < gapMs) return { accepted: true, checking: false };
    last = now();
    Promise.resolve().then(() => check()).catch(() => { /* the state says what went wrong; the hourly check tries again */ });
    return { accepted: true, checking: true };
  };
}

let singleton = null;
function getVersionSkew() {
  if (singleton) return singleton;
  singleton = createVersionSkew({
    serviceLinks: require('./service-links').getServiceLinks(),
    readInfo: (peer, options) => require('./remote-info').readRemoteInfo({ baseUrl: peer.baseUrl, token: peer.token, serverId: peer.remoteServerId }, options),
    request: (...args) => require('./remote-client').request(...args),
    local: () => {
      const info = require('../routes/engine-v1').localInfo();
      return { instance_id: info.instance_id || info.engine_id, name: info.name, version: info.engine_version, capabilities: info.capabilities };
    },
  });
  return singleton;
}

module.exports = {
  createVersionSkew, createNudgeReceiver, getVersionSkew, compare, signature,
  SHARED_CAPABILITIES, NUDGE_CAPABILITY, WHEN_IDLE_CAPABILITY, INFO_TTL_MS, NUDGE_GAP_MS, NUDGE_CHECK_GAP_MS,
};
