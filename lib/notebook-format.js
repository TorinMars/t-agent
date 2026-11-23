// The file side of the Shell notebook ("The file" and "Output lines" in docs/design/shell-notebook.md): reading and writing .ipynb files
// (nbformat 4.5), the normaliser that turns a terminal's output into the lines a cell shows, and the safe paths of notebook files inside a
// task folder. No kernel and no database here: services/notebook-kernels.js uses these pieces.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_LINES = 10000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const LINE_WIDTH = 4000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_LISTED = 200;
const SLUG_MAX = 60;
// The longest unfinished escape sequence kept between two chunks; a longer one is junk and is dropped.
const MAX_PENDING_ESCAPE = 64 * 1024;
const CELL_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const STATES = new Set(['idle', 'queued', 'running', 'done', 'failed', 'stopped', 'interrupted', 'fullscreen']);
const KERNELSPEC = { name: 'bash', display_name: 'Bash', language: 'bash' };

const fail = (code, statusCode) => Object.assign(new Error(code), { statusCode });
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const newCellId = () => crypto.randomBytes(4).toString('hex');

// ── Output lines ──
// A terminal's output as lines of text, the way a terminal would show them: "\r\n" and "\n" end a line, a bare "\r" returns to the start of the
// line (later text overwrites it), "\b" deletes one character, SGR sequences (ESC [ ... m) are kept in the text, ESC [ K erases (as a terminal
// does, and is then dropped), every other escape sequence (other CSI, OSC, DCS, SOS, PM, APC, charset and two-byte escapes) and every other
// control character except "\t" is dropped. A line longer than `lineWidth` characters wraps into more lines. Only the last `maxLines` lines and
// at most `maxBytes` (UTF-8) are kept; `dropped` counts the lines cut from the front. Chunks may split a sequence anywhere: write() keeps the
// unfinished part for the next chunk.
function createOutput({ maxLines = MAX_LINES, maxBytes = MAX_OUTPUT_BYTES, lineWidth = LINE_WIDTH } = {}) {
  const lines = [];
  let bytes = 0;
  let dropped = 0;
  let current = []; // the glyphs of the line being written; a glyph is one character with the SGR sequences that came before it
  let col = 0;
  let sgr = ''; // SGR sequences waiting for the next character
  let pending = '';
  let dirty = Infinity; // the lowest line index changed since the last takeChange()
  let droppedAtTake = 0;

  const touch = () => { if (lines.length < dirty) dirty = lines.length; };
  const trim = () => {
    let cut = 0;
    while (lines.length - cut > maxLines || (bytes > maxBytes && lines.length - cut > 0)) {
      bytes -= Buffer.byteLength(lines[cut]) + 1;
      cut += 1;
    }
    if (cut) { lines.splice(0, cut); dropped += cut; }
  };
  const endLine = () => {
    touch();
    const text = current.join('') + (current.length ? sgr : '');
    if (current.length) sgr = '';
    lines.push(text);
    bytes += Buffer.byteLength(text) + 1;
    current = [];
    col = 0;
    trim();
  };
  const put = ch => {
    if (col >= lineWidth) endLine();
    const glyph = sgr + ch;
    sgr = '';
    if (col < current.length) current[col] = glyph;
    else current.push(glyph);
    col += 1;
    touch();
  };
  const erase = mode => {
    touch();
    if (mode === 0) current.length = Math.min(current.length, col);
    else if (mode === 1) for (let i = 0; i <= col && i < current.length; i++) current[i] = ' ';
    else if (mode === 2) current = current.slice(0, col).map(() => ' ');
  };

  // The end (exclusive) of the escape sequence that starts at `i`, with what it is; null while it is not complete yet.
  function escapeAt(text, i) {
    const next = text[i + 1];
    if (next === undefined) return null;
    if (next === '[') {
      let j = i + 2;
      while (j < text.length) {
        const code = text.charCodeAt(j);
        if (code >= 0x40 && code <= 0x7e) {
          const body = text.slice(i + 2, j);
          if (text[j] === 'm') return { end: j + 1, kind: 'sgr', seq: text.slice(i, j + 1) };
          if (text[j] === 'K' && /^\d*$/.test(body)) return { end: j + 1, kind: 'erase', mode: Number(body || 0) };
          return { end: j + 1, kind: 'drop' };
        }
        if (code < 0x20 || code > 0x3f) return { end: j, kind: 'drop' }; // malformed: drop what came so far
        j += 1;
      }
      return null;
    }
    if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
      for (let j = i + 2; j < text.length; j++) {
        if (text[j] === '\x07' && next === ']') return { end: j + 1, kind: 'drop' };
        if (text[j] === '\x1b') {
          if (j + 1 >= text.length) return null;
          if (text[j + 1] === '\\') return { end: j + 2, kind: 'drop' };
        }
      }
      return null;
    }
    if ('()*+-./#%'.includes(next)) return i + 2 < text.length ? { end: i + 3, kind: 'drop' } : null;
    return { end: i + 2, kind: 'drop' };
  }

  function write(chunk) {
    const text = pending + String(chunk);
    pending = '';
    let i = 0;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code === 0x1b) {
        const found = escapeAt(text, i);
        if (!found) {
          if (text.length - i <= MAX_PENDING_ESCAPE) { pending = text.slice(i); return; }
          i += 1; // too long to be real: drop the ESC and go on with the rest as text
          continue;
        }
        if (found.kind === 'sgr') sgr += found.seq;
        else if (found.kind === 'erase') erase(found.mode);
        i = found.end;
        continue;
      }
      if (code === 0x0a) { endLine(); i += 1; continue; }
      if (code === 0x0d) { col = 0; i += 1; continue; }
      if (code === 0x08) {
        if (col > 0) {
          touch();
          if (col === current.length) current.pop();
          col -= 1;
        }
        i += 1;
        continue;
      }
      if (code === 0x09) { put('\t'); i += 1; continue; }
      if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) { i += 1; continue; }
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        const low = text.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) { put(text.slice(i, i + 2)); i += 2; continue; }
      }
      if (code >= 0xd800 && code <= 0xdbff && i + 1 >= text.length) { pending = text.slice(i); return; }
      put(text[i]);
      i += 1;
    }
  }

  // The lines as shown: the finished ones and the one being written (when it has text).
  const view = () => (current.length ? [...lines, current.join('')] : lines.slice());
  return {
    write,
    // The run ended: the line being written becomes a finished line; an unfinished escape sequence is dropped.
    finish() {
      pending = '';
      if (current.length) endLine();
      sgr = '';
    },
    view,
    get dropped() { return dropped; },
    // The output stops in the middle of a line (a prompt waiting for an answer).
    get partial() { return current.length > 0; },
    // Lines were cut from the front since the last takeChange(): the next change replaces every line.
    get cutSinceTake() { return dropped !== droppedAtTake; },
    // What changed since the last call: { from, lines } (replace the lines from index `from` on), or null when nothing changed.
    takeChange() {
      const cut = dropped !== droppedAtTake;
      if (dirty === Infinity && !cut) return null;
      const all = view();
      const from = cut ? 0 : Math.min(dirty, all.length);
      dirty = Infinity;
      droppedAtTake = dropped;
      return { from, lines: all.slice(from) };
    },
  };
}

