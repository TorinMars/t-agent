// Mind maps shared across connected services, in real Chromium with every route mocked here: the maps of this machine and of each connected service are in ONE list,
// each under a small header in task list order; each map stays on its own service, so opening, saving, renaming, deleting, conflicts, "save as a new copy" and drafts go
// to that service's `/api/remote-servers/:id/mindmaps` (this machine: `/api/mindmaps`). A service answering 501 is left out, a hidden device's maps are not shown, an
// offline one shows "Offline" and holds nothing up, and a single machine looks as it always did. Each case collects its failures; all are printed at the end.
// MINDMAP_SHOTS=<dir> saves a 390px screenshot of the list with two services. MINDMAP_ONLY=<text> runs the cases whose name has it.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOT_DIR = process.env.MINDMAP_SHOTS || null;
const LOCAL_BASE = '/api/mindmaps';
const OFFICE_BASE = '/api/remote-servers/2/mindmaps';
const SHARED_ID = '7d1f3c2a-1111-4c4c-9a9a-000000000001'; // the same id and title on two services: nothing may mix them up
const failures = [];
const pageErrors = [];
let currentCase = '';
const check = (ok, message) => { if (!ok) { failures.push(`${currentCase}: ${message}`); console.log(`  FAILED ${message}`); } };
const until = async (test, ms = 5000) => { const end = Date.now() + ms; while (!test()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(done => setTimeout(done, 50)); } };
const doc = (...children) => ({ nodeData: { id: 'r', topic: 'Root', children: children.map((topic, i) => ({ id: `c${i}`, topic, children: [] })) }, arrows: [], summaries: [], direction: 1 });

// One service's maps. `mode`: 'ok', 'offline' (502 REMOTE_OFFLINE) or 'unsupported' (501).
function makeStore(base) {
  let n = 0;
  const maps = new Map();
  const control = { mode: 'ok', listDelayMs: 0, conflictNext: false };
  const stamp = () => new Date().toISOString();
  const make = (title, data, id = null) => {
    n += 1;
    const map = { id: id || `${base.length.toString(16).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`, title, data: data ?? null, revision: 1, created_at: stamp(), updated_at: stamp() };
    maps.set(map.id, map);
    return map;
  };
  return { base, maps, control, make };
}

function makeWorld({ servers = [], hidden = [] } = {}) {
  const world = { servers, hidden, log: [], stores: new Map([[LOCAL_BASE, makeStore(LOCAL_BASE)]]), taskOffline: new Set() };
  for (const server of servers) world.stores.set(`/api/remote-servers/${server.id}/mindmaps`, makeStore(`/api/remote-servers/${server.id}/mindmaps`));
  world.store = base => world.stores.get(base);
  world.requests = (base, method) => world.log.filter(entry => entry.base === base && (!method || entry.method === method));
  return world;
}
const OFFICE = { id: 2, name: 'Office Mac', status: 'online', enabled: true };
const OLD = { id: 3, name: 'Old box', status: 'online', enabled: true };
const HIDDEN = { id: 4, name: 'Hidden box', status: 'online', enabled: true };
const DOWN = { id: 5, name: 'Down box', status: 'offline', enabled: true };

