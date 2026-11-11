// "Also update" in the Update dialog (scripts/h5-shell/Update.jsx, LinkedUpdates.jsx) in real Chromium at 390px, with the API mocked: the connected services are
// checked when the dialog opens, without holding up this machine's part; a linked service is ticked by default and a plain remote Engine is not; a service
// that is offline, up to date or managed by Docker is greyed with its reason and no checkbox; "Update now" sends every ticked service's apply-update before
// this machine's and waits for their answers; one refusal stops neither the others nor this machine; each row follows its service to the new version; and
// with this machine up to date only the services are updated. H5_SHOT_DIR=<dir> saves a screenshot of the dialog with two services.
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

const localStatus = (over = {}) => ({ status: 'available', local_version: '1.0.0', remote_version: '2.0.0', boot_id: 'boot-a', install_type: 'git', is_update_admin: true, log: [], ...over });
const remote = (over = {}) => ({ status: 'available', local_version: '1.0.0', remote_version: '2.0.0', install_type: 'git', ...over });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const waitFor = async (check, what, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out: ${what}`);
    await new Promise(done => setTimeout(done, 20));
  }
};
const sleep = ms => new Promise(done => setTimeout(done, ms));

// The world: `servers` (rows of /api/remote-servers), `links`, and per id what check-update answers (`checks`: a status, or [code, status] for an error),
// what apply-update answers (`applies`) and the update-status a service reports after its apply (`after`). `log` lists every request in order.
function world(over = {}) {
  return {
    local: localStatus(), servers: [], links: [], checks: {}, applies: {}, after: {}, holdCheck: {}, holdApply: {}, applied: new Set(), log: [], navigations: 0, ...over,
  };
}
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function serve(w, route) {
  const request = route.request();
  const { pathname } = new URL(request.url());
  const method = request.method();
  if (method !== 'GET' || /update-status$/.test(pathname)) w.log.push({ method, pathname, at: Date.now() });
  if (pathname === '/h5') { if (request.isNavigationRequest()) w.navigations += 1; return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') }); }
  if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
  if (pathname === '/api/system/update-status') return json(route, w.local);
  if (pathname === '/api/system/check-update') return json(route, w.local);
  if (pathname === '/api/system/version') return json(route, { app_version: w.local.local_version, boot_id: w.local.boot_id });
  if (pathname === '/api/system/update-notified') return json(route, {});
  if (pathname === '/api/system/apply-update') { w.local = { ...w.local, status: 'updating', stage: 'installing', message: 'Updating…' }; return json(route, { accepted: true }, 202); }
  if (pathname === '/api/remote-servers') return json(route, w.servers);
  if (pathname === '/api/service-links') return json(route, { supported: true, links: w.links });
  const engine = pathname.match(/^\/api\/remote-servers\/(\d+)\/(check-update|apply-update|update-status)$/);
  if (engine) {
    const id = Number(engine[1]);
    const action = engine[2];
    if (action === 'check-update') {
      if (w.holdCheck[id]) await w.holdCheck[id].promise;
      const answer = w.checks[id];
      return Array.isArray(answer) ? json(route, { error: answer[0] }, answer[1]) : json(route, answer);
    }
    if (action === 'apply-update') {
      if (w.holdApply[id]) await w.holdApply[id].promise;
      const answer = w.applies[id];
      if (Array.isArray(answer)) return json(route, { error: answer[0] }, answer[1]);
      w.applied.add(id);
      return json(route, { accepted: true }, 202);
    }
    return json(route, w.applied.has(id) ? (w.after[id] || remote({ status: 'updating', stage: 'installing' })) : w.checks[id]);
  }
  if (pathname === '/api/tasks') return json(route, [{ id: 1, title: 'Alpha', status: 'doing' }]);
  if (pathname === '/api/task-groups') return json(route, [{ key: 'doing', name: 'Doing', sort_order: 1 }]);
  if (pathname === '/api/tasks/terminal-activity' || pathname === '/api/tasks/terminal-subagents') return json(route, {});
  if (/^\/api\/tasks\/\d+\/terminals$/.test(pathname)) return json(route, [{ terminal_id: 'default', title: 'Terminal 1' }]);
  if (/\/agent\/conversations$/.test(pathname)) return json(route, []);
  if (pathname === '/api/agent-chat/summary') return json(route, { running: 0, queued: 0, submitted: 0 });
  if (pathname === '/api/task-list/hidden-devices') return json(route, { hidden: [] });
  if (/\/terminal\/(ack|control)$/.test(pathname)) return json(route, { success: true });
  return json(route, { error: 'not mocked' }, 404);
}

async function open(browser, w) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
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
    localStorage.setItem('h5-task:local', '1'); // a task is shown, so the task sheet does not open over the header at start
  });
  await page.addInitScript(activityStreamMock);
  await page.route(`${ORIGIN}/**`, route => serve(w, route));
  await page.goto(`${ORIGIN}/h5`);
  await page.locator('#h5-update').waitFor();
  return { context, page };
}
const openDialog = async page => { await page.locator('#h5-update').tap(); await page.locator('#h5-update-dialog [role="dialog"]').waitFor(); };
const row = (page, id) => page.locator(`.h5-update-linked-row[data-engine="${id}"]`);
const rowState = (page, id) => row(page, id).getAttribute('data-state');
const rowText = (page, id) => row(page, id).locator('.h5-update-linked-state').textContent();
const waitRow = (page, id, state) => page.waitForFunction(([key, want]) => (document.querySelector(`.h5-update-linked-row[data-engine="${key}"]`) || {}).dataset?.state === want, [id, state], { timeout: 8000 });
const checkbox = (page, id) => row(page, id).locator('input.h5-update-linked-check');

// Peer is a linked service, VPS a plain remote Engine; both have 2.0.0. Down is offline, Same is up to date, Dock is a Docker install.
const FIVE = () => world({
  servers: [{ id: 7, name: 'Peer', status: 'online' }, { id: 8, name: 'VPS', status: 'online' }, { id: 9, name: 'Down', status: 'offline' }, { id: 10, name: 'Same', status: 'online' }, { id: 11, name: 'Dock', status: 'online' }],
  links: [{ id: 'l1', remote_server_id: 7, name: 'Peer', state: 'online' }],
  checks: { 7: remote(), 8: remote(), 9: ['REMOTE_CONNECTION_FAILED', 502], 10: remote({ status: 'current', remote_version: '1.0.0' }), 11: remote({ install_type: 'docker' }) },
});

const SCENARIOS = {
  async 'linked services are ticked, plain remotes are not, and unavailable ones are greyed with the reason'(browser) {
    const w = FIVE();
    w.holdCheck[7] = deferred();
    const { context, page } = await open(browser, w);
    await openDialog(page);
    // This machine's part does not wait for the services: its button is there while Peer is still being checked.
    await page.locator('#h5-update-now').waitFor();
    await waitRow(page, 7, 'checking');
    assert.equal(await rowText(page, 7), 'Checking…');
    assert.equal(await page.locator('#h5-update-now').textContent(), 'Update now');
    w.holdCheck[7].resolve();
    await waitRow(page, 7, 'ready');
    await waitRow(page, 8, 'ready');
    assert.equal(await checkbox(page, 7).isChecked(), true, 'a linked service is ticked');
    assert.equal(await checkbox(page, 8).isChecked(), false, 'a plain remote Engine is not');
    assert.equal(await rowText(page, 7), '1.0.0 → 2.0.0');
    assert.equal(await row(page, 7).getAttribute('data-linked'), 'true');
    assert.match(await row(page, 7).textContent(), /PeerLinked/);
    for (const [id, reason] of [[9, 'Offline'], [10, 'Up to date · 1.0.0'], [11, 'This engine is managed by Docker. Update the image on the host · 1.0.0']]) {
      await waitRow(page, id, 'unavailable');
      assert.equal(await rowText(page, id), reason, `row ${id}`);
      assert.equal(await checkbox(page, id).count(), 0, `row ${id} has no checkbox`);
    }
    assert.equal(await page.locator('#h5-update-linked-title').textContent(), 'Also update');
    // Touch targets: the checkbox is at least 44px.
    const box = await row(page, 8).locator('.MuiCheckbox-root').boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44, `checkbox target ${box.width}x${box.height}`);
    await context.close();
  },
  async 'Update now starts the ticked services first, waits for their answers, and one refusal stops nothing'(browser) {
    const w = world({
      servers: [{ id: 7, name: 'Peer' }, { id: 8, name: 'VPS' }, { id: 12, name: 'Peer two' }],
      links: [{ id: 'l1', remote_server_id: 7, state: 'online' }, { id: 'l2', remote_server_id: 12, state: 'online' }],
      checks: { 7: remote(), 8: remote(), 12: remote() },
      applies: { 12: ['UPDATE_IN_PROGRESS', 409] },
    });
    w.holdApply[7] = deferred();
    const { context, page } = await open(browser, w);
    await openDialog(page);
    await waitRow(page, 8, 'ready');
    await waitRow(page, 7, 'ready');
    await waitRow(page, 12, 'ready');
    await checkbox(page, 8).tap(); // the plain remote too
    assert.equal(await checkbox(page, 8).isChecked(), true);
    await page.locator('#h5-update-now').tap();
    await waitFor(() => w.log.some(entry => entry.pathname === '/api/remote-servers/7/apply-update'), 'the apply of Peer');
    await waitRow(page, 7, 'starting');
    assert.equal(await page.locator('#h5-update-state').textContent(), 'Starting the updates of the other services…');
    assert.equal(await page.locator('#h5-update-dismiss').isDisabled(), true, 'the dialog cannot be closed while the services are being started');
    await sleep(400);
    assert.equal(w.log.some(entry => entry.pathname === '/api/system/apply-update'), false, 'this machine waits for the answer of Peer');
    w.holdApply[7].resolve();
    await waitFor(() => w.log.some(entry => entry.pathname === '/api/system/apply-update'), 'this machine\'s apply');
    const at = name => w.log.findIndex(entry => entry.method === 'POST' && entry.pathname === name);
    const local = at('/api/system/apply-update');
    for (const id of [7, 8, 12]) assert.ok(at(`/api/remote-servers/${id}/apply-update`) >= 0 && at(`/api/remote-servers/${id}/apply-update`) < local, `service ${id} before this machine`);
    // The refusal of Peer two is on its row; this machine and the others went on.
    await waitRow(page, 12, 'failed');
    assert.equal(await rowText(page, 12), 'Update did not start: The remote engine is running another update');
    await page.waitForFunction(() => /Updating/.test(document.getElementById('h5-update-state').textContent));
    // Each started row follows its service until it reports the new version.
    w.after[7] = remote({ status: 'current', local_version: '2.0.0', remote_version: '2.0.0' });
    await waitRow(page, 7, 'done');
    assert.equal(await rowText(page, 7), 'Updated to 2.0.0');
    assert.ok(['accepted', 'updating'].includes(await rowState(page, 8)), 'VPS is still updating');
    w.after[8] = remote({ status: 'failed', error: 'NPM_INSTALLING_FAILED' });
    await waitRow(page, 8, 'failed');
    assert.equal(await rowText(page, 8), 'The remote engine failed to install dependencies');
    assert.ok(w.log.some(entry => entry.pathname === '/api/remote-servers/7/update-status'), 'the rows read update-status');
    await context.close();
  },
  async 'with this machine up to date, only the services are updated'(browser) {
    const w = world({
      local: localStatus({ status: 'current', remote_version: '1.0.0' }),
      servers: [{ id: 7, name: 'Peer' }, { id: 8, name: 'VPS' }],
      links: [{ id: 'l1', remote_server_id: 7, state: 'online' }],
      checks: { 7: remote(), 8: remote() },
    });
    const { context, page } = await open(browser, w);
    await openDialog(page);
    await page.waitForFunction(() => (document.getElementById('h5-update-state') || {}).textContent === 'Already up to date');
    await waitRow(page, 7, 'ready');
    assert.equal(await page.locator('#h5-update-now').textContent(), 'Update the selected services');
    // Nothing ticked: no button.
    await checkbox(page, 7).tap();
    await page.locator('#h5-update-now').waitFor({ state: 'detached' });
    await checkbox(page, 7).tap();
    await page.locator('#h5-update-now').tap();
    await page.waitForFunction(() => ['accepted', 'updating'].includes(document.querySelector('.h5-update-linked-row[data-engine="7"]').dataset.state));
    await page.waitForFunction(() => (document.getElementById('h5-update-state') || {}).textContent === 'Already up to date');
    assert.equal(await page.locator('#h5-update-dismiss').isDisabled(), false, 'the dialog can be closed again');
    await sleep(300);
    assert.equal(w.log.some(entry => entry.pathname === '/api/system/apply-update'), false, 'this machine is not updated');
    assert.equal(w.log.some(entry => entry.pathname === '/api/remote-servers/8/apply-update'), false, 'an unticked service is not updated');
    w.after[7] = remote({ status: 'current', local_version: '2.0.0', remote_version: '2.0.0' });
    await waitRow(page, 7, 'done');
    assert.equal(w.navigations, 1, 'no reload');
    await context.close();
  },
  async 'no list without other services, and the plain flow is unchanged'(browser) {
    const w = world();
    const { context, page } = await open(browser, w);
    await openDialog(page);
    await page.locator('#h5-update-now').waitFor();
    await sleep(300);
    assert.equal(await page.locator('#h5-update-linked').count(), 0);
    await page.locator('#h5-update-now').tap();
    await waitFor(() => w.log.some(entry => entry.pathname === '/api/system/apply-update'), 'this machine\'s apply');
    await context.close();
  },
  async 'screenshot: the dialog with two services'(browser) {
    if (!SHOTS) return;
    const w = world({
      servers: [{ id: 7, name: 'Studio Mac' }, { id: 8, name: 'VPS' }],
      links: [{ id: 'l1', remote_server_id: 7, state: 'online' }],
      checks: { 7: remote({ local_version: '2.100.3', remote_version: '2.101.0' }), 8: remote({ local_version: '2.99.0', remote_version: '2.101.0' }) },
      local: localStatus({ local_version: '2.101.0', remote_version: '2.102.0' }),
    });
    const { context, page } = await open(browser, w);
    await openDialog(page);
    await waitRow(page, 8, 'ready');
    await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running'));
    await page.screenshot({ path: path.join(SHOTS, 'update-linked-390.png') });
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
  console.log('Also update in the Update dialog passed.');
})().catch(error => { console.error(error); process.exit(1); });
