// The navigation rail of the multi-column view and its two tabs (scripts/h5-shell/Columns.jsx, columns.mjs, public/js/mindmap.js, scripts/mindmap/app.js),
// in real Chromium at 1440x900 with every route mocked (/api/mindmaps in memory, as scripts/test-h5-mindmap-browser.cjs does):
// - a stored layout of v2.134 with a mind map column: that column is dropped on load and its pane keys are forgotten; the other two stay;
// - the rail: a nav "Views", 72px, the whole height, Update at the top, then "Columns" and "Mind maps", the switch that leaves the view at the bottom; the
//   red badge of "Columns" counts the columns that need the person (the same as the "1 needs you" chip), also while the Mind maps tab is shown;
//   Tab reaches each destination, the arrow keys move between them, Enter opens one;
// - Mind maps: the list (280px) and the empty editor right of the rail; a map opened from the list fills the rest; an edit is saved; the list folds
//   away and that is remembered; the hidden map takes no key meant for the rail or the columns;
// - switching tabs keeps every column's iframe: not reloaded, the same socket still open, the same size and no resize event; the map stays open;
// - the tab shown comes back after a reload; a pane's Mind maps button and an open request switch the tab;
// - maximize in the Columns tab: the maximize rail right of the navigation rail, tiles, peek, Escape restores with the same widths;
// - leaving the view takes the rail away.
// H5_SHOT_DIR=<dir> saves screenshots of the Columns tab, the Mind maps tab with a map open, the folded list and the badge.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const TASKS = [{ id: 1, title: 'Re-render', status: 'doing', work_dir: '/work/a' }, { id: 2, title: 'Write docs', status: 'doing' }];
const TERMINALS = { 1: [{ terminal_id: 'default', title: 'Terminal 1', agent: 'codex' }], 2: [{ terminal_id: 'd1', title: 'Docs shell' }] };
const ATTENTION = [{ id: 7, title: 'Allow edit', status: 'waiting_user', priority: 'none', source: 'codex', updated_at: '2026-11-18T10:00:00Z',
  context: { tagent: { task_id: 1, terminal_id: 'default' }, pending: { text: 'Allow edits to src/render.js?' } } }];
// What v2.134 left: two terminal columns and, between them, a mind map column with a map open.
const STORAGE = {
  'h5-columns': JSON.stringify({ on: true, ids: ['aaa111', 'mapold', 'bbb222'] }),
  'pane:aaa111:h5-task:local': '1', 'pane:aaa111:h5-terminal:local:1': 'default',
  'pane:bbb222:h5-task:local': '2', 'pane:bbb222:h5-terminal:local:2': 'd1',
  'pane:mapold:h5-mindmap': JSON.stringify({ screen: 'editor', sourceKey: 'local', id: 'm1' }),
  'pane:mapold:h5-source': 'local',
};
const pageErrors = [];

