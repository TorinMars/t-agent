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

test('a pane tells its tab the device of its task, and posts the column keys instead of typing them', async () => {
  const { startPane } = await load();
  const win = fakeWindow({ search: '?pane=a' });
  const doc = fakeDoc();
  const ui = fakeUi({ taskName: 'Fix', sessionName: 'T1', taskList: { tasks: [{ id: 1, selected: false, device: { key: 'local', local: true, name: 'MacBook', label: 'This machine', instanceId: 'm1' } }] } });
  startPane(ui, 'a', { win, doc });
  doc.fire('DOMContentLoaded');
  const titles = () => win.posted.filter(entry => entry.message.event === 'title').map(entry => entry.message);
  assert.deepEqual(titles(), [{ type: 't-agent-pane', paneId: 'a', event: 'title', title: 'Fix', session: 'T1' }], 'no selected tagged row: no device');
  ui.set({ taskList: { tasks: [{ id: 2, selected: true, device: { key: 'remote:7', local: false, name: '', label: 'K01', instanceId: 'k1', offline: false } }] } });
  assert.deepEqual(titles().at(-1), { type: 't-agent-pane', paneId: 'a', event: 'title', title: 'Fix', session: 'T1', device: { name: 'K01', instanceId: 'k1', local: false, offline: false } });
  ui.set({ notice: 'unrelated' });
  assert.equal(titles().length, 2, 'the same title and device are not posted again');
  ui.set({ taskList: { tasks: [{ id: 2, selected: true, device: { key: 'remote:7', local: false, name: '', label: 'K01', instanceId: 'k1', offline: true } }] } });
  assert.equal(titles().at(-1).device.offline, true, 'a device going offline is a change');

  const key = extra => { const event = { key: 'ArrowRight', ctrlKey: true, altKey: true, prevented: 0, stopped: 0, preventDefault() { this.prevented += 1; }, stopPropagation() { this.stopped += 1; }, ...extra }; win.fire('keydown', event); return event; };
  const step = key({});
  assert.deepEqual(win.posted.at(-1).message, { type: 't-agent-pane', paneId: 'a', event: 'step', step: 1 });
  assert.equal(step.prevented + step.stopped, 2, 'the step key never reaches the terminal');
  const move = key({ key: 'ArrowLeft', shiftKey: true });
  assert.deepEqual(win.posted.at(-1).message, { type: 't-agent-pane', paneId: 'a', event: 'move', step: -1 });
  assert.equal(move.prevented + move.stopped, 2, 'nor the move key');
  const count = win.posted.length;
  key({ shiftKey: true, isComposing: true });
  key({ key: 'ArrowRight', ctrlKey: false, shiftKey: true });
  assert.equal(win.posted.length, count, 'other keys are not posted');
});

test('a mind map column opens its map again after a reload and keeps what its view shows; it answers maximized and peek', async () => {
  const { startPane } = await load();
  const win = fakeWindow({ search: '?pane=a' });
  const doc = fakeDoc();
  const ui = fakeUi({ taskName: '', sessionName: '' });
  win.localStorage.setItem('pane:a:h5-mindmap', JSON.stringify({ screen: 'editor', sourceKey: 'local', id: 'm1' }));
  const opened = [];
  // As h5.js does: the view says at once what it is opening.
  ui.actions.openMindmaps = ({ open }) => { opened.push(open); ui.set({ mindmapView: { screen: 'editor', sourceKey: open.sourceKey, id: open.id, title: '' } }); };
  const maximized = [];
  ui.actions.setMindmapMaximized = on => maximized.push(on);
  ui.actions.paneTail = count => ['one', 'two'].slice(-count);
  startPane(ui, 'a', { win, doc });
  doc.fire('DOMContentLoaded');
  assert.deepEqual(opened, [{ sourceKey: 'local', id: 'm1' }]);
  assert.equal(win.localStorage.getItem('pane:a:h5-mindmap'), '{"screen":"editor","sourceKey":"local","id":"m1"}', 'not lost while the bundle loads');
  ui.set({ mindmapView: { screen: 'editor', sourceKey: 'local', id: 'm1', title: 'Plan' } });
  const title = win.posted.map(p => p.message).filter(m => m.event === 'title').at(-1);
  assert.deepEqual(title.map, { title: 'Plan', screen: 'editor' }, 'the tab hears the map name');
  ui.set({ mindmapView: { screen: 'list', title: '' } });
  assert.equal(win.localStorage.getItem('pane:a:h5-mindmap'), '{"screen":"list"}');
  ui.set({ mindmapView: null });
  assert.equal(win.localStorage.getItem('pane:a:h5-mindmap'), null, 'the view closed: the column shows its task again');
  const fromParent = data => win.fire('message', { source: win.parent, origin: 'http://h5.test', data: { type: 't-agent-pane', ...data } });
  fromParent({ event: 'maximized', on: true });
  fromParent({ event: 'maximized', on: false });
  assert.deepEqual(maximized, [true, false]);
  win.fire('message', { source: {}, origin: 'http://h5.test', data: { type: 't-agent-pane', event: 'maximized', on: true } });
  assert.deepEqual(maximized, [true, false], 'only from the parent');
  fromParent({ event: 'peek' });
  assert.deepEqual(win.posted.at(-1).message, { type: 't-agent-pane', paneId: 'a', event: 'peek', lines: ['one', 'two'] });
  // With the map view open, Cmd/Ctrl+Shift+Enter is the map's to take (it knows when a topic is being edited).
  const key = { key: 'Enter', metaKey: true, shiftKey: true, preventDefault() {}, stopPropagation() {} };
  ui.set({ mindmapView: { screen: 'list', title: '' } });
  const before = win.posted.length;
  win.fire('keydown', key);
  assert.equal(win.posted.slice(before).filter(p => p.message.event === 'maximize').length, 0);
});

