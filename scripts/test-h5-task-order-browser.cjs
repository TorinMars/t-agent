// The one flat task list in the shared order (`GET` / `PUT /api/task-order`), in real Chromium at phone size (390x844, touch) and on a computer (1280x800, mouse),
// with the routes mocked: no section per device; a device tag in front of each task name with the device's name and a colour that comes from its instance id
// (none with one device); the order from the API applied, new tasks first; a drag with the mouse (and Escape) and a long-press drag on a touch screen save the
// right whole order; the menu moves; keys of devices not shown are kept in place; a failed save moves back; a newer order is applied on refresh, after a drag;
// groups and the "Move to" of a group stay; an Engine without an instance id is placed last and cannot be moved until its id is known; an older server (404)
// keeps today's order and offers no sorting. H5_SHOT_DIR=<dir> saves the list at 390px and wide.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const LOCAL_ID = '6c1d1c1e-0000-4000-8000-00000000000a';
const VPS_ID = '9f2b7a33-0000-4000-8000-00000000000b';
const OLD_ID = '1a2b3c4d-0000-4000-8000-00000000000c';
const HIDDEN_KEY = 'aaaa0000-0000-4000-8000-0000000000ff:5'; // a task of a device this page does not list
const L = id => `${LOCAL_ID}:${id}`;
const V = id => `${VPS_ID}:${id}`;
const task = (id, title, status = 'doing') => ({ id, title, status, work_dir: `/w/${title.toLowerCase()}`, archived_at: null });

function makeWorld({ orderRoute = true, remote = true, older = false, groups = null } = {}) {
  return {
    orderRoute, remote, older, writes: [], reads: [], pageErrors: [], failPut: false, holdPut: null,
    groups: groups || [{ key: 'doing', name: 'In progress', sort_order: 1 }, { key: 'todo', name: 'To do', sort_order: 2 }],
    local: [task(1, 'Alpha'), task(2, 'Beta'), task(3, 'Gamma')],
    vps: [task(1, 'Delta'), task(2, 'Echo')],
    old: [task(1, 'Foxtrot')],
    oldId: null, // the older Engine's instance id, null until the server knows it
    // Beta (local 2) is not in the order: a new task, shown first.
    order: { order: [V(2), L(1), HIDDEN_KEY, V(1), L(3)], updated_at: 5 },
  };
}
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function serve(world, route) {
  const url = new URL(route.request().url());
  const pathname = url.pathname;
  const method = route.request().method();
  const body = method === 'GET' ? null : route.request().postDataJSON();
  if (method !== 'GET') world.writes.push([method, pathname, body]);
  else world.reads.push(pathname);
  if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
  if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
  if (pathname === '/api/system/version') return json(route, { app_version: '2.103.0', boot_id: 'b1', engine_name: 'MacBook', ...(world.orderRoute ? { instance_id: LOCAL_ID } : {}) });
  if (pathname === '/api/remote-servers') {
    const rows = [];
    if (world.remote) rows.push({ id: 7, name: 'VPS', status: 'online', enabled: true, ...(world.orderRoute ? { instance_id: VPS_ID } : {}) });
    if (world.older) rows.push({ id: 8, name: 'Old box', status: 'online', enabled: true, instance_id: world.oldId });
    return json(route, rows);
  }
  if (pathname === '/api/task-order') {
    if (!world.orderRoute) return json(route, { error: 'not found' }, 404);
    if (method === 'PUT') {
      if (world.holdPut) await world.holdPut;
      if (world.failPut) return json(route, { error: 'INVALID_TASK_ORDER' }, 400);
      world.order = { order: body.order, updated_at: world.order.updated_at + 1 };
    }
    return json(route, world.order);
  }
  if (pathname === '/api/task-list/hidden-devices') return json(route, { hidden: [] });
  if (pathname === '/api/service-links') return json(route, { supported: true, links: [] });
  const remote = pathname.match(/^\/api\/remote-servers\/(\d+)(\/.*)?$/);
  const list = remote ? (remote[1] === '7' ? world.vps : world.old) : world.local;
  const tail = remote ? remote[2] || '' : pathname.replace(/^\/api/, '');
  if (tail === '/task-groups') return json(route, world.groups);
  if (tail === '/info') return json(route, { capabilities: ['terminal:control', 'tasks:archive'] });
  if (/\/terminal-activity$|\/terminal-subagents$/.test(tail)) return json(route, {});
  if (tail === '/tasks' && method === 'GET') return json(route, url.searchParams.get('archived') === '1' ? [] : list);
  const hit = tail.match(/^\/tasks\/(\d+)(?:\/(.+))?$/);
  if (hit && !hit[2] && method === 'PUT') { Object.assign(list.find(item => item.id === Number(hit[1])) || {}, body); return json(route, {}); }
  if (hit && hit[2] === 'terminals') return json(route, [{ terminal_id: 'default', title: 'Shell' }]);
  if (hit && /^terminal\/(ack|control)$/.test(hit[2])) return json(route, {});
  return json(route, { error: 'not mocked' }, 404);
}

