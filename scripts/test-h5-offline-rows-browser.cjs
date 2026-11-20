// Browser test of an offline linked engine's tasks in the list ("Tasks of an offline engine" in docs/design/failover-and-one-login.md): the page of
// K01 is opened while T01 is offline; T01 never answered in this page load, but K01's server kept its task names (`last_known` of the 502), so its
// rows are listed, dimmed, with "offline" and an info line above the list, and cannot be opened. When T01 is back, its rows are normal again.
// SHOTS=<folder> saves a 390px screenshot.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const K01_ID = '6c1d1c1e-0000-4000-8000-0000000000a1';
const T01_ID = '9f2b7a33-0000-4000-8000-0000000000b2';
const GROUPS = [{ key: 'doing', name: 'In progress', sort_order: 1 }];
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

(async () => {
  const world = { t01: false, reads: [] };
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() { this.readyState = 3; } };
      window.WebSocket.OPEN = 1;
    });
    await page.addInitScript(activityStreamMock);
    await page.route(`${ORIGIN}/**`, route => {
      const url = new URL(route.request().url());
      const pathname = url.pathname;
      world.reads.push(pathname);
      if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
      if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
      if (pathname === '/api/system/version') return json(route, { app_version: '2.145.0', boot_id: 'b1', engine_name: 'K01', instance_id: K01_ID });
      if (pathname === '/api/remote-servers') return json(route, [{ id: 7, name: 'T01', status: world.t01 ? 'online' : 'offline', base_url: 'tunnel://x', enabled: true, instance_id: T01_ID }]);
      if (pathname === '/api/task-order') return json(route, { order: [], updated_at: 1 });
      if (pathname === '/api/task-list/hidden-devices') return json(route, { hidden: [] });
      if (pathname === '/api/tasks') return json(route, [{ id: 1, title: 'Welcome speech tuning', status: 'doing', archived_at: null }, { id: 2, title: 'SELF-ONCALL', status: 'doing', archived_at: null }]);
      if (pathname === '/api/task-groups' || pathname === '/api/remote-servers/7/task-groups') return json(route, GROUPS);
      if (pathname === '/api/remote-servers/7/tasks') {
        if (!world.t01) return json(route, { error: 'REMOTE_OFFLINE', last_known: { at: '2026-11-20T08:00:00.000Z', tasks: [{ id: 3, title: 'SELF-TAGENT', status: 'doing', sort_order: null }] } }, 502);
        return json(route, [{ id: 3, title: 'SELF-TAGENT', status: 'doing', archived_at: null }]);
      }
      if (pathname.startsWith('/api/remote-servers/7/') && !world.t01) return json(route, { error: 'REMOTE_OFFLINE' }, 502);
      if (pathname.endsWith('/terminal-activity') || pathname.endsWith('/terminal-subagents')) return json(route, {});
      if (pathname === '/api/remote-servers/7/info') return json(route, { capabilities: ['terminal:control'] });
      if (/\/terminals$/.test(pathname)) return json(route, []);
      return json(route, { error: 'not mocked' }, 404);
    });
    await page.goto(`${ORIGIN}/h5`);
    await page.waitForTimeout(500);
    if (!await page.locator('#h5-tasks').isVisible()) await page.locator('#h5-open-tasks').tap();
    await page.locator('#h5-tasks').waitFor({ state: 'visible' });
    const offlineRow = page.locator('#h5-task-list .h5-task[data-source="remote:7"]');
    await offlineRow.first().waitFor();
    await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity));
    assert.equal(await offlineRow.locator('.h5-task-title').textContent(), 'SELF-TAGENT');
    assert.equal(await offlineRow.locator('.h5-task-offline').textContent(), 'offline');
    assert.equal(await offlineRow.locator('.h5-task-item').getAttribute('data-offline'), 'true');
    assert.ok(await offlineRow.locator('.h5-task-item').isDisabled(), 'a row only known from the last read cannot be opened');
    assert.equal(await offlineRow.locator('.h5-task-more').count(), 0, 'and has no actions');
    const note = page.locator('.h5-offline-note');
    assert.equal(await note.count(), 1);
    assert.equal(await note.textContent(), 'T01 is offline. Its tasks are shown as they were and open again when it is back.');
    // Dimmed: the disabled text colour, unlike K01's rows.
    const colour = selector => page.locator(selector).first().evaluate(element => getComputedStyle(element).color);
    assert.notEqual(await colour('#h5-task-list .h5-task[data-source="remote:7"] .h5-task-title'), await colour('#h5-task-list .h5-task[data-source="local"] .h5-task-title'));
    assert.equal(await page.locator('#h5-task-list .h5-task[data-source="local"] .h5-task-offline').count(), 0);
    // A tap on the tag asks nothing of T01.
    const before = world.reads.filter(item => item.startsWith('/api/remote-servers/7/tasks/3')).length;
    await offlineRow.locator('.h5-task-tag').dispatchEvent('click');
    await page.waitForTimeout(300);
    assert.equal(world.reads.filter(item => item.startsWith('/api/remote-servers/7/tasks/3')).length, before);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll at 390px');
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'failover-offline-rows-390.png') });

    // T01 is back (the offline poll or a reload reads it): normal rows, no note.
    world.t01 = true;
    await page.reload();
    await page.waitForTimeout(500);
    if (!await page.locator('#h5-tasks').isVisible()) await page.locator('#h5-open-tasks').tap();
    await page.locator('#h5-task-list .h5-task[data-source="remote:7"] .h5-task-title').waitFor();
    await page.waitForFunction(() => !document.querySelector('.h5-offline-note'));
    assert.equal(await page.locator('#h5-task-list .h5-task[data-source="remote:7"] .h5-task-offline').count(), 0);
    assert.ok(!(await page.locator('#h5-task-list .h5-task[data-source="remote:7"] .h5-task-item').isDisabled()));
    assert.deepEqual(errors, []);
    await context.close();
    console.log('Offline rows: an offline linked engine\'s tasks stay listed, dimmed, with an info line, and are normal again when it is back.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
