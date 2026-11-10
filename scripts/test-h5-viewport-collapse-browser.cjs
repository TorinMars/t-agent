// The phone page must not collapse on a wrong, small height reading, in real Chromium at phone size (390x844, touch). iOS in standalone mode was seen showing the page
// only about 200px tall, with the terminal box at height 0 and the key rows right under the header, and nothing corrected it. What iOS really reported is not known, so
// the readings are stubbed here: `visualViewport.height` and `innerHeight` are set by the test, with or without the resize event. Each case runs on a fresh page, every check
// is collected and all failures are printed at the end. The server is mocked (no data folder is used).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const WIDTH = 390;
const HEIGHT = 844;
const TASKS = [{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }];
const TERMINALS = { 1: [{ terminal_id: 'h5-default', title: 'Terminal 1' }] };
const CHATS = [{ id: 'c1', agent: 'claude', title: 'A chat' }];
const pageErrors = [];
const failures = [];
let currentCase = '';

function check(ok, message) {
  if (ok) return;
  failures.push(`${currentCase}: ${message}`);
  console.log(`  FAILED ${message}`);
}
const near = (a, b, margin = 2) => Math.abs(a - b) <= margin;

async function openPage(browser, { chat = false } = {}) {
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    // The readings the page gets. null: the real value. `fire` sends the visual viewport's resize event; a late correction from iOS sends none.
    const realInner = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    let visual = null;
    let inner = null;
    window.heightReads = 0;
    Object.defineProperty(window, 'innerHeight', { get: () => inner ?? realInner.get.call(window), configurable: true });
    const viewport = new EventTarget();
    Object.defineProperties(viewport, {
      height: { get: () => { window.heightReads += 1; return visual ?? window.innerHeight; } },
      width: { get: () => window.innerWidth }, offsetTop: { get: () => 0 }, offsetLeft: { get: () => 0 }, scale: { get: () => 1 },
    });
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
    window.setReadings = (next, fire = true) => {
      visual = next.visual ?? null;
      inner = next.inner ?? null;
      if (fire) viewport.dispatchEvent(new Event('resize'));
    };
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    if (url.pathname === '/api/remote-servers') return json([]);
    if (url.pathname === '/api/tasks' && method === 'GET') return json(TASKS);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (url.pathname === '/api/tasks/terminal-activity' || url.pathname === '/api/tasks/terminal-subagents') return json({});
    const terminals = url.pathname.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (terminals && method === 'GET') return json(TERMINALS[terminals[1]] || []);
    if (url.pathname === '/api/tasks/1/agent/conversations' && method === 'GET') return json(CHATS);
    if (url.pathname === '/api/tasks/1/agent/conversations/c1') return json({ conversation: { id: 'c1' }, items: [{ id: 'u1', kind: 'user', text: 'hello agent' }], pending: [], status: 'idle', seq: 0 });
    if (url.pathname === '/api/tasks/1/agent/conversations/c1/events') return route.fulfill({ contentType: 'text/event-stream', body: ': ok\n\n' });
    if (url.pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    if (url.pathname === '/api/oss/config') return json({ enabled: false });
    if (url.pathname === '/api/system/check-update' || url.pathname === '/api/system/update-status') return json({ status: 'up_to_date', local_version: '1.0.0' });
    return json({ error: 'not mocked' }, 404);
  });
  if (chat) {
    await page.goto(`${ORIGIN}/h5?openChat=1:c1`);
    await page.locator('#h5-agent .agent-chat').waitFor();
    return { context, page };
  }
  await page.goto(`${ORIGIN}/h5`);
  await page.locator('#h5-tasks').waitFor({ state: 'visible' });
  await page.locator('.h5-task-item', { hasText: 'Fix login' }).click();
  await page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main', { hasText: 'Terminal 1' }).click();
  await page.waitForFunction(() => window.sockets.length > 0 && window.sockets.at(-1).readyState === 1 && document.querySelector('.h5-xterm:not([hidden]) .xterm-rows'));
  await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => window.sockets.at(-1).sent.some(item => item.includes('"resize"')));
  await page.waitForTimeout(1200); // closing the task sheet moved the focus: the page's follow-up measurements are over
  return { context, page };
}

