const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="host" style="width:370px;height:500px"></div>');
    await page.addStyleTag({ path: require.resolve('@xterm/xterm/css/xterm.css') });
    await page.addScriptTag({ path: require.resolve('@xterm/xterm') });
    await page.addScriptTag({ path: require.resolve('@xterm/addon-fit') });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../public/js/terminal-viewport.js'), 'utf8') });
    await page.evaluate(async () => {
      window.term = new Terminal({ scrollback: 5000 });
      window.fit = new FitAddon.FitAddon(); term.loadAddon(fit);
      term.open(document.getElementById('host')); fit.fit();
      await new Promise(done => term.write(Array.from({ length: 300 }, (_, i) => `line ${i}\r\n`).join(''), done));
    });
    for (const reading of [false, true]) {
      await page.evaluate(reading => reading ? term.scrollToLine(80) : term.scrollToBottom(), reading);
      for (const height of [250, 500, 280, 480]) {
        const position = await page.evaluate(async height => {
          const host = document.getElementById('host'); host.style.height = `${height}px`;
          TerminalViewport.fit(term, fit, host);
          await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
          return { y: term.buffer.active.viewportY, bottom: term.buffer.active.baseY };
        }, height);
        assert.equal(position.y, reading ? 80 : position.bottom);
      }
    }
    console.log('Real xterm preserves history position and bottom-follow across repeated mobile viewport resizes.');
  } finally { await browser.close(); }
})();
