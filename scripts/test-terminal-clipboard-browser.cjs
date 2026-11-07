// Program copy requests (OSC 52, public/js/terminal-clipboard.js) on the real page in Chromium, in touch mode (a phone) and pointer mode (a computer):
// right after the user's own tap or click on the terminal the text goes to the clipboard at once ("Copied N characters"); without a gesture the
// MUI dialog shows the text and copies only on "Confirm copy" (Cancel copies nothing); when the browser refuses the automatic write, the
// "Tap to copy" bar writes inside its own tap; replayed history and a hidden terminal never copy. Pointer mode also checks Cmd+C on a selection.
// The page is served over https (routed), so the real clipboard API is used with granted permissions.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'https://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const osc = text => `\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`;

async function openPage(browser, touch) {
  const context = await browser.newContext({ viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 }, ...(touch ? { isMobile: true, hasTouch: true } : {}) });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.sockets = [];
    window.FakeSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
      emit(data) { this.onmessage?.({ data }); }
    };
    window.FakeSocket.OPEN = 1;
    window.FakeSocket.CONNECTING = 0;
    window.WebSocket = window.FakeSocket;
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    if (url.pathname === '/api/remote-servers') return json([]);
    if (url.pathname === '/api/tasks' && route.request().method() === 'GET') return json([{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }]);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (url.pathname === '/api/tasks/1/terminals') return json([{ terminal_id: 'h5-default', title: 'Terminal 1' }]);
    if (url.pathname === '/api/tasks/1/agent/conversations') return json([]);
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.input), touch ? 'touch' : 'pointer');
  const how = touch ? 'tap' : 'click';
  if (touch || !(await page.locator('.h5-task-item', { hasText: 'Fix login' }).isVisible())) await page.locator('#h5-open-tasks')[how]().catch(() => {});
  await page.locator('.h5-task-item', { hasText: 'Fix login' })[how]();
  await page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main').first()[how]();
  await page.waitForFunction(() => window.sockets.length === 1 && window.sockets[0].readyState === 1);
  await page.evaluate(() => window.sockets[0].emit(JSON.stringify({ type: 'history', data: '$ ', cols: 60, rows: 20 })));
  await page.evaluate(() => window.sockets[0].emit('hello world from the shell\r\n$ '));
  await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-rows')?.textContent.includes('hello world'));
  await page.waitForTimeout(400); // the replay pause ends
  return { page, context, errors };
}

