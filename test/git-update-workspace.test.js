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
