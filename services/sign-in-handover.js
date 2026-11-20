// One login for linked engines: a browser logged in on engine A enters linked engine B without the code. See "One login for linked engines" in
// docs/design/failover-and-one-login.md.
//
// - A hand-over is made on A only by a POST of a logged-in page of A (the /api gates: same origin, session), for one linked engine B named by its
//   instance id. A asks B over the link first (GET /v1/sign-in-handover: B accepts hand-overs, B's web addresses; B's /v1/info lists the capability),
//   then signs { v, iss: A, aud: B, lnk, jti, iat, exp (60 s), lvl, nh } with the link's hand-over key: HKDF-SHA256 over the hashes of the two link
//   tokens (each side holds one token and the other's hash, so only the two ends of the link can make the key). `nh` is the SHA-256 of a nonce the
//   page made and keeps: the nonce never reaches A, only the browser that navigates to B carries it (with the token, in the URL fragment), so a token
//   read from A's answer alone is not enough.
// - B redeems it on its login page (POST <login path>/handover, the same origin rule as the login): the link is live (not revoked) and owned by this
//   owner, the signature is the link's, iss is the link's peer, aud is B, not expired, the nonce matches, the id was not used before (kept until it
//   expires, across a restart), B accepts hand-overs, and B's own rule still holds: B must use authenticator login, and A's session must have come
//   from an authenticator code too (a local-only login of A never opens B). B then sets its own normal session cookie. The new session does not count
//   as a recent verification (replacing B's authenticator asks for B's code).
// - Every issue, acceptance and refusal is logged with the engine names and the reason code, never the token or the nonce.
const crypto = require('crypto');

const CAPABILITY = 'sign-in:handover';
const SETTINGS_KEY = 'sign_in_handover_v1';
const USED_KEY = 'sign_in_handover_used_v1';
const ADDRESSES_KEY = 'linked_web_addresses_v1';
const TTL_MS = 60_000;
const SKEW_MS = 30_000; // how far the issuer's clock may be ahead of this one
const PEER_TTL_MS = 5 * 60_000; // how long a linked engine's addresses and switch are taken as known before they are asked again
const PEER_TIMEOUT_MS = 5_000;
const MAX_ADDRESSES = 8;
const MAX_USED = 2000;
const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 20;
const B64URL = /^[A-Za-z0-9_-]+$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes
const INSTANCE_ID = /^[A-Za-z0-9-]{1,64}$/;

// `status` too: routes/auth.js answers with error.status.
const fault = (code, statusCode = 400) => Object.assign(new Error(code), { statusCode, status: statusCode });
const sha256 = value => crypto.createHash('sha256').update(value).digest();
const b64 = buffer => Buffer.from(buffer).toString('base64url');
const nonceHash = nonce => b64(sha256(String(nonce)));

// The key of one link: both token hashes (sorted, so both ends get the same) through HKDF, with this feature's own label.
function handoverKey(linkId, tokenHashes) {
  const ikm = Buffer.from([...tokenHashes].map(String).sort().join('|'));
  return Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.from('t-agent sign-in hand-over v1'), Buffer.from(`link|${linkId}`), 32));
}
const macOf = (key, body) => crypto.createHmac('sha256', key).update(`v1.${body}`).digest();