async function open(browser, world, wide) {
  const context = await browser.newContext(wide ? { viewport: { width: 1280, height: 800 } } : { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', error => world.pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send() {}
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
  });
  await page.addInitScript(activityStreamMock);
  await page.route(`${ORIGIN}/**`, route => serve(world, route));
  await page.goto(`${ORIGIN}/h5`);
  return { context, page };
}

function tools(page, wide) {
  const press = locator => (wide ? locator.click() : locator.tap());
  const settle = () => page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity));
  const sheet = async () => {
    if (!wide && !await page.locator('#h5-tasks').isVisible()) await page.locator('#h5-open-tasks').tap();
    await page.locator('#h5-tasks').waitFor({ state: 'visible' });
    await settle();
  };
  const closeSheet = async () => { if (!wide) { await page.evaluate(() => window.H5UI.actions.closeTasks()); await page.locator('#h5-tasks').waitFor({ state: 'hidden' }); } };
  const titles = () => page.locator('#h5-task-list .h5-task .h5-task-title').allTextContents();
  const waitTitles = wanted => page.waitForFunction(want => JSON.stringify([...document.querySelectorAll('#h5-task-list .h5-task .h5-task-title')].map(node => node.textContent)) === JSON.stringify(want), wanted);
  const row = title => page.locator('#h5-task-list .h5-task').filter({ has: page.locator('.h5-task-title', { hasText: title }) });
  const box = async title => row(title).locator('.h5-task-item').boundingBox();
  const lastPut = world => world.writes.filter(([method, p]) => method === 'PUT' && p === '/api/task-order').at(-1);
  const puts = world => world.writes.filter(([method, p]) => method === 'PUT' && p === '/api/task-order').length;
  const menu = async title => {
    await sheet();
    await press(row(title).locator('.h5-task-more'));
    await page.locator('#h5-term-menu-actions').first().waitFor();
    await settle();
  };
  const item = text => page.locator('#h5-term-menu-actions button', { hasText: text });
  const notice = wanted => page.waitForFunction(text => ((window.H5UI.get().notice || {}).message || '').startsWith(text), wanted);
  // A mouse drag of the row `from` to the middle of the upper half of `to` (before it), or of its lower half (after it).
  const mouseDrag = async (from, to, { after = false, release = true } = {}) => {
    const a = await box(from);
    const b = await box(to);
    await page.mouse.move(a.x + 60, a.y + a.height / 2);
    await page.mouse.down();
    const y = b.y + (after ? b.height * 0.8 : b.height * 0.2);
    await page.mouse.move(a.x + 62, a.y + a.height / 2 + 3, { steps: 2 }); // under the threshold
    await page.mouse.move(b.x + 60, y, { steps: 8 });
    if (release) await page.mouse.up();
  };
  return { press, settle, sheet, closeSheet, titles, waitTitles, row, box, lastPut, puts, menu, item, notice, mouseDrag };
}