async function serveMaps(world, route, pathname, method, body, json) {
  const base = pathname.startsWith(LOCAL_BASE) ? LOCAL_BASE : (pathname.match(/^\/api\/remote-servers\/\d+\/mindmaps/) || [])[0];
  const store = world.store(base);
  if (!store) return json({ error: 'not mocked' }, 404);
  world.log.push({ base, method, pathname, body });
  if (store.control.mode === 'unsupported') return json({ error: 'MINDMAPS_UNSUPPORTED', message: 'Not supported' }, 501);
  if (store.control.mode === 'offline') return json({ error: 'REMOTE_OFFLINE', message: 'Offline' }, 502);
  const tail = pathname.slice(base.length);
  if (!tail && method === 'GET') {
    if (store.control.listDelayMs) await new Promise(done => setTimeout(done, store.control.listDelayMs));
    return json({ maps: [...store.maps.values()].reverse().map(({ data, ...rest }) => ({ ...rest, size: JSON.stringify(data || {}).length })) });
  }
  if (!tail && method === 'POST') return json(store.make(body.title || 'Untitled map', body.data), 201);
  const id = decodeURIComponent(tail.slice(1));
  const map = store.maps.get(id);
  if (!map) return json({ error: 'MINDMAP_NOT_FOUND' }, 404);
  if (method === 'GET') return json(map);
  if (method === 'DELETE') { store.maps.delete(id); return route.fulfill({ status: 204, body: '' }); }
  if (method === 'PUT') {
    if (store.control.conflictNext || body.revision !== map.revision) { store.control.conflictNext = false; map.revision += 10; return json({ error: 'MINDMAP_CONFLICT', current_revision: map.revision }, 409); }
    map.revision += 1;
    if (body.title !== undefined) map.title = body.title;
    if (body.data !== undefined) map.data = body.data;
    map.updated_at = stamp();
    return json({ id, title: map.title, revision: map.revision, updated_at: map.updated_at });
  }
  return json({ error: 'not mocked' }, 404);
}
function stamp() { return new Date().toISOString(); }

async function serve(world, route) {
  const request = route.request();
  const { pathname } = new URL(request.url());
  const method = request.method();
  const body = request.postData() ? JSON.parse(request.postData()) : undefined;
  const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
  if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
  if (/^\/api\/mindmaps(\/|$)|^\/api\/remote-servers\/\d+\/mindmaps(\/|$)/.test(pathname)) return serveMaps(world, route, pathname, method, body, json);
  if (pathname === '/api/remote-servers') return json(world.servers);
  if (pathname === '/api/service-links') return json({ supported: true, links: [] });
  if (pathname === '/api/task-list/hidden-devices') return json({ hidden: world.hidden });
  const remote = pathname.match(/^\/api\/remote-servers\/(\d+)\/(.+)$/);
  if (remote) {
    if (world.taskOffline.has(Number(remote[1])) || world.servers.some(server => server.id === Number(remote[1]) && server.status === 'offline')) return json({ error: 'REMOTE_CONNECTION_FAILED' }, 502);
    if (remote[2] === 'tasks' || remote[2] === 'task-groups') return json([]);
    if (remote[2] === 'info') return json({ capabilities: [] });
    return json({});
  }
  if (pathname === '/api/tasks') return json([]);
  if (pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
  if (pathname === '/api/tasks/terminal-activity' || pathname === '/api/tasks/terminal-subagents') return json({});
  if (pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
  if (pathname === '/api/oss/config') return json({ enabled: false });
  if (pathname === '/api/system/check-update' || pathname === '/api/system/update-status') return json({ status: 'current', local_version: '1.0.0' });
  return json({ error: 'not mocked' }, 404);
}

async function openPage(browser, world, { touch = false } = {}) {
  const context = await browser.newContext({ viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 800 }, isMobile: touch, hasTouch: touch });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(`${currentCase}: ${error.message}`));
  await page.addInitScript(() => {
    window.WebSocket = class { constructor(url) { this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); } send() {} close() { this.readyState = 3; } };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
  });
  await page.route(`${ORIGIN}/**`, route => serve(world, route));
  await page.goto(`${ORIGIN}/h5`);
  // Every notice of the page, in order (the shell shows only the newest one).
  await page.waitForFunction(() => typeof window.notify === 'function');
  await page.evaluate(() => { const show = window.notify; window.notices = []; window.notify = (message, type) => { window.notices.push(String(message)); return show(message, type); }; });
  return { context, page };
}

