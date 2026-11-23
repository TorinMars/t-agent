// "Learn at a calmer pace" on the Learn page (scripts/h5-shell/Learn.jsx, learn-grade.mjs), in real Chromium with every route mocked: the summary with
// `new_per_day`, `new_today`, `new_left` and `minutes_today`, queue cards with `leech`, `missed`, `parts` and `tip`, POST /api/learn/new-words and
// learning settings with `new_per_day` ("Almost", "Keeps slipping", "Round done", "Done for today" and "New words a day" in
// docs/design/learn-english-page.md).
// - 390x844 (touch): the new-words line of the Today card; a word one letter off says Almost (warning colour), offers Hard and names the spelling
//   pattern; a word that keeps slipping is copied in parts, then typed from memory (Show parts is help); Round done with the counts, the bar and its
//   legend, the words to work on and the break note; Next round on an empty queue says Done for today, with 5 more new words (POST, then the queue
//   again) and Practise anyway (extra=practice); NEW WORDS in Learn settings saves new_per_day; Practice asks for extra=practice.
// - 1440x900 (mouse): Almost with the keys (Enter takes Hard); an older server (no new fields): no new-words line, the old empty text, no NEW WORDS.
// H5_SHOT_DIR=<dir> saves pace-home.png, pace-almost.png, pace-parts-copy.png, pace-parts-recall.png, pace-round-done.png, pace-done-today.png,
// pace-settings.png and pace-almost-desktop.png.
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
const ZH_EXTENSION = '\u6269\u5c55';
const ZH_TEMPORARILY = '\u6682\u65f6\u5730';
const ZH_DEPLOY = '\u90e8\u7f72';

const TASKS = [{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }];
const TERMINALS = { 1: [{ terminal_id: 'c1', title: 'Claude: login fix', agent: 'claude' }] };
const card = (id, en, zh, extra = {}) => ({
  id, kind: 'word', en, zh, phonetic: '', source: 'starter', context: '', due_at: iso(NOW), interval_days: 3, reps: 2, lapses: 0, last_result: 'good',
  last_at: iso(NOW - 3 * DAY), suspended: false, created_at: iso(NOW - 9 * DAY), is_new: false, missed: 0, leech: false, parts: null, tip: '', ...extra,
});
const EXTENSION = card(1, 'extension', ZH_EXTENSION);
const TEMPORARILY = card(2, 'temporarily', ZH_TEMPORARILY, { leech: true, missed: 9, parts: ['tem', 'po', 'rar', 'i', 'ly'], tip: 'temporary + -ly. Keep the ar of temporary.' });
const DEPLOY = card(3, 'deploy', ZH_DEPLOY, { is_new: true });
const SUMMARY = {
  due: 17, done_today: 7, goal: 20, streak: 4, words: 226, sentences: 124, mistakes: 41, chats: 0, collecting: true, starter: 'dev',
  new_per_day: 10, new_today: 4, new_left: 6, minutes_today: 24,
};
const LEGACY_SUMMARY = { due: 17, done_today: 7, goal: 20, streak: 4, words: 226, sentences: 124, mistakes: 41, chats: 0, collecting: true, starter: 'dev' };
const pageErrors = [];

