// The page link of the T-Attention desktop window, `?openTerminal=<engine>:<task id>:<terminal id>` (public/js/h5.js openTerminalFromLink), in real
// Chromium at computer and phone size with mocked routes and sockets. A link selects that task on that service (this machine or a connected one) and shows
// that terminal, over the task the page remembered; the parameter is taken out of the address at once (other parameters stay), so a reload shows the page
// as usual. A task or terminal that is not there, or a link that is not one, shows the normal page and "That terminal is not available any more".
// The same without a new tab: the desktop window's Open session pushes `open-terminal` over the page's T-Attention stream (`/api/attention/stream?tab=1`,
// a fake EventSource here; scripts/h5-shell/attention-feed.mjs), and the open page switches task and terminal in place, without a reload. On `hello` the
// page reports that it is seen (POST /api/attention/stream/seen).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const GONE = 'That terminal is not available any more';

const shell = (id, title) => ({ terminal_id: id, title, work_dir: '/srv/self' });
const LOCAL_TASKS = [{ id: 1, title: 'Here', status: 'doing' }, { id: 2, title: 'Agent work', status: 'doing' }];
const REMOTE_TASKS = [{ id: 5, title: 'SELF-TAGENT', status: 'doing' }];
const ROWS = {
  local: { 1: [shell('h1', 'Here shell')], 2: [shell('a1', 'First shell'), shell('a2', 'Claude 2')] },
  remote: { 5: [shell('r1', 'review'), shell('r2', 'main dev')] },
};

