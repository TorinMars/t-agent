const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('The update status returns the actual version instead of the old one in the database', async () => {
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

test('The npm used for updates has short retries and timeouts and does not override values the user already set', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-update-npm-env-'));
  process.env.T_AGENT_DB_PATH = path.join(tempDir, 'db.sqlite');
  process.env.T_AGENT_DATA_DIR = tempDir;
  const { npmEnv } = require('../services/update-manager');
  const saved = { retries: process.env.npm_config_fetch_retries, timeout: process.env.npm_config_fetch_timeout };
  try {
    delete process.env.npm_config_fetch_retries;
    process.env.npm_config_fetch_timeout = '123000';
    const env = npmEnv();
    assert.equal(env.npm_config_fetch_retries, '1');
    assert.equal(env.npm_config_fetch_timeout, '123000', 'a value the user already set is kept');
    assert.equal(env.npm_config_loglevel, 'http', 'each download prints a line so progress is visible');
  } finally {
    for (const [key, value] of [['npm_config_fetch_retries', saved.retries], ['npm_config_fetch_timeout', saved.timeout]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    require('../db').close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
