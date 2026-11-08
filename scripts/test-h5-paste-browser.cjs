// The page's Paste action ("Paste text" in the saved commands list) in real Chromium, touch mode, at 390 x 844 and 320 x 568, with a stubbed
// navigator.clipboard. WebKit (every iOS browser) allows one clipboard read per tap and only inside the tap, so the page must make exactly ONE read,
// started synchronously in the click handler: read() with text pastes once and never calls readText; read() with an image uploads it; a refused read
// opens the Paste sheet, where a paste event sends its text to the terminal (once), an image goes to the upload, Send sends typed text and Cancel
// closes it and gives the focus back. A native paste of text into the terminal's own textarea is pasted once (by xterm).
// The server is mocked (no data folder is used). H5_SHOT_DIR=<dir> saves 3x screenshots of the sheet there.
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
  const counts = { ossConfig: 0 };
  // http://h5.test is not a secure context; the init script marks it secure, as the real HTTPS page is.
  const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: process.env.H5_SHOT_DIR ? 3 : 1 });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'isSecureContext', { value: true });
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    // The clipboard stub. `inClick` is true only while a click is being dispatched (set in the capture phase of window, cleared in its bubble
    // phase, after React's root listener): a read made after an await or a timer would see false.
    window.inClick = false;
    window.addEventListener('click', () => { window.inClick = true; }, true);
    window.addEventListener('click', () => { window.inClick = false; });
    window.clip = { mode: 'text', text: '', calls: [] };
    const item = parts => ({ types: Object.keys(parts), getType: async type => new Blob([parts[type]], { type }) });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      read() {
        window.clip.calls.push({ name: 'read', inClick: window.inClick });
        if (window.clip.mode === 'deny') return Promise.reject(new DOMException('The request is not allowed', 'NotAllowedError'));
        if (window.clip.mode === 'image') return Promise.resolve([item({ 'image/png': new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]) })]);
        return Promise.resolve([item({ 'text/plain': window.clip.text })]);
      },
      readText() { window.clip.calls.push({ name: 'readText', inClick: window.inClick }); return Promise.resolve(window.clip.text); },
      writeText: async () => {},
    } });
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
    if (url.pathname === '/api/oss/config') { counts.ossConfig += 1; return json({ enabled: false }); }
    if (url.pathname === '/api/system/check-update' || url.pathname === '/api/system/update-status') return json({ status: 'up_to_date', local_version: '1.0.0' });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  await page.locator('#h5-tasks').waitFor({ state: 'visible' });
  await page.locator('.h5-task-item', { hasText: 'Fix login' }).tap();
  await page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main', { hasText: 'Terminal 1' }).tap();
  await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => window.sockets.length > 0 && window.sockets.at(-1).readyState === 1 && document.querySelector('.h5-xterm:not([hidden]) .xterm-rows'));
  return { context, page, counts };
}

