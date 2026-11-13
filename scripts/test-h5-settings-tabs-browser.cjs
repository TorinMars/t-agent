// Browser test of the tabs at the top of the settings sheet (scripts/h5-shell/SettingsTabs.jsx, DeviceTarget.jsx, settings-tabs.mjs) in real Chromium,
// with the server mocked. Reading and saving through a linked device's tab is scripts/test-h5-device-settings-browser.cjs; the pills inside the tabs
// are scripts/test-h5-settings-scope-browser.cjs.
// - phone 390: the tabs are Shared, this device (its engine name with "This device" under it), K01, an older device (disabled, "Update Old Mac
//   first"), a device that is offline and not known (disabled, "Offline") and one that is offline but has the feature (enabled, "Offline", and the
//   line under the tabs says so). Each tab shows exactly its parts, and a group with nothing in the tab is hidden. The arrow keys move between tabs.
// - a remembered tab of a device that cannot be chosen now falls back to Shared and stays remembered.
// - `ui.actions.openSettings(id)` moves to the tab that holds the part (a per-device part: this device's tab) and opens it; a whole group stays on
//   the chosen tab when it has parts there.
// - phone 320 and 390: the tab row scrolls with its scroll buttons, nothing is wider than the screen, every button and tab is a 44px target.
// - Chinese 320: the tabs, the notes and the line under them are translated; device names are not.
// - the settings sync turned off (GET /api/settings-sync answers `off()` of routes/settings-sync.js) while the device list has K01: no Shared tab;
//   this device's tab draws every part, K01 can be chosen and shows its per-device parts, no pill says a change is copied, a remembered Shared tab
//   falls back to this device and stays remembered, and `openSettings` of a shared part stays on this device.
// H5_SHOT_DIR=<dir> saves 390px (3x) screenshots of the sheet in each tab.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const SHOTS = process.env.H5_SHOT_DIR || '';
const html = fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const SHARED = ['translate', 'voice', 'oss', 'oss-agent-access', 'attention-summary', 'notify-rules', 'notifier-plugins', 'widget-language', 'task-list-devices', 'browser-sites'];
const DEVICE = ['workdir', 'access', 'authenticator', 'engine-name', 'widget-enabled', 'peer-fs', 'restart', 'rule-sync'];
const DEVICES = { devices: [
  { id: 2, name: 'K01', online: true, supported: true },
  { id: 3, name: 'Old Mac', online: true, supported: false },
  { id: 4, name: 'Away', online: false, supported: null },
  { id: 5, name: 'Sleeping', online: false, supported: true },
] };

