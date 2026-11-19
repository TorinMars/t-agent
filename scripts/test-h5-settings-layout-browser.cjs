// Browser test of the layout of the Settings page (scripts/h5-shell/Settings.jsx, Form.jsx, Engines.jsx, settings-target.mjs) in real Chromium, with the
// server mocked. On a computer: the page right of the navigation rail (left = NAV_WIDTH, no backdrop), the group list as a vertical tab list (arrow keys,
// the chosen group's title takes the focus), every group's cards, Escape closing it with the focus back on the opener. On a phone: the group list, then
// one full-screen page per group, left with its back arrow, Escape and the back button. Both: the order of the groups and of the cards, "Advanced" in
// Devices folded with the one-way options inside, the old group ids opening the group and part that took their place, switches for the options that
// take effect at once, the "more" menu of a device row, no horizontal overflow and 44px touch targets at 320 and 390 px, and the Chinese titles.
// H5_SHOT_DIR=<dir> saves screenshots: the phone list, Devices and Advanced at 390px (3x), and Devices at 1440px.
const { chromium } = require('playwright');
const { addShell } = require('./h5-shell-test-script.cjs');
const { openGroup, backToList, groupShown, listedGroups, listedTitles, engineAction, engineActions } = require('./settings-test-helper.cjs');
const { settled } = require('./browser-test-wait.cjs');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const SHOTS = process.env.H5_SHOT_DIR || '';
const html = fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const GROUPS = ['Tasks and files', 'Voice and translation', 'Devices', 'T-Attention', 'Account and access', 'Usage data'];
const ZH_GROUPS = ['\u4efb\u52a1\u548c\u6587\u4ef6', '\u8bed\u97f3\u548c\u7ffb\u8bd1', '\u8bbe\u5907', 'T-Attention', '\u8d26\u53f7\u548c\u8bbf\u95ee', '\u4f7f\u7528\u6570\u636e'];

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
    '/api/oss/agent-access': { enabled: true },
    '/api/agent-skills': { skills: ['t-attention', 'tcli'].map(name => ({ name, description: `The ${name} skill.`, claude: { installed: true, current: true, conflict: null, path: `/home/t/.claude/skills/${name}/SKILL.md` }, codex: { installed: false, current: false, conflict: null, path: `/home/t/.codex/skills/${name}/SKILL.md` } })), old_task_tracker: { claude: false, codex: false }, user: null },
    '/api/browser-ext': { protocol: 1, connected: true, browsers: [{ browser_id: 'br_aaaaaaaaaaaa', name: 'Chrome on macOS', version: '1.0.0', online: true, active: true, browser: { name: 'Chrome' }, last_seen_at: '2026-11-12T10:00:00.000Z' }], extension_dir: '/home/t/t-agent/extensions/chrome', extension_present: true, server_url: 'http://127.0.0.1:3000' },
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
  // A Client that is not the rules source yet: the Codex option is a switch row (saved at once).
  routes['/api/rule-sync'] = { ...routes['/api/rule-sync'], role: 'receive', following: null, received: null };
  window.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    window.calls.push({ method, url });
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const known = routes[String(url).split('?')[0]];
    if (known && method === 'GET') return reply(known);
    return reply({ error: 'NOT_FOUND' }, 404);
  };
}

async function openPage(browser, { width, height = 800, zh = false, scale = 1, touch = true }) {
  const context = await browser.newContext({ viewport: { width, height }, ...(touch ? { hasTouch: true, isMobile: true } : {}), deviceScaleFactor: scale });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://app.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://app.test/');
  if (zh) await page.evaluate(() => localStorage.setItem('ta-lang', 'zh'));
  await page.addStyleTag({ content: read('public/css/h5.css') });
  await page.evaluate(mockServer);
  for (const file of ['public/js/local-keys.js', 'public/js/i18n.js', 'public/js/i18n-zh-ui.js', 'public/js/i18n-zh-server.js', 'public/js/i18n-zh-extra.js']) await page.addScriptTag({ content: read(file) });
  await addShell(page);
  // The actions h5.js registers (it is not loaded here).
  await page.evaluate(() => {
    let seq = 0;
    window.H5UI.actions.openSettings = group => window.H5UI.set({ settingsOpen: true, settingsTarget: typeof group === 'string' && group ? { id: group, seq: ++seq } : null });
    window.H5UI.actions.closeSettings = () => window.H5UI.set({ settingsOpen: false, settingsTarget: null });
  });
  return { context, page, errors };
}

