// T-Attention sub-tasks on the MUI page (scripts/h5-shell/Attention.jsx, attention-model.mjs, list-drag.jsx) in real Chromium, with the API
// (/api/attention*) mocked by Playwright routes and the live stream (EventSource) and AudioContext stubbed in the page:
// - phone 390x844 (touch through the DevTools protocol): the Home view (sections Needs you, Working, To do with coloured dots, "None" when empty,
//   "Done: N" unfolding the finished tasks; a tree stays together in the section of its most urgent open task, a finished parent kept above an open
//   sub-task; each row with its status pill, its section's detail line and its time), sub-tasks indented with a guide line, collapse remembered in
//   localStorage, Confirm / Reject (with a reason) / Handled and their PATCH bodies, the double-tap guard and the rollback of a failed button; a held
//   row dragged among its siblings of its status (POST /move { before | after }), a parent dragged with its sub-tasks, a drop on another section's
//   title ({ position, status }; Needs you gives waiting_user), a failed move sliding back with a notice; the edit view: custom status, result,
//   parent (never itself or a sub-task), sub-task links, Move up / down / to top, the timeline sentences, Delete of a parent answered 409
//   HAS_CHILDREN.
// - phone 320x640 (touch): the rows fit the width; every control is 44px.
// - computer 1440x900 (mouse; the side panel keeps the groups and the "\u21b3 <parent>" hint): a move of 4px picks a row up, a click still opens
//   it, a drop on a title; a server without /move (404) loses the drag.
// - an older server (no parent_id): no drag, no fold, no new fields; Chinese: the row buttons and the edit fields are translated.
// H5_SHOT_DIR=<dir> saves screenshots (phones at 3x).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const AT = '2026-11-05T10:00:00Z';

const node = (id, title, status, parent, order, extra = {}) => ({
  id, title, status, parent_id: parent, sort_order: order, custom_status: null, result: null, priority: 'none', source: 'claude', updated_at: AT, created_at: AT, ...extra,
});
const ITEMS = () => [
  node(1, 'Allow Bash in the repo', 'waiting_user', null, 10, { attention_reason: 'Claude needs your permission to use Bash' }),
  node(2, 'Check the PR', 'review', null, 20, { custom_status: 'Ready', result: 'Opened PR #1 with the login page', attention_reason: 'Claude finished. Review the result.' }),
  node(3, 'Write the docs', 'review', 2, 15, { result: 'Docs drafted' }),
  node(4, 'Review the plan', 'review', null, 12, { result: 'Plan in PLAN.md' }),
  node(10, 'Release 2.0', 'todo', null, 50, { source: 'user' }),
  node(11, 'Changelog', 'todo', 10, 40, { custom_status: 'Blocked' }),
  node(12, 'Tag the release', 'todo', 10, 30),
  node(13, 'Bump the version', 'todo', 11, 35),
  node(14, 'Pay invoice', 'todo', null, 45, { source: 'user' }),
  node(15, 'Clean up', 'todo', null, 20, { source: 'user' }),
  node(16, 'Refactor login', 'working', 10, 5),
  node(20, 'Old thing', 'done', null, 1, { result: 'Shipped' }),
];
// An older server: the same tasks without the new keys.
const OLD = () => ITEMS().map(({ parent_id: _p, sort_order: _s, custom_status: _c, result: _r, ...rest }) => rest);

