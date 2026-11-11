// Reads the input line of a terminal from its xterm screen: does the line the cursor is on already hold text the person typed? The page cannot read a
// program's own input buffer, so this looks at the cells of the screen (the xterm 5.5 buffer API: `buffer.active`, `getLine`, `getCell`). Translate-and-send
// (`sendTranslation` in public/js/h5.js) uses it to put a translation on a new line after text that is already there.
//
// Rules (`read(buffer)` returns `{ known, hasText }`):
// - The input line starts at the cursor row. Rows that soft-wrap (`isWrapped`) above and below it belong to the same line.
// - The line must start with a prompt marker; only what follows the marker counts:
//   - TUI markers at the start of the row, after spaces and an optional box border (U+2502 and similar): Claude Code U+276F and, in older versions boxed,
//     ">"; Codex U+203A. Each must be followed by a space (or the end of the row).
//   - Shell markers: the first "$ ", "% ", "# " or U+276F + space on the line (bash, zsh, root, starship / pure).
// - Claude Code and Codex draw multi-line input as separate rows, not wrapped ones. When the cursor row has no marker, the rows above it are searched for a
//   TUI marker, up to MAX_ROWS and never past a horizontal box border (the top of Claude Code's input box), so a line of the transcript above the box does not
//   count. With a TUI marker, the rows below the cursor count only when a border closes the box within MAX_ROWS (Claude Code); otherwise (Codex, whose
//   footer hints sit below the input) only soft-wrapped rows below count.
// - Box borders and padding are not text. Placeholder text is not text: cells drawn dim (SGR 2) or in palette color 8 (bright black, zsh-autosuggestions'
//   default) do not count, and an inverse cell followed by a dim one is the drawn cursor on the first letter of a placeholder (Claude Code draws a
//   placeholder as `invert(first letter) + dim(rest)`).
// - A right prompt on the cursor's line (a shell's RPROMPT: a run of text that ends in the last two columns after at least three blank cells) is not text.
// - Anything that cannot be understood (no buffer, no marker, the cursor on a border) gives `{ known: false, hasText: false }`: the caller then keeps the
//   old behaviour for an empty line.
const TerminalInputLine = (() => {
  const MAX_ROWS = 40;
  const MARKER_CLAUDE = '❯';
  const MARKER_CODEX = '›';
  const VERTICAL = new Set(['│', '┃', '║', '|']);
  const HORIZONTAL = '─━═╌╍┄┅┈┉';
  const BORDER = new RegExp(`^[\\u256d\\u2570\\u250c\\u2514\\u251c\\u2552\\u2558\\u2554\\u255a]?[${HORIZONTAL}]{3,}`);
  const SHELL_MARKERS = new Set(['$', '%', '#', MARKER_CLAUDE]);
  const blank = cell => !cell || cell.ch === ' ' || cell.ch === '';

  function cellOf(cell, x, y) {
    const ch = cell.getChars() || ' ';
    const palette8 = typeof cell.isFgPalette === 'function' && cell.isFgPalette() && cell.getFgColor() === 8;
    return { ch, x, y, end: x + cell.getWidth(), faint: Boolean(cell.isDim()) || palette8, inverse: Boolean(cell.isInverse()) };
  }
  // The cells of one screen row, one entry per character (the second half of a wide character is skipped).
  function rowCells(buffer, y) {
    const line = buffer.getLine(y);
    if (!line) return null;
    const cells = [];
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      cells.push(cellOf(cell, x, y));
    }
    return cells;
  }
  const textOf = cells => cells.map(cell => cell.ch).join('');
  const isBorder = cells => BORDER.test(textOf(cells).trim().replace(/^[│┃║]\s*/, ''));

  // A row without its box: leading spaces, a left border and the spaces after it, and a right border with the spaces before it.
  function unbox(cells) {
    let start = 0;
    let end = cells.length;
    while (start < end && blank(cells[start])) start++;
    let boxed = false;
    if (start < end && VERTICAL.has(cells[start].ch)) {
      boxed = true;
      start++;
      while (start < end && blank(cells[start])) start++;
    }
    let last = end - 1;
    while (last >= start && blank(cells[last])) last--;
    if (boxed && last >= start && VERTICAL.has(cells[last].ch)) end = last;
    return { cells: cells.slice(start, end), boxed };
  }
  // The TUI marker at the start of a row: { content } or null. ">" counts only inside a box or on the cursor's own line.
  function tuiMarker(cells, allowBare) {
    const { cells: inner, boxed } = unbox(cells);
    const first = inner[0];
    if (!first) return null;
    const ok = first.ch === MARKER_CLAUDE || first.ch === MARKER_CODEX || (first.ch === '>' && (boxed || allowBare));
    if (!ok || !(inner.length === 1 || blank(inner[1]))) return null;
    return { kind: 'tui', content: inner.slice(1) };
  }
  // The first shell marker on the line: { content } or null.
  function shellMarker(cells) {
    for (let i = 0; i < cells.length - 1; i++) {
      if (SHELL_MARKERS.has(cells[i].ch) && blank(cells[i + 1])) return { kind: 'shell', content: cells.slice(i + 1) };
    }
    return null;
  }
  // A right prompt: the last run of text on the line's last row ends in the last two columns and has at least three blank cells before it.
  function withoutRightPrompt(cells, columns, row) {
    let last = cells.length - 1;
    while (last >= 0 && blank(cells[last])) last--;
    if (last < 0 || cells[last].y !== row || cells[last].end < columns - 1) return cells;
    for (let i = last; i >= 2; i--) {
      if (blank(cells[i]) && blank(cells[i - 1]) && blank(cells[i - 2])) return cells.slice(0, i - 2);
    }
    return cells;
  }
  function typed(cells) {
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      if (blank(cell) || cell.faint) continue;
      if (cell.inverse && cells[i + 1] && cells[i + 1].faint) continue; // the drawn cursor on a placeholder's first letter
      return true;
    }
    return false;
  }
  // Rows below a TUI line, up to a closing border; none when no border closes them within MAX_ROWS.
  function boxRowsBelow(buffer, from) {
    const rows = [];
    for (let y = from; y < Math.min(buffer.length, from + MAX_ROWS); y++) {
      const cells = rowCells(buffer, y);
      if (!cells) break;
      if (isBorder(cells)) return rows;
      rows.push(unbox(cells).cells);
    }
    return [];
  }

  function read(buffer) {
    const unknown = { known: false, hasText: false };
    if (!buffer || typeof buffer.getLine !== 'function') return unknown;
    const y = buffer.baseY + buffer.cursorY;
    if (!buffer.getLine(y)) return unknown;
    let top = y;
    while (top > 0 && buffer.getLine(top) && buffer.getLine(top).isWrapped) top--;
    let bottom = y;
    while (buffer.getLine(bottom + 1) && buffer.getLine(bottom + 1).isWrapped) bottom++;
    let line = [];
    for (let row = top; row <= bottom; row++) line = line.concat(rowCells(buffer, row) || []);
    if (isBorder(rowCells(buffer, y) || [])) return unknown;
    const columns = buffer.getLine(bottom).length;

    let marker = tuiMarker(line, true) || shellMarker(line);
    let pieces;
    if (marker) {
      pieces = [withoutRightPrompt(marker.content, columns, bottom)];
      if (marker.kind === 'tui') pieces = pieces.concat(boxRowsBelow(buffer, bottom + 1));
    } else {
      // Multi-line input of a TUI: the marker is on a row above the cursor, inside the same box.
      for (let row = top - 1; row >= Math.max(0, top - MAX_ROWS); row--) {
        const cells = rowCells(buffer, row);
        if (!cells || isBorder(cells)) break;
        marker = tuiMarker(cells, false);
        if (!marker) continue;
        pieces = [marker.content];
        for (let below = row + 1; below < top; below++) pieces.push(unbox(rowCells(buffer, below) || []).cells);
        pieces.push(unbox(line).cells);
        pieces = pieces.concat(boxRowsBelow(buffer, bottom + 1));
        break;
      }
      if (!marker) return unknown;
    }
    return { known: true, hasText: pieces.some(typed) };
  }
  return { read, MAX_ROWS };
})();
if (typeof window !== 'undefined') window.TerminalInputLine = TerminalInputLine;
if (typeof module !== 'undefined') module.exports = TerminalInputLine;
