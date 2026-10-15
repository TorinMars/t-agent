// The "Choose an access mode" page shown on first open, and the "Access mode" block in settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function startAuthPage(status, post = {}, pathname = '/torin/hide/login/setup') {
  const elements = new Map();
  const listeners = new Map();
  const requests = [];
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', hidden: true, disabled: false, querySelectorAll: () => [], addEventListener: (type, fn) => listeners.set(`${id}:${type}`, fn) });
    return elements.get(id);
  } };
  const location = { search: '', pathname, replaced: null, replace(url) { this.replaced = url; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'auth.js'), 'utf8'), {
    document, URLSearchParams, location, navigator: {},
    async fetch(url, options = {}) {
      requests.push({ url, body: options.body && JSON.parse(options.body) });
      return { ok: true, async json() {
        if (url.endsWith('/status')) return status;
        if (url.endsWith('/mode')) return post;
        return { secret: 'SECRET', qr: 'data:image/png;base64,X', uri: 'otpauth://totp/T-Agent', replacing: false };
      } };
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  return { elements, listeners, requests, location };
}

test('Fresh install: shows both access modes and does not start binding directly', async () => {
  const page = await startAuthPage({ bound: false, authenticated: false, mode: 'unset' });
  assert.deepEqual(page.requests.map(request => request.url), ['/torin/hide/login/status']);
  const html = page.elements.get('auth-content').innerHTML;
  assert.match(html, /Authenticator \+ allow external access/);
  assert.match(html, /Local access only · no verification/);
  assert.match(page.elements.get('auth-title').textContent, /Choose an access mode/);
});

test('Choosing “local access only” submits mode=local and enters the workspace; choosing “external access” starts binding', async () => {
  const local = await startAuthPage({ bound: false, authenticated: false, mode: 'unset' }, { mode: 'local', redirect: '/web' });
  await local.listeners.get('mode-local:click')();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(local.requests.at(-1), { url: '/torin/hide/login/mode', body: { mode: 'local' } });
  assert.equal(local.location.replaced, '/web');

  const remote = await startAuthPage({ bound: false, authenticated: false, mode: 'unset' }, { mode: 'unset', redirect: '/torin/hide/login/setup' });
  await remote.listeners.get('mode-remote:click')();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(remote.requests.map(request => request.url).slice(-2), ['/torin/hide/login/mode', '/torin/hide/login/setup/start']);
  assert.equal(remote.location.replaced, null, 'binding starts on the same page');
});

test('An install that already chose an access mode never sees the chooser page (old installs / already bound)', async () => {
  const page = await startAuthPage({ bound: true, authenticated: false, mode: 'remote' }, {}, '/torin/hide/login');
  assert.match(page.elements.get('auth-title').textContent, /Log in with your authenticator/);
});

test('The access-mode block in settings: current mode, switch button and the loopback-only reminder', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const fn = source.match(/function accessModeSection\(user\) \{[\s\S]*?\n\}\n/)[0];
  const context = { escapeHtml: value => String(value) };
  vm.createContext(context);
  vm.runInContext(`${fn}\nglobalThis.render = accessModeSection;`, context);
  const remote = context.render({ access_mode: 'remote', listen_host: '127.0.0.1' });
  assert.match(remote, /Access mode · Authenticator \+ allow external access/);
  assert.match(remote, /Switch to: local access only \(no verification\)/);
  assert.match(remote, /HOST=0\.0\.0\.0/, 'warns when the service only listens on loopback');
  assert.doesNotMatch(context.render({ access_mode: 'remote', listen_host: '0.0.0.0' }), /HOST=0\.0\.0\.0/);
  const local = context.render({ access_mode: 'local', authenticator_bound: true, listen_host: '0.0.0.0' });
  assert.match(local, /Access mode · Local access only/);
  assert.match(local, /Switch to: authenticator \+ external access/);
  assert.match(local, /settings-mode-code/, 'a previously bound authenticator is verified with a code');
  assert.doesNotMatch(context.render({ access_mode: 'local', authenticator_bound: false, listen_host: '0.0.0.0' }), /settings-mode-code/);
});
