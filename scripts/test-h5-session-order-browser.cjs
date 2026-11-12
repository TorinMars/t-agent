// The sessions of a task in the order the person puts them (public/js/h5.js "Session order", TaskDrawer.jsx `SESSION_DRAG`), in real Chromium at phone size
// (390x844, touch through the DevTools protocol) and on a computer (1280x800, mouse), with the routes mocked: a finger held still on a session row picks it up
// and a drag then saves the task's whole order (`PUT {tasksBase}/:id/terminals/order`), on this machine and on a remote Engine with 'terminals:order'; a short
// tap opens the session and drags nothing; a quick swipe scrolls the list; a hold released without a move opens nothing; a mouse picks a row up after a move
// of 4px or a hold, and a click still opens it; a row stays among its own task's rows; a remote Engine without the capability offers no sorting, and one
// that answers TERMINAL_ORDER_UNSUPPORTED stops offering it; a failed save moves the rows back with a notice; Move up / Move down in the "⋯"; a list read
// during a drag waits for the drop; reduced motion moves everything at once. H5_SHOT_DIR=<dir> saves a phone screenshot during a drag and after the drop.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const term = (id, title, agent = null) => ({ terminal_id: id, title, ...(agent ? { agent } : {}) });

function makeWorld({ capabilities = ['terminal:control', 'terminals:order'], fillers = 0 } = {}) {
  const local = [{ id: 1, title: 'Alpha', status: 'doing' }, { id: 2, title: 'Beta', status: 'doing' }];
  for (let index = 0; index < fillers; index += 1) local.push({ id: 10 + index, title: `Filler ${index + 1}`, status: 'doing' });
  return {
    capabilities, writes: [], pageErrors: [], fail: null, holdPut: null,
    local, vps: [{ id: 1, title: 'Delta', status: 'doing' }],
    terms: {
      'local:1': [term('a1', 'One'), term('a2', 'Two', 'claude'), term('a3', 'Three')],
      'local:2': [term('b1', 'Bee one'), term('b2', 'Bee two')],
      'vps:1': [term('d1', 'Dee one'), term('d2', 'Dee two'), term('d3', 'Dee three')],
    },
  };
}
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function serve(world, route) {
  const url = new URL(route.request().url());
  const { pathname } = url;
  const method = route.request().method();
  if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
  if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
  if (pathname === '/api/system/version') return json(route, { app_version: '2.105.0', boot_id: 'b1', engine_name: 'MacBook' });
  if (pathname === '/api/remote-servers') return json(route, [{ id: 7, name: 'VPS', status: 'online', enabled: true }]);
  if (pathname === '/api/task-order') return json(route, { error: 'not found' }, 404);
  if (pathname === '/api/task-list/hidden-devices') return json(route, { hidden: [] });
  if (pathname === '/api/service-links') return json(route, { supported: true, links: [] });
  const remote = pathname.match(/^\/api\/remote-servers\/7(\/.*)?$/);
  const prefix = remote ? 'vps' : 'local';
  const tail = remote ? remote[1] || '' : pathname.replace(/^\/api/, '');
  if (tail === '/task-groups') return json(route, [{ key: 'doing', name: 'Doing', sort_order: 1 }]);
  if (tail === '/info') return json(route, { capabilities: world.capabilities });
  if (/\/terminal-activity$|\/terminal-subagents$/.test(tail)) return json(route, {});
  if (tail === '/tasks' && method === 'GET') return json(route, url.searchParams.get('archived') === '1' ? [] : remote ? world.vps : world.local);
  const hit = tail.match(/^\/tasks\/(\d+)(?:\/(.+))?$/);
  const key = hit && `${prefix}:${hit[1]}`;
  if (hit && hit[2] === 'terminals' && method === 'GET') return json(route, world.terms[key] || []);
  if (hit && hit[2] === 'terminals/order' && method === 'PUT') {
    const body = route.request().postDataJSON();
    world.writes.push([method, pathname, body]);
    if (world.holdPut) await world.holdPut;
    if (world.fail) return json(route, { error: world.fail.code }, world.fail.status);
    const rows = world.terms[key];
    world.terms[key] = [...body.order.map(id => rows.find(row => row.terminal_id === id)).filter(Boolean), ...rows.filter(row => !body.order.includes(row.terminal_id))];
    return json(route, { order: world.terms[key].map(row => row.terminal_id) });
  }
  if (hit && /^terminal\/(ack|control)$/.test(hit[2] || '')) return json(route, {});
  return json(route, { error: 'not mocked' }, 404);
}

