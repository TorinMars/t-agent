// The plain-text view of the file sheet (scripts/h5-shell/Design.jsx) and the relative images of its Markdown view.
//
// Plain text: a file can have up to 5 MiB of lines, so only the lines in view (and BUFFER lines above and below) exist as elements; the rest is empty height
// in a box as tall as the whole file. Lines never wrap (white-space: pre), so every line has the same height and line n starts at (n - 1) * height. The
// line a link named is marked and scrolled to the middle, as before. Selecting and copying work on the drawn lines (they are drawn again, and a selection
// in them is lost, only when the view comes near their edge); Select all (Cmd/Ctrl+A inside the view) and copy take the whole file.

export const BUFFER = 60; // lines drawn beyond each edge of the view
const FALLBACK_HEIGHT = 19.2; // 12px at line-height 1.6 (.h5-file-text)

// The lines to draw for a view of `height` px scrolled to `top` px, with lines of `lineHeight` px: [first, end) (0-based, end excluded).
export function visibleRange(top, height, lineHeight, count, buffer = BUFFER) {
  const first = Math.min(count, Math.max(0, Math.floor(top / lineHeight) - buffer));
  const end = Math.min(count, Math.ceil((top + height) / lineHeight) + buffer);
  return [first, Math.max(first, end)];
}

