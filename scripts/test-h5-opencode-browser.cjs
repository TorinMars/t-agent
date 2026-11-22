// OpenCode as the third agent of the page ("Session menu" in docs/design/page-task-list.md), in real Chromium with the routes mocked, at computer
// size (1440x900, a mouse) and phone size (390x844, touch):
// - New session: the first list is Claude session, Codex session, OpenCode session, New Terminal, each with its mark (the OpenCode mark is two
//   rectangles, never Claude's sparkle); a press on OpenCode session opens its sub-list from GET …/agent-sessions?agent=opencode (New OpenCode session,
//   the earlier sessions with the time they were last used, Back); New OpenCode session and Enter on the highlighted kind make a terminal with
//   agent 'opencode'.
// - An Engine whose /info does not list 'terminal:opencode' shows the row greyed with "<engine> needs an update first"; it is not a keyboard choice
//   and a press does nothing. An Engine that lists it offers it.
// - The marks and names of OpenCode terminals: the task list's tile, the Recent tab, the session switcher (phone).
// - Saved commands: an OpenCode terminal lists "OpenCode commands" and its keys; a plain shell lists `opencode` and `opencode -c`.
// SCREENSHOTS=<dir> saves the dialogs and lists.
const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { settled } = require('./browser-test-wait.cjs');

// A temporary data folder, so nothing here can reach the person's own data (the page itself only talks to the mocked routes).
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-opencode-browser-'));
process.env.T_AGENT_DATA_DIR = TEMP;

const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.SCREENSHOTS || '';
const SHORT = { timeout: 3000 };
const CHOICES = ['Claude session', 'Codex session', 'OpenCode session', 'New Terminal'];
const OC_COMMANDS = ['/new', '/sessions', '/compact', '/models', '/agents', '/undo', '/redo', '/diff', '/status', '/help'];
const OC_KEYS = ['Esc', 'Tab', 'Ctrl+J', 'Ctrl+X B', 'Ctrl+X L'];
// 11-22 18:40 and 11-21 09:12 in the browser's time zone (the page shows local time).
const AT_1 = new Date(2026, 10, 22, 18, 40).getTime();
const AT_2 = new Date(2026, 10, 21, 9, 12).getTime();
const SESSIONS = [{ id: 'ses_a1', title: 'Fix the flaky release test', updated_at: AT_1 }, { id: 'ses_b2', title: 'Write the 2.152 release notes', updated_at: AT_2 },
  { id: 'ses_c3xyz789ab', title: 'yz789ab', untitled: true, updated_at: AT_2 - 60000 }]; // still on opencode's default title: shown as Untitled session
const LOCAL_TASKS = [{ id: 1, title: 'release-notes', status: 'doing' }];
const TERMINALS = [
  { terminal_id: 'default', title: 'Terminal 1' },
  { terminal_id: 'cl1', title: 'Claude 1', agent: 'claude' },
  { terminal_id: 'oc1', title: 'Write the 2.152 release notes', agent: 'opencode' },
];
const REMOTES = [{ id: 7, name: 'K01', capabilities: ['terminal:control'] }, { id: 8, name: 'K02', capabilities: ['terminal:control', 'terminal:opencode'] }];

async function openPage(browser, wide) {
  const viewport = wide ? { width: 1440, height: 900 } : { width: 390, height: 844 };
  const context = await browser.newContext(wide ? { viewport, ...(SHOTS ? { deviceScaleFactor: 2 } : {}) } : { viewport, isMobile: true, hasTouch: true, ...(SHOTS ? { deviceScaleFactor: 3 } : {}) });
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
  });
  const server = { posts: [], sessionQueries: [] };
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const { pathname } = url;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
    if (pathname === '/auth/me') return json({ effective_work_dir: '/home/t/tasks' });
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
      return json({ terminal_id: `fresh-${server.posts.length}`, title: body.title || 'OpenCode 2', agent: body.agent || null }, 201);
    }
    if (/^\/api\/tasks\/1\/terminals$/.test(pathname) && method === 'GET') return json(TERMINALS);
    if (/^\/api\/remote-servers\/\d+\/tasks\/1\/terminals$/.test(pathname) && method === 'GET') return json([{ terminal_id: 'default', title: 'Terminal 1' }]);
    if (/\/agent-sessions$/.test(pathname)) {
      server.sessionQueries.push(`${pathname}?${url.searchParams.toString()}`);
      return json(url.searchParams.get('agent') === 'opencode' ? SESSIONS : []);
    }
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
  const labels = () => choices.locator('.h5-choice-label').allTextContents();
  // New session of a task row: its "+" on a computer; on a touch screen "New session" in its "⋯" menu.
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
  return { context, page, server, pageErrors, wide, press, row, openSheet, choices, labels, openDialog, closeDialog };
}

