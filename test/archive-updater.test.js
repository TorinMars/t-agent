const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  copyRelease,
  githubArchiveUrl,
  validateRef,
  validateRepository,
} = require('../services/archive-updater');

test('validates GitHub archive repository and branch', () => {
  assert.equal(validateRepository('TorinMars/t-agent'), 'TorinMars/t-agent');
  assert.equal(validateRef('codex/component-engine-client-token'), 'codex/component-engine-client-token');
  assert.equal(
    githubArchiveUrl('TorinMars/t-agent', 'main'),
    'https://github.com/TorinMars/t-agent/archive/refs/heads/main.tar.gz',
  );
  assert.throws(() => validateRepository('../t-agent'));
  assert.throws(() => validateRef('../main'));
});

test('archive copy updates code while preserving runtime data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-copy-test-'));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  fs.mkdirSync(path.join(source, 'public'), { recursive: true });
  fs.mkdirSync(path.join(source, 'data'), { recursive: true });
  fs.mkdirSync(path.join(source, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(target, 'public'), { recursive: true });
  fs.mkdirSync(path.join(target, 'data'), { recursive: true });
  fs.mkdirSync(path.join(target, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(source, 'public', 'app.js'), 'new code');
  fs.writeFileSync(path.join(source, 'data', 'db.sqlite'), 'new database');
  fs.writeFileSync(path.join(source, 'tasks', 'task.md'), 'new task');
  fs.writeFileSync(path.join(source, '.env'), 'NEW_SECRET=unsafe');
  fs.writeFileSync(path.join(target, 'public', 'app.js'), 'old code');
  fs.writeFileSync(path.join(target, 'data', 'db.sqlite'), 'current database');
  fs.writeFileSync(path.join(target, 'tasks', 'task.md'), 'current task');
  fs.writeFileSync(path.join(target, '.env'), 'SESSION_SECRET=keep');

  try {
    copyRelease(source, target);
    assert.equal(fs.readFileSync(path.join(target, 'public', 'app.js'), 'utf8'), 'new code');
    assert.equal(fs.readFileSync(path.join(target, 'data', 'db.sqlite'), 'utf8'), 'current database');
    assert.equal(fs.readFileSync(path.join(target, 'tasks', 'task.md'), 'utf8'), 'current task');
    assert.equal(fs.readFileSync(path.join(target, '.env'), 'utf8'), 'SESSION_SECRET=keep');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
