// Browser test of "Plan usage" in the session header ("Plan usage: the page" in docs/design/plan-usage-page.md), with the server stubbed by routes
// (`GET /api/agent-usage`, `POST /api/agent-usage/refresh`, a linked engine K01 with 'agent-usage:read' through `/api/remote-servers/7/…`) and the
// page's clock faked (Playwright `page.clock`), so the polls are seen without waiting.
// 1440x900 (pointer): `#h5-usage` before More with 8 bars and its label, the low number ("7d 8%"); a click opens the popover with the rows, the reset
// times, the pace line and the lines of K01; Escape closes it; Refresh posts; the GET every 5 minutes, every 60 s while a Claude or Codex session of
// the shown engine runs, about 10 s after it stops (at most one in 30 s), at once when the page is shown again after more than 60 s; the states not
// read yet, not signed in, offline (dimmed) and no answer (hidden).
// 390x844 touch: the bars without the number, stacked (Claude's row above Codex's, bars of 3 x 14px) in one 48px button with a 44px target; one agent:
// one centred row (outlined while not read); the bottom sheet with the rows, closed by back.
// SHOTS=<folder> saves screenshots.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const T01_ID = '6c1d1c1e-0000-4000-8000-0000000000a1';
const K01_ID = '9f2b7a33-0000-4000-8000-0000000000b2';
const STREAM = '/api/tasks/terminal-activity/stream';
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = new Date(2026, 10, 18, 15, 20, 0).getTime();
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// The answers, made with the page's clock at the time of each request.
const windows = (now, five, seven) => [
  { id: '5h', label: '5h', usedPercent: five[0], resetsAt: now + five[1] },
  { id: '7d', label: '7d', usedPercent: seven[0], resetsAt: now + seven[1] },
];
const ANSWERS = {
  ok: now => ({ engine: { instance_id: T01_ID, name: 'T01' }, agents: [
    { agent: 'claude', state: 'ok', account: 'aaaaaaaaaaaa', read_at: now - 2 * MIN, windows: windows(now, [30, 3 * HOUR + 10 * MIN + 30000], [19, 4 * DAY]) },
    { agent: 'codex', state: 'ok', account: 'cccccccccccc', read_at: now - 2 * MIN, windows: windows(now, [76, 3 * HOUR + 30 * MIN], [92, 2 * DAY + 19 * HOUR]) },
  ] }),
  states: now => ({ engine: { instance_id: T01_ID, name: 'T01' }, agents: [
    { agent: 'claude', state: 'not_read', account: null, read_at: null, windows: [] },
    { agent: 'codex', state: 'signed_out', account: null, read_at: now, windows: [] },
  ] }),
  k01: now => ({ engine: { instance_id: K01_ID, name: 'K01' }, agents: [
    { agent: 'claude', state: 'ok', account: 'aaaaaaaaaaaa', read_at: now - MIN, windows: windows(now, [50, HOUR], [50, DAY]) },
    { agent: 'codex', state: 'ok', account: 'dddddddddddd', read_at: now - MIN, windows: windows(now, [29, 2 * HOUR], [34, 3 * DAY]) },
  ] }),
};

async function open(browser, world, viewport) {
  const context = await browser.newContext(viewport);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() { this.readyState = 3; } };
    window.WebSocket.OPEN = 1;
    // The page's visibility, switched by the test.
    window.__visible = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__visible });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__visible !== 'visible' });
  });
  await page.addInitScript(activityStreamMock);
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const method = route.request().method();
    if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
    if (/agent-usage/.test(pathname)) {
      const now = await page.evaluate(() => Date.now());
      world.calls.push({ method, pathname, at: now });
      const which = pathname.startsWith('/api/remote-servers/7/') ? world.k01 : world.local;
      if (which === 'offline') return json(route, { error: 'REMOTE_OFFLINE' }, 502);
      if (which === 'missing') return json(route, { error: 'not mocked' }, 404);
      return json(route, ANSWERS[which](now));
    }
    if (pathname === '/api/system/version') return json(route, { app_version: '2.157.0', boot_id: 'b1', engine_name: 'T01', instance_id: T01_ID });
    if (pathname === '/api/remote-servers') return json(route, [{ id: 7, name: 'K01', status: 'online', base_url: 'tunnel://x', enabled: true, instance_id: K01_ID }]);
    if (pathname === '/api/task-order') return json(route, { order: [], updated_at: 1 });
    if (pathname === '/api/task-list/hidden-devices') return json(route, { hidden: [] });
    if (pathname === '/api/tasks') return json(route, [{ id: 1, title: 'SELF-TAGENT', status: 'doing', archived_at: null }]);
    if (pathname === '/api/remote-servers/7/tasks') return json(route, [{ id: 3, title: 'SELF-ONCALL', status: 'doing', archived_at: null }]);
    if (pathname === '/api/task-groups' || pathname === '/api/remote-servers/7/task-groups') return json(route, [{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (pathname === '/api/remote-servers/7/info') return json(route, { capabilities: ['terminal:control', 'agent-usage:read'] });
    // The activity as the stream last pushed it (a stream that the fake clock let stall is read again by GET).
    if (pathname === '/api/tasks/terminal-activity') return json(route, world.activity || {});
    if (pathname.endsWith('/terminal-activity') || pathname.endsWith('/terminal-subagents')) return json(route, {});
    if (/\/terminals$/.test(pathname)) return json(route, []);
    return json(route, { error: 'not mocked' }, 404);
  });
  await page.clock.install({ time: START }); // time runs normally from START; the polls are jumped over with fastForward
  await page.goto(`${ORIGIN}/h5`);
  await page.locator('#h5-usage').waitFor();
  return { context, page, errors };
}

