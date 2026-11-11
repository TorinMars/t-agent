// The task list after selecting another task, in real Chromium at computer and phone size with real clicks and taps (the routes are mocked, so requests can be held back or fail).
// The task that was selected keeps its sessions and count at once (no read is needed for them), the new one lists its own, and nothing stays on "Loading…":
// a task selected before and one never expanded, a task without terminals, a failed read (failure note, read again on the next open), a read that never answers,
// a remote Engine, and A to B to A where a late answer must not overwrite newer state. Terminals named after their agent stay listed.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const LOADING = 'Loading…';
const FAILED = 'Could not load the sessions';

const claude = (id, title) => ({ terminal_id: id, title, agent: 'claude' });
const shell = (id, title) => ({ terminal_id: id, title });
const LOCAL_TASKS = [{ id: 1, title: 'Alpha', status: 'doing' }, { id: 2, title: 'Beta', status: 'doing' }, { id: 3, title: 'Gamma', status: 'doing' }, { id: 4, title: 'Delta', status: 'doing' }];
const REMOTE_TASKS = [{ id: 5, title: 'Far one', status: 'doing' }, { id: 6, title: 'Far two', status: 'doing' }];
const startRows = () => ({
  1: [shell('a1', 'Alpha shell'), claude('a2', 'Alpha Claude')],
  2: [claude('b1', 'Beta Claude'), { terminal_id: 'b2', title: 'Beta Codex', agent: 'codex' }, shell('b3', 'Beta shell')],
  3: [], // a task with no terminal
  4: [shell('d1', 'Delta shell')],
  5: [shell('r1', 'Far shell'), claude('r2', 'Far Claude')],
  6: [shell('s1', 'Other far shell')],
});

