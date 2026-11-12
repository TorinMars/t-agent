// Settings sync across linked devices: the settings in the registry below are one set for every service link, kept the same on each device. See
// "Settings sync across linked devices" in DESIGN.md.
//
// - Registry: one entry per setting group, { key, read(owner) -> value | null, write(owner, value | null), secret }. Each adapts the store of its own
//   service (exportForSync / importFromSync there). Settings that belong to one device (working directory, access mode, authenticator, device name,
//   the desktop window switch, peer file access, restart, rules sync) are not in it, and Telegram keeps its own settings per device.
// - Metadata: system_state `settings_sync_v1` { keys: { <key>: { updated_at, updated_by, hash } } }. updated_at is a hybrid clock in milliseconds
//   (never behind the newest time seen, always ahead of it for a local change), updated_by the instance id of the device that made the value, hash an
//   HMAC of the value under a key from the session secret (so the table never holds a plain hash of a secret), null when there is no value. A value
//   that existed before this feature gets updated_at 0.
// - A local change: the save paths call settingChanged (services/settings-sync-store.js); 2 s later the hash is compared and, when it changed, the key
//   gets a new time and every online linked peer is synced. The hashes are also compared before every round, so a change no hook saw is not lost.
// - A round with one peer (on a local change, when a link comes online, at start and every 5 minutes): /v1/info must list `settings:sync` (an older
//   peer is skipped), GET /v1/settings-sync gives its metadata, the keys where it is newer are fetched (POST /v1/settings-sync/pull) and the keys where
//   we are newer are sent (PUT /v1/settings-sync). The receiver applies a value only when it is newer, so nothing loops; what it applied is sent on to
//   its other peers, so a chain of links reaches every device.
// - Newer: a value beats a key that never had one (updated_at 0, no value) whatever the times; otherwise the later updated_at wins and a tie goes to
//   the greater instance id. A cleared value is a tombstone (no value, a real time) and travels like any other.
// - Payloads: the values travel only inside AES-256-GCM envelopes. The key is per link: HKDF-SHA256 over an X25519 agreement between the two
//   devices' sync key pairs (made on first use, the private key encrypted with the session secret), salted with both link tokens' hashes, so only the
//   two ends of that link can open it, also when the link runs over plain HTTP. The additional data names the direction, the sender and the link, so
//   an envelope cannot be replayed the other way. A wrong key or a changed byte fails closed: nothing is applied. No value, key or hash of a secret is
//   ever logged or put in an error.
const crypto = require('crypto');
const { encryptToken, decryptToken } = require('../lib/token-crypto');
const syncStore = require('./settings-sync-store');

const STATE_KEY = 'settings_sync_v1';
const PEERS_KEY = 'settings_sync_peers_v1';
const KEYPAIR_KEY = 'settings_sync_keypair_v1';
const CAPABILITY = 'settings:sync';
const ROUTE = '/v1/settings-sync';
const REQUEST_TIMEOUT_MS = 10_000;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const DEBOUNCE_MS = 2000;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const INSTANCE_ID = /^[A-Za-z0-9-]{1,64}$/;
const B64URL = /^[A-Za-z0-9_-]*$/;
const NEVER = Object.freeze({ updated_at: 0, updated_by: '', hash: null });

// The setting groups the page shows, and where each one lives: 'shared' (this registry), 'device' (never synced), 'telegram' (its own plugin).
const SCOPES = Object.freeze({
  translate: 'shared', voice: 'shared', oss: 'shared', 'oss-agent-access': 'shared', 'attention-summary': 'shared', 'notify-rules': 'shared',
  'notifier-plugins': 'shared', 'widget-language': 'shared', 'task-list-devices': 'shared', 'browser-sites': 'shared',
  workdir: 'device', access: 'device', authenticator: 'device', 'engine-name': 'device', 'widget-enabled': 'device', 'peer-fs': 'device',
  restart: 'device', 'rule-sync': 'device',
  telegram: 'telegram',
});

const fault = (code, statusCode = 400) => Object.assign(new Error(code), { statusCode });
const errorCode = error => (error && /^[A-Z0-9_]{1,64}$/.test(error.message || '') ? error.message : 'SETTINGS_SYNC_FAILED');
const sha256 = value => crypto.createHash('sha256').update(value).digest();

