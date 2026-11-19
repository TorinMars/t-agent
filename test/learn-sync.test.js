// English learning across linked devices (services/learn-sync.js, services/learn-merge.js, services/learn-sync-store.js, services/device-tier.js;
// "Sync across linked devices" and "Company computer" in docs/design/learn-english.md): the merge rules, the schema 13 -> 14 columns, and services
// running in this process as real HTTP servers joined by service links (the page routes, /v1/info and /v1/learn-sync of each, sealed with the settings
// sync's link keys): both ways, conflicts, a chain, paging, an older peer, a moved card, and the company computer (home, cache, queue, hand-over).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const Database = require('better-sqlite3');

const merge = require('../services/learn-merge');
const syncStore = require('../services/learn-sync-store');
const { createLearn } = require('../services/learn');
const { createLearnRouter } = require('../routes/learn');
const { createLearnSync, CAPABILITY } = require('../services/learn-sync');
const { createEngineLearnSyncRouter } = require('../routes/learn-sync');
const { createSettingsSync } = require('../services/settings-sync');
const { createDeviceTier, CAPABILITY: TIER_CAPABILITY } = require('../services/device-tier');
const { createDeviceTierRouter } = require('../routes/device-tier');
const { createEngineDeviceSettingsRouter, createDeviceSettingsRouter } = require('../routes/device-settings');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const TZ = 'UTC';
const ZH = '\u5408\u5e76';
const ZH2 = '\u5408\u5e76\u4ee3\u7801';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const settle = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await settle(40);
  }
}

