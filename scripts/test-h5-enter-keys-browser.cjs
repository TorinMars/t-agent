// The Enter keys of the draft box (#h5-translate-input) in real Chromium, with real key presses and a real IME composition (CDP). On a computer: Enter translates and
// sends, Cmd/Ctrl+Enter and Shift+Enter make a new line at the caret and keep the caret visible, Enter that confirms an IME candidate does nothing, an empty box and a
// running translation make Enter do nothing. On a touch device the on-screen Return stays a new line (an open on-screen keyboard is a shorter viewport at the same width)
// and a hardware Enter sends. The server is mocked (no data folder is used).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const TRANSLATED = 'Translated text';
const pageErrors = [];
const translations = [];
let holdTranslation = null; // a promise: the mocked translator answers when it resolves

const TASKS = [{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }];
const TERMINALS = { 1: [{ terminal_id: 'h5-default', title: 'Terminal 1' }] };

async function openPage(browser, { viewport, touch }) {
  const context = await browser.newContext({ viewport, isMobile: touch, hasTouch: touch });
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
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    if (url.pathname === '/api/translate' && method === 'POST') {
      translations.push(route.request().postDataJSON().text);
      if (holdTranslation) await holdTranslation;
      return json({ text: TRANSLATED });
    }
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
  await page.locator('.h5-task-item', { hasText: 'Fix login' }).click();
  await page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main', { hasText: 'Terminal 1' }).click();
  await page.waitForFunction(() => window.sockets.length > 0 && window.sockets.at(-1).readyState === 1 && document.querySelector('.h5-xterm:not([hidden]) .xterm-rows'));
  await page.evaluate(() => {
    window.enterEvents = [];
    window.addEventListener('keydown', event => { if (event.key === 'Enter') window.enterEvents.push({ isComposing: event.isComposing, keyCode: event.keyCode, prevented: event.defaultPrevented }); });
  });
  return { context, page, input: page.locator('#h5-translate-input') };
}

const typedToTerminal = page => page.evaluate(() => window.sockets.at(-1).sent.filter(item => !item.startsWith('{')));
const waitForSends = (page, count) => page.waitForFunction(wanted => window.sockets.at(-1).sent.filter(item => !item.startsWith('{')).length >= wanted, count);
const caret = input => input.evaluate(el => [el.selectionStart, el.selectionEnd]);
const setCaret = (input, start, end = start) => input.evaluate((el, range) => el.setSelectionRange(range[0], range[1]), [start, end]);
const settle = page => page.waitForTimeout(250);
const hardwareSeen = page => page.evaluate(() => document.documentElement.dataset.keyboard === 'hardware');
// An open on-screen keyboard: the same width, a shorter viewport.
async function setHeight(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForFunction(wanted => Math.abs(window.visualViewport.height - wanted) < 2, height);
  await page.waitForTimeout(120);
}
async function noSend(page, sends, asked, what) {
  await settle(page);
  assert.equal(translations.length, asked, `${what}: no translate request`);
  assert.equal((await typedToTerminal(page)).length, sends, `${what}: nothing reaches the terminal`);
}

