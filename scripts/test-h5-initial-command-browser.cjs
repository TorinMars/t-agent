// The initial command of a new terminal in the New session dialog ("Initial command" in docs/design/terminals.md), in real Chromium with the routes
// mocked, at computer size (1440x900, a mouse) and phone size (390x844, touch):
// - "Run a command when it starts" is folded at every opening; a press unfolds the multiline field (4,000 characters at most, its helper text) and the
//   Recent menu, which lists the commands of the shared page state (`ta-start-commands`, newest first); a pick fills the field.
// - New Terminal with a command posts `command` (and a name when one was typed); the command is remembered in the shared page state (PUT
//   /api/page-state) at the top of Recent, once; the next opening is folded and empty again.
// - While a command is typed the other kinds are greyed ("Only a terminal runs a start command"); a sub-list (Claude session) has no field; a Claude
//   session made with the field folded sends no command.
// - An Engine whose /info does not list 'terminal:start-command' shows the field disabled with "This computer needs an update to run a command at
//   start"; one that lists it gets the command through the proxy.
// SCREENSHOTS=<dir> saves the dialog.
const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { settled } = require('./browser-test-wait.cjs');

// A temporary data folder, so nothing here can reach the person's own data (the page itself only talks to the mocked routes).
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-initial-command-browser-'));
process.env.T_AGENT_DATA_DIR = TEMP;

const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.SCREENSHOTS || '';
const SHORT = { timeout: 3000 };
const HELPER = 'Typed into the shell every time this session starts, then Enter. The terminal stays open.';
const EDIT_HELPER = 'Typed into the shell every time this session starts, then Enter.';
const NOTE = 'This computer needs an update to run a command at start';
const LOCAL_TASKS = [{ id: 1, title: 'release-notes', status: 'doing' }];
const REMOTES = [{ id: 7, name: 'K01', capabilities: ['terminal:control', 'terminal:initial-command'] }, { id: 8, name: 'K02', capabilities: ['terminal:control', 'terminal:initial-command', 'terminal:start-command'] }];
const SAVED = { shell: { 'npm run dev': 2000, 'git status\ngit log -3': 3000 } }; // the shared Recent list: newest first is the two-line one

async function openPage(browser, wide) {
  const viewport = wide ? { width: 1440, height: 900 } : { width: 390, height: 844 };
  const context = await browser.newContext(wide ? { viewport, ...(SHOTS ? { deviceScaleFactor: 2 } : {}) } : { viewport, isMobile: true, hasTouch: true, ...(SHOTS ? { deviceScaleFactor: 3 } : {}) });
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
  const server = { posts: [], stateKeys: { 'ta-start-commands': SAVED }, version: 1, puts: [], patches: [], commands: { '/api/tasks/1/terminals/default': 'cd docs\nmake watch' } };
  const view = () => ({ instance_id: 'local-instance', version: server.version, recent: [], keys: server.stateKeys, moves: [], peers: [] });
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const { pathname } = url;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
    if (pathname === '/auth/me') return json({ effective_work_dir: '/home/t/tasks' });
    if (pathname === '/api/page-state' && method === 'GET') return json(view());
    if (pathname === '/api/page-state' && method === 'PUT') {
      const body = route.request().postDataJSON();
      server.puts.push(body);
      server.stateKeys = { ...server.stateKeys, ...(body.keys || {}) };
      server.version += 1;
      return json(view());
    }
    if (pathname === '/api/remote-servers') return json(REMOTES.map(({ id, name }) => ({ id, name })));
    const info = pathname.match(/^\/api\/remote-servers\/(\d+)\/info$/);
    if (info) return json({ capabilities: REMOTES.find(item => item.id === Number(info[1])).capabilities });
    if (/\/task-groups$/.test(pathname)) return json([{ key: 'doing', name: 'Doing', sort_order: 1 }]);
    if (pathname === '/api/tasks' && method === 'GET') return json(LOCAL_TASKS);
    const remoteTasks = pathname.match(/^\/api\/remote-servers\/(\d+)\/tasks$/);
    if (remoteTasks && method === 'GET') return json([{ id: 1, title: `Remote ${remoteTasks[1]}`, status: 'doing' }]);
    if (method === 'POST' && /\/terminals$/.test(pathname)) {
      const body = route.request().postDataJSON();
      server.posts.push([pathname, body]);
      return json({ terminal_id: `fresh-${server.posts.length}`, title: body.title || `Terminal ${server.posts.length + 1}`, agent: body.agent || null }, 201);
    }
    if (/\/terminals$/.test(pathname) && method === 'GET') return json([
      { terminal_id: 'default', title: 'Terminal 1', has_start_command: Boolean(server.commands[`${pathname}/default`]) },
      ...(!pathname.startsWith('/api/tasks/') ? [] : [
        { terminal_id: 'claude', title: 'Claude', agent: 'claude' },
        { terminal_id: 'codex', title: 'Codex', agent: 'codex' },
        { terminal_id: 'opencode', title: 'OpenCode', agent: 'opencode' },
        { terminal_id: 'notebook', title: 'Notebook', agent: 'notebook', notebook: 'demo.ipynb' },
      ]),
    ]);
    if (method === 'GET' && pathname.endsWith('/start-command')) {
      const terminal = pathname.slice(0, -'/start-command'.length);
      return json({ command: server.commands[terminal] ?? '' });
    }
    if (method === 'PATCH' && /\/terminals\/[^/]+$/.test(pathname)) {
      const body = route.request().postDataJSON();
      server.patches.push([pathname, body]);
      server.commands[pathname] = body.start_command;
      return json({ has_start_command: Boolean(body.start_command) });
    }
    if (/\/agent-sessions$/.test(pathname)) return json([]);
    if (/\/terminal\/ack$/.test(pathname)) return json({ success: true });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  const press = locator => (wide ? locator.click() : locator.tap());
  const row = title => `#h5-tasks .h5-task-row:has(.h5-task-title:text-is("${title}"))`;
  const openSheet = async () => {
    if (!wide && !(await page.locator('#h5-tasks').isVisible())) await page.locator('#h5-open-tasks').tap();
    await page.locator('#h5-tasks .h5-task-item', { hasText: 'release-notes' }).waitFor();
    if (!wide) await settled(page);
  };
  const choices = page.locator('#h5-new-session #h5-term-menu-actions button');
  const openDialog = async title => {
    await openSheet();
    if (wide) await page.locator(`${row(title)} .h5-task-add`).click();
    else {
      await page.locator(`${row(title)} .h5-task-more`).tap();
      await page.locator('#h5-session-menu-actions [role="menuitem"]', { hasText: 'New session' }).tap();
    }
    await choices.first().waitFor();
    await settled(page);
  };
  const closeDialog = async () => {
    await press(page.locator('#h5-term-menu-cancel'));
    await page.locator('#h5-new-session').waitFor({ state: 'detached', ...SHORT });
  };
  return { context, page, server, pageErrors, wide, press, choices, openDialog, closeDialog, openSheet, row };
}

