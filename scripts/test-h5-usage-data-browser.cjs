// Usage data of the page (scripts/h5-shell/usage-track.mjs, usage-recorder.mjs, UsageData.jsx; "Usage data" in docs/design/usage-data.md) in real
// Chromium with mocked servers, on a computer (1440x900, a mouse) and a phone (390x844, touch): presses on several controls go to POST /api/ui-events
// in a batch (not one request per press) with the right keys, surfaces and context; no task, session or device name appears in any request body; the
// rest goes with navigator.sendBeacon on pagehide; with the switch off nothing is sent. The Settings group "Usage data" draws the cards of the mockup
// from a mocked summary; Clear asks first and clears; Export JSON downloads. It also prints how many controls on the main screens are named by a
// fallback (a class name or a role instead of data-track / id / data-action).
// H5_SHOT_DIR=<dir> saves screenshots of the group (computer 1440x900, phone 390x844 at 3x).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { settled } = require('./browser-test-wait.cjs');

const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const RECORDER = `/js/chunks/${fs.readdirSync(path.join(root, 'public/js/chunks')).find(name => name.startsWith('usage-recorder-'))}`;

// Names a person typed: none of them may ever reach the usage data.
const SECRETS = ['Acme merger', 'Payroll shell', 'Board deck', 'K01', 'Night build'];
const TASKS = [{ id: 1, title: 'Acme merger', status: 'doing' }, { id: 2, title: 'Board deck', status: 'doing' }];
const TERMINALS = { 1: [{ terminal_id: 'default', title: 'Payroll shell' }, { terminal_id: 'c1', title: 'Night build', agent: 'claude' }], 2: [{ terminal_id: 'd1', title: 'Terminal 1' }] };
const GROUPS = [{ key: 'doing', name: 'In progress', sort_order: 1 }];
const SUMMARY = {
  enabled: true, days: 30, layout: null, total: 3500,
  top: [
    { key: 'h5-translate-button', count: 1284, surfaces: [{ surface: 'bottom-row', count: 1284 }], layouts: { wide: 1284, narrow: 0 }, details: [] },
    { key: 'h5-cycle', count: 612, surfaces: [{ surface: 'bottom-row', count: 612 }], layouts: { wide: 400, narrow: 212 }, details: [] },
    { key: 'h5-commands', count: 388, surfaces: [{ surface: 'bottom-row', count: 388 }], layouts: { wide: 300, narrow: 88 }, details: [] },
    { key: 'h5-attention-open', count: 301, surfaces: [{ surface: 'attention', count: 301 }], layouts: { wide: 200, narrow: 101 }, details: [] },
    { key: 'key:Escape', count: 266, surfaces: [{ surface: 'key-row', count: 266 }], layouts: { wide: 0, narrow: 266 }, details: [] },
    { key: 'h5-term-width', count: 140, surfaces: [{ surface: 'header', count: 140 }], layouts: { wide: 140, narrow: 0 }, details: [] },
    { key: 'h5-nav-columns', count: 96, surfaces: [{ surface: 'rail', count: 96 }], layouts: { wide: 96, narrow: 0 }, details: [] },
    { key: 'h5-voice', count: 71, surfaces: [{ surface: 'bottom-row', count: 71 }], layouts: { wide: 50, narrow: 21 }, details: [] },
  ],
  unused: [
    { key: 'h5-image', surface: 'bottom-row', layouts: ['wide'] }, { key: 'h5-design', surface: 'bottom-row', layouts: ['wide', 'narrow'] },
    { key: 'h5-nav-maps', surface: 'rail', layouts: ['wide'] }, { key: 'h5-expand-all', surface: 'menu:task-list-menu', layouts: ['wide'] },
    { key: 'h5-refresh', surface: 'menu:header-more-menu', layouts: ['wide', 'narrow'] }, { key: 'key:Tab', surface: 'key-row', layouts: ['narrow'] },
  ],
  next: [], data: { count: 14208, first_at: Date.UTC(2026, 10, 19), retention_days: 90, bytes: 1.3 * 1024 * 1024 },
};
const EMPTY = { ...SUMMARY, total: 0, top: [], unused: [], data: { count: 0, first_at: null, retention_days: 90, bytes: 0 } };

