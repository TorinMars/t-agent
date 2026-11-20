// Usage data across linked devices (services/ui-events-sync.js, services/ui-events.js, routes/ui-events-sync.js, routes/ui-events.js; "Merged across
// linked devices" and "Company computer" in docs/design/usage-data.md): the client kind, the schema 16 columns, and services running in this process
// as real HTTP servers joined by service links (the page routes, /v1/info and /v1/usage-sync of each, sealed with the settings sync's link keys):
// both ways, the split by engine and client, an echo, a chain, pages, an older peer, the clear mark, retention, the shared switch, and the company
// computer (hand-over, the home's summary and export, offline).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// db/index.js (required by the services below) refuses to run a test on the real ~/.tagent: a temporary data folder first.
process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-usage-sync-data-'));
delete process.env.TAGENT_HOME;
const express = require('express');
const Database = require('better-sqlite3');

const usage = require('../services/ui-events');
const { createUiEventsRouter } = require('../routes/ui-events');
const { createUsageSync, CAPABILITY } = require('../services/ui-events-sync');
const { createEngineUsageSyncRouter } = require('../routes/ui-events-sync');
const { createSettingsSync, defaultRegistry, SCOPES } = require('../services/settings-sync');
const { createDeviceTier, CAPABILITY: TIER_CAPABILITY } = require('../services/device-tier');
const syncStore = require('../services/settings-sync-store');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const DAY = usage.DAY;
const UA = {
  computer: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  phone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) T-AgentApp/2.144.0',
};
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const settle = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await settle();
  }
}

