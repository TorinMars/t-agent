// Lists the Claude Code, Codex and OpenCode sessions that were run in a directory, so a terminal can resume one.
const fs = require('fs');
const os = require('os');
const path = require('path');

const AGENTS = {
  claude: { command: 'claude', resume: id => `claude --resume ${id}` },
  codex: { command: 'codex', resume: id => `codex resume ${id}` },
  // OpenCode (docs/design/opencode-terminals.md): no id up front; a new session gets its id (ses_...) at the first prompt.
  opencode: { command: 'opencode', resume: id => `opencode -s ${id}` },
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

// What was read from a session file is kept while the file stays the same, so listing sessions whose files did not change only lists the
// folders and stats the files (a Claude session file costs up to 768 KiB to read, and the page lists the terminals every 8 s).
//  - The same file: the same inode, size, modification time and change time. The inode and the change time catch a file that was written
//    again with its old times (lib/agent-session-move.js does that after a task rename).
//  - A file changed less than `racyMs` before it was read is not kept: a second write inside the same timestamp tick would not show.
//  - At most `max` files, the least recently used dropped first, but never one the listing in progress has used (a listing of more files
//    than the cache holds would otherwise push out its own entries and read every file again each time; begin() starts a listing).
function createFileCache({ max = 5000, racyMs = 2000, now = () => Date.now() } = {}) {
  const entries = new Map(); // name -> { key, value, listing }
  let listing = 0;
  const keyOf = stat => `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  return {
    begin() { listing += 1; },
    // The value `read()` gave for this file while it was as `stat` says; reads again when the file changed. What read() throws is thrown.
    get(name, stat, read) {
      const key = keyOf(stat);
      const hit = entries.get(name);
      entries.delete(name);
      if (hit && hit.key === key) {
        hit.listing = listing;
        entries.set(name, hit); // the most recently used entry is the last one
        return hit.value;
      }
      const startedAt = now();
      const value = read();
      if (Math.max(stat.mtimeMs, stat.ctimeMs) + racyMs >= startedAt) return value;
      if (entries.size >= max) {
        const [oldest, entry] = entries.entries().next().value;
        if (entry.listing === listing) return value; // full of files this listing needs
        entries.delete(oldest);
      }
      entries.set(name, { key, value, listing });
      return value;
    },
    size: () => entries.size,
    clear() { entries.clear(); },
  };
}
const sessionFiles = createFileCache();

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const length = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.toString('utf8', 0, length).split('\n').slice(0, -1);
  } finally { fs.closeSync(fd); }
}

// Claude Code appends its generated or user-set title as the conversation goes on, so the last one near the end of the file is current.
function readTail(file, size = fs.statSync(file).size) {
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

// The title of a Claude session file ('' when it has none yet): the head for the first prompt, the tail for the newest title.
function claudeTitle(file, size) {
  const rows = parseLines(readHead(file));
  const first = rows.find(row => row.type === 'user' && !row.isMeta && isPrompt(textOf(row.message && row.message.content)));
  const named = parseLines(readTail(file, size)).filter(row => (row.type === 'custom-title' && row.customTitle) || (row.type === 'ai-title' && row.aiTitle));
  const custom = named.filter(row => row.type === 'custom-title').pop();
  const generated = named.filter(row => row.type === 'ai-title').pop();
  return clip(custom ? custom.customTitle : generated ? generated.aiTitle : first ? textOf(first.message.content) : '');
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
      const stat = fs.statSync(file); // before the read: a file that grows meanwhile is read again next time
      const title = sessionFiles.get(`claude\0${file}`, stat, () => claudeTitle(file, stat.size));
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
  const file = path.join(home, '.codex', 'session_index.jsonl');
  try {
    return sessionFiles.get(`codex-index\0${file}`, fs.statSync(file), () => {
      const names = new Map();
      for (const row of parseLines(fs.readFileSync(file, 'utf8').split('\n'))) {
        if (row && row.id && row.thread_name) names.set(row.id, row.thread_name);
      }
      return names;
    });
  } catch { return new Map(); /* no index yet */ }
}

// What a listing needs from the head of a Codex rollout file, whatever directory is asked for: null when it has no usable session_meta.
function codexMeta(file) {
  const rows = parseLines(readHead(file));
  const meta = rows.find(row => row.type === 'session_meta');
  const payload = meta && meta.payload;
  if (!payload || !payload.id || !payload.cwd) return null;
  const cwd = path.resolve(payload.cwd);
  if (!SESSION_ID.test(payload.id)) return null;
  const first = rows.find(row => row.type === 'response_item' && row.payload && row.payload.role === 'user' && isPrompt(textOf(row.payload.content)));
  return { id: payload.id, cwd, first: clip(first ? textOf(first.payload.content) : ''), started: Date.parse(payload.timestamp || (meta && meta.timestamp)) };
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
      const stat = fs.statSync(file); // before the read: a file that grows meanwhile is read again next time
      const meta = sessionFiles.get(`codex\0${file}`, stat, () => codexMeta(file));
      if (!meta || meta.cwd !== target) continue;
      const name = names.get(meta.id);
      const title = name ? clip(name) : meta.first;
      result.push({ id: meta.id, title: title || meta.id.slice(0, 8), updated_at: stat.mtimeMs, started_at: Number.isFinite(meta.started) ? meta.started : stat.birthtimeMs });
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

// OpenCode keeps its sessions in one SQLite database (WAL mode), checked against opencode 1.19.6 (docs/design/opencode-terminals.md):
// $OPENCODE_DB (an absolute path, or a name inside opencode's data folder), else <XDG_DATA_HOME or ~/.local/share>/opencode/opencode.db.
// `home` is the home of the terminal user, whose opencode writes the file.
function opencodeDb(home, env = process.env) {
  const data = path.join(env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share'), 'opencode');
  const given = env.OPENCODE_DB;
  if (given === ':memory:') return null;
  if (given) return path.isAbsolute(given) ? given : path.join(data, given);
  return path.join(data, 'opencode.db');
}

// A title opencode gives a session until the model or the person names it: "New session - <ISO time>" ("Child session - ..." for a sub-agent's).
const OPENCODE_DEFAULT_TITLE = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const OPENCODE_SQL = `SELECT id, title, time_created, time_updated FROM session
  WHERE parent_id IS NULL AND time_archived IS NULL AND directory IN (?, ?) ORDER BY time_updated DESC LIMIT 200`;
const OPENCODE_BUSY_MS = 200;

// The root sessions (not a sub-agent's, not archived) of one directory, newest first. The database is opened read only and must exist; it is read
// again only when the database file or its WAL file changed (both stats make the cache key). Any error (no database, locked, another schema) is no
// sessions. An untitled session (opencode's default title) gets `untitled: true` and the end of its id as its title.
// better-sqlite3 is loaded here, not at the top: plugins/listeners/claude/hook.js loads this file with Node built-ins only.
function readOpencode(file, dirs) {
  const Database = require('better-sqlite3');
  const handle = new Database(file, { readonly: true, fileMustExist: true, timeout: OPENCODE_BUSY_MS });
  try {
    return handle.prepare(OPENCODE_SQL).all(dirs[0], dirs[1] || dirs[0]).map(row => {
      const id = String(row.id || '');
      const raw = clip(row.title);
      const untitled = !raw || OPENCODE_DEFAULT_TITLE.test(String(row.title || '').trim());
      return { id, title: untitled ? id.slice(-8) : raw, updated_at: Number(row.time_updated) || 0, started_at: Number(row.time_created) || 0, ...(untitled ? { untitled: true } : {}) };
    }).filter(row => SESSION_ID.test(row.id));
  } finally { handle.close(); }
}

function listOpencode(dir, home, env = process.env) {
  const file = opencodeDb(home, env);
  if (!file) return [];
  const target = path.resolve(dir);
  let real = target;
  try { real = fs.realpathSync(target); } catch { /* a folder that is gone: its sessions keep the path they had */ }
  try {
    const db = fs.statSync(file);
    let wal = null;
    try { wal = fs.statSync(`${file}-wal`); } catch { /* no WAL file at the moment */ }
    const stat = {
      ino: `${db.ino}/${wal ? wal.ino : 0}`, size: `${db.size}/${wal ? wal.size : 0}`,
      mtimeMs: Math.max(db.mtimeMs, wal ? wal.mtimeMs : 0), ctimeMs: Math.max(db.ctimeMs, wal ? wal.ctimeMs : 0),
    };
    return sessionFiles.get(`opencode\0${file}\0${target}\0${real}`, stat, () => readOpencode(file, [target, real])).map(row => ({ ...row }));
  } catch { return []; /* no database, or it cannot be read now */ }
}

// `env` (OpenCode only): where its database is (XDG_DATA_HOME, OPENCODE_DB).
function listSessions(agent, dir, home = os.homedir(), limit = MAX_SESSIONS, env = process.env) {
  if (!isAgent(agent)) throw Object.assign(new Error('INVALID_AGENT'), { statusCode: 400 });
  if (!dir) return [];
  sessionFiles.begin();
  const list = { claude: listClaude, codex: listCodex, opencode: (where, at) => listOpencode(where, at, env) }[agent];
  const rows = list(dir, home);
  return rows.sort((a, b) => b.updated_at - a.updated_at).slice(0, limit);
}

module.exports = { claudeProjectName, newClaudeCommand, listSessions, startupCommand, isAgent, runningSubagents, runningSubagentsIn, SUBAGENT_STALE_MS, SESSION_ID, createFileCache, sessionFiles, opencodeDb, OPENCODE_DEFAULT_TITLE };
