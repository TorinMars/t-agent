// Learn's Progress view, the grade intervals and the review schedule setting (scripts/h5-shell/LearnProgress.jsx, Learn.jsx), in real Chromium with
// every route mocked: GET /api/learn/stats as in docs/design/learn-english-stats.md, queue cards with the FSRS server's `next`, learning settings with
// `desired_retention` ("Progress", "Grade intervals" and "Learn settings" in docs/design/learn-english-page.md).
// Learn is the coach (GET /api/learn/coach answers), so every screen is opened the way the coach opens it (ui.actions.openLearn(name), the same as
// her buttons and the links /h5?learn=<name>), and its back returns to her.
// - 1440x900 (mouse): Progress opens in the page; the four tiles; the four charts two per row (columns,
//   the line with its last value, the memory bars, the due columns); a tooltip on hovering a column and the line (with its crosshair); Table shows
//   every chart as a table and Charts goes back; a failed load with Retry; the grade buttons with when each grade brings the card back, Enter takes the
//   suggested one; REVIEW SCHEDULE saves desired_retention at once (PUT).
// - 390x844 (touch): the view full screen, tiles two per row, charts one per row, no sideways scroll; a tap on a column and on the line shows the
//   tooltip; the empty state; the grade buttons in one row in the pinned actions with 44px targets; a card without `next` keeps the plain buttons;
//   settings without desired_retention (an older server) show no REVIEW SCHEDULE.
// - 320x640 (touch): the grade buttons still fit in one row.
// H5_SHOT_DIR=<dir> saves progress-desktop.png, progress-desktop-table.png, progress-phone.png, progress-phone-bottom.png, progress-phone-tooltip.png,
// progress-phone-table.png, progress-phone-empty.png, grades-desktop.png, grades-phone-390.png, grades-phone-320.png, schedule-desktop.png.
const { chromium } = require('playwright');
// Opens a screen of Learn the way the coach does (her buttons, the links): ui.actions.openLearn(name).
const openScreen = (page, name) => page.evaluate(screen => window.H5UI.actions.openLearn(screen), name);
const COACH = '[data-coach="only"] #h5-learn-coach';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
const NOW = Date.now();
const ZH_SHIP = '\u8239';
const ZH_CODE = '\u4ee3\u7801';

const TASKS = [{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }];
const TERMINALS = { 1: [{ terminal_id: 'c1', title: 'Claude: login fix', agent: 'claude' }] };
const NEXT = { again: 600000, hard: 2 * DAY, good: 5 * DAY };
const card = (id, en, zh, extra = {}) => ({ id, kind: 'word', en, zh, phonetic: '', source: 'manual', context: '', due_at: iso(NOW), interval_days: 3, ease: 2.5, reps: 2, lapses: 0, last_result: 'good', last_at: iso(NOW - 3 * DAY), suspended: false, created_at: iso(NOW - 9 * DAY), ...extra });
const QUEUE = [card(1, 'ship', ZH_SHIP, { next: NEXT, retrievability: 0.86 }), card(2, 'code', ZH_CODE)];

