// Learn: words picked from the person's translations (scripts/h5-shell/Learn.jsx), in real Chromium with every route mocked, /api/learn following the
// contract of "Words from your translations" in docs/design/learn-english.md (GET /level, POST /level/check, GET /cards?source=translation, the
// `context_zh` of a card, `pick_words` of the settings). No model is ever called. See "Spell the word" and "Learn settings" in
// docs/design/learn-english-page.md.
// - 390x844 (touch): Spell asks a word with `context_zh` inside its sentence (the "your translation" chip, the sentence with a primary gap about as
//   wide as the word, the Chinese of the sentence, a divider, "The word: <meaning>", Hear it, Show first letter, the letter slots and the page's
//   keyboard); the last letter checks by itself and the word fills the gap in the success colour, the word with its transcription and meaning under
//   the divider, "Correct" under the letters, the grades in the pinned actions; a word without a meaning looked up and given up (the error colour);
//   a starter word and a word not found in its sentence keep the meaning layout with "Used in". Learn settings: MY LEVEL (level, label, reason, the
//   caption), Check again (busy, the new level, a 409 shown like the other failed changes, "waiting"), the switch saved, Picked so far and View
//   (Your material on source=translation and kind=word, the chip that clears it, back to the settings), the privacy caption, no sideways scroll.
//   No level yet ("Not estimated yet", Check now); no translator (the notice, no button); a 503 from Check; an engine without the route (said in the
//   card, the rest of the settings work).
// - 1440x900 (mouse): the same sentence layout in the pane, a wrong answer typed with the keys, the grades under the result; Review uses it for a
//   picked word; MY LEVEL and View in the pane.
// H5_SHOT_DIR=<dir> saves learn-pick-spell.png, learn-pick-checked.png, learn-pick-settings.png (390 px, frames 1, 2 and 4 of the design) and
// learn-pick-desktop.png.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const AT = '2026-11-20T08:00:00.000Z';

const TASKS = [{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }];
const TERMINALS = { 1: [{ terminal_id: 'c1', title: 'Claude: login fix', agent: 'claude' }] };
// The Chinese of the cards is user content (escaped: Chinese is allowed only in the dictionaries and CJK fixtures).
const ZH_EXPIRE = '\u8fc7\u671f\uff1b\u5230\u671f';
const ZH_SENTENCE = '\u4f1a\u8bdd cookie \u4e09\u5341\u5206\u949f\u540e\u8fc7\u671f\uff0c\u6240\u4ee5\u8bf7\u91cd\u65b0\u767b\u5f55\u3002';
const ZH_TESTS = '\u5408\u5e76\u524d\u518d\u8dd1\u4e00\u904d\u6d4b\u8bd5\u3002';
const ZH_MERGE = '\u5408\u5e76';
const ZH_LATENCY = '\u5ef6\u8fdf';
const SENTENCE = 'The session cookie expires after thirty minutes, so please log in again.';
const card = (id, en, zh, source, extra = {}) => ({
  id, kind: 'word', en, zh, source, context: '', context_zh: '', phonetic: '', due_at: AT, interval_days: 0, ease: 2.5, reps: 0, lapses: 0, last_result: null, last_at: null, suspended: false, created_at: AT, ...extra,
});
const PICKED = card(31, 'expires', ZH_EXPIRE, 'translation', { context: SENTENCE, context_zh: ZH_SENTENCE, phonetic: '/\u026ak\u02c8spa\u026a\u0259rz/' });
const NO_MEANING = card(32, 'merge', '', 'translation', { context: 'Run the tests again before you merge.', context_zh: ZH_TESTS });
const STARTER = card(33, 'latency', ZH_LATENCY, 'starter', { context: 'Network latency is the time a packet takes', phonetic: '/\u02c8le\u026at\u0259nsi/' });
const NOT_IN_IT = card(34, 'expire', ZH_EXPIRE, 'translation', { context: 'It expired yesterday.', context_zh: ZH_SENTENCE });
const SENTENCE_CARD = { ...card(40, SENTENCE, ZH_SENTENCE, 'translation'), kind: 'sentence' };
// Taipei time (the browser context runs in Asia/Taipei): updated 11-21 09:00, the report of 11-16.
const LEVEL = { level: 'B1', label: 'intermediate', reason: 'Sure of everyday words; slips on spelling of longer technical words and on tense endings.', answers: 155, mistakes: 43, report_at: '2026-11-16T10:00:00+08:00', updated_at: '2026-11-21T09:00:00+08:00' };
const PICKING = { enabled: true, picked: 57, skipped: 12, sentences: 91, pending: 0, running: false };
const SUMMARY = { due: 4, new_today: 1, done_today: 3, goal: 20, streak: 2, words: 60, sentences: 91, mistakes: 0, collecting: true, starter: 'dev' };
const pageErrors = [];

