// The mouse ball of the terminal ("Mouse ball" in docs/design/page-terminal-mouse-ball.md), for a finger and a mouse alike (a mouse drags it with the
// left button held; the lift is the mouseup; Escape cancels). A chunk of its own (screen-mouse-ball.jsx), drawn by App.jsx through lazy-screens.jsx in
// both input modes. There is no ball of its own on the screen: it comes out of the wheel strip (the floating
// scrollbar on the right, h5.js `bindWheelStrip`), which hands a finger over when it slides to the left (`ui.actions.stripMouse`, registered here).
// - Out of the strip: under 40px of travel to the left the thumb stretches toward the finger like a bubble (a tail of the thumb's colour and a head
//   that grows into the 52px ball); lifted then, it springs back and nothing happens. Past 40px it lets go: the ball under the finger.
// - The ball: the cursor (the top-left corner of a square, two lines; the corner is the mouse position) shows 46px left of and above it, with a
//   dashed line between them; near the right and bottom edges that offset fades out (mouse-ball-model.mjs).
// - Keep still for 600 ms: a ring fills around the ball, then the left button goes down at the cursor (a haptic tick, the cursor turns blue).
//   Who gets the button is decided then and kept until the lift (`buttonMode`):
//   - page (no mouse reporting): moving selects from the press point to the cursor with xterm's own selection; near the top or bottom edge the
//     terminal scrolls and the selection stays anchored to its buffer cell. Lift: the selection is copied through the copy path of the double
//     tap (h5.js `mouseBallTarget().copy`, inside the pointerup, so the user activation is there; the same notice and refusal bar).
//   - program (only with this device's switch on, More > "Mouse ball sends the mouse to programs", and the program turned mouse reporting on:
//     Claude Code in fullscreen, vim, tmux): real mouse events at the cursor go to xterm's screen, which reports them to the program in its own
//     encoding, in the order a real mouse makes them: hover moves with no button while the ball is out (mode 1003 only), the terminal's focus
//     (`ESC[I` when the program asked for focus reports), the press, the motion with the button held, wheel steps near the top or bottom edge,
//     the release at the lift. The program selects and copies by itself; the lift marks a gesture for terminal-clipboard.js, so its OSC 52 copy
//     that follows shows "Copied N characters" instead of the request bar.
//   Without a press nothing happens. A cancelled touch ends everything without a copy (a program still gets the release).
// - Lift (or cancel): the ball glides back into the strip and is the thumb again (220 ms; at once with reduced motion). While it is out the
//   strip's thumb is dimmed at its place and the strip says what is out in `data-mouse` (stretch, ball, glide).
// The strip keeps the pointer capture of the finger, so the terminal under the ball never scrolls, pans, long-presses or double-tap-selects while it
// is used; this chunk follows that pointer on the document. The moving parts are set on the elements directly (a frame per finger move, no React
// render). The first time it can be used on a device a hint near the thumb says how (`HINT_KEY`, 4 s, once).
import { useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import { alpha } from '@mui/material/styles';
import { blueGrey } from '@mui/material/colors';
import { t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { keyTick } from './Osk.jsx';
import { localGet, localSet } from './local-keys.mjs';
import {
  BALL_SIZE, DWELL_IDLE, GLIDE_MS, THUMB_WIDTH, ballFor, buttonMode, cellFromPoint, cursorFor, dwellProgress, dwellStep, glideTarget, intersect,
  joinSelection, programReports, scrollSpeed, scrollStep, selectionRange, stretchProgress, stretchShape, stripAxis, thumbAnchor,
} from './mouse-ball-model.mjs';

const RING_R = 29; // the dwell ring, just outside the ball
const RING = 2 * Math.PI * RING_R;
const RECHECK_MS = 500; // how often it looks whether the terminal is still there and whether the first-time hint is due
const CURSOR = 'M0 19V0H19'; // the cursor: 19px of a square's top edge and left edge, the corner at the origin
const WHEEL_MAX = 40; // wheel steps sent to a program in one frame at most
const THUMB_DIM = 'rgba(255, 255, 255, 0.15)'; // the strip's thumb while the ball is out of it
const HINT_KEY = 'h5-mouse-ball-hinted'; // per device (public/js/local-keys.js): the first-time hint was shown
const PROGRAM_KEY = 'h5-mouse-ball-program'; // per device: 'on' sends the mouse to a program that has mouse reporting on; absent (the default): the page always selects. Set by the switch in the More menu (Header.jsx `PROGRAM_KEY`)
const HINT_MS = 4000;
const HINT_TEXT = 'Slide the scrollbar left for the mouse';
const STATUS = { wait: 'Hold still to press', page: 'Selecting in the page', program: 'Mouse sent to the program' }; // what the ball is doing, shown at the top of the terminal
const DESCRIPTION = 'Slide left for the mouse'; // the strip's aria-description, set while this chunk is there
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const trackingOf = term => (term.modes ? term.modes.mouseTrackingMode : 'none');
const rectOf = el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
const stripEl = () => document.getElementById('h5-wheel');
const thumbOf = el => (el ? el.querySelector('.h5-wheel-thumb') : null);
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

// The imperative part: the finger handed over by the strip, the stretch, the dwell clock, the selection, the scrolling, the glide back, the hint.
function control(nodes, ui) {
  const { ball, overlay, line, cursor, ring, tail, hint, status } = nodes;
  let drag = null;
  let frame = 0;
  let glide = null; // { el, timer } while the ball glides back into the strip
  let hintTimer = 0;
  let hinted = localGet(HINT_KEY) === 'shown';
  const setState = (name, mode = '') => {
    ball.dataset.state = name; // idle, stretch, drag, pressed, glide
    overlay.dataset.state = name;
    ball.dataset.mode = mode; // 'page' or 'program' while the button is down
  };
  const setRing = progress => {
    // With reduced motion the ring does not fill; it shows whole once the button is down.
    const p = reducedMotion() ? (progress >= 1 ? 1 : 0) : progress;
    ring.style.strokeDashoffset = `${RING * (1 - p)}px`;
    ring.style.opacity = p > 0 ? '1' : '0';
  };
  // The status pill at the top of the terminal while the ball is out: waiting for the press, then who gets the button (the page's selection or the program).
  const setStatus = name => {
    if (!name || !drag) { status.style.display = 'none'; delete status.dataset.status; return; }
    status.dataset.status = name;
    status.textContent = t(STATUS[name]);
    status.style.display = 'flex';
    status.style.top = `${drag.geo.area.top + 8}px`;
  };
  const moveBall = (point, scale = 1) => { ball.style.transform = `translate(${point.x - BALL_SIZE / 2}px, ${point.y - BALL_SIZE / 2}px) scale(${scale})`; };
  // The strip while the ball is out of it: `data-mouse` says what (stretch, ball, glide) and the thumb is dimmed at its place; null puts it back.
  function stripState(el, name) {
    if (!el) return;
    const thumb = thumbOf(el);
    if (name) el.dataset.mouse = name;
    else delete el.dataset.mouse;
    if (thumb) thumb.style.background = name ? THUMB_DIM : '';
  }
  function drawCursor(opacity) {
    cursor.setAttribute('transform', `translate(${drag.cursor.x} ${drag.cursor.y})`);
    cursor.style.opacity = opacity;
    line.style.opacity = opacity;
    line.setAttribute('x1', drag.cursor.x);
    line.setAttribute('y1', drag.cursor.y);
    line.setAttribute('x2', drag.ball.x);
    line.setAttribute('y2', drag.ball.y);
  }
  function draw() {
    moveBall(drag.ball);
    drawCursor('1');
  }
  // How many cells of a row hold text (the cell after the last one that does).
  function usedCells(row, cols) {
    for (let x = cols - 1; x >= 0; x -= 1) {
      const cell = row.getCell(x);
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
      const current = buffer.getLine(row);
      if (!current) break;
      const from = row === range.row ? range.col : 0;
      const to = end < (row + 1) * cols ? end - row * cols : cols;
      const next = buffer.getLine(row + 1);
      rows.push({
        text: current.translateToString(!(next && next.isWrapped && to === cols), from, to),
        wrapped: row !== range.row && current.isWrapped,
        full: to === cols,
        length: usedCells(current, cols),
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
    (drag.program ? drag.program.screen : drag.geo.target.screen).dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, buttons }));
  }
  function wheel(lines) {
    const { x, y } = drag.cursor;
    for (let i = 0; i < Math.min(Math.abs(lines), WHEEL_MAX); i += 1) {
      drag.program.screen.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, composed: true, view: window, deltaMode: 1, deltaY: Math.sign(lines), clientX: x, clientY: y }));
    }
  }
  // Before the press, with this device's switch on (`drag.hover`, read at the detach): the mouse moving with no button at the cursor, as a real
  // mouse is seen moving before its click. Only while the program asks for it (any, mode 1003); xterm reports one per changed cell.
  function hover() {
    if (drag.hover && !drag.anchor && !drag.program && programReports(trackingOf(drag.geo.target.term)).hover) report('mousemove', 0);
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
    const tracking = trackingOf(term);
    if (localGet(PROGRAM_KEY) === 'on' && buttonMode(tracking) === 'program') {
      term.clearSelection(); // an old page highlight goes, as a mouse press in the terminal clears it; the program draws its own
      drag.program = { screen: target.screen, gesture: target.gesture, reports: programReports(tracking), released: false };
      // As a real click: the terminal takes the focus first (xterm sends ESC[I when the program asked for focus reports), then the mouse is at the
      // cell of the press (a hover, sent by xterm only in mode 1003 and not twice for one cell), then the button goes down.
      // The haptic tick comes first: on iOS it toggles a hidden switch, which takes the focus from the terminal (ESC[O) and gives it back (ESC[I). Played
      // after the press, that pair of focus reports sat between the press and the first drag, which a real mouse never sends (found with `cat -v` on a phone).
      keyTick();
      if (term.textarea && document.activeElement !== term.textarea) term.focus();
      report('mousemove', 0);
      report('mousedown', 1);
      setState('pressed', 'program');
      setStatus('program');
      setRing(1);
      return;
    }
    drag.anchor = cellFromPoint(drag.cursor, drag.geo.screen, term.cols, term.rows, term.buffer.active.viewportY);
    term.clearSelection();
    target.hookSelection(); // h5.js clears the highlight on new output; ours draws it again right after (below)
    drag.output = term.onWriteParsed(() => { if (drag && drag.anchor) select(); });
    setState('pressed', 'page');
    setStatus('page');
    setRing(1);
    keyTick();
  }

  // ── Out of the strip: the stretch, then the ball ──
  // The thumb stretched toward the finger at `at`; at DETACH px to the left it lets go (detach).
  function stretch(at) {
    const p = stretchProgress(drag.from, at);
    if (p >= 1) { detach(at); return; }
    const shape = stretchShape(drag.root, at, p);
    drag.ball = shape.head;
    drag.scale = shape.scale;
    drag.cursor = cursorFor(shape.head, drag.geo.area, drag.geo.bounds);
    ball.dataset.progress = p.toFixed(2);
    moveBall(shape.head, shape.scale);
    ball.style.opacity = String(0.4 + 0.55 * p);
    tail.setAttribute('x1', shape.tail.x1);
    tail.setAttribute('y1', shape.tail.y1);
    tail.setAttribute('x2', shape.tail.x2);
    tail.setAttribute('y2', shape.tail.y2);
    tail.style.strokeWidth = `${shape.tail.width}px`;
    tail.style.display = '';
    drawCursor(String(p)); // the cursor shows where it will be, fainter the less it is stretched
  }
  function detach(at) {
    const now = performance.now();
    const program = localGet(PROGRAM_KEY) === 'on' && buttonMode(trackingOf(drag.geo.target.term)) === 'program'; // hover moves until the press
    Object.assign(drag, { phase: 'ball', start: at, grab: { x: 0, y: 0 }, scale: 1, last: now, hover: program, dwell: dwellStep(DWELL_IDLE, { type: 'down', x: at.x, y: at.y, t: now }) });
    delete ball.dataset.progress;
    ball.style.opacity = '';
    tail.style.display = 'none';
    stripState(drag.el, 'ball');
    setState('drag');
    setStatus('wait');
    if (!follow(at.x, at.y)) { end(); return; }
    frame = requestAnimationFrame(tick);
  }
  // The finger handed over by the strip (h5.js, a slide to the left): `id` its pointer, `el` the strip (it keeps the capture), `from` the touch,
  // `at` the finger now, `sync` the strip's redraw. false when there is nothing to point at (the strip then goes on as a scroll).
  function begin({ id, el, from, at, sync }) {
    if (drag) return false;
    const geo = geometry(ui);
    const thumb = thumbOf(el);
    if (!geo || !thumb) return false;
    settle();
    hideHint();
    drag = {
      id, el, sync, geo, from, root: thumbAnchor(rectOf(thumb), from.y), phase: 'stretch', scale: 0, start: null, grab: null, dwell: DWELL_IDLE,
      anchor: null, range: null, program: null, hover: false, output: null, carry: 0, last: performance.now(), ball: null, cursor: null,
    };
    listen(true);
    stripState(el, 'stretch');
    ball.style.display = 'flex';
    setState('stretch');
    stretch(at);
    return true;
  }
  // The ball glides back into the strip and is its thumb again (at once with reduced motion or without a thumb to go to).
  function glideBack(el) {
    const geo = geometry(ui);
    const thumb = el && el.isConnected ? thumbOf(el) : null;
    tail.style.display = 'none';
    if (!geo || !thumb || reducedMotion()) { settle(el); return; }
    if (drag && drag.sync) drag.sync(); // the thumb where the view is now (it may have scrolled)
    stripState(el, 'glide');
    setState('glide');
    moveBall(glideTarget(rectOf(thumb), geo.area), THUMB_WIDTH / BALL_SIZE);
    ball.style.opacity = '0';
    glide = { el, timer: setTimeout(() => settle(), GLIDE_MS) };
  }
  // The ball is gone and the thumb is the strip's own again. A touch during the glide ends it at once.
  function settle(el = glide && glide.el) {
    if (glide) clearTimeout(glide.timer);
    glide = null;
    ball.style.display = 'none';
    ball.style.opacity = '';
    delete ball.dataset.progress;
    if (!drag) setState('idle');
    stripState(el, null);
    const strip = stripEl();
    if (strip && strip !== el && strip.dataset.mouse && !drag) stripState(strip, null); // a strip drawn again meanwhile
  }
  function end() {
    if (!drag) return;
    if (drag.phase === 'ball') release();
    const { id, el, output, sync } = drag;
    cancelAnimationFrame(frame);
    frame = 0;
    if (output) output.dispose();
    listen(false);
    setRing(0);
    setStatus(null);
    glideBack(el);
    drag = null;
    if (!glide) setState('idle');
    try { if (el.hasPointerCapture(id)) el.releasePointerCapture(id); } catch { /* already released */ }
    if (sync) sync();
  }
  // Every frame while the ball is out: the dwell clock and the ring, then the scrolling near the top or bottom edge with the button down.
  function tick() {
    frame = 0;
    if (!drag || drag.phase !== 'ball') return;
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
  // The terminal still the one of the touch: false when it went away (another session, the chat), and the touch ends.
  function same() {
    const geo = geometry(ui);
    if (!geo || geo.target.term !== drag.geo.target.term) return false;
    drag.geo = geo;
    return true;
  }
  // The ball under the finger at (x, y).
  function follow(x, y) {
    if (!same()) return false;
    const { geo } = drag;
    drag.ball = ballFor({ x, y }, drag.grab, drag.start, geo.area);
    drag.cursor = cursorFor(drag.ball, geo.area, geo.bounds);
    draw();
    if (drag.anchor) select();
    else if (drag.program) { if (drag.program.reports.motion) report('mousemove', 1); } // xterm reports a motion only when the cell changes
    else hover();
    return true;
  }
  function move(event) {
    if (!drag || event.pointerId !== drag.id) return;
    if (event.cancelable) event.preventDefault();
    if (drag.phase === 'stretch') {
      if (same()) stretch({ x: event.clientX, y: event.clientY });
      else cancel();
      return;
    }
    const waiting = drag.dwell.phase === 'waiting';
    drag.dwell = dwellStep(drag.dwell, { type: 'move', x: event.clientX, y: event.clientY, t: performance.now() });
    if (waiting && drag.dwell.phase === 'pressed') press(); // the wait was over before this move: the press is where the ball stood
    if (!follow(event.clientX, event.clientY)) end();
  }
  function up(event) {
    if (!drag || event.pointerId !== drag.id) return;
    if (event.cancelable) event.preventDefault();
    if (drag.phase === 'stretch') { end(); return; } // not far enough: it springs back, nothing happens
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
    if (!drag || (event && event.pointerId !== undefined && event.pointerId !== drag.id)) return;
    if (drag.anchor) drag.geo.target.term.clearSelection(); // nothing was copied, so nothing stays selected
    end();
  }
  // While the ball is out: the finger on the document (the strip has its capture); no callout, no scrolling, no context menu.
  const stop = event => { if (drag && event.cancelable) event.preventDefault(); };
  // Escape (a mouse, or a keyboard beside the finger) ends it like a cancelled touch, and the key does not reach the terminal.
  const escape = event => { if (drag && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); } };
  const following = [['pointermove', move], ['pointerup', up], ['pointercancel', cancel], ['lostpointercapture', cancel], ['contextmenu', stop], ['touchmove', stop], ['keydown', escape]];
  function listen(on) {
    for (const [type, handler] of following) {
      if (on) document.addEventListener(type, handler, { capture: true, passive: false });
      else document.removeEventListener(type, handler, { capture: true });
    }
  }
  // Any new touch: the glide is over at once (the thumb is there for it) and the hint goes.
  const touched = () => { if (glide) settle(); hideHint(); };
  const away = () => cancel();
  const hidden = () => { if (document.hidden) cancel(); };
  const blurred = event => { if (event.target === window) cancel(); };

  // ── The first-time hint, and the strip's description ──
  function hideHint() {
    clearTimeout(hintTimer);
    hintTimer = 0;
    hint.style.display = 'none';
  }
  function showHint(strip, thumb) {
    const geo = geometry(ui);
    if (!geo) return;
    hinted = true;
    localSet(HINT_KEY, 'shown');
    const box = rectOf(strip);
    const middle = glideTarget(rectOf(thumb), geo.area).y;
    hint.style.display = 'flex';
    hint.style.right = `${Math.max(0, document.documentElement.clientWidth - box.left + 4)}px`;
    hint.style.top = `${Math.max(geo.area.top + 4, Math.min(geo.area.bottom - 48, middle - 22))}px`;
    hintTimer = setTimeout(hideHint, HINT_MS);
  }
  function check() {
    const strip = stripEl();
    if (strip && strip.getAttribute('aria-description') !== t(DESCRIPTION)) strip.setAttribute('aria-description', t(DESCRIPTION));
    if (drag) { if (!same()) cancel(); return; } // a terminal that went away while the finger was still
    if (hinted || !strip || strip.dataset.mode === 'none' || strip.classList.contains('active') || glide) return;
    const thumb = thumbOf(strip);
    if (thumb && geometry(ui)) showHint(strip, thumb);
  }

  ui.actions.stripMouse = { axis: stripAxis, begin };
  document.addEventListener('pointerdown', touched, true);
  window.addEventListener('pagehide', away);
  window.addEventListener('blur', blurred);
  document.addEventListener('visibilitychange', hidden);
  const timer = setInterval(check, RECHECK_MS);
  setState('idle');
  setRing(0);
  ball.style.display = 'none';
  tail.style.display = 'none';
  hint.style.display = 'none';
  check();
  return {
    dispose() {
      cancel();
      settle();
      hideHint();
      if (ui.actions.stripMouse && ui.actions.stripMouse.begin === begin) delete ui.actions.stripMouse;
      document.removeEventListener('pointerdown', touched, true);
      window.removeEventListener('pagehide', away);
      window.removeEventListener('blur', blurred);
      document.removeEventListener('visibilitychange', hidden);
      clearInterval(timer);
      const strip = stripEl();
      if (strip) strip.removeAttribute('aria-description');
    },
  };
}

