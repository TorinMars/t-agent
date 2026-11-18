// Mind map columns and the maximized column of the multi-column view (scripts/h5-shell/Columns.jsx, columns.mjs, pane.mjs, scripts/mindmap/app.js),
// in real Chromium at 1440x900 with every route mocked (/api/mindmaps in memory, as scripts/test-h5-mindmap-browser.cjs does):
// - "Add mind map column" makes a third column whose pane starts on the map list; the map fills that column only (not the window), its tab shows
//   the map icon, the name and the "map" tag; a map opened from that list opens in that column and the pane remembers it;
// - Maximize in the map's bar: the map column fills the strip, the other two become rail tiles (state dot, name, red count, labels); their iframes
//   stay mounted at their old width, not reloaded and still connected (a title message from a hidden pane updates its tile, a peek gets its lines);
//   the peek card shows the pending question and only "Open column"; Escape while a topic is edited does not restore, Escape then does, with the
//   exact widths and scroll back; Cmd/Ctrl+Shift+Enter in the map maximizes again; a tile click restores and focuses that column;
// - a terminal column is maximized with Ctrl+Shift+Enter from inside its pane (its terminal never sees the key), restored from the rail by keyboard
//   (Tab to a tile shows its peek, Escape closes the peek, Escape again restores);
// - a reload brings the map column back with the same map, without taking the focus.
// H5_SHOT_DIR=<dir> saves screenshots of the map column and of the maximized view with a peek card.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'; // the page takes either; this is what a person would press
const TASKS = [{ id: 1, title: 'Re-render', status: 'doing', work_dir: '/work/a' }, { id: 2, title: 'Write docs', status: 'doing' }];
const TERMINALS = { 1: [{ terminal_id: 'default', title: 'Terminal 1', agent: 'codex' }], 2: [{ terminal_id: 'd1', title: 'Docs shell' }] };
const ATTENTION = [{ id: 7, title: 'Allow edit', status: 'waiting_user', priority: 'none', source: 'codex', updated_at: '2026-11-18T10:00:00Z',
  context: { tagent: { task_id: 1, terminal_id: 'default' }, pending: { text: 'Allow edits to src/render.js?' } } }];
const STORAGE = {
  'h5-columns': JSON.stringify({ on: true, ids: ['aaa111', 'bbb222'] }),
  'pane:aaa111:h5-task:local': '1', 'pane:aaa111:h5-terminal:local:1': 'default',
  'pane:bbb222:h5-task:local': '2', 'pane:bbb222:h5-terminal:local:2': 'd1',
};
const pageErrors = [];

