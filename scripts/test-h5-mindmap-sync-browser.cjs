// Mind maps on every engine ("Mind maps on every engine" in docs/design/mind-maps.md), in real Chromium with every route mocked here: this engine's
// /api/mindmaps answers with `sync` (it keeps a copy of every map), so the list is this engine's own copy only, each row tagged with the engine it was
// edited on last; a linked engine that keeps the copies too is never read for maps, an older one (`older`) still is, with its own tag; there is no
// "Create on"; a company computer whose home is away says so above the list. An open map that changed on another engine reloads by itself when there
// are no unsaved edits, and offers "Reload the newer version" when there are. At 390px (a touch phone) and 1440px.
// MINDMAP_SHOTS=<dir> saves screenshots (maps-list-*.png, maps-newer-*.png, maps-company-offline-390.png). MINDMAP_ONLY=<text> runs the matching cases.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOT_DIR = process.env.MINDMAP_SHOTS || null;
const SELF = { instance_id: 'engine-t01', name: 'T01' };
const OFFICE = { id: 2, name: 'Office Mac', status: 'online', enabled: true, instance_id: 'engine-office' };
const OLD = { id: 3, name: 'Old box', status: 'online', enabled: true, instance_id: 'engine-old' };
const failures = [];
const pageErrors = [];
let currentCase = '';
const check = (ok, message) => { if (!ok) { failures.push(`${currentCase}: ${message}`); console.log(`  FAILED ${message}`); } };
const doc = (...children) => ({ nodeData: { id: 'r', topic: 'Root', children: children.map((topic, i) => ({ id: `c${i}`, topic, children: [] })) }, arrows: [], summaries: [], direction: 1 });
const ago = minutes => new Date(Date.UTC(2026, 10, 20, 9, 0, 0) - minutes * 60000).toISOString();

function makeWorld({ sync = {} } = {}) {
  let n = 0;
  const world = {
    servers: [OFFICE, OLD], log: [], maps: new Map(), oldMaps: new Map(), putFails: false,
    sync: { enabled: true, company_computer: false, cache_only: false, home_name: null, home_online: null, waiting: 0, engines: [SELF, { instance_id: OFFICE.instance_id, name: OFFICE.name }], older: [OLD.instance_id], ...sync },
  };
  world.make = (store, title, data, by, minutes) => {
    n += 1;
    const map = { id: `7d1f3c2a-0000-4c4c-9a9a-${String(n).padStart(12, '0')}`, title, data, revision: 1, created_at: ago(minutes), updated_at: ago(minutes), by: by.instance_id, by_name: by.name };
    store.set(map.id, map);
    return map;
  };
  // A save on another engine reached this one: the next revision, its content and its engine.
  world.remoteSave = (map, data, by) => { map.revision += 1; map.data = data; map.by = by.instance_id; map.by_name = by.name; map.updated_at = new Date().toISOString(); };
  return world;
}