// `syncOff`: GET /api/settings-sync answers as a service with SETTINGS_SYNC_ENABLED=false does (routes/settings-sync.js `off()`).
function mockServer({ scopes, devices, syncOff }) {
  window.calls = [];
  window.confirm = () => true;
  const skills = home => ({ skills: ['t-attention', 'tcli'].map(name => ({ name, description: `The ${name} skill.`, claude: { installed: false, current: false, conflict: null, path: `${home}/.claude/skills/${name}/SKILL.md` }, codex: { installed: false, current: false, conflict: null, path: `${home}/.codex/skills/${name}/SKILL.md` } })), old_task_tracker: { claude: false, codex: false }, user: null });
  const local = {
    '/auth/me': { work_dir: null, effective_work_dir: '/home/t/tasks', access_mode: 'remote', authenticator_bound: true, listen_host: '0.0.0.0' },
    '/api/settings-sync': syncOff
      ? { supported: false, scopes: Object.fromEntries(Object.entries(scopes).map(([id, scope]) => [id, scope === 'shared' ? 'device' : scope])), keys: [], peers: [] }
      : { supported: true, scopes, keys: [], peers: [{ name: 'K01', online: true, supported: true, last_sync_at: new Date().toISOString(), last_error: null }] },
    '/api/device-settings/devices': devices,
    '/api/oss/config': { enabled: false, hasAccessKeySecret: false },
    '/api/oss/agent-access': { enabled: true },
    '/api/agent-skills': skills('/home/t'),
    '/api/browser-ext': { protocol: 1, connected: true, browsers: [], extension_dir: '/home/t/t-agent/extensions/chrome', extension_present: true, server_url: 'http://127.0.0.1:3000' },
    '/api/translate/config': { provider: 'deepseek', providers: { deepseek: { label: 'DeepSeek', hasApiKey: true, baseUrl: '', model: 'deepseek-chat' } } },
    '/api/speech/config': { keySource: 'saved', region: 'cn', regions: { cn: { label: 'China', endpoint: 'wss://cn.example/ws' } }, language: 'zh', languages: { zh: 'Chinese' }, model: 'asr-1', noiseThreshold: null, hotwords: '', vocabularyId: '', endpoint: '' },
    '/api/remote-servers': [2, 3, 4, 5].map(id => ({ id, name: { 2: 'K01', 3: 'Old Mac', 4: 'Away', 5: 'Sleeping' }[id], base_url: `tunnel://l${id}`, status: id === 2 || id === 3 ? 'online' : 'offline', remote_version: '2.121.0', can_rename: true, name_source: 'engine' })),
    '/api/service-links': { supported: true, links: [2, 3, 4, 5].map(id => ({ id: `l${id}`, name: `D${id}`, state: 'online', role: 'initiator', peer_url: `http://10.0.0.${id}:14002`, remote_server_id: id })) },
    '/api/system/version': { app_version: '2.121.0', boot_id: 'b1' },
    '/api/system/engine-name': { name: 'T01', default_name: 't01', custom: true },
    '/api/peer-fs/settings': { enabled: false },
    '/api/rule-sync': { role: 'off', codex: false, local_changes: [], targets: [], skills: [], warnings: [], claude_md_path: '/home/t/.claude/CLAUDE.md', import_line: '@shared.md' },
    '/api/rule-sync/shared': { source: { local: true, name: 'T01' } },
    '/api/remote-tokens': [],
    '/api/attention/tokens': { tokens: [] },
    '/api/attention/settings/summary': { enabled: false, provider: 'deepseek', model: '', providers: [{ id: 'deepseek', label: 'DeepSeek', hasApiKey: true }] },
    '/api/attention/settings/guide': { dismissed: true, pageOnly: false, paired: false, tested: false, updatedAt: null },
    '/api/attention/plugins': { listeners: [{ name: 'claude', version: '1.0.0', description: 'Claude', loaded: true, error: null, enabled: true, statuses: {} }], notifiers: [{ name: 'telegram', version: '1.0.0', description: 'Telegram', loaded: true, error: null, enabled: true, configured: true, summary: 'Logged in', statuses: {}, settings: true, test: true, customUi: 'telegram' }] },
    '/api/attention/widget/settings': { enabled: true, language: 'auto', platform_supported: true, swiftc: true, running: true, building: false, last_error: null },
    '/api/attention/market': { plugins: [] },
  };
  const k01 = {
    '/auth/me': { work_dir: '/k01/work', effective_work_dir: '/k01/work' },
    '/peer-fs/settings': { enabled: true },
    '/agent-skills': skills('/Users/k'),
    '/rule-sync': { role: 'off', codex: false, local_changes: [], targets: [], skills: [], warnings: [], claude_md_path: '/Users/k/.claude/CLAUDE.md', import_line: '@shared.md' },
    '/rule-sync/shared': { source: { local: false, name: 'T01' } },
    '/attention/widget/settings': { enabled: false, language: 'auto', platform_supported: true, swiftc: true, running: false, building: false, last_error: null },
  };
  window.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    const pathname = String(url).split('?')[0];
    window.calls.push({ method, url: pathname });
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const remote = /^\/api\/device-settings\/(\d+)(\/.*)$/.exec(pathname);
    if (remote) {
      if (remote[1] !== '2') return reply({ error: 'REMOTE_OFFLINE', message: 'The device is offline' }, 502);
      return k01[remote[2]] ? reply(k01[remote[2]]) : reply({ error: 'DEVICE_SETTING_NOT_ALLOWED' }, 404);
    }
    const known = local[pathname];
    if (known && (method === 'GET' || method === 'PUT')) return reply(known);
    return reply({ error: 'NOT_FOUND' }, 404);
  };
}

