// The year, week and day views, the phone month, the search and the duration of the T-Attention calendar on the page (CalendarViews.jsx,
// AttentionCalendar.jsx, AttentionSearch.jsx, calendar-views.mjs, calendar-search.mjs; "Views", "Search" and "Duration and all day" in
// docs/design/page-attention-calendar.md), in real Chromium with the API mocked by Playwright routes (the engine's own rules,
// services/attention-schedule.js) and a fixed clock (Thursday 2026-11-26 10:00, Asia/Taipei):
// - phone 390 touch: the Year | Month | Week | Day switch and its shared value, the large-cell month, a tap opens the day (week strip, all-day row,
//   hours scrolled to about now, the now line), a 90 minute block 1.5 hours tall, an overlapping pair side by side, swipes by day and week, the edit
//   view's Duration / Ends at (an end before the start refused, a new end saved), the week, the year (3 a row, dots, a month opens), the chosen day
//   kept while the page is loaded, the search (a name, a lunar date, a filter, a result opens the item), 44px targets, no horizontal overflow;
// - computer 1440 mouse: the switch in the bar, a double click opens a day (the panel with the all-day items), the week, the year 4 a row with the
//   day panel and the keys, New event with Duration / Ends at / All day / Custom, an engine without `attention:duration`, the search dialog;
// - Chinese: the segments, the week and day titles, a search by the lunar words.
// H5_SHOT_DIR=<dir> saves screenshots (views-*.png).
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
  node(1, 'Call the dentist', { schedule: { kind: 'once', at: '2026-11-26T10:00', tz: TZ, duration: 90 } }),
  node(2, 'Code review', { schedule: { kind: 'once', at: '2026-11-26T10:30', tz: TZ, duration: 30 } }),
  node(3, 'Water the plants', { schedule: repeat({ freq: 'every', interval: 3, time: '18:00' }, { starts: '2026-11-02' }) }),
  node(4, "Mom's birthday", { schedule: repeat({ freq: 'yearly', calendar: 'lunar', month: 10, day: 7, occasion: 'birthday', year: 1964, time: '09:00' }) }),
  node(5, 'Wedding anniversary', { schedule: repeat({ freq: 'yearly', calendar: 'solar', month: 11, day: 12, occasion: 'anniversary', year: 2018, time: '09:00' }) }),
  node(6, 'Send the invoice', { due_date: '2026-11-26' }),
  node(7, 'Holiday', { schedule: { kind: 'once', at: '2026-11-27T09:00', tz: TZ, all_day: true } }),
  node(8, 'Release 2.0', { notes: 'ask about the birthday cake' }),
  node(9, 'Gym', { schedule: repeat({ freq: 'weekly', days: [1], time: '07:00' }, { duration: 60 }) }),
  node(10, 'Old errand', { due_date: '2026-11-21', status: 'done' }),
];
const REMOTE_ITEMS = () => [node(1, 'Deploy check', { schedule: repeat({ freq: 'weekly', days: [2], time: '08:00' }) })];