async function serve(world, route) {
  const request = route.request();
  const { pathname } = new URL(request.url());
  const method = request.method();
  const body = request.postData() ? JSON.parse(request.postData()) : undefined;
  const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
  if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
  const summary = ({ data, ...rest }) => ({ ...rest, size: JSON.stringify(data || {}).length });
  if (pathname.startsWith('/api/mindmaps')) {
    world.log.push(`${method} ${pathname}`);
    const tail = pathname.slice('/api/mindmaps'.length);
    if (!tail && method === 'GET') return json({ maps: [...world.maps.values()].map(summary).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)), sync: world.sync });
    if (!tail && method === 'POST') return json(world.make(world.maps, body.title, body.data || null, SELF, 0), 201);
    const [, id, part] = tail.match(/^\/([^/]+)(?:\/(head))?$/) || [];
    const map = world.maps.get(id);
    if (!map) return json({ error: 'MINDMAP_NOT_FOUND' }, 404);
    if (part === 'head') return json({ id, title: map.title, revision: map.revision, updated_at: map.updated_at, by: map.by, by_name: map.by_name });
    if (method === 'GET') return json(map);
    if (method === 'PUT') {
      if (world.putFails) return json({ error: 'MINDMAP_STORAGE_FAILED' }, 503);
      if (body.revision !== map.revision) return json({ error: 'MINDMAP_CONFLICT', current_revision: map.revision }, 409);
      map.revision += 1;
      if (body.data !== undefined) map.data = body.data;
      if (body.title !== undefined) map.title = body.title;
      map.by = SELF.instance_id;
      map.by_name = SELF.name;
      return json({ id, title: map.title, revision: map.revision, updated_at: map.updated_at });
    }
    return json({ error: 'not mocked' }, 404);
  }
  const remoteMaps = pathname.match(/^\/api\/remote-servers\/(\d+)\/mindmaps/);
  if (remoteMaps) {
    world.log.push(`${method} ${pathname}`);
    if (remoteMaps[1] === '3' && method === 'GET') return json({ maps: [...world.oldMaps.values()].map(summary) });
    return json({ error: 'not mocked' }, 404);
  }
  if (pathname === '/api/remote-servers') return json(world.servers);
  if (pathname === '/api/service-links') return json({ supported: true, links: [] });
  if (pathname === '/api/task-list/hidden-devices') return json({ hidden: [] });
  if (pathname === '/api/system/version') return json({ instance_id: SELF.instance_id, engine_name: SELF.name, name: SELF.name });
  const remote = pathname.match(/^\/api\/remote-servers\/(\d+)\/(.+)$/);
  if (remote) {
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
  const context = await browser.newContext({ viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: touch, hasTouch: touch, deviceScaleFactor: touch ? 3 : 1 });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(`${currentCase}: ${error.message}`));
  await page.addInitScript(() => {
    window.WebSocket = class { constructor(url) { this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); } send() {} close() { this.readyState = 3; } };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
  });
  await page.route(`${ORIGIN}/**`, route => serve(world, route));
  await page.goto(`${ORIGIN}/h5`);
  await page.waitForFunction(() => typeof window.notify === 'function');
  await page.evaluate(() => { const show = window.notify; window.notices = []; window.notify = (message, type) => { window.notices.push(String(message)); return show(message, type); }; });
  const press = locator => (touch ? locator.tap() : locator.click());
  const openView = async () => {
    if (touch && await page.locator('#h5-tasks').isVisible().catch(() => false)) { await page.locator('#h5-close-tasks').tap(); await page.locator('#h5-tasks').waitFor({ state: 'hidden' }); }
    if (touch) await press(page.locator('#h5-bnav-maps')); else await page.evaluate(() => window.H5UI.actions.openMindmaps());
    await page.locator('#mm-new').waitFor();
  };
  const row = title => page.locator('.mm-row').filter({ has: page.locator('.mm-row-title', { hasText: new RegExp(`^${title}$`) }) });
  // What the page asks while a map is open happens every 10 s; coming back to the page asks at once.
  const askNow = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const shot = async name => { if (SHOT_DIR) { fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(SHOT_DIR, name) }); } };
  return { context, page, press, openView, row, askNow, shot };
}

async function listCase(browser, touch) {
  const world = makeWorld();
  world.make(world.maps, 'Roadmap', doc('r'), { instance_id: OFFICE.instance_id, name: OFFICE.name }, 5);
  world.make(world.maps, 'Home plan', doc('h'), SELF, 20);
  world.make(world.maps, 'Trip (conflict from K01)', doc('k'), { instance_id: 'engine-k01', name: 'K01' }, 40);
  world.make(world.oldMaps, 'Old notes', doc('o'), { instance_id: OLD.instance_id, name: OLD.name }, 10);
  const t = await openPage(browser, world, { touch });
  await t.openView();
  await t.row('Old notes').waitFor({ timeout: 6000 });
  const rows = await t.page.evaluate(() => [...document.querySelectorAll('.mm-row')].map(node => {
    const tag = node.querySelector('.mm-row-tag');
    return { title: node.querySelector('.mm-row-title').textContent, source: node.dataset.source, tag: tag ? tag.textContent : null, tip: tag ? tag.title : null };
  }));
  check(JSON.stringify(rows.map(item => item.title)) === JSON.stringify(['Roadmap', 'Old notes', 'Home plan', 'Trip (conflict from K01)']), `one list by last edit: ${JSON.stringify(rows)}`);
  const byTitle = Object.fromEntries(rows.map(item => [item.title, item]));
  check(byTitle.Roadmap.source === 'local' && byTitle.Roadmap.tip === 'Edited on Office Mac', `a map edited on another engine is in this engine's list, tagged where it was edited: ${JSON.stringify(byTitle.Roadmap)}`);
  check(byTitle['Home plan'].tip === 'Edited on T01', 'this engine is named like any other');
  check(byTitle['Old notes'].source === 'remote:3' && byTitle['Old notes'].tip === 'Old box', `an older engine's maps are still read from it, with its tag: ${JSON.stringify(byTitle['Old notes'])}`);
  check(!world.log.some(line => line.includes('/api/remote-servers/2/mindmaps')), 'an engine that keeps a copy is never read for maps');
  check(await t.page.locator('#mm-create-on').isHidden() && await t.page.locator('.mm-on').isHidden(), 'no "Create on": a new map is on every engine');
  check(await t.page.locator('.mm-banner').count() === 0, 'no note on a normal engine');
  const width = await t.page.evaluate(() => ({ page: document.documentElement.scrollWidth, inner: window.innerWidth }));
  check(width.page <= width.inner, `nothing scrolls sideways: ${JSON.stringify(width)}`);
  // A new map goes to this engine's copy.
  await t.press(t.page.locator('#mm-new'));
  await t.page.locator('.mm-editor:not([hidden])').waitFor();
  check(world.log.includes('POST /api/mindmaps'), 'New map is made here');
  await t.press(t.page.locator('#mm-back'));
  await t.page.locator('.mm-list').waitFor({ state: 'visible' });
  await t.row('Roadmap').waitFor();
  await t.shot(`maps-list-${touch ? 390 : 1440}.png`);
  await t.context.close();
}

