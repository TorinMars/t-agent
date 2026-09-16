const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 600 }, isMobile: true, hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.dismiss());
    await page.setContent(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, ''));
    for (const file of ['style.css', 'mobile.css']) {
      await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'public/css', file), 'utf8') });
    }
    await page.evaluate(() => {
      window.Bookmarks = window.Tasks = window.RemoteTasks = { load: async () => {} };
      window.requests = [];
      window.fetch = async (url, options = {}) => {
        requests.push({ url, ...options });
        return { ok: true, json: async () => url === '/auth/me' ? { work_dir: '/tasks' } : {
          status: 'current', local_version: '2.9.6', check_interval_seconds: 1800,
          install_type: 'git', version_url: 'origin/main:VERSION.json',
        } };
      };
    });
    for (const file of ['mobile.js', 'app.js']) {
      await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js', file), 'utf8') });
    }
    const cdp = await page.context().newCDPSession(page);
    for (const height of [600, 360]) {
      await page.setViewportSize({ width: 390, height });
      await page.locator('#btn-settings').click();
      await page.locator('#settings-save').waitFor();
      const save = await page.locator('#settings-save').boundingBox();
      assert.ok(save.y >= 0 && save.y + save.height <= height, 'save stays inside viewport');
      const body = page.locator('#modal-body');
      assert.ok(await body.evaluate(el => el.scrollHeight > el.clientHeight));
      const box = await body.boundingBox();
      const x = box.x + box.width / 2, startY = box.y + box.height - 20;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] });
      for (let i = 1; i <= 8; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: startY - (box.height - 40) * i / 8 }] });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForFunction(() => document.getElementById('modal-body').scrollTop > 0);
      await page.locator('#settings-check-update').click();
      await page.waitForFunction(() => document.getElementById('modal-overlay').style.display === 'none');
      await page.locator('#btn-settings').click();
      await page.locator('#settings-work-dir').fill('/updated-tasks');
      await page.locator('#settings-save').click();
      await page.waitForFunction(() => document.getElementById('modal-overlay').style.display === 'none');
    }
    const requests = await page.evaluate(() => window.requests);
    assert.equal(requests.filter(r => r.url === '/api/system/check-update').length, 2);
    assert.equal(requests.filter(r => r.url === '/auth/settings' && r.method === 'PUT').length, 2);
    assert.deepEqual(errors, []);
    console.log('Settings touch scroll, fixed save button, check-update and save requests passed at 600px and 360px.');
  } finally { await browser.close(); }
})();
