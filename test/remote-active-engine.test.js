const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

function setup(saved, servers) {
  const { document } = parseHTML(fs.readFileSync('public/index.html', 'utf8'));
  const context = {
    document, console: { ...console, warn() {}, error() {} }, addEventListener() {}, setTimeout, clearTimeout, setInterval() { return 0; }, clearInterval() {},
    localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, String(value)), removeItem: key => saved.delete(key) },
    mermaid: { initialize() {} }, escapeHtml: String, confirm: () => true, alert() {},
    API: {
      async get(path) {
        if (path === '/api/remote-servers') return servers;
        if (path === '/api/system/version') return { app_version: '1.0.0' };
        if (/\/info$/.test(path)) return { role: 'operator', capabilities: ['tasks:write', 'documents:write', 'todos:write'] };
        if (/\/tasks$/.test(path)) return path.startsWith('/api/remote-servers') ? [{ id: 9, title: 'Remote task', status: 'todo' }] : [{ id: 1, title: 'Local task', status: 'todo' }];
        return [];
      },
      async post() { return {}; },
    },
    FilePanel: { isOpen: () => false }, TerminalHistory: { activate() {} }, TerminalControls: { clearMessage() {}, showMessage() {} },
    TerminalImages: { busy: false }, Modal: {}, ContextMenu: {},
  };
  context.window = context; vm.createContext(context);
  for (const file of ['terminal-activity.js', 'terminal-tabs.js', 'tasks.js', 'engines.js']) {
    vm.runInContext(fs.readFileSync(`public/js/${file}`, 'utf8'), context);
  }
  return { context, document };
}

test('During refresh the local data returns first and a saved remote Engine is not reset to local', async () => {
  const saved = new Map([['active-engine-key', 'remote:2']]);
  const { context } = setup(saved, [{ id: 2, name: 'Engine 2', base_url: 'http://engine', status: 'online' }]);
  await context.Tasks.load(); // the Engine list is not registered yet
  assert.equal(context.Tasks.getActiveKey(), 'local', 'No data source is active yet, so the saved preference stays unchanged');
  assert.equal(saved.get('active-engine-key'), 'remote:2');
  await context.Engines.load();
  assert.equal(context.Tasks.getActiveKey(), 'remote:2');
  assert.equal(saved.get('active-engine-key'), 'remote:2');
});

test('Falls back to local when the saved Engine has been removed', async () => {
  const saved = new Map([['active-engine-key', 'remote:7']]);
  const { context } = setup(saved, []);
  await context.Tasks.load();
  await context.Engines.load();
  assert.equal(context.Tasks.getActiveKey(), 'local');
  assert.equal(saved.get('active-engine-key'), 'local');
});

test('One UI shows the tasks of different Engines, and the sidebar content follows the switch', async () => {
  const saved = new Map();
  const { context, document } = setup(saved, [{ id: 2, name: 'Engine 2', base_url: 'http://engine', status: 'online' }]);
  await context.Tasks.load();
  await context.Engines.load();
  assert.match(document.getElementById('task-nav').textContent, /Local task/);
  await context.Tasks.activateSource('remote:2');
  assert.match(document.getElementById('task-nav').textContent, /Remote task/);
  assert.doesNotMatch(document.getElementById('task-nav').textContent, /Local task/);
  assert.equal(document.getElementById('btn-reveal-folder').style.display, 'none', 'Remote tasks do not offer opening in Finder');
  assert.equal(document.getElementById('btn-open-vscode').style.display, 'none', 'Remote tasks do not offer opening in VS Code');
  await context.Tasks.activateSource('local');
  assert.equal(document.getElementById('btn-reveal-folder').style.display, '');
});

test('During refresh the local group endpoint is slow and the user has already switched to a remote Engine; after switching back to local the tasks are not lost', async () => {
  // The local task list returns first while the group endpoint is slow; in the meantime Engines has already switched the UI to the saved remote Engine,
  // and switching writes the tasks of that moment back to the local data source; the local tasks just received must not be overwritten with an empty list.
  const saved = new Map([['active-engine-key', 'remote:2']]);
  const { context, document } = setup(saved, [{ id: 2, name: 'Engine 2', base_url: 'http://engine', status: 'online' }]);
  const original = context.API.get;
  context.API.get = async path => {
    if (path === '/api/task-groups') await new Promise(resolve => setTimeout(resolve, 40));
    return original.call(context.API, path);
  };
  await Promise.all([context.Tasks.load(), context.Engines.load()]);
  assert.equal(context.Tasks.getActiveKey(), 'remote:2');
  assert.match(document.getElementById('task-nav').textContent, /Remote task/);
  await context.Tasks.activateSource('local');
  assert.match(document.getElementById('task-nav').textContent, /Local task/, 'After switching back to local, the local tasks should be shown');
  assert.equal(context.Tasks.getSource('local').tasks.length, 1);
});
