// The shared page state (services/page-state.js, services/page-state-merge.js, routes/page-state.js, public/js/page-state.js;
// docs/design/shared-page-state.md): the merge rules, the identity mapping of the page, and services running in this process as real HTTP servers
// joined by service links (the page routes, /v1/info and /v1/page-state of each, sealed with the settings sync's link keys): the recent sessions and
// a remembered key the same on both, a rename and a delete travelling, a chain reaching the third engine, an older peer skipped, nothing looping.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// db/index.js (required by the services below) refuses to run a test on the real ~/.tagent: a temporary data folder first.
process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-page-state-data-'));
delete process.env.TAGENT_HOME;
const express = require('express');
const Database = require('better-sqlite3');

const merge = require('../services/page-state-merge');
const { createPageState, CAPABILITY } = require('../services/page-state');
const { createPageStateRouter, createEnginePageStateRouter } = require('../routes/page-state');
const { createSettingsSync } = require('../services/settings-sync');
const pageSide = require('../public/js/page-state.js');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const ZH = '\u6700\u8fd1\u4efb\u52a1'; // a session name in Chinese travels as it is
const T = '11111111-1111-4111-8111-111111111111';
const K = '22222222-2222-4222-8222-222222222222';
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
const DAY = 24 * 60 * 60 * 1000;
const entry = (instance, task, terminal, extra = {}) => ({ instance, task: String(task), terminal, title: '', agent: null, used: 1, gone: false, at: 1, by: T, ...extra });
const stateOf = (...entries) => ({ recent: Object.fromEntries(entries.map(item => [merge.recentId(item), item])), keys: {} });

// ---- Merge rules (pure) ----
test('merge: per entry the later version wins (a tie to the greater instance id); a union of both; the same whichever side merges', () => {
  const a = stateOf(entry(T, 1, 'a', { title: 'old', at: 5, by: T }), entry(T, 2, 'b', { used: 9, at: 3 }));
  const b = stateOf(entry(T, 1, 'a', { title: 'new', at: 6, by: K }), entry(K, 3, 'c', { used: 4, at: 2, by: K }));
  const ab = merge.merge(a, b, 100).state;
  const ba = merge.merge(b, a, 100).state;
  assert.equal(merge.stableJson(ab), merge.stableJson(ba), 'commutative');
  assert.equal(ab.recent[`${T}|1|a`].title, 'new');
  assert.equal(Object.keys(ab.recent).length, 3);
  assert.equal(merge.merge(ab, ab, 100).changed, false, 'merging the result again changes nothing');
  assert.equal(merge.merge(ab, a, 100).changed, false, 'an older side brings nothing');
  // The same time: the greater instance id.
  const tie = merge.merge(stateOf(entry(T, 1, 'a', { title: 'by T', at: 7, by: T })), stateOf(entry(T, 1, 'a', { title: 'by K', at: 7, by: K })), 100).state;
  assert.equal(tie.recent[`${T}|1|a`].title, 'by K');
});

test('merge: a delete is a tombstone that travels and beats the older entry; showing the session again later brings it back; old tombstones go', () => {
  const live = stateOf(entry(T, 1, 'a', { title: 'x', at: 5 }));
  const gone = stateOf(entry(T, 1, 'a', { gone: true, at: 6, used: 0 }));
  const after = merge.merge(live, gone, 100).state;
  assert.equal(after.recent[`${T}|1|a`].gone, true);
  assert.deepEqual(merge.pageView(after).recent, [], 'the page does not see it');
  const back = merge.merge(after, stateOf(entry(T, 1, 'a', { title: 'x', at: 9, used: 50 })), 100).state;
  assert.equal(back.recent[`${T}|1|a`].gone, false);
  const old = merge.trim(stateOf(entry(T, 1, 'a', { gone: true, at: 10 })), 10 + merge.GONE_KEEP_MS + 1);
  assert.deepEqual(old.recent, {}, 'a tombstone older than GONE_KEEP_MS is dropped');
});

