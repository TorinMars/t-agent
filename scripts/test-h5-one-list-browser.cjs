// The page without an Engine switch: the tasks of this machine and of every connected service are in ONE list, in real Chromium at phone and computer size with the routes mocked.
// Two services with the SAME task ids and titles, in one flat list (no section per service: each row has its device tag and `data-source`): each has its own rows; opening a task on each reaches that service's `tasksBase` and socket; expanding one leaves its twin
// closed; the actions of a row hit that row's service, whichever task is shown. Running counts add up, the next-session button crosses services, search finds both. An offline service
// adds no rows (or keeps the rows it had, with a muted tag), does not disturb the others and comes back on its own. New task with "Create on". A remembered remote task, and a fallback when it is offline or hidden.
// One service looks as it did. The Archived section across services. "Show in task list": hiding removes rows, counts and feeds, the last switch is disabled, it survives a reload.
// H5_SHOT_DIR=<dir> saves screenshots of a list with two services.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const LOCAL_STREAM = '/api/tasks/terminal-activity/stream';
const REMOTE_STREAM = '/api/remote-servers/7/terminal-activity/stream';
const GROUPS = [{ key: 'doing', name: 'In progress', sort_order: 1 }, { key: 'todo', name: 'To do', sort_order: 2 }];

function makeService(prefix, base) {
  return {
    prefix, base, offline: false, nextId: 100,
    tasks: [{ id: 1, title: 'Alpha', status: 'doing', work_dir: `/w${base}/alpha`, archived_at: null }, { id: 2, title: 'Beta', status: 'doing', work_dir: `/w${base}/beta`, archived_at: null }],
    archived: [{ id: 50, title: 'Old one', status: 'done', work_dir: '/w/old', archived_at: '2026-11-10 10:00:00' }],
    terminals: { 1: [{ terminal_id: 'default', title: 'Alpha shell' }], 2: [{ terminal_id: 'b1', title: 'Beta shell' }] },
    activity: {},
  };
}
function makeWorld({ remote = true, hiddenRoute = true, hidden = [], linked = false } = {}) {
  const world = {
    remote, hiddenRoute, hidden, linked, writes: [], reads: [], pageErrors: [],
    local: makeService('/api/tasks', 'local'),
    vps: makeService('/api/remote-servers/7/tasks', 'remote'),
  };
  world.lookup = pathname => {
    if (pathname.startsWith('/api/remote-servers/7/')) return world.vps;
    if (pathname.startsWith('/api/tasks') || pathname === '/api/task-groups') return world.local;
    return null;
  };
  return world;
}
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function serve(world, route) {
  const url = new URL(route.request().url());
  const pathname = url.pathname;
  const method = route.request().method();
  if (method !== 'GET') world.writes.push([method, pathname, route.request().postDataJSON()]);
  else world.reads.push(pathname);
  if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
  if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
  if (pathname === '/api/remote-servers') return json(route, world.remote ? [{ id: 7, name: 'VPS', status: 'online', base_url: 'http://10.0.0.7:14002', enabled: true }] : []);
  if (pathname === '/api/service-links') return json(route, { supported: true, links: world.linked ? [{ id: 'l1', remote_server_id: 7, peer_url: 'http://peer.test', peer_name: 'VPS', role: 'initiator', online: true, state: 'online', shared: {} }] : [] });
  if (pathname === '/api/task-list/hidden-devices') {
    if (!world.hiddenRoute) return json(route, { error: 'not found' }, 404);
    if (method === 'PUT') {
      const list = route.request().postDataJSON().hidden;
      if (list.includes('local') && list.includes('remote:7')) return json(route, { error: 'LAST_DEVICE_VISIBLE' }, 400);
      world.hidden = list;
    }
    return json(route, { hidden: world.hidden });
  }
  const service = world.lookup(pathname);
  if (!service) return json(route, { error: 'not mocked' }, 404);
  if (service.offline) return json(route, { error: 'REMOTE_CONNECTION_FAILED' }, 502);
  if (pathname === '/api/task-groups' || pathname === '/api/remote-servers/7/task-groups') return json(route, GROUPS);
  if (pathname === '/api/remote-servers/7/info') return json(route, { capabilities: ['tasks:archive', 'terminal:control'] });
  if (pathname.endsWith('/terminal-activity')) return json(route, service.activity);
  if (pathname.endsWith('/terminal-subagents')) return json(route, {});
  const tail = pathname.slice(service.prefix.length);
  if (!tail && method === 'GET') return json(route, url.searchParams.get('archived') === '1' ? service.archived : service.tasks);
  if (!tail && method === 'POST') {
    const task = { id: service.nextId++, title: route.request().postDataJSON().title, status: 'doing', archived_at: null };
    service.tasks.push(task);
    service.terminals[task.id] = [];
    return json(route, task);
  }
  const hit = tail.match(/^\/(\d+)(?:\/(.+))?$/);
  if (!hit) return json(route, { error: 'not mocked' }, 404);
  const id = Number(hit[1]);
  const rest = hit[2];
  if (!rest && method === 'PUT') { Object.assign(service.tasks.find(item => item.id === id) || {}, route.request().postDataJSON()); return json(route, {}); }
  if (!rest && method === 'DELETE') { service.tasks = service.tasks.filter(item => item.id !== id); service.archived = service.archived.filter(item => item.id !== id); return json(route, { directory_deleted: false }); }
  if (rest === 'archive') { const row = service.tasks.find(item => item.id === id); service.tasks = service.tasks.filter(item => item.id !== id); service.archived.push({ ...row, archived_at: '2026-11-10 11:00:00' }); return json(route, {}); }
  if (rest === 'restore') { const row = service.archived.find(item => item.id === id); service.archived = service.archived.filter(item => item.id !== id); service.tasks.push({ ...row, archived_at: null }); return json(route, {}); }
  if (rest === 'terminal/ack') return json(route, {});
  if (rest === 'terminals' && method === 'GET') return json(route, service.terminals[id] || []);
  if (rest === 'terminals' && method === 'POST') { const row = { terminal_id: `new-${id}`, title: 'New terminal' }; (service.terminals[id] ||= []).push(row); return json(route, row); }
  if (/^terminals\/[^/]+$/.test(rest) && method === 'PATCH') return json(route, { title: route.request().postDataJSON().title });
  if (rest === 'terminal/control') return json(route, {});
  return json(route, { error: 'not mocked' }, 404);
}

