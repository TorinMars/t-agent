// Peer file access (services/peer-fs.js, routes/peer-fs.js, scripts/peer-fs-child.js): the denylist and the home-folder scope, the list, read and
// search answers, the dropped terminal user, the Engine routes /v1/peer-fs, the local relay /api/peer-fs with the terminal hook token, and the switch.
// Every home folder here is a throwaway one; the real home of the person running the tests is never read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, execFileSync } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-peer-fs-'));
const home = path.join(root, 'home');
fs.mkdirSync(home);
process.env.HOME = home;
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(home, 'tasks');
process.env.SESSION_SECRET = 'peer-fs-test-secret-peer-fs-test-secret-peer-fs';

const express = require('express');
const peerFs = require('../services/peer-fs');
const { createPeerFs, makePolicy, verdict, globToRegExp, SEARCH_MAX_MATCHES, LIST_MAX_ENTRIES, READ_DEFAULT_LIMIT } = peerFs;

const write = (relative, content) => {
  const file = path.join(home, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};

// \u2500\u2500 The fixture home \u2500\u2500
write('notes.md', 'hello\nthe needle is here\n\u4e2d\u6587 needle\n');
write('proj/src/a.js', 'const needle = 1;\nconst other = 2;\n');
write('proj/README.md', 'Needle in caps\n');
write('proj/.env', 'SECRET=needle\n');
write('proj/.env.local', 'SECRET=needle\n');
write('proj/server.pem', 'needle\n');
write('proj/tls.KEY', 'needle\n');
write('proj/id_rsa.pub', 'needle\n');
write('proj/store.p12', 'needle\n');
write('proj/node_modules/x/index.js', 'needle\n');
write('proj/.git/config', 'needle\n');
write('proj/bin.dat', Buffer.concat([Buffer.from('needle'), Buffer.from([0, 1, 2]), Buffer.from('needle')]));
write('.ssh/config', 'needle\n');
write('.SSH-not/ok.txt', 'needle ok\n');
write('.aws/credentials', 'needle\n');
write('.config/gh/hosts.yml', 'needle\n');
write('.config/other.txt', 'needle ok\n');
write('.claude/.credentials.json', 'needle\n');
write('.claude/settings.json', 'needle ok\n');
write('.codex/auth.json', 'needle\n');
write('.codex/config.toml', 'needle ok\n');
write('Library/Keychains/login.keychain-db', 'needle\n');
write('.netrc', 'needle\n');
write('.npmrc', 'needle\n');
write('.git-credentials', 'needle\n');
write('.tagent/db.sqlite', 'needle\n');
write('data-inside/db.sqlite', 'needle\n');
const outside = path.join(root, 'outside');
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'secret.txt'), 'needle\n');
fs.symlinkSync(path.join(home, '.ssh'), path.join(home, 'link-to-ssh'));
fs.symlinkSync(outside, path.join(home, 'link-to-outside'));
fs.symlinkSync(path.join(home, '.ssh', 'config'), path.join(home, 'proj', 'innocent.txt'));
fs.symlinkSync(path.join(home, 'proj'), path.join(home, 'link-to-proj'));
const many = path.join(home, 'many');
fs.mkdirSync(many);
for (let index = 0; index < LIST_MAX_ENTRIES + 5; index += 1) fs.writeFileSync(path.join(many, `f${String(index).padStart(4, '0')}.txt`), 'x');
fs.mkdirSync(path.join(many, 'zz-dir'));
for (let index = 0; index < SEARCH_MAX_MATCHES + 20; index += 1) write(`hits/h${index}.txt`, 'hit\n');

const realHome = fs.realpathSync(home);
const deniedRoots = () => [path.join(home, 'data-inside')];
const RG = (() => { try { return execFileSync('sh', ['-c', 'command -v rg'], { encoding: 'utf8' }).trim() || null; } catch { return null; } })();
const make = (options = {}) => createPeerFs({ terminalUser: () => null, homeDir: () => home, deniedRoots, rgPath: () => null, ...options });
const reader = make();

async function failsWith(promise, code, status) {
  await assert.rejects(promise, error => {
    assert.equal(error.message, code);
    if (status) assert.equal(error.statusCode, status);
    return true;
  });
}

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// \u2500\u2500 The policy \u2500\u2500

test('policy: sensitive paths are denied anywhere below the home folder, other paths pass, outside the home folder is outside', () => {
  const policy = makePolicy({ home, deniedRoots: deniedRoots() });
  const at = relative => verdict(policy, path.join(home, relative));
  for (const denied of ['.ssh', '.ssh/config', '.SSH/config', '.aws/credentials', '.gnupg/x', '.kube/config', '.docker/config.json', '.config/gh/hosts.yml',
    '.netrc', '.git-credentials', '.npmrc', '.pypirc', 'Library/Keychains/x', 'library/keychains', '.password-store/a.gpg', '.tagent/db.sqlite',
    '.claude/.credentials.json', '.codex/auth.json', 'proj/.env', 'proj/.ENV.local', 'proj/a.pem', 'proj/a.key', 'proj/id_rsa', 'proj/id_rsa.pub',
    'proj/id_ed25519', 'proj/a.p12', 'proj/a.PFX', 'proj/release.keystore', 'proj/sub/.ssh/known_hosts', 'data-inside', 'data-inside/db.sqlite']) {
    assert.equal(at(denied), 'denied', denied);
  }
  for (const fine of ['', 'notes.md', 'proj/src/a.js', '.config/other.txt', '.claude/settings.json', '.codex/config.toml', '.SSH-not/ok.txt',
    'proj/env', 'proj/keys.txt', 'proj/.envrc', 'Library/Preferences/x', 'gh/x']) {
    assert.equal(at(fine), null, fine);
  }
  assert.equal(verdict(policy, '/etc/hosts'), 'outside');
  assert.equal(verdict(policy, path.dirname(home)), 'outside');
  assert.equal(verdict(policy, `${home}-other/x`), 'outside', 'a folder that only starts like the home folder is outside');
  assert.equal(verdict(policy, path.join(realHome, 'notes.md')), null, 'the home folder after realpath is the same home folder');
});

