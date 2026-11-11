// Engine names on the phone page, in real Chromium with the routes mocked: every place that names a device shows the engine's own name, this machine with a
// "This machine" hint (task list headers, the header line of the shown task, "Create on", Settings \u2192 Engines, Linked services, the task's "Visible to");
// Rename in Settings \u2192 Engines for this machine (with a reset to the default), a remote engine that renames itself, an older one that is renamed only here
// (with a note), and a linked row; validation, busy and server errors; long Chinese names at 320px; and an older server that keeps today's labels.
// H5_SHOT_DIR=<dir> saves 390px screenshots of the list headers and of the Engines group.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const GROUPS = [{ key: 'doing', name: 'In progress', sort_order: 1 }];
const SHOTS = process.env.H5_SHOT_DIR || '';
const validName = name => typeof name === 'string' && !/[\r\n]/.test(name) && name.trim().length >= 1 && Array.from(name.trim()).length <= 60;

function makeWorld({ modern = true, localName = 'MacBook' } = {}) {
  const row = (id, name, source) => ({
    id, name, status: 'online', base_url: `http://10.0.0.${id}:14002`, enabled: true, remote_version: '2.99.0',
    ...(modern ? { name_source: source, can_rename: true } : {}),
  });
  return {
    modern, writes: [], pageErrors: [], fail: null, hold: null,
    local: { name: localName, default_name: 'torin-mbp', custom: true },
    servers: [row(7, 'VPS', 'engine'), row(8, 'Old box', 'local'), row(9, 'Peer', 'engine')],
    tasks: { local: [{ id: 1, title: 'Alpha', status: 'doing', work_dir: '/w/alpha', archived_at: null }], 7: [{ id: 1, title: 'Remote alpha', status: 'doing', work_dir: '/r/alpha', archived_at: null }], 8: [], 9: [] },
  };
}
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function serve(world, route) {
  const url = new URL(route.request().url());
  const pathname = url.pathname;
  const method = route.request().method();
  const body = method === 'GET' ? null : route.request().postDataJSON();
  if (method !== 'GET') world.writes.push([method, pathname, body]);
  if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
  if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
  if (pathname === '/api/system/version') return json(route, { app_version: '2.99.0', boot_id: 'b1', ...(world.modern ? { engine_name: world.local.name } : {}) });
  if (pathname === '/api/system/engine-name') {
    if (!world.modern) return route.fulfill({ status: 404, contentType: 'text/html', body: 'Cannot GET' });
    if (method === 'PUT') {
      if (world.hold) await world.hold.promise;
      if (world.fail) { const { status, answer } = world.fail; world.fail = null; return json(route, answer, status); }
      if (!body || !('name' in body)) return json(route, { error: 'INVALID_ENGINE_NAME' }, 400);
      if (body.name === '' || body.name === null) Object.assign(world.local, { name: world.local.default_name, custom: false });
      else if (!validName(body.name)) return json(route, { error: 'INVALID_ENGINE_NAME' }, 400);
      else Object.assign(world.local, { name: body.name.trim(), custom: true });
    }
    return json(route, world.local);
  }
  if (pathname === '/api/remote-servers') return json(route, world.servers);
  const rename = pathname.match(/^\/api\/remote-servers\/(\d+)\/name$/);
  if (rename && method === 'PUT') {
    if (world.hold) await world.hold.promise;
    if (world.fail) { const { status, answer } = world.fail; world.fail = null; return json(route, answer, status); }
    const server = world.servers.find(item => item.id === Number(rename[1]));
    // The full row comes back. A reset ('' or null) needs a default, which only an engine that keeps its own name has.
    if (!body || !('name' in body)) return json(route, { error: 'INVALID_ENGINE_NAME' }, 400);
    if ((body.name === '' || body.name === null) && server.name_source === 'engine') { server.name = `host-${server.id}`; return json(route, server); }
    if (!validName(body.name)) return json(route, { error: 'INVALID_ENGINE_NAME' }, 400);
    server.name = body.name.trim();
    return json(route, server);
  }
  if (pathname === '/api/service-links') {
    const peer = world.servers.find(item => item.id === 9);
    return json(route, { supported: true, links: [{ id: 'l1', remote_server_id: 9, name: peer.name, peer_url: 'http://10.0.0.9:14002', role: 'initiator', online: true, state: 'online', shared: {} }] });
  }
  if (pathname === '/api/task-list/hidden-devices') return json(route, { hidden: [] });
  if (pathname === '/auth/me') return json(route, { effective_work_dir: '/home/me/tasks' });
  if (pathname === '/api/tasks/1/visibility') return json(route, { devices: [{ link_id: 'l1', name: world.servers.find(item => item.id === 9).name, allowed: true, online: true }] });
  const remote = pathname.match(/^\/api\/remote-servers\/(\d+)(\/.*)?$/);
  const key = remote ? Number(remote[1]) : 'local';
  const tail = remote ? remote[2] || '' : pathname.replace(/^\/api/, '');
  if (tail === '/task-groups') return json(route, GROUPS);
  if (tail === '/info') return json(route, { capabilities: ['terminal:control'] });
  if (tail === '/tasks' && method === 'GET') return json(route, world.tasks[key] || []);
  if (/\/terminal-activity$|\/terminal-subagents$/.test(tail)) return json(route, {});
  if (/^\/tasks\/\d+\/terminals$/.test(tail)) return json(route, [{ terminal_id: 'default', title: 'Shell' }]);
  if (/^\/tasks\/\d+\/terminal\/(ack|control)$/.test(tail)) return json(route, {});
  return json(route, { error: 'not mocked' }, 404);
}