// JSON with sorted object keys, so the same value always has the same hash.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}

// Whether version `a` beats version `b` (both { updated_at, updated_by, hash }; a null hash is "no value").
function isNewer(a, b) {
  const aEmpty = a.hash === null || a.hash === undefined;
  const bEmpty = b.hash === null || b.hash === undefined;
  if (aEmpty && bEmpty && a.updated_at === 0 && b.updated_at === 0) return false; // neither ever had a value: nothing to send
  if (!aEmpty && bEmpty && b.updated_at === 0) return true;
  if (aEmpty && a.updated_at === 0 && !bEmpty) return false;
  if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at;
  return String(a.updated_by || '') > String(b.updated_by || '');
}

function versionOf(value) {
  if (!value || typeof value !== 'object') return { ...NEVER };
  return {
    updated_at: Number.isSafeInteger(value.updated_at) && value.updated_at >= 0 ? value.updated_at : 0,
    updated_by: typeof value.updated_by === 'string' && INSTANCE_ID.test(value.updated_by) ? value.updated_by : '',
    hash: typeof value.hash === 'string' && value.hash ? value.hash : null,
  };
}

// ---- Envelopes ----
const aadOf = (direction, sender, linkId) => Buffer.from(`t-agent settings-sync v1|${direction}|${sender}|${linkId}`);

function seal(key, payload, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { v: 1, alg: 'A256GCM', iv: iv.toString('base64url'), data: data.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}

// Throws SETTINGS_SYNC_DECRYPT_FAILED for anything that is not an envelope this key and these additional data made.
function open(key, envelope, aad) {
  const broken = () => fault('SETTINGS_SYNC_DECRYPT_FAILED', 400);
  if (!envelope || typeof envelope !== 'object' || envelope.v !== 1 || envelope.alg !== 'A256GCM') throw broken();
  const { iv, data, tag } = envelope;
  if (![iv, data, tag].every(part => typeof part === 'string' && B64URL.test(part))) throw broken();
  if (data.length > MAX_PAYLOAD_BYTES * 2) throw fault('SETTINGS_SYNC_TOO_LARGE', 413);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const text = Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    const value = JSON.parse(text);
    if (!syncStore.isPlainObject(value)) throw Error();
    return value;
  } catch { throw broken(); }
}

// The key of one link: X25519(our private, their public), salted with the hashes of both link tokens (each side holds one token and the other's hash).
function deriveLinkKey({ privateKey, publicKey, linkId, tokenHashes }) {
  if (typeof publicKey !== 'string' || !PUBLIC_KEY.test(publicKey)) throw fault('SETTINGS_SYNC_BAD_KEY', 400);
  let shared;
  try { shared = crypto.diffieHellman({ privateKey, publicKey: crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: publicKey }, format: 'jwk' }) }); }
  catch { throw fault('SETTINGS_SYNC_BAD_KEY', 400); }
  const salt = sha256([...tokenHashes].sort().join('|'));
  return Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from(`t-agent settings-sync v1|${linkId}`), 32));
}

