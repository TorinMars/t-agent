// The two create dialogs of the task list, in real Chromium at phone size (390x844, touch; 320x568 for the narrow check) and computer size (1440x900,
// pointer, permanent sidebar), with the routes mocked:
// - New session: opened by the "+" of a task (the shown one, another one, a task of another service) and by "New session" in the empty terminal area. It
//   names the task (and its service), acts on that row's own task and service, Enter in the name field makes a terminal, each choice works (New Terminal,
//   Claude / Codex sessions with their sub-list and Back), Cancel, Escape, the back gesture and a tap beside it close it, busy and error are shown in it.
// - New task: opened by "New task"; "Create on", the working directory hint and check, busy and error, closes when made and opens the new task.
// Both stay usable with the on-screen keyboard up (a smaller fake visual viewport, as iOS), and keys typed while one is open do not go to the terminal.
// SCREENSHOTS=<dir> saves both dialogs at 390px.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const CHOICES = ['New Terminal', 'Claude session', 'Codex session'];
const LOCAL_TASKS = [{ id: 1, title: 'Alpha', status: 'doing' }, { id: 2, title: 'Beta', status: 'doing' }, { id: 3, title: 'Gamma', status: 'doing' }];
const REMOTE_TASKS = [{ id: 1, title: 'Remote one', status: 'doing' }]; // the same id as Alpha: the id alone does not say which task is meant
const SHORT = { timeout: 2000 };
const SHOTS = process.env.SCREENSHOTS || '';

