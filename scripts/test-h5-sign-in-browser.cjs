// Browser test of one login for linked engines in Settings → Devices (scripts/h5-shell/SignInHandover.jsx, Engines.jsx; "One login for linked
// engines" in docs/design/failover-and-one-login.md), with the server mocked, at 1440px and 390px:
// - the row of linked K01 has "Sign in on K01 too"; a click opens a tab inside the click, tries K01's address without credentials, posts only the
//   nonce hash, and the tab goes to K01's address with the token and the nonce in the fragment; the row says so. A refusal puts its reason on the
//   row and closes the tab. A linked device that does not accept says so instead of the button.
// - "Accept sign-in from linked devices": this device's switch (GET / PUT /api/sign-in-handover/settings), and in K01's tab K01's own switch
//   through /api/device-settings/2/sign-in-handover/settings.
// H5_SHOT_DIR=<dir> saves the 1440px screenshot.
const { chromium } = require('playwright');
const { addShell } = require('./h5-shell-test-script.cjs');
const { openGroup } = require('./settings-test-helper.cjs');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const SHOTS = process.env.H5_SHOT_DIR || '';
const html = fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const K01_ID = '9f2b7a33-0000-4000-8000-0000000000b2';

function mockServer({ k01Id, accepting }) {
  window.calls = [];
  window.opened = [];
  window.issueError = null;
  window.localAccept = true;
  window.k01Accept = true;
  window.open = () => { const tab = { opener: window, closed: false, location: { href: 'about:blank' }, close() { this.closed = true; } }; window.opened.push(tab); return tab; };
  const local = {
    '/api/remote-servers': [{ id: 2, name: 'K01', base_url: 'tunnel://l1', status: 'online', remote_version: '2.145.0', can_rename: true, name_source: 'engine', instance_id: k01Id }],
    '/api/service-links': { supported: true, links: [{ id: 'l1', name: 'K01', state: 'online', role: 'initiator', peer_url: null, remote_server_id: 2 }] },
    '/api/system/version': { app_version: '2.145.0', boot_id: 'b1', engine_name: 'T01', instance_id: '6c1d1c1e-0000-4000-8000-0000000000a1' },
    '/api/system/engine-name': { name: 'T01', default_name: 't01', custom: true },
    '/api/device-settings/devices': { devices: [{ id: 2, name: 'K01', online: true, supported: true, company_computer: true }] },
    '/api/peer-fs/settings': { enabled: false },
    '/api/device-tier': { company_computer: false },
  };
  window.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    const text = String(url);
    const body = options.body ? JSON.parse(options.body) : undefined;
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (/^https?:\/\//.test(text)) { // a probe of another engine's address
      window.calls.push({ method, url: text, mode: options.mode, credentials: options.credentials });
      if (text.startsWith('http://k01.lan:3000/')) return new Response(null, { status: 200 });
      throw new TypeError('Failed to fetch');
    }
    const pathname = text.split('?')[0];
    window.calls.push({ method, url: pathname, body });
    if (pathname === '/api/sign-in-handover/peers') return reply({ instance_id: 'a', name: 'T01', accepting: true, peers: [{ instance_id: k01Id, name: 'K01', online: true, supported: true, accepting, addresses: ['http://k01-dead.example:1', 'http://k01.lan:3000'] }] });
    if (pathname === '/api/sign-in-handover' && method === 'POST') return window.issueError ? reply({ error: window.issueError }, 409) : reply({ token: 'BODY.MAC', name: 'K01', addresses: [], expires_in: 60 }, 201);
    if (pathname === '/api/sign-in-handover/settings') { if (method === 'PUT') window.localAccept = body.accept; return reply({ accept: window.localAccept }); }
    if (pathname === '/api/device-settings/2/sign-in-handover/settings') { if (method === 'PUT') window.k01Accept = body.accept; return reply({ accept: window.k01Accept }); }
    if (local[pathname] && method === 'GET') return reply(local[pathname]);
    return reply({ error: 'NOT_FOUND' }, 404);
  };
}

