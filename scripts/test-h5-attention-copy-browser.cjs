// T-Attention read copies on the page (attention-feed.mjs, Attention.jsx; docs/design/attention-copies.md), in real Chromium with the API mocked by
// Playwright routes and a fake EventSource per stream:
// - this machine ("Air") lists its own items and the read copies of K01 (remote 7, 'attention:copy') in one answer (`copies=1`): one list read and one
//   stream, never a read or stream of K01's own; the rows have K01's tag and actions go to K01's proxy URL;
// - a copy change on this machine's stream reminds with "(K01)", a quiet one (history) does not; an engine without copies (Plain, remote 8) is read
//   live as before;
// - K01 goes offline (`kind: 'owners'` on the stream): the list is read again, K01's rows stay with "K01 is offline · Its tasks as of …", they are not
//   dragged, Handled is queued ("Will be sent to K01"), Delete is refused with the server's note; a dropped change says so (a notice, a line and
//   Dismiss, which deletes the note);
// - a device known only through another one ("Far", no row in the task list) is listed with its tag and "Far is not linked to this device";
// - K01 hidden in the task list takes its copies away, shown again brings them back;
// - phone 390 (touch; screenshots attention-copy-*.png with H5_SHOT_DIR) and computer 1440 (mouse), Chinese.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const AT = '2026-11-05T10:00:00Z';
const AS_OF = '2026-11-05T14:05:00Z';
const SHEET = '#h5-attention-sheet';
// The Chinese text of an English key in the page's dictionary.
const DICTIONARY = fs.readFileSync(path.join(root, 'public/js/i18n-zh-ui.js'), 'utf8');
const zh = key => { const match = DICTIONARY.match(new RegExp(`${JSON.stringify(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: ("(?:[^"\\\\]|\\\\.)*")`)); assert.ok(match, key); return JSON.parse(match[1]); };

const node = (id, title, status, parent, order, extra = {}) => ({
  id, title, status, parent_id: parent, sort_order: order, custom_status: null, result: null, priority: 'none', source: 'claude', updated_at: AT, created_at: AT, ...extra,
});
const copy = (owner, engine, item, extra = {}) => ({ ...item, owner, owner_name: owner === 'inst-k01' ? 'K01' : 'Far', owner_engine: engine, copy: true, pending: [], dropped: [], ...extra });
const LOCAL_ITEMS = () => [
  node(1, 'Allow Bash', 'waiting_user', null, 10, { attention_reason: 'Claude needs your permission' }),
  node(10, 'Release 2.0', 'todo', null, 50, { source: 'user' }),
];
const K01_ITEMS = () => [
  node(1, 'Deploy site', 'review', null, 30, { result: 'Deployed to staging' }),
  node(2, 'Answer the question', 'waiting_user', null, 5, { attention_reason: 'Which region?' }),
  node(10, 'Remote parent', 'todo', null, 60),
  node(11, 'Remote child', 'todo', 10, 55),
];
const FAR_ITEMS = () => [node(5, 'Far away task', 'working', null, 9, { custom_status: 'Building' })];
const SERVERS = [
  { id: 7, name: 'K01', instance_id: 'inst-k01', caps: ['attention:remote', 'attention:copy'] },
  { id: 8, name: 'Plain', instance_id: 'inst-plain', caps: ['attention:remote'] },
];

function makeWorld() {
  return {
    hidden: [], calls: [], errors: [], k01Online: true, far: true, dismissed: [],
    local: LOCAL_ITEMS(), k01: K01_ITEMS(), plain: [node(3, 'Plain task', 'todo', null, 3)],
  };
}
function owners(world) {
  return [
    { instance_id: 'inst-k01', name: 'K01', host: 'k01', engine: 'remote:7', linked: true, online: world.k01Online, as_of: AS_OF },
    ...(world.far ? [{ instance_id: 'inst-far', name: 'Far', host: 'far', engine: null, linked: false, online: false, as_of: AS_OF }] : []),
  ];
}
const copies = world => ({
  items: [...world.k01.map(item => copy('inst-k01', 'remote:7', item)), ...(world.far ? FAR_ITEMS().map(item => copy('inst-far', null, item)) : [])],
  owners: owners(world),
});

