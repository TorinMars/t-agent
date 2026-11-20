// "Move to another machine…" on the page in real Chromium at 390px (touch) and 1440px (mouse), with a mocked server: the menu item, the Move task
// dialog (targets by name, an offline one disabled with its reason, the company computer tick that keeps Move disabled until ticked, the counts and
// the busy agent), the progress dialog (closed while the move goes on, read again from the same menu item), the end notice. H5_SHOT_DIR=<dir> saves
// screenshots of both dialogs (move-dialog-<width>.png, move-progress-<width>.png).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const K01 = '22222222-2222-4222-8222-222222222222';
const M2 = '33333333-3333-4333-8333-333333333333';

function makeServer() {
  const server = { pageErrors: [], bodies: [], progressReads: 0, finish: false };
  server.preview = {
    task: { id: 1, title: 'Notes' }, self: { instance_id: '11111111-1111-4111-8111-111111111111', name: 'T01', company_computer: false },
    folder: { path: '/w/notes', files: 148, dirs: 12, links: 1, bytes: 3_200_000, skipped: 0, truncated: null }, sessions: { claude: 1, codex: 1, missing: 0 },
    limit_bytes: 2 * 1024 ** 3, refusal: null, terminals: { running: 2, busy: 1 }, active: null,
    targets: [
      { instance_id: M2, name: 'M2', online: false, supported: null, company_computer: null, free_bytes: null, refusal: { error: 'MOVE_TARGET_OFFLINE' } },
      { instance_id: K01, name: 'K01', online: true, supported: true, company_computer: true, free_bytes: 50e9, refusal: null },
    ],
  };
  server.progress = phase => ({ id: 'm1', task_id: 1, title: 'Notes', phase, target: { instance_id: K01, name: 'K01' }, files_total: 148, files_done: 92, bytes_total: 3_200_000, bytes_done: 2_000_000, cancellable: phase === 'copying', error: null, new_task_id: phase === 'done' ? 9 : null });
  return server;
}

async function openPage(browser, server, viewport, touch) {
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...(process.env.H5_SHOT_DIR ? { deviceScaleFactor: 2 } : {}) });
  const page = await context.newPage();
  page.on('pageerror', error => server.pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() { this.readyState = 3; } };
    window.WebSocket.OPEN = 1;
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
    let body = null;
    try { body = request.postData() ? JSON.parse(request.postData()) : null; } catch { body = null; }
    if (body) server.bodies.push({ key: `${method} ${pathname}`, body });
    if (pathname === '/api/remote-servers') return json([]);
    if (pathname === '/api/service-links') return json({ supported: true, links: [{ id: 'l1', name: 'K01', state: 'online' }] });
    if (/\/task-groups$/.test(pathname)) return json([{ key: 'todo', name: 'To do', sort_order: 1 }]);
    if (/\/terminal-activity$/.test(pathname) || /\/terminal-subagents$/.test(pathname)) return json({});
    if (pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    if (pathname === '/api/oss/config') return json({ enabled: false });
    if (pathname === '/api/tasks' && method === 'GET') return json(server.finish ? [] : [{ id: 1, title: 'Notes', status: 'todo', work_dir: '/w/notes', archived_at: null }]);
    if (pathname === '/api/tasks/1/terminals') return json([]);
    if (pathname === '/api/tasks/1/move' && method === 'GET') return json(server.preview);
    if (pathname === '/api/tasks/1/move' && method === 'POST') { server.preview.active = server.progress('copying'); return json(server.progress('closing'), 202); }
    if (pathname === '/api/tasks/1/move/progress') { server.progressReads += 1; return json({ move: server.progress(server.finish ? 'done' : 'copying') }); }
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  return { context, page };
}

