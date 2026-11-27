// "Open in VS Code" in the session header's More ("Page" in docs/design/vscode-web-proxy.md), in real Chromium with every route mocked (no real
// VS Code, nothing downloaded): this machine T01 with a Claude session, a remote engine K01 (capability `vscode:web`) and K02 (an older engine
// whose /info lacks it), each with one session.
// - The row: after the mouse ball's switch and before Remember this, 44px, the "</>" icon; absent for K02's session.
// - Happy path: the blank tab is opened inside the click (user activation), the notice "Starting VS Code on T01…" stays while the page polls GET
//   every 1.5 s, and the tab goes to `open_url` (its opener cut) when the answer is ready; the notice then goes.
// - The licence: the tab is closed and the dialog asks (h6 title, Cancel then Accept, text buttons); Cancel sends nothing; Accept opens a new tab
//   inside its click, POSTs accept-license and starts again.
// - Every error text, with the tab closed; a second tap while it starts does nothing; a remote session uses the remote engine's route.
// - The Mac app (computer only): no tab; the ready address goes to its `tagentOpen` handler.
// Runs at 1440x900 with a mouse and 390x844 touch. H5_SHOT_DIR=<dir> saves the menu, the notice and the dialog.
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
const K01_ID = '6c1d1c1e-0000-4000-8000-0000000000k1';
const WAIT = { timeout: 10000 };
const pageErrors = [];

const SESSIONS = {
  local: { task: 'SELF-TAGENT', session: 'Dev session', path: '/api/tasks/1/terminals/c1/vscode', engine: LOCAL_ID },
  k01: { task: 'K01 work', session: 'Remote session', path: '/api/remote-servers/7/tasks/5/terminals/k1/vscode', engine: K01_ID },
  k02: { task: 'K02 work', session: 'Old engine session' },
};
const openPath = engine => `/vscode/${engine}/?folder=%2Fwork%2Fself&ta_launch=tvl_${Math.random().toString(36).slice(2)}`;

// The VS Code routes answer from `reply(method, kind, call)` (`kind`: '' or '/accept-license'); every call is recorded.
const vscode = { calls: [], reply: null };

async function openPage(browser, { viewport, touch = false, macApp = false }) {
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), deviceScaleFactor: SHOTS ? 3 : 1 });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  const popups = [];
  context.on('page', popup => { if (popup !== page) popups.push(popup); });
  await page.addInitScript(macApp => {
    localStorage.setItem('h5-columns', JSON.stringify({ on: false }));
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1; window.WebSocket.CONNECTING = 0;
    // Each window.open: its arguments and whether the click's user activation was still there.
    window.openCalls = [];
    const open = window.open.bind(window);
    window.open = (...args) => { window.openCalls.push({ args, active: navigator.userActivation.isActive }); return open(...args); };
    if (macApp) { window.appOpened = []; window.webkit = { messageHandlers: { tagentOpen: { postMessage: url => window.appOpened.push(url) } } }; }
  }, macApp);
  await page.addInitScript(activityStreamMock);
  await context.route(`${ORIGIN}/**`, async route => {
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
    if (p.startsWith('/vscode/')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>VS Code stand-in</title>' });
    const call = /^(.*\/vscode)(\/accept-license)?$/.exec(p);
    if (call && p.startsWith('/api/')) {
      const entry = { method, path: p, at: Date.now(), body: route.request().postData(), popups: popups.length };
      vscode.calls.push(entry);
      const answer = vscode.reply ? vscode.reply(method, call[2] || '', entry) : { error: 'not mocked' };
      return json(answer.body || answer, answer.status || 200);
    }
    if (p === '/api/system/version') return json({ app_version: '2.181.0', boot_id: 'b1', engine_name: 'T01', instance_id: LOCAL_ID });
    if (p === '/api/task-order') return json({ order: [], updated_at: 1 });
    if (p === '/api/task-list/hidden-devices') return json({ hidden: [] });
    if (p === '/api/remote-servers') return json([{ id: 7, name: 'K01', status: 'online', enabled: true, instance_id: K01_ID }, { id: 8, name: 'K02', status: 'online', enabled: true, instance_id: 'inst-k02' }]);
    if (p === '/api/remote-servers/7/info') return json({ capabilities: ['tasks:archive', 'vscode:web'] });
    if (p === '/api/remote-servers/8/info') return json({ capabilities: ['tasks:archive'] });
    if (p === '/api/tasks' && method === 'GET') return json([{ id: 1, title: SESSIONS.local.task, status: 'doing', work_dir: '/work/self' }]);
    if (p === '/api/remote-servers/7/tasks' && method === 'GET') return json([{ id: 5, title: SESSIONS.k01.task, status: 'doing', work_dir: '/work/k01' }]);
    if (p === '/api/remote-servers/8/tasks' && method === 'GET') return json([{ id: 6, title: SESSIONS.k02.task, status: 'doing', work_dir: '/work/k02' }]);
    if (/^\/api\/(remote-servers\/\d+\/)?task-groups$/.test(p)) return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (/terminal-activity$|terminal-subagents$/.test(p)) return json({});
    if (p === '/api/tasks/1/terminals' && method === 'GET') return json([{ terminal_id: 'c1', title: SESSIONS.local.session, agent: 'claude' }]);
    if (p === '/api/remote-servers/7/tasks/5/terminals' && method === 'GET') return json([{ terminal_id: 'k1', title: SESSIONS.k01.session, agent: 'claude' }]);
    if (p === '/api/remote-servers/8/tasks/6/terminals' && method === 'GET') return json([{ terminal_id: 'k2', title: SESSIONS.k02.session, agent: 'claude' }]);
    if (/\/terminal\/(ack|control)$/.test(p)) return json({ success: true });
    if (/\/agent\/conversations$/.test(p)) return json([]);
    if (p === '/api/system/check-update' || p === '/api/system/update-status') return json({ status: 'up_to_date', local_version: '1.0.0' });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  const press = locator => (touch ? locator.tap() : locator.click());
  return { context, page, press, popups, touch };
}

const settle = page => page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity));
const shot = async (page, name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }); };