test('Cmd/Ctrl+Shift+Enter in any pane asks the top page to maximize its column, and never reaches the page', async () => {
  const { startPane } = await load();
  const win = fakeWindow({ search: '?pane=t' });
  const doc = fakeDoc();
  const ui = fakeUi({ taskName: 'Shell' });
  startPane(ui, 't', { win, doc });
  doc.fire('DOMContentLoaded');
  let stopped = 0;
  const key = extra => ({ key: 'Enter', shiftKey: true, preventDefault() {}, stopPropagation() { stopped += 1; }, ...extra });
  win.fire('keydown', key({ ctrlKey: true }));
  win.fire('keydown', key({ metaKey: true }));
  win.fire('keydown', key({ metaKey: true, repeat: true }));
  win.fire('keydown', key({ metaKey: true, isComposing: true }));
  win.fire('keydown', key({}));
  const asks = win.posted.filter(p => p.message.event === 'maximize');
  assert.equal(asks.length, 2, 'Ctrl and Cmd; a held key asks once; not inside a composition; not Shift+Enter alone');
  assert.deepEqual(asks[0], { message: { type: 't-agent-pane', paneId: 't', event: 'maximize' }, target: 'http://h5.test' });
  assert.equal(stopped, 3, 'the terminal never gets it (the repeat is swallowed too)');
});

test('a pane without a stored map opens nothing and stores nothing', async () => {
  const { startPane } = await load();
  const win = fakeWindow({ search: '?pane=b' });
  const doc = fakeDoc();
  const ui = fakeUi({});
  let calls = 0;
  ui.actions.openMindmaps = () => { calls += 1; };
  startPane(ui, 'b', { win, doc });
  doc.fire('DOMContentLoaded');
  ui.set({ taskName: 'x' });
  assert.equal(calls, 0);
  assert.equal(win.localStorage.getItem('pane:b:h5-mindmap'), null);
});

test('the column header acts inside the pane: task sheet, terminal width, rename, restart and reload, only from the parent', async () => {
  const { startPane } = await load();
  const win = fakeWindow({ search: '?pane=a' });
  const doc = fakeDoc();
  const ui = fakeUi({ taskName: 'Fix', sessionName: 'T1', wide: false, tasksOpen: true, terminalWidth: { mode: 'fit', cols: 160, current: 45 }, sourceLabel: 'K01' });
  const calls = [];
  for (const name of ['paneTasks', 'setTerminalWidth', 'toggleTerminalWidth', 'paneRename', 'paneRestart', 'refresh']) ui.actions[name] = (...args) => { calls.push([name, ...args]); };
  const pane = startPane(ui, 'a', { win, doc });
  doc.fire('DOMContentLoaded');
  // The title tells the header whether the task sheet is shown, the terminal width, and a remote service without a tag as a device.
  assert.deepEqual(win.posted.find(entry => entry.message.event === 'title').message, {
    type: 't-agent-pane', paneId: 'a', event: 'title', title: 'Fix', session: 'T1', device: { name: 'K01', instanceId: '', local: false, offline: false }, sheet: true, width: { mode: 'fit', cols: 160 },
  });
  ui.set({ wide: true, sidebarCollapsed: true, terminalWidth: null });
  assert.deepEqual(win.posted.at(-1).message, { type: 't-agent-pane', paneId: 'a', event: 'title', title: 'Fix', session: 'T1', device: { name: 'K01', instanceId: '', local: false, offline: false } }, 'a folded sidebar is no sheet; no terminal, no width');
  const send = (data, from = win.parent, origin = 'http://h5.test') => win.fire('message', { source: from, origin, data: { type: 't-agent-pane', ...data } });
  send({ event: 'tasks', toggle: true }, {});
  send({ event: 'rename' }, win.parent, 'http://evil.test');
  send({ event: 'restart', paneId: 'b' });
  assert.deepEqual(calls, [], 'from elsewhere, another origin or for another pane: nothing');
  assert.equal(pane.engaged(), false);
  send({ event: 'tasks', toggle: true });
  assert.equal(pane.engaged(), true, 'a header action is the person using this column (the sheet may take the focus)');
  send({ event: 'tasks' });
  send({ event: 'width' });
  send({ event: 'width', mode: 'wide', cols: 200 });
  send({ event: 'rename' });
  send({ event: 'restart' });
  send({ event: 'reload' });
  send({ event: 'delete' });
  assert.deepEqual(calls, [
    ['paneTasks', { toggle: true }], ['paneTasks', { toggle: false }], ['toggleTerminalWidth'], ['setTerminalWidth', { mode: 'wide', cols: 200 }],
    ['paneRename'], ['paneRestart'], ['refresh'],
  ]);
});