export function splitLines(source) {
  const lines = String(source).split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// The widest line in characters (a tab counts as 4, tab-size of .h5-file-text), so the box is as wide as the widest line even when it is not drawn.
function widest(lines) {
  let most = 0;
  for (const line of lines) {
    if (line.length <= most && line.indexOf('\t') < 0) continue;
    let width = 0;
    for (let i = 0; i < line.length; i += 1) width = line.charCodeAt(i) === 9 ? width + 4 - (width % 4) : width + 1;
    if (width > most) most = width;
  }
  return most;
}

// Syntax highlighting (highlight.js, Design.jsx): the highlighted HTML of the whole file is cut into one piece per line, so the drawing above stays
// per line. A highlighted span can run over several lines (a comment block, a template string): it is closed at the end of each line and opened
// again at the start of the next, so every line is complete HTML on its own. `html` comes from highlight.js: text is escaped, the only tags are
// <span ...> and </span>. Line ends are '\n' (the source is given to highlight.js with \r\n and \r made '\n'); like splitLines, a last empty line
// is dropped, so the two give the same number of lines.
export function splitHighlighted(html) {
  const lines = [];
  const open = []; // the opening tags of the spans open at this point
  let current = '';
  for (const [token] of String(html).matchAll(/<span\b[^>]*>|<\/span>|\n|[^<\n]+|</g)) {
    if (token === '\n') {
      lines.push(current + '</span>'.repeat(open.length));
      current = open.join('');
    } else if (token === '</span>') {
      if (open.length) { open.pop(); current += token; }
    } else {
      if (token.startsWith('<span')) open.push(token);
      current += token;
    }
  }
  lines.push(current + '</span>'.repeat(open.length));
  if (lines.length > 1 && lines[lines.length - 1].replace(/<[^>]*>/g, '') === '') lines.pop();
  return lines;
}

// Draws `source` into `node` (the scrolling content box). `html`: the highlighted lines (splitHighlighted), as many as the lines of `source`; drawn
// with innerHTML instead of the plain text (selecting, copying and Select all still give the plain text). Returns { dispose(), range() }.
export function renderText(node, source, line, { html = null } = {}) {
  const lines = splitLines(source);
  const marked = Array.isArray(html) && html.length === lines.length ? html : null;
  const digits = String(lines.length).length;
  const pre = document.createElement('pre');
  pre.className = marked ? 'h5-file-text is-highlighted' : 'h5-file-text';
  pre.setAttribute('translate', 'no');
  pre.style.position = 'relative';
  const rows = document.createElement('div');
  rows.className = 'h5-file-rows';
  rows.style.position = 'absolute';
  rows.style.left = '0';
  rows.style.right = '0';
  rows.style.minWidth = 'max-content';
  pre.append(rows);
  node.replaceChildren(pre);

  const row = index => {
    const el = document.createElement('span');
    el.className = 'h5-file-line';
    el.dataset.line = String(index + 1);
    el.style.setProperty('--h5-line-digits', String(digits));
    if (marked) el.innerHTML = `${marked[index]}\n`;
    else el.textContent = `${lines[index]}\n`;
    if (line && index + 1 === line) el.classList.add('is-target');
    return el;
  };
  // One line drawn to measure the height of a line (and the width of a character, for the widest line).
  const probe = row(0);
  rows.append(probe);
  const lineHeight = probe.getBoundingClientRect().height || FALLBACK_HEIGHT;
  pre.style.height = `${lines.length * lineHeight}px`;
  rows.style.minWidth = `calc(${widest(lines)}ch + ${digits}ch + 44px)`; // the text, the line numbers and their padding (.h5-file-line)

  let drawn = [-1, -1];
  let frame = 0;
  function draw() {
    frame = 0;
    const offset = pre.offsetTop || 0; // the content box may have padding above the text
    const top = Math.max(0, node.scrollTop - offset);
    const height = node.clientHeight || 800;
    // The drawn lines still cover the view with some room on both sides: nothing changes, so a selection being made stays.
    const [seenFirst, seenEnd] = visibleRange(top, height, lineHeight, lines.length, 0);
    const room = BUFFER / 4;
    if (drawn[0] >= 0 && seenFirst - drawn[0] >= (drawn[0] === 0 ? 0 : room) && drawn[1] - seenEnd >= (drawn[1] === lines.length ? 0 : room)) return;
    const [first, end] = visibleRange(top, height, lineHeight, lines.length);
    const fragment = [];
    for (let i = first; i < end; i += 1) fragment.push(row(i));
    rows.replaceChildren(...fragment);
    rows.style.top = `${first * lineHeight}px`;
    drawn = [first, end];
  }
  const onScroll = () => { if (!frame) frame = requestAnimationFrame(draw); };
  node.addEventListener('scroll', onScroll, { passive: true });

  // Select all inside the view selects the whole file for the copy that follows (the lines out of view are not in the page).
  let all = false;
  const onKey = event => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key || '').toLowerCase() === 'a') {
      event.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(rows);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      all = true;
    }
  };
  const onCopy = event => {
    if (!all || !event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', lines.join('\n'));
  };
  const onSelection = () => { if (all && !String(window.getSelection() || '')) all = false; };
  node.tabIndex = node.tabIndex >= 0 ? node.tabIndex : -1; // keys reach the view after a tap or a click in it
  node.addEventListener('keydown', onKey);
  node.addEventListener('copy', onCopy);
  document.addEventListener('selectionchange', onSelection);

  node.scrollTop = 0;
  if (line && line >= 1 && line <= lines.length) node.scrollTop = Math.max(0, (pre.offsetTop || 0) + (line - 1) * lineHeight - node.clientHeight / 2);
  draw();

  return {
    range: () => drawn.slice(),
    lineHeight,
    highlighted: Boolean(marked),
    dispose() {
      cancelAnimationFrame(frame);
      node.removeEventListener('scroll', onScroll);
      node.removeEventListener('keydown', onKey);
      node.removeEventListener('copy', onCopy);
      document.removeEventListener('selectionchange', onSelection);
    },
  };
}

// A relative image of a Markdown file: its path inside the working directory, from the folder of the document (`docPath`, relative to the working
// directory too). null for what is not a relative path to an image inside the working directory (a web address is handled by the caller).
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i; // the image types of the image read (an SVG is only ever shown through <img>)
export function imagePath(docPath, href) {
  let value = String(href || '').trim();
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//') || value.startsWith('/') || value.startsWith('\\')) return null;
  value = value.replace(/[?#].*$/, '');
  try { value = decodeURIComponent(value); } catch { return null; }
  if (!IMAGE_FILE.test(value) || value.includes('\\') || value.includes('\0')) return null;
  const parts = String(docPath || '').split('/').slice(0, -1).filter(Boolean);
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}