// Lines of a text read with the normaliser (a file's outputs).
function normaliseText(text, options) {
  const out = createOutput(options);
  out.write(text);
  out.finish();
  return { lines: out.view(), dropped: out.dropped };
}

// ── The .ipynb file ──
const joinSource = value => (Array.isArray(value) ? value.map(part => (typeof part === 'string' ? part : '')).join('') : typeof value === 'string' ? value : '');
// Jupyter's way of storing text: lines that keep their "\n".
const sourceLines = text => (text ? text.split(/(?<=\n)/) : []);
const intOrNull = value => (Number.isSafeInteger(value) ? value : null);

function outputText(outputs) {
  let text = '';
  const add = part => { if (part) text += part.endsWith('\n') ? part : `${part}\n`; };
  for (const output of Array.isArray(outputs) ? outputs : []) {
    if (!isObject(output)) continue;
    if (output.output_type === 'stream') text += joinSource(output.text);
    else if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
      if (isObject(output.data) && output.data['text/plain'] !== undefined) add(joinSource(output.data['text/plain']));
    } else if (output.output_type === 'error') {
      add(Array.isArray(output.traceback) ? output.traceback.filter(line => typeof line === 'string').join('\n') : `${output.ename || 'Error'}: ${output.evalue || ''}`);
    }
  }
  return text;
}