async function openPage(browser, { width, accepting = true }) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1, ...(width < 600 ? { hasTouch: true, isMobile: true } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://app.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://app.test/');
  await page.addStyleTag({ content: read('public/css/h5.css') });
  await page.evaluate(mockServer, { k01Id: K01_ID, accepting });
  for (const file of ['public/js/local-keys.js', 'public/js/i18n.js', 'public/js/i18n-zh-ui.js']) await page.addScriptTag({ content: read(file) });
  await addShell(page);
  await page.evaluate(() => window.H5UI.set({ settingsOpen: true }));
  await openGroup(page, 'devices');
  await page.locator('.h5-engine-row[data-engine="2"] .h5-engine-sign-in, .h5-engine-row[data-engine="2"] .h5-engine-sign-in-off').first().waitFor();
  return { context, page, errors };
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const width of [1440, 390]) {
      const { context, page, errors } = await openPage(browser, { width });
      const row = page.locator('.h5-engine-row[data-engine="2"]');
      const button = row.locator('.h5-engine-sign-in');
      assert.equal(await button.textContent(), 'Sign in on K01 too');
      // The switch of this device.
      const accept = page.locator('#h5-sign-in-accept');
      await accept.waitFor();
      assert.equal(await accept.isChecked(), true);
      assert.equal(await page.locator('#h5-sign-in .h5-switch-label').textContent(), 'Accept sign-in from linked devices');
      if (width === 1440 && SHOTS) {
        await row.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(SHOTS, 'failover-settings-sign-in-1440.png') });
      }
      await button.click();
      await row.locator('text=Signed in on K01 in a new tab').waitFor();
      const state = await page.evaluate(() => ({ opened: window.opened.map(tab => ({ href: tab.location.href, opener: tab.opener, closed: tab.closed })), calls: window.calls }));
      assert.equal(state.opened.length, 1);
      const target = new URL(state.opened[0].href);
      assert.equal(`${target.origin}${target.pathname}`, 'http://k01.lan:3000/');
      assert.equal(state.opened[0].opener, null);
      const fragment = new URLSearchParams(target.hash.slice(1));
      assert.equal(fragment.get('handover'), 'BODY.MAC');
      const post = state.calls.find(call => call.url === '/api/sign-in-handover' && call.method === 'POST');
      assert.equal(post.body.target, K01_ID);
      assert.match(post.body.nonce_hash, /^[A-Za-z0-9_-]{43}$/);
      assert.ok(!JSON.stringify(post.body).includes(fragment.get('n')), 'the nonce stays in the browser');
      const probes = state.calls.filter(call => /^https?:/.test(call.url));
      assert.deepEqual(probes.map(call => [call.url, call.mode, call.credentials]), [['http://k01-dead.example:1/health', 'no-cors', 'omit'], ['http://k01.lan:3000/health', 'no-cors', 'omit']]);
      // A refusal: the reason on the row, the tab closed.
      await page.evaluate(() => { window.issueError = 'HANDOVER_OFF_THERE'; });
      await button.click();
      await row.locator('text=K01 does not accept sign-in from linked devices').waitFor();
      assert.equal(await page.evaluate(() => window.opened.at(-1).closed), true);
      // The switch saves at once.
      await page.locator('#h5-sec-sign-in .h5-switch-row').click();
      await page.waitForFunction(() => window.localAccept === false);
      assert.equal(await accept.isChecked(), false);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width}: no sideways scroll`);
      assert.deepEqual(errors, []);
      await context.close();
    }
    // A linked device that does not accept: a line instead of the button.
    const { context, page } = await openPage(browser, { width: 1440, accepting: false });
    assert.equal(await page.locator('.h5-engine-row[data-engine="2"] .h5-engine-sign-in').count(), 0);
    assert.equal(await page.locator('.h5-engine-row[data-engine="2"] .h5-engine-sign-in-off').textContent(), 'K01 does not accept sign-in from linked devices');
    await context.close();
    console.log('Sign in on K01 too: the tab opens K01 with the hand-over in the fragment, a refusal says why, and the accept switch saves at once.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
