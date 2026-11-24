// Page time ("Page time" in docs/design/usage-time-page.md): the rules of scripts/h5-shell/usage-beats.mjs (the idle cutoff, 15-second steps, the
// surface and the engine-neutral ids from the store, batching, the owner tab) and the beat sender usage-time.mjs with a fake clock, document and
// window (visible only, the switch, batches of at most 40, the beacon on hide, a pane only tells its top page, an embed does nothing). The real page
// is scripts/test-h5-usage-time-browser.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = file => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'h5-shell', file)).href);
const SOURCES = [{ key: 'local', instanceId: 'inst-a' }, { key: 'remote:7', instanceId: 'inst-k' }, { key: 'remote:9', instanceId: null }];

test('the clock runs only while visible and with activity in the last 2 minutes', async () => {
  const { isActive, IDLE_MS } = await load('usage-beats.mjs');
  assert.equal(IDLE_MS, 120000);
  assert.equal(isActive(1000, 0, true), false, 'no activity yet');
  assert.equal(isActive(200000, 100000, true), true);
  assert.equal(isActive(220000, 100000, true), true, 'exactly 2 minutes');
  assert.equal(isActive(220001, 100000, true), false, 'idle');
  assert.equal(isActive(150000, 100000, false), false, 'hidden');
});

test('surfaces come from the store; a session beat names its kind and engine-neutral ids', async () => {
  const { surfaceOf, beatOf, neutralIds, STEP_S } = await load('usage-beats.mjs');
  const { refOfNeutral } = await load('usage-time-model.mjs');
  const shown = { sourceKey: 'remote:7', taskId: 12, terminalId: 'c1' };
  assert.equal(surfaceOf({}), 'other');
  assert.equal(surfaceOf({ shownTarget: shown }), 'sessions');
  assert.equal(surfaceOf({ shownTarget: shown, settingsOpen: true }), 'settings');
  assert.equal(surfaceOf({ learnOpen: true }), 'learn');
  assert.equal(surfaceOf({ attention: { open: true } }), 'attention');
  assert.equal(surfaceOf({ mindmapOpen: true }), 'mindmaps');
  assert.equal(surfaceOf({ columns: { shown: true, tab: 'maps' } }), 'mindmaps');
  assert.equal(surfaceOf({ columns: { shown: true, tab: 'columns' } }), 'sessions');
  assert.deepEqual(neutralIds(shown, SOURCES), { task: 'inst-k:12', session: 'inst-k:12:c1' });
  assert.deepEqual(neutralIds({ sourceKey: 'remote:9', taskId: 1, terminalId: 'x' }, SOURCES), { task: null, session: null }, 'no instance id: no ids');
  assert.deepEqual(refOfNeutral('inst-k:12:c1', SOURCES), { sourceKey: 'remote:7', taskId: '12', terminalId: 'c1' });
  assert.deepEqual(refOfNeutral('inst-a:3', SOURCES), { sourceKey: 'local', taskId: '3', terminalId: null });
  assert.equal(refOfNeutral('gone:3', SOURCES), null);
  assert.deepEqual(beatOf({ shownTarget: shown, terminalAgent: 'claude', sources: SOURCES }, 5), { at: 5, surface: 'sessions', kind: 'claude', task: 'inst-k:12', session: 'inst-k:12:c1', seconds: STEP_S });
  assert.equal(beatOf({ shownTarget: shown, terminalAgent: null, sources: SOURCES }, 5).kind, 'terminal');
  assert.equal(beatOf({ shownTarget: shown, notebook: { path: 'a.tnb' }, sources: SOURCES }, 5).kind, 'notebook');
  assert.deepEqual(beatOf({ shownTarget: shown, settingsOpen: true, sources: SOURCES }, 5), { at: 5, surface: 'settings', kind: null, task: null, session: null, seconds: 15 });
  // The multi-column view: the focused column's session.
  const columns = { shown: true, tab: 'columns', focus: 'p2', titles: { p1: { target: { sourceKey: 'local', taskId: 1, terminalId: 'a' } }, p2: { target: { sourceKey: 'local', taskId: 2, terminalId: 'b' }, agent: 'codex' } } };
  assert.deepEqual(beatOf({ columns, sources: SOURCES }, 9), { at: 9, surface: 'sessions', kind: 'codex', task: 'inst-a:2', session: 'inst-a:2:b', seconds: 15 });
});

test('the first screen and the sender agree on what counts as activity', async () => {
  const beats = await load('usage-beats.mjs');
  const first = await load('usage-time.mjs');
  assert.deepEqual(first.ACTIVITY, beats.ACTIVITY);
  assert.equal(first.MESSAGE, beats.MESSAGE);
});

