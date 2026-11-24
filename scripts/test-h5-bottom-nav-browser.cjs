// The phone's bottom navigation (BottomNav.jsx, #h5-bnav), in real Chromium with every route mocked. See "Bottom navigation" in
// docs/design/page-navigation.md.
// - 390x844 (touch), Sessions with a terminal: the bar hidden by default behind its pull handle (#h5-bnav-handle, "Show navigation", 16px at the
//   bottom, the page keeping only that room), the handle's error-colour dot for the Attention count; a tap (or a swipe up) showing the bar over the page
//   without changing the terminal's box or its cols / rows; Escape, a tap outside, a swipe down, back and 6 seconds without a touch hiding it; choosing
//   Attention from it hiding it and opening T-Attention, the terminal keeping its size there and back.
// - 390x844 (touch): a "Views" landmark of 56px at the bottom with Sessions, Attention (#h5-attention, its red count in the name and the badge),
//   Mind maps and Settings; `aria-current` following the destination; each other destination (T-Attention, the full-window mind map, Settings) filling
//   the screen above the bar while the bar stays usable; a destination closing the one before, Sessions closing all; the back button returning to
//   Sessions; arrow keys; the key row (44px) and the seven tools (48px row) of Sessions; the bar hidden while the terminal keyboard (Osk) is shown,
//   while the draft box has the focus and while the system keyboard is up, the terminal's rows growing then and coming back after; the drawer's scrim
//   over the bar, and no destination rows below the task list.
// - 1440x900: no bar (the rail is there). A pane of the multi-column view: no bar, and its drawer keeps Mind maps and Settings rows.
// H5_SHOT_DIR=<dir> saves the terminal page and T-Attention with the bar.
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

