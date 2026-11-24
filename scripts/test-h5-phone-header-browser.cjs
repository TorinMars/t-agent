// The room in the phone's session header ("Session header" in docs/design/page-navigation.md), in real Chromium with every route mocked: this machine
// with an instance id and a task order (so the header shows its engine tag), one task with a running Claude session whose name is long, and plan usage
// for Claude and Codex.
// - 390x844 (touch): the 56px app bar holds Tasks, the names, "Plan usage" (one 48px button, Claude's bars above Codex's) and More; no "Wide terminal"
//   in the bar. The names get at least 230px; the engine tag is not shrunk and does not overlap the session name, which ends with an ellipsis; "· running"
//   is whole. More starts with the terminal width ("Terminal width: Fit to screen" with a ›): it replaces the menu with the width choices (Fit to
//   screen, 200, 500, 1000, 2000 columns, the current one ticked) and a Back row; a choice sizes the PTY (2000 columns reach the socket) and the screen.
// - 320x640: nothing in the header overlaps or runs past its line.
// - 1440x900 (pointer): the computer's header as before: the width switch in the bar before "Plan usage" (its name now says the current width, its
//   menu ticks the current choice), the bars in one row, More with Refresh only.
// H5_SHOT_DIR=<dir> saves the headers and the menus.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const LOCAL_ID = '6c1d1c1e-0000-4000-8000-0000000000c1';
const SESSION = 'SELF AGENT DEV with a long session name';
const pageErrors = [];

const windows = (now, five, seven) => [
  { id: '5h', label: '5h', usedPercent: five, resetsAt: now + 3 * 3600000 },
  { id: '7d', label: '7d', usedPercent: seven, resetsAt: now + 4 * 86400000 },
];
const USAGE = now => ({ engine: { instance_id: LOCAL_ID, name: 'T01' }, agents: [
  { agent: 'claude', state: 'ok', account: 'aaaaaaaaaaaa', read_at: now - 60000, windows: windows(now, 44, 20) },
  { agent: 'codex', state: 'ok', account: 'cccccccccccc', read_at: now - 60000, windows: windows(now, 2, 22) },
] });

async function openPage(browser, { viewport, touch = false }) {
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), deviceScaleFactor: SHOTS ? 3 : 1 });
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
    if (p === '/api/system/version') return json({ app_version: '2.159.1', boot_id: 'b1', engine_name: 'T01', instance_id: LOCAL_ID });
    if (p === '/api/task-order') return json({ order: [], updated_at: 1 });
    if (p === '/api/task-list/hidden-devices') return json({ hidden: [] });
    if (p === '/api/remote-servers') return json([]);
    if (p === '/api/agent-usage') return json(USAGE(Date.now()));
    if (p === '/api/tasks' && method === 'GET') return json([{ id: 1, title: 'SELF-TAGENT', status: 'doing', work_dir: '/work/self' }]);
    if (p === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (p === '/api/tasks/terminal-activity') return json({ 1: { c1: 'running' } });
    if (p === '/api/tasks/terminal-subagents') return json({});
    if (p === '/api/tasks/1/terminals' && method === 'GET') return json([{ terminal_id: 'c1', title: SESSION, agent: 'claude' }]);
    if (/\/terminal\/(ack|control)$/.test(p)) return json({ success: true });
    if (/^\/api\/tasks\/\d+\/agent\/conversations$/.test(p)) return json([]);
    if (p === '/api/system/check-update' || p === '/api/system/update-status') return json({ status: 'up_to_date', local_version: '1.0.0' });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  const press = locator => (touch ? locator.tap() : locator.click());
  const row = page.locator('#h5-tasks .h5-terminal-main', { hasText: SESSION });
  if (touch && !(await page.locator('#h5-tasks').isVisible())) await page.locator('#h5-open-tasks').tap();
  await page.locator('#h5-tasks').waitFor({ state: 'visible' });
  if (!(await row.count())) await press(page.locator('.h5-task-item', { hasText: 'SELF-TAGENT' }));
  await press(row);
  await page.waitForFunction(name => document.getElementById('h5-session-name').textContent === name, SESSION);
  await page.waitForFunction(() => window.sockets.some(ws => ws.readyState === 1) && document.querySelector('.h5-xterm:not([hidden]) .xterm-rows'));
  await page.locator('#h5-usage .h5-usage-bar').first().waitFor();
  await page.locator('#h5-task-service > .h5-device-tag').waitFor();
  await page.waitForFunction(() => window.activityStream && window.activityStream.push('/api/tasks/terminal-activity/stream', { activity: { 1: { c1: 'running' } }, subagents: {} }), null, { timeout: 8000 });
  await page.locator('.h5-header .h5-header-dot[data-state="running"]').waitFor({ timeout: 5000 });
  await settle(page);
  return { context, page, press };
}