async function open(browser, world, { wide = false, reduced = false } = {}) {
  const context = await browser.newContext({
    ...(wide ? { viewport: { width: 1280, height: 800 } } : { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }),
    ...(reduced ? { reducedMotion: 'reduce' } : {}),
  });
  const page = await context.newPage();
  page.on('pageerror', error => world.pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.sockets = [];
    window.vibrations = [];
    navigator.vibrate = pattern => { window.vibrations.push(pattern); return true; };
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
  // No animation running (a slide, the sheet, a fade), and the drag's copy and slot gone.
  const settle = () => page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity)
    && ![...document.querySelectorAll('.h5-terminal-row')].some(node => node.style.transform));
  const dragDone = () => page.waitForFunction(() => !document.querySelector('.h5-session-float') && !document.querySelector('.h5-terminal-row[data-drag-slot]'));
  const sheet = async () => {
    if (!wide && !await page.locator('#h5-tasks').isVisible()) await page.locator('#h5-open-tasks').tap();
    await page.locator('#h5-tasks .h5-task-item').first().waitFor();
    await settle();
  };
  const task = title => page.locator('#h5-task-list .h5-task').filter({ has: page.locator('.h5-task-title', { hasText: new RegExp(`^${title}$`, 'i') }) });
  const list = title => task(title).locator('.h5-terminal-list');
  const names = title => list(title).locator('.h5-terminal-name').allTextContents();
  const waitNames = (title, wanted) => page.waitForFunction(([name, want]) => {
    const node = [...document.querySelectorAll('#h5-task-list .h5-task')].find(item => item.querySelector('.h5-task-title').textContent.toLowerCase() === name.toLowerCase());
    return node && JSON.stringify([...node.querySelectorAll('.h5-terminal-list .h5-terminal-name')].map(item => item.textContent)) === JSON.stringify(want);
  }, [title, wanted]);
  const row = (title, name) => list(title).locator('.h5-terminal-row').filter({ has: page.locator('.h5-terminal-name', { hasText: new RegExp(`^${name}$`) }) });
  const expand = async title => {
    if (await task(title).locator('.h5-task-item').getAttribute('aria-expanded') !== 'true') await press(task(title).locator('.h5-task-item'));
    await list(title).locator('.h5-terminal-name').first().waitFor();
    await settle();
  };
  // The terminal shown, and (on a phone) the sheet closed.
  const shown = async (taskId, id) => {
    await page.waitForFunction(([taskKey, terminal]) => { const el = document.querySelector('.h5-xterm:not([hidden])'); return el && el.dataset.taskId === String(taskKey) && el.dataset.terminalId === terminal; }, [taskId, id]);
    if (!wide) await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
  };
  const shownTerminal = () => page.evaluate(() => { const el = document.querySelector('.h5-xterm:not([hidden])'); return el ? el.dataset.terminalId : null; });
  const puts = world => world.writes.filter(([method, p]) => method === 'PUT' && /\/terminals\/order$/.test(p));
  const view = () => page.evaluate(() => {
    const float = document.querySelector('.h5-session-float');
    const slot = document.querySelector('.h5-terminal-row[data-drag-slot]');
    const body = float && float.querySelector('.h5-task-float-body');
    return {
      float: float ? { name: float.querySelector('.h5-terminal-name').textContent, lifted: body.classList.contains('h5-task-float-lifted'), shadow: getComputedStyle(body).boxShadow, transform: getComputedStyle(body).transform, top: float.getBoundingClientRect().top, hidden: float.getAttribute('aria-hidden') } : null,
      slot: slot ? { name: slot.querySelector('.h5-terminal-name').textContent, outline: getComputedStyle(slot, '::before').borderTopStyle, opacity: getComputedStyle(slot.firstElementChild).opacity } : null,
      moved: [...document.querySelectorAll('.h5-terminal-row')].filter(node => node !== slot && /translate/.test(node.style.transform)).map(node => node.querySelector('.h5-terminal-name').textContent),
      transitions: [...document.querySelectorAll('.h5-terminal-row')].map(node => node.style.transition),
    };
  });
  const notice = wanted => page.waitForFunction(text => ((window.H5UI.get().notice || {}).message || '').startsWith(text), wanted);
  const said = () => page.locator('#h5-task-order-live').textContent();
  const menu = async (title, name) => {
    await press(row(title, name).locator('.h5-terminal-more'));
    await page.locator('#h5-session-menu [role="menuitem"]').first().waitFor();
  };
  const items = () => page.locator('#h5-session-menu [role="menuitem"]').allTextContents();
  const item = label => page.locator('#h5-session-menu [role="menuitem"]', { hasText: new RegExp(`^${label}$`) });
  return { press, settle, dragDone, sheet, task, list, names, waitNames, row, expand, shown, shownTerminal, puts, view, notice, said, menu, items, item };
}

