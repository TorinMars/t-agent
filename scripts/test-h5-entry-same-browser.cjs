// The same page from any engine ("The same page from any engine" in docs/design/entry-symmetry.md), in real Chromium: the person's three engines T01,
// K01 and M05 are linked; the page of T01 (K01 is its remote:7, M05 its remote:9) and the page of K01 (T01 is its remote:3, M05 its remote:4) are opened
// side by side on a phone (390x844), with mirrored mocks: each serves its own engine under /api and the others through /api/remote-servers/<its row id>,
// and both share one page state (the real merge rules, services/page-state-merge.js). What each page shows is read and compared:
// - the task list (engine tags and titles, a task not in the shared order yet included), "Create on" with its default and its helper line, before and
//   after a task is made on M05 from the page of T01 ("the machine you chose last time", the same on K01's page);
// - Settings: the tab row (labels; "This device" under the page's own engine is the one note that differs), "Show in task list", the device list (the
//   small "This machine" hint is the only difference), the Environment table's columns;
// - the mind map list (one list by last edit, each row with its engine tag);
// - T-Attention: the engine a new task goes to and the "on" choices;
// - "Visible to" of a task of the page's own engine: its linked machines by name.
// ENTRY_SHOTS=<dir> saves 390px screenshots of both pages' task list, Settings → Devices and mind map list (entry-<engine>-<part>.png).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const merge = require('../services/page-state-merge');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const { openGroup, backToList } = require('./settings-test-helper.cjs');
const { settled } = require('./browser-test-wait.cjs');

const root = path.resolve(__dirname, '..');
const SHOTS = process.env.ENTRY_SHOTS || '';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const T = '11111111-1111-4111-8111-111111111111';
const K = '22222222-2222-4222-8222-222222222222';
const M = '33333333-3333-4333-8333-333333333333';
const ago = minutes => new Date(Date.parse('2026-11-20T12:00:00Z') - minutes * 60000).toISOString();
const GROUPS = [{ key: 'doing', name: 'In progress', sort_order: 1 }];
const tool = (id, name, value) => ({ id, name, status: 'ok', value });
const report = git => ({ checked_at: 1, platform: 'darwin', tools: [tool('node', 'Node.js', 'v24.22.0'), tool('git', 'git', git), tool('shell', 'Shell', 'zsh')] });
const item = (id, title, status, order) => ({ id, title, status, priority: 'none', parent_id: null, sort_order: order, source: 'user', created_at: ago(90), updated_at: ago(80) });

