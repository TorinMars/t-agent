const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const script = path.join(__dirname, '../scripts/install-claude-code.sh');
const run = args => spawnSync('bash', [script, ...args], { encoding: 'utf8', input: '' });

test('安装脚本语法正确，帮助信息列出全部参数', () => {
  assert.equal(spawnSync('bash', ['-n', script]).status, 0);
  const result = run(['--help']);
  assert.equal(result.status, 0);
  for (const flag of ['--check', '--upgrade', '--no-modify-path', '--passphrase', '--skip']) assert.match(result.stdout, new RegExp(flag));
});

test('安装脚本拒绝未知参数和不支持的 --skip 项', () => {
  assert.equal(run(['--bogus']).status, 2);
  assert.equal(run(['--skip', 'homebrew']).status, 2);
  assert.match(run(['--help']).stdout, /sync、ta 或 pm2/);
});

test('安装脚本中变量名后不能直接紧跟中文字符（UTF-8 下会被当作变量名的一部分）', () => {
  const source = require('node:fs').readFileSync(script, 'utf8');
  const offenders = source.split('\n').map((line, index) => [index + 1, line])
    .filter(([, line]) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/.test(line));
  assert.deepEqual(offenders, []);
});

const proxyScript = path.join(__dirname, '../scripts/install-proxy.sh');
const runProxy = args => spawnSync('bash', [proxyScript, ...args], { encoding: 'utf8', input: '' });

test('代理脚本语法正确，帮助信息列出全部参数，拒绝错误参数', () => {
  assert.equal(spawnSync('bash', ['-n', proxyScript]).status, 0);
  const help = runProxy(['--help']);
  assert.equal(help.status, 0);
  for (const flag of ['--update', '--status', '--core', '--reconfigure', '--upgrade', '--port', '--controller-port', '--no-service']) assert.match(help.stdout, new RegExp(flag));
  assert.equal(runProxy(['--bogus']).status, 2);
  assert.equal(runProxy(['--port', 'abc']).status, 2);
  assert.equal(runProxy(['--port', '80']).status, 2);
});