function mapServer() {
  const maps = new Map([['m1', { id: 'm1', title: 'Plan', data: null, revision: 1, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' }]]);
  const puts = [];
  async function handle(route, method, pathname, body, json) {
    if (pathname === '/api/mindmaps' && method === 'GET') return json({ maps: [...maps.values()].map(({ data, ...rest }) => ({ ...rest, size: 10 })) });
    const m = pathname.match(/^\/api\/mindmaps\/([^/]+)$/);
    const map = m && maps.get(m[1]);
    if (!map) return json({ error: 'MINDMAP_NOT_FOUND' }, 404);
    if (method === 'GET') return json(map);
    if (method === 'PUT') {
      puts.push(body);
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  const server = mapServer();
  await page.addInitScript(saved => {
    if (window === window.top && !sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
    }
    if (window === window.top) {
      window.frameFocusCalls = 0;
      const own = HTMLIFrameElement.prototype.focus;
      HTMLIFrameElement.prototype.focus = function focus(...args) { window.frameFocusCalls += 1; return own.apply(this, args); };
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
const visibleWidths = page => page.evaluate(() => [...document.querySelectorAll('#h5-columns .h5-column')].filter(el => !el.hasAttribute('data-railed') && getComputedStyle(el).display !== 'none')
  .sort((a, b) => Number(getComputedStyle(a).order) - Number(getComputedStyle(b).order)).map(el => [el.dataset.paneId, Math.round(el.getBoundingClientRect().width)]));
const tileLabels = page => page.evaluate(() => [...document.querySelectorAll('#h5-columns-rail .h5-rail-tile')].map(el => [el.dataset.paneId, el.getAttribute('aria-label'), el.dataset.state]));
const live = page => page.evaluate(() => document.getElementById('h5-columns-live').textContent);
async function waitTitles(page, check, timeout = 10000) {
  await page.waitForFunction(check, null, { timeout });
}

async function run() {
  const browser = await chromium.launch();
  try {
    const { context, page, server } = await openPage(browser);
    await page.waitForFunction(() => document.querySelectorAll('#h5-columns .h5-column[data-ready]').length === 2, null, { timeout: 15000 });
    await waitTitles(page, () => { const c = window.H5UI.get().columns; return c.titles.aaa111 && c.titles.aaa111.target && c.titles.bbb222 && c.titles.bbb222.target; });
    const before = await columns(page);
    assert.equal(before.titles.aaa111.agent, 'codex', 'the pane tells the agent of its terminal');
    assert.deepEqual(before.titles.bbb222.target, { sourceKey: 'local', taskId: 2, terminalId: 'd1' });

    // ── Add a mind map column ──
    const addMap = page.locator('#h5-columns-add-map');
    assert.equal(await addMap.getAttribute('aria-label'), 'Add mind map column');
    assert.equal(await addMap.getAttribute('title'), 'Add mind map column');
    await addMap.click();
    await page.waitForFunction(() => window.H5UI.get().columns.ids.length === 3);
    const mapId = (await columns(page)).ids[2];
    assert.equal(await page.evaluate(id => localStorage.getItem(`pane:${id}:h5-mindmap`), mapId), '{"screen":"list"}', 'written before its iframe exists');
    await page.waitForFunction(id => document.querySelector(`#h5-columns .h5-column[data-pane-id="${id}"][data-ready]`), mapId, { timeout: 15000 });
    const mapFrame = paneFrame(page, mapId);
    await mapFrame.locator('.mm-row[data-id="m1"]').waitFor({ timeout: 15000 });
    const tab = page.locator(`.h5-column-tab[data-pane-id="${mapId}"]`);
    await page.waitForFunction(id => document.querySelector(`.h5-column-tab[data-pane-id="${id}"]`)?.dataset.kind === 'map', mapId, { timeout: 5000 });
    assert.equal(await tab.locator('.h5-column-tab-name').textContent(), 'Mind maps');
    assert.equal(await tab.locator('.h5-column-tab-kind').textContent(), 'map');
    assert.equal(await tab.locator('svg').count() >= 1, true, 'the map icon');
    // The map fills its column, not the window; the top page's own view stays closed.
    const box = await page.locator(`#h5-columns .h5-column[data-pane-id="${mapId}"] iframe`).boundingBox();
    const inner = await mapFrame.evaluate(() => { const r = document.getElementById('h5-mindmap').getBoundingClientRect(); return { w: r.width, h: r.height, vw: innerWidth }; });
    assert.ok(Math.abs(inner.w - box.width) <= 1 && Math.abs(inner.h - box.height) <= 1, `map fills the column: ${JSON.stringify(inner)} vs ${box.width}x${box.height}`);
    assert.ok(box.width < 600, `one column of three, not the window: ${box.width}`);
    assert.equal(await page.evaluate(() => document.getElementById('h5-mindmap').hidden), true, 'the top page opens no map of its own');
    assert.equal(await page.evaluate(() => window.frameFocusCalls), 0, 'no frame focus taken by the top page');

    // A map opened from the column's list opens in that column; the pane remembers it.
    await mapFrame.locator('.mm-row[data-id="m1"] .mm-row-open').click();
    await mapFrame.locator('.me-tpc').first().waitFor({ timeout: 10000 });
    await page.waitForFunction(id => document.querySelector(`.h5-column-tab[data-pane-id="${id}"] .h5-column-tab-name`)?.textContent === 'Plan', mapId, { timeout: 5000 });
    assert.equal(await page.evaluate(id => localStorage.getItem(`pane:${id}:h5-mindmap`), mapId), '{"screen":"editor","sourceKey":"local","id":"m1"}');
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'mindmap-column.png') }); }

    // ── Maximize from the map's bar ──
    const stripBefore = await visibleWidths(page);
    assert.deepEqual(stripBefore.map(([, w]) => w), [480, 480, 480]);
    const scrollBefore = await page.evaluate(() => document.getElementById('h5-columns-strip').scrollLeft);
    const marks = { a: await paneFrame(page, 'aaa111').evaluate(() => window.loadedAt), b: await paneFrame(page, 'bbb222').evaluate(() => window.loadedAt) };
    const paneWidth = await paneFrame(page, 'bbb222').evaluate(() => innerWidth); // 479: the column's 1px left border
    const maximize = mapFrame.locator('#mm-maximize');
    assert.equal(await maximize.getAttribute('aria-label'), 'Maximize');
    assert.equal(await maximize.getAttribute('title'), 'Maximize');
    await maximize.click();
    await page.locator('#h5-columns-rail').waitFor({ timeout: 5000 });
    assert.equal((await columns(page)).maximized, mapId);
    assert.equal(await page.locator('#h5-columns-rail').evaluate(el => [el.tagName, el.getAttribute('aria-label'), Math.round(el.getBoundingClientRect().width)].join('|')), 'NAV|Other columns|72');
    assert.deepEqual(await visibleWidths(page), [[mapId, 1440 - 72]], 'the map column fills the strip');
    await mapFrame.waitForFunction(() => document.getElementById('mm-maximize').getAttribute('aria-label') === 'Restore', null, { timeout: 5000 });
    assert.match(await live(page), /Column maximized/);
    const restoreButton = page.locator('#h5-columns-restore');
    assert.equal(await restoreButton.getAttribute('aria-label'), 'Restore columns');
    assert.equal(await restoreButton.getAttribute('title'), 'Restore columns');
    // The other columns: mounted, the same width as before, hidden, not reloaded, sockets still open.
    const hidden = await page.evaluate(() => [...document.querySelectorAll('#h5-columns .h5-column[data-railed]')].map(el => [el.dataset.paneId, Math.round(el.getBoundingClientRect().width), getComputedStyle(el).visibility]));
    assert.deepEqual(hidden, [['aaa111', 480, 'hidden'], ['bbb222', 480, 'hidden']]);
    assert.equal(await paneFrame(page, 'aaa111').evaluate(() => window.loadedAt), marks.a, 'not reloaded');
    assert.equal(await paneFrame(page, 'bbb222').evaluate(() => innerWidth), paneWidth, 'its page sees no resize');
    assert.ok(await paneFrame(page, 'bbb222').evaluate(() => window.sockets.some(s => s.readyState === 1 && s.url.includes('/terminal/ws'))), 'its terminal socket is still open');
    // Tiles: state dot, name, count; labels like "Re-render, Codex needs you".
    await page.waitForFunction(() => document.querySelector('#h5-columns-rail .h5-rail-tile[data-pane-id="aaa111"]')?.dataset.state === 'waiting', null, { timeout: 5000 });
    assert.deepEqual(await tileLabels(page), [['aaa111', 'Re-render, Codex needs you', 'waiting'], ['bbb222', 'Write docs, idle', 'idle']]);
    assert.equal(await page.locator('.h5-rail-tile[data-pane-id="aaa111"] .h5-rail-badge').textContent(), '1');
    assert.equal(await page.locator('.h5-rail-tile[data-pane-id="bbb222"] .h5-rail-badge').count(), 0);
    // The top page's live activity colours a tile.
    assert.ok(await page.evaluate(() => window.activityStream.push('/api/tasks/terminal-activity/stream', { activity: { 2: { d1: 'running' } }, subagents: {} })));
    await page.waitForFunction(() => document.querySelector('.h5-rail-tile[data-pane-id="bbb222"]')?.dataset.state === 'running', null, { timeout: 5000 });
    assert.equal(await page.locator('.h5-rail-tile[data-pane-id="bbb222"] .h5-rail-dot').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(102, 187, 106)');
    // A message from a hidden pane still reaches its tile.
    await paneFrame(page, 'bbb222').evaluate(() => window.H5UI.set({ taskName: 'Docs v2' }));
    await page.waitForFunction(() => document.querySelector('.h5-rail-tile[data-pane-id="bbb222"]')?.getAttribute('aria-label') === 'Docs v2, running', null, { timeout: 5000 });
    // Peek: hover shows the question and only "Open column".
    await page.locator('.h5-rail-tile[data-pane-id="aaa111"]').hover();
    await page.locator('#h5-rail-peek[data-pane-id="aaa111"]').waitFor({ timeout: 3000 });
    assert.equal(await page.locator('#h5-rail-peek .h5-rail-peek-question').textContent(), 'Allow edits to src/render.js?');
    assert.deepEqual(await page.locator('#h5-rail-peek button').allTextContents(), ['Open column']);
    const peekBox = await page.locator('#h5-rail-peek').boundingBox();
    assert.ok(peekBox.x >= 72, 'beside the rail');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'mindmap-column-maximized.png') });
    // The peek of the other tile asks its (hidden) pane for the last lines of its terminal.
    await page.locator('.h5-rail-tile[data-pane-id="bbb222"]').hover();
    await page.locator('#h5-rail-peek[data-pane-id="bbb222"]').waitFor({ timeout: 3000 });
    await page.waitForFunction(() => Array.isArray(window.H5UI.get().columns.tails.bbb222), null, { timeout: 5000 });
    await page.mouse.move(900, 500);

    // ── Escape: not while a topic is edited; then it restores, exactly ──
    await mapFrame.locator('.me-tpc').first().click();
    await mapFrame.locator('.me-tpc').first().press('F2');
    await mapFrame.waitForFunction(() => Boolean(document.querySelector('#input-box, .mind-elixir [contenteditable]')), null, { timeout: 3000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    assert.equal((await columns(page)).maximized, mapId, 'Escape in the topic editor stays with the editor');
    await mapFrame.waitForFunction(() => !document.querySelector('#input-box'), null, { timeout: 3000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('h5-columns-rail'), null, { timeout: 3000 });
    assert.equal((await columns(page)).maximized, null);
    assert.deepEqual(await visibleWidths(page), stripBefore, 'the same widths');
    assert.equal(await page.evaluate(() => document.getElementById('h5-columns-strip').scrollLeft), scrollBefore);
    assert.equal(await mapFrame.locator('.me-tpc').count() > 0, true, 'Escape restored instead of leaving the map');
    assert.match(await live(page), /Columns restored/);
    await mapFrame.waitForFunction(() => document.getElementById('mm-maximize').getAttribute('aria-label') === 'Maximize', null, { timeout: 3000 });

    // ── Cmd/Ctrl+Shift+Enter in the map maximizes; a tile click restores and focuses that column ──
    await mapFrame.locator('.mm-canvas').click({ position: { x: 20, y: 20 } });
    await page.keyboard.press(`${MOD}+Shift+Enter`);
    await page.locator('#h5-columns-rail').waitFor({ timeout: 3000 });
    await page.locator('.h5-rail-tile[data-pane-id="aaa111"]').click();
    await page.waitForFunction(() => !document.getElementById('h5-columns-rail') && window.H5UI.get().columns.focus === 'aaa111', null, { timeout: 3000 });
    await page.waitForFunction(() => document.activeElement && document.activeElement.dataset.paneId === 'aaa111', null, { timeout: 3000 });

    // ── A terminal column: Ctrl+Shift+Enter inside its pane; restore from the rail by keyboard ──
    const termFrame = paneFrame(page, 'bbb222');
    await page.locator('#h5-columns .h5-column[data-pane-id="bbb222"] iframe').click({ position: { x: 200, y: 300 } });
    await page.waitForFunction(() => window.H5UI.get().columns.focus === 'bbb222', null, { timeout: 3000 });
    const sentBefore = await termFrame.evaluate(() => window.sockets.filter(s => s.url.includes('/terminal/ws')).reduce((n, s) => n + s.sent.length, 0));
    await page.keyboard.press('Control+Shift+Enter');
    await page.locator('#h5-columns-rail').waitFor({ timeout: 3000 });
    assert.equal((await columns(page)).maximized, 'bbb222', 'any column can be maximized');
    assert.deepEqual(await visibleWidths(page), [['bbb222', 1440 - 72]]);
    await termFrame.waitForFunction(() => innerWidth === 1440 - 72, null, { timeout: 3000 });
    const sentAfter = await termFrame.evaluate(() => window.sockets.filter(s => s.url.includes('/terminal/ws')).flatMap(s => s.sent));
    assert.ok(!sentAfter.slice(sentBefore).some(text => text === '\r' || text.includes('"data":"\\r"')), 'the key never reached the terminal');
    assert.deepEqual((await tileLabels(page)).map(([id]) => id), ['aaa111', mapId]);
    assert.equal((await tileLabels(page))[1][1], 'Plan, idle', 'a map column\'s tile');
    await restoreButton.focus();
    await page.keyboard.press('Tab');
    await page.locator('#h5-rail-peek[data-pane-id="aaa111"]').waitFor({ timeout: 3000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('h5-rail-peek'), null, { timeout: 3000 });
    assert.ok(await page.locator('#h5-columns-rail').isVisible(), 'the first Escape closes the peek only');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('h5-columns-rail'), null, { timeout: 3000 });
    assert.deepEqual(await visibleWidths(page), stripBefore.map(([id, w]) => [id, w]), 'widths back after a terminal column too');
    await termFrame.waitForFunction(w => innerWidth === w, paneWidth, { timeout: 3000 });
    assert.equal(await paneFrame(page, 'aaa111').evaluate(() => window.loadedAt), marks.a, 'never reloaded');

    // ── A reload keeps the map column ──
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#h5-columns .h5-column[data-ready]').length === 3, null, { timeout: 15000 });
    const again = paneFrame(page, mapId);
    await again.locator('.me-tpc').first().waitFor({ timeout: 15000 });
    assert.equal(await again.locator('.mm-title').inputValue(), 'Plan');
    await page.waitForFunction(id => document.querySelector(`.h5-column-tab[data-pane-id="${id}"]`)?.dataset.kind === 'map', mapId, { timeout: 5000 });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.frameFocusCalls), 0, 'no frame focused on load');
    assert.notEqual(await page.evaluate(() => document.activeElement && document.activeElement.tagName), 'IFRAME', 'the restored map took no focus');
    assert.equal((await columns(page)).maximized, null, 'maximize is not stored');
    assert.equal(server.puts.length, 0, 'opening and maximizing never saved the map');
    await context.close();
  } finally {
    await browser.close();
  }
  const errors = pageErrors.filter(text => !/ResizeObserver loop/.test(text));
  assert.deepEqual(errors, [], 'no page errors');
  console.log('mind map column and maximize browser test passed');
}

run().catch(error => { console.error(error); process.exit(1); });