const KNOWN_CELL_KEYS = new Set(['cell_type', 'id', 'source', 'metadata', 'outputs', 'execution_count']);

// One cell of the file as the server holds it: { id, type, source, origType, metadata, keep, [code: count, state, exit, duration_ms,
// started_at, ended_at, lines, dropped, rawOutputs] }. `keep` holds the fields this format does not know (written back as they were),
// `rawOutputs` the file's own outputs until the cell runs or is cleared (so a notebook made elsewhere keeps its pictures).
function readCell(raw, seen) {
  if (!isObject(raw)) return null;
  let id = typeof raw.id === 'string' && CELL_ID.test(raw.id) && !seen.has(raw.id) ? raw.id : null;
  while (!id || seen.has(id)) id = newCellId();
  seen.add(id);
  const keep = {};
  for (const [key, value] of Object.entries(raw)) if (!KNOWN_CELL_KEYS.has(key)) keep[key] = value;
  const metadata = isObject(raw.metadata) ? { ...raw.metadata } : {};
  const ours = isObject(metadata['t-agent']) ? metadata['t-agent'] : {};
  delete metadata['t-agent'];
  const cell = { id, type: raw.cell_type === 'code' ? 'code' : 'markdown', origType: typeof raw.cell_type === 'string' ? raw.cell_type : 'markdown', source: joinSource(raw.source), metadata, keep };
  if (cell.type !== 'code') return cell;
  const { lines, dropped } = normaliseText(outputText(raw.outputs));
  const count = intOrNull(raw.execution_count);
  let state = STATES.has(ours.state) ? ours.state : (count !== null ? 'done' : 'idle');
  if (state === 'running' || state === 'queued') state = 'interrupted'; // saved while it ran, and the server stopped
  Object.assign(cell, {
    count, state, exit: intOrNull(ours.exit), duration_ms: intOrNull(ours.duration_ms), started_at: intOrNull(ours.started_at), ended_at: intOrNull(ours.ended_at),
    lines, dropped: dropped + (intOrNull(ours.dropped) || 0),
    ...(typeof ours.program === 'string' ? { program: ours.program } : {}),
  });
  if (Array.isArray(raw.outputs) && raw.outputs.some(output => isObject(output) && output.output_type !== 'stream')) cell.rawOutputs = raw.outputs;
  return cell;
}

function newCodeCell(source = '', id = newCellId()) {
  return { id, type: 'code', origType: 'code', source, metadata: {}, keep: {}, count: null, state: 'idle', exit: null, duration_ms: null, started_at: null, ended_at: null, lines: [], dropped: 0 };
}
function newMarkdownCell(source = '', id = newCellId()) {
  return { id, type: 'markdown', origType: 'markdown', source, metadata: {}, keep: {} };
}

// A new notebook: one empty code cell.
function emptyNotebook() {
  return { metadata: {}, extra: {}, cells: [newCodeCell()] };
}

// Parses the text of an .ipynb file: { metadata, extra, cells }. An empty file is a new notebook. Not JSON, or not nbformat 4: 422 NOTEBOOK_FILE_UNREADABLE.
function parseNotebook(text) {
  if (!String(text).trim()) return emptyNotebook();
  let data;
  try { data = JSON.parse(text); } catch { throw fail('NOTEBOOK_FILE_UNREADABLE', 422); }
  if (!isObject(data) || data.nbformat !== 4 || !Array.isArray(data.cells)) throw fail('NOTEBOOK_FILE_UNREADABLE', 422);
  const extra = {};
  for (const [key, value] of Object.entries(data)) if (!['cells', 'metadata', 'nbformat', 'nbformat_minor'].includes(key)) extra[key] = value;
  const seen = new Set();
  return { metadata: isObject(data.metadata) ? data.metadata : {}, extra, cells: data.cells.map(cell => readCell(cell, seen)).filter(Boolean) };
}