test('merge: the live entries are cut to RECENT_KEEP by the time they were used, the same on both sides', () => {
  const many = Array.from({ length: merge.RECENT_KEEP + 6 }, (_, index) => entry(index % 2 ? T : K, index + 1, 't', { used: 1000 + index, at: index + 1 }));
  const one = stateOf(...many.filter((_, index) => index % 2));
  const two = stateOf(...many.filter((_, index) => !(index % 2)));
  const merged = merge.merge(one, two, 100).state;
  assert.equal(Object.keys(merged.recent).length, merge.RECENT_KEEP);
  assert.deepEqual(merge.pageView(merged).recent.map(item => item.used), many.map(item => item.used).sort((x, y) => y - x).slice(0, merge.RECENT_KEEP), 'the latest of both sides');
  assert.equal(merge.stableJson(merged), merge.stableJson(merge.merge(two, one, 100).state));
});

test('merge: keys are last writer wins, a cleared key is a tombstone, the recency of saved commands is merged per command', () => {
  const at = (value, time, by = T) => ({ value, at: time, by });
  const a = { recent: {}, keys: { 'h5-task-list-tab': at('recent', 5), 'ta-saved-commands-used': at({ claude: { '/compact': 10, '/clear': 50 } }, 5) } };
  const b = { recent: {}, keys: { 'h5-task-list-tab': at(null, 6, K), 'ta-saved-commands-used': at({ claude: { '/compact': 40 }, codex: { '/status': 7 } }, 6, K) } };
  const merged = merge.merge(a, b, 100).state;
  assert.deepEqual(merge.pageView(merged).keys, { 'h5-task-list-tab': null, 'ta-saved-commands-used': { claude: { '/clear': 50, '/compact': 40 }, codex: { '/status': 7 } } });
  assert.equal(merge.stableJson(merged), merge.stableJson(merge.merge(b, a, 100).state));
  assert.equal(merge.merge(merged, b, 100).changed, false);
});

test('a page change: stamped with one version, an import has version time 0 and gives way to a value set since; malformed bodies are refused', () => {
  const change = merge.changeState({ recent: [{ instance: T, task: 3, terminal: 'c1', title: ZH, agent: 'claude', used: 70 }], keys: { 'h5-columns': '{"on":true}' }, import: { keys: { 'h5-task-list-tab': 'recent', 'h5-columns': 'old' } } }, { at: 50, by: T });
  assert.equal(change.recent[`${T}|3|c1`].title, ZH);
  assert.equal(change.keys['h5-columns'].value, '{"on":true}', 'the change beats the import of the same key');
  assert.equal(change.keys['h5-task-list-tab'].at, 0);
  const stored = { recent: {}, keys: { 'h5-task-list-tab': { value: 'tasks', at: 3, by: K } } };
  assert.equal(merge.pageView(merge.merge(stored, change, 100).state).keys['h5-task-list-tab'], 'tasks', 'what a device set wins over an old browser value');
  for (const bad of [null, [], { recent: 'x' }, { recent: [{ instance: 'bad id!', task: 1, terminal: 'a' }] }, { recent: [{ instance: T, task: 0, terminal: 'a' }] },
    { keys: { 'Bad Key': 1 } }, { keys: { ok: 'x'.repeat(merge.VALUE_MAX + 1) } }]) {
    assert.throws(() => merge.changeState(bad, { at: 1, by: T }), /INVALID_PAGE_STATE/, JSON.stringify(bad).slice(0, 60));
  }
});

// ---- The page's identity mapping (public/js/page-state.js) ----
test('identity: each page names an engine by its own source key; the shared entry is the same', () => {
  // The page of T01 lists K01 as remote:3; the page of K01 lists T01 as remote:9.
  const onT = [{ key: 'local', instanceId: T }, { key: 'remote:3', instanceId: K }];
  const onK = [{ key: 'local', instanceId: K }, { key: 'remote:9', instanceId: T }];
  const shared = pageSide.toShared({ sourceKey: 'remote:3', taskId: '5', terminalId: 'k1', title: 'Build', agent: 'codex', lastUsed: 900 }, onT);
  assert.deepEqual(shared, { instance: K, task: '5', terminal: 'k1', title: 'Build', agent: 'codex', used: 900 });
  assert.deepEqual(pageSide.toPage(shared, onK), { sourceKey: 'local', taskId: '5', terminalId: 'k1', title: 'Build', agent: 'codex', lastUsed: 900 });
  const list = [shared, { instance: T, task: '1', terminal: 'a', used: 800 }, { instance: 'someone-else', task: '1', terminal: 'a', used: 700 }];
  assert.deepEqual(pageSide.recentForPage(list, onT).map(row => row.sourceKey), ['remote:3', 'local'], 'an engine this page does not list is left out');
  assert.deepEqual(pageSide.recentForPage(list, onK).map(row => row.sourceKey), ['local', 'remote:9']);
  // A device without an instance id (an older Engine) is `~<key>`: kept in this browser only, mapped back to the same source.
  const older = [{ key: 'local', instanceId: T }, { key: 'remote:4', instanceId: null }];
  const kept = pageSide.toShared({ sourceKey: 'remote:4', taskId: 2, terminalId: 'x', title: '' }, older, 1234);
  assert.equal(kept.instance, '~remote:4');
  assert.equal(kept.used, 1234, 'an entry without a time gets now');
  assert.equal(pageSide.toPage(kept, older).sourceKey, 'remote:4');
  // Two entries of one session (one from before its instance id was known): one row, the newer.
  assert.equal(pageSide.recentForPage([{ ...kept, instance: '~remote:4', used: 5 }, { instance: K, task: '2', terminal: 'x', used: 3 }], [{ key: 'remote:4', instanceId: K }]).length, 1);
});

