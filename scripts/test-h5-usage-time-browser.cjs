// Usage time and memories on the page (scripts/h5-shell/usage-time.mjs, usage-beats.mjs, UsageTime.jsx, UsageMemories.jsx, the "Remember this"
// dialog of TaskDialogs.jsx; "Usage time and memories: the page" in docs/design/usage-time-page.md) in real Chromium with a stubbed server that follows
// the contract, on a computer (1440x900, a mouse) and a phone (390x844, touch). The page runs on Playwright's clock: beats go only while the page is
// visible and was used in the last 2 minutes, one per 15 s, in a batch (not one request per beat), with a beacon when the tab is hidden and none
// while it is hidden. Settings > Usage data: the tabs (Buttons unchanged), the Time numbers, the bars with their values and the table view, a task's
// sessions in place and a session that opens, a device that needs an update first, "Record time", Export and Clear; Memories: the list, search, the
// kind chips, the digest card and its switch, a note edited and deleted with Undo, more on scroll, Export and Clear; "Remember this" from the session
// menu, the task menu and the session header posts the note with engine-neutral ids. No task, session or device name appears in a beat.
// H5_SHOT_DIR=<dir> saves screenshots (computer 1440x900, phone 390x844 at 3x).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { settled } = require('./browser-test-wait.cjs');

const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';

