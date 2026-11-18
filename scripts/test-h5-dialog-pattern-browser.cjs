// The one dialog pattern of the page ("One dialog pattern" in docs/design/page-dialogs.md) in real Chromium, with the API mocked, at 1440x900 (mouse)
// and 390x844 (touch): the title is MUI's h6 with 24px at the sides, the actions are text buttons with the dismissive one first and a contained one
// only to create or save, a destructive confirmation is in the error colour, a centred dialog keeps 16px margins on a phone and has an 8px radius,
// New task is full screen on a phone, Enter submits a form dialog and Escape closes it. Dialogs checked: New task, New session, the task dialogs
// (rename, archive, delete), Paste, the uploaded link, Update and the T-Attention Reject and Delete. H5_SHOT_DIR=<dir> saves a screenshot of each.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const AT = '2026-11-18T10:00:00Z';
const ITEMS = [
  { id: 1, title: 'Allow Bash', status: 'waiting_user', priority: 'none', source: 'codex', attention_reason: 'Allow Bash: npm test', updated_at: AT, created_at: AT },
  { id: 2, title: 'Check the PR', status: 'review', priority: 'none', source: 'claude', attention_reason: 'Claude finished.', updated_at: AT, created_at: AT },
];

const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
async function serve(calls, route) {
  const request = route.request();
  const { pathname } = new URL(request.url());
  const method = request.method();
  if (method !== 'GET') calls.push([method, pathname, request.postDataJSON()]);
  if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
  if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
  if (pathname === '/api/system/version') return json(route, { app_version: '2.101.0', boot_id: 'boot-a', engine_name: 'MacBook' });
  if (pathname === '/api/system/update-status' || pathname === '/api/system/check-update') return json(route, { status: 'available', local_version: '2.101.0', remote_version: '2.102.0', boot_id: 'boot-a', install_type: 'git', is_update_admin: true, log: [] });
  if (pathname === '/api/system/update-notified') return json(route, {});
  if (pathname === '/api/system/engine-name') return json(route, { name: 'MacBook', default_name: 'mbp', custom: true });
  if (pathname === '/api/remote-servers') return json(route, []);
  if (pathname === '/api/service-links') return json(route, { supported: true, links: [] });
  if (pathname === '/api/task-list/hidden-devices') return json(route, { hidden: [] });
  if (pathname === '/auth/me') return json(route, { effective_work_dir: '/home/me/tasks' });
  if (pathname === '/api/tasks' && method === 'POST') return json(route, { id: 9, title: 'Made', status: 'doing' });
  if (pathname === '/api/tasks') return json(route, [{ id: 1, title: 'Alpha', status: 'doing', work_dir: '/home/me/tasks/Alpha' }]);
  if (pathname === '/api/task-groups') return json(route, [{ key: 'doing', name: 'Doing', sort_order: 1 }]);
  if (pathname === '/api/tasks/terminal-activity' || pathname === '/api/tasks/terminal-subagents') return json(route, {});
  if (/^\/api\/tasks\/\d+\/terminals$/.test(pathname)) return json(route, [{ terminal_id: 'default', title: 'Terminal 1' }]);
  if (/\/agent\/conversations$/.test(pathname)) return json(route, []);
  if (pathname === '/api/agent-chat/summary') return json(route, { running: 0, queued: 0, submitted: 0 });
  if (pathname === '/api/attention' && method === 'GET') return json(route, { items: ITEMS, host: 'MacBook' });
  if (/^\/api\/attention\/\d+$/.test(pathname) && method === 'GET') return json(route, { events: [] });
  if (/^\/api\/attention\/\d+$/.test(pathname) && method === 'PATCH') return json(route, { ...ITEMS[1], ...request.postDataJSON() });
  if (pathname === '/api/attention/settings/guide') return json(route, { dismissed: true, pageOnly: false, paired: false, tested: false, updatedAt: null });
  if (pathname === '/api/task-order') return json(route, { order: [], updated_at: 1 });
  return json(route, { error: 'NOT_FOUND' }, 404);
}

