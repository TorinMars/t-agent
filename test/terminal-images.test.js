const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
function setup() {
  const { document, Event } = parseHTML('<html><body><main id="app"></main><div id="terminal-pane"><div id="xterm-container"><div id="host"></div></div></div><div id="modal-body"></div></body></html>');
  const listeners = new Map(); const requests = []; const sent = []; const notices = [];
  const window = { addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type) { listeners.delete(type); } };
  class XHR {
    constructor() { this.upload = {}; requests.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader() {}
    send(file) { this.file = file; }
    finish(status, body) { this.status = status; this.responseText = JSON.stringify(body); this.onload(); }
  }
  let config = { enabled: true, region: 'oss-cn-hangzhou', bucket: 'images', accessKeyId: 'id', hasAccessKeySecret: true, prefix: 'terminal/', publicBaseUrl: '' };
  const puts = [];
  const context = vm.createContext({ document, window, Event, URL, XMLHttpRequest: XHR, MutationObserver: class { observe() {} }, API: { async get() { return config; }, async put(path, value) { puts.push(value); return { ...value, hasAccessKeySecret: true }; }, async delete() { return { enabled: false }; } }, Modal: { show(title, html) { document.getElementById('modal-body').innerHTML = html; }, hide() {} }, escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'), alert: value => notices.push(value) });
  const path = require('node:path').join(__dirname, '../public/js/terminal-images.js');
  if (fs.existsSync(path)) vm.runInContext(fs.readFileSync(path, 'utf8') + '\nthis.images = TerminalImages;', context);
  assert.ok(context.images, 'terminal image controller exists');
  const socket = { readyState: 1, send(value) { sent.push(value); } };
  const term = { options: {}, paste(value) { socket.send(value); }, focus() {} };
  let current = socket;
  const handle = context.images.attach(term, document.getElementById('host'), () => current);
  const paste = (types = ['image/png']) => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    event.clipboardData = { items: types.map(type => ({ type, kind: 'file', getAsFile: () => ({ type, size: 123 }) })) };
    document.getElementById('host').dispatchEvent(event); return event;
  };
  return { context, document, Event, listeners, requests, sent, term, socket, handle, paste, puts, notices, switchSocket: () => { current = { readyState: 1 }; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('image paste locks the whole page, reports transfer then processing, and inserts URL without Enter', async () => {
  const s = setup(); await s.context.images.load();
  assert.equal(s.paste().defaultPrevented, true);
  assert.equal(s.requests.length, 1);
  assert.equal(s.term.options.disableStdin, true);
  assert.equal(s.document.getElementById('app').inert, true);
  const key = { preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} };
  s.listeners.get('keydown')(key); assert.equal(key.prevented, true);
  const xhr = s.requests[0]; xhr.upload.onprogress({ lengthComputable: true, loaded: 50, total: 100 });
  assert.equal(s.document.querySelector('progress').value, 50);
  xhr.upload.onload();
  assert.match(s.document.querySelector('.terminal-image-upload-status').textContent, /OSS/);
  assert.deepEqual(s.sent, []);
  xhr.finish(200, { url: 'https://images.example/a.png', expiresAt: null }); await tick();
  assert.deepEqual(s.sent, ['https://images.example/a.png']);
  assert.equal(s.document.querySelector('.terminal-image-upload-overlay'), null);
  assert.equal(Boolean(s.term.options.disableStdin), false);
  assert.equal(Boolean(s.document.getElementById('app').inert), false);
  assert.equal(s.listeners.size, 0);
});
test('ordinary text paste passes through, invalid image is stopped without upload, failures unlock', async () => {
  const s = setup(); await s.context.images.load();
  assert.equal(s.paste(['text/plain']).defaultPrevented, false);
  assert.equal(s.paste(['image/svg+xml']).defaultPrevented, true);
  assert.equal(s.requests.length, 0);
  s.paste(); s.requests[0].onerror(); await tick();
  assert.equal(s.document.querySelector('.terminal-image-upload-overlay'), null);
  assert.equal(s.listeners.size, 0); assert.equal(s.sent.length, 0);
});
test('reconnection or disposal during upload retains the result for manual copy and never sends it', async () => {
  for (const change of [s => s.switchSocket(), s => s.handle.dispose(), s => { s.document.getElementById('host').style.display = 'none'; }]) {
    const s = setup(); await s.context.images.load(); s.paste(); change(s);
    s.requests[0].finish(200, { url: 'https://images.example/saved.png' }); await tick();
    assert.deepEqual(s.sent, []);
    assert.equal(s.document.querySelector('.terminal-image-result input').value, 'https://images.example/saved.png');
  }
});
test('settings prefill public fields, never prefill secret, blank secret is preserved in update contract', async () => {
  const s = setup(); await s.context.images.showSettings();
  assert.equal(s.document.getElementById('oss-bucket').value, 'images');
  assert.equal(s.document.getElementById('oss-accessKeySecret').value, '');
  s.document.getElementById('oss-save').click(); await tick();
  assert.equal(s.puts.length, 1); assert.equal(s.puts[0].accessKeySecret, '');
  assert.equal(s.puts[0].bucket, 'images');
});

test('timeout and malformed success unlock the page without inserting terminal input', async () => {
  for (const fail of [xhr => xhr.ontimeout(), xhr => xhr.finish(200, { url: 'https://example.com/a\ncommand' }), xhr => xhr.finish(200, { url: 'javascript:alert(1)' })]) {
    const s = setup(); await s.context.images.load(); s.paste(); fail(s.requests[0]); await tick();
    assert.equal(s.document.querySelector('.terminal-image-upload-overlay'), null);
    assert.equal(s.listeners.size, 0); assert.deepEqual(s.sent, []);
    assert.equal(s.notices.length, 1);
  }
});
