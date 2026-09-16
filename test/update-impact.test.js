const test = require('node:test');
const assert = require('node:assert/strict');
const { requiresRestart } = require('../lib/update-impact');

function git(files, before = {}, after = {}) {
  return async args => {
    if (args[0] === 'diff') {
      assert.equal(args[3], 'running');
      return files.join('\0');
    }
    const [ref, file] = args[1].split(':');
    return JSON.stringify((ref === 'running' ? before : after)[file]);
  };
}
test('static assets and release-only metadata do not require a restart', async () => {
  const before = { 'package.json': { version: '1.0.0', dependencies: { a: '1' } },
    'package-lock.json': { version: '1.0.0', packages: { '': { version: '1.0.0' } } },
    'VERSION.json': { app_version: '1.0.0', schema_version: 5 } };
  const after = structuredClone(before);
  after['package.json'].version = after['package-lock.json'].version = after['package-lock.json'].packages[''].version = '1.0.1';
  after['VERSION.json'].app_version = '1.0.1';
  after['VERSION.json'].published_at = 'today';
  assert.equal(await requiresRestart(git(['public/js/tasks.js', 'test/new.test.js', ...Object.keys(before)], before, after), 'running', 'target'), false);
});
test('server, engine, build source and dependency changes require restart', async () => {
  for (const file of ['server.js', 'apps/engine/server.js', 'scripts/monaco-entry.js', 'config.js']) {
    assert.equal(await requiresRestart(git([file]), 'running', 'target'), true);
  }
  assert.equal(await requiresRestart(git(['package.json'], { 'package.json': { dependencies: { a: '1' } } }, { 'package.json': { dependencies: { a: '2' } } }), 'running', 'target'), true);
  assert.equal(await requiresRestart(git(['VERSION.json'], { 'VERSION.json': { schema_version: 5 } }, { 'VERSION.json': { schema_version: 6 } }), 'running', 'target'), true);
});
test('missing runtime baseline or unreadable metadata requires restart', async () => {
  assert.equal(await requiresRestart(git([]), null, 'target'), true);
  assert.equal(await requiresRestart(git(['package.json']), 'running', 'target'), true);
});
