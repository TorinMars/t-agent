// The mouse ball of the phone terminal ("Mouse ball" in docs/design/page-terminal-mouse-ball.md): the pure parts, no DOM and no React, so they are
// tested with node (test/mouse-ball-model.test.js). MouseBall.jsx (a chunk of its own, screen-mouse-ball.jsx) draws the ball and the cursor and
// drives the terminal with them.
// Rects are { left, top, right, bottom } in CSS px of the viewport; points are { x, y }.

export const BALL_SIZE = 52; // the ball's diameter
export const DOCK_MARGIN = 2; // its gap to the right edge of the terminal when docked
export const DOCK_AT = 2 / 3; // where it docks: this far down the terminal
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

// Where the idle ball rests: at the right edge of the terminal, about two thirds down, always whole inside it (above the on-screen keyboard: the
// caller passes the visible part of the terminal). Its centre.
export function dockPosition(area) {
  const half = BALL_SIZE / 2;
  const y = area.top + (area.bottom - area.top) * DOCK_AT;
  return { x: area.right - half - DOCK_MARGIN, y: clamp(y, area.top + half, Math.max(area.top + half, area.bottom - half)) };
}

// The ball's centre for the finger at `finger`: it keeps the place where it was grabbed (`grab`: the ball's centre minus the finger at the touch),
// except near the right and bottom edges, where that grab offset shrinks with the same fade as the cursor offset (relative to how much of it there
// was at the touch, `start`: the finger then), so a ball grabbed on its right side still reaches the edge and the cursor the last column. The
// centre stays inside `area`.
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
