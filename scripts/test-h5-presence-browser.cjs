// Foreground presence of the page's terminals (public/js/h5.js, `{ type: 'presence', foreground }` binary control frames), in Chromium with mocked
// sockets and the Playwright clock: the shown terminal says true after its history snapshot, switching terminals flips both, a hidden page says false,
// five minutes without the person using the page says false and the next key says true, a reconnect says it again, nothing is sent to an old
// text-protocol server, and in the multi-column view every visible pane with a terminal is in the foreground while the person uses any column.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const TERMINALS = [1, 2, 3].map(i => ({ terminal_id: `t${i}`, title: `Term ${i}` }));
const IDLE_MS = 5 * 60 * 1000;
const pageErrors = [];

async function openPage(browser, { viewport, phone }) {
  const context = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.clock.install();
  await page.addInitScript(() => {
    window.sockets = [];
    window.FakeSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } }, 0); }
      send(data) {
        const binary = typeof data !== 'string';
        const text = binary ? new TextDecoder().decode(data) : data;
        this.sent.push({ binary, text });
        // A server of the binary protocol answers pings, so the heartbeat keeps the connection while the clock runs for minutes.
        if (binary && text.includes('"ping"')) setTimeout(() => this.readyState === 1 && this.onmessage?.({ data: new TextEncoder().encode('{"type":"pong"}').buffer }), 0);
      }
      close() { this.readyState = 3; }
      emit(data) { this.onmessage?.({ data }); }
      history(binary = true) {
        const text = JSON.stringify({ type: 'history', data: '$ ', cols: 40, rows: 20 });
        this.emit(binary ? new TextEncoder().encode(text).buffer : text);
      }
      presence() { return this.sent.filter(item => item.binary && item.text.includes('"presence"')).map(item => JSON.parse(item.text).foreground); }
      textPresence() { return this.sent.filter(item => !item.binary && item.text.includes('presence')).length; }
    };
    window.FakeSocket.OPEN = 1;
    window.FakeSocket.CONNECTING = 0;
    window.WebSocket = window.FakeSocket;
  });
  await page.addInitScript(activityStreamMock);
  await context.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    if (/^\/api\/tasks\/\d+\/terminal\/ack$/.test(url.pathname)) return json({ success: true });
    if (url.pathname === '/api/remote-servers') return json([]);
    if (url.pathname === '/api/tasks' && method === 'GET') return json([{ id: 1, title: 'Alpha', status: 'doing' }]);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (url.pathname === '/api/tasks/1/terminals') return json(TERMINALS);
    if (url.pathname === '/api/tasks/terminal-activity' || url.pathname === '/api/tasks/terminal-subagents') return json({});
    if (url.pathname === '/api/tasks/1/agent/conversations') return json([]);
    if (url.pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  return { context, page };
}

// In the page (or a pane frame): the index of the newest socket of a terminal, waiting until it is open.
const socketFor = (target, id) => target.waitForFunction(want => {
  const index = window.sockets.map(socket => new URL(socket.url, location.href).searchParams.get('terminalId')).lastIndexOf(want);
  return index >= 0 && window.sockets[index].readyState === 1 ? { index } : false;
}, id).then(handle => handle.jsonValue()).then(found => found.index);
const presence = (target, index) => target.evaluate(i => window.sockets[i].presence(), index);
async function expectPresence(target, index, want, message) {
  try { await target.waitForFunction(([i, list]) => JSON.stringify(window.sockets[i].presence()) === JSON.stringify(list), [index, want], { timeout: 3000 }); }
  catch { assert.deepEqual(await presence(target, index), want, message); }
}
const setHidden = (page, hidden) => page.evaluate(value => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (value ? 'hidden' : 'visible') });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);

