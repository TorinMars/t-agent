// The mouse ball of the phone terminal (scripts/h5-shell/mouse-ball-model.mjs): the cursor offset with its edge fade, the clamp, the dock, the cell
// under a point, the selection range over one or several rows (also in a scrolled view), the dwell reducer with a fake clock and the scroll speed.
// The real page is scripts/test-h5-mouse-ball-browser.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'h5-shell', 'mouse-ball-model.mjs')).href);
const AREA = { left: 0, top: 56, right: 390, bottom: 656 }; // a 390px phone, a 600px tall terminal under the 56px header
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);

test('the cursor is 46px left of and above the ball, and the offset fades to 0 over the last 80px before the right and bottom edges', async () => {
  const { cursorOffset, cursorFor, OFFSET, EDGE_FADE } = await load();
  assert.equal(OFFSET, 46);
  assert.equal(EDGE_FADE, 80);
  assert.deepEqual(cursorOffset({ x: 200, y: 300 }, AREA), { x: 46, y: 46 }, 'away from the edges: the full offset');
  assert.deepEqual(cursorFor({ x: 200, y: 300 }, AREA), { x: 154, y: 254 });
  near(cursorOffset({ x: 350, y: 300 }, AREA).x, 23, 'halfway into the right fade: half the sideways offset');
  assert.equal(cursorOffset({ x: 350, y: 300 }, AREA).y, 46, 'the upward offset does not fade near the right edge');
  assert.equal(cursorOffset({ x: 310, y: 300 }, AREA).x, 46, 'exactly 80px from the edge: still the full offset');
  assert.equal(cursorOffset({ x: 390, y: 300 }, AREA).x, 0, 'at the right edge: straight above the ball');
  near(cursorOffset({ x: 200, y: 616 }, AREA).y, 23, 'halfway into the bottom fade');
  assert.deepEqual(cursorOffset({ x: 390, y: 656 }, AREA), { x: 0, y: 0 }, 'in the bottom-right corner: under the ball');
  // It glides: no jump anywhere along the way to the edge.
  let last = cursorFor({ x: 250, y: 300 }, AREA).x;
  for (let x = 251; x <= 390; x++) {
    const now = cursorFor({ x, y: 300 }, AREA).x;
    assert.ok(now >= last - 1e-9 && now - last <= 1 + 46 / 80 + 1e-9, `the cursor moves smoothly at x=${x}`);
    last = now;
  }
});

test('the cursor stays inside the visible cells, and at the right edge it reaches the last column', async () => {
  const { cursorFor, cellFromPoint } = await load();
  const bounds = { left: 4, top: 60, right: 386, bottom: 650 };
  assert.deepEqual(cursorFor({ x: 20, y: 70 }, AREA, bounds), { x: 4, y: 60 }, 'top-left: clamped to the first cell');
  const edge = cursorFor({ x: 390, y: 300 }, AREA, bounds);
  assert.equal(edge.x, 385.5, 'right edge: just inside the last cell');
  const screen = { left: 4, top: 60, right: 386, bottom: 650 };
  const cols = 53;
  assert.equal(cellFromPoint(edge, screen, cols, 33).col, cols, 'the boundary after the last column: a selection includes it');
  const bottom = cursorFor({ x: 200, y: 656 }, AREA, bounds);
  assert.equal(bottom.y, 649.5);
  assert.equal(cellFromPoint(bottom, screen, cols, 33).row, 32, 'the last row');
});

test('the idle ball docks at the right edge about two thirds down, whole inside the visible terminal', async () => {
  const { dockPosition, BALL_SIZE, DOCK_MARGIN } = await load();
  assert.equal(BALL_SIZE, 52);
  assert.deepEqual(dockPosition(AREA), { x: 390 - 26 - DOCK_MARGIN, y: 56 + 400 });
  // The keyboard leaves only 200px of the terminal: still whole inside it.
  const small = { left: 0, top: 56, right: 390, bottom: 256 };
  const dock = dockPosition(small);
  assert.ok(dock.y + 26 <= 256 && dock.y - 26 >= 56, `inside (${dock.y})`);
  const tiny = { left: 0, top: 56, right: 390, bottom: 90 };
  assert.equal(dockPosition(tiny).y, 56 + 26, 'too small: at the top, never above it');
});

