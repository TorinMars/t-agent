// Opening a session of a remote service from the task list, in real Chromium at computer and phone size with real clicks and taps. The routes are mocked and the
// remote list of terminals of the selected task answers about 1.5 s late, as through the network or a service-link tunnel.
// A tap on a session of an expanded task: the task keeps its session rows and count on every frame, the terminal area never says "Loading…", and the socket of the
// tapped terminal opens before that list answers; the answer then only reconciles (no second socket). When the tapped terminal was deleted meanwhile, the answer
// closes its socket and view and the usual rules choose another (the saved one). A Restart of that terminal still on its way: nothing connects before it is done.
// A task never expanded keeps the loading state until its list is read.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SLOW_MS = 1500;
const BASE = '/api/remote-servers/7';

const shell = (id, title) => ({ terminal_id: id, title, work_dir: '/srv/self' });
const LOCAL_TASKS = [{ id: 1, title: 'Here', status: 'doing' }];
const REMOTE_TASKS = [{ id: 5, title: 'SELF-TAGENT', status: 'doing' }, { id: 6, title: 'Never opened', status: 'doing' }];
const startRows = () => ({
  1: [shell('h1', 'Here shell')],
  5: [shell('r1', 'review'), shell('r2', 'main dev'), shell('r3', 'notes')],
  6: [shell('n1', 'Fresh shell')],
});

async function openPage(browser, wide) {
  const context = await browser.newContext(wide ? { viewport: { width: 1440, height: 900 } } : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  // slow: the next read of these tasks' terminals answers SLOW_MS late; answered: when each read was answered (in the order they came).
  const state = { rows: startRows(), slow: new Set(), reads: [], answered: [], controls: [], heldControls: [], holdControl: false, errors: [] };
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => {
    localStorage.setItem('h5-source', 'remote:7');
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.at = performance.now(); window.sockets.push(this); setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } }, 0); }
      send() {}
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
    if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
    if (p === '/api/remote-servers') return json([{ id: 7, name: '192.168.1.224', status: 'online' }]);
    if (p === `${BASE}/info`) return json({ capabilities: ['terminal:control'] });
    if (p === '/api/tasks' && method === 'GET') return json(LOCAL_TASKS);
    if (p === `${BASE}/tasks` && method === 'GET') return json(REMOTE_TASKS);
    if (/^\/api(\/remote-servers\/7)?\/task-groups$/.test(p)) return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    const control = p.match(/^\/api\/remote-servers\/7\/tasks\/(\d+)\/terminal\/control$/);
    if (control && method === 'POST') {
      state.controls.push(route.request().postDataJSON());
      if (state.holdControl) await new Promise(resolve => state.heldControls.push(resolve));
      return json({ success: true });
    }
    const list = p.match(/^\/api(?:\/remote-servers\/7)?\/tasks\/(\d+)\/terminals$/);
    if (list && method === 'GET') {
      const id = Number(list[1]);
      const read = { id, at: Date.now(), answered: false };
      state.reads.push(read);
      const answer = JSON.parse(JSON.stringify(state.rows[id] || [])); // what the server knew when it was asked
      if (state.slow.has(id)) {
        state.slow.delete(id);
        await new Promise(resolve => setTimeout(resolve, SLOW_MS));
      }
      read.answered = true;
      state.answered.push(id);
      return json(answer);
    }
    if (/\/agent\/conversations$/.test(p)) return json([]);
    if (/\/terminal-activity$/.test(p)) return json({});
    if (/\/terminal-subagents$/.test(p)) return json({});
    if (/\/terminal\/ack$/.test(p)) return json({ success: true });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  if (!wide) await page.locator('#h5-tasks').waitFor({ state: 'visible' }); // nothing remembered: a phone opens on the task sheet
  await page.locator('#h5-tasks .h5-task-item', { hasText: 'SELF-TAGENT' }).waitFor({ state: 'visible' });
  return { context, page, state, how: wide ? 'click' : 'tap', wide, label: wide ? 'computer' : 'phone' };
}

