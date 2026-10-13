const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const tools = require('../services/workspace-tools');

const roots = [];
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-tools-'));
  roots.push(dir);
  return dir;
}
test.after(() => { for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true }); });

function testDb() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'normal', due_date TEXT, md_path TEXT, work_dir TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
      user_id TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE repo_cleanups (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, path TEXT NOT NULL UNIQUE, remote TEXT NOT NULL,
      branch TEXT NOT NULL, commit_sha TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0, cleaned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
  `);
  return database;
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();

// 远程仓库 + 克隆到工作目录的代码目录
function repoIn(root, name) {
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
  return { dir, remote };
}

test('列出工作目录下未被任务管理的子目录，忽略隐藏目录、文件和已管理的目录', () => {
  const root = temp();
  const database = testDb();
  for (const name of ['managed', 'free-a', 'free-b', '.hidden', 'node_modules']) fs.mkdirSync(path.join(root, name));
  fs.mkdirSync(path.join(root, 'parent', 'inner'), { recursive: true });
  fs.writeFileSync(path.join(root, 'file.txt'), 'x');
  database.prepare('INSERT INTO tasks (title, work_dir, user_id) VALUES (?, ?, ?)').run('m', path.join(root, 'managed'), 'u');
  database.prepare('INSERT INTO tasks (title, work_dir, user_id) VALUES (?, ?, ?)').run('p', path.join(root, 'parent', 'inner'), 'u');
  database.prepare('INSERT INTO tasks (title, work_dir, user_id) VALUES (?, ?, ?)').run('other user', path.join(root, 'free-b'), 'someone');

  const result = tools.listUnmanaged(database, 'u', root);
  assert.deepEqual(result.items.map(item => item.name), ['free-a', 'free-b']);
});

test('批量导入只登记任务，不在目录里生成文件；不在列表里的路径被拒绝', () => {
  const root = temp();
  const database = testDb();
  fs.mkdirSync(path.join(root, 'one'));
  fs.mkdirSync(path.join(root, 'two'));
  const created = tools.importDirs(database, 'u', root, [path.join(root, 'one'), path.join(root, 'two')]);
  assert.deepEqual(created.map(task => task.title), ['one', 'two']);
  assert.equal(created[0].status, 'todo');
  assert.equal(created[0].md_path, path.join(root, 'one', 'DESIGN.md'));
  assert.deepEqual(fs.readdirSync(path.join(root, 'one')), []);
  assert.equal(tools.listUnmanaged(database, 'u', root).items.length, 0);

  assert.throws(() => tools.importDirs(database, 'u', root, [os.tmpdir()]), /PATH_NOT_IMPORTABLE/);
  assert.throws(() => tools.importDirs(database, 'u', root, [path.join(root, 'one')]), /PATH_NOT_IMPORTABLE/);
  assert.throws(() => tools.importDirs(database, 'u', root, []), /PATHS_REQUIRED/);
});

test('任务目录本身不是仓库：找出其中（3 层内）的多个仓库，不进入仓库内部和 node_modules', () => {
  const task = temp();
  repoIn(task, 'api');
  fs.mkdirSync(path.join(task, 'group'));
  repoIn(path.join(task, 'group'), 'web');
  fs.mkdirSync(path.join(task, 'a', 'b', 'c', 'too-deep'), { recursive: true });
  execFileSync('git', ['init', '-q', path.join(task, 'a', 'b', 'c', 'too-deep')]);
  fs.mkdirSync(path.join(task, 'node_modules', 'pkg'), { recursive: true });
  execFileSync('git', ['init', '-q', path.join(task, 'node_modules', 'pkg')]);
  fs.mkdirSync(path.join(task, 'api', 'vendor', 'inner'), { recursive: true });
  execFileSync('git', ['init', '-q', path.join(task, 'api', 'vendor', 'inner')]);
  fs.mkdirSync(path.join(task, 'docs'));
  assert.deepEqual(tools.findRepos(task), [path.join(task, 'api'), path.join(task, 'group', 'web')]);
  // 任务目录自己就是仓库时只算它自己
  assert.deepEqual(tools.findRepos(path.join(task, 'api')), [path.join(task, 'api')]);
});

test('按任务下的仓库列出和批量清理：只删安全的仓库目录，任务目录和其他文件保留，可恢复', async () => {
  const root = temp();
  const task = path.join(root, 'task-one');
  fs.mkdirSync(path.join(task, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(task, 'notes.md'), 'keep me');
  const database = testDb();
  const taskId = database.prepare('INSERT INTO tasks (title, work_dir, user_id) VALUES (?, ?, ?)').run('多仓库任务', task, 'u').lastInsertRowid;
  const clean = repoIn(task, 'clean');
  const dirty = repoIn(path.join(task, 'sub'), 'dirty');
  fs.writeFileSync(path.join(dirty.dir, 'wip.txt'), 'uncommitted');
  const unpushed = repoIn(task, 'unpushed');
  fs.writeFileSync(path.join(unpushed.dir, 'b.txt'), 'b');
  git(unpushed.dir, 'add', '.');
  git(unpushed.dir, 'commit', '-m', 'local only');

  const overview = await tools.cleanupOverview(database, 'u', root);
  const byName = Object.fromEntries(overview.items.map(item => [item.name, item]));
  assert.deepEqual(Object.keys(byName).sort(), ['clean', path.join('sub', 'dirty'), 'unpushed']);
  assert.ok(overview.items.every(item => item.task_id === taskId && item.title === '多仓库任务'));
  assert.equal(byName.clean.safe, true);
  assert.equal(byName.clean.remote, clean.remote);
  assert.ok(byName.clean.size_bytes > 0);
  assert.match(byName[path.join('sub', 'dirty')].reason, /未提交/);
  assert.match(byName.unpushed.reason, /未推送/);

  const outsider = repoIn(root, 'outsider');
  const closed = [];
  const results = await tools.cleanupRepos(database, 'u', root, [
    { task_id: taskId, path: clean.dir },
    { task_id: taskId, path: dirty.dir },
    { task_id: taskId, path: unpushed.dir },
    { task_id: taskId, path: outsider.dir },
    { task_id: 999, path: clean.dir },
  ], id => closed.push(id));
  assert.deepEqual(results.map(item => item.ok), [true, false, false, false, false]);
  assert.equal(results[3].error, 'NOT_A_REPOSITORY_OF_TASK');
  assert.equal(fs.existsSync(clean.dir), false);
  assert.equal(fs.existsSync(path.join(dirty.dir, 'wip.txt')), true);
  assert.equal(fs.existsSync(unpushed.dir), true);
  assert.equal(fs.existsSync(outsider.dir), true);
  assert.equal(fs.readFileSync(path.join(task, 'notes.md'), 'utf8'), 'keep me');
  assert.equal(database.prepare('SELECT COUNT(*) c FROM tasks').get().c, 1);
  assert.deepEqual(closed, [taskId]);

  const after = await tools.cleanupOverview(database, 'u', root);
  assert.equal(after.items.some(item => item.name === 'clean'), false);
  assert.match(after.archived[0].restore, /^git clone -b main /);
  await tools.restoreRepo(database, 'u', after.archived[0].id);
  assert.equal(fs.readFileSync(path.join(clean.dir, 'a.txt'), 'utf8'), 'hello');
  assert.equal((await tools.cleanupOverview(database, 'u', root)).archived.length, 0);
});

test('受保护的目录（工作目录本身、包含其他任务的仓库、本程序所在目录）不能被清理', async () => {
  const root = temp();
  const database = testDb();
  const outer = repoIn(root, 'outer');
  fs.mkdirSync(path.join(outer.dir, 'nested'));
  const add = (title, dir) => database.prepare('INSERT INTO tasks (title, work_dir, user_id) VALUES (?, ?, ?)').run(title, dir, 'u').lastInsertRowid;
  // 任务目录自己就是仓库，且里面还有另一个任务的目录
  const outerId = add('outer', outer.dir);
  add('inner', path.join(outer.dir, 'nested'));
  const appId = add('app', path.resolve(__dirname, '..'));

  const results = await tools.cleanupRepos(database, 'u', root, [
    { task_id: outerId, path: outer.dir },
    { task_id: appId, path: path.resolve(__dirname, '..') },
  ]);
  assert.ok(results.every(item => item.ok === false));
  assert.equal(results[0].error, 'NOT_SAFE_TO_DELETE');
  assert.equal(fs.existsSync(outer.dir), true);
});
