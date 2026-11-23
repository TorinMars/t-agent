const test = require('node:test');
const assert = require('node:assert/strict');
const { attach, createPairs, isPair } = require('../public/js/terminal-ime-pairs');

const LQ = '\u201C'; const RQ = '\u201D'; const LS = '\u2018'; const RS = '\u2019';
const QUOTES = LQ + RQ;
const LEFT = '\x1b[D';

// The rules with a fake clock: `wait(ms)` runs the timers that are due.
function setup() {
  let clock = 0;
  let timers = [];
  const sent = [];
  const pairs = createPairs(data => sent.push(data), {
    now: () => clock,
    schedule: (fn, ms) => { const timer = { fn, at: clock + ms }; timers.push(timer); return timer; },
    cancel: timer => { timers = timers.filter(item => item !== timer); },
  });
  const wait = ms => {
    clock += ms;
    for (const timer of timers.filter(item => item.at <= clock)) { timers = timers.filter(item => item !== timer); timer.fn(); }
  };
  // One press of the WeType key: the pair, then its Left key (xterm would emit the Left only on 'pass').
  const press = pair => { assert.equal(pairs.pairInserted(pair), true); assert.equal(pairs.leftKey(), 'drop'); };
  // The order seen in WebKit: the input method's key (229), its Left (xterm emits it), then the pair.
  const pressReversed = pair => {
    pairs.imeKey();
    assert.equal(pairs.leftKey(), 'hold');
    pairs.forward(LEFT);
    pairs.disarm();
    assert.equal(pairs.pairInserted(pair), true);
  };
  return { pairs, sent, wait, press, pressReversed };
}

test('every full-width pair is recognised, nothing else', () => {
  for (const pair of ['\u201C\u201D', '\u2018\u2019', '\uFF08\uFF09', '\u300A\u300B', '\u3008\u3009', '\u300C\u300D', '\u300E\u300F', '\u3010\u3011', '\u3014\u3015', '\uFF3B\uFF3D', '\uFF5B\uFF5D']) assert.equal(isPair(pair), true, pair);
  for (const text of ['""', '()', '[]', LQ, RQ, `${LQ}a${RQ}`, `${QUOTES}${QUOTES}`, '\uFF01', '', null, undefined]) assert.equal(isPair(text), false, String(text));
});

test('a pair and its Left key give one quote, alternating opening and closing', () => {
  const t = setup();
  t.press(QUOTES); t.press(QUOTES); t.press(QUOTES);
  assert.deepEqual(t.sent, [LQ, RQ, LQ]);
  t.wait(1000);
  assert.deepEqual(t.sent, [LQ, RQ, LQ], 'nothing else is sent later');
});

test('single and double quotes alternate on their own', () => {
  const t = setup();
  t.press(QUOTES); t.press(LS + RS); t.press(LS + RS); t.press(QUOTES);
  assert.deepEqual(t.sent, [LQ, LS, RS, RQ]);
});

test('brackets give the opening one every time', () => {
  const t = setup();
  t.press('\u3010\u3011'); t.press('\u3010\u3011'); t.press('\uFF08\uFF09'); t.press('\u300A\u300B'); t.press('\u300C\u300D'); t.press('\uFF5B\uFF5D');
  assert.deepEqual(t.sent, ['\u3010', '\u3010', '\uFF08', '\u300A', '\u300C', '\uFF5B']);
});

test('other text between the presses keeps the alternation', () => {
  const t = setup();
  t.press(QUOTES);
  t.pairs.forward('\uFF01');
  t.press(QUOTES);
  t.pairs.forward('\uFF01');
  t.press(QUOTES);
  assert.deepEqual(t.sent, [LQ, '\uFF01', RQ, '\uFF01', LQ]);
});

for (const [name, key] of [['Enter', '\r'], ['Ctrl+C', '\x03'], ['Ctrl+U', '\x15'], ['text ending in Enter', 'ls\r']]) {
  test(`${name} starts the quotes again`, () => {
    const t = setup();
    t.press(QUOTES);
    t.pairs.forward(key);
    t.press(QUOTES);
    assert.deepEqual(t.sent, [LQ, key, LQ]);
  });
}

test('an Enter sent another way (the page keyboard, observed) starts the quotes again', () => {
  const t = setup();
  t.press(QUOTES);
  t.pairs.observe('\r');
  t.press(QUOTES);
  assert.deepEqual(t.sent, [LQ, LQ]);
});

test('the reversed order (Left first, the pair right after) gives one quote and drops the Left', () => {
  const t = setup();
  t.pressReversed(QUOTES); t.pressReversed(QUOTES); t.pressReversed(QUOTES);
  assert.deepEqual(t.sent, [LQ, RQ, LQ]);
  t.wait(1000);
  assert.deepEqual(t.sent, [LQ, RQ, LQ]);
});

test('both orders mixed keep one alternation', () => {
  const t = setup();
  t.press(QUOTES); t.pressReversed(QUOTES); t.press(QUOTES);
  assert.deepEqual(t.sent, [LQ, RQ, LQ]);
});

test('a pair without a Left key is sent unchanged, a moment later', () => {
  const t = setup();
  assert.equal(t.pairs.pairInserted(QUOTES), true);
  assert.deepEqual(t.sent, []);
  t.wait(100);
  assert.deepEqual(t.sent, [QUOTES]);
  assert.equal(t.pairs.leftKey(), 'pass', 'a Left after the window is an ordinary Left');
  t.press(QUOTES);
  assert.deepEqual(t.sent, [QUOTES, LQ], 'and the unchanged pair did not count as a press');
});

