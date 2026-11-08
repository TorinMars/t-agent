// Preview of a file at any path (services/fs-read.js, routes/fs-read.js): path rules, regular files only, the text and image rules of the task
// files API, the read as the dropped terminal user (a child process with its uid/gid), and the local, Engine and proxy endpoints.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-fs-read-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'fs-read-test-secret-fs-read-test-secret-fs-read';

const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports(req, res, next) { req.session = { user: { login: 'owner' } }; next(); },
};

const express = require('express');
const fsRead = require('../services/fs-read');
const { MAX_TEXT_BYTES } = require('../services/file-content');

const { createFsReader, requestedPath, isPseudoFile, spawnRunner, spawnStreamRunner, CHILD_SCRIPT, ERRORS, VARIANT_MESSAGES } = fsRead;
const { PassThrough } = require('node:stream');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const home = path.join(root, 'home');
const files = path.join(root, 'files');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(files, 'folder'), { recursive: true });
const realFiles = fs.realpathSync(files);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 2)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(16, 3)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(8)]);

fs.writeFileSync(path.join(files, 'notes.md'), '# Notes\r\nline \u4e2d\u6587\r\n');
fs.writeFileSync(path.join(home, 'home.txt'), 'at home\n');
fs.writeFileSync(path.join(files, 'binary.txt'), Buffer.from([0x61, 0x00, 0x62]));
fs.writeFileSync(path.join(files, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
fs.writeFileSync(path.join(files, 'pic.png'), PNG);
fs.writeFileSync(path.join(files, 'pic.jpg'), JPEG);
fs.writeFileSync(path.join(files, 'pic.gif'), GIF);
fs.writeFileSync(path.join(files, 'pic.webp'), WEBP);
fs.writeFileSync(path.join(files, 'png-named.jpg'), PNG);
fs.writeFileSync(path.join(files, 'drawing.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
fs.writeFileSync(path.join(files, 'page.svg'), '<html><body><svg></svg></body></html>');
const SVG = Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<!-- icon -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>\n');
const BMP = Buffer.concat([Buffer.from('BM', 'latin1'), Buffer.alloc(30, 4)]);
const ICO = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(16, 5)]);
const AVIF = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypavif\0\0\0\0mif1miaf', 'latin1'), Buffer.alloc(8)]);
fs.writeFileSync(path.join(files, 'pic.svg'), SVG);
fs.writeFileSync(path.join(files, 'pic.bmp'), BMP);
fs.writeFileSync(path.join(files, 'pic.ico'), ICO);
fs.writeFileSync(path.join(files, 'pic.avif'), AVIF);
fs.writeFileSync(path.join(files, 'ico-named.bmp'), ICO);
fs.writeFileSync(path.join(files, 'mp4-named.avif'), Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypisom\0\0\0\0mp41', 'latin1')]));
{
  const descriptor = fs.openSync(path.join(files, 'huge.png'), 'w');
  fs.writeSync(descriptor, PNG);
  fs.ftruncateSync(descriptor, 20 * 1024 * 1024 + 1);
  fs.closeSync(descriptor);
}
fs.writeFileSync(path.join(files, 'medium.png'), Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]));
// Raw files (PDF, audio, video).
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.alloc(3000, 0x20), Buffer.from('\n%%EOF\n', 'latin1')]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypisom\0\0\0\0mp41', 'latin1'), Buffer.alloc(5000, 9)]);
const OGG = Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(100, 1)]);
fs.writeFileSync(path.join(files, 'doc.pdf'), PDF);
fs.writeFileSync(path.join(files, 'clip.mp4'), MP4);
fs.writeFileSync(path.join(files, 'voice.opus'), OGG);
fs.writeFileSync(path.join(files, 'fake.pdf'), 'not a pdf');
fs.symlinkSync(path.join(files, 'clip.mp4'), path.join(files, 'link.mp4'));
{
  const descriptor = fs.openSync(path.join(files, 'huge.mp4'), 'w');
  fs.writeSync(descriptor, MP4.subarray(0, 32));
  fs.ftruncateSync(descriptor, 200 * 1024 * 1024 + 1);
  fs.closeSync(descriptor);
}
fs.symlinkSync(path.join(files, 'notes.md'), path.join(files, 'link.md'));
fs.symlinkSync(path.join(files, 'nowhere.md'), path.join(files, 'dangling.md'));
fs.writeFileSync(path.join(files, 'secret.txt'), 'hidden\n');
fs.chmodSync(path.join(files, 'secret.txt'), 0o000);
{
  const descriptor = fs.openSync(path.join(files, 'large.txt'), 'w');
  fs.ftruncateSync(descriptor, MAX_TEXT_BYTES + 1);
  fs.closeSync(descriptor);
}
execFileSync('mkfifo', [path.join(files, 'pipe')]);
execFileSync('mkfifo', [path.join(files, 'pipe.mp4')]);

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const local = createFsReader({ terminalUser: () => null, homeDir: () => home });

async function failsWith(promise, code, status) {
  await assert.rejects(promise, error => {
    assert.equal(error.message, code);
    assert.equal(error.statusCode, status, `${code} status`);
    return true;
  });
}

