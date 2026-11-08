// Preview of a file at any path on this machine (read only): GET /api/fs/*, /v1/fs/*, and the remote proxy's /fs/*.
// The text, image and raw (PDF, audio, video) rules are those of the task files API (services/file-content.js). There is no root limit and symbolic links are followed,
// but the read is done with the terminal user's identity: when the service runs as root and drops the terminal to TERMINAL_USER
// (lib/terminal-user.js), a child process (scripts/fs-read-child.js) runs with that uid/gid and reads the file, so nothing that user cannot read is
// returned. Otherwise the file is read in this process. Only regular files; FIFOs, sockets, devices and empty /proc or /sys files are refused, so a
// read never waits for a writer; every read gives up after 10 s. A raw file is streamed: the 10 s cover the checks up to the first byte (the child's
// header line), then the stream runs as long as the answer is read and is stopped when the answer closes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PassThrough, Transform } = require('node:stream');
const {
  MAX_TEXT_BYTES, MAX_IMAGE_BYTES, MAX_RAW_BYTES, RAW_SNIFF_BYTES, failure, inspectBuffer, imageTypeOf, sniffImage, rawTypeOf, rawMagicMatches, parseRange,
} = require('./file-content');
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
  FILE_NOT_IMAGE: [415, 'This is not a supported image (PNG, JPEG, GIF, WebP, SVG, BMP, ICO or AVIF)'],
  RANGE_NOT_SATISFIABLE: [416, 'The requested range is outside the file'],
  FS_READ_FAILED: [500, 'The file could not be read'],
  READ_TIMEOUT: [504, 'Reading the file took longer than 10 seconds'],
};

// The message of a code for an image or raw read, where the text message would be wrong (`error.variant` is the kind of the read).
const VARIANT_MESSAGES = {
  'FILE_TOO_LARGE:image': 'The image is larger than 20 MB',
  'FILE_TOO_LARGE:raw': 'The file is larger than 200 MB',
  'FILE_UNSUPPORTED:raw': 'This file type cannot be shown',
};

const LIMITS = { text: MAX_TEXT_BYTES, image: MAX_IMAGE_BYTES, raw: MAX_RAW_BYTES };

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

// Opens a regular file for a read of `kind` ('text', 'image' or 'raw') after the checks: { realPath, stat, handle }. The caller closes the handle.
async function openChecked(absolute, kind) {
  let realPath;
  let stat;
  try {
    realPath = await fs.promises.realpath(absolute);
    stat = await fs.promises.stat(realPath);
  } catch (error) { throw mapFsError(error); }
  if (stat.isDirectory()) throw fsFailure('IS_DIRECTORY');
  if (!stat.isFile() || isPseudoFile(realPath, stat)) throw fsFailure('NOT_A_REGULAR_FILE');
  if (kind === 'image' && !imageTypeOf(absolute)) throw fsFailure('FILE_NOT_IMAGE');
  if (kind === 'raw' && !rawTypeOf(absolute)) throw fsFailure('FILE_UNSUPPORTED');
  if (stat.size > LIMITS[kind]) throw fsFailure('FILE_TOO_LARGE');
  let handle;
  try {
    // O_NONBLOCK: a FIFO put in the file's place after the check above must not make the open wait for a writer.
    handle = await fs.promises.open(realPath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    const opened = await handle.stat();
    if (!opened.isFile()) throw fsFailure('NOT_A_REGULAR_FILE');
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw fsFailure('FILE_PATH_CHANGED');
    if (opened.size > LIMITS[kind]) throw fsFailure('FILE_TOO_LARGE');
    return { realPath, stat: opened, handle };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    throw mapFsError(error);
  }
}

// The bytes of a regular file: { realPath, data }. Shared by the in-process read and the child process of a dropped terminal user.
async function readRaw(absolute, kind) {
  const limit = LIMITS[kind] || MAX_TEXT_BYTES;
  const { realPath, handle } = await openChecked(absolute, kind === 'image' ? 'image' : 'text');
  try {
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) throw fsFailure('FILE_TOO_LARGE');
    return { realPath, data: buffer.subarray(0, length) };
  } catch (error) {
    throw mapFsError(error);
  } finally {
    await handle.close().catch(() => {});
  }
}