// `spell`: the lists GET /queue?mode=spell gives without `extra`, one per request (then empty); `practice`: what it gives with extra=practice.
function learnMock({ legacy = false } = {}) {
  const mock = {
    summary: { ...(legacy ? LEGACY_SUMMARY : SUMMARY) },
    settings: legacy ? { collect: true, daily_goal: 20, starter: 'dev' } : { collect: true, daily_goal: 20, starter: 'dev', desired_retention: 0.9, new_per_day: 10 },
    spell: [[EXTENSION, TEMPORARILY, DEPLOY]], practice: [DEPLOY], requests: [],
  };
  mock.handle = (p, method, url, body) => {
    mock.requests.push({ method, path: p, search: url.search, body });
    if (p === '/api/learn/summary') return mock.summary;
    if (p === '/api/learn/settings' && method === 'GET') return mock.settings;
    if (p === '/api/learn/settings' && method === 'PUT') { mock.settings = { ...mock.settings, ...body }; return mock.settings; }
    if (p === '/api/learn/queue') {
      const mode = url.searchParams.get('mode');
      if (url.searchParams.get('extra') === 'practice') return { cards: mode === 'fill' ? [] : mock.practice };
      if (mode === 'spell' || mode === 'review') return { cards: mock.spell.shift() || [] };
      return { cards: [] };
    }
    if (p === '/api/learn/new-words' && method === 'POST') {
      mock.summary = { ...mock.summary, new_left: mock.summary.new_left + body.count };
      mock.spell.push([card(4, 'regression', '\u56de\u5f52', { is_new: true })]);
      return { new_per_day: 10, new_today: mock.summary.new_today, new_left: mock.summary.new_left };
    }
    if (/^\/api\/learn\/cards\/\d+\/answer$/.test(p)) return { card: { id: Number(p.split('/')[4]) } };
    if (p === '/api/learn/level') return { level: null, picking: { enabled: false, picked: 0, skipped: 0, sentences: 0, pending: 0, running: false }, translator: false };
    if (p === '/api/learn/chats') return { chats: [], translator: false };
    return [404, { error: 'not mocked' }];
  };
  mock.posts = re => mock.requests.filter(item => item.method !== 'GET' && re.test(item.path));
  mock.gets = re => mock.requests.filter(item => item.method === 'GET' && re.test(item.path));
  return mock;
}

async function openPage(browser, { viewport, touch = false, legacy = false }) {
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...(SHOTS ? { deviceScaleFactor: 3 } : {}) });
  const page = await context.newPage();
  const mock = learnMock({ legacy });
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