async function run(browser, touch) {
  const mode = touch ? 'touch' : 'pointer';
  const { page, context, errors } = await openPage(browser, touch);
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const setClipboard = text => page.evaluate(value => navigator.clipboard.writeText(value), text);
  const emit = data => page.evaluate(value => window.sockets[0].emit(value), data);
  const dialog = page.locator('#h5-clipboard');
  const notice = () => page.locator('.MuiSnackbar-root .MuiAlert-message').last();
  // A gesture on the terminal: a finger tap in touch mode, a mouse click in pointer mode (on an empty row, away from the text).
  const gesture = async () => {
    const box = await page.locator('.h5-xterm:not([hidden]) .xterm-screen').boundingBox();
    if (touch) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height - 20);
    else await page.mouse.click(box.x + box.width / 2, box.y + box.height - 20);
  };
  // Wait out the gesture window (1500 ms) of the taps that opened the terminal.
  await page.waitForTimeout(1600);

  // 1. No gesture: the dialog shows the text; nothing is written before Confirm copy.
  await setClipboard('before');
  await emit(osc('Remote program\nhello ✓ 中文'));
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#h5-clipboard-text').inputValue(), 'Remote program\nhello ✓ 中文');
  // A second request cannot replace the text shown for approval.
  await emit(osc('evil'));
  assert.equal(await page.locator('#h5-clipboard-text').inputValue(), 'Remote program\nhello ✓ 中文');
  assert.equal(await clipboard(), 'before', `${mode}: nothing written before confirmation`);
  await page.locator('#h5-clipboard-confirm')[touch ? 'tap' : 'click']();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await clipboard(), 'Remote program\nhello ✓ 中文', `${mode}: Confirm copy writes`);
  await page.waitForFunction(() => [...document.querySelectorAll('.MuiAlert-message')].some(node => node.textContent === 'Copied 25 characters'));

  // 2. No gesture, Cancel: nothing is written.
  await emit(osc('cancelled text'));
  await dialog.waitFor({ state: 'visible' });
  await page.locator('#h5-clipboard-cancel-ask')[touch ? 'tap' : 'click']();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await clipboard(), 'Remote program\nhello ✓ 中文', `${mode}: Cancel copies nothing`);
  await page.waitForTimeout(1600); // the Cancel tap was not on the terminal, but wait anyway so the next case starts clean

  // 3. Right after a gesture on the terminal (Claude Code copies a selection on release): written at once, no dialog, even split over two writes.
  await gesture();
  const payload = Buffer.from('selected in Claude Code').toString('base64');
  await emit(`\x1b]52;c;${payload.slice(0, 6)}`);
  await page.waitForTimeout(150);
  await emit(`${payload.slice(6)}\x07`);
  await page.waitForFunction(() => [...document.querySelectorAll('.MuiAlert-message')].some(node => node.textContent === 'Copied 23 characters'));
  assert.equal(await clipboard(), 'selected in Claude Code', `${mode}: user-initiated copy is written at once`);
  assert.equal(await dialog.isVisible(), false, `${mode}: no dialog for a user-initiated copy`);
  // The same text again at once (a pbcopy shim plus the program's own OSC 52) is merged: no second write, no dialog.
  await setClipboard('marker');
  await emit(osc('selected in Claude Code'));
  await page.waitForTimeout(300);
  assert.equal(await dialog.isVisible(), false, `${mode}: a duplicate opens no dialog`);
  assert.equal(await clipboard(), 'marker', `${mode}: a duplicate is not written again`);
  await setClipboard('selected in Claude Code');
  // The gesture is used up: the next request asks.
  await emit(osc('second request'));
  await dialog.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await clipboard(), 'selected in Claude Code');

  // 4. The browser refuses the automatic write (iOS Safari after a network round trip): the "Tap to copy" bar writes inside its own tap.
  await page.evaluate(() => {
    const real = navigator.clipboard.writeText.bind(navigator.clipboard);
    window.refuseOnce = true;
    navigator.clipboard.writeText = text => (window.refuseOnce ? (window.refuseOnce = false, Promise.reject(new DOMException('no activation', 'NotAllowedError'))) : real(text));
    const exec = document.execCommand.bind(document);
    document.execCommand = command => (command === 'copy' && window.refuseExec ? false : exec(command));
    window.refuseExec = true;
  });
  await gesture();
  await emit(osc('needs its own tap'));
  await page.locator('#h5-clipboard-bar').waitFor({ state: 'visible' });
  assert.equal(await clipboard(), 'selected in Claude Code');
  await page.evaluate(() => { window.refuseExec = false; });
  await page.locator('#h5-clipboard-copy')[touch ? 'tap' : 'click']();
  await page.locator('#h5-clipboard-bar').waitFor({ state: 'hidden' });
  assert.equal(await clipboard(), 'needs its own tap', `${mode}: Tap to copy writes`);

  // 5. Replayed history never copies or asks, even right after a gesture.
  await gesture();
  await page.evaluate(data => window.sockets[0].emit(JSON.stringify({ type: 'history', data, cols: 60, rows: 20 })), `$ ${osc('replayed')}`);
  await page.waitForTimeout(500);
  assert.equal(await dialog.isVisible(), false);
  assert.equal(await page.locator('#h5-clipboard-bar').count(), 0);
  assert.equal(await clipboard(), 'needs its own tap', `${mode}: replay copies nothing`);

  // 6. Pointer mode: a mouse selection and Cmd+C still copy (the page's own selection, not OSC 52).
  if (!touch) {
    await page.evaluate(() => window.sockets[0].emit('\r\nselect me please\r\n$ '));
    await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-rows')?.textContent.includes('select me'));
    const row = await page.evaluate(() => {
      const node = [...document.querySelectorAll('.h5-xterm:not([hidden]) .xterm-rows > div')].find(item => item.textContent.startsWith('select me'));
      const box = node.getBoundingClientRect();
      return { x: box.left, y: box.top + box.height / 2 };
    });
    await page.mouse.move(row.x + 2, row.y);
    await page.mouse.down();
    await page.mouse.move(row.x + 60, row.y, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.press('Meta+c');
    await page.waitForFunction(() => navigator.clipboard.readText().then(text => text.startsWith('select')), null, { timeout: 2000 });
  }
  assert.deepEqual(errors, []);
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await run(browser, true);
    await run(browser, false);
    console.log('PASS: OSC 52 on the page in touch and pointer mode: auto copy after a gesture (split request, duplicate merged), confirmation dialog without one (Confirm / Cancel, immutable preview), Tap to copy fallback, replay ignored, Cmd+C on a mouse selection.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
