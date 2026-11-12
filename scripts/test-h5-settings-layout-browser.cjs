// Browser test of the layout of the settings sheet (scripts/h5-shell/Settings.jsx, Engines.jsx, settings-target.mjs) in real Chromium, with the server
// mocked: the order of the groups and of the parts inside them, "Advanced" in Devices folded by default with the one-way options inside, the old group ids
// opening the group and part that took their place, no horizontal overflow and 44px touch targets at 320 and 390 px, and the Chinese headings.
// H5_SHOT_DIR=<dir> saves 390px (3x) screenshots: the folded sheet, Devices open, and Advanced open.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const SHOTS = process.env.H5_SHOT_DIR || '';
const html = fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const GROUPS = ['Tasks and files', 'Voice and translation', 'Devices', 'T-Attention', 'Account and access'];
const ZH_GROUPS = ['\u4efb\u52a1\u548c\u6587\u4ef6', '\u8bed\u97f3\u548c\u7ffb\u8bd1', '\u8bbe\u5907', 'T-Attention', '\u8d26\u53f7\u548c\u8bbf\u95ee'];

// The fetch of the page: enough for every group to draw its parts. A linked service and one plain remote engine make the device list a real one.
function mockServer() {
  window.calls = [];
  window.confirm = () => true;
  const links = [{ id: 'l1', name: 'Office Mac', state: 'online', role: 'initiator', peer_url: 'http://10.0.0.2:14002', remote_server_id: 2 }];
  const servers = [
    { id: 2, name: 'Office Mac', base_url: 'http://10.0.0.2:14002', status: 'online', remote_version: '2.109.0', can_rename: true, name_source: 'engine' },
    { id: 3, name: 'Old laptop', base_url: 'http://10.0.0.3:14002', status: 'offline', remote_version: '2.80.0', last_error: 'REMOTE_TIMEOUT' },
  ];
  const routes = {
    '/auth/me': { work_dir: null, effective_work_dir: '/home/t/tasks', access_mode: 'remote', authenticator_bound: true, listen_host: '0.0.0.0' },
    '/api/oss/config': { enabled: false, hasAccessKeySecret: false },
    '/api/translate/config': { provider: 'deepseek', providers: { deepseek: { label: 'DeepSeek', hasApiKey: true, baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' } } },
    '/api/speech/config': { keySource: 'none', region: 'cn', regions: { cn: { label: 'China', endpoint: 'wss://cn.example/ws' } }, language: 'zh', languages: { zh: 'Chinese' }, model: 'asr-1', noiseThreshold: null, hotwords: '', vocabularyId: '', endpoint: '' },
    '/api/remote-servers': servers,
    '/api/service-links': { supported: true, links },
    '/api/system/version': { app_version: '2.109.0', boot_id: 'b1', restart: { supported: true } },
    '/api/system/engine-name': { name: 'Home Mac', default_name: 'home-mac', custom: true },
    '/api/peer-fs/settings': { enabled: false },
    '/api/rule-sync': { role: 'off', codex: false, local_changes: [], targets: [], claude_md_path: '~/.claude/CLAUDE.md', import_line: '@shared.md' },
    '/api/remote-tokens': [{ id: 5, name: 'laptop', token_prefix: 'tae_ab', scopes: 'engine' }],
    '/api/attention/tokens': { tokens: [] },
    '/api/attention/settings/summary': { enabled: false, provider: 'deepseek', model: '', providers: [{ id: 'deepseek', label: 'DeepSeek', hasApiKey: true }] },
  };
  window.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    window.calls.push({ method, url });
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const known = routes[String(url).split('?')[0]];
    if (known && method === 'GET') return reply(known);
    return reply({ error: 'NOT_FOUND' }, 404);
  };
}

async function openPage(browser, { width, zh = false, scale = 1 }) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: scale });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://app.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://app.test/');
  if (zh) await page.evaluate(() => localStorage.setItem('ta-lang', 'zh'));
  await page.addStyleTag({ content: read('public/css/h5.css') });
  await page.evaluate(mockServer);
  for (const file of ['public/js/i18n.js', 'public/js/i18n-zh-ui.js', 'public/js/i18n-zh-server.js', 'public/js/i18n-zh-extra.js', 'public/js/h5-shell.js']) await page.addScriptTag({ content: read(file) });
  return { context, page, errors };
}

const settled = page => page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity));