async function serve(world, route) {
  const request = route.request();
  const url = new URL(request.url());
  const p = url.pathname;
  const method = request.method();
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
  if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
  if (p === '/api/system/version') return json({ engine_name: 'Air', instance_id: 'inst-local' });
  if (p === '/api/remote-servers') return json(SERVERS.map(server => ({ id: server.id, name: server.name, status: 'online', enabled: true, instance_id: server.instance_id })));
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
    const rest = p.slice('/api/attention'.length);
    if (rest === '' && method === 'GET') return json({ items: world.local, host: 'mac', instance_id: 'inst-local', ...(url.searchParams.get('copies') === '1' ? { copies: copies(world) } : {}) });
    const dismiss = rest.match(/^\/copies\/queue\/(\d+)$/);
    if (dismiss && method === 'DELETE') { world.dismissed.push(Number(dismiss[1])); return route.fulfill({ status: 204, body: '' }); }
    const one = rest.match(/^\/(\d+)$/);
    if (one && method === 'GET') return json({ item: world.local.find(item => item.id === Number(one[1])), events: [] });
    return json({ error: 'not mocked' }, 404);
  }
  const remote = p.match(/^\/api\/remote-servers\/(\d+)(\/.*)$/);
  if (remote) {
    const server = SERVERS.find(entry => entry.id === Number(remote[1]));
    const rest = remote[2];
    if (!server) return json({ error: 'not mocked' }, 404);
    if (rest.startsWith('/attention')) {
      world.calls.push({ method, path: p + url.search, body, remote: server.id });
      if (server.id === 8) return json({ items: world.plain, host: 'plain', instance_id: 'inst-plain' });
      // K01 through the proxy: forwarded while it is online; answered from the copy while it is offline (routes/remote-servers.js).
      const id = Number((rest.match(/^\/attention\/(\d+)/) || [])[1]);
      const item = world.k01.find(entry => entry.id === id);
      if (!item) return json({ error: 'NOT_FOUND', message: 'Task not found' }, 404);
      if (method === 'GET') return json(world.k01Online ? { item, events: [{ id: 1, item_id: id, at: AT, actor: 'claude', type: 'created', data: null }] } : { item: copy('inst-k01', 'remote:7', item), events: [], copy: { owner: 'inst-k01', as_of: AS_OF } });
      if (method === 'PATCH') {
        const { activity: _note, ...fields } = body;
        if (world.k01Online) { Object.assign(item, fields, { updated_at: new Date().toISOString() }); return json({ ...item }); }
        return json(copy('inst-k01', 'remote:7', { ...item, ...fields }, { pending: [{ id: 41, at: AS_OF, fields: Object.keys(fields) }] }), 202);
      }
      if (method === 'DELETE') {
        if (!world.k01Online) return json({ error: 'ATTENTION_OWNER_OFFLINE', message: 'A task can only be deleted while the device it belongs to is online' }, 409);
        world.k01 = world.k01.filter(entry => entry.id !== id);
        return route.fulfill({ status: 204, body: '' });
      }
      return json({ error: 'not mocked' }, 404);
    }
    if (rest === '/info') return json({ capabilities: server.caps });
    if (rest === '/tasks' && method === 'GET') return json([]);
    if (rest === '/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
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
  await page.waitForFunction(() => document.getElementById('h5-attention') && window.openStreams('/api/attention/stream').length === 1);
  await page.waitForFunction(() => window.openStreams('/api/remote-servers/8/attention/stream').length === 1, null, { timeout: 8000 });
  return { context, page };
}

async function openSheet(page, how) {
  if (how === 'click' && await page.locator('#h5-more').isVisible()) await page.locator('#h5-more').click();
  await page.locator('#h5-attention')[how]();
  await page.locator('#h5-more-menu .MuiBackdrop-root').waitFor({ state: 'hidden' });
  await page.locator(`${SHEET} .h5-attention-panel`).waitFor({ state: 'visible' });
  await page.locator(`${SHEET} .h5-attention-row`).first().waitFor();
}
const keysIn = (page, group) => page.evaluate(([sheet, key]) => [...document.querySelectorAll(`${sheet} #h5-attention-body .h5-attention-group[data-group="${key}"] .h5-attention-row`)].map(el => el.dataset.key), [SHEET, group]);
const row = (page, key) => page.locator(`#h5-attention-body .h5-attention-row[data-key="${key}"]`);
const notice = page => page.locator('.MuiSnackbar-root .MuiAlert-message');
const k01Calls = world => world.calls.filter(call => call.remote === 7);
const goOffline = async (page, world) => {
  world.k01Online = false;
  await page.evaluate(list => window.emitOn('/api/attention/stream', { kind: 'owners', owners: list }), owners(world));
  await page.locator(`${SHEET} .h5-attention-offline[data-engine="remote:7"]`).waitFor();
};

async function testPhone(browser) {
  const world = makeWorld();
  const { context, page } = await openPage(browser, world, { viewport: { width: 390, height: 844 } });
  await openSheet(page, 'tap');
  await row(page, 'remote:7:10').waitFor();

  // One list read and one stream of this machine carry K01's copies: K01 itself is never read; Plain (no copies) is read live as before.
  assert.deepEqual(k01Calls(world), [], 'no request to K01 for its list');
  assert.equal(await page.evaluate(() => window.streams.filter(s => s.url.includes('/remote-servers/7/')).length), 0, 'no stream of K01');
  assert.equal(world.calls.filter(call => call.method === 'GET' && call.path.startsWith('/api/attention?')).length, 1);
  assert.equal(await page.evaluate(() => window.streams.find(s => s.url.startsWith('/api/attention/stream')).url), '/api/attention/stream?tab=1&copies=1');
  assert.ok(world.calls.some(call => call.remote === 8), 'Plain is read live');
  assert.deepEqual(await keysIn(page, 'todo'), ['local:10', 'remote:7:10', 'remote:7:11', 'remote:8:3']);
  assert.equal(await row(page, 'remote:7:10').locator('.h5-attention-engine .h5-device-tag').textContent(), 'K01');
  assert.equal(await page.locator('#h5-attention').getAttribute('aria-label'), 'Attention (2)', 'the badge counts the copies');
  // A device known only through another one: listed with its own tag, read only.
  assert.equal(await row(page, 'copy:inst-far:5').locator('.h5-attention-engine .h5-device-tag').textContent(), 'Far');
  assert.equal(await page.locator(`${SHEET} .h5-attention-offline[data-engine="copy:inst-far"]`).textContent(), 'Far is not linked to this device · Its tasks as of 11-05 22:05'.replace('22:05', await page.evaluate(at => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }, AS_OF)));

  // A copy change on this machine's stream reminds with K01's name; a quiet one (history, a device back online) does not.
  const change = { kind: 'updated', copy: true, item: copy('inst-k01', 'remote:7', { ...K01_ITEMS()[2], status: 'waiting_user', attention_reason: 'Pick one', updated_at: '2026-11-06T00:00:00Z' }), previous: copy('inst-k01', 'remote:7', K01_ITEMS()[2]), event: { actor: 'claude', type: 'status' } };
  await page.evaluate(entry => window.emitOn('/api/attention/stream', entry), change);
  await notice(page).filter({ hasText: 'Remote parent' }).waitFor();
  assert.equal(await notice(page).textContent(), 'Needs you: Remote parent (K01) — Pick one');
  await page.evaluate(entry => window.emitOn('/api/attention/stream', entry), { ...change, quiet: true, item: { ...change.item, id: 11, title: 'Remote child', parent_id: 10, updated_at: '2026-11-06T00:00:01Z' }, previous: copy('inst-k01', 'remote:7', K01_ITEMS()[3]) });
  await page.waitForFunction(() => document.querySelector('#h5-attention-body .h5-attention-row[data-key="remote:7:11"][data-status="waiting_user"]'));
  await page.waitForTimeout(150);
  assert.equal(await notice(page).filter({ hasText: 'Remote child' }).count(), 0, 'no reminder for history');

  // Online: a row button goes to K01 itself, through the proxy.
  await row(page, 'remote:7:1').locator('.h5-attention-action[data-action="confirm"]').tap();
  await page.waitForFunction(() => !document.querySelector('#h5-attention-body .h5-attention-row[data-key="remote:7:1"][data-status="review"]'));
  assert.deepEqual(k01Calls(world).map(call => [call.method, call.path, call.body]), [['PATCH', '/api/remote-servers/7/attention/1', { status: 'done' }]]);

  // K01 goes offline: the list is read again and says since when its items are as shown; its rows stay and are not dragged.
  const reads = world.calls.filter(call => call.path.startsWith('/api/attention?')).length;
  await goOffline(page, world);
  assert.equal(world.calls.filter(call => call.path.startsWith('/api/attention?')).length, reads + 1);
  const offlineLine = await page.locator(`${SHEET} .h5-attention-offline[data-engine="remote:7"]`).textContent();
  assert.match(offlineLine, /^K01 is offline · Its tasks as of 11-05 \d\d:05 · Changes are sent when it is back$/);
  assert.ok(await row(page, 'remote:7:2').isVisible());
  assert.equal(await page.locator('#h5-attention-body .h5-attention-node[data-key="remote:7:10"]').getAttribute('data-movable'), null, 'no drag while K01 is offline');
  assert.equal(await page.locator('#h5-attention-body .h5-attention-node[data-key="local:10"]').getAttribute('data-movable'), 'true');

  // Handled while offline: queued here and shown at once as pending.
  await row(page, 'remote:7:2').locator('.h5-attention-action[data-action="handled"]').tap();
  await row(page, 'remote:7:2').locator('.h5-attention-pending').waitFor();
  assert.equal(await row(page, 'remote:7:2').locator('.h5-attention-pending').textContent(), 'Will be sent to K01');
  assert.equal(await row(page, 'remote:7:2').getAttribute('data-status'), 'working');
  assert.deepEqual(k01Calls(world).at(-1).body, { status: 'working', attention_reason: null, activity: { kind: 'note', text: 'Handled' } });
  await page.locator('#h5-attention-body').evaluate(list => { list.scrollTop = 0; });
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'attention-copy-offline-pending-390.png') });

  // Delete while offline: refused with the server's note; the edit view shows the copy's time and says where the history is.
  await row(page, 'remote:7:10').locator('.h5-attention-open').tap();
  const edit = page.locator('#h5-attention-edit .MuiDialog-paper');
  await edit.waitFor({ state: 'visible' });
  await page.locator('#h5-attention-history-elsewhere').waitFor();
  assert.equal(await page.locator('#h5-attention-history-elsewhere').textContent(), 'The history is kept on K01');
  assert.match(await page.locator('#h5-attention-edit-meta').textContent(), /As of /);
  await page.locator('#h5-attention-edit-delete').tap();
  await page.locator('#h5-attention-delete-confirm').tap();
  await page.locator('#h5-attention-edit-error').waitFor();
  assert.equal(await page.locator('#h5-attention-edit-error').textContent(), 'Could not delete: A task can only be deleted while the device it belongs to is online');
  await page.locator('#h5-attention-edit-cancel').tap();
  await edit.waitFor({ state: 'hidden' });
  assert.ok(await row(page, 'remote:7:10').isVisible(), 'not deleted');

  // A queued change K01 had changed meanwhile: dropped, with a notice, a line on the row and Dismiss.
  const dropped = copy('inst-k01', 'remote:7', { ...world.k01[1], status: 'review', updated_at: '2026-11-06T01:00:00Z' }, { dropped: [{ id: 41, at: AS_OF, fields: ['status', 'attention_reason'], reason: 'newer' }] });
  await page.evaluate(entry => window.emitOn('/api/attention/stream', entry), { kind: 'updated', copy: true, quiet: true, item: dropped, previous: null, event: null, dropped_now: [{ id: 41, reason: 'newer' }] });
  await notice(page).filter({ hasText: 'Not sent to K01' }).waitFor();
  assert.equal(await notice(page).filter({ hasText: 'Not sent to K01' }).textContent(), 'Not sent to K01: Answer the question — it was changed there in the meantime');
  await row(page, 'remote:7:2').locator('.h5-attention-dropped').waitFor();
  assert.equal(await row(page, 'remote:7:2').locator('.h5-attention-dropped').textContent(), 'Not sent: it was changed on K01 first');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'attention-copy-dropped-390.png') });
  await row(page, 'remote:7:2').locator('.h5-attention-action[data-action="dismiss"]').tap();
  await page.waitForFunction(() => !document.querySelector('#h5-attention-body .h5-attention-dropped'));
  assert.deepEqual(world.dismissed, [41]);

  // 44px controls and nothing wider than the screen.
  const small = await page.evaluate(sheet => [...document.querySelectorAll(`${sheet} button, ${sheet} input, ${sheet} select`)].map(el => { const r = (el.closest('.MuiInputBase-root') || el).getBoundingClientRect(); return { cls: el.className.split(' ')[0], w: r.width, h: r.height }; }).filter(r => r.w && (r.w < 44 || r.h < 44)), SHEET);
  assert.deepEqual(small, []);
  const wide = await page.evaluate(sheet => [...document.querySelector(`${sheet} .h5-attention-panel`).querySelectorAll('*')].filter(el => { const r = el.getBoundingClientRect(); return r.width && r.right > innerWidth + 0.5; }).length, SHEET);
  assert.equal(wide, 0);
  assert.deepEqual(world.errors, []);
  await context.close();
}

