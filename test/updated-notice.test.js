// "Updated to v…" (services/updated-notice.js, routes/updated-notice.js; "Notice after an update" in docs/design/update-check-and-versions.md): the
// version change recorded at start, several updates shown as one notice from the oldest version not acknowledged, nothing on a fresh install or a
// downgrade, the acknowledgement, the release notes of the range from DESIGN.md (and a missing file), and the linked engines over real HTTP: the line
// of a peer with a notice, an older peer skipped, the acknowledgement travelling to the peer, link tokens only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// db/index.js refuses to run a test on the real ~/.tagent: a temporary data folder first (CI sets none).
process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-updated-notice-data-'));
delete process.env.TAGENT_HOME;
const express = require('express');
const Database = require('better-sqlite3');

const { createUpdatedNotice, parseNotes, notesInRange, CAPABILITY, RUNNING_KEY, noticeKey } = require('../services/updated-notice');
const { createUpdatedNoticeRouter, createEngineUpdatedNoticeRouter } = require('../routes/updated-notice');
const { request } = require('../services/remote-client');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const FIXED = Date.UTC(2026, 10, 20, 0, 42, 0); // a fixed clock: no test reads the real date
const NOTES = [
  '# T-Agent design',
  '',
  '## Recent versions',
  '',
  '> v2.143.0 Shared page state',
  '> v2.143.1 Phone: the key row steps aside',
  '> v2.144.0 Updated notice',
  'not a note',
  '> v2.146.0 Later work',
  '',
].join('\n');

function memoryDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}
const stored = (db, key) => { const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(key); return row ? JSON.parse(row.value) : null; };
const store = (db, key, value) => db.prepare('INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));

function notesFile(text = NOTES) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-updated-notes-'));
  const file = path.join(dir, 'DESIGN.md');
  if (text !== null) fs.writeFileSync(file, text);
  return file;
}

// One engine: `version` is what it runs now (change it and call record() again for a restart into another version).
function engine(over = {}) {
  const db = over.db || memoryDb();
  const side = { db, version: over.version || '2.143.1', at: FIXED, updating: false };
  side.service = createUpdatedNotice({
    db,
    runningVersion: () => side.version,
    legacyVersion: over.legacyVersion || (() => null),
    owner: () => 'me',
    engineName: () => over.name || 'T01',
    notesFile: over.notesFile || notesFile(),
    updating: () => side.updating,
    serviceLinks: over.serviceLinks || null,
    request: over.request || null,
    now: () => side.at,
    log: { warn() {}, info() {} },
    timeoutMs: 2000,
  });
  side.restartInto = version => { side.version = version; return side.service.record(); };
  return side;
}

test('a fresh install records its version and tells nothing', async () => {
  const side = engine();
  assert.equal(side.service.record(), null);
  assert.deepEqual(stored(side.db, RUNNING_KEY), { version: '2.143.1' });
  assert.equal(side.service.shouldShow('me'), false);
  assert.deepEqual(await side.service.view('me'), { show: false });
  // The same version again (a plain restart) tells nothing either.
  assert.equal(side.service.record(), null);
  assert.equal(stored(side.db, noticeKey('me')), null);
});

test('a version that went up leaves a notice with the previous version and the time of the start', async () => {
  const side = engine();
  side.service.record();
  side.at = FIXED + 60_000;
  const notice = side.restartInto('2.144.0');
  assert.deepEqual(notice, { version: '2.144.0', previous_version: '2.143.1', updated_at: new Date(FIXED + 60_000).toISOString() });
  assert.equal(side.service.shouldShow('me'), true);
  assert.equal(side.service.shouldShow('someone-else'), false);
  const view = await side.service.view('me');
  assert.equal(view.show, true);
  assert.equal(view.version, '2.144.0');
  assert.equal(view.previous_version, '2.143.1');
  assert.equal(view.updated_at, '2026-11-20T00:43:00.000Z');
  assert.equal(view.engine_name, 'T01');
  assert.deepEqual(view.notes, [{ version: '2.144.0', note: 'Updated notice' }]);
  assert.deepEqual(view.linked, []);
});

test('several updates in a row are one notice from the oldest version not acknowledged; after OK the next one starts from there', () => {
  const side = engine();
  side.service.record();
  side.restartInto('2.144.0');
  side.at = FIXED + 3_600_000;
  assert.deepEqual(side.restartInto('2.146.0'), { version: '2.146.0', previous_version: '2.143.1', updated_at: new Date(FIXED + 3_600_000).toISOString() });
  return side.service.acknowledge('me', { version: '2.146.0' }).then(result => {
    assert.deepEqual(result, { acknowledged: true, linked: [] });
    assert.equal(side.service.shouldShow('me'), false);
    assert.equal(side.restartInto('2.146.1').previous_version, '2.146.0');
  });
});

