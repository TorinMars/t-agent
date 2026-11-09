// One key press, one character on the terminal's socket, in real Chromium with real key presses (CDP) and mocked sockets. xterm sends a plain Space on keypress and does
// not cancel the key, so the browser's `insertText` input event follows; `TerminalIme` (public/js/terminal-ime.js) must not take it for one xterm dropped. Covered: focus in
// the terminal, Shift+Space, a held key, back from the draft box, after switching terminals (warm), after a reconnect, phone width with a hardware keyboard; other keys; the
// page-level forwarding from the body; and the Apple Chinese keyboard's keydown (229) + insertText, which must still arrive.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const TERMINALS = [{ terminal_id: 't1', title: 'Terminal 1' }, { terminal_id: 't2', title: 'Terminal 2' }];
const pageErrors = [];
const SETTLE_MS = 200; // past TerminalIme's settle window, so a late second copy is seen

async function openPage(browser, options) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
  });
  await page.route(`${ORIGIN}/**`, route => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    if (url.pathname === '/api/remote-servers') return json([]);
    if (url.pathname === '/api/tasks') return json([{ id: 1, title: 'Alpha', status: 'doing' }]);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (url.pathname === '/api/tasks/1/terminals') return json(TERMINALS);
    if (url.pathname === '/api/tasks/1/agent/conversations') return json([]);
    if (url.pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    if (url.pathname === '/api/tasks/terminal-activity') return json({});
    if (url.pathname === '/api/tasks/terminal-subagents') return json({});
    if (url.pathname === '/api/system/check-update' || url.pathname === '/api/system/update-status') return json({ status: 'up_to_date', local_version: '1.0.0' });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  await page.locator('#h5-tasks').waitFor({ state: 'visible' });
  const cdp = await context.newCDPSession(page);
  return { context, page, cdp };
}

async function pick(page, name, touch) {
  if (!(await page.locator('#h5-tasks').isVisible())) await page.locator('#h5-open-tasks').click(); // the task itself was opened by the caller and stays open
  const row = page.locator('#h5-tasks .h5-terminal-main', { hasText: name });
  await row.waitFor({ state: 'visible' });
  if (touch) await row.tap(); else await row.click();
  await page.waitForFunction(id => {
    const el = document.querySelector('.h5-xterm:not([hidden])');
    return el && el.dataset.terminalId === id && el.querySelector('.xterm-rows') && window.sockets.some(socket => socket.readyState === 1 && socket.url.includes(`terminalId=${id}`));
  }, TERMINALS.find(item => item.title === name).terminal_id);
}

const textarea = page => page.locator('.h5-xterm:not([hidden]) .xterm-helper-textarea');
const typedSince = (page, from) => page.evaluate(start => window.sockets.flatMap(socket => socket.sent).filter(item => !item.startsWith('{')).slice(start), from);
const blur = page => page.evaluate(() => document.activeElement && document.activeElement.blur());

// Runs `act` and asserts that exactly `want` went out, across every socket.
async function expectSent(page, want, act, what) {
  await page.evaluate(() => { for (const socket of window.sockets) socket.sent = socket.sent.filter(item => item.startsWith('{')); });
  await act();
  await page.waitForTimeout(SETTLE_MS);
  assert.deepEqual(await typedSince(page, 0), want, what);
}

async function ime229(cdp, text) { // the Apple Chinese keyboard: keydown 229, then an insertText input event, no keypress
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 229, key: 'Process', code: 'Space' });
  await cdp.send('Input.insertText', { text });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 32, key: ' ', code: 'Space' });
}
async function heldSpace(cdp, repeats) { // the auto-repeat of a held key: keyDown events with autoRepeat
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 32, key: ' ', code: 'Space', text: ' ' });
  for (let i = 0; i < repeats; i += 1) await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 32, key: ' ', code: 'Space', text: ' ', autoRepeat: true });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 32, key: ' ', code: 'Space' });
}