const gets = (world, pathname = '/api/agent-usage') => world.calls.filter(call => call.method === 'GET' && call.pathname === pathname).length;
const waitGets = (page, world, count, pathname) => page.waitForFunction(() => true).then(async () => {
  const until = Date.now() + 3000;
  while (gets(world, pathname) < count && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(gets(world, pathname), count, `${pathname || '/api/agent-usage'}: ${count} GETs`);
});
const settle = page => page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity));
const quiet = () => new Promise(resolve => setTimeout(resolve, 300));
const setVisible = (page, value) => page.evaluate(state => { window.__visible = state; document.dispatchEvent(new Event('visibilitychange')); }, value);

async function computer(browser) {
  const world = { local: 'ok', k01: 'k01', calls: [] };
  const { context, page, errors } = await open(browser, world, { viewport: { width: 1440, height: 900 } });
  const button = page.locator('#h5-usage');
  // The button: in the header, right before More, with 8 bars, two marks and its label; the low 7-day plan of Codex with its number.
  assert.equal(await page.evaluate(() => document.getElementById('h5-usage').nextElementSibling.id), 'h5-header-more');
  assert.equal(await button.locator('.h5-usage-bar').count(), 8);
  assert.deepEqual(await button.locator('.h5-usage-agent').evaluateAll(nodes => nodes.map(node => node.dataset.agent)), ['claude', 'codex']);
  const label = 'Plan usage: Claude 5 hours 70% left, 7 days 81% left; Codex 5 hours 24% left, 7 days 8% left';
  assert.equal(await button.getAttribute('aria-label'), label);
  assert.equal(await button.getAttribute('title'), label);
  assert.equal(await button.locator('.h5-usage-low').textContent(), '7d 8%');
  assert.equal(await button.locator('.h5-usage-bar[data-low="true"]').count(), 1);
  const sizes = await button.locator('.h5-usage-bar').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return [box.width, box.height]; }));
  assert.ok(sizes.every(([width, height]) => width === 4 && height === 20), JSON.stringify(sizes));
  const plan = await button.locator('.h5-usage-bar.plan[data-window="5h"]').first().locator('.h5-usage-fill').evaluate(node => node.style.height || getComputedStyle(node).height);
  assert.ok(/70%|14px/.test(plan), plan);
  assert.equal(gets(world), 1, 'one GET at the start');

  // The details: a popover with the rows, the reset times, the pace line and the other engine's lines.
  await button.click();
  const details = page.locator('#h5-usage-details');
  await details.waitFor();
  await settle(page);
  assert.equal(await details.getAttribute('data-layout'), 'popover');
  assert.equal(await details.getAttribute('role'), 'dialog');
  assert.equal(await page.locator('#h5-usage-title').textContent(), 'Plan usage');
  assert.equal(await page.locator('#h5-usage-read').textContent(), 'T01 · read 2 min ago');
  assert.equal(await details.locator('.h5-usage-row').count(), 4);
  assert.deepEqual(await details.locator('.h5-usage-left').allTextContents(), ['70% left', '81% left', '24% left', '8% left']);
  const resets = await details.locator('.h5-usage-reset').allTextContents();
  assert.match(resets[0], /^resets in 3 h 1\d min · 18:3\d$/);
  assert.match(resets[1], /^resets Sun 15:2\d$/);
  assert.match(resets[2], /^resets in 3 h \d+ min · 18:5\d$/);
  assert.match(resets[3], /^resets Sat 10:2\d$/);
  assert.deepEqual(await details.locator('.h5-usage-pace').allTextContents(), [
    'At this pace it runs out about 3 h before the reset', 'At this pace it runs out about 2 days before the reset',
  ]);
  await waitGets(page, world, 1, '/api/remote-servers/7/agent-usage');
  await page.locator('.h5-usage-other').nth(1).waitFor();
  assert.deepEqual(await page.locator('.h5-usage-other').allTextContents(), [
    'K01 uses the same Claude account.', 'Codex on K01: another account, 5 hours 71% left, 7 days 66% left.',
  ]);
  const box = await details.boundingBox();
  const at = await button.boundingBox();
  assert.ok(box.width === 400 && box.y >= at.y + at.height && Math.abs(box.x + box.width - (at.x + at.width)) < 2, JSON.stringify({ box, at }));
  if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'plan-usage-1440.png') });

  // Refresh posts, then shows the answer.
  await page.locator('#h5-usage-refresh').click();
  await page.waitForFunction(() => document.getElementById('h5-usage-refresh') && !document.getElementById('h5-usage-refresh').dataset.busy);
  assert.equal(world.calls.filter(call => call.method === 'POST' && call.pathname === '/api/agent-usage/refresh').length, 1);
  // Escape closes it, and the focus is back on the button.
  await page.keyboard.press('Escape');
  await details.waitFor({ state: 'detached' });
  assert.equal(await button.getAttribute('aria-expanded'), 'false');

  // Polling: one GET every 5 minutes while visible.
  const before = gets(world);
  await page.clock.fastForward(5 * MIN);
  await waitGets(page, world, before + 1);
  // Hidden: none; shown again after more than 60 s: one at once; shown again within 60 s: none.
  await setVisible(page, 'hidden');
  await page.clock.fastForward(5 * MIN);
  await quiet();
  assert.equal(gets(world), before + 1, 'no GET while hidden');
  await setVisible(page, 'visible');
  await waitGets(page, world, before + 2);
  await setVisible(page, 'hidden');
  await page.clock.fastForward(20000);
  await setVisible(page, 'visible');
  await quiet();
  assert.equal(gets(world), before + 2, 'shown again within 60 s: no GET');

  // A Claude or Codex session of the shown engine runs: a GET every 60 s; it stops: one GET about 10 s later, at most one in 30 s.
  const push = async snapshot => {
    world.activity = snapshot.activity;
    await page.waitForFunction(([url, snap]) => window.activityStream.push(url, snap), [STREAM, snapshot]);
  };
  await page.clock.fastForward(MIN); // the last GET is more than 60 s old: the start of a run reads at once
  let count = gets(world);
  await push({ activity: { 1: { c1: 'running' } }, subagents: {} });
  await waitGets(page, world, count + 1);
  await page.clock.fastForward(61000);
  await waitGets(page, world, count + 2);
  await page.clock.fastForward(61000);
  await waitGets(page, world, count + 3);
  count = gets(world);
  await push({ activity: {}, subagents: {} });
  await quiet();
  assert.equal(gets(world), count, 'not at once when the turn ends');
  await page.clock.fastForward(11000);
  await waitGets(page, world, count + 1);
  // Another run that ends within 30 s: no extra GET.
  await push({ activity: { 1: { c1: 'running' } }, subagents: {} });
  await push({ activity: {}, subagents: {} });
  await page.clock.fastForward(11000);
  await quiet();
  assert.equal(gets(world), count + 1, 'one extra GET in 30 s at most');
  // None runs: back to 5 minutes.
  await page.clock.fastForward(2 * MIN);
  await quiet();
  assert.equal(gets(world), count + 1, 'no GET after 2 minutes without a run');
  await page.clock.fastForward(3 * MIN);
  await waitGets(page, world, count + 2);

  // States: not read yet (outlined bars), not signed in (left out of the bars, named in the details).
  world.local = 'states';
  await button.click();
  await details.waitFor();
  await page.locator('#h5-usage-refresh').click();
  await page.waitForFunction(() => document.querySelectorAll('#h5-usage .h5-usage-bar').length === 4);
  assert.deepEqual(await button.locator('.h5-usage-agent').evaluateAll(nodes => nodes.map(node => node.dataset.agent)), ['claude']);
  assert.equal(await button.locator('.h5-usage-fill').count(), 0, 'outlined bars, no fill');
  assert.equal(await button.getAttribute('aria-label'), 'Plan usage: Claude not read yet');
  assert.deepEqual(await details.locator('.h5-usage-message').allTextContents(), ['Not read yet', 'Codex is not signed in on T01']);
  // Offline: the last reading stays, dimmed, "T01 is offline · read …".
  world.local = 'ok';
  await page.locator('#h5-usage-refresh').click();
  await page.waitForFunction(() => document.querySelectorAll('#h5-usage .h5-usage-bar').length === 8);
  world.local = 'offline';
  await page.locator('#h5-usage-refresh').click();
  await page.waitForFunction(() => document.getElementById('h5-usage').dataset.offline === 'true');
  assert.equal(await button.locator('.h5-usage-bar').count(), 8);
  assert.equal(Number(await button.evaluate(node => getComputedStyle(node).opacity)), 0.38);
  assert.match(await page.locator('#h5-usage-read').textContent(), /^T01 is offline · read (just now|\d+ min ago)$/);
  await page.keyboard.press('Escape');
  await details.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  await context.close();
}

