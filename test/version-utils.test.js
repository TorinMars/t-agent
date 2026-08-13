const test = require('node:test');
const assert = require('node:assert/strict');
const {
  compareSemver,
  githubVersionUrlFromRemote,
  parseSemver,
  validateGithubVersionUrl,
  validateVersionManifest,
} = require('../lib/version-utils');
const { decryptToken, encryptToken } = require('../lib/token-crypto');
const { normalizeBaseUrl } = require('../services/remote-client');

test('compares stable and prerelease SemVer values', () => {
  assert.equal(compareSemver('1.2.0', '1.1.9'), 1);
  assert.equal(compareSemver('1.0.0-beta.2', '1.0.0-beta.11'), -1);
  assert.equal(compareSemver('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareSemver('1.0.0+build.2', '1.0.0+build.1'), 0);
  assert.equal(parseSemver('1.0.0-01'), null);
});

test('derives a raw GitHub VERSION.json URL from common remotes', () => {
  assert.equal(githubVersionUrlFromRemote('git@github.com:TorinMars/t-agent.git', 'main'), 'https://raw.githubusercontent.com/TorinMars/t-agent/main/VERSION.json');
  assert.equal(githubVersionUrlFromRemote('https://github.com/TorinMars/t-agent.git', 'release'), 'https://raw.githubusercontent.com/TorinMars/t-agent/release/VERSION.json');
});

test('only trusts HTTPS GitHub version hosts', () => {
  assert.equal(validateGithubVersionUrl('https://raw.githubusercontent.com/a/b/main/VERSION.json').hostname, 'raw.githubusercontent.com');
  assert.throws(() => validateGithubVersionUrl('http://raw.githubusercontent.com/a/b/main/VERSION.json'));
  assert.throws(() => validateGithubVersionUrl('https://example.com/VERSION.json'));
});

test('validates version manifest schema and release links', () => {
  const manifest = {
    app_version: '1.0.0', api_version: 1, schema_version: 1,
    min_remote_api_version: 1, max_remote_api_version: 1,
    release_url: 'https://github.com/a/b/releases/tag/v1.0.0',
  };
  assert.equal(validateVersionManifest(manifest), manifest);
  assert.throws(() => validateVersionManifest({ ...manifest, app_version: 'latest' }));
  assert.throws(() => validateVersionManifest({ ...manifest, release_url: 'https://example.com/release' }));
});

test('encrypts stored remote tokens with authenticated encryption', () => {
  const encrypted = encryptToken('txw_secret-value', 'session-secret');
  assert.notEqual(encrypted, 'txw_secret-value');
  assert.equal(decryptToken(encrypted, 'session-secret'), 'txw_secret-value');
  assert.throws(() => decryptToken(encrypted, 'wrong-secret'));
});

test('normalizes URL and port from the three-field remote form', () => {
  assert.equal(normalizeBaseUrl('http://192.168.1.20', '14002'), 'http://192.168.1.20:14002');
  assert.equal(normalizeBaseUrl('https://example.com', ''), 'https://example.com');
  assert.throws(() => normalizeBaseUrl('file:///tmp/tasks', ''));
  assert.throws(() => normalizeBaseUrl('https://example.com/path', ''));
});
