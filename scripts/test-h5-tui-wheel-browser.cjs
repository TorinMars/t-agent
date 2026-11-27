// The mouse wheel over a full-screen program that scrolls the pane under the mouse (opencode: a message pane, and a sidebar on the right that does not
// scroll the messages), with the real task routes, the real terminal WebSocket handler, a real PTY and a fake TUI that turns on mouse reports
// (1000, 1002, 1003 any motion, 1006 SGR) and shows on its screen the last wheel report it read (button;column;row) and how many motion reports came.
// See "Wheel strip" and "Terminal width (Fit / Wide)" in docs/design/page-terminal-and-bottom-bar.md.
// - Computer, Fit (1440 x 900, mouse; the 16px wheel strip drawn beside the terminal box): a wheel on the left, in the middle and on the last column reaches the program with the column under the pointer.
// - Computer, Wide (200 columns, the default): after Shift+wheel moved the screen to its right end, mouse moves (motion reports) and wheels over the right-most
//   columns leave the view where it is (before, every mouse report counted as typing and pulled the view back to the program's cursor on the left), and
//   each wheel names the column under the pointer; a typed key still brings the cursor back into view.
// - Touch screen with a mouse (1280 x 800, touch input mode, the wheel strip drawn): a wheel over the strip reaches the terminal under it (before, the
//   strip took it and nothing was sent); the strip's spring sends its wheel reports at the middle of the visible terminal, not at the strip's x (the
//   program's last columns: opencode's sidebar, so the spring never scrolled opencode on a wide terminal).
// - Columns view (1440 x 900, one column): a wheel inside the pane names the column under the pointer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const express = require('express');
const { WebSocketServer } = require('ws');
const root = path.resolve(__dirname, '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h5-tui-wheel-')));
process.env.T_AGENT_DATA_DIR = path.join(scratch, 'data');
process.env.TASKS_BASE_DIR = path.join(scratch, 'tasks');
const auth = require.resolve('../middleware/auth');
require.cache[auth] = { id: auth, filename: auth, loaded: true, exports: (req, res, next) => { req.session = { user: { login: 'owner' } }; next(); } };
const db = require('../db');
const engine = require('../test-support/older-tasks').olderTasks(require('../services/engine-tasks'), db);
const terminal = require('../routes/terminal');
const task = engine.createTask('owner', { title: 'Wheel fixture' });