function tools(page, touch) {
  const press = locator => (touch ? locator.tap() : locator.click());
  const section = key => page.locator(`.mm-section[data-source="${key}"]`);
  const row = (key, title) => section(key).locator('.mm-row').filter({ has: page.locator('.mm-row-title', { hasText: new RegExp(`^${title}$`) }) });
  const openView = async () => {
    if (touch && !await page.locator('#h5-tasks-mindmap').isVisible().catch(() => false)) {
      await page.locator('#h5-open-tasks').tap();
      await page.locator('#h5-tasks-mindmap').waitFor({ state: 'visible' });
    }
    await press(page.locator('#h5-tasks-mindmap'));
    await page.locator('#mm-new').waitFor();
  };
  const sections = () => page.evaluate(() => [...document.querySelectorAll('.mm-section')].map(node => ({
    key: node.dataset.source,
    header: node.querySelector('.mm-source-name') ? node.querySelector('.mm-source-name').textContent : null,
    offline: Boolean(node.querySelector('.mm-source-offline')),
    rows: [...node.querySelectorAll('.mm-row-title')].map(title => title.textContent),
  })));
  const newTopic = async text => {
    await page.keyboard.press('Home');
    await page.keyboard.press('Tab');
    await page.locator('#input-box').waitFor();
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#input-box'));
  };
  const waitState = (state, timeout = 10000) => page.locator(`.mm-status[data-state="${state}"]`).waitFor({ timeout });
  const back = async () => { await press(page.locator('#mm-back')); await page.locator('.mm-list').waitFor({ state: 'visible' }); };
  const notices = () => page.evaluate(() => window.notices.join(' | '));
  const noticed = (text, timeout = 6000) => page.waitForFunction(want => window.notices.some(message => message.includes(want)), text, { timeout });
  return { press, section, row, openView, sections, newTopic, waitState, back, notices, noticed };
}

