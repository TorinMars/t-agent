// The mouse ball of the phone terminal ("Mouse ball" in docs/design/page-terminal-mouse-ball.md): the pure parts, no DOM and no React, so they are
// tested with node (test/mouse-ball-model.test.js). MouseBall.jsx (a chunk of its own, screen-mouse-ball.jsx) draws the ball and the cursor and
// drives the terminal with them. The ball comes out of the mouse handle when it is slid toward the inside; a vertical drag on the handle scrolls.
// Rects are { left, top, right, bottom } in CSS px of the viewport; points are { x, y }.

export const BALL_SIZE = 52; // the ball's diameter
export const AXIS_SLOP = 10; // px a finger on the mouse handle travels before its axis is decided (scroll or mouse)
export const DETACH = 40; // px of travel toward the inside at which the stretched handle lets go and becomes the ball
export const TAIL_WIDTH = 20; // the widest the stretched tail gets
export const GLIDE_MS = 220; // the ball's glide back into the handle
export const OFFSET = 46; // the cursor is this far left of and above the ball's centre, so the finger never covers it
export const EDGE_FADE = 80; // over the last px before the right (bottom) edge, the sideways (upward) offset shrinks to 0
export const DWELL_MS = 600; // a ball kept still this long presses the left button
export const DWELL_SLOP = 6; // px the finger may move while the ball counts as still
export const SCROLL_ZONE = 24; // px from the top or bottom edge where a held button scrolls the terminal
export const SCROLL_MIN = 4; // lines per second at the inner edge of the zone
export const SCROLL_MAX = 40; // lines per second at the very edge

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const fade = distance => clamp(distance / EDGE_FADE, 0, 1);

// The visible part of two rects (the terminal box and the visual viewport, or that and the xterm screen); null when they do not overlap.
export function intersect(a, b) {
  const box = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  return box.right > box.left && box.bottom > box.top ? box : null;
}

// The axis of a one-finger drag on the mouse handle, from its travel (dx, dy) since the touch: null while it is shorter than AXIS_SLOP, then
// 'mouse' for a slide more sideways than up or down AND toward the inside of the screen (the ball comes out), 'scroll' for a drag at least as
// much up or down as sideways (the handle scrolls the terminal), else 'none' (a slide toward the edge: nothing happens). `side`: the edge the
// handle sits on, 'right' (the slide is to the left) or 'left' (the slide is to the right). The caller keeps the first answer that is not null until
// the lift: a drag that started vertical stays a scroll and never becomes the mouse.
const inward = side => (side === 'left' ? 1 : -1);
export function handleAxis(dx, dy, side = 'right') {
  if (Math.hypot(dx, dy) < AXIS_SLOP) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx * inward(side) > 0 ? 'mouse' : 'none';
  return 'scroll';
}

// How far the handle is stretched (0 to 1) for the finger at `finger` after a touch at `start`: the travel toward the inside (to the
// left for `side` 'right', to the right for 'left') over DETACH px. At 1 it lets go and is the ball. A finger back toward the edge is 0.
export function stretchProgress(start, finger, side = 'right') {
  return clamp(((finger.x - start.x) * inward(side)) / DETACH, 0, 1);
}

// Where the stretch hangs on the handle: the bar's x, at the touch's height kept inside the bar (`bar`: its rect; a touch beside the bar
// stretches from its nearest end).
export function barAnchor(bar, y) {
  return { x: (bar.left + bar.right) / 2, y: clamp(y, bar.top, bar.bottom) };
}

