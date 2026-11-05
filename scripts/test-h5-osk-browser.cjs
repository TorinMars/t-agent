// The terminal's own on-screen keyboard (scripts/h5-shell/Osk.jsx) in real Chromium, touch mode, at 390 x 844 and 320 x 568.
// The "Terminal keyboard" button shows it instead of the system keyboard: nothing editable takes the focus (the xterm textarea keeps inputmode="none"),
// typed keys reach the terminal through the same path as the function keys (a latched Ctrl of row 1 applies), Shift is one-shot or caps lock, the layers
// switch, the terminal refits (fewer rows) while it is shown and gets its rows back when it is hidden, and it fits a 320px screen.
// The server is mocked (no data folder is used); the mock socket echoes typed text back like a shell, so the test can read it in the terminal.
// H5_SHOT_DIR=<dir> saves 3x screenshots of the open keyboard there.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const pageErrors = [];

const TASKS = [{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }];
const TERMINALS = { 1: [{ terminal_id: 'h5-default', title: 'Terminal 1' }] };

async function openPage(browser, viewport) {
  const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: process.env.H5_SHOT_DIR ? 3 : 1 });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) {
        const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
        this.sent.push(text);
        // Echo typed printable text like a shell does (control frames are binary JSON; Enter becomes a new line).
        if (typeof data === 'string') setTimeout(() => this.onmessage?.({ data: data === '\r' ? '\r\n' : data.replace(/[\x00-\x1f\x7f]/g, '') }), 0);
      }
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    if (url.pathname === '/api/remote-servers') return json([]);
    if (url.pathname === '/api/tasks' && method === 'GET') return json(TASKS);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (url.pathname === '/api/tasks/terminal-activity') return json({});
    if (url.pathname === '/api/tasks/terminal-subagents') return json({});
    const terminals = url.pathname.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (terminals && method === 'GET') return json(TERMINALS[terminals[1]] || []);
    if (/^\/api\/tasks\/\d+\/agent\/conversations$/.test(url.pathname)) return json([]);
    if (url.pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    if (url.pathname === '/api/oss/config') return json({ enabled: false });
    if (url.pathname === '/api/system/check-update' || url.pathname === '/api/system/update-status') return json({ status: 'up_to_date', local_version: '1.0.0' });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  await page.locator('#h5-tasks').waitFor({ state: 'visible' });
  await page.locator('.h5-task-item', { hasText: 'Fix login' }).tap();
  await page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main', { hasText: 'Terminal 1' }).tap();
  await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => window.sockets.length > 0 && window.sockets.at(-1).readyState === 1 && document.querySelector('.h5-xterm:not([hidden]) .xterm-rows'));
  return { context, page };
}

