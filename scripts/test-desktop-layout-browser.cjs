const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const mobile of [true, false]) {
      const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 800 }, isMobile: mobile, hasTouch: mobile });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setContent(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, ''));
      await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'public/css/style.css'), 'utf8') });
      assert.equal(Math.round((await page.locator('body').boundingBox()).width), 1280);
      assert.ok(await page.locator('.sidebar').isVisible());
      assert.ok(await page.locator('.content-area').isVisible());
      assert.equal(await page.locator('.mobile-navigation, #btn-client-mode, #mobile-terminal-dialog').count(), 0);
      if (mobile) {
        const initial = await page.evaluate(() => visualViewport.scale);
        assert.ok(initial < 0.5, 'phone initially fits the whole desktop width');
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: initial * 2 });
        assert.ok(await page.evaluate(initial => visualViewport.scale > initial * 1.8, initial));
        assert.equal(Math.round((await page.locator('body').boundingBox()).width), 1280);
        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: initial });
        await page.screenshot({ path: '/private/tmp/t-agent-desktop-on-phone.png' });
      } else {
        await page.setViewportSize({ width: 900, height: 360 });
        assert.equal(Math.round((await page.locator('body').boundingBox()).width), 1280);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth));
        await page.evaluate(() => {
          window.Bookmarks = window.Tasks = window.RemoteTasks = { load: async () => {} };
          window.requests = [];
          window.fetch = async (url, options = {}) => {
            requests.push({ url, ...options });
            return { ok: true, json: async () => url === '/auth/me' ? { work_dir: '/tasks' } : {
              status: 'current', local_version: '2.10.0', check_interval_seconds: 1800, install_type: 'git',
            } };
          };
        });
        await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8') });
        await page.locator('#btn-settings').click();
        const save = await page.locator('#settings-save').boundingBox();
        assert.ok(save.y >= 0 && save.y + save.height <= 360);
        assert.ok(await page.locator('#modal-body').evaluate(el => el.scrollHeight > el.clientHeight));
        await page.locator('#settings-work-dir').fill('/updated-tasks');
        await page.locator('#settings-save').click();
        await page.waitForFunction(() => document.getElementById('modal-overlay').style.display === 'none');
        assert.ok(await page.evaluate(() => requests.some(r => r.url === '/auth/settings' && r.method === 'PUT')));
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('Unified 1280px desktop layout, phone viewport zoom, horizontal overflow and settings save passed.');
  } finally { await browser.close(); }
})();
