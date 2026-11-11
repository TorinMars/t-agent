// The session name fields of the task list, in real Chromium at phone size (390x844, touch) and computer size (1440x900, pointer, permanent sidebar):
// the "+" of a task opens the New session dialog (with its optional name field), which stays above the iPhone keyboard, and the rename field takes the place
// of the row being renamed, inside the sidebar and inside the visible area, also with the iPhone keyboard open (a smaller visual viewport). Enter saves, Escape / Cancel / leaving the rename field cancel. A session of a task that is not selected has the same "⋯" and renames
// that session of that task, on this machine and on a remote Engine, without leaving the task and terminal that are shown.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const KEYBOARD = 336; // the height of an iPhone keyboard at 390px
const tasks = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, title: `Task ${i + 1}`, status: 'doing' }));
const pageErrors = [];

async function openPage(browser, wide, remote = false) {
  const context = await browser.newContext(wide ? { viewport: { width: 1440, height: 900 } } : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  const requests = []; // [method, path, body] of the terminal writes
  await page.addInitScript(() => {
    window.sent = [];
    window.sockets = 0;
    window.WebSocket = class {
      constructor(url) { window.sockets += 1; this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { window.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    // A visual viewport like iOS Safari's: the keyboard makes it shorter while the layout viewport (innerHeight) stays.
    const viewport = new EventTarget();
    let keyboard = 0;
    Object.defineProperties(viewport, {
      height: { get: () => innerHeight - keyboard }, width: { get: () => innerWidth }, offsetTop: { get: () => 0 }, offsetLeft: { get: () => 0 }, scale: { get: () => 1 },
    });
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
    window.setKeyboard = height => { keyboard = height; viewport.dispatchEvent(new Event('resize')); };
  });
  // What the server keeps: the names given by a rename ("<task>/<terminal or chat id>"), so a list read later shows them.
  const names = new Map();
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    if (url.pathname === '/api/remote-servers') return json(remote ? [{ id: 7, name: 'VPS' }] : []);
    if (url.pathname === '/api/remote-servers/7/info') return json({ capabilities: ['agent-chat:manage', 'terminal:control'] });
    if (url.pathname === '/api/remote-servers/7/tasks' && method === 'GET') return json([{ id: 9, title: 'Remote 9', status: 'doing' }, { id: 10, title: 'Remote 10', status: 'doing' }]);
    if (url.pathname === '/api/remote-servers/7/task-groups') return json([{ key: 'doing', name: 'Doing', sort_order: 1 }]);
    if (url.pathname === '/api/tasks' && method === 'GET') return json(tasks);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'Doing', sort_order: 1 }]);
    // Every task has a terminal `default`, as on the real server: the id alone does not say which row is renamed.
    const list = url.pathname.match(/^\/api(?:\/remote-servers\/7)?\/tasks\/(\d+)\/terminals$/);
    const listTask = list && list[1];
    const titled = (id, title) => names.get(`${listTask}/${id}`) || title;
    if (list && method === 'GET') return json(Array.from({ length: 4 }, (_, i) => { const id = i ? `t${listTask}-${i + 1}` : 'default'; return { terminal_id: id, title: titled(id, `Terminal ${i + 1}`) }; }));
    if (list && method === 'POST') { const body = route.request().postDataJSON(); requests.push([method, url.pathname, body]); return json({ terminal_id: 'fresh', title: body.title || 'Terminal 5' }, 201); }
    const renamed = url.pathname.match(/^\/api(?:\/remote-servers\/7)?\/tasks\/(\d+)\/(?:terminals|agent\/conversations)\/([^/]+)$/);
    if (renamed && method === 'PATCH') { const body = route.request().postDataJSON(); requests.push([method, url.pathname, body]); names.set(`${renamed[1]}/${renamed[2]}`, body.title); return json({ title: body.title }); }
    const chatsOf = url.pathname.match(/^\/api(?:\/remote-servers\/7)?\/tasks\/(\d+)\/agent\/conversations$/);
    if (chatsOf && method === 'GET') return json(chatsOf[1] === '3' || chatsOf[1] === '10' ? [{ id: 'c1', agent: 'claude', title: names.get(`${chatsOf[1]}/c1`) || 'Chat 1', running: false, opened: { web: null, h5: null } }] : []);
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  return { context, page, requests };
}

// The boxes that the checks compare, read in one step (the list re-renders often).
function geometry(page, { field, task }) {
  return page.evaluate(([field, task]) => {
    const box = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height }; };
    const input = document.querySelector(field);
    return {
      field: box(input && input.closest('.MuiInputBase-root')),
      form: box(input && input.closest('form')),
      row: box(task ? [...document.querySelectorAll('#h5-tasks .h5-task-row')].find(node => node.querySelector('.h5-task-title').textContent === task) : null),
      sessionRow: box(document.querySelector('#h5-tasks .h5-terminal-row')),
      drawer: box(document.querySelector('#h5-tasks.h5-sheet-panel, #h5-tasks .h5-sheet-panel')),
      list: box(document.querySelector('#h5-task-list')),
      visible: window.visualViewport.height,
      focused: Boolean(input) && document.activeElement === input,
    };
  }, [field, task]);
}

