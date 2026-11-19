// Links opened by programs in the terminal, on the real page in Chromium (docs/design/open-links.md, h5.js "Links opened by programs",
// Terminal.jsx OpenLinkBar, public/js/open-link.js). The server's `open-link` control message on the shown terminal:
// - computer (1440 x 900) and phone (390 x 844): the page answers `open-link-result` shown: true and shows the link bar with the program's
//   name and the link; Open calls window.open (stubbed) inside the click's user activation; Copy copies; Dismiss and Escape close it; several
//   links queue behind "+N"; a hidden (warm) terminal answers shown: false and shows nothing, and the links of a terminal that is hidden go;
// - the Mac app (a stub `tagentOpen` handler): opened at once through the handler, no bar;
// - a Home Screen app (stubbed navigator / matchMedia): Open builds `x-safari-https://` on an iPhone and an `intent://` URL on Android;
// - a tap / click on an OSC 8 link in the terminal opens through the same function.
// H5_SHOT_DIR=<dir> saves screenshots of the bar.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'https://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR;
const URL_A = 'https://preview.example.dev/pr/42';
const URL_B = 'https://code.claude.com/docs/en/hooks';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

async function openPage(browser, touch, { userAgent, init } = {}) {
  const viewport = touch ? { width: 390, height: 844 } : { width: 1440, height: 900 };
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...(userAgent ? { userAgent } : {}), ...(SHOTS ? { deviceScaleFactor: touch ? 3 : 2 } : {}) });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.sockets = [];
    window.FakeSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
      emit(data) { this.onmessage?.({ data }); }
      control(message) { this.emit(new TextEncoder().encode(JSON.stringify(message)).buffer); } // a binary control frame (proto=2)
      results() { return this.sent.filter(text => text.includes('open-link-result')).map(text => JSON.parse(text)); }
    };
    window.FakeSocket.OPEN = 1;
    window.FakeSocket.CONNECTING = 0;
    window.WebSocket = window.FakeSocket;
    // window.open records its arguments and whether the call came with a user activation (inside a click).
    window.opened = [];
    window.open = (...args) => { window.opened.push({ args, active: navigator.userActivation ? navigator.userActivation.isActive : null }); return null; };
    window.confirm = () => true;
  });
  if (init) await page.addInitScript(init);
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    if (url.pathname === '/api/remote-servers') return json([]);
    if (url.pathname === '/api/tasks' && route.request().method() === 'GET') return json([{ id: 1, title: 'Fix login redirect loop', status: 'doing', work_dir: '/work/fix-login' }]);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (url.pathname === '/api/tasks/1/terminals') return json([{ terminal_id: 'claude-1', title: 'Claude: login fix', agent: 'claude' }, { terminal_id: 'shell-2', title: 'Terminal 2' }]);
    if (url.pathname === '/api/tasks/1/agent/conversations') return json([]);
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  const how = touch ? 'tap' : 'click';
  if (!touch && !(await page.locator('.h5-task-item', { hasText: 'Fix login' }).isVisible())) await page.locator('#h5-open-tasks')[how]();
  await page.locator('.h5-task-item', { hasText: 'Fix login' })[how]();
  await page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login redirect loop"] .h5-terminal-main').first()[how]();
  await page.waitForFunction(() => window.sockets.length === 1 && window.sockets[0].readyState === 1);
  await page.evaluate(() => window.sockets[0].control({ type: 'history', data: '$ ', cols: 80, rows: 24 }));
  await page.evaluate(() => window.sockets[0].emit('\x1b[1;31m*\x1b[0m \x1b[1mClaude Code\x1b[0m v2.1  /work/fix-login\r\n\r\n● The preview is running:\r\n  https://preview.example.dev/pr/42\r\n\r\n$ '));
  await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-rows')?.textContent.includes('preview'));
  await page.waitForTimeout(400); // the replay pause ends
  await page.evaluate(() => {
    window.notices = [];
    const real = window.notify;
    window.notify = (message, type) => { window.notices.push([message, type]); return real(message, type); };
  });
  return { page, context, errors, how };
}

const offer = (page, url, agent = 'claude', socket = 0, id = `l${Math.random().toString(36).slice(2)}`) => page.evaluate(([value, kind, index, key]) => {
  window.sockets[index].control({ type: 'open-link', id: key, url: value, agent: kind });
  return key;
}, [url, agent, socket, id]);
const results = (page, socket = 0) => page.evaluate(index => window.sockets[index].results(), socket);

