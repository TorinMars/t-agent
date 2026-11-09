// The task list does not offer agent chats (public/js/h5.js, scripts/h5-shell/TaskDrawer.jsx), in real Chromium at phone size and computer size, on this machine and on a
// remote Engine that has chats. The server still holds chats, one of them marked as open on the page, and the browser still points at it: no chat row, no way to create one,
// no read of the chat list; the page shows a terminal as it does for a session that is gone. Terminals keep their actions. A notification link still opens its chat.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const RESTART = 'Restart in the working directory';
const pageErrors = [];

const chatRow = (id, title, opened = null) => ({ id, agent: 'claude', session_id: null, title, mode: 'ask', running: false, pending: false, opened: { web: null, h5: opened } });

async function openPage(browser, { wide, remote }) {
  const context = await browser.newContext(wide ? { viewport: { width: 1440, height: 900 } } : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  const ids = remote ? { alpha: 9, beta: 10, gamma: 11 } : { alpha: 1, beta: 2, gamma: 3 };
  const base = remote ? '/api/remote-servers/7/tasks' : '/api/tasks';
  const key = remote ? 'remote:7' : 'local';
  await page.addInitScript(({ alpha, key: engine }) => {
    window.wsAll = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; window.wsAll.push(this); setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } }, 0); }
      send() {}
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    // What an earlier version left in this browser: the task, a chat id where a terminal id is expected, and the record of the open chat.
    localStorage.setItem('h5-source', engine);
    localStorage.setItem(`h5-task:${engine}`, String(alpha));
    localStorage.setItem(`h5-terminal:${engine}:${alpha}`, 'open-chat');
    localStorage.setItem(`h5-agent:${engine}:${alpha}`, 'open-chat');
  }, { alpha: ids.alpha, key });
  const terminalsOf = id => [{ terminal_id: 'default', title: 'Terminal 1' }, { terminal_id: `t${id}-2`, title: 'Terminal 2' }];
  const server = {
    lists: new Map([
      [ids.alpha, { terminals: terminalsOf(ids.alpha), chats: [chatRow('open-chat', 'Alpha chat', Date.now())] }],
      [ids.beta, { terminals: terminalsOf(ids.beta), chats: [chatRow('beta-chat', 'Beta chat')] }],
      [ids.gamma, { terminals: [], chats: [chatRow('gamma-chat', 'Gamma chat')] }], // only a chat: it counts as a task with no sessions
    ]),
    writes: [],
    chatCalls: [],
  };
  const taskList = [{ id: ids.alpha, title: 'Alpha', status: 'doing' }, { id: ids.beta, title: 'Beta', status: 'doing' }, { id: ids.gamma, title: 'Gamma', status: 'doing' }];
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const { pathname } = url;
    if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
    if (pathname === '/api/remote-servers') return json(remote ? [{ id: 7, name: 'VPS' }] : []);
    if (pathname === '/api/remote-servers/7/info') return json({ capabilities: ['agent-chat:manage', 'terminal:control'] });
    if (pathname === base && method === 'GET') return json(taskList);
    if (remote && pathname === '/api/tasks' && method === 'GET') return json([]);
    if (/\/task-groups$/.test(pathname)) return json([{ key: 'doing', name: 'Doing', sort_order: 1 }]);
    if (!pathname.startsWith(`${base}/`)) return json({ error: 'not mocked' }, 404);
    const rest = pathname.slice(base.length + 1).split('/');
    const list = server.lists.get(Number(rest[0]));
    if (!list) return json({ error: 'not mocked' }, 404);
    const tail = rest.slice(1).join('/');
    if (tail.startsWith('agent/')) server.chatCalls.push(`${method} ${tail}`);
    if (tail === 'terminals' && method === 'GET') return json(list.terminals);
    if (tail === 'terminal/ack') return json({ success: true });
    if (tail === 'terminal/control' && method === 'POST') {
      const body = route.request().postDataJSON();
      server.writes.push(['POST', pathname, body]);
      if (body.action === 'delete') list.terminals = list.terminals.filter(row => row.terminal_id !== body.terminal_id);
      return json({ success: true, action: body.action });
    }
    const named = tail.match(/^terminals\/([^/]+)$/);
    if (named && method === 'PATCH') {
      const body = route.request().postDataJSON();
      server.writes.push(['PATCH', pathname, body]);
      const entry = list.terminals.find(row => row.terminal_id === decodeURIComponent(named[1]));
      if (entry) entry.title = body.title;
      return json({ title: body.title });
    }
    if (tail === 'agent/conversations' && method === 'GET') return json(list.chats);
    if (tail === 'agent/conversations/open-chat' && method === 'GET') return json({ conversation: { id: 'open-chat' }, items: [{ id: 'u1', kind: 'user', text: 'hello agent' }], pending: [], status: 'idle', seq: 0 });
    if (tail === 'agent/conversations/open-chat/events') return route.fulfill({ contentType: 'text/event-stream', body: ': ok\n\n' });
    return json({ error: 'not mocked' }, 404);
  });
  page.on('dialog', dialog => dialog.accept());
  await page.goto(`${ORIGIN}/h5`);
  return { context, page, server, ids, base };
}

