// routes/browser-sites.js: the page router (/api/browser-sites: list, read, delete, edit) and the tcli relay (/api/tcli/site/*: the terminal hook
// token, this machine only, pass-through for other requests, SITE_HAS_SECRET refusal, unknown route). The service is backed by an in-memory db.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const Database = require('better-sqlite3');
const { createBrowserSites } = require('../services/browser-sites');
const { createBrowserSitesRouter, createSiteRelayRouter } = require('../routes/browser-sites');

const HOOK = { task: '7', terminal: 'term-1', token: 'a'.repeat(64) };
const hookHeaders = (hook = HOOK) => ({ 'X-T-Agent-Task': hook.task, 'X-T-Agent-Terminal': hook.terminal, 'X-T-Agent-Token': hook.token });
const verifyToken = (task, terminal, token) => task === 7 && terminal === HOOK.terminal && token === HOOK.token;

function makeService() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  db.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY, user_id TEXT)');
  db.prepare('INSERT INTO tasks (id, user_id) VALUES (7, ?)').run('owner');
  let clock = 1000;
  return { db, service: createBrowserSites({ db, now: () => (clock += 1), deviceName: () => 'DevA', settingChanged: () => {} }) };
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  test.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function call(base, method, route, { headers = {}, body } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json'; }
  const response = await fetch(new URL(route, base), init);
  const text = await response.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

// ---- Page router ----
test('page router: list, read, 404, edit and delete', async () => {
  const { service } = makeService();
  service.save('github.com', { title: 'GitHub', summary: 'Code', actions: [{ name: 'a', steps: ['x'] }] });
  const app = express();
  app.use('/api/browser-sites', createBrowserSitesRouter({ sites: () => service }));
  const base = await listen(app);

  const list = await call(base, 'GET', '/api/browser-sites');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.sites.map(s => s.site), ['github.com']);

  const one = await call(base, 'GET', '/api/browser-sites/www.github.com');
  assert.equal(one.status, 200);
  assert.equal(one.body.site.title, 'GitHub');

  const missing = await call(base, 'GET', '/api/browser-sites/absent.com');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'SITE_NOT_FOUND');

  const edited = await call(base, 'PATCH', '/api/browser-sites/github.com', { body: { notes: 'hi' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.site.notes, 'hi');

  const bad = await call(base, 'PATCH', '/api/browser-sites/github.com', { body: '{not json', headers: { 'Content-Type': 'application/json' } });
  assert.equal(bad.status, 400);

  const del = await call(base, 'DELETE', '/api/browser-sites/github.com');
  assert.equal(del.status, 200);
  assert.deepEqual(del.body, { removed: true, site: 'github.com' });
  assert.equal((await call(base, 'GET', '/api/browser-sites/github.com')).status, 404);
});

// ---- Relay router ----
// The relay first, then a marker that proves a request was passed on (as server.js mounts it before the gates).
async function relayApp({ isLocal = () => true } = {}) {
  const { db, service } = makeService();
  const app = express();
  app.use('/api/tcli', createSiteRelayRouter({ db, verifyToken, isLocal, sites: () => service }));
  app.use((req, res) => res.status(418).json({ error: 'PASSED_ON' }));
  return { service, base: await listen(app) };
}

test('relay: missing headers are 401, a wrong token 403, a non-terminal request is passed on', async () => {
  const { base } = await relayApp();
  const noHeaders = await call(base, 'GET', '/api/tcli/site/list');
  assert.equal(noHeaders.status, 418, 'no X-T-Agent-* headers: passed on, not handled');

  const missing = await call(base, 'GET', '/api/tcli/site/list', { headers: { 'X-T-Agent-Task': '7' } });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error, 'TCLI_AUTH_REQUIRED');

  const wrong = await call(base, 'GET', '/api/tcli/site/list', { headers: hookHeaders({ task: '7', terminal: 'term-1', token: 'b'.repeat(64) }) });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error, 'TCLI_AUTH_INVALID');
});

test('relay: a request not from this machine is passed on untouched', async () => {
  const { base } = await relayApp({ isLocal: () => false });
  const off = await call(base, 'GET', '/api/tcli/site/list', { headers: hookHeaders() });
  assert.equal(off.status, 418, 'not local: passed on');
});

test('relay: save, show, list, search, edit and rm with the terminal token', async () => {
  const { base } = await relayApp();
  const save = await call(base, 'POST', '/api/tcli/site/save', { headers: hookHeaders(), body: { site: 'github.com', entry: { title: 'GitHub', summary: 'Code host', apis: [{ name: 'repos', url: 'https://api.github.com' }] } } });
  assert.equal(save.status, 200);
  assert.equal(save.body.site.site, 'github.com');

  const list = await call(base, 'GET', '/api/tcli/site/list', { headers: hookHeaders() });
  assert.deepEqual(list.body.sites.map(s => s.site), ['github.com']);

  const show = await call(base, 'GET', '/api/tcli/site/show?site=www.github.com', { headers: hookHeaders() });
  assert.equal(show.body.site.title, 'GitHub');

  const search = await call(base, 'GET', '/api/tcli/site/search?q=host', { headers: hookHeaders() });
  assert.equal(search.body.results[0].site, 'github.com');

  const edit = await call(base, 'POST', '/api/tcli/site/edit', { headers: hookHeaders(), body: { site: 'github.com', changes: { notes: 'be careful' } } });
  assert.equal(edit.body.site.notes, 'be careful');

  const noConfirm = await call(base, 'POST', '/api/tcli/site/rm', { headers: hookHeaders(), body: { site: 'github.com' } });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.body.error, 'CONFIRM_REQUIRED');

  const rm = await call(base, 'POST', '/api/tcli/site/rm', { headers: hookHeaders(), body: { site: 'github.com', confirm: true } });
  assert.deepEqual(rm.body, { removed: true, site: 'github.com' });
});

test('relay: a save that leaks a secret is refused with SITE_HAS_SECRET; an unknown route is 404', async () => {
  const { base } = await relayApp();
  const secret = await call(base, 'POST', '/api/tcli/site/save', { headers: hookHeaders(), body: { site: 'evil.com', entry: { notes: 'NOTAREALKEY0000testfixture1234567890abcd' } } });
  assert.equal(secret.status, 400);
  assert.equal(secret.body.error, 'SITE_HAS_SECRET');

  const show = await call(base, 'GET', '/api/tcli/site/show?site=absent.com', { headers: hookHeaders() });
  assert.equal(show.status, 404);

  const unknown = await call(base, 'GET', '/api/tcli/site/nope', { headers: hookHeaders() });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, 'UNKNOWN_ROUTE');
});
