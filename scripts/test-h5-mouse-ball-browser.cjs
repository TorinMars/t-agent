// The mouse handle and the mouse ball of the terminal (scripts/h5-shell/MouseBall.jsx, mouse-ball-model.mjs; "Mouse ball" and "The mouse handle"
// in docs/design/page-terminal-mouse-ball.md) in real headless Chromium at 390 x 844 with touch, driven by real CDP touches (Input.dispatchTouchEvent),
// and at 1440 x 900 with Playwright's mouse. The server is mocked (no data folder).
// Checked: no ball and no More-menu switch at start (its chunk is loaded in touch input); the handle at its default place (role img, "Mouse handle,
// drag to scroll"); the first-time hint above it ("Drag to scroll, slide left for the mouse"), once per device, gone after 4 s, and
// mirrored ("Drag to scroll, slide right for the mouse") with the handle on the left edge; a vertical drag on the handle scrolls the normal buffer (up = older, down =
// newer, faster with the pull), highlighted blue with its chevrons, never the mouse even when it turns sideways, never a long-press move, and on the
// lift it springs back to its place and the scrolling stops; a tap on the handle does nothing and sends no click to the terminal; a slide toward
// the edge does nothing; a slide toward the inside stretches the handle (25px: the stretch state, the handle highlighted), lifted then it springs
// back with no copy and no scroll; past 40px it is the ball; then the shipped scenario from that entrance: the cursor 46px left of and above the
// ball with a dashed line; holding still 600 ms presses (ring, blue cursor) and does not open the long-press copy view; a drag then selects, and the
// lift copies exactly the expected text through the copy path of the double tap (notice "Copied N characters"), then the ball glides back into the
// handle; a touch on the handle during the glide works at once; the edge fade lets the cursor reach the last column; a drag without the dwell copies
// nothing; a cancelled touch copies nothing and leaves no selection; the terminal does not scroll under the ball, but a held button near the top
// edge scrolls it and the selection keeps its start; a refused write shows the copy bar; a paragraph a program wrapped is one line; with mouse
// reporting on (SGR drag tracking) the button goes to the program instead (the press at the dwell, motions while held and the release at the lift as
// 1-based SGR reports, wheel steps near the top edge, no page selection or copy, the program's OSC 52 copy on the release written at once, reporting
// turned off mid-gesture keeps the gesture the program's, off again the page selects and copies); the More menu's switch "Mouse ball sends the mouse
// to programs" (phone and computer, on by default, writing `off` to h5-mouse-ball-program); with modes 1000/1002/1003/1004/1006 the bytes of a real
// mouse (hover moves before the press, ESC[I once when the terminal did not have the focus, the press, drags, the release), no hover in 1002, and
// with the switch off nothing reaches the program; in a full-screen program (the alternate buffer) the handle scrolls with wheel events (arrow keys
// without mouse mode, SGR wheel reports with it) and the ball comes out the same way, sending nothing before the press; the long press that moves
// the handle, the snap to the nearest edge, the place kept after a reload, the mirrored pull from the left edge; a fresh terminal without history
// (the handle, the hint, a vertical drag scrolling nothing, a tap doing nothing, the whole gesture, then scrolling once there is history); a computer
// with a mouse (the terminal box 4px from the right, xterm's own scrollbar not hidden, a left-button vertical drag on the handle scrolling with the
// keyboard left in the terminal, the slide with the button held, the copy at the mouseup, Escape, the long press and the snap); no horizontal
// overflow. H5_SHOT_DIR=<dir> saves screenshots.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'https://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR;

async function openPage(browser, { touch = true, viewport = { width: 390, height: 844 } } = {}) {
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), deviceScaleFactor: SHOTS ? 3 : 1 });
  const page = await context.newPage();
  const errors = [];
  const chunks = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
      emit(data) { this.onmessage?.({ data }); }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    // The clipboard spy: every write the page makes, in order; `refuse` makes the browser say no (as iOS does without a user activation).
    window.copied = [];
    window.refuse = false;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: text => { if (window.refuse) return Promise.reject(new Error('NotAllowedError')); window.copied.push(text); return Promise.resolve(); },
      readText: () => Promise.resolve(window.copied.at(-1) || ''),
    } });
    const exec = document.execCommand.bind(document);
    document.execCommand = (command, ...rest) => (command === 'copy' && window.refuse ? false : exec(command, ...rest));
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) {
      if (url.pathname.includes('screen-mouse-ball')) chunks.push(url.pathname);
      return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    }
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
  return { context, page, errors, chunks };
}
async function openTerminal(page, { touch = true } = {}) {
  const press = locator => (touch ? locator.tap() : locator.click());
  await page.locator('#h5-tasks').waitFor({ state: 'visible' });
  await press(page.locator('.h5-task-item', { hasText: 'Fix login' }));
  await press(page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main', { hasText: 'Terminal 1' }));
  await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => window.sockets.length > 0 && window.sockets.at(-1).readyState === 1 && document.querySelector('.h5-xterm:not([hidden]) .xterm-rows'));
  await page.evaluate(() => {
    window.notices = [];
    const real = window.notify;
    window.notify = (message, type) => { window.notices.push([message, type]); return real(message, type); };
  });
}

