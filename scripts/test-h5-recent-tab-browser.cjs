// The Recent tab of the task list (RecentList.jsx, "Recent tab" in docs/design/page-task-list.md) in real Chromium with mocked servers, on a computer
// (1440x900, the permanent sidebar) and a phone (390x844, touch, the drawer): the two tabs By task and Recent under the title, the arrow keys between
// them, the chosen tab remembered across a reload; the empty state; the rows of the recent sessions in the switcher's order (the shown one first and
// selected, then the most recently used) with their name, device tag, task, state and time; the search field and the Running / Needs you chips with
// their counts applied to the rows; a click opens the session (on a phone it closes the drawer) and the selected row follows it; the "⋯" menu of a row
// with Rename in place; Expand all / Collapse all disabled on Recent.
// H5_SHOT_DIR=<dir> saves screenshots there (computer: Recent and By task; phone: the drawer on Recent).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';

const TASKS = [{ id: 1, title: 'Fix login', status: 'doing' }, { id: 2, title: 'Write docs', status: 'doing' }, { id: 3, title: 'Never opened', status: 'doing' }];
const TERMINALS = {
  1: [{ terminal_id: 'default', title: 'Terminal 1' }, { terminal_id: 'c1', title: 'Claude work', agent: 'claude' }],
  2: [{ terminal_id: 'd1', title: 'Docs shell' }],
  3: [{ terminal_id: 'n1', title: 'Idle shell' }],
};
const REMOTE_TASKS = [{ id: 5, title: 'Build server', status: 'doing' }];
const REMOTE_TERMINALS = { 5: [{ terminal_id: 'k1', title: 'Build shell' }] };
// Write docs / Docs shell finished and was not seen (it needs the person); K01's build shell runs.
const ACTIVITY = { 2: { d1: 'done' } };
const REMOTE_ACTIVITY = { 5: { k1: 'running' } };
const GROUPS = [{ key: 'doing', name: 'In progress', sort_order: 1 }];

async function openPage(browser, viewport, { touch }) {
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...(SHOTS ? { deviceScaleFactor: touch ? 3 : 1 } : {}) });
  const page = await context.newPage();
  const errors = [];
  const renames = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.FakeSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ type: 'history', data: '$ ', cols: 60, rows: 20 }) }); }, 0); }
      send() {}
      close() { this.readyState = 3; }
    };
    window.FakeSocket.OPEN = 1;
    window.FakeSocket.CONNECTING = 0;
    window.WebSocket = window.FakeSocket;
  });
  await page.route(`${ORIGIN}/**`, route => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
    if (p === '/api/remote-servers') return json([{ id: 7, name: 'K01', status: 'online', base_url: 'http://10.0.0.7:14002', enabled: true }]);
    if (p === '/api/tasks' && method === 'GET') return json(TASKS);
    if (p === '/api/remote-servers/7/tasks' && method === 'GET') return json(REMOTE_TASKS);
    if (p === '/api/task-groups' || p === '/api/remote-servers/7/task-groups') return json(GROUPS);
    if (p === '/api/tasks/terminal-activity') return json(ACTIVITY);
    if (p === '/api/remote-servers/7/terminal-activity') return json(REMOTE_ACTIVITY);
    if (/terminal-subagents$/.test(p)) return json({});
    if (/\/terminal\/ack$/.test(p)) return json({ success: true });
    const rename = p.match(/^\/api\/tasks\/(\d+)\/terminals\/([^/]+)$/);
    if (rename && method === 'PATCH') {
      const body = JSON.parse(route.request().postData() || '{}');
      renames.push({ task: rename[1], terminal: rename[2], title: body.title });
      const row = (TERMINALS[rename[1]] || []).find(item => item.terminal_id === rename[2]);
      if (row) row.title = body.title;
      return json({ terminal_id: rename[2], title: body.title });
    }
    const local = p.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (local && method === 'GET') return json(TERMINALS[local[1]] || []);
    const remote = p.match(/^\/api\/remote-servers\/7\/tasks\/(\d+)\/terminals$/);
    if (remote && method === 'GET') return json(REMOTE_TERMINALS[remote[1]] || []);
    if (p === '/api/remote-servers/7/info') return json({ capabilities: [] });
    if (/\/agent\/conversations$/.test(p)) return json([]);
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  return { context, page, errors, renames };
}

const waitShown = (page, task, terminal) => page.waitForFunction(([name, id]) => document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId === id
  && document.getElementById('h5-task-name').textContent === name, [task, terminal], { timeout: 10000 });