function createSettingsSync(options) {
  const {
    db, sessionSecret, serviceLinks = null, request = null, registry,
    identity, // () => { instance_id, name }
    owner = () => require('./single-user').ensureSingleUser().login,
    // The hash this device stores for the token it issued to the link's peer (engine_access_tokens), or null.
    issuedTokenHash = peer => {
      const link = serviceLinks && typeof serviceLinks.linkForServer === 'function' ? serviceLinks.linkForServer(peer.remoteServerId) : null;
      if (!link || link.id !== peer.id) return null;
      const row = db.prepare('SELECT token_hash FROM engine_access_tokens WHERE id = ?').get(link.issued_token_id);
      return row ? row.token_hash : null;
    },
    // A name for an instance id that is not a peer (a third device reached through a chain of links), or null.
    nameOfInstance = () => null,
    now = Date.now, log = console, intervalMs = SYNC_INTERVAL_MS, debounceMs = DEBOUNCE_MS, timeoutMs = REQUEST_TIMEOUT_MS,
  } = options;
  const byKey = new Map(registry.map(entry => [entry.key, entry]));
  const hashKey = sha256(`t-agent settings-sync hash|${sessionSecret}`);
  const hashOf = value => (value === null || value === undefined ? null : crypto.createHmac('sha256', hashKey).update(stableJson(value)).digest('hex').slice(0, 32));
  const me = () => identity().instance_id;

  // ---- Stored state ----
  function readMeta() {
    const value = syncStore.readState(db, STATE_KEY);
    const keys = value && syncStore.isPlainObject(value.keys) ? value.keys : {};
    return Object.fromEntries(Object.entries(keys).filter(([key]) => byKey.has(key)).map(([key, entry]) => [key, versionOf(entry)]));
  }
  const saveMeta = keys => syncStore.writeState(db, STATE_KEY, { keys });
  function readPeers() {
    const value = syncStore.readState(db, PEERS_KEY);
    return syncStore.isPlainObject(value) ? value : {};
  }
  const savePeers = peers => syncStore.writeState(db, PEERS_KEY, peers);
  function updatePeer(id, change) {
    const peers = readPeers();
    const current = syncStore.isPlainObject(peers[id]) ? peers[id] : {};
    peers[id] = { ...current, ...change(current) };
    // Links that are gone leave the table.
    if (serviceLinks) {
      const live = new Set(serviceLinks.peers().map(peer => peer.id));
      for (const key of Object.keys(peers)) if (!live.has(key)) delete peers[key];
    }
    savePeers(peers);
  }

  // The sync key pair of this device: made on first use, the private key kept encrypted with the session secret.
  let keyPair = null;
  function ownKeys() {
    if (keyPair) return keyPair;
    const stored = syncStore.readState(db, KEYPAIR_KEY);
    if (stored && typeof stored.private_key === 'string' && PUBLIC_KEY.test(stored.public_key || '')) {
      try {
        const d = decryptToken(stored.private_key, sessionSecret);
        keyPair = { publicKey: stored.public_key, privateKey: crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', x: stored.public_key, d }, format: 'jwk' }) };
        return keyPair;
      } catch { /* a key that cannot be read (another session secret) is replaced */ }
    }
    const { privateKey } = crypto.generateKeyPairSync('x25519');
    const jwk = privateKey.export({ format: 'jwk' });
    syncStore.writeState(db, KEYPAIR_KEY, { public_key: jwk.x, private_key: encryptToken(jwk.d, sessionSecret) });
    keyPair = { publicKey: jwk.x, privateKey };
    return keyPair;
  }

  let started = false;

  // ---- Clock ----
  let clock = 0;
  const observe = time => { if (Number.isSafeInteger(time) && time > clock) clock = time; };
  const tick = () => { clock = Math.max(now(), clock + 1); return clock; };

  // ---- Local values ----
  function readValue(key) {
    try { const value = byKey.get(key).read(owner()); return value === undefined ? null : value; } catch { return null; }
  }
  // Every key gets metadata once: a value that is already there counts as made at time 0, so it never beats a real change.
  let prepared = false;
  function prepare() {
    if (prepared) return;
    const keys = readMeta();
    let changed = false;
    for (const key of byKey.keys()) {
      if (keys[key]) continue;
      keys[key] = { updated_at: 0, updated_by: me(), hash: hashOf(readValue(key)) };
      changed = true;
    }
    for (const entry of Object.values(keys)) observe(entry.updated_at);
    if (changed) saveMeta(keys);
    prepared = true;
  }
  // Compares the hashes of the given keys with the stored values; a change gets a new time. Returns the keys that changed. A change found here that no
  // save hook reported is sent to the peers like one that was (`announce`), except where a round is already on its way.
  function reconcile(keys = [...byKey.keys()], { announce = true } = {}) {
    prepare();
    const meta = readMeta();
    const changed = [];
    for (const key of keys) {
      if (!byKey.has(key)) continue;
      const hash = hashOf(readValue(key));
      const current = meta[key] || { ...NEVER };
      if (current.hash === hash) continue;
      meta[key] = { updated_at: tick(), updated_by: me(), hash };
      changed.push(key);
    }
    if (changed.length) saveMeta(meta);
    if (changed.length && announce && started) fanOut();
    return changed;
  }
  const metaOf = key => { prepare(); return readMeta()[key] || { ...NEVER }; };

  // A value from a peer: written only when it is newer than ours. Returns true when it was applied.
  function applyRemote(key, entry) {
    if (!byKey.has(key) || !entry || typeof entry !== 'object') return false;
    if (!Number.isSafeInteger(entry.updated_at) || entry.updated_at < 0 || typeof entry.updated_by !== 'string' || !INSTANCE_ID.test(entry.updated_by)) return false;
    const value = entry.value === undefined ? null : entry.value;
    reconcile([key]);
    const incoming = { updated_at: entry.updated_at, updated_by: entry.updated_by, hash: value === null ? null : 'value' };
    observe(entry.updated_at);
    if (!isNewer(incoming, metaOf(key))) return false;
    try { byKey.get(key).write(owner(), value); }
    catch (error) { log.warn(`[settings-sync] a value for ${key} was refused: ${errorCode(error)}`); return false; }
    const meta = readMeta();
    meta[key] = { updated_at: entry.updated_at, updated_by: entry.updated_by, hash: hashOf(readValue(key)) };
    saveMeta(meta);
    return true;
  }

  // ---- Links ----
  const livePeers = () => {
    if (!serviceLinks) return [];
    try { return serviceLinks.peers(); } catch { return []; }
  };
  const onlinePeers = () => livePeers().filter(peer => peer.online);
  function linkKeyFor(peer, publicKey) {
    const own = issuedTokenHash(peer);
    if (!own || typeof peer.token !== 'string') throw fault('SETTINGS_SYNC_LINK_UNUSABLE', 409);
    return deriveLinkKey({ privateKey: ownKeys().privateKey, publicKey, linkId: peer.id, tokenHashes: [own, sha256(peer.token).toString('hex')] });
  }
  // The metadata a peer sees: hashes are bound to the link key, so they say "same value" to the peer and nothing to anyone else.
  function describe(peer, publicKey) {
    prepare();
    reconcile();
    let linkKey = null;
    if (publicKey) { try { linkKey = linkKeyFor(peer, publicKey); } catch { linkKey = null; } }
    const meta = readMeta();
    const keys = {};
    for (const key of byKey.keys()) {
      const entry = meta[key] || { ...NEVER };
      keys[key] = {
        updated_at: entry.updated_at, updated_by: entry.updated_by,
        hash: entry.hash === null ? null : (linkKey ? crypto.createHmac('sha256', linkKey).update(`hash|${entry.hash}`).digest('hex').slice(0, 32) : 'value'),
      };
    }
    return { instance_id: me(), public_key: ownKeys().publicKey, keys };
  }
  const peerForLink = link => livePeers().find(peer => peer.id === link.id) || null;
  function requirePeer(link) {
    const peer = peerForLink(link);
    if (!peer) throw fault('LINKED_ONLY', 403);
    return peer;
  }
  function checkSender(link, body) {
    const given = body && typeof body === 'object' ? body : {};
    if (typeof given.public_key !== 'string' || !PUBLIC_KEY.test(given.public_key)) throw fault('SETTINGS_SYNC_BAD_KEY', 400);
    if (typeof given.instance_id !== 'string' || !INSTANCE_ID.test(given.instance_id)) throw fault('INVALID_SETTINGS_SYNC', 400);
    if (link.peer_instance_id && link.peer_instance_id !== given.instance_id) throw fault('INVALID_SETTINGS_SYNC', 400);
    return given;
  }

  // GET /v1/settings-sync from a peer.
  function engineDescribe(link, publicKey) {
    const peer = requirePeer(link);
    return describe(peer, typeof publicKey === 'string' && PUBLIC_KEY.test(publicKey) ? publicKey : null);
  }
  // POST /v1/settings-sync/pull: our values of the asked keys, sealed for the peer.
  function enginePull(link, body) {
    const peer = requirePeer(link);
    const given = checkSender(link, body);
    if (!Array.isArray(given.keys) || given.keys.length > byKey.size * 2 || !given.keys.every(key => typeof key === 'string')) throw fault('INVALID_SETTINGS_SYNC', 400);
    const key = linkKeyFor(peer, given.public_key);
    reconcile();
    const values = {};
    for (const name of new Set(given.keys)) {
      if (!byKey.has(name)) continue;
      const meta = metaOf(name);
      values[name] = { value: readValue(name), updated_at: meta.updated_at, updated_by: meta.updated_by };
    }
    // The peer asked for these because ours are newer, so it will hold them in a moment.
    updatePeer(peer.id, current => ({
      supported: true, instance_id: given.instance_id,
      versions: { ...(syncStore.isPlainObject(current.versions) ? current.versions : {}), ...Object.fromEntries(Object.entries(values).map(([name, entry]) => [name, { updated_at: entry.updated_at, updated_by: entry.updated_by }])) },
    }));
    return { instance_id: me(), sealed: seal(key, { values }, aadOf('pull', me(), link.id)) };
  }
  // PUT /v1/settings-sync: the peer's newer values. Each is applied only when it is newer than ours.
  function enginePush(link, body) {
    const peer = requirePeer(link);
    const given = checkSender(link, body);
    const key = linkKeyFor(peer, given.public_key);
    const payload = open(key, given.sealed, aadOf('push', given.instance_id, link.id));
    const values = syncStore.isPlainObject(payload.values) ? payload.values : {};
    const applied = [];
    const ignored = [];
    for (const [name, entry] of Object.entries(values)) (applyRemote(name, entry) ? applied : ignored).push(name);
    const meta = readMeta();
    updatePeer(peer.id, current => ({
      supported: true, instance_id: given.instance_id,
      versions: { ...(syncStore.isPlainObject(current.versions) ? current.versions : {}), ...Object.fromEntries(applied.map(name => [name, { updated_at: meta[name].updated_at, updated_by: meta[name].updated_by }])) },
    }));
    if (applied.length) fanOut();
    return { applied, ignored };
  }

  // ---- Rounds ----
  const running = new Map(); // link id -> the round running for it
  const again = new Set(); // link ids to run once more when their round ends

  async function round(peer) {
    const call = (route, opts = {}) => request(peer.baseUrl, route, peer.token, { timeoutMs, ...opts });
    let applied = 0;
    try {
      const info = await call('/v1/info');
      if (!info || !Array.isArray(info.capabilities) || !info.capabilities.includes(CAPABILITY)) {
        updatePeer(peer.id, () => ({ supported: false, last_error: null }));
        return 0;
      }
      reconcile(undefined, { announce: false });
      const mine = ownKeys().publicKey;
      const theirs = await call(`${ROUTE}?public_key=${encodeURIComponent(mine)}`);
      if (!theirs || typeof theirs.instance_id !== 'string' || !INSTANCE_ID.test(theirs.instance_id) || !syncStore.isPlainObject(theirs.keys)) throw fault('SETTINGS_SYNC_BAD_ANSWER', 502);
      const linkKey = linkKeyFor(peer, theirs.public_key);
      const versions = {};
      const toPull = [];
      const toPush = [];
      for (const key of byKey.keys()) {
        const remote = versionOf(theirs.keys[key]);
        const local = metaOf(key);
        versions[key] = { updated_at: remote.updated_at, updated_by: remote.updated_by };
        observe(remote.updated_at);
        if (isNewer(remote, local)) toPull.push(key);
        else if (isNewer(local, remote)) toPush.push(key);
      }
      const self = me();
      if (toPull.length) {
        const answer = await call(`${ROUTE}/pull`, { method: 'POST', body: { instance_id: self, public_key: mine, keys: toPull } });
        const payload = open(linkKey, answer && answer.sealed, aadOf('pull', theirs.instance_id, peer.id));
        const values = syncStore.isPlainObject(payload.values) ? payload.values : {};
        for (const key of toPull) {
          if (applyRemote(key, values[key])) applied += 1;
          const meta = metaOf(key);
          if (values[key] && meta.updated_at === values[key].updated_at && meta.updated_by === values[key].updated_by) versions[key] = { updated_at: meta.updated_at, updated_by: meta.updated_by };
        }
      }
      if (toPush.length) {
        const values = {};
        for (const key of toPush) { const meta = metaOf(key); values[key] = { value: readValue(key), updated_at: meta.updated_at, updated_by: meta.updated_by }; }
        const answer = await call(ROUTE, { method: 'PUT', body: { instance_id: self, public_key: mine, sealed: seal(linkKey, { values }, aadOf('push', self, peer.id)) } });
        for (const key of Array.isArray(answer && answer.applied) ? answer.applied : []) {
          if (values[key]) versions[key] = { updated_at: values[key].updated_at, updated_by: values[key].updated_by };
        }
      }
      updatePeer(peer.id, () => ({ supported: true, instance_id: theirs.instance_id, last_sync_at: new Date(now()).toISOString(), last_error: null, versions }));
    } catch (error) {
      if (error && error.statusCode === 401 && typeof serviceLinks.noteUnauthorized === 'function') {
        try { serviceLinks.noteUnauthorized(peer.remoteServerId); } catch { /* the next call tries again */ }
      }
      const code = errorCode(error);
      updatePeer(peer.id, () => ({ last_error: code, last_error_at: new Date(now()).toISOString() }));
      log.warn(`[settings-sync] sync with ${peer.name} failed: ${code}`);
    }
    return applied;
  }

  // One round per link at a time; a request during a round runs one more round after it. Never rejects.
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
    })().catch(() => 0).finally(() => running.delete(peer.id));
    running.set(peer.id, work);
    return work;
  }

  async function syncAll() {
    const results = await Promise.all(onlinePeers().map(syncPeer));
    // What came from one peer goes on to the others.
    if (results.some(count => count > 0)) fanOut();
  }

  // ---- Local changes, debounced ----
  let timer = null;
  const dirty = new Set();
  let forward = false;
  function flush() {
    timer = null;
    const keys = [...dirty];
    dirty.clear();
    const changed = keys.length ? reconcile(keys, { announce: false }) : [];
    const go = changed.length > 0 || forward;
    forward = false;
    if (go) syncAll().catch(() => {});
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
    if (timer.unref) timer.unref();
  }
  function noteLocalChange(key) {
    if (!byKey.has(key)) return;
    dirty.add(key);
    schedule();
  }
  function fanOut() {
    forward = true;
    schedule();
  }

  // ---- The page ----
  function nameOf(instanceId, peers, states) {
    if (!instanceId) return null;
    if (instanceId === me()) return identity().name;
    const peer = peers.find(candidate => candidate.instanceId === instanceId || (states[candidate.id] && states[candidate.id].instance_id === instanceId));
    if (peer) return peer.name;
    try { return nameOfInstance(instanceId); } catch { return null; }
  }
  function view() {
    prepare();
    reconcile();
    const meta = readMeta();
    const peers = livePeers();
    const states = readPeers();
    const keys = [...byKey.keys()].map(key => {
      const local = meta[key] || { ...NEVER };
      const synced = [];
      const pending = [];
      for (const peer of peers) {
        const state = states[peer.id] || {};
        if (state.supported === false) continue;
        const theirs = syncStore.isPlainObject(state.versions) ? state.versions[key] : null;
        const same = theirs ? theirs.updated_at === local.updated_at && theirs.updated_by === local.updated_by : (local.updated_at === 0 && local.hash === null && state.supported === true);
        (same ? synced : pending).push(peer.name);
      }
      return { key, scope: 'shared', updated_at: local.updated_at, updated_by_name: local.updated_at || local.hash !== null ? nameOf(local.updated_by, peers, states) : null, synced_peers: synced, pending_peers: pending };
    });
    return {
      supported: true,
      scopes: { ...SCOPES },
      keys,
      peers: peers.map(peer => {
        const state = states[peer.id] || {};
        return { name: peer.name, online: Boolean(peer.online), supported: typeof state.supported === 'boolean' ? state.supported : null, last_sync_at: state.last_sync_at || null, last_error: state.last_error || null };
      }),
    };
  }

  // ---- Life ----
  let interval = null;
  let unsubscribeLinks = null;
  let unsubscribeChanges = null;
  function start() {
    if (unsubscribeChanges) return;
    started = true;
    try { prepare(); } catch (error) { log.warn(`[settings-sync] the metadata could not be prepared: ${errorCode(error)}`); }
    unsubscribeChanges = syncStore.onSettingChanged(noteLocalChange);
    if (serviceLinks && request) {
      unsubscribeLinks = serviceLinks.onChange(id => {
        const peer = onlinePeers().find(candidate => candidate.id === id);
        if (peer) syncPeer(peer);
      });
      if (intervalMs > 0) {
        interval = setInterval(() => { syncAll().catch(() => {}); }, intervalMs);
        if (interval.unref) interval.unref();
      }
      setImmediate(() => { syncAll().catch(() => {}); });
    }
  }
  function stop() {
    started = false;
    if (unsubscribeChanges) unsubscribeChanges();
    if (unsubscribeLinks) unsubscribeLinks();
    unsubscribeChanges = null;
    unsubscribeLinks = null;
    if (interval) clearInterval(interval);
    interval = null;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    start, stop, syncAll, syncPeer, view, reconcile, noteLocalChange, applyRemote,
    engineDescribe, enginePull, enginePush,
    meta: () => { prepare(); return readMeta(); },
    peerStates: readPeers,
    publicKey: () => ownKeys().publicKey,
    keys: () => [...byKey.keys()],
  };
}