test('policy: the default denied roots hold the data folder, its database and the old install data folder', () => {
  const roots = peerFs.defaultDeniedRoots();
  assert.ok(roots.includes(path.resolve(process.env.T_AGENT_DATA_DIR)));
  assert.ok(roots.includes(path.join(path.resolve(process.env.T_AGENT_DATA_DIR), 'db.sqlite')));
  assert.ok(roots.includes(path.join(__dirname, '..', 'data')));
});

// \u2500\u2500 List \u2500\u2500

test('list: dirs first then names, denied entries and links that escape are left out, the default is the home folder', async () => {
  const top = await reader.list();
  assert.equal(top.path, home);
  assert.equal(top.truncated, false);
  const names = top.entries.map(entry => entry.name);
  for (const hidden of ['.ssh', '.aws', '.netrc', '.npmrc', '.git-credentials', '.tagent', 'data-inside', 'link-to-ssh', 'link-to-outside']) assert.ok(!names.includes(hidden), hidden);
  for (const shown of ['proj', '.config', '.claude', 'notes.md', 'link-to-proj', 'Library']) assert.ok(names.includes(shown), shown);
  const firstFile = top.entries.findIndex(entry => entry.type !== 'dir');
  assert.ok(top.entries.slice(0, firstFile).every(entry => entry.type === 'dir'));
  assert.ok(top.entries.slice(firstFile).every(entry => entry.type !== 'dir'));
  const dirNames = top.entries.slice(0, firstFile).map(entry => entry.name);
  assert.deepEqual(dirNames, [...dirNames].sort());
  const notes = top.entries.find(entry => entry.name === 'notes.md');
  assert.deepEqual(Object.keys(notes).sort(), ['mtime', 'name', 'size', 'type']);
  assert.equal(notes.type, 'file');
  assert.equal(notes.size, fs.statSync(path.join(home, 'notes.md')).size);
  assert.ok(!Number.isNaN(Date.parse(notes.mtime)));
  assert.equal(top.entries.find(entry => entry.name === 'link-to-proj').type, 'symlink');
  assert.deepEqual((await reader.list('~')).entries, top.entries);

  const proj = (await reader.list('~/proj')).entries.map(entry => entry.name);
  assert.deepEqual(proj.filter(name => ['.env', '.env.local', 'server.pem', 'tls.KEY', 'id_rsa.pub', 'store.p12', 'innocent.txt'].includes(name)), []);
  assert.ok(proj.includes('README.md') && proj.includes('src'));
  assert.deepEqual((await reader.list('~/.config')).entries.map(entry => entry.name), ['other.txt']);
  assert.deepEqual((await reader.list('~/Library')).entries, []);
  assert.deepEqual((await reader.list('~/link-to-proj/src')).entries.map(entry => entry.name), ['a.js'], 'a link inside the home folder can be followed');
});

test('list: more than 1000 entries are cut with truncated, dirs still first', async () => {
  const result = await reader.list('~/many');
  assert.equal(result.entries.length, LIST_MAX_ENTRIES);
  assert.equal(result.truncated, true);
  assert.equal(result.entries[0].name, 'zz-dir');
  assert.equal(result.entries[1].name, 'f0000.txt');
});

test('list and read refuse denied, outside and escaping paths, and say what is wrong with others', async () => {
  for (const value of ['~/.ssh', '~/.ssh/config', '~/.ssh/missing', '~/link-to-ssh', '~/link-to-ssh/config', '~/link-to-outside', '~/link-to-outside/secret.txt',
    '~/proj/.env', '~/proj/innocent.txt', '~/data-inside/db.sqlite', '/etc', '/etc/hosts', path.dirname(home), path.join(outside, 'secret.txt'),
    `${home}/../outside/secret.txt`, '~/../outside/secret.txt']) {
    await failsWith(reader.read(value), 'PATH_NOT_ALLOWED', 403);
    await failsWith(reader.list(value), 'PATH_NOT_ALLOWED', 403);
  }
  for (const value of ['relative.txt', 'proj', '~user/x', ['~'], 'a\0b']) await failsWith(reader.read(value), 'INVALID_PATH', 400);
  await failsWith(reader.read('~/missing.txt'), 'NOT_FOUND', 404);
  await failsWith(reader.list('~/missing'), 'NOT_FOUND', 404);
  await failsWith(reader.read('~/proj'), 'IS_DIRECTORY', 400);
  await failsWith(reader.list('~/notes.md'), 'NOT_A_DIRECTORY', 400);
  await failsWith(reader.read('~/proj/bin.dat'), 'BINARY_FILE', 415);
});

// \u2500\u2500 Read \u2500\u2500

