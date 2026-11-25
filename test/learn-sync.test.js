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

// db/index.js (required by the services below) refuses to run a test on the real ~/.tagent: a temporary data folder first.
process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-sync-data-'));
delete process.env.TAGENT_HOME;
const express = require('express');
const Database = require('better-sqlite3');

const merge = require('../services/learn-merge');
const syncStore = require('../services/learn-sync-store');
const { createLearn, LearnError } = require('../services/learn');
const { createLearnRouter } = require('../routes/learn');
const { createLearnSync, CAPABILITY, REPORTS_CAPABILITY } = require('../services/learn-sync');
const { createLearnAnalysis } = require('../services/learn-analysis');
const { createLearnPick } = require('../services/learn-pick');
const { createLearnAsk } = require('../services/learn-ask');
const { createLearnChat } = require('../services/learn-chat');
const { createLearnCoach } = require('../services/learn-coach');
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

test('merge: a phonetic transcription travels with the content, is never replaced by an empty one, and never follows a move', () => {
  const ipa = '/m\u025crd\u0292/';
  // Filled on one side without a new content time (a lookup): it comes over whichever side has the later content.
  for (const [local, incoming] of [[base({ phonetic: ipa }), base({ content_at: 99, content_by: 'b', zh: ZH })], [base({ content_at: 99, content_by: 'b', zh: ZH }), base({ phonetic: ipa })]]) {
    const { card, changed } = merge.mergeCard(local, incoming);
    assert.equal(card.phonetic, ipa);
    assert.equal(card.zh, ZH);
    assert.equal(changed, true);
  }
  // An older peer (schema 14) sends no transcription: the one here stays, and nothing changes.
  const older = merge.cardToPeer({ ...base(), id: 1, owner: 'x', norm: 'merge' }, 'old');
  delete older.phonetic;
  const fromOlder = merge.cardFromPeer(older, 'old');
  assert.equal(fromOlder.phonetic, '');
  assert.equal(merge.mergeCard(base({ phonetic: ipa, content_by: 'old' }), fromOlder).card.phonetic, ipa);
  // A moved card's transcription is that of its old text.
  assert.equal(merge.mergeCard(base({ en: 'deploy' }), base({ en: 'deploi', phonetic: '/x/' }), { follow: true }).card.phonetic, '');
  // Checked on the way in: a sentence has none, odd text is dropped.
  const wire = merge.cardToPeer({ ...base({ phonetic: ipa }), id: 1, owner: 'x', norm: 'merge' }, 'me-id');
  assert.equal(wire.phonetic, ipa);
  assert.equal(merge.cardFromPeer({ ...wire, phonetic: '<script>' }, 's').phonetic, '');
  assert.equal(merge.cardFromPeer({ ...wire, kind: 'sentence', en: 'Please merge it now.', phonetic: ipa }, 's').phonetic, '');
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
  // The audio settings travel with them; a value this version does not know is left out (the default here), never an error.
  assert.deepEqual(merge.settingsFromPeer({ collect: true, audio_repeat: 5, audio_speed: 'slow', audio_words: false, audio_pause: 9, audio_sentences_at: 'later' }, { dev: {} }),
    { collect: true, audio_repeat: 5, audio_speed: 'slow', audio_words: false });
  // The voice ("DeepSeek voice" in docs/design/learn-english-voice.md) too; an unknown engine or voice is left out.
  assert.deepEqual(merge.settingsFromPeer({ voice_engine: 'deepseek', voice_id: 'tide' }, { dev: {} }), { voice_engine: 'deepseek', voice_id: 'tide' });
  assert.deepEqual(merge.settingsFromPeer({ voice_engine: 'cloud', voice_id: 'echo' }, { dev: {} }), {});
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
  // The answered card is replayed with FSRS by the schema 22 step of the same migration: its state gets a new clock (after its last answer, 5000);
  // the starter word without answers stays new with clock 0.
  assert.deepEqual(cards.map(card => [card.content_at, card.content_by, card.state_by]), [[0, '', ''], [0, '', '']]);
  assert.ok(cards[0].state_at > 5000);
  assert.equal(cards[1].state_at, 0);
  assert.equal(cards[0].fsrs_stability, 2.3065, 'two good answers 1 s apart: the first gives S0(good), the same-day one keeps it');
  assert.equal(cards[1].fsrs_stability, null);
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
    const side = { name, db, instanceId, tier, peers: [], issued: new Map(), linkByToken: new Map(), requests: [], capabilities: capabilities[name] || [CAPABILITY, REPORTS_CAPABILITY, TIER_CAPABILITY] };
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
      loadCoach: () => { if (side.loadCoach) side.loadCoach(); },
      loadSpeech: () => side.speech,
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
    // The mistake analysis with a stubbed model (never a real one): it answers with one finding over every mistake and records the questions.
    side.questions = [];
    side.analysis = createLearnAnalysis({
      learn: side.learn, sync: side.sync, owner: () => 'me', isConfigured: () => true, modelInfo: () => ({ label: 'Stub', model: name }),
      company: () => tier.isCompany(), log: { warn() {}, info() {} },
      chat: async (owner, system, user) => {
        side.questions.push(JSON.parse(user));
        const ids = JSON.parse(user).mistakes.map(item => item.id);
        return JSON.stringify({ summary: `Made on ${name}.`, findings: [{ title: 'All of them', cause: 'c', action: 'a', items: ids }] });
      },
    });
    // The level and the picking with a stubbed model too: the level B1, and the second word of every sentence.
    side.pickQuestions = [];
    side.pick = createLearnPick({
      db, learn: side.learn, sync: side.sync, owner: () => 'me', isConfigured: () => true, company: () => tier.isCompany(), afterSentenceMs: 10, log: { warn() {}, info() {} },
      chat: async (owner, system, user) => {
        const message = JSON.parse(user);
        side.pickQuestions.push(message);
        if (!message.sentences) return JSON.stringify({ level: 'B1', label: 'intermediate', reason: `Estimated on ${name}.` });
        return JSON.stringify({ sentences: message.sentences.map(item => ({ id: item.id, words: [{ word: item.text.split(' ')[1], zh: ZH }] })) });
      },
    });
    t.after(() => side.pick.stop());
    // The questions about a card with a stubbed model too: it names the engine that answered (streamed in two pieces).
    side.askQuestions = [];
    side.ask = createLearnAsk({
      db, learn: side.learn, sync: side.sync, isConfigured: () => true,
      converse: async (owner, system, messages, options) => {
        side.askQuestions.push(messages);
        const pieces = ['Answered ', `on ${name}.`];
        if (options.onDelta) for (const piece of pieces) options.onDelta(piece);
        return pieces.join('');
      },
    });
    // The English chats with a stubbed model too: it names the engine that answered, with a meta line (streamed in two pieces).
    side.chatQuestions = [];
    side.chat = createLearnChat({
      db, learn: side.learn, sync: side.sync, isConfigured: () => true, timeZone: TZ,
      converse: async (owner, system, messages, options) => {
        side.chatQuestions.push(messages);
        const pieces = ['Chatted ', `on ${name}.\n<<meta>>{"cards":[],"mistakes":[],"journal":false,"title":"From ${name}"}`];
        if (options.onDelta) for (const piece of pieces) options.onDelta(piece);
        return pieces.join('');
      },
    });
    // The English coach with a stubbed model too: it names the engine that answered (no tool calls).
    side.coachQuestions = [];
    side.coach = createLearnCoach({
      db, learn: side.learn, sync: side.sync, isConfigured: () => true, timeZone: TZ, activeModel: () => ({ provider: 'stub', model: name }),
      converse: async () => `Folded on ${name}.`,
      converseTools: async (owner, system, messages, options) => {
        side.coachQuestions.push(messages);
        const last = messages[messages.length - 1].content;
        if (/practise/.test(last) && !messages.some(item => item.role === 'tool')) return { content: '', toolCalls: [{ id: 'call_1', name: 'propose_practice', arguments: '{"kind":"today_spelling"}' }] };
        const text = `Coached on ${name}.\n<<meta>>{"cards":[],"mistakes":[],"suggestions":[]}`;
        if (options.onDelta) options.onDelta(text);
        return { content: text, toolCalls: [] };
      },
    });
    // The DeepSeek voice with a stub (never DeepSeek itself): a tiny WAV that names the engine and the text; `speechFails` makes it refuse.
    side.speechCalls = [];
    side.speech = {
      status: () => ({ ready: true, reason: null, voices: ['stella', 'tide'] }),
      speak: async (owner, body) => {
        side.speechCalls.push(body);
        if (side.speechFails) throw new LearnError('DeepSeek could not read this text', 422);
        return tinyWav(`${name}:${body.voice}:${body.text}`);
      },
    };
    const app = express();
    app.use(express.json({ limit: '32mb' }));
    app.use('/api/learn', createLearnRouter({ service: side.learn, sync: side.sync, analysis: side.analysis, pick: side.pick, ask: side.ask, chat: side.chat, coach: side.coach, speech: side.speech, requireAuth: (req, res, next) => { req.session = { user: { login: 'me' } }; next(); }, clientOrigin: pass }));
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
  assert.equal(cardsOf(B).find(card => card.norm === 'merge').phonetic, '/m\u025crd\u0292/', 'the transcription travels with the card');
  // A transcription filled in later on one side (the page sent it with a word the dictionary does not have) reaches the other.
  B.db.prepare("INSERT INTO learn_cards (owner, kind, en, norm, source, created_at, due_at, content_at, sync_seq) VALUES ((SELECT owner FROM learn_cards LIMIT 1), 'word', 'kubectl', 'kubectl', 'manual', 1, 1, 0, 0)").run();
  await B.page('POST', '/learn/cards', word('kubectl', { phonetic: '/ku\u02d0b k\u0259n\u02c8tro\u028al/' }));
  await B.sync.syncAll();
  assert.equal(cardsOf(A).find(card => card.norm === 'kubectl').phonetic, '/ku\u02d0b k\u0259n\u02c8tro\u028al/');

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
    // FSRS-6: the first good gives S0(good) = 2.3065 (2 days); the second on the same day keeps it (the same-day formula never lowers it).
    assert.equal(card.interval_days, 2);
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
  await A.page('PUT', '/learn/settings', { daily_goal: 33, audio_repeat: 3, audio_sentences_at: 'start' });
  await until(async () => (await B.page('GET', '/learn/settings')).body.daily_goal === 33, 'settings pushed');
  const audioOnB = (await B.page('GET', '/learn/settings')).body;
  assert.deepEqual([audioOnB.audio_repeat, audioOnB.audio_sentences_at], [3, 'start'], 'the audio settings are shared too');
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
  assert.deepEqual(devices.devices, [{ id: 1, name: 'K', online: true, supported: false, company_computer: true, environment: false }]);
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

test('the level and the words from translations: a company computer reads and checks the level on its home, and the home picks the sentences it hands over', async t => {
  const { T, K } = await makeNetwork(t, ['T', 'K'], { links: [['T', 'K']] });
  await noStarter(T);
  await noStarter(K);
  for (const en of ['merge', 'branch', 'commit', 'rebase', 'release']) {
    const made = (await T.page('POST', '/learn/cards', word(en, { zh: ZH }))).body.card;
    for (const correct of [true, false]) await T.page('POST', `/learn/cards/${made.id}/answer`, { mode: 'spell', grade: correct ? 'good' : 'again', correct });
  }
  K.tier.setCompany(true);
  await T.sync.syncAll();
  await K.sync.syncAll();
  assert.equal(K.sync.cacheOnly(), true);
  // K's page reads the home's level, and "Check again" runs on the home with its model.
  let level = (await K.page('GET', '/learn/level')).body;
  assert.deepEqual([level.level, level.translator, level.picking.enabled], [null, true, true]);
  const checked = await K.page('POST', '/learn/level/check');
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.equal(checked.body.level.reason, 'Estimated on T.');
  assert.equal(K.pickQuestions.length, 0, 'the company computer never asks a model');
  assert.equal((await T.page('GET', '/learn/level')).body.level.level, 'B1');
  await K.sync.syncAll();
  assert.equal(K.learn.level('me').level, 'B1', 'a copy of the level on the company computer');
  await assert.rejects(K.pick.check('me'), error => error.statusCode === 409);

  // A sentence collected on K goes to T at once and is picked there; the word comes back to K asked inside its sentence.
  K.sync.start();
  T.sync.start();
  const text = 'Please rollback the deploy now.';
  await K.page('POST', '/learn/cards', { kind: 'sentence', en: text, zh: ZH2, source: 'translation' });
  await until(() => cardsOf(T).some(card => card.norm === 'rollback'), 'the home picks the handed-over sentence');
  await K.sync.syncAll();
  const spell = (await K.page('GET', '/learn/queue?mode=spell&limit=50')).body.cards.find(card => card.en === 'rollback');
  assert.deepEqual([spell.context, spell.context_zh, spell.source], [text, ZH2, 'translation']);
  assert.equal(K.pickQuestions.length, 0);
  level = (await K.page('GET', '/learn/level')).body;
  assert.deepEqual([level.picking.picked, level.picking.sentences, level.picking.pending], [1, 1, 0]);

  // The home away: the copy here, said as such; Check again cannot run.
  K.sync.stop();
  T.sync.stop();
  setOnline(K, 'T', false);
  const away = (await K.page('GET', '/learn/level')).body;
  assert.deepEqual([away.offline, away.level.level, away.translator, away.picking.picked], [true, 'B1', false, 1]);
  const refused = await K.page('POST', '/learn/level/check');
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error, 'Your level is kept on a normal computer, which cannot be reached right now');
});

test('questions about a card: a company computer asks its home, which answers with its model and keeps the messages; away, it says so', async t => {
  const { T, K } = await makeNetwork(t, ['T', 'K'], { links: [['T', 'K']] });
  await noStarter(T);
  await noStarter(K);
  await T.page('POST', '/learn/cards', word('deploy', { zh: ZH }));
  K.tier.setCompany(true);
  await T.sync.syncAll();
  await K.sync.syncAll();
  assert.equal(K.sync.cacheOnly(), true);
  const onK = cardsOf(K).find(card => card.norm === 'deploy');
  // A normal engine streams; the company computer's page gets the home's answer as one JSON.
  const streamed = await fetch(`${T.base}/api/learn/cards/${cardsOf(T).find(card => card.norm === 'deploy').id}/ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'On T', mode: 'spell', state: { checked: false } }),
  });
  assert.match(streamed.headers.get('content-type'), /application\/x-ndjson/);
  const lines = (await streamed.text()).split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(lines.slice(0, 2), [{ delta: 'Answered ' }, { delta: 'on T.' }]);
  const asked = await K.page('POST', `/learn/cards/${onK.id}/ask`, { question: 'On K', mode: 'spell', state: { checked: true, answer: 'deplot', correct: false } });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.deepEqual(asked.body.messages.map(item => [item.role, item.text]), [['user', 'On K'], ['assistant', 'Answered on T.']]);
  assert.equal(K.askQuestions.length, 0, 'the company computer never asks a model');
  assert.deepEqual(T.askQuestions[1].map(item => item.content), ['On T', 'Answered on T.', 'On K'], 'the home has the whole conversation');
  const history = (await K.page('GET', `/learn/cards/${onK.id}/ask`)).body;
  assert.deepEqual([history.translator, history.messages.map(item => item.text)], [true, ['On T', 'Answered on T.', 'On K', 'Answered on T.']]);
  assert.equal(K.db.prepare('SELECT COUNT(*) FROM learn_chats').pluck().get(), 0, 'kept on the home only');
  // A card made on the company computer a moment ago: the home gets it first.
  const made = (await K.page('POST', '/learn/cards', word('rollback', { zh: ZH }))).body.card;
  const fresh = await K.page('POST', `/learn/cards/${made.id}/ask`, { question: 'New card', mode: 'spell' });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.ok(cardsOf(T).some(card => card.norm === 'rollback'));
  // Refusals of the home come through with their status.
  const refused = await K.page('POST', `/learn/cards/${onK.id}/ask`, { question: '', mode: 'spell' });
  assert.deepEqual([refused.status, refused.body], [400, { error: 'Enter your question' }]);
  // The home away: no messages and no model, said as such; asking is 503.
  setOnline(K, 'T', false);
  assert.deepEqual((await K.page('GET', `/learn/cards/${onK.id}/ask`)).body, { messages: [], translator: false, offline: true });
  const away = await K.page('POST', `/learn/cards/${onK.id}/ask`, { question: 'Away?', mode: 'spell' });
  assert.deepEqual([away.status, away.body], [503, { error: 'Questions about a card are answered on a normal computer, which cannot be reached right now' }]);
});

test('English chats: a company computer chats on its home, which answers with its model and keeps the chats; away, it says so', async t => {
  const { T, K } = await makeNetwork(t, ['T', 'K'], { links: [['T', 'K']] });
  await noStarter(T);
  await noStarter(K);
  await T.page('POST', '/learn/cards', word('deploy', { zh: ZH }));
  // A chat K had from before it was marked is handed over and leaves it.
  const before = await fetch(`${K.base}/api/learn/chats/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat: null, question: 'Before the flag' }) });
  const beforeUid = JSON.parse((await before.text()).split('\n')[0]).chat.uid;
  K.tier.setCompany(true);
  await T.sync.syncAll();
  await K.sync.syncAll();
  await K.sync.syncAll();
  assert.equal(K.sync.cacheOnly(), true);
  assert.equal(K.db.prepare('SELECT COUNT(*) FROM learn_convos').pluck().get(), 0, 'handed over');
  assert.equal(K.db.prepare('SELECT COUNT(*) FROM learn_convo_messages').pluck().get(), 0);
  assert.equal(T.db.prepare('SELECT COUNT(*) FROM learn_convo_messages').pluck().get(), 2);

  // A normal engine streams; the company computer's page gets the home's answer as one JSON { chat, messages }.
  const streamed = await fetch(`${T.base}/api/learn/chats/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat: null, question: 'On T' }) });
  assert.match(streamed.headers.get('content-type'), /application\/x-ndjson/);
  const lines = (await streamed.text()).split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(lines[0].chat);
  assert.deepEqual(lines.slice(1, 3), [{ delta: 'Chatted' }, { delta: ' on T.' }], 'trailing white space waits for the next piece');
  const asked = await K.page('POST', '/learn/chats/send', { chat: lines[0].chat.uid, question: 'On K' });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.chat.uid, lines[0].chat.uid);
  assert.equal(asked.body.chat.count, 4);
  assert.deepEqual(asked.body.messages.map(item => [item.role, item.text]), [['user', 'On K'], ['assistant', 'Chatted on T.']]);
  assert.equal(K.chatQuestions.length, 1, 'the company computer asked no model after the flag');
  assert.deepEqual(T.chatQuestions[T.chatQuestions.length - 1].map(item => item.content), ['On T', 'Chatted on T.', 'On K'], 'the home has the whole chat');
  const listed = (await K.page('GET', '/learn/chats')).body;
  assert.equal(listed.translator, true);
  assert.deepEqual(listed.chats.map(item => item.title), ['From T', 'From K']);
  const opened = (await K.page('GET', `/learn/chats/${lines[0].chat.uid}`)).body;
  assert.equal(opened.messages.length, 4);
  assert.equal((await K.page('PATCH', `/learn/chats/${lines[0].chat.uid}`, { title: 'Renamed on K', journal: true })).body.chat.title, 'Renamed on K');
  assert.deepEqual([...T.db.prepare('SELECT title, journal, journal_by FROM learn_convos WHERE uid = ?').all(lines[0].chat.uid).map(row => [row.title, row.journal, row.journal_by])], [['Renamed on K', 1, 'person']]);
  assert.equal((await K.page('GET', '/learn/summary')).body.chats, 2, 'the summary is the home\'s');
  assert.equal(listed.chats[1].uid, beforeUid);
  assert.deepEqual((await K.page('DELETE', `/learn/chats/${beforeUid}`)).body, { ok: true });
  assert.equal(T.db.prepare('SELECT deleted FROM learn_convos WHERE uid = ?').pluck().get(beforeUid), 1);
  assert.equal(K.db.prepare('SELECT COUNT(*) FROM learn_convos').pluck().get(), 0, 'kept on the home only');
  // Refusals of the home come through with their status.
  const refused = await K.page('POST', '/learn/chats/send', { chat: null, question: '' });
  assert.deepEqual([refused.status, refused.body], [400, { error: 'Enter your question' }]);
  assert.equal((await K.page('GET', '/learn/chats/aaaaaaaa-0000')).status, 404);
  // The home away: no chats and no model, said as such; the rest is 503.
  setOnline(K, 'T', false);
  assert.deepEqual((await K.page('GET', '/learn/chats')).body, { chats: [], translator: false, offline: true });
  const offline = 'Your English chats are kept on a normal computer, which cannot be reached right now';
  for (const [method, route, body] of [['POST', '/learn/chats/send', { chat: null, question: 'Away?' }], ['GET', `/learn/chats/${lines[0].chat.uid}`], ['DELETE', `/learn/chats/${lines[0].chat.uid}`]]) {
    const away = await K.page(method, route, body);
    assert.deepEqual([away.status, away.body], [503, { error: offline }], route);
  }
});

test('the English coach: a company computer talks to it on its home (one JSON), a plan starts with its own card ids, notes; away, it says so', async t => {
  const { T, K } = await makeNetwork(t, ['T', 'K'], { links: [['T', 'K']] });
  await noStarter(T);
  await noStarter(K);
  await T.page('POST', '/learn/cards', word('separate', { zh: ZH }));
  await T.page('POST', '/learn/cards', word('receive', { zh: ZH }));
  K.tier.setCompany(true);
  await T.sync.syncAll();
  await K.sync.syncAll();
  await K.sync.syncAll();
  assert.equal(K.sync.cacheOnly(), true);

  const asked = await K.page('POST', '/learn/coach/send', { text: 'Hello coach' });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.deepEqual([asked.body.message.text, asked.body.tools], ['Coached on T.', true]);
  assert.deepEqual(asked.body.messages.map(item => item.role), ['user', 'assistant']);
  assert.equal(K.coachQuestions.length, 0, 'the company computer asked no model');
  assert.equal(K.db.prepare("SELECT COUNT(*) FROM learn_convo_messages").pluck().get(), 0, 'kept on the home only');
  assert.equal(T.db.prepare("SELECT COUNT(*) FROM learn_convo_messages WHERE convo_uid = 'coach'").pluck().get(), 2);
  const viewed = (await K.page('GET', '/learn/coach')).body;
  assert.deepEqual([viewed.messages.length, viewed.tools_ok, viewed.settings.read_text], [2, true, true]);

  // A plan proposed on the home starts on the company computer with the cards of the company computer (their ids differ).
  const plan = await K.page('POST', '/learn/coach/send', { text: 'Let me practise' });
  const [proposal] = plan.body.message.meta.proposals;
  assert.equal(proposal.plan.words, 2);
  const started = await K.page('POST', '/learn/coach/plans/start', { message_uid: plan.body.message.uid, proposal_id: proposal.id });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const localIds = K.db.prepare("SELECT id FROM learn_cards WHERE owner = 'me' ORDER BY id").pluck().all();
  assert.deepEqual(started.body.plan.steps[0].cards.map(card => card.id).sort(), localIds.sort());
  assert.ok(started.body.plan.steps[0].cards.every(card => card.next), 'as GET /queue gives them');

  // Notes and the summary are kept on the home.
  T.db.prepare("INSERT INTO learn_coach_notes (owner, uid, text, created_at, updated_at, sync_seq) VALUES ('me', 'note-00001', 'Prefers short answers', 1, 1, 0)").run();
  assert.deepEqual((await K.page('GET', '/learn/coach/notes')).body.notes.map(note => note.text), ['Prefers short answers']);
  assert.equal((await K.page('DELETE', '/learn/coach/notes/note-00001')).status, 200);
  assert.equal(T.db.prepare("SELECT deleted FROM learn_coach_notes WHERE uid = 'note-00001'").pluck().get(), 1);
  assert.deepEqual((await K.page('POST', '/learn/coach/summary/reset')).body, { ok: true });
  const refused = await K.page('POST', '/learn/coach/send', { text: '' });
  assert.deepEqual([refused.status, refused.body], [400, { error: 'Enter your question' }]);

  setOnline(K, 'T', false);
  const away = (await K.page('GET', '/learn/coach')).body;
  assert.deepEqual([away.messages, away.offline, away.translator], [[], true, false]);
  const offline = await K.page('POST', '/learn/coach/send', { text: 'Away?' });
  assert.deepEqual([offline.status, offline.body], [503, { error: 'Your English coach is on a normal computer, which cannot be reached right now' }]);
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

test('mistakes and reports: the detail of a wrong answer and the reports reach every normal engine; one automatic report per week; a company computer reads and analyses on its home', async t => {
  const { A, B, K } = await makeNetwork(t, ['A', 'B', 'K'], { links: [['A', 'B'], ['A', 'K']] });
  for (const side of [A, B, K]) await noStarter(side);
  const card = (await A.page('POST', '/learn/cards', word('necessary'))).body.card;
  await A.page('POST', `/learn/cards/${card.id}/answer`, { mode: 'spell', grade: 'again', correct: false, answer: 'neccesary', tag: 'double-letter', hinted: true });
  await A.sync.syncAll();
  const onB = (await B.page('GET', '/learn/mistakes')).body.mistakes;
  assert.deepEqual(onB.map(item => [item.expected, item.written, item.tag, item.hinted, item.mode]), [['necessary', 'neccesary', 'double-letter', true, 'spell']]);

  // A report made on B reaches A, the same everywhere; the cards behind it are found by text on each engine.
  const made = await B.page('POST', '/learn/reports', { lang: 'en' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  await B.sync.syncAll();
  const onA = (await A.page('GET', '/learn/reports')).body;
  assert.equal(onA.reports.length, 1);
  assert.equal(onA.reports[0].uid, made.body.report.uid);
  assert.deepEqual((await A.page('GET', `/learn/reports/${made.body.report.uid}`)).body.report.findings, made.body.report.findings);
  const found = (await A.page('POST', '/learn/cards/find', { refs: made.body.report.findings[0].cards })).body.cards;
  assert.deepEqual(found.map(item => item.id), [card.id], "A's own id for the card");
  assert.equal(onA.since.mistakes, 0, 'the report covers the mistakes on every engine');

  // The automatic report of one week made on both A and B while they could not see each other: after they meet, both keep the earlier one.
  const autoRow = (side, at) => side.db.prepare(`INSERT INTO learn_reports (owner, uid, created_at, covers_from, covers_until, auto, lang, mistakes, answers, model, body, by, sync_seq)
    VALUES ('me', 'auto-2026-W47', ?, 0, ?, 1, 'en', 10, 20, '', ?, '', ?)`).run(at, at, JSON.stringify({ summary: `from ${side.name}`, kinds: [], findings: [] }), syncStore.nextSeq(side.db));
  autoRow(A, 5000); // times long before the report above, so that one stays the last
  autoRow(B, 4000);
  await A.sync.syncAll();
  await B.sync.syncAll();
  for (const side of [A, B]) {
    const row = side.db.prepare("SELECT body FROM learn_reports WHERE uid = 'auto-2026-W47'").get();
    assert.equal(JSON.parse(row.body).summary, 'from B', `${side.name} keeps the earlier one`);
  }

  // K is a company computer: it keeps no reports and no history; its page reads both from A and asks A to analyse.
  K.tier.setCompany(true);
  await A.sync.syncAll();
  await K.sync.syncAll();
  assert.equal(K.sync.cacheOnly(), true);
  assert.equal(K.db.prepare('SELECT COUNT(*) AS n FROM learn_reports').get().n, 0, 'no report is copied to a company computer');
  const cached = cardsOf(K).find(row => row.norm === 'necessary');
  await K.page('POST', `/learn/cards/${cached.id}/answer`, { mode: 'spell', grade: 'again', correct: false, answer: 'necesary', tag: 'double-letter' });
  const list = (await K.page('GET', '/learn/mistakes')).body;
  assert.deepEqual(list.mistakes.map(item => item.written), ['necesary', 'neccesary'], "the home's list, with the answer just given here");
  assert.equal(list.offline, undefined);
  const view = (await K.page('GET', '/learn/reports')).body;
  assert.equal(view.reports.length, 2);
  assert.equal(view.since.mistakes, 1);
  const before = A.questions.length;
  const viaHome = await K.page('POST', '/learn/reports', { lang: 'zh' });
  assert.equal(viaHome.status, 200, JSON.stringify(viaHome.body));
  assert.equal(viaHome.body.report.summary, 'Made on A.', 'the analysis ran on the home');
  assert.equal(A.questions.length, before + 1);
  assert.equal(K.questions.length, 0, 'the company computer never asks a model');
  assert.equal(viaHome.body.report.lang, 'zh');
  assert.equal((await K.page('GET', `/learn/reports/${viaHome.body.report.uid}`)).body.report.uid, viaHome.body.report.uid);
  assert.equal(await K.analysis.checkWeekly(), 'company');
  // The home away: the list says so and shows what waits here; reports and Analyze say the home cannot be reached.
  setOnline(K, 'A', false);
  await K.page('POST', `/learn/cards/${cached.id}/answer`, { mode: 'spell', grade: 'again', correct: false, answer: 'nesessary', tag: 'wrong-letter' });
  const offline = (await K.page('GET', '/learn/mistakes')).body;
  assert.equal(offline.offline, true);
  assert.deepEqual(offline.mistakes.map(item => item.written), ['nesessary']);
  assert.equal((await K.page('GET', '/learn/reports')).body.offline, true);
  const refused = await K.page('POST', '/learn/reports', {});
  assert.equal(refused.status, 503);
  assert.match(refused.body.error, /kept on a normal computer/);
});

// ---- Learn at a calmer pace ("New words a day" and "Keeps slipping" in docs/design/learn-review-fsrs.md) ----
test('new words a day and the parts of a word between engines: the setting, the words added today (merged, never lost), the parts and the tip', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  await noStarter(A);
  await A.page('PUT', '/learn/settings', { new_per_day: 20 });
  assert.deepEqual((await A.page('POST', '/learn/new-words', { count: 5 })).body.new_left, 25);
  await A.sync.syncAll();
  const onB = (await B.page('GET', '/learn/settings')).body;
  assert.equal(onB.new_per_day, 20, 'the setting travels');
  assert.equal(onB.extra_new.count, 5, 'the words added today travel');
  assert.equal((await B.page('GET', '/learn/summary')).body.new_left, 25);

  // Both change before either syncs: A adds 5 more words, B (later) changes the goal. B's settings win, and A's words are kept on both.
  await A.page('POST', '/learn/new-words', { count: 5 });
  await settle(5);
  await B.page('PUT', '/learn/settings', { daily_goal: 33 });
  await A.sync.syncAll();
  await B.sync.syncAll();
  for (const side of [A, B]) {
    const settings = (await side.page('GET', '/learn/settings')).body;
    assert.deepEqual([settings.daily_goal, settings.extra_new.count, settings.new_per_day], [33, 10, 20], side.name);
  }

  // An older peer sends settings without new_per_day and extra_new: the ones here stay.
  const before = (await B.page('GET', '/learn/settings')).body;
  B.sync.applyPage({ settings: { value: { collect: true, daily_goal: 7, starter: null }, at: Date.now() + 60_000, by: 'older-peer' } }, 'older-peer');
  const kept = (await B.page('GET', '/learn/settings')).body;
  assert.deepEqual([kept.daily_goal, kept.new_per_day, kept.extra_new], [7, 20, before.extra_new]);
  assert.deepEqual(merge.settingsFromPeer({ new_per_day: 7, extra_new: { day: 'x', count: 1 } }, { dev: {} }), {}, 'values this version does not take are left out');

  // The parts and the tip of a word filled in on A reach B; an empty one never wins over them.
  const card = (await A.page('POST', '/learn/cards', word('temporarily'))).body.card;
  await A.sync.syncAll();
  A.db.prepare("UPDATE learn_cards SET parts = 'tem·po·rar·i·ly', tip = 'temporary + -ly.', sync_seq = ? WHERE id = ?").run(syncStore.nextSeq(A.db), card.id);
  await A.sync.syncAll();
  const there = cardsOf(B).find(row => row.norm === 'temporarily');
  assert.deepEqual([there.parts, there.tip], ['tem·po·rar·i·ly', 'temporary + -ly.']);
  await B.page('PATCH', `/learn/cards/${there.id}`, { zh: ZH }); // a newer content version on B, which has the parts too
  B.db.prepare("UPDATE learn_cards SET parts = '', tip = '', sync_seq = ? WHERE id = ?").run(syncStore.nextSeq(B.db), there.id); // as if B never had them
  await B.sync.syncAll();
  await A.sync.syncAll();
  for (const side of [A, B]) assert.equal(cardsOf(side).find(row => row.norm === 'temporarily').parts, 'tem·po·rar·i·ly', side.name);
  // Parts from a peer that do not give the word are not kept.
  const wire = merge.cardToPeer(cardsOf(A).find(row => row.norm === 'temporarily'), 'a-id');
  assert.equal(merge.cardFromPeer({ ...wire, parts: 'tem·po·ra·ry' }, 'a-id').parts, '');
  assert.equal(merge.cardFromPeer({ ...wire }, 'a-id').parts, 'tem·po·rar·i·ly');
  const older = { ...wire };
  delete older.parts;
  delete older.tip;
  assert.deepEqual([merge.cardFromPeer(older, 'a-id').parts, merge.cardFromPeer(older, 'a-id').tip], ['', ''], 'an older peer sends none');
});

test('new words a day on a company computer: "5 more new words" is made on its home, and the home\'s count of new words is used', async t => {
  const { T, K } = await makeNetwork(t, ['T', 'K'], { links: [['T', 'K']] });
  await noStarter(T);
  K.tier.setCompany(true);
  await T.sync.syncAll();
  await K.sync.syncAll();
  assert.equal(K.sync.cacheOnly(), true);
  const added = await K.page('POST', '/learn/new-words', { count: 5 });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.new_left, 15, "the home's answer");
  assert.equal((await T.page('GET', '/learn/settings')).body.extra_new.count, 5, 'kept on the home');
  assert.equal((await K.page('GET', '/learn/settings')).body.extra_new.count, 5, 'and read back here');
  assert.equal((await K.page('POST', '/learn/new-words', { count: 99 })).status, 400, "the home's check answers");
  // A new word answered on the home: K's queue counts it from the home's last summary (K has no answers of its own).
  const onT = (await T.page('POST', '/learn/cards', word('latency', { zh: ZH }))).body.card;
  await T.page('POST', `/learn/cards/${onT.id}/answer`, { mode: 'spell', grade: 'good', correct: true });
  const summary = (await K.page('GET', '/learn/summary')).body;
  assert.deepEqual([summary.new_today, summary.new_left], [1, 14]);
  assert.deepEqual(K.learn.pace('me'), { new_per_day: 10, new_today: 1, new_left: 14 });
  setOnline(K, 'T', false);
  assert.equal((await K.page('POST', '/learn/new-words', { count: 5 })).status, 503, 'the home away: said so');
});

// A WAV header and `label` as its sound bytes (enough for the check of services/learn-speech.js isWav).
function tinyWav(label) {
  const data = Buffer.from(label, 'utf8');
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8, 'latin1');
  head.write('fmt ', 12, 'latin1'); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(24000, 24);
  head.writeUInt32LE(48000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36, 'latin1'); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

test('the DeepSeek voice on a company computer is made on its home: the audio comes over the link as base64 and is served as WAV', async t => {
  const { T, K } = await makeNetwork(t, ['T', 'K'], { links: [['T', 'K']] });
  K.tier.setCompany(true);
  await T.sync.syncAll();
  await K.sync.syncAll();
  assert.equal(K.sync.cacheOnly(), true);
  assert.deepEqual((await K.page('GET', '/learn/speech/status')).body, { ready: true, reason: null, voices: ['stella', 'tide'] }, "the home's status");
  const response = await fetch(`${K.base}/api/learn/speech?${new URLSearchParams({ text: '  Deploy   it. ', voice: 'tide' })}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.match(response.headers.get('cache-control'), /^private/);
  const audio = Buffer.from(await response.arrayBuffer());
  assert.equal(audio.subarray(44).toString('utf8'), 'T:tide:Deploy it.', 'made on the home, the text checked first');
  assert.deepEqual(T.speechCalls, [{ text: 'Deploy it.', voice: 'tide' }]);
  assert.deepEqual(K.speechCalls, [], 'never made on the company computer');
  assert.ok(K.requests.includes('GET /v1/learn-sync/speech'), JSON.stringify(K.requests));
  // The choice of the voice is shared like the other learning settings: made on the home from here, read back here.
  assert.equal((await K.page('PUT', '/learn/settings', { voice_engine: 'deepseek', voice_id: 'tide' })).status, 200);
  assert.deepEqual([(await T.page('GET', '/learn/settings')).body.voice_engine, (await K.page('GET', '/learn/settings')).body.voice_id], ['deepseek', 'tide']);
  // A refusal of the home keeps its status and message; a text refused here never reaches the home.
  T.speechFails = true;
  const refused = await K.page('GET', `/learn/speech?${new URLSearchParams({ text: 'Deploy it.' })}`);
  assert.deepEqual([refused.status, refused.body.error], [422, 'DeepSeek could not read this text']);
  assert.equal((await K.page('GET', `/learn/speech?${new URLSearchParams({ text: 'x'.repeat(501) })}`)).status, 400);
  assert.equal(T.speechCalls.length, 2);
  // A home without the voice (an older version) and a home that is away.
  T.speech = null;
  assert.equal((await K.page('GET', '/learn/speech/status')).body.reason, 'home_older');
  assert.equal((await K.page('GET', `/learn/speech?${new URLSearchParams({ text: 'Deploy it.' })}`)).status, 409);
  setOnline(K, 'T', false);
  assert.equal((await K.page('GET', '/learn/speech/status')).body.reason, 'offline');
  assert.equal((await K.page('GET', `/learn/speech?${new URLSearchParams({ text: 'Deploy it.' })}`)).status, 503);
});

test('a home whose coach is made on first use still answers a company computer (no 404 that reads as "older" right after a restart)', async t => {
  const { T, K } = await makeNetwork(t, ['T', 'K'], { links: [['T', 'K']] });
  K.tier.setCompany(true);
  await T.sync.syncAll();
  await K.sync.syncAll();
  // The home has no coach yet and cannot make one: the 404 the company page reads as "older".
  T.sync.setCoach(null);
  await assert.rejects(K.sync.askHome('coach?limit=1', {}), { statusCode: 404 });
  // The home makes it when the first question comes (its service hands itself in by setCoach), as the server does at start and on first use.
  T.loadCoach = () => T.sync.setCoach({ view: () => ({ messages: [], translator: true, settings: {} }) });
  const answered = await K.sync.askHome('coach?limit=1', {});
  assert.equal(answered.translator, true, JSON.stringify(answered));
});
