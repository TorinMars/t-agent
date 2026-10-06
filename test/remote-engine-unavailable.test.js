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

test('离线 Engine 只显示检查服务状态的提示，不显示任务和操作页面', async () => {
  const { document, context } = setup({ id: 1, name: 'Engine 1', base_url: 'http://10.0.0.5:3000', status: 'offline', last_error: 'REMOTE_TIMEOUT' });
  await context.Tasks.load();
  await context.Engines.load();
  const panel = panelOf(document);
  assert.ok(panel, '应显示不可用提示');
  assert.match(panel.textContent, /无法连接「Engine 1」/);
  assert.match(panel.textContent, /连接超时/);
  assert.match(panel.textContent, /请检查服务状态/);
  assert.match(panel.textContent, /http:\/\/10\.0\.0\.5:3000/);
  assert.deepEqual([...panel.querySelectorAll('button')].map(b => b.textContent), ['重试连接', '编辑连接', '移除连接']);
  assert.equal(document.getElementById('content-toolbar').style.display, 'none');
  assert.equal(document.getElementById('content-tabs').style.display, 'none');
  assert.equal(document.getElementById('terminal-pane').style.display, 'none');
  assert.equal(document.getElementById('preview-content').style.display, 'none');
  assert.equal(document.querySelectorAll('.task-nav-item').length, 0, '侧栏不列出任务');
  assert.match(nav(document), /服务不可用/);
});

test('认证失效提示重新配对，而不是检查网络', async () => {
  const { document, context } = setup({ id: 1, name: 'Engine 1', base_url: 'http://10.0.0.5:3000', status: 'unauthorized' });
  await context.Tasks.load();
  await context.Engines.load();
  assert.match(panelOf(document).textContent, /认证失效/);
  assert.match(panelOf(document).textContent, /配对码/);
});

test('在线但任务接口失败时同样显示提示', async () => {
  const { document, context } = setup({ id: 1, name: 'Engine 1', base_url: 'http://10.0.0.5:3000', status: 'online' }, { tasksFail: true });
  await context.Tasks.load();
  await context.Engines.load();
  assert.ok(panelOf(document));
  assert.match(panelOf(document).textContent, /远程服务连接失败/);
});

test('在线的 Engine 不显示提示，切回默认 Engine 时提示消失', async () => {
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

test('重试连接会重新检查该 Engine', async () => {
  const { document, context, calls } = setup({ id: 1, name: 'Engine 1', base_url: 'http://x', status: 'offline' });
  await context.Tasks.load();
  await context.Engines.load();
  panelOf(document).querySelector('button').dispatchEvent(new context.document.defaultView.Event('click'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(calls.includes('/api/remote-servers/1/check'));
});
