// The file side of moving a task to another engine (services/task-move.js; "Move a task to another machine" in docs/design/task-move.md): the scan
// and manifest of the source folder, the path rules of the target, writing and verifying the staged copy, the move journal and the trash sweeper.
// No database and no network here, so every rule is unit tested on temporary folders (test/task-move-files.test.js).
//
// Rules that keep the move safe:
// - Nothing is followed: the scan uses lstat, a symbolic link is an entry of its own (its text is copied, never what it points to), and a file is
//   read with O_NOFOLLOW after checking it is still the regular file of the manifest.
// - A relative path from a manifest is checked before it is joined to a folder (`safeRelative`): no absolute path, no `..`, no empty or `.` segment,
//   no NUL, so a manifest cannot write outside the staging folder.
// - Sockets, FIFOs and devices are not copied; they are listed in `skipped`.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MANIFEST_VERSION = 1;
const MAX_FILES_DEFAULT = 200000;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const HASH_CHUNK = 1024 * 1024;

const fail = (code, statusCode = 409, extra = {}) => Object.assign(new Error(code), { statusCode, ...extra });

// A path of a manifest (always '/' between segments), checked. Returns the segments, or throws 400 MOVE_BAD_PATH.
function safeRelative(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 4096 || rel.includes('\0') || rel.includes('\\') || rel.startsWith('/')) throw fail('MOVE_BAD_PATH', 400, { reason: String(rel).slice(0, 200) });
  const parts = rel.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part, 'utf8') > 255)) throw fail('MOVE_BAD_PATH', 400, { reason: rel.slice(0, 200) });
  return parts;
}
// `rel` joined to `root`, after the check above; the result is always inside `root`.
function joinInside(root, rel) {
  const target = path.join(root, ...safeRelative(rel));
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) throw fail('MOVE_BAD_PATH', 400, { reason: rel.slice(0, 200) });
  return target;
}

// One plain folder name (the name the folder gets on the target): no separator, not '.' or '..', no control character, no space at either end,
// at most 255 bytes, and not hidden (a hidden name would hide the task's folder from the import list).
function checkFolderName(value) {
  const name = typeof value === 'string' ? value : '';
  if (!name || name !== name.trim() || name === '.' || name === '..' || name.startsWith('.') || /[/\\]/.test(name) || /[\u0000-\u001f\u007f]/.test(name)
    || Buffer.byteLength(name, 'utf8') > 255) throw fail('MOVE_BAD_FOLDER_NAME', 400);
  return name;
}

// The folder a moved task gets under the target's tasks folder: `<base>/<name>`, or `<name>-2`, `-3`, ... when that exists. Throws when the result
// would not be a direct child of `base` (MOVE_PATH_ESCAPES).
function targetFolder(base, name, exists = target => fs.existsSync(target)) {
  const root = path.resolve(base);
  const clean = checkFolderName(name);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.join(root, index === 1 ? clean : `${clean}-${index}`);
    if (path.dirname(candidate) !== root) throw fail('MOVE_PATH_ESCAPES', 409);
    if (!exists(candidate)) return candidate;
  }
  throw fail('MOVE_FOLDER_EXISTS', 409);
}