test.after(() => {
  try { fs.chmodSync(path.join(files, 'secret.txt'), 0o600); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
});

test('paths: absolute or ~ / ~/..., normalized; relative, ~user, empty, NUL and non-strings are BAD_PATH', () => {
  assert.equal(requestedPath('/a/b/../c/', '/home/dev'), '/a/c');
  assert.equal(requestedPath('~', '/home/dev'), '/home/dev');
  assert.equal(requestedPath('~/', '/home/dev'), '/home/dev');
  assert.equal(requestedPath('~/x/\u65e5\u672c.md', '/home/dev'), '/home/dev/x/\u65e5\u672c.md');
  assert.equal(requestedPath('/a\\b', '/home/dev'), '/a\\b', 'a backslash is an ordinary character of a POSIX name');
  for (const bad of ['a.md', './a.md', '../a', '~dev/a', '~other', '', 'C:\\x', '/a\0b', undefined, null, ['/a', '/b'], 7]) {
    assert.throws(() => requestedPath(bad, '/home/dev'), error => error.message === 'BAD_PATH' && error.statusCode === 400, String(bad));
  }
  assert.throws(() => requestedPath('~/a', ''), /BAD_PATH/, 'no home, no ~');
});

test('text: an absolute path answers the shape of <task>/files/content plus realPath', async () => {
  const file = path.join(files, 'notes.md');
  const result = await local.readText(file);
  assert.deepEqual(Object.keys(result), ['path', 'realPath', 'content', 'revision', 'eol', 'bom']);
  assert.equal(result.path, file);
  assert.equal(result.realPath, path.join(realFiles, 'notes.md'));
  assert.equal(result.content, '# Notes\nline \u4e2d\u6587\n');
  assert.equal(result.eol, '\r\n');
  assert.equal(result.bom, false);
  assert.match(result.revision, /^[0-9a-f]{64}$/);
});

test('text: ~/ is the terminal user home, symbolic links are followed (realPath names the target)', async () => {
  const atHome = await local.readText('~/home.txt');
  assert.equal(atHome.path, path.join(home, 'home.txt'));
  assert.equal(atHome.content, 'at home\n');
  const linked = await local.readText(path.join(files, 'link.md'));
  assert.equal(linked.path, path.join(files, 'link.md'));
  assert.equal(linked.realPath, path.join(realFiles, 'notes.md'));
  assert.equal(linked.content, '# Notes\nline \u4e2d\u6587\n');
});

test('folders, FIFOs and devices are refused; a FIFO never makes the read wait', async () => {
  await assert.rejects(local.readText(path.join(files, 'folder') + '/'), error => {
    assert.equal(error.message, 'IS_DIRECTORY');
    assert.equal(error.statusCode, 400);
    assert.equal(error.path, path.join(files, 'folder'), 'the folder is named in the error, normalized');
    return true;
  });
  await failsWith(local.readText('~'), 'IS_DIRECTORY', 400);
  const started = Date.now();
  await failsWith(local.readText(path.join(files, 'pipe')), 'NOT_A_REGULAR_FILE', 400);
  await failsWith(local.readImage(path.join(files, 'pipe')), 'NOT_A_REGULAR_FILE', 400);
  assert.ok(Date.now() - started < 2000, 'answered at once');
  await failsWith(local.readText('/dev/zero'), 'NOT_A_REGULAR_FILE', 400);
  await failsWith(local.readText('/dev/null'), 'NOT_A_REGULAR_FILE', 400);
});

test('empty /proc and /sys files are refused as pseudo files', async () => {
  assert.equal(isPseudoFile('/proc/self/status', { size: 0 }), true);
  assert.equal(isPseudoFile('/sys/kernel/mm/x', { size: 0 }), true);
  assert.equal(isPseudoFile('/proc', { size: 0 }), true);
  assert.equal(isPseudoFile('/proc/self/status', { size: 12 }), false, 'a sized /proc file reads normally');
  assert.equal(isPseudoFile('/process/a', { size: 0 }), false);
  assert.equal(isPseudoFile('/home/a/empty.txt', { size: 0 }), false);
  if (process.platform === 'linux' && fs.existsSync('/proc/self/status')) {
    await failsWith(local.readText('/proc/self/status'), 'NOT_A_REGULAR_FILE', 400);
  }
  fs.writeFileSync(path.join(files, 'empty.txt'), '');
  assert.equal((await local.readText(path.join(files, 'empty.txt'))).content, '', 'an ordinary empty file is fine');
});

test('missing, dangling, too large, binary, not UTF-8 and unreadable files get the files API codes', async () => {
  await failsWith(local.readText(path.join(files, 'missing.md')), 'NOT_FOUND', 404);
  await failsWith(local.readText(path.join(files, 'notes.md', 'below')), 'NOT_FOUND', 404);
  await failsWith(local.readText(path.join(files, 'dangling.md')), 'NOT_FOUND', 404);
  await failsWith(local.readText(path.join(files, 'large.txt')), 'FILE_TOO_LARGE', 413);
  await failsWith(local.readText(path.join(files, 'binary.txt')), 'FILE_UNSUPPORTED', 415);
  await failsWith(local.readText(path.join(files, 'latin1.txt')), 'FILE_UNSUPPORTED', 415);
  await failsWith(local.readText(path.join(files, 'pic.png')), 'FILE_UNSUPPORTED', 415);
  if (!isRoot) await failsWith(local.readText(path.join(files, 'secret.txt')), 'PERMISSION_DENIED', 403);
});

test('images: PNG, JPEG, GIF, WebP, SVG, BMP, ICO and AVIF by name and content; a wrong name or content is refused', async () => {
  for (const [name, type, bytes] of [
    ['pic.png', 'image/png', PNG], ['pic.jpg', 'image/jpeg', JPEG], ['pic.gif', 'image/gif', GIF], ['pic.webp', 'image/webp', WEBP],
    ['pic.svg', 'image/svg+xml', SVG], ['pic.bmp', 'image/bmp', BMP], ['pic.ico', 'image/x-icon', ICO], ['pic.avif', 'image/avif', AVIF],
    ['medium.png', 'image/png', null],
  ]) {
    const image = await local.readImage(path.join(files, name));
    assert.equal(image.type, type, name);
    if (bytes) assert.deepEqual(image.data, bytes, name);
    assert.equal(image.realPath, path.join(realFiles, name));
  }
  await failsWith(local.readImage(path.join(files, 'png-named.jpg')), 'FILE_NOT_IMAGE', 415);
  // An SVG with a script is still an image: the answer is sandboxed and the page shows it only through <img>.
  assert.equal((await local.readImage(path.join(files, 'drawing.svg'))).type, 'image/svg+xml');
  await failsWith(local.readImage(path.join(files, 'page.svg')), 'FILE_NOT_IMAGE', 415);
  await failsWith(local.readImage(path.join(files, 'ico-named.bmp')), 'FILE_NOT_IMAGE', 415);
  await failsWith(local.readImage(path.join(files, 'mp4-named.avif')), 'FILE_NOT_IMAGE', 415);
  await failsWith(local.readImage(path.join(files, 'huge.png')), 'FILE_TOO_LARGE', 413);
  await failsWith(local.readImage(path.join(files, 'notes.md')), 'FILE_NOT_IMAGE', 415);
  await failsWith(local.readImage(path.join(files, 'missing.png')), 'NOT_FOUND', 404);
});

test('raw: PDF, audio and video open as a stream of the whole file or one range, by name and signature', async () => {
  const pdf = await local.openRaw(path.join(files, 'doc.pdf'));
  assert.deepEqual({ ...pdf, stream: undefined }, {
    path: path.join(files, 'doc.pdf'), realPath: path.join(realFiles, 'doc.pdf'), type: 'application/pdf', kind: 'pdf', size: PDF.length, range: null, stream: undefined,
  });
  assert.deepEqual(await collect(pdf.stream), PDF);
  const part = await local.openRaw(path.join(files, 'clip.mp4'), { range: 'bytes=10-29' });
  assert.equal(part.kind, 'video');
  assert.deepEqual(part.range, { start: 10, end: 29 });
  assert.deepEqual(await collect(part.stream), MP4.subarray(10, 30));
  const linked = await local.openRaw(path.join(files, 'link.mp4'), { range: 'bytes=-5' });
  assert.equal(linked.realPath, path.join(realFiles, 'clip.mp4'), 'symbolic links are followed, as for text');
  assert.deepEqual(await collect(linked.stream), MP4.subarray(MP4.length - 5));
  const voice = await local.openRaw(path.join(files, 'voice.opus'));
  assert.deepEqual([voice.type, voice.kind], ['audio/ogg', 'audio']);
  voice.stream.destroy();
  const head = await local.openRaw(path.join(files, 'clip.mp4'), { head: true });
  assert.equal(head.stream, null);
  assert.equal(head.size, MP4.length);
  const outside = await local.openRaw(path.join(files, 'clip.mp4'), { range: `bytes=${MP4.length}-` });
  assert.equal(outside.range, 'unsatisfiable');
  assert.equal(outside.stream, null);

  await failsWith(local.openRaw(path.join(files, 'fake.pdf')), 'FILE_UNSUPPORTED', 415);
  await failsWith(local.openRaw(path.join(files, 'notes.md')), 'FILE_UNSUPPORTED', 415);
  await failsWith(local.openRaw(path.join(files, 'pic.png')), 'FILE_UNSUPPORTED', 415);
  await failsWith(local.openRaw(path.join(files, 'huge.mp4')), 'FILE_TOO_LARGE', 413);
  await failsWith(local.openRaw(path.join(files, 'pipe.mp4')), 'NOT_A_REGULAR_FILE', 400);
  await failsWith(local.openRaw(path.join(files, 'missing.mp4')), 'NOT_FOUND', 404);
  await failsWith(local.openRaw('relative.pdf'), 'BAD_PATH', 400);
  await assert.rejects(local.openRaw(path.join(files, 'huge.mp4')), error => error.variant === 'raw', 'the raw messages are used');
});

// ── The dropped terminal user: a child process runs with that uid/gid ──

const DEV = { name: 'dev', uid: 1234, gid: 2345, home: '/home/dev' };
function fakeRunner(answer) {
  const calls = [];
  const runner = async options => { calls.push(options); return typeof answer === 'function' ? answer(options) : answer; };
  return { calls, runner };
}
const frame = (header, data = Buffer.alloc(0)) => ({ code: 0, stdout: Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), data]) });