function mapServer() {
  const maps = new Map([
    ['m1', { id: 'm1', title: 'Plan', data: null, revision: 1, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' }],
    ['m2', { id: 'm2', title: 'Release notes', data: null, revision: 1, created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' }],
  ]);
  const puts = [];
  async function handle(route, method, pathname, body, json) {
    if (pathname === '/api/mindmaps' && method === 'GET') return json({ maps: [...maps.values()].map(({ data, ...rest }) => ({ ...rest, size: 10 })) });
    const m = pathname.match(/^\/api\/mindmaps\/([^/]+)$/);
    const map = m && maps.get(m[1]);
    if (!map) return json({ error: 'MINDMAP_NOT_FOUND' }, 404);
    if (method === 'GET') return json(map);
    if (method === 'PUT') {
      puts.push({ id: map.id, body });
      if (body.revision !== map.revision) return json({ error: 'MINDMAP_CONFLICT', current_revision: map.revision }, 409);
      map.revision += 1;
      if (body.title !== undefined) map.title = body.title;
      if (body.data !== undefined) map.data = body.data;
      return json({ id: map.id, title: map.title, revision: map.revision, updated_at: new Date().toISOString() });
    }
    return json({ error: 'not mocked' }, 404);
  }
  return { maps, puts, handle };
}

async function openPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  const server = mapServer();
  await page.addInitScript(saved => {
    if (window === window.top && !sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
    }
    if (window === window.top) {
      // T-Attention's stream: open, silent (the list read is what this test needs).
      window.EventSource = class extends EventTarget { constructor(url) { super(); this.url = url; this.readyState = 1; } close() { this.readyState = 2; } };
    }
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    window.loadedAt = Math.random(); // a frame that is reloaded gets a new one
    window.resizes = 0;
    window.addEventListener('resize', () => { window.resizes += 1; });
  }, STORAGE);
  await page.addInitScript(activityStreamMock);
  await context.route(`${ORIGIN}/**`, async route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
    if (pathname.startsWith('/api/mindmaps')) return server.handle(route, method, pathname, request.postData() ? JSON.parse(request.postData()) : undefined, json);
    if (pathname === '/api/attention' && method === 'GET') return json({ items: ATTENTION, host: 'mac' });
    if (pathname === '/api/remote-servers') return json([]);
    if (pathname === '/api/tasks' && method === 'GET') return json(TASKS);
    if (pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (pathname === '/api/tasks/terminal-activity' || pathname === '/api/tasks/terminal-subagents') return json({});
    if (/^\/api\/tasks\/\d+\/terminal\/ack$/.test(pathname)) return json({ success: true });
    const terminals = pathname.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (terminals) return json(TERMINALS[terminals[1]] || []);
    if (/^\/api\/tasks\/\d+\/agent\/conversations$/.test(pathname)) return json([]);
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  return { context, page, server };
}

const paneFrame = (page, id) => page.frames().find(frame => frame.url().includes(`pane=${id}`));
const columns = page => page.evaluate(() => window.H5UI.get().columns);
const rect = (page, selector) => page.evaluate(sel => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }, selector);
const visibleWidths = page => page.evaluate(() => [...document.querySelectorAll('#h5-columns .h5-column')].filter(el => !el.hasAttribute('data-railed') && getComputedStyle(el).display !== 'none')
  .sort((a, b) => Number(getComputedStyle(a).order) - Number(getComputedStyle(b).order)).map(el => [el.dataset.paneId, Math.round(el.getBoundingClientRect().width)]));
const activeId = page => page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.dataset.paneId || document.activeElement.tagName));
// Everything that would show that a column's page was reloaded, reconnected or resized.
const paneState = frame => frame.evaluate(() => {
  const ws = window.sockets.filter(s => s.url.includes('/terminal/ws'));
  return { loadedAt: window.loadedAt, sockets: ws.length, open: ws.filter(s => s.readyState === 1).length, marked: ws.some(s => s.mark === 'kept'), w: innerWidth, h: innerHeight, resizes: window.resizes };
});
const topics = page => page.evaluate(() => [...document.querySelectorAll('#h5-columns-maps .mm-canvas .me-tpc')].map(el => el.textContent));
const shot = async (page, name, clip) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name), ...(clip ? { clip } : {}) }); };

