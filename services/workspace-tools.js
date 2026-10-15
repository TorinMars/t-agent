// Workspace tools (tasks are still only stored in the database):
// 1. List sub-directories of the workspace that are not yet managed by a task, with bulk import;
// 2. A task directory itself is usually not a Git repo, but contains several repos (a few levels down). List all repos under each task
// with their disk usage and clean up unused repo directories in bulk. Cleanup only deletes the local repo directory (the task directory and other files are kept),
// and is only allowed when the repo's Git state is confirmed safe (nothing uncommitted, nothing unpushed, no stash);
// before cleaning, the repo address, branch and commit are recorded in repo_cleanups so it can be restored from the remote later.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const run = promisify(execFile);
const DAY = 24 * 60 * 60 * 1000;
const GIT_TIMEOUT = 15000;
const SKIP_DIRS = new Set(['node_modules']);

function serviceError(code, statusCode = 400, extra = {}) {
  return Object.assign(new Error(code), { statusCode, ...extra });
}

function idleDays() {
  const value = Number(process.env.TASK_IDLE_DAYS);
  return Number.isFinite(value) && value > 0 ? value : 30;
}

function workRoot(workDir) {
  return path.resolve(workDir || process.env.TASKS_BASE_DIR || path.join(os.homedir(), 'tasks'));
}

function isDirectory(target) {
  try { return fs.statSync(target).isDirectory(); } catch { return false; }
}

// ---------- Import ----------
function managedDirs(database, owner) {
  return database.prepare('SELECT work_dir FROM tasks WHERE user_id = ? AND work_dir IS NOT NULL').all(owner)
    .map(row => path.resolve(row.work_dir));
}

function isManaged(dir, managed) {
  return managed.some(item => item === dir || item.startsWith(dir + path.sep));
}

function listUnmanaged(database, owner, workDir) {
  const root = workRoot(workDir);
  const managed = managedDirs(database, owner);
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return { root, items: [] }; }
  const items = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (!(entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(full)))) continue;
    if (isManaged(full, managed)) continue;
    items.push({ name: entry.name, path: full, is_git: fs.existsSync(path.join(full, '.git')) });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { root, items };
}

// Only register; no file is created in the directory (the design doc etc. are created on demand when first opened).
function importDirs(database, owner, workDir, paths, status = 'todo') {
  if (!Array.isArray(paths) || !paths.length) throw serviceError('PATHS_REQUIRED');
  const { items } = listUnmanaged(database, owner, workDir);
  const allowed = new Map(items.map(item => [item.path, item]));
  const insert = database.prepare(`INSERT INTO tasks (title, status, priority, md_path, work_dir, sort_order, user_id)
    VALUES (?, ?, 'normal', ?, ?, 0, ?)`);
  const created = [];
  database.transaction(() => {
    for (const raw of paths) {
      const target = path.resolve(String(raw));
      const item = allowed.get(target);
      if (!item) throw serviceError('PATH_NOT_IMPORTABLE', 400, { path: target });
      const info = insert.run(item.name, status, path.join(target, 'DESIGN.md'), target, owner);
      created.push(database.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid));
      allowed.delete(target);
    }
  })();
  return created;
}

// ---------- Delete the directory together with the task ----------
// Returns the reason it cannot be deleted, or null when it can. Deleting a directory is irreversible, so protected directories and directories shared by other tasks are always refused.
function taskDirectoryGuard(database, owner, task, workDir) {
  if (!task.work_dir) return 'The task has no working directory';
  const dir = path.resolve(task.work_dir);
  const root = workRoot(workDir);
  const others = database.prepare('SELECT work_dir FROM tasks WHERE user_id = ? AND id != ? AND work_dir IS NOT NULL').all(owner, task.id).map(row => path.resolve(row.work_dir));
  if (others.includes(dir)) return 'Other tasks also use this directory';
  const reason = protectedReason(dir, { root, others });
  return reason;
}

function removeTaskDirectory(task) {
  if (!task.work_dir || !isDirectory(task.work_dir)) return false;
  fs.rmSync(path.resolve(task.work_dir), { recursive: true, force: true });
  return true;
}