async function keysInTheTerminal(page, cdp, label) {
  await textarea(page).focus();
  await expectSent(page, [' '], () => page.keyboard.press('Space'), `${label}: Space once`);
  await expectSent(page, [' ', ' '], async () => { await page.keyboard.press('Space'); await page.keyboard.press('Space'); }, `${label}: two presses, two spaces`);
  await expectSent(page, [' '], () => page.keyboard.press('Shift+Space'), `${label}: Shift+Space once`);
  await expectSent(page, [' ', ' ', ' '], () => heldSpace(cdp, 2), `${label}: a held Space, one per repeat`);
  await expectSent(page, ['a'], () => page.keyboard.press('a'), `${label}: a letter once`);
  await expectSent(page, ['A'], () => page.keyboard.press('Shift+A'), `${label}: a capital once`);
  await expectSent(page, ['7'], () => page.keyboard.press('7'), `${label}: a digit once`);
  await expectSent(page, [','], () => page.keyboard.press(','), `${label}: punctuation once`);
  await expectSent(page, ['\r'], () => page.keyboard.press('Enter'), `${label}: Enter once`);
  await expectSent(page, [' '], () => ime229(cdp, ' '), `${label}: the Apple Chinese keyboard's space still arrives, once`);
  await expectSent(page, ['，'], () => ime229(cdp, '，'), `${label}: its punctuation still arrives, once`);
  await expectSent(page, [' ', ' '], async () => { await page.keyboard.press('Space'); await ime229(cdp, ' '); }, `${label}: a Space, then the Apple keyboard's space`);
}

async function computer(browser) {
  const { context, page, cdp } = await openPage(browser, { viewport: { width: 1280, height: 800 } });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.input), 'pointer');
  await page.locator('.h5-task-item', { hasText: 'Alpha' }).click();
  await pick(page, 'Terminal 1', false);
  await keysInTheTerminal(page, cdp, 'computer');

  // The page-level forwarding: from the body, the key is sent once and the terminal takes the focus.
  await blur(page);
  await expectSent(page, [' '], () => page.keyboard.press('Space'), 'body: Space forwarded once');
  assert.equal(await page.evaluate(() => document.activeElement.className.includes('xterm-helper-textarea')), true, 'body: the terminal took the focus');
  await expectSent(page, [' '], () => page.keyboard.press('Space'), 'body: the next Space goes to the terminal, once');
  await blur(page);
  await expectSent(page, ['a'], () => page.keyboard.press('a'), 'body: a letter forwarded once');

  // Typing in the draft box stays there; back in the terminal, one space again.
  await page.locator('#h5-translate-input').click();
  await expectSent(page, [], () => page.keyboard.press('Space'), 'draft box: Space stays in the box');
  assert.equal(await page.locator('#h5-translate-input').inputValue(), ' ');
  await textarea(page).focus();
  await expectSent(page, [' '], () => page.keyboard.press('Space'), 'back from the draft box: Space once');

  // A warm terminal: to the second one and back, only the shown one types.
  await pick(page, 'Terminal 2', false);
  await textarea(page).focus();
  await expectSent(page, [' '], () => page.keyboard.press('Space'), 'second terminal: Space once');
  await pick(page, 'Terminal 1', false);
  await textarea(page).focus();
  await expectSent(page, [' '], () => page.keyboard.press('Space'), 'back on the warm terminal: Space once');

  // A reconnect: the socket drops and a new one takes over.
  const sockets = await page.evaluate(() => window.sockets.length);
  await page.evaluate(() => { const shown = document.querySelector('.h5-xterm:not([hidden])').dataset.terminalId; const socket = window.sockets.filter(item => item.url.includes(`terminalId=${shown}`)).at(-1); socket.readyState = 3; socket.onclose?.({ code: 1006 }); });
  await page.waitForFunction(count => window.sockets.length > count && window.sockets.at(-1).readyState === 1, sockets);
  await page.waitForTimeout(100);
  await textarea(page).focus();
  await expectSent(page, [' '], () => page.keyboard.press('Space'), 'after a reconnect: Space once');
  await context.close();
}

async function phoneWithKeyboard(browser) {
  const { context, page, cdp } = await openPage(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.input), 'touch');
  await page.locator('.h5-task-item', { hasText: 'Alpha' }).tap();
  await pick(page, 'Terminal 1', true);
  await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-rows'));
  await textarea(page).focus();
  await page.keyboard.press('Space'); // the first hardware key is what makes the page know there is a keyboard
  await page.waitForFunction(() => document.documentElement.dataset.keyboard === 'hardware');
  await keysInTheTerminal(page, cdp, 'phone');
  await blur(page);
  await expectSent(page, [' '], () => page.keyboard.press('Space'), 'phone, body: Space forwarded once');
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await computer(browser);
    await phoneWithKeyboard(browser);
    assert.deepEqual(pageErrors, []);
    console.log('space key test passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