// A PDF, audio or video file opened for streaming: { realPath, size, range, head, stream }. `head` is the file's first bytes (its signature, already
// checked); `stream` reads exactly the range (the whole file when `range` is null) and is null for a HEAD request, a 416 range or an empty file.
// Shared by the in-process read and the child process of a dropped terminal user.
async function openRawFile(absolute, rangeHeader, { head: headOnly = false } = {}) {
  const { realPath, stat, handle } = await openChecked(absolute, 'raw');
  let streaming = false;
  try {
    const head = Buffer.alloc(RAW_SNIFF_BYTES);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (!rawMagicMatches(absolute, head.subarray(0, bytesRead))) throw fsFailure('FILE_UNSUPPORTED');
    const range = parseRange(rangeHeader, stat.size);
    let stream = null;
    if (!headOnly && range !== 'unsatisfiable' && stat.size > 0) {
      const { start, end } = range || { start: 0, end: stat.size - 1 };
      stream = handle.createReadStream({ start, end, autoClose: true });
      streaming = true;
    }
    return { realPath, size: stat.size, range, head: head.subarray(0, bytesRead), stream };
  } catch (error) {
    throw mapFsError(error);
  } finally {
    if (!streaming) await handle.close().catch(() => {});
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
    maxBytes: (LIMITS[kind] || MAX_TEXT_BYTES) + 64 * 1024,
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

// Runs a command whose output is one JSON header line and then a stream of bytes. Resolves { header, stream, kill } as soon as the header line
// has arrived (`header` is null when it is not JSON), or { timedOut } when it does not come within `timeoutMs`, or { error } when the command
// cannot start or ends without a header. After the header there is no time limit: the stream lasts as long as it is read, and destroying it kills
// the command.
const MAX_HEADER_BYTES = 64 * 1024;
function spawnStreamRunner({ command, args, uid, gid, cwd, env, timeoutMs }) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'ignore'], ...(uid !== undefined ? { uid, gid } : {}) });
    } catch (error) { resolve({ error }); return; }
    let settled = false;
    let pending = Buffer.alloc(0);
    const kill = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { kill(); finish({ timedOut: true }); }, timeoutMs);
    const onData = chunk => {
      pending = Buffer.concat([pending, chunk]);
      const newline = pending.indexOf(0x0a);
      if (newline < 0) {
        if (pending.length > MAX_HEADER_BYTES) { kill(); finish({ error: new Error('HEADER_TOO_LONG') }); }
        return;
      }
      child.stdout.off('data', onData);
      let header;
      try { header = JSON.parse(pending.subarray(0, newline).toString('utf8')); } catch { header = null; }
      const body = new PassThrough();
      const rest = pending.subarray(newline + 1);
      if (rest.length) body.write(rest);
      child.stdout.pipe(body);
      body.on('close', kill);
      finish({ header, stream: body, kill });
    };
    child.stdout.on('data', onData);
    child.on('error', error => finish({ error }));
    child.on('close', () => finish({ error: new Error('NO_HEADER') }));
  });
}

// Passes exactly `expected` bytes; more, or an end before them, fails the stream (the answer is then cut off instead of silently wrong).
function exactLength(expected) {
  let seen = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      seen += chunk.length;
      if (seen > expected) callback(fsFailure('FS_READ_FAILED'));
      else callback(null, chunk);
    },
    flush(callback) { callback(seen === expected ? null : fsFailure('FS_READ_FAILED')); },
  });
}

