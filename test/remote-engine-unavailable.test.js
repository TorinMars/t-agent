const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

function setup(server, { tasksFail = false } = {}) {
  const { document } = parseHTML(fs.readFileSync('public/index.html', 'utf8'));
  const saved = new Map([['active-engine-key', `remote:${server.id}`]]);
  const calls = [];
  const context = {
    document, console: { ...console, warn() {}, error() {} }, addEventListener() {}, setTimeout, clearTimeout, setInterval() { return 0; }, clearInterval() {},
    localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, String(value)), removeItem: key => saved.delete(key) },
    mermaid: { initialize() {} }, escapeHtml: String, confirm: () => true, alert() {},
    API: {
      async get(path) {
        if (path === '/api/remote-servers') return [server];
        if (path === '/api/system/version') return { app_version: '1.0.0' };
        if (/\/info$/.test(path)) return { role: 'operator', capabilities: ['tasks:write', 'documents:write', 'todos:write'] };
        if (path.startsWith('/api/remote-servers') && /\/tasks$/.test(path)) {
          if (tasksFail) throw new Error('REMOTE_CONNECTION_FAILED');
          return [{ id: 7, title: 'Remote task', status: 'todo' }];
        }
        if (path === '/api/tasks') return [{ id: 1, title: 'Local task', status: 'todo' }];
        return [];
      },
      async post(path) { calls.push(path); return {}; },
    },
    FilePanel: { isOpen: () => false }, TerminalHistory: { activate() {} }, TerminalControls: { clearMessage() {}, showMessage() {} },
    TerminalImages: { busy: false }, Modal: {}, ContextMenu: {},
  };
  context.window = context; vm.createContext(context);
  for (const file of ['terminal-activity.js', 'terminal-tabs.js', 'tasks.js', 'engines.js']) {
    vm.runInContext(fs.readFileSync(`public/js/${file}`, 'utf8'), context);
  }
  return { document, context, calls };
}

const panelOf = document => document.getElementById('engine-unavailable');
const nav = document => document.getElementById('task-nav').textContent;

test('An offline Engine shows only the check-service hint, with no tasks or action pages', async () => {
  const { document, context } = setup({ id: 1, name: 'Engine 1', base_url: 'http://10.0.0.5:3000', status: 'offline', last_error: 'REMOTE_TIMEOUT' });
  await context.Tasks.load();
  await context.Engines.load();
  const panel = panelOf(document);
  assert.ok(panel, 'The unavailable hint should be shown');
  assert.match(panel.textContent, /Cannot connect to “Engine 1”/);
  assert.match(panel.textContent, /Connection timed out/);
  assert.match(panel.textContent, /Check the service status/);
  assert.match(panel.textContent, /http:\/\/10\.0\.0\.5:3000/);
  assert.deepEqual([...panel.querySelectorAll('button')].map(b => b.textContent), ['Retry connection', 'Edit connection', 'Remove connection']);
  assert.equal(document.getElementById('content-toolbar').style.display, 'none');
  assert.equal(document.getElementById('content-tabs').style.display, 'none');
  assert.equal(document.getElementById('terminal-pane').style.display, 'none');
  assert.equal(document.getElementById('preview-content').style.display, 'none');
  assert.equal(document.querySelectorAll('.task-nav-item').length, 0, 'The sidebar lists no tasks');
  assert.match(nav(document), /Service unavailable/);
});

test('Expired authentication tells the user to pair again rather than check the network', async () => {
  const { document, context } = setup({ id: 1, name: 'Engine 1', base_url: 'http://10.0.0.5:3000', status: 'unauthorized' });
  await context.Tasks.load();
  await context.Engines.load();
  assert.match(panelOf(document).textContent, /Authentication expired/);
  assert.match(panelOf(document).textContent, /pairing code/);
});

test('An online Engine whose task endpoint fails shows the hint as well', async () => {
  const { document, context } = setup({ id: 1, name: 'Engine 1', base_url: 'http://10.0.0.5:3000', status: 'online' }, { tasksFail: true });
  await context.Tasks.load();
  await context.Engines.load();
  assert.ok(panelOf(document));
  assert.match(panelOf(document).textContent, /Failed to connect to the remote service/);
});

test('An online Engine shows no hint, and the hint disappears when switching back to the default Engine', async () => {
  const online = setup({ id: 1, name: 'Engine 1', base_url: 'http://x', status: 'online' });
  await online.context.Tasks.load();
  await online.context.Engines.load();
  assert.equal(panelOf(online.document), null);
  assert.match(nav(online.document), /Remote task/);

  const down = setup({ id: 1, name: 'Engine 1', base_url: 'http://x', status: 'offline' });
  await down.context.Tasks.load();
  await down.context.Engines.load();
  assert.ok(panelOf(down.document));
  await down.context.Tasks.activateSource('local');
  assert.equal(panelOf(down.document), null);
  assert.match(nav(down.document), /Local task/);
});

test('Retrying the connection checks that Engine again', async () => {
  const { document, context, calls } = setup({ id: 1, name: 'Engine 1', base_url: 'http://x', status: 'offline' });
  await context.Tasks.load();
  await context.Engines.load();
  panelOf(document).querySelector('button').dispatchEvent(new context.document.defaultView.Event('click'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(calls.includes('/api/remote-servers/1/check'));
});
