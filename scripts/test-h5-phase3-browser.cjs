// What the deleted desktop-page unit tests checked (single page, phase 3), now on the one page at `/`, in real Chromium with mocked servers at
// 1440x900 (mouse):
// - Engine choice: the saved remote Engine comes back after a reload, a removed one falls back to this machine, an Engine whose task list fails shows
//   the error instead of tasks, and switching back to this machine shows its tasks again (was test/remote-active-engine and remote-engine-unavailable).
// - Update reload after a restart (scripts/h5-shell/Update.jsx): the same process answering "not updating" does not reload the page, a new process
//   (another boot_id) does, an outage followed by an answer does, and after 20 s of restarting "Refresh now" appears (was test/update-reload-after-restart
//   and one-click-update).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const pageErrors = [];

const LOCAL_TASKS = [{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }];
function freshServer() {
  return {
    servers: [{ id: 7, name: 'VPS', base_url: 'http://10.0.0.7:14002', status: 'online', remote_version: '2.87.0' }],
    remoteTasksFail: false,
    update: { status: 'available', is_update_admin: true, local_version: '2.87.13', remote_version: '2.88.0', notice_version: '2.88.0', install_type: 'git', check_interval_ms: 3600000 },
    statusAnswers: [], // the answers of /api/system/update-status after the update started, one per poll (the last one repeats); 'down' = 502
    applied: false,
  };
}
let server = freshServer();