// The stretched handle at `progress` (stretchProgress): a head under the finger (never outside the handle: not right of it on the right edge,
// not left of it on the left edge, `side`) that grows from the bar's width (`from`) to the ball (`size`, `scale` of the 52px ball), and a tail
// from `root` (barAnchor) to the head, as wide as the head up to TAIL_WIDTH.
export function stretchShape(root, finger, progress, side = 'right', from = HANDLE.width) {
  const p = clamp(progress, 0, 1);
  const size = from + (BALL_SIZE - from) * p;
  const head = { x: side === 'left' ? Math.max(finger.x, root.x) : Math.min(finger.x, root.x), y: finger.y };
  return { head, size, scale: size / BALL_SIZE, tail: { x1: root.x, y1: root.y, x2: head.x, y2: head.y, width: Math.min(size, TAIL_WIDTH) } };
}

// Where the ball glides back to at the lift: the middle of the handle's bar (`bar`: its rect), kept inside the visible terminal `area` (a bar
// under the on-screen keyboard is not followed out of sight).
export function glideTarget(bar, area) {
  return { x: clamp((bar.left + bar.right) / 2, area.left, area.right), y: clamp((bar.top + bar.bottom) / 2, area.top, area.bottom) };
}

// The ball's centre for the finger at `finger`: it keeps the place where it was grabbed (`grab`: the ball's centre minus the finger at the touch),
// except near the right and bottom edges, where that grab offset shrinks with the same fade as the cursor offset (relative to how much of it there
// was at the touch, `start`: the finger then), so a ball grabbed on its right side still reaches the edge and the cursor the last column. The
// centre stays inside `area`. (Out of the handle the ball is under the finger: no grab.)
export function ballFor(finger, grab, start, area) {
  const scale = (now, then) => (then > 0 ? Math.min(1, now / then) : 0);
  const gx = scale(fade(area.right - finger.x), fade(area.right - start.x));
  const gy = scale(fade(area.bottom - finger.y), fade(area.bottom - start.y));
  return { x: clamp(finger.x + grab.x * gx, area.left, area.right), y: clamp(finger.y + grab.y * gy, area.top, area.bottom) };
}

// How far the cursor is from the ball's centre: OFFSET left and up, shrinking linearly to 0 over the last EDGE_FADE px before the right edge
// (sideways) and the bottom edge (upward) of `area`, so the cursor can reach the last column and the last row.
export function cursorOffset(ball, area) {
  return { x: OFFSET * fade(area.right - ball.x), y: OFFSET * fade(area.bottom - ball.y) };
}

// The cursor (the corner of its two lines, the mouse position) for the ball at `ball`, kept inside `bounds` (the visible cells of the terminal).
export function cursorFor(ball, area, bounds = area) {
  const offset = cursorOffset(ball, area);
  return { x: clamp(ball.x - offset.x, bounds.left, bounds.right - 0.5), y: clamp(ball.y - offset.y, bounds.top, bounds.bottom - 0.5) };
}

// The cell under a point of the xterm screen (`screen`: its bounding box, which includes the 4px inset, a sideways offset and the keyboard
// shift), as a column boundary (0 to cols: the edge between two cells nearest to the point, as a mouse selection counts it) and a buffer row
// (the screen row plus `viewportY`, the first buffer line shown). Points outside the screen count as its nearest cell.
export function cellFromPoint(point, screen, cols, rows, viewportY = 0) {
  const width = (screen.right - screen.left) / cols;
  const height = (screen.bottom - screen.top) / rows;
  const col = clamp(Math.round((point.x - screen.left) / width), 0, cols);
  const row = clamp(Math.floor((point.y - screen.top) / height), 0, rows - 1);
  return { col, row: row + viewportY };
}

// The selection from the press point `a` to the cursor `b` (cells of cellFromPoint) in xterm's terms, `term.select(col, row, length)`: the
// buffer runs row after row, so a range over several rows (wrapped or not) is one start and a length. null when nothing is between them.
export function selectionRange(a, b, cols) {
  const at = cell => cell.row * cols + cell.col;
  const first = Math.min(at(a), at(b));
  const length = Math.abs(at(a) - at(b));
  if (!length) return null;
  return { col: first % cols, row: Math.floor(first / cols), length };
}

