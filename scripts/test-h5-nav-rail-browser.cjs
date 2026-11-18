// The page's navigation rail and session header in the single view (Columns.jsx `NavRail`, Header.jsx), and the phone's task drawer with its
// destinations (TaskDrawer.jsx `TaskDrawer`, `DrawerNav`), in real Chromium with every route mocked. See "Navigation rail", "Page layout",
// "Session header" and "Phone drawer" in docs/design/page-navigation.md.
// - 1440x900: the rail at the left edge (a "Views" landmark, 72px, the whole height) with Sessions, Columns, Attention, Mind maps, then Update and
//   Settings; the layout right of it (task list 304px, then the 48px header); `aria-current` following the view (single view, Settings, the columns
//   view and its Mind maps tab, back); Attention toggling the T-Attention panel with its badge; Settings closed by another destination; arrow keys,
//   Home and End; the header's "More" menu (Refresh the page only) and no Update or columns switch in the header; the folded sidebar.
// - 390x844 (touch): no rail; the 56px app bar with the menu button, "More" with Refresh the page and Update (which opens the update dialog); the drawer
//   from the left at min(320px, 100vw - 56px) over a scrim, the page not moved, and no destination rows below the list (they are in the bottom navigation).
// H5_SHOT_DIR=<dir> saves the wide page and the open drawer.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const AT = new Date(Date.now() - 60000).toISOString();

const TASKS = [{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }, { id: 2, title: 'Write docs', status: 'doing' }];
const TERMINALS = { 1: [{ terminal_id: 'c1', title: 'Claude: login fix', agent: 'claude' }], 2: [{ terminal_id: 'd1', title: 'Docs shell' }] };
const ATTENTION = [
  { id: 1, title: 'Allow Bash', status: 'waiting_user', priority: 'none', source: 'claude', updated_at: AT, created_at: AT, context: { tagent: { task_id: '2', terminal_id: 'd1' } } }, // another session: the shown one is running, not waiting
  { id: 2, title: 'Refactor', status: 'working', priority: 'none', source: 'claude', updated_at: AT, created_at: AT },
];
const UPDATE = { status: 'available', local_version: '1.0.0', remote_version: '2.0.0', boot_id: 'b1', install_type: 'git', is_update_admin: true, log: [] };
const pageErrors = [];

async function openPage(browser, { viewport, touch = false }) {
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...(SHOTS ? { deviceScaleFactor: 2 } : {}) });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('h5-columns', JSON.stringify({ on: false }));
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1; window.WebSocket.CONNECTING = 0;
    window.EventSource = class extends EventTarget {
      constructor(url) { super(); this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; const event = new Event('open'); this.onopen?.(event); this.dispatchEvent(event); }, 50); }
      close() { this.readyState = 2; }
    };
  });
  await page.addInitScript(activityStreamMock);
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(p)) {
      const file = path.join(root, 'public', p);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(file) });
    }
    if (p === '/api/system/update-status' || p === '/api/system/check-update') return json(UPDATE);
    if (p === '/api/remote-servers') return json([]);
    if (p === '/api/tasks' && method === 'GET') return json(TASKS);
    if (p === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (p === '/api/tasks/terminal-activity') return json({ 1: { c1: 'running' } });
    if (p === '/api/tasks/terminal-subagents') return json({});
    const terminals = p.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (terminals && method === 'GET') return json(TERMINALS[terminals[1]] || []);
    if (/\/terminal\/(ack|control)$/.test(p)) return json({ success: true });
    if (/^\/api\/tasks\/\d+\/agent\/conversations$/.test(p)) return json([]);
    if (p === '/api/attention' && method === 'GET') return json({ items: ATTENTION, host: 'T01' });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  return { context, page };
}

