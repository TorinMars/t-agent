// Restart and Delete from the "⋯" of a session under a task that is not selected (public/js/h5.js, openOtherMenu and the functions that take a target), in real
// Chromium at phone size and computer size, on this machine and on a remote Engine, with a mocked server that remembers what was deleted. Every task has a terminal
// `default`, so the key case is that the row's own task is hit, its warm view in the page is closed, and the terminal `default` of the selected task (row, xterm, socket) is left alone.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const RESTART = 'Restart in the working directory';
const pageErrors = [];

function freshServer(ids) {
  const lists = new Map();
  const terminalsOf = id => Array.from({ length: 4 }, (_, i) => ({ terminal_id: i ? `t${id}-${i + 1}` : 'default', title: `Terminal ${i + 1}` }));
  lists.set(ids.alpha, { terminals: terminalsOf(ids.alpha) });
  lists.set(ids.beta, { terminals: terminalsOf(ids.beta) });
  lists.set(ids.gamma, { terminals: terminalsOf(ids.gamma).slice(0, 1) });
  return { lists, writes: [], fail: null, holdLists: [], holdControl: null };
}

async function openPage(browser, { wide, remote, capabilities = ['agent-chat:manage', 'terminal:control'] }) {
  const context = await browser.newContext(wide ? { viewport: { width: 1440, height: 900 } } : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.wsAll = [];
    window.sent = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; window.wsAll.push(this); setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } }, 0); }
      send(data) { window.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
  });
  const ids = remote ? { alpha: 9, beta: 10, gamma: 11 } : { alpha: 1, beta: 2, gamma: 3 };
  const base = remote ? '/api/remote-servers/7/tasks' : '/api/tasks';
  const server = freshServer(ids);
  const taskList = [{ id: ids.alpha, title: 'Alpha', status: 'doing' }, { id: ids.beta, title: 'Beta', status: 'doing' }, { id: ids.gamma, title: 'Gamma', status: 'doing' }];
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const { pathname } = url;
    if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
    if (pathname === '/api/remote-servers') return json(remote ? [{ id: 7, name: 'VPS' }] : []);
    if (pathname === '/api/remote-servers/7/info') return json({ capabilities });
    if (pathname === base && method === 'GET') return json(taskList);
    if (remote && pathname === '/api/tasks' && method === 'GET') return json([{ id: 99, title: 'On this machine', status: 'doing' }]);
    if (/\/task-groups$/.test(pathname)) return json([{ key: 'doing', name: 'Doing', sort_order: 1 }]);
    if (!pathname.startsWith(`${base}/`)) return json({ error: 'not mocked' }, 404);
    const rest = pathname.slice(base.length + 1).split('/');
    const taskId = Number(rest[0]);
    const list = server.lists.get(taskId);
    if (!list) return json({ error: 'not mocked' }, 404);
    const tail = rest.slice(1).join('/');
    if (tail === 'terminals' && method === 'GET') {
      const answer = JSON.stringify(list.terminals);
      const hold = server.holdLists.find(entry => entry.taskId === taskId && !entry.seen);
      if (hold) { hold.seen = true; await hold.released; }
      return route.fulfill({ contentType: 'application/json', body: answer });
    }
    if (tail === 'terminal/ack') return json({ success: true });
    if (tail === 'terminal/control' && method === 'POST') {
      const body = route.request().postDataJSON();
      server.writes.push(['POST', pathname, body]);
      if (server.holdControl) { const hold = server.holdControl; server.holdControl = null; hold.seen = true; await hold.released; }
      if (server.fail === 'control') { server.fail = null; return json({ error: 'BOOM' }, 500); }
      if (body.action === 'delete') list.terminals = list.terminals.filter(row => row.terminal_id !== body.terminal_id);
      return json({ success: true, action: body.action });
    }
    const named = tail.match(/^terminals\/([^/]+)$/);
    if (named && method === 'PATCH') {
      const entry = list.terminals.find(row => row.terminal_id === decodeURIComponent(named[1]));
      if (entry) entry.title = route.request().postDataJSON().title;
      return json({ title: entry && entry.title });
    }
    return json({ error: 'not mocked' }, 404);
  });
  const dialogs = [];
  const answers = { next: 'accept' };
  page.on('dialog', dialog => { dialogs.push(dialog.message()); return answers.next === 'accept' ? dialog.accept() : dialog.dismiss(); });
  await page.goto(`${ORIGIN}/h5`);
  return { context, page, server, ids, base, dialogs, answers };
}

