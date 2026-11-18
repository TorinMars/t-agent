// Open session without a new tab: the desktop window's POST /api/attention/widget/open-terminal (routes/attention-widget.js) tells one open T-Agent
// page of this machine to show a terminal, through that page's T-Attention stream (GET /api/attention/stream?tab=1, routes/attention.js, registered in
// services/page-channel.js), and asks the browser extension to bring that tab forward (a fake bridge here). Only top-level pages of this machine count:
// not a stream without tab=1, a forwarded (not this machine) one, a token's, or a column of the multi-column view. The page seen last gets it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-open-terminal-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
fs.mkdirSync(process.env.TASKS_BASE_DIR, { recursive: true });

const express = require('express');
const db = require('../db');
const { createPageChannel } = require('../services/page-channel');
const { createAttentionRoutes } = require('../routes/attention');
const { createAttentionWidgetRoutes } = require('../routes/attention-widget');
const { createWidgetSettings } = require('../services/attention-widget');
const { BridgeError, METHODS } = require('../services/browser-bridge');

const TOKEN = 'widget-token-0123456789-abcdefghijklmnopqrstuv';
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const servers = [];
const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); servers.push(server); });
const streamsOpen = [];
test.after(() => {
  for (const stream of streamsOpen) stream.close();
  for (const server of servers) { server.closeAllConnections?.(); server.close(); }
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
  const stream = { status: response.status, events: [], closed: false, close() { stream.closed = true; ctrl.abort(); } };
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
const opened = stream => stream.events.filter(e => e.event === 'open-terminal').map(e => e.data);

async function setUp({ bridge, bridgeWaitMs } = {}) {
  let clock = 1000;
  const pages = createPageChannel({ now: () => clock });
  const service = { onChange: () => () => {}, tokenActive: () => true };
  const attention = createAttentionRoutes({ service, pages, heartbeatMs: 60000 });
  const page = express();
  page.use(express.json());
  // A request with X-Test-Token stands for a token caller (the Bearer router sets req.attentionAuth so in server.js).
  page.use('/api/attention', (req, res, next) => { if (req.get('x-test-token')) req.attentionAuth = { kind: 'token', id: 1, name: 'cli', scopes: [] }; next(); }, attention.router);
  const pageBase = await listen(page);
  const launcher = { verifyToken: value => value === TOKEN, setEnabled: async () => {}, status: async () => ({}) };
  const widget = createAttentionWidgetRoutes({ service: {}, launcher, settings: createWidgetSettings({ db }), db, pages, ...(bridge ? { bridge } : {}), ...(bridgeWaitMs ? { bridgeWaitMs } : {}) });
  const app = express();
  app.use('/api/attention/widget', widget.bearer);
  const widgetBase = await listen(app);
  return {
    pages, pageBase, tick: () => { clock += 1000; },
    open: body => call('POST', `${widgetBase}/api/attention/widget/open-terminal`, body, AUTH),
    widgetBase,
  };
}
const TARGET = { engine: 'local', task_id: 12, terminal_id: 't3' };

test('only a top-level page of this machine counts, and the page seen last gets the terminal', async () => {
  const calls = [];
  const bridge = { command: async (method, params, options) => { calls.push([method, params, options]); return { focused: true, tab_id: 9 }; } };
  const world = await setUp({ bridge });
  const url = `${world.pageBase}/api/attention/stream`;
  const plain = await openStream(url);
  const forwarded = await openStream(`${url}?tab=1`, { 'X-Forwarded-For': '203.0.113.9' });
  const token = await openStream(`${url}?tab=1`, { 'X-Test-Token': '1' });
  const pane = await openStream(`${url}?tab=1`, { Referer: `${world.pageBase}/h5?pane=2` });
  const first = await openStream(`${url}?tab=1`, { Referer: `${world.pageBase}/` });
  await until(() => first.events.some(e => e.event === 'hello'));
  world.tick();
  const second = await openStream(`${url}?tab=1`);
  await until(() => second.events.some(e => e.event === 'hello'));
  for (const other of [plain, forwarded, token, pane]) assert.equal(other.status, 200);
  assert.equal(world.pages.size(), 2, 'only the two local top-level tab streams are pages');
  for (const other of [plain, forwarded, token, pane]) assert.equal(other.events.some(e => e.event === 'hello'), false);
  const firstId = first.events.find(e => e.event === 'hello').data.stream;
  assert.match(firstId, /^[A-Za-z0-9_-]{8,64}$/);

  // Nobody seen yet: the page that connected last.
  world.tick();
  let answer = await world.open(TARGET);
  assert.deepEqual(answer, { status: 200, body: { delivered: 1, focused: true } });
  await until(() => opened(second).length === 1);
  assert.deepEqual(opened(second), [{ engine: 'local', task_id: '12', terminal_id: 't3' }]);
  assert.deepEqual(calls, [['tabs.reveal', { origin: world.pageBase }, { timeoutMs: 1000 }]], 'the extension is asked for the page origin');

  // The first page is seen (shown or focused) now: it gets the next one, and only it.
  world.tick();
  assert.deepEqual((await call('POST', `${url}/seen`, { stream: firstId })).body, { ok: true });
  answer = await world.open({ engine: 'remote:7', task_id: '3', terminal_id: 'a_b-1' });
  assert.deepEqual(answer.body, { delivered: 1, focused: true });
  await until(() => opened(first).length === 1);
  assert.deepEqual(opened(first), [{ engine: 'remote:7', task_id: '3', terminal_id: 'a_b-1' }]);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(opened(second).length, 1, 'the other page is not told');
  for (const other of [plain, forwarded, token, pane]) assert.deepEqual(opened(other), []);

  // seen: a token is refused; an unknown id is no page.
  assert.equal((await call('POST', `${url}/seen`, { stream: firstId }, { 'X-Test-Token': '1' })).status, 403);
  assert.deepEqual((await call('POST', `${url}/seen`, { stream: 'nope' })).body, { ok: false });
  assert.deepEqual((await call('POST', `${url}/seen`, {})).body, { ok: false });

  // A closed page leaves; with none left nothing is delivered and the extension is not asked.
  first.close();
  second.close();
  await until(() => world.pages.size() === 0);
  calls.length = 0;
  assert.deepEqual((await world.open(TARGET)).body, { delivered: 0, focused: false });
  assert.deepEqual(calls, []);
  for (const other of [plain, forwarded, token, pane]) other.close();
});

test('the tab comes forward only when the extension says so; an older or missing extension is focused false', async () => {
  for (const [name, bridge, waitMs] of [
    ['older extension', { command: async () => { throw new BridgeError('UNKNOWN_METHOD', 'The connected extension (version 1.0.2) does not support tabs.reveal; update it', 400); } }],
    ['no browser', { command: async () => { throw new BridgeError('BROWSER_NOT_CONNECTED', 'No browser', 503); } }],
    ['no tab found', { command: async () => ({ focused: false }) }],
    ['a throw', { command: () => { throw new Error('boom'); } }],
    ['too slow', { command: () => new Promise(() => {}) }, 60],
  ]) {
    const world = await setUp({ bridge, bridgeWaitMs: waitMs });
    const page = await openStream(`${world.pageBase}/api/attention/stream?tab=1`);
    await until(() => page.events.some(e => e.event === 'hello'));
    const started = Date.now();
    assert.deepEqual((await world.open(TARGET)).body, { delivered: 1, focused: false }, name);
    if (waitMs) assert.ok(Date.now() - started < 1000, 'a slow extension does not hold the answer');
    await until(() => opened(page).length === 1);
    page.close();
  }
  assert.ok(METHODS.includes('tabs.reveal'), 'the bridge may send tabs.reveal');
});

// The T-Agent macOS app shows the page in a WKWebView on the loopback URL of app.json. Its EventSource sends what Safari sends: a
// Safari-like User-Agent without "Safari", maybe no Referer (or the page's own, without `pane`), an Accept of text/event-stream, and no
// Origin or Sec-Fetch headers on a same-origin GET. The page channel keys only on the session, tab=1, the loopback socket without
// forwarding headers, and a Referer without `pane`, so such a page counts like a browser tab and gets the open-terminal event.
test('a page inside the T-Agent app (WKWebView on the loopback URL) counts as a local top-level page', async () => {
  const world = await setUp({ bridge: { command: async () => ({ focused: false }) } });
  const webKit = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
  const port = new URL(world.pageBase).port;
  const pages = [
    await openStream(`${world.pageBase}/api/attention/stream?tab=1`, { 'User-Agent': webKit }),
    await openStream(`${world.pageBase}/api/attention/stream?tab=1`, { 'User-Agent': webKit, Referer: `${world.pageBase}/?openTerminal=local:12:t3` }),
    await openStream(`${world.pageBase}/api/attention/stream?tab=1`, { 'User-Agent': webKit, Host: `localhost:${port}`, Referer: `http://localhost:${port}/h5` }),
  ];
  for (const page of pages) await until(() => page.events.some(e => e.event === 'hello'));
  assert.equal(world.pages.size(), 3);
  world.tick();
  assert.deepEqual((await world.open(TARGET)).body, { delivered: 1, focused: false });
  await until(() => opened(pages[2]).length === 1);
  assert.deepEqual(opened(pages[2]), [{ engine: 'local', task_id: '12', terminal_id: 't3' }]);
  for (const page of pages) page.close();
});

test('bad input is refused, the token is needed, and an unknown path answers 404 JSON (what an older server answers here)', async () => {
  const world = await setUp({ bridge: { command: async () => ({ focused: true }) } });
  for (const body of [
    {}, { ...TARGET, engine: 'remote:0' }, { ...TARGET, engine: 'phone' }, { ...TARGET, task_id: 0 }, { ...TARGET, task_id: '1.5' }, { ...TARGET, task_id: -3 },
    { ...TARGET, terminal_id: '' }, { ...TARGET, terminal_id: 'a b' }, { ...TARGET, terminal_id: 'x'.repeat(65) }, [TARGET],
  ]) {
    const answer = await world.open(body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.equal(answer.body.error, 'VALIDATION_FAILED');
  }
  assert.equal((await call('POST', `${world.widgetBase}/api/attention/widget/open-terminal`, TARGET)).status, 401);
  assert.equal((await call('POST', `${world.widgetBase}/api/attention/widget/open-terminal`, TARGET, { ...AUTH, 'X-Forwarded-For': '203.0.113.9' })).status, 401);
  const unknown = await call('POST', `${world.widgetBase}/api/attention/widget/open-somewhere`, TARGET, AUTH);
  assert.deepEqual([unknown.status, unknown.body.error], [404, 'NOT_FOUND']);
});

test('the page channel picks one page: seen last, else connected last', () => {
  let clock = 0;
  const pages = createPageChannel({ now: () => clock });
  const told = [];
  assert.deepEqual(pages.openTerminal(TARGET), { delivered: 0, origin: null });
  const a = pages.add({ origin: 'http://127.0.0.1:3000', write: (event, data) => told.push(['a', event, data]) });
  const b = pages.add({ origin: 'http://localhost:3000', write: (event, data) => told.push(['b', event, data]) });
  assert.notEqual(a, b);
  assert.deepEqual(pages.openTerminal(TARGET), { delivered: 1, origin: 'http://localhost:3000' }, 'same time, never seen: the later one');
  clock = 5;
  assert.equal(pages.seen(a), true);
  assert.equal(pages.seen('missing'), false);
  assert.deepEqual(pages.openTerminal(TARGET), { delivered: 1, origin: 'http://127.0.0.1:3000' });
  assert.deepEqual(told.map(entry => entry[0]), ['b', 'a']);
  assert.deepEqual(told[1].slice(1), ['open-terminal', { engine: 'local', task_id: '12', terminal_id: 't3' }]);
  const broken = pages.add({ write: () => { throw new Error('closed'); } });
  clock = 9;
  pages.seen(broken);
  assert.deepEqual(pages.openTerminal(TARGET), { delivered: 0, origin: null }, 'a failing write is not counted and the stream is dropped');
  assert.equal(pages.size(), 2);
  assert.equal(pages.remove(a), true);
  assert.equal(pages.size(), 1);
});