test('代理脚本中变量名后不能直接紧跟中文字符，也不会把订阅链接写入输出', () => {
  const source = require('node:fs').readFileSync(proxyScript, 'utf8');
  assert.deepEqual(source.split('\n').filter(line => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/.test(line)), []);
  const printsUrl = source.split('\n').filter(line => /^\s*(info|ok|warn|fail|echo|printf)\b.*\$\{?SUB_URL\}?(?!\w)/.test(line) && !/#\{SUB_URL\}/.test(line) && !/printf 'url = /.test(line));
  assert.deepEqual(printsUrl, []);
});

test('向导启动脚本语法正确并给出帮助，向导服务可编译', () => {
  const wizardScript = path.join(__dirname, '../scripts/setup-wizard.sh');
  assert.equal(spawnSync('bash', ['-n', wizardScript]).status, 0);
  const help = spawnSync('bash', [wizardScript, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--port/);
  const source = require('node:fs').readFileSync(wizardScript, 'utf8');
  assert.deepEqual(source.split('\n').filter(line => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/.test(line)), []);
  if (spawnSync('python3', ['--version']).status === 0) {
    assert.equal(spawnSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf8").read())', path.join(__dirname, '../scripts/setup-wizard.py')]).status, 0);
  }
});

test('codex -c / --continue 继续最近会话，codex -c key=value 仍是配置覆盖', { skip: spawnSync('python3', ['--version']).status !== 0 }, () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-test-'));
  fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
  for (const name of ['claude', 'codex']) {
    fs.writeFileSync(path.join(home, '.local/bin', name), `#!/bin/sh\necho "${name.toUpperCase()}: $*"\n`, { mode: 0o755 });
  }
  const env = {
    HOME: home, SHELL: '/bin/bash', PATH: `${home}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    T_AGENT_SCRIPTS_BASE: `file://${path.join(__dirname, '../scripts')}`,
    T_AGENT_RULES_BASE: `file://${path.join(__dirname, '../rules')}`,
    T_AGENT_SYNC_CACHE: path.join(home, 'cache'),
  };
  const install = spawnSync('bash', [script, '--skip', 'ssh', '--skip', 'pm2'], { encoding: 'utf8', env, input: '' });
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const rcFile = path.join(home, process.platform === 'darwin' ? '.bash_profile' : '.bashrc');
  const rc = fs.readFileSync(rcFile, 'utf8');
  assert.equal(rc.split('# >>> t-agent agent-sync >>>').length - 1, 1);

  const shell = command => spawnSync('bash', ['--rcfile', rcFile, '-ic', command], { encoding: 'utf8', env }).stdout.split('\n').filter(line => /^(CLAUDE|CODEX):/.test(line));
  assert.deepEqual(shell('codex -c'), ['CODEX: resume --last']);
  assert.deepEqual(shell('codex --continue "接着做"'), ['CODEX: resume --last 接着做']);
  assert.deepEqual(shell('codex -c "接着做"'), ['CODEX: resume --last 接着做']);
  assert.deepEqual(shell('codex -c model="o3" exec x'), ['CODEX: -c model=o3 exec x']);
  assert.deepEqual(shell('codex exec x'), ['CODEX: exec x']);
  assert.deepEqual(shell('claude -c'), ['CLAUDE: -c']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('ta 把统一的 -c / -p / -m 翻译成 claude 和 codex 各自的写法，其余参数原样透传', () => {
  const ta = path.join(__dirname, '../scripts/ta.sh');
  const plan = (...args) => spawnSync('bash', [ta, '--dry-run', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent', LC_ALL: 'en_US.UTF-8' } });
  const cases = [
    [[], 'claude'],
    [['-c'], 'claude -c'],
    [['-c', '-m', 'opus'], 'claude -c --model opus'],
    [['-p', '总结'], "claude -p '总结'"],
    [['x'], 'codex'],
    [['x', '-c'], 'codex resume --last'],
    [['codex', '--continue'], 'codex resume --last'],
    [['x', '-c', '-m', 'gpt-6-sol'], 'codex resume --last -m gpt-6-sol'],
    [['x', '-p', '总结'], "codex exec '总结'"],
    [['x', '-c', '-p', '接着做'], "codex exec resume --last '接着做'"],
    [['c', '--resume', 'abc'], 'claude --resume abc'],
    [['x', '--full-auto', '-m', 'gpt-5.5'], 'codex -m gpt-5.5 --full-auto'],
    [['x', '--', '-p', 'work'], 'codex -p work'],
    [['-p', "it's"], "claude -p 'it'\\''s'"],
  ];
  for (const [args, expected] of cases) {
    const result = plan(...args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), expected, `ta ${args.join(' ')}`);
  }
  assert.equal(plan('-p').status, 2);
  assert.equal(spawnSync('bash', [ta, '--set-default', 'nope'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync('bash', ['-n', ta]).status, 0);
});

// ---- PM2 / Node.js 安装步骤：用本地 file:// 假镜像，不联网 ----
function pm2Sandbox({ wrongChecksum = false, withPm2 = false } = {}) {
  const fs = require('node:fs');
  const os = require('node:os');
  const crypto = require('node:crypto');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-install-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
  const nodeOs = process.platform === 'darwin' ? 'darwin' : 'linux';
  const nodeArch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const name = `node-v22.9.9-${nodeOs}-${nodeArch}`;
  const pkg = path.join(root, 'pkg', name, 'bin');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'node'), '#!/bin/sh\necho v22.9.9\n', { mode: 0o755 });
  fs.writeFileSync(path.join(pkg, 'npm'), `#!/bin/sh
here="$(cd "$(dirname "$0")/.." && pwd)"
case "$1 $2 $3" in
  "config get prefix") echo "$here"; exit 0 ;;
esac
prefix="$here"; [ "$3" = "--prefix" ] && prefix="$4"
mkdir -p "$prefix/bin" && printf '#!/bin/sh\\necho 7.0.0-fake\\n' > "$prefix/bin/pm2" && chmod +x "$prefix/bin/pm2"
`, { mode: 0o755 });
  const mirror = path.join(root, 'mirror/latest-v22.x');
  fs.mkdirSync(mirror, { recursive: true });
  const tarball = `${name}.tar.gz`;
  spawnSync('tar', ['-czf', path.join(mirror, tarball), '-C', path.join(root, 'pkg'), name]);
  const sum = wrongChecksum ? '0'.repeat(64) : crypto.createHash('sha256').update(fs.readFileSync(path.join(mirror, tarball))).digest('hex');
  fs.writeFileSync(path.join(mirror, 'SHASUMS256.txt'), `${sum}  ${tarball}\n`);
  if (withPm2) fs.writeFileSync(path.join(home, '.local/bin/pm2'), '#!/bin/sh\necho 6.0.0-existing\n', { mode: 0o755 });
  const run = extra => spawnSync('bash', [script, '--skip', 'claude', '--skip', 'codex', '--skip', 'ssh', '--skip', 'sync', '--skip', 'ta', ...extra], {
    encoding: 'utf8', input: '',
    env: { HOME: home, SHELL: '/bin/bash', PATH: `${home}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      T_AGENT_NODE_MIRROR: withPm2 ? 'file:///nonexistent' : `file://${path.join(root, 'mirror')}` },
  });
  return { root, home, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const systemHasNode = ['/usr/bin/node', '/bin/node', '/usr/sbin/node', '/sbin/node'].some(p => require('node:fs').existsSync(p));

test('没有 Node.js 时下载官方包到用户目录、校验 SHA-256，再安装 PM2', { skip: systemHasNode }, () => {
  const box = pm2Sandbox();
  try {
    const result = box.run([]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Node\.js 已安装：v22\.9\.9/);
    assert.match(result.stdout, /PM2\s+已安装\s+pm2 7\.0\.0-fake/);
    const fs = require('node:fs');
    assert.ok(fs.existsSync(path.join(box.home, '.local/node/bin/node')));
    assert.ok(fs.existsSync(path.join(box.home, '.local/node/bin/pm2')));
    const rc = fs.readFileSync(path.join(box.home, process.platform === 'darwin' ? '.bash_profile' : '.bashrc'), 'utf8');
    assert.equal(rc.split('.local/node/bin').length - 1, 1, 'PATH 只写入一次');
    const again = box.run([]);
    assert.equal(again.status, 0);
    assert.doesNotMatch(again.stdout, /正在安装 Node/);
    assert.match(again.stdout, /PM2\s+已安装/);
  } finally { box.cleanup(); }
});

test('Node.js 安装包校验和不一致时拒绝安装', { skip: systemHasNode }, () => {
  const box = pm2Sandbox({ wrongChecksum: true });
  try {
    const result = box.run([]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /校验失败/);
    assert.match(result.stdout, /PM2\s+失败/);
    assert.ok(!require('node:fs').existsSync(path.join(box.home, '.local/node')));
  } finally { box.cleanup(); }
});

test('已安装 PM2 时不下载任何东西；--skip pm2 和 --check 不安装', () => {
  const box = pm2Sandbox({ withPm2: true });
  try {
    const result = box.run([]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PM2\s+已安装\s+pm2 6\.0\.0-existing/);
    assert.ok(!require('node:fs').existsSync(path.join(box.home, '.local/node')));
    assert.match(box.run(['--skip', 'pm2']).stdout, /PM2\s+跳过/);
  } finally { box.cleanup(); }
  if (!systemHasNode) {
    const bare = pm2Sandbox();
    try {
      const check = bare.run(['--check']);
      assert.equal(check.status, 0);
      assert.match(check.stdout, /PM2\s+未安装/);
      assert.ok(!require('node:fs').existsSync(path.join(bare.home, '.local/node')));
    } finally { bare.cleanup(); }
  }
});
