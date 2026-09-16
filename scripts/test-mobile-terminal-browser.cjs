const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
      .replace(/<link\b[^>]*>/g, '');
    await page.setContent(html);
    for (const file of ['style.css', 'mobile.css']) {
      await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'public/css', file), 'utf8') });
    }
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js/mobile.js'), 'utf8') });
    await page.evaluate(() => {
      ClientMobile.finishStartup();
      ClientMobile.showDetails('Mobile terminal test');
      document.getElementById('content-tabs').style.display = 'flex';
      document.getElementById('content-tabs').addEventListener('click', event => {
        const tab = event.target.closest('[data-tab]');
        if (tab) document.getElementById('terminal-pane').style.display = tab.dataset.tab === 'shell' ? 'flex' : 'none';
      });
    });
    for (const height of [844, 420]) {
      await page.setViewportSize({ width: 390, height });
      await page.locator('[data-tab="shell"]').click();
      await page.waitForFunction(() => document.getElementById('mobile-terminal-dialog').matches(':modal'));
      const bounds = await page.locator('#mobile-terminal-dialog').boundingBox();
      assert.equal(Math.round(bounds.height), height);
      assert.equal(Math.round(bounds.y), 0);
      assert.ok(await page.locator('#mobile-terminal-dialog #terminal-pane').count());
      await page.evaluate(() => document.getElementById('btn-settings').focus());
      assert.notEqual(await page.evaluate(() => document.activeElement.id), 'btn-settings');
      await page.keyboard.press('Escape');
      assert.ok(await page.locator('#mobile-terminal-dialog').evaluate(el => el.open));
      await page.locator('#mobile-terminal-back').click();
      assert.equal(await page.locator('#mobile-terminal-dialog').evaluate(el => el.open), false);
      assert.ok(await page.locator('.content-body > #terminal-pane').count());
    }
    await page.locator('[data-tab="shell"]').click();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForFunction(() => !document.getElementById('mobile-terminal-dialog').open);
    assert.ok(await page.locator('.content-body > #terminal-pane').count());
    assert.deepEqual(errors, []);
    console.log('Mobile dialog: opening, background isolation, short viewport, return and desktop restoration passed.');
  } finally {
    await browser.close();
  }
})();