// Shows a session: on a phone through the task drawer.
async function showSession(t, which) {
  const { page, press, touch } = t;
  const { task, session } = SESSIONS[which];
  if (touch && !(await page.locator('#h5-tasks').isVisible())) await page.locator('#h5-open-tasks').tap();
  await page.locator('#h5-tasks').waitFor({ state: 'visible' });
  const row = page.locator('#h5-tasks .h5-terminal-main', { hasText: session });
  await page.locator('.h5-task-item', { hasText: task }).waitFor(WAIT);
  if (!(await row.count())) await press(page.locator('.h5-task-item', { hasText: task }));
  await press(row);
  await page.waitForFunction(name => document.getElementById('h5-session-name').textContent === name, session, WAIT);
  if (touch && (await page.locator('#h5-tasks').isVisible())) await page.keyboard.press('Escape').catch(() => {});
  await page.locator('#h5-tasks').waitFor({ state: touch ? 'hidden' : 'visible', ...WAIT }).catch(() => {});
  await settle(page);
}
const openMore = async t => { await t.press(t.page.locator('#h5-header-more')); await t.page.locator('#h5-header-more-menu [role="menu"]').waitFor(); await settle(t.page); };
const menuIds = page => page.locator('#h5-header-more-menu [role="menuitem"], #h5-header-more-menu [role="menuitemcheckbox"]').evaluateAll(items => items.map(el => el.id));
async function chooseVscode(t) {
  await openMore(t);
  await t.press(t.page.locator('#h5-header-vscode'));
  await t.page.locator('#h5-header-more-menu').waitFor({ state: 'detached' });
}
const noticeText = page => page.evaluate(() => { const node = document.querySelector('.MuiSnackbar-root [role="status"]'); return node ? node.textContent : null; });
const waitNotice = (page, text) => page.waitForFunction(want => { const node = document.querySelector('.MuiSnackbar-root [role="status"]'); return node && node.textContent === want; }, text, WAIT);
const until = async (check, label, ms = 10000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw new Error(`timed out: ${label}`); await new Promise(r => setTimeout(r, 50)); } };
const lastPopup = t => t.popups[t.popups.length - 1];