async function openSheet(page, target = null) {
  await page.evaluate(next => window.H5UI.set({ settingsOpen: true, settingsTarget: next }), target);
  await page.locator('#h5-settings').waitFor({ state: 'visible' });
  await settled(page);
}
async function closeSheet(page) {
  await page.evaluate(() => window.H5UI.set({ settingsOpen: false }));
  await page.waitForFunction(() => !document.getElementById('h5-settings') && !document.getElementById('h5-settings-page'));
}
// The group shown now (its id without `h5-set-`), or null: on a phone the group list shows none.
const shownGroup = page => page.evaluate(() => {
  const node = [...document.querySelectorAll('.h5-setting-group')].find(el => !el.hidden);
  if (!node) return null;
  const pageNode = document.getElementById('h5-settings-page');
  if (pageNode && pageNode.contains(node) && pageNode.classList.contains('MuiModal-hidden')) return null;
  return node.dataset.group;
});

// Nothing on the page is wider than the screen, and every visible button, row and switch label is at least 44px high (touch).
async function assertFits(page, label) {
  const result = await page.evaluate(() => {
    const surfaces = [...document.querySelectorAll('#h5-settings .h5-settings-page, #h5-settings-page:not(.MuiModal-hidden) .MuiDialog-paper')];
    const inner = document.documentElement.clientWidth;
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const all = surfaces.flatMap(surface => [...surface.querySelectorAll('*')]);
    const outside = all.filter(visible).filter(el => !el.closest('.MuiTouchRipple-root')).filter(el => { const r = el.getBoundingClientRect(); return r.right > inner + 0.5 || r.left < -0.5; }).map(el => el.id || String(el.className).slice(0, 60) || el.tagName);
    const small = all.filter(el => el.matches('button, [role="button"], .h5-switch-row')).filter(visible).filter(el => !el.closest('.MuiSwitch-root, .MuiCheckbox-root, .MuiRadio-root'))
      .map(el => ({ id: el.id || el.textContent.trim().slice(0, 40) || String(el.className).slice(0, 40), height: el.getBoundingClientRect().height })).filter(item => item.height < 43.5);
    return { outside, small, scroll: document.documentElement.scrollWidth - innerWidth, input: document.documentElement.dataset.input, surfaces: surfaces.length };
  });
  assert.ok(result.surfaces > 0, `${label}: the page is there`);
  assert.deepEqual(result.outside, [], `${label}: nothing is wider than the screen`);
  assert.ok(result.scroll <= 0, `${label}: no horizontal page scroll`);
  assert.equal(result.input, 'touch', `${label}: the page is in touch mode`);
  assert.deepEqual(result.small, [], `${label}: every button is a 44px touch target`);
}

// The cards of the shown group (their ids), in order, leaving out what draws nothing.
const cardsOf = (page, id) => page.evaluate(group => [...document.getElementById(`h5-set-${group}`).children].filter(el => el.tagName !== 'HEADER' && !el.classList.contains('h5-group-description') && !el.hidden && el.getBoundingClientRect().height > 0).map(el => el.id || el.dataset.slot || el.className.split(' ')[0]), id);

// The options that take effect at once are switch rows; a checkbox is only in a form saved with a button, or to pick several items.
async function assertSwitches(page, ids, label) {
  for (const id of ids) {
    const kind = await page.evaluate(inputId => { const input = document.getElementById(inputId); return input ? [Boolean(input.closest('.MuiSwitch-root')), Boolean(input.closest('.h5-switch-row'))] : null; }, id);
    assert.deepEqual(kind, [true, true], `${label}: #${id} is a switch in a switch row`);
  }
}
const CHECKBOXES_ALLOWED = ['h5-oss-enabled', 'h5-attention-summary-enabled'];
const checkboxesOf = (page, id) => page.evaluate(group => [...document.querySelectorAll(`#h5-set-${group} .MuiCheckbox-root input`)].map(input => input.id), id);

