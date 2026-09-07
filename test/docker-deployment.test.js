const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

test('Docker Engine 固定构建工具链并使用持久化目录', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'compose.engine.yml'), 'utf8');
  const updater = fs.readFileSync(path.join(root, 'scripts/docker-engine-update.sh'), 'utf8');

  assert.match(dockerfile, /FROM node:22-bookworm AS dependencies/);
  assert.match(dockerfile, /build-essential python3 pkg-config/);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(compose, /T_AGENT_INSTALL_TYPE: docker/);
  assert.match(compose, /target: engine/);
  assert.match(compose, /T_AGENT_DATA_DIR: \/var\/lib\/t-agent/);
  assert.match(compose, /T_AGENT_ENGINE_STORAGE_DIR.*\/data:\/var\/lib\/t-agent/);
  assert.match(compose, /T_AGENT_ENGINE_STORAGE_DIR.*\/tasks/);
  assert.doesNotMatch(compose, /docker\.sock/);
  assert.match(updater, /docker compose/);
});