async function openPage(browser, { viewport, touch }) {
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...(SHOTS ? { deviceScaleFactor: 2 } : {}) });
  const page = await context.newPage();
  const errors = [];
  const calls = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.WebSocket = class { constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); } send() {} close() { this.readyState = 3; } };
    window.WebSocket.OPEN = 1; window.WebSocket.CONNECTING = 0;
    window.EventSource = class extends EventTarget { constructor(url) { super(); this.url = url; setTimeout(() => { const e = new Event('open'); this.onopen?.(e); this.dispatchEvent(e); }, 20); } close() {} };
    window.Notification = class { close() {} }; window.Notification.permission = 'denied';
    try { localStorage.setItem('h5-columns', JSON.stringify({ on: false })); } catch { /* none */ }
  });
  await page.addInitScript(activityStreamMock);
  await page.route(`${ORIGIN}/**`, route => serve(calls, route));
  await page.goto(`${ORIGIN}/h5`);
  await page.waitForFunction(() => window.H5UI && window.H5UI.get().taskList);
  return { context, page, errors, calls };
}

// The look of the open dialog: its paper box, radius, the title's variant and padding, and each action button (id, text, variant, colour) in order.
const look = (page, selector) => page.evaluate(sel => {
  const papers = [...document.querySelectorAll(`${sel} .MuiDialog-paper`)];
  const paper = papers[papers.length - 1];
  const title = paper.querySelector('.MuiDialogTitle-root');
  const heading = title && (title.matches('h2') ? title : title.querySelector('h2'));
  const r = paper.getBoundingClientRect();
  const kind = button => (['contained', 'outlined', 'text'].find(name => button.classList.contains(`MuiButton-${name}`)) || '?');
  const colour = button => (['Primary', 'Error', 'Warning', 'Inherit'].find(name => button.className.includes(`MuiButton-color${name}`)) || '?').toLowerCase();
  return {
    left: r.left, right: r.right, width: r.width, top: r.top, height: r.height, innerWidth, innerHeight,
    radius: getComputedStyle(paper).borderTopLeftRadius,
    titleH6: Boolean(heading && heading.classList.contains('MuiTypography-h6')), titleSize: heading ? getComputedStyle(heading).fontSize : null,
    titlePad: title ? getComputedStyle(title).paddingLeft : null,
    actions: [...paper.querySelectorAll('.MuiDialogActions-root button')].map(button => ({ id: button.id, text: button.textContent.trim(), kind: kind(button), colour: colour(button) })),
  };
}, selector);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `dialog-pattern-${name}.png`) }); };

// The title and the shape every dialog has, and the 16px margins of a centred dialog on a phone.
function assertFrame(g, label, { phone, fullScreen = false }) {
  assert.ok(g.titleH6, `${label}: the title is h6`);
  assert.equal(g.titleSize, '20px', `${label}: the title is 20px`);
  assert.equal(g.titlePad, '24px', `${label}: 24px at the sides of the title`);
  if (fullScreen) {
    assert.ok(g.left === 0 && Math.abs(g.width - g.innerWidth) < 1, `${label}: full screen (${g.left}, ${g.width})`);
    assert.equal(g.radius, '0px', `${label}: no radius when full screen`);
    return;
  }
  assert.equal(g.radius, '8px', `${label}: an 8px radius`);
  if (phone) assert.ok(Math.abs(g.left - 16) < 1 && Math.abs(g.innerWidth - g.right - 16) < 1, `${label}: 16px margins on a phone (${g.left}-${g.right} of ${g.innerWidth})`);
}
const actions = g => g.actions.map(({ id, kind, colour }) => `${id}:${kind}:${colour}`);