async function checkRow(t, label) {
  const { page } = t;
  await showSession(t, 'local');
  await openMore(t);
  const ids = await menuIds(page);
  const want = t.touch ? ['h5-term-width', 'h5-mouse-ball-program', 'h5-header-vscode', 'h5-header-remember', 'h5-refresh', 'h5-header-update'] : ['h5-mouse-ball-program', 'h5-header-vscode', 'h5-header-remember', 'h5-refresh'];
  assert.deepEqual(ids, want, `${label}: Open in VS Code after the mouse ball switch, before Remember this`);
  const row = page.locator('#h5-header-vscode');
  assert.equal(await row.textContent(), 'Open in VS Code');
  assert.equal(await row.getAttribute('role'), 'menuitem');
  assert.ok((await row.evaluate(el => el.offsetHeight)) >= 44, `${label}: a 44px row`);
  assert.equal(await row.locator('svg path[stroke-width="1.5"]').count(), 1, `${label}: the self-drawn code icon`);
  await shot(page, `vscode-menu-${label}.png`);
  await page.keyboard.press('Escape');
  await page.locator('#h5-header-more-menu').waitFor({ state: 'detached' });
  // K02 says what it can do and lacks vscode:web: no row.
  await showSession(t, 'k02');
  await openMore(t);
  assert.equal(await page.locator('#h5-header-vscode').count(), 0, `${label}: no row for an engine without vscode:web`);
  assert.ok((await menuIds(page)).includes('h5-header-remember'), `${label}: the rest of the menu stays`);
  await page.keyboard.press('Escape');
  await page.locator('#h5-header-more-menu').waitFor({ state: 'detached' });
}

async function happyPath(t, label, which = 'local', engineName = 'T01') {
  const { page } = t;
  await showSession(t, which);
  const open = openPath(SESSIONS[which].engine);
  let gets = 0;
  vscode.calls = [];
  vscode.reply = (method, kind) => {
    if (method === 'POST' && !kind) return { state: 'starting', folder: '/work/self' };
    gets += 1;
    return gets < 3 ? { state: 'starting' } : { state: 'ready', open_url: open, open_path: open.replace(/&ta_launch=.*$/, ''), engine_id: SESSIONS[which].engine };
  };
  const before = t.popups.length;
  await page.evaluate(() => { window.openCalls = []; });
  await chooseVscode(t);
  await until(() => t.popups.length === before + 1, 'the blank tab');
  const calls = await page.evaluate(() => window.openCalls);
  assert.equal(calls.length, 1, `${label}: one window.open`);
  assert.deepEqual(calls[0].args, ['', '_blank'], `${label}: a blank tab`);
  assert.equal(calls[0].active, true, `${label}: opened inside the click (user activation)`);
  await waitNotice(page, `Starting VS Code on ${engineName}…`);
  await shot(page, `vscode-starting-${label}.png`);
  await until(() => vscode.calls.length >= 4, 'POST and three GETs', 15000);
  assert.deepEqual(vscode.calls.map(call => `${call.method} ${call.path}`), [`POST ${SESSIONS[which].path}`, ...Array(3).fill(`GET ${SESSIONS[which].path}`)], `${label}: POST start, then GET while starting`);
  assert.ok(vscode.calls[0].popups === before + 1, `${label}: the tab was open before the start was asked`);
  for (let i = 2; i < 4; i += 1) {
    const gap = vscode.calls[i].at - vscode.calls[i - 1].at;
    assert.ok(gap >= 1400 && gap < 3000, `${label}: polled every 1.5 s (${gap} ms)`);
  }
  const popup = lastPopup(t);
  await popup.waitForURL(`${ORIGIN}${open}`, WAIT);
  assert.equal(await popup.evaluate(() => window.opener), null, `${label}: the tab's opener is cut`);
  await page.waitForFunction(() => !document.querySelector('.MuiSnackbar-root [role="status"]'), null, WAIT);
  await popup.close();
}

