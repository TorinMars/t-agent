// "Restart T-Agent" on the "This machine" row of Settings → Devices (scripts/h5-shell/Restart.jsx) in real Chromium at 390px, with the API mocked: the
// confirmation, `POST /api/system/restart { confirm: true }`, no reload while the old process still answers, the reload once another boot_id answers,
// "Refresh now" when it takes long, the disabled button with its reason, no button on an older server or in a pane of the multi-column view, and the
// error texts. H5_SHOT_DIR=<dir> saves a screenshot of the confirmation.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const pageErrors = [];
const QUESTION = 'Restart T-Agent on this computer? Every terminal is closed and its screen is cleared. The page reloads when the service is back.';

const sleep = ms => new Promise(done => setTimeout(done, ms));
const waitFor = async (check, what, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out: ${what}`);
    await sleep(20);
  }
};
// `restart`: the field of /api/system/version (undefined = an older server). `answer`: [body, status] of POST /api/system/restart. `boot`: the boot_id
// answered now; `down`: version requests fail.
function world(over = {}) {
  return { restart: { supported: true, reason: null }, answer: null, boot: 'boot-a', down: false, posts: [], versionReads: 0, navigations: 0, ...over };
}
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function serve(w, route) {
  const request = route.request();
  const { pathname } = new URL(request.url());
  const method = request.method();
  if (pathname === '/top') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><iframe id="pane-a" src="${ORIGIN}/h5?pane=a" style="width:480px;height:900px"></iframe>` });
  if (pathname === '/h5') { if (request.isNavigationRequest() && request.frame() === request.frame().page().mainFrame()) w.navigations += 1; return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') }); }
  if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
  if (pathname === '/api/system/version') {
    w.versionReads += 1;
    if (w.down) return route.abort('connectionrefused');
    return json(route, { app_version: '2.101.0', boot_id: w.boot, engine_name: 'MacBook', ...(w.restart === undefined ? {} : { restart: w.restart }) });
  }
  if (pathname === '/api/system/restart') {
    w.posts.push(request.postDataJSON());
    if (w.answer) return json(route, ...w.answer);
    return json(route, { accepted: true, boot_id: w.boot }, 202);
  }
  if (pathname === '/api/system/update-status' || pathname === '/api/system/check-update') return json(route, { status: 'current', local_version: '2.101.0', remote_version: '2.101.0', boot_id: w.boot, install_type: 'git', is_update_admin: true, log: [] });
  if (pathname === '/api/system/engine-name') return json(route, { name: 'MacBook', default_name: 'mbp', custom: true });
  if (pathname === '/api/remote-servers') return json(route, []);
  if (pathname === '/api/service-links') return json(route, { supported: true, links: [] });
  if (pathname === '/api/task-list/hidden-devices') return json(route, { hidden: [] });
  if (pathname === '/auth/me') return json(route, { effective_work_dir: '/home/me/tasks' });
  if (pathname === '/api/tasks') return json(route, [{ id: 1, title: 'Alpha', status: 'doing' }]);
  if (pathname === '/api/task-groups') return json(route, [{ key: 'doing', name: 'Doing', sort_order: 1 }]);
  if (pathname === '/api/tasks/terminal-activity' || pathname === '/api/tasks/terminal-subagents') return json(route, {});
  if (/^\/api\/tasks\/\d+\/terminals$/.test(pathname)) return json(route, [{ terminal_id: 'default', title: 'Terminal 1' }]);
  if (/\/agent\/conversations$/.test(pathname)) return json(route, []);
  if (pathname === '/api/agent-chat/summary') return json(route, { running: 0, queued: 0, submitted: 0 });
  if (/\/terminal\/(ack|control)$/.test(pathname)) return json(route, { success: true });
  return json(route, { error: 'not mocked' }, 404);
}

async function open(browser, w, { at = '/h5', width = 390 } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.WebSocket = class {
      constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send() {}
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    // "Refresh now" waits 20 s on a real page; here it is 600 ms.
    const timeout = window.setTimeout;
    window.setTimeout = (run, ms, ...rest) => timeout(run, ms === 20000 ? 600 : ms, ...rest);
    localStorage.setItem('h5-task:local', '1');
  });
  await page.addInitScript(activityStreamMock);
  await page.route(`${ORIGIN}/**`, route => serve(w, route));
  await page.goto(`${ORIGIN}${at}`);
  return { context, page };
}
// Opens Settings → Devices in `frame` (the page, or a pane's frame) and waits for the row of this machine.
async function openEngines(frame) {
  await frame.locator('#h5-open-tasks').waitFor();
  await frame.evaluate(() => window.H5UI.actions.openSettings());
  await frame.locator('#h5-settings').waitFor({ state: 'visible' });
  const summary = frame.locator('#h5-set-devices .MuiAccordionSummary-root');
  await summary.scrollIntoViewIfNeeded();
  await summary.click();
  await frame.waitForFunction(() => Boolean(document.querySelector('#h5-set-devices .MuiCollapse-entered')));
  await frame.waitForFunction(() => (document.getElementById('h5-engine-local-version') || {}).textContent === 'v2.101.0');
}
const dialog = page => page.locator('#h5-restart-dialog [role="dialog"]');

