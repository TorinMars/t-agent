// The Mistakes page and the mistake reports of Learn (scripts/h5-shell/LearnMistakes.jsx), in real Chromium with every route mocked, /api/learn
// following docs/design/learn-english.md ("Mistakes", "Mistake reports"). No model is ever called: POST /api/learn/reports is answered by the mock.
// - 1440x900 (mouse): the one line on the Learn home for a new weekly report and its View; the report (range, summary, kinds as bars, findings with
//   cause, what to do and cards); opening it marks it seen (PUT report_seen); "Practise these N cards" finds the cards by text and starts a session;
//   the Mistakes page: the Analyze card with the count since the last report, every wrong answer newest first with its mode chip and tag chip,
//   Show more, Analyze (the body has only the page's language, the report opens), a model error shown in the card, All reports; the weekly switch in
//   Learn settings; the page's language told to the server once when it differs.
// - Without a usable model: the card says so with Open Settings, Analyze is off and the list still works.
// - 390x844 (touch): the Mistakes page and a report fit the width (no sideways scroll), chips wrap.
// H5_SHOT_DIR=<dir> saves mistakes-desktop.png, mistakes-phone.png, mistakes-report-phone.png, mistakes-no-model-phone.png.
const { chromium } = require('playwright');
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
const ZH = '\u5fc5\u8981\u7684';

const TASKS = [{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }];
const TERMINALS = { 1: [{ terminal_id: 'c1', title: 'Claude: login fix', agent: 'claude' }] };
const card = (id, kind, en) => ({ id, kind, en, zh: ZH, phonetic: '', source: 'manual', context: '', due_at: iso(NOW), interval_days: 0, ease: 2.5, reps: 1, lapses: 1, last_result: 'again', last_at: iso(NOW), suspended: false, created_at: iso(NOW - 9 * DAY) });
const CARDS = [card(1, 'word', 'expire'), card(2, 'sentence', 'He has already left.'), card(3, 'word', 'necessary'), card(4, 'sentence', 'I look forward to hearing from you.'), card(5, 'word', 'address')];
const mistake = (uid, at, mode, tag, expected, written, id, extra = {}) => ({ uid, at: iso(at), mode, tag, hinted: false, expected, written, card: { id, kind: CARDS[id - 1].kind, en: CARDS[id - 1].en }, ...extra });
const MISTAKES = [
  mistake('m1', NOW - 60000, 'spell', 'letter-order', 'expire', 'expier', 1),
  mistake('m2', NOW - 120000, 'build', 'tense', 'He has already left.', 'He already left.', 2),
  mistake('m3', NOW - DAY, 'spell', 'double-letter', 'necessary', 'neccesary', 3, { hinted: true }),
  mistake('m4', NOW - 2 * DAY, 'dictation', 'verb-form', 'I look forward to hearing from you.', 'I look forward to hear from you.', 4),
  mistake('m5', NOW - 3 * DAY, 'spell', 'unknown', 'address', '', 5),
];
const REPORT = {
  uid: 'auto-2026-W47', created_at: iso(NOW - 3600000), covers_from: iso(NOW - 7 * DAY), covers_until: iso(NOW - 3600000), auto: true, lang: 'en', mistakes: 38, answers: 212,
  summary: 'Most of your mistakes are spelling slips in long words and the present perfect. Listening is your strongest side.',
  kinds: [{ kind: 'spelling', count: 17 }, { kind: 'tense', count: 9 }, { kind: 'verb-form', count: 6 }, { kind: 'article', count: 4 }, { kind: 'listening', count: 2 }],
  findings: [
    { title: 'Double letters', cause: 'You drop or move one of a pair (neccesary, adress, occured).', action: 'Spell these 8 words in a group for three days; say the pair aloud.', cards: ['necessary', 'address', 'occurred', 'committee', 'success'].map(en => ({ kind: 'word', en })) },
    { title: 'Present perfect with "already"', cause: 'Chinese has no tense marker here, so "has" is left out.', action: 'Build the sentence cards with already / just / yet; read each aloud once.', cards: [{ kind: 'sentence', en: 'He has already left.' }] },
  ],
  model: 'DeepSeek deepseek-flash',
};
const SUMMARY = { due: 4, new_today: 1, done_today: 3, goal: 20, streak: 2, words: 12, sentences: 6, mistakes: 5, collecting: true, starter: null, new_report: { uid: REPORT.uid, created_at: REPORT.created_at, mistakes: 38 } };
const pageErrors = [];

