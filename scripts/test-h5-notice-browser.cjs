// The floating notice in real Chromium at 390 and 320px (touch) and 1440px (pointer): a blue (info) notice starts as a small one-line chip,
// a tap, Enter or Space opens it in place to the whole text, an open one outlives the info duration and a click away, a collapsed one goes by itself,
// a newer notice replaces it and starts collapsed, and success and error notices render as before.
// H5_SHOT_DIR=<dir> saves 3x screenshots of the chip and the open notice there.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const INFO_DURATION = 3500;
const LONG = 'A very long blue notice that does not fit on one line of a phone and must wrap in full once it is opened, ending with the word omega';
const pageErrors = [];

const VIEWPORTS = [
  { name: 'phone 390', viewport: { width: 390, height: 844 }, touch: true },
  { name: 'phone 320', viewport: { width: 320, height: 640 }, touch: true },
  { name: 'computer', viewport: { width: 1440, height: 900 }, touch: false },
];

async function openPage(browser, { viewport, touch }) {
  const scale = process.env.H5_SHOT_DIR ? { deviceScaleFactor: 3 } : {};
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...scale });
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
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    if (url.pathname === '/api/remote-servers') return json([]);
    if (url.pathname === '/api/tasks') return json([{ id: 1, title: 'Fix login', status: 'doing' }]);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (url.pathname === '/api/tasks/terminal-activity') return json({});
    if (url.pathname === '/api/tasks/terminal-subagents') return json({});
    if (url.pathname === '/api/tasks/1/terminals') return json([{ terminal_id: 'h5-default', title: 'Terminal 1' }]);
    if (/^\/api\/tasks\/\d+\/agent\/conversations$/.test(url.pathname)) return json([]);
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  await page.waitForFunction(() => Boolean(window.H5UI && window.H5UI.notify));
  return { context, page };
}

const notify = (page, message, type) => page.evaluate(([text, kind]) => window.H5UI.notify(text, kind), [message, type]);
const toggle = page => page.locator('.MuiSnackbar-root button[aria-expanded]');
const status = page => page.locator('.MuiSnackbar-root [role="status"]');
const message = page => page.locator('.MuiSnackbar-root .MuiAlert-message');
const closeButton = page => page.locator('.MuiSnackbar-root .MuiAlert-action button');
const settled = page => page.waitForFunction(() => {
  const node = document.querySelector('.MuiSnackbar-root > *');
  return node && ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(node).transform) && getComputedStyle(node).opacity === '1';
}, null, { timeout: 3000 });
const noSideScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const metrics = page => page.evaluate(() => {
  const alert = document.querySelector('.MuiSnackbar-root .MuiAlert-root');
  const text = alert.querySelector('.MuiAlert-message');
  const button = document.querySelector('.MuiSnackbar-root button[aria-expanded]');
  const box = alert.getBoundingClientRect();
  const style = getComputedStyle(text);
  return {
    top: box.top, left: box.left, right: box.right, width: box.width, height: box.height,
    whiteSpace: style.whiteSpace, textOverflow: style.textOverflow,
    cut: text.scrollWidth > text.clientWidth, overflowsDown: text.scrollHeight > text.clientHeight + 1,
    hit: button ? button.getBoundingClientRect().toJSON() : null,
  };
});
// What takes a tap at this point: the toggle button, or something else.
const hits = (page, x, y) => page.evaluate(([px, py]) => Boolean(document.elementFromPoint(px, py)?.closest('.MuiSnackbar-root button[aria-expanded]')), [x, y]);

async function checkChip(page, { viewport, touch }) {
  const box = await metrics(page);
  assert.ok(box.height <= 32, `chip height ${box.height}`);
  assert.ok(box.width <= Math.min(280, viewport.width - 32) + 0.5, `chip width ${box.width}`);
  assert.ok(box.top >= 12, `chip top ${box.top}`);
  assert.ok(box.left >= 0 && box.right <= viewport.width, 'chip inside the viewport');
  assert.ok(await noSideScroll(page), 'no horizontal scroll');
  if (touch) {
    assert.ok(box.hit.height >= 44, `hit height ${box.hit.height}`);
    const y = box.top + box.height / 2;
    for (const dy of [-21, 21]) assert.ok(await hits(page, viewport.width / 2, y + dy), `tap ${dy}px off the chip's middle counts`);
  }
  return box;
}

async function press(page, touch) { await toggle(page)[touch ? 'tap' : 'click'](); }