test('read: the answer shape, byte offset and limit, the limit capped at 1 MiB, a cut never splits a character', async () => {
  const notes = await reader.read('~/notes.md');
  assert.deepEqual(notes, {
    path: path.join(home, 'notes.md'), content: 'hello\nthe needle is here\n\u4e2d\u6587 needle\n', size: Buffer.byteLength(notes.content), offset: 0,
    truncated: false, encoding: 'utf8', next_offset: null,
  });
  const part = await reader.read('~/notes.md', { offset: '6', limit: '10' });
  assert.equal(part.content, 'the needle');
  assert.equal(part.truncated, true);
  assert.equal(part.next_offset, 16);
  // The Chinese characters are 3 bytes each: a limit that ends inside one stops before it.
  const start = Buffer.from('hello\nthe needle is here\n').length;
  const cut = await reader.read('~/notes.md', { offset: String(start), limit: '4' });
  assert.equal(cut.content, '\u4e2d');
  assert.equal(cut.next_offset, start + 3);
  const past = await reader.read('~/notes.md', { offset: '100000' });
  assert.equal(past.content, '');
  assert.equal(past.truncated, false);
  for (const options of [{ offset: '-1' }, { offset: 'x' }, { limit: '0' }, { limit: '1.5' }]) await failsWith(reader.read('~/notes.md', options), 'INVALID_ARGUMENT', 400);

  write('big.txt', 'a'.repeat(2 * 1024 * 1024));
  const big = await reader.read('~/big.txt');
  assert.equal(Buffer.byteLength(big.content), READ_DEFAULT_LIMIT);
  assert.equal(big.truncated, true);
  const max = await reader.read('~/big.txt', { limit: String(10 * 1024 * 1024) });
  assert.equal(Buffer.byteLength(max.content), 1024 * 1024, 'the limit is capped at 1 MiB');
  const tail = await reader.read('~/big.txt', { offset: String(2 * 1024 * 1024 - 5) });
  assert.equal(tail.content, 'aaaaa');
  assert.equal(tail.truncated, false);
  fs.rmSync(path.join(home, 'big.txt'));
});

// \u2500\u2500 Search \u2500\u2500

for (const engine of ['node', ...(RG ? ['rg'] : [])]) {
  const searcher = engine === 'rg' ? make({ rgPath: () => RG }) : reader;
  test(`search (${engine}): literal matches, denied paths, .git, node_modules and binary files are skipped`, async () => {
    const result = await searcher.search('~', { pattern: 'needle' });
    assert.equal(result.truncated, false);
    const found = result.matches.map(match => `${path.relative(home, match.path)}:${match.line}`).sort();
    assert.deepEqual(found, ['.SSH-not/ok.txt:1', '.claude/settings.json:1', '.codex/config.toml:1', '.config/other.txt:1', 'notes.md:2', 'notes.md:3', 'proj/src/a.js:1'].sort());
    const first = result.matches.find(match => match.path === path.join(home, 'notes.md') && match.line === 2);
    assert.deepEqual(first, { path: path.join(home, 'notes.md'), line: 2, text: 'the needle is here' });
    const caps = await searcher.search('~/proj', { pattern: 'NEEDLE', ignore_case: '1' });
    assert.deepEqual(caps.matches.map(match => path.basename(match.path)).sort(), ['README.md', 'a.js']);
    const exact = await searcher.search('~/proj', { pattern: 'Needle' });
    assert.deepEqual(exact.matches.map(match => path.basename(match.path)), ['README.md']);
    const globbed = await searcher.search('~', { pattern: 'needle', glob: '*.js' });
    assert.deepEqual(globbed.matches.map(match => path.relative(home, match.path)), ['proj/src/a.js']);
    const literal = await searcher.search('~', { pattern: 'ne.dle' });
    assert.deepEqual(literal.matches, [], 'a literal pattern is not a regular expression');
    const file = await searcher.search('~/notes.md', { pattern: 'needle' });
    assert.equal(file.matches.length, 2, 'a single file can be searched');
    await failsWith(searcher.search('~/.ssh', { pattern: 'needle' }), 'PATH_NOT_ALLOWED', 403);
    await failsWith(searcher.search('~/link-to-outside', { pattern: 'needle' }), 'PATH_NOT_ALLOWED', 403);
  });

  test(`search (${engine}): at most 200 matches, then truncated; long lines are cut to 400 characters`, async () => {
    const result = await searcher.search('~/hits', { pattern: 'hit' });
    assert.equal(result.matches.length, SEARCH_MAX_MATCHES);
    assert.equal(result.truncated, true);
    write('long/line.txt', `needle${'x'.repeat(1000)}\n`);
    const long = await searcher.search('~/long', { pattern: 'needle' });
    assert.equal(long.matches[0].text.length, 401);
    assert.ok(long.matches[0].text.endsWith('\u2026'));
    fs.rmSync(path.join(home, 'long'), { recursive: true, force: true });
  });
}

test('search: a regex pattern is a validated JS regular expression of at most 200 characters', async () => {
  const result = await reader.search('~/proj', { pattern: 'const (needle|other) =', regex: '1' });
  assert.deepEqual(result.matches.map(match => match.line), [1, 2]);
  const ignore = await reader.search('~/proj', { pattern: '^needle in', regex: 'true', ignore_case: 'true' });
  assert.deepEqual(ignore.matches.map(match => path.basename(match.path)), ['README.md']);
  // Even with rg on PATH, a regex runs in the Node walk, so it means the same everywhere.
  if (RG) assert.equal((await make({ rgPath: () => RG }).search('~/proj', { pattern: '(?<=const )needle', regex: '1' })).matches.length, 1);
  for (const options of [{ pattern: '(', regex: '1' }, { pattern: '' }, {}, { pattern: 'x'.repeat(201) }, { pattern: 'a', glob: '{a,b' }, { pattern: ['a', 'b'] }]) {
    await failsWith(reader.search('~', options), 'INVALID_PATTERN', 400);
  }
  assert.equal((await reader.search('~/proj', { pattern: 'x'.repeat(200) })).matches.length, 0, '200 characters are allowed');
});