const settle = page => page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity));
// Every box of the header that the checks compare, read in one step.
const header = page => page.evaluate(() => {
  const box = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const bar = document.querySelector('.h5-header');
  const name = document.getElementById('h5-session-name');
  const tag = document.querySelector('#h5-task-service > .h5-device-tag');
  const state = document.querySelector('.h5-header .h5-header-state');
  const usage = document.getElementById('h5-usage');
  return {
    bar: box(bar), overflow: bar.scrollWidth - bar.clientWidth,
    title: box(document.getElementById('h5-task-name').parentElement), task: box(document.getElementById('h5-task-name')),
    subline: box(document.querySelector('.h5-task-subline')), service: box(document.getElementById('h5-task-service')), tag: box(tag),
    tagCut: tag ? tag.scrollWidth - tag.clientWidth : null,
    name: box(name), nameCut: name.scrollWidth - name.clientWidth, nameEllipsis: getComputedStyle(name).textOverflow,
    state: box(state), stateText: state ? state.textContent : null, stateCut: state ? state.scrollWidth - state.clientWidth : null,
    usage: box(usage), more: box(document.getElementById('h5-header-more')), width: box(document.querySelector('.h5-header #h5-term-width')),
    rows: [...usage.querySelectorAll('.h5-usage-agent')].map(node => ({ agent: node.dataset.agent, ...box(node) })),
    bars: [...usage.querySelectorAll('.h5-usage-bar')].map(node => [node.getBoundingClientRect().width, node.getBoundingClientRect().height]),
  };
});
const shot = async (page, name, selector) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await (selector ? page.locator(selector) : page).screenshot({ path: path.join(SHOTS, name) });
};
const resizes = page => page.evaluate(() => window.sockets.flatMap(ws => ws.sent).map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(item => item && item.type === 'resize').map(item => item.cols));
const widthPref = page => page.evaluate(() => { const width = window.H5UI.get().terminalWidth; return width ? `${width.mode}${width.mode === 'wide' ? ` ${width.cols}` : ''}` : null; });

