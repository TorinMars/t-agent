// Archiving tasks on the page in real Chromium at 390px (touch), 1440px (mouse) and 320px: the "Archive" item of a task's menu, the confirmation with and without running
// terminals, archiving the shown task and another one, the Archived section read on demand, Restore, Delete from it, a remote Engine with and without 'tasks:archive',
// a page that learns from `TASK_ARCHIVED` that another device archived its task, and an older server process that does not implement archiving. The server is mocked. H5_SHOT_DIR=<dir> saves screenshots at 390px.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const ARCHIVED_AT = '2026-11-09 08:30:00';
// A long title with no spaces in Chinese ("a very long task title ..."), written with escapes: it must wrap inside the row at 320px.
const LONG = '\u4e00\u4e2a\u975e\u5e38\u975e\u5e38\u957f\u7684\u4efb\u52a1\u6807\u9898'.repeat(5);
const bare = (id, title) => ({ id, title, status: 'doing', work_dir: `/w/${id}` }); // a row of a server from before archiving: no `archived_at` key
const task = (id, title) => ({ ...bare(id, title), archived_at: null }); // a row of a current server: the key is always there
const CANNOT_POST = pathname => `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot POST ${pathname}</pre>\n</body>\n</html>\n`; // Express, for a route it does not have

// What the mocked server holds. `bases` is `/api/tasks` and the remote proxy of each Engine: { tasks, archived }.
function makeServer() {
  const server = {
    pageErrors: [], requests: [], activity: {}, createRefused: false,
    bases: {
      '/api/tasks': { tasks: [task(1, 'Alpha'), task(2, 'Beta'), task(3, 'Gamma')], archived: [] },
      '/api/remote-servers/7/tasks': { tasks: [bare(70, 'Old engine task')], archived: [] },
      // Without the key on purpose: a remote Engine is decided by its capability alone.
      '/api/remote-servers/8/tasks': { tasks: [bare(80, 'New engine task')], archived: [] }, // its archived row is added when the one list is tested, so the local steps count local rows only
    },
    capabilities: { 7: ['terminal:control'], 8: ['terminal:control', 'tasks:archive'] },
  };
  server.count = (method, url) => server.requests.filter(entry => entry === `${method} ${url}`).length;
  return server;
}