test('batches hold at most 40 beats and go when full or 2 minutes after the first', async () => {
  const { takeBatch, flushDue, BATCH_MAX, FLUSH_MS } = await load('usage-beats.mjs');
  assert.equal(BATCH_MAX, 40);
  const queue = Array.from({ length: 95 }, (_, i) => ({ at: i }));
  const [batch, rest] = takeBatch(queue);
  assert.equal(batch.length, 40);
  assert.equal(rest.length, 55);
  assert.equal(batch[0].at, 0, 'oldest first');
  assert.equal(flushDue([], 1e9), false);
  assert.equal(flushDue([{ at: 1000 }], 1000 + FLUSH_MS - 1), false);
  assert.equal(flushDue([{ at: 1000 }], 1000 + FLUSH_MS), true);
  assert.equal(flushDue(queue.slice(0, 40), 50), true, 'full');
});

test('of several tabs only the one with the newest activity counts', async () => {
  const { isOwner, clientOf } = await load('usage-beats.mjs');
  assert.equal(isOwner({ id: 'b', last: 10 }, {}), true);
  assert.equal(isOwner({ id: 'b', last: 10 }, { a: 9 }), true);
  assert.equal(isOwner({ id: 'b', last: 10 }, { a: 11 }), false);
  assert.equal(isOwner({ id: 'b', last: 10 }, { a: 10 }), false, 'a tie goes to the smaller id');
  assert.equal(isOwner({ id: 'a', last: 10 }, { b: 10 }), true);
  assert.equal(clientOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'phone');
  assert.equal(clientOf('Mozilla/5.0 (Macintosh) T-AgentApp/1.2'), 'mac-app');
  assert.equal(clientOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'computer');
});

// A fake page: a document that dispatches events, a window with a clock the test moves.
function fakePage({ framed = false, pane = null, recording = true } = {}) {
  let clock = 1_000_000;
  const listeners = {};
  const on = (map, type, fn) => { (map[type] = map[type] || []).push(fn); };
  const fire = (map, type, event = {}) => { for (const fn of map[type] || []) fn(event); };
  const doc = { visibilityState: 'visible', addEventListener: (type, fn) => on(listeners, type, fn) };
  const winListeners = {};
  const intervals = [];
  const timeouts = [];
  const posts = [];
  const beacons = [];
  const parentPosts = [];
  const win = {
    location: { origin: 'http://h5.test' },
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh)', sendBeacon: (url, blob) => { beacons.push({ url, blob }); return true; } },
    addEventListener: (type, fn) => on(winListeners, type, fn),
    setInterval: fn => intervals.push(fn),
    setTimeout: fn => timeouts.push(fn),
    fetch: async (url, options = {}) => {
      if (url.endsWith('/settings')) return { ok: true, status: 200, json: async () => ({ usage_time_record: recording, usage_memories_digest: false }) };
      posts.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
    parent: { postMessage: (data, origin) => parentPosts.push({ data, origin }) },
  };
  win.top = framed ? {} : win;
  let state = { pane, usageTimeRecording: null, shownTarget: { sourceKey: 'local', taskId: 4, terminalId: 'c1' }, terminalAgent: 'claude', sources: SOURCES };
  const subs = new Set();
  const ui = { get: () => state, set: patch => { state = { ...state, ...patch }; for (const fn of subs) fn(); }, subscribe: fn => { subs.add(fn); return () => subs.delete(fn); } };
  const step = (ms = 15000) => { clock += ms; for (const fn of intervals) fn(); };
  return {
    doc, win, ui, posts, beacons, parentPosts, intervals, timeouts, step, now: () => clock,
    act: (type = 'pointerdown') => fire(listeners, type),
    hide: () => { doc.visibilityState = 'hidden'; fire(listeners, 'visibilitychange'); },
    show: () => { doc.visibilityState = 'visible'; fire(listeners, 'visibilitychange'); },
    pagehide: () => fire(winListeners, 'pagehide'),
    readSwitch: async () => { for (const fn of timeouts) fn(); await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)); },
    advance: ms => { clock += ms; },
  };
}
const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0));
// The loader of the first screen with the sender chunk loaded from the source; resolves to the sender once the switch said on.
async function begin(page) {
  const { startUsageTime } = await load('usage-time.mjs');
  const loader = startUsageTime(page.ui, { doc: page.doc, win: page.win, now: page.now, load: () => load('usage-time-sender.mjs') });
  return loader;
}

