// Preview of a file at any path on this machine (read only): GET /api/fs/*, /v1/fs/*, and the remote proxy's /fs/*.
// The text and image rules are those of the task files API (services/file-content.js). There is no root limit and symbolic links are followed,
// but the read is done with the terminal user's identity: when the service runs as root and drops the terminal to TERMINAL_USER
// (lib/terminal-user.js), a child process (scripts/fs-read-child.js) runs with that uid/gid and reads the file, so nothing that user cannot read is
// returned. Otherwise the file is read in this process. Only regular files; FIFOs, sockets, devices and empty /proc or /sys files are refused, so a
// read never waits for a writer; every read gives up after 10 s.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { MAX_TEXT_BYTES, failure, inspectBuffer, imageTypeOf, sniffImage } = require('./file-content');
const { resolveTerminalUser, terminalEnvFor } = require('../lib/terminal-user');

const READ_TIMEOUT_MS = 10_000;
const CHILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'fs-read-child.js');
const CHILD_PATH = '/usr/local/bin:/usr/bin:/bin';

// Error codes of this API, their status and the English message sent with them (Chinese in public/js/i18n-zh-server.js).
const ERRORS = {
  BAD_PATH: [400, 'The path must be absolute or start with ~/'],
  IS_DIRECTORY: [400, 'This path is a folder'],
  NOT_A_REGULAR_FILE: [400, 'Only regular files can be opened'],
  NOT_FOUND: [404, 'File does not exist'],
  PERMISSION_DENIED: [403, 'Permission denied: the terminal user cannot read this file'],
  FILE_PATH_CHANGED: [409, 'The file changed while it was read'],
  FILE_TOO_LARGE: [413, 'The file is larger than 5 MB'],
  FILE_UNSUPPORTED: [415, 'This is not a plain text file'],
  FILE_NOT_IMAGE: [415, 'This is not a PNG, JPEG, GIF or WebP image'],
  FS_READ_FAILED: [500, 'The file could not be read'],
  READ_TIMEOUT: [504, 'Reading the file took longer than 10 seconds'],
};

function fsFailure(code, cause) {
  const known = ERRORS[code] ? code : 'FS_READ_FAILED';
  return failure(known, ERRORS[known][0], cause);
}

function mapFsError(error) {
  if (error && error.statusCode) return error;
  const code = error && error.code;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return fsFailure('NOT_FOUND', error);
  if (code === 'EACCES' || code === 'EPERM') return fsFailure('PERMISSION_DENIED', error);
  if (code === 'EISDIR') return fsFailure('IS_DIRECTORY', error);
  if (code === 'ENAMETOOLONG') return fsFailure('BAD_PATH', error);
  return fsFailure('FS_READ_FAILED', error);
}

// The absolute path a request names: an absolute path, or '~' / '~/...' (the terminal user's home). Anything else, NUL included, is BAD_PATH.
function requestedPath(value, home) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw fsFailure('BAD_PATH');
  let absolute;
  if (value === '~' || value.startsWith('~/')) {
    if (typeof home !== 'string' || !path.posix.isAbsolute(home)) throw fsFailure('BAD_PATH');
    absolute = path.posix.join(home, value.slice(1));
  } else if (value.startsWith('/')) {
    absolute = value;
  } else {
    throw fsFailure('BAD_PATH');
  }
  return path.posix.resolve(absolute);
}

// Files of /proc and /sys say they are empty but are generated when read (and some never end): refused like a device.
function isPseudoFile(realPath, stat) {
  return stat.size === 0 && /^\/(proc|sys)(\/|$)/.test(realPath);
}