test('the ball keeps the grab point, but near the edges the grab offset fades, so it reaches the edge; it stays inside the area', async () => {
  const { ballFor } = await load();
  const start = { x: 200, y: 300 };
  assert.deepEqual(ballFor({ x: 150, y: 250 }, { x: 10, y: -5 }, start, AREA), { x: 160, y: 245 }, 'it follows the finger from where it was grabbed');
  // Grabbed on its right side (the centre 18px left of the finger): at the right edge the centre is under the finger.
  assert.equal(ballFor({ x: 390, y: 300 }, { x: -18, y: 0 }, start, AREA).x, 390);
  // A touch that began in the fade zone (the docked ball) keeps its grab until the finger moves further in.
  const dock = { x: 362, y: 456 };
  assert.deepEqual(ballFor(dock, { x: 6, y: 4 }, dock, AREA), { x: 368, y: 460 }, 'no jump at the touch');
  assert.equal(ballFor({ x: 390, y: 456 }, { x: 6, y: 4 }, dock, AREA).x, 390, 'at the edge: no grab left, and clamped');
  assert.deepEqual(ballFor({ x: -40, y: 900 }, { x: 0, y: 0 }, start, AREA), { x: 0, y: 656 }, 'clamped inside the area');
});

test('the cell under a point: a column boundary and a buffer row, with the scrolled view', async () => {
  const { cellFromPoint } = await load();
  const screen = { left: 4, top: 60, right: 404, bottom: 660 }; // 40 cols of 10px, 30 rows of 20px
  assert.deepEqual(cellFromPoint({ x: 4, y: 60 }, screen, 40, 30), { col: 0, row: 0 });
  assert.deepEqual(cellFromPoint({ x: 48, y: 79 }, screen, 40, 30), { col: 4, row: 0 }, 'the nearest boundary (4.4 cells)');
  assert.deepEqual(cellFromPoint({ x: 50, y: 80 }, screen, 40, 30), { col: 5, row: 1 }, '4.6 cells: the boundary after the fifth');
  assert.deepEqual(cellFromPoint({ x: 100, y: 100 }, screen, 40, 30, 250), { col: 10, row: 252 }, 'scrolled: the buffer row is the screen row plus viewportY');
  assert.deepEqual(cellFromPoint({ x: 999, y: 999 }, screen, 40, 30, 5), { col: 40, row: 34 }, 'outside: the nearest cell');
});

test('the selection from the press point to the cursor is one start and a length, in either direction, over rows', async () => {
  const { selectionRange } = await load();
  assert.deepEqual(selectionRange({ col: 3, row: 2 }, { col: 9, row: 2 }, 40), { col: 3, row: 2, length: 6 }, 'one row, to the right');
  assert.deepEqual(selectionRange({ col: 9, row: 2 }, { col: 3, row: 2 }, 40), { col: 3, row: 2, length: 6 }, 'one row, to the left');
  assert.equal(selectionRange({ col: 7, row: 4 }, { col: 7, row: 4 }, 40), null, 'nothing between them');
  assert.deepEqual(selectionRange({ col: 21, row: 5 }, { col: 27, row: 6 }, 40), { col: 21, row: 5, length: 19 + 27 }, 'two rows: the rest of the first and the start of the next');
  assert.deepEqual(selectionRange({ col: 10, row: 103 }, { col: 30, row: 100 }, 40), { col: 30, row: 100, length: 3 * 40 - 20 }, 'upwards over several rows, in the scrolled buffer');
  assert.deepEqual(selectionRange({ col: 0, row: 7 }, { col: 40, row: 7 }, 40), { col: 0, row: 7, length: 40 }, 'a whole row up to the boundary after its last column');
});

