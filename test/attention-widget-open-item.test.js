// A task's details without a new tab: a click on a task row (or a task's bubble) of the desktop window asks POST /api/attention/widget/open-item
// { key } (routes/attention-widget.js), which tells one open T-Agent page of this machine, through its T-Attention stream (GET
// /api/attention/stream?tab=1, routes/attention.js, services/page-channel.js), to show that task's details (`open-item` { key }), and asks the browser
// extension to bring that tab forward (a fake bridge here). The same page choice as Open session (test/attention-widget-open-terminal.test.js): the
// page seen last. An unknown key is refused, a task that is not there and a device that is not connected are 404 (the window then opens the link).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-open-item-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
fs.mkdirSync(process.env.TASKS_BASE_DIR, { recursive: true });

const express = require('express');
const db = require('../db');
const { createPageChannel } = require('../services/page-channel');
const { createAttentionRoutes } = require('../routes/attention');
const { createAttentionWidgetRoutes } = require('../routes/attention-widget');
const { createWidgetSettings } = require('../services/attention-widget');
const { RemoteAttentionError } = require('../services/remote-attention');

const OWNER = 'owner';
const TOKEN = 'widget-token-0123456789-abcdefghijklmnopqrstuv';
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const servers = [];
const streamsOpen = [];
const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); servers.push(server); });
test.after(() => {
  for (const stream of streamsOpen) stream.close();
  for (const server of servers) { server.closeAllConnections?.(); server.close(); }
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function call(method, url, body, headers = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: response.status, body: parsed };
}

// A server-sent event stream read in the background: its events as { event, data }.
async function openStream(url, headers = {}) {
  const ctrl = new AbortController();
  const response = await fetch(url, { headers: { Accept: 'text/event-stream', ...headers }, signal: ctrl.signal });
  const stream = { status: response.status, events: [], close() { ctrl.abort(); } };
  streamsOpen.push(stream);
  (async () => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (data) stream.events.push({ event, data: JSON.parse(data) });
        }
      }
    } catch { /* closed */ }
  })();
  return stream;
}
const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const told = (stream, event = 'open-item') => stream.events.filter(e => e.event === event).map(e => e.data);

const remoteId = Number(db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher, enabled) VALUES (?, ?, ?, ?, ?)').run(OWNER, 'Laptop', 'http://laptop.test', 'x', 1).lastInsertRowid);
const offId = Number(db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher, enabled) VALUES (?, ?, ?, ?, ?)').run(OWNER, 'Off', 'http://off.test', 'x', 0).lastInsertRowid);

async function setUp({ bridge, remoteCall } = {}) {
  let clock = 1000;
  const pages = createPageChannel({ now: () => clock });
  const localItems = new Map([[3, { id: 3, title: 'Local task', status: 'working' }]]);
  const remoteReads = [];
  const service = { onChange: () => () => {}, tokenActive: () => true, get: id => localItems.get(Number(id)) || null };
  const attention = createAttentionRoutes({ service, pages, heartbeatMs: 60000 });
  const page = express();
  page.use(express.json());
  page.use('/api/attention', attention.router);
  const pageBase = await listen(page);
  const remote = {
    call: async (row, { method, path: pathname }) => {
      remoteReads.push(`${row.id} ${method} ${pathname}`);
      if (remoteCall) return remoteCall(row, method, pathname);
      if (method === 'GET' && pathname === '/4') return { item: { id: 4, title: 'Remote task', status: 'review' } };
      throw new RemoteAttentionError(404, { error: 'NOT_FOUND', message: 'Task not found' });
    },
  };
  const launcher = { verifyToken: value => value === TOKEN, setEnabled: async () => {}, status: async () => ({}) };
  const widget = createAttentionWidgetRoutes({
    service, launcher, settings: createWidgetSettings({ db }), db, pages, remote, owner: () => OWNER, copies: () => null, readTimeoutMs: 300,
    bridge: bridge || { command: async () => ({ focused: true }) },
  });
  const app = express();
  app.use('/api/attention/widget', widget.bearer);
  const widgetBase = await listen(app);
  return {
    pages, pageBase, widgetBase, remoteReads, tick: () => { clock += 1000; },
    open: (body, headers = AUTH) => call('POST', `${widgetBase}/api/attention/widget/open-item`, body, headers),
  };
}

