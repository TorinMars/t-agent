// The one flat task list in the shared order (`GET` / `PUT /api/task-order`), in real Chromium at phone size (390x844, touch) and on a computer (1280x800, mouse),
// with the routes mocked: no section per device; a device tag in front of each task name with the device's name and a colour that comes from its instance id
// (none with one device); the order from the API applied, new tasks first; a drag that starts on a row's grip, with the mouse (and Escape) and with a finger
// (no long press), saves the right whole order, while a drag, a long press or a swipe on the rest of the row does not (a tap still opens it, a swipe still
// scrolls); during a drag the row's place is an empty slot, a lifted copy floats under the pointer and the other rows slide (transforms); the keyboard
// moves a task from its grip with an announcement, Escape puts it back; reduced motion moves everything at once; menu moves and a newer order slide the rows;
// the menu moves; keys of devices not shown are kept in place; a failed save moves back; a newer order is applied on refresh, after a drag;
// groups and the "Move to" of a group stay; an Engine without an instance id is placed last and cannot be moved until its id is known; an older server (404)
// keeps today's order and offers no sorting. H5_SHOT_DIR=<dir> saves the list at 390px and wide, and both during a drag.
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
  const grip = title => row(title).locator('.h5-task-grip');
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
  // A mouse drag that starts on the grip of the row `from` (or, `onRow`, on its main button) and goes to the upper part of `to` (before it), or to its
  // lower part (after it).
  const mouseDrag = async (from, to, { after = false, release = true, onRow = false } = {}) => {
    const a = onRow ? await box(from) : await grip(from).boundingBox();
    const b = await box(to);
    const x = onRow ? a.x + 60 : a.x + a.width / 2;
    await page.mouse.move(x, a.y + a.height / 2);
    await page.mouse.down();
    const y = b.y + (after ? b.height * 0.8 : b.height * 0.2);
    await page.mouse.move(x + 1, a.y + a.height / 2 + 2, { steps: 2 }); // under the threshold
    await page.mouse.move(x, y, { steps: 8 });
    if (release) await page.mouse.up();
  };
  // What the drag shows: the slot, the floating copy, the rows that slide.
  const dragView = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('#h5-task-list .h5-task')];
    const name = node => node.querySelector('.h5-task-title').textContent;
    const float = document.querySelector('.h5-task-float');
    const body = float && float.querySelector('.h5-task-float-body');
    const slot = document.querySelector('#h5-task-list .h5-task[data-drag-slot]');
    return {
      slot: slot ? name(slot) : null,
      slotHeight: slot ? slot.getBoundingClientRect().height : 0,
      slotChildOpacity: slot ? getComputedStyle(slot.firstElementChild).opacity : null,
      slotOutline: slot ? getComputedStyle(slot, '::before').borderTopStyle : null,
      float: float ? { title: float.querySelector('.h5-task-title').textContent, lifted: body.classList.contains('h5-task-float-lifted'), shadow: getComputedStyle(body).boxShadow, hidden: float.getAttribute('aria-hidden'), gripColor: getComputedStyle(float.querySelector('.h5-task-grip')).color, top: float.getBoundingClientRect().top } : null,
      moved: rows.filter(node => node !== slot && /translate/.test(node.style.transform)).map(name),
      transitions: rows.map(node => node.style.transition),
      animations: document.getAnimations().filter(animation => animation.playState === 'running').length,
      cursor: getComputedStyle(document.body).cursor,
    };
  });
  const dragDone = () => page.waitForFunction(() => !document.querySelector('.h5-task-float') && !document.querySelector('.h5-task[data-drag-slot]'));
  return { press, settle, sheet, closeSheet, titles, waitTitles, row, box, grip, lastPut, puts, menu, item, notice, mouseDrag, dragView, dragDone };
}