async function openPage(browser, { width = 390, zh = false, stored = null, syncOff = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: SHOTS ? 3 : 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://app.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://app.test/');
  await page.evaluate(([lang, tab]) => {
    if (lang) localStorage.setItem('ta-lang', lang);
    if (tab) localStorage.setItem('t-agent.settings-tab', tab);
  }, [zh ? 'zh' : '', stored]);
  await page.addStyleTag({ content: read('public/css/h5.css') });
  const scopes = Object.fromEntries([...SHARED.map(id => [id, 'shared']), ...DEVICE.map(id => [id, 'device']), ['telegram', 'telegram']]);
  await page.evaluate(mockServer, { scopes, devices: DEVICES, syncOff });
  for (const file of ['public/js/i18n.js', 'public/js/i18n-zh-ui.js', 'public/js/i18n-zh-server.js', 'public/js/i18n-zh-extra.js', 'public/js/h5-shell.js']) await page.addScriptTag({ content: read(file) });
  // This device's engine name comes with the sources (h5.js, not loaded here); the switches of "Show in task list" too.
  await page.evaluate(() => {
    window.H5UI.set({ sources: [{ key: 'local', label: '', name: 'T01', offline: false, hidden: false, listed: true, instanceId: null, capabilities: null }], hiddenDevices: { supported: true, keys: [] } });
    window.H5UI.actions.setDeviceVisible = async () => {};
    // The same as h5.js (not loaded here).
    let seq = 100;
    window.H5UI.actions.openSettings = group => window.H5UI.set({ settingsOpen: true, settingsTarget: typeof group === 'string' && group ? { id: group, seq: ++seq } : null });
  });
  return { context, page, errors };
}

const settled = page => page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity));
async function openSheet(page, target = null) {
  await page.evaluate(next => window.H5UI.set({ settingsOpen: true, settingsTarget: next }), target);
  await page.locator('#h5-settings-tabs').waitFor({ state: 'visible' });
  await settled(page);
}
async function chooseTab(page, value) {
  const tab = page.locator(`#h5-settings-tab-${value}`);
  await tab.scrollIntoViewIfNeeded();
  await tab.tap();
  await page.waitForFunction(id => document.getElementById(`h5-settings-tab-${id}`).getAttribute('aria-selected') === 'true', value);
  await settled(page);
}
const chosenTab = page => page.evaluate(() => document.querySelector('#h5-settings-tabs [role="tab"][aria-selected="true"]').dataset.tab);
async function openGroup(page, id) {
  const summary = page.locator(`#h5-set-${id} .MuiAccordionSummary-root`);
  if (await summary.getAttribute('aria-expanded') === 'true') return;
  await summary.scrollIntoViewIfNeeded();
  await summary.tap();
  await page.waitForFunction(groupId => Boolean(document.querySelector(`#h5-set-${groupId} > .MuiCollapse-entered`)), id);
  await settled(page);
}
const shownGroups = page => page.evaluate(() => [...document.querySelectorAll('#h5-settings .h5-setting-group')].filter(group => !group.hidden && group.getBoundingClientRect().height > 0).map(group => group.id.replace('h5-set-', '')));
const openGroups = page => page.evaluate(() => [...document.querySelectorAll('#h5-settings .h5-setting-group')].filter(group => group.querySelector('.MuiAccordionSummary-root').getAttribute('aria-expanded') === 'true').map(group => group.id.replace('h5-set-', '')));

