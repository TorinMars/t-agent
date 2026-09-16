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
    if (!size || (size.cols === term.cols && size.rows === term.rows)) return;
    const saved = capture(term);
    const buffer = term.buffer.active;
    const marker = saved && !saved.bottom
      ? term.registerMarker(buffer.viewportY - buffer.baseY - buffer.cursorY) : null;
    try {
      addon.fit();
      if (marker && !marker.isDisposed && term.buffer.active.type === 'normal') term.scrollToLine(marker.line);
      else restore(term, saved);
    } finally { marker?.dispose(); }
  }
  return { capture, restore, fit };
})();