function learnMock() {
  const mock = {
    settings: { collect: true, daily_goal: 20, starter: 'dev', analysis_auto: true, pick_words: true, report_lang: 'en' },
    level: { level: { ...LEVEL }, picking: { ...PICKING }, translator: true },
    check: () => ({ level: { ...LEVEL, level: 'B2', label: 'upper intermediate', updated_at: '2026-11-21T10:30:00+08:00' }, picking: { ...PICKING, pending: 3, running: true }, translator: true }),
    spell: [PICKED, NO_MEANING, STARTER, NOT_IN_IT],
    requests: [],
  };
  mock.handle = (p, method, url, body) => {
    mock.requests.push({ method, path: p, search: url.search, body });
    if (p === '/api/learn/summary') return SUMMARY;
    if (p === '/api/learn/settings' && method === 'GET') return mock.settings;
    if (p === '/api/learn/settings' && method === 'PUT') { mock.settings = { ...mock.settings, ...body }; return mock.settings; }
    if (p === '/api/learn/level' && method === 'GET') return mock.level === null ? [404, { error: 'Not found' }] : mock.level;
    if (p === '/api/learn/level/check' && method === 'POST') return mock.check();
    if (p === '/api/learn/meaning') return { zh: ZH_MERGE, phonetic: '/m\u025dd\u0292/' };
    if (p === '/api/learn/queue') {
      const mode = url.searchParams.get('mode');
      if (mode === 'spell') return { cards: mock.spell };
      if (mode === 'review') return { cards: [PICKED, SENTENCE_CARD] };
      return { cards: [SENTENCE_CARD] };
    }
    if (/^\/api\/learn\/cards\/\d+\/answer$/.test(p)) return { card: { ...PICKED, reps: 1 } };
    if (p === '/api/learn/cards') {
      const source = url.searchParams.get('source');
      const kind = url.searchParams.get('kind');
      const cards = [PICKED, NO_MEANING, NOT_IN_IT, STARTER, SENTENCE_CARD].filter(item => (!source || item.source === source) && (!kind || item.kind === kind));
      return { cards, total: cards.length };
    }
    return [404, { error: 'not mocked' }];
  };
  mock.posts = re => mock.requests.filter(item => item.method !== 'GET' && re.test(item.path));
  mock.gets = re => mock.requests.filter(item => item.method === 'GET' && re.test(item.path));
  return mock;
}