async function open(browser, world, { width = 390 } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
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

function tools(page) {
  const settle = () => page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity));
  const sheet = async () => {
    if (!await page.locator('#h5-tasks').isVisible()) await page.locator('#h5-open-tasks').tap();
    await page.locator('#h5-tasks').waitFor({ state: 'visible' });
    await settle();
  };
  const header = key => page.locator(`#h5-task-list .h5-source-header[data-source="${key}"]`);
  const headerName = key => header(key).locator('.h5-source-name').textContent();
  const waitHeader = (key, text) => page.waitForFunction(([k, want]) => {
    const node = document.querySelector(`#h5-task-list .h5-source-header[data-source="${k}"] .h5-source-name`);
    return node && node.textContent === want;
  }, [key, text]);
  const group = async id => {
    const summary = page.locator(`#h5-set-${id} .MuiAccordionSummary-root`);
    await summary.scrollIntoViewIfNeeded();
    if (await summary.getAttribute('aria-expanded') !== 'true') await summary.tap();
    await page.waitForFunction(groupId => Boolean(document.querySelector(`#h5-set-${groupId} .MuiCollapse-entered`)), id);
  };
  const openEngines = async () => {
    await page.evaluate(() => window.H5UI.actions.openSettings());
    await page.locator('#h5-settings').waitFor({ state: 'visible' });
    await group('engines');
    await page.locator('.h5-engine-row[data-engine="9"]').waitFor();
  };
  const closeSettings = async () => { await page.evaluate(() => window.H5UI.actions.closeSettings()); await page.locator('#h5-settings .h5-sheet-panel').waitFor({ state: 'hidden' }); };
  const engineRow = key => page.locator(`.h5-engine-row[data-engine="${key}"]`);
  const engineName = key => engineRow(key).locator('.h5-engine-name').textContent();
  const dialog = page.locator('#h5-engine-rename [role="dialog"]');
  const openRename = async key => {
    await engineRow(key).locator('.h5-engine-rename').tap();
    await dialog.waitFor({ state: 'visible' });
    await settle();
  };
  const field = page.locator('#h5-engine-rename-name');
  const save = async () => { await page.locator('#h5-engine-rename-save').tap(); };
  const closed = () => dialog.waitFor({ state: 'hidden' });
  return { settle, sheet, header, headerName, waitHeader, group, openEngines, closeSettings, engineRow, engineName, dialog, openRename, field, save, closed };
}
const writesTo = (world, pathname) => world.writes.filter(([method, p]) => method === 'PUT' && p === pathname);