test('dropped user: the child is spawned with its uid, gid and home, without the service secrets', async () => {
  const body = Buffer.from('hello\n');
  const { calls, runner } = fakeRunner(frame({ realPath: '/home/dev/real.md', length: body.length }, body));
  const reader = createFsReader({ terminalUser: () => DEV, runner, timeoutMs: 1234 });
  const result = await reader.readText('~/notes.md');
  assert.deepEqual(result, {
    path: '/home/dev/notes.md', realPath: '/home/dev/real.md', content: 'hello\n',
    revision: require('node:crypto').createHash('sha256').update(body).digest('hex'), eol: '\n', bom: false,
  });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.command, process.execPath);
  assert.deepEqual(call.args, [CHILD_SCRIPT, 'text', '/home/dev/notes.md']);
  assert.equal(call.uid, 1234);
  assert.equal(call.gid, 2345);
  assert.equal(call.cwd, '/');
  assert.equal(call.timeoutMs, 1234);
  assert.equal(call.env.HOME, '/home/dev');
  assert.equal(call.env.USER, 'dev');
  assert.equal(call.env.SESSION_SECRET, undefined);
  assert.equal(call.env.NODE_OPTIONS, undefined, 'only a minimal environment is passed');
  assert.ok(call.maxBytes > MAX_TEXT_BYTES);

  const image = createFsReader({ terminalUser: () => DEV, runner: fakeRunner(frame({ realPath: '/x/p.png', length: PNG.length }, PNG)).runner });
  assert.deepEqual((await image.readImage('/x/p.png')).data, PNG);
});