async function openPage(browser, server, viewport, touch) {
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...(process.env.H5_SHOT_DIR ? { deviceScaleFactor: 3 } : {}) });
  const page = await context.newPage();
  page.on('pageerror', error => server.pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; window.sockets.push(this); setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } }, 0); }
      send() {}
      close() { this.readyState = 3; }
      serverClose(code, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    window.taskSockets = id => window.sockets.filter(socket => new URL(socket.url).searchParams.get('taskId') === String(id));
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
    server.requests.push(`${method} ${pathname}${url.search}`);
    if (pathname === '/api/remote-servers') return json([{ id: 7, name: 'Old engine' }, { id: 8, name: 'New engine' }]);
    const info = pathname.match(/^\/api\/remote-servers\/(\d+)\/info$/);
    if (info) return json({ capabilities: server.capabilities[info[1]] });
    if (/\/task-groups$/.test(pathname)) return json([{ key: 'doing', name: 'Doing', sort_order: 1 }]);
    if (/\/terminal-activity$/.test(pathname)) return json(server.activity);
    if (/\/terminal-subagents$/.test(pathname)) return json({});
    if (/\/agent\/conversations$/.test(pathname)) return json([]);
    if (pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    if (pathname === '/api/oss/config') return json({ enabled: false });
    if (/\/terminal\/ack$/.test(pathname)) return json({ success: true });
    const match = pathname.match(/^(\/api(?:\/remote-servers\/\d+)?\/tasks)(?:\/(\d+)(?:\/(archive|restore|terminals))?)?$/);
    if (!match) return json({ error: 'not mocked' }, 404);
    const store = server.bases[match[1]];
    const id = Number(match[2]);
    const action = match[3];
    if (store.old && !match[2] && method === 'GET') return json(store.tasks); // ignores `?archived=1`
    if (store.old && (action === 'archive' || action === 'restore')) return route.fulfill({ status: 404, contentType: 'text/html', body: CANNOT_POST(pathname) });
    if (!match[2] && method === 'GET') return json(url.searchParams.get('archived') === '1' ? [...store.archived].reverse() : store.tasks);
    if (action === 'terminals' && method === 'POST') return server.createRefused ? json({ error: 'TASK_ARCHIVED' }, 409) : json({ terminal_id: 'new', title: 'New' });
    if (action === 'terminals') return json(store.tasks.some(row => row.id === id) ? [{ terminal_id: 'default', title: 'Terminal 1' }] : []);
    if (action === 'archive') {
      const row = store.tasks.find(entry => entry.id === id);
      store.tasks = store.tasks.filter(entry => entry.id !== id);
      const archived = { ...row, archived_at: ARCHIVED_AT };
      store.archived.push(archived);
      return json(archived);
    }
    if (action === 'restore') {
      const row = store.archived.find(entry => entry.id === id);
      store.archived = store.archived.filter(entry => entry.id !== id);
      const restored = { ...row, archived_at: null };
      store.tasks.push(restored);
      return json(restored);
    }
    if (method === 'DELETE') { store.archived = store.archived.filter(entry => entry.id !== id); store.tasks = store.tasks.filter(entry => entry.id !== id); return json({ success: true }); }
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  return { context, page };
}

function helpers(page, wide, label) {
  const press = locator => (wide ? locator.click() : locator.tap());
  const settled = () => page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity));
  const row = title => page.locator('.h5-task-row', { hasText: title });
  const sheet = async () => {
    if (!wide && !await page.locator('#h5-tasks').isVisible()) await page.locator('#h5-open-tasks').tap();
    await page.locator('#h5-tasks').waitFor({ state: 'visible' });
    await settled();
  };
  const select = async title => {
    await sheet();
    await press(page.locator('.h5-task-item', { hasText: title }));
    await press(page.locator(`#h5-tasks .h5-terminal-list[aria-label="${title}"] .h5-terminal-main`).first());
    await page.waitForFunction(name => document.getElementById('h5-task-name').textContent === name, title);
    await page.waitForFunction(id => window.taskSockets(id).length > 0, title === 'Alpha' ? 1 : title === 'Beta' ? 2 : 3, { timeout: 3000 });
    if (!wide) await page.locator('#h5-tasks').waitFor({ state: 'hidden' }); // the sheet has finished closing, so `sheet` opens it again
  };
  const menuItems = page.locator('#h5-term-menu-actions button, #h5-term-menu-actions [role="button"]');
  const menu = async title => {
    await sheet();
    await press(row(title).locator('.h5-task-more'));
    await menuItems.first().waitFor();
    await settled();
  };
  const dialog = page.locator('#h5-task-dialog');
  const askArchive = async title => {
    await menu(title);
    await press(menuItems.filter({ hasText: /^Archive$/ }));
    await page.locator('#h5-task-archive-text').waitFor();
    await page.waitForFunction(() => { const ok = document.getElementById('h5-task-dialog-ok'); return ok && !ok.disabled; });
    await settled();
  };
  const closeDialog = async () => { await press(page.locator('#h5-task-dialog-cancel')); await dialog.waitFor({ state: 'detached' }); };
  const confirm = async () => { await press(page.locator('#h5-task-dialog-ok')); await dialog.waitFor({ state: 'detached' }); };
  const gone = title => row(title).waitFor({ state: 'detached', timeout: 3000 }).catch(() => assert.fail(`${label}: ${title} leaves the list`));
  const socketState = id => page.evaluate(task => window.taskSockets(task).map(socket => socket.readyState), id);
  const lastNotice = () => page.evaluate(() => (window.H5UI.get().notice || {}).message || '');
  const toast = text => page.waitForFunction(wanted => (window.H5UI.get().notice || {}).message === wanted, text, { timeout: 3000 }).catch(() => assert.fail(`${label}: the notice "${text}"`));
  return { press, settled, row, sheet, select, menuItems, menu, dialog, askArchive, closeDialog, confirm, gone, socketState, toast, lastNotice };
}

