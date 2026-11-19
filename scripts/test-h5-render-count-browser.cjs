// How much of the phone page (/h5) React draws again, in real Chromium with mocked routes and a pushed terminal activity stream (see "Page store"
// in docs/design/page-shell-and-columns.md): the page is given `window.__h5RenderCounts` before it loads, so the shell's components count their renders (use-store.mjs
// `countRender`), and a minimal React DevTools hook counts the commits. On a computer (1280x800, the permanent sidebar) with 20 tasks, one of them open
// with its sessions: one pushed activity change of one task's terminal draws that task's row again and no other row, not the header, the terminal area
// or the column strip; the same snapshot pushed again commits nothing; typing in the task search field draws no task row while the shown rows stay the
// same; typing in the draft box draws no row and no header. The numbers are printed (H5_RENDER_REPORT=1 prints them without the checks).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const REPORT_ONLY = process.env.H5_RENDER_REPORT === '1';
const LOCAL_ID = '6c1d1c1e-0000-4000-8000-00000000000a';
const STREAM = '/api/tasks/terminal-activity/stream';
const TASKS = Array.from({ length: 20 }, (_, index) => ({ id: index + 1, title: `Task ${String(index + 1).padStart(2, '0')}`, status: 'doing', work_dir: `/w/t${index + 1}`, archived_at: null }));
const pageErrors = [];
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function serve(route) {
  const url = new URL(route.request().url());
  const pathname = url.pathname;
  const method = route.request().method();
  if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
  if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
  if (pathname === '/api/system/version') return json(route, { app_version: '2.103.0', boot_id: 'b1', engine_name: 'MacBook', instance_id: LOCAL_ID });
  if (pathname === '/api/remote-servers') return json(route, []);
  if (pathname === '/api/task-order') return json(route, { order: TASKS.map(item => `${LOCAL_ID}:${item.id}`), updated_at: 1 });
  if (pathname === '/api/task-list/hidden-devices') return json(route, { hidden: [] });
  if (pathname === '/api/task-groups') return json(route, [{ key: 'doing', name: 'In progress', sort_order: 1 }]);
  if (pathname === '/api/tasks/terminal-activity' || pathname === '/api/tasks/terminal-subagents') return json(route, {});
  if (pathname === '/api/tasks' && method === 'GET') return json(route, url.searchParams.get('archived') === '1' ? [] : TASKS);
  const terminals = pathname.match(/^\/api\/tasks\/(\d+)\/terminals$/);
  if (terminals && method === 'GET') return json(route, [{ terminal_id: 'default', title: 'Shell' }, { terminal_id: `c${terminals[1]}`, title: 'Claude work', agent: 'claude' }]);
  if (/^\/api\/tasks\/\d+\/terminal\/(ack|control)$/.test(pathname)) return json(route, {});
  if (/^\/api\/tasks\/\d+\/agent\/conversations$/.test(pathname)) return json(route, []);
  return json(route, { error: 'not mocked' }, 404);
}