// The parts a group shows, by marker: the part headings (h3, in page order) of the group, and of T-Attention the plugin lists and the window controls.
const partsOf = (page, id) => page.evaluate(groupId => {
  const group = document.getElementById(`h5-set-${groupId}`);
  const seen = el => el.getBoundingClientRect().height > 0;
  const headings = [...group.querySelectorAll('.MuiAccordionDetails-root h3')].filter(seen).map(el => el.textContent.trim());
  const marks = ['#h5-engine-list', '#h5-shown-devices', '#h5-settings-sync', '#h5-plugins-listeners', '#h5-plugins-notifiers', '#h5-plugins-rules', '#h5-plugins-tab-market',
    '#h5-attention-widget-enabled', '#h5-attention-widget-language', '#h5-guide-show', '#h5-skill-pointer', '#h5-attention-token-create', '#h5-attention-sound']
    .filter(selector => { const el = group.querySelector(selector); return el && (seen(el) || el.type === 'checkbox'); });
  return { headings, marks };
}, id);

const groupsReady = {
  'tasks-files': () => document.getElementById('h5-workdir') || document.getElementById('h5-oss-save'),
  'voice-translate': () => document.getElementById('h5-tr-model') && document.getElementById('h5-tr-model').value === 'deepseek-chat',
  devices: () => document.getElementById('h5-engine-list') ? document.getElementById('h5-rule-sync-role') && document.getElementById('h5-peer-fs-enabled') : document.querySelectorAll('.h5-shown-device').length === 5,
  attention: () => document.querySelector('#h5-plugins-listeners, #h5-plugins-notifiers') && document.querySelector('#h5-attention-widget-enabled, #h5-attention-widget-language'),
  account: () => document.getElementById('h5-access-title') || document.getElementById('h5-access-remote'),
};
async function partsOfTab(page) {
  const result = {};
  for (const id of await shownGroups(page)) {
    await openGroup(page, id);
    await page.waitForFunction(groupsReady[id], null, { timeout: 10000 }).catch(error => { throw new Error(`${id} not ready: ${error.message}`); });
    result[id] = await partsOf(page, id);
  }
  return result;
}

const EXPECTED = {
  shared: {
    'tasks-files': { headings: ['Image and file upload', 'Site library'], marks: [] },
    'voice-translate': { headings: ['Voice input', 'Translation'], marks: [] },
    devices: { headings: ['Settings sync', 'Show in task list'], marks: ['#h5-shown-devices', '#h5-settings-sync'] },
    attention: { headings: ['Plugins', 'Desktop window (macOS)', 'AI summary'], marks: ['#h5-plugins-notifiers', '#h5-plugins-rules', '#h5-attention-widget-language'] },
  },
  local: {
    'tasks-files': { headings: ['Working directory', 'Agent skills', 'Browser extension'], marks: [] },
    devices: { headings: ['Link a device', 'Rules and skills sync', 'Advanced'], marks: ['#h5-engine-list'] },
    attention: { headings: ['Reminders on this device', 'Plugins', 'CLI tokens'], marks: ['#h5-plugins-listeners', '#h5-plugins-tab-market', '#h5-attention-widget-enabled', '#h5-guide-show', '#h5-skill-pointer', '#h5-attention-token-create', '#h5-attention-sound'] },
    account: { headings: ['Access mode', 'Authenticator'], marks: [] },
  },
};
// K01: the same parts, read on K01 or replaced by the note; the marketplace and the token form are this device's and are left out.
EXPECTED['2'] = {
  ...EXPECTED.local,
  attention: { headings: ['Reminders on this device', 'Plugins', 'CLI tokens'], marks: ['#h5-plugins-listeners', '#h5-attention-widget-enabled', '#h5-skill-pointer', '#h5-attention-sound'] },
};