async function openPage(browser, wide, { remote = false } = {}) {
  const context = await browser.newContext(wide ? { viewport: { width: 1440, height: 900 } } : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const state = { rows: startRows(), failing: new Set(), holdNext: new Set(), held: [], reads: {}, paths: [], errors: [] };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.addInitScript(isRemote => {
    if (isRemote) localStorage.setItem('h5-source', 'remote:7');
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send() {}
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
  }, remote);
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
    if (p === '/api/remote-servers') return json([{ id: 7, name: 'Lab', status: 'online' }]);
    if (p === '/api/remote-servers/7/info') return json({ capabilities: [] });
    if (p === '/api/tasks' && method === 'GET') return json(LOCAL_TASKS);
    if (p === '/api/remote-servers/7/tasks' && method === 'GET') return json(REMOTE_TASKS);
    if (/^\/api(\/remote-servers\/7)?\/task-groups$/.test(p)) return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    const list = p.match(/^\/api(?:\/remote-servers\/7)?\/tasks\/(\d+)\/terminals$/);
    if (list && method === 'GET') {
      const id = Number(list[1]);
      state.reads[id] = (state.reads[id] || 0) + 1;
      state.paths.push(p);
      const answer = state.failing.has(id) ? null : JSON.parse(JSON.stringify(state.rows[id] || [])); // what the server knew when it was asked
      if (state.holdNext.has(id)) {
        state.holdNext.delete(id);
        await new Promise(resolve => state.held.push({ id, resolve }));
      }
      return answer ? json(answer).catch(() => {}) : json({ error: 'boom' }, 500).catch(() => {});
    }
    if (/\/agent\/conversations$/.test(p)) return json([]);
    if (/\/terminal-activity$/.test(p)) return json({});
    if (/\/terminal-subagents$/.test(p)) return json({});
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  await page.locator('#h5-tasks .h5-task-item').first().waitFor({ state: 'visible' });
  return { context, page, state, how: wide ? 'click' : 'tap', wide };
}

const taskBox = (page, title) => page.locator('#h5-tasks .h5-task-row', { hasText: title }).locator('xpath=..');
// What the list under a task shows now.
async function look(page, title) {
  const box = taskBox(page, title);
  return {
    rows: (await box.locator('.h5-terminal-main').allTextContents()).map(text => text.trim()),
    note: (await box.locator('.h5-peek-note').allTextContents()).join(' '),
    count: (await box.locator('.h5-task-count').allTextContents()).join(' '),
  };
}
async function until(page, title, check, what) {
  const deadline = Date.now() + 8000;
  let last;
  do {
    last = await look(page, title);
    if (check(last)) return last;
    await page.waitForTimeout(40);
  } while (Date.now() < deadline);
  assert.fail(`${what}: ${title} shows ${JSON.stringify(last)}`);
}
const hasRows = (list, names) => list.rows.length === names.length && names.every(name => list.rows.some(row => row.includes(name)));
const listed = (page, title, names, count, what) => until(page, title, list => hasRows(list, names) && !list.note && list.count === `${count} ${count === 1 ? 'session' : 'sessions'}`, what);
const noted = (page, title, note, what) => until(page, title, list => list.note === note && !list.rows.length, what);

// The "+" of a task selects it and leaves the list on screen, at both sizes (the sheet of a phone stays open), and needs no earlier expansion. It opens the
// New session dialog over the list, which is cancelled here: the task stays selected.
const pick = async ({ page, how }, title) => {
  await page.locator('#h5-tasks .h5-task-row', { hasText: title }).locator('.h5-task-add')[how]();
  await page.locator('#h5-new-session #h5-term-menu-cancel')[how]();
  await page.locator('#h5-new-session').waitFor({ state: 'detached' });
};
const toggle = ({ page, how }, title) => page.locator('#h5-tasks .h5-task-item', { hasText: title })[how]();
const releaseAll = state => { for (const entry of state.held.splice(0)) entry.resolve(); };

async function scenario(browser, wide) {
  const label = wide ? 'computer' : 'phone';
  const opened = await openPage(browser, wide);
  const { context, page, state, how } = opened;

  // Selecting by a tap on a session row of an expanded task. A phone closes the sheet, as ever.
  await toggle(opened, 'Alpha');
  await until(page, 'Alpha', list => list.rows.length === 2, `${label}: Alpha expanded`);
  await taskBox(page, 'Alpha').locator('.h5-terminal-main').first()[how]();
  if (!wide) {
    await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
    await page.locator('#h5-open-tasks')[how]();
  }
  await listed(page, 'Alpha', ['Alpha shell', 'Alpha Claude'], 2, `${label}: Alpha selected`);

  // A task never expanded: the one left keeps its sessions while its new read is still on the way, the new one lists its own.
  state.holdNext.add(1);
  await pick(opened, 'Delta');
  await listed(page, 'Alpha', ['Alpha shell', 'Alpha Claude'], 2, `${label}: the task left, with its read held back`);
  await listed(page, 'Delta', ['Delta shell'], 1, `${label}: the never expanded task`);
  releaseAll(state);
  await listed(page, 'Alpha', ['Alpha shell', 'Alpha Claude'], 2, `${label}: the task left, after its read`);

  // A task selected before, with its Claude and Codex terminals, and another one selected from its own expanded row.
  await pick(opened, 'Beta');
  await listed(page, 'Delta', ['Delta shell'], 1, `${label}: Delta left`);
  await listed(page, 'Beta', ['Beta Claude', 'Beta Codex', 'Beta shell'], 3, `${label}: Beta selected`);
  await pick(opened, 'Delta');
  await listed(page, 'Beta', ['Beta Claude', 'Beta Codex', 'Beta shell'], 3, `${label}: agent terminals stay listed`);
  await pick(opened, 'Alpha');
  await listed(page, 'Alpha', ['Alpha shell', 'Alpha Claude'], 2, `${label}: selected again`);
  await listed(page, 'Delta', ['Delta shell'], 1, `${label}: Delta left again`);

  // A task with no terminal: as a task left it says "Open this task"; selected, it has no rows and the terminal area says so.
  await pick(opened, 'Gamma');
  await page.locator('#h5-empty', { hasText: 'This task has no terminal yet' }).waitFor();
  assert.deepEqual(await look(page, 'Gamma'), { rows: [], note: '', count: '' }, `${label}: a selected task with no terminal`);
  await pick(opened, 'Alpha');
  await until(page, 'Gamma', list => list.rows.length === 1 && list.rows[0].includes('Open this task') && !list.note && list.count === '0 sessions', `${label}: the task left has no terminal`);
  await listed(page, 'Alpha', ['Alpha shell', 'Alpha Claude'], 2, `${label}: back on Alpha`);

  // A failed read of the task left: the failure note, no count; the next open reads again.
  await pick(opened, 'Beta');
  await listed(page, 'Beta', ['Beta Claude', 'Beta Codex', 'Beta shell'], 3, `${label}: Beta before the failure`);
  state.failing.add(2);
  await pick(opened, 'Alpha');
  const failed = await noted(page, 'Beta', FAILED, `${label}: a failed read`);
  assert.equal(failed.count, '', `${label}: no count for a failed read`);
  state.failing.delete(2);
  await toggle(opened, 'Beta');
  await until(page, 'Beta', list => !list.rows.length && !list.note, `${label}: collapsed`);
  await toggle(opened, 'Beta');
  await listed(page, 'Beta', ['Beta Claude', 'Beta Codex', 'Beta shell'], 3, `${label}: read again on the next open`);

  // The selected task whose own read fails says so too, and the next open of its list reads again.
  state.failing.add(4);
  await pick(opened, 'Delta');
  await noted(page, 'Delta', FAILED, `${label}: the selected task failed`);
  state.failing.delete(4);
  await toggle(opened, 'Delta');
  await until(page, 'Delta', list => !list.rows.length && !list.note, `${label}: selected one collapsed`);
  await toggle(opened, 'Delta');
  await listed(page, 'Delta', ['Delta shell'], 1, `${label}: the selected task read again`);

  // Leaving a task before its own list has arrived: nothing is known about it yet, so a read that answers late is shown when it comes.
  // Beta is collapsed first: an expanded list would be known, carried into the selection and kept when it is left.
  await toggle(opened, 'Beta');
  await until(page, 'Beta', list => !list.rows.length && !list.note, `${label}: Beta collapsed, nothing known`);
  state.holdNext.add(2);
  await pick(opened, 'Beta'); // its own read is held
  await page.waitForTimeout(50);
  state.holdNext.add(2);
  await pick(opened, 'Alpha'); // its own read was dropped; the read of the list is held
  await noted(page, 'Beta', LOADING, `${label}: a slow read`);
  releaseAll(state);
  await listed(page, 'Beta', ['Beta Claude', 'Beta Codex', 'Beta shell'], 3, `${label}: the slow read arrived`);

  // A read that does not answer at all does not stay on "Loading…"; the next open reads again. Delta is collapsed first, so nothing is known (as Beta above).
  await toggle(opened, 'Delta');
  await until(page, 'Delta', list => !list.rows.length && !list.note, `${label}: Delta collapsed, nothing known`);
  state.holdNext.add(4);
  await pick(opened, 'Delta');
  await page.waitForTimeout(50);
  state.holdNext.add(4);
  await pick(opened, 'Alpha');
  await noted(page, 'Delta', LOADING, `${label}: no answer yet`);
  const deadline = Date.now() + 14000;
  while ((await look(page, 'Delta')).note === LOADING && Date.now() < deadline) await page.waitForTimeout(100);
  await noted(page, 'Delta', FAILED, `${label}: no answer at all`);
  await toggle(opened, 'Delta');
  await toggle(opened, 'Delta');
  await listed(page, 'Delta', ['Delta shell'], 1, `${label}: read again after no answer`);
  releaseAll(state); // the old reads come in now: the list stays

  // A to B to A: the first read of A is the oldest and arrives last. It must not bring back its old rows or attach twice.
  await pick(opened, 'Beta');
  await listed(page, 'Beta', ['Beta Claude', 'Beta Codex', 'Beta shell'], 3, `${label}: before A to B to A`);
  state.holdNext.add(4);
  await pick(opened, 'Delta'); // A, read held with the old rows
  await page.waitForTimeout(50);
  await pick(opened, 'Beta'); // B
  state.rows[4] = [shell('d1', 'Delta shell'), shell('d2', 'Delta newer')];
  await pick(opened, 'Delta'); // A again, with the new rows
  await listed(page, 'Delta', ['Delta shell', 'Delta newer'], 2, `${label}: A again`);
  const sockets = await page.evaluate(() => window.sockets.length);
  releaseAll(state);
  await page.waitForTimeout(300);
  await listed(page, 'Delta', ['Delta shell', 'Delta newer'], 2, `${label}: the late answer of the selected task is ignored`);
  assert.equal(await page.evaluate(() => window.sockets.length), sockets, `${label}: the late answer does not connect again`);

  // The same for the list of a task that is not selected: a read sent before the last one, answered after it.
  state.holdNext.add(4);
  await pick(opened, 'Beta'); // Delta left: its read is held, with the old rows
  await listed(page, 'Delta', ['Delta shell', 'Delta newer'], 2, `${label}: Delta left, list kept`);
  await pick(opened, 'Delta');
  await listed(page, 'Delta', ['Delta shell', 'Delta newer'], 2, `${label}: Delta back`);
  state.rows[4] = [shell('d3', 'Delta newest')];
  await pick(opened, 'Beta');
  await listed(page, 'Delta', ['Delta newest'], 1, `${label}: the newest read`);
  releaseAll(state);
  await page.waitForTimeout(300);
  await listed(page, 'Delta', ['Delta newest'], 1, `${label}: the late read of the list is ignored`);

  assert.deepEqual(state.errors, [], `${label}: no page errors`);
  await context.close();
}

async function remoteScenario(browser, wide) {
  const label = wide ? 'computer (remote)' : 'phone (remote)';
  const opened = await openPage(browser, wide, { remote: true });
  const { context, page, state } = opened;
  await pick(opened, 'Far one');
  await listed(page, 'Far one', ['Far shell', 'Far Claude'], 2, `${label}: selected`);
  state.holdNext.add(5);
  await pick(opened, 'Far two');
  await listed(page, 'Far one', ['Far shell', 'Far Claude'], 2, `${label}: the task left, with its read held back`);
  await listed(page, 'Far two', ['Other far shell'], 1, `${label}: the new one`);
  releaseAll(state);
  await page.waitForTimeout(200);
  await listed(page, 'Far one', ['Far shell', 'Far Claude'], 2, `${label}: after its read`);
  assert.ok(state.paths.every(item => item.startsWith('/api/remote-servers/7/')), `${label}: every read goes through the Engine: ${state.paths}`);

  // Going to a task of another service while the list of a task is on its way: that late answer changes nothing and connects nothing to the first service.
  state.rows[5] = []; // an empty answer would draw the "no terminal" state of a task of the Engine that was left
  state.holdNext.add(5);
  await pick(opened, 'Far one');
  await page.waitForTimeout(100);
  await pick(opened, 'Alpha');
  await page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'Alpha');
  await page.waitForFunction(() => window.sockets.length && new URL(window.sockets.at(-1).url).pathname === '/terminal/ws');
  const sockets = await page.evaluate(() => window.sockets.length);
  releaseAll(state);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.sockets.length), sockets, `${label}: the late answer connects nothing`);
  assert.equal(await page.locator('#h5-task-name').textContent(), 'Alpha', `${label}: the late answer changes nothing on screen`);
  assert.equal(await page.evaluate(() => new URL(window.sockets.at(-1).url).pathname), '/terminal/ws', `${label}: the task of this machine is the one connected`);
  assert.deepEqual(state.errors, [], `${label}: no page errors`);
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const wide of [true, false]) {
      await scenario(browser, wide);
      await remoteScenario(browser, wide);
    }
    console.log('h5 peek after switch: ok');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