function database(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-sync-'));
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

// ---- Merge rules (pure) ----
const base = (extra = {}) => ({
  kind: 'word', en: 'merge', zh: '', source: 'lookup', context: '', suspended: 0, created_at: 100, content_at: 10, content_by: 'a',
  due_at: 100, interval_days: 0, ease: 2.5, reps: 0, lapses: 0, last_result: null, last_at: null, last_correct: null, state_at: 0, state_by: 'a', ...extra,
});

test('merge: each half goes to its later version, a tie to the greater instance id; a meaning is never replaced by an empty one', () => {
  assert.equal(merge.later(2, 'a', 1, 'z'), true);
  assert.equal(merge.later(1, 'b', 1, 'a'), true);
  assert.equal(merge.later(1, 'a', 1, 'a'), false);
  // An answer on A (state) and a meaning edit on B (content) both survive, in either order.
  const a = base({ state_at: 50, state_by: 'a', reps: 1, interval_days: 1, due_at: 9000, last_result: 'good', last_at: 50, last_correct: 1 });
  const b = base({ content_at: 60, content_by: 'b', zh: ZH, created_at: 90 });
  for (const [local, incoming] of [[a, b], [b, a]]) {
    const { card, changed } = merge.mergeCard(local, incoming);
    assert.equal(changed, true);
    assert.equal(card.zh, ZH);
    assert.equal(card.reps, 1);
    assert.equal(card.due_at, 9000);
    assert.equal(card.created_at, 90, 'the earliest creation');
  }
  // The later content with an empty meaning keeps the meaning there.
  const empty = base({ content_at: 99, content_by: 'b', suspended: 1 });
  const kept = merge.mergeCard(base({ zh: ZH }), empty).card;
  assert.equal(kept.zh, ZH);
  assert.equal(kept.suspended, 1);
  // The same card merged again changes nothing (an echo stops).
  const once = merge.mergeCard(a, b).card;
  assert.equal(merge.mergeCard(once, b).changed, false);
  assert.equal(merge.mergeCard(once, a).changed, false);
  // Following a move: only the state and a missing meaning come over, never the text.
  const followed = merge.mergeCard(base({ en: 'deploy', content_at: 5 }), base({ en: 'deploi', content_at: 70, zh: ZH, state_at: 80, reps: 3 }), { follow: true }).card;
  assert.equal(followed.en, 'deploy');
  assert.equal(followed.zh, ZH);
  assert.equal(followed.reps, 3);
});

test('merge: what a peer sends is checked; norm is computed here, never taken from the wire', () => {
  const wire = merge.cardToPeer({ ...base(), id: 1, owner: 'x', norm: 'merge', content_by: '', state_by: '' }, 'me-id');
  assert.equal(wire.content_by, 'me-id', "'' is this device");
  assert.equal(wire.suspended, false);
  const back = merge.cardFromPeer({ ...wire, en: '  Merge ' }, 'sender');
  assert.equal(back.norm, 'merge');
  assert.equal(back.content_by, 'me-id');
  for (const broken of [{ kind: 'phrase' }, { en: 'not { code }' }, { ease: 'x' }, { suspended: 1 }, { last_result: 'great' }, { created_at: -1 }, { zh: 5 }]) {
    assert.equal(merge.cardFromPeer({ ...wire, ...broken }, 'sender'), null, JSON.stringify(broken));
  }
  assert.equal(merge.cardFromPeer({ ...wire, content_by: 'bad id!' }, 'sender').content_by, 'sender');
  assert.equal(merge.reviewFromPeer({ uid: 'short', kind: 'word', norm: 'merge', at: 1, mode: 'review', grade: 'good', correct: true }), null);
  assert.equal(merge.reviewFromPeer({ uid: crypto.randomUUID(), kind: 'word', norm: 'Merge', at: 1, mode: 'review', grade: 'good', correct: true }), null, 'a norm must be normalized');
  assert.equal(merge.moveFromPeer({ kind: 'word', norm: 'a', moved_to: 'a', at: 1 }, 's'), null);
  assert.throws(() => merge.settingsFromPeer({ daily_goal: 0 }, { dev: {} }), /INVALID_SYNC_VALUE/);
  assert.deepEqual(merge.settingsFromPeer({ collect: false, daily_goal: 5, starter: null }, { dev: {} }), { collect: false, daily_goal: 5, starter: null });
});

// ---- Schema 13 -> 14 ----
test('schema 13 -> 14: an old database with cards and answers gets the sync columns without loss; running it again changes nothing', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-migrate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new Database(path.join(dir, 'db.sqlite'));
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  // The schema 13 tables, as v2.141 made them.
  db.exec(`CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE learn_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, kind TEXT NOT NULL, en TEXT NOT NULL, norm TEXT NOT NULL,
      zh TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, due_at INTEGER NOT NULL,
      interval_days REAL NOT NULL DEFAULT 0, ease REAL NOT NULL DEFAULT 2.5, reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0,
      last_result TEXT, last_at INTEGER, last_correct INTEGER, suspended INTEGER NOT NULL DEFAULT 0, UNIQUE (owner, kind, norm));
    CREATE INDEX idx_learn_cards_due ON learn_cards (owner, suspended, due_at);
    CREATE TABLE learn_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL REFERENCES learn_cards(id) ON DELETE CASCADE,
      owner TEXT NOT NULL, at INTEGER NOT NULL, mode TEXT NOT NULL, grade TEXT NOT NULL, correct INTEGER NOT NULL, answer TEXT);`);
  db.prepare("INSERT INTO learn_cards (owner, kind, en, norm, zh, source, created_at, due_at, reps, last_result, last_at, last_correct) VALUES ('me', 'word', 'merge', 'merge', ?, 'lookup', 1, 2, 2, 'good', 5000, 1)").run(ZH);
  db.prepare("INSERT INTO learn_cards (owner, kind, en, norm, source, created_at, due_at) VALUES ('me', 'word', 'deploy', 'deploy', 'starter', 1, 2)").run();
  for (const at of [4000, 5000]) db.prepare("INSERT INTO learn_reviews (card_id, owner, at, mode, grade, correct) VALUES (1, 'me', ?, 'review', 'good', 1)").run(at);

  syncStore.ensureSyncSchema(db);
  syncStore.ensureSyncSchema(db);
  db.exec(SCHEMA); // what db/index.js runs next: every table and index is already there
  const cards = db.prepare('SELECT * FROM learn_cards ORDER BY id').all();
  assert.equal(cards.length, 2);
  assert.equal(cards[0].zh, ZH);
  assert.deepEqual(cards.map(card => [card.content_at, card.content_by, card.state_at, card.state_by]), [[0, '', 5000, ''], [0, '', 0, '']]);
  const reviews = db.prepare('SELECT * FROM learn_reviews ORDER BY id').all();
  assert.equal(reviews.length, 2);
  assert.ok(reviews.every(row => typeof row.uid === 'string' && row.uid.length >= 16));
  assert.notEqual(reviews[0].uid, reviews[1].uid);
  const seqs = [...cards, ...reviews].map(row => row.sync_seq);
  assert.equal(new Set(seqs).size, seqs.length, 'every row has its own change number');
  assert.ok(seqs.every(seq => seq > 0));
  for (const index of ['idx_learn_cards_seq', 'idx_learn_reviews_uid', 'idx_learn_reviews_seq', 'idx_learn_card_moves_seq']) {
    assert.equal(db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?").pluck().get(index), 1, index);
  }
  // The service works on the migrated database: a new answer gets a later number and its own uid.
  const learn = createLearn({ db, timeZone: TZ, lookupWord: null });
  learn.answer('me', 1, { mode: 'review', grade: 'good', correct: true });
  const last = db.prepare('SELECT * FROM learn_reviews ORDER BY id DESC LIMIT 1').get();
  assert.ok(last.sync_seq > Math.max(...seqs));
  assert.match(last.uid, /^[0-9a-f-]{36}$/);
  assert.equal(learn.summary('me').words, 2);
});

// ---- Services in this process, joined by links ----
const pass = (req, res, next) => next();

async function makeNetwork(t, names, { links: pairs, pageSize = 200, capabilities = {}, company = [] } = {}) {
  const sides = {};
  for (const name of names) {
    const db = database(t);
    const instanceId = crypto.randomUUID();
    const tier = createDeviceTier({ db });
    if (company.includes(name)) tier.setCompany(true);
    const side = { name, db, instanceId, tier, peers: [], issued: new Map(), linkByToken: new Map(), requests: [], capabilities: capabilities[name] || [CAPABILITY, TIER_CAPABILITY] };
    const linkListeners = new Set();
    side.links = {
      peers: () => side.peers,
      onChange: listener => { linkListeners.add(listener); return () => linkListeners.delete(listener); },
      emit: id => { for (const listener of linkListeners) listener(id); },
      noteUnauthorized() {},
    };
    side.settingsSync = createSettingsSync({
      db, sessionSecret: `${name}-secret-${name}-secret`, serviceLinks: side.links, registry: [], owner: () => 'me',
      identity: () => ({ instance_id: instanceId, name }),
      issuedTokenHash: peer => { const token = side.issued.get(peer.id); return token ? sha(token) : null; },
      request: null, log: { warn() {}, info() {} }, intervalMs: 0,
    });
    side.learn = createLearn({ db, timeZone: TZ, lookupWord: null, cacheOnly: () => side.sync.cacheOnly() });
    side.sync = createLearnSync({
      db, serviceLinks: side.links, owner: () => 'me', identity: () => ({ instance_id: instanceId, name }),
      linkKeys: { publicKey: () => side.settingsSync.publicKey(), linkKey: (peer, key) => side.settingsSync.linkKey(peer, key) },
      tier, learn: side.learn, timeZone: TZ, log: { warn: message => side.logs.push(message), info() {} }, intervalMs: 0, debounceMs: 30, companyDebounceMs: 10, pageSize,
      request: async (baseUrl, route, token, opts = {}) => {
        const peer = side.peers.find(candidate => candidate.baseUrl === baseUrl);
        if (!peer || !peer.online) throw Object.assign(new Error('REMOTE_OFFLINE'), { statusCode: 502 });
        side.requests.push(`${opts.method || 'GET'} ${route.split('?')[0]}`);
        const response = await fetch(baseUrl + route, {
          method: opts.method || 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: AbortSignal.timeout(opts.timeoutMs || 15000),
        });
        const text = await response.text();
        const body = text ? JSON.parse(text) : null;
        if (!response.ok) throw Object.assign(new Error(body && /^[A-Z0-9_]+$/.test(body.error || '') ? body.error : `REMOTE_HTTP_${response.status}`), { statusCode: response.status, peerBody: body });
        return body;
      },
    });
    side.logs = [];
    const app = express();
    app.use(express.json({ limit: '32mb' }));
    app.use('/api/learn', createLearnRouter({ service: side.learn, sync: side.sync, requireAuth: (req, res, next) => { req.session = { user: { login: 'me' } }; next(); }, clientOrigin: pass }));
    app.use('/api/device-tier', createDeviceTierRouter({ tier: () => tier }));
    const engineAuth = () => (req, res, next) => {
      const token = (req.get('Authorization') || '').replace(/^Bearer /, '');
      if (!side.linkByToken.has(token)) return res.status(401).json({ error: 'UNAUTHORIZED' });
      req.engineAuth = { tokenId: token, role: 'admin' };
      next();
    };
    app.get('/v1/info', engineAuth(), (req, res) => res.json({ engine_id: instanceId, name, capabilities: side.capabilities, company_computer: tier.isCompany() }));
    app.use('/v1/learn-sync', createEngineLearnSyncRouter({ service: () => side.sync, serviceLinks: () => ({ linkForToken: token => side.linkByToken.get(token) || null }), requireEngineAuth: engineAuth, enabled: () => true }));
    app.use('/v1/device-settings', createEngineDeviceSettingsRouter({ serviceLinks: { linkForToken: token => side.linkByToken.get(token) || null }, requireEngineAuth: engineAuth, deviceTier: () => createDeviceTierRouter({ tier: () => tier }) }));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => new Promise(resolve => { side.sync.stop(); server.closeAllConnections(); server.close(resolve); }));
    side.base = `http://127.0.0.1:${server.address().port}`;
    side.page = async (method, route, body) => {
      const response = await fetch(`${side.base}/api${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    sides[name] = side;
  }
  let serial = 0;
  for (const [x, y] of pairs || []) {
    serial += 1;
    const linkId = `link-${serial}-${x}-${y}`;
    const tokenXY = `tae_${crypto.randomBytes(32).toString('base64url')}`; // x calls y with it (y issued it)
    const tokenYX = `tae_${crypto.randomBytes(32).toString('base64url')}`;
    const X = sides[x];
    const Y = sides[y];
    X.peers.push({ id: linkId, name: y, online: true, remoteServerId: serial, instanceId: Y.instanceId, baseUrl: Y.base, token: tokenXY });
    Y.peers.push({ id: linkId, name: x, online: true, remoteServerId: serial, instanceId: X.instanceId, baseUrl: X.base, token: tokenYX });
    X.issued.set(linkId, tokenYX);
    Y.issued.set(linkId, tokenXY);
    Y.linkByToken.set(tokenXY, { id: linkId, revoked: false, peer_instance_id: X.instanceId });
    X.linkByToken.set(tokenYX, { id: linkId, revoked: false, peer_instance_id: Y.instanceId });
  }
  return sides;
}
const setOnline = (side, peerName, online) => { side.peers.find(peer => peer.name === peerName).online = online; };
const cardsOf = side => side.db.prepare("SELECT * FROM learn_cards WHERE owner = 'me' ORDER BY kind, norm").all();
const reviewsOf = side => side.db.prepare("SELECT r.uid, c.kind, c.norm, r.grade FROM learn_reviews r JOIN learn_cards c ON c.id = r.card_id WHERE r.owner = 'me' ORDER BY r.uid").all();
const view = side => cardsOf(side).map(card => ({ kind: card.kind, norm: card.norm, en: card.en, zh: card.zh, suspended: card.suspended, due_at: card.due_at, reps: card.reps, ease: card.ease, interval_days: card.interval_days }));
const noStarter = side => side.page('PUT', '/learn/settings', { starter: null });
const word = (en, extra = {}) => ({ kind: 'word', en, source: 'manual', ...extra });
const sentence = en => ({ kind: 'sentence', en, source: 'manual', zh: ZH });
const summaryOf = async side => { const { body } = await side.page('GET', '/learn/summary'); return { due: body.due, done_today: body.done_today, streak: body.streak, words: body.words, sentences: body.sentences, mistakes: body.mistakes, goal: body.goal }; };

test('two linked services: cards, answers and settings made on each side reach the other; an answer on A and a meaning edit on B both survive', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  await noStarter(A);
  const merged = (await A.page('POST', '/learn/cards', word('merge'))).body.card;
  await A.page('POST', '/learn/cards', sentence('Please fix the login page.'));
  await B.page('POST', '/learn/cards', word('deploy', { zh: ZH }));
  await B.page('POST', '/learn/cards', word('merge')); // the same word made on both sides is one card
  await A.page('POST', `/learn/cards/${merged.id}/answer`, { mode: 'review', grade: 'good', correct: true });
  await A.sync.syncAll();
  assert.deepEqual(view(A), view(B));
  assert.equal(cardsOf(A).length, 3);
  assert.equal(reviewsOf(B).length, 1);
  assert.equal((await B.page('GET', '/learn/settings')).body.starter, null, 'the settings travel too');

  // An answer on A and a meaning edit on B of the same card, before either syncs.
  const onB = cardsOf(B).find(card => card.norm === 'merge');
  await A.page('POST', `/learn/cards/${merged.id}/answer`, { mode: 'spell', grade: 'good', correct: true, answer: 'merge' });
  await B.page('PATCH', `/learn/cards/${onB.id}`, { zh: ZH2 });
  await B.sync.syncAll();
  await A.sync.syncAll();
  for (const side of [A, B]) {
    const card = cardsOf(side).find(row => row.norm === 'merge');
    assert.equal(card.zh, ZH2, `${side.name}: the meaning edit survives`);
    assert.equal(card.reps, 2, `${side.name}: the answer survives`);
    assert.equal(card.interval_days, 3);
  }
  assert.deepEqual(reviewsOf(A), reviewsOf(B));
  assert.equal(reviewsOf(A).length, 2);
  assert.deepEqual(await summaryOf(A), await summaryOf(B));
  const summary = await summaryOf(A);
  assert.equal(summary.done_today, 2);
  assert.equal(summary.streak, 1);

  // A local change is pushed by itself after the debounce, without a round being asked for.
  A.sync.start();
  B.sync.start();
  await A.page('POST', '/learn/cards', word('rollback'));
  await until(() => cardsOf(B).some(card => card.norm === 'rollback'), 'the push after a local change');
  await A.page('PUT', '/learn/settings', { daily_goal: 33 });
  await until(async () => (await B.page('GET', '/learn/settings')).body.daily_goal === 33, 'settings pushed');
  // Nothing loops: once both agree, rounds stop sending rows.
  await settle(200);
  const before = A.requests.length + B.requests.length;
  await settle(300);
  assert.equal(A.requests.length + B.requests.length, before, 'no round runs by itself once both agree');
  await A.sync.syncAll();
  assert.ok(!A.requests.slice(before).some(entry => entry.startsWith('PUT') || entry.startsWith('POST')), 'nothing left to send');
});

test('a chain A–B–C reaches C; a large set goes in pages; an older peer without the capability is skipped', async t => {
  const { A, B, C, D } = await makeNetwork(t, ['A', 'B', 'C', 'D'], { links: [['A', 'B'], ['B', 'C'], ['A', 'D']], pageSize: 7, capabilities: { D: [] } });
  await noStarter(A);
  const words = Array.from({ length: 40 }, (_, index) => `word${'abcdefghijklmnopqrstuvwxyz'[index % 26]}${'abcdefghij'[Math.floor(index / 26)]}`);
  for (const en of words) await A.page('POST', '/learn/cards', word(en));
  const first = cardsOf(A)[0];
  for (let index = 0; index < 10; index += 1) await A.page('POST', `/learn/cards/${first.id}/answer`, { mode: 'review', grade: index % 2 ? 'good' : 'again', correct: index % 2 === 1 });
  A.requests.length = 0;
  await A.sync.syncAll();
  assert.ok(A.requests.filter(entry => entry === 'PUT /v1/learn-sync').length >= 6, `in pages: ${A.requests.join(', ')}`);
  assert.equal(cardsOf(B).length, 40);
  assert.equal(reviewsOf(B).length, 10);
  // B passes it on to C.
  await B.sync.syncAll();
  assert.deepEqual(view(C), view(A));
  assert.deepEqual(reviewsOf(C), reviewsOf(A));
  assert.deepEqual(await summaryOf(C), await summaryOf(A));
  // C answers; it goes back through B to A.
  const onC = cardsOf(C).find(card => card.norm === first.norm);
  await C.page('POST', `/learn/cards/${onC.id}/answer`, { mode: 'review', grade: 'good', correct: true });
  await C.sync.syncAll();
  await B.sync.syncAll();
  assert.equal(reviewsOf(A).length, 11);
  assert.deepEqual(view(A), view(C));
  // D is an older version: only /v1/info was read, nothing was sent, and it is marked unsupported.
  assert.equal(cardsOf(D).length, 0);
  assert.equal(A.sync.peerStates()[A.peers.find(peer => peer.name === 'D').id].supported, false);
});

test('a card whose text changed on one side moves on the other too, with the answers given there under the old text', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  await noStarter(A);
  const card = (await A.page('POST', '/learn/cards', sentence('Please deploi the new build now.'))).body.card;
  await A.sync.syncAll();
  const onB = cardsOf(B)[0];
  // B answers under the old text while A fixes the text.
  await B.page('POST', `/learn/cards/${onB.id}/answer`, { mode: 'build', grade: 'good', correct: true });
  assert.equal((await A.page('PATCH', `/learn/cards/${card.id}`, { en: 'Please deploy the new build now.' })).status, 200);
  await B.sync.syncAll();
  await A.sync.syncAll();
  for (const side of [A, B]) {
    const cards = cardsOf(side);
    assert.equal(cards.length, 1, `${side.name}: one card`);
    assert.equal(cards[0].en, 'Please deploy the new build now.');
    assert.equal(cards[0].reps, 1, `${side.name}: the answer under the old text is kept`);
    assert.equal(reviewsOf(side).length, 1);
    assert.equal(reviewsOf(side)[0].norm, 'please deploy the new build now.');
  }
  // Adding the old text again later makes a new card there on both sides.
  await B.page('POST', '/learn/cards', sentence('Please deploi the new build now.'));
  await B.sync.syncAll();
  assert.equal(cardsOf(A).length, 2);
});

// ---- Company computer ----
test('the company computer flag: set on the machine and from a linked page, told to the peers in /v1/info', async t => {
  const { T, K } = await makeNetwork(t, ['T', 'K'], { links: [['T', 'K']] });
  assert.deepEqual((await K.page('GET', '/device-tier')).body, { company_computer: false });
  assert.equal((await K.page('PUT', '/device-tier', { company_computer: 'yes' })).status, 400);
  assert.deepEqual((await K.page('PUT', '/device-tier', { company_computer: true })).body, { company_computer: true });
  assert.equal(K.tier.isCompany(), true);
  // T learns it from K's /v1/info in its round.
  await T.sync.syncAll();
  assert.equal(T.sync.peerStates()[T.peers[0].id].company, true);
  // T's page lists K with the flag, and turns it off through the per-device settings path.
  const tokenOf = id => T.peers.find(peer => peer.remoteServerId === id).token;
  const rows = [{ id: 1, name: 'K', status: 'online', base_url: K.base, token_cipher: 'x' }];
  const pageRouter = createDeviceSettingsRouter({
    db: { prepare: () => ({ all: () => rows }) },
    serviceLinks: { linkForServer: id => (id === 1 ? { id: T.peers[0].id, revoked: false } : null), noteUnauthorized() {} },
    decrypt: () => tokenOf(1),
    readInfo: async (row, token) => (await fetch(`${row.base_url}/v1/info`, { headers: { Authorization: `Bearer ${token}` } })).json(),
    request: async (baseUrl, route, token, opts) => {
      const response = await fetch(baseUrl + route, { method: opts.method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error(body.error), { statusCode: response.status, peerBody: body });
      return body;
    },
  });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { user: { login: 'me' } }; next(); });
  app.use('/api/device-settings', pageRouter);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/device-settings`;
  const devices = await (await fetch(`${base}/devices`)).json();
  assert.deepEqual(devices.devices, [{ id: 1, name: 'K', online: true, supported: false, company_computer: true }]);
  const read = await (await fetch(`${base}/1/device-tier`)).json();
  assert.deepEqual(read, { company_computer: true });
  const changed = await (await fetch(`${base}/1/device-tier`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_computer: false, extra: 1 }) })).json();
  assert.deepEqual(changed, { company_computer: false });
  assert.equal(K.tier.isCompany(), false);
  assert.equal((await (await fetch(`${base}/devices`)).json()).devices[0].company_computer, false, 'the list shows the change at once');
});