async function run() {
  const browser = await chromium.launch();
  try {
    const { context, page, server } = await openPage(browser);
    await page.waitForFunction(() => document.querySelectorAll('#h5-columns .h5-column[data-ready]').length === 2, null, { timeout: 15000 });

    // ── The old mind map column is gone, with its keys ──
    const first = await columns(page);
    assert.deepEqual(first.ids, ['aaa111', 'bbb222'], 'the map column of v2.134 was dropped, the others kept in order');
    assert.equal(first.tab, 'columns', 'a layout from before the rail opens on the columns');
    assert.equal(await page.locator('#h5-columns iframe[data-pane-id="mapold"]').count(), 0);
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('pane:mapold:'))), [], 'its pane keys are forgotten');
    assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('h5-columns'))), { on: true, ids: ['aaa111', 'bbb222'], tab: 'columns' }, 'and the stored layout says so');

    // ── The rail ──
    const nav = page.locator('#h5-columns-nav');
    assert.equal(await nav.evaluate(el => [el.tagName, el.getAttribute('aria-label')].join('|')), 'NAV|Views');
    assert.deepEqual(await rect(page, '#h5-columns-nav'), { x: 0, y: 0, w: 72, h: 900 }, '72px, the whole height');
    const order = await nav.evaluate(el => [...el.querySelectorAll('#h5-columns-update, #h5-nav-columns, #h5-nav-maps, #h5-columns-toggle, hr')].map(node => node.id || node.tagName));
    assert.deepEqual(order, ['h5-columns-update', 'HR', 'h5-nav-columns', 'h5-nav-maps', 'h5-columns-toggle'], 'Update, a divider, the two destinations, the switch');
    assert.ok((await rect(page, '#h5-columns-toggle')).y > 800, 'the switch is at the bottom');
    for (const id of ['h5-columns-update', 'h5-columns-toggle']) {
      const button = page.locator(`#${id}`);
      assert.equal(await button.getAttribute('aria-label'), await button.getAttribute('title'), `${id}: aria-label = title`);
    }
    assert.equal(await page.locator('#h5-columns-toggle').getAttribute('aria-label'), 'Leave the columns view');
    assert.equal(await page.locator('#h5-columns-bar #h5-columns-update, #h5-columns-bar #h5-columns-toggle, #h5-columns-add-map').count(), 0, 'no longer in the bar; no map column button');
    assert.equal(await page.locator('#h5-nav-columns').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('#h5-nav-maps').getAttribute('aria-current'), null);
    const navColor = sel => page.locator(`${sel} .h5-nav-label`).evaluate(el => getComputedStyle(el).color);
    assert.equal(await navColor('#h5-nav-columns'), 'rgb(144, 202, 249)', 'the active destination in the primary colour');
    assert.notEqual(await navColor('#h5-nav-maps'), 'rgb(144, 202, 249)');
    // The badge: the column of task 1 needs the person (a T-Attention item of its terminal), the same count as the chip.
    await page.waitForFunction(() => document.querySelector('#h5-nav-needs') && !document.querySelector('#h5-nav-needs').classList.contains('MuiBadge-invisible'), null, { timeout: 10000 });
    assert.equal(await page.locator('#h5-nav-needs').textContent(), '1');
    assert.equal(await page.locator('#h5-columns-needs').textContent(), '1 needs you');
    assert.equal(await page.locator('#h5-nav-columns').getAttribute('aria-label'), 'Columns, 1 needs you');
    assert.equal(await page.locator('#h5-nav-maps').getAttribute('aria-label'), 'Mind maps');
    assert.equal(await page.locator('#h5-nav-needs').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(244, 67, 54)', 'red (the theme\'s error colour)');
    // The Columns tab sits right of the rail: its bar, then two columns sharing 1368px.
    assert.equal((await rect(page, '#h5-columns-bar')).x, 72);
    assert.equal((await rect(page, '#h5-columns-strip')).x, 72);
    assert.deepEqual(await visibleWidths(page), [['aaa111', 684], ['bbb222', 684]]);
    await page.waitForFunction(() => document.querySelector('.h5-column-head[data-pane-id="aaa111"]')?.dataset.state === 'waiting', null, { timeout: 5000 });
    await shot(page, 'rail-columns.png');
    await shot(page, 'rail-badge.png', { x: 0, y: 0, width: 400, height: 200 });

    // ── Keyboard on the rail: Tab reaches each destination, arrows move, Enter opens ──
    await page.locator('#h5-columns-update').focus();
    await page.keyboard.press('Tab');
    assert.equal(await activeId(page), 'h5-nav-columns');
    await page.keyboard.press('Tab');
    assert.equal(await activeId(page), 'h5-nav-maps', 'each destination is a Tab stop');
    await page.keyboard.press('ArrowUp');
    assert.equal(await activeId(page), 'h5-nav-columns', 'an arrow moves between them');
    await page.keyboard.press('ArrowDown');
    assert.equal(await activeId(page), 'h5-nav-maps');
    assert.equal((await columns(page)).tab, 'columns', 'a move does not open');

    // The columns' state before the switch: a mark on each terminal socket.
    for (const id of ['aaa111', 'bbb222']) {
      await paneFrame(page, id).waitForFunction(() => window.sockets.some(s => s.url.includes('/terminal/ws') && s.readyState === 1), null, { timeout: 10000 });
      await paneFrame(page, id).evaluate(() => { window.sockets.filter(s => s.url.includes('/terminal/ws')).forEach(s => { s.mark = 'kept'; }); });
    }
    const before = { a: await paneState(paneFrame(page, 'aaa111')), b: await paneState(paneFrame(page, 'bbb222')) };
    const iframeBoxes = await page.evaluate(() => [...document.querySelectorAll('#h5-columns iframe')].map(el => { const r = el.getBoundingClientRect(); return [el.dataset.paneId, r.width, r.height]; }));

    // ── Enter opens the Mind maps tab: the list and the empty editor right of the rail ──
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.H5UI.get().columns.tab === 'maps');
    await page.locator('#h5-columns-maps .mm-row[data-id="m1"]').waitFor({ timeout: 15000 });
    assert.equal(await page.locator('#h5-nav-maps').getAttribute('aria-current'), 'page');
    assert.equal(await activeId(page), 'h5-nav-maps', 'the keyboard stays on the rail');
    assert.equal(await page.locator('#h5-columns-tab').evaluate(el => getComputedStyle(el).visibility), 'hidden', 'the Columns tab is hidden, not removed');
    assert.equal(await page.locator('#h5-columns-maps').evaluate(el => getComputedStyle(el).visibility), 'visible');
    assert.equal(await page.evaluate(() => document.getElementById('h5-mindmap').hidden), true, 'not the full-window view');
    assert.deepEqual(await rect(page, '#h5-columns-maps'), { x: 72, y: 0, w: 1368, h: 900 }, 'the whole area right of the rail');
    assert.deepEqual(await rect(page, '#h5-columns-maps .mm-list'), { x: 72, y: 0, w: 280, h: 900 }, 'the list, 280px');
    assert.equal(await page.locator('#h5-columns-maps .mm-editor[data-empty] .mm-empty').isVisible(), true, 'no map open yet: how to start');
    assert.equal(await page.locator('#h5-columns-maps #mm-close, #h5-columns-maps #mm-back').count(), 0, 'no Close and no Back: the rail is the way out');
    assert.equal(await page.locator('#mm-search').getAttribute('aria-label'), 'Search mind maps');
    assert.equal(await page.locator('#h5-nav-needs').textContent(), '1', 'the badge stays while the Mind maps tab is shown');
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('h5-columns'))).tab, 'maps', 'remembered');
    // The columns behind it: not reloaded, the same socket, the same size, no resize.
    const hiddenState = { a: await paneState(paneFrame(page, 'aaa111')), b: await paneState(paneFrame(page, 'bbb222')) };
    assert.deepEqual(hiddenState, before, 'the columns are untouched while the Mind maps tab is shown');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#h5-columns iframe')].map(el => { const r = el.getBoundingClientRect(); return [el.dataset.paneId, r.width, r.height]; })), iframeBoxes, 'the iframes keep their size');

    // Search.
    await page.locator('#mm-search').fill('release');
    await page.waitForFunction(() => document.querySelectorAll('#h5-columns-maps .mm-row').length === 1);
    assert.equal(await page.locator('#h5-columns-maps .mm-row').getAttribute('data-id'), 'm2');
    await page.locator('#mm-search').fill('nothing like it');
    await page.locator('#h5-columns-maps .mm-note', { hasText: 'No maps match' }).waitFor();
    await page.locator('#mm-search').fill('');
    await page.waitForFunction(() => document.querySelectorAll('#h5-columns-maps .mm-row').length === 2);

    // ── Open a map: it fills the rest; edit it and it is saved ──
    await page.locator('#h5-columns-maps .mm-row[data-id="m1"] .mm-row-open').click();
    await page.locator('#h5-columns-maps .me-tpc').first().waitFor({ timeout: 10000 });
    assert.equal(await page.locator('#h5-columns-maps .mm-row[data-id="m1"] .mm-row-open').getAttribute('aria-current'), 'true', 'its row is marked');
    const editorBox = await rect(page, '#h5-columns-maps .mm-editor');
    assert.deepEqual(editorBox, { x: 72 + 280, y: 0, w: 1368 - 280, h: 900 }, 'the open map fills the rest');
    assert.equal(await page.locator('#h5-columns-maps .mm-title').inputValue(), 'Plan');
    await page.locator('#h5-columns-maps .me-tpc').first().click();
    await page.keyboard.press('Tab');
    await page.locator('#input-box').waitFor();
    await page.keyboard.type('Rail topic');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#input-box'));
    assert.ok((await topics(page)).includes('Rail topic'), 'the key reached the map');
    await page.locator('#h5-columns-maps .mm-status[data-state="saved"]').waitFor({ timeout: 8000 });
    await page.waitForFunction(() => true);
    assert.ok(server.puts.some(entry => entry.id === 'm1' && JSON.stringify(entry.body.data).includes('Rail topic')), 'the edit was saved on its service');
    await shot(page, 'rail-mindmap.png');

    // A key on the rail is the rail's, never the map's.
    const selectedBefore = await page.evaluate(() => document.querySelector('#h5-columns-maps .me-tpc.selected')?.textContent || '');
    await page.locator('#h5-nav-maps').focus();
    await page.keyboard.press('ArrowUp');
    assert.equal(await activeId(page), 'h5-nav-columns');
    assert.equal(await page.evaluate(() => document.querySelector('#h5-columns-maps .me-tpc.selected')?.textContent || ''), selectedBefore, 'the arrow did not move the map\'s selection');
    await page.keyboard.press('x');
    assert.equal(await page.locator('#input-box').count(), 0, 'a character on the rail opens no topic editor');

    // ── Back to the Columns tab with a click; the map stays open (hidden) ──
    await page.locator('#h5-columns-maps .mm-canvas').evaluate(el => { el.dataset.mark = 'kept'; });
    await page.locator('#h5-nav-columns').click();
    await page.waitForFunction(() => window.H5UI.get().columns.tab === 'columns');
    assert.equal(await page.locator('#h5-columns-maps').evaluate(el => getComputedStyle(el).visibility), 'hidden');
    assert.deepEqual({ a: await paneState(paneFrame(page, 'aaa111')), b: await paneState(paneFrame(page, 'bbb222')) }, before, 'back: nothing reloaded, reconnected or resized');
    assert.deepEqual(await visibleWidths(page), [['aaa111', 684], ['bbb222', 684]]);
    // The hidden map takes no key typed on the top page.
    await page.locator('.h5-column-head[data-pane-id="bbb222"] .h5-column-switch').focus();
    await page.keyboard.press('Delete');
    assert.ok((await topics(page)).includes('Rail topic'), 'Delete on a column header did not reach the hidden map');
    // A pane's Mind maps button opens the tab; the same map is still open there.
    await paneFrame(page, 'bbb222').evaluate(() => window.H5UI.actions.openMindmaps());
    await page.waitForFunction(() => window.H5UI.get().columns.tab === 'maps', null, { timeout: 3000 });
    assert.equal(await paneFrame(page, 'bbb222').evaluate(() => document.getElementById('h5-mindmap').hidden), true, 'the column shows no map of its own');
    assert.equal(await page.locator('#h5-columns-maps .mm-canvas').getAttribute('data-mark'), 'kept', 'the same editor, not mounted again');
    assert.ok((await topics(page)).includes('Rail topic'));

    // ── Fold the list away; remembered ──
    const fold = page.locator('#mm-list-toggle');
    assert.equal(await fold.getAttribute('aria-label'), 'Hide the map list');
    assert.equal(await fold.getAttribute('title'), 'Hide the map list');
    assert.equal(await fold.getAttribute('aria-expanded'), 'true');
    await fold.click();
    assert.equal(await page.locator('#h5-columns-maps .mm-list').isVisible(), false);
    assert.equal(await fold.getAttribute('aria-label'), 'Show the map list');
    assert.equal(await fold.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(await rect(page, '#h5-columns-maps .mm-editor'), { x: 72, y: 0, w: 1368, h: 900 }, 'the map has the whole area');
    assert.equal(await page.locator('#h5-columns-maps-view').evaluate(el => [el.className, getComputedStyle(el).display].join('|')), 'mm mm-split|flex', 'the view keeps its root class through the tab\'s re-renders');
    const tops = await topics(page);
    assert.ok(tops.includes('Rail topic'), 'the map is still drawn');
    assert.ok(await page.evaluate(() => { const c = document.querySelector('#h5-columns-maps .mm-canvas').getBoundingClientRect(); const t = document.querySelector('#h5-columns-maps .me-tpc').getBoundingClientRect(); return t.width > 0 && t.left >= c.left && t.right <= c.right && t.top >= c.top && t.bottom <= c.bottom; }), 'its topics are on the canvas');
    assert.equal(await page.evaluate(() => localStorage.getItem('h5-mindmap-list-folded')), '1');
    await shot(page, 'rail-mindmap-folded.png');

    // An open request (a ?openChat= link) goes to a column: the Columns tab is shown for it.
    assert.equal(await page.evaluate(() => window.H5UI.actions.openInColumn({ sourceKey: 'local', taskId: 1, terminalId: 'default' })), true);
    await page.waitForFunction(() => window.H5UI.get().columns.tab === 'columns', null, { timeout: 3000 });

    // ── Maximize still works in the Columns tab, its rail right of the navigation rail ──
    const termFrame = paneFrame(page, 'bbb222');
    await page.locator('#h5-columns .h5-column[data-pane-id="bbb222"] iframe').click({ position: { x: 200, y: 300 } });
    await page.waitForFunction(() => window.H5UI.get().columns.focus === 'bbb222', null, { timeout: 3000 });
    await page.keyboard.press('Control+Shift+Enter');
    await page.locator('#h5-columns-rail').waitFor({ timeout: 3000 });
    assert.equal((await columns(page)).maximized, 'bbb222');
    assert.deepEqual(await rect(page, '#h5-columns-rail'), { x: 72, y: (await rect(page, '#h5-columns-strip')).y, w: 72, h: 900 - (await rect(page, '#h5-columns-strip')).y });
    assert.deepEqual(await visibleWidths(page), [['bbb222', 1440 - 72 - 72]]);
    await termFrame.waitForFunction(() => innerWidth === 1440 - 144, null, { timeout: 3000 });
    await page.waitForFunction(() => document.querySelector('#h5-columns-rail .h5-rail-tile[data-pane-id="aaa111"]')?.dataset.state === 'waiting', null, { timeout: 5000 });
    assert.equal(await page.locator('.h5-rail-tile[data-pane-id="aaa111"]').getAttribute('aria-label'), 'Re-render, Codex needs you');
    await page.locator('.h5-rail-tile[data-pane-id="aaa111"]').hover();
    await page.locator('#h5-rail-peek[data-pane-id="aaa111"]').waitFor({ timeout: 3000 });
    assert.ok((await rect(page, '#h5-rail-peek')).x >= 144, 'the peek card beside both rails');
    await page.mouse.move(900, 500);
    await page.waitForFunction(() => !document.getElementById('h5-rail-peek'), null, { timeout: 3000 });
    await page.locator('#h5-columns-restore').focus();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('h5-columns-rail'), null, { timeout: 3000 });
    assert.deepEqual(await visibleWidths(page), [['aaa111', 684], ['bbb222', 684]], 'widths back');
    await termFrame.waitForFunction(w => innerWidth === w, before.b.w, { timeout: 3000 });
    assert.equal((await paneState(paneFrame(page, 'aaa111'))).loadedAt, before.a.loadedAt, 'never reloaded');

    // ── A reload brings back the tab shown and the folded list ──
    await page.locator('#h5-nav-maps').click();
    await page.waitForFunction(() => window.H5UI.get().columns.tab === 'maps');
    await page.locator('#h5-columns-maps .mm-status[data-state="saved"]').waitFor({ timeout: 8000 });
    await page.reload();
    await page.waitForFunction(() => window.H5UI && window.H5UI.get().columns && window.H5UI.get().columns.tab === 'maps', null, { timeout: 15000 });
    await page.locator('#h5-columns-maps #mm-list-toggle').waitFor({ timeout: 15000 });
    assert.equal(await page.locator('#h5-nav-maps').getAttribute('aria-current'), 'page', 'the Mind maps tab came back');
    assert.equal(await page.locator('#h5-columns-maps .mm-list').isVisible(), false, 'the list is still folded');
    assert.equal(await page.locator('#mm-list-toggle').getAttribute('aria-label'), 'Show the map list');
    await page.locator('#mm-list-toggle').click();
    await page.locator('#h5-columns-maps .mm-row[data-id="m1"]').waitFor({ timeout: 10000 });
    assert.equal(await page.evaluate(() => localStorage.getItem('h5-mindmap-list-folded')), null);
    await page.waitForFunction(() => document.querySelectorAll('#h5-columns .h5-column[data-ready]').length === 2, null, { timeout: 15000 });
    assert.equal(await page.locator('#h5-columns-tab').evaluate(el => getComputedStyle(el).visibility), 'hidden', 'the columns load behind the Mind maps tab');

    // ── Leaving the view takes the rail away ──
    await page.locator('#h5-columns-toggle').click();
    await page.waitForFunction(() => !document.getElementById('h5-columns'), null, { timeout: 3000 });
    assert.equal(await page.locator('#h5-columns-nav').count(), 0, 'no rail in the normal view');
    assert.equal(await page.locator('#h5-columns-open').getAttribute('aria-label'), 'Multi-column view');
    await context.close();
  } finally {
    await browser.close();
  }
  const errors = pageErrors.filter(text => !/ResizeObserver loop/.test(text));
  assert.deepEqual(errors, [], 'no page errors');
  console.log('columns navigation rail browser test passed');
}

run().catch(error => { console.error(error); process.exit(1); });