const taskBox = (page, title) => page.locator('#h5-tasks .h5-task-row', { hasText: title }).locator('xpath=..');
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
    await page.waitForTimeout(30);
  } while (Date.now() < deadline);
  assert.fail(`${what}: ${title} shows ${JSON.stringify(last)}`);
}
const hasRows = (list, names) => list.rows.length === names.length && names.every(name => list.rows.some(row => row.includes(name)));
const listed = (page, title, names, what) => until(page, title, list => hasRows(list, names) && !list.note && list.count === `${names.length} ${names.length === 1 ? 'session' : 'sessions'}`, what);

// Watches the page on every animation frame and after every DOM change: what the row of `title` lists (while the list is in the page; a phone's closed sheet
// is not), and what the terminal area says. `bad` collects every moment that breaks the rule.
const watch = (page, title, rows) => page.evaluate(({ title: want, rows: expected }) => {
  const seen = window.watched = { bad: [], samples: 0, empties: [] };
  const sample = why => {
    seen.samples += 1;
    const empty = document.getElementById('h5-empty');
    if (empty && empty.textContent.trim() && !seen.empties.includes(empty.textContent.trim())) seen.empties.push(empty.textContent.trim());
    if (empty && /Loading/.test(empty.textContent)) seen.bad.push(`${why}: the terminal area says ${empty.textContent.trim()}`);
    const item = [...document.querySelectorAll('#h5-tasks .h5-task-row')].find(row => row.querySelector('.h5-task-title')?.textContent.trim() === want);
    if (!item) return;
    const box = item.parentElement;
    const names = [...box.querySelectorAll('.h5-terminal-main')].length;
    const count = box.querySelector('.h5-task-count')?.textContent.trim() || '';
    if (names !== expected) seen.bad.push(`${why}: ${names} session rows`);
    if (count !== `${expected} sessions`) seen.bad.push(`${why}: count "${count}"`);
  };
  sample('start');
  const observer = new MutationObserver(() => sample('mutation'));
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  const frame = () => { if (!seen.stopped) { sample('frame'); requestAnimationFrame(frame); } };
  requestAnimationFrame(frame);
  seen.stop = () => { seen.stopped = true; observer.disconnect(); };
}, { title, rows });
const stopWatch = page => page.evaluate(() => { window.watched.stop(); return { bad: window.watched.bad.slice(0, 10), samples: window.watched.samples, empties: window.watched.empties }; });

const socketsOf = (page, id) => page.evaluate(want => window.sockets.map(socket => ({ id: new URL(socket.url).searchParams.get('terminalId'), path: new URL(socket.url).pathname, state: socket.readyState })).filter(item => item.id === want), id);
const shownId = page => page.evaluate(() => document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId || null);
const xtermsOf = (page, id) => page.evaluate(want => document.querySelectorAll(`.h5-xterm[data-terminal-id="${want}"]`).length, id);
const expand = async ({ page, how }, title, names, what) => {
  await page.locator('#h5-tasks .h5-task-item', { hasText: title })[how]();
  await listed(page, title, names, what);
};
const tapRow = ({ page, how }, title, name) => taskBox(page, title).locator('.h5-terminal-main', { hasText: name })[how]();
async function reopenSheet({ page, how, wide }) {
  if (wide) return;
  await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
  await page.locator('#h5-open-tasks')[how]();
  await page.locator('#h5-tasks').waitFor({ state: 'visible' });
}

