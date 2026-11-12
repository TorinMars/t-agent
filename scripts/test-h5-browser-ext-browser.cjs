// Browser test of Settings → Tasks and files → Browser extension (scripts/h5-shell/BrowserExtSettings.jsx), headless, with the routes mocked: nothing is
// read until the group opens; the empty state; "Pair a browser" shows the code in two groups, the countdown, the steps with the real extension
// folder and the server address (each with Copy), and notices the paired browser; the list row (Online, "Commands go here", the detail line);
// Rename (PATCH) and Remove (DELETE, after a confirmation); the warning when the folder is missing; an older server (404) shows nothing; the
// Chinese page; nothing is wider than a 390px phone.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const DIR = '/home/t/t-agent/extensions/chrome';

async function openPage(browser, { supported = true, present = true, browsers = [], zh = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 }, hasTouch: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://app.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://app.test/');
  await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'public/css/h5.css'), 'utf8') });
  if (zh) {
    await page.evaluate(() => localStorage.setItem('ta-lang', 'zh'));
    for (const file of ['i18n.js', 'i18n-zh-ui.js', 'i18n-zh-server.js']) await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js', file), 'utf8') });
  }
  await page.evaluate(({ supported, present, browsers, DIR }) => {
    window.calls = [];
    window.ext = { supported, present, browsers, codes: 0 };
    window.fetch = async (url, options = {}) => {
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ method, url, body });
      const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/browser-ext')) {
        if (!ext.supported) return new Response('Not found', { status: 404 });
        if (url === '/api/browser-ext' && method === 'GET') {
          return reply({ protocol: 1, connected: ext.browsers.some(item => item.online), browsers: ext.browsers, extension_dir: DIR, extension_present: ext.present, server_url: 'http://127.0.0.1:3000' });
        }
        if (url === '/api/browser-ext/pair-code' && method === 'POST') { ext.codes += 1; return reply({ code: 'ABCD2345', expires_at: new Date(Date.now() + 300000).toISOString(), expires_in_seconds: 300 }); }
        const id = decodeURIComponent(url.split('/').pop());
        const found = ext.browsers.find(item => item.browser_id === id);
        if (!found) return reply({ error: 'BROWSER_NOT_FOUND', message: 'There is no paired browser with this id' }, 404);
        if (method === 'PATCH') { found.name = body.name; return reply(found); }
        if (method === 'DELETE') { ext.browsers = ext.browsers.filter(item => item !== found); return reply({ removed: true, browser_id: id }); }
      }
      if (url === '/api/remote-servers') return reply([]);
      return new Response('Not found', { status: 404 });
    };
  }, { supported, present, browsers, DIR });
  await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js/h5-shell.js'), 'utf8') });
  await page.evaluate(() => window.H5UI.set({ settingsOpen: true }));
  await page.locator('#h5-settings').waitFor({ state: 'visible' });
  const extCalls = () => page.evaluate(() => window.calls.filter(call => call.url.startsWith('/api/browser-ext')));
  const openGroup = async () => {
    await page.locator('#h5-set-tasks-files .MuiAccordionSummary-root').tap();
    await page.waitForFunction(() => Boolean(document.querySelector('#h5-set-tasks-files .MuiCollapse-entered')));
  };
  return { page, errors, extCalls, openGroup };
}