const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) }); };
const disabledKinds = page => page.evaluate(() => [...document.querySelectorAll('#h5-new-session #h5-term-menu-actions button')].map(button => ({
  label: button.querySelector('.h5-choice-label')?.textContent, disabled: button.disabled, note: button.querySelector('.h5-choice-note')?.textContent || '',
})));

async function checks(t) {
  const { page, server, wide, press, choices } = t;
  const size = wide ? 'computer' : 'phone';
  const toggle = page.locator('#h5-start-command-toggle');
  const input = page.locator('#h5-start-command-input');

  // Folded at the opening.
  await t.openDialog('release-notes');
  await toggle.waitFor(SHORT);
  assert.equal(await toggle.textContent(), 'Run a command when it starts', `${size}: the disclosure line`);
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', `${size}: folded by default`);
  assert.equal(await input.count(), 0, `${size}: no field while folded`);
  const box = await toggle.boundingBox();
  if (!wide) assert.ok(box.height >= 44, `${size}: the disclosure is a 44px touch target (${box.height})`);
  await shot(page, `${size}-1-folded.png`);

  // Unfolded: the field, its helper text and limit, the Recent menu from the shared page state.
  await press(toggle);
  await input.waitFor(SHORT);
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true', `${size}: unfolded`);
  assert.equal(await input.evaluate(node => node.tagName), 'TEXTAREA', `${size}: a multiline field`);
  assert.equal(await input.getAttribute('maxlength'), '4000', `${size}: at most 4,000 characters`);
  assert.equal(await page.locator('#h5-start-command-input-helper-text').textContent(), HELPER, `${size}: the helper text`);
  await press(page.locator('#h5-start-command-recent'));
  const items = page.locator('#h5-start-command-menu [role="menuitem"]');
  await items.first().waitFor(SHORT);
  assert.deepEqual(await items.allTextContents(), ['git status ⏎ git log -3', 'npm run dev'], `${size}: Recent, newest first, a two-line command on one line`);
  await shot(page, `${size}-2-recent.png`);
  await press(items.filter({ hasText: 'npm run dev' }));
  await page.locator('#h5-start-command-menu').waitFor({ state: 'detached', ...SHORT }).catch(() => {});
  assert.equal(await input.inputValue(), 'npm run dev', `${size}: a pick fills the field`);

  // While a command is typed only New Terminal is a choice.
  const kinds = await disabledKinds(page);
  assert.deepEqual(kinds.filter(item => item.disabled).map(item => item.label), ['Claude session', 'Codex session', 'OpenCode session', 'Shell notebook'], `${size}: the other kinds are greyed`);
  assert.ok(kinds.filter(item => item.disabled).every(item => item.note === 'Only a terminal runs a start command'), `${size}: and say why`);
  if (wide) assert.equal(await page.locator('#h5-term-menu-actions [aria-selected="true"]').textContent(), 'New Terminal', 'New Terminal is the highlighted choice');
  await shot(page, `${size}-3-command.png`);

  // A second line, typed: Enter in the field is a new line, not a create.
  await input.fill('cd docs\nnpm run dev');
  if (wide) {
    await input.press('End');
    await input.press('Enter');
    assert.equal(server.posts.length, 0, 'Enter in the command field does not create');
    assert.equal(await input.inputValue(), 'cd docs\nnpm run dev\n', 'Enter adds a line');
  }
  await page.locator('#h5-new-name-input').fill('dev server');
  await press(choices.filter({ hasText: 'New Terminal' }));
  await page.locator('#h5-new-session').waitFor({ state: 'detached', ...SHORT });
  const [where, body] = server.posts.at(-1);
  assert.equal(where, '/api/tasks/1/terminals', `${size}: made in the task`);
  assert.deepEqual(body, { title: 'dev server', command: 'cd docs\nnpm run dev' }, `${size}: the body has the name and the command (trimmed)`);
  // Remembered in the shared page state, at the top, once.
  await page.waitForFunction(() => {
    const value = JSON.parse(window.TAPageState.store.getItem('ta-start-commands') || '{}');
    return value.shell && value.shell['cd docs\nnpm run dev'];
  }, null, SHORT);
  for (let i = 0; i < 40 && !server.puts.some(item => item.keys && item.keys['ta-start-commands']); i += 1) await page.waitForTimeout(100);
  const put = server.puts.find(item => item.keys && item.keys['ta-start-commands']);
  assert.ok(put, `${size}: the Recent list went to the server`);
  assert.deepEqual(Object.keys(put.keys['ta-start-commands'].shell).sort(), ['cd docs\nnpm run dev', 'git status\ngit log -3', 'npm run dev'], `${size}: added to the shared list`);

  // The next opening is folded and empty; the new command is at the top of Recent.
  await t.openDialog('release-notes');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', `${size}: folded again`);
  await press(toggle);
  await input.waitFor(SHORT);
  assert.equal(await input.inputValue(), '', `${size}: cleared after use`);
  await press(page.locator('#h5-start-command-recent'));
  await items.first().waitFor(SHORT);
  assert.equal(await items.first().textContent(), 'cd docs ⏎ npm run dev', `${size}: the last command used is first`);
  await page.keyboard.press('Escape');
  await page.locator('#h5-start-command-menu').waitFor({ state: 'detached', ...SHORT }).catch(() => {});
  // A sub-list has no field; Claude made with a command typed but the field folded sends none.
  await input.fill('echo hi');
  await press(toggle); // folded: the command is not used
  assert.equal((await disabledKinds(page)).filter(item => item.disabled).length, 0, `${size}: folded, every kind is offered again`);
  await press(choices.filter({ hasText: 'Claude session' }));
  await choices.filter({ hasText: 'New Claude session' }).waitFor(SHORT);
  assert.equal(await toggle.count(), 0, `${size}: the Claude sub-list has no command field`);
  await press(choices.filter({ hasText: 'New Claude session' }));
  await page.locator('#h5-new-session').waitFor({ state: 'detached', ...SHORT });
  assert.deepEqual(server.posts.at(-1), ['/api/tasks/1/terminals', { agent: 'claude' }], `${size}: a Claude session sends no command`);

  // An older Engine: disabled, with the note.
  await t.openDialog('Remote 7');
  await page.locator('#h5-start-command-note').waitFor(SHORT);
  assert.equal(await page.locator('#h5-start-command-note').textContent(), NOTE, `${size}: the note of an older engine`);
  await press(toggle);
  await input.waitFor(SHORT);
  assert.equal(await input.isDisabled(), true, `${size}: the field is disabled`);
  assert.equal(await page.locator('#h5-start-command-recent').isDisabled(), true, `${size}: and its Recent menu`);
  await shot(page, `${size}-4-older-engine.png`);
  await t.closeDialog();
  // An Engine with the capability: the command goes through the proxy.
  await t.openDialog('Remote 8');
  await press(toggle);
  await input.waitFor(SHORT);
  await page.waitForFunction(() => !document.getElementById('h5-start-command-input').disabled, null, SHORT);
  assert.equal(await page.locator('#h5-start-command-note').count(), 0, `${size}: no note for an engine that can`);
  await input.fill('make watch');
  await press(choices.filter({ hasText: 'New Terminal' }));
  await page.locator('#h5-new-session').waitFor({ state: 'detached', ...SHORT });
  assert.deepEqual(server.posts.at(-1), ['/api/remote-servers/8/tasks/1/terminals', { command: 'make watch' }], `${size}: the remote engine gets the command`);
}

