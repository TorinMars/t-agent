// The session name fields of the task list, in real Chromium at phone size (390x844, touch) and computer size (1440x900, pointer, permanent sidebar):
// the "Session" list of a task's "+" (with its optional name field) is drawn right under that task, indented like its session rows, and the rename field
// takes the place of the row being renamed. Both stay inside the sidebar and inside the visible area, also with the iPhone keyboard open (a smaller
// visual viewport). Enter saves, Escape / Cancel / leaving the rename field cancel.
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

async function openPage(browser, wide) {
  const context = await browser.newContext(wide ? { viewport: { width: 1440, height: 900 } } : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  const requests = []; // [method, path, body] of the terminal writes
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
    const viewport = new EventTarget();
    let keyboard = 0;
    Object.defineProperties(viewport, {
      height: { get: () => innerHeight - keyboard }, width: { get: () => innerWidth }, offsetTop: { get: () => 0 }, offsetLeft: { get: () => 0 }, scale: { get: () => 1 },
    });
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
    window.setKeyboard = height => { keyboard = height; viewport.dispatchEvent(new Event('resize')); };
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    if (url.pathname === '/api/remote-servers') return json([]);
    if (url.pathname === '/api/tasks' && method === 'GET') return json(tasks);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'Doing', sort_order: 1 }]);
    const list = url.pathname.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (list && method === 'GET') return json(Array.from({ length: 4 }, (_, i) => ({ terminal_id: `t${list[1]}-${i + 1}`, title: `Terminal ${i + 1}` })));
    if (list && method === 'POST') { const body = route.request().postDataJSON(); requests.push([method, url.pathname, body]); return json({ terminal_id: 'fresh', title: body.title || 'Terminal 5' }, 201); }
    if (/^\/api\/tasks\/\d+\/terminals\/[^/]+$/.test(url.pathname) && method === 'PATCH') { const body = route.request().postDataJSON(); requests.push([method, url.pathname, body]); return json({ title: body.title }); }
    if (/\/agent\/conversations$/.test(url.pathname) && method === 'GET') return json([]);
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

      // ── The "+" of the task: its Session list right under the task row, not a sheet at the bottom of the screen ──
      await press(page.locator(`${taskRow('Task 6')} .h5-task-add`));
      await page.locator('#h5-new-session').waitFor();
      await page.waitForTimeout(300);
      assert.equal(await page.locator('#h5-term-menu .h5-menu-panel').isVisible().catch(() => false), false, `${size}: no sheet from the bottom`);
      assert.deepEqual(await page.locator('#h5-new-session #h5-term-menu-actions button').allTextContents(), ['New Terminal', 'Claude session', 'Codex session', 'Claude agent', 'Codex agent']);
      let g = await geometry(page, { field: '#h5-new-name-input', task: 'Task 6' });
      assertInside(g, `${size} new session`);
      assert.ok(g.field.top >= g.row.bottom - 0.5 && g.field.top - g.row.bottom < 40, `${size}: the name field is right below its task row (${g.row.bottom} -> ${g.field.top})`);
      assert.ok(Math.abs(g.field.left - (g.sessionRow.left + 3)) <= 1, `${size}: aligned with the session rows (${g.field.left} vs ${g.sessionRow.left})`);
      assert.ok(g.field.height >= (wide ? 36 : 44) - 0.5, `${size}: the field is ${g.field.height}px high`);
      assert.equal(g.focused, wide, wide ? 'a computer: the name field takes the focus' : 'a touch screen: no keyboard pops up on its own');
      // The choices are below the field, and the sessions of the task follow the list.
      const order = await page.evaluate(() => {
        const top = selector => document.querySelector(selector).getBoundingClientRect().top;
        return top('#h5-new-name-input') < top('#h5-new-session #h5-term-menu-actions') && top('#h5-new-session') < top('#h5-tasks .h5-terminal-list[aria-label="Phone terminals"]');
      });
      assert.ok(order, `${size}: field, choices, then the sessions of the task`);

      if (!wide) {
        // The iPhone keyboard: the sheet gets shorter with the visual viewport and the focused field stays in view above the keyboard.
        await page.locator('#h5-new-name-input').tap();
        await page.evaluate(height => window.setKeyboard(height), KEYBOARD);
        await page.waitForTimeout(300);
        g = await geometry(page, { field: '#h5-new-name-input', task: 'Task 6' });
        assert.ok(Math.abs(g.drawer.height - (844 - KEYBOARD)) <= 1, `the sheet follows the visual viewport (${g.drawer.height})`);
        assertInside(g, 'phone new session, keyboard open');
        await page.evaluate(() => window.setKeyboard(0));
        // Cancel closes the list; the sheet stays.
        await page.locator('#h5-term-menu-cancel').tap();
        await page.locator('#h5-new-session').waitFor({ state: 'detached' });
        assert.equal(await page.locator('#h5-tasks').isVisible(), true, 'the sheet stays open');
        // The "+" of a task that is not open: the sheet stays and the list is under that task.
        await page.locator(`${taskRow('Task 2')} .h5-task-add`).tap();
        await page.locator('#h5-new-session').waitFor();
        await page.waitForTimeout(300);
        assert.equal(await page.locator('#h5-tasks').isVisible(), true, 'the sheet stays open for the "+" of another task');
        g = await geometry(page, { field: '#h5-new-name-input', task: 'Task 2' });
        assert.ok(g.field.top >= g.row.bottom - 0.5 && g.field.top - g.row.bottom < 40, `under Task 2 (${g.row.bottom} -> ${g.field.top})`);
        // The "+" again closes it.
        await page.locator(`${taskRow('Task 2')} .h5-task-add`).tap();
        await page.locator('#h5-new-session').waitFor({ state: 'detached' });
        // Back to Task 6 for the rename checks.
        await page.locator('.h5-task-item', { hasText: 'Task 6' }).tap(); // close
        await page.locator('.h5-task-item', { hasText: 'Task 6' }).tap(); // open
        await page.locator('#h5-tasks .h5-terminal-list[aria-label="Task 6"] .h5-terminal-main').first().tap();
        await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
        await openSheet();
      } else {
        // Escape closes the list and is not passed on to the terminal; Enter in the field runs New Terminal with the name.
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
      await press(page.locator('#h5-term-menu-actions button', { hasText: 'Rename' }));
      await page.locator('#h5-term-rename').waitFor();
      await page.locator('#h5-term-menu .h5-menu-panel').waitFor({ state: 'hidden' });
      await page.waitForTimeout(300);
      g = await geometry(page, { field: '#h5-term-rename-input' });
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
      await press(page.locator('#h5-term-menu-actions button', { hasText: 'Rename' }));
      await page.locator('#h5-term-rename-input').waitFor();
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'h5-term-rename-input');
      await press(page.locator('#h5-tasks-title'));
      await page.locator('#h5-term-rename').waitFor({ state: 'detached' });
      await press(rows.nth(2).locator('.h5-terminal-more'));
      await press(page.locator('#h5-term-menu-actions button', { hasText: 'Rename' }));
      await page.locator('#h5-term-rename-input').waitFor();
      await page.waitForTimeout(300);
      await page.locator('#h5-term-rename-input').press('Escape');
      await page.locator('#h5-term-rename').waitFor({ state: 'detached' });
      assert.equal(requests.length, writes, 'a cancelled rename saves nothing');
      assert.equal(await page.locator('#h5-tasks .h5-terminal-list[aria-label="Phone terminals"] .h5-terminal-name', { hasText: 'Terminal 3' }).count(), 1, 'the row is back');
      if (!wide) assert.equal(await page.locator('#h5-tasks').isVisible(), true, 'Escape in the field does not close the sheet');
      await context.close();
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log('Session name fields in place (phone, phone with keyboard, PC): Session list under its task, rename in place of the row, Enter / Escape / blur passed.');
})().catch(error => { console.error(error); process.exit(1); });
