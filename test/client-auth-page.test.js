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

test('unbound local page directly shows a QR code without an initialization password', async () => {
  const app = await start({ bound: false, authenticated: false, local_setup_allowed: true });
  assert.deepEqual(app.requests.map(request => request.url), ['/auth/status', '/auth/setup/start']);
  assert.equal(app.requests[1].options.body, '{}');
  assert.match(app.elements.get('auth-content').innerHTML, /binding-qr/);
  assert.doesNotMatch(app.elements.get('auth-content').innerHTML, /initialization/);
  assert.equal(app.elements.get('binding-qr').src, 'data:image/png;base64,TEST');
});

test('unbound remote page only asks for local binding and never requests a secret', async () => {
  const app = await start({ bound: false, authenticated: false, local_setup_allowed: false });
  assert.deepEqual(app.requests.map(request => request.url), ['/auth/status']);
  assert.match(app.elements.get('auth-description').textContent, /本机客户端/);
  assert.equal(app.elements.get('auth-content').innerHTML, '');
});

test('bound remote pages still require the authenticator login', async () => {
  const app = await start({ bound: true, authenticated: false, local_setup_allowed: false });
  assert.deepEqual(app.requests.map(request => request.url), ['/auth/status']);
  assert.match(app.elements.get('auth-content').innerHTML, /login-form/);
});