function makeWorld({ k01Yearly = true, k01Duration = false } = {}) {
  return {
    k01Yearly, k01Duration, calls: [], errors: [], nextId: 50,
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
    if (rest === '/info') return json({ capabilities: ['attention:remote', 'attention:schedule', 'terminal:control', ...(world.k01Yearly ? ['attention:yearly'] : []), ...(world.k01Duration ? ['attention:duration'] : [])] });
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
const chipsOf = (page, date) => cell(page, date).locator('.h5-cal-chip, .h5-cal-more').evaluateAll(els => els.map(el => el.dataset.kind || el.textContent));
const allDayOf = page => page.locator('#h5-cal-allday .h5-cal-allday-event').evaluateAll(els => els.map(el => [el.dataset.key, el.getAttribute('aria-label')]));
const monthView = async (page, how = 'tap') => { await page.locator('#h5-cal-views [data-value="month"]')[how](); await page.locator('#h5-attention-calendar[data-view="month"]').waitFor(); };
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
// Touch targets below 44px, leaving out the event blocks and all-day chips of the time grid (drawn to their time, like the month chips; the
// documented exception in "Views" of docs/design/page-attention-calendar.md).
const tooSmall = (page, scope) => page.evaluate(sel => [...document.querySelectorAll(`${sel} button, ${sel} input, ${sel} select`)]
  .filter(el => el.offsetParent !== null && !['radio', 'checkbox'].includes(el.type) && !el.closest('.h5-cal-block, .h5-cal-allday-event'))
  .map(el => { const r = (el.closest('.MuiInputBase-root') || el).getBoundingClientRect(); return { id: el.id || el.className.toString().split(' ').find(name => name.startsWith('h5-')) || el.tagName, w: r.width, h: r.height }; })
  .filter(r => r.w && (r.w < 44 || r.h < 44)), scope);
const view = page => page.locator('#h5-attention-calendar').evaluate(el => [el.dataset.view, el.dataset.date]);
const pick = async (page, value, how) => { await page.locator(`#h5-cal-views [data-value="${value}"]`)[how](); await page.locator(`#h5-attention-calendar[data-view="${value}"]`).waitFor(); };
const blocks = page => page.locator('#h5-cal-time .h5-cal-block').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { key: el.dataset.key, col: Number(el.dataset.col), cols: Number(el.dataset.cols), x: r.x, w: r.width, h: r.height }; }));
const allDay = page => page.locator('#h5-cal-allday .h5-cal-allday-event').evaluateAll(els => els.map(el => el.dataset.key));
async function swipe(page, selector, dx) {
  const box = await page.locator(selector).boundingBox();
  const y = box.y + box.height / 2;
  const x = box.x + box.width / 2 - dx / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 5; i += 1) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / 5, y: y + i }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
const shot = async (page, name) => { if (SHOTS) { await quiet(page); await page.screenshot({ path: path.join(SHOTS, name) }); } };