function sign(key, payload) {
  const body = b64(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${b64(macOf(key, body))}`;
}

// The payload of a token whose form is right, before its signature is checked (null otherwise). Only for finding the link.
function parse(token) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const [body, mac, extra] = token.split('.');
  if (extra !== undefined || !body || !mac || !B64URL.test(body) || !B64URL.test(mac) || mac.length !== 43) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.v !== 1) return null;
  const strings = ['iss', 'aud', 'lnk', 'jti', 'nh', 'lvl'];
  if (!strings.every(key => typeof payload[key] === 'string' && payload[key].length > 0 && payload[key].length <= 128)) return null;
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)) return null;
  return { body, mac, payload };
}

// An address another browser may open: http(s), a host that is not this machine's loopback, no user, password, query or fragment.
function cleanAddress(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 300) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host) || host === '0.0.0.0') return null;
  return url.origin;
}
function cleanAddresses(list) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(list) ? list : []) {
    const clean = cleanAddress(typeof value === 'string' ? value : value && value.url);
    if (clean && !seen.has(clean)) { seen.add(clean); out.push(clean); }
    if (out.length >= MAX_ADDRESSES) break;
  }
  return out;
}

function createSignInHandover(options) {
  const {
    db, serviceLinks, request,
    identity, // () => { instance_id, name }
    clientAuth, // { accessMode(), status(session), authenticated(session) }
    owner = () => require('./single-user').ensureSingleUser().login,
    ownAddresses = () => [], // this engine's web addresses ({ kind, url } of app.json); loopback ones are left out
    now = Date.now,
    randomId = () => crypto.randomBytes(16).toString('base64url'),
    log = console,
  } = options;

  // ---- Stored state (one statement per key, so the key guard of lib/server-state-keys.js can read each) ----
  const parsed = row => { if (!row) return null; try { return JSON.parse(row.value); } catch { return null; } };
  const readSettings = () => parsed(db.prepare('SELECT value FROM system_state WHERE key = ?').get(SETTINGS_KEY));
  const readAddresses = () => parsed(db.prepare('SELECT value FROM system_state WHERE key = ?').get(ADDRESSES_KEY));
  const readUsed = () => parsed(db.prepare('SELECT value FROM system_state WHERE key = ?').get(USED_KEY));

  // The switch of this machine (device scope): no row is on.
  const accepting = () => { const value = readSettings(); return !(value && value.accept === false); };
  function setAccepting(accept) {
    if (typeof accept !== 'boolean') throw fault('VALIDATION_FAILED', 400);
    if (accept) db.prepare('DELETE FROM system_state WHERE key = ?').run(SETTINGS_KEY);
    else db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(SETTINGS_KEY, JSON.stringify({ accept: false }));
    log.log(`[sign-in] accepting hand-overs from linked engines: ${accept ? 'on' : 'off'}`);
    return accept;
  }

  // ---- Links ----
  const livePeers = () => { try { return serviceLinks.peers(); } catch { return []; } };
  const linkOf = peer => (serviceLinks.linkForServer ? serviceLinks.linkForServer(peer.remoteServerId) : null);
  function issuedTokenHash(link) {
    if (!link) return null;
    const row = db.prepare('SELECT token_hash, revoked_at FROM engine_access_tokens WHERE id = ?').get(link.issued_token_id);
    return row && !row.revoked_at ? row.token_hash : null;
  }
  function keyFor(peer, link) {
    const own = issuedTokenHash(link);
    if (!own || typeof peer.token !== 'string' || !peer.token) throw fault('HANDOVER_LINK_REVOKED', 403);
    return handoverKey(link.id, [own, sha256(peer.token).toString('hex')]);
  }

  // How strong this page's login is: an authenticator code (remote mode), or a local-only login (local mode, loopback only).
  function levelOf(session) {
    if (!clientAuth.authenticated(session)) return null;
    return clientAuth.accessMode() === 'remote' ? 'authenticator' : 'local';
  }

  // ---- What linked engines told about themselves (their web addresses), kept so a page can offer them while one is down ----
  const remembered = () => { const value = readAddresses(); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; };
  function remember(instanceId, entry) {
    const all = remembered();
    const next = { name: entry.name, addresses: entry.addresses, accepting: entry.accepting, supported: entry.supported, at: entry.at };
    const same = value => JSON.stringify({ ...value, at: null });
    // Written only when something changed (or once an hour, so `at` says when it was last seen): a read of the page does not write every time.
    if (all[instanceId] && same(all[instanceId]) === same(next) && now() - (all[instanceId].at || 0) < 60 * 60_000) return;
    all[instanceId] = next;
    // Engines that are no longer linked are dropped.
    const linked = new Set(livePeers().map(peer => peer.instanceId).filter(Boolean));
    for (const id of Object.keys(all)) if (!linked.has(id)) delete all[id];
    db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(ADDRESSES_KEY, JSON.stringify(all));
  }
  const fresh = new Map(); // instance id -> { at, pending }

  // This engine's own addresses for a peer that asks: what app.json lists, without loopback.
  const myAddresses = () => { try { return cleanAddresses(ownAddresses()); } catch { return []; } };

  // GET /v1/sign-in-handover from a linked engine.
  function describeForPeer() { return { accepting: accepting(), addresses: myAddresses() }; }

  // Asks one online peer (never throws): its capability, its switch and its addresses. The joiner also knows the initiator's address it joined at.
  async function askPeer(peer, link) {
    const call = (route) => request(peer.baseUrl, route, peer.token, { timeoutMs: PEER_TIMEOUT_MS });
    const info = await call('/v1/info');
    const supported = Boolean(info && Array.isArray(info.capabilities) && info.capabilities.includes(CAPABILITY));
    let accepts = null;
    let addresses = [];
    if (supported) {
      const answer = await call('/v1/sign-in-handover');
      accepts = Boolean(answer && answer.accepting === true);
      addresses = cleanAddresses(answer && answer.addresses);
    }
    if (link && link.role === 'joiner' && link.peer_url) addresses = cleanAddresses([...addresses, link.peer_url]);
    const entry = { name: peer.name, addresses, accepting: accepts, supported, at: now() };
    if (peer.instanceId) remember(peer.instanceId, entry);
    return entry;
  }
  function refreshPeer(peer, link, force = false) {
    const key = peer.instanceId || peer.id;
    const known = fresh.get(key);
    if (known && known.pending) return known.pending;
    if (!force && known && now() - known.at < PEER_TTL_MS) return Promise.resolve(null);
    const pending = askPeer(peer, link).catch(error => {
      if (error && error.statusCode === 401 && serviceLinks.noteUnauthorized) { try { serviceLinks.noteUnauthorized(peer.remoteServerId); } catch { /* the next read tries again */ } }
      return null;
    }).finally(() => { fresh.set(key, { at: now(), pending: null }); });
    fresh.set(key, { at: known ? known.at : 0, pending });
    return pending;
  }

  // GET /api/sign-in-handover/peers: this engine and every live linked engine, with what is known of it (online ones are asked when stale).
  async function peersFor(ownerId) {
    const peers = livePeers().filter(peer => { const link = linkOf(peer); return link && link.owner_id === ownerId; });
    await Promise.all(peers.filter(peer => peer.online).map(peer => refreshPeer(peer, linkOf(peer))));
    const known = remembered();
    const me = identity();
    return {
      instance_id: me.instance_id, name: me.name, accepting: accepting(),
      peers: peers.map(peer => {
        const entry = (peer.instanceId && known[peer.instanceId]) || {};
        return {
          instance_id: peer.instanceId || null, name: peer.name, online: Boolean(peer.online),
          supported: typeof entry.supported === 'boolean' ? entry.supported : null,
          accepting: typeof entry.accepting === 'boolean' ? entry.accepting : null,
          addresses: cleanAddresses(entry.addresses),
        };
      }),
    };
  }

  // For app.json (the Mac app): every linked engine's remembered addresses, live links only.
  function linkedAddresses() {
    const known = remembered();
    return livePeers().filter(peer => peer.instanceId && known[peer.instanceId]).map(peer => ({
      name: peer.name, instance_id: peer.instanceId, urls: cleanAddresses(known[peer.instanceId].addresses),
    })).filter(entry => entry.urls.length);
  }

  // ---- Issue (on A) ----
  async function issue({ ownerId, session, target, nonceHash: hashed }) {
    const level = levelOf(session);
    if (!level) throw fault('AUTH_REQUIRED', 401);
    if (typeof target !== 'string' || !INSTANCE_ID.test(target)) throw fault('VALIDATION_FAILED', 400);
    if (typeof hashed !== 'string' || !NONCE.test(hashed)) throw fault('VALIDATION_FAILED', 400);
    const peer = livePeers().find(candidate => candidate.instanceId === target);
    const link = peer ? linkOf(peer) : null;
    if (!peer || !link || link.revoked || link.owner_id !== ownerId) throw fault('HANDOVER_NOT_LINKED', 404);
    // B's rule: a hand-over only stands for a login that used an authenticator code. Refused here already; B checks again.
    if (level !== 'authenticator') { log.log(`[sign-in] no hand-over to ${peer.name}: this login used no authenticator code`); throw fault('HANDOVER_CODE_REQUIRED', 409); }
    if (!peer.online) throw fault('HANDOVER_TARGET_OFFLINE', 409);
    const there = await refreshPeer(peer, link, true);
    if (!there) throw fault('HANDOVER_TARGET_OFFLINE', 409);
    if (!there.supported) throw fault('HANDOVER_UNSUPPORTED', 409);
    if (!there.accepting) { log.log(`[sign-in] no hand-over to ${peer.name}: it does not accept hand-overs`); throw fault('HANDOVER_OFF_THERE', 409); }
    const issuedAt = now();
    const token = sign(keyFor(peer, link), {
      v: 1, iss: identity().instance_id, aud: peer.instanceId, lnk: link.id, jti: randomId(), iat: issuedAt, exp: issuedAt + TTL_MS, lvl: level, nh: hashed,
    });
    log.log(`[sign-in] hand-over to ${peer.name} issued (valid ${TTL_MS / 1000} s, once)`);
    return { token, name: peer.name, instance_id: peer.instanceId, addresses: there.addresses, expires_in: TTL_MS / 1000 };
  }

  // ---- Redeem (on B) ----
  const failures = new Map(); // address -> [times]
  function limited(ip) {
    const key = String(ip || '');
    const recent = (failures.get(key) || []).filter(time => now() - time < FAILURE_WINDOW_MS);
    failures.set(key, recent);
    return recent.length >= MAX_FAILURES;
  }
  function noteFailure(ip) {
    const key = String(ip || '');
    failures.set(key, [...(failures.get(key) || []), now()]);
    if (failures.size > 1000) failures.delete(failures.keys().next().value);
  }
  // Marks the id used, or throws HANDOVER_USED. One transaction: two requests with the same token cannot both pass.
  const markUsed = (jti, expiresAt) => db.transaction(() => {
    const used = readUsed() || {};
    for (const [id, until] of Object.entries(used)) if (!(until > now())) delete used[id];
    if (Object.hasOwn(used, jti)) throw fault('HANDOVER_USED', 409);
    used[jti] = expiresAt;
    const ids = Object.keys(used);
    if (ids.length > MAX_USED) for (const id of ids.slice(0, ids.length - MAX_USED)) delete used[id];
    db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(USED_KEY, JSON.stringify(used));
  })();

  function check({ token, nonce }) {
    const parsed = parse(token);
    if (!parsed || typeof nonce !== 'string' || !NONCE.test(nonce)) throw fault('HANDOVER_INVALID', 400);
    const { payload } = parsed;
    // The link the token names, among the live links of this owner (a revoked or removed link is gone from the list).
    const peer = livePeers().find(candidate => candidate.id === payload.lnk);
    const link = peer ? linkOf(peer) : null;
    if (!peer || !link || link.revoked) throw fault('HANDOVER_LINK_REVOKED', 403);
    const expected = macOf(keyFor(peer, link), parsed.body);
    const given = Buffer.from(parsed.mac, 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw fault('HANDOVER_INVALID', 400);
    if (link.owner_id !== owner() || !link.peer_instance_id || payload.iss !== link.peer_instance_id) throw fault('HANDOVER_INVALID', 400);
    if (payload.aud !== identity().instance_id) throw fault('HANDOVER_WRONG_TARGET', 400);
    const time = now();
    if (payload.exp - payload.iat > TTL_MS || payload.iat > time + SKEW_MS) throw fault('HANDOVER_INVALID', 400);
    if (payload.exp <= time) throw fault('HANDOVER_EXPIRED', 400);
    const hashedGiven = Buffer.from(nonceHash(nonce));
    const hashedWanted = Buffer.from(payload.nh);
    if (hashedGiven.length !== hashedWanted.length || !crypto.timingSafeEqual(hashedGiven, hashedWanted)) throw fault('HANDOVER_INVALID', 400);
    return { payload, peer, link };
  }

  // POST <login path>/handover. Answers { from: { name, instance_id } } for the login to be saved, or throws a code.
  function redeem({ token, nonce, ip }) {
    if (limited(ip)) throw fault('AUTH_RATE_LIMITED', 429);
    let checked;
    try {
      checked = check({ token, nonce });
      if (!accepting()) throw fault('HANDOVER_OFF', 403);
      if (clientAuth.accessMode() !== 'remote' || !clientAuth.status(null).bound) throw fault('HANDOVER_NOT_AVAILABLE', 409);
      if (checked.payload.lvl !== 'authenticator') throw fault('HANDOVER_CODE_REQUIRED', 409);
      markUsed(checked.payload.jti, checked.payload.exp + SKEW_MS);
    } catch (error) {
      noteFailure(ip);
      const from = checked ? ` from ${checked.peer.name}` : '';
      log.log(`[sign-in] hand-over${from} refused: ${/^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'HANDOVER_INVALID'}`);
      throw error.statusCode ? error : fault('HANDOVER_INVALID', 400);
    }
    log.log(`[sign-in] hand-over from ${checked.peer.name} accepted: signed in here`);
    return { from: { name: checked.peer.name, instance_id: checked.payload.iss } };
  }

  return { accepting, setAccepting, describeForPeer, peersFor, linkedAddresses, issue, redeem };
}

let singleton = null;
function getSignInHandover() {
  if (singleton) return singleton;
  const { getEngineIdentity } = require('./engine-identity');
  singleton = createSignInHandover({
    db: require('../db'),
    serviceLinks: require('./service-links').getServiceLinks(),
    request: (...args) => require('./remote-client').request(...args),
    identity: () => { const { engine_id: instanceId, name } = getEngineIdentity(); return { instance_id: instanceId, name }; },
    clientAuth: require('./client-auth').getClientAuth(),
    ownAddresses: () => {
      const publisher = require('./app-info').sharedPublisher();
      const info = publisher && publisher.current();
      return info && Array.isArray(info.addresses) ? info.addresses.filter(entry => entry && entry.kind !== 'local') : [];
    },
  });
  return singleton;
}

module.exports = { createSignInHandover, getSignInHandover, handoverKey, nonceHash, cleanAddresses, CAPABILITY, SETTINGS_KEY, USED_KEY, ADDRESSES_KEY, TTL_MS };
