// The phone's draft box and session header while the system keyboard is up ("Draft box" in docs/design/page-terminal-and-bottom-bar.md, "Session
// header" in docs/design/page-navigation.md), in real Chromium at phone size (390x844, touch). The keyboard is simulated as in
// test-h5-viewport-collapse-browser.cjs: `visualViewport.height` is stubbed shorter while the draft box has the focus. Checked:
// - the draft box is ONE row: the text field on the left, "Send as is" (an icon button) and "Send" at its right, all 44px targets;
// - the field is one line when empty, grows with its text up to four lines and then scrolls inside;
// - nothing is reserved under the row while the keyboard is up (no safe-area or bottom navigation room): the row sits flush on the keyboard;
// - the header is one row (menu, task name, state dot, More) while the keyboard is up, and comes back whole when it goes;
// - the terminal area left above the row is at least 20% taller than the old layout gave for the same keyboard (BEFORE_TERMINAL, measured with the
//   old two-row draft box and the two-line header, v2.163.0), and the terminal is not resized while the keyboard is up; it refits once it is down.
// The server is mocked (no data folder is used).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const WIDTH = 390;
const HEIGHT = 844;
const KEYBOARD = 336; // an iPhone keyboard with its suggestion bar
const SAFE_AREA = { top: 47, bottom: 34, left: 0, right: 0 }; // an iPhone 14 in portrait
// The visible terminal area (from the header to the draft box) of the old layout with this keyboard, in this test's Chromium (no safe areas: on an
// iPhone, emulated here with SAFE_AREA: the old layout also kept the 34px bottom inset under its buttons).
const BEFORE_TERMINAL = 267;
const TASKS = [{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }];
const TERMINALS = { 1: [{ terminal_id: 'h5-default', title: 'Terminal 1' }] };
const pageErrors = [];
const failures = [];

function check(ok, message) {
  if (ok) { console.log(`  ok ${message}`); return; }
  failures.push(message);
  console.log(`  FAILED ${message}`);
}

async function openPage(browser) {
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  // An iPhone's safe areas (the notch and the home indicator), which Chromium can emulate: the old layout kept the bottom one under its buttons.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: SAFE_AREA });
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
    let visual = null;
    const viewport = new EventTarget();
    Object.defineProperties(viewport, {
      height: { get: () => visual ?? window.innerHeight },
      width: { get: () => window.innerWidth }, offsetTop: { get: () => 0 }, offsetLeft: { get: () => 0 }, scale: { get: () => 1 },
    });
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
    window.setKeyboard = height => { visual = height ? window.innerHeight - height : null; viewport.dispatchEvent(new Event('resize')); };
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
    if (url.pathname === '/api/tasks/terminal-activity' || url.pathname === '/api/tasks/terminal-subagents') return json({});
    const terminals = url.pathname.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (terminals && method === 'GET') return json(TERMINALS[terminals[1]] || []);
    if (url.pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    if (url.pathname === '/api/oss/config') return json({ enabled: false });
    if (url.pathname === '/api/system/check-update' || url.pathname === '/api/system/update-status') return json({ status: 'up_to_date', local_version: '1.0.0' });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  await page.locator('#h5-tasks').waitFor({ state: 'visible' });
  await page.locator('.h5-task-item', { hasText: 'Fix login' }).click();
  await page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main', { hasText: 'Terminal 1' }).click();
  await page.waitForFunction(() => window.sockets.length > 0 && window.sockets.at(-1).readyState === 1 && document.querySelector('.h5-xterm:not([hidden]) .xterm-rows'));
  await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => window.sockets.at(-1).sent.some(item => item.includes('"resize"')));
  await page.waitForTimeout(1200);
  return { context, page };
}