// The owner's case: the session "main dev" of the expanded remote task SELF-TAGENT.
async function tapExpanded(browser, wide) {
  const opened = await openPage(browser, wide);
  const { context, page, state, label } = opened;
  await expand(opened, 'SELF-TAGENT', ['review', 'main dev', 'notes'], `${label}: expanded`);
  state.slow.add(5);
  await watch(page, 'SELF-TAGENT', 3);
  const readsBefore = state.reads.length;
  await tapRow(opened, 'SELF-TAGENT', 'main dev');
  await page.waitForFunction(() => window.sockets.some(socket => new URL(socket.url).searchParams.get('terminalId') === 'r2'), null, { timeout: SLOW_MS - 300 });
  const slowRead = state.reads.slice(readsBefore).find(read => read.id === 5);
  assert.ok(slowRead, `${label}: the list of the task is read again`);
  assert.equal(slowRead.answered, false, `${label}: the socket of the tapped terminal opened before the list answered`);
  const [early] = await socketsOf(page, 'r2');
  assert.equal(early.path, `${BASE}/terminal/ws`, `${label}: the socket goes through the remote service`);
  assert.equal(await shownId(page), 'r2', `${label}: the tapped terminal is shown at once`);
  await reopenSheet(opened); // a phone: the sheet opened again before the answer still lists the sessions
  const during = await look(page, 'SELF-TAGENT');
  assert.ok(hasRows(during, ['review', 'main dev', 'notes']) && during.count === '3 sessions', `${label}: before the answer: ${JSON.stringify(during)}`);
  const current = await taskBox(page, 'SELF-TAGENT').locator('.h5-terminal-main[aria-current="true"]').allTextContents();
  assert.ok(current.length === 1 && current[0].includes('main dev'), `${label}: main dev is the current row before the answer (${current})`);
  const deadline = Date.now() + SLOW_MS + 3000;
  while (!slowRead.answered && Date.now() < deadline) await page.waitForTimeout(30);
  assert.ok(slowRead.answered, `${label}: the slow list answered`);
  await page.waitForTimeout(300);
  const seen = await stopWatch(page);
  assert.ok(seen.samples > 20, `${label}: the page was watched (${seen.samples} samples)`);
  assert.deepEqual(seen.bad, [], `${label}: the sessions, the count and the terminal area held on every frame`);
  await listed(page, 'SELF-TAGENT', ['review', 'main dev', 'notes'], `${label}: after the answer`);
  assert.equal(await shownId(page), 'r2', `${label}: still main dev after the answer`);
  const all = await socketsOf(page, 'r2');
  assert.equal(all.length, 1, `${label}: the answer does not connect again`);
  assert.equal(all[0].state, 1, `${label}: the socket is open`);
  assert.equal(await page.evaluate(() => localStorage.getItem('h5-terminal:remote:7:5')), 'r2', `${label}: the tapped terminal is remembered`);
  assert.equal(await page.locator('#h5-session-name').textContent(), 'main dev', `${label}: the header names it`);
  assert.deepEqual(state.errors, [], `${label}: no page errors`);
  await context.close();
}

// The tapped terminal was deleted on another device after the list was shown: it connects at once, and the answer closes it and opens the saved one.
async function deletedMeanwhile(browser, wide) {
  const opened = await openPage(browser, wide);
  const { context, page, state, label } = opened;
  await page.evaluate(() => localStorage.setItem('h5-terminal:remote:7:5', 'r3'));
  await expand(opened, 'SELF-TAGENT', ['review', 'main dev', 'notes'], `${label}: expanded`);
  state.rows[5] = [shell('r1', 'review'), shell('r3', 'notes renamed')]; // main dev is gone, notes was renamed
  state.slow.add(5);
  await tapRow(opened, 'SELF-TAGENT', 'main dev');
  await page.waitForFunction(() => window.sockets.some(socket => new URL(socket.url).searchParams.get('terminalId') === 'r2'), null, { timeout: SLOW_MS - 300 });
  assert.equal(await shownId(page), 'r2', `${label}: shown at once`);
  await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId === 'r3', null, { timeout: SLOW_MS + 3000 });
  const gone = await socketsOf(page, 'r2');
  assert.ok(gone.length === 1 && gone[0].state === 3, `${label}: the socket of the deleted terminal is closed: ${JSON.stringify(gone)}`);
  assert.equal(await xtermsOf(page, 'r2'), 0, `${label}: its view is gone too`);
  const saved = await socketsOf(page, 'r3');
  assert.ok(saved.length === 1 && saved[0].state === 1, `${label}: the saved terminal is connected: ${JSON.stringify(saved)}`);
  assert.equal(await page.evaluate(() => localStorage.getItem('h5-terminal:remote:7:5')), 'r3', `${label}: the saved terminal stays saved`);
  await reopenSheet(opened);
  await listed(page, 'SELF-TAGENT', ['review', 'notes renamed'], `${label}: the rows follow the server`);
  assert.equal(await page.locator('#h5-session-name').textContent(), 'notes renamed', `${label}: the header names the new one`);
  assert.deepEqual(state.errors, [], `${label}: no page errors`);
  await context.close();
}