const SECRETS = ['Acme merger', 'Payroll shell', 'Board deck', 'Night build', 'K01', 'Home'];
const TASKS = [{ id: 1, title: 'Acme merger', status: 'doing' }, { id: 2, title: 'Board deck', status: 'doing' }];
const TERMINALS = { 1: [{ terminal_id: 'default', title: 'Payroll shell' }, { terminal_id: 'c1', title: 'Night build', agent: 'claude' }], 2: [{ terminal_id: 'd1', title: 'Terminal 1' }] };
const GROUPS = [{ key: 'doing', name: 'In progress', sort_order: 1 }];
const DAYS = ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24'];
const SUMMARY = range => ({
  range, since: Date.UTC(2026, 10, 18), until: Date.UTC(2026, 10, 25),
  tiles: { page_s: 85200, working_s: 147900, waiting_s: 12000, learn_s: 7500, page_delta: 7800, working_delta: -3600, waiting_delta: 0, learn_delta: 900, median_wait_s: 360, learn_days: 5, away_working_s: 104400 },
  days: DAYS.map((day, i) => ({ day, sessions_s: [12240, 15120, 10080, 18360, 15840, 5760, 7920][i], learn_s: [2160, 2880, 0, 1800, 2520, 720, 1440][i], other_s: [1800, 1440, 1080, 2160, 1080, 720, 720][i] })),
  tasks: [{ task: 'inst-home:1', title: 'Acme merger', looked_s: 44400, worked_s: 100800, waiting_s: 3600 }, { task: 'inst-home:2', title: 'Board deck', looked_s: 14700, worked_s: 32400, waiting_s: 600 }],
  kinds: [{ kind: 'claude', share: 0.62 }, { kind: 'codex', share: 0.21 }, { kind: 'terminal', share: 0.12 }, { kind: 'notebook', share: 0.05 }],
  devices: [{ id: 'inst-home', name: 'Home' }],
});
const EMPTY_SUMMARY = range => ({ ...SUMMARY(range), tiles: {}, days: DAYS.map(day => ({ day, sessions_s: 0, learn_s: 0, other_s: 0 })), tasks: [], kinds: [] });
const at = (day, hour) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00`).getTime();
const MEMORIES = () => [
  { uid: 'd1', at: at('2026-11-22', 21), kind: 'digest', text: 'You spent most of the week on the merger.', week: '2026-11-16', sources: { events: 12, notes: 3, items: 6 }, source: 'auto' },
  { uid: 'e1', at: at('2026-11-24', 9), kind: 'event', event: 'attention-confirm', text: 'Confirmed: quarterly numbers', task: 'inst-home:1', session: null, source: 'auto' },
  { uid: 'n1', at: at('2026-11-24', 8), kind: 'note', text: 'The tab group stays unless ungrouped first', task: 'inst-home:1', session: 'inst-home:1:c1', source: 'user' },
  { uid: 'e2', at: at('2026-11-23', 18), kind: 'event', event: 'learn-practice', text: 'Spelling finished: 25 words, 22 right', task: null, session: null, source: 'auto' },
  { uid: 'e3', at: at('2026-11-22', 7), kind: 'event', event: 'engine-down', text: 'An engine went down for 40 min', task: null, session: null, source: 'auto' },
];
const OLDER = [{ uid: 'n0', at: at('2026-11-10', 12), kind: 'note', text: 'Older note from before', task: 'inst-home:2', session: null, source: 'user' }];
const UI_SUMMARY = {
  enabled: true, days: 30, layout: null, total: 10, top: [{ key: 'h5-translate-button', count: 10, surfaces: [{ surface: 'bottom-row', count: 10 }], layouts: { wide: 10, narrow: 0 }, details: [] }],
  unused: [], next: [], data: { count: 10, first_at: Date.UTC(2026, 10, 19), retention_days: 90, bytes: 2048 },
};

async function openPage(browser, viewport, { touch, server }) {
  const context = await browser.newContext({ viewport, acceptDownloads: true, ...(touch ? { isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' } : {}), ...(SHOTS ? { deviceScaleFactor: touch ? 3 : 1 } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date('2026-11-24T10:00:00') });
  await page.addInitScript(() => {
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send() {} close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    window.beacons = [];
    navigator.sendBeacon = (url, data) => { data.text().then(text => window.beacons.push({ url, text })); return true; };
    // The tab's visibility, set by the test.
    window.__hidden = false;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__hidden ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const p = url.pathname;
    const method = request.method();
    const body = request.postData() || '';
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
    if (p.startsWith('/api/usage-time') || p.startsWith('/api/memories')) {
      server.requests.push({ method, path: p + url.search, body });
      if (p === '/api/usage-time/settings' && method === 'GET') return json({ usage_time_record: server.record, usage_memories_digest: server.digest });
      if (p === '/api/usage-time/settings' && method === 'PUT') {
        const patch = JSON.parse(body);
        if ('usage_time_record' in patch) server.record = patch.usage_time_record;
        if ('usage_memories_digest' in patch) server.digest = patch.usage_memories_digest;
        return json({ usage_time_record: server.record, usage_memories_digest: server.digest });
      }
      if (p === '/api/usage-time/beats' && method === 'POST') { if (!server.record) return json({ ok: false }, 403); server.batches.push(JSON.parse(body)); return json({ ok: true }); }
      if (p === '/api/usage-time/summary') return json(server.timeCleared ? EMPTY_SUMMARY(url.searchParams.get('range')) : SUMMARY(url.searchParams.get('range')));
      if (p === '/api/usage-time/task') return json([{ session: 'inst-home:1:c1', title: 'Night build', kind: 'claude', looked_s: 30000, worked_s: 90000, waiting_s: 3000 }, { session: 'inst-home:1:default', title: 'Payroll shell', kind: 'terminal', looked_s: 14400, worked_s: 10800, waiting_s: 600 }]);
      if (p === '/api/usage-time/day') return json({ day: url.searchParams.get('day'), tasks: [{ task: 'inst-home:2', title: 'Board deck', looked_s: 3600, worked_s: 0, waiting_s: 0, sessions: [{ session: 'inst-home:2:d1', title: 'Terminal 1', kind: 'terminal', looked_s: 3600, worked_s: 0, waiting_s: 0 }] }] });
      if (p === '/api/usage-time/export') return route.fulfill({ status: 200, contentType: 'text/csv', headers: { 'Content-Disposition': 'attachment; filename="t-agent-time-2026-11-24.csv"' }, body: 'day,page_s\n' });
      if (p === '/api/usage-time' && method === 'DELETE') { if (url.searchParams.get('table') === 'time') server.timeCleared = true; else server.memories = []; return json({ cleared: 1 }); }
      if (p === '/api/memories' && method === 'GET') {
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const kind = url.searchParams.get('kind') || 'all';
        if (url.searchParams.get('before')) return json({ items: OLDER, has_more: false, digest_on: server.digest });
        const items = server.memories.filter(item => (kind === 'all' || item.kind === kind) && (!q || item.text.toLowerCase().includes(q)));
        return json({ items, has_more: kind === 'all' && !q, digest_on: server.digest });
      }
      if (p === '/api/memories' && method === 'POST') { const note = { uid: `n${server.memories.length + 10}`, at: Date.now(), kind: 'note', source: 'user', ...JSON.parse(body) }; server.notes.push(JSON.parse(body)); server.memories.unshift(note); return json(note); }
      if (p === '/api/memories/digest' && method === 'POST') return json(server.memories[0]);
      const one = p.match(/^\/api\/memories\/([\w-]+)$/);
      if (one && method === 'PATCH') { const item = server.memories.find(entry => entry.uid === one[1]); item.text = JSON.parse(body).text; return json(item); }
      if (one && method === 'DELETE') { server.memories = server.memories.filter(entry => entry.uid !== one[1]); return json({ ok: true }); }
    }
    if (p === '/api/ui-events/settings') return json({ enabled: false });
    if (p === '/api/ui-events/summary') return json(UI_SUMMARY);
    if (p === '/api/system/version') return json({ instance_id: 'inst-home', engine_name: 'Home', app_version: '2.160.0' });
    if (p === '/api/remote-servers') return json([{ id: 7, name: 'K01', status: 'online', base_url: 'http://10.0.0.7:14002', enabled: true, instance_id: 'inst-k01' }]);
    if (p === '/api/tasks' && method === 'GET') return json(TASKS);
    if (p === '/api/remote-servers/7/tasks' && method === 'GET') return json([]);
    if (p === '/api/task-groups' || p === '/api/remote-servers/7/task-groups') return json(GROUPS);
    if (p === '/api/tasks/terminal-activity' || p === '/api/remote-servers/7/terminal-activity') return json({});
    if (/terminal-subagents$/.test(p)) return json({});
    if (/\/terminal\/ack$/.test(p)) return json({ success: true });
    const local = p.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (local && method === 'GET') return json(TERMINALS[local[1]] || []);
    if (p === '/api/remote-servers/7/info') return json({ capabilities: ['terminal:control'] }); // an older engine: no usage:time
    if (/\/agent\/conversations$/.test(p)) return json([]);
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  await page.waitForFunction(() => window.H5UI && window.H5UI.get().usageTimeRecording === true, null, { timeout: 15000 });
  await page.waitForFunction(() => (window.H5UI.get().taskList.tasks || []).length === 2, null, { timeout: 15000 });
  await page.waitForFunction(() => (window.H5UI.get().sources || []).some(from => from.key === 'remote:7' && Array.isArray(from.capabilities)), null, { timeout: 15000 });
  return { context, page, errors };
}

const beats = server => server.batches.flatMap(batch => batch.beats);
const wait = async (check, label, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error(`timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 50)); }
};
const press = (page, touch, locator) => (touch ? locator.tap() : locator.click());

