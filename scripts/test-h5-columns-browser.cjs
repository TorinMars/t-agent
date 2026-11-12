// The multi-column view of the page (scripts/h5-shell/Columns.jsx, columns.mjs), in real Chromium with mocked servers, at 1440x900 and 1920x1080:
// the header switch shows the default number of iframes of the page in pane mode (`/h5?pane=<id>`) and goes back to the normal view (the same
// terminal again); a reload keeps the mode, the order and the ids; add and close a column (the last one cannot be closed, at most 12, a closed pane
// gets 'forget'); sideways scrolling when the columns do not fit; focus by a click into a column (none taken on load); pane messages
// from a foreign origin, from the top page itself or about another column are ignored; the top page holds no terminal socket while the strip is
// shown; the switch is not offered below the wide breakpoint, on a phone, or on a pane page. While the strip is shown, a ?openChat= link leaves the
// hidden normal view alone and sends `open` to the focused column (else the first).
// Widths: up to four columns share the strip's width; with more each one is a quarter of it (never below 360px) and the strip scrolls sideways; a
// window resize changes the widths (1920: 480px each; 1000: 360px, so three overflow).
// Scrolling (1440x900, 5 columns): each column is a quarter of the strip (360px), the strip overflows with its own scrollbar and edge shadows only where columns are hidden; a sideways wheel inside a pane scrolls the strip and a
// vertical one does not; Shift+wheel over a column's bar scrolls it; Ctrl+Alt+Right inside a pane moves the focus and scrolls, and never reaches the
// terminal; a new column is scrolled into view; 12 columns, not 13; with reduced motion the strip scrolls at once.
// H5_SHOT_DIR=<dir> saves screenshots of the header switch, of the strip at 1920x1080 and of 5 overflowing columns at 1440x900 (2x) there.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const FOREIGN = 'http://foreign.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const PANE_URL = /^\/h5\?pane=[a-z0-9]{1,16}$/;

const TASKS = [{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }, { id: 2, title: 'Write docs', status: 'doing' }];
const TERMINALS = { 1: [{ terminal_id: 'default', title: 'Terminal 1' }], 2: [{ terminal_id: 'd1', title: 'Docs shell' }] };
const REMEMBERED = { 'h5-task:local': '1', 'h5-terminal:local:1': 'default' };
const pageErrors = [];

