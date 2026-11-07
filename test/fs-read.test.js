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

const { createFsReader, requestedPath, isPseudoFile, spawnRunner, CHILD_SCRIPT, ERRORS } = fsRead;
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

test('images: PNG, JPEG, GIF and WebP by name and content; SVG and a wrong name are refused', async () => {
  for (const [name, type, bytes] of [['pic.png', 'image/png', PNG], ['pic.jpg', 'image/jpeg', JPEG], ['pic.gif', 'image/gif', GIF], ['pic.webp', 'image/webp', WEBP]]) {
    const image = await local.readImage(path.join(files, name));
    assert.equal(image.type, type, name);
    assert.deepEqual(image.data, bytes, name);
    assert.equal(image.realPath, path.join(realFiles, name));
  }
  await failsWith(local.readImage(path.join(files, 'png-named.jpg')), 'FILE_NOT_IMAGE', 415);
  await failsWith(local.readImage(path.join(files, 'drawing.svg')), 'FILE_NOT_IMAGE', 415);
  await failsWith(local.readImage(path.join(files, 'notes.md')), 'FILE_NOT_IMAGE', 415);
  await failsWith(local.readImage(path.join(files, 'missing.png')), 'NOT_FOUND', 404);
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
  await failsWith(child.readImage(path.join(files, 'drawing.svg')), 'FILE_NOT_IMAGE', 415);
  if (!isRoot) await failsWith(child.readText(path.join(files, 'secret.txt')), 'PERMISSION_DENIED', 403);
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
  const missing = Object.values(ERRORS).map(([, message]) => message).filter(message => sandbox.I18n.t(message) === message);
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
      [path.join(files, 'drawing.svg'), 415, 'FILE_NOT_IMAGE', 'image'],
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