test('dropped user: the child answers and failures are mapped to the API codes', async () => {
  const read = (answer, value = '/srv/a.md', kind = 'readText') => createFsReader({ terminalUser: () => DEV, runner: fakeRunner(answer).runner })[kind](value);
  await failsWith(read(frame({ error: 'PERMISSION_DENIED' })), 'PERMISSION_DENIED', 403);
  await failsWith(read(frame({ error: 'NOT_FOUND' })), 'NOT_FOUND', 404);
  await failsWith(read(frame({ error: 'NOT_A_REGULAR_FILE' })), 'NOT_A_REGULAR_FILE', 400);
  await assert.rejects(read(frame({ error: 'IS_DIRECTORY' }), '/srv/dir/'), error => error.message === 'IS_DIRECTORY' && error.path === '/srv/dir');
  await failsWith(read(frame({ error: 'SOMETHING_ELSE' })), 'FS_READ_FAILED', 500);
  await failsWith(read({ timedOut: true, code: null, signal: 'SIGKILL', stdout: Buffer.alloc(0) }), 'READ_TIMEOUT', 504);
  await failsWith(read({ overflow: true, code: null, signal: 'SIGKILL', stdout: Buffer.alloc(0) }), 'FILE_TOO_LARGE', 413);
  await failsWith(read({ error: Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }) }), 'FS_READ_FAILED', 500);
  await failsWith(read({ code: 1, stdout: Buffer.from('Error: cannot find module\n') }), 'FS_READ_FAILED', 500);
  await failsWith(read({ code: 0, stdout: Buffer.alloc(0) }), 'FS_READ_FAILED', 500);
  await failsWith(read(frame({ realPath: '/srv/a.md', length: 10 }, Buffer.from('short'))), 'FS_READ_FAILED', 500);
  await failsWith(read(frame({ realPath: 'relative', length: 1 }, Buffer.from('x'))), 'FS_READ_FAILED', 500);
  await failsWith(read(frame({ realPath: '/srv/a.md', length: 3 }, Buffer.from([0x61, 0, 0x62]))), 'FILE_UNSUPPORTED', 415);
  await failsWith(read(frame({ realPath: '/srv/a.png', length: JPEG.length }, JPEG), '/srv/a.png', 'readImage'), 'FILE_NOT_IMAGE', 415);
  await failsWith(read(frame({}), 'relative.md'), 'BAD_PATH', 400);
});

// The real child script and spawn runner, with this process's own uid/gid (the tests cannot run as root, so no real drop happens).
test('dropped user: the real child script reads with the same answers as the in-process read', async t => {
  if (typeof process.getuid !== 'function') return t.skip('no uid on this platform');
  const self = { name: os.userInfo().username, uid: process.getuid(), gid: process.getgid(), home };
  const child = createFsReader({ terminalUser: () => self, runner: spawnRunner });
  for (const value of [path.join(files, 'notes.md'), path.join(files, 'link.md'), '~/home.txt']) {
    assert.deepEqual(await child.readText(value), await local.readText(value), value);
  }
  assert.deepEqual(await child.readImage(path.join(files, 'pic.webp')), await local.readImage(path.join(files, 'pic.webp')));
  await assert.rejects(child.readText(path.join(files, 'folder')), error => error.message === 'IS_DIRECTORY' && error.path === path.join(files, 'folder'));
  await failsWith(child.readText(path.join(files, 'pipe')), 'NOT_A_REGULAR_FILE', 400);
  await failsWith(child.readText('/dev/zero'), 'NOT_A_REGULAR_FILE', 400);
  await failsWith(child.readText(path.join(files, 'missing.md')), 'NOT_FOUND', 404);
  await failsWith(child.readText(path.join(files, 'large.txt')), 'FILE_TOO_LARGE', 413);
  await failsWith(child.readText(path.join(files, 'binary.txt')), 'FILE_UNSUPPORTED', 415);
  await failsWith(child.readImage(path.join(files, 'page.svg')), 'FILE_NOT_IMAGE', 415);
  await failsWith(child.readImage(path.join(files, 'huge.png')), 'FILE_TOO_LARGE', 413);
  assert.deepEqual(await child.readImage(path.join(files, 'medium.png')), await local.readImage(path.join(files, 'medium.png')), 'the child may send 20 MiB');
  if (!isRoot) await failsWith(child.readText(path.join(files, 'secret.txt')), 'PERMISSION_DENIED', 403);
});

