const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function setup(remote = false) {
  const { document } = parseHTML(fs.readFileSync('public/index.html', 'utf8'));
  const watchers = [], errors = [];
  const context = { document, console: { error: (...args) => errors.push(args) },
    localStorage: { getItem: () => null, setItem() {} }, escapeHtml: String,
    mermaid: { initialize() {}, run: async () => {} }, MarkdownView: { enhance() {} },
    marked: { Marked: class { parse(source) { return source; } }, parse: source => source },
    fetch: async () => ({ ok: true, text: async () => '<h1>Current document</h1>' }),
    EventSource: class { constructor() { watchers.push(this); } close() { this.closed = true; } },
    IntersectionObserver: class { observe() {} disconnect() {} },
    RemoteTasks: { isSelected: () => false }, addEventListener() {}, setTimeout() {}, clearTimeout() {},
  };
  context.window = context; vm.createContext(context);
  const file = remote ? 'public/js/remote-tasks.js' : 'public/js/tasks.js';
  let source = fs.readFileSync(file, 'utf8');
  const marker = remote ? '  return {\n    load,' : '  return {\n    async load()';
  const expose = remote
    ? `_start() { selected = { serverId: 1, task: { id: 7 }, server: { name: 'Remote' } }; activeTab = 'doc'; previewPane.style.display = ''; return renderSelected(); }, _leave() { selected = null; },`
    : `_start() { selectedId = 7; activeTab = 'doc'; previewPane.style.display = ''; return renderPreview({ id: 7, md_path: '/task/DESIGN.md' }); }, _leave(tab = 'shell') { activeTab = tab; previewPane.style.display = tab === 'shell' ? 'none' : ''; hideToc(); },`;
  source = source.replace(marker, marker.replace('  return {\n', `  return {\n    ${expose}\n`));
  vm.runInContext(source, context);
  return { context, document, watchers, errors, controller: remote ? context.RemoteTasks : context.Tasks };
}
test('late Mermaid completion cannot restore outline or watcher after entering terminal', async () => {
  const app = setup(), diagram = deferred(), entered = deferred();
  app.context.fetch = async () => ({ ok: true, text: async () => '<h1>Old outline</h1><div class="mermaid">graph TD</div>' });
  app.context.mermaid.run = () => { entered.resolve(); return diagram.promise; };
  const render = app.controller._start(); await entered.promise;
  app.controller._leave(); diagram.resolve(); await render;
  assert.equal(app.document.getElementById('toc-pane').style.display, 'none');
  assert.equal(app.document.getElementById('toc-list').textContent, '');
  assert.equal(app.watchers.length, 0);
});
test('local response cannot overwrite remote view even when local task/tab are unchanged', async () => {
  const app = setup(), body = deferred();
  app.context.fetch = async () => ({ ok: true, text: () => body.promise });
  const render = app.controller._start(); await Promise.resolve();
  app.context.RemoteTasks.isSelected = () => true;
  app.document.getElementById('preview-content').textContent = 'Remote view';
  body.resolve('<h1>Old local document</h1>'); await render;
  assert.equal(app.document.getElementById('preview-content').textContent, 'Remote view');
  assert.equal(app.watchers.length, 0);
});
test('stale local errors cannot overwrite the newly selected tab', async () => {
  const app = setup(), response = deferred();
  app.context.fetch = () => response.promise;
  const render = app.controller._start(); app.controller._leave('readme');
  app.document.getElementById('preview-content').textContent = 'New README';
  response.reject(new Error('Late network failure')); await render;
  assert.equal(app.document.getElementById('preview-content').textContent, 'New README');
  assert.equal(app.watchers.length, 0);
});
test('current document still renders outline and starts watching', async () => {
  const app = setup(); await app.controller._start();
  assert.equal(app.document.getElementById('toc-pane').style.display, 'flex');
  assert.match(app.document.getElementById('toc-list').textContent, /Current document/);
  assert.equal(app.watchers.length, 1);
  assert.equal(app.errors.length, 0);
});
for (const fails of [false, true]) test(`stale remote ${fails ? 'error' : 'response'} cannot overwrite local view`, async () => {
  const app = setup(true), response = deferred(); app.context.fetch = () => response.promise;
  const render = app.controller._start(); app.controller._leave();
  app.document.getElementById('preview-content').textContent = 'Local view';
  if (fails) response.reject(new Error('Late error'));
  else response.resolve({ ok: true, text: async () => '<h1>Old remote</h1>' });
  await render;
  assert.equal(app.document.getElementById('preview-content').textContent, 'Local view');
});
