// What the notebook view says about its cells and its shell, the shell highlighting of the code editor and the .ipynb of Download. Pure (no
// DOM): the texts are English and whole sentences; the view translates them (I18n.t, with the templates in public/js/i18n-zh-extra.js).
import { stripSgr } from './sgr.mjs';

// The position of a code cell among the code cells, from 1 ("cell 3"); 0 when it is not one.
export function codeNumber(cells, id) {
  let n = 0;
  for (const cell of cells) {
    if (cell.type !== 'code') continue;
    n += 1;
    if (cell.id === id) return n;
  }
  return 0;
}

// The shell's state, as the chip of the header says it: { text, tone } with tone 'running' | 'idle' | 'starting' | 'stopped'.
// "zsh · Running cell 3", "zsh · Waiting for input", "zsh · Starting", "zsh · Idle", "Shell stopped".
export function kernelStatus(kernel, cells) {
  const shell = (kernel && kernel.shell) || 'shell';
  const state = kernel ? kernel.state : 'stopped';
  if (!kernel || state === 'stopped') return { text: 'Shell stopped', tone: 'stopped' };
  if (state === 'starting') return { text: `${shell} · Starting`, tone: 'starting' };
  if (state === 'busy') {
    if (kernel.waiting_input) return { text: `${shell} · Waiting for input`, tone: 'running' };
    const n = kernel.running ? codeNumber(cells, kernel.running) : 0;
    return { text: n ? `${shell} · Running cell ${n}` : `${shell} · Running`, tone: 'running' };
  }
  return { text: `${shell} · Idle`, tone: 'idle' };
}

// The second line of a notebook's row in the task list: "Notebook · Running cell 3" / "Notebook · Idle" / "Notebook · Shell stopped".
export function rowLine(kernel, cells) {
  if (!kernel || kernel.state === 'stopped') return 'Notebook · Shell stopped';
  if (kernel.state === 'busy') {
    const n = kernel.running ? codeNumber(cells, kernel.running) : 0;
    return n ? `Notebook · Running cell ${n}` : 'Notebook · Running';
  }
  return kernel.state === 'starting' ? 'Notebook · Starting' : 'Notebook · Idle';
}

