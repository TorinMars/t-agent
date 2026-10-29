const test = require('node:test');
const assert = require('node:assert/strict');
const { PAGE_ADDRESSES, DEFAULT_LOGIN_PATH, resolveLoginPath, isOpenPath, createLoginGate, createUnknownPageRedirect } = require('../lib/login-gate');

test('login path defaults to /torin/hide/login and rejects unsafe values', () => {
  assert.equal(DEFAULT_LOGIN_PATH, '/torin/hide/login');
  assert.equal(resolveLoginPath(''), DEFAULT_LOGIN_PATH);
  assert.equal(resolveLoginPath('/my/secret-door/'), '/my/secret-door');
  const warnings = [];
  for (const bad of ['no-slash', '/ab', '/api/x-login', '/a//b-login', '/a/../b-login', '/Chinese entrance/login', '/x y/login', '/web/login']) {
    assert.equal(resolveLoginPath(bad, message => warnings.push(message)), DEFAULT_LOGIN_PATH, bad);
  }
  assert.equal(warnings.length, 8);
});

test('only the login entrance, machine APIs and share assets are open before login', () => {
  const login = '/torin/hide/login';
  for (const open of [login, `${login}/`, `${login}/status`, `${login}/setup`, '/health', '/v1/info', '/api/remote/v1/capabilities', '/share/abc', '/share/abc/file', '/js/auth.js', '/js/i18n.js', '/js/i18n-zh-ui.js', '/css/auth.css', '/favicon.svg', '/manifest-h5.json', '/icons/icon-192.png', '/icons/icon-512.png', '/vendor/marked/marked-15.0.12.min.js']) {
    assert.equal(isOpenPath(open, login), true, open);
  }
  for (const closed of ['/', '/web', '/api/tasks', '/auth/login', '/auth/status', '/clients', '/js/app.js', '/manifest.json', '/sw.js', '/torin/hide', '/torin/hide/login-x', '/v1x', '/vendor/monaco/monaco.js', '/vendor/marked/../monaco/x.js']) {
    assert.equal(isOpenPath(closed, login), false, closed);
  }
});

test('gate lets an authenticated session through and answers anything else with a plain 404', () => {
  const gate = createLoginGate({ loginPath: '/torin/hide/login', isAuthenticated: session => session.ok === true });
  function run(pathname, session) {
    const result = { next: false };
    const res = { status(code) { result.status = code; return this; }, set() { return this; }, type() { return this; }, send(body) { result.body = body; } };
    gate({ path: pathname, method: 'GET', session }, res, () => { result.next = true; });
    return result;
  }
  assert.equal(run('/web', { ok: true }).next, true);
  assert.equal(run('/torin/hide/login', { ok: false }).next, true);
  const denied = run('/api/tasks', { ok: false });
  assert.equal(denied.next, false);
  assert.equal(denied.status, 404);
  assert.match(denied.body, /Cannot GET \/api\/tasks/);
  assert.equal(run('/%2e%2e/api/tasks', { ok: false }).status, 404);
});

test('a logged-in browser page visit to an unknown address goes to the home page, everything else is left to the 404', () => {
  const redirect = createUnknownPageRedirect({ loginPath: '/torin/hide/login', isAuthenticated: session => session.ok === true });
  function run(pathname, { ok = true, method = 'GET', accept = 'text/html,application/xhtml+xml' } = {}) {
    const result = { next: false };
    const res = { set() { return this; }, redirect(location) { result.location = location; } };
    redirect({ path: pathname, method, session: { ok }, headers: { accept } }, res, () => { result.next = true; });
    return result;
  }
  assert.equal(run('/nonexistent').location, '/');
  assert.equal(run('/a/b/c').location, '/');
  assert.equal(run('/web/wrong').location, '/');
  assert.equal(run('/nonexistent', { ok: false }).next, true, 'logged-out requests are never redirected, so the login entrance stays hidden');
  for (const pathname of ['/api/nothing', '/auth/nothing', '/v1/nothing', '/share/x', '/terminal/ws', '/js/missing.js', '/css/missing.css', '/icons/x.png', '/torin/hide/login/nothing']) {
    assert.equal(run(pathname).next, true, pathname);
  }
  assert.equal(run('/nonexistent', { method: 'POST' }).next, true);
  assert.equal(run('/nonexistent', { accept: '*/*' }).next, true, 'scripts and tools that do not ask for HTML still get 404');
});

test('logged out, the pages lead to the login entrance and come back after the login; nothing else is opened', () => {
  const gate = createLoginGate({ loginPath: '/torin/hide/login', isAuthenticated: session => session.ok === true });
  function run(pathname, { method = 'GET', ok = false, rawPath = pathname } = {}) {
    const result = { next: false };
    const res = { status(code) { result.status = code; return this; }, set() { return this; }, type() { return this; }, send(body) { result.body = body; }, redirect(location) { result.location = location; } };
    gate({ path: rawPath, method, session: { ok }, headers: {} }, res, () => { result.next = true; });
    return result;
  }
  assert.deepEqual([...PAGE_ADDRESSES].sort(), ['/', '/h5', '/web']);
  assert.equal(run('/h5').location, '/torin/hide/login?return_to=%2Fh5');
  assert.equal(run('/web').location, '/torin/hide/login?return_to=%2Fweb');
  assert.equal(run('/').location, '/torin/hide/login?return_to=%2F');
  assert.equal(run('/web', { method: 'HEAD' }).location, '/torin/hide/login?return_to=%2Fweb');
  for (const other of ['/api/tasks', '/h5/x', '/web/x', '/manifest.json', '/js/app.js', '/css/h5.css', '/index.html', '/h5.html']) assert.equal(run(other).status, 404, `${other} stays closed`);
  assert.equal(run('/h5', { method: 'POST' }).status, 404, 'only page visits are sent on');
  assert.equal(run('/h5', { rawPath: '/h5/' }).status, 404, 'a look-alike address is not one of the pages');
  assert.equal(run('/%68%35', { rawPath: '/%68%35' }).status, 404, 'an encoded look-alike is not either');
  for (const page of ['/h5', '/web', '/']) assert.equal(run(page, { ok: true }).next, true, 'a logged-in session is let through as before');
});
