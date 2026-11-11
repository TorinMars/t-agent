// Lists the Claude Code and Codex sessions that were run in a directory, so a terminal can resume one.
const fs = require('fs');
const os = require('os');
const path = require('path');

const AGENTS = {
  claude: { command: 'claude', resume: id => `claude --resume ${id}` },
  codex: { command: 'codex', resume: id => `codex resume ${id}` },
};
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,80}$/;
const MAX_SESSIONS = 30;
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 512 * 1024;

const isAgent = value => Object.prototype.hasOwnProperty.call(AGENTS, value);

// Command typed into a new terminal: a fresh agent session, or the one with the given id.
function startupCommand(agent, sessionId) {
  if (!isAgent(agent)) return null;
  if (!sessionId) return AGENTS[agent].command;
  if (!SESSION_ID.test(String(sessionId))) throw Object.assign(new Error('INVALID_SESSION_ID'), { statusCode: 400 });
  return AGENTS[agent].resume(sessionId);
}

// Claude Code accepts the id of a new session up front, so the terminal knows its session from the start; Codex does not.
const newClaudeCommand = id => `claude --session-id ${id}`;

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const length = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.toString('utf8', 0, length).split('\n').slice(0, -1);
  } finally { fs.closeSync(fd); }
}

// Claude Code appends its generated or user-set title as the conversation goes on, so the last one near the end of the file is current.
function readTail(file) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString('utf8').split('\n').slice(start ? 1 : 0);
  } finally { fs.closeSync(fd); }
}

const clip = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const part = content.find(item => item && typeof item.text === 'string');
  return part ? part.text : '';
}

// Injected context (environment blocks, slash-command wrappers) is not what the user typed.
const isPrompt = text => text && !/^\s*</.test(text);

function parseLines(lines) {
  const rows = [];
  for (const line of lines) { try { rows.push(JSON.parse(line)); } catch { /* a partial last line */ } }
  return rows;
}

// The folder name Claude Code gives a project under ~/.claude/projects: every character that is not a letter or a digit becomes '-'. A name longer
// than 200 characters is cut to 200 and gets '-' and a hash of the whole path (Java's String.hashCode over UTF-16 units, absolute value in base 36), as
// Claude Code 2.1 does (checked against 2.1.322).
const CLAUDE_NAME_MAX = 200;
function claudeProjectName(dir) {
  const text = String(dir);
  const name = text.replace(/[^A-Za-z0-9]/g, '-');
  if (name.length <= CLAUDE_NAME_MAX) return name;
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  return `${name.slice(0, CLAUDE_NAME_MAX)}-${Math.abs(hash).toString(36)}`;
}

function listClaude(dir, home) {
  const folder = path.join(home, '.claude', 'projects', claudeProjectName(path.resolve(dir)));
  let names;
  try { names = fs.readdirSync(folder).filter(name => name.endsWith('.jsonl')); } catch { return []; }
  const result = [];
  for (const name of names) {
    const file = path.join(folder, name);
    const id = name.slice(0, -'.jsonl'.length);
    if (!SESSION_ID.test(id)) continue;
    try {
      const rows = parseLines(readHead(file));
      const first = rows.find(row => row.type === 'user' && !row.isMeta && isPrompt(textOf(row.message && row.message.content)));
      const named = parseLines(readTail(file)).filter(row => (row.type === 'custom-title' && row.customTitle) || (row.type === 'ai-title' && row.aiTitle));
      const custom = named.filter(row => row.type === 'custom-title').pop();
      const generated = named.filter(row => row.type === 'ai-title').pop();
      const title = clip(custom ? custom.customTitle : generated ? generated.aiTitle : first ? textOf(first.message.content) : '');
      const stat = fs.statSync(file);
      result.push({ id, title: title || id.slice(0, 8), updated_at: stat.mtimeMs, started_at: stat.birthtimeMs });
    } catch { /* unreadable session file */ }
  }
  return result;
}

function walk(root, depth, out) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory() && depth > 0) walk(full, depth - 1, out);
    else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) out.push(full);
  }
}

// Codex keeps the thread names (set by /rename or generated) in one index file; the last entry of an id wins.
function codexNames(home) {
  const names = new Map();
  try {
    for (const row of parseLines(fs.readFileSync(path.join(home, '.codex', 'session_index.jsonl'), 'utf8').split('\n'))) {
      if (row && row.id && row.thread_name) names.set(row.id, row.thread_name);
    }
  } catch { /* no index yet */ }
  return names;
}