async function open(browser, world, wide, { storage = {} } = {}) {
  const context = await browser.newContext(wide ? { viewport: { width: 1280, height: 800 } } : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', error => world.pageErrors.push(error.message));
  await page.addInitScript(values => {
    for (const [key, value] of Object.entries(values)) { try { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); } catch { /* ignore */ } }
    window.sockets = [];
    window.FakeSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
    };
    window.FakeSocket.OPEN = 1;
    window.FakeSocket.CONNECTING = 0;
    window.WebSocket = window.FakeSocket;
  }, storage);
  await page.addInitScript(activityStreamMock);
  await page.route(`${ORIGIN}/**`, route => serve(world, route));
  await page.goto(`${ORIGIN}/h5`);
  return { context, page };
}

function tools(page, wide) {
  const press = locator => (wide ? locator.click() : locator.tap());
  const section = key => page.locator(`#h5-task-list .h5-task[data-source="${key}"]`); // the rows of one service (the list has no sections)
  const row = (key, title) => section(key).locator('.h5-task-row').filter({ has: page.locator('.h5-task-title', { hasText: title }) });
  const sheet = async () => {
    if (!wide && !await page.locator('#h5-tasks').isVisible()) await page.locator('#h5-open-tasks').tap();
    await page.locator('#h5-tasks').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity));
  };
  const socketPath = () => page.evaluate(() => { const s = window.sockets.filter(item => item.readyState !== 3).at(-1); return s ? new URL(s.url).pathname : null; });
  // A terminal of each service stays warm, so the newest socket need not be the shown one: an open socket of that service is what can be said here (the header says which is shown).
  const waitSocket = expected => page.waitForFunction(want => window.sockets.some(item => item.readyState === 1 && new URL(item.url).pathname === want), expected);
  const shownName = () => page.locator('#h5-task-name').textContent();
  const service = async () => (await page.locator('#h5-task-service').count() ? page.locator('#h5-task-service').textContent() : null);
  // Opens the first session of a task of a service.
  const openTask = async (key, title) => {
    await sheet();
    const item = row(key, title).locator('.h5-task-item');
    if (await item.getAttribute('aria-expanded') !== 'true') await press(item);
    await press(section(key).locator(`.h5-terminal-list[aria-label="${title}"] .h5-terminal-main`).first());
    await page.waitForFunction(name => document.getElementById('h5-task-name').textContent === name, title);
    if (!wide) await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
  };
  const taskMenu = async (key, title) => {
    await sheet();
    await press(row(key, title).locator('.h5-task-more'));
    await page.locator('#h5-term-menu-actions').first().waitFor();
    await page.waitForTimeout(250);
  };
  const menuItem = text => page.locator('#h5-term-menu-actions button', { hasText: text });
  const notice = wanted => page.waitForFunction(text => (window.H5UI.get().notice || {}).message === text, wanted);
  const openEngines = async () => {
    await page.evaluate(() => window.H5UI.actions.openSettings());
    await page.locator('#h5-settings').waitFor({ state: 'visible' });
    const summary = page.locator('#h5-set-engines .MuiAccordionSummary-root');
    await summary.scrollIntoViewIfNeeded();
    if (await summary.getAttribute('aria-expanded') !== 'true') await press(summary);
    await page.waitForFunction(() => Boolean(document.querySelector('#h5-set-engines .MuiCollapse-entered')));
  };
  const closeSettings = async () => { await page.evaluate(() => window.H5UI.actions.closeSettings()); await page.locator('#h5-settings .h5-sheet-panel').waitFor({ state: 'hidden' }); };
  return { press, section, row, sheet, socketPath, waitSocket, shownName, service, openTask, taskMenu, menuItem, notice, openEngines, closeSettings };
}
const lastWrite = (world, method, pathname) => world.writes.filter(([m, p]) => m === method && p === pathname).at(-1);
const count = (list, item) => list.filter(entry => entry === item).length;
const pushActivity = (page, url, snapshot) => page.waitForFunction(([u, s]) => window.activityStream.push(u, s), [url, snapshot]);