async function checkBeats(page, server, { touch }) {
  // The taps that opened the session were activity: their beats go out once the page has been idle a while. Then nothing more without activity.
  await page.clock.runFor(300000);
  await wait(() => server.batches.length === 1, 'the beats of the taps that opened the session');
  assert.ok(beats(server).length >= 1 && beats(server).length <= 9, `beats of the opening taps: ${beats(server).length}`);
  await page.clock.runFor(120000);
  await page.waitForTimeout(100);
  const start = server.batches.length;
  const was = beats(server).length;
  assert.equal(start, 1, 'no beat without activity');
  // Active: one beat per 15 s, in one batch 2 minutes after the first (not one request per beat).
  await page.mouse.move(300, 300);
  await page.keyboard.press('Shift');
  await page.clock.runFor(120000);
  await page.waitForTimeout(100);
  assert.equal(server.batches.length, start, 'no request per beat');
  await page.clock.runFor(15000);
  await wait(() => server.batches.length === start + 1, 'the batch of the activity');
  const first = server.batches[start].beats;
  assert.equal(first.length, 8, `8 beats in 2 minutes: ${first.length}`);
  assert.ok(first.every(beat => beat.seconds === 15 && beat.surface === 'sessions'));
  assert.deepEqual([first[0].task, first[0].session, first[0].kind], ['inst-home:1', 'inst-home:1:c1', 'claude']);
  assert.deepEqual(Object.keys(first[0]).sort(), ['at', 'kind', 'seconds', 'session', 'surface', 'task']);
  assert.equal(server.batches[start].client, touch ? 'phone' : 'computer');
  assert.ok(first.every((beat, i) => !i || beat.at - first[i - 1].at === 15000), 'every 15 s');
  // Idle: no activity for more than 2 minutes, no beat.
  await page.clock.runFor(180000);
  await page.waitForTimeout(100);
  assert.equal(beats(server).length, was + 8, 'idle: no beats');
  // A hidden tab: what was queued goes with a beacon, and nothing while hidden even with activity.
  await page.keyboard.press('Shift');
  await page.clock.runFor(30000);
  await page.evaluate(() => { window.__hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => window.beacons.length === 1);
  const beacon = await page.evaluate(() => window.beacons[0]);
  assert.equal(beacon.url, '/api/usage-time/beats');
  assert.equal(JSON.parse(beacon.text).beats.length, 2);
  await page.keyboard.press('Shift');
  await page.clock.runFor(150000);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.beacons.length), 1, 'never a beat from a hidden tab');
  assert.equal(beats(server).length, was + 8);
  await page.evaluate(() => { window.__hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  // No name in any beat.
  const bodies = JSON.stringify(server.batches) + beacon.text;
  for (const secret of SECRETS) assert.ok(!bodies.includes(secret), `"${secret}" is in a beat`);
}

async function openGroup(page, tab) {
  // Opened afresh (the group reads its data each time it is shown).
  if (await page.evaluate(() => window.H5UI.get().settingsOpen)) {
    await page.evaluate(() => window.H5UI.actions.closeSettings());
    await page.waitForFunction(() => !document.querySelector('#h5-set-usage-data') || !document.querySelector('#h5-set-usage-data').checkVisibility());
  }
  await page.evaluate(() => window.H5UI.actions.openSettings('usage-data'));
  await page.locator('#h5-set-usage-data').waitFor({ state: 'visible' });
  await settled(page);
  if (tab) {
    await page.locator(`#h5-usage-tab-${tab}`).click();
    await page.locator(`#h5-usage-panel-${tab}`).waitFor({ state: 'visible' });
  }
}

async function checkTime(page, server, { touch, wide }) {
  await openGroup(page, 'buttons');
  // Buttons: the existing parts, unchanged.
  await page.locator('#h5-usage-top .h5-usage-row').first().waitFor({ state: 'visible' });
  assert.deepEqual(await page.locator('#h5-usage-tabs [role="tab"]').allTextContents(), ['Buttons', 'Time', 'Memories']);
  assert.equal(await page.locator('#h5-usage-top .h5-usage-name').first().textContent(), 'Send');
  assert.equal(await page.locator('#h5-usage-data').textContent(), '10 events since 2026-11-19 · kept for 90 days · 2 KB');
  await press(page, touch, page.locator('#h5-usage-tab-time'));
  await page.locator('#h5-usage-tiles .h5-usage-tile').first().waitFor({ state: 'visible' });
  assert.equal(await page.locator('#h5-usage-tab-time').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#h5-usage-panel-buttons').isHidden(), true);
  const tileText = await page.evaluate(() => [...document.querySelectorAll('#h5-usage-tiles .h5-usage-tile')].map(tile => [...tile.children].map(child => child.textContent)));
  assert.deepEqual(tileText, [
    ['On the page', '23 h 40 min', '+2 h 10 min vs last week'],
    ['Agents working', '41 h 05 min', '−1 h vs last week', 'while you were away: 29 h'],
    ['Waiting for you', '3 h 20 min', 'Same as last week', 'median wait 6 min'],
    ['Learn English', '2 h 05 min', '+15 min vs last week', '5 of 7 days'],
  ]);
  assert.equal(await page.locator('#h5-usage-range-week').getAttribute('aria-pressed'), 'true');
  // The bars: seven days, each with its values in words (hover / focus), the highest one full height.
  const days = page.locator('#h5-usage-bars .h5-usage-day');
  assert.equal(await days.count(), 7);
  assert.equal(await days.nth(3).getAttribute('aria-label'), 'Sat 11-21: Sessions 5 h 06 min, Learn 30 min, Other 36 min');
  // Each day's parts stacked (Sessions at the bottom), their heights in the share of their seconds; the highest day is the tallest.
  const stacks = await page.evaluate(() => [...document.querySelectorAll('#h5-usage-bars .h5-usage-day')].map(day => [...day.querySelectorAll('.h5-usage-part')].map(part => ({ part: part.dataset.part, top: Math.round(part.getBoundingClientRect().top), height: Math.round(part.getBoundingClientRect().height) }))));
  const heights = stacks.map(parts => parts.reduce((sum, part) => sum + part.height, 0));
  assert.equal(Math.max(...heights), heights[3], `the highest day is the tallest: ${heights}`);
  assert.deepEqual(stacks[3].map(part => part.part), ['sessions_s', 'learn_s', 'other_s']);
  assert.ok(stacks[3][0].top > stacks[3][1].top && stacks[3][1].top > stacks[3][2].top, 'Sessions at the bottom, Other at the top');
  assert.ok(Math.abs(stacks[3][0].height / heights[3] - 18360 / 22320) < 0.05, `Sessions' share of the day: ${JSON.stringify(stacks[3])}`);
  if (!touch) {
    await days.nth(3).hover();
    await page.locator('.MuiTooltip-tooltip').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.MuiTooltip-tooltip').textContent(), 'Sat 11-21: Sessions 5 h 06 min, Learn 30 min, Other 36 min');
    await page.mouse.move(5, 5);
  }
  assert.deepEqual(await page.locator('#h5-usage-legend').innerText().then(text => text.split(/\s+/).filter(Boolean)), ['Sessions', 'Learn', 'Other']);
  if (SHOTS) {
    await page.locator('#h5-usage-tabs').scrollIntoViewIfNeeded();
    await page.evaluate(() => document.querySelector('#h5-usage-tabs').scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: path.join(SHOTS, `usage-time-${wide ? 'computer' : 'phone'}.png`) });
    if (!wide) { await page.locator('#h5-sec-usage-time-tasks').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(SHOTS, 'usage-time-phone-2.png') }); }
  }
  // The same as a table.
  await press(page, touch, page.locator('#h5-usage-days-table'));
  const row = await page.locator('.h5-usage-day-row').nth(3).locator('td').allTextContents();
  assert.deepEqual(row, ['Sat 11-21', '5 h 06 min', '30 min', '36 min']);
  // A day opens its sessions in place.
  await press(page, touch, page.locator('.h5-usage-day-row').nth(6).locator('button'));
  await page.locator('#h5-usage-day-sessions .h5-usage-session').first().waitFor({ state: 'visible' });
  assert.ok(server.requests.some(r => r.path.startsWith('/api/usage-time/day?day=2026-11-24')));
  await press(page, touch, page.locator('#h5-usage-days-chart'));
  // Tasks: looked at / worked, and a click shows its sessions.
  assert.deepEqual(await page.locator('#h5-usage-tasks .h5-usage-task-text').allTextContents(), ['12 h 20 min / 28 h', '4 h 05 min / 9 h']);
  assert.deepEqual(await page.locator('#h5-usage-tasks .h5-usage-task-name').allTextContents(), ['Acme merger', 'Board deck']);
  assert.match(await page.locator('#h5-usage-time-hint').textContent(), /Kinds of session: Claude 62%, Codex 21%, terminals 12%, notebooks 5%\./);
  await press(page, touch, page.locator('.h5-usage-task').first());
  await page.locator('#h5-usage-task-sessions .h5-usage-session').first().waitFor({ state: 'visible' });
  assert.ok(server.requests.some(r => r.path === '/api/usage-time/task?task=inst-home%3A1&range=week&device=all'));
  assert.deepEqual(await page.locator('#h5-usage-task-sessions .h5-usage-session-name').allTextContents(), ['Night build', 'Payroll shell']);
  assert.equal(await page.locator('.h5-usage-task').first().getAttribute('aria-expanded'), 'true');
  // The device chip: All devices, Home, and K01 that needs an update first.
  assert.equal(await page.locator('#h5-usage-time-old').textContent(), 'K01 needs an update first');
  await press(page, touch, page.locator('#h5-usage-device'));
  await page.locator('#h5-usage-device-menu .h5-usage-device-choice').first().waitFor({ state: 'visible' });
  const choices = await page.locator('#h5-usage-device-menu .h5-usage-device-choice').allInnerTexts();
  assert.deepEqual(choices.map(text => text.replace(/\s+/g, ' ').trim()), ['All devices', 'Home', 'K01 needs an update first']);
  assert.equal(await page.locator('#h5-usage-device-menu [data-device="inst-k01"]').getAttribute('aria-disabled'), 'true');
  await press(page, touch, page.locator('#h5-usage-device-menu [data-device="inst-home"]'));
  await wait(() => server.requests.some(r => r.path === '/api/usage-time/summary?range=week&device=inst-home'), 'the summary of one device');
  // A range.
  await press(page, touch, page.locator('#h5-usage-range-today'));
  await wait(() => server.requests.some(r => r.path === '/api/usage-time/summary?range=today&device=inst-home'), 'the summary of today');
  await page.locator('#h5-usage-range-today[aria-pressed="true"]').waitFor();
  if (touch) {
    const small = await page.evaluate(() => [...document.querySelectorAll('#h5-usage-panel-time .MuiChip-root, #h5-usage-panel-time .h5-usage-task, #h5-usage-panel-time button.MuiButton-root')]
      .filter(el => el.getClientRects().length).map(el => el.getBoundingClientRect()).filter(box => box.height < 43.5).length);
    assert.equal(small, 0, 'touch targets of at least 44px');
  }
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(width <= (wide ? 1440 : 390), `no sideways scroll: ${width}`);
  // Export and Clear.
  assert.equal(await page.locator('#h5-usage-time-export').getAttribute('href'), '/api/usage-time/export?table=time&format=json');
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#h5-usage-time-export-csv').click()]);
  assert.match(download.suggestedFilename(), /^t-agent-time-\d{4}-\d{2}-\d{2}\.csv$/);
  await press(page, touch, page.locator('#h5-usage-time-clear'));
  await page.locator('#h5-usage-time-clear-dialog').waitFor({ state: 'visible' });
  await settled(page);
  assert.deepEqual(await page.locator('#h5-usage-time-clear-dialog .MuiDialogActions-root button').allTextContents(), ['Cancel', 'Clear']);
  await press(page, touch, page.locator('#h5-usage-time-clear-confirm'));
  await page.locator('#h5-usage-tasks-empty').waitFor({ state: 'visible' });
  assert.ok(server.requests.some(r => r.method === 'DELETE' && r.path === '/api/usage-time?table=time'));
  server.timeCleared = false;
}