async function testHidden(browser) {
  const world = makeWorld();
  const { context, page } = await openPage(browser, world, { viewport: { width: 1440, height: 900 }, touch: false });
  await openSheet(page, 'click');
  await row(page, 'remote:7:10').waitFor();
  // K01 hidden in the task list: its copies leave the list, as every engine's rows do; shown again: this machine's list is read again and brings them.
  await page.evaluate(() => window.H5UI.actions.setDeviceVisible('remote:7', false));
  await page.waitForFunction(() => !document.querySelector('#h5-attention-body .h5-attention-row[data-engine="remote:7"]'));
  assert.ok(await row(page, 'local:10').isVisible());
  const reads = world.calls.filter(call => call.path.startsWith('/api/attention?')).length;
  await page.evaluate(() => window.H5UI.actions.setDeviceVisible('remote:7', true));
  await row(page, 'remote:7:10').waitFor();
  assert.equal(world.calls.filter(call => call.path.startsWith('/api/attention?')).length, reads + 1);
  assert.deepEqual(k01Calls(world), [], 'still no request to K01');
  assert.deepEqual(world.errors, []);
  await context.close();
}

async function testComputer(browser) {
  const world = makeWorld();
  const { context, page } = await openPage(browser, world, { viewport: { width: 1440, height: 900 }, touch: false });
  await openSheet(page, 'click');
  await row(page, 'remote:7:10').waitFor();
  await goOffline(page, world);
  await row(page, 'remote:7:2').locator('.h5-attention-action[data-action="handled"]').click();
  await row(page, 'remote:7:2').locator('.h5-attention-pending').waitFor();
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'attention-copy-offline-1440.png') });
  assert.deepEqual(world.errors, []);
  await context.close();
}