// The stats: 30 days (oldest first), 12 weeks, the memory groups, 14 days ahead; the days as the server writes them (YYYY-MM-DD).
const dayOf = ms => iso(ms).slice(0, 10);
const DAILY = [0, 12, 25, 8, 0, 30, 22, 18, 0, 0, 14, 27, 35, 20, 9, 0, 16, 24, 31, 12, 0, 19, 28, 40, 22, 15, 0, 26, 33, 21];
const RIGHT = DAILY.map((n, i) => (i === 23 ? 31 : Math.round(n * 0.75)));
const SHARES = [58, 61, 60, 64, 66, 63, 69, 71, 70, 74, 73, 76];
const DUE = [21, 9, 14, 6, 11, 4, 8, 12, 3, 7, 5, 9, 2, 6];
const monday = (() => { const d = new Date(NOW); const back = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back); })();
const STATS = {
  streak: 5, best_streak: 12,
  week: { answers: 143, right: 109, prev_answers: 105, prev_right: 77 },
  daily: DAILY.map((answers, i) => ({ day: dayOf(NOW - (29 - i) * DAY), answers, right: RIGHT[i] })),
  weekly: SHARES.map((share, i) => ({ week_start: dayOf(monday - (11 - i) * 7 * DAY), answers: 100, right_first: share })),
  memory: { new: 182, learning: 64, young: 66, mature: 118 }, total_cards: 430,
  due: DUE.map((count, i) => ({ day: dayOf(NOW + i * DAY), count })),
};
const EMPTY_STATS = {
  streak: 0, best_streak: 0, week: { answers: 0, right: 0, prev_answers: 0, prev_right: 0 },
  daily: STATS.daily.map(item => ({ ...item, answers: 0, right: 0 })), weekly: STATS.weekly.map(item => ({ ...item, answers: 0, right_first: 0 })),
  memory: { new: 12, learning: 0, young: 0, mature: 0 }, total_cards: 12, due: STATS.due.map(item => ({ ...item, count: 0 })),
};
const SUMMARY = { due: 12, new_today: 1, done_today: 7, goal: 20, streak: 5, words: 42, sentences: 26, mistakes: 0, chats: 0, collecting: true, starter: null };
const shortDay = day => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
const pageErrors = [];

function learnMock() {
  const mock = { summary: { ...SUMMARY }, stats: STATS, statsFail: false, queue: QUEUE, settings: { collect: true, daily_goal: 20, starter: null, desired_retention: 0.9 }, requests: [] };
  mock.handle = (p, method, url, body) => {
    mock.requests.push({ method, path: p, search: url.search, body });
    if (p === '/api/learn/summary') return mock.summary;
    if (p === '/api/learn/stats') return mock.statsFail ? [500, { error: 'Learning data is not available right now' }] : mock.stats;
    if (p === '/api/learn/settings' && method === 'GET') return mock.settings;
    if (p === '/api/learn/settings' && method === 'PUT') { mock.settings = { ...mock.settings, ...body }; return mock.settings; }
    if (p === '/api/learn/queue') return { cards: mock.queue };
    if (/^\/api\/learn\/cards\/\d+\/answer$/.test(p)) return { card: mock.queue.find(item => String(item.id) === p.split('/')[4]) };
    if (p === '/api/learn/meaning') return { zh: ZH_SHIP, phonetic: '' };
    if (p === '/api/learn/level') return { level: null, picking: { enabled: false, picked: 0, skipped: 0, sentences: 0, pending: 0, running: false }, translator: false };
    if (p === '/api/learn/chats') return { chats: [], translator: false };
    if (p === '/api/learn/coach' && method === 'GET') return { messages: [], has_more: false, tools_ok: true, translator: true, settings: { memory: true, read_answers: true, read_text: true, economy: false } };
    return [404, { error: 'not mocked' }];
  };
  mock.posts = re => mock.requests.filter(item => item.method !== 'GET' && re.test(item.path));
  return mock;
}

