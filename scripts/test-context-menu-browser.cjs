// The context menu must be shown above the top bar. The engine tabs are in the top bar and the menu pops up inside its range;
// in "installed app" mode the top bar is fixed with a higher z-index, and the menu used to be covered by its upper half.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const overlay of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 700 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setContent(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, ''));
      await page.addStyleTag({ path: path.join(root, 'public/css/style.css') });
      if (overlay) {
        // Headless Chrome cannot emulate display-mode; activate the actual app CSS rule.
        await page.evaluate(() => {
          for (const sheet of document.styleSheets) for (const rule of sheet.cssRules) {
            if (rule.media?.mediaText.includes('window-controls-overlay')) rule.media.mediaText = 'all';
          }
        });
      }
      // Only the menu itself is needed: reuse ContextMenu from app.js directly (it is a const in global scope, so fetch the source again and run it).
      await page.evaluate(src => { new Function(`${src}; window.ContextMenu = ContextMenu;`)(); },
        fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8').match(/const ContextMenu = \{[\s\S]*?\n\};/)[0]);

      // Pop the menu up inside the top bar (where an engine tab would be right-clicked).
      await page.evaluate(() => ContextMenu.show(240, 24, [{ label: 'Refresh', action() {} }, { label: 'Check for updates', action() {} }, { label: 'Remove connection', danger: true, action() {} }]));
      await page.waitForTimeout(100);
      const box = await page.locator('#context-menu').boundingBox();
      assert.ok(box.y < 48, `menu overlaps the header area (y=${box.y})`);
      for (const [name, point] of [['top edge', [box.x + 20, box.y + 6]], ['first item', [box.x + 20, box.y + 14]], ['last item', [box.x + 20, box.y + box.height - 8]]]) {
        const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('#context-menu') !== null, point);
        assert.equal(hit, true, `${overlay ? 'overlay' : 'normal'} mode: ${name} of the menu must not be covered by the header`);
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('Context menu browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
