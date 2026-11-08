// Touch scrolling and the terminal width of the page's terminal (public/js/terminal-gestures.js, h5.js) in real Chromium.
// Phone (390 x 844, touch, real CDP touches): there is no scrollbar strip; a pan anywhere picks its axis in the first 10px and keeps it; vertical
// pans scroll the normal buffer 1:1 and a flick keeps going; in the alternate buffer they send wheel reports (mouse tracking) or arrows (no mouse
// mode); in Wide mode a sideways pan moves the screen, the cursor is followed after input; the switch in the header toggles Fit / Wide (one tap) and
// its menu (long press) picks 120 / 160 / 200; the PTY gets the columns through the resize message; the copy view shows the wrap hint in Fit mode
// and widens from there; the choice is remembered. Computer (1440 x 900, mouse): Shift+wheel and a sideways wheel move the wide screen, the
// vertical wheel stays xterm's. The server is mocked (no data folder is used). H5_SHOT_DIR=<dir> saves screenshots.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const pageErrors = [];

async function openPage(browser, contextOptions, { storage = null } = {}) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(storage => {
    if (storage && !sessionStorage.getItem('seeded')) { for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value); sessionStorage.setItem('seeded', '1'); }
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
      emit(data) { this.onmessage?.({ data }); }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
  }, storage);
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    if (url.pathname === '/api/remote-servers') return json([]);
    if (url.pathname === '/api/tasks') return json([{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }]);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (url.pathname === '/api/tasks/terminal-activity' || url.pathname === '/api/tasks/terminal-subagents') return json({});
    if (url.pathname === '/api/tasks/1/terminals') return json([{ terminal_id: 'h5-default', title: 'Terminal 1' }]);
    if (/^\/api\/tasks\/\d+\/agent\/conversations$/.test(url.pathname)) return json([]);
    if (url.pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    if (url.pathname === '/api/oss/config') return json({ enabled: false });
    if (url.pathname === '/api/system/check-update' || url.pathname === '/api/system/update-status') return json({ status: 'up_to_date', local_version: '1.0.0' });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  await openTerminal(page);
  return { context, page };
}
async function openTerminal(page) {
  const wide = await page.evaluate(() => innerWidth >= 900);
  if (!wide) {
    await page.locator('#h5-tasks').waitFor({ state: 'visible' });
    await page.locator('.h5-task-item', { hasText: 'Fix login' }).tap();
    await page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main', { hasText: 'Terminal 1' }).tap();
    await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
  } else {
    await page.locator('.h5-task-item', { hasText: 'Fix login' }).click();
    await page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main', { hasText: 'Terminal 1' }).click();
  }
  await page.waitForFunction(() => window.sockets.length > 0 && window.sockets.at(-1).readyState === 1 && document.querySelector('.h5-xterm:not([hidden]) .xterm-rows'));
}

