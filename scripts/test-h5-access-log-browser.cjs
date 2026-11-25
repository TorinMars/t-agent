// "Devices and sign-ins" of Settings → Account and access (scripts/h5-shell/AccessLog.jsx; "Devices and sign-ins" in
// docs/design/page-files-and-settings.md) in real Chromium with a stubbed server that follows the /api/access/* contract, on a computer (1440x900,
// a mouse) and a phone (390x844, touch). Checks: every same-origin request carries X-TA-Device (the id of `ta-device-id`) and a cross-origin one
// does not; the terminal socket names the device; the list with "This device", "Signed out", an unconfirmed device with "It was me"; Rename (the
// request body), Sign out (POST revoke, not offered for this device), Forget (DELETE); the tunnel caption; Load more of the events; the alert
// switch PUTs; the local-mode hint with no sign-out; no sideways scroll at 390px and touch targets of at least 44px in touch mode.
// H5_SHOT_DIR=<dir> saves screenshots.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { settled } = require('./browser-test-wait.cjs');

const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const DEVICE = 'abcdef123456';
const NOW = Date.now();
const H = 3600000;

const DEVICES = () => [
  { id: DEVICE, name: 'Chrome on macOS', custom_name: null, first_seen: NOW - 40 * 24 * H, last_seen: NOW - 60000, last_ip: '127.0.0.1', ips_seen_count: 1, confirmed: true, revoked_at: null, current: true, sessions: 1, loopback: true },
  { id: 'phone00000001', name: 'Safari on iPhone', custom_name: null, first_seen: NOW - 2 * 24 * H, last_seen: NOW - 3 * H, last_ip: '127.0.0.1', ips_seen_count: 3, confirmed: false, revoked_at: null, current: false, sessions: 2, loopback: true },
  { id: 'old000000001', name: 'Firefox on Windows', custom_name: 'Office PC', first_seen: NOW - 90 * 24 * H, last_seen: NOW - 20 * 24 * H, last_ip: '203.0.113.9', ips_seen_count: 1, confirmed: true, revoked_at: NOW - 19 * 24 * H, current: false, sessions: 0, loopback: false },
];
const EVENTS = Array.from({ length: 35 }, (_, i) => ({
  id: 100 - i, at: NOW - i * H, device_id: i % 2 ? 'phone00000001' : DEVICE, device_name: i === 3 ? null : (i % 2 ? 'Safari on iPhone' : 'Chrome on macOS'), ip: '127.0.0.1',
  kind: ['login_ok', 'login_failed', 'new_device', 'new_ip', 'revoked', 'blocked'][i % 6], detail: i === 0 ? 'Code accepted' : '',
}));

async function openPage(browser, viewport, { touch, server }) {
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' } : {}), ...(SHOTS ? { deviceScaleFactor: touch ? 3 : 1 } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(id => {
    try { localStorage.setItem('ta-device-id', id); } catch { /* blocked storage */ }
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { window.sockets.push(url); this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send() {} close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
  }, DEVICE);
  await page.route('http://other.test/**', route => { server.foreign.push(route.request().headers()); return route.fulfill({ status: 200, contentType: 'application/json', body: '{}', headers: { 'Access-Control-Allow-Origin': '*' } }); });
  await page.route(`${ORIGIN}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const p = url.pathname;
    const method = request.method();
    const body = request.postData() || '';
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
    if (p.startsWith('/api/') || p.startsWith('/auth/')) server.headers.push({ path: p, device: request.headers()['x-ta-device'] || null });
    if (p.startsWith('/api/access')) {
      server.requests.push({ method, path: p + url.search, body });
      if (p === '/api/access/devices' && method === 'GET') {
        return json({ mode: server.mode, can_sign_out: server.mode === 'remote', current_device: DEVICE, alerts: { enabled: server.alerts }, ip_note: server.mode === 'remote' ? 'tunnel_no_forward' : null, devices: server.devices });
      }
      if (p === '/api/access/events') {
        const before = Number(url.searchParams.get('before')) || Infinity;
        const limit = Number(url.searchParams.get('limit')) || 30;
        const list = EVENTS.filter(event => event.id < before);
        return json({ events: list.slice(0, limit), more: list.length > limit });
      }
      if (p === '/api/access/settings' && method === 'GET') return json({ access_alerts: server.alerts });
      if (p === '/api/access/settings' && method === 'PUT') { server.alerts = JSON.parse(body).access_alerts; return json({ access_alerts: server.alerts }); }
      const one = p.match(/^\/api\/access\/devices\/([a-z0-9]+)(?:\/(rename|confirm|revoke))?$/);
      const device = one && server.devices.find(item => item.id === one[1]);
      if (one && !device) return json({ error: 'ACCESS_DEVICE_NOT_FOUND', message: 'This device is not in the access log.' }, 404);
      if (one && one[2] === 'rename') { const { name } = JSON.parse(body); device.custom_name = name || null; device.name = name || device.name; return json({ device }); }
      if (one && one[2] === 'confirm') { device.confirmed = true; return json({ device }); }
      if (one && one[2] === 'revoke') { device.revoked_at = Date.now(); return json({ ok: true, device, sessions_ended: 2 }); }
      if (one && method === 'DELETE') { server.devices = server.devices.filter(item => item !== device); return json({ ok: true }); }
    }
    if (p === '/auth/me') return json({ access_mode: server.mode, authenticator_bound: true, listen_host: '0.0.0.0' });
    if (p === '/api/system/version') return json({ instance_id: 'inst-home', engine_name: 'Home', app_version: '2.166.1' });
    if (p === '/api/remote-servers') return json([]);
    if (p === '/api/tasks' && method === 'GET') return json([{ id: 1, title: 'Plan', status: 'doing' }]);
    if (p === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (p === '/api/tasks/terminal-activity') return json({});
    if (/terminal-subagents$/.test(p)) return json({});
    if (/\/terminal\/ack$/.test(p)) return json({ success: true });
    if (p === '/api/tasks/1/terminals') return json([{ terminal_id: 'default', title: 'Terminal 1' }]);
    if (/\/agent\/conversations$/.test(p)) return json([]);
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  await page.waitForFunction(() => window.H5UI && (window.H5UI.get().taskList.tasks || []).length === 1, null, { timeout: 15000 });
  return { context, page, errors };
}

const wait = async (check, label, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error(`timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 50)); }
};
const press = (page, touch, locator) => (touch ? locator.tap() : locator.click());
const row = (page, id) => page.locator(`.h5-access-device[data-device="${id}"]`);

