// T-Attention read copies across linked devices (services/attention-copy.js, services/attention-copy-merge.js, routes/attention-copy.js, the copies of
// routes/attention.js and the window's copyEngine in routes/attention-widget.js; docs/design/attention-copies.md): the merge and queue rules (pure, a fake
// clock), and services running in this process as real HTTP servers joined by service links (the page routes, /v1/info, /v1/attention and
// /v1/attention-copy of each, sealed with the settings sync's link keys): copies both ways, an offline owner still listed "as of", a queued change
// applied when the owner is back, a dropped one, refused unsafe actions, deletes, no double notification, an older peer, a chain, the stream.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// db/index.js (required by some services below) refuses to run a test on the real ~/.tagent: a temporary data folder first.
process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-attention-copy-data-'));
delete process.env.TAGENT_HOME;
const express = require('express');
const Database = require('better-sqlite3');

const merge = require('../services/attention-copy-merge');
const { createAttentionCopy, CAPABILITY } = require('../services/attention-copy');
const { createEngineAttentionCopyRouter } = require('../routes/attention-copy');
const { createAttentionService } = require('../services/attention');
const { createAttentionRoutes, createEngineAttentionRouter } = require('../routes/attention');
const { copyEngine } = require('../routes/attention-widget');
const { RemoteAttentionError } = require('../services/remote-attention');
const { createSettingsSync } = require('../services/settings-sync');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const NOW = Date.UTC(2026, 10, 20, 9, 0, 0);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await settle();
  }
}

// ---- The rules (pure) ----

test('the version clock never goes back, also when the clock does', () => {
  assert.equal(merge.nextRev(0, NOW), NOW);
  assert.equal(merge.nextRev(NOW, NOW), NOW + 1, 'two changes in one millisecond');
  assert.equal(merge.nextRev(NOW + 50, NOW), NOW + 51, 'the clock went back');
  assert.equal(merge.nextRev(undefined, NOW + 0.7), NOW);
});

test('a row from a peer is checked: owner, id, version, time and a real item; a tombstone needs no item', () => {
  const owner = 'aaaaaaaa-1111-4111-8111-111111111111';
  const item = { id: 5, title: 'Check the build', status: 'waiting_user', context: { tagent: { task_id: '3', terminal_id: 't1' } } };
  const row = { owner, id: 5, rev: NOW, deleted: false, item, event: { type: 'status', actor: 'claude', at: new Date(NOW).toISOString(), data: { secret: 1 } }, at: new Date(NOW).toISOString() };
  const good = merge.rowFromPeer(row);
  assert.deepEqual(good.item, item);
  assert.deepEqual(good.event, { type: 'status', actor: 'claude', at: new Date(NOW).toISOString() }, 'the event keeps its kind and actor, never its data');
  assert.deepEqual(merge.rowFromPeer({ ...row, deleted: true, item: null }).deleted, true);
  for (const bad of [
    { ...row, owner: 'not an id' }, { ...row, id: 0 }, { ...row, rev: -1 }, { ...row, at: 'yesterday' }, { ...row, item: { ...item, id: 6 } },
    { ...row, item: { ...item, status: 'sleeping' } }, { ...row, item: { ...item, title: '' } }, { ...row, item: { ...item, notes: 'x'.repeat(70000) } }, null, [],
  ]) assert.equal(merge.rowFromPeer(bad), null, JSON.stringify(bad && bad.item ? { status: bad.item.status, id: bad.item.id } : bad).slice(0, 80));
  assert.equal(merge.wins({ rev: 2 }, null), true);
  assert.equal(merge.wins({ rev: 2 }, { rev: 1 }), true);
  assert.equal(merge.wins({ rev: 2 }, { rev: 2 }), false, 'the same version: nothing to do (an echo)');
  assert.equal(merge.wins({ rev: 1 }, { rev: 2 }), false);
  assert.equal(merge.changeKind({ deleted: false }, null), 'created');
  assert.equal(merge.changeKind({ deleted: false }, { deleted: true }), 'created');
  assert.equal(merge.changeKind({ deleted: false }, { deleted: false }), 'updated');
  assert.equal(merge.changeKind({ deleted: true }, { deleted: false }), 'deleted');
});