async function assertFits(page, label) {
  const outside = await page.evaluate(() => [...document.querySelectorAll('#h5-sec-browser-ext, #h5-sec-browser-ext *, #h5-browser-pair-dialog .MuiDialog-paper *')].filter(el => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && (box.right > document.documentElement.clientWidth + 0.5 || box.left < -0.5);
  }).map(el => el.id || el.className));
  assert.deepEqual(outside, [], `${label}: nothing is wider than the screen`);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    // Nothing paired yet; pair one.
    {
      const { page, errors, extCalls, openGroup } = await openPage(browser);
      assert.equal((await extCalls()).length, 0, 'nothing is read until the group opens');
      await openGroup();
      await page.locator('#h5-browser-empty').waitFor();
      assert.equal(await page.locator('#h5-sec-browser-ext-title').textContent(), 'Browser extension');
      assert.match(await page.locator('#h5-sec-browser-ext').textContent(), /tcli browser/);
      assert.match(await page.locator('#h5-sec-browser-ext').textContent(), /Cookies, tokens and passwords are hidden/);
      const headings = await page.locator('#h5-set-tasks-files .h5-setting-subheading').allTextContents();
      assert.deepEqual(headings.slice(-3), ['Agent skills', 'Browser extension', 'Site library'], 'the last parts of Tasks and files');
      await assertFits(page, 'empty');

      await page.click('#h5-browser-pair');
      await page.locator('#h5-browser-pair-code').waitFor();
      assert.equal(await page.locator('#h5-browser-pair-code').textContent(), 'ABCD 2345');
      assert.match(await page.locator('#h5-browser-pair-countdown').textContent(), /^Valid for [45]:\d\d$/);
      const steps = await page.locator('#h5-browser-pair-steps li').allTextContents();
      assert.equal(steps.length, 3);
      assert.match(steps[0], /chrome:\/\/extensions/);
      assert.match(steps[0], /Developer mode/);
      assert.match(steps[1], /Load unpacked/);
      assert.equal(await page.locator('#h5-browser-ext-dir').textContent(), DIR, 'the real folder');
      assert.equal(await page.locator('#h5-browser-ext-url').textContent(), 'http://127.0.0.1:3000');
      assert.equal(await page.locator('#h5-browser-ext-missing').count(), 0);
      await page.click('#h5-browser-ext-dir-copy');
      await page.waitForFunction(() => document.getElementById('h5-browser-ext-dir-copy').textContent === 'Copied');
      await assertFits(page, 'pair dialog');
      // The extension uses the code: the dialog notices the new browser.
      await page.evaluate(() => { window.ext.browsers.push({ browser_id: 'br_aaaaaaaaaaaa', name: 'Chrome on macOS', version: '1.0.0', online: true, active: true, browser: { name: 'Chrome' }, last_seen_at: '2026-11-12T10:00:00.000Z' }); });
      await page.locator('#h5-browser-pair-done').waitFor({ timeout: 8000 });
      assert.equal(await page.locator('#h5-browser-pair-done').textContent(), 'Paired: Chrome on macOS');
      await page.click('#h5-browser-pair-close');
      await page.locator('.h5-browser-row').waitFor();
      assert.equal(await page.locator('.h5-browser-name').textContent(), 'Chrome on macOS');
      assert.equal(await page.locator('.h5-browser-state').textContent(), 'Online');
      assert.equal(await page.locator('.h5-browser-active').textContent(), 'Commands go here');
      assert.equal(await page.locator('.h5-browser-detail').textContent(), 'Extension 1.0.0 · Chrome · Connected now');

      // Rename.
      await page.click('.h5-browser-rename');
      await page.locator('#h5-browser-rename-name').waitFor();
      assert.equal(await page.inputValue('#h5-browser-rename-name'), 'Chrome on macOS', 'the name is echoed');
      await page.fill('#h5-browser-rename-name', '');
      await page.click('#h5-browser-rename-save');
      await page.locator('#h5-browser-rename-error').waitFor();
      await page.fill('#h5-browser-rename-name', 'Work Chrome');
      await page.click('#h5-browser-rename-save');
      await page.waitForFunction(() => document.querySelector('.h5-browser-name') && document.querySelector('.h5-browser-name').textContent === 'Work Chrome');
      assert.deepEqual((await extCalls()).filter(call => call.method === 'PATCH').map(call => [call.url, call.body]), [['/api/browser-ext/br_aaaaaaaaaaaa', { name: 'Work Chrome' }]]);

      // Remove, after the confirmation.
      await page.click('.h5-browser-remove');
      await page.locator('#h5-browser-remove-accept').waitFor();
      await page.click('#h5-browser-remove-cancel');
      await page.waitForFunction(() => !document.querySelector('#h5-browser-remove .MuiDialog-paper'));
      assert.equal((await extCalls()).filter(call => call.method === 'DELETE').length, 0, 'Cancel removes nothing');
      await page.click('.h5-browser-remove');
      await page.click('#h5-browser-remove-accept');
      await page.locator('#h5-browser-empty').waitFor();
      assert.deepEqual((await extCalls()).filter(call => call.method === 'DELETE').map(call => call.url), ['/api/browser-ext/br_aaaaaaaaaaaa']);
      assert.equal(await page.locator('#h5-browser-ext-feedback').textContent(), 'Removed');
      assert.deepEqual(errors, []);
      await page.close();
    }

    // An offline browser, and an install without the extension folder.
    {
      const { page, errors, openGroup } = await openPage(browser, { present: false, browsers: [{ browser_id: 'br_b', name: 'Home', version: '1.0.0', online: false, active: false, last_seen_at: '2026-11-10T08:30:00.000Z' }] });
      await openGroup();
      await page.locator('.h5-browser-row').waitFor();
      assert.equal(await page.locator('.h5-browser-state').textContent(), 'Offline');
      assert.equal(await page.locator('.h5-browser-active').count(), 0);
      assert.equal(await page.locator('.h5-browser-detail').textContent(), 'Extension 1.0.0 · Last seen 2026-11-10 08:30');
      await page.click('#h5-browser-pair');
      await page.locator('#h5-browser-ext-missing').waitFor();
      assert.deepEqual(errors, []);
      await page.close();
    }

    // An older server: no part and no error.
    {
      const { page, errors, extCalls, openGroup } = await openPage(browser, { supported: false });
      await openGroup();
      await page.waitForFunction(() => window.calls.some(call => call.url === '/api/browser-ext'));
      await page.waitForFunction(() => { const node = document.getElementById('h5-browser-ext'); return node && node.hidden; });
      assert.equal(await page.locator('#h5-sec-browser-ext').count(), 0);
      assert.equal((await extCalls()).length, 1);
      assert.deepEqual(errors, []);
      await page.close();
    }

    // Chinese.
    {
      const { page, errors, openGroup } = await openPage(browser, { zh: true });
      await openGroup();
      await page.locator('#h5-browser-empty').waitFor();
      const zhText = english => page.evaluate(text => I18n.t(text), english);
      assert.notEqual(await zhText('Browser extension'), 'Browser extension', 'the dictionary has the heading');
      assert.equal(await page.locator('#h5-sec-browser-ext-title').textContent(), await zhText('Browser extension'));
      assert.equal(await page.locator('#h5-browser-pair').textContent(), await zhText('Pair a browser'));
      await page.click('#h5-browser-pair');
      await page.locator('#h5-browser-pair-steps').waitFor();
      assert.match(await page.locator('#h5-browser-pair-steps').textContent(), /chrome:\/\/extensions/);
      assert.doesNotMatch(await page.locator('#h5-browser-pair-steps').textContent(), /Load unpacked/, 'the steps are translated');
      await assertFits(page, 'zh pair dialog');
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('h5 browser extension settings: ok');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
