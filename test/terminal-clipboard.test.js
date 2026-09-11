const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

function setup() {
  const { document, Event } = parseHTML('<html><body><div class="terminal-toolbar"></div><div id="terminal-pane"><div id="xterm-container"><div id="host"></div></div></div></body></html>');
  const writes = [];
  const context = vm.createContext({ document, window: { isSecureContext: true }, navigator: { platform: 'MacIntel', clipboard: { async writeText(text) { writes.push(text); } } }, MutationObserver: class { observe() {} }, TextDecoder, Uint8Array, atob, setTimeout: () => 1, clearTimeout() {} });
  vm.runInContext(fs.readFileSync(require.resolve('../public/js/terminal-clipboard.js'), 'utf8') + '\nthis.clipboard = TerminalClipboard;', context);
  const term = { options: {}, selection: '中文\nsecond line', getSelection() { return this.selection; }, hasSelection() { return !!this.selection; }, attachCustomKeyEventHandler(fn) { this.key = fn; }, parser: { registerOscHandler(id, fn) { assert.equal(id, 52); term.osc = fn; return { dispose() { term.disposed = true; } }; } }, write(data, done) { this.osc(data); done(); } };
  const handle = context.clipboard.attach(term, document.getElementById('host'));
  return { term, handle, context, document, writes, Event };
}

test('Cmd+C writes the current selection once; Ctrl+C and no-selection input remain available', async () => {
  const { term, writes } = setup();
  const key = { key: 'c', type: 'keydown', metaKey: true, preventDefault() {} };
  assert.equal(term.key(key), false);
  assert.equal(term.key({ ...key, type: 'keyup' }), false);
  assert.deepEqual(writes, ['中文\nsecond line']);
  assert.equal(term.key({ ...key, metaKey: false, ctrlKey: true }), true);
  term.selection = '';
  assert.equal(term.key(key), true);
  assert.equal(term.options.macOptionClickForcesSelection, true);
});

test('OSC 52 requests require approval, are bounded, and never answer clipboard queries', () => {
  const { term, context, document, writes, handle } = setup();
  const payload = 'c;' + Buffer.from('中文\ntext').toString('base64');
  assert.equal(context.clipboard.decodeOsc52(payload), '中文\ntext');
  for (const data of ['c;?', 'c;', 'c;%%', 'c;' + 'A'.repeat(90000), 'x;YQ==']) assert.equal(context.clipboard.decodeOsc52(data), null);
  handle.writeHistory(payload);
  const request = [...document.querySelectorAll('button')].find(b => b.textContent === '查看程序复制请求');
  assert.equal(request.hidden, true);
  term.osc(payload);
  assert.equal(request.hidden, false);
  assert.deepEqual(writes, []);
  handle.dispose();
  assert.equal(request.hidden, true);
  assert.equal(term.disposed, true);
});

test('hidden terminal cannot handle copy keys or raise remote clipboard requests', () => {
  const { term, document, writes } = setup();
  document.getElementById('host').style.display = 'none';
  assert.equal(term.key({ key: 'c', type: 'keydown', metaKey: true }), true);
  term.osc('c;' + Buffer.from('hidden').toString('base64'));
  assert.deepEqual(writes, []);
  assert.equal([...document.querySelectorAll('button')].find(b => b.textContent === '查看程序复制请求').hidden, true);
});
