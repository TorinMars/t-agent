// Renaming a task's working folder (POST /api/tasks/:id/rename-folder, POST /v1/tasks/:id/rename-folder, and the remote proxy), optionally with a new title.
// See "Task rename" in DESIGN.md. The folder gets a new name in the same parent folder; the Claude Code and Codex sessions that were run in it move with
// it (lib/agent-session-move.js), so a terminal reopened in the new folder resumes them; then the task's records follow.
//
// All or nothing: each step records how to undo it, and a failure in a later step undoes the earlier ones in reverse order. The whole operation is
// synchronous, so no terminal or chat turn can start between the busy check and the end.
//
// Refused: a task with a live terminal or a running chat turn (409 TASK_BUSY, with the live terminal ids), a name that is not one plain path segment
// (400 INVALID_FOLDER_NAME), a target that exists (409 FOLDER_EXISTS), a folder that the delete rules protect or that holds another task's folder
// (409 FOLDER_NOT_RENAMABLE, from workspace-tools `taskDirectoryGuard`), and a folder that is a Git worktree, or holds a repository with linked worktrees
// or a worktree, which a move would break (409 FOLDER_NOT_RENAMABLE): see `worktreeReason`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const workspaceTools = require('./workspace-tools');
const sessionMove = require('../lib/agent-session-move');
const { resolveTerminalUser } = require('../lib/terminal-user');

const MAX_NAME_BYTES = 255;

const inside = (value, dir) => typeof value === 'string' && (value === dir || value.startsWith(dir + path.sep));
// A stored path inside the old folder, moved to the new one (normalised first); any other value is kept as it is.
const swap = (value, from, to) => {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return value;
  const resolved = path.resolve(value);
  return inside(resolved, from) ? to + resolved.slice(from.length) : value;
};

function fail(code, statusCode, extra = {}) {
  return Object.assign(new Error(code), { statusCode, ...extra });
}

// One plain path segment: no separator, not "." or "..", no control character, at most 255 bytes, no space at either end.
function checkName(value) {
  const name = typeof value === 'string' ? value : '';
  if (!name || name !== name.trim() || name === '.' || name === '..' || /[/\\]/.test(name) || /[\u0000-\u001f\u007f]/.test(name) || Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
    throw fail('INVALID_FOLDER_NAME', 400);
  }
  return name;
}

function checkTitle(value) {
  if (value === undefined) return undefined;
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title) throw fail('TITLE_REQUIRED', 400);
  return title;
}

// Git keeps absolute paths between a repository and its linked worktrees (both ways), and between a submodule and the repository holding it, so a move
// breaks them. Found by: a `.git` file ("gitdir: ...") in the folder itself (a worktree or a submodule) or, inside it, one that points to a worktree entry
// or outside the folder; and a non-empty `.git/worktrees` (a repository with linked worktrees). The folder itself and the repositories inside it
// (workspace-tools `findRepos`: three levels down, not into hidden folders or node_modules) are checked. Plain repositories move fine.
function worktreeReason(dir) {
  for (const repo of new Set([dir, ...workspaceTools.findRepos(dir)])) {
    const dotGit = path.join(repo, '.git');
    let stat;
    try { stat = fs.lstatSync(dotGit); } catch { continue; }
    if (stat.isFile()) {
      let target = null;
      try {
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
        if (match) target = path.resolve(repo, match[1]);
      } catch { /* unreadable: refused below */ }
      if (repo === dir || !target || !inside(target, dir) || /[/\\]worktrees[/\\]/.test(target)) {
        return repo === dir ? 'The folder is a Git worktree or submodule; renaming would break its link to the repository'
          : `A Git worktree or submodule inside the folder would break: ${path.relative(dir, repo)}`;
      }
    } else if (stat.isDirectory()) {
      let names = [];
      try { names = fs.readdirSync(path.join(dotGit, 'worktrees')); } catch { /* no linked worktrees */ }
      if (names.length) {
        return repo === dir ? 'The folder is a Git repository with linked worktrees; renaming would break them'
          : `A Git repository with linked worktrees inside the folder would break: ${path.relative(dir, repo)}`;
      }
    }
  }
  return null;
}