test('the sender beats every 15 s while active and visible, stops after 2 idle minutes, never while hidden, and batches', async () => {
  const page = fakePage();
  const loader = await begin(page);
  assert.equal(page.intervals.length, 0, 'no clock before the switch says on: the sender chunk is not loaded');
  page.act();
  await page.readSwitch();
  assert.equal(page.ui.get().usageTimeRecording, true);
  const sender = await loader.start();
  assert.equal(page.intervals.length, 1);
  page.act();
  for (let i = 0; i < 4; i += 1) page.step();
  assert.equal(sender.queued(), 4, 'one beat per 15 s step');
  // Idle: 2 minutes after the last activity the clock stops (the steps at 75, 90, 105 and 120 s still count).
  for (let i = 0; i < 4; i += 1) page.step();
  assert.equal(sender.queued(), 8);
  assert.equal(page.posts.length, 0, 'no request per beat');
  page.step(); // 135 s: idle, and the first beat is 2 minutes old
  await flushPromises();
  assert.equal(page.posts.length, 1, 'a batch 2 minutes after its first beat');
  assert.equal(page.posts[0].url, '/api/usage-time/beats');
  assert.equal(page.posts[0].body.client, 'computer');
  assert.equal(page.posts[0].body.beats.length, 8);
  assert.deepEqual(Object.keys(page.posts[0].body.beats[0]).sort(), ['at', 'kind', 'seconds', 'session', 'surface', 'task']);
  assert.deepEqual(page.posts[0].body.beats[0], { at: page.posts[0].body.beats[0].at, surface: 'sessions', kind: 'claude', task: 'inst-a:4', session: 'inst-a:4:c1', seconds: 15 });
  assert.equal(sender.queued(), 0, 'idle: no beat');
  // The first beat after the gap counts 15 s.
  page.act();
  page.step();
  assert.equal(sender.queued(), 1);
  // Hidden: what is queued goes with a beacon, and no beat while hidden even with activity.
  page.hide();
  assert.equal(page.beacons.length, 1);
  assert.equal(page.beacons[0].url, '/api/usage-time/beats');
  assert.equal(JSON.parse(await page.beacons[0].blob.text()).beats.length, 1);
  page.act();
  page.step();
  assert.equal(sender.queued(), 0, 'never a beat from a hidden tab');
  page.show();
  page.step();
  assert.equal(sender.queued(), 1, 'shown again counts as activity');
  // The switch off: the queue is dropped and nothing is sent.
  page.ui.set({ usageTimeRecording: false });
  assert.equal(sender.queued(), 0);
  page.act();
  page.step();
  page.pagehide();
  assert.equal(sender.queued(), 0);
  assert.equal(page.beacons.length, 1);
});

test('a long stretch is sent in requests of at most 40 beats', async () => {
  const page = fakePage();
  const loader = await begin(page);
  await page.readSwitch();
  const sender = await loader.start();
  // A hidden page never flushes by itself, so fill the queue past 40 with the requests failing to leave: count what reaches fetch.
  for (let i = 0; i < 45; i += 1) { page.act(); page.step(); }
  await flushPromises();
  const sizes = page.posts.map(post => post.body.beats.length);
  assert.ok(sizes.every(size => size <= 40), `batches: ${sizes}`);
  assert.equal(sizes.reduce((a, b) => a + b, 0) + sender.queued(), 45);
});

test('a refused batch turns the switch off; off loads nothing; a pane only tells its top page; an embed does nothing', async () => {
  const page = fakePage();
  page.win.fetch = async url => (url.endsWith('/settings')
    ? { ok: true, status: 200, json: async () => ({ usage_time_record: true }) }
    : { ok: false, status: 403, json: async () => ({ ok: false }) });
  const loader = await begin(page);
  await page.readSwitch();
  await loader.start();
  for (let i = 0; i < 9; i += 1) { page.act(); page.step(); }
  await flushPromises();
  await flushPromises();
  assert.equal(page.ui.get().usageTimeRecording, false);

  const { startUsageTime } = await load('usage-time.mjs');
  const off = fakePage({ recording: false });
  const idle = startUsageTime(off.ui, { doc: off.doc, win: off.win, now: off.now, load: () => { throw new Error('loaded while off'); } });
  await off.readSwitch();
  assert.equal(off.ui.get().usageTimeRecording, false);
  assert.equal(off.intervals.length, 0, 'switch off: the sender is never loaded');
  assert.equal(idle.pane, false);

  const pane = fakePage({ framed: true, pane: 'p1' });
  const sent = startUsageTime(pane.ui, { doc: pane.doc, win: pane.win, now: pane.now });
  assert.deepEqual(sent, { pane: true });
  assert.equal(pane.intervals.length, 0, 'no clock in a pane');
  pane.act('keydown');
  pane.act('keydown');
  assert.equal(pane.parentPosts.length, 1, 'at most every 5 s');
  assert.deepEqual(pane.parentPosts[0], { data: { type: 't-agent-activity' }, origin: 'http://h5.test' });
  pane.advance(6000);
  pane.act('wheel');
  assert.equal(pane.parentPosts.length, 2);

  const embed = fakePage({ framed: true });
  assert.equal(startUsageTime(embed.ui, { doc: embed.doc, win: embed.win, now: embed.now }), null);
  assert.equal(embed.intervals.length + embed.timeouts.length, 0);
});
