// Browser test of the scope labels of the settings sheet (scripts/h5-shell/ScopeLabel.jsx, settings-sync.mjs) in real Chromium, with the server mocked
// (GET /api/settings-sync, POST /api/settings-sync/now and the routes every group reads):
// - phone 390: every part of every group carries the right label ("Shared across devices", "This device only", Telegram's one sender), in order;
//   the details line of a shared part that waits for a device or was changed on another one; the "Settings sync" status line at the top of Devices
//   with "Sync now"; after a shared save "Copied to linked devices", or "Will be copied when K02 is online" for an offline device; nothing wider than the screen.
// - phone 320: the same parts fit (the labels wrap under their headings).
// - no linked device, and an older server (404): no label and no status line.
// - computer 1440: the labels sit on the heading line.
// - Chinese 390: the labels and the status line are translated.
// H5_SHOT_DIR=<dir> saves 390px (3x) screenshots of Tasks and files, T-Attention and Devices with the labels.
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

// `sync`: 'linked' (two peers), 'alone' (supported, no peer) or 'missing' (404).
function mockServer({ sync, scopes }) {
  window.calls = [];
  window.confirm = () => true;
  const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
  window.sync = sync === 'missing' ? null : {
    supported: true, scopes,
    keys: [
      { key: 'translate', scope: 'shared', updated_at: ago(5), updated_by_name: 'K01', synced_peers: ['K01', 'K02'], pending_peers: [] },
      { key: 'oss', scope: 'shared', updated_at: ago(1), updated_by_name: 'Home Mac', synced_peers: ['K01'], pending_peers: ['K02'] },
      { key: 'voice', scope: 'shared', updated_at: ago(30), updated_by_name: 'Home Mac', synced_peers: ['K01', 'K02'], pending_peers: [] },
    ],
    peers: sync === 'alone' ? [] : [
      { name: 'K01', online: true, supported: true, last_sync_at: ago(2), last_error: null },
      { name: 'K02', online: false, supported: true, last_sync_at: ago(90), last_error: 'REMOTE_TIMEOUT' },
    ],
  };
  // A shared save: the key changes, waits for `pending` and, for an online device, is copied after `reads` more reads of the route.
  window.afterSave = { translate: { pending: ['K01'], reads: 1 }, voice: { pending: ['K02'], reads: Infinity } };
  const saved = key => {
    const plan = window.afterSave[key];
    if (!window.sync || !plan) return;
    const entry = window.sync.keys.find(item => item.key === key);
    Object.assign(entry, { updated_at: new Date().toISOString(), updated_by_name: 'Home Mac', pending_peers: [...plan.pending] });
    window.pendingReads = { ...(window.pendingReads || {}), [key]: plan.reads };
  };
  const servers = [{ id: 2, name: 'K01', base_url: 'http://10.0.0.2:14002', status: 'online', remote_version: '2.116.0', can_rename: true, name_source: 'engine' }];
  const routes = {
    '/auth/me': { work_dir: null, effective_work_dir: '/home/t/tasks', access_mode: 'remote', authenticator_bound: true, listen_host: '0.0.0.0' },
    '/api/oss/config': { enabled: false, hasAccessKeySecret: false },
    '/api/oss/agent-access': { enabled: true },
    '/api/agent-skills': { skills: ['t-attention', 'tcli'].map(name => ({ name, description: `The ${name} skill.`, claude: { installed: true, current: true, conflict: null, path: `/home/t/.claude/skills/${name}/SKILL.md` }, codex: { installed: false, current: false, conflict: null, path: `/home/t/.codex/skills/${name}/SKILL.md` } })), old_task_tracker: { claude: false, codex: false }, user: null },
    '/api/translate/config': { provider: 'deepseek', providers: { deepseek: { label: 'DeepSeek', hasApiKey: true, baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' } } },
    '/api/speech/config': { keySource: 'saved', region: 'cn', regions: { cn: { label: 'China', endpoint: 'wss://cn.example/ws' } }, language: 'zh', languages: { zh: 'Chinese' }, model: 'asr-1', noiseThreshold: null, hotwords: '', vocabularyId: '', endpoint: '' },
    '/api/remote-servers': servers,
    '/api/service-links': { supported: true, links: [{ id: 'l1', name: 'K01', state: 'online', role: 'initiator', peer_url: 'http://10.0.0.2:14002', remote_server_id: 2 }] },
    '/api/system/version': { app_version: '2.116.0', boot_id: 'b1' },
    '/api/system/engine-name': { name: 'Home Mac', default_name: 'home-mac', custom: true },
    '/api/peer-fs/settings': { enabled: false },
    '/api/rule-sync': { role: 'off', codex: false, local_changes: [], targets: [], claude_md_path: '~/.claude/CLAUDE.md', import_line: '@shared.md' },
    '/api/attention/tokens': { tokens: [] },
    '/api/attention/settings/summary': { enabled: false, provider: 'deepseek', model: '', providers: [{ id: 'deepseek', label: 'DeepSeek', hasApiKey: true }] },
    '/api/attention/settings/guide': { dismissed: true, pageOnly: false, paired: false, tested: false, updatedAt: null },
    '/api/attention/plugins': { listeners: [], notifiers: [{ name: 'telegram', version: '1.0.0', description: 'Telegram', loaded: true, error: null, enabled: true, configured: true, summary: 'Logged in as Account One', statuses: {}, settings: true, test: true, customUi: 'telegram' }] },
    '/api/attention/widget/settings': { enabled: true, language: 'auto', platform_supported: true, swiftc: true, running: true, building: false, last_error: null },
    '/api/attention/market': { plugins: [] },
    '/api/attention-notify/config': { rules: { statuses: ['review'], modes: {}, callDelayMinutes: 0, quietHours: { enabled: false, start: '22:00', end: '08:00', timeZone: '' }, rateLimit: { message: 20, call: 6 }, publicUrl: '' }, statuses: ['review'], modes: ['message', 'call', 'off'], notifiers: [{ name: 'telegram', label: 'Telegram', configFields: [], status: { loggedIn: true, step: 'done' } }], recent: [] },
  };
  window.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    const pathname = String(url).split('?')[0];
    window.calls.push({ method, url: pathname });
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (pathname === '/api/settings-sync') {
      if (!window.sync) return reply({ error: 'NOT_FOUND' }, 404);
      for (const [key, left] of Object.entries(window.pendingReads || {})) {
        if (left <= 0) { window.sync.keys.find(item => item.key === key).pending_peers = []; delete window.pendingReads[key]; } else window.pendingReads[key] = left - 1;
      }
      return reply(window.sync);
    }
    if (pathname === '/api/settings-sync/now' && method === 'POST') { if (!window.sync) return reply({ error: 'NOT_FOUND' }, 404); window.sync.peers[0].last_sync_at = new Date().toISOString(); return reply({ ok: true }); }
    if (method === 'PUT' && pathname === '/api/translate/config') saved('translate');
    if (method === 'PUT' && pathname === '/api/speech/config') saved('voice');
    const known = routes[pathname];
    if (known && (method === 'GET' || method === 'PUT')) return reply(known);
    return reply({ error: 'NOT_FOUND' }, 404);
  };
}

async function openPage(browser, { width = 390, zh = false, sync = 'linked', wide = false }) {
  const scale = SHOTS && !wide ? 3 : 1;
  const context = await browser.newContext(wide ? { viewport: { width: 1440, height: 900 } } : { viewport: { width, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: scale });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://app.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://app.test/');
  if (zh) await page.evaluate(() => localStorage.setItem('ta-lang', 'zh'));
  await page.addStyleTag({ content: read('public/css/h5.css') });
  const scopes = Object.fromEntries([...SHARED.map(id => [id, 'shared']), ...DEVICE.map(id => [id, 'device']), ['telegram', 'telegram']]);
  await page.evaluate(mockServer, { sync, scopes });
  for (const file of ['public/js/i18n.js', 'public/js/i18n-zh-ui.js', 'public/js/i18n-zh-server.js', 'public/js/i18n-zh-extra.js', 'public/js/h5-shell.js']) await page.addScriptTag({ content: read(file) });
  // Two devices, so the "Show in task list" switches appear (h5.js owns them; mocked here).
  await page.evaluate(() => {
    window.H5UI.set({ hiddenDevices: { supported: true, keys: [] } });
    window.H5UI.actions.setDeviceVisible = async () => {};
  });
  return { context, page, errors, press: locator => (wide ? locator.click() : locator.tap()) };
}

const settled = page => page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity));
async function openSheet(page) {
  await page.evaluate(() => window.H5UI.set({ settingsOpen: true }));
  await page.locator('#h5-settings .h5-settings-body').waitFor({ state: 'visible' });
  await settled(page);
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.url === '/api/settings-sync').length), 0, 'nothing is read until a group opens');
}
async function toggleGroup(page, id, press) {
  const summary = page.locator(`#h5-set-${id} .MuiAccordionSummary-root`);
  await summary.scrollIntoViewIfNeeded();
  const wasOpen = await summary.getAttribute('aria-expanded') === 'true';
  await press(summary);
  await page.waitForFunction(([groupId, open]) => Boolean(document.querySelector(`#h5-set-${groupId} > .MuiCollapse-entered`)) === open, [id, !wasOpen]);
  if (!wasOpen) await page.waitForFunction(() => window.calls.some(call => call.url === '/api/settings-sync'));
  await settled(page);
}
// The labels of a group in page order: "<scope> <text>".
const labelsOf = (page, id) => page.locator(`#h5-set-${id} .h5-scope`).evaluateAll(nodes => nodes.map(node => `${node.dataset.scope} ${node.querySelector('.h5-scope-label').textContent}`));