test('search: a regular expression that never ends is stopped and the answer says truncated', async () => {
  write('slow/evil.txt', `${'a'.repeat(40)}!\n`);
  const quick = make({ searchTimeMs: 500 });
  const started = Date.now();
  const result = await quick.search('~/slow', { pattern: '^(a+)+$', regex: '1' });
  assert.deepEqual(result, { matches: [], truncated: true });
  assert.ok(Date.now() - started < 6000);
});

test('globs: names without a slash match the file name, with one the path; ** crosses folders', () => {
  assert.ok(globToRegExp('*.js').test('a.js'));
  assert.ok(!globToRegExp('*.js').test('src/a.js'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/a/b/c.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/c.ts'));
  assert.ok(globToRegExp('*.{md,txt}').test('A.MD'));
  assert.ok(globToRegExp('file?.[ch]').test('file1.c'));
  assert.ok(!globToRegExp('file?.[!ch]').test('file1.c'));
  assert.throws(() => globToRegExp('{a,b'));
});

// \u2500\u2500 The dropped terminal user \u2500\u2500

test('dropped user: list, read and search run in the child with its uid, gid and home, without the service secrets', async () => {
  const calls = [];
  const runner = async options => { calls.push(options); return { code: 0, stdout: Buffer.from(`${JSON.stringify({ result: { path: '/home/dev', entries: [], truncated: false } })}\n`) }; };
  const user = { name: 'dev', uid: 1234, gid: 2345, home: '/home/dev' };
  const dropped = createPeerFs({ terminalUser: () => user, deniedRoots: () => ['/var/lib/tagent'], runner, rgPath: () => '/usr/bin/rg' });
  assert.deepEqual(await dropped.list('~'), { path: '/home/dev', entries: [], truncated: false });
  const call = calls[0];
  assert.deepEqual([call.command, call.args[0], call.args[1], call.uid, call.gid, call.cwd, call.env.HOME, call.env.USER, call.env.SESSION_SECRET],
    [process.execPath, peerFs.CHILD_SCRIPT, 'list', 1234, 2345, '/', '/home/dev', 'dev', undefined]);
  assert.deepEqual(JSON.parse(call.args[2]), { policy: { home: '/home/dev', deniedRoots: ['/var/lib/tagent'] }, value: '~', options: {} });
  assert.equal(dropped.home(), '/home/dev');

  await dropped.read('~/a.txt', { offset: '3', limit: '9' });
  assert.deepEqual(JSON.parse(calls[1].args[2]).options, { offset: '3', limit: '9' });

  const searchRunner = async options => {
    calls.push(options);
    return { code: null, timedOut: true, stdout: Buffer.from(`${JSON.stringify({ match: { path: '/home/dev/a', line: 1, text: 'x' } })}\n`) };
  };
  const searching = createPeerFs({ terminalUser: () => user, runner: searchRunner, rgPath: () => '/usr/bin/rg' });
  assert.deepEqual(await searching.search('~', { pattern: 'x' }), { matches: [{ path: '/home/dev/a', line: 1, text: 'x' }], truncated: true }, 'a stopped search keeps its matches');
  assert.equal(JSON.parse(calls[2].args[2]).options.rgPath, '/usr/bin/rg');

  const failing = createPeerFs({ terminalUser: () => user, runner: async () => ({ code: 0, stdout: Buffer.from('{"error":"PATH_NOT_ALLOWED"}\n') }) });
  await failsWith(failing.read('~/.ssh/x'), 'PATH_NOT_ALLOWED', 403);
  const broken = createPeerFs({ terminalUser: () => user, runner: async () => ({ error: new Error('spawn EPERM') }) });
  await failsWith(broken.list('~'), 'PEER_FS_READ_FAILED', 500);
  const slow = createPeerFs({ terminalUser: () => user, runner: async () => ({ timedOut: true, stdout: Buffer.alloc(0) }) });
  await failsWith(slow.read('~/a'), 'READ_TIMEOUT', 504);
});

test('the real child script answers like the in-process reader (with this process\'s own uid, since tests cannot drop)', async () => {
  const self = { name: os.userInfo().username, uid: process.getuid(), gid: process.getgid(), home };
  const child = createPeerFs({ terminalUser: () => self, deniedRoots, runner: require('../services/fs-read').spawnRunner, rgPath: () => null });
  assert.deepEqual(await child.list('~/proj'), await reader.list('~/proj'));
  assert.deepEqual(await child.read('~/notes.md', { offset: '6', limit: '10' }), await reader.read('~/notes.md', { offset: '6', limit: '10' }));
  await failsWith(child.read('~/link-to-ssh/config'), 'PATH_NOT_ALLOWED', 403);
  await failsWith(child.read('~/proj/bin.dat'), 'BINARY_FILE', 415);
  assert.deepEqual(await child.search('~/proj', { pattern: 'needle' }), await reader.search('~/proj', { pattern: 'needle' }));
});

// \u2500\u2500 HTTP: the Engine routes, the relay and the settings \u2500\u2500

// routes/terminal.js with node-pty replaced, so a terminal's hook token can be read from its environment (the real verifyHookToken checks it).
function loadTerminal() {
  const terminalPath = path.resolve(__dirname, '../routes/terminal.js');
  const shells = [];
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(terminalPath, 'utf8'), {
    module: mod, __dirname: path.dirname(terminalPath), process, console, URL, setInterval, clearInterval, setTimeout, clearTimeout, Buffer,
    require(name) {
      if (name === '../lib/node-pty-runtime') return { repairSpawnHelperPermissions() {} };
      if (name === 'node-pty') return { spawn(shell, args, options) {
        const pty = { options, onData() {}, onExit(fn) { this.exit = fn; }, write() {}, pause() {}, resume() {}, resize() {}, kill() { this.exit && this.exit(); } };
        shells.push(pty);
        return pty;
      } };
      return require(name.startsWith('.') ? path.resolve(path.dirname(terminalPath), name) : name);
    },
  });
  const terminal = mod.exports;
  const { EventEmitter } = require('node:events');
  class Socket extends EventEmitter { readyState = 1; send() {} close() { this.readyState = 3; this.emit('close'); } }
  terminal.open = (taskId, id) => {
    terminal.handleWs(new Socket(), { url: `/terminal/ws?taskId=${taskId}&terminalId=${id}&clientId=test` }, { login: 'owner' });
    return shells[shells.length - 1];
  };
  return terminal;
}

const servers = [];
function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('listening', () => { servers.push(server); resolve(`http://127.0.0.1:${server.address().port}`); });
    server.once('error', reject);
  });
}