// Every place that names a device, on a server with engine names.
async function testNamesShown(browser) {
  const world = makeWorld();
  const { context, page } = await open(browser, world);
  const t = tools(page);
  await t.sheet();
  await t.waitHeader('local', 'MacBook');
  assert.equal(await t.header('local').locator('.h5-source-hint').textContent(), '\u00B7 This machine', 'list: this machine has the hint');
  assert.equal(await t.header('local').locator('.h5-source-name').getAttribute('title'), 'MacBook \u00B7 This machine', 'list: the full text is the title');
  assert.deepEqual(await page.locator('#h5-task-list .h5-source-header .h5-source-name').allTextContents(), ['MacBook', 'VPS', 'Old box', 'Peer'], 'list: each device by its name');
  assert.equal(await t.header('remote:7').locator('.h5-source-hint').count(), 0, 'list: a remote device has no hint');
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.locator('#h5-tasks').screenshot({ path: path.join(SHOTS, 'engine-name-list-390.png') }); }

  await page.locator('#h5-add-task').tap();
  await page.locator('#h5-new-task-on').waitFor();
  assert.deepEqual(await page.locator('#h5-new-task-on option').allTextContents(), ['MacBook \u00B7 This machine', 'VPS', 'Old box', 'Peer'], 'Create on: the names');
  await page.locator('#h5-add-task').tap();

  // The header line of a remote task names its device.
  const item = page.locator('#h5-task-list .h5-source[data-source="remote:7"] .h5-task-item').first();
  await item.tap();
  await page.locator('#h5-task-list .h5-source[data-source="remote:7"] .h5-terminal-main').first().tap();
  await page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'Remote alpha');
  await page.locator('#h5-tasks').waitFor({ state: 'hidden' }); // the sheet closes on a phone: wait, or the next open would find it still closing
  assert.equal(await page.locator('#h5-task-service').textContent(), 'VPS', 'header: the device of the shown task');

  // "Visible to" of a task of this machine lists the linked machines by the names the server gives.
  await t.sheet();
  await page.locator('#h5-task-list .h5-source[data-source="local"] .h5-task-more').first().tap();
  await page.locator('#h5-term-menu-actions button', { hasText: 'Visible to' }).tap();
  await page.locator('.h5-visibility-row').waitFor();
  assert.equal(await page.locator('.h5-visibility-name').textContent(), 'Peer', 'Visible to: the linked machine by name');
  await page.locator('#h5-task-dialog-cancel').tap();
  await page.locator('#h5-task-dialog [role="dialog"]').waitFor({ state: 'hidden' });

  await t.openEngines();
  await page.waitForFunction(() => (document.querySelector('.h5-engine-row[data-engine="local"] .h5-engine-name') || {}).textContent === 'MacBook');
  assert.equal(await t.engineRow('local').locator('.h5-engine-hint').textContent(), '\u00B7 This machine', 'Engines: the hint');
  assert.equal(await page.locator('#h5-engine-local-version').textContent(), 'v2.99.0', 'Engines: the version stays');
  assert.deepEqual(await page.locator('.h5-engine-row .h5-engine-name').allTextContents(), ['MacBook', 'VPS', 'Old box', 'Peer'], 'Engines: the names');
  assert.equal(await page.locator('.h5-engine-row .h5-engine-rename').count(), 4, 'Engines: Rename on every row, this machine and the linked one too');
  assert.equal(await t.engineRow(9).locator('.h5-engine-edit').count(), 0, 'Engines: a linked row still cannot edit its connection');
  assert.equal(await page.locator('.h5-engine-row .h5-engine-visible').count(), 4, 'Engines: "Show in task list" on every row');
  const box = await t.engineRow('local').locator('.h5-engine-rename').boundingBox();
  assert.ok(box.height >= 44, `Engines: Rename is a 44px target (${box.height})`);
  if (SHOTS) await page.locator('#h5-set-engines').screenshot({ path: path.join(SHOTS, 'engine-name-engines-390.png') });

  // "Edit connection" of a row that can be renamed has no name field any more: the name has one way to change.
  await t.engineRow(7).locator('.h5-engine-edit').tap();
  await page.locator('#h5-engine-edit [role="dialog"]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#h5-engine-edit-name').count(), 0, 'Edit connection: no name field with Rename');
  await page.locator('#h5-engine-edit-cancel').tap();
  await page.locator('#h5-engine-edit [role="dialog"]').waitFor({ state: 'hidden' });

  await t.group('service-links');
  await page.locator('.h5-link-row .h5-link-name').waitFor();
  assert.equal(await page.locator('.h5-link-row .h5-link-name').textContent(), 'Peer', 'Linked services: the name');
  assert.deepEqual(world.pageErrors, []);
  await context.close();
}

