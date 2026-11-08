// Sideways panning of the page's wide terminal, and its width math (see "Terminal width" and "Touch scrolling" in DESIGN.md).
// One handler for the terminal element: a one-finger pan picks its axis in its first AXIS_SLOP px and keeps it until the finger is lifted.
// - Horizontal: moves the wide terminal sideways (nothing in Fit mode, where the screen fits).
// - Vertical: not this handler's. The touch is let go at once, untouched: the wheel strip (h5.js bindWheelStrip) is the vertical scroller and a drag on
//   the body stays what it always was (xterm's own touch scrolling of the normal buffer with touch-action: pan-y; nothing in the alternate buffer).
// A touch that never travels AXIS_SLOP is left to the browser (tap, double tap, long press). A sideways pan never ends in a click, so it never opens a link.
const TerminalGestures = (() => {
  const AXIS_SLOP = 10; // px of travel that decide the axis of a pan
  const WIDE_CHOICES = [120, 160, 200];
  const DEFAULT_WIDE = 160;
  const WRAP_HINT_BELOW = 100; // the copy view suggests Wide when Fit gives fewer columns than this
  const FOLLOW_MARGIN = 4; // cells kept beside the cursor when it is scrolled into view

  // ── Pure math (test/terminal-gestures.test.js) ──
  function axisOf(dx, dy, slop = AXIS_SLOP) {
    if (Math.hypot(dx, dy) < slop) return null;
    return Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
  }
  function wideCols(choice) {
    const n = Number(choice);
    return WIDE_CHOICES.includes(n) ? n : DEFAULT_WIDE;
  }
  // The PTY columns: what fits in Fit mode; in Wide mode the chosen count, never fewer than what fits.
  function columnsFor(fitCols, mode, choice) {
    return mode === 'wide' ? Math.max(fitCols || 0, wideCols(choice)) : fitCols;
  }
  function maxOffset(content, visible) { return Math.max(0, Math.round(content - visible)); }
  function clampOffset(offset, content, visible) {
    return Math.max(0, Math.min(maxOffset(content, visible), Math.round(offset) || 0));
  }
  // The offset that shows the cursor cell [left, right) with `margin` px beside it; the left side wins when both cannot fit.
  function followOffset({ offset, left, right, visible, content, margin = 0 }) {
    let next = offset;
    if (right + margin > next + visible) next = right + margin - visible;
    if (left - margin < next) next = left - margin;
    return clampOffset(next, content, visible);
  }
  function inView(offset, left, right, visible) { return left >= offset && right <= offset + visible; }
  function wrapHint(mode, cols) { return mode !== 'wide' && cols > 0 && cols < WRAP_HINT_BELOW; }

  // ── The handler ──
  // opts: active() (the terminal is shown and nothing covers it), offset: { get(), set(px), max() } (the wide terminal),
  // onScroll() (a sideways scroll by the user, for the indicator), onHorizontalEnd() (a sideways pan or wheel ended).
  function attach(el, opts) {
    let g = null; // the touch being followed
    let lastPan = -Infinity;
    const now = () => performance.now();
    const scrolled = () => { if (opts.onScroll) opts.onScroll(); };
    const own = event => [...event.touches].find(touch => touch.identifier === g.id);
    const onStart = event => {
      if (event.touches.length !== 1 || !opts.active()) { g = null; return; } // a second finger ends the pan
      const touch = event.touches[0];
      g = { id: touch.identifier, x0: touch.clientX, y0: touch.clientY, axis: null, offset0: opts.offset.get() };
    };
    const onMove = event => {
      if (!g) return;
      const touch = event.touches.length === 1 ? own(event) : null;
      if (!touch || !opts.active()) { g = null; return; }
      const dx = touch.clientX - g.x0;
      if (!g.axis) {
        // Not decided yet, or vertical: the move is not touched, so xterm and the browser see the same touch they always did.
        const axis = axisOf(dx, touch.clientY - g.y0);
        if (!axis) return;
        if (axis === 'y') { g = null; return; }
        g.axis = axis;
      }
      // A sideways pan: only this handler moves the view, so xterm's own touch scrolling (on its element, below) and the browser never see the move.
      event.stopPropagation();
      if (event.cancelable) event.preventDefault();
      if (opts.offset.max() > 0) { opts.offset.set(g.offset0 - dx); scrolled(); }
    };
    const onEnd = event => {
      if (!g || own(event)) return; // another finger was lifted
      const done = g;
      g = null;
      if (!done.axis) return; // a tap or a press: the browser's (click, double tap, long press)
      lastPan = now();
      if (event.type === 'touchend' && event.cancelable) event.preventDefault(); // no click and no compatibility mouse events after a pan
      if (opts.onHorizontalEnd) opts.onHorizontalEnd();
    };
    // A sideways wheel or trackpad swipe, and Shift+wheel, move the wide terminal; anything else stays xterm's (vertical scroll, mouse reports).
    const onWheel = event => {
      const max = opts.offset.max();
      if (!(max > 0)) return;
      const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : (event.shiftKey ? event.deltaX || event.deltaY : 0);
      if (!sideways) return;
      const unit = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? el.clientWidth : 1;
      event.preventDefault();
      event.stopPropagation();
      opts.offset.set(opts.offset.get() + sideways * unit);
      scrolled();
      if (opts.onHorizontalEnd) opts.onHorizontalEnd();
    };
    const options = { capture: true, passive: false };
    el.addEventListener('touchstart', onStart, options);
    el.addEventListener('touchmove', onMove, options);
    el.addEventListener('touchend', onEnd, options);
    el.addEventListener('touchcancel', onEnd, options);
    el.addEventListener('wheel', onWheel, options);
    return {
      recentlyPanned: (ms = 600) => now() - lastPan < ms,
      panning: () => Boolean(g && g.axis),
      dispose() {
        el.removeEventListener('touchstart', onStart, options);
        el.removeEventListener('touchmove', onMove, options);
        el.removeEventListener('touchend', onEnd, options);
        el.removeEventListener('touchcancel', onEnd, options);
        el.removeEventListener('wheel', onWheel, options);
      },
    };
  }

  return {
    AXIS_SLOP, WIDE_CHOICES, DEFAULT_WIDE, WRAP_HINT_BELOW, FOLLOW_MARGIN,
    axisOf, wideCols, columnsFor, maxOffset, clampOffset, followOffset, inView, wrapHint, attach,
  };
})();
if (typeof module !== 'undefined') module.exports = TerminalGestures;
