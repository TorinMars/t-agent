const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const script = path.join(__dirname, '..', 'scripts/docker-client-copy-codex.sh');

test('copies host Codex once and keeps the container copy independent', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'host .codex');
  const target = path.join(root, 'client codex');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'auth.json'), '{"test":"original"}', { mode: 0o600 });
  fs.writeFileSync(path.join(source, '.hidden'), 'settings');
  execFileSync('bash', [script, target, source]);
  assert.equal(fs.readFileSync(path.join(target, '.hidden'), 'utf8'), 'settings');
  fs.writeFileSync(path.join(source, 'auth.json'), 'host changed');
  assert.equal(fs.readFileSync(path.join(target, 'auth.json'), 'utf8'), '{"test":"original"}');
  fs.writeFileSync(path.join(target, 'auth.json'), 'container renewed');
  execFileSync('bash', [script, target, source]);
  assert.equal(fs.readFileSync(path.join(target, 'auth.json'), 'utf8'), 'container renewed');
  assert.equal(fs.readFileSync(path.join(source, 'auth.json'), 'utf8'), 'host changed');
  assert.throws(() => execFileSync('bash', [script, source, source], { stdio: 'pipe' }));
});

test('copy failures leave an empty destination that can be retried', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); const target = path.join(root, 'target');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'config.toml'), '# copied');
  fs.symlinkSync(path.join(root, 'missing'), path.join(source, 'auth.json'));
  assert.throws(() => execFileSync('bash', [script, target, source], { stdio: 'pipe' }));
  assert.deepEqual(fs.readdirSync(target), []);
  fs.writeFileSync(path.join(root, 'missing'), 'linked credentials');
  execFileSync('bash', [script, target, source]);
  assert.equal(fs.lstatSync(path.join(target, 'auth.json')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(target, 'auth.json'), 'utf8'), 'linked credentials');
});