async function testPhone(browser, width) {
  const { context, page, errors } = await openPage(browser, { width });
  await openSheet(page);
  // The first page: the groups as two-line rows, no group open, Log out at the end.
  assert.deepEqual(await listedTitles(page), GROUPS);
  assert.equal(await shownGroup(page), null, 'the phone starts on the group list');
  assert.equal(await page.locator('#h5-settings-groups .MuiListItemText-secondary').count(), GROUPS.length, 'every row says what its group holds');
  assert.equal(await page.locator('#h5-settings-groups [role="tab"]').count(), 0, 'a list of rows, not tabs, on a phone');
  const box = await page.locator('#h5-settings .MuiDialog-paper').boundingBox();
  assert.deepEqual([box.x, box.y, box.width], [0, 0, width], 'a full-screen page');
  assert.equal(Math.round((await page.locator('#h5-settings .MuiToolbar-root').boundingBox()).height), 56, 'a 56px app bar');
  await assertFits(page, `${width} list`);

  // The cards of each group, in order, each on its own page.
  await openGroup(page, 'tasks-files');
  assert.equal(await page.locator('#h5-settings-page-title').textContent(), 'Tasks and files', 'the app bar names the group');
  assert.deepEqual(await page.locator('#h5-set-tasks-files .h5-setting-subheading').allTextContents(), ['Working directory', 'Image and file upload', 'Agent skills', 'Browser extension', 'Site library']);
  await page.waitForFunction(() => document.querySelectorAll('#h5-agent-skills .h5-agent-skill').length === 2 && document.getElementById('h5-oss-agent-enabled') && document.querySelector('.h5-browser-row'));
  await assertSwitches(page, ['h5-oss-agent-enabled'], 'Tasks and files');
  assert.deepEqual((await checkboxesOf(page, 'tasks-files')).filter(id => !CHECKBOXES_ALLOWED.includes(id)), [], 'no checkbox for an option that takes effect at once');
  await assertFits(page, `${width} Tasks and files`);
  await backToList(page);
  await openGroup(page, 'voice-translate');
  assert.deepEqual(await page.locator('#h5-set-voice-translate .h5-setting-subheading').allTextContents(), ['Voice input', 'Translation']);
  await page.waitForFunction(() => document.getElementById('h5-tr-model').value === 'deepseek-chat');
  await assertFits(page, `${width} Voice and translation`);

  // Devices: the list (this machine first), Link a device, the file access switch, Rules and skills sync, then Advanced (folded).
  await openGroup(page, 'devices');
  await page.waitForFunction(() => document.querySelectorAll('#h5-engine-list .h5-engine-row').length === 3 && document.querySelector('.h5-link-row'));
  await page.locator('#h5-rule-sync-role').waitFor();
  assert.deepEqual(await page.locator('#h5-engine-list .h5-engine-row').evaluateAll(rows => rows.map(row => row.dataset.engine)), ['local', '2', '3']);
  assert.deepEqual(await cardsOf(page, 'devices'), ['h5-sec-engine-name', 'h5-sec-link', 'h5-sec-peer-fs', 'h5-sec-rule-sync', 'h5-sec-advanced']);
  assert.deepEqual(await page.locator('#h5-set-devices h3.h5-setting-subheading').allTextContents(), ['Link a device', 'Rules and skills sync', 'Advanced']);
  assert.equal(await page.locator('#h5-peer-fs .h5-switch-label').textContent(), 'Sessions can read files on linked devices');
  await assertSwitches(page, ['h5-peer-fs-enabled', 'h5-rule-sync-codex'], 'Devices');
  assert.equal(await page.getAttribute('#h5-devices-advanced-toggle', 'aria-expanded'), 'false', 'Advanced is folded by default');
  assert.equal(await page.locator('#h5-engine-connect-open').isVisible(), false);
  assert.equal(await page.locator('#h5-token-create').isVisible(), false);
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.url === '/api/remote-tokens').length), 0, 'the remote access list is not read while Advanced is folded');
  // A device row: its name and status, and one "more" button whose menu holds every other action (a plain remote row keeps Edit connection).
  for (const engine of ['local', '2', '3']) {
    assert.equal(await page.locator(`.h5-engine-row[data-engine="${engine}"] button:not(.MuiSwitch-switchBase):not(#h5-restart)`).count(), 1, `${engine}: one button on the row, "more"`);
  }
  assert.deepEqual(await engineActions(page, '3'), ['h5-engine-check', 'h5-engine-update', 'h5-engine-edit', 'h5-engine-remove']);
  assert.deepEqual(await engineActions(page, '2'), ['h5-engine-rename', 'h5-engine-check', 'h5-engine-update', 'h5-engine-remove'], 'a linked row has no Edit connection');
  assert.deepEqual(await engineActions(page, 'local'), ['h5-engine-rename']);
  await engineAction(page, '3', 'h5-engine-edit');
  await page.locator('#h5-engine-edit [role="dialog"]').waitFor();
  assert.equal(await page.inputValue('#h5-engine-edit-url'), 'http://10.0.0.3');
  await page.locator('#h5-engine-edit-cancel').tap();
  await page.locator('#h5-engine-edit').waitFor({ state: 'detached' });
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

  // T-Attention: the guide, the reminders, the plugins, the pointer to the agent skills, the AI summary, the CLI tokens.
  await openGroup(page, 'attention');
  const order = await page.evaluate(() => [...document.querySelectorAll('#h5-set-attention > *')].map(el => (el.dataset.slot ? `slot:${el.dataset.slot}` : el.tagName === 'SECTION' && el.querySelector('h3') ? el.querySelector('h3').textContent : '')).filter(Boolean));
  const at = name => order.indexOf(name);
  assert.ok(at('Reminders on this device') >= 0 && at('AI summary') > at('Reminders on this device') && at('CLI tokens') > at('AI summary'), `T-Attention order: ${order}`);
  for (const slot of order.filter(item => item.startsWith('slot:'))) assert.ok(at(slot) > at('Reminders on this device') && at(slot) < at('AI summary'), `the slots sit between the reminders and the AI summary: ${order}`);
  if (order.includes('slot:plugins') && order.includes('slot:skill')) assert.ok(at('slot:plugins') < at('slot:skill'), 'the plugins come before the agent skill');
  await assertSwitches(page, ['h5-attention-sound'], 'T-Attention');

  await openGroup(page, 'account');
  assert.deepEqual(await page.locator('#h5-set-account .h5-setting-subheading').allTextContents(), ['Access mode', 'Authenticator']);
  await assertFits(page, `${width} Account and access`);

  // Back: the back arrow, Escape and the phone's back button go from a group's page to the list, then close Settings.
  await backToList(page);
  assert.equal(await shownGroup(page), null);
  assert.equal(await page.locator('#h5-settings-groups').isVisible(), true);
  await openGroup(page, 'voice-translate');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('h5-settings-page').classList.contains('MuiModal-hidden'));
  assert.equal(await page.locator('#h5-settings').isVisible(), true, 'Escape on a group page goes back to the list');
  await settled(page);
  await openGroup(page, 'account');
  await page.waitForTimeout(100); // back.mjs adds the history entry of the new page after the page has drawn it
  await page.goBack();
  await page.waitForFunction(() => document.getElementById('h5-settings-page').classList.contains('MuiModal-hidden'));
  assert.equal(await page.locator('#h5-settings').isVisible(), true, 'the back button goes to the list first');
  assert.equal(await page.evaluate(() => window.H5UI.get().settingsOpen), true);
  await settled(page);
  await page.goBack();
  await page.waitForFunction(() => !window.H5UI.get().settingsOpen);
  assert.equal(new URL(page.url()).pathname, '/', 'the page itself stays');
  assert.deepEqual(errors, []);
  await context.close();
}

