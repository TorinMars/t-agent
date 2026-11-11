// Renaming a task on the page in real Chromium at 390px (touch) and 1440px (mouse): the "Rename" item of a task's menu, a title-only rename (PUT), a rename with
// the folder (the slug follows the title until the name is edited, the old and new paths), the busy flow (TASK_BUSY: close the terminals, then the rename goes
// through and the shown terminal opens again), a running chat turn, a folder that does not have its title's name, errors from the server, and remote Engines
// with and without 'tasks:rename-folder'. The server is mocked. H5_SHOT_DIR=<dir> saves screenshots at 390px.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const task = (id, title, workDir = `/w/${title}`) => ({ id, title, status: 'doing', work_dir: workDir, archived_at: null });

function makeServer() {
  const server = {
    pageErrors: [], requests: [], bodies: [],
    // `refuse`: the answers the next rename-folder calls get, in order (then success).
    refuse: [],
    bases: {
      '/api/tasks': [task(1, 'Alpha'), task(2, 'Beta'), task(3, 'Gamma', '/w/custom-dir')],
      '/api/remote-servers/7/tasks': [task(70, 'Old engine task', '/w/Old-engine-task')],
      '/api/remote-servers/8/tasks': [task(80, 'New engine task', '/w/New-engine-task')],
    },
    capabilities: { 7: ['terminal:control'], 8: ['terminal:control', 'tasks:rename-folder'] },
  };
  server.count = (method, url) => server.requests.filter(entry => entry === `${method} ${url}`).length;
  server.bodyOf = (method, url) => server.bodies.filter(entry => entry.key === `${method} ${url}`).map(entry => entry.body);
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
    const key = `${method} ${pathname}${url.search}`;
    server.requests.push(key);
    let body = null;
    try { body = request.postData() ? JSON.parse(request.postData()) : null; } catch { body = null; }
    if (body) server.bodies.push({ key, body });
    if (pathname === '/api/remote-servers') return json([{ id: 7, name: 'Old engine' }, { id: 8, name: 'New engine' }]);
    const info = pathname.match(/^\/api\/remote-servers\/(\d+)\/info$/);
    if (info) return json({ capabilities: server.capabilities[info[1]] });
    if (/\/task-groups$/.test(pathname)) return json([{ key: 'doing', name: 'Doing', sort_order: 1 }]);
    if (/\/terminal-activity$/.test(pathname)) return json({});
    if (/\/terminal-subagents$/.test(pathname)) return json({});
    if (/\/agent\/conversations$/.test(pathname)) return json([]);
    if (pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    if (pathname === '/api/oss/config') return json({ enabled: false });
    if (/\/terminal\/(ack|control)$/.test(pathname)) return json({ success: true });
    const match = pathname.match(/^(\/api(?:\/remote-servers\/\d+)?\/tasks)(?:\/(\d+)(?:\/(terminals|rename-folder))?)?$/);
    if (!match) return json({ error: 'not mocked' }, 404);
    const list = server.bases[match[1]];
    const id = Number(match[2]);
    const action = match[3];
    const item = list.find(entry => entry.id === id);
    if (!match[2] && method === 'GET') return json(list);
    if (action === 'terminals') return json(item ? [{ terminal_id: 'default', title: 'Terminal 1', work_dir: item.work_dir }] : []);
    if (action === 'rename-folder') {
      const refusal = server.refuse.shift();
      if (refusal) return json(refusal.body, refusal.status);
      const from = item.work_dir;
      item.work_dir = `${from.replace(/\/[^/]*$/, '')}/${body.name}`;
      if (body.title) item.title = body.title;
      return json({ task: item, old_dir: from, new_dir: item.work_dir, moved: {} });
    }
    if (method === 'PUT' && item) { if (body.title !== undefined) item.title = body.title; return json(item); }
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  return { context, page };
}

async function run(browser, wide) {
  const label = wide ? 'PC 1440px' : 'phone 390px';
  const server = makeServer();
  const { context, page } = await openPage(browser, server, wide ? { width: 1440, height: 900 } : { width: 390, height: 844 }, !wide);
  const press = locator => (wide ? locator.click() : locator.tap());
  const settled = () => page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity));
  const row = title => page.locator('.h5-task-row', { hasText: title });
  const sheet = async () => {
    if (!wide && !await page.locator('#h5-tasks').isVisible()) await page.locator('#h5-open-tasks').tap();
    await page.locator('#h5-tasks').waitFor({ state: 'visible' });
    await settled();
  };
  const menuItems = page.locator('#h5-term-menu-actions button, #h5-term-menu-actions [role="button"]');
  const askRename = async title => {
    await sheet();
    await press(row(title).first().locator('.h5-task-more'));
    await menuItems.first().waitFor();
    await settled();
    await press(menuItems.filter({ hasText: /^Rename$/ }));
    await page.locator('#h5-task-rename-title').waitFor();
    await settled();
  };
  const dialog = page.locator('#h5-task-dialog');
  const fill = async (selector, value) => { await page.locator(selector).fill(value); };
  const value = selector => page.locator(selector).inputValue();
  const text = selector => page.locator(selector).textContent();
  const toast = wanted => page.waitForFunction(message => (window.H5UI.get().notice || {}).message === message, wanted, { timeout: 3000 }).catch(() => assert.fail(`${label}: the notice "${wanted}"`));
  const shot = async name => { if (!wide && process.env.H5_SHOT_DIR) await page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, name) }); };

  // The shown task: Alpha, with its terminal connected.
  await sheet();
  await press(page.locator('.h5-task-item', { hasText: 'Alpha' }));
  await press(page.locator('#h5-tasks .h5-terminal-list[aria-label="Alpha"] .h5-terminal-main').first());
  await page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'Alpha');
  await page.waitForFunction(() => window.taskSockets(1).some(socket => socket.readyState === 1), null, { timeout: 3000 });
  if (!wide) await page.locator('#h5-tasks').waitFor({ state: 'hidden' });

  // ── The menu item, before "Edit working directory" ──
  await sheet();
  await press(row('Beta').locator('.h5-task-more'));
  await menuItems.first().waitFor();
  const items = await menuItems.allTextContents();
  assert.equal(items.indexOf('Rename') + 1, items.indexOf('Edit working directory'), `${label}: Rename comes before Edit working directory ${JSON.stringify(items)}`);
  await press(page.locator('#h5-term-menu-cancel'));
  await page.locator('#h5-term-menu .h5-menu-panel').waitFor({ state: 'detached' });

  // ── Title only: the checkbox is there (the folder has the title's name) and off; Save sends the title by PUT ──
  await askRename('Beta');
  assert.equal(await value('#h5-task-rename-title'), 'Beta');
  assert.equal(await text('#h5-task-dialog-title'), 'Rename task');
  assert.equal(await page.locator('#h5-task-rename-folder').isChecked(), false, `${label}: the folder is not renamed by default`);
  assert.equal(await page.locator('#h5-task-rename-folder-box').count(), 0);
  await fill('#h5-task-rename-title', '  Beta two ');
  await press(page.locator('#h5-task-dialog-ok'));
  await dialog.waitFor({ state: 'detached' });
  await toast('Task renamed');
  assert.deepEqual(server.bodyOf('PUT', '/api/tasks/2'), [{ title: 'Beta two' }], `${label}: the trimmed title`);
  assert.equal(server.count('POST', '/api/tasks/2/rename-folder'), 0);
  await row('Beta two').waitFor({ timeout: 3000 });

  // ── An empty title cannot be saved ──
  await askRename('Beta two');
  await fill('#h5-task-rename-title', '   ');
  assert.equal(await page.locator('#h5-task-dialog-ok').isDisabled(), true, `${label}: no empty title`);
  await press(page.locator('#h5-task-dialog-cancel'));
  await dialog.waitFor({ state: 'detached' });

  // ── With the folder, the shown task: the name follows the title until it is edited; the paths are shown; a bad name stops Save ──
  await askRename('Alpha');
  await press(page.locator('#h5-task-rename-folder'));
  await page.locator('#h5-task-rename-folder-box').waitFor();
  assert.equal(await text('#h5-task-rename-old'), '/w/Alpha');
  await fill('#h5-task-rename-title', 'Alpha new');
  assert.equal(await value('#h5-task-rename-name'), 'Alpha-new', `${label}: the slug of the new title`);
  assert.equal(await text('#h5-task-rename-new'), '/w/Alpha-new');
  await fill('#h5-task-rename-name', 'a/b');
  assert.equal(await page.locator('#h5-task-dialog-ok').isDisabled(), true, `${label}: a name with a slash cannot be saved`);
  assert.match(await page.locator('#h5-task-rename-folder-box').textContent(), /Enter a folder name without \/ or \\/);
  await fill('#h5-task-rename-name', 'alpha-folder');
  await fill('#h5-task-rename-title', 'Alpha newer');
  assert.equal(await value('#h5-task-rename-name'), 'alpha-folder', `${label}: an edited name no longer follows the title`);
  assert.equal(await text('#h5-task-rename-new'), '/w/alpha-folder');
  await shot('task-rename-folder-390.png');

  // ── The server answers TASK_BUSY: the dialog says so and offers to close the terminal; then the rename is sent again and goes through ──
  server.refuse.push({ status: 409, body: { error: 'TASK_BUSY', terminals: ['default'], chat: false } });
  await press(page.locator('#h5-task-dialog-ok'));
  await page.locator('#h5-task-rename-busy').waitFor();
  assert.match(await text('#h5-task-rename-busy'), /1 terminal of this task is open\. It must be closed before the folder can be renamed\./);
  await shot('task-rename-busy-390.png');
  const socketsBefore = await page.evaluate(() => window.taskSockets(1).length);
  await press(page.locator('#h5-task-rename-close'));
  await dialog.waitFor({ state: 'detached', timeout: 6000 });
  assert.deepEqual(server.bodyOf('POST', '/api/tasks/1/terminal/control'), [{ action: 'close', terminal_id: 'default' }], `${label}: the terminal was closed through the usual path`);
  assert.deepEqual(server.bodyOf('POST', '/api/tasks/1/rename-folder'), [{ name: 'alpha-folder', title: 'Alpha newer' }, { name: 'alpha-folder', title: 'Alpha newer' }]);
  await toast('Task and folder renamed');
  await page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'Alpha newer', null, { timeout: 3000 });
  await page.waitForFunction(count => window.taskSockets(1).length > count && window.taskSockets(1).at(-1).readyState === 1, socketsBefore, { timeout: 3000 })
    .catch(() => assert.fail(`${label}: the shown terminal opens again in the new folder`));

  // ── A running chat turn: said, without a close button ──
  server.refuse.push({ status: 409, body: { error: 'TASK_BUSY', terminals: [], chat: true } });
  await askRename('Alpha newer');
  await press(page.locator('#h5-task-rename-folder-show')); // the folder is called alpha-folder now, not after the title
  await press(page.locator('#h5-task-dialog-ok'));
  await page.locator('#h5-task-rename-busy').waitFor();
  assert.match(await text('#h5-task-rename-busy'), /A chat turn of this task is running\. Stop it, then try again\./);
  assert.equal(await page.locator('#h5-task-rename-close').count(), 0);
  // ── Another refusal: its text and reason ──
  server.refuse.push({ status: 409, body: { error: 'FOLDER_NOT_RENAMABLE', reason: 'The folder is a Git repository with linked worktrees; renaming would break them' } });
  await press(page.locator('#h5-task-dialog-ok'));
  await page.locator('#h5-task-dialog-error').waitFor();
  assert.equal(await text('#h5-task-dialog-error'), 'This folder cannot be renamed: The folder is a Git repository with linked worktrees; renaming would break them');
  assert.equal(await page.locator('#h5-task-rename-busy').count(), 0, `${label}: the busy note goes away`);
  server.refuse.push({ status: 409, body: { error: 'FOLDER_EXISTS', path: '/w/alpha-folder2' } });
  await fill('#h5-task-rename-name', 'alpha-folder2');
  await press(page.locator('#h5-task-dialog-ok'));
  await page.waitForFunction(() => (document.getElementById('h5-task-dialog-error') || {}).textContent === 'A folder with this name already exists');
  await press(page.locator('#h5-task-dialog-cancel'));
  await dialog.waitFor({ state: 'detached' });

  // ── A folder without its title's name: one more tap shows the folder part, already checked ──
  await askRename('Gamma');
  assert.equal(await page.locator('#h5-task-rename-folder').count(), 0);
  await press(page.locator('#h5-task-rename-folder-show'));
  assert.equal(await page.locator('#h5-task-rename-folder').isChecked(), true);
  assert.equal(await text('#h5-task-rename-old'), '/w/custom-dir');
  assert.equal(await value('#h5-task-rename-name'), 'Gamma');
  await press(page.locator('#h5-task-dialog-cancel'));
  await dialog.waitFor({ state: 'detached' });

  // ── Remote Engines: without the capability only the title; with it the folder too, through the proxy ──
  await askRename('Old engine task');
  await page.waitForFunction(() => !document.getElementById('h5-task-rename-checking'));
  assert.equal(await page.locator('#h5-task-rename-folder, #h5-task-rename-folder-show').count(), 0, `${label}: an older Engine offers no folder rename`);
  await fill('#h5-task-rename-title', 'Old engine renamed');
  await press(page.locator('#h5-task-dialog-ok'));
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(server.bodyOf('PUT', '/api/remote-servers/7/tasks/70'), [{ title: 'Old engine renamed' }]);
  await askRename('New engine task');
  await page.locator('#h5-task-rename-folder').waitFor();
  await press(page.locator('#h5-task-rename-folder'));
  await fill('#h5-task-rename-name', 'New-engine-task-2');
  await press(page.locator('#h5-task-dialog-ok'));
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(server.bodyOf('POST', '/api/remote-servers/8/tasks/80/rename-folder'), [{ name: 'New-engine-task-2' }], `${label}: the folder only, the title is unchanged`);
  await toast('Task and folder renamed');

  // The dialog fits the phone: nothing scrolls sideways.
  if (!wide) {
    await askRename('Gamma');
    await press(page.locator('#h5-task-rename-folder-show'));
    const fit = await page.evaluate(() => { const box = document.querySelector('#h5-task-dialog .MuiDialog-paper'); return { scroll: box.scrollWidth, client: box.clientWidth, right: box.getBoundingClientRect().right, width: innerWidth }; });
    assert.ok(fit.scroll <= fit.client && fit.right <= fit.width, `${label}: the dialog fits ${JSON.stringify(fit)}`);
    await press(page.locator('#h5-task-dialog-cancel'));
  }
  await context.close();
  assert.deepEqual(server.pageErrors, [], `${label}: no page errors`);
  console.log(`  ${label}: ok`);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await run(browser, false);
    await run(browser, true);
  } finally {
    await browser.close();
  }
  console.log('Task rename on the page passed (390px, 1440px).');
})().catch(error => { console.error(error); process.exit(1); });