// The agent homes whose sessions move: the terminal user's (the terminals run as that user when the service drops privileges, lib/terminal-user.js) and
// the service's own, plus CLAUDE_CONFIG_DIR and CODEX_HOME when the service has them (the terminals inherit them).
function defaultAgentDirs({ env = process.env, homedir = os.homedir, terminalUser = () => resolveTerminalUser().user } = {}) {
  const homes = [];
  let user = null;
  try { user = terminalUser(); } catch { user = null; }
  if (user && user.home) homes.push(user.home);
  homes.push(homedir());
  const claude = new Set(homes.map(home => path.join(home, '.claude')));
  const codex = new Set(homes.map(home => path.join(home, '.codex')));
  if (env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR)) claude.add(path.resolve(env.CLAUDE_CONFIG_DIR));
  if (env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME)) codex.add(path.resolve(env.CODEX_HOME));
  return { claude: [...claude], codex: [...codex] };
}


// The task records that name the folder: the task's paths, the start folders of terminals (task_terminals.work_dir, task_default_terminal_dirs) and the
// cleaned repositories (repo_cleanups.path, restored there). Agent chats store no folder (they use the task's), shares and the task order are keyed by
// ids, so they stay. One transaction; it is the last step, so nothing runs after it that could need it undone.
function updateRecords(db, owner, task, from, to, title) {
  const ownTasks = 'SELECT id FROM tasks WHERE user_id = ?';
  db.transaction(() => {
    db.prepare(`UPDATE tasks SET work_dir = ?, md_path = ?, technical_path = ?, readme_path = ?, agent_path = ?,
      title = COALESCE(?, title), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`).run(
      swap(task.work_dir, from, to), swap(task.md_path, from, to), swap(task.technical_path, from, to), swap(task.readme_path, from, to),
      swap(task.agent_path, from, to), title === undefined ? null : title, task.id, owner);
    const terminals = db.prepare(`SELECT task_id, terminal_id, work_dir FROM task_terminals WHERE work_dir IS NOT NULL AND task_id IN (${ownTasks})`).all(owner);
    const setTerminal = db.prepare('UPDATE task_terminals SET work_dir = ? WHERE task_id = ? AND terminal_id = ?');
    for (const row of terminals) if (swap(row.work_dir, from, to) !== row.work_dir) setTerminal.run(swap(row.work_dir, from, to), row.task_id, row.terminal_id);
    const defaults = db.prepare(`SELECT task_id, work_dir FROM task_default_terminal_dirs WHERE task_id IN (${ownTasks})`).all(owner);
    const setDefault = db.prepare('UPDATE task_default_terminal_dirs SET work_dir = ? WHERE task_id = ?');
    for (const row of defaults) if (swap(row.work_dir, from, to) !== row.work_dir) setDefault.run(swap(row.work_dir, from, to), row.task_id);
    const cleanups = db.prepare('SELECT id, path FROM repo_cleanups WHERE task_id = ?').all(task.id);
    const setCleanup = db.prepare('UPDATE repo_cleanups SET path = ? WHERE id = ?');
    for (const row of cleanups) if (swap(row.path, from, to) !== row.path) setCleanup.run(swap(row.path, from, to), row.id);
  })();
}

function realOrNull(target) {
  try { return fs.realpathSync(target); } catch { return null; }
}

// What keeps the folder open: the live terminals of the task and a running chat turn.
function busyState(taskId) {
  return { terminals: require('../routes/terminal').liveTerminalIds(taskId), chat: require('./agent-chat').getAgentChat().taskBusy(taskId) };
}

// The JSON of a refusal or failure: the code, and the reason, live terminals or clashing path when there are any.
function errorBody(error) {
  const code = /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'RENAME_FAILED';
  return {
    error: code,
    ...(error.reason ? { reason: error.reason } : {}),
    ...(Array.isArray(error.terminals) ? { terminals: error.terminals, chat: Boolean(error.chat) } : {}),
    ...(error.path ? { path: error.path } : {}),
  };
}