function assertInside(g, label) {
  assert.ok(g.field, `${label}: the field is shown`);
  assert.ok(g.field.left >= g.drawer.left - 0.5 && g.field.right <= g.drawer.right + 0.5, `${label}: inside the sidebar (${JSON.stringify([g.field, g.drawer])})`);
  assert.ok(g.form.top >= g.list.top - 0.5 && g.form.bottom <= g.list.bottom + 0.5, `${label}: inside the visible part of the task list (${JSON.stringify([g.form, g.list])})`);
  assert.ok(g.form.bottom <= g.visible + 0.5, `${label}: above the bottom of the visible area (${g.form.bottom} > ${g.visible})`);
}

// A session of a task that is not selected: the row has the same "⋯"; the rename reaches that session of that task and nothing else moves.
async function checkOtherTask({ page, requests, size, press, list, shown, base, task }) {
  const rows = page.locator(`#h5-tasks .h5-terminal-list[aria-label="${list}"] .h5-terminal-row`);
  await rows.nth(3).waitFor();
  const state = () => page.evaluate(() => ({
    task: document.getElementById('h5-task-name').textContent,
    session: document.getElementById('h5-session-name').textContent,
    terminal: document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId,
    sockets: window.sockets,
    sent: window.sent.length,
  }));
  const before = await state();
  assert.equal(before.task, shown, `${size}: the task shown`);
  const buttons = await rows.locator('.h5-terminal-more').evaluateAll(nodes => nodes.map(node => [node.getAttribute('aria-label'), node.getAttribute('title')]));
  assert.equal(buttons.length, await rows.count(), `${size}: every session of the other task has the button`);
  for (const [label, title] of buttons) assert.ok(label && label === title, `${size}: aria-label and title agree (${label} / ${title})`);
  const writes = requests.length;
  const askRename = async index => {
    await press(rows.nth(index).locator('.h5-terminal-more'));
    await page.locator('#h5-session-menu [role="menuitem"]', { hasText: 'Rename' }).waitFor();
    assert.deepEqual(await page.locator('#h5-session-menu [role="menuitem"]').allTextContents(), index === 4 ? ['Rename', 'Open', 'Delete'] : ['Rename', 'Open', 'Restart in the working directory', 'Delete'], `${size}: what can be done from another task`);
    await press(page.locator('#h5-session-menu [role="menuitem"]', { hasText: 'Rename' }));
    await page.locator('#h5-term-rename-input').waitFor();
    await page.locator('#h5-session-menu').waitFor({ state: 'detached' });
    await page.waitForTimeout(300);
  };
  // The field is under this task only, although the shown task has a terminal with the same id. Escape cancels.
  await askRename(0);
  assert.equal(await page.locator('#h5-term-rename').count(), 1, `${size}: one field`);
  assert.equal(await page.locator('#h5-term-rename').evaluate(form => form.closest('.h5-terminal-list').getAttribute('aria-label')), list, `${size}: in the list of the row's own task`);
  assert.equal(await page.locator('#h5-term-rename-input').inputValue(), 'Terminal 1');
  await page.locator('#h5-term-rename-input').press('Escape');
  await page.locator('#h5-term-rename').waitFor({ state: 'detached' });
  assert.equal(requests.length, writes, `${size}: Escape saves nothing`);
  assert.equal(await rows.nth(0).locator('.h5-terminal-name').textContent(), 'Terminal 1', `${size}: the row is back`);
  // Leaving the field cancels too.
  await askRename(0);
  await press(page.locator('#h5-tasks-title'));
  await page.locator('#h5-term-rename').waitFor({ state: 'detached' });
  assert.equal(requests.length, writes, `${size}: leaving the field saves nothing`);
  // Enter saves that terminal of that task.
  await askRename(0);
  await page.locator('#h5-term-rename-input').fill('Docs shell');
  await page.locator('#h5-term-rename-input').press('Enter');
  await page.locator('#h5-term-rename').waitFor({ state: 'detached' });
  await rows.nth(0).locator('.h5-terminal-name', { hasText: 'Docs shell' }).waitFor();
  assert.deepEqual(requests.slice(writes), [['PATCH', `${base}/${task}/terminals/default`, { title: 'Docs shell' }]], `${size}: the right task and terminal, once`);
  assert.equal(await page.locator(`#h5-tasks .h5-terminal-list[aria-label="Phone terminals"] .h5-terminal-name`, { hasText: 'Docs shell' }).count(), 0, `${size}: the terminal with the same id in the shown task keeps its name`);
  assert.deepEqual(await state(), before, `${size}: the task and terminal shown are not touched, nothing is opened`);
  if (size.startsWith('phone')) assert.equal(await page.locator('#h5-tasks').isVisible(), true, `${size}: the sheet stays open`);
  // The names stay after the list is read again.
  const item = page.locator('.h5-task-item', { hasText: list });
  await press(item); // close
  await rows.first().waitFor({ state: 'detached' });
  await press(item); // open: read again
  await rows.nth(0).locator('.h5-terminal-name', { hasText: 'Docs shell' }).waitFor();
  assert.deepEqual(await state(), before, `${size}: reading the list again changes nothing shown`);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const wide of [false, true]) {
      const size = wide ? 'PC' : 'phone';
      const { context, page, requests } = await openPage(browser, wide);
      const press = locator => (wide ? locator.click() : locator.tap());
      const taskRow = title => `#h5-tasks .h5-task-row:has(.h5-task-title:text-is("${title}"))`;
      const openSheet = async () => { if (!wide && !(await page.locator('#h5-tasks').isVisible())) await page.locator('#h5-open-tasks').tap(); await page.locator('#h5-tasks .h5-task-item').first().waitFor(); };
      await openSheet();
      // Task 6 (low in the list) is opened, then the sheet is opened again.
      await press(page.locator('.h5-task-item', { hasText: 'Task 6' }));
      await press(page.locator('#h5-tasks .h5-terminal-list[aria-label="Task 6"] .h5-terminal-main').first());
      if (!wide) await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
      await openSheet();
      await page.locator('#h5-tasks .h5-terminal-list[aria-label="Phone terminals"] .h5-terminal-row').nth(3).waitFor();

      // ── The "+" of the task: the New session dialog (not a sheet at the bottom of the screen, nothing drawn in the list) ──
      const dialogBox = () => page.evaluate(() => {
        const box = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height }; };
        const input = document.getElementById('h5-new-name-input');
        return { paper: box(document.querySelector('#h5-new-session .MuiDialog-paper')), field: box(input.closest('.MuiInputBase-root')), visible: window.visualViewport.height, focused: document.activeElement === input };
      });
      await press(page.locator(`${taskRow('Task 6')} .h5-task-add`));
      await page.locator('#h5-new-session').waitFor();
      await page.waitForTimeout(300);
      assert.equal(await page.locator('#h5-term-menu .h5-menu-panel').isVisible().catch(() => false), false, `${size}: no sheet from the bottom`);
      assert.equal(await page.locator('#h5-tasks #h5-new-name-input').count(), 0, `${size}: nothing is drawn in the task list`);
      assert.deepEqual(await page.locator('#h5-new-session #h5-term-menu-actions button').allTextContents(), ['New Terminal', 'Claude session', 'Codex session']);
      assert.equal(await page.locator('#h5-new-session-task').textContent(), 'Task 6', `${size}: the dialog names its task`);
      let d = await dialogBox();
      assert.ok(d.field.height >= (wide ? 36 : 44) - 0.5, `${size}: the field is ${d.field.height}px high`);
      assert.equal(d.focused, true, `${size}: the name field takes the focus, as in the other dialogs`);
      assert.ok(d.field.top > d.paper.top && d.field.bottom < d.paper.bottom, `${size}: the field is in the dialog`);

      if (!wide) {
        // The iPhone keyboard: the dialog moves into the visible area above it.
        await page.evaluate(height => window.setKeyboard(height), KEYBOARD);
        await page.waitForTimeout(300);
        d = await dialogBox();
        assert.ok(d.paper.top >= 0 && d.paper.bottom <= d.visible + 0.5, `the dialog stays above the keyboard (${d.paper.top}-${d.paper.bottom}, visible ${d.visible})`);
        assert.ok(d.field.bottom <= d.visible, 'the field is above the keyboard');
        await page.evaluate(() => window.setKeyboard(0));
        // Cancel closes the dialog; the sheet stays.
        await page.locator('#h5-term-menu-cancel').tap();
        await page.locator('#h5-new-session').waitFor({ state: 'detached' });
        assert.equal(await page.locator('#h5-tasks').isVisible(), true, 'the sheet stays open');
        // The "+" of a task that is not open: the sheet stays under the dialog, which names that task.
        await page.locator(`${taskRow('Task 2')} .h5-task-add`).tap();
        await page.locator('#h5-new-session').waitFor();
        await page.waitForTimeout(300);
        assert.equal(await page.locator('#h5-tasks').isVisible(), true, 'the sheet stays open for the "+" of another task');
        assert.equal(await page.locator('#h5-new-session-task').textContent(), 'Task 2', 'the dialog names Task 2');
        await page.locator('#h5-term-menu-cancel').tap();
        await page.locator('#h5-new-session').waitFor({ state: 'detached' });
        // Back to Task 6 for the rename checks.
        await page.locator('.h5-task-item', { hasText: 'Task 6' }).tap(); // close
        await page.locator('.h5-task-item', { hasText: 'Task 6' }).tap(); // open
        await page.locator('#h5-tasks .h5-terminal-list[aria-label="Task 6"] .h5-terminal-main').first().tap();
        await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
        await openSheet();
      } else {
        // Escape closes the dialog and is not passed on to the terminal; Enter in the field runs New Terminal with the name.
        const before = await page.evaluate(() => window.sent.length);
        await page.locator('#h5-new-name-input').press('Escape');
        await page.locator('#h5-new-session').waitFor({ state: 'detached' });
        assert.equal(await page.evaluate(n => window.sent.slice(n).some(data => data.includes('\x1b')), before), false, 'Escape is not sent to the terminal');
        await page.locator(`${taskRow('Task 6')} .h5-task-add`).click();
        await page.locator('#h5-new-name-input').fill('Review');
        await page.locator('#h5-new-name-input').press('Enter');
        await page.locator('#h5-new-session').waitFor({ state: 'detached' });
        assert.deepEqual(requests.at(-1), ['POST', '/api/tasks/6/terminals', { title: 'Review' }]);
      }

      // ── Rename: the field takes the place of the row ──
      const rows = page.locator('#h5-tasks .h5-terminal-list[aria-label="Phone terminals"] .h5-terminal-row');
      await rows.nth(1).waitFor();
      await page.waitForTimeout(400); // the list settles (session counts, sheet slide)
      const rowBox = await rows.nth(1).boundingBox();
      await press(rows.nth(1).locator('.h5-terminal-more'));
      await press(page.locator('#h5-session-menu [role="menuitem"]', { hasText: 'Rename' }));
      await page.locator('#h5-term-rename').waitFor();
      await page.locator('#h5-session-menu').waitFor({ state: 'detached' });
      await page.waitForTimeout(300);
      let g = await geometry(page, { field: '#h5-term-rename-input' });
      assertInside(g, `${size} rename`);
      const above = await rows.nth(0).boundingBox(); // the row before it stays where it is
      assert.ok(Math.abs(g.form.top - (above.y + above.height)) <= 2, `${size}: the rename field is in place of the row, right under the row before it (${above.y + above.height} -> ${g.form.top})`);
      assert.ok(Math.abs(g.form.left - rowBox.x) <= 1 && Math.abs(g.form.right - (rowBox.x + rowBox.width)) <= 1, `${size}: as wide as the row (${JSON.stringify([g.form, rowBox])})`);
      assert.ok(Math.abs(g.form.height - rowBox.height) <= 4, `${size}: as high as the row (${g.form.height} vs ${rowBox.height})`);
      assert.equal(g.focused, true, `${size}: the rename field has the focus`);
      assert.equal(await page.locator('#h5-term-rename-input').evaluate(input => input.selectionStart === 0 && input.selectionEnd === input.value.length), true, 'the old name is selected');
      assert.equal(await page.locator('#h5-tasks .h5-terminal-list[aria-label="Phone terminals"] .h5-terminal-name', { hasText: 'Terminal 2' }).count(), 0, 'the row is replaced, not repeated');
      if (!wide) {
        await page.evaluate(height => window.setKeyboard(height), KEYBOARD);
        await page.waitForTimeout(300);
        assertInside(await geometry(page, { field: '#h5-term-rename-input' }), 'phone rename, keyboard open');
        await page.evaluate(() => window.setKeyboard(0));
      }
      // Enter saves.
      await page.locator('#h5-term-rename-input').fill('Build logs');
      await page.locator('#h5-term-rename-input').press('Enter');
      await page.locator('#h5-term-rename').waitFor({ state: 'detached' });
      await page.locator('#h5-tasks .h5-terminal-name', { hasText: 'Build logs' }).waitFor();
      assert.deepEqual(requests.at(-1), ['PATCH', '/api/tasks/6/terminals/t6-2', { title: 'Build logs' }]);
      const writes = requests.length;
      // Leaving the field cancels (a tap on the list title), and so does Escape.
      await press(rows.nth(2).locator('.h5-terminal-more'));
      await press(page.locator('#h5-session-menu [role="menuitem"]', { hasText: 'Rename' }));
      await page.locator('#h5-term-rename-input').waitFor();
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'h5-term-rename-input');
      await press(page.locator('#h5-tasks-title'));
      await page.locator('#h5-term-rename').waitFor({ state: 'detached' });
      await press(rows.nth(2).locator('.h5-terminal-more'));
      await press(page.locator('#h5-session-menu [role="menuitem"]', { hasText: 'Rename' }));
      await page.locator('#h5-term-rename-input').waitFor();
      await page.waitForTimeout(300);
      await page.locator('#h5-term-rename-input').press('Escape');
      await page.locator('#h5-term-rename').waitFor({ state: 'detached' });
      assert.equal(requests.length, writes, 'a cancelled rename saves nothing');
      assert.equal(await page.locator('#h5-tasks .h5-terminal-list[aria-label="Phone terminals"] .h5-terminal-name', { hasText: 'Terminal 3' }).count(), 1, 'the row is back');
      if (!wide) assert.equal(await page.locator('#h5-tasks').isVisible(), true, 'Escape in the field does not close the sheet');

      // ── A session of a task that is not selected ──
      await press(page.locator('.h5-task-item', { hasText: 'Task 3' }));
      await checkOtherTask({ page, requests, size, press, list: 'Task 3', shown: 'Task 6', base: '/api/tasks', task: 3 });
      if (!wide) {
        // The rows with their button fit a phone, also at 320px.
        for (const width of [390, 320]) {
          await page.setViewportSize({ width, height: 700 });
          await page.waitForTimeout(300);
          const fit = await page.evaluate(() => {
            const drawer = document.querySelector('#h5-tasks .h5-sheet-panel').getBoundingClientRect();
            return [...document.querySelectorAll('#h5-tasks .h5-terminal-list[aria-label="Task 3"] .h5-terminal-row')].map(row => {
              const box = row.getBoundingClientRect();
              const more = row.querySelector('.h5-terminal-more').getBoundingClientRect();
              return { row: box.right, more: more.right, drawer: drawer.right, left: more.left, main: row.querySelector('.h5-terminal-main').getBoundingClientRect().right, width: more.width, height: more.height, scroll: document.getElementById('h5-task-list').scrollWidth - document.getElementById('h5-task-list').clientWidth };
            });
          });
          for (const row of fit) {
            assert.ok(row.more <= row.row + 0.5 && row.row <= row.drawer + 0.5, `${width}px: the button is inside the row and the sheet (${JSON.stringify(row)})`);
            assert.ok(row.main <= row.left + 0.5, `${width}px: the name does not run under the button (${JSON.stringify(row)})`);
            assert.ok(row.width >= 43.5 && row.height >= 43.5, `${width}px: a 44px target (${JSON.stringify(row)})`);
            assert.ok(row.scroll <= 0, `${width}px: no sideways scroll in the list (${JSON.stringify(row)})`);
          }
        }
        await page.setViewportSize({ width: 390, height: 844 });
      }
      // Open is the other action: it goes to that session of that task, as a tap on the row does.
      await page.locator('#h5-tasks .h5-terminal-list[aria-label="Task 3"] .h5-terminal-row').nth(1).locator('.h5-terminal-more').waitFor();
      await press(page.locator('#h5-tasks .h5-terminal-list[aria-label="Task 3"] .h5-terminal-row').nth(1).locator('.h5-terminal-more'));
      await press(page.locator('#h5-session-menu [role="menuitem"]', { hasText: 'Open' }));
      await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId === 't3-2');
      assert.equal(await page.locator('#h5-task-name').textContent(), 'Task 3', `${size}: Open goes to that task`);
      await context.close();
    }

    // ── The same on a remote Engine, whose tasks and chats go through the proxy ──
    for (const wide of [false, true]) {
      const size = `remote ${wide ? 'PC' : 'phone'}`;
      const { context, page, requests } = await openPage(browser, wide, true);
      const press = locator => (wide ? locator.click() : locator.tap());
      const openSheet = async () => { if (!wide && !(await page.locator('#h5-tasks').isVisible())) await page.locator('#h5-open-tasks').tap(); await page.locator('#h5-tasks .h5-task-item').first().waitFor(); };
      await openSheet();
      await page.locator('.h5-task-item', { hasText: 'Remote 9' }).waitFor();
      await press(page.locator('.h5-task-item', { hasText: 'Remote 9' }));
      await press(page.locator('#h5-tasks .h5-terminal-list[aria-label="Remote 9"] .h5-terminal-main').nth(1));
      if (!wide) await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId === 't9-2');
      await openSheet();
      await page.locator('#h5-tasks .h5-terminal-list[aria-label="Phone terminals"] .h5-terminal-row').nth(3).waitFor();
      await press(page.locator('.h5-task-item', { hasText: 'Remote 10' }));
      await checkOtherTask({ page, requests, size, press, list: 'Remote 10', shown: 'Remote 9', base: '/api/remote-servers/7/tasks', task: 10 });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log('Session name fields in place (phone, phone with keyboard, PC): Session list under its task, rename in place of the row, Enter / Escape / blur, and rename of a session of another task (local and remote Engine) passed.');
})().catch(error => { console.error(error); process.exit(1); });
