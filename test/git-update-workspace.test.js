const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prepareWorkspace } = require('../lib/git-update-workspace');

test('force update backs up staged, unstaged and untracked files without touching ignored data', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'git-force-update-'));
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    git(['init', '-q']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.com']);
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.env\ndata/\n');
    fs.writeFileSync(path.join(cwd, 'app.js'), 'original');
    git(['add', '.']); git(['commit', '-qm', 'initial']);
    fs.writeFileSync(path.join(cwd, 'app.js'), 'staged'); git(['add', 'app.js']);
    fs.writeFileSync(path.join(cwd, 'app.js'), 'unstaged');
    fs.writeFileSync(path.join(cwd, 'notes.txt'), 'personal');
    fs.writeFileSync(path.join(cwd, '.env'), 'private');
    fs.mkdirSync(path.join(cwd, 'data'));
    fs.writeFileSync(path.join(cwd, 'data', 'db.sqlite'), 'database');
    await assert.rejects(prepareWorkspace(async args => git(args), false), /WORKTREE_DIRTY/);
    const backup = await prepareWorkspace(async args => git(args), true);
    assert.match(backup, /^[a-f0-9]{40}$/);
    assert.equal(git(['status', '--porcelain']), '');
    assert.equal(fs.readFileSync(path.join(cwd, 'app.js'), 'utf8'), 'original');
    assert.equal(fs.readFileSync(path.join(cwd, '.env'), 'utf8'), 'private');
    assert.equal(fs.readFileSync(path.join(cwd, 'data', 'db.sqlite'), 'utf8'), 'database');
    git(['stash', 'apply', '--index', backup]);
    assert.equal(fs.readFileSync(path.join(cwd, 'app.js'), 'utf8'), 'unstaged');
    assert.equal(git(['show', ':app.js']), 'staged');
    assert.equal(fs.readFileSync(path.join(cwd, 'notes.txt'), 'utf8'), 'personal');
    git(['add', '-f', '.env']);
    await assert.rejects(prepareWorkspace(async args => git(args), true), /TRACKED_RUNTIME_FILES/);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

const { trackedChanges } = require('../lib/git-update-workspace');

function repo(prefix = 'git-update-') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = (args, options = {}) => execFileSync('git', args, { cwd: options.cwd || cwd, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.env\ndata/\n');
  fs.writeFileSync(path.join(cwd, 'app.js'), 'original');
  git(['add', '.']); git(['commit', '-qm', 'initial']);
  return { cwd, git, exec: async args => git(args), cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

test('untracked files alone do not block an update, modified tracked files do', async () => {
  const r = repo();
  try {
    // 一键安装的服务器上常见的杂文件：没被忽略但也没被跟踪。
    fs.writeFileSync(path.join(r.cwd, '.DS_Store'), 'x');
    fs.writeFileSync(path.join(r.cwd, 'nohup.out'), 'log');
    fs.mkdirSync(path.join(r.cwd, '.claude'));
    fs.writeFileSync(path.join(r.cwd, '.claude', 'settings.local.json'), '{}');
    assert.ok(r.git(['status', '--porcelain']).length > 0, '旧的判定会把它们当成未提交修改');
    assert.deepEqual(await trackedChanges(r.exec), []);
    assert.equal(await prepareWorkspace(r.exec, false), null);
    assert.equal(fs.existsSync(path.join(r.cwd, '.DS_Store')), true, '没有动这些文件');

    fs.writeFileSync(path.join(r.cwd, 'app.js'), 'edited');
    await assert.rejects(prepareWorkspace(r.exec, false), error => {
      assert.equal(error.message, 'WORKTREE_DIRTY');
      assert.match(error.details, /app\.js/);
      assert.doesNotMatch(error.details, /DS_Store|nohup/, '只列出真正阻止更新的被跟踪文件');
      return true;
    });
  } finally { r.cleanup(); }
});

test('the dirty-file list shows paths even when git status trims the first line, and caps long lists', async () => {
  const r = repo();
  try {
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(r.cwd, `f${i}.js`), 'v1');
    r.git(['add', '.']); r.git(['commit', '-qm', 'many']);
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(r.cwd, `f${i}.js`), 'v2');
    // 模拟 runUpdateCommand 去掉输出首尾空白：第一行 " M f0.js" 变成 "M f0.js"。
    const trimmed = async args => r.git(args).trim();
    await assert.rejects(prepareWorkspace(trimmed, false), error => {
      assert.match(error.details, /^f0\.js、f1\.js/);
      assert.match(error.details, /等 12 个文件/);
      assert.ok(!/M f0/.test(error.details));
      return true;
    });
  } finally { r.cleanup(); }
});

test('git itself refuses to overwrite a colliding untracked file during the fast-forward merge', async () => {
  const origin = repo('git-origin-');
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'git-clone-'));
  const git = args => execFileSync('git', args, { cwd: clone, encoding: 'utf8' }).trim();
  try {
    execFileSync('git', ['clone', '-q', origin.cwd, clone]);
    fs.writeFileSync(path.join(origin.cwd, 'new-feature.js'), 'from upstream');
    origin.git(['add', '.']); origin.git(['commit', '-qm', 'upstream adds a file']);
    git(['fetch', '-q', 'origin']);

    fs.writeFileSync(path.join(clone, 'unrelated-note.txt'), 'keep me');
    assert.equal(await prepareWorkspace(async args => git(args), false), null);
    git(['merge', '--ff-only', '--no-overwrite-ignore', 'origin/main']);
    assert.equal(fs.readFileSync(path.join(clone, 'new-feature.js'), 'utf8'), 'from upstream');
    assert.equal(fs.readFileSync(path.join(clone, 'unrelated-note.txt'), 'utf8'), 'keep me', '不冲突的未跟踪文件原样保留');

    fs.writeFileSync(path.join(origin.cwd, 'collide.js'), 'upstream version');
    origin.git(['add', '.']); origin.git(['commit', '-qm', 'upstream adds collide.js']);
    git(['fetch', '-q', 'origin']);
    fs.writeFileSync(path.join(clone, 'collide.js'), 'my local file');
    assert.equal(await prepareWorkspace(async args => git(args), false), null, '预检查放行');
    assert.throws(() => git(['merge', '--ff-only', '--no-overwrite-ignore', 'origin/main']), /would be overwritten|untracked/i);
    assert.equal(fs.readFileSync(path.join(clone, 'collide.js'), 'utf8'), 'my local file', '冲突时合并被 git 拒绝，本地文件没有被覆盖');
  } finally { origin.cleanup(); fs.rmSync(clone, { recursive: true, force: true }); }
});
