// The shared page state in real Chromium (public/js/page-state.js, h5.js "Recent sessions"; docs/design/shared-page-state.md): the page of T01 on a
// computer (1440x900) and the page of K01 on a phone (390x844, touch) are two origins with one shared state behind them (two engines kept in step by
// their sync; here one in-memory state through the real merge rules, services/page-state-merge.js). Each lists the other engine under its own
// source key (T01: K01 is remote:7; K01: T01 is remote:3). Proven: the old per-browser list is imported once and its key removed; the Recent list
// made on T01 shows on K01 in the same order under K01's own keys (switcher and Recent tab); the task list tab chosen on the phone follows on the
// computer when it gets the focus again; tap to translate turned on on the computer is on on the phone; a delete on K01 leaves T01's list; the
// columns turned on on T01, with a session in its first column, are the same columns on a computer of K01, whose first column shows that session.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const merge = require('../services/page-state-merge');
const root = path.resolve(__dirname, '..');
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const T = '11111111-1111-4111-8111-111111111111';
const K = '22222222-2222-4222-8222-222222222222';

// The tasks of each engine, as both pages see them (one through its own API, the other through its remote proxy).
const T_TASKS = [{ id: 1, title: 'Fix login', status: 'doing' }, { id: 2, title: 'Write docs', status: 'doing' }];
const T_TERMINALS = { 1: [{ terminal_id: 'default', title: 'Terminal 1' }, { terminal_id: 'c1', title: 'Claude work', agent: 'claude' }], 2: [{ terminal_id: 'd1', title: 'Docs shell' }] };
const K_TASKS = [{ id: 5, title: 'Build server', status: 'doing' }];
const K_TERMINALS = { 5: [{ terminal_id: 'k1', title: 'Build shell' }] };
const GROUPS = [{ key: 'doing', name: 'In progress', sort_order: 1 }];

// One shared state for both engines.
let shared = { recent: {}, keys: {} };
const puts = [];
function answer(instance) { return { instance_id: instance, ...merge.pageView(shared), peers: [] }; }

