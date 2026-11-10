// Per-task visibility for linked machines on the page in real Chromium at 390px (touch), 1440px (mouse) and 320px: the "Visible to" item of a task's menu (a task of this machine
// with a service link, and never another service's task), the dialog (loading, its devices, saving `denied`, none checked, errors, an older server, the back gesture), and the other
// machine: a task hidden from it leaves the list and ends its terminal without a reconnect loop or a storm of notices. The server is mocked. H5_SHOT_DIR=<dir> saves screenshots at 390px.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const task = (id, title) => ({ id, title, status: 'doing', work_dir: `/w/${id}`, archived_at: null });
const CANNOT = (method, pathname) => `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot ${method} ${pathname}</pre>\n</body>\n</html>\n`; // Express, for a route it does not have
const LINK = { id: 'L1', name: 'Studio Mac', state: 'online', remote_server_id: 7 };
const DEVICES = () => [
  { link_id: 'L1', name: 'Studio Mac', online: true, allowed: true },
  { link_id: 'L2', name: 'Home server', online: false, allowed: true },
  { link_id: 'L3', name: 'Laptop', online: true, allowed: true },
];
// A long name with no spaces in Chinese, written with escapes: it must wrap at 320px.
const LONG = '\u4e00\u4e2a\u975e\u5e38\u975e\u5e38\u957f\u7684\u673a\u5668\u540d\u79f0'.repeat(5);
const SAVED = 'Unchecked machines cannot open this task or see its sessions.';
const HONEST = 'Linked machines still have full control of this computer, so this hides the task but is not a security boundary.';
const TOO_OLD = 'This server is too old to choose who can see a task. Restart or update it first';

