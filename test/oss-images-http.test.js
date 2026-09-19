const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const { createOssImages } = require('../services/oss-images');
const { createOssRouter } = require('../routes/oss');

test('OSS HTTP endpoints enforce origin/auth before upload parsing and return safe errors', async t => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
  const service = createOssImages({ db, sessionSecret: 'test', createClient: () => ({ put: async () => {} }) });
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
  for (const [method, path] of [['GET', '/config'], ['PUT', '/config'], ['DELETE', '/config'], ['POST', '/images']]) {
    assert.equal((await fetch(base + path, { method, headers: { 'X-Requested-With': 'XMLHttpRequest' } })).status, 401);
    assert.equal((await fetch(base + path, { method, headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  }
  const saved = await fetch(base + '/config', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, region: 'oss-cn-hangzhou', bucket: 'images-test', accessKeyId: 'key', accessKeySecret: 'secret', publicBaseUrl: 'https://images.example' }) });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).accessKeySecret, undefined);
  const get = await fetch(base + '/config', { headers });
  assert.equal(get.headers.get('cache-control'), 'no-store');
  assert.equal((await get.json()).enabled, true);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const uploaded = await fetch(base + '/images', { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: png });
  assert.equal(uploaded.status, 200);
  assert.match((await uploaded.json()).url, /^https:\/\/images.example\//);
  const large = await fetch(base + '/images', { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: Buffer.alloc(10 * 1024 * 1024 + 1) });
  assert.equal(large.status, 413);
  assert.equal(typeof (await large.json()).error, 'string');
  const svg = await fetch(base + '/images', { method: 'POST', headers: { ...headers, 'Content-Type': 'image/svg+xml' }, body: '<svg/>' });
  assert.equal(svg.status, 415);
  const deleted = await fetch(base + '/config', { method: 'DELETE', headers });
  assert.equal((await deleted.json()).enabled, false);
});