const measure = page => page.evaluate(() => {
  const rect = selector => { const box = document.querySelector(selector).getBoundingClientRect(); return { top: Math.round(box.top), bottom: Math.round(box.bottom), height: Math.round(box.height) }; };
  const el = document.querySelector('.h5-xterm:not([hidden])');
  const resizes = window.sockets.at(-1).sent.map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(item => item && item.type === 'resize');
  return {
    pageHeight: document.documentElement.style.getPropertyValue('--h5-height'),
    app: rect('.h5-app'), header: rect('.h5-header'), terminal: rect('.h5-terminal'), keys: rect('#h5-bottom'),
    pinnedHeight: el.style.height, shift: el.style.transform, screen: Math.round(el.querySelector('.xterm-screen').getBoundingClientRect().height),
    resizes: resizes.length, lastResize: resizes.at(-1) || null, rowsSent: resizes.map(item => item.rows),
    focused: document.activeElement === document.getElementById('h5-translate-input'),
  };
});
const settle = (page, ms = 300) => page.waitForTimeout(ms);
const setReadings = (page, readings, fire = true) => page.evaluate(([r, f]) => window.setReadings(r, f), [readings, fire]);
const describe = (name, state) => console.log(`  ${name}: page ${state.app.height}, terminal ${state.terminal.height}, header bottom ${state.header.bottom}, keys ${state.keys.top}-${state.keys.bottom}, last resize ${JSON.stringify(state.lastResize)}, ${state.resizes} sent`);
// What a healthy full-height page looks like.
function fullPage(state, what) {
  check(near(state.app.height, HEIGHT), `${what}: the page is full height (${state.app.height})`);
  check(state.terminal.height > 400, `${what}: the terminal box is usable (${state.terminal.height})`);
  check(near(state.keys.bottom, HEIGHT), `${what}: the keys sit at the bottom (${state.keys.bottom})`);
  if (!state.focused) check(state.keys.top >= state.terminal.bottom - 1, `${what}: the keys are under the terminal`); // a focused draft bar grows over the terminal
  check(state.keys.top > state.header.bottom + 100, `${what}: the keys are not right under the header (${state.keys.top}, header ${state.header.bottom})`);
  check(state.pinnedHeight === '', `${what}: the terminal is not pinned`);
}
const noTinyResize = (state, what) => check(state.rowsSent.every(rows => rows >= 3), `${what}: no PTY resize to a tiny size (rows sent: ${state.rowsSent.join(', ')})`);