function makeServer(options = {}) {
  const server = {
    pageErrors: [], requests: [], puts: [],
    links: [LINK], linksStatus: 200, linkAnswers: 0,
    devices: DEVICES(), visibility: 'ok', // 'ok' | 'old' (no such route) | 'empty' | 'fail' (a 500)
    putError: null, // { status, body } the next PUTs answer this
    getGate: null, putGate: null, // promises that hold an answer back
    hidden: new Set(), // tasks of the linked machine hidden from this one: out of its list, and 404
    bases: {
      '/api/tasks': [task(1, 'Alpha'), task(2, 'Beta')],
      '/api/remote-servers/7/tasks': [task(70, 'Remote one'), task(71, 'Remote two'), task(72, 'Remote three'), task(73, 'Remote four'), task(74, 'Remote five'), task(75, 'Remote six')],
    },
    ...options,
  };
  server.count = (method, url) => server.requests.filter(entry => entry === `${method} ${url}`).length;
  server.hide = id => server.hidden.add(id);
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
    const html404 = () => route.fulfill({ status: 404, contentType: 'text/html', body: CANNOT(method, pathname) });
    if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
    server.requests.push(`${method} ${pathname}${url.search}`);
    if (pathname === '/api/remote-servers') return json([{ id: 7, name: 'Linked Mac' }]);
    if (pathname === '/api/remote-servers/7/info') return json({ capabilities: ['terminal:control', 'tasks:archive'] });
    if (pathname === '/api/service-links') {
      if (server.linksStatus === 404) await html404();
      else await json({ links: server.links, supported: true });
      server.linkAnswers += 1;
      return undefined;
    }
    if (/\/task-groups$/.test(pathname)) return json([{ key: 'doing', name: 'Doing', sort_order: 1 }]);
    if (/\/terminal-activity$/.test(pathname)) return json({});
    if (/\/terminal-subagents$/.test(pathname)) return json({});
    if (/\/agent\/conversations$/.test(pathname)) return json([]);
    if (pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    if (pathname === '/api/oss/config') return json({ enabled: false });
    if (/\/terminal\/ack$/.test(pathname)) return json({ success: true });
    const match = pathname.match(/^(\/api(?:\/remote-servers\/\d+)?\/tasks)(?:\/(\d+)(?:\/(visibility|terminals|archive))?)?$/);
    if (!match || !server.bases[match[1]]) return json({ error: 'not mocked' }, 404);
    const remote = match[1] !== '/api/tasks';
    const id = Number(match[2]);
    const action = match[3];
    if (!match[2] && method === 'GET') return json(url.searchParams.get('archived') === '1' ? [] : server.bases[match[1]].filter(row => !(remote && server.hidden.has(row.id))));
    if (remote && server.hidden.has(id)) return json({ error: 'TASK_NOT_FOUND' }, 404);
    if (action === 'terminals') return json([{ terminal_id: 'default', title: 'Terminal 1' }]);
    if (action === 'visibility') {
      if (server.visibility === 'old') return html404();
      if (method === 'GET') {
        if (server.getGate) await server.getGate;
        if (server.visibility === 'fail') return json({ error: 'The database is busy' }, 500);
        return json({ devices: server.visibility === 'empty' ? [] : server.devices });
      }
      const body = JSON.parse(request.postData());
      server.puts.push({ url: pathname, body });
      if (server.putGate) await server.putGate;
      if (server.putError) return json(server.putError.body, server.putError.status);
      server.devices = server.devices.map(device => ({ ...device, allowed: !body.denied.includes(device.link_id) }));
      return json({ devices: server.devices });
    }
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  return { context, page };
}

function helpers(page, server, wide, label) {
  const press = locator => (wide ? locator.click() : locator.tap());
  const settled = () => page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity));
  const row = title => page.locator('.h5-task-row', { hasText: title });
  const sheet = async () => {
    if (!wide && !await page.locator('#h5-tasks').isVisible()) await page.locator('#h5-open-tasks').tap();
    await page.locator('#h5-tasks').waitFor({ state: 'visible' });
    await settled();
  };
  // The start: the task list is drawn, and the answer about the links has reached the page.
  const ready = async () => {
    await sheet();
    await row('Alpha').waitFor();
    await row('Remote one').waitFor();
    for (let tries = 0; tries < 100 && !server.linkAnswers; tries += 1) await page.waitForTimeout(20);
    assert.ok(server.linkAnswers, `${label}: the page asked for the links`);
    await page.waitForTimeout(80);
  };
  const select = async (title, id) => {
    await sheet();
    await press(page.locator('.h5-task-item', { hasText: title }));
    await press(page.locator(`#h5-tasks .h5-terminal-list[aria-label="${title}"] .h5-terminal-main`).first());
    await page.waitForFunction(name => document.getElementById('h5-task-name').textContent === name, title);
    await page.waitForFunction(task_ => window.taskSockets(task_).length > 0, id, { timeout: 3000 });
    if (!wide) await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
  };
  const menuItems = page.locator('#h5-term-menu-actions button, #h5-term-menu-actions [role="button"]');
  const menu = async title => {
    await sheet();
    await press(row(title).locator('.h5-task-more'));
    await menuItems.first().waitFor();
    await settled();
  };
  const closeMenu = async () => { await press(page.locator('#h5-term-menu-cancel')); await page.locator('#h5-term-menu .h5-menu-panel').waitFor({ state: 'detached' }); };
  const items = async title => { await menu(title); const texts = await menuItems.allTextContents(); await closeMenu(); return texts; };
  const dialog = page.locator('#h5-task-dialog');
  const ask = async (title = 'Beta') => { await menu(title); await press(menuItems.filter({ hasText: /^Visible to$/ })); await dialog.waitFor(); await settled(); };
  const asked = async title => { await ask(title); await page.locator('.h5-visibility-row').first().waitFor(); await settled(); };
  const closeDialog = async () => { await press(page.locator('#h5-task-dialog-cancel')); await dialog.waitFor({ state: 'detached' }); };
  const save = async () => { await press(page.locator('#h5-task-dialog-ok')); };
  const device = id => page.locator(`.h5-visibility-row[data-link="${id}"]`);
  const checked = () => page.locator('.h5-visibility-row').evaluateAll(rows => rows.map(entry => [entry.dataset.link, entry.querySelector('input').checked]));
  // The list must be open: a closed sheet of a phone has no rows at all, and the check would pass without looking.
  const gone = async title => { await sheet(); await row(title).waitFor({ state: 'detached', timeout: 3000 }).catch(() => assert.fail(`${label}: ${title} leaves the list`)); };
  const empty = () => page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'Choose a task', null, { timeout: 3000 }).catch(() => assert.fail(`${label}: no task is shown`));
  const lastNotice = () => page.evaluate(() => (window.H5UI.get().notice || {}).message || '');
  // Every notice from now on.
  const recordNotices = () => page.evaluate(() => {
    window.noticeLog = [];
    let last = window.H5UI.get().notice;
    window.H5UI.subscribe(() => { const now = window.H5UI.get().notice; if (now && now !== last) { last = now; window.noticeLog.push(now.message); } });
  });
  const notices = () => page.evaluate(() => window.noticeLog);
  const socketState = id => page.evaluate(task_ => window.taskSockets(task_).map(socket => socket.readyState), id);
  const sockets = id => page.evaluate(task_ => window.taskSockets(task_).length, id);
  return { press, settled, row, sheet, ready, select, menuItems, menu, closeMenu, items, dialog, ask, asked, closeDialog, save, device, checked, gone, empty, lastNotice, recordNotices, notices, socketState, sockets };
}