// The bytes of a regular file: { realPath, data }. Shared by the in-process read and the child process of a dropped terminal user.
async function readRaw(absolute, kind) {
  let realPath;
  let stat;
  try {
    realPath = await fs.promises.realpath(absolute);
    stat = await fs.promises.stat(realPath);
  } catch (error) { throw mapFsError(error); }
  if (stat.isDirectory()) throw fsFailure('IS_DIRECTORY');
  if (!stat.isFile() || isPseudoFile(realPath, stat)) throw fsFailure('NOT_A_REGULAR_FILE');
  if (kind === 'image' && !imageTypeOf(absolute)) throw fsFailure('FILE_NOT_IMAGE');
  if (stat.size > MAX_TEXT_BYTES) throw fsFailure('FILE_TOO_LARGE');
  let handle;
  try {
    // O_NONBLOCK: a FIFO put in the file's place after the check above must not make the open wait for a writer.
    handle = await fs.promises.open(realPath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    const opened = await handle.stat();
    if (!opened.isFile()) throw fsFailure('NOT_A_REGULAR_FILE');
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw fsFailure('FILE_PATH_CHANGED');
    const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_TEXT_BYTES) throw fsFailure('FILE_TOO_LARGE');
    return { realPath, data: buffer.subarray(0, length) };
  } catch (error) {
    throw mapFsError(error);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => { timer = setTimeout(() => reject(fsFailure('READ_TIMEOUT')), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

// Runs a command and collects at most `maxBytes` of its output; the process is killed on overflow or after `timeoutMs`.
// Resolves { code, signal, stdout, timedOut, overflow } or { error } when it cannot start.
function spawnRunner({ command, args, uid, gid, cwd, env, timeoutMs, maxBytes }) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'ignore'], ...(uid !== undefined ? { uid, gid } : {}) });
    } catch (error) { resolve({ error }); return; }
    const chunks = [];
    let length = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', chunk => {
      if (overflow) return;
      length += chunk.length;
      if (length > maxBytes) { overflow = true; child.kill('SIGKILL'); return; }
      chunks.push(chunk);
    });
    child.on('error', error => finish({ error }));
    child.on('close', (code, signal) => finish({ code, signal, stdout: Buffer.concat(chunks), timedOut, overflow }));
  });
}

// The child's answer: one JSON line ({ realPath, length } or { error }), then exactly `length` bytes of the file.
async function readAsUser(user, absolute, kind, { runner, timeoutMs }) {
  const result = await runner({
    command: process.execPath,
    args: [CHILD_SCRIPT, kind, absolute],
    uid: user.uid,
    gid: user.gid,
    cwd: '/',
    env: terminalEnvFor(user, { PATH: CHILD_PATH }),
    timeoutMs,
    maxBytes: MAX_TEXT_BYTES + 64 * 1024,
  });
  if (!result || result.error) throw fsFailure('FS_READ_FAILED', result && result.error);
  if (result.timedOut) throw fsFailure('READ_TIMEOUT');
  if (result.overflow) throw fsFailure('FILE_TOO_LARGE');
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
  const newline = stdout.indexOf(0x0a);
  let header;
  try { header = newline > 0 ? JSON.parse(stdout.subarray(0, newline).toString('utf8')) : null; } catch { header = null; }
  if (!header || typeof header !== 'object') throw fsFailure('FS_READ_FAILED');
  if (header.error) throw fsFailure(String(header.error));
  const data = stdout.subarray(newline + 1);
  if (result.code !== 0 || typeof header.realPath !== 'string' || !path.posix.isAbsolute(header.realPath) || header.length !== data.length) {
    throw fsFailure('FS_READ_FAILED');
  }
  return { realPath: header.realPath, data };
}

function finish(kind, requested, raw) {
  if (kind === 'image') {
    const type = imageTypeOf(requested);
    if (!type || sniffImage(raw.data) !== type) throw fsFailure('FILE_NOT_IMAGE');
    return { path: requested, realPath: raw.realPath, type, data: Buffer.from(raw.data) };
  }
  const text = inspectBuffer(raw.data, requested);
  return { path: requested, realPath: raw.realPath, content: text.content, revision: text.revision, eol: text.eol, bom: text.bom };
}

// `terminalUser()` returns the dropped terminal user ({ name, uid, gid, home }) or null; `runner` runs the child (injectable for tests).
function createFsReader({
  terminalUser = () => resolveTerminalUser().user,
  runner = spawnRunner,
  timeoutMs = READ_TIMEOUT_MS,
  homeDir = () => process.env.HOME || os.homedir(),
} = {}) {
  async function read(kind, value) {
    const user = terminalUser();
    const requested = requestedPath(value, user ? user.home : homeDir());
    try {
      const raw = user
        ? await readAsUser(user, requested, kind, { runner, timeoutMs })
        : await withTimeout(readRaw(requested, kind), timeoutMs);
      return finish(kind, requested, raw);
    } catch (error) {
      const mapped = mapFsError(error);
      if (mapped.message === 'IS_DIRECTORY') mapped.path = requested;
      throw mapped;
    }
  }
  return { readText: value => read('text', value), readImage: value => read('image', value) };
}

// The JSON body of an error answer: { error, message } and, for a folder, the path.
function errorBody(error) {
  const code = error && ERRORS[error.message] ? error.message : 'FS_READ_FAILED';
  return { status: ERRORS[code][0], body: { error: code, message: ERRORS[code][1], ...(error && error.path ? { path: error.path } : {}) } };
}

module.exports = {
  ERRORS,
  READ_TIMEOUT_MS,
  CHILD_SCRIPT,
  requestedPath,
  isPseudoFile,
  readRaw,
  spawnRunner,
  createFsReader,
  errorBody,
};
