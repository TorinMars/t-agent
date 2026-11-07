// Preserve the reader's position through keyboard, browser chrome and panel resizes.
const TerminalViewport = (() => {
  function capture(term) {
    const buffer = term.buffer.active;
    if (buffer.type !== 'normal') return null;
    return { bottom: buffer.viewportY >= buffer.baseY, distance: buffer.baseY - buffer.viewportY };
  }
  function restore(term, saved) {
    if (!saved || term.buffer.active.type !== 'normal') return;
    if (saved.bottom) term.scrollToBottom();
    else term.scrollToLine(Math.max(0, term.buffer.active.baseY - saved.distance));
  }
  // The width of one cell in CSS pixels: xterm's measured glyph width (fractional, the same for any column count; its css.cell.width is derived
  // from a rounded screen width and changes slightly with the columns, which could make the count flip between two values), else the drawn screen
  // divided by the columns.
  function cellWidth(term, host) {
    const glyph = term._core?._charSizeService?.width;
    if (glyph > 0) return glyph + Math.round(term.options?.letterSpacing || 0) / (globalThis.devicePixelRatio || 1);
    const screen = host.querySelector?.('.xterm-screen');
    const width = screen?.getBoundingClientRect?.().width || screen?.clientWidth || 0;
    return width > 0 && term.cols > 0 ? width / term.cols : 0;
  }
  // The columns that fit the host now. FitAddon takes the viewport scrollbar width off the host width, but xterm 5.5 measures that width once, at
  // start, and uses 15px whenever it measures 0, which is always the case with overlay scrollbars (phones, macOS): a phone lost two or three columns
  // on the right. Count only the room a scrollbar really takes now (offsetWidth - clientWidth of the viewport: 0 for an overlay scrollbar, the full
  // width for a classic one, which is drawn over the right edge of the screen) and no other reserve, so at most part of one cell stays empty.
  // xterm draws the screen Math.round(cols * cell) wide: take the most columns whose rounded screen still fits (0.05px of slack for a fractional
  // layout width just short of a whole pixel, which would otherwise flip the count between two values at start).
  function columns(term, host) {
    const viewport = host.querySelector?.('.xterm-viewport');
    const cell = cellWidth(term, host);
    if (!viewport || !(cell > 0)) return 0;
    const scrollbar = term.options?.scrollback === 0 ? 0 : Math.max(0, (viewport.offsetWidth || 0) - (viewport.clientWidth || 0));
    const style = term.element && typeof getComputedStyle === 'function' ? getComputedStyle(term.element) : null;
    const padding = style ? (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0) : 0;
    const available = (host.getBoundingClientRect?.().width || host.clientWidth) - padding - scrollbar;
    let cols = Math.floor((available + 0.5) / cell);
    if (Math.round(cols * cell) > available + 0.05) cols--;
    return Math.max(2, cols);
  }
  function fit(term, addon, host) {
    if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
    const size = addon.proposeDimensions();
    if (!size) return;
    const cols = columns(term, host);
    if (cols) size.cols = cols;
    if (size.cols === term.cols && size.rows === term.rows) return;
    const saved = capture(term);
    const buffer = term.buffer.active;
    const marker = saved && !saved.bottom
      ? term.registerMarker(buffer.viewportY - buffer.baseY - buffer.cursorY) : null;
    try {
      term.resize(size.cols, size.rows);
      if (marker && !marker.isDisposed && term.buffer.active.type === 'normal') term.scrollToLine(marker.line);
      else restore(term, saved);
    } finally { marker?.dispose(); }
  }
  // How far to shift a terminal up while the on-screen keyboard covers its bottom: the full amount, but never so far
  // that the cursor row leaves the top edge (a shell prompt near the top would otherwise be pushed out of sight).
  function keyboardShift(term, screenHeight, shift, topInset = 4) {
    if (!(shift > 0)) return 0;
    if (!(screenHeight > 0) || !(term.rows > 0)) return shift;
    const cursorTop = topInset + term.buffer.active.cursorY * (screenHeight / term.rows);
    return Math.max(0, Math.min(shift, Math.floor(cursorTop)));
  }
  function observe(term, addon, host) {
    if (typeof ResizeObserver === 'undefined') return null;
    let frame = 0, disposed = false;
    const schedule = () => {
      if (disposed || frame) return;
      frame = requestAnimationFrame(() => { frame = 0; if (!disposed) fit(term, addon, host); });
    };
    const observer = new ResizeObserver(schedule);
    for (const element of [host, host.querySelector('.xterm-viewport'), host.querySelector('.xterm-screen')]) {
      if (element) observer.observe(element);
    }
    document.fonts?.ready.then(schedule);
    return { disconnect() { disposed = true; observer.disconnect(); cancelAnimationFrame(frame); } };
  }
  return { capture, restore, fit, columns, keyboardShift, observe };
})();