async function testChinese(browser) {
  const world = makeWorld();
  const { context, page } = await openPage(browser, world, { viewport: { width: 390, height: 844 }, zh: true });
  await openSheet(page, 'tap');
  await goOffline(page, world);
  // The Chinese words come from the page's dictionary (public/js/i18n-zh-ui.js), keyed by the English text.
  const line = await page.locator(`${SHEET} .h5-attention-offline[data-engine="remote:7"]`).textContent();
  assert.equal(line.replace(/\d\d:05/, 'HH:05'), `${zh('{1} is offline').replace('{1}', 'K01')} · ${zh('Its tasks as of {1}').replace('{1}', '11-05 HH:05')} · ${zh('Changes are sent when it is back')}`);
  await row(page, 'remote:7:2').locator('.h5-attention-action[data-action="handled"]').tap();
  await row(page, 'remote:7:2').locator('.h5-attention-pending').waitFor();
  assert.equal(await row(page, 'remote:7:2').locator('.h5-attention-pending').textContent(), zh('Will be sent to {1}').replace('{1}', 'K01'));
  assert.deepEqual(world.errors, []);
  await context.close();
}

(async () => {
  const browser = await chromium.launch();
  try {
    await testPhone(browser);
    console.log('  phone 390 touch: ok');
    await testHidden(browser);
    console.log('  hidden device: ok');
    await testComputer(browser);
    console.log('  computer 1440 mouse: ok');
    await testChinese(browser);
    console.log('  Chinese: ok');
    console.log('h5 attention copy browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