async function openPage(browser, { viewport, touch = false, storage = REMEMBERED, url = '/h5', scale = 1, reducedMotion = 'no-preference' }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: scale, reducedMotion, ...(touch ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  // The remembered storage is written once, by the top page (not again on a reload, and not by the columns).
  await page.addInitScript(saved => {
    if (window === window.top && !sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      for (const [key, value] of Object.entries(saved || {})) localStorage.setItem(key, value);
    }
    // The top page itself must never move the focus into a column (a pane takes it only when the person clicks it).
    if (window === window.top) {
      window.frameFocusCalls = 0;
      const own = HTMLIFrameElement.prototype.focus;
      HTMLIFrameElement.prototype.focus = function focus(...args) { window.frameFocusCalls += 1; return own.apply(this, args); };
    }
    // Every pane message a column receives, from its start, in the top page's `paneInbox`: [pane id, data, origin].
    if (window !== window.top) {
      window.addEventListener('message', event => {
        if (!event.data || event.data.type !== 't-agent-pane') return;
        try { (window.top.paneInbox = window.top.paneInbox || []).push([new URLSearchParams(location.search).get('pane'), event.data, event.origin]); } catch { /* another origin */ }
      });
    }
    window.sockets = [];
    window.FakeSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
    };
    window.FakeSocket.OPEN = 1;
    window.FakeSocket.CONNECTING = 0;
    window.WebSocket = window.FakeSocket;
  }, storage);
  await page.addInitScript(activityStreamMock);
  await context.route(`${FOREIGN}/**`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Foreign</title><p>foreign page</p>' }));
  await context.route(`${ORIGIN}/**`, async route => {
    const address = new URL(route.request().url());
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (address.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(address.pathname)) return route.fulfill({ contentType: TYPES[path.extname(address.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', address.pathname)) });
    if (address.pathname === '/api/remote-servers') return json([]);
    if (address.pathname === '/api/tasks' && method === 'GET') return json(TASKS);
    if (address.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (address.pathname === '/api/tasks/terminal-activity') return json({});
    if (address.pathname === '/api/tasks/terminal-subagents') return json({});
    if (/^\/api\/tasks\/\d+\/terminal\/ack$/.test(address.pathname)) return json({ success: true });
    const terminals = address.pathname.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (terminals && method === 'GET') return json(TERMINALS[terminals[1]] || []);
    if (/^\/api\/tasks\/\d+\/agent\/conversations$/.test(address.pathname)) return json([]);
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}${url}`);
  return { context, page };
}

// The terminal sockets of the top page that are not closed (the columns have their own windows and sockets).
const openTerminalSockets = page => page.evaluate(() => window.sockets.filter(s => s.readyState !== 3 && s.url.includes('/terminal/ws')).map(s => s.url));
const terminalSocketCount = page => page.evaluate(() => window.sockets.filter(s => s.url.includes('/terminal/ws')).length);
const frameIds = page => page.evaluate(() => [...document.querySelectorAll('#h5-columns iframe')].filter(el => el.closest('.h5-column').style.display !== 'none' && getComputedStyle(el.closest('.h5-column')).display !== 'none').map(el => el.dataset.paneId));
const frameSrcs = page => page.evaluate(() => [...document.querySelectorAll('#h5-columns iframe')].map(el => el.getAttribute('src')));
const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem('h5-columns') || 'null'));
const opens = page => page.evaluate(() => (window.paneInbox || []).filter(([, data]) => data.event === 'open'));
// The minimum column width the page should use: a quarter of the strip's visible width, never below 360px (columns.mjs minColumnWidth).
const expectedMinWidth = page => page.evaluate(() => Math.max(360, Math.floor(document.getElementById('h5-columns-strip').clientWidth / 4)));
const columnWidths = page => page.evaluate(() => { const strip = document.getElementById('h5-columns-strip'); return { scroll: strip.scrollWidth, client: strip.clientWidth, overflow: strip.hasAttribute('data-overflow'), widths: [...strip.querySelectorAll('.h5-column')].filter(el => getComputedStyle(el).display !== 'none').map(el => el.getBoundingClientRect().width) }; });
// Waits until every shown column is `width` px wide (within 1px), then returns the strip's widths.
async function widthsBecome(page, width) {
  try { await page.waitForFunction(w => [...document.querySelectorAll('#h5-columns-strip .h5-column')].filter(el => getComputedStyle(el).display !== 'none').every(el => Math.abs(el.getBoundingClientRect().width - w) <= 1), width, { timeout: 3000 }); } catch { /* the assertion below reports them */ }
  return columnWidths(page);
}
const stripState = page => page.evaluate(() => {
  const strip = document.getElementById('h5-columns-strip');
  const box = strip.getBoundingClientRect();
  const focused = document.querySelector('.h5-column[data-focused]');
  return {
    left: strip.scrollLeft, max: strip.scrollWidth - strip.clientWidth, scroll: strip.scrollWidth, client: strip.clientWidth,
    overflow: strip.hasAttribute('data-overflow'), scrollClass: strip.classList.contains('h5-columns-scroll'),
    edges: [...document.querySelectorAll('.h5-columns-edge')].filter(el => el.hasAttribute('data-shown') && getComputedStyle(el).opacity === '1').map(el => el.dataset.side),
    widths: [...strip.querySelectorAll('.h5-column')].map(el => el.getBoundingClientRect().width),
    focus: focused ? focused.dataset.paneId : null,
    focusWhole: focused ? (() => { const r = focused.getBoundingClientRect(); return r.left >= box.left - 1 && r.right <= box.right + 1; })() : null,
    active: document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.paneId || null : null,
  };
});
// Waits until exactly these edge shadows are shown (after their short fade), then returns them.
async function edgesShown(page, sides) {
  const want = [...sides].sort().join(',');
  try {
    await page.waitForFunction(w => [...document.querySelectorAll('.h5-columns-edge')].filter(el => el.hasAttribute('data-shown') && getComputedStyle(el).opacity === '1').map(el => el.dataset.side).sort().join(',') === w
      && [...document.querySelectorAll('.h5-columns-edge:not([data-shown])')].every(el => getComputedStyle(el).opacity === '0'), want, { timeout: 3000 });
  } catch { /* the assertion below reports what is shown */ }
  return (await stripState(page)).edges.sort();
}
const paneFrame = (page, id) => page.frames().find(frame => frame.url().endsWith(`/h5?pane=${id}`));
async function waitFrames(page, count) {
  await page.waitForFunction(n => document.querySelectorAll('#h5-columns .h5-column').length === n && [...document.querySelectorAll('#h5-columns .h5-column')].every(el => getComputedStyle(el).display !== 'none'), count, { timeout: 5000 });
}
async function shownTerminal(page, name) {
  await page.waitForFunction(text => document.getElementById('h5-session-name') && document.getElementById('h5-session-name').textContent === text
    && window.sockets.some(s => s.readyState === 1 && s.url.includes('terminalId=default')), name, { timeout: 8000 });
}

(async () => {
  // Scrollbars are drawn (headless Chromium hides them by default), so the strip's own scrollbar takes its place as on a real screen.
  const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    // ── 1440x900: the whole cycle ──
    {
      const label = '1440x900';
      const { context, page } = await openPage(browser, { viewport: { width: 1440, height: 900 } });
      await shownTerminal(page, 'Terminal 1');
      const open = page.locator('#h5-columns-open');
      assert.equal(await open.getAttribute('aria-label'), 'Multi-column view', `${label}: the switch has its aria-label`);
      assert.equal(await open.getAttribute('title'), 'Multi-column view', `${label}: and the same title`);
      assert.equal(await open.getAttribute('aria-pressed'), 'false');
      assert.equal(await page.locator('#h5-columns').count(), 0, `${label}: the normal view at first`);

      // On: floor(1440 / 360) = 4 columns, each an iframe of /h5?pane=<id>, sharing the width evenly (4 x 360) with no sideways scrolling; the page
      // under it is hidden and holds no terminal socket.
      await open.click();
      await waitFrames(page, 4);
      const minWidth = await expectedMinWidth(page);
      assert.equal(minWidth, 360, `${label}: a quarter of the strip`);
      const four = await widthsBecome(page, 360);
      assert.ok(four.scroll <= four.client + 1 && !four.overflow, `${label}: four columns fit (${JSON.stringify(four)})`);
      assert.ok(four.widths.length === 4 && four.widths.every(w => Math.abs(w - 360) <= 1), `${label}: each 360px (${four.widths})`);
      assert.deepEqual(await edgesShown(page, []), [], `${label}: no edge shadow when nothing is hidden`);
      // A fifth column does not fit: the strip scrolls sideways instead of squeezing, and the new column was scrolled into view.
      await page.locator('#h5-columns-add').click();
      await waitFrames(page, 5);
      const ids = await frameIds(page);
      assert.equal(new Set(ids).size, 5, `${label}: five distinct ids (${ids})`);
      for (const src of await frameSrcs(page)) assert.match(src, PANE_URL, `${label}: an iframe of the page in pane mode`);
      assert.equal(await page.locator('#h5-app').isVisible(), false, `${label}: the normal page is hidden under the strip`);
      assert.equal(await page.locator('#h5-tasks').isVisible(), false, `${label}: and its sidebar`);
      assert.deepEqual(await openTerminalSockets(page), [], `${label}: the top page closed its terminal socket`);
      assert.deepEqual(await stored(page), { on: true, ids }, `${label}: mode and ids are remembered`);
      assert.equal(await page.locator('#h5-columns-toggle').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#h5-columns-toggle').getAttribute('title'), 'Multi-column view');
      assert.equal(await page.locator('#h5-columns-add').getAttribute('aria-label'), 'Add column');
      assert.equal(await page.locator('.h5-column-close').first().getAttribute('title'), 'Close column');
      // The close strip sits above each pane, not over it.
      const fit = await page.evaluate(() => {
        const strip = document.getElementById('h5-columns-strip');
        const column = document.querySelector('.h5-column');
        return { scroll: strip.scrollWidth, client: strip.clientWidth, left: strip.scrollLeft, width: column.getBoundingClientRect().width, bar: column.querySelector('.h5-column-bar').getBoundingClientRect().bottom, frame: column.querySelector('iframe').getBoundingClientRect().top, snap: getComputedStyle(strip).scrollSnapType };
      });
      assert.ok(fit.scroll > fit.client + 50, `${label}: five columns do not fit: the strip scrolls (${JSON.stringify(fit)})`);
      assert.ok(Math.abs(fit.width - minWidth) <= 1, `${label}: each stays a quarter of the strip, ${minWidth} (${fit.width})`);
      await page.waitForFunction(() => { const strip = document.getElementById('h5-columns-strip'); return strip.scrollLeft >= strip.scrollWidth - strip.clientWidth - 1; }, null, { timeout: 3000 });
      assert.ok(fit.bar <= fit.frame + 0.5, `${label}: the close strip is above the pane (${JSON.stringify(fit)})`);
      assert.equal(fit.snap, 'none', `${label}: no snapping (a small sideways scroll stays where it is)`);
      await page.evaluate(() => document.getElementById('h5-columns-strip').scrollTo({ left: 0 }));
      // No focus is taken on load by the top page: it calls no focus on an iframe. (The page inside each iframe is today the normal page, which
      // focuses its terminal when it shows one; pane mode must not do that on load. Then no column is [data-focused] until it is clicked.)
      assert.equal(await page.evaluate(() => window.frameFocusCalls), 0, `${label}: the top page focuses no column`);
      // The panes load (each is the page itself; the second agent makes it a pane).
      await page.waitForFunction(() => [...document.querySelectorAll('#h5-columns iframe')].every(el => el.contentDocument && el.contentDocument.getElementById('h5-app')), null, { timeout: 10000 });
      assert.equal(await page.locator('#h5-columns').count(), 1);
      for (const id of ids) assert.equal(await paneFrame(page, id).locator('#h5-columns, #h5-columns-open').count(), 0, `${label}: a pane never offers columns of its own`);
      assert.deepEqual(await openTerminalSockets(page), [], `${label}: still no terminal socket in the top page`);

      // Focus: a click into the second column focuses it (outline), then a click into the fifth (partly hidden) moves it there.
      await page.evaluate(() => document.getElementById('h5-columns-strip').scrollTo({ left: 200 }));
      await page.waitForFunction(() => document.getElementById('h5-columns-strip').scrollLeft === 200, null, { timeout: 3000 });
      const box = async index => (await page.locator('#h5-columns iframe').nth(index).boundingBox());
      let b = await box(1);
      await page.mouse.click(b.x + b.width / 2, b.y + 120);
      await page.waitForFunction(id => { const el = document.querySelector('.h5-column[data-focused]'); return el && el.dataset.paneId === id; }, ids[1], { timeout: 3000 });
      assert.equal(await page.locator('.h5-column[data-focused] .h5-column-outline').count(), 1, `${label}: the focused column has its outline`);
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.dataset.paneId), ids[1], `${label}: its iframe has the focus`);
      b = await box(4);
      await page.mouse.click(b.x + 60, b.y + 120); // the fifth column is partly hidden: a click on what shows of it focuses it
      await page.waitForFunction(id => { const el = document.querySelector('.h5-column[data-focused]'); return el && el.dataset.paneId === id; }, ids[4], { timeout: 3000 });
      // and scrolls it whole into view.
      await page.waitForFunction(() => { const strip = document.getElementById('h5-columns-strip'); const box = document.querySelector('.h5-column[data-focused]').getBoundingClientRect(); return box.right <= strip.getBoundingClientRect().right + 1; }, null, { timeout: 3000 });
      assert.equal(await page.locator('.h5-column[data-focused]').count(), 1, `${label}: one focused column`);

      // Messages: a pane about itself is read; one about another column, one from the top page and one from a foreign origin are ignored.
      const nameOf = index => page.locator('.h5-column-name').nth(index).textContent();
      assert.equal(await nameOf(0), 'Column 1');
      await paneFrame(page, ids[0]).evaluate(id => parent.postMessage({ type: 't-agent-pane', paneId: id, event: 'title', title: 'Fix login', session: 'Terminal 1' }, location.origin), ids[0]);
      await page.waitForFunction(() => document.querySelector('.h5-column-name').textContent === 'Fix login · Terminal 1', null, { timeout: 3000 });
      assert.equal(await page.locator('#h5-columns iframe').first().getAttribute('title'), 'Column 1: Fix login · Terminal 1');
      await paneFrame(page, ids[0]).evaluate(id => parent.postMessage({ type: 't-agent-pane', paneId: id, event: 'title', title: 'Spoofed' }, location.origin), ids[1]);
      await page.evaluate(id => window.postMessage({ type: 't-agent-pane', paneId: id, event: 'title', title: 'From the top' }, location.origin), ids[1]);
      await paneFrame(page, ids[0]).evaluate(id => parent.postMessage({ type: 't-agent-pane', paneId: id, event: 'ready' }, location.origin), ids[0]);
      await page.waitForFunction(id => document.querySelector(`.h5-column[data-pane-id="${id}"][data-ready]`), ids[0], { timeout: 3000 });
      assert.equal(await nameOf(1), 'Column 2', `${label}: a message about another column, or from the top page, is ignored`);
      // A pane's own 'focus' message is read. The real focus is still in the fifth column (clicked above), and the top page's own check of its active
      // element (every 300 ms) may not have seen that yet: when it does, it rightly moves the focus back to the fifth column. That check must have
      // nothing left to report, so the focus leaves the iframes first (a person using the first column would have moved it there too).
      await page.evaluate(() => document.activeElement.blur());
      await page.waitForFunction(() => document.activeElement === document.body, null, { timeout: 3000 });
      await paneFrame(page, ids[0]).evaluate(id => parent.postMessage({ type: 't-agent-pane', paneId: id, event: 'focus' }, location.origin), ids[0]);
      await page.waitForFunction(id => { const el = document.querySelector('.h5-column[data-focused]'); return el && el.dataset.paneId === id; }, ids[0], { timeout: 3000 });
      // The third column is sent to another origin (its window stays the iframe's), and posts from there.
      // Column 3's own pane has already said 'ready' (pane mode): forget it, so what follows shows whether the foreign page can set it.
      await page.evaluate(id => { const columns = window.H5UI.get().columns; window.H5UI.set({ columns: { ...columns, ready: { ...columns.ready, [id]: false } } }); }, ids[2]);
      await page.evaluate(([id, url]) => { document.querySelector(`#h5-columns iframe[data-pane-id="${id}"]`).src = url; }, [ids[2], `${FOREIGN}/page`]);
      await page.waitForFunction(() => true);
      let foreign = null;
      for (let i = 0; i < 50 && !foreign; i += 1) { foreign = page.frames().find(frame => frame.url().startsWith(FOREIGN)); if (!foreign) await page.waitForTimeout(100); }
      assert.ok(foreign, 'the foreign page loaded in the third column');
      await foreign.waitForLoadState();
      for (const event of ['title', 'focus', 'ready']) await foreign.evaluate(([id, kind]) => parent.postMessage({ type: 't-agent-pane', paneId: id, event: kind, title: 'Evil' }, '*'), [ids[2], event]);
      await paneFrame(page, ids[1]).evaluate(id => parent.postMessage({ type: 't-agent-pane', paneId: id, event: 'title', title: 'Write docs' }, location.origin), ids[1]);
      await page.waitForFunction(() => document.querySelectorAll('.h5-column-name')[1].textContent === 'Write docs', null, { timeout: 3000 });
      assert.equal(await nameOf(2), 'Column 3', `${label}: a foreign origin's title is ignored`);
      assert.equal(await page.locator(`.h5-column[data-pane-id="${ids[2]}"][data-ready]`).count(), 0, `${label}: and its ready`);
      assert.equal(await page.evaluate(() => document.querySelector('.h5-column[data-focused]').dataset.paneId), ids[0], `${label}: and its focus`);

      // Reload: the strip comes back with the same ids in the same order, and the top page opens no terminal socket at all (not even the early one).
      await page.evaluate(() => document.getElementById('h5-columns-strip').scrollTo({ left: 0 }));
      await page.reload();
      await waitFrames(page, 5);
      assert.deepEqual(await frameIds(page), ids, `${label}: a reload keeps mode, order and ids`);
      await page.waitForTimeout(1200);
      assert.equal(await terminalSocketCount(page), 0, `${label}: after the reload the top page never opened a terminal socket`);
      assert.equal(await page.evaluate(() => window.frameFocusCalls), 0, `${label}: no focus taken by the top page after the reload`);

      // Add: a new id at the end, scrolled into view.
      await page.evaluate(() => document.getElementById('h5-columns-strip').scrollTo({ left: 0 }));
      await page.locator('#h5-columns-add').click();
      await waitFrames(page, 6);
      const six = await frameIds(page);
      assert.deepEqual(six.slice(0, 5), ids);
      assert.equal(ids.includes(six[5]), false, `${label}: a new column gets a new id`);
      assert.deepEqual((await stored(page)).ids, six);
      const scroll = await page.evaluate(() => { const strip = document.getElementById('h5-columns-strip'); return { scroll: strip.scrollWidth, client: strip.clientWidth, left: strip.scrollLeft, width: document.querySelector('.h5-column').getBoundingClientRect().width }; });
      assert.ok(scroll.scroll >= 6 * minWidth - 2 && scroll.scroll > scroll.client + 50, `${label}: six columns do not fit: the strip scrolls sideways (${JSON.stringify(scroll)})`);
      assert.ok(Math.abs(scroll.width - minWidth) <= 1, `${label}: each a quarter of the strip (${scroll.width})`);
      await page.waitForFunction(() => { const strip = document.getElementById('h5-columns-strip'); return strip.scrollLeft >= strip.scrollWidth - strip.clientWidth - 1; }, null, { timeout: 3000 }); // the new one's smooth scroll ended
      // A sideways wheel over a column's bar moves the strip and it stays where it was moved (no snapping back).
      await page.evaluate(() => document.getElementById('h5-columns-strip').scrollTo({ left: 0 }));
      await page.waitForTimeout(300);
      const bar = await page.locator('.h5-column-bar').first().boundingBox();
      await page.mouse.move(bar.x + 60, bar.y + bar.height / 2);
      await page.mouse.wheel(300, 0);
      await page.waitForTimeout(900);
      const moved = await page.evaluate(() => document.getElementById('h5-columns-strip').scrollLeft);
      assert.ok(Math.abs(moved - 300) <= 2, `${label}: a sideways wheel over a bar scrolls the strip by its amount (${moved})`);

      // Close the second column: it gets 'forget' first; the other iframes stay the same elements (not reloaded); the id is forgotten.
      await page.evaluate(() => { window.forgets = []; document.querySelectorAll('#h5-columns iframe').forEach(el => { el.marker = el.dataset.paneId; }); });
      for (const id of six) {
        const frame = paneFrame(page, id);
        await frame.evaluate(own => window.addEventListener('message', event => { if (event.data && event.data.type === 't-agent-pane') parent.forgets.push([own, event.data.event, event.origin]); }), id);
      }
      await page.evaluate(() => document.getElementById('h5-columns-strip').scrollTo({ left: 0 }));
      await page.locator(`.h5-column[data-pane-id="${six[1]}"] .h5-column-close`).click();
      await waitFrames(page, 5);
      assert.deepEqual(await frameIds(page), six.filter(id => id !== six[1]));
      assert.deepEqual(await page.evaluate(() => window.forgets), [[six[1], 'forget', ORIGIN]], `${label}: the closed pane got 'forget' from this origin`);
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('#h5-columns iframe')].every(el => el.marker === el.dataset.paneId)), true, `${label}: the other columns were not reloaded`);
      assert.deepEqual((await stored(page)).ids, six.filter(id => id !== six[1]), `${label}: the closed id is forgotten`);
      // Close down to one: the last one cannot be closed.
      while ((await frameIds(page)).length > 1) {
        const left = await frameIds(page);
        await page.locator(`.h5-column[data-pane-id="${left.at(-1)}"] .h5-column-close`).click();
        await waitFrames(page, left.length - 1);
      }
      assert.equal(await page.locator('.h5-column-close').isDisabled(), true, `${label}: the last column cannot be closed`);
      await page.locator('.h5-column-close').click({ force: true });
      await page.waitForTimeout(400);
      assert.deepEqual(await frameIds(page), [six[0]]);
      const one = await frameIds(page);
      const width = await page.evaluate(() => document.querySelector('.h5-column').getBoundingClientRect().width);
      assert.ok(width > 1400, `${label}: one column takes the whole width (${width})`);

      // Off: the normal view again, showing the same terminal, connected again; the ids stay for the next time.
      await page.locator('#h5-columns-toggle').click();
      await page.locator('#h5-columns').waitFor({ state: 'detached' });
      await page.locator('#h5-app').waitFor({ state: 'visible' });
      await shownTerminal(page, 'Terminal 1');
      assert.equal(await page.locator('.h5-xterm:not([hidden])').count(), 1, `${label}: the terminal is shown again`);
      assert.equal((await openTerminalSockets(page)).length, 1, `${label}: one terminal socket again`);
      assert.deepEqual(await stored(page), { on: false, ids: one });
      await page.locator('#h5-columns-open').click();
      await waitFrames(page, 1);
      assert.deepEqual(await frameIds(page), one, `${label}: on again, the same columns`);
      await page.waitForTimeout(100);
      assert.deepEqual(await openTerminalSockets(page), []);

      // Below the wide breakpoint the strip and the switch go away and the normal page connects again; back above it the strip returns.
      await page.setViewportSize({ width: 800, height: 900 });
      await page.locator('#h5-columns').waitFor({ state: 'detached' });
      await shownTerminal(page, 'Terminal 1');
      assert.equal(await page.locator('#h5-columns-open').count(), 0, `${label}: no switch below the wide breakpoint`);
      await page.setViewportSize({ width: 1440, height: 900 });
      await waitFrames(page, 1);
      assert.deepEqual(await frameIds(page), one);
      await page.waitForTimeout(100);
      assert.deepEqual(await openTerminalSockets(page), [], `${label}: wide again: the socket is closed again`);
      await context.close();
    }

    // ── 1440x900, five columns: minimum width, scrollbar, edge shadows, sideways scrolling from inside a pane, keys, 12 at most ──
    {
      const label = 'scroll 1440x900';
      const ids5 = ['s1', 's2', 's3', 's4', 's5'];
      const storage = { ...REMEMBERED, 'h5-columns': JSON.stringify({ on: true, ids: ids5 }) };
      for (const id of ids5) { storage[`pane:${id}:h5-task:local`] = '1'; storage[`pane:${id}:h5-terminal:local:1`] = 'default'; }
      const { context, page } = await openPage(browser, { viewport: { width: 1440, height: 900 }, storage, scale: SHOTS ? 2 : 1 });
      await waitFrames(page, 5);
      await page.waitForFunction(() => [...document.querySelectorAll('#h5-columns iframe')].every(el => el.contentDocument && el.contentDocument.getElementById('h5-app')), null, { timeout: 10000 });
      const minWidth = await expectedMinWidth(page);
      assert.equal(minWidth, 360, `${label}: a quarter of the strip`);
      await widthsBecome(page, minWidth);
      let st = await stripState(page);
      assert.ok(st.widths.every(w => Math.abs(w - minWidth) <= 1), `${label}: each column is a quarter of the strip, ${minWidth} (${st.widths})`);
      assert.ok(st.scroll > st.client && st.scroll >= 5 * minWidth - 2, `${label}: the strip overflows (${JSON.stringify(st)})`);
      assert.equal(st.overflow, true, `${label}: data-overflow`);
      assert.equal(st.scrollClass, true, `${label}: the strip has its scrollbar class`);
      const bar = await page.evaluate(() => { const strip = document.getElementById('h5-columns-strip'); return strip.offsetHeight - strip.clientHeight; });
      assert.equal(bar, 10, `${label}: the strip draws its own 10px scrollbar, not an overlay one (${bar})`);
      assert.deepEqual(await edgesShown(page, ['right']), ['right'], `${label}: at the start only the right edge shadow`);
      // The pane's terminal is sized to its column (its resize message).
      const paneCols = await page.waitForFunction(() => {
        const win = document.querySelector('#h5-columns iframe[data-pane-id="s1"]').contentWindow;
        const sizes = (win.sockets || []).flatMap(s => s.sent).map(text => { try { return JSON.parse(text); } catch { return null; } }).filter(m => m && m.type === 'resize');
        return sizes.length ? sizes[sizes.length - 1].cols : 0;
      }, null, { timeout: 10000 });
      console.log(`${label}: the first pane's terminal has ${await paneCols.jsonValue()} columns`);
      assert.ok(await paneCols.jsonValue() >= 30, `${label}: the pane's terminal fills its column (${await paneCols.jsonValue()})`);

      // A sideways wheel inside the first pane (over its terminal) scrolls the strip; xterm does not see it.
      const frame1 = await page.locator('#h5-columns iframe[data-pane-id="s1"]').boundingBox();
      await page.mouse.move(frame1.x + frame1.width / 2, frame1.y + frame1.height / 2);
      // (At a device scale of 2 the browser reports half of Playwright's delta: the pane forwards what it got.)
      await paneFrame(page, 's1').evaluate(() => { window.wheels = []; window.addEventListener('wheel', event => window.wheels.push([event.deltaX, event.defaultPrevented]), true); }); // after the pane's own listener, same node and phase
      await page.mouse.wheel(250, 0);
      await page.waitForFunction(() => document.getElementById('h5-columns-strip').scrollLeft >= 100, null, { timeout: 3000 });
      st = await stripState(page);
      const seen = await paneFrame(page, 's1').evaluate(() => window.wheels);
      assert.equal(seen.length, 1, `${label}: one wheel event in the pane`);
      assert.ok(Math.abs(st.left - seen[0][0]) <= 2, `${label}: the strip moved by the wheel's amount (${st.left}, ${JSON.stringify(seen)})`);
      assert.equal(seen[0][1], true, `${label}: and the pane cancelled it (xterm and the browser do not act on it)`);
      assert.deepEqual(await edgesShown(page, ['left', 'right']), ['left', 'right'], `${label}: in the middle both edge shadows`);
      // A vertical wheel there does not move the strip.
      await page.evaluate(() => document.getElementById('h5-columns-strip').scrollTo({ left: 0 }));
      await page.waitForTimeout(100);
      await page.mouse.move(frame1.x + frame1.width / 2, frame1.y + frame1.height / 2);
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(500);
      assert.equal((await stripState(page)).left, 0, `${label}: a vertical wheel inside a pane leaves the strip alone`);
      // Shift+wheel over a column's bar scrolls the strip.
      const bar1 = await page.locator('.h5-column[data-pane-id="s1"] .h5-column-bar').boundingBox();
      await page.mouse.move(bar1.x + 60, bar1.y + bar1.height / 2);
      await page.keyboard.down('Shift');
      await page.mouse.wheel(0, 200);
      await page.keyboard.up('Shift');
      await page.waitForFunction(() => document.getElementById('h5-columns-strip').scrollLeft >= 50, null, { timeout: 3000 });
      // At the end: only the left shadow.
      await page.evaluate(() => { const strip = document.getElementById('h5-columns-strip'); strip.scrollTo({ left: strip.scrollWidth }); });
      assert.deepEqual(await edgesShown(page, ['left']), ['left'], `${label}: at the end only the left edge shadow`);

      // Ctrl+Alt+Right inside a pane: the focus moves to the next column, into its frame, and it is scrolled whole into view; the key never
      // reaches the first pane's terminal.
      await page.evaluate(() => document.getElementById('h5-columns-strip').scrollTo({ left: 0 }));
      await page.waitForTimeout(200);
      await page.mouse.click(frame1.x + frame1.width / 2, frame1.y + frame1.height / 2);
      await page.waitForFunction(() => { const el = document.querySelector('.h5-column[data-focused]'); return el && el.dataset.paneId === 's1'; }, null, { timeout: 3000 });
      const pane1 = paneFrame(page, 's1');
      const sentBefore = await pane1.evaluate(() => window.sockets.flatMap(s => s.sent).filter(text => !text.startsWith('{')).length);
      const focusOn = id => page.waitForFunction(want => { const el = document.querySelector('.h5-column[data-focused]'); return el && el.dataset.paneId === want; }, id, { timeout: 3000 });
      for (const id of ['s2', 's3', 's4', 's5']) { await page.keyboard.press('Control+Alt+ArrowRight'); await focusOn(id); }
      await page.waitForFunction(() => { const strip = document.getElementById('h5-columns-strip'); const r = document.querySelector('.h5-column[data-focused]').getBoundingClientRect(); return r.right <= strip.getBoundingClientRect().right + 1; }, null, { timeout: 3000 });
      st = await stripState(page);
      assert.equal(st.focusWhole, true, `${label}: the focused fifth column is whole in view (${JSON.stringify(st)})`);
      assert.ok(st.left > 0, `${label}: the strip scrolled to it`);
      assert.equal(st.active, 's5', `${label}: its frame has the focus`);
      assert.equal(await pane1.evaluate(() => window.sockets.flatMap(s => s.sent).filter(text => !text.startsWith('{')).length), sentBefore, `${label}: the key never reached the first pane's terminal`);
      // From inside the fifth pane (the focus is in its frame now) and from the top page: back to the first.
      await page.keyboard.press('Control+Alt+ArrowLeft');
      await focusOn('s4');
      await page.locator('#h5-columns-add').focus();
      for (const id of ['s3', 's2', 's1']) { await page.keyboard.press('Control+Alt+ArrowLeft'); await focusOn(id); }
      await page.waitForFunction(() => document.getElementById('h5-columns-strip').scrollLeft <= 1, null, { timeout: 3000 });

      if (SHOTS) {
        await page.evaluate(() => document.getElementById('h5-columns-strip').scrollTo({ left: 180 }));
        await page.waitForTimeout(800);
        fs.mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: path.join(SHOTS, 'columns-scroll-1440x900.png') });
        await page.evaluate(() => document.getElementById('h5-columns-strip').scrollTo({ left: 0 }));
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(SHOTS, 'columns-scroll-start-1440x900.png') });
      }

      // Adding a column scrolls it whole into view, smoothly (not in the same frame).
      await page.evaluate(() => document.getElementById('h5-columns-strip').scrollTo({ left: 0 }));
      await page.waitForTimeout(200);
      await page.locator('#h5-columns-add').click();
      await waitFrames(page, 6);
      await page.waitForFunction(() => { const strip = document.getElementById('h5-columns-strip'); const last = [...strip.querySelectorAll('.h5-column')].at(-1).getBoundingClientRect(); const box = strip.getBoundingClientRect(); return last.left >= box.left - 1 && last.right <= box.right + 1; }, null, { timeout: 3000 });
      const smooth = await page.evaluate(() => { const before = document.getElementById('h5-columns-strip').scrollLeft; window.H5UI.actions.stepColumn(-1); return [before, document.getElementById('h5-columns-strip').scrollLeft]; });
      assert.ok(smooth[0] > 0, `${label}: the new column was scrolled into view (${smooth})`);
      // 12 columns at most.
      while (!(await page.locator('#h5-columns-add').isDisabled())) await page.locator('#h5-columns-add').click();
      await waitFrames(page, 12);
      await page.locator('#h5-columns-add').click({ force: true });
      await page.waitForTimeout(200);
      assert.equal((await frameIds(page)).length, 12, `${label}: twelve columns, not thirteen`);
      assert.equal((await stored(page)).ids.length, 12);
      st = await stripState(page);
      assert.ok(st.widths.every(w => Math.abs(w - minWidth) <= 1), `${label}: twelve columns are each a quarter of the strip`);
      await context.close();
    }

    // ── Reduced motion: the strip scrolls at once ──
    {
      const label = 'reduced motion';
      const ids5 = ['r1', 'r2', 'r3', 'r4', 'r5'];
      const { context, page } = await openPage(browser, { viewport: { width: 1440, height: 900 }, storage: { ...REMEMBERED, 'h5-columns': JSON.stringify({ on: true, ids: ids5 }) }, reducedMotion: 'reduce' });
      await waitFrames(page, 5);
      const jump = await page.evaluate(() => {
        const strip = document.getElementById('h5-columns-strip');
        window.H5UI.actions.stepColumn(-1); // no focus: the last column
        return { left: strip.scrollLeft, max: strip.scrollWidth - strip.clientWidth };
      });
      assert.ok(jump.max > 0 && Math.abs(jump.left - jump.max) <= 1, `${label}: scrolled to the last column in the same frame (${JSON.stringify(jump)})`);
      await context.close();
      // Without it the same step is smooth: nothing has moved yet in the same frame.
      const normal = await openPage(browser, { viewport: { width: 1440, height: 900 }, storage: { ...REMEMBERED, 'h5-columns': JSON.stringify({ on: true, ids: ids5 }) } });
      await waitFrames(normal.page, 5);
      const glide = await normal.page.evaluate(() => { const strip = document.getElementById('h5-columns-strip'); window.H5UI.actions.stepColumn(-1); return strip.scrollLeft; });
      assert.ok(glide < 5, `motion: a smooth scroll (${glide} right after the step)`);
      await normal.page.waitForFunction(() => { const strip = document.getElementById('h5-columns-strip'); return strip.scrollLeft >= strip.scrollWidth - strip.clientWidth - 1; }, null, { timeout: 3000 });
      await normal.context.close();
    }

    // ── 1920x1080: first use opens 4 columns of 480px; a fifth scrolls; a window resize changes the widths; screenshot ──
    {
      const label = '1920x1080';
      const { context, page } = await openPage(browser, { viewport: { width: 1920, height: 1080 } });
      await shownTerminal(page, 'Terminal 1');
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'columns-header-1920.png'), clip: { x: 1320, y: 0, width: 600, height: 60 } }); }
      await page.locator('#h5-columns-open').click();
      await waitFrames(page, 4);
      for (const src of await frameSrcs(page)) assert.match(src, PANE_URL);
      const fit = await widthsBecome(page, 480);
      assert.ok(fit.scroll <= fit.client + 1 && !fit.overflow, `${label}: four columns fit (${JSON.stringify(fit)})`);
      assert.ok(fit.widths.length === 4 && fit.widths.every(w => Math.abs(w - 480) <= 1), `${label}: each a quarter, 480px (${fit.widths})`);
      assert.deepEqual(await openTerminalSockets(page), []);
      // A ?openChat= link while the strip is shown and no column is focused: the first column gets `open` once its
      // page has loaded; the hidden normal view still brings back its remembered terminal, shown when the strip is left.
      const shown = await frameIds(page);
      await page.goto(`${ORIGIN}/h5?openChat=1:conv-9`);
      await waitFrames(page, 4);
      await page.waitForFunction(() => (window.paneInbox || []).some(([, data]) => data.event === 'open'), null, { timeout: 10000 });
      assert.deepEqual(await opens(page), [[shown[0], { type: 't-agent-pane', event: 'open', sourceKey: 'local', taskId: 1, conversationId: 'conv-9' }, ORIGIN]], `${label}: the link went to the first column`);
      // (The outline is checked in the 1440 case: here the pages inside the columns, still the normal page until pane mode, take the focus on load.)
      await page.waitForTimeout(500);
      assert.equal(await terminalSocketCount(page), 0, `${label}: the top page opened no terminal socket`);
      await page.locator('#h5-columns-toggle').click();
      await shownTerminal(page, 'Terminal 1');
      assert.equal(await page.locator('#h5-agent').isVisible(), false, `${label}: the normal view did not open the chat`);
      await page.locator('#h5-columns-open').click();
      await waitFrames(page, 4);
      if (SHOTS) {
        await page.waitForFunction(() => [...document.querySelectorAll('#h5-columns iframe')].every(el => el.contentDocument && el.contentDocument.getElementById('h5-app')), null, { timeout: 10000 });
        await page.waitForTimeout(1500);
        const b = await page.locator('#h5-columns iframe').nth(1).boundingBox();
        await page.mouse.click(b.x + b.width / 2, b.y + 300);
        await page.waitForTimeout(500);
        fs.mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: path.join(SHOTS, 'columns-1920x1080.png') });
      }
      // A fifth column: the strip scrolls and each column stays a quarter (480px).
      await page.locator('#h5-columns-add').click();
      await waitFrames(page, 5);
      let wide = await widthsBecome(page, 480);
      assert.ok(wide.overflow && wide.scroll >= 5 * 480 - 2, `${label}: five columns overflow (${JSON.stringify(wide)})`);
      assert.ok(wide.widths.every(w => Math.abs(w - 480) <= 1), `${label}: each stays 480px (${wide.widths})`);
      // A narrower window: a quarter would be 250px, so each column is 360px; with three of them (1080px) the strip still overflows.
      await page.setViewportSize({ width: 1000, height: 800 });
      let narrow = await widthsBecome(page, 360);
      assert.equal(await expectedMinWidth(page), 360, `${label} -> 1000: never below 360`);
      assert.ok(narrow.widths.every(w => Math.abs(w - 360) <= 1), `${label} -> 1000: each 360px (${narrow.widths})`);
      while ((await frameIds(page)).length > 3) {
        const left = await frameIds(page);
        await page.locator(`.h5-column[data-pane-id="${left.at(-1)}"] .h5-column-close`).click();
        await waitFrames(page, left.length - 1);
      }
      narrow = await widthsBecome(page, 360);
      assert.ok(narrow.widths.length === 3 && narrow.widths.every(w => Math.abs(w - 360) <= 1), `${label} -> 1000: three columns of 360px (${narrow.widths})`);
      assert.ok(narrow.scroll > narrow.client && narrow.overflow, `${label} -> 1000: three columns overflow (${JSON.stringify(narrow)})`);
      // Wide again: the three share 1920px (640px each, more than a quarter).
      await page.setViewportSize({ width: 1920, height: 1080 });
      wide = await widthsBecome(page, 640);
      assert.ok(wide.widths.every(w => Math.abs(w - 640) <= 1) && !wide.overflow, `${label}: back to 1920, three share the width (${JSON.stringify(wide)})`);
      // And a fourth and fifth: a quarter each again.
      await page.locator('#h5-columns-add').click();
      await page.locator('#h5-columns-add').click();
      await waitFrames(page, 5);
      wide = await widthsBecome(page, 480);
      assert.ok(wide.widths.every(w => Math.abs(w - 480) <= 1) && wide.overflow, `${label}: five at 1920 are 480px each and scroll (${JSON.stringify(wide)})`);
      await context.close();
    }

    // ── Not offered: a phone, and a page in pane mode (even with the view remembered as on) ──
    {
      const on = { ...REMEMBERED, 'h5-columns': JSON.stringify({ on: true, ids: ['a1', 'b2'] }) };
      const { context, page } = await openPage(browser, { viewport: { width: 390, height: 844 }, touch: true, storage: on });
      await page.locator('#h5-app').waitFor({ state: 'visible' });
      await page.waitForTimeout(800);
      assert.equal(await page.locator('#h5-columns, #h5-columns-open').count(), 0, 'phone: no strip and no switch');
      await context.close();
      const pane = await openPage(browser, { viewport: { width: 1440, height: 900 }, storage: on, url: '/h5?pane=a1' });
      await pane.page.locator('#h5-app').waitFor({ state: 'visible' });
      await pane.page.waitForTimeout(800);
      assert.equal(await pane.page.locator('#h5-columns, #h5-columns-open').count(), 0, 'pane page: no strip and no switch');
      await pane.context.close();
    }

    assert.deepEqual(pageErrors, [], 'no page errors');
    console.log('h5 columns browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
