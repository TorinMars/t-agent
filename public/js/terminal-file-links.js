// File paths in terminal output become links that open the file in the task's file browser (desktop: the file panel, phone: the file preview sheet).
// findFileLinks() finds path-like text in one logical line (pure, unit tested in test/terminal-file-links.test.js), toRelative() turns a found path
// into a path relative to the task's working directory (or null when it is outside), and attach() registers an xterm link provider that uses both.
// Nothing is sent to the server while text is printed or hovered: whether the file exists is only asked for when a link is activated.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TerminalFileLinks = api;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const MAX_PATH = 1024;
  const MAX_LINE = 4096; // characters of one logical (wrapped) line that are searched
  const MAX_WRAPPED_ROWS = 32;
  // A name without a slash is only a link with one of these extensions (so "e.g." or "example.com" are not links).
  const KNOWN_EXTENSIONS = new Set(('bash bat c cc cfg cjs conf cpp cs css csv cxx dart dockerfile env erl ex exs fish go gradle h hpp htm html ini ipynb '
    + 'java js json jsonc jsx kt less lock log lua m markdown md mdx mjs ml mm php pl plist properties py r rb rs sass scala scss sh sql '
    + 'svelte swift toml ts tsv tsx txt vue xml yaml yml zsh').split(' '));
  const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]*/gi;
  const QUOTED_RE = /(["'`])([^"'`\r\n]{1,1024}?)\1/g;
  // Delimiters: white space, brackets, quotes, | ; , and CJK punctuation (full-width comma, full stop, colon, semicolon, ! ? ( ) and the
  // corner, book and lenticular brackets).
  const TOKEN_RE = /[^\s()[\]{}<>"'`|;,、。，：；！？（）「」『』【】《》]+/g;
  const TRAILING_RE = /[.:!?…]+$/; // sentence punctuation after a path ("see src/app.js." / "in a.js:")
  // A position after the path: ":42", ":42:7", ":42-50", "#L42", "#L42-L50".
  const POSITION_RE = /(?::(\d{1,7})(?::(\d{1,5}))?(?:-\d{1,7})?|#L(\d{1,7})(?:C(\d{1,5}))?(?:-L?\d{1,7})?)$/;
  const LETTER_RE = /[\p{L}_]/u;

  function extensionOf(name) {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  // Is this (already trimmed, position removed) text a file path? Absolute paths, ./ and ../ paths and a/b paths; a bare name needs a known extension.
  function pathLike(value) {
    if (!value || value.length > MAX_PATH || /[\u0000-\u001f\u007f\\]/.test(value)) return false;
    if (value.includes(':') || value.startsWith('~') || value.startsWith('//')) return false;
    const directory = value.endsWith('/');
    const body = directory ? value.replace(/\/+$/, '') : value;
    if (!body || /^[./]+$/.test(body)) return false; // "/", ".", "..", "./"
    const parts = body.split('/');
    if (parts.some((part, index) => !part && index > 0)) return false; // "a//b"
    const last = parts[parts.length - 1];
    if (!LETTER_RE.test(last)) return false; // dates and numbers: 2026/11/05, 1/2
    if (parts.length === 1 && directory) return last.length > 1 && !last.includes('.'); // "lib/"
    if (parts.length === 1) return KNOWN_EXTENSIONS.has(extensionOf(last)) && LETTER_RE.test(last.slice(0, last.lastIndexOf('.')));
    const first = parts[0];
    // "github.com/owner/repo", "www.example.org/page": the first part looks like a host name, not a folder.
    if (first && !first.startsWith('.') && first.includes('.') && !KNOWN_EXTENSIONS.has(extensionOf(first))) return false;
    return true;
  }

  // Splits ":42:7" / "#L42" off the end. Returns { path, line, column } (line and column are numbers or null).
  function splitPosition(value) {
    const match = POSITION_RE.exec(value);
    if (!match || match.index === 0) return { path: value, line: null, column: null };
    const line = Number(match[1] || match[3]);
    const column = match[2] || match[4] ? Number(match[2] || match[4]) : null;
    return { path: value.slice(0, match.index), line: line > 0 ? line : null, column: column > 0 ? column : null };
  }

  function candidate(index, raw, out) {
    let start = index;
    let value = raw;
    if (value.startsWith('@')) { value = value.slice(1); start += 1; } // "@src/app.js" mentions
    value = value.replace(TRAILING_RE, ''); // "see src/app.js." / "in src/app.js:42:"
    const position = splitPosition(value);
    if (!pathLike(position.path)) return false;
    out.push({ index: start, length: value.length, text: value, path: position.path, line: position.line, column: position.column, directory: position.path.endsWith('/') });
    return true;
  }

  function overlaps(spans, start, end) {
    return spans.some(span => start < span.end && end > span.start);
  }

  // All file links in one line of text, in order: [{ index, length, text, path, line, column, directory }]. index/length are in UTF-16 code units of
  // `text`; `path` is what the link points to (decoded for file:// URLs), `text` the part of the line that is the link.
  function findFileLinks(input) {
    const text = String(input || '').slice(0, MAX_LINE);
    const out = [];
    const taken = [];
    URL_RE.lastIndex = 0;
    for (let match; (match = URL_RE.exec(text));) {
      const url = match[0].replace(/[.,:;!?)\]}'"]+$/, '');
      taken.push({ start: match.index, end: match.index + url.length });
      if (!/^file:\/\//i.test(url)) continue; // web links are left to the web links addon
      const rest = url.slice(7);
      const slash = rest.indexOf('/');
      const host = slash < 0 ? rest : rest.slice(0, slash);
      if (slash < 0 || (host && host.toLowerCase() !== 'localhost')) continue;
      let decoded;
      try { decoded = decodeURIComponent(rest.slice(slash)); } catch { continue; }
      const position = splitPosition(decoded);
      if (!pathLike(position.path)) continue;
      out.push({ index: match.index, length: url.length, text: url, path: position.path, line: position.line, column: position.column, directory: position.path.endsWith('/') });
    }
    // Quoted paths may hold spaces: "my notes/plan.md". Unquoted, a space ends the path.
    QUOTED_RE.lastIndex = 0;
    for (let match; (match = QUOTED_RE.exec(text));) {
      const inner = match[2];
      const start = match.index + 1;
      if (inner.trim() !== inner || !inner.includes(' ') || overlaps(taken, start, start + inner.length)) continue;
      const position = splitPosition(inner);
      if (!pathLike(position.path)) continue;
      out.push({ index: start, length: inner.length, text: inner, path: position.path, line: position.line, column: position.column, directory: position.path.endsWith('/') });
      taken.push({ start: match.index, end: match.index + match[0].length });
    }
    TOKEN_RE.lastIndex = 0;
    for (let match; (match = TOKEN_RE.exec(text));) {
      if (overlaps(taken, match.index, match.index + match[0].length)) continue;
      candidate(match.index, match[0], out);
    }
    return out.sort((left, right) => left.index - right.index);
  }

  // The path relative to the working directory `root` ('' is the root itself), or null when it is outside the root or cannot be placed.
  // Relative paths are taken relative to the root. Only the text is compared: the server checks the real path (no symbolic links) again.
  function toRelative(filePath, root) {
    let rest = String(filePath || '');
    if (rest.startsWith('/')) {
      if (!root || !String(root).startsWith('/')) return null;
      const base = String(root).replace(/\/+$/, '');
      if (rest.replace(/\/+$/, '') === base) return '';
      if (base && !rest.startsWith(`${base}/`)) return null;
      rest = rest.slice(base.length + 1);
    }
    const parts = [];
    for (const part of rest.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!parts.length) return null; parts.pop(); continue; }
      parts.push(part);
    }
    return parts.join('/');
  }

  // The logical line (the row and the rows wrapped into it) around buffer row `row` (0-based), as text plus the cell of each code unit.
  function logicalLine(buffer, row) {
    let first = row;
    while (first > 0 && row - first < MAX_WRAPPED_ROWS && buffer.getLine(first)?.isWrapped) first -= 1;
    let text = '';
    const cells = [];
    for (let y = first; y < first + MAX_WRAPPED_ROWS && text.length < MAX_LINE; y += 1) {
      const line = buffer.getLine(y);
      if (!line || (y > first && !line.isWrapped)) break;
      for (let x = 0; x < line.length; x += 1) {
        const cell = line.getCell(x);
        const width = cell ? cell.getWidth() : 1;
        if (!width) continue; // the second half of a wide (CJK) character
        const chars = (cell && cell.getChars()) || ' ';
        for (let i = 0; i < chars.length; i += 1) cells.push({ x, y, width });
        text += chars;
      }
    }
    return { text, cells };
  }

  // Registers the link provider on an xterm Terminal. options: root() -> the working directory or null, activate(link, event) where link also has
  // `relative` (the path for the file API). Returns the disposable of the provider.
  function attach(term, options) {
    return term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        try {
          const row = bufferLineNumber - 1;
          const root = options.root ? options.root() : null;
          const { text, cells } = logicalLine(term.buffer.active, row);
          const links = [];
          for (const link of findFileLinks(text)) {
            const relative = toRelative(link.path, root);
            if (relative == null) continue; // outside the working directory: the file browser cannot show it, so it is not a link
            const start = cells[link.index];
            const end = cells[link.index + link.length - 1];
            if (!start || !end || row < start.y || row > end.y) continue;
            const found = { ...link, relative };
            links.push({
              range: { start: { x: start.x + 1, y: start.y + 1 }, end: { x: end.x + end.width, y: end.y + 1 } },
              text: link.text,
              decorations: { pointerCursor: true, underline: true },
              activate: event => options.activate(found, event),
            });
          }
          callback(links.length ? links : undefined);
        } catch {
          callback(undefined);
        }
      },
    });
  }

  return { findFileLinks, toRelative, attach, pathLike, splitPosition, MAX_LINE };
});