function learnMock() {
  const mock = {
    summary: { ...SUMMARY }, settings: { collect: true, daily_goal: 20, starter: null, analysis_auto: true, report_seen: '', report_lang: 'en' }, requests: [],
    state: { reports: [{ ...REPORT, kinds: undefined, findings: undefined }, { uid: 'r-older-0001', created_at: iso(NOW - 8 * DAY), covers_from: null, covers_until: iso(NOW - 8 * DAY), auto: false, lang: 'en', mistakes: 12, answers: 80, summary: 'Articles were the main slip.' }],
      since: { from: iso(NOW - 3600000), mistakes: 5, answers: 40 }, model: { ready: true, label: 'DeepSeek', name: 'deepseek-flash' }, running: false, auto: true },
    analyze: () => ({ report: { ...REPORT, uid: 'r-new-00001', auto: false, mistakes: 5, answers: 40, covers_from: iso(NOW - 3600000), covers_until: iso(NOW) } }),
    mistakes: MISTAKES,
  };
  mock.handle = (p, method, url, body) => {
    mock.requests.push({ method, path: p, search: url.search, body });
    // Like the server: an automatic report the person opened is not offered again.
    if (p === '/api/learn/summary') return { ...mock.summary, new_report: mock.summary.new_report && mock.summary.new_report.uid !== mock.settings.report_seen ? mock.summary.new_report : null };
    if (p === '/api/learn/settings' && method === 'GET') return mock.settings;
    if (p === '/api/learn/settings' && method === 'PUT') { mock.settings = { ...mock.settings, ...body }; return mock.settings; }
    if (p === '/api/learn/mistakes') {
      const before = url.searchParams.get('before');
      const list = before ? mock.mistakes.filter(item => item.at < before) : mock.mistakes;
      const limit = Number(url.searchParams.get('limit')) || 50;
      return { mistakes: list.slice(0, mock.page || limit), more: list.length > (mock.page || limit) };
    }
    if (p === '/api/learn/reports' && method === 'GET') return mock.state;
    if (p === '/api/learn/reports' && method === 'POST') return mock.analyze(body);
    if (p.startsWith('/api/learn/reports/')) return { report: REPORT };
    if (p === '/api/learn/cards/find') return { cards: CARDS.filter(item => (body.refs || []).some(ref => ref.en === item.en)) };
    if (p === '/api/learn/queue') return { cards: [CARDS[0], CARDS[2]] };
    if (p === '/api/learn/meaning') return { zh: ZH, phonetic: '' };
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

const text = (page, selector) => page.locator(selector).first().evaluate(el => el.textContent.replace(/\s+/g, ' ').trim());
const texts = (page, selector) => page.locator(selector).evaluateAll(els => els.map(el => el.textContent.replace(/\s+/g, ' ').trim()));
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, name) }); } };
const waitFor = async (check, message, timeout = 5000) => {
  const end = Date.now() + timeout;
  for (;;) { if (await check()) return; if (Date.now() > end) throw new Error(`timed out: ${message}`); await new Promise(resolve => setTimeout(resolve, 50)); }
};
// No sideways scroll in the open page: every scroll box of the Learn dialogs fits its width.
const noSidewaysScroll = page => page.evaluate(() => [...document.querySelectorAll('#h5-learn-mode .h5-learn-scroll, #h5-learn-mode .MuiCard-root')].every(el => el.scrollWidth <= el.clientWidth + 1));

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

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    // ── 1440x900 (mouse) ──
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 1440, height: 900 } });
      await page.locator('#h5-nav-learn').click();
      // The new weekly report: one line on the home with View.
      await page.locator('#h5-learn-new-report').waitFor();
      assert.equal(await text(page, '#h5-learn-new-report .MuiAlert-message'), 'Your weekly mistake report is ready (38 mistakes).');
      assert.equal(mock.posts(/\/settings$/).length, 0, 'the page language is the stored one: nothing to tell');
      await page.locator('#h5-learn-new-report-view').click();
      await page.locator('#h5-learn-report-summary').waitFor();
      assert.equal(await text(page, '#h5-learn-view-title'), 'Mistake report');
      assert.match(await text(page, '#h5-learn-report-range'), /^\d\d-\d\d – \d\d-\d\d · 38 mistakes in 212 answers$/);
      assert.equal(await text(page, '#h5-learn-report-summary'), REPORT.summary);
      assert.equal(await page.locator('#h5-learn-report-summary').getAttribute('translate'), 'no', "the model's text is never translated again");
      assert.deepEqual(await texts(page, '.h5-learn-report-kind'), ['Spelling17', 'Tense9', 'Verb forms6', 'Articles4', 'Listening2']);
      const bars = await page.locator('.h5-learn-report-kind [role="progressbar"]').evaluateAll(els => els.map(el => Number(el.getAttribute('aria-valuenow'))));
      assert.deepEqual(bars, [100, 53, 35, 24, 12], 'bars relative to the largest kind');
      assert.deepEqual(await texts(page, '.h5-learn-finding h3'), ['Double letters', 'Present perfect with "already"']);
      assert.match(await text(page, '.h5-learn-finding'), /Cause · You drop or move one of a pair.*What to do · Spell these 8 words.*necessary · address · occurred \+2/);
      await waitFor(() => mock.posts(/\/settings$/).some(item => item.body.report_seen === REPORT.uid), 'the report is marked as seen');
      await page.locator('#h5-learn-new-report').waitFor({ state: 'detached' });
      assert.equal(await text(page, '#h5-learn-report-practise'), 'Practise these 6 cards');
      await page.locator('#h5-learn-report-practise').click();
      await waitFor(() => mock.posts(/\/cards\/find$/).length === 1, 'the cards are found by text');
      assert.deepEqual(mock.posts(/\/cards\/find$/)[0].body.refs.map(ref => ref.en), ['necessary', 'address', 'occurred', 'committee', 'success', 'He has already left.']);
      await page.locator('.h5-learn-subtitle').waitFor();
      assert.equal(await text(page, '#h5-learn-view-title'), 'Mistakes');
      assert.equal(await text(page, '.h5-learn-subtitle'), '1 / 3', 'the cards this engine has');

      // The Mistakes page.
      mock.page = 4;
      await page.locator('#h5-learn-mode-mistakes').click();
      await page.locator('#h5-learn-mistakes').waitFor();
      assert.equal(await text(page, '#h5-learn-analyze-card h3'), 'Why do I get these wrong?');
      assert.match(await text(page, '#h5-learn-analyze-note'), /^5 mistakes since the last report \(\d\d-\d\d\)\. The analysis uses your translation model\.$/);
      assert.deepEqual(await texts(page, '.h5-learn-mistake-expected'), ['expire', 'He has already left.', 'necessary', 'I look forward to hearing from you.']);
      assert.deepEqual(await texts(page, '.h5-learn-mistake-written'), ['You wrote: expier', 'You wrote: He already left.', 'You wrote: neccesary', 'You wrote: I look forward to hear from you.']);
      assert.deepEqual(await texts(page, '.h5-learn-mode-chip'), ['Spell the word', 'Build the sentence', 'Spell the word', 'Dictation']);
      assert.deepEqual(await texts(page, '.h5-learn-tag-chip'), ['letter order', 'tense', 'double letter', 'verb form']);
      assert.equal(await page.locator('.h5-learn-hint-chip').count(), 1, 'help used is said once');
      assert.match(await text(page, '.h5-learn-mistake'), /today/);
      assert.match(await texts(page, '.h5-learn-mistake').then(all => all[2]), /yesterday/);
      await page.locator('#h5-learn-mistakes-more').click();
      await waitFor(async () => (await page.locator('.h5-learn-mistake').count()) === 5, 'the next page');
      assert.equal(await text(page, '.h5-learn-mistake:last-of-type .h5-learn-mistake-written'), "You didn't know it");
      assert.ok(mock.requests.some(item => item.path === '/api/learn/mistakes' && /before=/.test(item.search)), 'the next page starts before the last one shown');
      await shot(page, 'mistakes-desktop.png');
      // Analyze: only the page's language goes in the body; while it runs it says so; the new report opens.
      let release;
      mock.analyze = () => new Promise(resolve => { release = () => resolve({ report: { ...REPORT, uid: 'r-new-00001', auto: false, summary: 'Fresh report.' } }); });
      await page.locator('#h5-learn-analyze').click();
      await page.locator('#h5-learn-analyzing').waitFor();
      assert.equal(await page.locator('#h5-learn-analyze').isDisabled(), true, 'one run at a time');
      assert.deepEqual(mock.posts(/\/reports$/)[0].body, { lang: 'en' });
      release();
      await page.locator('#h5-learn-report-summary', { hasText: 'Fresh report.' }).waitFor();
      // A model error is shown in the card, the page stays whole.
      mock.analyze = () => [502, { error: "The model's answer could not be read. Try again." }];
      await page.locator('#h5-learn-mode-mistakes').click();
      await page.locator('#h5-learn-analyze:not([disabled])').click();
      await page.locator('#h5-learn-analyze-error').waitFor();
      assert.equal(await text(page, '#h5-learn-analyze-error'), "The model's answer could not be read. Try again.");
      assert.equal(await page.locator('.h5-learn-mistake').count(), 4, 'the list (its first page) is still there');
      // All reports, then one of them.
      await page.locator('#h5-learn-all-reports').click();
      await page.locator('.h5-learn-report-row').first().waitFor();
      assert.equal(await page.locator('.h5-learn-report-row').count(), 2);
      assert.match(await text(page, '.h5-learn-report-row'), /38 mistakes · Weekly/);
      assert.match(await texts(page, '.h5-learn-report-row').then(all => all[1]), /the start – .*12 mistakes · Asked for/);
      // The weekly switch in Learn settings.
      await page.locator('#h5-learn-settings').click();
      await page.locator('#h5-learn-analysis-auto').waitFor();
      assert.equal(await page.locator('#h5-learn-analysis-auto').isChecked(), true);
      await page.locator('#h5-learn-analysis-auto').click();
      await waitFor(() => mock.posts(/\/settings$/).some(item => item.body.analysis_auto === false), 'the switch is saved');
      await context.close();
    }

    // ── The page's language differs from the stored one: told once ──
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 1440, height: 900 } });
      mock.settings.report_lang = 'zh';
      await page.locator('#h5-nav-learn').click();
      await page.locator('#h5-learn-today').waitFor();
      await waitFor(() => mock.posts(/\/settings$/).length === 1, 'the language is told');
      assert.deepEqual(mock.posts(/\/settings$/)[0].body, { report_lang: 'en' });
      await context.close();
    }

    // ── 390x844 (touch): the Mistakes page, a report, and no model ──
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 390, height: 844 }, touch: true });
      mock.summary = { ...SUMMARY, new_report: null };
      await toTerminal(page);
      await page.locator('#h5-bnav-learn').tap();
      await page.locator('#h5-learn-mode-mistakes').tap();
      await page.locator('#h5-learn-mistakes').waitFor();
      await page.waitForTimeout(400);
      assert.equal(await noSidewaysScroll(page), true, 'the Mistakes page fits 390px');
      const card = await page.locator('#h5-learn-analyze-card').boundingBox();
      assert.ok(card.x >= 16 && card.x + card.width <= 390 - 16 + 1, 'the card keeps the 16px gutter');
      await shot(page, 'mistakes-phone.png');
      await page.locator('#h5-learn-last-report').tap();
      await page.locator('#h5-learn-report-summary').waitFor();
      await page.waitForTimeout(400);
      assert.equal(await noSidewaysScroll(page), true, 'the report fits 390px');
      await shot(page, 'mistakes-report-phone.png');
      await page.locator('#h5-learn-report-findings').scrollIntoViewIfNeeded();
      await shot(page, 'mistakes-report-findings-phone.png');
      // Back goes to the Mistakes page the report was opened from, then to the home.
      await page.locator('#h5-learn-back').tap();
      await page.locator('#h5-learn-analyze-card').waitFor();
      assert.equal(await text(page, '#h5-learn-view-title'), 'Mistakes');
      // No usable model: said in the card with Open Settings; Analyze is off; the list stays.
      mock.state = { ...mock.state, model: { ready: false, label: '', name: '' } };
      await page.locator('#h5-learn-back').tap();
      await page.locator('#h5-learn-mode').waitFor({ state: 'detached' });
      await page.locator('#h5-learn-mode-mistakes').tap();
      await page.locator('#h5-learn-analyze-no-model').waitFor();
      assert.match(await text(page, '#h5-learn-analyze-no-model'), /needs an AI translation model.*The list and the tags work without it/);
      assert.equal(await page.locator('#h5-learn-analyze').isDisabled(), true);
      assert.equal(await page.locator('.h5-learn-mistake').count(), 5);
      await shot(page, 'mistakes-no-model-phone.png');
      await context.close();
    }

    assert.deepEqual(pageErrors, []);
    console.log('Learn mistakes browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
