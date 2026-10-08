// Only modified tracked files block an update. Untracked files (.DS_Store, nohup.out, editor or
// agent folders...) are left alone: git's own fast-forward merge refuses to overwrite one that
// collides with an incoming file, so they never need to stop an update by themselves.
const MAX_LISTED_FILES = 8;

async function trackedChanges(execGit) {
  const output = await execGit(['status', '--porcelain', '--untracked-files=no']);
  return String(output).split('\n').map(line => line.trimEnd()).filter(Boolean);
}

// "XY path" (the first line may have lost its leading space) or "R  old -> new".
function changedPath(line) {
  const match = /^[ MADRCUT?!]{1,2}\s+(.+)$/.exec(line);
  return match ? match[1] : line;
}

// WORKTREE_DIRTY with the file names in `details`, which the update dialog shows after the label.
function dirtyError(changes) {
  const files = changes.map(changedPath);
  const shown = files.slice(0, MAX_LISTED_FILES).join('、');
  const error = new Error('WORKTREE_DIRTY');
  error.details = `${shown}${files.length > MAX_LISTED_FILES ? ` 等 ${files.length} 个文件` : ''}（在项目目录运行 git status 查看；确认不需要时可选择强制更新，修改会备份到 Git stash）`;
  return error;
}

// A force update preserves modifications in Git, never deletes them with clean/reset.
async function prepareWorkspace(execGit, force) {
  if (!force) {
    const changes = await trackedChanges(execGit);
    if (changes.length) throw dirtyError(changes);
    return null;
  }
  // Forcing also backs up untracked files, so the whole tree has to be clean afterwards.
  const dirty = await execGit(['status', '--porcelain']);
  if (!dirty) return null;
  // Runtime files must never be tracked, otherwise checkout/merge could replace them.
  const tracked = await execGit(['ls-files', '--', '.env', 'data', 'tasks', 'logs', 'node_modules']);
  if (tracked.trim()) throw new Error('TRACKED_RUNTIME_FILES');
  await execGit(['stash', 'push', '--include-untracked', '-m', `t-agent-before-update-${new Date().toISOString()}`]);
  const backup = (await execGit(['rev-parse', 'refs/stash'])).trim();
  if ((await execGit(['status', '--porcelain'])).trim()) throw new Error('WORKTREE_DIRTY');
  return backup;
}

module.exports = { prepareWorkspace, trackedChanges, dirtyError };
