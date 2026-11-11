// Copy on select on the real page in Chromium, in touch mode (a phone, 390 px) and pointer mode (a computer, 1440 px). One rule for every copy
// from the terminal (public/js/terminal-clipboard.js), so a page selection and a program's OSC 52 copy cannot be told apart:
// - a double / triple tap (touch) or a finished mouse drag (pointer) copies at once with "Copied N characters", no bar; Cmd+C gives no second notice;
// - a program's copy right after the user's own tap or click is written at once with the identical notice (split request, duplicate merged);
// - a program's copy without a gesture shows the bar with a one-line preview; Copy writes, Cancel does not, it expires after 60 s, later output
//   cannot replace it;
// - a write the browser refuses shows the same bar ("Press Copy to finish copying", same DOM) for both sources, and its Copy writes; when that
//   fails too, one error notice; the same text from the page and the program within 2 s is one copy; replayed history never copies;
// - the bar's look: a filled blue bar (the theme's `notice` blue, white text at WCAG AA), the copy icon, a title line over the preview, a white
//   filled Copy and a text Cancel, inside the terminal box under the header; it slides in and pulses once, and not at all with reduced motion;
//   at 320 px with a long text and the on-screen keyboard open it still fits, with 44 px buttons.
// The page is served over https (routed), so the real clipboard API is used with granted permissions. H5_SHOT_DIR=<dir> saves screenshots of the bar.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'https://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const osc = text => `\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`;

