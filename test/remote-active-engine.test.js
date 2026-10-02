const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

test('刷新时服务器列表返回前的渲染不会把已保存的远程 Engine 重置为本地', async () => {
  const { document } = parseHTML(fs.readFileSync('public/index.html', 'utf8'));
  const saved = new Map([['active-engine-key', 'remote:2']]);
  const context = {
    document, console, addEventListener() {}, setTimeout, clearTimeout,
    localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, String(value)) },
    API: { async get(path) { return path === '/api/remote-servers' ? [{ id: 2, name: 'Engine 2', status: 'online' }] : path === '/api/system/version' ? { app_version: '1.0.0' } : []; }, async post() { return {}; } },
    Tasks: { clearSelection() {}, activateLocal() {} }, FilePanel: { isOpen: () => false },
    TerminalTabs: {}, Modal: {}, ContextMenu: {}, escapeHtml: String,
  };
  context.window = context; vm.createContext(context);
  vm.runInContext(fs.readFileSync('public/js/remote-tasks.js', 'utf8') + '\nthis.remote = RemoteTasks;', context);

  context.remote.render(); // Tasks.load 会在 RemoteTasks.load 完成前调用
  assert.equal(context.remote.getActiveEngineKey(), 'remote:2');
  assert.equal(saved.get('active-engine-key'), 'remote:2');
});
