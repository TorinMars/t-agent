// The mouse ball of the phone terminal (scripts/h5-shell/mouse-ball-model.mjs): the cursor offset with its edge fade, the clamp, the strip's axis,
// the stretch out of the strip and the glide back, the cell under a point, the selection range over one or several rows (also in a scrolled view), the dwell reducer with a fake clock and the scroll speed.
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

test('a drag on the wheel strip: its axis is decided after 10px, and only a slide to the left is the mouse', async () => {
  const { stripAxis, AXIS_SLOP } = await load();
  assert.equal(AXIS_SLOP, 10);
  assert.equal(stripAxis(0, 0), null);
  assert.equal(stripAxis(-9, 0), null, 'under 10px: not decided yet');
  assert.equal(stripAxis(-6, 7), null, 'under 10px in any direction');
  assert.equal(stripAxis(-10, 0), 'mouse', 'to the left: the mouse');
  assert.equal(stripAxis(-9, 5), 'mouse', 'more sideways than up or down');
  assert.equal(stripAxis(-8, -7), 'mouse', 'a little upward still counts as sideways');
  assert.equal(stripAxis(-7, 8), 'scroll', 'more down than sideways: scrolling');
  assert.equal(stripAxis(-8, -8), 'scroll', 'a diagonal is not sideways');
  assert.equal(stripAxis(0, 12), 'scroll', 'down');
  assert.equal(stripAxis(0, -12), 'scroll', 'up');
  assert.equal(stripAxis(12, 0), 'scroll', 'to the right: never the mouse');
  assert.equal(stripAxis(30, -2), 'scroll');
});