function listCodex(dir, home) {
  const files = [];
  const names = codexNames(home);
  walk(path.join(home, '.codex', 'sessions'), 3, files);
  const target = path.resolve(dir);
  const result = [];
  // Newest first: the directory layout is YYYY/MM/DD, so sorting names descending is enough to stop early.
  for (const file of files.sort().reverse()) {
    if (result.length >= MAX_SESSIONS) break;
    try {
      const rows = parseLines(readHead(file));
      const meta = rows.find(row => row.type === 'session_meta');
      const payload = meta && meta.payload;
      if (!payload || !payload.id || !payload.cwd || path.resolve(payload.cwd) !== target || !SESSION_ID.test(payload.id)) continue;
      const first = rows.find(row => row.type === 'response_item' && row.payload && row.payload.role === 'user' && isPrompt(textOf(row.payload.content)));
      const title = clip(names.get(payload.id) || (first ? textOf(first.payload.content) : ''));
      const started = Date.parse(payload.timestamp || (meta && meta.timestamp));
      result.push({ id: payload.id, title: title || payload.id.slice(0, 8), updated_at: fs.statSync(file).mtimeMs, started_at: Number.isFinite(started) ? started : fs.statSync(file).birthtimeMs });
    } catch { /* unreadable session file */ }
  }
  return result;
}

// Running sub-agents of a Claude session. Claude Code writes each sub-agent (Task / Agent tool) of session <id> to
// ~/.claude/projects/<dir>/<id>/subagents/agent-<x>.jsonl (with agent-<x>.meta.json beside it). A sub-agent counts as running while
// the last row of its log is not the final assistant message (`stop_reason` end_turn / stop_sequence), and the log changed within
// SUBAGENT_STALE_MS (a sub-agent killed with its parent never writes the final line). Read only: names are checked, symbolic links
// and files that are not plain files are skipped, and only the end of each recent log is read.
// Used by the terminal counts here and, through runningSubagentsIn, by plugins/listeners/claude/hook.js, which holds back a Stop
// while sub-agents run (that is why this file may only need Node built-ins).
const SUBAGENT_STALE_MS = 15 * 60 * 1000;
const SUBAGENT_TAIL_BYTES = 64 * 1024;
const SUBAGENT_FILE = /^agent-[A-Za-z0-9_-]{1,80}\.jsonl$/;
const FINISHED_STOPS = new Set(['end_turn', 'stop_sequence']);

// A background command of a sub-agent that ended adds this row after the final message. When it wakes the sub-agent, an api-request
// row follows at once, so it is passed over and the row before it decides.
const lateNotice = row => row && row.type === 'user' && row.origin && row.origin.kind === 'task-notification';

function logIsRunning(file, size) {
  if (!size) return false;
  const fd = fs.openSync(file, 'r');
  try {
    const start = Math.max(0, size - SUBAGENT_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n').filter(line => line.trim());
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      let row;
      try { row = JSON.parse(lines[index]); } catch { continue; } // a partial line: look at the one before
      if (lateNotice(row)) continue;
      return !(row && row.type === 'assistant' && row.message && FINISHED_STOPS.has(row.message.stop_reason));
    }
    return true; // no whole row in the tail (the last row is longer than the tail): a recent log that is not known to be finished
  } finally { fs.closeSync(fd); }
}

// The running sub-agents of one `subagents` folder; a folder that is missing or unreadable has none.
function runningSubagentsIn(folder, now = Date.now()) {
  let names;
  try { names = fs.readdirSync(folder); } catch { return 0; }
  let count = 0;
  for (const name of names) {
    if (!SUBAGENT_FILE.test(name)) continue;
    const file = path.join(folder, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || now - stat.mtimeMs > SUBAGENT_STALE_MS) continue;
      if (logIsRunning(file, stat.size)) count += 1;
    } catch { /* unreadable log */ }
  }
  return count;
}

function runningSubagents(dir, sessionId, home = os.homedir(), now = Date.now()) {
  if (!dir || !SESSION_ID.test(String(sessionId || ''))) return 0;
  const projects = path.join(home, '.claude', 'projects');
  const folder = path.join(projects, claudeProjectName(path.resolve(dir)), String(sessionId), 'subagents');
  if (path.relative(projects, folder).startsWith('..')) return 0;
  return runningSubagentsIn(folder, now);
}

function listSessions(agent, dir, home = os.homedir(), limit = MAX_SESSIONS) {
  if (!isAgent(agent)) throw Object.assign(new Error('INVALID_AGENT'), { statusCode: 400 });
  if (!dir) return [];
  const rows = agent === 'claude' ? listClaude(dir, home) : listCodex(dir, home);
  return rows.sort((a, b) => b.updated_at - a.updated_at).slice(0, limit);
}

module.exports = { claudeProjectName, newClaudeCommand, listSessions, startupCommand, isAgent, runningSubagents, runningSubagentsIn, SUBAGENT_STALE_MS, SESSION_ID };