// Nothing in the sheet is wider than the screen (a tab scrolled out of the tab row is clipped by its scroller), and every visible button, tab and
// group header is at least 44px high.
async function assertFits(page, label) {
  const result = await page.evaluate(() => {
    const sheet = document.querySelector('#h5-settings .h5-sheet-panel');
    const inner = document.documentElement.clientWidth;
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).opacity !== '0'; };
    const clipped = el => Boolean(el.parentElement && el.parentElement.closest('.MuiTabs-scroller'));
    const outside = [...sheet.querySelectorAll('*')].filter(visible).filter(el => !clipped(el)).filter(el => { const r = el.getBoundingClientRect(); return r.right > inner + 0.5 || r.left < -0.5; }).map(el => el.id || String(el.className).slice(0, 60) || el.tagName);
    const small = [...sheet.querySelectorAll('button, [role="button"], [role="tab"], .MuiAccordionSummary-root, .MuiTabScrollButton-root')].filter(visible).filter(el => !el.closest('.MuiSwitch-root, .MuiCheckbox-root, .MuiRadio-root'))
      .map(el => ({ id: el.id || el.textContent.trim().slice(0, 40) || String(el.className).slice(0, 40), height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width }))
      .filter(item => item.height < 43.5 || item.width < 43.5);
    return { outside, small, scroll: document.documentElement.scrollWidth - innerWidth };
  });
  assert.deepEqual(result.outside, [], `${label}: nothing is wider than the screen`);
  assert.ok(result.scroll <= 0, `${label}: no horizontal page scroll`);
  assert.deepEqual(result.small, [], `${label}: every button and tab is a 44px touch target`);
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

async function testTabs(browser) {
  const { context, page, errors } = await openPage(browser);
  await openSheet(page);
  const tabs = await page.locator('#h5-settings-tabs [role="tab"]').evaluateAll(nodes => nodes.map(node => [node.dataset.tab, node.innerText.replace(/\s+/g, ' ').trim(), node.getAttribute('aria-disabled') === 'true' || node.disabled]));
  assert.deepEqual(tabs, [
    ['shared', 'Shared', false], ['local', 'T01 This device', false], ['2', 'K01', false],
    ['3', 'Old Mac Update Old Mac first', true], ['4', 'Away Offline', true], ['5', 'Sleeping Offline', false],
  ]);
  assert.equal(await page.locator('#h5-settings-tabs [role="tablist"]').getAttribute('aria-label'), 'Settings for');
  assert.equal(await page.getAttribute('#h5-settings-tab-3', 'title'), 'Old Mac is too old to be changed from here. Update Old Mac first.');
  assert.equal(await chosenTab(page), 'shared');
  // The tab row sits under the title, above Language; Language and Log out are in every tab.
  const order = await page.evaluate(() => {
    const top = selector => document.querySelector(selector).getBoundingClientRect().top;
    return [top('#h5-settings-title'), top('#h5-settings-tabs'), top('.h5-settings-body .h5-setting-row')];
  });
  assert.ok(order[0] < order[1] && order[1] < order[2], `title, tabs, Language: ${order}`);

  for (const value of ['shared', 'local', '2']) {
    if (await chosenTab(page) !== value) await chooseTab(page, value);
    const groups = Object.keys(EXPECTED[value]);
    assert.deepEqual(await shownGroups(page), groups, `${value}: the groups that have parts in the tab`);
    assert.equal(await page.locator('#h5-lang').isVisible(), true, `${value}: Language`);
    assert.equal(await page.locator('#h5-logout').count(), 1, `${value}: Log out`);
    assert.deepEqual(await partsOfTab(page), EXPECTED[value], `${value}: exactly its parts`);
    await assertFits(page, `390 ${value}`);
    if (SHOTS) { await page.evaluate(() => { document.querySelector('#h5-settings .h5-settings-body').scrollTop = 0; }); await shot(page, `settings-tabs-${value}-390`); }
  }
  // K01: its own values, and the notes for what is changed on its own page.
  assert.equal(await page.locator('#h5-workdir').inputValue(), '/k01/work');
  assert.equal(await page.locator('#h5-browser-ext-remote').innerText(), 'Open K01’s own page to change this');
  assert.equal(await page.locator('#h5-settings-tab-hint').innerText(), 'These settings are read and saved on K01');

  // A disabled tab cannot be chosen; an offline device that has the feature can, and the line under the tabs says it is offline.
  await page.locator('#h5-settings-tab-3').tap({ force: true }).catch(() => {});
  assert.equal(await chosenTab(page), '2', 'an older device cannot be chosen');
  await chooseTab(page, '5');
  assert.equal(await page.locator('#h5-settings-tab-hint').innerText(), 'Sleeping is offline. Its settings can be read and saved again once it is back online.');
  await openGroup(page, 'devices');
  await page.waitForFunction(() => /offline/i.test((document.getElementById('h5-peer-fs-feedback') || {}).textContent || '') || !document.getElementById('h5-peer-fs-enabled'));

  // The arrow keys move between the tabs, Enter chooses one.
  await page.locator('#h5-settings-tab-5').focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.tab), '2', 'disabled tabs are skipped');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('h5-settings-tab-2').getAttribute('aria-selected') === 'true');
  assert.deepEqual(errors, []);
  await context.close();
}