async function assertFits(page, label) {
  const result = await page.evaluate(() => {
    const sheet = document.querySelector('#h5-settings .h5-sheet-panel');
    const inner = document.documentElement.clientWidth;
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const outside = [...sheet.querySelectorAll('*')].filter(visible).filter(el => { const r = el.getBoundingClientRect(); return r.right > inner + 0.5 || r.left < -0.5; }).map(el => el.id || String(el.className).slice(0, 60) || el.tagName);
    // A label never sticks out of its part, and wraps rather than being cut.
    const cut = [...sheet.querySelectorAll('.h5-scope-label')].filter(visible).filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent);
    return { outside, cut, scroll: document.documentElement.scrollWidth - innerWidth };
  });
  assert.deepEqual(result.outside, [], `${label}: nothing is wider than the screen`);
  assert.deepEqual(result.cut, [], `${label}: no label is cut`);
  assert.ok(result.scroll <= 0, `${label}: no horizontal page scroll`);
}

const TASKS = ['device This device only', 'shared Shared across devices', 'shared Shared across devices', 'device This device only'];
const VOICE = ['shared Shared across devices', 'shared Shared across devices'];
const DEVICES = ['device Device names: This device only', 'shared Show in task list: Shared across devices', 'device This device only', 'device This device only', 'device This device only', 'device This device only'];
const ATTENTION = [
  'device Setup guide: This device only', 'device This device only', 'device This device only', 'shared Shared across devices', 'telegram Telegram: one device sends',
  'shared Shared across devices', 'device On or off: This device only', 'shared Window language: Shared across devices', 'shared Shared across devices', 'device This device only',
];
const ACCOUNT = ['device This device only', 'device This device only'];