async function run(browser, wide) {
  const label = wide ? 'PC 1440px' : 'phone 390px';
  const server = makeServer();
  const { context, page } = await openPage(browser, server, wide ? { width: 1440, height: 900 } : { width: 390, height: 844 }, !wide);
  const h = helpers(page, wide, label);
  const LIST = 'GET /api/tasks?archived=1';
  const shot = async name => { if (!wide && process.env.H5_SHOT_DIR) await page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, name) }); };

  await h.select('Alpha');
  assert.deepEqual(await h.socketState(1), [1], `${label}: the shown task is connected`);

  // ── The menu item: above Delete, not a warning ──
  await h.menu('Beta');
  assert.deepEqual((await h.menuItems.allTextContents()).slice(-2), ['Archive', 'Delete'], `${label}: Archive is above Delete`);
  assert.deepEqual((await h.menuItems.evaluateAll(nodes => nodes.map(node => node.classList.contains('danger')))).slice(-2), [false, true], `${label}: only Delete is a warning`);
  await shot('task-archive-menu-390.png');
  await h.press(page.locator('#h5-term-menu-cancel'));
  await page.locator('#h5-term-menu .h5-menu-panel').waitFor({ state: 'detached' });

  // ── The confirmation: nothing is said about running terminals when none is running; Cancel archives nothing ──
  await h.askArchive('Gamma');
  assert.equal(await page.locator('#h5-task-dialog-title').textContent(), 'Archive this task?');
  assert.equal(await page.locator('#h5-task-archive-name').textContent(), 'Gamma');
  assert.match(await page.locator('#h5-task-archive-text').textContent(), /Files, documents and terminal records are kept\. Its terminals will be closed\./);
  assert.equal(await page.locator('#h5-task-archive-running').count(), 0, `${label}: no warning without a running terminal`);
  await h.closeDialog();
  assert.equal(server.count('POST', '/api/tasks/3/archive'), 0, `${label}: Cancel archives nothing`);

  // ── Running terminals are said prominently; one or several ──
  server.activity = { 3: { default: 'running', idle: 'done' } };
  await h.askArchive('Gamma');
  assert.equal(await page.locator('#h5-task-archive-running').textContent(), '1 terminal is still running and will be stopped', `${label}: one running terminal`);
  await h.closeDialog();
  server.activity = { 2: { default: 'running', second: 'running' } };
  await h.askArchive('Beta');
  assert.equal(await page.locator('#h5-task-archive-running').textContent(), '2 terminals are still running and will be stopped', `${label}: two running terminals`);
  await shot('task-archive-dialog-390.png');

  // ── Archiving another task leaves the shown one alone ──
  await h.confirm();
  await h.gone('Beta');
  assert.equal(server.count('POST', '/api/tasks/2/archive'), 1);
  await h.toast('Task archived');
  assert.equal(await page.locator('#h5-task-name').textContent(), 'Alpha', `${label}: the shown task stays`);
  assert.deepEqual(await h.socketState(1), [1], `${label}: its socket stays open`);
  assert.equal(server.count('GET', '/api/tasks?archived=1'), 0, `${label}: the archived list is not read before it is opened`);

  // ── The Archived section: closed at first, read when it is opened; a row opens nothing ──
  await h.sheet();
  assert.equal(await page.locator('#h5-archived-list').count(), 0, `${label}: closed at first`);
  await h.press(page.locator('#h5-archived-toggle'));
  await page.locator('.h5-archived-row').first().waitFor();
  assert.equal(server.requests.filter(entry => entry === LIST).length, 1, `${label}: one read when opened`);
  assert.equal(await page.locator('#h5-archived-count').textContent(), '1');
  assert.equal(await page.locator('.h5-archived-title').first().textContent(), 'Beta');
  assert.match(await page.locator('.h5-archived-when').first().textContent(), /^Archived .*2026/, `${label}: when it was archived`);
  await h.press(page.locator('.h5-archived-title').first());
  await page.waitForTimeout(100);
  assert.deepEqual(await h.socketState(2), [], `${label}: an archived row opens nothing`);
  assert.equal(await page.locator('#h5-task-name').textContent(), 'Alpha');
  if (!wide) {
    for (const name of ['.h5-archived-restore', '.h5-archived-delete']) assert.ok((await page.locator(name).first().boundingBox()).height >= 44, `${label}: ${name} is 44px high`);
    await shot('task-archive-section-390.png');
  }

  // ── Restore: back in the list, no terminal is started, the shown task stays ──
  await h.press(page.locator('.h5-archived-restore').first());
  await h.row('Beta').waitFor();
  await h.toast('Task restored');
  assert.equal(server.count('POST', '/api/tasks/2/restore'), 1);
  assert.equal(await page.locator('.h5-archived-row').count(), 0, `${label}: the row left the section`);
  assert.equal(await page.locator('.h5-archived-note').textContent(), 'No archived tasks');
  assert.deepEqual(await h.socketState(2), [], `${label}: restore starts no terminal`);
  assert.equal(await page.locator('#h5-task-name').textContent(), 'Alpha');
  assert.deepEqual(await h.socketState(1), [1]);

  // ── Archiving the shown task: its socket closes, the page goes to the empty state, nothing reconnects, and the next session skips it ──
  await h.askArchive('Alpha');
  await h.confirm();
  await h.gone('Alpha');
  await page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'Choose a task');
  await page.locator('#h5-empty', { hasText: 'Choose a task to open its phone terminal' }).waitFor();
  assert.deepEqual(await h.socketState(1), [3], `${label}: the socket of the shown task is closed`);
  assert.equal(await page.locator('.h5-xterm').count(), 0, `${label}: no terminal is left`);
  server.activity = { 1: { default: 'running' } };
  await page.evaluate(() => window.H5UI.actions.nextActiveSession());
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.taskSockets(1).length), 1, `${label}: the next session button skips an archived task`);

  // ── It is in the section, which was already read and so is kept right; Delete uses the delete dialog ──
  await h.sheet();
  await page.locator('.h5-archived-row', { hasText: 'Alpha' }).waitFor();
  await h.press(page.locator('.h5-archived-delete').first());
  await page.locator('#h5-task-delete-text').waitFor();
  assert.match(await page.locator('#h5-task-delete-text').textContent(), /Alpha/);
  await h.confirm();
  await page.locator('.h5-archived-row').waitFor({ state: 'detached' });
  assert.equal(server.count('DELETE', '/api/tasks/1'), 1);
  assert.equal(server.bases['/api/tasks'].archived.length, 0, `${label}: it is gone on the server`);
  await h.toast('Task deleted');

  // ── A remote Engine without the capability has no Archive item; one with it adds its rows to the one Archived section, and each action goes to the row's service ──
  await h.row('Old engine task').waitFor();
  await h.row('New engine task').waitFor();
  await page.waitForTimeout(100);
  await h.menu('Old engine task');
  assert.ok(!(await h.menuItems.allTextContents()).includes('Archive'), `${label}: no Archive item on an old Engine`);
  await h.press(page.locator('#h5-term-menu-cancel'));
  await page.locator('#h5-term-menu .h5-menu-panel').waitFor({ state: 'detached' });

  // The Archived section of the one list: the rows of this machine and of Engine 8 together, named by their service; the old Engine 7 adds none and is not asked.
  server.bases['/api/remote-servers/8/tasks'].archived = [{ ...task(81, 'Remote archived'), archived_at: ARCHIVED_AT }];
  if (await page.locator('#h5-archived-list').count()) await h.press(page.locator('#h5-archived-toggle')); // closed, so that opening reads it again
  await h.press(page.locator('#h5-archived-toggle'));
  await page.locator('.h5-archived-title', { hasText: 'Remote archived' }).waitFor();
  assert.ok(server.count('GET', '/api/remote-servers/8/tasks?archived=1') >= 1, `${label}: the list of that Engine`);
  assert.equal(server.count('GET', '/api/remote-servers/7/tasks?archived=1'), 0, `${label}: no archive read on an old Engine`);
  assert.ok((await page.locator('.h5-archived-row', { hasText: 'Remote archived' }).locator('.h5-archived-service').textContent()).length > 3, `${label}: the row names its service`);
  await h.askArchive('New engine task');
  await h.confirm();
  await h.gone('New engine task');
  assert.equal(server.count('POST', '/api/remote-servers/8/tasks/80/archive'), 1, `${label}: archived on that Engine`);
  await page.locator('.h5-archived-title', { hasText: 'New engine task' }).waitFor();
  await page.locator('.h5-archived-restore').first().waitFor();
  await h.press(page.locator('.h5-archived-row', { hasText: 'New engine task' }).locator('.h5-archived-restore'));
  await h.row('New engine task').waitFor();
  assert.equal(server.count('POST', '/api/remote-servers/8/tasks/80/restore'), 1, `${label}: restored on that Engine`);

  await context.close();
  assert.deepEqual(server.pageErrors, [], `${label}: no page errors`);
  console.log(`  ${label}: ok`);
}