const ROW1 = 'alpha bravo charlie delta echo';
const ROW2 = 'foxtrot golf hotel india juliet';

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const { context, page, errors, chunks } = await openPage(browser);
    await openTerminal(page);
    const cdp = await context.newCDPSession(page);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y }] });
    const frames = (n = 2) => page.evaluate(n => new Promise(done => { const step = k => (k ? requestAnimationFrame(() => step(k - 1)) : done()); step(n); }), n);
    const emit = async data => { await page.evaluate(data => window.sockets.at(-1).emit(data), data); await frames(); };
    const shot = async name => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `mouse-ball-${name}.png`) }); } };
    // The cells: the box of .xterm-screen divided by the columns and rows.
    const grid = () => page.evaluate(() => {
      const el = document.querySelector('.h5-xterm:not([hidden])');
      const screen = el.querySelector('.xterm-screen').getBoundingClientRect();
      const rows = el.querySelectorAll('.xterm-rows > div').length;
      const cols = window.H5UI.get().terminalWidth.current;
      const box = document.getElementById('h5-terminal').getBoundingClientRect();
      return { left: screen.left, top: screen.top, right: screen.right, cw: screen.width / cols, ch: screen.height / rows, cols, rows, box: { top: box.top, bottom: box.bottom, right: box.right } };
    });
    const ballBox = () => page.evaluate(() => { const r = document.getElementById('h5-mouse-ball').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; });
    const ui = () => page.evaluate(() => {
      const ball = document.getElementById('h5-mouse-ball');
      const overlay = document.querySelector('.h5-mouse-ball-overlay');
      const cursor = overlay.querySelector('.h5-mouse-ball-cursor').getAttribute('transform') || '';
      const [, cx, cy] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(cursor) || [];
      const line = overlay.querySelector('.h5-mouse-ball-line');
      return {
        state: ball.dataset.state, pressed: String(ball.dataset.state === 'pressed'), overlay: getComputedStyle(overlay).display, color: getComputedStyle(overlay).color,
        ring: getComputedStyle(ball.querySelector('circle')).opacity, cursor: { x: Number(cx), y: Number(cy) },
        line: [line.getAttribute('x1'), line.getAttribute('y1'), line.getAttribute('x2'), line.getAttribute('y2')].map(Number), dash: getComputedStyle(line).strokeDasharray,
        selected: document.querySelectorAll('.h5-xterm:not([hidden]) .xterm-selection div').length,
        copyView: window.H5UI.get().copyText !== null,
      };
    });
    const copied = () => page.evaluate(() => window.copied.slice());
    const notices = () => page.evaluate(() => window.notices.splice(0));
    // A finger glide from `from` to `to` in `steps` moves, `ms` apart (each step more than 6px, so it never counts as still).
    const glide = async (from, to, { steps = 8, ms = 16 } = {}) => {
      for (let i = 1; i <= steps; i++) { await touch('touchMove', from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps); if (ms) await page.waitForTimeout(ms); }
    };
    // The finger that puts the cursor at `cursor` (the full 46px offset, away from the edges, grabbed at the ball's centre).
    const fingerFor = cursor => ({ x: cursor.x + 46, y: cursor.y + 46 });
    const at = (g, col, row) => ({ x: g.left + col * g.cw, y: g.top + (row + 0.5) * g.ch }); // the boundary before `col` in the middle of `row`
    // The middle of the handle's drawn bar: where a touch on the handle starts.
    const handlePoint = () => page.evaluate(() => { const b = document.querySelector('#h5-mouse-handle .h5-mouse-handle-bar').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    // The ball out of the handle: a touch on its bar, 45px toward the inside (it lets go at 40), then the finger to `to`.
    const enter = async (to, options) => {
      const from = await handlePoint();
      const side = await page.evaluate(() => document.getElementById('h5-mouse-handle').dataset.edge);
      const out = { x: from.x + (side === 'left' ? 45 : -45), y: from.y };
      await touch('touchStart', from.x, from.y);
      await glide(from, out, { steps: 5 });
      await page.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'drag', null, { timeout: 3000 });
      if (to) await glide(out, to, options);
      return out;
    };
    // Back in the handle after the lift: the ball gone, the handle at rest.
    const dockedAgain = () => page.waitForFunction(() => {
      const el = document.getElementById('h5-mouse-handle');
      const ball = document.getElementById('h5-mouse-ball');
      return !el.dataset.mouse && el.dataset.state === 'idle' && ball.dataset.state === 'idle' && getComputedStyle(ball).display === 'none';
    }, null, { timeout: 3000 });

    // The mouse handle: its touch box, its drawn bar (centre and size) and its state, with the terminal box.
    const handleBox = () => page.evaluate(() => {
      const el = document.getElementById('h5-mouse-handle');
      const bar = el.querySelector('.h5-mouse-handle-bar');
      const r = el.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      const box = document.getElementById('h5-terminal').getBoundingClientRect();
      const chevrons = [...el.querySelectorAll('.h5-mouse-handle-chevron')].map(node => ({ display: getComputedStyle(node).display, color: getComputedStyle(node).color, y: node.getBoundingClientRect().top }));
      return { display: getComputedStyle(el).display, state: el.dataset.state, edge: el.dataset.edge, dir: el.dataset.dir || '', mouse: el.dataset.mouse || '', role: el.getAttribute('role'), label: el.getAttribute('aria-label'), chevrons,
        touchAction: getComputedStyle(el).touchAction, hit: { x: r.left, y: r.top, w: r.width, h: r.height }, bar: { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height, bg: getComputedStyle(bar).backgroundColor, shadow: getComputedStyle(bar).boxShadow },
        box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom } };
    });
    // The More menu's switch "Mouse ball sends the mouse to programs": opened, flipped to `on` (true) or off, closed; returns what the row showed.
    const programSwitch = async on => {
      await page.locator('#h5-header-more').tap();
      const row = page.locator('#h5-mouse-ball-program');
      await row.waitFor({ state: 'visible' });
      const before = await row.getAttribute('aria-checked');
      if (on !== undefined && (before === 'true') !== on) {
        await row.tap();
        await page.waitForFunction(on => document.getElementById('h5-mouse-ball-program').getAttribute('aria-checked') === String(on), on);
        assert.equal(await page.locator('#h5-header-more-menu').isVisible(), true, 'the menu stays open: the row shows the new state at once');
      }
      const shown = await row.getAttribute('aria-checked');
      if (SHOTS) { await page.waitForTimeout(400); await shot(`switch-${shown}`); }
      await page.keyboard.press('Escape');
      await page.locator('#h5-header-more-menu').waitFor({ state: 'detached' });
      return { before, shown };
    };

    // ── At start: no ball, no switch in the More menu; the chunk is there in touch input ──
    const g0 = await grid();
    const history = Array.from({ length: 300 }, (_, i) => `old ${i + 1}`).join('\r\n');
    // The text starts on row 1 (0-based): the 24px next to the top edge is where a held button scrolls the history.
    await emit(`${history}\r\n\x1b[2J\x1b[H\r\nMOUSE BALL TEST\r\n${ROW1}\r\n${ROW2}\r\n${'W'.repeat(g0.cols - 1)}Z\r\n$ `);
    await page.locator('#h5-mouse-ball').waitFor({ state: 'attached' });
    await page.waitForFunction(() => document.getElementById('h5-mouse-handle')?.style.display === 'block');
    assert.equal(await page.locator('#h5-mouse-ball').isVisible(), false, 'no ball on the screen');
    assert.equal(chunks.length, 1, 'the chunk is loaded in touch input');
    // ── The mouse handle at its default place, and the first-time hint above it, once per device ──
    let hd = await handleBox();
    assert.equal(hd.display, 'block', 'the mouse handle is drawn with the terminal');
    assert.deepEqual([hd.role, hd.label, hd.edge, hd.state], ['img', 'Mouse handle, drag to scroll', 'right', 'idle']);
    assert.deepEqual([hd.bar.w, hd.bar.h], [11, 64], 'an 11 x 64 bar');
    assert.equal(hd.bar.bg, 'rgba(255, 255, 255, 0.55)', 'white 55% at rest');
    assert.ok(hd.chevrons.length === 2 && hd.chevrons.every(c => c.display === 'none'), 'no chevrons at rest');
    assert.ok(hd.hit.w >= 44 && hd.hit.h >= 64 && hd.hit.x <= hd.bar.x - 5.5 && hd.hit.x + hd.hit.w >= hd.bar.x + 5.5 && hd.hit.y <= hd.bar.y - 32 && hd.hit.y + hd.hit.h >= hd.bar.y + 32, `a touch box of at least 44px around the bar (${JSON.stringify(hd)})`);
    assert.ok(Math.abs(hd.bar.x - (hd.box.right - 7.5)) < 0.5, `on the right edge, 2px in (${hd.bar.x}, ${hd.box.right})`);
    assert.ok(Math.abs(hd.bar.y - (hd.box.bottom - 68)) < 0.5, `low, clear of the key row: its centre 68px above the terminal's bottom (${hd.bar.y}, ${hd.box.bottom})`);
    assert.equal(hd.touchAction, 'none');
    const handleHome = hd;
    const hint = page.locator('#h5-mouse-ball-hint');
    await hint.waitFor({ state: 'visible', timeout: 3000 });
    assert.equal(await hint.textContent(), 'Drag to scroll, slide left for the mouse');
    assert.equal(await page.evaluate(() => localStorage.getItem('h5-mouse-ball-hinted')), 'shown', 'remembered for this device');
    const hintBox = await hint.boundingBox();
    const hintFits = await page.evaluate(() => { const el = document.getElementById('h5-mouse-ball-hint'); return { scroll: el.scrollWidth, client: el.clientWidth }; });
    assert.ok(hintFits.scroll <= hintFits.client + 1, `the hint's text fits in its pill on one line (${JSON.stringify(hintFits)})`);
    assert.ok(hintBox.x >= 0 && hintBox.x + hintBox.width <= 390 - 24 + 0.5 && hintBox.y + hintBox.height <= hd.bar.y - 32 + 0.5 && hintBox.y >= hd.box.top, `above the handle, inside the screen (${JSON.stringify(hintBox)})`);
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('h5-mouse-ball-hint')).pointerEvents), 'none', 'it takes no touch');
    await shot('hint');
    await hint.waitFor({ state: 'hidden', timeout: 6000 });

    await page.locator('#h5-header-more').tap();
    await page.locator('#h5-header-more-menu').waitFor();
    assert.equal(await page.locator('#h5-mouse-ball-switch').count(), 0, 'no Mouse ball switch in the More menu');
    const programRow = page.locator('#h5-mouse-ball-program');
    await programRow.waitFor({ state: 'visible' });
    assert.equal(await programRow.getAttribute('role'), 'menuitemcheckbox');
    assert.equal(await programRow.getAttribute('aria-checked'), 'true', 'on by default');
    assert.match(await programRow.innerText(), /Mouse ball sends the mouse to programs\s+Off: the page selects\. On: a program with mouse reporting, such as Claude Code in full screen, selects by itself\./);
    const rowBox = await programRow.boundingBox();
    const menuBox = await page.locator('#h5-header-more-menu .MuiPaper-root').boundingBox();
    assert.ok(rowBox.height >= 44 && rowBox.x >= menuBox.x - 0.5 && rowBox.x + rowBox.width <= menuBox.x + menuBox.width + 0.5 && menuBox.x >= 0 && menuBox.x + menuBox.width <= 390, `a 44px row inside the menu, on the screen (${JSON.stringify({ rowBox, menuBox })})`);
    await page.keyboard.press('Escape');
    await page.locator('#h5-header-more-menu').waitFor({ state: 'detached' });

    // ── The terminal keeps its own touch scrolling; the handle scrolls too ──
    const g = await grid();
    assert.equal(await page.locator('#h5-wheel').count(), 0, 'the old wheel strip is gone');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.h5-xterm:not([hidden])')).touchAction), 'pan-y', 'the terminal keeps its own touch handling');
    const scrollTop = () => page.evaluate(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport').scrollTop);
    const toBottom = async () => { await page.evaluate(() => { document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport').scrollTop = 1e9; }); await page.waitForTimeout(150); };
    const states = () => page.evaluate(() => window.ballStates.splice(0));
    await page.evaluate(() => {
      window.ballStates = [];
      new MutationObserver(() => { const s = document.getElementById('h5-mouse-ball')?.dataset.state; if (s && s !== window.ballStates.at(-1)) window.ballStates.push(s); })
        .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-state'] });
      // The handle's own states, in order (scroll, spring, idle, move, snap).
      window.handleStates = [];
      new MutationObserver(() => { const s = document.getElementById('h5-mouse-handle')?.dataset.state; if (s && s !== window.handleStates.at(-1)) window.handleStates.push(s); })
        .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-state'] });
      // Clicks that reach the page outside the handle (the terminal, the document).
      window.passed = [];
      document.addEventListener('click', event => window.passed.push(event.target.className || event.target.tagName));
    });
    const handleStates = () => page.evaluate(() => window.handleStates.splice(0));
    const handleClean = () => page.waitForFunction(() => {
      const el = document.getElementById('h5-mouse-handle');
      const ball = document.getElementById('h5-mouse-ball');
      return !el.dataset.mouse && el.dataset.state === 'idle' && ball.dataset.state === 'idle' && getComputedStyle(ball).display === 'none';
    }, null, { timeout: 3000 });
    const atRest = async () => {
      await handleClean();
      const now = await handleBox();
      assert.ok(Math.abs(now.bar.x - handleHome.bar.x) < 0.5 && Math.abs(now.bar.y - handleHome.bar.y) < 0.5 && now.bar.w === 11 && now.dir === '', `the handle is back at its place (${JSON.stringify(now.bar)})`);
      assert.ok(now.chevrons.every(c => c.display === 'none'), 'no chevrons at rest');
    };

    // ── A vertical drag on the handle scrolls: up = older; it follows the finger, blue with its chevrons; turning sideways stays a scroll ──
    await toBottom();
    await handleStates();
    let t0 = await handlePoint();
    const bottomTop = await scrollTop();
    assert.ok(bottomTop > 0, 'there is history to scroll');
    await touch('touchStart', t0.x, t0.y);
    await glide(t0, { x: t0.x - 4, y: t0.y - 150 }, { steps: 10 }); // a little sideways on the way: still a scroll
    let hsc = await handleBox();
    assert.deepEqual([hsc.state, hsc.dir, hsc.bar.bg], ['scroll', 'up', 'rgba(144, 202, 249, 0.9)'], 'scrolling up: highlighted blue');
    assert.ok(Math.abs(hsc.bar.y - (t0.y - 150)) < 0.5, `the handle follows the finger (${hsc.bar.y}, ${t0.y - 150})`);
    assert.ok(hsc.chevrons.every(c => c.display === 'block'), 'the chevrons above and below it');
    assert.ok(hsc.chevrons[0].y < hsc.bar.y - 32 && hsc.chevrons[1].y > hsc.bar.y + 32, `one above, one below (${JSON.stringify(hsc.chevrons)})`);
    assert.equal(hsc.chevrons[0].color, 'rgb(144, 202, 249)', 'the chevron of the pull\'s direction is blue');
    assert.notEqual(hsc.chevrons[1].color, 'rgb(144, 202, 249)', 'the other one is not');
    await shot('handle-scroll');
    await page.waitForFunction(top => document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport').scrollTop < top - 50, bottomTop, { timeout: 3000 });
    await glide({ x: t0.x - 4, y: t0.y - 150 }, { x: t0.x - 90, y: t0.y - 150 }, { steps: 8 }); // a vertical start that turns sideways
    await page.waitForTimeout(700); // longer than the long press: scrolling never becomes the move
    assert.deepEqual((await states()).filter(name => name !== 'idle'), [], 'the mouse never came out');
    assert.equal((await handleBox()).state, 'scroll', 'still a scroll, never the move');
    await touch('touchEnd');
    assert.equal((await handleBox()).state, 'spring', 'it springs back');
    await atRest();
    assert.deepEqual(await handleStates(), ['scroll', 'spring', 'idle'], 'scroll, spring back, rest: no move, no snap');
    const stopped = await scrollTop();
    assert.ok(stopped < bottomTop - 50, 'it scrolled back');
    await page.waitForTimeout(300);
    assert.equal(await scrollTop(), stopped, 'the scrolling stops on the lift');
    // Pulled down: newer lines.
    t0 = await handlePoint();
    await touch('touchStart', t0.x, t0.y);
    await glide(t0, { x: t0.x, y: t0.y + 120 }, { steps: 8 });
    assert.equal((await handleBox()).dir, 'down');
    await page.waitForFunction(top => document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport').scrollTop > top + 20, stopped, { timeout: 3000 });
    await touch('touchEnd');
    await atRest();
    assert.deepEqual((await states()).filter(name => name !== 'idle'), [], 'no mouse from a downward pull');
    await toBottom();
    // A tap on the handle does nothing: no click reaches the terminal, nothing scrolls, nothing comes out.
    await page.waitForTimeout(450);
    await page.evaluate(() => window.passed.splice(0));
    const tapTop = await scrollTop();
    t0 = await handlePoint();
    await touch('touchStart', t0.x, t0.y);
    await touch('touchEnd');
    await page.waitForTimeout(300);
    assert.deepEqual(await page.evaluate(() => window.passed.slice()), [], 'no click passes the handle');
    assert.equal(await scrollTop(), tapTop, 'a tap scrolls nothing');
    assert.deepEqual((await states()).filter(name => name !== 'idle'), [], 'a tap is no mouse');
    // A slide toward the right edge does nothing.
    await touch('touchStart', t0.x - 20, t0.y);
    await glide({ x: t0.x - 20, y: t0.y }, { x: t0.x + 4, y: t0.y + 2 }, { steps: 4 });
    await touch('touchEnd');
    await page.waitForTimeout(100);
    assert.deepEqual((await states()).filter(name => name !== 'idle'), [], 'a slide toward the edge is no mouse');
    assert.equal(await scrollTop(), tapTop, 'and no scroll');
    await atRest();
    await handleStates();

    // ── A slide to the left: 25px stretches the handle, lifting then springs it back and does nothing ──
    t0 = await handlePoint();
    const scroll0 = await scrollTop();
    await touch('touchStart', t0.x, t0.y);
    await glide(t0, { x: t0.x - 25, y: t0.y }, { steps: 5 });
    let pull = await page.evaluate(() => {
      const ball = document.getElementById('h5-mouse-ball');
      const tail = document.querySelector('.h5-mouse-ball-tail');
      return { state: ball.dataset.state, progress: Number(ball.dataset.progress), tail: getComputedStyle(tail).display, size: ball.getBoundingClientRect().width };
    });
    let hs = await handleBox();
    assert.equal(pull.state, 'stretch', 'stretched, not out yet');
    assert.ok(Math.abs(pull.progress - 25 / 40) < 0.03, `progress 25 / 40 (${pull.progress})`);
    assert.deepEqual([hs.mouse, hs.bar.bg], ['stretch', 'rgba(144, 202, 249, 0.9)'], 'the handle is highlighted while it is pulled');
    assert.notEqual(pull.tail, 'none', 'the tail from the handle');
    assert.ok(pull.size > 11 && pull.size < 52, `the head grows toward the ball (${pull.size})`);
    await shot('pull');
    await touch('touchEnd');
    await handleClean();
    assert.deepEqual(await states(), ['stretch', 'glide', 'idle'], 'it springs back into the handle');
    assert.deepEqual(await copied(), [], 'nothing copied');
    assert.equal(await scrollTop(), scroll0, 'nothing scrolled');
    assert.equal((await ui()).selected, 0, 'nothing selected');

    // ── Past 40px it lets go: the ball ──
    t0 = await handlePoint();
    await touch('touchStart', t0.x, t0.y);
    await glide(t0, { x: t0.x - 45, y: t0.y }, { steps: 5 });
    await page.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'drag');
    assert.equal((await handleBox()).mouse, 'ball');
    const out = await ballBox();
    assert.equal(out.w, 52, 'the 52px ball');
    assert.ok(Math.abs(out.x - (t0.x - 45)) < 0.5 && Math.abs(out.y - t0.y) < 0.5, 'under the finger');
    await touch('touchEnd');
    await handleClean();
    assert.equal(await scrollTop(), scroll0, 'the slide did not scroll');
    await states();
    const idle = await ui();
    assert.equal(idle.state, 'idle');
    assert.equal(idle.overlay, 'none', 'no cursor while idle');
    await shot('idle');

    // ── Drag: the cursor shows 46px left of and above the ball; holding still presses; a drag selects; the lift copies ──
    const press1 = at(g, 8, 2);
    const finger1 = fingerFor(press1);
    await enter(finger1);
    let view = await ui();
    assert.equal(view.state, 'drag');
    assert.equal(view.overlay, 'block', 'the cursor is shown');
    const ball1 = await ballBox();
    assert.ok(Math.abs(ball1.x - finger1.x) < 0.5 && Math.abs(ball1.y - finger1.y) < 0.5, 'the ball follows the finger');
    assert.ok(Math.abs(view.cursor.x - (ball1.x - 46)) < 0.5 && Math.abs(view.cursor.y - (ball1.y - 46)) < 0.5, `the cursor is 46px up and left (${JSON.stringify(view.cursor)})`);
    assert.deepEqual(view.line.map(Math.round), [view.cursor.x, view.cursor.y, ball1.x, ball1.y].map(Math.round), 'the dashed line joins them');
    assert.notEqual(view.dash, 'none');
    assert.equal(view.pressed, 'false');
    const still = Date.now(); // a little after the last move (the checks above take a few dozen ms)
    await page.waitForTimeout(200);
    view = await ui();
    if (Date.now() - still < 550) assert.equal(view.state, 'drag', 'not pressed before 600 ms');
    assert.ok(Number(view.ring) > 0, 'the ring fills while waiting');
    await page.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'pressed', null, { timeout: 3000 });
    assert.ok(Date.now() - still >= 500, `pressed only after 600 ms still (${Date.now() - still})`);
    view = await ui();
    assert.equal(view.state, 'pressed', 'pressed after 600 ms still');
    assert.equal(await page.locator('#h5-mouse-ball-status').innerText(), 'Selecting in the page', 'the pill says where the button went');
    assert.equal(view.pressed, 'true');
    assert.equal(view.ring, '1');
    assert.equal(view.color, 'rgb(144, 202, 249)', 'the cursor is blue while pressed');
    assert.equal(view.copyView, false, 'no copy view opened (the terminal has no long press any more)');
    await shot('press');
    const select1 = at(g, 12, 3);
    await glide(finger1, fingerFor(select1));
    view = await ui();
    assert.ok(view.selected > 0, 'xterm draws the selection while dragging');
    await shot('select');
    await touch('touchEnd');
    const glideTo = await page.evaluate(() => /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(document.getElementById('h5-mouse-ball').style.transform).slice(1).map(Number));
    const expected1 = `${ROW1.slice(8)}\n${ROW2.slice(0, 12)}`;
    await page.waitForFunction(() => window.copied.length === 1);
    assert.deepEqual(await copied(), [expected1], 'the lift copies the selection');
    const said = await notices();
    assert.deepEqual(said, [[`Copied ${expected1.length} characters`, 'success']], 'the notice of every terminal copy');
    view = await ui();
    assert.ok(view.selected > 0, 'the highlight stays after the copy');
    assert.ok(Math.abs(glideTo[0] + 26 - handleHome.bar.x) < 1 && Math.abs(glideTo[1] + 26 - handleHome.bar.y) < 1 && Math.abs(glideTo[2] - 11 / 52) < 0.01, `it glides back to the handle, as wide as its bar (${glideTo})`);
    await dockedAgain();
    assert.deepEqual((await states()).slice(-3), ['pressed', 'glide', 'idle'], 'the ball glides back into the handle');
    await atRest();
    await shot('copied');

    // ── A touch on the handle during the glide works at once (a scroll) ──
    await toBottom();
    await enter({ x: 200, y: 300 });
    await touch('touchEnd');
    let t1 = await handlePoint();
    await touch('touchStart', t1.x, t1.y);
    const during = await page.evaluate(() => ({ state: document.getElementById('h5-mouse-ball').dataset.state, mouse: document.getElementById('h5-mouse-handle').dataset.mouse || '' }));
    assert.deepEqual(during, { state: 'idle', mouse: '' }, 'the glide is over at once and the handle has the new touch');
    const beforeScroll = await scrollTop();
    await glide(t1, { x: t1.x, y: t1.y - 120 }, { steps: 8 });
    await page.waitForFunction(top => document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport').scrollTop < top, beforeScroll, { timeout: 3000 });
    await touch('touchEnd');
    await toBottom();
    await atRest();
    await states();

    // ── The edge fade: the cursor reaches the last column ──
    const press2 = at(g, 3, 4);
    await enter(fingerFor(press2));
    await page.waitForTimeout(800);
    assert.equal((await ui()).state, 'pressed');
    const edgeFinger = { x: 389.5, y: fingerFor(press2).y };
    await glide(fingerFor(press2), edgeFinger, { steps: 12 });
    view = await ui();
    assert.ok(view.cursor.x >= g.left + (g.cols - 0.5) * g.cw, `the cursor is over the last column (${view.cursor.x}, last column from ${g.left + (g.cols - 1) * g.cw})`);
    await shot('edge');
    await touch('touchEnd');
    await page.waitForFunction(() => window.copied.length === 2);
    assert.equal((await copied())[1], `${'W'.repeat(g.cols - 4)}Z`, 'the selection runs to the last column');
    await notices();
    await dockedAgain();

    // ── A drag without the dwell copies nothing ──
    await page.evaluate(() => document.querySelector('.h5-xterm:not([hidden])').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await enter({ x: 200, y: 200 }, { steps: 10, ms: 50 });
    await glide({ x: 200, y: 200 }, { x: 150, y: 300 }, { steps: 6, ms: 50 });
    await shot('drag');
    await touch('touchEnd');
    await page.waitForTimeout(200);
    assert.equal((await copied()).length, 2, 'a plain drag only moves the cursor: nothing copied');
    await dockedAgain();

    // ── A cancelled touch copies nothing and leaves no selection ──
    await enter(fingerFor(press1));
    await page.waitForTimeout(800);
    assert.equal((await ui()).state, 'pressed');
    await glide(fingerFor(press1), fingerFor(select1));
    assert.ok((await ui()).selected > 0);
    await touch('touchCancel');
    await page.waitForTimeout(200);
    assert.equal((await copied()).length, 2, 'a cancelled touch copies nothing');
    await dockedAgain();
    assert.equal((await ui()).selected, 0, 'and leaves no selection');

    // ── The terminal does not scroll under the ball; a held button near the top edge scrolls it, the selection keeps its start ──
    await emit(`\r\n${Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\r\n')}`);
    await toBottom(); // the output since the history above follows only a view at the bottom
    const bottom = await scrollTop();
    assert.ok(bottom > 0, 'there is history above');
    await enter({ x: 250, y: 150 }, { steps: 10 });
    await glide({ x: 250, y: 150 }, { x: 250, y: 600 }, { steps: 10 });
    await touch('touchEnd');
    await page.waitForTimeout(200);
    assert.equal(await scrollTop(), bottom, 'dragging the ball does not scroll the terminal');
    await dockedAgain();
    const g2 = await grid();
    const midRow = Math.floor(g2.rows / 2);
    const lineAt = row => page.evaluate(row => document.querySelectorAll('.h5-xterm:not([hidden]) .xterm-rows > div')[row].textContent.trim(), midRow);
    const pressedLine = Number((await lineAt(midRow)).replace(/\D+/g, ''));
    const press3 = at(g2, 0, midRow);
    await enter(fingerFor(press3));
    await page.waitForTimeout(800);
    assert.equal((await ui()).state, 'pressed');
    assert.equal(await scrollTop(), bottom, 'holding still does not scroll');
    const nearTop = { x: press3.x + 46 + 20, y: g2.top + 4 + 46 };
    await glide(fingerFor(press3), nearTop);
    await page.waitForTimeout(700);
    const scrolled = await scrollTop();
    assert.ok(scrolled < bottom - g2.ch * 5, `a held button near the top edge scrolls back (${bottom} -> ${scrolled})`);
    await touch('touchEnd');
    await page.waitForFunction(() => window.copied.length === 3);
    const text3 = (await copied())[2];
    const numbers = text3.split('\n').map(row => Number(row.replace(/\D+/g, '')));
    assert.ok(numbers.length > 8, `several lines are copied (${numbers.length})`);
    assert.equal(numbers.at(-1), pressedLine - 1, `the selection still ends where the button went down (line ${pressedLine}, the boundary before its first column)`);
    assert.ok(numbers[0] < pressedLine - 8, 'and starts at an older line');
    await notices();
    await dockedAgain();

    // ── A write the browser refuses: the copy bar, as for the double tap ──
    await page.evaluate(() => { window.refuse = true; });
    await enter(fingerFor(at(g2, 0, 2)));
    await page.waitForTimeout(800);
    await glide(fingerFor(at(g2, 0, 2)), fingerFor(at(g2, 6, 2)));
    await touch('touchEnd');
    await page.locator('#h5-clipboard-bar').waitFor({ state: 'visible' });
    assert.match(await page.locator('#h5-clipboard-bar').textContent(), /Press Copy to finish copying/);
    await page.evaluate(() => { window.refuse = false; });
    await page.locator('#h5-clipboard-bar button', { hasText: /^Copy$/ }).tap();
    await page.waitForFunction(() => window.copied.length === 4);
    assert.match((await copied())[3], /^line \d/, 'its Copy writes the selection');
    await notices();

    // ── A paragraph that a program wrapped itself (hard line breaks at the width) is copied as one line ──
    const gw = await grid();
    const words = 'She worked hard to accomplish her goal before the deadline and then wrote down every step so that nobody else would have to guess how it was done'.split(' ');
    const wrapped = [];
    let current = '';
    for (const word of words) {
      if (current && current.length + 1 + word.length > gw.cols) { wrapped.push(current); current = word; } else current = current ? `${current} ${word}` : word;
    }
    wrapped.push(current);
    assert.ok(wrapped.length >= 3, `the paragraph wraps over several rows (${wrapped.length})`);
    await emit(`\x1b[2J\x1b[H\r\n\r\n\r\n\r\n${wrapped.join('\r\n')}\r\n$ `); // from row 4: the first rows are the zone where a held button scrolls
    await page.evaluate(() => { document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport').scrollTop = 1e9; }); // the earlier checks left the view scrolled back
    await page.waitForTimeout(200);
    const firstRow = 4;
    const lastRow = firstRow + wrapped.length - 1;
    await enter(fingerFor(at(gw, 0, firstRow)));
    await page.waitForTimeout(800);
    await glide(fingerFor(at(gw, 0, firstRow)), fingerFor(at(gw, wrapped.at(-1).length, lastRow)));
    await touch('touchEnd');
    await page.waitForFunction(() => window.copied.length === 5);
    assert.equal((await copied())[4], words.join(' '), 'the rows the program cut are one line again, with one space at each break');
    await notices();
    await dockedAgain();

    // ── A program with mouse reporting on (drag tracking, SGR): with the default (the device's choice not 'off') the ball drives the program's own selection ──
    assert.deepEqual(await programSwitch(), { before: 'true', shown: 'true' }, 'the switch is on by default');
    assert.equal(await page.evaluate(() => localStorage.getItem('h5-mouse-ball-program')), null, 'with no key stored');
    await emit(`\x1b[2J\x1b[HMOUSE MODE\r\n${ROW1}\r\n${ROW2}\r\n`);
    await page.evaluate(() => { document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport').scrollTop = 1e9; });
    await page.evaluate(() => document.querySelector('.h5-xterm:not([hidden])').dispatchEvent(new MouseEvent('click', { bubbles: true }))); // no old highlight
    await emit('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
    let gm = await grid();
    const mid = (col, row) => ({ x: gm.left + (col + 0.5) * gm.cw, y: gm.top + (row + 0.5) * gm.ch }); // the middle of a cell
    // The SGR mouse reports the page sent since `from`: [button, col, row, 'M' (press, motion) or 'm' (release)], 1-based screen cells.
    const sentCount = () => page.evaluate(() => window.sockets.at(-1).sent.length);
    const reports = from => page.evaluate(from => window.sockets.at(-1).sent.slice(from).flatMap(item => [...item.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)].map(m => [Number(m[1]), Number(m[2]), Number(m[3]), m[4]])), from);
    const pageScroll = await scrollTop();
    let from = await sentCount();
    const copiesBefore = (await copied()).length;
    await enter(fingerFor(mid(8, 6)));
    assert.deepEqual(await reports(from), [], 'moving the ball without the button sends nothing');
    await page.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'pressed', null, { timeout: 3000 });
    view = await ui();
    assert.equal(await page.locator('#h5-mouse-ball').getAttribute('data-mode'), 'program', 'the button went to the program');
    assert.equal(await page.locator('#h5-mouse-ball-status').innerText(), 'Mouse sent to the program', 'the pill says so');
    assert.equal(view.color, 'rgb(144, 202, 249)', 'the same pressed look');
    assert.deepEqual(await reports(from), [[0, 9, 7, 'M']], 'the press at the dwell, at the cursor cell; no hover in mode 1002');
    await glide(fingerFor(mid(8, 6)), fingerFor(mid(14, 8)));
    let sent = await reports(from);
    assert.ok(sent.slice(1).length >= 2 && sent.slice(1).every(r => r[0] === 32 && r[3] === 'M'), `motions with the left button held (${JSON.stringify(sent)})`);
    assert.deepEqual(sent.at(-1), [32, 15, 9, 'M'], 'the last motion is at the cursor cell');
    view = await ui();
    assert.equal(view.selected, 0, 'no page selection: the program draws its own');
    await shot('program');
    await touch('touchEnd');
    await page.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'idle');
    sent = await reports(from);
    assert.deepEqual(sent.at(-1), [0, 15, 9, 'm'], 'the release at the lift');
    assert.equal(sent.filter(r => r[3] === 'm').length, 1, 'one release');
    // The program copies on the release (OSC 52): the lift counted as the gesture, so it is written at once with the notice.
    await emit(`\x1b]52;c;${Buffer.from('program copy').toString('base64')}\x07`);
    await page.waitForFunction(n => window.copied.length === n + 1, copiesBefore);
    assert.deepEqual((await copied()).slice(copiesBefore), ['program copy'], 'only the program copied; the ball did not');
    assert.deepEqual(await notices(), [['Copied 12 characters', 'success']]);
    assert.equal(await page.locator('#h5-clipboard-bar').count(), 0, 'no request bar');
    assert.equal(await scrollTop(), pageScroll, 'the page did not scroll');
    // Without a recent gesture the same kind of copy waits on the request bar (what the lift's gesture mark avoided above).
    await page.waitForTimeout(1600);
    await emit(`\x1b]52;c;${Buffer.from('later copy').toString('base64')}\x07`);
    await page.locator('#h5-clipboard-bar').waitFor({ state: 'visible' });
    await page.locator('#h5-clipboard-bar button', { hasText: /^Cancel$/ }).tap();
    await page.locator('#h5-clipboard-bar').waitFor({ state: 'detached' });
    await page.waitForTimeout(300); // the terminal takes its height back
    gm = await grid();
    assert.equal((await copied()).length, copiesBefore + 1);
    await dockedAgain();

    // The edge scroll sends wheel steps at the cursor to the program; the page view does not move.
    from = await sentCount();
    await enter(fingerFor(mid(5, 8)));
    await page.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'pressed', null, { timeout: 3000 });
    await glide(fingerFor(mid(5, 8)), { x: mid(5, 0).x + 46, y: gm.top + 4 + 46 });
    await page.waitForTimeout(500);
    sent = await reports(from);
    const wheelUps = sent.filter(r => r[0] === 64);
    assert.ok(wheelUps.length >= 3, `wheel-up reports near the top edge (${JSON.stringify(sent)})`);
    const zoneRows = Math.floor(24 / gm.ch) + 1; // the rows of the 24px scroll zone (1-based)
    assert.ok(wheelUps.every(r => r[1] === 6 && r[2] <= zoneRows && r[3] === 'M'), `at the cursor, in the zone (${JSON.stringify(wheelUps)})`);
    assert.equal(wheelUps.at(-1)[2], 1, 'the last ones on the first row');
    assert.equal(await scrollTop(), pageScroll, 'the page view stays: the program scrolls its own');
    assert.equal((await ui()).selected, 0);
    await touch('touchEnd');
    await page.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'idle');
    assert.equal((await reports(from)).at(-1)[3], 'm', 'released at the lift');
    await dockedAgain();

    // The program turns mouse reporting off in the middle of a gesture: the gesture stays the program's (no page selection, no copy).
    from = await sentCount();
    await enter(fingerFor(mid(8, 1)));
    await page.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'pressed', null, { timeout: 3000 });
    assert.deepEqual(await reports(from), [[0, 9, 2, 'M']]);
    await emit('\x1b[?1000l\x1b[?1002l\x1b[?1006l');
    await glide(fingerFor(mid(8, 1)), fingerFor(mid(12, 2)));
    assert.equal(await page.locator('#h5-mouse-ball').getAttribute('data-mode'), 'program', 'the mode of the press is kept');
    assert.equal((await ui()).selected, 0, 'no page selection in the middle of the gesture');
    await touch('touchEnd');
    await page.waitForTimeout(200);
    assert.deepEqual(await reports(from), [[0, 9, 2, 'M']], 'xterm drops what the program no longer asks for');
    assert.equal((await copied()).length, copiesBefore + 1, 'nothing copied');
    await dockedAgain();

    // ── The bytes of a real mouse: with any-event tracking (1003) and focus reports (1004) the ball sends what a mouse would ──
    // Seen with a real mouse in this page: a hover at the cell first, ESC[I when the click focuses the terminal, the press, drags, the release.
    await emit(`\x1b[2J\x1b[H\r\nMOUSE MODE\r\n${ROW1}\r\n${ROW2}\r\n\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h`);
    await page.evaluate(() => { document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport').scrollTop = 1e9; if (document.activeElement) document.activeElement.blur(); });
    await page.waitForTimeout(200);
    gm = await grid();
    // Every mouse report and focus report the page sent since `from`, in order: [button, col, row, M/m] or 'I' / 'O'.
    const events = from => page.evaluate(from => window.sockets.at(-1).sent.slice(from).flatMap(item => [...item.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[([IO])/g)]
      .map(m => (m[5] ? m[5] : [Number(m[1]), Number(m[2]), Number(m[3]), m[4]]))), from);
    from = await sentCount();
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.h5-xterm:not([hidden]) textarea')), false, 'the terminal has no focus');
    await enter(fingerFor(mid(8, 6)));
    let seen = await events(from);
    assert.ok(seen.length >= 2 && seen.every(e => Array.isArray(e) && e[0] === 35 && e[3] === 'M'), `hover moves with no button while the ball is out (${JSON.stringify(seen)})`);
    assert.deepEqual(seen.at(-1), [35, 9, 7, 'M'], 'the last hover at the cursor cell');
    assert.equal(new Set(seen.map(e => `${e[1]};${e[2]}`)).size, seen.length, 'one hover per cell');
    await page.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'pressed', null, { timeout: 3000 });
    seen = await events(from);
    const press = seen.findIndex(e => Array.isArray(e) && e[0] === 0);
    assert.ok(press > 0, `a press (${JSON.stringify(seen)})`);
    assert.deepEqual(seen.slice(press - 1), ['I', [0, 9, 7, 'M']], 'the focus, then the press at the hovered cell');
    assert.equal(seen.filter(e => e === 'I').length, 1, 'one focus report');
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.h5-xterm:not([hidden]) textarea')), true, 'the terminal has the focus');
    await glide(fingerFor(mid(8, 6)), fingerFor(mid(14, 8)));
    await touch('touchEnd');
    await page.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'idle');
    await page.waitForTimeout(200);
    seen = await events(from);
    const after = seen.slice(press + 1);
    assert.ok(after.length >= 3 && after.slice(0, -1).every(e => Array.isArray(e) && e[0] === 32 && e[3] === 'M'), `drags with the button held (${JSON.stringify(after)})`);
    assert.deepEqual(after.at(-1), [0, 15, 9, 'm'], 'the release at the lift, and nothing after it');
    await dockedAgain();
    // A second press while the terminal has the focus: no focus report again.
    await page.waitForTimeout(1600); // past the gesture window of the lift above
    from = await sentCount();
    await enter(fingerFor(mid(5, 3)));
    await page.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'pressed', null, { timeout: 3000 });
    await touch('touchEnd');
    await page.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'idle');
    seen = await events(from);
    assert.ok(!seen.includes('I') && seen.some(e => e[0] === 0 && e[3] === 'M') && seen.at(-1)[3] === 'm', `the focus was there already (${JSON.stringify(seen)})`);
    await dockedAgain();
    await emit('\x1b[?1003l\x1b[?1004l');

    // Switched off in the More menu: the page selects even while the program has mouse reporting on (the default; Claude Code did not select with
    // the synthetic mouse of the ball), so the text is chosen and copied by the page and nothing reaches the program.
    assert.deepEqual(await programSwitch(false), { before: 'true', shown: 'false' }, 'the switch turns off');
    assert.equal(await page.evaluate(() => localStorage.getItem('h5-mouse-ball-program')), 'off', 'kept for this device');
    await emit(`\x1b[2J\x1b[H\r\nMOUSE MODE\r\n${ROW1}\r\n${ROW2}\r\n\x1b[?1000h\x1b[?1002h\x1b[?1006h`);
    await page.evaluate(() => { document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport').scrollTop = 1e9; });
    await page.waitForTimeout(200);
    gm = await grid();
    from = await sentCount();
    await enter(fingerFor(at(gm, 8, 2)));
    await page.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'pressed', null, { timeout: 3000 });
    assert.equal(await page.locator('#h5-mouse-ball').getAttribute('data-mode'), 'page', 'reporting on, switch off: the page gets the button');
    assert.equal(await page.locator('#h5-mouse-ball-status').innerText(), 'Selecting in the page');
    await glide(fingerFor(at(gm, 8, 2)), fingerFor(at(gm, 12, 3)));
    assert.ok((await ui()).selected > 0, 'the page draws its selection');
    await touch('touchEnd');
    await page.waitForFunction(n => window.copied.length === n + 2, copiesBefore);
    assert.equal((await reports(from)).length, 0, 'nothing is sent to the program');
    await notices();
    await dockedAgain();
    await emit('\x1b[?1000l\x1b[?1002l\x1b[?1006l');

    // Reporting off: the page selection and copy work again (the request bar above changed the terminal's height for a while: fresh text and cells).
    await emit(`\x1b[2J\x1b[H\r\nMOUSE MODE\r\n${ROW1}\r\n${ROW2}\r\n`);
    await page.evaluate(() => { document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport').scrollTop = 1e9; });
    await page.waitForTimeout(200);
    gm = await grid();
    from = await sentCount();
    await enter(fingerFor(at(gm, 8, 2)));
    await page.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'pressed', null, { timeout: 3000 });
    assert.equal(await page.locator('#h5-mouse-ball').getAttribute('data-mode'), 'page');
    await glide(fingerFor(at(gm, 8, 2)), fingerFor(at(gm, 12, 3)));
    assert.ok((await ui()).selected > 0, 'the page draws its selection again');
    await touch('touchEnd');
    await page.waitForFunction(n => window.copied.length === n + 3, copiesBefore);
    assert.equal((await copied()).at(-1), expected1, 'and the lift copies it');
    assert.deepEqual(await reports(from), [], 'no mouse reports');
    await notices();
    await dockedAgain();

    // ── A full-screen program (the alternate buffer): the handle scrolls the program with wheel events; the ball comes out the same way ──
    await emit(`\x1b[?1049h\x1b[H\x1b[2JSPRING\r\n${ROW1}\r\n${ROW2}\r\n`);
    await page.waitForFunction(() => window.H5UI && document.querySelector('.h5-xterm:not([hidden]) .xterm-rows').textContent.includes('SPRING'));
    const gs = await grid();
    const sentText = from => page.evaluate(from => window.sockets.at(-1).sent.slice(from).filter(item => !item.startsWith('{')).join(''), from);
    // Without mouse mode xterm turns the wheel steps into arrow keys: pulled up, up arrows; pulled down, down arrows.
    let ts = await handlePoint();
    from = await sentCount();
    await touch('touchStart', ts.x, ts.y);
    await glide(ts, { x: ts.x, y: ts.y - 120 }, { steps: 8 });
    await page.waitForFunction(from => window.sockets.at(-1).sent.slice(from).some(item => /\x1b[\[O]A/.test(item)), from, { timeout: 3000 });
    await touch('touchEnd');
    await atRest();
    let arrows = await sentText(from);
    assert.ok(/^(\x1b[\[O]A)+$/.test(arrows), `pulled up: only up arrows to the program (${JSON.stringify(arrows)})`);
    const settled = await sentCount();
    await page.waitForTimeout(300);
    assert.equal(await sentCount(), settled, 'nothing more after the lift');
    from = await sentCount();
    ts = await handlePoint();
    await touch('touchStart', ts.x, ts.y);
    await glide(ts, { x: ts.x, y: ts.y + 120 }, { steps: 8 });
    await page.waitForFunction(from => window.sockets.at(-1).sent.slice(from).some(item => /\x1b[\[O]B/.test(item)), from, { timeout: 3000 });
    await touch('touchEnd');
    await atRest();
    arrows = await sentText(from);
    assert.ok(/^(\x1b[\[O]B)+$/.test(arrows), `pulled down: only down arrows (${JSON.stringify(arrows)})`);
    // With mouse reporting on, the same pull reaches the program as SGR wheel reports (64 up, 65 down), and the page's view does not move.
    await emit('\x1b[?1000h\x1b[?1006h');
    from = await sentCount();
    ts = await handlePoint();
    await touch('touchStart', ts.x, ts.y);
    await glide(ts, { x: ts.x, y: ts.y - 120 }, { steps: 8 });
    await page.waitForFunction(from => window.sockets.at(-1).sent.slice(from).some(item => /\x1b\[<64;/.test(item)), from, { timeout: 3000 });
    await touch('touchEnd');
    await atRest();
    const wheelReports = (await reports(from)).filter(r => r[0] === 64 || r[0] === 65);
    assert.ok(wheelReports.length > 0 && wheelReports.every(r => r[0] === 64 && r[3] === 'M'), `wheel-up reports (${JSON.stringify(wheelReports)})`);
    assert.ok(wheelReports.every(r => Math.abs(r[1] - Math.ceil(gs.cols / 2)) <= 1), `at the middle column of the visible terminal (${JSON.stringify(wheelReports)})`);
    await emit('\x1b[?1000l\x1b[?1006l');
    await states();
    // Stretched and let go: nothing reaches the program (no wheel steps, no arrow keys).
    ts = await handlePoint();
    from = await sentCount();
    await touch('touchStart', ts.x, ts.y);
    await glide(ts, { x: ts.x - 25, y: ts.y + 3 }, { steps: 5 });
    assert.equal(await page.evaluate(() => document.getElementById('h5-mouse-ball').dataset.state), 'stretch');
    await page.waitForTimeout(300);
    await touch('touchEnd');
    await handleClean();
    assert.equal(await sentCount(), from, 'the stretch sends nothing to the program');
    // Out, pressed, selected, copied, back.
    await enter(fingerFor(at(gs, 8, 1)));
    assert.equal(await sentCount(), from, 'nothing sent while the ball is out');
    await page.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'pressed', null, { timeout: 3000 });
    assert.equal(await page.locator('#h5-mouse-ball').getAttribute('data-mode'), 'page', 'no mouse reporting: the page selects');
    await glide(fingerFor(at(gs, 8, 1)), fingerFor(at(gs, 12, 2)));
    await shot('spring');
    await touch('touchEnd');
    await page.waitForFunction(n => window.copied.length === n + 4, copiesBefore);
    assert.equal((await copied()).at(-1), expected1, 'the same copy in the full-screen program');
    await notices();
    await atRest();
    assert.equal(await sentCount(), from, 'nothing was sent to the program');
    await emit('\x1b[?1049l');


    // (The ball-state observer also fires on the handle's own data-state, which can log the ball's 'idle' once: the checks for 'no ball' leave it out.)
    // ── The mouse handle: a long press moves it, the lift snaps it to the nearest edge; on the left edge everything is mirrored ──
    await emit(`\x1b[2J\x1b[H\r\nHANDLE TEST\r\n${ROW1}\r\n${ROW2}\r\n$ `);
    await toBottom();
    await states();
    await page.evaluate(() => window.copied.splice(0));
    const gh = await grid();
    hd = await handleBox();
    assert.deepEqual([hd.edge, Math.round(hd.bar.y)], ['right', Math.round(handleHome.bar.y)], 'still at its default place');
    // A long press (500 ms still): the handle is picked up (bigger, blue, a shadow), the dashed guides and the pill show, it follows the finger in 2D.
    const tickedBefore = await page.evaluate(() => window.__h5KeyTicks || 0);
    await touch('touchStart', hd.bar.x, hd.bar.y);
    await page.waitForTimeout(250);
    assert.equal((await handleBox()).state, 'idle', 'not before 500 ms');
    await touch('touchMove', hd.bar.x - 2, hd.bar.y + 2); // within the 6px slop: still a hold
    await page.waitForFunction(() => document.getElementById('h5-mouse-handle').dataset.state === 'move', null, { timeout: 2000 });
    let hm = await handleBox();
    assert.deepEqual([hm.bar.w, hm.bar.h, hm.bar.bg], [18, 84, 'rgba(144, 202, 249, 0.9)'], 'bigger and blue');
    assert.notEqual(hm.bar.shadow, 'none', 'lifted with a shadow');
    const guidesBox = await page.evaluate(() => { const el = document.getElementById('h5-mouse-handle-guides'); const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { display: cs.display, left: r.left, right: r.right, top: r.top, bottom: r.bottom, styleL: cs.borderLeftStyle, styleR: cs.borderRightStyle, width: cs.borderLeftWidth }; });
    assert.deepEqual([guidesBox.display, guidesBox.styleL, guidesBox.styleR, guidesBox.width], ['block', 'dashed', 'dashed', '2px'], 'two dashed guides');
    assert.ok(Math.abs(guidesBox.left - hd.box.left) < 0.5 && Math.abs(guidesBox.right - hd.box.right) < 0.5, `at the terminal's two edges (${JSON.stringify(guidesBox)})`);
    const pill = page.locator('#h5-mouse-handle-pill');
    assert.equal(await pill.isVisible(), true);
    assert.equal(await pill.textContent(), 'Let go: it snaps to the nearest edge');
    await glide({ x: hd.bar.x - 2, y: hd.bar.y + 2 }, { x: 100, y: 300 }, { steps: 10 });
    hm = await handleBox();
    assert.ok(Math.abs(hm.bar.x - (100 + 2)) < 1.5 && Math.abs(hm.bar.y - (300 - 2)) < 1.5, `it follows the finger (${JSON.stringify(hm.bar)})`);
    assert.deepEqual((await states()).filter(name => name !== 'idle'), [], 'no ball while it is moved');
    await shot('handle-move');
    // Kept inside the terminal: not into the key row, not over the header.
    await glide({ x: 100, y: 300 }, { x: 100, y: hd.box.bottom + 60 }, { steps: 6 });
    hm = await handleBox();
    assert.ok(Math.abs(hm.bar.y + 42 - hd.box.bottom) < 0.5, `kept above the bottom of the terminal (${hm.bar.y})`);
    await glide({ x: 100, y: hd.box.bottom + 60 }, { x: 100, y: 10 }, { steps: 8 });
    hm = await handleBox();
    assert.ok(Math.abs(hm.bar.y - 42 - hd.box.top) < 0.5, `kept below the header (${hm.bar.y})`);
    await glide({ x: 100, y: 10 }, { x: 100, y: 300 }, { steps: 6 });
    await touch('touchEnd');
    // Let go left of the middle: it glides (160 ms) to the left edge at that height, and the place is kept for this device.
    assert.equal((await handleBox()).state, 'snap');
    assert.equal(await pill.isVisible(), false, 'the pill goes');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('h5-mouse-handle-guides')).display), 'none', 'the guides go');
    await page.waitForFunction(() => document.getElementById('h5-mouse-handle').dataset.state === 'idle', null, { timeout: 2000 });
    hd = await handleBox();
    assert.deepEqual([hd.edge, hd.bar.w, hd.bar.h], ['left', 11, 64], 'snapped to the left edge, at rest');
    assert.ok(Math.abs(hd.bar.x - (hd.box.left + 7.5)) < 0.5 && Math.abs(hd.bar.y - 298) < 1, `2px in from the left edge, at the height it was let go (${JSON.stringify(hd.bar)})`);
    assert.ok(hd.hit.x >= hd.box.left - 0.5 && hd.hit.w >= 44, 'the touch box inside the terminal');
    const kept = JSON.parse(await page.evaluate(() => localStorage.getItem('h5-mouse-handle')));
    assert.equal(kept.edge, 'left');
    assert.ok(Math.abs(kept.y - (298 - hd.box.top) / (hd.box.bottom - hd.box.top)) < 0.002, `the height kept as a fraction of the terminal (${JSON.stringify(kept)})`);
    assert.deepEqual((await states()).filter(name => name !== 'idle'), [], 'no ball from the move');
    assert.deepEqual(await copied(), [], 'nothing copied by the move');
    await shot('handle-left');
    // On the left edge it is mirrored: a slide to the left (toward the edge) does nothing, a slide to the right pulls the ball out.
    await touch('touchStart', hd.bar.x + 20, hd.bar.y);
    await glide({ x: hd.bar.x + 20, y: hd.bar.y }, { x: hd.bar.x - 4, y: hd.bar.y + 2 }, { steps: 4 });
    await touch('touchEnd');
    await page.waitForTimeout(100);
    assert.deepEqual((await states()).filter(name => name !== 'idle'), [], 'a slide toward the left edge is no mouse');
    // A vertical drag on the left handle scrolls as on the right one.
    await emit(`${Array.from({ length: 120 }, (_, i) => `left ${i + 1}`).join('\r\n')}\r\n$ `);
    await toBottom();
    const leftTop = await scrollTop();
    await touch('touchStart', hd.bar.x, hd.bar.y);
    await glide({ x: hd.bar.x, y: hd.bar.y }, { x: hd.bar.x, y: hd.bar.y - 120 }, { steps: 8 });
    assert.deepEqual([(await handleBox()).state, (await handleBox()).dir], ['scroll', 'up']);
    await page.waitForFunction(top => document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport').scrollTop < top - 20, leftTop, { timeout: 3000 });
    await touch('touchEnd');
    await page.waitForFunction(() => document.getElementById('h5-mouse-handle').dataset.state === 'idle', null, { timeout: 2000 });
    const leftBack = await handleBox();
    assert.ok(leftBack.edge === 'left' && Math.abs(leftBack.bar.x - hd.bar.x) < 0.5 && Math.abs(leftBack.bar.y - hd.bar.y) < 0.5, 'back at its place on the left edge');
    assert.deepEqual((await states()).filter(name => name !== 'idle'), [], 'no mouse from the scroll');
    await emit(`\x1b[2J\x1b[H\r\nHANDLE TEST\r\n${ROW1}\r\n${ROW2}\r\n$ `);
    await toBottom();
    await touch('touchStart', hd.bar.x, hd.bar.y);
    await glide({ x: hd.bar.x, y: hd.bar.y }, { x: hd.bar.x + 25, y: hd.bar.y }, { steps: 5 });
    hp = await page.evaluate(() => ({ state: document.getElementById('h5-mouse-ball').dataset.state, progress: Number(document.getElementById('h5-mouse-ball').dataset.progress) }));
    const headX = (await ballBox()).x;
    assert.equal(hp.state, 'stretch');
    assert.ok(Math.abs(hp.progress - 25 / 40) < 0.03, `progress 25 / 40 to the right (${hp.progress})`);
    assert.ok(headX >= hd.bar.x && Math.abs(headX - (hd.bar.x + 25)) < 0.5, `the head under the finger, never left of the handle (${headX})`);
    await glide({ x: hd.bar.x + 25, y: hd.bar.y }, { x: hd.bar.x + 45, y: hd.bar.y }, { steps: 3 });
    await page.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'drag', null, { timeout: 3000 });
    // The cursor reaches the first column and, at the right edge, the last one.
    const first = at(gh, 0, 2);
    await glide({ x: hd.bar.x + 45, y: hd.bar.y }, fingerFor(first));
    view = await ui();
    assert.ok(Math.abs(view.cursor.x - first.x) < 0.5, `the cursor on the first column (${view.cursor.x}, ${first.x})`);
    await page.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'pressed', null, { timeout: 3000 });
    await glide(fingerFor(first), fingerFor(at(gh, 5, 2)));
    await touch('touchEnd');
    const glideLeft = await page.evaluate(() => /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(document.getElementById('h5-mouse-ball').style.transform).slice(1).map(Number));
    await page.waitForFunction(() => window.copied.length === 1);
    assert.equal((await copied())[0], ROW1.slice(0, 5), 'from the first column');
    await notices();
    assert.ok(Math.abs(glideLeft[0] + 26 - hd.bar.x) < 1 && Math.abs(glideLeft[1] + 26 - hd.bar.y) < 1, `it glides back to the handle on the left (${glideLeft})`);
    await page.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'idle' && !document.getElementById('h5-mouse-handle').dataset.mouse, null, { timeout: 3000 });
    await touch('touchStart', hd.bar.x, hd.bar.y);
    await glide({ x: hd.bar.x, y: hd.bar.y }, { x: hd.bar.x + 45, y: hd.bar.y }, { steps: 5 });
    await page.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'drag', null, { timeout: 3000 });
    await glide({ x: hd.bar.x + 45, y: hd.bar.y }, { x: 389.5, y: fingerFor(at(gh, 0, 4)).y }, { steps: 14 });
    view = await ui();
    assert.ok(view.cursor.x >= gh.left + (gh.cols - 0.5) * gh.cw, `the cursor reaches the last column from the left handle too (${view.cursor.x})`);
    await touch('touchEnd');
    await page.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'idle', null, { timeout: 3000 });
    assert.equal((await copied()).length, 1, 'no press, no copy');
    await dockedAgain();
    await states();
    const handleKept = hd;

    // ── No horizontal overflow; after a reload the hint does not come again and the handle is where it was left ──
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
    await page.reload(); // the phone opens the terminal it showed
    await page.waitForFunction(() => window.sockets.length > 0 && window.sockets.at(-1).readyState === 1 && document.querySelector('.h5-xterm:not([hidden]) .xterm-rows'));
    await page.evaluate(history => window.sockets.at(-1).emit(`${history}\r\n$ `), history);
    await page.locator('#h5-mouse-ball').waitFor({ state: 'attached' });
    await page.waitForFunction(() => document.getElementById('h5-mouse-handle')?.style.display === 'block');
    await page.waitForTimeout(1500); // longer than the hint's check
    assert.equal(await page.locator('#h5-mouse-ball-hint').isVisible(), false, 'the hint is shown once per device');
    hd = await handleBox();
    assert.deepEqual([hd.display, hd.edge, Math.round(hd.bar.x), Math.round(hd.bar.y)], ['block', 'left', Math.round(handleKept.bar.x), Math.round(handleKept.bar.y)], 'the handle comes back where it was left on this device');
    // With the handle on the left edge the hint is mirrored (shown again only because the stored mark is removed here).
    await page.evaluate(() => localStorage.removeItem('h5-mouse-ball-hinted'));
    await page.reload();
    await page.waitForFunction(() => window.sockets.length > 0 && window.sockets.at(-1).readyState === 1 && document.querySelector('.h5-xterm:not([hidden]) .xterm-rows'));
    const leftHint = page.locator('#h5-mouse-ball-hint');
    await leftHint.waitFor({ state: 'visible', timeout: 3000 });
    assert.equal(await leftHint.textContent(), 'Drag to scroll, slide right for the mouse');
    const leftHintBox = await leftHint.boundingBox();
    hd = await handleBox();
    assert.ok(leftHintBox.x >= hd.box.left + 24 - 0.5 && leftHintBox.x + leftHintBox.width <= 390, `toward the inside of the left handle, on the screen (${JSON.stringify(leftHintBox)})`);
    await shot('hint-left');
    assert.equal(await page.locator('#h5-mouse-ball-switch').count(), 0);
    assert.deepEqual(errors, [], 'no page errors');
    await context.close();

    // ── Pointer input on a phone-sized window: the chunk is there (the handle is drawn with a mouse too), and the switch in the More menu ──
    const pointer = await openPage(browser, { touch: false });
    await openTerminal(pointer.page, { touch: false });
    await pointer.page.waitForFunction(() => window.H5UI.get().input === 'pointer');
    await pointer.page.locator('#h5-header-more').click();
    await pointer.page.locator('#h5-refresh').waitFor({ state: 'visible' });
    assert.equal(await pointer.page.locator('#h5-term-width').count(), 1, 'the terminal is shown');
    assert.equal(await pointer.page.locator('#h5-mouse-ball-program').getAttribute('aria-checked'), 'true', 'the switch is on the computer too, on by default');
    assert.equal(pointer.chunks.length, 1, 'the chunk is loaded in pointer input too');
    assert.deepEqual(pointer.errors, []);
    await pointer.context.close();

    // ── A normal terminal without history (a fresh shell): the handle is drawn all the same, so the mouse can come out of it ──
    {
      const fresh = await openPage(browser);
      const p = fresh.page;
      await openTerminal(p);
      const fcdp = await fresh.context.newCDPSession(p);
      const ftouch = (type, x, y) => fcdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y }] });
      const fframes = (n = 2) => p.evaluate(n => new Promise(done => { const step = k => (k ? requestAnimationFrame(() => step(k - 1)) : done()); step(n); }), n);
      const femit = async data => { await p.evaluate(data => window.sockets.at(-1).emit(data), data); await fframes(); };
      const fglide = async (from, to, { steps = 8, ms = 16 } = {}) => {
        for (let i = 1; i <= steps; i++) { await ftouch('touchMove', from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps); if (ms) await p.waitForTimeout(ms); }
      };
      const fhandle = () => p.evaluate(() => {
        const el = document.getElementById('h5-mouse-handle');
        const b = el.querySelector('.h5-mouse-handle-bar').getBoundingClientRect();
        const viewport = document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport');
        return { display: getComputedStyle(el).display, state: el.dataset.state, mouse: el.dataset.mouse || '', x: b.left + b.width / 2, y: b.top + b.height / 2, scrollTop: viewport.scrollTop };
      });
      await p.evaluate(() => {
        window.ballStates = [];
        new MutationObserver(() => { const s = document.getElementById('h5-mouse-ball')?.dataset.state; if (s && s !== window.ballStates.at(-1)) window.ballStates.push(s); })
          .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-state'] });
        window.passed = [];
        document.addEventListener('click', event => window.passed.push(event.target.className || event.target.tagName));
      });
      const fstates = () => p.evaluate(() => window.ballStates.splice(0));
      await femit(`\x1b[H\x1b[2J\r\nNO HISTORY\r\n${ROW1}\r\n${ROW2}\r\n$ `);
      await p.locator('#h5-mouse-ball').waitFor({ state: 'attached' });
      await p.waitForFunction(() => document.getElementById('h5-mouse-handle')?.style.display === 'block');
      let st = await fhandle();
      assert.deepEqual([st.display, st.state], ['block', 'idle'], 'a terminal without history has the handle');
      // The first-time hint shows for it too.
      const fhint = p.locator('#h5-mouse-ball-hint');
      await fhint.waitFor({ state: 'visible', timeout: 3000 });
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, 'mouse-ball-no-history.png') }); }
      await fhint.waitFor({ state: 'hidden', timeout: 6000 });
      // A vertical drag scrolls nothing (there is nothing to scroll) and never starts the mouse.
      await ftouch('touchStart', st.x, st.y);
      await fglide({ x: st.x, y: st.y }, { x: st.x, y: st.y - 150 }, { steps: 10 });
      assert.equal((await fhandle()).state, 'scroll', 'it is a scroll all the same');
      await fglide({ x: st.x, y: st.y - 150 }, { x: st.x, y: st.y + 30 }, { steps: 10 });
      await ftouch('touchEnd');
      await p.waitForFunction(() => document.getElementById('h5-mouse-handle').dataset.state === 'idle', null, { timeout: 2000 });
      assert.equal((await fhandle()).scrollTop, 0, 'nothing scrolled');
      assert.deepEqual((await fstates()).filter(name => name !== 'idle'), [], 'no mouse from a vertical drag');
      // A tap does nothing and passes no click.
      await p.waitForTimeout(450);
      await p.evaluate(() => window.passed.splice(0));
      await ftouch('touchStart', st.x, st.y);
      await ftouch('touchEnd');
      await p.waitForTimeout(300);
      assert.deepEqual(await p.evaluate(() => window.passed.slice()), [], 'a tap on the handle passes no click');
      assert.deepEqual((await fstates()).filter(name => name !== 'idle'), [], 'a tap is no mouse');
      // A slide to the left: stretch, the ball at 40px, the dwell presses, a drag selects, the lift copies, the ball glides back into the handle.
      const fg = await p.evaluate(() => {
        const el = document.querySelector('.h5-xterm:not([hidden])');
        const screen = el.querySelector('.xterm-screen').getBoundingClientRect();
        const rows = el.querySelectorAll('.xterm-rows > div').length;
        const cols = window.H5UI.get().terminalWidth.current;
        return { left: screen.left, top: screen.top, cw: screen.width / cols, ch: screen.height / rows };
      });
      const fat = (col, row) => ({ x: fg.left + col * fg.cw, y: fg.top + (row + 0.5) * fg.ch });
      const ffinger = c => ({ x: c.x + 46, y: c.y + 46 });
      st = await fhandle();
      const from = { x: st.x, y: st.y };
      await ftouch('touchStart', from.x, from.y);
      await fglide(from, { x: from.x - 25, y: from.y }, { steps: 5 });
      assert.equal(await p.evaluate(() => document.getElementById('h5-mouse-ball').dataset.state), 'stretch', 'the handle stretches');
      await fglide({ x: from.x - 25, y: from.y }, { x: from.x - 45, y: from.y }, { steps: 3 });
      await p.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'drag', null, { timeout: 3000 });
      const press = fat(8, 2);
      await fglide({ x: from.x - 45, y: from.y }, ffinger(press));
      await p.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'pressed', null, { timeout: 3000 });
      await fglide(ffinger(press), ffinger(fat(12, 3)));
      await ftouch('touchEnd');
      await p.waitForFunction(() => window.copied.length === 1, null, { timeout: 3000 });
      assert.deepEqual(await p.evaluate(() => window.copied), [`${ROW1.slice(8)}\n${ROW2.slice(0, 12)}`], 'the selection is copied');
      await p.waitForFunction(() => {
        const el = document.getElementById('h5-mouse-handle');
        const ball = document.getElementById('h5-mouse-ball');
        return !el.dataset.mouse && ball.dataset.state === 'idle' && getComputedStyle(ball).display === 'none';
      }, null, { timeout: 3000 });
      const seen = await fstates();
      assert.deepEqual(seen.slice(0, 3), ['stretch', 'drag', 'pressed'], `the shipped gesture (${seen})`);
      assert.ok(seen.includes('glide') && seen.at(-1) === 'idle', `it glides back into the handle (${seen})`);
      assert.equal((await fhandle()).scrollTop, 0, 'still nothing scrolled');
      // History appears: now the same drag scrolls back.
      await femit(`${Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\r\n')}\r\n`);
      await p.evaluate(() => { document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport').scrollTop = 1e9; });
      await p.waitForTimeout(150);
      st = await fhandle();
      assert.ok(st.scrollTop > 0, 'there is history now');
      await ftouch('touchStart', st.x, st.y);
      await fglide({ x: st.x, y: st.y }, { x: st.x, y: st.y - 150 }, { steps: 10 });
      await p.waitForFunction(top => document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport').scrollTop < top - 20, st.scrollTop, { timeout: 3000 });
      await ftouch('touchEnd');
      await p.waitForFunction(() => document.getElementById('h5-mouse-handle').dataset.state === 'idle', null, { timeout: 2000 });
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'no horizontal overflow');
      assert.deepEqual(fresh.errors, [], 'no page errors');
      await fresh.context.close();
    }

    // ── A computer (1440 x 900, a mouse, no touch): the same handle, which scrolls and lets the same mouse ball out with the left button held ──
    {
      const pc = await openPage(browser, { touch: false, viewport: { width: 1440, height: 900 } });
      const p = pc.page;
      await p.locator('#h5-tasks').waitFor({ state: 'visible' });
      await p.locator('.h5-task-item', { hasText: 'Fix login' }).click();
      await p.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main', { hasText: 'Terminal 1' }).click();
      await p.waitForFunction(() => window.sockets.length > 0 && window.sockets.at(-1).readyState === 1 && document.querySelector('.h5-xterm:not([hidden]) .xterm-rows'));
      assert.equal(await p.evaluate(() => document.documentElement.dataset.input), 'pointer');
      const pframes = () => p.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      await p.evaluate(data => window.sockets.at(-1).emit(data), `${Array.from({ length: 300 }, (_, i) => `old ${i + 1}`).join('\r\n')}\r\n\x1b[2J\x1b[H\r\nMOUSE BALL TEST\r\n${ROW1}\r\n${ROW2}\r\n$ `);
      await pframes();
      await p.locator('#h5-mouse-ball').waitFor({ state: 'attached' });
      await p.waitForFunction(() => document.getElementById('h5-mouse-handle')?.style.display === 'block');
      assert.equal(pc.chunks.length, 1, 'the chunk is loaded with a mouse');
      assert.equal(await p.locator('#h5-wheel').count(), 0, 'no wheel strip');
      const layout = await p.evaluate(() => {
        const host = document.getElementById('h5-terminal').getBoundingClientRect();
        const box = document.querySelector('.h5-xterm:not([hidden])').getBoundingClientRect();
        return { right: host.right - box.right, scrollbar: getComputedStyle(document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport')).scrollbarWidth };
      });
      assert.ok(Math.abs(layout.right - 4) < 0.5, `the terminal box ends 4px from the right again (${layout.right})`);
      assert.notEqual(layout.scrollbar, 'none', 'xterm\'s own scrollbar is not hidden');
      await p.evaluate(() => {
        window.ballStates = [];
        new MutationObserver(() => { const s = document.getElementById('h5-mouse-ball')?.dataset.state; if (s && s !== window.ballStates.at(-1)) window.ballStates.push(s); })
          .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-state'] });
      });
      const pstates = () => p.evaluate(() => window.ballStates.splice(0));
      const pscroll = () => p.evaluate(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport').scrollTop);
      const terminalFocused = () => p.evaluate(() => Boolean(document.activeElement && document.activeElement.closest('.h5-xterm:not([hidden])')));
      // The first-time hint says the same as on a phone.
      const phint = p.locator('#h5-mouse-ball-hint');
      await phint.waitFor({ state: 'visible', timeout: 3000 });
      assert.equal(await phint.textContent(), 'Drag to scroll, slide left for the mouse');
      const phandle = () => p.evaluate(() => {
        const el = document.getElementById('h5-mouse-handle');
        const b = el.querySelector('.h5-mouse-handle-bar').getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const box = document.getElementById('h5-terminal').getBoundingClientRect();
        return { display: getComputedStyle(el).display, edge: el.dataset.edge, state: el.dataset.state, dir: el.dataset.dir || '', x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height, hitW: r.width, hitH: r.height, right: box.right, left: box.left, bottom: box.bottom };
      });
      const ph = await phandle();
      assert.deepEqual([ph.display, ph.edge, ph.w, ph.h], ['block', 'right', 11, 64], 'the same handle on the computer');
      assert.ok(ph.hitW >= 44 && Math.abs(ph.x - (ph.right - 7.5)) < 0.5 && Math.abs(ph.y - (ph.bottom - 68)) < 0.5, `the same size and place (${JSON.stringify(ph)})`);
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, 'mouse-ball-pc-hint.png') }); }
      await phint.waitFor({ state: 'hidden', timeout: 6000 });
      // A vertical drag of the handle with the left button scrolls the history and never starts the mouse ball; the keyboard stays in the terminal.
      await p.locator('.h5-xterm:not([hidden]) .xterm-screen').click({ position: { x: 20, y: 20 } });
      const bottom = await pscroll();
      assert.ok(bottom > 0, 'there is history');
      await p.mouse.move(ph.x, ph.y);
      await p.mouse.down();
      await p.mouse.move(ph.x, ph.y - 200, { steps: 12 });
      const scrolling = await phandle();
      assert.deepEqual([scrolling.state, scrolling.dir], ['scroll', 'up'], 'the mouse drags it up: a scroll');
      await p.waitForFunction(top => document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport').scrollTop < top - 50, bottom, { timeout: 3000 });
      await p.mouse.up();
      await p.waitForFunction(() => document.getElementById('h5-mouse-handle').dataset.state === 'idle', null, { timeout: 2000 });
      assert.deepEqual((await pstates()).filter(name => name !== 'idle'), [], 'no mouse ball from a vertical drag');
      assert.equal(await terminalFocused(), true, 'a press on the handle keeps the keyboard in the terminal');
      // Back to the newest output by pulling the handle down with the mouse, held until the newest line is shown.
      await p.mouse.move(ph.x, ph.y);
      await p.mouse.down();
      await p.mouse.move(ph.x, 890, { steps: 12 });
      await p.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-rows').textContent.includes('MOUSE BALL TEST'), null, { timeout: 8000 });
      await p.mouse.up();
      await p.waitForFunction(() => document.getElementById('h5-mouse-handle').dataset.state === 'idle', null, { timeout: 2000 });
      await p.evaluate(() => { document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport').scrollTop = 1e9; });
      await p.waitForTimeout(150);
      await pstates();
      // A slide to the left with the left button held: the ball; holding still presses; a move selects; the mouseup copies; the ball glides back.
      const pg = await p.evaluate(() => {
        const el = document.querySelector('.h5-xterm:not([hidden])');
        const screen = el.querySelector('.xterm-screen').getBoundingClientRect();
        const rows = el.querySelectorAll('.xterm-rows > div').length;
        const cols = window.H5UI.get().terminalWidth.current;
        return { left: screen.left, top: screen.top, cw: screen.width / cols, ch: screen.height / rows };
      });
      const pat = (col, row) => ({ x: pg.left + col * pg.cw, y: pg.top + (row + 0.5) * pg.ch });
      const out = async () => {
        await p.mouse.move(ph.x, ph.y);
        await p.mouse.down();
        await p.mouse.move(ph.x - 25, ph.y, { steps: 5 });
        assert.equal(await p.evaluate(() => document.getElementById('h5-mouse-ball').dataset.state), 'stretch', 'the handle stretches toward the mouse');
        await p.mouse.move(ph.x - 45, ph.y, { steps: 3 });
        await p.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'drag', null, { timeout: 3000 });
      };
      await out();
      const press = pat(8, 2);
      await p.mouse.move(press.x + 46, press.y + 46, { steps: 8 });
      const view = await p.evaluate(() => /translate\(([-\d.]+) ([-\d.]+)\)/.exec(document.querySelector('.h5-mouse-ball-cursor').getAttribute('transform')).slice(1).map(Number));
      assert.ok(Math.abs(view[0] - press.x) < 0.5 && Math.abs(view[1] - press.y) < 0.5, `the cursor is 46px up and left of the mouse (${view})`);
      await p.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'pressed', null, { timeout: 3000 });
      const end = pat(12, 3);
      await p.mouse.move(end.x + 46, end.y + 46, { steps: 8 });
      await p.mouse.up();
      await p.waitForFunction(() => window.copied.length === 1, null, { timeout: 3000 });
      assert.deepEqual(await p.evaluate(() => window.copied), [`${ROW1.slice(8)}\n${ROW2.slice(0, 12)}`], 'the selection is copied at the mouseup');
      const docked = () => p.waitForFunction(() => {
        const el = document.getElementById('h5-mouse-handle');
        const ball = document.getElementById('h5-mouse-ball');
        return !el.dataset.mouse && ball.dataset.state === 'idle' && getComputedStyle(ball).display === 'none';
      }, null, { timeout: 3000 });
      await docked();
      const seen = await pstates();
      assert.deepEqual(seen.slice(0, 3), ['stretch', 'drag', 'pressed'], `the shipped gesture with a mouse (${seen})`);
      assert.ok(seen.includes('glide') && seen.at(-1) === 'idle', `it glides back into the handle (${seen})`);
      assert.equal(await terminalFocused(), true, 'the keyboard stays in the terminal');
      // Escape ends it like a cancelled touch: nothing copied, nothing selected, the key not sent to the terminal.
      await p.evaluate(() => window.copied.splice(0));
      const sentBefore = await p.evaluate(() => window.sockets.at(-1).sent.length);
      await out();
      await p.mouse.move(press.x + 46, press.y + 46, { steps: 8 });
      await p.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'pressed', null, { timeout: 3000 });
      await p.mouse.move(end.x + 46, end.y + 46, { steps: 8 });
      await p.keyboard.press('Escape');
      await docked();
      await p.mouse.up();
      await pframes();
      assert.deepEqual(await p.evaluate(() => window.copied), [], 'Escape copies nothing');
      assert.equal(await p.evaluate(() => document.querySelectorAll('.h5-xterm:not([hidden]) .xterm-selection div').length), 0, 'and leaves no selection');
      const sent = await p.evaluate(n => window.sockets.at(-1).sent.slice(n), sentBefore);
      assert.ok(!sent.some(item => item.includes('\x1b') && !item.startsWith('{')), `Escape did not reach the terminal (${JSON.stringify(sent)})`);
      const sentNow = await p.evaluate(() => window.sockets.at(-1).sent.length);
      await p.keyboard.press('Escape'); // the control: with the ball back in the handle, Escape is the terminal's again (the keyboard stayed there)
      await p.waitForFunction(n => window.sockets.at(-1).sent.slice(n).includes('\x1b'), sentNow, { timeout: 3000 });
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'no horizontal overflow');
      await pstates();
      // A long press with the left button held picks it up; Escape puts it back; a second one, let go right of the middle, snaps to the right edge higher up.
      await p.mouse.move(ph.x, ph.y);
      await p.mouse.down();
      await p.waitForFunction(() => document.getElementById('h5-mouse-handle').dataset.state === 'move', null, { timeout: 2000 });
      await p.mouse.move(600, 400, { steps: 6 });
      await p.keyboard.press('Escape');
      await p.waitForFunction(() => document.getElementById('h5-mouse-handle').dataset.state === 'idle', null, { timeout: 2000 });
      await p.mouse.up();
      let pm = await phandle();
      assert.ok(pm.edge === 'right' && Math.abs(pm.x - ph.x) < 0.5 && Math.abs(pm.y - ph.y) < 0.5, `Escape puts it back (${JSON.stringify(pm)})`);
      assert.equal(await p.evaluate(() => localStorage.getItem('h5-mouse-handle')), null, 'nothing kept');
      await p.mouse.move(ph.x, ph.y);
      await p.mouse.down();
      await p.waitForFunction(() => document.getElementById('h5-mouse-handle').dataset.state === 'move', null, { timeout: 2000 });
      await p.mouse.move(1000, 300, { steps: 6 });
      await p.mouse.up();
      await p.waitForFunction(() => document.getElementById('h5-mouse-handle').dataset.state === 'idle', null, { timeout: 2000 });
      pm = await phandle();
      assert.ok(pm.edge === 'right' && Math.abs(pm.x - (pm.right - 7.5)) < 0.5 && Math.abs(pm.y - 300) < 1, `snapped to the right edge at 300 (${JSON.stringify(pm)})`);
      assert.equal(JSON.parse(await p.evaluate(() => localStorage.getItem('h5-mouse-handle'))).edge, 'right');
      assert.deepEqual((await pstates()).filter(name => name !== 'idle'), [], 'no ball from the moves');
      if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'mouse-ball-pc.png') });
      assert.deepEqual(pc.errors, [], 'no page errors');
      await pc.context.close();
    }
    console.log('h5 mouse ball browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
