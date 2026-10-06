// 第三方前端库固定版本、自托管并校验哈希；页面不再依赖运行时 CDN。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'scripts/vendor-libs.json'), 'utf8'));
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('every vendored library exists locally and matches its pinned SHA-256', () => {
  assert.ok(manifest.libs.length >= 5);
  for (const lib of manifest.libs) {
    assert.match(lib.sha256, /^[0-9a-f]{64}$/, `${lib.name} has a hash`);
    assert.ok(lib.file.includes(lib.version), `${lib.file} carries its version so it can be cached forever`);
    assert.ok(lib.url.includes(`@${lib.version}`), `${lib.name} is downloaded from a pinned version`);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, lib.file))).digest('hex');
    assert.equal(actual, lib.sha256, `${lib.file} is unchanged; run node scripts/fetch-vendor.js after upgrading`);
  }
});

test('pages load libraries from /vendor, every referenced file is in the manifest, and no CDN remains', () => {
  const known = new Set(manifest.libs.map(lib => `/${lib.file.replace(/^public\//, '')}`));
  for (const file of ['public/index.html', 'public/js/tasks.js', 'server.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /cdn\.jsdelivr\.net/, `${file} must not use a runtime CDN`);
    for (const [, url] of source.matchAll(/(\/vendor\/(?:marked|mermaid|xterm)\/[\w.-]+)/g)) {
      assert.ok(known.has(url), `${file} references ${url}, which is not in scripts/vendor-libs.json`);
    }
  }
  // 主页面必须同步加载 marked / xterm；mermaid 只能懒加载（约 5 MB）。
  const index = read('public/index.html');
  assert.match(index, /\/vendor\/marked\/marked-[\d.]+\.min\.js/);
  assert.match(index, /\/vendor\/xterm\/xterm-[\d.]+\.js/);
  assert.doesNotMatch(index, /<script[^>]*mermaid/, 'mermaid is not loaded eagerly');
  assert.match(read('public/js/tasks.js'), /MERMAID_SRC = '\/vendor\/mermaid\/mermaid-[\d.]+\.min\.js'/);
});