function fakeStream(answer) {
  const calls = [];
  const streamRunner = async options => { calls.push(options); return typeof answer === 'function' ? answer(options) : answer; };
  return { calls, streamRunner };
}
const rawFrame = (header, data) => {
  const stream = new PassThrough();
  stream.end(data || Buffer.alloc(0));
  return { header, stream, kill() {} };
};
const mp4Head = MP4.subarray(0, 16).toString('base64');

test('dropped user: a raw file is streamed by the child, checked by the parent, without a time limit after the header', async () => {
  const { calls, streamRunner } = fakeStream(rawFrame({ realPath: '/home/dev/real.mp4', size: MP4.length, range: { start: 4, end: 11 }, head: mp4Head }, MP4.subarray(4, 12)));
  const reader = createFsReader({ terminalUser: () => DEV, streamRunner, timeoutMs: 4321 });
  const file = await reader.openRaw('~/clip.mp4', { range: 'bytes=4-11' });
  assert.deepEqual([file.path, file.realPath, file.type, file.size], ['/home/dev/clip.mp4', '/home/dev/real.mp4', 'video/mp4', MP4.length]);
  assert.deepEqual(await collect(file.stream), MP4.subarray(4, 12));
  const [call] = calls;
  assert.deepEqual(call.args, [CHILD_SCRIPT, 'raw', '/home/dev/clip.mp4', 'bytes=4-11', 'body']);
  assert.deepEqual([call.uid, call.gid, call.cwd, call.timeoutMs, call.env.HOME, call.env.SESSION_SECRET], [1234, 2345, '/', 4321, '/home/dev', undefined]);

  const headRunner = fakeStream(rawFrame({ realPath: '/x/a.mp4', size: MP4.length, range: null, head: mp4Head }));
  const head = await createFsReader({ terminalUser: () => DEV, streamRunner: headRunner.streamRunner }).openRaw('/x/a.mp4', { head: true });
  assert.equal(head.stream, null);
  assert.equal(headRunner.calls[0].args[3], '', 'no Range header');
  assert.equal(headRunner.calls[0].args[4], 'head');

  const open = (answer, value = '/x/a.mp4', options = {}) => createFsReader({ terminalUser: () => DEV, streamRunner: fakeStream(answer).streamRunner }).openRaw(value, options);
  await failsWith(open(rawFrame({ error: 'PERMISSION_DENIED' })), 'PERMISSION_DENIED', 403);
  await failsWith(open(rawFrame({ error: 'FILE_TOO_LARGE' })), 'FILE_TOO_LARGE', 413);
  await failsWith(open({ timedOut: true }), 'READ_TIMEOUT', 504);
  await failsWith(open({ error: new Error('NO_HEADER') }), 'FS_READ_FAILED', 500);
  await failsWith(open(rawFrame(null)), 'FS_READ_FAILED', 500);
  await failsWith(open(rawFrame({ realPath: 'relative', size: 1, range: null, head: mp4Head })), 'FS_READ_FAILED', 500);
  await failsWith(open(rawFrame({ realPath: '/x/a.mp4', size: 300 * 1024 * 1024, range: null, head: mp4Head })), 'FILE_TOO_LARGE', 413);
  await failsWith(open(rawFrame({ realPath: '/x/a.mp4', size: 100, range: null, head: Buffer.from('%PDF-1.4').toString('base64') })), 'FILE_UNSUPPORTED', 415);
  await failsWith(open(rawFrame({ realPath: '/x/a.mp4', size: 100, range: { start: 0, end: 9 }, head: mp4Head }), '/x/a.mp4', { range: 'bytes=0-4' }), 'FS_READ_FAILED', 500);
  await failsWith(open(rawFrame({}), '/x/a.txt'), 'FILE_UNSUPPORTED', 415);
  // A child that sends fewer (or more) bytes than the range makes the stream fail, so the answer is cut off rather than wrong.
  const short = await open(rawFrame({ realPath: '/x/a.mp4', size: 100, range: null, head: mp4Head }, Buffer.alloc(50)));
  await assert.rejects(collect(short.stream), /FS_READ_FAILED/);
  const long = await open(rawFrame({ realPath: '/x/a.mp4', size: 10, range: null, head: mp4Head }, Buffer.alloc(50)));
  await assert.rejects(collect(long.stream), /FS_READ_FAILED/);
});

