const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const PAGE_SIZE = 200;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

function failure(code, statusCode, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.statusCode = statusCode;
  return error;
}

function mapFsError(error) {
  if (error && error.statusCode) return error;
  if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return failure('FILE_NOT_FOUND', 404, error);
  if (error && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')) return failure('FILE_EXISTS', 409, error);
  if (error && (error.code === 'EACCES' || error.code === 'EPERM')) return failure('FILE_FORBIDDEN', 403, error);
  if (error && (error.code === 'ELOOP' || error.code === 'EMLINK')) return failure('FILE_UNSUPPORTED', 415, error);
  return failure('FILE_OPERATION_FAILED', 500, error);
}

function taskRoot(task) {
  const configured = task && (task.work_dir || (task.md_path && path.dirname(task.md_path)));
  if (!configured || !path.isAbsolute(configured)) throw failure('TASK_ROOT_UNAVAILABLE', 400);
  return path.resolve(configured);
}

function relativePath(value, { allowRoot = false } = {}) {
  if (value === undefined || value === null || value === '' || value === '.') {
    if (allowRoot) return '';
    throw failure('FILE_ROOT_PROTECTED', 400);
  }
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw failure('FILE_PATH_INVALID', 400);
  }
  const parts = value.split('/');
  if (parts.some(part => part === '..')) throw failure('FILE_PATH_INVALID', 400);
  const normalized = path.posix.normalize(value);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    if (allowRoot && normalized === '.') return '';
    throw failure('FILE_PATH_INVALID', 400);
  }
  return normalized;
}

function lstat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { throw mapFsError(error); }
}

function realpath(file) {
  return (fs.realpathSync.native || fs.realpathSync)(file);
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function assertNamedIdentity(absolute, stat) {
  try {
    const named = fs.lstatSync(absolute);
    if (named.isSymbolicLink() || !sameIdentity(named, stat)) throw failure('FILE_PATH_CHANGED', 409);
  } catch (error) {
    if (error.message === 'FILE_PATH_CHANGED') throw error;
    throw failure('FILE_PATH_CHANGED', 409, error);
  }
}

function snapshotNode(absolute, stat) {
  return {
    absolute,
    dev: stat.dev,
    ino: stat.ino,
    realpath: stat.isDirectory() ? realpath(absolute) : null,
  };
}

function assertPathStable(target, { includeLeaf = true } = {}) {
  const nodes = includeLeaf ? target.chain : target.chain.slice(0, -1);
  try {
    for (const node of nodes) {
      const before = fs.lstatSync(node.absolute);
      if (before.isSymbolicLink() || before.dev !== node.dev || before.ino !== node.ino) {
        throw failure('FILE_PATH_CHANGED', 409);
      }
      if (node.realpath !== null && realpath(node.absolute) !== node.realpath) {
        throw failure('FILE_PATH_CHANGED', 409);
      }
      const after = fs.lstatSync(node.absolute);
      if (after.isSymbolicLink() || after.dev !== node.dev || after.ino !== node.ino) {
        throw failure('FILE_PATH_CHANGED', 409);
      }
    }
  } catch (error) {
    if (error.message === 'FILE_PATH_CHANGED') throw error;
    throw failure('FILE_PATH_CHANGED', 409, error);
  }
}

function resolvePath(task, value, { allowRoot = false, allowMissingLeaf = false } = {}) {
  const root = taskRoot(task);
  const rootStat = lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw failure('FILE_UNSUPPORTED', 415);
  const chain = [snapshotNode(root, rootStat)];
  const relative = relativePath(value, { allowRoot });
  if (!relative) {
    const target = { root, relative, absolute: root, stat: rootStat, chain };
    assertPathStable(target);
    return target;
  }

  const parts = relative.split('/');
  let current = root;
  let stat;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const leaf = index === parts.length - 1;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (leaf && allowMissingLeaf && error.code === 'ENOENT') {
        const target = { root, relative, absolute: current, stat: null, chain };
        assertPathStable(target);
        return target;
      }
      throw mapFsError(error);
    }
    if (stat.isSymbolicLink()) throw failure('FILE_UNSUPPORTED', 415);
    if (!leaf && !stat.isDirectory()) throw failure('FILE_NOT_FOUND', 404);
    chain.push(snapshotNode(current, stat));
  }
  const target = { root, relative, absolute: current, stat, chain };
  assertPathStable(target);
  return target;
}

function offsetOf(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (!/^\d+$/.test(String(value))) throw failure('FILE_OFFSET_INVALID', 400);
  const offset = Number(value);
  if (!Number.isSafeInteger(offset)) throw failure('FILE_OFFSET_INVALID', 400);
  return offset;
}