const SCENARIOS = {
  async 'confirm, request, and a reload only once another boot_id answers'(browser) {
    const w = world();
    const { context, page } = await open(browser, w);
    await openEngines(page);
    const button = page.locator('.h5-engine-row[data-engine="local"] #h5-restart');
    await button.waitFor();
    assert.equal(await button.textContent(), 'Restart T-Agent');
    assert.equal(await button.isDisabled(), false);
    const box = await button.boundingBox();
    assert.ok(box.height >= 44, `the button is ${box.height}px high`);
    await button.tap();
    await dialog(page).waitFor();
    assert.equal(await page.locator('#h5-restart-title').textContent(), 'Restart T-Agent');
    assert.equal(await page.locator('#h5-restart-question').textContent(), QUESTION);
    await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running'));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'restart-confirm-390.png') });
    // Cancel sends nothing.
    await page.locator('#h5-restart-cancel').tap();
    await dialog(page).waitFor({ state: 'hidden' });
    assert.equal(w.posts.length, 0);
    await button.tap();
    await dialog(page).waitFor();
    await page.locator('#h5-restart-confirm').tap();
    await waitFor(() => w.posts.length === 1, 'the POST');
    assert.deepEqual(w.posts[0], { confirm: true });
    await page.waitForFunction(() => (document.getElementById('h5-restart-state') || {}).textContent === 'Restarting…');
    assert.equal(await page.locator('#h5-restart-cancel').isDisabled(), true, 'cannot be closed while restarting');
    // The old process still answers, then the service is away: no reload in either case.
    const reads = w.versionReads;
    await waitFor(() => w.versionReads >= reads + 2, 'two reads of the old process');
    w.down = true;
    await page.locator('#h5-restart-slow').waitFor({ timeout: 3000 }); // 20 s on a real page, 600 ms here
    assert.match(await page.locator('#h5-restart-slow').textContent(), /refresh manually: Refresh now$/);
    await sleep(4500); // longer than the grace period of an update: with a boot_id only a new one counts
    w.down = false;
    await sleep(1500);
    assert.equal(w.navigations, 1, 'the same boot_id never reloads');
    w.boot = 'boot-b';
    await waitFor(() => w.navigations === 2, 'the reload once the new process answers');
    await context.close();
  },
  async 'disabled with the reason when not supported'(browser) {
    const w = world({ restart: { supported: false, reason: 'NO_PROCESS_MANAGER' } });
    const { context, page } = await open(browser, w);
    await openEngines(page);
    const button = page.locator('#h5-restart');
    await button.waitFor();
    assert.equal(await button.isDisabled(), true);
    assert.equal(await page.locator('#h5-restart-why').textContent(), 'Needs a process manager such as PM2');
    await context.close();
  },
  async 'no button on an older server'(browser) {
    const w = world({ restart: undefined });
    const { context, page } = await open(browser, w);
    await openEngines(page);
    await page.locator('.h5-engine-row[data-engine="local"] .h5-engine-rename').waitFor();
    assert.equal(await page.locator('#h5-restart').count(), 0);
    await context.close();
  },
  async 'the errors are shown and the dialog can be closed'(browser) {
    const w = world();
    const { context, page } = await open(browser, w);
    await openEngines(page);
    const cases = [
      [[{ error: 'UPDATE_ADMIN_REQUIRED' }, 403], 'Only the update administrator can restart T-Agent'],
      [[{ error: 'NO_PROCESS_MANAGER' }, 409], 'Needs a process manager such as PM2'],
      [[{ error: 'UPDATE_IN_PROGRESS' }, 409], 'An update is running. Try again when it has finished.'],
      [[{ error: 'SOMETHING_ELSE', message: 'Disk is full' }, 500], 'Restart failed: Disk is full'],
    ];
    for (const [answer, text] of cases) {
      w.answer = answer;
      await page.locator('#h5-restart').tap();
      await dialog(page).waitFor();
      await page.locator('#h5-restart-confirm').tap();
      await page.locator('#h5-restart-error').waitFor();
      assert.equal(await page.locator('#h5-restart-error').textContent(), text);
      assert.equal(await page.locator('#h5-restart-cancel').textContent(), 'Close');
      await page.locator('#h5-restart-cancel').tap();
      await dialog(page).waitFor({ state: 'hidden' });
    }
    await sleep(1200);
    assert.equal(w.navigations, 1, 'no reload after a refused restart');
    await context.close();
  },
  async 'not offered in a pane of the multi-column view'(browser) {
    const w = world();
    const { context, page } = await open(browser, w, { at: '/top', width: 1200 });
    await page.waitForFunction(() => true);
    let frame = null;
    await waitFor(() => (frame = page.frames().find(item => item.url().includes('pane=a'))), 'the pane frame');
    await frame.waitForFunction(() => Boolean(window.H5Pane));
    await openEngines(frame);
    await frame.locator('.h5-engine-row[data-engine="local"] .h5-engine-rename').waitFor();
    assert.equal(await frame.locator('#h5-restart').count(), 0);
    await context.close();
  },
};

(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const [name, run] of Object.entries(SCENARIOS)) {
      await run(browser);
      console.log(`  ok: ${name}`);
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log('Restart T-Agent passed.');
})().catch(error => { console.error(error); process.exit(1); });
