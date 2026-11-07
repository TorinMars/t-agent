// The right edge of the page's terminal (public/h5.html, .h5-terminal > .h5-xterm styled by h5.css) at phone and computer widths: after a scrollbar
// change that xterm's FitAddon does not see (it caches the scrollbar width), TerminalViewport.fit (what h5.js calls) still keeps every column inside
// the visible area, so a wide CJK character in the last columns is drawn whole and the screen never runs past the window.
// Phones (touch, overlay scrollbars, deviceScaleFactor 2.625 and 3 at 360, 393 and 412 CSS px) and a computer with a classic scrollbar: the columns fill
// the width with less than one cell left on the right. xterm 5.5 takes a 15px scrollbar when it measures 0 (an overlay scrollbar), and FitAddon took that
// off, so a phone lost two or three columns. Repeated fits on an unchanged size never resize the terminal again (one PTY resize per real change).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

// The terminal as the page builds it (h5.css, the vendored xterm and FitAddon, TerminalViewport.fit as h5.js calls it).
async function openTerminal(browser, { fontSize, classic, ...options }) {
  const page = await browser.newPage(options);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div class="h5-terminal" style="position:fixed;inset:0"></div></body></html>');
  await page.addStyleTag({ path: path.join(root, 'public/vendor/xterm/xterm-5.5.0.css') });
  await page.addStyleTag({ path: path.join(root, 'public/css/h5.css') });
  // A classic (always shown) scrollbar, as on Windows or Linux; headless Chromium otherwise draws none (it runs with hidden scrollbars).
  if (classic) await page.addStyleTag({ content: '.h5-xterm .xterm-viewport { scrollbar-gutter: stable; } .h5-xterm .xterm-viewport::-webkit-scrollbar { display: block; width: 15px; } .h5-xterm .xterm-viewport::-webkit-scrollbar-thumb { background: #555; }' });
  for (const file of ['public/vendor/xterm/xterm-5.5.0.js', 'public/vendor/xterm/addon-fit-0.10.0.js', 'public/js/terminal-viewport.js']) {
    await page.addScriptTag({ path: path.join(root, file) });
  }
  await page.evaluate(async fontSize => {
    window.host = document.createElement('div'); host.className = 'h5-xterm';
    document.querySelector('.h5-terminal').append(host);
    window.term = new Terminal({ fontSize, fontFamily: 'Menlo, Monaco, "Courier New", monospace', scrollback: 5000 });
    window.fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(host);
    window.resizes = 0; term.onResize(() => { resizes++; });
    TerminalViewport.fit(term, fit, host);
    await new Promise(done => term.write('output\r\n'.repeat(100), done));
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
  }, fontSize);
  return { page, errors };
}
// What is left on the right of the drawn screen, the cell width, the visible width (the viewport less a real scrollbar) and the last column.
async function measure(page) {
  return page.evaluate(async () => {
    const viewport = host.querySelector('.xterm-viewport');
    const screen = host.querySelector('.xterm-screen').getBoundingClientRect();
    const scrollbar = viewport.offsetWidth - viewport.clientWidth;
    const visibleRight = host.getBoundingClientRect().right - scrollbar;
    term.reset();
    await new Promise(done => term.write('x'.repeat(term.cols - 1) + 'E', done));
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    const span = [...host.querySelectorAll('.xterm-rows > div:first-child span')].at(-1);
    const range = document.createRange(); range.selectNodeContents(span);
    const glyphs = [...range.getClientRects()];
    return { cols: term.cols, cell: screen.width / term.cols, leftover: visibleRight - screen.right, scrollbar, screenRight: screen.right, visibleRight,
      lastRight: glyphs.at(-1).right, text: term.buffer.active.getLine(0).translateToString(true) };
  });
}
async function fillsWidth(browser) {
  const cases = [];
  for (const width of [360, 393, 412]) for (const scale of [2.625, 3]) cases.push({ width, scale, touch: true, fontSize: 11 });
  cases.push({ width: 1280, scale: 1, fontSize: 13, classic: true }, { width: 1440, scale: 2, fontSize: 13, classic: true }, { width: 1440, scale: 2, fontSize: 13 });
  for (const { width, scale, touch = false, fontSize, classic = false } of cases) {
    const label = `${width}px x${scale}${touch ? ' touch' : ' pointer'}${classic ? ' classic scrollbar' : ''}`;
    const { page, errors } = await openTerminal(browser, { viewport: { width, height: 800 }, deviceScaleFactor: scale, isMobile: touch, hasTouch: touch, fontSize, classic });
    const m = await measure(page);
    if (classic) assert.equal(m.scrollbar, 15, `${label}: a classic scrollbar keeps its room on the right`);
    else assert.equal(m.scrollbar, 0, `${label}: an overlay scrollbar takes no room (a phone, macOS)`);
    assert.ok(m.leftover >= -0.05, `${label}: the screen stays inside the visible width (${m.screenRight} <= ${m.visibleRight})`);
    const blank = m.visibleRight - m.lastRight;
    assert.ok(blank < m.cell, `${label}: less than one cell is left blank on the right (${blank.toFixed(2)}px, cell ${m.cell.toFixed(2)}px, ${m.cols} cols)`);
    assert.ok(m.text.endsWith('E') && m.text.length === m.cols, `${label}: the last column holds the last character`);
    // xterm's DOM renderer places the glyphs with letter-spacing, which Chrome keeps in 1/64px steps, so a long row can end up to cols/64 px past
    // the drawn screen (2.5px at 180 columns, the same before this fix; it lands in the 4px margin or on the scrollbar). A phone row stays within 0.5px.
    assert.ok(m.lastRight <= m.visibleRight + Math.max(0.5, m.cols / 64), `${label}: the last character is drawn inside the visible area (${m.lastRight} <= ${m.visibleRight})`);
    const again = await page.evaluate(async () => {
      const before = resizes;
      for (let i = 0; i < 5; i++) { TerminalViewport.fit(term, fit, host); await new Promise(done => requestAnimationFrame(done)); }
      return resizes - before;
    });
    assert.equal(again, 0, `${label}: fitting an unchanged size does not resize the terminal`);
    const narrower = await page.evaluate(async () => {
      const before = resizes;
      host.style.right = '40px';
      await new Promise(done => requestAnimationFrame(done));
      for (let i = 0; i < 3; i++) TerminalViewport.fit(term, fit, host);
      return resizes - before;
    });
    assert.equal(narrower, 1, `${label}: one real size change is one resize`);
    const m2 = await measure(page);
    assert.ok(m2.leftover >= -0.05 && m2.visibleRight - m2.lastRight < m2.cell, `${label}: still full width after the change (${m2.leftover.toFixed(2)}px left)`);
    assert.deepEqual(errors, []);
    await page.close();
  }
}
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
      await page.waitForFunction(() => host.querySelector('.xterm-screen').getBoundingClientRect().width <= host.querySelector('.xterm-viewport').clientWidth + 0.05);
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
    await fillsWidth(browser);
    console.log('Terminal width: the right edge and a CJK character in the last columns stay visible at 390, 1280, 1440 and 1920 px after a scrollbar change; phones at 360, 393 and 412 px (x2.625, x3) and computers fill the width with less than one cell left and resize once per real change.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