let db, terminal, engineBase, relayBase, settingsBase, token, task, hook, otherHook, remoteId, oldId, offlineId, settings;
const PROMPT = { 'Content-Type': 'application/json' };

test.before(async () => {
  db = require('../db');
  const tasks = require('../services/engine-tasks');
  const { createAccessToken } = require('../services/engine-auth');
  const { encryptToken } = require('../lib/token-crypto');
  const routes = require('../routes/peer-fs');
  settings = require('../services/peer-fs-settings').peerFsSettings();
  terminal = loadTerminal();
  terminal.setHookEndpoint('http://127.0.0.1:9/hooks/terminal-activity');
  task = tasks.createTask('owner', { title: 'peer files' });
  tasks.createTask('someone-else', { title: 'not mine' });
  const row = terminal.createTerminal(task.id, {});
  hook = { task: String(task.id), terminal: row.terminal_id, token: terminal.open(task.id, row.terminal_id).options.env.TA_HOOK_TOKEN };
  const second = terminal.createTerminal(task.id, {});
  otherHook = { task: String(task.id), terminal: second.terminal_id, token: terminal.open(task.id, second.terminal_id).options.env.TA_HOOK_TOKEN };

  const engineApp = express();
  engineApp.use(express.json());
  engineApp.use('/v1', require('../routes/engine-v1'));
  engineBase = await listen(engineApp);
  token = createAccessToken(db, { principalId: 'owner' }).token;
  const insert = (owner, name, base, enabled = 1) => db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher, enabled) VALUES (?, ?, ?, ?, ?)')
    .run(owner, name, base, encryptToken(token, process.env.SESSION_SECRET), enabled).lastInsertRowid;
  remoteId = insert('owner', 'Studio Mac', engineBase);
  // An Engine from before this feature: no /v1/peer-fs and no capability.
  const oldApp = express();
  oldApp.get('/v1/info', (req, res) => res.json({ capabilities: ['files:read'] }));
  oldId = insert('owner', 'old', await listen(oldApp));
  const closed = await listen(express());
  const port = new URL(closed).port;
  await new Promise(resolve => servers.pop().close(resolve));
  offlineId = insert('owner', 'gone', `http://127.0.0.1:${port}`);
  insert('owner', 'switched off row', `${engineBase}/`, 0);
  insert('someone-else', 'theirs', `${engineBase}//`);

  const relayApp = express();
  relayApp.use('/api/peer-fs', routes.createPeerFsRelayRouter({ verifyToken: terminal.verifyHookToken }));
  relayApp.use('/api/peer-fs', (req, res) => res.status(418).json({ error: 'PASSED_ON' }));
  relayBase = await listen(relayApp);
  const settingsApp = express();
  settingsApp.use(express.json());
  settingsApp.use('/api/peer-fs', routes.createPeerFsSettingsRouter());
  settingsBase = await listen(settingsApp);
});

test.after(async () => {
  if (terminal && task) terminal.closeTaskTerminals(task.id);
  if (terminal) terminal.setHookEndpoint(null);
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); })));
  if (db) db.close();
});

async function call(url, headers = {}, init = {}) {
  const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000), ...init });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body };
}
const engine = (route, auth = token) => call(`${engineBase}/v1/peer-fs${route}`, auth ? { Authorization: `Bearer ${auth}` } : {});
const hookHeaders = (who = hook) => ({ 'X-T-Agent-Task': who.task, 'X-T-Agent-Terminal': who.terminal, 'X-T-Agent-Token': who.token });
const relay = (route, headers = hookHeaders()) => call(`${relayBase}/api/peer-fs${route}`, headers);

