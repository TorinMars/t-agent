// Phone page (/h5), row 2 "Next running or pending session" (#h5-cycle) in real Chromium with mocked sessions:
// it cycles through the running and pending-acceptance terminal sessions in task sheet order and wraps, skips idle terminals and chats,
// counts an idle Claude terminal with a running sub-agent as running, shows a toast when there is nothing to go to, and fits row 2 at 320 and 360px.
// The count badge on the button: from the pushed activity stream (mocked, scripts/h5-activity-stream-mock.cjs) with no polling while it is live,
// and from a slow fallback poll when the stream answers 404 (an older Engine). The shown terminal is acked when the stream says it is done.
// H5_SHOT_DIR=<dir> saves 3x screenshots of row 2 there.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };

// The API answers the tasks in a different order from the sheet: the sheet sorts by group (doing before todo), so the cycle must follow the sheet.
const TASKS = [
  { id: 3, title: 'Gamma', status: 'todo' },
  { id: 1, title: 'Alpha', status: 'doing' },
  { id: 2, title: 'Beta', status: 'doing' },
  { id: 4, title: 'Delta', status: 'doing' },
];
const TERMINALS = {
  1: [{ terminal_id: 'default', title: 'Terminal 1' }, { terminal_id: 'c1', title: 'Claude work', agent: 'claude' }, { terminal_id: 'x1', title: 'Idle shell' }],
  2: [{ terminal_id: 'b1', title: 'Codex work', agent: 'codex' }, { terminal_id: 'b2', title: 'Beta shell' }],
  3: [{ terminal_id: 'g1', title: 'Gamma shell' }],
  4: [{ terminal_id: 'd1', title: 'Delta shell' }],
};
// Task 1: the plain shell runs, the Claude terminal is idle but one of its sub-agents runs, x1 is idle; a running chat must not count.
// Task 2: the Codex session finished and waits for acceptance ('done'); task 3: a pending shell; task 4: idle. Task 99 is not in the list.
const BUSY = { 1: { default: 'running' }, 2: { b1: 'done' }, 3: { g1: 'done' }, 99: { z: 'running' } };
let activity = BUSY;
let subagents = { 1: { c1: 2 } };
let subagentsMissing = false; // an Engine older than the sub-agent endpoint
const pageErrors = [];
const hits = {}; // GET requests per path
const acks = []; // [task, terminal_id] of every acknowledgement
const renames = []; // [task, terminal_id, title] of every terminal rename

async function openPage(browser, viewport, { stream = false } = {}) {
  const scale = process.env.H5_SHOT_DIR ? { deviceScaleFactor: 3 } : {};
  const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true, ...scale });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.sockets = [];
    window.FakeSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
    };
    window.FakeSocket.OPEN = 1;
    window.FakeSocket.CONNECTING = 0;
    window.WebSocket = window.FakeSocket;
  });
  if (stream) await page.addInitScript(activityStreamMock);
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (method === 'GET') hits[url.pathname] = (hits[url.pathname] || 0) + 1;
    const ack = url.pathname.match(/^\/api\/tasks\/(\d+)\/terminal\/ack$/);
    if (ack && method === 'POST') { acks.push([Number(ack[1]), route.request().postDataJSON().terminal_id]); return json({ success: true }); }
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    if (url.pathname === '/api/remote-servers') return json([]);
    if (url.pathname === '/api/tasks' && method === 'GET') return json(TASKS);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }, { key: 'todo', name: 'To do', sort_order: 2 }]);
    if (url.pathname === '/api/tasks/terminal-activity') return json(activity);
    if (url.pathname === '/api/tasks/terminal-subagents') return subagentsMissing ? json({ error: 'not found' }, 404) : json(subagents);
    const rename = url.pathname.match(/^\/api\/tasks\/(\d+)\/terminals\/([^/]+)$/);
    if (rename && method === 'PATCH') { // the server keeps a given name (title_custom), so the listing answers it from now on
      const row = (TERMINALS[rename[1]] || []).find(item => item.terminal_id === decodeURIComponent(rename[2]));
      if (!row) return json({ error: 'TERMINAL_NOT_FOUND' }, 404);
      row.title = route.request().postDataJSON().title;
      renames.push([Number(rename[1]), row.terminal_id, row.title]);
      return json({ terminal_id: row.terminal_id, title: row.title });
    }
    const terminals = url.pathname.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (terminals && method === 'GET') return json(TERMINALS[terminals[1]] || []);
    if (url.pathname === '/api/tasks/1/agent/conversations') return json([{ id: 'k1', agent: 'claude', title: 'Busy chat', running: true, pending: false, opened: { web: null, h5: null } }]);
    if (/^\/api\/tasks\/\d+\/agent\/conversations$/.test(url.pathname)) return json([]);
    if (url.pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  return { context, page };
}

