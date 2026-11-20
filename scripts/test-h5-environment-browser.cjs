// Browser test of Settings → Devices → Environment (scripts/h5-shell/EnvironmentCompare.jsx, environment-compare.mjs) in real Chromium, with the
// server mocked:
// - 1440: the Devices row of the group list says "2 differences · 1 missing" before the group is opened; the table has a row per tool and a column
//   per machine by name (K01 before T01, whichever engine serves the page), the older versions orange, the missing tool red with its install hint
//   under the table; it is the same in the Shared tab, this device's tab and K01's tab; "Check again" probes every machine again (POST) and the
//   summary and the Devices row follow.
// - linked devices that cannot tell: an offline one, one without `environment:tools` and one whose read is refused say so in their column's header
//   and count as nothing.
// - 390: the table scrolls sideways inside its card with the first column fixed, nothing else is wider than the screen; the phone's group list shows
//   the summary on the Devices row.
// - Chinese: the table, the hint and the summary are translated; versions and machine names are not.
// H5_SHOT_DIR=<dir> saves 1440 and 390 (3x) screenshots of the table.
const { chromium } = require('playwright');
const { addShell } = require('./h5-shell-test-script.cjs');
const { openGroup, backToList } = require('./settings-test-helper.cjs');
const { settled } = require('./browser-test-wait.cjs');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const SHOTS = process.env.H5_SHOT_DIR || '';
const html = fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const tool = (id, name, value, status = 'ok', fix) => ({ id, name, status, value, ...(fix ? { fix } : {}) });
const CODEX_FIX = 'Install Codex, or set CODEX_PATH in .env to its full path, then restart the Client';
const report = ({ claude = '2.1.323', codex = '0.167.1', git = '2.50.1' } = {}) => ({
  checked_at: 1, platform: 'darwin', tools: [
    tool('node', 'Node.js', 'v24.22.0'), tool('git', 'git', git), tool('claude', 'Claude Code', claude),
    codex ? tool('codex', 'Codex', codex) : tool('codex', 'Codex', '', 'missing', CODEX_FIX),
    tool('tcli', 'tcli', ''), tool('shell', 'Shell', 'zsh'), tool('swift', 'Swift (Mac app)', '6.0'), tool('pm2', 'pm2', '6.0.8'),
  ],
});

// `devices`: the answer of GET /api/device-settings/devices; `reports`: path → the tools list (a status number: that error).
function mockServer({ devices, reports, after }) {
  window.calls = [];
  window.reports = reports;
  window.after = after; // the lists after "Check again" (POST)
  const local = {
    '/auth/me': { work_dir: null, effective_work_dir: '/home/t/tasks', access_mode: 'remote', authenticator_bound: true, listen_host: '0.0.0.0' },
    '/api/settings-sync': { supported: true, scopes: {}, keys: [], peers: [{ name: 'K01', online: true, supported: true, last_sync_at: new Date().toISOString(), last_error: null }] },
    '/api/remote-servers': devices.devices.map(device => ({ id: device.id, name: device.name, base_url: `tunnel://l${device.id}`, status: device.online ? 'online' : 'offline', remote_version: '2.143.0' })),
    '/api/service-links': { supported: true, links: [] },
    '/api/system/version': { app_version: '2.143.1', boot_id: 'b1' },
    '/api/system/engine-name': { name: 'T01', default_name: 't01', custom: true },
    '/api/device-tier': { company_computer: false },
  };
  window.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    const pathname = String(url).split('?')[0];
    window.calls.push({ method, url: pathname });
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (pathname === '/api/device-settings/devices') return reply(devices);
    const lists = method === 'POST' && window.after ? window.after : window.reports;
    if (Object.hasOwn(lists, pathname)) {
      const answer = lists[pathname];
      if (typeof answer === 'number') return reply({ error: answer === 501 ? 'DEVICE_SETTINGS_UNSUPPORTED' : 'REMOTE_OFFLINE' }, answer);
      return reply(answer);
    }
    const known = local[pathname];
    if (known && method === 'GET') return reply(known);
    return reply({ error: 'NOT_FOUND' }, 404);
  };
}

const K01_ONLY = { devices: [{ id: 2, name: 'K01', online: true, supported: true, company_computer: false, environment: true }] };
const MOCKUP = {
  '/api/environment/tools': report(),
  '/api/device-settings/2/environment/tools': report({ claude: '2.1.310', codex: '', git: '2.39.5' }),
};