// A finger on the touch screen, through the DevTools protocol (real touch events and the pointer events made from them: what a phone sends).
async function finger(page) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  return {
    touch,
    // `hold` ms still before moving (0: a drag at once; 500: what a long press was); `release` false keeps the finger down at `to`.
    async drag(from, to, { hold = 0, steps = 10, release = true } = {}) {
      await touch('touchStart', from.x, from.y);
      if (hold) await page.waitForTimeout(hold);
      for (let index = 1; index <= steps; index += 1) {
        await touch('touchMove', from.x + ((to.x - from.x) * index) / steps, from.y + ((to.y - from.y) * index) / steps);
        await page.waitForTimeout(16);
      }
      if (release) await touch('touchEnd');
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
const middle = rect => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

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
  // The grip: named, before the chevron, faint until the row is hovered.
  const grip = t.grip('Gamma');
  assert.equal(await grip.getAttribute('aria-label'), 'Drag to reorder', `${label}: the grip is named`);
  assert.equal(await grip.getAttribute('title'), 'Drag to reorder');
  assert.equal(await grip.getAttribute('aria-roledescription'), 'sortable');
  assert.ok(await t.row('Gamma').locator('.h5-task-head > .h5-task-grip + .h5-task-item').count(), `${label}: the grip comes before the row button`);
  assert.equal(await grip.evaluate(node => getComputedStyle(node).touchAction), 'none', `${label}: only the grip stops touch scrolling`);
  assert.equal(await t.row('Gamma').locator('.h5-task-item').evaluate(node => getComputedStyle(node).touchAction), 'auto', `${label}: the row button scrolls`);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(200);
  const faint = Number(await grip.evaluate(node => getComputedStyle(node).opacity));
  await t.row('Echo').locator('.h5-task-title').hover();
  await page.waitForTimeout(200);
  assert.ok(faint < 0.6 && Number(await t.grip('Echo').evaluate(node => getComputedStyle(node).opacity)) === 1, `${label}: faint (${faint}), full on hover`);
  // A drag on the row itself (not the grip) moves nothing and shows no drag.
  await t.mouseDrag('Gamma', 'Echo', { onRow: true, release: false });
  assert.equal((await t.dragView()).float, null, `${label}: no drag from the row`);
  await page.mouse.up();
  await page.waitForTimeout(150);
  await t.waitTitles(FIRST);
  assert.equal(t.puts(world), 0, `${label}: a drag on the row saves nothing`);
  // A click on the grip does nothing.
  await grip.click();
  await page.waitForTimeout(150);
  assert.equal(await t.row('Gamma').locator('.h5-task-item').getAttribute('aria-expanded'), 'false', `${label}: a click on the grip does not open the row`);
  assert.equal((await t.dragView()).float, null);
  // Gamma (last) before Echo: the slot, the lifted copy, the rows that slid.
  await t.mouseDrag('Gamma', 'Echo', { release: false });
  await page.waitForTimeout(250);
  const view = await t.dragView();
  assert.equal(view.slot, 'Gamma', `${label}: the dragged row's place is the slot`);
  assert.equal(view.slotChildOpacity, '0', `${label}: the slot is empty`);
  assert.equal(view.slotOutline, 'dashed', `${label}: the slot is dashed`);
  const rowHeight = (await t.row('Alpha').boundingBox()).height;
  assert.ok(Math.abs(view.slotHeight - rowHeight) < 1.5, `${label}: the slot is as tall as a row (${view.slotHeight} / ${rowHeight})`);
  assert.equal(view.float && view.float.title, 'Gamma', `${label}: a copy of the row floats`);
  assert.ok(view.float.lifted && view.float.shadow !== 'none', `${label}: lifted, with a shadow`);
  assert.equal(view.float.hidden, 'true', `${label}: the copy is hidden from assistive technology`);
  assert.equal(view.float.gripColor, 'rgb(144, 202, 249)', `${label}: the grip of the copy is in the primary colour`);
  assert.deepEqual(view.moved, ['Echo', 'Alpha', 'Delta'], `${label}: the rows between slid down`);
  assert.ok(view.transitions.some(value => /transform 180ms/.test(value)), `${label}: they slide (${view.transitions})`);
  assert.equal(view.cursor, 'grabbing', `${label}: the grabbing hand`);
  const slotBox = await t.row('Gamma').boundingBox();
  const echoBox = await t.row('Echo').boundingBox();
  assert.ok(slotBox.y < echoBox.y, `${label}: the slot is above Echo now`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'task-order-drag-wide.png') });
  await page.mouse.up();
  await t.waitTitles(['Beta', 'Gamma', 'Echo', 'Alpha', 'Delta']);
  await t.dragDone();
  assert.deepEqual(t.lastPut(world)[2], { order: [L(2), L(3), V(2), HIDDEN_KEY, L(1), V(1)] }, `${label}: the whole order, the hidden key kept in its place`);
  assert.equal(t.puts(world), 1, `${label}: one save`);
  assert.deepEqual((await t.dragView()).moved, [], `${label}: no row is left moved`);
  assert.equal(await t.row('Gamma').locator('.h5-task-item').getAttribute('aria-expanded'), 'false', `${label}: the drop did not open the row`);
  // After the last row.
  await t.mouseDrag('Beta', 'Delta', { after: true });
  await t.waitTitles(['Gamma', 'Echo', 'Alpha', 'Delta', 'Beta']);
  await t.dragDone();
  assert.deepEqual(t.lastPut(world)[2], { order: [L(3), V(2), L(1), HIDDEN_KEY, V(1), L(2)] }, `${label}: to the end`);
  // Escape cancels: nothing moves, nothing is saved, the row does not open, the sheet stays.
  const before = t.puts(world);
  await t.mouseDrag('Alpha', 'Gamma', { release: false });
  await page.locator('.h5-task-float').waitFor();
  await page.keyboard.press('Escape');
  await t.dragDone();
  await page.mouse.up();
  await page.waitForTimeout(150);
  assert.equal(t.puts(world), before, `${label}: Escape saves nothing`);
  await t.waitTitles(['Gamma', 'Echo', 'Alpha', 'Delta', 'Beta']);
  assert.deepEqual((await t.dragView()).moved, [], `${label}: the rows went back`);
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
  await t.dragDone();
  // Auto-scroll near the bottom edge of a short list.
  await page.setViewportSize({ width: 1280, height: 330 });
  await t.settle();
  const list = page.locator('#h5-task-list');
  const scrollable = await list.evaluate(node => node.scrollHeight > node.clientHeight);
  if (scrollable) {
    const a = await t.grip((await t.titles())[0]).boundingBox(); // the first row, in view at the top
    const edge = await list.boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2, a.y + 20, { steps: 3 });
    await page.mouse.move(a.x + a.width / 2, edge.y + edge.height - 6, { steps: 4 });
    await page.waitForFunction(() => document.getElementById('h5-task-list').scrollTop > 0);
    await page.keyboard.press('Escape');
    await page.mouse.up();
  }
  assert.ok(scrollable, `${label}: the short list scrolls (auto-scroll checked)`);
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

