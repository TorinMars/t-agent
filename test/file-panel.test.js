const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const sourcePath = path.join(__dirname, '..', 'public', 'js', 'file-panel.js');

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function makeMonaco() {
  const models = new Map();
  return {
    Uri: { parse(value) { return { toString: () => value }; } },
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
    editor: {
      getModel(uri) { return models.get(uri.toString()) || null; },
      createModel(value, language, uri) {
        const listeners = new Set();
        let current = value;
        const model = {
          language,
          uri,
          getValue() { return current; },
          setValue(next) { current = next; for (const listener of listeners) listener(); },
          onDidChangeContent(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
          dispose() { models.delete(uri.toString()); },
        };
        models.set(uri.toString(), model);
        return model;
      },
      setModelLanguage(model, language) { model.language = language; },
      create(host, options) {
        const instance = {
          host,
          model: options.model,
          options: { ...options },
          setModel(model) { this.model = model; },
          getModel() { return this.model; },
          updateOptions(next) { Object.assign(this.options, next); },
          addCommand(key, handler) { this.saveCommand = { key, handler }; },
          focus() {},
          layout() {},
          dispose() {},
        };
        this.lastEditor = instance;
        return instance;
      },
    },
  };
}

function setup(fetchImpl) {
  const { window, document } = parseHTML('<html><body><div class="content-area"><div class="content-toolbar"></div><div class="content-tabs"></div><div class="content-body"></div></div></body></html>');
  const storage = new Map();
  const monaco = makeMonaco();
  window.monaco = monaco;
  window.localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
  };
  window.fetch = fetchImpl;
  window.requestAnimationFrame = (fn) => fn();
  window.ResizeObserver = class { observe() {} disconnect() {} };
  window.alert = () => {};
  const context = vm.createContext({
    window,
    document,
    localStorage: window.localStorage,
    fetch: fetchImpl,
    monaco,
    CustomEvent: window.CustomEvent,
    Event: window.Event,
    AbortController,
    URLSearchParams,
    requestAnimationFrame: window.requestAnimationFrame,
    ResizeObserver: window.ResizeObserver,
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context);
  return { window, document, monaco };
}

test('open mounts a docked panel and loads the first tree page without hidden files', async () => {
  const calls = [];
  const { window, document } = setup(async (url, options = {}) => {
    calls.push({ url, options });
    return response(200, {
      entries: [
        { name: 'src', path: 'src', type: 'directory' },
        { name: 'README.md', path: 'README.md', type: 'file' },
      ],
      nextOffset: null,
      root: '/workspace/demo',
      writable: true,
    });
  });

  await window.FilePanel.open({ key: 'local:7', baseUrl: '/api/tasks/7/files', title: '示例任务' });

  assert.equal(window.FilePanel.isOpen(), true);
  assert.ok(document.querySelector('.content-area').classList.contains('file-panel-open'));
  assert.equal(document.querySelector('#file-panel').dataset.ratio, '85');
  assert.equal(document.querySelector('#file-panel-title').textContent, '示例任务');
  assert.equal(document.querySelector('#file-panel-root').textContent, '/workspace/demo');
  assert.equal(document.querySelectorAll('#file-panel-tree .file-tree-row').length, 2);
  assert.equal(calls[0].url, '/api/tasks/7/files?path=&offset=0&hidden=false');
  assert.equal(calls[0].options.headers['X-Requested-With'], 'XMLHttpRequest');
});

test('a stale tree response cannot replace the newly opened task state', async () => {
  let resolveFirst;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  const { window, document } = setup(async (url) => {
    if (url.startsWith('/old/')) return first;
    return response(200, {
      entries: [{ name: 'new.txt', path: 'new.txt', type: 'file' }],
      nextOffset: null,
      root: '/new-root',
      writable: true,
    });
  });

  const oldOpen = window.FilePanel.open({ key: 'old', baseUrl: '/old/files', title: '旧任务' });
  await window.FilePanel.open({ key: 'new', baseUrl: '/new/files', title: '新任务' });
  resolveFirst(response(200, {
    entries: [{ name: 'old.txt', path: 'old.txt', type: 'file' }],
    nextOffset: null,
    root: '/old-root',
    writable: true,
  }));
  await oldOpen;

  assert.equal(document.querySelector('#file-panel-title').textContent, '新任务');
  assert.equal(document.querySelector('#file-panel-root').textContent, '/new-root');
  assert.equal(document.querySelector('#file-panel-tree').textContent.includes('old.txt'), false);
  assert.equal(document.querySelector('#file-panel-tree').textContent.includes('new.txt'), true);
});

test('opening and saving a file keeps revision metadata and emits a saved event', async () => {
  const writes = [];
  const { window, document, monaco } = setup(async (url, options = {}) => {
    if (url.includes('/content') && options.method === 'PUT') {
      writes.push(JSON.parse(options.body));
      return response(200, { path: 'src/app.js', content: 'const n = 2;\n', revision: 'r2', eol: 'lf', bom: false });
    }
    if (url.includes('/content')) {
      return response(200, { path: 'src/app.js', content: 'const n = 1;\n', revision: 'r1', eol: 'lf', bom: false });
    }
    return response(200, {
      entries: [{ name: 'app.js', path: 'src/app.js', type: 'file' }],
      nextOffset: null,
      root: '/workspace',
      writable: true,
    });
  });
  let saved;
  document.querySelector('.content-area').addEventListener('file-panel:saved', event => { saved = event.detail; });
  await window.FilePanel.open({ key: 'task', baseUrl: '/files', title: '任务' });
  document.querySelector('[data-path="src/app.js"]').click();
  await new Promise(resolve => setImmediate(resolve));
  const model = monaco.editor.getModel(monaco.Uri.parse('inmemory://file-panel/task/src/app.js'));
  assert.equal(model.language, 'javascript');
  assert.equal(document.querySelector('#file-panel-editor').style.display, 'block');
  model.setValue('const n = 2;\n');
  document.querySelector('#file-panel-save').click();
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(writes, [{ path: 'src/app.js', content: 'const n = 2;\n', revision: 'r1' }]);
  assert.equal(document.querySelector('.file-editor-tab.is-dirty'), null);
  assert.equal(saved.path, 'src/app.js');
  assert.equal(saved.contextKey, 'task');
});

test('beforeContextChange offers save, discard and cancel and only closes when resolved', async () => {
  const { window, document, monaco } = setup(async (url) => {
    if (url.includes('/content')) return response(200, { path: 'note.txt', content: 'old', revision: '1', eol: 'lf', bom: false });
    return response(200, {
      entries: [{ name: 'note.txt', path: 'note.txt', type: 'file' }],
      nextOffset: null,
      root: '/workspace',
      writable: true,
    });
  });
  await window.FilePanel.open({ key: 'task', baseUrl: '/files', title: '任务' });
  document.querySelector('[data-path="note.txt"]').click();
  await new Promise(resolve => setImmediate(resolve));
  monaco.editor.getModel(monaco.Uri.parse('inmemory://file-panel/task/note.txt')).setValue('draft');

  const guarded = window.FilePanel.beforeContextChange();
  assert.equal(document.querySelector('#file-panel-dirty-dialog').hidden, false);
  document.querySelector('[data-dialog-action="cancel"]').click();
  assert.equal(await guarded, false);
  assert.equal(window.FilePanel.isOpen(), true);

  const discard = window.FilePanel.beforeContextChange();
  document.querySelector('[data-dialog-action="discard"]').click();
  assert.equal(await discard, true);
  assert.equal(window.FilePanel.isOpen(), false);
});

test('conflict keeps the draft and requires an explicit reload or force save', async () => {
  let putCount = 0;
  const { window, document, monaco } = setup(async (url, options = {}) => {
    if (url.includes('/content') && options.method === 'PUT') {
      putCount += 1;
      if (putCount === 1) return response(409, { error: 'FILE_CONFLICT' });
      const body = JSON.parse(options.body);
      assert.equal(body.force, true);
      return response(200, { path: 'a.md', content: body.content, revision: '3', eol: 'lf', bom: false });
    }
    if (url.includes('/content')) return response(200, { path: 'a.md', content: '# old', revision: '1', eol: 'lf', bom: false });
    return response(200, { entries: [{ name: 'a.md', path: 'a.md', type: 'file' }], nextOffset: null, root: '/w', writable: true });
  });
  await window.FilePanel.open({ key: 'task', baseUrl: '/files', title: '任务' });
  document.querySelector('[data-path="a.md"]').click();
  await new Promise(resolve => setImmediate(resolve));
  const model = monaco.editor.getModel(monaco.Uri.parse('inmemory://file-panel/task/a.md'));
  model.setValue('# draft');
  document.querySelector('#file-panel-save').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(model.getValue(), '# draft');
  assert.equal(document.querySelector('#file-panel-conflict-dialog').hidden, false);
  document.querySelector('[data-conflict-action="force"]').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(putCount, 2);
  assert.equal(document.querySelector('.file-editor-tab.is-dirty'), null);
});

test('renaming a directory rewrites open tabs and cached descendant tree paths', async () => {
  let didRename = false;
  const { window, document } = setup(async (url, options = {}) => {
    if (options.method === 'PATCH') {
      didRename = true;
      return response(200, { path: 'lib' });
    }
    if (url.includes('/content')) return response(200, { path: 'src/app.js', content: 'old', revision: '1', eol: 'lf', bom: false });
    const query = new URL(`http://test${url}`).searchParams;
    if (query.get('path') === 'src') {
      return response(200, { entries: [{ name: 'app.js', path: 'src/app.js', type: 'file' }], nextOffset: null, root: '/w', writable: true });
    }
    if (query.get('path') === '') {
      return response(200, { entries: [{ name: didRename ? 'lib' : 'src', path: didRename ? 'lib' : 'src', type: 'directory' }], nextOffset: null, root: '/w', writable: true });
    }
    return response(200, { entries: [], nextOffset: null, root: '/w', writable: true });
  });
  await window.FilePanel.open({ key: 'task', baseUrl: '/files', title: '任务' });
  document.querySelector('[data-path="src"]').click();
  await new Promise(resolve => setImmediate(resolve));
  document.querySelector('[data-path="src/app.js"]').click();
  await new Promise(resolve => setImmediate(resolve));
  document.querySelector('[data-path="src"]').click();
  document.querySelector('#file-panel-rename').click();
  const input = document.querySelector('#file-dialog-name');
  input.value = 'lib';
  input.closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(document.querySelector('[data-tab-path="lib/app.js"]') !== null, true);
  assert.equal(document.querySelector('[data-tab-path="src/app.js"]') === null, true);
  document.querySelector('[data-path="lib"]').click();
  assert.equal(document.querySelector('[data-path="src/app.js"]') === null, true);
  assert.equal(document.querySelector('[data-path="lib/app.js"]') !== null, true);
});

test('typing during an in-flight save preserves the newer draft and blocks context change', async () => {
  let resolveSave;
  let contentReads = 0;
  const saveResponse = new Promise(resolve => { resolveSave = resolve; });
  const { window, document, monaco } = setup(async (url, options = {}) => {
    if (url.includes('/content') && options.method === 'PUT') return saveResponse;
    if (url.includes('/content')) {
      contentReads += 1;
      return response(200, { path: 'note.txt', content: 'one', revision: '1', eol: 'lf', bom: false });
    }
    return response(200, { entries: [{ name: 'note.txt', path: 'note.txt', type: 'file' }], nextOffset: null, root: '/w', writable: true });
  });
  await window.FilePanel.open({ key: 'task', baseUrl: '/files', title: '任务' });
  const row = document.querySelector('[data-path="note.txt"]');
  row.click();
  row.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(contentReads, 1);
  const model = monaco.editor.getModel(monaco.Uri.parse('inmemory://file-panel/task/note.txt'));
  model.setValue('two');
  document.querySelector('#file-panel-save').click();
  model.setValue('three');

  const guarded = window.FilePanel.beforeContextChange();
  document.querySelector('[data-dialog-action="save"]').click();
  resolveSave(response(200, { path: 'note.txt', content: 'two', revision: '2', eol: 'lf', bom: false }));

  assert.equal(await guarded, false);
  assert.equal(window.FilePanel.isOpen(), true);
  assert.equal(model.getValue(), 'three');
  assert.equal(document.querySelector('.file-editor-tab.is-dirty') !== null, true);
});

test('read-only roots configure Monaco as read-only and keyboard save never writes', async () => {
  let writes = 0;
  const { window, document, monaco } = setup(async (url, options = {}) => {
    if (options.method === 'PUT') {
      writes += 1;
      return response(200, {});
    }
    if (url.includes('/content')) return response(200, { path: 'readme.txt', content: 'read only', revision: '1', eol: 'lf', bom: false });
    return response(200, { entries: [{ name: 'readme.txt', path: 'readme.txt', type: 'file' }], nextOffset: null, root: '/readonly', writable: false });
  });
  await window.FilePanel.open({ key: 'readonly', baseUrl: '/files', title: '只读任务' });
  document.querySelector('[data-path="readme.txt"]').click();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(monaco.editor.lastEditor.options.readOnly, true);
  monaco.editor.lastEditor.model.setValue('attempted change');
  await monaco.editor.lastEditor.saveCommand.handler();
  assert.equal(writes, 0);
});

test('a delayed delete from an old context cannot close a new context tab', async () => {
  let resolveDelete;
  const pendingDelete = new Promise(resolve => { resolveDelete = resolve; });
  const { window, document } = setup(async (url, options = {}) => {
    if (options.method === 'DELETE') return pendingDelete;
    if (url.includes('/content')) return response(200, { path: 'same.txt', content: url.startsWith('/a/') ? 'A' : 'B', revision: '1', eol: 'lf', bom: false });
    return response(200, { entries: [{ name: 'same.txt', path: 'same.txt', type: 'file' }], nextOffset: null, root: url.startsWith('/a/') ? '/a' : '/b', writable: true });
  });
  await window.FilePanel.open({ key: 'a', baseUrl: '/a/files', title: 'A' });
  document.querySelector('[data-path="same.txt"]').click();
  await new Promise(resolve => setImmediate(resolve));
  document.querySelector('#file-panel-delete').click();
  document.querySelector('[data-delete-action="confirm"]').click();

  assert.equal(await window.FilePanel.beforeContextChange(), true);
  await window.FilePanel.open({ key: 'b', baseUrl: '/b/files', title: 'B' });
  document.querySelector('[data-path="same.txt"]').click();
  await new Promise(resolve => setImmediate(resolve));
  resolveDelete(response(200, { success: true }));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(document.querySelector('[data-tab-path="same.txt"]') !== null, true);
  assert.equal(document.querySelector('#file-panel-title').textContent, 'B');
});

test('pointerdown inside the tree context menu does not hide it before the action click', async () => {
  const { window, document } = setup(async () => response(200, {
    entries: [{ name: 'a.txt', path: 'a.txt', type: 'file' }], nextOffset: null, root: '/w', writable: true,
  }));
  await window.FilePanel.open({ key: 'task', baseUrl: '/files', title: '任务' });
  const menuEvent = new window.Event('contextmenu', { bubbles: true, cancelable: true });
  menuEvent.clientX = 20;
  menuEvent.clientY = 30;
  document.querySelector('[data-path="a.txt"]').dispatchEvent(menuEvent);
  const menu = document.querySelector('#file-panel-context-menu');
  const action = menu.querySelector('[data-menu-action="rename"]');
  action.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  assert.equal(menu.hidden, false);
});

test('rename refuses an open-tab destination collision without losing its dirty draft', async () => {
  let patches = 0;
  const { window, document, monaco } = setup(async (url, options = {}) => {
    if (options.method === 'PATCH') {
      patches += 1;
      return response(200, { path: 'b.txt' });
    }
    if (url.includes('/content')) {
      const filePath = new URL(`http://test${url}`).searchParams.get('path');
      return response(200, { path: filePath, content: filePath, revision: '1', eol: 'lf', bom: false });
    }
    return response(200, { entries: [{ name: 'a.txt', path: 'a.txt', type: 'file' }, { name: 'b.txt', path: 'b.txt', type: 'file' }], nextOffset: null, root: '/w', writable: true });
  });
  await window.FilePanel.open({ key: 'task', baseUrl: '/files', title: '任务' });
  document.querySelector('[data-path="b.txt"]').click();
  await new Promise(resolve => setImmediate(resolve));
  const bModel = monaco.editor.getModel(monaco.Uri.parse('inmemory://file-panel/task/b.txt'));
  bModel.setValue('dirty b');
  document.querySelector('[data-path="a.txt"]').click();
  await new Promise(resolve => setImmediate(resolve));
  document.querySelector('[data-path="a.txt"]').click();
  document.querySelector('#file-panel-rename').click();
  const input = document.querySelector('#file-dialog-name');
  input.value = 'b.txt';
  input.closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(patches, 0);
  assert.equal(bModel.getValue(), 'dirty b');
  assert.equal(document.querySelector('[data-tab-path="b.txt"].is-dirty') !== null, true);
  assert.match(document.querySelector('.file-dialog-error').textContent, /关闭.*b\.txt/);
});

test('context change rechecks all tabs after waiting for save-and-continue', async () => {
  let resolveSave;
  const saveResponse = new Promise(resolve => { resolveSave = resolve; });
  const { window, document, monaco } = setup(async (url, options = {}) => {
    if (options.method === 'PUT') return saveResponse;
    if (url.includes('/content')) {
      const filePath = new URL(`http://test${url}`).searchParams.get('path');
      return response(200, { path: filePath, content: filePath, revision: '1', eol: 'lf', bom: false });
    }
    return response(200, { entries: [{ name: 'a.txt', path: 'a.txt', type: 'file' }, { name: 'b.txt', path: 'b.txt', type: 'file' }], nextOffset: null, root: '/w', writable: true });
  });
  await window.FilePanel.open({ key: 'task', baseUrl: '/files', title: '任务' });
  document.querySelector('[data-path="a.txt"]').click();
  await new Promise(resolve => setImmediate(resolve));
  document.querySelector('[data-path="b.txt"]').click();
  await new Promise(resolve => setImmediate(resolve));
  const aModel = monaco.editor.getModel(monaco.Uri.parse('inmemory://file-panel/task/a.txt'));
  const bModel = monaco.editor.getModel(monaco.Uri.parse('inmemory://file-panel/task/b.txt'));
  aModel.setValue('dirty a');
  document.querySelector('[data-tab-path="a.txt"] .file-tab-select').click();
  const guarded = window.FilePanel.beforeContextChange();
  document.querySelector('[data-dialog-action="save"]').click();
  document.querySelector('[data-tab-path="b.txt"] .file-tab-select').click();
  bModel.setValue('dirty b');
  resolveSave(response(200, { path: 'a.txt', content: 'dirty a', revision: '2', eol: 'lf', bom: false }));

  assert.equal(await guarded, false);
  assert.equal(window.FilePanel.isOpen(), true);
  assert.equal(bModel.getValue(), 'dirty b');
});

test('tab close keeps newer edits typed while save-and-continue is pending', async () => {
  let resolveSave;
  const saveResponse = new Promise(resolve => { resolveSave = resolve; });
  const { window, document, monaco } = setup(async (url, options = {}) => {
    if (options.method === 'PUT') return saveResponse;
    if (url.includes('/content')) return response(200, { path: 'a.txt', content: 'one', revision: '1', eol: 'lf', bom: false });
    return response(200, { entries: [{ name: 'a.txt', path: 'a.txt', type: 'file' }], nextOffset: null, root: '/w', writable: true });
  });
  await window.FilePanel.open({ key: 'task', baseUrl: '/files', title: '任务' });
  document.querySelector('[data-path="a.txt"]').click();
  await new Promise(resolve => setImmediate(resolve));
  const model = monaco.editor.getModel(monaco.Uri.parse('inmemory://file-panel/task/a.txt'));
  model.setValue('two');
  document.querySelector('.file-tab-close').click();
  document.querySelector('[data-dialog-action="save"]').click();
  await Promise.resolve();
  model.setValue('three');
  resolveSave(response(200, { path: 'a.txt', content: 'two', revision: '2', eol: 'lf', bom: false }));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(document.querySelector('[data-tab-path="a.txt"]') !== null, true);
  assert.equal(document.querySelector('[data-tab-path="a.txt"].is-dirty') !== null, true);
  assert.equal(model.getValue(), 'three');
});

test('tab close discards a dirty draft when discard is explicitly chosen', async () => {
  const { window, document, monaco } = setup(async (url) => {
    if (url.includes('/content')) return response(200, { path: 'a.txt', content: 'one', revision: '1', eol: 'lf', bom: false });
    return response(200, { entries: [{ name: 'a.txt', path: 'a.txt', type: 'file' }], nextOffset: null, root: '/w', writable: true });
  });
  await window.FilePanel.open({ key: 'task', baseUrl: '/files', title: '任务' });
  document.querySelector('[data-path="a.txt"]').click();
  await new Promise(resolve => setImmediate(resolve));
  monaco.editor.getModel(monaco.Uri.parse('inmemory://file-panel/task/a.txt')).setValue('dirty');
  document.querySelector('.file-tab-close').click();
  document.querySelector('[data-dialog-action="discard"]').click();
  await Promise.resolve();

  assert.equal(document.querySelector('[data-tab-path="a.txt"]') === null, true);
  assert.equal(window.FilePanel.isOpen(), true);
});