async function run(browser, wide) {
  const label = wide ? 'PC 1440px' : 'phone 390px';
  const server = makeServer();
  const { context, page } = await openPage(browser, server, wide ? { width: 1440, height: 900 } : { width: 390, height: 844 }, !wide);
  const h = helpers(page, server, wide, label);
  const shot = async name => { if (!wide && process.env.H5_SHOT_DIR) { await h.settled(); await page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, name) }); } };
  await h.ready();

  // ── The item: on a task of this machine, above Archive; the menu did not wait for the answer about the links, and the answer is at hand ──
  await h.menu('Beta');
  assert.deepEqual((await h.menuItems.allTextContents()).slice(-3), ['Visible to', 'Archive', 'Delete'], `${label}: above Archive`);
  if (!wide) assert.ok((await h.menuItems.filter({ hasText: /^Visible to$/ }).boundingBox()).height >= 44, `${label}: a 44px item`);
  await shot('task-visibility-menu-390.png');
  await h.closeMenu();
  assert.equal(server.count('GET', '/api/tasks/2/visibility'), 0, `${label}: the menu reads nothing about the task`);

  // ── Never on a task of another service: only its owner decides ──
  assert.ok(!(await h.items('Remote one')).includes('Visible to'), `${label}: no item on another service's task`);
  assert.ok(!server.requests.some(entry => /remote-servers\/7\/tasks\/\d+\/visibility/.test(entry)), `${label}: nothing is read through the proxy`);

  // ── The dialog while it loads: the state of the devices is not guessed, and Save is not there yet ──
  let release;
  server.getGate = new Promise(resolve => { release = resolve; });
  await h.ask('Beta');
  await page.locator('#h5-task-visibility-loading').waitFor();
  assert.equal(await page.locator('#h5-task-dialog-title').textContent(), 'Visible to');
  assert.equal(await page.locator('#h5-task-visibility-name').textContent(), 'Beta');
  assert.equal(await page.locator('#h5-task-dialog-ok').count(), 0, `${label}: nothing to save while loading`);
  assert.equal(await page.locator('.h5-visibility-row').count(), 0, `${label}: no rows while loading`);
  release();
  server.getGate = null;
  await page.locator('.h5-visibility-row').first().waitFor();
  assert.equal(await page.locator('#h5-task-visibility-loading').count(), 0, `${label}: the loading line goes away`);
  assert.equal(server.count('GET', '/api/tasks/2/visibility'), 1, `${label}: read once when opened`);

  // ── It lists the devices with their state, all allowed by default, and says what it does not do ──
  assert.deepEqual(await h.checked(), [['L1', true], ['L2', true], ['L3', true]], `${label}: all allowed by default`);
  assert.deepEqual(await page.locator('.h5-visibility-name').allTextContents(), ['Studio Mac', 'Home server', 'Laptop']);
  assert.deepEqual(await page.locator('.h5-visibility-offline').allTextContents(), ['Offline'], `${label}: only the offline one says so`);
  assert.equal((await h.device('L2').textContent()).includes('Offline'), true, `${label}: on its own row`);
  assert.equal(await page.locator('#h5-task-visibility-denied').count(), 0, `${label}: nothing to say while all are checked`);
  assert.equal(await page.locator('#h5-task-visibility-honest').textContent(), HONEST, `${label}: says it is no security boundary`);
  if (!wide) for (const id of ['L1', 'L2', 'L3']) assert.ok((await h.device(id).boundingBox()).height >= 44, `${label}: ${id} is a 44px row`);

  // ── Unchecking says what that means; Cancel saves nothing ──
  await h.press(h.device('L2'));
  assert.deepEqual(await h.checked(), [['L1', true], ['L2', false], ['L3', true]], `${label}: the tap unchecks`);
  assert.equal(await page.locator('#h5-task-visibility-denied').textContent(), SAVED, `${label}: says what unchecked means`);
  await shot('task-visibility-dialog-390.png');
  await h.closeDialog();
  assert.deepEqual(server.puts, [], `${label}: Cancel saves nothing`);

  // ── Saving sends the unchecked ones, closes and reads the state back ──
  await h.asked('Beta');
  assert.deepEqual(await h.checked(), [['L1', true], ['L2', true], ['L3', true]], `${label}: a cancelled change is forgotten`);
  await h.press(h.device('L2'));
  await h.save();
  await h.dialog.waitFor({ state: 'detached' });
  assert.deepEqual(server.puts.at(-1), { url: '/api/tasks/2/visibility', body: { denied: ['L2'] } }, `${label}: the unchecked one`);
  await page.waitForFunction(() => (window.H5UI.get().notice || {}).message === 'Saved');
  await h.asked('Beta');
  assert.deepEqual(await h.checked(), [['L1', true], ['L2', false], ['L3', true]], `${label}: the state is read back`);
  assert.equal(await page.locator('#h5-task-visibility-denied').textContent(), SAVED, `${label}: a saved state says so too`);

  // ── Every device checked is every device allowed ──
  await h.press(h.device('L2'));
  await h.save();
  await h.dialog.waitFor({ state: 'detached' });
  assert.deepEqual(server.puts.at(-1).body, { denied: [] }, `${label}: all allowed`);

  // ── None checked is valid: no other machine can see this task ──
  await h.asked('Beta');
  for (const id of ['L1', 'L2', 'L3']) await h.press(h.device(id));
  assert.deepEqual(await h.checked(), [['L1', false], ['L2', false], ['L3', false]]);
  await h.save();
  await h.dialog.waitFor({ state: 'detached' });
  assert.deepEqual(server.puts.at(-1).body, { denied: ['L1', 'L2', 'L3'] }, `${label}: none checked is sent`);
  server.devices = DEVICES();

  // ── Busy while saving: nothing can change and the dialog cannot be closed ──
  server.putGate = new Promise(resolve => { release = resolve; });
  await h.asked('Beta');
  await h.press(h.device('L1'));
  await h.save();
  await page.waitForFunction(() => document.getElementById('h5-task-dialog-ok').disabled);
  assert.equal(await page.locator('#h5-task-dialog-cancel').isDisabled(), true, `${label}: Cancel waits`);
  assert.equal(await h.device('L1').locator('input').isDisabled(), true, `${label}: the boxes wait`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(60);
  assert.equal(await h.dialog.count(), 1, `${label}: Escape waits`);
  release();
  server.putGate = null;
  await h.dialog.waitFor({ state: 'detached' });
  assert.deepEqual(server.puts.at(-1).body, { denied: ['L1'] });
  server.devices = DEVICES();

  // ── The server's error: the dialog stays and keeps what was chosen ──
  server.putError = { status: 400, body: { error: 'INVALID_VISIBILITY' } };
  await h.asked('Beta');
  await h.press(h.device('L3'));
  await h.save();
  const error = page.locator('#h5-task-dialog-error');
  await error.waitFor();
  assert.equal(await error.textContent(), 'The list of machines has changed. Close this and try again', `${label}: a sentence, not the code`);
  assert.deepEqual(await h.checked(), [['L1', true], ['L2', true], ['L3', false]], `${label}: the choice is kept`);
  assert.equal(await page.locator('#h5-task-dialog-ok').isDisabled(), false, `${label}: can try again`);
  server.putError = { status: 500, body: { error: 'The disk is full' } };
  await h.save();
  await page.waitForFunction(() => document.getElementById('h5-task-dialog-error')?.textContent === 'The disk is full');
  server.putError = null;
  await h.closeDialog();

  // ── A failed read says so and offers nothing to save ──
  server.visibility = 'fail';
  await h.ask('Beta');
  await error.waitFor();
  assert.equal(await error.textContent(), 'The database is busy', `${label}: the read error`);
  assert.equal(await page.locator('#h5-task-dialog-ok').count(), 0, `${label}: nothing to save after a failed read`);
  assert.equal(await page.locator('#h5-task-visibility-honest').count(), 0);
  await h.closeDialog();

  // ── No devices (the last link went while the menu was open): says so, with nothing to save ──
  server.visibility = 'empty';
  await h.ask('Beta');
  await page.locator('#h5-task-visibility-empty').waitFor();
  assert.equal(await page.locator('#h5-task-visibility-empty').textContent(), 'No linked machines');
  assert.equal(await page.locator('#h5-task-dialog-ok').count(), 0, `${label}: nothing to save`);
  await h.closeDialog();
  server.visibility = 'ok';

  // ── The back gesture closes the dialog and goes no further ──
  await h.asked('Beta');
  const before = page.url();
  await page.goBack();
  await h.dialog.waitFor({ state: 'detached', timeout: 3000 }).catch(() => assert.fail(`${label}: back closes the dialog`));
  assert.equal(page.url(), before, `${label}: back stays on the page`);
  assert.deepEqual(server.pageErrors, [], `${label}: no page errors`);

  await context.close();
  console.log(`  ${label}: ok`);
}

