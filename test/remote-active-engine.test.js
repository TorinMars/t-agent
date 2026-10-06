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

test('刷新时本地数据先返回，不会把已保存的远程 Engine 重置为本地', async () => {
  const saved = new Map([['active-engine-key', 'remote:2']]);
  const { context } = setup(saved, [{ id: 2, name: 'Engine 2', base_url: 'http://engine', status: 'online' }]);
  await context.Tasks.load(); // Engine 列表还没注册
  assert.equal(context.Tasks.getActiveKey(), 'local', '尚未激活任何数据源，保存的偏好保持不变');
  assert.equal(saved.get('active-engine-key'), 'remote:2');
  await context.Engines.load();
  assert.equal(context.Tasks.getActiveKey(), 'remote:2');
  assert.equal(saved.get('active-engine-key'), 'remote:2');
});

test('保存的 Engine 已被移除时回到本地', async () => {
  const saved = new Map([['active-engine-key', 'remote:7']]);
  const { context } = setup(saved, []);
  await context.Tasks.load();
  await context.Engines.load();
  assert.equal(context.Tasks.getActiveKey(), 'local');
  assert.equal(saved.get('active-engine-key'), 'local');
});

test('同一界面显示不同 Engine 的任务，切换后侧栏内容随之变化', async () => {
  const saved = new Map();
  const { context, document } = setup(saved, [{ id: 2, name: 'Engine 2', base_url: 'http://engine', status: 'online' }]);
  await context.Tasks.load();
  await context.Engines.load();
  assert.match(document.getElementById('task-nav').textContent, /Local task/);
  await context.Tasks.activateSource('remote:2');
  assert.match(document.getElementById('task-nav').textContent, /Remote task/);
  assert.doesNotMatch(document.getElementById('task-nav').textContent, /Local task/);
  assert.equal(document.getElementById('btn-reveal-folder').style.display, 'none', '远程任务不提供 Finder 打开');
  assert.equal(document.getElementById('btn-open-vscode').style.display, 'none', '远程任务不提供 VS Code 打开');
  await context.Tasks.activateSource('local');
  assert.equal(document.getElementById('btn-reveal-folder').style.display, '');
});
