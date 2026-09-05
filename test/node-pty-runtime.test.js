const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { repairSpawnHelperPermissions } = require('../lib/node-pty-runtime');

test('repairs missing macOS spawn-helper execute permissions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-pty-helper-'));
  const helper = path.join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper');
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(helper, 'helper', { mode: 0o644 });
  try {
    assert.deepEqual(repairSpawnHelperPermissions(root, { platform: 'darwin', nodePtyRoot: root }), [helper]);
    assert.notEqual(fs.statSync(helper).mode & 0o111, 0);
    assert.deepEqual(repairSpawnHelperPermissions(root, { platform: 'darwin', nodePtyRoot: root }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not change spawn-helper permissions on non-macOS systems', () => {
  assert.deepEqual(repairSpawnHelperPermissions('/missing', { platform: 'linux' }), []);
});
