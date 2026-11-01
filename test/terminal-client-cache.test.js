const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

function setup() {
  const { document, Event } = parseHTML(fs.readFileSync(require.resolve('../public/index.html'), 'utf8'));
  const sockets = [], terminals = [], timers = [];
  class Socket {
    static CONNECTING = 0; static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(data); }
    open() { this.readyState = 1; this.onopen?.(); }
    close() { this.closed = true; this.readyState = 3; }
  }
  class Terminal {
    constructor() { this.cols = 80; this.rows = 24; this.scrollPosition = 37; this.output = ''; terminals.push(this); }
    unicode = {};
    loadAddon() {} open(el) { this.el = el; } focus() { this.focused = (this.focused || 0) + 1; }
    onData() {} onResize() {} reset() { this.output = ''; this.resets = (this.resets || 0) + 1; }
    write(data, done) { this.output += data; done?.(); } dispose() { this.disposed = true; }
  }
  const context = { document, Event, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { protocol: 'http:', host: 'localhost' }, mermaid: { initialize() {} },
    WebSocket: Socket, Terminal, FitAddon: { FitAddon: class {} }, WebLinksAddon: { WebLinksAddon: class {} }, Unicode11Addon: { Unicode11Addon: class {} },
    TerminalOwner: { query: () => '', isBlocked: () => false, prompt() {} },
    TerminalViewport: { fit() {}, observe: () => ({ disconnect() {} }), capture: () => null, restore() {} },
    TerminalImages: { busy: false, attach: () => ({ dispose() {} }) },
    TerminalClipboard: { attach: term => ({ dispose() {}, writeHistory: (data, done) => term.write(data, done) }) },
    TerminalControls: { clearMessage() {}, showMessage() {} },
    API: { get: async () => [{ terminal_id: 'default', title: 'Terminal 1' }], post: async () => ({ terminal_id: 'second', title: 'Terminal 2' }) },
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {},
    requestAnimationFrame: fn => fn(), TextEncoder, TextDecoder, addEventListener() {}, removeEventListener() {}, console,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../public/js/terminal-activity.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(require.resolve('../public/js/terminal-tabs.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(require.resolve('../public/js/terminal-protocol.js'), 'utf8').replace('const TerminalProtocol', 'this.TerminalProtocol'), context);
  vm.runInContext(fs.readFileSync(require.resolve('../public/js/terminal-history.js'), 'utf8'), context);
  let source = fs.readFileSync(require.resolve('../public/js/tasks.js'), 'utf8');
  // Expose only task selection to the fixture; switching uses the real tabs,
  // controller cache, connection and explicit reopen implementations.
  const marker = '  return {\n    async load()';
  const open = "_select(task) { tasks = [task]; selectedId = null; selectTask(task.id); }, _open() { const task = { id: 7 }; tasks = [task]; selectedId = 7; activeTab = 'shell'; connectTerminal(task); }, _openRemote(id = 1) { const key = 'remote:' + id; if (!sources.has(key)) syncSources([1, 2].map(n => ({ id: n, name: 'Engine ' + n, base_url: 'http://engine' }))); const other = sources.get(key); source.tasks = tasks; source.selectedId = selectedId; source = other; tasks = other.tasks = [{ id: 7 }]; selectedId = 7; activeTab = 'shell'; connectTerminal(tasks[0]); },";
  source = source.replace(marker, marker.replace('  return {\n', `  return {\n    ${open}\n`));
  vm.runInContext(source, context);
  return { controller: context.Tasks, context, document, Event, sockets, terminals,
    flush: () => { for (const timer of timers.splice(0)) if (timer.delay === 0) timer.fn(); } };
}

test(`tab switching caches live and connecting terminals`, async () => {
  const app = setup();
  app.controller._open();
  await Promise.resolve();
  app.terminals[0].write('cached output');
  await app.controller.newTerminal();
  assert.equal(app.sockets.length, 2);
  const select = index => app.document.querySelectorAll('.terminal-tab')[index].dispatchEvent(new app.Event('click'));
  select(0); select(1); select(0);
  assert.equal(app.sockets.length, 2, 'CONNECTING sockets must also be cached');
  assert.ok(app.sockets.every(socket => !socket.closed));
  app.flush();
  const hiddenFocus = app.terminals[1].focused || 0;
  app.sockets[1].open();
  assert.equal(app.terminals[1].focused || 0, hiddenFocus, 'background connection cannot steal focus');
  app.sockets[0].open();
  select(1); select(0); app.flush();
  assert.equal(app.terminals.length, 2);
  assert.equal(app.terminals[0].output, 'cached output');
  assert.equal(app.terminals[0].scrollPosition, 37);
  assert.equal(app.terminals[0].el.style.display, '');
  assert.equal(app.terminals[1].el.style.display, 'none');
  await app.controller.reopenTerminal();
  assert.equal(app.sockets.length, 3);
  assert.ok(app.sockets[0].closed);
  assert.ok(!app.sockets[1].closed, 'explicit reopen only replaces the active terminal');
  select(1);
  assert.equal(app.sockets.length, 3);
});

test('terminals of equal task IDs on different Engines are cached separately and use their own endpoint', () => {
  const app = setup();
  app.controller._open();
  app.controller._openRemote(1); app.controller._openRemote(2); app.controller._openRemote(1);
  assert.equal(app.sockets.length, 3, 'local + two Engines, the repeat open reuses the cached terminal');
  assert.ok(app.sockets.every(socket => !socket.closed));
  const paths = app.sockets.map(socket => new URL(socket.url.replace(/^ws/, 'http')).pathname);
  assert.deepEqual(paths, ['/terminal/ws', '/api/remote-servers/1/terminal/ws', '/api/remote-servers/2/terminal/ws']);
});
test(`deleting a terminal removes its tab and cached connection; failure preserves it`, async () => {
  const app = setup();
  app.controller._open();
  await Promise.resolve();
  await app.controller.newTerminal();
  const added = app.terminals.at(-1);
  const socket = app.sockets.at(-1);
  const calls = [];
  app.context.API.post = async (url, body) => { calls.push({ url, body }); throw new Error('offline'); };
  await assert.rejects(app.controller.deleteTerminal(), /offline/);
  assert.equal(added.disposed, undefined);
  assert.equal(app.document.querySelectorAll('.terminal-tab').length, 2);
  app.context.API.post = async (url, body) => { calls.push({ url, body }); return { success: true }; };
  await app.controller.deleteTerminal();
  assert.equal(calls.at(-1).body.action, 'delete');
  assert.equal(calls.at(-1).body.terminal_id, 'second');
  assert.equal(added.disposed, true);
  assert.equal(socket.closed, true);
  assert.equal(app.document.querySelectorAll('.terminal-tab').length, 1);
  assert.equal(app.document.querySelector('.terminal-tab').getAttribute('aria-selected'), 'true');
  assert.equal(app.terminals[0].disposed, undefined);
  // The default terminal is deleted like any other; the last one leaves the task with no terminal and a hint.
  await app.controller.deleteTerminal();
  assert.equal(calls.at(-1).body.terminal_id, 'default');
  assert.equal(app.document.querySelectorAll('.terminal-tab').length, 0);
  await assert.rejects(app.controller.closeTerminal(), /This task has no terminal/);
});

test(`input controls cannot bypass image upload lock`, () => {
  const app = setup(); app.controller._open(); app.sockets[0].open();
  app.sockets[0].sent.length = 0;
  app.context.TerminalImages.busy = true;
  app.controller.sendTerminalInput('unexpected\r');
  assert.deepEqual(app.sockets[0].sent, []);
  app.context.TerminalImages.busy = false;
  app.controller.sendTerminalInput('allowed');
  assert.deepEqual(app.sockets[0].sent, ['allowed']);
});

test(`history pages stay out of live terminal and task switches discard stale pages`, async () => {
  const app = setup(); app.controller._open(); app.sockets[0].open();
  const socket = app.sockets[0];
  socket.onmessage({ data: JSON.stringify({ type: 'history', data: 'recent', archive: { id: 'archive', before: 100, hasMore: true, limit: 500 } }) });
  socket.onmessage({ data: '-live' });
  app.document.getElementById('btn-terminal-history').dispatchEvent(new app.Event('click'));
  const request = socket.sent.map(data => { try { return JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); } catch { return {}; } }).find(data => data.type === 'history-page');
  assert.equal(request.before, 100);
  socket.onmessage({ data: JSON.stringify({ ...request, before: 40, hasMore: true, data: 'archive-only' }) });
  assert.equal(app.document.getElementById('terminal-history-text').textContent, 'archive-only');
  assert.equal(app.terminals[0].output, 'recent-live');
  await app.controller.newTerminal();
  assert.equal(app.document.querySelector('.terminal-history-dialog'), null);
  socket.onmessage({ data: JSON.stringify({ ...request, before: 0, hasMore: false, data: 'stale-page' }) });
  assert.equal(app.terminals[0].output, 'recent-live');
  assert.equal(app.terminals[1].output, '');
});

test(`input toolbar obeys the snapshot replay pause`, () => {
  const app = setup();
  let finish;
  app.context.TerminalClipboard.attach = term => ({ dispose() {}, writeHistory(data, done) { term.write(data); finish = done; } });
  app.controller._open(); app.sockets[0].open();
  app.sockets[0].onmessage({ data: JSON.stringify({ type: 'history', data: 'replay' }) });
  app.sockets[0].sent.length = 0;
  app.controller.sendTerminalInput('must-not-send');
  assert.deepEqual(app.sockets[0].sent, []);
  finish(); app.sockets[0].sent.length = 0;
  app.controller.sendTerminalInput('allowed');
  assert.deepEqual(app.sockets[0].sent, ['allowed']);
});

test('the content tabs stay visible when a task opens straight into its terminal tab', async () => {
  const app = setup();
  app.context.localStorage.getItem = key => (key === 'task-tab-7' ? 'shell' : null);
  // e.g. hidden earlier by the empty state / loading state of another Engine
  app.document.getElementById('content-tabs').style.display = 'none';
  app.controller._select({ id: 7 });
  await Promise.resolve();
  assert.equal(app.document.getElementById('content-tabs').style.display, 'flex');
  assert.equal(app.document.getElementById('terminal-pane').style.display, 'flex');
  assert.equal(app.sockets.length, 1, 'the terminal still connects');
});

test('typed input during the snapshot replay is queued and sent when the replay ends', () => {
  const app = setup();
  let finish, onData;
  app.context.Terminal = class extends app.context.Terminal { onData(fn) { onData = fn; } };
  app.context.TerminalClipboard.attach = term => ({ dispose() {}, writeHistory(data, done) { term.write(data); finish = done; } });
  app.controller._open(); app.sockets[0].open();
  app.sockets[0].onmessage({ data: JSON.stringify({ type: 'history', data: 'replay' }) });
  app.sockets[0].sent.length = 0;
  onData('ab'); onData('c');
  assert.deepEqual(app.sockets[0].sent, []);
  finish();
  assert.deepEqual(app.sockets[0].sent.filter(item => typeof item === 'string'), ['abc']);
});

test('reconnecting after an ownership takeover clears the old screen before the snapshot', () => {
  const app = setup();
  app.context.TerminalOwner.isBlocked = code => code === 4010;
  let take;
  app.context.TerminalOwner.prompt = (host, code, onTake) => { take = onTake; };
  app.controller._open(); app.sockets[0].open();
  app.sockets[0].onmessage({ data: JSON.stringify({ type: 'history', data: 'old screen' }) });
  assert.ok(!app.terminals[0].resets);
  app.sockets[0].onclose({ code: 4010 });
  take();
  app.sockets[1].open();
  assert.equal(app.terminals[0].resets, 1, 'the terminal is reset when it already showed output');
});

test('control-looking text frames from a new server are terminal output, not a snapshot', () => {
  const app = setup();
  app.controller._open(); app.sockets[0].open();
  const bin = value => new TextEncoder().encode(JSON.stringify(value)).buffer;
  app.sockets[0].onmessage({ data: bin({ type: 'history', data: 'screen' }) });
  assert.equal(app.terminals[0].output, 'screen');
  app.sockets[0].onmessage({ data: '{"type":"history","data":"fake"}' });
  assert.equal(app.terminals[0].output, 'screen{"type":"history","data":"fake"}');
});

test('hidden terminals beyond the cache limit are disposed, the visible one is kept', async () => {
  const app = setup();
  let n = 0;
  app.context.API.post = async () => ({ terminal_id: `t${++n}`, title: `T${n}` });
  app.controller._open();
  for (let i = 0; i < 12; i++) await app.controller.newTerminal();
  const disposed = app.terminals.filter(t => t.disposed).length;
  assert.ok(disposed >= 4, `old terminals were disposed (${disposed})`);
  assert.ok(app.terminals.length - disposed <= 8);
  assert.ok(!app.terminals.at(-1).disposed, 'the newest terminal stays');
});

test('sendTerminalInput can target a terminal captured earlier', async () => {
  const app = setup();
  app.controller._open(); app.sockets[0].open();
  const target = app.controller.currentTerminal();
  await app.controller.newTerminal(); app.sockets[1].open();
  app.sockets[0].sent.length = 0; app.sockets[1].sent.length = 0;
  assert.equal(app.controller.sendTerminalInput('hello', target), true);
  assert.deepEqual(app.sockets[0].sent, ['hello']);
  assert.deepEqual(app.sockets[1].sent, []);
});
