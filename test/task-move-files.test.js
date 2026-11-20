// The file side of moving a task (lib/task-move-files.js, "Move a task to another machine" in docs/design/task-move.md): the scan and manifest,
// the path rules, writing and verifying a copy, the journal and the trash sweeper with a fake clock. Only temporary folders are touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-move-files-data-'));
const files = require('../lib/task-move-files');

const ZH = '\u7b14\u8bb0'; // a file name in Chinese is copied as it is
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function temp(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `t-agent-move-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// A task folder: nested folders, a hidden file, a .git folder, an executable, a relative and an absolute link (one into the folder, one out of it).
function sampleFolder(root) {
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# Notes\n');
  fs.writeFileSync(path.join(root, '.env.example'), 'A=1\n');
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(root, 'src', 'deep', `${ZH}.txt`), 'hello');
  fs.writeFileSync(path.join(root, 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
  fs.chmodSync(path.join(root, 'run.sh'), 0o755);
  fs.writeFileSync(path.join(root, 'empty'), '');
  fs.symlinkSync('src/deep', path.join(root, 'shortcut'));
  fs.symlinkSync(path.join(root, 'README.md'), path.join(root, 'abs-inside'));
  fs.symlinkSync('/etc/hosts', path.join(root, 'abs-outside'));
  fs.utimesSync(path.join(root, 'README.md'), 1_700_000_000, 1_700_000_000);
}

test('scan: every entry once, parents first, links as links (never followed), sizes and modes; a socket is skipped', async t => {
  const root = temp(t, 'scan');
  sampleFolder(root);
  const scan = files.scanFolder(root);
  const byPath = new Map(scan.entries.map(entry => [entry.p, entry]));
  assert.equal(byPath.get('shortcut').t, 'l');
  assert.equal(byPath.get('shortcut').l, 'src/deep');
  assert.equal(byPath.get('abs-outside').l, '/etc/hosts', 'the text of a link, not what it points to');
  assert.ok(!scan.entries.some(entry => entry.p.startsWith('shortcut/')), 'a link to a folder is not walked into');
  assert.equal(byPath.get('run.sh').m & 0o777, 0o755);
  assert.equal(byPath.get('.git/HEAD').t, 'f', 'hidden files and .git are part of the folder');
  assert.equal(byPath.get(`src/deep/${ZH}.txt`).s, 5);
  assert.equal(byPath.get('README.md').mt, 1_700_000_000_000);
  const order = scan.entries.map(entry => entry.p);
  assert.ok(order.indexOf('src') < order.indexOf('src/deep') && order.indexOf('src/deep') < order.indexOf(`src/deep/${ZH}.txt`));
  assert.deepEqual(scan.totals, { files: 6, dirs: 4, links: 3, bytes: scan.entries.reduce((sum, entry) => sum + entry.s, 0) });
  // A socket: not copied, named.
  const net = require('node:net');
  const socketPath = path.join(root, 's.sock');
  const server = net.createServer();
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => server.close());
  const again = files.scanFolder(root);
  assert.deepEqual(again.skipped.map(item => item.p), ['s.sock']);
  // Limits stop the scan early.
  assert.equal(files.scanFolder(root, { maxFiles: 3 }).truncated, 'files');
  assert.equal(files.scanFolder(root, { maxBytes: 4 }).truncated, 'bytes');
  assert.throws(() => files.scanFolder(path.join(root, 'shortcut')), /MOVE_NOT_A_FOLDER/, 'a link is not a folder to move');
});

test('manifest: SHA-256 of every file; a file that changed size or became a link is refused', async t => {
  const root = temp(t, 'hash');
  sampleFolder(root);
  const scan = files.scanFolder(root);
  await files.hashEntries(root, scan.entries);
  const readme = scan.entries.find(entry => entry.p === 'README.md');
  assert.equal(readme.h, sha('# Notes\n'));
  assert.equal(scan.entries.find(entry => entry.p === 'empty').h, sha(''));
  fs.appendFileSync(path.join(root, 'README.md'), 'more');
  await assert.rejects(files.hashFile(path.join(root, 'README.md'), { expectedSize: readme.s }), /MOVE_FILE_CHANGED/);
  assert.throws(() => files.openChecked(path.join(root, 'abs-inside')), error => ['ELOOP', 'EMLINK'].includes(error.code) || /MOVE_FILE_CHANGED/.test(error.message), 'a link is never opened');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(files.hashFile(path.join(root, 'run.sh'), { signal: controller.signal }), /MOVE_CANCELLED/);
});

test('path rules: a manifest path cannot leave the folder; the folder name is one plain segment; the target folder stays in the tasks folder', t => {
  for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'a//b', './a', 'a/.', 'a\\b', 'a\0b', `${'x'.repeat(256)}`]) {
    assert.throws(() => files.safeRelative(bad), /MOVE_BAD_PATH/, JSON.stringify(bad).slice(0, 40));
  }
  assert.deepEqual(files.safeRelative(`src/${ZH}.txt`), ['src', `${ZH}.txt`]);
  assert.equal(files.joinInside('/base', 'a/b'), path.join('/base', 'a', 'b'));
  for (const bad of ['', '.', '..', '.hidden', 'a/b', 'a\\b', ' a', 'a ', 'x\u0001']) assert.throws(() => files.checkFolderName(bad), /MOVE_BAD_FOLDER_NAME/, bad);
  const base = temp(t, 'base');
  fs.mkdirSync(path.join(base, 'notes'));
  fs.mkdirSync(path.join(base, 'notes-2'));
  assert.equal(files.targetFolder(base, 'notes'), path.join(base, 'notes-3'), 'a free name next to the taken ones');
  assert.equal(files.targetFolder(base, ZH), path.join(base, ZH));
  assert.throws(() => files.targetFolder(base, '../escape'), /MOVE_BAD_FOLDER_NAME/);
});

test('copy and verify: the skeleton, links re-pointed only when absolute into the old folder, modes and times; any difference is found', async t => {
  const root = temp(t, 'src');
  sampleFolder(root);
  const scan = files.scanFolder(root);
  await files.hashEntries(root, scan.entries);
  const base = temp(t, 'dst');
  const copy = path.join(base, 'copy');
  const newDir = path.join(base, 'notes');
  files.createSkeleton(copy, scan.entries, { fromDirs: [root], toDir: newDir });
  for (const entry of scan.entries.filter(item => item.t === 'f')) fs.copyFileSync(path.join(root, entry.p), path.join(copy, entry.p));
  files.applyMeta(copy, scan.entries, { m: scan.mode, mt: scan.mt });
  assert.deepEqual(await files.verifyCopy(copy, scan.entries, { fromDirs: [root], toDir: newDir }), []);
  assert.equal(fs.readlinkSync(path.join(copy, 'abs-inside')), path.join(newDir, 'README.md'));
  assert.equal(fs.readlinkSync(path.join(copy, 'abs-outside')), '/etc/hosts');
  assert.equal(fs.readlinkSync(path.join(copy, 'shortcut')), 'src/deep');
  assert.equal(fs.statSync(path.join(copy, 'run.sh')).mode & 0o777, 0o755);
  assert.equal(Math.round(fs.statSync(path.join(copy, 'README.md')).mtimeMs), 1_700_000_000_000);
  // A changed byte, a missing file and an extra file are all named.
  fs.writeFileSync(path.join(copy, 'README.md'), '# Nates\n');
  fs.utimesSync(path.join(copy, 'README.md'), 1_700_000_000, 1_700_000_000);
  fs.unlinkSync(path.join(copy, 'empty'));
  fs.writeFileSync(path.join(copy, 'extra'), 'x');
  const problems = await files.verifyCopy(copy, scan.entries, { fromDirs: [root], toDir: newDir });
  assert.ok(problems.some(line => line.startsWith('README.md: SHA-256 differs')), problems.join('\n'));
  assert.ok(problems.includes('empty: missing'));
  assert.ok(problems.includes('extra: not in the manifest'));
  assert.equal(files.movedLink(`${root}/a/b`, [root], '/new'), '/new/a/b');
  assert.equal(files.movedLink(`${root}-other/x`, [root], '/new'), `${root}-other/x`, 'a sibling with the same prefix is not inside');
});

test('journal: atomic records, read back after a "restart", a bad id refused', t => {
  const dir = temp(t, 'journal');
  const journal = files.createJournal(path.join(dir, 'task-moves'));
  const id = crypto.randomUUID();
  journal.write({ id, role: 'source', state: 'preparing' });
  journal.update(id, { state: 'offered' });
  const again = files.createJournal(path.join(dir, 'task-moves'));
  assert.equal(again.read(id).state, 'offered');
  assert.deepEqual(again.all().map(record => record.id), [id]);
  fs.writeFileSync(path.join(dir, 'task-moves', `${id}.json.123.tmp`), '{"half');
  assert.equal(again.all().length, 1, 'a half-written temporary file is not a record');
  assert.throws(() => again.read('../../etc/passwd'), /MOVE_NOT_FOUND/);
  again.remove(id);
  assert.equal(again.read(id), null);
});

test('trash sweeper (fake clock): an entry older than 7 days goes, a newer one stays; a folder kept elsewhere goes only with a name of ours; links are not followed', t => {
  const data = temp(t, 'trash');
  const trash = path.join(data, 'trash');
  const t0 = Date.UTC(2026, 10, 1);
  const make = (name, movedAt, extra = {}) => {
    fs.mkdirSync(path.join(trash, name, 'folder'), { recursive: true });
    fs.writeFileSync(path.join(trash, name, 'folder', 'f.txt'), 'x');
    fs.writeFileSync(path.join(trash, name, 'moved.json'), JSON.stringify({ moved_at: movedAt, ...extra }));
  };
  const outside = temp(t, 'outside');
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
  make('moved-1-100', t0);
  make('moved-2-200', t0 + 6 * 24 * 3600 * 1000);
  fs.symlinkSync(outside, path.join(trash, 'moved-1-100', 'folder', 'link-out'));
  const elsewhere = path.join(outside, '.t-agent-trash-moved-3-300');
  fs.mkdirSync(elsewhere);
  make('moved-3-300', t0, { elsewhere });
  make('moved-4-400', t0, { elsewhere: outside }); // a name that is not ours: the folder it names stays
  fs.mkdirSync(path.join(trash, 'not-ours'));
  const removed = files.sweepTrash(trash, { now: t0 + 7 * 24 * 3600 * 1000 + 1 });
  assert.deepEqual(removed.sort(), ['moved-1-100', 'moved-3-300', 'moved-4-400']);
  assert.ok(fs.existsSync(path.join(trash, 'moved-2-200')), 'six days old: kept');
  assert.ok(fs.existsSync(path.join(trash, 'not-ours')), 'only names this code gives');
  assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'keep me', 'a link inside the trash is removed, not followed');
  assert.ok(!fs.existsSync(elsewhere));
  assert.ok(fs.existsSync(outside));
  assert.deepEqual(files.sweepTrash(trash, { now: t0 + 6 * 24 * 3600 * 1000 }), [], 'nothing is due yet');
});

test('free space is known for a folder that does not exist yet (its nearest parent)', t => {
  const dir = temp(t, 'free');
  const free = files.freeBytes(path.join(dir, 'a', 'b', 'c'));
  assert.ok(free === null || free > 0);
});