test('dropped user: the real child streams raw files like the in-process read and stops when the answer closes', async t => {
  if (typeof process.getuid !== 'function') return t.skip('no uid on this platform');
  const self = { name: os.userInfo().username, uid: process.getuid(), gid: process.getgid(), home };
  const child = createFsReader({ terminalUser: () => self });
  for (const [value, range] of [[path.join(files, 'doc.pdf')], [path.join(files, 'clip.mp4'), 'bytes=100-199'], [path.join(files, 'link.mp4'), 'bytes=-3']]) {
    const [mine, theirs] = [await local.openRaw(value, { range }), await child.openRaw(value, { range })];
    assert.deepEqual({ ...theirs, stream: null }, { ...mine, stream: null }, value);
    assert.deepEqual(await collect(theirs.stream), await collect(mine.stream), value);
  }
  assert.equal((await child.openRaw(path.join(files, 'clip.mp4'), { range: 'bytes=999999-' })).range, 'unsatisfiable');
  assert.equal((await child.openRaw(path.join(files, 'clip.mp4'), { head: true })).stream, null);
  await failsWith(child.openRaw(path.join(files, 'fake.pdf')), 'FILE_UNSUPPORTED', 415);
  await failsWith(child.openRaw(path.join(files, 'huge.mp4')), 'FILE_TOO_LARGE', 413);
  await failsWith(child.openRaw(path.join(files, 'pipe.mp4')), 'NOT_A_REGULAR_FILE', 400);
  await failsWith(child.openRaw(path.join(files, 'missing.mp4')), 'NOT_FOUND', 404);

  // A long stream is not killed by the 10 s first-byte limit, and destroying it kills the child.
  const big = path.join(root, 'long.mp4');
  fs.writeFileSync(big, Buffer.concat([MP4.subarray(0, 32), Buffer.alloc(8 * 1024 * 1024)]));
  const slow = createFsReader({ terminalUser: () => self, timeoutMs: 2000 });
  const started = await slow.openRaw(big);
  let received = 0;
  for await (const chunk of started.stream) {
    received += chunk.length;
    if (received === chunk.length) await new Promise(resolve => setTimeout(resolve, 2500));
    if (received > 1024 * 1024) break;
  }
  assert.ok(received > 1024 * 1024, 'still streaming after the first-byte limit');
});

test('the stream runner gives up without a header in time and kills the command when the stream is destroyed', async () => {
  const silent = await spawnStreamRunner({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 5000)'], cwd: '/', env: {}, timeoutMs: 200 });
  assert.equal(silent.timedOut, true);
  const none = await spawnStreamRunner({ command: process.execPath, args: ['-e', 'process.stdout.write("no newline")'], cwd: '/', env: {}, timeoutMs: 5000 });
  assert.ok(none.error);
  const missing = await spawnStreamRunner({ command: path.join(root, 'no-such-binary'), args: [], cwd: '/', env: {}, timeoutMs: 1000 });
  assert.ok(missing.error);
  const endless = await spawnStreamRunner({
    command: process.execPath,
    args: ['-e', 'process.stdout.write(JSON.stringify({ pid: process.pid }) + "\\nabc"); setInterval(() => process.stdout.write("x"), 10)'],
    cwd: '/', env: {}, timeoutMs: 5000,
  });
  assert.ok(Number.isInteger(endless.header.pid));
  const first = await new Promise(resolve => endless.stream.once('data', resolve));
  assert.equal(first.toString().slice(0, 3), 'abc');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.doesNotThrow(() => process.kill(endless.header.pid, 0), 'no time limit once the header has come');
  endless.stream.destroy();
  let alive = true;
  for (let tries = 0; alive && tries < 50; tries += 1) {
    await new Promise(resolve => setTimeout(resolve, 20));
    try { process.kill(endless.header.pid, 0); } catch { alive = false; }
  }
  assert.equal(alive, false, 'destroying the stream kills the command');
});

test('the spawn runner kills a child that runs too long or prints too much', async () => {
  const slow = await spawnRunner({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 5000)'], cwd: '/', env: {}, timeoutMs: 200, maxBytes: 10 });
  assert.equal(slow.timedOut, true);
  const loud = await spawnRunner({ command: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(100000))'], cwd: '/', env: {}, timeoutMs: 5000, maxBytes: 1000 });
  assert.equal(loud.overflow, true);
  assert.ok(loud.stdout.length <= 1000);
  const missing = await spawnRunner({ command: path.join(root, 'no-such-binary'), args: [], cwd: '/', env: {}, timeoutMs: 1000, maxBytes: 10 });
  assert.ok(missing.error);
});

test('every error message of the API has a Chinese translation', () => {
  const JS = path.join(__dirname, '..', 'public', 'js');
  const sandbox = { localStorage: { getItem: () => 'zh', setItem() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['i18n.js', 'i18n-zh-ui.js', 'i18n-zh-server.js', 'i18n-zh-extra.js']) vm.runInContext(fs.readFileSync(path.join(JS, file), 'utf8'), sandbox);
  const missing = [...Object.values(ERRORS).map(([, message]) => message), ...Object.values(VARIANT_MESSAGES)].filter(message => sandbox.I18n.t(message) === message);
  assert.deepEqual(missing, []);
});

// ── HTTP: local /api/fs, Engine /v1/fs, proxy /api/remote-servers/:id/fs ──

const servers = [];
function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('listening', () => { servers.push(server); resolve(`http://127.0.0.1:${server.address().port}`); });
    server.once('error', reject);
  });
}
let localBase, engineBase, proxyBase, token, remoteId, oldId, db;

test.before(async () => {
  db = require('../db');
  const { createAccessToken } = require('../services/engine-auth');
  const { encryptToken } = require('../lib/token-crypto');
  const { createFsReadRouter } = require('../routes/fs-read');
  const localApp = express();
  localApp.use('/api/fs', createFsReadRouter());
  localBase = await listen(localApp);
  const engineApp = express();
  engineApp.use(express.json());
  engineApp.use('/v1', require('../routes/engine-v1'));
  engineBase = await listen(engineApp);
  token = createAccessToken(db, { role: 'operator', principalId: 'owner' }).token;
  remoteId = db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
    .run('owner', 'engine', engineBase, encryptToken(token, process.env.SESSION_SECRET)).lastInsertRowid;
  // An Engine from before this feature: /v1/info without 'fs:read-any'.
  const oldApp = express();
  oldApp.get('/v1/info', (req, res) => res.json({ capabilities: ['files:read'] }));
  const oldBase = await listen(oldApp);
  oldId = db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
    .run('owner', 'old', oldBase, encryptToken(token, process.env.SESSION_SECRET)).lastInsertRowid;
  const proxyApp = express();
  proxyApp.use(express.json());
  proxyApp.use('/api/remote-servers', require('../routes/remote-servers'));
  proxyBase = await listen(proxyApp);
});

test.after(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); })));
  if (db) db.close();
});

