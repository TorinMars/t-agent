// Recent phone terminals stay connected (public/js/h5.js, WARM_MAX = 3), in Chromium at phone size with mocked sockets:
// switching back to one is instant (no new socket, no replay) and shows what it printed while hidden; only the shown one is acked and sends its size;
// a fourth terminal closes the least recently shown one; a hidden one taken over elsewhere is closed without a prompt; after 60 s on a hidden page every
// socket is closed and the shown one connects again when the page is shown. Switching between five terminals ten times does not grow the number of
// event listeners (the xterm 5.5 screen-DPR monitor used to leak two per terminal).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const TERMINALS = [1, 2, 3, 4, 5].map(i => ({ terminal_id: `t${i}`, title: `Term ${i}` }));
const pageErrors = [];
const acks = [];

async function openPage(browser, { keepSockets = true, clock = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  if (clock) await page.clock.install();
  await page.addInitScript(keep => {
    // keep: the list holds every socket (to look at them); otherwise only their number, so a closed terminal can be collected.
    window.sockets = keep ? [] : { length: 0, push() { this.length += 1; } };
    window.FakeSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
      emit(data) { this.onmessage?.({ data }); }
    };
    window.FakeSocket.OPEN = 1;
    window.FakeSocket.CONNECTING = 0;
    window.WebSocket = window.FakeSocket;
  }, keepSockets);
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    if (url.pathname === '/api/tasks/1/terminal/ack' && method === 'POST') { acks.push(route.request().postDataJSON().terminal_id); return json({ success: true }); }
    if (url.pathname === '/api/remote-servers') return json([]);
    if (url.pathname === '/api/tasks' && method === 'GET') return json([{ id: 1, title: 'Alpha', status: 'doing' }]);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (url.pathname === '/api/tasks/1/terminals') return json(TERMINALS);
    if (url.pathname === '/api/tasks/1/agent/conversations') return json([]);
    if (url.pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  await page.locator('.h5-task-item', { hasText: 'Alpha' }).tap();
  return { context, page };
}

const shownId = page => page.evaluate(() => document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId);
// Picks a terminal in the task sheet; returns the ms from the click until it is on screen (in-page clock: the display may be asleep).
async function pick(page, name) {
  if (!(await page.locator('#h5-tasks').isVisible())) await page.locator('#h5-open-tasks').tap();
  const id = TERMINALS.find(row => row.title === name).terminal_id;
  const row = page.locator('#h5-tasks .h5-terminal-main', { hasText: name });
  await row.waitFor();
  // The click is sent inside the page and timed there (the time of Playwright's own tap checks is not the page's).
  const ms = await row.evaluate((el, want) => new Promise(resolve => {
    const at = performance.now();
    el.click();
    const check = () => (document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId === want ? resolve(performance.now() - at) : requestAnimationFrame(check));
    check();
  }), id);
  await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
  return ms;
}
const socketOf = (page, id) => page.evaluate(want => window.sockets.map((socket, index) => [index, new URL(socket.url).searchParams.get('terminalId'), socket.readyState]).filter(([, tid]) => tid === want), id);
const resizes = (page, index) => page.evaluate(i => window.sockets[i].sent.filter(item => { try { return JSON.parse(item).type === 'resize'; } catch { return false; } }).length, index);

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const { context, page } = await openPage(browser, { clock: true });
    await pick(page, 'Term 1');
    await page.waitForFunction(() => window.sockets.length === 1 && window.sockets[0].readyState === 1);
    await page.evaluate(() => window.sockets[0].emit(JSON.stringify({ type: 'history', data: 'one$ ', cols: 40, rows: 20 })));
    await pick(page, 'Term 2');
    await page.waitForFunction(() => window.sockets.length === 2 && window.sockets[1].readyState === 1);
    assert.equal(await page.evaluate(() => window.sockets[0].readyState), 1, 'Term 1 stays connected while hidden');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.h5-xterm')].map(el => [el.dataset.terminalId, el.hidden])), [['t1', true], ['t2', false]]);

    // Output of the hidden terminal is kept; a resize of the page reaches only the shown terminal's PTY.
    await page.evaluate(() => window.sockets[0].emit('\r\nPRINTED-WHILE-HIDDEN'));
    const hiddenResizes = await resizes(page, 0);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForFunction(() => window.sockets[1].sent.some(item => item.includes('"resize"')));
    await page.waitForTimeout(300);
    assert.equal(await resizes(page, 0), hiddenResizes, 'a hidden terminal sends no resize');

    // Back to Term 1: no new socket, its output is there at once, it is acked and sends its size once.
    const acksBefore = acks.length;
    const ms = await pick(page, 'Term 1');
    assert.equal(await page.evaluate(() => window.sockets.length), 2, 'no reconnect');
    assert.ok(await page.evaluate(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-rows').textContent.includes('PRINTED-WHILE-HIDDEN')), 'what it printed while hidden is shown');
    await page.waitForFunction(() => window.sockets[0].sent.some(item => item.includes('"resize"')));
    const started = Date.now();
    while (!acks.slice(acksBefore).includes('t1')) { assert.ok(Date.now() - started < 5000, 'the shown terminal is acked'); await page.waitForTimeout(50); }
    assert.ok(acks.slice(acksBefore).every(id => id === 't1'), `only the shown terminal is acked: ${acks.slice(acksBefore)}`);
    assert.ok(ms >= 0);

    // Typing goes only to the shown terminal.
    await page.evaluate(() => { window.sockets[0].sent.length = 0; window.sockets[1].sent.length = 0; });
    await page.evaluate(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-helper-textarea').dispatchEvent(new InputEvent('input', { data: 'x', inputType: 'insertText', bubbles: true })));
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.sockets[1].sent.filter(item => !item.includes('"ping"')).length), 0, 'nothing reaches a hidden terminal');

    // Term 3 and Term 4: the least recently shown one (Term 2) is closed; three stay.
    await pick(page, 'Term 3');
    await pick(page, 'Term 4');
    assert.deepEqual(await socketOf(page, 't2'), [[1, 't2', 3]], 'Term 2 was closed');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.h5-xterm')].map(el => el.dataset.terminalId).sort()), ['t1', 't3', 't4']);
    // Term 2 again: a new connection (it was closed), and now Term 1 is the oldest and goes.
    await pick(page, 'Term 2');
    assert.equal((await socketOf(page, 't2')).length, 2);
    assert.equal((await socketOf(page, 't1')).at(-1)[2], 3, 'Term 1 was closed');

    // A hidden terminal taken over on another device: it is closed quietly, no prompt on this one.
    const [[t3]] = await socketOf(page, 't3');
    await page.evaluate(i => { const socket = window.sockets[i]; socket.readyState = 3; socket.onclose?.({ code: 4010 }); }, t3);
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.h5-xterm[data-terminal-id="t3"]').count(), 0, 'its view is gone');
    assert.equal(await page.locator('.terminal-owner-prompt, .h5-owner-prompt').count(), 0, 'no take-over prompt for a hidden terminal');
    assert.equal(await shownId(page), 't2');

    // The page is hidden for more than 60 s: every socket is closed; shown again, the shown terminal connects again.
    const setHidden = hidden => page.evaluate(value => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (value ? 'hidden' : 'visible') });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
    await setHidden(true);
    await page.clock.fastForward(30000);
    assert.ok((await page.evaluate(() => window.sockets.filter(socket => socket.readyState === 1).length)) >= 2, 'still connected after 30 s');
    await page.clock.fastForward(31000);
    assert.equal(await page.evaluate(() => window.sockets.filter(socket => socket.readyState === 1).length), 0, 'all closed after 60 s');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.h5-xterm')].map(el => el.dataset.terminalId)), ['t2'], 'the shown view stays');
    const count = await page.evaluate(() => window.sockets.length);
    await setHidden(false);
    await page.waitForFunction(n => window.sockets.length === n + 1 && new URL(window.sockets.at(-1).url).searchParams.get('terminalId') === 't2', count);
    await context.close();

    // Listener growth: three terminals warm, then ten switches over five terminals (opening and closing xterms) change nothing.
    {
      const { context: leakContext, page: leakPage } = await openPage(browser, { keepSockets: false });
      const cdp = await leakContext.newCDPSession(leakPage);
      await cdp.send('Performance.enable');
      const listeners = async () => {
        await cdp.send('HeapProfiler.collectGarbage');
        await leakPage.waitForTimeout(150);
        await cdp.send('HeapProfiler.collectGarbage');
        const { metrics } = await cdp.send('Performance.getMetrics');
        return { listeners: metrics.find(m => m.name === 'JSEventListeners').value, nodes: metrics.find(m => m.name === 'Nodes').value };
      };
      for (const name of ['Term 3', 'Term 2', 'Term 1']) await pick(leakPage, name);
      // Timing without the fake clock: back to a warm terminal against a terminal that must be created (the mock answers at once).
      const warmMs = await pick(leakPage, 'Term 3');
      const coldMs = await pick(leakPage, 'Term 5');
      console.log(`switch to a warm terminal ${warmMs.toFixed(1)} ms, to a new one ${coldMs.toFixed(1)} ms (a real one also waits for the socket and the replay)`);
      for (const name of ['Term 2', 'Term 1']) await pick(leakPage, name);
      const before = await listeners();
      for (let i = 0; i < 10; i += 1) await pick(leakPage, `Term ${(i % 5) + 1}`);
      const after = await listeners();
      console.log(`listeners before ${before.listeners}, after 10 switches ${after.listeners}; DOM nodes ${before.nodes} -> ${after.nodes}`);
      assert.equal(after.listeners, before.listeners, 'switching does not grow the event listeners');
      assert.equal(await leakPage.locator('.h5-xterm').count(), 3, 'three terminals at most');
      await leakContext.close();
    }

    assert.deepEqual(pageErrors, [], 'no browser runtime errors');
    console.log('Phone warm terminals: instant switch back, hidden output kept, shown-only ack / size / input, oldest closed, quiet take-over, idle close and reopen, no listener growth passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
