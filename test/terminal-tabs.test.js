const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

test('new terminal tabs switch independently and keep local and remote task state separate', async () => {
  const { document } = parseHTML('<div id="terminal-tabs"></div>');
  const calls = [];
  const context = vm.createContext({ document, API: {
    async get() { return [{ terminal_id: 'default', title: '终端 1' }]; },
    async post(url) { calls.push(url); return { terminal_id: 'second', title: '终端 2' }; },
  } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/js/terminal-tabs.js'), 'utf8') + '\nglobalThis.tabs = TerminalTabs;', context);
  const tabs = context.tabs;
  let switches = 0;
  tabs.show('/api/tasks/1', () => switches++);
  await Promise.resolve();
  await tabs.create();
  assert.deepEqual(calls, ['/api/tasks/1/terminals']);
  assert.equal(tabs.current('/api/tasks/1'), 'second');
  assert.equal(switches, 1);
  const buttons = document.querySelectorAll('button');
  assert.equal(buttons.length, 2);
  assert.equal(buttons[1].getAttribute('aria-selected'), 'true');
  buttons[0].click();
  assert.equal(tabs.current('/api/tasks/1'), 'default');
  assert.equal(switches, 2);
  tabs.show('/api/remote-servers/2/tasks/1', () => {});
  await Promise.resolve();
  await tabs.create();
  assert.equal(tabs.current('/api/tasks/1'), 'default');
  assert.equal(tabs.current('/api/remote-servers/2/tasks/1'), 'second');
});