function helpers({ page, wide }) {
  const press = locator => (wide ? locator.click() : locator.tap());
  const list = name => page.locator(`#h5-tasks .h5-terminal-list[aria-label="${name}"]`);
  const row = (name, title) => list(name).locator('.h5-terminal-row').filter({ has: page.locator('.h5-terminal-name', { hasText: title }) });
  const names = name => list(name).locator('.h5-terminal-name').allTextContents();
  const item = name => page.locator('.h5-task-item', { hasText: name });
  const actions = page.locator('#h5-term-menu #h5-term-menu-actions button');
  const action = label => page.locator('#h5-term-menu #h5-term-menu-actions button', { hasText: label });
  const openMenu = async (name, title) => { await press(row(name, title).locator('.h5-terminal-more')); await actions.first().waitFor(); };
  const closeMenu = async () => { await press(page.locator('#h5-term-menu-cancel')); await page.locator('#h5-term-menu .h5-menu-panel').waitFor({ state: 'hidden' }); };
  const openSheet = async () => { if (!wide && !(await page.locator('#h5-tasks').isVisible())) await page.locator('#h5-open-tasks').tap(); await page.locator('#h5-tasks .h5-task-item').first().waitFor(); };
  const shown = async (taskId, id) => {
    await page.waitForFunction(([task, terminal]) => { const el = document.querySelector('.h5-xterm:not([hidden])'); return el && el.dataset.taskId === String(task) && el.dataset.terminalId === terminal; }, [taskId, id]);
    if (!wide) await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
  };
  return { press, list, row, names, item, actions, action, openMenu, closeMenu, openSheet, shown };
}

const assertNoChatMarks = async (page, label) => {
  assert.equal(await page.locator('#h5-tasks .h5-agent-badge, #h5-tasks .h5-robot, #h5-tasks .h5-subagent-row').count(), 0, `${label}: nothing in the list is marked as a chat`);
  assert.equal(await page.locator('#h5-tasks [aria-label="Chat actions"]').count(), 0, `${label}: no chat actions`);
  assert.equal(await page.locator('#h5-tasks .h5-terminal-name', { hasText: /chat/i }).count(), 0, `${label}: no chat is listed`);
};