// Two services, the same ids and titles.
async function testTwoServices(browser, wide) {
  const label = wide ? 'wide' : 'phone';
  const world = makeWorld();
  const { context, page } = await open(browser, world, wide);
  const t = tools(page, wide);
  await t.sheet();
  await t.row('local', 'Alpha').waitFor();
  await t.row('remote:7', 'Alpha').waitFor();
  assert.equal(await page.locator('#h5-engine').count(), 0, `${label}: no Engine selector`);
  assert.equal(await page.locator('.h5-source-header, .h5-source').count(), 0, `${label}: no section per service`);
  assert.deepEqual(await page.locator('#h5-task-list .h5-task .h5-device-tag').allTextContents(), ['This machine', 'This machine', 'VPS', 'VPS'], `${label}: one list, this machine first, each row with its device tag`);
  assert.equal(await page.locator('.h5-device-tag[data-offline]').count(), 0, `${label}: nobody is offline`);

  // Expanding one does not expand its twin.
  const localItem = t.row('local', 'Alpha').locator('.h5-task-item');
  const remoteItem = t.row('remote:7', 'Alpha').locator('.h5-task-item');
  await t.press(localItem);
  await page.waitForFunction(() => document.querySelector('.h5-task[data-source="local"] .h5-task-item').getAttribute('aria-expanded') === 'true');
  assert.equal(await remoteItem.getAttribute('aria-expanded'), 'false', `${label}: the twin stays closed`);
  await t.section('local').locator('.h5-terminal-list[aria-label="Alpha"]').waitFor();
  assert.ok(world.reads.includes('/api/tasks/1/terminals'), `${label}: the local task was read`);
  assert.ok(!world.reads.includes('/api/remote-servers/7/tasks/1/terminals'), `${label}: and not the twin`);
  await t.press(localItem); // closed again

  if (process.env.H5_SHOT_DIR) { await t.sheet(); await page.waitForTimeout(150); await page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, `one-list-${wide ? 'wide' : '390'}.png`) }); }

  // Opening a task on each reaches the right socket and tasks base.
  await t.openTask('local', 'Alpha');
  await t.waitSocket('/terminal/ws');
  assert.equal(await t.service(), null, `${label}: this machine is not named in the header`);
  await t.openTask('remote:7', 'Alpha');
  await t.waitSocket('/api/remote-servers/7/terminal/ws');
  assert.equal(await t.service(), 'VPS', `${label}: the header names the service`);
  assert.ok(world.reads.includes('/api/remote-servers/7/tasks/1/terminals'), `${label}: its terminals were read there`);

  // The shown task is on VPS; actions on a row of this machine go to this machine.
  await t.taskMenu('local', 'Beta');
  await t.press(t.menuItem('To do'));
  await page.waitForFunction(() => document.querySelectorAll('#h5-term-menu-actions button').length === 0);
  await page.waitForFunction(() => window.H5UI.get().taskList.tasks.length === 4);
  await page.waitForTimeout(100);
  assert.deepEqual(lastWrite(world, 'PUT', '/api/tasks/2'), ['PUT', '/api/tasks/2', { status: 'todo' }], `${label}: move goes to the row's service`);
  assert.equal(lastWrite(world, 'PUT', '/api/remote-servers/7/tasks/2'), undefined, `${label}: and not to the shown one`);

  // Opening a task of this machine, an action on the remote twin goes to the remote one.
  await t.openTask('local', 'Alpha');
  await t.waitSocket('/terminal/ws');
  await t.taskMenu('remote:7', 'Beta');
  assert.match(await page.locator('.h5-menu-panel, #h5-term-menu').first().textContent(), /Beta · VPS/, `${label}: the sheet names the service`);
  await t.press(t.menuItem('Archive'));
  await page.locator('#h5-task-dialog-ok').waitFor();
  await page.waitForFunction(() => !document.getElementById('h5-task-dialog-ok').disabled);
  await t.press(page.locator('#h5-task-dialog-ok'));
  await t.notice('Task archived');
  assert.ok(lastWrite(world, 'POST', '/api/remote-servers/7/tasks/2/archive'), `${label}: archive goes to the row's service`);
  assert.equal(lastWrite(world, 'POST', '/api/tasks/2/archive'), undefined, `${label}: the twin is untouched`);
  await t.row('remote:7', 'Beta').waitFor({ state: 'detached' });
  await t.row('local', 'Beta').waitFor();

  // "+" of a row of the other service adds a terminal there, opened through that service.
  await t.sheet();
  await t.press(t.row('remote:7', 'Alpha').locator('.h5-task-add'));
  await page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'Alpha' && document.getElementById('h5-task-service')?.textContent === 'VPS');
  assert.equal(await page.locator('#h5-new-session-task').textContent(), 'Alpha', `${label}: the New session dialog names the row's task`);
  assert.equal(await page.locator('#h5-new-session-service').textContent(), 'VPS', `${label}: and its service`);
  await t.press(page.locator('#h5-new-session #h5-term-menu-actions button', { hasText: 'New Terminal' }));
  await page.locator('#h5-new-session').waitFor({ state: 'detached' });
  if (!wide) await page.locator('#h5-tasks').waitFor({ state: 'hidden' }); // creating a terminal closes the sheet of a phone
  await t.waitSocket('/api/remote-servers/7/terminal/ws');
  assert.ok(lastWrite(world, 'POST', '/api/remote-servers/7/tasks/1/terminals'), `${label}: "+" made the terminal on the row's service`);

  // The working directory of the other service's row. The dialog shows the service of that row.
  await t.taskMenu('local', 'Alpha');
  await t.press(t.menuItem('Edit working directory'));
  await page.locator('#h5-task-workdir').fill('/w/changed');
  await t.press(page.locator('#h5-task-dialog-ok'));
  await page.locator('#h5-task-dialog').waitFor({ state: 'detached' });
  assert.deepEqual(lastWrite(world, 'PUT', '/api/tasks/1'), ['PUT', '/api/tasks/1', { work_dir: '/w/changed' }], `${label}: working directory on the row's service`);

  // Delete from a row of the other service, shown task elsewhere.
  await t.taskMenu('remote:7', 'Alpha'); // the shown task
  await t.press(t.menuItem('Delete'));
  await page.locator('#h5-task-dialog-service').waitFor();
  assert.equal(await page.locator('#h5-task-dialog-service').textContent(), 'VPS', `${label}: the dialog names the service`);
  await t.press(page.locator('#h5-task-dialog-ok'));
  await page.locator('#h5-task-dialog').waitFor({ state: 'detached' });
  assert.ok(lastWrite(world, 'DELETE', '/api/remote-servers/7/tasks/1'), `${label}: delete went to the row's service`);
  assert.equal(lastWrite(world, 'DELETE', '/api/tasks/1'), undefined, `${label}: not to this machine`);
  await page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'Choose a task');
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