test('a change older than a minute when it arrives is quiet (no reminder); a fresh one is not', () => {
  const at = new Date(NOW).toISOString();
  assert.equal(merge.isQuiet(at, NOW + 1000), false);
  assert.equal(merge.isQuiet(at, NOW + 60 * 1000), false);
  assert.equal(merge.isQuiet(at, NOW + 61 * 1000), true);
  assert.equal(merge.isQuiet('', NOW), true);
});

test('offline: fields and a note are queued; delete, move, summary, a new task and tree or agent fields are refused', () => {
  const handled = merge.queueRule('PATCH', '', { status: 'working', attention_reason: null, activity: { kind: 'note', text: 'Handled' } });
  assert.deepEqual(handled, { queue: { fields: { status: 'working', attention_reason: null }, activity: { kind: 'note', text: 'Handled' } } });
  assert.deepEqual(merge.queueRule('PATCH', '', { notes: '', due_date: '2026-12-01', plain_turn_end: true }).queue.fields, { notes: null, due_date: '2026-12-01' });
  for (const [method, sub, body, hasItem] of [['DELETE', '', undefined], ['POST', '/move', { position: 'top' }], ['POST', '/summarize', {}], ['POST', '', { title: 'x' }, false], ['PATCH', '', { parent_id: 3 }], ['PATCH', '', { context: { goal: 'x' } }], ['PATCH', '', { activity: { kind: 'prompt', text: 'x' } }]]) {
    const rule = merge.queueRule(method, sub, body, { hasItem: hasItem !== false });
    assert.equal(rule.refuse && rule.refuse.error, 'ATTENTION_OWNER_OFFLINE', `${method} ${sub} ${JSON.stringify(body)}`);
    assert.equal(rule.refuse.status, 409);
  }
  assert.equal(merge.queueRule('PATCH', '', { status: 'sleeping' }).refuse.error, 'VALIDATION_FAILED');
  assert.equal(merge.queueRule('PATCH', '', {}).refuse.error, 'VALIDATION_FAILED');
  assert.equal(merge.queueRule('PATCH', '', { title: '  ' }).refuse.error, 'VALIDATION_FAILED');
});

test('queued changes are shown applied in order; on the owner each is applied, already there, or dropped when the owner changed the field meanwhile', () => {
  const item = { id: 1, title: 'A', status: 'waiting_user', attention_reason: 'Allow rm?', notes: null };
  const first = { fields: { status: 'working', attention_reason: null }, activity: { kind: 'note', text: 'Handled' } };
  first.base = merge.baseOf(item, first.fields);
  assert.deepEqual(first.base, { status: 'waiting_user', attention_reason: 'Allow rm?' });
  const shown = merge.project(item, [first]);
  assert.equal(shown.status, 'working');
  assert.equal(item.status, 'waiting_user', 'the copy itself is not changed');
  const second = { fields: { status: 'done' } };
  second.base = merge.baseOf(shown, second.fields);
  assert.equal(merge.project(item, [first, second]).status, 'done');

  // The owner as it was: both apply in order (the second starts from what the first made).
  assert.deepEqual(merge.resolveQueued(first, item), { apply: { body: { status: 'working', attention_reason: null, activity: { kind: 'note', text: 'Handled' } } } });
  assert.deepEqual(merge.resolveQueued(second, { ...item, status: 'working', attention_reason: null }), { apply: { body: { status: 'done' } } });
  // The owner already has it.
  assert.deepEqual(merge.resolveQueued({ fields: { status: 'done' }, base: { status: 'review' } }, { ...item, status: 'done' }), { noop: true });
  // The owner changed the status meanwhile: its change wins, the queued one is dropped whole (its note too).
  assert.deepEqual(merge.resolveQueued(first, { ...item, status: 'review' }), { drop: 'newer' });
  // Another field changed on the owner: no conflict.
  assert.deepEqual(merge.resolveQueued({ fields: { notes: 'mine' }, base: { notes: null } }, { ...item, status: 'review' }), { apply: { body: { notes: 'mine' } } });
  assert.deepEqual(merge.resolveQueued(first, null), { drop: 'gone' });
});