async function openAccount(page) {
  if (await page.evaluate(() => window.H5UI.get().settingsOpen)) {
    await page.evaluate(() => window.H5UI.actions.closeSettings());
    await page.waitForFunction(() => !document.querySelector('#h5-set-account') || !document.querySelector('#h5-set-account').checkVisibility());
  }
  await page.evaluate(() => window.H5UI.actions.openSettings('access-devices'));
  await page.locator('#h5-set-account').waitFor({ state: 'visible' });
  await page.locator('#h5-access-devices .h5-access-device').first().waitFor({ state: 'visible' });
  await settled(page);
}
async function menuItems(page, touch, id) {
  await press(page, touch, row(page, id).locator('.h5-access-more'));
  await page.locator(`#h5-access-menu-${id} [role="menuitem"]`).first().waitFor({ state: 'visible' });
  const names = await page.locator(`#h5-access-menu-${id} [role="menuitem"]`).evaluateAll(nodes => nodes.map(node => [...node.classList].find(name => name.startsWith('h5-access-'))));
  return names;
}
async function closeMenu(page, id) {
  await page.keyboard.press('Escape');
  await page.locator(`#h5-access-menu-${id} [role="menuitem"]`).first().waitFor({ state: 'detached' }).catch(() => {});
}
async function choose(page, touch, id, action) {
  await menuItems(page, touch, id);
  await settled(page);
  await press(page, touch, page.locator(`#h5-access-menu-${id} .${action}`));
  await page.locator(`#h5-access-menu-${id} .${action}`).waitFor({ state: 'detached' }).catch(() => {});
}