async function testActivity(browser, wide) {
  const label = wide ? 'wide' : 'phone';
  const world = makeWorld();
  const { context, page } = await open(browser, world, wide);
  const t = tools(page, wide);
  await t.sheet();
  await t.row('remote:7', 'Alpha').waitFor();
  await page.waitForFunction(([a, b]) => window.activityStream.open(a) && window.activityStream.open(b), [LOCAL_STREAM, REMOTE_STREAM]);
  await pushActivity(page, LOCAL_STREAM, { activity: { 1: { default: 'running' } }, subagents: {} });
  await pushActivity(page, REMOTE_STREAM, { activity: { 2: { b1: 'done' } }, subagents: {} });
  await page.waitForFunction(() => window.H5UI.get().activeCount === 2);

  // Filters and search cover both services.
  const search = page.locator('#h5-task-search-input');
  await search.fill('alpha');
  await t.row('local', 'Alpha').waitFor();
  await t.row('remote:7', 'Alpha').waitFor();
  assert.equal(await t.section('local').locator('.h5-task-row').count(), 1, `${label}: search keeps the matching task`);
  await search.fill('');
  await page.locator('.h5-task-filters').getByText('Running', { exact: true }).click();
  await t.row('local', 'Alpha').waitFor();
  assert.equal(await page.locator('.h5-task[data-source="remote:7"]').count(), 0, `${label}: the remote service has nothing running`);
  await page.locator('.h5-task-filters').getByText('Pending', { exact: true }).click();
  await t.row('remote:7', 'Beta').waitFor();
  assert.equal(await page.locator('.h5-task[data-source="local"]').count(), 0, `${label}: this machine has nothing pending`);
  await page.locator('.h5-task-filters').getByText('All', { exact: true }).click();

  // The next-session button crosses services: the one running here, then the pending one there, and back.
  world.local.activity = { 1: { default: 'running' } }; world.vps.activity = { 2: { b1: 'done' } };
  await page.evaluate(() => window.H5UI.actions.nextActiveSession());
  await page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'Alpha');
  await t.waitSocket('/terminal/ws');
  await page.evaluate(() => window.H5UI.actions.nextActiveSession());
  await page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'Beta' && document.getElementById('h5-task-service')?.textContent === 'VPS');
  await t.waitSocket('/api/remote-servers/7/terminal/ws');
  await page.evaluate(() => window.H5UI.actions.nextActiveSession());
  await page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'Alpha');
  await t.waitSocket('/terminal/ws');
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

