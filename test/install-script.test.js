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
  assert.match(run(['--help']).stdout, /claude、codex、ssh 或 sync/);
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
