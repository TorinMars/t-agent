// 工作目录体检：不合法内容的提示，以及“长期没动、内容都在远程仓库里”的项目清理建议。
// 清理只删除本地文件，且只在 Git 状态确认安全（无未提交、无未推送、无暂存）时才允许；
// 清理前把元信息和仓库地址、分支、提交记入 .t-agent/archive.json，之后可以从仓库恢复。
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const run = promisify(execFile);
const DAY = 24 * 60 * 60 * 1000;
const GIT_TIMEOUT = 15000;

function idleDays() {
  const value = Number(process.env.TASK_IDLE_DAYS);
  return Number.isFinite(value) && value > 0 ? value : 30;
}

async function git(dir, args, timeout = GIT_TIMEOUT) {
  const { stdout } = await run('git', ['-C', dir, ...args], { timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return stdout.trim();
}

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

// 最近一次活动：元信息更新、Git 的 HEAD/索引/日志/拉取记录中最新的一个。
function lastActivity(task) {
  const gitDir = path.join(task.work_dir, '.git');
  const times = [Date.parse(task.updated_at) || 0, ...['HEAD', 'index', 'FETCH_HEAD', path.join('logs', 'HEAD')].map(name => mtime(path.join(gitDir, name)))];
  return Math.max(...times);
}

function directorySize(dir, limit = 300000) {
  let total = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length && seen < limit) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      seen += 1;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) { try { total += fs.statSync(full).size; } catch { /* 忽略 */ } }
    }
  }
  return total;
}

// 判断某个任务目录能否安全删除本地文件。返回 { safe:true, remote, branch, commit } 或 { safe:false, reason }。
async function inspectRepository(dir) {
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) return { safe: false, reason: '不是 Git 仓库，删除后无法恢复' };
    const top = fs.realpathSync(await git(dir, ['rev-parse', '--show-toplevel']));
    if (top !== fs.realpathSync(dir)) return { safe: false, reason: '目录只是某个仓库的子目录，不能单独删除' };
    if (await git(dir, ['status', '--porcelain', '--untracked-files=normal', '--', '.', ':(exclude).t-agent'])) return { safe: false, reason: '有未提交的修改或未跟踪文件' };
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
    const commit = await git(dir, ['rev-parse', 'HEAD']);
    return { safe: true, remote, branch, commit };
  } catch (error) {
    return { safe: false, reason: `Git 检查失败：${(error.stderr || error.message || '').toString().trim().split('\n')[0]}` };
  }
}

function archiveFile(store) { return path.join(store.root, '.t-agent', 'archive.json'); }
function readArchive(store) {
  try { const value = JSON.parse(fs.readFileSync(archiveFile(store), 'utf8')); return Array.isArray(value.items) ? value.items : []; } catch { return []; }
}
function writeArchive(store, items) {
  fs.mkdirSync(path.dirname(archiveFile(store)), { recursive: true });
  fs.writeFileSync(archiveFile(store), `${JSON.stringify({ items }, null, 2)}\n`, 'utf8');
}

async function health(store, days = idleDays()) {
  const issues = store.getIssues();
  const cutoff = Date.now() - days * DAY;
  const stale = [];
  for (const task of store.listTasks()) {
    const last = lastActivity(task);
    if (!last || last > cutoff) continue;
    const repo = await inspectRepository(task.work_dir);
    if (!repo.safe) continue;
    stale.push({
      task_id: task.id, title: task.title, path: task.work_dir,
      idle_days: Math.floor((Date.now() - last) / DAY), size_bytes: directorySize(task.work_dir),
      remote: repo.remote, branch: repo.branch, commit: repo.commit,
    });
  }
  stale.sort((a, b) => b.size_bytes - a.size_bytes);
  return { idle_days_threshold: days, issues, stale, archived: readArchive(store) };
}

function serviceError(code, statusCode = 400) {
  return Object.assign(new Error(code), { statusCode });
}

// 删除任务目录的本地文件。服务端重新检查，不信任前端传来的“安全”判断。
async function removeLocalRepository(store, taskId, closeTerminals = () => {}) {
  const task = store.getTask(taskId);
  if (!task) throw serviceError('TASK_NOT_FOUND', 404);
  const dir = path.resolve(task.work_dir);
  if (dir === path.parse(dir).root || dir === require('os').homedir() || dir === store.root) throw serviceError('REFUSE_TO_DELETE_DIRECTORY', 400);
  const repo = await inspectRepository(dir);
  if (!repo.safe) throw Object.assign(serviceError('REPOSITORY_NOT_SAFE_TO_DELETE', 409), { reason: repo.reason });
  const meta = JSON.parse(fs.readFileSync(path.join(dir, '.t-agent', 'task.json'), 'utf8'));
  const item = {
    id: task.id, title: task.title, path: dir, remote: repo.remote, branch: repo.branch, commit: repo.commit,
    size_bytes: directorySize(dir), deleted_at: new Date().toISOString(), meta,
    restore: `git clone -b ${repo.branch} ${repo.remote} ${dir}`,
  };
  // 先记档案，再删除；档案写不进去就不删。
  writeArchive(store, [...readArchive(store).filter(old => old.path !== dir), item]);
  closeTerminals(task.id);
  fs.rmSync(dir, { recursive: true, force: true });
  store.unregisterProject(dir);
  store.invalidate();
  return item;
}

// 从仓库恢复：克隆回原路径并写回元信息（保留任务 ID、待办、分享令牌）。
async function restoreRepository(store, id) {
  const items = readArchive(store);
  const item = items.find(entry => entry.id === Number(id));
  if (!item) throw serviceError('ARCHIVE_ITEM_NOT_FOUND', 404);
  if (fs.existsSync(item.path)) throw serviceError('RESTORE_PATH_EXISTS', 409);
  fs.mkdirSync(path.dirname(item.path), { recursive: true });
  await run('git', ['clone', '-b', item.branch, item.remote, item.path], { timeout: 10 * 60 * 1000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const metaFile = path.join(item.path, '.t-agent', 'task.json');
  if (!fs.existsSync(metaFile)) {
    fs.mkdirSync(path.dirname(metaFile), { recursive: true });
    fs.writeFileSync(metaFile, `${JSON.stringify({ ...item.meta, deleted: undefined, updated_at: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  }
  store.registerProject(item.path);
  writeArchive(store, items.filter(entry => entry.id !== item.id));
  store.invalidate();
  return store.getTask(item.id);
}

module.exports = { idleDays, inspectRepository, health, removeLocalRepository, restoreRepository, readArchive, lastActivity };