async function testLinkedPhone(browser) {
  const { context, page, errors, press } = await openPage(browser, { width: 390 });
  await openSheet(page);
  // Tasks and files: Working directory (device), Image and file upload (shared, waiting for K02), the tcli switch (shared), Agent skills (device).
  await toggleGroup(page, 'tasks-files', press);
  await page.waitForFunction(() => document.getElementById('h5-oss-agent-enabled') && document.querySelectorAll('#h5-agent-skills .h5-agent-skill').length === 2);
  assert.deepEqual(await labelsOf(page, 'tasks-files'), TASKS);
  assert.equal(await page.locator('#h5-sec-workdir .h5-scoped-heading [data-setting="workdir"]').count(), 1, 'the label sits on the heading line');
  assert.equal(await page.locator('#h5-sec-oss [data-setting="oss"] .h5-scope-detail').textContent(), 'Waiting to reach K02');
  assert.equal(await page.getAttribute('#h5-sec-oss [data-setting="oss"] .h5-scope-label', 'title'), 'Changes here are copied to every linked device\nWaiting to reach K02');
  assert.equal(await page.getAttribute('#h5-sec-workdir .h5-scope-label', 'title'), 'Only this device uses this');
  assert.deepEqual(await page.locator('#h5-set-tasks-files .h5-setting-subheading').allTextContents(), ['Working directory', 'Image and file upload', 'Agent skills'], 'headings keep their text');
  await assertFits(page, '390 Tasks and files');
  if (SHOTS) { await page.locator('#h5-set-tasks-files').scrollIntoViewIfNeeded(); await page.evaluate(() => document.getElementById('h5-set-tasks-files').scrollIntoView({ block: 'start' })); await settled(page); await page.screenshot({ path: path.join(SHOTS, 'settings-scope-tasks-files-390.png') }); }
  await toggleGroup(page, 'tasks-files', press);

  // Voice and translation: both shared; translation was last changed on K01.
  await toggleGroup(page, 'voice-translate', press);
  await page.waitForFunction(() => document.getElementById('h5-tr-model').value === 'deepseek-chat');
  assert.deepEqual(await labelsOf(page, 'voice-translate'), VOICE);
  assert.equal(await page.locator('#h5-sec-translate .h5-scope-detail').textContent(), 'Changed on K01, 5 min ago');
  assert.equal(await page.locator('#h5-sec-voice .h5-scope-detail').count(), 0, 'a change made on this device is not news');
  // A shared save: Saved, then "Copied to linked devices" once K01 has it.
  await press(page.locator('#h5-tr-save'));
  await page.waitForFunction(() => document.getElementById('h5-tr-feedback').textContent === 'Translation settings saved');
  await page.waitForFunction(() => (document.getElementById('h5-tr-sync') || {}).textContent === 'Copying to linked devices…');
  await page.waitForFunction(() => (document.getElementById('h5-tr-sync') || {}).textContent === 'Copied to linked devices', null, { timeout: 12000 });
  // K02 is offline: the save says it waits for it.
  await press(page.locator('#h5-vi-save'));
  await page.waitForFunction(() => (document.getElementById('h5-vi-sync') || {}).textContent === 'Will be copied when K02 is online', null, { timeout: 12000 });
  assert.equal(await page.locator('#h5-vi-feedback').textContent(), 'Voice input settings saved');
  assert.equal(await page.locator('#h5-sec-voice .h5-scope-detail').textContent(), 'Waiting to reach K02', 'the label follows the new state');
  await assertFits(page, '390 Voice and translation');
  await toggleGroup(page, 'voice-translate', press);

  // Devices: the status line first, then the list, Link a device, the file access switch, Rules and skills sync and Advanced, all this device's own,
  // except which devices the task list shows.
  await toggleGroup(page, 'devices', press);
  await page.waitForFunction(() => document.querySelector('.h5-link-row') && document.getElementById('h5-rule-sync-role') && document.getElementById('h5-peer-fs-enabled'));
  const first = await page.evaluate(() => [...document.querySelectorAll('#h5-set-devices .MuiAccordionDetails-root > *')].find(el => !el.hidden && el.getBoundingClientRect().height > 0).id);
  assert.equal(first, 'h5-sec-settings-sync', 'the status line is at the top of Devices');
  assert.deepEqual(await page.locator('.h5-settings-sync-peer').allInnerTexts(), ['K01 · Online · Synced 2 min ago', 'K02 · Offline · Synced 2 h ago · Error: REMOTE_TIMEOUT']);
  assert.deepEqual(await labelsOf(page, 'devices'), DEVICES);
  assert.equal(await page.locator('#h5-devices-advanced-toggle .h5-scope').count(), 1);
  assert.equal(await page.locator('#h5-peer-fs .h5-scope').count(), 1);
  assert.equal(await page.locator('#h5-sec-link .h5-scoped-heading .h5-scope').count(), 1);
  assert.equal(await page.locator('#h5-sec-rule-sync .h5-scoped-heading .h5-scope').count(), 1);
  const posts = () => page.evaluate(() => window.calls.filter(call => call.url === '/api/settings-sync/now').length);
  assert.equal(await posts(), 0);
  await press(page.locator('#h5-settings-sync-now'));
  await page.waitForFunction(() => document.getElementById('h5-settings-sync-feedback').textContent === 'Synced');
  assert.equal(await posts(), 1);
  await page.waitForFunction(() => /K01 · Online · Synced just now/.test(document.getElementById('h5-settings-sync-peers').innerText));
  await assertFits(page, '390 Devices');
  if (SHOTS) { await page.evaluate(() => document.getElementById('h5-set-devices').scrollIntoView({ block: 'start' })); await settled(page); await page.screenshot({ path: path.join(SHOTS, 'settings-scope-devices-390.png') }); }
  await toggleGroup(page, 'devices', press);

  // T-Attention: the guide, reminders and tokens are this device's own; plugins, rules, the summary and the window language are shared; Telegram is sent through one device.
  await toggleGroup(page, 'attention', press);
  await page.waitForFunction(() => document.querySelector('.h5-plugin-notifier[data-name="telegram"]') && document.getElementById('h5-attention-widget-enabled') && document.getElementById('h5-guide-show'));
  assert.deepEqual(await labelsOf(page, 'attention'), ATTENTION);
  assert.equal(await page.locator('.h5-plugin-notifier[data-name="telegram"] .h5-scope').getAttribute('data-scope'), 'telegram');
  await assertFits(page, '390 T-Attention');
  if (SHOTS) { await page.evaluate(() => document.getElementById('h5-set-attention').scrollIntoView({ block: 'start' })); await settled(page); await page.screenshot({ path: path.join(SHOTS, 'settings-scope-attention-390.png') }); await page.evaluate(() => document.getElementById('h5-attention-widget').scrollIntoView({ block: 'start' })); await settled(page); await page.screenshot({ path: path.join(SHOTS, 'settings-scope-attention-2-390.png') }); }
  // The page of the rules carries the shared label at its top.
  await press(page.locator('#h5-plugins-rules-open'));
  await page.locator('.h5-plugin-page[data-kind="rules"] #h5-notify-save').waitFor();
  assert.equal(await page.locator('.h5-plugin-page[data-kind="rules"] .h5-plugin-page-body > .h5-scope').getAttribute('data-scope'), 'shared');
  await press(page.locator('.h5-plugin-page[data-kind="rules"] .h5-plugin-page-back'));
  await page.locator('.h5-plugin-page').waitFor({ state: 'detached' });
  await toggleGroup(page, 'attention', press);

  await toggleGroup(page, 'account', press);
  assert.deepEqual(await labelsOf(page, 'account'), ACCOUNT);
  assert.deepEqual(errors, []);
  await context.close();
}