// Rename this machine, then back to its default; everything that names it follows.
async function testRenameLocal(browser) {
  const world = makeWorld();
  const { context, page } = await open(browser, world);
  const t = tools(page);
  await t.sheet();
  await t.waitHeader('local', 'MacBook');
  await t.openEngines();
  await t.openRename('local');
  assert.equal(await page.locator('#h5-engine-rename-current').textContent(), 'MacBook', 'dialog: the current name');
  assert.equal(await t.field.inputValue(), 'MacBook', 'dialog: the field starts with it');
  assert.match(await page.locator('#h5-engine-rename-default').textContent(), /torin-mbp/, 'dialog: the default name is shown');
  assert.equal(await page.locator('#h5-engine-rename-reset').isEnabled(), true, 'dialog: a custom name can be reset');
  assert.equal(await page.locator('#h5-engine-rename-only-here').count(), 0, 'dialog: no note for this machine');
  await t.field.fill('  \u5DE5\u4F5C\u7AD9 Mac  ');
  await t.save();
  await t.closed();
  assert.deepEqual(writesTo(world, '/api/system/engine-name').at(-1)[2], { name: '\u5DE5\u4F5C\u7AD9 Mac' }, 'the trimmed name is sent');
  await page.waitForFunction(() => document.querySelector('.h5-engine-row[data-engine="local"] .h5-engine-name').textContent === '\u5DE5\u4F5C\u7AD9 Mac');
  assert.equal(await page.locator('#h5-engines-feedback').textContent(), 'Saved');
  await t.closeSettings();
  await t.sheet();
  await t.waitHeader('local', '\u5DE5\u4F5C\u7AD9 Mac');
  await page.locator('#h5-add-task').tap();
  assert.equal(await page.locator('#h5-new-task-on option').first().textContent(), '\u5DE5\u4F5C\u7AD9 Mac \u00B7 This machine', 'Create on follows');
  await page.locator('#h5-add-task').tap();

  await t.openEngines();
  await t.openRename('local');
  await page.locator('#h5-engine-rename-reset').tap();
  await t.closed();
  assert.deepEqual(writesTo(world, '/api/system/engine-name').at(-1)[2], { name: '' }, 'reset sends an empty name');
  await page.waitForFunction(() => document.querySelector('.h5-engine-row[data-engine="local"] .h5-engine-name').textContent === 'torin-mbp');
  await t.openRename('local');
  assert.equal(await page.locator('#h5-engine-rename-reset').isEnabled(), false, 'the default name has nothing to reset');
  await page.locator('#h5-engine-rename-cancel').tap();
  await t.closed();
  await t.closeSettings();
  await t.sheet();
  await t.waitHeader('local', 'torin-mbp');
  assert.deepEqual(world.pageErrors, []);
  await context.close();
}

