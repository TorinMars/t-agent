// Service links: two T-Agent services that see and operate each other as remote Engines, in both directions. The side that made the code is the
// initiator (A), the side that entered it is the joiner (B). B may be behind NAT, so B always calls A directly and A calls B through the reverse tunnel B
// keeps open (lib/service-link-tunnel.js). See "Service links" in DESIGN.md.
const crypto = require('crypto');
const { hashSecret, createAccessToken } = require('./engine-auth');
const { decryptToken, encryptToken } = require('../lib/token-crypto');
const { normalizeBaseUrl, request: remoteRequest } = require('./remote-client');
const tunnelModule = require('../lib/service-link-tunnel');

const STATE_KEY = 'service_links_v1';
const CAPABILITY = 'service-links';
// A link grants full admin and the join endpoint can be on the public internet. Six digits are a small space, so it is the cap that makes them acceptable:
// five wrong codes in total, from any address, end the code, so a guess succeeds at most 5 times in 1,000,000 for each code the owner generates.
const CODE = Object.freeze({ ttlMs: 10 * 60 * 1000, maxFailures: 5, pattern: /^\d{6}$/ });
const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCESS_TOKEN = /^tae_[A-Za-z0-9_-]{10,200}$/;
const TUNNEL_TOKEN = /^tsl_[A-Za-z0-9_-]{10,200}$/;
const NOTIFY_TIMEOUT_MS = 3000;
const JOIN_TIMEOUT_MS = 10_000;
// Codes of the peer's join answer that the joiner passes on as they are; everything else means the peer could not be used.
const PEER_REFUSALS = ['INVALID_CODE', 'INVALID_REQUEST', 'SELF_LINK', 'ALREADY_LINKED', 'PAIRING_RATE_LIMITED'];

const fault = (code, statusCode) => Object.assign(new Error(code), { statusCode });
const codeHash = code => hashSecret(`service-link:${code}`);
const cleanName = (value, fallback) => (typeof value === 'string' && value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 80)) || fallback;