const settled = page => page.waitForFunction(() => !document.getAnimations().some(a => a.playState === 'running') && !document.querySelector('.h5-bar-moving'), null, { timeout: 3000 });
const measure = async page => { await settled(page); return page.evaluate(() => {
  const rect = el => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height }; };
  const byId = id => rect(document.getElementById(id));
  const shown = el => Boolean(el) && el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden';
  const resizes = window.sockets.at(-1).sent.map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(item => item && item.type === 'resize');
  const input = document.getElementById('h5-translate-input');
  const style = getComputedStyle(input);
  return {
    header: rect(document.querySelector('.h5-header')), terminal: byId('h5-terminal'), bottom: byId('h5-bottom'), form: byId('h5-translate'),
    input: byId('h5-translate-input'), field: rect(document.querySelector('.h5-translate-input')), send: byId('h5-translate-send'), translate: byId('h5-translate-button'),
    page: parseFloat(document.documentElement.style.getPropertyValue('--h5-height')), soft: Boolean(window.H5UI.get().softKeyboard),
    line: parseFloat(style.lineHeight), pad: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom), overflowY: style.overflowY, scrollHeight: input.scrollHeight, clientHeight: input.clientHeight,
    headerParts: { menu: shown(document.getElementById('h5-open-tasks')), name: shown(document.getElementById('h5-task-name')), dot: shown(document.querySelector('.h5-header .h5-header-dot')),
      more: shown(document.getElementById('h5-header-more')), device: shown(document.getElementById('h5-task-service')), subline: shown(document.querySelector('.h5-header .h5-task-subline')),
      session: shown(document.getElementById('h5-session-name')), usage: shown(document.getElementById('h5-usage')) },
    sendLabel: { aria: document.getElementById('h5-translate-send').getAttribute('aria-label'), title: document.getElementById('h5-translate-send').title, type: document.getElementById('h5-translate-send').type },
    resizes: resizes.length, rows: document.querySelectorAll('.h5-xterm:not([hidden]) .xterm-rows > div').length, lastResize: resizes.at(-1) || null,
    bottomPadding: parseFloat(getComputedStyle(document.getElementById('h5-bottom')).paddingBottom) || 0, appPadding: parseFloat(getComputedStyle(document.querySelector('.h5-app')).paddingBottom) || 0,
  };
}); };
// The terminal area the person sees: from the top of the terminal box to the top of whatever covers its bottom (the draft box grows over it).
const visibleTerminal = state => Math.round(Math.min(state.terminal.bottom, state.form.height ? state.form.top : state.bottom.top) - state.terminal.top);

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const { context, page } = await openPage(browser);
    // The cursor on the last row (a prompt at the bottom), so the terminal is moved up as far as the draft row covers it.
    await page.evaluate(() => window.sockets.at(-1).emit('\x1b[999;1Hlast'));
    await page.waitForTimeout(200);
    const closed = await measure(page);
    console.log(`closed: header ${closed.header.height}, terminal ${closed.terminal.height}, rows ${closed.rows}`);
    // The draft keyboard key focuses the box; the system keyboard comes up.
    await page.locator('[data-action="draft"]').tap();
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'h5-translate-input');
    await page.evaluate(height => window.setKeyboard(height), KEYBOARD);
    await page.waitForFunction(() => window.H5UI.get().softKeyboard === true);
    await page.waitForTimeout(300);
    const open = await measure(page);
    const visible = visibleTerminal(open);
    console.log(`keyboard ${KEYBOARD}px: page ${open.page}, header ${open.header.height}, form ${Math.round(open.form.top)}-${Math.round(open.form.bottom)}, bottom ${Math.round(open.bottom.top)}-${Math.round(open.bottom.bottom)}, visible terminal ${visible}px`);
    const near = (a, b, margin = 1.5) => Math.abs(a - b) <= margin;
    // ONE row: the field and both buttons share the row's bottom line, the field on the left takes the rest of the width.
    check(near(open.field.bottom, open.send.bottom) && near(open.field.bottom, open.translate.bottom), `the field and the two buttons are on one row (${open.field.bottom}, ${open.send.bottom}, ${open.translate.bottom})`);
    check(open.field.right <= open.send.left && open.send.right <= open.translate.left, 'field, then Send as is, then Send, left to right');
    check(open.field.left <= 9 && open.translate.right >= WIDTH - 9 && open.field.width > 200, `the field takes the free width (${Math.round(open.field.width)}px)`);
    check(open.send.width >= 44 && open.send.height >= 44 && open.translate.height >= 44 && open.translate.width >= 44, 'both buttons are 44px targets');
    check(open.sendLabel.aria === 'Send as is' && open.sendLabel.title === 'Send as is' && open.sendLabel.type === 'submit', `"Send as is" is the form's submit, named "Send as is" (${JSON.stringify(open.sendLabel)})`);
    check(near(open.field.height, open.line + open.pad, 2) && open.field.height >= 44, `the empty field is one 44px line (${open.field.height}px)`);
    // Flush on the keyboard: nothing reserved under the row.
    check(open.bottomPadding === 0 && open.appPadding === 0, `no safe-area or navigation room under the row while the keyboard is up (${open.bottomPadding}, ${open.appPadding})`);
    check(near(open.form.bottom, HEIGHT - KEYBOARD) && near(open.bottom.bottom, HEIGHT - KEYBOARD), `the draft row ends on the keyboard (${open.form.bottom}, ${open.bottom.bottom}, keyboard top ${HEIGHT - KEYBOARD})`);
    // The header is one row.
    const parts = open.headerParts;
    check(parts.menu && parts.name && parts.dot && parts.more, `the collapsed header keeps menu, name, dot and More (${JSON.stringify(parts)})`);
    check(!parts.device && !parts.subline && !parts.session && !parts.usage, `the collapsed header hides the device tag, the status line and Plan usage (${JSON.stringify(parts)})`);
    check(near(open.header.height, 48), `the collapsed header is 48px (${open.header.height})`);
    // The terminal gets the height.
    check(visible >= BEFORE_TERMINAL * 1.2, `the terminal area is at least 20% taller than before (${visible}px, before ${BEFORE_TERMINAL}px)`);
    check(open.resizes === closed.resizes, `no PTY resize while the keyboard is up (${closed.resizes} to ${open.resizes})`);
    const lastRowShown = await page.evaluate(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-screen').getBoundingClientRect().bottom);
    check(lastRowShown <= open.form.top + 1, 'the last terminal row stays above the draft row');

    // Four lines at most, then it scrolls inside; the buttons stay on the bottom line.
    const input = page.locator('#h5-translate-input');
    const lines = n => Array.from({ length: n }, (_, i) => `row ${i + 1}`).join('\n');
    let previous = open;
    for (const n of [2, 3, 4]) {
      await input.fill(lines(n));
      const grown = await measure(page);
      check(near(grown.field.height, n * grown.line + grown.pad, 3) && grown.overflowY !== 'auto', `${n} lines are all shown (${grown.field.height}px)`);
      check(grown.field.height > previous.field.height + 10, `${n} lines: taller than before`);
      check(near(grown.send.bottom, open.send.bottom) && near(grown.translate.bottom, open.translate.bottom), `${n} lines: the buttons stay on the bottom line`);
      previous = grown;
    }
    await input.fill(lines(9));
    const capped = await measure(page);
    check(near(capped.field.height, previous.field.height) && capped.overflowY === 'auto' && capped.scrollHeight > capped.clientHeight + 10, `beyond four lines the field scrolls inside (${capped.field.height}px)`);
    check(capped.resizes === closed.resizes, 'no PTY resize while the field grows');
    await input.fill('');
    check(near((await measure(page)).field.height, open.field.height), 'back to one line when emptied');
    if (process.env.H5_SHOT_DIR) await page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, 'h5-compact-draft.png') });

    // The keyboard goes down: the header and the bottom area come back whole, the terminal has its closed size and was never resized.
    await page.evaluate(() => window.setKeyboard(0));
    await page.waitForFunction(() => window.H5UI.get().softKeyboard === false);
    await page.waitForTimeout(400);
    const back = await measure(page);
    check(near(back.header.height, closed.header.height) && back.headerParts.subline && back.headerParts.usage === closed.headerParts.usage, `the header is whole again (${back.header.height}px)`);
    check(near(back.terminal.height, closed.terminal.height) && back.rows === closed.rows, `the terminal is back to its closed size (${back.terminal.height}px, ${back.rows} rows)`);
    check(back.resizes === closed.resizes, `no PTY resize for the keyboard round trip (${closed.resizes} to ${back.resizes})`);
    check(back.bottomPadding === SAFE_AREA.bottom || back.appPadding > 0, `the bottom safe area is kept again (${back.bottomPadding}, ${back.appPadding})`);
    // A real change of the box still refits: a narrower window gives fewer columns.
    const cols = await page.evaluate(() => window.sockets.at(-1).sent.map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(item => item && item.type === 'resize').at(-1).cols);
    await page.setViewportSize({ width: 320, height: HEIGHT });
    await page.waitForFunction(before => { const last = window.sockets.at(-1).sent.map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(item => item && item.type === 'resize').at(-1); return last && last.cols < before; }, cols, { timeout: 4000 }).then(() => check(true, 'the terminal still refits to a real size change'), () => check(false, 'the terminal still refits to a real size change'));
    await context.close();
  } finally { await browser.close(); }
  if (pageErrors.length) failures.push(`page errors: ${pageErrors.join(' | ')}`);
  if (failures.length) { console.error(`\n${failures.length} failed:\n${failures.join('\n')}`); process.exit(1); }
  console.log('\nall compact draft checks passed');
})().catch(error => { console.error(error); process.exit(1); });
