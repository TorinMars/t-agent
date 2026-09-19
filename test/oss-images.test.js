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
    assert.throws(() => service.saveConfig('a', { ...input, publicBaseUrl }), /公共地址/);
  }
  assert.throws(() => service.saveConfig('a', { ...input, region: 'https://evil.example' }), /Region/);
  assert.equal(service.getConfig('a').bucket, input.bucket);
});
test('upload verifies image MIME and size, uses TLS, unique keys and 24 hour signed URLs', async t => {
  let options; const puts = []; const signatures = [];
  const { service } = setup(t, value => { options = value; return {
    put: async (...args) => puts.push(args),
    signatureUrlV4: async (method, expires, opts, key) => { signatures.push([method, expires, opts, key]); return `https://my-images.oss-cn-hangzhou.aliyuncs.com/${key}?signature=abc`; },
  }; });
  service.saveConfig('a', input);
  const before = Date.now();
  const uploaded = await service.upload('a', png, 'image/png');
  await service.upload('a', png, 'image/png');
  assert.equal(options.secure, true);
  assert.equal(options.accessKeySecret, input.accessKeySecret);
  assert.equal(signatures[0][1], 86400);
  assert.match(uploaded.url, /^https:/);
  assert.ok(Date.parse(uploaded.expiresAt) >= before + 86400000 - 1000);
  assert.notEqual(puts[0][0], puts[1][0]);
  assert.match(puts[0][0], /^terminal\/.*\.png$/);
  assert.equal(puts[0][2].headers['Content-Type'], 'image/png');
  for (const [body, mime] of [[png, 'image/jpeg'], [Buffer.from('<svg/>'), 'image/svg+xml'], [Buffer.alloc(0), 'image/png'], [Buffer.alloc(MAX_IMAGE_BYTES + 1), 'image/png']]) {
    await assert.rejects(service.upload('a', body, mime));
  }
  assert.equal(puts.length, 2);
  await assert.rejects(service.upload('other', png, 'image/png'), /未启用/);
});
test('public links have no expiry and SDK failures never reveal credentials', async t => {
  const { service } = setup(t, () => ({ put: async () => {}, signatureUrlV4: () => { throw Error('must not sign'); } }));
  service.saveConfig('a', { ...input, publicBaseUrl: 'https://images.example/assets/' });
  const result = await service.upload('a', png, 'image/png');
  assert.match(result.url, /^https:\/\/images.example\/assets\/terminal\//);
  assert.equal(result.expiresAt, null);
  const failing = createOssImages({ db: setup(t).db, sessionSecret: 'secret', createClient: () => ({ put: async () => { throw Error(input.accessKeySecret); } }) });
  failing.saveConfig('a', input);
  await assert.rejects(failing.upload('a', png, 'image/png'), error => error.message === 'OSS 图片上传失败，请检查配置和 Bucket 权限');
});

test('real OSS SDK creates an HTTPS V4 signature offline', async t => {
  const OSS = require('ali-oss');
  const { service } = setup(t, options => {
    const client = new OSS(options);
    client.put = async () => {};
    return client;
  });
  service.saveConfig('a', input);
  const { url } = await service.upload('a', png, 'image/png');
  const parsed = new URL(url);
  assert.equal(parsed.protocol, 'https:');
  assert.equal(parsed.searchParams.get('x-oss-signature-version'), 'OSS4-HMAC-SHA256');
  assert.equal(parsed.searchParams.get('x-oss-expires'), '86400');
});
