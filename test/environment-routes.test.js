const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const { createEnvironmentRouter } = require('../routes/environment');

async function setup(t, { run, ossFor, clientAuth, frp } = {}) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
  if (frp) db.prepare("INSERT INTO system_state (key, value) VALUES ('frp_config', ?)").run(JSON.stringify(frp));
  const contexts = [];
  const service = { run: async context => { contexts.push(context); return run ? run(context) : { features: [], summary: { ok: 0, warn: 0, fail: 0 } }; } };
  const app = express();
  app.use('/api/environment', createEnvironmentRouter({
    service, db, ossFor: ossFor || (() => null), clientAuth: () => clientAuth || null,
    requireAuth(req, res, next) { if (req.get('Authorization') !== 'test-session') return res.status(401).json({ error: 'AUTH_REQUIRED' }); req.session = { user: { login: 'alice' } }; next(); },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/environment`;
  return { base, contexts, call: (path = '/check', headers = {}) => fetch(base + path, { headers: { Authorization: 'test-session', ...headers } }) };
}

test('the report needs a signed-in browser of this page, and is never cached', async t => {
  const { base, call } = await setup(t, { run: async () => ({ features: [{ id: 'x' }], summary: { ok: 1, warn: 0, fail: 0 } }) });
  assert.equal((await fetch(`${base}/check`)).status, 401);
  assert.equal((await call('/check', { Origin: 'https://evil.example' })).status, 403, 'another site cannot read it');
  assert.equal((await call('/check', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const ok = await call();
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await ok.json(), { features: [{ id: 'x' }], summary: { ok: 1, warn: 0, fail: 0 } });
});

test('the checks learn the address of the page, the upload settings, the login state and whether the tunnel is set up', async t => {
  const auth = { accessMode: () => 'remote', status: () => ({ bound: true }) };
  const asked = [];
  const { base, contexts, call } = await setup(t, { ossFor: user => { asked.push(user); return { enabled: true, bucket: 'b', region: 'oss-cn-hangzhou' }; }, clientAuth: auth, frp: { serverAddr: 'frp.example.com' } });
  await call();
  assert.deepEqual(asked, ['alice'], 'the settings of the signed-in user');
  // (the address is the one the page was reached at: protocol and host of the request)
  assert.deepEqual(contexts[0], { origin: new URL(base).origin, oss: { enabled: true, bucket: 'b', region: 'oss-cn-hangzhou' }, clientAuth: auth, frpConfigured: true });
  await call('/check', { Origin: new URL(base).origin });
  assert.equal(contexts[1].origin, new URL(base).origin, 'the same with the Origin header a browser sends');

  const bare = await setup(t);
  await bare.call();
  assert.deepEqual([bare.contexts[0].oss, bare.contexts[0].clientAuth, bare.contexts[0].frpConfigured], [null, null, false], 'nothing is set up: nothing is assumed');
  const empty = await setup(t, { frp: { serverAddr: '' } });
  await empty.call();
  assert.equal(empty.contexts[0].frpConfigured, false, 'a tunnel without a server address is not set up');
});

test('settings that cannot be read do not stop the report, a second request while one runs shares its answer, and a failure is reported plainly', async t => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { call } = await setup(t, { ossFor: () => { throw new Error('unreadable'); }, run: async () => { calls++; await gate; return { features: [], summary: { ok: 0, warn: 0, fail: 0 } }; } });
  const first = call();
  const second = call();
  await new Promise(resolve => setTimeout(resolve, 50));
  release();
  assert.deepEqual([(await first).status, (await second).status], [200, 200]);
  assert.equal(calls, 1, 'one check serves both requests');
  await call();
  assert.equal(calls, 2, 'the next request runs a new check');

  const failing = await setup(t, { run: async () => { throw new Error('boom /secret/path'); } });
  const answer = await failing.call();
  assert.equal(answer.status, 500);
  assert.deepEqual(await answer.json(), { error: 'The environment check failed' }, 'no internals in the error');
});
