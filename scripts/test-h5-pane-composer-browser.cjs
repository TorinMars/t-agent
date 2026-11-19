// The compact bottom area of a column of the multi-column view (Terminal.jsx CompactBottom, "Compact bottom area of a column" in
// docs/design/page-terminal-and-bottom-bar.md), in real Chromium with the real top page and four real pane iframes, the API mocked.
// A computer at 1440x900: the bottom area of every column is one row of 52px, focused or not; no column is focused before a press, so no column
// shows a button; the column the person presses (or Tab moves into, or the top page focuses with Ctrl+Alt+Right) shows the draft box, Upload image or
// file, Voice input, More tools and Translate and send, and every other column only its quiet draft box; the terminals' sizes never change when the
// focus moves (no PTY resize, the same terminal box), also with a draft of several lines that grows over the terminal; an unsent draft shows a
// "Draft" tag and its first line in an unfocused column and comes back whole when the column is focused again; every item of More tools does what
// its old button did (the saved commands list, Docs, the next running or pending session with its count, which the More tools button shows as a
// badge, Send as typed without translating); Enter translates and sends, Alt+Enter sends as typed, the Translate and send button translates; a
// running translation and a recording keep the buttons shown in a column that lost the focus. A tablet at 1280x800 (touch input): the row is 56px,
// every button 44px, More tools also has Terminal keyboard, which shows the function keys and the on-screen keyboard.
// H5_SHOT_DIR=<dir> saves screenshots: four columns with one focused, a draft in an unfocused column, the More tools menu, and the touch row.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const IDS = ['a', 'b', 'c', 'd'];
const TASKS = [{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }, { id: 2, title: 'Write docs', status: 'doing', work_dir: '/work/docs' }];
const TERMINALS = { 1: [{ terminal_id: 't1', title: 'Shell one' }, { terminal_id: 't2', title: 'Shell two' }], 2: [{ terminal_id: 't3', title: 'Docs shell' }, { terminal_id: 't4', title: 'Notes shell' }] };
// Each column remembers its own task and terminal, so all four show a terminal at once.
const STORAGE = {
  'h5-columns': JSON.stringify({ on: true, ids: IDS }),
  'pane:a:h5-task:local': '1', 'pane:a:h5-terminal:local:1': 't1',
  'pane:b:h5-task:local': '1', 'pane:b:h5-terminal:local:1': 't2',
  'pane:c:h5-task:local': '2', 'pane:c:h5-terminal:local:2': 't3',
  'pane:d:h5-task:local': '2', 'pane:d:h5-terminal:local:2': 't4',
};
// Two running terminals (t1 of Fix login, t3 of Write docs): the count of "Next running or pending session".
const ACTIVITY = { 1: { t1: 'running' }, 2: { t3: 'running' } };
const pageErrors = [];

