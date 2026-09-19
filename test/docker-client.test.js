const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureClientSecret } = require('../services/docker-client');

test('Docker Client secret persists across restarts with private permissions', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-client-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = ensureClientSecret(dir);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(ensureClientSecret(dir), first);
  assert.equal(fs.statSync(path.join(dir, 'client-session-secret')).mode & 0o777, 0o600);
});

test('Docker Client never replaces a damaged or conflicting persisted secret', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-client-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configured = 'explicit-migration-secret-'.repeat(3);
  assert.equal(ensureClientSecret(dir, configured), configured);
  assert.equal(ensureClientSecret(dir), configured);
  assert.throws(() => ensureClientSecret(dir, 'different-'.repeat(8)), /MISMATCH/);
  fs.writeFileSync(path.join(dir, 'client-session-secret'), '');
  assert.throws(() => ensureClientSecret(dir), /INVALID/);
  assert.equal(fs.readFileSync(path.join(dir, 'client-session-secret'), 'utf8'), '');
});

test('Docker Client deployment keeps enrollment private and supports both image targets', () => {
  const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
  const compose = read('compose.client.yml');
  assert.match(compose, /target: client/);
  assert.match(compose, /127\.0\.0\.1.*3000/);
  assert.match(compose, /HOST: 0\.0\.0\.0/);
  assert.match(compose, /NODE_ENV: production/);
  for (const mount of ['data:/var/lib/t-agent', 'tasks}:/workspace', 'codex:/root/.codex']) assert.ok(compose.includes(mount));
  assert.doesNotMatch(compose, /docker\.sock|privileged:/);
  const nginx = read('docker/client.nginx.conf.example');
  assert.match(nginx, /X-Forwarded-Proto \$scheme/);
  assert.match(nginx, /Upgrade \$http_upgrade/);
  assert.match(read('.github/workflows/docker-engine.yml'), /target: \$\{\{ matrix.target \}\}/);
});

test('Docker Client refuses to generate a replacement key for an existing database', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-client-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'db.sqlite'), 'existing database fixture');
  assert.throws(() => ensureClientSecret(dir), /MISSING/);
  assert.equal(fs.existsSync(path.join(dir, 'client-session-secret')), false);
  assert.equal(ensureClientSecret(dir, 'original-migration-secret-'.repeat(3)), 'original-migration-secret-'.repeat(3));
});
