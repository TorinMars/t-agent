// Auto-paired punctuation of input methods (public/js/terminal-ime-pairs.js), in real Chromium with CDP key and IME input and mocked sockets. WeType answers
// one press of " with the pair “” in one insertion and then a Left arrow key; the terminal must send ONE quote per press (opening, closing, opening, ...),
// never the Left key and never repeated text, whether the keydown is a plain one or the input method's 229 and whether the Left comes after or before the
// pair. Ordinary Left keys, a pinyin composition, the Apple-style 229 punctuation, a paste of the pair and a pair without a Left key stay as they were, and a
// Left key pressed right after an input method's key never overtakes that key's text, also when xterm's timers run late (`slowTimers`).
// Only Chromium: WebKit / the Mac app with the real WeType are not covered here.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const TERMINALS = [{ terminal_id: 't1', title: 'Terminal 1' }];
const pageErrors = [];
const SETTLE_MS = 300; // past the pair window (100 ms) and xterm's setTimeout diff, so a late or repeated copy is seen
const LQ = '\u201C'; const RQ = '\u201D'; const QUOTES = LQ + RQ;
const BANG = '\uFF01';

async function openPage(browser, options) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    // A busy page, made deterministic: while `slowTimers` is set, every shorter timer (xterm's 0 ms composition and textarea-diff timers among them)
    // runs that late, so the CDP key events of a step all arrive before xterm has sent the text of the input method's key.
    const realSetTimeout = window.setTimeout.bind(window);
    window.slowTimers = 0;
    window.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, window.slowTimers && (Number(ms) || 0) < window.slowTimers ? window.slowTimers : ms, ...args);
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

const textarea = page => page.locator('.h5-xterm:not([hidden]) .xterm-helper-textarea');
const typed = page => page.evaluate(() => window.sockets.flatMap(socket => socket.sent).filter(item => !item.startsWith('{')));

// Runs `act` and asserts that exactly `want` went out (joined, so the split into chunks does not matter).
async function expectSent(page, want, act, what) {
  await page.evaluate(() => { for (const socket of window.sockets) socket.sent = socket.sent.filter(item => item.startsWith('{')); });
  await act();
  await page.waitForTimeout(SETTLE_MS);
  assert.equal(JSON.stringify((await typed(page)).join('')), JSON.stringify(want), what);
}

const key = (cdp, props) => cdp.send('Input.dispatchKeyEvent', props);
const imeKeyDown = cdp => key(cdp, { type: 'rawKeyDown', windowsVirtualKeyCode: 229, key: 'Process', code: 'Quote' });
const imeKeyUp = cdp => key(cdp, { type: 'keyUp', windowsVirtualKeyCode: 222, key: '"', code: 'Quote' });
async function arrowLeft(cdp) {
  await key(cdp, { type: 'rawKeyDown', windowsVirtualKeyCode: 37, key: 'ArrowLeft', code: 'ArrowLeft' });
  await key(cdp, { type: 'keyUp', windowsVirtualKeyCode: 37, key: 'ArrowLeft', code: 'ArrowLeft' });
}
// One press of " with WeType: the pair in one insertion, then a Left key (with or without the input method's 229 keydown before it).
async function wetype(cdp, pair, { with229 = true, reversed = false } = {}) {
  if (with229) await imeKeyDown(cdp);
  if (reversed) { await arrowLeft(cdp); await cdp.send('Input.insertText', { text: pair }); } else { await cdp.send('Input.insertText', { text: pair }); await arrowLeft(cdp); }
  if (with229) await imeKeyUp(cdp);
}
async function ime229(cdp, text) { // punctuation typed by an input method without a pair: keydown 229, then the text
  await imeKeyDown(cdp);
  await cdp.send('Input.insertText', { text });
  await imeKeyUp(cdp);
}

