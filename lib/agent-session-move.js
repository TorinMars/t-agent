// Moves the Claude Code and Codex session records of a folder that was renamed, so that `claude --resume <id>` and `codex resume <id>` started in the new
// folder find the session and do not ask about the old one. Used by services/task-rename.js; see "Task rename" in DESIGN.md for what was checked against
// Claude Code 2.1.322 and Codex 0.167.1.
//
// Claude Code: the sessions of a folder are ~/.claude/projects/<claudeProjectName(folder)>/<id>.jsonl (sub-agents in <id>/subagents/). The project folder
// is renamed to the name of the new path and the `cwd` values of its rows that are the old path or inside it are rewritten.
// Codex: the rollouts stay where they are (~/.codex/sessions/YYYY/MM/DD); the `cwd` values and the workspace roots of their rows are rewritten, and so are
// `threads.cwd` and `project_roots.path` of its state database (state_<n>.sqlite), which the interactive `codex resume` reads to decide which directory
// the session belongs to.
//
// Everything is synchronous (no other request can run in between) and every step pushes its undo onto `undo`, so the caller can roll back. Session files
// are never deleted: a rewritten file is written to a temporary file that replaces it, and the old content is kept under a second name (a hard link) until
// the caller commits. Message text is never changed, only the fields that name the working directory.
const fs = require('fs');
const path = require('path');
const { claudeProjectName } = require('./agent-sessions');

const CODEX_ROOT_KEYS = new Set(['runtime_workspace_roots', 'workspace_roots', 'writable_roots']);
const BACKUP_SUFFIX = '.t-agent-rename.bak';
const HEAD_BYTES = 256 * 1024;

const inside = (value, dir) => typeof value === 'string' && (value === dir || value.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep));
const swap = (value, from, to) => to + value.slice(from.length);

function moveError(code, detail) {
  return Object.assign(new Error(code), { statusCode: 500, detail });
}

// The pairs [old, new] of a rename: the path as given and, when it differs, its real path (Claude Code names its project folder after the real path).
function pathPairs(oldDir, newDir, oldReal, newReal) {
  const pairs = [[path.resolve(oldDir), path.resolve(newDir)]];
  if (oldReal && newReal && oldReal !== pairs[0][0]) pairs.push([oldReal, newReal]);
  return pairs;
}

const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;
function keepOwner(file, stat) {
  if (!isRoot()) return; // not root: the new file is ours, as the old one was
  try { fs.chownSync(file, stat.uid, stat.gid); } catch { /* best effort */ }
}

// Rewrites the rows of a JSON-lines file with `change(row)` (which edits the row and answers true when it changed it). Rows that do not contain `needle`,
// or do not parse, keep their exact bytes. Returns true when the file changed. The original stays under a hard link until `commit` runs.
function rewriteJsonl(file, needles, change, undo, commits) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) return false;
  const text = fs.readFileSync(file, 'utf8');
  if (!needles.some(needle => text.includes(needle))) return false;
  let changed = false;
  const lines = text.split('\n').map(line => {
    if (!needles.some(needle => line.includes(needle))) return line;
    let row;
    try { row = JSON.parse(line); } catch { return line; }
    if (!change(row)) return line;
    changed = true;
    return JSON.stringify(row);
  });
  if (!changed) return false;
  const dir = path.dirname(file);
  const base = path.basename(file);
  const backup = path.join(dir, `.${base}${BACKUP_SUFFIX}`);
  const temp = path.join(dir, `.${base}.t-agent-rename-${process.pid}-${Date.now()}.tmp`);
  try { fs.unlinkSync(backup); } catch { /* none left over */ }
  fs.linkSync(file, backup);
  try {
    fs.writeFileSync(temp, lines.join('\n'), { mode: stat.mode & 0o7777 });
    keepOwner(temp, stat);
    fs.utimesSync(temp, stat.atime, stat.mtime); // the session lists are sorted by the time of the file
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* not written */ }
    try { fs.unlinkSync(backup); } catch { /* keep going */ }
    throw error;
  }
  undo.push(() => fs.renameSync(backup, file));
  commits.push(() => { try { fs.unlinkSync(backup); } catch { /* already gone */ } });
  return true;
}

// The needles of a path: its JSON spelling inside a string (a path with a quote or a backslash is escaped in the file).
const needlesOf = pairs => pairs.map(([from]) => JSON.stringify(from).slice(1, -1));

