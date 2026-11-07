const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createOssImages, MAX_IMAGE_BYTES, MAX_FILE_BYTES, fileName, fileType, attachment } = require('../services/oss-images');
const input = { enabled: true, region: 'oss-cn-hangzhou', bucket: 'my-images', accessKeyId: 'test-key-id', accessKeySecret: 'test-secret', prefix: 'terminal/' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
function setup(t, client) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
  t.after(() => db.close());
  const options = { db, sessionSecret: 'session-secret', createClient: client };
  return { db, service: createOssImages(options), options };
}
test('config persists encrypted credentials, isolates owners and preserves blank secrets', t => {
  const { db, service, options } = setup(t);
  assert.equal(service.getConfig('alice').enabled, false);
  const saved = service.saveConfig('alice', input);
  assert.equal(saved.hasAccessKeySecret, true);
  assert.equal(saved.accessKeySecret, undefined);
  const disk = db.prepare('SELECT value FROM system_state').get().value;
  assert.ok(!disk.includes(input.accessKeySecret));
  assert.ok(!disk.includes(input.accessKeyId));
  assert.equal(createOssImages(options).getConfig('alice').bucket, input.bucket);
  assert.equal(service.getConfig('bob').enabled, false);
  service.saveConfig('alice', { ...input, accessKeySecret: '' });
  assert.equal(service.getConfig('alice').hasAccessKeySecret, true);
  service.clearConfig('alice');
  assert.equal(service.getConfig('alice').enabled, false);
});
test('config rejects invalid regions and unsafe public URLs without changing saved config', t => {
  const { service } = setup(t);
  service.saveConfig('a', input);
  for (const publicBaseUrl of ['http://images.example', 'https://user:pass@example.com', 'https://example.com/?x=1', 'https://example.com/#x', 'https://example.com/\nx', 'https://example.com/%0a']) {
    assert.throws(() => service.saveConfig('a', { ...input, publicBaseUrl }), /public address/i);
  }
  assert.throws(() => service.saveConfig('a', { ...input, region: 'https://evil.example' }), /region/i);
  assert.equal(service.getConfig('a').bucket, input.bucket);
});
const decode = fields => JSON.parse(Buffer.from(fields.policy, 'base64').toString('utf8'));
test('an upload policy pins one key, one type and the exact size, expires in minutes and never carries the secret', async t => {
  const signatures = [];
  const { service } = setup(t, () => ({
    signatureUrlV4: async (method, expires, opts, key) => { signatures.push([method, expires, opts, key]); return `https://my-images.oss-cn-hangzhou.aliyuncs.com/${key}?signature=abc`; },
  }));
  service.saveConfig('a', input);
  const before = Date.now();
  const first = await service.signUpload('a', { type: 'image/png', size: 70 });
  const second = await service.signUpload('a', { type: 'image/png', size: 70 });
  assert.equal(first.host, 'https://my-images.oss-cn-hangzhou.aliyuncs.com');
  assert.match(first.fields.key, /^terminal\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.png$/);
  assert.notEqual(first.fields.key, second.fields.key);
  assert.equal(JSON.stringify(first).includes(input.accessKeySecret), false, 'the secret is never sent to the browser');
  const policy = decode(first.fields);
  assert.ok(Date.parse(policy.expiration) > before && Date.parse(policy.expiration) <= Date.now() + 5 * 60 * 1000 + 1000);
  assert.deepEqual(policy.conditions.filter(Array.isArray), [
    ['eq', '$key', first.fields.key], ['eq', '$Content-Type', 'image/png'], ['eq', '$Content-Disposition', 'inline'],
    ['eq', '$success_action_status', '200'], ['content-length-range', 70, 70],
  ]);
  assert.deepEqual(policy.conditions.filter(item => !Array.isArray(item)).map(item => Object.keys(item)[0]), ['bucket', 'x-oss-signature-version', 'x-oss-credential', 'x-oss-date']);
  assert.equal(first.fields['x-oss-credential'], `test-key-id/${first.fields['x-oss-date'].slice(0, 8)}/cn-hangzhou/oss/aliyun_v4_request`);
  assert.equal(signatures[0][1], 86400);
  assert.match(first.url, /^https:\/\//);
  assert.ok(Date.parse(first.expiresAt) >= before + 86400000 - 1000);
  for (const body of [{ type: 'image/svg+xml', size: 5 }, { type: 'text/html', size: 5 }, { type: 'image/png', size: 0 }, { type: 'image/png', size: -1 }, { type: 'image/png', size: 1.5 }, { type: 'image/png', size: '70' }, { type: 'image/png', size: MAX_IMAGE_BYTES + 1 }, {}, undefined]) {
    await assert.rejects(service.signUpload('a', body), body && body.size > MAX_IMAGE_BYTES ? /10 MiB/ : /supported|empty/);
  }
  await assert.rejects(service.signUpload('other', { type: 'image/png', size: 5 }), /not enabled/);
});
test('public links have no expiry, and a failing signer never reveals credentials', async t => {
  const { service } = setup(t, () => ({ signatureUrlV4: () => { throw Error('must not sign'); } }));
  service.saveConfig('a', { ...input, publicBaseUrl: 'https://images.example/assets/' });
  const result = await service.signUpload('a', { type: 'image/jpeg', size: 9 });
  assert.equal(result.url, `https://images.example/assets/${result.fields.key}`);
  assert.match(result.fields.key, /\.jpg$/);
  assert.equal(result.expiresAt, null);
  const failing = createOssImages({ db: setup(t).db, sessionSecret: 'secret', createClient: () => ({ signatureUrlV4: async () => { throw Error(input.accessKeySecret); } }) });
  failing.saveConfig('a', input);
  await assert.rejects(failing.signUpload('a', { type: 'image/png', size: 9 }), error => error.message === 'Could not prepare the OSS upload; check the configuration' && !error.message.includes(input.accessKeySecret));
});
test('the policy signature equals the one the real OSS SDK computes, and the URL is an HTTPS V4 link', async t => {
  const OSS = require('ali-oss');
  const { service } = setup(t, options => new OSS(options));
  service.saveConfig('a', input);
  const result = await service.signUpload('a', { type: 'image/png', size: 70 });
  const policy = decode(result.fields);
  const stamp = result.fields['x-oss-date'];
  const date = new Date(Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(9, 11), +stamp.slice(11, 13), +stamp.slice(13, 15)));
  const sdk = new OSS({ region: input.region, bucket: input.bucket, accessKeyId: input.accessKeyId, accessKeySecret: input.accessKeySecret, authorizationV4: true });
  assert.equal(result.fields['x-oss-signature'], sdk.signPostObjectPolicyV4(policy, date));
  assert.equal(result.fields.policy, Buffer.from(JSON.stringify(policy)).toString('base64'));
  const parsed = new URL(result.url);
  assert.equal(parsed.protocol, 'https:');
  assert.equal(parsed.searchParams.get('x-oss-signature-version'), 'OSS4-HMAC-SHA256');
  assert.equal(parsed.searchParams.get('x-oss-expires'), '86400');
});

