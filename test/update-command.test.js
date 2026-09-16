const test = require('node:test');
const assert = require('node:assert/strict');
const { runUpdateCommand } = require('../lib/update-command');

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