function database(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-usage-sync-'));
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.exec(SCHEMA);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

// ---- Pure parts ----

test('the client kind comes from the User-Agent: the Mac app, a phone or tablet, else a computer', () => {
  assert.equal(usage.clientOf(UA.mac), 'mac-app');
  assert.equal(usage.clientOf(UA.phone), 'phone');
  assert.equal(usage.clientOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'), 'phone');
  assert.equal(usage.clientOf('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'), 'phone');
  assert.equal(usage.clientOf(UA.computer), 'computer');
  assert.equal(usage.clientOf(undefined), 'computer');
});

test('the summary query: days, layout, engine and client are checked', () => {
  assert.deepEqual(usage.summaryQuery({}), { days: 30, layout: null, engine: null, client: null });
  assert.deepEqual(usage.summaryQuery({ days: '7', layout: 'narrow', engine: 'abc-1', client: 'mac-app' }), { days: 7, layout: 'narrow', engine: 'abc-1', client: 'mac-app' });
  for (const query of [{ days: '0' }, { days: '91' }, { layout: 'tablet' }, { engine: 'a b' }, { client: 'watch' }]) assert.equal(usage.summaryQuery(query), null, JSON.stringify(query));
});

test('schema 16: a schema 15 usage table gets uid, engine, client and change numbers; rows are kept, and a second run changes nothing', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-usage-schema-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.exec(`CREATE TABLE ui_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, page TEXT NOT NULL, key TEXT NOT NULL, detail TEXT, surface TEXT NOT NULL,
    view TEXT NOT NULL, layout TEXT NOT NULL, input TEXT NOT NULL, pane INTEGER NOT NULL DEFAULT 0, device TEXT NOT NULL, state TEXT, version TEXT);
    CREATE TABLE ui_controls (key TEXT NOT NULL, surface TEXT NOT NULL, layout TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY (key, surface, layout));
    CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);`);
  db.prepare("INSERT INTO ui_events (at, page, key, surface, view, layout, input, device) VALUES (1, 'pageone', 'h5-cycle', 'header', 'sessions', 'narrow', 'touch', 'local')").run();
  db.prepare("INSERT INTO ui_events (at, page, key, surface, view, layout, input, device) VALUES (2, 'pageone', 'h5-more', 'header', 'sessions', 'wide', 'pointer', 'local')").run();
  db.prepare("INSERT INTO ui_controls VALUES ('h5-cycle', 'header', 'narrow', 1, 2)").run();
  usage.ensureSchema(db);
  db.exec(SCHEMA); // the indexes of schema.sql on the new columns now work
  const rows = db.prepare('SELECT id, uid, engine, client, sync_seq FROM ui_events ORDER BY id').all();
  assert.deepEqual(rows.map(row => [row.engine, row.client, row.sync_seq]), [['', null, 1], ['', null, 2]], 'recorded here, client read from the layout');
  assert.ok(rows.every(row => /^[0-9a-f]{32}$/.test(row.uid)) && rows[0].uid !== rows[1].uid);
  assert.equal(db.prepare('SELECT sync_seq FROM ui_controls').pluck().get(), 3);
  usage.ensureSchema(db);
  assert.deepEqual(db.prepare('SELECT uid FROM ui_events ORDER BY id').pluck().all(), rows.map(row => row.uid), 'a second run changes nothing');
  const service = usage.createUiEvents({ db, now: () => 10, identity: () => ({ instance_id: 'me-1', name: 'Me' }) });
  assert.deepEqual(service.summary({ days: 1 }).clients, { phone: 1, computer: 1, 'mac-app': 0 });
  db.close();
});

test('the switch is a shared setting: the settings sync group usage-record, saved through the hook and round-tripped', t => {
  const db = database(t);
  assert.equal(SCOPES['usage-record'], 'shared');
  const entry = defaultRegistry({ db, sessionSecret: 'secret-secret-secret-secret' }).find(item => item.key === 'usage-record');
  assert.ok(entry, 'in the registry');
  const changed = [];
  const off = syncStore.onSettingChanged(group => changed.push(group));
  try {
    const service = usage.createUiEvents({ db, now: () => NOW });
    assert.equal(entry.read('me'), null, 'never set: on by default, nothing to send');
    service.setEnabled(false);
    assert.deepEqual(changed, ['usage-record']);
    assert.deepEqual(entry.read('me'), { enabled: false });
    entry.write('me', { enabled: true });
    assert.equal(service.enabled(), true);
    entry.write('me', null);
    assert.equal(service.enabled(), true);
    assert.throws(() => entry.write('me', { enabled: 'yes' }), /INVALID_SYNC_VALUE/);
    assert.deepEqual(changed, ['usage-record'], 'a write by the sync never calls the hook');
  } finally { off(); }
});

// ---- Services in this process, joined by links ----
const pass = (req, res, next) => next();

async function makeNetwork(t, names, { links: pairs, pageSize = 500, capabilities = {}, company = [] } = {}) {
  const sides = {};
  for (const name of names) {
    const db = database(t);
    const instanceId = crypto.randomUUID();
    const tier = createDeviceTier({ db });
    if (company.includes(name)) tier.setCompany(true);
    const side = { name, db, instanceId, tier, peers: [], issued: new Map(), linkByToken: new Map(), requests: [], logs: [], clock: NOW, capabilities: capabilities[name] || [CAPABILITY, TIER_CAPABILITY] };
    const now = () => side.clock;
    const identity = () => ({ instance_id: instanceId, name });
    const linkListeners = new Set();
    side.links = {
      peers: () => side.peers,
      onChange: listener => { linkListeners.add(listener); return () => linkListeners.delete(listener); },
      noteUnauthorized() {},
    };
    side.settingsSync = createSettingsSync({
      db, sessionSecret: `${name}-secret-${name}-secret`, serviceLinks: side.links, registry: [], owner: () => 'me', identity,
      issuedTokenHash: peer => { const token = side.issued.get(peer.id); return token ? sha(token) : null; },
      request: null, log: { warn() {}, info() {} }, intervalMs: 0,
    });
    side.usage = usage.createUiEvents({ db, now, identity, version: () => '2.145.0' });
    side.sync = createUsageSync({
      db, serviceLinks: side.links, identity, service: side.usage, now,
      linkKeys: { publicKey: () => side.settingsSync.publicKey(), linkKey: (peer, key) => side.settingsSync.linkKey(peer, key) },
      tier, log: { warn: message => side.logs.push(message), info() {} }, intervalMs: 0, debounceMs: 20, companyDebounceMs: 10, pageSize, readWaitMs: 2000,
      request: async (baseUrl, route, token, opts = {}) => {
        const peer = side.peers.find(candidate => candidate.baseUrl === baseUrl);
        if (!peer || !peer.online) throw Object.assign(new Error('REMOTE_OFFLINE'), { statusCode: 502 });
        side.requests.push(`${opts.method || 'GET'} ${peer.name} ${route.split('?')[0]}`);
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
    const app = express();
    app.use(express.json({ limit: '32mb' }));
    app.use('/api/ui-events', createUiEventsRouter({ service: side.usage, sync: () => side.sync, requireAuth: pass }));
    const engineAuth = () => (req, res, next) => {
      const token = (req.get('Authorization') || '').replace(/^Bearer /, '');
      if (!side.linkByToken.has(token)) return res.status(401).json({ error: 'UNAUTHORIZED' });
      req.engineAuth = { tokenId: token, role: 'admin' };
      next();
    };
    app.get('/v1/info', engineAuth(), (req, res) => res.json({ engine_id: instanceId, name, capabilities: side.capabilities, company_computer: tier.isCompany() }));
    app.use('/v1/usage-sync', createEngineUsageSyncRouter({ service: () => side.sync, serviceLinks: () => ({ linkForToken: token => side.linkByToken.get(token) || null }), requireEngineAuth: engineAuth, enabled: () => true }));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => new Promise(resolve => { side.sync.stop(); server.closeAllConnections(); server.close(resolve); }));
    side.base = `http://127.0.0.1:${server.address().port}`;
    side.page = async (method, route, body, agent = UA.computer) => {
      const response = await fetch(`${side.base}/api/ui-events${route}`, { method, headers: { 'Content-Type': 'application/json', 'User-Agent': agent }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    // Presses sent by a page of this engine, at the side's clock.
    side.press = (keys, agent = UA.computer, extra = {}) => side.page('POST', '', {
      page: extra.page || `page${name.toLowerCase()}1`, sent: side.clock,
      events: keys.map((key, index) => ({ at: side.clock - 1000 + index, key, surface: 'bottom-row', view: 'sessions', layout: agent === UA.phone ? 'narrow' : 'wide', input: agent === UA.phone ? 'touch' : 'pointer', pane: false, device: 'local' })),
      seen: extra.seen || [],
    }, agent);
    sides[name] = side;
  }
  let serial = 0;
  for (const [x, y] of pairs || []) {
    serial += 1;
    const linkId = `link-${serial}-${x}-${y}`;
    const tokenXY = `tae_${crypto.randomBytes(32).toString('base64url')}`;
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
const uids = side => side.db.prepare('SELECT uid FROM ui_events ORDER BY uid').pluck().all();
const count = side => side.db.prepare('SELECT COUNT(*) FROM ui_events').pluck().get();

test('two linked services: presses made on each side are one set on both, split by engine and by client kind; an echo changes nothing', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  await A.press(['h5-cycle', 'h5-more'], UA.computer, { seen: [{ key: 'h5-design', surface: 'bottom-row', layout: 'wide' }] });
  B.clock = NOW + 5000;
  await B.press(['h5-cycle'], UA.phone, { seen: [{ key: 'h5-design', surface: 'bottom-row', layout: 'wide' }] });
  await B.press(['h5-commands'], UA.mac, { page: 'macpage1' });
  await A.sync.syncAll();
  assert.equal(count(A), 4);
  assert.deepEqual(uids(A), uids(B));
  const design = side => side.db.prepare("SELECT first_seen, last_seen FROM ui_controls WHERE key = 'h5-design'").get();
  assert.deepEqual(design(A), { first_seen: NOW, last_seen: NOW + 5000 }, 'a seen control: the earliest first and the latest last time');
  assert.deepEqual(design(B), design(A));
  await B.sync.syncAll(); // B learns from A's /v1/info that A is a normal machine (it is named in "where" from then on)

  const summary = (await B.page('GET', '/summary?days=30')).body;
  assert.equal(summary.total, 4);
  assert.deepEqual(summary.top[0], { key: 'h5-cycle', count: 2, surfaces: [{ surface: 'bottom-row', count: 2 }], layouts: { wide: 1, narrow: 1 }, details: [] });
  assert.deepEqual(summary.engines.map(engine => [engine.name, engine.count, engine.self]), [['A', 2, false], ['B', 2, true]]);
  assert.deepEqual(summary.engines.map(engine => engine.id), [A.instanceId, B.instanceId]);
  assert.deepEqual(summary.clients, { phone: 1, computer: 2, 'mac-app': 1 });
  assert.deepEqual(summary.where, { company_computer: false, hands_over: false, home_name: null, home_online: null, waiting: 0, shared_with: ['A'] });
  const onlyA = (await B.page('GET', `/summary?engine=${A.instanceId}`)).body;
  assert.equal(onlyA.total, 2);
  assert.deepEqual(onlyA.engines.map(engine => engine.count), [2, 2], 'the engine split ignores the engine filter');
  assert.equal((await B.page('GET', `/summary?engine=${B.instanceId}&client=mac-app`)).body.total, 1);
  assert.equal((await A.page('GET', '/summary?client=phone')).body.top[0].key, 'h5-cycle');
  assert.equal((await A.page('GET', '/summary?client=tablet')).status, 400);

  const exported = (await A.page('GET', '/export')).body;
  assert.deepEqual(exported.events.map(row => [row.key, row.engine_name, row.client]), [['h5-cycle', 'A', 'computer'], ['h5-more', 'A', 'computer'], ['h5-cycle', 'B', 'phone'], ['h5-commands', 'B', 'mac-app']]);
  assert.equal(exported.events[2].engine, B.instanceId);
  assert.equal(exported.events.some(row => 'uid' in row || 'sync_seq' in row), false);

  // A second round: both sides have everything, nothing is applied and nothing more is pushed.
  A.requests.length = 0;
  assert.equal(await A.sync.syncPeer(A.peers[0]), 0);
  assert.deepEqual(A.requests, ['GET B /v1/info', 'GET B /v1/usage-sync']);
});

test('a chain A-B-C: a press on A reaches C through B, with the name of A; pages carry a large first merge', async t => {
  const { A, B, C } = await makeNetwork(t, ['A', 'B', 'C'], { links: [['A', 'B'], ['B', 'C']], pageSize: 3 });
  for (const side of [A, B, C]) side.sync.start();
  await A.press(Array.from({ length: 10 }, (_, index) => `h5-key-${index}`));
  await until(() => count(C) === 10, 'the presses reach C');
  assert.deepEqual(uids(C), uids(A));
  const summary = (await C.page('GET', '/summary')).body;
  assert.deepEqual(summary.engines.map(engine => [engine.name, engine.count]), [['A', 10]], 'C names A, which it has no link with');
});

test('an older peer without usage:sync is skipped', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']], capabilities: { B: [TIER_CAPABILITY] } });
  await A.press(['h5-cycle']);
  await A.sync.syncAll();
  assert.deepEqual(A.requests, ['GET B /v1/info']);
  assert.equal(A.sync.peerStates()[A.peers[0].id].supported, false);
  assert.equal(count(B), 0);
  assert.deepEqual((await A.page('GET', '/summary')).body.where.shared_with, [], 'not named as keeping the same set');
});

test('Clear travels: every engine deletes the presses up to the clear and refuses older ones that arrive later; newer ones stay', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  await A.press(['h5-cycle'], UA.computer, { seen: [{ key: 'h5-cycle', surface: 'bottom-row', layout: 'wide' }] });
  await A.sync.syncAll();
  assert.equal(count(B), 1);
  // B records a press that has not travelled yet, then A clears.
  await B.press(['h5-more']);
  A.clock = NOW + 60_000;
  assert.deepEqual((await A.page('DELETE', '')).body, { cleared: 1 });
  B.clock = NOW + 120_000;
  await B.press(['h5-design']);
  await A.sync.syncAll();
  assert.deepEqual(B.db.prepare('SELECT key FROM ui_events').pluck().all(), ['h5-design'], 'the presses up to the clear went on B too');
  assert.deepEqual(A.db.prepare('SELECT key FROM ui_events').pluck().all(), ['h5-design'], 'the press B made before the clear never arrives');
  assert.equal(B.db.prepare('SELECT COUNT(*) FROM ui_controls').pluck().get(), 0);
  assert.equal(usage.readClear(B.db).at, NOW + 60_000);
  A.requests.length = 0;
  assert.equal(await A.sync.syncPeer(A.peers[0]), 0, 'the clear mark sent back changes nothing');
});

test('a press older than the retention, or with an unknown field value, is refused by the receiver', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  await A.press(['h5-cycle', 'h5-more']);
  A.db.prepare("UPDATE ui_events SET at = ? WHERE key = 'h5-cycle'").run(NOW - 91 * DAY);
  A.db.prepare("UPDATE ui_events SET device = 'elsewhere' WHERE key = 'h5-more'").run();
  await A.press(['h5-design']);
  await A.sync.syncAll();
  assert.deepEqual(B.db.prepare('SELECT key FROM ui_events').pluck().all(), ['h5-design']);
});

test('a company computer hands its presses over to its home and keeps none; its summary and export are the home\'s; offline they wait', async t => {
  const { T, K } = await makeNetwork(t, ['T', 'K'], { links: [['T', 'K']], company: ['K'] });
  await T.press(['h5-cycle']);
  await K.press(['h5-more', 'h5-commands'], UA.mac, { seen: [{ key: 'h5-more', surface: 'bottom-row', layout: 'wide' }] });
  await T.sync.syncAll();
  assert.deepEqual(T.requests, ['GET K /v1/info'], 'a normal machine never syncs with a company computer itself');
  assert.equal(count(T), 1);
  await K.sync.syncAll();
  assert.equal(count(T), 3, 'K\'s presses are on T');
  assert.equal(count(K), 0, 'and no longer on K');
  assert.equal(K.db.prepare('SELECT COUNT(*) FROM ui_controls').pluck().get(), 0);
  assert.equal(T.db.prepare('SELECT COUNT(*) FROM ui_controls').pluck().get(), 1);
  assert.ok(K.requests.every(line => !line.includes('/pull')), 'it never pulls');
  assert.equal(syncStore.readState(K.db, usage.SEQ_KEY).seq, usage.maxSeq(K.db), 'the change numbers are kept when the rows go');

  const summary = (await K.page('GET', '/summary')).body;
  assert.equal(summary.total, 3, 'the home\'s merged set');
  assert.deepEqual(summary.engines.map(engine => [engine.name, engine.count]), [['K', 2], ['T', 1]]);
  assert.deepEqual(summary.clients, { phone: 0, computer: 1, 'mac-app': 2 });
  assert.deepEqual(summary.where, { company_computer: true, hands_over: true, home_name: 'T', home_online: true, waiting: 0, shared_with: [] });
  const exported = (await K.page('GET', '/export')).body;
  assert.deepEqual(exported.events.map(row => [row.key, row.engine_name, row.client]).sort(), [['h5-commands', 'K', 'mac-app'], ['h5-cycle', 'T', 'computer'], ['h5-more', 'K', 'mac-app']]);
  assert.deepEqual(exported.controls.map(row => row.key), ['h5-more']);

  // The home's sync routes refuse on a company computer.
  const kLink = [...K.linkByToken.keys()][0];
  const refused = await fetch(`${K.base}/v1/usage-sync/pull`, { method: 'POST', headers: { Authorization: `Bearer ${kLink}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, 'USAGE_COMPANY_COMPUTER');

  // The home goes away: presses wait on K, and the summary is the presses here.
  setOnline(K, 'T', false);
  K.clock = NOW + 10_000;
  await K.press(['h5-design']);
  const away = (await K.page('GET', '/summary')).body;
  assert.equal(away.total, 1);
  assert.deepEqual(away.where, { company_computer: true, hands_over: true, home_name: 'T', home_online: false, waiting: 1, shared_with: [] });
  assert.equal((await K.page('GET', '/export')).body.events.length, 1);
  setOnline(K, 'T', true);
  await K.sync.syncAll();
  assert.equal(count(K), 0);
  assert.equal(count(T), 4);
});

test('every machine marked as a company computer: nothing moves and each keeps its own presses', async t => {
  const { K1, K2 } = await makeNetwork(t, ['K1', 'K2'], { links: [['K1', 'K2']], company: ['K1', 'K2'] });
  await K1.press(['h5-cycle']);
  await K1.sync.syncAll();
  await K2.sync.syncAll();
  assert.equal(count(K1), 1);
  assert.equal(count(K2), 0);
  assert.deepEqual((await K1.page('GET', '/summary')).body.where, { company_computer: true, hands_over: false, home_name: null, home_online: null, waiting: 0, shared_with: [] });
});
