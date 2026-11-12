// T-Attention of every engine in one list (scripts/h5-shell/Attention.jsx, attention-feed.mjs, attention-model.mjs; "T-Attention on the page" in DESIGN.md),
// in real Chromium with the API mocked by Playwright routes and a fake EventSource per stream:
// - this machine ("mac") and K01 (remote 7, 'attention:remote') merged in one list, each row with the engine tag of the task list, each group in engine
//   blocks (this machine first) with repeating ids; Old (no capability) and Legacy (capability, answers 501) left out silently; Hidden (hidden from the
//   task list) left out; Down (its list answers 502) named by a muted "Could not load Down" line; Gone (offline in the task list) never read;
// - a live change of K01's stream updates the list, the badge and reminds with "(K01)"; one of this machine reminds without a name;
// - every action goes to the item's own engine: Confirm, Reject, Handled, edit save, Parent select (its own engine only), Move down, delete, history,
//   summarize; the jump back opens K01's task terminal through the one list;
// - drag: a K01 row dragged over this machine's rows stays in K01's block ({ before } of a K01 id, on K01's URL); a drop on a group title moves it on K01;
// - quick add "on K01" (remembered); hiding K01 in the task list takes its rows and stream away and showing it brings them back;
// - phone 390 and 320 (touch, 3x screenshots with H5_SHOT_DIR), computer 1440 (mouse), Chinese, and a single engine that looks as before (no tags).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const AT = '2026-11-05T10:00:00Z';
const SHEET = '#h5-attention-sheet';

const node = (id, title, status, parent, order, extra = {}) => ({
  id, title, status, parent_id: parent, sort_order: order, custom_status: null, result: null, priority: 'none', source: 'claude', updated_at: AT, created_at: AT, ...extra,
});
const LOCAL_ITEMS = () => [
  node(1, 'Allow Bash', 'waiting_user', null, 10, { attention_reason: 'Claude needs your permission' }),
  node(2, 'Check the PR', 'review', null, 20, { result: 'PR #1' }),
  node(10, 'Release 2.0', 'todo', null, 50, { source: 'user' }),
  node(11, 'Changelog', 'todo', 10, 40),
  node(14, 'Pay invoice', 'todo', null, 45, { source: 'user' }),
];
const REMOTE_ITEMS = () => [
  node(1, 'Deploy site', 'review', null, 30, {
    result: 'Deployed to staging', attention_reason: 'Claude finished. Review the result.',
    context: { host: 'k01', cwd: '/srv/site', goal: 'Ship the site', tagent: { task_id: 1, terminal_id: 'r1' }, session: { resume: 'claude --resume s9' }, summary: { text: 'The deploy is done.', at: AT, model: 'mini' } },
  }),
  node(3, 'Second review', 'review', null, 10, { result: 'Drafted' }),
  node(4, 'Third review', 'review', null, 5),
  node(2, 'Answer the question', 'waiting_user', null, 5, { attention_reason: 'Which region?' }),
  node(10, 'Remote parent', 'todo', null, 60),
  node(11, 'Remote child', 'todo', 10, 55),
  node(14, 'Remote chores', 'todo', null, 20),
  node(20, 'Old remote', 'done', null, 1),
];

function makeWorld({ remotes = true } = {}) {
  return {
    remotes, hidden: ['remote:9'], calls: [], errors: [], sockets: [],
    dbs: { '/api/attention': { items: LOCAL_ITEMS(), host: 'mac', instance: 'inst-local', nextId: 100 }, '/api/remote-servers/7/attention': { items: REMOTE_ITEMS(), host: 'k01', instance: 'inst-k01', nextId: 200 } },
  };
}
const SERVERS = [
  { id: 7, name: 'K01', instance_id: 'inst-k01', caps: ['attention:remote', 'terminal:control'] },
  { id: 8, name: 'Old', instance_id: 'inst-old', caps: ['tasks:archive'] },
  { id: 9, name: 'Hidden', instance_id: 'inst-hid', caps: ['attention:remote'] },
  { id: 10, name: 'Down', instance_id: 'inst-down', caps: ['attention:remote'], attention: 502 },
  { id: 11, name: 'Legacy', instance_id: 'inst-leg', caps: ['attention:remote'], attention: 501 },
  { id: 12, name: 'Gone', instance_id: 'inst-gone', caps: ['attention:remote'], offline: true },
];

