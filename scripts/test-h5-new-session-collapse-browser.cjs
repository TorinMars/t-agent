// The "Session" list of a task's "+" (and the rename field) go away with the task they are drawn under: in real Chromium at phone size (touch) and computer
// size (pointer, permanent sidebar). Collapsing that task, Collapse all, another task becoming the selected one, folding the sidebar, closing the sheet and
// changing the Engine all take the list away; collapsing a different task does not. Every case runs on a fresh page and all of them are reported.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const LOCAL_TASKS = [{ id: 1, title: 'Alpha', status: 'doing' }, { id: 2, title: 'Beta', status: 'doing' }, { id: 3, title: 'Gamma', status: 'doing' }];
const REMOTE_TASKS = [{ id: 1, title: 'Remote one', status: 'doing' }]; // the same id as Alpha: ids alone do not say which task a list belongs to
const CHOICES = ['New Terminal', 'Claude session', 'Codex session'];
const SHORT = { timeout: 1500 };

async function openPage(browser, wide) {
  const context = await browser.newContext(wide ? { viewport: { width: 1440, height: 900 } } : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send() {}
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
  });
  const server = { posts: [], holdSessions: null };
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const { pathname } = url;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
    if (pathname === '/api/remote-servers') return json([{ id: 7, name: 'VPS' }]);
    if (pathname === '/api/remote-servers/7/info') return json({ capabilities: ['terminal:control'] });
    if (pathname === '/api/tasks' && method === 'GET') return json(LOCAL_TASKS);
    if (pathname === '/api/remote-servers/7/tasks' && method === 'GET') return json(REMOTE_TASKS);
    if (/\/task-groups$/.test(pathname)) return json([{ key: 'doing', name: 'Doing', sort_order: 1 }]);
    const terminals = pathname.match(/^\/api(?:\/remote-servers\/7)?\/tasks\/(\d+)\/terminals$/);
    if (terminals && method === 'GET') return json([{ terminal_id: 'default', title: 'Terminal 1' }, { terminal_id: `t${terminals[1]}-2`, title: 'Terminal 2' }]);
    if (terminals && method === 'POST') { const body = route.request().postDataJSON(); server.posts.push([pathname, body]); return json({ terminal_id: `fresh-${server.posts.length}`, title: body.title || 'Terminal 3' }, 201); }
    if (/\/agent-sessions$/.test(pathname)) {
      if (server.holdSessions) { server.holdSessions.seen = true; await server.holdSessions.released; }
      return json([{ id: 's1', title: 'Older session' }]);
    }
    if (/\/terminal\/ack$/.test(pathname)) return json({ success: true });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);

  const press = locator => (wide ? locator.click() : locator.tap());
  const item = title => page.locator('#h5-tasks .h5-task-item', { hasText: title });
  const add = title => page.locator(`#h5-tasks .h5-task-row:has(.h5-task-title:text-is("${title}")) .h5-task-add`);
  const list = label => page.locator(`#h5-tasks .h5-terminal-list[aria-label="${label}"]`);
  const panel = page.locator('#h5-new-session');
  const choices = page.locator('#h5-new-session #h5-term-menu-actions button');
  const openSheet = async () => {
    if (!wide && !(await page.locator('#h5-tasks').isVisible())) await page.locator('#h5-open-tasks').tap();
    await item('Alpha').waitFor();
    if (!wide) await page.waitForTimeout(350); // the sheet has finished sliding in
  };
  const sheetClosed = async () => { if (!wide) await page.locator('#h5-tasks').waitFor({ state: 'hidden' }); };
  const shown = title => page.waitForFunction(name => document.getElementById('h5-task-name').textContent === name, title);
  const openPanel = async title => { await press(add(title)); await choices.first().waitFor(); assert.deepEqual(await choices.allTextContents(), CHOICES, 'the choices of the list'); };
  const gone = async text => { await panel.waitFor({ state: 'detached', ...SHORT }).catch(() => assert.fail(`${text}: the Session list is still open`)); };
  const owner = () => panel.evaluate(node => node.parentElement.querySelector('.h5-task-title').textContent);
  // Alpha is the selected task, with its sessions listed.
  await openSheet();
  await press(item('Alpha'));
  await press(list('Alpha').locator('.h5-terminal-main').first());
  await shown('Alpha');
  await sheetClosed();
  await openSheet();
  await list('Phone terminals').locator('.h5-terminal-row').nth(1).waitFor();
  return { context, page, server, pageErrors, wide, press, item, add, list, panel, choices, openSheet, sheetClosed, shown, openPanel, gone, owner };
}

