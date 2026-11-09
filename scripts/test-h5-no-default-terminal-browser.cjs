// A new task has no terminal: the page at `/` with the real task routes, the real WebSocket handler and real shells, in real Chromium at computer and phone size.
// Opening or reloading the task (also with a remembered terminal that does not exist) starts no PTY; the terminal area says so and has a button that opens the
// Session list of the task; New Terminal there creates one and attaches. Input controls do nothing harmful with no terminal. Deleting the last terminal goes back to the
// empty state. A task from before this change still opens on its `default` terminal.
// SHOT_DIR=<dir> saves a screenshot of the empty state there.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const express = require('express');
const { WebSocketServer } = require('ws');
const root = path.resolve(__dirname, '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h5-no-default-terminal-')));
process.env.T_AGENT_DATA_DIR = path.join(scratch, 'data');
process.env.TASKS_BASE_DIR = path.join(scratch, 'tasks');
const auth = require.resolve('../middleware/auth');
require.cache[auth] = { id: auth, filename: auth, loaded: true, exports: (req, res, next) => { req.session = { user: { login: 'owner' } }; next(); } };

// Every PTY the server starts, and what it prints.
const pty = require('node-pty');
const realSpawn = pty.spawn;
const shells = [];
pty.spawn = (...args) => {
  const shell = realSpawn(...args);
  const entry = { output: '' };
  shells.push(entry);
  shell.onData(data => { entry.output += data; });
  return shell;
};

const db = require('../db');
const terminal = require('../routes/terminal');
const { asOlderTask } = require('../test-support/older-tasks');

const app = express();
app.use(express.json({ limit: '32mb' }));
app.use('/api/tasks', require('../routes/tasks'));
app.use('/api/task-groups', require('../routes/task-groups'));
app.get('/api/remote-servers', (req, res) => res.json([]));
app.get('/auth/me', (req, res) => res.json({ work_dir: null, effective_work_dir: process.env.TASKS_BASE_DIR }));
app.get('/api/system/version', (req, res) => res.json({ app_version: '0.0.0', boot_id: 'b1' }));
app.all('/api/system/*', (req, res) => res.json({ status: 'current', is_update_admin: false }));
app.get('/api/agent-chat/summary', (req, res) => res.json({ running: 0, queued: 0, submitted: 0 }));
app.get('/', (req, res) => res.type('html').sendFile(path.join(root, 'public/h5.html')));
app.use(express.static(path.join(root, 'public'), { index: false }));
app.use((req, res) => res.status(404).json({ error: 'not mocked' }));

const WAIT = { timeout: 15000 };
let base;
async function newTask(title) {
  const response = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
  assert.equal(response.status, 201);
  return response.json();
}
const listed = async id => (await (await fetch(`${base}/api/tasks/${id}/terminals`)).json()).map(row => row.terminal_id);

async function openPage(browser, wide) {
  const context = await browser.newContext(wide ? { viewport: { width: 1440, height: 900 } } : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  const sockets = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => { if (socket.url().includes('/terminal/ws')) sockets.push(socket.url()); });
  page.on('dialog', dialog => dialog.accept());
  return { context, page, errors, sockets };
}
// A tap on a task opens its list of sessions; the first row of that list goes there.
async function openTask(page, title) {
  await page.locator('.h5-task-item', { hasText: title }).first().click();
  await page.locator(`#h5-tasks .h5-terminal-list[aria-label="${title}"] .h5-terminal-main`).first().click();
}
const empty = page => page.locator('#h5-empty', { hasText: 'This task has no terminal yet' }).waitFor(WAIT);
const pointerOf = (page, id) => page.evaluate(key => localStorage.getItem(key), `h5-terminal:local:${id}`);
const settle = page => page.waitForTimeout(400); // a socket or a spawn that should not happen would have shown by now

