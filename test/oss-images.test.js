const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createOssImages, MAX_IMAGE_BYTES } = require('../services/oss-images');
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
