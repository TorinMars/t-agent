// The automatic update on the page (scripts/h5-shell/Update.jsx) in real Chromium, with the two endpoints mocked: the switch and its status lines in the Update
// dialog, and the silent reload after the service restarted into an automatic update. The minute poll and the 3 second poll run faster here (the timers are
// shortened in the page); everything else is the real page.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const pageErrors = [];
const TASKS = [{ id: 1, title: 'Alpha', status: 'doing' }, { id: 2, title: 'Beta', status: 'doing' }];

const autoUpdate = (over = {}) => ({ enabled: true, supported: true, unsupported_reason: null, state: 'idle', waiting_for: [], quiet_until: null, last_error: null, last_auto_version: null, last_auto_at: null, ...over });
const statusOf = (over = {}) => ({ status: 'current', local_version: '1.0.0', remote_version: '1.0.0', boot_id: 'boot-a', install_type: 'git', is_update_admin: true, log: [], auto_update: autoUpdate(), ...over });
const waitFor = async (check, what, ms = 4000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out: ${what}`);
    await new Promise(done => setTimeout(done, 20));
  }
};
const sleep = ms => new Promise(done => setTimeout(done, ms));

// The page, on a mocked server. server.status is what update-status answers; server.down makes it unreachable. navigations counts the loads of the page.
async function openPage(browser, { status = statusOf(), pollMs = 150, autoAnswer = null } = {}) {
  const server = { status, down: false, reads: 0, navigations: 0, posts: [], autoAnswer, nextVersion: null };
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(({ pollMs: poll }) => {
    window.WebSocket = class {
      constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send() {}
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    const interval = window.setInterval;
    window.setInterval = (run, ms, ...rest) => interval(run, ms === 60000 ? poll : ms, ...rest);
    const timeout = window.setTimeout;
    window.setTimeout = (run, ms, ...rest) => timeout(run, ms === 3000 ? 120 : ms, ...rest);
    let hidden = false;
    Object.defineProperty(document, 'hidden', { get: () => hidden, configurable: true });
    window.setPageHidden = value => { hidden = value; document.dispatchEvent(new Event('visibilitychange')); };
    // The task and the terminal this page shows, as after a tap on them.
    localStorage.setItem('h5-task:local', '2');
    localStorage.setItem('h5-terminal:local:2', 'second');
  }, { pollMs });
  await page.route(`${ORIGIN}/**`, async route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const json = (body, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/h5') {
      if (request.isNavigationRequest()) server.navigations += 1;
      return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    }
    if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
    if (pathname === '/api/system/update-status') {
      server.reads += 1;
      if (server.down) return route.abort('connectionrefused');
      if (server.flip) server.flip();
      return json(server.status);
    }
    if (pathname === '/api/system/check-update') { const { auto_update: omitted, ...rest } = server.status; return json(rest); } // check-update does not carry auto_update
    if (pathname === '/api/system/version') return json({ boot_id: server.status.boot_id });
    if (pathname === '/api/system/apply-update') { server.status = { ...server.status, status: 'updating', stage: 'installing', message: 'Updating…' }; return json({ accepted: true }); }
    if (pathname === '/api/system/auto-update') {
      const body = JSON.parse(request.postData());
      server.posts.push(body);
      if (server.autoAnswer) return json(...server.autoAnswer);
      server.status = { ...server.status, auto_update: { ...server.status.auto_update, enabled: body.enabled, state: body.enabled ? 'idle' : 'off' } };
      return json(server.status);
    }
    if (pathname === '/api/remote-servers') return json([]);
    if (pathname === '/api/tasks') return json(TASKS);
    if (pathname === '/api/task-groups') return json([{ key: 'doing', name: 'Doing', sort_order: 1 }]);
    if (pathname === '/api/tasks/terminal-activity' || pathname === '/api/tasks/terminal-subagents') return json({});
    if (/^\/api\/tasks\/\d+\/terminals$/.test(pathname)) return json([{ terminal_id: 'default', title: 'Terminal 1' }, { terminal_id: 'second', title: 'Terminal 2' }]);
    if (/\/agent\/conversations$/.test(pathname)) return json([]);
    if (pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    if (pathname === '/api/oss/config') return json({ enabled: false });
    if (/\/terminal\/ack$/.test(pathname)) return json({ success: true });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  await page.locator('#h5-update').waitFor();
  await waitFor(() => server.reads >= 2, 'the first reads of update-status'); // the baseline is taken
  return { context, page, server };
}
const openDialog = async page => { await page.locator('#h5-update').click(); await page.locator('#h5-update-dialog [role="dialog"]').waitFor(); };
const closeDialog = async page => { await page.locator('#h5-update-dismiss').click(); await page.locator('#h5-update-dialog').waitFor({ state: 'detached' }).catch(() => {}); await page.waitForFunction(() => !document.querySelector('.MuiModal-root:not(.MuiModal-hidden)')); };
const text = async (page, id) => (await page.locator(id).textContent());
const toAutoUpdated = server => {
  server.status = statusOf({ boot_id: 'boot-b', local_version: '2.0.0', auto_update: autoUpdate({ last_auto_version: '2.0.0', last_auto_at: '2026-11-10T03:04:00.000Z' }) });
};
const stayed = async (server, count, what, ms = 900) => { await sleep(ms); assert.equal(server.navigations, count, what); };

const SCENARIOS = {
  async 'the switch posts and shows the answer of the server'(browser) {
    const { context, page, server } = await openPage(browser, { status: statusOf({ auto_update: autoUpdate({ enabled: false, state: 'off' }) }) });
    await openDialog(page);
    const box = page.locator('#h5-update-auto-switch');
    await box.waitFor({ state: 'attached' });
    assert.equal(await box.isChecked(), false);
    assert.match(await text(page, '#h5-update-auto'), /Update automatically when idle/);
    await box.click({ force: true });
    await waitFor(() => server.posts.length === 1, 'the POST');
    assert.deepEqual(server.posts[0], { enabled: true });
    await page.waitForFunction(() => document.getElementById('h5-update-auto-switch').checked);

    // A refused POST: the switch stays as it was, and the error is shown.
    server.autoAnswer = [{ error: 'UPDATE_ADMIN_REQUIRED' }, 403];
    await box.click({ force: true });
    await page.locator('#h5-update-auto-error').waitFor();
    assert.equal(await text(page, '#h5-update-auto-error'), 'Only the update administrator can run updates');
    assert.equal(await box.isChecked(), true, 'not optimistic');
    await context.close();
  },
  async 'nothing new on a server without auto_update, and no reload there'(browser) {
    const { auto_update: omitted, ...old } = statusOf();
    const { context, page, server } = await openPage(browser, { status: old });
    await openDialog(page);
    await page.locator('#h5-update-versions').waitFor();
    assert.equal(await page.locator('#h5-update-auto').count(), 0);
    await closeDialog(page);
    server.status = { ...old, boot_id: 'boot-b', local_version: '2.0.0' };
    await stayed(server, 1, 'an old server never reloads the page');
    await context.close();
  },
  async 'disabled when unsupported or not an admin, with the reason'(browser) {
    const { context, page, server } = await openPage(browser, { status: statusOf({ auto_update: autoUpdate({ supported: false, unsupported_reason: 'NO_PROCESS_MANAGER', enabled: false, state: 'unsupported' }) }) });
    await openDialog(page);
    const box = page.locator('#h5-update-auto-switch');
    await box.waitFor({ state: 'attached' });
    assert.equal(await box.isDisabled(), true);
    assert.equal(await text(page, '#h5-update-auto-why'), 'Needs a process manager such as PM2 to restart the service');
    assert.equal(await page.locator('#h5-update-auto-state').count(), 0);
    server.status = statusOf({ auto_update: autoUpdate({ supported: false, unsupported_reason: 'CHECKS_DISABLED', enabled: false, state: 'unsupported' }) });
    await page.waitForFunction(() => document.getElementById('h5-update-auto-why').textContent === 'Version checks are turned off on this service');
    server.status = statusOf({ is_update_admin: false });
    await page.waitForFunction(() => document.getElementById('h5-update-auto-why').textContent === 'Only the update administrator can run updates');
    assert.equal(await box.isDisabled(), true);
    await context.close();
  },
  async 'each status line'(browser) {
    const quiet = new Date(Date.UTC(2026, 10, 10, 13, 5));
    const { context, page, server } = await openPage(browser);
    await openDialog(page);
    await page.locator('#h5-update-auto').waitFor();
    const lines = [
      [{ state: 'waiting', waiting_for: [{ code: 'terminal_running', count: 2 }] }, 'Waiting: 2 terminals running'],
      [{ state: 'waiting', waiting_for: [{ code: 'terminal_running', count: 1 }] }, 'Waiting: 1 terminal running'],
      [{ state: 'waiting', waiting_for: [{ code: 'terminal_program', count: 1 }] }, 'Waiting: an open program such as vim or ssh'],
      [{ state: 'waiting', waiting_for: [{ code: 'chat_running', count: 1 }] }, 'Waiting: an agent chat is running'],
      [{ state: 'waiting', waiting_for: [{ code: 'recent_input', count: 1 }] }, 'Waiting: recent typing'],
      [{ state: 'applying' }, 'Updating…'],
      [{ state: 'gave_up', last_error: 'WORKTREE_DIRTY' }, 'Automatic update stopped for this version: Local uncommitted changes'],
    ];
    for (const [over, wanted] of lines) {
      server.status = statusOf({ auto_update: autoUpdate(over) });
      await page.waitForFunction(value => (document.getElementById('h5-update-auto-state') || {}).textContent === value, wanted);
    }
    server.status = statusOf({ auto_update: autoUpdate({ state: 'waiting', quiet_until: quiet.toISOString() }) });
    const clock = await page.evaluate(iso => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }, quiet.toISOString());
    await page.waitForFunction(value => (document.getElementById('h5-update-auto-state') || {}).textContent === value, `Will update at about ${clock}`);
    server.status = statusOf({ auto_update: autoUpdate({ state: 'off', enabled: false }) });
    await page.waitForFunction(() => !document.getElementById('h5-update-auto-state'));
    server.status = statusOf({ auto_update: autoUpdate({ last_auto_version: '1.0.0', last_auto_at: '2026-11-10T03:04:00.000Z' }) });
    await page.waitForFunction(() => /^Last automatic update: 1\.0\.0, ./.test((document.getElementById('h5-update-auto-last') || {}).textContent || ''));
    await context.close();
  },
  async 'an automatic update reloads the page once, silently, and returns to the same task'(browser) {
    const { context, page, server } = await openPage(browser);
    await page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'Beta' && document.getElementById('h5-session-name').textContent === 'Terminal 2');
    assert.equal(server.navigations, 1);
    toAutoUpdated(server);
    await waitFor(() => server.navigations === 2, 'the silent reload');
    await page.waitForFunction(() => document.getElementById('h5-task-name') && document.getElementById('h5-task-name').textContent === 'Beta');
    assert.equal(await page.locator('.MuiModal-root:not(.MuiModal-hidden)').count(), 0, 'no dialog or banner');
    await page.waitForFunction(() => document.getElementById('h5-session-name').textContent === 'Terminal 2'); // the terminal that was open, not the task's first
    await stayed(server, 2, 'once only');
    await context.close();
  },
  async 'no reload for a restart that is not an automatic update'(browser) {
    const { context, server } = await openPage(browser);
    server.status = statusOf({ boot_id: 'boot-b' }); // pm2 restart: new process, same version
    await stayed(server, 1, 'a plain restart');
    server.status = statusOf({ boot_id: 'boot-c', local_version: '2.0.0', auto_update: autoUpdate({ last_auto_version: '1.5.0' }) }); // a manual update
    await stayed(server, 1, 'another version was installed automatically earlier');
    server.status = statusOf({ boot_id: 'boot-d', local_version: '2.0.0', auto_update: autoUpdate() });
    await stayed(server, 1, 'no automatic update on record');
    server.status = statusOf({ local_version: '2.0.0', auto_update: autoUpdate({ last_auto_version: '2.0.0' }) }); // the same process
    await stayed(server, 1, 'the version file changed, the process did not');
    await context.close();
  },
  async 'the reload waits for the translate box, and goes once it is empty'(browser) {
    const { context, page, server } = await openPage(browser);
    await page.evaluate(() => { document.getElementById('h5-translate-input').value = 'half a sentence'; });
    toAutoUpdated(server);
    await stayed(server, 1, 'text in the translate box', 1300);
    await page.evaluate(() => { document.getElementById('h5-translate-input').value = ''; });
    await waitFor(() => server.navigations === 2, 'the reload once the box is empty');
    await context.close();
  },
  async 'the reload waits while the mind map view is open'(browser) {
    const { context, page, server } = await openPage(browser);
    await page.evaluate(() => { document.getElementById('h5-mindmap').hidden = false; });
    toAutoUpdated(server);
    await stayed(server, 1, 'the mind map view is open', 1300);
    await page.evaluate(() => { document.getElementById('h5-mindmap').hidden = true; });
    await waitFor(() => server.navigations === 2, 'the reload once the view is closed');
    await context.close();
  },
  async 'the reload waits for a dialog and for a hidden page'(browser) {
    let { context, page, server } = await openPage(browser);
    await openDialog(page);
    toAutoUpdated(server);
    await stayed(server, 1, 'the Update dialog is open', 1300);
    await closeDialog(page);
    await waitFor(() => server.navigations === 2, 'the reload once the dialog is closed');
    await context.close();

    ({ context, page, server } = await openPage(browser));
    await page.evaluate(() => window.setPageHidden(true));
    toAutoUpdated(server);
    await stayed(server, 1, 'the page is hidden', 1300);
    await page.evaluate(() => window.setPageHidden(false));
    await waitFor(() => server.navigations === 2, 'the reload when the page comes back', 800);
    await context.close();
  },
  async 'no reload loop'(browser) {
    const { context, server } = await openPage(browser);
    toAutoUpdated(server);
    await waitFor(() => server.navigations === 2, 'the first reload');
    // Every read now comes from another process, and the version keeps changing between two values the server says it installed.
    let boot = 0;
    server.flip = () => {
      boot += 1;
      const version = boot % 2 ? '2.0.0' : '3.0.0';
      server.status = statusOf({ boot_id: `boot-${boot}`, local_version: version, auto_update: autoUpdate({ last_auto_version: version }) });
    };
    await sleep(2500);
    assert.ok(server.navigations <= 3, `each version reloads once at most: ${server.navigations} loads`);
    const settled = server.navigations;
    await stayed(server, settled, 'no further reloads', 1000);
    await context.close();
  },
  async 'a failed read polls fast until the service is back'(browser) {
    const { context, server } = await openPage(browser, { pollMs: 1500 });
    server.down = true;
    const before = server.reads;
    await waitFor(() => server.reads > before, 'a failed read', 2500);
    const failed = server.reads;
    await sleep(800);
    assert.ok(server.reads - failed >= 3, `fast polling while down: ${server.reads - failed} reads`);
    toAutoUpdated(server);
    server.down = false;
    await waitFor(() => server.navigations === 2, 'the reload as soon as the service is back', 1000);
    await context.close();
  },
  async 'the manual update flow keeps its own single reload'(browser) {
    const { context, page, server } = await openPage(browser, { status: statusOf({ status: 'available', remote_version: '2.0.0' }) });
    await openDialog(page);
    await page.locator('#h5-update-now').click();
    await waitFor(() => server.status.status === 'updating', 'the update starts');
    server.status = statusOf({ status: 'current', stage: 'completed', boot_id: 'boot-b', local_version: '2.0.0', auto_update: autoUpdate({ last_auto_version: '2.0.0' }) });
    await page.waitForFunction(() => /Update complete, reloading/.test((document.getElementById('h5-update-state') || {}).textContent || ''));
    assert.equal(server.navigations, 1, 'the silent path stands aside');
    await waitFor(() => server.navigations === 2, 'the reload of the manual flow');
    await stayed(server, 2, 'only that one');
    await context.close();
  },
};

(async () => {
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
  console.log('The automatic update on the page passed.');
})().catch(error => { console.error(error); process.exit(1); });