async function openSheet(page, target = null) {
  await page.evaluate(next => window.H5UI.set({ settingsOpen: true, settingsTarget: next }), target);
  await page.locator('#h5-settings .h5-settings-body').waitFor({ state: 'visible' });
  await settled(page);
}
async function closeSheet(page) {
  await page.evaluate(() => window.H5UI.set({ settingsOpen: false }));
  await page.locator('#h5-settings').waitFor({ state: 'detached' }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('#h5-settings .h5-settings-body'));
}
async function openGroup(page, id) {
  const summary = page.locator(`#h5-set-${id} .MuiAccordionSummary-root`);
  await summary.scrollIntoViewIfNeeded();
  await summary.tap();
  await page.waitForFunction(groupId => Boolean(document.querySelector(`#h5-set-${groupId} > .MuiCollapse-entered`)), id);
  await settled(page);
}
const expandedGroups = page => page.evaluate(() => [...document.querySelectorAll('#h5-settings .h5-setting-group')].filter(group => group.querySelector('.MuiAccordionSummary-root').getAttribute('aria-expanded') === 'true').map(group => group.id));

// Nothing in the sheet is wider than the screen, and every visible button, switch label and group header is at least 44px high (touch).
async function assertFits(page, label) {
  const result = await page.evaluate(() => {
    const sheet = document.querySelector('#h5-settings .h5-sheet-panel');
    const inner = document.documentElement.clientWidth;
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const outside = [...sheet.querySelectorAll('*')].filter(visible).filter(el => { const r = el.getBoundingClientRect(); return r.right > inner + 0.5 || r.left < -0.5; }).map(el => el.id || String(el.className).slice(0, 60) || el.tagName);
    const small = [...sheet.querySelectorAll('button, [role="button"], .MuiAccordionSummary-root')].filter(visible).filter(el => !el.closest('.MuiSwitch-root, .MuiCheckbox-root, .MuiRadio-root'))
      .map(el => ({ id: el.id || el.textContent.trim().slice(0, 40) || String(el.className).slice(0, 40), height: el.getBoundingClientRect().height })).filter(item => item.height < 43.5);
    return { outside, small, scroll: document.documentElement.scrollWidth - innerWidth, input: document.documentElement.dataset.input };
  });
  assert.deepEqual(result.outside, [], `${label}: nothing is wider than the screen`);
  assert.ok(result.scroll <= 0, `${label}: no horizontal page scroll`);
  assert.equal(result.input, 'touch', `${label}: the page is in touch mode`);
  assert.deepEqual(result.small, [], `${label}: every button is a 44px touch target`);
}