test('the acknowledgement removes only the version that was shown', async () => {
  const side = engine();
  side.service.record();
  side.restartInto('2.144.0');
  // A page that showed an older notice (an update came in meanwhile) does not acknowledge the newer one.
  assert.deepEqual(await side.service.acknowledge('me', { version: '2.143.9' }), { acknowledged: false, linked: [] });
  assert.equal(side.service.shouldShow('me'), true);
  await assert.rejects(side.service.acknowledge('me', { version: 'nope' }), error => error.statusCode === 400 && error.message === 'INVALID_UPDATED_NOTICE');
  assert.deepEqual(await side.service.acknowledge('me', { version: '2.144.0' }), { acknowledged: true, linked: [] });
  assert.equal(side.service.shouldShow('me'), false);
  assert.deepEqual(await side.service.view('me'), { show: false });
  // Nothing left to acknowledge.
  assert.deepEqual(await side.service.acknowledge('me', {}), { acknowledged: false, linked: [] });
});

test('nothing is shown while an update is being applied, and a downgrade drops the notice', async () => {
  const side = engine();
  side.service.record();
  side.restartInto('2.144.0');
  side.updating = true;
  assert.equal(side.service.shouldShow('me'), false);
  assert.deepEqual(await side.service.view('me'), { show: false });
  side.updating = false;
  assert.equal(side.restartInto('2.143.0'), null);
  assert.equal(stored(side.db, noticeKey('me')), null);
  assert.equal(side.service.shouldShow('me'), false);
});

test('the first start of this feature takes the previous version from the update state of the release before', () => {
  const side = engine({ version: '2.144.0', legacyVersion: () => '2.143.1' });
  assert.equal(side.service.record().previous_version, '2.143.1');
  const fresh = engine({ version: '2.144.0', legacyVersion: () => null });
  assert.equal(fresh.service.record(), null);
});

test('the release notes are the DESIGN.md lines of the range, newest first; a version without a line is left out', () => {
  const notes = parseNotes(NOTES);
  assert.deepEqual(notes.map(entry => entry.version), ['2.143.0', '2.143.1', '2.144.0', '2.146.0']);
  assert.deepEqual(notesInRange(notes, '2.143.0', '2.146.0'), [
    { version: '2.146.0', note: 'Later work' },
    { version: '2.144.0', note: 'Updated notice' },
    { version: '2.143.1', note: 'Phone: the key row steps aside' },
  ]);
  assert.deepEqual(notesInRange(notes, '2.144.0', '2.145.0'), []);
  assert.deepEqual(notesInRange(notes, 'bad', '2.145.0'), []);
  // A line repeated keeps its last text; a note in Chinese stays as written.
  const zh = '\u66f4\u65b0\u8bf4\u660e';
  assert.deepEqual(notesInRange(parseNotes(`> v1.0.1 first\n> v1.0.1 ${zh}\n`), '1.0.0', '1.0.1'), [{ version: '1.0.1', note: zh }]);
});

test('a missing DESIGN.md is harmless: the notice comes without notes', async () => {
  const side = engine({ notesFile: notesFile(null) });
  side.service.record();
  side.restartInto('2.144.0');
  const view = await side.service.view('me');
  assert.equal(view.show, true);
  assert.deepEqual(view.notes, []);
});