// A finger on the touch screen, through the DevTools protocol (real touch events and the pointer events made from them: what a phone sends).
async function finger(page) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const moveTo = async (from, to, steps) => {
    for (let index = 1; index <= steps; index += 1) {
      await touch('touchMove', from.x + ((to.x - from.x) * index) / steps, from.y + ((to.y - from.y) * index) / steps);
      await page.waitForTimeout(16);
    }
  };
  return {
    touch,
    // Waits until the row is picked up (the copy floats), then moves; `release` false keeps the finger down at `to`.
    async holdDrag(from, to, { steps = 12, release = true } = {}) {
      await touch('touchStart', from.x, from.y);
      await page.waitForSelector('.h5-session-float');
      await moveTo(from, to, steps);
      if (release) await touch('touchEnd');
    },
    async hold(at, ms) { await touch('touchStart', at.x, at.y); await page.waitForTimeout(ms); await touch('touchEnd'); },
    async swipe(from, to, steps = 6) { await touch('touchStart', from.x, from.y); await moveTo(from, to, steps); await touch('touchEnd'); },
    async tap(at) { await touch('touchStart', at.x, at.y); await page.waitForTimeout(60); await touch('touchEnd'); },
  };
}
const centre = rect => ({ x: rect.x + 80, y: rect.y + rect.height / 2 });
const below = (rect, part = 0.8) => ({ x: rect.x + 80, y: rect.y + rect.height * part });

// The selected task Alpha (on its first terminal), the sheet open.
async function start(page, t, wide) {
  await t.sheet();
  await t.press(t.task('Alpha').locator('.h5-task-item'));
  await t.list('Alpha').locator('.h5-terminal-name').first().waitFor();
  await t.press(t.row('Alpha', 'One').locator('.h5-terminal-main'));
  await t.shown(1, 'a1');
  await t.sheet();
  await t.waitNames('Alpha', ['One', 'Two', 'Three']);
}