async function testLayout(browser, width) {
  const { context, page, errors } = await openPage(browser, { width });
  await openSheet(page);
  // Top to bottom: Language, the five groups, Log out.
  assert.deepEqual(await page.locator('#h5-settings .h5-settings-body > * .h5-setting-label, #h5-settings .h5-settings-body > .h5-setting-row .h5-setting-label').allTextContents(), ['Language', ...GROUPS, 'Log out']);
  assert.deepEqual(await expandedGroups(page), [], 'every group starts folded');
  await assertFits(page, `${width} folded`);

  // The parts of each group, in order.
  await openGroup(page, 'tasks-files');
  assert.deepEqual(await page.locator('#h5-set-tasks-files .h5-setting-subheading').allTextContents(), ['Working directory', 'Image and file upload']);
  await page.locator('#h5-workdir').waitFor();
  await assertFits(page, `${width} Tasks and files`);
  await openGroup(page, 'voice-translate');
  assert.deepEqual(await page.locator('#h5-set-voice-translate .h5-setting-subheading').allTextContents(), ['Voice input', 'Translation']);
  await page.waitForFunction(() => document.getElementById('h5-tr-model').value === 'deepseek-chat');
  await assertFits(page, `${width} Voice and translation`);

  // Devices: the list (this machine first), Link a device, the file access switch, Rules and skills sync, then Advanced (folded).
  await openGroup(page, 'devices');
  await page.waitForFunction(() => document.querySelectorAll('#h5-engine-list .h5-engine-row').length === 3 && document.querySelector('.h5-link-row'));
  await page.locator('#h5-rule-sync-role').waitFor();
  assert.deepEqual(await page.locator('#h5-engine-list .h5-engine-row').evaluateAll(rows => rows.map(row => row.dataset.engine)), ['local', '2', '3']);
  const parts = await page.evaluate(() => [...document.querySelectorAll('#h5-set-devices .MuiAccordionDetails-root > *')].filter(el => !el.hidden && el.getBoundingClientRect().height > 0).map(el => el.id).filter(Boolean));
  assert.deepEqual(parts, ['h5-engine-list', 'h5-sec-link', 'h5-sec-peer-fs', 'h5-sec-rule-sync', 'h5-sec-advanced']);
  assert.deepEqual(await page.locator('#h5-set-devices h3.h5-setting-subheading').allTextContents(), ['Link a device', 'Rules and skills sync', 'Advanced']);
  assert.equal(await page.locator('#h5-peer-fs').innerText().then(text => text.split('\n')[0]), 'Sessions can read files on linked devices');
  assert.equal(await page.getAttribute('#h5-devices-advanced-toggle', 'aria-expanded'), 'false', 'Advanced is folded by default');
  assert.equal(await page.locator('#h5-engine-connect-open').isVisible(), false);
  assert.equal(await page.locator('#h5-token-create').isVisible(), false);
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.url === '/api/remote-tokens').length), 0, 'the remote access list is not read while Advanced is folded');
  assert.equal(await page.locator('#h5-set-devices .h5-engine-row[data-engine="3"] .h5-engine-edit').count(), 1, 'a plain remote row keeps Edit connection');
  assert.equal(await page.locator('#h5-set-devices .h5-engine-row[data-engine="2"] .h5-engine-edit').count(), 0, 'a linked row has none');
  await assertFits(page, `${width} Devices`);
  // Advanced unfolds: the one-line explanation, Connect a remote engine, and Let other clients connect to this one.
  await page.locator('#h5-devices-advanced-toggle').scrollIntoViewIfNeeded();
  await page.locator('#h5-devices-advanced-toggle').tap();
  await page.waitForSelector('.h5-token-row');
  await settled(page);
  assert.equal(await page.getAttribute('#h5-devices-advanced-toggle', 'aria-expanded'), 'true');
  assert.deepEqual(await page.locator('#h5-devices-advanced h4.h5-setting-subheading').allTextContents(), ['Connect a remote engine', 'Let other clients connect to this one']);
  assert.match(await page.locator('#h5-devices-advanced-hint').innerText(), /recommended way/);
  assert.equal(await page.locator('#h5-engine-connect-open').isVisible(), true);
  assert.equal(await page.locator('#h5-remote-origin').textContent(), 'http://app.test');
  await assertFits(page, `${width} Advanced`);
  // The connect form still opens from there.
  await page.locator('#h5-engine-connect-open').tap();
  await page.locator('#h5-engine-connect').waitFor();
  await page.locator('#h5-engine-connect-cancel').tap();
  await page.locator('#h5-engine-connect').waitFor({ state: 'detached' });

  // T-Attention: the guide, the reminders, the plugins, the agent skill, the AI summary, the CLI tokens.
  await openGroup(page, 'attention');
  const order = await page.evaluate(() => [...document.querySelectorAll('#h5-set-attention .MuiAccordionDetails-root > *')].map(el => (el.dataset.slot ? `slot:${el.dataset.slot}` : el.tagName === 'H3' ? el.textContent : '')).filter(Boolean));
  const at = name => order.indexOf(name);
  assert.ok(at('Reminders on this device') >= 0 && at('AI summary') > at('Reminders on this device') && at('CLI tokens') > at('AI summary'), `T-Attention order: ${order}`);
  for (const slot of order.filter(item => item.startsWith('slot:'))) assert.ok(at(slot) > at('Reminders on this device') && at(slot) < at('AI summary'), `the slots sit between the reminders and the AI summary: ${order}`);
  if (order.includes('slot:plugins') && order.includes('slot:skill')) assert.ok(at('slot:plugins') < at('slot:skill'), 'the plugins come before the agent skill');

  await openGroup(page, 'account');
  assert.deepEqual(await page.locator('#h5-set-account .h5-setting-subheading').allTextContents(), ['Access mode', 'Authenticator']);
  await assertFits(page, `${width} Account and access`);
  assert.deepEqual(errors, []);
  await context.close();
}