const rect = (page, selector) => page.locator(selector).first().evaluate(el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) }; });
const current = page => page.evaluate(() => [...document.querySelectorAll('#h5-columns-nav [aria-current="page"]')].map(el => el.id));
const activeId = page => page.evaluate(() => document.activeElement && document.activeElement.id);
const ui = (page, key) => page.evaluate(name => { const value = window.H5UI.get()[name]; return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value; }, key);
// The terminal of task 1 runs (the pushed activity stream, h5-activity-stream-mock.cjs).
const pushRunning = page => page.waitForFunction(() => window.activityStream && window.activityStream.push('/api/tasks/terminal-activity/stream', { activity: { 1: { c1: 'running' } }, subagents: {} }), null, { timeout: 8000 });
async function openTerminal(page, task, terminal, how = 'click') {
  const row = page.locator('#h5-tasks .h5-terminal-main', { hasText: terminal });
  if (!(await row.count())) await page.locator('.h5-task-item', { hasText: task })[how]();
  await row[how]();
  await page.waitForFunction(name => document.getElementById('h5-session-name').textContent === name, terminal);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    // ── 1440x900: the rail in the single view ──
    {
      const { context, page } = await openPage(browser, { viewport: { width: 1440, height: 900 } });
      const nav = page.locator('#h5-columns-nav');
      await nav.waitFor({ state: 'visible' });
      await page.locator('#h5-tasks').waitFor({ state: 'visible' });
      await openTerminal(page, 'Fix login', 'Claude: login fix');
      assert.equal(await nav.evaluate(el => [el.tagName, el.getAttribute('aria-label')].join('|')), 'NAV|Views');
      assert.deepEqual(await rect(page, '#h5-columns-nav'), { x: 0, y: 0, w: 72, h: 900, right: 72 }, 'the rail: 72px at the left edge, the whole height');
      assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-nav-rail')), true);
      assert.deepEqual(await nav.evaluate(el => [...el.querySelectorAll('.h5-nav-item, #h5-update')].map(node => node.id)),
        ['h5-nav-sessions', 'h5-nav-columns', 'h5-nav-attention', 'h5-nav-maps', 'h5-update', 'h5-nav-settings'], 'the destinations, then Update and Settings');
      for (const [id, label] of [['h5-nav-sessions', 'Sessions'], ['h5-nav-columns', 'Columns'], ['h5-nav-maps', 'Mind maps']]) {
        assert.equal(await page.locator(`#${id}`).getAttribute('aria-label'), label);
        assert.equal(await page.locator(`#${id} .h5-nav-label`).textContent(), label, `${label}: a caption label under the icon`);
        assert.equal((await rect(page, `#${id}`)).h, 56, `${label}: 56px tall`);
      }
      for (const id of ['h5-update', 'h5-nav-settings']) {
        assert.equal(await page.locator(`#${id}`).getAttribute('aria-label'), await page.locator(`#${id}`).getAttribute('title'), `${id}: aria-label = title`);
        assert.equal((await rect(page, `#${id}`)).w, 48, `${id}: a 48px button`);
      }
      assert.ok((await rect(page, '#h5-nav-settings')).y > 800, 'Settings at the bottom');
      assert.deepEqual(await current(page), ['h5-nav-sessions'], 'the single view: Sessions is the current page');
      await page.locator('#h5-update[data-attention="true"]').waitFor({ timeout: 5000 });

      // The layout right of the rail: the task list (304px), then the header (48px), the terminal and the bottom row.
      const sidebar = await rect(page, '#h5-tasks');
      assert.equal(sidebar.x, 72, 'the task list starts at the rail');
      assert.equal(sidebar.w, 304, 'the task list is 304px');
      assert.equal((await rect(page, '#h5-app')).x, 376, 'the page starts after the rail and the list');
      assert.equal((await rect(page, '.h5-header')).h, 48, 'a dense 48px header');
      assert.equal((await rect(page, '#h5-terminal')).x, 376);
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--h5-terminal-left').trim()), '376px', 'the top sheets line up with the terminal');

      // The header: the state dot, the device-less names on one line, the agent's state; at the right Wide terminal and More only.
      await pushRunning(page);
      await page.locator('.h5-header .h5-header-dot[data-state="running"]').waitFor({ timeout: 5000 });
      assert.equal(await page.locator('#h5-task-name').textContent(), 'Fix login');
      assert.equal(await page.locator('#h5-session-name').textContent(), 'Claude: login fix');
      assert.equal(await page.locator('.h5-header .h5-header-hint').textContent(), 'Claude · running');
      const header = page.locator('.h5-header');
      assert.equal(await header.locator('#h5-update, #h5-columns-open, #h5-refresh').count(), 0, 'no Update, columns switch or refresh button in the header');
      assert.equal(await header.locator('#h5-sidebar-toggle').count(), 1, 'the fold toggle stays at the left');
      await page.locator('#h5-header-more').click();
      await page.locator('#h5-header-more-menu [role="menu"]').waitFor();
      assert.deepEqual(await page.locator('#h5-header-more-menu [role="menuitem"]').evaluateAll(items => items.map(el => [el.id, el.textContent])), [['h5-refresh', 'Refresh the page']], 'More holds Refresh the page');
      assert.equal(await page.locator('#h5-header-more-menu [role="menu"]').getAttribute('aria-label'), 'More');
      await page.keyboard.press('Escape');
      await page.locator('#h5-header-more-menu [role="menu"]').waitFor({ state: 'hidden' });
      assert.equal(await activeId(page), 'h5-header-more', 'the focus is back on More');

      // Attention: a red badge with the items that need the person; it shows and hides the panel and is active while it is open.
      await page.waitForFunction(() => document.getElementById('h5-nav-attention-count') && document.getElementById('h5-nav-attention-count').textContent === '1', null, { timeout: 8000 });
      assert.equal(await page.locator('#h5-nav-attention').getAttribute('aria-label'), 'Attention, 1 item needs you');
      assert.equal(await page.locator('#h5-nav-attention-count').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(244, 67, 54)', 'red, like the Columns badge');
      assert.equal(await page.locator('#h5-nav-attention').getAttribute('aria-expanded'), 'false');
      await page.locator('#h5-nav-attention').click();
      await page.locator('#h5-attention-sheet .h5-attention-panel').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#h5-nav-attention').getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('#h5-nav-attention').getAttribute('data-active'), '');
      const panel = await rect(page, '#h5-attention-sheet .h5-attention-panel');
      assert.equal((await rect(page, '#h5-app')).right, panel.x, 'the page ends where the panel starts');
      assert.deepEqual(await current(page), ['h5-nav-sessions'], 'the panel is not a page');
      await page.locator('#h5-nav-attention').click();
      await page.waitForFunction(() => !window.H5UI.get().attention.open);
      assert.equal(await page.locator('#h5-nav-attention').getAttribute('aria-expanded'), 'false');

      // Settings: current while open; another destination closes it first.
      await page.locator('#h5-nav-settings').click();
      await page.waitForFunction(() => window.H5UI.get().settingsOpen);
      await page.locator('#h5-settings').waitFor({ state: 'visible' });
      assert.deepEqual(await current(page), ['h5-nav-settings'], 'Settings is the current page while open');
      await page.locator('#h5-nav-attention').click();
      await page.waitForFunction(() => !window.H5UI.get().settingsOpen && window.H5UI.get().attention.open);
      assert.deepEqual(await current(page), ['h5-nav-sessions']);
      await page.locator('#h5-nav-attention').click();
      await page.waitForFunction(() => !window.H5UI.get().attention.open);
      await page.locator('#h5-nav-settings').click();
      await page.waitForFunction(() => window.H5UI.get().settingsOpen);
      await page.locator('#h5-nav-sessions').click();
      await page.waitForFunction(() => !window.H5UI.get().settingsOpen);
      assert.deepEqual(await current(page), ['h5-nav-sessions'], 'Sessions closed Settings');
      await page.locator('#h5-settings').waitFor({ state: 'hidden' });

      // Keyboard: arrows move between the destinations (Settings included, Update skipped), wrapping; Home and End.
      await page.locator('#h5-nav-sessions').focus();
      await page.keyboard.press('ArrowDown');
      assert.equal(await activeId(page), 'h5-nav-columns');
      await page.keyboard.press('ArrowRight');
      assert.equal(await activeId(page), 'h5-nav-attention');
      await page.keyboard.press('End');
      assert.equal(await activeId(page), 'h5-nav-settings');
      await page.keyboard.press('ArrowDown');
      assert.equal(await activeId(page), 'h5-nav-sessions', 'wraps to the first');
      await page.keyboard.press('ArrowUp');
      assert.equal(await activeId(page), 'h5-nav-settings', 'and back to the last');
      await page.keyboard.press('Home');
      assert.equal(await activeId(page), 'h5-nav-sessions');
      assert.equal(await ui(page, 'settingsOpen'), false, 'a move opens nothing');
      const ring = await page.locator('#h5-nav-sessions').evaluate(el => getComputedStyle(el).outlineStyle);
      assert.equal(ring, 'solid', 'a focus ring on the keyboard focus');
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'nav-rail-single.png') }); }

      // The folded task list: the page starts at the rail.
      await page.locator('#h5-sidebar-toggle').click();
      await page.waitForFunction(() => Math.round(document.getElementById('h5-app').getBoundingClientRect().left) === 72);
      assert.equal(await page.locator('#h5-tasks').count(), 0);
      await page.locator('#h5-sidebar-toggle').click();
      await page.waitForFunction(() => Math.round(document.getElementById('h5-app').getBoundingClientRect().left) === 376);

      // The columns view: the same rail above it, `aria-current` on its tab; Sessions brings the single view back.
      await page.locator('#h5-nav-columns').click();
      await page.locator('#h5-columns').waitFor({ state: 'visible' });
      assert.equal((await rect(page, '#h5-columns')).x, 72, 'the view starts right of the rail');
      assert.equal(await nav.isVisible(), true, 'the rail stays');
      assert.deepEqual(await current(page), ['h5-nav-columns']);
      await page.locator('#h5-nav-maps').click();
      await page.waitForFunction(() => window.H5UI.get().columns.tab === 'maps');
      assert.deepEqual(await current(page), ['h5-nav-maps']);
      await page.locator('#h5-nav-sessions').click();
      await page.locator('#h5-columns').waitFor({ state: 'detached' });
      assert.deepEqual(await current(page), ['h5-nav-sessions']);
      assert.equal((await ui(page, 'columns')).enabled, false);
      // The Mind maps destination from the single view enters the columns view on its Mind maps tab.
      await page.locator('#h5-nav-maps').click();
      await page.waitForFunction(() => window.H5UI.get().columns.shown && window.H5UI.get().columns.tab === 'maps');
      assert.deepEqual(await current(page), ['h5-nav-maps']);
      await page.locator('#h5-nav-sessions').click();
      await page.locator('#h5-columns').waitFor({ state: 'detached' });
      await context.close();
    }

    // ── 390x844 (touch): no rail; the app bar; the drawer ──
    {
      const { context, page } = await openPage(browser, { viewport: { width: 390, height: 844 }, touch: true });
      await page.locator('.h5-header').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#h5-columns-nav').isVisible(), false, 'no rail on a phone');
      assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-nav-rail')), false);
      assert.equal(await page.locator('#h5-update').count(), 1, 'the updater is still there (hidden with the rail)');
      if (!(await page.locator('#h5-tasks').isVisible())) await page.locator('#h5-open-tasks').tap();
      await page.locator('#h5-tasks').waitFor({ state: 'visible' });
      await openTerminal(page, 'Fix login', 'Claude: login fix', 'tap');
      await page.waitForFunction(() => !document.body.classList.contains('h5-tasks-open'));
      assert.equal((await rect(page, '.h5-header')).h, 56, 'a 56px app bar');
      const menu = page.locator('#h5-open-tasks');
      assert.equal(await menu.evaluate(el => el.tagName), 'BUTTON');
      assert.equal(await menu.getAttribute('aria-label'), 'Tasks');
      assert.equal(await menu.getAttribute('aria-haspopup'), 'dialog');
      assert.equal(await menu.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('#h5-task-name').textContent(), 'Fix login');
      assert.equal(await page.locator('#h5-session-name').textContent(), 'Claude: login fix');
      await pushRunning(page);
      await page.locator('.h5-header .h5-header-dot[data-state="running"]').waitFor({ timeout: 5000 });
      assert.equal(await page.locator('.h5-header .h5-header-state').textContent(), '· running');
      // More: Refresh the page and Update (with the red dot of a waiting update, also on the button).
      await page.locator('#h5-header-more[data-attention="true"]').waitFor({ timeout: 5000 });
      await page.locator('#h5-header-more').tap();
      await page.locator('#h5-header-more-menu [role="menu"]').waitFor();
      assert.deepEqual(await page.locator('#h5-header-more-menu [role="menuitem"]').evaluateAll(items => items.map(el => el.id)), ['h5-refresh', 'h5-header-update']);
      assert.equal(await page.locator('#h5-header-update').getAttribute('data-attention'), 'true');
      await page.waitForTimeout(400); // the menu's grow animation
      for (const item of await page.locator('#h5-header-more-menu [role="menuitem"]').all()) assert.ok((await item.evaluate(el => el.offsetHeight)) >= 44, 'menu items are 44px touch targets');
      await page.locator('#h5-header-update').tap();
      await page.locator('#h5-update-dialog [role="dialog"]').waitFor();
      await page.locator('#h5-update-dismiss').tap();
      await page.locator('#h5-update-dialog').waitFor({ state: 'hidden' });

      // The drawer: from the left, min(320px, 100vw - 56px), over a scrim; the page does not move.
      await menu.tap();
      await page.locator('#h5-tasks .MuiDrawer-paper').waitFor({ state: 'visible' });
      await page.waitForTimeout(400);
      const paper = await rect(page, '#h5-tasks .MuiDrawer-paper');
      assert.equal(paper.x, 0, 'from the left edge');
      assert.equal(paper.w, 320, 'min(320px, 100vw - 56px) at 390px');
      assert.equal(await menu.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.evaluate(() => document.body.classList.contains('h5-tasks-open')), true);
      assert.equal((await rect(page, '#h5-app')).x, 0, 'the page stays where it is');
      assert.equal(await page.locator('#h5-task-backdrop').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0.32)', 'the MD2 scrim');
      // The destinations are in the bottom navigation (scripts/test-h5-bottom-nav-browser.cjs), not below the list.
      assert.equal(await page.locator('#h5-tasks-nav').count(), 0, 'no destination rows below the list');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'nav-drawer-phone.png') });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const errors = pageErrors.filter(text => !/ResizeObserver loop/.test(text));
  assert.deepEqual(errors, [], 'no page errors');
  console.log('navigation rail, session header and phone drawer browser test passed');
})().catch(error => { console.error(error); process.exit(1); });