async function run(browser, setup) {
  const { context, page } = await openPage(browser, setup);
  const { viewport, touch } = setup;
  if (!touch) await page.mouse.move(5, viewport.height - 5); // the pointer is not resting on a notice: hovering one holds its timer
  await page.evaluate(() => window.H5UI.set({ tasksOpen: false })); // the phone starts on the task sheet, a modal that would hold the keyboard focus
  await page.waitForFunction(() => !document.querySelector('.MuiModal-root:not(.MuiModal-hidden) .h5-sheet-panel'));

  // Starts collapsed, one line, cut by CSS only, with the full text kept for screen readers.
  await notify(page, LONG);
  await status(page).waitFor();
  await settled(page);
  const chip = await checkChip(page, setup);
  assert.equal(chip.whiteSpace, 'nowrap');
  assert.equal(chip.textOverflow, 'ellipsis');
  assert.ok(chip.cut, 'the long text is cut');
  assert.equal(await status(page).innerText(), LONG, 'role=status has the whole text');
  assert.equal(await toggle(page).getAttribute('aria-expanded'), 'false');
  assert.equal(await toggle(page).getAttribute('aria-label'), 'Show the full notice');
  assert.equal(await toggle(page).getAttribute('title'), 'Show the full notice');
  assert.equal(await closeButton(page).count(), 0, 'no close button on the chip');
  assert.equal(await status(page).locator('button[aria-expanded]').count(), 0, 'the button is outside the status box');
  // The strip beside the chip belongs to the page below it.
  const beside = await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest('.MuiSnackbar-root')), [12, chip.top + chip.height / 2]);
  assert.equal(beside, false, 'the strip beside the chip is not covered');
  if (process.env.H5_SHOT_DIR && viewport.width === 390) await page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, 'notice-collapsed-390.png') });

  // A tap opens it in place: the whole text, wrapped, with a close button.
  const focusBefore = await page.evaluate(() => { const input = document.createElement('input'); input.id = 'focus-probe'; input.style.cssText = 'position:fixed;left:0;bottom:0'; document.body.append(input); input.focus(); return document.activeElement.id; });
  await press(page, touch);
  await page.waitForFunction(() => document.querySelector('.MuiSnackbar-root button[aria-expanded]').getAttribute('aria-expanded') === 'true');
  assert.equal(await page.evaluate(() => document.activeElement.id), focusBefore, 'the tap leaves the focus where it was');
  await page.evaluate(() => document.getElementById('focus-probe').remove());
  const open = await metrics(page);
  assert.equal(open.whiteSpace, 'normal');
  assert.equal(open.cut, false, 'nothing cut sideways');
  assert.equal(open.overflowsDown, false, 'nothing cut below');
  assert.ok(open.height > chip.height, 'taller than the chip');
  assert.ok(open.left >= 0 && open.right <= viewport.width, 'open notice inside the viewport');
  assert.ok(await noSideScroll(page), 'no horizontal scroll when open');
  assert.equal(await status(page).innerText(), LONG);
  await closeButton(page).waitFor({ state: 'visible' });
  assert.equal(await toggle(page).getAttribute('aria-label'), 'Collapse this notice');
  if (process.env.H5_SHOT_DIR && viewport.width === 390) await page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, 'notice-expanded-390.png') });

  // Open, it outlives the info duration and a click away.
  await page.waitForTimeout(INFO_DURATION + 1000);
  await page.evaluate(() => document.body.click()); // a click that lands on no control, so it opens nothing
  await page.waitForTimeout(300);
  await status(page).waitFor({ state: 'visible', timeout: 500 });
  assert.equal(await toggle(page).getAttribute('aria-expanded'), 'true', 'still open');

  // A newer notice replaces it and starts collapsed.
  await notify(page, 'A newer blue notice');
  await message(page).filter({ hasText: 'A newer blue notice' }).waitFor();
  await settled(page);
  assert.equal(await message(page).count(), 1, 'only one notice');
  assert.equal(await toggle(page).getAttribute('aria-expanded'), 'false', 'the newer one starts collapsed');
  await checkChip(page, setup);

  // A short message opens too, and the close button ends it.
  await press(page, touch);
  await closeButton(page).waitFor({ state: 'visible' });
  await closeButton(page)[touch ? 'tap' : 'click']();
  await status(page).waitFor({ state: 'detached', timeout: 2000 });
  if (!touch) await page.mouse.move(5, viewport.height - 5);

  // The keyboard: Enter and Space, on a real button.
  for (const key of ['Enter', 'Space']) {
    await notify(page, `Keyboard ${key}`);
    await message(page).filter({ hasText: `Keyboard ${key}` }).waitFor();
    await toggle(page).focus();
    await page.keyboard.press(key);
    await page.waitForFunction(() => document.querySelector('.MuiSnackbar-root button[aria-expanded]').getAttribute('aria-expanded') === 'true');
    await closeButton(page).waitFor({ state: 'visible' });
  }
  await closeButton(page)[touch ? 'tap' : 'click']();
  await status(page).waitFor({ state: 'detached', timeout: 2000 });
  if (!touch) await page.mouse.move(5, viewport.height - 5);

  // Collapsed, it goes by itself after the info duration, not much sooner.
  await notify(page, 'Goes by itself');
  await message(page).filter({ hasText: 'Goes by itself' }).waitFor();
  const shownAt = Date.now();
  await page.waitForTimeout(INFO_DURATION - 1000);
  assert.equal(await message(page).count(), 1, 'still there before the duration');
  await status(page).waitFor({ state: 'detached', timeout: 3000 });
  assert.ok(Date.now() - shownAt >= INFO_DURATION - 500, 'not gone early');

  // Success and error are as before: the full Alert with a close button, wrapped, and no chip.
  for (const type of ['success', 'error']) {
    await notify(page, `${LONG} (${type})`, type);
    await message(page).filter({ hasText: `(${type})` }).waitFor();
    await settled(page);
    assert.equal(await toggle(page).count(), 0, `${type}: no chip button`);
    assert.equal(await page.locator(`.MuiSnackbar-root .MuiAlert-colorSuccess, .MuiSnackbar-root .MuiAlert-colorError`).count(), 1);
    assert.ok((await page.locator(`.MuiSnackbar-root .MuiAlert-color${type === 'error' ? 'Error' : 'Success'}`).count()) === 1, `${type}: colour`);
    const box = await metrics(page);
    assert.equal(box.whiteSpace, 'normal', `${type}: wrapped`);
    assert.equal(box.cut, false, `${type}: not cut`);
    assert.ok(box.height >= 48, `${type}: full size, ${box.height}`);
    await closeButton(page).waitFor({ state: 'visible' });
    assert.ok(await noSideScroll(page));
  }
  await context.close();
}

(async () => {
  if (process.env.H5_SHOT_DIR) fs.mkdirSync(process.env.H5_SHOT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const setup of VIEWPORTS) {
      await run(browser, setup);
      console.log(`ok ${setup.name}`);
    }
    assert.deepEqual(pageErrors, [], 'no page errors');
    console.log('h5 notice browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
