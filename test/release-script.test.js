const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'scripts', 'release.js');
const json = value => `${JSON.stringify(value, null, 2)}\n`;

function project(versions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-'));
  const v = { info: '1.2.3', pkg: '1.2.3', lock: '1.2.3', lockRoot: '1.2.3', ...versions };
  fs.writeFileSync(path.join(dir, 'VERSION.json'), json({ app_version: v.info, api_version: 1, schema_version: 6, published_at: '2020-01-01T00:00:00.000Z' }));
  fs.writeFileSync(path.join(dir, 'package.json'), json({ name: 'x', version: v.pkg }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), json({ name: 'x', version: v.lock, packages: { '': { name: 'x', version: v.lockRoot }, 'node_modules/y': { version: '9.9.9' } } }));
  fs.writeFileSync(path.join(dir, 'DESIGN.md'), '# Design\n> v1.2.3 old note\n');
  return dir;
}
const run = (dir, ...args) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, RELEASE_ROOT: dir }, encoding: 'utf8' });
const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

test('patch bumps every version field, the time and the design note, and nothing else', () => {
  const dir = project();
  const result = run(dir, 'patch', 'Something changed.');
  assert.equal(result.status, 0, result.stderr);
  const info = read(dir, 'VERSION.json');
  assert.deepEqual([info.app_version, info.api_version, info.schema_version], ['1.2.4', 1, 6], 'the protocol versions stay');
  assert.notEqual(info.published_at, '2020-01-01T00:00:00.000Z');
  assert.equal(read(dir, 'package.json').version, '1.2.4');
  const lock = read(dir, 'package-lock.json');
  assert.deepEqual([lock.version, lock.packages[''].version, lock.packages['node_modules/y'].version], ['1.2.4', '1.2.4', '9.9.9'], 'only the project, not its dependencies');
  assert.equal(fs.readFileSync(path.join(dir, 'DESIGN.md'), 'utf8'), '# Design\n> v1.2.3 old note\n> v1.2.4 Something changed.\n');
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), json({ name: 'x', version: '1.2.4' }), 'the file keeps its format');
});

test('minor, major and an exact version; a bad argument changes nothing', () => {
  assert.equal(read(project(), 'VERSION.json').app_version, '1.2.3');
  for (const [bump, expected] of [['minor', '1.3.0'], ['major', '2.0.0'], ['4.5.6', '4.5.6']]) {
    const dir = project();
    assert.equal(run(dir, bump).status, 0);
    assert.equal(read(dir, 'VERSION.json').app_version, expected);
  }
  const dir = project();
  const bad = run(dir, 'sideways');
  assert.notEqual(bad.status, 0);
  assert.equal(read(dir, 'VERSION.json').app_version, '1.2.3');
});

test('--dry-run changes nothing, and fields that disagree stop the release', () => {
  const dir = project();
  const dry = run(dir, 'patch', '--dry-run');
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /1\.2\.3 -> 1\.2\.4/);
  assert.equal(read(dir, 'VERSION.json').app_version, '1.2.3');

  const mixed = project({ lockRoot: '1.2.0' });
  const result = run(mixed, 'patch');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /disagree/);
  assert.equal(read(mixed, 'package.json').version, '1.2.3', 'nothing was written');
});