// Before the page's scripts: the render counters, the commit counter (React calls a DevTools hook on every commit, also in a production build), fake sockets.
function instrument() {
  window.__h5RenderCounts = {};
  window.__h5Commits = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, isDisabled: false, renderers: new Map(),
    inject(renderer) { this.renderers.set(1, renderer); return 1; },
    onCommitFiberRoot() { window.__h5Commits += 1; },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {}, checkDCE() {},
  };
  window.sockets = [];
  window.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 0; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
    send() {}
    close() { this.readyState = 3; }
  };
  window.WebSocket.OPEN = 1;
  window.WebSocket.CONNECTING = 0;
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript(instrument);
    await page.addInitScript(activityStreamMock);
    await page.route(`${ORIGIN}/**`, serve);
    await page.goto(`${ORIGIN}/h5`);
    await page.waitForFunction(() => document.querySelectorAll('#h5-tasks .h5-task[data-movable="true"]').length === 20);
    await page.waitForFunction(url => window.activityStream.open(url), STREAM);
    const push = snapshot => page.waitForFunction(([url, snap]) => window.activityStream.push(url, snap), [STREAM, snapshot]);
    const activeIs = count => page.waitForFunction(want => window.H5UI.get().activeCount === want, count); // the push has been taken in
    // Two frames and a pause: whatever the change drew has been committed.
    const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 150)))));
    const reset = () => page.evaluate(() => { for (const key of Object.keys(window.__h5RenderCounts)) delete window.__h5RenderCounts[key]; window.__h5Commits = 0; });
    const read = () => page.evaluate(() => ({ commits: window.__h5Commits, ...window.__h5RenderCounts }));
    const count = (counts, name) => counts[name] || 0;

    // Task 01 open with its sessions (a session list under a row), and the page at rest.
    await push({ activity: {}, subagents: {} });
    await page.locator('#h5-tasks .h5-task-item', { hasText: 'Task 01' }).click();
    await page.locator('#h5-tasks .h5-terminal-list[aria-label="Task 01"] .h5-terminal-row', { hasText: 'Claude work' }).waitFor();
    await settle();
    await page.waitForTimeout(500);
    const rest = await read();
    assert.ok(rest.commits > 0 || REPORT_ONLY, `the DevTools hook counts commits: ${JSON.stringify(rest)}`);

    // (a) One pushed change: a terminal of Task 05 runs.
    await reset();
    await push({ activity: { 5: { default: 'running' } }, subagents: {} });
    await activeIs(1);
    await settle();
    const activity = await read();

    // (a2) The same snapshot again: nothing changed, nothing is drawn.
    await reset();
    await push({ activity: { 5: { default: 'running' } }, subagents: {} });
    await settle();
    await page.waitForTimeout(200);
    const same = await read();

    // (b) Typing in the task search field: every task still matches, so the rows shown stay the same.
    await page.locator('#h5-task-search-input').click();
    await settle();
    await reset();
    await page.keyboard.type('Task', { delay: 30 });
    await settle();
    const search = await read();
    assert.equal(await page.locator('#h5-tasks .h5-task').count(), 20, 'the search keeps every task');
    await page.locator('#h5-task-search-input').fill('');

    // (c) Typing in the draft box (always shown on a computer).
    await page.locator('#h5-translate-input').click();
    await settle();
    await reset();
    await page.keyboard.type('hello', { delay: 30 });
    await settle();
    const draft = await read();

    const report = { rest, activity, same, search, draft };
    console.log(`Render counts (20 task rows): ${JSON.stringify(report)}`);
    if (!REPORT_ONLY) {
      assert.equal(count(activity, 'TaskRow'), 1, `one activity push draws only the row of its task: ${JSON.stringify(activity)}`);
      for (const name of ['Header', 'TerminalArea', 'ColumnStrip']) assert.equal(count(activity, name), 0, `one activity push does not draw ${name}: ${JSON.stringify(activity)}`);
      assert.ok(count(activity, 'App') === 0, `the page root is not drawn again for an activity push: ${JSON.stringify(activity)}`);
      assert.equal(same.commits, 0, `the same snapshot pushed again commits nothing: ${JSON.stringify(same)}`);
      assert.equal(count(search, 'TaskRow'), 0, `typing in the task search draws no row while the rows stay: ${JSON.stringify(search)}`);
      for (const name of ['TaskRow', 'Header', 'TerminalArea', 'ColumnStrip', 'App']) assert.equal(count(draft, name), 0, `typing in the draft box does not draw ${name}: ${JSON.stringify(draft)}`);
      // The filters still see the pushed state: Running keeps Task 05 alone.
      await page.locator('#h5-tasks .h5-task-filters button', { hasText: 'Running' }).click();
      await page.waitForFunction(() => [...document.querySelectorAll('#h5-tasks .h5-task-title')].map(node => node.textContent).join() === 'Task 05');
      await push({ activity: { 5: { default: 'running' }, 7: { c7: 'running' } }, subagents: {} });
      await page.waitForFunction(() => [...document.querySelectorAll('#h5-tasks .h5-task-title')].map(node => node.textContent).join() === 'Task 05,Task 07');

      // (d) The Recent tab ("Recent tab" in docs/design/page-task-list.md): two sessions shown, then one pushed change of one of them draws its row
      // alone (and no task row: the By task list is not drawn on Recent).
      await page.locator('#h5-tasks .h5-task-filters button', { hasText: 'All' }).click();
      await page.evaluate(() => window.H5UI.actions.openRow('local|2', { kind: 'terminal', id: 'default' }));
      await page.waitForFunction(() => (window.H5UI.get().shownTarget || {}).taskId === 2);
      await page.evaluate(() => window.H5UI.actions.openRow('local|1', { kind: 'terminal', id: 'c1' }));
      await page.waitForFunction(() => window.H5UI.get().recent.length === 2 && (window.H5UI.get().shownTarget || {}).terminalId === 'c1');
      await page.locator('#h5-tab-recent').click();
      await page.waitForFunction(() => document.querySelectorAll('#h5-recent-list .h5-recent-row').length === 2);
      await settle();
      await page.waitForTimeout(300);
      await reset();
      await push({ activity: { 5: { default: 'running' }, 7: { c7: 'running' }, 2: { default: 'running' } }, subagents: {} });
      await page.waitForFunction(() => document.querySelector('#h5-recent-list .h5-recent-row[data-key="local|2|default"]')?.dataset.status === 'running');
      await settle();
      const recentPush = await read();
      console.log(`Render counts on the Recent tab: ${JSON.stringify(recentPush)}`);
      assert.equal(count(recentPush, 'RecentRow'), 1, `one activity push draws one row of the Recent tab: ${JSON.stringify(recentPush)}`);
      assert.equal(count(recentPush, 'TaskRow'), 0, `no task row is drawn on the Recent tab: ${JSON.stringify(recentPush)}`);
      for (const name of ['Header', 'TerminalArea', 'ColumnStrip', 'App']) assert.equal(count(recentPush, name), 0, `the Recent tab's push does not draw ${name}: ${JSON.stringify(recentPush)}`);
      await page.evaluate(() => { try { localStorage.removeItem('h5-task-list-tab'); } catch { /* none */ } });
    }
    await context.close();
    assert.deepEqual(pageErrors, [], 'no browser runtime errors');
    console.log('Phone page render counts: one activity push draws one task row, a repeated snapshot commits nothing, typing draws no task row: passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
