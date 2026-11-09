// Phone page (/h5) in real Chromium at phone size: key layout, task selection, phone-only terminals,
// latched modifiers, paste, image upload, translate-and-send and the guard against engines without phone terminals.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };

const ossUploads = [];
const ossPolicies = [];
const pageErrors = [];
// The conversations the page's server knows.
const chats = [];
const createBodies = []; // the bodies of POST .../terminals, in order
const pollUntil = async condition => { for (let i = 0; i < 500 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(condition(), 'timed out waiting for the server'); };
// What the task file API answers for DESIGN.md of task 1: the document, or a missing file. The paths of the file reads are kept.
let designMode = 'ready';
const designReads = [];
const DESIGN_MD = ['# Design of Fix login', '', 'Intro with **bold** text and a [web link](https://example.test/doc) and a [bad link](javascript:alert(1)).', '', '<script>window.injected = true</script>', '',
  '## Table', '', '| Key | Value |', '| --- | --- |', '| a | 1 |', '', '```js', 'const answer = 42;', '```', '', ...Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} of the long design text.`)].join('\n');

const translateRequests = []; // the texts the phone page sent to /api/translate

const innerWidthOf = viewport => viewport.width;

// A tap on a task only opens the list of its sessions; going to one is a tap on that session.
async function openTask(page, title, how = 'tap') {
  await page.locator('.h5-task-item', { hasText: title })[how]();
  await page.locator(`#h5-tasks .h5-terminal-list[aria-label="${title}"] .h5-terminal-main`).first()[how]();
}

let updateDone = false; // the mocked update-status answers "completed" once the test sets this
let checkMode = 'available'; // what the mocked update check answers: available | current | error

