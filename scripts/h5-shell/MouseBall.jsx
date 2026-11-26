// The mouse ball of the phone terminal ("Mouse ball" in docs/design/page-terminal-mouse-ball.md). A chunk of its own (screen-mouse-ball.jsx), drawn
// by App.jsx through lazy-screens.jsx while it is on for this device (More > Mouse ball, h5.js `setMouseBall`) in touch input on a phone.
// - Idle: a 52px half transparent ball docked at the right edge of the visible terminal, about two thirds down (above the on-screen keyboard). It
//   takes touches only on itself; the terminal scrolls and takes taps as before.
// - Touch and move: the ball follows the finger; the cursor (the top-left corner of a square, two lines; the corner is the mouse position) shows 46px
//   left of and above it, with a dashed line between them; near the right and bottom edges that offset fades out (mouse-ball-model.mjs).
// - Keep still for 600 ms: a ring fills around the ball, then the left button goes down at the cursor (a haptic tick, the cursor turns blue).
//   Who gets the button is decided then and kept until the lift (`buttonMode`):
//   - page (no mouse reporting): moving selects from the press point to the cursor with xterm's own selection; near the top or bottom edge the
//     terminal scrolls and the selection stays anchored to its buffer cell. Lift: the selection is copied through the copy path of the double
//     tap (h5.js `mouseBallTarget().copy`, inside the pointerup, so the user activation is there; the same notice and refusal bar).
//   - program (the program turned mouse reporting on: Claude Code in fullscreen, vim, tmux): real mouse events at the cursor go to xterm's
//     screen, which reports them to the program in its own encoding: the press, the motion with the button held, wheel steps near the top or
//     bottom edge, the release at the lift. The program selects and copies by itself; the lift marks a gesture for terminal-clipboard.js, so
//     its OSC 52 copy that follows shows "Copied N characters" instead of the request bar.
//   Without a press nothing happens. A cancelled touch ends everything without a copy (a program still gets the release).
// The ball holds the pointer (capture, touch-action none, cancelled touch events), so the terminal under it never scrolls, long-presses or
// double-tap-selects while it is used. The moving parts are set on the elements directly (a frame per finger move, no React render).
import { useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import { alpha } from '@mui/material/styles';
import { blueGrey } from '@mui/material/colors';
import { t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { keyTick } from './Osk.jsx';
import {
  BALL_SIZE, DWELL_IDLE, ballFor, buttonMode, cellFromPoint, cursorFor, dockPosition, dwellProgress, dwellStep, intersect, joinSelection,
  programReports, scrollSpeed, scrollStep, selectionRange,
} from './mouse-ball-model.mjs';

const RING_R = 29; // the dwell ring, just outside the ball
const RING = 2 * Math.PI * RING_R;
const RECHECK_MS = 500; // how often the idle ball looks again whether a terminal is shown (the chat or a session switch changes no store key)
const CURSOR = 'M0 19V0H19'; // the cursor: 19px of a square's top edge and left edge, the corner at the origin
const WHEEL_MAX = 40; // wheel steps sent to a program in one frame at most
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const rectOf = el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
function viewportRect() {
  const vv = window.visualViewport;
  return vv ? { left: vv.offsetLeft, top: vv.offsetTop, right: vv.offsetLeft + vv.width, bottom: vv.offsetTop + vv.height } : { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
}
// The shown terminal and its visible part: `area` (the terminal box within the visual viewport), `screen` (xterm's cells, maybe wider than the box in
// Wide mode) and `bounds` (the visible cells). null while no terminal is shown or it is too small for the ball.
function geometry(ui) {
  const target = ui.actions.mouseBallTarget ? ui.actions.mouseBallTarget() : null;
  const box = document.getElementById('h5-terminal');
  if (!target || !box) return null;
  const area = intersect(rectOf(box), viewportRect());
  if (!area || area.bottom - area.top < BALL_SIZE + 16) return null;
  const screen = rectOf(target.screen);
  const bounds = intersect(area, screen);
  return bounds && target.term.cols && target.term.rows ? { target, area, screen, bounds } : null;
}

// The imperative part: the touch on the ball, the dwell clock, the selection and the scrolling.
function control(nodes, ui) {
  const { ball, overlay, line, cursor, ring } = nodes;
  let drag = null;
  let frame = 0;
  let shown = false;
  const setState = (name, mode = '') => {
    ball.dataset.state = name;
    overlay.dataset.state = name;
    ball.dataset.mode = mode; // 'page' or 'program' while the button is down
    ball.setAttribute('aria-pressed', name === 'pressed' ? 'true' : 'false');
  };
  const setRing = progress => {
    // With reduced motion the ring does not fill; it shows whole once the button is down.
    const p = reducedMotion() ? (progress >= 1 ? 1 : 0) : progress;
    ring.style.strokeDashoffset = `${RING * (1 - p)}px`;
    ring.style.opacity = p > 0 ? '1' : '0';
  };
  const moveBall = point => { ball.style.transform = `translate(${point.x - BALL_SIZE / 2}px, ${point.y - BALL_SIZE / 2}px)`; };
  const show = on => { if (shown !== on) { shown = on; ball.style.display = on ? '' : 'none'; } };
  // Docks the idle ball (animated by its CSS transition, none with reduced motion) or hides it while no terminal is shown.
  function place() {
    if (drag) return;
    const geo = geometry(ui);
    show(Boolean(geo));
    if (geo) moveBall(dockPosition(geo.area));
  }
  function draw() {
    moveBall(drag.ball);
    cursor.setAttribute('transform', `translate(${drag.cursor.x} ${drag.cursor.y})`);
    line.setAttribute('x1', drag.cursor.x);
    line.setAttribute('y1', drag.cursor.y);
    line.setAttribute('x2', drag.ball.x);
    line.setAttribute('y2', drag.ball.y);
  }
  // How many cells of a row hold text (the cell after the last one that does).
  function usedCells(line, cols) {
    for (let x = cols - 1; x >= 0; x -= 1) {
      const cell = line.getCell(x);
      if (cell && cell.getChars()) return x + (cell.getWidth() || 1);
    }
    return 0;
  }
  // The copied text: the rows of the selection read from the buffer and joined by joinSelection (a line a program wrapped itself is one line again).
  function textOf(term, range) {
    const buffer = term.buffer.active;
    const cols = term.cols;
    const end = range.row * cols + range.col + range.length;
    const rows = [];
    for (let row = range.row; ; row += 1) {
      const line = buffer.getLine(row);
      if (!line) break;
      const from = row === range.row ? range.col : 0;
      const to = end < (row + 1) * cols ? end - row * cols : cols;
      const next = buffer.getLine(row + 1);
      rows.push({
        text: line.translateToString(!(next && next.isWrapped && to === cols), from, to),
        wrapped: row !== range.row && line.isWrapped,
        full: to === cols,
        length: usedCells(line, cols),
      });
      if (end <= (row + 1) * cols) break;
    }
    return joinSelection(rows, cols);
  }
  // The selection from the press point to the cell under the cursor, in buffer rows (so a scrolled view keeps the press point where it was).
  function select() {
    const { term } = drag.geo.target;
    const focus = cellFromPoint(drag.cursor, drag.geo.screen, term.cols, term.rows, term.buffer.active.viewportY);
    const range = selectionRange(drag.anchor, focus, term.cols);
    drag.range = range;
    if (range) term.select(range.col, range.row, range.length);
    else term.clearSelection();
  }
  // A mouse event for the program at the cursor: dispatched on xterm's screen, which turns it into the report of the program's tracking mode and
  // encoding (X10, SGR, ...) and sends it through the terminal's input (term.onData, like a real mouse). Only mouse and wheel events, never
  // pointer, touch or click events, so the page's tap, long press and copy-on-select handlers do not run (terminal-clipboard.js also counts only
  // trusted events).
  function report(type, buttons) {
    const { x, y } = drag.cursor;
    drag.program.screen.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, buttons }));
  }
  function wheel(lines) {
    const { x, y } = drag.cursor;
    for (let i = 0; i < Math.min(Math.abs(lines), WHEEL_MAX); i += 1) {
      drag.program.screen.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, composed: true, view: window, deltaMode: 1, deltaY: Math.sign(lines), clientX: x, clientY: y }));
    }
  }
  // The release for the program, once: at the lift (after its gesture mark) and when the touch ends any other way (the program must not be left
  // with its button down, and xterm drops its document listeners on it).
  function release() {
    const { program } = drag;
    if (!program || program.released) return;
    program.released = true;
    if (program.reports.release) report('mouseup', 0);
  }
  function press() {
    const { target } = drag.geo;
    const { term } = target;
    const tracking = term.modes ? term.modes.mouseTrackingMode : 'none';
    if (buttonMode(tracking) === 'program') {
      term.clearSelection(); // an old page highlight goes, as a mouse press in the terminal clears it; the program draws its own
      drag.program = { screen: target.screen, gesture: target.gesture, reports: programReports(tracking), released: false };
      report('mousedown', 1);
      setState('pressed', 'program');
      setRing(1);
      keyTick();
      return;
    }
    drag.anchor = cellFromPoint(drag.cursor, drag.geo.screen, term.cols, term.rows, term.buffer.active.viewportY);
    term.clearSelection();
    target.hookSelection(); // h5.js clears the highlight on new output; ours draws it again right after (below)
    drag.output = term.onWriteParsed(() => { if (drag && drag.anchor) select(); });
    setState('pressed', 'page');
    setRing(1);
    keyTick();
  }
  function end() {
    if (!drag) return;
    release();
    const { id, output } = drag;
    drag = null;
    if (output) output.dispose();
    cancelAnimationFrame(frame);
    frame = 0;
    try { if (ball.hasPointerCapture(id)) ball.releasePointerCapture(id); } catch { /* already released */ }
    setState('idle');
    setRing(0);
    place(); // back to the dock
  }
  // Every frame while the finger is down: the dwell clock and the ring, then the scrolling near the top or bottom edge with the button down.
  function tick() {
    frame = 0;
    if (!drag) return;
    const now = performance.now();
    const dt = Math.max(0, Math.min(100, now - drag.last));
    drag.last = now;
    if (drag.dwell.phase === 'waiting') {
      drag.dwell = dwellStep(drag.dwell, { type: 'tick', t: now });
      if (drag.dwell.phase === 'pressed') press();
      else setRing(dwellProgress(drag.dwell, now));
    }
    // The page scrolls its own view (the selection grows with it); a program gets wheel steps at the cursor and scrolls its own view.
    if (drag.anchor || (drag.program && drag.program.reports.wheel)) {
      const step = scrollStep(drag.carry, scrollSpeed(drag.cursor.y, drag.geo.bounds), dt);
      drag.carry = step.carry;
      if (step.lines && drag.anchor) { drag.geo.target.term.scrollLines(step.lines); select(); } else if (step.lines) wheel(step.lines);
    }
    frame = requestAnimationFrame(tick);
  }
  // The ball under the finger at (x, y); false when the terminal went away (another session, the chat): the touch ends.
  function follow(x, y) {
    const geo = geometry(ui);
    if (!geo || geo.target.term !== drag.geo.target.term) return false;
    drag.geo = geo;
    drag.ball = ballFor({ x, y }, drag.grab, drag.start, geo.area);
    drag.cursor = cursorFor(drag.ball, geo.area, geo.bounds);
    draw();
    if (drag.anchor) select();
    else if (drag.program && drag.program.reports.motion) report('mousemove', 1); // xterm reports a motion only when the cell changes
    return true;
  }
  function down(event) {
    if (drag || (event.button !== undefined && event.button > 0) || !event.isPrimary) return; // one finger drives; a second one is ignored
    const geo = geometry(ui);
    if (!geo) return;
    event.preventDefault();
    try { ball.setPointerCapture(event.pointerId); } catch { /* the touch still works without capture */ }
    const now = performance.now();
    const centre = dockPosition(geo.area);
    drag = {
      id: event.pointerId, geo, start: { x: event.clientX, y: event.clientY }, grab: { x: centre.x - event.clientX, y: centre.y - event.clientY },
      dwell: dwellStep(DWELL_IDLE, { type: 'down', x: event.clientX, y: event.clientY, t: now }), anchor: null, program: null, output: null, carry: 0, last: now, ball: centre, cursor: null,
    };
    setState('drag');
    if (!follow(event.clientX, event.clientY)) { end(); return; }
    frame = requestAnimationFrame(tick);
  }
  function move(event) {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault();
    const waiting = drag.dwell.phase === 'waiting';
    drag.dwell = dwellStep(drag.dwell, { type: 'move', x: event.clientX, y: event.clientY, t: performance.now() });
    if (waiting && drag.dwell.phase === 'pressed') press(); // the wait was over before this move: the press is where the ball stood
    if (!follow(event.clientX, event.clientY)) end();
  }
  function up(event) {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault();
    if (drag.program && follow(event.clientX, event.clientY)) {
      // The program copies by itself on the release (OSC 52 or pbcopy): this lift is the user's gesture for that copy.
      if (drag.program.gesture) drag.program.gesture();
      release();
    } else if (drag.anchor && follow(event.clientX, event.clientY)) {
      const { term, copy } = drag.geo.target;
      const text = term.hasSelection() && drag.range ? textOf(term, drag.range) : '';
      if (text) void copy(text); // inside the lift, so the browser lets the page write the clipboard
    }
    end();
  }
  function cancel(event) {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    if (drag.anchor) drag.geo.target.term.clearSelection(); // nothing was copied, so nothing stays selected
    end();
  }
  // The terminal under the ball must not see the touch: no scrolling, zooming, callout or click.
  const stop = event => { if (event.cancelable) event.preventDefault(); };
  const listeners = [['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', cancel], ['lostpointercapture', cancel],
    ['touchstart', stop], ['touchmove', stop], ['touchend', stop], ['contextmenu', stop]];
  for (const [type, handler] of listeners) ball.addEventListener(type, handler, { passive: false });
  const vv = window.visualViewport;
  window.addEventListener('resize', place);
  vv?.addEventListener('resize', place);
  vv?.addEventListener('scroll', place);
  const box = document.getElementById('h5-terminal');
  const observer = box && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
  observer?.observe(box);
  const timer = setInterval(place, RECHECK_MS);
  setState('idle');
  setRing(0);
  ball.style.display = 'none';
  place();
  return {
    place,
    dispose() {
      cancel();
      for (const [type, handler] of listeners) ball.removeEventListener(type, handler);
      window.removeEventListener('resize', place);
      vv?.removeEventListener('resize', place);
      vv?.removeEventListener('scroll', place);
      observer?.disconnect();
      clearInterval(timer);
    },
  };
}

