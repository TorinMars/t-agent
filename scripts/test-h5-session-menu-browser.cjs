// The "⋯" of a session row (scripts/h5-shell/TermMenu.jsx, `SessionPopup`) in real Chromium at 390px (touch) and 1440px (mouse): a popup right under the button,
// right-aligned to it and inside the screen, turned over above the button when there is no room below (a short window, the on-screen keyboard), for a session of
// the selected task and of another task; every way it closes; the rename field keeping the focus; and the "⋯" of a task, which stays a sheet from the bottom.
// H5_SHOT_DIR=<dir> saves a screenshot of the popup at 390px there.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const pageErrors = [];
const TASKS = [{ id: 1, title: 'Alpha', status: 'doing' }, { id: 2, title: 'Beta', status: 'doing' }];
const terminals = (id, count) => Array.from({ length: count }, (_, i) => ({ terminal_id: i ? `t${id}-${i + 1}` : 'default', title: `Terminal ${i + 1}` }));
const LISTS = { 1: terminals(1, 20), 2: terminals(2, 14) }; // Beta is long, so its first row can be scrolled to the top of the list

async function openPage(browser, wide) {
  const context = await browser.newContext({ viewport: wide ? { width: 1440, height: 900 } : { width: 390, height: 844 }, ...(wide ? {} : { isMobile: true, hasTouch: true }), ...(process.env.H5_SHOT_DIR ? { deviceScaleFactor: 3 } : {}) });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.WebSocket = class {
      constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send() {}
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    // The on-screen keyboard: only the visual viewport gets shorter, as on an iPhone.
    const viewport = new EventTarget();
    let keyboard = 0;
    Object.defineProperties(viewport, { height: { get: () => window.innerHeight - keyboard }, width: { get: () => window.innerWidth }, offsetTop: { get: () => 0 }, offsetLeft: { get: () => 0 }, scale: { get: () => 1 } });
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
    window.setKeyboard = height => { keyboard = height; viewport.dispatchEvent(new Event('resize')); };
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const { pathname } = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
    if (pathname === '/api/remote-servers') return json([]);
    if (pathname === '/api/tasks') return json(TASKS);
    if (pathname === '/api/task-groups') return json([{ key: 'doing', name: 'Doing', sort_order: 1 }]);
    if (pathname === '/api/tasks/terminal-activity' || pathname === '/api/tasks/terminal-subagents') return json({});
    const list = pathname.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (list) return json(LISTS[list[1]] || []);
    if (/\/agent\/conversations$/.test(pathname)) return json([]);
    if (pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    if (pathname === '/api/oss/config') return json({ enabled: false });
    if (/\/terminal\/ack$/.test(pathname)) return json({ success: true });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  return { context, page };
}

function helpers(page, wide, label) {
  const press = locator => (wide ? locator.click() : locator.tap());
  const list = name => page.locator(`#h5-tasks .h5-terminal-list[aria-label="${name}"]`);
  const more = (name, index) => list(name).locator('.h5-terminal-row').nth(index).locator('.h5-terminal-more');
  const popup = page.locator('#h5-session-menu');
  const items = page.locator('#h5-session-menu [role="menuitem"]');
  const settled = () => page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity));
  const open = async (name, index) => { await more(name, index).scrollIntoViewIfNeeded(); await press(more(name, index)); await items.first().waitFor(); await settled(); };
  const gone = async what => popup.waitFor({ state: 'detached', timeout: 3000 }).catch(() => assert.fail(`${label}: ${what} closes the popup`));
  const boxes = (name, index) => page.evaluate(([list_, row]) => {
    const rect = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
    return {
      button: rect(document.querySelectorAll(`#h5-tasks .h5-terminal-list[aria-label="${list_}"] .h5-terminal-row`)[row].querySelector('.h5-terminal-more')),
      paper: rect(document.querySelector('.h5-session-menu-paper')),
      items: [...document.querySelectorAll('#h5-session-menu [role="menuitem"]')].map(rect),
      inner: { width: innerWidth, height: innerHeight },
    };
  }, [name, index]);
  return { press, list, more, popup, items, open, gone, boxes, settled };
}