async function openPage(browser, { viewport, touch = false, url = '/h5' }) {
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
    if (p === '/parent') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><iframe id="pane" src="/h5?pane=abc1" style="width:390px;height:844px;border:0"></iframe>' });
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
  await page.goto(`${ORIGIN}${url}`);
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


const barTop = page => page.locator('#h5-bnav').evaluate(el => Math.round(el.getBoundingClientRect().top));
// The bar is on the screen (with its room kept on a destination page, or over the session page while peeking from the handle).
const shown = page => page.evaluate(() => { const el = document.getElementById('h5-bnav'); return Boolean(el) && getComputedStyle(el).display !== 'none'; });
const handleShown = page => page.evaluate(() => Boolean(document.getElementById('h5-bnav-handle')));
// On the session page the bar is behind its pull handle: show it first, then tap the destination.
async function reveal(page) {
  if (!(await handleShown(page))) return;
  await page.locator('#h5-bnav-handle').tap();
  await page.waitForFunction(() => getComputedStyle(document.getElementById('h5-bnav')).display !== 'none');
}
const navTap = async (page, selector) => { await reveal(page); await page.locator(selector).tap(); };
// A one-finger swipe on an element, as touch events (Playwright has no swipe).
const swipe = (page, selector, dy) => page.locator(selector).evaluate((el, delta) => {
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const touch = clientY => new Touch({ identifier: 1, target: el, clientX: x, clientY });
  el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [touch(y)], changedTouches: [touch(y)] }));
  el.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [touch(y + delta)], changedTouches: [touch(y + delta)] }));
  el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], changedTouches: [touch(y + delta)] }));
}, dy);
const resizes = page => page.evaluate(() => window.sockets.filter(s => s.url.includes('/terminal/ws')).flatMap(s => s.sent).filter(item => /"type":"resize"/.test(item)).length);
// The terminal's rows: those of the last resize the page sent on the terminal socket.
const rows = page => page.evaluate(() => { const sent = window.sockets.filter(s => s.url.includes('/terminal/ws')).flatMap(s => s.sent).map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(item => item && item.type === 'resize'); return sent.length ? sent.at(-1).rows : 0; });
const view = page => page.evaluate(() => document.querySelector('#h5-bnav [aria-current="page"]')?.dataset.view || null);

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    // ── 390x844 (touch) ──
    {
      const { context, page } = await openPage(browser, { viewport: { width: 390, height: 844 }, touch: true });
      await page.locator('.h5-header').waitFor({ state: 'visible' });
      if (!(await page.locator('#h5-tasks').isVisible())) await page.locator('#h5-open-tasks').tap();
      await page.locator('#h5-tasks').waitFor({ state: 'visible' });
      await openTerminal(page, 'Fix login', 'Claude: login fix', 'tap');
      await page.waitForFunction(() => !document.body.classList.contains('h5-tasks-open'));
      await page.waitForFunction(() => window.sockets.some(s => s.url.includes('/terminal/ws') && s.readyState === 1));
      await page.evaluate(() => window.sockets.filter(s => s.url.includes('/terminal/ws')).at(-1).onmessage?.({ data: JSON.stringify({ type: 'history', data: 'ready $ ', cols: 40, rows: 20 }) }));
      await page.waitForTimeout(400);

      // Sessions with a terminal: the bar is hidden behind its pull handle, and the page keeps only the handle's 16px.
      const nav = page.locator('#h5-bnav');
      const handle = page.locator('#h5-bnav-handle');
      assert.equal(await shown(page), false, 'the bar is hidden on the session page');
      assert.equal(await page.evaluate(() => [document.documentElement.hasAttribute('data-bnav'), document.documentElement.hasAttribute('data-bnav-handle')].join()), 'false,true');
      assert.equal(await handle.evaluate(el => [el.tagName, el.getAttribute('aria-label'), el.getAttribute('title')].join('|')), 'BUTTON|Show navigation|Show navigation');
      assert.deepEqual(await rect(page, '#h5-bnav-handle'), { x: 0, y: 844 - 16, w: 390, h: 16, right: 390 }, 'a 16px strip at the bottom');
      const grip = await rect(page, '#h5-bnav-handle .h5-bnav-grip');
      assert.ok(grip.w === 40 && grip.h === 4 && Math.abs(grip.x + 20 - 195) <= 1, `a centred 4 x 40px bar (${JSON.stringify(grip)})`);
      const bottomArea = await rect(page, '#h5-bottom');
      assert.ok(Math.abs(bottomArea.y + bottomArea.h - (844 - 16)) <= 0.5, `the bottom area ends on the handle (${JSON.stringify(bottomArea)})`);
      await page.waitForFunction(() => document.querySelector('#h5-bnav-handle .h5-bnav-handle-dot'), null, { timeout: 8000 });
      assert.equal(await page.locator('#h5-bnav-handle .h5-bnav-handle-dot').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(244, 67, 54)', 'the Attention count shows as a red dot');
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'bnav-handle.png') }); }
      // A tap shows the bar over the page: the terminal keeps its box, its rows and columns (no resize is sent).
      const term = await rect(page, '#h5-terminal');
      const sentBefore = await resizes(page);
      await handle.tap();
      await page.waitForFunction(() => getComputedStyle(document.getElementById('h5-bnav')).display !== 'none');
      assert.equal(await handleShown(page), false, 'the handle gives way to the bar');
      assert.deepEqual(await rect(page, '#h5-bnav'), { x: 0, y: 844 - 56, w: 390, h: 56, right: 390 }, 'the bar over the bottom of the page');
      assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-bnav')), false, 'no room taken');
      await page.waitForTimeout(400);
      assert.deepEqual(await rect(page, '#h5-terminal'), term, 'the terminal box does not change');
      assert.equal(await resizes(page), sentBefore, 'no resize is sent');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'bnav-peek.png') });
      // Escape hides it.
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => getComputedStyle(document.getElementById('h5-bnav')).display === 'none' && document.getElementById('h5-bnav-handle'));
      // A swipe up on the handle shows it; a swipe down on the bar hides it.
      await swipe(page, '#h5-bnav-handle', -40);
      await page.waitForFunction(() => window.H5UI.get().navPeek === true);
      await swipe(page, '#h5-bnav', 40);
      await page.waitForFunction(() => window.H5UI.get().navPeek === false);
      // A tap outside it hides it.
      await reveal(page);
      await page.touchscreen.tap(195, 300);
      await page.waitForFunction(() => window.H5UI.get().navPeek === false);
      // The back button hides it, and the page is not left.
      await reveal(page);
      await page.waitForTimeout(300); // the layer's history entry is pushed
      await page.evaluate(() => history.back());
      await page.waitForFunction(() => window.H5UI.get().navPeek === false);
      await page.waitForTimeout(300);
      assert.equal(page.url(), `${ORIGIN}/h5`, 'back only hid the bar');
      // Six seconds without a touch hide it.
      await reveal(page);
      await page.waitForTimeout(5000);
      assert.equal(await ui(page, 'navPeek'), true, 'still shown after 5 seconds');
      await page.waitForFunction(() => window.H5UI.get().navPeek === false, null, { timeout: 3000 });
      assert.equal(await resizes(page), sentBefore, 'still no resize');
      // The keyboard: Enter on the handle shows the bar and puts the focus on the current destination; Escape gives it back to the handle.
      await handle.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'h5-bnav-sessions');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => window.H5UI.get().navPeek === false && document.activeElement && document.activeElement.id === 'h5-bnav-handle');
      // Choosing Attention hides the bar and opens T-Attention; the terminal keeps its size there and back.
      await navTap(page, '#h5-attention');
      await page.waitForFunction(() => window.H5UI.get().attention.open && !window.H5UI.get().navPeek);
      await page.locator('#h5-attention-sheet .h5-attention-panel').waitFor({ state: 'visible' });
      assert.equal(await shown(page), true, 'the bar is shown, with its room, over T-Attention');
      assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-bnav')), true);
      await page.waitForTimeout(400);
      await page.locator('#h5-attention-close').tap();
      await page.waitForFunction(() => !window.H5UI.get().attention.open && document.getElementById('h5-bnav-handle'));
      await page.waitForTimeout(400);
      assert.deepEqual(await rect(page, '#h5-terminal'), term, 'the same terminal box after T-Attention');
      assert.equal(await resizes(page), sentBefore, 'no resize for going to T-Attention and back');

      // The bar (shown from the handle): a landmark at the bottom, five destinations, Sessions current; no drawer rows below the task list any more.
      await reveal(page);
      assert.equal(await nav.evaluate(el => [el.tagName, el.getAttribute('aria-label')].join('|')), 'NAV|Views');
      assert.deepEqual(await rect(page, '#h5-bnav'), { x: 0, y: 844 - 56, w: 390, h: 56, right: 390 }, '56px at the bottom, the whole width');
      assert.deepEqual(await nav.evaluate(el => [...el.querySelectorAll('.h5-bnav-item')].map(node => [node.id, node.querySelector('.h5-bnav-label').textContent])),
        [['h5-bnav-sessions', 'Sessions'], ['h5-attention', 'Attention'], ['h5-bnav-maps', 'Mind maps'], ['h5-bnav-learn', 'Learn'], ['h5-bnav-settings', 'Settings']]);
      assert.equal(await page.locator('#h5-attention').count(), 1, 'one #h5-attention in the page');
      assert.equal(await view(page), 'sessions');
      assert.equal(await page.locator('#h5-bnav-sessions .h5-bnav-label').evaluate(el => getComputedStyle(el).color), 'rgb(144, 202, 249)', 'the current one in the primary colour');
      assert.equal((await rect(page, '#h5-app')).h, 844);
      // Sessions: the key row (44px) and the seven tools (a 48px row, 44px targets), without T-Attention.
      assert.equal((await rect(page, '#h5-keys')).h, 44, 'the key row is 44px');
      const tools = await page.locator('#h5-actions > button, #h5-actions > label').evaluateAll(nodes => nodes.filter(el => getComputedStyle(el).display !== 'none').map(el => ({ id: el.id || el.dataset.action, h: el.getBoundingClientRect().height })));
      assert.equal(tools.length, 7, `seven tools (${JSON.stringify(tools)})`);
      assert.ok(tools.every(tool => tool.h >= 44) && !tools.some(tool => tool.id === 'h5-attention'), 'no T-Attention tool; 44px targets');
      assert.ok(Math.abs((await rect(page, '#h5-actions')).h - 49) <= 1, 'the tool row is 48px (and its 1px divider)');
      // The badge: the same count as the rail's.
      await page.waitForFunction(() => document.querySelector('#h5-attention .h5-attention-badge .MuiBadge-badge')?.textContent === '1', null, { timeout: 8000 });
      assert.equal(await page.locator('#h5-attention').getAttribute('aria-label'), 'Attention (1)');
      assert.equal(await page.locator('#h5-attention').getAttribute('title'), 'Attention (1)');
      assert.equal(await page.locator('#h5-attention .MuiBadge-badge').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(244, 67, 54)', 'red, like the rail');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'bnav-terminal.png') });
      // Arrow keys move between the items.
      await page.locator('#h5-bnav-sessions').focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await activeId(page), 'h5-attention');
      await page.keyboard.press('End');
      assert.equal(await activeId(page), 'h5-bnav-settings');
      await page.keyboard.press('ArrowRight');
      assert.equal(await activeId(page), 'h5-bnav-sessions', 'wraps');
      await page.evaluate(() => document.activeElement.blur());

      // T-Attention fills the screen above the bar; the bar stays usable.
      const top = await barTop(page);
      await page.locator('#h5-attention').tap();
      await page.locator('#h5-attention-sheet .h5-attention-panel').waitFor({ state: 'visible' });
      await page.waitForTimeout(400);
      const sheet = await rect(page, '#h5-attention-sheet .h5-attention-panel');
      assert.ok(sheet.y <= 0.5 && Math.abs(sheet.y + sheet.h - top) <= 1, `T-Attention ends at the bar (${JSON.stringify(sheet)}, bar at ${top})`);
      assert.equal(await view(page), 'attention');
      assert.equal(await shown(page), true, 'the bar stays over T-Attention');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'bnav-attention.png') });
      // Mind maps: T-Attention goes; the map fills the screen above the bar.
      await page.locator('#h5-bnav-maps').tap();
      await page.waitForFunction(() => window.H5UI.get().mindmapOpen && !window.H5UI.get().attention.open);
      await page.locator('#h5-mindmap').waitFor({ state: 'visible' });
      const map = await rect(page, '#h5-mindmap');
      assert.ok(map.y <= 0.5 && Math.abs(map.y + map.h - top) <= 1, `the mind map ends at the bar (${JSON.stringify(map)})`);
      assert.equal(await view(page), 'maps');
      // Settings: the map goes; Settings ends at the bar.
      await page.locator('#h5-bnav-settings').tap();
      await page.waitForFunction(() => window.H5UI.get().settingsOpen && !window.H5UI.get().mindmapOpen);
      await page.locator('#h5-settings').waitFor({ state: 'visible' });
      await page.waitForTimeout(500);
      const settings = await page.locator('#h5-settings .MuiPaper-root').first().evaluate(el => { const r = el.getBoundingClientRect(); return { bottom: Math.round(r.bottom), top: Math.round(r.top) }; });
      assert.ok(Math.abs(settings.bottom - top) <= 1 && settings.top >= 0, `Settings ends at the bar (${JSON.stringify(settings)})`);
      assert.equal(await page.locator('#h5-mindmap').isVisible(), false);
      assert.equal(await view(page), 'settings');
      // Over the Settings modal the bar stays usable: not hidden from assistive technology, and a focus that comes into it stays there.
      assert.equal(await nav.getAttribute('aria-hidden'), null, 'the bar is not aria-hidden over Settings');
      await page.locator('#h5-bnav-maps').focus();
      await page.waitForTimeout(300);
      assert.equal(await activeId(page), 'h5-bnav-maps', 'the modal does not take the focus back from the bar');
      await page.keyboard.press('ArrowLeft');
      assert.equal(await activeId(page), 'h5-attention', 'the arrow keys move along the bar over Settings');
      await page.locator('#h5-settings-group-tasks-files').focus();
      // A group's page (#h5-settings-page) ends at the bar too; back returns to the group list, then to Sessions.
      await page.locator('#h5-settings-group-tasks-files').tap();
      await page.locator('#h5-settings-page .MuiDialog-paper').waitFor({ state: 'visible' });
      await page.waitForTimeout(500);
      const group = await page.locator('#h5-settings-page .MuiDialog-paper').evaluate(el => { const r = el.getBoundingClientRect(); return { bottom: Math.round(r.bottom), top: Math.round(r.top), left: Math.round(r.left) }; });
      assert.ok(Math.abs(group.bottom - top) <= 1 && group.top >= 0 && group.left === 0, `a group's page ends at the bar (${JSON.stringify(group)})`);
      assert.equal(await shown(page), true, 'the bar stays over a group page');
      await page.waitForTimeout(300);
      await page.evaluate(() => history.back());
      await page.waitForFunction(() => document.getElementById('h5-settings-page').classList.contains('MuiModal-hidden'));
      assert.equal(await page.evaluate(() => window.H5UI.get().settingsOpen), true, 'back from a group page returns to the group list');
      await page.waitForTimeout(300);
      await page.evaluate(() => history.back());
      await page.waitForFunction(() => !window.H5UI.get().settingsOpen);
      assert.equal(await view(page), 'sessions', 'back from the group list returns to Sessions');
      await navTap(page, '#h5-bnav-settings');
      await page.waitForFunction(() => window.H5UI.get().settingsOpen);
      await page.waitForTimeout(400);
      // Sessions closes it.
      await page.locator('#h5-bnav-sessions').tap();
      await page.waitForFunction(() => !window.H5UI.get().settingsOpen);
      await page.locator('#h5-settings').waitFor({ state: 'hidden' });
      assert.equal(await view(page), 'sessions');
      // T-Attention's back arrow returns to Sessions.
      await navTap(page, '#h5-attention');
      await page.locator('#h5-attention-close').waitFor({ state: 'visible' });
      await page.waitForTimeout(400);
      await page.locator('#h5-attention-close').tap();
      await page.waitForFunction(() => !window.H5UI.get().attention.open);
      await page.waitForFunction(() => document.querySelector('#h5-bnav [aria-current="page"]')?.dataset.view === 'sessions');
      await page.waitForTimeout(400);
      // Back on a destination returns to Sessions.
      for (const [id, isOpen] of [['#h5-attention', () => window.H5UI.get().attention.open], ['#h5-bnav-settings', () => window.H5UI.get().settingsOpen], ['#h5-bnav-maps', () => window.H5UI.get().mindmapOpen]]) {
        await navTap(page, id);
        await page.waitForFunction(isOpen);
        await page.waitForTimeout(400); // the layer's history entry is pushed
        await page.evaluate(() => history.back());
        await page.waitForFunction(fn => !new Function(`return (${fn})()`)(), isOpen.toString());
        await page.waitForFunction(() => document.querySelector('#h5-bnav [aria-current="page"]')?.dataset.view === 'sessions');
        await page.waitForTimeout(400);
      }
      assert.equal(page.url(), `${ORIGIN}/h5`, 'the page itself was not left');

      // The bar steps aside: the terminal keyboard, the draft box, the system keyboard. The terminal refits each time.
      const before = await rows(page);
      assert.ok(before > 0, 'the terminal has rows');
      await page.locator('#h5-actions [data-action="draft"]').tap();
      await page.waitForFunction(() => window.H5UI.get().keyboard === 'draft');
      await page.waitForFunction(() => !document.getElementById('h5-bnav-handle'));
      assert.equal(await shown(page), false, 'hidden while the draft box has the focus');
      assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-bnav-handle')), true, 'the room of the handle is kept while typing');
      await page.evaluate(() => document.activeElement.blur());
      await page.waitForFunction(() => document.getElementById('h5-bnav-handle'));
      await page.waitForTimeout(400);
      assert.equal(await rows(page), before, 'the terminal has its rows back with the bar');
      await page.locator('#h5-actions [data-action="keyboard"]').tap();
      await page.locator('#h5-osk').waitFor({ state: 'visible' });
      assert.equal(await shown(page), false, 'hidden while the terminal keyboard is shown');
      assert.equal(await handleShown(page), false, 'and so is the handle');
      const oskBottom = await page.locator('#h5-osk').evaluate(el => Math.round(el.getBoundingClientRect().bottom));
      assert.ok(oskBottom >= 844 - 1, `the terminal keyboard reaches the bottom (${oskBottom})`);
      await page.locator('#h5-actions [data-action="keyboard"]').tap();
      await page.locator('#h5-osk').waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.getElementById('h5-bnav-handle'));
      await page.waitForTimeout(400);
      assert.equal(await rows(page), before, 'and after the terminal keyboard');
      // The system keyboard: a field that raises one has the focus and the visual viewport becomes much shorter.
      const growth = await page.evaluate(() => window.H5UI.get().softKeyboard);
      assert.equal(growth, false);
      await navTap(page, '#h5-attention');
      await page.locator('#h5-attention-sheet input').first().waitFor({ state: 'visible' });
      await page.locator('#h5-attention-sheet input').first().focus();
      await page.setViewportSize({ width: 390, height: 500 });
      await page.waitForFunction(() => window.H5UI.get().softKeyboard === true, null, { timeout: 5000 });
      assert.equal(await shown(page), false, 'hidden while the system keyboard is up');
      await page.evaluate(() => document.activeElement.blur());
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => window.H5UI.get().softKeyboard === false, null, { timeout: 5000 });
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-bnav'));
      await page.locator('#h5-bnav-sessions').tap();
      await page.waitForFunction(() => !window.H5UI.get().attention.open);
      await page.waitForTimeout(500);
      assert.equal(await rows(page), before, 'the same rows after the system keyboard');

      // The drawer: its scrim lies over the bar, which cannot be used meanwhile; no destination rows below the list.
      await page.locator('#h5-open-tasks').tap();
      await page.locator('#h5-tasks .MuiDrawer-paper').waitFor({ state: 'visible' });
      await page.waitForTimeout(400);
      assert.equal(await page.locator('#h5-tasks-nav, #h5-tasks-settings, #h5-tasks-attention, #h5-tasks-mindmap').count(), 0, 'no destination rows in the drawer');
      assert.equal(await nav.evaluate(el => el.inert), true, 'the bar is inert under the drawer');
      const hit = await page.evaluate(() => { const el = document.elementFromPoint(370, 844 - 28); return Boolean(el && el.closest('#h5-bnav')); });
      assert.equal(hit, false, 'the scrim covers the bar');
      await page.locator('#h5-task-backdrop').tap({ position: { x: 375, y: 400 } });
      await page.waitForFunction(() => !document.body.classList.contains('h5-tasks-open'));
      assert.equal(await nav.evaluate(el => el.inert), false);
      await context.close();
    }

    // ── 1440x900: the rail, no bar ──
    {
      const { context, page } = await openPage(browser, { viewport: { width: 1440, height: 900 } });
      await page.locator('#h5-columns-nav').waitFor({ state: 'visible' });
      assert.equal(await shown(page), false, 'no bar on the wide layout');
      assert.equal(await page.locator('#h5-attention').count(), 1, 'one #h5-attention (the More tools item)');
      assert.equal(await page.locator('#h5-bnav #h5-attention').count(), 0);
      await context.close();
    }

    // ── A pane of the multi-column view: no bar; its drawer keeps Mind maps and Settings ──
    {
      const { context, page } = await openPage(browser, { viewport: { width: 400, height: 860 }, touch: true, url: '/parent' });
      const frame = page.frameLocator('#pane');
      await frame.locator('#h5-app').waitFor({ state: 'visible' });
      await page.waitForTimeout(800);
      assert.equal(await frame.locator('#h5-bnav').count(), 0, 'no bar in a pane');
      if (!(await frame.locator('#h5-tasks').isVisible())) await frame.locator('#h5-open-tasks').tap().catch(() => {});
      await frame.locator('#h5-tasks-settings').waitFor({ state: 'visible', timeout: 8000 });
      assert.equal(await frame.locator('#h5-tasks-mindmap').count(), 1);
      assert.equal(await frame.locator('#h5-tasks-attention').count(), 0, 'a pane has no T-Attention');
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const errors = pageErrors.filter(text => !/ResizeObserver loop/.test(text));
  assert.deepEqual(errors, [], 'no page errors');
  console.log('phone bottom navigation browser test passed');
})().catch(error => { console.error(error); process.exit(1); });