// In-page probes.
const state = () => {
  const active = document.activeElement;
  const textarea = document.querySelector('.h5-xterm:not([hidden]) textarea');
  const ws = window.sockets.at(-1);
  return {
    open: Boolean(document.getElementById('h5-osk')),
    pressed: document.querySelector('[data-action="keyboard"]').getAttribute('aria-pressed'),
    editable: Boolean(active && active.matches && active.matches('input, textarea, [contenteditable="true"]')),
    inputmode: textarea && textarea.getAttribute('inputmode'),
    rows: document.querySelectorAll('.h5-xterm:not([hidden]) .xterm-rows > div').length,
    typed: ws.sent.filter(item => !item.startsWith('{')),
    resizes: ws.sent.map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(item => item && item.type === 'resize'),
  };
};
// A touch press in the page (pointerdown then pointerup on the key's centre), so fast sequences such as a Shift double tap do not depend on frame timing.
const pressKeys = (page, selectors, gap = 0) => page.evaluate(async ({ selectors, gap }) => {
  for (const selector of selectors) {
    const el = document.querySelector(`#h5-osk ${selector}`);
    if (!el) throw new Error(`no key ${selector}`);
    const box = el.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 7, isPrimary: true, button: 0, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
    el.dispatchEvent(new PointerEvent('pointerdown', init));
    el.dispatchEvent(new PointerEvent('pointerup', { ...init, button: 0 }));
    if (gap) { const until = performance.now() + gap; while (performance.now() < until) await new Promise(resolve => setTimeout(resolve, 5)); }
  }
}, { selectors, gap });
const terminalText = page => page.evaluate(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-rows').textContent);

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    // ── iPhone size ──
    {
      const { context, page } = await openPage(browser, { width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.dataset.input), 'touch', 'a phone is in touch mode');
      const rest = await page.evaluate(state);
      assert.equal(rest.open, false, 'the keyboard is hidden at first');
      assert.equal(rest.pressed, 'false');
      // Open: the custom keyboard is shown, the button is blue, nothing editable has the focus and the terminal never asks for the system keyboard.
      await page.locator('[data-action="keyboard"]').tap();
      await page.locator('#h5-osk').waitFor();
      await page.waitForFunction(rows => document.querySelectorAll('.h5-xterm:not([hidden]) .xterm-rows > div').length < rows, rest.rows);
      const opened = await page.evaluate(state);
      assert.equal(opened.pressed, 'true', 'the terminal keyboard button shows the open state');
      assert.equal(opened.editable, false, 'no input or textarea has the focus (the system keyboard stays closed)');
      assert.equal(opened.inputmode, 'none', 'the xterm textarea asks for no system keyboard');
      assert.ok(opened.rows < rest.rows, `the terminal refits above the keyboard (${rest.rows} -> ${opened.rows} rows)`);
      await page.waitForFunction(rows => window.sockets.at(-1).sent.some(item => { try { return JSON.parse(item).rows === rows; } catch { return false; } }), opened.rows);
      // The terminal stays above the keyboard: its screen ends before the bottom area starts.
      const layout = await page.evaluate(() => ({ screen: document.querySelector('.h5-xterm:not([hidden]) .xterm-screen').getBoundingClientRect().bottom, bottom: document.getElementById('h5-bottom').getBoundingClientRect().top, osk: document.getElementById('h5-osk').getBoundingClientRect(), actions: document.getElementById('h5-actions').getBoundingClientRect().bottom }));
      assert.ok(layout.screen <= layout.bottom + 1, 'the terminal is fully visible above the bottom area');
      assert.ok(layout.osk.top >= layout.actions - 1 && layout.osk.bottom <= 844, 'the keyboard sits under row 2, inside the screen');
      if (process.env.H5_SHOT_DIR) await page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, 'osk-390-letters.png') });

      // Tapping keys (real touch taps) never moves the focus to an input. "ls" + Enter reaches the terminal and its echo shows up.
      for (const key of ['l', 's']) await page.locator(`#h5-osk [data-char="${key}"]`).tap();
      await page.locator('#h5-osk [data-key="Enter"]').tap();
      await page.waitForFunction(() => window.sockets.at(-1).sent.includes('\r'));
      let now = await page.evaluate(state);
      assert.deepEqual(now.typed, ['l', 's', '\r'], 'l, s and Enter are sent as typed');
      assert.equal(now.editable, false, 'the keys did not focus an input');
      await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-rows').textContent.includes('ls'));
      assert.match(await terminalText(page), /ls/, 'the terminal shows the echoed command');
      if (process.env.H5_SHOT_DIR) await page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, 'osk-390-typed.png') });

      // Shift is one-shot: the next letter is upper case, the one after is not. Twice quickly is caps lock, a third tap ends it.
      await pressKeys(page, ['[data-shift]']);
      assert.equal(await page.locator('#h5-osk').getAttribute('data-shift'), 'once');
      assert.equal(await page.locator('#h5-osk [data-char="a"]').textContent(), 'A', 'the letters show upper case while Shift is on');
      await pressKeys(page, ['[data-char="a"]', '[data-char="b"]']);
      await pressKeys(page, ['[data-shift]', '[data-shift]']);
      assert.equal(await page.locator('#h5-osk').getAttribute('data-shift'), 'lock', 'a double tap turns on caps lock');
      assert.equal(await page.locator('#h5-osk [data-shift]').getAttribute('aria-label'), 'Caps lock');
      await pressKeys(page, ['[data-char="c"]', '[data-char="d"]', '[data-shift]', '[data-char="e"]']);
      assert.equal(await page.locator('#h5-osk').getAttribute('data-shift'), 'off');
      // Two slow taps are on then off, not caps lock.
      await pressKeys(page, ['[data-shift]', '[data-shift]'], 450);
      assert.equal(await page.locator('#h5-osk').getAttribute('data-shift'), 'off', 'two slow taps turn Shift on and off');
      now = await page.evaluate(state);
      assert.deepEqual(now.typed.slice(3), ['A', 'b', 'C', 'D', 'e']);

      // Layers: 123 has the digits and shell symbols, #+= more symbols, ABC goes back. Space is a space.
      await pressKeys(page, ['[data-layer="num"]']);
      assert.equal(await page.locator('#h5-osk').getAttribute('data-layer'), 'num');
      const numKeys = await page.locator('#h5-osk [data-char]').evaluateAll(list => list.map(el => el.dataset.char).join(''));
      assert.ok(numKeys.startsWith('1234567890'), `digits first: ${numKeys}`);
      await pressKeys(page, ['[data-char="1"]']);
      await pressKeys(page, ['[data-layer="sym"]']);
      const symKeys = await page.locator('#h5-osk [data-char]').evaluateAll(list => list.map(el => el.dataset.char).join(''));
      for (const ch of '-_/\\|~`\'":;,.?!@#$%^&*()[]{}<>=+') assert.ok((numKeys + symKeys).includes(ch), `the symbol pages have ${ch}`);
      await pressKeys(page, ['[data-char="|"]', '[data-key="Space"]', '[data-char="~"]']);
      await pressKeys(page, ['[data-layer="abc"]']);
      assert.equal(await page.locator('#h5-osk').getAttribute('data-layer'), 'abc');
      now = await page.evaluate(state);
      assert.deepEqual(now.typed.slice(8), ['1', '|', ' ', '~']);

      // A latched Ctrl of row 1 applies to the next key of the custom keyboard: Ctrl + c sends \x03, then Ctrl is released. Ctrl + r is \x12.
      await page.locator('[data-modifier="ctrl"]').tap();
      assert.equal(await page.locator('[data-modifier="ctrl"]').getAttribute('aria-pressed'), 'true');
      await page.locator('#h5-osk [data-char="c"]').tap();
      await page.waitForFunction(() => window.sockets.at(-1).sent.includes('\x03'));
      assert.equal(await page.locator('[data-modifier="ctrl"]').getAttribute('aria-pressed'), 'false', 'Ctrl is one-shot');
      await page.locator('[data-modifier="ctrl"]').tap();
      await pressKeys(page, ['[data-char="r"]']);
      // Row 1 keys still work with the keyboard open.
      await page.locator('#h5-keys [data-key="Escape"]').tap();
      now = await page.evaluate(state);
      assert.deepEqual(now.typed.slice(12), ['\x03', '\x12', '\x1b']);
      assert.equal(now.editable, false);

      // Backspace repeats while held (in-page timing: hold 900 ms).
      const before = (await page.evaluate(state)).typed.length;
      await page.evaluate(async () => {
        const el = document.querySelector('#h5-osk [data-key="Backspace"]');
        const init = { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 9, isPrimary: true, button: 0 };
        el.dispatchEvent(new PointerEvent('pointerdown', init));
        if (!el.hasAttribute('data-down')) throw new Error('no press feedback');
        const until = performance.now() + 900;
        while (performance.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
        el.dispatchEvent(new PointerEvent('pointerup', init));
        if (el.hasAttribute('data-down')) throw new Error('the press feedback stays after release');
      });
      const held = (await page.evaluate(state)).typed.slice(before);
      assert.ok(held.length >= 3 && held.every(item => item === '\x7f'), `a held Backspace repeats (${held.length} times)`);
      const settled = (await page.evaluate(state)).typed.length;
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)));
      assert.equal((await page.evaluate(state)).typed.length, settled, 'the repeat stops on release');

      // The draft keyboard hides the custom keyboard (the system keyboard types into the draft box).
      await page.locator('[data-action="draft"]').tap();
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'h5-translate-input' && !document.getElementById('h5-osk'));
      assert.equal(await page.locator('[data-action="keyboard"]').getAttribute('aria-pressed'), 'false');
      assert.equal(await page.locator('[data-action="draft"]').getAttribute('aria-pressed'), 'true');
      // The terminal keyboard takes over from the draft box: the box loses the focus.
      await page.locator('[data-action="keyboard"]').tap();
      await page.locator('#h5-osk').waitFor();
      assert.equal((await page.evaluate(state)).editable, false, 'opening the terminal keyboard blurs the draft box');
      // A second tap hides it, and the terminal gets its rows back.
      await page.locator('[data-action="keyboard"]').tap();
      await page.locator('#h5-osk').waitFor({ state: 'detached' });
      await page.waitForFunction(rows => document.querySelectorAll('.h5-xterm:not([hidden]) .xterm-rows > div').length === rows, rest.rows);
      const closed = await page.evaluate(state);
      assert.equal(closed.pressed, 'false');
      assert.equal(closed.inputmode, 'none');
      // Tapping the terminal still never asks for the system keyboard.
      await page.locator('.h5-xterm:not([hidden])').tap();
      assert.equal((await page.evaluate(state)).inputmode, 'none');
      await context.close();
    }
    // ── 320px wide (iPhone SE first generation): every layer fits, no sideways scrolling, keys 44px high ──
    {
      const { context, page } = await openPage(browser, { width: 320, height: 568 });
      const restRows = (await page.evaluate(state)).rows;
      await page.locator('[data-action="keyboard"]').tap();
      await page.locator('#h5-osk').waitFor();
      await page.waitForFunction(rows => document.querySelectorAll('.h5-xterm:not([hidden]) .xterm-rows > div').length < rows, restRows);
      for (const layer of ['abc', 'num', 'sym']) {
        if (layer !== 'abc') await pressKeys(page, [layer === 'num' ? '[data-layer="num"]' : '[data-layer="sym"]']);
        assert.equal(await page.locator('#h5-osk').getAttribute('data-layer'), layer);
        const fit = await page.evaluate(() => {
          const keys = [...document.querySelectorAll('#h5-osk button')].map(el => el.getBoundingClientRect());
          return {
            pageWide: document.documentElement.scrollWidth, bodyWide: document.body.scrollWidth,
            inside: keys.every(b => b.left >= 0 && b.right <= innerWidth && b.bottom <= innerHeight),
            tall: keys.every(b => b.height >= 44), narrowest: Math.min(...keys.map(b => b.width)), lines: new Set(keys.map(b => Math.round(b.top))).size,
            screenBottom: document.querySelector('.h5-xterm:not([hidden]) .xterm-screen').getBoundingClientRect().bottom, bottomTop: document.getElementById('h5-bottom').getBoundingClientRect().top,
            rows: document.querySelectorAll('.h5-xterm:not([hidden]) .xterm-rows > div').length,
          };
        });
        assert.ok(fit.pageWide <= 320 && fit.bodyWide <= 320, `${layer}: no horizontal overflow (${fit.pageWide}px)`);
        assert.ok(fit.inside, `${layer}: every key is inside the screen`);
        assert.ok(fit.tall, `${layer}: keys are 44px high`);
        assert.equal(fit.lines, 4, `${layer}: four rows of keys (Shift / the layer key share the third row with the letters)`);
        assert.ok(fit.narrowest >= 26, `${layer}: the narrowest key is ${fit.narrowest}px`);
        assert.ok(fit.screenBottom <= fit.bottomTop + 1 && fit.rows >= 5, `${layer}: the terminal stays visible above the keyboard (${fit.rows} rows)`);
        if (process.env.H5_SHOT_DIR) await page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, `osk-320-${layer}.png`) });
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log('h5 terminal on-screen keyboard: ok (390 and 320px)');
})().catch(error => { console.error(error); process.exit(1); });