async function testOfflineAndReturn(browser, wide) {
  const label = wide ? 'wide' : 'phone';
  const world = makeWorld();
  world.vps.offline = true;
  const { context, page } = await open(browser, world, wide);
  const t = tools(page, wide);
  await t.sheet();
  await t.row('local', 'Alpha').waitFor();
  await page.waitForFunction(() => (window.H5UI.get().sources.find(item => item.key === 'remote:7') || {}).offline === true);
  assert.equal(await t.section('remote:7').count(), 0, `${label}: an offline service that never answered adds no rows`);
  assert.doesNotMatch(await page.locator('#h5-task-list').textContent(), /Could not/, `${label}: no error text`);
  assert.equal(await page.evaluate(url => window.activityStream.open(url), REMOTE_STREAM), false, `${label}: no feed while offline`);

  // It comes back by itself (the slow poll runs while the page is visible).
  world.vps.offline = false;
  await t.row('remote:7', 'Alpha').waitFor({ timeout: 40000 });
  assert.equal(await page.locator('.h5-device-tag[data-offline]').count(), 0, `${label}: the Offline mark is gone`);
  await page.waitForFunction(url => window.activityStream.open(url), REMOTE_STREAM);

  // Going offline in use: a dropped feed reads the list again and marks it. A task of another service stays usable.
  await page.waitForTimeout(5200); // a failed feed reads the list at most every 5 s, and it was just read
  world.vps.offline = true;
  await page.evaluate(url => window.activityStream.drop(url), REMOTE_STREAM);
  await page.locator('.h5-task[data-source="remote:7"] .h5-device-tag[data-offline="true"]').first().waitFor({ timeout: 10000 });
  assert.equal(await t.section('remote:7').count(), 2, `${label}: its rows stay where they were, with a muted tag`);
  assert.match(await page.locator('.h5-task[data-source="remote:7"] .h5-device-tag').first().getAttribute('title'), /VPS · Offline/, `${label}: the tag says Offline`);
  await t.row('local', 'Alpha').waitFor();
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

async function testNewTask(browser, wide) {
  const label = wide ? 'wide' : 'phone';
  const world = makeWorld();
  const { context, page } = await open(browser, world, wide);
  const t = tools(page, wide);
  await t.sheet();
  await t.row('remote:7', 'Alpha').waitFor();
  await t.press(page.locator('#h5-add-task'));
  await page.locator('#h5-new-task-on').waitFor();
  assert.deepEqual(await page.locator('#h5-new-task-on option').allTextContents(), ['This machine', 'VPS'], `${label}: the online services`);
  assert.equal(await page.locator('#h5-new-task-on').inputValue(), 'local', `${label}: this machine by default`);
  assert.match(await page.locator('#h5-new-task-dir-help').textContent(), /Leave empty to use the default/, `${label}: the local hint`);
  await page.locator('#h5-new-task-on').selectOption('remote:7');
  assert.match(await page.locator('#h5-new-task-dir-help').textContent(), /Absolute path on the remote engine/, `${label}: the hint follows the choice`);
  await page.fill('#h5-new-task-title', 'Made there');
  await t.press(page.locator('#h5-new-task button[type="submit"]'));
  await page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'Made there');
  await page.locator('#h5-new-task-dialog').waitFor({ state: 'detached' }); // the New task dialog closes once the task is made
  assert.deepEqual(lastWrite(world, 'POST', '/api/remote-servers/7/tasks'), ['POST', '/api/remote-servers/7/tasks', { title: 'Made there' }], `${label}: made on the chosen service`);
  assert.equal(lastWrite(world, 'POST', '/api/tasks'), undefined, `${label}: not on this machine`);
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

async function testOneService(browser, wide) {
  const label = wide ? 'wide' : 'phone';
  const world = makeWorld({ remote: false });
  const { context, page } = await open(browser, world, wide);
  const t = tools(page, wide);
  await t.sheet();
  await page.locator('.h5-task-item', { hasText: 'Alpha' }).first().waitFor();
  assert.equal(await page.locator('.h5-device-tag').count(), 0, `${label}: no device tags with one service`);
  await t.press(page.locator('#h5-add-task'));
  await page.locator('#h5-new-task-title').waitFor();
  assert.equal(await page.locator('#h5-new-task-on').count(), 0, `${label}: no "Create on" with one service`);
  await t.press(page.locator('#h5-new-task-cancel'));
  await page.locator('#h5-new-task-dialog').waitFor({ state: 'detached' });
  assert.equal(await page.locator('#h5-archived-toggle').count(), 1, `${label}: Archived is there`);
  await t.openEngines();
  await page.locator('#h5-engine-empty').waitFor();
  assert.equal(await page.locator('.h5-engine-visible').count(), 0, `${label}: the setting is absent with one device`);
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

async function testRemembered(browser, wide) {
  const label = wide ? 'wide' : 'phone';
  const world = makeWorld();
  const { context, page } = await open(browser, world, wide, { storage: { 'h5-source': 'remote:7', 'h5-task:remote:7': '2', 'h5-task:local': '1' } });
  const t = tools(page, wide);
  await page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'Beta');
  await t.waitSocket('/api/remote-servers/7/terminal/ws');
  assert.equal(await t.service(), 'VPS', `${label}: the remembered remote task`);

  // The service went offline: this machine's remembered task, no error, no early socket left open to the offline one.
  world.vps.offline = true;
  await page.reload();
  await page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'Alpha');
  await t.waitSocket('/terminal/ws');
  assert.equal(await t.service(), null, `${label}: on this machine`);
  await page.waitForFunction(() => window.sockets.every(item => item.readyState === 3 || new URL(item.url).pathname === '/terminal/ws'));
  assert.equal(await page.locator('.h5-list-note').count(), 0, `${label}: no error in the list`);
  // Back online, the remembered service is tried again on the next load.
  world.vps.offline = false;
  await page.reload();
  await page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'Beta');
  await t.waitSocket('/api/remote-servers/7/terminal/ws');
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

