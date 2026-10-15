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

// A remote repository + a code directory cloned into the workspace
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

test('List sub-directories of the workspace not managed by a task, ignoring hidden directories, files and managed directories', () => {
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

test('Bulk import only registers tasks and creates no files in the directories; paths not in the list are rejected', () => {
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

test('A task directory itself is not a repo: find the several repos inside it (within 3 levels), without entering repos or node_modules', () => {
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
  // When the task directory is itself a repo only it counts
  assert.deepEqual(tools.findRepos(path.join(task, 'api')), [path.join(task, 'api')]);
});

test('List and clean up repos per task in bulk: only safe repo directories are deleted, the task directory and other files are kept, and they can be restored', async () => {
  const root = temp();
  const task = path.join(root, 'task-one');
  fs.mkdirSync(path.join(task, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(task, 'notes.md'), 'keep me');
  const database = testDb();
  const taskId = database.prepare('INSERT INTO tasks (title, work_dir, user_id) VALUES (?, ?, ?)').run('Multi-repo task', task, 'u').lastInsertRowid;
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
  assert.ok(overview.items.every(item => item.task_id === taskId && item.title === 'Multi-repo task'));
  assert.equal(byName.clean.safe, true);
  assert.equal(byName.clean.remote, clean.remote);
  assert.ok(byName.clean.size_bytes > 0);
  assert.match(byName[path.join('sub', 'dirty')].reason, /uncommitted/);
  assert.match(byName.unpushed.reason, /unpushed/);

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

test('Protected directories (the working directory itself, a repo containing other tasks, the directory of this program) cannot be cleaned up', async () => {
  const root = temp();
  const database = testDb();
  const outer = repoIn(root, 'outer');
  fs.mkdirSync(path.join(outer.dir, 'nested'));
  const add = (title, dir) => database.prepare('INSERT INTO tasks (title, work_dir, user_id) VALUES (?, ?, ?)').run(title, dir, 'u').lastInsertRowid;
  // The task directory is itself a repo and also contains another task's directory
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