// A finger: hold, drag, save; a tap opens; a swipe scrolls; a hold without a move opens nothing; a row stays in its task.
async function testTouch(browser) {
  const label = 'phone';
  const world = makeWorld({ fillers: 12 });
  const { context, page } = await open(browser, world);
  const t = tools(page, false);
  const f = await finger(page);
  await start(page, t, false);
  // The rows: no text selection, and they still scroll (no touch-action on the row). (Chromium has no -webkit-touch-callout to read back.)
  const look = await t.row('Alpha', 'Two').evaluate(node => ({ select: getComputedStyle(node).userSelect, action: getComputedStyle(node).touchAction, movable: node.dataset.movable }));
  assert.equal(look.select, 'none', `${label}: no text selection on a session row`);
  assert.equal(look.action, 'auto', `${label}: the row still scrolls the list`);
  assert.equal(look.movable, 'true', `${label}: the row can be moved`);
  // Hold One, drag it below Three.
  const one = await t.row('Alpha', 'One').boundingBox();
  const three = await t.row('Alpha', 'Three').boundingBox();
  // Halfway (the copy between Two and Three, the slot under it), then on below Three.
  const half = { x: one.x + 80, y: three.y + three.height * 0.25 };
  await f.holdDrag(centre(one), half, { release: false });
  await page.waitForFunction(() => document.querySelectorAll('.h5-terminal-row[style*="translate"]').length > 0);
  await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity)); // the slide done
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'session-order-drag-390.png') }); }
  const end = below(three, 0.9);
  for (let index = 1; index <= 6; index += 1) { await f.touch('touchMove', end.x, half.y + ((end.y - half.y) * index) / 6); await page.waitForTimeout(16); }
  await page.waitForTimeout(250);
  const mid = await t.view();
  assert.equal(mid.float && mid.float.name, 'One', `${label}: a copy of the row floats`);
  assert.ok(mid.float.lifted && mid.float.shadow !== 'none', `${label}: lifted with a shadow`);
  assert.match(mid.float.transform, /matrix\(1\.02/, `${label}: 2% larger`);
  assert.equal(mid.float.hidden, 'true', `${label}: the copy is hidden from assistive technology`);
  assert.equal(mid.slot && mid.slot.name, 'One', `${label}: its place is the slot`);
  assert.equal(mid.slot.outline, 'dashed', `${label}: a dashed slot`);
  assert.equal(mid.slot.opacity, '0', `${label}: the slot is empty`);
  assert.deepEqual(mid.moved, ['Two', 'Three'], `${label}: the rows below slid up`);
  assert.ok(mid.transitions.some(value => /transform 180ms/.test(value)), `${label}: they slide`);
  assert.deepEqual(await page.evaluate(() => window.vibrations), [10], `${label}: a short vibration when the row is picked up`);
  await f.touch('touchEnd');
  await t.waitNames('Alpha', ['Two', 'Three', 'One']);
  await t.dragDone();
  await t.settle();
  assert.deepEqual(t.puts(world).map(([, p, body]) => [p, body]), [['/api/tasks/1/terminals/order', { order: ['a2', 'a3', 'a1'] }]], `${label}: one save of the whole order`);
  assert.equal(await t.said(), 'Moved to position 3 of 3', `${label}: the move is announced`);
  assert.equal(await page.locator('#h5-tasks').isVisible(), true, `${label}: the drop opened nothing (the sheet stays)`);
  assert.equal(await t.shownTerminal(), 'a1', `${label}: the terminal shown did not change`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'session-order-drop-390.png') });
  // The page reloaded reads the saved order.
  await page.reload();
  await t.sheet();
  await t.waitNames('Alpha', ['Two', 'Three', 'One']);
  // A short tap opens the session and drags nothing.
  await f.tap(centre(await t.row('Alpha', 'Three').boundingBox()));
  await t.shown(1, 'a3');
  assert.equal(t.puts(world).length, 1, `${label}: a tap saves nothing`);
  // A quick swipe from a session row scrolls the list and picks nothing up.
  await t.sheet();
  const listBox = await page.locator('#h5-task-list').boundingBox();
  const scrollable = await page.locator('#h5-task-list').evaluate(node => node.scrollHeight > node.clientHeight + 100);
  assert.ok(scrollable, `${label}: the list scrolls`);
  await page.locator('#h5-task-list').evaluate(node => { node.scrollTop = 0; });
  const two = await t.row('Alpha', 'Two').boundingBox();
  await f.swipe(centre(two), { x: two.x + 80, y: listBox.y + 10 }, 5);
  await page.waitForFunction(() => document.getElementById('h5-task-list').scrollTop > 20);
  await page.waitForTimeout(HOLD_WAIT);
  assert.equal((await t.view()).float, null, `${label}: a swipe picks nothing up`);
  assert.equal(t.puts(world).length, 1, `${label}: a swipe saves nothing`);
  assert.equal(await page.locator('#h5-tasks').isVisible(), true, `${label}: and opens nothing`);
  await page.locator('#h5-task-list').evaluate(node => { node.scrollTop = 0; });
  await t.settle();
  // A hold released without a move: the row was picked up and goes back; nothing opens, nothing is saved, no context menu.
  const menus = await page.evaluate(() => { window.menus = 0; window.addEventListener('contextmenu', event => { if (!event.defaultPrevented) window.menus += 1; }); return 0; });
  await f.hold(centre(await t.row('Alpha', 'Two').boundingBox()), 700);
  await t.dragDone();
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#h5-tasks').isVisible(), true, `${label}: a hold opens nothing`);
  assert.equal(await t.shownTerminal(), 'a3', `${label}: the terminal shown did not change`);
  assert.equal(t.puts(world).length, 1, `${label}: a hold saves nothing`);
  assert.equal(await page.evaluate(() => window.menus), menus, `${label}: no context menu`);
  // A row stays among its own task's rows: Three dragged far below Beta's rows goes to the end of Alpha only.
  await t.expand('Beta');
  const threeBox = await t.row('Alpha', 'Three').boundingBox();
  const bee = await t.row('Beta', 'Bee two').boundingBox();
  const lastAlpha = await t.row('Alpha', 'One').boundingBox(); // the bottom row of Alpha, before anything slides
  await f.holdDrag(centre(threeBox), below(bee, 0.9), { release: false });
  await page.waitForTimeout(200);
  const clamped = await t.view();
  assert.ok(Math.abs(clamped.float.top - lastAlpha.y) <= 2, `${label}: the copy stays inside its task (${clamped.float.top} / ${lastAlpha.y})`);
  assert.deepEqual(clamped.moved.filter(name => name.startsWith('Bee')), [], `${label}: the other task's rows do not move`);
  await f.touch('touchEnd');
  await t.waitNames('Alpha', ['Two', 'One', 'Three']);
  await t.dragDone();
  assert.deepEqual(t.puts(world).at(-1).slice(1), ['/api/tasks/1/terminals/order', { order: ['a2', 'a1', 'a3'] }], `${label}: only Alpha's order`);
  assert.deepEqual(await t.names('Beta'), ['Bee one', 'Bee two'], `${label}: Beta unchanged`);
  // A non-selected task's rows (Beta, a peek list) move too.
  const beeOne = await t.row('Beta', 'Bee one').boundingBox();
  await f.holdDrag(centre(beeOne), below(await t.row('Beta', 'Bee two').boundingBox(), 0.9));
  await t.waitNames('Beta', ['Bee two', 'Bee one']);
  await t.dragDone();
  assert.deepEqual(t.puts(world).at(-1).slice(1), ['/api/tasks/2/terminals/order', { order: ['b2', 'b1'] }], `${label}: the peek list saves its task's order`);
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}
const HOLD_WAIT = 500; // longer than the hold, to see that nothing was picked up