// A computer: the page right of the rail, the group list as tabs, a group's cards, keyboard and focus.
async function testWide(browser) {
  const { context, page, errors } = await openPage(browser, { width: 1440, height: 900, touch: false });
  await page.waitForFunction(() => window.H5UI && window.H5UI.get().wide);
  // Opened from a button, as the rail's Settings button does: the focus goes back to it when the page closes.
  await page.evaluate(() => { const button = document.createElement('button'); button.id = 'opener'; button.textContent = 'Settings'; button.style.cssText = 'position:fixed;left:8px;top:300px;z-index:9999'; button.onclick = () => window.H5UI.actions.openSettings(); document.body.append(button); });
  await page.locator('#opener').click();
  await page.locator('#h5-settings').waitFor({ state: 'visible' });
  await settled(page);
  const box = await page.locator('#h5-settings').boundingBox();
  assert.deepEqual([box.x, box.y, box.width, box.height], [72, 0, 1440 - 72, 900], 'the page fills the window to the right of the navigation rail (NAV_WIDTH)');
  assert.equal(await page.locator('.MuiBackdrop-root:visible').count(), 0, 'no backdrop');
  assert.equal(await page.evaluate(() => !document.getElementById('h5-settings').contains(document.elementFromPoint(36, 300))), true, 'the strip of the rail is not covered');
  assert.equal(await page.evaluate(() => Boolean(document.getElementById('h5-root').closest('[aria-hidden="true"], [inert]'))), false, 'what is beside it stays reachable');
  assert.equal(Math.round((await page.locator('#h5-settings .h5-settings-list').boundingBox()).width), 280, 'a 280px group list');
  // The group list is a vertical tab list; the first group is shown and its tab has the focus.
  assert.equal(await page.getAttribute('#h5-settings-groups', 'role'), 'tablist');
  assert.equal(await page.getAttribute('#h5-settings-groups', 'aria-orientation'), 'vertical');
  assert.deepEqual(await listedGroups(page), ['tasks-files', 'voice-translate', 'devices', 'attention', 'account', 'usage-data']);
  assert.equal(await shownGroup(page), 'tasks-files', 'a computer always shows a group');
  assert.equal(await page.getAttribute('#h5-settings-group-tasks-files', 'aria-selected'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'h5-settings-group-tasks-files', 'the focus moves into the page');
  assert.equal(await page.locator('#h5-set-tasks-files-title').textContent(), 'Tasks and files');
  assert.equal(await page.locator('#h5-set-tasks-files .h5-group-description').isVisible(), true, 'a one-line description under the title');
  // Arrow keys move the focus through the list; Enter chooses, and the chosen group's title takes the focus.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'h5-settings-group-devices');
  assert.equal(await shownGroup(page), 'tasks-files', 'moving the focus does not change the group yet');
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'h5-settings-group-usage-data');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'h5-settings-group-tasks-files', 'it wraps around');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'h5-set-attention-title');
  assert.equal(await shownGroup(page), 'attention');
  assert.equal(await page.getAttribute('#h5-settings-group-attention', 'aria-selected'), 'true');
  // Each group shows its cards, at most 720px wide, as elevated cards.
  const expected = {
    'tasks-files': ['Working directory', 'Image and file upload', 'Agent skills', 'Browser extension', 'Site library'],
    'voice-translate': ['Voice input', 'Translation'],
    devices: ['Link a device', 'Rules and skills sync', 'Advanced'],
    account: ['Access mode', 'Authenticator'],
    'usage-data': ['Most used \u00b7 last 30 days', 'Not used in 30 days', 'Data'],
  };
  for (const [id, headings] of Object.entries(expected)) {
    await openGroup(page, id);
    if (id === 'devices') await page.locator('#h5-rule-sync-role').waitFor();
    assert.deepEqual(await page.locator(`#h5-set-${id} h3.h5-setting-subheading`).allTextContents(), headings, `${id}: its cards`);
    const cards = await page.locator(`#h5-set-${id} .h5-setting-card`).evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().height > 0).map(node => ({ width: node.getBoundingClientRect().width, radius: getComputedStyle(node).borderTopLeftRadius, shadow: getComputedStyle(node).boxShadow !== 'none' })));
    assert.ok(cards.length >= headings.length - 1, `${id}: cards`);
    for (const card of cards) {
      assert.ok(card.width <= 720 && card.width > 600, `${id}: a card is at most 720px wide (${card.width})`);
      assert.equal(card.radius, '8px', `${id}: 8px corners`);
      assert.equal(card.shadow, true, `${id}: elevation 1`);
    }
  }
  await assertSwitches(page, [], 'wide');
  if (SHOTS) {
    await openGroup(page, 'devices');
    await page.screenshot({ path: path.join(SHOTS, 'settings-page-devices-1440.png') });
  }
  // Escape closes the page, and the focus goes back to the button that opened it.
  await page.locator('#h5-settings-group-account').focus();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.H5UI.get().settingsOpen);
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'opener');
  // The close button is there too.
  await openSheet(page);
  await page.locator('#h5-close-settings').click();
  await page.waitForFunction(() => !window.H5UI.get().settingsOpen);
  assert.deepEqual(errors, []);
  await context.close();
}

