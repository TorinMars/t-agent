// Browser test of "Settings for" at the top of the settings sheet (scripts/h5-shell/DeviceTarget.jsx, device-target.mjs) in real Chromium, with the
// server mocked:
// - phone 390: the selector lists This device, K01 and an older device (disabled, "Update Old Mac first"); choosing K01 makes the per-device parts
//   read and write through /api/device-settings/2/... (peer file access, working directory, agent skills, rules sync, the desktop window switch),
//   their labels say "K01 only", shared parts still read this device's /api routes, and the parts that cannot be changed from here (link a device,
//   Advanced, access mode, authenticator, CLI tokens, setup guide, listeners) show "Open K01's own page to change this". Nothing is wider than the screen.
// - the choice is remembered in localStorage and goes back to This device when K01 is no longer linked; a localStorage that throws is no error.
// - no supported linked device, and an older server (404): no selector.
// - Chinese 390: the selector, the labels and the note are translated.
// H5_SHOT_DIR=<dir> saves 390px (3x) screenshots of the sheet with K01 chosen.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const SHOTS = process.env.H5_SHOT_DIR || '';
const html = fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const SHARED = ['translate', 'voice', 'oss', 'oss-agent-access', 'attention-summary', 'notify-rules', 'notifier-plugins', 'widget-language', 'task-list-devices'];
const DEVICE = ['workdir', 'access', 'authenticator', 'engine-name', 'widget-enabled', 'peer-fs', 'restart', 'rule-sync'];

