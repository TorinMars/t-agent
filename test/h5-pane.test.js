// Pane mode of the page (scripts/h5-shell/pane.mjs): which windows are panes, the per-pane storage keys and how they are forgotten, and the messages to
// the parent, with fake windows. The real page in a real iframe is scripts/test-h5-pane-browser.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'h5-shell', 'pane.mjs')).href);

function fakeStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    get length() { return map.size; },
    key: i => [...map.keys()][i] ?? null,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    keys: () => [...map.keys()].sort(),
  };
}

function fakeWindow({ search = '', framed = true, origin = 'http://h5.test' } = {}) {
  const listeners = {};
  const posted = [];
  const parent = { postMessage: (message, target) => posted.push({ message, target }) };
  const win = {
    location: { search, origin },
    localStorage: fakeStorage(),
    sessionStorage: fakeStorage(),
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    setTimeout: fn => fn(),
    fire: (type, event = {}) => (listeners[type] || []).forEach(fn => fn(event)),
    posted,
  };
  win.parent = framed ? parent : win;
  win.top = framed ? parent : win;
  return win;
}
const fakeDoc = () => {
  const listeners = {};
  return { readyState: 'loading', addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); }, fire: type => (listeners[type] || []).forEach(fn => fn({})) };
};
const fakeUi = state => {
  const subs = new Set();
  return { actions: {}, get: () => state, set(patch) { state = { ...state, ...patch }; subs.forEach(fn => fn()); }, subscribe: fn => { subs.add(fn); return () => subs.delete(fn); } };
};

test('a pane needs a valid id and a frame', async () => {
  const { detectPane } = await load();
  assert.equal(detectPane(fakeWindow({ search: '?pane=a1' })), 'a1');
  assert.equal(detectPane(fakeWindow({ search: '?pane=abcdefghijklmnop' })), 'abcdefghijklmnop');
  assert.equal(detectPane(fakeWindow({ search: '?pane=a1', framed: false })), null, 'a top-level ?pane= is the normal page');
  for (const bad of ['', '?pane=', '?pane=A1', '?pane=a-1', '?pane=a:1', '?pane=abcdefghijklmnopq', '?pane=%E4%B8%AD', '?other=1']) {
    assert.equal(detectPane(fakeWindow({ search: bad })), null, `invalid: ${bad}`);
  }
});

test('forgetting a pane removes only its own keys, in both storages', async () => {
  const { forgetPaneKeys } = await load();
  const local = fakeStorage({ 'pane:a:h5-source': 'remote:1', 'pane:a:h5-task:local': '3', 'pane:ab:h5-task:local': '4', 'h5-task:local': '5', 'ta-lang': 'zh' });
  const session = fakeStorage({ 'pane:a:terminal-client-id': 'x', 'terminal-client-id': 'y' });
  assert.equal(forgetPaneKeys('a', [local, session]), 3);
  assert.deepEqual(local.keys(), ['h5-task:local', 'pane:ab:h5-task:local', 'ta-lang']);
  assert.deepEqual(session.keys(), ['terminal-client-id']);
  assert.equal(forgetPaneKeys('a', [null, { get length() { throw new Error('blocked'); } }]), 0, 'blocked storage is no error');
});

test('a pane tells its parent ready, title and focus, on its own origin only, and opens and forgets on its parent\'s word', async () => {
  const { startPane } = await load();
  const win = fakeWindow({ search: '?pane=a' });
  const doc = fakeDoc();
  const ui = fakeUi({ taskName: '', sessionName: '' });
  win.localStorage.setItem('pane:a:h5-task:local', '1');
  win.localStorage.setItem('pane:b:h5-task:local', '2');
  win.sessionStorage.setItem('pane:a:terminal-client-id', 'c');
  const pane = startPane(ui, 'a', { win, doc });
  assert.equal(win.H5Pane, pane);
  assert.equal(pane.key('h5-source'), 'pane:a:h5-source');
  ui.set({ taskName: 'Early' });
  assert.equal(win.posted.length, 0, 'nothing before the page has started');
  doc.fire('DOMContentLoaded');
  assert.deepEqual(win.posted.map(entry => entry.message), [
    { type: 't-agent-pane', paneId: 'a', event: 'ready' },
    { type: 't-agent-pane', paneId: 'a', event: 'title', title: 'Early', session: '' },
  ]);
  assert.ok(win.posted.every(entry => entry.target === 'http://h5.test'), 'posted to this origin only');
  ui.set({ sessionName: 'Term 1' });
  ui.set({ notice: 'unrelated' });
  assert.deepEqual(win.posted.slice(2).map(entry => entry.message), [{ type: 't-agent-pane', paneId: 'a', event: 'title', title: 'Early', session: 'Term 1' }], 'one title per change');
  win.fire('focus');
  assert.equal(win.posted.length, 3, 'a focus the page took by itself is not told');
  assert.equal(pane.engaged(), false, 'not used yet: the page takes no focus by itself');
  doc.fire('pointerdown');
  win.fire('focus');
  assert.deepEqual(win.posted.slice(3).map(entry => entry.message.event), ['focus'], 'a press and its focus count once');
  assert.equal(pane.engaged(), true);

  const opened = [];
  ui.actions = { paneOpen: request => { opened.push(request); return Promise.resolve(true); } };
  const open = { type: 't-agent-pane', event: 'open', sourceKey: 'remote:3', taskId: 7, terminalId: 't9' };
  win.fire('message', { source: {}, origin: 'http://h5.test', data: open });
  win.fire('message', { source: win.parent, origin: 'http://evil.test', data: open });
  win.fire('message', { source: win.parent, origin: 'http://h5.test', data: { ...open, sourceKey: 3 } });
  win.fire('message', { source: win.parent, origin: 'http://h5.test', data: open });
  win.fire('message', { source: win.parent, origin: 'http://h5.test', data: { type: 't-agent-pane', event: 'open', sourceKey: 'local', taskId: 1 } });
  win.fire('message', { source: win.parent, origin: 'http://h5.test', data: { type: 't-agent-pane', event: 'open', sourceKey: 'local', taskId: 1, conversationId: 'c1' } });
  assert.deepEqual(opened, [
    { sourceKey: 'remote:3', taskId: 7, terminalId: 't9', conversationId: null },
    { sourceKey: 'local', taskId: 1, terminalId: null, conversationId: null },
    { sourceKey: 'local', taskId: 1, terminalId: null, conversationId: 'c1' },
  ], 'open only from the parent on this origin');

  const forget = { type: 't-agent-pane', event: 'forget' };
  win.fire('message', { source: {}, origin: 'http://h5.test', data: forget });
  win.fire('message', { source: win.parent, origin: 'http://evil.test', data: forget });
  win.fire('message', { source: win.parent, origin: 'http://h5.test', data: { ...forget, paneId: 'b' } });
  win.fire('message', { source: win.parent, origin: 'http://h5.test', data: { type: 'other', event: 'forget' } });
  assert.equal(win.localStorage.getItem('pane:a:h5-task:local'), '1', 'messages from elsewhere are ignored');
  win.fire('message', { source: win.parent, origin: 'http://h5.test', data: forget });
  assert.equal(win.localStorage.getItem('pane:a:h5-task:local'), null);
  assert.equal(win.sessionStorage.getItem('pane:a:terminal-client-id'), null);
  assert.equal(win.localStorage.getItem('pane:b:h5-task:local'), '2', 'another pane keeps its keys');
  assert.equal(win.posted.at(-1).message.event, 'forgotten');
});