// Two engines over real HTTP: the page routes of A and the engine routes of B (and C, an older engine without the capability).
async function linkedPair(t) {
  const servers = [];
  const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => { servers.push(server); resolve(`http://127.0.0.1:${server.address().port}`); }); });
  t.after(() => Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }))));
  const engineAuth = links => () => (req, res, next) => {
    const token = (req.get('Authorization') || '').replace(/^Bearer /, '');
    if (!token) return res.status(401).json({ error: 'UNAUTHORIZED' });
    req.engineAuth = { tokenId: token };
    next();
  };
  const b = engine({ name: 'K01' });
  const bApp = express();
  bApp.use(express.json());
  bApp.get('/v1/info', (req, res) => res.json({ capabilities: ['tasks:read', CAPABILITY] }));
  const bLinks = new Map([['token-from-a', { id: 'link-ab' }]]);
  bApp.use('/v1/updated-notice', createEngineUpdatedNoticeRouter({ service: () => b.service, serviceLinks: () => ({ linkForToken: token => bLinks.get(token) || null }), requireEngineAuth: engineAuth(bLinks) }));
  const bBase = await listen(bApp);

  const cApp = express();
  cApp.get('/v1/info', (req, res) => res.json({ capabilities: ['tasks:read'] }));
  cApp.get('/v1/updated-notice', (req, res) => res.json({ pending: true, version: '9.0.0' })); // never asked: C does not list the capability
  const cBase = await listen(cApp);

  const peers = [
    { id: 'link-ab', name: 'K01', online: true, baseUrl: bBase, token: 'token-from-a' },
    { id: 'link-ac', name: 'Old', online: true, baseUrl: cBase, token: 'token-c' },
    { id: 'link-ad', name: 'Away', online: false, baseUrl: 'http://127.0.0.1:9', token: 'token-d' },
  ];
  const a = engine({ serviceLinks: { peers: () => peers }, request });
  const aApp = express();
  aApp.use(express.json());
  aApp.use((req, res, next) => { req.session = { user: { login: 'me' } }; next(); });
  aApp.use('/api/system/updated-notice', createUpdatedNoticeRouter({ service: () => a.service }));
  const aBase = await listen(aApp);
  const page = async (method, body) => {
    const response = await fetch(`${aBase}/api/system/updated-notice`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { a, b, bBase, page };
}

test('a linked engine with its own notice adds a line, an older or offline one is skipped, and OK acknowledges it there too', async t => {
  const { a, b, page } = await linkedPair(t);
  for (const side of [a, b]) { side.service.record(); side.restartInto('2.144.0'); }
  const got = await page('GET');
  assert.equal(got.status, 200);
  assert.equal(got.body.show, true);
  assert.deepEqual(got.body.linked, [{ id: 'link-ab', name: 'K01', version: '2.144.0' }]);
  const done = await page('POST', { version: '2.144.0', linked: got.body.linked.map(({ id, version }) => ({ id, version })) });
  assert.deepEqual(done.body, { acknowledged: true, linked: [{ id: 'link-ab', acknowledged: true }] });
  assert.equal(a.service.shouldShow('me'), false);
  assert.equal(b.service.shouldShow('me'), false, 'opening K01 later shows nothing');
  assert.deepEqual((await page('GET')).body, { show: false });
});

test('a linked engine without a notice adds no line; the page route refuses a malformed version', async t => {
  const { a, b, page } = await linkedPair(t);
  b.service.record();
  a.service.record();
  a.restartInto('2.144.0');
  assert.deepEqual((await page('GET')).body.linked, []);
  const bad = await page('POST', { version: 12 });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'INVALID_UPDATED_NOTICE');
  // An unknown link id is not acknowledged and does not fail the request.
  assert.deepEqual((await page('POST', { version: '2.144.0', linked: [{ id: 'nobody', version: '2.144.0' }] })).body, { acknowledged: true, linked: [{ id: 'nobody', acknowledged: false }] });
});

test('the engine routes take link tokens only', async t => {
  const { b, bBase } = await linkedPair(t);
  b.service.record();
  b.restartInto('2.144.0');
  await assert.rejects(request(bBase, '/v1/updated-notice', 'not-a-link'), error => error.statusCode === 403 && error.message === 'LINKED_ONLY');
  const answer = await request(bBase, '/v1/updated-notice', 'token-from-a');
  assert.deepEqual(answer, { pending: true, version: '2.144.0', previous_version: '2.143.1', updated_at: new Date(FIXED).toISOString(), name: 'K01' });
  await assert.rejects(request(bBase, '/v1/updated-notice/ack', 'token-from-a', { method: 'POST', body: {} }), error => error.statusCode === 400);
  assert.deepEqual(await request(bBase, '/v1/updated-notice/ack', 'token-from-a', { method: 'POST', body: { version: '2.143.0' } }), { acknowledged: false });
  assert.deepEqual(await request(bBase, '/v1/updated-notice/ack', 'token-from-a', { method: 'POST', body: { version: '2.144.0' } }), { acknowledged: true });
  assert.deepEqual(await request(bBase, '/v1/updated-notice', 'token-from-a'), { pending: false, name: 'K01' });
});

test('/v1/info lists the capability', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'engine-v1.js'), 'utf8');
  assert.match(source, /require\('\.\.\/services\/updated-notice'\)\.CAPABILITY/);
  assert.match(source, /router\.use\('\/updated-notice'/);
  assert.equal(CAPABILITY, 'updated-notice');
  // The state the store keeps can be read back by the next process.
  const db = memoryDb();
  store(db, RUNNING_KEY, { version: '2.143.1' });
  const side = engine({ db, version: '2.144.0' });
  assert.equal(side.service.record().previous_version, '2.143.1');
});
