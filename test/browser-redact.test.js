// lib/browser-redact.js: the shared vectors (test/fixtures/browser-redact-vectors.json, which the extension's own redact.js passes too), that redacting
// twice changes nothing, and the server's wider pass over recording items and answers (redactDeep).
const test = require('node:test');
const assert = require('node:assert/strict');
const redact = require('../lib/browser-redact');
const vectors = require('./fixtures/browser-redact-vectors.json');

test('the vectors file has every section', () => {
  assert.equal(vectors.version, 1);
  for (const section of ['keys', 'headers', 'urls', 'bodies', 'json']) assert.ok(vectors[section].length >= 3, section);
});

test('names: secret or not, as the vectors say', () => {
  for (const { name, value, secret } of vectors.keys) assert.equal(redact.keyIsSecret(name, value), secret, `${name} = ${JSON.stringify(value)}`);
});

test('headers, URLs, bodies and JSON give the vector results, and a second pass changes nothing', () => {
  for (const { in: input, out } of vectors.headers) {
    assert.deepEqual(redact.redactHeaders(input), out);
    assert.deepEqual(redact.redactHeaders(out), out);
  }
  for (const { in: input, out } of vectors.urls) {
    assert.equal(redact.redactUrl(input), out, input);
    assert.equal(redact.redactUrl(out), out);
  }
  for (const { in: input, mime, out } of vectors.bodies) {
    assert.equal(redact.redactBody(input, mime), out, input);
    assert.equal(redact.redactBody(out, mime), out);
  }
  for (const { in: input, out } of vectors.json) {
    assert.deepEqual(redact.redactJson(input), out);
    assert.deepEqual(redact.redactJson(out), out);
  }
});

test('false positives that must stay: author, authority, the :authority pseudo header, counts of tokens', () => {
  assert.deepEqual(redact.redactHeaders({ ':authority': 'github.com', 'X-Author': 'ann' }), { ':authority': 'github.com', 'X-Author': 'ann' });
  assert.deepEqual(redact.redactJson({ author: 'ann', authors: ['a'], usage: { prompt_tokens: 10, total_tokens: 30 } }), { author: 'ann', authors: ['a'], usage: { prompt_tokens: 10, total_tokens: 30 } });
  assert.equal(redact.keyIsSecret('authorization', 'x'), true, 'author is a safe word, authorization is not');
  assert.equal(redact.keyIsSecret('auth_author', 'x'), true, 'auth is still a secret word next to author');
});

test('the length in the mark is the length of the value', () => {
  assert.deepEqual(redact.redactJson({ password: 'hunter2', session: 12345, auth: { a: 1 } }), { password: '<redacted:7>', session: '<redacted:5>', auth: '<redacted:7>' });
});

test('server pass: a recording request item, input of a secret field, console text, submit fields', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
  const item = redact.redactDeep({
    seq: 1, kind: 'request', url: 'https://a.test/api?token=abc&q=1',
    request: { headers: { Cookie: 'sid=1', 'Content-Type': 'application/json' }, post_data: '{"password":"pw","name":"n"}' },
    response: { mime: 'application/json', body: '{"access_token":"t","items":[1,2]}', headers: [{ name: 'Set-Cookie', value: 'sid=2' }] },
  });
  assert.equal(item.url, 'https://a.test/api?token=<redacted:3>&q=1');
  assert.equal(item.request.headers.Cookie, '<redacted:5>');
  assert.equal(item.request.headers['Content-Type'], 'application/json');
  assert.equal(item.request.post_data, '{"password":"<redacted:2>","name":"n"}');
  assert.equal(item.response.body, '{"access_token":"<redacted:1>","items":[1,2]}');
  assert.equal(item.response.headers[0].value, '<redacted:5>');

  assert.equal(redact.redactDeep({ kind: 'input', target: { type: 'password' }, value: 'pw' }).value, '<redacted:2>');
  assert.equal(redact.redactDeep({ kind: 'input', target: { autocomplete: 'one-time-code', name: 'otp_token' }, value: '123456' }).value, '<redacted:6>');
  assert.equal(redact.redactDeep({ kind: 'input', target: { name: 'search' }, value: 'shoes' }).value, 'shoes');
  assert.equal(redact.redactDeep({ kind: 'console', text: `token ${jwt} and Authorization: Bearer abcdefgh12345` }).text, `token <redacted:${jwt.length}> and Authorization: Bearer <redacted:13>`);
  assert.deepEqual(redact.redactDeep({ kind: 'submit', fields: { email: 'a@b.c', password: 'p', csrf_token: 'c' } }).fields, { email: 'a@b.c', password: '<redacted:1>', csrf_token: '<redacted:1>' });
  assert.equal(redact.redactDeep({ kind: 'nav', from: 'https://a.test/#access_token=xyz', to: 'https://a.test/home' }).from, 'https://a.test/#access_token=<redacted:3>');
  assert.equal(redact.redactDeep({ kind: 'ws', data: '{"type":"auth","token":"tt"}' }).data, '{"type":"auth","token":"<redacted:2>"}');
  const twice = redact.redactDeep(redact.redactDeep(item));
  assert.deepEqual(twice, item, 'the server pass is stable');
});