// The registry of this server: every setting that linked devices keep as one set, adapting each service's own store.
function defaultRegistry({ db, sessionSecret }) {
  const deps = { db, sessionSecret };
  const entry = (key, module, { secret = false, exportName = 'exportForSync', importName = 'importFromSync' } = {}) => ({
    key, secret,
    read: owner => module()[exportName](deps, owner),
    write: (owner, value) => module()[importName](deps, owner, value),
  });
  return [
    entry('translate', () => require('./translator'), { secret: true }),
    entry('voice', () => require('./speech'), { secret: true }),
    entry('oss', () => require('./oss-images'), { secret: true }),
    entry('oss-agent-access', () => require('./oss-agent-settings')),
    entry('attention-summary', () => require('./attention-summary')),
    entry('notify-rules', () => require('./attention-notify'), { exportName: 'exportRulesForSync', importName: 'importRulesFromSync' }),
    entry('notifier-plugins', () => require('./attention-notify'), { secret: true, exportName: 'exportPluginsForSync', importName: 'importPluginsFromSync' }),
    entry('widget-language', () => require('./attention-widget')),
    entry('task-list-devices', () => require('../routes/task-list-prefs')),
    // The site capability library (services/browser-sites.js): the whole shared set travels, merged per site on import (last-writer-wins with
    // tombstones), so two devices that each edit a different site keep both. It holds no raw secrets, so syncing it is safe. Merge semantics, not
    // replace: a null from a peer is a no-op (deletions travel as per-site tombstones inside the value), so it is not cleared by write(null).
    entry('browser-sites', () => require('./browser-sites')),
  ];
}

