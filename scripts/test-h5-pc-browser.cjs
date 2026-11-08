// The MUI page (/h5) on a computer, in real Chromium with mocked servers: input mode 'pointer' (no touch, a mouse) at 1440x900 and 1280x800, and the
// touch mode at phone size for comparison. Checks: no key row, no wheel strip, no keyboard buttons, the draft box always shown, 13px terminal font,
// native titles on icon buttons, Escape closing the saved commands menu from the terminal; Cmd/Ctrl+Enter translates and sends, Alt+Enter sends as typed, Enter is a new line, and a send gives the focus back to the terminal;
// typing with nothing focused reaches the terminal, Escape in the draft box goes back to it, Cmd/Ctrl+K focuses the session search; a shorter window does
// NOT pin the terminal (it was taken for the on-screen keyboard); the terminal "done" acknowledgement (local and remote Engine) and the next-session
// button seeing it idle; folding the sidebar (remembered) and the design document as a right side panel, both refitting the terminal.
// H5_SHOT_DIR=<dir> saves screenshots there (PC 1440x900: sidebar open, folded, design panel; phone 390x844).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';

const TASKS = [{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }, { id: 2, title: 'Write docs', status: 'doing' }];
const TERMINALS = { 1: [{ terminal_id: 'default', title: 'Terminal 1' }, { terminal_id: 'p1', title: 'Pending shell' }], 2: [{ terminal_id: 'd1', title: 'Docs shell' }] };
const DESIGN_MD = ['# Design of Fix login', '', 'Some **design** text.', '', ...Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}.`)].join('\n');
let activity = {}; // { taskId: { terminalId: 'running' | 'done' } } of the local Client
let remoteActivity = {};
const acks = []; // [url, terminal_id] of every acknowledgement
const translations = [];
const pageErrors = [];

async function openPage(browser, { viewport, touch = false, remote = false, storage = null }) {
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...(SHOTS ? { deviceScaleFactor: touch ? 3 : 1 } : {}) });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(saved => {
    if (saved) for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
    window.sockets = [];
    window.FakeSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
      emit(data) { this.onmessage?.({ data }); }
    };
    window.FakeSocket.OPEN = 1;
    window.FakeSocket.CONNECTING = 0;
    window.WebSocket = window.FakeSocket;
  }, storage);
  await page.addInitScript(activityStreamMock); // the pushed terminal activity (window.activityStream)
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    if (url.pathname === '/api/remote-servers') return json(remote ? [{ id: 7, name: 'VPS' }] : []);
    if (url.pathname === '/api/tasks' && method === 'GET') return json(TASKS);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (url.pathname === '/api/tasks/terminal-activity') return json(activity);
    if (url.pathname === '/api/tasks/terminal-subagents') return json({});
    const ack = url.pathname.match(/^(\/api(?:\/remote-servers\/7)?)\/tasks\/(\d+)\/terminal\/ack$/);
    if (ack && method === 'POST') {
      const id = route.request().postDataJSON().terminal_id;
      acks.push([url.pathname, id]);
      const table = ack[1] === '/api' ? activity : remoteActivity;
      if ((table[ack[2]] || {})[id] === 'done') delete table[ack[2]][id]; // the server clears 'done' only
      return json({ success: true });
    }
    const terminals = url.pathname.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (terminals && method === 'GET') return json(TERMINALS[terminals[1]] || []);
    if (url.pathname === '/api/tasks/1/files/content') return json({ path: 'DESIGN.md', content: DESIGN_MD });
    if (/^\/api\/tasks\/\d+\/agent\/conversations$/.test(url.pathname)) return json([]);
    if (url.pathname === '/api/translate') { const { text } = route.request().postDataJSON(); translations.push(text); return json({ text: 'Translated text' }); }
    // A remote Engine through the Client's proxy.
    if (url.pathname === '/api/remote-servers/7/tasks') return json([{ id: 9, title: 'Remote task', status: 'doing' }]);
    if (url.pathname === '/api/remote-servers/7/task-groups') return json([]);
    if (url.pathname === '/api/remote-servers/7/tasks/9/terminals') return json([{ terminal_id: 'r1', title: 'Remote shell' }]);
    if (url.pathname === '/api/remote-servers/7/terminal-activity') return json(remoteActivity);
    if (url.pathname === '/api/remote-servers/7/info') return json({ capabilities: [] });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  return { context, page };
}

const lastSocket = page => page.evaluate(() => window.sockets.at(-1).sent);
const resizes = page => page.evaluate(() => window.sockets.at(-1).sent.map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(item => item && item.type === 'resize'));
const activeIsTerminal = page => page.evaluate(() => Boolean(document.activeElement && document.activeElement.closest('.h5-xterm:not([hidden])')));
async function openTerminal(page, task, terminal, how = 'click') {
  // The terminal names are unique in these mocks; a task that is not open yet is opened first.
  const row = page.locator('#h5-tasks .h5-terminal-main', { hasText: terminal });
  if (!(await row.count())) await page.locator('.h5-task-item', { hasText: task })[how]();
  await row[how]();
  await page.waitForFunction(name => document.getElementById('h5-session-name').textContent === name && window.sockets.length, terminal);
}
async function history(page, cols = 80, rows = 24) {
  await page.evaluate(([c, r]) => window.sockets.at(-1).emit(JSON.stringify({ type: 'history', data: 'ready $ ', cols: c, rows: r })), [cols, rows]);
  await page.waitForTimeout(350); // the replay unpauses input after two frames or 300 ms
}
async function toast(page, text) { await page.locator('.MuiSnackbar-root [role="status"]', { hasText: text }).waitFor({ timeout: 5000 }); }
const waitAck = (url, id, from = 0) => new Promise((resolve, reject) => {
  const started = Date.now();
  const check = () => {
    if (acks.slice(from).some(([u, t]) => u === url && t === id)) resolve();
    else if (Date.now() - started > 8000) reject(new Error(`no ack ${url} ${id}: ${JSON.stringify(acks)}`));
    else setTimeout(check, 50);
  };
  check();
});

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
      const label = `${viewport.width}x${viewport.height}`;
      activity = {};
      const { context, page } = await openPage(browser, { viewport });
      assert.equal(await page.evaluate(() => document.documentElement.dataset.input), 'pointer', `${label}: a mouse and no touch screen is the pointer mode`);
      await page.locator('#h5-tasks').waitFor({ state: 'visible' });
      await openTerminal(page, 'Fix login', 'Terminal 1');
      await history(page);

      // Layout: no key row, no wheel strip, no keyboard buttons; the draft box is shown at rest (one line) with the whole action row.
      assert.equal(await page.locator('#h5-keys').count(), 0, `${label}: no function key row`);
      assert.equal(await page.locator('#h5-wheel').count(), 0, `${label}: no wheel strip`);
      assert.equal(await page.locator('#h5-actions [data-action="keyboard"], #h5-actions [data-action="draft"]').count(), 0, `${label}: no keyboard buttons`);
      const draft = await page.evaluate(() => ({ focused: document.activeElement && document.activeElement.id === 'h5-translate-input', height: document.getElementById('h5-translate').getBoundingClientRect().height, input: document.getElementById('h5-translate-input').getBoundingClientRect().height }));
      assert.equal(draft.focused, false);
      assert.ok(draft.height > 30 && draft.input < 40, `${label}: the draft box is shown as one line without focus (${JSON.stringify(draft)})`);
      for (const id of ['h5-image', 'h5-commands', 'h5-voice', 'h5-design', 'h5-attention', 'h5-cycle', 'h5-translate-send', 'h5-translate-button']) {
        assert.equal(await page.locator(`#${id}`).isVisible(), true, `${label}: #${id} is shown`);
      }
      const bottom = await page.evaluate(() => ({ terminal: document.querySelector('.h5-terminal').getBoundingClientRect().bottom, box: document.getElementById('h5-translate').getBoundingClientRect().top }));
      assert.ok(bottom.terminal <= bottom.box + 1, `${label}: the resting draft box has its own room below the terminal (${JSON.stringify(bottom)})`);
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.h5-xterm:not([hidden]) .xterm-rows')).fontSize), '13px', `${label}: 13px terminal font`);
      assert.equal(await page.locator('#h5-voice').getAttribute('title'), 'Voice input: click to start speaking', `${label}: voice is click to start / stop`);
      // Icon buttons: the native title is the tooltip (no MUI Tooltip any more), the same text as the aria-label; no MUI tooltip opens on hover.
      for (const [id, name] of [['h5-design', 'Docs'], ['h5-attention', 'Attention'], ['h5-commands', 'Saved commands'], ['h5-image', 'Upload image or file'], ['h5-refresh', 'Refresh the page']]) {
        assert.equal(await page.locator(`#${id}`).getAttribute('title'), name, `${label}: #${id} has its title`);
        assert.equal(await page.locator(`#${id}`).getAttribute('aria-label'), name, `${label}: #${id} has its aria-label`);
      }
      await page.locator('#h5-design').hover();
      await page.waitForTimeout(400);
      assert.equal(await page.locator('[role="tooltip"]').count(), 0, `${label}: no MUI tooltip`);
      await page.mouse.move(viewport.width / 2, 200);
      // The saved commands menu: Escape closes it while the focus is in the terminal (xterm stops the keydown, so the menu listens in the capture
      // phase), and that Escape is not typed into the terminal.
      await page.locator('#h5-terminal .xterm-helper-textarea').focus();
      await page.locator('#h5-commands').click();
      await page.locator('.h5-add-menu').waitFor();
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('xterm-helper-textarea')), true, `${label}: the terminal keeps the focus while the menu is open`);
      const typedBefore = (await lastSocket(page)).filter(item => !item.startsWith('{')).length;
      await page.keyboard.press('Escape');
      await page.locator('.h5-add-menu').waitFor({ state: 'detached', timeout: 2000 });
      await page.waitForTimeout(200);
      assert.equal((await lastSocket(page)).filter(item => !item.startsWith('{')).length, typedBefore, `${label}: the Escape that closed the menu was not sent to the terminal`);
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      if (SHOTS && viewport.width === 1440) await page.screenshot({ path: path.join(SHOTS, 'pc-1440-sidebar-open.png') });

      // Typing with nothing focused goes to the terminal, and the terminal keeps the focus.
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      let before = (await lastSocket(page)).length;
      await page.keyboard.type('ls');
      await page.keyboard.press('Enter');
      assert.deepEqual((await lastSocket(page)).slice(before).join(''), 'ls\r', `${label}: keys typed with nothing focused reach the terminal`);
      assert.equal(await activeIsTerminal(page), true, `${label}: and the terminal has the focus`);
      // A click on the terminal focuses it.
      await page.evaluate(() => document.activeElement.blur());
      await page.locator('.h5-xterm:not([hidden])').click({ position: { x: 200, y: 100 } });
      assert.equal(await activeIsTerminal(page), true, `${label}: a click focuses the terminal`);

      // Draft box shortcuts: Cmd/Ctrl+Enter translates and sends, Alt+Enter sends as typed, Enter is a new line; a send returns the focus to the terminal.
      const input = page.locator('#h5-translate-input');
      for (const combo of ['Meta+Enter', 'Control+Enter']) {
        const asked = translations.length;
        await input.click();
        await input.fill('translate me');
        before = (await lastSocket(page)).length;
        await page.keyboard.press(combo);
        await page.waitForFunction(count => window.sockets.at(-1).sent.length >= count + 2, before);
        assert.equal(translations.length, asked + 1, `${label}: ${combo} asks for one translation`);
        assert.deepEqual((await lastSocket(page)).slice(before), ['Translated text', '\r'], `${label}: ${combo} sends the translation, then Enter`);
        assert.equal(await input.inputValue(), '');
        assert.equal(await activeIsTerminal(page), true, `${label}: after ${combo} the terminal has the focus again`);
        assert.ok(await page.locator('#h5-translate').evaluate(el => el.getBoundingClientRect().height > 30), 'the draft box stays shown');
      }
      await input.click();
      await input.fill('echo  as typed');
      before = (await lastSocket(page)).length;
      await page.keyboard.press('Alt+Enter');
      await page.waitForFunction(count => window.sockets.at(-1).sent.length >= count + 2, before);
      assert.deepEqual((await lastSocket(page)).slice(before), ['echo  as typed', '\r'], `${label}: Alt+Enter sends as typed`);
      assert.equal(await activeIsTerminal(page), true);
      await input.click();
      await page.keyboard.type('one');
      await page.keyboard.press('Enter');
      await page.keyboard.type('two');
      assert.equal(await input.inputValue(), 'one\ntwo', `${label}: plain Enter is a new line`);
      const grown = await page.evaluate(() => ({ input: document.getElementById('h5-translate-input').getBoundingClientRect().height, extra: parseFloat(document.getElementById('h5-bottom').style.getPropertyValue('--h5-bar-extra')) || 0 }));
      assert.ok(grown.input > 35 && grown.extra > 10, `${label}: the box grows with its text over the terminal (${JSON.stringify(grown)})`);
      // Escape leaves the draft box for the terminal; the text stays.
      await page.keyboard.press('Escape');
      assert.equal(await activeIsTerminal(page), true, `${label}: Escape in the draft box returns to the terminal`);
      assert.equal(await input.inputValue(), 'one\ntwo');
      await input.fill('');

      // Cmd+K (Ctrl+K on other systems) focuses the session search.
      await page.evaluate(() => document.activeElement.blur());
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'h5-task-search-input');
      await page.evaluate(() => document.activeElement.blur());

      // Regression: a shorter window is not the on-screen keyboard. The terminal is not pinned to its old height or shifted; it refits (fewer rows).
      const rowsBefore = (await resizes(page)).at(-1).rows;
      await page.setViewportSize({ width: viewport.width, height: viewport.height - 300 });
      await page.waitForTimeout(400);
      const pinned = await page.evaluate(() => { const el = document.querySelector('.h5-xterm:not([hidden])'); const host = document.getElementById('h5-terminal').getBoundingClientRect(); const box = el.getBoundingClientRect();
        return { height: el.style.height, transform: el.style.transform, inside: box.top >= host.top - 1 && box.bottom <= host.bottom + 1, page: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--h5-height')), inner: innerHeight }; });
      assert.deepEqual({ height: pinned.height, transform: pinned.transform, inside: pinned.inside }, { height: '', transform: '', inside: true }, `${label}: a shorter window does not pin or shift the terminal`);
      assert.equal(pinned.page, pinned.inner, '--h5-height follows the window height');
      assert.ok((await resizes(page)).at(-1).rows < rowsBefore, `${label}: the terminal refits to the shorter window`);
      await page.setViewportSize(viewport);
      await page.waitForTimeout(300);

      // Folding the sidebar: the page takes the whole width, the terminal refits wider; the choice is remembered over a reload.
      const colsOpen = (await resizes(page)).at(-1).cols;
      assert.equal(await page.locator('#h5-sidebar-toggle').getAttribute('aria-label'), 'Collapse the sidebar');
      await page.locator('#h5-sidebar-toggle').click();
      await page.locator('#h5-tasks').waitFor({ state: 'detached' });
      await page.waitForTimeout(300);
      assert.deepEqual(await page.locator('#h5-app').boundingBox().then(box => [box.x, box.width]), [0, viewport.width], `${label}: folded, the page is full width`);
      assert.ok((await resizes(page)).at(-1).cols > colsOpen, `${label}: the terminal refits wider`);
      assert.equal(await page.locator('#h5-sidebar-toggle').getAttribute('aria-label'), 'Expand the sidebar');
      assert.equal(await page.evaluate(() => localStorage.getItem('h5-sidebar-collapsed')), '1');
      if (SHOTS && viewport.width === 1440) { await page.mouse.move(viewport.width / 2, 300); await page.waitForTimeout(300); await page.screenshot({ path: path.join(SHOTS, 'pc-1440-sidebar-collapsed.png') }); }
      await page.reload();
      await page.locator('#h5-sidebar-toggle[aria-label="Expand the sidebar"]').waitFor();
      assert.equal(await page.locator('#h5-tasks').count(), 0, 'still folded after a reload');
      await page.locator('#h5-sidebar-toggle').click();
      await page.locator('#h5-tasks').waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => localStorage.getItem('h5-sidebar-collapsed')), null);
      await page.waitForFunction(() => window.sockets.length && document.getElementById('h5-session-name').textContent === 'Terminal 1');
      await history(page);

      // The design document opens as a panel on the right, beside the terminal (not a bottom sheet); the terminal refits narrower; Escape closes it.
      const colsBefore = (await resizes(page)).at(-1).cols;
      await page.locator('#h5-design').click();
      await page.locator('.h5-design-side h1', { hasText: 'Design of Fix login' }).waitFor({ timeout: 10000 });
      await page.waitForTimeout(500); // the slide-in
      const panel = await page.locator('.h5-design-side').boundingBox();
      const app = await page.locator('#h5-app').boundingBox();
      assert.ok(Math.abs(panel.x + panel.width - viewport.width) <= 1 && panel.height >= viewport.height - 1, `${label}: a full-height panel at the right edge (${JSON.stringify(panel)})`);
      assert.ok(app.x + app.width <= panel.x + 1, `${label}: the page ends where the panel starts`);
      assert.equal(await page.locator('.MuiBackdrop-root').count(), 0, 'the page is not dimmed');
      assert.ok((await resizes(page)).at(-1).cols < colsBefore, `${label}: the terminal refits narrower beside the panel`);
      if (SHOTS && viewport.width === 1440) await page.screenshot({ path: path.join(SHOTS, 'pc-1440-design-panel.png') });
      await page.locator('#h5-design-body').focus();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-side-panel'));
      await page.waitForTimeout(300);
      assert.ok(Math.abs((await page.locator('#h5-app').boundingBox()).width - app.width - panel.width) <= 2, `${label}: closed, the page is wide again`);

      // Acknowledgement (once): showing a Pending terminal acks it; the next-session button then finds nothing pending.
      if (viewport.width === 1440) {
        activity = { 1: { p1: 'done' } };
        const from = acks.length;
        await openTerminal(page, 'Fix login', 'Pending shell');
        await waitAck('/api/tasks/1/terminal/ack', 'p1', from);
        assert.deepEqual(activity, { 1: {} }, 'the server cleared the pending state');
        const push = snapshot => page.waitForFunction(snap => window.activityStream.push('/api/tasks/terminal-activity/stream', snap), snapshot);
        await push({ activity, subagents: {} }); // the server pushes the cleared state
        await page.locator('#h5-cycle').click();
        await toast(page, 'No running or pending sessions');
        // The shown terminal finishes while it is on screen: the pushed 'done' makes the page ack it again by itself.
        const again = acks.length;
        activity = { 1: { p1: 'done' } };
        await push({ activity, subagents: {} });
        await waitAck('/api/tasks/1/terminal/ack', 'p1', again);
        assert.deepEqual(activity, { 1: {} });
      }
      await context.close();
    }

    // Saved commands follow the kind of the open terminal: Claude Code slash commands in a Claude terminal, Codex slash commands in a Codex terminal,
    // and the "Start an agent" shell list in a plain terminal. Paste text is always first, and a preset is typed WITHOUT Enter.
    {
      const saved = TERMINALS[2];
      TERMINALS[2] = [{ terminal_id: 'd1', title: 'Docs shell' }, { terminal_id: 'dc', title: 'Claude docs', agent: 'claude' }, { terminal_id: 'dx', title: 'Codex docs', agent: 'codex' }];
      activity = {};
      const { context, page } = await openPage(browser, { viewport: { width: 1440, height: 900 } });
      await page.locator('#h5-tasks').waitFor({ state: 'visible' });
      const menu = async () => {
        await page.locator('#h5-commands').click();
        await page.locator('.h5-add-menu').waitFor();
        const out = await page.evaluate(() => ({
          head: [...document.querySelectorAll('.h5-add-menu .h5-add-menu-head')].map(node => node.textContent),
          first: document.querySelector('.h5-add-menu [role="menuitem"]').textContent,
          commands: [...document.querySelectorAll('.h5-add-menu .h5-add-menu-command')].map(node => node.textContent),
          keys: [...document.querySelectorAll('.h5-add-menu .h5-add-menu-key')].map(node => node.textContent),
          notes: [...document.querySelectorAll('.h5-add-menu .h5-add-menu-note')].map(node => node.textContent),
        }));
        assert.equal(out.first, 'Paste text', 'Paste text is the first item');
        assert.equal(out.notes.length, out.commands.length + out.keys.length, 'every preset and key has a description');
        assert.ok(out.notes.every(Boolean));
        return out;
      };
      const closeMenu = async () => { await page.locator('#h5-commands').click(); await page.locator('.h5-add-menu').waitFor({ state: 'detached' }); }; // a second click on the button closes it
      await openTerminal(page, 'Write docs', 'Docs shell');
      await history(page);
      const shell = await menu();
      assert.deepEqual(shell.head, ['Start an agent']);
      assert.deepEqual(shell.keys, [], 'a plain terminal has no key group');
      assert.deepEqual(shell.commands, ['claude', 'claude --continue', 'claude --resume', 'codex', 'codex resume', 'git status'], 'a plain terminal lists the commands that start an agent');
      await closeMenu();
      await openTerminal(page, 'Write docs', 'Claude docs');
      await history(page);
      const claude = await menu();
      assert.deepEqual(claude.head, ['Claude Code commands', 'Keys']);
      assert.deepEqual(claude.keys, ['Shift+Tab', 'Esc', 'Esc Esc', 'Ctrl+C', 'Ctrl+R', 'Ctrl+O', 'Ctrl+G', 'Ctrl+J'], 'a Claude terminal lists its key combinations after the commands');
      assert.deepEqual(claude.commands, ['/clear', '/compact', '/resume', '/model', '/context', '/usage', '/diff', '/rewind', '/review', '/init', '/memory', '/mcp'], 'a Claude terminal lists Claude Code slash commands');
      // A preset is typed into the terminal without Enter.
      const socket = await page.evaluate(() => window.sockets.length - 1);
      const typed = () => page.evaluate(index => window.sockets[index].sent.filter(item => !item.startsWith('{')), socket);
      const before = (await typed()).length;
      await page.locator('.h5-add-menu [role="menuitem"]', { hasText: '/compact' }).click();
      await page.waitForFunction(([index, count]) => window.sockets[index].sent.filter(item => !item.startsWith('{')).length > count, [socket, before]);
      assert.deepEqual((await typed()).slice(before), ['/compact'], 'the slash command is typed without Enter');
      assert.equal(await page.locator('.h5-add-menu').count(), 0, 'the menu closes after a command is chosen');
      await openTerminal(page, 'Write docs', 'Codex docs');
      await history(page);
      const codex = await menu();
      assert.deepEqual(codex.head, ['Codex commands', 'Keys']);
      assert.deepEqual(codex.commands, ['/new', '/resume', '/compact', '/model', '/permissions', '/status', '/diff', '/review', '/mention', '/plan', '/init', '/mcp'], 'a Codex terminal lists Codex slash commands');
      assert.deepEqual(codex.keys, ['Shift+Tab', 'Shift+Left', 'Esc', 'Esc Esc', 'Ctrl+C', 'Ctrl+R', 'Ctrl+T', 'Ctrl+G', 'Ctrl+J'], 'a Codex terminal lists its key combinations after the commands');
      await closeMenu();
      await context.close();
      TERMINALS[2] = saved;
    }

    // The "Keys" group on a phone (touch) in a Codex terminal: a tap SENDS the key bytes at once and closes the list; a latched Ctrl from row 1 is
    // dropped, not added to the key (and not left for the next character); Esc Esc arrives as two separate presses.
    {
      const saved = TERMINALS[2];
      TERMINALS[2] = [{ terminal_id: 'dx', title: 'Codex docs', agent: 'codex' }];
      const { context, page } = await openPage(browser, { viewport: { width: 390, height: 844 }, touch: true });
      await page.locator('#h5-tasks').waitFor({ state: 'visible' });
      await openTerminal(page, 'Write docs', 'Codex docs', 'tap');
      await history(page);
      const socket = await page.evaluate(() => window.sockets.length - 1);
      const typed = () => page.evaluate(index => window.sockets[index].sent.filter(item => !item.startsWith('{')), socket);
      const pick = async label => {
        await page.locator('#h5-commands').tap();
        await page.locator('.h5-add-menu').waitFor();
        const item = page.locator('.h5-add-menu [role="menuitem"]').filter({ has: page.locator('.h5-add-menu-key', { hasText: new RegExp(`^${label.replace('+', '\\+')}$`) }) });
        assert.equal(await item.count(), 1, `one ${label} entry`);
        const box = await item.boundingBox();
        assert.ok(box.height >= 44, `${label}: a 44px touch target`);
        await item.tap();
        await page.locator('.h5-add-menu').waitFor({ state: 'detached' });
      };
      if (SHOTS) {
        await page.locator('#h5-commands').tap();
        await page.locator('.h5-add-menu').waitFor();
        await page.evaluate(() => { const menu = document.querySelector('.h5-add-menu'); const head = [...menu.querySelectorAll('.h5-add-menu-head')].at(-1); menu.scrollTop = head.offsetTop - 120; });
        await page.screenshot({ path: path.join(SHOTS, 'agent-keys-codex-390.png') });
        await page.locator('#h5-commands').tap();
        await page.locator('.h5-add-menu').waitFor({ state: 'detached' });
      }
      let before = (await typed()).length;
      await pick('Shift+Tab');
      await page.waitForFunction(([index, count]) => window.sockets[index].sent.filter(item => !item.startsWith('{')).length > count, [socket, before]);
      assert.deepEqual((await typed()).slice(before), ['\x1b[Z'], 'Shift+Tab sends the back-tab sequence, without Enter');
      before = (await typed()).length;
      await pick('Shift+Left');
      await page.waitForFunction(([index, count]) => window.sockets[index].sent.filter(item => !item.startsWith('{')).length > count, [socket, before]);
      assert.deepEqual((await typed()).slice(before), ['\x1b[1;2D'], 'Shift+Left sends its xterm sequence');
      // A latched Ctrl is not applied to the key, and it is released.
      await page.locator('#h5-keys [data-modifier="ctrl"]').tap();
      assert.equal(await page.locator('#h5-keys button[aria-pressed="true"]').count(), 1, 'Ctrl is latched');
      before = (await typed()).length;
      await pick('Ctrl+R');
      await page.waitForFunction(([index, count]) => window.sockets[index].sent.filter(item => !item.startsWith('{')).length > count, [socket, before]);
      assert.deepEqual((await typed()).slice(before), ['\x12'], 'Ctrl+R is sent once, unchanged by the latched Ctrl');
      assert.equal(await page.locator('#h5-keys button[aria-pressed="true"]').count(), 0, 'the latch is released');
      before = (await typed()).length;
      await pick('Esc Esc');
      await page.waitForFunction(([index, count]) => window.sockets[index].sent.filter(item => !item.startsWith('{')).length >= count + 2, [socket, before]);
      assert.deepEqual((await typed()).slice(before), ['\x1b', '\x1b'], 'Esc Esc is two separate presses');
      await context.close();
      TERMINALS[2] = saved;
    }

    // A remote Engine: the ack goes through the Client's proxy with the same task base as the other calls.
    {
      remoteActivity = { 9: { r1: 'done' } };
      const { context, page } = await openPage(browser, { viewport: { width: 1440, height: 900 }, remote: true });
      await page.locator('#h5-engine').selectOption('remote:7');
      const from = acks.length;
      await openTerminal(page, 'Remote task', 'Remote shell');
      await waitAck('/api/remote-servers/7/tasks/9/terminal/ack', 'r1', from);
      assert.deepEqual(remoteActivity, { 9: {} });
      await context.close();
    }

    // The phone (touch mode) keeps its layout; it now acks a Pending terminal when it is shown, like pointer mode.
    {
      activity = { 1: { p1: 'done' } };
      const { context, page } = await openPage(browser, { viewport: { width: 390, height: 844 }, touch: true });
      assert.equal(await page.evaluate(() => document.documentElement.dataset.input), 'touch');
      await page.locator('#h5-tasks').waitFor({ state: 'visible' });
      const from = acks.length;
      await openTerminal(page, 'Fix login', 'Pending shell', 'tap');
      await waitAck('/api/tasks/1/terminal/ack', 'p1', from);
      await history(page, 40, 30);
      assert.equal(await page.locator('#h5-keys').isVisible(), true, 'phone: the key row is shown');
      assert.equal(await page.locator('#h5-wheel').count(), 1, 'phone: the wheel strip is there');
      assert.equal(await page.locator('#h5-actions [data-action="keyboard"]').isVisible(), true, 'phone: the keyboard buttons are shown');
      assert.equal(await page.evaluate(() => document.getElementById('h5-translate').getBoundingClientRect().height), 0, 'phone: the draft box is hidden at rest');
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.h5-xterm:not([hidden]) .xterm-rows')).fontSize), '11px', 'phone: 11px terminal font');
      assert.equal(await page.locator('#h5-sidebar-toggle').count(), 0, 'phone: no sidebar toggle');
      assert.equal(await activeIsTerminal(page), false, 'phone: showing a terminal does not focus it (no on-screen keyboard)');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'phone-390-unchanged.png') });
      await context.close();
    }
    assert.deepEqual(pageErrors, [], 'no runtime errors');
    console.log('MUI page on a computer: pointer layout, shortcuts, typing to the terminal, Escape, Cmd/Ctrl+K, no pinning on a shorter window, ack (local, remote, phone), sidebar folding, the design side panel and the saved commands of each terminal kind passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