async function openPage(browser, { viewport, tablet = false }) {
  const server = { translations: [], holdTranslation: null };
  const context = await browser.newContext({ viewport, ...(tablet ? { hasTouch: true } : {}) });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(saved => {
    if (window === window.top && !sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
    }
    window.inbox = [];
    window.addEventListener('message', event => { if (event.data && event.data.type === 't-agent-pane') window.inbox.push([Date.now() % 100000, event.data.paneId || '-', event.data.event, event.data.on]); });
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
  }, STORAGE);
  await page.addInitScript(activityStreamMock);
  await context.route(`${ORIGIN}/**`, async route => {
    const address = new URL(route.request().url());
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const p = address.pathname;
    if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
    if (p === '/api/remote-servers') return json([]);
    if (p === '/api/tasks' && method === 'GET') return json(TASKS);
    if (p === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (p === '/api/tasks/terminal-activity') return json(ACTIVITY); // a pane polls it (the top page's stream is its own)
    if (p === '/api/tasks/terminal-subagents') return json({});
    if (/^\/api\/tasks\/\d+\/terminal\/ack$/.test(p)) return json({ success: true });
    const terminals = p.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (terminals && method === 'GET') return json(TERMINALS[terminals[1]] || []);
    if (/^\/api\/tasks\/\d+\/agent\/conversations$/.test(p)) return json([]);
    if (/^\/api\/tasks\/\d+\/files\/content$/.test(p)) return json({ path: 'DESIGN.md', content: '# Design\n\nA test document.', size: 26 });
    if (p === '/api/translate') {
      const body = JSON.parse(route.request().postData() || '{}');
      server.translations.push(body.text);
      if (server.holdTranslation) await server.holdTranslation;
      return json({ text: `EN(${body.text})` });
    }
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  return { context, page, server };
}

const paneFrame = (page, id) => page.frames().find(frame => frame.url().endsWith(`/h5?pane=${id}`));
const until = async (check, message, ms = 8000) => {
  const started = Date.now();
  for (;;) {
    if (await check()) return;
    assert.ok(Date.now() - started < ms, message);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

// What a column's bottom area shows: the row and the whole area's heights, whether it is the focused column, the buttons drawn (ids), the draft tag,
// the terminal box, the draft box height, and the last PTY size its socket sent (and how many resizes).
const rowOf = frame => frame.evaluate(() => {
  const bottom = document.getElementById('h5-bottom');
  const drawn = el => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const socket = window.sockets.filter(s => s.url.includes('/terminal/ws')).at(-1);
  const resizes = socket ? socket.sent.map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(item => item && item.type === 'resize') : [];
  const peek = document.getElementById('h5-draft-peek');
  const last = resizes.at(-1);
  return {
    row: Math.round(document.getElementById('h5-row').getBoundingClientRect().height),
    bottom: Math.round(bottom.getBoundingClientRect().height),
    focused: bottom.hasAttribute('data-focused'),
    buttons: [...bottom.querySelectorAll('button, label')].filter(drawn).map(el => el.id || el.getAttribute('aria-label')),
    peek: peek ? peek.textContent : null,
    box: Math.round(document.getElementById('h5-translate').getBoundingClientRect().height),
    terminal: document.getElementById('h5-terminal').clientHeight,
    size: last ? `${last.cols}x${last.rows}` : null,
    resizes: resizes.length,
  };
});
const rows = page => Promise.all(IDS.map(id => rowOf(paneFrame(page, id))));
const terminalClick = (page, id) => paneFrame(page, id).locator('.h5-xterm:not([hidden]) .xterm-screen').click({ position: { x: 40, y: 40 } });
const focusedIn = async (page, id) => {
  try {
    await until(async () => (await rows(page)).every((row, index) => row.focused === (IDS[index] === id)), `only column ${id} is focused`);
  } catch (error) {
    console.error(JSON.stringify(await rows(page)), await page.evaluate(() => (document.querySelector('.h5-column[data-focused]') || {}).dataset));
    console.error('top', JSON.stringify(await page.evaluate(() => window.inbox.filter(m => m[2] !== 'title'))));
    for (const pid of IDS) console.error(pid, JSON.stringify(await paneFrame(page, pid).evaluate(() => window.inbox.filter(m => m[2] !== 'title'))));
    throw error;
  }
};
const sentText = (frame, text) => frame.evaluate(want => window.sockets.some(s => s.sent.some(item => item.includes(want))), text);
const FOCUSED_BUTTONS = ['h5-image', 'h5-voice', 'h5-more', 'h5-translate-button'];

async function desktop(browser) {
  const { context, page, server } = await openPage(browser, { viewport: { width: 1440, height: 900 } });
  await page.waitForFunction(n => document.querySelectorAll('#h5-columns iframe').length === n, IDS.length, { timeout: 10000 });
  await until(() => IDS.every(id => paneFrame(page, id)), 'the four panes load');
  for (const id of IDS) {
    const frame = paneFrame(page, id);
    await frame.waitForFunction(() => window.H5UI && window.H5Pane && document.getElementById('h5-row') && window.sockets.some(s => s.readyState === 1 && s.url.includes('/terminal/ws')), null, { timeout: 30000 });
    await frame.waitForFunction(() => window.sockets.some(s => s.sent.some(item => item.includes('"resize"'))), null, { timeout: 30000 });
  }
  await page.waitForTimeout(400); // the first fits settle

  // ── Before any press: no focused column, one quiet 52px row each, no buttons ──
  const start = await rows(page);
  for (const [index, row] of start.entries()) {
    assert.equal(row.row, 52, `column ${IDS[index]}: the row is 52px`);
    assert.equal(row.bottom, 53, `column ${IDS[index]}: the whole bottom area is the row and its 1px divider`);
    assert.equal(row.focused, false, `column ${IDS[index]} is not focused before a press`);
    assert.deepEqual(row.buttons, [], `column ${IDS[index]} shows no button`);
    assert.equal(row.peek, null);
    assert.ok(row.size, `column ${IDS[index]} has a PTY size`);
  }
  const sizes = start.map(row => row.size);
  const boxes = start.map(row => row.terminal);
  const resizeCounts = start.map(row => row.resizes);
  const unchanged = async label => {
    const now = await rows(page);
    assert.deepEqual(now.map(row => row.row), [52, 52, 52, 52], `${label}: every row is 52px`);
    assert.deepEqual(now.map(row => row.size), sizes, `${label}: no terminal changed its size`);
    assert.deepEqual(now.map(row => row.terminal), boxes, `${label}: no terminal box changed`);
    assert.deepEqual(now.map(row => row.resizes), resizeCounts, `${label}: no PTY resize was sent`);
    return now;
  };
  // The placeholder, quiet: the textarea is the real one, so nothing is lost.
  assert.equal(await paneFrame(page, 'a').locator('#h5-translate-input').getAttribute('placeholder'), 'Chinese → English, then send');

  // ── A press focuses a column: its row shows the four buttons, the others none ──
  await terminalClick(page, 'b');
  await focusedIn(page, 'b');
  let now = await unchanged('column b focused');
  assert.deepEqual(now.map(row => row.buttons), [[], FOCUSED_BUTTONS, [], []], 'only the focused column shows its buttons, in this order');
  assert.equal(await page.evaluate(() => document.querySelector('.h5-column[data-focused]').dataset.paneId), 'b', 'the top page agrees');
  const b = paneFrame(page, 'b');
  assert.equal(await b.locator('#h5-translate-button').textContent(), 'Send');
  assert.equal(await b.locator('#h5-translate-button').getAttribute('aria-label'), 'Translate and send');
  assert.equal(await b.locator('#h5-more').getAttribute('aria-haspopup'), 'menu');
  for (const id of ['h5-image', 'h5-voice', 'h5-more']) {
    const box = await b.locator(`#${id}`).boundingBox();
    assert.ok(box.width === 36 && box.height === 36, `${id} is a 36px icon button with a mouse`);
  }
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'composer-four-columns.png') }); }

  // Ctrl+Alt+Right from inside the pane: the top page moves the focus to the next column, which is told so.
  await b.locator('.h5-xterm:not([hidden]) .xterm-screen').click({ position: { x: 40, y: 40 } });
  await page.keyboard.press('Control+Alt+ArrowRight');
  await focusedIn(page, 'c');
  await unchanged('focus moved by the keys');
  await terminalClick(page, 'b');
  await focusedIn(page, 'b');

  // ── Enter translates and sends, Alt+Enter sends as typed, the button translates (the same keys and buttons as the page) ──
  const input = b.locator('#h5-translate-input');
  await input.click();
  await input.fill('hello one');
  await input.press('Enter');
  await until(() => server.translations.includes('hello one'), 'Enter translates');
  await until(() => sentText(b, 'EN(hello one)'), 'and sends the translation');
  await input.click();
  await input.fill('typed two');
  await input.press('Alt+Enter');
  await until(() => sentText(b, 'typed two'), 'Alt+Enter sends as typed');
  assert.ok(!server.translations.includes('typed two'), 'Alt+Enter does not translate');
  await input.click();
  await input.fill('hello three');
  await b.locator('#h5-translate-button').click();
  await until(() => sentText(b, 'EN(hello three)'), 'the Translate and send button translates and sends');
  assert.equal(await input.inputValue(), '', 'the sent text left the box');

  // ── More tools: every item does what its old button did ──
  const openMore = async () => {
    await b.locator('#h5-more').click();
    await b.locator('#h5-more-menu [role="menu"]').waitFor();
  };
  await openMore();
  assert.equal(await b.locator('#h5-more').getAttribute('aria-expanded'), 'true');
  assert.equal(await b.locator('#h5-more-menu [role="menu"]').getAttribute('aria-label'), 'More tools');
  assert.deepEqual(await b.locator('#h5-more-menu [role="menuitem"], #h5-more-menu [role="menuitemcheckbox"]').evaluateAll(items => items.map(item => item.id)),
    ['h5-more-commands', 'h5-more-docs', 'h5-more-cycle', 'h5-more-send'], 'the menu holds every tool without a button (no keyboard item with a mouse)');
  if (SHOTS) { await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, 'composer-more-menu.png') }); }
  // Saved commands: the same list as the saved commands button.
  await b.locator('#h5-more-commands').click();
  await b.locator('.h5-add-menu').waitFor();
  assert.ok(await b.locator('.h5-add-menu').getByText('Paste text').count(), 'the saved commands list, with Paste text');
  await b.locator('.h5-add-menu').getByText('git status').click();
  await until(() => sentText(b, 'git status'), 'a saved command is typed into the terminal');
  await b.locator('.h5-add-menu').waitFor({ state: 'detached' });
  const typedIn = () => b.evaluate(() => window.sockets.flatMap(s => s.sent.filter(item => !item.startsWith('{'))));
  await until(async () => (await typedIn()).slice(-2).join('|') === 'git status|\r', 'a tap sends the saved command, then Enter');
  // The same list in a column: the pencil types without Enter, and the used commands come first with "used ...", above a divider.
  await openMore();
  await b.locator('#h5-more-commands').click();
  await b.locator('.h5-add-menu').waitFor();
  assert.equal(await b.locator('.h5-add-menu-row', { hasText: 'codex resume' }).locator('.h5-add-menu-edit').evaluate(node => getComputedStyle(node).opacity), '0', 'pointer: the pencil waits for hover');
  await b.locator('.h5-add-menu-row', { hasText: 'codex resume' }).hover();
  const typedBefore = (await typedIn()).length;
  await b.locator('.h5-add-menu-row', { hasText: 'codex resume' }).locator('.h5-add-menu-edit').click();
  await b.locator('.h5-add-menu').waitFor({ state: 'detached' });
  await page.waitForTimeout(400);
  assert.deepEqual((await typedIn()).slice(typedBefore), ['codex resume'], 'the pencil types the command without Enter');
  await openMore();
  await b.locator('#h5-more-commands').click();
  await b.locator('.h5-add-menu').waitFor();
  assert.deepEqual(await b.evaluate(() => [...document.querySelectorAll('.h5-add-menu .h5-add-menu-command, .h5-add-menu .h5-add-menu-divider')].slice(0, 3).map(node => (node.classList.contains('h5-add-menu-divider') ? '|' : node.textContent))),
    ['codex resume', 'git status', '|'], 'used first, most recent at the top, then the divider');
  assert.equal(await b.locator('.h5-add-menu-used').count(), 2);
  await b.locator('.h5-terminal').click({ position: { x: 20, y: 20 } }); // a press outside closes the list
  await b.locator('.h5-add-menu').waitFor({ state: 'detached' });
  // Docs: the design document sheet.
  await b.evaluate(() => { const own = window.H5UI.actions.openDesign; window.designCalls = 0; window.H5UI.actions.openDesign = (...args) => { window.designCalls += 1; return own(...args); }; });
  await openMore();
  await b.locator('#h5-more-docs').click();
  await b.waitForFunction(() => window.designCalls === 1 && window.H5UI.get().design && window.H5UI.get().design.open === true);
  await b.locator('#h5-design-sheet').waitFor();
  await page.keyboard.press('Escape');
  await b.waitForFunction(() => !window.H5UI.get().design.open);
  // Next running or pending session: the count on More tools (a badge and its name) and in the item; the item cycles.
  await b.waitForFunction(() => window.H5UI.get().activeCount === 2, null, { timeout: 30000 });
  assert.equal(await b.locator('#h5-more').getAttribute('aria-label'), 'More tools (2)');
  assert.equal(await b.locator('.h5-more-badge .MuiBadge-badge').textContent(), '2');
  await openMore();
  assert.equal(await b.locator('#h5-more-cycle').getAttribute('aria-label'), 'Next running or pending session (2)');
  assert.equal(await b.locator('#h5-more-cycle .h5-more-count').textContent(), '2');
  await b.locator('#h5-more-cycle').click();
  // b showed t2, which is not running: the first running one in task sheet order is shown (t1), as the old button does.
  await b.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId === 't1' && window.H5UI.get().sessionName === 'Shell one', null, { timeout: 30000 });
  await openMore();
  await b.locator('#h5-more-cycle').click();
  await b.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId === 't3', null, { timeout: 30000 });
  assert.equal(await b.evaluate(() => window.H5UI.get().taskName), 'Write docs', 'then the next running session');
  // Send as typed, without translating: the form's submit, as the send arrow.
  await input.click();
  await input.fill('plain four');
  await openMore();
  await b.locator('#h5-more-send').click();
  await until(() => sentText(b, 'plain four'), 'Send as typed sends the text as typed');
  assert.ok(!server.translations.includes('plain four'), 'and does not translate');
  await b.waitForFunction(() => document.activeElement && document.activeElement.closest('.xterm'), null, { timeout: 3000 });
  // The terminal of b changed (the cycle): its size is the new socket's.
  const after = await rows(page);
  sizes[1] = after[1].size; boxes[1] = after[1].terminal; resizeCounts[1] = after[1].resizes;

  // ── A draft in a column that loses the focus: the Draft tag and its first line; back whole when focused again ──
  const c = paneFrame(page, 'c');
  const draft = 'first line of a long draft that keeps going on and on so that it has to be cut with an ellipsis at the end\nsecond line\nthird line';
  await c.locator('#h5-translate-input').click();
  await focusedIn(page, 'c');
  await c.locator('#h5-translate-input').fill(draft);
  await c.waitForFunction(() => document.getElementById('h5-translate').getBoundingClientRect().height > 70, null, { timeout: 3000 });
  now = await unchanged('a draft of three lines grows over the terminal');
  assert.ok(now[2].box > 70, 'the box grew upward');
  const grownTop = await c.evaluate(() => document.getElementById('h5-translate').getBoundingClientRect().top);
  const rowTop = await c.evaluate(() => document.getElementById('h5-row').getBoundingClientRect().top);
  assert.ok(grownTop < rowTop, 'the grown box is drawn above the row, over the terminal');
  await terminalClick(page, 'd');
  await focusedIn(page, 'd');
  now = await unchanged('the column with a draft lost the focus');
  assert.equal(now[2].peek, `Draft${draft.replace(/\s+/g, ' ')}`, 'the Draft tag and the draft on one line');
  assert.equal(now[2].box, 36, 'the box went back to one line');
  assert.deepEqual(now[2].buttons, [], 'no buttons');
  const peekText = c.locator('.h5-draft-peek-text');
  assert.ok(await peekText.evaluate(el => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === 'ellipsis'), 'one line, cut with an ellipsis');
  assert.equal(await c.locator('#h5-translate-input').inputValue(), draft, 'the draft is kept');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'composer-draft-unfocused.png') });
  await c.locator('#h5-translate').click({ position: { x: 60, y: 18 } });
  await focusedIn(page, 'c');
  await c.waitForFunction(() => !document.getElementById('h5-draft-peek') && document.activeElement && document.activeElement.id === 'h5-translate-input');
  assert.equal(await c.locator('#h5-translate-input').inputValue(), draft, 'the whole draft is back in the box');
  assert.ok((await rowOf(c)).box > 70, 'shown whole again while it has the focus');
  await unchanged('the draft column focused again');
  await c.locator('#h5-translate-input').fill('');

  // ── A translation that runs and a recording keep the buttons of a column that lost the focus ──
  let release;
  server.holdTranslation = new Promise(resolve => { release = resolve; });
  await c.locator('#h5-translate-input').fill('slow one');
  await c.locator('#h5-translate-input').press('Enter');
  await c.waitForFunction(() => document.getElementById('h5-translate').classList.contains('translating') && document.getElementById('h5-translate-button').disabled);
  await terminalClick(page, 'a');
  await focusedIn(page, 'a');
  assert.deepEqual((await rowOf(c)).buttons, FOCUSED_BUTTONS, 'the column whose translation runs keeps its buttons');
  release();
  server.holdTranslation = null;
  await until(() => sentText(c, 'EN(slow one)'), 'the slow translation is sent');
  await until(async () => (await rowOf(c)).buttons.length === 0, 'its buttons go once it is over');
  await c.evaluate(() => document.getElementById('h5-voice').classList.add('listening'));
  assert.deepEqual((await rowOf(c)).buttons, FOCUSED_BUTTONS, 'a recording column keeps its buttons');
  await c.evaluate(() => document.getElementById('h5-voice').classList.remove('listening'));
  await unchanged('after the translation and the recording');

  // ── Tab from the top page into a column's draft box focuses that column ──
  const d = paneFrame(page, 'd');
  await d.locator('#h5-translate-input').focus();
  await focusedIn(page, 'd');
  await unchanged('the focus came into the draft box');

  await context.close();
}