function rewriteCwd(row, pairs, rootKeys = null) {
  let changed = false;
  const visit = (value, key) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (rootKeys && rootKeys.has(key) && typeof item === 'string') {
          const pair = pairs.find(([from]) => inside(item, from));
          if (pair) { value[index] = swap(item, pair[0], pair[1]); changed = true; }
        } else if (item && typeof item === 'object') visit(item, null);
      });
      return;
    }
    for (const [name, item] of Object.entries(value)) {
      if (name === 'cwd' && typeof item === 'string') {
        const pair = pairs.find(([from]) => inside(item, from));
        if (pair) { value[name] = swap(item, pair[0], pair[1]); changed = true; }
      } else if (item && typeof item === 'object') visit(item, name);
    }
  };
  if (row && typeof row === 'object') visit(row, null);
  return changed;
}

function listFiles(dir, test, depth, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) listFiles(full, test, depth - 1, out);
    else if (entry.isFile() && test(entry.name)) out.push(full);
  }
  return out;
}

// The directory a Claude project folder belongs to: one of the `cwd` values of its sessions whose folder name is this one (a session may have moved on
// to a subfolder later, so not simply the first). Null when no row says.
function claudeFolderDir(folder, name) {
  for (const file of listFiles(folder, entry => entry.endsWith('.jsonl'), 0)) {
    let head;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(HEAD_BYTES);
        head = buffer.toString('utf8', 0, fs.readSync(fd, buffer, 0, HEAD_BYTES, 0));
      } finally { fs.closeSync(fd); }
    } catch { continue; }
    for (const line of head.split('\n')) {
      if (!line.includes('"cwd"')) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row && typeof row.cwd === 'string' && path.isAbsolute(row.cwd) && claudeProjectName(row.cwd) === name) return row.cwd;
    }
  }
  return null;
}

// Moves the Claude Code project folders of the renamed folder (the folder itself and every folder inside it) in one config folder (~/.claude).
function moveClaude(claudeDir, pairs, undo, commits) {
  const projects = path.join(claudeDir, 'projects');
  let entries;
  try { entries = fs.readdirSync(projects, { withFileTypes: true }); } catch { return { folders: 0, files: 0 }; }
  const moves = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // a symbolic link is left alone
    for (const [from, to] of pairs) {
      const exact = claudeProjectName(from);
      const prefix = from.replace(/[^A-Za-z0-9]/g, '-').slice(0, 200);
      if (entry.name !== exact && !entry.name.startsWith(prefix)) continue;
      const folder = path.join(projects, entry.name);
      // The lossy name could belong to another folder (/a/b-c and /a/b/c have the same name): the rows say which folder it is.
      const dir = claudeFolderDir(folder, entry.name) || (entry.name === exact ? from : null);
      if (!dir || !inside(dir, from)) continue;
      const target = claudeProjectName(swap(dir, from, to));
      if (target !== entry.name) moves.push({ folder, target: path.join(projects, target) });
      break;
    }
  }
  let files = 0;
  for (const { folder, target } of moves) {
    if (fs.existsSync(target)) throw moveError('SESSION_FOLDER_CONFLICT', target);
    fs.renameSync(folder, target);
    undo.push(() => fs.renameSync(target, folder));
  }
  const needles = needlesOf(pairs);
  for (const { target } of moves) {
    for (const file of listFiles(target, name => name.endsWith('.jsonl'), 3)) {
      if (rewriteJsonl(file, needles, row => rewriteCwd(row, pairs), undo, commits)) files += 1;
    }
  }
  return { folders: moves.length, files };
}

function firstLine(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const text = buffer.toString('utf8', 0, fs.readSync(fd, buffer, 0, HEAD_BYTES, 0));
    return text.split('\n')[0];
  } finally { fs.closeSync(fd); }
}

// The Codex state databases (state_5.sqlite in 0.167; another number in another version) that have the tables used below.
function codexDatabases(codexDir) {
  let names;
  try { names = fs.readdirSync(codexDir); } catch { return []; }
  return names.filter(name => /^state(_\d+)?\.sqlite$/.test(name)).map(name => path.join(codexDir, name));
}

function openDatabase(file) {
  const Database = require('better-sqlite3');
  const db = new Database(file, { fileMustExist: true, timeout: 5000 });
  try { db.pragma('schema_version'); } catch (error) { db.close(); throw error; } // a file that is not a database fails here, not halfway through
  const columns = table => db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
  return { db, columns };
}

