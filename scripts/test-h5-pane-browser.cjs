// Pane mode (scripts/h5-shell/pane.mjs, "Pane mode" in DESIGN.md): the page (/h5?pane=<id>) inside real 480x900 iframes of a test parent page, in Chromium
// on a computer (mouse, no touch), with the API mocked. Checks: each pane remembers its own task and terminal (two panes, two sessions) and the normal view
// keeps its own; a new pane starts at the task list with nothing selected; a pane opens no terminal activity stream and no T-Attention stream and polls
// the activity instead; a loading pane takes no focus, a click does; `open` from the parent shows that task and terminal; no notice, sound or system notification (the page makes none at all now) and no attention or update reads in a pane; no Update or Attention button; phone layout
// with desktop input (Enter translates and sends, a click focuses the terminal, no on-screen keyboard buttons), the height of the iframe; no history
// entries for the top page; the messages to the parent (ready, title, focus) on this origin only; `forget` from the parent clears only that pane's keys,
// and the same message from anywhere else is ignored; a top-level `/h5?pane=` is the normal page (streams, reminders, Update and Attention buttons).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const OTHER = 'http://other.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const TASKS = [{ id: 1, title: 'Alpha', status: 'doing' }, { id: 2, title: 'Beta', status: 'doing' }];
const TERMINALS = { 1: [{ terminal_id: 't1', title: 'Term 1' }, { terminal_id: 't2', title: 'Term 2' }], 2: [{ terminal_id: 't3', title: 'Term 3' }] };
// What is remembered before the panes start: pane a shows Alpha / Term 1, the normal view Alpha / Term 2, pane b nothing yet, pane c (under another origin) Alpha.
const SEED = {
  'pane:a:h5-task:local': '1', 'pane:a:h5-terminal:local:1': 't1',
  'h5-task:local': '1', 'h5-terminal:local:1': 't2',
  'pane:c:h5-task:local': '1',
};
const PARENT = paneIds => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;display:flex;gap:8px}iframe{width:480px;height:900px;border:0;flex:0 0 auto}</style></head><body>
<script>
  window.messages = [];
  window.startLength = history.length; // before the panes load
  addEventListener('message', event => {
    const frame = [...document.querySelectorAll('iframe')].findIndex(el => el.contentWindow === event.source);
    window.messages.push({ data: event.data, origin: event.origin, frame });
  });
</script>
${paneIds.map(id => `<iframe id="pane-${id}" src="${ORIGIN}/h5?pane=${id}"></iframe>`).join('')}
</body></html>`;

const pageErrors = [];
const requests = []; // { path, method, frame } of every API request (frame: the address of the frame that sent it)

async function setup(context) {
  await context.addInitScript(seed => {
    if (location.origin === 'http://h5.test' && !localStorage.getItem('test-seeded')) {
      for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
      localStorage.setItem('test-seeded', '1');
    }
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    window.streams = [];
    window.EventSource = class extends EventTarget {
      constructor(url) { super(); this.url = url; this.readyState = 0; window.streams.push(this); setTimeout(() => { if (this.readyState !== 2) { this.readyState = 1; this.dispatchEvent(new Event('open')); } }, 0); }
      close() { this.readyState = 2; }
    };
    window.emitChange = change => {
      const live = window.streams.filter(s => s.readyState === 1 && /\/api\/attention\/stream$/.test(s.url)).at(-1);
      if (!live) return false;
      live.dispatchEvent(new MessageEvent('change', { data: JSON.stringify(change) }));
      return true;
    };
    // The page shows no system notifications any more (only Telegram reminds outside the page): any made would be counted here.
    window.notes = [];
    window.Notification = class { constructor(title) { window.notes.push(title); } close() {} };
    window.Notification.permission = 'granted';
    window.Notification.requestPermission = async () => 'granted';
    window.tones = 0;
    window.AudioContext = class {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
      resume() { return Promise.resolve(); }
      createOscillator() { window.tones += 1; return { type: '', frequency: {}, connect() {}, start() {}, stop() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    };
  }, SEED);
  await context.addInitScript(activityStreamMock);
  await context.route(`${OTHER}/**`, route => route.fulfill({ contentType: 'text/html', body: PARENT(['c']) }));
  await context.route(`${ORIGIN}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const p = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/parent.html') return route.fulfill({ contentType: 'text/html', body: PARENT(['a', 'b']) });
    if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
    let frame = '';
    try { frame = request.frame().url(); } catch { /* a service worker request */ }
    requests.push({ path: p, method, frame });
    if (p === '/api/remote-servers') return json([]);
    if (p === '/api/tasks' && method === 'GET') return json(TASKS);
    if (p === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (p === '/api/tasks/terminal-activity') return json({});
    if (p === '/api/tasks/terminal-subagents') return json({});
    const terminals = p.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (terminals && method === 'GET') return json(TERMINALS[terminals[1]] || []);
    if (/^\/api\/tasks\/\d+\/agent\/conversations$/.test(p)) return json(p === '/api/tasks/2/agent/conversations' ? [{ id: 'beta-chat', agent: 'claude', session_id: null, title: 'Beta chat', mode: 'ask', running: false, pending: false, opened: { web: null, h5: null } }] : []);
    if (p === '/api/tasks/2/agent/conversations/beta-chat') return json({ conversation: { id: 'beta-chat' }, items: [{ id: 'u1', kind: 'user', text: 'hello agent' }], pending: [], status: 'idle', seq: 0 });
    if (/^\/api\/tasks\/\d+\/terminal\/ack$/.test(p)) return json({ success: true });
    if (p === '/api/translate') return json({ text: 'Translated text' });
    if (p === '/api/attention') return json({ items: [], host: 'h5.test' });
    if (p === '/api/system/update-status') return json({ status: 'current', local_version: '1.0.0', boot_id: 'b1' });
    return json({ error: 'not mocked' }, 404);
  });
}