async function runCase(browser, name, options, body) {
  currentCase = name;
  console.log(name);
  const { context, page } = await openPage(browser, options);
  try { await body(page); } catch (error) { check(false, `threw ${error.message}`); } finally { await context.close(); }
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await runCase(browser, 'small reading with nothing focused', {}, async page => {
      const before = await measure(page);
      describe('before', before);
      fullPage(before, 'at start');
      // Chromium has no safe areas here, so the header and the keys take 155px together; on the iPhone the same two boxes come to about 195 to 228px with the safe areas.
      for (const reading of [before.header.height + before.keys.height, 200]) {
        await setReadings(page, { visual: reading });
        await settle(page);
        const state = await measure(page);
        describe(`small reading ${reading}`, state);
        fullPage(state, `small reading ${reading}`);
        check(state.resizes === before.resizes, `small reading ${reading}: no PTY resize (${before.resizes} to ${state.resizes})`);
        check(state.screen > 400, `small reading ${reading}: the terminal is drawn (${state.screen})`);
      }
    });

    await runCase(browser, 'a small reading together with a change of width, corrected late with no event', {}, async page => {
      // The width change clears the remembered full height, so on the old code this reading looked like a full height: nothing measured again and the page stayed short.
      await setReadings(page, { visual: 200 }, false);
      await page.setViewportSize({ width: WIDTH + 40, height: HEIGHT });
      await settle(page);
      const wrong = await measure(page);
      describe('small reading, new width', wrong);
      fullPage(wrong, 'small reading, new width');
      await setReadings(page, {}, false);
      await settle(page, 1500);
      const state = await measure(page);
      describe('reading corrected', state);
      fullPage(state, 'reading corrected');
    });

    await runCase(browser, 'a small reading that leaves the terminal box a few pixels', {}, async page => {
      const before = await measure(page);
      const reading = before.header.height + before.keys.height + 30;
      await setReadings(page, { visual: reading });
      await settle(page);
      const state = await measure(page);
      describe(`reading ${reading}`, state);
      noTinyResize(state, 'small reading');
      fullPage(state, 'small reading');
    });

    await runCase(browser, 'the terminal keyboard textarea and other fields that raise no keyboard', {}, async page => {
      const inputs = [
        ['the xterm textarea', () => document.querySelector('.xterm-helper-textarea').focus()],
        ['a checkbox', () => { const el = document.body.appendChild(Object.assign(document.createElement('input'), { type: 'checkbox' })); el.focus(); }],
        ['a read-only field', () => { const el = document.body.appendChild(Object.assign(document.createElement('input'), { readOnly: true })); el.focus(); }],
      ];
      for (const [name, focus] of inputs) {
        await page.evaluate(focus);
        await setReadings(page, { visual: 200 });
        await settle(page);
        fullPage(await measure(page), `small reading while ${name} has focus`);
        await setReadings(page, {});
        await settle(page, 100);
      }
    });

    await runCase(browser, 'a wrong height from both readings recovers without a resize event', {}, async page => {
      const before = await measure(page);
      for (const event of ['visibilitychange', 'pageshow', 'orientationchange', 'focusout']) {
        await setReadings(page, { visual: 300, inner: 300 });
        await settle(page);
        const small = await measure(page);
        check(near(small.app.height, 300), `${event}: both readings small: the page follows (${small.app.height})`);
        // The event, then the correct reading some time later and no resize event at all.
        await page.evaluate(name => {
          const target = name === 'pageshow' || name === 'orientationchange' ? window : document;
          target.dispatchEvent(new Event(name, { bubbles: true }));
          setTimeout(() => window.setReadings({}, false), 300);
        }, event);
        await settle(page, 1300);
        const state = await measure(page);
        describe(`after ${event}`, state);
        fullPage(state, `after ${event}`);
        check(state.lastResize.rows === before.lastResize.rows, `after ${event}: the terminal is back at its full size (${state.lastResize.rows} rows, was ${before.lastResize.rows})`);
      }
    });

    await runCase(browser, 'repeated events do not stack timers', {}, async page => {
      const count = async times => {
        await settle(page, 1300);
        const start = await page.evaluate(() => window.heightReads);
        await page.evaluate(n => { for (let i = 0; i < n; i += 1) window.dispatchEvent(new Event('orientationchange')); }, times);
        await settle(page, 1300);
        return (await page.evaluate(() => window.heightReads)) - start;
      };
      const once = await count(1);
      const many = await count(8);
      check(once > 0, 'one event measures again');
      check(many <= once + 2, `eight events measure as often as one (${once} and ${many} readings)`);
    });

    await runCase(browser, 'the draft box with the on-screen keyboard', {}, async page => {
      const before = await measure(page);
      await page.locator('#h5-translate-input').focus();
      await settle(page, 150);
      await setReadings(page, { visual: 500 });
      await settle(page);
      const open = await measure(page);
      describe('keyboard open', open);
      check(open.focused, 'the box keeps the focus');
      check(near(open.app.height, 500), `the page follows the keyboard (${open.app.height})`);
      check(near(open.keys.bottom, 500), `the keys are pushed up (${open.keys.bottom})`);
      check(open.pinnedHeight === `${before.terminal.height - 6}px`, `the terminal stays pinned at its closed height (${open.pinnedHeight}, box was ${before.terminal.height})`);
      check(open.shift !== '', 'the terminal is shifted up');
      check(open.resizes === before.resizes, `no PTY resize when the keyboard opens (${before.resizes} to ${open.resizes})`);
      await setReadings(page, {});
      await settle(page);
      const closed = await measure(page);
      describe('keyboard closed', closed);
      fullPage(closed, 'keyboard closed');
      check(closed.resizes === before.resizes, `no PTY resize when the keyboard closes (${before.resizes} to ${closed.resizes})`);
      check(!closed.focused, 'the draft box returns to rest when the keyboard goes away');
    });

    await runCase(browser, 'a bad reading leaves the keyboard detection right', {}, async page => {
      const before = await measure(page);
      await setReadings(page, { visual: 200 });
      await settle(page);
      await setReadings(page, {});
      await settle(page);
      // Focus with no keyboard (a hardware keyboard): nothing is open.
      await page.locator('#h5-translate-input').focus();
      await settle(page);
      const noKeyboard = await measure(page);
      fullPage(noKeyboard, 'focus without a keyboard after a bad reading');
      await setReadings(page, { visual: 480 });
      await settle(page);
      const open = await measure(page);
      check(near(open.app.height, 480), `the keyboard still pushes the keys up (${open.app.height})`);
      check(open.pinnedHeight === `${before.terminal.height - 6}px`, `the terminal is pinned at its real height (${open.pinnedHeight})`);
      await setReadings(page, {});
      await settle(page);
      fullPage(await measure(page), 'after the keyboard');
    });

    await runCase(browser, 'a real shrink of the window is followed', {}, async page => {
      const before = await measure(page);
      await page.setViewportSize({ width: WIDTH, height: 500 });
      await settle(page);
      const small = await measure(page);
      describe('window 500', small);
      check(near(small.app.height, 500), `the page follows the window (${small.app.height})`);
      check(small.pinnedHeight === '', 'the terminal is not pinned');
      check(small.lastResize.rows < before.lastResize.rows && small.lastResize.rows >= 3, `the PTY gets the smaller size (${before.lastResize.rows} to ${small.lastResize.rows})`);
      // The keyboard detection starts from the new height: focus alone opens nothing.
      await page.locator('#h5-translate-input').focus();
      await settle(page);
      check((await measure(page)).pinnedHeight === '', 'focus in the shorter window pins nothing');
      await page.locator('#h5-translate-input').blur();
      await page.setViewportSize({ width: WIDTH, height: HEIGHT });
      await settle(page);
      const full = await measure(page);
      fullPage(full, 'window back');
      check(full.lastResize.rows === before.lastResize.rows, `the PTY gets the full size again (${full.lastResize.rows})`);
    });

    await runCase(browser, 'the keyboard goes down after the blur with the window still short (Android)', {}, async page => {
      const before = await measure(page);
      await page.locator('#h5-translate-input').focus();
      await settle(page, 150);
      await page.setViewportSize({ width: WIDTH, height: 500 });
      await settle(page);
      const open = await measure(page);
      check(open.pinnedHeight !== '', 'the terminal is pinned with the keyboard open');
      await page.locator('#h5-translate-input').blur();
      await settle(page, 200); // the keyboard is still going down
      const closing = await measure(page);
      check(closing.pinnedHeight !== '', 'the terminal stays pinned while the keyboard goes down');
      check(closing.resizes === before.resizes, `no PTY resize while the keyboard goes down (${before.resizes} to ${closing.resizes})`);
      await page.setViewportSize({ width: WIDTH, height: HEIGHT });
      await settle(page);
      const closed = await measure(page);
      fullPage(closed, 'keyboard gone');
      check(closed.resizes === before.resizes, `no PTY resize after the keyboard went down (${before.resizes} to ${closed.resizes})`);
    });

    await runCase(browser, 'a collapsed box sends no tiny size, and the size is right after recovery', {}, async page => {
      const before = await measure(page);
      const collapse = height => page.evaluate(value => document.documentElement.style.setProperty('--h5-height', `${value}px`), height);
      for (const room of [0, 20, 40]) {
        await collapse(before.header.height + before.keys.height + room);
        await settle(page);
        const state = await measure(page);
        describe(`terminal box ${room}`, state);
        check(near(state.terminal.height, room, 3), `the box really is ${room}px (${state.terminal.height})`);
        check(state.resizes === before.resizes, `box of ${room}px: no PTY resize (rows sent: ${state.rowsSent.join(', ')})`);
      }
      // The terminal connects again while the box is collapsed: no size now, and the right one afterwards.
      await collapse(before.header.height + before.keys.height + 20);
      await settle(page, 100);
      await page.evaluate(() => window.sockets.at(-1).onopen());
      await settle(page, 100);
      check((await measure(page)).resizes === before.resizes, 'connecting while collapsed sends no size');
      await setReadings(page, {});
      await settle(page);
      const after = await measure(page);
      describe('recovered', after);
      fullPage(after, 'recovered');
      check(after.resizes === before.resizes + 1 && after.lastResize.rows === before.lastResize.rows && after.lastResize.cols === before.lastResize.cols, `the full size is sent once after recovery (${after.rowsSent.join(', ')})`);
      check(after.screen > 400, `the terminal is drawn at its full size (${after.screen})`);
    });

    await runCase(browser, 'the chat view on a small reading', { chat: true }, async page => {
      await setReadings(page, { visual: 200 });
      await settle(page);
      const box = await page.evaluate(() => { const rect = document.getElementById('h5-agent').getBoundingClientRect(); return { bottom: Math.round(rect.bottom), height: Math.round(rect.height) }; });
      console.log(`  chat view: bottom ${box.bottom}, height ${box.height}`);
      check(near(box.bottom, HEIGHT), `the chat reaches the bottom of the screen (${box.bottom})`);
      check(box.height > 500, `the chat keeps its height (${box.height})`);
    });

    assert.deepEqual(pageErrors, [], 'no page errors');
    if (failures.length) {
      console.error(`\n${failures.length} check(s) failed:\n${failures.map(line => ` - ${line}`).join('\n')}`);
      process.exitCode = 1;
    } else {
      console.log('h5 viewport collapse: all checks passed');
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