async function testRememberedDisabled(browser) {
  const { context, page, errors } = await openPage(browser, { stored: '3' });
  await openSheet(page);
  assert.equal(await chosenTab(page), 'shared', 'a device that cannot be chosen now falls back to Shared');
  assert.equal(await page.evaluate(() => localStorage.getItem('t-agent.settings-tab')), '3', 'and stays remembered while it is linked');
  assert.deepEqual(errors, []);
  await context.close();
}

async function testOpenSettings(browser) {
  const { context, page, errors } = await openPage(browser, { stored: '2' });
  // A per-device part from code: this device's tab, even with K01 remembered; the group opens on the part.
  await openSheet(page, { id: 'workdir', seq: 1 });
  await page.waitForFunction(() => document.getElementById('h5-settings-tab-local').getAttribute('aria-selected') === 'true');
  await page.waitForFunction(() => document.querySelector('#h5-set-tasks-files > .MuiCollapse-entered') && document.getElementById('h5-workdir').value === '/home/t/tasks');
  assert.deepEqual(await openGroups(page), ['tasks-files']);
  // A shared part: Shared.
  await page.evaluate(() => window.H5UI.actions.openSettings('translate'));
  await page.waitForFunction(() => document.getElementById('h5-settings-tab-shared').getAttribute('aria-selected') === 'true');
  await page.waitForFunction(() => document.querySelector('#h5-set-voice-translate > .MuiCollapse-entered'));
  await page.waitForFunction(() => document.getElementById('h5-sec-translate').getBoundingClientRect().top < 400);
  // An old alias of a per-device part: this device's tab, with Link a device.
  await page.evaluate(() => window.H5UI.actions.openSettings('service-links'));
  await page.waitForFunction(() => document.getElementById('h5-settings-tab-local').getAttribute('aria-selected') === 'true' && document.querySelector('#h5-set-devices > .MuiCollapse-entered') && document.getElementById('h5-sec-link'));
  // A whole group stays on the chosen tab when it has parts there; Account has none in Shared.
  await chooseTab(page, '2');
  await page.evaluate(() => window.H5UI.actions.openSettings('attention'));
  await page.waitForFunction(() => document.querySelector('#h5-set-attention > .MuiCollapse-entered'));
  assert.equal(await chosenTab(page), '2');
  await chooseTab(page, 'shared');
  await page.evaluate(() => window.H5UI.actions.openSettings('account'));
  await page.waitForFunction(() => document.getElementById('h5-settings-tab-local').getAttribute('aria-selected') === 'true' && document.querySelector('#h5-set-account > .MuiCollapse-entered'));
  // Once placed, a request does not hold the tab: the person can move on.
  await chooseTab(page, 'shared');
  await page.waitForTimeout(300);
  assert.equal(await chosenTab(page), 'shared');
  assert.deepEqual(errors, []);
  await context.close();
}