// WCAG relative luminance and contrast of two `rgb(...)` colours (getComputedStyle form).
const rgb = text => (text.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
const luminance = colour => { const [r, g, b] = rgb(colour).map(v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const SHOTS = process.env.H5_SHOT_DIR;
// Waits until the bar's slide-in and pulse (on the bar and its ::after) have finished, so boxes are measured at rest.
const settled = page => page.evaluate(() => Promise.all((document.querySelector('#h5-clipboard-bar')?.getAnimations({ subtree: true }) || []).map(animation => animation.finished)));

async function openPage(browser, touch, size) {
  const viewport = size || (touch ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...(SHOTS ? { deviceScaleFactor: touch ? 3 : 2 } : {}) });
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
  await page.clock.install(); // time runs normally; the expiry test fast-forwards it
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
  // Every notice the page shows, with its type (toast.js `notify`, looked up at call time by h5.js and terminal-clipboard.js).
  await page.evaluate(() => {
    window.notices = [];
    const real = window.notify;
    window.notify = (message, type) => { window.notices.push([message, type]); return real(message, type); };
  });
  return { page, context, errors };
}

async function run(browser, touch) {
  const mode = touch ? 'touch' : 'pointer';
  const { page, context, errors } = await openPage(browser, touch);
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const setClipboard = text => page.evaluate(value => navigator.clipboard.writeText(value), text);
  const emit = data => page.evaluate(value => window.sockets[0].emit(value), data);
  const bar = page.locator('#h5-clipboard-bar');
  const press = locator => locator[touch ? 'tap' : 'click']();
  const notices = () => page.evaluate(() => window.notices.splice(0));
  const waitNotice = message => page.waitForFunction(text => window.notices.some(([m]) => m === text), message, { timeout: 5000 })
    .catch(async error => { throw new Error(`${mode}: no notice "${message}"; seen ${JSON.stringify(await page.evaluate(() => window.notices))}, clipboard ${JSON.stringify(await clipboard())}`, { cause: error }); });
  // The look of the bar without its text: tag, classes, ids and button labels, so the two sources can be compared.
  const barShape = () => page.evaluate(() => {
    const node = document.querySelector('#h5-clipboard-bar');
    const parts = [...node.querySelectorAll('*')].filter(child => child.id || child.tagName === 'BUTTON' || /^h5-clipboard-/.test(child.className))
      .map(child => `${child.tagName}#${child.id}.${child.className}${child.tagName === 'BUTTON' || child.id === 'h5-clipboard-title' ? `:${child.textContent}` : ''}`);
    return { className: node.className, kind: node.dataset.kind, label: node.getAttribute('aria-label'), parts };
  });
  // The look of the notice that is shown (MUI Alert severity and classes).
  const noticeShape = () => page.evaluate(() => [...document.querySelectorAll('.MuiSnackbar-root .MuiAlert-root')].pop()?.className.replace(/css-\S+/g, '').trim());
  // A gesture on the terminal: a finger tap in touch mode, a mouse click in pointer mode (on an empty row, away from the text).
  const gesture = async () => {
    const box = await page.locator('.h5-xterm:not([hidden]) .xterm-screen').boundingBox();
    if (touch) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height - 20);
    else await page.mouse.click(box.x + box.width / 2, box.y + box.height - 20);
  };
  // Where the text `word` is on the row that contains `rowStart` (a range over its characters).
  const where = (rowStart, word) => page.evaluate(([start, text]) => {
    const plain = node => node.textContent.replace(/\u00a0/g, ' ');
    const row = [...document.querySelectorAll('.h5-xterm:not([hidden]) .xterm-rows > div')].find(item => plain(item).includes(start));
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let offset = plain(row).indexOf(text);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (offset < node.length) {
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, Math.min(node.length, offset + text.length));
        const box = range.getBoundingClientRect();
        return { x: box.left, y: box.top + box.height / 2, right: box.right };
      }
      offset -= node.length;
    }
    return null;
  }, [rowStart, word]);
  // The page's own selection: a double (word) or triple (line) tap with a finger; a mouse drag over the text.
  const select = async (rowStart, word, count = 2) => {
    const point = await where(rowStart, word);
    if (touch) {
      await page.waitForTimeout(450); // the previous multi-tap is over
      for (let i = 0; i < count; i++) await page.touchscreen.tap(point.x + 3, point.y);
    } else {
      await page.mouse.move(point.x + 1, point.y);
      await page.mouse.down();
      await page.mouse.move(point.right + 1, point.y, { steps: 6 });
      await page.mouse.up();
    }
  };
  // The text to select sits lower on the screen, away from the notice at the top.
  await emit('\r\n'.repeat(6) + 'pick a word from the shell\r\n$ ');
  await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-rows')?.textContent.includes('pick'));
  // Wait out the gesture window (1500 ms) of the taps that opened the terminal.
  await page.waitForTimeout(1600);
  await notices();

  // 1. Page selection copies at once, with the notice and no bar.
  await setClipboard('before');
  await select('pick a word', 'word');
  await waitNotice('Copied 4 characters');
  assert.equal(await clipboard(), 'word', `${mode}: the selection is copied on select`);
  assert.equal(await bar.count(), 0, `${mode}: no bar after a successful copy`);
  const pageNotice = await notices();
  const pageNoticeShape = await noticeShape();
  assert.deepEqual(pageNotice, [['Copied 4 characters', 'success']]);
  if (touch) {
    await select('pick a word', 'word', 3); // a triple tap copies the whole line
    await waitNotice('Copied 26 characters');
    assert.equal((await clipboard()).trim(), 'pick a word from the shell', `${mode}: triple tap copies the line`);
  } else {
    // Cmd+C on the selection just copied: no second notice.
    await page.keyboard.press('Meta+c');
    await page.waitForTimeout(300);
    assert.deepEqual(await notices(), [], `${mode}: Cmd+C on the same text gives no second notice`);
    // A plain click copies nothing (it clears the selection).
    await setClipboard('kept');
    await gesture();
    await page.waitForTimeout(300);
    assert.equal(await clipboard(), 'kept', `${mode}: a plain click copies nothing`);
    await page.waitForTimeout(2100); // the merge window is over
    // A double click copies the word, Cmd+C on a fresh selection still copies.
    const point = await where('pick a word', 'pick');
    await page.mouse.dblclick(point.x + 3, point.y);
    await waitNotice('Copied 4 characters');
    assert.equal(await clipboard(), 'pick', `${mode}: a double click copies the word`);
  }
  await notices();
  await page.waitForTimeout(1600); // the gesture of the selection is over

  // 2. A program's copy without a gesture: the bar with a one-line preview; nothing is written before Copy; later output cannot replace it.
  await setClipboard('before');
  await emit(osc('Remote program\nhello ✓ 中文'));
  await bar.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#h5-clipboard-text').textContent(), 'Remote program hello ✓ 中文', `${mode}: one-line preview`);
  assert.equal(await page.locator('#h5-clipboard-copy').textContent(), 'Copy');
  assert.equal(await page.locator('#h5-clipboard-cancel').textContent(), 'Cancel');
  assert.equal(await page.locator('#h5-clipboard').count(), 0, `${mode}: no dialog any more`);
  await settled(page);
  // The look: a filled blue bar with white text, the copy icon and the title line, a white filled Copy, a text Cancel; it slides in and pulses once.
  const look = await page.evaluate(() => {
    const bar = document.querySelector('#h5-clipboard-bar');
    const style = getComputedStyle(bar);
    const after = getComputedStyle(bar, '::after');
    const copy = getComputedStyle(document.querySelector('#h5-clipboard-copy'));
    const cancel = getComputedStyle(document.querySelector('#h5-clipboard-cancel'));
    const title = document.querySelector('#h5-clipboard-title');
    const text = document.querySelector('#h5-clipboard-text');
    const icon = bar.querySelector('.h5-clipboard-icon svg path');
    const header = document.querySelector('.h5-header').getBoundingClientRect();
    const terminal = document.querySelector('#h5-terminal').getBoundingClientRect();
    const box = bar.getBoundingClientRect();
    return {
      background: style.backgroundColor, colour: style.color, image: style.backgroundImage,
      animation: style.animationName, animationCount: style.animationIterationCount, pulse: after.animationName, pulseCount: after.animationIterationCount,
      copyBackground: copy.backgroundColor, copyColour: copy.color, cancelBackground: cancel.backgroundColor, cancelColour: cancel.color,
      titleText: title.textContent, titleColour: getComputedStyle(title).color, titleSize: parseFloat(getComputedStyle(title).fontSize), previewTitle: text.getAttribute('title'),
      textColour: getComputedStyle(text).color, iconPath: icon ? icon.getAttribute('d').slice(0, 20) : null, iconHidden: bar.querySelector('.h5-clipboard-icon').getAttribute('aria-hidden'),
      inside: box.left >= terminal.left && box.right <= terminal.right && box.top >= terminal.top, belowHeader: box.top >= header.bottom,
    };
  });
  assert.equal(look.background, 'rgb(21, 101, 192)', `${mode}: the bar is filled with the notice blue`);
  assert.equal(look.image, 'none', `${mode}: no dark elevation overlay greys the blue`);
  assert.equal(look.colour, 'rgb(255, 255, 255)');
  for (const [name, colour] of [['text', look.colour], ['title', look.titleColour], ['preview', look.textColour], ['Cancel', look.cancelColour]]) {
    assert.ok(contrast(colour, look.background) >= 4.5, `${mode}: ${name} on the blue is WCAG AA (${contrast(colour, look.background).toFixed(2)})`);
  }
  assert.equal(look.copyBackground, 'rgb(255, 255, 255)', `${mode}: Copy is a white filled button`);
  assert.ok(contrast(look.copyColour, look.copyBackground) >= 4.5, `${mode}: Copy's text is readable (${contrast(look.copyColour, look.copyBackground).toFixed(2)})`);
  assert.equal(look.cancelBackground, 'rgba(0, 0, 0, 0)', `${mode}: Cancel is a text button`);
  assert.equal(look.titleText, 'Copy request from the terminal');
  assert.ok(look.titleSize < 13.5, `${mode}: the title is a small line`);
  assert.equal(look.previewTitle, 'Remote program\nhello ✓ 中文', `${mode}: the full text is the preview's title`);
  assert.equal(look.iconPath, 'M832 64H296c-4.4 0-8', `${mode}: the file-copy icon of the library`);
  assert.equal(look.iconHidden, 'true');
  assert.ok(look.inside && look.belowHeader, `${mode}: the bar sits inside the terminal, under the header`);
  assert.deepEqual([look.animation, look.animationCount, look.pulse, look.pulseCount], ['h5-clipboard-in', '1', 'h5-clipboard-pulse', '1'], `${mode}: one slide-in and one pulse`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `copy-bar-${touch ? 390 : 1440}.png`) });
  await emit(osc('evil'));
  assert.equal(await page.locator('#h5-clipboard-text').textContent(), 'Remote program hello ✓ 中文');
  assert.equal(await clipboard(), 'before', `${mode}: nothing written before Copy`);
  const box = await bar.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box.x >= 0 && box.x + box.width <= viewport.width, `${mode}: the bar fits the width`);
  await press(page.locator('#h5-clipboard-copy'));
  await bar.waitFor({ state: 'hidden' });
  assert.equal(await clipboard(), 'Remote program\nhello ✓ 中文', `${mode}: Copy writes the full text`);
  await waitNotice('Copied 25 characters');
  await notices();
  // Cancel writes nothing.
  await emit(osc('cancelled text'));
  await bar.waitFor({ state: 'visible' });
  await press(page.locator('#h5-clipboard-cancel'));
  await bar.waitFor({ state: 'hidden' });
  assert.equal(await clipboard(), 'Remote program\nhello ✓ 中文', `${mode}: Cancel copies nothing`);
  // A waiting request expires after 60 s.
  await emit(osc('expires'));
  await bar.waitFor({ state: 'visible' });
  await page.clock.fastForward('01:01');
  await bar.waitFor({ state: 'hidden' });
  assert.equal(await clipboard(), 'Remote program\nhello ✓ 中文', `${mode}: an expired request copies nothing`);
  await page.waitForTimeout(1600);

  // 3. Right after a gesture (Claude Code copies a selection on release): written at once with the identical notice, even split over two writes.
  await gesture();
  const payload = Buffer.from('selected in Claude Code').toString('base64');
  await emit(`\x1b]52;c;${payload.slice(0, 6)}`);
  await page.waitForTimeout(150);
  await emit(`${payload.slice(6)}\x07`);
  await waitNotice('Copied 23 characters');
  assert.equal(await clipboard(), 'selected in Claude Code', `${mode}: user-initiated copy is written at once`);
  assert.equal(await bar.count(), 0, `${mode}: no bar for a user-initiated copy`);
  const programNotice = await notices();
  assert.deepEqual(programNotice.map(([, type]) => type), pageNotice.map(([, type]) => type), `${mode}: same notice type for both sources`);
  assert.equal(await noticeShape(), pageNoticeShape, `${mode}: the notice looks the same for both sources`);
  // The same text again at once (a pbcopy shim plus the program's own OSC 52) is merged: no second write, no bar.
  await setClipboard('marker');
  await emit(osc('selected in Claude Code'));
  await page.waitForTimeout(300);
  assert.equal(await bar.count(), 0, `${mode}: a duplicate shows no bar`);
  assert.equal(await clipboard(), 'marker', `${mode}: a duplicate is not written again`);
  await page.waitForTimeout(1600);

  // 4. Duplicate merge across sources: the page copies a selection, the program sends the same text: one write, one notice.
  await select('pick a word', 'shell');
  await waitNotice('Copied 5 characters');
  await setClipboard('marker');
  await emit(osc('shell'));
  await page.waitForTimeout(300);
  assert.equal(await clipboard(), 'marker', `${mode}: the program's copy of the page selection is merged`);
  assert.deepEqual(await notices(), [['Copied 5 characters', 'success']], `${mode}: one notice for both sources`);
  assert.equal(await bar.count(), 0);
  await page.waitForTimeout(2100);

  // 5. The browser refuses the write: the same bar ("Press Copy to finish copying") for a page selection and for a program's copy; the tap writes.
  await page.evaluate(() => {
    const real = navigator.clipboard.writeText.bind(navigator.clipboard);
    window.refuse = 0;
    navigator.clipboard.writeText = text => (window.refuse > 0 ? (window.refuse -= 1, Promise.reject(new DOMException('no activation', 'NotAllowedError'))) : real(text));
    const exec = document.execCommand.bind(document);
    document.execCommand = command => (command === 'copy' && window.refuseExec ? false : exec(command));
  });
  const refuse = (times = 1) => page.evaluate(count => { window.refuse = count; window.refuseExec = true; }, times);
  const allow = () => page.evaluate(() => { window.refuse = 0; window.refuseExec = false; });
  await setClipboard('before');
  await refuse();
  await select('pick a word', 'from');
  await bar.waitFor({ state: 'visible' });
  const pageBar = await barShape();
  assert.equal(await page.locator('#h5-clipboard-copy').textContent(), 'Copy');
  assert.equal(await page.locator('#h5-clipboard-title').textContent(), 'Press Copy to finish copying');
  if (SHOTS) { await settled(page); await page.screenshot({ path: path.join(SHOTS, `copy-bar-tap-${touch ? 390 : 1440}.png`) }); }
  assert.equal(await clipboard(), 'before');
  await allow();
  await press(page.locator('#h5-clipboard-copy'));
  await bar.waitFor({ state: 'hidden' });
  assert.equal(await clipboard(), 'from', `${mode}: Copy on the bar writes the refused page selection`);
  await page.waitForTimeout(1600);
  await refuse();
  await gesture();
  await emit(osc('needs its own tap'));
  await bar.waitFor({ state: 'visible' });
  assert.deepEqual(await barShape(), pageBar, `${mode}: the same bar for a page selection and a program copy`);
  await allow();
  await press(page.locator('#h5-clipboard-copy'));
  await bar.waitFor({ state: 'hidden' });
  assert.equal(await clipboard(), 'needs its own tap', `${mode}: Copy on the bar writes the refused program copy`);
  await notices();
  // The tap fails too: the bar closes with one error notice.
  await page.waitForTimeout(2100);
  await refuse(2);
  await gesture();
  await emit(osc('nothing works'));
  await bar.waitFor({ state: 'visible' });
  await press(page.locator('#h5-clipboard-copy'));
  await bar.waitFor({ state: 'hidden' });
  const failed = touch ? 'Could not copy. Long-press to open the copy view' : 'Could not copy. Use Copy text in the terminal menu';
  await waitNotice(failed);
  assert.deepEqual(await notices(), [[failed, 'error']]);
  await allow();

  // Reduced motion: the bar appears without the slide and the pulse; Copy still writes only after the tap, Cancel still dismisses.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(1600);
  await emit(osc('calm bar'));
  await bar.waitFor({ state: 'visible' });
  const calm = await page.evaluate(() => { const node = document.querySelector('#h5-clipboard-bar'); return [getComputedStyle(node).animationName, getComputedStyle(node, '::after').animationName]; });
  assert.deepEqual(calm, ['none', 'none'], `${mode}: no animation with reduced motion`);
  assert.equal(await clipboard(), 'needs its own tap', `${mode}: nothing written before Copy (reduced motion)`);
  await press(page.locator('#h5-clipboard-cancel'));
  await bar.waitFor({ state: 'hidden' });
  assert.equal(await clipboard(), 'needs its own tap', `${mode}: Cancel copies nothing (reduced motion)`);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await notices();

  // 6. Replayed history never copies or asks, even right after a gesture.
  await gesture();
  await page.evaluate(data => window.sockets[0].emit(JSON.stringify({ type: 'history', data, cols: 60, rows: 20 })), `$ ${osc('replayed')}`);
  await page.waitForTimeout(500);
  assert.equal(await bar.count(), 0);
  assert.equal(await clipboard(), 'needs its own tap', `${mode}: replay copies nothing`);
  assert.deepEqual(errors, []);
  await context.close();
}