function helpers({ page, wide }) {
  const press = locator => (wide ? locator.click() : locator.tap());
  const list = name => page.locator(`#h5-tasks .h5-terminal-list[aria-label="${name}"]`);
  const row = (name, title) => list(name).locator('.h5-terminal-row').filter({ has: page.locator('.h5-terminal-name', { hasText: title }) });
  const names = name => list(name).locator('.h5-terminal-name').allTextContents();
  const item = name => page.locator('.h5-task-item', { hasText: name });
  const actions = page.locator('#h5-session-menu [role="menuitem"]');
  const action = label => page.locator('#h5-session-menu [role="menuitem"]', { hasText: label });
  const openMenu = async (name, title) => { await press(row(name, title).locator('.h5-terminal-more')); await actions.first().waitFor(); };
  const closeMenu = async () => { await page.keyboard.press('Escape'); await actions.first().waitFor({ state: 'detached' }); };
  const openSheet = async () => { if (!wide && !(await page.locator('#h5-tasks').isVisible())) await page.locator('#h5-open-tasks').tap(); await page.locator('#h5-tasks .h5-task-item').first().waitFor(); };
  // That terminal is on the page; on a phone the sheet has finished closing (a sheet still sliding away would count as open).
  const shown = async (taskId, id) => {
    await page.waitForFunction(([task, terminal]) => { const el = document.querySelector('.h5-xterm:not([hidden])'); return el && el.dataset.taskId === String(task) && el.dataset.terminalId === terminal; }, [taskId, id]);
    if (!wide) await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
  };
  // Closes (when open) and opens the list of a task: a new read from the server.
  const reread = async name => {
    if (await item(name).getAttribute('aria-expanded') === 'true') { await press(item(name)); await list(name).waitFor({ state: 'detached' }); }
    await press(item(name));
    await list(name).locator('.h5-terminal-name').first().waitFor();
  };
  const views = (taskId, id) => page.locator(`.h5-xterm[data-task-id="${taskId}"][data-terminal-id="${id}"]`).count();
  const socket = (taskId, id) => page.evaluate(([task, terminal]) => window.wsAll.filter(ws => ws.url.includes(`taskId=${task}&terminalId=${encodeURIComponent(terminal)}`)).map(ws => ws.readyState), [taskId, id]);
  const state = () => page.evaluate(() => {
    const el = document.querySelector('.h5-xterm:not([hidden])');
    return { task: document.getElementById('h5-task-name').textContent, session: document.getElementById('h5-session-name').textContent, shownTask: el && el.dataset.taskId, shownTerminal: el && el.dataset.terminalId, sockets: window.wsAll.length, open: window.wsAll.filter(ws => ws.readyState === 1).length };
  });
  const toast = text => page.locator('.MuiSnackbar-root [role="status"]', { hasText: text }).waitFor({ timeout: 5000 });
  return { press, list, row, names, item, actions, action, openMenu, closeMenu, openSheet, shown, reread, views, socket, state, toast };
}

// Task Beta opened on two terminals (they stay warm, hidden), then task Alpha opened on its `default`; the sheet is open with the sessions of Beta and Gamma listed.
async function setup(env, h, { remote }) {
  const { page, ids } = env;
  await h.openSheet();
  if (remote) await h.item('Beta').waitFor();
  await h.press(h.item('Beta'));
  await h.press(h.row('Beta', 'Terminal 1').locator('.h5-terminal-main'));
  await h.shown(ids.beta, 'default');
  await h.openSheet();
  await h.press(h.row('Phone terminals', 'Terminal 2').locator('.h5-terminal-main'));
  await h.shown(ids.beta, `t${ids.beta}-2`);
  await h.openSheet();
  await h.press(h.item('Alpha'));
  await h.press(h.row('Alpha', 'Terminal 1').locator('.h5-terminal-main'));
  await h.shown(ids.alpha, 'default');
  await h.openSheet();
  await h.reread('Beta');
  await h.reread('Gamma');
  await h.list('Beta').locator('.h5-terminal-name').nth(3).waitFor();
}