async function testPhone(browser) {
  const world = makeWorld();
  const { context, page } = await openPage(browser, world, { viewport: { width: 390, height: 844 } });
  await openSheet(page, 'tap');
  await page.locator('#h5-attention-view [data-value="calendar"]').tap();
  await page.locator('#h5-attention-calendar').waitFor();
  // The four-segment switch under List | Calendar: Month first; a choice is kept in the shared page state.
  assert.deepEqual(await page.locator('#h5-cal-views button').evaluateAll(els => els.map(el => [el.dataset.value, el.textContent, el.getAttribute('aria-pressed')])), [['year', 'Year', 'false'], ['month', 'Month', 'true'], ['week', 'Week', 'false'], ['day', 'Day', 'false']]);
  assert.equal(await shared(page, 'h5-attention-cal-view'), null);
  assert.deepEqual(await view(page), ['month', '2026-11-26']);
  const grid = await page.locator('#h5-cal-grid').boundingBox();
  assert.ok(grid.height > 450, `the large cells fill the height (${grid.height})`);
  assert.deepEqual(await tooSmall(page, '#h5-attention-calendar'), []);
  assert.deepEqual(await noOverflow(page, `${SHEET} .h5-attention-panel`), []);
  await shot(page, 'views-month-390.png');
  // A tap on a day opens it in the Day view: the week strip, the date and lunar day, the all-day row and the hours scrolled to about now.
  await cell(page, '2026-11-26').tap();
  await page.locator('#h5-attention-calendar[data-view="day"]').waitFor();
  assert.equal(await shared(page, 'h5-attention-cal-view'), 'day');
  assert.equal(await page.locator('#h5-cal-title').textContent(), 'Nov 26, 2026');
  assert.deepEqual(await page.locator('#h5-cal-strip .h5-cal-strip-day').evaluateAll(els => els.map(el => el.dataset.date)), ['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28']);
  assert.deepEqual(await allDay(page), ['local:6']);
  assert.equal(await page.locator('#h5-cal-hours').evaluate(el => el.scrollTop), 9 * 48, 'an hour before 10:00');
  assert.equal(await page.locator('#h5-cal-now').getAttribute('data-minutes'), '600');
  // 90 minutes are 1.5 hours tall; the overlapping pair is side by side; no duration is one hour.
  const shown = await blocks(page);
  const by = key => shown.find(block => block.key === key);
  assert.deepEqual(shown.map(block => block.key), ['local:1', 'local:2', 'local:3']);
  assert.equal(Math.round(by('local:1').h), 90 / 60 * 48 - 2);
  assert.equal(Math.round(by('local:3').h), 48 - 2, 'no duration: one hour');
  assert.deepEqual([by('local:1').col, by('local:1').cols, by('local:2').col, by('local:2').cols], [0, 2, 1, 2]);
  assert.ok(by('local:2').x >= by('local:1').x + by('local:1').w - 1 && Math.abs(by('local:1').w - by('local:2').w) < 2, 'side by side, the same width');
  await shot(page, 'views-day-390.png');
  // Swipes move a day; another day scrolls to 8:00.
  await swipe(page, '#h5-cal-hours', -160);
  await page.locator('#h5-attention-calendar[data-date="2026-11-27"]').waitFor();
  assert.deepEqual(await allDay(page), ['local:7'], 'the all-day once');
  assert.equal(await page.locator('#h5-cal-hours').evaluate(el => el.scrollTop), 8 * 48);
  await swipe(page, '#h5-cal-hours', 160);
  await page.locator('#h5-attention-calendar[data-date="2026-11-26"]').waitFor();
  await page.locator('#h5-cal-next').tap();
  assert.deepEqual(await view(page), ['day', '2026-11-27']);
  await page.locator('#h5-cal-strip .h5-cal-strip-day[data-date="2026-11-23"]').tap();
  assert.deepEqual(await view(page), ['day', '2026-11-23']);
  assert.equal(await page.locator('#h5-cal-time .h5-cal-block[data-key="local:9"]').getAttribute('data-end'), String(8 * 60), 'Gym 07:00 for an hour');
  await page.locator('#h5-cal-today').tap();
  // A block opens the edit view: Duration and Ends at follow each other, an end before the start is refused, a new end is one PATCH.
  await page.locator('#h5-cal-time .h5-cal-block[data-key="local:1"]').tap();
  await page.locator('#h5-attention-edit').waitFor();
  assert.equal(await page.locator('#h5-attention-duration').inputValue(), '90');
  assert.equal(await page.locator('#h5-attention-ends-at').inputValue(), '11:30');
  await page.locator('#h5-attention-ends-at').fill('09:00');
  assert.equal(await page.locator('#h5-attention-duration-error').textContent(), 'It would end after midnight: choose an earlier end or a shorter duration');
  await page.locator('#h5-attention-ends-at').fill('12:00');
  assert.equal(await page.locator('#h5-attention-duration-error').count(), 0);
  assert.equal(await page.locator('#h5-attention-duration').inputValue(), '120');
  await page.locator('#h5-attention-edit-save').tap();
  await page.locator('#h5-attention-edit').waitFor({ state: 'hidden' });
  assert.deepEqual(last(world, 'PATCH').body, { schedule: { kind: 'once', at: '2026-11-26T10:00', duration: 120 } });
  await page.waitForFunction(() => Math.round(document.querySelector('.h5-cal-block[data-key="local:1"]').getBoundingClientRect().height) === 94);
  // Week: seven narrow columns and the all-day row; a tap on a day number opens that day.
  await pick(page, 'week', 'tap');
  assert.equal(await page.locator('#h5-cal-title').textContent(), 'Nov 22 – 28, 2026');
  assert.equal(await page.locator('#h5-cal-time .h5-cal-col').count(), 7);
  assert.deepEqual(await page.locator('#h5-cal-allday .h5-cal-allday-col').evaluateAll(els => els.map(el => el.querySelectorAll('.h5-cal-allday-event').length)), [0, 0, 0, 0, 1, 1, 0]);
  assert.equal(await page.locator('#h5-cal-now').count(), 1, 'in the column of today');
  assert.deepEqual(await noOverflow(page, `${SHEET} .h5-attention-panel`), []);
  assert.deepEqual(await tooSmall(page, '#h5-attention-calendar'), []);
  await shot(page, 'views-week-390.png');
  await swipe(page, '#h5-cal-hours', -160);
  await page.locator('#h5-attention-calendar[data-date="2026-12-03"]').waitFor();
  assert.equal(await page.locator('#h5-cal-title').textContent(), 'Nov 29 – Dec 5, 2026');
  await page.locator('#h5-cal-prev').tap();
  await page.locator('#h5-cal-heads .h5-cal-head[data-date="2026-11-27"]').tap();
  assert.deepEqual(await view(page), ['day', '2026-11-27']);
  // Year: twelve months, today filled, a pink dot on a birthday; a tap on a month opens it, the day of the month kept.
  await pick(page, 'year', 'tap');
  assert.equal(await page.locator('#h5-cal-title').textContent(), '2026');
  assert.equal(await page.locator('#h5-cal-year .h5-cal-ymonth').count(), 12);
  assert.equal(await page.locator('#h5-cal-year .h5-cal-yday[data-today="true"]').getAttribute('data-date'), '2026-11-26');
  assert.equal(await page.locator('#h5-cal-year .h5-cal-yday[data-date="2026-11-15"] .h5-cal-ydot').getAttribute('data-mark'), 'special');
  assert.equal(await page.locator('#h5-cal-year .h5-cal-yday[data-date="2026-11-24"] .h5-cal-ydot').getAttribute('data-mark'), 'busy');
  assert.equal(await page.locator('#h5-cal-year .h5-cal-yday[data-date="2026-11-13"] .h5-cal-ydot').getAttribute('data-mark'), null);
  const columns = new Set(await page.locator('#h5-cal-year .h5-cal-ymonth').evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().x))));
  assert.equal(columns.size, 3, 'three months a row');
  assert.deepEqual(await noOverflow(page, `${SHEET} .h5-attention-panel`), []);
  await shot(page, 'views-year-390.png');
  await page.locator('#h5-cal-year .h5-cal-ymonth[data-month="2026-03"]').tap();
  assert.deepEqual(await view(page), ['month', '2026-03-27']);
  assert.equal(await page.locator('#h5-cal-title').textContent(), 'March 2026');
  // The chosen day stays while the page is loaded: the panel closed and opened again.
  await page.locator('#h5-attention-close').tap();
  await page.locator(`${SHEET} .h5-attention-panel`).waitFor({ state: 'hidden' });
  await openSheet(page, 'tap');
  await page.locator('#h5-attention-calendar').waitFor();
  assert.deepEqual(await view(page), ['month', '2026-03-27']);
  // Search: by name and by the lunar date of a birthday; the matched text marked; a tap opens the item.
  await page.locator('#h5-attention-search').tap();
  await page.locator('#h5-attention-search-view').waitFor();
  await page.locator('#h5-search-field').fill('mom');
  await page.locator('#h5-search-results .h5-search-result[data-key="local:4"]').waitFor();
  assert.equal(await page.locator('#h5-search-results .h5-search-group').first().getAttribute('data-group'), 'next');
  assert.equal(await page.locator('.h5-search-result[data-key="local:4"] .h5-search-hit').textContent(), 'Mom');
  assert.equal(await page.locator('.h5-search-result[data-key="local:4"] .h5-search-title').textContent(), "Mom's birthday · turns 63");
  assert.equal(await page.locator('.h5-search-result[data-key="local:4"] .h5-search-line').textContent(), 'Thu, Nov 4, 2027 · Lunar 10/7 · Every year');
  await page.locator('#h5-search-field').fill('lunar 10/7');
  assert.deepEqual(await page.locator('.h5-search-result').evaluateAll(els => els.map(el => el.dataset.key)), ['local:4']);
  await page.locator('#h5-search-field').fill('birthday');
  assert.deepEqual(await page.locator('.h5-search-group').evaluateAll(els => els.map(el => el.dataset.group)), ['next', 'none'], 'the notes of an item without a date match too');
  await page.locator('#h5-search-filter-birthday').tap();
  assert.deepEqual(await page.locator('.h5-search-result').evaluateAll(els => els.map(el => el.dataset.key)), ['local:4']);
  assert.equal(await page.locator('#h5-search-count').textContent(), '1 result');
  assert.deepEqual(await noOverflow(page, '#h5-attention-search-view'), []);
  assert.deepEqual(await tooSmall(page, '#h5-attention-search-view'), []);
  await shot(page, 'views-search-390.png');
  await page.locator('.h5-search-result[data-key="local:4"]').tap();
  await page.locator('#h5-attention-edit').waitFor();
  assert.equal(await page.locator('#h5-attention-search-view').count(), 0);
  assert.equal(await page.locator('#h5-attention-edit-name').inputValue(), "Mom's birthday");
  await page.locator('#h5-attention-edit-close').tap();
  assert.deepEqual(world.errors, []);
  await context.close();
}