// Every old group id (and the new ids) opens the group and part that took its place; the parts inside Advanced unfold it.
async function testAliases(browser, wide) {
  const { context, page, errors } = await openPage(browser, wide ? { width: 1440, height: 900, touch: false } : { width: 390 });
  const cases = [
    ['workdir', 'tasks-files', 'workdir'], ['oss', 'tasks-files', 'oss'], ['voice', 'voice-translate', 'voice'], ['translate', 'voice-translate', 'translate'],
    ['engines', 'devices', ''], ['service-links', 'devices', 'link'], ['rule-sync', 'devices', 'rule-sync'], ['peer-fs', 'devices', 'peer-fs'],
    ['remote', 'devices', 'remote'], ['advanced', 'devices', 'advanced'], ['access', 'account', 'access'], ['attention', 'attention', ''],
    ['devices', 'devices', ''], ['account', 'account', ''], ['agent-skills', 'tasks-files', 'agent-skills'], ['attention-skill', 'tasks-files', 'agent-skills'], ['browser-ext', 'tasks-files', 'browser-ext'],
  ];
  const label = wide ? 'wide' : 'phone';
  let seq = 0;
  for (const [id, group, section] of cases) {
    seq += 1;
    await openSheet(page, { id, seq });
    await page.waitForFunction(groupId => { const node = document.getElementById(`h5-set-${groupId}`); return node && !node.hidden; }, group);
    if (!wide) await page.waitForFunction(() => !document.getElementById('h5-settings-page').classList.contains('MuiModal-hidden'));
    await settled(page);
    assert.equal(await shownGroup(page), group, `${label}: ${id} opens ${group}`);
    assert.equal(await groupShown(page, group), true);
    const advanced = await page.getAttribute('#h5-devices-advanced-toggle', 'aria-expanded').catch(() => null);
    if (group === 'devices') assert.equal(advanced, ['remote', 'advanced'].includes(id) ? 'true' : 'false', `${label} ${id}: Advanced`);
    if (section) {
      await page.locator(`#h5-sec-${section}`).waitFor();
      await page.waitForTimeout(450); // the second look of the reveal (Form.jsx Group)
      const shown = await page.evaluate(sectionId => {
        const body = [...document.querySelectorAll('.h5-settings-body')].find(el => el.getBoundingClientRect().height > 0).getBoundingClientRect();
        const box = document.getElementById(`h5-sec-${sectionId}`).getBoundingClientRect();
        return box.top >= body.top - 1 && box.top < body.bottom - 20;
      }, section);
      assert.ok(shown, `${label} ${id}: the part ${section} is scrolled into view`);
    }
    await closeSheet(page);
  }
  // The target is used once: the page opened again without one starts as it does without a target.
  await openSheet(page);
  assert.equal(await shownGroup(page), wide ? 'tasks-files' : null);
  await closeSheet(page);
  // An unknown id opens the page as without a target.
  await openSheet(page, { id: 'no-such-group', seq: 99 });
  assert.equal(await shownGroup(page), wide ? 'tasks-files' : null);
  assert.deepEqual(errors, []);
  await context.close();
}