test('Engine: /v1/peer-fs needs a token, advertises peer-fs:read, and answers info, list, read and search', async () => {
  assert.deepEqual((await engine('/info', null)).body, { error: 'ENGINE_TOKEN_REQUIRED' });
  assert.equal((await engine('/list', 'ta_wrong')).status, 401);
  const capabilities = await call(`${engineBase}/v1/info`, { Authorization: `Bearer ${token}` });
  assert.ok(capabilities.body.capabilities.includes('peer-fs:read'));

  const info = await engine('/info');
  assert.equal(info.status, 200);
  assert.deepEqual(Object.keys(info.body).sort(), ['home', 'name', 'platform', 'tasks']);
  assert.equal(info.body.home, home);
  assert.equal(info.body.platform, process.platform);
  assert.equal(info.body.name, require('../services/engine-identity').getEngineIdentity().name);
  assert.deepEqual(info.body.tasks, [{ id: task.id, title: 'peer files', work_dir: task.work_dir }], 'only the token owner\'s tasks');

  const list = await engine('/list?path=~/proj');
  assert.equal(list.status, 200);
  assert.ok(list.body.entries.some(entry => entry.name === 'README.md'));
  const read = await engine(`/read?path=${encodeURIComponent('~/notes.md')}&offset=6&limit=10`);
  assert.equal(read.body.content, 'the needle');
  const search = await engine('/search?path=~/proj&pattern=needle');
  assert.deepEqual(search.body.matches.map(match => path.basename(match.path)), ['a.js']);
  assert.deepEqual(await engine('/read?path=~/.ssh/config'), {
    status: 403, body: { error: 'PATH_NOT_ALLOWED', message: 'Linked engines cannot read this path: it is outside the home folder or holds sensitive data' },
  });
  assert.equal((await engine('/read?path=~/proj/bin.dat')).body.error, 'BINARY_FILE');
  assert.equal((await engine('/search?pattern=(&regex=1')).status, 400);
  assert.equal((await engine('/write?path=~/x')).status, 404, 'no write route');
});

test('Engine: the switch off answers 403 PEER_FS_DISABLED on every route', async () => {
  settings.setEnabled(false);
  try {
    for (const route of ['/info', '/list', '/read?path=~/notes.md', '/search?pattern=x']) {
      assert.deepEqual(await engine(route), { status: 403, body: { error: 'PEER_FS_DISABLED', message: 'File access for linked engines is turned off on that engine' } }, route);
    }
  } finally { settings.setEnabled(true); }
});

test('relay: the hook token of the terminal is the only credential; other requests are passed on untouched', async () => {
  assert.deepEqual(await relay('/engines', {}), { status: 418, body: { error: 'PASSED_ON' } }, 'no headers: not taken');
  assert.deepEqual(await relay('/settings', hookHeaders()), { status: 418, body: { error: 'PASSED_ON' } }, 'only the relay paths are taken');
  assert.equal((await relay('/engines', { 'X-T-Agent-Task': hook.task, 'X-T-Agent-Terminal': hook.terminal })).body.error, 'PEER_FS_AUTH_REQUIRED');
  assert.equal((await relay('/engines', { 'X-T-Agent-Token': hook.token })).status, 401);
  for (const headers of [
    { ...hookHeaders(), 'X-T-Agent-Token': 'f'.repeat(64) },
    { ...hookHeaders(), 'X-T-Agent-Token': hook.token.slice(1) },
    { ...hookHeaders(), 'X-T-Agent-Terminal': otherHook.terminal },
    { ...hookHeaders(), 'X-T-Agent-Task': String(task.id + 1000) },
    { ...hookHeaders(), 'X-T-Agent-Task': 'abc' },
    { ...hookHeaders(), 'X-T-Agent-Terminal': '../x' },
  ]) {
    assert.deepEqual(await relay('/engines', headers), { status: 403, body: { error: 'PEER_FS_AUTH_INVALID', message: 'The terminal token is not valid' } });
  }
  assert.equal((await relay('/engines', hookHeaders(otherHook))).status, 200, 'each terminal has its own token');
  assert.equal(terminal.verifyHookToken(task.id, hook.terminal, hook.token), true);
  assert.equal(terminal.verifyHookToken(task.id, hook.terminal, undefined), false);
  assert.equal(terminal.verifyHookToken(task.id, null, hook.token), false);
  const forwarded = await relay('/engines', { ...hookHeaders(), 'X-Forwarded-For': '203.0.113.9' });
  assert.equal(forwarded.status, 418, 'a request through a proxy is not taken');
});

test('relay: only requests from this machine are taken', () => {
  const { fromThisMachine } = require('../routes/peer-fs');
  const req = (remoteAddress, localAddress = '127.0.0.1', headers = {}) => ({ socket: { remoteAddress, localAddress }, headers });
  assert.equal(fromThisMachine(req('127.0.0.1')), true);
  assert.equal(fromThisMachine(req('::1', '::1')), true);
  assert.equal(fromThisMachine(req('::ffff:127.0.0.1')), true);
  assert.equal(fromThisMachine(req('192.168.1.5', '192.168.1.5')), true, 'the server\'s own address (HOST is not a wildcard)');
  assert.equal(fromThisMachine(req('192.168.1.9', '192.168.1.5')), false);
  assert.equal(fromThisMachine(req('127.0.0.1', '127.0.0.1', { forwarded: 'for=1.2.3.4' })), false);
});