function writeCell(cell) {
  const out = { ...cell.keep, id: cell.id, metadata: { ...cell.metadata }, source: sourceLines(cell.source) };
  if (cell.type !== 'code') {
    out.cell_type = cell.origType && cell.origType !== 'code' ? cell.origType : 'markdown';
    return out;
  }
  out.cell_type = 'code';
  out.execution_count = cell.count ?? null;
  if (cell.rawOutputs) out.outputs = cell.rawOutputs;
  else out.outputs = cell.lines && cell.lines.length ? [{ output_type: 'stream', name: 'stdout', text: cell.lines.map(line => `${line}\n`) }] : [];
  // Only a cell that ran here gets our metadata (a notebook made elsewhere keeps its cells as they were).
  if (cell.started_at !== null || cell.ended_at !== null || cell.dropped) {
    out.metadata['t-agent'] = {
      state: cell.state, exit: cell.exit, duration_ms: cell.duration_ms, started_at: cell.started_at, ended_at: cell.ended_at,
      ...(cell.dropped ? { dropped: cell.dropped } : {}), ...(cell.program ? { program: cell.program } : {}),
    };
  }
  return out;
}

const sortKeys = value => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
  return out;
};

// The text of the file: nbformat 4.5, the bash kernelspec, the notebook's other metadata kept, keys sorted (as Jupyter writes them), 2-space JSON
// and a trailing newline.
function serializeNotebook(notebook) {
  const metadata = { ...notebook.metadata, kernelspec: { ...KERNELSPEC }, language_info: { name: 'bash' } };
  const data = { ...notebook.extra, cells: notebook.cells.map(writeCell), metadata, nbformat: 4, nbformat_minor: 5 };
  return `${JSON.stringify(sortKeys(data), null, 2)}\n`;
}

// Writes the file atomically: a temporary file in the same folder, then a rename. `owner` ({ uid, gid }, optional) owns the file (a root service
// that drops terminals to another user).
function writeFileAtomic(file, text, { owner } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  let mode = 0o644;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* a new file */ }
  const temp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, text, { mode });
    if (owner) { try { fs.chownSync(temp, owner.uid, owner.gid); } catch { /* the service may not change owners */ } }
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* gone */ }
    throw error;
  }
}