async function openPage(browser, viewport, { touch, server }) {
  const context = await browser.newContext({ viewport, acceptDownloads: true, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...(SHOTS ? { deviceScaleFactor: touch ? 3 : 1 } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send() {} close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    // The beacon is real (it reaches the route below), and its body is also kept here.
    window.beacons = [];
    const send = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => { data.text().then(text => window.beacons.push({ url, text })); return send(url, data); };
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const p = url.pathname;
    const method = request.method();
    const json = (body, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
    if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
    if (p.startsWith('/api/ui-events')) {
      server.requests.push({ method, path: p + url.search, body: request.postData() || '' });
      if (p === '/api/ui-events/settings' && method === 'GET') return json({ enabled: server.enabled });
      if (p === '/api/ui-events/settings' && method === 'PUT') { server.enabled = JSON.parse(request.postData()).enabled; return json({ enabled: server.enabled }); }
      if (p === '/api/ui-events' && method === 'POST') { server.batches.push(request.postData()); return json({ accepted: 1, enabled: server.enabled }); }
      if (p === '/api/ui-events/summary') return json(server.cleared ? EMPTY : SUMMARY);
      if (p === '/api/ui-events/export') return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Content-Disposition': 'attachment; filename="t-agent-usage-2026-11-19.json"' }, body: JSON.stringify({ events: [] }) });
      if (p === '/api/ui-events' && method === 'DELETE') { server.cleared = true; return json({ cleared: 14208 }); }
    }
    if (p === '/api/remote-servers') return json([{ id: 7, name: 'K01', status: 'online', base_url: 'http://10.0.0.7:14002', enabled: true }]);
    if (p === '/api/tasks' && method === 'GET') return json(TASKS);
    if (p === '/api/remote-servers/7/tasks' && method === 'GET') return json([]);
    if (p === '/api/task-groups' || p === '/api/remote-servers/7/task-groups') return json(GROUPS);
    if (p === '/api/tasks/terminal-activity' || p === '/api/remote-servers/7/terminal-activity') return json({});
    if (/terminal-subagents$/.test(p)) return json({});
    if (/\/terminal\/ack$/.test(p)) return json({ success: true });
    const local = p.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (local && method === 'GET') return json(TERMINALS[local[1]] || []);
    if (p === '/api/remote-servers/7/info') return json({ capabilities: [] });
    if (/\/agent\/conversations$/.test(p)) return json([]);
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  await page.waitForFunction(() => window.H5UI && window.H5UI.get().usageRecording !== null, null, { timeout: 15000 });
  await page.waitForFunction(() => (window.H5UI.get().taskList.tasks || []).length === 2, null, { timeout: 15000 });
  return { context, page, errors };
}

const events = server => server.batches.flatMap(body => JSON.parse(body).events);
const noSecrets = (server, page) => page.evaluate(() => window.beacons.map(beacon => beacon.text)).then(beacons => {
  const bodies = [...server.requests.map(request => request.body), ...beacons].join('\n');
  for (const secret of SECRETS) assert.ok(!bodies.includes(secret), `"${secret}" is in a request body`);
});
// The keys of every control on screen, by where they come from (the recorder's own identityOf).
const fallbackCount = (page, label) => page.evaluate(async ([url, name]) => {
  const { CONTROL, identityOf, controlOf } = await import(url);
  const all = [...new Set([...document.querySelectorAll(CONTROL)].filter(el => el.getClientRects().length).map(el => controlOf(el)).filter(Boolean))];
  const by = {};
  const fallbacks = new Set();
  for (const el of all) {
    const { key, source } = identityOf(el);
    by[source] = (by[source] || 0) + 1;
    if (['class', 'ancestor', 'role'].includes(source)) fallbacks.add(`${key}`);
  }
  return { name, total: all.length, by, fallbacks: [...fallbacks].sort() };
}, [RECORDER, label]);

async function openUsageGroup(page) {
  await page.evaluate(() => window.H5UI.actions.openSettings('usage-data'));
  await page.locator('#h5-set-usage-data').waitFor({ state: 'visible' });
  await page.locator('#h5-usage-top .h5-usage-row').first().waitFor({ state: 'visible' });
  await settled(page);
}

async function checkGroup(page, { wide }) {
  const rows = await page.evaluate(() => [...document.querySelectorAll('#h5-usage-top .h5-usage-row')].map(row => [row.querySelector('.h5-usage-name').textContent, row.querySelector('.h5-usage-surface').textContent, row.querySelector('.h5-usage-count').textContent, `${Math.round((row.querySelector('.h5-usage-bar').getBoundingClientRect().width / row.querySelector('.h5-usage-bar').parentElement.getBoundingClientRect().width) * 100)}%`]));
  assert.deepEqual(rows.map(row => row[0]), ['Send', 'Recent sessions', 'Saved commands', 'Open session', 'Esc key', 'Wide terminal', 'Columns', 'Voice input']);
  assert.deepEqual(rows[0].slice(1), ['Bottom row · computer', '1,284', '100%']);
  assert.equal(rows[4][1], 'Key row · phone');
  assert.equal(rows[3][1], 'T-Attention');
  assert.equal(rows[6][3], '7%');
  const chips = await page.locator('#h5-usage-unused .h5-usage-chip').allTextContents();
  assert.deepEqual(chips, ['Upload image or file (computer)', 'Docs', 'Mind maps (computer)', 'Expand all (computer)', 'Refresh the page', 'Esc key'.replace('Esc', 'Tab') + ' (phone)']);
  assert.equal(await page.locator('#h5-usage-data').textContent(), '14,208 events since 2026-11-19 · kept for 90 days · 1.3 MB');
  assert.equal(await page.locator('#h5-usage-enabled').isChecked(), true);
  assert.equal(await page.locator('#h5-usage-layout-all').getAttribute('aria-pressed'), 'true');
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(width <= (wide ? 1440 : 390), `no sideways scroll: ${width}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const report = [];
  try {
    // ── Computer ──
    {
      const server = { enabled: true, requests: [], batches: [], cleared: false };
      const { context, page, errors } = await openPage(browser, { width: 1440, height: 900 }, { touch: false, server });
      await page.waitForFunction(() => window.H5UI.get().usageRecording === true);
      report.push(await fallbackCount(page, 'computer: main screen with the task list'));
      await page.locator('.h5-task-item').first().click(); // Acme merger
      await page.locator('.h5-terminal-main').first().waitFor({ state: 'visible' });
      await page.locator('.h5-terminal-main').first().click(); // Payroll shell
      await page.locator('#h5-commands').click();
      await page.locator('.h5-add-menu [data-track="h5-add-menu-command"]').first().waitFor({ state: 'visible' });
      report.push(await fallbackCount(page, 'computer: saved commands open'));
      const preset = (await page.locator('.h5-add-menu .h5-add-menu-command').first().textContent()).trim(); // a preset of commands.mjs ('claude' in a plain shell)
      await page.locator('.h5-add-menu [data-track="h5-add-menu-command"]').first().click();
      await page.locator('#h5-more').click();
      await page.locator('#h5-more-menu [role="menuitem"]').first().waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await settled(page);
      assert.equal(server.batches.length, 0, 'no request per press');
      const deadline = Date.now() + 15000;
      while (!server.batches.length && Date.now() < deadline) await page.waitForTimeout(250);
      assert.equal(server.batches.length, 1, 'one batch about 10 s after the first press');
      const sent = events(server);
      assert.deepEqual(sent.map(event => event.key), ['h5-task-item', 'h5-terminal-main', 'h5-commands', 'h5-add-menu-command', 'h5-more']);
      assert.deepEqual(sent.map(event => event.surface), ['task-list', 'task-list', 'bottom-row', 'menu:commands', 'bottom-row']);
      assert.equal(sent[3].detail, preset, 'a preset command is a fixed product string');
      for (const event of sent) assert.deepEqual([event.layout, event.input, event.view, event.pane], ['wide', 'pointer', 'sessions', false]);
      assert.equal(sent[4].device, 'local');
      const batch = JSON.parse(server.batches[0]);
      assert.ok(batch.seen.length > 10, `the controls on screen are reported too: ${batch.seen.length}`);
      // pagehide: what is buffered goes with a beacon.
      await page.locator('#h5-sidebar-toggle').click();
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
      await page.waitForFunction(() => window.beacons.length === 1);
      const beacon = await page.evaluate(() => window.beacons[0]);
      assert.equal(beacon.url, '/api/ui-events');
      assert.deepEqual(JSON.parse(beacon.text).events.map(event => event.key), ['h5-sidebar-toggle']);
      await page.locator('#h5-sidebar-toggle').click(); // the list back
      // The Settings group from a mocked summary.
      await openUsageGroup(page);
      report.push(await fallbackCount(page, 'computer: Settings > Usage data'));
      await checkGroup(page, { wide: true });
      assert.equal(await page.locator('#h5-settings-group-usage-data').getAttribute('aria-selected'), 'true');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'usage-data-computer.png') });
      // The layout filter asks for that layout.
      await page.locator('#h5-usage-layout-phone').click();
      const deadline2 = Date.now() + 5000;
      while (!server.requests.some(request => request.path === '/api/ui-events/summary?days=30&layout=narrow') && Date.now() < deadline2) await page.waitForTimeout(100);
      assert.ok(server.requests.some(request => request.path === '/api/ui-events/summary?days=30&layout=narrow'));
      await page.locator('#h5-usage-layout-all').click();
      // Export JSON downloads.
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#h5-usage-export').click()]);
      assert.match(download.suggestedFilename(), /^t-agent-usage-\d{4}-\d{2}-\d{2}\.json$/);
      // Clear asks first; Cancel keeps everything; Clear deletes.
      await page.locator('#h5-usage-clear').click();
      await page.locator('#h5-usage-clear-dialog').waitFor({ state: 'visible' });
      await settled(page);
      assert.equal(await page.locator('#h5-usage-clear-title').textContent(), 'Clear usage data?');
      assert.deepEqual(await page.locator('#h5-usage-clear-dialog .MuiDialogActions-root button').allTextContents(), ['Cancel', 'Clear']);
      await page.locator('#h5-usage-clear-cancel').click();
      await page.locator('#h5-usage-clear-dialog').waitFor({ state: 'hidden' });
      assert.equal(server.requests.filter(request => request.method === 'DELETE').length, 0);
      await page.locator('#h5-usage-clear').click();
      await page.locator('#h5-usage-clear-confirm').click();
      await page.locator('#h5-usage-top-empty').waitFor({ state: 'visible' });
      assert.equal(server.requests.filter(request => request.method === 'DELETE').length, 1);
      assert.equal(await page.locator('#h5-usage-data').textContent(), 'No events yet · kept for 90 days · 1 KB');
      assert.equal(await page.locator('#h5-usage-clear').isDisabled(), true);
      // The switch off: nothing is sent any more, not even with the beacon.
      await page.locator('#h5-usage-enabled').click();
      await page.waitForFunction(() => window.H5UI.get().usageRecording === false);
      assert.equal(server.enabled, false);
      const before = { batches: server.batches.length, beacons: await page.evaluate(() => window.beacons.length) };
      await page.locator('#h5-usage-layout-computer').click();
      await page.locator('#h5-close-settings').click();
      await page.locator('#h5-commands').click();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(11000);
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
      await page.waitForTimeout(300);
      assert.deepEqual({ batches: server.batches.length, beacons: await page.evaluate(() => window.beacons.length) }, before, 'nothing sent while off');
      await noSecrets(server, page);
      assert.deepEqual(errors, []);
      await context.close();
    }
    // ── Phone ──
    {
      const server = { enabled: true, requests: [], batches: [], cleared: false };
      const { context, page, errors } = await openPage(browser, { width: 390, height: 844 }, { touch: true, server });
      await page.waitForFunction(() => window.H5UI.get().usageRecording === true);
      await page.locator('#h5-tasks').waitFor({ state: 'visible' });
      report.push(await fallbackCount(page, 'phone: task drawer'));
      await page.locator('.h5-task-item').first().tap();
      await page.locator('.h5-terminal-main').first().waitFor({ state: 'visible' });
      await page.locator('.h5-terminal-main').first().tap();
      await page.locator('#h5-keys').waitFor({ state: 'visible' });
      await settled(page);
      report.push(await fallbackCount(page, 'phone: terminal page'));
      await page.locator('#h5-keys [data-key="Escape"]').tap();
      await page.locator('#h5-keys [data-modifier="ctrl"]').tap();
      await page.locator('#h5-cycle').tap();
      await page.locator('#h5-switcher').waitFor({ state: 'visible' });
      report.push(await fallbackCount(page, 'phone: switcher open'));
      await page.keyboard.press('Escape');
      await page.locator('#h5-switcher').waitFor({ state: 'detached' }).catch(() => {});
      const deadline = Date.now() + 15000;
      while (!server.batches.length && Date.now() < deadline) await page.waitForTimeout(250);
      const sent = events(server);
      assert.deepEqual(sent.map(event => event.key), ['h5-task-item', 'h5-terminal-main', 'key:Escape', 'mod:ctrl', 'h5-cycle']);
      assert.deepEqual(sent.map(event => event.surface), ['task-list', 'task-list', 'key-row', 'key-row', 'tool-row']);
      assert.equal(sent[3].state, 'on', 'the new state of a toggle key');
      for (const event of sent) assert.deepEqual([event.layout, event.input, event.pane], ['narrow', 'touch', false]);
      await openUsageGroup(page);
      report.push(await fallbackCount(page, 'phone: Settings > Usage data'));
      await checkGroup(page, { wide: false });
      if (SHOTS) {
        await page.screenshot({ path: path.join(SHOTS, 'usage-data-phone.png') });
        await page.locator('#h5-sec-usage-store').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(SHOTS, 'usage-data-phone-end.png') });
      }
      await noSecrets(server, page);
      assert.deepEqual(errors, []);
      await context.close();
    }
    for (const entry of report) console.log(`${entry.name}: ${entry.total} controls, by source ${JSON.stringify(entry.by)}; fallback keys: ${entry.fallbacks.join(', ') || 'none'}`);
    console.log('Usage data: batched presses with keys and context, no names in any body, the beacon on pagehide, nothing while off, the Settings group, Clear and Export passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