// The marks of the choices: the kind each row names, whether the mark is the two-rectangle OpenCode mark, and the glyph drawn by CSS.
const marks = page => page.evaluate(() => [...document.querySelectorAll('#h5-new-session #h5-term-menu-actions button')].map(button => {
  const mark = button.querySelector('.h5-choice-mark');
  if (!mark) return null;
  return { mark: mark.dataset.mark, rects: mark.querySelectorAll('svg rect').length, glyph: mark.dataset.glyph || '', disabled: button.disabled, note: button.querySelector('.h5-choice-note')?.textContent || '' };
}));
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) }); };

async function dialogChecks(t) {
  const { page, server, wide, choices, labels } = t;
  const size = wide ? 'computer' : 'phone';
  // This machine: the four kinds, each with its mark.
  await t.openDialog('release-notes');
  assert.deepEqual(await labels(), CHOICES, `${size}: the choices, OpenCode session after Codex`);
  const first = await marks(page);
  assert.deepEqual(first.map(item => item.mark), ['claude', 'codex', 'opencode', 'shell'], `${size}: each row starts with its mark`);
  assert.equal(first[2].rects, 2, `${size}: the OpenCode mark is the self-drawn block, not the Claude sparkle`);
  assert.deepEqual(first.map(item => item.glyph), ['✳', '', '', '>_'], `${size}: the text marks are drawn by CSS`);
  assert.ok(first.every(item => !item.disabled && !item.note), `${size}: this machine runs every kind`);
  assert.deepEqual(await choices.allTextContents(), CHOICES, `${size}: a row's text is only its words`);
  await shot(page, `${size}-1-new-session.png`);
  // The OpenCode sub-list: New OpenCode session, the earlier sessions newest first with their time, Back.
  await t.press(choices.filter({ hasText: 'OpenCode session' }));
  await choices.filter({ hasText: 'Fix the flaky release test' }).waitFor();
  assert.equal(server.sessionQueries.at(-1), '/api/tasks/1/agent-sessions?agent=opencode', `${size}: the sessions of the folder are asked for`);
  assert.deepEqual(await labels(), ['New OpenCode session', 'Fix the flaky release test', 'Write the 2.152 release notes', 'Untitled session', 'Back'], `${size}: the OpenCode sub-list`);
  assert.equal(await page.locator('#h5-new-session-sub').textContent(), 'OpenCode session', `${size}: the sub-list is named`);
  const sub = await marks(page);
  assert.deepEqual(sub.map(item => item.mark), ['opencode', 'opencode', 'opencode', 'opencode', 'back'], `${size}: the sub-list marks`);
  assert.deepEqual(sub.map(item => item.note), ['', '11-22 18:40', '11-21 09:12', '11-21 09:11', ''], `${size}: an earlier session shows when it was last used`);
  await shot(page, `${size}-2-opencode-list.png`);
  await t.press(choices.filter({ hasText: 'New OpenCode session' }));
  await page.locator('#h5-new-session').waitFor({ state: 'detached', ...SHORT });
  assert.deepEqual(server.posts.at(-1), ['/api/tasks/1/terminals', { agent: 'opencode' }], `${size}: New OpenCode session makes an OpenCode terminal`);
  // An earlier session resumes it.
  await t.openDialog('release-notes');
  await t.press(choices.filter({ hasText: 'OpenCode session' }));
  await choices.filter({ hasText: 'Write the 2.152 release notes' }).waitFor();
  await t.press(choices.filter({ hasText: 'Write the 2.152 release notes' }));
  await page.locator('#h5-new-session').waitFor({ state: 'detached', ...SHORT });
  assert.deepEqual(server.posts.at(-1), ['/api/tasks/1/terminals', { agent: 'opencode', session_id: 'ses_b2' }], `${size}: an earlier session is resumed`);

  // An older Engine (K01): greyed, with the reason, not a choice, and a press does nothing.
  await t.openDialog('Remote 7');
  await page.waitForFunction(() => document.querySelector('#h5-new-session .h5-choice-note'), null, SHORT);
  assert.deepEqual(await labels(), CHOICES, `${size}: K01 lists the same kinds`);
  const old = await marks(page);
  assert.deepEqual(old.map(item => item.disabled), [false, false, true, false], `${size}: OpenCode session is greyed on K01`);
  assert.equal(old[2].note, 'K01 needs an update first', `${size}: the row says why`);
  assert.equal(await choices.nth(2).getAttribute('role'), null, `${size}: the greyed row is not a keyboard choice`);
  if (wide) {
    await page.locator('#h5-new-name-input').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const on = await page.evaluate(() => [...document.querySelectorAll('#h5-term-menu-actions [aria-selected="true"]')].map(node => node.textContent));
    assert.deepEqual(on, ['New Terminal'], 'Down from Codex session skips the greyed row');
  }
  await shot(page, `${size}-3-older-engine.png`);
  const before = server.posts.length;
  await choices.nth(2).dispatchEvent('click');
  await page.waitForTimeout(200);
  assert.equal(server.posts.length, before, `${size}: a press on the greyed row makes nothing`);
  assert.deepEqual(await labels(), CHOICES, `${size}: and opens no sub-list`);
  await t.closeDialog();
  // An Engine that lists terminal:opencode (K02) offers it.
  await t.openDialog('Remote 8');
  const fresh = await marks(page);
  assert.deepEqual(fresh.map(item => item.disabled), [false, false, false, false], `${size}: K02 offers OpenCode session`);
  await t.press(choices.filter({ hasText: 'OpenCode session' }));
  await choices.filter({ hasText: 'New OpenCode session' }).waitFor();
  assert.equal(server.sessionQueries.at(-1), '/api/remote-servers/8/tasks/1/agent-sessions?agent=opencode', `${size}: K02's sessions are asked for`);
  await t.closeDialog();
}