async function run(page, cdp, label) {
  await textarea(page).focus();
  // The user's sequence (macOS WeType, od -c): Chinese text, then " several times, then ！ and " again.
  await expectSent(page, LQ, () => wetype(cdp, QUOTES), `${label}: the first press gives the opening quote`);
  await expectSent(page, RQ, () => wetype(cdp, QUOTES), `${label}: the second press gives the closing quote`);
  await expectSent(page, LQ, () => wetype(cdp, QUOTES), `${label}: the third press opens again`);
  await expectSent(page, BANG, () => ime229(cdp, BANG), `${label}: punctuation between the presses, once`);
  await expectSent(page, RQ, () => wetype(cdp, QUOTES), `${label}: then the closing quote, no repeats`);
  await expectSent(page, `${LQ}${RQ}${LQ}`, async () => { for (let i = 0; i < 3; i += 1) await wetype(cdp, QUOTES); }, `${label}: three quick presses`);
  await expectSent(page, '\r', () => page.keyboard.press('Enter'), `${label}: Enter`);
  await expectSent(page, LQ, () => wetype(cdp, QUOTES, { with229: false }), `${label}: after Enter the next quote opens; also without the 229 keydown`);
  await expectSent(page, RQ, () => wetype(cdp, QUOTES, { with229: false }), `${label}: without 229, closing`);
  await expectSent(page, '\x03', () => page.keyboard.press('Control+C'), `${label}: Ctrl+C`);
  await expectSent(page, `${LQ}${RQ}`, async () => { await wetype(cdp, QUOTES, { reversed: true }); await wetype(cdp, QUOTES, { reversed: true }); }, `${label}: the reversed order (Left, then the pair)`);
  await expectSent(page, '\x15', () => page.keyboard.press('Control+U'), `${label}: Ctrl+U`);
  await expectSent(page, '\u3010\u3010', async () => { await wetype(cdp, '\u3010\u3011'); await wetype(cdp, '\u3010\u3011'); }, `${label}: a bracket pair gives the opening bracket only`);
  await expectSent(page, LQ, () => wetype(cdp, QUOTES), `${label}: brackets leave the quotes alone`);
  await expectSent(page, '\r', () => page.keyboard.press('Enter'), `${label}: Enter again`);

  // Unchanged behaviour.
  await expectSent(page, '\x1b[D', () => arrowLeft(cdp), `${label}: an ordinary Left key still sends ESC[D`);
  await expectSent(page, '\x1b[D\x1b[D', async () => { await arrowLeft(cdp); await arrowLeft(cdp); }, `${label}: two Left keys, two ESC[D`);
  await expectSent(page, QUOTES, () => cdp.send('Input.insertText', { text: QUOTES }), `${label}: the pair without a Left key is sent unchanged`);
  await expectSent(page, `${QUOTES}\x1b[D`, async () => { await cdp.send('Input.insertText', { text: QUOTES }); await page.waitForTimeout(250); await arrowLeft(cdp); }, `${label}: a Left key long after the pair is an ordinary Left`);
  await expectSent(page, '\u6D4B\u8BD5', async () => {
    await key(cdp, { type: 'rawKeyDown', windowsVirtualKeyCode: 229, key: 'Process', code: 'KeyC' });
    await cdp.send('Input.imeSetComposition', { text: 'ceshi', selectionStart: 5, selectionEnd: 5 });
    await key(cdp, { type: 'rawKeyDown', windowsVirtualKeyCode: 229, key: 'Process', code: 'Space' });
    await cdp.send('Input.insertText', { text: '\u6D4B\u8BD5' });
  }, `${label}: a pinyin composition sends its committed text`);
  await expectSent(page, '\u6D4B\x1b[D', async () => {
    await key(cdp, { type: 'rawKeyDown', windowsVirtualKeyCode: 229, key: 'Process', code: 'KeyC' });
    await cdp.send('Input.imeSetComposition', { text: 'ce', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.insertText', { text: '\u6D4B' });
    await arrowLeft(cdp);
  }, `${label}: a composition commit, then a Left key that stays ordinary`);
  // A busy page: xterm's 0 ms timers run 60 ms late. The text of the input method's key must still go out before a Left key pressed right after it.
  await page.evaluate(() => { window.slowTimers = 60; });
  const commit = async text => {
    await key(cdp, { type: 'rawKeyDown', windowsVirtualKeyCode: 229, key: 'Process', code: 'KeyC' });
    await cdp.send('Input.imeSetComposition', { text: 'ce', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.insertText', { text });
  };
  await expectSent(page, '\u6D4B\x1b[D', async () => { await commit('\u6D4B'); await arrowLeft(cdp); }, `${label}, busy: a composition commit goes out before the Left key`);
  await expectSent(page, '\u6D4B\u8BD5\x1b[D\x1b[D', async () => { await commit('\u6D4B\u8BD5'); await arrowLeft(cdp); await arrowLeft(cdp); }, `${label}, busy: two Left keys after a commit, in order`);
  await expectSent(page, `${BANG}\x1b[D`, async () => { await imeKeyDown(cdp); await cdp.send('Input.insertText', { text: BANG }); await arrowLeft(cdp); await imeKeyUp(cdp); }, `${label}, busy: 229 punctuation goes out before the Left key`);
  await expectSent(page, `${BANG}\x1b[Da`, async () => { await imeKeyDown(cdp); await cdp.send('Input.insertText', { text: BANG }); await arrowLeft(cdp); await imeKeyUp(cdp); await page.keyboard.press('a'); }, `${label}, busy: 229 punctuation, Left, then a letter: in that order`);
  await expectSent(page, '\r', () => page.keyboard.press('Enter'), `${label}, busy: Enter`);
  await expectSent(page, `${LQ}${RQ}`, async () => { await wetype(cdp, QUOTES); await wetype(cdp, QUOTES); }, `${label}, busy: the WeType pair still gives one quote per press`);
  await expectSent(page, `${LQ}${RQ}`, async () => { await wetype(cdp, QUOTES, { reversed: true }); await wetype(cdp, QUOTES, { reversed: true }); }, `${label}, busy: and in the reversed order`);
  await expectSent(page, '\x1b[D', () => arrowLeft(cdp), `${label}, busy: an ordinary Left key`);
  await page.evaluate(() => { window.slowTimers = 0; });
  await expectSent(page, '\r', () => page.keyboard.press('Enter'), `${label}: Enter after the busy part`);

  await expectSent(page, QUOTES, async () => {
    await page.evaluate(text => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      document.querySelector('.h5-xterm:not([hidden]) .xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, QUOTES);
  }, `${label}: a paste of the pair sends the pair`);
  await expectSent(page, 'a', () => page.keyboard.press('a'), `${label}: a letter once`);
  // The helper textarea's caret is at its end, so xterm's diff stays right.
  const caret = await textarea(page).evaluate(el => ({ start: el.selectionStart, end: el.selectionEnd, length: el.value.length }));
  assert.equal(caret.start, caret.length, `${label}: caret at the end of the textarea`);
  assert.equal(caret.end, caret.length, `${label}: no selection in the textarea`);
}

async function computer(browser) {
  const { context, page, cdp } = await openPage(browser, { viewport: { width: 1280, height: 800 } });
  await page.locator('.h5-task-item', { hasText: 'Alpha' }).click();
  await page.locator('#h5-tasks .h5-terminal-main', { hasText: 'Terminal 1' }).click();
  await page.waitForFunction(() => {
    const el = document.querySelector('.h5-xterm:not([hidden])');
    return el && el.querySelector('.xterm-rows') && window.sockets.some(socket => socket.readyState === 1 && socket.url.includes('terminalId=t1'));
  });
  await run(page, cdp, 'computer');
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await computer(browser);
    assert.deepEqual(pageErrors, []);
    console.log('ime pairs test passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
