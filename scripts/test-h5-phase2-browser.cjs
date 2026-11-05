// The features ported from the desktop page into the MUI page (single page, phase 2), in real Chromium with mocked servers, on a phone (390x844, touch)
// and on a PC (1440x900, mouse):
// - Settings "Engines": list (this machine + remote Engines), connect with a pairing code (wrong code error), edit (the form echoes the saved name and
//   address, has no token field), check (an offline Engine shows the error), update a remote Engine with progress and the wait for its restart, remove
//   (confirmation); the engine selector of the task list follows every change. Dialogs are full screen on the phone and normal dialogs on the PC.
// - Update modal: red dot, install type, last check and interval, version source, release link, update-notified, force update, "Choose force update…"
//   after WORKTREE_DIRTY, the restart_pending help with the restart commands.
// - Task "⋯" menu: move to a group, edit the working directory (echo, relative path refused), delete with and without the directory (confirmation),
//   a refused directory delete; the new-task form's working directory (the default path shown but never sent, a relative path refused, a custom path sent).
// H5_SHOT_DIR=<dir> saves screenshots there.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const pageErrors = [];

function freshServer() {
  return {
    calls: [],
    servers: [{ id: 7, name: 'VPS', base_url: 'http://10.0.0.7:14002', status: 'online', remote_version: '2.87.0', last_checked_at: '2026-11-05 10:00:00', last_error: null }],
    nextId: 8,
    checkOffline: false,
    remoteUpdate: [], // the answers of /7/update-status after an update was started, one per poll (the last one repeats)
    update: { status: 'available', is_update_admin: true, local_version: '2.87.12', remote_version: '2.88.0', notice_version: null, install_type: 'git', version_url: 'https://github.com/o/r/raw/main/VERSION.json', last_checked_at: '2026-11-05T10:00:00Z', check_interval_seconds: 3600, remote_manifest: { release_url: 'https://github.com/o/r/releases/tag/v2.88.0', published_at: '2026-11-05T09:00:00Z' }, log: [] },
    afterApply: null,
    tasks: [
      { id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' },
      { id: 2, title: 'Write docs', status: 'doing', work_dir: '/work/docs' },
      { id: 3, title: 'Notes', status: 'todo', work_dir: null },
    ],
    nextTask: 10,
  };
}
let server = freshServer();

async function openPage(browser, { viewport, touch }) {
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...(SHOTS ? { deviceScaleFactor: touch ? 3 : 1 } : {}) });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() { this.readyState = 3; } };
    window.WebSocket.OPEN = 1;
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const body = (() => { try { return route.request().postDataJSON(); } catch { return undefined; } })();
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    const p = url.pathname;
    if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
    server.calls.push({ method, url: `${p}${url.search}`, body });
    if (p === '/auth/me') return json({ work_dir: null, effective_work_dir: '/home/t/tasks' });
    if (p === '/api/system/version') return json({ app_version: '2.87.12', boot_id: 'b1' });
    if (p === '/api/system/update-status') return json(server.afterApply || server.update);
    if (p === '/api/system/check-update') return json(server.update);
    if (p === '/api/system/update-notified') return json({ ...server.update, notice_version: body.version });
    if (p === '/api/system/apply-update') { server.afterApply = { ...server.update, status: 'blocked', error: 'WORKTREE_DIRTY', error_details: 'src/a.js', log: [{ at: 1, text: 'git status' }] }; return json({ accepted: true }, 202); }
    // Remote Engines.
    if (p === '/api/remote-servers' && method === 'GET') return json(server.servers);
    if (p === '/api/remote-servers/test') return body.token === 'TA-GOOD-CODE-0001' ? json({ success: true }) : json({ error: 'PAIRING_CODE_INVALID_OR_EXPIRED' }, 400);
    if (p === '/api/remote-servers' && method === 'POST') {
      if (body.token !== 'TA-GOOD-CODE-0001') return json({ error: 'PAIRING_CODE_INVALID_OR_EXPIRED' }, 400);
      const created = { id: server.nextId++, name: new URL(body.url).hostname, base_url: `${body.url}:${body.port}`, status: 'online', remote_version: '2.87.12', last_checked_at: '2026-11-05 11:00:00' };
      server.servers.push(created);
      return json(created, 201);
    }
    let m = p.match(/^\/api\/remote-servers\/(\d+)(\/.*)?$/);
    if (m) {
      const id = Number(m[1]);
      const row = server.servers.find(item => item.id === id);
      const rest = m[2] || '';
      if (!row) return json({ error: 'REMOTE_NOT_FOUND' }, 404);
      if (rest === '' && method === 'PUT') { Object.assign(row, { name: body.name, base_url: `${body.url}${body.port ? `:${body.port}` : ''}` }); return json(row); }
      if (rest === '' && method === 'DELETE') { server.servers = server.servers.filter(item => item !== row); return json({ success: true }); }
      if (rest === '/test') return json({ success: true });
      if (rest === '/check') {
        if (server.checkOffline) { Object.assign(row, { status: 'offline', last_error: 'REMOTE_TIMEOUT' }); return json({ error: 'REMOTE_TIMEOUT', server: row }, 502); }
        Object.assign(row, { status: 'online', last_error: null }); return json(row);
      }
      if (rest === '/check-update') return json({ status: 'available', local_version: row.remote_version, remote_version: '2.88.0', install_type: 'git', update_ref: 'main', remote_manifest: { release_url: 'https://github.com/o/r/releases/tag/v2.88.0' } });
      if (rest === '/apply-update') { server.remoteUpdate = [{ status: 'updating', stage: 'installing', message: 'Installing dependencies', local_version: row.remote_version, log: [{ at: 1, text: 'npm ci' }] }, 'down', { status: 'current', local_version: '2.88.0', log: [{ at: 1, text: 'npm ci' }, { at: 2, text: 'restarted' }] }]; return json({ accepted: true }, 202); }
      if (rest === '/update-status') {
        const next = server.remoteUpdate.length > 1 ? server.remoteUpdate.shift() : server.remoteUpdate[0];
        if (next === 'down') return json({ error: 'REMOTE_CONNECTION_FAILED' }, 502);
        if (next && next.local_version === '2.88.0') row.remote_version = '2.88.0';
        return json(next || { status: 'idle' });
      }
      if (rest === '/info') return json({ capabilities: [] });
      if (rest === '/tasks') return json([{ id: 90, title: `Task on ${row.name}`, status: 'doing' }]);
      if (rest === '/task-groups') return json([]);
      if (/^\/tasks\/\d+\/terminals$/.test(rest)) return json([]);
      if (rest === '/terminal-activity' || rest === '/terminal-subagents') return json({});
      return json({ error: 'not mocked' }, 404);
    }
    // Local tasks.
    if (p === '/api/tasks' && method === 'GET') return json(server.tasks);
    if (p === '/api/tasks' && method === 'POST') {
      if (body.work_dir && !body.work_dir.startsWith('/')) return json({ error: 'work_dir must be an absolute path' }, 400);
      const created = { id: server.nextTask++, title: body.title, status: 'todo', work_dir: body.work_dir || `/home/t/tasks/${body.title.replace(/\s+/g, '-')}` };
      server.tasks.push(created);
      return json(created, 201);
    }
    if (p === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }, { key: 'todo', name: 'To do', sort_order: 2 }, { key: 'done', name: 'Done', sort_order: 3 }]);
    m = p.match(/^\/api\/tasks\/(\d+)$/);
    if (m) {
      const item = server.tasks.find(entry => entry.id === Number(m[1]));
      if (!item) return json({ error: 'Task not found' }, 404);
      if (method === 'PUT') { Object.assign(item, body); return json(item); }
      if (method === 'DELETE') {
        if (url.searchParams.get('delete_directory') === '1' && item.work_dir === '/work/docs') return json({ error: 'DIRECTORY_NOT_SAFE_TO_DELETE', reason: 'shared with another task' }, 409);
        server.tasks = server.tasks.filter(entry => entry !== item);
        return json(url.searchParams.get('delete_directory') === '1' ? { success: true, directory_deleted: true } : { success: true });
      }
    }
    if (/^\/api\/tasks\/\d+\/terminals$/.test(p)) return json([]);
    if (/^\/api\/tasks\/\d+\/agent\/conversations$/.test(p)) return json([]);
    if (p === '/api/tasks/terminal-activity' || p === '/api/tasks/terminal-subagents') return json({});
    if (p === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  return { context, page };
}

