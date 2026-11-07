const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

// The module in a small DOM with a fake clock, fake timers, a recording clipboard and a page host that records what it is asked to show.
function setup({ clipboardFails = false } = {}) {
  const { document } = parseHTML('<html><body><div id="host"></div></body></html>');
  const writes = [];
  const notices = [];
  const shown = [];
  const timers = [];
  const clock = { now: 1000000 };
  const clipboard = { fails: clipboardFails, async writeText(text) { if (this.fails) throw new Error('NotAllowedError'); writes.push(text); } };
  document.execCommand = () => false; // the legacy fallback fails too, like iOS Safari outside a gesture
  const context = vm.createContext({
    document, window: { isSecureContext: true }, navigator: { platform: 'MacIntel', clipboard }, TextDecoder, Uint8Array, atob, Promise,
    Date: { now: () => clock.now },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, at: clock.now + ms }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; },
    notify: (message, type) => notices.push([message, type]),
  });
  vm.runInContext(fs.readFileSync(require.resolve('../public/js/terminal-clipboard.js'), 'utf8') + '\nthis.clipboard = TerminalClipboard;', context);
  context.clipboard.setHost({ show: request => shown.push(request) });
  const term = { options: {}, selection: '中文\nsecond line', getSelection() { return this.selection; }, hasSelection() { return !!this.selection; }, attachCustomKeyEventHandler(fn) { this.key = fn; }, parser: { registerOscHandler(id, fn) { assert.equal(id, 52); term.osc = fn; return { dispose() { term.disposed = true; } }; } }, write(data, done) { this.osc(data); done(); } };
  const state = { active: true };
  const handle = context.clipboard.attach(term, document.getElementById('host'), { isActive: () => state.active });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const advance = ms => { clock.now += ms; for (const timer of timers) if (timer.fn && timer.at <= clock.now) { const fn = timer.fn; timer.fn = null; fn(); } };
  const last = () => shown[shown.length - 1];
  return { term, handle, context, document, writes, notices, shown, last, state, clock, clipboard, flush, advance };
}
const osc = text => 'c;' + Buffer.from(text).toString('base64');

test('Cmd+C writes the current selection once; Ctrl+C and no-selection input remain available', async () => {
  const { term, writes, flush } = setup();
  const key = { key: 'c', type: 'keydown', metaKey: true, preventDefault() {} };
  assert.equal(term.key(key), false);
  assert.equal(term.key({ ...key, type: 'keyup' }), false);
  await flush();
  assert.deepEqual(writes, ['中文\nsecond line']);
  assert.equal(term.key({ ...key, metaKey: false, ctrlKey: true }), true);
  term.selection = '';
  assert.equal(term.key(key), true);
  assert.equal(term.options.macOptionClickForcesSelection, true);
});

test('OSC 52 decoding is bounded, UTF-8 only, and never answers clipboard queries', () => {
  const { context } = setup();
  assert.equal(context.clipboard.decodeOsc52(osc('中文\ntext')), '中文\ntext');
  assert.equal(context.clipboard.decodeOsc52('c;' + Buffer.alloc(65536, 97).toString('base64')), 'a'.repeat(65536));
  for (const data of ['c;?', 'c;', 'c;%%', 'c;' + Buffer.alloc(65537, 97).toString('base64'), 'c;' + 'A'.repeat(90000), 'x;YQ==', 'c;' + Buffer.from([0xff, 0xfe]).toString('base64'), 'nosep']) {
    assert.equal(context.clipboard.decodeOsc52(data), null, data.slice(0, 20));
  }
});

test('without a recent gesture a request asks first: nothing is written until Confirm copy', async () => {
  const { term, context, writes, notices, last, flush } = setup();
  term.osc(osc('Remote program\nhello'));
  assert.deepEqual(writes, []);
  assert.equal(last().kind, 'ask');
  assert.equal(last().text, 'Remote program\nhello');
  assert.equal(last().chars, 20);
  // A second request cannot replace the text already shown for approval.
  term.osc(osc('evil'));
  assert.equal(last().text, 'Remote program\nhello');
  assert.equal(await context.clipboard.confirm(), true);
  await flush();
  assert.deepEqual(writes, ['Remote program\nhello']);
  assert.equal(last(), null);
  assert.deepEqual(notices.at(-1), ['Copied 20 characters', 'success']);
});

test('Cancel copies nothing, and a waiting request expires after 60 seconds', () => {
  const { term, context, writes, last, advance } = setup();
  term.osc(osc('one'));
  context.clipboard.cancel();
  assert.equal(last(), null);
  term.osc(osc('two'));
  assert.equal(last().kind, 'ask');
  advance(context.clipboard.REQUEST_TTL_MS - 1);
  assert.equal(last().text, 'two');
  advance(1);
  assert.equal(last(), null);
  assert.deepEqual(writes, []);
});