// The text of a selection, joined the way a person reads it ("Copy" in docs/design/page-terminal-mouse-ball.md). `rows`: one entry per buffer row
// of the selection, { text (the selected part of the row), wrapped (xterm soft-wrapped it onto the row before), full (the selection runs to the end
// of the row), length (the length of the whole row without its trailing blanks) }; `cols`: the terminal width. A soft-wrapped row continues the one
// before it as it is. A row that a program wrapped itself (Claude Code and Codex cut their lines at the width) is one line again when the row before
// runs to the right edge (within HARD_WRAP_SLACK columns: a long word, a path or an address cut in the middle) or when the first word of this row
// would not have fitted after it (a break at a space): joined with one space, or with nothing after a cut word. A row that starts a list item, a
// quote, a heading or a table row, a blank row and a row after a short row are new lines.
export const HARD_WRAP_SLACK = 2;
const NEW_LINE_START = /^\s*([-*+\u2022>|#\u2502]|\d+[.)])(\s|$)/;
function continues(before, row, cols) {
  if (!before.full || !row.text.trim() || NEW_LINE_START.test(row.text)) return false;
  if (before.length >= cols - HARD_WRAP_SLACK) return 'cut';
  const word = /^\s*(\S+)/.exec(row.text)[1];
  return before.length + 1 + word.length > cols ? 'space' : false;
}
export function joinSelection(rows, cols) {
  let out = '';
  rows.forEach((row, index) => {
    if (!index) { out = row.text; return; }
    const before = rows[index - 1];
    if (row.wrapped) { out += row.text; return; }
    const how = continues(before, row, cols);
    if (how) {
      const glue = how === 'space' || /\s/.test(before.text.trim()) ? ' ' : '';
      out = out.replace(/\s+$/, '') + glue + row.text.replace(/^\s+/, '');
      return;
    }
    out += `\n${row.text}`;
  });
  return out;
}

// Scrolling while the button is down: lines per second for the cursor at height `y` inside `bounds`: negative (older lines) within SCROLL_ZONE px
// of the top edge, positive (newer) within it of the bottom edge, faster the nearer the edge (SCROLL_MIN to SCROLL_MAX); 0 elsewhere.
export function scrollSpeed(y, bounds) {
  const speed = distance => SCROLL_MIN + (SCROLL_MAX - SCROLL_MIN) * (1 - clamp(distance, 0, SCROLL_ZONE) / SCROLL_ZONE);
  const top = y - bounds.top;
  const bottom = bounds.bottom - y;
  if (top < SCROLL_ZONE && top <= bottom) return -speed(top);
  if (bottom < SCROLL_ZONE) return speed(bottom);
  return 0;
}

// The lines to scroll in one frame of `dt` ms at `speed` lines per second (scrollSpeed), with the fraction left from the frames before (`carry`):
// { lines (whole lines, signed), carry (the new fraction) }. A speed of 0 drops the fraction.
export function scrollStep(carry, speed, dt) {
  if (!speed) return { lines: 0, carry: 0 };
  const total = carry + (speed * dt) / 1000;
  const lines = Math.trunc(total);
  return { lines, carry: total - lines };
}

// Who gets the button ("Two modes" in docs/design/page-terminal-mouse-ball.md), decided once at the press and kept until the lift: 'program'
// when the program in the terminal turned mouse reporting on (xterm `term.modes.mouseTrackingMode`: 'x10', 'vt200', 'drag' or 'any'), so the
// press, the motion and the release go to the program and it selects and copies by itself; 'page' otherwise (the page's own selection and copy).
export function buttonMode(tracking) {
  return tracking && tracking !== 'none' ? 'program' : 'page';
}
// What the ball sends a program in mouse tracking mode `tracking` besides the press: the release (not in x10, which reports presses only),
// motion with the button held (drag and any), wheel steps for the edge scroll (not in x10) and, before the press, hover motion with no button
// (only any, mode 1003: the only mode in which xterm, like a real terminal, reports a mouse that moves without a button).
export function programReports(tracking) {
  return { release: tracking !== 'x10', motion: tracking === 'drag' || tracking === 'any', wheel: tracking !== 'x10', hover: tracking === 'any' };
}

// The dwell that presses the button, as a reducer over the touch and a clock (the time `t` of each event, in ms):
//   idle    no finger on the ball
//   waiting the finger is down and the ball counts how long it has been still (`since`, from the point x, y)
//   pressed the left button is down (from the dwell on, until the finger is lifted)
// Events: { type: 'down', x, y, t }, { type: 'move', x, y, t }, { type: 'tick', t }, { type: 'up' }, { type: 'cancel' }. A move of more than
// DWELL_SLOP px from where the wait began starts it again from there; a move after the button went down only selects.
export const DWELL_IDLE = Object.freeze({ phase: 'idle' });
export function dwellStep(state, event) {
  switch (event.type) {
    case 'down': return { phase: 'waiting', since: event.t, x: event.x, y: event.y };
    case 'tick':
      return state.phase === 'waiting' && event.t - state.since >= DWELL_MS ? { phase: 'pressed', since: event.t, x: state.x, y: state.y } : state;
    case 'move': {
      const now = dwellStep(state, { type: 'tick', t: event.t }); // a wait that is over presses first, from where the ball stood
      if (now.phase !== 'waiting') return now;
      return Math.hypot(event.x - now.x, event.y - now.y) > DWELL_SLOP ? { phase: 'waiting', since: event.t, x: event.x, y: event.y } : now;
    }
    case 'up':
    case 'cancel': return DWELL_IDLE;
    default: return state;
  }
}
// How full the ring around the ball is (0 to 1) at time `t`.
export function dwellProgress(state, t) {
  if (state.phase === 'pressed') return 1;
  return state.phase === 'waiting' ? clamp((t - state.since) / DWELL_MS, 0, 1) : 0;
}

// ── The mouse handle ("The mouse handle" in docs/design/page-terminal-mouse-ball.md) ──
// A small bar of its own on the left or right edge of the terminal: a drag up or down scrolls the terminal (springScroll), a slide toward the inside
// pulls the ball out of it (handleAxis, stretchProgress and stretchShape with its `side`), a long press picks it up to be moved, and the lift snaps
// it to the nearest edge. Its place is kept per device as { edge: 'left' | 'right', y } (y: the bar's centre as a fraction of the visible terminal's
// height; null: the default height).
export const HANDLE = Object.freeze({
  width: 11, height: 64, // the drawn bar at rest
  moveWidth: 18, moveHeight: 84, // the drawn bar while it is moved
  hitWidth: 44, hitHeight: 72, // the box that takes the touch (at least 44px in touch input), the bar inside it at the edge
  inset: 2, // the bar's gap to the edge (the browser's edge swipe stays free)
  bottom: 68, // the default height: the centre this far above the bottom of the terminal (the bar ends 36px above it, clear of the key row)
});
export const HOLD_MS = 500; // a handle held still this long is picked up to be moved
export const HOLD_SLOP = 6; // px the finger may move while the handle counts as held still (as DWELL_SLOP)
export const SNAP_MS = 160; // the glide to the nearest edge after a move
export const DEFAULT_PLACE = Object.freeze({ edge: 'right', y: null });

// The stored place, read safely: anything but { edge: 'left' | 'right', y: a number from 0 to 1 or null } falls back to the default (a bad height
// alone keeps the edge and takes the default height).
export function parsePlace(text) {
  let value = null;
  try { value = typeof text === 'string' ? JSON.parse(text) : null; } catch { value = null; }
  if (!value || typeof value !== 'object' || (value.edge !== 'left' && value.edge !== 'right')) return DEFAULT_PLACE;
  if (value.y === null || value.y === undefined) return { edge: value.edge, y: null };
  return typeof value.y === 'number' && Number.isFinite(value.y) && value.y >= 0 && value.y <= 1 ? { edge: value.edge, y: value.y } : { edge: value.edge, y: null };
}
export function serializePlace(place) {
  const y = typeof place.y === 'number' && Number.isFinite(place.y) ? Math.round(clamp(place.y, 0, 1) * 1000) / 1000 : null;
  return JSON.stringify({ edge: place.edge === 'left' ? 'left' : 'right', y });
}
// The edge nearer to x within `area` (the right one exactly in the middle, where it starts).
export function nearestEdge(x, area) {
  return x < (area.left + area.right) / 2 ? 'left' : 'right';
}
// A centre for a box of `w` x `h` kept inside `area` (in a terminal too small for it: its middle).
export function clampCentre(point, area, w, h) {
  const fit = (value, low, high) => (high < low ? (low + high) / 2 : clamp(value, low, high));
  return { x: fit(point.x, area.left + w / 2, area.right - w / 2), y: fit(point.y, area.top + h / 2, area.bottom - h / 2) };
}
// The centre of the handle's bar at `place` in `area` (the visible terminal): on its edge, `inset` from it, at its height (by default HANDLE.bottom
// above the bottom), kept so that its touch box stays inside the terminal.
export function handleCentre(place, area) {
  const y = place.y === null ? area.bottom - HANDLE.bottom : area.top + place.y * (area.bottom - area.top);
  const x = place.edge === 'left' ? area.left + HANDLE.inset + HANDLE.width / 2 : area.right - HANDLE.inset - HANDLE.width / 2;
  return { x, y: clampCentre({ x, y }, area, 0, HANDLE.hitHeight).y };
}
// Where a handle let go at `centre` goes: the nearest edge at that height (kept inside), and the place to keep.
export function snapPlace(centre, area) {
  const height = area.bottom - area.top;
  const y = clampCentre(centre, area, 0, HANDLE.hitHeight).y;
  const place = { edge: nearestEdge(centre.x, area), y: height > 0 ? clamp((y - area.top) / height, 0, 1) : null };
  return { place, centre: handleCentre(place, area) };
}
// A finger on the handle still counts as held still: within HOLD_SLOP px of the touch.
export function heldStill(from, at) {
  return Math.hypot(at.x - from.x, at.y - from.y) <= HOLD_SLOP;
}

// ── Scrolling with the handle ("Scrolling" in "The mouse handle", docs/design/page-terminal-mouse-ball.md) ──
// A vertical drag on the handle pulls it up or down from where it rests, like the old spring of the wheel strip: pulled up scrolls to older lines,
// pulled down to newer, faster the further it is pulled; let go, it springs back and the scrolling stops.
export const SPRING = Object.freeze({
  dead: 6, // px of pull that do not scroll yet
  rate: 8, // lines per second for each terminal row of pull beyond the dead zone
  max: 200, // lines per second at most
  reach: 0.42, // the pull counts up to this share of the visible terminal's height
});
export const SPRING_MS = 200; // the handle's spring back to its place after a scroll
export const STALE_MS = 3000; // a finger with no pointer event for this long stops the scrolling (a lost pointerup must not keep it)
// The pull for a finger `dy` px below the touch (negative: above it) in a visible terminal `height` px tall, at most SPRING.reach of it either way.
export function springPull(dy, height) {
  const reach = Math.max(0, height) * SPRING.reach;
  return clamp(dy, -reach, reach);
}
// Lines per second for a pull of `pull` px with terminal rows `rowHeight` px tall: signed like the pull (negative: older lines), 0 inside the dead
// zone, at most SPRING.max. Feed it to scrollStep with the time of each frame.
export function springSpeed(pull, rowHeight) {
  const beyond = Math.abs(pull) - SPRING.dead;
  if (beyond <= 0) return 0;
  return Math.sign(pull) * Math.min(SPRING.max, (SPRING.rate * beyond) / Math.max(1, rowHeight));
}
