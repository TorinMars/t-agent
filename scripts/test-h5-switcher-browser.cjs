// The session switcher (Switcher.jsx, "Session switcher" in docs/design/session-switcher.md) in real Chromium with mocked servers, on a phone
// (390x844, touch) and a computer (1440x900, a mouse). Phone: the switch button (#h5-cycle) opens a stack of the recently shown sessions with the
// previous one centred and the current one on top at the right, labels above the cards, an orange edge on a session that needs the person, the preview
// lines of warm terminals and of one closed earlier; a swipe moves it; a tap or another press switches (task and terminal shown), two quick presses go
// back and forth; Back, the empty space and a downward swipe close without switching and give the focus back to the button. Computer ("The wide
// row"): a row of cards side by side without overlap, most recent first from the left, the previous one selected, each card's header naming its task,
// the session and the state; a wider window shows more cards; the arrow keys move the selection along the row and scroll it into view; an upright
// wheel and a mouse drag scroll the row; Enter, a second press of the button and a click switch; Escape and the empty space close. No count on the
// button; on a computer it is a button of the row (not in "More tools") that stays in the narrow row. A pane has no switcher. A session of another
// engine (K01) is a card too, and the list is remembered (the shared page state; here, without a server for it, in this browser).
// H5_SHOT_DIR=<dir> saves screenshots there (phone: first press, after a swipe; computer: open at 1440x900, open at 1920x1080 with the sidebar folded).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';

const TASKS = [{ id: 1, title: 'Fix login', status: 'doing' }, { id: 2, title: 'Write docs', status: 'doing' }];
const TERMINALS = {
  1: [{ terminal_id: 'default', title: 'Terminal 1' }, { terminal_id: 'c1', title: 'Claude work', agent: 'claude' }],
  2: [{ terminal_id: 'd1', title: 'Docs shell' }],
};
const REMOTE_TASKS = [{ id: 5, title: 'Build server', status: 'doing' }];
const REMOTE_TERMINALS = { 5: [{ terminal_id: 'k1', title: 'Build shell' }] };
// Write docs / Docs shell finished and was not seen (it needs the person); K01's build shell runs.
const ACTIVITY = { 2: { d1: 'done' } };
const REMOTE_ACTIVITY = { 5: { k1: 'running' } };
const GROUPS = [{ key: 'doing', name: 'In progress', sort_order: 1 }];

async function openPage(browser, viewport, { touch }) {
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...(SHOTS ? { deviceScaleFactor: touch ? 3 : 1 } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.sockets = [];
    // Every terminal answers its history at once: a prompt line naming it, so its card can show it.
    window.FakeSocket = class {
      constructor(url) {
        this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this);
        const id = new URL(url).searchParams.get('terminalId');
        setTimeout(() => { this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ type: 'history', data: `PREVIEW-${id} $ `, cols: 60, rows: 20 }) }); }, 0);
      }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
    };
    window.FakeSocket.OPEN = 1;
    window.FakeSocket.CONNECTING = 0;
    window.WebSocket = window.FakeSocket;
  });
  await page.route(`${ORIGIN}/**`, route => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (p === '/frame') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><iframe id="pane" src="/h5?pane=k3x9" style="width:600px;height:800px"></iframe>' });
    if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
    if (p === '/api/remote-servers') return json([{ id: 7, name: 'K01', status: 'online', base_url: 'http://10.0.0.7:14002', enabled: true }]);
    if (p === '/api/tasks' && method === 'GET') return json(TASKS);
    if (p === '/api/remote-servers/7/tasks' && method === 'GET') return json(REMOTE_TASKS);
    if (p === '/api/task-groups' || p === '/api/remote-servers/7/task-groups') return json(GROUPS);
    if (p === '/api/tasks/terminal-activity') return json(ACTIVITY);
    if (p === '/api/remote-servers/7/terminal-activity') return json(REMOTE_ACTIVITY);
    if (/terminal-subagents$/.test(p)) return json({});
    if (/\/terminal\/ack$/.test(p)) return json({ success: true });
    const local = p.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (local && method === 'GET') return json(TERMINALS[local[1]] || []);
    const remote = p.match(/^\/api\/remote-servers\/7\/tasks\/(\d+)\/terminals$/);
    if (remote && method === 'GET') return json(REMOTE_TERMINALS[remote[1]] || []);
    if (p === '/api/remote-servers/7/info') return json({ capabilities: [] });
    if (/\/agent\/conversations$/.test(p)) return json([]);
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  return { context, page, errors };
}