async function checkMemories(page, server, { touch, wide }) {
  await press(page, touch, page.locator('#h5-usage-tab-memories'));
  await page.locator('#h5-memories-list .h5-memory').first().waitFor({ state: 'visible' });
  // The digest card, then the list without it; each entry with its date, its kind in words and where it belongs.
  assert.equal(await page.locator('#h5-memories-digest-title').textContent(), 'This week, in short');
  assert.equal(await page.locator('#h5-memories-digest-when').textContent(), 'written Sun 21:00');
  assert.equal(await page.locator('#h5-memories-digest-open').textContent(), 'Open the 6 tasks');
  // The notes "Remember this" saved before come first (newest), and older entries follow as the end of the list is in view.
  const rows = await page.evaluate(() => ['e1', 'n1', 'e2', 'e3'].map(uid => document.querySelector(`#h5-memories-list .h5-memory[data-uid="${uid}"]`)).map(item => [item.querySelector('.h5-memory-date').textContent, item.querySelector('.h5-memory-text').textContent, item.querySelector('.h5-memory-where').textContent]));
  assert.deepEqual(rows, [
    ['11-24', 'Confirmed: quarterly numbers', 'Task Acme merger · event'],
    ['11-24', 'The tab group stays unless ungrouped first', 'Acme merger · Night build · your note'],
    ['11-23', 'Spelling finished: 25 words, 22 right', 'Learn · event'],
    ['11-22', 'An engine went down for 40 min', 'Engines · event'],
  ]);
  // The digest switch, off by default, with what it sends.
  assert.equal(await page.locator('#h5-memories-digest-enabled').isChecked(), false);
  assert.match(await page.locator('#h5-sec-usage-digest').textContent(), /No terminal text or code is sent\./);
  await press(page, touch, page.locator('#h5-memories-digest-enabled'));
  await wait(() => server.digest === true, 'the digest switch saved');
  await press(page, touch, page.locator('#h5-memories-digest-again'));
  await wait(() => server.requests.some(r => r.method === 'POST' && r.path === '/api/memories/digest' && JSON.parse(r.body).week === '2026-11-16'), 'write it again');
  assert.equal(await page.locator('#h5-memories-list .h5-memory').first().locator('.h5-memory-text').textContent(), 'From the header');
  assert.equal(await page.locator('#h5-memories-list .h5-memory[data-uid="d1"]').count(), 0, 'the digest is the card, not a row');
  // More as the end of the list comes into view.
  await page.locator('#h5-memories-more').scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {}); // it may have loaded already
  await page.locator('.h5-memory[data-uid="n0"]').waitFor({ state: 'attached' });
  assert.ok(server.requests.some(r => r.path.includes('before=')));
  // Search and the kind chips.
  await page.locator('#h5-memories-search').fill('tab group');
  await wait(() => server.requests.some(r => r.path.startsWith('/api/memories?q=tab%20group&kind=all')), 'the search');
  await page.waitForFunction(() => document.querySelectorAll('#h5-memories-list .h5-memory').length === 1);
  await page.locator('#h5-memories-search').fill('');
  await press(page, touch, page.locator('#h5-memories-kind-note'));
  await wait(() => server.requests.some(r => r.path.startsWith('/api/memories?q=&kind=note')), 'the kind chip');
  await page.waitForFunction(() => [...document.querySelectorAll('#h5-memories-list .h5-memory')].every(item => item.dataset.kind === 'note'));
  // A note edited, then deleted with Undo, then deleted for good.
  await press(page, touch, page.locator('.h5-memory[data-uid="n1"] .h5-memory-edit-button'));
  await page.locator('#h5-memory-edit-text').fill('The tab group stays in the bar');
  await press(page, touch, page.locator('#h5-memory-edit-save'));
  await page.locator('.h5-memory[data-uid="n1"] .h5-memory-text').filter({ hasText: 'The tab group stays in the bar' }).waitFor();
  assert.ok(server.requests.some(r => r.method === 'PATCH' && r.path === '/api/memories/n1' && JSON.parse(r.body).text === 'The tab group stays in the bar'));
  await press(page, touch, page.locator('.h5-memory[data-uid="n1"] .h5-memory-delete'));
  await page.locator('.h5-memory[data-uid="n1"]').waitFor({ state: 'detached' });
  await page.locator('.MuiSnackbar-root button', { hasText: 'Undo' }).click();
  await page.locator('.h5-memory[data-uid="n1"]').waitFor({ state: 'visible' });
  await page.clock.runFor(8000);
  await page.waitForTimeout(100);
  assert.ok(!server.requests.some(r => r.method === 'DELETE' && r.path === '/api/memories/n1'), 'Undo keeps the note');
  await press(page, touch, page.locator('.h5-memory[data-uid="n1"] .h5-memory-delete'));
  await page.clock.runFor(7000);
  await wait(() => server.requests.some(r => r.method === 'DELETE' && r.path === '/api/memories/n1'), 'the delete after the Undo time');
  if (SHOTS) {
    await press(page, touch, page.locator('#h5-memories-kind-all'));
    await page.locator('#h5-memories-digest').waitFor();
    await page.locator('#h5-memories-search').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, `usage-memories-${wide ? 'computer' : 'phone'}.png`) });
  }
  // A click on an entry opens its session.
  await press(page, touch, page.locator('#h5-memories-kind-all'));
  await page.locator('.h5-memory[data-uid="e1"]').waitFor();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(width <= (wide ? 1440 : 390), `no sideways scroll: ${width}`);
  // Export and Clear.
  assert.equal(await page.locator('#h5-memories-export').getAttribute('href'), '/api/usage-time/export?table=memories&format=json');
  await press(page, touch, page.locator('#h5-memories-clear'));
  await page.locator('#h5-memories-clear-dialog').waitFor({ state: 'visible' });
  await settled(page);
  await press(page, touch, page.locator('#h5-memories-clear-cancel'));
  await page.locator('#h5-memories-clear-dialog').waitFor({ state: 'hidden' });
  assert.ok(!server.requests.some(r => r.method === 'DELETE' && r.path === '/api/usage-time?table=memories'));
  await press(page, touch, page.locator('.h5-memory[data-uid="e1"] .h5-memory-open'));
  await page.waitForFunction(() => !window.H5UI.get().settingsOpen);
}