function assertInside(g, label) {
  assert.ok(g.paper.left >= 0 && g.paper.right <= g.inner.width && g.paper.top >= 0 && g.paper.bottom <= g.inner.height, `${label}: inside the viewport ${JSON.stringify(g)}`);
}
function assertBelow(g, label) {
  assert.ok(Math.abs(g.paper.top - g.button.bottom) <= 3, `${label}: the popup's top is at the button's bottom ${JSON.stringify([g.button, g.paper])}`);
  assert.ok(Math.abs(g.paper.right - g.button.right) <= 3, `${label}: right-aligned to the button ${JSON.stringify([g.button, g.paper])}`);
  assertInside(g, label);
}
function assertAbove(g, label) {
  assert.ok(Math.abs(g.paper.bottom - g.button.top) <= 3, `${label}: the popup is turned over, its bottom at the button's top ${JSON.stringify([g.button, g.paper])}`);
  assert.ok(Math.abs(g.paper.right - g.button.right) <= 3, `${label}: right-aligned to the button ${JSON.stringify([g.button, g.paper])}`);
  assertInside(g, label);
}

async function setup(page, h, wide) {
  if (!wide) await page.locator('#h5-tasks').waitFor({ state: 'visible' });
  await h.press(page.locator('.h5-task-item', { hasText: 'Alpha' }));
  await h.press(h.list('Alpha').locator('.h5-terminal-main').first());
  await page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'Alpha');
  if (!wide) { await page.locator('#h5-tasks').waitFor({ state: 'hidden' }); await page.locator('#h5-open-tasks').tap(); await page.locator('#h5-tasks').waitFor({ state: 'visible' }); }
  await h.list('Phone terminals').locator('.h5-terminal-row').nth(19).waitFor();
  await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity));
}