// A finger on the touch screen, through the DevTools protocol (real touch events: the page's long press, scrolling and taps see what a phone sends).
async function finger(page) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  return {
    async longDrag(from, to, { hold = 500, steps = 10 } = {}) {
      await touch('touchStart', from.x, from.y);
      await page.waitForTimeout(hold);
      for (let index = 1; index <= steps; index += 1) {
        await touch('touchMove', from.x + ((to.x - from.x) * index) / steps, from.y + ((to.y - from.y) * index) / steps);
        await page.waitForTimeout(16);
      }
      await touch('touchEnd');
    },
    async swipe(from, to, steps = 8) {
      await touch('touchStart', from.x, from.y);
      for (let index = 1; index <= steps; index += 1) { await touch('touchMove', from.x, from.y + ((to.y - from.y) * index) / steps); await page.waitForTimeout(16); }
      await touch('touchEnd');
    },
    async tap(at) { await touch('touchStart', at.x, at.y); await page.waitForTimeout(60); await touch('touchEnd'); },
  };
}
const centre = rect => ({ x: rect.x + 60, y: rect.y + rect.height / 2 });

// The order from the API, new tasks first; one flat list; the tags.
const FIRST = ['Beta', 'Echo', 'Alpha', 'Delta', 'Gamma'];
async function testFlatList(browser, wide) {
  const label = wide ? 'wide' : 'phone';
  const { tagColorIndex } = await import('./h5-shell/task-order.mjs');
  const world = makeWorld();
  const { context, page } = await open(browser, world, wide);
  const t = tools(page, wide);
  await t.sheet();
  await t.waitTitles(FIRST);
  assert.equal(await page.locator('.h5-source-header, .h5-source, #h5-task-list h3').count(), 0, `${label}: no section or group headers`);
  assert.deepEqual(await page.locator('#h5-task-list .h5-task .h5-device-tag').allTextContents(), ['MacBook', 'VPS', 'MacBook', 'VPS', 'MacBook'], `${label}: each task has its device tag`);
  assert.equal(await t.row('Beta').locator('.h5-device-tag').getAttribute('title'), 'MacBook · This machine', `${label}: the full name is the title`);
  // The colour: the same for every row of a device, from its instance id.
  const colours = await page.locator('#h5-task-list .h5-device-tag').evaluateAll(nodes => nodes.map(node => [node.dataset.source, node.dataset.color, getComputedStyle(node).color, getComputedStyle(node).backgroundColor]));
  for (const [source, index] of colours) assert.equal(Number(index), tagColorIndex(source === 'local' ? LOCAL_ID : VPS_ID), `${label}: ${source} colour from its id`);
  const bySource = new Map();
  for (const [source, , color, background] of colours) {
    if (bySource.has(source)) assert.deepEqual(bySource.get(source), [color, background], `${label}: one colour per device`);
    bySource.set(source, [color, background]);
  }
  assert.notDeepEqual(bySource.get('local'), bySource.get('remote:7'), `${label}: these two devices differ`);
  // The chevron still sits in front, and the tag is between it and the name.
  const order = await t.row('Alpha').locator('.h5-task-item').evaluate(node => [...node.querySelectorAll('svg, .h5-device-tag, .h5-task-title')].map(item => (item.classList.contains('h5-device-tag') ? 'tag' : item.classList.contains('h5-task-title') ? 'title' : 'chevron')));
  assert.deepEqual(order, ['chevron', 'tag', 'title'], `${label}: chevron, tag, name`);
  // A click (or tap) still opens a row; nothing is saved.
  await t.press(t.row('Alpha').locator('.h5-task-item'));
  await page.waitForFunction(() => [...document.querySelectorAll('.h5-task')].some(node => node.querySelector('.h5-task-title').textContent === 'Alpha' && node.querySelector('.h5-task-item').getAttribute('aria-expanded') === 'true'));
  await t.press(t.row('Alpha').locator('.h5-task-item'));
  assert.equal(t.puts(world), 0, `${label}: no save without a move`);
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await t.settle(); await page.screenshot({ path: path.join(SHOTS, `task-order-${wide ? 'wide' : '390'}.png`) }); }
  // Search and the filters keep the shared order.
  await page.locator('#h5-task-search-input').fill('a'); // Beta, Alpha, Delta, Gamma (Echo has no "a")
  await t.waitTitles(['Beta', 'Alpha', 'Delta', 'Gamma']);
  await page.locator('#h5-task-search-input').fill('');
  // Same colour in another client: a new context reads the same ids.
  const other = await open(browser, makeWorld(), wide);
  const o = tools(other.page, wide);
  await o.sheet();
  await o.waitTitles(FIRST);
  const again = await other.page.locator('#h5-task-list .h5-device-tag').evaluateAll(nodes => nodes.map(node => [node.dataset.source, node.dataset.color, getComputedStyle(node).color, getComputedStyle(node).backgroundColor]));
  assert.deepEqual(again, colours, `${label}: the same colours on another client`);
  await other.context.close();
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

