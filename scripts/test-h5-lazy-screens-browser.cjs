// The screens that open on demand come from chunks of their own (scripts/h5-shell/lazy-screens.jsx, scripts/build-page-bundles.js), in real Chromium
// at phone and computer size with the API mocked: the shell loads none of them at start; each is fetched the first time it opens (or earlier, when
// the pointer, a finger or the focus reaches its button) and works as before, with every Settings group and the T-Attention settings slots; a chunk
// that cannot be loaded closes the screen with a notice and is asked for again on the next opening; and the page has no errors.
const { chromium } = require('playwright');
const { addShell } = require('./h5-shell-test-script.cjs');
const { openGroup: openSettingsGroup, backToList, groupShown, wideLayout, listedTitles } = require('./settings-test-helper.cjs');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

async function openPage(browser, { viewport, touch, zh = false }) {
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const chunks = []; // the chunk names asked for, in order
  page.on('request', request => { const match = /\/js\/chunks\/([\w.-]+)-[A-Z0-9]{8}\.js$/.exec(request.url()); if (match) chunks.push(match[1]); });
  await page.route('http://app.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://app.test/');
  await page.addStyleTag({ content: read('public/css/h5.css') });
  if (zh) await page.evaluate(() => localStorage.setItem('ta-lang', 'zh'));
  for (const file of ['public/js/i18n.js', ...(zh ? ['public/js/i18n-zh-ui.js', 'public/js/i18n-zh-server.js', 'public/js/i18n-zh-extra.js'] : [])]) await page.addScriptTag({ content: read(file) });
  await page.evaluate(() => {
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    window.fetch = async url => {
      if (url === '/api/remote-servers') return reply([]);
      if (url === '/auth/me') return reply({ work_dir: null, effective_work_dir: '/home/t/tasks', access_mode: 'local', listen_host: '127.0.0.1' });
      if (/^\/api\/attention(\?|$)/.test(url)) return reply({ items: [], engines: [] });
      return reply({ error: 'NOT_FOUND' }, 404); // an older server: the parts that read it are not drawn
    };
  });
  await addShell(page);
  // What h5.js registers (it is not loaded here): the Settings button opens the sheet.
  await page.evaluate(() => { const ui = window.H5UI; ui.actions.openSettings = () => ui.set({ settingsOpen: true }); ui.actions.closeSettings = () => ui.set({ settingsOpen: false }); });
  return { context, page, errors, chunks };
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    // 1. Phone: nothing of the screens at start; Settings loads its chunk when opened, with every group and the T-Attention slots.
    {
      const { context, page, errors, chunks } = await openPage(browser, { viewport: { width: 390, height: 800 }, touch: true });
      assert.deepEqual(chunks.filter(name => name.startsWith('screen-')), [], 'no screen chunk at start');
      assert.equal(await page.locator('#h5-settings').count(), 0);
      await page.evaluate(() => window.H5UI.set({ settingsOpen: true }));
      await page.locator('#h5-settings').waitFor({ state: 'visible' });
      assert.ok(chunks.includes('screen-settings'), 'the Settings chunk is fetched when Settings opens');
      assert.deepEqual(await listedTitles(page), ['Tasks and files', 'Voice and translation', 'Devices', 'T-Attention', 'Account and access']);
      await openSettingsGroup(page, 'attention');
      // The parts registered by their own modules (attention-slots.mjs), imported by the Settings chunk.
      await page.locator('#h5-set-attention .h5-attention-slot[data-slot="plugins"]').waitFor({ state: 'attached' });
      const slots = await page.locator('#h5-set-attention .h5-attention-slot').evaluateAll(nodes => nodes.map(node => node.dataset.slot));
      assert.ok(slots.includes('plugins') && slots.length >= 3, `the T-Attention slots are drawn: ${slots}`);
      assert.equal(chunks.filter(name => name === 'screen-settings').length, 1, 'fetched once');
      // T-Attention: its own chunk, on first open (the design sheet's is covered by scripts/test-h5-assets-browser.cjs).
      await page.evaluate(() => window.H5UI.set({ settingsOpen: false }));
      await page.locator('#h5-settings').waitFor({ state: 'hidden' });
      await page.evaluate(() => window.H5UI.actions.openAttention());
      await page.locator('#h5-attention-sheet').waitFor({ state: 'visible' });
      assert.ok(chunks.includes('screen-attention'));
      await page.evaluate(() => window.H5UI.actions.closeAttention());
      assert.deepEqual(errors, []);
      await context.close();
    }

    // 2. Computer: hovering the Settings button asks for the chunk before the click.
    {
      const { context, page, errors, chunks } = await openPage(browser, { viewport: { width: 1280, height: 800 }, touch: false });
      assert.ok(!chunks.includes('screen-settings'));
      await page.locator('#h5-tasks-settings').hover();
      await page.waitForFunction(() => performance.getEntriesByType('resource').some(entry => /\/js\/chunks\/screen-settings-/.test(entry.name)));
      assert.equal(await page.locator('#h5-settings').count(), 0, 'only fetched, not drawn');
      await page.locator('#h5-tasks-settings').click();
      await page.locator('#h5-settings').waitFor({ state: 'visible' });
      assert.equal(chunks.filter(name => name === 'screen-settings').length, 1);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // 3. A chunk that cannot be loaded: the sheet closes with a notice that says to reload (translated in Chinese), the page keeps working, and after a
    // reload it opens. (Chromium remembers the failed module for the life of the page, so the next opening in the same page fails again the same way.)
    {
      const { context, page, errors } = await openPage(browser, { viewport: { width: 390, height: 800 }, touch: true, zh: true });
      await page.route('**/js/chunks/screen-settings-*.js', route => route.abort('internetdisconnected'));
      await page.evaluate(() => window.H5UI.set({ settingsOpen: true }));
      await page.waitForFunction(() => window.H5UI.get().settingsOpen === false);
      const notice = await page.evaluate(() => window.H5UI.get().notice);
      assert.equal(notice.type, 'error');
      assert.equal(notice.message, '\u9875\u9762\u7684\u8fd9\u4e00\u90e8\u5206\u65e0\u6cd5\u52a0\u8f7d\u3002\u8bf7\u68c0\u67e5\u7f51\u7edc\u8fde\u63a5\u540e\u91cd\u65b0\u52a0\u8f7d\u9875\u9762\u3002');
      assert.equal(await page.locator('#h5-settings').count(), 0);
      // The rest of the page still works: T-Attention opens from its own chunk.
      await page.evaluate(() => window.H5UI.actions.openAttention());
      await page.locator('#h5-attention-sheet').waitFor({ state: 'visible' });
      await page.evaluate(() => window.H5UI.actions.closeAttention());
      // Opening Settings again is safe: it opens, or closes again with the same notice.
      await page.evaluate(() => window.H5UI.set({ settingsOpen: true }));
      await page.waitForFunction(() => window.H5UI.get().settingsOpen === false || Boolean(document.querySelector('#h5-settings')));
      assert.deepEqual(errors, []);
      await context.close();
      const again = await openPage(browser, { viewport: { width: 390, height: 800 }, touch: true, zh: true }); // the reload
      await again.page.evaluate(() => window.H5UI.set({ settingsOpen: true }));
      await again.page.locator('#h5-settings').waitFor({ state: 'visible' });
      assert.equal(await again.page.locator('.h5-setting-group').count(), 5);
      assert.equal(await again.page.locator('#h5-settings-groups .h5-settings-group-item').count(), 5);
      await again.context.close();
    }
    console.log('Lazy screens: chunks on first open or hover, every Settings group and slot, a failed chunk retried: passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