// The task list's tile of an OpenCode terminal, its saved commands, the Recent tab and (phone) the switcher.
async function listChecks(t) {
  const { page, wide, press } = t;
  const size = wide ? 'computer' : 'phone';
  await t.openSheet();
  const list = page.locator('#h5-tasks .h5-terminal-list').first();
  if (!(await list.isVisible().catch(() => false))) await press(page.locator('#h5-tasks .h5-task-item', { hasText: 'release-notes' }));
  const ocRow = page.locator('#h5-tasks .h5-terminal-row', { hasText: 'Write the 2.152 release notes' }).first();
  await ocRow.waitFor();
  const tile = await ocRow.locator('.h5-terminal-icon').evaluate(node => ({ cls: node.className, title: node.getAttribute('title'), rects: node.querySelectorAll('svg rect').length, text: node.textContent }));
  assert.ok(tile.cls.includes('opencode'), `${size}: the tile is an OpenCode one`);
  assert.equal(tile.title, 'OpenCode session', `${size}: the tile names the kind`);
  assert.equal(tile.rects, 2, `${size}: the tile draws the OpenCode mark`);
  assert.ok(!tile.text.includes('✳'), `${size}: not Claude's sparkle`);
  await shot(page, `${size}-4-task-rows.png`);
  // Open the OpenCode terminal: its saved commands.
  await press(ocRow.locator('.h5-terminal-main'));
  await page.waitForFunction(() => (document.getElementById('h5-session-name') || {}).textContent === 'Write the 2.152 release notes', null, SHORT);
  if (!wide) await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
  await press(page.locator('#h5-commands'));
  await page.locator('.h5-add-menu').waitFor();
  const menu = await page.evaluate(() => ({
    head: [...document.querySelectorAll('.h5-add-menu .h5-add-menu-head')].map(node => node.textContent),
    commands: [...document.querySelectorAll('.h5-add-menu .h5-add-menu-command')].map(node => node.textContent),
    keys: [...document.querySelectorAll('.h5-add-menu .h5-add-menu-key')].map(node => node.textContent),
  }));
  assert.deepEqual(menu.head, ['OpenCode commands', 'Keys'], `${size}: an OpenCode terminal shows its own list`);
  assert.deepEqual(menu.commands, OC_COMMANDS, `${size}: the OpenCode commands`);
  assert.deepEqual(menu.keys, OC_KEYS, `${size}: the OpenCode keys`);
  await shot(page, `${size}-5-commands.png`);
  // A tap on Ctrl+X B sends the leader key, then b.
  const sentBefore = await page.evaluate(() => window.sent.length);
  await press(page.locator('.h5-add-menu [role="menuitem"]').filter({ has: page.locator('.h5-add-menu-key', { hasText: /^Ctrl\+X B$/ }) }));
  await page.waitForFunction(count => window.sent.slice(count).filter(item => !item.startsWith('{')).length >= 2, sentBefore, SHORT);
  assert.deepEqual(await page.evaluate(count => window.sent.slice(count).filter(item => !item.startsWith('{')), sentBefore), ['\x18', 'b'], `${size}: Ctrl+X B is two presses`);
  await page.locator('.h5-add-menu').waitFor({ state: 'detached', ...SHORT });
  // A plain shell lists opencode and opencode -c.
  await t.openSheet();
  await press(page.locator('#h5-tasks .h5-terminal-row', { hasText: 'Terminal 1' }).first().locator('.h5-terminal-main'));
  await page.waitForFunction(() => (document.getElementById('h5-session-name') || {}).textContent === 'Terminal 1', null, SHORT);
  if (!wide) await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
  await press(page.locator('#h5-commands'));
  await page.locator('.h5-add-menu').waitFor();
  const shell = await page.locator('.h5-add-menu .h5-add-menu-command').allTextContents();
  assert.ok(shell.includes('opencode') && shell.includes('opencode -c'), `${size}: the shell list starts OpenCode (${shell.join(', ')})`);
  assert.ok(shell.indexOf('opencode') > shell.indexOf('codex resume'), `${size}: after the Codex entries`);
  await press(page.locator('#h5-commands'));
  await page.locator('.h5-add-menu').waitFor({ state: 'detached', ...SHORT });
  // The Recent tab: the OpenCode session with its mark and kind.
  await t.openSheet();
  await press(page.locator('#h5-tab-recent'));
  const recent = page.locator('.h5-recent-row', { hasText: 'Write the 2.152 release notes' });
  await recent.waitFor(SHORT);
  const recentTile = await recent.locator('.h5-terminal-icon').evaluate(node => ({ cls: node.className, title: node.getAttribute('title'), rects: node.querySelectorAll('svg rect').length }));
  assert.ok(recentTile.cls.includes('opencode') && recentTile.rects === 2, `${size}: the Recent row draws the OpenCode mark`);
  assert.equal(recentTile.title, 'OpenCode session', `${size}: the Recent row names the kind`);
  await shot(page, `${size}-6-recent.png`);
  await press(page.locator('#h5-tab-tasks'));
  if (!wide) {
    // The session switcher: the OpenCode card's label.
    await page.locator('#h5-tasks .h5-scrim, .MuiBackdrop-root').first().tap({ position: { x: 380, y: 400 } }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    await page.locator('#h5-tasks').waitFor({ state: 'hidden', ...SHORT }).catch(() => {});
    await page.locator('#h5-cycle').tap();
    await page.locator('#h5-switcher .h5-switcher-card').first().waitFor(SHORT);
    await settled(page);
    const card = await page.evaluate(() => [...document.querySelectorAll('#h5-switcher .h5-terminal-icon.opencode')].map(node => ({ title: node.getAttribute('title'), rects: node.querySelectorAll('svg rect').length })));
    assert.ok(card.length >= 1 && card.every(item => item.rects === 2), `${size}: the switcher draws the OpenCode mark (${JSON.stringify(card)})`);
    assert.ok(card.some(item => item.title === 'OpenCode session'), `${size}: the switcher card names the kind`);
    await shot(page, `${size}-7-switcher.png`);
  }
}

(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const wide of [true, false]) {
      const t = await openPage(browser, wide);
      await dialogChecks(t);
      await listChecks(t);
      assert.deepEqual(t.pageErrors, [], `${wide ? 'computer' : 'phone'}: no browser runtime errors`);
      await t.context.close();
    }
    console.log('OpenCode sessions in the page passed: the New session dialog and its sub-list, the greyed row of an older Engine, marks, names and saved commands.');
  } finally {
    await browser.close();
    fs.rmSync(TEMP, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