// A page that does not know another device archived its task.
async function stale(browser) {
  const label = 'stale page';
  const server = makeServer();
  const { context, page } = await openPage(browser, server, { width: 1440, height: 900 }, false);
  const h = helpers(page, true, label);
  const stillWaits = async (id, sockets) => { await page.waitForTimeout(1300); assert.equal(await page.evaluate(task => window.taskSockets(task).length, id), sockets, `${label}: no reconnect to task ${id}`); };
  const archiveOnServer = id => { const store = server.bases['/api/tasks']; const row = store.tasks.find(entry => entry.id === id); store.tasks = store.tasks.filter(entry => entry.id !== id); store.archived.push({ ...row, archived_at: ARCHIVED_AT }); };

  // The socket is refused with the reason: a clean message, the list read again, no reconnect.
  await h.select('Alpha');
  archiveOnServer(1);
  await page.evaluate(() => window.taskSockets(1)[0].serverClose(1008, 'TASK_ARCHIVED'));
  await h.toast('This task was archived on another device');
  await h.gone('Alpha');
  await page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'Choose a task');
  await stillWaits(1, 1);
  assert.equal(await page.locator('.xterm').count(), 0, `${label}: no terminal is left`);

  // The socket ends without a reason (the server closed the terminals): the page asks once and finds it archived.
  await h.select('Beta');
  archiveOnServer(2);
  await page.evaluate(() => window.taskSockets(2)[0].serverClose(1000, 'terminal exited'));
  await h.toast('This task was archived on another device');
  await h.gone('Beta');
  await stillWaits(2, 1);

  // A shell that just exited is not an archived task: the task stays and nothing is announced.
  await h.select('Gamma');
  await page.evaluate(() => window.taskSockets(3)[0].serverClose(1000, 'terminal exited'));
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#h5-task-name').textContent(), 'Gamma', `${label}: an ended shell leaves the task shown`);
  assert.equal(await page.locator('.h5-task-row', { hasText: 'Gamma' }).count(), 1);
  await stillWaits(3, 1);

  // A new terminal refused with TASK_ARCHIVED: the same message and not "Could not create".
  archiveOnServer(3);
  server.createRefused = true;
  await page.evaluate(() => window.H5UI.actions.addSession(3));
  await page.locator('#h5-term-menu-actions').waitFor();
  await page.locator('#h5-term-menu-actions button', { hasText: 'New Terminal' }).click();
  await h.toast('This task was archived on another device');
  await h.gone('Gamma');
  assert.doesNotMatch(await h.lastNotice(), /Could not create/, `${label}: no create error`);
  await page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'Choose a task');

  await context.close();
  assert.deepEqual(server.pageErrors, [], `${label}: no page errors`);
  console.log(`  ${label}: ok`);
}