const BALL = theme => ({
  position: 'fixed', left: 0, top: 0, zIndex: theme.zIndex.speedDial, width: BALL_SIZE, height: BALL_SIZE, boxSizing: 'border-box', borderRadius: '50%',
  display: 'none', alignItems: 'center', justifyContent: 'center', color: theme.palette.common.white, bgcolor: blueGrey[800], // shown by control()
  border: `1px solid ${alpha(theme.palette.common.white, 0.35)}`, boxShadow: theme.shadows[6], opacity: 0.95, pointerEvents: 'none', transformOrigin: 'center',
  transition: 'none',
  '&[data-state="pressed"]': { bgcolor: theme.palette.notice.main },
  '&[data-state="glide"]': { transition: theme.transitions.create(['transform', 'opacity'], { duration: GLIDE_MS, easing: theme.transitions.easing.easeIn }) },
  '& .h5-mouse-ball-ring': { position: 'absolute', left: -6, top: -6, width: 64, height: 64, overflow: 'visible', pointerEvents: 'none', transform: 'rotate(-90deg)' },
  '& .h5-mouse-ball-ring circle': { fill: 'none', stroke: theme.palette.primary.main, strokeWidth: 3, strokeDasharray: RING, strokeDashoffset: RING, opacity: 0 },
  '@media (prefers-reduced-motion: reduce)': { '&[data-state="glide"]': { transition: 'none' } },
});
const OVERLAY = theme => ({
  position: 'fixed', left: 0, top: 0, width: '100%', height: '100%', zIndex: theme.zIndex.speedDial, pointerEvents: 'none', overflow: 'visible', display: 'none',
  color: theme.palette.common.white,
  '&[data-state="stretch"], &[data-state="drag"], &[data-state="pressed"]': { display: 'block' },
  '&[data-state="pressed"]': { color: theme.palette.primary.main },
  '& .h5-mouse-ball-line': { stroke: alpha(theme.palette.common.white, 0.45), strokeWidth: 1.5, strokeDasharray: '3 4' },
  '& .h5-mouse-ball-tail': { stroke: alpha(theme.palette.common.white, 0.3), strokeLinecap: 'round' }, // the thumb's colour, stretched
  '& path': { fill: 'none', strokeLinecap: 'butt', strokeLinejoin: 'miter' },
  '& .h5-mouse-ball-outline': { stroke: theme.palette.common.black },
});
// The status pill: centred at the top of the terminal while the ball is out, never taking a touch.
const STATUS_PILL = theme => ({
  position: 'fixed', left: '50%', transform: 'translateX(-50%)', zIndex: theme.zIndex.speedDial, minHeight: 32, boxSizing: 'border-box', display: 'none', alignItems: 'center', px: 2,
  borderRadius: '16px', pointerEvents: 'none', whiteSpace: 'nowrap', maxWidth: 'calc(100vw - 32px)', ...theme.typography.body2,
  '&[data-status="wait"]': { color: theme.palette.text.secondary },
  '&[data-status="page"], &[data-status="program"]': { bgcolor: theme.palette.notice.main, color: theme.palette.notice.contrastText },
});
// The first-time hint: a pill left of the thumb, never taking a touch.
const HINT = theme => ({
  position: 'fixed', zIndex: theme.zIndex.speedDial, height: 44, boxSizing: 'border-box', display: 'none', alignItems: 'center', gap: 1, px: 2,
  borderRadius: '22px', pointerEvents: 'none', whiteSpace: 'nowrap', maxWidth: 'calc(100vw - 72px)', ...theme.typography.body2,
  '& .h5-mouse-ball-hint-icon': { display: 'inline-flex', color: theme.palette.primary.main, flex: '0 0 auto' },
});