async function openPage(browser, size) {
  const wide = size === 'PC';
  const viewport = wide ? { width: 1440, height: 900 } : size === 'narrow' ? { width: 320, height: 568 } : { width: 390, height: 844 };
  const context = await browser.newContext(wide ? { viewport } : { viewport, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.sent = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { window.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    // A visual viewport like iOS Safari's: the keyboard makes it shorter while the layout viewport (innerHeight) stays.
    const visual = new EventTarget();
    let keyboard = 0;
    Object.defineProperties(visual, {
      height: { get: () => innerHeight - keyboard }, width: { get: () => innerWidth }, offsetTop: { get: () => 0 }, offsetLeft: { get: () => 0 }, scale: { get: () => 1 },
    });
    Object.defineProperty(window, 'visualViewport', { value: visual, configurable: true });
    window.setKeyboard = height => { keyboard = height; visual.dispatchEvent(new Event('resize')); };
  });
  // posts: [path, body] of every POST that makes a terminal or a task. hold: a POST waits for `release(status, body)` (busy). failNext: the next POST answers this error.
  const server = { posts: [], hold: null, failNext: null, nextTask: 50 };
  const holdNext = () => {
    let release;
    const released = new Promise(resolve => { release = resolve; });
    server.hold = { seen: false, released, release: (status = 201, body = null) => release({ status, body }) };
    return server.hold;
  };
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const { pathname } = url;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
    if (pathname === '/auth/me') return json({ effective_work_dir: '/home/t/tasks' });
    if (pathname === '/api/remote-servers') return json([{ id: 7, name: 'VPS' }]);
    if (pathname === '/api/remote-servers/7/info') return json({ capabilities: ['terminal:control'] });
    if (/\/task-groups$/.test(pathname)) return json([{ key: 'doing', name: 'Doing', sort_order: 1 }]);
    const creates = /\/terminals$/.test(pathname) || pathname === '/api/tasks' || pathname === '/api/remote-servers/7/tasks';
    if (method === 'POST' && creates) {
      const body = route.request().postDataJSON();
      server.posts.push([pathname, body]);
      if (server.hold) {
        const held = server.hold;
        held.seen = true;
        const answer = await held.released;
        server.hold = null;
        if (answer.status >= 400) return json(answer.body, answer.status);
      }
      if (server.failNext) { const fail = server.failNext; server.failNext = null; return json(fail, 500); }
      if (pathname === '/api/tasks' || pathname === '/api/remote-servers/7/tasks') {
        const made = { id: (server.nextTask += 1), title: body.title, status: 'doing' };
        (pathname === '/api/tasks' ? LOCAL : REMOTE).push(made);
        return json(made, 201);
      }
      if (/\/terminals$/.test(pathname)) return json({ terminal_id: `fresh-${server.posts.length}`, title: body.title || 'Terminal 9', agent: body.agent || null }, 201);
    }
    if (pathname === '/api/tasks' && method === 'GET') return json(LOCAL);
    if (pathname === '/api/remote-servers/7/tasks' && method === 'GET') return json(REMOTE);
    const terminals = pathname.match(/^\/api(?:\/remote-servers\/7)?\/tasks\/(\d+)\/terminals$/);
    if (terminals && method === 'GET') {
      const id = Number(terminals[1]);
      if ((id === 3 && !pathname.includes('remote')) || id > 50) return json([]); // Gamma and new tasks have no terminal yet
      return json([{ terminal_id: 'default', title: 'Terminal 1' }, { terminal_id: `t${id}-2`, title: 'Terminal 2' }]);
    }
    if (/\/agent-sessions$/.test(pathname)) return json([{ id: 's1', title: 'Older session' }]);
    if (/\/terminal\/ack$/.test(pathname)) return json({ success: true });
    return json({ error: 'not mocked' }, 404);
  });
  const LOCAL = LOCAL_TASKS.map(item => ({ ...item }));
  const REMOTE = REMOTE_TASKS.map(item => ({ ...item }));
  await page.goto(`${ORIGIN}/h5`);

  const press = locator => (wide ? locator.click() : locator.tap());
  const item = title => page.locator('#h5-tasks .h5-task-item', { hasText: title });
  const add = title => page.locator(`#h5-tasks .h5-task-row:has(.h5-task-title:text-is("${title}")) .h5-task-add`);
  const list = label => page.locator(`#h5-tasks .h5-terminal-list[aria-label="${label}"]`);
  const dialog = page.locator('#h5-new-session');
  const choices = page.locator('#h5-new-session #h5-term-menu-actions button');
  const nameField = page.locator('#h5-new-name-input');
  const sheetOpen = () => page.locator('#h5-tasks').isVisible();
  const openSheet = async () => {
    if (!wide && !(await sheetOpen())) await page.locator('#h5-open-tasks').tap();
    await item('Alpha').waitFor();
    if (!wide) await page.waitForTimeout(350); // the sheet has finished sliding in
  };
  const sheetClosed = async () => { if (!wide) await page.locator('#h5-tasks').waitFor({ state: 'hidden' }); };
  const shown = title => page.waitForFunction(name => document.getElementById('h5-task-name').textContent === name, title);
  const sessionName = name => page.waitForFunction(text => document.getElementById('h5-session-name').textContent === text, name);
  const openDialog = async (title, want = CHOICES) => {
    await press(add(title));
    await choices.first().waitFor();
    await page.waitForTimeout(250); // the dialog has finished fading in
    assert.deepEqual(await choices.allTextContents(), want, `${size}: the choices`);
  };
  const gone = async text => { await dialog.waitFor({ state: 'detached', ...SHORT }).catch(() => assert.fail(`${size}: ${text}: the New session dialog is still open`)); };
  // Alpha is the selected task, with its sessions listed.
  await openSheet();
  await press(item('Alpha'));
  await press(list('Alpha').locator('.h5-terminal-main').first());
  await shown('Alpha');
  await sheetClosed();
  await openSheet();
  await list('Phone terminals').locator('.h5-terminal-row').nth(1).waitFor();
  return { context, page, server, holdNext, pageErrors, size, wide, press, item, add, list, dialog, choices, nameField, sheetOpen, openSheet, sheetClosed, shown, sessionName, openDialog, gone };
}