// Walks `root` without following anything. Entries in a stable order (parents before children), each { p, t: 'd' | 'f' | 'l', s, m, mt, l? }.
// Stops early (truncated) past `maxFiles` entries or `maxBytes` bytes of files, so a preview of a huge folder answers quickly.
function scanFolder(root, { maxFiles = MAX_FILES_DEFAULT, maxBytes = Infinity } = {}) {
  const base = path.resolve(root);
  const top = fs.lstatSync(base);
  if (!top.isDirectory()) throw fail('MOVE_NOT_A_FOLDER', 409);
  const entries = [];
  const skipped = [];
  const totals = { files: 0, dirs: 0, links: 0, bytes: 0 };
  let truncated = null;
  const walk = (dir, rel) => {
    let names;
    try { names = fs.readdirSync(dir); } catch (error) { throw fail('MOVE_UNREADABLE', 409, { reason: `${rel || '.'}: ${error.code || error.message}` }); }
    names.sort();
    for (const name of names) {
      if (truncated) return;
      const full = path.join(dir, name);
      const p = rel ? `${rel}/${name}` : name;
      let stat;
      try { stat = fs.lstatSync(full); } catch (error) { throw fail('MOVE_UNREADABLE', 409, { reason: `${p}: ${error.code || error.message}` }); }
      const meta = { p, s: 0, m: stat.mode & 0o7777, mt: Math.round(stat.mtimeMs) };
      if (stat.isDirectory()) {
        entries.push({ ...meta, t: 'd' });
        totals.dirs += 1;
        walk(full, p);
      } else if (stat.isFile()) {
        entries.push({ ...meta, t: 'f', s: stat.size });
        totals.files += 1;
        totals.bytes += stat.size;
      } else if (stat.isSymbolicLink()) {
        entries.push({ ...meta, t: 'l', l: fs.readlinkSync(full) });
        totals.links += 1;
      } else {
        skipped.push({ p, why: 'not a file, folder or link' });
      }
      if (entries.length > maxFiles) truncated = 'files';
      else if (totals.bytes > maxBytes) truncated = 'bytes';
    }
  };
  walk(base, '');
  return { entries, skipped, totals, truncated, mode: top.mode & 0o7777, mt: Math.round(top.mtimeMs) };
}

// Opens a file of a manifest for reading: still a regular file (not a link put there since) of the expected size, opened without following links.
function openChecked(abs, expectedSize = null) {
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw fail('MOVE_FILE_CHANGED', 409, { reason: path.basename(abs) });
    if (expectedSize !== null && stat.size !== expectedSize) throw fail('MOVE_FILE_CHANGED', 409, { reason: path.basename(abs) });
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}

// SHA-256 (hex) of a file, read in 1 MiB pieces with a pause between them so the server keeps answering. `signal` (an AbortSignal) stops it.
async function hashFile(abs, { expectedSize = null, signal = null } = {}) {
  const fd = openChecked(abs, expectedSize);
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.alloc(HASH_CHUNK);
  let size = 0;
  try {
    for (;;) {
      if (signal && signal.aborted) throw fail('MOVE_CANCELLED', 409);
      const read = await new Promise((resolve, reject) => fs.read(fd, buffer, 0, buffer.length, null, (error, bytes) => (error ? reject(error) : resolve(bytes))));
      if (!read) break;
      hash.update(buffer.subarray(0, read));
      size += read;
    }
  } finally { fs.closeSync(fd); }
  if (expectedSize !== null && size !== expectedSize) throw fail('MOVE_FILE_CHANGED', 409, { reason: path.basename(abs) });
  return hash.digest('hex');
}

// The SHA-256 of every file entry of a scan, added in place (`h`). Throws MOVE_FILE_CHANGED when a file changed size meanwhile.
async function hashEntries(root, entries, { signal = null, onFile = () => {} } = {}) {
  for (const entry of entries) {
    if (entry.t !== 'f') continue;
    entry.h = await hashFile(joinInside(root, entry.p), { expectedSize: entry.s, signal });
    onFile(entry);
  }
  return entries;
}

// A link's text on the target: an absolute link into the old folder (its path as stored or its real path) points into the new one; any other link
// keeps its text exactly (it was never followed, so it gives nothing away).
function movedLink(text, fromDirs, toDir) {
  if (typeof text !== 'string' || !path.isAbsolute(text)) return text;
  for (const from of fromDirs.filter(Boolean)) {
    const base = path.resolve(from);
    if (text === base) return toDir;
    if (text.startsWith(base + path.sep)) return toDir + text.slice(base.length);
  }
  return text;
}