// Without a link nothing is offered; a server that has no linking and one whose linking has no visibility yet.
async function noLinks(browser, wide) {
  const label = wide ? 'no links 1440px' : 'no links 390px';
  const start = async options => {
    const server = makeServer(options);
    const { context, page } = await openPage(browser, server, wide ? { width: 1440, height: 900 } : { width: 390, height: 844 }, !wide);
    const h = helpers(page, server, wide, label);
    await h.ready();
    return { server, context, page, h };
  };
  const finish = async ({ server, context }) => { await context.close(); assert.deepEqual(server.pageErrors, [], `${label}: no page errors`); };

  let now = await start({ links: [] });
  assert.ok(!(await now.h.items('Beta')).includes('Visible to'), `${label}: no links, no item`);
  assert.ok((await now.h.items('Beta')).includes('Archive'), `${label}: the rest of the menu stays`);
  await finish(now);

  // Only a link the other side already ended: there is no machine left to choose.
  now = await start({ links: [{ ...LINK, state: 'revoked' }] });
  assert.ok(!(await now.h.items('Beta')).includes('Visible to'), `${label}: a revoked link is no link`);
  await finish(now);

  // A server from before service links answers 404 with a page.
  now = await start({ linksStatus: 404 });
  assert.ok(!(await now.h.items('Beta')).includes('Visible to'), `${label}: no linking, no item`);
  await finish(now);

  // A link that is made later shows the item, without a reload, the next time the menu opens.
  now = await start({ links: [] });
  now.server.links = [LINK];
  assert.ok(!(await now.h.items('Beta')).includes('Visible to'), `${label}: not yet known`);
  await now.page.waitForTimeout(80);
  assert.ok((await now.h.items('Beta')).includes('Visible to'), `${label}: seen on the next open`);
  await finish(now);

  // Linking but no such route (not restarted after an update): a clean sentence, not the HTML; the item then goes away.
  now = await start({ visibility: 'old' });
  await now.h.ask('Beta');
  const error = now.page.locator('#h5-task-dialog-error');
  await error.waitFor();
  assert.equal(await error.textContent(), TOO_OLD, `${label}: a clean message`);
  assert.equal(await now.page.locator('#h5-task-dialog-ok').count(), 0, `${label}: nothing to save`);
  await now.h.closeDialog();
  assert.ok(!(await now.h.items('Beta')).includes('Visible to'), `${label}: the item went away`);
  assert.deepEqual(now.server.puts, [], `${label}: nothing was sent`);
  await finish(now);

  console.log(`  ${label}: ok`);
}

