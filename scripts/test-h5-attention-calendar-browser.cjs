// The calendar view of T-Attention on the page (scripts/h5-shell/AttentionCalendar.jsx, calendar-model.mjs; "Calendar view" in
// docs/design/page-attention-calendar.md), in real Chromium with the API mocked by Playwright routes (the engine's own rules,
// services/attention-schedule.js, give the next times of what is saved), a fake EventSource per stream and a fixed clock (Thursday 2026-11-26 10:00,
// Asia/Taipei):
// - phone 390 touch: List | Calendar (remembered in the shared page state), the month (Sunday first, 35 cells), dots of each kind, today, the agenda
//   of a day in its order, the lunar date, previous / next / Today, "N to do without a date" and its dialog, a row opening the edit view, the New event
//   dialog: a lunar birthday (the next birthday card, the POST body, the title) and an anniversary, both then on the calendar and in the list's Recurring
//   section with "Every year · … · turns N"; editing a yearly item ("Every year" in the edit view, the PATCH); 44px targets and no horizontal overflow;
// - computer 1440 mouse: the sheet takes the window right of the rail, chips in the cells with "+N more", the lunar day in the corner, the 320px day
//   panel with Coming up, the arrow keys and Page Down, New event: a one-off with the When fields, and an engine without `attention:yearly` (no
//   Birthday / Anniversary, "This computer needs an update first");
// - Chinese: the month and day titles, the weekday letters and the lunar words.
// H5_SHOT_DIR=<dir> saves screenshots (cal-*.png).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const rules = require('../services/attention-schedule');
const lunar = require('../lib/lunar');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TZ = 'Asia/Taipei';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const NOW_MS = Date.parse('2026-11-26T10:00:00+08:00'); // Thursday, 10:00 in Taipei
const AT = '2026-11-20T00:00:00.000Z';
const SHEET = '#h5-attention-sheet';

const NONE = { schedule: null, then_action: null, next_at: null, schedule_state: null, runs: 0, last_fired_at: null, last_done_at: null, due_date: null };
const withNext = item => {
  if (!item.schedule) return item;
  const schedule = rules.normalizeSchedule(item.schedule, { tz: TZ, starts: '2026-11-26' });
  const next = rules.nextOccurrence(schedule, NOW_MS);
  return { ...item, schedule, schedule_state: item.schedule_state || 'waiting', next_at: next ? new Date(next).toISOString() : null };
};
const node = (id, title, extra = {}) => withNext({ id, title, status: 'todo', parent_id: null, sort_order: 100 - id, custom_status: null, result: null, priority: 'none', source: 'user', updated_at: AT, created_at: AT, ...NONE, ...extra });
const repeat = (rule, extra = {}) => ({ kind: 'repeat', rule, tz: TZ, ...extra });
const LOCAL_ITEMS = () => [
  node(1, 'Call the dentist', { schedule: { kind: 'once', at: '2026-11-26T10:00', tz: TZ } }),
  node(2, 'Water the plants', { schedule: repeat({ freq: 'every', interval: 3, time: '18:00' }, { starts: '2026-11-02' }) }),
  node(3, 'Weekly review', { schedule: repeat({ freq: 'weekly', days: [1], time: '09:00' }) }),
  node(4, "Mom's birthday", { schedule: repeat({ freq: 'yearly', calendar: 'lunar', month: 10, day: 7, occasion: 'birthday', year: 1964, time: '09:00' }) }),
  node(5, 'Wedding anniversary', { schedule: repeat({ freq: 'yearly', calendar: 'solar', month: 11, day: 12, occasion: 'anniversary', year: 2018, time: '09:00' }) }),
  node(6, 'Send the invoice', { due_date: '2026-11-26' }),
  node(7, 'Pay rent', { due_date: '2026-11-28' }),
  node(8, 'Release 2.0'),
  node(9, 'Allow Bash', { status: 'waiting_user', source: 'claude', attention_reason: 'Claude needs your permission' }),
  node(10, 'Old errand', { due_date: '2026-11-21', status: 'done' }),
];
const REMOTE_ITEMS = () => [node(1, 'Deploy check', { schedule: repeat({ freq: 'weekly', days: [2], time: '08:00' }) })];

function makeWorld({ k01Yearly = true } = {}) {
  return {
    k01Yearly, calls: [], errors: [], nextId: 50,
    dbs: { '/api/attention': { items: LOCAL_ITEMS(), host: 'mac', instance: 'inst-local' }, '/api/remote-servers/7/attention': { items: REMOTE_ITEMS(), host: 'k01', instance: 'inst-k01' } },
  };
}