// options: db, owner, taskId, body ({ name, title? }), workRoot (the tasks folder of the owner), busy(taskId) -> { terminals: [ids], chat: boolean },
// agentDirs ({ claude: [...], codex: [...] }; the default reads the homes as above), hooks (tests: `afterStep(name)` may throw to test the rollback).
function renameTaskFolder({ db, owner, taskId, body = {}, workRoot, busy = busyState, agentDirs = defaultAgentDirs(), hooks = {} }) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(taskId, owner);
  if (!task) throw fail('TASK_NOT_FOUND', 404);
  const name = checkName(body.name);
  const title = checkTitle(body.title);
  if (!task.work_dir) throw fail('FOLDER_NOT_RENAMABLE', 409, { reason: 'The task has no working directory' });
  const from = path.resolve(task.work_dir);
  let stat;
  try { stat = fs.lstatSync(from); } catch { throw fail('FOLDER_MISSING', 409, { reason: 'The working directory does not exist' }); }
  if (!stat.isDirectory()) throw fail('FOLDER_NOT_RENAMABLE', 409, { reason: stat.isSymbolicLink() ? 'The working directory is a symbolic link' : 'The working directory is not a folder' });
  const to = path.join(path.dirname(from), name);
  if (to === from) throw fail('FOLDER_NAME_UNCHANGED', 400);

  const guard = workspaceTools.taskDirectoryGuard(db, owner, task, workRoot);
  // The delete rules are shared, and so is their wording, without the "it cannot be deleted" part.
  if (guard) throw fail('FOLDER_NOT_RENAMABLE', 409, { reason: guard.replace(/; it cannot be deleted$/, '') });
  const worktree = worktreeReason(from);
  if (worktree) throw fail('FOLDER_NOT_RENAMABLE', 409, { reason: worktree });
  let existing = null;
  try { existing = fs.lstatSync(to); } catch { /* free */ }
  // A case-insensitive file system answers for the old folder when only the case changes; that is the same folder, not a clash.
  if (existing && !(existing.ino === stat.ino && existing.dev === stat.dev)) throw fail('FOLDER_EXISTS', 409, { path: to });
  // Last, so that a rename that cannot happen anyway does not first ask to close the terminals.
  const state = busy(task.id);
  if ((state.terminals && state.terminals.length) || state.chat) {
    throw fail('TASK_BUSY', 409, { terminals: state.terminals || [], chat: Boolean(state.chat) });
  }

  const oldReal = realOrNull(from);
  const parentReal = realOrNull(path.dirname(from));
  const pairs = sessionMove.pathPairs(from, to, oldReal, parentReal ? path.join(parentReal, name) : null);
  const undo = [];
  const commits = [];
  const step = label => { if (hooks.afterStep) hooks.afterStep(label); };
  const moved = { claude_folders: 0, claude_files: 0, codex_rollouts: 0, codex_threads: 0 };
  try {
    fs.renameSync(from, to);
    undo.push(() => fs.renameSync(to, from));
    step('folder');
    for (const dir of agentDirs.claude || []) {
      const result = sessionMove.moveClaude(dir, pairs, undo, commits);
      moved.claude_folders += result.folders;
      moved.claude_files += result.files;
    }
    step('claude');
    for (const dir of agentDirs.codex || []) {
      const result = sessionMove.moveCodex(dir, pairs, undo, commits);
      moved.codex_rollouts += result.rollouts;
      moved.codex_threads += result.threads;
    }
    step('codex');
    updateRecords(db, owner, task, from, to, title);
    step('records');
  } catch (error) {
    const failures = [];
    for (const action of undo.reverse()) {
      try { action(); } catch (undoError) { failures.push(undoError.message); }
    }
    if (failures.length) {
      console.error('[task-rename] rollback incomplete:', failures.join('; '));
      throw fail('RENAME_ROLLBACK_FAILED', 500, { reason: `${error.message}; undo failed: ${failures.join('; ')}` });
    }
    if (error.statusCode && error.statusCode < 500) throw error;
    throw fail('RENAME_FAILED', 500, { reason: error.detail ? `${error.message}: ${error.detail}` : error.message });
  }
  for (const action of commits) action();
  return { task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id), old_dir: from, new_dir: to, moved };
}

module.exports = { renameTaskFolder, errorBody, busyState, checkName, worktreeReason, defaultAgentDirs };