test('other data before the Left sends the waiting pair first, unchanged, in order', () => {
  const t = setup();
  t.pairs.pairInserted(QUOTES);
  t.pairs.forward('a');
  assert.deepEqual(t.sent, [QUOTES, 'a']);
  assert.equal(t.pairs.leftKey(), 'pass');
});

test('an ordinary Left key passes at once', () => {
  const t = setup();
  assert.equal(t.pairs.leftKey(), 'pass');
  t.pairs.forward(LEFT);
  assert.deepEqual(t.sent, [LEFT]);
});

test('a Left held after an input method key is sent when no pair follows, in order', () => {
  const t = setup();
  t.pairs.imeKey();
  assert.equal(t.pairs.leftKey(), 'hold');
  t.pairs.forward(LEFT);
  assert.deepEqual(t.sent, []);
  t.wait(100);
  assert.deepEqual(t.sent, [LEFT]);
  t.pairs.imeKey();
  t.pairs.leftKey();
  t.pairs.forward('\x1bOD'); // application cursor mode
  t.pairs.forward('x');
  assert.deepEqual(t.sent, [LEFT, '\x1bOD', 'x'], 'other data sends the held Left first');
});

test('an input method key whose text came is no reason to hold the next Left', () => {
  const t = setup();
  t.pairs.imeKey();
  t.pairs.inserted();
  assert.equal(t.pairs.leftKey(), 'pass');
  t.pairs.imeKey();
  t.wait(200);
  assert.equal(t.pairs.leftKey(), 'pass', 'nor one long ago');
});

test('only the Left emitted right after the key is held', () => {
  const t = setup();
  t.pairs.imeKey();
  t.pairs.leftKey();
  t.pairs.disarm();
  t.pairs.forward(LEFT);
  assert.deepEqual(t.sent, [LEFT]);
});

test('text that is not a pair is not taken', () => {
  const t = setup();
  assert.equal(t.pairs.pairInserted('\uFF01'), false);
  assert.equal(t.pairs.pairInserted(`${QUOTES}${QUOTES}`), false);
  assert.deepEqual(t.sent, []);
});

// The DOM side with a fake terminal element: capture listeners, cancellation, the textarea fallback.
function dom() {
  const listeners = {};
  const textarea = { value: '', selectionStart: 0, selectionEnd: 0, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; } };
  const term = { element: { addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener: type => { delete listeners[type]; } }, textarea };
  const sent = [];
  const pairs = attach(term, data => sent.push(data), { schedule: () => 0, cancel: () => {} });
  const event = props => ({ defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...props });
  return { listeners, textarea, sent, pairs, event };
}

test('DOM: the pair insertion is cancelled and its Left key stopped before xterm', () => {
  const d = dom();
  const before = d.event({ inputType: 'insertText', data: QUOTES, isComposing: false, cancelable: true });
  d.listeners.beforeinput(before);
  assert.equal(before.defaultPrevented, true);
  const left = d.event({ key: 'ArrowLeft', keyCode: 37 });
  d.listeners.keydown(left);
  assert.equal(left.defaultPrevented, true);
  assert.equal(left.stopped, true);
  assert.deepEqual(d.sent, [LQ]);
  d.pairs.dispose();
  assert.deepEqual(Object.keys(d.listeners), []);
});

test('DOM: an insertion that cannot be cancelled is taken back out of the textarea, caret at the end', () => {
  const d = dom();
  d.textarea.value = `ab${QUOTES}c`; d.textarea.selectionStart = d.textarea.selectionEnd = 4;
  d.listeners.beforeinput(d.event({ inputType: 'insertText', data: QUOTES, isComposing: false, cancelable: false }));
  const input = d.event({ inputType: 'insertText', data: QUOTES, isComposing: false, target: d.textarea });
  d.listeners.input(input);
  assert.equal(input.stopped, true, 'xterm does not see it');
  assert.equal(d.textarea.value, 'abc');
  assert.equal(d.textarea.selectionStart, 3);
  d.listeners.keydown(d.event({ key: 'ArrowLeft', keyCode: 37 }));
  assert.deepEqual(d.sent, [LQ]);
});

test('DOM: composing, modified Left keys and plain text are left alone', () => {
  const d = dom();
  const composing = d.event({ inputType: 'insertText', data: QUOTES, isComposing: true, cancelable: true });
  d.listeners.beforeinput(composing);
  assert.equal(composing.defaultPrevented, false);
  const plain = d.event({ inputType: 'insertText', data: 'a', isComposing: false, cancelable: true });
  d.listeners.beforeinput(plain);
  assert.equal(plain.defaultPrevented, false);
  const paste = d.event({ inputType: 'insertFromPaste', data: QUOTES, isComposing: false, cancelable: true });
  d.listeners.beforeinput(paste);
  assert.equal(paste.defaultPrevented, false);
  d.listeners.beforeinput(d.event({ inputType: 'insertText', data: QUOTES, isComposing: false, cancelable: true }));
  for (const mods of [{ shiftKey: true }, { altKey: true }, { metaKey: true }, { ctrlKey: true }, { isComposing: true }]) {
    const left = d.event({ key: 'ArrowLeft', keyCode: 37, ...mods });
    d.listeners.keydown(left);
    assert.equal(left.stopped, false, JSON.stringify(mods));
  }
  assert.deepEqual(d.sent, []);
});