const CASES = {
  async 'phone: two services in one list, a 501, a hidden and an offline one'(browser) {
    const world = makeWorld({ servers: [OFFICE, OLD, HIDDEN, DOWN], hidden: ['remote:4'] });
    world.store(LOCAL_BASE).make('Home plan', doc('a'));
    world.store(LOCAL_BASE).make('Shopping', doc('b'));
    world.store(OFFICE_BASE).make('Office roadmap', doc('c'));
    world.store(OFFICE_BASE).make('Team chart', doc('d'));
    world.store('/api/remote-servers/3/mindmaps').control.mode = 'unsupported';
    world.store('/api/remote-servers/4/mindmaps').make('Secret map', doc('e'));
    world.store('/api/remote-servers/5/mindmaps').make('Unreachable map', doc('f'));
    world.store(OFFICE_BASE).control.listDelayMs = 2500; // a slow service
    const { context, page } = await openPage(browser, world, { touch: true });
    const t = tools(page, true);
    await t.openView();

    // The local rows are there while the slow service is still loading, under their own header.
    await t.row('local', 'Home plan').waitFor({ timeout: 2000 });
    let shown = await t.sections();
    const office = shown.find(item => item.key === 'remote:2');
    check(office && office.rows.length === 0 && /Loading/.test(await t.section('remote:2').textContent()), `the slow service is still loading while this machine is listed: ${JSON.stringify(shown)}`);
    await t.row('remote:2', 'Office roadmap').waitFor({ timeout: 6000 });
    shown = await t.sections();
    check(JSON.stringify(shown.map(item => item.key)) === JSON.stringify(['local', 'remote:2', 'remote:5']), `order: this machine, then the task list order; the 501 one and the hidden one are left out: ${JSON.stringify(shown.map(item => item.key))}`);
    check(shown[0].header === 'This machine' && shown[1].header === 'Office Mac' && shown[2].header === 'Down box', `each service has a header: ${JSON.stringify(shown.map(item => item.header))}`);
    check(!shown[0].offline && !shown[1].offline && shown[2].offline, 'only the offline service says Offline');
    check(shown[2].rows.length === 0 && !/Unreachable map/.test(await page.locator('.mm-rows').textContent()), 'the offline service shows no rows');
    check(JSON.stringify(shown[0].rows) === JSON.stringify(['Shopping', 'Home plan']) && JSON.stringify(shown[1].rows) === JSON.stringify(['Team chart', 'Office roadmap']), `each section has its own maps: ${JSON.stringify(shown)}`);
    check(!/Secret map|Old box|Hidden box/.test(await page.locator('#h5-mindmap').textContent()), 'nothing of the hidden device or the too-old service is shown');
    check(world.requests('/api/remote-servers/4/mindmaps').length === 0, 'the hidden device\'s maps are not even read');
    check(world.requests('/api/remote-servers/5/mindmaps').length === 0, 'a service the page knows is offline is not asked');
    check(await page.locator('.mm-row[data-ref]').evaluateAll(nodes => nodes.every(node => node.dataset.ref === `${node.dataset.source}|${node.dataset.id}`)), 'each row is keyed by its service and id');
    // "Create on": this machine and the online service that answered, not the offline, the too-old or the hidden one.
    const options = await page.locator('#mm-create-on option').evaluateAll(nodes => nodes.map(node => node.value));
    check(JSON.stringify(options) === JSON.stringify(['local', 'remote:2']), `Create on offers the services that can take a map: ${options}`);
    check(await page.locator('#mm-create-on').inputValue() === 'local', 'Create on starts on this machine');
    const width = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: document.getElementById('h5-mindmap').scrollWidth, inner: window.innerWidth }));
    check(width.page <= width.inner && width.view <= width.inner, `nothing scrolls sideways at 390px: ${JSON.stringify(width)}`);
    if (SHOT_DIR) { fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(SHOT_DIR, 'mindmap-share-list-390.png') }); }

    // Shown again in "Show in task list": its maps appear in the same list, in its place.
    world.hidden = [];
    await page.evaluate(() => window.H5UI.actions.enginesChanged());
    await t.row('remote:4', 'Secret map').waitFor({ timeout: 5000 });
    check(JSON.stringify((await t.sections()).map(item => item.key)) === JSON.stringify(['local', 'remote:2', 'remote:4', 'remote:5']), 'a device shown again takes its place in the order');
    // And hidden again: gone at once.
    world.hidden = ['remote:4'];
    await page.evaluate(() => window.H5UI.actions.enginesChanged());
    await t.section('remote:4').waitFor({ state: 'detached', timeout: 5000 });
    await context.close();
  },

  async 'computer: this machine alone has no header, and a 501 service alone changes nothing'(browser) {
    for (const servers of [[], [OLD]]) {
      const world = makeWorld({ servers });
      if (servers.length) world.store('/api/remote-servers/3/mindmaps').control.mode = 'unsupported';
      world.store(LOCAL_BASE).make('Only map', doc('a'));
      const { context, page } = await openPage(browser, world);
      const t = tools(page, false);
      await t.openView();
      await t.row('local', 'Only map').waitFor();
      if (servers.length) { await until(() => world.requests('/api/remote-servers/3/mindmaps').length > 0); await page.waitForTimeout(200); } // the 501 answer has arrived
      check(await page.locator('.mm-source').count() === 0, `no service header (${servers.length ? 'with a too-old service' : 'alone'})`);
      check(await page.locator('.mm-on').isHidden(), 'no Create on choice');
      check(await page.locator('.mm-section').count() === 1, 'one section');
      await context.close();
      // Empty, it says what it always said.
      const empty = makeWorld({ servers });
      if (servers.length) empty.store('/api/remote-servers/3/mindmaps').control.mode = 'unsupported';
      const second = await openPage(browser, empty);
      await tools(second.page, false).openView();
      await second.page.locator('.mm-note', { hasText: 'No mind maps yet. Create one or import a .xmind file.' }).waitFor();
      await second.context.close();
    }
  },

  async 'computer: a remote map opens, saves, is renamed and deleted on its own service'(browser) {
    const world = makeWorld({ servers: [OFFICE] });
    world.store(LOCAL_BASE).make('Local twin', doc('local child'), SHARED_ID);
    world.store(OFFICE_BASE).make('Remote one', doc('remote child'));
    world.store(OFFICE_BASE).make('Remote two', doc('x'));
    const { context, page } = await openPage(browser, world);
    const t = tools(page, false);
    await t.openView();
    await t.press(t.row('remote:2', 'Remote one').locator('.mm-row-open'));
    await page.locator('.me-tpc', { hasText: 'remote child' }).waitFor();
    const localBefore = world.requests(LOCAL_BASE).length;
    await t.newTopic('Edited remotely');
    await t.waitState('saved');
    const remote = [...world.store(OFFICE_BASE).maps.values()].find(map => map.title === 'Remote one');
    check(JSON.stringify(remote.data).includes('Edited remotely'), 'the edit reached the remote service');
    check(world.requests(OFFICE_BASE, 'PUT').length >= 1 && world.requests(OFFICE_BASE, 'PUT').every(entry => entry.pathname === `${OFFICE_BASE}/${remote.id}`), 'the save went to the remote base');
    check(world.requests(LOCAL_BASE).slice(localBefore).length === 0 && !JSON.stringify(world.store(LOCAL_BASE).maps.get(SHARED_ID).data).includes('Edited remotely'), 'nothing went to this machine');
    await t.back();

    // Rename and delete use the row's service.
    await t.press(t.row('remote:2', 'Remote two').locator('[data-part="rename"]'));
    await page.locator('.mm-dialog input').fill('Remote renamed');
    await page.keyboard.press('Enter');
    await t.row('remote:2', 'Remote renamed').waitFor();
    check(world.requests(OFFICE_BASE, 'PUT').some(entry => entry.body.title === 'Remote renamed') && !world.requests(LOCAL_BASE, 'PUT').length, 'the rename went to the remote base');
    await t.press(t.row('local', 'Local twin').locator('[data-part="rename"]'));
    await page.locator('.mm-dialog input').fill('Local renamed');
    await page.keyboard.press('Enter');
    await t.row('local', 'Local renamed').waitFor();
    check(world.requests(LOCAL_BASE, 'PUT').length === 1 && world.store(OFFICE_BASE).maps.size === 2, 'a local rename went to this machine');
    await t.press(t.row('remote:2', 'Remote renamed').locator('[data-part="delete"]'));
    await page.locator('.mm-dialog .mm-btn-danger').click();
    await t.row('remote:2', 'Remote renamed').waitFor({ state: 'detached' });
    check(world.store(OFFICE_BASE).maps.size === 1 && world.store(LOCAL_BASE).maps.size === 1 && world.requests(OFFICE_BASE, 'DELETE').length === 1 && !world.requests(LOCAL_BASE, 'DELETE').length, 'the delete went to the remote base only');
    await context.close();
  },

  async 'computer: create and import on a chosen service'(browser) {
    const world = makeWorld({ servers: [OFFICE] });
    const { context, page } = await openPage(browser, world);
    const t = tools(page, false);
    await t.openView();
    await page.locator('#mm-create-on').waitFor({ state: 'visible' });
    check((await page.locator('.mm-on').textContent()).includes('Create on'), 'the choice says Create on');
    // The default is this machine.
    await page.locator('#mm-new').click();
    await page.locator('.me-tpc').first().waitFor();
    check(world.requests(LOCAL_BASE, 'POST').length === 1 && !world.requests(OFFICE_BASE, 'POST').length, 'a new map goes to this machine by default');
    await t.back();
    await page.locator('#mm-create-on').selectOption('remote:2');
    await page.locator('#mm-new').click();
    await page.locator('.me-tpc').first().waitFor();
    check(world.requests(OFFICE_BASE, 'POST').length === 1 && world.requests(LOCAL_BASE, 'POST').length === 1, 'with Office Mac chosen the map is created there');
    await t.newTopic('Made remotely');
    await t.waitState('saved');
    const made = [...world.store(OFFICE_BASE).maps.values()][0];
    check(JSON.stringify(made.data).includes('Made remotely'), 'its edits save on that service');
    await t.back();
    await t.section('remote:2').locator('.mm-row').first().waitFor();
    // Import follows the same choice (the file is built with the page's own converter by an export first).
    const { zipSync, strToU8 } = await import('fflate');
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mindmap-share-'));
    try {
      const file = path.join(dir, 'Imported here.xmind');
      fs.writeFileSync(file, zipSync({ 'content.json': strToU8(JSON.stringify([{ id: 's', class: 'sheet', title: 'Sheet', rootTopic: { id: 'r', class: 'topic', title: 'Imported root' } }])), 'metadata.json': strToU8('{}'), 'manifest.json': strToU8('{}') }));
      await page.locator('#mm-import').click(); // picks the target; the chooser itself is fed below
      await page.locator('.mm-file').setInputFiles(file);
      await page.locator('.me-tpc', { hasText: 'Imported root' }).waitFor();
      check(world.requests(OFFICE_BASE, 'POST').length === 2 && world.requests(LOCAL_BASE, 'POST').length === 1, 'the import went to the chosen service');
      check(world.requests(OFFICE_BASE, 'GET').some(entry => entry.pathname.endsWith([...world.store(OFFICE_BASE).maps.values()].at(-1).id)), 'and the imported map was opened there');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    await context.close();
  },

  async 'computer: a conflict on a remote map, and its new copy stays on that service'(browser) {
    const world = makeWorld({ servers: [OFFICE] });
    const map = world.store(OFFICE_BASE).make('Contested', doc('A'));
    const { context, page } = await openPage(browser, world);
    const t = tools(page, false);
    await t.openView();
    await t.press(t.row('remote:2', 'Contested').locator('.mm-row-open'));
    await page.locator('.me-tpc', { hasText: 'A' }).first().waitFor();
    world.store(OFFICE_BASE).control.conflictNext = true;
    await t.newTopic('Mine');
    await page.locator('.mm-dialog', { hasText: 'changed elsewhere' }).waitFor({ timeout: 8000 });
    check(await page.locator('.mm-status[data-state="conflict"]').count() === 1, 'the status shows the conflict');
    check(world.requests(OFFICE_BASE, 'GET').some(entry => entry.pathname === `${OFFICE_BASE}/${map.id}`), 'the check after the 409 read the remote map');
    check(!JSON.stringify(world.store(OFFICE_BASE).maps.get(map.id).data).includes('Mine'), 'the remote map was not overwritten');
    await page.locator('.mm-dialog .mm-btn-primary').click(); // Save as a new copy
    await page.waitForFunction(() => /copy/.test(document.querySelector('.mm-title').value));
    check(world.store(OFFICE_BASE).maps.size === 2 && world.store(LOCAL_BASE).maps.size === 0, 'the copy was made on the same service');
    check(JSON.stringify([...world.store(OFFICE_BASE).maps.values()][1].data).includes('Mine'), 'the copy has the edits');
    await t.newTopic('On the copy');
    await t.waitState('saved');
    check(!world.requests(LOCAL_BASE, 'PUT').length && JSON.stringify([...world.store(OFFICE_BASE).maps.values()][1].data).includes('On the copy'), 'the copy keeps saving on that service');
    await context.close();
  },

  async 'computer: offline while editing, a draft per service, and back again'(browser) {
    const world = makeWorld({ servers: [OFFICE] });
    world.store(LOCAL_BASE).make('Twin', doc('local only'), SHARED_ID);
    world.store(OFFICE_BASE).make('Twin', doc('remote only'), SHARED_ID);
    const { context, page } = await openPage(browser, world);
    const t = tools(page, false);
    await t.openView();
    await t.press(t.row('remote:2', 'Twin').locator('.mm-row-open'));
    await page.locator('.me-tpc', { hasText: 'remote only' }).waitFor();
    // The service goes away: the save retries and the edit is kept as a draft of THAT service's map.
    world.store(OFFICE_BASE).control.mode = 'offline';
    await t.newTopic('Typed while away');
    await t.waitState('retrying', 8000);
    check(/retrying/.test(await page.locator('.mm-status').textContent()), 'the status says it is retrying');
    const keys = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('h5-mindmap-draft:')));
    check(JSON.stringify(keys) === JSON.stringify([`h5-mindmap-draft:remote:2|${SHARED_ID}`]), `the draft is kept under the remote service's key only: ${keys}`);
    const draft = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), `h5-mindmap-draft:remote:2|${SHARED_ID}`);
    check(draft.source === 'remote:2' && draft.id === SHARED_ID, 'the draft says which service and map it is for');
    check(await page.evaluate(() => Object.keys(sessionStorage).filter(key => /mindmap/i.test(key)).length === 0), 'nothing of the maps is kept in sessionStorage');
    await page.locator('#mm-back').click(); // waits up to 3 s for the save, then leaves
    await t.noticed('Not saved yet');
    await page.locator('.mm-list').waitFor({ state: 'visible' });
    await t.section('remote:2').locator('.mm-source-offline').waitFor({ timeout: 5000 });
    check(await t.row('local', 'Twin').count() === 1, 'this machine\'s list is still there');

    // The local map with the same id and title: the remote draft is not applied to it.
    await t.press(t.row('local', 'Twin').locator('.mm-row-open'));
    await page.locator('.me-tpc', { hasText: 'local only' }).waitFor();
    await page.waitForTimeout(1300);
    check(!(await page.locator('.mm-canvas').textContent()).includes('Typed while away'), 'the local twin does not get the remote draft');
    check(await page.locator('.mm-dialog').count() === 0 && !/restored/.test(await t.notices()), `no restore message or draft dialog on the local twin: ${await t.notices()}`);
    check(!world.requests(LOCAL_BASE, 'PUT').length, 'opening the local twin saved nothing');
    await t.back();

    // Opening the remote map while it is offline names the service. The view is opened again with the service back, so its row is there first.
    world.store(OFFICE_BASE).control.mode = 'ok';
    await page.locator('#mm-close').click();
    await page.locator('#h5-mindmap').waitFor({ state: 'hidden' });
    await t.openView();
    await t.row('remote:2', 'Twin').waitFor({ timeout: 5000 });
    world.store(OFFICE_BASE).control.mode = 'offline';
    await t.press(t.row('remote:2', 'Twin').locator('.mm-row-open'));
    await t.noticed('This service is offline: Office Mac');
    await t.section('remote:2').locator('.mm-source-offline').waitFor({ timeout: 5000 });
    check(await page.locator('.mm-editor').isHidden(), 'the editor did not open');

    // Back online: opening restores the remote draft, and it saves on that service.
    world.store(OFFICE_BASE).control.mode = 'ok';
    await page.locator('#mm-close').click();
    await page.locator('#h5-mindmap').waitFor({ state: 'hidden' });
    await t.openView();
    await t.press(t.row('remote:2', 'Twin').locator('.mm-row-open'));
    await page.locator('.me-tpc', { hasText: 'Typed while away' }).waitFor({ timeout: 8000 });
    await t.noticed('Unsaved changes from this device were restored');
    await t.waitState('saved', 15000);
    check(JSON.stringify(world.store(OFFICE_BASE).maps.get(SHARED_ID).data).includes('Typed while away'), 'the remote draft was saved on the remote service');
    check(!JSON.stringify(world.store(LOCAL_BASE).maps.get(SHARED_ID).data).includes('Typed while away'), 'and never on this machine');
    check(await page.evaluate(id => localStorage.getItem(`h5-mindmap-draft:remote:2|${id}`), SHARED_ID) === null, 'the draft is gone after the save');
    await context.close();
  },

  async 'computer: a save that fails while the service is away goes through when it is back, without a new edit'(browser) {
    const world = makeWorld({ servers: [OFFICE] });
    world.store(OFFICE_BASE).make('Patient', doc('start'));
    const { context, page } = await openPage(browser, world);
    const t = tools(page, false);
    await t.openView();
    await t.press(t.row('remote:2', 'Patient').locator('.mm-row-open'));
    await page.locator('.me-tpc', { hasText: 'start' }).waitFor();
    world.store(OFFICE_BASE).control.mode = 'offline';
    await t.newTopic('Waiting');
    await t.waitState('retrying', 8000);
    world.store(OFFICE_BASE).control.mode = 'ok';
    await t.waitState('saved', 20000);
    check(JSON.stringify([...world.store(OFFICE_BASE).maps.values()][0].data).includes('Waiting'), 'the retry saved on the remote service');
    check(!world.requests(LOCAL_BASE, 'PUT').length, 'no save went to this machine');
    // The view open and dirty is what holds a silent update reload; the editor and the back gesture are unchanged.
    await page.waitForFunction(() => history.state && history.state.h5Layer >= 2);
    await page.goBack();
    await page.locator('.mm-list').waitFor({ state: 'visible' });
    await page.goBack();
    await page.locator('#h5-mindmap').waitFor({ state: 'hidden' });
    await context.close();
  },
};

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const [name, run] of Object.entries(CASES)) {
      if (process.env.MINDMAP_ONLY && !name.includes(process.env.MINDMAP_ONLY)) continue;
      currentCase = name;
      console.log(`case: ${name}`);
      await run(browser);
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(failures, [], 'all checks pass');
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log('Mind maps across services passed.');
})().catch(error => { console.error(error); console.error(failures); process.exit(1); });