const CASES = [
  ['collapsing the selected task closes its Session list, and it opens again', async t => {
    await t.openPanel('Alpha');
    await t.press(t.item('Alpha'));
    await t.list('Phone terminals').waitFor({ state: 'detached' });
    await t.gone('after the collapse');
    assert.equal(await t.item('Alpha').getAttribute('aria-expanded'), 'false', 'the task is collapsed');
    await t.press(t.item('Alpha')); // opening the task does not bring the list back
    await t.list('Phone terminals').waitFor();
    await t.page.waitForTimeout(150);
    assert.equal(await t.panel.count(), 0, 'expanding the task does not bring the list back');
    await t.openPanel('Alpha');
    assert.equal(await t.owner(), 'Alpha', 'under its task');
  }],
  ['the "+" of a collapsed selected task opens the task, so one tap on the task closes both', async t => {
    await t.press(t.item('Alpha'));
    await t.list('Phone terminals').waitFor({ state: 'detached' });
    await t.openPanel('Alpha');
    assert.equal(await t.item('Alpha').getAttribute('aria-expanded'), 'true', 'the task is expanded by its "+"');
    await t.list('Phone terminals').waitFor();
    await t.press(t.item('Alpha'));
    await t.gone('after one tap on the task');
    assert.equal(await t.item('Alpha').getAttribute('aria-expanded'), 'false', 'and the task is collapsed');
  }],
  ['creating a session still works after a collapse, with a fresh name', async t => {
    await t.openPanel('Alpha');
    await t.page.locator('#h5-new-name-input').fill('Abandoned');
    await t.press(t.item('Alpha'));
    await t.gone('after the collapse');
    await t.openPanel('Alpha');
    assert.equal(await t.page.locator('#h5-new-name-input').inputValue(), '', 'the abandoned name is not kept');
    await t.page.locator('#h5-new-name-input').fill('Review');
    await t.press(t.choices.filter({ hasText: 'New Terminal' }));
    await t.page.waitForFunction(() => document.getElementById('h5-session-name').textContent === 'Review');
    assert.deepEqual(t.server.posts, [['/api/tasks/1/terminals', { title: 'Review' }]], 'one terminal, in that task, with that name');
    await t.sheetClosed();
  }],
  ['the "+" of a task that is not selected: collapsing that task closes the list', async t => {
    await t.openPanel('Beta');
    assert.equal(await t.owner(), 'Beta', 'under its task');
    await t.press(t.item('Beta'));
    await t.gone('after the collapse');
  }],
  ['collapsing a different task leaves the list and the typed name alone', async t => {
    await t.press(t.item('Gamma'));
    await t.list('Gamma').waitFor();
    await t.openPanel('Alpha');
    await t.page.locator('#h5-new-name-input').fill('Keep me');
    await t.press(t.item('Gamma'));
    await t.list('Gamma').waitFor({ state: 'detached' });
    await t.page.waitForTimeout(150);
    assert.equal(await t.panel.count(), 1, 'the list stays');
    assert.equal(await t.page.locator('#h5-new-name-input').inputValue(), 'Keep me', 'with the typed name');
    await t.press(t.choices.filter({ hasText: 'New Terminal' }));
    await t.page.waitForFunction(() => document.getElementById('h5-session-name').textContent === 'Keep me');
    assert.deepEqual(t.server.posts, [['/api/tasks/1/terminals', { title: 'Keep me' }]], 'the name is used');
  }],
  ['Collapse all closes the list; Expand all does not', async t => {
    await t.openPanel('Alpha');
    await t.press(t.page.locator('#h5-expand-all'));
    await t.page.waitForTimeout(150);
    assert.equal(await t.panel.count(), 1, 'Expand all leaves the list');
    await t.press(t.page.locator('#h5-collapse-all'));
    await t.gone('after Collapse all');
  }],
  ['a Claude list that arrives after the collapse does not replace a list opened again', async t => {
    let release;
    t.server.holdSessions = { seen: false, released: new Promise(resolve => { release = resolve; }) };
    const held = t.server.holdSessions;
    await t.openPanel('Alpha');
    await t.press(t.choices.filter({ hasText: 'Claude session' }));
    await t.choices.filter({ hasText: 'Loading' }).waitFor();
    while (!held.seen) await t.page.waitForTimeout(20);
    await t.press(t.item('Alpha'));
    await t.gone('after the collapse');
    await t.openPanel('Alpha');
    t.server.holdSessions = null;
    release();
    await t.page.waitForTimeout(300);
    assert.deepEqual(await t.choices.allTextContents(), CHOICES, 'the list opened again keeps its choices');
    // The sub-list itself still arrives when nothing happened meanwhile.
    await t.press(t.choices.filter({ hasText: 'Claude session' }));
    await t.choices.filter({ hasText: 'Older session' }).waitFor();
    assert.deepEqual(await t.choices.allTextContents(), ['New Claude session', 'Older session', 'Back'], 'the Claude list');
  }],
  ['opening a task of another service closes the list', async t => {
    await t.openPanel('Alpha');
    await t.press(t.item('Remote one'));
    await t.press(t.list('Remote one').locator('.h5-terminal-main').first());
    await t.gone('after a task of the other service was opened');
  }],
  ['a collapse takes the rename field away for good', async t => {
    const rows = t.list('Phone terminals').locator('.h5-terminal-row');
    await t.press(rows.nth(1).locator('.h5-terminal-more'));
    await t.press(t.page.locator('#h5-session-menu [role="menuitem"]', { hasText: 'Rename' }));
    await t.page.locator('#h5-term-rename-input').waitFor();
    await t.page.waitForTimeout(350);
    // Without the blur a real tap may not cause (iOS does not move the focus to a button): the page only sees the collapse.
    await t.item('Alpha').evaluate(node => node.click());
    await t.list('Phone terminals').waitFor({ state: 'detached' });
    await t.press(t.item('Alpha'));
    await t.list('Phone terminals').waitFor();
    await t.page.waitForTimeout(150);
    assert.equal(await t.page.locator('#h5-term-rename').count(), 0, 'expanding the task does not bring the rename field back');
  }],
  ['closing the sheet closes the list', async t => {
    await t.openPanel('Alpha');
    await t.press(t.page.locator('#h5-close-tasks'));
    await t.sheetClosed();
    await t.openSheet();
    assert.equal(await t.panel.count(), 0, 'not there when the sheet opens again');
  }, 'phone'],
  ['another task becoming the selected one closes the list', async t => {
    await t.press(t.item('Beta'));
    await t.list('Beta').waitFor();
    await t.list('Beta').locator('.h5-terminal-row').first().waitFor();
    await t.openPanel('Alpha');
    await t.press(t.list('Beta').locator('.h5-terminal-main').first());
    await t.shown('Beta');
    await t.gone('after Beta was selected');
    assert.deepEqual(t.server.posts, [], 'nothing was created');
  }, 'PC'],
  ['folding the sidebar closes the list', async t => {
    await t.openPanel('Alpha');
    await t.press(t.page.locator('#h5-sidebar-toggle'));
    await t.page.locator('#h5-tasks').waitFor({ state: 'detached' });
    await t.press(t.page.locator('#h5-sidebar-toggle'));
    await t.item('Alpha').waitFor();
    await t.page.waitForTimeout(150);
    assert.equal(await t.panel.count(), 0, 'not there when the sidebar comes back');
  }, 'PC'],
];

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const failures = [];
  try {
    for (const wide of [false, true]) {
      const size = wide ? 'PC' : 'phone';
      for (const [name, run, only] of CASES) {
        if (only && only !== size) continue;
        let t;
        try {
          t = await openPage(browser, wide);
          await run(t);
          assert.deepEqual(t.pageErrors, [], 'no page errors');
          console.log(`  ok   ${size}: ${name}`);
        } catch (error) {
          failures.push(`${size}: ${name}`);
          console.log(`  FAIL ${size}: ${name}\n       ${String(error.message).split('\n')[0]}`);
        } finally {
          if (t) await t.context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  if (failures.length) { console.error(`${failures.length} case(s) failed`); process.exit(1); }
  console.log('The Session list and the rename field go away with their task (phone, PC).');
})().catch(error => { console.error(error); process.exit(1); });