async function checkRemote(page, server, { touch }) {
  // The device id goes with every same-origin request, and the terminal socket names it; never to another origin.
  await wait(() => server.headers.some(entry => entry.path === '/api/tasks'), 'a task request');
  // An EventSource (/api/attention/stream) cannot send a header: it is not a fetch, and the server takes its device from the session.
  const missing = server.headers.filter(entry => entry.device !== DEVICE && !entry.path.endsWith('/stream'));
  assert.deepEqual(missing, [], 'every same-origin fetch carries X-TA-Device');
  await page.evaluate(() => fetch('http://other.test/ping').catch(() => null));
  await wait(() => server.foreign.length === 1, 'the cross-origin request');
  assert.equal(server.foreign[0]['x-ta-device'], undefined, 'no device id to another origin');
  await page.evaluate(id => fetch('/api/tasks', { headers: { 'X-TA-Device': id } }), 'explicit00001');
  await wait(() => server.headers.some(entry => entry.device === 'explicit00001'), 'an explicit device id is kept');
  await page.evaluate(() => fetch(new Request('/api/tasks/terminal-activity')));
  await wait(() => server.headers.filter(entry => entry.path === '/api/tasks/terminal-activity').every(entry => entry.device === 'abcdef123456'), 'a Request object gets the header');

  await openAccount(page);
  const names = await page.locator('#h5-access-devices .h5-access-name').allTextContents();
  assert.deepEqual(names, ['Chrome on macOS', 'Safari on iPhone', 'Firefox on Windows']);
  assert.equal(await row(page, DEVICE).locator('.h5-access-current').textContent(), 'This device');
  assert.equal(await row(page, 'old000000001').locator('.h5-access-revoked').textContent(), 'Signed out');
  const line = await row(page, 'phone00000001').locator('.h5-access-line').textContent();
  assert.ok(/^First seen .+ · Last seen 3 h ago · 127\.0\.0\.1 \(tunnel\) · 3 addresses$/.test(line), line);
  assert.ok(/· 127\.0\.0\.1$/.test(await row(page, DEVICE).locator('.h5-access-line').textContent()), 'this device keeps its plain address');
  assert.equal(await row(page, 'phone00000001').locator('.h5-access-unconfirmed').innerText().then(text => text.replace(/\s+/g, ' ').trim()), 'Not confirmed yet It was me');
  assert.equal(await row(page, DEVICE).locator('.h5-access-unconfirmed').count(), 0);
  assert.match(await page.locator('#h5-access-ip-note').textContent(), /^All visits come from the tunnel/);
  assert.equal(await page.locator('#h5-access-local-hint').count(), 0);

  // The menus: this device can only be renamed; a signed-out device cannot be signed out again.
  assert.deepEqual(await menuItems(page, touch, DEVICE), ['h5-access-rename']);
  await closeMenu(page, DEVICE);
  assert.deepEqual(await menuItems(page, touch, 'phone00000001'), ['h5-access-rename', 'h5-access-revoke', 'h5-access-forget']);
  await closeMenu(page, 'phone00000001');
  assert.deepEqual(await menuItems(page, touch, 'old000000001'), ['h5-access-rename', 'h5-access-forget']);
  await closeMenu(page, 'old000000001');

  // "It was me".
  await press(page, touch, row(page, 'phone00000001').locator('.h5-access-confirm'));
  await wait(() => server.requests.some(r => r.method === 'POST' && r.path === '/api/access/devices/phone00000001/confirm'), 'confirm');
  await row(page, 'phone00000001').locator('.h5-access-unconfirmed').waitFor({ state: 'detached' });

  // Rename: Enter submits; the body is the name.
  await choose(page, touch, 'phone00000001', 'h5-access-rename');
  await page.locator('#h5-access-rename-name').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#h5-access-rename-name').inputValue(), 'Safari on iPhone');
  assert.deepEqual(await page.locator('#h5-access-rename .MuiDialogActions-root button').allTextContents(), ['Cancel', 'Save']);
  await page.locator('#h5-access-rename-name').fill('My phone');
  await page.locator('#h5-access-rename-name').press('Enter');
  await wait(() => server.requests.some(r => r.path === '/api/access/devices/phone00000001/rename'), 'rename');
  assert.deepEqual(JSON.parse(server.requests.find(r => r.path === '/api/access/devices/phone00000001/rename').body), { name: 'My phone' });
  await page.locator('#h5-access-rename').waitFor({ state: 'detached' });
  await row(page, 'phone00000001').locator('.h5-access-name', { hasText: 'My phone' }).waitFor();

  // Sign out: a destructive confirmation, then POST revoke.
  await choose(page, touch, 'phone00000001', 'h5-access-revoke');
  await page.locator('#h5-access-revoke-dialog-text').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#h5-access-revoke-dialog-text').textContent(), 'My phone must log in again with a code. Its open terminals close.');
  assert.equal(await page.locator('#h5-access-revoke-dialog-title').textContent(), 'Sign out My phone?');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `access-revoke-${touch ? 'phone' : 'computer'}.png`) });
  await press(page, touch, page.locator('#h5-access-revoke-dialog-confirm'));
  await wait(() => server.requests.some(r => r.method === 'POST' && r.path === '/api/access/devices/phone00000001/revoke'), 'revoke');
  await row(page, 'phone00000001').locator('.h5-access-revoked').waitFor();

  // Forget: DELETE, and the row goes.
  await choose(page, touch, 'old000000001', 'h5-access-forget');
  await page.locator('#h5-access-forget-dialog-text').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#h5-access-forget-dialog-text').textContent(), 'Its events are deleted too. If it visits again it shows up as a new device.');
  await press(page, touch, page.locator('#h5-access-forget-dialog-confirm'));
  await wait(() => server.requests.some(r => r.method === 'DELETE' && r.path === '/api/access/devices/old000000001'), 'forget');
  await row(page, 'old000000001').waitFor({ state: 'detached' });

  // Events: 30, then Load more asks before the last id.
  assert.equal(await page.locator('#h5-access-events .h5-access-event').count(), 30);
  assert.equal(await page.locator('.h5-access-event[data-event="100"] .h5-access-event-what').textContent(), 'Signed in · Code accepted');
  assert.match(await page.locator('.h5-access-event[data-event="97"] .h5-access-event-meta').textContent(), /· Unknown device · 127\.0\.0\.1$/);
  assert.equal(await page.locator('.h5-access-event[data-event="95"] .h5-access-event-what').textContent(), 'Refused: signed out device');
  await press(page, touch, page.locator('#h5-access-events-more'));
  await wait(() => server.requests.some(r => r.path === '/api/access/events?before=71&limit=30'), 'load more');
  await page.locator('#h5-access-events .h5-access-event').nth(34).waitFor();
  await page.locator('#h5-access-events-more').waitFor({ state: 'detached' });

  // The alert switch: PUT on change.
  await page.waitForFunction(() => !document.querySelector('#h5-access-alerts').disabled);
  assert.equal(await page.locator('#h5-access-alerts').isChecked(), true);
  await press(page, touch, page.locator('#h5-access-alerts'));
  await wait(() => server.requests.some(r => r.method === 'PUT' && r.path === '/api/access/settings'), 'the switch');
  assert.deepEqual(JSON.parse(server.requests.find(r => r.method === 'PUT').body), { access_alerts: false });
  assert.equal(server.alerts, false);
  await page.waitForFunction(() => !document.querySelector('#h5-access-alerts').checked);

  // Layout: no sideways scroll; touch targets.
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(width <= (touch ? 390 : 1440), `no sideways scroll: ${width}`);
  if (touch) {
    assert.equal(await page.evaluate(() => document.documentElement.dataset.input), 'touch');
    const small = await page.evaluate(() => [...document.querySelectorAll('#h5-sec-access-devices button, #h5-sec-access-alerts .h5-switch-row')]
      .filter(el => el.getClientRects().length).map(el => { const box = el.getBoundingClientRect(); return { cls: el.className, w: box.width, h: box.height }; })
      .filter(box => box.h < 43.5 || box.w < 43.5));
    assert.deepEqual(small, [], 'touch targets of at least 44px');
  }
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `access-${touch ? 'phone' : 'computer'}.png`), fullPage: true });
}