const text = (page, selector) => page.locator(selector).first().evaluate(el => (el.innerText ?? el.textContent).replace(/\s+/g, ' ').trim());
const texts = (page, selector) => page.locator(selector).evaluateAll(els => els.map(el => (el.innerText ?? el.textContent).replace(/\s+/g, ' ').trim()));
const color = (page, selector) => page.locator(selector).first().evaluate(el => getComputedStyle(el).color);
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, name) }); } };
const waitFor = async (check, message, timeout = 5000) => {
  const end = Date.now() + timeout;
  for (;;) { if (await check()) return; if (Date.now() > end) throw new Error(`timed out: ${message}`); await new Promise(resolve => setTimeout(resolve, 50)); }
};
const lastAnswer = mock => { const list = mock.posts(/\/answer$/); return list.length ? { id: list.at(-1).path.match(/cards\/(\d+)/)[1], ...list.at(-1).body } : null; };
const noSidewaysScroll = page => page.evaluate(() => [...document.querySelectorAll('#h5-learn-mode .h5-learn-scroll, #h5-learn-mode .MuiCard-root')].every(el => el.scrollWidth <= el.clientWidth + 1));
const contained = (page, selector) => page.locator(selector).evaluate(el => el.classList.contains('MuiButton-contained'));
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

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    // ── 390x844 (touch) ──
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 390, height: 844 }, touch: true });
      await toTerminal(page);
      await page.locator('#h5-bnav-learn').tap();
      // The Today card: today's new words under the due count.
      await page.locator('#h5-learn-new-words').waitFor();
      assert.equal(await text(page, '#h5-learn-new-words'), '6 new words left today · 4 of 10 learned');
      await shot(page, 'pace-home.png');

      // One letter off: Almost in the warning colour, Hard offered, the pattern named.
      await page.locator('#h5-learn-mode-spell').tap();
      await page.locator('#h5-learn-spell-input').waitFor();
      assert.equal(await text(page, '#h5-learn-meaning'), ZH_EXTENSION);
      await tapKeys(page, 'extention');
      await page.locator('#h5-learn-feedback[data-near="true"]').waitFor();
      assert.equal(await page.locator('#h5-learn-feedback').getAttribute('data-correct'), 'false');
      assert.equal(await text(page, '#h5-learn-feedback .h5-learn-result-title'), 'Almost');
      const warning = await color(page, '#h5-learn-feedback .h5-learn-result-title');
      assert.equal(warning, 'rgb(255, 167, 38)', 'the warning colour (warning.main of the dark theme)');
      assert.equal(await contained(page, '#h5-learn-grade-hard'), true, 'Hard is offered');
      assert.equal(await contained(page, '#h5-learn-grade-again'), false);
      assert.equal(await text(page, '#h5-learn-pattern'), '-sion, not -tion here');
      assert.equal(await page.locator('#h5-learn-pattern strong').textContent(), '-sion', 'the right ending stands out');
      assert.match(await text(page, '#h5-learn-feedback'), /extension.*You wrote: extention.*8 of 9 letters right/);
      assert.equal(await noSidewaysScroll(page), true, 'Almost fits 390px');
      await shot(page, 'pace-almost.png');
      await page.locator('#h5-learn-grade-hard').tap();
      await waitFor(() => mock.posts(/\/answer$/).length === 1, 'the first answer');
      assert.deepEqual(lastAnswer(mock), { id: '1', mode: 'spell', grade: 'hard', correct: false, answer: 'extention', expected: 'extension', tag: 'wrong-letter', hinted: false });

      // Keeps slipping, step 1: the parts, the tip, copy it once (Next step only when the copy matches).
      await page.locator('#h5-learn-slipping').waitFor();
      assert.equal(await text(page, '#h5-learn-slipping'), 'Keeps slipping · missed 9 times');
      assert.equal(await page.locator('.h5-learn-letters').count(), 0, 'no letter slots');
      assert.match(await text(page, '.h5-learn-prompt'), /^Learn it in parts/);
      assert.deepEqual(await texts(page, '#h5-learn-parts .h5-learn-part'), ['tem', 'po', 'rar', 'i', 'ly'], 'the card\'s own parts');
      assert.equal(await page.locator('#h5-learn-parts').getAttribute('aria-label'), 'temporarily');
      const partColors = await page.locator('#h5-learn-parts .h5-learn-part').evaluateAll(els => els.map(el => getComputedStyle(el).color));
      assert.notEqual(partColors[0], partColors[1], 'the parts alternate colours');
      assert.equal(partColors[0], partColors[2]);
      assert.equal(await text(page, '#h5-learn-tip'), 'temporary + -ly. Keep the ar of temporary.');
      assert.equal(await page.locator('#h5-learn-slow').count(), 1, 'Slowly');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'h5-learn-copy-input');
      assert.equal(await page.locator('#h5-learn-keys').count(), 1, 'the page keyboard types the copy');
      assert.equal(await page.locator('#h5-learn-next').isDisabled(), true);
      await tapKeys(page, 'tempor');
      assert.equal(await page.locator('#h5-learn-next').isDisabled(), true, 'not before the copy matches');
      assert.equal(await noSidewaysScroll(page), true, 'step 1 fits 390px');
      await shot(page, 'pace-parts-copy.png');
      await tapKeys(page, 'arily');
      assert.equal(await page.locator('#h5-learn-next').isDisabled(), false);
      await page.locator('#h5-learn-next').tap();
      // Step 2: the word hidden, the number of parts; Show parts is help; the grade is from this step only.
      await page.locator('#h5-learn-recall-input').waitFor();
      assert.match(await text(page, '.h5-learn-prompt'), /^Now from memory/);
      assert.equal(await page.locator('#h5-learn-parts').count(), 0, 'the word is hidden');
      assert.equal(await text(page, '#h5-learn-parts-count'), '5 parts');
      assert.equal(await text(page, '#h5-learn-meaning'), ZH_TEMPORARILY, 'the meaning stays');
      assert.equal(await page.locator('#h5-learn-hear').count(), 1, 'the sound stays');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'h5-learn-recall-input');
      assert.equal(mock.posts(/\/answer$/).length, 1, 'step 1 is not graded');
      await shot(page, 'pace-parts-recall.png');
      await page.locator('#h5-learn-show-parts').tap();
      await page.locator('#h5-learn-parts').waitFor();
      assert.equal(await page.locator('#h5-learn-show-parts').isDisabled(), true);
      await tapKeys(page, 'temporar');
      await page.locator('#h5-learn-check').tap();
      await page.locator('#h5-learn-feedback[data-correct="false"]').waitFor();
      assert.equal(await page.locator('#h5-learn-feedback').getAttribute('data-near'), null, 'three letters short is not almost');
      assert.equal(await text(page, '#h5-learn-feedback .h5-learn-result-title'), 'Not quite');
      assert.equal(await contained(page, '#h5-learn-grade-again'), true);
      await page.locator('#h5-learn-grade-again').tap();
      await waitFor(() => mock.posts(/\/answer$/).length === 2, 'the second answer');
      assert.deepEqual(lastAnswer(mock), { id: '2', mode: 'spell', grade: 'again', correct: false, answer: 'temporar', expected: 'temporarily', tag: 'spelling', hinted: true });

      // A right answer, then Round done.
      await page.locator('#h5-learn-spell-input').waitFor();
      await tapKeys(page, 'deploy');
      await page.locator('#h5-learn-feedback[data-correct="true"]').waitFor();
      await page.locator('#h5-learn-grade-good').tap();
      await page.locator('#h5-learn-done').waitFor();
      const summaries = mock.gets(/\/summary$/).length;
      assert.match(await text(page, '#h5-learn-done'), /^Round done 3 answered · 1 right · 1 almost/);
      assert.deepEqual(await page.locator('#h5-learn-done-bar > *').evaluateAll(els => els.map(el => el.dataset.kind)), ['right', 'almost', 'again']);
      assert.equal(await page.locator('#h5-learn-done-bar').getAttribute('aria-label'), '1 right, 1 almost, 1 again');
      assert.equal(await text(page, '#h5-learn-done-legend'), 'right · almost · again');
      assert.deepEqual(await texts(page, '.h5-learn-work-row'), ['extension You wrote extention Almost', 'temporarily Learned in parts Keeps slipping']);
      await page.locator('#h5-learn-break').waitFor();
      assert.equal(await text(page, '#h5-learn-break'), '24 min today. A short break now helps you remember more.');
      assert.ok(summaries >= 2, 'the summary is read when the round ends');
      assert.equal(await contained(page, '#h5-learn-finish'), true);
      assert.equal(await text(page, '#h5-learn-finish'), 'Back to Learn');
      assert.equal(await text(page, '#h5-learn-again'), 'Next round');
      assert.equal(await contained(page, '#h5-learn-again'), false, 'Next round is a text button');
      const heights = await page.locator('#h5-learn-finish, #h5-learn-again').evaluateAll(els => els.map(el => el.getBoundingClientRect().height));
      assert.ok(heights.every(h => h >= 44), `44px targets: ${heights}`);
      assert.equal(await noSidewaysScroll(page), true, 'Round done fits 390px');
      await shot(page, 'pace-round-done.png');

      // Next round: the queue is empty, today's new words are learned: Done for today.
      mock.summary = { ...mock.summary, new_today: 10, new_left: 0 };
      await page.locator('#h5-learn-again').tap();
      await page.locator('#h5-learn-session-empty[data-kind="done-today"]').waitFor();
      assert.equal(await text(page, '#h5-learn-session-empty'), "Done for today Every due word is reviewed and today's 10 new words are learned. Practise anyway 5 more new words");
      assert.equal(await page.locator('#h5-learn-session-free').evaluate(el => el.classList.contains('MuiButton-outlined')), true, 'Practise anyway is outlined');
      assert.equal(await page.locator('#h5-learn-more-words').evaluate(el => el.classList.contains('MuiButton-text')), true, '5 more new words is a text button');
      assert.equal(mock.gets(/\/queue$/).at(-1).search, '?mode=spell&limit=20', 'no extra without asking');
      await shot(page, 'pace-done-today.png');
      // 5 more new words: POST, then the queue again.
      const queues = mock.gets(/\/queue$/).length;
      await page.locator('#h5-learn-more-words').tap();
      await waitFor(() => mock.posts(/\/new-words$/).length === 1, 'the new words are asked for');
      assert.deepEqual(mock.posts(/\/new-words$/)[0].body, { count: 5 });
      await page.locator('#h5-learn-spell-input').waitFor();
      assert.equal(mock.gets(/\/queue$/).length, queues + 1, 'the queue is read again');
      assert.equal(mock.gets(/\/queue$/).at(-1).search, '?mode=spell&limit=20');
      assert.equal(await page.locator('.h5-learn-letter').count(), 'regression'.length, 'the new word');
      // Practise anyway: the same mode with extra=practice.
      await page.locator('#h5-learn-back').tap();
      await page.locator('#h5-learn-mode-spell').tap();
      await page.locator('#h5-learn-session-empty[data-kind="done-today"]').waitFor();
      await page.locator('#h5-learn-session-free').tap();
      await page.locator('#h5-learn-spell-input').waitFor();
      assert.equal(mock.gets(/\/queue$/).at(-1).search, '?mode=spell&limit=20&extra=practice');
      assert.equal(await page.locator('.h5-learn-letter').count(), 'deploy'.length);
      await page.locator('#h5-learn-back').tap();

      // NEW WORDS in Learn settings: saved at once.
      await page.locator('#h5-learn-settings').tap();
      await page.locator('#h5-learn-new-per-day').waitFor();
      assert.ok((await texts(page, '#h5-learn-mode h3.MuiTypography-overline')).includes('NEW WORDS'));
      assert.equal(await text(page, '#h5-learn-new-words-card'), 'New words a day Due reviews always come first 5 10 15 20 30');
      assert.equal(await page.locator('#h5-learn-new-per-day [data-value="10"]').getAttribute('aria-pressed'), 'true');
      await page.locator('#h5-learn-new-words-card').scrollIntoViewIfNeeded();
      await shot(page, 'pace-settings.png');
      await page.locator('#h5-learn-new-per-day [data-value="20"]').tap();
      await waitFor(() => mock.posts(/\/settings$/).some(item => item.body.new_per_day === 20), 'new_per_day is saved');
      assert.deepEqual(mock.posts(/\/settings$/).at(-1).body, { new_per_day: 20 });
      await page.locator('#h5-learn-new-per-day [data-value="20"][aria-pressed="true"]').waitFor();
      const toggles = await page.locator('#h5-learn-new-per-day button').evaluateAll(els => els.map(el => el.getBoundingClientRect().width));
      assert.ok(toggles.every(w => w >= 44), `44px wide choices: ${toggles}`);
      assert.equal(await noSidewaysScroll(page), true, 'settings fit 390px');
      await page.locator('#h5-learn-back').tap();

      // Practice (nothing due): spell and fill (the sentence queue) with extra=practice.
      mock.summary = { ...mock.summary, due: 0 };
      await page.locator('#h5-learn-settings').tap();
      await page.locator('#h5-learn-back').tap();
      await page.locator('#h5-learn-free').waitFor();
      const before = mock.gets(/\/queue$/).length;
      await page.locator('#h5-learn-free').tap();
      await waitFor(() => mock.gets(/\/queue$/).length >= before + 2, 'the practice queues');
      assert.deepEqual(mock.gets(/\/queue$/).slice(before).map(item => item.search).sort(), ['?mode=fill&limit=10&extra=practice', '?mode=spell&limit=10&extra=practice']);
      await context.close();
    }

    // ── 1440x900 (mouse): Almost with the keys ──
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 1440, height: 900 } });
      await page.locator('#h5-nav-learn').click();
      await page.locator('#h5-learn-new-words').waitFor();
      await page.locator('#h5-learn-mode-spell').click();
      await page.locator('#h5-learn-spell-input').waitFor();
      await page.locator('.h5-learn-letters').click();
      await page.keyboard.type('axtensoin');
      await page.locator('#h5-learn-feedback[data-correct="false"]').waitFor();
      assert.equal(await text(page, '#h5-learn-feedback .h5-learn-result-title'), 'Not quite', 'two letters off is not almost');
      assert.equal(await page.locator('#h5-learn-pattern').count(), 0, 'no pattern');
      // The focus goes to "Type it yourself"; Enter there takes the offered grade (contained).
      assert.equal(await page.evaluate(() => document.activeElement.id), 'h5-learn-practice-input');
      assert.match(await page.locator('#h5-learn-grade-again').getAttribute('class'), /MuiButton-contained/);
      await page.keyboard.press('Enter');
      await waitFor(() => mock.posts(/\/answer$/).length === 1, 'graded');
      assert.equal(lastAnswer(mock).grade, 'again');
      // The leech card on a computer: Enter in the copy field goes on once it matches; Hint types the next part.
      await page.locator('#h5-learn-copy-input').waitFor();
      await page.keyboard.type('temporarily');
      await page.keyboard.press('Enter');
      await page.locator('#h5-learn-recall-input').waitFor();
      await page.locator('#h5-learn-hint').click();
      assert.equal(await page.locator('#h5-learn-recall-input').inputValue(), 'tem');
      await page.locator('#h5-learn-hint').click();
      assert.equal(await page.locator('#h5-learn-recall-input').inputValue(), 'tempo');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'h5-learn-recall-input', 'Hint keeps the focus in the field');
      await page.keyboard.type('rarily');
      await page.locator('#h5-learn-feedback[data-correct="true"]').waitFor();
      assert.equal(await page.evaluate(() => document.activeElement.id), 'h5-learn-grade-hard', 'right with a hint: Hard');
      await page.keyboard.press('Enter');
      await waitFor(() => mock.posts(/\/answer$/).length === 2, 'graded');
      assert.deepEqual(lastAnswer(mock), { id: '2', mode: 'spell', grade: 'hard', correct: true, answer: 'temporarily' });
      // One letter off with the keys: Enter takes Hard.
      await page.locator('#h5-learn-spell-input').waitFor();
      await page.locator('.h5-learn-letters').click();
      await page.keyboard.type('dpeloy');
      await page.locator('#h5-learn-feedback[data-near="true"]').waitFor();
      assert.equal(await page.evaluate(() => document.activeElement.id), 'h5-learn-practice-input');
      assert.match(await page.locator('#h5-learn-grade-hard').getAttribute('class'), /MuiButton-contained/);
      assert.equal(await page.locator('#h5-learn-pattern').count(), 0, 'a swap has no pattern note');
      await shot(page, 'pace-almost-desktop.png');
      await page.keyboard.press('Enter');
      await waitFor(() => mock.posts(/\/answer$/).length === 3, 'graded');
      assert.equal(lastAnswer(mock).grade, 'hard');
      assert.equal(lastAnswer(mock).correct, false);
      await page.locator('#h5-learn-done').waitFor();
      assert.match(await text(page, '#h5-learn-done-counts'), /3 answered · 1 right · 1 almost/);
      await context.close();
    }

    // ── An older server: none of the new fields ──
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 1440, height: 900 }, legacy: true });
      mock.spell = [];
      await page.locator('#h5-nav-learn').click();
      await page.locator('#h5-learn-today').waitFor();
      assert.equal(await page.locator('#h5-learn-new-words').count(), 0, 'no new-words line');
      await page.locator('#h5-learn-mode-spell').click();
      await page.locator('#h5-learn-session-empty').waitFor();
      assert.equal(await page.locator('#h5-learn-session-empty').getAttribute('data-kind'), null);
      assert.match(await text(page, '#h5-learn-session-empty'), /^No words yet/, 'the old empty text');
      await page.locator('#h5-learn-settings').click();
      await page.locator('#h5-learn-settings-card').waitFor();
      assert.equal(await page.locator('#h5-learn-new-words-card').count(), 0, 'no NEW WORDS');
      await context.close();
    }
    assert.deepEqual(pageErrors, []);
    console.log('Learn pace browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
