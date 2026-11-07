// The clipboard shims (scripts/clipboard-shims) run under a real PTY with fake "real" commands on PATH that record what
// they get, and routes/terminal.js is checked to put the shim folder first in PATH of the PTYs it spawns.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-clipboard-shims-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
const nodePty = require('node-pty');
const { SHIM_DIR, SHIMS, ensureShimModes, shimsUsableBy, clipboardShimEnv } = require('../lib/clipboard-shims');

const CHINESE = '\u4e2d\u6587\u526a\u8d34\u677f copy \u2713\n';
const osc52 = text => `\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`;
const count = (haystack, needle) => haystack.split(needle).length - 1;

// Fake real commands: record arguments and stdin; `xclip -o` / `xsel -o` print a pasted text.
const fakeDir = path.join(root, 'fake');
const recordDir = path.join(root, 'records');
fs.mkdirSync(fakeDir);
fs.mkdirSync(recordDir);
for (const name of [...SHIMS, 'tmux']) {
  fs.writeFileSync(path.join(fakeDir, name), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_RECORDS/${name}.args"
case " $* " in *" -o "*|*" -bo "*|*" --output "*) printf 'pasted text'; exit 0 ;; esac
case "${name}:$1" in tmux:show-options) printf '%s\\n' "\${FAKE_TMUX_CLIPBOARD:-external}"; exit 0 ;; esac
[ ! -t 0 ] || exit 0
cat >> "$FAKE_RECORDS/${name}.data"
[ "${name}:$FAKE_TMUX_FAIL" != tmux:1 ] || exit 1
exit 0
`, { mode: 0o755 });
}
const record = (name, kind) => {
  try { return fs.readFileSync(path.join(recordDir, `${name}.${kind}`), 'utf8'); } catch { return null; }
};
const clearRecords = () => { for (const file of fs.readdirSync(recordDir)) fs.rmSync(path.join(recordDir, file)); };

function baseEnv(extra = {}) {
  const env = {
    HOME: root, TMPDIR: root, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TERM: 'xterm-256color',
    FAKE_RECORDS: recordDir, DISPLAY: ':99', WAYLAND_DISPLAY: 'wayland-0',
    ...clipboardShimEnv(`${fakeDir}:/usr/bin:/bin`),
    ...extra,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
}

// Runs a shell command in a PTY; resolves with everything the terminal received and the exit code.
function inPty(command, env = baseEnv(), shell = '/bin/sh') {
  clearRecords();
  return new Promise(resolve => {
    const pty = nodePty.spawn(shell, ['-c', command], { name: 'xterm-256color', cols: 200, rows: 20, cwd: root, env });
    let output = '';
    pty.onData(data => { output += data; });
    pty.onExit(({ exitCode }) => setTimeout(() => resolve({ output, exitCode }), 50));
  });
}

// Runs a command without a controlling terminal (a new session from detached: true).
function withoutTty(command, input, env = baseEnv()) {
  clearRecords();
  return new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', command], { env, cwd: root, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('close', code => resolve({ stdout, stderr, code }));
    child.stdin.end(input);
  });
}

const textFile = path.join(root, 'chinese.txt');
fs.writeFileSync(textFile, CHINESE);

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('the shims are committed executable and the folder is first in PATH with the marker', () => {
  for (const name of SHIMS) assert.ok(fs.statSync(path.join(SHIM_DIR, name)).mode & 0o111, `${name} is executable`);
  const env = clipboardShimEnv('/usr/bin:/bin');
  assert.equal(env.PATH, `${SHIM_DIR}:/usr/bin:/bin`);
  assert.equal(env.TA_CLIPBOARD_OSC52, '1');
});

test('pbcopy sends Chinese UTF-8 text as one OSC 52 sequence to the terminal and still runs the real pbcopy', async () => {
  const { output, exitCode } = await inPty(`pbcopy < '${textFile}'`);
  assert.equal(exitCode, 0);
  assert.equal(count(output, '\x1b]52;'), 1);
  assert.ok(output.includes(osc52(CHINESE)), JSON.stringify(output));
  assert.equal(record('pbcopy', 'data'), CHINESE);
});

test('the shims work under dash as well', { skip: !fs.existsSync('/bin/dash') && 'no dash' }, async () => {
  const { output } = await inPty(`dash '${path.join(SHIM_DIR, 'xclip')}' -selection clipboard < '${textFile}'`);
  assert.ok(output.includes(osc52(CHINESE)));
  assert.equal(record('xclip', 'data'), CHINESE);
});

test('xclip, xsel and wl-copy copies reach the browser and the real command', async () => {
  const cases = [
    ['xclip -selection clipboard', 'xclip'],
    ['xclip -sel c -quiet -i', 'xclip'],
    ['xclip', 'xclip'],
    ['xsel --nodetach -i -b', 'xsel'],
    ['xsel -bi', 'xsel'],
    ['wl-copy', 'wl-copy'],
    ['wl-copy --type text/plain', 'wl-copy'],
  ];
  for (const [command, name] of cases) {
    const { output, exitCode } = await inPty(`${command} < '${textFile}'`);
    assert.equal(exitCode, 0, command);
    assert.equal(count(output, '\x1b]52;'), 1, command);
    assert.ok(output.includes(osc52(CHINESE)), command);
    assert.equal(record(name, 'data'), CHINESE, command);
    assert.equal(record(name, 'args'), `${command.split(' ').slice(1).join(' ')}\n`, command);
  }
  const { output } = await inPty(`xclip -selection clipboard '${textFile}'`);
  assert.ok(output.includes(osc52(CHINESE)), 'xclip reads a file argument');
  const words = await inPty('wl-copy hello  world');
  assert.ok(words.output.includes(osc52('hello world')), 'wl-copy copies its text arguments');
  const trimmed = await inPty(`printf 'one\\n' | xclip -selection clipboard -rmlastnl`);
  assert.ok(trimmed.output.includes(osc52('one')));
});

test('paste, output and non-copy modes go to the real command without OSC 52', async () => {
  for (const command of ['xclip -o', 'xclip -selection clipboard -o', 'xsel -o', 'xsel --output --clipboard', 'xsel -bo']) {
    const { output } = await inPty(command);
    assert.equal(count(output, ']52;'), 0, command);
    assert.ok(output.includes('pasted text'), command);
  }
  for (const command of ['xclip -t image/png -selection clipboard', 'xclip -selection secondary', 'xclip -unknown-flag', 'xsel -a', 'wl-copy --clear', 'wl-copy -t image/png', 'pbcopy -pboard find']) {
    const { output } = await inPty(`${command} < '${textFile}'`);
    assert.equal(count(output, ']52;'), 0, command);
    const name = command.split(' ')[0];
    assert.equal(record(name, 'args'), `${command.split(' ').slice(1).join(' ')}\n`, command);
  }
  // xsel with a terminal on stdin and no -i prints the selection.
  const { output } = await inPty('xsel');
  assert.equal(count(output, ']52;'), 0);
});

test('over 64 KiB is refused with a note and exit 1, and the real command still gets the data', async () => {
  const big = path.join(root, 'big.txt');
  fs.writeFileSync(big, 'x'.repeat(65537));
  const { output, exitCode } = await inPty(`pbcopy < '${big}'`);
  assert.equal(exitCode, 1);
  assert.equal(count(output, ']52;'), 0);
  assert.match(output, /over the 64 KiB limit/);
  assert.equal(record('pbcopy', 'data').length, 65537);
  fs.writeFileSync(big, 'x'.repeat(65536));
  const atLimit = await inPty(`pbcopy < '${big}'`);
  assert.equal(atLimit.exitCode, 0);
  assert.equal(count(atLimit.output, '\x1b]52;c;'), 1);
});

test('without a controlling terminal the shim skips OSC 52 silently', async () => {
  const { stdout, stderr, code } = await withoutTty('pbcopy', CHINESE);
  assert.equal(code, 0);
  assert.equal(stdout, '');
  assert.equal(stderr, '');
  assert.equal(record('pbcopy', 'data'), CHINESE);
  const filter = await withoutTty('xclip -filter -selection clipboard', 'echo me', baseEnv({ DISPLAY: undefined }));
  assert.equal(filter.stdout, 'echo me', 'xclip -filter echoes the input when the real xclip is not run');
  assert.equal(record('xclip', 'data'), null, 'no X display: the real xclip is not run');
});

test('inside tmux the text goes to tmux load-buffer -w, else through the DCS passthrough', async () => {
  const tmuxEnv = extra => baseEnv({ TMUX: '/tmp/fake-tmux,1,0', ...extra });
  const loaded = await inPty(`pbcopy < '${textFile}'`, tmuxEnv());
  assert.equal(count(loaded.output, ']52;'), 0);
  assert.equal(record('tmux', 'args'), 'show-options -gv set-clipboard\nload-buffer -w -\n');
  assert.equal(record('tmux', 'data'), CHINESE);
  assert.equal(record('pbcopy', 'data'), CHINESE);
  const b64 = Buffer.from(CHINESE).toString('base64');
  const wrapped = `\x1bPtmux;\x1b\x1b]52;c;${b64}\x07\x1b\\`;
  const failed = await inPty(`pbcopy < '${textFile}'`, tmuxEnv({ FAKE_TMUX_FAIL: '1' }));
  assert.ok(failed.output.includes(wrapped), JSON.stringify(failed.output));
  const off = await inPty(`pbcopy < '${textFile}'`, tmuxEnv({ FAKE_TMUX_CLIPBOARD: 'off' }));
  assert.ok(off.output.includes(wrapped));
  assert.equal(record('tmux', 'data'), null, 'set-clipboard off: no load-buffer');
});

test('inside GNU screen the sequence is sent in DCS chunks', async () => {
  const text = 'screen '.repeat(200);
  const file = path.join(root, 'screen.txt');
  fs.writeFileSync(file, text);
  const { output } = await inPty(`pbcopy < '${file}'`, baseEnv({ STY: '1.fake' }));
  const start = output.indexOf('\x1bP\x1b]52;c;');
  assert.ok(start >= 0);
  const end = output.indexOf('\x07\x1b\\', start);
  const body = output.slice(start + '\x1bP\x1b]52;c;'.length, end);
  const chunks = body.split('\x1b\\\x1bP');
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 512));
  assert.equal(Buffer.from(chunks.join(''), 'base64').toString(), text);
});

test('outside a T-Agent terminal, with a second copy of the folder and with no real command', async () => {
  const outside = await inPty(`pbcopy < '${textFile}'`, baseEnv({ TA_CLIPBOARD_OSC52: undefined }));
  assert.equal(count(outside.output, ']52;'), 0);
  assert.equal(record('pbcopy', 'data'), CHINESE);
  const copy = path.join(root, 'shims-copy');
  fs.cpSync(SHIM_DIR, copy, { recursive: true });
  const nested = await inPty(`pbcopy < '${textFile}'`, baseEnv({ PATH: `${SHIM_DIR}:${copy}:${fakeDir}:/usr/bin:/bin` }));
  assert.equal(count(nested.output, ']52;'), 1);
  assert.equal(record('pbcopy', 'data'), CHINESE);
  const alone = await inPty(`pbcopy < '${textFile}'; echo "status $?"; xclip -o; echo "status $?"`, baseEnv({ PATH: `${SHIM_DIR}:/usr/bin:/bin` }));
  assert.equal(count(alone.output, ']52;'), 1);
  assert.match(alone.output, /status 0[\s\S]*xclip: command not found[\s\S]*status 127/);
});

test('ensureShimModes restores the executable bit and shimsUsableBy checks the dropped user', () => {
  const copy = path.join(root, 'modes');
  fs.cpSync(SHIM_DIR, copy, { recursive: true });
  for (const name of SHIMS) fs.chmodSync(path.join(copy, name), 0o644);
  assert.equal(ensureShimModes(copy), true);
  for (const name of SHIMS) assert.equal(fs.statSync(path.join(copy, name)).mode & 0o777, 0o755);
  assert.equal(ensureShimModes(path.join(root, 'missing')), false);
  const user = { name: 'dev', uid: 4242, gid: 4242 };
  const stat = closedDir => file => ({
    uid: 0, gid: 0, isDirectory: () => !path.extname(file) && !SHIMS.includes(path.basename(file)),
    mode: file === closedDir ? 0o40700 : 0o40755,
  });
  assert.equal(shimsUsableBy(null), true);
  assert.equal(shimsUsableBy(user, '/opt/t-agent/scripts/clipboard-shims', stat('')), true);
  assert.equal(shimsUsableBy(user, '/root/t-agent/scripts/clipboard-shims', stat('/root')), false);
  const logs = [];
  const env = clipboardShimEnv('/usr/bin', user, { dir: '/root/t-agent/scripts/clipboard-shims', stat: stat('/root'), log: line => logs.push(line) });
  assert.deepEqual(env, { PATH: '/usr/bin' });
  clipboardShimEnv('/usr/bin', user, { dir: '/root/t-agent/scripts/clipboard-shims', stat: stat('/root'), log: line => logs.push(line) });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /not usable by dev/);
});

test('routes/terminal.js spawns every PTY with the shim folder first in PATH and the marker', () => {
  const db = require('../db');
  const tasks = require('../services/engine-tasks');
  const shells = [];
  const terminalPath = path.resolve(__dirname, '../routes/terminal.js');
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(terminalPath, 'utf8'), {
    module: mod, __dirname: path.dirname(terminalPath), process, console: { ...console, warn() {} }, URL,
    setInterval, clearInterval, Buffer,
    require(name) {
      if (name === '../lib/node-pty-runtime') return { repairSpawnHelperPermissions() {} };
      if (name === 'node-pty') return { spawn(shell, args, options) {
        const pty = { options, onData() {}, onExit(fn) { this.exit = fn; }, write() {}, pause() {}, resume() {}, resize() {}, kill() { this.exit(); } };
        shells.push(pty);
        return pty;
      } };
      return require(name.startsWith('.') ? path.resolve(path.dirname(terminalPath), name) : name);
    },
  });
  const terminal = mod.exports;
  class Socket extends EventEmitter {
    readyState = 1;
    send() {}
    close() { this.readyState = 3; this.emit('close'); }
  }
  const task = tasks.createTask('owner', { title: 'clipboard' });
  try {
    terminal.handleWs(new Socket(), { url: `/terminal/ws?taskId=${task.id}&terminalId=default&clientId=test` }, { login: 'owner' });
    assert.equal(shells.length, 1);
    const { env } = shells[0].options;
    const entries = env.PATH.split(':');
    assert.equal(entries[0], SHIM_DIR);
    assert.ok(entries.includes('/usr/bin') && entries.includes('/bin'), 'the other PATH entries stay');
    for (const entry of (process.env.PATH || '').split(':').filter(Boolean)) assert.ok(entries.includes(entry), entry);
    assert.equal(env.TA_CLIPBOARD_OSC52, '1');
  } finally {
    terminal.closeTaskTerminals(task.id);
    db.close();
  }
});
