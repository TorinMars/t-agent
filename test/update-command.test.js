const test = require('node:test');
const assert = require('node:assert/strict');
const { runUpdateCommand, runWithProgress, formatProgress } = require('../lib/update-command');

test('update commands print output, redact credentials and record completion', async t => {
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(line));
  const result = await runUpdateCommand(process.execPath, ['-e',
    "process.stdout.write('installed\\n'); process.stderr.write('https://user:secret@example.com token=private\\n');",
  ], {}, { stage: 'installing', errorCode: 'INSTALL_FAILED', streamOutput: true });
  assert.equal(result, 'installed');
  assert.ok(lines.some(line => line.includes('stdout: installed')));
  assert.ok(lines.some(line => line.includes('stderr: https://[redacted]@example.com token=[redacted]')));
  assert.ok(lines.at(-1).includes('完成，耗时'));
  assert.ok(lines.every(line => !line.includes('secret') && !line.includes('private')));
});

test('failed commands preserve exit code and diagnostic output', async t => {
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(line));
  await assert.rejects(runUpdateCommand(process.execPath, ['-e',
    "console.error('esbuild: command not found'); process.exit(127);",
  ], {}, { stage: 'building', errorCode: 'NPM_BUILDING_FAILED', streamOutput: true }), error => {
    assert.equal(error.message, 'NPM_BUILDING_FAILED');
    assert.match(error.details, /code=127/);
    assert.match(error.details, /esbuild: command not found/);
    return true;
  });
  assert.ok(lines.at(-1).includes('失败，耗时'));
});

test('missing executable reports ENOENT even without stdout or stderr', async t => {
  t.mock.method(console, 'log', () => {});
  await assert.rejects(runUpdateCommand('/nonexistent/t-agent-npm', [], {}, {
    stage: 'installing', errorCode: 'NPM_INSTALLING_FAILED',
  }), error => error.message === 'NPM_INSTALLING_FAILED' && /ENOENT/.test(error.details));
});

test('onOutput receives every redacted output line from stdout and stderr', async t => {
  t.mock.method(console, 'log', () => {});
  const seen = [];
  await runUpdateCommand(process.execPath, ['-e',
    "console.log('first'); console.error('npm http fetch GET 200 https://user:secret@registry.npmjs.org/a 12ms'); console.log('last');",
  ], {}, { stage: 'installing', errorCode: 'INSTALL_FAILED', streamOutput: true, onOutput: line => seen.push(line) });
  assert.deepEqual([...seen].sort(), ['first', 'last', 'npm http fetch GET 200 https://[redacted]@registry.npmjs.org/a 12ms'].sort());
});

test('formatProgress shows elapsed time and the last line, and warns when the command goes quiet', () => {
  assert.equal(formatProgress('正在安装依赖', 5_000, '', 5_000), '正在安装依赖 · 已用 5 秒 · 等待输出');
  assert.equal(formatProgress('正在安装依赖', 83_000, 'http fetch GET 200 x', 2_000), '正在安装依赖 · 已用 1 分 23 秒 · http fetch GET 200 x');
  const quiet = formatProgress('正在安装依赖', 95_000, 'http fetch GET 200 x', 45_000);
  assert.match(quiet, /已 45 秒无输出，可能是网络不通/);
  assert.equal(formatProgress('x', 1000, 'a'.repeat(300), 0).length < 140, true, 'long lines are truncated');
});

test('runWithProgress reports progress while the command runs and stops after it finishes or fails', async () => {
  const messages = [];
  let emit;
  const done = runWithProgress('正在安装依赖', onOutput => new Promise(resolve => { emit = onOutput; setTimeout(resolve, 120); }),
    message => messages.push(message), { intervalMs: 20 });
  await new Promise(resolve => setTimeout(resolve, 50));
  emit('http fetch GET 200 pkg');
  await done;
  assert.match(messages[0], /^正在安装依赖 · 已用 0 秒 · 等待输出$/);
  assert.ok(messages.length >= 3, 'ticks while running');
  assert.ok(messages.some(message => message.endsWith('http fetch GET 200 pkg')), 'last output line is shown');
  const count = messages.length;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(messages.length, count, 'no ticks after the command ended');

  const failed = [];
  await assert.rejects(runWithProgress('x', () => Promise.reject(new Error('NPM_INSTALLING_FAILED')), message => failed.push(message), { intervalMs: 20 }), /NPM_INSTALLING_FAILED/);
  const afterFailure = failed.length;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(failed.length, afterFailure, 'timer is cleared when the command fails');
});
