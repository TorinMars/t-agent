// "Updated to v…" (scripts/h5-shell/UpdatedNotice.jsx; "Notice after an update" in docs/design/update-check-and-versions.md) in real Chromium with the
// API mocked: shown on load when the update status says so (a phone, 390 x 844 touch, and a computer, 1440 x 900), the title, the line with the engine
// and the time, the linked engine's line, the release notes newest first in the primary colour; OK posts the acknowledgement (with the linked line)
// and it is not shown again; Escape acknowledges too; nothing when the API says no, nothing in a pane of the multi-column view; the Chinese UI.
// H5_SHOT_DIR=<dir> saves screenshots of the dialog.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const pageErrors = [];

const sleep = ms => new Promise(done => setTimeout(done, ms));
const NOTICE = {
  show: true, version: '2.144.0', previous_version: '2.143.0', updated_at: '2026-11-19T16:42:00.000Z', engine_name: 'T01',
  notes: [
    { version: '2.144.0', note: 'After an update, the next visit to the page shows what changed' },
    { version: '2.143.1', note: 'Phone: the key row and the tools row step aside while the draft box types with the phone keyboard' },
  ],
  linked: [{ id: 'link-k01', name: 'K01', version: '2.144.0' }],
};
// `due`: updated_notice of update-status; `notice`: the GET answer. Acknowledging turns both off, as the server does.
function world(over = {}) {
  return { due: true, notice: NOTICE, gets: 0, posts: [], paneGets: 0, ...over };
}
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function serve(w, route) {
  const request = route.request();
  const { pathname } = new URL(request.url());
  const method = request.method();
  if (pathname === '/top') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><iframe id="pane-a" src="${ORIGIN}/h5?pane=a" style="width:480px;height:900px"></iframe>` });
  if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
  if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
  if (pathname === '/api/system/updated-notice') {
    if (method === 'POST') {
      w.posts.push(request.postDataJSON());
      w.due = false;
      w.notice = { show: false };
      return json(route, { acknowledged: true, linked: [{ id: 'link-k01', acknowledged: true }] });
    }
    if (request.frame() !== request.frame().page().mainFrame()) w.paneGets += 1; else w.gets += 1;
    return json(route, w.notice);
  }
  if (pathname === '/api/system/version') return json(route, { app_version: '2.144.0', boot_id: 'boot-a', engine_name: 'T01' });
  if (pathname === '/api/system/update-status' || pathname === '/api/system/check-update') return json(route, { status: 'current', local_version: '2.144.0', remote_version: '2.144.0', boot_id: 'boot-a', install_type: 'git', is_update_admin: true, log: [], updated_notice: w.due });
  if (pathname === '/api/system/engine-name') return json(route, { name: 'T01', default_name: 't01', custom: true });
  if (pathname === '/api/remote-servers') return json(route, []);
  if (pathname === '/api/service-links') return json(route, { supported: true, links: [] });
  if (pathname === '/api/task-list/hidden-devices') return json(route, { hidden: [] });
  if (pathname === '/auth/me') return json(route, { effective_work_dir: '/home/me/tasks' });
  if (pathname === '/api/tasks') return json(route, [{ id: 1, title: 'Alpha', status: 'doing' }]);
  if (pathname === '/api/task-groups') return json(route, [{ key: 'doing', name: 'Doing', sort_order: 1 }]);
  if (pathname === '/api/tasks/terminal-activity' || pathname === '/api/tasks/terminal-subagents') return json(route, {});
  if (/^\/api\/tasks\/\d+\/terminals$/.test(pathname)) return json(route, [{ terminal_id: 'default', title: 'Terminal 1' }]);
  if (/\/agent\/conversations$/.test(pathname)) return json(route, []);
  if (pathname === '/api/agent-chat/summary') return json(route, { running: 0, queued: 0, submitted: 0 });
  if (/\/terminal\/(ack|control)$/.test(pathname)) return json(route, { success: true });
  return json(route, { error: 'not mocked' }, 404);
}

async function open(browser, w, { at = '/h5', phone = true, zh = false } = {}) {
  const context = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, timezoneId: 'Asia/Taipei' }
    : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, timezoneId: 'Asia/Taipei' });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(chinese => {
    window.WebSocket = class {
      constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send() {}
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    try { localStorage.setItem('h5-task:local', '1'); if (chinese) localStorage.setItem('ta-lang', 'zh'); } catch { /* not the page origin */ }
  }, zh);
  await page.addInitScript(activityStreamMock);
  await page.route(`${ORIGIN}/**`, route => serve(w, route));
  await page.goto(`${ORIGIN}${at}`);
  return { context, page };
}
const dialog = page => page.locator('#h5-updated-dialog [role="dialog"]');
const settled = page => page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running'));

async function checkContent(page) {
  assert.equal(await page.locator('#h5-updated-title').textContent(), 'Updated to v2.144.0');
  assert.match(await page.locator('#h5-updated-body').textContent(), /^T-Agent on T01 was updated on Nov 20(, 2026)?, 00:42, from v2\.143\.0\.$/);
  assert.deepEqual(await page.locator('.h5-updated-linked').allTextContents(), ['K01 was also updated to v2.144.0.']);
  const rows = page.locator('.h5-updated-note');
  assert.equal(await rows.count(), 2);
  assert.deepEqual(await rows.evaluateAll(list => list.map(row => row.firstElementChild.textContent)), ['v2.144.0', 'v2.143.1']);
  assert.equal(await page.locator('#h5-updated-notes').getAttribute('translate'), 'no');
  // The version in the primary colour of the dark theme (#90caf9).
  assert.equal(await rows.first().locator('span').first().evaluate(el => getComputedStyle(el).color), 'rgb(144, 202, 249)');
  const overline = page.locator('#h5-updated-dialog h3');
  assert.equal(await overline.evaluate(el => getComputedStyle(el).textTransform), 'uppercase');
  // One text button, OK (the one dialog pattern).
  const actions = page.locator('#h5-updated-dialog .MuiDialogActions-root button');
  assert.equal(await actions.count(), 1);
  assert.equal(await actions.textContent(), 'OK');
  assert.ok(await actions.evaluate(el => el.classList.contains('MuiButton-text')));
}

const SCENARIOS = {
  async 'phone: shown on load with the notes and the linked line; OK acknowledges both and it is not shown again'(browser) {
    const w = world();
    const { context, page } = await open(browser, w);
    await dialog(page).waitFor();
    await settled(page);
    await checkContent(page);
    const box = await dialog(page).boundingBox();
    assert.equal(Math.round(box.x), 16, 'a centred dialog with the 16px margin on a phone');
    assert.equal(Math.round(box.width), 390 - 32);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'updated-notice-390.png') });
    await page.locator('#h5-updated-ok').tap();
    await dialog(page).waitFor({ state: 'hidden' });
    await page.waitForFunction(() => !document.getElementById('h5-updated-root'));
    assert.deepEqual(w.posts, [{ version: '2.144.0', linked: [{ id: 'link-k01', version: '2.144.0' }] }]);
    // A visit after OK: the update status says nothing, the notice is not even asked for.
    const gets = w.gets;
    await page.reload();
    await page.locator('#h5-app').waitFor();
    await sleep(1200);
    assert.equal(await page.locator('#h5-updated-dialog').count(), 0);
    assert.equal(w.gets, gets);
    await context.close();
  },
  async 'computer: 444px wide, Escape closes it and counts as seen'(browser) {
    const w = world();
    const { context, page } = await open(browser, w, { phone: false });
    await dialog(page).waitFor();
    await settled(page);
    await checkContent(page);
    assert.equal(Math.round((await dialog(page).boundingBox()).width), 444);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'updated-notice-1440.png') });
    await page.keyboard.press('Escape');
    await dialog(page).waitFor({ state: 'hidden' });
    assert.deepEqual(w.posts, [{ version: '2.144.0', linked: [{ id: 'link-k01', version: '2.144.0' }] }]);
    await context.close();
  },
  async 'nothing when the API says no'(browser) {
    // The update status says no: the notice is never asked for.
    const quiet = world({ due: false });
    const first = await open(browser, quiet);
    await first.page.locator('#h5-app').waitFor();
    await sleep(1500);
    assert.equal(quiet.gets, 0);
    assert.equal(await first.page.locator('#h5-updated-dialog').count(), 0);
    await first.context.close();
    // The status says yes but the notice says no (acknowledged on another device a moment ago): nothing is drawn.
    const gone = world({ notice: { show: false } });
    const second = await open(browser, gone);
    await second.page.locator('#h5-app').waitFor();
    for (let i = 0; i < 100 && gone.gets === 0; i += 1) await sleep(30);
    assert.equal(gone.gets, 1);
    await sleep(600);
    assert.equal(await second.page.locator('#h5-updated-dialog').count(), 0);
    assert.equal(gone.posts.length, 0);
    await second.context.close();
  },
  async 'nothing in a pane of the multi-column view'(browser) {
    const w = world();
    const { context, page } = await open(browser, w, { at: '/top', phone: false });
    let frame = null;
    for (let i = 0; i < 200 && !frame; i += 1) { frame = page.frames().find(item => item.url().includes('pane=a')); if (!frame) await sleep(20); }
    assert.ok(frame, 'the pane frame');
    await frame.waitForFunction(() => Boolean(window.H5Pane));
    await frame.locator('#h5-app').waitFor();
    await sleep(1500);
    assert.equal(w.paneGets, 0);
    assert.equal(await frame.locator('#h5-updated-dialog').count(), 0);
    await context.close();
  },
  async 'the Chinese UI'(browser) {
    const w = world();
    const { context, page } = await open(browser, w, { zh: true });
    await dialog(page).waitFor();
    await settled(page);
    assert.equal(await page.locator('#h5-updated-title').textContent(), '\u5df2\u66f4\u65b0\u5230 v2.144.0');
    assert.match(await page.locator('#h5-updated-body').textContent(), /^T01 \u4e0a\u7684 T-Agent \u5df2\u4e8e .+ \u4ece v2\.143\.0 \u66f4\u65b0\u3002$/);
    assert.deepEqual(await page.locator('.h5-updated-linked').allTextContents(), ['K01 \u4e5f\u5df2\u66f4\u65b0\u5230 v2.144.0\u3002']);
    assert.equal(await page.locator('#h5-updated-dialog h3').textContent(), '\u66f4\u65b0\u5185\u5bb9');
    assert.equal(await page.locator('#h5-updated-ok').textContent(), '\u786e\u5b9a');
    // The release notes stay in English, as written.
    assert.equal(await page.locator('.h5-updated-note').first().locator('span').nth(1).textContent(), NOTICE.notes[0].note);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'updated-notice-390-zh.png') });
    await page.locator('#h5-updated-ok').tap();
    await dialog(page).waitFor({ state: 'hidden' });
    assert.equal(w.posts.length, 1);
    await context.close();
  },
};

(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const [name, run] of Object.entries(SCENARIOS)) {
      await run(browser);
      console.log(`  ok: ${name}`);
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log('Updated notice passed.');
})().catch(error => { console.error(error); process.exit(1); });
