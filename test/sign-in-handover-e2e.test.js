// One login for linked engines, end to end: two engines in this process (each its own database, sessions, client auth, login gate and the real
// routes), joined by one link over real HTTP, and a browser played by a cookie jar per origin. A logs in with its authenticator code, asks for a
// hand-over with a same-origin POST, and the browser redeems it on B's login page: B then serves its page with its own session cookie, without B's
// code. The same-origin rules, the replay and a forged token are checked on the wire. See "One login for linked engines" in
// docs/design/failover-and-one-login.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-sign-in-e2e-'));
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const { createClientAuth, totp } = require('../services/client-auth');
const { createSignInHandover, CAPABILITY } = require('../services/sign-in-handover');
const { createSignInHandoverRouter, createEngineSignInHandoverRouter } = require('../routes/sign-in-handover');
const { createAuthRouter } = require('../routes/auth');
const { createLoginGate } = require('../lib/login-gate');
const clientOrigin = require('../middleware/client-origin');
const { request } = require('../services/remote-client');

const SECRET = 'e2e-session-secret-0123456789-abcdefghijklmnop';
const LOGIN = '/hidden/door';
const LINK = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const clock = { now: Date.now() };

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

// One engine. `link` is filled in once both listen: { peerName, peerInstance, peerToken (the token it holds), issuedToken (the one it gave) }.
function makeEngine(instance, name) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE engine_access_tokens (id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL, revoked_at TEXT)`);
  const auth = createClientAuth(db, { sessionSecret: SECRET, ownerId: 'owner', now: () => clock.now });
  const engine = { instance, name, db, auth, link: null, base: null };
  const serviceLinks = {
    peers: () => (engine.link ? [{ id: LINK, name: engine.link.peerName, online: true, remoteServerId: 1, instanceId: engine.link.peerInstance, baseUrl: engine.link.peerBase, token: engine.link.peerToken }] : []),
    linkForServer: id => (engine.link && id === 1 ? { id: LINK, role: engine.link.role, owner_id: 'owner', peer_instance_id: engine.link.peerInstance, issued_token_id: 1, revoked: false, peer_url: null } : null),
    linkForToken: id => (engine.link && id === 1 ? { id: LINK, revoked: false } : null),
    noteUnauthorized() {},
  };
  engine.logs = [];
  engine.handover = createSignInHandover({
    db, serviceLinks, request, clientAuth: auth, owner: () => 'owner', now: () => clock.now,
    identity: () => ({ instance_id: instance, name }),
    ownAddresses: () => [{ kind: 'lan', url: engine.base }],
    log: { log: line => engine.logs.push(line), warn: () => {}, error: () => {} },
  });
  const app = express();
  app.use(express.json());
  app.use(session({ name: 'ta.sid', secret: SECRET, resave: false, saveUninitialized: false, store: new session.MemoryStore(), cookie: { httpOnly: true, sameSite: 'strict', secure: false } }));
  // The link side: a Bearer token the peer holds, as requireEngineAuth would check it.
  const requireEngineAuth = () => (req, res, next) => {
    const given = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const row = db.prepare('SELECT id FROM engine_access_tokens WHERE token_hash = ? AND revoked_at IS NULL').get(sha(given));
    if (!row) return res.status(401).json({ error: 'ENGINE_TOKEN_INVALID' });
    req.engineAuth = { tokenId: row.id };
    next();
  };
  app.get('/v1/info', requireEngineAuth(), (req, res) => res.json({ capabilities: [CAPABILITY] }));
  app.use('/v1/sign-in-handover', createEngineSignInHandoverRouter({ service: () => engine.handover, serviceLinks, requireEngineAuth }));
  app.use(createLoginGate({ loginPath: LOGIN, isAuthenticated: value => auth.authenticated(value) }));
  app.use('/api', clientOrigin, (req, res, next) => {
    if (!auth.authenticated(req.session)) return res.status(401).json({ error: 'AUTH_REQUIRED' });
    req.session.user = { login: 'owner' };
    next();
  });
  app.use('/api/sign-in-handover', createSignInHandoverRouter({ service: () => engine.handover }));
  app.use(LOGIN, createAuthRouter({ clientAuth: () => auth, handover: () => engine.handover }));
  app.get('/', (req, res) => res.type('text').send(`page of ${name}`));
  engine.app = app;
  return engine;
}

// A browser: one cookie jar per origin, no redirects followed (each hop is checked).
function browser() {
  const jars = new Map();
  return {
    jar: origin => jars.get(origin) || new Map(),
    async go(url, { method = 'GET', body, headers = {} } = {}) {
      const origin = new URL(url).origin;
      const jar = jars.get(origin) || new Map();
      const cookie = [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
      const response = await fetch(url, {
        method, redirect: 'manual',
        headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(';');
        const at = pair.indexOf('=');
        jar.set(pair.slice(0, at), pair.slice(at + 1));
      }
      jars.set(origin, jar);
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* a page */ }
      return { status: response.status, headers: response.headers, text, json, setCookie: response.headers.getSetCookie() };
    },
  };
}

// Binds an authenticator on an engine (as its first setup would) and answers the secret.
function bind(engine) {
  const pending = {};
  const { secret } = engine.auth.beginSetup(pending, '127.0.0.1');
  engine.auth.confirmSetup(pending, totp(secret, Math.floor(clock.now / 30000)), '127.0.0.1');
  return secret;
}

test('a login on A enters B through a hand-over: same-origin POST on A, redeemed once on B\'s login page, B\'s own cookie', async t => {
  const A = makeEngine('inst-a', 'T01');
  const B = makeEngine('inst-b', 'K01');
  const a = await listen(A.app);
  const b = await listen(B.app);
  t.after(() => { a.server.close(); b.server.close(); });
  A.base = a.origin;
  B.base = b.origin;
  // The link: A holds the token B issued (T_B), B holds the one A issued (T_A); each stores the hash of the one it issued.
  const T_A = `tae_${crypto.randomBytes(24).toString('base64url')}`;
  const T_B = `tae_${crypto.randomBytes(24).toString('base64url')}`;
  A.db.prepare('INSERT INTO engine_access_tokens (id, token_hash) VALUES (1, ?)').run(sha(T_A));
  B.db.prepare('INSERT INTO engine_access_tokens (id, token_hash) VALUES (1, ?)').run(sha(T_B));
  A.link = { role: 'initiator', peerName: 'K01', peerInstance: 'inst-b', peerBase: b.origin, peerToken: T_B };
  B.link = { role: 'joiner', peerName: 'T01', peerInstance: 'inst-a', peerBase: a.origin, peerToken: T_A };
  const secretA = bind(A);
  bind(B);
  clock.now += 30_000; // the next code

  const person = browser();
  // Logged out, B's page leads to its login entrance.
  const before = await person.go(`${b.origin}/`);
  assert.equal(before.status, 302);
  assert.match(before.headers.get('location'), new RegExp(`^${LOGIN}\\?return_to=`));

  // Log in on A with A's code.
  const login = await person.go(`${a.origin}${LOGIN}/login`, { method: 'POST', body: { code: totp(secretA, Math.floor(clock.now / 30000)), return_to: '/' }, headers: { origin: a.origin } });
  assert.equal(login.status, 200, login.text);
  assert.equal((await person.go(`${a.origin}/`)).text, 'page of T01');

  const nonce = crypto.randomBytes(32).toString('base64url');
  const nonceHash = crypto.createHash('sha256').update(nonce).digest('base64url');
  // The hand-over is made only by a same-origin POST of the logged-in page: not by a GET, not cross-site, not without the origin proof, not logged out.
  assert.equal((await person.go(`${a.origin}/api/sign-in-handover?target=inst-b&nonce_hash=${nonceHash}`)).status, 404);
  assert.equal((await person.go(`${a.origin}/api/sign-in-handover`, { method: 'POST', body: { target: 'inst-b', nonce_hash: nonceHash } })).status, 403);
  assert.equal((await person.go(`${a.origin}/api/sign-in-handover`, { method: 'POST', body: { target: 'inst-b', nonce_hash: nonceHash }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await person.go(`${a.origin}/api/sign-in-handover`, { method: 'POST', body: { target: 'inst-b', nonce_hash: nonceHash }, headers: { origin: a.origin, 'sec-fetch-site': 'cross-site' } })).status, 403);
  const stranger = browser();
  assert.equal((await stranger.go(`${a.origin}/api/sign-in-handover`, { method: 'POST', body: { target: 'inst-b', nonce_hash: nonceHash }, headers: { origin: a.origin } })).status, 404); // the login gate
  const peers = await person.go(`${a.origin}/api/sign-in-handover/peers`);
  assert.deepEqual(peers.json.peers.map(peer => [peer.name, peer.online, peer.supported, peer.accepting, peer.addresses]), [['K01', true, true, true, []]]); // B's 127.0.0.1 address is loopback: never offered
  const issued = await person.go(`${a.origin}/api/sign-in-handover`, { method: 'POST', body: { target: 'inst-b', nonce_hash: nonceHash }, headers: { origin: a.origin } });
  assert.equal(issued.status, 201, issued.text);
  assert.equal(issued.headers.get('cache-control'), 'no-store');
  const { token } = issued.json;

  // The browser opens B: the fragment never reaches B's server, the login page posts it (same origin of B).
  assert.equal((await person.go(`${b.origin}${LOGIN}/handover`, { method: 'POST', body: { token, nonce }, headers: { origin: a.origin } })).status, 403); // from A's page: refused
  const redeemed = await person.go(`${b.origin}${LOGIN}/handover`, { method: 'POST', body: { token, nonce, return_to: '/h5' }, headers: { origin: b.origin } });
  assert.equal(redeemed.status, 200, redeemed.text);
  assert.deepEqual(redeemed.json, { success: true, from: 'T01', redirect: '/h5' });
  const cookie = redeemed.setCookie.find(line => line.startsWith('ta.sid='));
  assert.ok(cookie, 'B sets its own session cookie');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.equal((await person.go(`${b.origin}/`)).text, 'page of K01');

  // Used once: another browser with the same token and nonce gets nothing.
  const thief = browser();
  const replay = await thief.go(`${b.origin}${LOGIN}/handover`, { method: 'POST', body: { token, nonce }, headers: { origin: b.origin } });
  assert.equal(replay.status, 409);
  assert.equal(replay.json.error, 'HANDOVER_USED');
  assert.equal((await thief.go(`${b.origin}/`)).status, 302);
  // A forged token does not sign anyone in either.
  const forged = await thief.go(`${b.origin}${LOGIN}/handover`, { method: 'POST', body: { token: `${token.split('.')[0]}.${'A'.repeat(43)}`, nonce }, headers: { origin: b.origin } });
  assert.equal(forged.status, 400);
  assert.equal(forged.json.error, 'HANDOVER_INVALID');
  assert.equal(thief.jar(b.origin).size, 0);

  // A session that came from a hand-over is not a recent verification: replacing B's authenticator asks for B's code.
  const replace = await person.go(`${b.origin}${LOGIN}/setup/start`, { method: 'POST', body: {}, headers: { origin: b.origin } });
  assert.equal(replace.status, 401);
  assert.equal(replace.json.error, 'AUTH_RECENT_VERIFICATION_REQUIRED');

  // B's switch off: a fresh hand-over is refused by A already (B said so over the link).
  B.handover.setAccepting(false);
  const off = await person.go(`${a.origin}/api/sign-in-handover`, { method: 'POST', body: { target: 'inst-b', nonce_hash: nonceHash }, headers: { origin: a.origin } });
  assert.equal(off.status, 409);
  assert.equal(off.json.error, 'HANDOVER_OFF_THERE');

  // Nothing logged holds the token or the nonce.
  for (const line of [...A.logs, ...B.logs]) assert.ok(!line.includes(token.split('.')[1]) && !line.includes(nonce), line);
});