// The other machine: its tasks are in the page as a linked service, and the owner hides one. Nothing here may become a loop or a run of error notices.
async function hiddenElsewhere(browser, wide) {
  const label = wide ? 'hidden 1440px' : 'hidden 390px';
  const server = makeServer();
  const { context, page } = await openPage(browser, server, wide ? { width: 1440, height: 900 } : { width: 390, height: 844 }, !wide);
  const h = helpers(page, server, wide, label);
  await h.ready();
  await h.recordNotices();
  const noRetry = async (id, count) => { await page.waitForTimeout(1300); assert.equal(await h.sockets(id), count, `${label}: no reconnect to task ${id}`); };
  const others = async () => {
    await h.sheet();
    await h.row('Alpha').waitFor();
    assert.equal(await page.locator('.h5-source-offline').count(), 0, `${label}: the service is not called offline`);
    for (const name of ['Alpha', 'Beta']) assert.equal(await h.row(name).count(), 1, `${label}: ${name} of this machine stays`);
  };

  // Hidden while its terminal is open: the server closes it with 1008 and the task answers 404. The page goes to no task, once.
  await h.select('Remote one', 70);
  assert.deepEqual(await h.socketState(70), [1], `${label}: connected`);
  server.hide(70);
  await page.evaluate(() => window.taskSockets(70)[0].serverClose(1008, 'TASK_NOT_FOUND'));
  await h.empty();
  await h.gone('Remote one');
  await noRetry(70, 1);
  await page.locator('#h5-empty', { hasText: 'Choose a task to open its phone terminal' }).waitFor();
  assert.equal(await page.locator('.h5-xterm').count(), 0, `${label}: no terminal is left`);
  assert.deepEqual(await h.notices(), [], `${label}: not a word`);
  await others();

  // Refused before a socket opens (which a browser reports as 1006): it would be retried for ever if the task were not checked.
  await h.select('Remote two', 71);
  server.hide(71);
  await page.evaluate(() => window.taskSockets(71)[0].serverClose(1006));
  await h.empty();
  await h.gone('Remote two');
  await noRetry(71, 1);
  assert.deepEqual(await h.notices(), [], `${label}: not a word after a refused connection`);

  // A terminal that merely dropped, on a task that is still there, keeps reconnecting as before.
  await h.select('Remote three', 72);
  await page.evaluate(() => window.taskSockets(72)[0].serverClose(1006));
  await page.waitForFunction(() => window.taskSockets(72).length === 2, null, { timeout: 4000 }).catch(() => assert.fail(`${label}: a dropped connection reconnects`));
  assert.equal(await page.locator('#h5-task-name').textContent(), 'Remote three', `${label}: its task stays shown`);
  await h.sheet();
  await h.row('Remote three').waitFor({ timeout: 3000 }).catch(() => assert.fail(`${label}: its task stays in the list`));

  // Hidden with no close at all: the next read of the list ends it, and the task sheet the person just opened stays open.
  server.hide(72);
  await page.evaluate(() => window.H5UI.actions.openTasks());
  await h.empty();
  await h.gone('Remote three');
  await h.sheet();
  assert.equal(await page.locator('#h5-tasks').isVisible(), true, `${label}: the sheet stays`);
  assert.deepEqual(await h.socketState(72).then(states => states.at(-1)), 3, `${label}: its socket is closed`);
  await noRetry(72, 2);

  // In the one list, a task that is not shown: its open list of sessions answers 404. Only that row goes, by one read of the list, and no retry loop follows.
  await h.press(page.locator('.h5-task-item', { hasText: 'Remote four' }));
  await page.locator('.h5-terminal-list[aria-label="Remote four"] .h5-terminal-main').first().waitFor();
  server.hide(73);
  const lists = server.count('GET', '/api/remote-servers/7/tasks');
  await h.press(page.locator('.h5-task-item', { hasText: 'Remote four' }));
  await h.press(page.locator('.h5-task-item', { hasText: 'Remote four' }));
  await h.gone('Remote four');
  await page.waitForTimeout(300);
  assert.equal(server.count('GET', '/api/remote-servers/7/tasks'), lists + 1, `${label}: one read of the list`);
  assert.equal(await page.locator('.h5-terminal-list[aria-label="Remote four"]').count(), 0, `${label}: its sessions are gone`);
  assert.equal(await h.row('Remote five').count(), 1, `${label}: the rest of that service stays`);
  assert.deepEqual(await h.notices(), [], `${label}: not a word about a row that left`);
  await others();

  // A row that was still in a list read before it was hidden is tapped: the list says it is gone, instead of an error about its terminals.
  server.hide(74);
  await h.press(page.locator('.h5-task-item', { hasText: 'Remote five' }));
  await page.waitForTimeout(0);
  await h.gone('Remote five');
  assert.equal(await page.locator('.h5-terminal-list[aria-label="Remote five"]').count(), 0, `${label}: its sessions are gone`);
  await page.waitForTimeout(200);
  assert.doesNotMatch(await page.locator('#h5-empty').textContent(), /Could not load/, `${label}: no error about its terminals`);
  assert.deepEqual(await h.notices(), [], `${label}: not a word`);

  // The same for a session of such a row: it is selected, and its terminals answer 404. No error about terminals, and the page ends on no task.
  await h.sheet();
  await h.press(page.locator('.h5-task-item', { hasText: 'Remote six' }));
  const session = page.locator('.h5-terminal-list[aria-label="Remote six"] .h5-terminal-main').first();
  await session.waitFor();
  await h.settled();
  server.hide(75);
  await h.press(session);
  await h.gone('Remote six');
  await page.locator('#h5-empty', { hasText: 'Choose a task to open its phone terminal' }).waitFor({ timeout: 3000 }).catch(() => assert.fail(`${label}: no error about its terminals`));
  assert.equal(await h.sockets(75), 0, `${label}: nothing connected to it`);
  assert.deepEqual(await h.notices(), [], `${label}: not a word`);

  // A task of this machine is not touched by any of it.
  assert.equal(await h.sockets(1), 0, `${label}: this machine's tasks were not opened`);
  assert.deepEqual(server.pageErrors, [], `${label}: no page errors`);
  await context.close();
  console.log(`  ${label}: ok`);
}