// Every old group id (and the new ids) opens the group and part that took its place; the parts inside Advanced unfold it.
async function testAliases(browser) {
  const { context, page, errors } = await openPage(browser, { width: 390 });
  const cases = [
    ['workdir', 'tasks-files', 'workdir'], ['oss', 'tasks-files', 'oss'], ['voice', 'voice-translate', 'voice'], ['translate', 'voice-translate', 'translate'],
    ['engines', 'devices', ''], ['service-links', 'devices', 'link'], ['rule-sync', 'devices', 'rule-sync'], ['peer-fs', 'devices', 'peer-fs'],
    ['remote', 'devices', 'remote'], ['advanced', 'devices', 'advanced'], ['access', 'account', 'access'], ['attention', 'attention', ''],
    ['devices', 'devices', ''], ['account', 'account', ''],
  ];
  let seq = 0;
  for (const [id, group, section] of cases) {
    seq += 1;
    await openSheet(page, { id, seq });
    await page.waitForFunction(groupId => Boolean(document.querySelector(`#h5-set-${groupId} > .MuiCollapse-entered`)), group);
    await settled(page);
    assert.deepEqual(await expandedGroups(page), [`h5-set-${group}`], `${id} opens ${group} only`);
    const advanced = await page.getAttribute('#h5-devices-advanced-toggle', 'aria-expanded').catch(() => null);
    if (group === 'devices') assert.equal(advanced, ['remote', 'advanced'].includes(id) ? 'true' : 'false', `${id}: Advanced`);
    if (section) {
      await page.locator(`#h5-sec-${section}`).waitFor();
      const shown = await page.evaluate(sectionId => {
        const body = document.querySelector('#h5-settings .h5-settings-body').getBoundingClientRect();
        const box = document.getElementById(`h5-sec-${sectionId}`).getBoundingClientRect();
        return box.top >= body.top - 1 && box.top < body.bottom - 20;
      }, section);
      assert.ok(shown, `${id}: the part ${section} is scrolled into view`);
    }
    await closeSheet(page);
  }
  // The target is used once: the sheet opened again without one starts folded.
  await openSheet(page);
  assert.deepEqual(await expandedGroups(page), []);
  await closeSheet(page);
  // An unknown id opens the sheet with every group folded.
  await openSheet(page, { id: 'no-such-group', seq: 99 });
  assert.deepEqual(await expandedGroups(page), []);
  assert.deepEqual(errors, []);
  await context.close();
}

// The screenshots, in a page of their own: an element screenshot drops Chromium's touch emulation, so it would change the checks that follow.
async function takeShots(browser) {
  const { context, page } = await openPage(browser, { width: 390, scale: 3 });
  await openSheet(page);
  await page.screenshot({ path: path.join(SHOTS, 'settings-tidy-folded-390.png') });
  await page.setViewportSize({ width: 390, height: 3400 }); // a tall page, so the open group fits in the sheet without scrolling inside it
  await openGroup(page, 'devices');
  await page.waitForFunction(() => document.querySelectorAll('#h5-engine-list .h5-engine-row').length === 3 && document.querySelector('.h5-link-row') && document.querySelector('#h5-rule-sync-role'));
  await settled(page);
  await page.locator('#h5-set-devices').screenshot({ path: path.join(SHOTS, 'settings-tidy-devices-390.png') });
  await page.locator('#h5-devices-advanced-toggle').scrollIntoViewIfNeeded();
  await page.locator('#h5-devices-advanced-toggle').click();
  await page.waitForSelector('.h5-token-row');
  await settled(page);
  await page.locator('#h5-sec-advanced').screenshot({ path: path.join(SHOTS, 'settings-tidy-advanced-390.png') });
  await context.close();
}

async function testChinese(browser) {
  const { context, page, errors } = await openPage(browser, { width: 320, zh: true });
  assert.equal(await page.evaluate(() => I18n.get()), 'zh');
  await openSheet(page);
  assert.deepEqual(await page.locator('.h5-setting-group .MuiAccordionSummary-content').allTextContents(), ZH_GROUPS);
  await openGroup(page, 'devices');
  await page.locator('#h5-rule-sync-role').waitFor();
  assert.deepEqual(await page.locator('#h5-set-devices h3.h5-setting-subheading').allTextContents(), ['\u5173\u8054\u8bbe\u5907', '\u89c4\u5219\u548c\u6280\u80fd\u540c\u6b65', '\u9ad8\u7ea7']);
  await page.locator('#h5-devices-advanced-toggle').tap();
  await page.waitForSelector('.h5-token-row');
  await settled(page);
  assert.deepEqual(await page.locator('#h5-devices-advanced h4.h5-setting-subheading').allTextContents(), ['\u8fde\u63a5\u8fdc\u7a0b\u5f15\u64ce', '\u8ba9\u5176\u4ed6\u5ba2\u6237\u7aef\u8fde\u63a5\u5230\u8fd9\u53f0']);
  await assertFits(page, 'Chinese 320 Devices');
  assert.deepEqual(errors, []);
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await testLayout(browser, 390);
    await testLayout(browser, 320);
    await testAliases(browser);
    await testChinese(browser);
    if (SHOTS) await takeShots(browser);
    console.log('h5 settings layout: ok');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