// An older server process serving the newer page files (it was not restarted after an update): it answers `?archived=1` with its whole list. A row there has no
// Restore or Delete, because Delete would delete a task in use. `rows` is what it holds: no `archived_at` key at all, or null keys once a newer process has added the column.
async function oldServer(browser, wide) {
  const label = wide ? 'old server 1440px' : 'old server 390px';
  const start = async (rows, old = true) => {
    const server = makeServer();
    server.capabilities[8] = ['terminal:control']; // no connected service can archive here: what is shown is decided by this machine alone
    Object.assign(server.bases['/api/tasks'], { tasks: rows, old });
    const { context, page } = await openPage(browser, server, wide ? { width: 1440, height: 900 } : { width: 390, height: 844 }, !wide);
    const h = helpers(page, wide, label);
    await h.sheet();
    return { server, context, page, h, store: server.bases['/api/tasks'] };
  };
  const LIST = 'GET /api/tasks?archived=1';
  const withoutKey = () => [bare(1, 'Alpha'), bare(2, 'Beta'), bare(3, 'Gamma')];
  const nullKeys = () => [task(1, 'Alpha'), task(2, 'Beta'), task(3, 'Gamma')];
  const items = async ({ page, h }, title) => { await h.menu(title); const texts = await h.menuItems.allTextContents(); await h.press(page.locator('#h5-term-menu-cancel')); await page.locator('#h5-term-menu .h5-menu-panel').waitFor({ state: 'detached' }); return texts; };
  const finish = async ({ server, context }) => { await context.close(); assert.deepEqual(server.pageErrors, [], `${label}: no page errors`); };

  // Rows without the key: an old server from the first list on, so nothing is offered and `?archived=1` is never read.
  let now = await start(withoutKey());
  await now.h.row('Alpha').waitFor();
  await now.page.waitForTimeout(100);
  assert.equal(await now.page.locator('#h5-archived').count(), 0, `${label}: no Archived section from the start`);
  let texts = await items(now, 'Beta');
  assert.ok(!texts.includes('Archive'), `${label}: no Archive item from the start`);
  assert.ok(texts.includes('Delete'), `${label}: the normal Delete of the task stays`);
  assert.equal(now.server.requests.filter(entry => entry === LIST).length, 0, `${label}: the list is not read`);
  await finish(now);

  // The key is there but null everywhere (a newer process added the column): only the answer shows it. Nothing is listed, and the section and the item go away.
  now = await start(nullKeys());
  await now.page.locator('#h5-archived').waitFor();
  assert.ok((await items(now, 'Beta')).includes('Archive'), `${label}: not known yet`);
  await now.h.press(now.page.locator('#h5-archived-toggle'));
  await now.page.locator('#h5-archived').waitFor({ state: 'detached', timeout: 3000 }).catch(() => assert.fail(`${label}: the section goes away`));
  assert.equal(now.server.requests.filter(entry => entry === LIST).length, 1, `${label}: one read`);
  assert.equal(await now.page.locator('.h5-archived-row').count(), 0, `${label}: no row is shown`);
  assert.equal(await now.page.locator('.h5-archived-delete').count(), 0, `${label}: no Delete on a task in use`);
  assert.equal(await now.page.locator('[data-source="local"] .h5-task-row').count(), 3, `${label}: the tasks stay in the list`);
  texts = await items(now, 'Beta');
  assert.ok(!texts.includes('Archive'), `${label}: Archive left the menu`);
  await finish(now);

  // Archive on such a server: the 404 gives a sentence and not the HTML; the task stays, and the item goes away.
  now = await start(nullKeys());
  await now.h.askArchive('Beta');
  await now.h.press(now.page.locator('#h5-task-dialog-ok'));
  const error = now.page.locator('#h5-task-dialog-error');
  await error.waitFor();
  assert.equal(await error.textContent(), 'This server is too old to archive tasks. Restart or update it first', `${label}: a clean message`);
  await now.h.closeDialog();
  assert.equal(now.server.count('POST', '/api/tasks/2/archive'), 1, `${label}: it was asked`);
  assert.equal(await now.h.row('Beta').count(), 1, `${label}: the task stays`);
  assert.equal(await now.h.lastNotice(), '', `${label}: nothing says it was archived`);
  await now.h.sheet();
  assert.equal(await now.page.locator('#h5-archived').count(), 0, `${label}: the section went away`);
  assert.ok(!(await items(now, 'Beta')).includes('Archive'), `${label}: the item went away`);
  await finish(now);

  // A terminal that ended on such a server: `?archived=1` lists the shown task, which does not make it archived.
  now = await start(nullKeys());
  await now.h.select('Alpha');
  await now.page.evaluate(() => window.taskSockets(1)[0].serverClose(1000, 'terminal exited'));
  await now.page.waitForTimeout(200);
  assert.equal(now.server.requests.filter(entry => entry === LIST).length, 1, `${label}: it asked once`);
  assert.equal(await now.page.locator('#h5-task-name').textContent(), 'Alpha', `${label}: the task stays shown`);
  assert.equal(await now.h.lastNotice(), '', `${label}: nothing says it was archived on another device`);
  await finish(now);

  // An empty list says nothing: the section stays, and an empty answer is simply empty.
  now = await start([]);
  await now.page.locator('#h5-archived').waitFor();
  await now.h.press(now.page.locator('#h5-archived-toggle'));
  await now.page.locator('.h5-archived-note', { hasText: 'No archived tasks' }).waitFor();
  await finish(now);

  // A mixed answer: only the row that is really archived.
  now = await start(nullKeys(), false);
  now.store.archived = [{ ...task(9, 'Really archived'), archived_at: ARCHIVED_AT }, task(1, 'Alpha'), bare(2, 'Beta')];
  await now.h.press(now.page.locator('#h5-archived-toggle'));
  await now.page.locator('.h5-archived-row').first().waitFor();
  await now.page.waitForTimeout(50);
  assert.deepEqual(await now.page.locator('.h5-archived-title').allTextContents(), ['Really archived'], `${label}: only the real row`);
  assert.equal(await now.page.locator('.h5-archived-delete').count(), 1, `${label}: one Delete`);
  assert.equal(await now.page.locator('#h5-archived-count').textContent(), '1', `${label}: the count is of real rows`);
  assert.ok((await items(now, 'Beta')).includes('Archive'), `${label}: archiving is still there`);
  await finish(now);

  console.log(`  ${label}: ok`);
}

