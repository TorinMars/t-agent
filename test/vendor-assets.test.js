// Third-party frontend libraries are pinned, self-hosted and hash-verified; the page no longer depends on a runtime CDN.
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
  // The main page must load marked / xterm synchronously; mermaid may only be lazy-loaded (about 5 MB).
  const index = read('public/index.html');
  assert.match(index, /\/vendor\/marked\/marked-[\d.]+\.min\.js/);
  assert.match(index, /\/vendor\/xterm\/xterm-[\d.]+\.js/);
  assert.doesNotMatch(index, /<script[^>]*mermaid/, 'mermaid is not loaded eagerly');
  assert.match(read('public/js/tasks.js'), /MERMAID_SRC = '\/vendor\/mermaid\/mermaid-[\d.]+\.min\.js'/);
});
