const test = require('node:test');
const assert = require('node:assert/strict');
const { KNOWN_DEVICE_COOKIE, DEFAULT_LOGIN_PATH, resolveLoginPath, isOpenPath, createLoginGate, createUnknownPageRedirect } = require('../lib/login-gate');

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
  const denied = run('/web', { ok: false });
  assert.equal(denied.next, false);
  assert.equal(denied.status, 404);
  assert.match(denied.body, /Cannot GET \/web/);
  assert.equal(run('/%2e%2e/web', { ok: false }).status, 404);
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

test('a device that has logged in before gets from the phone page address to the login entrance, nobody else does', () => {
  const gate = createLoginGate({ loginPath: '/torin/hide/login', isAuthenticated: session => session.ok === true });
  function run(pathname, { cookie, method = 'GET', ok = false, rawPath = pathname } = {}) {
    const result = { next: false };
    const res = { status(code) { result.status = code; return this; }, set() { return this; }, type() { return this; }, send(body) { result.body = body; }, redirect(location) { result.location = location; } };
    gate({ path: rawPath, method, session: { ok }, headers: cookie ? { cookie } : {} }, res, () => { result.next = true; });
    return result;
  }
  const known = `${KNOWN_DEVICE_COOKIE}=1`;
  assert.equal(run('/h5', { cookie: known }).location, '/torin/hide/login?return_to=%2Fh5');
  assert.equal(run('/h5', { cookie: `a=b; ${known}; c=d` }).location, '/torin/hide/login?return_to=%2Fh5');
  assert.equal(run('/h5').status, 404, 'a device we do not know sees a plain 404');
  assert.equal(run('/h5', { cookie: `x${known}` }).status, 404);
  assert.equal(run('/h5', { cookie: `${KNOWN_DEVICE_COOKIE}=0` }).status, 404);
  for (const other of ['/web', '/', '/api/tasks', '/h5/x', '/manifest.json']) assert.equal(run(other, { cookie: known }).status, 404, `${other} stays closed`);
  assert.equal(run('/h5', { cookie: known, method: 'POST' }).status, 404, 'only page visits are sent on');
  assert.equal(run('/h5', { cookie: known, ok: true }).next, true, 'a logged-in session is let through as before');
});
