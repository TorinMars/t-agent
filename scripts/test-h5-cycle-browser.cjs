// Phone page (/h5), row 2 "Next running or pending session" (#h5-cycle) in real Chromium with mocked sessions:
// it cycles through the running and pending-acceptance terminal sessions in task sheet order and wraps, skips idle terminals and chats,
// counts an idle Claude terminal with a running sub-agent as running, shows a toast when there is nothing to go to, and fits row 2 at 320 and 360px.
// H5_SHOT_DIR=<dir> saves 3x screenshots of row 2 there.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
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

async function openPage(browser, viewport) {
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
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    if (url.pathname === '/api/remote-servers') return json([]);
    if (url.pathname === '/api/tasks' && method === 'GET') return json(TASKS);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }, { key: 'todo', name: 'To do', sort_order: 2 }]);
    if (url.pathname === '/api/tasks/terminal-activity') return json(activity);
    if (url.pathname === '/api/tasks/terminal-subagents') return subagentsMissing ? json({ error: 'not found' }, 404) : json(subagents);
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

const shown = page => page.evaluate(() => ({ terminal: new URL(window.sockets.at(-1).url).searchParams.get('terminalId'), task: document.getElementById('h5-task-name').textContent }));
async function waitFor(page, task, terminal) {
  await page.waitForFunction(([name, id]) => window.sockets.length && new URL(window.sockets.at(-1).url).searchParams.get('terminalId') === id && document.getElementById('h5-task-name').textContent === name, [task, terminal]);
}
// The shell's floating notice (Notice in scripts/h5-shell/Dialogs.jsx, a Snackbar) shows the last message.
async function toast(page, text) {
  await page.locator('.MuiSnackbar-root [role="status"]', { hasText: text }).waitFor({ timeout: 5000 });
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const { context, page } = await openPage(browser, { width: 390, height: 844 });
    // Open Alpha / Terminal 1 from the task sheet, as a person would.
    await page.locator('#h5-tasks').waitFor({ state: 'visible' });
    await page.locator('.h5-task-item', { hasText: 'Alpha' }).tap();
    await page.locator('#h5-tasks .h5-terminal-list[aria-label="Alpha"] .h5-terminal-main', { hasText: 'Terminal 1' }).tap();
    await waitFor(page, 'Alpha', 'default');
    await page.locator('#h5-tasks').waitFor({ state: 'hidden' });

    const cycle = page.locator('#h5-cycle');
    assert.equal(await cycle.getAttribute('aria-label'), 'Next running or pending session');
    assert.equal(await cycle.getAttribute('title'), 'Next running or pending session');
    assert.equal(await cycle.locator('svg').count(), 1, 'an icon button');

    // The terminal keyboard is open (the terminal input has the focus): a tap closes it first.
    await page.evaluate(() => document.querySelector('#h5-terminal .xterm-helper-textarea').focus());
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
    assert.deepEqual(pageErrors, [], 'no browser runtime errors');
    console.log('Phone next running or pending session: order, wrap, skips, sub-agents, toasts and row fit passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