// "0.3 s", "12 s", "2 min 5 s", "1 h 2 min".
export function durationText(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 10000) return `${(Math.round(value / 100) / 10).toFixed(1)} s`;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}
// The time running so far: "0:38", "12:05", "1:02:03".
export function elapsedText(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const two = value => String(value).padStart(2, '0');
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
// "14:20" (local time), '' without a time.
export function clockText(at) {
  const date = new Date(Number(at));
  if (!(Number(at) > 0) || !Number.isFinite(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// The program a cell started, for "htop draws a full screen": the first word of its first command line (comments and assignments skipped).
export function programOf(source) {
  for (const raw of String(source || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const words = line.split(/\s+/).filter(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) && !['sudo', 'exec', 'command', 'env', 'time', 'nohup'].includes(word));
    if (!words.length) continue;
    const word = words[0].replace(/^["']|["';|&]+$/g, '');
    const name = word.split('/').pop();
    if (name && /^[\w.+-]+$/.test(name)) return name.slice(0, 40);
  }
  return '';
}

// The parts of the line under a cell (its meta line), already whole sentences: { tone, parts: [text], check, kind }.
// tone: 'done' | 'failed' | 'stopped' | 'running' | 'queued' | 'muted'; `after`: the cell number a queued cell waits for (0: none known).
export function metaOf(cell, { now = Date.now(), after = 0, stoppedRun = false, kernelStopped = false } = {}) {
  if (!cell || cell.type !== 'code') return null;
  const ended = clockText(cell.ended_at);
  const took = Number.isFinite(cell.duration_ms) ? durationText(cell.duration_ms) : '';
  const join = parts => parts.filter(Boolean);
  switch (cell.state) {
    case 'running': return { tone: 'running', parts: ['Running', elapsedText(now - (cell.started_at || now)), 'Ctrl+C stops it'] };
    case 'queued': return { tone: 'queued', parts: [after ? `Queued · runs after cell ${after}` : 'Queued'] };
    case 'done': return { tone: 'done', check: true, parts: join([`Exit ${cell.exit === null ? 0 : cell.exit}`, took, ended]) };
    case 'failed': return { tone: 'failed', parts: join([cell.exit === null ? 'Failed' : `Exit ${cell.exit}`, took, ended, stoppedRun ? 'Run all stopped here' : '']) };
    case 'stopped': return { tone: 'stopped', parts: join(['Stopped (Ctrl+C)', took, 'the shell keeps its state']) };
    case 'interrupted': return { tone: 'muted', parts: [kernelStopped ? 'Not finished: the shell was stopped' : 'Not finished: the shell was restarted'] };
    case 'fullscreen': return { tone: 'muted', parts: join([took, ended]) };
    default: return null;
  }
}

// What the gutter of a code cell says: "[3]", "[*]" while it runs, "[ ]" queued or never run.
export function countLabel(cell) {
  if (!cell || cell.type !== 'code') return '';
  if (cell.state === 'running') return '[*]';
  if (cell.state === 'queued') return '[ ]';
  return Number.isInteger(cell.count) ? `[${cell.count}]` : '[ ]';
}

// The cell a queued cell runs after: the one before it in the kernel's queue, or the running one when it is first. 0 when not known.
export function queuedAfter(kernel, cells, id) {
  if (!kernel) return 0;
  const queue = Array.isArray(kernel.queue) ? kernel.queue : [];
  const at = queue.indexOf(id);
  const before = at > 0 ? queue[at - 1] : at === 0 ? kernel.running : null;
  return before ? codeNumber(cells, before) : 0;
}

// ── Shell highlighting of the code editor ("Code editor" in docs/design/shell-notebook-page.md) ──
// Runs of { text, kind } that join back to the source exactly; kind: 'keyword' (shell words and builtins in a command's place), 'string',
// 'var' ($NAME, ${…}, $1, $?), 'comment' or '' (plain). Simple on purpose: a wrong colour never changes what runs.
const KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', 'case', 'esac', 'function', 'select', 'time',
  'cd', 'export', 'echo', 'printf', 'read', 'source', 'local', 'set', 'unset', 'return', 'exit', 'alias', 'unalias', 'eval', 'exec', 'trap',
  'shift', 'test', 'pushd', 'popd', 'declare', 'typeset', 'readonly', 'let', 'wait', 'kill', 'true', 'false', 'break', 'continue', 'type', 'which',
]);
const COMMAND_START = /(^|[\n;&|(`{]|\b(?:then|do|else|elif)\s)\s*$/;
export function shellTokens(source) {
  const text = String(source || '');
  const runs = [];
  const push = (piece, kind) => {
    if (!piece) return;
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.text += piece;
    else runs.push({ text: piece, kind });
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const before = text.slice(Math.max(0, i - 40), i);
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      push(text.slice(i, stop), 'comment');
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += ch === '"' && text[j] === '\\' ? 2 : 1;
      const stop = Math.min(text.length, j + 1);
      push(text.slice(i, stop), 'string');
      i = stop;
      continue;
    }
    if (ch === '$') {
      const match = /^\$(?:\{[^}\n]*\}?|[A-Za-z_][A-Za-z0-9_]*|[0-9?#@*!$-])/.exec(text.slice(i));
      if (match) { push(match[0], 'var'); i += match[0].length; continue; }
    }
    if (/[A-Za-z_]/.test(ch) && (i === 0 || /[\s;&|(`{]/.test(text[i - 1]))) {
      const word = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(text.slice(i))[0];
      const next = text[i + word.length];
      const isWord = next === undefined || /[\s;&|)`}]/.test(next);
      push(word, isWord && KEYWORDS.has(word) && COMMAND_START.test(before) ? 'keyword' : '');
      i += word.length;
      continue;
    }
    push(ch, '');
    i += 1;
  }
  return runs;
}

// ── Download .ipynb ──
// The notebook as Jupyter's format (nbformat 4.5), the way the server writes it: one stream output per code cell with the kept lines (SGR codes
// kept), the execution count and our metadata. Made from what the page shows; the file on the engine is the same notebook.
export function ipynbOf(doc) {
  const lines = text => {
    const parts = String(text).split('\n');
    return parts.map((line, index) => (index < parts.length - 1 ? `${line}\n` : line)).filter((line, index, all) => line !== '' || index < all.length - 1);
  };
  const cells = (doc && Array.isArray(doc.cells) ? doc.cells : []).map(cell => {
    if (cell.type !== 'code') return { cell_type: 'markdown', id: cell.id, metadata: {}, source: lines(cell.source) };
    const meta = {};
    if (cell.exit !== null && cell.exit !== undefined) meta.exit = cell.exit;
    if (cell.duration_ms !== null && cell.duration_ms !== undefined) meta.duration_ms = cell.duration_ms;
    if (cell.ended_at !== null && cell.ended_at !== undefined) meta.ended_at = cell.ended_at;
    if (cell.state && cell.state !== 'idle') meta.state = cell.state;
    return {
      cell_type: 'code', id: cell.id, metadata: Object.keys(meta).length ? { 't-agent': meta } : {}, source: lines(cell.source),
      execution_count: Number.isInteger(cell.count) ? cell.count : null,
      outputs: cell.lines && cell.lines.length ? [{ output_type: 'stream', name: 'stdout', text: cell.lines.map(line => `${line}\n`) }] : [],
    };
  });
  const notebook = {
    cells,
    metadata: { kernelspec: { name: 'bash', display_name: 'Bash', language: 'bash' }, language_info: { name: 'bash' } },
    nbformat: 4,
    nbformat_minor: 5,
  };
  return `${JSON.stringify(notebook, null, 2)}\n`;
}
// The file name of a notebook's path ("notebooks/release-check.ipynb" -> "release-check.ipynb").
export const fileName = (path, fallback = 'notebook.ipynb') => String(path || '').split('/').filter(Boolean).pop() || fallback;
// A cell's kept output as plain text (Download of a long output).
export const outputText = lines => `${(lines || []).map(stripSgr).join('\n')}\n`;

// ── Folding long cells ("Long cells fold" in docs/design/shell-notebook-page.md) ──
// A cell of more than FOLD_OVER screen lines (a wrapped line counts as the lines it takes on the screen) is long: it shows its first FOLD_SHOW
// lines and "Show all N lines" (N: the lines of its text). How the page shows it, never saved: the file and the cell are unchanged.
export const FOLD_OVER = 12;
export const FOLD_SHOW = 8;

// The lines of a cell's text, as the person counts them in the file (a last newline does not start a new line).
export function lineCount(source) {
  const text = String(source == null ? '' : source);
  if (!text) return 0;
  return text.replace(/\n$/, '').split('\n').length;
}

// The screen lines of a box of `height` px drawn in lines of `lineHeight` px, after its `padding` (top and bottom together); null when it is
// not laid out (a hidden view), so the last answer stays.
export function screenLines(height, lineHeight, padding = 0) {
  if (!(height > 0) || !(lineHeight > 0)) return null;
  return Math.max(0, Math.round((height - padding) / lineHeight));
}

// Whether a cell is long and whether it is folded now: `opened` (Show all, Z, or the editor has had the focus while it was long) and `focused`
// (its editor has the focus: never folded, so nothing is typed into hidden lines). `hold`: the cell becomes opened (it is long while its
// editor has the focus or was just left, so leaving the editor never folds it).
export function foldOf(lines, { opened = false, focused = false } = {}) {
  const long = Number.isFinite(lines) && lines > FOLD_OVER;
  return { long, folded: long && !opened && !focused, hold: long && focused && !opened };
}

// The text of the fold button: "Show all 42 lines" (template "Show all {1} lines" in public/js/i18n-zh-extra.js) or "Show less". N is the
// lines of the text; a few very long lines that wrap past the fold count as their screen lines, so N is never less than what is already shown.
export function foldLabel(folded, source, screen) {
  if (!folded) return 'Show less';
  const lines = lineCount(source);
  return `Show all ${lines > FOLD_SHOW ? lines : Math.max(lines, Number(screen) || 0)} lines`;
}
