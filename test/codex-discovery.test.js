const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const codex = require('../lib/agent-chat/codex');
const { executablePath, findCodex, forgetCodex, searchDirs, NOT_FOUND } = require('../lib/agent-chat/codex-app-server');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-codex-find-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test.beforeEach(() => forgetCodex());

let counter = 0;
const folder = () => { const dir = path.join(root, `case-${counter++}`); fs.mkdirSync(dir, { recursive: true }); return dir; };
const program = (dir, name = 'codex', mode = 0o755) => { fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, name); fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode }); fs.chmodSync(file, mode); return file; };

test('codex is found on PATH, in the usual install folders of the user and in the newest nvm node, in that order', () => {
  const home = folder();
  const none = { HOME: home, PATH: '' };
  assert.equal(executablePath(none), null);
  const nvmOld = program(path.join(home, '.nvm', 'versions', 'node', 'v20.9.0', 'bin'));
  const nvmNew = program(path.join(home, '.nvm', 'versions', 'node', 'v22.10.1', 'bin'));
  assert.equal(executablePath(none), nvmNew, 'the newest node version wins (v22 before v20, v9 would not beat v22)');
  const bun = program(path.join(home, '.bun', 'bin'));
  assert.equal(executablePath(none), bun, 'the usual folders come before nvm');
  const standalone = program(path.join(home, '.codex', 'packages', 'standalone', 'current', 'bin'));
  assert.equal(executablePath(none), standalone, 'the folder of the standalone installer');
  const local = program(path.join(home, '.local', 'bin'));
  assert.equal(executablePath(none), local);
  const onPath = program(folder());
  assert.equal(executablePath({ HOME: home, PATH: `${path.dirname(onPath)}${path.delimiter}/nonexistent` }), onPath, 'PATH comes first');
  assert.equal(nvmOld.includes('v20.9.0'), true);
});

test('CODEX_PATH names codex explicitly and is used first; one that is not an executable file is ignored', () => {
  const home = folder();
  const onPath = program(folder());
  const chosen = program(folder(), 'my-codex');
  assert.equal(executablePath({ HOME: home, PATH: path.dirname(onPath), CODEX_PATH: chosen }), chosen);
  assert.equal(executablePath({ HOME: home, PATH: path.dirname(onPath), CODEX_PATH: path.join(root, 'missing') }), onPath, 'a wrong CODEX_PATH falls back to the search');
  assert.equal(executablePath({ HOME: home, PATH: path.dirname(onPath), CODEX_PATH: folder() }), onPath, 'a directory is not a program');
  assert.equal(executablePath({ HOME: home, PATH: '', CODEX_PATH: program(folder(), 'plain', 0o644) }), null, 'a file that cannot be executed is not used');
});

test('a codex that cannot be run, or a directory with that name, is skipped', () => {
  const home = folder();
  const blocked = folder();
  program(blocked, 'codex', 0o644);
  fs.mkdirSync(path.join(folder(), 'codex'));
  const directory = folder();
  fs.mkdirSync(path.join(directory, 'codex'));
  const good = program(folder());
  assert.equal(executablePath({ HOME: home, PATH: [blocked, directory, path.dirname(good)].join(path.delimiter) }), good);
  assert.ok(searchDirs({ HOME: home, PATH: '/a:/b:/a' }).filter(dir => dir === '/a').length === 1, 'no folder is searched twice');
});

// A stand-in login shell: `-lc` and `-ilc` print what the test says.
function fakeShell(dir, { login = '', interactive = '' }) {
  const file = path.join(dir, 'fake-shell');
  fs.writeFileSync(file, `#!/bin/sh\ncase "$1" in\n  -lc) printf '%s\\n' "${login}" ;;\n  -ilc) printf 'noise from the profile\\n%s\\n' "${interactive}" ;;\nesac\necho "$1" >> "${dir}/asked"\n`, { mode: 0o755 });
  return file;
}

test('when the service PATH has no codex, the login shell of the user is asked, then an interactive one', async () => {
  const home = folder();
  const dir = folder();
  const real = program(folder());
  const none = { HOME: home, PATH: '' };

  const login = fakeShell(dir, { login: real });
  assert.equal(await findCodex({ ...none, SHELL: login }), real);
  assert.equal(fs.readFileSync(path.join(dir, 'asked'), 'utf8').trim(), '-lc', 'a login shell was enough');

  forgetCodex();
  fs.rmSync(path.join(dir, 'asked'));
  const interactive = fakeShell(dir, { interactive: real });
  assert.equal(await findCodex({ ...none, SHELL: interactive }), real, 'nvm and the like are set up in the interactive profile; the last line is the answer');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'asked'), 'utf8').trim().split('\n'), ['-lc', '-ilc']);

  fs.rmSync(path.join(dir, 'asked'));
  assert.equal(await findCodex({ ...none, SHELL: interactive }), real);
  assert.equal(fs.existsSync(path.join(dir, 'asked')), false, 'what the shell said is remembered, the shell is not asked again');

  forgetCodex();
  for (const answer of ['relative/codex', '/nonexistent/codex', dir]) {
    assert.equal(await findCodex({ ...none, SHELL: fakeShell(dir, { login: answer, interactive: answer }) }), null, `${answer} is not a program`);
  }
  assert.equal(await findCodex({ ...none, SHELL: path.join(root, 'no-such-shell') }), null, 'a shell that cannot start is not an error');
});

test('a codex that is on PATH is used without asking a shell', async () => {
  const home = folder();
  const dir = folder();
  const onPath = program(folder());
  assert.equal(await findCodex({ HOME: home, PATH: path.dirname(onPath), SHELL: fakeShell(dir, {}) }), onPath);
  assert.equal(fs.existsSync(path.join(dir, 'asked')), false);
});

test('without codex the turn says how to fix it instead of failing on something obscure', async () => {
  assert.match(NOT_FOUND, /CODEX_PATH/);
  assert.match(NOT_FOUND, /\.env/);
  const outcome = await codex.runTurn({ cwd: os.tmpdir(), mode: 'write', prompt: { text: 'x' }, signal: new AbortController().signal, ctx: { upsert() {}, append() {}, getItem() {}, setSession() {}, setControl() {} }, requestPermission: async () => ({ allow: true }), deps: { executable: null } });
  assert.deepEqual(outcome, { ok: false, error: NOT_FOUND });
  await assert.rejects(codex.listModels({ deps: { executable: null } }), error => error.message === NOT_FOUND);
});