async function tablet(browser) {
  const { context, page } = await openPage(browser, { viewport: { width: 1280, height: 800 }, tablet: true });
  await page.waitForFunction(n => document.querySelectorAll('#h5-columns iframe').length === n, IDS.length, { timeout: 10000 });
  await until(() => IDS.every(id => paneFrame(page, id)), 'the four panes load');
  const a = paneFrame(page, 'a');
  const b = paneFrame(page, 'b');
  for (const frame of [a, b]) await frame.waitForFunction(() => window.H5UI && document.getElementById('h5-row') && window.sockets.some(s => s.readyState === 1 && s.url.includes('/terminal/ws')), null, { timeout: 30000 });
  assert.equal(await a.evaluate(() => document.documentElement.dataset.input), 'touch', 'a tablet column is in touch input mode');
  await a.locator('.h5-xterm:not([hidden]) .xterm-screen').tap({ position: { x: 40, y: 40 } });
  await a.waitForFunction(() => document.getElementById('h5-bottom').hasAttribute('data-focused'));
  await page.waitForTimeout(300);
  const row = await rowOf(a);
  assert.equal(row.row, 56, 'the row is 56px in touch input mode');
  assert.deepEqual(row.buttons, FOCUSED_BUTTONS);
  assert.deepEqual((await rowOf(b)).buttons, [], 'an unfocused column shows no buttons on a touch screen either');
  assert.equal((await rowOf(b)).row, 56);
  for (const id of ['h5-image', 'h5-voice', 'h5-more', 'h5-translate-button', 'h5-translate']) {
    const box = await a.locator(`#${id}`).boundingBox();
    assert.ok(box.height >= 44 && box.width >= 44, `${id} is at least 44px (${box.width}x${box.height})`);
  }
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'composer-touch.png') });
  // Terminal keyboard from More tools: the function keys and the on-screen keyboard (they take room, as on the page); the item says it is on.
  await a.locator('#h5-more').tap();
  await a.locator('#h5-more-keyboard').waitFor();
  assert.equal(await a.locator('#h5-more-keyboard').getAttribute('aria-checked'), 'false');
  await page.waitForTimeout(400); // the menu's grow animation (a scale) is over
  for (const id of ['h5-more-commands', 'h5-more-docs', 'h5-more-cycle', 'h5-more-send', 'h5-more-keyboard']) {
    assert.ok((await a.locator(`#${id}`).boundingBox()).height >= 44, `${id} is at least 44px high`);
  }
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'composer-touch-menu.png') });
  await a.locator('#h5-more-keyboard').tap();
  await a.locator('#h5-osk').waitFor();
  await a.locator('#h5-keys').waitFor();
  assert.equal((await rowOf(a)).row, 56, 'the row keeps its height with the keyboard shown');
  await a.locator('#h5-keys [data-key="Escape"]').tap();
  await a.waitForFunction(() => window.sockets.some(s => s.sent.includes('\x1b')), null, { timeout: 3000 });
  const withKeys = await rowOf(a);
  // The focus moves to another column: nothing is resized (the keyboard stays until it is turned off).
  await b.locator('.h5-xterm:not([hidden]) .xterm-screen').tap({ position: { x: 40, y: 40 } });
  await a.waitForFunction(() => !document.getElementById('h5-bottom').hasAttribute('data-focused'));
  await page.waitForTimeout(300);
  const later = await rowOf(a);
  assert.equal(later.size, withKeys.size, 'no resize when the focus moves');
  assert.equal(later.resizes, withKeys.resizes);
  assert.equal(later.terminal, withKeys.terminal);
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await desktop(browser);
    await tablet(browser);
    assert.deepEqual(pageErrors, [], 'no browser runtime errors');
    console.log('Compact bottom area of a column: one 52px row (56px touch), buttons only in the focused column, no resize on focus moves, draft tag, More tools items, Enter / Alt+Enter / Translate and send, running states kept, touch keyboard passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