async function attention(world, base, rest, method, body, json) {
  const db = world.dbs[base];
  if (rest === '' && method === 'GET') return json({ items: db.items, host: db.host, instance_id: db.instance });
  if (rest === '' && method === 'POST') {
    const item = node(world.nextId += 1, body.title, { schedule: body.schedule || null, then_action: body.then_action || null, updated_at: new Date(NOW_MS + 1000).toISOString() });
    db.items.push(item);
    return json(item, 201);
  }
  if (rest === '/schedule/preview' && method === 'POST') {
    const answer = rules.preview(body.schedule, NOW_MS, { tz: TZ });
    return json(answer);
  }
  const one = rest.match(/^\/(\d+)$/);
  if (!one) return json({ error: 'not mocked' }, 404);
  const index = db.items.findIndex(entry => entry.id === Number(one[1]));
  if (method === 'GET') return json({ item: db.items[index], events: [] });
  if (method === 'PATCH') {
    db.items[index] = withNext({ ...db.items[index], ...body, schedule_state: null, updated_at: new Date(NOW_MS + 5000).toISOString() });
    return json({ ...db.items[index] });
  }
  return json({ error: 'not mocked' }, 404);
}

async function serve(world, route) {
  const request = route.request();
  const url = new URL(request.url());
  const p = url.pathname;
  const method = request.method();
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
  if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
  if (p === '/api/system/version') return json({ engine_name: 'Air', instance_id: 'inst-local' });
  if (p === '/api/remote-servers') return json([{ id: 7, name: 'K01', status: 'online', enabled: true, instance_id: 'inst-k01' }]);
  if (p === '/api/task-list/hidden-devices') return json({ hidden: [] });
  if (p === '/api/tasks' && method === 'GET') return json([{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login', archived_at: null }]);
  if (p === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
  if (p === '/api/tasks/1/terminals') return json([{ terminal_id: 't1', title: 'Claude 1' }]);
  if (/\/agent\/conversations$/.test(p)) return json([]);
  const body = request.postData() ? JSON.parse(request.postData()) : undefined;
  if (p.startsWith('/api/attention')) {
    world.calls.push({ method, path: p + url.search, body });
    return attention(world, '/api/attention', p.slice('/api/attention'.length), method, body, json);
  }
  const remote = p.match(/^\/api\/remote-servers\/7(\/.*)$/);
  if (remote) {
    const rest = remote[1];
    if (rest.startsWith('/attention')) {
      world.calls.push({ method, path: p + url.search, body, remote: 7 });
      return attention(world, '/api/remote-servers/7/attention', rest.slice('/attention'.length), method, body, json);
    }
    if (rest === '/info') return json({ capabilities: ['attention:remote', 'attention:schedule', 'terminal:control', ...(world.k01Yearly ? ['attention:yearly'] : [])] });
    if (rest === '/tasks' && method === 'GET') return json([{ id: 1, title: 'Deploy site', status: 'doing', work_dir: '/srv/site', archived_at: null }]);
    if (rest === '/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (rest === '/tasks/1/terminals') return json([{ terminal_id: 'r1', title: 'ONCALL-CC' }]);
    if (/terminal-activity$|terminal-subagents$/.test(rest)) return json({});
    return json({ error: 'not mocked' }, 404);
  }
  if (/terminal-activity$|terminal-subagents$/.test(p)) return json({});
  return json({ error: 'not mocked' }, 404);
}

async function openPage(browser, world, { viewport, touch = true, zh = false }) {
  const scale = SHOTS ? { deviceScaleFactor: touch ? 3 : 1 } : {};
  const context = await browser.newContext({ viewport, timezoneId: TZ, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...scale });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(NOW_MS));
  page.on('pageerror', error => world.errors.push(error.message));
  await page.addInitScript(({ zh: chinese }) => {
    window.WebSocket = class {
      constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send() {}
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    window.streams = [];
    window.EventSource = class extends EventTarget {
      constructor(url) { super(); this.url = url; this.readyState = 0; window.streams.push(this); setTimeout(() => { if (this.readyState !== 2) { this.readyState = 1; this.dispatchEvent(new Event('open')); } }, 0); }
      close() { this.readyState = 2; }
    };
    window.openStreams = pathname => window.streams.filter(s => s.readyState === 1 && new URL(s.url, location.href).pathname === pathname);
    window.AudioContext = class {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
      resume() { return Promise.resolve(); }
      createOscillator() { return { type: '', frequency: {}, connect() {}, start() {}, stop() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    };
    try { if (chinese) localStorage.setItem('ta-lang', 'zh'); } catch { /* none */ }
  }, { zh });
  await page.route(`${ORIGIN}/**`, route => serve(world, route));
  await page.goto(`${ORIGIN}/h5`);
  const how = touch ? 'tap' : 'click';
  const terminal = page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main').first();
  if (!(await terminal.isVisible())) await page.locator('.h5-task-item', { hasText: 'Fix login' })[how]();
  await terminal[how]();
  await page.waitForFunction(() => innerWidth >= 900 || !document.body.classList.contains('h5-tasks-open') && Math.abs(document.getElementById('h5-app').getBoundingClientRect().left) < 0.5);
  await page.waitForFunction(() => document.getElementById('h5-attention') && window.openStreams('/api/attention/stream').length === 1);
  await page.waitForFunction(() => window.openStreams('/api/remote-servers/7/attention/stream').length === 1);
  return { context, page };
}

async function openSheet(page, how) {
  if (how === 'click' && await page.locator('#h5-more').isVisible()) await page.locator('#h5-more').click();
  await page.locator('#h5-attention')[how]();
  await page.locator('#h5-more-menu .MuiBackdrop-root').waitFor({ state: 'hidden' });
  await page.locator(`${SHEET} .h5-attention-panel`).waitFor({ state: 'visible' });
  await page.waitForFunction(sheet => { const el = document.querySelector(`${sheet} .h5-attention-panel`); return el && ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(el).transform); }, SHEET);
  await page.locator(`${SHEET} #h5-attention-view`).waitFor();
}
const cell = (page, date) => page.locator(`${SHEET} .h5-cal-cell[data-date="${date}"]`);
const dotsOf = (page, date) => cell(page, date).locator('.h5-cal-dot').evaluateAll(els => els.map(el => el.dataset.kind));
const agenda = page => page.locator('#h5-cal-agenda .h5-cal-event').evaluateAll(els => els.map(el => [el.dataset.key, el.querySelector('.h5-cal-event-time').textContent, el.querySelector('.h5-cal-event-title').textContent, el.querySelector('.h5-cal-event-line').textContent]));
const last = (world, method, test = () => true) => world.calls.filter(call => call.method === method && test(call)).at(-1);
const shared = (page, key) => page.evaluate(name => (window.TAPageState ? window.TAPageState.store.getItem(name) : localStorage.getItem(name)), key);
const noOverflow = (page, scope) => page.evaluate(sel => { const panel = document.querySelector(sel); return [...panel.querySelectorAll('*')].filter(el => { const r = el.getBoundingClientRect(); return r.width && r.right > innerWidth + 0.5; }).map(el => el.className.toString().split(' ')[0] || el.tagName); }, scope);
const small = (page, scope) => page.evaluate(sel => [...document.querySelectorAll(`${sel} button, ${sel} input, ${sel} select, ${sel} textarea`)]
  .filter(el => el.offsetParent !== null && !['radio', 'checkbox'].includes(el.type))
  .map(el => { const r = (el.closest('.MuiInputBase-root') || el).getBoundingClientRect(); return { id: el.id || el.className.split(' ')[0], w: r.width, h: r.height }; })
  .filter(r => r.w && (r.w < 44 || r.h < 44)), scope);
const quiet = async page => { for (const button of await page.locator('.MuiSnackbar-root button[aria-label="Close"], .MuiSnackbar-root .MuiAlert-action button').all()) await button.click({ force: true }).catch(() => {}); await page.locator('.MuiSnackbar-root').first().waitFor({ state: 'detached', timeout: 3000 }).catch(() => {}); };
const lunarDay = (month, day) => new Date(lunar.dayOf(2026, month, day, false)).toISOString().slice(0, 10);

async function testPhone(browser) {
  const world = makeWorld();
  const { context, page } = await openPage(browser, world, { viewport: { width: 390, height: 844 } });
  await openSheet(page, 'tap');
  // The list first; the toggle switches to the calendar and the choice is kept in the shared page state.
  assert.equal(await page.locator('#h5-attention-view [aria-pressed="true"]').getAttribute('data-value'), 'list');
  assert.equal(await page.locator('#h5-attention-add-form').count(), 1);
  await page.locator('#h5-attention-view [data-value="calendar"]').tap();
  await page.locator('#h5-attention-calendar').waitFor();
  assert.equal(await shared(page, 'h5-attention-view'), 'calendar');
  assert.equal(await page.locator('#h5-attention-add-form').count(), 0, 'no quick add in the calendar: its + makes events');
  assert.equal(await page.locator('#h5-attention-calendar').getAttribute('data-layout'), 'phone');
  // The month: Sunday first, 35 cells from Nov 1; today is selected and marked.
  assert.equal(await page.locator('#h5-cal-title').textContent(), 'November 2026');
  assert.deepEqual(await page.locator('#h5-cal-grid [role="columnheader"]').evaluateAll(els => els.map(el => el.getAttribute('aria-label'))), ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
  const dates = await page.locator(`${SHEET} .h5-cal-cell`).evaluateAll(els => els.map(el => el.dataset.date));
  assert.equal(dates.length, 35);
  assert.equal(dates[0], '2026-11-01');
  assert.equal(await cell(page, '2026-11-26').getAttribute('aria-current'), 'date');
  assert.equal(await cell(page, '2026-11-26').getAttribute('tabindex'), '0', 'the selected day is the one Tab stop');
  assert.equal(await page.locator('#h5-cal-grid [role="gridcell"][aria-selected="true"] .h5-cal-cell').getAttribute('data-date'), '2026-11-26');
  // Dots: one per kind, in the theme's colours; a to do is a ring.
  assert.deepEqual(await dotsOf(page, '2026-11-26'), ['once', 'repeat', 'todo']);
  assert.deepEqual(await dotsOf(page, '2026-11-15'), ['birthday']);
  assert.deepEqual(await dotsOf(page, '2026-11-12'), ['anniversary']);
  assert.deepEqual(await dotsOf(page, '2026-11-24'), ['repeat'], "K01's weekly check");
  assert.deepEqual(await dotsOf(page, '2026-11-21'), [], 'a done to do is not drawn');
  const colours = await page.evaluate(() => Object.fromEntries(['once', 'repeat', 'birthday', 'anniversary'].map(kind => [kind, getComputedStyle(document.querySelector(`#h5-cal-legend .h5-cal-dot[data-kind="${kind}"]`)).backgroundColor])));
  assert.equal(new Set(Object.values(colours)).size, 4, 'four colours');
  assert.equal(await cell(page, '2026-11-26').getAttribute('aria-label'), 'Thursday, Nov 26: Call the dentist, Water the plants, Send the invoice');
  // The agenda of today: timed first, then the to do (with its done button).
  assert.equal(await page.locator('#h5-cal-day-title').textContent(), 'Thursday, Nov 26');
  assert.equal(await page.locator('#h5-cal-day-lunar').textContent(), 'Lunar 10/18');
  assert.deepEqual(await agenda(page), [
    ['local:1', '10:00', 'Call the dentist', 'Once'], ['local:2', '18:00', 'Water the plants', 'Every 3 days 18:00'], ['local:6', 'All day', 'Send the invoice', 'To do'],
  ]);
  assert.equal(await page.locator('#h5-cal-agenda .h5-cal-event[data-key="local:6"] .h5-cal-event-done').count(), 1);
  // A birthday: its number and the lunar date.
  await cell(page, '2026-11-15').tap();
  assert.equal(await page.locator('#h5-cal-day-title').textContent(), 'Sunday, Nov 15');
  assert.deepEqual(await agenda(page), [['local:4', 'All day', "Mom's birthday", 'Birthday · turns 62 · Lunar 10/7']]);
  await cell(page, '2026-11-12').tap();
  assert.deepEqual(await agenda(page), [['local:5', 'All day', 'Wedding anniversary', 'Anniversary · 8th anniversary']]);
  await cell(page, '2026-11-24').tap();
  assert.match(await page.locator('#h5-cal-agenda .h5-cal-event[data-key="remote:7:1"]').textContent(), /K01/, 'the engine tag of K01');
  // Next and previous month, Today.
  await page.locator('#h5-cal-next').tap();
  assert.equal(await page.locator('#h5-cal-title').textContent(), 'December 2026');
  assert.equal(await page.locator(`${SHEET} .h5-cal-cell`).first().getAttribute('data-date'), '2026-11-29');
  assert.equal(await page.locator('#h5-cal-day-title').textContent(), 'Thursday, Dec 24', 'the same day of the next month');
  await page.locator('#h5-cal-prev').tap();
  await page.locator('#h5-cal-prev').tap();
  assert.equal(await page.locator('#h5-cal-title').textContent(), 'October 2026');
  assert.equal(await page.locator(`${SHEET} .h5-cal-cell`).first().getAttribute('data-date'), '2026-09-27', 'October 2026 starts on a Thursday');
  await page.locator('#h5-cal-today').tap();
  assert.equal(await page.locator('#h5-cal-title').textContent(), 'November 2026');
  assert.equal(await page.locator('#h5-cal-day-title').textContent(), 'Thursday, Nov 26');
  // The items without a date, in a dialog; a tap opens the edit view.
  assert.equal(await page.locator('#h5-cal-undated').textContent(), '2 to do without a date');
  await page.locator('#h5-cal-undated').tap();
  await page.locator('#h5-cal-undated-dialog').waitFor();
  assert.deepEqual(await page.locator('#h5-cal-undated-dialog .h5-cal-undated-row').evaluateAll(els => els.map(el => el.dataset.key)), ['local:8', 'local:9']);
  await page.locator('#h5-cal-undated-dialog .h5-cal-undated-row[data-key="local:8"]').tap();
  await page.locator('#h5-attention-edit').waitFor();
  assert.equal(await page.locator('#h5-attention-edit-name').inputValue(), 'Release 2.0');
  await page.locator('#h5-attention-edit-close').tap();
  await page.locator('#h5-attention-edit').waitFor({ state: 'hidden' });
  // A tap on an agenda row opens the edit view: a yearly item has "Every year" with its fields; a changed day is one PATCH.
  await cell(page, '2026-11-15').tap();
  await page.locator('#h5-cal-agenda .h5-cal-event[data-key="local:4"] .h5-cal-event-open').tap();
  await page.locator('#h5-attention-edit').waitFor();
  assert.equal(await page.locator('#h5-attention-repeat-freq').inputValue(), 'yearly');
  assert.equal(await page.locator('#h5-attention-repeat-yearly-calendar [aria-pressed="true"]').getAttribute('data-value'), 'lunar');
  assert.deepEqual([await page.locator('#h5-attention-repeat-yearly-month').inputValue(), await page.locator('#h5-attention-repeat-yearly-day').inputValue(), await page.locator('#h5-attention-repeat-yearly-year').inputValue(), await page.locator('#h5-attention-repeat-occasion').inputValue()], ['10', '7', '1964', 'birthday']);
  await page.locator('#h5-attention-schedule-next', { hasText: 'Every year on lunar month 10, day 7 at 09:00' }).waitFor();
  await page.locator('#h5-attention-repeat-yearly-day').selectOption('8');
  await page.locator('#h5-attention-edit-save').tap();
  await page.locator('#h5-attention-edit').waitFor({ state: 'hidden' });
  assert.deepEqual(last(world, 'PATCH').body, { schedule: { kind: 'repeat', rule: { freq: 'yearly', calendar: 'lunar', month: 10, day: 8, occasion: 'birthday', year: 1964, time: '09:00' } } });
  assert.equal(last(world, 'PATCH').path, '/api/attention/4');
  await cell(page, '2026-11-16').locator('.h5-cal-dot[data-kind="birthday"]').waitFor();
  if (SHOTS) { await quiet(page); await cell(page, '2026-11-26').tap(); await page.screenshot({ path: path.join(SHOTS, 'cal-month-390.png') }); }
  assert.deepEqual(await noOverflow(page, `${SHEET} .h5-attention-panel`), []);
  assert.deepEqual(await small(page, '#h5-attention-calendar'), []);

  // New event: a lunar birthday on this machine. The engine of a new item is the list's "Add on" choice (this machine first).
  await page.locator('#h5-cal-add').tap();
  await page.locator('#h5-cal-new').waitFor();
  assert.deepEqual(await page.locator('#h5-cal-new-kind button').evaluateAll(els => els.map(el => el.textContent)), ['One-off', 'Repeats', 'Birthday', 'Anniversary']);
  assert.equal(await page.locator('#h5-cal-new-update').count(), 0);
  await page.locator('#h5-cal-new-kind [data-value="birthday"]').tap();
  await page.locator('#h5-cal-new-name').fill('Dad');
  await page.locator('#h5-cal-new-yearly-calendar [data-value="lunar"]').tap();
  await page.locator('#h5-cal-new-yearly-month').selectOption('11');
  await page.locator('#h5-cal-new-yearly-day').selectOption('2');
  await page.locator('#h5-cal-new-yearly-year').fill('1960');
  const dad = lunarDay(11, 2);
  await page.locator('#h5-cal-new-next-date', { hasText: 'turns 66' }).waitFor();
  assert.equal(await page.locator('#h5-cal-new-next-lunar').textContent(), 'Lunar 11/2. The solar date changes every year.');
  assert.match(await page.locator('#h5-cal-new-next-date').textContent(), /, Dec 10, 2026 · turns 66$/);
  assert.equal(dad, '2026-12-10');
  assert.equal(await page.locator('#h5-cal-new-yearly-leap').count(), 1, 'Leap month only for a lunar date');
  assert.deepEqual(await noOverflow(page, '#h5-cal-new'), []);
  assert.deepEqual(await small(page, '#h5-cal-new'), []);
  if (SHOTS) { await quiet(page); await page.screenshot({ path: path.join(SHOTS, 'cal-birthday-390.png') }); }
  await page.locator('#h5-cal-new-save').tap();
  await page.locator('#h5-cal-new').waitFor({ state: 'hidden' });
  const post = last(world, 'POST', call => call.path === '/api/attention');
  assert.deepEqual(post.body, { title: "Dad's birthday", schedule: { kind: 'repeat', rule: { freq: 'yearly', calendar: 'lunar', month: 11, day: 2, occasion: 'birthday', year: 1960, time: '09:00' } } });
  // An anniversary (solar): the error of a day the month does not have, then saved.
  await page.locator('#h5-cal-add').tap();
  await page.locator('#h5-cal-new-kind [data-value="anniversary"]').tap();
  assert.equal(await page.locator('#h5-cal-new-yearly-leap').count(), 0, 'no leap month for a solar date');
  await page.locator('#h5-cal-new-name').fill('Office');
  await page.locator('#h5-cal-new-yearly-month').selectOption('2');
  await page.locator('#h5-cal-new-yearly-day').selectOption('30');
  await page.locator('#h5-cal-new-save').tap();
  assert.equal(await page.locator('#h5-cal-new-error').textContent(), 'This month has no such day');
  await page.locator('#h5-cal-new-yearly-month').selectOption('12');
  await page.locator('#h5-cal-new-yearly-day').selectOption('1');
  await page.locator('#h5-cal-new-yearly-year').fill('2020');
  await page.locator('#h5-cal-new-next-date', { hasText: '6th anniversary' }).waitFor();
  await page.locator('#h5-cal-new-save').tap();
  await page.locator('#h5-cal-new').waitFor({ state: 'hidden' });
  assert.deepEqual(last(world, 'POST', call => call.path === '/api/attention').body, { title: 'Office anniversary', schedule: { kind: 'repeat', rule: { freq: 'yearly', calendar: 'solar', month: 12, day: 1, occasion: 'anniversary', year: 2020, time: '09:00' } } });
  // Both are on the calendar of December.
  await page.locator('#h5-cal-next').tap();
  assert.deepEqual(await dotsOf(page, '2026-12-10'), ['birthday']);
  assert.deepEqual(await dotsOf(page, '2026-12-01'), ['repeat', 'anniversary'], "K01's Tuesday check, then the anniversary");
  await cell(page, '2026-12-01').tap();
  assert.deepEqual((await agenda(page)).at(-1), ['local:52', 'All day', 'Office anniversary', 'Anniversary · 6th anniversary']);
  // And in the list's Recurring section, with the number of their next time.
  await page.locator('#h5-attention-view [data-value="list"]').tap();
  await page.locator('#h5-attention-body').waitFor();
  assert.equal(await shared(page, 'h5-attention-view'), 'list');
  const line = key => page.locator(`#h5-attention-body .h5-attention-group[data-group="recurring"] .h5-attention-row[data-key="${key}"] .h5-attention-schedule-text`).textContent().then(text => text.replace(/\s+/g, ' '));
  assert.equal(await line('local:51'), 'Every year · 12-10 · lunar 11/2 · turns 66');
  assert.equal(await line('local:52'), 'Every year · 12-01 · 6th anniversary');
  assert.equal(await line('local:5'), 'Every year · 11-12 · 9th anniversary', 'the next one is 2027');
  if (SHOTS) { await page.locator('.h5-attention-group[data-group="recurring"]').scrollIntoViewIfNeeded(); await quiet(page); await page.screenshot({ path: path.join(SHOTS, 'cal-list-390.png') }); }
  assert.deepEqual(world.errors, []);
  await context.close();
}

async function testComputer(browser) {
  const world = makeWorld({ k01Yearly: false });
  const { context, page } = await openPage(browser, world, { viewport: { width: 1440, height: 900 }, touch: false });
  await openSheet(page, 'click');
  const narrow = await page.locator(`${SHEET} .h5-attention-panel`).boundingBox();
  await page.locator('#h5-attention-view [data-value="calendar"]').click();
  await page.locator('#h5-attention-calendar[data-layout="wide"]').waitFor();
  const box = await page.locator(`${SHEET} .h5-attention-panel`).boundingBox();
  assert.ok(narrow.width <= 481 && box.width > 1200, `the sheet widens for the calendar (${narrow.width} -> ${box.width})`);
  assert.ok(Math.abs(box.x + box.width - (1440 - 8)) < 1.5, 'still 8px from the right edge');
  const panel = await page.locator('#h5-cal-panel').boundingBox();
  assert.equal(Math.round(panel.width), 320);
  // Chips in the cells: two and "+1 more"; the lunar day in the corner.
  assert.deepEqual(await cell(page, '2026-11-26').locator('.h5-cal-chip').evaluateAll(els => els.map(el => [el.dataset.kind, el.textContent])), [['once', '10:00 Call the dentist'], ['repeat', 'Water the plants']]);
  assert.equal(await cell(page, '2026-11-26').locator('.h5-cal-more').textContent(), '+1 more');
  assert.equal(await cell(page, '2026-11-26').locator('.h5-cal-lunar').textContent(), '10/18');
  assert.deepEqual(await cell(page, '2026-11-15').locator('.h5-cal-chip').evaluateAll(els => els.map(el => el.textContent)), ["Mom's birthday · turns 62"]);
  assert.equal(await cell(page, '2026-11-28').locator('.h5-cal-chip[data-kind="todo"]').textContent(), 'Pay rent');
  // The day panel: the day, its lunar date, its agenda, Coming up.
  assert.equal(await page.locator('#h5-cal-day-title').textContent(), 'Thursday, Nov 26');
  assert.deepEqual((await page.locator('#h5-cal-coming .h5-cal-coming-row').evaluateAll(els => els.map(el => `${el.dataset.date} ${el.dataset.key}`))).slice(0, 3), ['2026-11-28 local:7', '2026-11-29 local:2', '2026-11-30 local:3']);
  assert.equal(await page.locator('#h5-cal-coming .h5-cal-coming-row').first().textContent(), 'Sat, Nov 28 · Pay rentTo do');
  // Keyboard: the arrows move the day (and its focus), Page Down a month.
  await cell(page, '2026-11-26').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.date), '2026-11-27');
  assert.equal(await page.locator('#h5-cal-day-title').textContent(), 'Friday, Nov 27');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.date), '2026-12-04');
  assert.equal(await page.locator('#h5-cal-title').textContent(), 'December 2026', 'a key into the next month shows it');
  await page.keyboard.press('PageUp');
  assert.equal(await page.locator('#h5-cal-title').textContent(), 'November 2026');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.date), '2026-11-04');
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.date), '2026-11-01');
  if (SHOTS) { await cell(page, '2026-11-26').click(); await quiet(page); await page.screenshot({ path: path.join(SHOTS, 'cal-month-1440.png') }); }
  // New event on a computer: a one-off with the When fields; the preview of the engine.
  await cell(page, '2026-11-27').click();
  await page.locator('#h5-cal-add').click();
  await page.locator('#h5-cal-new').waitFor();
  assert.equal(await page.locator('#h5-attention-once-date').inputValue(), '2026-11-27', 'the selected day');
  assert.equal(await page.locator('#h5-attention-when').count(), 0, 'the chips replace the When toggle');
  await page.locator('#h5-cal-new-name').fill('Dentist follow-up');
  await page.locator('#h5-attention-once-time').fill('14:30');
  await page.locator('#h5-attention-schedule-next', { hasText: 'Next time' }).waitFor();
  await page.locator('#h5-cal-new-save').click();
  await page.locator('#h5-cal-new').waitFor({ state: 'hidden' });
  assert.deepEqual(last(world, 'POST', call => call.path === '/api/attention').body, { title: 'Dentist follow-up', schedule: { kind: 'once', at: '2026-11-27T14:30' } });
  await cell(page, '2026-11-27').locator('.h5-cal-chip[data-kind="once"]', { hasText: 'Dentist follow-up' }).waitFor();
  // An engine without yearly rules: "on K01" leaves out Birthday and Anniversary and says why; this machine has them again.
  await page.locator('#h5-cal-add').click();
  await page.locator('#h5-cal-new-kind [data-value="repeat"]').click();
  assert.equal(await page.locator('#h5-attention-repeat-freq').inputValue(), 'weekly');
  assert.ok((await page.locator('#h5-attention-repeat-freq option').allTextContents()).includes('Every year'), 'this machine offers Every year');
  await page.locator('#h5-cal-new-on').selectOption('remote:7');
  await page.locator('#h5-cal-new-update').waitFor();
  assert.equal(await page.locator('#h5-cal-new-update').textContent(), 'Birthdays and anniversaries: This computer needs an update first');
  assert.deepEqual(await page.locator('#h5-cal-new-kind button').evaluateAll(els => els.map(el => el.dataset.value)), ['once', 'repeat']);
  assert.ok(!(await page.locator('#h5-attention-repeat-freq option').allTextContents()).includes('Every year'));
  if (SHOTS) { await quiet(page); await page.screenshot({ path: path.join(SHOTS, 'cal-gate-1440.png') }); }
  await page.locator('#h5-cal-new-on').selectOption('local');
  await page.locator('#h5-cal-new-kind [data-value="birthday"]').waitFor();
  await page.locator('#h5-cal-new-cancel').click();
  await page.locator('#h5-cal-new').waitFor({ state: 'hidden' });
  assert.deepEqual(await noOverflow(page, `${SHEET} .h5-attention-panel`), []);
  // Back to the list: the sheet is narrow again.
  await page.locator('#h5-attention-view [data-value="list"]').click();
  await page.locator('#h5-attention-body').waitFor();
  assert.ok((await page.locator(`${SHEET} .h5-attention-panel`).boundingBox()).width <= 481);
  assert.deepEqual(world.errors, []);
  await context.close();
}

