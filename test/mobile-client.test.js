const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function start({ route = '/h5', narrow = true } = {}) {
  const classes = new Set(route === '/h5' ? ['h5-client'] : []);
  const elements = new Map();
  function element() {
    return { attributes: {}, listeners: {}, children: [], setAttribute(key, value) { this.attributes[key] = value; }, addEventListener(type, listener) { this.listeners[type] = listener; }, appendChild(child) { this.children.push(child); }, focus() {}, remove() {} };
  }
  const key = element(); key.dataset = { terminalKey: 'interrupt' };
  const body = { dataset: {}, classList: { contains: name => classes.has(name), toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } } };
  const document = { body, createElement: element, getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, querySelectorAll(selector) { return selector === '[data-terminal-key]' ? [key] : []; } };
  const sent = [];
  const media = { matches: narrow, addEventListener() {} };
  const window = { matchMedia: () => media, dispatchEvent() {}, Tasks: { sendTerminalInput: data => sent.push(data) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'mobile.js'), 'utf8'), { window, document, location: { pathname: route }, Event: class {}, MutationObserver: class { observe() {} } });
  return { classes, elements, body, window, key, sent };
}

test('H5 opens the list, then switches to selected task details with touch navigation', () => {
  const app = start();
  assert.equal(app.classes.has('mobile-client'), true);
  assert.equal(app.body.dataset.mobileView, 'tasks');
  app.window.ClientMobile.showDetails('restored task');
  assert.equal(app.body.dataset.mobileView, 'tasks');
  app.window.ClientMobile.finishStartup();
  app.window.ClientMobile.showDetails('selected task');
  assert.equal(app.body.dataset.mobileView, 'details');
  assert.equal(app.elements.get('mobile-task-title').textContent, 'selected task');
  assert.equal(app.elements.get('mobile-show-details').attributes['aria-pressed'], 'true');
  app.elements.get('mobile-show-tasks').listeners.click();
  assert.equal(app.body.dataset.mobileView, 'tasks');
});

test('explicit desktop route stays desktop on phones while root responds to viewport', () => {
  assert.equal(start({ route: '/web' }).classes.has('mobile-client'), false);
  assert.equal(start({ route: '/' }).classes.has('mobile-client'), true);
  assert.equal(start({ route: '/', narrow: false }).classes.has('mobile-client'), false);
  assert.equal(start({ narrow: false }).classes.has('mobile-client'), true);
});

test('mobile terminal shortcut sends control input only to the active controller', () => {
  const app = start();
  app.key.listeners.click();
  assert.deepEqual(app.sent, ['\x03']);
});

test('mobile Markdown editor preserves content and emits changes without Monaco', () => {
  const app = start();
  const host = app.elements.get('task-nav');
  const { editor, model } = app.window.ClientMobile.createDocumentEditor(host, '# 手机文档\n');
  assert.equal(model.getValue(), '# 手机文档\n');
  let changed = false;
  editor.onDidChangeModelContent(() => { changed = true; });
  host.children[0].value = '# 已修改\n';
  host.children[0].listeners.input();
  assert.equal(changed, true);
  assert.equal(model.getValue(), '# 已修改\n');
});
