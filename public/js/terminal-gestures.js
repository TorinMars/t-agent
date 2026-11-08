// Touch scrolling of the page's terminal and the sideways offset of the wide terminal (see "Terminal width" and "Touch scrolling" in DESIGN.md).
// One handler for the whole terminal area: a one-finger pan picks its axis in its first AXIS_SLOP px and keeps it until the finger is lifted.
// - Horizontal: moves the wide terminal sideways (nothing in Fit mode, where the screen fits).
// - Vertical, normal buffer: scrolls the scrollback 1:1 under the finger (by whole lines, as xterm draws them), with momentum after a flick
//   (none with prefers-reduced-motion).
// - Vertical, alternate buffer (Claude Code, Codex, vim, less, tmux): wheel events on the xterm screen, one per line of finger travel, as the old
//   wheel strip sent them; xterm turns them into mouse wheel reports for a mouse-tracking program, or into up / down arrows for one without.
// A touch that never travels AXIS_SLOP is left to the browser (tap, double tap, long press). A pan never ends in a click, so it never opens a link.
const TerminalGestures = (() => {
  const AXIS_SLOP = 10; // px of travel that decide the axis of a pan
  const FLICK_MIN = 0.3; // px/ms: a lift faster than this keeps scrolling
  const FLICK_STOP = 0.02; // px/ms: momentum stops below this
  const FRICTION = 0.95; // momentum kept per 16 ms
  const FLICK_WINDOW = 100; // ms of finger movement that count for the speed at the lift
  const MAX_EVENTS = 200; // wheel events per move at most (alternate buffer)
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
  function takeLines(accum, lineHeight) {
    const lines = lineHeight > 0 ? Math.trunc(accum / lineHeight) : 0;
    return { lines, rest: accum - lines * lineHeight };
  }
  // Finger speed at the lift in px/ms from [{ t, y }] samples; positive = the finger moved up (toward newer output).
  function velocity(samples, now, window = FLICK_WINDOW) {
    const recent = samples.filter(sample => now - sample.t <= window);
    if (recent.length < 2) return 0;
    const first = recent[0];
    const last = recent[recent.length - 1];
    const dt = last.t - first.t;
    return dt > 0 ? (first.y - last.y) / dt : 0;
  }
  function decay(v, dt) { return v * FRICTION ** (dt / 16); }
  function wrapHint(mode, cols) { return mode !== 'wide' && cols > 0 && cols < WRAP_HINT_BELOW; }

  // ── The handler ──
  // opts: active() (the terminal is shown and nothing covers it), lineHeight(), wheel(lines, x, y) (alternate buffer),
  // offset: { get(), set(px), max() } (the wide terminal), onScroll(axis) (a scroll by the user, for the indicator),
  // onHorizontalEnd() (a sideways pan or wheel ended), reducedMotion().
  function attach(el, term, opts) {
    let g = null; // the touch being followed
    let fling = 0;
    let lastPan = -Infinity;
    const now = () => performance.now();
    const stopFling = () => { if (fling) cancelAnimationFrame(fling); fling = 0; };
    const scrolled = axis => { if (opts.onScroll) opts.onScroll(axis); };
    const vertical = (state, dy, x, y) => { // dy > 0: the finger moved up, newer output
      state.accum += dy;
      const { lines, rest } = takeLines(state.accum, opts.lineHeight());
      if (!lines) return;
      state.accum = rest;
      // The buffer type is read at each step, so a program that switches screens during the pan is followed.
      if (term.buffer.active.type === 'alternate') opts.wheel(Math.max(-MAX_EVENTS, Math.min(MAX_EVENTS, lines)), x, y);
      else { term.scrollLines(lines); scrolled('y'); }
    };
    const startFling = v => {
      let last = now();
      const state = { accum: 0 };
      const step = () => {
        fling = 0;
        const at = now();
        const dt = Math.min(64, at - last);
        last = at;
        if (term.buffer.active.type !== 'normal' || !opts.active()) return;
        state.accum += v * dt;
        const { lines, rest } = takeLines(state.accum, opts.lineHeight());
        state.accum = rest;
        if (lines) {
          const before = term.buffer.active.viewportY;
          term.scrollLines(lines);
          if (term.buffer.active.viewportY === before) return; // at the top or the bottom
          scrolled('y');
        }
        v = decay(v, dt);
        if (Math.abs(v) >= FLICK_STOP) fling = requestAnimationFrame(step);
      };
      fling = requestAnimationFrame(step);
    };
    const own = event => [...event.touches].find(touch => touch.identifier === g.id);
    const onStart = event => {
      stopFling();
      if (event.touches.length !== 1 || !opts.active()) { g = null; return; } // a second finger ends the pan
      const touch = event.touches[0];
      g = { id: touch.identifier, x0: touch.clientX, y0: touch.clientY, y: touch.clientY, axis: null, offset0: opts.offset.get(), accum: 0, samples: [{ t: now(), y: touch.clientY }] };
    };
    const onMove = event => {
      if (!g) return;
      const touch = event.touches.length === 1 ? own(event) : null;
      if (!touch || !opts.active()) { g = null; return; }
      // Only this handler moves the view: xterm's own touch scrolling (on its element, below) and the browser's never see the move.
      event.stopPropagation();
      if (event.cancelable) event.preventDefault();
      const dx = touch.clientX - g.x0;
      if (!g.axis) {
        g.axis = axisOf(dx, touch.clientY - g.y0);
        if (!g.axis) return;
      }
      if (g.axis === 'x') {
        if (opts.offset.max() > 0) { opts.offset.set(g.offset0 - dx); scrolled('x'); }
      } else {
        vertical(g, g.y - touch.clientY, touch.clientX, touch.clientY);
        g.samples.push({ t: now(), y: touch.clientY });
        if (g.samples.length > 32) g.samples.shift();
      }
      g.y = touch.clientY;
    };
    const onEnd = event => {
      if (!g || own(event)) return; // another finger was lifted
      const done = g;
      g = null;
      if (!done.axis) return; // a tap or a press: the browser's (click, double tap, long press)
      lastPan = now();
      if (event.type === 'touchend' && event.cancelable) event.preventDefault(); // no click and no compatibility mouse events after a pan
      if (done.axis === 'x') { if (opts.onHorizontalEnd) opts.onHorizontalEnd(); return; }
      if (event.type !== 'touchend' || term.buffer.active.type !== 'normal' || (opts.reducedMotion && opts.reducedMotion())) return;
      const v = velocity(done.samples, now());
      if (Math.abs(v) >= FLICK_MIN) startFling(v);
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
      stopFling();
      opts.offset.set(opts.offset.get() + sideways * unit);
      scrolled('x');
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
      flinging: () => Boolean(fling),
      stop: stopFling,
      dispose() {
        stopFling();
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
    axisOf, wideCols, columnsFor, maxOffset, clampOffset, followOffset, inView, takeLines, velocity, decay, wrapHint, attach,
  };
})();
if (typeof module !== 'undefined') module.exports = TerminalGestures;