async function computer(browser) {
  const { context, page, input } = await openPage(browser, { viewport: { width: 1280, height: 800 }, touch: false });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.input), 'pointer');

  // Enter translates and sends, once, and adds no line.
  await input.click();
  await page.keyboard.type('please translate');
  await page.keyboard.press('Enter');
  await waitForSends(page, 2);
  assert.deepEqual(translations, ['please translate'], 'Enter makes one translate request');
  assert.deepEqual(await typedToTerminal(page), [TRANSLATED, '\r'], 'Enter sends the translation, then Enter');
  assert.equal(await input.inputValue(), '', 'the box is emptied');

  // Cmd+Enter and Ctrl+Enter: a new line at the caret, replacing a selection; nothing is sent.
  for (const combo of ['Meta+Enter', 'Control+Enter']) {
    const sends = (await typedToTerminal(page)).length;
    const asked = translations.length;
    await input.click();
    await input.fill('abcd');
    await setCaret(input, 2);
    await page.keyboard.press(combo);
    assert.equal(await input.inputValue(), 'ab\ncd', `${combo} inserts a new line at the caret`);
    assert.deepEqual(await caret(input), [3, 3], `${combo} leaves the caret after the new line`);
    await input.fill('abcd');
    await setCaret(input, 1, 3);
    await page.keyboard.press(combo);
    assert.equal(await input.inputValue(), 'a\nd', `${combo} replaces the selection`);
    assert.deepEqual(await caret(input), [2, 2]);
    await noSend(page, sends, asked, combo);
    await input.fill('');
  }

  // Undo works, because the new line went in as typing.
  await input.fill('');
  await page.keyboard.type('xy');
  await setCaret(input, 1);
  await page.keyboard.press('Meta+Enter');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  assert.equal(await input.inputValue(), 'xy', 'undo takes the new line out');
  await input.fill('');

  // Shift+Enter is a new line. Option+Enter still sends as typed, with no translation.
  {
    await input.click();
    await page.keyboard.type('one');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('two');
    assert.equal(await input.inputValue(), 'one\ntwo', 'Shift+Enter is a new line');
    await input.fill('as typed');
    const sends = (await typedToTerminal(page)).length;
    const asked = translations.length;
    await page.keyboard.press('Alt+Enter');
    await waitForSends(page, sends + 2);
    assert.equal(translations.length, asked, 'Alt+Enter makes no translate request');
    assert.deepEqual((await typedToTerminal(page)).slice(sends), ['as typed', '\r']);
  }

  // The box grows with a new line, and the caret stays visible once the box is at its cap and scrolls.
  {
    await input.click();
    await input.fill('one');
    const before = await input.evaluate(el => el.getBoundingClientRect().height);
    await page.keyboard.press('Meta+Enter');
    await settle(page);
    const after = await input.evaluate(el => el.getBoundingClientRect().height);
    assert.ok(after > before + 10, `the box grows (${before} to ${after})`);
    const many = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
    await input.fill(many);
    await settle(page);
    const visible = () => input.evaluate(el => {
      const style = getComputedStyle(el);
      const lineHeight = parseFloat(style.lineHeight);
      const paddingTop = parseFloat(style.paddingTop);
      const line = el.value.slice(0, el.selectionStart).split('\n').length - 1;
      const top = paddingTop + line * lineHeight;
      return { capped: el.scrollHeight > el.clientHeight + 1, top, bottom: top + lineHeight, viewTop: el.scrollTop, viewBottom: el.scrollTop + el.clientHeight };
    });
    await setCaret(input, many.length);
    await page.keyboard.press('Meta+Enter');
    await settle(page);
    let view = await visible();
    assert.ok(view.bottom <= view.viewBottom + 2 && view.top >= view.viewTop - 2, `the caret at the end stays visible (${JSON.stringify(view)})`);
    await input.evaluate(el => { el.scrollTop = 0; });
    await setCaret(input, await input.evaluate(el => el.value.length));
    await page.keyboard.press('Shift+Enter');
    await settle(page);
    view = await visible();
    assert.ok(view.bottom <= view.viewBottom + 2 && view.top >= view.viewTop - 2, `Shift+Enter keeps the caret visible (${JSON.stringify(view)})`);
    assert.ok(view.capped, 'the box is at its cap and scrolls');
    assert.ok(view.bottom <= view.viewBottom + 2 && view.top >= view.viewTop - 2, `the caret at the end stays visible (${JSON.stringify(view)})`);
    const middle = many.indexOf('line 20') + 2;
    await input.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await setCaret(input, middle);
    await page.keyboard.press('Control+Enter');
    await settle(page);
    view = await visible();
    assert.ok(view.bottom <= view.viewBottom + 2 && view.top >= view.viewTop - 2, `the caret in the middle stays visible (${JSON.stringify(view)})`);
    await input.fill('');
  }

  // Empty and spaces-only: Enter neither sends nor adds a line, like the send button.
  for (const text of ['', '   ', ' \n ']) {
    const sends = (await typedToTerminal(page)).length;
    const asked = translations.length;
    await input.click();
    await input.fill(text);
    await page.keyboard.press('Enter');
    await noSend(page, sends, asked, `Enter in a box holding ${JSON.stringify(text)}`);
    assert.equal(await input.inputValue(), text, 'the box is unchanged');
  }
  await input.fill('');

  // A running translation: more Enter presses send nothing more and add no line, and text typed meanwhile stays.
  {
    const sends = (await typedToTerminal(page)).length;
    const asked = translations.length;
    let release;
    holdTranslation = new Promise(resolve => { release = resolve; });
    await input.click();
    await page.keyboard.type('slow one');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('h5-translate-send').disabled === true);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type(' more');
    await page.keyboard.press('Enter');
    await settle(page);
    assert.equal(translations.length, asked + 1, 'Enter during a translation makes no second request');
    assert.equal(await input.inputValue(), 'slow one more', 'and adds no line');
    assert.equal((await typedToTerminal(page)).length, sends, 'nothing is sent before the translation is back');
    release();
    holdTranslation = null;
    await waitForSends(page, sends + 2);
    await settle(page);
    assert.deepEqual((await typedToTerminal(page)).slice(sends), [TRANSLATED, '\r'], 'one send only');
    assert.equal(await input.inputValue(), ' more', 'the text typed meanwhile stays');
    await input.fill('');
  }

  // A held Enter sends once.
  {
    const sends = (await typedToTerminal(page)).length;
    const asked = translations.length;
    let release;
    holdTranslation = new Promise(resolve => { release = resolve; });
    await input.click();
    await page.keyboard.type('held');
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter'); // a second down without an up: autorepeat
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await settle(page);
    assert.equal(translations.length, asked + 1, 'a held Enter makes one request');
    release();
    holdTranslation = null;
    await waitForSends(page, sends + 2);
    await settle(page);
    assert.equal((await typedToTerminal(page)).length, sends + 2, 'a held Enter sends once');
    await input.fill('');
  }

  // IME composition, with a real composition in the box.
  {
    const cdp = await context.newCDPSession(page);
    const rawEnter = async (keyCode, modifiers = 0) => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
    };
    const sends = (await typedToTerminal(page)).length;
    const asked = translations.length;
    await input.click();
    await input.fill('');
    await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
    assert.equal(await input.inputValue(), 'ni', 'the composition is in the box');
    await page.evaluate(() => { window.enterEvents.length = 0; });
    await rawEnter(229); // Chromium: isComposing and keyCode 229
    await rawEnter(13); // isComposing with a normal key code
    await rawEnter(229, 4); // with Cmd held
    await rawEnter(229, 2); // with Ctrl held
    const composing = await page.evaluate(() => window.enterEvents.slice());
    assert.equal(composing.length, 4, 'all four key presses reached the page');
    assert.ok(composing.every(event => event.isComposing), `the page saw a real composition (${JSON.stringify(composing)})`);
    assert.ok(composing.every(event => !event.prevented), 'the composing Enter is left to the IME');
    assert.equal(await input.inputValue(), 'ni', 'a composing Enter adds no new line');
    await noSend(page, sends, asked, 'a composing Enter');

    // The candidate is confirmed. Safari ends the composition before the keydown: isComposing is false and only keyCode 229 tells.
    await cdp.send('Input.insertText', { text: '\u4f60\u597d' });
    assert.equal(await input.inputValue(), '\u4f60\u597d', 'the Chinese text is committed');
    await page.evaluate(() => { window.enterEvents.length = 0; });
    await rawEnter(229);
    const committed = await page.evaluate(() => window.enterEvents.slice());
    assert.deepEqual(committed, [{ isComposing: false, keyCode: 229, prevented: false }], 'the keydown after the composition ended');
    assert.equal(await input.inputValue(), '\u4f60\u597d', 'keyCode 229 adds no new line');
    await noSend(page, sends, asked, 'an Enter with keyCode 229 after the composition');

    // The next, ordinary Enter sends the Chinese text.
    await page.keyboard.press('Enter');
    await waitForSends(page, sends + 2);
    assert.equal(translations.at(-1), '\u4f60\u597d', 'the next Enter translates the Chinese text');
    assert.deepEqual((await typedToTerminal(page)).slice(sends), [TRANSLATED, '\r']);
  }
  await context.close();
}