// In-page probes.
const probe = page => page.evaluate(() => {
  const el = document.querySelector('.h5-xterm:not([hidden])');
  const screen = el.querySelector('.xterm-screen');
  const transform = screen.style.transform;
  const ws = window.sockets.at(-1);
  const resizes = ws.sent.map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(item => item && item.type === 'resize');
  const rowsEl = el.querySelectorAll('.xterm-rows > div').length;
  return {
    offset: transform ? -parseFloat(/translateX\((-?[\d.]+)px\)/.exec(transform)[1]) : 0,
    content: screen.offsetWidth, visible: el.clientWidth, wide: el.classList.contains('h5-wide'),
    lineHeight: screen.clientHeight / rowsEl, lastCols: resizes.length ? resizes.at(-1).cols : null, resizes: resizes.length,
    sent: ws.sent.filter(item => !item.startsWith('{')),
  };
});
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const shots = process.env.H5_SHOT_DIR;
  try {
    // ── Phone ──
    {
      const { context, page } = await openPage(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: shots ? 3 : 1 });
      const cdp = await context.newCDPSession(page);
      const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
      // A pan: `steps` moves `ms` apart, then the lift (after `hold` ms of no movement: no momentum).
      const pan = async (x, y, dx, dy, { steps = 8, ms = 16, hold = 150 } = {}) => {
        await touch('touchStart', x, y);
        for (let i = 1; i <= steps; i++) { await touch('touchMove', x + dx * i / steps, y + dy * i / steps); if (ms) await page.waitForTimeout(ms); }
        if (hold) await page.waitForTimeout(hold);
        await touch('touchEnd');
      };
      const emit = data => page.evaluate(data => new Promise(done => { window.sockets.at(-1).emit(data); requestAnimationFrame(() => requestAnimationFrame(done)); }), data);
      assert.equal(await page.locator('#h5-wheel').count(), 0, 'there is no scrollbar strip any more');
      assert.equal(await page.locator('#h5-term-width').getAttribute('aria-pressed'), 'false', 'Fit mode at first');
      assert.equal(await page.locator('#h5-term-width').getAttribute('aria-label'), 'Wide terminal');
      assert.equal(await page.locator('#h5-term-width').getAttribute('title'), 'Wide terminal');
      const fit = await probe(page);
      assert.ok(fit.lastCols > 20 && fit.lastCols < 100, `Fit gives the PTY the columns that fit (${fit.lastCols})`);
      assert.equal(fit.wide, false);
      assert.equal(fit.offset, 0);

      // Normal buffer: 300 lines, at the bottom. A slow pan down (finger down) shows older lines, 1:1 by line height; up shows newer.
      await emit(Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\r\n'));
      const rowsOf = () => page.evaluate(() => [...document.querySelectorAll('.h5-xterm:not([hidden]) .xterm-rows > div')].map(row => row.textContent.trim()));
      const topLine = async () => Number(((await rowsOf())[0].match(/^line (\d+)/) || [])[1] || 0);
      const bottom = await topLine();
      const lh = fit.lineHeight;
      await pan(150, 300, 0, 160);
      const older = await topLine();
      const expected = Math.round(160 / lh);
      assert.ok(Math.abs(bottom - older - expected) <= 1, `a pan down of 160px scrolls back about ${expected} lines (${bottom - older}): one scroller, no double scrolling`);
      await pan(150, 460, 0, -80);
      const newer = await topLine();
      assert.ok(Math.abs(newer - older - Math.round(80 / lh)) <= 1, `a pan up of 80px scrolls forward about ${Math.round(80 / lh)} lines (${newer - older})`);
      await page.waitForTimeout(300);
      assert.equal(await topLine(), newer, 'a slow lift has no momentum');
      // A flick up keeps going after the lift.
      // Back into the history first, far enough that the flick and its momentum never reach the bottom (which would end the momentum early).
      await pan(150, 300, 0, 160);
      await pan(150, 300, 0, 160);
      await pan(150, 300, 0, 160);
      // In-page touch events at a real finger's pace (CDP touches arrive one per rendered frame, which is slow in headless Chromium).
      // 40 px per step: still a flick (over FLICK_MIN 0.3 px/ms) when a busy machine stretches the 16 ms timer to about 100 ms.
      const flick = () => page.evaluate(async () => {
        const el = document.querySelector('.h5-xterm:not([hidden]) .xterm-screen');
        const fire = (type, y) => {
          const point = new Touch({ identifier: 9, target: el, clientX: 150, clientY: y });
          el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [point], targetTouches: type === 'touchend' ? [] : [point], changedTouches: [point] }));
        };
        fire('touchstart', 500);
        for (let i = 1; i <= 6; i++) { await new Promise(done => setTimeout(done, 16)); fire('touchmove', 500 - i * 40); }
        fire('touchend', 260);
      });
      // A headless page can stall more than FLICK_WINDOW (100 ms) between two steps; the lift is then rightly a slow one with no momentum.
      // So the flick gets a second try from further back in the history; one of the two must keep scrolling after the lift.
      let flicked = null;
      for (let attempt = 0; attempt < 2 && !flicked; attempt++) {
        if (attempt) { await pan(150, 300, 0, 160); await pan(150, 300, 0, 160); await page.waitForTimeout(800); }
        const beforeFlick = await topLine();
        await flick();
        const atLift = await topLine();
        await page.waitForTimeout(600);
        const afterFlick = await topLine();
        assert.ok(atLift > beforeFlick, 'the flick scrolls while the finger moves');
        if (afterFlick > atLift) flicked = { atLift, afterFlick };
        else console.log(`flick attempt ${attempt + 1}: no momentum (${atLift} -> ${afterFlick}), page stalled; trying again`);
      }
      assert.ok(flicked, 'a flick keeps scrolling after the lift');
      // Fit mode: a sideways pan moves nothing (the screen fits) and does not scroll vertically either (axis lock).
      // Wait for the flick's momentum to end first, so the line read below is where the view rests.
      // The momentum's slow tail moves one line only every few hundred ms, so the view must stay put for 800 ms.
      for (let last = -1, now = await topLine(), tries = 0; now !== last && tries < 15; tries++) { last = now; await page.waitForTimeout(800); now = await topLine(); }
      const lockedTop = await topLine();
      await pan(200, 300, -120, 30);
      assert.equal(await topLine(), lockedTop, 'a sideways pan does not scroll the history');
      assert.equal((await probe(page)).offset, 0, 'Fit mode has nothing to move sideways');
      // A tap is still a tap: no scroll.
      await page.touchscreen.tap(150, 300);
      assert.equal(await topLine(), lockedTop, 'a tap does not scroll');

      // Copy view (long press): Fit under 100 columns shows the wrap hint; "Widen terminal" switches to Wide (160) and the PTY gets 160 columns.
      await touch('touchStart', 150, 300);
      await page.waitForTimeout(650);
      await touch('touchEnd');
      await page.locator('#h5-copy').waitFor();
      await page.locator('#h5-copy-wrap-hint').waitFor();
      assert.equal(await page.locator('#h5-copy-wrap-hint span').first().textContent(), `Lines are wrapped at ${fit.lastCols} columns`);
      if (shots) await page.screenshot({ path: path.join(shots, 'gestures-copy-hint.png') });
      await page.locator('#h5-copy-widen').tap();
      await page.waitForFunction(() => { const sent = window.sockets.at(-1).sent.map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(item => item && item.type === 'resize'); return sent.at(-1)?.cols === 160; });
      await page.locator('#h5-copy-wrap-hint').waitFor({ state: 'detached' });
      await page.locator('.MuiAlert-message', { hasText: 'The new width applies to new output' }).waitFor();
      await page.locator('#h5-copy-close').tap();
      await page.locator('#h5-copy').waitFor({ state: 'detached' });
      assert.equal(await page.locator('#h5-term-width').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.evaluate(() => localStorage.getItem('h5-terminal-width')), 'wide', 'the choice is remembered');
      let wide = await probe(page);
      assert.equal(wide.wide, true);
      assert.ok(wide.content > wide.visible * 2, `the screen is wider than the view (${wide.content} > ${wide.visible})`);

      // Wide: a sideways pan (finger left) moves the screen 1:1, clamped at both ends; the history does not move.
      const wideTop = await topLine();
      await pan(300, 300, -150, 0);
      wide = await probe(page);
      assert.ok(Math.abs(wide.offset - 150) <= 1, `a 150px pan moves the screen 150px (${wide.offset})`);
      assert.equal(await topLine(), wideTop, 'a sideways pan leaves the history where it is');
      await pan(380, 300, -370, 0);
      await pan(380, 300, -370, 0);
      await pan(380, 300, -370, 0);
      wide = await probe(page);
      assert.equal(wide.offset, wide.content - wide.visible, 'the offset stops at the right end');
      if (shots) await page.screenshot({ path: path.join(shots, 'gestures-wide-right.png') });
      // Diagonal pans lock to their first axis.
      const atEnd = wide.offset;
      await pan(200, 300, 60, 25);
      wide = await probe(page);
      assert.ok(Math.abs(atEnd - wide.offset - 60) <= 1, `a pan that leans sideways moves sideways only (${atEnd - wide.offset})`);
      assert.equal(await topLine(), wideTop, '... and not vertically');
      const sideways = wide.offset;
      await pan(200, 300, 25, 120);
      assert.equal((await probe(page)).offset, sideways, 'a pan that leans down does not move sideways');
      assert.ok(await topLine() < wideTop, '... and scrolls the history');
      // Output does not pull the view back while the user has panned the cursor away; input does.
      await emit('\r\n$ ');
      assert.equal((await probe(page)).offset, sideways, 'output does not move a view the user panned away from the cursor');
      await page.locator('#h5-keys [data-key="Escape"]').tap();
      await page.waitForFunction(() => !document.querySelector('.h5-xterm:not([hidden]) .xterm-screen').style.transform);
      assert.equal((await probe(page)).offset, 0, 'input brings the cursor (column 0) back into view');
      // Output that moves the cursor past the right edge is followed (the view follows the cursor until the user pans away).
      await emit('x'.repeat(120));
      wide = await probe(page);
      const cell = wide.content / 160;
      assert.ok(wide.offset > 0 && 122 * cell <= wide.offset + wide.visible + 1, `the cursor at column 122 is kept in view (offset ${wide.offset})`);

      // Header switch: long press opens the menu, pick 200 columns; a tap goes back to Fit.
      await touch('touchStart', ...(await page.locator('#h5-term-width').boundingBox().then(box => [box.x + box.width / 2, box.y + box.height / 2])));
      await page.waitForTimeout(650);
      await touch('touchEnd');
      await page.locator('#h5-term-width-menu').waitFor();
      assert.equal(await page.locator('#h5-term-width-menu .Mui-selected').getAttribute('data-cols'), '160');
      if (shots) await page.screenshot({ path: path.join(shots, 'gestures-width-menu.png') });
      await page.locator('#h5-term-width-menu [data-cols="200"]').tap();
      await page.waitForFunction(() => window.sockets.at(-1).sent.some(item => item.includes('"cols":200')));
      await page.locator('#h5-term-width-menu').waitFor({ state: 'detached' });
      assert.equal(await page.locator('#h5-term-width').getAttribute('aria-pressed'), 'true', 'the long press opened the menu, it did not toggle');
      assert.equal(await page.evaluate(() => localStorage.getItem('h5-terminal-wide-cols')), '200');
      await page.locator('#h5-term-width').tap();
      await page.waitForFunction(cols => { const sent = window.sockets.at(-1).sent.map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(item => item && item.type === 'resize'); return sent.at(-1)?.cols === cols; }, fit.lastCols);
      assert.equal(await page.locator('#h5-term-width').getAttribute('aria-pressed'), 'false', 'one tap goes back to Fit');
      assert.equal((await probe(page)).wide, false);
      await page.locator('#h5-term-width').tap(); // Wide 200 again for the alternate buffer
      await page.waitForFunction(() => window.sockets.at(-1).sent.filter(item => item.includes('"cols":200')).length >= 2);

      // Alternate buffer with mouse tracking (Claude Code, vim with mouse): a pan up (finger up) sends wheel-down reports (newer), one per line
      // of travel; a pan down sends wheel-up reports; a sideways pan moves the screen and sends nothing.
      await emit('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[Hfull screen app');
      const reports = async () => (await probe(page)).sent.filter(item => /^\x1b\[<6[45];/.test(item)).map(item => item.slice(3, 5));
      let before = (await reports()).length;
      await pan(150, 500, 0, -100);
      let codes = (await reports()).slice(before);
      const lines = Math.trunc(100 / lh);
      assert.ok(codes.length >= lines - 1 && codes.length <= lines + 1 && codes.every(code => code === '65'), `a pan up sends about ${lines} wheel-down reports (${codes.join(',')})`);
      before = (await reports()).length;
      await pan(150, 300, 0, 100);
      codes = (await reports()).slice(before);
      assert.ok(codes.length >= lines - 1 && codes.every(code => code === '64'), `a pan down sends wheel-up reports (${codes.join(',')})`);
      before = (await reports()).length;
      const altOffset = (await probe(page)).offset;
      await pan(300, 400, -120, 20);
      assert.equal((await reports()).length, before, 'a sideways pan sends nothing to the program');
      assert.ok(Math.abs((await probe(page)).offset - altOffset - 120) <= 1, 'a sideways pan in the alternate buffer moves the screen');
      before = (await reports()).length;
      await page.touchscreen.tap(150, 400);
      await page.waitForTimeout(100);
      assert.equal((await reports()).length, before, 'a tap sends no wheel report');
      // Without mouse mode (less, a pager): the same pan sends down / up arrows.
      await emit('\x1b[?1000l\x1b[?1006l');
      const arrows = async () => (await probe(page)).sent.filter(item => /^\x1b[[O][AB]$/.test(item)).map(item => item.at(-1));
      before = (await arrows()).length;
      await pan(150, 500, 0, -100);
      codes = (await arrows()).slice(before);
      assert.ok(codes.length >= lines - 1 && codes.every(code => code === 'B'), `without mouse mode a pan up sends down arrows (${codes.join(',')})`);
      await emit('\x1b[?1049l');

      // Remembered: a new page starts in Wide 200 and sizes the PTY so at once.
      await page.reload(); // the open terminal is remembered too
      await page.waitForFunction(() => window.sockets.length > 0 && window.sockets.at(-1).readyState === 1 && document.querySelector('.h5-xterm:not([hidden]) .xterm-rows'));
      await page.waitForFunction(() => window.sockets.at(-1).sent.some(item => item.includes('"cols":200')));
      assert.equal(await page.locator('#h5-term-width').getAttribute('aria-pressed'), 'true', 'Wide is remembered after a reload');
      await cdp.detach();
      await context.close();
    }

    // ── Computer: mouse wheel ──
    {
      const { context, page } = await openPage(browser, { viewport: { width: 1440, height: 900 } }, { storage: { 'h5-terminal-width': 'wide', 'h5-terminal-wide-cols': '200' } });
      await page.waitForFunction(() => window.sockets.at(-1).sent.some(item => item.includes('"cols"')));
      await page.evaluate(() => new Promise(done => { window.sockets.at(-1).emit(Array.from({ length: 200 }, (_, i) => `row ${i}`).join('\r\n')); requestAnimationFrame(() => requestAnimationFrame(done)); }));
      const first = await probe(page);
      assert.equal(first.lastCols, 200, 'the remembered Wide 200 sizes the PTY');
      assert.equal(first.wide, true, '200 columns at 13px are wider than the 1440 window less the sidebar');
      const box = await page.locator('.h5-xterm:not([hidden])').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -200);
      await page.waitForTimeout(100);
      assert.equal((await probe(page)).offset, 0, 'the vertical wheel does not move sideways');
      await page.keyboard.down('Shift');
      await page.mouse.wheel(0, 100);
      await page.keyboard.up('Shift');
      await page.waitForTimeout(100);
      const shifted = await probe(page);
      assert.ok(shifted.offset > 0, `Shift+wheel moves the wide screen sideways (${shifted.offset})`);
      await page.mouse.wheel(-40, 0);
      await page.waitForTimeout(100);
      assert.ok((await probe(page)).offset < shifted.offset, 'a sideways wheel moves it back');
      assert.equal(await page.locator('#h5-term-width').getAttribute('aria-pressed'), 'true');
      await context.close();
    }
    assert.deepEqual(pageErrors, [], 'no page errors');
    console.log('h5 terminal gestures browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
