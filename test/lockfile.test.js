// 锁文件里的下载地址必须是公开的 npm 源：本机配置了公司内部镜像时，npm install 会把内网地址写进锁文件，
// 导致 GitHub Actions 等外部环境 npm ci 失败（ENOTFOUND）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('package-lock.json only resolves packages from the public npm registry', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '../package-lock.json'), 'utf8'));
  const offenders = Object.entries(lock.packages)
    .filter(([, info]) => info.resolved && !info.resolved.startsWith('https://registry.npmjs.org/'))
    .map(([name, info]) => `${name} -> ${info.resolved}`);
  assert.deepEqual(offenders, [], '用 npm install --registry=https://registry.npmjs.org 安装，或把 resolved 改回 registry.npmjs.org');
});
