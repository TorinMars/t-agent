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
    CREATE TABLE task_cleanups (task_id INTEGER PRIMARY KEY, path TEXT NOT NULL, remote TEXT NOT NULL, branch TEXT NOT NULL,
      commit_sha TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0, cleaned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
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

test('清理列表标出能否安全删除，批量清理只处理安全的并记档案', async () => {
  const root = temp();
  const database = testDb();
  const clean = repoIn(root, 'clean');
  const dirty = repoIn(root, 'dirty');
  fs.writeFileSync(path.join(dirty.dir, 'wip.txt'), 'uncommitted');
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'f.txt'), 'not a repo');
  const add = (title, dir) => database.prepare('INSERT INTO tasks (title, work_dir, user_id) VALUES (?, ?, ?)').run(title, dir, 'u').lastInsertRowid;
  const cleanId = add('clean', clean.dir);
  const dirtyId = add('dirty', dirty.dir);
  const plainId = add('plain', plain);

  const overview = await tools.cleanupOverview(database, 'u', root);
  const byId = Object.fromEntries(overview.items.map(item => [item.task_id, item]));
  assert.equal(byId[cleanId].safe, true);
  assert.equal(byId[cleanId].remote, clean.remote);
  assert.ok(byId[cleanId].size_bytes > 0);
  assert.equal(byId[dirtyId].safe, false);
  assert.match(byId[dirtyId].reason, /未提交/);
  assert.match(byId[plainId].reason, /不是 Git 仓库/);

  const closed = [];
  const results = await tools.cleanupTasks(database, 'u', root, [cleanId, dirtyId, plainId, 999], id => closed.push(id));
  assert.deepEqual(results.map(item => [item.task_id, item.ok]), [[cleanId, true], [dirtyId, false], [plainId, false], [999, false]]);
  assert.equal(fs.existsSync(clean.dir), false);
  assert.equal(fs.existsSync(path.join(dirty.dir, 'wip.txt')), true);
  assert.equal(fs.existsSync(path.join(plain, 'f.txt')), true);
  assert.deepEqual(closed, [cleanId]);
  assert.equal(database.prepare('SELECT COUNT(*) c FROM tasks').get().c, 3);

  const after = await tools.cleanupOverview(database, 'u', root);
  assert.equal(after.items.some(item => item.task_id === cleanId), false);
  assert.equal(after.archived[0].task_id, cleanId);
  assert.match(after.archived[0].restore, /^git clone -b main /);

  await tools.restoreTask(database, 'u', cleanId);
  assert.equal(fs.readFileSync(path.join(clean.dir, 'a.txt'), 'utf8'), 'hello');
  assert.equal((await tools.cleanupOverview(database, 'u', root)).archived.length, 0);
});

test('受保护的目录（工作目录本身、包含其他任务的目录、本程序所在目录）不能被清理', async () => {
  const root = temp();
  const database = testDb();
  const outer = repoIn(root, 'outer');
  fs.mkdirSync(path.join(outer.dir, 'nested'));
  const add = (title, dir) => database.prepare('INSERT INTO tasks (title, work_dir, user_id) VALUES (?, ?, ?)').run(title, dir, 'u').lastInsertRowid;
  const outerId = add('outer', outer.dir);
  add('inner', path.join(outer.dir, 'nested'));
  const appId = add('app', path.resolve(__dirname, '..'));
  const rootId = add('root', root);

  const results = await tools.cleanupTasks(database, 'u', root, [outerId, appId, rootId]);
  assert.ok(results.every(item => item.ok === false && item.error === 'NOT_SAFE_TO_DELETE'));
  assert.equal(fs.existsSync(outer.dir), true);
});