test('identity: the collapsed T-Attention parents and the engine of a new task travel by instance id', () => {
  const { CODECS } = pageSide;
  const onT = [{ key: 'local', instanceId: T }, { key: 'remote:3', instanceId: K }];
  const onK = [{ key: 'local', instanceId: K }, { key: 'remote:9', instanceId: T }];
  const collapsed = CODECS['h5-attention-collapsed'];
  const shared = collapsed.encode(JSON.stringify([12, 'remote:3:40']), onT, ['other-engine:7']);
  assert.deepEqual(shared.sort(), [`${K}:40`, `${T}:12`, 'other-engine:7'].sort(), 'an id of an engine this page does not know is kept');
  assert.deepEqual(JSON.parse(collapsed.decode(shared, onK)).sort(), [40, 'remote:9:12'].sort());
  const engine = CODECS['h5-attention-add-on'];
  assert.equal(engine.encode('remote:3', onT), K);
  assert.equal(engine.decode(K, onK), 'local');
  assert.equal(engine.decode('unknown', onK), null);
});

// ---- Services in this process, joined by links ----
const pass = (req, res, next) => next();
function database(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-page-state-'));
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.exec(SCHEMA);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

async function makeNetwork(t, names, { links: pairs = [], capabilities = {}, denied = {} } = {}) {
  const sides = {};
  for (const name of names) {
    const db = database(t);
    const instanceId = crypto.randomUUID();
    const side = { name, db, instanceId, peers: [], issued: new Map(), linkByToken: new Map(), requests: [], logs: [], capabilities: capabilities[name] || [CAPABILITY] };
    const listeners = new Set();
    side.links = { peers: () => side.peers, onChange: listener => { listeners.add(listener); return () => listeners.delete(listener); }, emit: id => { for (const listener of listeners) listener(id); }, noteUnauthorized() {} };
    side.settingsSync = createSettingsSync({
      db, sessionSecret: `${name}-secret-${name}-secret`, serviceLinks: side.links, registry: [], owner: () => 'me',
      identity: () => ({ instance_id: instanceId, name }),
      issuedTokenHash: peer => { const token = side.issued.get(peer.id); return token ? sha(token) : null; },
      request: null, log: { warn() {}, info() {} }, intervalMs: 0,
    });
    side.service = createPageState({
      db, serviceLinks: side.links, owner: () => 'me', identity: () => ({ instance_id: instanceId, name }),
      linkKeys: { publicKey: () => side.settingsSync.publicKey(), linkKey: (peer, key) => side.settingsSync.linkKey(peer, key) },
      visibility: () => ({ isDenied: (taskId, linkId) => (denied[name] || []).some(rule => rule.task === taskId && side.peers.some(peer => peer.id === linkId && peer.name === rule.from)) }),
      log: { warn: message => side.logs.push(message), info() {} }, intervalMs: 0, debounceMs: 30,
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
        if (!response.ok) throw Object.assign(new Error(body && /^[A-Z0-9_]+$/.test(body.error || '') ? body.error : `REMOTE_HTTP_${response.status}`), { statusCode: response.status });
        return body;
      },
    });
    const app = express();
    app.use(express.json());
    app.use('/api/page-state', createPageStateRouter({ service: () => side.service, requireAuth: (req, res, next) => { req.session = { user: { login: 'me' } }; next(); }, clientOrigin: pass }));
    const engineAuth = () => (req, res, next) => {
      const token = (req.get('Authorization') || '').replace(/^Bearer /, '');
      if (token === 'not-a-link') { req.engineAuth = { tokenId: token, role: 'admin' }; return next(); }
      if (!side.linkByToken.has(token)) return res.status(401).json({ error: 'UNAUTHORIZED' });
      req.engineAuth = { tokenId: token, role: 'admin' };
      next();
    };
    app.get('/v1/info', engineAuth(), (req, res) => res.json({ engine_id: instanceId, name, capabilities: side.capabilities }));
    app.use('/v1/page-state', createEnginePageStateRouter({ service: () => side.service, serviceLinks: () => ({ linkForToken: token => side.linkByToken.get(token) || null }), requireEngineAuth: engineAuth, enabled: () => !side.off }));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => new Promise(resolve => { side.service.stop(); server.closeAllConnections(); server.close(resolve); }));
    side.base = `http://127.0.0.1:${server.address().port}`;
    side.page = async (method, body) => {
      const response = await fetch(`${side.base}/api/page-state`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    side.view = async () => { const { body } = await side.page('GET'); return { recent: body.recent, keys: body.keys }; };
    sides[name] = side;
  }
  let serial = 0;
  for (const [x, y] of pairs) {
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
const note = (side, instance, task, terminal, extra = {}) => side.page('PUT', { recent: [{ instance, task, terminal, title: '', agent: null, used: Date.now(), ...extra }] });

test('two linked engines: the Recent list and a remembered key are the same on both; a rename and a delete travel; changes on both sides meet', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  // The page of A shows a session of A and one of B; the page of B one of its own.
  await note(A, A.instanceId, 1, 'default', { title: 'Terminal 1', used: 1000 });
  await note(A, B.instanceId, 5, 'k1', { title: ZH, agent: 'codex', used: 2000 });
  await note(B, B.instanceId, 6, 'k2', { title: 'Logs', used: 1500 });
  const put = await A.page('PUT', { keys: { 'h5-task-list-tab': 'recent', 'h5-columns': '{"on":true,"ids":["abc123"],"tab":"columns"}' } });
  assert.equal(put.status, 200);
  assert.equal(put.body.keys['h5-task-list-tab'], 'recent', 'the answer is the new state');
  await A.service.syncAll();
  const onA = await A.view();
  assert.deepEqual(await B.view(), onA, 'the same on both');
  assert.deepEqual(onA.recent.map(item => [item.instance === A.instanceId ? 'A' : 'B', item.task, item.terminal, item.title]), [['B', '5', 'k1', ZH], ['B', '6', 'k2', 'Logs'], ['A', '1', 'default', 'Terminal 1']]);
  assert.equal(onA.keys['h5-columns'], '{"on":true,"ids":["abc123"],"tab":"columns"}');

  // A rename on B and a delete on B travel to A.
  await note(B, B.instanceId, 5, 'k1', { title: 'Renamed', agent: 'codex', used: 2000 });
  await B.page('PUT', { recent: [{ instance: A.instanceId, task: '1', terminal: 'default', gone: true }] });
  await B.service.syncAll();
  const after = await A.view();
  assert.deepEqual(after.recent.map(item => [item.task, item.title]), [['5', 'Renamed'], ['6', 'Logs']]);
  assert.deepEqual(after, await B.view());

  // Both sides change before either syncs: both changes survive, in the order they were used.
  await note(A, A.instanceId, 2, 'a2', { used: 3000 });
  await note(B, B.instanceId, 7, 'b7', { used: 3100 });
  await A.page('PUT', { keys: { 'h5-design-outline': '0' } });
  await B.page('PUT', { keys: { 'h5-sidebar-collapsed': '1' } });
  await A.service.syncAll();
  const both = await A.view();
  assert.deepEqual(both, await B.view());
  assert.deepEqual(both.recent.slice(0, 2).map(item => item.terminal), ['b7', 'a2']);
  assert.equal(both.keys['h5-design-outline'], '0');
  assert.equal(both.keys['h5-sidebar-collapsed'], '1');

  // A page change is pushed by itself after the debounce; once both agree nothing loops.
  A.service.start();
  B.service.start();
  await A.page('PUT', { keys: { 'h5-task-list-tab': null } });
  await until(async () => (await B.view()).keys['h5-task-list-tab'] === null, 'the push after a page change');
  await settle(250);
  const before = A.requests.length + B.requests.length;
  await settle(300);
  assert.equal(A.requests.length + B.requests.length, before, 'no round runs by itself once both agree');
  const fromA = A.requests.length;
  await A.service.syncAll();
  assert.deepEqual(A.requests.slice(fromA), ['GET /v1/info', 'GET /v1/page-state'], 'equal digests: nothing is pulled or sent');
  assert.deepEqual(A.logs, []);
});

test('a chain A–B–C reaches C and comes back; an older peer without the capability is skipped; a hidden task is not sent', async t => {
  const { A, B, C, D } = await makeNetwork(t, ['A', 'B', 'C', 'D'], { links: [['A', 'B'], ['B', 'C'], ['A', 'D']], capabilities: { D: [] }, denied: { A: [{ task: 9, from: 'B' }] } });
  await note(A, A.instanceId, 1, 'a1', { title: 'On A', used: 100 });
  await note(A, A.instanceId, 9, 'secret', { title: 'Hidden from B', used: 200 });
  await A.page('PUT', { keys: { 'word-translate': '1' } });
  await A.service.syncAll();
  await B.service.syncAll();
  const onC = await C.view();
  assert.deepEqual(onC.recent.map(item => item.terminal), ['a1'], 'C has it through B; the task A hides from B is not sent to B');
  assert.equal(onC.keys['word-translate'], '1');
  assert.deepEqual((await A.view()).recent.map(item => item.terminal), ['secret', 'a1'], 'A keeps its own');
  // C's change goes back through B to A.
  await note(C, C.instanceId, 3, 'c3', { title: 'On C', used: 300 });
  await C.service.syncAll();
  await B.service.syncAll();
  assert.deepEqual((await A.view()).recent.map(item => item.terminal), ['c3', 'secret', 'a1']);
  // D is an older version: only /v1/info was read, nothing was sent, and it is marked unsupported (the page sees it in `peers`).
  assert.deepEqual((await D.view()).recent, []);
  assert.equal(A.service.peerStates()[A.peers.find(peer => peer.name === 'D').id].supported, false);
  assert.deepEqual((await A.page('GET')).body.peers.find(peer => peer.name === 'D'), { name: 'D', online: true, supported: false, last_sync_at: null });
});

test('the engine routes: link tokens only, a bad key or envelope is refused, nothing with the sync off', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  const peer = A.peers[0];
  const call = (route, opts = {}) => fetch(`${B.base}${route}`, { method: opts.method || 'GET', headers: { Authorization: `Bearer ${opts.token || peer.token}`, 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  assert.equal((await call('/v1/page-state', { token: 'not-a-link' })).status, 403);
  const described = await (await call(`/v1/page-state?public_key=${A.settingsSync.publicKey()}`)).json();
  assert.equal(described.instance_id, B.instanceId);
  assert.match(described.digest, /^[0-9a-f]{32}$/);
  assert.equal((await call('/v1/page-state/pull', { method: 'POST', body: { instance_id: A.instanceId, public_key: 'short' } })).status, 400);
  assert.equal((await call('/v1/page-state/pull', { method: 'POST', body: { instance_id: crypto.randomUUID(), public_key: A.settingsSync.publicKey() } })).status, 400, 'another instance than the link\'s');
  const bad = await call('/v1/page-state', { method: 'PUT', body: { instance_id: A.instanceId, public_key: A.settingsSync.publicKey(), sealed: { v: 1, alg: 'A256GCM', iv: 'AAAA', data: 'AAAA', tag: 'AAAA' } } });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'SETTINGS_SYNC_DECRYPT_FAILED');
  B.off = true;
  assert.equal((await call('/v1/page-state')).status, 404);
  assert.equal((await A.page('PUT', { recent: [{ instance: 'bad id!', task: 1, terminal: 'a' }] })).status, 400);
  assert.equal((await A.page('PUT', { recent: [{ instance: 'bad id!', task: 1, terminal: 'a' }] })).body.error, 'INVALID_PAGE_STATE');
});