async function openPage(browser, { origin, own, other, otherId, otherName, viewport, touch, before = null }) {
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(seed => {
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ type: 'history', data: '$ ', cols: 60, rows: 20 }) }); }, 0); }
      send() {}
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    if (seed && !localStorage.getItem('seeded')) { localStorage.setItem('seeded', '1'); for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value); }
  }, before);
  const mine = own === T ? { tasks: T_TASKS, terminals: T_TERMINALS } : { tasks: K_TASKS, terminals: K_TERMINALS };
  const theirs = own === T ? { tasks: K_TASKS, terminals: K_TERMINALS } : { tasks: T_TASKS, terminals: T_TERMINALS };
  await page.route(`${origin}/**`, route => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
    if (p === '/api/page-state' && method === 'GET') return json(answer(own));
    if (p === '/api/page-state' && method === 'PUT') {
      const body = JSON.parse(route.request().postData() || '{}');
      puts.push({ origin, body });
      shared = merge.merge(shared, merge.changeState(body, { at: Date.now() + puts.length, by: own }), Date.now()).state;
      return json(answer(own));
    }
    if (p === '/api/system/version') return json({ engine_name: own === T ? 'T01' : 'K01', instance_id: own });
    if (p === '/api/remote-servers') return json([{ id: otherId, name: otherName, status: 'online', base_url: 'http://10.0.0.7:14002', enabled: true, instance_id: other }]);
    if (p === '/api/tasks' && method === 'GET') return json(mine.tasks);
    if (p === `/api/remote-servers/${otherId}/tasks` && method === 'GET') return json(theirs.tasks);
    if (p === '/api/task-groups' || p === `/api/remote-servers/${otherId}/task-groups`) return json(GROUPS);
    if (/terminal-activity$/.test(p) || /terminal-subagents$/.test(p)) return json({});
    if (/\/terminal\/ack$/.test(p)) return json({ success: true });
    const local = p.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (local && method === 'GET') return json(mine.terminals[local[1]] || []);
    const remote = p.match(new RegExp(`^/api/remote-servers/${otherId}/tasks/(\\d+)/terminals$`));
    if (remote && method === 'GET') return json(theirs.terminals[remote[1]] || []);
    if (p === `/api/remote-servers/${otherId}/info`) return json({ capabilities: [] });
    if (/\/agent\/conversations$/.test(p)) return json([]);
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${origin}/h5`);
  await page.waitForFunction(() => (window.H5UI.get().taskList.tasks || []).length === 3, null, { timeout: 15000 });
  return { context, page, errors };
}
const shownIs = (page, task, terminal) => page.waitForFunction(([name, id]) => document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId === id
  && document.getElementById('h5-task-name').textContent === name, [task, terminal], { timeout: 10000 });
async function visit(page, ref, terminal, task) {
  await page.evaluate(([r, id]) => window.H5UI.actions.openRow(r, { kind: 'terminal', id }), [ref, terminal]);
  await shownIs(page, task, terminal);
}
const recentKeys = page => page.evaluate(() => window.H5UI.get().recent.map(entry => `${entry.sourceKey}|${entry.taskId}|${entry.terminalId}`));
const sharedIds = () => merge.pageView(shared).recent.map(entry => `${entry.instance === T ? 'T' : entry.instance === K ? 'K' : entry.instance}|${entry.task}|${entry.terminal}`);
async function until(check, label, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label} (${JSON.stringify(await check())})`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
// The page reads the state again when the window gets the focus (at most every 3 s since the last read).
async function refocus(page) {
  await page.waitForTimeout(3100);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    // ── T01 on a computer: its old per-browser list is imported once; the sessions it shows go to the shared state ──
    const oldList = JSON.stringify([{ sourceKey: 'local', taskId: '2', terminalId: 'd1', title: 'Docs shell', agent: null }]);
    const t01 = await openPage(browser, { origin: 'http://t01.test', own: T, other: K, otherId: 7, otherName: 'K01', viewport: { width: 1440, height: 900 }, touch: false, before: { 'h5-recent-sessions': oldList } });
    await until(() => sharedIds().includes('T|2|d1'), 'the old list imported');
    assert.equal(await t01.page.evaluate(() => localStorage.getItem('h5-recent-sessions')), null, 'the old key is removed after the import');
    assert.ok(puts.some(put => put.body.import && put.body.import.recent.some(entry => entry.instance === T && entry.terminal === 'd1')), 'sent as an import');
    await visit(t01.page, 'local|1', 'default', 'Fix login');
    await visit(t01.page, 'remote:7|5', 'k1', 'Build server');
    await visit(t01.page, 'local|1', 'c1', 'Fix login');
    await until(() => sharedIds().slice(0, 3).join() === 'T|1|c1,K|5|k1,T|1|default', 'the sessions of T01 in the shared state');
    assert.deepEqual(await recentKeys(t01.page), ['local|1|c1', 'remote:7|5|k1', 'local|1|default', 'local|2|d1']);

    // ── K01 on a phone: the same list, under its own source keys ──
    const k01 = await openPage(browser, { origin: 'http://k01.test', own: K, other: T, otherId: 3, otherName: 'T01', viewport: { width: 390, height: 844 }, touch: true });
    await k01.page.waitForFunction(() => window.H5UI.get().recent.length === 4, null, { timeout: 10000 });
    assert.deepEqual(await recentKeys(k01.page), ['remote:3|1|c1', 'local|5|k1', 'remote:3|1|default', 'remote:3|2|d1'], 'the same sessions in the same order on the other engine');
    // The Recent tab of the phone's drawer draws them.
    await k01.page.locator('#h5-tab-recent').waitFor();
    await k01.page.locator('#h5-tab-recent').tap();
    await k01.page.waitForFunction(() => [...document.querySelectorAll('#h5-recent-list .h5-recent-row')].map(row => row.dataset.key).join() === 'remote:3|1|c1,local|5|k1,remote:3|1|default,remote:3|2|d1', null, { timeout: 10000 });
    await until(() => merge.pageView(shared).keys['h5-task-list-tab'] === 'recent', 'the chosen tab in the shared state');

    // ── The computer follows when it gets the focus again: the Recent tab is chosen there too ──
    assert.equal(await t01.page.locator('#h5-tab-recent').getAttribute('aria-selected'), 'false');
    await refocus(t01.page);
    await t01.page.waitForFunction(() => document.getElementById('h5-tab-recent')?.getAttribute('aria-selected') === 'true', null, { timeout: 10000 });
    assert.equal(await t01.page.evaluate(() => localStorage.getItem('h5-task-list-tab')), 'recent', 'mirrored into the browser\'s own key (the cache)');

    // ── Tap to translate turned on on the computer is on on the phone ──
    assert.equal(await k01.page.evaluate(() => window.WordTranslate.enabled), false);
    await t01.page.evaluate(() => window.WordTranslate.setEnabled(true));
    await until(() => merge.pageView(shared).keys['word-translate'] === '1', 'tap to translate in the shared state');
    await refocus(k01.page);
    await k01.page.waitForFunction(() => window.WordTranslate.enabled === true, null, { timeout: 10000 });

    // ── The phone shows a session; a delete on the phone leaves the computer's list ──
    await visit(k01.page, 'local|5', 'k1', 'Build server');
    await until(() => sharedIds()[0] === 'K|5|k1', 'K01 noted its own session first');
    await k01.page.evaluate(() => window.TAPageState.noteRecent([{ instance: '11111111-1111-4111-8111-111111111111', task: '2', terminal: 'd1', gone: true }]));
    await until(() => !sharedIds().includes('T|2|d1'), 'the delete in the shared state');
    await refocus(t01.page);
    await t01.page.waitForFunction(() => window.H5UI.get().recent.map(entry => `${entry.sourceKey}|${entry.taskId}|${entry.terminalId}`).join() === 'remote:7|5|k1,local|1|c1,local|1|default', null, { timeout: 10000 });

    // ── Columns: the layout and the session of a column made on T01 are the same on a computer of K01 ──
    await t01.page.evaluate(() => window.H5UI.actions.toggleColumns());
    await t01.page.waitForFunction(() => window.H5UI.get().columns.shown && window.H5UI.get().columns.ids.length >= 2, null, { timeout: 10000 });
    const ids = await t01.page.evaluate(() => window.H5UI.get().columns.ids);
    await until(() => { const raw = merge.pageView(shared).keys['h5-columns']; return raw && JSON.parse(raw).on === true && JSON.parse(raw).ids.join() === ids.join(); }, 'the layout in the shared state');
    const paneOf = (page, id) => page.frames().find(frame => frame.url().endsWith(`/h5?pane=${id}`));
    await until(() => paneOf(t01.page, ids[0]), 'the first column of T01');
    const first = paneOf(t01.page, ids[0]);
    await first.waitForFunction(() => window.H5UI && (window.H5UI.get().taskList.tasks || []).length === 3, null, { timeout: 15000 });
    await first.evaluate(() => window.H5UI.actions.openRow('remote:7|5', { kind: 'terminal', id: 'k1' }));
    await until(() => { const raw = merge.pageView(shared).keys[`h5-column:${ids[0]}`]; return raw && JSON.parse(raw).instance === K && JSON.parse(raw).terminal === 'k1'; }, 'the column\'s session in the shared state');
    const k01pc = await openPage(browser, { origin: 'http://k01.test', own: K, other: T, otherId: 3, otherName: 'T01', viewport: { width: 1440, height: 900 }, touch: false });
    await k01pc.page.waitForFunction(want => { const columns = window.H5UI.get().columns; return columns && columns.shown && columns.ids.join() === want.join(); }, ids, { timeout: 10000 });
    await until(() => paneOf(k01pc.page, ids[0]), 'the first column of K01');
    const mirrored = paneOf(k01pc.page, ids[0]);
    // A pane has no header of its own: the shown terminal and its target say what it shows (K01 names its own session `local`).
    await mirrored.waitForFunction(() => { const shown = window.H5UI.get().shownTarget; return document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId === 'k1' && shown && shown.sourceKey === 'local' && String(shown.taskId) === '5'; }, null, { timeout: 15000 });
    assert.deepEqual(k01pc.errors, [], 'no page errors on the computer of K01');
    await k01pc.context.close();

    assert.deepEqual(t01.errors, [], 'no page errors on T01');
    assert.deepEqual(k01.errors, [], 'no page errors on K01');
    await t01.context.close();
    await k01.context.close();
    console.log('Shared page state: the old list imported once, the same Recent list on two engines under their own source keys, the chosen tab and tap to translate followed on focus, a delete travels, the columns and the session of a column on a computer of the other engine: passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
