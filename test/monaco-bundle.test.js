// The Monaco bundle must be built with the maintained DOMPurify (scripts/build-monaco.js), not the old copy monaco-editor ships inside itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('the Monaco bundle carries the DOMPurify of node_modules, not the copy inside monaco-editor', () => {
  const installed = JSON.parse(read('node_modules/dompurify/package.json')).version;
  const vendored = /version = '([\d.]+)'/.exec(read('node_modules/monaco-editor/esm/vs/base/browser/dompurify/dompurify.js'))[1];
  const bundle = read('public/vendor/monaco/monaco.js');
  assert.notEqual(installed, vendored, 'the installed DOMPurify is newer than the one monaco-editor vendors (if they match, scripts/build-monaco.js no longer needs its redirect)');
  assert.ok(bundle.includes(`"${installed}"`), `the bundle contains DOMPurify ${installed}`);
  assert.equal(bundle.includes(`"${vendored}"`), false, `the bundle does not contain the vendored DOMPurify ${vendored}`);
});

test('package.json pins DOMPurify and builds Monaco with the script that redirects to it', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.overrides.dompurify, /^\d+\.\d+\.\d+$/, 'an exact version, so a lock file refresh cannot move it back');
  assert.equal(pkg.scripts['build:monaco'], 'node scripts/build-monaco.js');
});