// A Restart of the tapped terminal is still on its way: the rows stay listed, but nothing connects until it is done and the list was read after it.
async function restartPending(browser, wide) {
  const opened = await openPage(browser, wide);
  const { context, page, state, label, how } = opened;
  await expand(opened, 'SELF-TAGENT', ['review', 'main dev', 'notes'], `${label}: expanded`);
  await taskBox(page, 'SELF-TAGENT').locator('.h5-terminal-row', { hasText: 'main dev' }).locator('.h5-terminal-more')[how]();
  state.holdControl = true;
  await page.locator('#h5-session-menu [role="menuitem"]', { hasText: 'Restart in the working directory' })[how]();
  const deadline = Date.now() + 3000;
  while (!state.heldControls.length && Date.now() < deadline) await page.waitForTimeout(20);
  assert.equal(state.heldControls.length, 1, `${label}: the restart was sent and is held`);
  assert.deepEqual(state.controls, [{ action: 'restart-workdir', terminal_id: 'r2' }], `${label}: restart of main dev`);
  const readsBefore = state.reads.length;
  await tapRow(opened, 'SELF-TAGENT', 'main dev');
  await page.waitForTimeout(600);
  assert.deepEqual(await socketsOf(page, 'r2'), [], `${label}: nothing connects while the restart is on its way`);
  assert.equal(state.reads.slice(readsBefore).filter(read => read.id === 5).length, 0, `${label}: the list waits for the restart`);
  assert.equal(await page.locator('#h5-empty').textContent(), 'Loading…', `${label}: the terminal area waits`);
  await reopenSheet(opened);
  const during = await look(page, 'SELF-TAGENT');
  assert.ok(hasRows(during, ['review', 'main dev', 'notes']), `${label}: the rows stay listed meanwhile: ${JSON.stringify(during)}`);
  assert.equal(await taskBox(page, 'SELF-TAGENT').locator('.h5-terminal-main[aria-current="true"]').count(), 0, `${label}: no row is current yet`);
  for (const resolve of state.heldControls.splice(0)) resolve();
  await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId === 'r2', null, { timeout: 5000 });
  const reads = state.reads.slice(readsBefore).filter(read => read.id === 5);
  assert.ok(reads.length >= 1 && reads.every(read => read.answered), `${label}: the list was read after the restart`);
  const sockets = await socketsOf(page, 'r2');
  assert.ok(sockets.length === 1 && sockets[0].state === 1, `${label}: main dev connects once after the restart: ${JSON.stringify(sockets)}`);
  assert.deepEqual(state.errors, [], `${label}: no page errors`);
  await context.close();
}

// A task never expanded: nothing is known, so the terminal area says "Loading…" and nothing connects until its list is read.
async function neverExpanded(browser, wide) {
  const opened = await openPage(browser, wide);
  const { context, page, state, label, how } = opened;
  state.slow.add(6);
  await page.locator('#h5-tasks .h5-task-row', { hasText: 'Never opened' }).locator('.h5-task-add')[how]();
  await page.locator('#h5-new-session #h5-term-menu-cancel')[how]();
  await page.locator('#h5-new-session').waitFor({ state: 'detached' });
  assert.equal(await page.locator('#h5-empty').textContent(), 'Loading…', `${label}: the loading state`);
  assert.deepEqual(await socketsOf(page, 'n1'), [], `${label}: nothing connects before the list`);
  await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId === 'n1', null, { timeout: SLOW_MS + 3000 });
  assert.ok(state.reads.filter(read => read.id === 6).every(read => read.answered), `${label}: connected after the answer`);
  await listed(page, 'Never opened', ['Fresh shell'], `${label}: its list`);
  assert.equal(await page.locator('#h5-empty').count(), 0, `${label}: the loading note is gone`);
  assert.deepEqual(state.errors, [], `${label}: no page errors`);
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const wide of [true, false]) {
      await tapExpanded(browser, wide);
      await deletedMeanwhile(browser, wide);
      await restartPending(browser, wide);
      await neverExpanded(browser, wide);
    }
    console.log('h5 remote open: ok');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
