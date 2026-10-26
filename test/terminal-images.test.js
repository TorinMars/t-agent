const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
function setup() {
  const { document, Event } = parseHTML('<html><body><main id="app"></main><div id="terminal-pane"><div id="terminal-keys"></div><div id="xterm-container"><div id="host"></div></div></div><div id="modal-body"></div></body></html>');
  const listeners = new Map(); const requests = []; const sent = []; const notices = [];
  const window = { addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type) { listeners.delete(type); } };
  // The controller hands the file to the shared direct-to-OSS uploader (oss-direct.js, tested in a browser); the test settles each upload by hand.
  const OssDirect = { upload(file, ui) { return new Promise((resolve, reject) => requests.push({ file, ui, resolve, reject })); } };
  let config = { enabled: true, region: 'oss-cn-hangzhou', bucket: 'images', accessKeyId: 'id', hasAccessKeySecret: true, prefix: 'terminal/', publicBaseUrl: '' };
  const puts = [];
  const context = vm.createContext({ document, window, Event, URL, setTimeout, clearTimeout, OssDirect, MutationObserver: class { observe() {} }, API: { async get() { return config; }, async put(path, value) { puts.push(value); return { ...value, hasAccessKeySecret: true }; }, async delete() { return { enabled: false }; } }, Modal: { show(title, html) { document.getElementById('modal-body').innerHTML = html; }, hide() {} }, escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'), alert: value => notices.push(value) });
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
test('image paste locks the whole page, shows the uploader’s progress and status, and inserts the URL without Enter', async () => {
  const s = setup(); await s.context.images.load();
  assert.equal(s.paste().defaultPrevented, true);
  assert.equal(s.requests.length, 1);
  assert.equal(s.term.options.disableStdin, true);
  assert.equal(s.document.getElementById('app').inert, true);
  const key = { preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} };
  s.listeners.get('keydown')(key); assert.equal(key.prevented, true);
  const upload = s.requests[0];
  assert.equal(upload.file.type, 'image/png');
  upload.ui.progress(50); upload.ui.status('Uploading image to OSS: 50%');
  assert.equal(s.document.querySelector('progress').value, 50);
  assert.match(s.document.querySelector('.terminal-image-upload-status').textContent, /50%/);
  upload.ui.progress(null); upload.ui.status('OSS is processing the image…');
  assert.match(s.document.querySelector('.terminal-image-upload-status').textContent, /OSS/);
  assert.equal(s.document.querySelector('progress').hasAttribute('value'), false);
  assert.deepEqual(s.sent, []);
  upload.resolve({ url: 'https://images.example/a.png', expiresAt: null }); await tick();
  assert.deepEqual(s.sent, ['https://images.example/a.png ']); // add a space after the link, no Enter
  assert.equal(s.document.querySelector('.terminal-image-upload-overlay'), null);
  assert.equal(Boolean(s.term.options.disableStdin), false);
  assert.equal(Boolean(s.document.getElementById('app').inert), false);
  assert.equal([...s.listeners.keys()].filter(key => !['focus', 'pageshow'].includes(key)).length, 0);
});
test('ordinary text paste passes through, invalid image is stopped without upload, failures unlock', async () => {
  const s = setup(); await s.context.images.load();
  assert.equal(s.paste(['text/plain']).defaultPrevented, false);
  assert.equal(s.paste(['image/svg+xml']).defaultPrevented, true);
  assert.equal(s.requests.length, 0);
  s.paste(); s.requests[0].reject(new Error('Image upload failed')); await tick();
  assert.equal(s.document.querySelector('.terminal-image-upload-overlay'), null);
  assert.equal([...s.listeners.keys()].filter(key => !['focus', 'pageshow'].includes(key)).length, 0); assert.equal(s.sent.length, 0);
});
test('reconnection or disposal during upload retains the result for manual copy and never sends it', async () => {
  for (const change of [s => s.switchSocket(), s => s.handle.dispose(), s => { s.document.getElementById('host').style.display = 'none'; }]) {
    const s = setup(); await s.context.images.load(); s.paste(); change(s);
    s.requests[0].resolve({ url: 'https://images.example/saved.png' }); await tick();
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

test('every upload failure unlocks the page without inserting terminal input and tells the person why', async () => {
  for (const message of ['Image upload timed out. Please retry', 'Upload failed: the server returned an invalid upload policy', 'OSS rejected the upload (AccessDenied). Check the bucket permissions and the AccessKey']) {
    const s = setup(); await s.context.images.load(); s.paste(); s.requests[0].reject(new Error(message)); await tick();
    assert.deepEqual(s.notices, [message]);
    assert.equal(s.document.querySelector('.terminal-image-upload-overlay'), null);
    assert.equal([...s.listeners.keys()].filter(key => !['focus', 'pageshow'].includes(key)).length, 0); assert.deepEqual(s.sent, []);
  }
});


test('upload entry remains available and paste retries configuration after startup failure', async () => {
  const s = setup();
  s.context.API.get = async () => { throw new Error('offline'); };
  await assert.rejects(s.context.images.load(), /offline/);
  assert.equal(s.document.querySelector('#terminal-keys .terminal-image-upload').hidden, false);
  s.context.API.get = async () => ({ enabled: true });
  s.paste(); await tick();
  assert.equal(s.requests.length, 1);
  assert.equal(s.notices.length, 0);
  s.requests[0].resolve({ url: 'https://images.example/retried.png' }); await tick();
  assert.deepEqual(s.sent, ['https://images.example/retried.png ']);
});
test('returning to an installed window refreshes config saved in another window', async () => {
  const s = setup(); s.context.API.get = async () => ({ enabled: false });
  await s.context.images.load();
  s.context.API.get = async () => ({ enabled: true });
  s.listeners.get('focus')(); await tick();
  s.paste(); assert.equal(s.requests.length, 1);
  s.requests[0].reject(new Error('Image upload failed')); await tick();
});
test('configuration read errors are not reported as missing settings and always unlock', async () => {
  const s = setup(); s.context.API.get = async () => { throw new Error('offline'); };
  s.paste(); await tick();
  assert.equal(s.requests.length, 0);
  assert.match(s.notices[0], /Could not read OSS settings/);
  assert.equal(s.context.images.busy, false);
  assert.equal(s.document.querySelector('.terminal-image-upload-overlay'), null);
});
test('terminal switch during config retry never uploads into a different session', async () => {
  const s = setup(); let resolve;
  s.context.API.get = () => new Promise(done => { resolve = done; });
  s.paste(); s.switchSocket(); resolve({ enabled: true }); await tick();
  assert.equal(s.requests.length, 0);
  assert.match(s.notices[0], /switched or disconnected/);
  assert.equal(s.context.images.busy, false);
});
test('older config reads cannot overwrite settings saved in this window', async () => {
  const s = setup(); await s.context.images.showSettings();
  let resolve; s.context.API.get = () => new Promise(done => { resolve = done; });
  const oldRead = s.context.images.load();
  s.document.getElementById('oss-enabled').checked = true;
  s.document.getElementById('oss-save').click(); await tick();
  resolve({ enabled: false }); await oldRead;
  s.paste(); assert.equal(s.requests.length, 1);
  s.requests[0].reject(new Error('Image upload failed')); await tick();
});

test('saving disabled credentials explicitly explains that uploading is not enabled', async () => {
  const s = setup(); await s.context.images.showSettings();
  s.document.getElementById('oss-enabled').checked = false;
  s.document.getElementById('oss-save').click(); await tick();
  assert.match(s.document.getElementById('oss-feedback').textContent, /Settings saved.*not enabled/);
  assert.equal(s.document.getElementById('oss-save').disabled, false);
});

test('stalled configuration request times out and releases the upload lock', async () => {
  const s = setup(); let timeout;
  s.context.setTimeout = callback => { timeout = callback; return 1; };
  s.context.clearTimeout = () => {};
  s.context.API.get = () => new Promise(() => {});
  s.paste(); timeout(); await tick();
  assert.equal(s.context.images.busy, false);
  assert.equal(s.requests.length, 0);
  assert.match(s.notices[0], /Could not read OSS settings/);
});
