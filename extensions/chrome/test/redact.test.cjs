// The extension's redaction (extensions/chrome/redact.js) must behave exactly like the server's (lib/browser-redact.js),
// because both redact the same captured data. This test runs the extension copy against the canonical vector file that
// also tests the server (test/fixtures/browser-redact-vectors.json), so the two can never drift. A trimmed copy lives at
// extensions/chrome/redact-vectors.json for running the extension on its own; keep-extension-redact.js regenerates both.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CANONICAL = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'browser-redact-vectors.json');

test('extension redaction matches the canonical server vectors', async t => {
  const { redact, headers, url } = await import('../redact.js');
  const v = JSON.parse(fs.readFileSync(CANONICAL, 'utf8'));
  for (const e of v.keys || []) {
    await t.test(`key ${e.name}`, () => {
      const out = redact({ [e.name]: e.value });
      const masked = out[e.name] !== e.value;
      assert.equal(masked, !!e.secret, `${e.name}=${JSON.stringify(e.value)} -> ${JSON.stringify(out[e.name])}`);
    });
  }
  for (const [i, e] of (v.headers || []).entries()) {
    await t.test(`headers ${i + 1}`, () => assert.deepEqual(headers(e.in), e.out));
  }
  for (const [i, e] of (v.urls || []).entries()) {
    await t.test(`url ${i + 1}`, () => assert.deepEqual(url(e.in), e.out));
  }
  for (const [i, e] of (v.json || []).entries()) {
    await t.test(`json ${i + 1}`, () => assert.deepEqual(redact(e.in), e.out));
  }
});

test('redaction keeps duplicate keys, writes raw marks and is idempotent', async () => {
  const { redact } = await import('../redact.js');
  const data = {
    url: 'http://localhost/?token=a&token=bb&safe=x',
    body: 'csrf=a&csrf=bb',
    headers: { Cookie: 'abc', 'x-plain': 'public' },
  };
  const safe = redact(data);
  assert.deepEqual(new URL(safe.url).searchParams.getAll('token'), ['<redacted:1>', '<redacted:2>']);
  assert.deepEqual(new URLSearchParams(safe.body).getAll('csrf'), ['<redacted:1>', '<redacted:2>']);
  assert.equal(safe.headers['x-plain'], 'public');
  assert.equal(safe.headers.Cookie, '<redacted:3>');
  assert.match(safe.url, /token=<redacted:1>/); // raw mark, not percent-encoded
  assert.deepEqual(redact(safe), safe); // idempotent
});

test('all secret keys, nested arrays, JWT and UTF-8 byte caps', async () => {
  const { redact, cut } = await import('../redact.js');
  for (const key of ['token', 'secret', 'session', 'password', 'pwd', 'api-key', 'api_key', 'auth', 'signature', 'csrf', 'xsrf', 'cookie', 'ticket', 'code_verifier']) {
    assert.equal(redact({ [key]: 'abc' })[key], '<redacted:3>', key);
  }
  assert.equal(redact({ author: 'Ann' }).author, 'Ann'); // SAFE_WORDS kept
  assert.deepEqual(
    redact([{ nested: { ticket: 'abc' }, value: 'eyJabc.def.ghi' }]),
    [{ nested: { ticket: '<redacted:3>' }, value: '<redacted:14>' }],
  );
  assert.deepEqual(cut('éé', 3), { text: 'é', truncated: true });
});
