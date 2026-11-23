// The care of T-Agent's browser tabs ("Closing T-Agent's tabs" in docs/design/browser-extension.md): services/browser-tab-care.js with a fake
// clock, then through the bridge (services/browser-bridge.js) with a fake extension: tabs per terminal, the close 2 minutes after a turn ended,
// a new command cancelling it, a closed terminal, 30 minutes idle, keep and the person's tabs never closed, closes due while offline sent on
// reconnect, tabs adopted from the hello, an old extension left alone, and the reload request for an older unpacked extension only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTabCare, TURN_END_IDLE_MS, IDLE_MS } = require('../services/browser-tab-care');
const { bridgeServer, fakeExtension, openSocket, waitFor, FEATURES } = require('./helpers/fake-browser-ext');
const { newerVersion, folderVersion } = require('../services/browser-bridge');

const MIN = 60_000;
function fakeClock(start = 1_000_000) {
  let time = start;
  const timers = new Set();
  return {
    now: () => time,
    setTimer(fn, ms) { const timer = { at: time + ms, fn }; timers.add(timer); return timer; },
    clearTimer(timer) { timers.delete(timer); },
    advance(ms) {
      const end = time + ms;
      for (;;) {
        const next = [...timers].filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        time = next.at;
        timers.delete(next);
        next.fn();
      }
      time = end;
    },
    count: () => timers.size,
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const A = { task_id: 7, terminal_id: 'default' };
const B = { task_id: 7, terminal_id: 't2' };

function careWith({ fail = null } = {}) {
  const clock = fakeClock();
  const closed = [];
  const care = createTabCare({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    close: async (browserId, tabId) => {
      if (fail && fail(browserId, tabId)) throw Object.assign(new Error('offline'), { code: 'BROWSER_NOT_CONNECTED' });
      closed.push(`${browserId}:${tabId}`);
    },
  });
  return { clock, closed, care };
}

test('a turn end closes the terminal\'s tabs once they had no command for 2 minutes; a new command cancels it', async () => {
  const { clock, closed, care } = careWith();
  care.noteTab('br', 1, { context: A });
  care.noteTab('br', 2, { context: B });
  clock.advance(30_000);
  care.turnEnded(A);
  clock.advance(TURN_END_IDLE_MS - 30_000 - 1);
  await flush();
  assert.deepEqual(closed, [], 'not before 2 minutes after the last command');
  clock.advance(1);
  await flush();
  assert.deepEqual(closed, ['br:1'], 'only the tabs of that terminal');

  // A tab idle for longer than 2 minutes closes at the turn end itself.
  care.noteTab('br', 3, { context: A });
  clock.advance(3 * MIN);
  care.turnEnded(A);
  await flush();
  assert.deepEqual(closed, ['br:1', 'br:3']);

  // A new command on the tab after the turn end cancels the close until the next turn end.
  care.noteTab('br', 4, { context: A });
  care.turnEnded(A);
  clock.advance(MIN);
  care.noteTab('br', 4, { context: A });
  clock.advance(5 * MIN);
  await flush();
  assert.ok(!closed.includes('br:4'), 'cancelled');
  care.turnEnded(A);
  clock.advance(TURN_END_IDLE_MS);
  await flush();
  assert.ok(closed.includes('br:4'));
  // The tab used by another terminal last belongs to that one.
  care.noteTab('br', 5, { context: A });
  care.noteTab('br', 5, { context: B });
  care.turnEnded(A);
  clock.advance(TURN_END_IDLE_MS);
  await flush();
  assert.ok(!closed.includes('br:5'));
});

test('a closed terminal closes its tabs at once; any tab closes after 30 minutes without a command', async () => {
  const { clock, closed, care } = careWith();
  care.noteTab('br', 1, { context: A });
  care.noteTab('br', 2, { context: A });
  care.noteTab('br', 3, { context: B });
  care.terminalEnded(A);
  await flush();
  assert.deepEqual(closed.sort(), ['br:1', 'br:2']);
  clock.advance(IDLE_MS - 1);
  await flush();
  assert.ok(!closed.includes('br:3'));
  clock.advance(1);
  await flush();
  assert.ok(closed.includes('br:3'), '30 minutes idle');
  care.noteTab('br', 4); // no terminal (a command without one, or adopted)
  clock.advance(IDLE_MS);
  await flush();
  assert.ok(closed.includes('br:4'));
  assert.equal(clock.count(), 0, 'no timer left');
});

test('keep, handed tabs and tabs the person used are never closed', async () => {
  const { clock, closed, care } = careWith();
  care.noteTab('br', 1, { context: A, keep: true });
  care.noteTab('br', 2, { context: A, how: 'handed' });
  care.noteTab('br', 3, { context: A });
  care.forget('br', 3); // tab.used: the person's now
  care.noteTab('br', 4, { context: A });
  care.keep('br', 4); // tab.used with kept (a recorded tab the person used)
  care.turnEnded(A);
  care.terminalEnded(A);
  clock.advance(2 * IDLE_MS);
  await flush();
  assert.deepEqual(closed, []);
  assert.equal(care.snapshot().tabs.filter(tab => tab.keep).length, 2);
  assert.ok(!care.snapshot().tabs.some(tab => tab.tab_id === 2 || tab.tab_id === 3));
});

test('a close due while the browser is offline waits and is sent when it connects; owned tabs of the hello are adopted', async () => {
  let offline = true;
  const { clock, closed, care } = careWith({ fail: () => offline });
  care.noteTab('br', 1, { context: A });
  care.noteTab('br', 2, { context: A });
  care.noteTab('br', 9, { context: A });
  care.terminalEnded(A);
  await flush();
  assert.deepEqual(closed, []);
  assert.deepEqual(care.snapshot().pending.br.sort(), [1, 2, 9]);
  offline = false;
  // The extension still owns 1 and 2 (9 is gone), and 5 that this server did not know (it restarted), kept 6.
  care.connected('br', [{ tab_id: 1 }, { tab_id: 2 }, { tab_id: 5 }, { tab_id: 6, keep: true }]);
  await flush();
  assert.deepEqual(closed.sort(), ['br:1', 'br:2']);
  assert.deepEqual(care.snapshot().tabs.map(tab => [tab.tab_id, tab.keep]).sort(), [[5, false], [6, true]]);
  clock.advance(IDLE_MS);
  await flush();
  assert.ok(closed.includes('br:5') && !closed.includes('br:6'), 'an adopted tab closes after 30 minutes idle');
  // An old extension's hello has no owned_tabs: the pending closes are still sent.
  offline = true;
  care.noteTab('br2', 3, { context: B });
  care.terminalEnded(B);
  await flush();
  offline = false;
  care.connected('br2', null);
  await flush();
  assert.ok(closed.includes('br2:3'));
});

test('through the bridge: tabs per terminal, turn end and terminal end close them with auto, keep and the person\'s tabs stay, pending closes on reconnect', async () => {
  const clock = fakeClock();
  const { bridge, wsUrl, close } = await bridgeServer({ bridgeOptions: { tabCareOptions: { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer } } });
  try {
    const { token, browser_id: browserId } = bridge.pair({ code: bridge.createPairCode().code, name: 'Chrome' });
    let next = 40;
    const handler = (method, params) => {
      if (method === 'tabs.open') return { tab: { tab_id: next++, url: params.url, how: 'group', ...(params.keep ? { keep: true } : {}) } };
      if (method === 'tabs.close') return {};
      return { ok: true };
    };
    let ext = await fakeExtension(wsUrl, token, { handler, features: [...FEATURES, 'close.auto'], version: '1.0.5' });
    const a = await bridge.command('tabs.open', { url: 'https://a.test/' }, { context: A });
    const b = await bridge.command('tabs.open', { url: 'https://b.test/', keep: true }, { context: A });
    const c = await bridge.command('tabs.open', { url: 'https://c.test/' }, { context: B });
    const d = await bridge.command('tabs.open', { url: 'https://d.test/' }, { context: A });
    assert.deepEqual(bridge.tabCare().tabs.map(tab => [tab.tab_id, tab.terminal, tab.keep]), [[a.tab.tab_id, '7:default', false], [b.tab.tab_id, '7:default', true], [c.tab.tab_id, '7:t2', false], [d.tab.tab_id, '7:default', false]]);
    ext.event('tab.used', { tab_id: d.tab.tab_id, how: 'activated' });
    await waitFor(() => bridge.tabCare().tabs.length === 3);

    bridge.turnEnded(A);
    clock.advance(TURN_END_IDLE_MS);
    await waitFor(() => ext.commands.some(cmd => cmd.method === 'tabs.close'));
    const closes = () => ext.commands.filter(cmd => cmd.method === 'tabs.close').map(cmd => cmd.params);
    assert.deepEqual(closes(), [{ tab_id: a.tab.tab_id, auto: true }], 'only the idle tab of that terminal; never the kept one or the person\'s');
    await waitFor(() => !bridge.tabCare().tabs.some(tab => tab.tab_id === a.tab.tab_id));

    // Offline when terminal t2 closes: the close waits for the reconnect.
    ext.close();
    await waitFor(() => !bridge.connected());
    bridge.terminalEnded(B);
    await waitFor(() => (bridge.tabCare().pending[browserId] || []).length === 1);
    ext = await fakeExtension(wsUrl, token, { handler, features: [...FEATURES, 'close.auto'], version: '1.0.5' });
    await waitFor(() => ext.commands.some(cmd => cmd.method === 'tabs.close'));
    assert.deepEqual(ext.commands.filter(cmd => cmd.method === 'tabs.close').map(cmd => cmd.params), [{ tab_id: c.tab.tab_id, auto: true }]);
    assert.deepEqual(bridge.tabCare().pending, {});
    ext.close();
    await waitFor(() => !bridge.connected());

    // An extension before 1.0.5 (no close.auto): nothing is tracked or closed.
    const old = await fakeExtension(wsUrl, token, { handler, features: FEATURES, version: '1.0.4' });
    const before = bridge.tabCare().tabs.length;
    await bridge.command('tabs.open', { url: 'https://e.test/' }, { context: A });
    assert.equal(bridge.tabCare().tabs.length, before);
    old.close();
  } finally { await close(); }
});

test('the result envelope\'s tab ties every command to its terminal; tabs.close and TAB_NOT_FOUND forget the tab', async () => {
  const clock = fakeClock();
  const { bridge, wsUrl, close } = await bridgeServer({ bridgeOptions: { tabCareOptions: { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer } } });
  try {
    const { token } = bridge.pair({ code: bridge.createPairCode().code, name: 'Chrome' });
    const ext = await fakeExtension(wsUrl, token, { features: [...FEATURES, 'close.auto'], version: '1.0.5' });
    // A hand-written answer with the envelope, as background.js sends it.
    ext.ws.removeAllListeners('message');
    ext.ws.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'cmd') return;
      ext.commands.push(message);
      const tab = { tab_id: message.params.tab_id ?? 70, how: message.params.tab_id === 71 ? 'handed' : 'group' };
      if (message.params.tab_id === 72) return ext.send({ type: 'result', id: message.id, ok: false, error: { code: 'TAB_NOT_FOUND', message: 'gone' }, tab });
      return ext.send({ type: 'result', id: message.id, ok: true, result: {}, tab });
    });
    await bridge.command('page.snapshot', {}, { context: A });
    await bridge.command('page.snapshot', { tab_id: 71 }, { context: A });
    await bridge.command('input.click', { tab_id: 72 }, { context: B }).catch(() => {});
    assert.deepEqual(bridge.tabCare().tabs.map(tab => [tab.tab_id, tab.terminal]), [[70, '7:default']], 'the handed tab and the gone tab are not cared for');
    await bridge.command('tabs.close', { tab_id: 70 }, { context: A });
    assert.deepEqual(bridge.tabCare().tabs, []);
    ext.close();
  } finally { await close(); }
});