async function openPage(browser, { source = null, clock = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  if (clock) await page.clock.install();
  await page.addInitScript(saved => {
    window.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() { this.readyState = 3; } };
    window.WebSocket.OPEN = 1;
    if (saved && !sessionStorage.getItem('seeded')) { localStorage.setItem('h5-source', saved); sessionStorage.setItem('seeded', '1'); }
  }, source);
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    const p = url.pathname;
    if (p === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
    if (p === '/auth/me') return json({ work_dir: null, effective_work_dir: '/home/t/tasks' });
    if (p === '/api/system/version') return json({ app_version: '2.87.13', boot_id: 'b1' });
    if (p === '/api/system/check-update') return json(server.update);
    if (p === '/api/system/apply-update') { server.applied = true; return json({ accepted: true }, 202); }
    if (p === '/api/system/update-status') {
      if (!server.applied) return json(server.update);
      const next = server.statusAnswers.length > 1 ? server.statusAnswers.shift() : server.statusAnswers[0];
      return next === 'down' ? json({ error: 'down' }, 502) : json(next);
    }
    if (p === '/api/remote-servers' && method === 'GET') return json(server.servers);
    const m = p.match(/^\/api\/remote-servers\/(\d+)(\/.*)?$/);
    if (m) {
      const row = server.servers.find(item => item.id === Number(m[1]));
      const rest = m[2] || '';
      if (!row) return json({ error: 'REMOTE_NOT_FOUND' }, 404);
      if (rest === '/tasks') return server.remoteTasksFail ? json({ error: 'REMOTE_CONNECTION_FAILED' }, 502) : json([{ id: 90, title: `Task on ${row.name}`, status: 'doing' }]);
      if (rest === '/task-groups') return json([]);
      if (rest === '/info') return json({ capabilities: [] });
      if (rest === '/terminal-activity' || rest === '/terminal-subagents') return json({});
      return json({ error: 'not mocked' }, 404);
    }
    if (p === '/api/tasks' && method === 'GET') return json(LOCAL_TASKS);
    if (p === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }, { key: 'todo', name: 'To do', sort_order: 2 }, { key: 'done', name: 'Done', sort_order: 3 }]);
    if (/^\/api\/tasks\/\d+\/terminals$/.test(p)) return json([]);
    if (/^\/api\/tasks\/\d+\/agent\/conversations$/.test(p)) return json([]);
    if (p === '/api/tasks/terminal-activity' || p === '/api/tasks/terminal-subagents') return json({});
    if (p === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/`);
  await page.locator('#h5-tasks').waitFor({ state: 'visible' });
  return { context, page };
}

const listText = page => page.locator('#h5-task-list').textContent();
async function waitForList(page, pattern, what) {
  await page.waitForFunction(source => new RegExp(source).test(document.getElementById('h5-task-list')?.textContent || ''), pattern.source, { timeout: 10000 })
    .catch(async () => { throw new Error(`${what}: the task list says "${await listText(page)}"`); });
}

async function engineChoice(browser) {
  // There is no Engine switch: the tasks of both are in one list, with a remembered Engine too.
  server = freshServer();
  let { context, page } = await openPage(browser, { source: 'remote:7' });
  await waitForList(page, /Task on VPS/, 'saved Engine');
  await waitForList(page, /Fix login/, 'this machine is in the same list');
  assert.equal(await page.locator('#h5-engine').count(), 0, 'no Engine selector');
  await page.reload();
  await waitForList(page, /Task on VPS/, 'saved Engine after a reload');
  await waitForList(page, /Fix login/, 'this machine after a reload');
  await context.close();

  // A saved Engine that was removed: this machine, without an error.
  server = freshServer();
  ({ context, page } = await openPage(browser, { source: 'remote:9' }));
  await waitForList(page, /Fix login/, 'removed Engine');
  assert.doesNotMatch(await listText(page), /Could not load/);
  await context.close();

  // An Engine whose task list fails: there are no device headers any more, so it simply adds no rows (its state is in Settings); this machine still works.
  server = freshServer();
  server.remoteTasksFail = true;
  ({ context, page } = await openPage(browser, { source: 'remote:7' }));
  await waitForList(page, /Fix login/, 'this machine next to a failing Engine');
  assert.doesNotMatch(await listText(page), /Task on VPS|Could not load/);
  await context.close();
}

async function startUpdate(page) {
  await page.locator('#h5-update').click();
  await page.locator('#h5-update-now').waitFor();
  await page.evaluate(() => { window.__beforeReload = true; });
  await page.locator('#h5-update-now').click();
}
const reloaded = page => page.evaluate(() => !window.__beforeReload).catch(() => false);
async function waitReload(page, what, timeout = 8000) {
  const started = Date.now();
  while (!(await reloaded(page))) {
    if (Date.now() - started > timeout) throw new Error(`no reload: ${what}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function updateReload(browser) {
  // The same process keeps answering: no reload, even when it says it is no longer updating; a new process (another boot_id) reloads.
  server = freshServer();
  server.statusAnswers = [{ status: 'updating', stage: 'installing', message: 'Installing dependencies', boot_id: 'b1' }, { status: 'current', stage: 'idle', boot_id: 'b1' }];
  let { context, page } = await openPage(browser);
  await startUpdate(page);
  await new Promise(resolve => setTimeout(resolve, 3500));
  assert.equal(await reloaded(page), false, 'the same process does not reload the page');
  server.statusAnswers = [{ status: 'current', stage: 'idle', boot_id: 'b2' }];
  await waitReload(page, 'a new process');
  await context.close();

  // An outage (the old process exits), then an answer: reload.
  server = freshServer();
  server.statusAnswers = [{ status: 'updating', stage: 'restarting', boot_id: 'b1' }, 'down', { status: 'idle', boot_id: 'b1' }];
  ({ context, page } = await openPage(browser));
  await startUpdate(page);
  await waitReload(page, 'after an outage');
  await context.close();

  // Restarting for 20 s without coming back: "Refresh now".
  server = freshServer();
  server.statusAnswers = [{ status: 'updating', stage: 'restarting', boot_id: 'b1' }];
  ({ context, page } = await openPage(browser, { clock: true }));
  await startUpdate(page);
  await page.getByText('Restarting the PC service, this page reloads when it is back…').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Refresh now' }).count(), 0, 'no "Refresh now" at once');
  await page.clock.fastForward(21000);
  await page.getByRole('button', { name: 'Refresh now' }).waitFor({ timeout: 5000 });
  assert.equal(await reloaded(page), false, 'still waiting, not reloaded');
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await engineChoice(browser);
    await updateReload(browser);
    assert.deepEqual(pageErrors, []);
    console.log('Phase 3 on the page at /: Engine choice restore / fallback / failing Engine, and the update reload after a restart.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
