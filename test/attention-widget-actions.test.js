// Fast actions on a connected service from the desktop window ("Fast actions on a connected service" in docs/design/attention-desktop-window.md): the
// capability check of services/remote-attention.js never makes an action wait once it is known (a stale answer is used while it is read again in the
// background, and `warm` reads it ahead for a copied engine), the answer of Confirm comes back as soon as the owner applied the change and does not
// wait for the copies' background sync, and the owner's answer stands in for the item in the list until the copies have caught up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-attention-widget-actions-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'attention-widget-actions-secret-attention-widget-actions';
fs.mkdirSync(process.env.TASKS_BASE_DIR, { recursive: true });

const express = require('express');
const db = require('../db');
const { defaultService } = require('../services/attention');
const { createRemoteAttention, RemoteAttentionError } = require('../services/remote-attention');
const { createWidgetSettings } = require('../services/attention-widget');
const { createAttentionWidgetRoutes } = require('../routes/attention-widget');

const OWNER = 'owner';
const TOKEN = 'widget-token-0123456789-abcdefghijklmnopqrstuv';
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const servers = [];
test.after(() => { for (const server of servers) server.close(); fs.rmSync(root, { recursive: true, force: true }); });

async function call(method, url, body) {
  const response = await fetch(url, { method, headers: { ...AUTH, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const later = ms => new Promise(resolve => setTimeout(resolve, ms));

test('remote attention: a stale capability answer is used while it is read again in the background; warm reads it ahead', async () => {
  let clock = 0;
  const sent = [];
  let infoGate = null; // a promise that holds the /v1/info answer
  let supportedNow = true;
  const readInfo = async () => {
    sent.push('info');
    if (infoGate) await infoGate;
    return { capabilities: supportedNow ? ['attention:remote'] : [] };
  };
  const request = async (base, pathname, token, options) => { sent.push(`${options.method} ${pathname}`); return { ok: true }; };
  const remote = createRemoteAttention({ request, readInfo, now: () => clock });
  const row = { id: 1, base_url: 'http://t01.test', token_cipher: 'x' };

  // warm: one background read when nothing is known (a second warm while it runs adds none); then an action sends at once.
  remote.warm(row, 't');
  remote.warm(row, 't');
  await later(5);
  assert.deepEqual(sent, ['info']);
  remote.warm(row, 't');
  await later(5);
  assert.deepEqual(sent, ['info'], 'known: warm reads nothing');
  sent.length = 0;
  await remote.call(row, { method: 'PATCH', path: '/5', body: { status: 'done' }, token: 't' });
  assert.deepEqual(sent, ['PATCH /v1/attention/5']);

  // After INFO_MS the old answer is used at once, and one background read brings it up to date.
  clock += 31_000;
  sent.length = 0;
  let open;
  infoGate = new Promise(resolve => { open = resolve; });
  await remote.call(row, { method: 'PATCH', path: '/5', body: {}, token: 't' });
  await remote.call(row, { method: 'PATCH', path: '/5', body: {}, token: 't' });
  assert.deepEqual(sent, ['info', 'PATCH /v1/attention/5', 'PATCH /v1/attention/5'], 'the action did not wait; one background read only');
  supportedNow = false; // the engine lost the capability meanwhile
  open();
  await later(5);
  infoGate = null;
  await assert.rejects(remote.call(row, { method: 'PATCH', path: '/5', body: {}, token: 't' }), error => error instanceof RemoteAttentionError && error.statusCode === 501);

  // Nothing known: the first call still waits for /v1/info, and nothing is sent to an engine without the capability.
  sent.length = 0;
  await assert.rejects(remote.call({ id: 2, base_url: 'http://k02.test', token_cipher: 'x' }, { method: 'PATCH', path: '/1', body: {}, token: 't' }), error => error.statusCode === 501);
  assert.deepEqual(sent, ['info']);

  // A first read that fails stays an error (502), as before; a failed warm is quiet.
  const failing = createRemoteAttention({ request, readInfo: async () => { throw Object.assign(new Error('REMOTE_OFFLINE'), { statusCode: 502 }); } });
  failing.warm(row, 't');
  await later(5);
  await assert.rejects(failing.call(row, { method: 'GET', path: '', token: 't' }), error => error.statusCode === 502 && error.body.error === 'REMOTE_OFFLINE');
});

// A connected service (T01) whose items this engine keeps read copies of: `copy` is what the copies hold (until a sync round, which never ends here).
function copiedService(rowId) {
  const owner = new Map([[5, { id: 5, title: 'Remote review', status: 'review', sort_order: 2, parent_id: null, updated_at: '2026-11-25T00:00:00.000Z' }],
    [6, { id: 6, title: 'Remote other', status: 'review', sort_order: 1, parent_id: null, updated_at: '2026-11-25T00:00:00.000Z' }]]);
  const copy = new Map([...owner].map(([id, item]) => [id, { ...item }]));
  const calls = [];
  const syncs = [];
  const remote = {
    async call(row, { method, path: pathname }) {
      calls.push(`${method} ${pathname}`);
      const match = /^\/(\d+)$/.exec(pathname);
      const item = match && owner.get(Number(match[1]));
      if (method === 'GET' && item) return { item: { ...item }, events: [] };
      if (method === 'PATCH' && item) return Object.assign(item, { status: 'done', updated_at: '2026-11-25T00:00:01.000Z' }) && { ...item };
      if (method === 'DELETE' && item) { owner.delete(item.id); return null; }
      throw new RemoteAttentionError(404, { error: 'NOT_FOUND' });
    },
  };
  const copies = {
    covers: id => Number(id) === rowId,
    owners: () => [{ engine: `remote:${rowId}`, online: true }],
    onChange: fn => { copies.changed = fn; return () => {}; },
    peerOnline: () => true,
    // The background sync round: started, never awaited by the route (here it never ends).
    nudge: serverId => { syncs.push(serverId); return new Promise(() => {}); },
    offline: ({ method, itemId }) => (method === 'GET' && itemId === null ? { status: 200, body: { items: [...copy.values()].map(item => ({ ...item })) } } : null),
  };
  return { owner, copy, calls, syncs, remote, copies };
}

test('Confirm on a copied connected service answers once the owner applied it, without waiting for the sync, and the row does not come back', async () => {
  const rowId = Number(db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher, enabled) VALUES (?, ?, ?, ?, 1)').run(OWNER, 'T01', 'http://t01.test', 'x').lastInsertRowid);
  const t01 = copiedService(rowId);
  let clock = Date.parse('2026-11-25T00:00:00.000Z');
  const launcher = { verifyToken: value => value === TOKEN, setEnabled: async () => {}, status: async () => ({}) };
  const routes = createAttentionWidgetRoutes({
    service: defaultService(), launcher, settings: createWidgetSettings({ db }), db, remote: t01.remote, copies: () => t01.copies, owner: () => OWNER,
    localName: () => 'K01', localInstanceId: () => 'k01', remoteInstanceId: () => 't01', liveTerminals: () => [], liveActivity: () => [],
    now: () => new Date(clock), answeredTtlMs: 60_000,
  });
  const app = express();
  app.use('/api/attention/widget', routes.bearer);
  const base = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/api/attention/widget`)); servers.push(server); });
  const key = `remote:${rowId}:5`;
  const statusIn = list => { const found = list.items.find(item => item.key === key); return found ? found.status : null; };

  assert.equal(statusIn((await call('GET', `${base}/items`)).body), 'review');
  const confirmed = await call('POST', `${base}/items/${key}/confirm`, {});
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.status, 'done', 'the owner\'s answer');
  assert.deepEqual(t01.calls, ['GET /5', 'PATCH /5'], 'one read of the status and the change; nothing else waited for');
  assert.deepEqual(t01.syncs, [rowId], 'the copies\' sync round was started and left running');
  assert.equal(t01.copy.get(5).status, 'review', 'the copies have not caught up');

  // The list (GET /items and /tick) shows the owner's answer, not the stale copy.
  assert.equal(statusIn((await call('GET', `${base}/items`)).body), 'done');
  const tick = await call('GET', `${base}/tick`);
  assert.equal(statusIn(tick.body.list), 'done');

  // The copies catch up (the sync round lands): the copy is used again, and the stand-in is gone (a later change of the copy shows).
  Object.assign(t01.copy.get(5), { status: 'done', updated_at: '2026-11-25T00:00:01.000Z' });
  t01.copies.changed({ item: { owner_engine: `remote:${rowId}` } });
  assert.equal(statusIn((await call('GET', `${base}/items`)).body), 'done');
  Object.assign(t01.copy.get(5), { status: 'working', updated_at: '2026-11-25T00:00:05.000Z' });
  assert.equal(statusIn((await call('GET', `${base}/items`)).body), 'working', 'a newer copy wins');

  // A delete: the row leaves the list at once although the copy still has it, until the copy drops it.
  assert.equal((await call('DELETE', `${base}/items/remote:${rowId}:6`)).status, 204);
  assert.equal((await call('GET', `${base}/items`)).body.items.some(item => item.key === `remote:${rowId}:6`), false);
  t01.copy.delete(6);
  assert.equal((await call('GET', `${base}/items`)).body.items.some(item => item.key === `remote:${rowId}:6`), false);

  // A refused action leaves nothing behind: the list keeps what the owner has.
  const wrong = await call('POST', `${base}/items/${key}/confirm`, {});
  assert.equal(wrong.status, 409);

  // The stand-in lasts answeredTtlMs at most: a copy that never catches up is shown again after it.
  Object.assign(t01.owner.get(5), { status: 'review' });
  Object.assign(t01.copy.get(5), { status: 'review', updated_at: '2026-11-25T00:00:09.000Z' });
  assert.equal((await call('POST', `${base}/items/${key}/confirm`, {})).body.status, 'done');
  assert.equal(statusIn((await call('GET', `${base}/items`)).body), 'review', 'the copy is newer than the answer: the copy is the truth');
  assert.equal((await call('POST', `${base}/items/${key}/confirm`, {})).status, 409, 'the owner is done already');
  db.prepare('UPDATE remote_servers SET enabled = 0 WHERE id = ?').run(rowId);
});

test('the answer of Confirm does not wait for a slow background sync (measured)', async () => {
  const rowId = Number(db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher, enabled) VALUES (?, ?, ?, ?, 1)').run(OWNER, 'T02', 'http://t02.test', 'x').lastInsertRowid);
  const t02 = copiedService(rowId);
  const RTT = 40;
  const slow = t02.remote.call.bind(t02.remote);
  t02.remote.call = async (...args) => { await later(RTT); return slow(...args); };
  let syncDone = false;
  t02.copies.nudge = () => { later(2000).then(() => { syncDone = true; }); };
  const launcher = { verifyToken: value => value === TOKEN, setEnabled: async () => {}, status: async () => ({}) };
  const routes = createAttentionWidgetRoutes({
    service: defaultService(), launcher, settings: createWidgetSettings({ db }), db, remote: t02.remote, copies: () => t02.copies, owner: () => OWNER,
    localName: () => 'K01', localInstanceId: () => 'k01', remoteInstanceId: () => 't02', liveTerminals: () => [], liveActivity: () => [],
  });
  const app = express();
  app.use('/api/attention/widget', routes.bearer);
  const base = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/api/attention/widget`)); servers.push(server); });
  const started = Date.now();
  const answer = await call('POST', `${base}/items/remote:${rowId}:5/confirm`, {});
  const took = Date.now() - started;
  assert.equal(answer.body.status, 'done');
  assert.equal(syncDone, false, 'answered before the sync round ended');
  assert.ok(took < RTT * 2 + 1000, `two round trips, not the 2 s sync (${took} ms)`);
  db.prepare('UPDATE remote_servers SET enabled = 0 WHERE id = ?').run(rowId);
});