async function openPage(browser, { viewport, touch = false }) {
  const context = await browser.newContext({ viewport, timezoneId: 'Asia/Taipei', ...(touch ? { isMobile: true, hasTouch: true } : {}), ...(SHOTS ? { deviceScaleFactor: 3 } : {}) });
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
    window.spoken = [];
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak(u) { window.spoken.push(u.text); setTimeout(() => u.onstart && u.onstart(), 0); setTimeout(() => u.onend && u.onend(), 20); }, cancel() {}, getVoices: () => [{ lang: 'en-US', name: 'Test', localService: true }], addEventListener() {}, removeEventListener() {} } });
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
const color = (page, selector, prop = 'color') => page.locator(selector).first().evaluate((el, name) => getComputedStyle(el)[name], prop);
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, name) }); } };
const waitFor = async (check, message, timeout = 5000) => {
  const end = Date.now() + timeout;
  for (;;) { if (await check()) return; if (Date.now() > end) throw new Error(`timed out: ${message}`); await new Promise(resolve => setTimeout(resolve, 50)); }
};
const noSidewaysScroll = page => page.evaluate(() => [...document.querySelectorAll('#h5-learn-mode .h5-learn-scroll, #h5-learn-mode .MuiCard-root')].every(el => el.scrollWidth <= el.clientWidth + 1));
const lastAnswer = mock => { const list = mock.posts(/\/answer$/); return list.length ? { id: list.at(-1).path.match(/cards\/(\d+)/)[1], ...list.at(-1).body } : null; };
const lines = (page, selector) => page.locator(selector).first().evaluate(el => el.innerText.split('\n').map(line => line.trim()).filter(Boolean));
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
async function openSettings(page, touch) {
  const button = page.locator('#h5-learn-settings');
  if (touch) await button.tap(); else await button.click();
  await page.locator('#h5-learn-level-card').waitFor();
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    // \u2500\u2500 390x844 (touch): Spell inside the sentence, then Learn settings \u2500\u2500
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 390, height: 844 }, touch: true });
      await toTerminal(page);
      await page.locator('#h5-bnav-learn').tap();
      await page.locator('#h5-learn-mode-spell').tap();
      await page.locator('#h5-learn-sentence').waitFor();
      await page.waitForTimeout(400);
      // Frame 1: the label with its chip, the sentence with a gap, the Chinese, a divider, the word's meaning, Hear it and Show first letter.
      assert.equal(await text(page, '#h5-learn-mode .h5-learn-prompt > div:first-child'), 'Fill in the wordyour translation');
      assert.equal(await text(page, '#h5-learn-from-translation'), 'your translation');
      assert.equal(await text(page, '#h5-learn-sentence'), 'The session cookie after thirty minutes, so please log in again.');
      assert.equal(await page.locator('#h5-learn-sentence').getAttribute('translate'), 'no');
      assert.equal(await color(page, '#h5-learn-sentence', 'fontSize'), '20px', 'the sentence in the h6 size');
      const gap = await page.locator('#h5-learn-gap').boundingBox();
      assert.ok(gap.width >= 60 && gap.width <= 100, `the gap is about as wide as the word (${gap.width})`);
      assert.equal(await page.locator('#h5-learn-gap').getAttribute('aria-label'), 'blank');
      assert.equal(await color(page, '#h5-learn-gap', 'borderBottomColor'), await page.locator('#h5-learn-from-translation').evaluate(el => getComputedStyle(el).color), 'the gap and the chip in the primary colour');
      assert.equal(await text(page, '#h5-learn-sentence-zh'), ZH_SENTENCE);
      assert.equal(await page.locator('#h5-learn-sentence-zh').getAttribute('lang'), 'zh');
      assert.equal(await page.locator('#h5-learn-mode .h5-learn-prompt hr').count(), 1, 'a divider');
      assert.equal(await text(page, '#h5-learn-word-meaning'), `The word: ${ZH_EXPIRE}`);
      assert.equal(await page.locator('#h5-learn-hear').count(), 1);
      assert.equal(await page.locator('#h5-learn-first').count(), 1);
      assert.equal(await page.locator('#h5-learn-phonetic').count(), 0, 'the transcription waits for the answer (frame 1)');
      assert.equal(await page.locator('#h5-learn-mode .h5-learn-prompt', { hasText: 'Used in' }).count(), 0);
      assert.equal(await page.locator('.h5-learn-letter').count(), 7, 'the letter slots of the word as written in the sentence');
      await page.locator('#h5-learn-keys[data-kind="letters"]').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#h5-learn-spell-input').getAttribute('inputmode'), 'none', 'the page keyboard, as today');
      await tapKeys(page, 'expi');
      assert.equal(await page.locator('#h5-learn-spell-input').inputValue(), 'expi');
      assert.equal(await noSidewaysScroll(page), true, 'the sentence fits 390px');
      await shot(page, 'learn-pick-spell.png');
      // Frame 2: the last letter checks by itself; the word fills the gap in the success colour; the word, its transcription and meaning under the
      // divider; "Correct" under the letters; the helpers are gone; the grades are pinned at the bottom.
      await tapKeys(page, 'res');
      await page.locator('#h5-learn-sentence-word').waitFor();
      assert.equal(await text(page, '#h5-learn-sentence'), SENTENCE, 'the sentence reads whole');
      assert.equal(await text(page, '#h5-learn-sentence-word'), 'expires');
      assert.equal(await page.locator('#h5-learn-sentence-word').getAttribute('data-correct'), 'true');
      const success = await color(page, '#h5-learn-feedback p');
      assert.equal(await color(page, '#h5-learn-sentence-word'), success, 'the filled word in the success colour, like "Correct"');
      assert.notEqual(success, await color(page, '#h5-learn-sentence-zh'));
      assert.equal(await text(page, '#h5-learn-feedback'), 'Correct');
      assert.equal(await page.locator('#h5-learn-feedback').getAttribute('data-correct'), 'true');
      assert.equal(await text(page, '#h5-learn-feedback-phonetic'), '/\u026ak\u02c8spa\u026a\u0259rz/');
      assert.equal(await text(page, '#h5-learn-meaning'), ZH_EXPIRE);
      assert.equal(await text(page, '#h5-learn-mode .h5-learn-word'), 'expires');
      assert.equal(await page.locator('#h5-learn-hear').count(), 0, 'Hear it and Show first letter go after Check (frame 2)');
      assert.equal(await page.locator('#h5-learn-first').count(), 0);
      assert.equal(await page.locator('.h5-learn-footer .h5-learn-grades').count(), 1, 'the grades in the pinned actions');
      assert.equal(await page.locator('#h5-learn-grade-good').evaluate(el => el.classList.contains('MuiButton-contained')), true, 'right: Good is offered');
      await shot(page, 'learn-pick-checked.png');
      await page.locator('#h5-learn-grade-good').tap();
      await waitFor(() => lastAnswer(mock) && lastAnswer(mock).id === '31', 'the answer is posted');
      assert.deepEqual(lastAnswer(mock), { id: '31', mode: 'spell', grade: 'good', correct: true, answer: 'expires' });

      // A picked word without a meaning yet: looked up, then "The word: ..."; given up: the right word in the error colour.
      await page.locator('#h5-learn-word-meaning').waitFor();
      assert.equal(await text(page, '#h5-learn-word-meaning'), `The word: ${ZH_MERGE}`);
      assert.equal(mock.posts(/\/meaning$/).at(-1).body.word, 'merge');
      assert.equal(await text(page, '#h5-learn-sentence'), 'Run the tests again before you .', 'the full stop stays outside the gap');
      await page.locator('#h5-learn-dont-know').tap();
      await page.locator('#h5-learn-sentence-word').waitFor();
      assert.equal(await page.locator('#h5-learn-sentence-word').getAttribute('data-correct'), 'false');
      assert.equal(await text(page, '#h5-learn-sentence'), 'Run the tests again before you merge.');
      const error = await color(page, '#h5-learn-feedback p');
      assert.equal(await color(page, '#h5-learn-sentence-word'), error, 'the right word in the error colour');
      assert.notEqual(error, success);
      assert.equal(await text(page, '#h5-learn-feedback'), 'Not quite');
      await page.locator('#h5-learn-grade-again').tap();
      await waitFor(() => lastAnswer(mock).id === '32', 'the second answer');
      assert.equal(lastAnswer(mock).correct, false);
      assert.equal(lastAnswer(mock).expected, 'merge');

      // A starter word (its context is the list title, no Chinese of a sentence): the meaning layout of today (frame 3).
      await page.locator('#h5-learn-mode .h5-learn-prompt', { hasText: 'Meaning' }).waitFor();
      assert.equal(await page.locator('#h5-learn-sentence').count(), 0);
      assert.equal(await page.locator('#h5-learn-from-translation').count(), 0);
      assert.equal(await text(page, '#h5-learn-meaning'), ZH_LATENCY);
      assert.equal(await text(page, '#h5-learn-phonetic'), '/\u02c8le\u026at\u0259nsi/');
      assert.match(await text(page, '#h5-learn-mode .h5-learn-prompt'), /Used in "Network ___ is the time a packet takes"/);
      await page.locator('#h5-learn-dont-know').tap();
      await page.locator('#h5-learn-grade-again').tap();
      // A word whose form is not in the sentence: the meaning layout too, its context as the hint.
      await waitFor(async () => (await text(page, '#h5-learn-mode .h5-learn-subtitle')).startsWith('4 / 4'), 'the fourth card');
      assert.equal(await page.locator('#h5-learn-sentence').count(), 0);
      assert.match(await text(page, '#h5-learn-mode .h5-learn-prompt'), /^Meaning/);
      assert.match(await text(page, '#h5-learn-mode .h5-learn-prompt'), /Used in "It ___ yesterday\."/, 'its context as the hint (masked as today)');

      // Learn settings (frame 4): MY LEVEL, WORDS FROM MY TRANSLATIONS, the privacy caption.
      await page.locator('#h5-learn-back').tap();
      await page.locator('#h5-learn-mode').waitFor({ state: 'detached' });
      await openSettings(page, true);
      await page.locator('#h5-learn-level').waitFor();
      await page.waitForTimeout(400);
      const overlines = await page.locator('#h5-learn-mode h3.MuiTypography-overline').evaluateAll(els => els.map(el => el.textContent));
      assert.deepEqual(overlines.slice(0, 3), ['My level', 'Words from my translations', 'Practice']);
      assert.equal(await page.locator('#h5-learn-mode h3.MuiTypography-overline').first().evaluate(el => getComputedStyle(el).textTransform), 'uppercase');
      assert.equal(await text(page, '#h5-learn-level-card > p:first-child'), 'Your level (estimated)');
      assert.equal(await text(page, '#h5-learn-level'), 'B1');
      assert.ok(await page.locator('#h5-learn-level').evaluate(el => el.classList.contains('MuiTypography-h4')), 'the level in h4');
      assert.equal(await text(page, '#h5-learn-level-label'), 'intermediate');
      assert.equal(await text(page, '#h5-learn-level-reason'), LEVEL.reason);
      assert.equal(await text(page, '#h5-learn-level-note'), 'From 155 answers, 43 mistakes and the report of 11-16 \u00b7 updated 11-21 09:00');
      assert.equal(await text(page, '#h5-learn-level-check'), 'Check again');
      assert.equal(await page.locator('#h5-learn-pick-words').isChecked(), true);
      assert.match(await text(page, '#h5-learn-pick-card'), /Pick words from my translationsLess common words above your level become Spell cards, asked inside their sentence/);
      assert.equal(await text(page, '#h5-learn-picked'), '57 words from 91 sentences \u00b7 12 skipped (you know them)');
      assert.equal(await text(page, '#h5-learn-pick-privacy'), 'Your sentences and a summary of your answers go to the translation model you set up (the same one that translated them). Nothing else is sent.');
      assert.equal(await noSidewaysScroll(page), true, 'the settings fit 390px');
      const levelCard = await page.locator('#h5-learn-level-card').boundingBox();
      assert.ok(levelCard.x >= 16 && levelCard.x + levelCard.width <= 390 - 16 + 1, 'the card keeps the 16px gutter');
      await shot(page, 'learn-pick-settings.png');

      // Check again: busy while it runs, then the new level and "waiting" while sentences wait.
      let release;
      const later = mock.check;
      mock.check = () => new Promise(resolve => { release = () => resolve(later()); });
      await page.locator('#h5-learn-level-check').tap();
      await page.locator('#h5-learn-level-busy').waitFor();
      assert.equal(await page.locator('#h5-learn-level-check').isDisabled(), true, 'one check at a time');
      assert.equal(await text(page, '#h5-learn-level-check'), 'Checking\u2026');
      assert.equal(await page.locator('#h5-learn-level-card').getAttribute('aria-busy'), 'true');
      release();
      await page.locator('#h5-learn-level', { hasText: 'B2' }).waitFor();
      assert.equal(await page.locator('#h5-learn-level-busy').count(), 0);
      assert.equal(await text(page, '#h5-learn-level-label'), 'upper intermediate');
      assert.equal(await text(page, '#h5-learn-level-note'), 'From 155 answers, 43 mistakes and the report of 11-16 \u00b7 updated 11-21 10:30');
      assert.equal(await text(page, '#h5-learn-picked'), '57 words from 91 sentences \u00b7 12 skipped (you know them) \u00b7 3 waiting');
      assert.equal(mock.posts(/\/level\/check$/).length, 1);
      // A run going on elsewhere (409): shown like the other failed changes; the button comes back.
      mock.check = () => [409, { error: 'The level is being checked already. Try again in a minute.' }];
      await page.locator('#h5-learn-level-check').tap();
      await page.locator('#h5-learn-settings-error').waitFor();
      assert.equal(await text(page, '#h5-learn-settings-error'), 'The level is being checked already. Try again in a minute.');
      assert.equal(await page.locator('#h5-learn-level-check').isDisabled(), false);
      assert.equal(await text(page, '#h5-learn-level'), 'B2', 'the level shown stays');
      // The switch is saved in the learning settings; the error goes away with a change that works.
      await page.locator('#h5-learn-pick-words').tap();
      await waitFor(() => mock.posts(/\/settings$/).some(item => item.body.pick_words === false), 'the switch is saved');
      assert.deepEqual(mock.posts(/\/settings$/).at(-1).body, { pick_words: false });
      await page.locator('#h5-learn-settings-error').waitFor({ state: 'detached' });
      assert.equal(await page.locator('#h5-learn-pick-words').isChecked(), false);
      // View: Your material on the picked words; the chip clears the filter; back returns to the settings.
      await page.locator('#h5-learn-picked-view').tap();
      await page.locator('#h5-learn-source-filter').waitFor();
      assert.equal(await text(page, '#h5-learn-view-title'), 'Your material');
      await waitFor(() => mock.gets(/^\/api\/learn\/cards$/).length > 0, 'the list is asked for');
      const asked = new URLSearchParams(mock.gets(/^\/api\/learn\/cards$/).at(-1).search);
      assert.equal(asked.get('source'), 'translation');
      assert.equal(asked.get('kind'), 'word');
      await waitFor(async () => (await page.locator('.h5-learn-card-row').count()) === 3, 'the three picked words');
      assert.equal(await text(page, '#h5-learn-source-filter'), 'From your translations');
      await page.locator('#h5-learn-source-filter .MuiChip-deleteIcon').tap();
      await page.locator('#h5-learn-source-filter').waitFor({ state: 'detached' });
      await waitFor(() => !new URLSearchParams(mock.gets(/^\/api\/learn\/cards$/).at(-1).search).has('source'), 'the filter is cleared');
      await page.locator('#h5-learn-back').tap();
      await page.locator('#h5-learn-level-card').waitFor();
      assert.equal(await text(page, '#h5-learn-view-title'), 'Learn settings', 'back to the settings it came from');
      await context.close();
    }

    // \u2500\u2500 No level yet: "Not estimated yet" and Check now \u2500\u2500
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 390, height: 844 }, touch: true });
      mock.level = { level: null, picking: { ...PICKING, picked: 0, skipped: 0, pending: 91 }, translator: true };
      mock.check = () => ({ level: { ...LEVEL, level: 'A2', label: 'elementary', report_at: null }, picking: { ...PICKING, picked: 0, skipped: 0, pending: 91, running: true }, translator: true });
      await toTerminal(page);
      await page.locator('#h5-bnav-learn').tap();
      await openSettings(page, true);
      await page.locator('#h5-learn-level-none').waitFor();
      assert.equal(await text(page, '#h5-learn-level-none'), 'Not estimated yet');
      assert.equal(await text(page, '#h5-learn-level-check'), 'Check now');
      assert.equal(await text(page, '#h5-learn-picked'), '0 words from 91 sentences \u00b7 0 skipped (you know them) \u00b7 91 waiting');
      await page.locator('#h5-learn-level-check').tap();
      await page.locator('#h5-learn-level', { hasText: 'A2' }).waitFor();
      assert.equal(await text(page, '#h5-learn-level-note'), 'From 155 answers and 43 mistakes \u00b7 updated 11-21 09:00', 'without a report');
      assert.equal(await text(page, '#h5-learn-level-check'), 'Check again');
      await context.close();
    }

    // \u2500\u2500 No translator: the notice instead of the button; a 503 from Check shows it too \u2500\u2500
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 390, height: 844 }, touch: true });
      mock.level = { level: { ...LEVEL }, picking: { ...PICKING }, translator: false };
      await toTerminal(page);
      await page.locator('#h5-bnav-learn').tap();
      await openSettings(page, true);
      await page.locator('#h5-learn-level-no-translator').waitFor();
      assert.equal(await page.locator('#h5-learn-level-check').count(), 0);
      assert.equal(await text(page, '#h5-learn-level'), 'B1', 'a level synced from another engine is still shown');
      assert.match(await text(page, '#h5-learn-level-no-translator'), /need a translator/);
      await page.locator('#h5-learn-back').tap();
      await page.locator('#h5-learn-mode').waitFor({ state: 'detached' });
      mock.level = { level: null, picking: { ...PICKING }, translator: true };
      mock.check = () => [503, { error: 'No translator is configured' }];
      await openSettings(page, true);
      await page.locator('#h5-learn-level-check').tap();
      await page.locator('#h5-learn-level-no-translator').waitFor();
      assert.equal(await text(page, '#h5-learn-settings-error'), 'No translator is configured');
      assert.equal(await page.locator('#h5-learn-level-check').count(), 0);
      await context.close();
    }

    // \u2500\u2500 An engine without the level route (an older version): said in the card, the other settings work \u2500\u2500
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 390, height: 844 }, touch: true });
      mock.level = null;
      await toTerminal(page);
      await page.locator('#h5-bnav-learn').tap();
      await openSettings(page, true);
      await page.locator('#h5-learn-level-error').waitFor();
      assert.equal(await text(page, '#h5-learn-level-error'), 'Not found');
      assert.equal(await page.locator('#h5-learn-level-check').count(), 0);
      assert.equal(await text(page, '#h5-learn-picked'), '\u2014');
      await page.locator('#h5-learn-collect').tap();
      await waitFor(() => mock.posts(/\/settings$/).some(item => item.body.collect === false), 'another switch still saves');
      await context.close();
    }

    // \u2500\u2500 1440x900 (mouse): the sentence layout in the pane, typed with the keys; Review; MY LEVEL and View \u2500\u2500
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 1440, height: 900 } });
      await page.locator('#h5-nav-learn').click();
      await page.locator('#h5-learn-mode-spell').click();
      await page.locator('#h5-learn-sentence').waitFor();
      assert.equal(await page.locator('#h5-learn-keys').count(), 0, 'no page keyboard on a computer');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'h5-learn-spell-input');
      await page.keyboard.type('expirez');
      await page.locator('#h5-learn-sentence-word').waitFor();
      assert.equal(await page.locator('#h5-learn-sentence-word').getAttribute('data-correct'), 'false');
      assert.equal(await text(page, '#h5-learn-sentence-word'), 'expires', 'the right word in the sentence');
      assert.deepEqual(await lines(page, '#h5-learn-feedback'), ['Not quite', 'You wrote: expirez', '6 of 7 letters right']);
      const feedback = await page.locator('#h5-learn-feedback').boundingBox();
      const grades = await page.locator('#h5-learn-mode-pane .h5-learn-grades, .h5-learn-pane .h5-learn-grades').first().boundingBox();
      assert.ok(grades.y >= feedback.y + feedback.height, 'the grades under the result');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'h5-learn-grade-again');
      await shot(page, 'learn-pick-desktop.png');
      await page.keyboard.press('Enter');
      await waitFor(() => lastAnswer(mock) && lastAnswer(mock).id === '31', 'graded with Enter');
      assert.equal(lastAnswer(mock).grade, 'again');
      assert.equal(lastAnswer(mock).tag !== undefined, true, 'a wrong answer keeps its tag');
      // Review asks a picked word the same way.
      await page.locator('#h5-learn-start').click();
      await page.locator('#h5-learn-sentence').waitFor();
      assert.equal(await text(page, '#h5-learn-view-title'), 'Daily review');
      // MY LEVEL and View in the pane.
      await openSettings(page, false);
      await page.locator('#h5-learn-level').waitFor();
      assert.equal(await text(page, '#h5-learn-picked'), '57 words from 91 sentences \u00b7 12 skipped (you know them)');
      await page.locator('#h5-learn-picked-view').click();
      await page.locator('#h5-learn-source-filter').waitFor();
      await page.locator('#h5-learn-back').click();
      await page.locator('#h5-learn-level-card').waitFor();
      await context.close();
    }

    assert.deepEqual(pageErrors, []);
    console.log('Learn pick browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