// ---------- Cleanup ----------
async function git(dir, args, timeout = GIT_TIMEOUT) {
  const { stdout } = await run('git', ['-C', dir, ...args], { timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return stdout.trim();
}

async function directorySize(dir) {
  try {
    const { stdout } = await run('du', ['-sk', dir], { timeout: 120000 });
    return Number(stdout.split(/\s+/)[0]) * 1024 || 0;
  } catch { return 0; }
}

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

async function lastActivity(dir) {
  const gitDir = path.join(dir, '.git');
  const times = ['HEAD', 'index', 'FETCH_HEAD', path.join('logs', 'HEAD')].map(name => mtime(path.join(gitDir, name)));
  try { times.push(Number(await git(dir, ['log', '-1', '--format=%ct'])) * 1000 || 0); } catch { /* no commits */ }
  return Math.max(...times);
}

// Find Git repos inside a task directory: if the task directory is itself a repo only it counts; otherwise search downwards, at most MAX_DEPTH levels,
// without entering repos, hidden directories or node_modules.
const MAX_DEPTH = 3;
function findRepos(taskDir) {
  const root = path.resolve(taskDir);
  if (!isDirectory(root)) return [];
  if (fs.existsSync(path.join(root, '.git'))) return [root];
  const repos = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (fs.existsSync(path.join(full, '.git'))) repos.push(full);
      else if (depth < MAX_DEPTH) walk(full, depth + 1);
    }
  };
  walk(root, 1);
  return repos.sort();
}

// A repo directory must not be any of these: the filesystem root, the home directory, the workspace, a directory containing the workspace or this program, or a directory that contains other task directories.
function protectedReason(dir, { root, others }) {
  const home = os.homedir();
  const app = path.resolve(__dirname, '..');
  if (dir === path.parse(dir).root || dir === home || dir === root) return 'Protected directory';
  if (root.startsWith(dir + path.sep) || app === dir || app.startsWith(dir + path.sep)) return 'Contains the workspace or this program; it cannot be deleted';
  if (others.some(other => other !== dir && other.startsWith(dir + path.sep))) return 'Contains directories of other tasks; it cannot be deleted';
  return null;
}

async function inspectRepository(dir) {
  try {
    if (!isDirectory(dir)) return { safe: false, reason: 'Directory does not exist' };
    if (!fs.existsSync(path.join(dir, '.git'))) return { safe: false, reason: 'Not a Git repository; it cannot be restored after deletion' };
    const top = fs.realpathSync(await git(dir, ['rev-parse', '--show-toplevel']));
    if (top !== fs.realpathSync(dir)) return { safe: false, reason: 'The directory is only a subdirectory of a repository and cannot be deleted on its own' };
    if (await git(dir, ['status', '--porcelain', '--untracked-files=normal'])) return { safe: false, reason: 'Has uncommitted changes or untracked files' };
    if (await git(dir, ['stash', 'list'])) return { safe: false, reason: 'Has Git stash entries' };
    const branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch === 'HEAD') return { safe: false, reason: 'Detached HEAD; there is no branch to restore' };
    const remotes = (await git(dir, ['remote'])).split('\n').filter(Boolean);
    if (!remotes.length) return { safe: false, reason: 'No remote repository configured' };
    const refs = await git(dir, ['for-each-ref', '--format=%(refname:short)|%(upstream:short)|%(upstream:track)', 'refs/heads']);
    for (const line of refs.split('\n').filter(Boolean)) {
      const [name, upstream, track] = line.split('|');
      if (!upstream) return { safe: false, reason: `Local branch ${name} has no matching remote branch (not pushed)` };
      if (/ahead/.test(track)) return { safe: false, reason: `Local branch ${name} has unpushed commits` };
      if (/gone/.test(track)) return { safe: false, reason: `The remote branch of local branch ${name} no longer exists` };
    }
    const remote = await git(dir, ['remote', 'get-url', remotes.includes('origin') ? 'origin' : remotes[0]]);
    return { safe: true, remote, branch, commit: await git(dir, ['rev-parse', 'HEAD']) };
  } catch (error) {
    return { safe: false, reason: `Git check failed: ${(error.stderr || error.message || '').toString().trim().split('\n')[0]}` };
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await worker(items[index]); }
  }));
  return results;
}