// A mouse: a move of 4px or a hold picks the row up; a click still opens; the click after a drag is swallowed; Escape puts it back.
async function testMouse(browser) {
  const label = 'wide';
  const world = makeWorld();
  const { context, page } = await open(browser, world, { wide: true });
  const t = tools(page, true);
  await start(page, t, true);
  // Press and move: Three above One.
  const one = await t.row('Alpha', 'One').boundingBox();
  const three = await t.row('Alpha', 'Three').boundingBox();
  await page.mouse.move(three.x + 80, three.y + three.height / 2);
  await page.mouse.down();
  await page.mouse.move(three.x + 81, three.y + three.height / 2 - 2, { steps: 2 }); // under the threshold
  assert.equal((await t.view()).float, null, `${label}: not picked up under 4px`);
  await page.mouse.move(three.x + 80, one.y + one.height * 0.2, { steps: 8 });
  const mid = await t.view();
  assert.equal(mid.float && mid.float.name, 'Three', `${label}: picked up by a move`);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).cursor), 'grabbing', `${label}: the grabbing hand`);
  await page.mouse.up();
  await t.waitNames('Alpha', ['Three', 'One', 'Two']);
  await t.dragDone();
  assert.deepEqual(t.puts(world).at(-1).slice(1), ['/api/tasks/1/terminals/order', { order: ['a3', 'a1', 'a2'] }], `${label}: saved`);
  assert.equal(await t.shownTerminal(), 'a1', `${label}: the click after the drag was swallowed`);
  // Press and hold, then move: Three after Two.
  const held = await t.row('Alpha', 'Three').boundingBox();
  await page.mouse.move(held.x + 80, held.y + held.height / 2);
  await page.mouse.down();
  await page.waitForSelector('.h5-session-float');
  assert.equal((await t.view()).float.name, 'Three', `${label}: picked up by a hold`);
  const two = await t.row('Alpha', 'Two').boundingBox();
  await page.mouse.move(held.x + 80, two.y + two.height * 0.9, { steps: 8 });
  await page.mouse.up();
  await t.waitNames('Alpha', ['One', 'Two', 'Three']);
  await t.dragDone();
  assert.deepEqual(t.puts(world).at(-1).slice(2), [{ order: ['a1', 'a2', 'a3'] }], `${label}: saved after a hold`);
  // Hold and release without a move: nothing opens (the click is swallowed), nothing is saved.
  const count = t.puts(world).length;
  const twoAgain = await t.row('Alpha', 'Two').boundingBox();
  await page.mouse.move(twoAgain.x + 80, twoAgain.y + twoAgain.height / 2);
  await page.mouse.down();
  await page.waitForSelector('.h5-session-float');
  await page.mouse.up();
  await t.dragDone();
  await page.waitForTimeout(100);
  assert.equal(await t.shownTerminal(), 'a1', `${label}: a hold opens nothing`);
  assert.equal(t.puts(world).length, count, `${label}: and saves nothing`);
  // Escape during a drag puts the row back.
  await page.mouse.move(twoAgain.x + 80, twoAgain.y + twoAgain.height / 2);
  await page.mouse.down();
  await page.mouse.move(twoAgain.x + 80, twoAgain.y + 50, { steps: 6 });
  await page.waitForSelector('.h5-session-float');
  await page.keyboard.press('Escape');
  await t.dragDone();
  await page.mouse.up();
  await t.settle();
  assert.deepEqual(await t.names('Alpha'), ['One', 'Two', 'Three'], `${label}: Escape puts it back`);
  assert.equal(t.puts(world).length, count, `${label}: Escape saves nothing`);
  assert.equal(await page.locator('#h5-tasks').isVisible(), true, `${label}: the sidebar stays`);
  // A plain click opens the session.
  await t.row('Alpha', 'Two').locator('.h5-terminal-main').click();
  await t.shown(1, 'a2');
  assert.equal(t.puts(world).length, count, `${label}: a click saves nothing`);
  // The "⋯" is not a grip: a press on it opens the menu.
  await t.menu('Alpha', 'Two');
  assert.deepEqual(await t.items(), ['Copy text', 'Rename', 'Reopen', 'Move up', 'Move down', 'Restart in the working directory', 'Delete'], `${label}: the actions of a middle session`);
  await page.keyboard.press('Escape');
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