async function openPage(browser, { viewport, touch = true, items = ITEMS(), zh = false, noMove = false }) {
  const scale = SHOTS && touch ? { deviceScaleFactor: 3 } : {};
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...scale });
  const page = await context.newPage();
  const errors = [];
  const calls = []; // { method, path, body } of every /api/attention request
  const db = { items, failPatch: false, failMove: false, holdMove: null, noMove };
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ zh: chinese }) => {
    window.WebSocket = class {
      constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send() {}
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    window.streams = [];
    window.EventSource = class extends EventTarget {
      constructor(url) { super(); this.url = url; this.readyState = 0; window.streams.push(this); setTimeout(() => { if (this.readyState !== 2) { this.readyState = 1; this.dispatchEvent(new Event('open')); } }, 0); }
      close() { this.readyState = 2; }
    };
    window.emitChange = change => { const live = window.streams.filter(s => s.readyState === 1).at(-1); live.dispatchEvent(new MessageEvent('change', { data: JSON.stringify(change) })); };
    window.tones = 0;
    window.AudioContext = class {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
      resume() { return Promise.resolve(); }
      createOscillator() { window.tones += 1; return { type: '', frequency: {}, connect() {}, start() {}, stop() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    };
    try { if (chinese) localStorage.setItem('ta-lang', 'zh'); } catch { /* none */ }
  }, { zh });
  await page.route(`${ORIGIN}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const p = url.pathname;
    if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
    if (p === '/api/remote-servers') return json([]);
    if (p === '/api/tasks' && method === 'GET') return json([{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }]);
    if (p === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (p === '/api/tasks/1/terminals') return json([{ terminal_id: 't1', title: 'Terminal 1' }]);
    if (/\/agent\/conversations$/.test(p)) return json([]);
    if (p.startsWith('/api/attention')) {
      const body = request.postData() ? JSON.parse(request.postData()) : undefined;
      calls.push({ method, path: p + url.search, body });
      if (p === '/api/attention' && method === 'GET') return json({ items: db.items, host: 'mac' });
      const move = p.match(/^\/api\/attention\/(\d+)\/move$/);
      if (move && method === 'POST') {
        if (db.noMove) return json({ error: 'not mocked' }, 404);
        if (db.holdMove) await db.holdMove;
        if (db.failMove) return json({ error: 'INTERNAL', message: 'The database is locked' }, 500);
        // The order as the server keeps it: the moved task between its neighbours of the group (integers, renumbered), or at the top with a status.
        const item = db.items.find(entry => entry.id === Number(move[1]));
        if (body.status) item.status = body.status;
        const group = db.items.filter(entry => entry.status === item.status && entry !== item).sort((a, b) => b.sort_order - a.sort_order);
        let at = 0;
        if (body.before !== undefined) at = group.findIndex(entry => entry.id === body.before);
        else if (body.after !== undefined) at = group.findIndex(entry => entry.id === body.after) + 1;
        else if (body.position === 'bottom') at = group.length;
        group.splice(at, 0, item);
        const changed = [];
        group.forEach((entry, index) => { const value = (group.length - index) * 10; if (entry.sort_order !== value) { entry.sort_order = value; changed.push(entry); } });
        return json({ item: { ...item }, items: changed.map(entry => ({ ...entry })) });
      }
      const one = p.match(/^\/api\/attention\/(\d+)$/);
      if (one) {
        const id = Number(one[1]);
        const item = db.items.find(entry => entry.id === id);
        if (!item) return json({ error: 'NOT_FOUND', message: 'Not found' }, 404);
        if (method === 'GET') {
          const events = [
            // As the server stores them: a move is an update with data.move; the row buttons' notes are English activity notes.
            { id: 11, item_id: id, at: '2026-11-05T10:08:00Z', actor: 'user', type: 'activity', data: { kind: 'note', text: 'Rejected: Missing tests' } },
            { id: 10, item_id: id, at: '2026-11-05T10:07:00Z', actor: 'user', type: 'activity', data: { kind: 'note', text: 'Handled' } },
            { id: 9, item_id: id, at: '2026-11-05T10:06:00Z', actor: 'user', type: 'updated', data: { sort_order: 30, move: { before: 12 } } },
            { id: 8, item_id: id, at: '2026-11-05T10:05:00Z', actor: 'user', type: 'updated', data: { sort_order: 20, move: { after: 14 }, reason: 'drag' } },
            { id: 7, item_id: id, at: '2026-11-05T10:04:00Z', actor: 'user', type: 'updated', data: { sort_order: 3 } },
            { id: 6, item_id: id, at: '2026-11-05T10:03:00Z', actor: 'claude', type: 'updated', data: { parent_id: 10 } },
            { id: 5, item_id: id, at: '2026-11-05T10:02:00Z', actor: 'claude', type: 'updated', data: { result: 'Half done' } },
            { id: 4, item_id: id, at: '2026-11-05T10:01:00Z', actor: 'claude', type: 'updated', data: { custom_status: 'Blocked' } },
            { id: 1, item_id: id, at: '2026-11-05T10:00:00Z', actor: 'claude', type: 'created', data: null },
          ];
          return json({ item, events });
        }
        if (method === 'PATCH') {
          if (db.failPatch) return json({ error: 'INTERNAL', message: 'The database is locked' }, 500);
          const { activity: _a, ...fields } = body;
          Object.assign(item, fields, { updated_at: new Date().toISOString() });
          return json({ ...item });
        }
        if (method === 'DELETE') {
          const children = db.items.filter(entry => entry.parent_id === id).map(entry => entry.id);
          if (children.length) return json({ error: 'HAS_CHILDREN', message: 'This task has sub-tasks', children }, 409);
          db.items = db.items.filter(entry => entry.id !== id);
          return route.fulfill({ status: 204, body: '' });
        }
      }
      return json({ error: 'not mocked' }, 404);
    }
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  // A terminal open, so the phone task sheet has gone and the bottom bar is there.
  const how = touch ? 'tap' : 'click';
  const terminal = page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main').first();
  if (!(await terminal.isVisible())) await page.locator('.h5-task-item', { hasText: 'Fix login' })[how]();
  await terminal[how]();
  await page.waitForFunction(() => innerWidth >= 900 || !document.body.classList.contains('h5-tasks-open') && Math.abs(document.getElementById('h5-app').getBoundingClientRect().left) < 0.5 && innerWidth >= document.getElementById('h5-app').getBoundingClientRect().right - 0.5);
  await page.waitForFunction(() => document.getElementById('h5-attention') && window.streams.length >= 1);
  return { context, page, errors, calls, db };
}

// The sheet open and settled.
async function openSheet(page, how) {
  await page.locator('#h5-attention')[how]();
  await page.locator('#h5-attention-sheet .h5-attention-panel').waitFor({ state: 'visible' });
  await page.waitForFunction(() => { const node = document.querySelector('#h5-attention-sheet .h5-attention-panel'); return node && ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(node).transform); });
  await page.locator('#h5-attention-sheet .h5-attention-row').first().waitFor();
}
const SHEET = '#h5-attention-sheet';
const idsIn = (page, group) => page.evaluate(([sheet, key]) => [...document.querySelectorAll(`${sheet} .h5-attention-group[data-group="${key}"] .h5-attention-row`)].map(node => Number(node.dataset.id)), [SHEET, group]);
const row = (page, id) => page.locator(`#h5-attention-body .h5-attention-row[data-id="${id}"]`); // not the floating copy
const nodeOf = (page, id) => page.locator(`#h5-attention-body .h5-attention-node[data-id="${id}"]`);
const notice = page => page.locator('.MuiSnackbar-root .MuiAlert-message');
const moves = calls => calls.filter(call => call.method === 'POST' && /\/move$/.test(call.path)).map(call => [Number(call.path.split('/')[3]), call.body]);
const patches = calls => calls.filter(call => call.method === 'PATCH').map(call => [Number(call.path.split('/')[3]), call.body]);
// Every drag is over: no floating copy, no slot, no row still sliding.
const settledDrag = page => page.waitForFunction(sheet => !document.querySelector('.h5-attention-float') && !document.querySelector(`${sheet} [data-drag-slot]`)
  && [...document.querySelectorAll(`${sheet} .h5-attention-node`)].every(node => !node.style.transform), SHEET, { timeout: 4000 });
const box = locator => locator.boundingBox();
const at = (rect, part = 0.5) => ({ x: rect.x + Math.min(120, rect.width / 2), y: rect.y + rect.height * part });

// A finger on the touch screen, through the DevTools protocol (real touch events and the pointer events made from them).
async function finger(page) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const moveTo = async (from, to, steps) => {
    for (let index = 1; index <= steps; index += 1) {
      await touch('touchMove', from.x + ((to.x - from.x) * index) / steps, from.y + ((to.y - from.y) * index) / steps);
      await page.waitForTimeout(16);
    }
  };
  return {
    touch,
    // Holds until the row is picked up (the copy floats), then moves; `release` false keeps the finger down at `to`.
    async holdDrag(from, to, { steps = 14, release = true } = {}) {
      await touch('touchStart', from.x, from.y);
      await page.waitForSelector('.h5-attention-float');
      await moveTo(from, to, steps);
      if (release) await touch('touchEnd');
    },
    async tap(spot) { await touch('touchStart', spot.x, spot.y); await page.waitForTimeout(60); await touch('touchEnd'); },
  };
}

async function testPhone(browser) {
  const { context, page, errors, calls, db } = await openPage(browser, { viewport: { width: 390, height: 844 } });
  await openSheet(page, 'tap');
  // The Home view: Needs you (waiting_user trees, then review), Working, To do, then "Done: N". A tree stays together in the section of its most
  // urgent open task: Release 2.0 (To do) is in Working because of its working sub-task, drawn first among its children.
  assert.deepEqual(await page.evaluate(sheet => [...document.querySelectorAll(`${sheet} .h5-attention-group`)].map(node => node.dataset.group), SHEET), ['needs_you', 'working', 'todo', 'closed']);
  assert.deepEqual(await idsIn(page, 'needs_you'), [1, 2, 3, 4]);
  assert.deepEqual(await idsIn(page, 'working'), [10, 16, 11, 13, 12]);
  assert.deepEqual(await idsIn(page, 'todo'), [14, 15]);
  assert.deepEqual(await idsIn(page, 'closed'), [], 'finished tasks are only counted');
  assert.equal(await page.locator('#h5-attention-closed-toggle .h5-attention-group-title').textContent(), 'Done: 1');
  assert.equal(await page.locator('#h5-attention-closed-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator(`${SHEET} .h5-attention-parent-hint`).count(), 0, 'no sub-task is drawn away from its parent');
  // Each heading has a coloured dot (no emoji), each one a different colour.
  const dots = await page.evaluate(sheet => [...document.querySelectorAll(`${sheet} .h5-attention-dot`)].map(node => [node.dataset.section, getComputedStyle(node).backgroundColor, node.getBoundingClientRect().width]), SHEET);
  assert.deepEqual(dots.map(([section]) => section), ['needs_you', 'working', 'todo', 'closed']);
  assert.equal(new Set(dots.map(([, color]) => color)).size, 4, `four colours: ${dots}`);
  assert.ok(dots.every(([, color, width]) => color !== 'rgba(0, 0, 0, 0)' && width === 8));
  assert.deepEqual(await page.locator(`${SHEET} .h5-attention-group-label`).allTextContents(), ['Needs you', 'Working', 'To do']);
  const depth = await page.evaluate(sheet => Object.fromEntries([...document.querySelectorAll(`${sheet} .h5-attention-row`)].map(node => [node.dataset.id, [Number(node.dataset.depth), parseFloat(getComputedStyle(node).paddingLeft)]])), SHEET);
  assert.deepEqual([depth[10], depth[16], depth[11], depth[13], depth[12], depth[3]], [[0, 0], [1, 16], [1, 16], [2, 32], [1, 16], [1, 16]], 'indented 16px per level');
  const guide = await page.evaluate(sheet => getComputedStyle(document.querySelector(`${sheet} .h5-attention-level[data-level="working:10"]`), '::before').borderLeftWidth, SHEET);
  assert.equal(guide, '1px', 'a thin guide line under the parent');
  // Every row: its own status pill and its time (MM-DD HH:MM, local); the detail line of its section.
  const pill = id => row(page, id).locator('.h5-attention-status').textContent();
  assert.deepEqual([await pill(10), await pill(16), await pill(1), await pill(2)], ['To do', 'Working', 'Needs you', 'Review']);
  const local = await page.evaluate(at => { const d = new Date(at); const p = n => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }, AT);
  assert.equal(await row(page, 1).locator('.h5-attention-updated').textContent(), local);
  assert.equal(await row(page, 1).locator('.h5-attention-reason').textContent(), 'Claude needs your permission to use Bash', 'Needs you: what you need to do');
  assert.equal(await row(page, 2).locator('.h5-attention-reason').textContent(), 'Claude finished. Review the result.');
  assert.equal(await row(page, 2).locator('.h5-attention-result').textContent(), 'Opened PR #1 with the login page', 'Review shows the result too');
  assert.equal(await row(page, 3).locator('.h5-attention-reason').textContent(), 'Waits for your confirmation', 'a review without a reason');
  assert.equal(await row(page, 11).locator('.h5-attention-progress').textContent(), 'Blocked', 'Working: the custom status');
  assert.equal(await row(page, 10).locator('.h5-attention-progress, .h5-attention-reason, .h5-attention-result').count(), 0);
  assert.equal(await row(page, 14).locator('.h5-attention-progress, .h5-attention-reason').count(), 0, 'To do: nothing extra');
  assert.equal(await page.locator(`${SHEET} .h5-attention-custom`).count(), 0, 'the custom status is in the Working line, not a pill');
  // The row buttons.
  const actions = id => row(page, id).locator('.h5-attention-action').allTextContents();
  assert.deepEqual(await actions(2), ['Confirm', 'Reject']);
  assert.deepEqual(await actions(3), ['Confirm', 'Reject']);
  assert.deepEqual(await actions(1), ['Handled']);
  assert.deepEqual(await actions(10), []);
  // Every control is 44px.
  const small = await page.evaluate(sheet => [...document.querySelectorAll(`${sheet} button, ${sheet} input`)].map(node => { const r = (node.closest('.MuiInputBase-root') || node).getBoundingClientRect(); return { cls: node.className.split(' ')[0], text: node.textContent, w: r.width, h: r.height }; }).filter(r => r.w && (r.w < 44 || r.h < 44)), SHEET);
  assert.deepEqual(small, [], 'every control is 44px');
  for (const id of [10, 11]) assert.equal(await row(page, id).locator('.h5-attention-fold').getAttribute('aria-label'), await row(page, id).locator('.h5-attention-fold').getAttribute('title'));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-attention-tree-phone.png') });
  // Done: N unfolds the finished tasks; one can be opened again from there.
  await page.locator('#h5-attention-closed-toggle').tap();
  assert.deepEqual(await idsIn(page, 'closed'), [20]);
  assert.equal(await row(page, 20).locator('.h5-attention-status').textContent(), 'Done');
  assert.equal(await row(page, 20).locator('.h5-attention-result').textContent(), 'Shipped');
  await page.locator('#h5-attention-closed-toggle').tap();
  assert.deepEqual(await idsIn(page, 'closed'), []);

  // Collapse: the sub-tasks go, the count shows, it is remembered.
  await row(page, 10).locator('.h5-attention-fold').tap();
  assert.deepEqual(await idsIn(page, 'working'), [10]);
  assert.equal(await row(page, 10).locator('.h5-attention-fold').getAttribute('aria-expanded'), 'false');
  assert.equal(await row(page, 10).locator('.h5-attention-fold-count').textContent(), '3');
  assert.equal(await row(page, 10).locator('.h5-attention-fold').getAttribute('aria-label'), 'Expand sub-tasks');
  assert.equal(await page.evaluate(() => localStorage.getItem('h5-attention-collapsed')), '[10]');
  await page.locator('#h5-attention-close').tap();
  await page.locator(`${SHEET} .h5-attention-panel`).waitFor({ state: 'hidden' });
  await openSheet(page, 'tap');
  assert.deepEqual(await idsIn(page, 'working'), [10], 'still collapsed when the panel opens again');
  await row(page, 10).locator('.h5-attention-fold').tap();
  assert.deepEqual(await idsIn(page, 'working'), [10, 16, 11, 13, 12]);
  assert.equal(await page.evaluate(() => localStorage.getItem('h5-attention-collapsed')), '[]');

  // Confirm, twice at once: one PATCH; the task is done, and stays drawn (Done pill) to keep its review sub-task under it.
  await row(page, 2).locator('.h5-attention-action[data-action="confirm"]').evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(sheet => document.querySelector(`${sheet} .h5-attention-row[data-id="2"] .h5-attention-status[data-status="done"]`), SHEET);
  await page.waitForFunction(() => !document.querySelector('.h5-attention-action:disabled'));
  assert.deepEqual(patches(calls), [[2, { status: 'done' }]], 'one request for a double tap');
  assert.deepEqual(await idsIn(page, 'needs_you'), [1, 4, 2, 3], 'the finished parent after the open review task');
  assert.equal(await row(page, 3).getAttribute('data-depth'), '1');
  assert.equal(await page.locator('#h5-attention-closed-toggle .h5-attention-group-title').textContent(), 'Done: 2');
  // Handled: the task goes to Working.
  await row(page, 1).locator('.h5-attention-action[data-action="handled"]').tap();
  await page.waitForFunction(sheet => document.querySelector(`${sheet} .h5-attention-group[data-group="working"] .h5-attention-row[data-id="1"]`), SHEET);
  assert.deepEqual(patches(calls).at(-1), [1, { status: 'working', attention_reason: null, activity: { kind: 'note', text: 'Handled' } }]);
  // Reject with a reason: the sub-task goes to Working, and its finished parent with it.
  await row(page, 3).locator('.h5-attention-action[data-action="reject"]').tap();
  await page.locator('#h5-attention-reject .MuiDialog-paper').waitFor({ state: 'visible' });
  await page.locator('#h5-attention-reject-reason').fill('  Missing tests ');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-attention-tree-reject.png') });
  await page.locator('#h5-attention-reject-confirm').tap();
  await page.waitForFunction(sheet => document.querySelector(`${sheet} .h5-attention-group[data-group="working"] .h5-attention-row[data-id="3"]`), SHEET);
  assert.deepEqual(patches(calls).at(-1), [3, { status: 'working', attention_reason: null, activity: { kind: 'note', text: 'Rejected: Missing tests' } }]);
  assert.deepEqual(await idsIn(page, 'working'), [1, 10, 16, 11, 13, 12, 2, 3]);
  assert.deepEqual(await idsIn(page, 'needs_you'), [4]);
  // A failed button: drawn at once, then put back with a notice.
  db.failPatch = true;
  await row(page, 4).locator('.h5-attention-action[data-action="confirm"]').tap();
  await notice(page).filter({ hasText: 'Could not update the task' }).waitFor();
  assert.match(await notice(page).textContent(), /The database is locked/);
  await page.waitForFunction(sheet => document.querySelector(`${sheet} .h5-attention-group[data-group="needs_you"] .h5-attention-row[data-id="4"]`), SHEET);
  db.failPatch = false;

  // Drag among siblings: Clean up held and put above Pay invoice (the top-level rows of To do).
  const f = await finger(page);
  await page.locator('#h5-attention-body').evaluate(list => { list.scrollTop = list.scrollHeight; });
  const pay = await box(row(page, 14));
  await f.holdDrag(at(await box(row(page, 15))), at(pay, 0.3), { release: false });
  assert.equal(await nodeOf(page, 15).getAttribute('data-drag-slot'), 'true', 'the slot of the held row');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-attention-tree-drag.png') });
  await f.touch('touchEnd');
  await settledDrag(page);
  await page.waitForFunction(() => !document.querySelector('.h5-attention-float'));
  assert.deepEqual(moves(calls), [[15, { before: 14 }]]);
  assert.deepEqual(await idsIn(page, 'todo'), [15, 14]);
  // A parent dragged with its sub-task, among the siblings of its own status (To do) under Release 2.0: Changelog after Tag the release.
  await page.locator('#h5-attention-body').evaluate(list => { list.scrollTop = 0; });
  const changelog = await box(row(page, 11));
  const tagRow = await box(row(page, 12));
  await f.holdDrag(at(changelog), { x: changelog.x + 120, y: tagRow.y + tagRow.height + 30 }, { release: false });
  assert.ok(await page.locator('.h5-attention-float .h5-attention-row[data-id="13"]').count(), 'the copy carries the sub-tasks');
  await f.touch('touchEnd');
  await settledDrag(page);
  assert.deepEqual(moves(calls).at(-1), [11, { after: 12 }]);
  assert.deepEqual(await idsIn(page, 'working'), [1, 10, 16, 12, 11, 13, 2, 3], 'the sub-task moved with its parent');
  // A drop on another section's title: Refactor login onto Needs you gives waiting_user, and its whole tree follows it into Needs you.
  await page.locator('#h5-attention-body').evaluate(list => { list.scrollTop = 0; });
  const needs = page.locator(`${SHEET} .h5-attention-drop[data-group="needs_you"]`);
  await f.holdDrag(at(await box(row(page, 16))), at(await box(needs)), { release: false });
  assert.equal(await needs.getAttribute('data-drop-over'), 'true');
  assert.equal(await needs.locator('.h5-attention-drop-hint').textContent(), '→ Needs you');
  assert.ok(await needs.locator('.h5-attention-drop-hint').isVisible(), 'the title says where the row goes');
  assert.equal(await page.locator(`${SHEET} .h5-attention-drop[data-group="working"]`).getAttribute('data-drop-over'), null, 'not its own section');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-attention-tree-drop.png') });
  await f.touch('touchEnd');
  await settledDrag(page);
  await page.waitForFunction(sheet => document.querySelector(`${sheet} .h5-attention-group[data-group="needs_you"] .h5-attention-row[data-id="16"]`), SHEET);
  assert.deepEqual(moves(calls).at(-1), [16, { position: 'top', status: 'waiting_user' }]);
  assert.deepEqual(await idsIn(page, 'needs_you'), [10, 16, 12, 11, 13, 4], 'the tree is in the section of its most urgent task');
  assert.deepEqual(await idsIn(page, 'working'), [1, 2, 3]);
  assert.equal(await needs.getAttribute('data-drop-over'), null);
  // A failed move: drawn at once, then the rows slide back and a notice says why.
  db.failMove = true;
  let release2;
  db.holdMove = new Promise(resolve => { release2 = resolve; });
  await page.locator('#h5-attention-body').evaluate(list => { list.scrollTop = list.scrollHeight; });
  const before = await idsIn(page, 'todo');
  const clean = await box(row(page, 15));
  const invoice = await box(row(page, 14));
  await f.holdDrag(at(clean), { x: clean.x + 120, y: invoice.y + invoice.height - 4 }); // not as far as the Done title below it, a drop target
  await page.waitForFunction(sheet => [...document.querySelectorAll(`${sheet} .h5-attention-group[data-group="todo"] .h5-attention-row`)].at(-1).dataset.id === '15', SHEET);
  release2();
  await notice(page).filter({ hasText: 'Could not move the task' }).waitFor();
  await page.waitForFunction(([sheet, ids]) => [...document.querySelectorAll(`${sheet} .h5-attention-group[data-group="todo"] .h5-attention-row`)].map(node => Number(node.dataset.id)).join() === ids.join(), [SHEET, before]);
  await settledDrag(page);
  db.failMove = false;
  db.holdMove = null;
  // A plain tap still opens the edit view (no drag).
  const movesSoFar = moves(calls).length;

  // The edit view of a sub-task with a sub-task of its own.
  await page.locator('#h5-attention-body').evaluate(list => { list.scrollTop = 0; });
  await f.tap(at(await box(row(page, 11).locator('.h5-attention-open'))));
  const edit = page.locator('#h5-attention-edit .MuiDialog-paper');
  await edit.waitFor({ state: 'visible' });
  assert.equal(moves(calls).length, movesSoFar, 'a tap moves nothing');
  assert.equal(await page.locator('#h5-attention-edit-custom').inputValue(), 'Blocked');
  assert.equal(await page.locator('#h5-attention-edit-result').inputValue(), '');
  assert.equal(await page.locator('#h5-attention-edit-parent').inputValue(), '10');
  const options = await page.locator('#h5-attention-edit-parent option').evaluateAll(list => list.map(option => option.value));
  assert.equal(options[0], '', 'None first');
  assert.ok(!options.includes('11') && !options.includes('13'), 'never itself or one of its sub-tasks');
  assert.ok(options.includes('10') && options.includes('2'));
  assert.deepEqual(await page.locator('#h5-attention-edit-children .h5-attention-child').evaluateAll(list => list.map(node => Number(node.dataset.id))), [13]);
  await page.locator('#h5-attention-history .h5-attention-event').first().waitFor();
  const sentences = await page.locator('#h5-attention-history .h5-attention-sentence').allTextContents();
  assert.deepEqual(sentences.map(text => text.replace(/ · \w+$/, '')), ['Created', 'Custom status: Blocked', 'Result: Half done', 'Moved under Release 2.0', 'Moved', 'Handled', 'Rejected: Missing tests'], 'a run of moves is one sentence');
  assert.equal(await page.locator('#h5-attention-move-up').isDisabled(), false, 'after Tag the release among its siblings of To do');
  assert.equal(await page.locator('#h5-attention-move-down').isDisabled(), true, 'already the last');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-attention-tree-edit.png') });
  // Move up from the keyboard buttons.
  await page.locator('#h5-attention-move-up').tap();
  await page.waitForFunction(() => document.getElementById('h5-attention-move-down') && !document.getElementById('h5-attention-move-down').disabled);
  assert.deepEqual(moves(calls).at(-1), [11, { before: 12 }]);
  // Save the new fields: now a top-level task of To do, with its sub-task.
  await page.locator('#h5-attention-edit-custom').fill('Waiting on CI');
  await page.locator('#h5-attention-edit-result').fill('Half done');
  await page.locator('#h5-attention-edit-parent').selectOption('');
  await page.locator('#h5-attention-edit-save').tap();
  await edit.waitFor({ state: 'hidden' });
  assert.deepEqual(patches(calls).at(-1), [11, { custom_status: 'Waiting on CI', result: 'Half done', parent_id: null }]);
  assert.equal(await row(page, 11).getAttribute('data-depth'), '0', 'now a top-level row');
  const todoNow = await idsIn(page, 'todo');
  assert.deepEqual(todoNow.slice(todoNow.indexOf(11), todoNow.indexOf(11) + 2), [11, 13], 'its sub-task under it, in To do');
  // A sub-task link opens that task.
  await row(page, 10).locator('.h5-attention-open').tap();
  await edit.waitFor({ state: 'visible' });
  await page.locator('#h5-attention-edit-children .h5-attention-child[data-id="12"]').tap();
  await page.waitForFunction(() => document.getElementById('h5-attention-edit-name').value === 'Tag the release');
  await page.locator('#h5-attention-edit-close').tap();
  await edit.waitFor({ state: 'hidden' });
  // Delete of a parent: the server refuses (409 HAS_CHILDREN) and the edit view says what to do.
  await row(page, 10).locator('.h5-attention-open').tap();
  await edit.waitFor({ state: 'visible' });
  await page.locator('#h5-attention-edit-delete').tap();
  await page.locator('#h5-attention-delete-confirm').tap();
  await page.locator('#h5-attention-edit-error').waitFor();
  assert.equal(await page.locator('#h5-attention-edit-error').textContent(), 'Delete or move its sub-tasks first');
  assert.ok(await edit.isVisible(), 'the edit view stays');
  await page.locator('#h5-attention-edit-close').tap();
  await edit.waitFor({ state: 'hidden' });
  // A reorder sent by the stream is no reminder: a renumbered neighbour (reorder: true, event: null, the same updated_at) still takes its new place.
  const tones = await page.evaluate(() => window.tones);
  const copy = db.items.find(entry => entry.id === 11);
  assert.notEqual((await idsIn(page, 'todo'))[0], 11);
  await page.evaluate(item => window.emitChange({ kind: 'updated', reorder: true, event: null, item: { ...item, sort_order: 1000 } }), copy);
  await page.waitForFunction(sheet => document.querySelector(`${sheet} .h5-attention-group[data-group="todo"] .h5-attention-row`).dataset.id === '11', SHEET);
  await page.evaluate(() => { const item = { id: 15, title: 'Clean up', status: 'waiting_user', parent_id: null, sort_order: 99, updated_at: new Date().toISOString() }; window.emitChange({ kind: 'updated', item, previous: { ...item, sort_order: 1 }, event: { type: 'moved', from_status: 'waiting_user', to_status: 'waiting_user' } }); });
  await page.waitForFunction(sheet => document.querySelector(`${sheet} .h5-attention-group[data-group="needs_you"] .h5-attention-row[data-id="15"]`), SHEET);
  assert.equal(await page.evaluate(() => window.tones), tones, 'no sound');
  assert.equal(await notice(page).filter({ hasText: 'Needs you: Clean up' }).count(), 0, 'no notice');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('  phone 390 touch: ok');
}

// An empty section keeps its heading with "None"; a finished parent with an open sub-task is drawn with it (and not again in the Done list).
async function testPhoneSections(browser) {
  const items = [node(30, 'Ship it', 'done', null, 5), node(31, 'Follow up', 'todo', 30, 4), node(20, 'Old thing', 'done', null, 1), node(21, 'Broken build', 'failed', null, 2)];
  const { context, page, errors, calls } = await openPage(browser, { viewport: { width: 390, height: 844 }, items });
  await openSheet(page, 'tap');
  const nones = await page.evaluate(sheet => [...document.querySelectorAll(`${sheet} .h5-attention-group`)].map(node => [node.dataset.group, node.dataset.empty === 'true', (node.querySelector('.h5-attention-none') || {}).textContent || '']), SHEET);
  assert.deepEqual(nones, [['needs_you', true, 'None'], ['working', true, 'None'], ['todo', false, ''], ['closed', false, '']]);
  assert.deepEqual(await idsIn(page, 'todo'), [30, 31]);
  assert.equal(await row(page, 30).locator('.h5-attention-status').textContent(), 'Done');
  assert.equal(await page.locator('#h5-attention-closed-toggle .h5-attention-group-title').textContent(), 'Done: 3', 'every finished task is counted');
  await page.locator('#h5-attention-closed-toggle').tap();
  assert.deepEqual(await idsIn(page, 'closed'), [21, 20], 'the finished parent is not drawn twice');
  // Opened again from the Done list.
  await row(page, 20).locator('.h5-attention-check').tap();
  await page.waitForFunction(sheet => document.querySelector(`${sheet} .h5-attention-group[data-group="todo"] .h5-attention-row[data-id="20"]`), SHEET);
  assert.deepEqual(patches(calls).at(-1), [20, { status: 'todo' }]);
  assert.equal(await page.locator('#h5-attention-closed-toggle .h5-attention-group-title').textContent(), 'Done: 2');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-attention-tree-sections.png') });
  assert.deepEqual(errors, []);
  await context.close();
  console.log('  phone sections: ok');
}

async function testSmallPhone(browser) {
  const { context, page, errors } = await openPage(browser, { viewport: { width: 320, height: 640 } });
  await openSheet(page, 'tap');
  const wide = await page.evaluate(sheet => [...document.querySelectorAll(`${sheet} .h5-attention-row, ${sheet} .h5-attention-actions, ${sheet} .h5-attention-group-title`)]
    .filter(node => node.scrollWidth > node.clientWidth + 1 || node.getBoundingClientRect().right > innerWidth + 0.5).map(node => node.className.split(' ')[0] + (node.dataset.id || '')), SHEET);
  assert.deepEqual(wide, [], 'every row fits 320px');
  const small = await page.evaluate(sheet => [...document.querySelectorAll(`${sheet} button`)].map(node => { const r = node.getBoundingClientRect(); return { cls: node.className.split(' ')[0], w: r.width, h: r.height }; }).filter(r => r.w && (r.w < 44 || r.h < 44)), SHEET);
  assert.deepEqual(small, []);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-attention-tree-320.png') });
  assert.deepEqual(errors, []);
  await context.close();
  console.log('  phone 320 touch: ok');
}

async function testComputer(browser) {
  const { context, page, errors, calls, db } = await openPage(browser, { viewport: { width: 1440, height: 900 }, touch: false });
  await openSheet(page, 'click');
  // A click opens the edit view; nothing moves.
  await row(page, 14).locator('.h5-attention-title').click();
  await page.locator('#h5-attention-edit .MuiDialog-paper').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await page.locator('#h5-attention-edit .MuiDialog-paper').waitFor({ state: 'hidden' });
  assert.deepEqual(moves(calls), []);
  // A mouse moved 4px picks the row up: Pay invoice above Release 2.0.
  const pay = await box(row(page, 14));
  const release = await box(row(page, 10));
  await page.mouse.move(pay.x + 120, pay.y + pay.height / 2);
  await page.mouse.down();
  await page.mouse.move(pay.x + 120, pay.y + pay.height / 2 - 6, { steps: 2 });
  await page.waitForSelector('.h5-attention-float');
  await page.mouse.move(release.x + 120, release.y + 4, { steps: 12 });
  await page.mouse.up();
  await settledDrag(page);
  assert.deepEqual(moves(calls), [[14, { before: 10 }]]);
  assert.deepEqual(await idsIn(page, 'todo'), [14, 10, 11, 13, 12, 15]);
  assert.equal(await page.locator('#h5-attention-edit').count(), 0, 'the click after a drag opens nothing');
  // A drop on the folded Done & failed title: done.
  const closed = await box(page.locator('#h5-attention-closed-toggle'));
  const clean = await box(row(page, 15));
  await page.mouse.move(clean.x + 120, clean.y + clean.height / 2);
  await page.mouse.down();
  await page.mouse.move(clean.x + 120, clean.y + clean.height / 2 + 6, { steps: 2 });
  await page.waitForSelector('.h5-attention-float');
  await page.mouse.move(closed.x + 120, closed.y + closed.height / 2, { steps: 10 });
  assert.equal(await page.locator('#h5-attention-closed-toggle').getAttribute('data-drop-over'), 'true');
  await page.mouse.up();
  await settledDrag(page);
  assert.deepEqual(moves(calls).at(-1), [15, { position: 'top', status: 'done' }]);
  assert.equal(await page.locator('#h5-attention-closed-toggle').getAttribute('aria-expanded'), 'false', 'a drop does not unfold it');
  // A server without /move: the first move fails, and the rows can no longer be dragged.
  db.noMove = true;
  const tag = await box(row(page, 12));
  const top = await box(row(page, 14));
  await page.mouse.move(tag.x + 120, tag.y + tag.height / 2);
  await page.mouse.down();
  await page.mouse.move(tag.x + 120, tag.y + tag.height / 2 - 6, { steps: 2 });
  await page.waitForSelector('.h5-attention-float');
  await page.mouse.move(top.x + 120, top.y + 2, { steps: 8 });
  await page.mouse.up();
  await notice(page).filter({ hasText: 'Could not move the task' }).waitFor();
  await page.waitForFunction(sheet => !document.querySelector(`${sheet} .h5-attention-node[data-movable]`), SHEET);
  await settledDrag(page);
  assert.equal(await page.locator('#h5-attention-sheet .h5-attention-drop').count(), 0, 'no drop targets either');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-attention-tree-1440.png') });
  assert.deepEqual(errors, []);
  await context.close();
  console.log('  computer 1440 mouse: ok');
}

async function testOldServer(browser) {
  const { context, page, errors, calls } = await openPage(browser, { viewport: { width: 390, height: 844 }, items: OLD() });
  await openSheet(page, 'tap');
  assert.equal(await page.locator(`${SHEET} .h5-attention-fold`).count(), 0, 'no tree');
  assert.equal(await page.locator(`${SHEET} .h5-attention-node[data-movable]`).count(), 0, 'no drag');
  assert.equal(await page.locator(`${SHEET} .h5-attention-drop`).count(), 0);
  assert.equal(await page.locator(`${SHEET} .h5-attention-custom, ${SHEET} .h5-attention-result`).count(), 0, 'no new fields');
  assert.deepEqual(await idsIn(page, 'todo'), [10, 11, 12, 13, 14, 15], 'the old order (no priority, no due date: by id)');
  // A long press does not pick a row up.
  const f = await finger(page);
  const spot = at(await box(row(page, 14)));
  await f.touch('touchStart', spot.x, spot.y);
  await page.waitForTimeout(600); // longer than the hold, to see that nothing was picked up
  assert.equal(await page.locator('.h5-attention-float').count(), 0);
  await f.touch('touchEnd');
  await row(page, 12).locator('.h5-attention-open').tap();
  await page.locator('#h5-attention-edit .MuiDialog-paper').waitFor({ state: 'visible' });
  for (const id of ['custom', 'result', 'parent', 'move-up']) assert.equal(await page.locator(`#h5-attention-edit-${id}, #h5-attention-${id}`).count(), 0, `no ${id}`);
  await page.locator('#h5-attention-edit-close').tap();
  assert.deepEqual(moves(calls), []);
  assert.deepEqual(errors, []);
  await context.close();
  console.log('  older server: ok');
}

async function testChinese(browser) {
  const { context, page, errors } = await openPage(browser, { viewport: { width: 390, height: 844 }, zh: true });
  await openSheet(page, 'tap');
  await page.waitForFunction(sheet => document.querySelector(`${sheet} .h5-attention-action[data-action="confirm"]`).textContent === '\u786e\u8ba4', SHEET);
  assert.deepEqual(await row(page, 2).locator('.h5-attention-action').allTextContents(), ['\u786e\u8ba4', '\u6253\u56de']);
  assert.deepEqual(await row(page, 1).locator('.h5-attention-action').allTextContents(), ['\u5df2\u5904\u7406']);
  assert.equal(await row(page, 10).locator('.h5-attention-fold').getAttribute('aria-label'), '\u6298\u53e0\u5b50\u4efb\u52a1');
  // The phone's sections, the Done line and the review line without a reason.
  assert.deepEqual(await page.locator(`${SHEET} .h5-attention-group-label`).allTextContents(), ['\u9700\u8981\u4f60', '\u8fdb\u884c\u4e2d', '\u5f85\u529e']);
  assert.equal(await page.locator('#h5-attention-closed-toggle .h5-attention-group-title').textContent(), '\u5df2\u5b8c\u6210\uff1a1');
  assert.equal(await row(page, 3).locator('.h5-attention-reason').textContent(), '\u7b49\u4f60\u786e\u8ba4');
  await row(page, 11).locator('.h5-attention-open').tap();
  await page.locator('#h5-attention-edit .MuiDialog-paper').waitFor({ state: 'visible' });
  assert.equal(await page.locator('label[for="h5-attention-edit-custom"]').textContent(), '\u81ea\u5b9a\u4e49\u72b6\u6001');
  assert.equal(await page.locator('#h5-attention-edit-parent option').first().textContent(), '\u65e0');
  await page.locator('#h5-attention-history .h5-attention-event').first().waitFor();
  assert.ok((await page.locator('#h5-attention-history .h5-attention-sentence').allTextContents()).some(text => text.startsWith('\u79fb\u5230\u201cRelease 2.0\u201d\u4e0b\u9762')), 'the parent sentence');
  const notes = await page.locator('#h5-attention-history .h5-attention-sentence').allTextContents();
  assert.ok(notes.includes('\u5df2\u5904\u7406') && notes.some(text => text.startsWith('\u5df2\u6253\u56de')), `the row buttons' notes: ${notes}`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-attention-tree-zh.png') });
  assert.deepEqual(errors, []);
  await context.close();
  console.log('  Chinese: ok');
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await testPhone(browser);
    await testPhoneSections(browser);
    await testSmallPhone(browser);
    await testComputer(browser);
    await testOldServer(browser);
    await testChinese(browser);
  } finally {
    await browser.close();
  }
  console.log('h5 attention tree browser test passed');
})().catch(error => { console.error(error); process.exit(1); });