// The fake TUI. Row 1: "TUI ready" and "SIDEBAR" at the right edge; row 2: "wheel <n>: <button>;<column>;<row>" of the last wheel report; row 3:
// "moves <n>", the motion reports so far. Its cursor rests in its input line at the bottom left (column 3), as opencode's does.
const bin = path.join(scratch, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(scratch, 'faketui.js'), `
process.stdin.setRawMode(true);
process.stdin.resume();
let wheels = 0; let last = '-'; let moves = 0; let rest = '';
const out = text => process.stdout.write(text);
const draw = () => {
  const cols = process.stdout.columns; const rows = process.stdout.rows;
  out('\\x1b[2J\\x1b[1;1HTUI ready ' + cols + 'x' + rows + '\\x1b[1;' + (cols - 7) + 'HSIDEBAR');
  out('\\x1b[2;1Hwheel ' + wheels + ': ' + last + '\\x1b[3;1Hmoves ' + moves + '\\x1b[' + rows + ';1H> \\x1b[' + rows + ';3H');
};
out('\\x1b[?1049h\\x1b[?1000h\\x1b[?1002h\\x1b[?1003h\\x1b[?1006h');
draw();
process.stdout.on('resize', draw);
process.stdin.on('data', chunk => {
  rest += chunk.toString('latin1');
  const reports = /\\x1b\\[<(\\d+);(\\d+);(\\d+)([Mm])/g;
  let end = 0; let match;
  while ((match = reports.exec(rest))) {
    const button = Number(match[1]);
    if (button === 64 || button === 65) { wheels += 1; last = match[1] + ';' + match[2] + ';' + match[3]; }
    else if (button & 32) moves += 1;
    end = reports.lastIndex;
  }
  rest = rest.slice(end).slice(-64);
  draw();
});
`);
fs.writeFileSync(path.join(bin, 'faketui'), `#!/bin/sh\nexec '${process.execPath}' '${path.join(scratch, 'faketui.js')}'\n`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;

const app = express(); app.use(express.json({ limit: '32mb' }));
app.use('/api/tasks', require('../routes/tasks'));
app.use('/api/task-groups', require('../routes/task-groups'));
app.get('/api/remote-servers', (req, res) => res.json([]));
app.get('/auth/me', (req, res) => res.json({ work_dir: null, effective_work_dir: process.env.TASKS_BASE_DIR }));
app.get('/api/system/version', (req, res) => res.json({ app_version: '0.0.0', boot_id: 'b1' }));
app.all('/api/system/*', (req, res) => res.json({ status: 'current', is_update_admin: false }));
app.get('/api/agent-chat/summary', (req, res) => res.json({ running: 0, queued: 0, submitted: 0 }));
app.get(['/', '/h5'], (req, res) => res.type('html').sendFile(path.join(root, 'public/h5.html')));
app.use(express.static(path.join(root, 'public'), { index: false }));
app.use((req, res) => res.status(404).json({ error: 'not mocked' }));

const REMEMBERED = { 'h5-task:local': String(task.id), [`h5-terminal:local:${task.id}`]: 'default' };
const errors = [];
let server; let browser; let wss;

// A page (or a column's frame) whose xterm instances are kept in window.__testTerms.
async function newPage(contextOptions, storage = REMEMBERED) {
  const context = await browser.newContext(contextOptions);
  await context.addInitScript(saved => {
    if (window === window.top && !sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
    }
    window.__testTerms = [];
    // Row `y` of the screen of the last terminal (the alternate buffer keeps the rows a shrink took off above the screen).
    window.__screenLine = y => { const buffer = window.__testTerms.at(-1).buffer.active; return buffer.getLine(buffer.baseY + y)?.translateToString(true) || ''; };
    Object.defineProperty(window, 'Terminal', { configurable: true, set(Original) { delete window.Terminal; window.Terminal = class extends Original { constructor(...args) { super(...args); window.__testTerms.push(this); } }; }, get() { return undefined; } });
  }, storage);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  return { context, page };
}
// Waits until the shown terminal of `frame` runs the fake TUI with mouse reports on, drawn at the terminal's size (a page that connects to the running
// TUI sends its own size, and the TUI draws again).
const tuiShown = frame => frame.waitForFunction(() => {
  const term = window.__testTerms.at(-1);
  return term && term.buffer.active.type === 'alternate' && term.modes.mouseTrackingMode === 'any' && window.__screenLine(0).startsWith(`TUI ready ${term.cols}x${term.rows}`);
}, null, { timeout: 60000 });
// The TUI's status: wheel count and last report, motion count, and the page's geometry (the visible box, the moved screen, the cell size).
const status = frame => frame.evaluate(() => {
  const term = window.__testTerms.at(-1);
  const line = window.__screenLine;
  const wheel = /^wheel (\d+): (\d+);(\d+);(\d+)/.exec(line(1));
  const box = document.querySelector('.h5-xterm:not([hidden])').getBoundingClientRect();
  const screen = document.querySelector('.h5-xterm:not([hidden]) .xterm-screen').getBoundingClientRect();
  return {
    wheels: wheel ? Number(wheel[1]) : 0, button: wheel ? Number(wheel[2]) : 0, col: wheel ? Number(wheel[3]) : 0, row: wheel ? Number(wheel[4]) : 0,
    moves: Number((/^moves (\d+)/.exec(line(2)) || [])[1] || 0), cols: term.cols, rows: term.rows,
    box: { left: box.left, top: box.top, width: box.width, height: box.height }, screen: { left: screen.left, top: screen.top },
    cell: { width: screen.width / term.cols, height: screen.height / term.rows }, offset: Math.round(box.left - screen.left),
  };
});
// The point (in the frame's own coordinates) at the centre of the cell at 1-based `col`, `row`.
const cellPoint = (st, col, row) => ({ x: st.screen.left + (col - 0.5) * st.cell.width, y: st.screen.top + (row - 0.5) * st.cell.height });
// The 1-based cell under the point x, y of the frame (what xterm reports).
const cellUnder = (st, x, y) => ({ col: Math.floor((x - st.screen.left) / st.cell.width) + 1, row: Math.floor((y - st.screen.top) / st.cell.height) + 1 });
// Waits for the TUI to show more than `count` wheel reports.
const wheelsAbove = (frame, count) => frame.waitForFunction(n => Number((/^wheel (\d+):/.exec(window.__screenLine(1)) || [])[1] || 0) > n, count, { timeout: 15000 });
// One wheel step down at the page point x, y (`dx`, `dy` = the point's offset from the frame to the page); returns the report the TUI read.
async function wheelAt(page, frame, x, y, { dx = 0, dy = 0 } = {}) {
  const before = (await status(frame)).wheels;
  await page.mouse.move(x + dx, y + dy);
  await page.mouse.wheel(0, 100);
  await wheelsAbove(frame, before);
  return status(frame);
}

(async () => {
  try {
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    wss = new WebSocketServer({ server });
    wss.on('connection', (ws, req) => terminal.handleWs(ws, req, { login: 'owner' }));
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });

    // ── Computer, Fit ──
    {
      const { context, page } = await newPage({ viewport: { width: 1440, height: 900 } });
      assert.equal(await page.evaluate(() => document.documentElement.dataset.input), 'pointer');
      await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-screen')?.clientHeight > 10 && window.__testTerms.length > 0, null, { timeout: 30000 });
      const input = page.locator('.h5-xterm:not([hidden]) .xterm-helper-textarea');
      await input.focus();
      await page.keyboard.type('faketui');
      await page.keyboard.press('Enter');
      await tuiShown(page);
      let st = await status(page);
      await page.waitForFunction(() => document.querySelector('#h5-wheel')?.dataset.mode === 'spring');
      assert.equal(await page.evaluate(() => document.querySelector('#h5-wheel').getBoundingClientRect().width), 16, 'the wheel strip is drawn in pointer mode too (16px, beside the terminal box)');
      const row = Math.round(st.rows / 2);
      for (const col of [3, Math.round(st.cols / 2), st.cols - 2, st.cols]) {
        const point = cellPoint(st, col, row);
        st = await wheelAt(page, page, point.x, point.y);
        assert.deepEqual([st.button, st.col, st.row], [65, col, row], `Fit: a wheel down over column ${col} of ${st.cols} reaches the program at that cell`);
      }

      // ── Computer, Wide: the screen moved to its right end stays there under the mouse ──
      await page.locator('#h5-term-width').click();
      await page.waitForFunction(() => { const term = window.__testTerms.at(-1); return term.cols === 200 && window.__screenLine(0).startsWith('TUI ready 200x'); }, null, { timeout: 15000 });
      st = await status(page);
      assert.equal(st.offset, 0, 'Wide starts at the left end, with the cursor in view');
      const middle = { x: st.box.left + st.box.width / 2, y: st.box.top + st.box.height / 2 };
      await page.mouse.move(middle.x, middle.y);
      await page.keyboard.down('Shift');
      await page.mouse.wheel(0, 4000);
      await page.keyboard.up('Shift');
      await page.waitForFunction(() => { const el = document.querySelector('.h5-xterm:not([hidden])'); const screen = el.querySelector('.xterm-screen'); return Math.abs(screen.offsetWidth - el.clientWidth - (el.getBoundingClientRect().left - screen.getBoundingClientRect().left)) <= 1; });
      st = await status(page);
      const end = st.offset;
      assert.ok(end > 100, `Shift+wheel moved the wide screen to its right end (${end}px)`);
      // Motion reports: the mouse moves over the right part (opencode asks for any-motion reports, so every move is one).
      const moves = st.moves;
      for (const col of [190, 194, 198]) { const point = cellPoint(st, col, row); await page.mouse.move(point.x, point.y); }
      await page.waitForFunction(n => Number((/^moves (\d+)/.exec(window.__screenLine(2)) || [])[1] || 0) > n, moves);
      assert.equal((await status(page)).offset, end, 'mouse moves (motion reports) do not pull the wide view back to the cursor');
      // Wheels over the right-most columns: each one names the cell under the pointer, and the view stays.
      for (const col of [198, 190, 200]) {
        const point = cellPoint(st, col, row);
        const now = await wheelAt(page, page, point.x, point.y);
        assert.deepEqual([now.col, now.row], [col, row], `Wide at the right end: a wheel over column ${col} reaches that cell`);
        assert.equal(now.offset, end, `Wide: the wheel over column ${col} leaves the view at the right end`);
      }
      // A typed key is input: it brings the cursor (column 3 of the input line) back into view.
      await input.focus();
      await page.keyboard.press('x');
      await page.waitForFunction(() => { const el = document.querySelector('.h5-xterm:not([hidden])'); return el.getBoundingClientRect().left - el.querySelector('.xterm-screen').getBoundingClientRect().left < 1; });
      await page.locator('#h5-term-width').click(); // back to Fit
      await page.waitForFunction(() => window.__testTerms.at(-1).cols < 200);
      await context.close();
    }

    // ── Touch screen with a mouse: the wheel strip ──
    {
      const { context, page } = await newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true });
      assert.equal(await page.evaluate(() => document.documentElement.dataset.input), 'touch');
      await tuiShown(page);
      await page.waitForFunction(() => document.querySelector('#h5-wheel')?.dataset.mode === 'spring');
      let st = await status(page);
      const strip = await page.evaluate(() => { const box = document.querySelector('#h5-wheel').getBoundingClientRect(); return { left: box.left, width: box.width, top: box.top, height: box.height }; });
      const row = Math.round(st.rows / 2);
      // A mouse wheel over the strip reaches the cell under it.
      const over = { x: strip.left + strip.width / 2, y: st.screen.top + (row - 0.5) * st.cell.height };
      assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, over), 'h5-wheel', 'the point is over the strip');
      st = await wheelAt(page, page, over.x, over.y);
      const under = cellUnder(st, over.x, over.y);
      assert.deepEqual([st.button, st.col, st.row], [65, under.col, under.row], `a wheel over the strip reaches the terminal cell under it (${under.col} of ${st.cols})`);
      // The spring's wheel reports point at the middle of the visible terminal.
      const cdp = await context.newCDPSession(page);
      const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
      const before = st.wheels;
      const sx = strip.left + strip.width / 2; const sy = strip.top + strip.height / 2;
      await touch('touchStart', sx, sy);
      for (let i = 1; i <= 5; i++) { await touch('touchMove', sx, sy + i * 20); await page.waitForTimeout(16); }
      await wheelsAbove(page, before + 2);
      await touch('touchEnd');
      await page.waitForFunction(() => !window.__h5WheelSpring());
      st = await status(page);
      const expected = cellUnder(st, st.box.left + st.box.width / 2, strip.top + strip.height / 2);
      assert.equal(st.button, 65, 'pulled down: wheel down');
      assert.deepEqual([st.col, st.row], [expected.col, expected.row], `the spring scrolls at the middle of the visible terminal (column ${st.col} of ${st.cols}), not at the strip's last columns`);
      await cdp.detach();
      await context.close();
    }

    // ── Columns view: a wheel inside a column ──
    {
      const storage = { ...REMEMBERED, 'h5-columns': JSON.stringify({ on: true, ids: ['s1'] }), 'pane:s1:h5-task:local': String(task.id), [`pane:s1:h5-terminal:local:${task.id}`]: 'default' };
      const { context, page } = await newPage({ viewport: { width: 1440, height: 900 } }, storage);
      await page.waitForFunction(() => document.querySelector('#h5-columns iframe[data-pane-id="s1"]')?.contentWindow?.__testTerms?.length > 0, null, { timeout: 30000 });
      const frame = page.frames().find(item => item.url().endsWith('/h5?pane=s1'));
      await tuiShown(frame);
      const offset = await page.locator('#h5-columns iframe[data-pane-id="s1"]').boundingBox();
      let st = await status(frame);
      const row = Math.round(st.rows / 2);
      for (const col of [3, Math.round(st.cols / 2), st.cols - 1]) {
        const point = cellPoint(st, col, row);
        st = await wheelAt(page, frame, point.x, point.y, { dx: offset.x, dy: offset.y });
        assert.deepEqual([st.button, st.col, st.row], [65, col, row], `columns view: a wheel over column ${col} of ${st.cols} reaches that cell`);
      }
      await context.close();
    }
    assert.deepEqual(errors, [], 'no page errors');
    console.log('h5 TUI wheel browser test passed');
  } finally {
    if (browser) await browser.close();
    terminal.closeTaskTerminals(task.id);
    if (wss) { for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); }
    if (server) await new Promise(resolve => server.close(resolve));
    db.close(); fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