test('a company computer: its history is handed over once, answers go to the home at once, it keeps only the cards, and the summary comes from the home', async t => {
  const { T, K } = await makeNetwork(t, ['T', 'K'], { links: [['T', 'K']] });
  await noStarter(T);
  await noStarter(K);
  // K was a normal machine with its own history before it was marked.
  const old = (await K.page('POST', '/learn/cards', word('latency'))).body.card;
  for (const grade of ['good', 'again']) await K.page('POST', `/learn/cards/${old.id}/answer`, { mode: 'review', grade, correct: grade === 'good' });
  await T.page('POST', '/learn/cards', word('timeout', { zh: ZH }));
  const onT = cardsOf(T)[0];
  await T.page('POST', `/learn/cards/${onT.id}/answer`, { mode: 'review', grade: 'good', correct: true });
  K.tier.setCompany(true);
  await T.sync.syncAll(); // T learns K is a company computer and leaves it alone
  assert.equal(cardsOf(T).length, 1, 'a normal machine never pulls from a company computer itself');
  await K.sync.syncAll();
  assert.equal(K.sync.cacheOnly(), true);
  // K's history is on T now, and gone from K; K keeps every card as its cache.
  assert.equal(reviewsOf(T).length, 3);
  assert.equal(reviewsOf(K).length, 0, 'no review history on the company computer');
  assert.deepEqual(view(K), view(T));
  assert.equal(cardsOf(T).find(card => card.norm === 'latency').lapses, 1);
  let status = (await K.page('GET', '/learn/status')).body;
  assert.deepEqual(status, { company_computer: true, cache_only: true, home_name: 'T', home_online: true, waiting: 0 });

  // An answer on K goes to T at once (no round asked for), then leaves K.
  K.sync.start();
  T.sync.start();
  const cached = cardsOf(K).find(card => card.norm === 'timeout');
  await K.page('POST', `/learn/cards/${cached.id}/answer`, { mode: 'review', grade: 'good', correct: true });
  await until(() => reviewsOf(T).length === 4, 'the answer reaches the home');
  await until(() => reviewsOf(K).length === 0, 'and leaves the company computer');
  // An answer on T shows on K's page at its next read (the read syncs with the home first).
  await T.page('POST', `/learn/cards/${onT.id}/answer`, { mode: 'review', grade: 'again', correct: false });
  assert.equal((await K.page('GET', '/learn/queue?mode=review')).status, 200);
  const fresh = cardsOf(K).find(card => card.norm === 'timeout');
  assert.equal(fresh.lapses, 1, 'the card failed on T is failed on K too');
  assert.equal(fresh.due_at, cardsOf(T).find(card => card.norm === 'timeout').due_at);
  assert.equal(reviewsOf(K).length, 0, 'the history still is not copied to K');
  // The summary on K is T's.
  const fromHome = (await K.page('GET', '/learn/summary')).body;
  const onHome = (await T.page('GET', '/learn/summary')).body;
  for (const key of ['due', 'done_today', 'streak', 'mistakes', 'words', 'goal']) assert.equal(fromHome[key], onHome[key], key);
  assert.equal(fromHome.device.home_online, true);
  assert.equal(onHome.device.company_computer, false);
  // Settings are changed on T through K's page.
  assert.equal((await K.page('PUT', '/learn/settings', { daily_goal: 12 })).body.daily_goal, 12);
  assert.equal((await T.page('GET', '/learn/settings')).body.daily_goal, 12);
  assert.equal((await K.page('PUT', '/learn/settings', { daily_goal: 0 })).status, 400, "the home's check answers");

  // T goes away: K keeps reviewing from its cache, its answers wait, the summary is the last copy plus them.
  K.sync.stop();
  T.sync.stop();
  setOnline(K, 'T', false);
  setOnline(T, 'K', false);
  const doneBefore = fromHome.done_today;
  await K.page('POST', `/learn/cards/${cached.id}/answer`, { mode: 'review', grade: 'good', correct: true });
  const added = (await K.page('POST', '/learn/cards', word('throughput'))).body.card;
  assert.ok(added.id);
  status = (await K.page('GET', '/learn/status')).body;
  assert.equal(status.home_online, false);
  assert.equal(status.home_name, 'T');
  assert.equal(status.waiting, 2, 'one answer and one new card wait');
  const offline = (await K.page('GET', '/learn/summary')).body;
  assert.equal(offline.done_today, doneBefore + 1);
  assert.equal(offline.words, 3);
  assert.equal(offline.device.home_online, false);
  assert.ok(offline.device.offline_copy_at);
  assert.equal((await K.page('PUT', '/learn/settings', { daily_goal: 9 })).status, 503);
  // T is back: the queue is handed over and removed from K.
  setOnline(K, 'T', true);
  setOnline(T, 'K', true);
  await K.sync.syncAll();
  assert.equal(reviewsOf(K).length, 0);
  assert.equal(reviewsOf(T).length, 6);
  assert.ok(cardsOf(T).some(card => card.norm === 'throughput'));
  assert.equal((await K.page('GET', '/learn/status')).body.waiting, 0);
});