async function checkOtherTask(env, h, { wide, remote, label }) {
  const { page, server, ids, base, dialogs, answers } = env;
  const { alpha, beta, gamma } = ids;
  const control = `${base}/${beta}/terminal/control`;
  const before = await h.state();
  assert.equal(before.task, 'Alpha', `${label}: the task shown`);
  assert.equal(await h.views(beta, 'default'), 1, `${label}: Beta's default is warm in the page`);
  assert.equal(await h.views(beta, `t${beta}-2`), 1, `${label}: Beta's second terminal is warm in the page`);
  const untouched = async text => {
    await page.waitForTimeout(150);
    const now = await h.state();
    for (const key of ['task', 'session', 'shownTask', 'shownTerminal']) assert.equal(now[key], before[key], `${label}: ${text}: ${key} of the page`);
    assert.equal(now.sockets, before.sockets, `${label}: ${text}: no new socket`);
    assert.equal(await h.views(alpha, 'default'), 1, `${label}: ${text}: the view of the selected task's default stays`);
    assert.equal((await h.socket(alpha, 'default')).at(-1), 1, `${label}: ${text}: the socket of the selected task's default stays open`);
    assert.ok((await h.names('Phone terminals')).includes('Terminal 1'), `${label}: ${text}: the row of the selected task's default stays`);
    const focus = await page.evaluate(() => { const el = document.activeElement && document.activeElement.closest('.h5-xterm'); return el ? { hidden: el.hidden, task: el.dataset.taskId, terminal: el.dataset.terminalId } : null; });
    if (!wide) assert.equal(focus, null, `${label}: ${text}: no terminal took the focus (no keyboard pops up)`);
    else if (focus) assert.deepEqual(focus, { hidden: false, task: String(alpha), terminal: 'default' }, `${label}: ${text}: the focus stays with the terminal shown`);
    if (!wide) assert.equal(await page.locator('#h5-tasks').isVisible(), true, `${label}: ${text}: the sheet stays open`);
  };

  // ── What the sheet offers, with the danger style ──
  await h.openMenu('Beta', 'Terminal 1');
  // This machine sorts sessions (Move up / Move down where the row can go); the mocked remote Engine does not say 'terminals:order'.
  const moves = steps => (remote ? [] : steps);
  assert.deepEqual(await h.actions.allTextContents(), ['Rename', 'Open', ...moves(['Move down']), RESTART, 'Delete'], `${label}: terminal actions`);
  assert.deepEqual(await h.actions.evaluateAll(nodes => nodes.map(node => node.classList.contains('danger'))), [false, false, ...moves([false]), true, true], `${label}: the same danger style`);
  await h.closeMenu();

  // ── Cancel in the confirmation sends nothing and names the session and the task ──
  answers.next = 'dismiss';
  for (const [title, name, words] of [['Terminal 1', 'Delete', 'Delete this terminal'], ['Terminal 1', RESTART, 'clears its history']]) {
    await h.openMenu('Beta', title);
    await h.press(h.action(name));
    assert.ok(dialogs.at(-1).includes(words), `${label}: the same question (${dialogs.at(-1)})`);
    assert.ok(dialogs.at(-1).includes(title) && dialogs.at(-1).includes('Beta'), `${label}: it names the session and the task (${dialogs.at(-1)})`);
    await h.actions.first().waitFor({ state: 'detached' }); // the popup closes when an item is chosen, whatever the answer
  }
  assert.deepEqual(server.writes, [], `${label}: Cancel sends nothing`);
  answers.next = 'accept';
  await untouched('cancel');

  // ── Restart of Beta's `default`: the request goes to Beta, its warm view is closed, the selected task's `default` is not ──
  await h.openMenu('Beta', 'Terminal 1');
  await h.press(h.action(RESTART));
  await h.actions.first().waitFor({ state: 'detached' });
  await page.waitForFunction(([task]) => !document.querySelector(`.h5-xterm[data-task-id="${task}"][data-terminal-id="default"]`), [beta]);
  assert.deepEqual(server.writes, [['POST', control, { action: 'restart-workdir', terminal_id: 'default' }]], `${label}: restart of that task's default`);
  assert.equal((await h.socket(beta, 'default')).at(-1), 3, `${label}: the socket of the restarted terminal is closed`);
  assert.ok((await h.names('Beta')).includes('Terminal 1'), `${label}: the restarted row stays`);
  await untouched('restart');
  server.writes.length = 0;

  // ── A server error: the notice, the row stays, the view stays ──
  server.fail = 'control';
  await h.openMenu('Beta', 'Terminal 4');
  await h.press(h.action('Delete'));
  await h.toast('Could not delete the terminal');
  assert.ok((await h.names('Beta')).includes('Terminal 4'), `${label}: the row stays after an error`);
  server.fail = 'control';
  await h.openMenu('Beta', 'Terminal 4');
  await h.press(h.action(RESTART));
  await h.toast('Could not restart the terminal');
  await untouched('errors');
  server.writes.length = 0;

  // ── An older read still on its way does not bring a deleted row back: a rename starts a read of Beta that is held, then the second terminal is deleted ──
  // The older answer arrives first (it must not count), then the read made after the delete.
  const gate = () => { const hold = { taskId: beta, seen: false }; hold.released = new Promise(resolve => { hold.release = resolve; }); return hold; };
  const older = gate();
  const newer = gate();
  server.holdLists.push(older, newer);
  await h.openMenu('Beta', 'Terminal 3');
  await h.press(h.action('Rename'));
  await page.locator('#h5-term-rename-input').fill('Logs');
  await page.locator('#h5-term-rename-input').press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#h5-term-rename-input').length === 0);
  await h.row('Beta', 'Logs').waitFor();
  while (!older.seen) await page.waitForTimeout(20);
  await h.openMenu('Beta', 'Terminal 2');
  await h.press(h.action('Delete'));
  await h.row('Beta', 'Terminal 2').waitFor({ state: 'detached' });
  assert.equal(await h.views(beta, `t${beta}-2`), 0, `${label}: the warm view of the deleted terminal is gone`);
  assert.equal((await h.socket(beta, `t${beta}-2`)).at(-1), 3, `${label}: and its socket is closed`);
  assert.deepEqual(server.writes, [['POST', control, { action: 'delete', terminal_id: `t${beta}-2` }]], `${label}: delete of that terminal`);
  while (!newer.seen) await page.waitForTimeout(20);
  older.release();
  await page.waitForTimeout(300);
  assert.equal(await h.row('Beta', 'Terminal 2').count(), 0, `${label}: the older read did not bring it back`);
  newer.release();
  await page.waitForTimeout(300);
  assert.equal(await h.row('Beta', 'Terminal 2').count(), 0, `${label}: nor did the read after the delete`);
  server.holdLists.length = 0;
  server.writes.length = 0;

  // ── The key case: delete Beta's `default`; Alpha's `default` is untouched ──
  await h.openMenu('Beta', 'Terminal 1');
  await h.press(h.action('Delete'));
  await h.row('Beta', 'Terminal 1').waitFor({ state: 'detached' });
  assert.deepEqual(server.writes, [['POST', control, { action: 'delete', terminal_id: 'default' }]], `${label}: Beta's default and nothing else`);
  assert.ok(server.lists.get(alpha).terminals.some(row => row.terminal_id === 'default'), `${label}: the selected task's default still exists on the server`);
  assert.equal(await h.views(beta, 'default'), 0, `${label}: no view of Beta's default in the page`);
  await untouched('delete default');
  await h.reread('Beta');
  assert.equal(await h.row('Beta', 'Terminal 1').count(), 0, `${label}: gone after the list is read again`);
  await h.row('Beta', 'Logs').waitFor();
  await untouched('read again');
  server.writes.length = 0;

  // ── The last row of a task ──
  await h.openMenu('Gamma', 'Terminal 1');
  await h.press(h.action('Delete'));
  await h.list('Gamma').locator('.h5-terminal-name', { hasText: 'Open this task' }).waitFor();
  assert.deepEqual(server.writes, [['POST', `${base}/${gamma}/terminal/control`, { action: 'delete', terminal_id: 'default' }]], `${label}: the last terminal of Gamma`);
  await untouched('last row');
  server.writes.length = 0;

  // ── The selected task's own actions behave as before ──
  await h.openMenu('Phone terminals', 'Terminal 3');
  assert.deepEqual(await h.actions.allTextContents(), ['Rename', 'Reopen', ...moves(['Move up', 'Move down']), RESTART, 'Delete'], `${label}: own terminal actions`);
  await h.press(h.action(RESTART));
  await h.shown(alpha, `t${alpha}-3`);
  assert.deepEqual(server.writes, [['POST', `${base}/${alpha}/terminal/control`, { action: 'restart-workdir', terminal_id: `t${alpha}-3` }]], `${label}: own restart`);
  assert.ok(!dialogs.at(-1).includes('Alpha'), `${label}: the selected task's question is unchanged (${dialogs.at(-1)})`);
  server.writes.length = 0;
  await h.openSheet();
  await h.openMenu('Phone terminals', 'Terminal 3');
  await h.press(h.action('Delete'));
  await h.shown(alpha, 'default'); // the shown terminal is deleted: the first one is shown
  assert.deepEqual(server.writes, [['POST', `${base}/${alpha}/terminal/control`, { action: 'delete', terminal_id: `t${alpha}-3` }]], `${label}: own delete`);
  await h.openSheet();
  await h.row('Phone terminals', 'Terminal 3').waitFor({ state: 'detached' });
  server.writes.length = 0;

  // ── The selection moves to that task while the action runs: the list ends up correct and the deleted terminal is not connected ──
  await h.reread('Beta');
  let free;
  const hold = { released: new Promise(resolve => { free = resolve; }), seen: false };
  server.holdControl = hold;
  await h.openMenu('Beta', 'Logs');
  await h.press(h.action('Delete'));
  while (!hold.seen) await page.waitForTimeout(20);
  await h.press(h.row('Beta', 'Logs').locator('.h5-terminal-main')); // the very terminal that is being deleted: its row is still there
  await page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'Beta');
  free();
  await h.shown(beta, `t${beta}-4`);
  await h.openSheet();
  await h.row('Phone terminals', 'Terminal 4').waitFor();
  assert.equal(await h.row('Phone terminals', 'Logs').count(), 0, `${label}: the deleted row is not in the list of the task now selected`);
  assert.equal(await h.views(beta, `t${beta}-3`), 0, `${label}: and it has no view`);
  assert.deepEqual(await h.socket(beta, `t${beta}-3`), [], `${label}: and it was never connected`);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const remote of [false, true]) {
      for (const wide of [false, true]) {
        const label = `${remote ? 'remote' : 'local'} ${wide ? 'PC' : 'phone'}`;
        const env = await openPage(browser, { wide, remote });
        const h = helpers({ page: env.page, wide });
        await setup(env, h, { remote });
        await checkOtherTask(env, h, { wide, remote, label });
        await env.context.close();
        console.log(`  ${label}: ok`);
      }
    }
    // A remote Engine that says it cannot control terminals: those two actions are not offered.
    const env = await openPage(browser, { wide: true, remote: true, capabilities: ['agent-chat:manage'] });
    const h = helpers({ page: env.page, wide: true });
    await setup(env, h, { remote: true });
    await h.openMenu('Beta', 'Terminal 1');
    assert.deepEqual(await h.actions.allTextContents(), ['Rename', 'Open'], 'no Restart or Delete without terminal:control');
    await env.context.close();
  } finally {
    await browser.close();
  }
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log('Restart and Delete of a session under a task that is not selected passed (phone, PC, local, remote).');
})().catch(error => { console.error(error); process.exit(1); });