// A remote engine that renames itself, an older one renamed only here, and a linked row.
async function testRenameRemote(browser) {
  const world = makeWorld();
  const { context, page } = await open(browser, world);
  const t = tools(page);
  await t.sheet();
  await t.waitHeader('remote:7', 'VPS');
  // The task of VPS is shown, so the header line follows the rename too.
  await page.locator('#h5-task-list .h5-source[data-source="remote:7"] .h5-task-item').first().tap();
  await page.locator('#h5-task-list .h5-source[data-source="remote:7"] .h5-terminal-main').first().tap();
  await page.waitForFunction(() => document.getElementById('h5-task-service') && document.getElementById('h5-task-service').textContent === 'VPS');
  await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
  await t.openEngines();

  await t.openRename(7);
  assert.equal(await page.locator('#h5-engine-rename-only-here').count(), 0, 'an engine that renames itself has no note');
  assert.equal(await page.locator('#h5-engine-rename-reset').isEnabled(), true, 'an engine that keeps its own name can go back to its default');
  await t.field.fill('\u4E1C\u4EAC VPS');
  await t.save();
  await t.closed();
  assert.deepEqual(writesTo(world, '/api/remote-servers/7/name').at(-1)[2], { name: '\u4E1C\u4EAC VPS' });
  await page.waitForFunction(() => document.querySelector('.h5-engine-row[data-engine="7"] .h5-engine-name').textContent === '\u4E1C\u4EAC VPS');

  await t.openRename(8);
  assert.equal(await page.locator('#h5-engine-rename-only-here').textContent(), 'This engine is too old to be renamed. The new name only changes on this device.', 'the note of an older engine');
  assert.equal(await page.locator('#h5-engine-rename-reset').count(), 0, 'a name kept only here has no default to go back to');
  await t.field.fill('Old box 2');
  await t.save();
  await t.closed();
  assert.deepEqual(writesTo(world, '/api/remote-servers/8/name').at(-1)[2], { name: 'Old box 2' });

  await t.openRename(9);
  assert.equal(await t.field.inputValue(), 'Peer');
  await t.field.fill('Peer two');
  await t.save();
  await t.closed();
  assert.deepEqual(writesTo(world, '/api/remote-servers/9/name').at(-1)[2], { name: 'Peer two' });
  await page.waitForFunction(() => document.querySelector('.h5-engine-row[data-engine="9"] .h5-engine-name').textContent === 'Peer two');
  await t.group('service-links');
  await page.waitForFunction(() => (document.querySelector('.h5-link-row .h5-link-name') || {}).textContent === 'Peer two');
  await t.closeSettings();

  await page.waitForFunction(() => document.getElementById('h5-task-service').textContent === '\u4E1C\u4EAC VPS');
  await t.sheet();
  assert.deepEqual(await page.locator('#h5-task-list .h5-source-header .h5-source-name').allTextContents(), ['MacBook', '\u4E1C\u4EAC VPS', 'Old box 2', 'Peer two'], 'the list follows every rename');

  // An engine that keeps its own name goes back to its default (an empty name).
  await t.openEngines();
  await t.openRename(7);
  await page.locator('#h5-engine-rename-reset').tap();
  await t.closed();
  assert.deepEqual(writesTo(world, '/api/remote-servers/7/name').at(-1)[2], { name: '' }, 'a remote reset sends an empty name');
  await page.waitForFunction(() => document.querySelector('.h5-engine-row[data-engine="7"] .h5-engine-name').textContent === 'host-7');
  await t.closeSettings();
  await t.sheet();
  await t.waitHeader('remote:7', 'host-7');
  assert.deepEqual(world.pageErrors, []);
  await context.close();
}