async function run(browser, touch) {
  const mode = touch ? 'phone' : 'computer';
  const { page, context, errors, how } = await openPage(browser, touch);
  const bar = page.locator('#h5-open-link-bar');

  // 1. A link on the shown terminal: answered at once, the bar shows the program and the link.
  const first = await offer(page, URL_A);
  await bar.waitFor();
  assert.deepEqual(await results(page), [{ type: 'open-link-result', id: first, shown: true }], `${mode}: the page takes the link`);
  assert.equal(await page.locator('#h5-open-link-title').textContent(), 'Claude wants to open a link');
  assert.equal(await page.locator('#h5-open-link-url').textContent(), URL_A);
  await page.evaluate(() => Promise.all(document.querySelector('#h5-open-link-bar').getAnimations({ subtree: true })
    .filter(animation => animation.animationName !== 'h5-clipboard-timer').map(animation => animation.finished))); // measured at rest
  const look = await page.evaluate(() => {
    const node = document.querySelector('#h5-open-link-bar');
    const style = getComputedStyle(node);
    const open = getComputedStyle(document.querySelector('#h5-open-link-open'));
    const box = node.getBoundingClientRect();
    const terminal = document.querySelector('#h5-terminal').getBoundingClientRect();
    const sizes = ['#h5-open-link-copy', '#h5-open-link-dismiss', '#h5-open-link-open'].map(id => document.querySelector(id).getBoundingClientRect()).map(b => [b.width, b.height]);
    return { bg: style.backgroundColor, color: style.color, openBg: open.backgroundColor, font: getComputedStyle(document.querySelector('#h5-open-link-url')).fontFamily,
      inside: box.top >= terminal.top && box.left >= terminal.left && box.right <= terminal.right, sizes, labels: [...node.querySelectorAll('button')].map(b => b.textContent),
      role: node.getAttribute('role'), label: node.getAttribute('aria-label'), icon: Boolean(node.querySelector('.h5-clipboard-icon svg')) };
  });
  assert.equal(look.bg, 'rgb(21, 101, 192)', `${mode}: the notice blue ${JSON.stringify(look)}`);
  assert.equal(look.openBg, 'rgb(255, 255, 255)', `${mode}: Open is the white filled button`);
  assert.match(look.font, /monospace|Menlo/);
  assert.deepEqual(look.labels, ['Copy', 'Dismiss', 'Open']);
  assert.ok(look.inside && look.icon && look.role === 'toolbar' && look.label === 'Open a link from the terminal', JSON.stringify(look));
  if (touch) assert.ok(look.sizes.every(([w, h]) => w >= 44 && h >= 44), `${mode}: 44px targets ${JSON.stringify(look.sizes)}`);
  if (SHOTS) {
    await page.waitForTimeout(1300); // the slide-in and the pulse are over
    await page.screenshot({ path: path.join(SHOTS, `open-link-bar-${mode}.png`) });
  }

  // 2. Open: window.open inside the click (user activation), a new tab without opener; the bar goes.
  await page.locator('#h5-open-link-open')[how]();
  await bar.waitFor({ state: 'hidden' });
  const opened = await page.evaluate(() => window.opened.splice(0));
  assert.deepEqual(opened, [{ args: [URL_A, '_blank', 'noopener,noreferrer'], active: true }], `${mode}: Open opens inside the click`);

  // 3. Copy copies the link; Dismiss closes without opening.
  await offer(page, URL_B, 'codex');
  await bar.waitFor();
  assert.equal(await page.locator('#h5-open-link-title').textContent(), 'Codex wants to open a link');
  await page.locator('#h5-open-link-copy')[how]();
  await bar.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), URL_B, `${mode}: Copy copies the link`);
  await page.waitForFunction(() => window.notices.some(([message, type]) => message === 'Link copied' && type === 'success'));
  await offer(page, URL_A, null);
  await bar.waitFor();
  assert.equal(await page.locator('#h5-open-link-title').textContent(), 'A program wants to open a link');
  await page.locator('#h5-open-link-dismiss')[how]();
  await bar.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.opened.length), 0, `${mode}: Dismiss opens nothing`);

  // 4. Several links queue: "+1", the next one after Dismiss; Escape inside the bar closes it.
  await offer(page, URL_A);
  await offer(page, URL_B);
  await bar.waitFor();
  assert.equal(await page.locator('#h5-open-link-title').textContent(), 'Claude wants to open a link +1');
  assert.equal(await page.locator('#h5-open-link-url').textContent(), URL_A);
  if (SHOTS) { await page.waitForTimeout(1300); await page.screenshot({ path: path.join(SHOTS, `open-link-bar-${mode}-queue.png`) }); }
  await page.locator('#h5-open-link-dismiss')[how]();
  await page.waitForFunction(url => document.querySelector('#h5-open-link-url')?.textContent === url, URL_B);
  await page.locator('#h5-open-link-open').focus();
  await page.keyboard.press('Escape');
  await bar.waitFor({ state: 'hidden' });

  // 5. Another terminal is shown: the first one is a hidden warm terminal; its links are refused (the engine opens them) and its waiting links go.
  await offer(page, URL_A);
  await bar.waitFor();
  if (!(await page.locator('#h5-tasks').isVisible())) await page.locator('#h5-open-tasks')[how]();
  const second = page.locator('#h5-tasks .h5-terminal-main', { hasText: 'Terminal 2' });
  await second.waitFor();
  await second.evaluate(el => el.click());
  await page.waitForFunction(() => window.sockets.length === 2 && window.sockets[1].readyState === 1);
  await bar.waitFor({ state: 'hidden' });
  const hiddenId = await offer(page, URL_B, 'claude', 0);
  await page.waitForFunction(id => window.sockets[0].results().some(result => result.id === id), hiddenId);
  assert.deepEqual((await results(page, 0)).find(result => result.id === hiddenId), { type: 'open-link-result', id: hiddenId, shown: false }, `${mode}: a hidden terminal does not act`);
  assert.equal(await bar.count(), 0);
  assert.deepEqual(errors, [], `${mode}: no page errors`);
  await context.close();
}