// The boxes of the dialog compared with the visible area, read in one step.
function layout(page, selector) {
  return page.evaluate(sel => {
    const box = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const paper = document.querySelector(`${sel} .MuiDialog-paper`);
    return {
      paper: box(paper),
      active: box(document.activeElement && document.activeElement.closest('.MuiInputBase-root')),
      activeId: document.activeElement && document.activeElement.id,
      buttons: [...paper.querySelectorAll('.MuiDialogActions-root button')].map(box),
      visible: window.visualViewport.height,
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  }, selector);
}
function assertUsable(g, label) {
  assert.ok(g.paper.top >= -0.5 && g.paper.bottom <= g.visible + 0.5, `${label}: the dialog is inside the visible area (${g.paper.top}-${g.paper.bottom}, visible ${g.visible})`);
  assert.ok(g.paper.left >= 0 && g.paper.right <= g.width, `${label}: inside the width (${g.paper.left}-${g.paper.right} of ${g.width})`);
  assert.ok(g.scrollWidth <= g.width, `${label}: no sideways scroll`);
  assert.ok(g.active && g.active.top >= g.paper.top - 0.5 && g.active.bottom <= g.visible + 0.5, `${label}: the focused field is in view (${JSON.stringify(g.active)}, visible ${g.visible})`);
  for (const button of g.buttons) assert.ok(button.top >= g.paper.top && button.bottom <= g.visible + 0.5, `${label}: the buttons are in view (${JSON.stringify(button)})`);
}

const CASES = [
  ['the "+" of the shown task: the dialog names it, focuses the name, Enter makes a named terminal', async t => {
    await t.openDialog('Alpha');
    assert.equal(await t.page.locator('#h5-new-session-title').textContent(), 'New session');
    assert.equal(await t.page.locator('#h5-new-session-task').textContent(), 'Alpha');
    assert.equal(await t.page.locator('#h5-new-session-service').count(), 0, 'no service for this machine');
    assert.equal(await t.page.locator('#h5-new-session[role="presentation"] [role="dialog"]').count(), 1, 'a modal dialog');
    assert.equal(await t.page.locator('#h5-tasks #h5-new-name-input, #h5-tasks #h5-term-menu-actions').count(), 0, 'nothing is drawn in the task list');
    assert.equal(await t.page.evaluate(() => document.activeElement && document.activeElement.id), 'h5-new-name-input', 'the name field has the focus, as in the other dialogs');
    for (const box of await t.choices.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))) assert.ok(box >= (t.wide ? 36 : 44) - 0.5, `a choice is ${box}px high`);
    await t.nameField.fill('Review');
    await t.nameField.press('Enter');
    await t.gone('after Enter');
    await t.sessionName('Review');
    assert.deepEqual(t.server.posts, [['/api/tasks/1/terminals', { title: 'Review' }]], 'one terminal in Alpha, with that name');
    await t.sheetClosed();
  }],
  ['the "+" of a task that is not shown acts on that task', async t => {
    await t.openDialog('Beta');
    assert.equal(await t.page.locator('#h5-new-session-task').textContent(), 'Beta');
    if (!t.wide) assert.equal(await t.sheetOpen(), true, 'the sheet stays open under the dialog');
    await t.press(t.choices.filter({ hasText: 'New Terminal' }));
    await t.gone('after New Terminal'); // the dialog closes once the terminal is made, so the request has been seen
    assert.deepEqual(t.server.posts, [['/api/tasks/2/terminals', {}]], 'the terminal is made in Beta, not in the task that was shown');
    await t.shown('Beta');
    await t.sheetClosed();
  }],
  ['a task of another service: its service is named, Claude sub-list, Back and an earlier session', async t => {
    await t.openDialog('Remote one');
    assert.equal(await t.page.locator('#h5-new-session-task').textContent(), 'Remote one');
    assert.equal(await t.page.locator('#h5-new-session-service').textContent(), 'VPS', 'the service of the task');
    await t.nameField.fill('Kept');
    await t.press(t.choices.filter({ hasText: 'Claude session' }));
    await t.choices.filter({ hasText: 'Older session' }).waitFor();
    assert.deepEqual(await t.choices.allTextContents(), ['New Claude session', 'Older session', 'Back'], 'the Claude list');
    assert.equal(await t.page.locator('#h5-new-session-sub').textContent(), 'Claude session', 'the sub-list is named');
    await t.press(t.choices.filter({ hasText: 'Back' }));
    await t.choices.filter({ hasText: 'New Terminal' }).waitFor();
    assert.equal(await t.nameField.inputValue(), 'Kept', 'the name stays while moving between the lists');
    await t.press(t.choices.filter({ hasText: 'Claude session' }));
    await t.press(t.choices.filter({ hasText: 'Older session' }));
    await t.gone('after an earlier session');
    await t.shown('Remote one');
    assert.deepEqual(t.server.posts, [['/api/remote-servers/7/tasks/1/terminals', { agent: 'claude', session_id: 's1', title: 'Kept' }]], 'on that service, resuming that session');
  }],
  ['Codex session: New Codex session, and Enter in its list runs it', async t => {
    await t.openDialog('Alpha');
    await t.press(t.choices.filter({ hasText: 'Codex session' }));
    await t.choices.filter({ hasText: 'New Codex session' }).waitFor();
    await t.press(t.choices.filter({ hasText: 'New Codex session' }));
    await t.gone('after New Codex session');
    await t.openSheet();
    await t.openDialog('Alpha');
    await t.press(t.choices.filter({ hasText: 'Codex session' }));
    await t.choices.filter({ hasText: 'New Codex session' }).waitFor();
    await t.nameField.fill('Fix');
    await t.nameField.press('Enter');
    await t.gone('after Enter in the Codex list');
    assert.deepEqual(t.server.posts, [['/api/tasks/1/terminals', { agent: 'codex' }], ['/api/tasks/1/terminals', { agent: 'codex', title: 'Fix' }]]);
  }],
  ['Cancel, Escape, the back gesture and a tap beside it close it; nothing is made and a new one starts empty', async t => {
    const sentBefore = await t.page.evaluate(() => window.sent.length);
    const url = t.page.url();
    await t.openDialog('Alpha');
    await t.nameField.fill('Abandoned');
    await t.press(t.page.locator('#h5-term-menu-cancel'));
    await t.gone('after Cancel');
    if (!t.wide) assert.equal(await t.sheetOpen(), true, 'Cancel leaves the sheet open');
    await t.openDialog('Alpha');
    assert.equal(await t.nameField.inputValue(), '', 'the abandoned name is not kept');
    await t.nameField.press('Escape');
    await t.gone('after Escape');
    if (!t.wide) assert.equal(await t.sheetOpen(), true, 'Escape leaves the sheet open');
    await t.openDialog('Alpha');
    await t.page.waitForTimeout(100); // back.mjs has pushed the entry of the dialog
    await t.page.goBack();
    await t.gone('after the back gesture');
    assert.equal(t.page.url(), url, 'the page stays');
    if (!t.wide) assert.equal(await t.sheetOpen(), true, 'the back gesture closes only the dialog, not the sheet under it');
    await t.openDialog('Alpha');
    if (t.wide) await t.page.mouse.click(1400, 20); else await t.page.touchscreen.tap(380, 10);
    await t.gone('after a tap beside it');
    assert.deepEqual(t.server.posts, [], 'nothing was made');
    assert.equal(await t.page.evaluate(n => window.sent.slice(n).some(data => data.includes('\x1b')), sentBefore), false, 'Escape is not sent to the terminal');
  }],
  ['busy while the terminal is made, an error is shown in the dialog, a second try works', async t => {
    await t.openDialog('Beta');
    const held = t.holdNext();
    await t.press(t.choices.filter({ hasText: 'New Terminal' }));
    await t.page.locator('#h5-new-session-busy').waitFor();
    assert.equal(await t.choices.first().isDisabled(), true, 'the choices are disabled');
    assert.equal(await t.page.locator('#h5-term-menu-cancel').isDisabled(), true, 'Cancel is disabled');
    await t.page.keyboard.press('Escape');
    await t.page.waitForTimeout(250);
    assert.equal(await t.dialog.count(), 1, 'Escape does not close a busy dialog');
    held.release(500, { error: 'NO_ROOM' });
    await t.page.locator('#h5-new-session-error', { hasText: 'Could not create the terminal: NO_ROOM' }).waitFor();
    assert.equal(await t.page.locator('#h5-new-session-busy').count(), 0, 'no longer busy');
    assert.equal(await t.choices.first().isDisabled(), false, 'the choices work again');
    if (!t.wide) assert.equal(await t.sheetOpen(), true, 'the sheet stays after a failure');
    await t.press(t.choices.filter({ hasText: 'New Terminal' }));
    await t.gone('after the second try');
    assert.deepEqual(t.server.posts, [['/api/tasks/2/terminals', {}], ['/api/tasks/2/terminals', {}]], 'both tries went to Beta');
    await t.sheetClosed();
  }],
  ['"New session" in the empty terminal area opens the dialog for the shown task', async t => {
    await t.press(t.item('Gamma'));
    await t.list('Gamma').waitFor();
    await t.press(t.page.locator('#h5-tasks .h5-task-row:has(.h5-task-title:text-is("Gamma")) .h5-task-add'));
    await t.choices.first().waitFor();
    await t.press(t.page.locator('#h5-term-menu-cancel'));
    await t.gone('after Cancel');
    await t.shown('Gamma');
    if (!t.wide) { await t.page.locator('#h5-close-tasks').tap(); await t.sheetClosed(); }
    await t.page.locator('#h5-empty-new').waitFor();
    await t.press(t.page.locator('#h5-empty-new'));
    await t.choices.first().waitFor();
    assert.equal(await t.page.locator('#h5-new-session-task').textContent(), 'Gamma');
    if (!t.wide) assert.equal(await t.sheetOpen(), false, 'the task sheet is not opened for it');
    await t.press(t.choices.filter({ hasText: 'New Terminal' }));
    await t.gone('after New Terminal');
    assert.deepEqual(t.server.posts, [['/api/tasks/3/terminals', {}]]);
    await t.page.locator('#h5-empty-new').waitFor({ state: 'detached' });
  }],
  ['keys typed while the dialog is open do not go to the terminal', async t => {
    await t.openDialog('Alpha');
    const before = await t.page.evaluate(() => window.sent.length);
    await t.page.locator('#h5-term-menu-cancel').focus();
    await t.page.keyboard.type('xy');
    await t.page.waitForTimeout(150);
    assert.equal(await t.page.evaluate(n => window.sent.slice(n).filter(data => /x|y/.test(data)).length, before), 0, 'nothing was typed into the terminal');
    assert.equal(await t.dialog.count(), 1, 'the dialog is still open');
  }, 'PC'],
  ['the keyboard up: the New session dialog stays in the visible area', async t => {
    await t.openDialog('Alpha');
    const keyboard = t.size === 'narrow' ? 253 : 336;
    await t.nameField.focus();
    await t.page.evaluate(height => window.setKeyboard(height), keyboard);
    await t.page.waitForTimeout(350);
    const g = await layout(t.page, '#h5-new-session');
    assertUsable(g, `${t.size} New session, keyboard up`);
    if (SHOTS && t.size === 'phone') await t.page.screenshot({ path: path.join(SHOTS, 'new-session-390-keyboard.png') });
    await t.page.evaluate(() => window.setKeyboard(0));
    await t.page.waitForTimeout(250);
    if (SHOTS && t.size === 'phone') await t.page.screenshot({ path: path.join(SHOTS, 'new-session-390.png') });
    await t.nameField.fill('Up');
    await t.nameField.press('Enter');
    await t.gone('after Enter');
    assert.deepEqual(t.server.posts, [['/api/tasks/1/terminals', { title: 'Up' }]]);
  }, ['phone', 'narrow']],

  // ── New task ──
  ['New task: "Create on", the hint, the path check; created on the chosen service and opened', async t => {
    const form = t.page.locator('#h5-new-task-dialog');
    await t.press(t.page.locator('#h5-add-task'));
    await t.page.locator('#h5-new-task-title').waitFor();
    await t.page.waitForTimeout(250);
    assert.equal(await t.page.locator('#h5-new-task-title-label').textContent(), 'New task');
    assert.equal(await t.page.locator('#h5-tasks #h5-new-task').count(), 0, 'the form is not in the task list');
    assert.equal(await t.page.evaluate(() => document.activeElement && document.activeElement.id), 'h5-new-task-title', 'the title has the focus');
    assert.deepEqual(await t.page.locator('#h5-new-task-on option').allTextContents(), ['This machine', 'VPS'], 'the online services');
    assert.equal(await t.page.locator('#h5-new-task-on').inputValue(), 'local', 'this machine by default');
    await t.page.fill('#h5-new-task-title', 'My task');
    await t.page.waitForFunction(() => document.getElementById('h5-new-task-dir').placeholder === '/home/t/tasks/My-task');
    assert.match(await t.page.locator('#h5-new-task-dir-help').textContent(), /Leave empty to use the default: \/home\/t\/tasks\/My-task/);
    await t.page.fill('#h5-new-task-dir', 'not/absolute');
    await t.press(t.page.locator('#h5-new-task-create'));
    await t.page.locator('#h5-new-task-dir-help', { hasText: 'Enter an absolute path' }).waitFor();
    assert.deepEqual(t.server.posts, [], 'a relative path is not sent');
    await t.page.fill('#h5-new-task-dir', '');
    await t.page.locator('#h5-new-task-on').selectOption('remote:7');
    assert.match(await t.page.locator('#h5-new-task-dir-help').textContent(), /Absolute path on the remote engine/, 'the hint follows the choice');
    await t.page.locator('#h5-new-task-title').press('Enter');
    await form.waitFor({ state: 'detached', ...SHORT });
    await t.shown('My task');
    assert.deepEqual(t.server.posts, [['/api/remote-servers/7/tasks', { title: 'My task' }]], 'made on the chosen service, with the default folder');
    await t.sheetClosed();
    await t.page.locator('#h5-empty-new').waitFor(); // a new task has no terminal
  }],
  ['New task: busy, an error keeps the dialog, Cancel / Escape / back close it and it opens empty', async t => {
    const form = t.page.locator('#h5-new-task-dialog');
    await t.press(t.page.locator('#h5-add-task'));
    await t.page.fill('#h5-new-task-title', 'Second');
    await t.page.fill('#h5-new-task-dir', '/data/second');
    const held = t.holdNext();
    await t.press(t.page.locator('#h5-new-task-create'));
    while (!held.seen) await t.page.waitForTimeout(20);
    await t.page.waitForFunction(() => document.getElementById('h5-new-task-create').disabled);
    assert.equal(await t.page.locator('#h5-new-task-cancel').isDisabled(), true, 'Cancel is disabled while busy');
    await t.page.keyboard.press('Escape');
    await t.page.waitForTimeout(250);
    assert.equal(await form.count(), 1, 'Escape does not close a busy dialog');
    held.release(500, { error: 'DISK_FULL' });
    await t.page.locator('#h5-new-task-dir-help', { hasText: 'The task was not created. Check the working directory.' }).waitFor();
    await t.page.locator('[role="status"]', { hasText: 'Could not create the task: DISK_FULL' }).first().waitFor();
    assert.equal(await t.page.locator('#h5-new-task-title').inputValue(), 'Second', 'what was typed stays');
    assert.equal(await t.page.locator('#h5-new-task-create').isDisabled(), false, 'no longer busy');
    await t.press(t.page.locator('#h5-new-task-cancel'));
    await form.waitFor({ state: 'detached', ...SHORT });
    if (!t.wide) assert.equal(await t.sheetOpen(), true, 'the sheet stays');
    await t.press(t.page.locator('#h5-add-task'));
    await t.page.locator('#h5-new-task-title').waitFor();
    assert.equal(await t.page.locator('#h5-new-task-title').inputValue(), '', 'a new dialog starts empty');
    assert.equal(await t.page.locator('#h5-new-task-dir').inputValue(), '');
    await t.page.keyboard.press('Escape');
    await form.waitFor({ state: 'detached', ...SHORT });
    await t.press(t.page.locator('#h5-add-task'));
    await t.page.locator('#h5-new-task-title').waitFor();
    await t.page.waitForTimeout(100);
    await t.page.goBack();
    await form.waitFor({ state: 'detached', ...SHORT });
    if (!t.wide) assert.equal(await t.sheetOpen(), true, 'back closes only the dialog');
    assert.equal(t.server.posts.length, 1, 'only the failed try was sent');
  }],
  ['the keyboard up: the New task dialog stays in the visible area', async t => {
    await t.press(t.page.locator('#h5-add-task'));
    await t.page.locator('#h5-new-task-title').waitFor();
    await t.page.waitForTimeout(250);
    await t.page.locator('#h5-new-task-title').focus();
    await t.page.evaluate(height => window.setKeyboard(height), t.size === 'narrow' ? 253 : 336);
    await t.page.waitForTimeout(350);
    assertUsable(await layout(t.page, '#h5-new-task-dialog'), `${t.size} New task, keyboard up (title)`);
    await t.page.locator('#h5-new-task-dir').focus();
    await t.page.waitForTimeout(350);
    assertUsable(await layout(t.page, '#h5-new-task-dialog'), `${t.size} New task, keyboard up (working directory)`);
    if (SHOTS && t.size === 'phone') await t.page.screenshot({ path: path.join(SHOTS, 'new-task-390-keyboard.png') });
    await t.page.evaluate(() => window.setKeyboard(0));
    await t.page.locator('#h5-new-task-title').focus();
    await t.page.waitForTimeout(250);
    if (SHOTS && t.size === 'phone') await t.page.screenshot({ path: path.join(SHOTS, 'new-task-390.png') });
  }, ['phone', 'narrow']],
];

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const failures = [];
  try {
    for (const size of ['phone', 'PC', 'narrow']) {
      for (const [name, run, only] of CASES) {
        const sizes = only ? [].concat(only) : ['phone', 'PC'];
        if (!sizes.includes(size) || (process.env.ONLY && !name.includes(process.env.ONLY))) continue; // ONLY=<part of a case name> runs those cases
        let t;
        try {
          t = await openPage(browser, size);
          await run(t);
          assert.deepEqual(t.pageErrors, [], 'no page errors');
          console.log(`  ok   ${size}: ${name}`);
        } catch (error) {
          failures.push(`${size}: ${name}`);
          console.log(`  FAIL ${size}: ${name}\n       ${String(error.message).split('\n')[0]}\n       ${(String(error.stack).split('\n').find(line => line.includes('create-dialogs-browser')) || '').trim()}`);
        } finally {
          if (t) await t.context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  if (failures.length) { console.error(`${failures.length} case(s) failed`); process.exit(1); }
  console.log('The New session and New task dialogs work from every entry point (phone, PC, 320px).');
})().catch(error => { console.error(error); process.exit(1); });
