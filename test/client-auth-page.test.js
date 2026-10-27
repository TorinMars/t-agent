const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function start(status) {
  const elements = new Map();
  const requests = [];
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', hidden: true, addEventListener() {} });
    return elements.get(id);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'auth.js'), 'utf8'), {
    document, URLSearchParams, location: { search: '', pathname: '/auth/setup' }, navigator: { userAgent: 'iPhone Mobile' },
    async fetch(url, options) {
      requests.push({ url, options });
      return { ok: true, async json() {
        return url === '/auth/status' ? status : { secret: 'TESTSECRET', qr: 'data:image/png;base64,TEST', uri: 'otpauth://totp/T-Agent', replacing: false };
      } };
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  return { elements, requests };
}

test('unbound page directly shows a QR code without an initialization password', async () => {
  const app = await start({ bound: false, authenticated: false });
  assert.deepEqual(app.requests.map(request => request.url), ['/auth/status', '/auth/setup/start']);
  assert.equal(app.requests[1].options.body, '{}');
  assert.match(app.elements.get('auth-content').innerHTML, /binding-qr/);
  assert.doesNotMatch(app.elements.get('auth-content').innerHTML, /initialization/);
  assert.equal(app.elements.get('binding-qr').src, 'data:image/png;base64,TEST');
});

test('bound remote pages still require the authenticator login', async () => {
  const app = await start({ bound: true, authenticated: false });
  assert.deepEqual(app.requests.map(request => request.url), ['/auth/status']);
  assert.match(app.elements.get('auth-content').innerHTML, /login-form/);
});

// Logs in on a page opened with the given address, device and screen, and returns the return_to the page sent and where it went afterwards.
async function logIn({ search = '', userAgent, maxTouchPoints = 0, screen }) {
  const elements = new Map();
  const handlers = new Map();
  const requests = [];
  let went = null;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', hidden: true, value: '', querySelectorAll: () => [], setAttribute() {}, addEventListener: (type, handler) => handlers.set(`${id}:${type}`, handler) });
    return elements.get(id);
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'auth.js'), 'utf8'), {
    document: { getElementById: element },
    URLSearchParams, location: { search, pathname: '/torin/hide/login', replace: url => { went = url; } }, navigator: { userAgent, maxTouchPoints }, screen,
    async fetch(url, options) {
      requests.push({ url, body: options && options.body ? JSON.parse(options.body) : null });
      return { ok: true, async json() { return url.endsWith('/status') ? { bound: true, authenticated: false } : { success: true, redirect: JSON.parse(options.body).return_to }; } };
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  element('login-code').value = '123456';
  await handlers.get('login-form:submit')({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  return { sent: requests.find(request => request.url.endsWith('/login')).body.return_to, went };
}

test('after the login the phone goes to the phone page, also from the bare login address and when the browser asks for the desktop site', async () => {
  const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', maxTouchPoints: 5, screen: { width: 390, height: 844 } };
  assert.deepEqual(await logIn(iphone), { sent: '/h5', went: '/h5' });
  assert.equal((await logIn({ ...iphone, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15' })).went, '/h5', 'the desktop site on a phone');
  assert.equal((await logIn({ ...iphone, search: '?return_to=/h5' })).went, '/h5');
  assert.equal((await logIn({ ...iphone, search: '?return_to=/web' })).went, '/web', 'an address that asks for the desktop page keeps it');
});

test('after the login a computer goes to the address that picks its page', async () => {
  const mac = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', maxTouchPoints: 0, screen: { width: 1728, height: 1117 } };
  assert.equal((await logIn(mac)).went, '/');
  assert.equal((await logIn({ ...mac, search: '?return_to=/web' })).went, '/web');
});
