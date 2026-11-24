// Mind maps on every engine (services/mindmap.js, services/mindmap-sync.js, routes/mindmap-sync.js, routes/mindmap.js; "Mind maps on every engine"
// in docs/design/mind-maps.md): the migration of existing files, and engines running in this process as real HTTP servers joined by service links
// (the page routes, /v1/info and /v1/mindmap-sync of each, sealed with the settings sync's link keys): both ways, an echo, a conflict that keeps both,
// a delete that travels and an edit that brings a map back, a large map paged, a chain of three, an older peer, and the company computer (hand-over,
// list and open through the home, the cache, the offline queue).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// db/index.js (required by the services below) refuses to run a test on the real ~/.tagent: a temporary data folder first.
process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-mindmap-sync-data-'));
delete process.env.TAGENT_HOME;
const express = require('express');
const Database = require('better-sqlite3');

const { createMindmapService } = require('../services/mindmap');
const { createMindmapRouter } = require('../routes/mindmap');
const { createMindmapSync, CAPABILITY } = require('../services/mindmap-sync');
const { createEngineMindmapSyncRouter } = require('../routes/mindmap-sync');
const { createSettingsSync } = require('../services/settings-sync');
const { createDeviceTier, CAPABILITY: TIER_CAPABILITY } = require('../services/device-tier');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const NOW = Date.UTC(2026, 10, 20, 9, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const settle = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await settle();
  }
}
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
const topic = text => ({ root: { topic: text } });

function folder(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---- Migration ----

test('existing map files get a version and a change number on first read; ids and content stay, a second start changes nothing', async t => {
  const dataDir = folder(t, 't-agent-mindmap-migrate-');
  const dir = path.join(dataDir, 'mindmaps');
  fs.mkdirSync(dir, { recursive: true });
  const old = [
    { id: '3f1e6c2a-9b1d-4c3e-8a5f-1b2c3d4e5f60', title: 'Plan', data: topic('old plan'), revision: 7, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-05T10:00:00.000Z' },
    { id: '4a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d', title: 'Notes', data: null, revision: 1, created_at: '2026-10-02T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z' },
  ];
  for (const record of old) fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record));
  const identity = () => ({ instance_id: 'engine-t01', name: 'T01' });
  const service = createMindmapService({ dataDir, identity, now: () => new Date(NOW), log: () => {} });
  const first = await service.list();
  assert.deepEqual(first.map(map => [map.id, map.title, map.revision]), [[old[0].id, 'Plan', 7], [old[1].id, 'Notes', 1]], 'listed at once, before the migration');
  await service.settled(); // the migration runs in the background, never inside a request
  const listed = await service.list();
  assert.deepEqual(listed.map(map => [map.id, map.title, map.revision, map.by, map.by_name]), [[old[0].id, 'Plan', 7, 'engine-t01', 'T01'], [old[1].id, 'Notes', 1, 'engine-t01', 'T01']]);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, `${old[0].id}.json`), 'utf8'));
  assert.deepEqual(stored.data, topic('old plan'));
  assert.deepEqual(stored.sync.vv, { 'engine-t01': 1 });
  assert.equal(stored.sync.at, Date.parse(old[0].updated_at), 'the version time is when it was last edited');
  assert.equal(service.maxSeq(), 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'sync', 'state.json'), 'utf8')).seq, 2);
  // A second start: nothing to migrate and no file read; the counter goes on past a margin (a stop between a map and the state file is covered).
  const again = createMindmapService({ dataDir, identity, now: () => new Date(NOW), log: () => {} });
  await again.list();
  assert.equal(again.maxSeq(), 1002);
  const made = await again.create({ title: 'New' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `${made.id}.json`), 'utf8')).sync.seq, 1003);
  assert.deepEqual((await again.get(old[0].id)).data, topic('old plan'));
});