// "Remember this" from a menu: the dialog of the design, then the note in the request.
async function remember(page, server, touch, open, text) {
  await open();
  await page.locator('#h5-task-dialog.h5-remember-dialog').waitFor({ state: 'visible' });
  await settled(page);
  assert.equal(await page.locator('#h5-task-dialog-title').textContent(), 'Remember this');
  assert.equal(await page.locator('#h5-remember-caption').textContent(), 'Saves a note with the time and this task and session. The terminal text is not saved.');
  assert.deepEqual(await page.locator('#h5-task-dialog .MuiDialogActions-root button').allTextContents(), ['Cancel', 'Save']);
  assert.equal(await page.locator('#h5-task-dialog-ok').isDisabled(), true, 'nothing to save yet');
  await page.locator('#h5-remember-text').fill(text);
  await press(page, touch, page.locator('#h5-task-dialog-ok'));
  await page.locator('#h5-task-dialog').waitFor({ state: 'detached' });
  return server.notes[server.notes.length - 1];
}

async function checkRemember(page, server, { touch }) {
  const tasks = async () => { if (touch && !(await page.locator('#h5-tasks').isVisible())) { await page.evaluate(() => window.H5UI.actions.openTasks()); await page.locator('#h5-tasks .h5-task-item').first().waitFor({ state: 'visible' }); await settled(page); } };
  // The session's "⋯" in the task list.
  await tasks();
  let note = await remember(page, server, touch, async () => {
    await press(page, touch, page.locator('.h5-terminal-row[data-session="c1"] .h5-terminal-more'));
    await press(page, touch, page.locator('#h5-session-menu [role="menuitem"]', { hasText: 'Remember this' }));
  }, 'Night build: the flaky test is the clock');
  assert.deepEqual(note, { text: 'Night build: the flaky test is the clock', task: 'inst-home:1', session: 'inst-home:1:c1' });
  // The task's "⋯": the task only.
  await tasks();
  note = await remember(page, server, touch, async () => {
    await press(page, touch, page.locator('.h5-task-more').nth(1));
    await press(page, touch, page.locator('#h5-session-menu [role="menuitem"]', { hasText: 'Remember this' }));
  }, 'Board deck goes out on Friday');
  assert.deepEqual(note, { text: 'Board deck goes out on Friday', task: 'inst-home:2' });
  // The session header's More, while a session is shown.
  if (touch) await page.evaluate(() => window.H5UI.actions.closeTasks && window.H5UI.actions.closeTasks());
  await page.waitForFunction(() => Boolean(window.H5UI.get().shownTarget));
  note = await remember(page, server, touch, async () => {
    await press(page, touch, page.locator('#h5-header-more'));
    await press(page, touch, page.locator('#h5-header-remember'));
  }, 'From the header');
  assert.equal(note.task, 'inst-home:1');
  assert.match(note.session, /^inst-home:1:/);
  // Cancel saves nothing.
  const count = server.notes.length;
  await press(page, touch, page.locator('#h5-header-more'));
  await press(page, touch, page.locator('#h5-header-remember'));
  await page.locator('#h5-task-dialog.h5-remember-dialog').waitFor({ state: 'visible' });
  await page.locator('#h5-remember-text').fill('not this one');
  await press(page, touch, page.locator('#h5-task-dialog-cancel'));
  await page.locator('#h5-task-dialog').waitFor({ state: 'detached' });
  assert.equal(server.notes.length, count);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const [name, viewport, touch] of [['computer', { width: 1440, height: 900 }, false], ['phone', { width: 390, height: 844 }, true]]) {
      const server = { record: true, digest: false, requests: [], batches: [], notes: [], memories: MEMORIES(), timeCleared: false };
      const { context, page, errors } = await openPage(browser, viewport, { touch, server });
      // A session shown (Acme merger, Night build): the beats name it.
      if (touch && !(await page.locator('#h5-tasks').isVisible())) await page.evaluate(() => window.H5UI.actions.openTasks());
      await press(page, touch, page.locator('.h5-task-item').first());
      await page.locator('.h5-terminal-row[data-session="c1"] .h5-terminal-main').waitFor({ state: 'visible' });
      await press(page, touch, page.locator('.h5-terminal-row[data-session="c1"] .h5-terminal-main'));
      await page.waitForFunction(() => window.H5UI.get().shownTarget && window.H5UI.get().shownTarget.terminalId === 'c1');
      await page.waitForFunction(() => window.H5UI.get().terminalAgent === 'claude');
      await checkBeats(page, server, { touch });
      await checkRemember(page, server, { touch });
      await checkTime(page, server, { touch, wide: !touch });
      // A session of a task opens from the Time tab and Settings closes.
      await openGroup(page, null);
      await press(page, touch, page.locator('#h5-usage-tab-time'));
      await press(page, touch, page.locator('.h5-usage-task').nth(1));
      await page.locator('#h5-usage-task-sessions .h5-usage-session').first().waitFor({ state: 'visible' });
      await press(page, touch, page.locator('#h5-usage-task-sessions .h5-usage-session').first());
      await page.waitForFunction(() => !window.H5UI.get().settingsOpen);
      await page.waitForFunction(() => window.H5UI.get().shownTarget && window.H5UI.get().shownTarget.terminalId === 'c1');
      await openGroup(page, null);
      await checkMemories(page, server, { touch, wide: !touch });
      // "Record time" off: saved, and the page stops sending.
      await openGroup(page, null);
      await press(page, touch, page.locator('#h5-usage-tab-time'));
      await page.locator('#h5-usage-time-enabled').waitFor();
      await page.waitForFunction(() => !document.querySelector('#h5-usage-time-enabled').disabled);
      await press(page, touch, page.locator('#h5-usage-time-enabled'));
      await page.waitForFunction(() => window.H5UI.get().usageTimeRecording === false);
      assert.equal(server.record, false);
      const before = server.batches.length;
      const beaconsBefore = await page.evaluate(() => window.beacons.length);
      await page.keyboard.press('Shift');
      await page.clock.runFor(150000);
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
      await page.waitForTimeout(100);
      assert.equal(server.batches.length, before, 'nothing sent while off');
      assert.equal(await page.evaluate(() => window.beacons.length), beaconsBefore);
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`${name}: beats, the Time tab, the Memories tab and "Remember this" passed`);
    }
    console.log('Usage time and memories: beats only while visible and active, batches and the beacon, the tabs, the numbers, the chart and table, sessions in place, a device that needs an update, the switches, Export and Clear, memories with search, kinds, the digest, edit and delete with Undo, and "Remember this" passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