test('relay: engines lists the linked engines of the task owner with online, supported and disabled', async () => {
  const answer = await relay('/engines');
  assert.equal(answer.status, 200);
  const byName = Object.fromEntries(answer.body.engines.map(entry => [entry.name, entry]));
  assert.deepEqual(Object.keys(byName).sort(), ['Studio Mac', 'gone', 'old'], 'not other owners\' rows, not disabled rows');
  assert.deepEqual(byName['Studio Mac'], {
    id: String(remoteId), name: 'Studio Mac', online: true, supported: true, disabled: false, home, platform: process.platform,
    tasks: [{ id: task.id, title: 'peer files', work_dir: task.work_dir }],
  });
  assert.equal(byName.old.id, String(oldId));
  assert.deepEqual([byName.old.online, byName.old.supported, byName.old.disabled], [true, false, false]);
  assert.deepEqual([byName.gone.online, byName.gone.supported, byName.gone.error], [false, false, 'ENGINE_OFFLINE']);
  assert.equal(byName.gone.id, String(offlineId));

  settings.setEnabled(false);
  try {
    // One database for both sides here: the relay itself is off first.
    assert.deepEqual(await relay('/engines'), { status: 403, body: { error: 'PEER_FS_DISABLED', message: 'File access for linked engines is turned off on this engine' } });
  } finally { settings.setEnabled(true); }
});

test('relay: list, read and search are forwarded to the engine named by id or name, answers and error codes passed through', async () => {
  const list = await relay(`/list?engine=${remoteId}&path=~/proj`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body, (await engine('/list?path=~/proj')).body);
  const byName = await relay(`/read?engine=${encodeURIComponent('studio MAC')}&path=${encodeURIComponent('~/notes.md')}&offset=6&limit=10`);
  assert.equal(byName.body.content, 'the needle', 'the name, without regard to case');
  const search = await relay(`/search?engine=${remoteId}&path=~&pattern=NEEDLE&ignore_case=1&glob=*.js`);
  assert.deepEqual(search.body, { matches: [{ path: path.join(home, 'proj/src/a.js'), line: 1, text: 'const needle = 1;' }], truncated: false });
  const regex = await relay(`/search?engine=${remoteId}&path=~/proj&pattern=${encodeURIComponent('other|needle')}&regex=1`);
  assert.equal(regex.body.matches.length, 2);
  assert.deepEqual(await relay(`/read?engine=${remoteId}&path=~/.ssh/config`), {
    status: 403, body: { error: 'PATH_NOT_ALLOWED', message: 'Linked engines cannot read this path: it is outside the home folder or holds sensitive data' },
  });
  assert.equal((await relay(`/read?engine=${remoteId}&path=~/missing`)).body.error, 'NOT_FOUND');
  assert.equal((await relay(`/search?engine=${remoteId}&pattern=(&regex=1`)).body.error, 'INVALID_PATTERN');

  assert.deepEqual(await relay('/list?path=~'), { status: 400, body: { error: 'ENGINE_REQUIRED', message: 'Name the linked engine to read from' } });
  assert.equal((await relay('/list?engine=nobody')).body.error, 'ENGINE_NOT_FOUND');
  assert.equal((await relay('/list?engine=theirs')).status, 404, 'another owner\'s engine is not found');
  assert.equal((await relay('/list?engine=switched%20off%20row')).status, 404, 'a disabled row is not used');
  assert.deepEqual(await relay(`/list?engine=${oldId}`), { status: 501, body: { error: 'PEER_FS_UNSUPPORTED', message: 'The linked engine is too old to share its files; update it first' } });
  assert.deepEqual(await relay('/read?engine=gone&path=~/a'), { status: 502, body: { error: 'ENGINE_OFFLINE', message: 'The linked engine cannot be reached' } });

  settings.setEnabled(false);
  try { assert.equal((await relay(`/list?engine=${remoteId}`)).body.error, 'PEER_FS_DISABLED'); }
  finally { settings.setEnabled(true); }
});

test('relay: a target engine that switched off is shown as disabled, its answers keep PEER_FS_DISABLED', async () => {
  const routes = require('../routes/peer-fs');
  const peer = express();
  peer.use('/v1/peer-fs', routes.createPeerFsEngineRouter({ settings: () => ({ enabled: () => false }) }));
  const { encryptToken } = require('../lib/token-crypto');
  const id = db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
    .run('owner', 'off', await listen(peer), encryptToken(token, process.env.SESSION_SECRET)).lastInsertRowid;
  try {
    const off = (await relay('/engines')).body.engines.find(entry => entry.name === 'off');
    assert.deepEqual([off.online, off.supported, off.disabled], [true, true, true]);
    assert.deepEqual(await relay(`/read?engine=${id}&path=~/notes.md`), { status: 403, body: { error: 'PEER_FS_DISABLED', message: 'File access for linked engines is turned off on that engine' } });
  } finally { db.prepare('DELETE FROM remote_servers WHERE id = ?').run(id); }
});

test('settings: GET and PUT { enabled }; anything but a boolean is refused', async () => {
  const url = `${settingsBase}/api/peer-fs/settings`;
  assert.deepEqual(await call(url), { status: 200, body: { enabled: true } });
  assert.deepEqual(await call(url, PROMPT, { method: 'PUT', body: JSON.stringify({ enabled: false }) }), { status: 200, body: { enabled: false } });
  assert.deepEqual(await call(url), { status: 200, body: { enabled: false } });
  assert.equal(settings.enabled(), false);
  assert.equal((await call(url, PROMPT, { method: 'PUT', body: JSON.stringify({ enabled: 'yes' }) })).status, 400);
  assert.deepEqual(await call(url, PROMPT, { method: 'PUT', body: JSON.stringify({ enabled: true }) }), { status: 200, body: { enabled: true } });
});