async function openPage(browser, { viewport, touch = false }) {
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...(SHOTS ? { deviceScaleFactor: 3 } : {}) });
  const page = await context.newPage();
  const mock = learnMock();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('h5-columns', JSON.stringify({ on: false }));
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send() {}
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1; window.WebSocket.CONNECTING = 0;
    window.EventSource = class extends EventTarget {
      constructor(url) { super(); this.url = url; this.readyState = 1; }
      close() { this.readyState = 2; }
    };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak(u) { setTimeout(() => u.onend && u.onend(), 20); }, cancel() {}, getVoices: () => [{ lang: 'en-US', name: 'Test', localService: true }], addEventListener() {}, removeEventListener() {} } });
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  });
  await page.addInitScript(activityStreamMock);
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(p)) {
      const file = path.join(root, 'public', p);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(file) });
    }
    if (p.startsWith('/api/learn/')) {
      let body = null;
      try { body = route.request().postData() ? JSON.parse(route.request().postData()) : null; } catch { body = null; }
      const out = await mock.handle(p, method, url, body);
      return Array.isArray(out) ? json(out[1], out[0]) : json(out);
    }
    if (p === '/api/system/update-status' || p === '/api/system/check-update') return json({ status: 'idle', local_version: '1.0.0', install_type: 'git', log: [] });
    if (p === '/api/remote-servers') return json([]);
    if (p === '/api/tasks' && method === 'GET') return json(TASKS);
    if (p === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (p === '/api/tasks/terminal-activity' || p === '/api/tasks/terminal-subagents') return json({});
    const terminals = p.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (terminals && method === 'GET') return json(TERMINALS[terminals[1]] || []);
    if (/\/terminal\/(ack|control)$/.test(p)) return json({ success: true });
    if (/^\/api\/tasks\/\d+\/agent\/conversations$/.test(p)) return json([]);
    if (p === '/api/attention' && method === 'GET') return json({ items: [], host: 'T01' });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  return { context, page, mock };
}

// The text as shown (innerText: lines of a block are apart), SVG text by its content.
const text = (page, selector) => page.locator(selector).first().evaluate(el => (el.innerText ?? el.textContent).replace(/\s+/g, ' ').trim());
const texts = (page, selector) => page.locator(selector).evaluateAll(els => els.map(el => (el.innerText ?? el.textContent).replace(/\s+/g, ' ').trim()));
const rect = (page, selector) => page.locator(selector).first().evaluate(el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }; });
const shot = async (page, name, options = {}) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, name), ...options }); } };
const waitFor = async (check, message, timeout = 5000) => {
  const end = Date.now() + timeout;
  for (;;) { if (await check()) return; if (Date.now() > end) throw new Error(`timed out: ${message}`); await new Promise(resolve => setTimeout(resolve, 50)); }
};
const noSidewaysScroll = page => page.evaluate(() => [...document.querySelectorAll('#h5-learn-mode .h5-learn-scroll, #h5-learn-mode .MuiCard-root')].every(el => el.scrollWidth <= el.clientWidth + 1));
const lastAnswer = mock => { const list = mock.posts(/\/answer$/); return list.length ? { id: list.at(-1).path.match(/cards\/(\d+)/)[1], ...list.at(-1).body } : null; };
// The middle of a column's hit target (the slot) of a chart.
const slotCenter = (page, chart, index) => page.locator(`#${chart} .h5-learn-slot[data-index="${index}"]`).evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
async function tapKeys(page, keys) {
  for (const key of keys) await page.locator(`#h5-learn-keys button[data-char="${key}"]`).tap();
}

async function toTerminal(page) {
  await page.locator('.h5-header').waitFor({ state: 'visible' });
  if (!(await page.locator('#h5-tasks').isVisible())) await page.locator('#h5-open-tasks').tap();
  await page.locator('#h5-tasks').waitFor({ state: 'visible' });
  const row = page.locator('#h5-tasks .h5-terminal-main', { hasText: 'Claude: login fix' });
  if (!(await row.count())) await page.locator('.h5-task-item', { hasText: 'Fix login' }).tap();
  await row.tap();
  await page.waitForFunction(() => !document.body.classList.contains('h5-tasks-open'));
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-bnav'));
}