// The child's raw answer: one JSON line ({ realPath, size, range, head (base64 of the first bytes) } or { error }), then exactly the bytes of the range.
async function openRawAsUser(user, absolute, rangeHeader, headOnly, { streamRunner, timeoutMs }) {
  const result = await streamRunner({
    command: process.execPath,
    args: [CHILD_SCRIPT, 'raw', absolute, typeof rangeHeader === 'string' ? rangeHeader : '', headOnly ? 'head' : 'body'],
    uid: user.uid,
    gid: user.gid,
    cwd: '/',
    env: terminalEnvFor(user, { PATH: CHILD_PATH }),
    timeoutMs,
  });
  if (!result || result.error) throw fsFailure('FS_READ_FAILED', result && result.error);
  if (result.timedOut) throw fsFailure('READ_TIMEOUT');
  const { header, stream, kill } = result;
  const fail = code => { if (kill) kill(); if (stream) stream.destroy(); return fsFailure(code); };
  if (!header || typeof header !== 'object') throw fail('FS_READ_FAILED');
  if (header.error) throw fail(String(header.error));
  const { realPath, size } = header;
  if (typeof realPath !== 'string' || !path.posix.isAbsolute(realPath) || !Number.isSafeInteger(size) || size < 0) throw fail('FS_READ_FAILED');
  if (size > MAX_RAW_BYTES) throw fail('FILE_TOO_LARGE');
  if (!rawMagicMatches(absolute, Buffer.from(String(header.head || ''), 'base64'))) throw fail('FILE_UNSUPPORTED');
  const range = parseRange(rangeHeader, size);
  if (JSON.stringify(range) !== JSON.stringify(header.range === undefined ? null : header.range)) throw fail('FS_READ_FAILED');
  const expected = headOnly || range === 'unsatisfiable' ? 0 : range ? range.end - range.start + 1 : size;
  if (!expected) {
    if (kill) kill();
    if (stream) stream.destroy();
    return { realPath, size, range, stream: null };
  }
  const checked = exactLength(expected);
  stream.on('error', error => checked.destroy(error));
  checked.on('close', () => { if (!stream.destroyed) stream.destroy(); });
  return { realPath, size, range, stream: stream.pipe(checked) };
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
  streamRunner = spawnStreamRunner,
  timeoutMs = READ_TIMEOUT_MS,
  homeDir = () => process.env.HOME || os.homedir(),
} = {}) {
  function mapped(error, kind, requested) {
    const result = mapFsError(error);
    if (result.message === 'IS_DIRECTORY') result.path = requested;
    if (kind !== 'text') result.variant = kind;
    return result;
  }

  async function read(kind, value) {
    const user = terminalUser();
    const requested = requestedPath(value, user ? user.home : homeDir());
    try {
      const raw = user
        ? await readAsUser(user, requested, kind, { runner, timeoutMs })
        : await withTimeout(readRaw(requested, kind), timeoutMs);
      return finish(kind, requested, raw);
    } catch (error) {
      throw mapped(error, kind, requested);
    }
  }

  // A PDF, audio or video file for sendRaw (services/file-content.js): { path, realPath, type, kind, size, range, stream }.
  async function openRaw(value, { range, head = false } = {}) {
    const user = terminalUser();
    const requested = requestedPath(value, user ? user.home : homeDir());
    const declared = rawTypeOf(requested);
    try {
      if (!declared) throw fsFailure('FILE_UNSUPPORTED');
      let file;
      if (user) {
        file = await openRawAsUser(user, requested, range, head, { streamRunner, timeoutMs });
      } else {
        const opening = openRawFile(requested, range, { head });
        try { file = await withTimeout(opening, timeoutMs); }
        catch (error) {
          // A file opened after the time limit is closed again.
          opening.then(late => { if (late.stream) late.stream.destroy(); }, () => {});
          throw error;
        }
      }
      return { path: requested, realPath: file.realPath, ...declared, size: file.size, range: file.range, stream: file.stream };
    } catch (error) {
      throw mapped(error, 'raw', requested);
    }
  }

  return { readText: value => read('text', value), readImage: value => read('image', value), openRaw };
}

// The JSON body of an error answer: { error, message } and, for a folder, the path.
function errorBody(error) {
  const code = error && ERRORS[error.message] ? error.message : 'FS_READ_FAILED';
  const message = (error && VARIANT_MESSAGES[`${code}:${error.variant}`]) || ERRORS[code][1];
  return { status: ERRORS[code][0], body: { error: code, message, ...(error && error.path ? { path: error.path } : {}) } };
}

module.exports = {
  ERRORS,
  VARIANT_MESSAGES,
  READ_TIMEOUT_MS,
  CHILD_SCRIPT,
  requestedPath,
  isPseudoFile,
  readRaw,
  openRawFile,
  spawnRunner,
  spawnStreamRunner,
  fsFailure,
  createFsReader,
  errorBody,
};
