// The flags of the T-Attention first-run guide (services/attention-guide.js) and GET / PUT /api/attention/settings/guide (routes/attention.js):
// stored per owner in system_state, validated, the browser session only (a tatt_ token gets 403).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const { createAttentionService } = require('../services/attention');
const { createAttentionRoutes } = require('../routes/attention');

function setup() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  const attention = createAttentionService({ db, now: () => new Date('2026-11-08T10:00:00Z') });
  return { db, attention };
}

test('guide flags: defaults, partial saves, per owner, validated', () => {
  const { db, attention } = setup();
  assert.deepEqual(attention.getGuide('local'), { dismissed: false, pageOnly: false, paired: false, tested: false, updatedAt: null });
  const saved = attention.saveGuide('local', { pageOnly: true });
  assert.deepEqual(saved, { dismissed: false, pageOnly: true, paired: false, tested: false, updatedAt: '2026-11-08T10:00:00.000Z' });
  attention.saveGuide('local', { tested: true, dismissed: true });
  assert.deepEqual(attention.getGuide('local'), { dismissed: true, pageOnly: true, paired: false, tested: true, updatedAt: '2026-11-08T10:00:00.000Z' });
  assert.equal(attention.saveGuide('local', { dismissed: false }).dismissed, false, 'the guide can be brought back');
  assert.equal(attention.getGuide('ann').pageOnly, false, 'another owner has its own flags');
  assert.ok(db.prepare("SELECT value FROM system_state WHERE key = 'attention-guide:local'").get());
  for (const [body, message] of [[null, /JSON object/], [[], /JSON object/], [{ dismissed: 'yes' }, /dismissed must be true or false/], [{ hacked: true }, /Unknown guide setting: hacked/]]) {
    assert.throws(() => attention.saveGuide('local', body), error => error.code === 'VALIDATION_FAILED' && error.statusCode === 400 && message.test(error.message));
  }
  db.prepare("UPDATE system_state SET value = 'not json' WHERE key = 'attention-guide:local'").run();
  assert.equal(attention.getGuide('local').tested, false, 'a broken row reads as the defaults');
});

test('HTTP: GET / PUT /settings/guide for the browser session; a token gets 403', async t => {
  const { attention } = setup();
  const routes = createAttentionRoutes({ service: attention });
  const app = express();
  app.use('/api/attention', routes.bearer);
  app.use(express.json());
  app.use('/api/attention', (req, res, next) => { req.session = { user: { login: 'local' } }; next(); }, routes.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { routes.closeStreams(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/attention`;
  const json = { 'Content-Type': 'application/json' };

  const got = await fetch(`${base}/settings/guide`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('cache-control'), 'no-store');
  assert.equal((await got.json()).dismissed, false);
  const put = await fetch(`${base}/settings/guide`, { method: 'PUT', headers: json, body: JSON.stringify({ dismissed: true, tested: true }) });
  assert.equal(put.status, 200);
  const body = await put.json();
  assert.equal(body.dismissed, true);
  assert.equal(body.tested, true);
  const bad = await fetch(`${base}/settings/guide`, { method: 'PUT', headers: json, body: JSON.stringify({ tested: 1 }) });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'VALIDATION_FAILED', message: 'tested must be true or false' });

  const { token } = attention.createToken({ name: 'cli' });
  for (const [method, route] of [['GET', '/settings/guide'], ['PUT', '/settings/guide'], ['GET', '/SETTINGS/Guide']]) {
    const response = await fetch(`${base}${route}`, { method, headers: { ...json, Authorization: `Bearer ${token}` }, ...(method === 'PUT' ? { body: JSON.stringify({ dismissed: false }) } : {}) });
    assert.equal(response.status, 403, `${method} ${route}`);
    assert.equal((await response.json()).error, 'TOKEN_NOT_ALLOWED');
  }
  assert.equal(attention.getGuide('local').dismissed, true, 'a token could not change the flags');
});

test('HTTP: a service without the guide answers 404', async t => {
  const routes = createAttentionRoutes({ service: { onChange: () => () => {} } });
  const app = express();
  app.use(express.json());
  app.use('/api/attention', (req, res, next) => { req.session = { user: { login: 'local' } }; next(); }, routes.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { routes.closeStreams(); server.close(); });
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/attention/settings/guide`)).status, 404);
});
