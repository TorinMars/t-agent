const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const taskFiles = require('../services/task-files');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-files-'));
  return {
    root,
    task: { work_dir: root, md_path: path.join(root, 'DESIGN.md') },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('lists directories first with stable paging and an explicit hidden-file toggle', t => {
  const current = fixture();
  t.after(current.cleanup);
  fs.mkdirSync(path.join(current.root, 'z-dir'));
  fs.writeFileSync(path.join(current.root, '.secret'), 'hidden');
  for (let index = 0; index < 202; index += 1) {
    fs.writeFileSync(path.join(current.root, `file-${String(index).padStart(3, '0')}.txt`), 'x');
  }
  fs.symlinkSync('file-000.txt', path.join(current.root, 'link'));

  const first = taskFiles.list(current.task, { path: '', offset: 0, hidden: false, writable: true });
  assert.equal(first.entries.length, 200);
  assert.deepEqual(first.entries[0], { name: 'z-dir', path: 'z-dir', type: 'directory' });
  assert.equal(first.entries.some(entry => entry.name === '.secret'), false);
  assert.equal(first.root, current.root);
  assert.equal(first.writable, true);
  assert.equal(first.nextOffset, 200);

  const second = taskFiles.list(current.task, { path: '', offset: first.nextOffset, hidden: false, writable: true });
  assert.equal(second.entries.length, 4);
  assert.equal(second.nextOffset, null);
  assert.equal([...first.entries, ...second.entries].find(entry => entry.name === 'link').type, 'symlink');
  assert.equal(taskFiles.list(current.task, { path: '', hidden: true }).entries.some(entry => entry.name === '.secret'), true);
});

test('reads and saves UTF-8 text while preserving BOM, CRLF, mode, and optimistic revisions', t => {
  const current = fixture();
  t.after(current.cleanup);
  const file = path.join(current.root, 'notes.txt');
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\r\n')]));
  fs.chmodSync(file, 0o640);

  const initial = taskFiles.read(current.task, 'notes.txt');
  assert.deepEqual(initial, {
    path: 'notes.txt', content: 'one\ntwo\n', revision: initial.revision, eol: '\r\n', bom: true,
  });
  assert.match(initial.revision, /^[a-f0-9]{64}$/);

  const saved = taskFiles.write(current.task, 'notes.txt', 'changed\ntext\n', initial.revision);
  assert.equal(saved.content, 'changed\ntext\n');
  assert.equal(saved.eol, '\r\n');
  assert.equal(saved.bom, true);
  assert.equal(fs.readFileSync(file).equals(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('changed\r\ntext\r\n')])), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);

  assert.throws(() => taskFiles.write(current.task, 'notes.txt', 'stale', initial.revision), error => {
    assert.equal(error.message, 'FILE_CONFLICT');
    assert.equal(error.statusCode, 409);
    return true;
  });
  assert.equal(taskFiles.write(current.task, 'notes.txt', 'forced\n', initial.revision, true).content, 'forced\n');
});