async function visit(page, ref, terminal, task) {
  await page.evaluate(([r, id]) => window.H5UI.actions.openRow(r, { kind: 'terminal', id }), [ref, terminal]);
  await waitShown(page, task, terminal);
}
// Four sessions, oldest first: Fix login / Terminal 1, Write docs / Docs shell, K01 Build server / Build shell, Fix login / Claude work (shown).
async function visitAll(page) {
  await page.waitForFunction(() => (window.H5UI.get().taskList.tasks || []).length === 4, null, { timeout: 15000 });
  await visit(page, 'local|1', 'default', 'Fix login');
  await visit(page, 'local|2', 'd1', 'Write docs');
  await visit(page, 'remote:7|5', 'k1', 'Build server');
  await visit(page, 'local|1', 'c1', 'Fix login');
  await page.waitForFunction(() => window.H5UI.get().recent.length === 4);
}
const tabs = page => page.evaluate(() => [...document.querySelectorAll('#h5-task-tabs [role="tab"]')].map(tab => {
  const box = tab.getBoundingClientRect();
  return { id: tab.id, text: tab.textContent, selected: tab.getAttribute('aria-selected') === 'true', tabIndex: tab.tabIndex, width: Math.round(box.width), height: Math.round(box.height) };
}));
const rows = page => page.evaluate(() => [...document.querySelectorAll('#h5-recent-list .h5-recent-row')].map(row => ({
  key: row.dataset.key, status: row.dataset.status, current: row.dataset.current === 'true',
  name: row.querySelector('.h5-recent-name')?.textContent, task: row.querySelector('.h5-recent-task')?.textContent || '',
  tag: row.querySelector('.h5-device-tag')?.textContent || '', state: row.querySelector('.h5-recent-state')?.textContent,
  when: row.querySelector('.h5-recent-when')?.textContent || '', height: Math.round(row.getBoundingClientRect().height),
  more: Number(getComputedStyle(row.querySelector('.h5-recent-more')).opacity), selectedBg: getComputedStyle(row).boxShadow.includes('inset'),
})));
const keys = async page => (await rows(page)).map(row => row.key);
const waitKeys = (page, want) => page.waitForFunction(list => [...document.querySelectorAll('#h5-recent-list .h5-recent-row')].map(row => row.dataset.key).join() === list.join(), want, { timeout: 10000 });
const chip = (page, key) => page.locator(`#h5-tasks .h5-task-filters [data-filter="${key}"]`);
const ORDER = ['local|1|c1', 'remote:7|5|k1', 'local|2|d1', 'local|1|default'];

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    // ── Computer ──
    {
      const { context, page, errors, renames } = await openPage(browser, { width: 1440, height: 900 }, { touch: false });
      await page.locator('#h5-task-tabs').waitFor({ state: 'visible' });
      let list = await tabs(page);
      assert.deepEqual(list.map(tab => [tab.id, tab.text, tab.selected, tab.tabIndex]), [['h5-tab-tasks', 'By task', true, 0], ['h5-tab-recent', 'Recent', false, -1]], 'two tabs, By task first and chosen');
      assert.ok(Math.abs(list[0].width - list[1].width) <= 1 && list[0].width > 140, `two equal tabs over the full width: ${JSON.stringify(list)}`);
      assert.ok(list[0].height >= 40, 'tabs are 40px tall on a computer');
      const order = await page.evaluate(() => {
        const y = id => document.getElementById(id).getBoundingClientRect().top;
        return { title: y('h5-tasks-title'), tabs: y('h5-task-tabs'), search: y('h5-task-search-input') };
      });
      assert.ok(order.title < order.tabs && order.tabs < order.search, `the tabs are under the title and above the search: ${JSON.stringify(order)}`);
      await page.locator('#h5-task-list').waitFor();

      // Empty state, before any session was shown.
      await page.locator('#h5-tab-recent').click();
      await page.locator('#h5-recent-empty').waitFor();
      assert.match(await page.locator('#h5-recent-empty').textContent(), /No recent sessions yet/);
      assert.equal(await page.locator('#h5-task-list').count(), 0, 'the By task list is not drawn on Recent');
      assert.equal(await page.locator('#h5-recent-list').getAttribute('role'), 'tabpanel');

      // Sessions shown while the tab is open appear at once, the shown one first.
      await visitAll(page);
      await waitKeys(page, ORDER);
      let seen = await rows(page);
      assert.deepEqual(seen.map(row => [row.name, row.task, row.state, row.status]), [
        ['Claude work', 'Fix login', '· Idle', 'idle'],
        ['Build shell', 'Build server', '· Running', 'running'],
        ['Docs shell', 'Write docs', '· Needs you', 'waiting'],
        ['Terminal 1', 'Fix login', '· Idle', 'idle'],
      ], 'names, tasks, states');
      assert.ok(seen.every(row => row.tag), `every row has its device tag: ${JSON.stringify(seen.map(row => row.tag))}`);
      assert.equal(seen[1].tag, 'K01', 'the other engine is named');
      assert.equal(seen[0].when, 'Current', 'the shown session says Current');
      assert.ok(seen.slice(1).every(row => row.when === 'just now'), `the others say when they were used: ${seen.map(row => row.when)}`);
      assert.deepEqual(seen.map(row => row.current), [true, false, false, false]);
      assert.ok(seen[0].selectedBg && !seen[1].selectedBg, 'the shown session has the selected look');
      assert.ok(seen.every(row => row.height >= 52 && row.height <= 64), `rows are about 56px: ${seen.map(row => row.height)}`);
      assert.equal(seen[1].more, 0, 'the "⋯" is hidden until hover or focus on a computer');
      assert.equal(await page.locator('#h5-recent-caption').textContent(), 'Sessions you used, most recent first');

      // The chips count the recent sessions and filter them; the search matches the session and the task.
      await page.waitForFunction(() => document.querySelector('#h5-tasks [data-filter="running"]').textContent === 'Running 1' && document.querySelector('#h5-tasks [data-filter="pending"]').textContent === 'Needs you 1');
      await chip(page, 'running').click();
      await waitKeys(page, ['remote:7|5|k1']);
      await chip(page, 'pending').click();
      await waitKeys(page, ['local|2|d1']);
      await chip(page, 'all').click();
      await waitKeys(page, ORDER);
      await page.locator('#h5-task-search-input').fill('docs');
      await waitKeys(page, ['local|2|d1']);
      await page.locator('#h5-task-search-input').fill('fix');
      await waitKeys(page, ['local|1|c1', 'local|1|default']);
      await page.locator('#h5-task-search-input').fill('zzz');
      await page.locator('#h5-recent-list .h5-list-note', { hasText: 'No matching sessions' }).waitFor();
      await page.locator('#h5-task-search-input').fill('');
      await waitKeys(page, ORDER);

      // List options: Expand all / Collapse all do nothing on Recent.
      await page.locator('#h5-task-list-more').click();
      assert.equal(await page.locator('#h5-expand-all').getAttribute('aria-disabled'), 'true');
      assert.equal(await page.locator('#h5-collapse-all').getAttribute('aria-disabled'), 'true');
      await page.keyboard.press('Escape');
      await page.locator('#h5-task-list-menu').waitFor({ state: 'hidden' });

      // A click opens the session; the selected row and the order follow.
      await page.locator('#h5-recent-list .h5-recent-row[data-key="local|2|d1"] .h5-recent-main').click();
      await waitShown(page, 'Write docs', 'd1');
      await waitKeys(page, ['local|2|d1', 'local|1|c1', 'remote:7|5|k1', 'local|1|default']);
      seen = await rows(page);
      assert.deepEqual(seen.map(row => row.current), [true, false, false, false], 'the selected row follows the shown session');
      assert.equal(seen[1].when, 'just now');
      // Enter on a focused row opens it too.
      await page.locator('#h5-recent-list .h5-recent-row[data-key="local|1|default"] .h5-recent-main').focus();
      await page.keyboard.press('Enter');
      await waitShown(page, 'Fix login', 'default');
      await page.waitForFunction(() => document.querySelector('#h5-recent-list .h5-recent-row')?.dataset.key === 'local|1|default');

      // The "⋯" of a row of a task that is neither shown nor open in the list: the session menu, and Rename in place.
      const docsRow = page.locator('#h5-recent-list .h5-recent-row[data-key="local|2|d1"]');
      await docsRow.hover();
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#h5-recent-list .h5-recent-row[data-key="local|2|d1"] .h5-recent-more')).opacity) === 1); // shown on hover
      await docsRow.locator('.h5-recent-more').click();
      await page.locator('#h5-session-menu').waitFor();
      const items = await page.locator('#h5-session-menu [role="menuitem"]').allTextContents();
      assert.ok(items.includes('Rename') && items.includes('Open'), `the menu of a session row of another task: ${items}`);
      await page.locator('#h5-session-menu [role="menuitem"]', { hasText: 'Rename' }).click();
      await page.locator('#h5-recent-list #h5-term-rename-input').waitFor();
      await page.locator('#h5-term-rename-input').fill('Docs renamed');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('#h5-recent-list .h5-recent-row[data-key="local|2|d1"] .h5-recent-name')?.textContent === 'Docs renamed');
      assert.deepEqual(renames, [{ task: '2', terminal: 'd1', title: 'Docs renamed' }]);

      // The tabs with the keyboard: the arrows move to the other tab and choose it.
      await page.locator('#h5-tab-recent').focus();
      await page.keyboard.press('ArrowLeft');
      await page.locator('#h5-task-list').waitFor();
      list = await tabs(page);
      assert.deepEqual(list.map(tab => tab.selected), [true, false]);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'h5-tab-tasks');
      if (SHOTS) { await page.waitForTimeout(200); await page.screenshot({ path: path.join(SHOTS, 'computer-by-task-1440.png') }); }
      await page.keyboard.press('ArrowRight');
      await page.locator('#h5-recent-list .h5-recent-row').first().waitFor();
      assert.equal(await page.evaluate(() => document.activeElement.id), 'h5-tab-recent');
      if (SHOTS) { await page.mouse.move(1000, 500); await page.waitForTimeout(200); await page.screenshot({ path: path.join(SHOTS, 'computer-recent-1440.png') }); }

      // Remembered across a reload, with the list.
      await page.reload();
      await page.locator('#h5-task-tabs').waitFor();
      list = await tabs(page);
      assert.deepEqual(list.map(tab => tab.selected), [false, true], 'Recent is still chosen after a reload');
      await page.waitForFunction(() => document.querySelectorAll('#h5-recent-list .h5-recent-row').length === 4, null, { timeout: 15000 });
      await page.locator('#h5-tab-tasks').click();
      await page.reload();
      await page.locator('#h5-task-list').waitFor();
      assert.deepEqual((await tabs(page)).map(tab => tab.selected), [true, false], 'By task is remembered too');
      assert.deepEqual(errors, [], 'no page errors on the computer');
      await context.close();
    }

    // ── Phone ──
    {
      const { context, page, errors } = await openPage(browser, { width: 390, height: 844 }, { touch: true });
      await page.locator('#h5-tasks').waitFor({ state: 'visible' });
      await page.evaluate(() => window.H5UI.actions.closeTasks());
      await visitAll(page);
      await page.evaluate(() => window.H5UI.actions.openTasks());
      await page.locator('#h5-task-tabs').waitFor({ state: 'visible' });
      let list = await tabs(page);
      assert.ok(list.every(tab => tab.height >= 48), `48px tabs on a touch screen: ${JSON.stringify(list)}`);
      await page.locator('#h5-tab-recent').tap();
      await waitKeys(page, ORDER);
      const seen = await rows(page);
      assert.ok(seen.every(row => row.height >= 56), `touch rows are tall enough: ${seen.map(row => row.height)}`);
      assert.ok(seen.every(row => row.more === 1), 'the "⋯" is always shown on a touch screen');
      const more = await page.locator('#h5-recent-list .h5-recent-more').first().boundingBox();
      assert.ok(more.width >= 44 && more.height >= 44, `the "⋯" is a 44px target: ${JSON.stringify(more)}`);
      if (SHOTS) { await page.waitForTimeout(300); await page.screenshot({ path: path.join(SHOTS, 'phone-drawer-recent-390.png') }); }
      // A tap opens the session and closes the drawer.
      await page.locator('#h5-recent-list .h5-recent-row[data-key="remote:7|5|k1"] .h5-recent-main').tap();
      await waitShown(page, 'Build server', 'k1');
      await page.waitForFunction(() => !window.H5UI.get().tasksOpen);
      // Opened again: still on Recent, the shown session first and selected.
      await page.evaluate(() => window.H5UI.actions.openTasks());
      await waitKeys(page, ['remote:7|5|k1', 'local|1|c1', 'local|2|d1', 'local|1|default']);
      assert.equal((await rows(page))[0].current, true);
      // Remembered across a reload on the phone too.
      await page.reload();
      await page.waitForFunction(() => window.H5UI && window.H5UI.actions.openTasks);
      await page.evaluate(() => window.H5UI.actions.openTasks());
      await page.locator('#h5-task-tabs').waitFor({ state: 'visible' });
      list = await tabs(page);
      assert.deepEqual(list.map(tab => tab.selected), [false, true]);
      assert.deepEqual(errors, [], 'no page errors on the phone');
      await context.close();
    }
    console.log('Recent tab: two tabs (computer and phone), remembered choice, rows in the switcher order with task, device, state and time, search and chips, open on click (drawer closes), selected row, row menu with Rename, empty state: passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