// touch: a phone or tablet (a touch screen: input mode 'touch'); without it the context has a mouse only, like a computer (input mode 'pointer').
// Phone-sized windows are touch screens by default; the wide window is the computer. The computer layout itself is tested in test-h5-pc-browser.cjs.
async function openPage(browser, { remoteTerminals, remoteChat = false, viewport, touch = !viewport || viewport.width < 900 } = {}) {
  // H5_SHOT_DIR=<dir> also saves screenshots of the design document sheet there, at 3x like a phone screen.
  const scale = process.env.H5_SHOT_DIR ? { deviceScaleFactor: 3 } : {};
  const context = await browser.newContext({ viewport: viewport || { width: 390, height: 844 }, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...scale });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  const calls = [];
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
    window.clip = 'git status';
    window.locks = { held: 0, requested: 0 };
    Object.defineProperty(navigator, 'wakeLock', { value: { request: async () => { window.locks.requested += 1; window.locks.held += 1; const lock = new EventTarget(); lock.release = async () => { window.locks.held -= 1; }; return lock; } }, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { readText: async () => window.clip }, configurable: true });
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    calls.push(`${method} ${url.pathname}${url.search}`);
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) {
      return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    }
    if (url.pathname === '/auth/logout' && method === 'POST') return json({ success: true });
    if (url.pathname === '/torin/hide/login') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>login</title>' });
    if (url.pathname === '/api/remote-servers') return json(remoteTerminals ? [{ id: 7, name: 'Old VPS' }] : []);
    if (url.pathname === '/api/tasks' && method === 'GET') return json([{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }, { id: 2, title: 'Write docs', status: 'todo' }]);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }, { key: 'todo', name: 'To do', sort_order: 2 }]);
    if (url.pathname === '/api/remote-servers/7/tasks') return json([{ id: 9, title: 'Remote task', status: 'doing' }]);
    if (url.pathname === '/api/remote-servers/7/task-groups') return json([]);
    if (url.pathname === '/api/remote-servers/7/tasks/9/terminals') return json([{ terminal_id: remoteChat ? 'h5-default' : 'default', title: 'Terminal 1' }]);
    if (url.pathname === '/api/remote-servers/7/info') return json({ capabilities: remoteChat ? ['agent-chat:manage'] : [] });
    if (url.pathname === '/api/tasks/1/files/content' && method === 'GET') {
      designReads.push(url.searchParams.get('path'));
      return designMode === 'missing' ? json({ error: 'FILE_NOT_FOUND' }, 404) : json({ path: 'DESIGN.md', content: DESIGN_MD, revision: 'r1', eol: '\n', bom: false });
    }
    if (url.pathname === '/api/tasks/1/terminals' && method === 'GET') return json([{ terminal_id: 'h5-default', title: 'Terminal 1' }]);
    if (url.pathname === '/api/tasks/2/terminals' && method === 'GET') return json([{ terminal_id: 'h5-docs', title: 'Docs terminal' }]);
    if (url.pathname === '/api/tasks/2/agent/conversations' && method === 'GET') return json([]);
    if (url.pathname === '/api/tasks/1/terminals' && method === 'POST') { createBodies.push(route.request().postDataJSON()); return json({ terminal_id: 'h5-second', title: 'Terminal 2' }, 201); }
    if (url.pathname === '/api/tasks/1/terminals/h5-second' && method === 'PATCH') return json({ terminal_id: 'h5-second', title: route.request().postDataJSON().title });
    if (url.pathname === '/api/tasks/1/terminal/control' && method === 'POST') return json({ success: true });
    if (url.pathname === '/api/tasks/1/agent-sessions') return json([]);
    // A notification link opens a chat.
    const chatPath = url.pathname.replace('/api/remote-servers/7/tasks/9/agent', '/api/tasks/1/agent');
    // Chat-style agents: the conversation list, one conversation and an idle event stream.
    if (chatPath === '/api/tasks/1/agent/conversations' && method === 'GET') return json(chats);
    if (chatPath === '/api/tasks/1/agent/conversations/c1') return json({ conversation: { id: 'c1' }, items: [{ id: 'u1', kind: 'user', text: 'hello agent' }, { id: 't1', kind: 'text', text: 'Hi **there**' }], pending: [], status: 'idle', seq: 0 });
    if (chatPath === '/api/tasks/1/agent/conversations/c1/events') return route.fulfill({ contentType: 'text/event-stream', body: ': ok\n\n' });
    if (url.pathname === '/api/oss/config') return json({ enabled: true });
    if (url.pathname === '/api/oss/upload-policy' && method === 'POST') {
      // The Client only signs the upload; the image itself goes to OSS from the browser.
      const asked = route.request().postDataJSON();
      ossPolicies.push(asked);
      if (asked.kind === 'file') {
        assert.deepEqual(asked, { kind: 'file', type: 'application/pdf', size: 9, name: 'notes.pdf' });
        return json({ host: 'https://bucket.oss.test', fields: { key: 'terminal-images/notes.pdf', 'Content-Disposition': 'attachment; filename="notes.pdf"', policy: 'p' }, url: 'https://img.test/notes.pdf', expiresAt: null });
      }
      assert.deepEqual(asked, { type: 'image/png', size: 8 });
      return json({ host: 'https://bucket.oss.test', fields: { key: 'terminal-images/shot.png', policy: 'p', 'x-oss-signature': 's' }, url: 'https://img.test/shot.png', expiresAt: null });
    }
    if (url.pathname === '/api/oss/images') return json({ error: 'the Client no longer receives images' }, 404);
    if (url.pathname === '/api/system/check-update') {
      if (checkMode === 'current') return json({ status: 'current', is_update_admin: true, local_version: '1.0.0', remote_version: '1.0.0' });
      if (checkMode === 'error') return json({ status: 'failed', error: 'REMOTE_DOWN', is_update_admin: true, local_version: '1.0.0' });
      return json({ status: 'available', is_update_admin: true, local_version: '1.0.0', remote_version: '1.0.1' });
    }
    if (url.pathname === '/api/system/version') return json({ boot_id: 'old' });
    if (url.pathname === '/api/system/apply-update') { assert.deepEqual(route.request().postDataJSON(), { confirm: true }); return json({ accepted: true }, 202); }
    if (url.pathname === '/api/system/update-status' && updateDone) return json({ status: 'current', stage: 'completed', message: 'done', log: [{ at: 1, text: 'npm ci' }], boot_id: 'old' });
    if (url.pathname === '/api/system/update-status') return json({ status: 'updating', stage: 'installing', message: 'Installing dependencies', log: [{ at: 1, text: 'npm ci' }], boot_id: 'old' });
    if (url.pathname === '/api/translate') {
      const text = route.request().postDataJSON().text;
      translateRequests.push(text);
      if (text.startsWith('FAIL')) return json({ error: 'Translation service unavailable' }, 502);
      if (text.startsWith('LONG')) return json({ text: `${'word '.repeat(300)}end\u001b[2J` }); // a long translation on one line
      if (text.startsWith('SLOW')) { await new Promise(resolve => setTimeout(resolve, 600)); return json({ text: 'Slow done' }); }
      return json({ text: text.startsWith('MULTI') ? 'First line\n\nSecond line\u001b[2J' : 'Run the tests\u001b[2J' });
    }
    return json({ error: 'not mocked' }, 404);
  });
  await page.route('https://bucket.oss.test/**', async route => {
    const request = route.request();
    const body = request.postDataBuffer().toString('latin1');
    assert.match(request.headers()['content-type'], /^multipart\/form-data/);
    assert.ok(body.includes('name="key"') && body.indexOf('name="key"') < body.indexOf('name="file"'), 'the file is the last field');
    ossUploads.push(body);
    await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '' });
  });
  page.on('pageerror', e => console.log('PAGEERR', e.message));
  await page.goto(`${ORIGIN}/h5`);
  return { context, page, calls };
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const { context, page, calls } = await openPage(browser);
    // Nothing chosen yet: the task sheet opens on its own.
    await page.locator('#h5-tasks').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.h5-group-title').count(), 0, 'the tasks are one list, with no group titles');
    // A tap on a task does not go anywhere: it opens the list of its sessions, and a tap on a session goes there.
    await page.locator('.h5-task-item', { hasText: 'Fix login' }).tap();
    await page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main', { hasText: 'Terminal 1' }).waitFor();
    assert.equal(await page.locator('#h5-tasks').isVisible(), true, 'the sheet stays open');
    assert.equal(await page.locator('.h5-task-item', { hasText: 'Fix login' }).getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#h5-task-name').textContent(), 'Choose a task', 'the task is not selected yet');
    assert.equal(await page.evaluate(() => window.sockets.length), 0, 'no terminal is opened by the tap on the task');
    await page.locator('.h5-task-item', { hasText: 'Fix login' }).tap();
    await page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"]').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.h5-task-item', { hasText: 'Fix login' }).getAttribute('aria-expanded'), 'false', 'a second tap closes the list');
    await openTask(page, 'Fix login');
    await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#h5-task-name').textContent(), 'Fix login');
    assert.equal(await page.locator('#agent-activity').count(), 0, 'the agent counters are gone from the header');
    // The name of the terminal that is shown stands under the task name, in small text.
    await page.locator('#h5-session-name', { hasText: 'Terminal 1' }).waitFor();
    const [nameBox, sessionBox] = await Promise.all([page.locator('#h5-task-name').boundingBox(), page.locator('#h5-session-name').boundingBox()]);
    assert.ok(sessionBox.y >= nameBox.y + nameBox.height - 1, 'the session name is below the task name');
    assert.ok(await page.locator('#h5-session-name').evaluate(node => parseFloat(getComputedStyle(node).fontSize)) < await page.locator('#h5-task-name').evaluate(node => parseFloat(getComputedStyle(node).fontSize)), 'in smaller text');
    const headerHeight = () => page.locator('.h5-header').evaluate(node => node.getBoundingClientRect().height);
    const terminalHeader = await headerHeight();
    // The task panel slides in from the left when the menu button is tapped.
    await page.locator('#h5-open-tasks').tap();
    const midway = await page.locator('#h5-tasks .h5-sheet-panel').evaluate(el => new Promise(resolve => setTimeout(() => resolve(el.getBoundingClientRect().left), 60)));
    assert.ok(midway < 0 && midway > -390, `panel is mid-slide from the left (x=${midway})`);
    await page.waitForFunction(() => document.querySelector('#h5-tasks .h5-sheet-panel').getBoundingClientRect().left === 0);
    await page.locator('#h5-close-tasks').tap();
    await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.sockets.length === 1 && window.sockets[0].readyState === 1);
    assert.ok(calls.includes('GET /api/tasks/1/terminals'));
    assert.match(await page.evaluate(() => new URL(window.sockets[0].url).search), /^\?taskId=1&terminalId=h5-default&clientId=[\w-]+&proto=2$/);
    assert.equal(await page.evaluate(() => window.sockets[0].url.startsWith('ws://h5.test/terminal/ws')), true);
    // The screen stays on while a task is open, so the phone does not sleep during the session.
    await page.waitForFunction(() => window.locks.held === 1);

    // Saved screen first, then live input is allowed.
    await page.evaluate(() => window.sockets[0].emit(JSON.stringify({ type: 'history', data: 'saved prompt$ ', cols: 80, rows: 24 })));
    await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-rows')?.textContent.includes('saved prompt$'));
    // OSC 8 links: a javascript: address is never confirmed or opened; an https address is confirmed first, then opened in a new tab.
    await page.evaluate(() => {
      window.opened = [];
      window.open = (...args) => { window.opened.push(args[0]); return null; };
      window.sockets[0].emit('\r\n\x1b]8;;javascript:alert(1)\x07EVILLINK\x1b]8;;\x07\r\n\x1b]8;;https://example.com/ok\x07GOODLINK\x1b]8;;\x07');
    });
    await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-rows')?.textContent.includes('GOODLINK'));
    const clickText = async text => {
      const box = await page.locator('.h5-xterm:not([hidden]) .xterm-rows > div', { hasText: text }).first().boundingBox();
      await page.mouse.move(box.x + 12, box.y + box.height / 2);
      await page.mouse.move(box.x + 14, box.y + box.height / 2);
      await page.mouse.down(); await page.mouse.up();
    };
    const prompts = [];
    page.on('dialog', dialog => { prompts.push(dialog.message()); void dialog.accept(); });
    await clickText('EVILLINK');
    await page.waitForTimeout(300);
    assert.deepEqual(prompts, [], 'a javascript: link asks nothing');
    assert.deepEqual(await page.evaluate(() => window.opened), [], 'a javascript: link is never opened');
    await clickText('GOODLINK');
    await page.waitForFunction(() => window.opened.length === 1);
    assert.deepEqual(await page.evaluate(() => window.opened), ['https://example.com/ok'], 'an https link opens after confirmation');
    assert.match(prompts[0], /https:\/\/example\.com\/ok/, 'the real address is shown');
    page.removeAllListeners('dialog');
    await page.waitForTimeout(100);
    const resize = await page.evaluate(() => window.sockets[0].sent.map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(item => item?.type === 'resize').pop());
    assert.ok(resize.cols < 80 && resize.cols >= 30, `the phone terminal fits the phone width (${resize.cols} columns)`);

    // Key grid: first two rows follow the mobile terminal layout and every key is finger-sized.
    const rows = await page.evaluate(() => {
      const byRow = new Map();
      for (const button of document.querySelectorAll('#h5-keys button')) {
        const box = button.getBoundingClientRect();
        const top = Math.round(box.top);
        if (!byRow.has(top)) byRow.set(top, []);
        byRow.get(top).push({ left: box.left, right: box.right, height: box.height, text: button.textContent.trim() || button.getAttribute('aria-label') });
      }
      return [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row.sort((a, b) => a.left - b.left));
    });
    assert.equal(rows.length, 1, 'the function keys are one row that scrolls sideways');
    assert.deepEqual(rows[0].map(cell => cell.text), ['Esc', 'Left arrow', 'Down arrow', 'Up arrow', 'Right arrow', 'Enter', 'Backspace', 'Tab', 'Ctrl', 'Alt', 'Home', 'End', 'PgUp', 'PgDn', 'Ins', 'Del', 'Shift', '^C'], 'the order is Esc, the arrows, Enter, Backspace, then the other keys');
    {
      // Function keys: the arrows, Enter, Backspace, Tab and Shift are icons (library or self-drawn; one inline SVG, currentColor, no text), the rest are short text labels; every key has an English aria-label and the same title.
      const keys = await page.evaluate(() => [...document.querySelectorAll('#h5-keys button')].map(b => ({ text: b.textContent.trim(), svg: b.querySelectorAll('svg').length, aria: b.getAttribute('aria-label'), title: b.getAttribute('title'), fill: getComputedStyle(b.querySelector('svg') || b).fill })));
      const textKeys = keys.filter(k => !k.svg).map(k => k.text);
      assert.deepEqual(textKeys, ['Esc', 'Ctrl', 'Alt', 'Home', 'End', 'PgUp', 'PgDn', 'Ins', 'Del', '^C'], 'the keys without a clear icon keep a text label');
      for (const k of keys.filter(k => !k.svg && k.aria)) assert.ok(k.aria === k.title, `${k.text} has an aria-label equal to its title`);
      for (const k of keys.filter(k => k.svg)) { assert.equal(k.text, '', `${k.aria} has no text`); assert.ok(k.aria && k.aria === k.title, `${k.aria} has an aria-label equal to its title`); }
      assert.equal(await page.locator('#h5-keys svg').evaluateAll(list => new Set(list.map(el => el.innerHTML)).size), 8, 'the 8 icon keys have 8 different icons');
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('#h5-keys svg')].every(el => el.getAttribute('aria-hidden') === 'true' && el.querySelector('path'))), true, 'the icons are inline SVG paths');
    }
    assert.equal(await page.evaluate(() => { const el = document.getElementById('h5-keys'); const first = el.querySelector('button').getBoundingClientRect(); return el.scrollLeft === 0 && first.left >= 0; }), true, 'the row starts scrolled to the left with Esc in view');
    const keyStrip = await page.evaluate(() => { const el = document.getElementById('h5-keys'); return { scrolls: el.scrollWidth > el.clientWidth, overflowX: getComputedStyle(el).overflowX }; });
    assert.ok(keyStrip.scrolls && keyStrip.overflowX === 'auto', 'the key row scrolls sideways');
    // The function row scrolls sideways: no wrapping, no shrinking keys, no scroll bar; scrollLeft can change; a touch drag scrolls and presses no key; a tap still works.
    {
      const keysSent = () => page.evaluate(() => window.sockets[0].sent.filter(item => !item.startsWith('{')));
      const look = await page.evaluate(() => { const el = document.getElementById('h5-keys'); const cs = getComputedStyle(el); const widths = () => [...el.querySelectorAll('button')].map(b => Math.round(b.getBoundingClientRect().width));
        return { wrap: cs.flexWrap, scrollbar: cs.scrollbarWidth, widths: widths(), overflowing: el.scrollWidth > el.clientWidth + 20, shrink: [...el.querySelectorAll('button')].every(b => getComputedStyle(b).flexShrink === '0') }; });
      assert.deepEqual([look.wrap, look.scrollbar, look.overflowing, look.shrink], ['nowrap', 'none', true, true], 'the function row does not wrap, hides its scroll bar, overflows and its keys do not shrink');
      const sentBefore = (await keysSent()).length;
      const box = await page.locator('#h5-keys [data-key="Escape"]').boundingBox();
      const cdp = await page.context().newCDPSession(page);
      const y = box.y + box.height / 2;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2 + 100, y }] });
      for (let step = 1; step <= 10; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.width / 2 + 100 - step * 20, y }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(300);
      assert.ok(await page.evaluate(() => document.getElementById('h5-keys').scrollLeft) > 20, 'a touch drag scrolls the function row');
      assert.equal((await keysSent()).length, sentBefore, 'a drag presses no key');
      await page.evaluate(() => { document.getElementById('h5-keys').scrollLeft = 0; });
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#h5-keys button')].map(b => Math.round(b.getBoundingClientRect().width))), look.widths, 'the keys keep their widths while scrolling');
      await page.locator('#h5-keys [data-key="Escape"]').tap();
      assert.equal((await keysSent()).length, sentBefore + 1, 'a tap on a key still sends it');
      await page.evaluate(() => { const el = document.getElementById('h5-keys'); el.scrollLeft = el.scrollWidth; });
      assert.ok(await page.evaluate(() => document.getElementById('h5-keys').scrollLeft) > 0, 'scrollLeft can change');
      await page.evaluate(() => { document.getElementById('h5-keys').scrollLeft = 0; });
    }
    // The arrows sit in one row in the order left, down, up, right.
    const arrows = await page.evaluate(() => Object.fromEntries(['Left', 'Down', 'Up', 'Right'].map(name => { const box = document.querySelector(`#h5-keys [data-key="Arrow${name}"]`).getBoundingClientRect(); return [name, { left: box.left, top: box.top }]; })));
    assert.ok(arrows.Left.left < arrows.Down.left && arrows.Down.left < arrows.Up.left && arrows.Up.left < arrows.Right.left, 'left, down, up, right in that order');
    assert.equal(arrows.Left.top, arrows.Right.top);
    // The bottom area: the draft box is hidden by default (no resting pill) and, in the DOM, it sits above the key row. The two keyboard keys have icons, titles and no pressed state at first.
    assert.equal(await page.locator('#h5-translate').isVisible(), false, 'the draft box is hidden by default');
    assert.equal(await page.evaluate(() => document.getElementById('h5-translate').getBoundingClientRect().height), 0, 'hidden: it takes no height at all');
    assert.equal(await page.evaluate(() => document.getElementById('h5-bottom').style.getPropertyValue('--h5-bar-extra') || '0px'), '0px', 'hidden: nothing is covered');
    assert.equal(await page.evaluate(() => Boolean(document.getElementById('h5-translate').compareDocumentPosition(document.getElementById('h5-keys')) & Node.DOCUMENT_POSITION_FOLLOWING)), true, 'the draft box comes before the key row');
    for (const [action, label] of [['keyboard', 'Terminal keyboard'], ['draft', 'Draft keyboard']]) {
      const key = page.locator(`#h5-actions [data-action="${action}"]`);
      assert.equal(await key.getAttribute('aria-label'), label);
      assert.equal(await key.getAttribute('title'), label);
      assert.equal(await key.getAttribute('aria-pressed'), 'false', `${label} is not pressed at first`);
      assert.equal(await key.locator('svg').count(), 1, `${label} has an icon`);
    }
    assert.notEqual(await page.locator('[data-action="keyboard"] svg').innerHTML(), await page.locator('[data-action="draft"] svg').innerHTML(), 'the two keyboard icons differ');
    // Row 2 (reference design): terminal keyboard, draft keyboard, upload image, saved commands, voice; equal buttons filling the width, below the function key row. Send and translate-and-send are not shown while the box is hidden.
    {
      const row2 = await page.evaluate(() => [...document.querySelectorAll('#h5-actions button, #h5-actions [role="button"]')].map(b => { const r = b.getBoundingClientRect(); return { label: b.getAttribute('aria-label'), left: r.left, right: r.right, top: r.top, width: r.width, height: r.height }; }).filter(b => b.width > 0));
      assert.deepEqual(row2.map(b => b.label), ['Terminal keyboard', 'Draft keyboard', 'Upload image or file', 'Saved commands', 'Voice input', 'Docs', 'Attention', 'Next running or pending session'], 'row 2: the two keyboards, image, saved commands, voice, Docs, Attention, next running or pending session');
      assert.ok(row2.every(b => Math.abs(b.top - row2[0].top) <= 1 && Math.abs(b.width - row2[0].width) <= 1 && b.height >= 40), 'row 2: one row of equal, finger-sized buttons');
      assert.ok(row2[0].left >= 0 && row2.at(-1).right <= 390, 'row 2 fits the screen');
      assert.equal(await page.evaluate(() => document.querySelector('#h5-actions').getBoundingClientRect().top >= document.getElementById('h5-keys').getBoundingClientRect().bottom - 1), true, 'row 2 is below the function keys');
      for (const id of ['h5-translate-send', 'h5-translate-button']) assert.equal(await page.locator(`#${id}`).isVisible(), false, `${id} is not shown while the box is hidden`);
      assert.equal(await page.evaluate(() => Boolean(document.getElementById('h5-translate').compareDocumentPosition(document.getElementById('h5-keys')) & Node.DOCUMENT_POSITION_FOLLOWING && document.getElementById('h5-keys').compareDocumentPosition(document.getElementById('h5-actions')) & Node.DOCUMENT_POSITION_FOLLOWING)), true, 'order: draft box, function keys, action row');
    }
    assert.ok(rows.flat().every(cell => cell.height >= 32), 'the keys are finger-sized');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

    // Design document: the last button of row 2 opens DESIGN.md of the task's working directory in a sheet from the bottom. The terminal keeps its size and no resize is sent.
    {
      const design = page.locator('#h5-design');
      assert.equal(await design.getAttribute('aria-label'), 'Docs');
      assert.equal(await design.getAttribute('title'), 'Docs');
      assert.equal(await design.locator('svg').count(), 1, 'the design button has an icon');
      const measure = () => page.evaluate(() => {
        const term = document.querySelector('#h5-terminal .xterm').getBoundingClientRect();
        return { width: term.width, height: term.height, top: term.top, resizes: window.sockets[0].sent.filter(item => { try { return JSON.parse(item).type === 'resize'; } catch { return false; } }).length };
      });
      const before = await measure();
      await page.evaluate(() => document.querySelector('#h5-terminal .h5-xterm:not([hidden]) .xterm-helper-textarea').focus()); // a focused input is blurred first, so the on-screen keyboard closes
      await design.tap();
      await page.locator('#h5-design-body h1', { hasText: 'Design of Fix login' }).waitFor();
      assert.deepEqual(designReads, ['DESIGN.md'], 'read through the task file API, relative to the working directory');
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('xterm-helper-textarea')), false, 'the terminal input lost the focus');
      assert.equal(await page.locator('#h5-design-path').textContent(), '/work/fix-login/DESIGN.md');
      await page.waitForFunction(() => { const panel = document.querySelector('.h5-design-panel'); return panel && ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(panel).transform); }, null, { timeout: 3000 }); // the slide has ended
      const sheet = await page.locator('.h5-design-panel').boundingBox();
      const vh = page.viewportSize().height;
      assert.ok(Math.abs(sheet.height - vh * 0.88) <= 2 && Math.abs(sheet.y) <= 1, `the sheet is 88% of the height, at the top (${sheet.y}, ${sheet.height})`);
      assert.equal(await page.locator('#h5-design-body table td').first().textContent(), 'a', 'tables are rendered');
      assert.equal((await page.locator('#h5-design-body .md-code-block code').textContent()).trim(), 'const answer = 42;', 'code blocks are rendered');
      assert.equal(await page.locator('#h5-design-body a[href="https://example.test/doc"]').count(), 1, 'web links stay links');
      assert.equal(await page.locator('#h5-design-body a', { hasText: 'bad link' }).count(), 0, 'a javascript: link is only text');
      assert.equal(await page.evaluate(() => Boolean(window.injected) || Boolean(document.querySelector('#h5-design-body script'))), false, 'raw HTML is shown as text, never run');
      assert.equal(await page.evaluate(() => { const b = document.getElementById('h5-design-body'); return b.scrollHeight > b.clientHeight && getComputedStyle(b).overflowY === 'auto'; }), true, 'the content scrolls');
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#h5-design-body .markdown-body')).color), 'rgb(230, 237, 243)', 'dark document colours');
      if (process.env.H5_SHOT_DIR) await page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, 'h5-design-open.png') });
      const open = await measure();
      assert.deepEqual(open, before, 'opening the sheet does not resize or move the terminal and sends no resize');
      // The close button closes it.
      await page.locator('#h5-design-close').tap();
      await page.locator('.h5-design-panel').waitFor({ state: 'hidden' });
      // A tap on the dimmed page closes it too.
      await design.tap();
      await page.locator('#h5-design-body h1').waitFor();
      await page.mouse.click(200, vh - 30);
      await page.locator('.h5-design-panel').waitFor({ state: 'hidden' });
      // Escape closes it.
      await design.tap();
      await page.locator('#h5-design-body h1').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('.h5-design-panel').waitFor({ state: 'hidden' });
      // A swipe up on the sheet closes it (real touch events through the DevTools protocol).
      await design.tap();
      await page.locator('#h5-design-body h1').waitFor();
      await page.waitForFunction(() => ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(document.querySelector('.h5-design-panel')).transform), null, { timeout: 3000 });
      {
        const cdp = await page.context().newCDPSession(page);
        const handle = await page.locator('.h5-design-handle').boundingBox();
        const x = handle.x + handle.width / 2;
        let y = handle.y + handle.height / 2;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let i = 0; i < 12; i++) { y -= 40; await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }); await page.waitForTimeout(16); }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await cdp.detach();
      }
      await page.locator('.h5-design-panel').waitFor({ state: 'hidden' });
      // No DESIGN.md: a clear empty state, not an error.
      designMode = 'missing';
      await design.tap();
      await page.locator('#h5-design-empty', { hasText: 'No DESIGN.md in /work/fix-login' }).waitFor();
      assert.equal(await page.locator('#h5-design-body').isVisible(), false);
      if (process.env.H5_SHOT_DIR) {
        await page.waitForFunction(() => ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(document.querySelector('.h5-design-panel')).transform), null, { timeout: 3000 });
        await page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, 'h5-design-missing.png') });
      }
      await page.locator('#h5-design-close').tap();
      await page.locator('.h5-design-panel').waitFor({ state: 'hidden' });
      designMode = 'ready';
      assert.deepEqual(await measure(), before, 'after all of it the terminal has the same size and no resize was sent');
    }

    const sent = () => page.evaluate(() => window.sockets[0].sent.filter(item => !item.startsWith('{')));
    // The blue state of Ctrl, Alt and Shift is exactly the armed state: aria-pressed and the accent colour agree; a second tap disarms; the next key releases it (one-shot).
    for (const name of ['ctrl', 'alt', 'shift']) {
      const key = page.locator(`[data-modifier="${name}"]`);
      const look = () => key.evaluate(el => ({ pressed: el.getAttribute('aria-pressed'), selected: el.classList.contains('Mui-selected'), border: getComputedStyle(el).borderColor }));
      const off = await look();
      assert.deepEqual([off.pressed, off.selected], ['false', false], `${name} is normal at first`);
      await key.tap();
      const on = await look();
      assert.deepEqual([on.pressed, on.selected], ['true', true], `${name} armed: pressed and blue`);
      assert.notEqual(on.border, off.border, `${name} armed looks different`);
      await page.locator('#h5-translate-input').focus(); // the bar changes layout: the state stays
      await page.waitForTimeout(250);
      assert.equal((await look()).pressed, 'true', `${name} stays armed when the bar changes layout`);
      await page.locator('#h5-translate-input').blur();
      await key.tap();
      assert.deepEqual([(await look()).pressed, (await look()).selected], ['false', false], `${name} disarmed by a second tap`);
    }
    await page.locator('[data-modifier="shift"]').tap();
    await page.locator('[data-key="Home"]').tap();
    assert.equal(await page.locator('[data-modifier="shift"]').getAttribute('aria-pressed'), 'false', 'the modifier is released after the next key (one-shot)');

    await page.locator('[data-key="Escape"]').tap();
    await page.locator('[data-modifier="ctrl"]').tap();
    assert.equal(await page.locator('[data-modifier="ctrl"]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-key="ArrowUp"]').tap();
    assert.equal(await page.locator('[data-modifier="ctrl"]').getAttribute('aria-pressed'), 'false');
    // A latched Ctrl applies to the next character typed on the on-screen keyboard.
    await page.locator('[data-modifier="ctrl"]').tap();
    await page.locator('.h5-xterm:not([hidden]) textarea').focus();
    await page.keyboard.type('c');
    await page.locator('[data-shortcut="ctrl-c"]').tap();
    await page.locator('#h5-commands').tap(); // the saved commands menu also holds Paste text
    await page.locator('.h5-add-menu [role="menuitem"]', { hasText: 'Paste text' }).tap();
    await page.waitForFunction(() => window.sockets[0].sent.includes('git status'));
    assert.deepEqual(await sent(), ['\x1b', '\x1b[1;2H', '\x1b', '\x1b[1;5A', '\x03', '\x03', 'git status']);
    for (const name of ['Left', 'Down', 'Up', 'Right']) await page.locator(`[data-key="Arrow${name}"]`).tap();
    assert.deepEqual((await sent()).slice(7), ['\x1b[D', '\x1b[B', '\x1b[A', '\x1b[C'], 'each arrow sends its own sequence');

    // Tapping the terminal never asks for the system keyboard; the keyboard key shows the terminal's own keyboard (scripts/test-h5-osk-browser.cjs) and the
    // textarea keeps inputmode none and is not focused.
    const inputmode = () => page.evaluate(() => document.querySelector('.h5-xterm:not([hidden]) textarea').getAttribute('inputmode'));
    const inTerminal = () => page.evaluate(() => document.querySelector('.h5-xterm:not([hidden])').contains(document.activeElement));
    assert.equal(await inputmode(), 'none');
    await page.locator('.h5-xterm:not([hidden])').tap();
    assert.equal(await inputmode(), 'none', 'tapping the terminal does not request the on-screen keyboard');
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.locator('[data-action="keyboard"]').tap();
    await page.locator('#h5-osk').waitFor();
    assert.equal(await inputmode(), 'none', 'the terminal keyboard key never asks for the system keyboard');
    assert.equal(await inTerminal(), false, 'the terminal keyboard key does not focus the terminal');
    await page.locator('.h5-xterm:not([hidden])').tap();
    assert.equal(await inputmode(), 'none');
    assert.equal(await page.locator('#h5-osk').count(), 1, 'a terminal tap keeps the terminal keyboard shown');
    await page.locator('[data-action="keyboard"]').tap();
    await page.locator('#h5-osk').waitFor({ state: 'detached' });
    assert.equal(await inputmode(), 'none');

    // Draft box: hidden by default (no resting pill). The "Draft keyboard" key focuses it and it shows ABOVE the function keys: the box takes row 1 across the width
    // and the buttons sit on row 2. The "Terminal keyboard" key focuses the terminal and keeps it hidden. Blur hides it again. Pressing a button must not hide it.
    // The bar animates (about 180 ms); measurements wait until no animation is running instead of sleeping.
    const barSettled = () => page.waitForFunction(() => !document.getAnimations().some(a => a.playState === 'running') && !document.querySelector('.h5-bar-moving'), null, { timeout: 3000 });
    const openDraft = async () => { await page.locator('[data-action="draft"]').tap(); await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'h5-translate-input'); };
    const barRects = async () => { await barSettled(); return page.evaluate(() => {
      const r = id => { const b = document.getElementById(id).getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height }; };
      const form = r('h5-translate');
      const root = document.querySelector('.h5-translate-input').getBoundingClientRect();
      const resizes = window.sockets[0].sent.filter(item => { try { return JSON.parse(item).type === 'resize'; } catch { return false; } }).length;
      return { form, root: { top: root.top, bottom: root.bottom, left: root.left, right: root.right, width: root.width }, input: r('h5-translate-input'), voice: r('h5-voice'), commands: r('h5-commands'), area: r('h5-bottom'), keys: r('h5-keys'), send: r('h5-translate-send'), translate: r('h5-translate-button'), resizes,
        term: document.getElementById('h5-terminal').getBoundingClientRect().height, focused: document.activeElement && document.activeElement.id,
        xterm: (() => { const b = document.querySelector('.h5-xterm:not([hidden])').getBoundingClientRect(); return { top: b.top, height: b.height }; })(),
        screenBottom: document.querySelector('.h5-xterm:not([hidden]) .xterm-screen').getBoundingClientRect().bottom, rows: document.querySelectorAll('.h5-xterm:not([hidden]) .xterm-rows > div').length };
    }); };
    {
      // The cursor is on the last row, so the last row must stay visible above the bar when the bar grows over the terminal.
      await page.evaluate(() => window.sockets[0].emit('\x1b[999;1Hlast'));
      await page.waitForTimeout(200);
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      const rest = await barRects();
      assert.notEqual(rest.focused, 'h5-translate-input');
      assert.equal(rest.form.height, 0, 'hidden by default: the draft box has no height');
      assert.equal(await page.locator('#h5-translate').isVisible(), false);
      assert.equal(await page.locator('[data-action="draft"]').getAttribute('aria-pressed'), 'false');
      // The terminal keyboard key shows the terminal's own keyboard (not the system one) and keeps the draft box hidden; the terminal refits above it
      // (rows and resizes are checked in scripts/test-h5-osk-browser.cjs).
      await page.locator('[data-action="keyboard"]').tap();
      await page.locator('#h5-osk').waitFor();
      assert.equal(await page.evaluate(() => document.querySelector('.h5-xterm:not([hidden])').contains(document.activeElement)), false, 'the terminal keyboard key does not focus the terminal');
      assert.equal(await page.evaluate(() => document.getElementById('h5-translate').getBoundingClientRect().height), 0, 'the draft box stays hidden');
      assert.equal(await page.locator('[data-action="keyboard"]').getAttribute('aria-pressed'), 'true', 'the terminal keyboard key is blue');
      assert.equal(await page.locator('[data-action="draft"]').getAttribute('aria-pressed'), 'false');
      await page.locator('[data-action="keyboard"]').tap(); // a second tap closes it
      await page.locator('#h5-osk').waitFor({ state: 'detached' });
      assert.equal(await page.locator('[data-action="keyboard"]').getAttribute('aria-pressed'), 'false');
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      // Showing and hiding the terminal keyboard refits the terminal twice (smaller, then back): wait for the rows to come back and count resizes from here.
      await page.waitForFunction(rows => document.querySelectorAll('.h5-xterm:not([hidden]) .xterm-rows > div').length === rows, rest.rows);
      rest.resizes = (await barRects()).resizes;
      // The draft keyboard key focuses the box, which shows above the function keys.
      await openDraft();
      const active = await barRects();
      assert.equal(await page.evaluate(() => document.querySelector('.h5-xterm:not([hidden])').contains(document.activeElement)), false, 'the terminal gave up the focus');
      assert.equal(await page.locator('#h5-translate').isVisible(), true, 'the draft box is shown');
      assert.equal(await page.evaluate(() => document.querySelector('.h5-xterm:not([hidden]) textarea').getAttribute('inputmode')), 'none', 'the terminal asks for no keyboard while the draft box has it');
      await page.locator('[data-action="keyboard"]').tap(); // moving to the terminal keyboard hides the draft box again
      await page.waitForFunction(() => document.getElementById('h5-translate').getBoundingClientRect().height === 0 && document.getElementById('h5-osk'));
      assert.equal(await page.evaluate(() => document.getElementById('h5-translate').getBoundingClientRect().height), 0, 'the terminal keyboard key hides the draft box');
      await openDraft();
      // That round trip showed and hid the terminal keyboard, which refits the terminal twice: move the resize baseline past it.
      await page.waitForFunction(rows => document.querySelectorAll('.h5-xterm:not([hidden]) .xterm-rows > div').length === rows, rest.rows);
      { const roundTrip = (await barRects()).resizes - active.resizes; assert.ok(roundTrip === 0 || roundTrip === 2, `the terminal keyboard round trip resized ${roundTrip} times`); rest.resizes += roundTrip; active.resizes += roundTrip; }
      assert.equal(await page.locator('[data-action="draft"]').getAttribute('aria-pressed'), 'true', 'the draft keyboard key is blue');
      assert.equal(await page.locator('[data-action="keyboard"]').getAttribute('aria-pressed'), 'false');
      assert.ok(active.form.bottom <= active.keys.top + 1 && active.form.top < active.keys.top, 'the draft box is above the function keys');
      assert.ok(active.keys.top - active.form.bottom <= 12, 'right above the keys, not floating away');
      assert.ok(active.root.bottom <= active.keys.top + 1 && active.keys.bottom <= active.voice.top + 1, 'the box is above the function keys, and the action row below them');
      assert.ok(Math.abs(active.voice.top - active.send.top) <= 6 && Math.abs(active.send.top - active.translate.top) <= 6, 'voice, send and translate share the action row');
      assert.ok(active.commands.right <= active.voice.left + 1 && active.voice.right <= active.send.left + 1, 'voice is left of the send arrow');
      assert.ok(active.send.right <= active.translate.left + 1, 'the send arrow is left of the translate-and-send button');
      assert.ok(active.translate.right <= 390 && active.send.width >= 40 && active.send.height >= 40 && active.translate.height >= 40, 'the buttons fit the screen and are finger-sized');
      assert.equal(await page.evaluate(() => { const a = document.getElementById('h5-translate-send'), b = document.getElementById('h5-translate-button'); return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); }), true, 'DOM and tab order: send arrow before translate-and-send');
      const looks = await page.evaluate(() => { const bg = id => getComputedStyle(document.getElementById(id)).backgroundColor; const rad = id => getComputedStyle(document.getElementById(id)).borderTopLeftRadius; return { send: bg('h5-translate-send'), translate: bg('h5-translate-button'), sendRadius: rad('h5-translate-send') }; });
      assert.equal(looks.send, 'rgb(255, 255, 255)', 'as in the image, the send arrow is the white round button');
      assert.equal(looks.translate, 'rgb(255, 255, 255)', 'translate-and-send looks like the send button (white round button)');
      const same = await page.evaluate(() => { const pick = id => { const el = document.getElementById(id), cs = getComputedStyle(el), box = el.getBoundingClientRect(); return { w: box.width, h: box.height, radius: cs.borderTopLeftRadius, bg: cs.backgroundColor, color: cs.color, border: cs.borderTopWidth, icon: el.querySelector('svg').innerHTML }; }; const aa = document.querySelector('#h5-translate-button .h5-aa'), box = document.getElementById('h5-translate-button').getBoundingClientRect(), ab = aa.getBoundingClientRect(); return { send: pick('h5-translate-send'), translate: pick('h5-translate-button'), aa: aa.textContent, inside: ab.left >= box.left && ab.right <= box.right && ab.top >= box.top && ab.bottom <= box.bottom, sendAa: document.querySelectorAll('#h5-translate-send .h5-aa').length }; });
      assert.deepEqual(same.translate, same.send, 'translate-and-send has the same size, shape, colours, border and send icon as the send button');
      assert.deepEqual([same.aa, same.inside, same.sendAa], ['Aa', true, 0], 'only translate-and-send has the small Aa mark, inside the button');
      assert.ok(parseFloat(looks.sendRadius) >= 20, 'the send arrow is round');
      assert.ok(active.root.width > 250 && active.root.left >= 0 && active.root.right <= 390, 'the box takes the full width');
      assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('h5-translate')).borderTopLeftRadius), '22px', 'the box has the 22px outer radius');
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.h5-translate-input')).borderTopLeftRadius), '16px', 'the textarea radius is the outer radius minus the 6px padding');
      // The terminal is moved, not resized: same box, same element height, same rows, no resize message; it only moves up.
      assert.equal(active.term, rest.term, 'the terminal box keeps its height');
      assert.equal(active.xterm.height, rest.xterm.height, 'the terminal element keeps its height');
      assert.equal(active.rows, rest.rows, 'the terminal keeps its rows');
      assert.equal(active.resizes, rest.resizes, `no resize message for showing the box (${rest.resizes} before, ${active.resizes} after)`);
      assert.ok(active.xterm.top <= rest.xterm.top - 30, `the terminal moves up (${rest.xterm.top} to ${active.xterm.top})`);
      assert.ok(active.screenBottom <= active.area.top + 1, 'the last terminal row stays visible above the draft box and the keys');
      await page.waitForTimeout(300);
      assert.equal((await barRects()).resizes, active.resizes, 'no resize loop after showing the box');
      // Typing still grows the box from one to two lines while focused.
      await page.locator('#h5-translate-input').focus(); await page.locator('#h5-translate-input').fill('a long sentence that does not fit on a single line of the narrow phone box, so it wraps');
      const grown = await barRects();
      assert.ok(grown.input.height > active.input.height + 10, 'focused: the box still grows to two lines');
      assert.ok(Math.abs(grown.voice.top - active.voice.top) <= 1, 'the buttons stay on the bottom row');
      assert.equal(grown.term, active.term, 'the terminal box keeps its height as the box grows');
      assert.equal(grown.resizes, rest.resizes, 'no resize message while the box grows');
      assert.ok(grown.xterm.top < active.xterm.top, 'the terminal moves further up as the box grows');
      assert.ok(grown.screenBottom <= grown.area.top + 1, 'the last row stays visible above the two-line bar');
      await page.locator('#h5-translate-input').focus(); await page.locator('#h5-translate-input').fill('');
      // A press on the voice button keeps the focus in the box (no blur between pointerdown and click), so the layout does not collapse.
      await page.evaluate(() => {
        window.blurCount = 0;
        document.getElementById('h5-translate-input').addEventListener('blur', () => { window.blurCount++; });
      });
      const voiceBox = await page.locator('#h5-voice').boundingBox();
      await page.mouse.move(voiceBox.x + voiceBox.width / 2, voiceBox.y + voiceBox.height / 2);
      await page.mouse.down();
      const pressed = await barRects();
      assert.equal(pressed.focused, 'h5-translate-input', 'pressing the voice button keeps the focus in the box');
      assert.ok(Math.abs(pressed.voice.top - active.voice.top) <= 1, 'pressing voice does not collapse the layout');
      await page.mouse.up();
      await page.waitForTimeout(600);
      assert.equal(await page.evaluate(() => window.blurCount), 0, 'the box was not blurred by the voice press');
      assert.equal((await barRects()).focused, 'h5-translate-input');
      // Blur hides the box again (no delay); the terminal moves back down.
      await page.locator('#h5-translate-input').blur();
      const back = await barRects();
      assert.equal(back.form.height, 0, 'blur hides the draft box');
      assert.equal(back.term, rest.term);
      assert.equal(back.resizes, rest.resizes, 'no resize message after blur either');
      assert.ok(Math.abs(back.xterm.top - rest.xterm.top) <= 1, 'the terminal moves back down');
      assert.equal(await page.locator('[data-action="draft"]').getAttribute('aria-pressed'), 'false');
      // The draft key is a toggle: a second tap closes the keyboard and hides the box.
      await openDraft();
      await page.locator('[data-action="draft"]').tap();
      assert.equal((await barRects()).form.height, 0, 'a second tap on the draft key hides the box');
      // The animation: right after the box shows, the terminal is still on its way (not reduced motion); with reduced motion the switch is instant.
      const mid = await page.evaluate(async () => {
        document.getElementById('h5-translate-input').focus();
        await new Promise(resolve => requestAnimationFrame(resolve));
        return { animations: document.getAnimations().length, moving: !!document.querySelector('.h5-bar-moving'), xtermTransform: getComputedStyle(document.querySelector('.h5-xterm:not([hidden])')).transform };
      });
      assert.ok(mid.animations > 0 && mid.moving, 'the bar and the terminal move with an animation');
      const during = await barRects();
      assert.equal(during.resizes, rest.resizes, 'no resize message during or after the animation');
      assert.ok(Math.abs(during.xterm.top - active.xterm.top) <= 1, 'the terminal ends where the shown layout wants it');
      await page.locator('#h5-translate-input').blur();
      await barRects();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const instant = await page.evaluate(() => {
        document.getElementById('h5-translate-input').focus();
        return { animations: document.getAnimations().length, moving: !!document.querySelector('.h5-bar-moving'),
          top: document.querySelector('.h5-xterm:not([hidden])').getBoundingClientRect().top, form: document.getElementById('h5-translate').getBoundingClientRect().top };
      });
      assert.equal(instant.animations, 0, 'reduced motion: no animation');
      assert.ok(Math.abs(instant.top - active.xterm.top) <= 1, 'reduced motion: the terminal moves at once');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      assert.equal((await barRects()).resizes, rest.resizes);
    }

    // The saved commands menu: Paste text, then the presets of the terminal kind (a plain shell here; the Claude / Codex lists are checked in test-h5-pc-browser.cjs); a preset command is typed WITHOUT Enter.
    {
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await barSettled();
      const restForm = await page.evaluate(() => document.getElementById('h5-translate').getBoundingClientRect().height);
      const resizesBefore = await page.evaluate(() => window.sockets[0].sent.filter(item => { try { return JSON.parse(item).type === 'resize'; } catch { return false; } }).length);
      const sentBefore = (await sent()).length;
      await page.locator('#h5-commands').tap();
      assert.equal(await page.locator('#h5-translate').isVisible(), false, 'the saved commands menu does not open the draft box');
      assert.equal(await page.locator('.h5-add-menu [role="menuitem"]').first().textContent(), 'Paste text', 'Paste text is the first item');
      assert.deepEqual(await page.locator('.h5-add-menu .h5-add-menu-head').allTextContents(), ['Start an agent'], 'a plain terminal shows the shell list');
      const commands = await page.locator('.h5-add-menu .h5-add-menu-command').allTextContents();
      assert.deepEqual(commands, ['claude', 'claude --continue', 'claude --resume', 'codex', 'codex resume', 'git status'], 'the menu lists the commands that start an agent');
      await page.locator('.h5-add-menu [role="menuitem"]', { hasText: 'git status' }).tap();
      await page.waitForFunction(count => window.sockets[0].sent.filter(item => !item.startsWith('{')).length > count, sentBefore);
      const typedAfter = (await sent()).slice(sentBefore);
      assert.deepEqual(typedAfter, ['git status'], 'a preset is typed into the terminal without Enter');
      assert.equal(await page.locator('.h5-add-menu').count(), 0, 'the menu closes after a command is chosen');
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      // A tap outside closes the menu, and so does Escape.
      await page.locator('#h5-commands').tap();
      assert.equal(await page.locator('.h5-add-menu').count(), 1);
      await page.locator('.h5-terminal').tap({ position: { x: 20, y: 20 } });
      assert.equal(await page.locator('.h5-add-menu').count(), 0, 'a tap outside closes the menu');
      await page.evaluate(() => document.activeElement && document.activeElement.blur()); // the focused terminal cursor blinks forever
      await openDraft(); // the add button lives in the draft box
      await page.locator('#h5-commands').tap();
      await page.locator('#h5-commands').tap();
      assert.equal(await page.locator('.h5-add-menu').count(), 0, 'a second tap on the saved commands button closes the menu');
      await barSettled();
      const resizesAfter = await page.evaluate(() => window.sockets[0].sent.filter(item => { try { return JSON.parse(item).type === 'resize'; } catch { return false; } }).length);
      assert.equal(resizesAfter, resizesBefore, 'opening and closing the menu sends no resize');
    }

    // Translate box height: one line when empty, then it grows with the text and shows ALL of it (1, 2, 5, 12 lines) without inner scroll, up to a cap of half the
    // visible viewport; beyond the cap it scrolls inside. It shrinks back when lines are deleted, and a send gives one line again.
    {
      const input = page.locator('#h5-translate-input');
      const box = async () => { await barSettled(); return page.evaluate(() => {
        const el = document.getElementById('h5-translate-input');
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const term = document.getElementById('h5-terminal').getBoundingClientRect();
        const send = document.getElementById('h5-translate-send').getBoundingClientRect();
        const voice = document.getElementById('h5-voice').getBoundingClientRect();
        const resizes = window.sockets[0].sent.filter(item => { try { return JSON.parse(item).type === 'resize'; } catch { return false; } }).length;
        return { height: rect.height, bottom: rect.bottom, line: parseFloat(style.lineHeight), pad: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
          overflowY: style.overflowY, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, viewport: window.visualViewport.height,
          screenBottom: document.querySelector('#h5-terminal .h5-xterm:not([hidden]) .xterm-screen').getBoundingClientRect().bottom, areaTop: document.getElementById('h5-bottom').getBoundingClientRect().top, termHeight: term.height, sendBottom: send.bottom, voiceBottom: voice.bottom, resizes, placeholder: el.placeholder };
      }); };
      await input.focus(); // fill() focuses the box anyway: measure the active layout throughout
      const one = await box();
      assert.ok(Math.abs(one.height - (one.line + one.pad)) <= 2, `one line when empty (${one.height}px)`);
      await input.focus(); await input.fill('short');
      assert.ok(Math.abs((await box()).height - one.height) <= 1, 'short text stays on one line');
      await input.focus(); await input.fill('a long sentence that does not fit on a single line of the narrow phone box, so it wraps');
      const two = await box();
      assert.ok(Math.abs(two.height - (2 * two.line + two.pad)) <= 2, `two lines for text that needs two (${two.height}px)`);
      assert.ok(Math.abs(two.bottom - one.bottom) <= 1, 'the box grows upward, its bottom stays');
      assert.equal(two.termHeight, one.termHeight, 'the terminal box keeps its height as the box grows (it is moved, not resized)');
      assert.ok(two.sendBottom >= two.bottom && Math.abs(two.voiceBottom - one.voiceBottom) <= 1 && Math.abs(two.sendBottom - one.sendBottom) <= 1, 'the buttons stay on the bottom row');
      const noInnerScroll = state => state.scrollHeight <= state.clientHeight + 1 && state.overflowY !== 'auto';
      assert.ok(noInnerScroll(two), 'two lines: everything is shown, no inner scroll');
      const lines = n => Array.from({ length: n }, (_, i) => `row ${i + 1}`).join('\n');
      let previous = two;
      for (const n of [5, 12]) {
        await input.focus(); await input.fill(lines(n));
        const grownBox = await box();
        assert.ok(Math.abs(grownBox.height - (n * grownBox.line + grownBox.pad)) <= 3, `${n} lines are all shown (${grownBox.height}px)`);
        assert.ok(noInnerScroll(grownBox), `${n} lines: no inner scroll`);
        assert.ok(grownBox.height > previous.height + 10, `${n} lines: taller than before`);
        assert.equal(grownBox.termHeight, one.termHeight, `${n} lines: the terminal box keeps its height`);
        assert.equal(grownBox.resizes, one.resizes, `${n} lines: no resize message`);
        assert.ok(grownBox.screenBottom <= grownBox.areaTop + 1, `${n} lines: the last terminal row stays above the bar`);
        previous = grownBox;
      }
      // Deleting lines shrinks the box again.
      await input.focus(); await input.fill(lines(2));
      const shrunk = await box();
      assert.ok(Math.abs(shrunk.height - (2 * shrunk.line + shrunk.pad)) <= 3 && noInnerScroll(shrunk), `shrinks back after deleting lines (${shrunk.height}px)`);
      assert.ok(shrunk.screenBottom <= shrunk.areaTop + 1, 'the last terminal row stays above the bar after shrinking');
      // Beyond the cap (half of the visible viewport) the box stops growing and scrolls inside.
      await input.focus(); await input.fill(lines(80));
      const many = await box();
      assert.ok(many.height <= many.viewport * 0.5 + 1 && many.height >= many.viewport * 0.5 - many.line - 2, `the cap is about half of the viewport (${many.height}px of ${many.viewport}px)`);
      assert.equal(many.overflowY, 'auto', 'beyond the cap the text scrolls inside the box');
      assert.ok(many.scrollHeight > many.clientHeight + 10, 'beyond the cap there is more text than is shown');
      assert.equal(many.termHeight, one.termHeight, 'at the cap the terminal box keeps its height');
      assert.equal(many.resizes, one.resizes, 'at the cap no resize message');
      assert.ok(many.sendBottom >= many.bottom && Math.abs(many.voiceBottom - one.voiceBottom) <= 1, 'at the cap the buttons stay on the bottom row');
      await page.waitForTimeout(700);
      const settled = await box();
      await page.waitForTimeout(700);
      assert.equal((await box()).resizes, settled.resizes, 'no terminal resize loop after the box changed');
      assert.ok(settled.termHeight > 100, 'the terminal still has room');
      await input.focus(); await input.fill('');
      const cleared = await box();
      assert.ok(Math.abs(cleared.height - one.height) <= 1, 'back to one line when cleared');
      assert.equal(cleared.termHeight, one.termHeight);
      assert.equal(await input.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'the placeholder stays on one line');
    }

    // Keyboard dismissed: the box goes back to ONE line and the bar to the resting pill, the text is kept, no resize message; focusing again shows everything.
    {
      const input = page.locator('#h5-translate-input');
      const text = 'a long sentence that does not fit on a single line of the narrow phone box, so it wraps';
      const state = async () => { await barSettled(); return page.evaluate(() => {
        const el = document.getElementById('h5-translate-input');
        const style = getComputedStyle(el);
        const form = document.getElementById('h5-translate').getBoundingClientRect();
        return { height: el.getBoundingClientRect().height, line: parseFloat(style.lineHeight), pad: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom), value: el.value, focused: document.activeElement === el,
          formHeight: form.height, extra: document.getElementById('h5-bottom').style.getPropertyValue('--h5-bar-extra'), termTransform: document.getElementById('h5-terminal').firstElementChild?.style.transform || '',
          resizes: window.sockets[0].sent.filter(item => { try { return JSON.parse(item).type === 'resize'; } catch { return false; } }).length };
      }); };
      const vp = page.viewportSize();
      await input.focus();
      await input.focus(); await input.fill(text);
      const open = await state();
      assert.ok(Math.abs(open.height - (2 * open.line + open.pad)) <= 2, `all (two) lines while typing (${open.height}px)`);
      // 1) blur (the keyboard hide button, or focus moving away): the default state is back in the SAME tick, nothing waits for a timer or the viewport.
      const sync = await page.evaluate(() => {
        const el = document.getElementById('h5-translate-input');
        const read = () => ({ height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight), pad: parseFloat(getComputedStyle(el).paddingTop) + parseFloat(getComputedStyle(el).paddingBottom),
          form: document.getElementById('h5-translate').getBoundingClientRect().height, extra: document.getElementById('h5-bottom').style.getPropertyValue('--h5-bar-extra'),
          transform: document.getElementById('h5-terminal').firstElementChild?.style.transform || '' });
        const before = read();
        el.blur();
        return { before, after: read() };
      });
      assert.ok(Math.abs(sync.after.height - (sync.after.line + sync.after.pad)) <= 2, `one line in the same tick as the blur (${sync.after.height}px)`);
      assert.ok(sync.after.form < sync.before.form - 10, 'the bar is the resting pill in the same tick as the blur');
      assert.equal(sync.after.extra, '0px', 'the bar overlap is reset in the same tick');
      assert.ok(!sync.after.transform || parseFloat(sync.after.transform.replace(/[^0-9.-]/g, '')) >= parseFloat(sync.before.transform.replace(/[^0-9.-]/g, '') || '0'), 'the terminal shift is released in the same tick');
      const blurred = await state();
      assert.ok(Math.abs(blurred.height - (blurred.line + blurred.pad)) <= 2, `one line after blur (${blurred.height}px)`);
      assert.equal(blurred.value, text, 'the text is kept');
      assert.ok(blurred.formHeight < open.formHeight - 10, 'the bar is back to the resting pill');
      assert.equal(blurred.resizes, open.resizes, 'no resize message');
      await input.focus();
      assert.ok(Math.abs((await state()).height - open.height) <= 2, 'all lines again on focus');
      // 2) the keyboard goes away without a blur (Android back button): the viewport returns to full height while the box stays focused
      await page.setViewportSize({ width: vp.width, height: vp.height - 300 });
      await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--h5-height') !== '', null, { timeout: 3000 });
      await page.waitForTimeout(300);
      assert.equal((await state()).focused, true, 'the box is focused while the keyboard is up');
      await page.setViewportSize(vp);
      await page.waitForFunction(() => window.visualViewport.height >= innerHeight - 1, null, { timeout: 3000 });
      const lag = Date.now();
      await page.waitForFunction(() => document.activeElement !== document.getElementById('h5-translate-input'), null, { timeout: 4000 });
      assert.ok(Date.now() - lag < 250, `the box is blurred right after the viewport is back, no 350 ms timer (${Date.now() - lag} ms)`);
      const closed = await state();
      assert.ok(Math.abs(closed.height - (closed.line + closed.pad)) <= 2, `one line after the keyboard went away (${closed.height}px)`);
      assert.equal(closed.value, text, 'the text is kept');
      assert.equal(closed.resizes, open.resizes, 'no resize message when the keyboard comes and goes');
      await input.focus();
      assert.ok(Math.abs((await state()).height - open.height) <= 2, 'two lines again on focus after that');
      // 3) a tap on a bar button while the box is focused keeps the focus and the click
      await input.blur();
      await input.focus(); await input.fill('');
    }

    // The key presses above are trusted hardware keydowns, so the page has noticed a hardware keyboard (entry.jsx `hasKeyboard`). The send checks below are
    // about a phone with only the on-screen keyboard, so that flag is cleared for them (with a keyboard, a send focuses the terminal instead; see test-h5-pc-browser.cjs).
    assert.equal(await page.evaluate(() => window.H5UI.get().hasKeyboard), true, 'a trusted keydown with the full viewport counts as a hardware keyboard');
    await page.evaluate(() => window.H5UI.set({ hasKeyboard: false }));
    // Translate and send: control characters are stripped and Enter follows separately.
    const restResizes = await page.evaluate(() => window.sockets[0].sent.filter(item => { try { return JSON.parse(item).type === 'resize'; } catch { return false; } }).length);
    await page.locator('#h5-translate-input').focus(); await page.locator('#h5-translate-input').fill('run the tests, and please make the text long enough that the box grows to two lines on the phone');
    await page.locator('#h5-translate-input').blur();
    await page.evaluate(() => document.getElementById('h5-translate-input').focus()); // the bar is still animating when the tap lands
    await page.locator('#h5-translate-button').tap();
    await page.waitForFunction(() => window.sockets[0].sent.includes('\r'));
    assert.deepEqual((await sent()).slice(-2), ['Run the tests [2J', '\r'], 'ESC is removed, so no escape sequence reaches the shell');
    assert.equal(await page.locator('#h5-translate-input').inputValue(), '');
    {
      const afterSend = await page.locator('#h5-translate-input').evaluate(el => ({ height: el.getBoundingClientRect().height, inline: el.style.height }));
      assert.ok(afterSend.height < 50 && afterSend.inline === '', `one line again after a send (${afterSend.height}px)`);
      // After a send the keyboard is dismissed: the box is blurred (and hidden at once), the terminal is not focused, no keyboard key stays pressed, nothing is resized.
      assert.notEqual(await page.evaluate(() => document.activeElement && document.activeElement.id), 'h5-translate-input', 'the box is blurred after a send');
      assert.equal(await page.evaluate(() => document.querySelector('.h5-xterm:not([hidden])').contains(document.activeElement)), false, 'the terminal is not focused after a send');
      assert.equal(await page.evaluate(() => document.getElementById('h5-translate').getBoundingClientRect().height), 0, 'the box is hidden right after a send');
      assert.equal(await page.evaluate(() => document.getElementById('h5-bottom').style.getPropertyValue('--h5-bar-extra') || '0px'), '0px', 'nothing is covered any more');
      for (const action of ['keyboard', 'draft']) assert.equal(await page.locator(`#h5-actions [data-action="${action}"]`).getAttribute('aria-pressed'), 'false', `${action} key is reset after a send`);
      assert.equal(await page.evaluate(() => window.sockets[0].sent.filter(item => { try { return JSON.parse(item).type === 'resize'; } catch { return false; } }).length), restResizes, 'a send resizes nothing');
    }

    // The send arrow sends the text as typed: no translate request, nothing trimmed or joined; only invisible control characters (ESC) are dropped; one Enter.
    // Line breaks are carriage returns; with bracketed paste on, text with a line break or a tab is one paste.
    {
      const input = page.locator('#h5-translate-input');
      const requests = translateRequests.length;
      const returns = () => page.evaluate(() => window.sockets[0].sent.filter(item => item === '\r').length);
      let before = await returns();
      await input.focus(); await input.fill('ls -la\u001b[2J \n  second   line');
      await page.locator('#h5-translate-send').tap();
      await page.waitForFunction(count => window.sockets[0].sent.filter(item => item === '\r').length > count, before);
      assert.deepEqual((await sent()).slice(-2), ['ls -la[2J \r  second   line', '\r'], 'as typed: ESC dropped, spaces and the line break kept, one Enter');
      assert.equal(translateRequests.length, requests, 'the send arrow makes no translate request');
      assert.equal(await input.inputValue(), '');
      await page.evaluate(() => window.sockets[0].emit('\x1b[?2004h'));
      await page.waitForTimeout(100);
      before = await returns();
      await input.focus(); await input.fill('one\ntwo');
      await page.locator('#h5-translate-send').tap();
      await page.waitForFunction(count => window.sockets[0].sent.filter(item => item === '\r').length > count, before);
      assert.deepEqual((await sent()).slice(-2), ['\x1b[200~one\rtwo\x1b[201~', '\r'], 'as typed with bracketed paste: one paste, one Enter');
      assert.equal(translateRequests.length, requests, 'still no translate request');
      // No limit on what can be typed: 50,000 characters with CJK, emoji, tabs, blank lines and indentation reach the terminal in full, in one paste.
      assert.equal(await input.getAttribute('maxlength'), null, 'the box has no length cap');
      const unit = '\u4f60\u597d \u{1F600}\u{1F44D}\u{1F3FD}\tcol\n\n    indented line\n';
      const huge = unit.repeat(Math.ceil(50_000 / unit.length)).slice(0, 50_000);
      before = await returns();
      await input.focus(); await input.fill(huge.slice(0, 5000)); // typed through the browser's editing (Playwright's insertText is very slow with thousands of lines)
      assert.equal(await input.inputValue(), huge.slice(0, 5000), 'CJK, emoji, tabs, blank lines and indentation are kept as typed');
      await input.evaluate((el, text) => { el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })); }, huge); // the rest as one long paste
      assert.equal((await input.inputValue()).length, 50_000, 'the box keeps all 50,000 characters');
      await page.locator('#h5-translate-send').tap();
      await page.waitForFunction(count => window.sockets[0].sent.filter(item => item === '\r').length > count, before);
      assert.deepEqual((await sent()).slice(-2), [`\x1b[200~${huge.replace(/\n/g, '\r')}\x1b[201~`, '\r'], 'every character is sent as typed, in one paste');
      assert.equal(await input.inputValue(), '');
      assert.equal(translateRequests.length, requests, 'still no translate request');
      await page.evaluate(() => window.sockets[0].emit('\x1b[?2004l'));
      // The box stays editable while a translation runs; only the sent text leaves the box, what was typed meanwhile stays, with the keyboard.
      before = await returns();
      await input.focus(); await input.fill('SLOW first');
      await page.locator('#h5-translate-button').tap();
      await page.waitForFunction(() => document.getElementById('h5-translate-input').classList.contains('translating') || document.querySelector('.h5-translate-input.translating'));
      assert.equal(await input.evaluate(el => el.readOnly), false, 'not read-only while translating');
      await input.press('End'); await page.keyboard.type(' and more');
      assert.equal(await input.inputValue(), 'SLOW first and more', 'typing works during the translation');
      await page.waitForFunction(count => window.sockets[0].sent.filter(item => item === '\r').length > count, before);
      assert.deepEqual((await sent()).slice(-2), ['Slow done', '\r']);
      assert.equal(await input.inputValue(), ' and more', 'what was typed during the translation stays in the box');
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'h5-translate-input', 'the keyboard stays while text is left');
      await input.fill('');
      // A failed translation sends nothing and keeps the text in the box.
      const sentBefore = (await sent()).length;
      await input.focus(); await input.fill('FAIL please');
      await page.locator('#h5-translate-button').tap();
      await page.waitForFunction(count => window.sockets[0].sent.length >= 0 && document.getElementById('h5-translate-send').disabled === false, 0);
      await page.waitForTimeout(300);
      assert.equal(translateRequests.at(-1), 'FAIL please');
      assert.equal((await sent()).length, sentBefore, 'a failed translation sends nothing');
      assert.equal(await input.inputValue(), 'FAIL please', 'the text stays in the box');
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'h5-translate-input', 'a failed translation keeps the keyboard (the box keeps the focus)');
      assert.ok(await page.evaluate(() => document.getElementById('h5-translate').getBoundingClientRect().height) > 0, 'a failed translation keeps the box shown');
      await input.fill(''); // an empty send does nothing: no message, no blur
      await page.locator('#h5-translate-send').tap();
      await page.waitForTimeout(200);
      assert.equal((await sent()).length, sentBefore, 'an empty send sends nothing');
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'h5-translate-input', 'an empty send keeps the focus');
      await input.fill('FAIL please');
      await input.focus(); await input.fill('');
      await input.blur();
    }

    // The on-screen Return is a new line in the box and never sends (the viewport is made shorter, as an open on-screen keyboard does); a hardware Enter is below.
    // Several lines reach the terminal as one paste (or joined, see below).
    {
      const input = page.locator('#h5-translate-input');
      const requests = translateRequests.length;
      const inputs = (await sent()).length;
      const oneLine = await input.evaluate(el => el.getBoundingClientRect().height);
      await input.focus();
      assert.equal(await input.getAttribute('enterkeyhint'), 'enter', 'the on-screen Enter key is a new-line key');
      const fullSize = page.viewportSize();
      await page.setViewportSize({ width: fullSize.width, height: fullSize.height - 300 });
      // Wait for the page's own resize handler (it sets --h5-height and notes the open keyboard), not only for the browser's viewport.
      await page.waitForFunction(height => window.visualViewport.height <= height && parseInt(getComputedStyle(document.documentElement).getPropertyValue('--h5-height'), 10) <= height, fullSize.height - 300);
      await page.waitForTimeout(100);
      await page.keyboard.type('MULTI one');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type('two');
      assert.equal(await input.inputValue(), 'MULTI one\n\ntwo', 'Enter and Shift+Enter both insert a new line');
      await barSettled();
      const grown = await input.evaluate(el => ({ height: el.getBoundingClientRect().height, overflowY: getComputedStyle(el).overflowY }));
      assert.ok(grown.height > oneLine + 10, `the box grows after new lines (${oneLine} to ${grown.height})`);
      await page.keyboard.press('Enter');
      await page.keyboard.type('three');
      await page.keyboard.press('Enter');
      await page.keyboard.type('four');
      await barSettled();
      const many = await input.evaluate(el => ({ height: el.getBoundingClientRect().height, overflowY: getComputedStyle(el).overflowY }));
      assert.ok(many.height > grown.height + 15 && many.overflowY !== 'auto', 'five lines from Enter are all shown, no inner scroll');
      assert.equal(translateRequests.length, requests, 'Enter sends no translate request');
      assert.equal((await sent()).length, inputs, 'Enter writes nothing to the terminal');
      // Enter that confirms an IME composition neither sends nor adds a line.
      const before = await input.inputValue();
      await input.evaluate(el => {
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
        el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
      });
      assert.equal(await input.inputValue(), before, 'an IME Enter adds no new line');
      assert.equal(translateRequests.length, requests, 'an IME Enter sends nothing');
      await page.setViewportSize(fullSize); // the on-screen keyboard goes away
      // A late resize handler would blur the box again (the keyboard went away), so wait for it before focusing.
      await page.waitForFunction(height => window.visualViewport.height >= height && parseInt(getComputedStyle(document.documentElement).getPropertyValue('--h5-height'), 10) >= height, fullSize.height);
      await page.waitForTimeout(100);
      await input.focus(); await input.fill('MULTI one\n\ntwo');
      // Without bracketed paste the lines are joined, so a shell cannot run them one by one.
      await page.locator('#h5-translate-button').tap();
      await page.waitForFunction(count => window.sockets[0].sent.filter(item => item === '\r').length > count, (await sent()).filter(item => item === '\r').length);
      assert.equal(translateRequests.at(-1), 'MULTI one\n\ntwo', 'the request keeps the line breaks');
      assert.deepEqual((await sent()).slice(-2), ['First line Second line [2J', '\r'], 'no bracketed paste: the lines are joined into one');
      assert.equal(translateRequests.length, requests + 1, 'one click sends once');
      assert.equal(await input.inputValue(), '');
      // With bracketed paste mode on, the lines go in as ONE paste (Claude Code accepts it); line breaks are carriage returns inside the markers.
      await page.evaluate(() => window.sockets[0].emit('\x1b[?2004h'));
      await page.waitForTimeout(100);
      const returns = (await sent()).filter(item => item === '\r').length;
      await input.focus(); await input.fill('MULTI one\n\ntwo');
      await page.locator('#h5-translate-button').tap();
      await page.waitForFunction(count => window.sockets[0].sent.filter(item => item === '\r').length > count, returns);
      assert.deepEqual((await sent()).slice(-2), ['\x1b[200~First line\r\rSecond line [2J\x1b[201~', '\r'], 'bracketed paste: one paste, then a single Enter');
      assert.equal(await input.inputValue(), '');
      // A long translation on ONE line is one paste too: sent as keys, the PTY splits it into ~1 KB reads and Claude Code turned the first read into a
      // "[Pasted text #1]" chip and typed the rest, so the message seemed to start in the middle of a word.
      const longLine = `${'word '.repeat(300)}end [2J`;
      const sendAndWait = async (button, text) => {
        const count = (await sent()).filter(item => item === '\r').length;
        await input.focus(); await input.fill(text);
        await page.locator(button).tap();
        await page.waitForFunction(before => window.sockets[0].sent.filter(item => item === '\r').length > before, count);
        return (await sent()).slice(-2);
      };
      assert.deepEqual(await sendAndWait('#h5-translate-button', 'LONG one line'), [`\x1b[200~${longLine}\x1b[201~`, '\r'], 'a long one-line translation is one bracketed paste, without ESC');
      const typedLong = `${'typed '.repeat(60)}\u001b[2Jend`;
      assert.deepEqual(await sendAndWait('#h5-translate-send', typedLong), [`\x1b[200~${typedLong.replace('\u001b', '')}\x1b[201~`, '\r'], 'a long typed line is one bracketed paste, without ESC');
      assert.deepEqual(await sendAndWait('#h5-translate-send', '/compact'), ['/compact', '\r'], 'a short typed line is still typed as keys (a slash command keeps working)');
      await page.evaluate(() => window.sockets[0].emit('\x1b[?2004l'));
      await page.waitForTimeout(100);
      assert.deepEqual(await sendAndWait('#h5-translate-button', 'LONG one line'), [longLine, '\r'], 'without bracketed paste a long translation is typed as keys, as before');
      await page.evaluate(() => window.sockets[0].emit('\x1b[?2004h'));
      await page.waitForTimeout(100);
      await page.evaluate(() => window.sockets[0].emit('\x1b[?2004l'));
      await input.blur();
    }

    // Hardware keyboard keys in the draft box (the viewport is at its full height): Enter is translate-and-send, Option+Enter (Alt+Enter) is the send arrow, and neither
    // inserts a new line; Cmd+Enter is a new line and an IME Enter does nothing. scripts/test-h5-enter-keys-browser.cjs covers these keys in detail.
    {
      const input = page.locator('#h5-translate-input');
      const returns = () => page.evaluate(() => window.sockets[0].sent.filter(item => item === '\r').length);
      assert.match(await page.locator('#h5-translate-button').getAttribute('title'), /\((↩|Enter)\)$/, 'the translate tooltip names its shortcut');
      assert.match(await page.locator('#h5-translate-send').getAttribute('title'), /\((⌥↩|Alt\+Enter)\)$/, 'the send tooltip names its shortcut');
      for (const combo of ['Enter']) {
        const requests = translateRequests.length;
        const before = await returns();
        await input.focus(); await input.fill('shortcut please');
        await page.keyboard.press(combo);
        await page.waitForFunction(count => window.sockets[0].sent.filter(item => item === '\r').length > count, before);
        assert.equal(translateRequests.length, requests + 1, `${combo} makes one translate request`);
        assert.equal(translateRequests.at(-1), 'shortcut please', `${combo} translates the text without a new line`);
        assert.deepEqual((await sent()).slice(-2), ['Run the tests [2J', '\r'], `${combo} sends the translation, then Enter`);
        assert.equal(await input.inputValue(), '', `${combo} clears the box`);
        assert.notEqual(await page.evaluate(() => document.activeElement && document.activeElement.id), 'h5-translate-input', `${combo} dismisses the keyboard like the button`);
      }
      {
        const requests = translateRequests.length;
        const before = await returns();
        await input.focus(); await input.fill('echo  typed');
        await page.keyboard.press('Alt+Enter');
        await page.waitForFunction(count => window.sockets[0].sent.filter(item => item === '\r').length > count, before);
        assert.deepEqual((await sent()).slice(-2), ['echo  typed', '\r'], 'Option+Enter sends as typed, with no new line added');
        assert.equal(translateRequests.length, requests, 'Option+Enter makes no translate request');
        assert.equal(await input.inputValue(), '');
      }
      {
        const requests = translateRequests.length;
        const inputs = (await sent()).length;
        await input.focus(); await input.fill('FAIL shortcut');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.getElementById('h5-translate-send').disabled === false);
        await page.waitForTimeout(300);
        assert.equal(translateRequests.length, requests + 1);
        assert.equal((await sent()).length, inputs, 'a failed shortcut translation sends nothing');
        assert.equal(await input.inputValue(), 'FAIL shortcut', 'and keeps the text, with no new line');
        await input.fill('');
        await page.keyboard.press('Alt+Enter'); await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
        assert.equal((await sent()).length, inputs, 'an empty box sends nothing by shortcut');
        assert.equal(translateRequests.length, requests + 1, 'an empty box makes no translate request');
        await page.keyboard.type('line'); await page.keyboard.press('Meta+Enter');
        assert.equal(await input.inputValue(), 'line\n', 'Cmd+Enter is a new line');
        for (const extra of [{ metaKey: true }, { altKey: true }, { ctrlKey: true }]) {
          const value = await input.evaluate((el, mods) => {
            const event = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true, ...mods });
            el.dispatchEvent(event);
            return { value: el.value, prevented: event.defaultPrevented };
          }, extra);
          assert.deepEqual(value, { value: 'line\n', prevented: false }, `a composing Enter with ${Object.keys(extra)[0]} is left alone`);
        }
        await page.waitForTimeout(200);
        assert.equal((await sent()).length, inputs, 'a composing shortcut sends nothing');
        assert.equal(translateRequests.length, requests + 1, 'a composing shortcut makes no translate request');
        await input.fill('');
        await input.blur();
      }
    }

    // Image upload: the link is typed into the terminal with a trailing space and no Enter.
    // iOS WebKit (a Home Screen web app above all) opens the photo picker only for a tap that lands on the file input itself: a script `input.click()` on a
    // hidden input, run from the click handler of another, pointer-captured button, is ignored there without any error. Chromium would open the picker anyway,
    // so the test checks the conditions WebKit needs: the finger hits a real, rendered file input, no script click opens it and the press is not captured.
    {
      const hit = await page.evaluate(() => {
        const box = document.getElementById('h5-image').getBoundingClientRect();
        const el = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        const style = el && getComputedStyle(el);
        return { tag: el && el.tagName, type: el && el.type, id: el && el.id, display: style && style.display, visibility: style && style.visibility, events: style && style.pointerEvents, insideButton: Boolean(el && el.closest('#h5-image')) };
      });
      assert.deepEqual(hit, { tag: 'INPUT', type: 'file', id: 'h5-image-picker', display: 'block', visibility: 'visible', events: 'auto', insideButton: true }, 'a tap on Upload image lands on the file input itself');
      await page.evaluate(() => {
        window.scriptClicks = 0; window.captures = [];
        const click = HTMLInputElement.prototype.click;
        HTMLInputElement.prototype.click = function () { if (this.type === 'file') window.scriptClicks += 1; return click.call(this); };
        const capture = Element.prototype.setPointerCapture;
        Element.prototype.setPointerCapture = function (id) { window.captures.push(this.id || this.tagName); return capture.call(this, id); };
      });
    }
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#h5-image').tap()]);
    assert.equal(await page.evaluate(() => window.scriptClicks), 0, 'the picker opens from the tap itself, not from a script click');
    assert.deepEqual(await page.evaluate(() => window.captures.filter(id => /h5-image|LABEL|INPUT/.test(id))), [], 'the image press is not pointer-captured');
    await chooser.setFiles({ name: 'shot.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') });
    await page.waitForFunction(() => window.sockets[0].sent.includes('https://img.test/shot.png '));
    await page.locator('.h5-upload-overlay').waitFor({ state: 'detached' }); // the dialog fades out
    assert.equal(await page.locator('.h5-upload-overlay').count(), 0);
    assert.equal(ossUploads.length, 1, 'the image went to OSS from the browser');
    assert.ok(ossUploads[0].includes('\x89PNG'));
    assert.notEqual((await sent()).at(-1), '\r');

    // A pasted image (paste event on the terminal input) is uploaded the same way; nothing else reaches the shell.
    const linkCount = () => page.evaluate(() => window.sockets[0].sent.filter(item => item === 'https://img.test/shot.png ').length);
    const sentBefore = (await sent()).length;
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'clip.png', { type: 'image/png' }));
      document.querySelector('.h5-xterm:not([hidden]) textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => window.sockets[0].sent.filter(item => item === 'https://img.test/shot.png ').length === 2);
    assert.equal(await linkCount(), 2);
    assert.equal(ossUploads.length, 2, 'the pasted image went to OSS from the browser');
    assert.equal((await sent()).length, sentBefore + 1, 'only the link was typed');

    // Any other file: the picker accepts every type, the file goes up as a download and its link is typed the same way.
    assert.equal(await page.locator('#h5-image-picker').getAttribute('accept'), null, 'the picker accepts any file');
    assert.equal(await page.locator('#h5-image').getAttribute('aria-label'), 'Upload image or file');
    const [fileChooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#h5-image').tap()]);
    await fileChooser.setFiles({ name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n') });
    await page.waitForFunction(() => window.sockets[0].sent.includes('https://img.test/notes.pdf '));
    await page.locator('.h5-upload-overlay').waitFor({ state: 'detached' });
    assert.equal(ossUploads.length, 3, 'the file went to OSS from the browser');
    assert.ok(ossUploads[2].includes('attachment; filename="notes.pdf"') && ossUploads[2].includes('%PDF-1.7'));
    assert.equal(ossPolicies.at(-1).kind, 'file');
    assert.notEqual((await sent()).at(-1), '\r', 'no Enter after the file link');

    // The wheel strip on the right edge is a scrollbar: a thumb in the normal buffer, a spring in the alternate buffer; a drag on the
    // terminal body makes no wheel events. The touches are PointerEvents fired inside the page and the waits are the page's own timers
    // (CDP touches arrive one per rendered frame, and headless Chromium draws slowly while the display sleeps).
    const strip = page.locator('#h5-wheel');
    assert.equal(await strip.count(), 1, 'the terminal has one wheel strip');
    await page.evaluate(() => {
      window.__wfire = (type, y, id = 77) => {
        const el = document.querySelector('#h5-wheel');
        const box = el.getBoundingClientRect();
        el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true, clientX: box.left + box.width / 2, clientY: y }));
      };
      window.__wsleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      // A drag in steps of at most 10 px, with a pause between the steps (ms), without pointerdown / pointerup.
      window.__wmove = async (from, to, gap = 0, id = 77) => {
        const step = from < to ? 10 : -10;
        for (let y = from + step; step > 0 ? y < to : y > to; y += step) { window.__wfire('pointermove', y, id); if (gap) await window.__wsleep(gap); }
        window.__wfire('pointermove', to, id);
      };
    });
    const bar = () => page.evaluate(() => {
      const el = document.querySelector('#h5-wheel');
      const box = el.getBoundingClientRect();
      const thumb = el.querySelector('.h5-wheel-thumb').getBoundingClientRect();
      const viewport = document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport');
      return { mode: el.dataset.mode, top: box.top, bottom: box.bottom, height: box.height, thumbTop: thumb.top - box.top, thumbHeight: thumb.height, thumbY: thumb.top + thumb.height / 2,
        now: Number(el.getAttribute('aria-valuenow')), max: Number(el.getAttribute('aria-valuemax')), rows: document.querySelectorAll('.h5-xterm:not([hidden]) .xterm-rows > div').length,
        atBottom: viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 1, visibility: getComputedStyle(el).visibility, pointerEvents: getComputedStyle(el).pointerEvents,
        ariaHidden: el.getAttribute('aria-hidden'), thumbColor: getComputedStyle(el.querySelector('.h5-wheel-thumb')).backgroundColor };
    });
    const lastCols = () => page.evaluate(() => window.sockets[0].sent.map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(item => item?.type === 'resize').pop()?.cols);
    const screenWidth = () => page.evaluate(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-screen').getBoundingClientRect().width);
    const rowsText = () => page.locator('.h5-xterm:not([hidden]) .xterm-rows').textContent();

    // No history yet: nothing is drawn and touches go through.
    await page.evaluate(() => window.sockets[0].emit('\x1b[?1049l\x1b[?1000l\x1b[H\x1b[2J\x1b[3J'));
    await page.waitForFunction(() => document.querySelector('#h5-wheel').dataset.mode === 'none');
    const idle = await page.evaluate(() => {
      const el = document.querySelector('#h5-wheel');
      const box = el.getBoundingClientRect();
      const area = document.querySelector('#h5-terminal').getBoundingClientRect();
      return { bg: getComputedStyle(el).backgroundColor, touchAction: getComputedStyle(el).touchAction, bottomGap: Math.abs(area.bottom - box.bottom), rightGap: area.right - box.right, width: box.width,
        role: el.getAttribute('role'), label: el.getAttribute('aria-label'), orientation: el.getAttribute('aria-orientation') };
    });
    assert.equal(idle.bg, 'rgba(0, 0, 0, 0)', 'the strip has no background of its own');
    assert.equal(idle.touchAction, 'none');
    assert.ok(idle.bottomGap <= 1, `the wheel strip reaches the bottom of the terminal area (${idle.bottomGap}px short)`);
    assert.ok(Math.abs(idle.rightGap - 2) <= 0.5, `the strip sits 2px in from the screen edge (${idle.rightGap}px)`);
    assert.ok(idle.width >= 36 && idle.width <= 48, 'the strip is about 40px wide');
    assert.deepEqual([idle.role, idle.label, idle.orientation], ['scrollbar', 'Scroll', 'vertical'], 'the strip is a vertical scrollbar named Scroll');
    assert.equal(await page.locator('[data-copy], #h5-scroll, .h5-scroll').count(), 0, 'the floating copy button is gone');
    {
      const none = await bar();
      assert.deepEqual([none.visibility, none.pointerEvents, none.ariaHidden], ['hidden', 'none', 'true'], 'without scrollback the strip is hidden and lets touches through');
    }
    const cols0 = await lastCols();
    const width0 = await screenWidth();

    // Normal buffer with history: the thumb size is rows / (rows + scrollback) and it sits at the bottom.
    await page.evaluate(() => window.sockets[0].emit(Array.from({ length: 200 }, (_, i) => 'line ' + i).join('\r\n')));
    await page.waitForFunction(() => document.querySelector('#h5-wheel').dataset.mode === 'bar' && Number(document.querySelector('#h5-wheel').getAttribute('aria-valuemax')) > 0);
    let b = await bar();
    assert.equal(b.visibility, 'visible', 'the bar shows when there is scrollback');
    assert.equal(b.ariaHidden, null);
    assert.equal(b.max, 200 - b.rows, `aria-valuemax is the scrollback in use (${b.max}, ${b.rows} rows)`);
    assert.equal(b.now, b.max, 'the view is at the bottom');
    const thumbSize = Math.max(32, Math.round(b.height * b.rows / (b.rows + b.max)));
    assert.ok(Math.abs(b.thumbHeight - thumbSize) <= 1, `the thumb size follows the buffer (${b.thumbHeight} vs ${thumbSize})`);
    assert.ok(Math.abs(b.thumbTop + b.thumbHeight - b.height) <= 1, 'the thumb sits at the bottom of the track');
    assert.equal(await lastCols(), cols0, 'the visible bar does not take terminal columns');
    assert.equal(await screenWidth(), width0, 'the terminal keeps its width with the bar shown');
    const idleColor = b.thumbColor;

    // Dragging the thumb: up = older (viewportY goes down), down = newer, and the thumb stays under the finger (1:1, not a speed wheel).
    const bottomText = await rowsText();
    const grabY = b.top + b.thumbTop + b.thumbHeight / 2;
    await page.evaluate(y => window.__wfire('pointerdown', y), grabY);
    assert.equal(await page.evaluate(() => document.querySelector('#h5-wheel').classList.contains('active')), true, 'the strip is active while touched');
    await page.waitForFunction(idle => getComputedStyle(document.querySelector('#h5-wheel .h5-wheel-thumb')).backgroundColor === 'rgba(255, 255, 255, 0.62)', idleColor, { timeout: 2000 }).catch(() => assert.fail('the thumb is brighter while touched'));
    const ups = [];
    for (let y = grabY - 60; y > b.top + b.thumbHeight / 2 + 2; y -= 60) {
      await page.evaluate(({ from, to }) => window.__wmove(from, to), { from: y + 60, to: y });
      const now = await bar();
      ups.push(now.now);
      assert.ok(Math.abs(now.thumbY - y) <= 1 + now.height / now.max, `the thumb follows the finger (${now.thumbY.toFixed(1)} vs ${y.toFixed(1)})`);
    }
    assert.ok(ups.length >= 3 && ups.every((value, i) => value < (i ? ups[i - 1] : b.max)), `dragging up shows older output step by step (${ups.join(',')})`);
    await page.evaluate(y => window.__wmove(y, y - 400), ups.length ? b.top + b.thumbHeight / 2 : b.top);
    b = await bar();
    assert.equal(b.now, 0, 'dragged to the top, the view shows the oldest line');
    await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-rows').textContent.startsWith('line 0'), null, { timeout: 3000 }).catch(() => assert.fail('the first line is at the top'));
    assert.ok(b.thumbTop <= 0.5, 'the thumb is at the top of the track');
    await page.evaluate(({ from, to }) => window.__wmove(from, to), { from: b.top, to: b.top + (b.height - b.thumbHeight) / 2 + b.thumbHeight / 2 });
    b = await bar();
    assert.ok(Math.abs(b.now - b.max / 2) <= 2, `half way down the track is half way through the history (${b.now} of ${b.max})`);
    await page.evaluate(({ from, to }) => window.__wmove(from, to), { from: b.thumbY, to: b.bottom + 100 });
    b = await bar();
    assert.equal(b.now, b.max, 'dragging down brings the newest output back');
    await page.waitForFunction(text => document.querySelector('.h5-xterm:not([hidden]) .xterm-rows').textContent === text, bottomText, { timeout: 3000 }).catch(() => assert.fail('the newest rows are drawn again'));
    await page.evaluate(y => window.__wfire('pointerup', y), b.bottom + 100);
    await page.waitForFunction(() => !document.querySelector('#h5-wheel').classList.contains('active'), null, { timeout: 3000 });
    await page.waitForFunction(idle => getComputedStyle(document.querySelector('#h5-wheel .h5-wheel-thumb')).backgroundColor === idle, idleColor, { timeout: 2000 }).catch(() => assert.fail('the thumb dims again after release'));

    // A tap on the track above the thumb is one page up, below it one page down; a tap on the thumb goes through to the terminal.
    const stripTap = y => page.evaluate(y => { window.__wfire('pointerdown', y); window.__wfire('pointerup', y); }, y);
    await stripTap(b.top + 20);
    b = await bar();
    assert.equal(b.now, b.max - (b.rows - 1), 'a tap above the thumb scrolls one page up (xterm pages by rows - 1)');
    await stripTap(b.bottom - 4);
    b = await bar();
    assert.equal(b.now, b.max, 'a tap below the thumb scrolls one page down');
    await page.evaluate(() => { window.__tapClicks = 0; document.querySelector('.h5-xterm:not([hidden])').addEventListener('click', () => { window.__tapClicks++; }); });
    await stripTap(b.thumbY);
    assert.ok(await page.evaluate(() => window.__tapClicks) >= 1, 'a tap on the thumb reaches the terminal under it');
    assert.equal((await bar()).now, b.max, 'a tap on the thumb does not scroll');

    // The thumb follows scrolling done elsewhere: a native scroll of the body, and new output (at the bottom it stays at the bottom).
    await page.evaluate(() => { document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport').scrollTop = 0; });
    await page.waitForFunction(() => document.querySelector('#h5-wheel').getAttribute('aria-valuenow') === '0');
    b = await bar();
    assert.ok(b.thumbTop <= 0.5, 'a native scroll to the top moves the thumb to the top');
    const max0 = b.max;
    await page.evaluate(() => window.sockets[0].emit('\r\n' + Array.from({ length: 100 }, (_, i) => 'more ' + i).join('\r\n')));
    await page.waitForFunction(max => Number(document.querySelector('#h5-wheel').getAttribute('aria-valuemax')) === max + 100, max0);
    b = await bar();
    assert.equal(b.now, 0, 'new output does not move a view that was scrolled up');
    assert.ok(b.thumbHeight < thumbSize || b.thumbHeight === 32, 'the thumb gets smaller as the history grows');
    await page.evaluate(() => { const viewport = document.querySelector('.h5-xterm:not([hidden]) .xterm-viewport'); viewport.scrollTop = viewport.scrollHeight; });
    await page.waitForFunction(() => { const el = document.querySelector('#h5-wheel'); return el.getAttribute('aria-valuenow') === el.getAttribute('aria-valuemax'); });
    await page.evaluate(() => window.sockets[0].emit('\r\n' + Array.from({ length: 50 }, (_, i) => 'tail ' + i).join('\r\n')));
    await page.waitForFunction(max => Number(document.querySelector('#h5-wheel').getAttribute('aria-valuemax')) === max + 150, max0);
    b = await bar();
    assert.equal(b.now, b.max, 'at the bottom, new output keeps the view and the thumb at the bottom');
    assert.ok(Math.abs(b.thumbTop + b.thumbHeight - b.height) <= 1, 'the thumb is drawn at the bottom after new output');
    if (process.env.H5_SHOT_DIR) {
      await stripTap(b.top + 20); // a page up, so the thumb is not at an edge
      await page.evaluate(() => { const el = document.querySelector('#h5-wheel'); el.classList.remove('active'); });
      await page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, 'h5-wheel-bar.png') });
      await stripTap((await bar()).bottom - 4);
    }

    // A thumb drag that meets a switch to the alternate screen becomes the spring (the buffer type is read on every move).
    const wheels = () => page.evaluate(() => window.sockets[0].sent.filter(item => /^\x1b\[<6[45];/.test(item)).map(item => item.slice(3, 5)));
    await page.evaluate(() => window.sockets[0].emit('\x1b[?1000h\x1b[?1006h'));
    b = await bar();
    const midBefore = (await wheels()).length;
    await page.evaluate(y => { window.__wfire('pointerdown', y); window.__wfire('pointermove', y - 20); }, b.thumbY);
    await page.evaluate(() => window.sockets[0].emit('\x1b[?1049h'));
    await page.waitForFunction(() => document.querySelector('#h5-wheel').dataset.mode === 'spring');
    await page.evaluate(async y => { await window.__wmove(y - 20, y + 80); }, b.thumbY);
    await page.waitForFunction(before => window.sockets[0].sent.filter(item => /^\x1b\[<6[45];/.test(item)).length > before, midBefore, { timeout: 8000 }).catch(() => {});
    await page.evaluate(y => window.__wfire('pointerup', y + 80), b.thumbY);
    const mid = (await wheels()).slice(midBefore);
    assert.ok(mid.length > 0 && mid.every(code => code === '65'), `after a switch to the alternate screen, pulling down sends wheel-down reports (${mid.join(',')})`);
    await page.waitForFunction(() => !window.__h5WheelSpring());

    // Alternate buffer: the thumb is a spring in the middle with chevrons; pull down = newer (wheel down), pull up = older (wheel up),
    // faster the further it is pulled; released, it springs back and stops.
    await page.evaluate(() => window.sockets[0].emit('\x1b[2J\x1b[Hfull screen app'));
    await page.waitForFunction(() => !document.querySelector('#h5-wheel').classList.contains('active'), null, { timeout: 3000 });
    const spring = await page.evaluate(() => {
      const el = document.querySelector('#h5-wheel');
      const box = el.getBoundingClientRect();
      const thumb = el.querySelector('.h5-wheel-thumb').getBoundingClientRect();
      const chevrons = [...el.querySelectorAll('.h5-wheel-chevron')].map(node => ({ display: getComputedStyle(node).display, y: node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2 }));
      return { mode: el.dataset.mode, middle: box.top + box.height / 2, thumbY: thumb.top + thumb.height / 2, now: el.getAttribute('aria-valuenow'), chevrons };
    });
    assert.equal(spring.mode, 'spring');
    assert.ok(Math.abs(spring.thumbY - spring.middle) <= 1, 'the spring thumb rests in the middle');
    assert.equal(spring.now, '50', 'the spring reports the middle of its range');
    assert.deepEqual(spring.chevrons.map(item => item.display), ['block', 'block'], 'the spring shows its chevrons');
    assert.ok(spring.chevrons[0].y < spring.thumbY && spring.chevrons[1].y > spring.thumbY, 'one chevron above the thumb, one below');
    if (process.env.H5_SHOT_DIR) await page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, 'h5-wheel-spring.png') });
    const pull = async (by, ms) => {
      const before = (await wheels()).length;
      const offset = await page.evaluate(async ({ y, by, ms }) => {
        window.__wfire('pointerdown', y);
        await window.__wmove(y, y + by);
        await window.__wsleep(ms);
        const value = document.querySelector('#h5-wheel').style.getPropertyValue('--h5-spring-offset');
        window.__wfire('pointerup', y + by);
        return value;
      }, { y: spring.middle, by, ms });
      return { codes: (await wheels()).slice(before), offset };
    };
    const down = await pull(100, 500);
    assert.ok(down.codes.length >= 3 && down.codes.every(code => code === '65'), `pulling the spring down sends wheel-down reports (newer) (${down.codes.join(',')})`);
    assert.equal(down.offset, '100px', 'the spring thumb follows the pull');
    assert.equal(await page.evaluate(() => document.querySelector('#h5-wheel').style.getPropertyValue('--h5-spring-offset')), '0px', 'released, the thumb springs back to the middle');
    assert.equal(await page.evaluate(() => window.__h5WheelSpring()), false, 'released, the spring stops');
    const stopped = (await wheels()).length;
    await page.evaluate(() => window.__wsleep(300));
    assert.equal((await wheels()).length, stopped, 'nothing is sent after the release');
    const up = await pull(-100, 500);
    assert.ok(up.codes.length >= 3 && up.codes.every(code => code === '64'), `pulling the spring up sends wheel-up reports (older) (${up.codes.join(',')})`);
    const near = await pull(30, 600);
    const far = await pull(200, 600);
    assert.ok(far.codes.length > near.codes.length * 2, `a longer pull scrolls faster (${near.codes.length} vs ${far.codes.length} in the same time)`);
    const dead = await pull(4, 400);
    assert.equal(dead.codes.length, 0, 'a pull inside the dead zone does not scroll');
    // A tap on the spring is handed to the element under it (a link of the program stays clickable).
    await page.evaluate(() => { window.__tapClicks = 0; });
    await stripTap(spring.middle - 150);
    assert.ok(await page.evaluate(() => window.__tapClicks) >= 1, 'a tap on the spring reaches the terminal under it');

    // A drag on the terminal body sends no wheel reports.
    const cdp = await context.newCDPSession(page);
    const bodyDrag = async (x, from, to) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from }] });
      await page.waitForTimeout(50);
      for (let y = from; y !== to; y += from < to ? 20 : -20) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }); await page.waitForTimeout(16); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const afterStrip = (await wheels()).length;
    await bodyDrag(150, 300, 500);
    await bodyDrag(150, 500, 300);
    await page.waitForTimeout(100);
    assert.equal((await wheels()).length, afterStrip, 'dragging the terminal body sends no wheel reports');

    // The terminal's textarea never asks for the system keyboard, whatever the visual viewport does (Android back button, a viewport change): the terminal
    // keyboard is the page's own and stays until its key is tapped again.
    const vp = page.viewportSize();
    await page.locator('[data-action="keyboard"]').tap();
    await page.locator('#h5-osk').waitFor();
    await page.setViewportSize({ width: vp.width, height: vp.height - 300 });
    await page.waitForFunction(height => innerHeight === height, vp.height - 300);
    assert.equal(await inputmode(), 'none');
    await page.setViewportSize(vp);
    await page.waitForFunction(height => innerHeight === height, vp.height);
    assert.equal(await page.locator('#h5-osk').count(), 1, 'a viewport change does not hide the terminal keyboard');
    await page.locator('.h5-xterm:not([hidden])').tap();
    assert.equal(await inputmode(), 'none', 'a terminal tap does not ask for the system keyboard');
    await page.locator('[data-action="keyboard"]').tap();
    await page.locator('#h5-osk').waitFor({ state: 'detached' });

    // The terminal has no floating up/down buttons: scrolling is by the wheel strip.
    assert.equal(await page.locator('[data-scroll]').count(), 0, 'no scroll buttons are drawn');

    // A new terminal is a phone terminal and gets its own connection.
    await page.locator('#h5-open-tasks').tap();
    assert.deepEqual(await page.locator('#h5-tasks .h5-terminal-main .h5-terminal-name').allTextContents(), ['Terminal 1'], 'the selected task lists its terminals under it');
    assert.equal(await page.locator('#h5-tasks .h5-terminal-main[aria-current="true"] .h5-terminal-name').textContent(), 'Terminal 1');
    assert.equal(await page.locator('#h5-terminal-tabs').count(), 0, 'there is no tab strip above the terminal any more');
    // A task has no selected look: the open task's row is painted like the others (the current session row below it still is).
    assert.deepEqual(await page.evaluate(() => {
      const bg = node => getComputedStyle(node).backgroundColor;
      const rows = [...document.querySelectorAll('#h5-tasks .h5-task-item')];
      return { selectedClass: rows.some(node => node.classList.contains('Mui-selected')), colors: [...new Set(rows.map(node => bg(node) + '|' + bg(node.parentElement)))].length };
    }), { selectedClass: false, colors: 1 }, 'no task row looks selected');
    assert.equal(await page.locator('#h5-tasks .h5-task-add').count(), await page.locator('#h5-tasks .h5-task-item').count(), 'every task has the "+" button');
    // Measured in one step: the task list re-renders when the sheet opens and would replace the row between two separate reads.
    await page.locator('#h5-tasks .h5-task-row:has(.h5-task-item[aria-current="true"]) .h5-task-add').waitFor();
    const atEnd = await page.evaluate(() => {
      const row = document.querySelector('#h5-tasks .h5-task-row:has(.h5-task-item[aria-current="true"])').getBoundingClientRect();
      const add = document.querySelector('#h5-tasks .h5-task-row:has(.h5-task-item[aria-current="true"]) .h5-task-add').getBoundingClientRect();
      return add.x + add.width > row.x + row.width - 2;
    });
    assert.ok(atEnd, 'the "+" sits at the right end of the task row');
    await page.locator('#h5-tasks .h5-task-row:has(.h5-task-item[aria-current="true"]) .h5-task-add').tap();
    assert.deepEqual(await page.locator('#h5-term-menu-actions button').allTextContents(), ['New Terminal', 'Claude session', 'Codex session'], 'the "+" opens the Session menu');
    // The optional name field above the Session lists: placeholder, limit, the name stays when moving between the lists, and Enter creates.
    const nameField = page.locator('#h5-new-name-input');
    assert.equal(await nameField.getAttribute('placeholder'), 'Name (optional)');
    assert.equal(await nameField.getAttribute('maxlength'), '40');
    assert.equal(await nameField.inputValue(), '', 'the name starts empty');
    assert.notEqual(await page.evaluate(() => document.activeElement && document.activeElement.id), 'h5-new-name-input', 'the field is not focused on its own (no keyboard pops up)');
    await nameField.fill('  \u8bc4\u5ba1  \u{1F680} ');
    // The name stays while moving between the lists.
    await page.locator('#h5-term-menu-actions button', { hasText: 'Claude session' }).tap();
    await page.locator('#h5-term-menu-actions button', { hasText: 'New Claude session' }).waitFor();
    assert.equal(await nameField.inputValue(), '  \u8bc4\u5ba1  \u{1F680} ', 'the name is kept in the sub-list');
    await page.locator('#h5-term-menu-actions button', { hasText: 'Back' }).tap();
    await page.locator('#h5-term-menu-actions button', { hasText: 'New Terminal' }).waitFor();
    assert.equal(await nameField.inputValue(), '  \u8bc4\u5ba1  \u{1F680} ', 'and after Back');
    // The task sheet does not create or list chats; a notification link still opens one, a conversation view over the terminal.
    chats.push({ id: 'c1', agent: 'claude', session_id: null, title: 'New chat', mode: 'ask', running: false, opened: { web: null, h5: null } });
    await page.goto(`${ORIGIN}/h5?openChat=1:c1`);
    await page.locator('#h5-agent .agent-chat').waitFor();
    await page.locator('#h5-tasks').waitFor({ state: 'hidden' }); // opening a chat closes the task sheet
    await page.locator('#h5-agent .ac-bubble', { hasText: 'hello agent' }).waitFor();
    // The chat shows the same header as the terminal (task name and settings) and starts right below it.
    assert.equal(await page.locator('#h5-agent .ac-head').isVisible(), false, 'the chat has no header of its own');
    assert.equal(await page.locator('#h5-close-chat').count(), 0, 'and no back button');
    assert.equal(await page.locator('.h5-header').isVisible(), true);
    const [headBox, chatBox] = await Promise.all([page.locator('.h5-header').boundingBox(), page.locator('#h5-agent').boundingBox()]);
    assert.equal(Math.round(chatBox.y), Math.round(headBox.y + headBox.height), 'the chat starts below the header');
    assert.equal(await page.locator('.h5-header').evaluate(el => el === document.elementFromPoint(el.getBoundingClientRect().x + 20, el.getBoundingClientRect().y + 20) || el.contains(document.elementFromPoint(el.getBoundingClientRect().x + 20, el.getBoundingClientRect().y + 20))), true, 'the header is not covered by the chat');
    assert.equal(await page.locator('#h5-agent .ac-text strong').textContent(), 'there');
    // The Material UI drawer reveals the conversation's left edge on the right without resizing it.
    await page.locator('#h5-open-tasks').tap();
    await page.waitForTimeout(400);
    const drawer = await page.locator('#h5-tasks > .h5-sheet-panel').boundingBox();
    const shiftedChat = await page.locator('#h5-agent').boundingBox();
    assert.ok(drawer.width > 390 * .7 && drawer.width < 390 * .85, 'the sidebar leaves room for the conversation');
    assert.ok(Math.abs(shiftedChat.x - drawer.width) < 1, 'the conversation begins at the sidebar edge');
    assert.ok(Math.abs(shiftedChat.width - chatBox.width) < 1, 'and keeps its original width');
    assert.equal(await page.locator('#h5-agent').getAttribute('aria-hidden'), 'true', 'it is hidden from assistive technology while the drawer is open');
    assert.equal(await page.locator('#h5-agent').evaluate(node => node.inert), true);
    await page.screenshot({ path: '/tmp/t-agent-sidebar-open.png' });
    await page.locator('#h5-task-backdrop').tap({ position: { x: 375, y: 400 } });
    await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#h5-agent').getAttribute('aria-hidden'), null);
    assert.equal(await page.locator('#h5-agent').evaluate(node => node.inert), false);
    assert.equal(await page.locator('#h5-open-tasks').getAttribute('aria-expanded'), 'false');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('h5-agent')).transform === 'none');
    assert.equal(Math.round((await page.locator('#h5-agent').boundingBox()).x), 0);

    // A chat is not brought back by a refresh: the page comes back on its terminal, and nothing about the chat is kept in the browser.
    assert.equal(await page.evaluate(() => localStorage.getItem('h5-agent:local:1')), null, 'nothing about it is kept in the browser');
    assert.equal(await page.locator('#h5-session-name').textContent(), 'New chat', 'an open chat shows its own name');
    assert.equal(await headerHeight(), terminalHeader, 'the header keeps its height whatever the name is');
    // With a chat open no terminal row is highlighted; going to a terminal from the task sheet leaves the chat.
    await page.locator('#h5-open-tasks').tap();
    await page.locator('#h5-tasks .h5-terminal-main').first().waitFor();
    assert.equal(await page.locator('#h5-tasks .h5-terminal-main[aria-current="true"]').count(), 0, 'no terminal is current while the chat covers it');
    await page.locator('#h5-tasks .h5-terminal-row:not(:has(.h5-terminal-icon.claude, .h5-terminal-icon.codex)) .h5-terminal-main').first().tap();
    await page.locator('#h5-agent').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#h5-session-name').textContent(), 'Terminal 1', 'back on the terminal, its name');
    await page.locator('#h5-open-tasks').tap();
    await page.locator('#h5-tasks .h5-terminal-main[aria-current="true"]').waitFor();
    assert.equal(await page.locator('#h5-tasks .h5-terminal-main[aria-current="true"]').count(), 1, 'the terminal is current again');
    await page.goto(`${ORIGIN}/h5`);
    await page.locator('#h5-task-name', { hasText: 'Fix login' }).waitFor();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#h5-agent').isHidden(), true, 'a chat does not come back after a refresh');
    chats.length = 0;
    await page.locator('#h5-open-tasks').tap();
    await page.locator('#h5-tasks .h5-task-row:has(.h5-task-item[aria-current="true"]) .h5-task-add').tap();
    assert.equal(await page.locator('#h5-new-name-input').inputValue(), '', 'a new Session sheet starts with an empty name');
    await page.locator('#h5-term-menu-actions button', { hasText: 'New Terminal' }).tap();
    await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.sockets.length === 2);
    assert.ok(calls.includes('POST /api/tasks/1/terminals'));
    assert.deepEqual(createBodies[createBodies.length - 1], {}, 'no name: the terminal keeps its default name');
    assert.equal(await page.evaluate(() => new URL(window.sockets[1].url).searchParams.get('terminalId')), 'h5-second');
    assert.equal(await page.evaluate(() => window.sockets[0].readyState), 1, 'the previous terminal stays connected, hidden (recent terminals are kept warm)');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.h5-xterm').length - document.querySelectorAll('.h5-xterm:not([hidden])').length), 1);

    // The on-screen keyboard shrinks the viewport: the terminal keeps its size (no resize, so no redraw) and is shifted up instead.
    const termInfo = () => page.evaluate(() => {
      const box = document.getElementById('h5-terminal').getBoundingClientRect();
      const term = document.querySelector('.h5-xterm:not([hidden])').getBoundingClientRect();
      const resizes = window.sockets[1].sent.filter(item => { try { return JSON.parse(item).type === 'resize'; } catch { return false; } }).length;
      return { boxTop: box.top, boxBottom: box.bottom, top: term.top, bottom: term.bottom, height: term.height, resizes };
    });
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.evaluate(() => window.sockets[1].emit(JSON.stringify({ type: 'history', data: '\x1b[?1049hfull screen app\x1b[30;1H', cols: 40, rows: 30 })));
    await page.waitForTimeout(200);
    const closed = await termInfo();
    await page.setViewportSize({ width: 390, height: 844 - 330 });
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#h5-keys').isVisible(), true, 'the function keys stay visible while the keyboard is open');
    assert.equal(await page.locator('#h5-translate').isVisible(), false, 'the draft box stays hidden until the draft keyboard key focuses it');
    const open = await termInfo();
    assert.equal(open.resizes, closed.resizes, 'opening the keyboard sends no resize to the terminal');
    assert.ok(Math.abs(open.height - closed.height) < 1, 'the terminal keeps its height');
    assert.ok(open.top < open.boxTop, 'the top rows are shifted out of view');
    assert.ok(Math.abs(open.bottom - open.boxBottom) <= 3, 'the bottom rows stay visible above the keys');
    // A cursor near the top (a shell prompt) must not be pushed out of view: the shift is capped by the cursor row.
    await page.evaluate(() => window.sockets[1].emit('\x1b[1;1H'));
    await page.waitForTimeout(200);
    const prompt = await termInfo();
    assert.equal(prompt.resizes, closed.resizes, 'moving the cursor sends no resize');
    assert.ok(prompt.top >= prompt.boxTop - 1, 'the top row with the cursor stays in view');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#h5-keys').isVisible(), true, 'the function keys are still shown after the keyboard closes');
    const back = await termInfo();
    assert.equal(back.resizes, closed.resizes, 'closing the keyboard sends no resize either');
    assert.ok(Math.abs(back.top - closed.top) < 1 && Math.abs(back.bottom - closed.bottom) < 1, 'the terminal returns to its place');

    // iOS can miss the last resize event while focus moves to the translate box: the page must still follow the visible height.
    await page.setViewportSize({ width: 390, height: 844 - 330 });
    await page.waitForTimeout(300);
    // A stale height, as if the event was missed. Set and read in one evaluate: the page's 500 ms keyboard timer
    // (fitViewport) may run between two evaluates and fix the height before the test reads it.
    assert.equal(await page.evaluate(() => {
      document.documentElement.style.setProperty('--h5-height', '300px');
      return document.querySelector('.h5-app').getBoundingClientRect().height;
    }), 300);
    await page.locator('#h5-translate-input').focus();
    await page.waitForFunction(() => Math.abs(document.querySelector('.h5-app').getBoundingClientRect().height - window.visualViewport.height) <= 1, null, { timeout: 3000 });
    {
      // Keyboard open and the bar grown over the terminal: still no resize, same element height, one combined shift, last rows above the bar.
      await page.evaluate(() => window.sockets[1].emit('\x1b[999;1H')); // the cursor on the last row (the terminal has more than 30 rows), so the full shift applies
      await page.waitForTimeout(100);
      await barSettled();
      const formTop = () => page.evaluate(() => document.getElementById('h5-bottom').getBoundingClientRect().top); // the keys and the bar together
      const withBar = await termInfo();
      assert.equal(withBar.resizes, closed.resizes, 'keyboard open and the bar grown: no resize message');
      assert.ok(Math.abs(withBar.height - closed.height) < 1, 'keyboard open and the bar grown: the terminal keeps its height');
      assert.ok(withBar.bottom <= (await formTop()) + 3, 'the bottom rows stay above the grown bar while the keyboard is open');
      assert.ok(withBar.bottom >= (await formTop()) - 40, 'the terminal is not shifted further than needed');
      await page.locator('#h5-translate-input').focus(); await page.locator('#h5-translate-input').fill('a long sentence that does not fit on a single line of the narrow phone box, so it wraps');
      await barSettled();
      const twoLines = await termInfo();
      assert.equal(twoLines.resizes, closed.resizes, 'two lines with the keyboard open: no resize message');
      assert.ok(Math.abs(twoLines.height - closed.height) < 1);
      assert.ok(twoLines.bottom <= (await formTop()) + 3, 'the bottom rows stay above the two-line bar');
      assert.ok(twoLines.top < withBar.top, 'the terminal moved further up');
      await page.locator('#h5-translate-input').focus(); await page.locator('#h5-translate-input').fill('');
      await page.evaluate(() => window.sockets[1].emit('\x1b[30;1H')); // back to the cursor row the later checks expect
    }
    await page.locator('#h5-translate-input').blur();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);

    // Copy text: the "Copy text" item of the terminal actions menu shows the terminal text in a selectable overlay (the long press is tested below).
    const openCopyFromMenu = async () => {
      await page.locator('#h5-open-tasks').tap();
      await page.locator('#h5-tasks .h5-terminal-main[aria-current="true"]').locator('xpath=..').locator('.h5-terminal-more').tap();
      await page.locator('#h5-session-menu [role="menuitem"]', { hasText: 'Copy text' }).tap();
      await page.locator('#h5-copy').waitFor({ state: 'visible' });
    };
    await page.evaluate(() => { navigator.clipboard.writeText = async text => { window.copied = text; }; });
    // A row as wide as the terminal must stay one line in the overlay (same font, no wrapping of its own).
    const termCols = await page.evaluate(() => window.sockets[1].sent.map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(item => item?.type === 'resize').pop().cols);
    await page.evaluate(width => window.sockets[1].emit(`\r\n${'x'.repeat(width)}`), termCols);
    await page.waitForTimeout(150);
    await openCopyFromMenu();
    const view = await page.locator('#h5-copy-text').evaluate(el => ({ white: getComputedStyle(el).whiteSpace, size: getComputedStyle(el).fontSize, over: el.scrollWidth - el.clientWidth }));
    assert.deepEqual({ white: view.white, size: view.size }, { white: 'pre', size: '11px' });
    assert.ok(view.over <= 0, `a full-width terminal row fits without scrolling sideways (${view.over}px over)`);
    assert.match(await page.locator('#h5-copy-text').textContent(), /full screen app/);
    assert.equal(await page.locator('#h5-copy-text').evaluate(el => getComputedStyle(el).userSelect), 'text');
    await page.locator('#h5-copy-all').tap();
    await page.waitForFunction(() => /full screen app/.test(window.copied || ''));
    // Search: Enter jumps to the match and marks it; the next press moves on and wraps around.
    await page.locator('#h5-copy-search').fill('full');
    await page.locator('#h5-copy-search').press('Enter');
    const marked = () => page.evaluate(() => (window.CSS?.highlights?.get('h5-copy-match') ? [...CSS.highlights.get('h5-copy-match')][0].toString() : String(getSelection())));
    assert.equal(await marked(), 'full', 'search marks the match');
    // Live refresh: new output reaches the open view without a reopen (debounced) and the scroll position follows the bottom.
    await page.evaluate(() => window.sockets[1].emit('\r\nlive refresh line'));
    await page.waitForFunction(() => /live refresh line/.test(document.querySelector('#h5-copy-text').textContent), null, { timeout: 3000 });
    // With a selection in the view the text is kept and a chip offers the refresh.
    await page.evaluate(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector('#h5-copy-text')); getSelection().removeAllRanges(); getSelection().addRange(range); });
    await page.evaluate(() => window.sockets[1].emit('\r\nheld back line'));
    await page.locator('#h5-copy-stale').waitFor({ state: 'visible', timeout: 3000 });
    assert.doesNotMatch(await page.locator('#h5-copy-text').textContent(), /held back line/, 'an active selection keeps the text');
    await page.locator('#h5-copy-stale').click();
    await page.waitForFunction(() => /held back line/.test(document.querySelector('#h5-copy-text').textContent));
    assert.equal(await page.locator('#h5-copy-stale').count(), 0);
    await page.locator('#h5-copy-close').tap();
    await page.locator('#h5-copy').waitFor({ state: 'hidden' });

    // A space in the last cell of a wrapped row is real text and must survive in the copy view.
    await page.evaluate(width => window.sockets[1].emit(`\r\n${'q'.repeat(width - 1)} WRAPTAIL`), termCols);
    await page.waitForTimeout(150);
    await openCopyFromMenu();
    assert.match(await page.locator('#h5-copy-text').textContent(), new RegExp(`q{${termCols - 1}} WRAPTAIL`), 'the space at the soft wrap is kept');
    await page.locator('#h5-copy-close').tap();
    await page.locator('#h5-copy').waitFor({ state: 'hidden' });

    // Long press on the terminal body opens the copy view; a press that moves does not.
    const touch = (type, x, y) => page.evaluate(([kind, px, py]) => {
      const target = document.querySelector('.h5-xterm:not([hidden]) .xterm-screen');
      const init = { bubbles: true, cancelable: true, clientX: px, clientY: py, pointerId: 7, pointerType: 'touch', isPrimary: true };
      target.dispatchEvent(new PointerEvent(kind, init));
    }, [type, x, y]);
    const screenBox = await page.locator('.h5-xterm:not([hidden]) .xterm-screen').boundingBox();
    await touch('pointerdown', screenBox.x + 50, screenBox.y + 100);
    await touch('pointermove', screenBox.x + 50, screenBox.y + 130);
    await page.waitForTimeout(700);
    assert.equal(await page.locator('#h5-copy').isVisible(), false, 'a moving press is a scroll, not a long press');
    await touch('pointerup', screenBox.x + 50, screenBox.y + 130);
    await touch('pointerdown', screenBox.x + 50, screenBox.y + 100);
    await page.waitForTimeout(700);
    await page.locator('#h5-copy').waitFor({ state: 'visible' });
    await touch('pointerup', screenBox.x + 50, screenBox.y + 100);
    await page.locator('#h5-copy-close').tap();
    await page.locator('#h5-copy').waitFor({ state: 'hidden' });

    // Double tap selects a word and triple tap a line and copies at once (copy on select, the same notice as a program copy, no bar);
    // new output clears the highlight; a program with mouse mode gets the taps instead.
    await page.evaluate(() => window.sockets[1].emit('\x1b[2J\x1b[Hhello world foo'));
    await page.waitForTimeout(150);
    const cell = { w: screenBox.width / termCols };
    const tap = async (col, count) => {
      await page.waitForTimeout(450); // the previous multi-tap is over
      for (let i = 0; i < count; i++) {
        await page.evaluate(([x, y]) => {
          const target = document.querySelector('.h5-xterm:not([hidden]) .xterm-screen');
          const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 8, pointerType: 'touch', isPrimary: true };
          target.dispatchEvent(new PointerEvent('pointerdown', init));
          target.dispatchEvent(new PointerEvent('pointerup', init));
          target.dispatchEvent(new MouseEvent('click', init));
        }, [screenBox.x + (col + 0.5) * cell.w, screenBox.y + 4]);
      }
    };
    const selected = () => page.evaluate(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-selection')?.children.length || 0);
    // Plain HTTP here: the copy uses the legacy copy command from a temporary field (terminal-clipboard.js); record what it copies.
    await page.evaluate(() => { document.execCommand = command => { if (command === 'copy') window.copied = document.activeElement.value; return command === 'copy'; }; });
    await page.evaluate(() => { window.copied = ''; });
    await tap(8, 2);
    await page.waitForFunction(() => window.copied === 'world', null, { timeout: 2000 });
    await page.getByText('Copied 5 characters').first().waitFor();
    assert.equal(await page.locator('#h5-clipboard-bar').count(), 0, 'no bar after the copy');
    await tap(8, 3);
    await page.waitForFunction(() => window.copied.trim() === 'hello world foo', null, { timeout: 2000 });
    assert.equal(await page.locator('#h5-clipboard-bar').count(), 0);
    await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-selection')?.children.length > 0);
    await page.evaluate(() => window.sockets[1].emit('x'));
    await page.waitForFunction(() => !document.querySelector('.h5-xterm:not([hidden]) .xterm-selection')?.children.length, null, { timeout: 2000 });
    await page.evaluate(() => window.sockets[1].emit('\x1b[?1000h'));
    await page.waitForTimeout(100);
    await page.evaluate(() => { window.copied = ''; });
    await tap(8, 2);
    await page.waitForTimeout(200);
    assert.equal(await selected(), 0, 'no selection while the program tracks the mouse');
    assert.equal(await page.evaluate(() => window.copied), '', 'and nothing copied');
    await page.evaluate(() => window.sockets[1].emit('\x1b[?1000l'));

    // Terminal actions: the "⋯" on a terminal row opens rename / reopen / restart / delete.
    await page.locator('#h5-open-tasks').tap();
    assert.deepEqual(await page.locator('#h5-tasks .h5-terminal-main .h5-terminal-name').allTextContents(), ['Terminal 1', 'Terminal 2']);
    const more = page.locator('#h5-tasks .h5-terminal-row').nth(1).locator('.h5-terminal-more');
    await more.tap();
    await page.locator('#h5-session-menu').waitFor({ state: 'visible' });
    assert.deepEqual(await page.locator('#h5-session-menu [role="menuitem"]').allTextContents(), ['Copy text', 'Rename', 'Reopen', 'Restart in the working directory', 'Delete'], 'the open terminal also offers Copy text');
    await page.locator('#h5-session-menu [role="menuitem"]', { hasText: 'Rename' }).tap();
    await page.locator('#h5-term-rename-input').fill('Build logs');
    await page.locator('#h5-term-rename button').tap(); // the field is in place of the row (the popup closed at "Rename"); Save does not blur it
    await page.locator('#h5-term-rename').waitFor({ state: 'detached' });
    assert.deepEqual(await page.locator('#h5-tasks .h5-terminal-main .h5-terminal-name').allTextContents(), ['Terminal 1', 'Build logs']);
    assert.ok(calls.includes('PATCH /api/tasks/1/terminals/h5-second'));
    // The first terminal can be deleted too.
    await page.locator('#h5-tasks .h5-terminal-row').nth(0).locator('.h5-terminal-more').tap();
    await page.locator('#h5-session-menu [role="menuitem"]', { hasText: 'Delete' }).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#h5-session-menu').waitFor({ state: 'detached' });
    // Delete the current terminal (after a confirmation): the phone falls back to the remaining one.
    const sentBodies = [];
    await page.route(`${ORIGIN}/api/tasks/1/terminal/control`, route => { sentBodies.push(route.request().postDataJSON()); return route.fulfill({ contentType: 'application/json', body: '{"success":true}' }); });
    page.once('dialog', dialog => dialog.dismiss());
    await more.tap();
    await page.locator('#h5-session-menu [role="menuitem"]', { hasText: 'Delete' }).tap();
    assert.equal(sentBodies.length, 0, 'declining the confirmation deletes nothing');
    await page.locator('#h5-session-menu').waitFor({ state: 'detached' }); // closed by choosing the item, whatever the answer
    await more.tap();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#h5-session-menu [role="menuitem"]', { hasText: 'Delete' }).tap();
    await page.waitForFunction(() => document.querySelectorAll('#h5-tasks .h5-terminal-main').length === 1);
    assert.deepEqual(sentBodies, [{ action: 'delete', terminal_id: 'h5-second' }]);
    await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId), 'h5-default');

    // A session of another task: a tap on that task lists its sessions (the task shown stays), and a tap on a session selects the task and goes there.
    await page.locator('#h5-open-tasks').tap();
    assert.equal(await page.locator('.h5-task-item', { hasText: 'Fix login' }).getAttribute('aria-expanded'), 'true', 'the sheet opens with the sessions of the task that is shown');
    await page.locator('.h5-task-item', { hasText: 'Write docs' }).tap();
    await page.locator('#h5-tasks .h5-terminal-list[aria-label="Write docs"] .h5-terminal-main', { hasText: 'Docs terminal' }).waitFor();
    assert.deepEqual(await page.locator('.h5-task-item').evaluateAll(nodes => nodes.map(node => [node.querySelector('.h5-task-title').textContent, node.getAttribute('aria-expanded')])), [['Fix login', 'true'], ['Write docs', 'true']], 'opening a second task does not close the first');
    // Collapse all and Expand all are in the header of the list.
    await page.locator('#h5-collapse-all').tap();
    assert.deepEqual(await page.locator('.h5-task-item').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-expanded'))), ['false', 'false'], 'collapse all');
    await page.locator('#h5-expand-all').tap();
    await page.locator('#h5-tasks .h5-terminal-list[aria-label="Write docs"] .h5-terminal-main', { hasText: 'Docs terminal' }).waitFor();
    assert.deepEqual(await page.locator('.h5-task-item').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-expanded'))), ['true', 'true'], 'expand all, with the sessions of the task that is not selected read');
    assert.equal(await page.locator('#h5-task-name').textContent(), 'Fix login', 'still on the same task');
    await page.locator('#h5-tasks .h5-terminal-list[aria-label="Write docs"] .h5-terminal-main', { hasText: 'Docs terminal' }).tap();
    await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#h5-task-name').textContent(), 'Write docs');
    assert.equal(await page.locator('#h5-session-name').textContent(), 'Docs terminal');
    await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId === 'h5-docs');

    // Settings: the gear at the bottom of the task sidebar opens a sheet with the language toggle and the PC one-click update; the header has no settings button.
    assert.equal(await page.locator('#h5-open-settings').count(), 0, 'the header has no settings button');
    // The Update button stands right of the refresh button; it opens a modal that checks, shows both versions, and offers the update.
    // Both boxes are read in one step (the activity counter can still move the row).
    await page.waitForFunction(() => {
      const refresh = document.getElementById('h5-refresh').getBoundingClientRect();
      const update = document.getElementById('h5-update').getBoundingClientRect();
      return update.left >= refresh.right - 1 && Math.abs(update.top - refresh.top) < 2 && Math.abs(update.width - refresh.width) < 1 && update.right <= innerWidth;
    }, null, { timeout: 5000 });
    await page.locator('#h5-update').click();
    await page.locator('#h5-update-dialog [role="dialog"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#h5-update-dialog [role="dialog"]').getAttribute('aria-modal'), 'true');
    assert.equal(await page.locator('#h5-update-dialog [role="dialog"]').getAttribute('aria-labelledby'), 'h5-update-title');
    await page.waitForFunction(() => document.getElementById('h5-update-latest') && document.getElementById('h5-update-latest').textContent === '1.0.1');
    assert.equal(await page.locator('#h5-update-current').textContent(), '1.0.0');
    assert.equal(await page.locator('#h5-update-now').count(), 1, 'the update action is offered');
    assert.equal(calls.includes('POST /api/system/apply-update'), false, 'opening the modal only checks');
    await page.keyboard.press('Escape');
    await page.locator('#h5-update-dialog').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'h5-update', 'focus returns to the Update button');
    await page.locator('#h5-update').click();
    await page.locator('#h5-update-close').click();
    await page.locator('#h5-update-dialog').waitFor({ state: 'detached' });
    await page.locator('#h5-update').click();
    await page.locator('#h5-update-now').waitFor();
    await page.mouse.click(5, 5); // tap outside
    await page.locator('#h5-update-dialog').waitFor({ state: 'detached' });
    // Up to date and a failed check.
    for (const [mode, selector, text] of [['current', '#h5-update-state', 'Already up to date'], ['error', '#h5-update-state[role="alert"]', 'REMOTE_DOWN']]) {
      checkMode = mode;
      await page.locator('#h5-update').click();
      await page.locator(selector).filter({ hasText: text }).waitFor();
      await page.keyboard.press('Escape');
      await page.locator('#h5-update-dialog').waitFor({ state: 'detached' });
    }
    checkMode = 'available';
    await page.evaluate(() => { window.beforeRefresh = true; });
    await Promise.all([page.waitForEvent('load'), page.locator('#h5-refresh').click()]);
    await page.waitForSelector('#h5-refresh');
    assert.equal(await page.evaluate(() => window.beforeRefresh === true), false, 'the page was loaded again');
    await page.locator('#h5-open-tasks').tap();
    assert.equal(await page.locator('#h5-tasks-settings svg').count(), 1, 'a gear icon');
    await page.locator('#h5-tasks-settings').tap();
    await page.locator('#h5-settings').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#h5-settings #h5-lang').count(), 1, 'the settings have the language button');
    assert.equal(await page.locator('#h5-lang').textContent(), '\u4e2d\u6587', 'it names the other language');
    assert.equal(await page.locator('#h5-settings #h5-logout').isVisible(), true, 'the settings have a log out button');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#h5-settings .h5-sheet-panel')).transform === 'none');
    await page.screenshot({ path: '/tmp/t-agent-mui-settings.png' });
    // Logging out goes to the hidden login address the server wrote into the page, and comes back to the phone page afterwards.
    await page.evaluate(() => { const meta = document.createElement('meta'); meta.name = 't-agent-login-path'; meta.content = '/torin/hide/login'; document.head.append(meta); });
    page.once('dialog', dialog => dialog.accept());
    await Promise.all([page.waitForURL(`${ORIGIN}/torin/hide/login?return_to=/h5`), page.locator('#h5-logout').tap()]);
    assert.ok(calls.includes('POST /auth/logout'));
    await page.goto(`${ORIGIN}/h5`);
    await page.locator('#h5-open-tasks').tap();
    await page.locator('#h5-tasks-settings').tap();
    await page.locator('#h5-settings').waitFor({ state: 'visible' });
    // The settings sheet has no updater any more: the Update button's modal does the whole flow.
    assert.equal(await page.locator('#h5-settings #h5-update-check, #h5-settings #h5-update-log, #h5-settings #h5-update-hint').count(), 0, 'no updater in Settings');
    await page.goto(`${ORIGIN}/h5`); // back to the plain page (no sheets open)
    await page.locator('#h5-update').click();
    await page.locator('#h5-update-now').click();
    // Update now starts the update at once and shows the live log; the page reloads when the service is back.
    await page.waitForFunction(() => (document.getElementById('h5-update-log') || {}).textContent === 'npm ci');
    assert.ok(calls.includes('POST /api/system/apply-update'));
    assert.equal(await page.locator('#h5-update-dismiss').isDisabled(), true, 'the modal cannot be closed while updating');
    updateDone = true;
    await Promise.all([page.waitForEvent('load', { timeout: 15000 }), page.locator('#h5-update-state', { hasText: /reloading/ }).waitFor()]);
    await context.close();

    // The action row (keyboards, image, commands, mic, send arrow, translate-and-send) fits a 360px phone with no sideways overflow.
    {
      const narrow = await openPage(browser, { viewport: { width: 360, height: 740 } });
      await openTask(narrow.page, 'Fix login', 'click');
      await narrow.page.waitForFunction(() => window.sockets.length === 1);
      await narrow.page.waitForTimeout(500);
      await narrow.page.locator('#h5-translate-input').focus();
      await narrow.page.waitForFunction(() => !document.getAnimations().some(a => a.playState === 'running') && !document.querySelector('.h5-bar-moving'), null, { timeout: 3000 });
      const row = await narrow.page.evaluate(() => { const r = id => document.getElementById(id).getBoundingClientRect(); const ids = ['h5-image', 'h5-commands', 'h5-voice', 'h5-translate-send', 'h5-translate-button'];
        const boxes = [...document.querySelectorAll('#h5-actions button, #h5-actions [role="button"]')].map(b => b.getBoundingClientRect()).filter(box => box.width > 0);
        return { designHidden: document.getElementById('h5-design').getBoundingClientRect().width === 0 && document.getElementById('h5-cycle').getBoundingClientRect().width === 0, inside: ids.every(id => r(id).left >= 0 && r(id).right <= innerWidth && r(id).width >= 32 && r(id).height >= 40), overflow: document.documentElement.scrollWidth > innerWidth, noOverlap: boxes.every((box, i) => i === 0 || boxes[i - 1].right <= box.left + 0.5) };
      });
      assert.deepEqual(row, { designHidden: true, inside: true, overflow: false, noOverlap: true }, 'the action row with send and translate fits at 360px (the design and next-session buttons step aside)');
      await narrow.context.close();
    }

    // The key row scrolls sideways (as in the reference design): the first keys are fully on screen on the narrowest phones and in landscape, the page itself never scrolls sideways.
    for (const viewport of [{ width: 320, height: 640 }, { width: 844, height: 390 }]) {
      const small = await openPage(browser, { viewport });
      await small.page.locator('#h5-keys').waitFor({ state: 'visible' });
      await openTask(small.page, 'Fix login', 'click');
      await small.page.waitForFunction(() => window.sockets.length === 1);
      await small.page.waitForTimeout(500); // the task sheet slides away
      const fit = await small.page.evaluate(() => {
        const boxes = [...document.querySelectorAll('#h5-keys button')].map(button => button.getBoundingClientRect());
        const first = boxes.slice(0, 5);
        return { count: boxes.length, inside: first.every(box => box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && box.width >= 36 && box.height >= 32), overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.deepEqual(fit, { count: 18, inside: true, overflow: false }, `the first keys fit at ${viewport.width}px`);
      const row2 = () => small.page.evaluate(() => [...document.querySelectorAll('#h5-actions button, #h5-actions [role="button"]')].map(b => b.getBoundingClientRect()).filter(box => box.width > 0).map(box => ({ left: box.left, right: box.right, width: box.width, height: box.height })));
      const resting = await row2();
      if (process.env.H5_SHOT_DIR && viewport.width === 320) await small.page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, 'h5-row2-320-rest.png') });
      const restCount = viewport.width < 360 ? 7 : 8; // Files is left out under 360px (eight 44px buttons do not fit)
      assert.ok(resting.length === restCount && resting.every((box, i) => box.left >= 0 && box.right <= innerWidthOf(viewport) && box.width >= 40 && box.height >= 40 && (i === 0 || resting[i - 1].right <= box.left + 0.5)), `row 2 at rest: ${restCount} buttons of at least 40px at ${viewport.width}px`);
      await small.page.locator('#h5-translate-input').focus();
      await small.page.waitForFunction(() => !document.getAnimations().some(a => a.playState === 'running') && !document.querySelector('.h5-bar-moving'), null, { timeout: 3000 });
      const drafting = await row2();
      assert.ok(drafting.length === 7 && drafting.every((box, i) => box.left >= 0 && box.right <= innerWidthOf(viewport) && box.width >= 32 && (i === 0 || drafting[i - 1].right <= box.left + 0.5)), `row 2 with the draft box: the design and next-session buttons step aside and the rest fits at ${viewport.width}px`);
      if (process.env.H5_SHOT_DIR && viewport.width === 320) await small.page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, 'h5-row2-320-draft.png') });
      await small.page.evaluate(() => document.activeElement.blur());
      await small.context.close();
    }

    // Opened on a computer, the task sheet is a permanent sidebar and the terminal fills the rest of the window.
    const wide = await openPage(browser, { viewport: { width: 1440, height: 900 } });
    await wide.page.locator('#h5-tasks').waitFor({ state: 'visible' });
    const sheetBox = await wide.page.locator('#h5-tasks').boundingBox();
    assert.deepEqual([sheetBox.width, sheetBox.x], [320, 0]);
    await openTask(wide.page, 'Fix login', 'click');
    assert.equal(await wide.page.locator('#h5-tasks').isVisible(), true, 'the sidebar stays after a task is chosen');
    assert.equal(await wide.page.locator('#h5-close-tasks').isHidden(), true, 'the sidebar has no close button');
    assert.equal(await wide.page.evaluate(() => document.getElementById('h5-app').inert), false, 'the page beside the sidebar stays usable');
    const appBox = await wide.page.locator('#h5-app').boundingBox();
    assert.deepEqual([appBox.width, appBox.x], [1120, 320]);
    assert.equal(await wide.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await wide.page.waitForFunction(() => window.sockets.length === 1);
    await wide.page.evaluate(() => window.sockets[0].emit(JSON.stringify({ type: 'history', data: 'x', cols: 80, rows: 24 })));
    await wide.page.waitForTimeout(100);
    const cols = await wide.page.evaluate(() => window.sockets[0].sent.map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(item => item?.type === 'resize').pop().cols);
    assert.ok(cols > 100, `the terminal uses the width beside the sidebar (${cols} columns)`);
    await wide.page.screenshot({ path: '/tmp/t-agent-mui-wide.png' });
    // The actions of a terminal are a popup right under the "⋯" that opened them, right-aligned to it (scripts/test-h5-session-menu-browser.cjs has the rest).
    await wide.page.locator('#h5-tasks .h5-terminal-more').first().click();
    await wide.page.locator('#h5-session-menu [role="menuitem"]').first().waitFor();
    await wide.page.waitForFunction(() => getComputedStyle(document.querySelector('.h5-session-menu-paper')).transform === 'none'); // the grow-in has finished
    const moreBox = await wide.page.locator('#h5-tasks .h5-terminal-more').first().boundingBox();
    const menuBox = await wide.page.locator('.h5-session-menu-paper').boundingBox();
    assert.ok(Math.abs(menuBox.y - (moreBox.y + moreBox.height)) <= 2 && Math.abs(menuBox.x + menuBox.width - (moreBox.x + moreBox.width)) <= 2, `the popup is under the button (${JSON.stringify([moreBox, menuBox])})`);
    await wide.page.keyboard.press('Escape');
    await wide.page.locator('#h5-session-menu').waitFor({ state: 'detached' });
    // Settings are a sheet from the bottom with the page dimmed; a click beside the sheet closes it.
    await wide.page.locator('#h5-tasks-settings').click();
    await wide.page.locator('#h5-settings').waitFor({ state: 'visible' });
    await wide.page.waitForFunction(() => getComputedStyle(document.querySelector('#h5-settings .h5-sheet-panel')).transform === 'none'); // the slide-in has finished
    const panelBox = await wide.page.locator('#h5-settings .h5-sheet-panel').boundingBox();
    assert.deepEqual([panelBox.width, panelBox.x + panelBox.width / 2, panelBox.y + panelBox.height], [440, 720, 900], 'a centred sheet that rises from the bottom');
    await wide.page.mouse.click(100, 100);
    await wide.page.locator('#h5-settings').waitFor({ state: 'detached' });
    // Narrowing the window below the breakpoint turns the sidebar back into the sheet that is closed; widening brings it back.
    await wide.page.setViewportSize({ width: 600, height: 900 });
    await wide.page.locator('#h5-tasks').waitFor({ state: 'detached' });
    assert.deepEqual(await wide.page.locator('#h5-app').boundingBox().then(box => [box.x, box.width]), [0, 600], 'a tablet-sized window is one full-width column');
    await wide.page.locator('#h5-open-tasks').click();
    assert.equal(await wide.page.evaluate(() => document.getElementById('h5-root').getAttribute('aria-hidden')), 'true', 'the sheet is modal below the breakpoint');
    // Close only after the slide-in has finished: a click on the moving close button can miss it on a busy machine.
    await wide.page.waitForFunction(() => getComputedStyle(document.querySelector('#h5-tasks .MuiDrawer-paper')).transform === 'none');
    await wide.page.locator('#h5-close-tasks').click();
    await wide.page.locator('#h5-tasks').waitFor({ state: 'detached' });
    await wide.page.setViewportSize({ width: 1200, height: 900 });
    await wide.page.locator('#h5-tasks').waitFor({ state: 'visible' });
    assert.equal(await wide.page.evaluate(() => document.getElementById('h5-root').getAttribute('aria-hidden')), null, 'the page beside the sidebar is usable');
    assert.equal(await wide.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await wide.context.close();

    // A remote engine's desktop terminal is the phone's terminal too (shared terminals).
    const old = await openPage(browser, { remoteTerminals: true });
    await old.page.locator('#h5-tasks').waitFor({ state: 'visible' });
    await old.page.locator('#h5-engine').selectOption('remote:7');
    await openTask(old.page, 'Remote task');
    await old.page.waitForFunction(() => window.sockets.length === 1);
    assert.match(await old.page.evaluate(() => new URL(window.sockets[0].url).search), /terminalId=default&clientId=/);
    await old.context.close();
    // A remote Engine that has chats: the "+" offers terminals only and the page does not ask for its chats.
    const remote = await openPage(browser, { remoteTerminals: true, remoteChat: true });
    await remote.page.locator('#h5-engine').selectOption('remote:7');
    await openTask(remote.page, 'Remote task');
    await remote.page.locator('#h5-open-tasks').tap();
    await remote.page.locator('.h5-task-add').tap();
    await remote.page.waitForTimeout(300);
    assert.deepEqual(await remote.page.locator('#h5-term-menu-actions button').allTextContents(), ['New Terminal', 'Claude session', 'Codex session']);
    assert.ok(!remote.calls.some(call => call.includes('/agent/conversations')), 'no chat is read');
    await remote.context.close();
    assert.deepEqual(pageErrors, [], 'the phone shell has no browser runtime errors');
    console.log('Phone page layout, phone terminals, keys, paste, image upload, translate-and-send and old-engine guard passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