// The terminal on screen: recent terminals stay connected but hidden, so the newest socket is not always the shown one.
const shown = page => page.evaluate(() => ({ terminal: document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId, task: document.getElementById('h5-task-name').textContent }));
async function waitFor(page, task, terminal) {
  await page.waitForFunction(([name, id]) => document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId === id && document.getElementById('h5-task-name').textContent === name, [task, terminal]);
}
// The shell's floating notice (Notice in scripts/h5-shell/Dialogs.jsx, a Snackbar) shows the last message.
async function toast(page, text) {
  await page.locator('.MuiSnackbar-root [role="status"]', { hasText: text }).waitFor({ timeout: 5000 });
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    // The back button (page.goBack: Android back, the back gesture) closes the open sheet, menu or dialog instead of leaving the page.
    {
      const { context, page } = await openPage(browser, { width: 390, height: 844 });
      await page.goto(`${ORIGIN}/h5?openChat=9:x`); // the notification link: its address is kept by every entry
      const sheet = page.locator('#h5-tasks');
      await sheet.waitFor({ state: 'visible' }); // the task sheet opens by itself on a phone
      await page.waitForFunction(() => history.state && history.state.h5Layer === 1);
      await page.goBack();
      await sheet.waitFor({ state: 'hidden' });
      assert.equal(new URL(page.url()).search, '?openChat=9:x', 'still on the page, same address');
      // Settings, then a menu over the task sheet: one back press each, top first.
      await page.evaluate(() => window.H5UI.actions.openSettings());
      await page.locator('#h5-settings').waitFor({ state: 'visible' });
      await page.goBack();
      await page.locator('#h5-settings').waitFor({ state: 'hidden' });
      await page.locator('#h5-open-tasks').tap();
      await sheet.waitFor({ state: 'visible' });
      await page.locator('.h5-task-item', { hasText: 'Alpha' }).tap();
      await page.locator('#h5-tasks .h5-terminal-list[aria-label="Alpha"] .h5-terminal-main', { hasText: 'Terminal 1' }).tap();
      await sheet.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => !(history.state && history.state.h5Layer)); // closed by choosing a terminal: its entry was taken back
      await page.locator('#h5-open-tasks').tap();
      await page.locator('#h5-tasks .h5-terminal-row', { hasText: 'Claude work' }).locator('.h5-terminal-more').tap();
      await page.locator('#h5-term-menu').waitFor({ state: 'visible' });
      await page.waitForFunction(() => history.state && history.state.h5Layer === 2);
      await page.goBack();
      await page.locator('#h5-term-menu').waitFor({ state: 'hidden' });
      assert.equal(await sheet.isVisible(), true, 'the sheet under the menu stays');
      // Closed another way (Cancel): its entry is taken back, so one back press closes the sheet and nothing is left over.
      await page.locator('#h5-tasks .h5-terminal-row', { hasText: 'Claude work' }).locator('.h5-terminal-more').tap();
      await page.locator('#h5-term-menu-cancel').tap();
      await page.locator('#h5-term-menu').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => history.state && history.state.h5Layer === 1);
      await page.goBack();
      await sheet.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => !(history.state && history.state.h5Layer));
      assert.equal(new URL(page.url()).pathname, '/h5');
      await context.close();
    }

    const { context, page } = await openPage(browser, { width: 390, height: 844 });
    // Open Alpha / Terminal 1 from the task sheet, as a person would.
    await page.locator('#h5-tasks').waitFor({ state: 'visible' });
    await page.locator('.h5-task-item', { hasText: 'Alpha' }).tap();
    await page.locator('#h5-tasks .h5-terminal-list[aria-label="Alpha"] .h5-terminal-main', { hasText: 'Terminal 1' }).tap();
    await waitFor(page, 'Alpha', 'default');
    await page.locator('#h5-tasks').waitFor({ state: 'hidden' });

    // A Claude terminal can be renamed from its menu too (a given name wins over the Claude session title on the server).
    await page.locator('#h5-open-tasks').tap();
    await page.locator('#h5-tasks .h5-terminal-row', { hasText: 'Claude work' }).locator('.h5-terminal-more').tap();
    await page.locator('#h5-term-menu').waitFor({ state: 'visible' });
    assert.deepEqual(await page.locator('#h5-term-menu-actions button').allTextContents(), ['Rename', 'Reopen', 'Restart in the working directory', 'Delete'], 'Rename is offered for an agent terminal');
    await page.locator('#h5-term-menu-actions button', { hasText: 'Rename' }).tap();
    await page.locator('#h5-term-rename-input').fill('My review');
    await page.locator('#h5-term-rename button').tap();
    await page.locator('#h5-term-rename').waitFor({ state: 'detached' }); // the field is in the task list, in place of the row
    assert.deepEqual(renames, [[1, 'c1', 'My review']]);
    await page.locator('#h5-tasks .h5-terminal-row .h5-terminal-name', { hasText: 'My review' }).waitFor();
    await page.evaluate(() => window.H5UI.actions.closeTasks()); // not Escape: a key press would turn on the hardware keyboard mode
    await page.locator('#h5-tasks').waitFor({ state: 'hidden' });

    const cycle = page.locator('#h5-cycle');
    // No stream here (the mock answers 404, as an older Engine would): the page reads the states once and then polls slowly. The badge counts
    // Alpha default (running), Alpha c1 (sub-agent), Beta b1 and Gamma g1 (pending); task 99 is not in the list.
    await page.waitForFunction(() => document.getElementById('h5-cycle').getAttribute('aria-label') === 'Next running or pending session (4)');
    assert.equal(await cycle.getAttribute('title'), 'Next running or pending session (4)');
    assert.equal((await cycle.locator('.MuiBadge-badge').textContent()).trim(), '4');
    assert.ok(hits['/api/tasks/terminal-activity/stream'] >= 1, 'the stream was tried first');
    assert.equal(await cycle.locator('svg').count(), 1, 'an icon button');

    // The terminal keyboard is open (the terminal input has the focus): a tap closes it first.
    await page.evaluate(() => document.querySelector('#h5-terminal .h5-xterm:not([hidden]) .xterm-helper-textarea').focus());
    // Sheet order: Alpha (default, c1), Beta (b1), Gamma (g1); x1, b2, d1 are idle, the running chat and task 99 do not count. Then it wraps.
    const expected = [['Alpha', 'c1'], ['Beta', 'b1'], ['Gamma', 'g1'], ['Alpha', 'default'], ['Alpha', 'c1']];
    for (const [index, [task, terminal]] of expected.entries()) {
      await cycle.tap();
      await waitFor(page, task, terminal);
      if (index === 0) assert.notEqual(await page.evaluate(() => document.activeElement && document.activeElement.className), 'xterm-helper-textarea', 'the keyboard was closed first');
    }
    assert.equal(await page.locator('#h5-tasks').isVisible(), false, 'the task sheet stays closed');

    // An Engine without the sub-agent endpoint: the activity states alone still work. c1 (the current one) is then idle, so the cycle starts at the first.
    subagentsMissing = true;
    await cycle.tap();
    await waitFor(page, 'Alpha', 'default');
    subagentsMissing = false;

    // The current session is not in the set: the first one of the set.
    activity = { 3: { g1: 'done' } };
    subagents = {};
    await cycle.tap();
    await waitFor(page, 'Gamma', 'g1');

    // Only the current session is in the set: a short note, no switch.
    const before = await page.evaluate(() => window.sockets.length);
    await cycle.tap();
    await toast(page, 'This is the only running or pending session');
    assert.equal(await page.evaluate(() => window.sockets.length), before, 'no new connection');

    // Nothing running or pending: a toast, and the terminal stays.
    activity = {};
    await cycle.tap();
    await toast(page, 'No running or pending sessions');
    assert.deepEqual(await shown(page), { terminal: 'g1', task: 'Gamma' });
    assert.equal(await page.evaluate(() => window.sockets.length), before, 'still no new connection');

    // While the draft box is shown, the button steps aside like the design button.
    await page.locator('#h5-translate-input').focus();
    await page.waitForFunction(() => document.getElementById('h5-cycle').getBoundingClientRect().width === 0);
    await page.evaluate(() => document.activeElement.blur());
    await context.close();

    // Row 2 at rest fits 320px and 360px phones: seven equal buttons of at least 40px, no overlap, no sideways scroll.
    activity = BUSY;
    subagents = { 1: { c1: 2 } };
    for (const viewport of [{ width: 320, height: 640 }, { width: 360, height: 740 }]) {
      const small = await openPage(browser, viewport);
      await small.page.locator('.h5-task-item', { hasText: 'Alpha' }).click();
      await small.page.locator('#h5-tasks .h5-terminal-list[aria-label="Alpha"] .h5-terminal-main').first().click();
      await waitFor(small.page, 'Alpha', 'default');
      await small.page.waitForTimeout(500); // the task sheet slides away
      const row = await small.page.evaluate(() => {
        const boxes = [...document.querySelectorAll('#h5-actions button, #h5-actions [role="button"]')].filter(b => b.getBoundingClientRect().width > 0).map(b => ({ id: b.id, ...b.getBoundingClientRect().toJSON() }));
        return { boxes, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.equal(row.boxes.length, 7, `seven buttons at ${viewport.width}px`);
      assert.equal(row.boxes.at(-1).id, 'h5-cycle', 'the new button is the last one of row 2');
      assert.ok(row.boxes.every((box, i) => box.left >= 0 && box.right <= viewport.width && box.width >= 40 && box.height >= 40 && Math.abs(box.width - row.boxes[0].width) <= 1 && (i === 0 || row.boxes[i - 1].right <= box.left + 0.5)), `row 2 fits at ${viewport.width}px: ${JSON.stringify(row.boxes.map(box => Math.round(box.width)))}`);
      assert.equal(row.overflow, false);
      if (process.env.H5_SHOT_DIR) {
        await small.page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, `h5-cycle-row2-${viewport.width}.png`) });
        await small.page.locator('#h5-actions').screenshot({ path: path.join(process.env.H5_SHOT_DIR, `h5-cycle-row2-${viewport.width}-bar.png`) });
      }
      // One tap from the narrow page goes on, as on the wide one.
      await small.page.locator('#h5-cycle').tap();
      await waitFor(small.page, 'Alpha', 'c1');
      await small.context.close();
    }
    // A live stream: the badge and the button follow the pushed snapshots, nothing is polled, and a pushed 'done' of the shown terminal is acked.
    {
      activity = {};
      subagents = {};
      for (const key of Object.keys(hits)) delete hits[key]; // count this page's requests only
      const live = await openPage(browser, { width: 390, height: 844 }, { stream: true });
      const STREAM = '/api/tasks/terminal-activity/stream';
      const push = snapshot => live.page.waitForFunction(([url, snap]) => window.activityStream.push(url, snap), [STREAM, snapshot]);
      const label = () => live.page.locator('#h5-cycle').getAttribute('aria-label');
      const labelIs = text => live.page.waitForFunction(want => document.getElementById('h5-cycle').getAttribute('aria-label') === want, text);
      await push({ activity: BUSY, subagents: { 1: { c1: 2 } } });
      await labelIs('Next running or pending session (4)');
      await live.page.locator('.h5-task-item', { hasText: 'Alpha' }).tap();
      await live.page.locator('#h5-tasks .h5-terminal-list[aria-label="Alpha"] .h5-terminal-main', { hasText: 'Terminal 1' }).tap();
      await waitFor(live.page, 'Alpha', 'default');
      await live.page.locator('#h5-tasks').waitFor({ state: 'hidden' });
      // The tap uses the pushed states: no read of the polling endpoints.
      await live.page.locator('#h5-cycle').tap();
      await waitFor(live.page, 'Alpha', 'c1');
      // Changes arrive without a request: two left, then none (the badge is hidden).
      await push({ activity: { 2: { b1: 'done' } }, subagents: { 1: { c1: 1 } } });
      await labelIs('Next running or pending session (2)');
      await push({ activity: {}, subagents: {} });
      await labelIs('Next running or pending session');
      assert.equal(await live.page.locator('#h5-cycle .MuiBadge-badge.MuiBadge-invisible').count(), 1, 'the badge is hidden at 0');
      // The shown terminal (Alpha c1) finishes while it is on screen: acked.
      const from = acks.length;
      await push({ activity: { 1: { c1: 'done' } }, subagents: {} });
      const started = Date.now();
      while (!acks.slice(from).some(([taskId, id]) => taskId === 1 && id === 'c1')) {
        assert.ok(Date.now() - started < 8000, `no ack: ${JSON.stringify(acks)}`);
        await live.page.waitForTimeout(50);
      }
      assert.equal(await label(), 'Next running or pending session (1)', 'the badge counts it until the server pushes the cleared state');
      // No polling while the stream is live: wait longer than the old 3 s poll, twice over.
      const polled = () => (hits['/api/tasks/terminal-activity'] || 0) + (hits['/api/tasks/terminal-subagents'] || 0);
      const before = polled();
      // The agent counters of the top bar travel in the same stream: shown at once, and their 5 s poll stops.
      await push({ activity: { 1: { c1: 'done' } }, subagents: {}, agents: { running: 2, queued: 1, submitted: 3 } });
      await live.page.waitForFunction(() => [...document.querySelectorAll('#agent-activity .count')].map(node => node.textContent).join() === '3,2');
      const summaries = hits['/api/agent-chat/summary'] || 0;
      await live.page.waitForTimeout(7000);
      assert.equal(polled(), before, 'no GET of terminal-activity / terminal-subagents while the stream is live');
      assert.equal(before, 0, 'not even once since the page opened');
      assert.equal(hits['/api/agent-chat/summary'] || 0, summaries, 'no GET of the agent summary while the stream pushes it');
      assert.deepEqual(await live.page.evaluate(() => window.activityStream.opens), [STREAM], 'one stream for the whole time');
      // A lost connection reconnects (after a 1 s backoff) and the new stream's snapshot is used.
      await live.page.evaluate(url => window.activityStream.drop(url), STREAM);
      await live.page.waitForFunction(() => window.activityStream.opens.length === 2, null, { timeout: 10000 });
      await push({ activity: { 3: { g1: 'running' } }, subagents: {} });
      await labelIs('Next running or pending session (1)');
      await live.context.close();
    }

    assert.deepEqual(pageErrors, [], 'no browser runtime errors');
    console.log('Phone next running or pending session: order, wrap, skips, sub-agents, toasts, row fit, pushed badge, ack and fallback polling passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