// ---- Services in this process, joined by links ----
const pass = (req, res, next) => { req.session = { user: { login: 'me' } }; next(); };

async function makeNetwork(t, names, { links: pairs = [], capabilities = {} } = {}) {
  const sides = {};
  for (const name of names) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-attention-copy-'));
    const db = new Database(path.join(dir, 'db.sqlite'));
    db.exec(SCHEMA);
    t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const instanceId = crypto.randomUUID();
    const side = { name, db, instanceId, peers: [], issued: new Map(), linkByToken: new Map(), requests: [], logs: [], clock: NOW, capabilities: capabilities[name] || [CAPABILITY, 'attention:remote'] };
    const identity = () => ({ instance_id: instanceId, name });
    const linkListeners = new Set();
    side.links = {
      peers: () => side.peers,
      onChange: listener => { linkListeners.add(listener); return () => linkListeners.delete(listener); },
      noteUnauthorized() {},
    };
    side.setOnline = (peerName, online) => { side.peers.find(peer => peer.name === peerName).online = online; for (const listener of linkListeners) listener(side.peers.find(peer => peer.name === peerName).id); };
    side.settingsSync = createSettingsSync({
      db, sessionSecret: `${name}-secret-${name}-secret`, serviceLinks: side.links, registry: [], owner: () => 'me', identity,
      issuedTokenHash: peer => { const token = side.issued.get(peer.id); return token ? sha(token) : null; },
      request: null, log: { warn() {}, info() {} }, intervalMs: 0,
    });
    side.service = createAttentionService({ db, now: () => new Date(side.clock) });
    // A notifier of this engine: what its own change bus delivers (the notifiers, the AI summary and /v1/attention/stream follow this bus).
    side.notified = [];
    side.service.onChange(change => { if (change.item && ['waiting_user', 'review', 'failed'].includes(change.item.status) && (!change.previous || change.previous.status !== change.item.status)) side.notified.push(change.item.title); });
    side.request = async (baseUrl, route, token, opts = {}) => {
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
    };
    side.copy = createAttentionCopy({
      db, service: side.service, serviceLinks: side.links, identity, host: () => `${name.toLowerCase()}.local`,
      linkKeys: { publicKey: () => side.settingsSync.publicKey(), linkKey: (peer, key) => side.settingsSync.linkKey(peer, key) },
      now: () => side.clock, log: { warn: message => side.logs.push(message), info() {} }, intervalMs: 0, pushMs: 20, request: side.request,
    });
    side.copied = [];
    side.copy.onChange(change => side.copied.push(change));
    const app = express();
    app.use(express.json({ limit: '32mb' }));
    const engineAuth = () => (req, res, next) => {
      const token = (req.get('Authorization') || '').replace(/^Bearer /, '');
      if (!side.linkByToken.has(token)) return res.status(401).json({ error: 'UNAUTHORIZED' });
      req.engineAuth = { tokenId: token, role: 'admin', scopes: ['*'] };
      next();
    };
    app.get('/v1/info', engineAuth(), (req, res) => res.json({ engine_id: instanceId, name, capabilities: side.capabilities }));
    app.use('/v1/attention-copy', createEngineAttentionCopyRouter({ service: () => side.copy, serviceLinks: () => ({ linkForToken: token => side.linkByToken.get(token) || null }), requireEngineAuth: engineAuth, enabled: () => true }));
    app.use('/v1/attention', createEngineAttentionRouter({ service: side.service, authenticate: engineAuth(), instanceId: () => instanceId, heartbeatMs: 60000 }));
    const routes = createAttentionRoutes({ service: side.service, copies: () => side.copy, instanceId: () => instanceId, heartbeatMs: 60000 });
    app.use('/api/attention', pass, routes.router);
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => new Promise(resolve => { side.copy.stop(); routes.closeStreams(); server.closeAllConnections(); server.close(resolve); }));
    side.base = `http://127.0.0.1:${server.address().port}`;
    side.page = async (method, route, body) => {
      const response = await fetch(`${side.base}/api/attention${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    side.add = (title, extra = {}) => side.service.create({ title, ...extra }, { actor: 'claude', defaultSource: 'claude' });
    side.copies = async () => (await side.page('GET', '?include_done=1&copies=1')).body.copies;
    sides[name] = side;
  }
  let serial = 0;
  for (const [x, y] of pairs) {
    serial += 1;
    const linkId = `link-${serial}-${x}-${y}`;
    const tokenXY = `tae_${crypto.randomBytes(32).toString('base64url')}`;
    const tokenYX = `tae_${crypto.randomBytes(32).toString('base64url')}`;
    const X = sides[x];
    const Y = sides[y];
    X.peers.push({ id: linkId, name: y, online: true, remoteServerId: serial, instanceId: Y.instanceId, baseUrl: Y.base, token: tokenXY });
    Y.peers.push({ id: linkId, name: x, online: true, remoteServerId: serial + 100, instanceId: X.instanceId, baseUrl: X.base, token: tokenYX });
    X.issued.set(linkId, tokenYX);
    Y.issued.set(linkId, tokenXY);
    Y.linkByToken.set(tokenXY, { id: linkId, revoked: false, peer_instance_id: X.instanceId });
    X.linkByToken.set(tokenYX, { id: linkId, revoked: false, peer_instance_id: Y.instanceId });
  }
  for (const side of Object.values(sides)) side.copy.start();
  return sides;
}
const queueRows = side => side.db.prepare('SELECT state, reason FROM attention_copy_queue ORDER BY id').all();

test('two linked engines: each keeps a copy of the other\'s items, marked with its owner; its own list and an echo are unchanged', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  const mine = A.add('Fix the login page', { status: 'waiting_user', attention_reason: 'Allow npm test?', context: { tagent: { task_id: '7', terminal_id: 'term-1' }, host: 'a.local' } });
  B.clock += 1000;
  const theirs = B.add('Write the report');
  await A.copy.syncAll();

  const onB = await B.copies();
  assert.deepEqual(onB.items.map(item => [item.title, item.owner, item.owner_name, item.owner_engine, item.copy]), [['Fix the login page', A.instanceId, 'A', 'remote:101', true]]);
  assert.deepEqual(onB.items[0].context, mine.context, 'the whole item, its session included');
  assert.deepEqual(onB.items[0].pending, []);
  // as_of: the last time B heard from A, by B's clock.
  assert.deepEqual(onB.owners, [{ instance_id: A.instanceId, name: 'A', host: 'a.local', engine: 'remote:101', linked: true, online: true, as_of: new Date(NOW + 1000).toISOString() }]);
  const onA = await A.copies();
  assert.deepEqual(onA.items.map(item => [item.title, item.owner, item.owner_engine]), [['Write the report', B.instanceId, 'remote:1']]);
  assert.equal(onA.items[0].id, theirs.id);

  // Without copies=1 (the CLI, the listeners, an older page) the list is this engine's own items, as before.
  const plain = (await B.page('GET', '?include_done=1')).body;
  assert.deepEqual(plain.items.map(item => item.title), ['Write the report']);
  assert.equal(plain.copies, undefined);

  // A change on the owner reaches the copy; a second round applies nothing and sends no page.
  A.clock += 2000;
  A.service.update(mine.id, { title: 'Fix the login page now' }, { actor: 'user' });
  await A.copy.syncAll();
  assert.equal((await B.copies()).items[0].title, 'Fix the login page now');
  A.requests.length = 0;
  assert.equal(await A.copy.syncPeer(A.peers[0]), 0);
  assert.deepEqual(A.requests, ['GET B /v1/info', 'GET B /v1/attention-copy']);
  // An activity note alone changes nothing a copy shows: no new row is made for it.
  const seq = A.db.prepare("SELECT sync_seq FROM attention_copies WHERE owner = ''").pluck().all();
  A.service.update(mine.id, { activity: { kind: 'prompt', text: 'go on' } }, { actor: 'claude' });
  assert.deepEqual(A.db.prepare("SELECT sync_seq FROM attention_copies WHERE owner = ''").pluck().all(), seq);
});

test('pushed a moment after a change, without a round asked for; the change is on the copy bus (for the page), never on the notifiers\' bus', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  A.add('Deploy', { status: 'working' });
  await until(async () => (await B.copies()).items.length === 1, 'the first push');
  B.copied.length = 0;
  A.clock += 3000;
  const item = A.service.list({ includeDone: true })[0];
  A.service.update(item.id, { status: 'waiting_user', attention_reason: 'Approve the deploy?' }, { actor: 'claude' });
  await until(() => B.copied.some(change => change.item && change.item.status === 'waiting_user'), 'the push of the status change');
  const change = B.copied.find(entry => entry.item && entry.item.status === 'waiting_user');
  assert.equal(change.kind, 'updated');
  assert.equal(change.copy, true);
  assert.equal(change.previous.status, 'working');
  assert.equal(change.event.type, 'status');
  assert.equal(change.event.actor, 'claude');
  assert.equal(change.quiet, undefined, 'news, not history: the page may remind');
  // No double notification: the owner's notifier saw it once, the copy's engine none.
  assert.deepEqual(A.notified, ['Deploy']);
  assert.deepEqual(B.notified, []);
});

test('an offline owner: its items stay listed "as of" the last time it was heard; a fresh copy arriving late is quiet', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  A.add('Review the PR', { status: 'review' });
  await A.copy.syncAll();
  B.setOnline('A', false);
  A.setOnline('B', false);
  B.clock += 3 * 60 * 60 * 1000;
  const onB = await B.copies();
  assert.deepEqual(onB.items.map(item => item.title), ['Review the PR'], 'still listed');
  assert.deepEqual(onB.owners.map(owner => [owner.name, owner.online, owner.as_of]), [['A', false, new Date(NOW).toISOString()]]);
  assert.ok(B.copied.some(change => change.kind === 'owners' && change.owners[0].online === false), 'the stream is told the owner went offline');

  // A change made on A while apart arrives later than a minute after it was made: shown, but not a reminder.
  A.clock += 5000;
  A.add('Failed build', { status: 'failed' });
  A.clock += 10 * 60 * 1000;
  B.setOnline('A', true);
  A.setOnline('B', true);
  await A.copy.syncAll();
  const late = B.copied.find(change => change.item && change.item.title === 'Failed build');
  assert.equal(late.quiet, true);
});

test('a queued change: shown at once as pending, applied in order when the owner is back, with its note', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  const item = A.add('Run the migration', { status: 'waiting_user', attention_reason: 'Allow the migration?' });
  await A.copy.syncAll();
  B.setOnline('A', false);
  A.setOnline('B', false);
  B.clock += 60000;
  const handled = B.copy.offline({ serverId: 101, method: 'PATCH', itemId: item.id, body: { status: 'working', attention_reason: null, activity: { kind: 'note', text: 'Handled' } } });
  assert.equal(handled.status, 202);
  assert.equal(handled.body.status, 'working');
  assert.equal(handled.body.attention_reason, null);
  assert.deepEqual(handled.body.pending.map(entry => entry.fields), [['status', 'attention_reason']]);
  const notes = B.copy.offline({ serverId: 101, method: 'PATCH', itemId: item.id, body: { notes: 'Done by hand on B' } });
  assert.equal(notes.status, 202);
  const listed = (await B.copies()).items[0];
  assert.equal(listed.status, 'working');
  assert.equal(listed.notes, 'Done by hand on B');
  assert.equal(listed.pending.length, 2);
  assert.equal(A.service.get(item.id).status, 'waiting_user', 'nothing reached the owner yet');

  B.setOnline('A', true);
  A.setOnline('B', true);
  await B.copy.syncAll();
  const now = A.service.get(item.id);
  assert.equal(now.status, 'working');
  assert.equal(now.attention_reason, null);
  assert.equal(now.notes, 'Done by hand on B');
  assert.ok(A.service.events(item.id).some(event => event.type === 'activity' && event.data.text === 'Handled' && event.actor === 'user'), 'the note, made by the person');
  assert.deepEqual(queueRows(B), [], 'applied: the queue is empty');
  await until(async () => { const copy = (await B.copies()).items[0]; return copy.pending.length === 0 && copy.notes === 'Done by hand on B'; }, 'the copy follows the owner');
});

test('a dropped queued change: the owner changed the same field meanwhile, so its change wins and the page is told', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  const item = A.add('Answer the question', { status: 'waiting_user', attention_reason: 'Which branch?' });
  await A.copy.syncAll();
  B.setOnline('A', false);
  A.setOnline('B', false);
  assert.equal(B.copy.offline({ serverId: 101, method: 'PATCH', itemId: item.id, body: { status: 'done' } }).status, 202);
  A.clock += 30000;
  A.service.update(item.id, { status: 'review', result: 'Used main' }, { actor: 'claude' }); // the agent went on by itself
  B.setOnline('A', true);
  A.setOnline('B', true);
  B.copied.length = 0;
  await B.copy.syncAll();
  assert.equal(A.service.get(item.id).status, 'review', 'the owner\'s newer change stays');
  assert.deepEqual(queueRows(B), [{ state: 'dropped', reason: 'newer' }]);
  const told = B.copied.find(change => change.dropped_now);
  assert.deepEqual(told.dropped_now.map(entry => entry.reason), ['newer']);
  const copy = (await B.copies()).items[0];
  assert.equal(copy.status, 'review');
  assert.deepEqual(copy.dropped.map(entry => [entry.fields, entry.reason]), [[['status'], 'newer']]);
  // The person read the note: it goes.
  const dismissed = await B.page('DELETE', `/copies/queue/${copy.dropped[0].id}`);
  assert.equal(dismissed.status, 204);
  assert.deepEqual((await B.copies()).items[0].dropped, []);
  assert.equal((await B.page('DELETE', '/copies/queue/999')).status, 404);
});

test('unsafe actions on an offline owner\'s item are refused with a clear note; nothing is queued', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  const item = A.add('Clean up');
  await A.copy.syncAll();
  B.setOnline('A', false);
  for (const [method, sub, body, itemId, message] of [
    ['DELETE', '', undefined, item.id, 'A task can only be deleted while the device it belongs to is online'],
    ['POST', '/move', { position: 'top' }, item.id, 'The order can only be changed while the device the task belongs to is online'],
    ['POST', '/summarize', {}, item.id, 'A summary can only be made while the device the task belongs to is online'],
    ['POST', '', { title: 'New' }, null, 'Tasks can only be added while the device they go to is online'],
    ['PATCH', '', { parent_id: 4 }, item.id, 'This change can only be made while the device the task belongs to is online'],
  ]) {
    const answer = B.copy.offline({ serverId: 101, method, itemId, sub, body });
    assert.deepEqual(answer, { status: 409, body: { error: 'ATTENTION_OWNER_OFFLINE', message } }, `${method} ${sub}`);
  }
  assert.deepEqual(queueRows(B), []);
  // A read of the item answers the copy (no history: it is on the owner); an unknown item is 404; a row the copies do not cover is not answered.
  const read = B.copy.offline({ serverId: 101, method: 'GET', itemId: item.id });
  assert.equal(read.status, 200);
  assert.equal(read.body.item.title, 'Clean up');
  assert.deepEqual(read.body.events, []);
  assert.equal(read.body.copy.owner, A.instanceId);
  assert.equal(B.copy.offline({ serverId: 101, method: 'GET', itemId: 999 }).status, 404);
  assert.equal(B.copy.offline({ serverId: 55, method: 'GET', itemId: item.id }), null);
});

test('a delete travels as a tombstone; an old copy never brings the item back', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  const item = A.add('Temporary');
  await A.copy.syncAll();
  const before = B.db.prepare('SELECT * FROM attention_copies WHERE owner = ? AND item_id = ?').get(A.instanceId, item.id);
  A.clock += 1000;
  A.service.remove(item.id, { actor: 'user' });
  B.copied.length = 0;
  await A.copy.syncAll();
  assert.deepEqual((await B.copies()).items, []);
  assert.equal(B.copied[0].kind, 'deleted');
  assert.equal(B.copied[0].item.title, 'Temporary');
  // The row from before the delete, sent again (a slow path, a restored peer): older than the tombstone, so it is dropped.
  assert.equal(B.copy.applyPage({ rows: [{ owner: A.instanceId, id: item.id, rev: before.rev, deleted: false, item: JSON.parse(before.item), event: null, at: before.at }] }, A.instanceId), 0);
  assert.deepEqual((await B.copies()).items, []);
  // A row of one's own items from a peer is never taken.
  assert.equal(A.copy.applyPage({ rows: [{ owner: A.instanceId, id: 99, rev: NOW * 2, deleted: false, item: { id: 99, title: 'Forged', status: 'todo' }, event: null, at: new Date(NOW).toISOString() }] }, B.instanceId), 0);
  assert.equal(A.db.prepare('SELECT COUNT(*) FROM attention_copies WHERE item_id = 99').pluck().get(), 0);
});

test('an older peer without attention:copy is skipped, and read live by the page as before', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']], capabilities: { B: ['attention:remote'] } });
  A.add('Mine');
  B.add('Theirs');
  A.requests.length = 0;
  await A.copy.syncAll();
  assert.ok(A.requests.length && A.requests.every(entry => entry === 'GET B /v1/info'), A.requests.join(', '));
  assert.deepEqual(A.copy.peerStates()[A.peers[0].id].supported, false);
  assert.deepEqual((await A.copies()).owners, [], 'not one of the owners: the page reads it through the proxy');
  assert.equal(A.copy.covers(1), false);
  assert.equal(A.copy.offline({ serverId: 1, method: 'GET', itemId: 1 }), null);
});

test('a chain A-B-C: A\'s items reach C through B; C reads them but cannot change them, and A\'s delete reaches C', async t => {
  const { A, B, C } = await makeNetwork(t, ['A', 'B', 'C'], { links: [['A', 'B'], ['B', 'C']] });
  const item = A.add('Far away task', { status: 'review' });
  await until(async () => (await C.copies()).items.length === 1, 'the item reaches C');
  const onC = await C.copies();
  assert.equal(onC.items[0].owner, A.instanceId);
  assert.equal(onC.items[0].owner_engine, null, 'no link of C names A');
  const owner = onC.owners.find(entry => entry.instance_id === A.instanceId);
  assert.deepEqual([owner.name, owner.linked, owner.online, owner.host], ['A', false, false, 'a.local']);
  const read = await C.page('GET', `/copies/${A.instanceId}/${item.id}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.item.title, 'Far away task');
  const write = await C.page('PATCH', `/copies/${A.instanceId}/${item.id}`, { status: 'done' });
  assert.equal(write.status, 409);
  assert.equal(write.body.error, 'ATTENTION_OWNER_NOT_LINKED');
  assert.equal((await C.page('GET', `/copies/${A.instanceId}/999`)).status, 404);
  // B's own item reaches C directly and A through B; nobody keeps a copy of its own items.
  B.add('Middle task');
  await until(async () => (await A.copies()).items.length === 1 && (await C.copies()).items.length === 2, 'B\'s item reaches both');
  for (const side of [A, B, C]) assert.equal(side.db.prepare('SELECT COUNT(*) FROM attention_copies WHERE owner = ?').pluck().get(side.instanceId), 0, side.name);
  A.clock += 1000;
  A.service.remove(item.id, { actor: 'user' });
  await until(async () => (await C.copies()).items.every(entry => entry.title !== 'Far away task'), 'the delete reaches C');
});