// `devices`: the answer of GET /api/device-settings/devices, or null for an older server (404).
function mockServer({ devices, scopes, brokenStorage }) {
  window.calls = [];
  window.confirm = () => true;
  window.devices = devices;
  if (brokenStorage) {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function getItem(key) { if (key === 't-agent.settings-device') throw new Error('denied'); return original.call(this, key); };
    Storage.prototype.setItem = function setItem() { throw new Error('denied'); };
  }
  const skills = home => ({ skills: ['t-attention', 'tcli'].map(name => ({ name, description: `The ${name} skill.`, claude: { installed: false, current: false, conflict: null, path: `${home}/.claude/skills/${name}/SKILL.md` }, codex: { installed: false, current: false, conflict: null, path: `${home}/.codex/skills/${name}/SKILL.md` } })), old_task_tracker: { claude: false, codex: false }, user: null });
  const local = {
    '/auth/me': { work_dir: null, effective_work_dir: '/home/t/tasks', access_mode: 'remote', authenticator_bound: true, listen_host: '0.0.0.0' },
    '/api/settings-sync': { supported: true, scopes, keys: [], peers: [{ name: 'K01', online: true, supported: true, last_sync_at: new Date().toISOString(), last_error: null }] },
    '/api/oss/config': { enabled: false, hasAccessKeySecret: false },
    '/api/oss/agent-access': { enabled: true },
    '/api/agent-skills': skills('/home/t'),
    '/api/translate/config': { provider: 'deepseek', providers: { deepseek: { label: 'DeepSeek', hasApiKey: true, baseUrl: '', model: 'deepseek-chat' } } },
    '/api/speech/config': { keySource: 'saved', region: 'cn', regions: { cn: { label: 'China', endpoint: 'wss://cn.example/ws' } }, language: 'zh', languages: { zh: 'Chinese' }, model: 'asr-1', noiseThreshold: null, hotwords: '', vocabularyId: '', endpoint: '' },
    '/api/remote-servers': [{ id: 2, name: 'K01', base_url: 'tunnel://l1', status: 'online', remote_version: '2.119.0', can_rename: true, name_source: 'engine' }],
    '/api/service-links': { supported: true, links: [{ id: 'l1', name: 'K01', state: 'online', role: 'initiator', peer_url: 'http://10.0.0.2:14002', remote_server_id: 2 }] },
    '/api/system/version': { app_version: '2.119.0', boot_id: 'b1' },
    '/api/system/engine-name': { name: 'Home Mac', default_name: 'home-mac', custom: true },
    '/api/peer-fs/settings': { enabled: false },
    '/api/rule-sync': { role: 'off', codex: false, local_changes: [], targets: [], skills: [], warnings: [], claude_md_path: '/home/t/.claude/CLAUDE.md', import_line: '@shared.md' },
    '/api/rule-sync/shared': { source: { local: true, name: 'Home Mac' } },
    '/api/remote-tokens': [],
    '/api/attention/tokens': { tokens: [] },
    '/api/attention/settings/summary': { enabled: false, provider: 'deepseek', model: '', providers: [{ id: 'deepseek', label: 'DeepSeek', hasApiKey: true }] },
    '/api/attention/settings/guide': { dismissed: false, pageOnly: false, paired: false, tested: false, updatedAt: null },
    '/api/attention/plugins': { listeners: [{ name: 'claude', version: '1.0.0', description: 'Claude', loaded: true, error: null, enabled: true, statuses: {} }], notifiers: [] },
    '/api/attention/widget/settings': { enabled: true, language: 'auto', platform_supported: true, swiftc: true, running: true, building: false, last_error: null },
    '/api/attention/market': { plugins: [] },
  };
  // K01, through the link.
  window.k01 = {
    '/auth/me': { work_dir: '/k01/work', effective_work_dir: '/k01/work' },
    '/auth/settings': { success: true, work_dir: '/k01/new' },
    '/peer-fs/settings': { enabled: true },
    '/agent-skills': skills('/Users/k'),
    '/rule-sync': { role: 'receive', codex: true, local_changes: [], targets: [], skills: [], warnings: [], claude_md_path: '/Users/k/.claude/CLAUDE.md', import_line: '@shared.md', following: null, received: { conflicts: [] } },
    '/rule-sync/shared': { source: { local: false, name: 'Home Mac' } },
    '/attention/widget/settings': { enabled: false, language: 'auto', platform_supported: true, swiftc: true, running: false, building: false, last_error: null },
  };
  window.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    const pathname = String(url).split('?')[0];
    const body = options.body ? JSON.parse(options.body) : undefined;
    window.calls.push({ method, url: pathname, body });
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (pathname === '/api/device-settings/devices') return window.devices ? reply(window.devices) : reply({ error: 'NOT_FOUND' }, 404);
    const remote = /^\/api\/device-settings\/2(\/.*)$/.exec(pathname);
    if (remote) {
      if (method === 'PUT' && remote[1] === '/peer-fs/settings') window.k01['/peer-fs/settings'] = { enabled: body.enabled };
      const known = window.k01[remote[1]];
      return known ? reply(known) : reply({ error: 'DEVICE_SETTING_NOT_ALLOWED' }, 404);
    }
    const known = local[pathname];
    if (known && (method === 'GET' || method === 'PUT')) return reply(known);
    return reply({ error: 'NOT_FOUND' }, 404);
  };
}

const DEVICES = { devices: [{ id: 2, name: 'K01', online: true, supported: true }, { id: 3, name: 'Old Mac', online: true, supported: false }] };

