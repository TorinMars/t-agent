// The mouse ball of the phone terminal (scripts/h5-shell/MouseBall.jsx, mouse-ball-model.mjs; "Mouse ball" in docs/design/page-terminal-mouse-ball.md)
// in real headless Chromium at 390 x 844 with touch, driven by real CDP touches (Input.dispatchTouchEvent). The server is mocked (no data folder).
// Checked: off by default (its chunk is not even loaded); More > Mouse ball turns it on (a switch row, remembered for this device); the idle ball is
// docked at the right edge about two thirds down, above the key rows; a drag shows the cursor 46px left of and above the ball with a dashed line;
// holding still 600 ms presses (ring, blue cursor, aria-pressed) and does not open the long-press copy view; a drag then selects, and the lift copies
// exactly the expected text through the copy path of the double tap (notice "Copied N characters"), then the ball docks again; the edge fade lets the
// cursor reach the last column; a drag without the dwell copies nothing; a cancelled touch copies nothing and leaves no selection; the terminal does
// not scroll under the ball, but a held button near the top edge scrolls it and the selection keeps its start; a refused write shows the copy bar;
// no horizontal overflow; off again removes the ball. H5_SHOT_DIR=<dir> saves screenshots.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'https://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR;

async function openPage(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: SHOTS ? 3 : 1 });
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
async function openTerminal(page) {
  await page.locator('#h5-tasks').waitFor({ state: 'visible' });
  await page.locator('.h5-task-item', { hasText: 'Fix login' }).tap();
  await page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main', { hasText: 'Terminal 1' }).tap();
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
      const line = overlay.querySelector('line');
      return {
        state: ball.dataset.state, pressed: ball.getAttribute('aria-pressed'), overlay: getComputedStyle(overlay).display, color: getComputedStyle(overlay).color,
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
    const dockedAgain = async dock => {
      await page.waitForFunction(dock => { const r = document.getElementById('h5-mouse-ball').getBoundingClientRect(); return Math.abs(r.left + r.width / 2 - dock.x) < 0.5 && Math.abs(r.top + r.height / 2 - dock.y) < 0.5; }, dock);
    };

    // ── Off by default: no ball, no chunk ──
    const g0 = await grid();
    await emit(`\x1b[2J\x1b[HMOUSE BALL TEST\r\n${ROW1}\r\n${ROW2}\r\n${'W'.repeat(g0.cols - 1)}Z\r\n$ `);
    assert.equal(await page.locator('#h5-mouse-ball').count(), 0, 'off by default');
    assert.deepEqual(chunks, [], 'its chunk is not loaded while it is off');
    assert.equal(await page.evaluate(() => localStorage.getItem('h5-mouse-ball')), null);

    // ── More > Mouse ball: a switch row ──
    await page.locator('#h5-header-more').tap();
    const item = page.locator('#h5-mouse-ball-switch');
    await item.waitFor();
    assert.equal(await item.getAttribute('role'), 'menuitemcheckbox');
    assert.equal(await item.getAttribute('aria-checked'), 'false');
    assert.match(await item.textContent(), /Mouse ball/);
    const order = await page.evaluate(() => [...document.querySelectorAll('#h5-header-more-menu [role^="menuitem"]')].map(node => node.id));
    assert.equal(order.indexOf('h5-mouse-ball-switch'), order.indexOf('h5-term-width') + 1, `right after Terminal width (${order})`);
    assert.ok(await item.evaluate(node => node.offsetHeight) >= 44, 'a 44px row');
    await page.waitForTimeout(400); // the menu's grow animation
    await shot('menu');
    await item.tap();
    await page.locator('#h5-header-more-menu').waitFor({ state: 'detached' });
    await page.locator('#h5-mouse-ball').waitFor({ state: 'visible' });
    assert.equal(chunks.length, 1, 'the chunk is loaded when it is turned on');
    assert.equal(await page.evaluate(() => localStorage.getItem('h5-mouse-ball')), 'on', 'remembered for this device');
    assert.equal(await page.locator('#h5-mouse-ball').getAttribute('aria-label'), 'Mouse ball');
    assert.equal(await page.locator('#h5-mouse-ball').getAttribute('title'), 'Mouse ball');
    assert.equal(await page.locator('#h5-mouse-ball').getAttribute('role'), 'button');
    await page.locator('#h5-header-more').tap();
    assert.equal(await page.locator('#h5-mouse-ball-switch').getAttribute('aria-checked'), 'true', 'the switch shows it on');
    await page.keyboard.press('Escape');
    await page.locator('#h5-header-more-menu').waitFor({ state: 'detached' });

    // ── Idle: docked at the right edge, about two thirds down, above the key rows ──
    const g = await grid();
    await page.waitForTimeout(300);
    const dock = await ballBox();
    assert.equal(dock.w, 52);
    assert.ok(Math.abs(dock.x - (g.box.right - 28)) < 1, `at the right edge (${dock.x})`);
    const twoThirds = g.box.top + (g.box.bottom - g.box.top) * 2 / 3;
    assert.ok(Math.abs(dock.y - twoThirds) < 1, `two thirds down (${dock.y} vs ${twoThirds})`);
    const keysTop = await page.evaluate(() => document.getElementById('h5-bottom').getBoundingClientRect().top);
    assert.ok(dock.y + 26 <= keysTop, 'it does not cover the key rows');
    const idle = await ui();
    assert.equal(idle.state, 'idle');
    assert.equal(idle.overlay, 'none', 'no cursor while idle');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('h5-mouse-ball')).touchAction), 'none');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.h5-xterm:not([hidden])')).touchAction), 'pan-y', 'the terminal keeps its own touch handling');
    await shot('idle');

    // ── Drag: the cursor shows 46px left of and above the ball; holding still presses; a drag selects; the lift copies ──
    const press1 = at(g, 8, 1);
    const finger1 = fingerFor(press1);
    await touch('touchStart', dock.x, dock.y);
    await glide(dock, finger1);
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
    assert.equal(view.pressed, 'true');
    assert.equal(view.ring, '1');
    assert.equal(view.color, 'rgb(144, 202, 249)', 'the cursor is blue while pressed');
    assert.equal(view.copyView, false, 'the long press of the terminal did not open the copy view');
    await shot('press');
    const select1 = at(g, 12, 2);
    await glide(finger1, fingerFor(select1));
    view = await ui();
    assert.ok(view.selected > 0, 'xterm draws the selection while dragging');
    await shot('select');
    await touch('touchEnd');
    const expected1 = `${ROW1.slice(8)}\n${ROW2.slice(0, 12)}`;
    await page.waitForFunction(() => window.copied.length === 1);
    assert.deepEqual(await copied(), [expected1], 'the lift copies the selection');
    const said = await notices();
    assert.deepEqual(said, [[`Copied ${expected1.length} characters`, 'success']], 'the notice of every terminal copy');
    view = await ui();
    assert.equal(view.state, 'idle');
    assert.ok(view.selected > 0, 'the highlight stays after the copy');
    await dockedAgain(dock);
    await shot('copied');

    // ── The edge fade: the cursor reaches the last column ──
    const press2 = at(g, 3, 3);
    await touch('touchStart', dock.x, dock.y);
    await glide(dock, fingerFor(press2));
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
    await dockedAgain(dock);

    // ── A drag without the dwell copies nothing ──
    await page.evaluate(() => document.querySelector('.h5-xterm:not([hidden])').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await touch('touchStart', dock.x, dock.y);
    await glide(dock, { x: 200, y: 200 }, { steps: 10, ms: 50 });
    await glide({ x: 200, y: 200 }, { x: 150, y: 300 }, { steps: 6, ms: 50 });
    await shot('drag');
    await touch('touchEnd');
    await page.waitForTimeout(200);
    assert.equal((await copied()).length, 2, 'a plain drag only moves the cursor: nothing copied');
    assert.equal((await ui()).state, 'idle');
    await dockedAgain(dock);

    // ── A cancelled touch copies nothing and leaves no selection ──
    await touch('touchStart', dock.x, dock.y);
    await glide(dock, fingerFor(press1));
    await page.waitForTimeout(800);
    assert.equal((await ui()).state, 'pressed');
    await glide(fingerFor(press1), fingerFor(select1));
    assert.ok((await ui()).selected > 0);
    await touch('touchCancel');
    await page.waitForTimeout(200);
    assert.equal((await copied()).length, 2, 'a cancelled touch copies nothing');
    view = await ui();
    assert.equal(view.state, 'idle');
    assert.equal(view.selected, 0, 'and leaves no selection');
    await dockedAgain(dock);

    // ── The terminal does not scroll under the ball; a held button near the top edge scrolls it, the selection keeps its start ──
    await emit(`\r\n${Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\r\n')}`);
    const scrollTop = () => page.evaluate(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport').scrollTop);
    const bottom = await scrollTop();
    assert.ok(bottom > 0, 'there is history above');
    await touch('touchStart', dock.x, dock.y);
    await glide(dock, { x: 250, y: 150 }, { steps: 10 });
    await glide({ x: 250, y: 150 }, { x: 250, y: 600 }, { steps: 10 });
    await touch('touchEnd');
    await page.waitForTimeout(200);
    assert.equal(await scrollTop(), bottom, 'dragging the ball does not scroll the terminal');
    await dockedAgain(dock);
    const g2 = await grid();
    const midRow = Math.floor(g2.rows / 2);
    const lineAt = row => page.evaluate(row => document.querySelectorAll('.h5-xterm:not([hidden]) .xterm-rows > div')[row].textContent.trim(), midRow);
    const pressedLine = Number((await lineAt(midRow)).replace(/\D+/g, ''));
    const press3 = at(g2, 0, midRow);
    await touch('touchStart', dock.x, dock.y);
    await glide(dock, fingerFor(press3));
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
    await dockedAgain(dock);

    // ── A write the browser refuses: the copy bar, as for the double tap ──
    await page.evaluate(() => { window.refuse = true; });
    await touch('touchStart', dock.x, dock.y);
    await glide(dock, fingerFor(at(g2, 0, 2)));
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

    // ── No horizontal overflow; off again removes the ball; a reload keeps the choice ──
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
    await page.reload(); // the phone opens the terminal it showed
    await page.waitForFunction(() => window.sockets.length > 0 && window.sockets.at(-1).readyState === 1 && document.querySelector('.h5-xterm:not([hidden]) .xterm-rows'));
    await page.locator('#h5-mouse-ball').waitFor({ state: 'visible' });
    await page.locator('#h5-header-more').tap();
    await page.locator('#h5-mouse-ball-switch').tap();
    await page.locator('#h5-mouse-ball').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => localStorage.getItem('h5-mouse-ball')), null, 'off is the default again');
    assert.deepEqual(errors, [], 'no page errors');
    await context.close();
    console.log('h5 mouse ball browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