// A remote Engine: with 'terminals:order' its rows move and the save goes through the proxy; without it nothing moves and the menu has no moves; one that
// answers TERMINAL_ORDER_UNSUPPORTED moves back, says so and stops offering it.
async function testRemote(browser, wide) {
  const label = wide ? 'wide remote' : 'phone remote';
  for (const capable of [true, false]) {
    const world = makeWorld({ capabilities: capable ? ['terminal:control', 'terminals:order'] : ['terminal:control'] });
    const { context, page } = await open(browser, world, { wide });
    const t = tools(page, wide);
    await t.sheet();
    await t.expand('Delta');
    await t.waitNames('Delta', ['Dee one', 'Dee two', 'Dee three']);
    const movable = await t.list('Delta').locator('.h5-terminal-row[data-movable="true"]').count();
    assert.equal(movable, capable ? 3 : 0, `${label}: rows movable ${capable ? 'with' : 'without'} the capability`);
    await t.menu('Delta', 'Dee two');
    assert.deepEqual(await t.items(), capable ? ['Rename', 'Open', 'Move up', 'Move down', 'Restart in the working directory', 'Delete'] : ['Rename', 'Open', 'Restart in the working directory', 'Delete'], `${label}: the menu ${capable ? 'with' : 'without'} moves`);
    if (capable) {
      await t.item('Move down').click();
      await t.waitNames('Delta', ['Dee one', 'Dee three', 'Dee two']);
      await t.settle();
      assert.deepEqual(t.puts(world).at(-1).slice(1), ['/api/remote-servers/7/tasks/1/terminals/order', { order: ['d1', 'd3', 'd2'] }], `${label}: saved through the proxy`);
      // A drag of a remote row, by mouse or by finger.
      const a = await t.row('Delta', 'Dee one').boundingBox();
      const b = await t.row('Delta', 'Dee two').boundingBox();
      if (wide) {
        await page.mouse.move(a.x + 80, a.y + a.height / 2);
        await page.mouse.down();
        await page.mouse.move(a.x + 80, b.y + b.height * 0.9, { steps: 10 });
        await page.mouse.up();
      } else await (await finger(page)).holdDrag(centre(a), below(b, 0.9));
      await t.waitNames('Delta', ['Dee three', 'Dee two', 'Dee one']);
      await t.dragDone();
      assert.deepEqual(t.puts(world).at(-1).slice(2), [{ order: ['d3', 'd2', 'd1'] }], `${label}: the drag saved`);
      // The proxy says the Engine is older after all: back, a notice, and no more sorting there.
      world.fail = { status: 501, code: 'TERMINAL_ORDER_UNSUPPORTED' };
      await t.menu('Delta', 'Dee two');
      await t.item('Move up').click();
      await t.notice('Could not save the session order');
      await t.waitNames('Delta', ['Dee three', 'Dee two', 'Dee one']);
      await page.waitForFunction(() => !document.querySelector('.h5-task .h5-terminal-row[data-movable="true"][data-session^="d"]'));
      await t.menu('Delta', 'Dee two');
      assert.deepEqual(await t.items(), ['Rename', 'Open', 'Restart in the working directory', 'Delete'], `${label}: no moves after TERMINAL_ORDER_UNSUPPORTED`);
      await page.keyboard.press('Escape');
    } else {
      await page.keyboard.press('Escape');
      // A hold does nothing but what a press did: no copy.
      const a = await t.row('Delta', 'Dee one').boundingBox();
      if (wide) {
        await page.mouse.move(a.x + 80, a.y + a.height / 2);
        await page.mouse.down();
        await page.mouse.move(a.x + 80, a.y + 60, { steps: 6 });
        await page.waitForTimeout(HOLD_WAIT);
        assert.equal((await t.view()).float, null, `${label}: no drag without the capability`);
        await page.mouse.up();
      } else {
        const f = await finger(page);
        await f.touch('touchStart', a.x + 80, a.y + a.height / 2);
        await page.waitForTimeout(HOLD_WAIT);
        assert.equal((await t.view()).float, null, `${label}: no drag without the capability`);
        await f.touch('touchEnd');
      }
      assert.equal(t.puts(world).length, 0, `${label}: nothing saved`);
    }
    assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
    await context.close();
  }
}

