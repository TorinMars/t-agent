// 工作目录工具（任务仍只保存在数据库）：
//  1. 列出工作目录下还没有被任务管理的子目录，支持批量导入；
//  2. 任务目录本身通常不是 Git 仓库，里面（几层子目录内）有多个仓库。列出每个任务下的所有仓库
//     及占用空间，批量清理不用的仓库目录。清理只删本地的仓库目录（任务目录和其他文件保留），
//     且仅当该仓库 Git 状态确认安全（无未提交、无未推送、无 stash）时才允许，
//     清理前把仓库地址、分支、提交记入 repo_cleanups，之后可以从仓库恢复。
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

// ---------- 导入 ----------
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

// 只登记，不在目录里生成任何文件（技术文档等在首次打开时才按需创建）。
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

// ---------- 删除任务时一并删除目录 ----------
// 返回不能删除的原因，可以删除则返回 null。目录删除不可恢复，所以对受保护目录、被其他任务共用的目录一律拒绝。
function taskDirectoryGuard(database, owner, task, workDir) {
  if (!task.work_dir) return '任务没有工作目录';
  const dir = path.resolve(task.work_dir);
  const root = workRoot(workDir);
  const others = database.prepare('SELECT work_dir FROM tasks WHERE user_id = ? AND id != ? AND work_dir IS NOT NULL').all(owner, task.id).map(row => path.resolve(row.work_dir));
  if (others.includes(dir)) return '其他任务也在使用这个目录';
  const reason = protectedReason(dir, { root, others });
  return reason;
}

function removeTaskDirectory(task) {
  if (!task.work_dir || !isDirectory(task.work_dir)) return false;
  fs.rmSync(path.resolve(task.work_dir), { recursive: true, force: true });
  return true;
}

// ---------- 清理 ----------
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
  try { times.push(Number(await git(dir, ['log', '-1', '--format=%ct'])) * 1000 || 0); } catch { /* 没有提交 */ }
  return Math.max(...times);
}

// 在任务目录里找 Git 仓库：任务目录自己是仓库就只算它；否则向下找，最多 MAX_DEPTH 层，
// 不进入仓库内部、隐藏目录和 node_modules。
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

// 仓库目录不能是这些：系统根、家目录、工作目录、包含工作目录或本程序的目录、含有其他任务目录的目录。
function protectedReason(dir, { root, others }) {
  const home = os.homedir();
  const app = path.resolve(__dirname, '..');
  if (dir === path.parse(dir).root || dir === home || dir === root) return '受保护的目录';
  if (root.startsWith(dir + path.sep) || app === dir || app.startsWith(dir + path.sep)) return '包含工作目录或本程序，不能删除';
  if (others.some(other => other !== dir && other.startsWith(dir + path.sep))) return '里面还有其他任务的目录，不能删除';
  return null;
}

async function inspectRepository(dir) {
  try {
    if (!isDirectory(dir)) return { safe: false, reason: '目录不存在' };
    if (!fs.existsSync(path.join(dir, '.git'))) return { safe: false, reason: '不是 Git 仓库，删除后无法恢复' };
    const top = fs.realpathSync(await git(dir, ['rev-parse', '--show-toplevel']));
    if (top !== fs.realpathSync(dir)) return { safe: false, reason: '目录只是某个仓库的子目录，不能单独删除' };
    if (await git(dir, ['status', '--porcelain', '--untracked-files=normal'])) return { safe: false, reason: '有未提交的修改或未跟踪文件' };
    if (await git(dir, ['stash', 'list'])) return { safe: false, reason: '有 Git stash 暂存内容' };
    const branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch === 'HEAD') return { safe: false, reason: '当前是游离 HEAD，没有分支可以恢复' };
    const remotes = (await git(dir, ['remote'])).split('\n').filter(Boolean);
    if (!remotes.length) return { safe: false, reason: '没有配置远程仓库' };
    const refs = await git(dir, ['for-each-ref', '--format=%(refname:short)|%(upstream:short)|%(upstream:track)', 'refs/heads']);
    for (const line of refs.split('\n').filter(Boolean)) {
      const [name, upstream, track] = line.split('|');
      if (!upstream) return { safe: false, reason: `本地分支 ${name} 没有对应的远程分支（未推送）` };
      if (/ahead/.test(track)) return { safe: false, reason: `本地分支 ${name} 有未推送的提交` };
      if (/gone/.test(track)) return { safe: false, reason: `本地分支 ${name} 的远程分支已不存在` };
    }
    const remote = await git(dir, ['remote', 'get-url', remotes.includes('origin') ? 'origin' : remotes[0]]);
    return { safe: true, remote, branch, commit: await git(dir, ['rev-parse', 'HEAD']) };
  } catch (error) {
    return { safe: false, reason: `Git 检查失败：${(error.stderr || error.message || '').toString().trim().split('\n')[0]}` };
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

// 逐个仓库清理，一个失败不影响其他。服务端重新检查，不信任前端传来的“安全”判断；
// 只接受确实位于该任务目录内、且被识别为仓库的路径。
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