// A warm terminal (kept open, not shown) and a task menu that is open when the task leaves.
async function warmAndMenu(browser) {
  const label = 'warm 1440px';
  const server = makeServer();
  const { context, page } = await openPage(browser, server, { width: 1440, height: 900 }, false);
  const h = helpers(page, server, true, label);
  await h.ready();
  await h.select('Remote one', 70);
  await h.select('Remote two', 71);
  assert.equal(await page.evaluate(() => window.taskSockets(70).at(-1).readyState), 1, `${label}: the other terminal stays warm`);
  await h.recordNotices();

  server.hide(70);
  await h.menu('Remote one');
  await page.evaluate(() => window.H5UI.actions.openTasks());
  await h.gone('Remote one');
  await page.locator('#h5-term-menu .h5-menu-panel').waitFor({ state: 'detached', timeout: 3000 }).catch(() => assert.fail(`${label}: the menu of a task that left closes`));
  assert.deepEqual((await h.socketState(70)).at(-1), 3, `${label}: the warm terminal is closed`);
  assert.equal(await page.locator('#h5-task-name').textContent(), 'Remote two', `${label}: the shown task stays`);
  assert.deepEqual(await h.socketState(71), [1], `${label}: its socket stays open`);
  await page.waitForTimeout(1300);
  assert.equal(await h.sockets(70), 1, `${label}: no reconnect`);
  assert.deepEqual(await h.notices(), [], `${label}: not a word`);
  assert.deepEqual(server.pageErrors, [], `${label}: no page errors`);
  await context.close();
  console.log(`  ${label}: ok`);
}