// The three engines: each one's own data, the same whichever page reads it.
const ENGINES = {
  [T]: { name: 'T01', tasks: [{ id: 1, title: 'SELF-TAGENT', status: 'doing' }, { id: 2, title: 'Notes', status: 'doing' }], maps: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Release plan', updated_at: ago(120), size: 2048, revision: 1 }], items: [item(1, 'Review the plan', 'todo', 10)], git: '2.50.1' },
  [K]: { name: 'K01', tasks: [{ id: 5, title: 'Welcome speed', status: 'doing' }, { id: 6, title: 'SELF-ONCALL', status: 'doing' }], maps: [{ id: 'bbbbbbbb-0000-4000-8000-000000000001', title: 'Oncall flow', updated_at: ago(1440), size: 1024, revision: 1 }], items: [item(1, 'Answer the oncall', 'todo', 10)], git: '2.39.5' },
  [M]: { name: 'M05', tasks: [{ id: 8, title: 'Docs site', status: 'doing' }], maps: [{ id: 'cccccccc-0000-4000-8000-000000000001', title: 'Ideas', updated_at: ago(30), size: 512, revision: 1 }], items: [], git: '2.50.1' },
};
// The shared task order: M05's task is not in it yet (it comes first, in the one order of devices).
let ORDER = [`${T}:1`, `${K}:5`, `${K}:6`, `${T}:2`];
// Each page: its own engine, and the row id it gave each other engine.
const PAGES = {
  T01: { own: T, origin: 'http://t01.test', rows: { 7: K, 9: M } },
  K01: { own: K, origin: 'http://k01.test', rows: { 3: T, 4: M } },
};
const CAPS = ['tasks:archive', 'terminals:order', 'attention:remote', 'settings:device', 'environment:tools'];

// One shared page state for both pages (two engines kept in step by their sync; here one in memory through the real merge rules).
let shared = { recent: {}, keys: {} };
let version = 1;
const live = [];
const view = own => ({ instance_id: own, version, ...merge.pageView(shared), peers: [] });
const STREAM = '/api/tasks/terminal-activity/stream';
function pushAll() {
  setTimeout(() => {
    for (const { page, own } of live) page.evaluate(([url, text]) => window.activityStream.send(url, 'page-state', text), [STREAM, JSON.stringify(view(own))]).catch(() => {});
  }, 50);
}
const posts = [];

function serve(name, route) {
  const { own, rows } = PAGES[name];
  const request = route.request();
  const url = new URL(request.url());
  const p = url.pathname;
  const method = request.method();
  const body = request.postData() ? JSON.parse(request.postData()) : undefined;
  const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
  if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
  const others = Object.entries(rows).map(([id, instance]) => ({ id: Number(id), instance, name: ENGINES[instance].name }));
  if (p === '/api/page-state' && method === 'GET') return json(view(own));
  if (p === '/api/page-state' && method === 'PUT') {
    shared = merge.merge(shared, merge.changeState(body, { at: Date.now() + version, by: own }), Date.now()).state;
    version += 1;
    pushAll();
    return json(view(own));
  }
  if (p === '/api/system/version') return json({ engine_name: ENGINES[own].name, instance_id: own, app_version: '2.144.0', boot_id: 'b1' });
  if (p === '/api/system/engine-name') return json({ name: ENGINES[own].name, default_name: ENGINES[own].name.toLowerCase(), custom: true });
  if (p === '/api/remote-servers') return json(others.map(row => ({ id: row.id, name: row.name, status: 'online', enabled: true, instance_id: row.instance, base_url: `tunnel://l${row.id}`, remote_version: '2.144.0', can_rename: true, name_source: 'engine' })));
  if (p === '/api/service-links') return json({ supported: true, links: others.map(row => ({ id: `L${row.id}`, name: row.name, state: 'online', online: true, remote_server_id: row.id })) });
  if (p === '/api/device-settings/devices') return json({ devices: others.map(row => ({ id: row.id, name: row.name, online: true, supported: true, company_computer: false, environment: true })) });
  if (p === '/api/settings-sync') return json({ supported: true, scopes: {}, keys: [], peers: others.map(row => ({ name: row.name, online: true, supported: true, last_sync_at: ago(1), last_error: null })) });
  if (p === '/api/device-tier') return json({ company_computer: false });
  if (p === '/api/task-list/hidden-devices') return json({ hidden: [] });
  if (p === '/api/task-order' && method === 'GET') return json({ order: ORDER, updated_at: 1 });
  // This engine's linked machines, by the names it gives them: oldest link first, as the server answers.
  if (/^\/api\/tasks\/\d+\/visibility$/.test(p)) return json({ devices: others.map(row => ({ link_id: `L${row.id}`, name: row.name, online: true, allowed: true })) });
  // The engine a path is about: this page's own, or the one behind a remote row.
  const remote = p.match(/^\/api\/remote-servers\/(\d+)(\/.*)$/);
  const engine = remote ? rows[remote[1]] : own;
  const rest = remote ? remote[2] : p.replace(/^\/api/, '');
  if (!engine) return json({ error: 'not mocked' }, 404);
  const data = ENGINES[engine];
  if (remote && rest === '/info') return json({ capabilities: CAPS });
  if (rest === '/tasks' && method === 'GET') return json(data.tasks.map(task => ({ ...task, work_dir: `/w/${task.id}`, archived_at: null })));
  if (rest === '/tasks' && method === 'POST') {
    const task = { id: 90 + posts.length, title: body.title, status: 'doing' };
    posts.push({ name, engine, body });
    data.tasks.push(task);
    return json({ ...task, work_dir: `/w/${task.id}`, archived_at: null }, 201);
  }
  if (rest === '/task-groups') return json(GROUPS);
  if (/^\/tasks\/\d+\/terminals$/.test(rest)) return json([]);
  if (/terminal-activity$|terminal-subagents$/.test(rest)) return json({});
  if (rest === '/mindmaps' && method === 'GET') return json({ maps: data.maps });
  if (rest.startsWith('/attention')) {
    if (rest === '/attention' && method === 'GET') return json({ items: data.items, host: data.name.toLowerCase(), instance_id: engine });
    return json({ error: 'not mocked' }, 404);
  }
  if (p === '/api/environment/tools') return json(report(data.git));
  const env = p.match(/^\/api\/device-settings\/(\d+)\/environment\/tools$/);
  if (env && rows[env[1]]) return json(report(ENGINES[rows[env[1]]].git));
  if (p === '/auth/me') return json({ work_dir: null, effective_work_dir: '/home/t/tasks', access_mode: 'remote', authenticator_bound: true, listen_host: '0.0.0.0' });
  return json({ error: 'not mocked' }, 404);
}

async function openPage(browser, name) {
  const { origin, own } = PAGES[name];
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: SHOTS ? 2 : 1, colorScheme: 'dark' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(activityStreamMock);
  await page.addInitScript(() => {
    window.WebSocket = class { constructor(url) { this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); } send() {} close() { this.readyState = 3; } };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    window.EventSource = class extends EventTarget {
      constructor(url) { super(); this.url = url; this.readyState = 0; setTimeout(() => { if (this.readyState !== 2) { this.readyState = 1; this.dispatchEvent(new Event('open')); } }, 0); }
      close() { this.readyState = 2; }
    };
  });
  await page.route(`${origin}/**`, route => serve(name, route));
  await page.goto(`${origin}/h5`);
  await page.waitForFunction(() => (window.H5UI.get().taskList.tasks || []).length === 5 && window.H5UI.get().taskList.tasks.every(task => task.device), null, { timeout: 15000 });
  live.push({ page, own });
  return { context, page, errors, name };
}
const shot = async (page, file) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, file) }); } };
async function until(check, label, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label} (${JSON.stringify(await check())})`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// ── What a page shows ──
const taskList = page => page.evaluate(() => [...document.querySelectorAll('#h5-task-list .h5-task')].map(row => `${row.querySelector('.h5-device-tag').textContent} ${row.querySelector('.h5-task-title').textContent}`));
async function openSheet(page) {
  if (await page.locator('#h5-tasks').isVisible().catch(() => false)) return;
  await page.locator('#h5-open-tasks').tap();
  await page.locator('#h5-tasks').waitFor({ state: 'visible' });
}
async function closeSheet(page) {
  if (await page.locator('#h5-tasks').isVisible().catch(() => false)) { await page.locator('#h5-close-tasks').tap(); await page.locator('#h5-tasks').waitFor({ state: 'hidden' }); }
}
async function createOn(page) {
  await openSheet(page);
  await page.locator('#h5-add-task').tap();
  await page.locator('#h5-new-task-on').waitFor();
  const shown = await page.evaluate(() => {
    const select = document.getElementById('h5-new-task-on');
    return { options: [...select.options].map(option => option.textContent), picked: select.options[select.selectedIndex].textContent, help: (document.getElementById('h5-new-task-on-help') || {}).textContent || '' };
  });
  return shown;
}
async function closeNewTask(page) {
  await page.locator('#h5-new-task-cancel').tap();
  await page.locator('#h5-new-task-dialog').waitFor({ state: 'detached' });
}
async function settingsView(page, name) {
  await closeSheet(page);
  await page.evaluate(() => window.H5UI.actions.openSettings());
  await page.locator('#h5-settings').waitFor({ state: 'visible' });
  await page.locator('#h5-settings-tabs [role="tab"]').first().waitFor();
  await settled(page);
  const tabs = await page.locator('#h5-settings-tabs [role="tab"]').evaluateAll(nodes => nodes.map(node => ({ label: node.querySelector('.h5-settings-tab-name').textContent, note: (node.querySelector('.h5-settings-tab-note') || {}).textContent || '' })));
  // Shared: "Show in task list" and the Environment table.
  await openGroup(page, 'devices');
  await page.waitForFunction(() => document.querySelectorAll('#h5-env-table thead th').length > 1 && !document.querySelector('#h5-env-check[disabled]'), null, { timeout: 10000 });
  const shown = await page.locator('#h5-shown-devices .h5-engine-name').allTextContents();
  const environment = await page.locator('#h5-env-table thead th').allInnerTexts();
  // This device's tab: the device list.
  await backToList(page);
  const tab = page.locator('#h5-settings-tab-local');
  await tab.scrollIntoViewIfNeeded();
  await tab.tap();
  await page.waitForFunction(() => document.getElementById('h5-settings-tab-local').getAttribute('aria-selected') === 'true');
  await openGroup(page, 'devices');
  await page.locator('#h5-engine-list .h5-engine-name').nth(2).waitFor();
  const devices = await page.locator('#h5-engine-list .h5-engine-name').allTextContents();
  const hints = await page.locator('#h5-engine-list .h5-engine-hint').allTextContents();
  await page.locator('#h5-engine-list').scrollIntoViewIfNeeded();
  await shot(page, `entry-${name}-devices.png`);
  await page.evaluate(() => window.H5UI.set({ settingsOpen: false }));
  await page.locator('#h5-settings').waitFor({ state: 'hidden' });
  return { tabs, shown, environment: environment.map(text => text.split('\n')[0].trim()), devices, hints };
}
async function mindMaps(page, name) {
  await closeSheet(page);
  await page.locator('#h5-bnav-maps').tap();
  await page.locator('.mm-row').nth(2).waitFor({ timeout: 10000 });
  const rows = await page.evaluate(() => [...document.querySelectorAll('.mm-row')].map(row => `${row.querySelector('.mm-row-tag').textContent} ${row.querySelector('.mm-row-title').textContent} (${row.querySelector('.mm-row-meta').textContent})`));
  const lines = await page.locator('.mm-source').count();
  await shot(page, `entry-${name}-mindmaps.png`);
  await page.locator('#mm-close').tap();
  await page.locator('#h5-mindmap').waitFor({ state: 'hidden' });
  return { rows, lines };
}
async function attention(page) {
  await closeSheet(page);
  await page.locator('#h5-attention').tap();
  await page.locator('#h5-attention-add-on').waitFor({ timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('#h5-attention-add-on option').length === 3, null, { timeout: 10000 });
  const shown = await page.evaluate(() => { const select = document.getElementById('h5-attention-add-on'); return { options: [...select.options].map(option => option.textContent), picked: select.options[select.selectedIndex].textContent }; });
  await page.locator('#h5-bnav-sessions').tap();
  return shown;
}
async function visibleTo(page, title) {
  await openSheet(page);
  const row = page.locator('#h5-task-list .h5-task[data-source="local"]').filter({ hasText: title });
  await row.locator('.h5-task-more').tap();
  await page.locator('#h5-session-menu-actions [role="menuitem"]', { hasText: 'Visible to' }).tap();
  await page.locator('.h5-visibility-row').nth(1).waitFor();
  const names = await page.locator('.h5-visibility-name').allTextContents();
  const menuTitle = await page.locator('#h5-task-dialog-title').textContent();
  await page.locator('#h5-task-dialog-cancel').tap();
  await page.locator('#h5-task-dialog [role="dialog"]').waitFor({ state: 'hidden' });
  return { names, menuTitle };
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const a = await openPage(browser, 'T01');
    const b = await openPage(browser, 'K01');
    const both = async run => [await run(a), await run(b)];

    // ── The task list: the same rows in the same order; the task not in the shared order yet comes first, the devices by name ──
    const [listA, listB] = await both(page => taskList(page.page));
    assert.deepEqual(listA, listB, 'the same task list on both pages');
    assert.equal(listA.length, 5);
    assert.match(listA[0], /^M05 /, 'the task not in the shared order comes first, wherever M05 is in the device list of the page');
    await shot(a.page, 'entry-T01-tasks.png');
    await shot(b.page, 'entry-K01-tasks.png');

    // ── "Create on": nothing chosen yet, both start on the first machine by name, never the page's own engine ──
    const [onA, onB] = await both(page => createOn(page.page));
    assert.deepEqual(onA, onB, 'the same Create on on both pages');
    assert.deepEqual(onA.options, ['K01', 'M05', 'T01'], 'the machines by name, no "This machine" label');
    assert.equal(onA.picked, 'K01', 'nothing chosen yet: the first by name');
    assert.equal(onA.help, '', 'no "chosen last time" line yet');
    await closeNewTask(b.page);

    // A task made on M05 from the page of T01: the next Create on starts there on both pages, and says why.
    await a.page.locator('#h5-new-task-title').fill('Spec review');
    await a.page.locator('#h5-new-task-on').selectOption({ label: 'M05' });
    await a.page.locator('#h5-new-task-create').tap();
    await a.page.locator('#h5-new-task-dialog').waitFor({ state: 'detached' });
    assert.deepEqual(posts.map(post => [post.name, ENGINES[post.engine].name, post.body.title]), [['T01', 'M05', 'Spec review']], 'made on M05, through T01\'s proxy');
    await until(() => merge.pageView(shared).keys['h5-create-on'] === M, 'the machine chosen last in the shared state, by instance id');
    await b.page.waitForFunction(() => localStorage.getItem('h5-create-on') === 'remote:4', null, { timeout: 5000 }); // pushed: M05 is remote:4 on K01's page
    const [againA, againB] = await both(page => createOn(page.page));
    assert.deepEqual(againA, againB, 'the same Create on on both pages after the choice');
    assert.equal(againA.picked, 'M05');
    assert.equal(againA.help, 'The machine you chose last time');
    await closeNewTask(a.page);
    await closeNewTask(b.page);
    // Both lists have the new task, in the same place.
    await b.page.evaluate(() => window.H5UI.actions.enginesChanged());
    await a.page.waitForFunction(() => window.H5UI.get().taskList.tasks.length === 6, null, { timeout: 10000 });
    await b.page.waitForFunction(() => window.H5UI.get().taskList.tasks.length === 6, null, { timeout: 10000 });
    const [newA, newB] = await both(page => taskList(page.page));
    assert.deepEqual(newA, newB, 'the new task is in the same place on both pages');

    // ── "Visible to" of a task of the page's own engine: its linked machines by name ──
    const visA = await visibleTo(a.page, 'SELF-TAGENT');
    const visB = await visibleTo(b.page, 'Welcome speed');
    assert.deepEqual(visA.names, ['K01', 'M05'], 'T01\'s linked machines by name');
    assert.deepEqual(visB.names, ['M05', 'T01'], 'K01\'s linked machines by name (the server answers T01 first)');
    await closeSheet(a.page);
    await closeSheet(b.page);

    // ── T-Attention: a new task goes to the first engine by name until one is chosen ──
    const [attA, attB] = await both(page => attention(page.page));
    assert.deepEqual(attA, attB, 'the same "on" choice on both pages');
    assert.deepEqual(attA.options, ['on K01', 'on M05', 'on T01']);
    assert.equal(attA.picked, 'on K01');

    // ── Settings: tabs, "Show in task list", the device list and the Environment table ──
    const setA = await settingsView(a.page, 'T01');
    const setB = await settingsView(b.page, 'K01');
    assert.deepEqual(setA.tabs.map(tab => tab.label), ['Shared', 'K01', 'M05', 'T01'], 'Shared, then the devices by name');
    assert.deepEqual(setB.tabs.map(tab => tab.label), setA.tabs.map(tab => tab.label), 'the same tab row on both pages');
    assert.deepEqual(setA.tabs.filter(tab => tab.note).map(tab => [tab.label, tab.note]), [['T01', 'This device']], 'T01\'s page: its own tab says "This device"');
    assert.deepEqual(setB.tabs.filter(tab => tab.note).map(tab => [tab.label, tab.note]), [['K01', 'This device']], 'K01\'s page: its own tab says "This device"');
    assert.deepEqual(setA.shown, ['K01', 'M05', 'T01'], '"Show in task list" by name, no hint');
    assert.deepEqual(setB.shown, setA.shown);
    assert.deepEqual(setA.devices, ['K01', 'M05', 'T01'], 'the device list by name');
    assert.deepEqual(setB.devices, setA.devices);
    assert.deepEqual([setA.hints, setB.hints], [['· This machine'], ['· This machine']], 'the one small "This machine" label, on each page\'s own row');
    assert.deepEqual(setA.environment, ['Tool', 'K01', 'M05', 'T01'], 'the Environment table by name');
    assert.deepEqual(setB.environment, setA.environment);

    // ── Mind maps: one list by last edit, each row with its engine tag ──
    const [mapsA, mapsB] = await both(page => mindMaps(page.page, page.name));
    assert.deepEqual(mapsA, mapsB, 'the same mind map list on both pages');
    assert.deepEqual(mapsA.rows.map(row => row.split(' (')[0]), ['M05 Ideas', 'T01 Release plan', 'K01 Oncall flow'], 'the last edited first, each with its engine tag');
    assert.equal(mapsA.lines, 0, 'no line per service: every service answered');

    assert.deepEqual(a.errors, [], 'no page errors on T01\'s page');
    assert.deepEqual(b.errors, [], 'no page errors on K01\'s page');
    await a.context.close();
    await b.context.close();
    console.log('entry-same: ok');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