const signer = () => ({ signatureUrlV4: async (method, expires, opts, key) => `https://my-images.oss-cn-hangzhou.aliyuncs.com/${key}?signature=abc` });
test('a file that is not an image is an attachment under its original name, with its own type, key and 100 MiB limit', async t => {
  const { service } = setup(t, signer);
  service.saveConfig('a', input);
  const report = '\u5b63\u5ea6\u62a5\u544a 2026.pdf'; // a Chinese file name
  const result = await service.signUpload('a', { kind: 'file', type: 'application/pdf', size: 1234, name: report });
  const disposition = `attachment; filename="____ 2026.pdf"; filename*=UTF-8''${encodeURIComponent(report)}`;
  assert.match(result.fields.key, /^terminal\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.pdf$/);
  assert.equal(result.fields['Content-Type'], 'application/pdf');
  assert.equal(result.fields['Content-Disposition'], disposition);
  assert.equal(decodeURIComponent(disposition.split("UTF-8''")[1]), report, 'filename* decodes back to the original name');
  const policy = decode(result.fields);
  assert.ok(Date.parse(policy.expiration) <= Date.now() + 5 * 60 * 1000 + 1000);
  assert.deepEqual(policy.conditions.filter(Array.isArray), [
    ['eq', '$key', result.fields.key], ['eq', '$Content-Type', 'application/pdf'], ['eq', '$Content-Disposition', disposition],
    ['eq', '$success_action_status', '200'], ['content-length-range', 1234, 1234],
  ]);
  assert.match(result.url, /^https:\/\/my-images\.oss-cn-hangzhou\.aliyuncs\.com\/terminal\//);
  assert.equal(JSON.stringify(result).includes(input.accessKeySecret), false);
  // Above the image limit is fine for a file; the file limit is its own constant.
  assert.equal(MAX_FILE_BYTES, 100 * 1024 * 1024);
  const big = await service.signUpload('a', { kind: 'file', type: 'application/zip', size: MAX_FILE_BYTES, name: 'logs.ZIP' });
  assert.deepEqual(decode(big.fields).conditions.at(-1), ['content-length-range', MAX_FILE_BYTES, MAX_FILE_BYTES]);
  assert.match(big.fields.key, /\.zip$/, 'the key extension is lower case');
  await assert.rejects(service.signUpload('a', { kind: 'file', type: 'application/zip', size: MAX_FILE_BYTES + 1, name: 'a.zip' }), error => error.statusCode === 413 && /100 MiB/.test(error.message));
  for (const size of [0, -1, 1.5, '70', undefined]) await assert.rejects(service.signUpload('a', { kind: 'file', type: 'text/plain', size, name: 'a.txt' }), /empty/);
  // No name, a name that is not a string, only dots: the download is called "file" and the key has no extension.
  for (const name of [undefined, 42, '...', '/', '\u202e\u0000']) {
    const unnamed = await service.signUpload('a', { kind: 'file', type: 'text/plain', size: 3, name });
    assert.equal(unnamed.fields['Content-Disposition'], `attachment; filename="file"; filename*=UTF-8''file`);
    assert.match(unnamed.fields.key, /\/[0-9a-f-]{36}$/);
  }
  // Images keep exactly what they had: inline, an image extension, 10 MiB.
  const image = await service.signUpload('a', { type: 'image/png', size: 70 });
  assert.equal(image.fields['Content-Disposition'], 'inline');
  assert.match(image.fields.key, /\.png$/);
  await assert.rejects(service.signUpload('a', { type: 'image/png', size: MAX_IMAGE_BYTES + 1 }), /10 MiB/);
  // A file that only claims to be an image (the browser read other bytes) is still a download.
  const claimed = await service.signUpload('a', { kind: 'file', type: 'image/png', size: 5, name: 'fake.png' });
  assert.match(claimed.fields['Content-Disposition'], /^attachment; /);
  await assert.rejects(service.signUpload('other', { kind: 'file', type: 'text/plain', size: 5, name: 'a.txt' }), /not enabled/);
});
test('active content is never stored with its own type, and every non-image is an attachment', async t => {
  const { service } = setup(t, signer);
  service.saveConfig('a', input);
  for (const type of ['text/html', 'TEXT/HTML', 'application/xhtml+xml', 'image/svg+xml', 'application/javascript', 'text/javascript', 'application/x-javascript',
    'text/ecmascript', 'text/xml', 'application/xml', 'application/rss+xml', 'text/css', 'text/xsl', 'application/x-shockwave-flash', 'multipart/related', 'message/rfc822',
    'text/html; charset=utf-8', 'text/plain\r\nX-Evil: 1', 'text/plain;', 'nonsense', '', ' / ', 'a/b/c', 'x'.repeat(100) + '/' + 'y'.repeat(100), 42, null]) {
    assert.equal(fileType(type), 'application/octet-stream', String(type));
    const result = await service.signUpload('a', { kind: 'file', type, size: 10, name: 'page.html' });
    assert.equal(result.fields['Content-Type'], 'application/octet-stream');
    assert.match(result.fields['Content-Disposition'], /^attachment; filename="page\.html"; /);
    assert.deepEqual(decode(result.fields).conditions.filter(Array.isArray)[1], ['eq', '$Content-Type', 'application/octet-stream']);
  }
  for (const type of ['application/pdf', 'text/plain', 'application/json', 'application/zip', 'text/markdown', 'image/heic', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']) {
    assert.equal(fileType(type), type);
  }
  assert.equal(fileType(' Application/PDF '), 'application/pdf');
});
test('file names lose folders, control and format characters and quotes, and are encoded per RFC 5987', () => {
  const chinese = '\u4f1a\u8bae\u8bb0\u5f55.docx';
  const cases = [
    ['../../etc/passwd', 'passwd'], ['C:\\Users\\me\\a.txt', 'a.txt'], ['dir/sub/\u62a5\u544a.pdf', '\u62a5\u544a.pdf'],
    ['say "hi".txt', 'say hi.txt'], ['a\r\nContent-Type: text/html.txt', 'aContent-Type: text/html.txt'.split('/').pop()],
    ['evil\u202etxt.exe', 'eviltxt.exe'], ['tab\there.txt', 'tabhere.txt'], ['zero\u200bwidth.txt', 'zerowidth.txt'],
    ['  spaced   out .md ', 'spaced out .md'], ['line\u2028sep.txt', 'linesep.txt'], ['..', 'file'], ['', 'file'], [chinese, chinese],
  ];
  for (const [raw, expected] of cases) assert.equal(fileName(raw), expected, JSON.stringify(raw));
  const long = fileName('n'.repeat(500) + '.tar.gz');
  assert.equal([...long].length, 200);
  assert.ok(long.endsWith('.gz'), 'a long name keeps its extension');
  assert.equal([...fileName('\u6587'.repeat(300))].length, 200, 'counted in characters, not bytes');
  // filename* has only attr-chars and %XX; the quoted fallback is printable ASCII without quotes, backslashes, percent or semicolons.
  for (const raw of [chinese, "it's (1)*;%20!.zip", 'emoji \ud83d\ude00.png', 'semi;colon=1.txt', 'a"b\\c.txt']) {
    const value = attachment(fileName(raw));
    const [, fallback, encoded] = /^attachment; filename="([^"]*)"; filename\*=UTF-8''(.*)$/.exec(value);
    assert.match(fallback, /^[\x20-\x7e]*$/);
    assert.doesNotMatch(fallback, /["\\%;]/);
    assert.match(encoded, /^(?:[A-Za-z0-9!#$&+\-.^_`|~]|%[0-9A-F]{2})+$/, value);
    assert.equal(decodeURIComponent(encoded), fileName(raw));
    assert.doesNotMatch(value, /[\r\n\x00-\x1f\x7f]/);
  }
  assert.equal(attachment(chinese), `attachment; filename="____.docx"; filename*=UTF-8''%E4%BC%9A%E8%AE%AE%E8%AE%B0%E5%BD%95.docx`);
});
test('a file policy signature (non-ASCII name in the disposition) equals the one the real OSS SDK computes', async t => {
  const OSS = require('ali-oss');
  const { service } = setup(t, options => new OSS(options));
  service.saveConfig('a', input);
  const result = await service.signUpload('a', { kind: 'file', type: 'application/pdf', size: 4096, name: '\u62a5\u544a (final).pdf' });
  const policy = decode(result.fields);
  const stamp = result.fields['x-oss-date'];
  const date = new Date(Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(9, 11), +stamp.slice(11, 13), +stamp.slice(13, 15)));
  const sdk = new OSS({ region: input.region, bucket: input.bucket, accessKeyId: input.accessKeyId, accessKeySecret: input.accessKeySecret, authorizationV4: true });
  assert.equal(result.fields['x-oss-signature'], sdk.signPostObjectPolicyV4(policy, date));
  assert.equal(new URL(result.url).protocol, 'https:');
});
