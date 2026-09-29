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
});

test('安装脚本中变量名后不能直接紧跟中文字符（UTF-8 下会被当作变量名的一部分）', () => {
  const source = require('node:fs').readFileSync(script, 'utf8');
  const offenders = source.split('\n').map((line, index) => [index + 1, line])
    .filter(([, line]) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/.test(line));
  assert.deepEqual(offenders, []);
});