test('the dwell: 600 ms still presses; a move of more than 6px restarts it; lifting or cancelling ends it', async () => {
  const { dwellStep, dwellProgress, DWELL_IDLE, DWELL_MS, DWELL_SLOP } = await load();
  assert.equal(DWELL_MS, 600);
  assert.equal(DWELL_SLOP, 6);
  let state = dwellStep(DWELL_IDLE, { type: 'down', x: 100, y: 100, t: 1000 });
  assert.equal(state.phase, 'waiting');
  assert.equal(dwellProgress(state, 1300), 0.5, 'half the ring');
  state = dwellStep(state, { type: 'move', x: 104, y: 103, t: 1200 });
  assert.equal(state.since, 1000, 'a move of 5px is still "still"');
  assert.equal(dwellStep(state, { type: 'tick', t: 1599 }).phase, 'waiting');
  const pressed = dwellStep(state, { type: 'tick', t: 1600 });
  assert.equal(pressed.phase, 'pressed', 'pressed at 600 ms');
  assert.equal(dwellProgress(pressed, 1600), 1);
  // A real move restarts the clock from the new place.
  state = dwellStep(state, { type: 'move', x: 110, y: 100, t: 1500 });
  assert.deepEqual(state, { phase: 'waiting', since: 1500, x: 110, y: 100 });
  assert.equal(dwellStep(state, { type: 'tick', t: 1700 }).phase, 'waiting', 'the old wait is gone');
  assert.equal(dwellStep(state, { type: 'tick', t: 2100 }).phase, 'pressed');
  // A move that comes after the wait was over presses first (where the ball stood), and then only selects.
  const late = dwellStep(state, { type: 'move', x: 160, y: 140, t: 2200 });
  assert.deepEqual(late, { phase: 'pressed', since: 2200, x: 110, y: 100 });
  assert.equal(dwellStep(late, { type: 'move', x: 300, y: 300, t: 2300 }), late, 'pressed stays pressed while moving');
  assert.equal(dwellStep(late, { type: 'up' }), DWELL_IDLE);
  assert.equal(dwellStep(state, { type: 'cancel' }), DWELL_IDLE);
  assert.equal(dwellProgress(DWELL_IDLE, 5000), 0);
  assert.equal(dwellStep(DWELL_IDLE, { type: 'tick', t: 9999 }), DWELL_IDLE, 'no finger: nothing happens');
});

test('scrolling with the button down: within 24px of the top (older) or bottom (newer) edge, faster nearer the edge', async () => {
  const { scrollSpeed, SCROLL_ZONE, SCROLL_MIN, SCROLL_MAX } = await load();
  const bounds = { left: 0, top: 60, right: 390, bottom: 660 };
  assert.equal(SCROLL_ZONE, 24);
  assert.equal(scrollSpeed(300, bounds), 0, 'the middle: no scrolling');
  assert.equal(scrollSpeed(60 + 24, bounds), 0, 'just outside the top zone');
  assert.equal(scrollSpeed(60, bounds), -SCROLL_MAX, 'at the top edge: fastest, upwards');
  assert.equal(scrollSpeed(659.5, bounds) > 0, true, 'at the bottom: downwards');
  near(scrollSpeed(660, bounds), SCROLL_MAX, 'at the very bottom edge');
  near(scrollSpeed(60 + 12, bounds), -(SCROLL_MIN + (SCROLL_MAX - SCROLL_MIN) / 2), 'halfway into the zone: halfway between the speeds');
  assert.ok(Math.abs(scrollSpeed(65, bounds)) > Math.abs(scrollSpeed(75, bounds)), 'nearer is faster');
});

test('intersect: the visible part of two rects, or null', async () => {
  const { intersect } = await load();
  assert.deepEqual(intersect({ left: 0, top: 56, right: 390, bottom: 740 }, { left: 0, top: 0, right: 390, bottom: 500 }), { left: 0, top: 56, right: 390, bottom: 500 });
  assert.equal(intersect({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 20, top: 0, right: 30, bottom: 10 }), null);
});