async function editChecks({ page, server, press, openSheet, row, wide }) {
  const openMenu = async (title, id = 'default') => {
    await openSheet();
    const task = page.locator(row(title));
    const more = task.locator('..').locator(`.h5-terminal-row[data-session="${id}"] .h5-terminal-more`);
    const toggle = task.locator('.h5-task-item');
    if (await toggle.getAttribute('aria-expanded') === 'false') await press(toggle);
    await more.waitFor(SHORT);
    await more.scrollIntoViewIfNeeded();
    await press(more);
    await page.locator('#h5-session-menu-actions').waitFor(SHORT);
  };
  const edit = page.getByRole('menuitem', { name: 'Start command…', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Start command', exact: true });
  const field = dialog.getByRole('textbox');
  const openEdit = async title => {
    await openMenu(title);
    await press(edit);
    await dialog.waitFor(SHORT);
    await page.waitForFunction(() => {
      const input = document.getElementById('h5-edit-start-command-input');
      return input && !input.disabled;
    }, null, SHORT);
  };

  await openEdit('release-notes');
  assert.equal(await dialog.locator('#h5-edit-start-command-input-helper-text').textContent(), EDIT_HELPER);
  assert.ok(await field.inputValue() === 'cd docs\nmake watch', 'the editor opens with the stored command');
  if (!wide) {
    for (const button of await dialog.getByRole('button').all()) assert.ok((await button.boundingBox()).height >= 44);
  }
  await field.fill('discard this edit');
  await press(dialog.getByRole('button', { name: 'Cancel' }));
  await dialog.waitFor({ state: 'hidden', ...SHORT });
  assert.equal(server.patches.length, 0);
  await openEdit('release-notes');
  await field.fill('make test');
  await press(dialog.getByRole('button', { name: 'Save' }));
  await dialog.waitFor({ state: 'hidden', ...SHORT });
  assert.ok(server.commands['/api/tasks/1/terminals/default'] === 'make test');

  await openEdit('release-notes');
  await press(dialog.getByRole('button', { name: 'Remove' }));
  await dialog.waitFor({ state: 'hidden', ...SHORT });
  assert.equal(server.commands['/api/tasks/1/terminals/default'], '');
  await openEdit('release-notes');
  assert.equal(await dialog.getByRole('button', { name: 'Remove' }).count(), 0);
  await press(dialog.getByRole('button', { name: 'Cancel' }));
  await dialog.waitFor({ state: 'hidden', ...SHORT });

  for (const agent of ['claude', 'codex', 'opencode', 'notebook']) {
    await openMenu('release-notes', agent);
    assert.equal(await edit.count(), 0, `no editor for ${agent}`);
    await page.keyboard.press('Escape');
    await page.locator('#h5-session-menu-actions').waitFor({ state: 'detached', ...SHORT });
  }

  await openMenu('Remote 7');
  const update = page.getByRole('menuitem', { name: 'This computer needs an update first', exact: true });
  await update.waitFor(SHORT);
  assert.equal(await update.isDisabled(), true);
  assert.equal(await edit.count(), 0);
  await page.keyboard.press('Escape');
  await page.locator('#h5-session-menu-actions').waitFor({ state: 'detached', ...SHORT });

  await openEdit('Remote 8');
  await field.fill('make verify');
  await press(dialog.getByRole('button', { name: 'Save' }));
  await dialog.waitFor({ state: 'hidden', ...SHORT });
  assert.ok(server.commands['/api/remote-servers/8/tasks/1/terminals/default'] === 'make verify');
}

(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const wide of [true, false]) {
      const t = await openPage(browser, wide);
      await checks(t);
      await editChecks(t);
      assert.deepEqual(t.pageErrors, [], `${wide ? 'computer' : 'phone'}: no browser runtime errors`);
      await t.context.close();
    }
    console.log('The initial command of a new terminal passed: folded by default, Recent from the shared page state, the body, cleared after use, other kinds greyed, an older engine disabled, and the session editor loads, saves and removes.');
  } finally {
    await browser.close();
    fs.rmSync(TEMP, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