function list(task, options = {}) {
  const target = resolvePath(task, options.path, { allowRoot: true });
  if (!target.stat.isDirectory()) throw failure('FILE_NOT_DIRECTORY', 400);
  const showHidden = options.hidden === true || options.hidden === 'true';
  const offset = offsetOf(options.offset);
  let entries;
  try {
    assertPathStable(target);
    entries = fs.readdirSync(target.absolute, { withFileTypes: true })
      .filter(entry => showHidden || !entry.name.startsWith('.'))
      .map(entry => ({
        name: entry.name,
        path: target.relative ? `${target.relative}/${entry.name}` : entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
      }));
    assertPathStable(target);
  } catch (error) { throw mapFsError(error); }
  entries.sort((left, right) => {
    if (left.type === 'directory' && right.type !== 'directory') return -1;
    if (left.type !== 'directory' && right.type === 'directory') return 1;
    return left.name.localeCompare(right.name);
  });
  const page = entries.slice(offset, offset + PAGE_SIZE);
  return {
    entries: page,
    nextOffset: offset + page.length < entries.length ? offset + page.length : null,
    root: target.root,
    writable: Boolean(options.writable),
  };
}

function openRegularFile(target, flags) {
  if (!target.stat || !target.stat.isFile()) throw failure('FILE_UNSUPPORTED', 415);
  let descriptor;
  try {
    descriptor = fs.openSync(target.absolute, flags | NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw failure('FILE_UNSUPPORTED', 415);
    if (!sameIdentity(stat, target.stat)) throw failure('FILE_PATH_CHANGED', 409);
    assertPathStable(target);
    if (stat.size > MAX_TEXT_BYTES) throw failure('FILE_TOO_LARGE', 413);
    return { descriptor, stat };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw mapFsError(error);
  }
}

function inspectBuffer(buffer, relative) {
  if (buffer.length > MAX_TEXT_BYTES) throw failure('FILE_TOO_LARGE', 413);
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const textBytes = bom ? buffer.subarray(3) : buffer;
  let decoded;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(textBytes); }
  catch (error) { throw failure('FILE_UNSUPPORTED', 415, error); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(decoded)) throw failure('FILE_UNSUPPORTED', 415);
  const firstBreak = decoded.match(/\r\n|\n|\r/);
  const eol = firstBreak && firstBreak[0] === '\r\n' ? '\r\n' : '\n';
  const result = {
    path: relative,
    content: decoded.replace(/\r\n?/g, '\n'),
    revision: crypto.createHash('sha256').update(buffer).digest('hex'),
    eol,
    bom,
  };
  Object.defineProperty(result, 'storageEol', {
    value: firstBreak && firstBreak[0] === '\r' ? '\r' : eol,
    enumerable: false,
  });
  return result;
}

function readBounded(descriptor) {
  const buffer = Buffer.allocUnsafe(MAX_TEXT_BYTES + 1);
  let length = 0;
  while (length < buffer.length) {
    const read = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
    if (read === 0) break;
    length += read;
  }
  if (length > MAX_TEXT_BYTES) throw failure('FILE_TOO_LARGE', 413);
  return buffer.subarray(0, length);
}

function read(task, value) {
  const target = resolvePath(task, value);
  const { descriptor } = openRegularFile(target, fs.constants.O_RDONLY);
  try { return inspectBuffer(readBounded(descriptor), target.relative); }
  finally { fs.closeSync(descriptor); }
}

function readCurrent(target) {
  const { descriptor, stat } = openRegularFile(target, fs.constants.O_RDONLY);
  try { return { metadata: inspectBuffer(readBounded(descriptor), target.relative), stat }; }
  finally { fs.closeSync(descriptor); }
}