// The settings sync turned off on this service, K01 still linked: the tabs are this device, K01 and the others, without Shared.
const ALL_LOCAL = {
  'tasks-files': { headings: ['Working directory', 'Image and file upload', 'Agent skills', 'Browser extension', 'Site library'], marks: [] },
  'voice-translate': { headings: ['Voice input', 'Translation'], marks: [] },
  devices: { headings: ['Link a device', 'Rules and skills sync', 'Advanced'], marks: ['#h5-engine-list'] },
  // The desktop window is one part again, its switch the heading (as without tabs).
  attention: { headings: ['Reminders on this device', 'Plugins', 'AI summary', 'CLI tokens'], marks: ['#h5-plugins-listeners', '#h5-plugins-notifiers', '#h5-plugins-rules', '#h5-plugins-tab-market', '#h5-attention-widget-enabled', '#h5-attention-widget-language', '#h5-guide-show', '#h5-skill-pointer', '#h5-attention-token-create', '#h5-attention-sound'] },
  account: { headings: ['Access mode', 'Authenticator'], marks: [] },
};
async function testSyncOff(browser) {
  let { context, page, errors } = await openPage(browser, { syncOff: true });
  await openSheet(page);
  const tabs = await page.locator('#h5-settings-tabs [role="tab"]').evaluateAll(nodes => nodes.map(node => [node.dataset.tab, node.innerText.replace(/\s+/g, ' ').trim(), node.getAttribute('aria-disabled') === 'true' || node.disabled]));
  assert.deepEqual(tabs, [
    ['local', 'T01 This device', false], ['2', 'K01', false], ['3', 'Old Mac Update Old Mac first', true], ['4', 'Away Offline', true], ['5', 'Sleeping Offline', false],
  ], 'no Shared tab without the sync');
  assert.equal(await chosenTab(page), 'local', 'this device is the first tab');
  assert.equal(await page.locator('#h5-settings-tab-hint').innerText(), 'Changes here are saved on this device');
  assert.equal(await page.getAttribute('#h5-settings-tab-local', 'title'), 'Changes here are saved on this device');
  // This device's tab draws every part (the shared ones are this device's own now); no status line of the sync and no pill.
  assert.deepEqual(await shownGroups(page), ['tasks-files', 'voice-translate', 'devices', 'attention', 'account']);
  assert.deepEqual(await partsOfTab(page), ALL_LOCAL);
  assert.equal(await page.locator('#h5-sec-settings-sync').count(), 0, 'no "Settings sync" status line');
  assert.equal(await page.locator('#h5-settings .h5-scope').count(), 0, 'no pill says a change is copied');
  assert.equal(await page.locator('.h5-engine-visible-input').count() > 0, true, 'the "Show in task list" switches are on the device rows');
  await assertFits(page, '390 sync off local');
  await shot(page, 'settings-tabs-sync-off-local-390');
  // K01 can be chosen: its per-device parts, read on K01.
  await chooseTab(page, '2');
  assert.deepEqual(await shownGroups(page), Object.keys(EXPECTED['2']));
  assert.deepEqual(await partsOfTab(page), EXPECTED['2']);
  assert.equal(await page.locator('#h5-workdir').inputValue(), '/k01/work');
  assert.equal(await page.locator('#h5-settings-tab-hint').innerText(), 'These settings are read and saved on K01');
  assert.ok((await page.evaluate(() => window.calls.map(call => call.url))).includes('/api/device-settings/2/auth/me'), 'K01 is read through the link');
  assert.equal(await page.locator('#h5-settings .h5-scope').count(), 0);
  await assertFits(page, '390 sync off K01');
  await shot(page, 'settings-tabs-sync-off-k01-390');
  // A shared part opened from code stays on this device: there is no Shared tab to move to.
  await page.evaluate(() => window.H5UI.actions.openSettings('translate'));
  await page.waitForFunction(() => document.getElementById('h5-settings-tab-local').getAttribute('aria-selected') === 'true' && document.querySelector('#h5-set-voice-translate > .MuiCollapse-entered'));
  assert.equal(await page.locator('#h5-settings-tab-shared').count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
  // A remembered Shared tab: this device for now, and still remembered for when the sync is back.
  ({ context, page, errors } = await openPage(browser, { syncOff: true, stored: 'shared' }));
  await openSheet(page);
  assert.equal(await chosenTab(page), 'local');
  assert.equal(await page.evaluate(() => localStorage.getItem('t-agent.settings-tab')), 'shared');
  assert.deepEqual(errors, []);
  await context.close();
  // A remembered K01 tab is chosen again without the sync.
  ({ context, page, errors } = await openPage(browser, { syncOff: true, stored: '2' }));
  await openSheet(page);
  assert.equal(await chosenTab(page), '2');
  assert.deepEqual(errors, []);
  await context.close();
}

async function testNarrow(browser, zh) {
  const { context, page, errors } = await openPage(browser, { width: 320, zh });
  await openSheet(page);
  // Six tabs do not fit: the row scrolls, and the end button shows.
  const row = await page.evaluate(() => {
    const scroller = document.querySelector('#h5-settings-tabs .MuiTabs-scroller');
    const buttons = [...document.querySelectorAll('#h5-settings-tabs .MuiTabScrollButton-root')].map(el => getComputedStyle(el).opacity !== '0' && el.getBoundingClientRect().width > 0);
    return { overflow: scroller.scrollWidth > scroller.clientWidth, buttons };
  });
  assert.ok(row.overflow, 'the tabs overflow at 320');
  assert.deepEqual(row.buttons, [false, true], 'at the start only the end button shows');
  await page.locator('#h5-settings-tabs .MuiTabScrollButton-root').last().tap();
  await page.waitForFunction(() => document.querySelector('#h5-settings-tabs .MuiTabs-scroller').scrollLeft > 0);
  await assertFits(page, `320${zh ? ' zh' : ''} folded`);
  if (zh) {
    const tabs = await page.locator('#h5-settings-tabs [role="tab"]').allInnerTexts();
    assert.deepEqual(tabs.map(text => text.replace(/\s+/g, ' ').trim()), ['\u5171\u4eab', 'T01 \u672c\u673a', 'K01', 'Old Mac \u8bf7\u5148\u5347\u7ea7 Old Mac', 'Away \u79bb\u7ebf', 'Sleeping \u79bb\u7ebf']);
    assert.equal(await page.locator('#h5-settings-tab-hint').innerText(), '\u8fd9\u91cc\u7684\u4fee\u6539\u4f1a\u590d\u5236\u5230\u6240\u6709\u5173\u8054\u8bbe\u5907');
    await chooseTab(page, 'local');
    assert.equal(await page.locator('#h5-settings-tab-hint').innerText(), '\u53ea\u6709\u672c\u673a\u4f7f\u7528\u8fd9\u4e9b\u8bbe\u7f6e');
    await chooseTab(page, '5');
    assert.equal(await page.locator('#h5-settings-tab-hint').innerText(), 'Sleeping \u5df2\u79bb\u7ebf\u3002\u7b49\u5b83\u91cd\u65b0\u4e0a\u7ebf\u540e\u624d\u80fd\u518d\u8bfb\u53d6\u548c\u4fdd\u5b58\u5b83\u7684\u8bbe\u7f6e\u3002');
    await chooseTab(page, 'shared');
    await openGroup(page, 'devices');
    await page.waitForFunction(() => document.querySelectorAll('.h5-shown-device').length === 5);
    assert.equal(await page.locator('#h5-sec-task-list-devices-title').innerText(), '\u5728\u4efb\u52a1\u5217\u8868\u4e2d\u663e\u793a');
    assert.equal(await page.locator('.h5-shown-device[data-device="remote:2"] .h5-engine-visible-input').getAttribute('aria-label'), '\u5728\u4efb\u52a1\u5217\u8868\u4e2d\u663e\u793a K01');
  }
  for (const value of ['shared', 'local', '2']) {
    if (await chosenTab(page) !== value) await chooseTab(page, value);
    await partsOfTab(page);
    await assertFits(page, `320${zh ? ' zh' : ''} ${value}`);
  }
  assert.deepEqual(errors, []);
  await context.close();
}

(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await testTabs(browser);
    await testRememberedDisabled(browser);
    await testOpenSettings(browser);
    await testSyncOff(browser);
    await testNarrow(browser, false);
    await testNarrow(browser, true);
    console.log('h5 settings tabs browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