async function openPage(browser, { width = 390, zh = false, devices = DEVICES, stored = null, brokenStorage = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: SHOTS ? 3 : 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://app.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://app.test/');
  await page.evaluate(([lang, id]) => {
    if (lang) localStorage.setItem('ta-lang', lang);
    if (id) localStorage.setItem('t-agent.settings-device', id); else localStorage.removeItem('t-agent.settings-device');
  }, [zh ? 'zh' : '', stored]);
  await page.addStyleTag({ content: read('public/css/h5.css') });
  const scopes = Object.fromEntries([...SHARED.map(id => [id, 'shared']), ...DEVICE.map(id => [id, 'device']), ['telegram', 'telegram']]);
  await page.evaluate(mockServer, { devices, scopes, brokenStorage });
  for (const file of ['public/js/i18n.js', 'public/js/i18n-zh-ui.js', 'public/js/i18n-zh-server.js', 'public/js/i18n-zh-extra.js', 'public/js/h5-shell.js']) await page.addScriptTag({ content: read(file) });
  return { context, page, errors };
}

const settled = page => page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity));
async function openSheet(page) {
  await page.evaluate(() => window.H5UI.set({ settingsOpen: true }));
  await page.locator('#h5-settings .h5-settings-body').waitFor({ state: 'visible' });
  await page.waitForFunction(() => window.calls.some(call => call.url === '/api/device-settings/devices'));
  await settled(page);
}
async function toggleGroup(page, id) {
  const summary = page.locator(`#h5-set-${id} .MuiAccordionSummary-root`);
  await summary.scrollIntoViewIfNeeded();
  const wasOpen = await summary.getAttribute('aria-expanded') === 'true';
  await summary.tap();
  await page.waitForFunction(([groupId, open]) => Boolean(document.querySelector(`#h5-set-${groupId} > .MuiCollapse-entered`)) === open, [id, !wasOpen]);
  await settled(page);
}
const callsTo = (page, prefix) => page.evaluate(start => window.calls.filter(call => call.url.startsWith(start)).map(call => `${call.method} ${call.url}`), prefix);
async function assertFits(page, label) {
  const result = await page.evaluate(() => {
    const sheet = document.querySelector('#h5-settings .h5-sheet-panel');
    const inner = document.documentElement.clientWidth;
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const outside = [...sheet.querySelectorAll('*')].filter(visible).filter(el => { const r = el.getBoundingClientRect(); return r.right > inner + 0.5 || r.left < -0.5; }).map(el => el.id || String(el.className).slice(0, 60) || el.tagName);
    return { outside, scroll: document.documentElement.scrollWidth - innerWidth };
  });
  assert.deepEqual(result.outside, [], `${label}: nothing is wider than the screen`);
  assert.ok(result.scroll <= 0, `${label}: no horizontal page scroll`);
}
const shot = async (page, name) => { if (SHOTS) await page.locator('#h5-settings .h5-sheet-panel').screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

async function testChooseK01(browser) {
  const { context, page, errors } = await openPage(browser);
  await openSheet(page);
  const select = page.locator('#h5-settings-device-select');
  await select.waitFor({ state: 'visible' });
  const options = await select.locator('option').evaluateAll(nodes => nodes.map(node => [node.value, node.textContent, node.disabled]));
  assert.deepEqual(options, [['', 'This device', false], ['2', 'K01', false], ['3', 'Old Mac (Update Old Mac first)', true]]);
  assert.equal(await select.inputValue(), '');
  await select.selectOption('2');
  await page.locator('#h5-settings-device-hint').waitFor();
  assert.match(await page.locator('#h5-settings-device-hint').innerText(), /Parts marked \u201cK01 only\u201d are read and saved on K01/);
  assert.equal(await page.evaluate(() => localStorage.getItem('t-agent.settings-device')), '2');

  // Tasks and files: the working directory and the skills are K01's; the upload settings are this device's /api (shared).
  await toggleGroup(page, 'tasks-files');
  await page.waitForFunction(() => document.getElementById('h5-workdir').value === '/k01/work');
  await page.waitForFunction(() => document.querySelector('.h5-skill-path') && document.querySelector('.h5-skill-path').textContent.startsWith('/Users/k'));
  assert.equal(await page.locator('#h5-sec-workdir .h5-scope-label').innerText(), 'K01 only');
  assert.equal(await page.locator('#h5-sec-oss > .h5-scoped-heading .h5-scope-label').innerText(), 'Shared across devices');
  assert.ok((await callsTo(page, '/api/oss/config')).length > 0, 'shared parts read this device');
  await page.locator('#h5-workdir').fill('/k01/new');
  await page.locator('#h5-workdir-save').tap();
  await page.waitForFunction(() => window.calls.some(call => call.method === 'PUT' && call.url === '/api/device-settings/2/auth/settings'));
  assert.equal((await callsTo(page, '/auth/settings')).length, 0, 'not saved on this device');
  await page.locator('#h5-agent-skill-install-tcli').tap();
  await page.waitForFunction(() => window.calls.some(call => call.method === 'POST' && call.url === '/api/device-settings/2/agent-skills/tcli/install'));
  await assertFits(page, 'Tasks and files on K01');
  await shot(page, 'device-settings-tasks');
  await toggleGroup(page, 'tasks-files');

  // Devices: peer file access and the rules sync are K01's; linking and Advanced are changed on K01's own page; device names stay this device's.
  await toggleGroup(page, 'devices');
  await page.waitForFunction(() => document.getElementById('h5-peer-fs-enabled') && document.getElementById('h5-peer-fs-enabled').checked === true);
  await page.waitForFunction(() => document.getElementById('h5-rule-sync-role-receive') && document.getElementById('h5-rule-sync-role-receive').checked);
  assert.equal(await page.locator('#h5-sec-peer-fs .h5-scope-label').innerText(), 'K01 only');
  assert.equal(await page.locator('#h5-sec-rule-sync .h5-scope-label').first().innerText(), 'K01 only');
  assert.equal(await page.locator('#h5-set-devices .h5-scope[data-setting="engine-name"] .h5-scope-label').innerText(), 'Device names: This device only');
  assert.equal(await page.locator('#h5-link-remote').innerText(), 'Open K01\u2019s own page to change this');
  assert.equal(await page.locator('#h5-link-generate').count(), 0);
  await page.locator('#h5-devices-advanced-toggle').tap();
  await page.locator('#h5-devices-advanced-remote').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#h5-engine-connect-open').count(), 0);
  await page.locator('#h5-peer-fs-enabled').tap();
  await page.waitForFunction(() => window.calls.some(call => call.method === 'PUT' && call.url === '/api/device-settings/2/peer-fs/settings' && call.body.enabled === false));
  await page.waitForFunction(() => document.getElementById('h5-peer-fs-enabled').checked === false);
  assert.deepEqual((await callsTo(page, '/api/peer-fs/settings')), [], 'this device\'s switch is never read or written');
  await assertFits(page, 'Devices on K01');
  await shot(page, 'device-settings-devices');
  await toggleGroup(page, 'devices');

  // T-Attention: the window switch is K01's, the guide, the listeners and the CLI tokens are notes.
  await toggleGroup(page, 'attention');
  await page.waitForFunction(() => document.getElementById('h5-attention-widget-enabled') && document.getElementById('h5-attention-widget-enabled').checked === false);
  assert.ok((await callsTo(page, '/api/device-settings/2/attention/widget/settings')).length > 0);
  for (const id of ['#h5-guide-settings-remote', '#h5-attention-tokens-remote', '#h5-plugins-listeners-remote']) {
    assert.equal(await page.locator(id).innerText(), 'Open K01\u2019s own page to change this', id);
  }
  assert.equal(await page.locator('#h5-attention-token-create').count(), 0);
  assert.equal(await page.locator('#h5-set-attention .h5-scope[data-setting="widget-enabled"] .h5-scope-label').innerText(), 'On or off: K01 only');
  assert.equal(await page.locator('#h5-set-attention .h5-scope[data-setting="widget-language"] .h5-scope-label').innerText(), 'Window language: Shared across devices');
  await page.locator('#h5-attention-widget-language').selectOption('zh');
  await page.waitForFunction(() => window.calls.some(call => call.method === 'PUT' && call.url === '/api/attention/widget/settings' && call.body.language === 'zh'));
  assert.equal((await page.evaluate(() => window.calls.filter(call => call.method === 'PUT' && call.url.startsWith('/api/device-settings/') && call.body && call.body.language))).length, 0, 'the shared language is saved here');
  await toggleGroup(page, 'attention');

  // Account and access: notes only.
  await toggleGroup(page, 'account');
  assert.equal(await page.locator('#h5-access-remote').innerText(), 'Open K01\u2019s own page to change this');
  assert.equal(await page.locator('#h5-authenticator-remote').innerText(), 'Open K01\u2019s own page to change this');
  assert.equal(await page.locator('#h5-access-switch').count(), 0);
  await assertFits(page, 'Account on K01');
  await toggleGroup(page, 'account');

  // Back to this device: the parts read this device again.
  await select.selectOption('');
  await toggleGroup(page, 'devices');
  await page.waitForFunction(() => window.calls.some(call => call.url === '/api/peer-fs/settings'));
  assert.equal(await page.locator('#h5-sec-peer-fs .h5-scope-label').innerText(), 'This device only');
  assert.equal(await page.locator('#h5-link-generate').count(), 1);
  assert.equal(await page.evaluate(() => localStorage.getItem('t-agent.settings-device')), null);
  assert.deepEqual(errors, []);
  await context.close();
}

async function testRemembered(browser) {
  // Remembered: K01 is chosen again on the next visit.
  let opened = await openPage(browser, { stored: '2' });
  await openSheet(opened.page);
  await opened.page.waitForFunction(() => document.getElementById('h5-settings-device-select').value === '2');
  await opened.context.close();
  // K01 is no longer linked: back to this device, and the choice is forgotten.
  opened = await openPage(browser, { stored: '2', devices: { devices: [{ id: 5, name: 'K05', online: true, supported: true }] } });
  await openSheet(opened.page);
  assert.equal(await opened.page.locator('#h5-settings-device-select').inputValue(), '');
  assert.equal(await opened.page.evaluate(() => localStorage.getItem('t-agent.settings-device')), null);
  assert.deepEqual(opened.errors, []);
  await opened.context.close();
  // A storage that throws: the selector still works, nothing is remembered.
  opened = await openPage(browser, { brokenStorage: true });
  await openSheet(opened.page);
  await opened.page.locator('#h5-settings-device-select').selectOption('2');
  await opened.page.locator('#h5-settings-device-hint').waitFor();
  assert.deepEqual(opened.errors, []);
  await opened.context.close();
}

async function testHidden(browser, devices, label) {
  const { context, page, errors } = await openPage(browser, { devices });
  await openSheet(page);
  assert.equal(await page.locator('#h5-settings-device-select').count(), 0, `${label}: no selector`);
  assert.deepEqual(errors, []);
  await context.close();
}

async function testChinese(browser) {
  const { context, page, errors } = await openPage(browser, { zh: true, stored: '2' });
  await openSheet(page);
  await page.locator('#h5-settings-device-hint').waitFor();
  assert.equal(await page.locator('#h5-settings-device-select-label').innerText(), '\u8bbe\u7f6e\u5bf9\u8c61');
  const options = await page.locator('#h5-settings-device-select option').allInnerTexts();
  assert.deepEqual(options, ['\u672c\u673a', 'K01', 'Old Mac (\u8bf7\u5148\u5347\u7ea7 Old Mac)']);
  await toggleGroup(page, 'devices');
  await page.waitForFunction(() => document.querySelector('#h5-sec-peer-fs .h5-scope-label'));
  assert.equal(await page.locator('#h5-sec-peer-fs .h5-scope-label').innerText(), '\u4ec5 K01');
  assert.equal(await page.locator('#h5-link-remote').innerText(), '\u8bf7\u6253\u5f00 K01 \u81ea\u5df1\u7684\u9875\u9762\u6765\u4fee\u6539\u8fd9\u9879\u8bbe\u7f6e');
  await assertFits(page, 'zh Devices on K01');
  assert.deepEqual(errors, []);
  await context.close();
}

(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await testChooseK01(browser);
    await testRemembered(browser);
    await testHidden(browser, { devices: [{ id: 3, name: 'Old Mac', online: true, supported: false }] }, 'only an older device');
    await testHidden(browser, { devices: [] }, 'no linked device');
    await testHidden(browser, null, 'an older server');
    await testChinese(browser);
    console.log('h5 device settings browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