// One engine's T-Attention API (the same shapes locally and through the proxy).
async function attention(world, base, rest, method, body, json, route) {
  const db = world.dbs[base];
  if (rest === '' && method === 'GET') return json({ items: db.items, host: db.host, instance_id: db.instance });
  if (rest === '' && method === 'POST') { const item = node(db.nextId++, body.title, 'todo', null, 1000, { source: 'user' }); db.items.push(item); return json(item, 201); }
  const move = rest.match(/^\/(\d+)\/move$/);
  if (move && method === 'POST') {
    const item = db.items.find(entry => entry.id === Number(move[1]));
    if (body.status) item.status = body.status;
    const group = db.items.filter(entry => entry.status === item.status && entry !== item).sort((a, b) => b.sort_order - a.sort_order);
    let at = 0;
    if (body.before !== undefined) at = group.findIndex(entry => entry.id === body.before);
    else if (body.after !== undefined) at = group.findIndex(entry => entry.id === body.after) + 1;
    group.splice(at, 0, item);
    const changed = [];
    group.forEach((entry, index) => { const value = (group.length - index) * 10; if (entry.sort_order !== value) { entry.sort_order = value; changed.push(entry); } });
    return json({ item: { ...item }, items: changed.map(entry => ({ ...entry })) });
  }
  const summarize = rest.match(/^\/(\d+)\/summarize$/);
  if (summarize && method === 'POST') return json({ ok: true, queued: true }, 202);
  const one = rest.match(/^\/(\d+)$/);
  if (!one) return json({ error: 'not mocked' }, 404);
  const id = Number(one[1]);
  const item = db.items.find(entry => entry.id === id);
  if (!item) return json({ error: 'NOT_FOUND', message: 'Not found' }, 404);
  if (method === 'GET') return json({ item, events: [{ id: 1, item_id: id, at: AT, actor: 'claude', type: 'created', data: null }, { id: 2, item_id: id, at: '2026-11-05T10:05:00Z', actor: 'user', type: 'activity', data: { kind: 'note', text: `${db.host} note` } }] });
  if (method === 'PATCH') { const { activity: _a, ...fields } = body; Object.assign(item, fields, { updated_at: new Date().toISOString() }); return json({ ...item }); }
  if (method === 'DELETE') {
    const children = db.items.filter(entry => entry.parent_id === id).map(entry => entry.id);
    if (children.length) return json({ error: 'HAS_CHILDREN', message: 'This task has sub-tasks', children }, 409);
    db.items = db.items.filter(entry => entry.id !== id);
    return route.fulfill({ status: 204, body: '' });
  }
  return json({ error: 'not mocked' }, 404);
}

