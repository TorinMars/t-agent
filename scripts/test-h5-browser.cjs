// Phone page (/h5) in real Chromium at phone size: key layout, task selection, phone-only terminals,
// latched modifiers, paste, image upload, translate-and-send and the guard against engines without phone terminals.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };

async function openPage(browser, { remoteTerminals } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const calls = [];
  await page.addInitScript(() => {
    window.sockets = [];
    window.FakeSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(data); }
      close() { this.readyState = 3; }
      emit(data) { this.onmessage?.({ data }); }
    };
    window.FakeSocket.OPEN = 1;
    window.FakeSocket.CONNECTING = 0;
    window.WebSocket = window.FakeSocket;
    window.clip = 'git status';
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
    if (url.pathname === '/api/remote-servers') return json(remoteTerminals ? [{ id: 7, name: 'Old VPS' }] : []);
    if (url.pathname === '/api/tasks' && method === 'GET') return json([{ id: 1, title: 'Fix login', status: 'doing' }, { id: 2, title: 'Write docs', status: 'todo' }]);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }, { key: 'todo', name: 'To do', sort_order: 2 }]);
    if (url.pathname === '/api/remote-servers/7/tasks') return json([{ id: 9, title: 'Remote task', status: 'doing' }]);
    if (url.pathname === '/api/remote-servers/7/task-groups') return json([]);
    // An old remote engine ignores surface=h5 and answers with its desktop terminals.
    if (url.pathname === '/api/remote-servers/7/tasks/9/terminals') return json([{ terminal_id: 'default', title: 'Terminal 1' }]);
    if (url.pathname === '/api/tasks/1/terminals' && method === 'GET') return json([{ terminal_id: 'h5-default', title: 'Terminal 1' }]);
    if (url.pathname === '/api/tasks/1/terminals' && method === 'POST') return json({ terminal_id: 'h5-second', title: 'Terminal 2' }, 201);
    if (url.pathname === '/api/oss/config') return json({ enabled: true });
    if (url.pathname === '/api/oss/images' && method === 'POST') {
      assert.equal(route.request().headers()['content-type'], 'image/png');
      return json({ url: 'https://img.test/shot.png' });
    }
    if (url.pathname === '/api/translate') return json({ text: 'Run the tests\u001b[2J' });
    return json({ error: 'not mocked' }, 404);
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
    assert.deepEqual(await page.locator('.h5-group-title').allTextContents(), ['In progress', 'To do']);
    await page.locator('.h5-task-item', { hasText: 'Fix login' }).tap();
    assert.equal(await page.locator('#h5-tasks').isVisible(), false);
    assert.equal(await page.locator('#h5-task-name').textContent(), 'Fix login');
    await page.waitForFunction(() => window.sockets.length === 1 && window.sockets[0].readyState === 1);
    assert.ok(calls.includes('GET /api/tasks/1/terminals?surface=h5'));
    assert.equal(await page.evaluate(() => new URL(window.sockets[0].url).search), '?taskId=1&terminalId=h5-default');
    assert.equal(await page.evaluate(() => window.sockets[0].url.startsWith('ws://h5.test/terminal/ws')), true);

    // Saved screen first, then live input is allowed.
    await page.evaluate(() => window.sockets[0].emit(JSON.stringify({ type: 'history', data: 'saved prompt$ ', cols: 80, rows: 24 })));
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('saved prompt$'));
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
    assert.deepEqual(rows[0].map(cell => cell.text), ['Esc', 'Tab', 'Ctrl', '↑', 'Shift', '⌨']);
    assert.deepEqual(rows[1].map(cell => cell.text), ['Alt', 'Paste', '←', '↓', '→', 'Enter']);
    assert.deepEqual(rows[2].map(cell => cell.text), ['⌫', '^C', 'Upload image', 'Translate']);
    assert.ok(rows.flat().every(cell => cell.height >= 40 && cell.right <= 390));
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

    // The keyboard key toggles focus of the terminal input (which is what shows the on-screen keyboard).
    assert.equal(await page.evaluate(() => document.querySelector('.h5-xterm').contains(document.activeElement)), true);
    await page.locator('[data-action="keyboard"]').tap();
    assert.equal(await page.evaluate(() => document.querySelector('.h5-xterm').contains(document.activeElement)), false);
    await page.locator('[data-action="keyboard"]').tap();
    assert.equal(await page.evaluate(() => document.querySelector('.h5-xterm').contains(document.activeElement)), true);

    // Translate and send: control characters are stripped and Enter follows separately.
    await page.locator('[data-action="translate"]').tap();
    await page.locator('#h5-translate-input').fill('run the tests');
    await page.locator('#h5-translate-send').tap();
    await page.waitForFunction(() => window.sockets[0].sent.includes('\r'));
    assert.deepEqual((await sent()).slice(-2), ['Run the tests [2J', '\r'], 'ESC is removed, so no escape sequence reaches the shell');
    assert.equal(await page.locator('#h5-translate-input').inputValue(), '');

    // Image upload: the link is typed into the terminal with a trailing space and no Enter.
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-action="image"]').tap()]);
    await chooser.setFiles({ name: 'shot.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') });
    await page.waitForFunction(() => window.sockets[0].sent.includes('https://img.test/shot.png '));
    assert.equal(await page.locator('.h5-upload-overlay').count(), 0);
    assert.notEqual((await sent()).at(-1), '\r');

    // A new terminal is a phone terminal and gets its own connection.
    await page.locator('#h5-terminal-tabs [aria-label="New phone terminal"]').tap();
    await page.waitForFunction(() => window.sockets.length === 2);
    assert.ok(calls.includes('POST /api/tasks/1/terminals?surface=h5'));
    assert.equal(await page.evaluate(() => new URL(window.sockets[1].url).searchParams.get('terminalId')), 'h5-second');
    assert.equal(await page.evaluate(() => window.sockets[0].readyState), 3);
    await context.close();

    // An engine that does not know phone terminals is never attached to its desktop terminal.
    const old = await openPage(browser, { remoteTerminals: true });
    await old.page.locator('#h5-tasks').waitFor({ state: 'visible' });
    await old.page.locator('#h5-engine').selectOption('remote:7');
    await old.page.locator('.h5-task-item', { hasText: 'Remote task' }).tap();
    await old.page.waitForFunction(() => document.getElementById('h5-empty').textContent.includes('does not support phone terminals'));
    assert.equal(await old.page.evaluate(() => window.sockets.length), 0);
    await old.context.close();
    console.log('Phone page layout, phone terminals, keys, paste, image upload, translate-and-send and old-engine guard passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
