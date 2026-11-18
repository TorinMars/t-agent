// "Mac app" in Settings \u2192 Devices (scripts/h5-shell/MacApp.jsx) in real Chromium at 390px, with GET /api/system/app-info mocked: the installed
// app's version against the server ("Up to date" / "Older than the server: rebuild it"), not installed, the build command with the install folder
// and a Copy button, the web addresses with their labels and Copy buttons, nothing on a server that is not macOS (`app: null`) or on an older
// server (404), and no horizontal overflow on a phone. H5_SHOT_DIR=<dir> saves a screenshot.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const pageErrors = [];

const ADDRESSES = [
  { kind: 'local', label: 'This computer', url: 'http://127.0.0.1:3000' },
  { kind: 'lan', label: 'Local network (en0)', url: 'http://192.168.1.20:3000' },
  { kind: 'remote', label: 'Remote (frp)', url: 'http://203.0.113.7:23456' },
];
const INSTALLED_OLD = { installed: true, path: '/Users/me/Applications/T-Agent.app', version: '2.100.0', matches_server: false };
function world(over = {}) {
  return { appInfo: { addresses: ADDRESSES, app: INSTALLED_OLD, server: { version: '2.101.0', install_dir: '/Users/me/t-agent' } }, reads: 0, ...over };
}
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function serve(w, route) {
  const request = route.request();
  const { pathname } = new URL(request.url());
  if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
  if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
  if (pathname === '/api/system/app-info') {
    w.reads += 1;
    return w.appInfo === 404 ? json(route, { error: 'Not found' }, 404) : json(route, w.appInfo);
  }
  if (pathname === '/api/system/version') return json(route, { app_version: '2.101.0', boot_id: 'boot-a', engine_name: 'MacBook', restart: { supported: true, reason: null } });
  if (pathname === '/api/system/update-status' || pathname === '/api/system/check-update') return json(route, { status: 'current', local_version: '2.101.0', remote_version: '2.101.0', boot_id: 'boot-a', install_type: 'git', is_update_admin: true, log: [] });
  if (pathname === '/api/system/engine-name') return json(route, { name: 'MacBook', default_name: 'mbp', custom: true });
  if (pathname === '/api/remote-servers') return json(route, []);
  if (pathname === '/api/service-links') return json(route, { supported: true, links: [] });
  if (pathname === '/api/task-list/hidden-devices') return json(route, { hidden: [] });
  if (pathname === '/auth/me') return json(route, { effective_work_dir: '/home/me/tasks' });
  if (pathname === '/api/tasks') return json(route, [{ id: 1, title: 'Alpha', status: 'doing' }]);
  if (pathname === '/api/task-groups') return json(route, [{ key: 'doing', name: 'Doing', sort_order: 1 }]);
  if (pathname === '/api/tasks/terminal-activity' || pathname === '/api/tasks/terminal-subagents') return json(route, {});
  if (/^\/api\/tasks\/\d+\/terminals$/.test(pathname)) return json(route, [{ terminal_id: 'default', title: 'Terminal 1' }]);
  if (/\/agent\/conversations$/.test(pathname)) return json(route, []);
  if (pathname === '/api/agent-chat/summary') return json(route, { running: 0, queued: 0, submitted: 0 });
  if (/\/terminal\/(ack|control)$/.test(pathname)) return json(route, { success: true });
  return json(route, { error: 'not mocked' }, 404);
}

async function open(browser, w, { lang = 'en' } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(language => {
    window.WebSocket = class {
      constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send() {}
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    // The copies land here (a plain-HTTP test origin has no clipboard of its own).
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copied.push(text); } } });
    localStorage.setItem('h5-task:local', '1');
    if (language === 'zh') localStorage.setItem('ta-lang', 'zh');
  }, lang);
  await page.addInitScript(activityStreamMock);
  await page.route(`${ORIGIN}/**`, route => serve(w, route));
  await page.goto(`${ORIGIN}/h5`);
  return { context, page };
}
async function openDevices(page) {
  await page.locator('#h5-open-tasks').waitFor();
  await page.evaluate(() => window.H5UI.actions.openSettings());
  await page.locator('#h5-settings').waitFor({ state: 'visible' });
  const summary = page.locator('#h5-set-devices .MuiAccordionSummary-root');
  await summary.scrollIntoViewIfNeeded();
  await summary.click();
  await page.waitForFunction(() => Boolean(document.querySelector('#h5-set-devices .MuiCollapse-entered')));
  await page.waitForFunction(() => (document.getElementById('h5-engine-local-version') || {}).textContent === 'v2.101.0');
}
const text = (page, selector) => page.locator(selector).textContent();