const routes = () => [
  { name: 'local', url: kind => `${localBase}/api/fs/${kind}`, headers: {} },
  { name: 'engine', url: kind => `${engineBase}/v1/fs/${kind}`, headers: { Authorization: `Bearer ${token}` } },
  { name: 'proxy', url: kind => `${proxyBase}/api/remote-servers/${remoteId}/fs/${kind}`, headers: {} },
];
const get = (route, kind, value) => fetch(`${route.url(kind)}?path=${encodeURIComponent(value)}`, { headers: route.headers });

test('HTTP: the three routes answer text, images and errors alike; remote answers are sandboxed', async () => {
  for (const route of routes()) {
    const text = await get(route, 'content', path.join(files, 'notes.md'));
    assert.equal(text.status, 200, route.name);
    const body = await text.json();
    assert.equal(body.content, '# Notes\nline \u4e2d\u6587\n', route.name);
    assert.equal(body.realPath, path.join(realFiles, 'notes.md'), route.name);
    const image = await get(route, 'image', path.join(files, 'pic.png'));
    assert.equal(image.status, 200, route.name);
    assert.equal(image.headers.get('content-type'), 'image/png', route.name);
    assert.equal(image.headers.get('content-security-policy'), 'sandbox', route.name);
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff', route.name);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG, route.name);
    if (route.name === 'proxy') assert.equal(text.headers.get('content-security-policy'), 'sandbox', 'the proxied text answer is sandboxed too');

    const folder = await get(route, 'content', path.join(files, 'folder'));
    assert.equal(folder.status, 400, route.name);
    assert.deepEqual(await folder.json(), { error: 'IS_DIRECTORY', message: 'This path is a folder', path: path.join(files, 'folder') }, route.name);
    for (const [value, status, code, kind = 'content'] of [
      ['relative.md', 400, 'BAD_PATH'],
      [path.join(files, 'pipe'), 400, 'NOT_A_REGULAR_FILE'],
      [path.join(files, 'missing.md'), 404, 'NOT_FOUND'],
      [path.join(files, 'large.txt'), 413, 'FILE_TOO_LARGE'],
      [path.join(files, 'binary.txt'), 415, 'FILE_UNSUPPORTED'],
      [path.join(files, 'page.svg'), 415, 'FILE_NOT_IMAGE', 'image'],
      ...(isRoot ? [] : [[path.join(files, 'secret.txt'), 403, 'PERMISSION_DENIED']]),
    ]) {
      const response = await get(route, kind, value);
      assert.equal(response.status, status, `${route.name} ${code}`);
      const error = await response.json();
      assert.equal(error.error, code, route.name);
      assert.equal(error.message, ERRORS[code][1], route.name);
    }
    const none = await fetch(route.url('content'), { headers: route.headers });
    assert.equal(none.status, 400, `${route.name}: no path`);
    assert.equal((await none.json()).error, 'BAD_PATH');
  }
});