// The phone's line of the names: the tag whole and before the name, the name cut with an ellipsis, "· running" whole and after it, all on the line.
function checkLine(g, label) {
  assert.ok(g.overflow <= 0, `${label}: nothing runs past the bar (${g.overflow})`);
  assert.ok(g.tag && g.tagCut <= 0, `${label}: the engine tag is whole (${g.tagCut})`);
  assert.ok(g.service.right <= g.tag.right + 0.5 && g.service.left <= g.tag.left + 0.5, `${label}: the tag stays inside its box (${JSON.stringify([g.service, g.tag])})`);
  assert.ok(g.tag.right <= g.name.left + 0.5, `${label}: the tag does not overlap the session name (${JSON.stringify([g.tag, g.name])})`);
  assert.ok(g.name.width > 20, `${label}: the session name keeps some room (${g.name.width})`);
  assert.ok(g.nameCut > 0 && g.nameEllipsis === 'ellipsis', `${label}: a long name ends with an ellipsis (${g.nameCut}, ${g.nameEllipsis})`);
  assert.equal(g.stateText, '· running', `${label}: the state text`);
  assert.ok(g.stateCut <= 0 && g.name.right <= g.state.left + 0.5 && g.state.right <= g.subline.right + 0.5, `${label}: "· running" is whole, after the name (${JSON.stringify([g.name, g.state, g.subline])})`);
  assert.ok(g.subline.right <= g.title.right + 0.5 && g.task.right <= g.title.right + 0.5, `${label}: the lines stay inside the title block`);
  assert.ok(g.title.right <= g.usage.left + 0.5 && g.usage.right <= g.more.left + 0.5, `${label}: the title, Plan usage and More do not overlap (${JSON.stringify([g.title, g.usage, g.more])})`);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    // ── 390x844 (touch) ──
    {
      const { context, page, press } = await openPage(browser, { viewport: { width: 390, height: 844 }, touch: true });
      assert.equal(await page.evaluate(() => document.documentElement.dataset.input), 'touch');
      const g = await header(page);
      console.log(`390px: the title block is ${g.title.width}px wide`);
      assert.equal(g.bar.height, 56, 'a 56px app bar');
      assert.equal(g.width, null, 'no "Wide terminal" in the phone app bar');
      assert.deepEqual(await page.evaluate(() => [...document.querySelector('.h5-header .MuiToolbar-root').children].map(node => node.id || node.className.split(' ')[0])).then(ids => ids.filter(id => /^h5-/.test(id))),
        ['h5-open-tasks', 'h5-usage', 'h5-header-more'], 'Tasks, the names, Plan usage and More');
      assert.ok(g.title.width >= 230, `the names get at least 230px (${g.title.width})`);
      checkLine(g, '390');
      // Plan usage: one 48px button (44px high), Claude's row above Codex's, each centred, bars of 3 x 14px.
      assert.equal(g.usage.width, 48, `Plan usage is 48px wide (${g.usage.width})`);
      assert.ok(g.usage.height >= 44, `a 44px target (${g.usage.height})`);
      assert.deepEqual(g.rows.map(item => item.agent), ['claude', 'codex']);
      assert.ok(g.rows[0].bottom <= g.rows[1].top + 0.5, `Claude's row above Codex's (${JSON.stringify(g.rows)})`);
      for (const item of g.rows) assert.ok(item.left >= g.usage.left && item.right <= g.usage.right && Math.abs((item.left + item.right) / 2 - (g.usage.left + g.usage.right) / 2) < 1.5, `${item.agent}: centred in the button`);
      assert.ok(g.bars.length === 8 && g.bars.every(([w, h]) => w === 3 && h === 14), `eight bars of 3 x 14px (${JSON.stringify(g.bars)})`);
      await shot(page, 'phone-header-390.png', '.h5-header');

      // More: the terminal width first; it shows the width choices with a Back row; a choice sizes the PTY and the screen.
      await press(page.locator('#h5-header-more'));
      await page.locator('#h5-header-more-menu [role="menu"]').waitFor();
      assert.deepEqual(await page.locator('#h5-header-more-menu [role="menuitem"]').evaluateAll(items => items.map(el => el.id)), ['h5-term-width', 'h5-header-remember', 'h5-refresh', 'h5-header-update']);
      const item = page.locator('#h5-term-width');
      assert.equal(await item.textContent(), 'Terminal width: Fit to screen');
      assert.equal(await item.locator('svg').count(), 2, 'its icon and the ›');
      assert.equal(await item.getAttribute('aria-haspopup'), 'menu');
      assert.equal(await item.getAttribute('data-mode'), 'fit');
      await settle(page);
      for (const el of await page.locator('#h5-header-more-menu [role="menuitem"]').all()) assert.ok((await el.evaluate(node => node.offsetHeight)) >= 44, 'menu items are 44px touch targets');
      await shot(page, 'phone-more-menu-390.png');
      const fitCols = (await resizes(page)).at(-1);
      await press(item);
      const menu = page.locator('#h5-term-width-menu');
      await menu.locator('[role="menu"]').waitFor();
      await page.locator('#h5-header-more-menu').waitFor({ state: 'detached' });
      assert.deepEqual(await menu.locator('[role="menuitem"], [role="menuitemradio"]').allTextContents(),
        ['Back', 'Fit to screen', '200 columns, scroll sideways', '500 columns, scroll sideways', '1000 columns, scroll sideways', '2000 columns, scroll sideways']);
      const ticked = () => menu.locator('[role="menuitemradio"]').evaluateAll(items => items.filter(el => el.getAttribute('aria-checked') === 'true').map(el => [el.textContent, el.querySelectorAll('svg').length]));
      assert.deepEqual(await ticked(), [['Fit to screen', 1]], 'the current width is ticked');
      assert.equal(await menu.locator('[role="menuitemradio"][aria-checked="false"] svg').count(), 0, 'no tick on the others');
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.closest('#h5-term-width-menu') !== null), true, 'the focus is in the width list');
      await settle(page);
      for (const el of await menu.locator('[role="menuitem"], [role="menuitemradio"]').all()) assert.ok((await el.evaluate(node => node.offsetHeight)) >= 44, 'width items are 44px touch targets');
      await shot(page, 'phone-width-menu-390.png');
      // Back: the More menu again.
      await press(page.locator('#h5-term-width-back'));
      await page.locator('#h5-header-more-menu [role="menu"]').waitFor();
      await menu.waitFor({ state: 'detached' });
      await press(page.locator('#h5-term-width'));
      await menu.locator('[role="menu"]').waitFor();
      await press(menu.locator('[data-cols="2000"]'));
      await menu.waitFor({ state: 'detached' });
      await page.waitForFunction(() => window.sockets.flatMap(ws => ws.sent).some(item => item.includes('"cols":2000')));
      assert.equal(await widthPref(page), 'wide 2000');
      await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden])').classList.contains('h5-wide'));
      const screen = await page.evaluate(() => { const el = document.querySelector('.h5-xterm:not([hidden])'); return { content: el.querySelector('.xterm-screen').offsetWidth, visible: el.clientWidth }; });
      assert.ok(screen.content > screen.visible * 2, `the terminal is wider than the view (${JSON.stringify(screen)})`);
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'h5-header-more', 'the focus is back on More');
      // Again: the item says the width, the list ticks 2000; 500 works too; Fit to screen goes back to the columns that fit.
      await press(page.locator('#h5-header-more'));
      await page.locator('#h5-term-width[data-mode="wide"]').waitFor();
      assert.equal(await page.locator('#h5-term-width').textContent(), 'Terminal width: 2000 columns');
      await shot(page, 'phone-more-menu-wide-390.png');
      await press(page.locator('#h5-term-width'));
      await menu.locator('[role="menu"]').waitFor();
      assert.deepEqual(await ticked(), [['2000 columns, scroll sideways', 1]]);
      assert.equal(await menu.locator('.Mui-selected').getAttribute('data-cols'), '2000');
      await press(menu.locator('[data-cols="500"]'));
      await menu.waitFor({ state: 'detached' });
      await page.waitForFunction(() => window.sockets.flatMap(ws => ws.sent).map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(item => item && item.type === 'resize').at(-1)?.cols === 500);
      await press(page.locator('#h5-header-more'));
      await page.locator('#h5-term-width', { hasText: 'Terminal width: 500 columns' }).waitFor();
      await press(page.locator('#h5-term-width'));
      await menu.locator('[role="menu"]').waitFor();
      await press(menu.locator('[role="menuitemradio"]', { hasText: 'Fit to screen' }));
      await menu.waitFor({ state: 'detached' });
      await page.waitForFunction(cols => window.sockets.flatMap(ws => ws.sent).map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(item => item && item.type === 'resize').at(-1)?.cols === cols, fitCols);
      assert.equal(await widthPref(page), 'fit');
      // Escape closes the width list without a change.
      await press(page.locator('#h5-header-more'));
      await press(page.locator('#h5-term-width'));
      await menu.locator('[role="menu"]').waitFor();
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
      assert.equal(await widthPref(page), 'fit');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll at 390px');

      // ── 320x640: nothing overlaps ──
      await page.setViewportSize({ width: 320, height: 640 });
      await page.waitForTimeout(200);
      const narrow = await header(page);
      console.log(`320px: the title block is ${narrow.title.width}px wide`);
      checkLine(narrow, '320');
      assert.equal(narrow.usage.width, 48, 'Plan usage stays 48px at 320');
      await shot(page, 'phone-header-320.png', '.h5-header');
      await context.close();
    }

    // ── 1440x900 (pointer): the computer's header is unchanged ──
    {
      const { context, page } = await openPage(browser, { viewport: { width: 1440, height: 900 } });
      const g = await header(page);
      assert.equal(g.bar.height, 48, 'the 48px bar');
      assert.ok(g.width, '"Wide terminal" is in the bar');
      assert.equal(await page.evaluate(() => [document.getElementById('h5-term-width').nextElementSibling.id, document.getElementById('h5-usage').nextElementSibling.id].join(' ')), 'h5-usage h5-header-more',
        'Wide terminal, Plan usage, More');
      assert.equal(await page.locator('#h5-term-width').getAttribute('aria-pressed'), 'false');
      assert.equal(await page.locator('#h5-term-width').getAttribute('aria-label'), 'Terminal width: Fit to screen', 'its name says the current width');
      assert.equal(await page.locator('#h5-term-width').getAttribute('title'), 'Terminal width: Fit to screen');
      assert.equal(g.rows.length, 2);
      assert.ok(Math.abs(g.rows[0].top - g.rows[1].top) < 1 && g.rows[0].right <= g.rows[1].left, `the bars in one row (${JSON.stringify(g.rows)})`);
      assert.ok(g.bars.every(([w, h]) => w === 4 && h === 20), `bars of 4 x 20px (${JSON.stringify(g.bars)})`);
      assert.ok(g.tag.right <= g.task.left + 0.5 && g.tagCut <= 0, `the tag is whole and before the task name (${JSON.stringify([g.tag, g.task])})`);
      await page.locator('#h5-header-more').click();
      await page.locator('#h5-header-more-menu [role="menu"]').waitFor();
      assert.deepEqual(await page.locator('#h5-header-more-menu [role="menuitem"]').evaluateAll(items => items.map(el => el.id)), ['h5-header-remember', 'h5-refresh'], 'More: Remember this (a session is shown) and Refresh');
      await page.keyboard.press('Escape');
      await page.locator('#h5-header-more-menu').waitFor({ state: 'detached' });
      // The bar's switch still works: a click to Wide, a right click for the choices.
      await page.locator('#h5-term-width').click();
      await page.waitForFunction(() => document.getElementById('h5-term-width').getAttribute('aria-pressed') === 'true');
      assert.equal(await page.locator('#h5-term-width').getAttribute('aria-label'), 'Terminal width: 200 columns', 'a tap gives the default 200');
      await page.locator('#h5-term-width').click({ button: 'right' });
      await page.locator('#h5-term-width-menu [role="menu"]').waitFor();
      assert.equal(await page.locator('#h5-term-width-back').count(), 0, 'no Back row on a computer');
      assert.equal(await page.locator('#h5-term-width-menu [role="menuitemradio"]').count(), 5);
      assert.deepEqual(await page.locator('#h5-term-width-menu [role="menuitemradio"][aria-checked="true"]').evaluateAll(items => items.map(el => [el.dataset.cols, el.querySelectorAll('svg').length])), [['200', 1]], 'the current choice is ticked');
      await shot(page, 'computer-width-menu-1440.png');
      await page.locator('#h5-term-width-menu [data-cols="1000"]').click();
      await page.waitForFunction(() => window.sockets.flatMap(ws => ws.sent).some(item => item.includes('"cols":1000')));
      assert.equal(await page.locator('#h5-term-width').getAttribute('title'), 'Terminal width: 1000 columns');
      await page.locator('#h5-term-width').click({ button: 'right' });
      await page.locator('#h5-term-width-menu [role="menuitemradio"]', { hasText: 'Fit to screen' }).click();
      await page.waitForFunction(() => document.getElementById('h5-term-width').getAttribute('aria-pressed') === 'false');
      await shot(page, 'computer-header-1440.png', '.h5-header');
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const errors = pageErrors.filter(text => !/ResizeObserver loop/.test(text));
  assert.deepEqual(errors, [], 'no page errors');
  console.log('phone header browser test passed');
})().catch(error => { console.error(error); process.exit(1); });