function write(task, value, content, revision, force = false) {
  if (typeof content !== 'string') throw failure('FILE_CONTENT_REQUIRED', 400);
  if (!force && (typeof revision !== 'string' || !revision)) throw failure('FILE_REVISION_REQUIRED', 400);
  const target = resolvePath(task, value);
  const { metadata: current, stat: currentStat } = readCurrent(target);
  if (!force && current.revision !== revision) throw failure('FILE_CONFLICT', 409);
  const normalized = content.replace(/\r\n?/g, '\n');
  const encodedText = Buffer.from(current.storageEol === '\n' ? normalized : normalized.replace(/\n/g, current.storageEol), 'utf8');
  const output = current.bom
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encodedText])
    : encodedText;
  const saved = inspectBuffer(output, target.relative);

  const parentRelative = path.posix.dirname(target.relative);
  const temporaryParent = resolvePath(task, parentRelative === '.' ? '' : parentRelative, { allowRoot: true });
  const temporary = path.join(path.dirname(target.absolute), `.${path.basename(target.absolute)}.t-agent-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  let descriptor;
  let temporaryPresent = false;
  let temporaryStat;
  try {
    assertPathStable(temporaryParent);
    descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW, currentStat.mode & 0o7777);
    temporaryStat = fs.fstatSync(descriptor);
    assertNamedIdentity(temporary, temporaryStat);
    assertPathStable(temporaryParent);
    temporaryPresent = true;
    let written = 0;
    while (written < output.length) written += fs.writeSync(descriptor, output, written, output.length - written, written);
    fs.fchmodSync(descriptor, currentStat.mode & 0o7777);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    const recheckedTarget = resolvePath(task, value);
    const { metadata: rechecked } = readCurrent(recheckedTarget);
    if (!force && rechecked.revision !== current.revision) throw failure('FILE_CONFLICT', 409);
    assertPathStable(temporaryParent);
    assertNamedIdentity(temporary, temporaryStat);
    assertPathStable(recheckedTarget);
    fs.renameSync(temporary, target.absolute);
    temporaryPresent = false;
    const writtenTarget = resolvePath(task, value);
    const { metadata: verifiedWrite } = readCurrent(writtenTarget);
    if (verifiedWrite.revision !== saved.revision) throw failure('FILE_PATH_CHANGED', 409);
    return saved;
  } catch (error) {
    throw mapFsError(error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (temporaryPresent) {
      try {
        assertPathStable(temporaryParent);
        assertNamedIdentity(temporary, temporaryStat);
        fs.unlinkSync(temporary);
      } catch {}
    }
  }
}

function create(task, value, type) {
  if (!['file', 'directory'].includes(type)) throw failure('FILE_TYPE_INVALID', 400);
  const target = resolvePath(task, value, { allowMissingLeaf: true });
  if (target.stat) throw failure('FILE_EXISTS', 409);
  const parentRelative = path.posix.dirname(target.relative);
  const parent = resolvePath(task, parentRelative === '.' ? '' : parentRelative, { allowRoot: true });
  if (!parent.stat.isDirectory()) throw failure('FILE_NOT_DIRECTORY', 400);
  let createdStat;
  try {
    assertPathStable(parent);
    if (type === 'directory') {
      fs.mkdirSync(target.absolute);
      createdStat = fs.lstatSync(target.absolute);
    }
    else {
      let descriptor;
      try {
        descriptor = fs.openSync(target.absolute, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW, 0o666);
        createdStat = fs.fstatSync(descriptor);
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
      }
    }
    assertNamedIdentity(target.absolute, createdStat);
    assertPathStable(parent);
  } catch (error) { throw mapFsError(error); }
  return { path: target.relative };
}

function rename(task, value, newValue) {
  const source = resolvePath(task, value);
  const destination = resolvePath(task, newValue, { allowMissingLeaf: true });
  if (destination.stat) throw failure('FILE_EXISTS', 409);
  if (!source.stat.isFile() && !source.stat.isDirectory()) throw failure('FILE_UNSUPPORTED', 415);
  if (source.stat.isDirectory() && destination.relative.startsWith(`${source.relative}/`)) {
    throw failure('FILE_PATH_INVALID', 400);
  }
  const parentRelative = path.posix.dirname(destination.relative);
  const parent = resolvePath(task, parentRelative === '.' ? '' : parentRelative, { allowRoot: true });
  if (!parent.stat.isDirectory()) throw failure('FILE_NOT_DIRECTORY', 400);
  let reservation;
  try {
    assertPathStable(source);
    assertPathStable(parent);
    if (source.stat.isDirectory()) {
      fs.mkdirSync(destination.absolute, { mode: 0o000 });
    } else {
      const descriptor = fs.openSync(destination.absolute, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW, 0o000);
      fs.closeSync(descriptor);
    }
    reservation = fs.lstatSync(destination.absolute);
    assertNamedIdentity(destination.absolute, reservation);
    assertPathStable(parent);
    assertPathStable(source);
    assertPathStable(parent);
    assertNamedIdentity(destination.absolute, reservation);
    fs.renameSync(source.absolute, destination.absolute);
    reservation = null;
    const moved = resolvePath(task, destination.relative);
    if (!sameIdentity(moved.stat, source.stat)) throw failure('FILE_PATH_CHANGED', 409);
  } catch (error) {
    if (reservation) {
      try {
        assertPathStable(parent);
        assertNamedIdentity(destination.absolute, reservation);
        if (reservation.isDirectory()) fs.rmdirSync(destination.absolute);
        else fs.unlinkSync(destination.absolute);
      } catch {}
    }
    throw mapFsError(error);
  }
  return { path: destination.relative };
}

function remove(task, value, recursive = false) {
  const target = resolvePath(task, value);
  const parentRelative = path.posix.dirname(target.relative);
  const parent = resolvePath(task, parentRelative === '.' ? '' : parentRelative, { allowRoot: true });
  try {
    assertPathStable(parent);
    assertPathStable(target);
    if (target.stat.isDirectory()) {
      if (recursive !== true) throw failure('DIRECTORY_RECURSIVE_REQUIRED', 400);
      let descriptor;
      let opened;
      try {
        descriptor = fs.openSync(target.absolute, fs.constants.O_RDONLY | NOFOLLOW);
        opened = fs.fstatSync(descriptor);
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
      }
      if (!sameIdentity(opened, target.stat)) throw failure('FILE_PATH_CHANGED', 409);
      assertPathStable(target);
      fs.rmSync(target.absolute, { recursive: true });
    } else if (target.stat.isFile()) {
      assertPathStable(target);
      assertNamedIdentity(target.absolute, target.stat);
      fs.unlinkSync(target.absolute);
    } else {
      throw failure('FILE_UNSUPPORTED', 415);
    }
    assertPathStable(parent);
  } catch (error) { throw mapFsError(error); }
  return { success: true };
}

module.exports = {
  PAGE_SIZE,
  MAX_TEXT_BYTES,
  taskRoot,
  list,
  read,
  write,
  create,
  rename,
  remove,
};
