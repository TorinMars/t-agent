// Pure math of the sideways pan and the wide terminal (public/js/terminal-gestures.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../public/js/terminal-gestures.js');

test('the axis is decided after 10px of travel and by the larger component', () => {
  assert.equal(G.axisOf(3, 4), null, '5px is still a tap');
  assert.equal(G.axisOf(9, 0), null);
  assert.equal(G.axisOf(10, 0), 'x');
  assert.equal(G.axisOf(-12, 5), 'x');
  assert.equal(G.axisOf(4, -11), 'y');
  assert.equal(G.axisOf(8, 8), 'y', 'an exact diagonal is vertical (scrolling is the common case)');
  assert.equal(G.axisOf(9, 7), 'x', 'a diagonal that leans sideways locks to x');
});

test('wide columns: the chosen count, never fewer than what fits; fit mode keeps the fitted count', () => {
  assert.equal(G.columnsFor(52, 'fit', 500), 52);
  assert.equal(G.columnsFor(52, 'wide', 500), 500);
  assert.equal(G.columnsFor(52, 'wide', 2000), 2000);
  assert.equal(G.columnsFor(230, 'wide', 200), 230, 'a wide screen keeps its own columns');
  for (const cols of [200, 500, 1000, 2000]) assert.equal(G.wideCols(String(cols)), cols, `${cols} is a choice`);
  assert.equal(G.wideCols('120'), 200, 'a choice of an older page (120) falls back to 200');
  assert.equal(G.wideCols('160'), 200, 'a choice of an older page (160) falls back to 200');
  assert.equal(G.wideCols('999'), 200, 'an unknown choice falls back to 200');
  assert.equal(G.wideCols(null), 200);
});

test('the offset stays inside the content', () => {
  assert.equal(G.maxOffset(1056, 382), 674);
  assert.equal(G.maxOffset(380, 382), 0);
  assert.equal(G.clampOffset(-20, 1056, 382), 0);
  assert.equal(G.clampOffset(900, 1056, 382), 674);
  assert.equal(G.clampOffset(100.4, 1056, 382), 100);
  assert.equal(G.clampOffset(NaN, 1056, 382), 0);
});

test('following the cursor scrolls just enough, with a margin, and the left side wins', () => {
  const base = { visible: 400, content: 1000, margin: 20 };
  assert.equal(G.followOffset({ ...base, offset: 0, left: 100, right: 107 }), 0, 'already in view: no move');
  assert.equal(G.followOffset({ ...base, offset: 0, left: 600, right: 607 }), 227, 'right of the view: the cursor ends a margin from the right edge');
  assert.equal(G.followOffset({ ...base, offset: 500, left: 100, right: 107 }), 80, 'left of the view: a margin from the left edge');
  assert.equal(G.followOffset({ ...base, offset: 500, left: 5, right: 12 }), 0, 'never past the start');
  assert.equal(G.followOffset({ ...base, offset: 0, left: 993, right: 1000 }), 600, 'never past the end');
  assert.equal(G.followOffset({ visible: 10, content: 1000, margin: 20, offset: 0, left: 500, right: 507 }), 480, 'a view too small for both margins keeps the left one');
  assert.equal(G.inView(100, 100, 107, 400), true);
  assert.equal(G.inView(100, 99, 106, 400), false);
  assert.equal(G.inView(100, 495, 501, 400), false);
});

test('the copy view hint shows in fit mode under 100 columns only', () => {
  assert.equal(G.wrapHint('fit', 52), true);
  assert.equal(G.wrapHint('fit', 100), false);
  assert.equal(G.wrapHint('wide', 52), false);
  assert.equal(G.wrapHint('fit', 0), false);
});

test('mouse reports are told apart from typed input (they never pull a wide terminal back to the cursor)', () => {
  assert.equal(G.isMouseReport('\x1b[<64;150;26M'), true, 'SGR wheel up');
  assert.equal(G.isMouseReport('\x1b[<65;3;1M'), true, 'SGR wheel down');
  assert.equal(G.isMouseReport('\x1b[<35;42;16M'), true, 'SGR motion (any-motion mode, as opencode turns on)');
  assert.equal(G.isMouseReport('\x1b[<0;10;5m'), true, 'SGR release');
  assert.equal(G.isMouseReport('\x1b[<64;1;1M\x1b[<64;1;1M'), true, 'two reports in one chunk');
  assert.equal(G.isMouseReport('\x1b[96;10;20M'), true, 'urxvt');
  assert.equal(G.isMouseReport('\x1b[M`!!'), true, 'X10');
  for (const typed of ['a', 'x', '\r', '\x1b', '\x1b[A', '\x1bOB', '\x1b[1;5D', '\x1b[3~', '\x1b[200~hello\x1b[201~', '\x1b[<64;1;1Mx', 'M', '']) {
    assert.equal(G.isMouseReport(typed), false, `typed input ${JSON.stringify(typed)}`);
  }
  assert.equal(G.isMouseReport(null), false);
});