async function run(browser, wide) {
  const label = wide ? 'PC 1440px' : 'phone 390px';
  const { context, page } = await openPage(browser, wide);
  const h = helpers(page, wide, label);
  await setup(page, h, wide);
  const SELECTED = 'Phone terminals';

  // ── Under the button: the selected task, then a task that is not selected ──
  await h.open(SELECTED, 1);
  assertBelow(await h.boxes(SELECTED, 1), `${label} selected task`);
  assert.deepEqual(await h.items.allTextContents(), ['Rename', 'Reopen', 'Restart in the working directory', 'Delete'], `${label}: the actions`);
  assert.deepEqual(await h.items.evaluateAll(nodes => nodes.map(node => node.classList.contains('danger'))), [false, false, true, true], `${label}: the danger style`);
  assert.equal(await page.locator('#h5-session-menu-actions').getAttribute('aria-label'), 'Terminal 2', `${label}: the list is named after the session`);
  assert.equal(await page.locator('#h5-term-menu .h5-menu-panel').count(), 0, `${label}: no sheet from the bottom`);
  if (!wide) for (const item of (await h.boxes(SELECTED, 1)).items) assert.ok(item.height >= 44, `${label}: a 44px item (${item.height})`);
  if (!wide && process.env.H5_SHOT_DIR) await page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, 'session-menu-390.png') });
  await page.keyboard.press('Escape');
  await h.gone('Escape');

  await page.evaluate(() => { document.getElementById('h5-task-list').scrollTop = 1e6; });
  await h.press(page.locator('.h5-task-item', { hasText: 'Beta' }));
  await h.list('Beta').locator('.h5-terminal-row').nth(13).waitFor();
  await h.more('Beta', 0).evaluate(node => node.scrollIntoView({ block: 'start' }));
  await h.open('Beta', 0);
  assertBelow(await h.boxes('Beta', 0), `${label} other task`);
  assert.deepEqual(await h.items.allTextContents(), ['Rename', 'Open', 'Restart in the working directory', 'Delete'], `${label}: the actions of another task`);
  await page.keyboard.press('Escape');
  await h.gone('Escape');
  await h.press(page.locator('.h5-task-item', { hasText: 'Beta' }));
  await h.list('Beta').waitFor({ state: 'detached' });

  // ── The ways it closes; what is behind it stays ──
  const stays = async what => { if (!wide) assert.equal(await page.locator('#h5-tasks').isVisible(), true, `${label}: ${what} leaves the task sheet open`); };
  await page.evaluate(() => { document.getElementById('h5-task-list').scrollTop = 0; });
  const atFirst = async () => { await page.evaluate(() => { document.getElementById('h5-task-list').scrollTop = 0; }); await page.waitForTimeout(60); await h.open(SELECTED, 1); };

  await atFirst();
  if (wide) await page.mouse.click(1000, 500); else await page.touchscreen.tap(380, 700);
  await h.gone('a tap beside it');
  await stays('a tap beside it');

  await atFirst();
  await page.goBack();
  await h.gone('the back button');
  await stays('the back button');

  await atFirst();
  await page.evaluate(() => { document.getElementById('h5-task-list').scrollTop += 40; });
  await h.gone('scrolling the list');

  await atFirst();
  if (wide) { await page.mouse.move(1000, 500); await page.mouse.wheel(0, 40); }
  else await page.locator('#h5-session-menu .MuiBackdrop-root').evaluate(node => node.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true })));
  await h.gone('a drag beside it');

  // A terminal printing scrolls its own viewport, which has nothing to do with the list; a scroll inside the popup is the popup's own.
  await atFirst();
  await page.evaluate(() => { const view = document.querySelector('.xterm-viewport') || document.createElement('div'); if (!view.isConnected) document.body.append(view); view.dispatchEvent(new Event('scroll')); });
  await page.locator('.h5-session-menu-paper').evaluate(node => node.dispatchEvent(new Event('scroll')));
  await page.waitForTimeout(150);
  assert.equal(await h.popup.count(), 1, `${label}: a scroll elsewhere leaves the popup open`);
  await page.keyboard.press('Escape');
  await h.gone('Escape');

  await atFirst();
  await page.evaluate(() => window.H5UI.actions.collapseAll());
  await h.gone('its row going away');
  await page.locator('.h5-task-item', { hasText: 'Alpha' }).evaluate(node => node.click());
  await h.list(SELECTED).locator('.h5-terminal-row').nth(19).waitFor();

  await atFirst();
  await page.evaluate(() => window.H5UI.actions[window.H5UI.get().wide ? 'toggleSidebar' : 'closeTasks']());
  await h.gone(wide ? 'folding the sidebar' : 'the task sheet closing');
  if (wide) await page.evaluate(() => window.H5UI.actions.toggleSidebar());
  else { await page.locator('#h5-tasks').waitFor({ state: 'hidden' }); await page.locator('#h5-open-tasks').tap(); await page.locator('#h5-tasks').waitFor({ state: 'visible' }); }
  await h.list(SELECTED).locator('.h5-terminal-row').nth(19).waitFor();

  // ── Choosing an item closes it; Rename's field keeps the focus ──
  await atFirst();
  await h.press(h.items.filter({ hasText: 'Rename' }));
  await h.gone('Rename');
  await page.locator('#h5-term-rename-input').waitFor();
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'h5-term-rename-input', `${label}: the rename field has the focus`);
  await page.locator('#h5-term-rename-input').press('Escape');
  await page.locator('#h5-term-rename').waitFor({ state: 'detached' });

  // ── The "⋯" of a task stays a sheet from the bottom ──
  await h.press(page.locator('.h5-task-more').first());
  await page.locator('#h5-term-menu .h5-menu-panel').waitFor({ state: 'visible' });
  assert.equal(await h.popup.count(), 0, `${label}: the task menu is not the popup`);
  await h.press(page.locator('#h5-term-menu-cancel'));
  await page.locator('#h5-term-menu .h5-menu-panel').waitFor({ state: 'detached' });

  // ── The last row of a short window: above the button, not cut off ──
  await page.setViewportSize({ width: wide ? 1440 : 390, height: 460 });
  await page.waitForTimeout(350);
  await h.open(SELECTED, 19);
  assertAbove(await h.boxes(SELECTED, 19), `${label} short viewport`);
  await page.keyboard.press('Escape');
  await h.gone('Escape');
  await page.setViewportSize({ width: wide ? 1440 : 390, height: wide ? 900 : 844 });
  await page.waitForTimeout(350);

  if (!wide) {
    // ── The on-screen keyboard counts as the end of the screen: a row that would fit below in the full window turns over above it ──
    await page.evaluate(() => window.setKeyboard(420));
    await page.waitForTimeout(350);
    await page.locator('#h5-task-list').evaluate(node => { node.scrollTop = 0; });
    await page.waitForTimeout(60);
    await h.open(SELECTED, 3);
    const g = await h.boxes(SELECTED, 3);
    assertAbove(g, `${label} keyboard open`);
    assert.ok(g.paper.bottom <= 844 - 420 + 1, `${label}: above the keyboard ${JSON.stringify(g.paper)}`);
    await page.keyboard.press('Escape');
    await h.gone('Escape');
    await page.evaluate(() => window.setKeyboard(0));
  }
  await context.close();
  console.log(`  ${label}: ok`);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await run(browser, false);
    await run(browser, true);
  } finally {
    await browser.close();
  }
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log('The popup of a session row passed (390px and 1440px).');
})().catch(error => { console.error(error); process.exit(1); });