async function phone(browser) {
  const world = { local: 'ok', k01: 'k01', calls: [] };
  const { context, page, errors } = await open(browser, world, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const button = page.locator('#h5-usage');
  // No task is shown, so the phone opens its task drawer: closed first (Escape, as back.mjs would).
  if (await page.locator('#h5-tasks').isVisible()) {
    await page.keyboard.press('Escape');
    await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
  }
  await settle(page);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.input), 'touch');
  assert.equal(await page.evaluate(() => document.getElementById('h5-usage').nextElementSibling.id), 'h5-header-more');
  assert.equal(await button.locator('.h5-usage-bar').count(), 8);
  assert.equal(await button.locator('.h5-usage-low').count(), 0, 'the phone shows the bars only');
  assert.equal(await button.locator('.h5-usage-bar[data-low="true"]').count(), 1, 'the low bar is still in the warning colour');
  const hit = await button.boundingBox();
  assert.ok(hit.height >= 44 && hit.width === 48, JSON.stringify(hit));
  // Stacked: Claude's row above Codex's, each centred in the button; bars of 3 x 14px.
  const rows = () => button.locator('.h5-usage-agent').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { agent: node.dataset.agent, top: box.top, bottom: box.bottom, centre: box.left + box.width / 2 }; }));
  const stacked = await rows();
  assert.deepEqual(stacked.map(row => row.agent), ['claude', 'codex']);
  assert.ok(stacked[0].bottom <= stacked[1].top + 0.5, `Claude above Codex (${JSON.stringify(stacked)})`);
  for (const row of stacked) assert.ok(Math.abs(row.centre - (hit.x + hit.width / 2)) < 1.5, `${row.agent}: centred (${JSON.stringify([row, hit])})`);
  const sizes = await button.locator('.h5-usage-bar').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return [box.width, box.height]; }));
  assert.ok(sizes.every(([width, height]) => width === 3 && height === 14), JSON.stringify(sizes));
  if (process.env.SHOTS) await page.locator('.h5-header').screenshot({ path: path.join(process.env.SHOTS, 'plan-usage-header-390.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll at 390px');
  await button.tap();
  const details = page.locator('#h5-usage-details');
  await details.waitFor();
  await settle(page);
  assert.equal(await details.getAttribute('data-layout'), 'sheet');
  const sheet = await details.boundingBox();
  assert.ok(Math.abs(sheet.y + sheet.height - 844) < 2 && sheet.width === 390, JSON.stringify(sheet));
  assert.equal(await details.locator('.h5-usage-row').count(), 4);
  assert.ok((await page.locator('#h5-usage-refresh').boundingBox()).height >= 44, 'Refresh: a 44px target');
  if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'plan-usage-390.png') });
  // One agent (Codex not signed in, Claude not read yet): one centred row of outlined bars.
  world.local = 'states';
  await page.locator('#h5-usage-refresh').tap();
  await page.waitForFunction(() => document.querySelectorAll('#h5-usage .h5-usage-bar').length === 4);
  const one = await rows();
  assert.deepEqual(one.map(row => row.agent), ['claude']);
  const middle = (hit.y + hit.height / 2);
  assert.ok(Math.abs((one[0].top + one[0].bottom) / 2 - middle) < 1.5 && Math.abs(one[0].centre - (hit.x + hit.width / 2)) < 1.5, `one row, centred (${JSON.stringify([one, hit])})`);
  assert.equal(await button.locator('.h5-usage-fill').count(), 0, 'outlined, not read yet');
  assert.equal((await button.boundingBox()).width, 48, 'still 48px wide');
  // Back closes the sheet (back.mjs).
  await page.goBack();
  await details.waitFor({ state: 'detached' });
  assert.equal(page.url(), `${ORIGIN}/h5`, 'still on the page');
  assert.deepEqual(errors, []);
  await context.close();
}

async function hidden(browser) {
  // An engine without plan usage (an older server: 404): no button.
  const world = { local: 'missing', k01: 'missing', calls: [] };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.route(`${ORIGIN}/**`, route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
    if (/agent-usage/.test(pathname)) world.calls.push({ method: 'GET', pathname });
    if (pathname === '/api/remote-servers') return json(route, []);
    if (pathname === '/api/tasks') return json(route, []);
    return json(route, { error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  await page.locator('#h5-header-more').waitFor();
  const until = Date.now() + 3000;
  while (!world.calls.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
  await quiet();
  assert.equal(world.calls.length, 1);
  assert.equal(await page.locator('#h5-usage').count(), 0);
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await computer(browser);
    await phone(browser);
    await hidden(browser);
    console.log('Plan usage: the header bars, the popover and the sheet, the states, Refresh and the polls work.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
