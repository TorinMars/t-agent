const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

test('Docker Client 固定构建工具链并只提供 client 目标', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');

  assert.match(dockerfile, /FROM node:22-bookworm AS dependencies/);
  assert.match(dockerfile, /build-essential python3 pkg-config/);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /npm install -g "@openai\/codex@\$\{CODEX_VERSION\}"/);
  assert.match(dockerfile, /codex --version/);
  assert.match(dockerfile, /FROM runtime AS client/);
  assert.doesNotMatch(dockerfile, /AS engine|apps\/engine/);
  for (const removed of ['compose.engine.yml', 'scripts/docker-engine-update.sh', 'apps/engine']) {
    assert.equal(fs.existsSync(path.join(root, removed)), false, `${removed} 应已删除`);
  }
});