const BALL = theme => ({
  position: 'fixed', left: 0, top: 0, zIndex: theme.zIndex.speedDial, width: BALL_SIZE, height: BALL_SIZE, boxSizing: 'border-box', borderRadius: '50%',
  display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.palette.common.white, bgcolor: blueGrey[700],
  border: `1px solid ${alpha(theme.palette.common.white, 0.35)}`, boxShadow: theme.shadows[6], opacity: 0.55,
  touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none', WebkitTapHighlightColor: 'transparent',
  transition: theme.transitions.create(['transform', 'opacity'], { duration: 220, easing: theme.transitions.easing.easeOut }),
  '&[data-state="drag"], &[data-state="pressed"]': { transition: 'none', opacity: 0.95, bgcolor: blueGrey[800] },
  '&[data-state="pressed"]': { bgcolor: theme.palette.notice.main },
  '& .h5-mouse-ball-ring': { position: 'absolute', left: -6, top: -6, width: 64, height: 64, overflow: 'visible', pointerEvents: 'none', transform: 'rotate(-90deg)' },
  '& .h5-mouse-ball-ring circle': { fill: 'none', stroke: theme.palette.primary.main, strokeWidth: 3, strokeDasharray: RING, strokeDashoffset: RING, opacity: 0 },
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
});
const OVERLAY = theme => ({
  position: 'fixed', left: 0, top: 0, width: '100%', height: '100%', zIndex: theme.zIndex.speedDial, pointerEvents: 'none', overflow: 'visible', display: 'none',
  color: theme.palette.common.white,
  '&[data-state="drag"], &[data-state="pressed"]': { display: 'block' },
  '&[data-state="pressed"]': { color: theme.palette.primary.main },
  '& line': { stroke: alpha(theme.palette.common.white, 0.45), strokeWidth: 1.5, strokeDasharray: '3 4' },
  '& path': { fill: 'none', strokeLinecap: 'butt', strokeLinejoin: 'miter' },
  '& .h5-mouse-ball-outline': { stroke: theme.palette.common.black },
});

