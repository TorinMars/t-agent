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
  function fit(term, addon, host) {
    if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
    const size = addon.proposeDimensions();
    if (!size) return;
    // FitAddon caches scrollbar width at startup. Measure the current clipping
    // area as well, since browser zoom or scrollbar settings may change it.
    const screen = host.querySelector?.('.xterm-screen');
    const viewport = host.querySelector?.('.xterm-viewport');
    if (screen?.clientWidth > 0 && viewport?.clientWidth > 0) {
      const cellWidth = screen.clientWidth / term.cols;
      const available = Math.min(host.clientWidth, viewport.clientWidth) - 2;
      size.cols = Math.min(size.cols, Math.max(2, Math.floor(available / cellWidth)));
    }
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
  return { capture, restore, fit, observe };
})();