// The screenshots, in a page of their own: an element screenshot drops Chromium's touch emulation, so it would change the checks that follow.
async function takeShots(browser) {
  const { context, page } = await openPage(browser, { width: 390, scale: 3 });
  await openSheet(page);
  await page.screenshot({ path: path.join(SHOTS, 'settings-list-390.png') });
  await openGroup(page, 'devices');
  await page.waitForFunction(() => document.querySelectorAll('#h5-engine-list .h5-engine-row').length === 3 && document.querySelector('.h5-link-row') && document.querySelector('#h5-rule-sync-role'));
  await settled(page);
  await page.screenshot({ path: path.join(SHOTS, 'settings-devices-390.png') });
  await page.locator('#h5-devices-advanced-toggle').scrollIntoViewIfNeeded();
  await page.locator('#h5-devices-advanced-toggle').click();
  await page.waitForSelector('.h5-token-row');
  await settled(page);
  await page.locator('#h5-sec-advanced').screenshot({ path: path.join(SHOTS, 'settings-advanced-390.png') });
  await context.close();
}

async function testChinese(browser) {
  const { context, page, errors } = await openPage(browser, { width: 320, zh: true });
  assert.equal(await page.evaluate(() => I18n.get()), 'zh');
  await openSheet(page);
  assert.deepEqual(await listedTitles(page), ZH_GROUPS);
  await openGroup(page, 'devices');
  await page.locator('#h5-rule-sync-role').waitFor();
  assert.equal(await page.locator('#h5-settings-page-title').textContent(), '\u8bbe\u5907');
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
    await testWide(browser);
    await testPhone(browser, 390);
    await testPhone(browser, 320);
    await testAliases(browser, false);
    await testAliases(browser, true);
    await testChinese(browser);
    if (SHOTS) await takeShots(browser);
    console.log('h5 settings layout: ok');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