async function touchDevice(browser) {
  const width = 390;
  const height = 844;
  const { context, page, input } = await openPage(browser, { viewport: { width, height }, touch: true });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.input), 'touch');

  // The on-screen keyboard is open: Return is a new line, nothing is sent, and it does not count as a hardware keyboard.
  {
    const sends = (await typedToTerminal(page)).length;
    const asked = translations.length;
    await input.focus();
    await setHeight(page, width, height - 320);
    await page.keyboard.type('phone');
    await page.keyboard.press('Enter');
    await page.keyboard.type('line');
    assert.equal(await input.inputValue(), 'phone\nline', 'the on-screen Return is a new line');
    await noSend(page, sends, asked, 'the on-screen Return');
    assert.equal(await hardwareSeen(page), false, 'on-screen keys are not a hardware keyboard');
    await input.fill('');
    await setHeight(page, width, height);
  }

  // A hardware keyboard on the touch device (no on-screen keyboard, so the viewport is at full height): the first key is seen as hardware and Enter sends.
  {
    const sends = (await typedToTerminal(page)).length;
    const asked = translations.length;
    await input.focus();
    await input.fill('from bluetooth');
    assert.equal(await hardwareSeen(page), false, 'no key was pressed yet');
    await page.keyboard.press('Enter');
    await waitForSends(page, sends + 2);
    assert.equal(await hardwareSeen(page), true, 'the very first key press counts');
    assert.equal(translations.length, asked + 1);
    assert.deepEqual((await typedToTerminal(page)).slice(sends), [TRANSLATED, '\r'], 'a hardware Enter sends on a touch device');
    assert.equal(await input.inputValue(), '');
  }

  // Cmd+Enter is a new line on a touch device as well.
  {
    await input.focus();
    await input.fill('ab');
    await setCaret(input, 1);
    await page.keyboard.press('Meta+Enter');
    assert.equal(await input.inputValue(), 'a\nb');
    assert.deepEqual(await caret(input), [2, 2]);
    await input.fill('');
  }

  // A hardware keyboard was seen earlier and is gone now: an open on-screen keyboard keeps its Return as a new line.
  {
    const sends = (await typedToTerminal(page)).length;
    const asked = translations.length;
    await input.focus();
    await setHeight(page, width, height - 320);
    await page.keyboard.type('later');
    await page.keyboard.press('Enter');
    assert.equal(await input.inputValue(), 'later\n', 'the on-screen Return stays a new line after a hardware keyboard was seen');
    await noSend(page, sends, asked, 'the on-screen Return after a hardware keyboard was seen');
    await input.fill('');
    await setHeight(page, width, height);
  }
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await computer(browser);
    await touchDevice(browser);
    assert.deepEqual(pageErrors, [], 'no page errors');
    console.log('h5 draft box Enter keys: all checks passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
