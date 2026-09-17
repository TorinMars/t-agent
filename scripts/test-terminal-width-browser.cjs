const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const width of [1200, 1240, 1280, 1920]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setContent(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, ''));
      await page.addStyleTag({ path: path.join(root, 'public/css/style.css') });
      await page.addStyleTag({ path: require.resolve('@xterm/xterm/css/xterm.css') });
      if (width < 1280) {
        // Headless Chrome cannot emulate display-mode; activate the actual app CSS rule.
        await page.evaluate(() => {
          for (const sheet of document.styleSheets) for (const rule of sheet.cssRules) {
            if (rule.media?.mediaText.includes('display-mode: standalone')) rule.media.mediaText = 'all';
          }
        });
      }

      for (const file of [require.resolve('@xterm/xterm'), require.resolve('@xterm/addon-fit'), path.join(root, 'public/js/terminal-viewport.js'), path.join(root, 'public/js/terminal-clipboard.js')]) {
        await page.addScriptTag({ path: file });
      }
      await page.evaluate(async () => {
        document.getElementById('preview-pane').style.display = 'none';
        document.getElementById('terminal-pane').style.display = 'flex';
        document.getElementById('terminal-tabs').innerHTML = '<button class="terminal-toolbar-btn terminal-tab">终端 1</button><button class="terminal-toolbar-btn terminal-tab">终端 2</button>';
        window.host = document.createElement('div'); host.className = 'xterm-host';
        document.getElementById('xterm-container').append(host);
        window.term = new Terminal({ fontSize: 13, fontFamily: 'Menlo, Monaco, "Courier New", monospace', scrollback: 5000 });
        window.fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(host); fit.fit();
        await new Promise(done => term.write('output\r\n'.repeat(100), done));
        await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
      });
      // Reproduce the cached-scrollbar mismatch before enabling the new observer.
      await page.addStyleTag({ content: '#xterm-container .xterm-viewport::-webkit-scrollbar { width: 32px; }' });
      const before = await page.evaluate(() => {
        const viewport = host.querySelector('.xterm-viewport');
        viewport.style.display = 'none';
        void viewport.offsetWidth;
        viewport.style.display = '';
        fit.fit();
        return { screen: host.querySelector('.xterm-screen').clientWidth, viewport: host.querySelector('.xterm-viewport').clientWidth, cached: term._core.viewport.scrollBarWidth, host: host.clientWidth };
      });
      assert.ok(before.screen > before.viewport, 'cached scrollbar width overestimates columns after scrollbar changes');
      await page.evaluate(() => { window.observer = TerminalViewport.observe(term, fit, host); });
      await page.waitForFunction(() => host.querySelector('.xterm-screen').clientWidth + 2 <= host.querySelector('.xterm-viewport').clientWidth);
      const bounds = await page.evaluate(() => ({
        screenRight: host.querySelector('.xterm-screen').getBoundingClientRect().right,
        windowRight: innerWidth,
      }));
      assert.ok(bounds.screenRight <= bounds.windowRight, 'terminal right edge must remain inside the app window');
      const row = await page.evaluate(async () => {
        term.reset();
        await new Promise(done => term.write('x'.repeat(term.cols - 8) + '模式但完\r\n播已选中连接卡后必须固定使用连接卡 ID', done));
        return { text: term.buffer.active.getLine(0).translateToString(true), lastCharacter: term.buffer.active.getLine(0).getCell(term.cols - 2).getChars() };
      });
      assert.ok(row.text.endsWith('模式但完'));
      assert.equal(row.lastCharacter, '完');
      const tabs = await page.locator('#terminal-tabs').boundingBox();
      const toolbar = await page.locator('.terminal-toolbar').boundingBox();
      const controls = await page.locator('.terminal-controls').boundingBox();
      assert.ok(Math.abs(tabs.y - toolbar.y) < 2);
      assert.ok(Math.abs(tabs.x - controls.x - 8) < 2);
      assert.ok(Math.abs(toolbar.x + toolbar.width - controls.x - controls.width + 8) < 2);
      assert.ok(controls.height <= 40);
      await page.evaluate(() => { observer.disconnect(); term.dispose(); });
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('Right-edge Chinese text visible in 1200px/1240px app windows and 1280px/1920px browsers; scrollbar changes and toolbar layout passed.');
  } finally { await browser.close(); }
})();