// The narrowest phone: long Chinese names wrap inside the dialog.
async function narrow(browser) {
  const label = 'phone 320px';
  const server = makeServer();
  server.bases['/api/tasks'].push(task(9, LONG));
  server.devices = [{ link_id: 'L1', name: LONG, online: false, allowed: false }, { link_id: 'L2', name: 'Studio Mac', online: true, allowed: true }];
  const { context, page } = await openPage(browser, server, { width: 320, height: 640 }, true);
  const h = helpers(page, server, false, label);
  await h.ready();
  await h.asked(LONG.slice(0, 8));
  const fit = await page.evaluate(() => {
    const rect = el => { const box = el.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height, width: box.width }; };
    const paper = document.querySelector('#h5-task-dialog .MuiDialog-paper');
    const content = document.querySelector('#h5-task-dialog .MuiDialogContent-root');
    return { width: innerWidth, paper: rect(paper), paperScroll: paper.scrollWidth, paperClient: paper.clientWidth, scroll: content.scrollWidth, client: content.clientWidth, rows: [...document.querySelectorAll('.h5-visibility-row')].map(rect), name: rect(document.querySelector('#h5-task-visibility-name')), buttons: [...document.querySelectorAll('#h5-task-dialog .MuiDialogActions-root button')].map(rect) };
  });
  assert.ok(fit.scroll <= fit.client, `${label}: the content does not scroll sideways ${JSON.stringify(fit)}`);
  assert.ok(fit.paperScroll <= fit.paperClient, `${label}: the dialog does not scroll sideways ${JSON.stringify(fit)}`);
  assert.ok(fit.paper.left >= 0 && fit.paper.right <= fit.width, `${label}: the dialog is on the screen ${JSON.stringify(fit)}`);
  for (const row of fit.rows) { assert.ok(row.right <= fit.paper.right + 0.5 && row.left >= fit.paper.left - 0.5, `${label}: the row stays inside ${JSON.stringify(fit)}`); assert.ok(row.height >= 44, `${label}: a 44px row ${JSON.stringify(fit)}`); }
  for (const button of fit.buttons) assert.ok(button.height >= 44, `${label}: 44px buttons ${JSON.stringify(fit)}`);
  await context.close();
  assert.deepEqual(server.pageErrors, [], `${label}: no page errors`);
  console.log(`  ${label}: ok`);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await run(browser, false);
    await run(browser, true);
    await noLinks(browser, false);
    await noLinks(browser, true);
    await hiddenElsewhere(browser, false);
    await hiddenElsewhere(browser, true);
    await warmAndMenu(browser);
    await narrow(browser);
  } finally {
    await browser.close();
  }
  console.log('Per-task visibility on the page passed (390px, 1440px, 320px).');
})().catch(error => { console.error(error); process.exit(1); });
