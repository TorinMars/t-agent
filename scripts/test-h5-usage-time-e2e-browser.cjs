#!/usr/bin/env node
// Usage time and memories end to end: the REAL server (its own data folder, port 0, a temporary HOME) and the REAL page in headless Chromium
// (1440x900 with a mouse, 390x844 with touch), with a FAKE OpenAI-compatible model for the weekly digest (a local http server; never a real model)
// and a fake older engine (a remote service whose /v1/info has no `usage:time`). The page runs on Playwright's clock, so page time passes without
// waiting; the session clocks run on the server's own clock in a real shell. Checked against the database (usage_time, memories):
// - beats reach the server with the right surface, kind, task, session and client (engine-neutral ids `<instance>|<task>[|<terminal>]`), the
//   page's `sent` moves them to the server's clock, idle 2 minutes stops them, a hidden tab sends none (what was queued goes with a beacon), a batch
//   answered `enabled: false` turns recording off;
// - a shell that runs `sleep` counts agent_working, a wait for the person (the activity hook's attention) counts waiting_you until the next key;
// - the Time tab shows the server's numbers (tiles, days, tasks, kinds), the range and device chips (with `tz`; the older engine "needs an update
//   first"), a task's sessions and a day's sessions in place, a session that opens, Export CSV / JSON, Clear;
// - "Remember this" from the session menu and the task menu saves notes that show in Memories with the task and session names, and open them;
// - events of a T-Attention confirm and send back and of a task created and archived; the kind chips; paging with `before`;
// - the digest switch is off by default; on, the first digest and "Write it again" go to the fake model, whose input holds only event lines,
//   notes and item titles / results (no terminal text); the card shows; Clear per tab; the Buttons tab still works.
// See docs/design/usage-time.md and docs/design/usage-time-page.md.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
const { chromium } = require('playwright');
const Database = require('better-sqlite3');
const { settled } = require('./browser-test-wait.cjs');

const ROOT = path.resolve(__dirname, '..');
const { encryptToken } = require(path.join(ROOT, 'lib', 'token-crypto'));
const SECRET = 'usage-time-e2e-test-secret-'.repeat(3);
const OWNER = 'local';
const TZ = 'Asia/Taipei';
const LIMIT_MS = 540000;
const XHR = { 'X-Requested-With': 'XMLHttpRequest' };
const TERMINAL_SECRET = 'E2E-TERMINAL-SECRET-7731';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const log = (...args) => { if (process.env.TIME_E2E_VERBOSE) console.log(...args); };

// ---- The fake model: every request is kept; answers are queued (else a default line). ----
function fakeModel() {
  const state = { requests: [], answers: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) { res.writeHead(404); res.end('{}'); return; }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* empty */ }
      state.requests.push({ body, raw });
      const content = state.answers.length ? state.answers.shift() : 'A quiet week.';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(Object.assign(state, { server, port: server.address().port }))));
}

// ---- A fake older engine: /v1/info without usage:time; everything else is not there. ----
function oldEngine() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/v1/info') {
      res.end(JSON.stringify({ name: 'Old01', engine_name: 'Old01', instance_id: 'inst-old-engine', app_version: '2.100.0', engine_version: '2.100.0', capabilities: ['terminal:control', 'tasks:read'] }));
      return;
    }
    if (url.pathname === '/v1/tasks') { res.end('[]'); return; }
    if (url.pathname === '/v1/task-groups') { res.end('[]'); return; }
    res.statusCode = 404;
    res.end('{"error":"NOT_FOUND"}');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// ---- The server ----