// Reads and parses a notebook file: { notebook, stamp }. Larger than 20 MB: 413 NOTEBOOK_TOO_LARGE.
function readNotebookFile(file) {
  const stat = fs.statSync(file);
  if (stat.size > MAX_FILE_BYTES) throw fail('NOTEBOOK_TOO_LARGE', 413);
  return { notebook: parseNotebook(fs.readFileSync(file, 'utf8')), stamp: stampOf(stat) };
}
// What identifies one version of a file on disk (a write by anyone else changes it).
const stampOf = stat => `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
function fileStamp(file) {
  try { return stampOf(fs.statSync(file)); } catch { return null; }
}

// ── Paths ──
const inside = (root, target) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

function realFolder(folder) {
  if (!folder || typeof folder !== 'string' || !path.isAbsolute(folder)) throw fail('TASK_HAS_NO_FOLDER', 409);
  try {
    const real = fs.realpathSync(folder);
    if (!fs.statSync(real).isDirectory()) throw new Error('not a folder');
    return real;
  } catch { throw fail('TASK_HAS_NO_FOLDER', 409); }
}

// The deepest existing folder above `target`, as a real path, with the rest of the path added back.
function realPathOfNew(target) {
  const rest = [];
  let at = target;
  while (!fs.existsSync(at)) {
    rest.unshift(path.basename(at));
    const up = path.dirname(at);
    if (up === at) break;
    at = up;
  }
  return path.join(fs.realpathSync(at), ...rest);
}

// A notebook path relative to `folder`: a relative path to a .ipynb file that stays inside the folder, also after symbolic links are followed
// (a link that leads out of the folder is outside). `mustExist`: the file must be there and be a regular file. Answers { file (the real path),
// relative ('notebooks/x.ipynb', with "/") }; 400 INVALID_NOTEBOOK_PATH otherwise, 409 TASK_HAS_NO_FOLDER when the folder is not there.
function resolveNotebookPath(folder, relative, { mustExist = true } = {}) {
  const root = realFolder(folder);
  const bad = () => fail('INVALID_NOTEBOOK_PATH', 400);
  if (typeof relative !== 'string' || !relative || relative.length > 1024 || /[\0]/.test(relative)) throw bad();
  if (path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative) || relative.startsWith('\\')) throw bad();
  const parts = relative.split(/[\\/]+/).filter(part => part && part !== '.');
  if (!parts.length || parts.includes('..') || !/\.ipynb$/i.test(parts[parts.length - 1])) throw bad();
  const target = path.join(root, ...parts);
  if (!inside(root, target)) throw bad();
  let real;
  if (fs.existsSync(target)) {
    real = fs.realpathSync(target);
    if (!fs.statSync(real).isFile()) throw bad();
  } else if (mustExist) {
    throw bad();
  } else {
    real = realPathOfNew(target);
  }
  if (!inside(root, real)) throw bad();
  return { file: real, relative: parts.join('/') };
}

// The folder of a notebook: the terminal row's own directory (task_terminals.work_dir, set when the notebook was made), else the task's working
// directory, else the folder of the task's Markdown file; null when there is none.
function notebookFolder(task, row) {
  return (row && row.work_dir) || (task && task.work_dir) || (task && task.md_path ? path.dirname(task.md_path) : null);
}

// The file name part of a new notebook made from a title: any script is kept; / \ : * ? " < > | and runs of whitespace become "-"; control
// characters and leading or trailing dots and dashes are removed; at most 60 characters. Empty: "notebook".
function notebookSlug(title) {
  let slug = String(title ?? '').normalize('NFC').replace(/[\x00-\x1f\x7f]/g, '').replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, '-').replace(/-{2,}/g, '-');
  slug = slug.replace(/^[-.]+|[-.]+$/g, '');
  slug = Array.from(slug).slice(0, SLUG_MAX).join('').replace(/[-.]+$/g, '');
  return slug || 'notebook';
}

// Makes notebooks/<slug>.ipynb (then -2, -3, ...) in the folder with one empty code cell. Answers { file, relative }.
function createNotebookFile(folder, title, { owner } = {}) {
  const root = realFolder(folder);
  const dir = path.join(root, 'notebooks');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    if (owner) { try { fs.chownSync(dir, owner.uid, owner.gid); } catch { /* see writeFileAtomic */ } }
  }
  const slug = notebookSlug(title);
  const text = serializeNotebook(emptyNotebook());
  for (let n = 1; n < 10000; n++) {
    const name = `${slug}${n === 1 ? '' : `-${n}`}.ipynb`;
    const { file, relative } = resolveNotebookPath(root, `notebooks/${name}`, { mustExist: false });
    try {
      fs.writeFileSync(file, text, { flag: 'wx', mode: 0o644 });
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    if (owner) { try { fs.chownSync(file, owner.uid, owner.gid); } catch { /* see writeFileAtomic */ } }
    return { file, relative };
  }
  throw fail('INVALID_NOTEBOOK_PATH', 400);
}

// The .ipynb files directly in <folder>/notebooks/ and in <folder>: [{ id: relative path, title, updated_at (ms) }], newest first, at most 200.
function listNotebookFiles(folder) {
  let root;
  try { root = realFolder(folder); } catch { return []; }
  const rows = [];
  for (const sub of ['notebooks', '']) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, sub)); } catch { continue; }
    for (const name of names) {
      if (!/\.ipynb$/i.test(name) || name.startsWith('.')) continue;
      const relative = sub ? `${sub}/${name}` : name;
      try {
        const { file } = resolveNotebookPath(root, relative);
        rows.push({ id: relative, title: name.replace(/\.ipynb$/i, ''), updated_at: Math.round(fs.statSync(file).mtimeMs) });
      } catch { /* a link out of the folder, or not a file */ }
    }
  }
  return rows.sort((a, b) => b.updated_at - a.updated_at).slice(0, MAX_LISTED);
}

module.exports = {
  MAX_LINES, MAX_OUTPUT_BYTES, LINE_WIDTH, MAX_FILE_BYTES, CELL_ID, STATES,
  createOutput, normaliseText, parseNotebook, serializeNotebook, emptyNotebook, newCodeCell, newMarkdownCell, newCellId,
  writeFileAtomic, readNotebookFile, fileStamp, resolveNotebookPath, notebookSlug, createNotebookFile, listNotebookFiles, realFolder, notebookFolder,
};
