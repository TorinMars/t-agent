const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const source = fs.readFileSync(path.join(__dirname, '../public/js/terminal-tabs.js'), 'utf8');
const rowsOnServer = [{ terminal_id: 'default', title: 'Terminal 1' }, { terminal_id: 'second', title: 'Terminal 2' }];

// Mirrors TerminalActivity.acknowledge: it clears the state and notifies listeners
// synchronously, and a listener refreshes the tab strip while it may still be rendering.
function load(states) {
  const { document } = parseHTML('<div id="terminal-tabs"></div><button id="btn-terminal-delete"></button>');
  const strip = document.getElementById('terminal-tabs');
  // linkedom's replaceChildren ignores its arguments; browsers replace the children.
  strip.replaceChildren = (...nodes) => { while (strip.firstChild) strip.removeChild(strip.firstChild); nodes.forEach(node => strip.appendChild(node)); };
  const context = {
    document,
    API: { get: async () => rowsOnServer, post: async () => ({}) },
    TerminalControls: { calls: [], run(...args) { this.calls.push(args); } },
    TerminalActivity: {
      stateOf: (taskId, terminalId) => states[terminalId] || 'idle',
      acknowledge: (taskId, terminalId) => { delete states[terminalId]; context.TerminalTabs.refresh(); },
    },
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nglobalThis.TerminalTabs = TerminalTabs;`, context);
  return { TerminalTabs: context.TerminalTabs, strip, controls: context.TerminalControls };
}

const titles = strip => [...strip.children].map(button => button.textContent);
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a finished active terminal is acknowledged without duplicating the tabs', async () => {
  const states = { default: 'done', second: 'running' };
  const { TerminalTabs, strip } = load(states);
  TerminalTabs.show('/api/tasks/1', () => {}, { taskId: 1, sourceKey: 'local', viewing: () => true });
  await tick();
  assert.deepEqual(titles(strip), ['Terminal 1', 'Terminal 2']);
  assert.equal(strip.querySelectorAll('.term-done').length, 0, 'the acknowledged terminal is no longer done');
  assert.equal(strip.querySelectorAll('.term-running').length, 1);
});

test('a terminal that finishes while it is on screen keeps one set of tabs', async () => {
  const states = {};
  const { TerminalTabs, strip } = load(states);
  TerminalTabs.show('/api/tasks/1', () => {}, { taskId: 1, sourceKey: 'local', viewing: () => true });
  await tick();
  states.default = 'running';
  TerminalTabs.refresh();
  states.default = 'done'; // running -> done while the user is looking at it
  TerminalTabs.refresh();
  assert.deepEqual(titles(strip), ['Terminal 1', 'Terminal 2']);
});

test('a finished terminal that is not on screen stays done and is not acknowledged', async () => {
  const states = { default: 'done' };
  const { TerminalTabs, strip } = load(states);
  TerminalTabs.show('/api/tasks/1', () => {}, { taskId: 1, sourceKey: 'local', viewing: () => false });
  await tick();
  assert.deepEqual(titles(strip), ['Terminal 1', 'Terminal 2']);
  assert.equal(strip.querySelectorAll('.term-done').length, 1);
});

test('The entry to delete a terminal is in the tab: every tab, the default one included, carries a ×, and clicking × deletes only that tab without switching', async () => {
  const { TerminalTabs, strip, controls } = load({});
  let selected = 0;
  TerminalTabs.show('/api/tasks/1', () => { selected += 1; }, { taskId: 1, sourceKey: 'local', viewing: () => false });
  await tick();
  const [first, second] = [...strip.children];
  assert.equal(first.querySelector('.terminal-tab-close').getAttribute('aria-label'), 'Delete Terminal 1');
  const close = second.querySelector('.terminal-tab-close');
  assert.ok(close);
  assert.equal(close.getAttribute('aria-label'), 'Delete Terminal 2');
  let stopped = false;
  close.dispatchEvent(Object.assign(new (require('linkedom').parseHTML('').Event)('click'), { stopPropagation() { stopped = true; } }));
  assert.equal(stopped, true);
  assert.equal(controls.calls.length, 1);
  assert.equal(controls.calls[0][0], 'deleteTerminal');
  assert.match(controls.calls[0][1], /Terminal 2/);
  assert.equal(controls.calls[0][2], 'second');
  assert.equal(TerminalTabs.current('/api/tasks/1'), 'default', 'Clicking × does not switch to that tab');
  const before = selected;
  TerminalTabs.remove('/api/tasks/1', 'second');
  assert.equal(selected, before, 'When the deleted tab is not the current one, the current terminal is not reconnected');
  assert.deepEqual(titles(strip), ['Terminal 1']);
});

test('agent chats are tabs after the terminals; selecting one deactivates the terminal and a terminal tab leaves the chat', async () => {
  const { TerminalTabs, strip } = load({});
  TerminalTabs.show('/api/tasks/1', () => {}, { taskId: 1, sourceKey: 'local' });
  await tick();
  const log = [];
  const chats = { rows: [{ id: 'c1', agent: 'codex', title: 'Fix build' }], active: null, select: id => { chats.active = id; log.push(`select ${id}`); TerminalTabs.setChats('/api/tasks/1', chats); }, close: id => log.push(`close ${id}`), leave: () => { chats.active = null; log.push('leave'); } };
  TerminalTabs.setChats('/api/tasks/1', chats);
  assert.equal(strip.children.length, 3);
  strip.children[2].click();
  assert.deepEqual(log, ['select c1']);
  assert.equal(strip.querySelectorAll('.active').length, 1, 'only the chat tab is active');
  assert.ok(strip.children[2].classList.contains('active'));
  strip.children[2].querySelector('.terminal-tab-close').click();
  assert.deepEqual(log, ['select c1', 'close c1']);
  strip.children[0].click();
  assert.deepEqual(log, ['select c1', 'close c1', 'leave']);
  assert.ok(strip.children[0].classList.contains('active'));
  TerminalTabs.setChats('/api/tasks/1', null);
  assert.equal(strip.children.length, 2);
});

test('a long agent chat title is truncated in its own label so the close button stays visible', async () => {
  const { TerminalTabs, strip } = load({});
  TerminalTabs.show('/api/tasks/1', () => {}, { taskId: 1, sourceKey: 'local' });
  await tick();
  const chats = { rows: [{ id: 'c1', agent: 'codex', title: 'A very long chat title that does not fit in the tab at all' }], active: null, select: () => {}, close: () => {}, leave: () => {} };
  TerminalTabs.setChats('/api/tasks/1', chats);
  const tab = strip.children[2];
  assert.ok(tab.querySelector('.agent-tab-label'), 'the title has its own element to truncate');
  assert.ok(tab.querySelector('.terminal-tab-close'));
  const css = fs.readFileSync(path.join(__dirname, '../public/css/style.css'), 'utf8');
  assert.match(css, /\.terminal-tabs \.agent-tab-label \{[^}]*text-overflow: ellipsis/);
  assert.doesNotMatch(css, /\.terminal-tabs \.agent-tab \{[^}]*overflow: hidden/, 'clipping the whole tab hides the close button');
});

test('deleting the current terminal selects the first remaining one, and the last one leaves no terminal selected', async () => {
  const { TerminalTabs, strip } = load({});
  let selected = 0;
  TerminalTabs.show('/api/tasks/1', () => { selected += 1; }, { taskId: 1, sourceKey: 'local' });
  await tick();
  TerminalTabs.remove('/api/tasks/1', 'default');
  assert.equal(TerminalTabs.current('/api/tasks/1'), 'second');
  assert.deepEqual(titles(strip), ['Terminal 2']);
  assert.equal(selected, 1);
  TerminalTabs.remove('/api/tasks/1', 'second');
  assert.equal(TerminalTabs.current('/api/tasks/1'), null);
  assert.equal(strip.children.length, 0);
  assert.equal(selected, 2);
});