// After the service (root) wrote to the database of another user, the journal files it may have made get that user as owner, or Codex could no longer open them.
function keepDatabaseOwner(file) {
  if (!isRoot()) return;
  let stat;
  try { stat = fs.statSync(file); } catch { return; }
  for (const suffix of ['-wal', '-shm', '-journal']) keepOwner(`${file}${suffix}`, stat);
}

// Rows of `table` whose `column` is the old path or inside it, rewritten in one transaction. Returns the rows with their old values, for `restoreRows`.
function rewriteRows(db, table, keyColumns, column, pairs) {
  const rows = [];
  for (const [from] of pairs) {
    const select = db.prepare(`SELECT ${keyColumns.join(', ')}, ${column} AS value FROM ${table} WHERE ${column} = ? OR substr(${column}, 1, ?) = ?`);
    for (const row of select.all(from, from.length + 1, from + path.sep)) if (!rows.some(seen => keyColumns.every(key => seen[key] === row[key]))) rows.push(row);
  }
  if (!rows.length) return rows;
  const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${keyColumns.map(key => `${key} = ?`).join(' AND ')}`);
  db.transaction(() => {
    for (const row of rows) {
      const pair = pairs.find(([from]) => inside(row.value, from));
      update.run(swap(row.value, pair[0], pair[1]), ...keyColumns.map(key => row[key]));
    }
  })();
  return rows;
}

// The undo of `rewriteRows`, on a database opened again (the first handle is closed by then).
function restoreRows(file, table, keyColumns, column, rows) {
  const { db } = openDatabase(file);
  try {
    const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${keyColumns.map(key => `${key} = ?`).join(' AND ')}`);
    db.transaction(() => { for (const row of rows) update.run(row.value, ...keyColumns.map(key => row[key])); })();
  } finally { db.close(); keepDatabaseOwner(file); }
}

// Rewrites the Codex rollouts and state of one Codex home (~/.codex): the rollouts that started in the folder (their first row) or that the state database
// lists for it, then the database rows.
function moveCodex(codexDir, pairs, undo, commits) {
  const files = new Set();
  for (const sub of ['sessions', 'archived_sessions']) {
    for (const file of listFiles(path.join(codexDir, sub), name => /^rollout-.*\.jsonl$/.test(name), 3)) {
      try {
        const meta = JSON.parse(firstLine(file));
        if (meta && meta.type === 'session_meta' && meta.payload && pairs.some(([from]) => inside(meta.payload.cwd, from))) files.add(file);
      } catch { /* not a rollout we can read */ }
    }
  }
  const databases = [];
  for (const file of codexDatabases(codexDir)) {
    let handle;
    try { handle = openDatabase(file); } catch (error) { throw moveError('CODEX_STATE_UNREADABLE', `${file}: ${error.message}`); }
    databases.push({ file, ...handle });
  }
  try {
    for (const { db, columns } of databases) {
      if (!columns('threads').includes('cwd') || !columns('threads').includes('rollout_path')) continue;
      for (const [from] of pairs) {
        const rows = db.prepare('SELECT rollout_path FROM threads WHERE cwd = ? OR substr(cwd, 1, ?) = ?').all(from, from.length + 1, from + path.sep);
        for (const row of rows) if (row.rollout_path && path.isAbsolute(row.rollout_path) && fs.existsSync(row.rollout_path)) files.add(row.rollout_path);
      }
    }
    const needles = needlesOf(pairs);
    let rewritten = 0;
    for (const file of files) {
      if (rewriteJsonl(file, needles, row => rewriteCwd(row, pairs, CODEX_ROOT_KEYS), undo, commits)) rewritten += 1;
    }
    let threads = 0;
    for (const { file, db, columns } of databases) {
      try {
        const tables = [['threads', ['id'], 'cwd'], ['project_roots', ['project_id', 'position'], 'path']];
        for (const [table, keys, column] of tables) {
          const present = columns(table);
          if (![...keys, column].every(name => present.includes(name))) continue;
          const rows = rewriteRows(db, table, keys, column, pairs);
          if (table === 'threads') threads += rows.length;
          if (rows.length) undo.push(() => restoreRows(file, table, keys, column, rows));
        }
      } catch (error) { throw moveError('CODEX_STATE_UPDATE_FAILED', `${file}: ${error.message}`); }
    }
    return { rollouts: rewritten, threads };
  } finally {
    for (const { file, db } of databases) { try { db.close(); } catch { /* closed */ } keepDatabaseOwner(file); }
  }
}

module.exports = { pathPairs, moveClaude, moveCodex, rewriteJsonl, rewriteCwd, claudeFolderDir, BACKUP_SUFFIX };
