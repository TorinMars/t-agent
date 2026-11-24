// Usage time and memories across linked devices (services/usage-time-sync.js, routes/usage-time-sync.js; "Sync across linked devices" in
// docs/design/usage-time.md): real services joined by links over HTTP, like test/ui-events-sync.test.js. Both ways, no second counted twice after
// echoes, repeated rounds and a chain, the company computer's hand-over (its later seconds of the same key, its reads and edits through its home),
// an older peer, Clear of each tab, retention, and memories' conflicts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const Database = require('better-sqlite3');

const time = require('../services/usage-time');
const { createMemories } = require('../services/usage-memories');
const { createUsageTimeSync, CAPABILITY } = require('../services/usage-time-sync');
const { createEngineUsageTimeSyncRouter } = require('../routes/usage-time-sync');
const { createUsageTimeRouters } = require('../routes/usage-time');
const { createSettingsSync } = require('../services/settings-sync');
const { createDeviceTier, CAPABILITY: TIER_CAPABILITY } = require('../services/device-tier');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-usage-time-sync-'));
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.exec(SCHEMA);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}
const pass = (req, res, next) => next();

async function makeNetwork(t, names, { links: pairs, pageSize = 500, capabilities = {}, company = [] } = {}) {
  const sides = {};
  for (const name of names) {
    const db = database(t);
    const instanceId = crypto.randomUUID();
    const tier = createDeviceTier({ db });
    if (company.includes(name)) tier.setCompany(true);
    const side = { name, db, instanceId, tier, peers: [], issued: new Map(), linkByToken: new Map(), requests: [], logs: [], clock: NOW, capabilities: capabilities[name] || [CAPABILITY, 'usage:sync', TIER_CAPABILITY] };
    const now = () => side.clock;
    const identity = () => ({ instance_id: instanceId, name });
    const linkListeners = new Set();
    side.links = { peers: () => side.peers, onChange: listener => { linkListeners.add(listener); return () => linkListeners.delete(listener); }, noteUnauthorized() {} };
    side.settingsSync = createSettingsSync({
      db, sessionSecret: `${name}-secret-${name}-secret`, serviceLinks: side.links, registry: [], owner: () => 'me', identity,
      issuedTokenHash: peer => { const token = side.issued.get(peer.id); return token ? sha(token) : null; },
      request: null, log: { warn() {}, info() {} }, intervalMs: 0,
    });
    side.usage = time.createUsageTime({ db, now, identity, linked: () => side.sync.linked() });
    side.memories = createMemories({ db, now, usage: side.usage });
    side.sync = createUsageTimeSync({
      db, serviceLinks: side.links, identity, usage: side.usage, memories: side.memories, now,
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
    const routers = createUsageTimeRouters({ usage: side.usage, memories: side.memories, sync: () => side.sync, requireAuth: pass });
    app.use('/api/usage-time', routers.time);
    app.use('/api/memories', routers.memories);
    const engineAuth = () => (req, res, next) => {
      const token = (req.get('Authorization') || '').replace(/^Bearer /, '');
      if (!side.linkByToken.has(token)) return res.status(401).json({ error: 'UNAUTHORIZED' });
      req.engineAuth = { tokenId: token, role: 'admin' };
      next();
    };
    app.get('/v1/info', engineAuth(), (req, res) => res.json({ engine_id: instanceId, name, capabilities: side.capabilities, company_computer: tier.isCompany() }));
    app.use('/v1/usage-sync/time', createEngineUsageTimeSyncRouter({ service: () => side.sync, serviceLinks: () => ({ linkForToken: token => side.linkByToken.get(token) || null }), requireEngineAuth: engineAuth, enabled: () => true }));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => new Promise(resolve => { side.sync.stop(); server.closeAllConnections(); server.close(resolve); }));
    side.base = `http://127.0.0.1:${server.address().port}`;
    side.page = async (method, route, body) => {
      const response = await fetch(`${side.base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      let parsed = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* a CSV */ }
      return { status: response.status, body: parsed };
    };
    side.beats = (count, extra = {}) => side.page('POST', '/api/usage-time/beats', { beats: Array.from({ length: count }, () => ({ at: side.clock - 1000, surface: 'sessions', kind: 'claude', task: `${instanceId}|5`, session: `${instanceId}|5|k1`, seconds: 15, ...extra })) });
    side.total = column => Number(db.prepare(`SELECT COALESCE(SUM(${column}), 0) FROM usage_time`).pluck().get());
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
const uids = (side, table) => side.db.prepare(`SELECT uid FROM ${table} ORDER BY uid`).pluck().all();

test('two linked services: time and memories made on each side are one set on both; the summaries agree; an echo changes nothing', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  await A.beats(4);
  B.usage.recordSession({ at: NOW - 1000, task: `${B.instanceId}|3`, session: `${B.instanceId}|3|c1`, kind: 'codex', working: 600, waiting: 60, waits: [60] });
  await A.page('POST', '/api/memories', { text: 'A note' });
  B.memories.addEvent({ event: 'task-created', text: 'Task "x" created', ref: 'x' });
  await A.sync.syncAll();
  assert.deepEqual(uids(A, 'usage_time'), uids(B, 'usage_time'));
  assert.deepEqual(uids(A, 'memories'), uids(B, 'memories'));
  await B.sync.syncAll();
  const sa = (await A.page('GET', '/api/usage-time/summary?range=today&tz=UTC')).body;
  const sb = (await B.page('GET', '/api/usage-time/summary?range=today&tz=UTC')).body;
  assert.deepEqual(sa.tiles, sb.tiles);
  assert.deepEqual([sa.tiles.page_s, sa.tiles.working_s, sa.tiles.waiting_s], [60, 600, 60]);
  assert.deepEqual(sb.where.shared_with, ['A']);
  const onlyA = (await B.page('GET', `/api/usage-time/summary?range=today&tz=UTC&device=${A.instanceId}`)).body;
  assert.deepEqual([onlyA.tiles.page_s, onlyA.tiles.working_s], [60, 0]);
  assert.deepEqual(onlyA.devices.map(device => [device.name, device.self, device.supported]), [['B', true, true], ['A', false, true]]);
  const exported = (await B.page('GET', '/api/usage-time/export?table=time')).body;
  assert.deepEqual(exported.time.map(row => row.engine_name).sort(), ['A', 'B']);
  assert.equal((await B.page('GET', '/api/memories')).body.items.length, 2);
  // Another round: nothing is applied and nothing more is pushed.
  A.requests.length = 0;
  assert.equal(await A.sync.syncPeer(A.peers[0]), 0);
  assert.deepEqual(A.requests, ['GET B /v1/info', 'GET B /v1/usage-sync/time']);
});

test('no second is counted twice: more seconds of a synced row replace its copy, repeated rounds and a chain A-B-C keep one sum', async t => {
  const { A, B, C } = await makeNetwork(t, ['A', 'B', 'C'], { links: [['A', 'B'], ['B', 'C']], pageSize: 3 });
  await A.beats(2);
  for (let i = 0; i < 3; i += 1) { await A.sync.syncAll(); await B.sync.syncAll(); await C.sync.syncAll(); }
  assert.deepEqual([A.total('page_s'), B.total('page_s'), C.total('page_s')], [30, 30, 30]);
  // The same key gets more seconds on A: one row, a higher revision; the copies are replaced, never added to.
  await A.beats(3);
  A.usage.recordSession({ at: NOW - 500, task: `${A.instanceId}|5`, session: `${A.instanceId}|5|k1`, kind: 'claude', working: 120 });
  for (let i = 0; i < 3; i += 1) { await C.sync.syncAll(); await B.sync.syncAll(); await A.sync.syncAll(); }
  assert.deepEqual([A.total('page_s'), B.total('page_s'), C.total('page_s')], [75, 75, 75]);
  assert.deepEqual([B.total('working_s'), C.total('working_s')], [120, 120]);
  assert.equal(C.db.prepare('SELECT COUNT(*) FROM usage_time').pluck().get(), 2, 'one row per key and origin');
  // Many rows travel in pages of 3 through B.
  for (let hour = 1; hour <= 8; hour += 1) A.usage.recordSession({ at: NOW - hour * time.HOUR, task: `${A.instanceId}|5`, session: `${A.instanceId}|5|k1`, kind: 'claude', working: 10 });
  for (const side of [A, B, C]) side.sync.start();
  A.usage.recordSession({ at: NOW - 9 * time.HOUR, task: `${A.instanceId}|5`, session: `${A.instanceId}|5|k1`, kind: 'claude', working: 10 }); // the hook starts a round
  await until(() => C.total('working_s') === 210, 'the rows reach C');
  await settle(200);
  assert.deepEqual([A.total('working_s'), B.total('working_s'), C.total('working_s')], [210, 210, 210]);
  const summary = (await C.page('GET', '/api/usage-time/summary?range=today&tz=UTC')).body;
  assert.equal(summary.devices.find(device => device.id === A.instanceId).name, 'A', 'C names A, which it has no link with');
});

test('an older peer without usage:time (or with the sync off) is skipped', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']], capabilities: { B: ['usage:sync', TIER_CAPABILITY] } });
  await A.beats(1);
  await A.sync.syncAll();
  assert.deepEqual(A.requests, ['GET B /v1/info']);
  assert.equal(A.sync.peerStates()[A.peers[0].id].supported, false);
  assert.equal(B.total('page_s'), 0);
  const devices = (await A.page('GET', '/api/usage-time/summary?range=today')).body.devices;
  assert.deepEqual(devices.map(device => [device.name, device.supported]), [['A', true], ['B', false]], 'the page shows "needs an update first" for it');
});

test('Clear of each tab travels: time rows of the hours up to it go everywhere and older copies are refused; memories become tombstones', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  await A.beats(2);
  await A.page('POST', '/api/memories', { text: 'keep or not' });
  await A.sync.syncAll();
  assert.equal(B.total('page_s'), 30);
  B.clock = NOW + 60_000;
  assert.deepEqual((await B.page('DELETE', '/api/usage-time?table=time')).body, { cleared: 1 });
  await B.sync.syncAll();
  assert.equal(A.total('page_s'), 0, 'A deleted them too');
  // A late copy from before the Clear is refused.
  const stale = { time: [{ uid: 'late1', engine: A.instanceId, client: 'computer', day: '2026-11-24', hour: 11, start: Date.UTC(2026, 10, 24, 11), surface: 'sessions', kind: '', task: '', session: '', page_s: 15, working_s: 0, waiting_s: 0, waits: '', rev: 1, updated_at: NOW }], memories: [], names: {} };
  assert.equal(B.sync.applyPage(stale, A.instanceId), 0);
  // New time after the Clear is kept and travels.
  A.clock = NOW + 120_000;
  await A.beats(1);
  await A.sync.syncAll();
  assert.equal(B.total('page_s'), 15);
  // Memories: Clear makes tombstones everywhere.
  assert.deepEqual((await A.page('DELETE', '/api/usage-time?table=memories')).body, { cleared: 1 });
  await A.sync.syncAll();
  assert.equal((await B.page('GET', '/api/memories')).body.items.length, 0);
  assert.equal(B.db.prepare('SELECT deleted FROM memories').pluck().get(), 1);
});

test('retention: a row older than 2 years is refused by the receiver and pruned locally; a bad row is refused', async t => {
  const { A } = await makeNetwork(t, ['A']);
  const old = Date.UTC(2024, 10, 1, 10);
  const row = { uid: 'old1', engine: crypto.randomUUID(), client: 'computer', day: '2024-11-01', hour: 10, start: old, surface: 'sessions', kind: '', task: '', session: '', page_s: 15, working_s: 0, waiting_s: 0, waits: '', rev: 1, updated_at: old };
  assert.equal(A.sync.applyPage({ time: [row] }, row.engine), 0);
  const fresh = { ...row, uid: 'new1', day: '2026-11-24', hour: 10, start: Date.UTC(2026, 10, 24, 10), updated_at: NOW };
  for (const bad of [{ ...fresh, hour: 11 }, { ...fresh, page_s: 3601 }, { ...fresh, surface: 'terminal' }, { ...fresh, task: 'x' }, { ...fresh, waits: '[1]' }, { ...fresh, rev: 0 }]) {
    assert.equal(A.sync.applyPage({ time: [bad] }, row.engine), 0, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(A.sync.applyPage({ time: [fresh] }, row.engine), 1);
  A.db.prepare("UPDATE usage_time SET start = ? WHERE uid = 'new1'").run(old);
  assert.equal(A.usage.prune().time, 1);
});

test('memories: the newer change wins, a tombstone wins a tie, an older edit never brings a deleted note back', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  const note = A.memories.addNote({ text: 'first' });
  await A.sync.syncAll();
  A.clock = NOW + 1000;
  A.memories.editNote(note.uid, { text: 'edited on A' });
  B.clock = NOW + 2000;
  B.memories.remove(note.uid);
  await A.sync.syncAll();
  assert.deepEqual([A, B].map(side => side.db.prepare('SELECT deleted, text FROM memories WHERE uid = ?').get(note.uid)), [{ deleted: 1, text: '' }, { deleted: 1, text: '' }]);
  // A tie: the tombstone wins.
  const other = A.memories.addNote({ text: 'tie' });
  await A.sync.syncAll();
  const row = A.db.prepare('SELECT * FROM memories WHERE uid = ?').get(other.uid);
  const page = { memories: [{ ...row, engine: A.instanceId, by: B.instanceId, private: false, deleted: true, text: '', updated_at: row.updated_at }] };
  assert.equal(A.sync.applyPage(page, B.instanceId), 1);
  assert.equal(A.db.prepare('SELECT deleted FROM memories WHERE uid = ?').pluck().get(other.uid), 1);
  assert.equal(A.sync.applyPage({ memories: [{ ...page.memories[0], deleted: false, text: 'tie', updated_at: row.updated_at }] }, B.instanceId), 0);
});

test('a company computer hands its rows over and keeps none; its later seconds of the same key are added on the home; its reads, edits and export are the home\'s', async t => {
  const { T, K } = await makeNetwork(t, ['T', 'K'], { links: [['T', 'K']], company: ['K'] });
  await T.beats(1);
  await K.beats(2);
  const note = (await K.page('POST', '/api/memories', { text: 'from the company computer' })).body;
  await T.sync.syncAll();
  assert.deepEqual(T.requests, ['GET K /v1/info'], 'a normal machine never syncs with a company computer itself');
  await K.sync.syncAll();
  assert.equal(T.total('page_s'), 45);
  assert.equal(K.db.prepare('SELECT COUNT(*) FROM usage_time').pluck().get() + K.db.prepare('SELECT COUNT(*) FROM memories').pluck().get(), 0, 'nothing kept on K');
  assert.ok(K.requests.every(line => !line.includes('/pull')), 'it never pulls');
  // More seconds of the same key on K: a new row there, added to the first on the home.
  await K.beats(3);
  await K.sync.syncAll();
  assert.equal(T.total('page_s'), 90);
  assert.equal(T.db.prepare('SELECT COUNT(*) FROM usage_time WHERE engine = ?').pluck().get(K.instanceId), 2);
  // Reads on K are the home's.
  const summary = (await K.page('GET', '/api/usage-time/summary?range=today&tz=UTC')).body;
  assert.equal(summary.tiles.page_s, 90);
  assert.deepEqual(summary.where, { company_computer: true, hands_over: true, home_name: 'T', home_online: true, waiting: 0, shared_with: [] });
  assert.equal((await K.page('GET', `/api/usage-time/task?task=${encodeURIComponent(`${K.instanceId}|5`)}&range=today&tz=UTC`)).body.looked_s, 75);
  assert.equal((await K.page('GET', '/api/usage-time/day?day=2026-11-24&tz=UTC')).body.page_s, 90);
  const list = (await K.page('GET', '/api/memories')).body;
  assert.deepEqual(list.items.map(item => item.text), ['from the company computer']);
  // An edit and a delete of a note kept on the home are done there.
  assert.equal((await K.page('PATCH', `/api/memories/${note.uid}`, { text: 'edited on K' })).body.text, 'edited on K');
  assert.equal(T.db.prepare('SELECT text FROM memories WHERE uid = ?').pluck().get(note.uid), 'edited on K');
  assert.deepEqual((await K.page('DELETE', `/api/memories/${note.uid}`)).body, { deleted: true, uid: note.uid });
  assert.equal(T.db.prepare('SELECT deleted FROM memories WHERE uid = ?').pluck().get(note.uid), 1);
  // The export is the home's rows.
  const exported = (await K.page('GET', '/api/usage-time/export?table=time')).body;
  assert.equal(exported.time.reduce((sum, row) => sum + row.page_s, 0), 90);
  // The home's routes refuse on a company computer.
  const kLink = [...K.linkByToken.keys()][0];
  const refused = await fetch(`${K.base}/v1/usage-sync/time/pull`, { method: 'POST', headers: { Authorization: `Bearer ${kLink}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, 'USAGE_COMPANY_COMPUTER');
  // The home goes away: rows wait on K, the summary is the rows here, an edit of a home row is refused.
  setOnline(K, 'T', false);
  await K.beats(1);
  const away = (await K.page('GET', '/api/usage-time/summary?range=today&tz=UTC')).body;
  assert.equal(away.tiles.page_s, 15);
  assert.equal(away.where.home_online, false);
  assert.equal(away.where.waiting, 1);
  assert.equal((await K.page('PATCH', '/api/memories/elsewhere1', { text: 'x' })).status, 503);
  setOnline(K, 'T', true);
  await K.sync.syncAll();
  assert.equal(T.total('page_s'), 105);
  assert.equal(K.db.prepare('SELECT COUNT(*) FROM usage_time').pluck().get(), 0);
});