// `state`: the store keys of App.jsx `BALL_KEYS`. With the terminal covered or replaced it draws nothing; a finger and a mouse use it alike.
export function MouseBall({ state, ui }) {
  const covered = Boolean(state.empty) || Boolean(state.notebook) || state.copyText !== null || Boolean(state.mindmapOpen) || Boolean(state.learnOpen);
  const live = !covered;
  const ball = useRef(null);
  const overlay = useRef(null);
  const line = useRef(null);
  const cursor = useRef(null);
  const ring = useRef(null);
  const tail = useRef(null);
  const hint = useRef(null);
  const status = useRef(null);
  useEffect(() => {
    if (!live) return undefined;
    const handle = control({ ball: ball.current, overlay: overlay.current, line: line.current, cursor: cursor.current, ring: ring.current, tail: tail.current, hint: hint.current, status: status.current }, ui);
    return () => handle.dispose();
  }, [live, ui]);
  if (!live) return null;
  return (
    <>
      <Box component="svg" ref={overlay} className="h5-mouse-ball-overlay" aria-hidden="true" focusable="false" sx={OVERLAY}>
        <line ref={tail} className="h5-mouse-ball-tail" />
        <line ref={line} className="h5-mouse-ball-line" />
        <g ref={cursor} className="h5-mouse-ball-cursor">
          <path d={CURSOR} className="h5-mouse-ball-outline" strokeWidth="5" />
          <path d={CURSOR} stroke="currentColor" strokeWidth="2.5" />
        </g>
      </Box>
      <Box ref={ball} id="h5-mouse-ball" aria-hidden="true" sx={BALL}>
        <svg className="h5-mouse-ball-ring" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><circle ref={ring} cx="32" cy="32" r={RING_R} /></svg>
        <Icon name="mouseBall" size={22} />
      </Box>
      <Paper ref={status} id="h5-mouse-ball-status" role="status" elevation={6} sx={STATUS_PILL} />
      <Paper ref={hint} id="h5-mouse-ball-hint" role="status" elevation={6} sx={HINT}>
        <span className="h5-mouse-ball-hint-icon" aria-hidden="true"><Icon name="chevronLeft" size={18} /></span>
        <span>{t(HINT_TEXT)}</span>
      </Paper>
    </>
  );
}