// Move up / Move down in the "⋯" (only where the row can go); a failed save moves back with a notice; a list read during a drag waits for the drop.
async function testMenuAndFailure(browser, wide) {
  const label = wide ? 'wide' : 'phone';
  const world = makeWorld();
  const { context, page } = await open(browser, world, { wide });
  const t = tools(page, wide);
  await start(page, t, wide);
  await t.menu('Alpha', 'One');
  assert.deepEqual(await t.items(), ['Copy text', 'Rename', 'Reopen', 'Move down', 'Restart in the working directory', 'Delete'], `${label}: the first row moves only down`);
  await page.keyboard.press('Escape');
  await t.menu('Alpha', 'Three');
  assert.deepEqual(await t.items(), ['Rename', 'Reopen', 'Move up', 'Restart in the working directory', 'Delete'], `${label}: the last row moves only up`);
  await t.press(t.item('Move up'));
  await t.waitNames('Alpha', ['One', 'Three', 'Two']);
  assert.equal(await t.said(), 'Moved to position 2 of 3', `${label}: announced`);
  await t.settle();
  assert.deepEqual(t.puts(world).at(-1).slice(1), ['/api/tasks/1/terminals/order', { order: ['a1', 'a3', 'a2'] }], `${label}: the menu saves the whole order`);
  // A failure moves back, sliding, and says so.
  world.fail = { status: 400, code: 'INVALID_TERMINAL_ORDER' };
  let release;
  world.holdPut = new Promise(resolve => { release = resolve; });
  await t.menu('Alpha', 'One');
  await t.press(t.item('Move down'));
  await t.waitNames('Alpha', ['Three', 'One', 'Two']);
  await t.settle();
  release();
  await t.notice('Could not save the session order');
  await t.waitNames('Alpha', ['One', 'Three', 'Two']);
  if (!wide) {
    const sliding = await t.view();
    assert.ok(sliding.transitions.some(value => /transform 180ms/.test(value)) || sliding.moved.length === 0, `${label}: the rows slide back`);
  }
  await t.settle();
  world.fail = null;
  world.holdPut = null;
  // A list read during a drag waits for the drop: a new terminal of Beta (a peek list) appears after it, and the drop keeps it last.
  await t.expand('Beta');
  world.terms['local:2'].push(term('b3', 'Bee three'));
  const a = await t.row('Beta', 'Bee one').boundingBox();
  const b = await t.row('Beta', 'Bee two').boundingBox();
  const f = wide ? null : await finger(page);
  if (wide) {
    await page.mouse.move(a.x + 80, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + 80, b.y + b.height * 0.9, { steps: 10 });
  } else await f.holdDrag(centre(a), below(b, 0.9), { release: false });
  await page.waitForSelector('.h5-session-float');
  const reads = page.waitForResponse(response => response.url().endsWith('/api/tasks/2/terminals'));
  await page.evaluate(() => window.H5UI.actions.openTasks()); // reads the open lists again
  await reads;
  await page.waitForTimeout(150);
  assert.deepEqual(await t.names('Beta'), ['Bee one', 'Bee two'], `${label}: the rows stay still during the drag`);
  if (wide) await page.mouse.up();
  else await f.touch('touchEnd');
  await t.waitNames('Beta', ['Bee two', 'Bee one', 'Bee three']);
  await t.dragDone();
  assert.deepEqual(t.puts(world).at(-1).slice(1), ['/api/tasks/2/terminals/order', { order: ['b2', 'b1', 'b3'] }], `${label}: the drop made on the newer list`);
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

// Reduced motion: the rows do not slide, the copy does not animate, and the order still changes.
async function testMotion(browser) {
  const label = 'reduced motion';
  const world = makeWorld();
  const { context, page } = await open(browser, world, { wide: true, reduced: true });
  const t = tools(page, true);
  await start(page, t, true);
  const one = await t.row('Alpha', 'One').boundingBox();
  const three = await t.row('Alpha', 'Three').boundingBox();
  await page.mouse.move(one.x + 80, one.y + one.height / 2);
  await page.mouse.down();
  await page.mouse.move(one.x + 80, three.y + three.height * 0.9, { steps: 8 });
  const mid = await t.view();
  assert.ok(mid.moved.length && mid.transitions.every(value => !/transform \d/.test(value)), `${label}: the rows move at once (${mid.transitions})`);
  await page.mouse.up();
  await t.waitNames('Alpha', ['Two', 'Three', 'One']);
  await t.dragDone();
  await t.menu('Alpha', 'One');
  await t.item('Move up').click();
  await t.waitNames('Alpha', ['Two', 'One', 'Three']);
  const after = await t.view();
  assert.deepEqual(after.moved, [], `${label}: a menu move does not slide`);
  assert.deepEqual(t.puts(world).map(([, , body]) => body.order), [['a2', 'a3', 'a1'], ['a2', 'a1', 'a3']], `${label}: both saved`);
  assert.deepEqual(world.pageErrors, [], `${label}: no page errors`);
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await testTouch(browser);
    console.log('  touch: ok');
    await testMouse(browser);
    console.log('  mouse: ok');
    for (const wide of [false, true]) {
      await testRemote(browser, wide);
      await testMenuAndFailure(browser, wide);
      console.log(`  ${wide ? 'wide' : 'phone'} remote, menu, failure, deferred read: ok`);
    }
    await testMotion(browser);
    console.log('  motion: ok');
    console.log('h5 session order: ok');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
