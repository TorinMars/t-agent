// A force update preserves modifications in Git, never deletes them with clean/reset.
async function prepareWorkspace(execGit, force) {
  const dirty = await execGit(['status', '--porcelain']);
  if (!dirty) return null;
  if (!force) throw new Error('WORKTREE_DIRTY');
  // Runtime files must never be tracked, otherwise checkout/merge could replace them.
  const tracked = await execGit(['ls-files', '--', '.env', 'data', 'tasks', 'logs', 'node_modules', 'docker/engine.env']);
  if (tracked.trim()) throw new Error('TRACKED_RUNTIME_FILES');
  await execGit(['stash', 'push', '--include-untracked', '-m', `t-agent-before-update-${new Date().toISOString()}`]);
  const backup = (await execGit(['rev-parse', 'refs/stash'])).trim();
  if ((await execGit(['status', '--porcelain'])).trim()) throw new Error('WORKTREE_DIRTY');
  return backup;
}

module.exports = { prepareWorkspace };