test('reload request: only for an unpacked extension older than the folder, at most once per version in 10 minutes, at most 3 times', async () => {
  let clock = 5_000_000;
  let latest = '1.0.5';
  const { bridge, wsUrl, close } = await bridgeServer({ bridgeOptions: { now: () => clock, extensionVersion: () => latest } });
  try {
    const { token } = bridge.pair({ code: bridge.createPairCode().code, name: 'Chrome' });
    const hello = async (version, installType) => {
      const socket = await openSocket(wsUrl);
      socket.ws.send(JSON.stringify({ type: 'hello', token, version, protocol: 1, browser: { name: 'Chrome' }, methods: [], features: FEATURES, ...(installType ? { install_type: installType } : {}) }));
      await waitFor(() => socket.messages.length >= 1);
      await new Promise(resolve => setTimeout(resolve, 30));
      socket.ws.close();
      await socket.closed;
      return socket.messages.filter(message => message.type === 'reload');
    };
    assert.deepEqual(await hello('1.0.2', 'development'), [{ type: 'reload', version: '1.0.5' }]);
    assert.deepEqual(await hello('1.0.2', 'development'), [], 'not again within 10 minutes');
    clock += 10 * MIN;
    assert.equal((await hello('1.0.2', 'development')).length, 1, 'again after 10 minutes');
    clock += 10 * MIN;
    assert.equal((await hello('1.0.2', 'development')).length, 1);
    clock += 10 * MIN;
    assert.deepEqual(await hello('1.0.2', 'development'), [], 'after 3 tries for the same version the folder is not this one: no more');
    assert.deepEqual(await hello('1.0.5', 'development'), [], 'up to date');
    assert.deepEqual(await hello('1.0.6', 'development'), [], 'newer than the folder');
    assert.deepEqual(await hello('1.0.3', 'normal'), [], 'installed from a store: never');
    assert.deepEqual(await hello('1.0.3'), [], 'an extension that does not say how it was installed (before 1.0.5)');
    latest = '1.0.7';
    assert.equal((await hello('1.0.2', 'development')).length, 1, 'a newer folder version is asked again');
    assert.equal(bridge.status().extension_version, '1.0.7');
  } finally { await close(); }
  assert.equal(newerVersion('1.0.10', '1.0.9'), true);
  assert.equal(newerVersion('1.0.5', '1.0.5'), false);
  assert.equal(newerVersion('x', '1.0.0'), false);
  assert.equal(folderVersion(), require('../extensions/chrome/manifest.json').version);
});