async function testChinese(browser) {
  const world = makeWorld();
  const { context, page } = await openPage(browser, world, { viewport: { width: 390, height: 844 }, zh: true });
  await openSheet(page, 'tap');
  await page.locator('#h5-attention-view [data-value="calendar"]').tap();
  await page.locator('#h5-attention-calendar').waitFor();
  assert.equal(await page.locator('#h5-cal-title').textContent(), '2026\u5e7411\u6708');
  assert.equal(await page.locator('#h5-cal-day-title').textContent(), '11\u670826\u65e5 \u5468\u56db');
  assert.equal(await page.locator('#h5-cal-day-lunar').textContent(), '\u519c\u5386\u5341\u6708\u5341\u516b');
  assert.deepEqual(await page.locator('#h5-cal-grid [role="columnheader"]').allTextContents(), ['\u65e5', '\u4e00', '\u4e8c', '\u4e09', '\u56db', '\u4e94', '\u516d']);
  await cell(page, '2026-11-15').tap();
  assert.equal(await page.locator('#h5-cal-agenda .h5-cal-event-line').first().textContent(), '\u751f\u65e5 · 62 \u5c81 · \u519c\u5386\u5341\u6708\u521d\u4e03');
  if (SHOTS) { await quiet(page); await page.screenshot({ path: path.join(SHOTS, 'cal-month-zh-390.png') }); }
  await page.locator('#h5-attention-view [data-value="list"]').tap();
  const text = (await page.locator('#h5-attention-body .h5-attention-row[data-key="local:4"] .h5-attention-schedule-text').textContent()).replace(/\s+/g, ' ');
  assert.equal(text, '\u6bcf\u5e74 · 11-04 · \u519c\u5386\u5341\u6708\u521d\u4e03 · 63 \u5c81');
  assert.deepEqual(world.errors, []);
  await context.close();
}

(async () => {
  const browser = await chromium.launch();
  try {
    for (const [name, run] of [['phone 390 touch', testPhone], ['computer 1440 mouse', testComputer], ['Chinese', testChinese]]) {
      await run(browser);
      console.log(`  ${name}: ok`);
    }
    console.log('h5 attention calendar browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