async function run(browser, phone) {
  const size = phone ? 'phone 390' : 'computer 1440';
  const { context, page, errors, calls } = await openPage(browser, phone ? { viewport: { width: 390, height: 844 }, touch: true } : { viewport: { width: 1440, height: 900 }, touch: false });
  const set = patch => page.evaluate(value => window.H5UI.set(value), patch);
  const press = loc => (phone ? loc.tap() : loc.click());

  // New task: a form that creates; Create is the contained button after Cancel; full screen on a phone; Escape closes it; Enter creates.
  await page.evaluate(() => window.H5UI.actions.openNewTask());
  await page.locator('#h5-new-task-dialog .MuiDialog-paper').waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  let g = await look(page, '#h5-new-task-dialog');
  assertFrame(g, `${size}: New task`, { phone, fullScreen: phone });
  assert.deepEqual(actions(g), ['h5-new-task-cancel:text:primary', 'h5-new-task-create:contained:primary'], `${size}: New task actions`);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'h5-new-task-title', `${size}: the first field has the focus`);
  await shot(page, `${phone ? 'p' : 'd'}-new-task`);
  await page.keyboard.press('Escape');
  await page.locator('#h5-new-task-dialog').waitFor({ state: 'detached' });
  await page.evaluate(() => window.H5UI.actions.openNewTask());
  await page.locator('#h5-new-task-title').waitFor();
  await page.locator('#h5-new-task-title').fill('Made');
  await page.locator('#h5-new-task-title').press('Enter');
  await page.waitForFunction(() => !document.querySelector('#h5-new-task-dialog .MuiDialog-paper'));
  assert.deepEqual(calls.filter(([method, url]) => method === 'POST' && url === '/api/tasks').map(call => call[2]), [{ title: 'Made' }], `${size}: Enter in the title creates the task`);

  // The task dialogs: Rename (a form with the contained Save), Archive (a text confirmation), Delete (a text button in the error colour).
  await set({ taskDialog: { kind: 'rename', id: 1, sourceKey: 'local', title: 'Alpha', workDir: '', folderSupported: false } });
  await page.locator('#h5-task-dialog .MuiDialog-paper').waitFor({ state: 'visible' });
  g = await look(page, '#h5-task-dialog');
  assertFrame(g, `${size}: Rename`, { phone });
  assert.deepEqual(actions(g), ['h5-task-dialog-cancel:text:primary', 'h5-task-dialog-ok:contained:primary'], `${size}: Rename actions`);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'h5-task-rename-title', `${size}: the title field has the focus`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.H5UI.get().taskDialog === null);
  await set({ taskDialog: { kind: 'archive', id: 1, sourceKey: 'local', title: 'Alpha', running: 0 } });
  await page.locator('#h5-task-dialog .MuiDialog-paper').waitFor({ state: 'visible' });
  g = await look(page, '#h5-task-dialog');
  assertFrame(g, `${size}: Archive`, { phone });
  assert.deepEqual(actions(g), ['h5-task-dialog-cancel:text:primary', 'h5-task-dialog-ok:text:primary'], `${size}: Archive actions`);
  await set({ taskDialog: { kind: 'delete', id: 1, sourceKey: 'local', title: 'Alpha', workDir: '/home/me/tasks/Alpha', error: 'The directory is protected' } });
  await page.locator('#h5-task-delete-text').waitFor();
  g = await look(page, '#h5-task-dialog');
  assertFrame(g, `${size}: Delete`, { phone });
  assert.deepEqual(actions(g), ['h5-task-dialog-cancel:text:primary', 'h5-task-dialog-ok:text:error'], `${size}: Delete actions`);
  assert.ok(await page.locator('#h5-task-dialog-error.MuiAlert-root').isVisible(), `${size}: the error is an inline Alert`);
  await shot(page, `${phone ? 'p' : 'd'}-task-delete`);
  await set({ taskDialog: null });
  await page.locator('#h5-task-dialog').waitFor({ state: 'detached' });

  // Paste: a form at the top; Send is a text submit button after Cancel.
  await set({ pasteSheet: { open: true } });
  await page.locator('#h5-paste .MuiDialog-paper').waitFor({ state: 'visible' });
  g = await look(page, '#h5-paste');
  assertFrame(g, `${size}: Paste`, { phone });
  assert.deepEqual(actions(g), ['h5-paste-cancel:text:primary', 'h5-paste-send:text:primary'], `${size}: Paste actions`);
  assert.equal(await page.locator('#h5-paste-send').getAttribute('type'), 'submit');
  await page.keyboard.press('Escape');
  await page.locator('#h5-paste').waitFor({ state: 'detached' });

  // The uploaded link: a short title, the reason as body text, Close.
  await set({ retainUrl: 'https://bucket.example/a.png' });
  await page.locator('.h5-upload-overlay .MuiDialog-paper').waitFor({ state: 'visible' });
  g = await look(page, '.h5-upload-overlay');
  assertFrame(g, `${size}: uploaded link`, { phone });
  assert.equal(await page.locator('#h5-retain-title').textContent(), 'Uploaded link');
  await set({ retainUrl: null });
  await page.locator('.h5-upload-overlay').waitFor({ state: 'detached' });

  // Update: Close first, then Update now, both text buttons.
  await page.evaluate(() => window.H5UI.actions.openUpdate());
  await page.locator('#h5-update-now').waitFor();
  g = await look(page, '#h5-update-dialog');
  assertFrame(g, `${size}: Update`, { phone });
  assert.deepEqual(actions(g), ['h5-update-dismiss:text:primary', 'h5-update-now:text:primary'], `${size}: Update actions`);
  await shot(page, `${phone ? 'p' : 'd'}-update`);
  await page.keyboard.press('Escape');
  await page.locator('#h5-update-dialog .MuiDialog-paper').waitFor({ state: 'hidden' });

  // T-Attention: Reject (a small form: Enter rejects) and the delete confirmation of the edit view (a text button in the error colour).
  await page.evaluate(() => window.H5UI.actions.toggleAttention());
  await page.locator('.h5-attention-row[data-id="2"] .h5-attention-action[data-action="reject"]').waitFor();
  await press(page.locator('.h5-attention-row[data-id="2"] .h5-attention-action[data-action="reject"]'));
  await page.locator('#h5-attention-reject .MuiDialog-paper').waitFor({ state: 'visible' });
  g = await look(page, '#h5-attention-reject');
  assertFrame(g, `${size}: Reject`, { phone });
  assert.deepEqual(actions(g), ['h5-attention-reject-cancel:text:primary', 'h5-attention-reject-confirm:text:primary'], `${size}: Reject actions`);
  await page.locator('#h5-attention-reject-reason').fill('Missing tests');
  await page.locator('#h5-attention-reject-reason').press('Enter');
  await page.locator('#h5-attention-reject').waitFor({ state: 'detached' });
  assert.deepEqual(calls.filter(([method]) => method === 'PATCH').map(call => [call[1], call[2].activity]), [['/api/attention/2', { kind: 'note', text: 'Rejected: Missing tests' }]], `${size}: Enter rejects with the reason`);
  await press(page.locator('.h5-attention-row[data-id="1"] .h5-attention-open'));
  await page.locator('#h5-attention-edit .MuiDialog-paper').waitFor({ state: 'visible' });
  g = await look(page, '#h5-attention-edit');
  assertFrame(g, `${size}: Edit task`, { phone, fullScreen: phone });
  assert.deepEqual(actions(g), ['h5-attention-edit-delete:text:error', 'h5-attention-edit-cancel:text:primary', 'h5-attention-edit-save:contained:primary'], `${size}: Edit task actions`);
  await press(page.locator('#h5-attention-edit-delete'));
  await page.locator('#h5-attention-delete .MuiDialog-paper').waitFor({ state: 'visible' });
  g = await look(page, '#h5-attention-delete');
  assertFrame(g, `${size}: Delete this task`, { phone });
  assert.deepEqual(actions(g), ['h5-attention-delete-cancel:text:primary', 'h5-attention-delete-confirm:text:error'], `${size}: Delete this task actions`);
  await page.keyboard.press('Escape');
  await page.locator('#h5-attention-delete .MuiDialog-paper').waitFor({ state: 'hidden' });
  await page.keyboard.press('Escape');
  await page.locator('#h5-attention-edit').waitFor({ state: 'detached' });

  assert.deepEqual(errors, [], `${size}: no page errors`);
  await context.close();
  console.log(`  ${size}: ok`);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await run(browser, false);
    await run(browser, true);
    console.log('dialog pattern: ok');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