async function license(t, label) {
  const { page, press } = t;
  await showSession(t, 'local');
  const open = openPath(LOCAL_ID);
  let accepted = false;
  vscode.calls = [];
  vscode.reply = (method, kind) => {
    if (kind) { accepted = true; return { accepted: true }; }
    return accepted ? { state: 'ready', open_url: open, engine_id: LOCAL_ID } : { state: 'error', error: 'VSCODE_LICENSE_REQUIRED', detail: '' };
  };
  const before = t.popups.length;
  await chooseVscode(t);
  const dialog = page.locator('#h5-vscode-license [role="dialog"]');
  await dialog.waitFor(WAIT);
  await until(() => t.popups[before] && t.popups[before].isClosed(), 'the blank tab is closed for the question');
  assert.equal(await page.locator('#h5-vscode-license-title').textContent(), 'Use VS Code in the browser?');
  assert.equal(await page.locator('#h5-vscode-license-title').evaluate(el => el.classList.contains('MuiTypography-h6')), true, `${label}: an h6 title`);
  assert.equal(await page.locator('#h5-vscode-license-body').textContent(), "VS Code's server will be downloaded to T01 (about 100 MB) and you accept its license terms.");
  assert.deepEqual(await dialog.locator('.MuiDialogActions-root button').evaluateAll(buttons => buttons.map(b => [b.textContent, b.classList.contains('MuiButton-text')])), [['Cancel', true], ['Accept', true]], `${label}: Cancel then Accept, text buttons`);
  if (t.touch) for (const button of await dialog.locator('.MuiDialogActions-root button').all()) assert.ok((await button.evaluate(el => el.offsetHeight)) >= 44, `${label}: 44px buttons`);
  await settle(page);
  await shot(page, `vscode-license-${label}.png`);
  await press(page.locator('#h5-vscode-license-cancel'));
  await page.locator('#h5-vscode-license').waitFor({ state: 'detached', ...WAIT });
  assert.deepEqual(vscode.calls.map(call => call.method), ['POST'], `${label}: Cancel sends nothing`);
  assert.equal(t.popups.length, before + 1, `${label}: Cancel opens no tab`);
  assert.equal(await page.locator('#h5-vscode-root').count(), 0, `${label}: the dialog's root is gone`);
  // Again, and Accept.
  await chooseVscode(t);
  await dialog.waitFor(WAIT);
  await settle(page);
  await page.evaluate(() => { window.openCalls = []; });
  await press(page.locator('#h5-vscode-license-accept'));
  await until(() => t.popups.length === before + 3, 'a new tab from Accept');
  const calls = await page.evaluate(() => window.openCalls);
  assert.equal(calls.length === 1 && calls[0].active, true, `${label}: Accept opens the tab inside its click`);
  await lastPopup(t).waitForURL(`${ORIGIN}${open}`, WAIT);
  assert.deepEqual(vscode.calls.map(call => `${call.method} ${call.path}`), [`POST ${SESSIONS.local.path}`, `POST ${SESSIONS.local.path}`, `POST ${SESSIONS.local.path}/accept-license`, `POST ${SESSIONS.local.path}`], `${label}: accept-license, then start again`);
  await page.locator('#h5-vscode-license').waitFor({ state: 'detached', ...WAIT });
  await lastPopup(t).close();
}

const ERRORS = [
  ['local', { state: 'error', error: 'VSCODE_NOT_INSTALLED', detail: '' }, 'VS Code is not installed on T01'],
  ['local', { state: 'error', error: 'VSCODE_START_FAILED', detail: 'Starting server\nError: listen EADDRINUSE\n' }, 'VS Code could not start on T01: Error: listen EADDRINUSE'],
  ['local', { state: 'error', error: 'VSCODE_DOWNLOAD_FAILED', detail: '' }, 'VS Code could not start on T01: the download failed'],
  ['local', { state: 'error', error: 'VSCODE_SERVE_WEB_UNSUPPORTED', detail: '' }, 'VS Code could not start on T01: update the VS Code command line tool'],
  ['local', { status: 500, body: { error: 'VSCODE_START_FAILED' } }, 'VS Code could not start on T01: it stopped before it was ready'],
  ['local', { state: 'error', error: 'VSCODE_DISABLED', detail: '' }, 'VS Code is turned off on T01'],
  ['local', { status: 404, body: { error: 'TASK_NOT_FOUND' } }, 'Could not open VS Code: TASK_NOT_FOUND'],
  ['k01', { status: 501, body: { error: 'VSCODE_WEB_UNSUPPORTED' } }, 'K01 does not support VS Code in the browser'],
  ['k01', { status: 502, body: { error: 'REMOTE_OFFLINE' } }, 'K01 is offline'],
];
async function errors(t, label) {
  const { page } = t;
  let shown = null;
  for (const [which, answer, text] of ERRORS) {
    if (shown !== which) { await showSession(t, which); shown = which; }
    vscode.calls = [];
    vscode.reply = () => answer;
    const before = t.popups.length;
    await chooseVscode(t);
    await waitNotice(page, text);
    assert.equal(await page.locator('.MuiSnackbar-root .MuiAlert-colorError.MuiAlert-filled').count(), 1, `${label}: "${text}" is an error notice`);
    await until(() => t.popups.length === before + 1 && t.popups[before].isClosed(), `${label}: the tab of "${text}" is closed`);
    assert.equal(vscode.calls.length, 1, `${label}: one request for "${text}"`);
    assert.equal(vscode.calls[0].path, SESSIONS[which].path, `${label}: the route of ${which}`);
  }
}