// Creates the folders and links of a manifest under `root` (files are written by the transfer). Never follows a link: a parent is created with
// mkdir, which fails on a link in the way.
function createSkeleton(root, entries, { fromDirs = [], toDir = root } = {}) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const target = joinInside(root, entry.p);
    if (entry.t === 'd') fs.mkdirSync(target, { mode: 0o700 });
    else if (entry.t === 'l') fs.symlinkSync(movedLink(entry.l, fromDirs, toDir), target);
  }
}

// Modes and modification times of a written copy: files and links first, then folders from the deepest up (writing inside a folder changes its time).
function applyMeta(root, entries, top = null) {
  for (const entry of entries) {
    const target = joinInside(root, entry.p);
    if (entry.t === 'f') {
      fs.chmodSync(target, entry.m & 0o777);
      fs.utimesSync(target, entry.mt / 1000, entry.mt / 1000);
    } else if (entry.t === 'l' && typeof fs.lutimesSync === 'function') {
      try { fs.lutimesSync(target, entry.mt / 1000, entry.mt / 1000); } catch { /* not supported here */ }
    }
  }
  const dirs = entries.filter(entry => entry.t === 'd').sort((a, b) => b.p.split('/').length - a.p.split('/').length);
  for (const entry of dirs) {
    const target = joinInside(root, entry.p);
    fs.chmodSync(target, entry.m & 0o777);
    fs.utimesSync(target, entry.mt / 1000, entry.mt / 1000);
  }
  if (top) {
    fs.chmodSync(root, top.m & 0o777);
    fs.utimesSync(root, top.mt / 1000, top.mt / 1000);
  }
}

// Checks a staged copy against its manifest: every entry there with its type, every file with its size and SHA-256 read again from the disk, every
// link with its text, and nothing more than the manifest names. Returns the problems ([] when the copy is right).
async function verifyCopy(root, entries, { fromDirs = [], toDir = root, signal = null } = {}) {
  const problems = [];
  const expected = new Set();
  for (const entry of entries) {
    expected.add(entry.p);
    let target;
    try { target = joinInside(root, entry.p); } catch { problems.push(`${entry.p}: bad path`); continue; }
    let stat;
    try { stat = fs.lstatSync(target); } catch { problems.push(`${entry.p}: missing`); continue; }
    if (entry.t === 'd' && !stat.isDirectory()) problems.push(`${entry.p}: not a folder`);
    else if (entry.t === 'l') {
      if (!stat.isSymbolicLink()) problems.push(`${entry.p}: not a link`);
      else if (fs.readlinkSync(target) !== movedLink(entry.l, fromDirs, toDir)) problems.push(`${entry.p}: link changed`);
    } else if (entry.t === 'f') {
      if (!stat.isFile()) problems.push(`${entry.p}: not a file`);
      else if (stat.size !== entry.s) problems.push(`${entry.p}: size ${stat.size} instead of ${entry.s}`);
      else {
        try {
          const digest = await hashFile(target, { expectedSize: entry.s, signal });
          if (digest !== entry.h) problems.push(`${entry.p}: SHA-256 differs`);
        } catch (error) {
          if (error.message === 'MOVE_CANCELLED') throw error;
          problems.push(`${entry.p}: ${error.message}`);
        }
      }
    }
  }
  // Nothing extra: walk the copy and name what the manifest does not have.
  const walk = (dir, rel) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const p = rel ? `${rel}/${name}` : name;
      if (!expected.has(p)) { problems.push(`${p}: not in the manifest`); continue; }
      let stat;
      try { stat = fs.lstatSync(path.join(dir, name)); } catch { continue; }
      if (stat.isDirectory()) walk(path.join(dir, name), p);
    }
  };
  walk(root, '');
  return problems;
}

// Free bytes for unprivileged use on the file system of `dir` (its nearest existing parent); null when it cannot be told.
function freeBytes(dir) {
  let probe = path.resolve(dir);
  for (;;) {
    try {
      if (typeof fs.statfsSync !== 'function') return null;
      const stat = fs.statfsSync(probe);
      return Number(stat.bavail) * Number(stat.bsize);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
}

// Writes JSON to `file` so that a crash leaves either the old or the new content: a temporary file in the same folder, flushed, then renamed.
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  try { const dirFd = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); } } catch { /* not every system syncs a folder */ }
}