const callsTo = (method, prefix) => server.calls.filter(call => call.method === method && call.url.startsWith(prefix));
async function until(check, what, timeout = 10000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error(`timed out: ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
const shot = async (page, name) => {
  if (!SHOTS) return;
  await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running'));
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

async function openSidebar(page, touch) {
  if (touch) {
    if (!(await page.evaluate(() => window.H5UI.get().tasksOpen))) {
      await page.waitForFunction(() => !document.body.classList.contains('h5-tasks-open'));
      await page.locator('#h5-open-tasks').tap();
    }
    await page.waitForFunction(() => { const panel = document.querySelector('#h5-tasks .h5-sheet-panel'); return panel && getComputedStyle(panel).transform === 'none'; });
  } else await page.locator('#h5-tasks').waitFor({ state: 'visible' });
}
async function openSettingsGroup(page, touch, id) {
  await openSidebar(page, touch);
  await page.locator('#h5-tasks-settings').click();
  await page.locator('#h5-settings').waitFor({ state: 'visible' });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#h5-settings .h5-sheet-panel')).transform === 'none');
  await page.locator(`#h5-set-${id} .MuiAccordionSummary-root`).click();
  await page.waitForFunction(group => document.querySelector(`#h5-set-${group} .MuiAccordionSummary-root`).getAttribute('aria-expanded') === 'true'
    && !document.getAnimations().some(animation => animation.playState === 'running'), id);
}
async function engineOptions(page) {
  if (!(await page.locator('#h5-engine').count())) return [];
  return page.locator('#h5-engine option').allTextContents();
}

async function checkUpdateModal(page, label, touch) {
  // The red dot: the state read at load says a new version exists.
  await page.waitForFunction(() => document.getElementById('h5-update').dataset.attention === 'true');
  assert.equal(await page.locator('#h5-update-dot .MuiBadge-dot.MuiBadge-invisible').count(), 0, `${label}: the red dot is shown`);
  // The phone opens with the task sheet (no task was open before); close it first.
  if (touch) { await page.locator('#h5-close-tasks').tap(); await page.waitForFunction(() => !document.body.classList.contains('h5-tasks-open')); }
  await page.locator('#h5-update').click();
  await page.locator('#h5-update-now').waitFor();
  assert.equal(await page.locator('#h5-update-install').textContent(), 'Git fast-forward update');
  assert.equal(await page.locator('#h5-update-interval').textContent(), '60 min');
  assert.equal(await page.locator('#h5-update-source').textContent(), 'https://github.com/o/r/raw/main/VERSION.json');
  assert.notEqual(await page.locator('#h5-update-checked').textContent(), 'Not checked yet');
  assert.equal(await page.locator('#h5-update-notes').getAttribute('href'), 'https://github.com/o/r/releases/tag/v2.88.0');
  assert.match(await page.locator('#h5-update-warning').textContent(), /fast-forwards the code/);
  await until(() => callsTo('POST', '/api/system/update-notified').length === 1, 'update-notified');
  assert.deepEqual(callsTo('POST', '/api/system/update-notified')[0].body, { version: '2.88.0' });
  await shot(page, `${label}-update-modal`);
  // Force update sends force: true; the mocked update then stops on WORKTREE_DIRTY, which offers the force update again.
  await page.locator('#h5-update-force').check();
  assert.equal(await page.locator('#h5-update-now').textContent(), 'Force update now');
  await page.locator('#h5-update-now').click();
  await until(() => callsTo('POST', '/api/system/apply-update').length === 1, 'apply-update');
  assert.deepEqual(callsTo('POST', '/api/system/apply-update')[0].body, { confirm: true, force: true });
  await page.locator('#h5-update-state[role="alert"]', { hasText: 'Local uncommitted changes: src/a.js' }).waitFor();
  await page.locator('#h5-update-force-retry').click();
  assert.equal(await page.locator('#h5-update-force').isChecked(), true, `${label}: "Choose force update…" goes back with force ticked`);
  await page.locator('#h5-update-dismiss').click();
  await page.locator('#h5-update-dialog').waitFor({ state: 'detached' });
  server.afterApply = null;
  // restart_pending: the hint with the restart commands of every install type.
  server.update = { ...server.update, status: 'restart_pending', message: 'Code updated; restart the service to apply it' };
  await page.locator('#h5-update').click();
  await page.locator('#h5-update-restart').waitFor();
  const restart = await page.locator('#h5-update-restart').textContent();
  for (const command of ['pm2 restart t-agent', 'launchctl kickstart -k gui/$(id -u)/com.tagent.client', 'sudo systemctl restart t-agent']) assert.ok(restart.includes(command), `${label}: ${command}`);
  assert.equal(await page.locator('#h5-update-now').count(), 0);
  assert.equal(await page.evaluate(() => document.getElementById('h5-update').dataset.attention), 'true', `${label}: restart_pending keeps the red dot`);
  await shot(page, `${label}-update-restart`);
  await page.keyboard.press('Escape');
  await page.locator('#h5-update-dialog').waitFor({ state: 'detached' });
  // Up to date: no dot after the next check.
  server.update = { ...server.update, status: 'current', remote_version: '2.87.12', message: '' };
  await page.locator('#h5-update').click();
  await page.locator('#h5-update-state', { hasText: 'Already up to date' }).waitFor();
  await page.waitForFunction(() => !document.getElementById('h5-update').dataset.attention);
  await page.keyboard.press('Escape');
  await page.locator('#h5-update-dialog').waitFor({ state: 'detached' });
}

async function checkEngines(page, label, touch) {
  await openSettingsGroup(page, touch, 'engines');
  await page.locator('.h5-engine-row[data-engine="7"]').waitFor();
  assert.equal(await page.locator('#h5-engine-local-version').textContent(), 'v2.87.12');
  const row = page.locator('.h5-engine-row[data-engine="7"]');
  assert.equal(await row.locator('.h5-engine-status').textContent(), 'Online');
  assert.match(await row.locator('.h5-engine-meta').textContent(), /http:\/\/10\.0\.0\.7:14002 · v2\.87\.0/);
  await shot(page, `${label}-engines`);

  // Connect: the same errors as the desktop page; a wrong pairing code is refused, the right one adds the Engine to the list and to the selector.
  await page.locator('#h5-engine-connect-open').click();
  await page.locator('#h5-engine-connect [role="dialog"]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#h5-engine-connect .MuiDialog-paperFullScreen').count(), touch ? 1 : 0, `${label}: full screen only on the phone`);
  assert.equal(await page.getAttribute('#h5-engine-token', 'type'), 'password');
  await page.fill('#h5-engine-url', 'http://10.0.0.9');
  await page.fill('#h5-engine-port', '14002');
  await page.fill('#h5-engine-token', 'TA-BAD');
  await page.locator('#h5-engine-connect-save').click();
  await page.locator('#h5-engine-connect-result', { hasText: 'The pairing code is invalid or has expired' }).waitFor();
  await page.fill('#h5-engine-token', 'TA-GOOD-CODE-0001');
  await page.locator('#h5-engine-connect-test').click();
  await page.locator('#h5-engine-connect-result', { hasText: 'Connected' }).waitFor();
  await shot(page, `${label}-engine-connect`);
  await page.locator('#h5-engine-connect-save').click();
  await page.locator('#h5-engine-connect').waitFor({ state: 'detached' });
  await page.locator('.h5-engine-row[data-engine="8"]').waitFor();
  assert.deepEqual(callsTo('POST', '/api/remote-servers').filter(call => call.url === '/api/remote-servers').at(-1).body, { url: 'http://10.0.0.9', port: '14002', token: 'TA-GOOD-CODE-0001' });
  await page.waitForFunction(() => [...document.querySelectorAll('#h5-engine option')].map(o => o.textContent).includes('10.0.0.9'));

  // Edit: the form echoes the saved name and address (no token field: the saved token is reused); saving renames the option of the selector.
  await row.locator('.h5-engine-edit').click();
  await page.locator('#h5-engine-edit [role="dialog"]').waitFor({ state: 'visible' });
  assert.equal(await page.inputValue('#h5-engine-edit-name'), 'VPS');
  assert.equal(await page.inputValue('#h5-engine-edit-url'), 'http://10.0.0.7');
  assert.equal(await page.inputValue('#h5-engine-edit-port'), '14002');
  assert.equal(await page.locator('#h5-engine-edit input[type="password"]').count(), 0, `${label}: the edit form shows no token`);
  await page.locator('#h5-engine-edit-test').click();
  await page.locator('#h5-engine-edit-result', { hasText: 'Connected; the token is valid' }).waitFor();
  await page.fill('#h5-engine-edit-name', 'Cloud box');
  await page.locator('#h5-engine-edit-save').click();
  await page.locator('#h5-engine-edit').waitFor({ state: 'detached' });
  assert.deepEqual(callsTo('PUT', '/api/remote-servers/7').at(-1).body, { name: 'Cloud box', url: 'http://10.0.0.7', port: '14002' });
  await page.waitForFunction(() => [...document.querySelectorAll('#h5-engine option')].map(o => o.textContent).includes('Cloud box'));

  // Check: an offline Engine shows the reason and its new state.
  server.checkOffline = true;
  await row.locator('.h5-engine-check').click();
  await row.locator('.h5-engine-status', { hasText: 'Offline' }).waitFor();
  await row.locator('[role="status"]', { hasText: 'Connection timed out' }).waitFor();
  server.checkOffline = false;
  await row.locator('.h5-engine-check').click();
  await row.locator('.h5-engine-status', { hasText: 'Online' }).waitFor();

  // Update a remote Engine: check, confirm, follow the progress while it restarts, and see the new version.
  await row.locator('.h5-engine-update').click();
  await page.locator('#h5-engine-update-apply').waitFor();
  assert.equal(await page.locator('#h5-engine-update-latest').textContent(), '2.88.0');
  assert.equal(await page.locator('#h5-engine-update-install').textContent(), 'Git fast-forward update');
  assert.equal(await page.locator('#h5-engine-update-notes').getAttribute('href'), 'https://github.com/o/r/releases/tag/v2.88.0');
  await shot(page, `${label}-engine-update`);
  await page.locator('#h5-engine-update-apply').click();
  await page.locator('#h5-engine-update-confirm').click();
  await page.locator('#h5-engine-update-log', { hasText: 'npm ci' }).waitFor({ timeout: 10000 });
  assert.equal(await page.locator('#h5-engine-update-close').isDisabled(), true, `${label}: the update dialog stays open while the Engine updates`);
  await page.locator('#h5-engine-update-state', { hasText: 'Cloud box upgraded to 2.88.0' }).waitFor({ timeout: 15000 });
  await page.locator('#h5-engine-update-close').click();
  await page.locator('#h5-engine-update').waitFor({ state: 'detached' });
  await row.locator('.h5-engine-meta', { hasText: 'v2.88.0' }).waitFor();

  // Remove: asks first; declining keeps it, accepting removes it from the list and the selector.
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('.h5-engine-row[data-engine="8"] .h5-engine-remove').click();
  await page.waitForTimeout(200);
  assert.equal(callsTo('DELETE', '/api/remote-servers/8').length, 0);
  page.once('dialog', dialog => { assert.equal(dialog.message(), 'Remove this remote connection? Remote data is not deleted.'); dialog.accept(); });
  await page.locator('.h5-engine-row[data-engine="8"] .h5-engine-remove').click();
  await page.locator('.h5-engine-row[data-engine="8"]').waitFor({ state: 'detached' });
  await page.waitForFunction(() => ![...document.querySelectorAll('#h5-engine option')].map(o => o.textContent).includes('10.0.0.9'));
  await page.locator('#h5-close-settings').click();
  await page.locator('#h5-settings .h5-sheet-panel').waitFor({ state: 'hidden' });
  // The shown Engine is removed: the task list goes back to this machine.
  await openSidebar(page, touch);
  await page.locator('#h5-engine').selectOption('remote:7');
  await page.locator('.h5-task-item', { hasText: 'Task on Cloud box' }).waitFor();
  await openSettingsGroup(page, touch, 'engines');
  await page.locator('.h5-engine-row[data-engine="7"]').waitFor();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('.h5-engine-row[data-engine="7"] .h5-engine-remove').click();
  await page.locator('#h5-engine-empty').waitFor();
  await page.locator('#h5-close-settings').click();
  await page.locator('#h5-settings .h5-sheet-panel').waitFor({ state: 'hidden' });
  await openSidebar(page, touch);
  await page.locator('.h5-task-item', { hasText: 'Fix login' }).waitFor();
  assert.equal(await page.locator('#h5-engine').count(), 0, `${label}: no selector with only this machine`);
}