test('right after a user gesture on the terminal the copy is written at once, once per gesture', async () => {
  const { term, handle, context, writes, notices, shown, last, advance, flush } = setup();
  handle.gesture();
  advance(context.clipboard.GESTURE_WINDOW_MS);
  term.osc(osc('selected in Claude Code'));
  await flush();
  assert.deepEqual(writes, ['selected in Claude Code']);
  assert.deepEqual(notices.at(-1), ['Copied 23 characters', 'success']);
  assert.equal(shown.length, 0, 'no question for a user-initiated copy');
  // The gesture is used up: a second request from the program asks.
  term.osc(osc('second'));
  await flush();
  assert.deepEqual(writes, ['selected in Claude Code']);
  assert.equal(last().kind, 'ask');
  context.clipboard.cancel();
  // A gesture too long ago asks too.
  handle.gesture();
  advance(context.clipboard.GESTURE_WINDOW_MS + 1);
  term.osc(osc('late'));
  await flush();
  assert.equal(last().kind, 'ask');
  assert.equal(writes.length, 1);
});

test('when the browser refuses the automatic write, the page offers Tap to copy and the tap writes', async () => {
  const { term, handle, context, clipboard, writes, last, flush } = setup({ clipboardFails: true });
  handle.gesture();
  term.osc(osc('needs a tap'));
  await flush();
  assert.equal(last().kind, 'tap');
  assert.equal(last().text, 'needs a tap');
  clipboard.fails = false; // inside the tap the browser allows it
  assert.equal(await context.clipboard.confirm(), true);
  assert.deepEqual(writes, ['needs a tap']);
  assert.equal(last(), null);
});

test('a confirmation whose write fails stays open and says so', async () => {
  const { term, context, last } = setup({ clipboardFails: true });
  term.osc(osc('text'));
  assert.equal(await context.clipboard.confirm(), false);
  assert.equal(last().kind, 'ask');
  assert.equal(last().failed, true);
});

test('replayed history, a hidden terminal and a disposed one never copy or ask', async () => {
  const { term, handle, context, writes, shown, state, flush, advance } = setup();
  handle.gesture();
  handle.writeHistory(osc('replayed'));
  state.active = false;
  term.osc(osc('hidden'));
  assert.equal(term.key({ key: 'c', type: 'keydown', metaKey: true }), true);
  await flush();
  assert.deepEqual(writes, []);
  assert.equal(shown.length, 0);
  state.active = true;
  advance(context.clipboard.GESTURE_WINDOW_MS + 1);
  term.osc(osc('asks'));
  assert.equal(shown.at(-1).kind, 'ask');
  handle.dispose();
  assert.equal(shown.at(-1), null, 'disposing drops its waiting request');
  assert.equal(term.disposed, true);
});

test('a request of a terminal that is hidden goes away, and confirm then writes nothing', async () => {
  const { term, handle, context, writes, last, state } = setup();
  term.osc(osc('waiting'));
  state.active = false;
  assert.equal(await context.clipboard.confirm(), false);
  assert.deepEqual(writes, []);
  assert.equal(last(), null);
  state.active = true;
  term.osc(osc('again'));
  handle.dismiss();
  assert.equal(last(), null);
});

test('untrusted DOM events are not gestures', async () => {
  const { term, document, writes, last, flush } = setup();
  const host = document.getElementById('host');
  const event = new document.defaultView.Event('pointerup');
  host.dispatchEvent(event); // a script event (isTrusted is false)
  term.osc(osc('scripted'));
  await flush();
  assert.deepEqual(writes, []);
  assert.equal(last().kind, 'ask');
});

test('the same text twice within 2 seconds is one copy (pbcopy shim and the program\'s own OSC 52)', async () => {
  const { term, handle, context, writes, notices, shown, last, advance, flush } = setup();
  handle.gesture();
  term.osc(osc('twice'));
  await flush();
  term.osc(osc('twice')); // the gesture is used up, but the duplicate neither writes again nor asks
  await flush();
  assert.deepEqual(writes, ['twice']);
  assert.equal(notices.filter(([message]) => message === 'Copied 5 characters').length, 1);
  assert.equal(shown.length, 0);
  // Without a gesture: one dialog; the duplicate does not open another after Cancel either.
  advance(context.clipboard.DUPLICATE_WINDOW_MS + 1);
  term.osc(osc('asked'));
  term.osc(osc('asked'));
  assert.equal(shown.length, 1);
  context.clipboard.cancel();
  term.osc(osc('asked'));
  assert.equal(shown.length, 2, 'only the cancel was shown');
  assert.equal(last(), null);
  // After the window the same text is a new request.
  advance(context.clipboard.DUPLICATE_WINDOW_MS + 1);
  term.osc(osc('asked'));
  assert.equal(last().kind, 'ask');
  // Another text is never merged.
  context.clipboard.cancel();
  handle.gesture();
  term.osc(osc('other'));
  await flush();
  assert.deepEqual(writes, ['twice', 'other']);
});