async function newerCase(browser, touch) {
  const world = makeWorld();
  const map = world.make(world.maps, 'Plan', doc('first'), SELF, 5);
  const t = await openPage(browser, world, { touch });
  await t.openView();
  await t.press(t.row('Plan').locator('.mm-row-open'));
  await t.page.locator('.me-tpc', { hasText: 'first' }).waitFor();

  // No unsaved edits: the newer version from another engine replaces what is shown, with a note.
  world.remoteSave(map, doc('first', 'from the office'), { instance_id: OFFICE.instance_id, name: OFFICE.name });
  await t.askNow();
  await t.page.locator('.me-tpc', { hasText: 'from the office' }).waitFor({ timeout: 5000 });
  await t.page.waitForFunction(() => window.notices.some(text => text === 'Updated to the version saved on Office Mac'), null, { timeout: 5000 });
  check(await t.page.locator('#mm-newer').isHidden(), 'no offer when nothing here was lost');

  // Unsaved edits (the save keeps failing): the offer, with the engine's name; Reload shows the newer version.
  world.putFails = true;
  await t.page.locator('.mm-canvas .map-container').focus();
  if (touch) { await t.page.locator('.me-tpc', { hasText: 'Root' }).tap(); await t.press(t.page.locator('#mm-action-child')); await t.page.locator('#input-box').waitFor(); await t.page.keyboard.type('Mine'); await t.page.keyboard.press('Enter'); }
  else { await t.page.keyboard.press('Home'); await t.page.keyboard.press('Tab'); await t.page.locator('#input-box').waitFor(); await t.page.keyboard.type('Mine'); await t.page.keyboard.press('Enter'); }
  await t.page.waitForFunction(() => !document.querySelector('#input-box'));
  await t.page.locator('.mm-status[data-state="retrying"]').waitFor({ timeout: 8000 });
  world.remoteSave(map, doc('first', 'from the office', 'and K01'), { instance_id: 'engine-k01', name: 'K01' });
  await t.askNow();
  await t.page.locator('#mm-newer').waitFor({ state: 'visible', timeout: 5000 });
  check((await t.page.locator('#mm-newer').textContent()).includes('A newer version was saved on K01.'), 'the offer names the engine');
  check(await t.page.locator('.me-tpc', { hasText: 'Mine' }).count() === 1, 'the edits here stay until the person chooses');
  const button = await t.page.locator('#mm-newer-reload').boundingBox();
  check(button && button.height >= 44, `the button is a 44px target: ${JSON.stringify(button)}`);
  const width = await t.page.evaluate(() => ({ page: document.documentElement.scrollWidth, inner: window.innerWidth }));
  check(width.page <= width.inner, `nothing scrolls sideways: ${JSON.stringify(width)}`);
  await t.shot(`maps-newer-${touch ? 390 : 1440}.png`);
  world.putFails = false;
  await t.press(t.page.locator('#mm-newer-reload'));
  await t.page.locator('.me-tpc', { hasText: 'and K01' }).waitFor({ timeout: 5000 });
  check(await t.page.locator('#mm-newer').isHidden(), 'the offer is gone after the reload');
  check(await t.page.locator('.me-tpc', { hasText: 'Mine' }).count() === 0, 'the newer version is shown');
  await t.context.close();
}

const CASES = {
  'phone: the list is this engine\'s copy, tagged by where each map was edited': browser => listCase(browser, true),
  'computer: the list is this engine\'s copy, tagged by where each map was edited': browser => listCase(browser, false),
  'phone: an open map gets a newer version': browser => newerCase(browser, true),
  'computer: an open map gets a newer version': browser => newerCase(browser, false),
  async 'phone: a company computer whose home is away says so above its cache'(browser) {
    const world = makeWorld({ sync: { company_computer: true, cache_only: true, home_name: 'T01', home_online: false, waiting: 2, engines: [{ instance_id: 'engine-k01', name: 'K01' }], older: [] } });
    world.make(world.maps, 'Opened here', doc('x'), { instance_id: 'engine-k01', name: 'K01' }, 5);
    const t = await openPage(browser, world, { touch: true });
    await t.openView();
    await t.page.locator('.mm-banner').waitFor({ timeout: 5000 });
    const text = await t.page.locator('.mm-banner').textContent();
    check(text === "T01 can't be reached. These are the maps opened on this computer lately; changes are kept here and move to T01 when it is back. 2 changes wait.", `the note: ${text}`);
    await t.shot('maps-company-offline-390.png');
    await t.context.close();
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
  console.log('Mind maps on every engine passed.');
})().catch(error => { console.error(error); console.error(failures); process.exit(1); });