test('a task of this machine or of a connected service: the page seen last shows its details, and the tab comes forward', async () => {
  const calls = [];
  const world = await setUp({ bridge: { command: async (method, params) => { calls.push([method, params]); return { focused: true }; } } });
  const url = `${world.pageBase}/api/attention/stream`;
  const plain = await openStream(url);
  const first = await openStream(`${url}?tab=1`);
  await until(() => first.events.some(e => e.event === 'hello'));
  world.tick();
  const second = await openStream(`${url}?tab=1`);
  await until(() => second.events.some(e => e.event === 'hello'));
  world.tick();

  assert.deepEqual(await world.open({ key: 'local:3' }), { status: 200, body: { delivered: 1, focused: true } });
  await until(() => told(second).length === 1);
  assert.deepEqual(told(second), [{ key: 'local:3' }]);
  assert.deepEqual(calls, [['tabs.reveal', { origin: world.pageBase }]]);
  assert.deepEqual(told(second, 'open-terminal'), [], 'never a terminal');

  // The first page is seen now: it gets the next one; the task of a connected service is asked of its owner.
  world.tick();
  const firstId = first.events.find(e => e.event === 'hello').data.stream;
  assert.deepEqual((await call('POST', `${url}/seen`, { stream: firstId })).body, { ok: true });
  assert.deepEqual((await world.open({ key: `remote:${remoteId}:4` })).body, { delivered: 1, focused: true });
  await until(() => told(first).length === 1);
  assert.deepEqual(told(first), [{ key: `remote:${remoteId}:4` }]);
  assert.deepEqual(world.remoteReads, [`${remoteId} GET /4`]);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(told(second).length, 1, 'the other page is not told');
  assert.deepEqual(told(plain), [], 'a stream that is no page is never told');

  // No page open: delivered 0 (the window opens `?openAttention=<key>`), the extension is not asked.
  first.close();
  second.close();
  await until(() => world.pages.size() === 0);
  calls.length = 0;
  assert.deepEqual((await world.open({ key: 'local:3' })).body, { delivered: 0, focused: false });
  assert.deepEqual(calls, []);
  plain.close();
});

test('a task that is not there, a device that is not connected and a bad key are refused; an owner that does not answer does not hold it', async () => {
  const world = await setUp();
  const page = await openStream(`${world.pageBase}/api/attention/stream?tab=1`);
  await until(() => page.events.some(e => e.event === 'hello'));
  for (const key of ['local:99', `remote:${remoteId}:5`]) {
    const answer = await world.open({ key });
    assert.deepEqual([answer.status, answer.body.error], [404, 'NOT_FOUND'], key);
  }
  for (const key of [`remote:${offId}:4`, 'remote:999:4']) {
    const answer = await world.open({ key });
    assert.deepEqual([answer.status, answer.body.error], [404, 'ENGINE_NOT_FOUND'], key);
  }
  for (const body of [{}, { key: '' }, { key: 'local' }, { key: 'local:0' }, { key: 'phone:3' }, { key: 'remote:0:3' }, { key: 'local:3:4' }, { key: 3 }, [{ key: 'local:3' }]]) {
    const answer = await world.open(body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.equal(answer.body.error, 'VALIDATION_FAILED');
  }
  assert.deepEqual(told(page), [], 'nothing refused reaches the page');
  assert.equal((await world.open({ key: 'local:3' }, {})).status, 401, 'the token is needed');
  assert.equal((await world.open({ key: 'local:3' }, { ...AUTH, 'X-Forwarded-For': '203.0.113.9' })).status, 401, 'only from this machine');
  page.close();

  // An owner that is offline or slower than the read time: the page is told anyway (it finds out itself whether the task is there).
  const slow = await setUp({ remoteCall: () => new Promise(() => {}) });
  const other = await openStream(`${slow.pageBase}/api/attention/stream?tab=1`);
  await until(() => other.events.some(e => e.event === 'hello'));
  assert.deepEqual((await slow.open({ key: `remote:${remoteId}:4` })).body, { delivered: 1, focused: true });
  const down = await setUp({ remoteCall: () => { throw new RemoteAttentionError(502, { error: 'REMOTE_OFFLINE' }); } });
  assert.deepEqual((await down.open({ key: `remote:${remoteId}:4` })).body, { delivered: 0, focused: false });
  other.close();
});

test('the page channel sends open-item to the page seen last', () => {
  let clock = 0;
  const pages = createPageChannel({ now: () => clock });
  const events = [];
  assert.deepEqual(pages.openItem({ key: 'local:3' }), { delivered: 0, origin: null });
  const a = pages.add({ origin: 'http://127.0.0.1:3000', write: (event, data) => events.push(['a', event, data]) });
  pages.add({ origin: 'http://localhost:3000', write: (event, data) => events.push(['b', event, data]) });
  assert.deepEqual(pages.openItem({ key: 'remote:7:4' }), { delivered: 1, origin: 'http://localhost:3000' });
  clock = 5;
  pages.seen(a);
  assert.deepEqual(pages.openItem({ key: 'local:3' }), { delivered: 1, origin: 'http://127.0.0.1:3000' });
  assert.deepEqual(events, [['b', 'open-item', { key: 'remote:7:4' }], ['a', 'open-item', { key: 'local:3' }]]);
  const broken = pages.add({ write: () => { throw new Error('closed'); } });
  clock = 9;
  pages.seen(broken);
  assert.deepEqual(pages.openItem({ key: 'local:3' }), { delivered: 0, origin: null }, 'a failing write is not counted and the stream is dropped');
  assert.equal(pages.size(), 2);
});