const shown = page => page.evaluate(() => ({ terminal: document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId, task: document.getElementById('h5-task-name').textContent }));
const waitShown = (page, task, terminal) => page.waitForFunction(([name, id]) => document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId === id
  && document.getElementById('h5-task-name').textContent === name, [task, terminal], { timeout: 10000 });
// Shows a session the way the task list does (h5.js `openRow`), and waits until it is on screen and has said its prompt.
async function visit(page, ref, terminal, task) {
  await page.evaluate(([r, id]) => window.H5UI.actions.openRow(r, { kind: 'terminal', id }), [ref, terminal]);
  await waitShown(page, task, terminal);
  await page.waitForFunction(id => (document.querySelector(`.h5-xterm[data-terminal-id="${id}"]:not([hidden]) .xterm-rows`)?.textContent || '').includes(`PREVIEW-${id}`), terminal);
}
// The four sessions, oldest first: Fix login / Terminal 1, Write docs / Docs shell, K01 Build server / Build shell, Fix login / Claude work (shown).
async function visitAll(page) {
  await page.waitForFunction(() => (window.H5UI.get().taskList.tasks || []).length === 3, null, { timeout: 15000 });
  await visit(page, 'local|1', 'default', 'Fix login');
  await visit(page, 'local|2', 'd1', 'Write docs');
  await visit(page, 'remote:7|5', 'k1', 'Build server');
  await visit(page, 'local|1', 'c1', 'Fix login');
  await page.waitForFunction(() => window.H5UI.get().recent.length === 4);
}
const switcher = page => page.locator('#h5-switcher');
const hint = async page => (await page.locator('.h5-switcher-hint').textContent()).replace(/\s+/g, ' ').trim(); // the icon stands for the button
// The cards: index, key, centred, current, status, name (none behind in the stack), box, edge colour, preview text; in the wide row also the header's
// task title (and its tooltip), its state word and where the "Current" pill sits.
const cards = page => page.evaluate(() => [...document.querySelectorAll('#h5-switcher .h5-switcher-card')].map(card => {
  const body = card.querySelector('.h5-switcher-body');
  const box = body.getBoundingClientRect();
  const head = card.querySelector('.h5-switcher-head');
  const pill = card.querySelector('.h5-switcher-current');
  return {
    index: Number(card.dataset.index), key: card.dataset.key, centred: card.dataset.centred === 'true', current: card.dataset.current === 'true', status: card.dataset.status,
    name: card.querySelector('.h5-switcher-name')?.textContent || null, tag: card.querySelector('.h5-switcher-label .h5-device-tag, .h5-switcher-head .h5-device-tag')?.textContent || null,
    left: Math.round(box.left), right: Math.round(box.right), top: Math.round(box.top), bottom: Math.round(box.bottom), width: Math.round(box.width), opacity: Number(getComputedStyle(card).opacity),
    shadow: getComputedStyle(body).boxShadow, lines: card.querySelector('.h5-switcher-lines')?.textContent || '', label: card.getAttribute('aria-label'),
    task: head?.querySelector('.h5-switcher-task')?.textContent ?? null, taskTip: head?.querySelector('.h5-switcher-task')?.getAttribute('title') ?? null,
    state: head?.querySelector('.h5-switcher-state')?.textContent ?? null, headBottom: head ? Math.round(head.getBoundingClientRect().bottom) : null,
    pill: pill ? { top: Math.round(pill.getBoundingClientRect().top), right: Math.round(pill.getBoundingClientRect().right) } : null,
    label2: Boolean(card.querySelector('.h5-switcher-label')), foot: Boolean(card.querySelector('.h5-switcher-foot')),
  };
}));
// The wide row: its scroll position, its visible width and the cards wholly in view.
const rowState = page => page.evaluate(() => {
  const scroller = document.querySelector('#h5-switcher .h5-switcher-row');
  const box = scroller.getBoundingClientRect();
  const whole = [...scroller.querySelectorAll('.h5-switcher-card')].filter(card => { const r = card.getBoundingClientRect(); return r.left >= box.left - 0.5 && r.right <= box.right + 0.5; });
  return { scroll: scroller.scrollLeft, max: scroller.scrollWidth - scroller.clientWidth, left: box.left, right: box.right, whole: whole.map(card => card.dataset.key) };
});
const cardBox = (page, key) => page.evaluate(want => { const r = document.querySelector(`#h5-switcher .h5-switcher-card[data-key="${want}"]`).getBoundingClientRect(); return { left: r.left, right: r.right }; }, key);
const centredKey = async page => (await cards(page)).find(card => card.centred)?.key;
const waitCentred = (page, key) => page.waitForFunction(want => document.querySelector('#h5-switcher .h5-switcher-card[data-centred="true"]')?.dataset.key === want, key);
const waitClosed = page => page.waitForFunction(() => !document.getElementById('h5-switcher') && !window.H5UI.get().switcher);
const settled = page => page.waitForTimeout(350); // the 200ms motion
const WARNING = 'rgb(255, 167, 38)'; // the dark theme's warning.main (orange 400)
const PRIMARY = 'rgb(144, 202, 249)'; // primary.main (blue 200)