test('every machine marked as a company computer: nothing moves and nothing is lost', async t => {
  const { K1, K2 } = await makeNetwork(t, ['K1', 'K2'], { links: [['K1', 'K2']], company: ['K1', 'K2'] });
  await noStarter(K1);
  await noStarter(K2);
  const card = (await K1.page('POST', '/learn/cards', word('merge'))).body.card;
  await K1.page('POST', `/learn/cards/${card.id}/answer`, { mode: 'review', grade: 'good', correct: true });
  await K1.sync.syncAll();
  await K2.sync.syncAll();
  assert.equal(K1.sync.cacheOnly(), false);
  assert.equal(cardsOf(K2).length, 0);
  assert.equal(reviewsOf(K1).length, 1, 'kept where it is');
  const summary = (await K1.page('GET', '/learn/summary')).body;
  assert.equal(summary.done_today, 1);
  assert.deepEqual(summary.device, { company_computer: true, cache_only: false, home_name: null, home_online: null, waiting: 0, offline_copy_at: null });
});

test('the starter list imported on both sides is one set of cards after the first merge, and an answer to one of them wins', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  await A.page('GET', '/learn/summary');
  await B.page('GET', '/learn/summary');
  const count = cardsOf(A).length;
  assert.ok(count > 200);
  const first = cardsOf(B)[0];
  await B.page('POST', `/learn/cards/${first.id}/answer`, { mode: 'review', grade: 'good', correct: true });
  await A.sync.syncAll();
  await B.sync.syncAll();
  assert.equal(cardsOf(A).length, count);
  assert.deepEqual(view(A), view(B));
  assert.equal(cardsOf(A).find(card => card.norm === first.norm).reps, 1);
  assert.deepEqual(await summaryOf(A), await summaryOf(B));
});