test('every new server message has a Chinese translation', () => {
  const JS = path.join(__dirname, '..', 'public', 'js');
  const sandbox = { localStorage: { getItem: () => 'zh', setItem() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['i18n.js', 'i18n-zh-ui.js', 'i18n-zh-server.js', 'i18n-zh-extra.js']) vm.runInContext(fs.readFileSync(path.join(JS, file), 'utf8'), sandbox);
  const { RELAY_ERRORS } = require('../routes/peer-fs');
  const messages = [...Object.values(peerFs.ERRORS), ...Object.values(RELAY_ERRORS)].map(([, message]) => message).concat('enabled must be true or false');
  assert.deepEqual(messages.filter(message => sandbox.I18n.t(message) === message), []);
});

// \u2500\u2500 A real second service \u2500\u2500

function spawnService(t, env) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-peer-fs-svc-'));
  const serviceHome = path.join(temp, 'home');
  fs.mkdirSync(path.join(serviceHome, 'work'), { recursive: true });
  fs.writeFileSync(path.join(serviceHome, 'work', 'plan.md'), '# Plan\nship the needle\n');
  fs.mkdirSync(path.join(serviceHome, '.ssh'));
  fs.writeFileSync(path.join(serviceHome, '.ssh', 'id_ed25519'), 'needle\n');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env, HOME: serviceHome, TAGENT_HOME: '', HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', SESSION_SECRET: process.env.SESSION_SECRET,
      T_AGENT_DATA_DIR: path.join(temp, 'data'), T_AGENT_DB_PATH: path.join(temp, 'data', 'db.sqlite'), TASKS_BASE_DIR: path.join(serviceHome, 'tasks'),
      SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) await new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); });
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no start: ${output}`)), 20000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Server running at http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve({ url: `http://127.0.0.1:${match[1]}`, home: serviceHome }); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`exited ${code}: ${output}`)); });
  });
}

const SAME_ORIGIN = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };

test('real server: the relay is answered before the login gate, the settings route is behind it', { timeout: 60000 }, async t => {
  const { url } = await spawnService(t, { CLIENT_ALLOW_HTTP: 'false' });
  assert.equal((await call(`${url}/api/peer-fs/settings`)).status, 404, 'logged out: the same 404 as any protected address');
  assert.equal((await call(`${url}/api/peer-fs/engines`)).status, 404, 'no terminal headers: like any protected address');
  assert.deepEqual((await call(`${url}/api/peer-fs/engines`, hookHeaders())).body, { error: 'PEER_FS_AUTH_INVALID', message: 'The terminal token is not valid' },
    'a token of another process is refused by the relay itself');
  assert.equal((await call(`${url}/v1/peer-fs/info`)).status, 401);
});

test('real server: the relay forwards to a second real service, which reads its own home folder and honours its switch', { timeout: 60000 }, async t => {
  const peer = await spawnService(t, { ACCESS_MODE: 'local', ENGINE_NAME: 'peer-b' });
  const created = await call(`${peer.url}/api/remote-tokens`, SAME_ORIGIN, { method: 'POST', body: JSON.stringify({ name: 'peer fs test' }) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const made = await call(`${peer.url}/api/tasks`, SAME_ORIGIN, { method: 'POST', body: JSON.stringify({ title: 'remote work' }) });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const { encryptToken } = require('../lib/token-crypto');
  const id = db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
    .run('owner', 'peer-b', peer.url, encryptToken(created.body.token, process.env.SESSION_SECRET)).lastInsertRowid;
  try {
    const listed = (await relay('/engines')).body.engines.find(entry => entry.id === String(id));
    assert.deepEqual([listed.online, listed.supported, listed.disabled, listed.home], [true, true, false, peer.home]);
    assert.deepEqual(listed.tasks.map(item => item.title), ['remote work']);
    const read = await relay(`/read?engine=peer-b&path=${encodeURIComponent('~/work/plan.md')}`);
    assert.equal(read.body.content, '# Plan\nship the needle\n');
    assert.equal(read.body.path, path.join(peer.home, 'work', 'plan.md'));
    const search = await relay(`/search?engine=${id}&pattern=needle`);
    assert.deepEqual(search.body.matches.map(match => path.relative(peer.home, match.path)), ['work/plan.md'], 'the peer\'s .ssh is skipped');
    assert.equal((await relay(`/read?engine=${id}&path=~/.ssh/id_ed25519`)).body.error, 'PATH_NOT_ALLOWED');
    assert.equal((await relay(`/list?engine=${id}&path=/etc`)).body.error, 'PATH_NOT_ALLOWED');

    // The settings route of the peer, with its trusted local session (ACCESS_MODE=local).
    const off = await call(`${peer.url}/api/peer-fs/settings`, SAME_ORIGIN, { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    assert.deepEqual(off.body, { enabled: false });
    const disabled = (await relay('/engines')).body.engines.find(entry => entry.id === String(id));
    assert.deepEqual([disabled.online, disabled.supported, disabled.disabled], [true, true, true]);
    assert.equal((await relay(`/read?engine=${id}&path=~/work/plan.md`)).body.error, 'PEER_FS_DISABLED');
  } finally { db.prepare('DELETE FROM remote_servers WHERE id = ?').run(id); }
});