test('the start check journals a change made while the copies were off, and a delete', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  const kept = A.add('Kept');
  const gone = A.add('Gone');
  await A.copy.syncAll();
  A.copy.stop(); // an older version runs, or the server stopped before the journal was written
  A.db.prepare("UPDATE attention_items SET status = 'done', updated_at = ? WHERE id = ?").run(new Date(NOW + 5000).toISOString(), kept.id);
  A.db.prepare('DELETE FROM attention_items WHERE id = ?').run(gone.id);
  A.clock += 10000;
  assert.equal(A.copy.reconcile(), 2);
  assert.equal(A.copy.reconcile(), 0, 'a second check finds nothing');
  await A.copy.syncAll();
  const onB = await B.copies();
  assert.deepEqual(onB.items.map(item => [item.title, item.status]), [['Kept', 'done']]);
});

test('the page stream with copies=1 carries the copies\' changes; without it only this engine\'s own', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  const read = async (query, wanted) => {
    const controller = new AbortController();
    const response = await fetch(`${B.base}/api/attention/stream${query}`, { signal: controller.signal });
    const reader = response.body.getReader();
    let text = '';
    const go = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; text += Buffer.from(value).toString('utf8'); } })().catch(() => {});
    await until(() => text.includes(': connected'), 'connected');
    return { text: () => text, close: () => { controller.abort(); return go; }, wanted };
  };
  const withCopies = await read('?copies=1');
  const without = await read('');
  A.add('Streamed', { status: 'waiting_user' });
  await A.copy.syncAll();
  await until(() => withCopies.text().includes('"title":"Streamed"'), 'the copy change on the stream');
  const change = [...withCopies.text().matchAll(/event: change\ndata: (.+)\n/g)].map(match => JSON.parse(match[1])).find(entry => entry.item && entry.item.title === 'Streamed');
  assert.equal(change.copy, true);
  assert.equal(change.item.owner, A.instanceId);
  B.add('Own');
  await until(() => without.text().includes('"title":"Own"'), 'the own change');
  assert.equal(without.text().includes('Streamed'), false);
  await withCopies.close();
  await without.close();
});