async function startServer(temp) {
  const data = path.join(temp, 'server-data');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', ACCESS_MODE: 'local', SESSION_SECRET: SECRET, TZ,
      T_AGENT_DATA_DIR: data, TAGENT_HOME: data, T_AGENT_DB_PATH: path.join(data, 'db.sqlite'), TASKS_BASE_DIR: path.join(temp, 'tasks'),
      SINGLE_USER_ID: OWNER, UPDATE_CHECK_ENABLED: 'false', HOME: path.join(temp, 'home'), ZDOTDIR: path.join(temp, 'home'), SHELL: '/bin/zsh',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server startup timed out: ${output}`)), 30000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`server exited: ${output}`)); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      const found = output.match(/Server running at http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timer); resolve(Number(found[1])); }
    });
  });
  return { base: `http://127.0.0.1:${port}`, child, dbPath: path.join(data, 'db.sqlite'), log: () => output };
}
// The translator configuration as services/translator.js stores it (system_state `translator:<owner>`, encrypted with the session secret), pointing
// at the fake model (the settings route takes only https). The key is a dummy.
function configureModel(dbPath, port) {
  const db = new Database(dbPath);
  try {
    db.pragma('busy_timeout = 5000');
    const value = {
      enabled: true, provider: 'deepseek',
      providers: { deepseek: { apiKey: 'dummy-test-key', baseUrl: `http://127.0.0.1:${port}`, model: 'fake-model' }, glm: { apiKey: '', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash' } },
    };
    db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(`translator:${OWNER}`, encryptToken(JSON.stringify(value), SECRET));
  } finally { db.close(); }
}
const readDb = (dbPath, fn) => { const db = new Database(dbPath, { readonly: true, fileMustExist: true }); try { db.pragma('busy_timeout = 5000'); return fn(db); } finally { db.close(); } };

// ---- Helpers ----
const pageErrors = [];
async function openPage(browser, base, { viewport, touch = false }) {
  const context = await browser.newContext({
    viewport, timezoneId: TZ, acceptDownloads: true,
    ...(touch ? { isMobile: true, hasTouch: true, userAgent: IPHONE } : {}),
  });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(`${touch ? 'phone' : 'computer'}: ${error.message}`));
  const requests = [];
  page.on('request', request => {
    const u = new URL(request.url());
    if (u.pathname.startsWith('/api/usage-time') || u.pathname.startsWith('/api/memories')) requests.push({ method: request.method(), path: u.pathname + u.search, body: request.postData() });
  });
  // Page time on Playwright's clock (it also flows by itself); the server keeps its real clock, so the page's clock runs ahead as the test jumps.
  await page.clock.install({ time: Date.now() });
  await page.addInitScript(() => {
    try { localStorage.setItem('h5-columns', JSON.stringify({ on: false })); } catch { /* none */ }
    // The tab's visibility, set by the test (headless Chromium is always visible).
    window.__hidden = false;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__hidden ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
    // The beacons are counted, and still sent for real.
    window.__beacons = 0;
    const send = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => { window.__beacons += 1; return send(url, data); };
  });
  await page.goto(`${base}/h5`);
  await page.waitForFunction(() => window.H5UI && window.H5UI.get().usageTimeRecording === true, null, { timeout: 20000 });
  return { context, page, requests };
}
const api = (page, method, url, body) => page.evaluate(async ([m, u, b, headers]) => {
  const res = await fetch(u, { method: m, headers: { ...headers, ...(b ? { 'Content-Type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}, [method, url, body, XHR]);
const waitFor = async (check, message, timeout = 15000) => {
  const end = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error(`Timed out: ${message}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const press = (page, touch, target) => { const loc = typeof target === 'string' ? page.locator(target).first() : target; return touch ? loc.tap() : loc.click(); };
const text = loc => loc.evaluate(el => el.textContent.replace(/\s+/g, ' ').trim());

async function openGroup(page, tab, touch = false) {
  if (await page.evaluate(() => window.H5UI.get().settingsOpen)) {
    await page.evaluate(() => window.H5UI.actions.closeSettings());
    await page.waitForFunction(() => !window.H5UI.get().settingsOpen);
  }
  await page.evaluate(() => window.H5UI.actions.openSettings('usage-data'));
  await page.locator('#h5-set-usage-data').waitFor({ state: 'visible' });
  await settled(page);
  if (tab) {
    await press(page, touch, page.locator(`#h5-usage-tab-${tab}`));
    await page.locator(`#h5-usage-panel-${tab}`).waitFor({ state: 'visible' });
  }
}
async function showTasks(page, touch) {
  if (touch && !(await page.locator('#h5-tasks').isVisible())) {
    await page.evaluate(() => window.H5UI.actions.openTasks());
    await page.locator('#h5-tasks .h5-task-item').first().waitFor({ state: 'visible' });
    await settled(page);
  }
}
async function openSession(page, touch, title, terminalId) {
  await showTasks(page, touch);
  const row = page.locator(`.h5-terminal-row[data-session="${terminalId}"] .h5-terminal-main`);
  if (!(await row.isVisible())) await press(page, touch, page.locator('.h5-task-item', { hasText: title }).first());
  await row.waitFor({ state: 'visible' });
  await press(page, touch, row);
  await page.waitForFunction(id => window.H5UI.get().shownTarget && window.H5UI.get().shownTarget.terminalId === id, terminalId);
}

// Page time rows of the database.
const timeRows = dbPath => readDb(dbPath, db => db.prepare('SELECT * FROM usage_time ORDER BY start, uid').all());
const pageSum = (dbPath, where = () => true) => timeRows(dbPath).filter(where).reduce((sum, row) => sum + row.page_s, 0);

async function main() {
  const model = await import(path.join(ROOT, 'scripts', 'h5-shell', 'usage-time-model.mjs'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-usage-time-e2e-'));
  const home = path.join(temp, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.zshrc'), "PROMPT='$ '\nRPROMPT=''\n");
  fs.writeFileSync(path.join(home, '.bashrc'), "PS1='$ '\n");
  const work = path.join(temp, 'work');
  fs.mkdirSync(work, { recursive: true });
  const fake = await fakeModel();
  const old = await oldEngine();
  const server = await startServer(temp);
  configureModel(server.dbPath, fake.port);
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    // ======== The computer (1440x900, a mouse) ========
    const one = await openPage(browser, server.base, { viewport: { width: 1440, height: 900 } });
    const { page } = one;
    const version = await api(page, 'GET', '/api/system/version');
    const inst = version.data.instance_id;
    assert.match(inst, /^[A-Za-z0-9-]+$/, 'the engine has an instance id');
    const made = await api(page, 'POST', '/api/tasks', { title: 'Time E2E', work_dir: work });
    assert.ok(made.status === 200 || made.status === 201, `the task was made: ${JSON.stringify(made)}`);
    const taskId = made.data.id;
    const shell = await api(page, 'POST', `/api/tasks/${taskId}/terminals`, { title: 'Build shell' });
    assert.equal(shell.status, 201, JSON.stringify(shell));
    const tid = shell.data.terminal_id;
    const TASK = `${inst}|${taskId}`;
    const SESSION = `${TASK}|${tid}`;
    const other = await api(page, 'POST', '/api/tasks', { title: 'Archive me', work_dir: work });
    // The older engine, added as a service: its /v1/info has no usage:time.
    const added = await api(page, 'POST', '/api/remote-servers', { name: 'Old01', url: `http://127.0.0.1:${old.port}`, token: 'dummy-old-token' });
    log('old engine added', added.status, JSON.stringify(added.data));
    await page.reload();
    await page.waitForFunction(() => window.H5UI && window.H5UI.get().usageTimeRecording === true, null, { timeout: 20000 });

    // ---- The settings route, and what the server refuses ----
    let answer = await api(page, 'GET', '/api/usage-time/settings');
    assert.deepEqual(answer.data, { usage_time_record: true, usage_memories_digest: false }, 'the defaults: Record time on, the digest off');
    answer = await api(page, 'PUT', '/api/usage-time/settings', { usage_time_record: 'yes' });
    assert.deepEqual([answer.status, answer.data.error], [400, 'INVALID_USAGE_TIME_SETTING']);
    // The page's id form is the server's: an id with ':' (the task order's form) is refused, '|' is taken.
    answer = await api(page, 'POST', '/api/usage-time/beats', { client: 'computer', beats: [{ at: Date.now(), surface: 'sessions', kind: 'terminal', task: `${inst}:${taskId}`, session: null, seconds: 15 }] });
    assert.equal(answer.status, 400, 'a colon id is not engine-neutral for the server');

    // ---- Beats ----
    await openSession(page, false, 'Time E2E', tid);
    // The clicks that opened the session were activity; let their beats go and the clock go idle.
    await page.clock.runFor(5 * 60000);
    await waitFor(() => pageSum(server.dbPath) > 0, 'the beats of the opening clicks reach the server');
    let rows = timeRows(server.dbPath).filter(row => row.page_s > 0);
    const sessionRow = rows.find(row => row.surface === 'sessions');
    assert.ok(sessionRow, `a sessions row: ${JSON.stringify(rows)}`);
    assert.deepEqual([sessionRow.kind, sessionRow.task, sessionRow.session, sessionRow.client, sessionRow.engine], ['terminal', TASK, SESSION, 'computer', ''], 'the beat names the shown session by engine-neutral ids');
    // `sent` moved the beats to the server's clock: the page's clock is minutes ahead, the rows are in the server's current or last hour.
    const pageAhead = (await page.evaluate(() => Date.now())) - Date.now();
    assert.ok(pageAhead > 4 * 60000, `the page clock is ahead: ${pageAhead}`);
    assert.ok(rows.every(row => row.start <= Date.now() && row.start > Date.now() - 2 * 3600000), 'rows in the server\'s hours');
    // One activity, then idle: 8 beats of 15 s (2 minutes), then nothing more.
    let before = pageSum(server.dbPath);
    await page.mouse.move(400, 400);
    await page.mouse.move(420, 410);
    await page.clock.runFor(5 * 60000);
    await waitFor(() => pageSum(server.dbPath) > before, 'the beats of the activity');
    await sleep(500);
    const afterActivity = pageSum(server.dbPath);
    assert.ok(afterActivity - before >= 105 && afterActivity - before <= 135, `about 2 minutes counted: ${afterActivity - before}`);
    await page.clock.runFor(5 * 60000);
    await sleep(800);
    assert.equal(pageSum(server.dbPath), afterActivity, 'idle for 2 minutes: no beat');
    // A hidden tab: what was queued goes with a beacon (and lands), and nothing while hidden.
    await page.mouse.move(300, 300);
    await page.clock.runFor(30000);
    await page.evaluate(() => { window.__hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => pageSum(server.dbPath) > afterActivity, 'the beacon of a hidden tab reaches the server');
    assert.ok(await page.evaluate(() => window.__beacons) >= 1, 'it went with a beacon');
    const hidden = pageSum(server.dbPath);
    assert.ok(hidden - afterActivity >= 15 && hidden - afterActivity <= 45, `the queued beats: ${hidden - afterActivity}`);
    await page.mouse.move(310, 310);
    await page.keyboard.press('Shift');
    await page.clock.runFor(3 * 60000);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await sleep(800);
    assert.equal(pageSum(server.dbPath), hidden, 'never a beat from a hidden tab');
    await page.evaluate(() => { window.__hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    // Settings open: surface `settings`, no task or session.
    await openGroup(page, null);
    await page.mouse.move(500, 500);
    await page.clock.runFor(3 * 60000);
    await waitFor(() => timeRows(server.dbPath).some(row => row.surface === 'settings' && row.page_s > 0), 'a settings beat');
    assert.ok(timeRows(server.dbPath).filter(row => row.surface === 'settings').every(row => row.task === '' && row.session === '' && row.kind === ''), 'a Settings beat names no session');
    await page.evaluate(() => window.H5UI.actions.closeSettings());
    console.log('beats: surface, kind, task, session, client, the clock correction, idle, hidden: passed');

    // ---- The session clocks: a running command and a wait for the person ----
    await openSession(page, false, 'Time E2E', tid);
    const typeIn = async line => {
      await page.evaluate(() => document.querySelector('#h5-terminal .h5-xterm:not([hidden]) .xterm-helper-textarea').focus());
      await page.keyboard.type(line);
      await page.keyboard.press('Enter');
    };
    await page.locator('#h5-terminal .h5-xterm:not([hidden]) .xterm-helper-textarea').waitFor({ state: 'attached', timeout: 20000 });
    await sleep(1500); // the shell starts
    await typeIn(`echo ${TERMINAL_SECRET}; sleep 7`);
    const activity = () => api(page, 'GET', '/api/tasks/terminal-activity').then(res => JSON.stringify(res.data));
    await waitFor(async () => /running/.test(await activity()), 'the shell runs sleep', 10000);
    await waitFor(async () => !/running/.test(await activity()), 'sleep ends', 15000);
    // The activity hook's attention: the session waits for the person.
    await typeIn('curl -s -m 2 -o /dev/null -X POST -H "X-TA-Token: $TA_HOOK_TOKEN" "$TA_HOOK_URL&event=attention&kind=accept"');
    await waitFor(async () => /accept/.test(JSON.stringify((await api(page, 'GET', '/api/tasks/terminal-activity?kinds=1')).data.waiting_kind)), 'the session waits for the person', 10000);
    await sleep(5000);
    await page.evaluate(() => document.querySelector('#h5-terminal .h5-xterm:not([hidden]) .xterm-helper-textarea').focus());
    await page.keyboard.type('x'); // the person's next input ends the wait
    await sleep(500);
    await page.keyboard.press('Backspace');
    // Written every 60 s.
    const clockRow = () => timeRows(server.dbPath).filter(row => row.surface === '' && row.session === SESSION);
    await waitFor(() => { const list = clockRow(); return list.reduce((s, r) => s + r.working_s, 0) >= 5 && list.reduce((s, r) => s + r.waiting_s, 0) >= 4; }, 'agent_working and waiting_you are written', 80000);
    const clock = clockRow();
    const worked = clock.reduce((s, r) => s + r.working_s, 0);
    const waited = clock.reduce((s, r) => s + r.waiting_s, 0);
    assert.ok(worked >= 5 && worked <= 12, `agent_working of sleep 7: ${worked}`);
    assert.ok(waited >= 4 && waited <= 9, `waiting_you until the next key: ${waited}`);
    assert.ok(clock.every(row => row.kind === 'terminal' && row.task === TASK && row.client === ''), 'a shell is a terminal session of its task');
    assert.ok(clock.some(row => row.waits), 'the finished wait is counted for the median');
    console.log(`session clocks: agent_working ${worked} s, waiting_you ${waited} s: passed`);

    // ---- Shapes of the reads ----
    const q = `tz=${encodeURIComponent(TZ)}`;
    const summary = (await api(page, 'GET', `/api/usage-time/summary?range=week&device=all&${q}`)).data;
    const all = timeRows(server.dbPath);
    assert.equal(summary.tz, TZ);
    assert.equal(summary.tiles.page_s, all.reduce((s, r) => s + r.page_s, 0), 'page_s is the sum of the rows');
    assert.equal(summary.tiles.working_s, all.reduce((s, r) => s + r.working_s, 0));
    assert.equal(summary.tiles.waiting_s, all.reduce((s, r) => s + r.waiting_s, 0));
    assert.ok(summary.tiles.median_wait_s > 0, 'a median wait');
    const listedTask = summary.tasks.find(row => row.task === TASK);
    assert.equal(listedTask.title, 'Time E2E', 'the server names the task by its engine-neutral id');
    assert.equal(listedTask.looked_s, all.filter(r => r.task === TASK).reduce((s, r) => s + r.page_s, 0));
    assert.ok(summary.kinds.every(row => row.share > 0 && row.share <= 1), 'kinds.share is a fraction');
    assert.equal(summary.devices[0].id, inst);
    assert.equal(summary.devices[0].self, true);
    const taskAnswer = (await api(page, 'GET', `/api/usage-time/task?task=${encodeURIComponent(TASK)}&range=week&device=all&${q}`)).data;
    assert.ok(Array.isArray(taskAnswer.sessions), '/task answers { sessions }');
    assert.deepEqual(taskAnswer.sessions.map(row => [row.session, row.title, row.kind]), [[SESSION, 'Build shell', 'terminal']]);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
    const dayAnswer = (await api(page, 'GET', `/api/usage-time/day?day=${today}&device=all&${q}`)).data;
    assert.ok(dayAnswer.tasks.find(row => row.task === TASK).sessions.some(row => row.session === SESSION), '/day answers tasks with their sessions');
    assert.equal((await api(page, 'GET', `/api/usage-time/summary?range=week&device=${inst}&${q}`)).data.tiles.page_s, summary.tiles.page_s, 'this device is all the rows');

    // ---- The Time tab ----
    await openGroup(page, 'time');
    await page.locator('#h5-usage-tiles .h5-usage-tile').first().waitFor({ state: 'visible' });
    const shown = (await api(page, 'GET', `/api/usage-time/summary?range=week&device=all&${q}`)).data;
    const tiles = model.tiles(shown, 'week');
    for (const tile of tiles) assert.equal(await text(page.locator(`#h5-usage-tiles [data-tile="${tile.id}"] .h5-usage-tile-value`)), tile.value, `tile ${tile.id}`);
    assert.ok(one.requests.some(r => r.path.startsWith('/api/usage-time/summary?range=week&device=all&tz=Asia%2FTaipei')), 'the page sends its time zone');
    assert.equal(await page.locator('#h5-usage-bars .h5-usage-day').count(), shown.days.length, 'a bar per day of the range');
    const todayBar = model.bars(shown.days, 'week').find(bar => bar.day === today);
    assert.equal(await page.locator(`#h5-usage-bars .h5-usage-day[data-day="${today}"]`).getAttribute('aria-label'), todayBar.text);
    assert.equal(await text(page.locator(`.h5-usage-task[data-task="${TASK}"] .h5-usage-task-name`)), 'Time E2E');
    assert.equal(await text(page.locator(`.h5-usage-task[data-task="${TASK}"] .h5-usage-task-text`)), model.lookedText(shown.tasks.find(row => row.task === TASK)));
    assert.match(await text(page.locator('#h5-usage-time-hint')), /Kinds of session: terminals 100%\./);
    // The device chip: this machine, and the older engine that needs an update first.
    if (added.status === 201) {
      await page.waitForFunction(() => (window.H5UI.get().sources || []).some(from => from.key !== 'local' && Array.isArray(from.capabilities)), null, { timeout: 15000 });
      await openGroup(page, 'time');
      await page.locator('#h5-usage-time-old').waitFor({ state: 'visible' });
      assert.equal(await text(page.locator('#h5-usage-time-old')), 'Old01 needs an update first');
    }
    await page.locator('#h5-usage-device').click();
    await page.locator('#h5-usage-device-menu .h5-usage-device-choice').first().waitFor({ state: 'visible' });
    const choices = (await page.locator('#h5-usage-device-menu .h5-usage-device-choice').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim());
    assert.equal(choices[0], 'All devices');
    assert.ok(choices.length >= 2, `this machine is listed: ${choices}`);
    await page.locator(`#h5-usage-device-menu [data-device="${inst}"]`).click();
    await waitFor(() => one.requests.some(r => r.path.startsWith(`/api/usage-time/summary?range=week&device=${inst}&tz=`)), 'the summary of one device');
    await page.locator('#h5-usage-range-today').click();
    await waitFor(() => one.requests.some(r => r.path.startsWith(`/api/usage-time/summary?range=today&device=${inst}&tz=Asia%2FTaipei`)), 'the summary of today');
    await page.locator('#h5-usage-range-today[aria-pressed="true"]').waitFor();
    const todaySummary = (await api(page, 'GET', `/api/usage-time/summary?range=today&device=${inst}&${q}`)).data;
    await page.waitForFunction(value => document.querySelector('#h5-usage-tiles [data-tile="page"] .h5-usage-tile-value').textContent === value, model.duration(todaySummary.tiles.page_s));
    // A day's sessions, and a task's sessions, in place.
    await page.locator(`#h5-usage-bars .h5-usage-day[data-day="${today}"]`).click();
    await page.locator(`#h5-usage-day-sessions .h5-usage-session[data-session="${SESSION}"]`).waitFor({ state: 'visible' });
    await page.locator(`.h5-usage-task[data-task="${TASK}"]`).click();
    await page.locator(`#h5-usage-task-sessions .h5-usage-session[data-session="${SESSION}"]`).waitFor({ state: 'visible' });
    assert.equal(await text(page.locator(`#h5-usage-task-sessions .h5-usage-session[data-session="${SESSION}"] .h5-usage-session-name`)), 'Build shell');
    assert.ok(one.requests.some(r => r.path.startsWith(`/api/usage-time/task?task=${encodeURIComponent(TASK)}&range=today&device=${inst}&tz=`)));
    // Export CSV and JSON: every row of the database.
    const download = async selector => {
      const [file] = await Promise.all([page.waitForEvent('download'), page.locator(selector).click()]);
      return fs.readFileSync(await file.path(), 'utf8');
    };
    const json = JSON.parse(await download('#h5-usage-time-export'));
    assert.equal(json.time.length, timeRows(server.dbPath).length, 'the JSON export has every row');
    assert.ok(json.time.some(row => row.task === TASK && row.session === SESSION && row.engine === inst));
    const csv = (await download('#h5-usage-time-export-csv')).trim().split('\n');
    assert.equal(csv[0], 'day,hour,start,engine,engine_name,client,surface,kind,task,session,page_s,working_s,waiting_s');
    assert.equal(csv.length - 1, timeRows(server.dbPath).length, 'the CSV export has every row');
    assert.ok(!csv.join('\n').includes(TERMINAL_SECRET), 'no terminal text in the export');
    // A session opens from the Time tab, and Settings closes.
    await page.evaluate(() => window.H5UI.actions.closeSettings());
    await page.evaluate(() => window.H5UI.actions.openTasks && window.H5UI.actions.openTasks());
    await openGroup(page, 'time');
    await page.locator(`.h5-usage-task[data-task="${TASK}"]`).click();
    await page.locator(`#h5-usage-task-sessions .h5-usage-session[data-session="${SESSION}"]`).click();
    await page.waitForFunction(() => !window.H5UI.get().settingsOpen);
    await page.waitForFunction(id => window.H5UI.get().shownTarget && window.H5UI.get().shownTarget.terminalId === id, tid);
    console.log('Time tab: tiles, days, tasks, kinds, tz, range and device chips, an older engine, sessions in place, Export: passed');

    // ---- "Remember this" from the session menu and the task menu ----
    const remember = async (open, note) => {
      await open();
      await page.locator('#h5-task-dialog.h5-remember-dialog').waitFor({ state: 'visible' });
      await settled(page);
      assert.equal(await text(page.locator('#h5-remember-caption')), 'Saves a note with the time and this task and session. The terminal text is not saved.');
      await page.locator('#h5-remember-text').fill(note);
      await page.locator('#h5-task-dialog-ok').click();
      await page.locator('#h5-task-dialog').waitFor({ state: 'detached' });
      return readDb(server.dbPath, db => db.prepare("SELECT * FROM memories WHERE kind = 'note' AND text = ?").get(note));
    };
    let saved = await remember(async () => {
      await page.locator(`.h5-terminal-row[data-session="${tid}"] .h5-terminal-more`).click();
      await page.locator('#h5-session-menu [role="menuitem"]', { hasText: 'Remember this' }).click();
    }, 'The build needs the cache warmed first');
    assert.deepEqual([saved.task, saved.session, saved.source], [TASK, SESSION, 'person'], 'the session note names the task and session');
    saved = await remember(async () => {
      await page.locator('.h5-task-head', { has: page.locator('.h5-task-item', { hasText: 'Time E2E' }) }).first().locator('.h5-task-more').click();
      await page.locator('#h5-session-menu [role="menuitem"]', { hasText: 'Remember this' }).click();
    }, 'Time E2E ships on Friday');
    assert.deepEqual([saved.task, saved.session], [TASK, ''], 'the task note names the task only');

    // ---- Events: T-Attention confirm and send back, a task archived ----
    const item1 = await api(page, 'POST', '/api/attention', { title: 'Ship the report', status: 'review', result: 'Report sent to the team' });
    assert.equal(item1.status, 201, JSON.stringify(item1));
    const item2 = await api(page, 'POST', '/api/attention', { title: 'Fix the flaky test', status: 'review' });
    assert.equal((await api(page, 'PATCH', `/api/attention/${item1.data.id}`, { status: 'done' })).status, 200);
    assert.equal((await api(page, 'PATCH', `/api/attention/${item2.data.id}`, { status: 'working' })).status, 200);
    assert.equal((await api(page, 'POST', `/api/tasks/${other.data.id}/archive`)).status, 200);
    const events = () => readDb(server.dbPath, db => db.prepare("SELECT event, text, task FROM memories WHERE kind = 'event' AND deleted = 0 ORDER BY at").all());
    await waitFor(() => events().length >= 4, 'the events are written');
    const lines = events().map(row => row.text);
    for (const line of ['Task "Time E2E" created', 'You confirmed "Ship the report"', 'You sent "Fix the flaky test" back', 'Task "Archive me" archived']) assert.ok(lines.includes(line), `event "${line}" in ${JSON.stringify(lines)}`);
    assert.equal(events().find(row => row.event === 'task-archived').task, `${inst}|${other.data.id}`);

    // ---- The memories API: paging with `before`, a digest kind ----
    for (const n of [1, 2, 3]) { await api(page, 'POST', '/api/memories', { text: `Paging note ${n}`, task: TASK }); await sleep(5); }
    const first = (await api(page, 'GET', '/api/memories?kind=note&limit=2')).data;
    assert.equal(first.items.length, 2);
    assert.equal(first.has_more, true);
    const next = (await api(page, 'GET', `/api/memories?kind=note&limit=2&before=${first.items[1].at}`)).data;
    const noteCount = readDb(server.dbPath, db => db.prepare("SELECT COUNT(*) FROM memories WHERE kind = 'note' AND deleted = 0").pluck().get());
    assert.equal(new Set([...first.items, ...next.items].map(item => item.uid)).size, Math.min(4, noteCount), 'the next page follows on');
    assert.deepEqual((await api(page, 'GET', '/api/memories?q=&kind=digest&limit=1')).data.items, [], 'no digest yet');
    const sessionNote = (await api(page, 'GET', '/api/memories?q=cache%20warmed&kind=note&limit=5')).data.items[0];
    assert.deepEqual([sessionNote.task_title, sessionNote.session_title], ['Time E2E', 'Build shell'], 'a note comes with its task and session titles');

    // ---- The Memories tab ----
    await openGroup(page, 'memories');
    await page.locator('#h5-memories-list .h5-memory').first().waitFor({ state: 'visible' });
    const where = uid => text(page.locator(`.h5-memory[data-uid="${uid}"] .h5-memory-where`));
    assert.equal(await where(sessionNote.uid), 'Time E2E · Build shell · your note');
    const confirm = (await api(page, 'GET', '/api/memories?q=You%20confirmed&kind=event&limit=5')).data.items[0];
    assert.equal(await text(page.locator(`.h5-memory[data-uid="${confirm.uid}"] .h5-memory-text`)), 'You confirmed "Ship the report"');
    await page.locator('#h5-memories-kind-event').click();
    await waitFor(() => one.requests.some(r => r.path.startsWith('/api/memories?q=&kind=event')), 'the Events chip');
    await page.waitForFunction(() => { const list = [...document.querySelectorAll('#h5-memories-list .h5-memory')]; return list.length >= 4 && list.every(item => item.dataset.kind === 'event'); });
    await page.locator('#h5-memories-kind-note').click();
    await page.waitForFunction(() => { const list = [...document.querySelectorAll('#h5-memories-list .h5-memory')]; return list.length >= 2 && list.every(item => item.dataset.kind === 'note'); });
    await page.locator('#h5-memories-search').fill('cache warmed');
    await page.waitForFunction(() => document.querySelectorAll('#h5-memories-list .h5-memory').length === 1);
    // A click on the session note opens its session (Settings closes).
    await page.evaluate(() => window.H5UI.actions.openTasks && window.H5UI.actions.openTasks());
    await page.locator(`.h5-memory[data-uid="${sessionNote.uid}"] .h5-memory-open`).click();
    await page.waitForFunction(() => !window.H5UI.get().settingsOpen);
    await page.waitForFunction(id => window.H5UI.get().shownTarget && window.H5UI.get().shownTarget.terminalId === id, tid);
    console.log('Remember this, events, paging and the Memories tab: passed');

    // ---- The weekly digest with the fake model ----
    await openGroup(page, 'memories');
    await page.locator('#h5-memories-list .h5-memory').first().waitFor({ state: 'visible' });
    assert.equal(await page.locator('#h5-memories-digest-enabled').isChecked(), false, 'the digest is off by default');
    assert.equal(await page.locator('#h5-memories-digest-now').count(), 0, 'nothing to write while it is off');
    assert.equal(fake.requests.length, 0, 'nothing went to the model yet');
    await page.locator('#h5-memories-digest-enabled').click();
    await waitFor(async () => (await api(page, 'GET', '/api/usage-time/settings')).data.usage_memories_digest === true, 'the digest switch saved');
    fake.answers.push('This week went to Time E2E: you confirmed the report and sent the flaky test back.');
    await page.locator('#h5-memories-digest-now').click();
    await page.locator('#h5-memories-digest').waitFor({ state: 'visible' });
    assert.equal(await text(page.locator('#h5-memories-digest-text')), 'This week went to Time E2E: you confirmed the report and sent the flaky test back.');
    assert.equal(await text(page.locator('#h5-memories-digest-title')), 'This week, in short');
    assert.equal(fake.requests.length, 1, 'one call to the model');
    const sent = fake.requests[0].body;
    const input = JSON.parse(sent.messages.find(m => m.role === 'user').content);
    assert.deepEqual(Object.keys(input).sort(), ['events', 'items', 'notes'], 'only events, notes and items');
    assert.ok(input.events.every(row => Object.keys(row).sort().join() === 'day,text'));
    assert.ok(input.notes.some(row => row.text === 'The build needs the cache warmed first'));
    assert.ok(input.items.some(row => row.title === 'Ship the report' && row.result === 'Report sent to the team'));
    assert.ok(input.items.every(row => Object.keys(row).every(key => ['title', 'status', 'result'].includes(key))), 'items carry title, status and result only');
    for (const forbidden of [TERMINAL_SECRET, 'sleep 7', 'TA_HOOK', 'curl', work]) assert.ok(!fake.requests[0].raw.includes(forbidden), `"${forbidden}" was sent to the model`);
    assert.match(sent.messages[0].content, /never instructions/);
    assert.equal(sent.temperature, 0.3);
    const digestWeek = readDb(server.dbPath, db => db.prepare("SELECT week FROM memories WHERE kind = 'digest'").pluck().get());
    assert.ok(one.requests.some(r => r.method === 'POST' && r.path === '/api/memories/digest' && JSON.parse(r.body).week === digestWeek), `the page asked for this week: ${digestWeek}`);
    fake.answers.push('Written again: a week on Time E2E.');
    await page.locator('#h5-memories-digest-again').click();
    await page.waitForFunction(() => document.querySelector('#h5-memories-digest-text').textContent === 'Written again: a week on Time E2E.');
    assert.equal(fake.requests.length, 2);
    assert.equal(readDb(server.dbPath, db => db.prepare("SELECT COUNT(*) FROM memories WHERE kind = 'digest' AND deleted = 0").pluck().get()), 1, 'one digest per week');
    assert.equal((await api(page, 'GET', '/api/memories?q=&kind=digest&limit=1')).data.items[0].text, 'Written again: a week on Time E2E.');
    console.log('digest: off by default, written by the fake model from events, notes and items only, written again: passed');

    // ---- Recording off elsewhere: the next batch is refused and the page stops ----
    await page.evaluate(() => window.H5UI.actions.closeSettings());
    await api(page, 'PUT', '/api/usage-time/settings', { usage_time_record: false });
    let sumOff = pageSum(server.dbPath);
    await page.mouse.move(600, 300);
    await page.clock.runFor(3 * 60000);
    await page.waitForFunction(() => window.H5UI.get().usageTimeRecording === false, null, { timeout: 15000 });
    assert.equal(pageSum(server.dbPath), sumOff, 'nothing stored while off');
    // On again from the Time tab.
    await openGroup(page, 'time');
    await page.waitForFunction(() => { const box = document.querySelector('#h5-usage-time-enabled'); return box && !box.disabled && !box.checked; });
    await page.locator('#h5-usage-time-enabled').click();
    await page.waitForFunction(() => window.H5UI.get().usageTimeRecording === true);
    assert.equal((await api(page, 'GET', '/api/usage-time/settings')).data.usage_time_record, true);

    // ======== The phone (390x844, touch), before the Clear: its beats are dated up to 2 minutes back by the page's clock ========
    const two = await openPage(browser, server.base, { viewport: { width: 390, height: 844 }, touch: true });
    const phone = two.page;
    await openSession(phone, true, 'Time E2E', tid);
    await phone.clock.runFor(5 * 60000);
    await waitFor(() => timeRows(server.dbPath).some(row => row.client === 'phone' && row.page_s > 0), 'the phone\'s beats');
    rows = timeRows(server.dbPath).filter(row => row.client === 'phone' && row.surface === 'sessions');
    assert.ok(rows.length && rows.every(row => row.task === TASK && row.session === SESSION && row.kind === 'terminal'), `phone beats name the session: ${JSON.stringify(rows)}`);
    // Remember this from the session menu, by touch.
    await showTasks(phone, true);
    await press(phone, true, phone.locator(`.h5-terminal-row[data-session="${tid}"] .h5-terminal-more`));
    await press(phone, true, phone.locator('#h5-session-menu [role="menuitem"]', { hasText: 'Remember this' }));
    await phone.locator('#h5-task-dialog.h5-remember-dialog').waitFor({ state: 'visible' });
    await settled(phone);
    await phone.locator('#h5-remember-text').fill('Noted on the phone');
    await press(phone, true, phone.locator('#h5-task-dialog-ok'));
    await phone.locator('#h5-task-dialog').waitFor({ state: 'detached' });
    const phoneNote = readDb(server.dbPath, db => db.prepare("SELECT * FROM memories WHERE text = 'Noted on the phone' AND deleted = 0").get());
    assert.deepEqual([phoneNote.task, phoneNote.session], [TASK, SESSION]);
    // The Time tab on the phone: the server's numbers, two tiles a row, no sideways scroll.
    await openGroup(phone, 'time', true);
    await phone.locator('#h5-usage-tiles .h5-usage-tile').first().waitFor({ state: 'visible' });
    const phoneSummary = (await api(phone, 'GET', `/api/usage-time/summary?range=week&device=all&${q}`)).data;
    assert.equal(await text(phone.locator('#h5-usage-tiles [data-tile="page"] .h5-usage-tile-value')), model.duration(phoneSummary.tiles.page_s));
    const tops = await phone.evaluate(() => [...document.querySelectorAll('#h5-usage-tiles .h5-usage-tile')].map(tile => Math.round(tile.getBoundingClientRect().top)));
    assert.equal(new Set(tops).size, 2, `two rows of tiles: ${tops}`);
    assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth) <= 390, 'no sideways scroll');
    await press(phone, true, phone.locator(`.h5-usage-task[data-task="${TASK}"]`));
    await phone.locator(`#h5-usage-task-sessions .h5-usage-session[data-session="${SESSION}"]`).waitFor({ state: 'visible' });
    // Memories on the phone: the note, and a tap opens the session.
    await press(phone, true, phone.locator('#h5-usage-tab-memories'));
    await phone.locator(`.h5-memory[data-uid="${phoneNote.uid}"]`).waitFor({ state: 'visible' });
    assert.equal(await text(phone.locator(`.h5-memory[data-uid="${phoneNote.uid}"] .h5-memory-where`)), 'Time E2E · Build shell · your note');
    await press(phone, true, phone.locator(`.h5-memory[data-uid="${phoneNote.uid}"] .h5-memory-open`));
    await phone.waitForFunction(() => !window.H5UI.get().settingsOpen);
    await phone.waitForFunction(id => window.H5UI.get().shownTarget && window.H5UI.get().shownTarget.terminalId === id, tid);
    console.log('phone: beats, Remember this, the Time and Memories tabs by touch: passed');
    await two.context.close();

    // ---- Clear per tab ----
    await page.locator('#h5-usage-time-clear').click();
    await page.locator('#h5-usage-time-clear-dialog').waitFor({ state: 'visible' });
    await settled(page);
    await page.locator('#h5-usage-time-clear-confirm').click();
    await page.locator('#h5-usage-tasks-empty').waitFor({ state: 'visible' });
    assert.equal(timeRows(server.dbPath).length, 0, 'Clear deletes every time row');
    assert.equal(await text(page.locator('#h5-usage-tiles [data-tile="page"] .h5-usage-tile-value')), '0 min');
    await press(page, false, page.locator('#h5-usage-tab-memories'));
    await page.locator('#h5-memories-list .h5-memory').first().waitFor({ state: 'visible' });
    await page.locator('#h5-memories-clear').click();
    await page.locator('#h5-memories-clear-dialog').waitFor({ state: 'visible' });
    await settled(page);
    await page.locator('#h5-memories-clear-confirm').click();
    await page.locator('#h5-memories-empty').waitFor({ state: 'visible' });
    assert.equal(readDb(server.dbPath, db => db.prepare('SELECT COUNT(*) FROM memories WHERE deleted = 0').pluck().get()), 0, 'Clear makes every memory a tombstone');
    assert.equal(await page.locator('#h5-memories-digest').count(), 0, 'no digest card after Clear');
    // The Buttons tab still works.
    await press(page, false, page.locator('#h5-usage-tab-buttons'));
    await page.locator('#h5-usage-panel-buttons').waitFor({ state: 'visible' });
    await page.waitForFunction(() => { const box = document.querySelector('#h5-usage-enabled'); return box && !box.disabled; });
    const wasOn = await page.locator('#h5-usage-enabled').isChecked();
    await page.locator('#h5-usage-enabled').click();
    await waitFor(async () => (await api(page, 'GET', '/api/ui-events/settings')).data.enabled === !wasOn, 'the Record button use switch saved');
    await page.locator('#h5-usage-data, #h5-usage-top-empty, #h5-usage-top').first().waitFor({ state: 'visible' });
    console.log('record off elsewhere, on again, Clear per tab, the Buttons tab: passed');
    await one.context.close();


    assert.deepEqual(pageErrors, [], 'no page errors');
    console.log('usage time e2e: all checks passed');
  } catch (error) {
    if (process.env.TIME_E2E_VERBOSE) console.error(server.log().slice(-4000));
    throw error;
  } finally {
    await browser.close();
    server.child.kill('SIGTERM');
    fake.server.close();
    old.server.close();
    await sleep(500);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const limit = setTimeout(() => { console.error(`usage time e2e: over ${LIMIT_MS / 1000} s`); process.exit(1); }, LIMIT_MS);
main().then(() => { clearTimeout(limit); }, error => { console.error(error); process.exit(1); });