test('a folder at the map limit with unversioned files written behind the server\'s back: requests answer at once, the files are adopted in the background', async t => {
  const dataDir = folder(t, 't-agent-mindmap-limit-');
  const service = createMindmapService({ dataDir, identity: () => ({ instance_id: 'engine-a', name: 'A' }), now: () => new Date(NOW), log: () => {}, maxMaps: 300 });
  await service.create({ title: 'Real' });
  for (let index = 1; index < 300; index += 1) {
    const id = `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    fs.writeFileSync(path.join(service.dir, `${id}.json`), JSON.stringify({ id, title: 'x', data: null, revision: 1, created_at: 'a', updated_at: 'a' }));
  }
  // The limit answers without touching the files.
  await assert.rejects(service.create({ title: 'one too many' }), error => error.code === 'MINDMAP_LIMIT');
  const listed = await service.list();
  assert.equal(listed.length, 300, 'listed at once');
  assert.equal(listed.filter(map => map.by === null).length, 299, 'not yet adopted when the list answers');
  await service.settled();
  assert.equal((await service.list()).filter(map => map.by === null).length, 0, 'adopted in the background');
  assert.equal((await service.exportPage(0, { maxRows: 1000 })).maps.length, 300, 'and every one travels');
});

// A change number is taken before its file is written. A page made while that write is on its way must not say it reaches that number, or the
// peer records it as had and the entry never travels (the A-B-C chain lost C's edit this way in CI: B applied C's push while A pulled from B).
test('a page made while a numbered write is on its way stops before that number, and the next page has the entry', async t => {
  const dataDir = folder(t, 't-agent-mindmap-inflight-');
  let hold = null;
  let held = null;
  const service = createMindmapService({
    dataDir, identity: () => ({ instance_id: 'engine-b', name: 'B' }), now: () => new Date(NOW), log: () => {},
    hooks: { beforeWrite: entry => (hold ? new Promise(resolve => { held = { entry, resolve }; }) : null) },
  });
  const made = await service.create({ title: 'Plan', data: topic('a') });
  const first = await service.exportPage(0);
  assert.deepEqual(first.maps.map(map => map.id), [made.id]);
  // An edit arrives from a peer (C) and its write is held after it took its number.
  hold = true;
  const raw = (await service.exportIds([made.id])).maps[0];
  const edit = { ...raw, data: topic('c'), revision: 2, updated_at: new Date(NOW + 1000).toISOString(), sync: { ...raw.sync, vv: { ...raw.sync.vv, 'engine-c': 1 }, at: NOW + 1000, by: 'engine-c', by_name: 'C' } };
  const applying = service.applyEntries([edit]);
  while (!held) await settle(5);
  assert.ok(held.entry.sync.seq > first.next, 'the held write has a newer number');
  const during = await service.exportPage(first.next);
  assert.deepEqual(during.maps, [], 'not on disk yet: not in the page');
  assert.ok(during.next < held.entry.sync.seq, `the page stops before the number on its way (next ${during.next}, held ${held.entry.sync.seq})`);
  assert.ok(service.maxSeq() < held.entry.sync.seq, 'the newest number a peer is told is one that is written');
  hold = false;
  held.resolve();
  await applying;
  const after = await service.exportPage(during.next);
  assert.deepEqual(after.maps.map(map => map.data), [topic('c')], 'the next page has the edit');
});

test('a map put back from the trash by hand wins over its tombstone and travels again', async t => {
  const dataDir = folder(t, 't-agent-mindmap-restore-');
  const service = createMindmapService({ dataDir, identity: () => ({ instance_id: 'engine-a', name: 'A' }), now: () => new Date(NOW), log: () => {} });
  const made = await service.create({ title: 'Back', data: topic('x') });
  await service.remove(made.id);
  assert.equal((await service.exportPage(0)).tombstones.length, 1);
  const trashed = fs.readdirSync(service.trashDir)[0];
  fs.renameSync(path.join(service.trashDir, trashed), path.join(service.dir, `${made.id}.json`));
  assert.deepEqual((await service.list()).map(map => map.id), [made.id]);
  await service.settled();
  const page = await service.exportPage(0);
  assert.deepEqual(page.tombstones, []);
  assert.deepEqual(page.maps[0].sync.vv, { 'engine-a': 3 }, 'made, deleted, put back: three changes of this engine');
});

// ---- Engines in this process, joined by links ----
const pass = (req, res, next) => next();

async function makeNetwork(t, names, { links: pairs, pageBytes = 2 * 1024 * 1024, capabilities = {}, company = [], cacheDays = 14, hooks = {} } = {}) {
  const sides = {};
  for (const name of names) {
    const dir = folder(t, `t-agent-mindmap-sync-${name}-`);
    const db = new Database(path.join(dir, 'db.sqlite'));
    db.exec(SCHEMA);
    t.after(() => db.close());
    const instanceId = `engine-${name.toLowerCase()}-${crypto.randomBytes(3).toString('hex')}`;
    const tier = createDeviceTier({ db });
    if (company.includes(name)) tier.setCompany(true);
    const side = { name, db, instanceId, tier, peers: [], issued: new Map(), linkByToken: new Map(), requests: [], logs: [], clock: NOW, capabilities: capabilities[name] || [CAPABILITY, TIER_CAPABILITY] };
    const now = () => side.clock;
    const identity = () => ({ instance_id: instanceId, name });
    side.links = { peers: () => side.peers, onChange: () => () => {}, noteUnauthorized() {} };
    side.settingsSync = createSettingsSync({
      db, sessionSecret: `${name}-secret-${name}-secret`, serviceLinks: side.links, registry: [], owner: () => 'me', identity,
      issuedTokenHash: peer => { const token = side.issued.get(peer.id); return token ? sha(token) : null; },
      request: null, log: { warn() {}, info() {} }, intervalMs: 0,
    });
    side.maps = createMindmapService({ dataDir: dir, identity, now: () => new Date(side.clock), log: () => {}, hooks: hooks[name] || {} });
    side.sync = createMindmapSync({
      db, service: side.maps, serviceLinks: side.links, identity, now,
      linkKeys: { publicKey: () => side.settingsSync.publicKey(), linkKey: (peer, key) => side.settingsSync.linkKey(peer, key) },
      tier, log: { warn: message => side.logs.push(message), info() {} }, intervalMs: 0, debounceMs: 20, companyDebounceMs: 10, pageBytes, readWaitMs: 3000, cacheDays, retryMs: 100,
      request: async (baseUrl, route, token, opts = {}) => {
        const peer = side.peers.find(candidate => candidate.baseUrl === baseUrl);
        if (!peer || !peer.online) throw Object.assign(new Error('REMOTE_OFFLINE'), { statusCode: 502 });
        if (side.failNext) { side.failNext -= 1; throw new Error('read ECONNRESET'); }
        side.requests.push(`${opts.method || 'GET'} ${peer.name} ${route}${opts.body && opts.body.ids ? ' ids' : ''}${opts.body && opts.body.list ? ' list' : ''}`);
        const response = await fetch(baseUrl + route, {
          method: opts.method || 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: AbortSignal.timeout(opts.timeoutMs || 30000),
        });
        const text = await response.text();
        const body = text ? JSON.parse(text) : null;
        if (!response.ok) throw Object.assign(new Error(body && /^[A-Z0-9_]+$/.test(body.error || '') ? body.error : `REMOTE_HTTP_${response.status}`), { statusCode: response.status });
        return body;
      },
    });
    const app = express();
    app.use('/api/mindmaps', createMindmapRouter({ service: side.maps, sync: () => side.sync }));
    const engineAuth = () => (req, res, next) => {
      const token = (req.get('Authorization') || '').replace(/^Bearer /, '');
      if (!side.linkByToken.has(token)) return res.status(401).json({ error: 'UNAUTHORIZED' });
      req.engineAuth = { tokenId: token, role: 'admin' };
      next();
    };
    app.get('/v1/info', engineAuth(), (req, res) => res.json({ engine_id: instanceId, name, capabilities: side.capabilities, company_computer: tier.isCompany() }));
    app.use('/v1/mindmap-sync', express.json({ limit: '32mb' }), createEngineMindmapSyncRouter({ service: () => side.sync, serviceLinks: () => ({ linkForToken: token => side.linkByToken.get(token) || null }), requireEngineAuth: engineAuth, enabled: () => true }));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => new Promise(resolve => { side.sync.stop(); server.closeAllConnections(); server.close(resolve); }));
    side.base = `http://127.0.0.1:${server.address().port}`;
    side.page = async (method, route = '', body) => {
      const response = await fetch(`${side.base}/api/mindmaps${route}`, { method, headers: HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    side.titles = async () => (await side.maps.list()).map(map => map.title).sort();
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

test('two engines: a map made on each is on both, same id and content; an edit travels; a second round sends nothing', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  const onA = await A.page('POST', '', { title: 'Plan', data: topic('from A') });
  B.clock = NOW + 1000;
  const onB = await B.page('POST', '', { title: 'Plan', data: topic('from B') }); // the same name: still two maps
  await A.sync.syncAll();
  assert.deepEqual(await A.titles(), ['Plan', 'Plan']);
  assert.deepEqual(await B.titles(), ['Plan', 'Plan']);
  assert.deepEqual((await B.page('GET', `/${onA.body.id}`)).body.data, topic('from A'));
  const listed = (await B.page('GET')).body;
  assert.deepEqual(listed.maps.map(map => [map.id, map.by_name]), [[onB.body.id, 'B'], [onA.body.id, 'A']], 'by last edit; edited on its engine');
  await B.sync.syncAll(); // B reads A's /v1/info: A is a normal machine that syncs
  assert.deepEqual((await B.page('GET')).body.sync.engines.map(engine => engine.name), ['B', 'A']);
  assert.equal((await B.page('GET')).body.sync.cache_only, false);

  // An edit on B (with B's revision) reaches A and raises A's revision; the head says where it was changed.
  B.clock = NOW + 5000;
  const revision = (await B.page('GET', `/${onA.body.id}`)).body.revision;
  assert.equal((await B.page('PUT', `/${onA.body.id}`, { revision, data: topic('edited on B') })).status, 200);
  const before = (await A.page('GET', `/${onA.body.id}/head`)).body.revision;
  await B.sync.syncAll();
  const head = (await A.page('GET', `/${onA.body.id}/head`)).body;
  assert.ok(head.revision > before, 'an open page on A sees a newer revision');
  assert.equal(head.by_name, 'B');
  assert.deepEqual((await A.page('GET', `/${onA.body.id}`)).body.data, topic('edited on B'));

  // Both have everything: an echo changes nothing, and a quiet round costs two small requests.
  await A.sync.syncAll();
  A.requests.length = 0;
  assert.equal(await A.sync.syncPeer(A.peers[0]), 0);
  assert.deepEqual(A.requests, ['GET B /v1/info', 'GET B /v1/mindmap-sync']);
});

test('two engines save different content from the same base while apart: both are kept, the later as the map, the other as "(conflict from <engine>)"', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  const made = await A.page('POST', '', { title: 'Trip', data: topic('base') });
  await A.sync.syncAll();
  setOnline(A, 'B', false);
  setOnline(B, 'A', false);
  A.clock = NOW + 10_000;
  assert.equal((await A.page('PUT', `/${made.body.id}`, { revision: 1, data: topic('A while apart') })).status, 200);
  B.clock = NOW + 20_000;
  assert.equal((await B.page('PUT', `/${made.body.id}`, { revision: 1, data: topic('B while apart') })).status, 200);
  setOnline(A, 'B', true);
  setOnline(B, 'A', true);
  await A.sync.syncAll();
  await B.sync.syncAll();
  for (const side of [A, B]) {
    assert.deepEqual(await side.titles(), ['Trip', 'Trip (conflict from A)'], side.name);
    assert.deepEqual((await side.maps.get(made.body.id)).data, topic('B while apart'), `${side.name}: the later save is the map`);
    const copy = (await side.maps.list()).find(map => map.title.includes('conflict'));
    assert.deepEqual((await side.maps.get(copy.id)).data, topic('A while apart'));
  }
  assert.deepEqual((await A.maps.list()).map(map => map.id).sort(), (await B.maps.list()).map(map => map.id).sort(), 'one copy, the same id on both');
  // A's page still holds revision 2 of its own save: it now gets a conflict and offers to reload, nothing is lost.
  assert.equal((await A.page('PUT', `/${made.body.id}`, { revision: 2, data: topic('typed on') })).status, 409);
  await A.sync.syncAll();
  A.requests.length = 0;
  assert.equal(await A.sync.syncPeer(A.peers[0]), 0, 'settled: nothing more moves');
});

test('a delete travels and stays; an edit the deleting engine never saw brings the map back everywhere; tombstones go after 30 days', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  const one = await A.page('POST', '', { title: 'One' });
  const two = await A.page('POST', '', { title: 'Two' });
  await A.sync.syncAll();
  A.clock = NOW + 1000;
  assert.equal((await A.page('DELETE', `/${one.body.id}`)).status, 204);
  await A.sync.syncAll();
  assert.equal((await B.page('GET', `/${one.body.id}`)).status, 404, 'deleted on B too');
  assert.ok(fs.readdirSync(B.maps.trashDir).some(name => name.startsWith(one.body.id)), 'into B\'s trash');
  await B.sync.syncAll();
  assert.equal((await A.page('GET', `/${one.body.id}`)).status, 404, 'the old version never comes back');

  // "Two": B edits it while apart, A deletes it.
  setOnline(A, 'B', false);
  setOnline(B, 'A', false);
  B.clock = NOW + 2000;
  await B.page('PUT', `/${two.body.id}`, { revision: 1, title: 'Two, edited' });
  A.clock = NOW + 3000;
  await A.page('DELETE', `/${two.body.id}`);
  setOnline(A, 'B', true);
  setOnline(B, 'A', true);
  await A.sync.syncAll();
  await B.sync.syncAll();
  assert.equal((await A.page('GET', `/${two.body.id}`)).body.title, 'Two, edited', 'the edit is kept');
  assert.equal((await B.page('GET', `/${two.body.id}`)).body.title, 'Two, edited');

  // 31 days later the tombstone of "One" is gone.
  A.clock = NOW + 31 * DAY;
  assert.equal(await A.maps.purgeTombs(), 1);
  assert.deepEqual(fs.readdirSync(path.join(A.maps.syncDir, 'tombstones')), []);
});

test('a large first merge goes in pages cut by bytes; an 8 MB map travels alone', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']], pageBytes: 64 * 1024 });
  for (let n = 0; n < 6; n += 1) await A.maps.create({ title: `Map ${n}`, data: { root: { topic: 'x'.repeat(30 * 1024) } } });
  const big = await A.maps.create({ title: 'Big', data: { root: { topic: 'y'.repeat(8 * 1024 * 1024 - 40) } } });
  await B.sync.syncAll(); // B pulls
  const pulls = B.requests.filter(line => line.endsWith('/pull')).length;
  assert.ok(pulls >= 4, `several pages (${pulls})`);
  assert.equal((await B.maps.list()).length, 7);
  assert.equal(JSON.stringify((await B.maps.get(big.id)).data), JSON.stringify((await A.maps.get(big.id)).data));
  // And the other way: A pushes in pages too.
  for (let n = 0; n < 4; n += 1) await B.maps.create({ title: `B ${n}`, data: { root: { topic: 'z'.repeat(30 * 1024) } } });
  B.requests.length = 0;
  await B.sync.syncAll();
  assert.ok(B.requests.filter(line => line.startsWith('PUT')).length >= 2, 'several pushes');
  assert.equal((await A.maps.list()).length, 11);
});

test('a chain A-B-C, forced order: A pulls from B while B is still writing C\'s pushed edit; the edit still reaches A', async t => {
  let hold = false;
  let held = null;
  const { A, B, C } = await makeNetwork(t, ['A', 'B', 'C'], {
    links: [['A', 'B'], ['B', 'C']],
    hooks: { B: { beforeWrite: entry => (hold && entry.sync && entry.sync.by === C.instanceId ? new Promise(resolve => { held = resolve; }) : null) } },
  });
  const made = await A.page('POST', '', { title: 'Shared', data: topic('a') });
  await A.sync.syncAll();
  await B.sync.syncAll();
  await A.sync.syncAll();
  assert.equal((await C.page('GET', `/${made.body.id}`)).status, 200);
  C.clock = NOW + 1000;
  await C.page('PUT', `/${made.body.id}`, { revision: (await C.page('GET', `/${made.body.id}`)).body.revision, data: topic('c') });
  // C pushes its edit to B, and B's write of it is held after it took its change number.
  hold = true;
  const cRound = C.sync.syncPeer(C.peers.find(peer => peer.name === 'B'));
  while (!held) await settle(5);
  // Meanwhile A pulls from B (A's own round): B's page must not claim the number on its way.
  await A.sync.syncPeer(A.peers.find(peer => peer.name === 'B'));
  hold = false;
  held();
  await cRound;
  // B's fan-out round (what its debounce runs) sends the edit to A.
  await B.sync.syncAll();
  assert.deepEqual((await A.page('GET', `/${made.body.id}`)).body.data, topic('c'));
  assert.deepEqual(await A.titles(), ['Shared'], 'no conflict copy: C\'s edit descends from A\'s map');
});

test('a chain A-B-C: a map made on A reaches C through B, and C\'s edit comes back; an older peer is skipped', async t => {
  const { A, B, C, D } = await makeNetwork(t, ['A', 'B', 'C', 'D'], { links: [['A', 'B'], ['B', 'C'], ['A', 'D']], capabilities: { D: [TIER_CAPABILITY] } });
  for (const side of [A, B, C]) side.sync.start();
  const made = await A.page('POST', '', { title: 'Shared', data: topic('a') });
  await until(async () => (await C.page('GET', `/${made.body.id}`)).status === 200, 'the map reaches C');
  C.clock = NOW + 1000;
  await C.page('PUT', `/${made.body.id}`, { revision: (await C.page('GET', `/${made.body.id}`)).body.revision, data: topic('c') });
  await until(async () => JSON.stringify((await A.page('GET', `/${made.body.id}`)).body.data) === JSON.stringify(topic('c')), 'C\'s edit reaches A');
  // D has no mindmaps:sync: one /v1/info and nothing else, and the page lists D's own maps from D (older).
  A.requests.length = 0;
  await A.sync.syncPeer(A.peers.find(peer => peer.name === 'D'));
  // A's own timer may still be talking to B in the background: only what went to D counts.
  assert.deepEqual(A.requests.filter(line => / D /.test(line)), ['GET D /v1/info']);
  assert.deepEqual((await A.page('GET')).body.sync.older, [D.instanceId]);
  assert.equal((await D.maps.list()).length, 0);
});

test('a company computer hands its maps over, lists and opens through its home, keeps the opened ones and queues while the home is away', async t => {
  const { T, K } = await makeNetwork(t, ['T', 'K'], { links: [['T', 'K']], company: ['K'] });
  // Maps K had before it was marked, and one on T.
  const before = await K.maps.create({ title: 'From K', data: topic('k') });
  T.clock = NOW + 500;
  const onT = await T.page('POST', '', { title: 'From T', data: topic('t') });
  await T.sync.syncAll();
  assert.deepEqual(T.requests, ['GET K /v1/info'], 'a normal machine never syncs with a company computer itself');
  await K.sync.syncAll();
  assert.deepEqual(await T.titles(), ['From K', 'From T'], 'K\'s map is on T');
  assert.ok(K.requests.every(line => !line.endsWith('/pull')), 'K never pulls the whole set');
  assert.deepEqual(await K.titles(), ['From K'], 'K keeps what was made here lately, not T\'s map');

  // The list on K is the home's; opening T's map reads it through the home and keeps it here.
  const listed = (await K.page('GET')).body;
  assert.deepEqual(listed.maps.map(map => map.title), ['From T', 'From K']);
  assert.deepEqual({ ...listed.sync, engines: undefined }, { enabled: true, company_computer: true, cache_only: true, home_name: 'T', home_online: true, waiting: 0, engines: undefined, older: [] });
  const opened = await K.page('GET', `/${onT.body.id}`);
  assert.deepEqual(opened.body.data, topic('t'));
  assert.equal(opened.body.revision, (await T.page('GET', `/${onT.body.id}`)).body.revision, 'the same revision as on the home');
  assert.deepEqual(await K.titles(), ['From K', 'From T'], 'opened: now in the cache');

  // A save on K goes to the home soon after.
  K.sync.start();
  K.clock = NOW + 1000;
  assert.equal((await K.page('PUT', `/${onT.body.id}`, { revision: opened.body.revision, data: topic('saved on K') })).status, 200);
  await until(async () => JSON.stringify((await T.maps.get(onT.body.id)).data) === JSON.stringify(topic('saved on K')), 'the save reaches T');

  // The home goes away: K lists its cache, opens what it has, saves and makes maps that wait; a map it never opened cannot be read.
  const unseen = await T.page('POST', '', { title: 'Only on T' });
  setOnline(K, 'T', false);
  const away = (await K.page('GET')).body;
  assert.deepEqual(away.maps.map(map => map.title).sort(), ['From K', 'From T']);
  assert.equal(away.sync.home_online, false);
  const head = (await K.page('GET', `/${onT.body.id}`)).body;
  K.clock = NOW + 2000;
  assert.equal((await K.page('PUT', `/${onT.body.id}`, { revision: head.revision, data: topic('offline on K') })).status, 200);
  const offlineMade = await K.page('POST', '', { title: 'Made offline' });
  assert.equal(offlineMade.status, 201);
  assert.equal((await K.page('GET')).body.sync.waiting, 2, 'two changes wait for T');
  const missing = await K.page('GET', `/${unseen.body.id}`);
  assert.equal(missing.status, 503);
  assert.equal(missing.body.error, 'MINDMAP_HOME_OFFLINE');
  assert.equal(missing.body.message, 'This map is kept on T, which can\'t be reached right now');

  // Back: the waiting changes go to T, keep their revision there, and nothing waits any more.
  setOnline(K, 'T', true);
  await K.sync.syncAll();
  assert.deepEqual((await T.maps.get(onT.body.id)).data, topic('offline on K'));
  assert.equal((await T.maps.get(onT.body.id)).revision, (await K.maps.get(onT.body.id)).revision, 'the offline saves keep their numbers on the home');
  assert.ok((await T.titles()).includes('Made offline'));
  assert.equal((await K.page('GET')).body.sync.waiting, 0);

  // A delete on another engine leaves K's cache at its next list; maps not opened for 14 days leave the cache once T has them.
  T.clock = NOW + 3000;
  await T.page('DELETE', `/${before.id}`);
  assert.ok(!(await K.page('GET')).body.maps.some(map => map.id === before.id));
  assert.ok(!(await K.titles()).includes('From K'));
  K.clock = NOW + 15 * DAY;
  await K.sync.syncAll();
  assert.deepEqual(await K.titles(), [], 'the cache is empty; T keeps everything');
  assert.deepEqual(await T.titles(), ['From T', 'Made offline', 'Only on T']);
  // The home's sync routes refuse on a company computer.
  const kToken = [...K.linkByToken.keys()][0];
  const refused = await fetch(`${K.base}/v1/mindmap-sync/pull`, { method: 'POST', headers: { Authorization: `Bearer ${kToken}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, 'MINDMAP_COMPANY_COMPUTER');
});

test('a round that fails (a link reset while it comes up) is tried again by itself', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  A.sync.start();
  A.failNext = 1;
  await A.page('POST', '', { title: 'After a reset' });
  await until(async () => (await B.titles()).includes('After a reset'), 'the retry brings the map to B').catch(error => {
    throw new Error(`${error.message}; A asked: ${A.requests.join(', ')}; A logged: ${A.logs.join(' | ')}`);
  });
  assert.ok(A.logs.some(line => line.includes('failed: MINDMAP_SYNC_FAILED')), 'the failure is logged once, by code');
});

test('only company computers linked: each keeps its own maps as a normal machine would', async t => {
  const { K1, K2 } = await makeNetwork(t, ['K1', 'K2'], { links: [['K1', 'K2']], company: ['K1', 'K2'] });
  await K1.page('POST', '', { title: 'Mine' });
  await K1.sync.syncAll();
  await K2.sync.syncAll();
  assert.deepEqual(await K1.titles(), ['Mine']);
  assert.deepEqual(await K2.titles(), []);
  assert.equal((await K1.page('GET')).body.sync.cache_only, false);
});
