// The live current directory of a terminal shell (lib/terminal-cwd.js), used by terminal file links when the shell sends no OSC 7.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { processCwd, parseLsofCwd, cwdInRoot } = require('../lib/terminal-cwd');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-cwd-')));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('parseLsofCwd reads the name field', () => {
  assert.equal(parseLsofCwd('p123\nfcwd\nn/Users/me/my dir\n'), '/Users/me/my dir');
  assert.equal(parseLsofCwd('p123\nfcwd\nn/work/设计\n'), '/work/设计');
  assert.equal(parseLsofCwd(''), null);
  assert.equal(parseLsofCwd('p1\nfcwd\nnrelative\n'), null);
});

test('cwdInRoot compares real paths and refuses symbolic links out of the root', () => {
  const work = path.join(root, 'work');
  const sub = path.join(work, '子 dir');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(work, 'escape'));
  fs.symlinkSync(work, path.join(root, 'work-link'));
  assert.equal(cwdInRoot(work, work), '');
  assert.equal(cwdInRoot(sub, work), '子 dir');
  assert.equal(cwdInRoot(sub, path.join(root, 'work-link')), '子 dir', 'a root reached through a link');
  assert.equal(cwdInRoot(path.join(work, 'escape'), work), null, 'a link out of the root');
  assert.equal(cwdInRoot(outside, work), null);
  assert.equal(cwdInRoot(root, work), null, 'the parent');
  assert.equal(cwdInRoot(path.join(root, 'workx'), work), null, 'missing');
  assert.equal(cwdInRoot('relative', work), null);
  assert.equal(cwdInRoot(sub, null), null);
});

test('processCwd reads the directory of a running process', { skip: !['darwin', 'linux'].includes(process.platform) }, async () => {
  const dir = path.join(root, 'live', '设计');
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { cwd: dir, stdio: 'ignore' });
  try {
    await new Promise(resolve => child.once('spawn', resolve));
    assert.equal(await processCwd(child.pid), dir);
  } finally { child.kill(); }
  assert.equal(await processCwd(0), null);
  assert.equal(await processCwd('x'), null);
  assert.equal(await processCwd(2 ** 22 + 12345), null, 'no such process');
});

test('processCwd gives null when lsof fails or prints nothing', async () => {
  const run = output => (cmd, args, options, callback) => { assert.equal(cmd, 'lsof'); assert.deepEqual(args, ['-a', '-d', 'cwd', '-p', '42', '-Fn']); callback(output ? null : new Error('ENOENT'), output || ''); };
  assert.equal(await processCwd(42, { platform: 'darwin', run: run('') }), null);
  assert.equal(await processCwd(42, { platform: 'darwin', run: run('p42\nfcwd\nn/a/b\n') }), '/a/b');
});
