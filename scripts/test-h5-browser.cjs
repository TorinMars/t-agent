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
    assert.deepEqual(await page.locator('.h5-group-title').allTextContents(), ['In progress', 'To do']);
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
    // The agent counters stand in the header, right of the task name and left of the settings button.
    await page.locator('#agent-activity').waitFor({ state: 'visible' });
    assert.deepEqual(await page.locator('#agent-activity .count').allTextContents(), ['3', '1']);
    assert.deepEqual(await page.locator('#agent-activity .label').allTextContents(), ['submitted', 'running']);
    const [activityBox, settingsBox, titleBox] = await Promise.all([page.locator('#agent-activity').boundingBox(), page.locator('#h5-open-settings').boundingBox(), page.locator('#h5-task-name').boundingBox()]);
    assert.ok(activityBox.x + activityBox.width <= settingsBox.x + 1 && activityBox.x >= titleBox.x, 'between the task name and the settings button');
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
    assert.match(await page.evaluate(() => new URL(window.sockets[0].url).search), /^\?taskId=1&terminalId=h5-default&clientId=[\w-]+$/);
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
    assert.equal(rows.length, 2, 'the function keys fit in two rows');
    assert.deepEqual(rows[0].map(cell => cell.text), ['Esc', 'Tab', 'Ctrl', 'Alt', 'Shift', '⌨', 'Paste', 'Image']);
    assert.deepEqual(rows[1].map(cell => cell.text), ['←', '↓', '↑', '→', 'Enter', '⌫', '^C']);
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

    // The keyboard key toggles focus of the terminal input (which is what shows the on-screen keyboard).
    assert.equal(await page.evaluate(() => document.querySelector('.h5-xterm').contains(document.activeElement)), true);
    await page.locator('[data-action="keyboard"]').tap();
    assert.equal(await page.evaluate(() => document.querySelector('.h5-xterm').contains(document.activeElement)), false);
    await page.locator('[data-action="keyboard"]').tap();
    assert.equal(await page.evaluate(() => document.querySelector('.h5-xterm').contains(document.activeElement)), true);

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

    // Dragging scrolls a full-screen program (alternate buffer with mouse reporting) by sending wheel events.
    await page.evaluate(() => window.sockets[0].emit(JSON.stringify({ type: 'history', data: '\x1b[?1049h\x1b[?1000h\x1b[?1006hfull screen app', cols: 40, rows: 30 })));
    await page.waitForTimeout(150);
    const cdp = await context.newCDPSession(page);
    const drag = async (from, to) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: from }] });
      await page.waitForTimeout(400); // press and hold first
      for (let y = from; y !== to; y += from < to ? 20 : -20) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y }] }); await page.waitForTimeout(16); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const wheels = () => page.evaluate(() => window.sockets[0].sent.filter(item => /^\x1b\[<6[45];/.test(item)).map(item => item.slice(3, 5)));
    const before = (await wheels()).length;
    await drag(300, 500);
    const down = (await wheels()).slice(before);
    assert.ok(down.length >= 5 && down.every(code => code === '64'), 'dragging down sends wheel-up reports');
    await drag(500, 300);
    const up = (await wheels()).slice(before + down.length);
    assert.ok(up.length >= 5 && up.every(code => code === '65'), 'dragging up sends wheel-down reports');

    // The floating buttons scroll by click, without a drag.
    const clicked = (await wheels()).length;
    await page.locator('[data-scroll="-1"]').tap();
    await page.locator('[data-scroll="1"]').tap();
    const buttons = (await wheels()).slice(clicked);
    assert.deepEqual([...new Set(buttons)].sort(), ['64', '65'], 'the up button sends wheel-up and the down button wheel-down reports');

    // A new terminal is a phone terminal and gets its own connection.
    await page.locator('#h5-open-tasks').tap();
    assert.deepEqual(await page.locator('#h5-tasks .h5-terminal-main .h5-terminal-name').allTextContents(), ['Terminal 1'], 'the selected task lists its terminals under it');
    assert.equal(await page.locator('#h5-tasks .h5-terminal-main[aria-current="true"] .h5-terminal-name').textContent(), 'Terminal 1');
    assert.equal(await page.locator('#h5-terminal-tabs').count(), 0, 'there is no tab strip above the terminal any more');
    assert.equal(await page.locator('#h5-tasks .h5-task-add').count(), 1, 'only the selected task has the "+" button');
    // Measured in one step: the task list re-renders when the sheet opens and would replace the row between two separate reads.
    await page.locator('#h5-tasks .h5-task-add').waitFor();
    const atEnd = await page.evaluate(() => {
      const row = document.querySelector('#h5-tasks .h5-task-row').getBoundingClientRect();
      const add = document.querySelector('#h5-tasks .h5-task-add').getBoundingClientRect();
      return add.x + add.width > row.x + row.width - 2;
    });
    assert.ok(atEnd, 'the "+" sits at the right end of the task row');
    await page.locator('#h5-tasks .h5-task-add').tap();
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
    // A chat shows the agent's mark with a speech bubble, so it differs from a terminal that runs the same agent.
    assert.equal(await chatRow.locator('.agent-chat-mark .agent-chat-bubble').count(), 1);
    await chatRow.locator('.agent-chat-bubble').waitFor({ state: 'visible' }); // the sheet may still be sliding in
    const bubble = await chatRow.locator('.agent-chat-bubble').boundingBox();
    assert.ok(bubble && bubble.width >= 8 && bubble.height >= 8, 'the bubble is drawn');
    assert.equal(await page.locator('#h5-tasks .h5-terminal-row:not(:has(.agent-chat-mark)) .agent-chat-bubble').count(), 0, 'only chats have the bubble');
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
    await page.locator('#h5-tasks .h5-task-add').tap();
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

    // Copy text: the floating button above the scroll buttons shows the terminal text in a selectable overlay.
    const order = await page.evaluate(() => [...document.querySelectorAll('#h5-scroll button')].map(button => button.getBoundingClientRect().top));
    assert.ok(order[0] < order[1] && order[1] < order[2], 'the copy button sits above the scroll buttons');
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
    await page.locator('#h5-copy-close').tap();
    await page.locator('#h5-copy').waitFor({ state: 'hidden' });

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
    assert.deepEqual(await page.locator('.h5-task-item').evaluateAll(nodes => nodes.map(node => [node.textContent, node.getAttribute('aria-expanded')])), [['Fix login', 'false'], ['Write docs', 'true']], 'one task is open at a time');
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
    await page.locator('.h5-task-item', { hasText: 'Fix login' }).tap();
    await page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main', { hasText: 'Cross chat' }).tap();
    await page.locator('#h5-agent .agent-chat').waitFor();
    assert.equal(await page.locator('#h5-task-name').textContent(), 'Fix login');
    assert.equal(await page.locator('#h5-session-name').textContent(), 'Cross chat');
    await pollUntil(() => openOnServer() > 0);

    // Settings: the header button opens a menu with the language toggle and the PC one-click update.
    assert.equal(await page.locator('#h5-open-settings').textContent(), '⚙');
    await page.locator('#h5-open-settings').tap();
    await page.locator('#h5-settings').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#h5-settings [data-lang-toggle]').count(), 1);
    await page.locator('#h5-update-check').tap();
    // One tap checks and starts the update; there is no second confirmation.
    await page.waitForFunction(() => document.getElementById('h5-update-log').textContent.includes('npm ci'));
    assert.ok(calls.includes('POST /api/system/apply-update'));
    assert.equal(await page.locator('#h5-update-confirm').count(), 0, 'no confirmation step is left');
    await context.close();

    // Opened on a computer, the page stays a centred phone-sized column.
    const wide = await openPage(browser, { viewport: { width: 1440, height: 900 } });
    await wide.page.locator('#h5-tasks').waitFor({ state: 'visible' });
    const sheetBox = await wide.page.locator('#h5-tasks').boundingBox();
    assert.deepEqual([sheetBox.width, sheetBox.x], [480, 480]);
    await openTask(wide.page, 'Fix login', 'click');
    const appBox = await wide.page.locator('#h5-app').boundingBox();
    assert.deepEqual([appBox.width, appBox.x], [480, 480]);
    assert.equal(await wide.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await wide.page.waitForFunction(() => window.sockets.length === 1);
    await wide.page.evaluate(() => window.sockets[0].emit(JSON.stringify({ type: 'history', data: 'x', cols: 80, rows: 24 })));
    await wide.page.waitForTimeout(100);
    const cols = await wide.page.evaluate(() => window.sockets[0].sent.map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(item => item?.type === 'resize').pop().cols);
    assert.ok(cols < 70, `the terminal fits the 480px column (${cols} columns)`);
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
        await remote.page.evaluate(() => {
          const select = document.getElementById('h5-engine');
          select.value = 'local';
          select.dispatchEvent(new Event('change'));
        });
        await remote.page.locator('#h5-agent').waitFor({ state: 'hidden' });
      } else {
        assert.equal(await remote.page.locator('#h5-term-menu-actions button', { hasText: 'Codex agent' }).count(), 0);
      }
      await remote.context.close();
    }
    console.log('Phone page layout, phone terminals, keys, paste, image upload, translate-and-send and old-engine guard passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