async function run(browser, wide) {
  const width = wide ? 1440 : 390;
  const label = `${wide ? 'PC' : 'phone'} ${width}px`;
  const server = makeServer();
  const { context, page } = await openPage(browser, server, wide ? { width: 1440, height: 900 } : { width: 390, height: 844 }, !wide);
  const press = locator => (wide ? locator.click() : locator.tap());
  const settled = () => page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity));
  const shot = async name => { if (process.env.H5_SHOT_DIR) { await settled(); await page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, `${name}-${width}.png`) }); } };
  const sheet = async () => {
    if (!wide && !await page.locator('#h5-tasks').isVisible()) await page.locator('#h5-open-tasks').tap();
    await page.locator('#h5-tasks').waitFor({ state: 'visible' });
    await settled();
  };
  const menuItems = page.locator('#h5-session-menu-actions [role="menuitem"]');
  const askMove = async () => {
    await sheet();
    await press(page.locator('.h5-task-row', { hasText: 'Notes' }).first().locator('.h5-task-more'));
    await menuItems.first().waitFor();
    await settled();
    // The links are read when the menu opens the first time: open it again until the item is there.
    if (!await menuItems.filter({ hasText: 'Move to another machine' }).count()) {
      await page.keyboard.press('Escape');
      await page.locator('#h5-session-menu-actions').waitFor({ state: 'detached' });
      await press(page.locator('.h5-task-row', { hasText: 'Notes' }).first().locator('.h5-task-more'));
      await menuItems.first().waitFor();
      await settled();
    }
    await press(menuItems.filter({ hasText: 'Move to another machine…' }));
    await page.locator('#h5-task-dialog').waitFor();
  };

  // ── The Move task dialog ──
  await askMove();
  await page.locator('#h5-move-target').waitFor();
  assert.match(await page.locator('#h5-move-text').textContent(), /^“Notes” moves from T01 to another machine with its folder, documents and agent sessions\.$/);
  assert.match(await page.locator('#h5-move-target').textContent(), /K01\s*Company computer/, `${label}: the usable target is chosen, with its tier`);
  assert.equal(await page.locator('#h5-move-counts').textContent(), '2 running terminals will be closed. 148 files, 3.2 MB.');
  assert.equal(await page.locator('#h5-move-busy').textContent(), 'An agent is working in 1 terminal; closing it stops its turn.');
  assert.equal(await page.locator('#h5-move-tier').textContent(), 'This puts personal files on a company computer.');
  assert.ok(await page.locator('#h5-task-dialog-ok').isDisabled(), `${label}: Move stays disabled until the tick`);
  await shot('move-dialog');
  // The targets in one order (by name), the offline one disabled with its reason.
  await press(page.locator('#h5-move-target'));
  const options = page.locator('.h5-move-target-option');
  await options.first().waitFor();
  assert.deepEqual((await options.allTextContents()).map(item => item.trim()), ['K01Company computer', 'M2Offline']);
  assert.equal(await options.nth(1).getAttribute('aria-disabled'), 'true');
  await page.keyboard.press('Escape');
  await page.locator('.h5-move-target-option').first().waitFor({ state: 'detached' });
  await press(page.locator('#h5-move-ack'));
  assert.ok(await page.locator('#h5-task-dialog-ok').isEnabled());
  const fit = await page.evaluate(() => { const box = document.querySelector('#h5-task-dialog .MuiDialog-paper'); return { scroll: box.scrollWidth, client: box.clientWidth, right: box.getBoundingClientRect().right, width: innerWidth }; });
  assert.ok(fit.scroll <= fit.client && fit.right <= fit.width, `${label}: the dialog fits ${JSON.stringify(fit)}`);
  await press(page.locator('#h5-task-dialog-ok'));

  // ── The progress dialog ──
  await page.locator('#h5-move-progress').waitFor();
  assert.deepEqual(server.bodies.filter(entry => entry.key === 'POST /api/tasks/1/move').map(entry => entry.body), [{ target: K01, tier_ack: true }], `${label}: the tick is sent (the server checks it too)`);
  await page.waitForFunction(() => (document.getElementById('h5-move-phase') || {}).textContent === 'Copying files · 92 of 148', null, { timeout: 5000 });
  assert.equal(await page.locator('#h5-task-dialog-title').textContent(), 'Moving “Notes” to K01');
  assert.ok(await page.locator('#h5-move-stop').isVisible(), `${label}: it can be stopped until the copy is verified`);
  await shot('move-progress');
  // Closed: the move goes on; the same menu item shows the progress again.
  await press(page.locator('#h5-task-dialog-cancel'));
  await page.locator('#h5-task-dialog').waitFor({ state: 'detached' });
  const reads = server.progressReads;
  await page.waitForTimeout(900);
  assert.ok(server.progressReads > reads, `${label}: the progress is still read while the dialog is closed`);
  await askMove();
  await page.locator('#h5-move-progress').waitFor();
  await press(page.locator('#h5-task-dialog-cancel'));
  await page.locator('#h5-task-dialog').waitFor({ state: 'detached' });
  // It ends: the notice, the task leaves this machine's list.
  server.finish = true;
  await page.waitForFunction(() => (window.H5UI.get().notice || {}).message === 'Moved “Notes” to K01', null, { timeout: 5000 });
  await context.close();
  assert.deepEqual(server.pageErrors, [], `${label}: no page errors`);
  console.log(`  ${label}: ok`);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await run(browser, false);
    await run(browser, true);
  } finally {
    await browser.close();
  }
  console.log('Moving a task on the page passed (390px, 1440px).');
})().catch(error => { console.error(error); process.exit(1); });