test('HTTP: the Engine needs a token, advertises fs:read-any, and the proxy refuses an Engine without it', async () => {
  assert.equal((await fetch(`${engineBase}/v1/fs/content?path=/etc/hosts`)).status, 401);
  assert.equal((await fetch(`${engineBase}/v1/fs/image?path=/x.png`, { headers: { Authorization: 'Bearer nope' } })).status, 401);
  const info = await (await fetch(`${engineBase}/v1/info`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.ok(info.capabilities.includes('fs:read-any'));
  assert.ok(info.capabilities.includes('files:read'));
  for (const kind of ['content', 'image']) {
    const response = await fetch(`${proxyBase}/api/remote-servers/${oldId}/fs/${kind}?path=/etc/hosts`);
    assert.equal(response.status, 501, kind);
    assert.deepEqual(await response.json(), { error: 'FS_READ_UNSUPPORTED' });
  }
  assert.equal((await fetch(`${proxyBase}/api/remote-servers/999999/fs/content?path=/etc/hosts`)).status, 404);
});

test('HTTP: raw files stream on the three routes with Range support, the PDF exception to the sandbox, and API errors', async () => {
  for (const route of routes()) {
    const raw = (value, extra = {}, method = 'GET') => fetch(`${route.url('raw')}?path=${encodeURIComponent(value)}`, { method, headers: { ...route.headers, ...extra } });
    const pdf = await raw(path.join(files, 'doc.pdf'));
    assert.equal(pdf.status, 200, route.name);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf', route.name);
    assert.equal(pdf.headers.get('content-security-policy'), null, `${route.name}: a sandboxed PDF is not shown by Chrome`);
    assert.equal(pdf.headers.get('content-disposition'), 'inline', route.name);
    assert.equal(pdf.headers.get('x-content-type-options'), 'nosniff', route.name);
    assert.equal(pdf.headers.get('cache-control'), 'private, no-cache', route.name);
    assert.equal(pdf.headers.get('accept-ranges'), 'bytes', route.name);
    assert.deepEqual(Buffer.from(await pdf.arrayBuffer()), PDF, route.name);

    const video = await raw(path.join(files, 'clip.mp4'), { Range: 'bytes=1000-1999' });
    assert.equal(video.status, 206, route.name);
    assert.equal(video.headers.get('content-type'), 'video/mp4', route.name);
    assert.equal(video.headers.get('content-range'), `bytes 1000-1999/${MP4.length}`, route.name);
    assert.equal(video.headers.get('content-length'), '1000', route.name);
    assert.equal(video.headers.get('content-security-policy'), 'sandbox', route.name);
    assert.deepEqual(Buffer.from(await video.arrayBuffer()), MP4.subarray(1000, 2000), route.name);

    const head = await raw(path.join(files, 'clip.mp4'), {}, 'HEAD');
    assert.equal(head.status, 200, route.name);
    assert.equal(head.headers.get('content-length'), String(MP4.length), route.name);

    const outside = await raw(path.join(files, 'clip.mp4'), { Range: 'bytes=999999-' });
    assert.equal(outside.status, 416, route.name);
    assert.equal(outside.headers.get('content-range'), `bytes */${MP4.length}`, route.name);
    assert.deepEqual(await outside.json(), { error: 'RANGE_NOT_SATISFIABLE', message: ERRORS.RANGE_NOT_SATISFIABLE[1] }, route.name);

    for (const [value, status, code, message] of [
      [path.join(files, 'fake.pdf'), 415, 'FILE_UNSUPPORTED', VARIANT_MESSAGES['FILE_UNSUPPORTED:raw']],
      [path.join(files, 'notes.md'), 415, 'FILE_UNSUPPORTED', VARIANT_MESSAGES['FILE_UNSUPPORTED:raw']],
      [path.join(files, 'huge.mp4'), 413, 'FILE_TOO_LARGE', VARIANT_MESSAGES['FILE_TOO_LARGE:raw']],
      [path.join(files, 'missing.mp4'), 404, 'NOT_FOUND', ERRORS.NOT_FOUND[1]],
      [path.join(files, 'pipe.mp4'), 400, 'NOT_A_REGULAR_FILE', ERRORS.NOT_A_REGULAR_FILE[1]],
      ['relative.pdf', 400, 'BAD_PATH', ERRORS.BAD_PATH[1]],
    ]) {
      const response = await raw(value);
      assert.equal(response.status, status, `${route.name} ${value}`);
      assert.deepEqual(await response.json(), { error: code, message }, `${route.name} ${value}`);
      if (route.name === 'proxy') assert.equal(response.headers.get('content-security-policy'), 'sandbox', 'a proxied error keeps the sandbox');
    }

    const image = await get(route, 'image', path.join(files, 'pic.svg'));
    assert.equal(image.status, 200, route.name);
    assert.equal(image.headers.get('content-type'), 'image/svg+xml', route.name);
    assert.equal(image.headers.get('content-security-policy'), 'sandbox', route.name);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), SVG, route.name);
    const tooBig = await get(route, 'image', path.join(files, 'huge.png'));
    assert.equal(tooBig.status, 413, route.name);
    assert.deepEqual(await tooBig.json(), { error: 'FILE_TOO_LARGE', message: VARIANT_MESSAGES['FILE_TOO_LARGE:image'] }, route.name);
  }
});

test('HTTP: the Engine advertises files:raw and the proxy answers RAW_UNSUPPORTED for an Engine without it', async () => {
  const info = await (await fetch(`${engineBase}/v1/info`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.ok(info.capabilities.includes('files:raw'));
  assert.equal((await fetch(`${engineBase}/v1/fs/raw?path=/x.pdf`)).status, 401);
  const response = await fetch(`${proxyBase}/api/remote-servers/${oldId}/fs/raw?path=/x.pdf`);
  assert.equal(response.status, 501);
  assert.deepEqual(await response.json(), { error: 'RAW_UNSUPPORTED' });
});