function createServiceLinks({ db, sessionSecret, identity, tunnel = tunnelModule, request = remoteRequest, now = Date.now, log = console }) {
  // Held in memory only, as a hash: one active code { hash, expiresAt, failures, principalId }. A restart loses it.
  let activeCode = null;
  const clients = new Map();
  const clientsOnline = new Set();
  let localPort = null;
  let subscribed = false;
  const changeListeners = new Set();
  // A link was added, removed, revoked or changed presence. Listeners only ever drop cached facts, so one that fails must not stop the change itself.
  function notifyChange(id) {
    for (const listener of changeListeners) {
      try { listener(id); } catch { /* the next read asks again */ }
    }
  }

  function links() {
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY);
    return row ? JSON.parse(row.value).links : [];
  }
  function saveLinks(list) {
    db.prepare(`INSERT INTO system_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(STATE_KEY, JSON.stringify({ links: list }));
  }
  const findLink = id => links().find(link => link.id === id) || null;
  const updateLink = (id, change) => saveLinks(links().map(link => (link.id === id ? { ...link, ...change } : link)));
  const serverOf = link => db.prepare('SELECT * FROM remote_servers WHERE id = ?').get(link.remote_server_id);
  const tokenOf = row => decryptToken(row.token_cipher, sessionSecret);
  const timestamp = () => new Date(now()).toISOString();
  const isOnline = link => (link.role === 'initiator' ? tunnel.getHub().isOnline(link.id) : clientsOnline.has(link.id));

  function publicLink(link) {
    const online = !link.revoked && isOnline(link);
    return {
      id: link.id, name: link.name, role: link.role, peer_url: link.peer_url, online,
      state: link.revoked ? 'revoked' : (online ? 'online' : 'offline'),
      remote_server_id: link.remote_server_id, created_at: link.created_at, last_seen_at: link.last_seen_at,
    };
  }

  function createCode(principalId) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    activeCode = { hash: codeHash(code), expiresAt: now() + CODE.ttlMs, failures: 0, principalId };
    return { code, expires_in_seconds: CODE.ttlMs / 1000 };
  }

  // Throws INVALID_CODE for a wrong, used or expired code. A wrong code counts toward the cap, whatever address it came from.
  function verifyCode(code) {
    if (activeCode && activeCode.expiresAt <= now()) activeCode = null;
    const active = activeCode;
    if (!active) throw fault('INVALID_CODE', 400);
    if (!crypto.timingSafeEqual(Buffer.from(active.hash, 'hex'), Buffer.from(codeHash(code), 'hex'))) {
      active.failures += 1;
      if (active.failures >= CODE.maxFailures) activeCode = null;
      throw fault('INVALID_CODE', 400);
    }
    return active;
  }

  // Runs on the initiator, for POST /v1/service-links/join. Synchronous from the first check to the end, so no other join can run in between: the code is
  // consumed only when everything succeeded, and a refused attempt (SELF_LINK, ALREADY_LINKED) leaves the code and the tables as they were.
  function acceptJoin(body) {
    const given = body || {};
    // A malformed value is not a guess, so it does not count as a failure.
    if (typeof given.code !== 'string' || !CODE.pattern.test(given.code)) throw fault('INVALID_CODE', 400);
    if (typeof given.instance_id !== 'string' || !INSTANCE_ID.test(given.instance_id)
      || typeof given.access_token !== 'string' || !ACCESS_TOKEN.test(given.access_token)) throw fault('INVALID_REQUEST', 400);
    const active = verifyCode(given.code);
    const me = identity();
    if (given.instance_id === me.instance_id) throw fault('SELF_LINK', 409);
    if (links().some(link => link.peer_instance_id === given.instance_id)) throw fault('ALREADY_LINKED', 409);

    const name = cleanName(given.name, 'Linked service');
    const linkId = crypto.randomUUID();
    const tunnelToken = `tsl_${crypto.randomBytes(32).toString('base64url')}`;
    const issued = db.transaction(() => {
      const created = createAccessToken(db, { name: `Service link: ${name}`, principalId: active.principalId });
      const row = db.prepare(`INSERT INTO remote_servers (owner_id, name, base_url, token_cipher, status)
        VALUES (?, ?, ?, ?, 'offline')`).run(active.principalId, name, tunnel.tunnelBase(linkId), encryptToken(given.access_token, sessionSecret));
      saveLinks([...links(), {
        id: linkId, role: 'initiator', owner_id: active.principalId, name, peer_instance_id: given.instance_id, peer_url: null,
        remote_server_id: Number(row.lastInsertRowid), issued_token_id: created.id,
        tunnel_token_hash: hashSecret(tunnelToken), tunnel_token_cipher: null,
        created_at: timestamp(), last_seen_at: null, revoked: false,
      }]);
      return created;
    })();
    activeCode = null;
    notifyChange(linkId);
    return { link_id: linkId, access_token: issued.token, tunnel_token: tunnelToken, name: me.name, instance_id: me.instance_id, version: me.version };
  }

  async function probePeer(baseUrl) {
    let health;
    try { health = await request(baseUrl, '/v1/health', null, { timeoutMs: JOIN_TIMEOUT_MS }); }
    catch { throw fault('LINK_UNREACHABLE', 502); }
    if (!health || !Array.isArray(health.capabilities) || !health.capabilities.includes(CAPABILITY)) throw fault('LINK_UNSUPPORTED', 501);
  }

  function joinFailure(error) {
    if (PEER_REFUSALS.includes(error.message)) return fault(error.message, error.statusCode || 400);
    // A 404 here means the peer has no join route.
    if (error.statusCode === 404) return fault('LINK_UNSUPPORTED', 501);
    return fault('LINK_UNREACHABLE', 502);
  }

  // Runs on the joiner, for POST /api/service-links/join. A failure at any step removes what the earlier steps created.
  async function join({ url, port, code, name, confirm, ownerId }) {
    if (confirm !== true) throw fault('CONFIRM_REQUIRED', 400);
    const baseUrl = normalizeBaseUrl(url, port);
    const given = typeof code === 'string' ? code.trim() : '';
    if (!CODE.pattern.test(given)) throw fault('INVALID_CODE', 400);
    if (links().some(link => link.peer_url === baseUrl)) throw fault('ALREADY_LINKED', 409);
    // Checked before the code is spent: UNIQUE(owner_id, base_url) would refuse the row after the peer had already accepted.
    if (db.prepare('SELECT 1 FROM remote_servers WHERE owner_id = ? AND base_url = ?').get(ownerId, baseUrl)) throw fault('REMOTE_ALREADY_EXISTS', 409);
    await probePeer(baseUrl);

    const me = identity();
    const host = new URL(baseUrl).hostname;
    const local = createAccessToken(db, { name: `Service link: ${host}`, principalId: ownerId });
    const forget = () => db.prepare('DELETE FROM engine_access_tokens WHERE id = ?').run(local.id);
    let joined;
    try {
      joined = await request(baseUrl, '/v1/service-links/join', null, {
        method: 'POST', timeoutMs: JOIN_TIMEOUT_MS,
        body: { code: given, name: me.name, instance_id: me.instance_id, access_token: local.token },
      });
    } catch (error) {
      forget();
      throw joinFailure(error);
    }
    if (!joined || typeof joined.link_id !== 'string' || !ACCESS_TOKEN.test(joined.access_token || '') || !TUNNEL_TOKEN.test(joined.tunnel_token || '')) {
      forget();
      throw fault('LINK_UNSUPPORTED', 501);
    }

    const peerName = cleanName(name, cleanName(joined.name, host));
    let link = null;
    try {
      link = db.transaction(() => {
        const row = db.prepare(`INSERT INTO remote_servers (owner_id, name, base_url, token_cipher, status, remote_version, last_checked_at)
          VALUES (?, ?, ?, ?, 'online', ?, CURRENT_TIMESTAMP)`).run(ownerId, peerName, baseUrl, encryptToken(joined.access_token, sessionSecret), joined.version || null);
        db.prepare('UPDATE engine_access_tokens SET name = ? WHERE id = ?').run(`Service link: ${peerName}`.slice(0, 80), local.id);
        const record = {
          id: joined.link_id, role: 'joiner', owner_id: ownerId, name: peerName, peer_instance_id: joined.instance_id || null, peer_url: baseUrl,
          remote_server_id: Number(row.lastInsertRowid), issued_token_id: local.id,
          tunnel_token_hash: null, tunnel_token_cipher: encryptToken(joined.tunnel_token, sessionSecret),
          created_at: timestamp(), last_seen_at: null, revoked: false,
        };
        saveLinks([...links(), record]);
        return record;
      })();
      startClient(link);
    } catch (error) {
      if (link) {
        db.transaction(() => {
          db.prepare('DELETE FROM remote_servers WHERE id = ?').run(link.remote_server_id);
          saveLinks(links().filter(entry => entry.id !== link.id));
        })();
      }
      forget();
      // The peer already holds its half of the link; ask it to let go with the token it just gave.
      try {
        await request(baseUrl, `/v1/service-links/${encodeURIComponent(joined.link_id)}/unlink`, joined.access_token, { method: 'POST', body: {}, timeoutMs: NOTIFY_TIMEOUT_MS, expectText: true });
      } catch { /* the peer's owner removes it there */ }
      throw error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? fault('REMOTE_ALREADY_EXISTS', 409) : fault('LINK_JOIN_FAILED', 500);
    }
    notifyChange(link.id);
    return publicLink(link);
  }

  function startClient(link) {
    if (clients.has(link.id) || localPort === null) return;
    const client = tunnel.startTunnelClient({
      url: link.peer_url, token: decryptToken(link.tunnel_token_cipher, sessionSecret), linkId: link.id, localPort,
      onState: state => onClientState(link.id, state),
    });
    clients.set(link.id, client);
  }

  function onClientState(id, { online, error }) {
    if (error === 'LINK_REVOKED') return markRevoked(id);
    const up = Boolean(online);
    if (up === clientsOnline.has(id)) return;
    if (up) clientsOnline.add(id); else clientsOnline.delete(id);
    setPresence(id, up);
  }

  // The Engines list reads remote_servers.status, so the row follows the tunnel. When the tunnel comes up the version is read again, as POST /:id/check does.
  function setPresence(id, online) {
    const link = findLink(id);
    if (!link || link.revoked) return;
    db.prepare(`UPDATE remote_servers SET status = ?, last_checked_at = CURRENT_TIMESTAMP, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(online ? 'online' : 'offline', online ? null : 'LINK_OFFLINE', link.remote_server_id);
    updateLink(id, { last_seen_at: timestamp() });
    if (online) refreshPeer(link).catch(() => {});
    notifyChange(id);
  }

  async function refreshPeer(link) {
    const row = serverOf(link);
    if (!row) return;
    try {
      const info = await request(row.base_url, '/v1/info', tokenOf(row));
      db.prepare(`UPDATE remote_servers SET remote_version = COALESCE(?, remote_version), last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(info && (info.engine_version || info.app_version) || null, row.id);
    } catch (error) {
      if (error.statusCode === 401) markRevoked(link.id);
    }
  }

  function stopTransport(link) {
    if (link.role === 'joiner') {
      const client = clients.get(link.id);
      if (client) client.stop();
      clients.delete(link.id);
      clientsOnline.delete(link.id);
    } else {
      tunnel.getHub().drop(link.id, 'LINK_REVOKED');
    }
  }

  // The peer has let go of this link: stop reconnecting, show `revoked` and offer removal. The peer no longer needs the token issued to it, so it ends now.
  function markRevoked(id) {
    const link = findLink(id);
    if (!link || link.revoked) return;
    db.transaction(() => {
      db.prepare('UPDATE engine_access_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL').run(link.issued_token_id);
      db.prepare(`UPDATE remote_servers SET status = 'unauthorized', last_checked_at = CURRENT_TIMESTAMP, last_error = 'LINK_REVOKED',
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(link.remote_server_id);
      updateLink(id, { revoked: true });
    })();
    stopTransport(link);
    notifyChange(id);
  }

  function removeLocal(id) {
    const link = findLink(id);
    if (!link) return;
    db.transaction(() => {
      db.prepare('UPDATE engine_access_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL').run(link.issued_token_id);
      db.prepare('DELETE FROM remote_servers WHERE id = ?').run(link.remote_server_id);
      saveLinks(links().filter(entry => entry.id !== id));
    })();
    stopTransport(link);
    notifyChange(id);
  }

  // Best effort, with a short limit: a peer that does not hear it learns from its token failing.
  // The joiner reaches the initiator directly. The initiator reaches the joiner through the tunnel, whose path allowlist refuses /v1/service-links, so it uses
  // the notice path.
  async function notifyPeer(link) {
    if (link.role === 'initiator' && !tunnel.getHub().isOnline(link.id)) return;
    const row = serverOf(link);
    if (!row) return;
    const route = link.role === 'joiner' ? 'service-links' : 'service-link-notice';
    try {
      await request(row.base_url, `/v1/${route}/${encodeURIComponent(link.id)}/unlink`, tokenOf(row), { method: 'POST', body: {}, timeoutMs: NOTIFY_TIMEOUT_MS, expectText: true });
    } catch { /* best effort */ }
  }

  async function unlink(id) {
    const link = findLink(id);
    if (!link) throw fault('LINK_NOT_FOUND', 404);
    if (!link.revoked) await notifyPeer(link);
    removeLocal(id);
  }

  // The peer tells us it unlinked; only the token issued to the peer for this link may say so.
  function peerUnlink(id, tokenId) {
    const link = findLink(id);
    if (!link || link.issued_token_id !== Number(tokenId)) throw fault('LINK_NOT_FOUND', 404);
    removeLocal(id);
  }

  function authenticateTunnel(header) {
    const match = String(header || '').match(/^Bearer\s+(tsl_\S+)$/i);
    if (!match) return null;
    const hash = hashSecret(match[1]);
    const link = links().find(entry => entry.role === 'initiator' && !entry.revoked && entry.tunnel_token_hash === hash);
    return link ? link.id : null;
  }

  // Called once when the server listens. The tunnels are all down at this moment, so no row may keep the 'online' of the previous run.
  function start({ port }) {
    localPort = port;
    if (!subscribed) {
      subscribed = true;
      tunnel.getHub().onChange(({ linkId, online }) => setPresence(linkId, online));
    }
    for (const link of links()) {
      if (link.revoked) continue;
      db.prepare(`UPDATE remote_servers SET status = 'offline', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(link.remote_server_id);
      if (link.role !== 'joiner') continue;
      try { startClient(link); }
      catch (error) { log.error('[service-links] the tunnel could not start:', /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'START_FAILED'); }
    }
  }

  function stop() {
    for (const client of clients.values()) client.stop();
    clients.clear();
    clientsOnline.clear();
  }

  return {
    createCode, acceptJoin, join, unlink, peerUnlink, authenticateTunnel, start, stop, markRevoked,
    list: ownerId => links().filter(link => link.owner_id === ownerId).map(publicLink),
    linkForServer: serverId => links().find(link => link.remote_server_id === Number(serverId)) || null,
    linkForToken: tokenId => links().find(link => link.issued_token_id === Number(tokenId)) || null,
    // For services/linked-capabilities.js only, because it holds the Engine token and the address: never send this to a page. Live links, oldest first.
    peers() {
      const live = links().filter(link => !link.revoked).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      return live.flatMap(link => {
        const row = serverOf(link);
        if (!row) return [];
        try {
          return [{ id: link.id, name: link.name, online: isOnline(link), remoteServerId: link.remote_server_id, baseUrl: row.base_url, token: tokenOf(row) }];
        } catch { return []; } // a token that cannot be decrypted is a link that cannot be used
      });
    },
    onChange(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    // Token lists show which tokens belong to a link.
    markTokens(rows) {
      const byToken = new Map(links().map(link => [link.issued_token_id, link.id]));
      return rows.map(row => ({ ...row, service_link_id: byToken.get(row.id) || null }));
    },
    // A 401 from the peer's Engine API, seen by the Engines page check.
    noteUnauthorized(serverId) {
      const link = links().find(entry => entry.remote_server_id === Number(serverId));
      if (link) markRevoked(link.id);
    },
  };
}

let singleton = null;
function getServiceLinks() {
  if (singleton) return singleton;
  const db = require('../db');
  const config = require('../config');
  const updates = require('./update-manager');
  const { getEngineIdentity } = require('./engine-identity');
  singleton = createServiceLinks({
    db, sessionSecret: config.sessionSecret,
    identity() {
      const { engine_id: instanceId, name } = getEngineIdentity();
      let version = null;
      try { version = updates.readLocalManifest().app_version; } catch { /* the package version below */ }
      return { instance_id: instanceId, name, version: version || require('../package.json').version };
    },
  });
  return singleton;
}

module.exports = { createServiceLinks, getServiceLinks, CAPABILITY, CODE, STATE_KEY };
