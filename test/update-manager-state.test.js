const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('更新状态始终返回磁盘上实际安装的版本', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-update-state-'));
  process.env.T_AGENT_DB_PATH = path.join(tempDir, 'db.sqlite');
  process.env.T_AGENT_DATA_DIR = tempDir;

  const db = require('../db');
  db.prepare(`INSERT INTO system_state (key, value) VALUES ('update_state', ?)`)
    .run(JSON.stringify({ status: 'updating', stage: 'restarting', local_version: '1.0.0' }));
  const updates = require('../services/update-manager');
  const manifest = updates.readLocalManifest();

  assert.equal(updates.publicState().local_version, manifest.app_version);
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