const typed = page => page.evaluate(() => window.sockets.at(-1).sent.filter(item => !item.startsWith('{')));
const pasted = (page, text) => typed(page).then(list => list.filter(item => item.includes(text)).length);
const focusTerminal = page => page.evaluate(() => document.querySelector('.h5-xterm:not([hidden]) textarea').focus());
const terminalFocused = page => page.evaluate(() => document.activeElement === document.querySelector('.h5-xterm:not([hidden]) textarea'));
async function tapPaste(page) {
  await page.locator('#h5-commands').tap();
  await page.locator('.h5-add-menu [role="menuitem"]', { hasText: 'Paste text' }).tap();
  await page.locator('.h5-add-menu').waitFor({ state: 'detached' });
}
// A paste event like the system's (iOS long-press, Paste) on an element, with text or with one file.
const pasteEvent = (page, selector, { text, file }) => page.evaluate(({ selector, text, file }) => {
  const data = new DataTransfer();
  if (text) data.setData('text/plain', text);
  if (file) data.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])], file, { type: 'image/png' }));
  const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
  document.querySelector(selector).dispatchEvent(event);
  return event.defaultPrevented;
}, { selector, text, file });

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
      const { context, page, counts } = await openPage(browser, viewport);
      const label = `${viewport.width}px`;
      assert.equal(await page.evaluate(() => document.documentElement.dataset.input), 'touch', 'a phone is in touch mode');

      // read() returns text: pasted once, read once inside the click, readText never called, no sheet.
      await page.evaluate(() => { window.clip.mode = 'text'; window.clip.text = 'echo paste-one'; window.clip.calls = []; });
      await tapPaste(page);
      await page.waitForFunction(() => window.sockets.at(-1).sent.some(item => item.includes('echo paste-one')));
      await page.waitForTimeout(100);
      assert.equal(await pasted(page, 'echo paste-one'), 1, `${label}: the text is pasted once`);
      assert.deepEqual(await page.evaluate(() => window.clip.calls), [{ name: 'read', inClick: true }], `${label}: one read(), started synchronously inside the click; no readText()`);
      assert.equal(await page.locator('#h5-paste').count(), 0, `${label}: no sheet when the read worked`);

      // read() returns an image: it goes to the upload (the mocked OSS is off, so the upload stops at its settings).
      await page.evaluate(() => { window.clip.mode = 'image'; window.clip.calls = []; });
      const before = counts.ossConfig;
      await tapPaste(page);
      await page.waitForFunction(() => document.body.textContent.includes('Enable Alibaba Cloud OSS'));
      assert.equal(counts.ossConfig, before + 1, `${label}: the clipboard image goes through the upload path`);
      assert.deepEqual(await page.evaluate(() => window.clip.calls.map(call => call.name)), ['read'], `${label}: one read for the image`);

      // read() is refused (iOS: denied, or the Paste callout dismissed): the sheet opens; readText is not tried.
      await page.evaluate(() => { window.clip.mode = 'deny'; window.clip.text = 'never read'; window.clip.calls = []; });
      await focusTerminal(page);
      await tapPaste(page);
      await page.locator('#h5-paste-text').waitFor();
      assert.deepEqual(await page.evaluate(() => window.clip.calls), [{ name: 'read', inClick: true }], `${label}: a refused read() is not followed by readText()`);
      assert.equal(await page.locator('#h5-paste-text').getAttribute('placeholder'), 'Long-press here and choose Paste');
      const fit = await page.evaluate(() => {
        const paper = document.querySelector('#h5-paste .MuiDialog-paper').getBoundingClientRect();
        return { left: paper.left, right: paper.right, top: paper.top, pageWide: document.documentElement.scrollWidth, focused: document.activeElement && document.activeElement.id };
      });
      assert.ok(fit.left >= 15 && fit.right <= viewport.width - 15 && fit.pageWide <= viewport.width, `${label}: the sheet fits with a 16px gutter (${fit.left}-${fit.right})`);
      assert.ok(fit.top <= 40, `${label}: the sheet sits at the top, above the on-screen keyboard (${fit.top})`);
      assert.equal(fit.focused, 'h5-paste-text', `${label}: the box has the focus`);
      if (process.env.H5_SHOT_DIR) await page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, `paste-sheet-${viewport.width}.png`) });
      // A paste event of text into the empty box: sent to the terminal once, the sheet closes and the terminal gets its focus back.
      assert.equal(await pasteEvent(page, '#h5-paste-text', { text: 'echo from-sheet' }), true, 'the sheet takes the paste');
      await page.locator('#h5-paste').waitFor({ state: 'detached' });
      await page.waitForTimeout(100);
      assert.equal(await pasted(page, 'echo from-sheet'), 1, `${label}: the sheet's paste reaches the terminal once`);
      assert.equal(await terminalFocused(page), true, `${label}: the terminal gets the focus back`);

      // A pasted image in the sheet goes to the upload.
      await focusTerminal(page);
      await tapPaste(page);
      await page.locator('#h5-paste-text').waitFor();
      const beforeImage = counts.ossConfig;
      await pasteEvent(page, '#h5-paste-text', { file: 'shot.png' });
      await page.locator('#h5-paste').waitFor({ state: 'detached' });
      await page.waitForTimeout(150);
      assert.equal(counts.ossConfig, beforeImage + 1, `${label}: an image pasted into the sheet goes through the upload path`);

      // Typed text waits for Send; Cancel sends nothing.
      await tapPaste(page);
      await page.locator('#h5-paste-text').fill('git status');
      assert.equal(await pasted(page, 'git status'), 0, 'typing alone sends nothing');
      await page.locator('#h5-paste-send').tap();
      await page.locator('#h5-paste').waitFor({ state: 'detached' });
      await page.waitForTimeout(100);
      assert.equal(await pasted(page, 'git status'), 1, `${label}: Send sends the box once`);
      await focusTerminal(page);
      await tapPaste(page);
      await page.locator('#h5-paste-text').fill('rm nothing');
      await page.locator('#h5-paste-cancel').tap();
      await page.locator('#h5-paste').waitFor({ state: 'detached' });
      await page.waitForTimeout(100);
      assert.equal(await pasted(page, 'rm nothing'), 0, `${label}: Cancel sends nothing`);
      assert.equal(await terminalFocused(page), true, `${label}: Cancel gives the focus back to the terminal`);

      // No clipboard API at all (an old browser): the sheet opens too.
      await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); });
      await tapPaste(page);
      await page.locator('#h5-paste-text').waitFor();
      await page.locator('#h5-paste-cancel').tap();
      await page.locator('#h5-paste').waitFor({ state: 'detached' });

      // The system's paste into the terminal's own textarea (iOS long-press on the terminal, Paste): xterm pastes it, once.
      await focusTerminal(page);
      await pasteEvent(page, '.h5-xterm:not([hidden]) textarea', { text: 'echo native-paste' });
      await page.waitForTimeout(150);
      assert.equal(await pasted(page, 'echo native-paste'), 1, `${label}: a native paste in the terminal is pasted once`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log('h5 paste: ok (one read per tap, the Paste sheet, 390 and 320px)');
})().catch(error => { console.error(error); process.exit(1); });