async function testNarrow(browser) {
  const { context, page, errors, press } = await openPage(browser, { width: 320 });
  await openSheet(page);
  for (const [id, expected, ready] of [
    ['tasks-files', TASKS, () => document.getElementById('h5-oss-agent-enabled') && document.querySelectorAll('#h5-agent-skills .h5-agent-skill').length === 2],
    ['voice-translate', VOICE, () => document.getElementById('h5-tr-model').value === 'deepseek-chat'],
    ['devices', DEVICES, () => document.querySelector('.h5-link-row') && document.getElementById('h5-rule-sync-role') && document.getElementById('h5-peer-fs-enabled')],
    ['attention', ATTENTION, () => document.querySelector('.h5-plugin-notifier[data-name="telegram"]') && document.getElementById('h5-attention-widget-enabled') && document.getElementById('h5-guide-show')],
    ['account', ACCOUNT, () => document.getElementById('h5-access-title').textContent],
  ]) {
    await toggleGroup(page, id, press);
    await page.waitForFunction(ready);
    assert.deepEqual(await labelsOf(page, id), expected, `320 ${id}`);
    await assertFits(page, `320 ${id}`);
    await toggleGroup(page, id, press);
  }
  assert.deepEqual(errors, []);
  await context.close();
}

async function testHidden(browser, sync) {
  const { context, page, errors, press } = await openPage(browser, { width: 390, sync });
  await openSheet(page);
  for (const id of ['tasks-files', 'voice-translate', 'devices', 'attention', 'account']) await toggleGroup(page, id, press);
  await page.waitForFunction(() => document.querySelector('.h5-link-row') && document.querySelector('.h5-plugin-notifier[data-name="telegram"]') && document.getElementById('h5-attention-widget-enabled'));
  assert.equal(await page.locator('#h5-settings .h5-scope').count(), 0, `${sync}: no label`);
  assert.equal(await page.locator('#h5-sec-settings-sync').count(), 0, `${sync}: no status line`);
  assert.equal(await page.locator('#h5-settings-sync').evaluate(node => node.hidden), true);
  // The page is as before: the Devices parts in their old order.
  const parts = await page.evaluate(() => [...document.querySelectorAll('#h5-set-devices .MuiAccordionDetails-root > *')].filter(el => !el.hidden && el.getBoundingClientRect().height > 0).map(el => el.id).filter(Boolean));
  assert.deepEqual(parts, ['h5-engine-list', 'h5-sec-link', 'h5-sec-peer-fs', 'h5-sec-rule-sync', 'h5-sec-advanced']);
  // A save says Saved and nothing about copying.
  await page.locator('#h5-tr-save').scrollIntoViewIfNeeded();
  await press(page.locator('#h5-tr-save'));
  await page.waitForFunction(() => document.getElementById('h5-tr-feedback').textContent === 'Translation settings saved');
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('#h5-tr-sync').evaluate(node => node.hidden), true);
  assert.deepEqual(errors, []);
  await context.close();
}