async function pick(page, name) {
  if (!(await page.locator('#h5-tasks').isVisible())) await page.locator('#h5-open-tasks').tap();
  const row = page.locator('#h5-tasks .h5-terminal-main', { hasText: name });
  await row.waitFor();
  await row.evaluate(el => el.click());
  await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    // ── One page on a phone ──
    {
      const { context, page } = await openPage(browser, { viewport: { width: 390, height: 844 }, phone: true });
      await page.locator('.h5-task-item', { hasText: 'Alpha' }).tap();
      await pick(page, 'Term 1');
      const first = await socketFor(page, 't1');
      assert.deepEqual(await presence(page, first), [], 'nothing before the server spoke the binary protocol');
      await page.evaluate(i => window.sockets[i].history(), first);
      await expectPresence(page, first, [true], 'the shown terminal is in the foreground after its snapshot');

      // Switching flips both; a warm terminal shown again says true again.
      await pick(page, 'Term 2');
      const second = await socketFor(page, 't2');
      await expectPresence(page, first, [true, false], 'the hidden one says false');
      await page.evaluate(i => window.sockets[i].history(), second);
      await expectPresence(page, second, [true]);
      await pick(page, 'Term 1');
      await expectPresence(page, second, [true, false]);
      await expectPresence(page, first, [true, false, true]);

      // A hidden page: false; visible again (the person used it a moment ago): true. Only changes are sent.
      await setHidden(page, true);
      await expectPresence(page, first, [true, false, true, false]);
      await setHidden(page, false);
      await expectPresence(page, first, [true, false, true, false, true]);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.clock.runFor(2000);
      assert.deepEqual(await presence(page, first), [true, false, true, false, true], 'no repeat without a change');
      assert.deepEqual(await presence(page, second), [true, false], 'a hidden warm terminal stays false');

      // Five minutes without the person: false. The next key (or press) on the page: true.
      await page.clock.runFor(IDLE_MS + 1000);
      await expectPresence(page, first, [true, false, true, false, true, false], 'idle for five minutes');
      assert.equal(await page.evaluate(() => window.sockets.filter(socket => socket.readyState === 1).length), 2, 'the sockets stayed connected');
      await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true })));
      await expectPresence(page, first, [true, false, true, false, true, false, true], 'activity after the window ran out');
      assert.deepEqual(await presence(page, second), [true, false]);

      // A lost connection: the new socket says it again after its snapshot.
      await page.evaluate(i => { const socket = window.sockets[i]; socket.readyState = 3; socket.onclose?.({ code: 1006 }); }, first);
      await page.clock.runFor(1500);
      const again = await socketFor(page, 't1');
      assert.notEqual(again, first);
      await page.evaluate(i => window.sockets[i].history(), again);
      await expectPresence(page, again, [true], 'resent after the reconnect');

      // An old server (its snapshot is a text frame): no presence at all, in either kind of frame.
      await pick(page, 'Term 3');
      const old = await socketFor(page, 't3');
      await page.evaluate(i => window.sockets[i].history(false), old);
      await page.clock.runFor(500);
      await setHidden(page, true);
      await setHidden(page, false);
      assert.deepEqual(await presence(page, old), [], 'nothing to an old server');
      assert.equal(await page.evaluate(i => window.sockets[i].textPresence(), old), 0, 'never as a text frame (that would be typed into the shell)');
      await context.close();
    }

    // ── The multi-column view: each pane reports for its own terminal; the activity of any column counts for all ──
    {
      const { context, page } = await openPage(browser, { viewport: { width: 1440, height: 900 }, phone: false });
      await page.locator('#h5-columns-open').waitFor();
      await page.locator('#h5-columns-open').click();
      // First use at 1440px: four columns (floor(1440 / 360); columns.mjs defaultCount). The first two are used below.
      await page.waitForFunction(() => document.querySelectorAll('#h5-columns iframe').length === 4
        && [...document.querySelectorAll('#h5-columns iframe')].every(el => el.contentDocument && el.contentDocument.getElementById('h5-app') && el.contentWindow.H5Pane));
      const ids = await page.evaluate(() => [...document.querySelectorAll('#h5-columns iframe')].map(el => el.dataset.paneId));
      const frame = id => page.frames().find(item => item.url().endsWith(`/h5?pane=${id}`));
      // The first two columns open a terminal each (as the top page's open request does).
      await page.evaluate(([a, b]) => {
        const post = (id, terminalId) => document.querySelector(`#h5-columns iframe[data-pane-id="${id}"]`).contentWindow.postMessage({ type: 't-agent-pane', event: 'open', sourceKey: 'local', taskId: 1, terminalId }, location.origin);
        post(a, 't1');
        post(b, 't2');
      }, ids);
      const left = frame(ids[0]);
      const right = frame(ids[1]);
      const leftSocket = await socketFor(left, 't1');
      const rightSocket = await socketFor(right, 't2');
      await left.evaluate(i => window.sockets[i].history(), leftSocket);
      await right.evaluate(i => window.sockets[i].history(), rightSocket);
      await expectPresence(left, leftSocket, [true], 'a visible pane with its terminal is in the foreground');
      await expectPresence(right, rightSocket, [true]);
      assert.equal(await page.evaluate(() => window.sockets.filter(socket => socket.readyState === 1 && socket.url.includes('/terminal/ws')).length), 0, 'the top page holds no terminal socket');
      // Nobody uses the page for five minutes: both columns go to the background.
      await page.clock.runFor(IDLE_MS + 1000);
      await expectPresence(left, leftSocket, [true, false]);
      await expectPresence(right, rightSocket, [true, false]);
      // A key in the left column: the right one (visible beside it) is in the foreground again too.
      await left.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true })));
      await expectPresence(left, leftSocket, [true, false, true]);
      await expectPresence(right, rightSocket, [true, false, true], 'the activity of one column counts for every column');
      // Idle again, then a press on the top page's own bar: the columns follow.
      await page.clock.runFor(IDLE_MS + 1000);
      await expectPresence(right, rightSocket, [true, false, true, false]);
      await page.evaluate(() => document.getElementById('h5-columns-bar').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
      await expectPresence(right, rightSocket, [true, false, true, false, true], 'activity on the top page counts for the columns');
      await expectPresence(left, leftSocket, [true, false, true, false, true]);
      await context.close();
    }

    assert.deepEqual(pageErrors, [], 'no browser runtime errors');
    console.log('Terminal presence: snapshot, switch, hidden page, five-minute idle and activity, reconnect, old server, columns with shared activity passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