// `state`: the store keys of App.jsx `BALL_KEYS`. Off (or with the terminal covered or replaced) it draws nothing.
export function MouseBall({ state, ui }) {
  const on = Boolean(state.mouseBall) && state.input === 'touch' && !state.wide && !state.pane;
  const covered = Boolean(state.empty) || Boolean(state.notebook) || state.copyText !== null || Boolean(state.mindmapOpen) || Boolean(state.learnOpen);
  const live = on && !covered;
  const ball = useRef(null);
  const overlay = useRef(null);
  const line = useRef(null);
  const cursor = useRef(null);
  const ring = useRef(null);
  useEffect(() => {
    if (!live) return undefined;
    const handle = control({ ball: ball.current, overlay: overlay.current, line: line.current, cursor: cursor.current, ring: ring.current }, ui);
    return () => handle.dispose();
  }, [live, ui]);
  if (!live) return null;
  const label = t('Mouse ball');
  return (
    <>
      <Box component="svg" ref={overlay} className="h5-mouse-ball-overlay" aria-hidden="true" focusable="false" sx={OVERLAY}>
        <line ref={line} />
        <g ref={cursor} className="h5-mouse-ball-cursor">
          <path d={CURSOR} className="h5-mouse-ball-outline" strokeWidth="5" />
          <path d={CURSOR} stroke="currentColor" strokeWidth="2.5" />
        </g>
      </Box>
      <Box ref={ball} id="h5-mouse-ball" role="button" aria-label={label} title={label} aria-pressed="false" sx={BALL}>
        <svg className="h5-mouse-ball-ring" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><circle ref={ring} cx="32" cy="32" r={RING_R} /></svg>
        <Icon name="mouseBall" size={22} />
      </Box>
    </>
  );
}
