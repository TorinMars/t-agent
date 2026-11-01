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
const pageErrors = [];
// The conversations the page's server knows; a test can make the list unreadable.
const chats = [];
const chatPatches = [];
const pollUntil = async condition => { for (let i = 0; i < 500 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(condition(), 'timed out waiting for the server'); };
let chatListFails = false;

// The chat has no back button; going to a terminal from the task sheet leaves it.
async function leaveChatByTerminal(page) {
  await page.locator('#h5-open-tasks').tap();
  await page.locator('#h5-tasks .h5-terminal-row:not(:has(.h5-terminal-icon.claude, .h5-terminal-icon.codex)) .h5-terminal-main').first().tap();
}

// A tap on a task only opens the list of its sessions; going to one is a tap on that session.
async function openTask(page, title, how = 'tap') {
  await page.locator('.h5-task-item', { hasText: title })[how]();
  await page.locator(`#h5-tasks .h5-terminal-list[aria-label="${title}"] .h5-terminal-main`).first()[how]();
}

async function openPage(browser, { remoteTerminals, remoteChat = false, viewport } = {}) {
  const context = await browser.newContext(viewport ? { viewport } : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
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
    if (url.pathname === '/api/tasks' && method === 'GET') return json([{ id: 1, title: 'Fix login', status: 'doing' }, { id: 2, title: 'Write docs', status: 'todo' }]);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }, { key: 'todo', name: 'To do', sort_order: 2 }]);
    if (url.pathname === '/api/remote-servers/7/tasks') return json([{ id: 9, title: 'Remote task', status: 'doing' }]);
    if (url.pathname === '/api/remote-servers/7/task-groups') return json([]);
    if (url.pathname === '/api/remote-servers/7/tasks/9/terminals') return json([{ terminal_id: remoteChat ? 'h5-default' : 'default', title: 'Terminal 1' }]);
    if (url.pathname === '/api/remote-servers/7/info') return json({ capabilities: remoteChat ? ['agent-chat:manage'] : [] });
    if (url.pathname === '/api/agent-chat/summary') return json({ running: 1, queued: 2, submitted: 3 });
    if (url.pathname === '/api/tasks/1/terminals' && method === 'GET') return json([{ terminal_id: 'h5-default', title: 'Terminal 1' }]);
    if (url.pathname === '/api/tasks/2/terminals' && method === 'GET') return json([{ terminal_id: 'h5-docs', title: 'Docs terminal' }]);
    if (url.pathname === '/api/tasks/2/agent/conversations' && method === 'GET') return json([]);
    if (url.pathname === '/api/tasks/1/terminals' && method === 'POST') return json({ terminal_id: 'h5-second', title: 'Terminal 2' }, 201);
    if (url.pathname === '/api/tasks/1/terminals/h5-second' && method === 'PATCH') return json({ terminal_id: 'h5-second', title: route.request().postDataJSON().title });
    if (url.pathname === '/api/tasks/1/terminal/control' && method === 'POST') return json({ success: true });
    // Both local and remote chats use the same view, with a different task base.
    const chatPath = url.pathname.replace('/api/remote-servers/7/tasks/9/agent', '/api/tasks/1/agent');
    // Chat-style agents: the conversation list, the sessions of the task directory, one empty conversation and an idle event stream.
    if (chatPath === '/api/tasks/1/agent/conversations' && method === 'GET') return chatListFails ? json({ error: 'down' }, 500) : json(chats);
    if (chatPath === '/api/tasks/1/agent/sessions') return json([{ id: 'session-old-1234', title: 'Old chat' }]);
    if (chatPath === '/api/tasks/1/agent/conversations' && method === 'POST') {
      const row = { id: 'c1', agent: route.request().postDataJSON().agent, session_id: null, title: 'New chat', mode: 'ask', running: false, opened: { web: null, h5: null } };
      chats.push(row);
      return json(row);
    }
    if (chatPath === '/api/tasks/1/agent/conversations/c1' && method === 'PATCH') {
      // Which chat is open on the phone page is kept by the server.
      const body = route.request().postDataJSON();
      if (body.title !== undefined) { const named = chats.find(entry => entry.id === 'c1'); if (named) named.title = body.title; chatPatches.push(body); return json({ success: true }); }
      chatPatches.push(body);
      const row = chats.find(entry => entry.id === 'c1');
      if (row) row.opened[body.surface] = body.opened ? row.opened[body.surface] || Date.now() : null;
      return json(row || {});
    }
    if (chatPath.startsWith('/api/tasks/1/agent/conversations/') && method === 'DELETE') {
      const index = chats.findIndex(entry => chatPath.endsWith(`/${entry.id}`));
      if (index < 0) return json({ error: 'CONVERSATION_NOT_FOUND' }, 404);
      chats.splice(index, 1);
      return json({ success: true });
    }
    if (chatPath === '/api/tasks/1/agent/conversations/c1') return json({ conversation: { id: 'c1' }, items: [{ id: 'u1', kind: 'user', text: 'hello agent' }, { id: 't1', kind: 'text', text: 'Hi **there**' }], pending: [], status: 'idle', seq: 0 });
    if (chatPath === '/api/tasks/1/agent/conversations/c1/events') return route.fulfill({ contentType: 'text/event-stream', body: ': ok\n\n' });
    if (url.pathname === '/api/oss/config') return json({ enabled: true });
    if (url.pathname === '/api/oss/upload-policy' && method === 'POST') {
      // The Client only signs the upload; the image itself goes to OSS from the browser.
      assert.deepEqual(route.request().postDataJSON(), { type: 'image/png', size: 8 });
      return json({ host: 'https://bucket.oss.test', fields: { key: 'terminal-images/shot.png', policy: 'p', 'x-oss-signature': 's' }, url: 'https://img.test/shot.png', expiresAt: null });
    }
    if (url.pathname === '/api/oss/images') return json({ error: 'the Client no longer receives images' }, 404);
    if (url.pathname === '/api/system/check-update') return json({ status: 'available', is_update_admin: true, local_version: '1.0.0', remote_version: '1.0.1' });
    if (url.pathname === '/api/system/version') return json({ boot_id: 'old' });
    if (url.pathname === '/api/system/apply-update') { assert.deepEqual(route.request().postDataJSON(), { confirm: true }); return json({ accepted: true }, 202); }
    if (url.pathname === '/api/system/update-status') return json({ status: 'updating', stage: 'installing', message: 'Installing dependencies', log: [{ at: 1, text: 'npm ci' }], boot_id: 'old' });
    if (url.pathname === '/api/translate') return json({ text: 'Run the tests\u001b[2J' });
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
    // The agent counters stand in the header, right of the task name and left of the refresh button.
    await page.locator('#agent-activity').waitFor({ state: 'visible' });
    assert.deepEqual(await page.locator('#agent-activity .count').allTextContents(), ['3', '1']);
    assert.deepEqual(await page.locator('#agent-activity .label').allTextContents(), ['submitted', 'running']);
    const [activityBox, refreshBox, titleBox] = await Promise.all([page.locator('#agent-activity').boundingBox(), page.locator('#h5-refresh').boundingBox(), page.locator('#h5-task-name').boundingBox()]);
    assert.ok(activityBox.x + activityBox.width <= refreshBox.x + 1 && activityBox.x >= titleBox.x, 'between the task name and the refresh button');
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
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('saved prompt$'));
    // OSC 8 links: a javascript: address is never confirmed or opened; an https address is confirmed first, then opened in a new tab.
    await page.evaluate(() => {
      window.opened = [];
      window.open = (...args) => { window.opened.push(args[0]); return null; };
      window.sockets[0].emit('\r\n\x1b]8;;javascript:alert(1)\x07EVILLINK\x1b]8;;\x07\r\n\x1b]8;;https://example.com/ok\x07GOODLINK\x1b]8;;\x07');
    });
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('GOODLINK'));
    const clickText = async text => {
      const box = await page.locator('.xterm-rows > div', { hasText: text }).first().boundingBox();
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
        byRow.get(top).push({ left: box.left, right: box.right, height: box.height, text: button.textContent.trim() });
      }
      return [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row.sort((a, b) => a.left - b.left));
    });
    assert.equal(rows.length, 3, 'the function keys fit in three rows');
    assert.deepEqual(rows[0].map(cell => cell.text), ['Esc', 'Tab', 'Ctrl', 'Alt', 'Shift', '⌨']);
    assert.deepEqual(rows[1].map(cell => cell.text), ['Paste', 'Image', '⌫', '↑']);
    assert.deepEqual(rows[2].map(cell => cell.text), ['Enter', '^C', '←', '↓', '→']);
    // The arrows form an inverted T: ↑ right above ↓, and ← ↓ → in one row in that order.
    const arrows = await page.evaluate(() => Object.fromEntries(['Left', 'Down', 'Up', 'Right'].map(name => { const box = document.querySelector(`#h5-keys [data-key="Arrow${name}"]`).getBoundingClientRect(); return [name, { left: box.left, top: box.top, bottom: box.bottom, cx: (box.left + box.right) / 2 }]; })));
    assert.ok(arrows.Up.bottom <= arrows.Down.top, 'the up arrow is above the down arrow');
    assert.ok(Math.abs(arrows.Up.cx - arrows.Down.cx) < 1, 'the up arrow is centred over the down arrow');
    assert.equal(arrows.Left.top, arrows.Down.top);
    assert.equal(arrows.Right.top, arrows.Down.top);
    assert.ok(arrows.Left.left < arrows.Down.left && arrows.Down.left < arrows.Right.left, 'left, down, right in that order');
    assert.equal(await page.locator('#h5-translate').isVisible(), true, 'the translate box is always shown');
    assert.ok(rows.flat().every(cell => cell.height >= 32 && cell.right <= 390));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

    const sent = () => page.evaluate(() => window.sockets[0].sent.filter(item => !item.startsWith('{')));
    await page.locator('[data-key="Escape"]').tap();
    await page.locator('[data-modifier="ctrl"]').tap();
    assert.equal(await page.locator('[data-modifier="ctrl"]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-key="ArrowUp"]').tap();
    assert.equal(await page.locator('[data-modifier="ctrl"]').getAttribute('aria-pressed'), 'false');
    // A latched Ctrl applies to the next character typed on the on-screen keyboard.
    await page.locator('[data-modifier="ctrl"]').tap();
    await page.locator('.h5-xterm textarea').focus();
    await page.keyboard.type('c');
    await page.locator('[data-shortcut="ctrl-c"]').tap();
    await page.locator('[data-action="paste"]').tap();
    await page.waitForFunction(() => window.sockets[0].sent.includes('git status'));
    assert.deepEqual(await sent(), ['\x1b', '\x1b[1;5A', '\x03', '\x03', 'git status']);
    for (const name of ['Left', 'Down', 'Up', 'Right']) await page.locator(`[data-key="Arrow${name}"]`).tap();
    assert.deepEqual((await sent()).slice(5), ['\x1b[D', '\x1b[B', '\x1b[A', '\x1b[C'], 'each arrow sends its own sequence');

    // Tapping the terminal never asks for the on-screen keyboard; the keyboard key toggles it through the textarea's inputmode.
    const inputmode = () => page.evaluate(() => document.querySelector('.h5-xterm textarea').getAttribute('inputmode'));
    const inTerminal = () => page.evaluate(() => document.querySelector('.h5-xterm').contains(document.activeElement));
    assert.equal(await inputmode(), 'none');
    await page.locator('.h5-xterm').tap();
    assert.equal(await inputmode(), 'none', 'tapping the terminal does not request the on-screen keyboard');
    await page.locator('[data-action="keyboard"]').tap();
    assert.equal(await inputmode(), 'text');
    assert.equal(await inTerminal(), true);
    await page.locator('.h5-xterm').tap();
    assert.equal(await inputmode(), 'text', 'a terminal tap keeps the open keyboard');
    await page.locator('[data-action="keyboard"]').tap();
    assert.equal(await inputmode(), 'none');
    assert.equal(await inTerminal(), false);
    await page.locator('.h5-xterm').tap();
    assert.equal(await inputmode(), 'none', 'a terminal tap after closing does not reopen it');

    // Translate and send: control characters are stripped and Enter follows separately.
    await page.locator('#h5-translate-input').fill('run the tests');
    await page.locator('#h5-translate-send').tap();
    await page.waitForFunction(() => window.sockets[0].sent.includes('\r'));
    assert.deepEqual((await sent()).slice(-2), ['Run the tests [2J', '\r'], 'ESC is removed, so no escape sequence reaches the shell');
    assert.equal(await page.locator('#h5-translate-input').inputValue(), '');

    // Image upload: the link is typed into the terminal with a trailing space and no Enter.
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-action="image"]').tap()]);
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
      document.querySelector('.h5-xterm textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => window.sockets[0].sent.filter(item => item === 'https://img.test/shot.png ').length === 2);
    assert.equal(await linkCount(), 2);
    assert.equal(ossUploads.length, 2, 'the pasted image went to OSS from the browser');
    assert.equal((await sent()).length, sentBefore + 1, 'only the link was typed');

    // The wheel strip on the right edge scrolls like a wheel; a drag on the terminal body makes no wheel events.
    const strip = page.locator('#h5-wheel');
    assert.equal(await page.locator('#h5-wheel').count(), 1, 'the terminal has one wheel strip');
    const idle = await page.evaluate(() => {
      const el = document.querySelector('#h5-wheel');
      const copy = document.querySelector('#h5-scroll [data-copy]').getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return { bg: getComputedStyle(el).backgroundColor, trackOpacity: getComputedStyle(el, '::before').opacity, touchAction: getComputedStyle(el).touchAction,
        overlap: !(box.right <= copy.left || box.left >= copy.right || box.bottom <= copy.top || box.top >= copy.bottom), width: box.width };
    });
    assert.equal(idle.bg, 'rgba(0, 0, 0, 0)', 'the idle strip has no background');
    assert.equal(idle.trackOpacity, '0', 'the idle strip shows nothing');
    assert.equal(idle.touchAction, 'none');
    assert.equal(idle.overlap, false, 'the strip does not cover the copy button');
    assert.ok(idle.width >= 36 && idle.width <= 48, 'the strip is about 40px wide');

    await page.evaluate(() => window.sockets[0].emit(JSON.stringify({ type: 'history', data: '\x1b[?1049h\x1b[?1000h\x1b[?1006hfull screen app', cols: 40, rows: 30 })));
    await page.waitForTimeout(150);
    const cdp = await context.newCDPSession(page);
    const box = await strip.boundingBox();
    const stripX = box.x + box.width / 2;
    const drag = async (x, from, to, check) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from }] });
      await page.waitForTimeout(50);
      for (let y = from; y !== to; y += from < to ? 20 : -20) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }); await page.waitForTimeout(16); }
      if (check) await check();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForFunction(() => !window.__h5WheelCoasting(), null, { timeout: 8000 }); // let the momentum end
    };
    const wheels = () => page.evaluate(() => window.sockets[0].sent.filter(item => /^\x1b\[<6[45];/.test(item)).map(item => item.slice(3, 5)));
    const before = (await wheels()).length;
    await drag(stripX, 300, 500, async () => {
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#h5-wheel'), '::before').opacity), '1', 'the track shows while a finger is on the strip');
    });
    const down = (await wheels()).slice(before);
    assert.ok(down.length >= 5 && down.every(code => code === '64'), 'dragging down on the strip sends wheel-up reports');
    await drag(stripX, 500, 300);
    const up = (await wheels()).slice(before + down.length);
    assert.ok(up.length >= 5 && up.every(code => code === '65'), 'dragging up on the strip sends wheel-down reports');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#h5-wheel'), '::before').opacity === '0', null, { timeout: 3000 });

    const afterStrip = (await wheels()).length;
    await drag(150, 300, 500);
    await drag(150, 500, 300);
    assert.equal((await wheels()).length, afterStrip, 'dragging the terminal body sends no wheel reports');

    // In the normal buffer the strip scrolls the history.
    await page.evaluate(() => window.sockets[0].emit(JSON.stringify({ type: 'history', data: '\x1b[?1049l\x1b[?1000l' + Array.from({ length: 200 }, (_, i) => 'line ' + i).join('\r\n'), cols: 40, rows: 30 })));
    await page.waitForTimeout(300);
    const rowsText = () => page.locator('.h5-xterm .xterm-rows').textContent();
    const bottomText = await rowsText();
    await drag(stripX, 300, 500);
    const olderText = await rowsText();
    assert.notEqual(olderText, bottomText, 'dragging down on the strip shows older output in the normal buffer');
    await drag(stripX, 500, 100); // momentum makes the way back longer than the way out
    assert.equal(await rowsText(), bottomText, 'dragging up brings the newest output back');

    // A tap on the strip (no travel) is handed to the element under it, so links under the strip stay clickable.
    await page.evaluate(() => { window.__tapClicks = 0; document.querySelector('.h5-xterm').addEventListener('click', () => { window.__tapClicks++; }); });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: stripX, y: 200 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(100);
    assert.ok(await page.evaluate(() => window.__tapClicks) >= 1, 'a tap on the strip reaches the terminal under it');

    // Momentum: a quick flick keeps scrolling after the finger is lifted, then stops by itself; a new touch cancels it.
    const coasting = () => page.evaluate(() => window.__h5WheelCoasting());
    const flick = async () => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: stripX, y: 300 }] });
      for (let y = 300; y <= 400; y += 25) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: stripX, y }] }); await page.waitForTimeout(8); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await flick();
    assert.equal(await coasting(), true, 'a quick flick starts momentum scrolling');
    await page.waitForFunction(() => !window.__h5WheelCoasting(), null, { timeout: 8000 });
    assert.equal(await coasting(), false, 'the momentum stops by itself');
    await flick();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: stripX, y: 300 }] });
    assert.equal(await coasting(), false, 'a new touch cancels the momentum');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(1000);

    // The buffer type is read for every step: switching to the alternate screen in the middle of a gesture sends wheel reports.
    await page.evaluate(() => window.sockets[0].emit(JSON.stringify({ type: 'history', data: '\x1b[?1000h\x1b[?1006hnormal', cols: 40, rows: 30 })));
    await page.waitForTimeout(150);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: stripX, y: 300 }] });
    for (let y = 300; y <= 400; y += 20) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: stripX, y }] }); await page.waitForTimeout(16); }
    const midBefore = (await wheels()).length;
    await page.evaluate(() => window.sockets[0].emit('\x1b[?1049h'));
    await page.waitForTimeout(100);
    for (let y = 400; y <= 520; y += 20) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: stripX, y }] }); await page.waitForTimeout(16); }
    assert.ok((await wheels()).length > midBefore, 'steps after a switch to the alternate screen become wheel reports');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(1500);

    // A fast fling in the alternate buffer delivers proportional lines (no cap of 10 per move).
    const fling0 = (await wheels()).length;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: stripX, y: 100 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: stripX, y: 500 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(100);
    assert.ok((await wheels()).length - fling0 >= 40, 'one long move sends many lines, not at most 10');
    await page.waitForFunction(() => !window.__h5WheelCoasting(), null, { timeout: 8000 });

    // Android: the back button closes the keyboard but leaves the input focused; inputmode goes back to none by itself.
    const vp = page.viewportSize();
    await page.locator('[data-action="keyboard"]').tap();
    assert.equal(await inputmode(), 'text');
    await page.setViewportSize({ width: vp.width, height: vp.height - 300 });
    await page.waitForTimeout(1000);
    assert.equal(await inputmode(), 'text', 'the keyboard is open: inputmode stays');
    await page.setViewportSize(vp);
    await page.waitForTimeout(900);
    assert.equal(await inputmode(), 'none', 'after the keyboard closed without a blur, inputmode is reset');
    await page.locator('.h5-xterm').tap();
    assert.equal(await inputmode(), 'none', 'the next terminal tap does not reopen the keyboard');
    await page.locator('[data-action="keyboard"]').tap();
    assert.equal(await inputmode(), 'text', 'the keyboard key still opens it afterwards');
    await page.locator('[data-action="keyboard"]').tap();

    // The terminal has no floating up/down buttons: scrolling is by the wheel strip.
    assert.equal(await page.locator('[data-scroll]').count(), 0, 'no scroll buttons are drawn');

    // A new terminal is a phone terminal and gets its own connection.
    await page.locator('#h5-open-tasks').tap();
    assert.deepEqual(await page.locator('#h5-tasks .h5-terminal-main .h5-terminal-name').allTextContents(), ['Terminal 1'], 'the selected task lists its terminals under it');
    assert.equal(await page.locator('#h5-tasks .h5-terminal-main[aria-current="true"] .h5-terminal-name').textContent(), 'Terminal 1');
    assert.equal(await page.locator('#h5-terminal-tabs').count(), 0, 'there is no tab strip above the terminal any more');
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
    assert.deepEqual(await page.locator('#h5-term-menu-actions button').allTextContents(), ['New Terminal', 'Claude session', 'Codex session', 'Claude agent', 'Codex agent'], 'the "+" opens the Session menu');
    // A chat-style agent: choose new or an existing session, then a conversation view covers the terminal.
    await page.locator('#h5-term-menu-actions button', { hasText: 'Claude agent' }).tap();
    await page.locator('#h5-term-menu-actions button', { hasText: 'Old chat' }).waitFor();
    assert.deepEqual(await page.locator('#h5-term-menu-actions button').allTextContents(), ['New Claude chat', 'Old chat', 'Back']);
    await page.locator('#h5-term-menu-actions button', { hasText: 'New Claude chat' }).tap();
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
    assert.ok(calls.includes('POST /api/tasks/1/agent/conversations'));
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

    // The open chat is kept by the server: a refresh brings it back, and the back button means the person is done with it.
    const openOnServer = () => chats[0] && chats[0].opened.h5;
    await pollUntil(() => openOnServer() > 0);
    assert.deepEqual(chatPatches.at(-1), { opened: true, surface: 'h5' });
    assert.equal(await page.evaluate(() => localStorage.getItem('h5-agent:local:1')), null, 'nothing about it is kept in the browser any more');
    await page.reload();
    await page.locator('#h5-agent .agent-chat').waitFor();
    await page.locator('#h5-agent .ac-bubble', { hasText: 'hello agent' }).waitFor();
    await leaveChatByTerminal(page);
    await page.locator('#h5-agent').waitFor({ state: 'hidden' });
    await pollUntil(() => openOnServer() === null);
    assert.deepEqual(chatPatches.at(-1), { opened: false, surface: 'h5' });
    await page.reload();
    await page.locator('#h5-task-name', { hasText: 'Fix login' }).waitFor();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#h5-agent').isHidden(), true, 'a chat that was closed does not come back');
    // A chat that was left is still listed under its task in the task sheet, and tapping it opens it again.
    await page.locator('#h5-open-tasks').tap();
    const chatRow = page.locator('#h5-tasks .h5-terminal-row', { hasText: 'New chat' });
    await chatRow.waitFor();
    // A chat shows the agent's mark with a small robot and an AGENT badge, so it differs from a terminal that runs the same agent.
    await chatRow.locator('.h5-robot').waitFor({ state: 'visible' }); // the sheet may still be sliding in
    assert.equal(await chatRow.locator('.h5-agent-badge').count(), 1);
    assert.equal(await page.locator('#h5-tasks .h5-terminal-row:not(:has(.h5-robot)) .h5-agent-badge').count(), 0, 'only chats have the badge');
    await chatRow.locator('.h5-terminal-main').tap();
    await page.locator('#h5-agent .agent-chat').waitFor();
    assert.equal(await page.locator('#h5-session-name').textContent(), 'New chat', 'an open chat shows its own name');
    assert.equal(await headerHeight(), terminalHeader, 'the header keeps its height whatever the name is');
    await pollUntil(() => openOnServer() > 0);
    await leaveChatByTerminal(page);
    assert.equal(await page.locator('#h5-session-name').textContent(), 'Terminal 1', 'back on the terminal, its name');
    await page.locator('#h5-agent').waitFor({ state: 'hidden' });
    await pollUntil(() => openOnServer() === null);
    // Only one of a terminal and a chat is current: with a chat open no terminal row is highlighted, and the chat row is.
    await page.locator('#h5-open-tasks').tap();
    await page.locator('#h5-tasks .h5-terminal-row', { hasText: 'New chat' }).locator('.h5-terminal-main').tap();
    await page.locator('#h5-agent .agent-chat').waitFor();
    await page.locator('#h5-open-tasks').tap();
    assert.equal(await page.locator('#h5-tasks .h5-terminal-main[aria-current="true"]').count(), 1, 'exactly one row is current');
    assert.equal(await page.locator('#h5-tasks .h5-terminal-row', { hasText: 'New chat' }).locator('.h5-terminal-main').getAttribute('aria-current'), 'true');
    await page.locator('#h5-tasks .h5-terminal-row:not(:has(.h5-terminal-icon.claude, .h5-terminal-icon.codex)) .h5-terminal-main').first().tap();
    await page.locator('#h5-agent').waitFor({ state: 'hidden' });
    await page.locator('#h5-open-tasks').tap();
    assert.equal(await page.locator('#h5-tasks .h5-terminal-main[aria-current="true"]').count(), 1);
    assert.equal(await page.locator('#h5-tasks .h5-terminal-row', { hasText: 'New chat' }).locator('.h5-terminal-main').getAttribute('aria-current'), null);
    // Chat actions (the three dots on a chat row): rename, and delete with a confirmation; the sheet is still open.
    await page.locator('#h5-tasks .h5-terminal-row', { hasText: 'New chat' }).locator('.h5-terminal-more').tap();
    await page.locator('#h5-term-menu-actions button', { hasText: 'Rename' }).tap();
    await page.locator('#h5-term-rename-input').fill('Renamed chat');
    await page.locator('#h5-term-rename-input').press('Enter');
    await page.locator('#h5-tasks .h5-terminal-row', { hasText: 'Renamed chat' }).waitFor();
    assert.deepEqual(chatPatches.at(-1), { title: 'Renamed chat' });
    chats.push({ id: 'c2', agent: 'codex', session_id: null, title: 'Spare chat', mode: 'ask', running: false, opened: { web: null, h5: null } });
    await page.reload();
    await page.locator('#h5-open-tasks').tap();
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#h5-tasks .h5-terminal-row', { hasText: 'Spare chat' }).locator('.h5-terminal-more').tap();
    await page.locator('#h5-term-menu-actions button', { hasText: 'Delete' }).tap();
    await page.waitForTimeout(200);
    assert.ok(chats.some(entry => entry.id === 'c2'), 'declining the confirmation keeps the chat');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#h5-term-menu-actions button', { hasText: 'Delete' }).tap(); // the menu stays open after a declined confirmation
    await pollUntil(() => !chats.some(entry => entry.id === 'c2'));
    await page.locator('#h5-tasks .h5-terminal-row', { hasText: 'Spare chat' }).waitFor({ state: 'detached' });
    await page.reload();
    // It is the server that remembers: a list that cannot be read opens nothing and forgets nothing; a chat that no longer exists is not shown.
    chats[0].opened.h5 = Date.now();
    chatListFails = true;
    await page.reload();
    await page.locator('#h5-task-name', { hasText: 'Fix login' }).waitFor();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#h5-agent').isHidden(), true);
    assert.ok(openOnServer() > 0);
    chatListFails = false;
    await page.reload();
    await page.locator('#h5-agent .agent-chat').waitFor();
    // What an earlier version kept in the browser moves to the server, once.
    await leaveChatByTerminal(page);
    await pollUntil(() => openOnServer() === null);
    const patchesBefore = chatPatches.length;
    await page.evaluate(() => localStorage.setItem('h5-agent:local:1', 'c1'));
    await page.reload();
    await page.locator('#h5-agent .agent-chat').waitFor();
    await pollUntil(() => openOnServer() > 0);
    assert.equal(chatPatches.length, patchesBefore + 1);
    assert.equal(await page.evaluate(() => localStorage.getItem('h5-agent:local:1')), null, 'the old record is gone');
    chats.length = 0;
    await page.reload();
    await page.locator('#h5-task-name', { hasText: 'Fix login' }).waitFor();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#h5-agent').isHidden(), true, 'a deleted chat is not shown');
    await page.locator('#h5-open-tasks').tap();
    await page.locator('#h5-tasks .h5-task-row:has(.h5-task-item[aria-current="true"]) .h5-task-add').tap();
    await page.locator('#h5-term-menu-actions button', { hasText: 'New Terminal' }).tap();
    await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.sockets.length === 2);
    assert.ok(calls.includes('POST /api/tasks/1/terminals'));
    assert.equal(await page.evaluate(() => new URL(window.sockets[1].url).searchParams.get('terminalId')), 'h5-second');
    assert.equal(await page.evaluate(() => window.sockets[0].readyState), 3);

    // The on-screen keyboard shrinks the viewport: the terminal keeps its size (no resize, so no redraw) and is shifted up instead.
    const termInfo = () => page.evaluate(() => {
      const box = document.getElementById('h5-terminal').getBoundingClientRect();
      const term = document.querySelector('.h5-xterm').getBoundingClientRect();
      const resizes = window.sockets[1].sent.filter(item => { try { return JSON.parse(item).type === 'resize'; } catch { return false; } }).length;
      return { boxTop: box.top, boxBottom: box.bottom, top: term.top, bottom: term.bottom, height: term.height, resizes };
    });
    await page.evaluate(() => window.sockets[1].emit(JSON.stringify({ type: 'history', data: '\x1b[?1049hfull screen app\x1b[30;1H', cols: 40, rows: 30 })));
    await page.waitForTimeout(200);
    const closed = await termInfo();
    await page.setViewportSize({ width: 390, height: 844 - 330 });
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#h5-keys').isVisible(), false, 'the function keys are hidden while the keyboard is open');
    assert.equal(await page.locator('#h5-translate').isVisible(), true, 'the translate box stays');
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
    assert.equal(await page.locator('#h5-keys').isVisible(), true, 'the function keys come back when the keyboard closes');
    const back = await termInfo();
    assert.equal(back.resizes, closed.resizes, 'closing the keyboard sends no resize either');
    assert.ok(Math.abs(back.top - closed.top) < 1 && Math.abs(back.bottom - closed.bottom) < 1, 'the terminal returns to its place');

    // iOS can miss the last resize event while focus moves to the translate box: the page must still follow the visible height.
    await page.setViewportSize({ width: 390, height: 844 - 330 });
    await page.waitForTimeout(300);
    await page.evaluate(() => document.documentElement.style.setProperty('--h5-height', '300px')); // a stale height, as if the event was missed
    assert.equal(await page.evaluate(() => document.querySelector('.h5-app').getBoundingClientRect().height), 300);
    await page.locator('#h5-translate-input').focus();
    await page.waitForFunction(() => Math.abs(document.querySelector('.h5-app').getBoundingClientRect().height - window.visualViewport.height) <= 1, null, { timeout: 3000 });
    await page.locator('#h5-translate-input').blur();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);

    // Copy text: the floating button shows the terminal text in a selectable overlay.
    assert.equal(await page.locator('#h5-scroll button').count(), 1, 'the copy button is the only floating button');
    await page.evaluate(() => { navigator.clipboard.writeText = async text => { window.copied = text; }; });
    // A row as wide as the terminal must stay one line in the overlay (same font, no wrapping of its own).
    const termCols = await page.evaluate(() => window.sockets[1].sent.map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(item => item?.type === 'resize').pop().cols);
    await page.evaluate(width => window.sockets[1].emit(`\r\n${'x'.repeat(width)}`), termCols);
    await page.waitForTimeout(150);
    await page.locator('[data-copy]').tap();
    await page.locator('#h5-copy').waitFor({ state: 'visible' });
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
    await page.locator('[data-copy]').tap();
    await page.locator('#h5-copy').waitFor({ state: 'visible' });
    assert.match(await page.locator('#h5-copy-text').textContent(), new RegExp(`q{${termCols - 1}} WRAPTAIL`), 'the space at the soft wrap is kept');
    await page.locator('#h5-copy-close').tap();
    await page.locator('#h5-copy').waitFor({ state: 'hidden' });

    // Long press on the terminal body opens the copy view; a press that moves does not.
    const touch = (type, x, y) => page.evaluate(([kind, px, py]) => {
      const target = document.querySelector('.h5-xterm .xterm-screen');
      const init = { bubbles: true, cancelable: true, clientX: px, clientY: py, pointerId: 7, pointerType: 'touch', isPrimary: true };
      target.dispatchEvent(new PointerEvent(kind, init));
    }, [type, x, y]);
    const screenBox = await page.locator('.h5-xterm .xterm-screen').boundingBox();
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

    // Double tap selects a word, triple tap a line, then Copy / Cancel; a program with mouse mode gets the taps instead.
    await page.evaluate(() => window.sockets[1].emit('\x1b[2J\x1b[Hhello world foo'));
    await page.waitForTimeout(150);
    const cell = { w: screenBox.width / termCols };
    const tap = async (col, count) => {
      await page.waitForTimeout(450); // the previous multi-tap is over
      for (let i = 0; i < count; i++) {
        await page.evaluate(([x, y]) => {
          const target = document.querySelector('.h5-xterm .xterm-screen');
          const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 8, pointerType: 'touch', isPrimary: true };
          target.dispatchEvent(new PointerEvent('pointerdown', init));
          target.dispatchEvent(new PointerEvent('pointerup', init));
          target.dispatchEvent(new MouseEvent('click', init));
        }, [screenBox.x + (col + 0.5) * cell.w, screenBox.y + 4]);
      }
    };
    await page.evaluate(() => { window.copied = ''; });
    await tap(8, 2);
    await page.locator('#h5-selection-bar').waitFor({ state: 'visible', timeout: 2000 });
    await page.locator('#h5-selection-copy').click();
    await page.waitForFunction(() => window.copied === 'world');
    await page.locator('#h5-selection-bar').waitFor({ state: 'hidden' });
    await tap(8, 3);
    await page.locator('#h5-selection-bar').waitFor({ state: 'visible', timeout: 2000 });
    await page.locator('#h5-selection-copy').click();
    await page.waitForFunction(() => window.copied.trim() === 'hello world foo');
    await tap(8, 2);
    await page.locator('#h5-selection-bar').waitFor({ state: 'visible' });
    await page.locator('#h5-selection-cancel').click();
    await page.locator('#h5-selection-bar').waitFor({ state: 'hidden' });
    await tap(8, 2);
    await page.locator('#h5-selection-bar').waitFor({ state: 'visible' });
    await page.evaluate(() => window.sockets[1].emit('x'));
    await page.locator('#h5-selection-bar').waitFor({ state: 'hidden', timeout: 2000 });
    await page.evaluate(() => window.sockets[1].emit('\x1b[?1000h'));
    await page.waitForTimeout(100);
    await tap(8, 2);
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#h5-selection-bar').count(), 0, 'no selection while the program tracks the mouse');
    await page.evaluate(() => window.sockets[1].emit('\x1b[?1000l'));

    // Terminal actions: the "⋯" on a terminal row opens rename / reopen / restart / delete.
    await page.locator('#h5-open-tasks').tap();
    assert.deepEqual(await page.locator('#h5-tasks .h5-terminal-main .h5-terminal-name').allTextContents(), ['Terminal 1', 'Terminal 2']);
    const more = page.locator('#h5-tasks .h5-terminal-row').nth(1).locator('.h5-terminal-more');
    await more.tap();
    await page.locator('#h5-term-menu').waitFor({ state: 'visible' });
    assert.deepEqual(await page.locator('#h5-term-menu-actions button').allTextContents(), ['Rename', 'Reopen', 'Restart in the working directory', 'Delete']);
    await page.locator('#h5-term-menu-actions button', { hasText: 'Rename' }).tap();
    await page.locator('#h5-term-rename-input').fill('Build logs');
    await page.locator('#h5-term-rename button').tap();
    await page.locator('#h5-term-menu').waitFor({ state: 'hidden' });
    assert.deepEqual(await page.locator('#h5-tasks .h5-terminal-main .h5-terminal-name').allTextContents(), ['Terminal 1', 'Build logs']);
    assert.ok(calls.includes('PATCH /api/tasks/1/terminals/h5-second'));
    // The first terminal can be deleted too.
    await page.locator('#h5-tasks .h5-terminal-row').nth(0).locator('.h5-terminal-more').tap();
    assert.equal(await page.locator('#h5-term-menu-actions button', { hasText: 'Delete' }).count(), 1);
    await page.locator('#h5-term-menu-cancel').tap();
    // Delete the current terminal (after a confirmation): the phone falls back to the remaining one.
    const sentBodies = [];
    await page.route(`${ORIGIN}/api/tasks/1/terminal/control`, route => { sentBodies.push(route.request().postDataJSON()); return route.fulfill({ contentType: 'application/json', body: '{"success":true}' }); });
    page.once('dialog', dialog => dialog.dismiss());
    await more.tap();
    await page.locator('#h5-term-menu-actions button', { hasText: 'Delete' }).tap();
    assert.equal(sentBodies.length, 0, 'declining the confirmation deletes nothing');
    await page.locator('#h5-term-menu-cancel').tap();
    await more.tap();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#h5-term-menu-actions button', { hasText: 'Delete' }).tap();
    await page.waitForFunction(() => document.querySelectorAll('#h5-tasks .h5-terminal-main').length === 1);
    assert.deepEqual(sentBodies, [{ action: 'delete', terminal_id: 'h5-second' }]);
    await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => new URL(window.sockets.at(-1).url).searchParams.get('terminalId')), 'h5-default');

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
    await page.waitForFunction(() => new URL(window.sockets.at(-1).url).searchParams.get('terminalId') === 'h5-docs');
    // And a chat of another task: that task is selected and the chat opens over it.
    chats.length = 0;
    chats.push({ id: 'c1', agent: 'claude', session_id: null, title: 'Cross chat', mode: 'ask', running: false, opened: { web: null, h5: null } });
    await page.locator('#h5-open-tasks').tap();
    // Fix login was left open, so its list is there already (read again when the sheet opens).
    await page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main', { hasText: 'Cross chat' }).tap();
    await page.locator('#h5-agent .agent-chat').waitFor();
    assert.equal(await page.locator('#h5-task-name').textContent(), 'Fix login');
    assert.equal(await page.locator('#h5-session-name').textContent(), 'Cross chat');
    await pollUntil(() => openOnServer() > 0);

    // Settings: the gear at the bottom of the task sidebar opens a sheet with the language toggle and the PC one-click update; the header has no settings button.
    assert.equal(await page.locator('#h5-open-settings').count(), 0, 'the header has no settings button');
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
    await page.locator('#h5-update-check').tap();
    // One tap checks and starts the update; there is no second confirmation.
    await page.waitForFunction(() => document.getElementById('h5-update-log').textContent.includes('npm ci'));
    assert.ok(calls.includes('POST /api/system/apply-update'));
    assert.equal(await page.locator('#h5-update-confirm').count(), 0, 'no confirmation step is left');
    await context.close();

    // The key grid shows every key, without sideways scrolling, on the narrowest phones and in landscape.
    for (const viewport of [{ width: 320, height: 640 }, { width: 844, height: 390 }]) {
      const small = await openPage(browser, { viewport });
      await small.page.locator('#h5-keys').waitFor({ state: 'visible' });
      await openTask(small.page, 'Fix login', 'click');
      await small.page.waitForFunction(() => window.sockets.length === 1);
      await small.page.waitForTimeout(500); // the task sheet slides away
      const fit = await small.page.evaluate(() => {
        const boxes = [...document.querySelectorAll('#h5-keys button')].map(button => button.getBoundingClientRect());
        return { count: boxes.length, inside: boxes.every(box => box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && box.width >= 36 && box.height >= 36), overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.deepEqual(fit, { count: 15, inside: true, overflow: false }, `all keys fit at ${viewport.width}px`);
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
    // The actions of a terminal rise inside the sidebar, under the "⋯" that opened them, not over the middle of the window.
    await wide.page.locator('#h5-tasks .h5-terminal-more').first().click();
    await wide.page.locator('#h5-term-menu-actions button').first().waitFor();
    await wide.page.waitForFunction(() => getComputedStyle(document.querySelector('#h5-term-menu .MuiDrawer-paper')).transform === 'none'); // the slide-in has finished
    const menuBox = await wide.page.locator('#h5-term-menu .MuiDrawer-paper').boundingBox();
    assert.deepEqual([menuBox.x, menuBox.width], [0, 320], 'the sheet is as wide as the sidebar and starts at its edge');
    await wide.page.locator('#h5-term-menu-cancel').click();
    await wide.page.locator('#h5-term-menu').waitFor({ state: 'detached' });
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
    // Chat capability controls the phone menu, and opening a remote chat uses only remote URLs.
    for (const supported of [false, true]) {
      chats.length = 0;
      const remote = await openPage(browser, { remoteTerminals: true, remoteChat: true });
      if (!supported) await remote.page.route(`${ORIGIN}/api/remote-servers/7/info`, route => route.fulfill({ contentType: 'application/json', body: '{"capabilities":[]}' }));
      await remote.page.locator('#h5-engine').selectOption('remote:7');
      await openTask(remote.page, 'Remote task');
      await remote.page.locator('#h5-open-tasks').tap();
      await Promise.all([remote.page.waitForResponse(`${ORIGIN}/api/remote-servers/7/info`), remote.page.locator('.h5-task-add').tap()]);
      if (supported) {
        await remote.page.locator('#h5-term-menu-actions button', { hasText: 'Codex agent' }).tap();
        await remote.page.locator('#h5-term-menu-actions button', { hasText: 'New Codex chat' }).tap();
        await remote.page.locator('#h5-agent .agent-chat').waitFor();
        assert.ok(remote.calls.includes('POST /api/remote-servers/7/tasks/9/agent/conversations'));
        assert.ok(remote.calls.includes('GET /api/remote-servers/7/tasks/9/agent/conversations/c1'));
        assert.ok(!remote.calls.some(call => call.includes('/api/tasks/1/agent')));
        await pollUntil(() => chats[0]?.opened.h5 > 0);
        await remote.page.reload();
        await remote.page.locator('#h5-agent .agent-chat').waitFor();
        await leaveChatByTerminal(remote.page);
        await pollUntil(() => chats[0]?.opened.h5 === null);
        await remote.page.locator('#h5-open-tasks').tap();
        await remote.page.locator('.h5-task-add').tap();
        await remote.page.locator('#h5-term-menu-actions button', { hasText: 'Codex agent' }).tap();
        await remote.page.locator('#h5-term-menu-actions button', { hasText: 'New Codex chat' }).tap();
        await remote.page.locator('#h5-agent .agent-chat').waitFor();
        // A source change hides the old view without clearing its saved open state.
        await remote.page.locator('#h5-engine').selectOption('local');
        await remote.page.locator('#h5-agent').waitFor({ state: 'hidden' });
      } else {
        assert.equal(await remote.page.locator('#h5-term-menu-actions button', { hasText: 'Codex agent' }).count(), 0);
      }
      await remote.context.close();
    }
    assert.deepEqual(pageErrors, [], 'the phone shell has no browser runtime errors');
    console.log('Phone page layout, phone terminals, keys, paste, image upload, translate-and-send and old-engine guard passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