async function checkCharts(page) {
  // Tiles: the streak and the best, this week vs last, right in points, remembered well of all.
  assert.deepEqual(await texts(page, '.h5-learn-tile'), [
    'Streak 5 days best 12', 'This week 143 answers · +38 vs last', 'Right this week 76% +3 points vs last', 'Remembered well 118 of 430 cards',
  ]);
  // The four charts with the design's titles, in its order.
  assert.deepEqual(await texts(page, '.h5-learn-chart h3'), ['Answers per day', 'Right answers by week', 'Memory strength', 'Due in the next 14 days']);
  assert.equal(await page.locator('#h5-learn-chart-daily-svg .h5-learn-column').count(), DAILY.filter(Boolean).length, 'a column per day with answers');
  assert.equal(await page.locator('#h5-learn-chart-daily-svg .h5-learn-slot').count(), 30, 'every day has a hit target');
  const widths = await page.locator('#h5-learn-chart-daily-svg .h5-learn-column').evaluateAll(els => els.map(el => el.getBBox().width));
  assert.ok(widths.every(w => w <= 24 && w >= 2), `columns are thin: ${widths[0]}`);
  assert.equal(await page.locator('#h5-learn-chart-weekly-svg .h5-learn-line-path').count(), 1);
  assert.equal(await text(page, '#h5-learn-chart-weekly-svg .h5-learn-line-label'), '76%', 'the last value labels the end of the line');
  assert.equal(await page.locator('#h5-learn-chart-weekly-svg .h5-learn-line-end').getAttribute('r'), '4');
  assert.deepEqual(await texts(page, '.h5-learn-memory-value'), ['182', '64', '66', '118']);
  assert.equal(await page.locator('#h5-learn-chart-due-svg .h5-learn-column').count(), 14);
  assert.deepEqual(await texts(page, '#h5-learn-chart-due-svg .h5-learn-xlabel'), ['Today', shortDay(STATS.due[6].day), shortDay(STATS.due[13].day)]);
  assert.deepEqual(await texts(page, '#h5-learn-chart-daily-svg .h5-learn-xlabel'), [0, 14, 29].map(i => shortDay(STATS.daily[i].day)));
  // One hue: every mark is the theme's primary.
  const fills = await page.locator('.h5-learn-column').evaluateAll(els => [...new Set(els.map(el => el.getAttribute('fill')))]);
  assert.deepEqual(fills, ['#90caf9']);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    // ── 1440x900 (mouse) ──
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 1440, height: 900 } });
      await page.locator('#h5-nav-learn').click();
      await page.locator(COACH).waitFor();
      await openScreen(page, 'progress');
      await page.locator('#h5-learn-progress-tiles').waitFor();
      assert.equal(await text(page, '#h5-learn-view-title'), 'Progress');
      assert.equal(await page.locator('.h5-learn-pane #h5-learn-progress-charts').count(), 1, 'in the page');
      await page.locator('#h5-learn-chart-daily-svg').waitFor();
      await checkCharts(page);
      // Two charts per row, four tiles in a row.
      const [daily, weekly, memory] = await Promise.all(['#h5-learn-chart-daily', '#h5-learn-chart-weekly', '#h5-learn-chart-memory'].map(selector => rect(page, selector)));
      assert.equal(daily.y, weekly.y, 'the first two charts side by side');
      assert.ok(memory.y > daily.bottom, 'the next two below');
      const tileRows = new Set(await page.locator('.h5-learn-tile').evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().y))));
      assert.equal(tileRows.size, 1, 'four tiles in one row');
      // Hover a column: its day, the answers and how many were right; the column lifts.
      const at = await slotCenter(page, 'h5-learn-chart-daily-svg', 23);
      await page.mouse.move(at.x, at.y);
      await page.locator('#h5-learn-chart-daily .h5-learn-chart-tip').waitFor();
      assert.equal(await text(page, '#h5-learn-chart-daily .h5-learn-chart-tip'), `${shortDay(STATS.daily[23].day)} · 40 answers 31 right (78%)`);
      assert.equal(await page.locator('#h5-learn-chart-daily-svg .h5-learn-column[data-index="23"]').getAttribute('fill'), 'rgb(177, 217, 250)', 'the hovered column is lighter');
      const zero = await slotCenter(page, 'h5-learn-chart-daily-svg', 0);
      await page.mouse.move(zero.x, zero.y);
      assert.equal(await text(page, '#h5-learn-chart-daily .h5-learn-chart-tip'), `${shortDay(STATS.daily[0].day)} No answers`, 'an empty day has a tooltip too');
      await page.mouse.move(5, 5);
      await page.locator('#h5-learn-chart-daily .h5-learn-chart-tip').waitFor({ state: 'detached' });
      // Hover the line: the nearest week, with a crosshair.
      const line = await rect(page, '#h5-learn-chart-weekly-svg .h5-learn-line-hit');
      await page.mouse.move(line.x + line.w * 0.55, line.y + line.h / 2);
      await page.locator('#h5-learn-chart-weekly .h5-learn-chart-tip').waitFor();
      assert.match(await text(page, '#h5-learn-chart-weekly .h5-learn-chart-tip'), /^(6[3-9]|7[0-4])% right the first time Week of \w+ \d+ · 100 cards$/);
      assert.equal(await page.locator('#h5-learn-chart-weekly-svg .h5-learn-crosshair').count(), 1);
      await page.mouse.move(line.right - 2, line.y + 4);
      assert.equal(await text(page, '#h5-learn-chart-weekly .h5-learn-chart-tip'), `76% right the first time Week of ${shortDay(STATS.weekly[11].week_start)} · 100 cards`);
      // The keyboard: focus shows the last slot, the arrows move.
      await page.mouse.move(5, 5);
      await page.locator('#h5-learn-chart-due-svg').focus();
      assert.equal(await text(page, '#h5-learn-chart-due .h5-learn-chart-tip'), `6 cards ${shortDay(STATS.due[13].day)}`);
      for (let i = 0; i < 13; i += 1) await page.keyboard.press('ArrowLeft');
      assert.equal(await text(page, '#h5-learn-chart-due .h5-learn-chart-tip'), '21 cards Today, with the overdue ones');
      // The memory rows: a tooltip with the share of all cards.
      await page.locator('.h5-learn-memory-row[data-group="mature"]').hover();
      assert.equal(await text(page, '#h5-learn-chart-memory .h5-learn-chart-tip'), '118 cards Remembered well · 27% of all cards');
      await page.mouse.move(5, 5);
      await shot(page, 'progress-desktop.png');
      // Table: every chart as a table; Charts goes back.
      await page.locator('#h5-learn-progress-table').click();
      await page.locator('#h5-learn-progress-tables').waitFor();
      assert.equal(await text(page, '#h5-learn-progress-table'), 'Charts');
      assert.equal(await page.locator('#h5-learn-progress-table').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('.h5-learn-progress-table').count(), 4);
      assert.equal(await page.locator('#h5-learn-table-daily tbody tr').count(), 30);
      assert.deepEqual(await texts(page, '#h5-learn-table-daily tbody tr:first-child td'), [shortDay(STATS.daily[29].day), '21', '16 (76%)'], 'the newest day first');
      assert.deepEqual(await texts(page, '#h5-learn-table-weekly tbody tr:first-child td'), [shortDay(STATS.weekly[11].week_start), '100', '76 (76%)']);
      assert.deepEqual(await texts(page, '#h5-learn-table-memory tbody td'), ['New (never answered)', '182', 'Learning (under 1 day)', '64', 'Getting there (1 to 21 days)', '66', 'Remembered well (21 days or more)', '118']);
      assert.deepEqual(await texts(page, '#h5-learn-table-due tbody tr:first-child td'), ['Today', '21']);
      await shot(page, 'progress-desktop-table.png');
      await page.locator('#h5-learn-progress-table').click();
      await page.locator('#h5-learn-progress-charts').waitFor();

      // A failed load: said with Retry, which loads again.
      mock.statsFail = true;
      await page.locator('#h5-learn-back').click();
      await page.locator(COACH).waitFor();
      await openScreen(page, 'progress');
      await page.locator('#h5-learn-progress-error').waitFor();
      assert.match(await text(page, '#h5-learn-progress-error'), /Learning data is not available right now/);
      mock.statsFail = false;
      await page.locator('#h5-learn-progress-error button').click();
      await page.locator('#h5-learn-progress-tiles').waitFor();

      // The grade buttons: when each grade brings the card back; the suggested one stays contained and Enter takes it.
      await openScreen(page, 'review');
      await page.locator('#h5-learn-spell-input').waitFor();
      await page.locator('.h5-learn-letters').click();
      await page.keyboard.type('ship');
      await page.keyboard.press('Enter');
      await page.locator('#h5-learn-feedback[data-correct="true"]').waitFor();
      assert.deepEqual(await texts(page, '#h5-learn-feedback .h5-learn-grade-when'), ['10 min', '2 days', '5 days']);
      assert.deepEqual(await texts(page, '#h5-learn-feedback .h5-learn-grades button'), ['Again1 10 min', 'Hard2 2 days', 'Good3 5 days']);
      assert.equal(await page.locator('#h5-learn-grade-good').evaluate(el => el.classList.contains('MuiButton-contained')), true);
      assert.equal(await page.locator('#h5-learn-grade-good').getAttribute('aria-label'), 'Good, 5 days');
      const grades = await page.locator('#h5-learn-feedback .h5-learn-grades button').evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().y)));
      assert.equal(new Set(grades).size, 1, 'one row');
      await shot(page, 'grades-desktop.png');
      await page.keyboard.press('Enter');
      await waitFor(() => mock.posts(/\/answer$/).length === 1, 'the answer');
      assert.deepEqual(lastAnswer(mock), { id: '1', mode: 'spell', grade: 'good', correct: true, answer: 'ship' });
      // The next card has no `next` (an older server): the plain buttons, the keys still work.
      await page.locator('.h5-learn-letters').click();
      await page.keyboard.type('code');
      await page.keyboard.press('Enter');
      await page.locator('#h5-learn-feedback[data-correct="true"]').waitFor();
      assert.equal(await page.locator('.h5-learn-grade-when').count(), 0);
      assert.deepEqual(await texts(page, '#h5-learn-feedback .h5-learn-grades button'), ['Again1', 'Hard2', 'Good3']);
      await page.keyboard.press('2');
      await waitFor(() => mock.posts(/\/answer$/).length === 2, 'the second answer');
      assert.equal(lastAnswer(mock).grade, 'hard');
      await page.locator('#h5-learn-done').waitFor();

      // REVIEW SCHEDULE: 90% chosen; 95% is saved at once.
      await openScreen(page, 'settings');
      await page.locator('#h5-learn-retention').waitFor();
      assert.equal(await text(page, '#h5-learn-schedule-card'), 'Remember How sure you want to be when a card comes back 85% 90% 95% Cards are scheduled with FSRS, a model of how memory fades, from your own answers. Higher means more reviews; 90% is a good balance.');
      assert.equal(await page.locator('#h5-learn-retention [data-value="0.9"]').getAttribute('aria-pressed'), 'true');
      const overlines = await texts(page, '.h5-learn-pane h3.MuiTypography-overline');
      assert.ok(overlines.includes('REVIEW SCHEDULE'), overlines.join(', '));
      await page.locator('#h5-learn-retention [data-value="0.95"]').click();
      await waitFor(() => mock.posts(/\/settings$/).some(item => item.body.desired_retention === 0.95), 'the retention is saved');
      assert.deepEqual(mock.posts(/\/settings$/).at(-1).body, { desired_retention: 0.95 });
      await page.locator('#h5-learn-retention [data-value="0.95"][aria-pressed="true"]').waitFor();
      await page.locator('#h5-learn-schedule-card').scrollIntoViewIfNeeded();
      await shot(page, 'schedule-desktop.png');
      // How learning works describes FSRS, not the old fixed steps.
      await openScreen(page, 'how');
      assert.match(await text(page, '#h5-learn-how-card'), /FSRS, a model of how memory fades/);
      assert.doesNotMatch(await text(page, '#h5-learn-how-card'), /1, 3, 7, 15, 30/);
      await context.close();
    }

    // ── 390x844 (touch) ──
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 390, height: 844 }, touch: true });
      await toTerminal(page);
      await page.locator('#h5-bnav-learn').tap();
      await page.locator(COACH).waitFor();
      await openScreen(page, 'progress');
      await page.locator('#h5-learn-mode #h5-learn-chart-daily-svg').waitFor();
      await page.waitForTimeout(400);
      assert.equal(await text(page, '#h5-learn-view-title'), 'Progress');
      assert.equal(await text(page, '#h5-learn-mode #h5-learn-progress-table'), 'Table', 'Table in the bar');
      await checkCharts(page);
      assert.equal(await noSidewaysScroll(page), true, 'the view fits 390px');
      const tiles = await page.locator('.h5-learn-tile').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; }));
      assert.equal(tiles[0][1], tiles[1][1], 'two tiles per row');
      assert.ok(tiles[2][1] > tiles[0][1], 'then the next two');
      assert.ok(tiles[0][0] >= 16, 'the 16px gutter');
      const [daily, weekly] = await Promise.all(['#h5-learn-chart-daily', '#h5-learn-chart-weekly'].map(selector => rect(page, selector)));
      assert.ok(weekly.y > daily.bottom, 'one chart per row');
      await shot(page, 'progress-phone.png');
      // A tap on a column shows its tooltip; a second tap hides it.
      const at = await slotCenter(page, 'h5-learn-chart-daily-svg', 23);
      await page.touchscreen.tap(at.x, at.y);
      await page.locator('#h5-learn-chart-daily .h5-learn-chart-tip').waitFor();
      assert.equal(await text(page, '#h5-learn-chart-daily .h5-learn-chart-tip'), `${shortDay(STATS.daily[23].day)} · 40 answers 31 right (78%)`);
      const tip = await rect(page, '#h5-learn-chart-daily .h5-learn-chart-tip');
      const box = await rect(page, '#h5-learn-chart-daily');
      assert.ok(tip.x >= box.x && tip.right <= box.right, 'the tooltip stays inside the card');
      await shot(page, 'progress-phone-tooltip.png');
      await page.touchscreen.tap(at.x, at.y);
      await page.locator('#h5-learn-chart-daily .h5-learn-chart-tip').waitFor({ state: 'detached' });
      // A tap on the line.
      const line = await rect(page, '#h5-learn-chart-weekly-svg .h5-learn-line-hit');
      await page.touchscreen.tap(line.right - 4, line.y + line.h / 2);
      await page.locator('#h5-learn-chart-weekly .h5-learn-chart-tip').waitFor();
      assert.match(await text(page, '#h5-learn-chart-weekly .h5-learn-chart-tip'), /^76% right the first time/);
      await page.locator('#h5-learn-chart-due').scrollIntoViewIfNeeded();
      await shot(page, 'progress-phone-bottom.png');
      await page.locator('#h5-learn-mode #h5-learn-progress-table').tap();
      await page.locator('#h5-learn-progress-tables').waitFor();
      await page.waitForTimeout(300);
      assert.equal(await noSidewaysScroll(page), true, 'the tables fit 390px');
      await shot(page, 'progress-phone-table.png');
      // The empty state: one line instead of the charts, no Table.
      mock.stats = EMPTY_STATS;
      await page.locator('#h5-learn-back').tap();
      await page.locator(COACH).waitFor();
      await openScreen(page, 'progress');
      await page.locator('#h5-learn-progress-empty').waitFor();
      assert.equal(await text(page, '#h5-learn-progress-empty'), 'Answer a few cards and your progress shows here.');
      assert.equal(await page.locator('#h5-learn-progress-charts').count(), 0);
      assert.equal(await page.locator('#h5-learn-progress-table').count(), 0);
      await shot(page, 'progress-phone-empty.png');
      await page.locator('#h5-learn-back').tap();
      await page.locator(COACH).waitFor();

      // The grade buttons in the pinned actions: one row, 44px targets, the interval under each label.
      await openScreen(page, 'review');
      await page.locator('#h5-learn-keys[data-kind="letters"]').waitFor({ state: 'visible' });
      await tapKeys(page, 'ship');
      await page.locator('#h5-learn-check').tap();
      await page.locator('#h5-learn-feedback[data-correct="true"]').waitFor();
      assert.deepEqual(await texts(page, '.h5-learn-footer .h5-learn-grade-when'), ['10 min', '2 days', '5 days']);
      const buttons = await page.locator('.h5-learn-footer .h5-learn-grades button').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { y: Math.round(r.y), w: r.width, h: r.height, right: r.right }; }));
      assert.equal(new Set(buttons.map(b => b.y)).size, 1, 'one row');
      assert.ok(buttons.every(b => b.h >= 44 && b.w >= 44), `44px targets: ${JSON.stringify(buttons)}`);
      assert.ok(buttons[2].right <= 390 - 16 + 1, 'inside the gutter');
      await shot(page, 'grades-phone-390.png');
      await page.locator('#h5-learn-grade-good').tap();
      await waitFor(() => mock.posts(/\/answer$/).length === 1, 'the answer');
      assert.equal(lastAnswer(mock).grade, 'good');
      // The back button: the session returns to the coach, then the coach closes Learn.
      await page.evaluate(() => history.back());
      await page.locator('#h5-learn-mode').waitFor({ state: 'detached' });
      await page.locator(COACH).waitFor();

      // Settings of an older server (no desired_retention): no REVIEW SCHEDULE. The session was a modal of its own over the coach, so the next
      // back press closes Learn at once (no wait for back.mjs to take an entry again).
      delete mock.settings.desired_retention;
      await page.evaluate(() => history.back());
      await page.locator('#h5-learn').waitFor({ state: 'detached' });
      await page.locator('#h5-bnav-learn').tap();
      await page.locator(COACH).waitFor();
      await openScreen(page, 'settings');
      await page.locator('#h5-learn-settings-card').waitFor();
      assert.equal(await page.locator('#h5-learn-retention').count(), 0);
      await context.close();
    }

    // ── 320x640 (touch): the grade buttons still fit in one row ──
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 320, height: 640 }, touch: true });
      await toTerminal(page);
      await page.locator('#h5-bnav-learn').tap();
      mock.queue = [{ ...QUEUE[0], next: { again: 600000, hard: 20 * DAY, good: 400 * DAY } }];
      await page.locator(COACH).waitFor();
      await openScreen(page, 'review');
      await page.locator('#h5-learn-keys[data-kind="letters"]').waitFor({ state: 'visible' });
      await tapKeys(page, 'ship');
      await page.locator('#h5-learn-check').tap();
      await page.locator('#h5-learn-feedback[data-correct="true"]').waitFor();
      assert.deepEqual(await texts(page, '.h5-learn-footer .h5-learn-grade-when'), ['10 min', '20 days', '1.1 yr']);
      const buttons = await page.locator('.h5-learn-footer .h5-learn-grades button').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { y: Math.round(r.y), w: r.width, h: r.height, right: r.right, fits: el.scrollWidth <= el.clientWidth + 1 }; }));
      assert.equal(new Set(buttons.map(b => b.y)).size, 1, 'one row at 320px');
      assert.ok(buttons.every(b => b.h >= 44 && b.w >= 44 && b.fits), `44px targets, nothing cut: ${JSON.stringify(buttons)}`);
      assert.ok(buttons[2].right <= 320 - 16 + 1, 'inside the gutter');
      assert.equal(await noSidewaysScroll(page), true, 'no sideways scroll at 320px');
      await shot(page, 'grades-phone-320.png');
      await context.close();
    }

    assert.deepEqual(pageErrors, []);
    console.log('Learn progress browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
