// lib/browser-site-secret: the save-time redaction and SITE_HAS_SECRET guard for the site-capability library. It builds
// on the canonical lib/browser-redact (secret-named keys, whole-value JWTs) and adds, for authored entries, masking of
// any JWT / bearer value and a refusal of opaque provider keys and high-entropy runs the length-preserving rule cannot
// shape. Token-shaped fixtures are assembled at runtime (join / concat) so no key-looking literal sits in the source.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { redactEntry, hasResidualSecret, residualSecretPath, valueLooksSecret, looksLikeOpaqueToken } = require('../lib/browser-site-secret');

const providerKey = ['sk', 'live', '4eC39HqLyjWDarjtT1zdp7dc12345678'].join('_'); // a Stripe-shaped fake, never a real key
const githubPat = `ghp${'_'}0123456789abcdefghijABCDEFGHIJ0123`;
const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjMifQ', 'c2ln'].join('.');

test('redactEntry masks secret-named keys and whole JWT / bearer values anywhere', () => {
  const out = redactEntry({
    apis: [{ name: 'a', request_example: 'Authorization: Bearer abcdef1234567890xyz', params: [{ name: 'session_token', description: jwt }] }],
    author: 'Ann',
    page_count: 7,
  });
  assert.match(out.apis[0].request_example, /^<redacted:\d+>$/, 'a bearer in free text is masked');
  assert.match(out.apis[0].params[0].description, /^<redacted:\d+>$/, 'a JWT value is masked');
  assert.equal(out.author, 'Ann', 'a safe word is kept');
  assert.equal(out.page_count, 7, 'a plain number is kept');
});

test('hasResidualSecret refuses an opaque provider key or high-entropy run left after redaction', () => {
  for (const value of [providerKey, githubPat, 'NOTAREALKEY0000testfixture1234567890abcd']) {
    const redacted = redactEntry({ notes: `the value is ${value}` });
    assert.equal(hasResidualSecret(redacted), true, value.slice(0, 6));
    assert.equal(residualSecretPath(redacted), 'notes');
  }
});

test('ordinary content is not flagged as a secret', () => {
  const redacted = redactEntry({
    summary: 'Open the repo, click New, fill the form and submit. The short commit is 0123abc.',
    pages: [{ pattern: '/*/settings', purpose: 'settings' }],
    author: 'the-maintainer',
  });
  // A full 40-char hex sha would trip the high-entropy net (a known limitation); a short hash and ordinary prose do not.
  assert.equal(hasResidualSecret(redacted), false, 'prose and a short commit hash are fine');
  assert.equal(valueLooksSecret('just some words'), false);
  assert.equal(looksLikeOpaqueToken('short'), false);
});
