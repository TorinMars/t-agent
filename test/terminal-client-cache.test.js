const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

function setup(remote) {
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
    loadAddon() {} open(el) { this.el = el; } focus() { this.focused = (this.focused || 0) + 1; }
    onData() {} onResize() {} reset() { this.output = ''; this.resets = (this.resets || 0) + 1; }
    write(data, done) { this.output += data; done?.(); } dispose() { this.disposed = true; }
  }
  const context = { document, Event, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { protocol: 'http:', host: 'localhost' }, mermaid: { initialize() {} },
    WebSocket: Socket, Terminal, FitAddon: { FitAddon: class {} },
    TerminalViewport: { fit() {}, observe: () => ({ disconnect() {} }), capture: () => null, restore() {} },
    TerminalImages: { busy: false, attach: () => ({ dispose() {} }) },
    TerminalClipboard: { attach: term => ({ dispose() {}, writeHistory: (data, done) => term.write(data, done) }) },
    TerminalControls: { clearMessage() {}, showMessage() {} },
    API: { get: async () => [{ terminal_id: 'default', title: '终端 1' }], post: async () => ({ terminal_id: 'second', title: '终端 2' }) },
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearTimeout() {},
    requestAnimationFrame: fn => fn(), addEventListener() {}, removeEventListener() {}, console,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../public/js/terminal-tabs.js'), 'utf8'), context);
  let source = fs.readFileSync(require.resolve(remote ? '../public/js/remote-tasks.js' : '../public/js/tasks.js'), 'utf8');
  // Expose only task selection to the fixture; switching uses the real tabs,
  // controller cache, connection and explicit reopen implementations.
  const marker = remote ? '  return {\n    load,' : '  return {\n    async load()';
  const open = remote
    ? "_open(serverId = 1) { selected = { serverId, task: { id: 7 } }; activeTab = 'shell'; renderRemoteTerminal(); },"
    : "_open() { const task = { id: 7 }; tasks = [task]; selectedId = 7; activeTab = 'shell'; connectTerminal(task); },";
  source = source.replace(marker, marker.replace('  return {\n', `  return {\n    ${open}\n`));
  vm.runInContext(source, context);
  return { controller: remote ? context.RemoteTasks : context.Tasks, context, document, Event, sockets, terminals,
    flush: () => { for (const timer of timers.splice(0)) if (timer.delay === 0) timer.fn(); } };
}

for (const remote of [false, true]) {
  test(`${remote ? 'remote' : 'local'} tab switching caches live and connecting terminals`, async () => {
    const app = setup(remote);
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
}

test('remote cache isolates equal task and terminal IDs on different servers', async () => {
  const app = setup(true);
  app.controller._open(1); app.controller._open(2); app.controller._open(1);
  assert.equal(app.sockets.length, 2);
  assert.ok(app.sockets.every(socket => !socket.closed));
});

for (const remote of [false, true]) {
  test(`${remote ? 'remote' : 'local'} deleting a terminal removes its tab and cached connection; failure preserves it`, async () => {
    const app = setup(remote);
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
    await assert.rejects(app.controller.deleteTerminal(), /默认终端不能删除/);
  });
}

for (const remote of [false, true]) {
  test(`${remote ? 'remote' : 'local'} input controls cannot bypass image upload lock`, () => {
    const app = setup(remote); app.controller._open(); app.sockets[0].open();
    app.sockets[0].sent.length = 0;
    app.context.TerminalImages.busy = true;
    app.controller.sendTerminalInput('unexpected\r');
    assert.deepEqual(app.sockets[0].sent, []);
    app.context.TerminalImages.busy = false;
    app.controller.sendTerminalInput('allowed');
    assert.deepEqual(app.sockets[0].sent, ['allowed']);
  });
}