// A small phone (320 x 568) with a long single-line request and the terminal's on-screen keyboard open: the bar stays inside the screen and the
// terminal, under the header, the preview is cut with an ellipsis, the title is whole, the buttons wrap under the text at the right and are 44 px.
async function narrow(browser) {
  const { page, context, errors } = await openPage(browser, true, { width: 320, height: 568 });
  await page.locator('[data-action="keyboard"]').tap();
  await page.locator('#h5-osk').waitFor({ state: 'visible' });
  await page.waitForTimeout(1600);
  await page.evaluate(() => navigator.clipboard.writeText('before'));
  const long = `npm run build && ${'a-very-long-path/'.repeat(12)}end-of-the-request`;
  await page.evaluate(value => window.sockets[0].emit(value), osc(long));
  const bar = page.locator('#h5-clipboard-bar');
  await bar.waitFor({ state: 'visible' });
  await settled(page);
  const fit = await page.evaluate(() => {
    const box = node => node.getBoundingClientRect();
    const bar = box(document.querySelector('#h5-clipboard-bar'));
    const terminal = box(document.querySelector('#h5-terminal'));
    const header = box(document.querySelector('.h5-header'));
    const text = document.querySelector('#h5-clipboard-text');
    const title = document.querySelector('#h5-clipboard-title');
    const copy = box(document.querySelector('#h5-clipboard-copy'));
    const cancel = box(document.querySelector('#h5-clipboard-cancel'));
    const body = box(document.querySelector('.h5-clipboard-body'));
    return {
      bar: { left: bar.left, right: bar.right, top: bar.top, bottom: bar.bottom }, terminal: { left: terminal.left, right: terminal.right, top: terminal.top, bottom: terminal.bottom }, headerBottom: header.bottom,
      cut: text.scrollWidth > text.clientWidth + 1, titleWhole: title.scrollWidth <= title.clientWidth + 1,
      copy: { w: copy.width, h: copy.height, top: copy.top, right: copy.right }, cancel: { w: cancel.width, h: cancel.height, right: cancel.right }, bodyBottom: body.bottom,
      osk: document.querySelector('[data-action="keyboard"]').getAttribute('aria-pressed'), oskTop: box(document.querySelector('#h5-osk')).top,
    };
  });
  assert.equal(fit.osk, 'true', '320px: the on-screen keyboard is open');
  assert.ok(fit.bar.bottom <= fit.oskTop, `320px: the bar is above the on-screen keyboard ${JSON.stringify(fit)}`);
  assert.ok(fit.bar.left >= 0 && fit.bar.right <= 320 && fit.bar.left >= fit.terminal.left && fit.bar.right <= fit.terminal.right, `320px: the bar fits the width ${JSON.stringify(fit)}`);
  assert.ok(fit.bar.top >= fit.headerBottom && fit.bar.bottom <= fit.terminal.bottom, `320px: the bar is inside the terminal, under the header ${JSON.stringify(fit)}`);
  assert.ok(fit.cut, '320px: the long preview is cut with an ellipsis');
  assert.ok(fit.titleWhole, '320px: the title line is shown whole');
  assert.ok(fit.copy.h >= 44 && fit.copy.w >= 44 && fit.cancel.h >= 44 && fit.cancel.w >= 44, `320px: Copy and Cancel are 44px targets ${JSON.stringify(fit)}`);
  assert.ok(fit.copy.top >= fit.bodyBottom - 0.5 && fit.cancel.right <= fit.bar.right, `320px: the buttons wrap under the text ${JSON.stringify(fit)}`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'copy-bar-320-osk.png') });
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'before', '320px: nothing written before Copy');
  await page.locator('#h5-clipboard-copy').tap();
  await bar.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), long, '320px: Copy writes the whole text');
  assert.deepEqual(errors, []);
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await run(browser, true);
    await run(browser, false);
    await narrow(browser);
    console.log('PASS: copy on select in touch (390 px) and pointer (1440 px) mode: double / triple tap and mouse drag / double click copy at once with the OSC 52 notice, Cmd+C no second notice, program copy after a gesture (split, duplicate merged), bar with preview without one (Copy / Cancel / expiry, immutable; blue, icon, title, one slide and pulse, none with reduced motion), the same refused-copy bar for both sources, 320 px with a long text and the on-screen keyboard, error notice, merge across sources, replay ignored.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