const paneFrame = (page, id) => page.frames().find(frame => frame.url().includes(`pane=${id}`));
const fromPane = (id, test) => requests.filter(entry => entry.frame.includes(`pane=${id}`) && test(entry));
const until = async (check, message, ms = 5000) => {
  const started = Date.now();
  for (;;) {
    if (await check()) return;
    assert.ok(Date.now() - started < ms, message);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
const socketTerminal = url => new URL(url).searchParams.get('terminalId');
const socketClient = url => new URL(url).searchParams.get('clientId');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 960 } });
    await setup(context);
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`${ORIGIN}/parent.html`);
    await until(() => page.frames().length === 3 && paneFrame(page, 'a') && paneFrame(page, 'b'), 'both panes load');
    const a = paneFrame(page, 'a');
    const b = paneFrame(page, 'b');
    for (const frame of [a, b]) await frame.waitForFunction(() => window.H5UI && window.H5Pane && document.readyState === 'complete');

    // ── Own selection ──
    await a.waitForFunction(() => window.sockets.length >= 1);
    assert.deepEqual(await a.evaluate(() => window.sockets.map(socket => new URL(socket.url).searchParams.get('terminalId'))), ['t1'], 'pane a opens its own remembered terminal');
    await a.waitForFunction(() => window.H5UI.get().taskName === 'Alpha');
    // A new pane: the task list, nothing selected, no socket, no error.
    await b.waitForFunction(() => window.H5UI.get().tasksOpen === true);
    await b.waitForTimeout(300);
    assert.equal(await b.evaluate(() => window.H5UI.get().taskName), '', 'pane b shows no task');
    assert.equal(await b.evaluate(() => window.sockets.length), 0, 'pane b opens no terminal');
    // Nothing takes the focus by itself: a column that loads must not pull the focus into its frame (pane a shows a terminal, pane b its task sheet).
    await a.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.tagName), 'BODY', 'a loading pane does not take the parent\'s focus');
    assert.equal(await a.evaluate(() => Boolean(document.activeElement && document.activeElement.closest && document.activeElement.closest('.xterm'))), false, 'pane a does not focus its terminal by itself');
    assert.equal((await page.evaluate(() => window.messages)).filter(m => m.data.event === 'focus').length, 0, 'no focus message before a press');
    // Pane b chooses Beta / Term 3: it is remembered for pane b only.
    await b.locator('.h5-task-item', { hasText: 'Beta' }).click();
    await b.locator('#h5-tasks .h5-terminal-main', { hasText: 'Term 3' }).click();
    await b.waitForFunction(() => window.sockets.length === 1);
    assert.equal(socketTerminal(await b.evaluate(() => window.sockets[0].url)), 't3');
    const stored = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)])));
    assert.equal(stored['pane:b:h5-task:local'], '2');
    assert.equal(stored['pane:b:h5-terminal:local:2'], 't3');
    assert.equal(stored['pane:a:h5-task:local'], '1');
    assert.equal(stored['pane:a:h5-terminal:local:1'], 't1');
    assert.equal(stored['h5-task:local'], '1', 'the normal view keeps its task');
    assert.equal(stored['h5-terminal:local:1'], 't2', 'the normal view keeps its terminal');
    assert.equal(stored['h5-task:local:2'], undefined);
    // Two panes are two terminal clients (the frames of a tab share its sessionStorage).
    const clients = [socketClient(await a.evaluate(() => window.sockets[0].url)), socketClient(await b.evaluate(() => window.sockets[0].url))];
    assert.notEqual(clients[0], clients[1], 'each pane has its own terminal client id');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('pane:a:terminal-client-id')), clients[0]);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('terminal-client-id')), null, 'the tab\'s own client id is untouched');

    // ── Streams: none in a pane, the activity is polled ──
    await until(() => fromPane('a', entry => entry.path === '/api/tasks/terminal-activity').length >= 1 && fromPane('b', entry => entry.path === '/api/tasks/terminal-activity').length >= 1, 'each pane polls the terminal activity');
    for (const frame of [a, b]) {
      assert.deepEqual(await frame.evaluate(() => window.activityStream.opens), [], 'no terminal activity stream in a pane');
      assert.deepEqual(await frame.evaluate(() => window.streams.map(s => s.url)), [], 'no EventSource in a pane');
    }
    // The page shown again: still no stream (the feeds are decided again then).
    await a.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await a.waitForTimeout(200);
    assert.deepEqual(await a.evaluate(() => window.activityStream.opens), [], 'no stream after the page is shown again');
    // ── No reminders, no updater, no T-Attention in a pane ──
    assert.equal(fromPane('a', entry => entry.path.startsWith('/api/attention')).length + fromPane('b', entry => entry.path.startsWith('/api/attention')).length, 0, 'no T-Attention reads in a pane');
    const updaterRead = entry => /^\/api\/system\/(update-status|check-update|apply-update|update-notified)/.test(entry.path);
    assert.equal(fromPane('a', updaterRead).length + fromPane('b', updaterRead).length, 0, 'no update polling in a pane');
    for (const id of ['a', 'b']) assert.ok(fromPane(id, entry => entry.path === '/api/system/version').length <= 1, 'at most one version read (the engine name) per pane');
    for (const frame of [a, b]) {
      assert.equal(await frame.locator('#h5-update').count(), 0, 'no Update button in a pane');
      assert.equal(await frame.locator('#h5-attention').count(), 0, 'no Attention button in a pane');
      assert.equal(await frame.evaluate(() => window.emitChange({ kind: 'updated', item: { id: 5, title: 'Ping', status: 'waiting_user' }, previous: { id: 5, status: 'working' }, event: { actor: 'claude' } })), false, 'nothing to remind from');
      assert.equal(await frame.evaluate(() => window.notes.length + window.tones), 0, 'no notification or sound in a pane');
      assert.equal(await frame.locator('.MuiSnackbar-root').count(), 0, 'no notice in a pane');
    }
    // The header keeps its own buttons.
    for (const id of ['#h5-open-tasks', '#h5-task-name', '#h5-session-name', '#h5-term-width', '#h5-refresh']) assert.equal(await a.locator(id).count(), 1, `${id} in the pane header`);

    // ── Phone layout with desktop input, at the iframe's size ──
    const layout = await a.evaluate(() => ({
      wide: window.H5UI.get().wide, input: document.documentElement.dataset.input, height: getComputedStyle(document.documentElement).getPropertyValue('--h5-height').trim(),
      width: innerWidth, sidebar: Boolean(document.getElementById('h5-sidebar-toggle')), keyboards: document.querySelectorAll('[data-action="keyboard"], [data-action="draft"]').length,
    }));
    assert.deepEqual(layout, { wide: false, input: 'pointer', height: '900px', width: 480, sidebar: false, keyboards: 0 }, 'phone layout, pointer input, iframe height');
    // A click on the terminal focuses it; Enter in the draft box translates and sends.
    await a.locator('.h5-xterm:not([hidden]) .xterm-screen').click();
    assert.ok(await a.evaluate(() => Boolean(document.activeElement && document.activeElement.closest('.xterm'))), 'a click focuses the terminal');
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'pane-a', 'the clicked pane has the focus');
    await a.locator('#h5-translate-input').fill('hello');
    await a.locator('#h5-translate-input').press('Enter');
    await until(() => fromPane('a', entry => entry.path === '/api/translate').length === 1, 'Enter translates and sends');
    await a.waitForFunction(() => window.sockets[0].sent.some(item => item.includes('Translated text')));
    // ── No history entries for the top page (the task sheet of pane b and the menus are modals) ──
    await b.locator('#h5-open-tasks').click();
    await b.waitForFunction(() => window.H5UI.get().tasksOpen === true);
    await b.waitForTimeout(100);
    assert.equal(await page.evaluate(() => history.length - window.startLength), 0, 'panes push no history entries');
    await page.keyboard.press('Escape');
    await b.waitForFunction(() => window.H5UI.get().tasksOpen === false);

    // ── Messages to the parent ──
    const messages = await page.evaluate(() => window.messages);
    const of = (frame, event) => messages.filter(m => m.frame === frame && m.data && m.data.type === 't-agent-pane' && m.data.event === event);
    assert.ok(messages.every(m => m.origin === ORIGIN), 'every message comes from this origin');
    assert.deepEqual(of(0, 'ready').map(m => m.data), [{ type: 't-agent-pane', paneId: 'a', event: 'ready' }]);
    assert.deepEqual(of(1, 'ready').map(m => m.data), [{ type: 't-agent-pane', paneId: 'b', event: 'ready' }]);
    assert.deepEqual(of(0, 'title').at(-1).data, { type: 't-agent-pane', paneId: 'a', event: 'title', title: 'Alpha', session: 'Term 1' });
    assert.deepEqual(of(1, 'title').at(-1).data, { type: 't-agent-pane', paneId: 'b', event: 'title', title: 'Beta', session: 'Term 3' });
    assert.ok(of(0, 'focus').length >= 1 && of(1, 'focus').length >= 1, 'a press in a pane says focus');
    const focusBefore = of(1, 'focus').length;
    await b.locator('#h5-task-name').click();
    await until(async () => (await page.evaluate(() => window.messages)).filter(m => m.frame === 1 && m.data.event === 'focus').length > focusBefore, 'focus on a press');
    await page.keyboard.press('Escape');

    // ── open: the parent asks a pane to show a task and terminal, or a chat (a `?openChat=` link the top page handles while its columns are shown) ──
    const openIn = (frame, request) => frame.evaluate(data => window.frames[1].postMessage({ type: 't-agent-pane', event: 'open', ...data }, location.origin), request);
    await a.evaluate(() => window.parent.frames[1].postMessage({ type: 't-agent-pane', event: 'open', sourceKey: 'local', taskId: 1, terminalId: 't1' }, location.origin)); // another pane
    await openIn(page, { sourceKey: 'remote:9', taskId: 1, terminalId: 't1' }); // an unknown service
    await openIn(page, { sourceKey: 'local', taskId: 99 }); // an unknown task
    await page.waitForTimeout(300);
    assert.equal(await b.evaluate(() => window.H5UI.get().taskName), 'Beta', 'open from elsewhere, or for something unknown, changes nothing');
    assert.equal(await b.evaluate(() => window.sockets.length), 1);
    await openIn(page, { sourceKey: 'local', taskId: 1, terminalId: 't2' });
    await b.waitForFunction(() => window.H5UI.get().taskName === 'Alpha' && document.querySelector('.h5-xterm:not([hidden])')?.dataset.terminalId === 't2');
    assert.equal(socketTerminal(await b.evaluate(() => window.sockets.at(-1).url)), 't2', 'pane b shows Alpha / Term 2');
    assert.equal(await page.evaluate(() => localStorage.getItem('pane:b:h5-task:local')), '1', 'remembered for pane b');
    assert.equal(await page.evaluate(() => localStorage.getItem('h5-terminal:local:1')), 't2');
    assert.equal(await a.evaluate(() => window.H5UI.get().taskName), 'Alpha');
    assert.equal(socketTerminal(await a.evaluate(() => window.sockets.at(-1).url)), 't1', 'pane a is not moved');
    await until(async () => (await page.evaluate(() => window.messages)).some(m => m.frame === 1 && m.data.event === 'title' && m.data.title === 'Alpha' && m.data.session === 'Term 2'), 'pane b tells its new title');
    // An agent chat of a task (a `?openChat=` link handled by the top page): opened as the link would; a chat that is not there changes nothing.
    await openIn(page, { sourceKey: 'local', taskId: 2, conversationId: 'gone-chat' });
    await page.waitForTimeout(300);
    assert.equal(await b.evaluate(() => window.H5UI.get().taskName), 'Alpha', 'a chat that is not there is ignored');
    await openIn(page, { sourceKey: 'local', taskId: 2, conversationId: 'beta-chat' });
    await b.locator('#h5-agent .ac-bubble', { hasText: 'hello agent' }).waitFor();
    assert.equal(await b.evaluate(() => window.H5UI.get().taskName), 'Beta');
    assert.equal(await b.locator('#h5-session-name').textContent(), 'Beta chat', 'the header names the chat');
    assert.equal(await b.evaluate(() => window.streams.length), 1, 'the shown chat keeps its event stream');
    assert.equal(await a.evaluate(() => window.H5UI.get().taskName), 'Alpha', 'pane a is not moved');

    // ── forget: only from the parent, only that pane ──
    const keys = prefix => page.evaluate(start => Object.keys(localStorage).concat(Object.keys(sessionStorage)).filter(key => key.startsWith(start)).sort(), prefix);
    assert.ok((await keys('pane:b:')).length >= 3);
    await a.evaluate(() => window.parent.frames[1].postMessage({ type: 't-agent-pane', event: 'forget' }, location.origin)); // another pane
    await b.evaluate(() => window.postMessage({ type: 't-agent-pane', event: 'forget' }, location.origin)); // itself
    await page.evaluate(() => window.frames[1].postMessage({ type: 't-agent-pane', event: 'forget', paneId: 'a' }, location.origin)); // meant for another pane
    await page.waitForTimeout(200);
    assert.ok((await keys('pane:b:')).length >= 3, 'a forget from anywhere but the parent is ignored');
    await page.evaluate(() => window.frames[1].postMessage({ type: 't-agent-pane', event: 'forget' }, location.origin));
    await until(async () => (await keys('pane:b:')).length === 0, 'pane b forgets its keys');
    assert.ok((await keys('pane:a:')).length >= 3, 'pane a keeps its keys');
    assert.equal(await page.evaluate(() => localStorage.getItem('h5-terminal:local:1')), 't2', 'the normal view keeps its keys');
    assert.ok((await page.evaluate(() => window.messages)).some(m => m.frame === 1 && m.data.event === 'forgotten'), 'the pane answers forgotten');

    // ── A parent on another origin gets no messages and cannot make a pane forget ──
    const evil = await context.newPage();
    evil.on('pageerror', error => pageErrors.push(error.message));
    await evil.goto(`${OTHER}/parent.html`);
    await until(() => evil.frames().some(frame => frame.url().includes('pane=c')), 'the pane under another origin loads');
    const c = paneFrame(evil, 'c');
    await c.waitForFunction(() => window.H5Pane && window.H5UI.get().taskName === 'Alpha');
    await evil.evaluate(() => window.frames[0].postMessage({ type: 't-agent-pane', event: 'forget' }, '*'));
    await evil.waitForTimeout(200);
    assert.equal(await c.evaluate(() => localStorage.getItem('pane:c:h5-task:local')), '1', 'a forget from another origin is ignored');
    assert.deepEqual(await evil.evaluate(() => window.messages), [], 'a parent on another origin gets nothing');
    await evil.close();

    // ── A top-level /h5?pane= is the normal page ──
    const top = await context.newPage();
    top.on('pageerror', error => pageErrors.push(error.message));
    await top.goto(`${ORIGIN}/h5?pane=a`);
    await top.waitForFunction(() => window.H5UI && window.sockets.length >= 1);
    assert.equal(await top.evaluate(() => window.H5Pane), undefined);
    assert.equal(await top.evaluate(() => window.H5UI.get().pane), null);
    assert.equal(socketTerminal(await top.evaluate(() => window.sockets[0].url)), 't2', 'the normal view\'s own terminal');
    await top.locator('#h5-update').waitFor();
    await top.locator('#h5-attention').waitFor();
    await top.waitForFunction(() => window.activityStream.opens.includes('/api/tasks/terminal-activity/stream'));
    await top.waitForFunction(() => window.streams.some(s => s.url.endsWith('/api/attention/stream') && s.readyState === 1));
    assert.equal(await top.evaluate(() => window.emitChange({ kind: 'updated', item: { id: 5, title: 'Ping', status: 'waiting_user' }, previous: { id: 5, status: 'working' }, event: { actor: 'claude' } })), true);
    await top.waitForFunction(() => window.tones > 0); // the top page reminds: a sound and a notice
    await top.locator('.MuiSnackbar-root', { hasText: 'Ping' }).waitFor();
    assert.equal(await top.evaluate(() => window.notes.length), 0, 'no system notification, not even in the top page');
    await top.close();

    assert.deepEqual(pageErrors, [], 'no browser runtime errors');
    console.log('Pane mode: own selection per pane, no streams (polling), no reminders / updater / attention, phone layout with desktop input, no history, parent messages and forget, top-level ?pane= normal passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