// Off only when SETTINGS_SYNC_ENABLED=false (config.settingsSyncEnabled): then /v1/info does not list the capability and nothing starts.
const syncEnabled = () => require('../config').settingsSyncEnabled !== false;

let singleton = null;
function getSettingsSync() {
  if (singleton) return singleton;
  const db = require('../db');
  const config = require('../config');
  const serviceLinks = require('./service-links').getServiceLinks();
  singleton = createSettingsSync({
    db, sessionSecret: config.sessionSecret, serviceLinks,
    request: (...args) => require('./remote-client').request(...args),
    registry: defaultRegistry({ db, sessionSecret: config.sessionSecret }),
    identity: () => { const { engine_id: instanceId, name } = require('./engine-identity').getEngineIdentity(); return { instance_id: instanceId, name }; },
    nameOfInstance: instanceId => {
      const { remoteInstanceIds } = require('./engine-name');
      for (const [serverId, id] of remoteInstanceIds(db)) {
        if (id !== instanceId) continue;
        const row = db.prepare('SELECT name FROM remote_servers WHERE id = ?').get(serverId);
        if (row) return row.name;
      }
      return null;
    },
  });
  return singleton;
}

module.exports = {
  createSettingsSync, getSettingsSync, syncEnabled, defaultRegistry, isNewer, stableJson, seal, open, deriveLinkKey, aadOf,
  STATE_KEY, PEERS_KEY, KEYPAIR_KEY, CAPABILITY, ROUTE, SCOPES, SYNC_INTERVAL_MS, DEBOUNCE_MS,
};