async function doubleTap(t, label) {
  const { page } = t;
  await showSession(t, 'local');
  let finish = false;
  vscode.calls = [];
  vscode.reply = method => (finish && method === 'GET' ? { state: 'error', error: 'VSCODE_START_FAILED', detail: 'stopped' } : { state: 'starting' });
  const before = t.popups.length;
  await chooseVscode(t);
  await waitNotice(page, 'Starting VS Code on T01…');
  await chooseVscode(t);
  await page.waitForTimeout(400);
  assert.equal(t.popups.length, before + 1, `${label}: the second tap opens no tab`);
  assert.equal(vscode.calls.filter(call => call.method === 'POST').length, 1, `${label}: and starts nothing`);
  finish = true;
  await waitNotice(page, 'VS Code could not start on T01: stopped');
  // Free again: the next tap starts.
  vscode.calls = [];
  vscode.reply = () => ({ state: 'error', error: 'VSCODE_DISABLED' });
  await chooseVscode(t);
  await waitNotice(page, 'VS Code is turned off on T01');
  assert.equal(vscode.calls.length, 1, `${label}: a launch after the first ended`);
}

async function closedTab(t, label) {
  const { page } = t;
  await showSession(t, 'local');
  vscode.calls = [];
  vscode.reply = () => ({ state: 'starting' });
  const before = t.popups.length;
  await chooseVscode(t);
  await waitNotice(page, 'Starting VS Code on T01…');
  await until(() => t.popups.length === before + 1, 'the tab');
  await t.popups[before].close();
  await page.waitForFunction(() => !document.querySelector('.MuiSnackbar-root [role="status"]'), null, WAIT);
  const count = vscode.calls.length;
  await page.waitForTimeout(2000);
  assert.equal(vscode.calls.length, count, `${label}: a closed tab stops the polling`);
}

async function macApp(browser) {
  const t = await openPage(browser, { viewport: { width: 1440, height: 900 }, macApp: true });
  await showSession(t, 'local');
  const open = openPath(LOCAL_ID);
  vscode.calls = [];
  vscode.reply = () => ({ state: 'ready', open_url: open, engine_id: LOCAL_ID });
  await chooseVscode(t);
  await t.page.waitForFunction(() => window.appOpened.length === 1, null, WAIT);
  assert.deepEqual(await t.page.evaluate(() => window.appOpened), [`${ORIGIN}${open}`], 'the Mac app opens the address itself');
  assert.equal((await t.page.evaluate(() => window.openCalls)).length, 0, 'no blank tab in the Mac app');
  assert.equal(t.popups.length, 0);
  await t.context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const [label, options] of [['computer', { viewport: { width: 1440, height: 900 } }], ['phone', { viewport: { width: 390, height: 844 }, touch: true }]]) {
      const t = await openPage(browser, options);
      assert.equal(await t.page.evaluate(() => document.documentElement.dataset.input), options.touch ? 'touch' : 'pointer');
      await checkRow(t, label);
      await happyPath(t, label);
      await happyPath(t, `${label} remote`, 'k01', 'K01');
      await license(t, label);
      await errors(t, label);
      await doubleTap(t, label);
      await closedTab(t, label);
      console.log(`${label}: ok`);
      await t.context.close();
    }
    await macApp(browser);
    console.log('Mac app: ok');
  } finally {
    await browser.close();
  }
  const errorsSeen = pageErrors.filter(text => !/ResizeObserver loop/.test(text));
  assert.deepEqual(errorsSeen, [], 'no page errors');
  console.log('test-h5-vscode-browser: all passed');
})().catch(error => { console.error(error); process.exit(1); });
