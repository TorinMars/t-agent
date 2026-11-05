// The right edge of the page's terminal (public/h5.html, .h5-terminal > .h5-xterm styled by h5.css) at phone and computer widths: after a scrollbar
// change that xterm's FitAddon does not see (it caches the scrollbar width), TerminalViewport.fit (what h5.js calls) still keeps every column inside
// the visible area, so a wide CJK character in the last columns is drawn whole and the screen never runs past the window.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const [width, fontSize] of [[390, 11], [1280, 13], [1440, 13], [1920, 13]]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setContent('<html lang="zh-CN"><body style="margin:0"><div class="h5-terminal" style="position:fixed;inset:0"></div></body></html>');
      await page.addStyleTag({ path: require.resolve('@xterm/xterm/css/xterm.css') });
      await page.addStyleTag({ path: path.join(root, 'public/css/h5.css') });
      for (const file of [require.resolve('@xterm/xterm'), require.resolve('@xterm/addon-fit'), path.join(root, 'public/js/terminal-viewport.js')]) {
        await page.addScriptTag({ path: file });
      }
      await page.evaluate(async fontSize => {
        window.host = document.createElement('div'); host.className = 'h5-xterm';
        document.querySelector('.h5-terminal').append(host);
        window.term = new Terminal({ fontSize, fontFamily: 'Menlo, Monaco, "Courier New", monospace', scrollback: 5000 });
        window.fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(host); fit.fit();
        await new Promise(done => term.write('output\r\n'.repeat(100), done));
        await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
      }, fontSize);
      // A wider scrollbar than the one FitAddon measured at start: fit() alone now proposes too many columns.
      await page.addStyleTag({ content: '.h5-xterm .xterm-viewport { overflow-y: scroll !important; scrollbar-gutter: stable; } .h5-xterm .xterm-viewport::-webkit-scrollbar { display: block; width: 32px; }' });
      const before = await page.evaluate(() => {
        const viewport = host.querySelector('.xterm-viewport');
        viewport.style.display = 'none';
        void viewport.offsetWidth;
        viewport.style.display = '';
        fit.fit();
        return { screen: host.querySelector(".xterm-screen").clientWidth, viewport: host.querySelector(".xterm-viewport").clientWidth };
      });
      assert.ok(before.screen > before.viewport, `${width}px: the cached scrollbar width overestimates the columns (the case under test)`);
      await page.evaluate(() => TerminalViewport.fit(term, fit, host));
      await page.waitForFunction(() => host.querySelector('.xterm-screen').clientWidth + 2 <= host.querySelector('.xterm-viewport').clientWidth);
      const bounds = await page.evaluate(() => ({ screenRight: host.querySelector('.xterm-screen').getBoundingClientRect().right, windowRight: innerWidth }));
      assert.ok(bounds.screenRight <= bounds.windowRight, `${width}px: the terminal's right edge stays inside the window`);
      const row = await page.evaluate(async () => {
        term.reset();
        await new Promise(done => term.write('x'.repeat(term.cols - 8) + '模式但完\r\nnext', done));
        return { text: term.buffer.active.getLine(0).translateToString(true), lastCharacter: term.buffer.active.getLine(0).getCell(term.cols - 2).getChars() };
      });
      assert.ok(row.text.endsWith('模式但完'), `${width}px: the wide characters stay on the first row`);
      assert.equal(row.lastCharacter, '完', `${width}px: the last wide character sits in the last two columns`);
      await page.evaluate(() => term.dispose());
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('Terminal width: the right edge and a CJK character in the last columns stay visible at 390, 1280, 1440 and 1920 px after a scrollbar change.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