async function check(env, h, { wide, remote, label }) {
  const { page, server, ids, base } = env;
  const { alpha, beta, gamma } = ids;

  // ── A chat that was open and a saved pointer to it: the page comes back on a terminal, never on a blank view ──
  await h.shown(alpha, 'default');
  await page.waitForTimeout(400); // a restored chat would be mounted by now
  assert.equal(await page.locator('#h5-agent').isHidden(), true, `${label}: the chat view stays hidden`);
  assert.equal(await page.locator('#h5-agent .agent-chat').count(), 0, `${label}: no chat is mounted`);
  assert.equal(await page.locator('#h5-task-name').textContent(), 'Alpha', `${label}: the saved task`);
  assert.equal(await page.locator('#h5-session-name').textContent(), 'Terminal 1', `${label}: the first terminal, as for a saved session that is gone`);

  // ── The list: terminals only, under the selected task and the others, and the count follows ──
  await h.openSheet();
  await h.list('Phone terminals').locator('.h5-terminal-name').nth(1).waitFor();
  assert.deepEqual(await h.names('Phone terminals'), ['Terminal 1', 'Terminal 2'], `${label}: the selected task lists its terminals`);
  await h.item('Alpha').locator('.h5-task-count', { hasText: '2 sessions' }).waitFor();
  await h.press(h.item('Beta'));
  await h.row('Beta', 'Terminal 2').waitFor();
  assert.deepEqual(await h.names('Beta'), ['Terminal 1', 'Terminal 2'], `${label}: another task lists its terminals`);
  await h.item('Beta').locator('.h5-task-count', { hasText: '2 sessions' }).waitFor();
  await h.press(h.item('Gamma'));
  await h.list('Gamma').locator('.h5-terminal-name', { hasText: 'Open this task' }).waitFor();
  assert.deepEqual(await h.names('Gamma'), ['Open this task'], `${label}: a task with only a chat is a task with no sessions`);
  await h.item('Gamma').locator('.h5-task-count', { hasText: '0 sessions' }).waitFor();
  await assertNoChatMarks(page, label);

  // ── The "+": terminals and Claude / Codex terminal sessions, and no chat, also after the Engine has answered what it can do ──
  await h.press(page.locator('#h5-tasks .h5-task-row:has(.h5-task-item[aria-current="true"]) .h5-task-add'));
  await page.locator('#h5-new-session #h5-term-menu-actions button').first().waitFor();
  await page.waitForTimeout(300);
  assert.deepEqual(await page.locator('#h5-new-session #h5-term-menu-actions button').allTextContents(), ['New Terminal', 'Claude session', 'Codex session'], `${label}: the Session list`);
  await h.press(page.locator('#h5-tasks .h5-task-row:has(.h5-task-item[aria-current="true"]) .h5-task-add'));
  await page.locator('#h5-new-session').waitFor({ state: 'detached' });

  // ── Terminals keep their actions, under the selected task and the others ──
  await h.openMenu('Phone terminals', 'Terminal 2');
  assert.deepEqual(await h.actions.allTextContents(), ['Rename', 'Reopen', RESTART, 'Delete'], `${label}: the actions of a terminal of the selected task`);
  await h.closeMenu();
  await h.openMenu('Beta', 'Terminal 1');
  assert.deepEqual(await h.actions.allTextContents(), ['Rename', 'Open', RESTART, 'Delete'], `${label}: the actions of a terminal of another task`);
  await h.press(h.action('Rename'));
  await page.locator('#h5-term-rename-input').fill('Docs shell');
  await page.locator('#h5-term-rename-input').press('Enter');
  await h.row('Beta', 'Docs shell').waitFor();
  assert.deepEqual(server.writes.at(-1), ['PATCH', `${base}/${beta}/terminals/default`, { title: 'Docs shell' }], `${label}: rename reaches that terminal`);
  await h.openMenu('Beta', 'Docs shell');
  await h.press(h.action(RESTART));
  await page.waitForFunction(() => !document.querySelector('#h5-term-menu .h5-menu-panel') || !document.querySelector('#h5-term-menu .h5-menu-panel').checkVisibility());
  assert.deepEqual(server.writes.at(-1), ['POST', `${base}/${beta}/terminal/control`, { action: 'restart-workdir', terminal_id: 'default' }], `${label}: restart reaches that terminal`);
  await h.openMenu('Beta', 'Terminal 2');
  await h.press(h.action('Delete'));
  await h.row('Beta', 'Terminal 2').waitFor({ state: 'detached' });
  assert.deepEqual(server.writes.at(-1), ['POST', `${base}/${beta}/terminal/control`, { action: 'delete', terminal_id: `t${beta}-2` }], `${label}: delete reaches that terminal`);
  await h.openMenu('Beta', 'Docs shell');
  await h.press(h.action('Open'));
  await h.shown(beta, 'default');
  assert.equal(await page.locator('#h5-task-name').textContent(), 'Beta', `${label}: Open goes to that task`);
  await h.openSheet();
  await h.list('Phone terminals').locator('.h5-terminal-name', { hasText: 'Docs shell' }).waitFor();
  await assertNoChatMarks(page, `${label} after moving`);

  // ── The task list did not read a chat ──
  assert.deepEqual(server.chatCalls, [], `${label}: no request about chats (${server.chatCalls.join(', ')})`);
  assert.equal(server.lists.get(gamma).chats.length, 1, `${label}: the chats are still kept`);

  // ── A notification link still reaches its chat; the chat is left by choosing a terminal; a link to a chat that is gone shows the terminal (this machine only, as before) ──
  if (remote) return;
  await page.goto(`${ORIGIN}/h5?openChat=${alpha}:open-chat`);
  await page.locator('#h5-agent .agent-chat').waitFor();
  await page.locator('#h5-agent .ac-bubble', { hasText: 'hello agent' }).waitFor();
  assert.equal(await page.locator('#h5-session-name').textContent(), 'Alpha chat', `${label}: the header names the chat of the link`);
  await h.openSheet();
  await h.list('Phone terminals').locator('.h5-terminal-name').first().waitFor();
  await assertNoChatMarks(page, `${label} with a chat open`);
  assert.equal(await page.locator('#h5-tasks .h5-terminal-main[aria-current="true"]').count(), 0, `${label}: no terminal is current while the chat covers it`);
  await h.press(h.row('Phone terminals', 'Terminal 1').locator('.h5-terminal-main'));
  await page.locator('#h5-agent').waitFor({ state: 'hidden' });
  await h.shown(alpha, 'default');
  await page.goto(`${ORIGIN}/h5?openChat=${alpha}:gone`);
  await h.shown(alpha, 'default');
  assert.equal(await page.locator('#h5-agent').isHidden(), true, `${label}: a link to a chat that is gone shows the terminal`);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const remote of [false, true]) {
      for (const wide of [false, true]) {
        const label = `${remote ? 'remote' : 'local'} ${wide ? 'PC' : 'phone'}`;
        const env = await openPage(browser, { wide, remote });
        await check(env, helpers({ page: env.page, wide }), { wide, remote, label });
        await env.context.close();
        console.log(`  ${label}: ok`);
      }
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log('The task list has no agent chats and no way to create one (phone, PC, local, remote); saved pointers to a chat recover; terminals keep their actions; notification links still open a chat.');
})().catch(error => { console.error(error); process.exit(1); });