async function openPage(browser, wide, query) {
  const context = await browser.newContext(wide ? { viewport: { width: 1440, height: 900 } } : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const state = { errors: [], seen: [] };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.addInitScript(() => {
    // The page remembers task 1 of this machine and its terminal: a link wins over it.
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('h5-task:local', '1');
      localStorage.setItem('h5-terminal:local:1', 'h1');
      sessionStorage.setItem('seeded', '1');
    }
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; window.sockets.push(this); setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } }, 0); }
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
    if (p === '/api/remote-servers/7/info') return json({ capabilities: ['terminal:control'] });
    if (p === '/api/tasks' && method === 'GET') return json(LOCAL_TASKS);
    if (p === '/api/remote-servers/7/tasks' && method === 'GET') return json(REMOTE_TASKS);
    if (/^\/api(\/remote-servers\/7)?\/task-groups$/.test(p)) return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    const list = p.match(/^\/api(\/remote-servers\/7)?\/tasks\/(\d+)\/terminals$/);
    if (list && method === 'GET') {
      const rows = ROWS[list[1] ? 'remote' : 'local'][Number(list[2])];
      return rows ? json(rows) : json({ error: 'TASK_NOT_FOUND' }, 404);
    }
    if (/\/agent\/conversations$/.test(p)) return json([]);
    if (/\/terminal-activity$/.test(p)) return json({});
    if (/\/terminal-subagents$/.test(p)) return json({});
    if (/\/terminal\/ack$/.test(p)) return json({ success: true });
    if (p === '/api/attention' && method === 'GET') return json({ items: [] });
    if (p === '/api/attention/stream/seen' && method === 'POST') { state.seen.push(route.request().postDataJSON()); return json({ ok: true }); }
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5${query}`);
  return { context, page, state, label: `${wide ? 'computer' : 'phone'} ${query}` };
}

const shownId = page => page.evaluate(() => document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId || null);
const socketTo = page => page.evaluate(() => window.sockets.filter(socket => socket.readyState !== 3).map(socket => {
  const url = new URL(socket.url);
  return `${url.pathname} ${url.searchParams.get('taskId')}:${url.searchParams.get('terminalId')}`;
}));
const notice = page => page.locator('.MuiSnackbar-root .MuiAlert-message');
const waitShown = (page, id) => page.waitForFunction(want => document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId === want, id, { timeout: 8000 });

async function followed(browser, wide, { query, terminal, socket, session, store, rest }) {
  const { context, page, state, label } = await openPage(browser, wide, query);
  await waitShown(page, terminal);
  assert.equal(await page.evaluate(() => location.search), rest, `${label}: the link is taken out of the address`);
  assert.deepEqual(await socketTo(page), [socket], `${label}: only the linked terminal is connected`);
  assert.equal(await page.locator('#h5-session-name').textContent(), session, `${label}: the header names it`);
  assert.equal(await page.evaluate(([key]) => localStorage.getItem(key), [store[0]]), store[1], `${label}: it is remembered for its task`);
  if (!wide) assert.equal(await page.locator('#h5-tasks').isVisible(), false, `${label}: a phone shows the terminal, not the task sheet`);
  await page.waitForTimeout(400);
  assert.equal(await notice(page).count(), 0, `${label}: no notice`);
  assert.equal(await shownId(page), terminal, `${label}: the remembered task does not take over afterwards`);
  // A reload shows the page as usual: nothing opens again from the link.
  await page.reload();
  await page.waitForFunction(() => Boolean(document.querySelector('.h5-xterm:not([hidden])')), null, { timeout: 8000 });
  assert.equal(await page.evaluate(() => location.search), rest, `${label}: still without the link after a reload`);
  await page.waitForTimeout(300);
  assert.equal(await notice(page).count(), 0, `${label}: no notice after the reload`);
  assert.deepEqual(state.errors, [], `${label}: no page errors`);
  await context.close();
}

async function notThere(browser, wide, query) {
  const { context, page, state, label } = await openPage(browser, wide, query);
  await notice(page).filter({ hasText: GONE }).waitFor({ state: 'visible', timeout: 8000 });
  assert.equal(await page.evaluate(() => location.search), '', `${label}: the link is taken out of the address`);
  await waitShown(page, 'h1'); // the normal page: the remembered task and terminal
  assert.deepEqual(state.errors, [], `${label}: no page errors`);
  await context.close();
}

// A page loaded as usual (the remembered task 1, terminal h1) is told by its stream to show other terminals: it switches in place, never reloads.
async function pushed(browser, wide) {
  const { context, page, state, label } = await openPage(browser, wide, '');
  const pushedLabel = `${label} pushed`;
  await waitShown(page, 'h1');
  await page.evaluate(() => { window.notReloaded = true; });
  await page.waitForFunction(() => window.streams.some(s => s.readyState === 1 && s.url === '/api/attention/stream?tab=1&copies=1'), null, { timeout: 8000 });
  assert.equal(await page.evaluate(() => window.push('hello', { stream: 'page-1' })), true);
  for (let i = 0; i < 50 && !state.seen.length; i += 1) await page.waitForTimeout(50);
  assert.deepEqual(state.seen, [{ stream: 'page-1' }], `${pushedLabel}: a visible page says it is seen`);
  await page.evaluate(() => window.push('open-terminal', { engine: 'local', task_id: '2', terminal_id: 'a2' }));
  await waitShown(page, 'a2');
  assert.equal(await page.locator('#h5-session-name').textContent(), 'Claude 2', `${pushedLabel}: the header names it`);
  assert.ok((await socketTo(page)).includes('/terminal/ws 2:a2'), `${pushedLabel}: that terminal is connected`);
  await page.evaluate(() => window.push('open-terminal', { engine: 'remote:7', task_id: '5', terminal_id: 'r2' }));
  await waitShown(page, 'r2');
  assert.ok((await socketTo(page)).includes('/api/remote-servers/7/terminal/ws 5:r2'), `${pushedLabel}: on the connected service`);
  if (!wide) assert.equal(await page.locator('#h5-tasks').isVisible(), false, `${pushedLabel}: a phone shows the terminal, not the task sheet`);
  assert.equal(await notice(page).count(), 0, `${pushedLabel}: no notice`);
  await page.evaluate(() => window.push('open-terminal', { engine: 'local', task_id: '2', terminal_id: 'gone' }));
  await notice(page).filter({ hasText: GONE }).waitFor({ state: 'visible', timeout: 8000 });
  assert.equal(await shownId(page), 'r2', `${pushedLabel}: a terminal that is not there leaves the page as it is`);
  assert.equal(await page.evaluate(() => window.notReloaded === true && location.search === ''), true, `${pushedLabel}: no reload, no link in the address`);
  assert.deepEqual(state.errors, [], `${pushedLabel}: no page errors`);
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const wide of [true, false]) {
      await followed(browser, wide, {
        query: '?openTerminal=local:2:a2', terminal: 'a2', socket: '/terminal/ws 2:a2', session: 'Claude 2', store: ['h5-terminal:local:2', 'a2'], rest: '',
      });
      await followed(browser, wide, {
        query: '?keep=1&openTerminal=remote:7:5:r2', terminal: 'r2', socket: '/api/remote-servers/7/terminal/ws 5:r2', session: 'main dev', store: ['h5-terminal:remote:7:5', 'r2'], rest: '?keep=1',
      });
      for (const query of ['?openTerminal=local:2:gone', '?openTerminal=local:99:a1', '?openTerminal=remote:8:5:r2', '?openTerminal=nonsense']) await notThere(browser, wide, query);
      await pushed(browser, wide);
    }
    console.log('h5 open terminal link: ok');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
