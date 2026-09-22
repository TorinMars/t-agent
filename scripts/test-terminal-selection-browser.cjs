const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const deviceScaleFactor of [1, 2]) {
      const page = await browser.newPage({ viewport: { width: 1728, height: 917 }, deviceScaleFactor });
      await page.setContent('<html lang="zh-CN"><div id="xterm-container" style="width:1400px;height:700px;margin-left:100px"><div class="xterm-host"></div></div></html>');
      await page.addStyleTag({ path: path.join(root, 'public/css/style.css') });
      await page.addStyleTag({ path: require.resolve('@xterm/xterm/css/xterm.css') });
      await page.addScriptTag({ path: require.resolve('@xterm/xterm') });
      await page.evaluate(() => {
        window.term = new Terminal({ cols: 170, rows: 40, fontSize: 13,
          fontFamily: 'Menlo, Monaco, "Courier New", monospace' });
        term.open(document.querySelector('.xterm-host'));
      });
      for (const alternate of [false, true]) {
        for (const prefix of ['ASCII text '.repeat(8), '中文测试'.repeat(10), '中文，测试。'.repeat(6), '（中文）：测试；'.repeat(5)]) {
          await page.evaluate(async ({ prefix, alternate }) => {
            term.reset();
            await new Promise(done => term.write((alternate ? '\x1b[?1049h' : '') + prefix + '\x1b[36;4mTARGET\x1b[0m tail', done));
            await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
          }, { prefix, alternate });
          const bounds = await page.evaluate(() => {
            const row = document.querySelector('.xterm-rows > div');
            const start = row.textContent.indexOf('TARGET');
            function point(offset) {
              const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
              for (let node; (node = walker.nextNode());) {
                if (offset < node.length) return [node, offset];
                offset -= node.length;
              }
              throw new Error('Text boundary not found');
            }
            const range = document.createRange();
            range.setStart(...point(start)); range.setEnd(...point(start + 6));
            const rect = range.getBoundingClientRect();
            let column = 0;
            const line = term.buffer.active.getLine(0);
            while (line.getCell(column).getChars() !== 'T') column++;
            const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
            return { x: rect.x, end: rect.right, y: rect.y + rect.height / 2,
              expected: screen.x + column * term._core._renderService.dimensions.css.cell.width };
          });
          assert.ok(Math.abs(bounds.x - bounds.expected) < 2,
            `CJK text must stay on the cell grid: drift=${bounds.x - bounds.expected}, prefix=${prefix}`);
          await page.mouse.move(bounds.x + 1, bounds.y);
          await page.mouse.down();
          await page.mouse.move(bounds.end - 1, bounds.y, { steps: 6 });
          await page.mouse.up();
          assert.equal(await page.evaluate(() => term.getSelection()), 'TARGET');
        }
      }
      await page.close();
    }
    console.log('PASS: ASCII/CJK/punctuation mixed text stays aligned; real mouse selection matches in normal/alternate screens at DPR 1 and 2.');
  } finally { await browser.close(); }
})();