async function openPage(browser, { width = 1440, zh = false, devices = K01_ONLY, reports = MOCKUP, after = null } = {}) {
  const phone = width < 600;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, hasTouch: phone, isMobile: phone, deviceScaleFactor: SHOTS && phone ? 3 : 1, colorScheme: 'dark' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://app.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://app.test/');
  await page.evaluate(lang => { if (lang) localStorage.setItem('ta-lang', lang); localStorage.removeItem('t-agent.settings-tab'); }, zh ? 'zh' : '');
  await page.addStyleTag({ content: read('public/css/h5.css') });
  await page.evaluate(mockServer, { devices, reports, after });
  for (const file of ['public/js/local-keys.js', 'public/js/i18n.js', 'public/js/i18n-zh-ui.js', 'public/js/i18n-zh-server.js', 'public/js/i18n-zh-extra.js']) await page.addScriptTag({ content: read(file) });
  await addShell(page);
  await page.evaluate(() => window.H5UI.set({ sources: [{ key: 'local', label: '', name: 'T01', offline: false, hidden: false, listed: true, instanceId: null, capabilities: null }], hiddenDevices: { supported: true, keys: [] } }));
  return { context, page, errors };
}

async function openSheet(page) {
  await page.evaluate(() => window.H5UI.set({ settingsOpen: true }));
  await page.locator('#h5-settings').waitFor({ state: 'visible' });
  await settled(page);
}
const rowNote = page => page.locator('#h5-settings-group-devices .h5-settings-group-note');
const table = page => page.evaluate(() => {
  const head = [...document.querySelectorAll('#h5-env-table thead th')].map(cell => cell.innerText.replace(/\s+/g, ' ').trim());
  const rows = [...document.querySelectorAll('#h5-env-table tbody tr')].map(row => [row.querySelector('th').innerText.trim(), ...[...row.querySelectorAll('td')].map(cell => `${cell.innerText.trim()}:${cell.dataset.tone}`)]);
  return { head, rows };
});
const colorOf = (page, tool, index) => page.evaluate(([id, at]) => getComputedStyle(document.querySelectorAll(`#h5-env-table tr[data-tool="${id}"] td`)[at]).color, [tool, index]);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
const waitTable = page => page.waitForFunction(() => document.querySelectorAll('#h5-env-table tbody tr').length > 0 && !document.querySelector('#h5-env-check[disabled]'));

async function testMockup(browser) {
  const { context, page, errors } = await openPage(browser);
  await openSheet(page);
  // Before the group is opened, its row in the list says how the machines differ.
  await rowNote(page).waitFor({ state: 'visible' });
  assert.equal(await rowNote(page).innerText(), '2 differences · 1 missing');
  await openGroup(page, 'devices');
  await waitTable(page);
  const { head, rows } = await table(page);
  assert.deepEqual(head, ['Tool', 'K01', 'T01'], 'machines by name, whichever engine serves the page');
  assert.deepEqual(rows, [
    ['Node.js', 'v24.22.0:same', 'v24.22.0:same'],
    ['git', '2.39.5:diff', '2.50.1:same'],
    ['Claude Code', '2.1.310:diff', '2.1.323:same'],
    ['Codex', 'not installed:missing', '0.167.1:same'],
    ['tcli', 'ok:same', 'ok:same'],
    ['Shell', 'zsh:same', 'zsh:same'],
    ['Swift (Mac app)', '6.0:same', '6.0:same'],
    ['pm2', '6.0.8:same', '6.0.8:same'],
  ]);
  const [orange, red, plain] = [await colorOf(page, 'git', 0), await colorOf(page, 'codex', 0), await colorOf(page, 'git', 1)];
  assert.ok(orange !== plain && red !== plain && orange !== red, `orange ${orange}, red ${red}, plain ${plain}`);
  assert.deepEqual(await page.locator('.h5-env-hint').allInnerTexts(), [`K01 · Codex: ${CODEX_FIX}`]);
  assert.equal(await page.locator('#h5-env-summary').innerText(), '2 differences · 1 missing');
  assert.equal(await page.locator('.h5-env-machine[data-machine="remote:2"] [translate="no"]').count(), 1, 'machine names are never translated');
  await shot(page, 'env-compare-1440');

  // The same table in this device's tab and in K01's tab.
  for (const tab of ['local', '2']) {
    await page.locator(`#h5-settings-tab-${tab}`).click();
    await page.waitForFunction(id => document.getElementById(`h5-settings-tab-${id}`).getAttribute('aria-selected') === 'true', tab);
    await openGroup(page, 'devices');
    assert.equal(await page.locator('#h5-env-table').isVisible(), true, `the table in tab ${tab}`);
    assert.deepEqual((await table(page)).head, ['Tool', 'K01', 'T01']);
  }
  const reads = await page.evaluate(() => window.calls.filter(call => call.url.endsWith('/environment/tools')).length);
  assert.ok(reads <= 4, `the lists are not read again on every tab (${reads} reads)`);

  // Check again: every machine probes again; the summary and the row follow.
  await page.evaluate(() => {
    window.after = { ...window.reports, '/api/device-settings/2/environment/tools': { ...window.reports['/api/device-settings/2/environment/tools'], tools: window.reports['/api/device-settings/2/environment/tools'].tools.map(item => (item.id === 'claude' ? { ...item, value: '2.1.323' } : item)) } };
  });
  await page.locator('#h5-env-check').click();
  await page.waitForFunction(() => document.getElementById('h5-env-summary').innerText === '1 difference · 1 missing');
  assert.deepEqual(await page.evaluate(() => window.calls.filter(call => call.method === 'POST').map(call => call.url).sort()), ['/api/device-settings/2/environment/tools', '/api/environment/tools']);
  assert.equal(await rowNote(page).innerText(), '1 difference · 1 missing');
  assert.deepEqual(errors, []);
  await context.close();
}

