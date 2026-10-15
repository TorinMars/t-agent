// Download addresses in the lockfile must be the public npm registry: when a company-internal mirror is configured on this machine, npm install writes intranet addresses into the lockfile,
// which makes npm ci fail in external environments such as GitHub Actions (ENOTFOUND).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('package-lock.json only resolves packages from the public npm registry', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '../package-lock.json'), 'utf8'));
  const offenders = Object.entries(lock.packages)
    .filter(([, info]) => info.resolved && !info.resolved.startsWith('https://registry.npmjs.org/'))
    .map(([name, info]) => `${name} -> ${info.resolved}`);
  assert.deepEqual(offenders, [], 'Use npm install --registry=https://install from registry.npmjs.org, or change resolved back to registry.npmjs.org');
});