// The Mac app: the handler opens at once, no bar.
async function macApp(browser) {
  const { page, context, errors } = await openPage(browser, false, { init: () => { window.appOpened = []; window.webkit = { messageHandlers: { tagentOpen: { postMessage: value => window.appOpened.push(value) } } }; } });
  const id = await offer(page, URL_A);
  await page.waitForFunction(() => window.appOpened.length === 1);
  assert.deepEqual(await page.evaluate(() => window.appOpened), [URL_A]);
  assert.deepEqual(await results(page), [{ type: 'open-link-result', id, shown: true }]);
  assert.equal(await page.locator('#h5-open-link-bar').count(), 0, 'Mac app: no bar');
  // A click on an OSC 8 link in the terminal goes through the same handler.
  await page.evaluate(() => window.sockets[0].emit('\r\n\x1b]8;;https://example.com/osc8\x07OSC8LINK\x1b]8;;\x07\r\n$ '));
  await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-rows')?.textContent.includes('OSC8LINK'));
  const point = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.h5-xterm:not([hidden]) .xterm-rows > div')].find(item => item.textContent.includes('OSC8LINK'));
    const box = row.getBoundingClientRect();
    const cell = box.width / 80;
    return { x: box.left + cell * 3, y: box.top + box.height / 2 };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.move(point.x + 2, point.y);
  await page.waitForTimeout(200);
  await page.mouse.click(point.x + 2, point.y);
  await page.waitForFunction(() => window.appOpened.length === 2);
  assert.equal(await page.evaluate(() => window.appOpened[1]), 'https://example.com/osc8');
  assert.deepEqual(errors, []);
  await context.close();
}

// A Home Screen app: the bar's Open builds the platform's URL (OpenLink.open is wrapped to record what it would open).
async function standalone(browser, userAgent, expected) {
  const init = () => {
    Object.defineProperty(navigator, 'standalone', { get: () => /iPhone/.test(navigator.userAgent) });
    const real = window.matchMedia.bind(window);
    window.matchMedia = query => (query === '(display-mode: standalone)' ? { matches: true, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : real(query));
  };
  const { page, context, errors, how } = await openPage(browser, true, { userAgent, init });
  await page.evaluate(() => {
    window.targets = [];
    OpenLink.open = url => { window.targets.push({ ...OpenLink.target(url, OpenLink.environment()), active: navigator.userActivation.isActive }); return true; };
  });
  await offer(page, URL_A);
  await page.locator('#h5-open-link-bar').waitFor();
  await page.locator('#h5-open-link-open')[how]();
  await page.waitForFunction(() => window.targets.length === 1);
  assert.deepEqual(await page.evaluate(() => window.targets[0]), { ...expected, active: true }, userAgent);
  assert.deepEqual(errors, []);
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await run(browser, false);
    await run(browser, true);
    await macApp(browser);
    await standalone(browser, IPHONE, { how: 'location', href: `x-safari-${URL_A}` });
    await standalone(browser, ANDROID, { how: 'window', href: `intent://preview.example.dev/pr/42#Intent;scheme=https;S.browser_fallback_url=${encodeURIComponent(URL_A)};end` });
    console.log('PASS: links from programs on the computer (1440 px) and the phone (390 px): the bar with the program and the link, Open inside the click, Copy, Dismiss, Escape, the queue, hidden terminals refuse; the Mac app opens through its handler (also OSC 8 links); Home Screen apps open x-safari-https (iPhone) and intent:// (Android).');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