test('normalizes CR-only text for editing and preserves CR-only storage on save', t => {
  const current = fixture();
  t.after(current.cleanup);
  const file = path.join(current.root, 'classic-mac.txt');
  fs.writeFileSync(file, 'one\rtwo\r');

  const opened = taskFiles.read(current.task, 'classic-mac.txt');
  assert.equal(opened.content, 'one\ntwo\n');
  assert.equal(opened.eol, '\n');
  const saved = taskFiles.write(current.task, 'classic-mac.txt', 'changed\ntext\n', opened.revision);
  assert.equal(saved.content, 'changed\ntext\n');
  assert.equal(saved.eol, '\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'changed\rtext\r');
});

test('rejects an opened file when a checked parent is swapped to an outside symlink', t => {
  const current = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-files-outside-'));
  t.after(() => {
    current.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const checkedParent = path.join(current.root, 'checked');
  const parkedParent = path.join(current.root, 'parked');
  fs.mkdirSync(checkedParent);
  fs.writeFileSync(path.join(checkedParent, 'target.txt'), 'inside');
  fs.writeFileSync(path.join(outside, 'target.txt'), 'outside secret');

  const originalOpen = fs.openSync;
  let swapped = false;
  fs.openSync = (file, ...args) => {
    if (!swapped && file === path.join(checkedParent, 'target.txt')) {
      swapped = true;
      fs.renameSync(checkedParent, parkedParent);
      fs.symlinkSync(outside, checkedParent);
    }
    return originalOpen(file, ...args);
  };
  try {
    assert.throws(
      () => taskFiles.read(current.task, 'checked/target.txt'),
      error => error.message === 'FILE_PATH_CHANGED' && error.statusCode === 409,
    );
  } finally {
    fs.openSync = originalOpen;
  }
});

test('does not write content when a save parent is swapped before the temporary file opens', t => {
  const current = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-save-outside-'));
  t.after(() => {
    current.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const checkedParent = path.join(current.root, 'checked');
  const parkedParent = path.join(current.root, 'parked');
  const target = path.join(checkedParent, 'target.txt');
  fs.mkdirSync(checkedParent);
  fs.writeFileSync(target, 'inside original');
  fs.writeFileSync(path.join(outside, 'target.txt'), 'outside original');
  const opened = taskFiles.read(current.task, 'checked/target.txt');

  const originalOpen = fs.openSync;
  let swapped = false;
  fs.openSync = (file, ...args) => {
    if (!swapped && path.dirname(file) === checkedParent && path.basename(file).startsWith('.target.txt.t-agent-')) {
      swapped = true;
      fs.renameSync(checkedParent, parkedParent);
      fs.symlinkSync(outside, checkedParent);
    }
    return originalOpen(file, ...args);
  };
  try {
    assert.throws(
      () => taskFiles.write(current.task, 'checked/target.txt', 'replacement', opened.revision),
      error => error.message === 'FILE_PATH_CHANGED' && error.statusCode === 409,
    );
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(fs.readFileSync(path.join(parkedParent, 'target.txt'), 'utf8'), 'inside original');
  assert.equal(fs.readFileSync(path.join(outside, 'target.txt'), 'utf8'), 'outside original');
});

test('rejects traversal, symlink operations, binary text, oversize text, and root mutation', t => {
  const current = fixture();
  t.after(current.cleanup);
  fs.writeFileSync(path.join(current.root, 'binary.dat'), Buffer.from([0xff, 0x00, 0xfe]));
  fs.writeFileSync(path.join(current.root, 'controls.dat'), Buffer.from('text\u0001more'));
  fs.writeFileSync(path.join(current.root, 'outside.txt'), 'target');
  fs.symlinkSync('outside.txt', path.join(current.root, 'link.txt'));

  for (const invalid of ['../outside', '/absolute', 'a/../../outside']) {
    assert.throws(() => taskFiles.read(current.task, invalid), /FILE_PATH_INVALID/);
  }
  assert.throws(() => taskFiles.read(current.task, 'link.txt'), /FILE_UNSUPPORTED/);
  assert.throws(() => taskFiles.read(current.task, 'binary.dat'), error => error.message === 'FILE_UNSUPPORTED' && error.statusCode === 415);
  assert.throws(() => taskFiles.read(current.task, 'controls.dat'), error => error.message === 'FILE_UNSUPPORTED' && error.statusCode === 415);
  assert.throws(() => taskFiles.write(current.task, 'binary.dat', 'text', 'anything', true), /FILE_UNSUPPORTED/);
  assert.throws(() => taskFiles.write(current.task, 'outside.txt', 'x'.repeat(5 * 1024 * 1024 + 1), 'anything', true), error => error.message === 'FILE_TOO_LARGE' && error.statusCode === 413);
  assert.throws(() => taskFiles.remove(current.task, '', true), /FILE_ROOT_PROTECTED/);
});

test('a failed save leaves the original file intact', t => {
  const current = fixture();
  t.after(current.cleanup);
  const file = path.join(current.root, 'safe.txt');
  fs.writeFileSync(file, 'original\n');
  const opened = taskFiles.read(current.task, 'safe.txt');
  const originalWrite = fs.writeSync;
  fs.writeSync = () => { throw Object.assign(new Error('disk failed'), { code: 'EIO' }); };
  try {
    assert.throws(() => taskFiles.write(current.task, 'safe.txt', 'replacement\n', opened.revision), /FILE_OPERATION_FAILED/);
  } finally {
    fs.writeSync = originalWrite;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), 'original\n');
  assert.deepEqual(fs.readdirSync(current.root), ['safe.txt']);

  assert.throws(() => taskFiles.write(current.task, 'safe.txt', 'bad\u0001text', opened.revision), /FILE_UNSUPPORTED/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'original\n');
});

test('save rechecks the revision immediately before replacing the file', t => {
  const current = fixture();
  t.after(current.cleanup);
  const file = path.join(current.root, 'concurrent.txt');
  fs.writeFileSync(file, 'original\n');
  const opened = taskFiles.read(current.task, 'concurrent.txt');
  const originalFsync = fs.fsyncSync;
  let changed = false;
  fs.fsyncSync = descriptor => {
    originalFsync(descriptor);
    if (!changed) {
      changed = true;
      fs.writeFileSync(file, 'external edit\n');
    }
  };
  try {
    assert.throws(() => taskFiles.write(current.task, 'concurrent.txt', 'replacement\n', opened.revision), /FILE_CONFLICT/);
  } finally {
    fs.fsyncSync = originalFsync;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), 'external edit\n');
  assert.deepEqual(fs.readdirSync(current.root), ['concurrent.txt']);
});

test('creates, renames without overwrite, and requires confirmation for recursive directory deletion', t => {
  const current = fixture();
  t.after(current.cleanup);

  assert.deepEqual(taskFiles.create(current.task, 'docs', 'directory'), { path: 'docs' });
  assert.deepEqual(taskFiles.create(current.task, 'docs/a.txt', 'file'), { path: 'docs/a.txt' });
  fs.writeFileSync(path.join(current.root, 'docs', 'a.txt'), 'a');
  fs.writeFileSync(path.join(current.root, 'existing.txt'), 'existing');
  assert.throws(() => taskFiles.rename(current.task, 'docs/a.txt', 'existing.txt'), error => error.message === 'FILE_EXISTS' && error.statusCode === 409);
  assert.deepEqual(taskFiles.rename(current.task, 'docs/a.txt', 'docs/b.txt'), { path: 'docs/b.txt' });
  assert.throws(() => taskFiles.remove(current.task, 'docs', false), /DIRECTORY_RECURSIVE_REQUIRED/);
  assert.deepEqual(taskFiles.remove(current.task, 'docs', true), { success: true });
  assert.equal(fs.existsSync(path.join(current.root, 'docs')), false);
});

test('deletes a large file without applying editor size or read-permission checks', t => {
  const current = fixture();
  t.after(current.cleanup);
  const file = path.join(current.root, 'large.bin');
  fs.writeFileSync(file, Buffer.alloc(5 * 1024 * 1024 + 1, 0xff));
  fs.chmodSync(file, 0o000);

  assert.deepEqual(taskFiles.remove(current.task, 'large.bin'), { success: true });
  assert.equal(fs.existsSync(file), false);
});

test('uses the Markdown parent when a task has no work directory', t => {
  const current = fixture();
  t.after(current.cleanup);
  const task = { md_path: path.join(current.root, 'DESIGN.md') };
  assert.equal(taskFiles.list(task, {}).root, current.root);
});
