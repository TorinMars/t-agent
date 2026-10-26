// Small text helpers of the chat footer (kept apart from React so they can be tested directly).

// A number with at most one decimal and no trailing ".0": 4.25 -> "4.3", 2 -> "2".
export const num = value => String(Math.round(value * 10) / 10);

// A time span in a single unit, decimals allowed: "3.2d", "4.2h", "35m" (under one minute: "<1m").
export function duration(ms) {
  const hours = ms / 3600000;
  if (hours >= 24) return `${num(hours / 24)}d`;
  if (hours >= 1) return `${num(hours)}h`;
  const minutes = ms / 60000;
  return minutes >= 1 ? `${num(minutes)}m` : '<1m';
}

// "claude-sonnet-5-5" -> "Sonnet 5.5"; an alias such as "sonnet" -> "Sonnet"; ids of other makers are shown as they are.
export function modelName(id) {
  const match = /^claude-([a-z]+)-(\d+(?:-\d+)?)(?:-\d{8})?$/.exec(id || '');
  if (match) return `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2].replace('-', '.')}`;
  return /^(opus|sonnet|haiku|fable)$/.test(id || '') ? `${id[0].toUpperCase()}${id.slice(1)}` : id || '';
}

export const capitalize = text => (text ? `${text[0].toUpperCase()}${text.slice(1)}` : '');
export const tokens = count => (count >= 1e6 ? `${num(count / 1e6)}M` : count >= 1000 ? `${Math.round(count / 1000)}k` : String(count));

// The plan windows still worth showing at `now`: a window whose reset time has passed has been read before it reset, so it says nothing.
export function visibleLimits(limits, now) {
  return (Array.isArray(limits) ? limits : []).filter(entry => entry && (entry.resetsAt === null || entry.resetsAt === undefined || entry.resetsAt > now));
}

// What is left of a window and when it resets: { text: "62% · 4.2h", title: "5h limit: 62% left, resets in 4.2h" }.
export function limitText(entry, now) {
  const left = num(Math.max(0, 100 - entry.usedPercent));
  const reset = entry.resetsAt ? duration(entry.resetsAt - now) : '';
  return { left, reset, text: `${left}%${reset ? ` · ${reset}` : ''}` };
}

// ── Tool calls ──
const SHELL = /^(bash|shell|powershell|exec|command)$/i;
const EDIT = /^(edit|write|multiedit|notebookedit|edit files|apply_patch)$/i;
const firstLine = value => (typeof value === 'string' ? value.split('\n')[0] : '');
// What a call is about, in a few words: the command, the file, the pattern ...
export function callBrief(args) {
  const value = (args && (args.command || args.file_path || args.path || args.pattern || args.query || args.url || args.description)) || '';
  return firstLine(value);
}

// The folded line of a group of calls: { text, failed } in English (the page translates the parts). While one runs it says what it is doing.
export function groupLabel(calls) {
  const running = calls.find(call => call.status === 'running');
  const failed = calls.filter(call => call.status === 'error').length;
  if (running) return { text: `Running ${[running.name, callBrief(running.args)].filter(Boolean).join(' ')}`.trim(), failed, running: true };
  const n = calls.length;
  let text;
  if (calls.every(call => SHELL.test(call.name))) text = n === 1 ? 'Ran 1 command' : `Ran ${n} commands`;
  else if (calls.every(call => EDIT.test(call.name))) text = n === 1 ? 'Edited 1 file' : `Edited ${n} files`;
  else text = n === 1 ? 'Used 1 tool' : `Used ${n} tools`;
  return { text, failed, running: false };
}

// ── Changes to review ──
const MAX_DIFF_LINES = 400;
const lines = text => String(text === undefined || text === null ? '' : text).replace(/\n$/, '').split('\n');
const classify = line => (line.startsWith('@@') ? 'hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : 'ctx');

// The edit a tool wants to make as lines to show: { type: 'file' | 'hunk' | 'add' | 'del' | 'ctx', text }, or null when the input is not an edit.
// Codex sends a unified diff (or the whole new file) for each changed file; Claude's Edit / MultiEdit send the old and new text, Write the new file.
export function diffLines(input) {
  if (!input || typeof input !== 'object') return null;
  const out = [];
  const file = text => out.push({ type: 'file', text });
  // old text -> new text: the lines both share at the start and the end are context, the rest is removed / added.
  const replaced = (oldText, newText) => {
    const before = oldText === '' ? [] : lines(oldText);
    const after = newText === '' ? [] : lines(newText);
    let head = 0;
    while (head < before.length && head < after.length && before[head] === after[head]) head++;
    let tail = 0;
    while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
    for (const line of before.slice(0, head)) out.push({ type: 'ctx', text: line });
    for (const line of before.slice(head, before.length - tail)) out.push({ type: 'del', text: line });
    for (const line of after.slice(head, after.length - tail)) out.push({ type: 'add', text: line });
    for (const line of before.slice(before.length - tail)) out.push({ type: 'ctx', text: line });
  };
  if (Array.isArray(input.changes) && input.changes.length && input.changes.every(change => change && typeof change.path === 'string')) {
    for (const change of input.changes) {
      file(`${change.path}${change.kind ? ` (${change.kind})` : ''}`);
      for (const line of lines(change.diff || '')) out.push({ type: change.kind === 'add' && !/^[+@-]/.test(line) ? 'add' : classify(line), text: line.replace(/^[+-](?!\+\+|--)/, '') });
    }
  } else if (typeof input.file_path === 'string' && Array.isArray(input.edits)) {
    file(input.file_path);
    for (const edit of input.edits) { if (edit && typeof edit.old_string === 'string') { out.push({ type: 'hunk', text: '…' }); replaced(edit.old_string, edit.new_string); } }
  } else if (typeof input.file_path === 'string' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    file(input.file_path);
    replaced(input.old_string, input.new_string);
  } else if (typeof input.file_path === 'string' && typeof input.content === 'string') {
    file(input.file_path);
    for (const line of lines(input.content)) out.push({ type: 'add', text: line });
  } else return null;
  if (out.length > MAX_DIFF_LINES) { const more = out.length - MAX_DIFF_LINES; out.length = MAX_DIFF_LINES; out.push({ type: 'hunk', text: `… ${more} more lines` }); }
  return out;
}