test('the stretch: its progress over 40px to the left, the thumb growing into the ball, and the glide back', async () => {
  const { stretchProgress, stretchShape, thumbAnchor, glideTarget, DETACH, THUMB_WIDTH, TAIL_WIDTH, BALL_SIZE } = await load();
  assert.equal(DETACH, 40);
  const start = { x: 380, y: 500 };
  assert.equal(stretchProgress(start, { x: 380, y: 500 }), 0);
  near(stretchProgress(start, { x: 355, y: 500 }), 25 / 40, '25px: not detached yet');
  near(stretchProgress(start, { x: 355, y: 540 }), 25 / 40, 'only the travel to the left counts');
  assert.equal(stretchProgress(start, { x: 340, y: 500 }), 1, '40px: detached');
  assert.equal(stretchProgress(start, { x: 300, y: 500 }), 1, 'never more than 1');
  assert.equal(stretchProgress(start, { x: 395, y: 500 }), 0, 'back to the right: 0');
  // The tail hangs on the thumb: the touch height inside it, or its nearest end.
  const thumb = { left: 381, top: 480, right: 387, bottom: 530 };
  assert.deepEqual(thumbAnchor(thumb, 500), { x: 384, y: 500 });
  assert.deepEqual(thumbAnchor(thumb, 300), { x: 384, y: 480 }, 'a touch above the thumb: its top');
  assert.deepEqual(thumbAnchor(thumb, 700), { x: 384, y: 530 }, 'below it: its bottom');
  const root = thumbAnchor(thumb, 500);
  const none = stretchShape(root, { x: 384, y: 500 }, 0);
  assert.equal(none.size, THUMB_WIDTH, 'at 0 the head is the thumb');
  near(none.scale, THUMB_WIDTH / BALL_SIZE, 'its scale of the ball');
  const half = stretchShape(root, { x: 360, y: 510 }, 0.5);
  assert.equal(half.size, THUMB_WIDTH + (BALL_SIZE - THUMB_WIDTH) / 2, 'halfway: halfway to the ball');
  assert.deepEqual(half.head, { x: 360, y: 510 }, 'the head is under the finger');
  assert.deepEqual(half.tail, { x1: 384, y1: 500, x2: 360, y2: 510, width: TAIL_WIDTH }, 'the tail from the thumb to the head, at most 20px wide');
  const small = stretchShape(root, { x: 375, y: 500 }, 0.2);
  assert.equal(small.tail.width, small.size, 'a small head: the tail is as wide as the head');
  const full = stretchShape(root, { x: 340, y: 500 }, 1);
  assert.equal(full.size, BALL_SIZE, 'at 1 it is the 52px ball');
  assert.equal(full.scale, 1);
  assert.equal(stretchShape(root, { x: 395, y: 500 }, 0).head.x, 384, 'never right of the strip');
  assert.equal(stretchShape(root, { x: 340, y: 500 }, 3).size, BALL_SIZE, 'the progress is clamped');
  // The glide back: the middle of the thumb where it is now, inside the visible terminal.
  assert.deepEqual(glideTarget(thumb, AREA), { x: 384, y: 505 });
  assert.deepEqual(glideTarget({ left: 381, top: 700, right: 387, bottom: 740 }, AREA), { x: 384, y: 656 }, 'a thumb under the keyboard: the bottom of the visible terminal');
  assert.equal(BALL_SIZE, 52);
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

test('joinSelection: soft-wrapped rows continue, rows a program wrapped itself are one line again, anything else keeps its line break', async () => {
  const { joinSelection } = await load();
  const COLS = 36;
  const row = (text, extra = {}) => ({ text, wrapped: false, full: true, length: text.trimEnd().length, ...extra });
  const join = rows => joinSelection(rows, COLS);
  assert.equal(join([row('one line')]), 'one line');
  assert.equal(join([row('The quick brown fox '), row('jumps over', { wrapped: true })]), 'The quick brown fox jumps over', 'xterm soft wrap: as is');
  // The program cut the line at a space because the next word did not fit.
  assert.equal(join([row('She worked hard to accomplish her'), row('goal before the deadline.')]), 'She worked hard to accomplish her goal before the deadline.', 'one space');
  assert.equal(join([row('She worked hard to accomplish her'), row('goal before the deadline, and then'), row('rested.')]), 'She worked hard to accomplish her goal before the deadline, and then rested.', 'several rows');
  // The row ends far from the edge but the next word is long: it would not have fitted.
  assert.equal(join([row('Short line here'), row('unbelievablylongwordthatwouldnotfitonthatline')]), 'Short line here unbelievablylongwordthatwouldnotfitonthatline');
  assert.equal(join([row('A short line'), row('another line')]), 'A short line\nanother line', 'a row that did not need to break ends its line');
  assert.equal(join([row('https://example.com/a/very/long/pa'), row('th/in/the/middle')]), 'https://example.com/a/very/long/path/in/the/middle', 'a cut word: joined with nothing');
  assert.equal(join([row('see https://example.com/a/very/lon'), row('continues here')]), 'see https://example.com/a/very/lon continues here', 'a row with words: one space');
  assert.equal(join([row('A line that fills the whole width of'), row('')]), 'A line that fills the whole width of\n', 'a blank row stays');
  assert.equal(join([row('Items that run to the edge of screen'), row('- second item')]), 'Items that run to the edge of screen\n- second item', 'a list item starts a line');
  assert.equal(join([row('A line that fills the whole width of'), row('2. numbered')]), 'A line that fills the whole width of\n2. numbered');
  assert.equal(join([row('wrapped here at the very edge of th'), row('   indented rest')]), 'wrapped here at the very edge of th indented rest', 'the indent of the rest is dropped');
  assert.equal(join([row('She worked hard to accomplish her', { full: false }), row('goal before the deadline.')]), 'She worked hard to accomplish her\ngoal before the deadline.', 'a selection that stops inside a row does not join');
});

test('the edge scroll counts whole lines per frame and keeps the fraction', async () => {
  const { scrollStep } = await load();
  assert.deepEqual(scrollStep(0, 0, 16), { lines: 0, carry: 0 }, 'no speed: nothing, the fraction is dropped');
  assert.deepEqual(scrollStep(0.7, 0, 16), { lines: 0, carry: 0 });
  let step = scrollStep(0, 40, 16); // 0.64 of a line
  assert.equal(step.lines, 0);
  near(step.carry, 0.64, 'the fraction is kept');
  step = scrollStep(step.carry, 40, 16);
  assert.equal(step.lines, 1, 'two frames make a line');
  near(step.carry, 0.28, 'and the rest is kept');
  step = scrollStep(0, -40, 50);
  assert.equal(step.lines, -2, 'upward: negative lines');
  near(step.carry, 0, 'nothing left');
  let lines = 0;
  let carry = 0;
  for (let i = 0; i < 60; i++) ({ lines: step.lines, carry } = scrollStep(carry, 4, 1000 / 60), lines += step.lines);
  near(lines + carry, 4, '4 lines per second over one second of frames');
  assert.ok(lines >= 3, `whole lines were scrolled on the way (${lines})`);
});

test('the button goes to the program while it reports the mouse, else to the page; what each tracking mode is sent', async () => {
  const { buttonMode, programReports } = await load();
  assert.equal(buttonMode('none'), 'page', 'no mouse reporting: the page selects');
  assert.equal(buttonMode(undefined), 'page', 'an xterm without modes: the page');
  for (const mode of ['x10', 'vt200', 'drag', 'any']) assert.equal(buttonMode(mode), 'program', mode);
  assert.deepEqual(programReports('x10'), { release: false, motion: false, wheel: false }, 'x10: the press only');
  assert.deepEqual(programReports('vt200'), { release: true, motion: false, wheel: true }, 'vt200: press, release and wheel');
  assert.deepEqual(programReports('drag'), { release: true, motion: true, wheel: true }, 'drag: and the motion with the button held');
  assert.deepEqual(programReports('any'), { release: true, motion: true, wheel: true });
});
