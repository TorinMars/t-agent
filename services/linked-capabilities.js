// Translation, voice input and OSS upload for a service that has none of its own: the call goes to a linked service that does, and no key is copied.
// Local configuration always wins, and a real failure of a configured local service never moves to a peer. See "Service links" in DESIGN.md.
const FEATURES = ['translate', 'speech', 'oss'];
const CAPABILITY = 'linked-services';
const ROUTE_BASE = '/v1/linked-services';
const CACHE_MS = 60_000;
const RETRY_MS = 10_000; // a peer that did not answer is asked again sooner than one that did
const PROBE_TIMEOUT_MS = 3_000;
// On top of the time the peer may spend on its own upstream call, so that a peer reporting its own timeout is heard instead of being called offline.
const TIMEOUT_MARGIN_MS = 5_000;
const UPLOAD_POLICY_TIMEOUT_MS = 10_000; // signed on the peer, with no upstream call
const TRANSLATION_MAX_BYTES = 16 * 1024 * 1024; // the local call has no limit, and the default of remote-client.js is meant for smaller answers
// What the link answers about itself, not the peer's service: the token, its rights, or a route the peer does not have.
const LINK_STATUSES = new Set([401, 403, 404]);
const NOTHING = Object.freeze(Object.fromEntries(FEATURES.map(feature => [feature, false])));

class LinkedServiceError extends Error {
  constructor(statusCode, body) { super(body.error); this.name = 'LinkedServiceError'; this.statusCode = statusCode; this.body = body; }
}

function createLinkedCapabilities({ serviceLinks, request, now = Date.now }) {
  // Per link: { available, at, failed, generation, pending }. `available` survives a link going offline, which is how a page can be told who was providing.
  const cache = new Map();

  const entryOf = id => {
    if (!cache.has(id)) cache.set(id, { available: null, at: null, failed: false, generation: 0, pending: null });
    return cache.get(id);
  };
  const isFresh = entry => entry.at !== null && now() - entry.at < (entry.failed ? RETRY_MS : CACHE_MS);
  const provides = (peer, feature) => { const entry = cache.get(peer.id); return Boolean(entry && entry.available && entry.available[feature]); };

  // The peer no longer accepts the token: the link is revoked, as for a 401 seen by the Engines page. Bookkeeping, so it can never replace the answer.
  function tokenRefused(peer) {
    try { serviceLinks.noteUnauthorized(peer.remoteServerId); } catch { /* the next 401 tries again */ }
  }

  async function probe(peer) {
    const info = await request(peer.baseUrl, '/v1/info', peer.token, { timeoutMs: PROBE_TIMEOUT_MS });
    if (!info || !Array.isArray(info.capabilities) || !info.capabilities.includes(CAPABILITY)) return NOTHING;
    const answer = await request(peer.baseUrl, `${ROUTE_BASE}/availability`, peer.token, { timeoutMs: PROBE_TIMEOUT_MS });
    return Object.fromEntries(FEATURES.map(feature => [feature, Boolean(answer && answer[feature] === true)]));
  }

  // Never rejects. One probe per link at a time; a result that arrives after the link changed is dropped, and the next read asks again.
  function refresh(peer) {
    const entry = entryOf(peer.id);
    if (entry.pending) return entry.pending;
    const { generation } = entry;
    const current = () => cache.get(peer.id) === entry && entry.generation === generation;
    const work = probe(peer).then(available => {
      if (!current()) return;
      entry.available = available;
      entry.failed = false;
      entry.at = now();
    }, error => {
      if (error && error.statusCode === 401) tokenRefused(peer);
      if (!current()) return;
      entry.failed = true;
      entry.at = now();
    }).finally(() => { if (entry.pending === work) entry.pending = null; });
    entry.pending = work;
    return work;
  }

  serviceLinks.onChange(id => {
    const peer = serviceLinks.peers().find(candidate => candidate.id === id);
    if (!peer) { cache.delete(id); return; }
    const entry = cache.get(id);
    if (entry) Object.assign(entry, { at: null, failed: false, generation: entry.generation + 1, pending: null });
    // Asked now, while nobody is waiting, so that the page's next read of the config already has the answer.
    if (peer.online) refresh(peer);
  });

  // The first peer, oldest link first, that is online, can do this and has the feature. Waits for a stale peer only as long as one probe takes.
  async function providerFor(feature) {
    for (const peer of serviceLinks.peers()) {
      if (!peer.online) continue;
      if (!isFresh(entryOf(peer.id))) await refresh(peer);
      if (provides(peer, feature)) return peer;
    }
    return null;
  }

  // For GET .../config: what the cache says at this moment, and never a wait. A stale entry is refreshed for the next read.
  function sharedFrom(feature) {
    const peers = serviceLinks.peers();
    for (const peer of peers) if (peer.online && !isFresh(entryOf(peer.id))) refresh(peer);
    const known = peers.filter(peer => provides(peer, feature));
    const peer = known.find(candidate => candidate.online) || known[0];
    return peer ? { name: peer.name, online: Boolean(peer.online) } : null;
  }

  const offline = peer => new LinkedServiceError(502, { error: 'LINKED_PROVIDER_OFFLINE', provider: peer.name });

  function failure(error, peer) {
    const status = error && error.statusCode;
    if (status === 401) tokenRefused(peer);
    // An answer from the peer's own service keeps its words and status. Anything else (no answer, a token or route problem, a proxy's page) is the link failing.
    if (Number.isInteger(status) && status >= 400 && status <= 599 && !LINK_STATUSES.has(status) && error.peerError) {
      return new LinkedServiceError(status, { error: error.peerError });
    }
    return offline(peer);
  }

  // What an /api route calls. `configured` is read first and alone decides whether a peer is involved at all.
  async function run(feature, { configured, local, route, body, timeoutMs, maxBytes }) {
    if (configured()) return local();
    const peer = await providerFor(feature);
    if (!peer) {
      const last = serviceLinks.peers().find(candidate => provides(candidate, feature));
      if (last) throw offline(last);
      return local();
    }
    try {
      return await request(peer.baseUrl, `${ROUTE_BASE}${route}`, peer.token, { method: 'POST', body, timeoutMs, ...(maxBytes ? { maxBytes } : {}) });
    } catch (error) {
      throw failure(error, peer);
    }
  }

  return { providerFor, sharedFrom, run };
}

let singleton = null;
function getLinkedCapabilities() {
  if (singleton) return singleton;
  const { getServiceLinks } = require('./service-links');
  const { request } = require('./remote-client');
  singleton = createLinkedCapabilities({ serviceLinks: getServiceLinks(), request });
  return singleton;
}

module.exports = { createLinkedCapabilities, getLinkedCapabilities, LinkedServiceError, CAPABILITY, FEATURES, CACHE_MS, RETRY_MS, TIMEOUT_MARGIN_MS, UPLOAD_POLICY_TIMEOUT_MS, TRANSLATION_MAX_BYTES };
