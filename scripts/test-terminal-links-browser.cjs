// 终端里的链接：Cmd/Ctrl + 点击才打开；普通点击不打开。用和 tasks.js 相同的 xterm 与 WebLinksAddon 配置。
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 300 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<link rel="stylesheet" href="x"><body style="margin:0"><div id="t" style="width:800px;height:200px"></div></body>');
    for (const file of ['xterm/xterm-5.5.0.js', 'xterm/addon-web-links-0.11.0.js']) await page.addScriptTag({ path: path.join(root, 'public/vendor', file) });
    await page.addStyleTag({ path: path.join(root, 'public/vendor/xterm/xterm-5.5.0.css') });
    // 复制 tasks.js 里的注册代码，保证两处一致。
    const registration = fs.readFileSync(path.join(root, 'public/js/tasks.js'), 'utf8').match(/t\.loadAddon\(new WebLinksAddon[\s\S]*?\}\)\);/)[0];
    await page.evaluate(async code => {
      window.opened = [];
      window.open = (...args) => { window.opened.push(args); return null; };
      const t = new Terminal({ fontSize: 13 });
      t.open(document.getElementById('t'));
      new Function('t', code)(t);
      await new Promise(resolve => t.write('see https://example.com/docs?a=1 ok\r\n', resolve));
    }, registration);
    await page.waitForTimeout(200);
    // “see ” 占 4 列，链接从第 5 列开始；取链接中间位置。
    const box = await page.locator('.xterm-screen').boundingBox();
    const cell = box.width / 80;
    const point = { x: box.x + cell * 12, y: box.y + 6 };
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(200);
    await page.mouse.click(point.x, point.y);
    assert.deepEqual(await page.evaluate(() => window.opened), [], 'plain click must not open the link');
    await page.keyboard.down('Meta');
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up('Meta');
    const opened = await page.evaluate(() => window.opened);
    assert.equal(opened.length, 1, 'Cmd+click opens the link');
    assert.equal(opened[0][0], 'https://example.com/docs?a=1');
    assert.match(opened[0][2], /noopener/);
    assert.deepEqual(errors, []);
    console.log('terminal links browser test passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