async function testArchived(browser, wide) {
  const label = wide ? 'wide' : 'phone';
  const world = makeWorld();
  const { context, page } = await open(browser, world, wide);
  const t = tools(page, wide);
  await t.sheet();
  await t.row('remote:7', 'Alpha').waitFor();
  await t.press(page.locator('#h5-archived-toggle'));
  await page.waitForFunction(() => document.querySelectorAll('.h5-archived-row').length === 2);
  const rows = page.locator('.h5-archived-row');
  const texts = await rows.allTextContents();
  assert.equal(texts.filter(text => text.includes('Old one')).length, 2, `${label}: the same archived task on each service`);
  assert.equal(await page.locator('.h5-archived-service').count(), 1, `${label}: only the other service is named`);
  assert.match(await page.locator('.h5-archived-service').textContent(), /VPS/);
  await t.press(page.locator('.h5-archived-row[data-ref="remote:7|50"] .h5-archived-restore'));
  await t.row('remote:7', 'Old one').waitFor();
  assert.ok(lastWrite(world, 'POST', '/api/remote-servers/7/tasks/50/restore'), `${label}: Restore on the row's service`);
  assert.equal(lastWrite(world, 'POST', '/api/tasks/50/restore'), undefined, `${label}: not on this machine`);
  await page.locator('.h5-archived-row[data-ref="local|50"]').waitFor();
  await t.press(page.locator('.h5-archived-row[data-ref="local|50"] .h5-archived-delete'));
  await page.locator('#h5-task-delete-text').waitFor();
  await t.press(page.locator('#h5-task-dialog-ok'));
  await page.locator('.h5-archived-row[data-ref="local|50"]').waitFor({ state: 'detached' });
  assert.ok(lastWrite(world, 'DELETE', '/api/tasks/50'), `${label}: Delete on the row's service`);
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

async function testHidden(browser, wide) {
  const label = wide ? 'wide' : 'phone';
  const world = makeWorld({ linked: true });
  const { context, page } = await open(browser, world, wide);
  const t = tools(page, wide);
  await t.sheet();
  await t.row('remote:7', 'Alpha').waitFor();
  await page.waitForFunction(([a, b]) => window.activityStream.open(a) && window.activityStream.open(b), [LOCAL_STREAM, REMOTE_STREAM]);
  await pushActivity(page, LOCAL_STREAM, { activity: { 1: { default: 'running' } }, subagents: {} });
  await pushActivity(page, REMOTE_STREAM, { activity: { 2: { b1: 'running' } }, subagents: {} });
  await page.waitForFunction(() => window.H5UI.get().activeCount === 2);
  await t.openTask('remote:7', 'Alpha');
  await t.waitSocket('/api/remote-servers/7/terminal/ws');
  const opened = await page.evaluate(() => window.sockets.filter(item => item.readyState === 1).length);

  await t.openEngines();
  await page.locator('.h5-engine-row[data-engine="7"] .h5-engine-linked').waitFor();
  assert.equal(await page.locator('.h5-engine-row[data-engine="7"] .h5-engine-edit').count(), 0, `${label}: a linked row cannot be edited`);
  const remoteSwitch = page.locator('.h5-engine-visible[data-device="remote:7"] input');
  const localSwitch = page.locator('.h5-engine-visible[data-device="local"] input');
  await remoteSwitch.waitFor({ state: 'attached' });
  assert.equal(await remoteSwitch.isChecked(), true, `${label}: shown by default`);
  assert.equal(await localSwitch.isDisabled(), false, `${label}: two devices can be switched`);
  await remoteSwitch.click();
  await page.waitForFunction(() => window.H5UI.get().hiddenDevices.keys.includes('remote:7'));
  assert.deepEqual(world.hidden, ['remote:7'], `${label}: saved on the service`);
  assert.equal(await localSwitch.isDisabled(), true, `${label}: the last visible device cannot be hidden`);
  await t.closeSettings();

  // Rows, count and feed go; the shown terminal stays until the person opens something else.
  await t.sheet();
  await t.row('local', 'Alpha').waitFor();
  assert.equal(await page.locator('.h5-task[data-source="remote:7"]').count(), 0, `${label}: its rows are gone`);
  assert.equal(await page.locator('.h5-device-tag').count(), 0, `${label}: this machine alone has no tags`);
  await page.waitForFunction(() => window.H5UI.get().activeCount === 1);
  await page.waitForFunction(url => !window.activityStream.open(url), REMOTE_STREAM);
  assert.equal(await t.service(), 'VPS', `${label}: the task keeps being shown`);
  assert.equal(await page.evaluate(() => window.sockets.filter(item => item.readyState === 1).length), opened, `${label}: its terminal stays connected`);
  // Search, the Archived section.
  await page.locator('#h5-task-search-input').fill('Alpha');
  assert.equal(await page.locator('.h5-task-row').count(), 1, `${label}: search leaves it out`);
  await page.locator('#h5-task-search-input').fill('');
  await t.press(page.locator('#h5-archived-toggle'));
  await page.waitForFunction(() => document.querySelectorAll('.h5-archived-row').length === 1);
  assert.equal(await page.locator('.h5-archived-service').count(), 0, `${label}: its archived rows are left out`);
  assert.ok(!world.reads.includes('/api/remote-servers/7/tasks?archived=1'), `${label}: and its archive is not read`);
  await page.evaluate(() => window.H5UI.actions.nextActiveSession());
  await page.waitForTimeout(150);
  assert.equal(await t.shownName(), 'Alpha', `${label}: the next-session button leaves it out too`);

  // A reload keeps it, and a hidden device's task is not the remembered selection.
  const opensBefore = await page.evaluate(() => window.activityStream.opens.length);
  world.reads.length = 0;
  world.writes.length = 0;
  await page.evaluate(() => localStorage.setItem('h5-task:local', '2'));
  await page.reload();
  await page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'Beta');
  await t.waitSocket('/terminal/ws');
  assert.equal(await t.service(), null, `${label}: fell back to a visible device`);
  assert.equal(await page.locator('.h5-device-tag').count(), 0, `${label}: still hidden after a reload`);
  await page.waitForTimeout(200);
  assert.ok(!(await page.evaluate(() => window.activityStream.opens)).some(url => url.includes('/7/')), `${label}: no feed is opened for it after a reload`);
  assert.equal(count(world.reads, '/api/remote-servers/7/tasks/terminal-activity'), 0, `${label}: and it is not polled`);
  void opensBefore;

  // Shown again: rows, count and feed come back; the switch works from a reload.
  await t.openEngines();
  await page.locator('.h5-engine-visible[data-device="remote:7"] input').click();
  await page.waitForFunction(() => !window.H5UI.get().hiddenDevices.keys.includes('remote:7'));
  await t.closeSettings();
  await t.sheet();
  await t.row('remote:7', 'Alpha').waitFor();
  assert.deepEqual([...new Set(await page.locator('.h5-device-tag').evaluateAll(nodes => nodes.map(node => node.dataset.source)))], ['local', 'remote:7'], `${label}: both devices tagged again`);
  await page.waitForFunction(url => window.activityStream.open(url), REMOTE_STREAM);
  await pushActivity(page, REMOTE_STREAM, { activity: { 2: { b1: 'running' } }, subagents: {} });
  await pushActivity(page, LOCAL_STREAM, { activity: { 1: { default: 'running' } }, subagents: {} });
  await page.waitForFunction(() => window.H5UI.get().activeCount === 2);

  // Hiding this machine, the service remains alone: no tags, only its rows.
  await t.openEngines();
  await page.locator('.h5-engine-visible[data-device="local"] input').click();
  await page.waitForFunction(() => window.H5UI.get().hiddenDevices.keys.includes('local'));
  assert.equal(await page.locator('.h5-engine-visible[data-device="remote:7"] input').isDisabled(), true, `${label}: the last visible one, the other way round`);
  await t.closeSettings();
  await t.sheet();
  await t.row('remote:7', 'Alpha').waitFor();
  assert.equal(await page.locator('.h5-task[data-source="local"]').count(), 0, `${label}: this machine can be hidden too`);
  assert.equal(await page.locator('.h5-device-tag').count(), 0, `${label}: one device left: no tags`);
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

async function testOlderServer(browser, wide) {
  const label = wide ? 'wide' : 'phone';
  const world = makeWorld({ hiddenRoute: false });
  const { context, page } = await open(browser, world, wide);
  const t = tools(page, wide);
  await t.sheet();
  await t.row('remote:7', 'Alpha').waitFor();
  await t.openEngines();
  await page.locator('.h5-engine-row[data-engine="7"]').waitFor();
  assert.equal(await page.locator('.h5-engine-visible').count(), 0, `${label}: an older server has no switches`);
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const wide of [true, false]) {
      await testTwoServices(browser, wide);
      await testActivity(browser, wide);
      await testNewTask(browser, wide);
      await testOneService(browser, wide);
      await testRemembered(browser, wide);
      await testArchived(browser, wide);
      await testHidden(browser, wide);
      await testOlderServer(browser, wide);
      await testOfflineAndReturn(browser, wide);
    }
    console.log('h5 one list: ok');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