async function taskMenu(page, title) {
  await page.locator('.h5-task-row', { has: page.locator('.h5-task-item', { hasText: title }) }).locator('.h5-task-more').click();
  await page.locator('#h5-term-menu-actions').waitFor({ state: 'visible' });
  // The sheet slides up; a click during the slide can land on the backdrop (headless Chromium draws few frames while the display sleeps).
  await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running') && getComputedStyle(document.querySelector('#h5-term-menu .h5-menu-panel')).transform === 'none');
}

async function checkTasks(page, label, touch) {
  await openSidebar(page, touch);
  await page.locator('.h5-task-item', { hasText: 'Fix login' }).waitFor();
  assert.equal(await page.locator('#h5-tasks .h5-task-more').count(), await page.locator('#h5-tasks .h5-task-item').count(), 'every task has "⋯"');
  assert.equal(await page.getAttribute('#h5-tasks .h5-task-more >> nth=0', 'aria-label'), 'Task actions');
  // The "+" stays at the right end; "⋯" is left of it.
  assert.ok(await page.evaluate(() => {
    const rowEl = document.querySelector('#h5-tasks .h5-task-row');
    return rowEl.querySelector('.h5-task-more').getBoundingClientRect().right <= rowEl.querySelector('.h5-task-add').getBoundingClientRect().left + 1;
  }));

  // Move to a group.
  await taskMenu(page, 'Fix login');
  assert.deepEqual(await page.locator('#h5-term-menu-actions button').allTextContents(), ['✓ Move to “In progress”', 'Move to “To do”', 'Move to “Done”', 'Edit working directory', 'Delete']);
  await shot(page, `${label}-task-menu`);
  await page.locator('#h5-term-menu-actions button', { hasText: 'Done' }).click();
  await until(() => callsTo('PUT', '/api/tasks/1').length === 1, 'move PUT');
  assert.deepEqual(callsTo('PUT', '/api/tasks/1')[0].body, { status: 'done' });

  // Edit the working directory: the saved path is shown; a relative path is refused without a request; an absolute one is saved.
  if (touch) await openSidebar(page, touch);
  await taskMenu(page, 'Fix login');
  await page.locator('#h5-term-menu-actions button', { hasText: 'Edit working directory' }).click();
  await page.locator('#h5-task-workdir').waitFor();
  assert.equal(await page.inputValue('#h5-task-workdir'), '/work/fix-login');
  await page.fill('#h5-task-workdir', 'relative/dir');
  await page.locator('#h5-task-dialog-ok').click();
  await page.locator('#h5-task-dialog', { hasText: 'Enter an absolute path' }).waitFor();
  assert.equal(callsTo('PUT', '/api/tasks/1').length, 1);
  await page.fill('#h5-task-workdir', '/work/login-v2');
  await page.locator('#h5-task-dialog-ok').click();
  await page.locator('#h5-task-dialog').waitFor({ state: 'detached' });
  assert.deepEqual(callsTo('PUT', '/api/tasks/1').at(-1).body, { work_dir: '/work/login-v2' });

  // Delete with the directory, refused by the server (shared directory): the reason is shown and the task stays.
  if (touch) await openSidebar(page, touch);
  await taskMenu(page, 'Write docs');
  await page.locator('#h5-term-menu-actions button', { hasText: 'Delete' }).click();
  await page.locator('#h5-task-delete-dir').waitFor();
  assert.equal(await page.locator('#h5-task-delete-dir').isChecked(), false, 'the directory is not deleted by default');
  await page.locator('#h5-task-delete-dir').check();
  assert.match(await page.locator('#h5-task-delete-dir-path').textContent(), /\/work\/docs.*permanently deleted/);
  await shot(page, `${label}-task-delete`);
  await page.locator('#h5-task-dialog-ok').click();
  await page.locator('#h5-task-dialog-error', { hasText: 'This directory cannot be deleted (protected or shared with other tasks); the task was not deleted: shared with another task' }).waitFor();
  assert.equal(callsTo('DELETE', '/api/tasks/2').at(-1).url, '/api/tasks/2?delete_directory=1');
  // Without the directory it goes.
  await page.locator('#h5-task-delete-dir').uncheck();
  await page.locator('#h5-task-dialog-ok').click();
  await page.locator('#h5-task-dialog').waitFor({ state: 'detached' });
  assert.equal(callsTo('DELETE', '/api/tasks/2').at(-1).url, '/api/tasks/2');
  if (touch) await openSidebar(page, touch);
  await page.locator('.h5-task-item', { hasText: 'Write docs' }).waitFor({ state: 'detached' });
  // A task without a working directory: no checkbox, and Cancel deletes nothing.
  await taskMenu(page, 'Notes');
  await page.locator('#h5-term-menu-actions button', { hasText: 'Delete' }).click();
  await page.locator('#h5-task-dialog', { hasText: 'This task has no working directory, so no directory will be deleted.' }).waitFor();
  assert.equal(await page.locator('#h5-task-delete-dir').count(), 0);
  await page.locator('#h5-task-dialog-cancel').click();
  await page.locator('#h5-task-dialog').waitFor({ state: 'detached' });
  assert.equal(callsTo('DELETE', '/api/tasks/3').length, 0);
  // With the directory (allowed).
  if (touch) await openSidebar(page, touch);
  await taskMenu(page, 'Fix login');
  await page.locator('#h5-term-menu-actions button', { hasText: 'Delete' }).click();
  await page.locator('#h5-task-delete-dir').check();
  await page.locator('#h5-task-dialog-ok').click();
  await page.locator('#h5-task-dialog').waitFor({ state: 'detached' });
  assert.equal(callsTo('DELETE', '/api/tasks/1').at(-1).url, '/api/tasks/1?delete_directory=1');

  // New task: the default path is shown (and follows the title) but never sent; a relative path is refused; a custom path is sent.
  if (touch) await openSidebar(page, touch);
  await page.locator('#h5-add-task').click();
  await page.fill('#h5-new-task-title', 'My task');
  await page.waitForFunction(() => document.getElementById('h5-new-task-dir').placeholder === '/home/t/tasks/My-task');
  assert.match(await page.locator('#h5-new-task-dir-help').textContent(), /Leave empty to use the default: \/home\/t\/tasks\/My-task/);
  await shot(page, `${label}-new-task`);
  await page.locator('#h5-new-task button[type="submit"]').click();
  await until(() => callsTo('POST', '/api/tasks').length === 1, 'create without a path');
  assert.deepEqual(callsTo('POST', '/api/tasks')[0].body, { title: 'My task' }, `${label}: the default path is not saved as a custom path`);
  await page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'My task'); // the new task is opened (the phone sheet closes)
  if (touch) await openSidebar(page, touch);
  await page.locator('#h5-add-task').click();
  await page.fill('#h5-new-task-title', 'Second');
  await page.fill('#h5-new-task-dir', 'not/absolute');
  await page.locator('#h5-new-task button[type="submit"]').click();
  await page.locator('#h5-new-task-dir-help', { hasText: 'Enter an absolute path' }).waitFor();
  assert.equal(callsTo('POST', '/api/tasks').length, 1, 'a relative path is not sent');
  await page.fill('#h5-new-task-dir', '/data/second');
  await page.locator('#h5-new-task button[type="submit"]').click();
  await until(() => callsTo('POST', '/api/tasks').length === 2, 'create with a path');
  assert.deepEqual(callsTo('POST', '/api/tasks')[1].body, { title: 'Second', work_dir: '/data/second' });
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const [label, viewport, touch] of [['phone-390', { width: 390, height: 844 }, true], ['pc-1440', { width: 1440, height: 900 }, false]]) {
      for (const run of [checkUpdateModal, checkEngines, checkTasks]) {
        server = freshServer();
        const { context, page } = await openPage(browser, { viewport, touch });
        await page.locator('#h5-update').waitFor();
        await run(page, label, touch);
        await context.close();
      }
    }
    assert.deepEqual(pageErrors, []);
    console.log('h5 phase 2 (engines, update details, task actions): ok');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