// What the dialog refuses before sending, the busy state, and the errors of the server.
async function testValidationAndErrors(browser) {
  const world = makeWorld();
  const { context, page } = await open(browser, world);
  const t = tools(page);
  await t.openEngines();
  await t.openRename('local');
  const before = world.writes.length;
  await t.field.fill('   ');
  await t.save();
  assert.equal(await page.locator('#h5-engine-rename-error').textContent(), 'Enter a name', 'an empty name');
  await t.field.fill('x'.repeat(61));
  await t.save();
  assert.equal(await page.locator('#h5-engine-rename-error').textContent(), 'A name can have at most 60 characters', '61 characters');
  assert.equal(world.writes.length, before, 'nothing is sent for a name the rule refuses');
  assert.equal(await t.dialog.isVisible(), true, 'the dialog stays open');

  // 60 Chinese characters are allowed (counted in characters).
  const sixty = '\u540D'.repeat(60);
  await t.field.fill(sixty);
  await t.save();
  await t.closed();
  assert.deepEqual(writesTo(world, '/api/system/engine-name').at(-1)[2], { name: sixty });

  // The server's own refusal.
  world.fail = { status: 400, answer: { error: 'INVALID_ENGINE_NAME' } };
  await t.openRename('local');
  await t.field.fill('Refused');
  await t.save();
  await page.locator('#h5-engine-rename-error').waitFor();
  assert.equal(await page.locator('#h5-engine-rename-error').textContent(), 'Enter a name of 1 to 60 characters on one line');
  assert.equal(await t.field.inputValue(), 'Refused', 'what was typed stays');
  world.fail = { status: 403, answer: { error: 'ENGINE_ADMIN_REQUIRED' } };
  await t.save();
  await page.waitForFunction(() => (document.getElementById('h5-engine-rename-error') || {}).textContent === 'Only an administrator can rename this machine');
  await page.locator('#h5-engine-rename-cancel').tap();
  await t.closed();

  // Busy while the server answers; then an offline engine (502 without a code of its own).
  let release;
  world.hold = { promise: new Promise(resolve => { release = resolve; }) };
  world.fail = { status: 502, answer: { error: 'ENGINE_OFFLINE' } };
  await t.openRename(7);
  await t.field.fill('Tokyo');
  await t.save();
  await page.locator('#h5-engine-rename-busy').waitFor();
  assert.equal(await page.locator('#h5-engine-rename-save').isDisabled(), true, 'busy: Save is disabled');
  assert.equal(await page.locator('#h5-engine-rename-cancel').isDisabled(), true, 'busy: Cancel is disabled');
  release();
  world.hold = null;
  await page.locator('#h5-engine-rename-error').waitFor();
  assert.equal(await page.locator('#h5-engine-rename-error').textContent(), 'The engine is offline. Try again when it is online.');
  assert.equal(await page.locator('#h5-engine-rename-busy').count(), 0, 'not busy any more');

  // A known connection error, then the remote's own message passed through.
  world.fail = { status: 502, answer: { error: 'REMOTE_CONNECTION_FAILED' } };
  await t.save();
  await page.waitForFunction(() => (document.getElementById('h5-engine-rename-error') || {}).textContent === 'Failed to connect to the remote service');
  world.fail = { status: 409, answer: { error: 'REMOTE_SAID_NO', message: 'The remote engine refused the name' } };
  await t.save();
  await page.waitForFunction(() => (document.getElementById('h5-engine-rename-error') || {}).textContent === 'The remote engine refused the name');
  assert.equal(world.servers.find(item => item.id === 7).name, 'VPS', 'nothing was renamed');
  await page.locator('#h5-engine-rename-cancel').tap();
  await t.closed();
  assert.deepEqual(world.pageErrors, []);
  await context.close();
}