async function testOneDevice(browser, wide) {
  const label = wide ? 'wide' : 'phone';
  const world = makeWorld({ remote: false });
  const { context, page } = await open(browser, world, wide);
  const t = tools(page, wide);
  await t.sheet();
  await t.waitTitles(['Beta', 'Alpha', 'Gamma']);
  assert.equal(await page.locator('.h5-device-tag').count(), 0, `${label}: one device: no tags`);
  assert.equal(await page.locator('.h5-task[data-movable="true"]').count(), 3, `${label}: still sortable`);
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

// The expected whole order after a move: the hidden key stays at its index.
async function testMouseDrag(browser) {
  const label = 'wide';
  const world = makeWorld();
  const { context, page } = await open(browser, world, true);
  const t = tools(page, true);
  await t.sheet();
  await t.waitTitles(FIRST);
  // Gamma (last) before Echo: the line shows during the drag, the row is faded.
  await t.mouseDrag('Gamma', 'Echo', { release: false });
  await page.locator('#h5-task-list .h5-task-drop').waitFor();
  assert.equal(await t.row('Gamma').getAttribute('data-dragging'), 'true', `${label}: the dragged row is marked`);
  const line = await page.locator('.h5-task-drop').boundingBox();
  const echo = await t.box('Echo');
  assert.ok(Math.abs(line.y - echo.y) < 6, `${label}: the line is at the top of Echo`);
  await page.mouse.up();
  await t.waitTitles(['Beta', 'Gamma', 'Echo', 'Alpha', 'Delta']);
  await page.waitForFunction(() => !document.querySelector('.h5-task-drop'));
  assert.deepEqual(t.lastPut(world)[2], { order: [L(2), L(3), V(2), HIDDEN_KEY, L(1), V(1)] }, `${label}: the whole order, the hidden key kept in its place`);
  assert.equal(t.puts(world), 1, `${label}: one save`);
  assert.equal(await t.row('Gamma').locator('.h5-task-item').getAttribute('aria-expanded'), 'false', `${label}: the drop did not open the row`);
  // After the last row.
  await t.mouseDrag('Beta', 'Delta', { after: true });
  await t.waitTitles(['Gamma', 'Echo', 'Alpha', 'Delta', 'Beta']);
  assert.deepEqual(t.lastPut(world)[2], { order: [L(3), V(2), L(1), HIDDEN_KEY, V(1), L(2)] }, `${label}: to the end`);
  // Escape cancels: nothing moves, nothing is saved, the row does not open.
  const before = t.puts(world);
  await t.mouseDrag('Alpha', 'Gamma', { release: false });
  await page.locator('.h5-task-drop').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.h5-task-drop').waitFor({ state: 'detached' });
  await page.mouse.up();
  await page.waitForTimeout(150);
  assert.equal(t.puts(world), before, `${label}: Escape saves nothing`);
  await t.waitTitles(['Gamma', 'Echo', 'Alpha', 'Delta', 'Beta']);
  assert.equal(await t.row('Alpha').locator('.h5-task-item').getAttribute('aria-expanded'), 'false', `${label}: and opens nothing`);
  // A newer order arriving during a drag waits for the drop, and the drop is made on it.
  await t.mouseDrag('Echo', 'Beta', { after: true, release: false });
  world.order = { order: [L(1), V(1), V(2), L(3), L(2), HIDDEN_KEY], updated_at: world.order.updated_at + 5 };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(300);
  assert.deepEqual(await t.titles(), ['Gamma', 'Echo', 'Alpha', 'Delta', 'Beta'], `${label}: the rows stay still during the drag`);
  await page.mouse.up();
  await t.waitTitles(['Alpha', 'Delta', 'Gamma', 'Beta', 'Echo']);
  assert.deepEqual(t.lastPut(world)[2], { order: [L(1), V(1), L(3), L(2), V(2), HIDDEN_KEY] }, `${label}: the drop moved Echo in the newer order`);
  // Auto-scroll near the bottom edge of a short list.
  await page.setViewportSize({ width: 1280, height: 330 });
  await t.settle();
  const list = page.locator('#h5-task-list');
  const scrollable = await list.evaluate(node => node.scrollHeight > node.clientHeight);
  if (scrollable) {
    const a = await t.box((await t.titles())[0]); // the first row, in view at the top
    const edge = await list.boundingBox();
    await page.mouse.move(a.x + 60, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + 60, a.y + 20, { steps: 3 });
    await page.mouse.move(a.x + 60, edge.y + edge.height - 6, { steps: 4 });
    await page.waitForFunction(() => document.getElementById('h5-task-list').scrollTop > 0);
    await page.keyboard.press('Escape');
    await page.mouse.up();
  }
  assert.ok(scrollable, `${label}: the short list scrolls (auto-scroll checked)`);
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

async function testTouch(browser) {
  const label = 'phone';
  const world = makeWorld();
  const { context, page } = await open(browser, world, false);
  const t = tools(page, false);
  await t.sheet();
  await t.waitTitles(FIRST);
  const f = await finger(page);
  // A long press on Gamma, then the finger goes to the top half of Echo.
  const echo = await t.box('Echo');
  await f.longDrag(centre(await t.box('Gamma')), { x: echo.x + 60, y: echo.y + echo.height * 0.25 });
  await t.waitTitles(['Beta', 'Gamma', 'Echo', 'Alpha', 'Delta']);
  assert.deepEqual(t.lastPut(world)[2], { order: [L(2), L(3), V(2), HIDDEN_KEY, L(1), V(1)] }, `${label}: the long-press drag saved the whole order`);
  await page.waitForTimeout(300);
  assert.equal(await t.row('Gamma').locator('.h5-task-item').getAttribute('aria-expanded'), 'false', `${label}: the drop did not open the row`);
  // A quick tap opens the row; nothing is saved.
  const saved = t.puts(world);
  await f.tap(centre(await t.box('Alpha')));
  await page.waitForFunction(() => [...document.querySelectorAll('.h5-task')].some(node => node.querySelector('.h5-task-title').textContent === 'Alpha' && node.querySelector('.h5-task-item').getAttribute('aria-expanded') === 'true'));
  await f.tap(centre(await t.box('Alpha')));
  await page.waitForTimeout(200);
  // A finger that moves at once scrolls: no drag.
  const delta = await t.box('Delta');
  await f.swipe(centre(delta), { x: delta.x + 60, y: delta.y - 120 });
  await page.waitForTimeout(600);
  assert.equal(await page.locator('.h5-task-drop').count(), 0, `${label}: a swipe is not a drag`);
  assert.equal(t.puts(world), saved, `${label}: taps and swipes save nothing`);
  // "⋯" and "+" still work with a tap (they are not part of the drag).
  await t.press(t.row('Echo').locator('.h5-task-more'));
  await page.locator('#h5-term-menu-actions').first().waitFor();
  await page.locator('#h5-term-menu-cancel').tap();
  await page.locator('#h5-term-menu-actions').first().waitFor({ state: 'detached' });
  assert.equal(t.puts(world), saved, `${label}: still nothing saved`);
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

async function testMenu(browser, wide) {
  const label = wide ? 'wide' : 'phone';
  const world = makeWorld();
  const { context, page } = await open(browser, world, wide);
  const t = tools(page, wide);
  await t.sheet();
  await t.waitTitles(FIRST);
  await t.menu('Beta');
  assert.equal(await t.item('Move to top').isDisabled(), true, `${label}: the first cannot go up`);
  assert.equal(await t.item('Move up').isDisabled(), true);
  assert.equal(await t.item('Move down').isDisabled(), false);
  assert.ok(await t.item('Move to “To do”').count(), `${label}: the group moves stay`);
  await t.press(t.item('Move down'));
  await t.waitTitles(['Echo', 'Beta', 'Alpha', 'Delta', 'Gamma']);
  assert.deepEqual(t.lastPut(world)[2], { order: [V(2), L(2), L(1), HIDDEN_KEY, V(1), L(3)] }, `${label}: Move down`);
  await t.menu('Gamma');
  assert.equal(await t.item('Move down').isDisabled(), true, `${label}: the last cannot go down`);
  assert.equal(await t.item('Move to bottom').isDisabled(), true);
  await t.press(t.item('Move to top'));
  await t.waitTitles(['Gamma', 'Echo', 'Beta', 'Alpha', 'Delta']);
  await t.menu('Gamma');
  await t.press(t.item('Move to bottom'));
  await t.waitTitles(['Echo', 'Beta', 'Alpha', 'Delta', 'Gamma']);
  await t.menu('Delta');
  await t.press(t.item('Move up'));
  await t.waitTitles(['Echo', 'Beta', 'Delta', 'Alpha', 'Gamma']);
  assert.deepEqual(world.order.order, [V(2), L(2), V(1), HIDDEN_KEY, L(1), L(3)], `${label}: the saved order after four moves, the hidden key in place`);
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

async function testFailure(browser, wide) {
  const label = wide ? 'wide' : 'phone';
  const world = makeWorld();
  const { context, page } = await open(browser, world, wide);
  const t = tools(page, wide);
  await t.sheet();
  await t.waitTitles(FIRST);
  world.failPut = true;
  let release;
  world.holdPut = new Promise(resolve => { release = resolve; });
  await t.menu('Gamma');
  await t.press(t.item('Move to top'));
  await t.waitTitles(['Gamma', ...FIRST.slice(0, 4)]); // at once
  release();
  await t.notice('Could not save the task order');
  await t.waitTitles(FIRST); // back
  world.holdPut = null;
  world.failPut = false;
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

// Another client changed the order: a refresh of the list shows it.
async function testRefresh(browser, wide) {
  const label = wide ? 'wide' : 'phone';
  const world = makeWorld();
  const { context, page } = await open(browser, world, wide);
  const t = tools(page, wide);
  await t.sheet();
  await t.waitTitles(FIRST);
  world.order = { order: [L(3), L(2), V(1), V(2), L(1)], updated_at: 9 };
  if (wide) await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // the page shown again
  else { await t.closeSheet(); await t.sheet(); } // the list opened again
  await t.waitTitles(['Gamma', 'Beta', 'Delta', 'Echo', 'Alpha']);
  // An open menu stays open while a newer order comes in.
  await t.menu('Echo');
  world.order = { order: [L(1), L(2), L(3), V(1), V(2)], updated_at: 10 };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await t.waitTitles(['Alpha', 'Beta', 'Gamma', 'Delta', 'Echo']);
  assert.equal(await page.locator('#h5-term-menu-actions').first().isVisible(), true, `${label}: the menu is still open`);
  await t.press(t.item('Move up')); // acts on the order as it is now
  await t.waitTitles(['Alpha', 'Beta', 'Gamma', 'Echo', 'Delta']);
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

// Groups: the list never had group titles; it stays flat in the shared order, and "Move to" a group still works without moving the row.
async function testGroups(browser, wide) {
  const label = wide ? 'wide' : 'phone';
  const world = makeWorld({ groups: [{ key: 'doing', name: 'In progress', sort_order: 1 }, { key: 'todo', name: 'To do', sort_order: 2 }, { key: 'g-ideas', name: 'Ideas', sort_order: 3 }] });
  world.local[2].status = 'g-ideas';
  const { context, page } = await open(browser, world, wide);
  const t = tools(page, wide);
  await t.sheet();
  await t.waitTitles(FIRST);
  assert.equal(await page.locator('#h5-task-list h3, #h5-task-list [role="heading"]').count(), 0, `${label}: no group titles, as before`);
  await t.menu('Alpha');
  await t.press(t.item('Move to “Ideas”'));
  await page.waitForFunction(() => document.querySelectorAll('#h5-term-menu-actions button').length === 0);
  await page.waitForFunction(() => window.H5UI.get().taskList.groups.some(group => group.key === 'g-ideas' && group.tasks.length === 2));
  await t.waitTitles(FIRST);
  assert.deepEqual(world.writes.filter(([m, p]) => m === 'PUT' && p === '/api/tasks/1').at(-1)[2], { status: 'g-ideas' }, `${label}: the group move went to the task`);
  assert.equal(t.puts(world), 0, `${label}: and not to the order`);
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

// An Engine without an instance id: its tasks at the end, not movable, and it says why; once the server knows the id they can be moved.
async function testUnknownId(browser) {
  const label = 'wide';
  const world = makeWorld({ older: true });
  const { context, page } = await open(browser, world, true);
  const t = tools(page, true);
  await t.sheet();
  await t.waitTitles([...FIRST, 'Foxtrot']);
  assert.equal(await t.row('Foxtrot').getAttribute('data-movable'), null, `${label}: it cannot be moved`);
  assert.match(await t.row('Foxtrot').locator('.h5-device-tag').getAttribute('title'), /^Old box · Its tasks can be moved once this device is updated$/, `${label}: the tag says why`);
  assert.equal(await t.row('Foxtrot').locator('.h5-device-tag').getAttribute('data-color'), '-1', `${label}: a neutral tag`);
  await t.mouseDrag('Foxtrot', 'Beta');
  await page.waitForTimeout(150);
  assert.equal(t.puts(world), 0, `${label}: a drag of it saves nothing`);
  await t.menu('Foxtrot');
  assert.equal(await t.item('Move up').count(), 0, `${label}: no move items for it`);
  await page.keyboard.press('Escape');
  // The server learns the id: the rows are read again and its task joins the order as a new task (first, after this machine's new one).
  world.oldId = OLD_ID;
  await page.waitForFunction(() => document.querySelector('.h5-task[data-source="remote:8"]')?.dataset.movable === 'true', null, { timeout: 25000 });
  await t.waitTitles(['Beta', 'Foxtrot', ...FIRST.slice(1)]);
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

// An older server: no /api/task-order. Today's order (this machine, then each service), no sorting at all.
async function testOlderServer(browser, wide) {
  const label = wide ? 'wide' : 'phone';
  const world = makeWorld({ orderRoute: false });
  const { context, page } = await open(browser, world, wide);
  const t = tools(page, wide);
  await t.sheet();
  await t.waitTitles(['Alpha', 'Beta', 'Gamma', 'Delta', 'Echo']);
  assert.equal(await page.locator('.h5-task[data-movable]').count(), 0, `${label}: nothing can be moved`);
  assert.equal(await page.locator('.h5-device-tag').count(), 5, `${label}: the tags are there`);
  assert.equal(await page.locator('.h5-source-header').count(), 0, `${label}: no headers`);
  await t.menu('Beta');
  assert.equal(await t.item('Move up').count(), 0, `${label}: no move items`);
  await t.press(page.locator('#h5-term-menu-cancel'));
  if (wide) { await t.mouseDrag('Echo', 'Alpha'); await page.waitForTimeout(150); }
  await t.waitTitles(['Alpha', 'Beta', 'Gamma', 'Delta', 'Echo']);
  assert.equal(world.writes.filter(([, p]) => p === '/api/task-order').length, 0, `${label}: nothing is saved`);
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const wide of [false, true]) {
      await testFlatList(browser, wide);
      await testOneDevice(browser, wide);
      await testMenu(browser, wide);
      await testFailure(browser, wide);
      await testRefresh(browser, wide);
      await testGroups(browser, wide);
      await testOlderServer(browser, wide);
      console.log(`  ${wide ? 'wide' : 'phone'}: ok`);
    }
    await testMouseDrag(browser);
    console.log('  mouse drag: ok');
    await testTouch(browser);
    console.log('  long-press drag: ok');
    await testUnknownId(browser);
    console.log('  unknown instance id: ok');
    console.log('h5 task order: ok');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