async function testComputer(browser) {
  const world = makeWorld({ k01Yearly: true, k01Duration: false });
  const { context, page } = await openPage(browser, world, { viewport: { width: 1440, height: 900 }, touch: false });
  await openSheet(page, 'click');
  await page.locator('#h5-attention-view [data-value="calendar"]').click();
  await page.locator('#h5-attention-calendar[data-layout="wide"]').waitFor();
  // The switch sits in the calendar's bar; the month as before, a double click opens a day.
  const bar = await page.locator('#h5-cal-bar').boundingBox();
  const views = await page.locator('#h5-cal-views').boundingBox();
  assert.ok(views.y >= bar.y && views.y + views.height <= bar.y + bar.height + 1, 'in the bar');
  await cell(page, '2026-11-26').dblclick();
  await page.locator('#h5-attention-calendar[data-view="day"]').waitFor();
  // Day: one wide column, the heads with the lunar day, the panel with the all-day items and Coming up.
  assert.equal(await page.locator('#h5-cal-heads .h5-cal-head .h5-cal-lunar').textContent(), '10/18');
  assert.equal(await page.locator('#h5-cal-day[data-all-day="true"]').count(), 1);
  assert.deepEqual(await page.locator('#h5-cal-agenda .h5-cal-event').evaluateAll(els => els.map(el => el.dataset.key)), ['local:6']);
  assert.ok(await page.locator('#h5-cal-coming .h5-cal-coming-row').count() > 0);
  assert.equal(await page.locator('.h5-cal-block[data-key="local:1"] .h5-cal-block-time').textContent(), '10:00–11:30');
  const wide = await blocks(page);
  assert.ok(wide[0].w > 300, 'a wide column');
  await shot(page, 'views-day-1440.png');
  // Week: seven columns with titles and times.
  await pick(page, 'week', 'click');
  assert.equal(await page.locator('#h5-cal-panel').count(), 0, 'the week takes the whole width');
  assert.equal(await page.locator('#h5-cal-heads .h5-cal-head').count(), 7);
  assert.equal(await page.locator('.h5-cal-block[data-key="local:2"] .h5-cal-block-title').textContent(), 'Code review');
  assert.deepEqual(await noOverflow(page, `${SHEET} .h5-attention-panel`), []);
  await shot(page, 'views-week-1440.png');
  // Year: 4 x 3 months and the day panel; a click selects a day, a double click opens it; a month title opens the month.
  await pick(page, 'year', 'click');
  const columns = new Set(await page.locator('#h5-cal-year .h5-cal-ymonth').evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().x))));
  assert.equal(columns.size, 4, 'four months a row');
  await page.locator('#h5-cal-year button.h5-cal-yday[data-date="2026-11-15"]').click();
  assert.equal(await page.locator('#h5-cal-day-title').textContent(), 'Sunday, Nov 15');
  assert.deepEqual(await page.locator('#h5-cal-agenda .h5-cal-event').evaluateAll(els => els.map(el => el.dataset.key)), ['local:4']);
  // The arrow keys move the day across months.
  await page.locator('#h5-cal-year button.h5-cal-yday[data-date="2026-11-15"]').focus();
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.date), '2026-11-08');
  await page.keyboard.press('PageDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.date), '2026-12-08');
  await shot(page, 'views-year-1440.png');
  await page.locator('#h5-cal-year button.h5-cal-yday[data-date="2026-11-12"]').dblclick();
  assert.deepEqual(await view(page), ['day', '2026-11-12']);
  await pick(page, 'year', 'click');
  await page.locator('#h5-cal-year .h5-cal-ymonth[data-month="2026-11"] .h5-cal-ymonth-title').click();
  assert.deepEqual(await view(page), ['month', '2026-11-12']);
  await page.locator('#h5-cal-day-open').click();
  assert.deepEqual(await view(page), ['day', '2026-11-12']);
  // New event: 1 hour by default, Duration and Ends at follow each other, All day hides the time; saved with the length.
  await page.locator('#h5-cal-add').click();
  await page.locator('#h5-cal-new').waitFor();
  assert.equal(await page.locator('#h5-attention-duration').inputValue(), '60');
  assert.equal(await page.locator('#h5-attention-ends-at').inputValue(), '10:00');
  await page.locator('#h5-attention-duration').selectOption('90');
  assert.equal(await page.locator('#h5-attention-ends-at').inputValue(), '10:30');
  await page.locator('#h5-attention-all-day').check();
  assert.equal(await page.locator('#h5-attention-once-time').count(), 0);
  assert.equal(await page.locator('#h5-attention-duration').count(), 0);
  await page.locator('#h5-attention-all-day').uncheck();
  await page.locator('#h5-attention-duration').selectOption('custom');
  await page.locator('#h5-attention-duration-minutes').fill('50');
  assert.equal(await page.locator('#h5-attention-ends-at').inputValue(), '09:50');
  await page.locator('#h5-cal-new-name').fill('Standup');
  await shot(page, 'views-new-1440.png');
  await page.locator('#h5-cal-new-save').click();
  await page.locator('#h5-cal-new').waitFor({ state: 'hidden' });
  assert.deepEqual(last(world, 'POST', call => call.path === '/api/attention').body, { title: 'Standup', schedule: { kind: 'once', at: '2026-11-12T09:00', duration: 50 } });
  await page.locator('.h5-cal-block', { hasText: 'Standup' }).waitFor();
  // An engine without `attention:duration`: no Duration row, nothing about it saved.
  await page.locator('#h5-cal-add').click();
  await page.locator('#h5-cal-new-on').selectOption('remote:7');
  await page.locator('#h5-attention-duration').waitFor({ state: 'detached' });
  assert.equal(await page.locator('#h5-attention-all-day').count(), 0);
  await page.locator('#h5-cal-new-name').fill('Remote thing');
  await page.locator('#h5-cal-new-save').click();
  await page.locator('#h5-cal-new').waitFor({ state: 'hidden' });
  assert.deepEqual(last(world, 'POST', call => call.remote === 7).body, { title: 'Remote thing', schedule: { kind: 'once', at: '2026-11-12T09:00' } });
  // Search in a dialog; Escape closes it.
  await page.locator('#h5-attention-search').click();
  await page.locator('#h5-attention-search-view').waitFor();
  await page.locator('#h5-search-field').fill('Wedding');
  await page.locator('.h5-search-result[data-key="local:5"]').waitFor();
  assert.equal(await page.locator('.h5-search-result[data-key="local:5"] .h5-search-title').textContent(), 'Wedding anniversary · 9th anniversary');
  await shot(page, 'views-search-1440.png');
  await page.keyboard.press('Escape');
  await page.locator('#h5-attention-search-view').waitFor({ state: 'detached' });
  assert.equal(await page.locator(`${SHEET} .h5-attention-panel`).isVisible(), true, 'the panel stays');
  assert.deepEqual(world.errors, []);
  await context.close();
}

async function testChinese(browser) {
  const world = makeWorld();
  const { context, page } = await openPage(browser, world, { viewport: { width: 390, height: 844 }, zh: true });
  await openSheet(page, 'tap');
  await page.locator('#h5-attention-view [data-value="calendar"]').tap();
  await page.locator('#h5-attention-calendar').waitFor();
  assert.deepEqual(await page.locator('#h5-cal-views button').allTextContents(), ['\u5e74', '\u6708', '\u5468', '\u65e5']);
  await pick(page, 'week', 'tap');
  assert.equal(await page.locator('#h5-cal-title').textContent(), '2026\u5e7411\u670822\u65e5 – 28\u65e5');
  await pick(page, 'day', 'tap');
  assert.equal(await page.locator('#h5-cal-title').textContent(), '2026\u5e7411\u670826\u65e5');
  await page.locator('#h5-attention-search').tap();
  await page.locator('#h5-search-field').fill('\u5341\u6708\u521d\u4e03');
  await page.locator('.h5-search-result[data-key="local:4"]').waitFor();
  assert.equal(await page.locator('.h5-search-group h3').first().textContent(), '\u63a5\u4e0b\u6765');
  await shot(page, 'views-search-zh-390.png');
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
    console.log('h5 attention calendar views browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
