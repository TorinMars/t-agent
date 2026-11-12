// Settings -> T-Attention -> "Desktop window (macOS)" (scripts/h5-shell/AttentionWidgetSettings.jsx) in real Chromium, against a mocked
// /api/attention/widget/settings:
// - phone 390x844 (touch): nothing is read until the group opens; the switch echoes the server (on), the status says Running; turning it off sends
//   PUT { enabled: false } and shows Off; the language select sends PUT { language: 'zh' }; a refused PUT shows the error and what is in effect; while a
//   build runs the status says so and is read again until it ends; a last error is shown; everything fits the screen.
// - computer 1440x900 (mouse): a Mac without the command line tools shows the xcode-select hint; another system shows "Not supported" with the
//   switch and the select disabled; an older server (404) shows nothing.
// - phone 390x844 in Chinese: the texts are translated.
// H5_SHOT_DIR=<dir> saves screenshots (phones at 3x).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const BASE_SETTING = { enabled: true, language: 'auto', platform_supported: true, swiftc: true, running: true, building: false, last_error: null };

async function openPage(browser, { wide = false, chinese = false, model }) {
  const context = await browser.newContext({ viewport: wide ? { width: 1440, height: 900 } : { width: 390, height: 844 }, ...(wide ? {} : { isMobile: true, hasTouch: true }), ...(SHOTS && !wide ? { deviceScaleFactor: 3 } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(language => {
    if (language) localStorage.setItem('ta-lang', language);
    window.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() { this.readyState = 3; } };
    window.WebSocket.OPEN = 1;
    window.EventSource = class extends EventTarget { constructor(url) { super(); this.url = url; } close() {} };
  }, chinese ? 'zh' : null);
  await page.route(`${ORIGIN}/**`, async route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
    if (pathname === '/api/attention/widget/settings') {
      model.calls.push(method === 'PUT' ? `PUT ${request.postData()}` : method);
      if (!model.setting) return json({ error: 'NOT_FOUND', message: 'Not found' }, 404);
      if (method === 'PUT') {
        if (model.failPut) { model.failPut = false; return json({ error: 'VALIDATION_FAILED', message: 'language must be one of: auto, en, zh' }, 400); }
        const body = JSON.parse(request.postData());
        Object.assign(model.setting, body);
        if (body.enabled === false) model.setting.running = false;
        if (body.enabled === true) { model.setting.running = false; model.setting.building = true; }
      } else if (model.setting.building && model.reads++ >= 1) { model.setting.building = false; model.setting.running = true; }
      return json({ ...model.setting });
    }
    if (pathname === '/api/remote-servers') return json([]);
    if (pathname === '/api/service-links') return json({ links: [], supported: true });
    if (pathname === '/api/tasks') return json([{ id: 1, title: 'Alpha', status: 'doing' }]);
    if (pathname === '/api/task-groups') return json([{ key: 'doing', name: 'Doing', sort_order: 1 }]);
    if (/^\/api\/tasks\/\d+\/terminals$/.test(pathname)) return json([]);
    if (pathname === '/auth/me') return json({ work_dir: null, effective_work_dir: '/Users/me/tasks' });
    if (pathname === '/api/attention' && method === 'GET') return json({ items: [], host: 'mac' });
    if (pathname === '/api/attention/plugins') return json({ listeners: [], notifiers: [] });
    if (pathname === '/api/attention/settings/guide') return json({ dismissed: true, pageOnly: false, paired: false, tested: false, updatedAt: null });
    if (pathname === '/api/attention/tokens') return json({ tokens: [] });
    if (pathname === '/api/attention/settings/summary') return json({ enabled: false, provider: 'deepseek', model: '', providers: [] });
    if (pathname === '/api/attention/market') return json({ plugins: [] });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  await page.waitForFunction(() => window.H5UI && window.H5UI.get().sources.length > 0);
  const press = locator => (wide ? locator.click() : locator.tap());
  const settled = () => page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity));
  await page.evaluate(() => window.H5UI.set({ settingsOpen: true }));
  await page.locator('#h5-settings').waitFor({ state: 'visible' });
  await settled();
  const openGroup = async () => {
    const summary = page.locator('#h5-set-attention .MuiAccordionSummary-root');
    await summary.scrollIntoViewIfNeeded();
    await press(summary);
    await page.waitForFunction(() => Boolean(document.querySelector('#h5-set-attention > .MuiCollapse-entered')));
    await settled();
  };
  const closeGroup = async () => {
    await press(page.locator('#h5-set-attention .MuiAccordionSummary-root'));
    await page.waitForFunction(() => !document.querySelector('#h5-set-attention > .MuiCollapse-entered'));
    await settled();
  };
  const status = () => page.locator('#h5-attention-widget-status').innerText();
  const shot = async name => { if (SHOTS) { await page.locator('#h5-attention-widget').scrollIntoViewIfNeeded(); await settled(); await page.screenshot({ path: path.join(SHOTS, `attention-widget-${name}.png`) }); } };
  return { context, page, errors, openGroup, closeGroup, press, status, shot, settled };
}

async function assertFits(page, label) {
  const result = await page.evaluate(() => {
    const scope = document.querySelector('#h5-attention-widget');
    const nodes = [scope, ...scope.querySelectorAll('*')];
    const inner = document.documentElement.clientWidth;
    return { outside: nodes.filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > inner + 0.5 || r.left < -0.5); }).map(el => el.id || String(el.className).slice(0, 60) || el.tagName), scroll: document.documentElement.scrollWidth - innerWidth };
  });
  assert.deepEqual(result.outside, [], `${label}: nothing outside the screen`);
  assert.ok(result.scroll <= 0, `${label}: no sideways scroll`);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    // Phone: running, then off, language, a refused save, on again with a build.
    {
      const model = { setting: { ...BASE_SETTING }, calls: [], reads: 0 };
      const { context, page, errors, openGroup, closeGroup, press, status, shot } = await openPage(browser, { model });
      assert.deepEqual(model.calls, [], 'nothing is read until the group opens');
      await openGroup();
      await page.waitForFunction(() => { const input = document.getElementById('h5-attention-widget-enabled'); return input && !input.disabled && input.checked; });
      assert.equal(await page.getAttribute('#h5-attention-widget-enabled', 'aria-label'), 'Desktop window (macOS)');
      assert.equal(await status(), 'Status: Running');
      assert.equal(await page.inputValue('#h5-attention-widget-language'), 'auto');
      assert.match(await page.locator('#h5-attention-widget').innerText(), /stays above other windows/);
      // The slot sits in the T-Attention group, after the plugins and before the skill pointer.
      const slots = await page.evaluate(() => [...document.querySelectorAll('#h5-set-attention .h5-attention-slot')].map(node => node.dataset.slot));
      assert.ok(slots.indexOf('widget') >= 0 && slots.indexOf('widget') < slots.indexOf('skill'), slots.join(','));
      await assertFits(page, 'phone');
      await shot('phone-running');

      await press(page.locator('#h5-attention-widget-enabled'));
      await page.waitForFunction(() => /Off$/.test(document.getElementById('h5-attention-widget-status').innerText));
      assert.equal(await page.isChecked('#h5-attention-widget-enabled'), false);
      assert.equal(model.calls.at(-1), 'PUT {"enabled":false}');
      assert.equal(await page.locator('#h5-attention-widget-feedback').innerText(), 'Saved');

      await page.selectOption('#h5-attention-widget-language', 'zh');
      await page.waitForFunction(() => window.H5UI && document.getElementById('h5-attention-widget-language').value === 'zh');
      await page.waitForFunction(count => document.getElementById('h5-attention-widget-feedback').innerText === 'Saved', model.calls.length);
      assert.equal(model.calls.at(-1), 'PUT {"language":"zh"}');

      model.failPut = true;
      await page.selectOption('#h5-attention-widget-language', 'en');
      await page.waitForFunction(() => /Failed/.test(document.getElementById('h5-attention-widget-feedback').innerText));
      await page.waitForFunction(() => document.getElementById('h5-attention-widget-language').value === 'zh');
      assert.equal(await page.locator('#h5-attention-widget-feedback').innerText(), 'Failed: VALIDATION_FAILED');

      // On again: a build runs, the status says so and is read again until the window runs.
      model.reads = 0;
      await press(page.locator('#h5-attention-widget-enabled'));
      await page.waitForFunction(() => /Building the window…$/.test(document.getElementById('h5-attention-widget-status').innerText));
      await shot('phone-building');
      await page.waitForFunction(() => /Running$/.test(document.getElementById('h5-attention-widget-status').innerText), null, { timeout: 15000 });
      assert.equal(model.calls.filter(call => call === 'PUT {"enabled":true}').length, 1);

      // A window that stopped: its error is shown.
      model.setting = { ...BASE_SETTING, running: false, last_error: 'The window stopped (exit code 3)' };
      await closeGroup();
      await openGroup(); // read again when opened
      await page.waitForFunction(() => /exit code 3/.test(document.getElementById('h5-attention-widget-status').innerText));
      assert.equal(await status(), 'Status: The window stopped (exit code 3)');
      await assertFits(page, 'phone, error');
      assert.deepEqual(errors, []);
      await context.close();
    }

    // Computer: no command line tools; another system; an older server.
    {
      const model = { setting: { ...BASE_SETTING, swiftc: false, running: false, last_error: 'Xcode command line tools needed: xcode-select --install' }, calls: [], reads: 0 };
      const { context, page, errors, openGroup, status } = await openPage(browser, { wide: true, model });
      await openGroup();
      await page.waitForFunction(() => /xcode-select --install/.test((document.getElementById('h5-attention-widget-status') || {}).innerText || ''));
      assert.equal(await status(), 'Status: Xcode command line tools needed: xcode-select --install');
      assert.equal(await page.isDisabled('#h5-attention-widget-enabled'), false, 'the switch still works (the tools may be installed later)');
      assert.deepEqual(errors, []);
      await context.close();
    }
    {
      const model = { setting: { ...BASE_SETTING, platform_supported: false, swiftc: false, running: false }, calls: [], reads: 0 };
      const { context, page, errors, openGroup, status } = await openPage(browser, { wide: true, model });
      await openGroup();
      await page.waitForFunction(() => Boolean(document.getElementById('h5-attention-widget-status')));
      assert.equal(await status(), 'Status: Not supported on this system');
      assert.equal(await page.isDisabled('#h5-attention-widget-enabled'), true);
      assert.equal(await page.isDisabled('#h5-attention-widget-language'), true);
      assert.deepEqual(errors, []);
      await context.close();
    }
    {
      const model = { setting: null, calls: [], reads: 0 };
      const { context, page, errors, openGroup } = await openPage(browser, { wide: true, model });
      await openGroup();
      await page.waitForFunction(() => window.H5UI && document.querySelector('#h5-set-attention .h5-attention-slot[data-slot="widget"]'));
      await page.waitForFunction(() => { const node = document.getElementById('h5-attention-widget'); return node && node.hidden; });
      assert.deepEqual(model.calls, ['GET']);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // Chinese phone.
    {
      const model = { setting: { ...BASE_SETTING, enabled: false, running: false }, calls: [], reads: 0 };
      const { context, page, errors, openGroup, status, shot } = await openPage(browser, { chinese: true, model });
      await openGroup();
      await page.waitForFunction(() => Boolean(document.getElementById('h5-attention-widget-status')));
      const text = await page.locator('#h5-attention-widget').innerText();
      assert.ok(!/Desktop window|stays above|Window language|Same as this page/.test(text), text);
      assert.match(text, /\u684c\u9762\u6d6e\u7a97/);
      assert.match(await status(), /\u5173\u95ed/);
      const options = await page.locator('#h5-attention-widget-language option').allInnerTexts();
      assert.ok(options.every(option => !/[A-Za-z]{3}/.test(option)), options.join(','));
      await assertFits(page, 'phone, Chinese');
      await shot('phone-zh');
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('h5 attention widget settings browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