// A long Chinese name at 320px: cut with an ellipsis in the list and in Engines, the hint stays, the full name is the title and is in the dialog.
async function testLongNames(browser) {
  const long = '\u8FD9\u662F\u4E00\u4E2A\u975E\u5E38\u957F\u7684\u4E2D\u6587\u5F15\u64CE\u540D\u79F0\u7528\u6765\u6D4B\u8BD5\u7701\u7565\u53F7\u662F\u5426\u6B63\u786E\u663E\u793A\u5728\u7A84\u5C4F\u5E55\u4E0A\u7684\u6548\u679C';
  const world = makeWorld({ localName: long });
  world.servers[0].name = long;
  const { context, page } = await open(browser, world, { width: 320 });
  const t = tools(page);
  await t.sheet();
  await t.waitHeader('local', long);
  const cut = selector => page.evaluate(sel => { const node = document.querySelector(sel); return node.scrollWidth > node.clientWidth && getComputedStyle(node).textOverflow === 'ellipsis'; }, selector);
  const inside = (inner, outer) => page.evaluate(([a, b]) => { const r = document.querySelector(a).getBoundingClientRect(); const o = document.querySelector(b).getBoundingClientRect(); return r.width > 0 && r.right <= o.right + 0.5; }, [inner, outer]);
  assert.equal(await cut('.h5-source-header[data-source="local"] .h5-source-name'), true, 'list: the name is cut');
  assert.equal(await inside('.h5-source-header[data-source="local"] .h5-source-hint', '.h5-source-header[data-source="local"]'), true, 'list: the hint stays visible');
  assert.equal(await t.header('local').locator('.h5-source-name').getAttribute('title'), `${long} \u00B7 This machine`);
  assert.equal(await cut('.h5-source-header[data-source="remote:7"] .h5-source-name'), true, 'list: a long remote name is cut');
  if (SHOTS) await page.locator('#h5-tasks').screenshot({ path: path.join(SHOTS, 'engine-name-long-list-320.png') });
  await t.openEngines();
  await page.waitForFunction(text => document.querySelector('.h5-engine-row[data-engine="local"] .h5-engine-name').textContent === text, long);
  assert.equal(await cut('.h5-engine-row[data-engine="local"] .h5-engine-name'), true, 'Engines: the name is cut');
  assert.equal(await inside('.h5-engine-row[data-engine="local"] .h5-engine-hint', '.h5-engine-row[data-engine="local"]'), true, 'Engines: the hint stays visible');
  assert.equal(await cut('.h5-engine-row[data-engine="7"] .h5-engine-name'), true, 'Engines: a remote name is cut');
  assert.equal(await t.engineRow(7).locator('.h5-engine-name').getAttribute('title'), long);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 320), 'no horizontal scroll');
  if (SHOTS) await page.locator('#h5-set-engines').screenshot({ path: path.join(SHOTS, 'engine-name-long-320.png') });
  await t.openRename(7);
  assert.equal(await page.locator('#h5-engine-rename-current').textContent(), long, 'dialog: the full name');
  const wraps = await page.evaluate(() => { const node = document.getElementById('h5-engine-rename-current'); return node.scrollWidth <= node.clientWidth; });
  assert.equal(wraps, true, 'dialog: the full name wraps instead of being cut');
  assert.deepEqual(world.pageErrors, []);
  await context.close();
}

// An older server: no engine names, no Rename, today's labels and the name field of "Edit connection".
async function testOlderServer(browser) {
  const world = makeWorld({ modern: false });
  const { context, page } = await open(browser, world);
  const t = tools(page);
  await t.sheet();
  await t.waitHeader('local', 'This machine');
  assert.equal(await t.header('local').locator('.h5-source-hint').count(), 0, 'older: no hint next to "This machine"');
  await page.locator('#h5-add-task').tap();
  assert.deepEqual(await page.locator('#h5-new-task-on option').allTextContents(), ['This machine', 'VPS', 'Old box', 'Peer'], 'older: Create on as today');
  await page.locator('#h5-add-task').tap();
  await t.openEngines();
  await page.waitForFunction(() => Boolean(document.getElementById('h5-engine-local-version')) && document.getElementById('h5-engine-local-version').textContent === 'v2.99.0');
  assert.equal(await t.engineName('local'), 'This machine', 'older: the label as today');
  assert.equal(await page.locator('.h5-engine-row .h5-engine-rename').count(), 0, 'older: no Rename anywhere');
  await t.engineRow(7).locator('.h5-engine-edit').tap();
  await page.locator('#h5-engine-edit [role="dialog"]').waitFor({ state: 'visible' });
  assert.equal(await page.inputValue('#h5-engine-edit-name'), 'VPS', 'older: the name is edited with the connection, as today');
  await page.locator('#h5-engine-edit-cancel').tap();
  assert.deepEqual(world.pageErrors, []);
  await context.close();
}

(async () => {
  const browser = await chromium.launch();
  try {
    for (const run of [testNamesShown, testRenameLocal, testRenameRemote, testValidationAndErrors, testLongNames, testOlderServer]) {
      await run(browser);
      console.log(`ok ${run.name}`);
    }
    console.log('h5 engine name browser tests passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