async function touchSwipe(page, cdp, from, to, steps = 12) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }] });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(120); // a slow swipe: no flick
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    // ── Phone ──
    {
      const { context, page, errors } = await openPage(browser, { width: 390, height: 844 }, { touch: true });
      await page.locator('#h5-tasks').waitFor({ state: 'visible' });
      await page.evaluate(() => window.H5UI.actions.closeTasks());
      await visitAll(page);
      const cdp = await context.newCDPSession(page);
      const cycle = page.locator('#h5-cycle');
      assert.equal(await cycle.getAttribute('aria-label'), 'Recent sessions', 'the button is named without a count');
      assert.equal(await cycle.locator('.MuiBadge-badge').count(), 0, 'no badge on the button');
      const row = await page.evaluate(() => [...document.querySelectorAll('#h5-actions button, #h5-actions [role="button"]')].filter(b => b.getBoundingClientRect().width > 0).map(b => b.id || b.getAttribute('aria-label')));
      assert.equal(row.at(-1), 'h5-cycle', 'the last button of the tool row');

      await cycle.tap();
      await switcher(page).waitFor({ state: 'visible' });
      await settled(page);
      assert.equal(await switcher(page).getAttribute('role'), 'dialog');
      assert.equal(await switcher(page).getAttribute('aria-modal'), 'true');
      assert.equal(await switcher(page).getAttribute('aria-label'), 'Recent sessions');
      assert.equal(await cycle.getAttribute('aria-expanded'), 'true', 'the button shows the pressed look');
      const place = await page.evaluate(() => {
        const box = document.getElementById('h5-switcher').getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, actions: document.getElementById('h5-actions').getBoundingClientRect().top, nav: document.getElementById('h5-bnav').getBoundingClientRect().height, header: document.querySelector('.h5-header').getBoundingClientRect().top };
      });
      assert.ok(place.top <= place.header + 0.5 && Math.abs(place.bottom - place.actions) <= 1, `it covers the header, the terminal and the key row, down to the tool row: ${JSON.stringify(place)}`);
      assert.ok(place.nav > 0, 'the bottom navigation stays');
      let list = await cards(page);
      assert.deepEqual(list.map(card => card.key), ['local|1|c1', 'remote:7|5|k1', 'local|2|d1', 'local|1|default'], 'most recently shown first, the other engine among them');
      assert.equal(list[0].current, true);
      assert.equal(list[1].centred, true, 'the previous session is centred');
      assert.ok(list[0].left > list[1].left + 150 && list[0].left < 390, `the current card peeks in from the right: ${list[0].left}`);
      assert.ok(list[2].left < list[1].left && list[2].width < list[1].width && list[3].width < list[2].width, 'older cards lie behind to the left, each smaller');
      assert.equal(list[1].name, 'Build shell');
      assert.equal(list[1].tag, 'K01', 'the device tag of the other engine');
      assert.equal(list[0].name, 'Claude work');
      assert.equal(list[2].name, null, 'a card behind shows only its icon above it');
      assert.equal(list[2].status, 'waiting');
      assert.ok(list[2].shadow.includes(WARNING), `a session that needs the person has an orange edge: ${list[2].shadow}`);
      assert.ok(list[1].shadow.includes(PRIMARY), 'the centred card has the primary edge');
      assert.equal(list[1].status, 'running');
      assert.ok(list[1].lines.includes('PREVIEW-k1'), 'a warm terminal shows its last lines');
      assert.ok(list[3].lines.includes('PREVIEW-default'), 'a terminal closed earlier in this page shows what it showed then');
      assert.match(list[1].label, /^K01, Build shell, Build server, Running$/, 'the card names device, session, task and state');
      assert.match(list[0].label, /, Current$/);
      assert.equal(await page.evaluate(() => document.activeElement.dataset.key), 'remote:7|5|k1', 'the focus is on the centred card');
      assert.equal(await hint(page), 'Press again to switch to it');
      assert.equal(await page.locator('.h5-switcher-dots > *').count(), 4);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'switcher-phone-first.png') });

      // A swipe to the right shows the older ones: it settles with Write docs centred.
      const centre = list[1];
      await touchSwipe(page, cdp, { x: 195, y: 420 }, { x: 195 + 70, y: 424 });
      await waitCentred(page, 'local|2|d1');
      await settled(page);
      list = await cards(page);
      assert.ok(list[1].left > centre.left + 150, 'the previous session moved to the right, on top');
      assert.equal(await hint(page), 'Swipe to move · tap a card or press to switch');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'switcher-phone-swiped.png') });
      // And back to the left: K01 again.
      await touchSwipe(page, cdp, { x: 195, y: 420 }, { x: 195 - 70, y: 418 });
      await waitCentred(page, 'remote:7|5|k1');
      await touchSwipe(page, cdp, { x: 195, y: 420 }, { x: 195 + 70, y: 424 });
      await waitCentred(page, 'local|2|d1');

      // A tap on the centred card switches to it: the card grows into the page, then the task and the terminal are shown.
      await page.locator('#h5-switcher .h5-switcher-card[data-centred="true"]').tap();
      await waitShown(page, 'Write docs', 'd1');
      await waitClosed(page);
      assert.equal(await cycle.getAttribute('aria-expanded'), 'false');

      // Two quick presses: the previous session; two more: back.
      await cycle.tap();
      await cycle.tap();
      await waitShown(page, 'Fix login', 'c1');
      await waitClosed(page);
      await cycle.tap();
      await cycle.tap();
      await waitShown(page, 'Write docs', 'd1');
      await waitClosed(page);

      // Closing without switching: Back, a tap on the empty space, a downward swipe. The focus goes back to the button each time.
      await cycle.tap();
      await switcher(page).waitFor();
      await page.waitForFunction(() => history.state && history.state.h5Layer >= 1);
      await page.goBack();
      await waitClosed(page);
      assert.deepEqual(await shown(page), { terminal: 'd1', task: 'Write docs' }, 'Back closes without switching');
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'h5-cycle', 'the focus is back on the button');
      await cycle.tap();
      await switcher(page).waitFor();
      await settled(page);
      await page.touchscreen.tap(195, 60); // beside the title: no card there
      await waitClosed(page);
      assert.deepEqual(await shown(page), { terminal: 'd1', task: 'Write docs' }, 'the empty space closes without switching');
      await cycle.tap();
      await switcher(page).waitFor();
      await settled(page);
      await touchSwipe(page, cdp, { x: 195, y: 300 }, { x: 198, y: 460 });
      await waitClosed(page);
      assert.deepEqual(await shown(page), { terminal: 'd1', task: 'Write docs' }, 'a downward swipe closes without switching');
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'h5-cycle');

      // Kept in the shared page state (this mocked server has none, so it stays in this browser, public/js/page-state.js): a new page opens with the
      // same list (the shown one first). The devices have no instance id here, so they are named by their source keys.
      const stored = await page.evaluate(() => window.TAPageState.recent().map(entry => `${entry.instance}|${entry.task}|${entry.terminal}`));
      assert.deepEqual(stored, ['~local|2|d1', '~local|1|c1', '~remote:7|5|k1', '~local|1|default']);
      assert.equal(await page.evaluate(() => localStorage.getItem('h5-recent-sessions')), null, 'the old per-browser key is not written');
      await page.reload();
      await page.waitForFunction(() => window.H5UI.get().recent.length === 4, null, { timeout: 15000 });
      assert.deepEqual(errors, [], 'no page errors on the phone');
      await context.close();
    }

    // ── Computer ──
    {
      const { context, page, errors } = await openPage(browser, { width: 1440, height: 900 }, { touch: false });
      await visitAll(page);
      const cycle = page.locator('#h5-cycle');
      const ids = await page.evaluate(() => [...document.querySelectorAll('#h5-bottom button, #h5-bottom label')].filter(el => el.getBoundingClientRect().width > 0 && !el.closest('.h5-add-menu')).map(el => el.id));
      assert.deepEqual(ids, ['h5-image', 'h5-voice', 'h5-commands', 'h5-design', 'h5-cycle', 'h5-more', 'h5-translate-button'], 'the switch button is in the row, between Docs and More tools');
      assert.equal(await page.locator('#h5-more-menu #h5-cycle, #h5-more-menu [data-action="cycle"]').count(), 0, 'not an item of More tools');
      assert.equal(await page.locator('#h5-more .MuiBadge-badge').count(), 0, 'More tools carries no count');
      assert.equal(await page.locator('#h5-more').getAttribute('aria-label'), 'More tools');
      const size = await cycle.boundingBox();
      assert.ok(Math.abs(size.width - 40) <= 1 && Math.abs(size.height - 40) <= 1, `a 40px icon button like the others: ${JSON.stringify(size)}`);

      await cycle.click();
      await switcher(page).waitFor({ state: 'visible' });
      await settled(page);
      const place = await page.evaluate(() => {
        const box = document.getElementById('h5-switcher').getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, terminal: document.getElementById('h5-terminal').getBoundingClientRect().top, row: document.getElementById('h5-bottom').getBoundingClientRect().top };
      });
      assert.ok(Math.abs(place.top - place.terminal) <= 1 && Math.abs(place.bottom - place.row) <= 1, `it covers the terminal area between the header and the row: ${JSON.stringify(place)}`);
      assert.equal(await cycle.isVisible(), true);
      assert.equal(await cycle.getAttribute('aria-expanded'), 'true');
      // The wide row: side by side, never overlapping, most recent first from the left; the previous one is selected.
      let list = await cards(page);
      assert.deepEqual(list.map(card => card.key), ['local|1|c1', 'remote:7|5|k1', 'local|2|d1', 'local|1|default'], 'most recent first from the left');
      for (let i = 1; i < list.length; i += 1) {
        const gap = list[i].left - list[i - 1].right;
        assert.ok(gap >= 16 && gap <= 20, `cards side by side, 16-20px apart, no overlap: ${gap}`);
        assert.equal(list[i].top, list[0].top, 'one row');
        assert.equal(list[i].width, list[0].width, 'cards of one size');
      }
      assert.ok(list[0].width >= 280 && list[0].width <= 380, `the card width stays within 280-380px: ${list[0].width}`);
      assert.equal(list[0].current, true, 'the current session comes first');
      assert.equal(list[1].centred, true, 'the previous session is selected');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.key), 'remote:7|5|k1', 'the focus is on the selected card');
      assert.ok(list[1].shadow.includes(PRIMARY), 'the selected card has the primary edge');
      assert.ok(list[2].shadow.includes(WARNING), 'the orange edge');
      // Each card's header names its task, then the device tag, the session and the state; no label above the card and no bottom line.
      assert.deepEqual(list.map(card => card.task), ['Fix login', 'Build server', 'Write docs', 'Fix login'], 'the header names the task of every card');
      assert.deepEqual(list.map(card => card.taskTip), ['Fix login', 'Build server', 'Write docs', 'Fix login'], 'the full task name in the tooltip');
      assert.deepEqual(list.map(card => card.name), ['Claude work', 'Build shell', 'Docs shell', 'Terminal 1'], 'and the session name, on the cards further right too');
      assert.equal(list[1].tag, 'K01', 'the device tag of the other engine');
      assert.deepEqual(list.map(card => card.state), ['Idle', 'Running', 'Needs you', 'Idle']);
      assert.ok(list.every(card => !card.label2 && !card.foot), 'no label above a card and no bottom line in the wide row');
      assert.ok(list[0].pill && list[0].pill.top >= list[0].headBottom && list[0].pill.right <= list[0].right, `"Current" sits in the card under the header: ${JSON.stringify(list[0])}`);
      assert.equal(list.filter(card => card.pill).length, 1);
      assert.match(list[1].label, /^K01, Build shell, Build server, Running$/, 'the card names device, session, task and state');
      assert.match(list[0].label, /, Current$/);
      assert.ok(list[1].lines.includes('PREVIEW-k1'), 'a warm terminal shows its last lines');
      assert.equal(await page.locator('#h5-switcher .h5-switcher-dots').count(), 0, 'the row needs no position dots');
      const narrowRow = await rowState(page);
      assert.equal(narrowRow.scroll, 0, 'the selected card is in view without scrolling');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'switcher-desktop-open.png') });
      // The arrow keys move the selection along the row (right: older) and scroll it into view; Enter switches to it.
      await page.keyboard.press('ArrowRight');
      await waitCentred(page, 'local|2|d1');
      await page.keyboard.press('ArrowRight');
      await waitCentred(page, 'local|1|default');
      await page.waitForFunction(() => { const s = document.querySelector('#h5-switcher .h5-switcher-row'); const c = document.querySelector('#h5-switcher .h5-switcher-card[data-centred="true"]').getBoundingClientRect(); return c.right <= s.getBoundingClientRect().right + 0.5; });
      let state = await rowState(page);
      assert.ok(state.whole.includes('local|1|default'), `the selected last card is scrolled into view: ${JSON.stringify(state)}`);
      if (narrowRow.max > 0) assert.ok(state.scroll > 0, 'the row scrolled');
      await page.keyboard.press('ArrowRight');
      await waitCentred(page, 'local|1|default'); // the end of the row
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await waitCentred(page, 'remote:7|5|k1');
      await page.keyboard.press('Home');
      await waitCentred(page, 'local|1|c1');
      await page.waitForFunction(() => document.querySelector('#h5-switcher .h5-switcher-row').scrollLeft === 0);
      await page.keyboard.press('ArrowRight');
      await waitCentred(page, 'remote:7|5|k1');
      await page.keyboard.press('Enter');
      await waitShown(page, 'Build server', 'k1');
      await waitClosed(page);
      // A second press of the button switches to the selected card: open, move to the third card, press again.
      await cycle.click();
      await switcher(page).waitFor();
      await settled(page);
      assert.equal(await centredKey(page), 'local|1|c1', 'the previous one is selected on open');
      await page.keyboard.press('ArrowRight');
      await waitCentred(page, 'local|2|d1');
      await cycle.click();
      await waitShown(page, 'Write docs', 'd1');
      await waitClosed(page);
      // An upright wheel scrolls the row sideways, and a mouse drag scrolls it back; neither is a click.
      await cycle.click();
      await switcher(page).waitFor();
      await settled(page);
      state = await rowState(page);
      if (state.max > 0) {
        await page.mouse.move(700, 400);
        await page.mouse.wheel(0, 120);
        await page.waitForFunction(() => document.querySelector('#h5-switcher .h5-switcher-row').scrollLeft > 0);
        await page.mouse.move(700, 400);
        await page.mouse.down();
        for (let i = 1; i <= 10; i += 1) { await page.mouse.move(700 + 20 * i, 401); await page.waitForTimeout(16); }
        await page.mouse.up();
        await page.waitForFunction(() => document.querySelector('#h5-switcher .h5-switcher-row').scrollLeft === 0);
        assert.equal(await page.locator('#h5-switcher').count(), 1, 'a drag is not a click: still open');
      }
      // Escape closes without switching; the focus is back on the button.
      await page.keyboard.press('Escape');
      await waitClosed(page);
      assert.deepEqual(await shown(page), { terminal: 'd1', task: 'Write docs' });
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'h5-cycle');
      // A click on the empty space closes too; a click on a card switches to it.
      await cycle.click();
      await switcher(page).waitFor();
      await settled(page);
      const empty = await page.evaluate(() => { const r = document.getElementById('h5-switcher').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom - 60 }; });
      await page.mouse.click(empty.x, empty.y);
      await waitClosed(page);
      assert.deepEqual(await shown(page), { terminal: 'd1', task: 'Write docs' });
      await cycle.click();
      await switcher(page).waitFor();
      await settled(page);
      const third = await cardBox(page, 'local|1|c1');
      await page.mouse.click(third.left + 40, 400);
      await waitShown(page, 'Fix login', 'c1');
      await waitClosed(page);

      // A wider window (1920x1080, the sidebar folded) shows more whole cards.
      const before = narrowRow.whole.length;
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.evaluate(() => window.H5UI.actions.toggleSidebar());
      await page.waitForFunction(() => window.H5UI.get().sidebarCollapsed === true);
      await cycle.click();
      await switcher(page).waitFor();
      await settled(page);
      state = await rowState(page);
      assert.ok(state.whole.length > before, `a wider window shows more whole cards: ${before} -> ${state.whole.length}`);
      list = await cards(page);
      assert.ok(list[0].width <= 380, 'at most 380px wide');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'switcher-desktop-wide.png') });
      await page.keyboard.press('Escape');
      await waitClosed(page);
      await page.evaluate(() => window.H5UI.actions.toggleSidebar());
      await page.waitForFunction(() => window.H5UI.get().sidebarCollapsed === false);

      // The narrow row (under 560px): Saved commands and Docs go into More tools; the switch button stays.
      await page.setViewportSize({ width: 900, height: 900 });
      await page.waitForFunction(() => document.getElementById('h5-bottom').clientWidth < 560 && !document.getElementById('h5-commands'));
      assert.equal(await cycle.isVisible(), true, 'the switch button stays in the narrow row');
      assert.equal(await page.locator('#h5-more-menu #h5-more-commands').count(), 1);
      assert.deepEqual(errors, [], 'no page errors on the computer');
      await context.close();
    }

    // ── A pane of the multi-column view: no switcher ──
    {
      const { context, page, errors } = await openPage(browser, { width: 1440, height: 900 }, { touch: false });
      await page.goto(`${ORIGIN}/frame`);
      const frame = await (await page.waitForSelector('#pane')).contentFrame();
      await frame.waitForFunction(() => window.H5UI && window.H5UI.get().pane === 'k3x9' && document.getElementById('h5-bottom'));
      assert.equal(await frame.locator('#h5-cycle').count(), 0, 'a column has its own "Next running or pending session" in More tools, no switch button');
      await frame.evaluate(() => window.H5UI.actions.openSwitcher && window.H5UI.actions.openSwitcher());
      await page.waitForTimeout(200);
      assert.equal(await frame.evaluate(() => window.H5UI.get().switcher), null, 'it does not open in a pane');
      assert.equal(await frame.locator('#h5-switcher').count(), 0);
      assert.deepEqual(await frame.evaluate(() => window.H5UI.get().recent), [], 'a pane keeps no recent sessions');
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('Session switcher: phone stack (order, labels, edges, previews, swipe, tap, double press, Back, empty space, downward swipe, focus) and the wide row (order, no overlap, card headers, wider window, keys and scroll into view, wheel, drag, Enter, second press, click, Escape, empty space), no badge, row placement, narrow row and pane passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