// The keyboard: Space or Enter on a grip picks the task up, Up and Down move it, Space or Enter drops it, Escape puts it back; a live region says where.
async function testKeyboard(browser, wide) {
  const label = wide ? 'wide keyboard' : 'phone keyboard';
  const world = makeWorld();
  const { context, page } = await open(browser, world, wide);
  const t = tools(page, wide);
  await t.sheet();
  await t.waitTitles(FIRST);
  const said = () => page.locator('#h5-task-order-live').textContent();
  await t.grip('Echo').focus();
  await page.keyboard.press('Space');
  assert.match(await said(), /^Picked up at position 2 of 5\./, `${label}: picked up`);
  assert.equal((await t.dragView()).slot, 'Echo', `${label}: its place is the slot`);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  assert.equal(await said(), 'Moved to position 4 of 5', `${label}: moved down twice`);
  assert.deepEqual((await t.dragView()).moved, ['Alpha', 'Delta'], `${label}: the rows it passed slid up`);
  await page.waitForTimeout(250);
  const float = (await t.dragView()).float;
  const slot = await t.row('Echo').boundingBox();
  assert.ok(Math.abs(float.top - slot.y) < 3, `${label}: the copy sits on the slot (${float.top} / ${slot.y})`);
  assert.equal(t.puts(world), 0, `${label}: nothing saved before the drop`);
  await page.keyboard.press('Enter');
  assert.equal(await said(), 'Dropped at position 4 of 5', `${label}: dropped`);
  await t.waitTitles(['Beta', 'Alpha', 'Delta', 'Echo', 'Gamma']);
  await t.dragDone();
  assert.deepEqual(t.lastPut(world)[2], { order: [L(2), L(1), V(1), HIDDEN_KEY, V(2), L(3)] }, `${label}: the same save as a drop`);
  assert.equal(await page.evaluate(() => document.activeElement.closest('.h5-task')?.querySelector('.h5-task-title').textContent), 'Echo', `${label}: the focus stays on its grip`);
  // Escape puts it back, and the sheet stays open.
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  assert.equal(await said(), 'Moved to position 1 of 5');
  await page.keyboard.press('ArrowUp');
  assert.equal(await said(), 'Moved to position 1 of 5', `${label}: it stops at the top`);
  await page.keyboard.press('Escape');
  assert.equal(await said(), 'Reorder cancelled', `${label}: cancelled`);
  await t.dragDone();
  await t.waitTitles(['Beta', 'Alpha', 'Delta', 'Echo', 'Gamma']);
  assert.equal(t.puts(world), 1, `${label}: Escape saves nothing`);
  assert.deepEqual((await t.dragView()).moved, [], `${label}: the rows went back`);
  assert.equal(await page.locator('#h5-tasks').isVisible(), true, `${label}: the sheet stays open`);
  // Leaving the grip (Tab) puts it back too.
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  await t.dragDone();
  assert.equal(await said(), 'Reorder cancelled', `${label}: leaving the grip cancels`);
  assert.equal(t.puts(world), 1, `${label}: still one save`);
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

// Order changes that are not drags slide the rows to their new places; reduced motion moves everything at once.
async function testMotion(browser) {
  const label = 'motion';
  const world = makeWorld();
  const { context, page } = await open(browser, world, true);
  const t = tools(page, true);
  await t.sheet();
  await t.waitTitles(FIRST);
  const sliding = () => page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running' && animation.effect.target && animation.effect.target.classList.contains('h5-task')).length);
  // A menu move: the rows slide.
  await t.menu('Beta');
  await t.press(t.item('Move to bottom'));
  await t.waitTitles(['Echo', 'Alpha', 'Delta', 'Gamma', 'Beta']);
  assert.ok(await sliding() > 0, `${label}: a menu move slides the rows`);
  await t.settle();
  assert.deepEqual((await t.dragView()).moved, [], `${label}: and they end in place`);
  // A newer order from the server: the rows slide.
  world.order = { order: [L(3), L(2), V(1), V(2), L(1)], updated_at: 99 };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await t.waitTitles(['Gamma', 'Beta', 'Delta', 'Echo', 'Alpha']);
  assert.ok(await sliding() > 0, `${label}: a newer order slides the rows`);
  await t.settle();
  // A search narrows the list without sliding anything.
  await page.locator('#h5-task-search-input').fill('e');
  await t.waitTitles(['Beta', 'Delta', 'Echo']);
  assert.equal(await sliding(), 0, `${label}: a search slides nothing`);
  await page.locator('#h5-task-search-input').fill('');
  await t.waitTitles(['Gamma', 'Beta', 'Delta', 'Echo', 'Alpha']);
  // Reduced motion: no transition during a drag, at the drop, or after a menu move.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await t.mouseDrag('Alpha', 'Beta', { release: false });
  const view = await t.dragView();
  assert.equal(view.slot, 'Alpha', `${label}: reduced motion still drags`);
  assert.deepEqual(view.moved, ['Beta', 'Delta', 'Echo'], `${label}: the rows moved`);
  assert.ok(view.transitions.every(value => value === '' || value === 'none'), `${label}: without a transition (${view.transitions})`);
  assert.equal(view.animations, 0, `${label}: nothing animates`);
  assert.equal(await page.locator('.h5-task-float-body').evaluate(node => getComputedStyle(node).transitionDuration), '0s', `${label}: the copy does not animate`);
  await page.mouse.up();
  await t.waitTitles(['Gamma', 'Alpha', 'Beta', 'Delta', 'Echo']);
  await t.dragDone();
  assert.equal(await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').length), 0, `${label}: the drop does not animate`);
  await t.menu('Gamma');
  await t.press(t.item('Move down'));
  await t.waitTitles(['Alpha', 'Gamma', 'Beta', 'Delta', 'Echo']);
  assert.equal(await sliding(), 0, `${label}: a menu move does not slide`);
  assert.deepEqual(world.order.order.filter(key => key !== HIDDEN_KEY), [L(1), L(3), L(2), V(1), V(2)], `${label}: the saved order`);
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
  // The grip is shown in full, and its target is 44px tall; the row is not taller than the "⋯" beside it.
  const gripBox = await t.grip('Gamma').boundingBox();
  assert.ok(gripBox.height >= 44, `${label}: the grip is 44px tall (${gripBox.height})`);
  assert.equal(Number(await t.grip('Gamma').evaluate(node => getComputedStyle(node).opacity)), 1, `${label}: always shown on a touch screen`);
  assert.ok((await t.row('Gamma').locator('.h5-task-head').boundingBox()).height <= 45, `${label}: the row stays 44px`);
  // A finger on Gamma's grip goes straight to the top half of Echo: no long press needed. Midway: the slot and the floating copy.
  const echo = await t.box('Echo');
  await f.drag(middle(gripBox), { x: gripBox.x + gripBox.width / 2, y: echo.y + echo.height * 0.25 }, { release: false });
  await page.waitForTimeout(250);
  const view = await t.dragView();
  assert.equal(view.slot, 'Gamma', `${label}: the slot`);
  assert.equal(view.float && view.float.title, 'Gamma', `${label}: the floating copy`);
  assert.deepEqual(view.moved, ['Echo', 'Alpha', 'Delta'], `${label}: the rows slid`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'task-order-drag-390.png') });
  await f.touch('touchEnd');
  await t.waitTitles(['Beta', 'Gamma', 'Echo', 'Alpha', 'Delta']);
  await t.dragDone();
  assert.deepEqual(t.lastPut(world)[2], { order: [L(2), L(3), V(2), HIDDEN_KEY, L(1), V(1)] }, `${label}: the drag saved the whole order`);
  await page.waitForTimeout(300);
  assert.equal(await t.row('Gamma').locator('.h5-task-item').getAttribute('aria-expanded'), 'false', `${label}: the drop did not open the row`);
  // A tap on the grip does nothing.
  const saved = t.puts(world);
  await f.tap(middle(await t.grip('Alpha').boundingBox()));
  await page.waitForTimeout(250);
  assert.equal(await t.row('Alpha').locator('.h5-task-item').getAttribute('aria-expanded'), 'false', `${label}: a tap on the grip opens nothing`);
  assert.equal((await t.dragView()).float, null, `${label}: and drags nothing`);
  // A quick tap on the row opens it; nothing is saved.
  await f.tap(centre(await t.box('Alpha')));
  await page.waitForFunction(() => [...document.querySelectorAll('.h5-task')].some(node => node.querySelector('.h5-task-title').textContent === 'Alpha' && node.querySelector('.h5-task-item').getAttribute('aria-expanded') === 'true'));
  await f.tap(centre(await t.box('Alpha')));
  await page.waitForTimeout(200);
  // A long press on the row, then a move, is not a drag any more (it was before the grip).
  const alpha = await t.box('Alpha');
  await f.drag(centre(await t.box('Gamma')), { x: alpha.x + 60, y: alpha.y + alpha.height * 0.25 }, { hold: 500, release: false });
  assert.equal((await t.dragView()).float, null, `${label}: a long press on the row is not a drag`);
  await f.touch('touchEnd');
  await page.waitForTimeout(300);
  await t.waitTitles(['Beta', 'Gamma', 'Echo', 'Alpha', 'Delta']);
  // "⋯" and "+" still work with a tap (they are not part of the drag).
  await t.press(t.row('Echo').locator('.h5-task-more'));
  await page.locator('#h5-term-menu-actions').first().waitFor();
  await page.locator('#h5-term-menu-cancel').tap();
  await page.locator('#h5-term-menu-actions').first().waitFor({ state: 'detached' });
  assert.equal(t.puts(world), saved, `${label}: taps, long presses and swipes save nothing`);
  // A finger that moves on a row scrolls the list, as before sorting existed.
  await page.setViewportSize({ width: 390, height: 420 });
  await t.settle();
  const list = page.locator('#h5-task-list');
  assert.ok(await list.evaluate(node => node.scrollHeight > node.clientHeight + 40), `${label}: the short list can scroll`);
  assert.ok(await list.evaluate((node, y) => y + 22 < node.getBoundingClientRect().bottom, (await t.box((await t.titles())[1])).y), `${label}: the second row is in view`);
  const top = await t.box((await t.titles())[1]); // a row in view, below the first
  await f.drag(centre(top), { x: top.x + 60, y: top.y - 80 }, { steps: 8 });
  await page.waitForTimeout(400);
  assert.ok(await list.evaluate(node => node.scrollTop > 20), `${label}: a swipe on a row scrolls the list`);
  assert.equal((await t.dragView()).float, null, `${label}: a swipe is not a drag`);
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
  assert.equal(await t.grip('Foxtrot').count(), 0, `${label}: it has no grip`);
  assert.equal(await t.row('Foxtrot').locator('.h5-task-grip-space').count(), 1, `${label}: but the same space, so the chevrons line up`);
  await t.mouseDrag('Foxtrot', 'Beta', { onRow: true });
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
  assert.equal(await page.locator('.h5-task-grip, .h5-task-grip-space').count(), 0, `${label}: no grips and no space for them`);
  assert.equal(await page.locator('.h5-device-tag').count(), 5, `${label}: the tags are there`);
  assert.equal(await page.locator('.h5-source-header').count(), 0, `${label}: no headers`);
  await t.menu('Beta');
  assert.equal(await t.item('Move up').count(), 0, `${label}: no move items`);
  await t.press(page.locator('#h5-term-menu-cancel'));
  if (wide) { await t.mouseDrag('Echo', 'Alpha', { onRow: true }); await page.waitForTimeout(150); }
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
    console.log('  touch drag: ok');
    await testKeyboard(browser, true);
    await testKeyboard(browser, false);
    console.log('  keyboard: ok');
    await testMotion(browser);
    console.log('  motion: ok');
    await testUnknownId(browser);
    console.log('  unknown instance id: ok');
    console.log('h5 task order: ok');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