async function testDesktop(browser) {
  const { context, page, errors, press } = await openPage(browser, { wide: true });
  await openSheet(page);
  await toggleGroup(page, 'tasks-files', press);
  await page.waitForFunction(() => document.getElementById('h5-oss-agent-enabled'));
  assert.deepEqual(await labelsOf(page, 'tasks-files'), TASKS);
  // On a wide sheet the label is on the same line as its heading.
  const same = await page.evaluate(() => [...document.querySelectorAll('#h5-set-tasks-files .h5-scoped-heading')].every(row => {
    const heading = row.querySelector('.h5-setting-subheading').getBoundingClientRect();
    const label = row.querySelector('.h5-scope-label').getBoundingClientRect();
    return label.left > heading.right - 1 && Math.abs((label.top + label.bottom) / 2 - (heading.top + heading.bottom) / 2) < 6;
  }));
  assert.ok(same, 'labels sit beside their headings');
  assert.deepEqual(errors, []);
  await context.close();
}

async function testChinese(browser) {
  const { context, page, errors, press } = await openPage(browser, { width: 390, zh: true });
  await openSheet(page);
  await toggleGroup(page, 'tasks-files', press);
  await page.waitForFunction(() => document.getElementById('h5-oss-agent-enabled') && document.querySelectorAll('#h5-set-tasks-files .h5-scope').length === 4);
  const texts = await page.locator('#h5-set-tasks-files .h5-scope').allInnerTexts();
  assert.deepEqual(texts.map(text => text.replace(/\s+/g, ' ')), ['\u4ec5\u672c\u673a', '\u6240\u6709\u8bbe\u5907\u5171\u4eab \u7b49\u5f85\u540c\u6b65\u5230 K02', '\u6240\u6709\u8bbe\u5907\u5171\u4eab', '\u4ec5\u672c\u673a']);
  await assertFits(page, 'zh Tasks and files');
  await toggleGroup(page, 'tasks-files', press);
  await toggleGroup(page, 'devices', press);
  await page.waitForFunction(() => document.getElementById('h5-settings-sync-now'));
  const status = await page.locator('#h5-sec-settings-sync').innerText();
  assert.match(status, /\u8bbe\u7f6e\u540c\u6b65/);
  assert.match(status, /\u7acb\u5373\u540c\u6b65/);
  assert.match(status, /K01 · \u5728\u7ebf · \u4e0a\u6b21\u540c\u6b65\uff1a2 \u5206\u949f\u524d/);
  assert.ok(!/Settings sync|Sync now|Online|Offline|Synced/.test(status), status);
  await toggleGroup(page, 'devices', press);
  await toggleGroup(page, 'attention', press);
  await page.waitForFunction(() => document.querySelector('.h5-plugin-notifier[data-name="telegram"] .h5-scope'));
  const telegram = await page.locator('.h5-plugin-notifier[data-name="telegram"] .h5-scope-label').innerText();
  assert.equal(telegram, 'Telegram\uff1a\u7531\u4e00\u53f0\u8bbe\u5907\u53d1\u9001');
  const all = (await page.locator('#h5-set-attention .h5-scope').allInnerTexts()).join('\n');
  assert.ok(!/Shared across|This device only|Setup guide|Window language|On or off/.test(all), all);
  await assertFits(page, 'zh T-Attention');
  assert.deepEqual(errors, []);
  await context.close();
}

(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await testLinkedPhone(browser);
    await testNarrow(browser);
    await testHidden(browser, 'alone');
    await testHidden(browser, 'missing');
    await testDesktop(browser);
    await testChinese(browser);
    console.log('h5 settings scope labels browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
