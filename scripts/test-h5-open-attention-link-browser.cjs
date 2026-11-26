// The details of a T-Attention task from the desktop window, in real Chromium at computer and phone size with mocked routes and a fake EventSource.
// A click on a task row (or a task's bubble) of the window asks POST /api/attention/widget/open-item; the open page gets `open-item` { key } over its
// T-Attention stream (`/api/attention/stream?tab=1`, scripts/h5-shell/attention-feed.mjs) and shows the T-Attention panel with that task's edit view,
// without a reload. When no page took it the window opens `?openAttention=<key>` (public/js/h5.js): the same panel and edit view once the lists are
// known, the parameter taken out of the address at once (other parameters stay). A task of a connected service opens too (its list comes later); a
// task that is not there, or a key that is not one, shows the panel without an edit view and no error.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };

const LOCAL_TASKS = [{ id: 1, title: 'Here', status: 'doing' }];
const at = '2026-11-26T08:00:00.000Z';
const item = (id, title, status = 'working') => ({ id, title, status, notes: '', source: 'claude', created_at: at, updated_at: at });
const LOCAL_ITEMS = [item(3, 'Local task'), item(5, 'Other local task', 'waiting_user')];
const REMOTE_ITEMS = [item(4, 'Remote task')];

async function openPage(browser, wide, query) {
  const context = await browser.newContext(wide ? { viewport: { width: 1440, height: 900 } } : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const state = { errors: [] };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.addInitScript(() => {
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } }, 0); }
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
    window.push = (event, data) => {
      const stream = window.streams.filter(s => s.readyState === 1 && s.url === '/api/attention/stream?tab=1&copies=1').at(-1);
      if (!stream) return false;
      stream.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) }));
      return true;
    };
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
    if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
    if (p === '/api/remote-servers') return json([{ id: 7, name: 'Laptop', status: 'online' }]);
    if (p === '/api/remote-servers/7/info') return json({ capabilities: ['terminal:control', 'attention:remote'] });
    if (p === '/api/tasks' && method === 'GET') return json(LOCAL_TASKS);
    if (p === '/api/remote-servers/7/tasks' && method === 'GET') return json([]);
    if (/^\/api(\/remote-servers\/7)?\/task-groups$/.test(p)) return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (/\/tasks\/\d+\/terminals$/.test(p)) return json([]);
    if (/\/agent\/conversations$/.test(p)) return json([]);
    if (/\/terminal-activity$/.test(p)) return json({});
    if (/\/terminal-subagents$/.test(p)) return json({});
    if (p === '/api/attention' && method === 'GET') return json({ items: LOCAL_ITEMS, host: 'mac' });
    // The connected service's list answers later than this machine's: the edit view waits for it.
    if (p === '/api/remote-servers/7/attention' && method === 'GET') { await new Promise(resolve => setTimeout(resolve, 300)); return json({ items: REMOTE_ITEMS, host: 'laptop' }); }
    if (p === '/api/attention/stream/seen' && method === 'POST') return json({ ok: true });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5${query}`);
  return { context, page, state, label: `${wide ? 'computer' : 'phone'} ${query || '(no link)'}` };
}

const sheet = page => page.locator('#h5-attention-sheet .h5-attention-panel');
const editName = page => page.locator('#h5-attention-edit #h5-attention-edit-name');

async function followed(browser, wide, { query, title, rest }) {
  const { context, page, state, label } = await openPage(browser, wide, query);
  await editName(page).waitFor({ state: 'visible', timeout: 8000 });
  assert.equal(await editName(page).inputValue(), title, `${label}: the edit view of that task`);
  assert.equal(await sheet(page).isVisible(), true, `${label}: the T-Attention panel is shown`);
  assert.equal(await page.evaluate(() => location.search), rest, `${label}: the link is taken out of the address`);
  // Closing the edit view leaves the panel; it does not come back by itself.
  await page.locator('#h5-attention-edit-close').click();
  await page.locator('#h5-attention-edit').waitFor({ state: 'detached', timeout: 5000 });
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#h5-attention-edit').count(), 0, `${label}: the edit view stays closed`);
  await page.reload();
  await page.waitForTimeout(800);
  assert.equal(await page.locator('#h5-attention-edit').count(), 0, `${label}: a reload does not open it again`);
  assert.deepEqual(state.errors, [], `${label}: no page errors`);
  await context.close();
}

async function notThere(browser, wide, query) {
  const { context, page, state, label } = await openPage(browser, wide, query);
  await sheet(page).waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('#h5-attention-edit').count(), 0, `${label}: no edit view`);
  assert.equal(await page.evaluate(() => location.search), '', `${label}: the link is taken out of the address`);
  assert.equal(await page.evaluate(() => (window.H5UI && window.H5UI.get ? (window.H5UI.get().attention || {}).focus : null) ?? null), null, `${label}: nothing waits to open later`);
  assert.deepEqual(state.errors, [], `${label}: no page errors`);
  await context.close();
}

// A page loaded as usual is told by its stream to show a task's details: the panel opens with the edit view, without a reload.
async function pushed(browser, wide) {
  const { context, page, state, label } = await openPage(browser, wide, '');
  const pushedLabel = `${label} pushed`;
  await page.waitForFunction(() => window.streams.some(s => s.readyState === 1 && s.url === '/api/attention/stream?tab=1&copies=1'), null, { timeout: 8000 });
  await page.waitForTimeout(500);
  await page.evaluate(() => { window.notReloaded = true; });
  assert.equal(await page.evaluate(() => window.push('open-item', { key: 'local:5' })), true);
  await editName(page).waitFor({ state: 'visible', timeout: 8000 });
  assert.equal(await editName(page).inputValue(), 'Other local task', `${pushedLabel}: the edit view of that task`);
  await page.locator('#h5-attention-edit-close').click();
  await page.locator('#h5-attention-edit').waitFor({ state: 'detached', timeout: 5000 });
  await page.evaluate(() => window.push('open-item', { key: 'remote:7:4' }));
  await editName(page).waitFor({ state: 'visible', timeout: 8000 });
  assert.equal(await editName(page).inputValue(), 'Remote task', `${pushedLabel}: a task of the connected service`);
  await page.locator('#h5-attention-edit-close').click();
  await page.locator('#h5-attention-edit').waitFor({ state: 'detached', timeout: 5000 });
  await page.evaluate(() => window.push('open-item', { key: 'local:99' }));
  await page.waitForTimeout(800);
  assert.equal(await page.locator('#h5-attention-edit').count(), 0, `${pushedLabel}: a task that is not there opens no edit view`);
  assert.equal(await sheet(page).isVisible(), true, `${pushedLabel}: the panel stays shown`);
  assert.equal(await page.evaluate(() => window.notReloaded === true && location.search === ''), true, `${pushedLabel}: no reload, no link in the address`);
  assert.deepEqual(state.errors, [], `${pushedLabel}: no page errors`);
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const wide of [true, false]) {
      await followed(browser, wide, { query: '?openAttention=local:3', title: 'Local task', rest: '' });
      await followed(browser, wide, { query: '?keep=1&openAttention=remote:7:4', title: 'Remote task', rest: '?keep=1' });
      for (const query of ['?openAttention=local:99', '?openAttention=nonsense']) await notThere(browser, wide, query);
      await pushed(browser, wide);
    }
    console.log('h5 open attention link: ok');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
