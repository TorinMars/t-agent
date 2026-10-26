const test = require('node:test');
const assert = require('node:assert/strict');
const { attach } = require('../public/js/terminal-ime');

function setup() {
  const listeners = {};
  const dataHandlers = [];
  const term = {
    element: { addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener: type => { delete listeners[type]; } },
    onData: fn => { dataHandlers.push(fn); return { dispose() { dataHandlers.length = 0; } }; },
  };
  const sent = [];
  const timers = [];
  const dispose = attach(term, text => sent.push(text), { schedule: fn => timers.push(fn) });
  return {
    sent, dispose, listeners,
    input: event => listeners.input(event),
    xtermEmits: chunk => dataHandlers.forEach(fn => fn(chunk)),
    settle: () => timers.splice(0).forEach(fn => fn()),
  };
}

test('a space, punctuation mark or number that xterm dropped is sent', () => {
  const t = setup();
  for (const data of [' ', '\uFF0C', '\u3002', ',', '.', '\u3000', '0', '7', '\uFF15']) t.input({ inputType: 'insertText', data, isComposing: false });
  t.settle();
  assert.deepEqual(t.sent, [' ', '\uFF0C', '\u3002', ',', '.', '\u3000', '0', '7', '\uFF15']);
});

test('a character xterm already emitted is not sent twice', () => {
  const t = setup();
  t.input({ inputType: 'insertText', data: ' ', isComposing: false });
  t.xtermEmits(' ');
  t.settle();
  assert.deepEqual(t.sent, []);
});

test('letters, composition and other input types are left to xterm', () => {
  const t = setup();
  t.input({ inputType: 'insertText', data: 'a', isComposing: false });
  t.input({ inputType: 'insertText', data: '\uFF0C', isComposing: true });
  t.input({ inputType: 'insertCompositionText', data: '\uFF0C', isComposing: false });
  t.input({ inputType: 'insertText', data: ', ', isComposing: false });
  t.input({ inputType: 'deleteContentBackward', data: null, isComposing: false });
  t.settle();
  assert.deepEqual(t.sent, []);
});

test('detaching stops the watching', () => {
  const t = setup();
  t.dispose();
  assert.equal(t.listeners.input, undefined);
});

test('several characters typed quickly are each checked against what xterm emitted', () => {
  const t = setup();
  t.input({ inputType: 'insertText', data: ' ', isComposing: false });
  t.xtermEmits(' ');
  t.input({ inputType: 'insertText', data: '\uFF0C', isComposing: false });
  t.settle();
  assert.deepEqual(t.sent, ['\uFF0C']);
});
