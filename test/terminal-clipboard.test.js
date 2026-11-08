const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

// The module in a small DOM with a fake clock, fake timers, a recording clipboard and a page host that records what it is asked to show.
function setup({ clipboardFails = false, input = 'touch' } = {}) {
  const { document } = parseHTML('<html><body><div id="host"></div></body></html>');
  document.documentElement.dataset.input = input;
  const windowListeners = {};
  const writes = [];
  const notices = [];
  const shown = [];
  const timers = [];
  const clock = { now: 1000000 };
  const clipboard = { fails: clipboardFails, async writeText(text) { if (this.fails) throw new Error('NotAllowedError'); writes.push(text); } };
  document.execCommand = () => false; // the legacy fallback fails too, like iOS Safari outside a gesture
  const context = vm.createContext({
    document, window: { isSecureContext: true, addEventListener: (type, fn) => { windowListeners[type] = fn; }, removeEventListener: type => { delete windowListeners[type]; } }, navigator: { platform: 'MacIntel', clipboard }, TextDecoder, Uint8Array, atob, Promise,
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
  // A real (trusted) mouse press on the terminal, then the button goes up on the window (copy on select with a mouse).
  const trusted = (type, init = {}) => { const event = new document.defaultView.Event(type); Object.defineProperty(event, 'isTrusted', { value: true }); Object.assign(event, init); return event; };
  const mouse = { down(button = 0) { document.getElementById('host').dispatchEvent(trusted('pointerdown', { pointerType: 'mouse', button })); }, up() { windowListeners.mouseup({ button: 0 }); } };
  return { term, handle, context, document, writes, notices, shown, last, state, clock, clipboard, flush, advance, mouse, windowListeners };
}
const osc = text => 'c;' + Buffer.from(text).toString('base64');

test('Cmd+C writes the current selection once; Ctrl+C and no-selection input remain available', async () => {
  const { term, writes, notices, flush } = setup();
  const key = { key: 'c', type: 'keydown', metaKey: true, preventDefault() {} };
  assert.equal(term.key(key), false);
  assert.equal(term.key({ ...key, type: 'keyup' }), false);
  await flush();
  assert.deepEqual(writes, ['中文\nsecond line']);
  assert.deepEqual(notices, [['Copied 14 characters', 'success']], 'the same notice as a program copy');
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

test('without a recent gesture a request asks first: nothing is written until Copy', async () => {
  const { term, context, writes, notices, last, flush } = setup();
  term.osc(osc('Remote program\nhello'));
  assert.deepEqual(writes, []);
  assert.equal(last().kind, 'ask');
  assert.equal(last().text, 'Remote program\nhello');
  assert.equal(last().chars, 20);
  assert.equal(last().preview, 'Remote program hello', 'a one-line preview');
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

test('a write that fails inside the tap closes the bar with one error notice, by input mode', async () => {
  for (const [input, message] of [['touch', 'Could not copy. Long-press to open the copy view'], ['pointer', 'Could not copy. Use Copy text in the terminal menu']]) {
    const { term, handle, context, notices, last } = setup({ clipboardFails: true, input });
    term.osc(osc('text'));
    assert.equal(await context.clipboard.confirm(), false);
    assert.equal(last(), null);
    assert.deepEqual(notices, [[message, 'error']]);
    // A refused page selection whose Tap to copy fails ends the same way.
    context.clipboard.cancel();
    await handle.copy('selected');
    assert.equal(last().kind, 'tap');
    assert.equal(await context.clipboard.confirm(), false);
    assert.equal(last(), null);
    assert.deepEqual(notices, [[message, 'error'], [message, 'error']]);
  }
});

test('the preview is one line and bounded', () => {
  const { context } = setup();
  assert.equal(context.clipboard.previewOf('  a\n\tb  c \r\n'), 'a b c');
  assert.equal(context.clipboard.previewOf('x'.repeat(500)), `${'x'.repeat(120)}…`);
  assert.equal(context.clipboard.previewOf('中'.repeat(121)), `${'中'.repeat(120)}…`);
});

test('a page selection and a program copy after a gesture give the identical write, notice and bar', async () => {
  const runs = [];
  for (const source of ['page', 'program']) {
    const { term, handle, writes, notices, shown, flush } = setup();
    if (source === 'page') await handle.copy('same text');
    else { handle.gesture(); term.osc(osc('same text')); }
    await flush();
    runs.push({ writes, notices: [...notices], shown: [...shown] });
  }
  assert.deepEqual(runs[0], runs[1]);
  assert.deepEqual(runs[0], { writes: ['same text'], notices: [['Copied 9 characters', 'success']], shown: [] });
  // Refused by the browser: the same "Tap to copy" bar for both.
  const bars = [];
  for (const source of ['page', 'program']) {
    const { term, handle, notices, last, flush } = setup({ clipboardFails: true });
    if (source === 'page') await handle.copy('x');
    else { handle.gesture(); term.osc(osc('x')); }
    await flush();
    const { id, ...bar } = last();
    bars.push(bar);
    assert.deepEqual(notices, [], 'no notice while the bar waits');
  }
  assert.deepEqual(bars[0], bars[1]);
  assert.deepEqual(bars[0], { kind: 'tap', text: 'x', preview: 'x', chars: 1 });
});

test('a page copy uses up the gesture, is ignored for a hidden terminal and merges with the program\'s copy of the same text', async () => {
  const { term, handle, context, writes, notices, shown, last, state, advance, flush } = setup();
  handle.gesture();
  await handle.copy('word');
  term.osc(osc('other'));
  await flush();
  assert.equal(last().kind, 'ask', 'the program cannot copy on the gesture the page copy used');
  context.clipboard.cancel();
  // The program copies the same text the page just copied (Claude Code with a forced selection, its pbcopy shim): one copy.
  advance(context.clipboard.DUPLICATE_WINDOW_MS + 1);
  await handle.copy('merged');
  handle.gesture();
  term.osc(osc('merged'));
  term.osc(osc('merged'));
  await flush();
  // And the other way round: the program first, then the page selects it.
  advance(context.clipboard.DUPLICATE_WINDOW_MS + 1);
  handle.gesture();
  term.osc(osc('first'));
  await handle.copy('first');
  await flush();
  assert.deepEqual(writes, ['word', 'merged', 'first']);
  assert.deepEqual(notices.map(([message]) => message), ['Copied 4 characters', 'Copied 6 characters', 'Copied 5 characters']);
  assert.equal(shown.length, 2, 'only the ask and its cancel');
  state.active = false;
  assert.equal(await handle.copy('hidden'), false);
  assert.equal(writes.length, 3);
});

test('mouse: copy on select when the button goes up; a plain click or an unchanged selection copies nothing; Cmd+C gives no second notice', async () => {
  const { term, handle, windowListeners, writes, notices, mouse, advance, flush } = setup({ input: 'pointer' });
  term.selection = '';
  mouse.down(); mouse.up(); // a plain click
  windowListeners.mouseup({ button: 0 }); // a button going up without a press on this terminal
  term.selection = 'dragged';
  windowListeners.mouseup({ button: 0 });
  await flush();
  assert.deepEqual(writes, []);
  mouse.down(); mouse.up(); // a drag, a double or triple click, an Option / Shift selection
  await flush();
  assert.deepEqual(writes, ['dragged']);
  assert.deepEqual(notices, [['Copied 7 characters', 'success']]);
  // Cmd+C on the text just copied: no second write or notice.
  term.key({ key: 'c', type: 'keydown', metaKey: true, preventDefault() {} });
  await flush();
  // A press that leaves the selection as it was (the scrollbar) copies nothing, even after the merge window.
  advance(5000);
  mouse.down(); mouse.up();
  await flush();
  assert.deepEqual(writes, ['dragged']);
  assert.equal(notices.length, 1);
  // A right button never copies.
  term.selection = 'right';
  mouse.down(2);
  windowListeners.mouseup({ button: 2 });
  windowListeners.mouseup({ button: 0 });
  await flush();
  assert.deepEqual(writes, ['dragged']);
  // A new selection copies; after the selection was cleared the same text copies again.
  term.selection = 'longer selection';
  mouse.down(); mouse.up();
  term.selection = '';
  mouse.down(); mouse.up();
  advance(5000);
  term.selection = 'longer selection';
  mouse.down(); mouse.up();
  await flush();
  assert.deepEqual(writes, ['dragged', 'longer selection', 'longer selection']);
  handle.dispose();
  assert.equal(windowListeners.mouseup, undefined, 'dispose removes the window listener');
});

test('Cmd+C on the text of a refused copy writes it inside the key press', async () => {
  const { term, clipboard, writes, notices, last, mouse, flush } = setup({ clipboardFails: true, input: 'pointer' });
  term.selection = 'refused';
  mouse.down(); mouse.up();
  await flush();
  assert.equal(last().kind, 'tap');
  clipboard.fails = false;
  term.key({ key: 'c', type: 'keydown', metaKey: true, preventDefault() {} });
  await flush();
  assert.deepEqual(writes, ['refused']);
  assert.equal(last(), null);
  assert.deepEqual(notices, [['Copied 7 characters', 'success']]);
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
  // Without a gesture: one bar; the duplicate does not open another after Cancel either.
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

// ── Paste: one clipboard read per tap (readClipboard / pickClipboard) ──
function pasteModule() {
  const context = vm.createContext({ TextDecoder, Uint8Array, atob, Promise, Response, Blob, Date, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(require.resolve('../public/js/terminal-clipboard.js'), 'utf8') + '\nthis.clipboard = TerminalClipboard;', context);
  return context.clipboard;
}
const item = parts => ({ types: Object.keys(parts), async getType(type) { if (!(type in parts)) throw new Error('NotFoundError'); return new Blob([parts[type]], { type }); } });
const recordingClipboard = ({ items, readFails, noRead, text } = {}) => {
  const calls = [];
  return {
    calls,
    clipboard: {
      ...(noRead ? {} : { read() { calls.push('read'); return readFails ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve(items || []); } }),
      readText() { calls.push('readText'); return Promise.resolve(text || ''); },
    },
  };
};

test('paste reads the clipboard once with read() and takes text/plain from the same items', async () => {
  const { readClipboard } = pasteModule();
  const { clipboard, calls } = recordingClipboard({ items: [item({ 'text/html': '<b>x</b>', 'text/plain': '中文 vim :wq\nline 2' })] });
  const reading = readClipboard(clipboard);
  assert.deepEqual(calls, ['read'], 'the read starts synchronously, inside the tap');
  const result = await reading;
  assert.equal(result.kind, 'text');
  assert.equal(result.text, '中文 vim :wq\nline 2');
  assert.deepEqual(calls, ['read'], 'readText is never called after read()');
});

test('paste prefers an image of any item over text', async () => {
  const { readClipboard } = pasteModule();
  const { clipboard, calls } = recordingClipboard({ items: [item({ 'text/plain': 'name.png' }), item({ 'image/png': 'PNGDATA' })] });
  const result = await readClipboard(clipboard);
  assert.equal(result.kind, 'image');
  assert.equal(result.type, 'image/png');
  assert.equal(await result.blob.text(), 'PNGDATA');
  assert.deepEqual(calls, ['read']);
});

test('a refused read() is reported as denied and does not fall back to readText', async () => {
  const { readClipboard } = pasteModule();
  const { clipboard, calls } = recordingClipboard({ readFails: true, text: 'never' });
  const result = await readClipboard(clipboard);
  assert.equal(result.kind, 'denied');
  assert.deepEqual(calls, ['read'], 'a second read would have no user gesture left on WebKit');
});

test('a read() that throws at once is denied, an empty clipboard is empty, no API is unsupported', async () => {
  const { readClipboard } = pasteModule();
  assert.equal((await readClipboard({ read() { throw new Error('SecurityError'); } })).kind, 'denied');
  assert.equal((await readClipboard(recordingClipboard({ items: [item({ 'text/html': '<i></i>' })] }).clipboard)).kind, 'empty');
  assert.equal((await readClipboard(recordingClipboard({ items: [item({ 'text/plain': '' })] }).clipboard)).kind, 'empty');
  assert.equal((await readClipboard(undefined)).kind, 'unsupported', 'plain HTTP has no navigator.clipboard');
  assert.equal((await readClipboard({})).kind, 'unsupported');
});

test('readText is used only when read() does not exist', async () => {
  const { readClipboard } = pasteModule();
  const { clipboard, calls } = recordingClipboard({ noRead: true, text: 'plain' });
  const result = await readClipboard(clipboard);
  assert.deepEqual({ kind: result.kind, text: result.text }, { kind: 'text', text: 'plain' });
  assert.deepEqual(calls, ['readText']);
  assert.equal((await readClipboard(recordingClipboard({ noRead: true, text: '' }).clipboard)).kind, 'empty');
});
