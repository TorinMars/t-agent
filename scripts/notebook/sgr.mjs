// SGR colours of the output lines of a cell ("Output" in docs/design/shell-notebook-page.md). The server normalises the output and keeps only the
// SGR sequences (`ESC [ ... m`); this module turns one line into runs of text with a style, and a style into CSS properties. Pure: the view makes
// the spans with textContent (never innerHTML), so the text of a program can never become markup.
//
// A style is { fg, bg, bold, dim, italic, underline, inverse }, fg / bg null (the default colour) or a CSS colour '#rrggbb'. The style carries over
// from line to line, as in a terminal: `styleAfter` gives the style at the start of a later line without making any runs.

const ESC = '\u001b';
const SGR = /\u001b\[([0-9;:]*)m/g;

// The 16 colours of the page's terminals (xterm.js 5.5 defaults, the page sets only the background), then the 6x6x6 cube and the grey ramp.
const BASE16 = [
  '#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
  '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec',
];
const hex2 = value => value.toString(16).padStart(2, '0');
const rgb = (r, g, b) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const CUBE = [0, 95, 135, 175, 215, 255];
export function color256(index) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  if (n < 16) return BASE16[n];
  if (n < 232) {
    const k = n - 16;
    return rgb(CUBE[Math.floor(k / 36)], CUBE[Math.floor(k / 6) % 6], CUBE[k % 6]);
  }
  const grey = 8 + (n - 232) * 10;
  return rgb(grey, grey, grey);
}

export const plainStyle = () => ({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false });
const sameStyle = (a, b) => a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline && a.inverse === b.inverse;
export const isPlain = style => sameStyle(style, plainStyle());

const byte = value => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
};

// The style after the parameters of one SGR sequence (`params`: the text between `ESC [` and `m`). Unknown codes are skipped. Both the `;` form
// (38;5;n, 38;2;r;g;b) and the `:` form (38:5:n, 38:2::r:g:b, 38:2:r:g:b) of extended colours are read.
export function applySgr(style, params) {
  const next = { ...style };
  const groups = params === '' ? ['0'] : params.split(';');
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (group.includes(':')) { // one parameter with its own sub-parameters
      const parts = group.split(':');
      const code = Number(parts[0]);
      if (code === 38 || code === 48) {
        const key = code === 38 ? 'fg' : 'bg';
        if (parts[1] === '5') next[key] = color256(parts[2]);
        else if (parts[1] === '2') {
          const values = parts.length >= 6 ? parts.slice(3, 6) : parts.slice(2, 5); // with or without the colour space id
          const [r, g, b] = values.map(byte);
          if (r !== null && g !== null && b !== null) next[key] = rgb(r, g, b);
        }
      } else if (code === 4) next.underline = parts[1] !== '0';
      continue;
    }
    const code = group === '' ? 0 : Number(group);
    if (!Number.isInteger(code)) continue;
    if (code === 0) Object.assign(next, plainStyle());
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 21 || code === 22) { next.bold = false; next.dim = false; }
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.inverse = false;
    else if (code >= 30 && code <= 37) next.fg = BASE16[code - 30];
    else if (code === 39) next.fg = null;
    else if (code >= 40 && code <= 47) next.bg = BASE16[code - 40];
    else if (code === 49) next.bg = null;
    else if (code >= 90 && code <= 97) next.fg = BASE16[code - 90 + 8];
    else if (code >= 100 && code <= 107) next.bg = BASE16[code - 100 + 8];
    else if (code === 38 || code === 48) {
      const key = code === 38 ? 'fg' : 'bg';
      if (groups[i + 1] === '5') { next[key] = color256(groups[i + 2]); i += 2; }
      else if (groups[i + 1] === '2') {
        const [r, g, b] = groups.slice(i + 2, i + 5).map(byte);
        if (r !== null && g !== null && b !== null) next[key] = rgb(r, g, b);
        i += 4;
      }
    }
  }
  return next;
}

// One line as runs [{ text, style }] (no empty runs; neighbours of the same style joined), and the style at its end. Any other escape that is
// still there (the server drops them, an older file may have them) is removed with its ESC, so no control character reaches the page.
export function parseLine(line, start = plainStyle()) {
  const text = String(line == null ? '' : line);
  const runs = [];
  let style = start;
  let at = 0;
  const push = piece => {
    const clean = piece.split(ESC).join('');
    if (!clean) return;
    const last = runs[runs.length - 1];
    if (last && sameStyle(last.style, style)) last.text += clean;
    else runs.push({ text: clean, style });
  };
  SGR.lastIndex = 0;
  for (let match = SGR.exec(text); match; match = SGR.exec(text)) {
    push(text.slice(at, match.index));
    style = applySgr(style, match[1]);
    at = match.index + match[0].length;
  }
  push(text.slice(at));
  return { runs, end: style };
}

// The style at the start of line `to`, from the style at the start of line `from` (only the SGR sequences are read).
export function styleAfter(lines, from, to, start = plainStyle()) {
  let style = start;
  for (let i = Math.max(0, from); i < to && i < lines.length; i++) {
    const text = String(lines[i] == null ? '' : lines[i]);
    if (!text.includes(ESC)) continue;
    SGR.lastIndex = 0;
    for (let match = SGR.exec(text); match; match = SGR.exec(text)) style = applySgr(style, match[1]);
  }
  return style;
}

// The text of a line without its SGR sequences (Download, the copy of a line).
export const stripSgr = line => String(line == null ? '' : line).replace(SGR, '').split(ESC).join('');

// The default colours of the output (the text and the page's background): what an inverse run swaps.
export const DEFAULT_FG = 'rgba(255, 255, 255, 0.78)';
export const DEFAULT_BG = '#121212';

// The CSS of a style: { color?, backgroundColor?, fontWeight?, fontStyle?, textDecoration?, opacity? } (only what differs from the default).
export function styleCss(style) {
  const css = {};
  let fg = style.fg;
  let bg = style.bg;
  if (style.inverse) {
    const swappedFg = bg || DEFAULT_BG;
    bg = fg || '#e0e0e0';
    fg = swappedFg;
  }
  if (fg) css.color = fg;
  if (bg) css.backgroundColor = bg;
  if (style.bold) css.fontWeight = '700';
  if (style.italic) css.fontStyle = 'italic';
  if (style.underline) css.textDecoration = 'underline';
  if (style.dim) css.opacity = '0.6';
  return css;
}

// ── Output windowing ("Long output" in docs/design/shell-notebook-page.md) ──
export const WINDOW_LINES = 200;
// Which of the kept lines a cell shows: all of them (`showAll`, or no more than WINDOW_LINES), else the last WINDOW_LINES. `total` counts the lines
// the server dropped too (`dropped`), as "Last 200 of 12,408 lines" says.
export function outputWindow(lineCount, dropped = 0, showAll = false, size = WINDOW_LINES) {
  const kept = Math.max(0, Number(lineCount) || 0);
  const cut = Math.max(0, Number(dropped) || 0);
  const total = kept + cut;
  const start = showAll || kept <= size ? 0 : kept - size;
  return { start, end: kept, total, shown: kept - start, windowed: total > size, dropped: cut };
}