async function serve(world, route) {
  const request = route.request();
  const url = new URL(request.url());
  const p = url.pathname;
  const method = request.method();
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
  if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
  if (p === '/api/system/version') return json({ engine_name: 'mac', instance_id: 'inst-local' });
  if (p === '/api/remote-servers') return json(world.remotes ? SERVERS.map(server => ({ id: server.id, name: server.name, status: server.offline ? 'offline' : 'online', enabled: true, instance_id: server.instance_id })) : []);
  if (p === '/api/task-list/hidden-devices') {
    if (method === 'PUT') world.hidden = JSON.parse(request.postData()).hidden;
    return json({ hidden: world.hidden });
  }
  if (p === '/api/tasks' && method === 'GET') return json([{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login', archived_at: null }]);
  if (p === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
  if (p === '/api/tasks/1/terminals') return json([{ terminal_id: 't1', title: 'Terminal 1' }]);
  if (/\/agent\/conversations$/.test(p)) return json([]);
  const body = request.postData() ? JSON.parse(request.postData()) : undefined;
  if (p.startsWith('/api/attention')) {
    world.calls.push({ method, path: p + url.search, body });
    return attention(world, '/api/attention', p.slice('/api/attention'.length), method, body, json, route);
  }
  const remote = p.match(/^\/api\/remote-servers\/(\d+)(\/.*)$/);
  if (remote) {
    const server = SERVERS.find(entry => entry.id === Number(remote[1]));
    const rest = remote[2];
    if (!server) return json({ error: 'not mocked' }, 404);
    if (rest.startsWith('/attention')) {
      world.calls.push({ method, path: p + url.search, body, remote: server.id });
      if (server.attention === 502) return json({ error: 'REMOTE_CONNECTION_FAILED', message: 'The remote engine cannot be reached' }, 502);
      if (server.attention === 501) return json({ error: 'ATTENTION_REMOTE_UNSUPPORTED', message: 'The remote engine has no T-Attention' }, 501);
      return attention(world, `/api/remote-servers/${server.id}/attention`, rest.slice('/attention'.length), method, body, json, route);
    }
    if (server.offline) return json({ error: 'REMOTE_OFFLINE' }, 502);
    if (rest === '/info') return json({ capabilities: server.caps });
    if (rest === '/tasks' && method === 'GET') return json(server.id === 7 ? [{ id: 1, title: 'Deploy site task', status: 'doing', work_dir: '/srv/site', archived_at: null }] : []);
    if (rest === '/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (rest === '/tasks/1/terminals') return json([{ terminal_id: 'r1', title: 'Remote shell' }]);
    if (/terminal-activity$|terminal-subagents$/.test(rest)) return json({});
    return json({ error: 'not mocked' }, 404);
  }
  if (/terminal-activity$|terminal-subagents$/.test(p)) return json({});
  return json({ error: 'not mocked' }, 404);
}

async function openPage(browser, world, { viewport, touch = true, zh = false }) {
  const scale = SHOTS && touch ? { deviceScaleFactor: 3 } : {};
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...scale });
  const page = await context.newPage();
  page.on('pageerror', error => world.errors.push(error.message));
  await page.addInitScript(({ zh: chinese }) => {
    window.socketUrls = [];
    window.WebSocket = class {
      constructor(url) { window.socketUrls.push(url); this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
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
    // The open stream of one path (T-Attention: '/api/attention/stream' or '/api/remote-servers/7/attention/stream').
    window.openStreams = pathname => window.streams.filter(s => s.readyState === 1 && new URL(s.url, location.href).pathname === pathname);
    window.emitOn = (pathname, change) => window.openStreams(pathname).at(-1).dispatchEvent(new MessageEvent('change', { data: JSON.stringify(change) }));
    window.AudioContext = class {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
      resume() { return Promise.resolve(); }
      createOscillator() { return { type: '', frequency: {}, connect() {}, start() {}, stop() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    };
    try { if (chinese) localStorage.setItem('ta-lang', 'zh'); } catch { /* none */ }
  }, { zh });
  await page.route(`${ORIGIN}/**`, route => serve(world, route));
  await page.goto(`${ORIGIN}/h5`);
  const how = touch ? 'tap' : 'click';
  const terminal = page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main').first();
  if (!(await terminal.isVisible())) await page.locator('.h5-task-item', { hasText: 'Fix login' })[how]();
  await terminal[how]();
  await page.waitForFunction(() => innerWidth >= 900 || !document.body.classList.contains('h5-tasks-open') && Math.abs(document.getElementById('h5-app').getBoundingClientRect().left) < 0.5);
  await page.waitForFunction(() => document.getElementById('h5-attention') && window.openStreams('/api/attention/stream').length === 1);
  if (world.remotes) await page.waitForFunction(() => window.openStreams('/api/remote-servers/7/attention/stream').length === 1);
  return { context, page };
}

async function openSheet(page, how) {
  await page.locator('#h5-attention')[how]();
  await page.locator(`${SHEET} .h5-attention-panel`).waitFor({ state: 'visible' });
  await page.waitForFunction(sheet => { const el = document.querySelector(`${sheet} .h5-attention-panel`); return el && ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(el).transform); }, SHEET);
  await page.locator(`${SHEET} .h5-attention-row`).first().waitFor();
}
const keysIn = (page, group) => page.evaluate(([sheet, key]) => [...document.querySelectorAll(`${sheet} #h5-attention-body .h5-attention-group[data-group="${key}"] .h5-attention-row`)].map(el => el.dataset.key), [SHEET, group]);
const row = (page, key) => page.locator(`#h5-attention-body .h5-attention-row[data-key="${key}"]`);
const notice = page => page.locator('.MuiSnackbar-root .MuiAlert-message');
const remoteCalls = (world, method) => world.calls.filter(call => call.remote === 7 && (!method || call.method === method));
const last = (world, method) => world.calls.filter(call => call.method === method).at(-1);
const settledDrag = page => page.waitForFunction(sheet => !document.querySelector('.h5-attention-float') && !document.querySelector(`${sheet} [data-drag-slot]`)
  && [...document.querySelectorAll(`${sheet} .h5-attention-node`)].every(el => !el.style.transform), SHEET, { timeout: 4000 });
const box = locator => locator.boundingBox();
const at = (rect, part = 0.5) => ({ x: rect.x + Math.min(120, rect.width / 2), y: rect.y + rect.height * part });
const noOverflow = page => page.evaluate(sheet => { const panel = document.querySelector(`${sheet} .h5-attention-panel`); return [...panel.querySelectorAll('*')].filter(el => { const r = el.getBoundingClientRect(); return r.width && r.right > innerWidth + 0.5; }).map(el => el.className.toString().split(' ')[0]); }, SHEET);

async function finger(page) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  return {
    touch,
    async holdDrag(from, to, { steps = 14, release = true } = {}) {
      await touch('touchStart', from.x, from.y);
      await page.waitForSelector('.h5-attention-float');
      for (let index = 1; index <= steps; index += 1) {
        await touch('touchMove', from.x + ((to.x - from.x) * index) / steps, from.y + ((to.y - from.y) * index) / steps);
        await page.waitForTimeout(16);
      }
      if (release) await touch('touchEnd');
    },
  };
}

async function testPhone(browser) {
  const world = makeWorld();
  const { context, page } = await openPage(browser, world, { viewport: { width: 390, height: 844 } });
  await openSheet(page, 'tap');
  await page.locator(`${SHEET} .h5-attention-failed`).waitFor();

  // One list: this machine's block first, then K01's, each by sort_order; ids repeat, keys do not.
  assert.deepEqual(await keysIn(page, 'todo'), ['local:10', 'local:11', 'local:14', 'remote:7:10', 'remote:7:11', 'remote:7:14']);
  assert.deepEqual(await keysIn(page, 'review'), ['local:2', 'remote:7:1', 'remote:7:3', 'remote:7:4']);
  assert.deepEqual(await keysIn(page, 'needs'), ['local:1', 'remote:7:2']);
  // The engine tag of the task list in front of every title.
  assert.equal(await row(page, 'local:10').locator('.h5-attention-engine .h5-device-tag').textContent(), 'mac');
  assert.equal(await row(page, 'remote:7:10').locator('.h5-attention-engine .h5-device-tag').textContent(), 'K01');
  const colors = await page.evaluate(sheet => [...new Set([...document.querySelectorAll(`${sheet} .h5-attention-engine .h5-device-tag`)].map(el => `${el.dataset.source}=${el.dataset.color}`))], SHEET);
  const { tagColorIndex } = await import(require('node:url').pathToFileURL(path.join(root, 'scripts/h5-shell/task-order.mjs')).href);
  assert.deepEqual(colors.sort(), [`local=${tagColorIndex('inst-local')}`, `remote:7=${tagColorIndex('inst-k01')}`], 'the colour of its tag in the task list (its instance id)');
  // The sub-task is drawn under its parent of the same engine (remote 11 under remote 10, never under local 10).
  assert.equal(await page.locator('#h5-attention-body .h5-attention-level[data-level="todo:remote:7:10"] .h5-attention-row[data-key="remote:7:11"]').count(), 1);
  assert.equal(await page.locator('#h5-attention-body .h5-attention-level[data-level="todo:10"] .h5-attention-row[data-key="local:11"]').count(), 1);
  // Old (no capability), Hidden (hidden from the task list) and Gone (offline) are never read; Legacy answered 501 and is left out quietly; Down failed.
  for (const id of [8, 9, 12]) assert.equal(world.calls.filter(call => call.remote === id).length, 0, `remote ${id} is not read`);
  assert.ok(world.calls.some(call => call.remote === 11), 'Legacy was tried');
  assert.deepEqual(await page.locator(`${SHEET} .h5-attention-failed`).allTextContents(), ['Could not load Down']);
  assert.equal(await page.locator(`${SHEET} .h5-attention-failed`).getAttribute('data-engine'), 'remote:10');
  assert.equal(await page.evaluate(() => window.openStreams('/api/remote-servers/11/attention/stream').length), 0, 'no stream for an engine without T-Attention');
  // The badge counts every engine.
  assert.equal(await page.locator('#h5-attention').getAttribute('aria-label'), 'Attention (2)');
  // Every control is 44px; the quick add has "on <engine>".
  const small = await page.evaluate(sheet => [...document.querySelectorAll(`${sheet} button, ${sheet} input, ${sheet} select`)].map(el => { const r = (el.closest('.MuiInputBase-root') || el).getBoundingClientRect(); return { cls: el.className.split(' ')[0], id: el.id, w: r.width, h: r.height }; }).filter(r => r.w && (r.w < 44 || r.h < 44)), SHEET);
  assert.deepEqual(small, [], 'every control is 44px');
  assert.deepEqual(await page.locator('#h5-attention-add-on option').allTextContents(), ['on mac', 'on K01']);
  assert.deepEqual(await noOverflow(page), []);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-attention-remote-phone.png') });

  // A live change of K01's stream: a new task that needs the user, with the engine named in the reminder.
  const created = { kind: 'created', item: node(30, 'Pick a region', 'waiting_user', null, 70, { attention_reason: 'eu or us?' }), event: { actor: 'claude', type: 'created' } };
  await page.evaluate(change => window.emitOn('/api/remote-servers/7/attention/stream', change), created);
  await notice(page).filter({ hasText: 'Pick a region' }).waitFor();
  assert.equal(await notice(page).textContent(), 'Needs you: Pick a region (K01) — eu or us?');
  await row(page, 'remote:7:30').waitFor();
  assert.equal(await page.locator('#h5-attention').getAttribute('aria-label'), 'Attention (3)');
  // One of this machine names no engine; an equal id on the other engine is not touched.
  await page.evaluate(change => window.emitOn('/api/attention/stream', change), { kind: 'updated', item: { ...LOCAL_ITEMS()[3], status: 'review', attention_reason: 'Look at it', updated_at: '2026-11-06T00:00:00Z' }, previous: LOCAL_ITEMS()[3], event: { actor: 'claude', type: 'status' } });
  await notice(page).filter({ hasText: 'Changelog' }).waitFor();
  assert.equal(await notice(page).textContent(), 'Review: Changelog — Look at it');
  assert.equal(await row(page, 'remote:7:11').getAttribute('data-status'), 'todo');

  // The row buttons go to K01.
  await row(page, 'remote:7:3').locator('.h5-attention-action[data-action="confirm"]').tap();
  await page.waitForFunction(() => !document.querySelector('#h5-attention-body .h5-attention-row[data-key="remote:7:3"][data-status="review"]'));
  assert.deepEqual([last(world, 'PATCH').path, last(world, 'PATCH').body], ['/api/remote-servers/7/attention/3', { status: 'done' }]);
  assert.equal(world.dbs['/api/attention'].items.find(entry => entry.id === 3), undefined);
  await row(page, 'remote:7:2').locator('.h5-attention-action[data-action="handled"]').tap();
  await page.waitForFunction(() => document.querySelector('#h5-attention-body .h5-attention-group[data-group="working"] .h5-attention-row[data-key="remote:7:2"]'));
  assert.deepEqual([last(world, 'PATCH').path, last(world, 'PATCH').body], ['/api/remote-servers/7/attention/2', { status: 'working', attention_reason: null, activity: { kind: 'note', text: 'Handled' } }]);
  assert.equal(await row(page, 'local:1').getAttribute('data-status'), 'waiting_user', 'this machine\'s task 2 and 1 are not touched');
  await row(page, 'remote:7:4').locator('.h5-attention-action[data-action="reject"]').tap();
  await page.locator('#h5-attention-reject-reason').fill('Missing tests');
  await page.locator('#h5-attention-reject-confirm').tap();
  await page.waitForFunction(() => document.querySelector('#h5-attention-body .h5-attention-group[data-group="working"] .h5-attention-row[data-key="remote:7:4"]'));
  assert.deepEqual([last(world, 'PATCH').path, last(world, 'PATCH').body], ['/api/remote-servers/7/attention/4', { status: 'working', attention_reason: null, activity: { kind: 'note', text: 'Rejected: Missing tests' } }]);

  // Drag: K01's last To do row held and dragged over this machine's rows to the top: it stays in K01's block (before K01's 10, on K01's URL).
  const f = await finger(page);
  await page.locator('#h5-attention-body').evaluate(list => { const group = list.querySelector('.h5-attention-group[data-group="todo"]'); list.scrollTop = group.offsetTop - 20; });
  const target = await box(row(page, 'local:10'));
  assert.ok((await box(row(page, 'remote:7:14'))).y + 40 < 844, 'both rows are on the screen');
  await f.holdDrag(at(await box(row(page, 'remote:7:14'))), at(target, 0.3), { release: false });
  assert.equal(await page.locator('#h5-attention-body .h5-attention-node[data-key="remote:7:14"]').getAttribute('data-drag-slot'), 'true');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-attention-remote-drag.png') });
  await f.touch('touchEnd');
  await settledDrag(page);
  const moved = world.calls.filter(call => /\/move$/.test(call.path));
  assert.deepEqual(moved.map(call => [call.path, call.body]), [['/api/remote-servers/7/attention/14/move', { before: 10 }]], 'snapped to the top of its own engine');
  assert.deepEqual(await keysIn(page, 'todo'), ['local:10', 'local:14', 'remote:7:14', 'remote:7:10', 'remote:7:11'], 'local 11 went to Review above');
  // A drop on the title of "Done & failed": the status changes on K01.
  const closed = page.locator(`${SHEET} .h5-attention-drop[data-group="closed"]`);
  await page.locator('#h5-attention-body').evaluate(list => { list.scrollTop = list.scrollHeight; });
  await f.holdDrag(at(await box(row(page, 'remote:7:14'))), at(await box(closed)), { release: false });
  assert.equal(await closed.getAttribute('data-drop-over'), 'true');
  await f.touch('touchEnd');
  await settledDrag(page);
  await page.waitForFunction(() => !document.querySelector('#h5-attention-body .h5-attention-row[data-key="remote:7:14"]'));
  assert.deepEqual([last(world, 'POST').path, last(world, 'POST').body], ['/api/remote-servers/7/attention/14/move', { position: 'top', status: 'done' }]);
  assert.equal(world.dbs['/api/remote-servers/7/attention'].items.find(entry => entry.id === 14).status, 'done');
  assert.equal(world.dbs['/api/attention'].items.find(entry => entry.id === 14).status, 'todo', 'this machine\'s 14 stays');
  assert.equal(world.calls.filter(call => /^\/api\/attention\/\d+\/move$/.test(call.path)).length, 0, 'nothing moved on this machine');

  // The edit view of K01's parent: its tag, its history from K01, the Parent select of its own engine, Move down, Save on K01.
  await row(page, 'remote:7:10').locator('.h5-attention-open').tap();
  const edit = page.locator('#h5-attention-edit .MuiDialog-paper');
  await edit.waitFor({ state: 'visible' });
  await page.locator('#h5-attention-history .h5-attention-event').nth(1).waitFor();
  assert.match(await page.locator('#h5-attention-history').textContent(), /k01 note/, 'the history of K01');
  assert.equal(await page.locator('#h5-attention-edit-engine .h5-device-tag').textContent(), 'K01');
  const parents = await page.locator('#h5-attention-edit-parent option').allTextContents();
  assert.ok(parents.includes('Deploy site') && !parents.includes('Remote child') && !parents.includes('Remote parent'), 'never itself or its sub-task');
  assert.ok(!parents.includes('Release 2.0') && !parents.includes('Pay invoice'), 'only its own engine');
  assert.equal(await page.locator('#h5-attention-move-down').isDisabled(), true, 'the only To do row of K01: this machine\'s rows are not its siblings');
  await page.locator('#h5-attention-edit-name').fill('Remote parent v2');
  await page.locator('#h5-attention-edit-save').tap();
  await edit.waitFor({ state: 'hidden' });
  assert.deepEqual([last(world, 'PATCH').path, last(world, 'PATCH').body], ['/api/remote-servers/7/attention/10', { title: 'Remote parent v2' }]);
  // Move down among K01's Working rows (Third review, then Answer the question: equal sort_order, the higher id first).
  assert.deepEqual(await keysIn(page, 'working'), ['remote:7:4', 'remote:7:2']);
  await row(page, 'remote:7:4').locator('.h5-attention-open').tap();
  await edit.waitFor({ state: 'visible' });
  await page.locator('#h5-attention-move-down').tap();
  await page.waitForFunction(() => document.querySelector('#h5-attention-move-down').disabled);
  assert.deepEqual([last(world, 'POST').path, last(world, 'POST').body], ['/api/remote-servers/7/attention/4/move', { after: 2 }]);
  await page.locator('#h5-attention-edit-close').tap();
  await edit.waitFor({ state: 'hidden' });
  // Delete K01's sub-task.
  await row(page, 'remote:7:11').locator('.h5-attention-open').tap();
  await edit.waitFor({ state: 'visible' });
  await page.locator('#h5-attention-edit-delete').tap();
  await page.locator('#h5-attention-delete-confirm').tap();
  await edit.waitFor({ state: 'hidden' });
  assert.equal(last(world, 'DELETE').path, '/api/remote-servers/7/attention/11');
  assert.equal(await row(page, 'remote:7:11').count(), 0);
  assert.equal(await row(page, 'local:11').count(), 1, 'this machine\'s 11 stays');

  // The context card of K01's task: the summary is asked for on K01, and Open terminal opens its task's terminal on K01.
  await row(page, 'remote:7:1').locator('.h5-attention-open').tap();
  await edit.waitFor({ state: 'visible' });
  await page.locator('#h5-attention-summary-refresh').tap();
  await notice(page).filter({ hasText: 'A new summary was asked for' }).waitFor();
  assert.equal(last(world, 'POST').path, '/api/remote-servers/7/attention/1/summarize');
  assert.equal(await page.locator('#h5-attention-jump').textContent(), 'Open terminal');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-attention-remote-edit.png') });
  await page.locator('#h5-attention-jump').tap();
  await page.locator(`${SHEET} .h5-attention-panel`).waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'Deploy site task');
  await page.waitForFunction(() => window.socketUrls.some(url => url.includes('/api/remote-servers/7/terminal/ws')));

  // Quick add on K01 (remembered).
  await openSheet(page, 'tap');
  await page.locator('#h5-attention-add-on').selectOption('remote:7');
  await page.locator('#h5-attention-add-input').fill('Rotate the keys');
  await page.locator('#h5-attention-add').tap();
  await row(page, 'remote:7:200').waitFor();
  assert.deepEqual([last(world, 'POST').path, last(world, 'POST').body], ['/api/remote-servers/7/attention', { title: 'Rotate the keys' }]);
  assert.equal(await page.evaluate(() => localStorage.getItem('h5-attention-add-on')), 'remote:7');
  assert.equal(await row(page, 'remote:7:200').locator('.h5-device-tag').textContent(), 'K01');

  // K01 hidden from the task list: its rows, stream and tags go (one engine left, so no tags); shown again: back, read again.
  await page.evaluate(() => window.H5UI.actions.setDeviceVisible('remote:7', false));
  await page.waitForFunction(() => !document.querySelector('#h5-attention-body .h5-attention-row[data-engine="remote:7"]'));
  assert.equal(await page.evaluate(() => window.openStreams('/api/remote-servers/7/attention/stream').length), 0);
  assert.equal(await page.locator('#h5-attention-add-on').count(), 0, 'no "on" with this machine alone (Down failed: no new task can go there)');
  assert.equal(await page.locator(`${SHEET} .h5-attention-engine`).count() > 0, true, 'the tags stay while Down is listed with its line');
  assert.equal(await page.locator('#h5-attention').getAttribute('aria-label'), 'Attention (1)');
  const reads = remoteCalls(world, 'GET').filter(call => call.path.includes('include_done')).length;
  await page.evaluate(() => window.H5UI.actions.setDeviceVisible('remote:7', true));
  await row(page, 'remote:7:200').waitFor();
  await page.waitForFunction(() => window.openStreams('/api/remote-servers/7/attention/stream').length === 1);
  assert.equal(remoteCalls(world, 'GET').filter(call => call.path.includes('include_done')).length, reads + 1);
  await page.locator('#h5-attention-add-on').waitFor();
  assert.equal(await page.locator('#h5-attention-add-on').inputValue(), 'remote:7', 'the remembered engine is chosen again');
  assert.deepEqual(world.errors, []);
  await context.close();
}

async function testNarrow(browser) {
  const world = makeWorld();
  const { context, page } = await openPage(browser, world, { viewport: { width: 320, height: 640 } });
  await openSheet(page, 'tap');
  await page.locator(`${SHEET} .h5-attention-failed`).waitFor();
  assert.deepEqual(await noOverflow(page), [], 'nothing is wider than the phone');
  const addOn = await box(page.locator('#h5-attention-add-on'));
  const input = await box(page.locator('#h5-attention-add-input'));
  assert.ok(addOn.width >= 44 && addOn.height >= 44 && input.width >= 120, `the select and the input fit (${addOn.width}, ${input.width})`);
  const title = await box(row(page, 'remote:7:10').locator('.h5-attention-title'));
  const tag = await box(row(page, 'remote:7:10').locator('.h5-device-tag'));
  assert.ok(tag.x + tag.width <= title.x && Math.abs(tag.y - title.y) < 4, 'the tag sits in front of the title, on its first line');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-attention-remote-320.png') });
  assert.deepEqual(world.errors, []);
  await context.close();
}

async function testComputer(browser) {
  const world = makeWorld();
  const { context, page } = await openPage(browser, world, { viewport: { width: 1440, height: 900 }, touch: false });
  await openSheet(page, 'click');
  // A mouse drag of a K01 row over this machine's rows: it stays in K01's block.
  await page.locator('#h5-attention-body').evaluate(list => { const group = list.querySelector('.h5-attention-group[data-group="todo"]'); list.scrollTop = group.offsetTop - 20; });
  const from = at(await box(row(page, 'remote:7:14')));
  const to = at(await box(row(page, 'local:14')), 0.2);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let index = 1; index <= 12; index += 1) { await page.mouse.move(from.x + ((to.x - from.x) * index) / 12, from.y + ((to.y - from.y) * index) / 12); await page.waitForTimeout(16); }
  await page.waitForSelector('.h5-attention-float');
  await page.mouse.up();
  await settledDrag(page);
  assert.deepEqual(world.calls.filter(call => /\/move$/.test(call.path)).map(call => [call.path, call.body]), [['/api/remote-servers/7/attention/14/move', { before: 10 }]]);
  // A click still opens the edit view of a K01 row.
  await row(page, 'remote:7:10').locator('.h5-attention-open').click();
  await page.locator('#h5-attention-edit .MuiDialog-paper').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#h5-attention-edit-engine .h5-device-tag').textContent(), 'K01');
  await page.locator('#h5-attention-edit-close').click();
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-attention-remote-1440.png') });
  assert.deepEqual(world.errors, []);
  await context.close();
}

async function testChinese(browser) {
  const world = makeWorld();
  const { context, page } = await openPage(browser, world, { viewport: { width: 390, height: 844 }, zh: true });
  await openSheet(page, 'tap');
  await page.locator(`${SHEET} .h5-attention-failed`).waitFor();
  assert.equal(await page.locator(`${SHEET} .h5-attention-failed`).textContent(), '\u65e0\u6cd5\u52a0\u8f7d Down');
  assert.deepEqual(await page.locator('#h5-attention-add-on option').allTextContents(), ['\u5230 mac', '\u5230 K01']);
  assert.equal(await page.locator('#h5-attention-add-on').getAttribute('aria-label'), '\u6dfb\u52a0\u5230');
  await page.evaluate(change => window.emitOn('/api/remote-servers/7/attention/stream', change), { kind: 'created', item: node(31, 'Pick a region', 'waiting_user', null, 70, { attention_reason: 'eu or us?' }) });
  await notice(page).filter({ hasText: 'Pick a region' }).waitFor();
  assert.match(await notice(page).textContent(), /^\S+: Pick a region \(K01\) — eu or us\?$/);
  assert.doesNotMatch(await notice(page).textContent(), /^Needs you/, 'the status is translated');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-attention-remote-zh.png') });
  assert.deepEqual(world.errors, []);
  await context.close();
}

async function testSingle(browser) {
  const world = makeWorld({ remotes: false });
  const { context, page } = await openPage(browser, world, { viewport: { width: 390, height: 844 } });
  await openSheet(page, 'tap');
  assert.equal(await page.locator(`${SHEET} .h5-attention-engine`).count(), 0, 'no tags with one engine');
  assert.equal(await page.locator('#h5-attention-add-on').count(), 0, 'no "on <engine>"');
  assert.equal(await page.locator(`${SHEET} .h5-attention-failed`).count(), 0);
  assert.deepEqual(await keysIn(page, 'todo'), ['local:10', 'local:11', 'local:14']);
  assert.equal(world.calls.filter(call => call.remote).length, 0);
  await page.locator('#h5-attention-add-input').fill('Water the plants');
  await page.locator('#h5-attention-add').tap();
  await row(page, 'local:100').waitFor();
  assert.deepEqual([last(world, 'POST').path, last(world, 'POST').body], ['/api/attention', { title: 'Water the plants' }]);
  assert.deepEqual(world.errors, []);
  await context.close();
}

(async () => {
  const browser = await chromium.launch();
  try {
    for (const [name, run] of [['phone 390 touch', testPhone], ['phone 320 touch', testNarrow], ['computer 1440 mouse', testComputer], ['Chinese', testChinese], ['one engine', testSingle]]) {
      await run(browser);
      console.log(`  ${name}: ok`);
    }
    console.log('h5 attention remote browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