async function checkLocal(page, server, { touch }) {
  server.mode = 'local';
  await openAccount(page);
  await page.locator('#h5-access-local-hint').waitFor();
  assert.equal(await page.locator('#h5-access-local-hint').textContent(), 'Local access only: there is no login, so devices are only logged and nothing can be signed out.');
  assert.equal(await page.locator('#h5-access-ip-note').count(), 0);
  const id = server.devices.find(item => !item.current).id;
  assert.deepEqual(await menuItems(page, touch, id), ['h5-access-rename', 'h5-access-forget'], 'nothing to sign out in local mode');
  await closeMenu(page, id);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const [name, viewport, touch] of [['computer', { width: 1440, height: 900 }, false], ['phone', { width: 390, height: 844 }, true]]) {
      const server = { mode: 'remote', alerts: true, devices: DEVICES(), requests: [], headers: [], foreign: [] };
      const { context, page, errors } = await openPage(browser, viewport, { touch, server });
      // The terminal socket names the device.
      if (touch && !(await page.locator('#h5-tasks').isVisible())) await page.evaluate(() => window.H5UI.actions.openTasks());
      await press(page, touch, page.locator('.h5-task-item').first());
      const terminal = page.locator('.h5-terminal-row[data-session="default"] .h5-terminal-main');
      await terminal.waitFor({ state: 'visible' });
      await press(page, touch, terminal);
      await page.waitForFunction(() => window.sockets.some(url => url.includes('terminalId=')), null, { timeout: 10000 });
      const sockets = await page.evaluate(() => window.sockets.filter(url => url.includes('terminalId=')));
      assert.ok(sockets.every(url => url.includes(`&device=${DEVICE}`)), sockets.join('\n'));
      await checkRemote(page, server, { touch });
      await checkLocal(page, server, { touch });
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`${name}: the device header, the device list, It was me, Rename, Sign out, Forget, the events, the switch and the local mode passed`);
    }
    console.log('Devices and sign-ins: X-TA-Device on same-origin requests and the socket, the list, the actions, the events with Load more, the alert switch, the local-mode hint, the phone layout and touch targets passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