async function testCannotTell(browser) {
  const devices = { devices: [
    { id: 2, name: 'K01', online: true, supported: true, environment: true },
    { id: 3, name: 'Old Mac', online: true, supported: true, environment: false },
    { id: 4, name: 'Away', online: false, supported: true, environment: true },
    { id: 5, name: 'Refuses', online: true, supported: true, environment: null },
    { id: 6, name: 'Gone', online: true, supported: true, environment: null },
  ] };
  const reports = { '/api/environment/tools': report(), '/api/device-settings/2/environment/tools': report(), '/api/device-settings/5/environment/tools': 501, '/api/device-settings/6/environment/tools': 502 };
  const { context, page, errors } = await openPage(browser, { devices, reports });
  await openSheet(page);
  await openGroup(page, 'devices');
  await waitTable(page);
  const { head, rows } = await table(page);
  assert.deepEqual(head, ['Tool', 'Away Offline', 'Gone Offline', 'K01', 'Old Mac Update Old Mac first', 'Refuses Update Refuses first', 'T01']);
  assert.deepEqual(rows[0], ['Node.js', ':none', ':none', 'v24.22.0:same', ':none', ':none', 'v24.22.0:same']);
  assert.equal(await page.locator('#h5-env-summary').innerText(), 'The same on every machine');
  assert.equal(await rowNote(page).count(), 0, 'nothing on the Devices row');
  const asked = await page.evaluate(() => window.calls.filter(call => call.url.endsWith('/environment/tools')).map(call => call.url));
  assert.ok(!asked.some(url => /\/(3|4)\/environment/.test(url)), 'an offline or older device is not asked');
  assert.deepEqual(errors, []);
  await context.close();
}

async function testPhone(browser) {
  const { context, page, errors } = await openPage(browser, { width: 390 });
  await openSheet(page);
  await rowNote(page).waitFor({ state: 'visible' });
  assert.equal(await rowNote(page).innerText(), '2 differences · 1 missing', 'the phone\'s group list says it too');
  await openGroup(page, 'devices');
  await waitTable(page);
  await page.locator('#h5-sec-environment').scrollIntoViewIfNeeded();
  await settled(page);
  const fit = await page.evaluate(() => {
    const inner = document.documentElement.clientWidth;
    const wrap = document.getElementById('h5-env-table-wrap');
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const outside = [...document.querySelectorAll('#h5-settings-page *')].filter(visible).filter(el => !wrap.contains(el) || el === wrap)
      .filter(el => { const r = el.getBoundingClientRect(); return r.right > inner + 0.5 || r.left < -0.5; }).map(el => el.id || String(el.className).slice(0, 60));
    return { outside, scrolls: wrap.scrollWidth > wrap.clientWidth, page: document.documentElement.scrollWidth - innerWidth };
  });
  assert.deepEqual(fit.outside, [], 'nothing but the table\'s own content is wider than the screen');
  assert.ok(fit.page <= 0, 'no horizontal page scroll');
  await shot(page, 'env-compare-390');
  if (fit.scrolls) {
    const before = await page.locator('#h5-env-table tr[data-tool="git"] th').boundingBox();
    await page.evaluate(() => { document.getElementById('h5-env-table-wrap').scrollLeft = 400; });
    const after = await page.locator('#h5-env-table tr[data-tool="git"] th').boundingBox();
    assert.equal(Math.round(after.x), Math.round(before.x), 'the first column stays in place');
  }
  await backToList(page);
  assert.deepEqual(errors, []);
  await context.close();
}

async function testChinese(browser) {
  const { context, page, errors } = await openPage(browser, { zh: true });
  await openSheet(page);
  await rowNote(page).waitFor({ state: 'visible' });
  assert.equal(await rowNote(page).innerText(), '2 \u5904\u4e0d\u540c · \u7f3a\u5c11 1 \u9879');
  await openGroup(page, 'devices');
  await waitTable(page);
  const { head, rows } = await table(page);
  assert.deepEqual(head, ['\u5de5\u5177', 'K01', 'T01']);
  assert.deepEqual(rows[3], ['Codex', '\u672a\u5b89\u88c5:missing', '0.167.1:same']);
  assert.equal(await page.locator('#h5-sec-environment-title').innerText(), '\u73af\u5883');
  assert.match(await page.locator('.h5-env-hint').innerText(), /^K01 · Codex: \u5b89\u88c5 Codex/);
  assert.equal(await page.locator('#h5-env-check').innerText(), '\u91cd\u65b0\u68c0\u67e5');
  assert.deepEqual(errors, []);
  await context.close();
}

(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await testMockup(browser);
    await testCannotTell(browser);
    await testPhone(browser);
    await testChinese(browser);
    console.log('h5 environment browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
