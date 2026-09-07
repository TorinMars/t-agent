const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('Docker 更新状态返回实际版本并拒绝容器内自更新', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-update-state-'));
  process.env.T_AGENT_DB_PATH = path.join(tempDir, 'db.sqlite');
  process.env.T_AGENT_DATA_DIR = tempDir;
  process.env.T_AGENT_INSTALL_TYPE = 'docker';

  const db = require('../db');
  db.prepare(`INSERT INTO system_state (key, value) VALUES ('update_state', ?)`)
    .run(JSON.stringify({ status: 'updating', stage: 'restarting', local_version: '1.0.0' }));
  const updates = require('../services/update-manager');
  const manifest = updates.readLocalManifest();

  assert.equal(updates.publicState().local_version, manifest.app_version);
  assert.equal(updates.publicState().install_type, 'docker');
  await assert.rejects(updates.apply(), /DOCKER_MANAGED_UPDATE/);
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
