// 右键菜单必须显示在顶部栏之上。引擎标签在顶部栏里，菜单会在顶部栏范围内弹出；
// “已安装应用”模式下顶部栏是 fixed 且 z-index 更高，菜单曾被它盖住上半截。
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
      // 只需要菜单本身：直接复用 app.js 里的 ContextMenu（它在全局作用域里是 const，所以重新取源码执行）。
      await page.evaluate(src => { new Function(`${src}; window.ContextMenu = ContextMenu;`)(); },
        fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8').match(/const ContextMenu = \{[\s\S]*?\n\};/)[0]);

      // 在顶部栏内（右键引擎标签的位置）弹出菜单。
      await page.evaluate(() => ContextMenu.show(240, 24, [{ label: '刷新', action() {} }, { label: '检查更新', action() {} }, { label: '移除连接', danger: true, action() {} }]));
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
