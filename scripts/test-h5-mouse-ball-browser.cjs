// The mouse ball of the phone terminal (scripts/h5-shell/MouseBall.jsx, mouse-ball-model.mjs; "Mouse ball" in docs/design/page-terminal-mouse-ball.md)
// in real headless Chromium at 390 x 844 with touch, driven by real CDP touches (Input.dispatchTouchEvent). The server is mocked (no data folder).
// Checked: no ball and no More-menu switch at start (its chunk is loaded in touch input); the first-time hint near the thumb, once per device (not
// again after a reload), gone after 4 s; the wheel strip's 44px hit area and its description; a vertical drag of the thumb still scrolls and never
// starts the mouse, nor does a slide to the right or a vertical start that turns sideways; a slide to the left stretches the thumb (25px: the
// stretch state, the thumb dimmed), lifted then it springs back with no copy and no scroll; past 40px it is the ball; then the shipped scenario
// from that entrance: the cursor 46px left of and above the ball with a dashed line; holding still 600 ms presses (ring, blue cursor) and does not
// open the long-press copy view; a drag then selects, and the lift copies exactly the expected text through the copy path of the double tap
// (notice "Copied N characters"), then the ball glides back into the strip (a clean strip: no data-mouse, no stuck active, the thumb's own colour);
// a touch during the glide works at once; the edge fade lets the cursor reach the last column; a drag without the dwell copies nothing; a cancelled
// touch copies nothing and leaves no selection; the terminal does not scroll under the ball, but a held button near the top edge scrolls it and the
// selection keeps its start; a refused write shows the copy bar; a paragraph a program wrapped is one line; with mouse reporting on (SGR drag
// tracking) the button goes to the program instead (the press at the dwell, motions while held and the release at the lift as 1-based SGR reports,
// wheel steps near the top edge, no page selection or copy, the program's OSC 52 copy on the release written at once, reporting turned off
// mid-gesture keeps the gesture the program's, off again the page selects and copies); the More menu's switch "Mouse ball sends the mouse to
// programs" (touch only, off by default, writing h5-mouse-ball-program); with modes 1000/1002/1003/1004/1006 the bytes of a real mouse (hover
// moves before the press, ESC[I once when the terminal did not have the focus, the press, drags, the release), no hover in 1002, and with the switch
// off nothing reaches the program; the spring strip of a full-screen program works the same
// and sends nothing to the program before the ball is out; no horizontal overflow. H5_SHOT_DIR=<dir> saves screenshots.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'https://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR;

