// Pure math of the terminal touch handler and the wide terminal (public/js/terminal-gestures.js).
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
  assert.equal(G.columnsFor(52, 'fit', 160), 52);
  assert.equal(G.columnsFor(52, 'wide', 160), 160);
  assert.equal(G.columnsFor(52, 'wide', 120), 120);
  assert.equal(G.columnsFor(230, 'wide', 200), 230, 'a wide screen keeps its own columns');
  assert.equal(G.wideCols('200'), 200);
  assert.equal(G.wideCols('999'), 160, 'an unknown choice falls back to 160');
  assert.equal(G.wideCols(null), 160);
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

test('finger travel becomes whole lines and keeps the remainder', () => {
  assert.deepEqual(G.takeLines(35, 16), { lines: 2, rest: 3 });
  assert.deepEqual(G.takeLines(-35, 16), { lines: -2, rest: -3 });
  assert.deepEqual(G.takeLines(15, 16), { lines: 0, rest: 15 });
  assert.deepEqual(G.takeLines(15, 0), { lines: 0, rest: 15 });
});

test('the speed at the lift counts only the last 100ms; a finger that stopped has none', () => {
  const samples = [{ t: 0, y: 500 }, { t: 900, y: 400 }, { t: 950, y: 380 }, { t: 1000, y: 340 }];
  assert.equal(G.velocity(samples, 1000), (400 - 340) / 100, 'up = positive (newer)');
  assert.equal(G.velocity([{ t: 0, y: 300 }, { t: 50, y: 330 }], 60), -0.6, 'down = negative (older)');
  assert.equal(G.velocity(samples, 1300), 0, 'held still before the lift');
  assert.equal(G.velocity([{ t: 0, y: 1 }], 0), 0);
  assert.ok(G.decay(1, 16) < 1 && G.decay(1, 16) > 0.9);
  assert.ok(Math.abs(G.decay(1, 32) - G.decay(G.decay(1, 16), 16)) < 1e-12, 'decay depends on time only, not on the frame rate');
});

test('the copy view hint shows in fit mode under 100 columns only', () => {
  assert.equal(G.wrapHint('fit', 52), true);
  assert.equal(G.wrapHint('fit', 100), false);
  assert.equal(G.wrapHint('wide', 52), false);
  assert.equal(G.wrapHint('fit', 0), false);
});