const SCENARIOS = {
  async 'an older app: its version, rebuild, the command and the addresses, each copied'(browser) {
    const w = world();
    const { context, page } = await open(browser, w);
    await openDevices(page);
    const section = page.locator('#h5-sec-mac-app');
    await section.waitFor();
    assert.equal(await text(page, '#h5-sec-mac-app-title'), 'Mac app');
    assert.equal(await text(page, '#h5-mac-app-state'), 'Older than the server: rebuild it');
    assert.equal(await text(page, '#h5-mac-app-version'), 'App v2.100.0 \u00b7 Server v2.101.0');
    assert.equal(await text(page, '#h5-mac-app-path'), '/Users/me/Applications/T-Agent.app');
    assert.equal(await text(page, '#h5-mac-app-command'), 'cd /Users/me/t-agent && npm run build:mac-app -- --install');
    assert.equal(await section.locator('.h5-mac-app-label').first().textContent(), 'Rebuild and install it in a terminal on this Mac:');
    assert.equal(await text(page, '#h5-mac-app-addresses-title'), 'Web addresses');
    const labels = await page.locator('#h5-mac-app-addresses .h5-mac-app-label').allTextContents();
    assert.deepEqual(labels, ['This computer', 'Local network (en0)', 'Remote (frp)']);
    for (const [index, entry] of ADDRESSES.entries()) assert.equal(await text(page, `#h5-mac-app-address-${index}`), entry.url);
    // Copy: the command, then an address; the button says Copied.
    const copyCommand = page.locator('#h5-mac-app-command-copy');
    const box = await copyCommand.boundingBox();
    assert.ok(box.height >= 44, `the Copy button is ${box.height}px high`);
    await copyCommand.tap();
    await page.waitForFunction(() => document.getElementById('h5-mac-app-command-copy').textContent === 'Copied');
    await page.locator('#h5-mac-app-address-1-copy').tap();
    await page.waitForFunction(() => window.__copied.length === 2);
    assert.deepEqual(await page.evaluate(() => window.__copied), ['cd /Users/me/t-agent && npm run build:mac-app -- --install', 'http://192.168.1.20:3000']);
    // No sideways scrolling at phone width.
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    const width = await page.evaluate(() => { const r = document.getElementById('h5-sec-mac-app').getBoundingClientRect(); return r.right; });
    assert.ok(width <= 390, `the card ends at ${width}px`);
    if (SHOTS) {
      await section.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(SHOTS, 'mac-app-390.png') });
    }
    await context.close();
  },
  async 'up to date, and a folder with spaces is quoted'(browser) {
    const w = world({ appInfo: { addresses: ADDRESSES.slice(0, 1), app: { ...INSTALLED_OLD, version: '2.101.0', matches_server: true }, server: { version: '2.101.0', install_dir: "/Users/me/My Apps/t-agent's" } } });
    const { context, page } = await open(browser, w);
    await openDevices(page);
    await page.locator('#h5-sec-mac-app').waitFor();
    assert.equal(await text(page, '#h5-mac-app-state'), 'Up to date');
    assert.equal(await text(page, '#h5-mac-app-command'), "cd '/Users/me/My Apps/t-agent'\\''s' && npm run build:mac-app -- --install");
    assert.equal(await page.locator('#h5-sec-mac-app .h5-mac-app-label').first().textContent(), 'Build and install it in a terminal on this Mac:');
    assert.equal(await page.locator('#h5-mac-app-addresses .h5-mac-app-label').count(), 1);
    await context.close();
  },
  async 'not installed'(browser) {
    const w = world({ appInfo: { addresses: ADDRESSES, app: { installed: false, path: null, version: null, matches_server: false }, server: { version: '2.101.0', install_dir: '/Users/me/t-agent' } } });
    const { context, page } = await open(browser, w);
    await openDevices(page);
    await page.locator('#h5-sec-mac-app').waitFor();
    assert.equal(await text(page, '#h5-mac-app-state'), 'Not installed');
    assert.equal(await page.locator('#h5-mac-app-version').count(), 0);
    assert.equal(await page.locator('#h5-mac-app-path').count(), 0);
    assert.equal(await text(page, '#h5-mac-app-command'), 'cd /Users/me/t-agent && npm run build:mac-app -- --install');
    await context.close();
  },
  async 'nothing on a server that is not macOS, or on an older server'(browser) {
    for (const appInfo of [{ addresses: ADDRESSES, app: null, server: { version: '2.101.0', install_dir: '/srv/t-agent' } }, 404]) {
      const w = world({ appInfo });
      const { context, page } = await open(browser, w);
      await openDevices(page);
      await page.waitForFunction(() => true);
      const end = Date.now() + 5000;
      while (w.reads === 0 && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(w.reads >= 1, 'the route was read');
      await page.waitForTimeout(300); // the answer is drawn (or not) right after it arrives
      assert.equal(await page.locator('#h5-sec-mac-app').count(), 0);
      await context.close();
    }
  },
  async 'Chinese'(browser) {
    const w = world();
    const { context, page } = await open(browser, w, { lang: 'zh' });
    await page.locator('#h5-open-tasks').waitFor();
    await page.evaluate(() => window.H5UI.actions.openSettings());
    await page.locator('#h5-settings').waitFor({ state: 'visible' });
    const summary = page.locator('#h5-set-devices .MuiAccordionSummary-root');
    await summary.scrollIntoViewIfNeeded();
    await summary.click();
    await page.locator('#h5-sec-mac-app').waitFor();
    assert.equal(await text(page, '#h5-sec-mac-app-title'), 'Mac \u5e94\u7528');
    assert.equal(await text(page, '#h5-mac-app-state'), '\u6bd4\u670d\u52a1\u65e7\uff1a\u8bf7\u91cd\u65b0\u6784\u5efa');
    assert.deepEqual(await page.locator('#h5-mac-app-addresses .h5-mac-app-label').allTextContents(), ['\u672c\u673a', '\u5c40\u57df\u7f51 (en0)', '\u8fdc\u7a0b\uff08frp\uff09']);
    await context.close();
  },
};

(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const [name, run] of Object.entries(SCENARIOS)) {
      await run(browser);
      console.log(`  ok: ${name}`);
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log('Mac app settings card passed.');
})().catch(error => { console.error(error); process.exit(1); });
