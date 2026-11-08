// The formatted views of the file sheet (Design.jsx): pretty-printed JSON and the table of a CSV / TSV file. Pure functions, tested in
// test/h5-file-kinds.test.js.

export const JSON_FORMAT_LIMIT = 2 * 1024 * 1024; // characters: a larger JSON file is shown as it is
export const TABLE_ROWS = 2000; // data rows of a CSV / TSV table (below the header); the rest is in the Source view

const stripBom = text => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

// The JSON text indented by `indent` spaces, one member or item per line, or null when it is not valid JSON (JSONC / JSON5 with comments are then
// shown as they are). The tokens are copied as written, never parsed and printed again, so a number too big for JavaScript (12345678901234567890)
// and the escapes inside strings stay exactly as in the file.
export function formatJson(text, indent = 2) {
  const source = stripBom(String(text));
  if (source.length > JSON_FORMAT_LIMIT || !source.trim()) return null;
  try { JSON.parse(source); } catch { return null; }
  const pad = depth => `\n${' '.repeat(depth * indent)}`;
  let out = '';
  let depth = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '"') {
      let end = i + 1;
      while (source[end] !== '"') end += source[end] === '\\' ? 2 : 1;
      out += source.slice(i, end + 1);
      i = end;
    } else if (ch === '{' || ch === '[') {
      let next = i + 1;
      while (/\s/.test(source[next])) next += 1;
      const close = ch === '{' ? '}' : ']';
      if (source[next] === close) { out += ch + close; i = next; continue; } // {} and [] stay on one line
      depth += 1;
      out += ch + pad(depth);
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      out += pad(depth) + ch;
    } else if (ch === ',') {
      out += `,${pad(depth)}`;
    } else if (ch === ':') {
      out += ': ';
    } else if (!/\s/.test(ch)) {
      out += ch;
    }
  }
  return `${out}\n`;
}

// The rows of a CSV (`,`) or TSV (tab) file, RFC 4180: a field in double quotes may hold the separator, line ends and "" for one quote; lines end
// with \r\n, \n or \r. Returns { rows, total }: the first `limit` rows (arrays of strings) and the number of rows in the whole file. An empty last
// line is not a row.
export function parseDelimited(text, separator = ',', limit = Infinity) {
  const source = stripBom(String(text));
  const rows = [];
  let total = 0;
  let row = [];
  let field = '';
  let quoted = false;
  let touched = false; // the row has something (a field, a separator or quotes), so a line end closes a row
  const endRow = () => {
    row.push(field);
    if (total < limit) rows.push(row);
    total += 1;
    row = [];
    field = '';
    touched = false;
  };
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      quoted = true;
      touched = true;
    } else if (ch === separator) {
      row.push(field);
      field = '';
      touched = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      if (touched || field) endRow();
      else { row = []; } // an empty line between rows is skipped
    } else {
      field += ch;
      touched = true;
    }
  }
  if (touched || field) endRow();
  return { rows, total };
}

export const separatorOf = filePath => (/\.tsv$/i.test(String(filePath || '')) ? '\t' : ',');
