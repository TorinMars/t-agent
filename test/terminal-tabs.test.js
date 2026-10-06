const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const source = fs.readFileSync(path.join(__dirname, '../public/js/terminal-tabs.js'), 'utf8');
const rowsOnServer = [{ terminal_id: 'default', title: '终端 1' }, { terminal_id: 'second', title: '终端 2' }];

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
    TerminalActivity: {
      stateOf: (taskId, terminalId) => states[terminalId] || 'idle',
      acknowledge: (taskId, terminalId) => { delete states[terminalId]; context.TerminalTabs.refresh(); },
    },
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nglobalThis.TerminalTabs = TerminalTabs;`, context);
  return { TerminalTabs: context.TerminalTabs, strip };
}

const titles = strip => [...strip.children].map(button => button.textContent);
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a finished active terminal is acknowledged without duplicating the tabs', async () => {
  const states = { default: 'done', second: 'running' };
  const { TerminalTabs, strip } = load(states);
  TerminalTabs.show('/api/tasks/1', () => {}, { taskId: 1, sourceKey: 'local', viewing: () => true });
  await tick();
  assert.deepEqual(titles(strip), ['终端 1', '终端 2']);
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
  assert.deepEqual(titles(strip), ['终端 1', '终端 2']);
});

test('a finished terminal that is not on screen stays done and is not acknowledged', async () => {
  const states = { default: 'done' };
  const { TerminalTabs, strip } = load(states);
  TerminalTabs.show('/api/tasks/1', () => {}, { taskId: 1, sourceKey: 'local', viewing: () => false });
  await tick();
  assert.deepEqual(titles(strip), ['终端 1', '终端 2']);
  assert.equal(strip.querySelectorAll('.term-done').length, 1);
});