// The narrowest phone: a long Chinese title wraps inside the row, and nothing goes past the edge of the sheet.
async function narrow(browser) {
  const label = 'phone 320px';
  const server = makeServer();
  server.bases['/api/tasks'].archived.push({ ...task(9, LONG), archived_at: ARCHIVED_AT });
  const { context, page } = await openPage(browser, server, { width: 320, height: 640 }, true);
  const h = helpers(page, false, label);
  await h.sheet();
  await h.press(page.locator('#h5-archived-toggle'));
  await page.locator('.h5-archived-row').waitFor();
  await h.settled();
  const fit = await page.evaluate(() => {
    const list = document.getElementById('h5-task-list');
    const row = document.querySelector('.h5-archived-row');
    const rect = el => { const box = el.getBoundingClientRect(); return { left: box.left, right: box.right, height: box.height, top: box.top }; };
    return { scroll: list.scrollWidth, client: list.clientWidth, row: rect(row), buttons: [...row.querySelectorAll('button')].map(rect), toggle: rect(document.getElementById('h5-archived-toggle')), list: rect(list) };
  });
  assert.ok(fit.scroll <= fit.client, `${label}: the list does not scroll sideways ${JSON.stringify(fit)}`);
  for (const button of fit.buttons) {
    assert.ok(button.right <= fit.list.right + 0.5 && button.left >= fit.list.left - 0.5, `${label}: the button stays inside ${JSON.stringify(fit)}`);
    assert.ok(button.height >= 44, `${label}: 44px buttons ${JSON.stringify(fit)}`);
  }
  assert.ok(fit.toggle.height >= 44, `${label}: a 44px entry ${JSON.stringify(fit)}`);
  await context.close();
  assert.deepEqual(server.pageErrors, [], `${label}: no page errors`);
  console.log(`  ${label}: ok`);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await run(browser, false);
    await run(browser, true);
    await stale(browser);
    await oldServer(browser, false);
    await oldServer(browser, true);
    await narrow(browser);
  } finally {
    await browser.close();
  }
  console.log('Task archiving on the page passed (390px, 1440px, 320px).');
})().catch(error => { console.error(error); process.exit(1); });
