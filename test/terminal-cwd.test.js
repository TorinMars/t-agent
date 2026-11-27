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

test('parseLsofCwd undoes the escapes lsof prints outside a UTF-8 locale and for special characters', () => {
  assert.equal(parseLsofCwd('p123\nfcwd\nn/a/\\xe9\\x9c\\x80\\xe6\\xb1\\x82/b\n'), '/a/需求/b', 'bytes of one character');
  assert.equal(parseLsofCwd('p1\nfcwd\nn/Users/torin/main/02_agent/\\xe9\\x9c\\x80\\xe6\\xb1\\x82-\\xe6\\xac\\xa2\\xe8\\xbf\\x8enotice\n'), '/Users/torin/main/02_agent/需求-欢迎notice', 'several characters and ASCII between');
  assert.equal(parseLsofCwd('p1\nfcwd\nn/a/\\xe8\\xae\\xbe\\xe8\\xae\\xa1/\\xe9\\x9c\\x80\n'), '/a/设计/需', 'escaped runs on both sides of a slash');
  assert.equal(parseLsofCwd('p1\nfcwd\nn/a/with\\\\backslash\n'), '/a/with\\backslash', 'a backslash is doubled');
  assert.equal(parseLsofCwd('p1\nfcwd\nn/a/tab\\there\n'), '/a/tab\there');
  assert.equal(parseLsofCwd('p1\nfcwd\nn/a/ctl\\^Ax\n'), '/a/ctl\x01x');
  assert.equal(parseLsofCwd('p1\nfcwd\nn/a/plain \\q dir\n'), '/a/plain \\q dir', 'an unknown escape stays as it is');
  assert.equal(parseLsofCwd('p1\nfcwd\nn/a/\\xe9\n'), '/a/\ufffd', 'a lone byte of a UTF-8 sequence is not valid text');
});

test('processCwd asks lsof in a UTF-8 locale', async () => {
  let seen = null;
  const run = (cmd, args, options, callback) => { seen = options; callback(null, 'p42\nfcwd\nn/a/b\n'); };
  assert.equal(await processCwd(42, { platform: 'darwin', run }), '/a/b');
  assert.equal(seen.env.LC_ALL, 'en_US.UTF-8');
  assert.equal(seen.env.PATH, process.env.PATH, 'the rest of the environment is kept');
});

test('processCwd reads a Chinese directory through the real lsof even when this process runs under LC_ALL=C', { skip: process.platform !== 'darwin' }, async () => {
  const dir = path.join(root, 'live', '需求-欢迎语');
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { cwd: dir, stdio: 'ignore' });
  const old = process.env.LC_ALL;
  process.env.LC_ALL = 'C';
  try {
    await new Promise(resolve => child.once('spawn', resolve));
    assert.equal(await processCwd(child.pid), dir);
  } finally {
    if (old === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = old;
    child.kill();
  }
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
