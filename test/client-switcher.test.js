const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const { normalizeAddress, readState, STORAGE_KEY } = require('../public/js/clients');

const root = path.resolve(__dirname, '..');

function start(saved = null, storageBlocked = false) {
  const { document, window } = parseHTML(fs.readFileSync(path.join(root, 'public/clients.html'), 'utf8'));
  const storage = new Map(saved === null ? [] : [[STORAGE_KEY, saved]]);
  const timers = new Map();
  const listeners = new Map();
  let timerId = 0;
  const dialog = document.getElementById('client-dialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new window.Event('close')); };
  // linkedom doesn't create browsing contexts; use distinct window identities.
  const create = document.createElement.bind(document);
  document.createElement = tag => {
    const element = create(tag);
    if (tag === 'iframe') element.contentWindow = {};
    return element;
  };
  const context = {
    document, URL, location: { protocol: 'https:', origin: 'https://hub.example.com' },
    localStorage: {
      getItem(key) { if (storageBlocked) throw new Error('blocked'); return storage.get(key) ?? null; },
      setItem(key, value) { if (storageBlocked) throw new Error('blocked'); storage.set(key, value); },
    },
    window: { addEventListener: (type, handler) => listeners.set(type, handler), crypto: { randomUUID: () => `id-${++timerId}` } },
    confirm: () => true,
    setTimeout(handler) { const id = ++timerId; timers.set(id, handler); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/js/clients.js'), 'utf8'), context);
  const el = id => document.getElementById(id);
  function save(name, address) {
    el('client-name').value = name;
    el('client-url').value = address;
    el('client-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  }
  return { document, el, save, storage, timers, listeners, frames: () => [...document.querySelectorAll('iframe')], tabs: () => [...el('client-tabs').children] };
}

test('addresses accept host:port and /web but reject credentials, scripts, paths and mixed content', () => {
  assert.equal(normalizeAddress('  EXAMPLE.com:3100/web  '), 'https://example.com:3100');
  assert.equal(normalizeAddress('http://[::1]:3000/', 'http:'), 'http://[::1]:3000');
  assert.equal(normalizeAddress('//agent.example.com'), 'https://agent.example.com');
  for (const value of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/test', 'ftp://example.com', 'https://user:pass@example.com', 'https://example.com/task/1', 'https://example.com/?token=secret', 'https://example.com/#x', 'https://ex ample.com', 'https://example.com\\@other.test']) {
    assert.throws(() => normalizeAddress(value), undefined, value);
  }
  assert.throws(() => normalizeAddress('http://agent.example.com'), /HTTPS/);
});

test('saved configuration recovers from invalid entries, duplicates and a missing selected Client', () => {
  const state = readState(JSON.stringify({ version: 1, selectedId: 'missing', clients: [
    { id: 'one', name: 'One', address: 'https://one.example.com' },
    { id: 'bad', name: 'Bad', address: 'javascript:alert(1)' },
    { id: 'two', name: 'Duplicate', address: 'https://one.example.com/web' },
    { id: 'one', name: 'Duplicate ID', address: 'https://two.example.com' },
  ] }), 'https:');
  assert.deepEqual(state, { clients: [{ id: 'one', name: 'One', address: 'https://one.example.com' }], selectedId: 'one' });
  assert.deepEqual(readState('{invalid', 'https:'), { clients: [], selectedId: null });
});

test('switching preserves frames, edits prefill and rename retains state; reload only replaces active frame', () => {
  const app = start();
  const localFrame = app.frames()[0];
  app.el('add-client').click();
  app.save('<img src=x onerror=alert(1)>', 'https://second.example.com/web');
  assert.equal(app.frames().length, 2);
  assert.equal(app.tabs()[1].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(app.tabs()[1].querySelector('img'), null);
  const secondFrame = app.frames()[1];
  app.tabs()[0].click();
  assert.equal(app.frames()[0], localFrame);
  assert.equal(secondFrame.hidden, true);
  app.tabs()[1].click();
  assert.equal(app.frames()[1], secondFrame);
  app.el('client-edit').click();
  assert.equal(app.el('client-url').value, 'https://second.example.com');
  app.save('Work', 'https://second.example.com');
  assert.equal(app.frames()[1], secondFrame);
  assert.equal(secondFrame.title, 'Work');
  const stored = JSON.parse(app.storage.get(STORAGE_KEY));
  const restored = start(JSON.stringify(stored));
  assert.equal(restored.frames().length, 1, 'restore only opens the selected Client');
  assert.equal(restored.frames()[0].src, 'https://second.example.com/web');
  app.el('client-reload').click();
  assert.equal(app.frames()[0], localFrame);
  assert.notEqual(app.frames()[1], secondFrame);
  app.el('client-edit').click();
  app.save('Work', 'https://changed.example.com');
  assert.equal(app.frames()[1].src, 'https://changed.example.com/web');
  app.el('client-remove').click();
  assert.equal(app.frames().length, 1);
  assert.equal(app.frames()[0], localFrame);
  assert.equal(localFrame.hidden, false);
  app.el('client-remove').click();
  assert.equal(app.el('hub-empty').hidden, false);
  const emptyRestored = start(app.storage.get(STORAGE_KEY));
  assert.equal(emptyRestored.frames().length, 0, 'removing all Clients stays empty after reload');
});

test('duplicate addresses leave configuration intact and blocked storage still allows switching', () => {
  const app = start();
  app.el('add-client').click();
  app.save('duplicate', 'https://hub.example.com/web');
  assert.match(app.el('client-form-error').textContent, /已经添加/);
  assert.equal(app.tabs().length, 1);
  const blocked = start(null, true);
  blocked.el('add-client').click();
  blocked.save('Work', 'https://second.example.com');
  assert.equal(blocked.tabs().length, 2);
  assert.match(blocked.el('hub-notice').textContent, /无法保存/);
});

test('load confirmation accepts only the selected frame origin and window; timeout is not treated as success', () => {
  const app = start();
  const frame = app.frames()[0];
  const receive = app.listeners.get('message');
  const data = { type: 't-agent:client-frame', status: 'ready' };
  receive({ origin: 'https://evil.example.com', source: frame.contentWindow, data });
  receive({ origin: 'https://hub.example.com', source: {}, data });
  assert.equal(app.el('client-status').textContent, '正在载入…');
  for (const callback of app.timers.values()) callback();
  assert.equal(app.el('client-status').textContent, '等待页面响应');
  receive({ origin: 'https://hub.example.com', source: frame.contentWindow, data: { ...data, status: 'auth-required' } });
  assert.equal(app.el('client-status').textContent, '需要登录');
  assert.match(app.el('hub-notice').textContent, /打开并登录/);
  receive({ origin: 'https://hub.example.com', source: frame.contentWindow, data });
  assert.equal(app.el('client-status').textContent, '页面已载入');
  assert.equal(app.el('hub-notice').hidden, true);
});
