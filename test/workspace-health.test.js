const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const taskStore = require('../services/task-store');
const health = require('../services/workspace-health');

const roots = [];
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-health-'));
  roots.push(dir);
  return dir;
}
test.after(() => { for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true }); });

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();

// 一个“远程仓库 + 已克隆到工作目录的任务”，并把活动时间调到很久以前。
function repoTask(root, name, { age = 60 } = {}) {
  const remote = path.join(temp(), `${name}.git`);
  execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
  const seed = temp();
  git(seed, 'init', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'a.txt'), 'hello');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-u', 'origin', 'main');
  const dir = path.join(root, name);
  execFileSync('git', ['clone', '-b', 'main', remote, dir]);
  const store = taskStore.storeFor(root);
  store.invalidate();
  const task = store.listTasks().find(item => item.work_dir === dir);
  const old = new Date(Date.now() - age * 24 * 60 * 60 * 1000);
  const metaFile = path.join(dir, '.t-agent', 'task.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  meta.updated_at = old.toISOString();
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  for (const file of ['HEAD', 'index', 'FETCH_HEAD', path.join('logs', 'HEAD')]) {
    try { fs.utimesSync(path.join(dir, '.git', file), old, old); } catch { /* 部分文件可能不存在 */ }
  }
  store.invalidate();
  return { store, task, dir, remote };
}

test('工作目录里的文件、坏元信息、失效项目路径都会作为问题提示，且不覆盖坏元信息', async () => {
  const root = temp();
  fs.mkdirSync(path.join(root, 'good'));
  fs.mkdirSync(path.join(root, 'broken', '.t-agent'), { recursive: true });
  fs.writeFileSync(path.join(root, 'broken', '.t-agent', 'task.json'), '{ not json');
  fs.writeFileSync(path.join(root, 'stray.txt'), 'x');
  const store = taskStore.storeFor(root);
  const gone = path.join(temp(), 'gone-project');
  fs.mkdirSync(gone);
  store.createTask({ title: '会消失', work_dir: gone });
  fs.rmSync(gone, { recursive: true });
  store.invalidate();

  const types = store.getIssues().map(issue => issue.type).sort();
  assert.deepEqual(types, ['invalid-meta', 'missing-project', 'unexpected-file']);
  assert.deepEqual(store.listTasks().map(task => task.title), ['good']);
  assert.equal(fs.readFileSync(path.join(root, 'broken', '.t-agent', 'task.json'), 'utf8'), '{ not json');
  assert.throws(() => store.createTask({ work_dir: path.join(root, 'broken') }), /TASK_META_INVALID/);

  store.unregisterProject(gone);
  store.invalidate();
  assert.equal(store.getIssues().some(issue => issue.type === 'missing-project'), false);
});

test('长期闲置且全部已推送的仓库会被建议清理，有未提交/未推送的不会', async () => {
  const root = temp();
  const clean = repoTask(root, 'clean-repo');
  const dirty = repoTask(root, 'dirty-repo');
  const unpushed = repoTask(root, 'unpushed-repo');
  const recent = repoTask(root, 'recent-repo', { age: 1 });
  fs.writeFileSync(path.join(dirty.dir, 'new.txt'), 'uncommitted');
  fs.writeFileSync(path.join(unpushed.dir, 'b.txt'), 'b');
  git(unpushed.dir, 'add', '.');
  git(unpushed.dir, 'commit', '-m', 'local only');
  // 提交会刷新 Git 文件时间，再调回去
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  for (const item of [dirty, unpushed]) for (const file of ['HEAD', 'index', 'logs/HEAD']) { try { fs.utimesSync(path.join(item.dir, '.git', file), old, old); } catch { /* 忽略 */ } }

  const report = await health.health(clean.store, 30);
  assert.deepEqual(report.stale.map(item => item.title), ['clean-repo']);
  assert.equal(report.stale[0].remote, clean.remote);
  assert.equal(report.stale[0].branch, 'main');
  assert.ok(report.stale[0].idle_days >= 59);
  assert.equal((await health.inspectRepository(dirty.dir)).safe, false);
  assert.match((await health.inspectRepository(unpushed.dir)).reason, /未推送/);
  assert.equal(recent.store.listTasks().length, 4);
});

test('清理只删本地文件并记档案，之后可从仓库恢复且保留任务 ID 和待办', async () => {
  const root = temp();
  const { store, task, dir } = repoTask(root, 'to-archive');
  store.createTodo(task.id, '别丢了我');

  await assert.rejects(() => health.removeLocalRepository(store, 999), /TASK_NOT_FOUND/);
  const item = await health.removeLocalRepository(store, task.id);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(store.getTask(task.id), null);
  assert.equal(health.readArchive(store)[0].id, task.id);
  assert.match(item.restore, /^git clone -b main /);

  const restored = await health.restoreRepository(store, task.id);
  assert.equal(restored.id, task.id);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'hello');
  assert.equal(store.listTodos(task.id)[0].content, '别丢了我');
  assert.deepEqual(health.readArchive(store), []);
});

test('有未提交修改时拒绝清理，目录原样保留', async () => {
  const root = temp();
  const { store, task, dir } = repoTask(root, 'refuse');
  fs.writeFileSync(path.join(dir, 'wip.txt'), 'work in progress');
  await assert.rejects(() => health.removeLocalRepository(store, task.id), /REPOSITORY_NOT_SAFE_TO_DELETE/);
  assert.equal(fs.existsSync(path.join(dir, 'wip.txt')), true);
});