async function openPage(browser, { touch = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...(touch ? { isMobile: true, hasTouch: true } : {}), deviceScaleFactor: SHOTS ? 3 : 1 });
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
    // The middle of the strip's thumb, a little inside the strip's right edge (the strip is 44px wide, the thumb 4px at its right).
    const thumbPoint = () => page.evaluate(() => {
      const strip = document.getElementById('h5-wheel').getBoundingClientRect();
      const thumb = document.querySelector('#h5-wheel .h5-wheel-thumb').getBoundingClientRect();
      return { x: strip.right - 8, y: thumb.top + thumb.height / 2 };
    });
    // The ball out of the strip: a touch on the thumb, 45px to the left (it lets go at 40), then the finger to `to`.
    const enter = async (to, options) => {
      const from = await thumbPoint();
      const out = { x: from.x - 45, y: from.y };
      await touch('touchStart', from.x, from.y);
      await glide(from, out, { steps: 5 });
      await page.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'drag', null, { timeout: 3000 });
      if (to) await glide(out, to, options);
      return out;
    };
    // Back in the strip after the lift: the ball gone, the strip its own again.
    const dockedAgain = () => page.waitForFunction(() => {
      const el = document.getElementById('h5-wheel');
      const ball = document.getElementById('h5-mouse-ball');
      return !el.dataset.mouse && ball.dataset.state === 'idle' && getComputedStyle(ball).display === 'none' && el.querySelector('.h5-wheel-thumb').style.background === '';
    }, null, { timeout: 3000 });

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
    await page.waitForFunction(() => document.getElementById('h5-wheel').dataset.mode === 'bar');
    await page.locator('#h5-mouse-ball').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#h5-mouse-ball').isVisible(), false, 'no ball on the screen');
    assert.equal(chunks.length, 1, 'the chunk is loaded in touch input');
    await page.locator('#h5-header-more').tap();
    await page.locator('#h5-header-more-menu').waitFor();
    assert.equal(await page.locator('#h5-mouse-ball-switch').count(), 0, 'no Mouse ball switch in the More menu');
    const programRow = page.locator('#h5-mouse-ball-program');
    await programRow.waitFor({ state: 'visible' });
    assert.equal(await programRow.getAttribute('role'), 'menuitemcheckbox');
    assert.equal(await programRow.getAttribute('aria-checked'), 'false', 'off by default');
    assert.match(await programRow.innerText(), /Mouse ball sends the mouse to programs\s+Off: the page selects\. On: a program with mouse reporting, such as Claude Code in full screen, selects by itself\./);
    const rowBox = await programRow.boundingBox();
    const menuBox = await page.locator('#h5-header-more-menu .MuiPaper-root').boundingBox();
    assert.ok(rowBox.height >= 44 && rowBox.x >= menuBox.x - 0.5 && rowBox.x + rowBox.width <= menuBox.x + menuBox.width + 0.5 && menuBox.x >= 0 && menuBox.x + menuBox.width <= 390, `a 44px row inside the menu, on the screen (${JSON.stringify({ rowBox, menuBox })})`);
    await page.keyboard.press('Escape');
    await page.locator('#h5-header-more-menu').waitFor({ state: 'detached' });

    // ── The first-time hint near the thumb, once per device ──
    const hint = page.locator('#h5-mouse-ball-hint');
    await hint.waitFor({ state: 'visible', timeout: 3000 });
    assert.match(await hint.textContent(), /Slide the scrollbar left for the mouse/);
    assert.equal(await page.evaluate(() => localStorage.getItem('h5-mouse-ball-hinted')), 'shown', 'remembered for this device');
    const hintBox = await hint.boundingBox();
    const stripBox = await page.locator('#h5-wheel').boundingBox();
    assert.ok(hintBox.x >= 0 && hintBox.x + hintBox.width <= stripBox.x + 0.5, `left of the strip, inside the screen (${JSON.stringify(hintBox)})`);
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('h5-mouse-ball-hint')).pointerEvents), 'none', 'it takes no touch');
    await shot('hint');
    await hint.waitFor({ state: 'hidden', timeout: 6000 });

    // ── The strip: a 44px hit area, a scrollbar that says it slides out ──
    const g = await grid();
    assert.ok(stripBox.width >= 44, `the strip's hit area is 44px wide (${stripBox.width})`);
    assert.equal(await page.locator('#h5-wheel').getAttribute('role'), 'scrollbar');
    assert.equal(await page.locator('#h5-wheel').getAttribute('aria-description'), 'Slide left for the mouse');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.h5-xterm:not([hidden])')).touchAction), 'pan-y', 'the terminal keeps its own touch handling');
    const scrollTop = () => page.evaluate(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport').scrollTop);
    const toBottom = async () => { await page.evaluate(() => { document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport').scrollTop = 1e9; }); await page.waitForTimeout(150); };
    const states = () => page.evaluate(() => window.ballStates.splice(0));
    await page.evaluate(() => {
      window.ballStates = [];
      new MutationObserver(() => { const s = document.getElementById('h5-mouse-ball')?.dataset.state; if (s && s !== window.ballStates.at(-1)) window.ballStates.push(s); })
        .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-state'] });
    });
    const stripClean = () => page.waitForFunction(() => {
      const el = document.getElementById('h5-wheel');
      const ball = document.getElementById('h5-mouse-ball');
      return !el.dataset.mouse && !el.classList.contains('active') && el.querySelector('.h5-wheel-thumb').style.background === '' && ball.dataset.state === 'idle' && getComputedStyle(ball).display === 'none';
    }, null, { timeout: 3000 });

    // ── A vertical drag of the thumb still scrolls and never starts the mouse ──
    let t0 = await thumbPoint();
    const bottomTop = await scrollTop();
    await touch('touchStart', t0.x, t0.y);
    await glide(t0, { x: t0.x - 6, y: t0.y - 150 }, { steps: 10 }); // a little sideways on the way: still a scroll
    assert.ok(await scrollTop() < bottomTop - 50, 'the thumb drag scrolled back');
    await glide({ x: t0.x - 6, y: t0.y - 150 }, { x: t0.x - 90, y: t0.y - 150 }, { steps: 8 }); // a vertical start that turns sideways
    assert.deepEqual(await states(), [], 'the mouse never came out');
    await touch('touchEnd');
    await toBottom();
    // A slide to the right never becomes the mouse.
    t0 = await thumbPoint();
    await touch('touchStart', stripBox.x + 4, t0.y);
    await glide({ x: stripBox.x + 4, y: t0.y }, { x: stripBox.x + 34, y: t0.y }, { steps: 5 });
    await touch('touchEnd');
    assert.deepEqual(await states(), [], 'a slide to the right is no mouse');
    await stripClean();

    // ── A slide to the left: 25px stretches the thumb, lifting then springs it back and does nothing ──
    t0 = await thumbPoint();
    const scroll0 = await scrollTop();
    await touch('touchStart', t0.x, t0.y);
    await glide(t0, { x: t0.x - 25, y: t0.y }, { steps: 5 });
    let pull = await page.evaluate(() => {
      const ball = document.getElementById('h5-mouse-ball');
      const el = document.getElementById('h5-wheel');
      const tail = document.querySelector('.h5-mouse-ball-tail');
      return { state: ball.dataset.state, progress: Number(ball.dataset.progress), mouse: el.dataset.mouse, thumb: getComputedStyle(el.querySelector('.h5-wheel-thumb')).backgroundColor,
        tail: getComputedStyle(tail).display, width: parseFloat(getComputedStyle(tail).strokeWidth), size: ball.getBoundingClientRect().width };
    });
    assert.equal(pull.state, 'stretch', 'stretched, not out yet');
    assert.ok(Math.abs(pull.progress - 25 / 40) < 0.03, `progress 25 / 40 (${pull.progress})`);
    assert.equal(pull.mouse, 'stretch');
    assert.equal(pull.thumb, 'rgba(255, 255, 255, 0.15)', 'the thumb is dimmed at its place');
    assert.notEqual(pull.tail, 'none', 'the tail from the strip');
    assert.ok(pull.size > 6 && pull.size < 52, `the head grows toward the ball (${pull.size})`);
    await shot('pull');
    await touch('touchEnd');
    await stripClean();
    assert.deepEqual(await states(), ['stretch', 'glide', 'idle'], 'it springs back into the strip');
    assert.deepEqual(await copied(), [], 'nothing copied');
    assert.equal(await scrollTop(), scroll0, 'nothing scrolled');
    assert.equal((await ui()).selected, 0, 'nothing selected');

    // ── Past 40px it lets go: the ball ──
    t0 = await thumbPoint();
    await touch('touchStart', t0.x, t0.y);
    await glide(t0, { x: t0.x - 45, y: t0.y }, { steps: 5 });
    await page.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'drag');
    assert.equal(await page.evaluate(() => document.getElementById('h5-wheel').dataset.mouse), 'ball');
    const out = await ballBox();
    assert.equal(out.w, 52, 'the 52px ball');
    assert.ok(Math.abs(out.x - (t0.x - 45)) < 0.5 && Math.abs(out.y - t0.y) < 0.5, 'under the finger');
    await touch('touchEnd');
    await stripClean();
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
    assert.equal(view.copyView, false, 'the long press of the terminal did not open the copy view');
    await shot('press');
    const select1 = at(g, 12, 3);
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
    assert.ok(view.selected > 0, 'the highlight stays after the copy');
    await dockedAgain();
    assert.deepEqual((await states()).slice(-3), ['pressed', 'glide', 'idle'], 'the ball glides back into the strip');
    await stripClean();
    await shot('copied');

    // ── A touch during the glide works at once (a scroll of the strip) ──
    await toBottom();
    await enter({ x: 200, y: 300 });
    await touch('touchEnd');
    let t1 = await thumbPoint();
    await touch('touchStart', t1.x, t1.y);
    const during = await page.evaluate(() => ({ state: document.getElementById('h5-mouse-ball').dataset.state, mouse: document.getElementById('h5-wheel').dataset.mouse || '', active: document.getElementById('h5-wheel').classList.contains('active') }));
    assert.deepEqual(during, { state: 'idle', mouse: '', active: true }, 'the glide is over at once and the strip has the new touch');
    const beforeScroll = await scrollTop();
    await glide(t1, { x: t1.x, y: t1.y - 120 }, { steps: 8 });
    assert.ok(await scrollTop() < beforeScroll, 'and it scrolls');
    await touch('touchEnd');
    await toBottom();
    await stripClean();
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

    // ── A program with mouse reporting on (drag tracking, SGR): with the device's choice 'on' the ball drives the program's own selection ──
    assert.deepEqual(await programSwitch(true), { before: 'false', shown: 'true' }, 'the switch turns on');
    assert.equal(await page.evaluate(() => localStorage.getItem('h5-mouse-ball-program')), 'on', 'kept for this device');
    assert.deepEqual(await programSwitch(), { before: 'true', shown: 'true' }, 'and shown on when the menu opens again');
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
    assert.equal(await page.evaluate(() => localStorage.getItem('h5-mouse-ball-program')), null, 'the key is removed');
    await emit(`\x1b[2J\x1b[H\r\nMOUSE MODE\r\n${ROW1}\r\n${ROW2}\r\n\x1b[?1000h\x1b[?1002h\x1b[?1006h`);
    await page.evaluate(() => { document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport').scrollTop = 1e9; });
    await page.waitForTimeout(200);
    gm = await grid();
    from = await sentCount();
    await enter(fingerFor(at(gm, 8, 2)));
    await page.waitForFunction(() => document.getElementById('h5-mouse-ball').dataset.state === 'pressed', null, { timeout: 3000 });
    assert.equal(await page.locator('#h5-mouse-ball').getAttribute('data-mode'), 'page', 'reporting on, no choice: the page gets the button');
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

    // ── A full-screen program (the alternate buffer): the spring strip lets the ball out the same way ──
    await emit(`\x1b[?1049h\x1b[H\x1b[2JSPRING\r\n${ROW1}\r\n${ROW2}\r\n`);
    await page.waitForFunction(() => document.getElementById('h5-wheel').dataset.mode === 'spring');
    await page.waitForTimeout(400); // the spring thumb at rest in the middle
    const gs = await grid();
    let ts = await thumbPoint();
    const stripMiddle = await page.evaluate(() => { const r = document.getElementById('h5-wheel').getBoundingClientRect(); return r.top + r.height / 2; });
    assert.ok(Math.abs(ts.y - stripMiddle) < 2, 'the spring thumb rests in the middle');
    // Stretched and let go: nothing reaches the program (no wheel steps, no arrow keys).
    from = await sentCount();
    await touch('touchStart', ts.x, ts.y);
    await glide(ts, { x: ts.x - 25, y: ts.y + 3 }, { steps: 5 });
    assert.equal(await page.evaluate(() => document.getElementById('h5-mouse-ball').dataset.state), 'stretch');
    await page.waitForTimeout(300);
    await touch('touchEnd');
    await stripClean();
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
    await stripClean();
    const spring = await page.evaluate(() => { const el = document.getElementById('h5-wheel'); return { offset: el.style.getPropertyValue('--h5-spring-offset'), pulling: el.hasAttribute('data-pulling'), mode: el.dataset.mode }; });
    assert.deepEqual(spring, { offset: '0px', pulling: false, mode: 'spring' }, 'the spring thumb is back in the middle');
    assert.equal(await sentCount(), from, 'nothing was sent to the program');
    await emit('\x1b[?1049l');

    // ── No horizontal overflow; after a reload the hint does not come again ──
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
    await page.reload(); // the phone opens the terminal it showed
    await page.waitForFunction(() => window.sockets.length > 0 && window.sockets.at(-1).readyState === 1 && document.querySelector('.h5-xterm:not([hidden]) .xterm-rows'));
    await page.evaluate(history => window.sockets.at(-1).emit(`${history}\r\n$ `), history);
    await page.waitForFunction(() => document.getElementById('h5-wheel').dataset.mode === 'bar');
    await page.locator('#h5-mouse-ball').waitFor({ state: 'attached' });
    await page.waitForTimeout(1500); // longer than the hint's check
    assert.equal(await page.locator('#h5-mouse-ball-hint').isVisible(), false, 'the hint is shown once per device');
    assert.equal(await page.locator('#h5-mouse-ball-switch').count(), 0);
    assert.deepEqual(errors, [], 'no page errors');
    await context.close();

    // ── Pointer input on a phone-sized window: no mouse ball, and no switch for it in the More menu ──
    const pointer = await openPage(browser, { touch: false });
    await openTerminal(pointer.page, { touch: false });
    await pointer.page.waitForFunction(() => window.H5UI.get().input === 'pointer');
    await pointer.page.locator('#h5-header-more').click();
    await pointer.page.locator('#h5-refresh').waitFor({ state: 'visible' });
    assert.equal(await pointer.page.locator('#h5-term-width').count(), 1, 'the terminal is shown');
    assert.equal(await pointer.page.locator('#h5-mouse-ball-program').count(), 0, 'the switch is for touch input only');
    assert.deepEqual(pointer.errors, []);
    await pointer.context.close();
    console.log('h5 mouse ball browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
