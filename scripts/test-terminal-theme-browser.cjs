// Browser test: the terminal, its tab strip and its buttons share one set of colours in every theme, and xterm's own background is the pane's.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');

// [pane, tab strip / bars, buttons] in every theme (the neutral grey of the light and dark themes did not change).
const EXPECTED = {
  light: ['rgb(30, 30, 30)', 'rgb(37, 37, 38)', 'rgb(45, 45, 45)'],
  dark: ['rgb(30, 30, 30)', 'rgb(37, 37, 38)', 'rgb(45, 45, 45)'],
  tech: ['rgb(4, 10, 24)', 'rgb(10, 22, 48)', 'rgb(12, 29, 66)'],
};

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(html);
    for (const file of ['css/style.css', 'css/themes.css']) await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'public', file), 'utf8') });
    await page.addStyleTag({ path: require.resolve('@xterm/xterm/css/xterm.css') });
    for (const file of [path.join(root, 'public/js/theme.js'), require.resolve('@xterm/xterm')]) await page.addScriptTag({ path: file });
    await page.evaluate(() => {
      document.querySelector('#terminal-pane').style.display = 'flex';
      document.querySelector('#xterm-container').innerHTML = '<div id="host" style="height:200px"></div>';
      window.term = new Terminal({ cols: 40, rows: 8, theme: Theme.terminal() });
      term.open(document.getElementById('host'));
      term.write('hello');
    });
    const colors = () => page.evaluate(() => {
      const of = selector => getComputedStyle(document.querySelector(selector)).backgroundColor;
      return {
        pane: of('#terminal-pane'), controls: of('.terminal-controls'), tabs: of('#terminal-tabs'), button: of('#btn-terminal-new'),
        keys: of('#terminal-keys'), translate: of('#terminal-translate'),
        xterm: getComputedStyle(document.querySelector('#host .xterm-viewport')).backgroundColor, fromTheme: Theme.terminal().background,
      };
    });

    for (const theme of ['light', 'dark', 'tech', 'light']) {
      await page.evaluate(name => { Theme.set(name); term.options.theme = Theme.terminal(); }, theme);
      const found = await colors();
      const [pane, chrome, button] = EXPECTED[theme];
      assert.equal(found.pane, pane, `${theme}: the terminal pane`);
      for (const part of ['controls', 'tabs', 'keys', 'translate']) assert.equal(found[part], chrome, `${theme}: ${part} (the tab strip and the bars around the terminal)`);
      assert.equal(found.button, button, `${theme}: the buttons`);
      assert.equal(found.xterm, found.pane, `${theme}: xterm's background is the pane's, never another shade`);
      assert.equal(found.fromTheme.startsWith('#'), true);
    }
    assert.deepEqual(errors, []);
    console.log('Terminal theme: pane, tabs, bars, buttons and xterm share one set of colours in the light, dark and futuristic themes.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