async function scenario(browser, wide) {
  const label = wide ? 'computer' : 'phone';
  const { context, page, errors, sockets } = await openPage(browser, wide);
  const task = await newTask(`Fresh ${label}`);
  const spawned = shells.length;

  await page.goto(`${base}/`);
  await openTask(page, `Fresh ${label}`); // the row of a task with no terminal says "Open this task"
  await empty(page);
  await page.locator('#h5-empty-new').waitFor(WAIT);
  await settle(page);
  if (process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, `no-terminal-${label}.png`) });
  assert.equal(await page.locator('.h5-xterm').count(), 0, `${label}: no terminal view`);
  assert.deepEqual(sockets, [], `${label}: no socket on open`);
  assert.equal(shells.length, spawned, `${label}: no PTY on open`);
  assert.deepEqual(await listed(task.id), [], `${label}: nothing listed`);

  await page.reload();
  await empty(page);
  await settle(page);
  assert.deepEqual(sockets, [], `${label}: no socket on reload`);
  assert.equal(shells.length, spawned, `${label}: no PTY on reload`);

  // A remembered terminal that does not exist (`default` of a stale tab, an id from a link): refused, no spawn, and forgotten.
  for (const ghost of ['default', 'ghost-terminal']) {
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [`h5-terminal:local:${task.id}`, ghost]);
    sockets.length = 0;
    await page.reload();
    await empty(page);
    await settle(page);
    assert.ok(sockets.length <= 1, `${label}: at most the early socket for ${ghost}`);
    assert.equal(shells.length, spawned, `${label}: no PTY for a remembered ${ghost}`);
    assert.equal(await pointerOf(page, task.id), null, `${label}: the pointer to ${ghost} is forgotten`);
    assert.deepEqual(await listed(task.id), [], `${label}: ${ghost} did not appear`);
  }
  sockets.length = 0;

  // The controls that act on a terminal: nothing throws, nothing is sent. (A computer has no key row.)
  if (!wide) {
    const keys = page.locator('#h5-keys button');
    for (let i = 0, n = await keys.count(); i < n; i += 1) await keys.nth(i).click({ force: true, timeout: 3000 }).catch(() => {});
    await page.locator('#h5-translate-input').focus().catch(() => {});
  }
  await page.locator('#h5-translate-input').fill('hello').catch(() => {});
  await page.locator('#h5-translate-input').press('Control+Enter').catch(() => {});
  await page.keyboard.type('x');
  await settle(page);
  assert.deepEqual(errors, [], `${label}: no error from the controls`);
  assert.equal(shells.length, spawned, `${label}: the controls spawn nothing`);
  await page.locator('#h5-translate-input').fill('').catch(() => {});

  // The empty state opens the Session list of the task, which creates the first terminal.
  await page.locator('#h5-empty-new').click();
  await page.locator('#h5-new-session').waitFor(WAIT);
  assert.deepEqual(await page.locator('#h5-term-menu-actions button').allTextContents(), ['New Terminal', 'Claude session', 'Codex session'], `${label}: the existing panel`);
  await page.locator('#h5-term-menu-actions button', { hasText: 'New Terminal' }).click();
  await page.locator('.h5-xterm').first().waitFor(WAIT);
  await page.waitForFunction(() => !document.querySelector('#h5-empty'), null, WAIT);
  const ids = await listed(task.id);
  assert.equal(ids.length, 1, `${label}: one terminal`);
  assert.notEqual(ids[0], 'default');
  for (let i = 0; i < 100 && shells.length === spawned; i += 1) await page.waitForTimeout(100);
  assert.equal(shells.length, spawned + 1, `${label}: one PTY`);
  assert.equal(sockets.filter(url => url.includes(ids[0])).length, 1, `${label}: attached`);
  assert.equal(await pointerOf(page, task.id), ids[0], `${label}: remembered`);
  const shell = shells.at(-1);
  await page.locator('.h5-xterm .xterm-helper-textarea').first().focus();
  await page.waitForTimeout(800); // the shell's prompt
  for (let i = 0; i < 100 && !shell.output.length; i += 1) await page.waitForTimeout(100);
  assert.ok(shell.output.length > 0, `${label}: the shell prints to the attached terminal`);

  // Delete the last terminal: back to the empty state, no new shell, also after a reload.
  if (!wide) await page.locator('#h5-open-tasks').click();
  const row = page.locator('#h5-tasks .h5-terminal-row').first();
  await row.locator('button').last().click();
  await page.locator('button, [role="menuitem"]', { hasText: /^Delete$/ }).first().click();
  await empty(page);
  await page.locator('#h5-empty-new').waitFor(WAIT);
  await settle(page);
  assert.deepEqual(await listed(task.id), [], `${label}: the last terminal is gone`);
  assert.equal(shells.length, spawned + 1, `${label}: no shell replaces it`);
  assert.equal(await pointerOf(page, task.id), null, `${label}: the pointer is forgotten`);
  sockets.length = 0;
  await page.reload();
  await empty(page);
  await settle(page);
  assert.deepEqual(sockets, [], `${label}: no socket on reload after the delete`);
  assert.equal(shells.length, spawned + 1, `${label}: no PTY on reload after the delete`);

  // A task from before this change is not touched: it opens on its default terminal.
  const older = asOlderTask(db, await newTask(`Older ${label}`));
  await page.reload();
  await empty(page);
  if (!wide) await page.locator('#h5-open-tasks').click();
  await openTask(page, `Older ${label}`);
  await page.locator('.h5-xterm').first().waitFor(WAIT);
  for (let i = 0; i < 100 && shells.length === spawned + 1; i += 1) await page.waitForTimeout(100);
  assert.equal(shells.length, spawned + 2, `${label}: the older task's default terminal starts`);
  assert.ok(sockets.some(url => url.includes(`taskId=${older.id}`) && url.includes('terminalId=default')), `${label}: attached to default`);

  assert.deepEqual(errors, [], `${label}: no page errors`);
  await context.close();
  terminal.closeTaskTerminals(task.id);
  terminal.closeTaskTerminals(older.id);
  console.log(`ok - ${label}`);
}

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => terminal.handleWs(ws, req, { login: 'owner' }));
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  let failed = false;
  try {
    await scenario(browser, true);
    await scenario(browser, false);
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    await browser.close();
    wss.close();
    server.closeAllConnections?.();
    server.close();
    db.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
})();