async function cleanupOverview(database, owner, workDir) {
  const root = workRoot(workDir);
  const tasks = database.prepare('SELECT * FROM tasks WHERE user_id = ? AND work_dir IS NOT NULL ORDER BY id').all(owner);
  const others = tasks.map(task => path.resolve(task.work_dir));
  const cleaned = database.prepare('SELECT * FROM repo_cleanups ORDER BY cleaned_at DESC, id DESC').all();
  const cleanedPaths = new Set(cleaned.map(row => row.path));
  const jobs = [];
  for (const task of tasks) for (const repo of findRepos(task.work_dir)) if (!cleanedPaths.has(repo)) jobs.push({ task, repo });
  const items = await mapLimit(jobs, 4, async ({ task, repo }) => {
    const taskDir = path.resolve(task.work_dir);
    const base = { task_id: task.id, title: task.title, task_path: taskDir, path: repo, name: path.relative(taskDir, repo) || path.basename(repo) };
    const [size, last] = await Promise.all([directorySize(repo), lastActivity(repo)]);
    const guard = protectedReason(repo, { root, others });
    const inspected = guard ? { safe: false, reason: guard } : await inspectRepository(repo);
    return { ...base, size_bytes: size, idle_days: last ? Math.floor((Date.now() - last) / DAY) : null, ...inspected };
  });
  items.sort((a, b) => b.size_bytes - a.size_bytes);
  const titles = new Map(tasks.map(task => [task.id, task.title]));
  const archived = cleaned.filter(row => titles.has(row.task_id)).map(row => ({
    id: row.id, task_id: row.task_id, title: titles.get(row.task_id), path: row.path, remote: row.remote, branch: row.branch,
    size_bytes: row.size_bytes, cleaned_at: row.cleaned_at, restore: `git clone -b ${row.branch} ${row.remote} ${row.path}`,
  }));
  return { idle_days_threshold: idleDays(), items, archived };
}

// Clean repos one by one; one failure does not affect the others. The server re-checks and does not trust the "safe" verdict sent by the frontend;
// only paths that really lie inside the task directory and are recognized as repos are accepted.
async function cleanupRepos(database, owner, workDir, requests, closeTerminals = () => {}) {
  if (!Array.isArray(requests) || !requests.length) throw serviceError('REPOS_REQUIRED');
  const root = workRoot(workDir);
  const all = database.prepare('SELECT * FROM tasks WHERE user_id = ? AND work_dir IS NOT NULL').all(owner);
  const others = all.map(task => path.resolve(task.work_dir));
  const results = [];
  for (const request of requests) {
    const taskId = Number(request && request.task_id);
    const target = path.resolve(String((request && request.path) || ''));
    const task = all.find(item => item.id === taskId);
    if (!task) { results.push({ task_id: taskId, path: target, ok: false, error: 'TASK_NOT_FOUND' }); continue; }
    if (!findRepos(task.work_dir).includes(target)) { results.push({ task_id: taskId, path: target, ok: false, error: 'NOT_A_REPOSITORY_OF_TASK' }); continue; }
    const guard = protectedReason(target, { root, others });
    const repo = guard ? { safe: false, reason: guard } : await inspectRepository(target);
    if (!repo.safe) { results.push({ task_id: taskId, path: target, ok: false, error: 'NOT_SAFE_TO_DELETE', reason: repo.reason }); continue; }
    const size = await directorySize(target);
    let recordId;
    try {
      recordId = database.prepare(`INSERT INTO repo_cleanups (task_id, path, remote, branch, commit_sha, size_bytes) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(taskId, target, repo.remote, repo.branch, repo.commit, size).lastInsertRowid;
      closeTerminals(taskId);
      fs.rmSync(target, { recursive: true, force: true });
      results.push({ task_id: taskId, path: target, ok: true, freed_bytes: size });
    } catch (error) {
      if (recordId) database.prepare('DELETE FROM repo_cleanups WHERE id = ?').run(recordId);
      results.push({ task_id: taskId, path: target, ok: false, error: 'DELETE_FAILED', reason: error.message });
    }
  }
  return results;
}

async function restoreRepo(database, owner, cleanupId) {
  const row = database.prepare('SELECT * FROM repo_cleanups WHERE id = ?').get(cleanupId);
  const task = row && database.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(row.task_id, owner);
  if (!task) throw serviceError('CLEANUP_RECORD_NOT_FOUND', 404);
  if (fs.existsSync(row.path)) throw serviceError('RESTORE_PATH_EXISTS', 409);
  fs.mkdirSync(path.dirname(row.path), { recursive: true });
  await run('git', ['clone', '-b', row.branch, row.remote, row.path], { timeout: 10 * 60 * 1000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  database.prepare('DELETE FROM repo_cleanups WHERE id = ?').run(row.id);
  return task;
}

module.exports = { taskDirectoryGuard, removeTaskDirectory, idleDays, listUnmanaged, importDirs, findRepos, inspectRepository, cleanupOverview, cleanupRepos, restoreRepo };