test('the desktop window\'s engine of a copied device: reads the copies, writes to the owner while it answers, queues or refuses while it does not', async t => {
  const { A, B } = await makeNetwork(t, ['A', 'B'], { links: [['A', 'B']] });
  const item = A.add('Window task', { status: 'review' });
  await A.copy.syncAll();
  const sent = [];
  const live = { get: async id => (sent.push(['get', id]), A.service.get(id)), update: async (id, body) => (sent.push(['update', id]), A.service.update(id, body, { actor: 'user' })), remove: async id => sent.push(['remove', id]), move: async () => {}, create: async () => {} };
  const engine = copyEngine(live, 101, B.copy);
  assert.deepEqual(engine.list().map(entry => entry.title), ['Window task'], 'read from the copies, no request');
  assert.deepEqual(sent, []);
  const updated = await engine.update(item.id, { priority: 'high' });
  assert.equal(updated.priority, 'high');
  assert.deepEqual(sent, [['update', item.id]], 'online: to the owner');
  B.setOnline('A', false);
  sent.length = 0;
  const queued = await engine.update(item.id, { status: 'done' });
  assert.equal(queued.status, 'done');
  assert.equal(queued.pending.length, 1);
  assert.deepEqual(sent, []);
  await assert.rejects(engine.remove(item.id), error => error instanceof RemoteAttentionError && error.statusCode === 409 && error.body.error === 'ATTENTION_OWNER_OFFLINE');
  assert.equal((await engine.get(item.id)).status, 'done', 'the copy as it will be');
});
