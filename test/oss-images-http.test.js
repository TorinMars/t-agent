const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const { createOssImages } = require('../services/oss-images');
const { createOssRouter } = require('../routes/oss');

test('OSS HTTP endpoints enforce origin/auth before signing an upload and return safe errors', async t => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
  const service = createOssImages({ db, sessionSecret: 'test', createClient: () => ({ signatureUrlV4: async () => 'https://images-test.oss-cn-hangzhou.aliyuncs.com/x?y=1' }) });
  const app = express();
  app.use(express.json());
  app.use('/api/oss', createOssRouter({ service, requireAuth(req, res, next) {
    if (req.get('Authorization') !== 'test-session') return res.status(401).json({ error: 'AUTH_REQUIRED' });
    req.session = { user: { login: 'a' } }; next();
  } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/oss`;
  const headers = { Authorization: 'test-session', 'X-Requested-With': 'XMLHttpRequest' };
  for (const [method, path] of [['GET', '/config'], ['PUT', '/config'], ['DELETE', '/config'], ['POST', '/upload-policy']]) {
    assert.equal((await fetch(base + path, { method, headers: { 'X-Requested-With': 'XMLHttpRequest' } })).status, 401);
    assert.equal((await fetch(base + path, { method, headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  }
  const saved = await fetch(base + '/config', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, region: 'oss-cn-hangzhou', bucket: 'images-test', accessKeyId: 'key', accessKeySecret: 'secret', publicBaseUrl: 'https://images.example' }) });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).accessKeySecret, undefined);
  const get = await fetch(base + '/config', { headers });
  assert.equal(get.headers.get('cache-control'), 'no-store');
  assert.equal((await get.json()).enabled, true);
  const sign = body => fetch(base + '/upload-policy', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const signed = await sign({ type: 'image/png', size: 70 });
  assert.equal(signed.status, 200);
  assert.equal(signed.headers.get('cache-control'), 'no-store');
  const policy = await signed.json();
  assert.match(policy.url, /^https:\/\/images.example\//);
  assert.match(policy.host, /^https:\/\/images-test\.oss-cn-hangzhou\.aliyuncs\.com$/);
  assert.equal(JSON.stringify(policy).includes('secret'), false);
  assert.equal((await sign({ type: 'image/png', size: 10 * 1024 * 1024 + 1 })).status, 413);
  assert.equal((await sign({ type: 'image/svg+xml', size: 5 })).status, 415);
  assert.equal((await fetch(base + '/upload-policy', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{not json' })).status, 400);
  assert.equal((await fetch(base + '/images', { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: Buffer.alloc(8) })).status, 404, 'the server no longer receives image bytes');
  const deleted = await fetch(base + '/config', { method: 'DELETE', headers });
  assert.equal((await deleted.json()).enabled, false);
});
