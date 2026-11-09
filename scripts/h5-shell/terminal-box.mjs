// Publishes where the terminal area (#h5-terminal, the column between the sidebar and the T-Attention panel) really is, as two CSS variables on the root
// element: --h5-terminal-left and --h5-terminal-width. The top sheets line up with it on a wide screen (TOP_SHEET_PAPER in Design.jsx). The values are
// measured, not worked out from the sidebar width, so whatever narrows the terminal is followed.
const ID = 'h5-terminal';

export function measureTerminalBox() {
  const node = document.getElementById(ID);
  if (!node) return;
  const { left, width } = node.getBoundingClientRect();
  if (width <= 0) return; // not laid out: keep the last good values
  const { style } = document.documentElement;
  style.setProperty('--h5-terminal-left', `${left}px`);
  style.setProperty('--h5-terminal-width', `${width}px`);
}

// Keeps the variables up to date; the window listener catches a move that leaves the width as it was. Returns the function that stops it.
export function trackTerminalBox() {
  const node = document.getElementById(ID);
  measureTerminalBox();
  const observer = node && typeof ResizeObserver === 'function' ? new ResizeObserver(measureTerminalBox) : null;
  if (observer) observer.observe(node);
  window.addEventListener('resize', measureTerminalBox);
  return () => {
    if (observer) observer.disconnect();
    window.removeEventListener('resize', measureTerminalBox);
  };
}