// The move journal of one engine: one JSON file per move in `dir` (`<data folder>/task-moves`). A record is written before each step that changes
// something, so a start after a crash knows where each move stopped ("Journal and recovery" in docs/design/task-move.md).
function createJournal(dir) {
  const MOVE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const fileOf = id => {
    if (!MOVE_ID.test(String(id))) throw fail('MOVE_NOT_FOUND', 404);
    return path.join(dir, `${id}.json`);
  };
  return {
    dir,
    isId: id => MOVE_ID.test(String(id)),
    read(id) {
      try { return JSON.parse(fs.readFileSync(fileOf(id), 'utf8')); } catch (error) { if (error.statusCode) throw error; return null; }
    },
    write(record) { writeJsonAtomic(fileOf(record.id), record); return record; },
    update(id, change) {
      const current = this.read(id);
      if (!current) throw fail('MOVE_NOT_FOUND', 404);
      return this.write({ ...current, ...change });
    },
    remove(id) { try { fs.unlinkSync(fileOf(id)); } catch { /* gone */ } },
    all() {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return []; }
      const out = [];
      for (const name of names) {
        if (!name.endsWith('.json') || !MOVE_ID.test(name.slice(0, -5))) continue;
        try { out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))); } catch { /* a half-written temporary file is not a .json */ }
      }
      return out;
    },
  };
}

// The trash of moved folders: `<data folder>/trash/moved-<task>-<time>/`, each with `moved.json` ({ moved_at (ms), task_id, title, to, elsewhere? }).
// `elsewhere` is the folder's place when it could not be renamed into the data folder (another file system): `<parent>/.t-agent-trash-moved-...`.
const TRASH_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const TRASH_NAME = /^moved-\d+-\d+(-\d+)?$/;
const ELSEWHERE_NAME = /^\.t-agent-trash-moved-\d+-\d+(-\d+)?$/;

// Removes the trash entries older than `keepMs` at `now`. Never follows a link (fs.rmSync removes a link, not what it points to), and removes a folder
// kept elsewhere only when its name is one this code gives. Returns the names removed.
function sweepTrash(trashDir, { now = Date.now(), keepMs = TRASH_KEEP_MS, log = null } = {}) {
  let names = [];
  try { names = fs.readdirSync(trashDir); } catch { return []; }
  const removed = [];
  for (const name of names) {
    if (!TRASH_NAME.test(name)) continue;
    const dir = path.join(trashDir, name);
    let info = null;
    try { info = JSON.parse(fs.readFileSync(path.join(dir, 'moved.json'), 'utf8')); } catch { info = null; }
    let movedAt = info && Number.isFinite(info.moved_at) ? info.moved_at : null;
    if (movedAt === null) { try { movedAt = fs.lstatSync(dir).mtimeMs; } catch { continue; } }
    if (now - movedAt < keepMs) continue;
    try {
      if (info && typeof info.elsewhere === 'string' && path.isAbsolute(info.elsewhere) && ELSEWHERE_NAME.test(path.basename(info.elsewhere))) {
        fs.rmSync(info.elsewhere, { recursive: true, force: true });
      }
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch (error) { if (log) log.warn(`[task-move] could not remove ${name} from the trash: ${error.code || error.message}`); }
  }
  return removed;
}

module.exports = {
  MANIFEST_VERSION, MAX_FILES_DEFAULT, TRASH_KEEP_MS, TRASH_NAME, ELSEWHERE_NAME,
  safeRelative, joinInside, checkFolderName, targetFolder, scanFolder, openChecked, hashFile, hashEntries, movedLink, createSkeleton, applyMeta,
  verifyCopy, freeBytes, writeJsonAtomic, createJournal, sweepTrash,
};
