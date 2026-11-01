const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Terminal } = require('@xterm/headless');
const { TerminalSnapshot } = require('../lib/terminal-snapshot');

const vendorFile = path.join(__dirname, '..', 'public', 'vendor', 'xterm', 'addon-unicode11-0.8.0.js');
const write = (terminal, data) => new Promise(resolve => terminal.write(data, resolve));

// Load the vendored file the way a browser page does (a classic script that sets a global), not through require().
function loadBrowserAddon() {
  const sandbox = { window: {}, self: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(vendorFile, 'utf8'), sandbox);
  return sandbox.Unicode11Addon || sandbox.window.Unicode11Addon || sandbox.self.Unicode11Addon;
}

// Columns the cursor advances for one string.
async function width(text, Addon) {
  const terminal = new Terminal({ cols: 30, rows: 2, allowProposedApi: true });
  if (Addon) { terminal.loadAddon(new Addon.Unicode11Addon()); terminal.unicode.activeVersion = '11'; }
  await write(terminal, text);
  const columns = terminal.buffer.active.cursorX;
  terminal.dispose();
  return columns;
}

// [text, expected columns under Unicode 11]
const SAMPLES = [
  ['abc', 3], ['\u4e2d\u6587', 4], ['\ud55c', 2], ['\uff71', 1], ['e\u0301', 1],
  ['\ud83d\ude00', 2], ['\ud83d\ude80', 2], ['\u2705', 2], ['\u2b50', 2], ['\u2728', 2], ['\u26a1', 2], ['\ud83e\udde0', 2],
];

test('the default Unicode 6 table is too narrow for common emoji (the problem being fixed)', async () => {
  assert.equal(await width('\ud83d\ude00'), 1);
  assert.equal(await width('\u2705'), 1);
});

test('the vendored browser addon and the server snapshot terminal agree on widths', async () => {
  const browser = loadBrowserAddon();
  assert.ok(browser && browser.Unicode11Addon, 'vendored addon exposes Unicode11Addon');
  const snapshot = new TerminalSnapshot(30, 2);
  for (const [text, expected] of SAMPLES) {
    const inBrowser = await width(text, browser);
    await snapshot.write('\x1b[2J\x1b[H' + text);
    const onServer = snapshot.terminal.buffer.active.cursorX;
    assert.equal(inBrowser, expected, `browser width of ${JSON.stringify(text)}`);
    assert.equal(onServer, expected, `server width of ${JSON.stringify(text)}`);
  }
  assert.equal(snapshot.terminal.unicode.activeVersion, '11');
  await snapshot.dispose();
});

test('snapshot round trip keeps wide characters aligned when the replay uses Unicode 11', async () => {
  const browser = loadBrowserAddon();
  const snapshot = new TerminalSnapshot(40, 6);
  await snapshot.write('\u2705 done\r\n\u4e2d\u6587\u6d4b\u8bd5|\r\n\ud83d\ude80 launch \u2728|\r\n\x1b[2;3Hxy');
  let frame;
  await snapshot.snapshot(value => { frame = value; });
  const replayed = new Terminal({ cols: frame.cols, rows: frame.rows, scrollback: 500, allowProposedApi: true });
  replayed.loadAddon(new browser.Unicode11Addon());
  replayed.unicode.activeVersion = '11';
  await write(replayed, frame.data);
  for (let y = 0; y < 4; y++) {
    const a = snapshot.terminal.buffer.active.getLine(y);
    const b = replayed.buffer.active.getLine(y);
    assert.equal(b.translateToString(true), a.translateToString(true), `row ${y} text`);
    for (let x = 0; x < 12; x++) assert.equal(b.getCell(x).getWidth(), a.getCell(x).getWidth(), `row ${y} col ${x} width`);
  }
  // The pipes sit at the same column on both sides.
  const column = (terminal, y) => { let c = 0; const line = terminal.buffer.active.getLine(y); for (let x = 0; x < 40; x++) { const cell = line.getCell(x); if (cell.getChars() === '|') c = x; } return c; };
  assert.equal(column(replayed, 1), 8);
  assert.equal(column(replayed, 1), column(snapshot.terminal, 1));
  assert.equal(column(replayed, 2), column(snapshot.terminal, 2));
  assert.equal(replayed.buffer.active.cursorX, snapshot.terminal.buffer.active.cursorX);
  replayed.dispose(); await snapshot.dispose();
});
