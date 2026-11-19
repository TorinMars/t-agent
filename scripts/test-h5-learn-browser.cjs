// The Learn page (scripts/h5-shell/Learn.jsx, the "Learn" destination), in real Chromium with every route mocked, /api/learn following the contract
// of docs/design/learn-english.md. See "The Learn page" in docs/design/learn-english-page.md.
// - 1440x900 (mouse): the rail's Learn destination and the page right of it; the home numbers (due, estimate, streak, goal, mode counts); Build the
//   sentence (tiles, typing, the diff and the third-person hint, the grades posted with the keys 2 and Enter, Hint, Skip, the end of a session);
//   Spell the word (wrong letters, "I don't know"-free flow with the first letter, no translator configured and its link to Settings); Dictation (speech
//   at the normal and the slow rate, an article hint); Fill the gap; Say it; Mistakes; Your material (search, kind, edit meaning, suspend); Learn
//   settings (collect with window.LearnCollect, daily goal, starter list); Escape; Sessions closing the page; the empty states (no cards, nothing due);
//   a browser without speech output or voice input (no Dictation, no Say it, no Hear it).
// - 390x844 (touch): the bottom navigation's Learn; the home and the modes as pages above the bar; the system keyboard not covering the answer field or
//   Check; the grades in the pinned actions; the back button closing the mode, then the page.
// H5_SHOT_DIR=<dir> saves the screenshots (computer: home, Build after Check, Spell; phone: Spell, Build, Dictation).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const AT = new Date(Date.now() - 86400000).toISOString();

const TASKS = [{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }];
const TERMINALS = { 1: [{ terminal_id: 'c1', title: 'Claude: login fix', agent: 'claude' }] };
// The Chinese of the study cards is user content (written with \u escapes: Chinese is allowed only in the dictionaries and CJK fixtures).
const ZH_EXPIRE = '\u8fc7\u671f\uff1b\u5230\u671f';
const ZH_LOOP = '\u8bf7\u4fee\u590d\u4f1a\u8bdd cookie \u8fc7\u671f\u540e\u7684\u767b\u5f55\u91cd\u5b9a\u5411\u5faa\u73af\u3002';
const ZH_TESTS = '\u5408\u5e76\u524d\u518d\u8dd1\u4e00\u904d\u6d4b\u8bd5\u3002';
const ZH_DEPLOY = '\u4eca\u665a\u90e8\u7f72\u9884\u53d1\u73af\u5883\u3002';
const card = (id, kind, en, zh, source, extra = {}) => ({
  id, kind, en, zh, source, context: '', due_at: AT, interval_days: 0, ease: 2.5, reps: 0, lapses: 0, last_result: null, last_at: null, suspended: false, created_at: AT, ...extra,
});
const WORDS = [
  card(1, 'word', 'expire', ZH_EXPIRE, 'lookup', { context: 'after the session cookie expires' }),
  card(2, 'word', 'deploy', '', 'starter'),
];
const SENTENCES = [
  card(10, 'sentence', 'Please fix the login redirect loop after the session cookie expires.', ZH_LOOP, 'translation', { context: 'SELF-TAGENT', created_at: '2026-11-19T08:00:00.000Z' }),
  card(11, 'sentence', 'Run the tests again before you merge.', ZH_TESTS, 'translation'),
  card(12, 'sentence', 'Deploy the staging server tonight.', ZH_DEPLOY, 'manual'),
];
const SUMMARY = { due: 18, new_today: 2, done_today: 7, goal: 20, streak: 5, words: 42, sentences: 26, mistakes: 3, collecting: true, starter: 'dev' };
const pageErrors = [];

function learnMock() {
  const mock = { summary: { ...SUMMARY }, settings: { collect: true, daily_goal: 20, starter: 'dev' }, translator: false, requests: [], material: [...WORDS, ...SENTENCES].map(item => ({ ...item })) };
  mock.handle = (p, method, url, body) => {
    mock.requests.push({ method, path: p, search: url.search, body });
    if (p === '/api/learn/summary') return mock.summary;
    if (p === '/api/learn/settings' && method === 'GET') return mock.settings;
    if (p === '/api/learn/settings' && method === 'PUT') { mock.settings = { ...mock.settings, ...body }; return mock.settings; }
    if (p === '/api/learn/starter') return { added: 120 };
    if (p === '/api/learn/meaning') return mock.translator ? { zh: 'zh' } : [503, { error: 'No translator is configured' }];
    if (p === '/api/learn/queue') {
      const mode = url.searchParams.get('mode');
      if (mode === 'spell') return { cards: WORDS };
      if (mode === 'review') return { cards: [WORDS[0], SENTENCES[0]] };
      if (mode === 'mistakes') return { cards: [WORDS[0], SENTENCES[1], SENTENCES[2]] };
      return { cards: SENTENCES };
    }
    const answer = p.match(/^\/api\/learn\/cards\/(\d+)\/answer$/);
    if (answer) return { card: { ...mock.material.find(item => String(item.id) === answer[1]), reps: 1 } };
    const one = p.match(/^\/api\/learn\/cards\/(\d+)$/);
    if (one && method === 'PATCH') {
      const item = mock.material.find(entry => String(entry.id) === one[1]);
      Object.assign(item, body);
      return { card: item };
    }
    if (p === '/api/learn/cards') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const kind = url.searchParams.get('kind');
      const cards = mock.material.filter(item => (!kind || item.kind === kind) && (!q || item.en.toLowerCase().includes(q)));
      return { cards, total: cards.length };
    }
    return [404, { error: 'not mocked' }];
  };
  mock.posts = re => mock.requests.filter(item => item.method !== 'GET' && re.test(item.path));
  return mock;
}

async function openPage(browser, { viewport, touch = false, speech = true }) {
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...(SHOTS ? { deviceScaleFactor: 2 } : {}) });
  const page = await context.newPage();
  const mock = learnMock();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(withSpeech => {
    localStorage.setItem('h5-columns', JSON.stringify({ on: false }));
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : ''); }
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1; window.WebSocket.CONNECTING = 0;
    window.EventSource = class extends EventTarget {
      constructor(url) { super(); this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; const event = new Event('open'); this.onopen?.(event); this.dispatchEvent(event); }, 50); }
      close() { this.readyState = 2; }
    };
    // Speech output that records what it reads, or none at all; no voice input in the second case either.
    window.spoken = [];
    if (withSpeech) {
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak(u) { window.spoken.push({ text: u.text, rate: u.rate, lang: u.lang }); }, cancel() {}, getVoices: () => [{ lang: 'en-US', name: 'Test', localService: true }], addEventListener() {}, removeEventListener() {} } });
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    } else {
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: undefined });
      Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
      Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: undefined });
      localStorage.setItem('voice-enabled', '0');
    }
    window.collectCalls = [];
    // The page's own public/js/learn-collect.js (h5.html) defines window.LearnCollect when it runs; until then a stand-in. Either way the calls of
    // set() are counted: the real object's set is wrapped once it appears (the property's setter), the stand-in records them directly.
    let current = { set(on) { window.collectCalls.push(on); } };
    Object.defineProperty(window, 'LearnCollect', {
      configurable: true,
      get: () => current,
      set: real => {
        const original = real && typeof real.set === 'function' ? real.set.bind(real) : null;
        current = { ...real, set(on) { window.collectCalls.push(on); return original ? original(on) : undefined; } };
      },
    });
  }, speech);
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
      const out = mock.handle(p, method, url, body);
      return Array.isArray(out) ? json(out[1], out[0]) : json(out);
    }
    if (p === '/api/system/update-status' || p === '/api/system/check-update') return json({ status: 'idle', local_version: '1.0.0', install_type: 'git', log: [] });
    if (p === '/api/remote-servers') return json([]);
    if (p === '/api/tasks' && method === 'GET') return json(TASKS);
    if (p === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (p === '/api/tasks/terminal-activity') return json({});
    if (p === '/api/tasks/terminal-subagents') return json({});
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

const rect = (page, selector) => page.locator(selector).first().evaluate(el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }; });
const text = (page, selector) => page.locator(selector).first().evaluate(el => el.textContent.replace(/\s+/g, ' ').trim());
const ui = (page, key) => page.evaluate(name => window.H5UI.get()[name], key);
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(350); await page.screenshot({ path: path.join(SHOTS, name) }); } };
const waitFor = async (check, message, timeout = 5000) => {
  const end = Date.now() + timeout;
  for (;;) { if (await check()) return; if (Date.now() > end) throw new Error(`timed out: ${message}`); await new Promise(resolve => setTimeout(resolve, 50)); }
};
const lastAnswer = mock => { const list = mock.posts(/\/answer$/); return list.length ? { id: list.at(-1).path.match(/cards\/(\d+)/)[1], ...list.at(-1).body } : null; };
// Places the tiles for these words, in order (a word can be on two tiles: the first free one).
async function placeTiles(page, words) {
  for (const word of words) {
    const tile = page.locator('.h5-learn-pool .h5-learn-tile:not([disabled])', { hasText: new RegExp(`^${word}$`) }).first();
    await tile.click();
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    // ── 1440x900 (mouse) ──
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 1440, height: 900 } });
      await page.locator('#h5-columns-nav').waitFor({ state: 'visible' });
      const learn = page.locator('#h5-nav-learn');
      assert.equal(await learn.getAttribute('aria-label'), 'Learn');
      assert.equal(await text(page, '#h5-nav-learn .h5-nav-label'), 'Learn');
      assert.equal((await rect(page, '#h5-nav-learn')).h, 56);
      await learn.click();
      await page.locator('#h5-learn').waitFor({ state: 'visible' });
      assert.equal(await learn.getAttribute('aria-current'), 'page', 'Learn is the current destination');
      assert.equal(await page.locator('#h5-nav-sessions').getAttribute('aria-current'), null);
      assert.deepEqual(await rect(page, '#h5-learn'), { x: 72, y: 0, w: 1440 - 72, h: 900, bottom: 900 }, 'a page right of the rail');
      // The home numbers.
      await page.locator('#h5-learn-due').waitFor();
      assert.equal(await text(page, '#h5-learn-due'), '18');
      assert.equal(await text(page, '#h5-learn-estimate'), 'cards due today · about 6 min');
      assert.equal(await text(page, '#h5-learn-streak'), '5-day streak · 7 of 20 done');
      assert.equal(await page.locator('#h5-learn-goal').getAttribute('aria-valuenow'), '35', '7 of 20');
      assert.deepEqual(await page.locator('.h5-learn-mode .h5-learn-count').allTextContents(), ['42 words', '26 sentences', '26 sentences', '26 sentences', '26 sentences', '3 cards']);
      assert.deepEqual(await page.locator('.h5-learn-mode .MuiTypography-subtitle1').allTextContents(), ['Spell the word', 'Build the sentence', 'Dictation', 'Say it', 'Fill the gap', 'Mistakes']);
      assert.match(await text(page, '#h5-learn-material'), /From your translations · 26 sentences, 42 words/);
      await page.locator('#h5-learn-how-card').waitFor({ state: 'visible' });
      await shot(page, 'learn-desktop-home.png');

      // ── Build the sentence: tiles and typing, the diff, the third-person hint, the grade with the key 2 ──
      await page.locator('#h5-learn-mode-build').click();
      await page.locator('#h5-learn-chinese').waitFor();
      assert.equal(await text(page, '#h5-learn-chinese'), ZH_LOOP);
      assert.equal(await text(page, '#h5-learn-view-title'), 'Build the sentence');
      assert.equal(await text(page, '.h5-learn-subtitle'), '1 / 3');
      assert.equal(await text(page, '.h5-learn-origin'), 'From your message on 11-19 · SELF-TAGENT');
      assert.equal(await page.locator('#h5-learn-mode-build').getAttribute('aria-current'), 'true');
      const tiles = await page.locator('.h5-learn-pool .h5-learn-tile').allTextContents();
      assert.equal(tiles.length, 14, '11 words and 3 distractors from the other sentences');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'h5-learn-build-input', 'the answer field has the focus on a computer');
      await placeTiles(page, ['Please', 'fix', 'the', 'login', 'redirect', 'loop', 'after', 'the', 'session', 'cookie']);
      assert.equal(await page.locator('.h5-learn-answer .h5-learn-placed').count(), 10);
      assert.equal(await page.locator('.h5-learn-pool .h5-learn-tile[disabled]').count(), 10, 'placed tiles leave a dashed place');
      await page.locator('.h5-learn-answer .h5-learn-placed').last().click();
      assert.equal(await page.locator('.h5-learn-answer .h5-learn-placed').count(), 9, 'a tap takes a tile back');
      await placeTiles(page, ['cookie']);
      await page.locator('#h5-learn-build-input').fill('expire');
      await page.locator('#h5-learn-check').click();
      await page.locator('#h5-learn-feedback').waitFor();
      assert.equal(await page.locator('#h5-learn-feedback').getAttribute('data-correct'), 'false');
      assert.equal(await text(page, '.h5-learn-del'), 'expire');
      assert.equal(await text(page, '.h5-learn-ins'), 'expires');
      assert.equal(await text(page, '.h5-learn-diff'), 'Please fix the login redirect loop after the session cookie expire expires.');
      assert.equal(await text(page, '.h5-learn-summary'), 'Word by word: 10 of 11 right · "expires": third person -s');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'h5-learn-grade-again', 'the offered grade (wrong: Again) has the focus');
      assert.equal(await page.locator('#h5-learn-grade-again').evaluate(el => el.classList.contains('MuiButton-contained')), true);
      await shot(page, 'learn-desktop-build-check.png');
      await page.keyboard.press('2');
      await waitFor(() => Boolean(lastAnswer(mock)), 'the answer is posted');
      assert.deepEqual(lastAnswer(mock), { id: '10', mode: 'build', grade: 'hard', correct: false, answer: 'Please fix the login redirect loop after the session cookie expire' });
      // Card 2: typed only; Enter checks, Enter again takes the offered grade (right: Good).
      await waitFor(async () => (await text(page, '.h5-learn-subtitle')) === '2 / 3', 'the next card');
      await page.locator('#h5-learn-build-input').focus();
      await page.keyboard.type('run the tests  again before you merge');
      await page.keyboard.press('Enter');
      await page.locator('#h5-learn-feedback[data-correct="true"]').waitFor();
      await page.keyboard.press('Enter');
      await waitFor(() => mock.posts(/\/answer$/).length === 2, 'the second answer');
      assert.deepEqual(lastAnswer(mock), { id: '11', mode: 'build', grade: 'good', correct: true, answer: 'run the tests  again before you merge' });
      // Card 3: Hint places the first word; Skip posts nothing; the session ends.
      await waitFor(async () => (await text(page, '.h5-learn-subtitle')) === '3 / 3', 'the third card');
      await page.locator('#h5-learn-hint').click();
      assert.deepEqual(await page.locator('.h5-learn-answer .h5-learn-placed').allTextContents(), ['Deploy']);
      await page.locator('#h5-learn-skip').click();
      await page.locator('#h5-learn-done').waitFor();
      assert.equal(mock.posts(/\/answer$/).length, 2, 'Skip posts no answer');
      assert.match(await text(page, '#h5-learn-done'), /2 answered · 1 right/);
      await page.locator('#h5-learn-finish').click();
      await page.locator('#h5-learn-how-card').waitFor();

      // ── Spell the word: wrong letters with the key 1; no translator; the first letter and Hard ──
      await page.locator('#h5-learn-mode-spell').click();
      await page.locator('#h5-learn-meaning').waitFor();
      assert.equal(await text(page, '#h5-learn-meaning'), ZH_EXPIRE);
      assert.match(await text(page, '.h5-learn-prompt'), /Used in "after the session cookie ___"/);
      assert.equal(await page.locator('.h5-learn-letter').count(), 6, 'a box per letter');
      await page.locator('#h5-learn-hear').click();
      assert.deepEqual(await page.evaluate(() => window.spoken.at(-1)), { text: 'expire', rate: 1, lang: 'en-US' });
      await page.locator('.h5-learn-letters').click();
      await page.keyboard.type('expi');
      await shot(page, 'learn-desktop-spell.png');
      await page.keyboard.type('er');
      await page.keyboard.press('Enter');
      await page.locator('#h5-learn-feedback[data-correct="false"]').waitFor();
      assert.match(await text(page, '#h5-learn-feedback'), /expire.*You wrote: expier.*4 of 6 letters right/);
      await page.keyboard.press('1');
      await waitFor(() => mock.posts(/\/answer$/).length === 3, 'the spell answer');
      assert.deepEqual(lastAnswer(mock), { id: '1', mode: 'spell', grade: 'again', correct: false, answer: 'expier' });
      await page.locator('#h5-learn-no-translator').waitFor();
      assert.match(await text(page, '#h5-learn-no-translator'), /Word meanings need a translator/);
      assert.deepEqual(mock.posts(/\/meaning$/).at(-1).body, { word: 'deploy' });
      await page.locator('#h5-learn-first').click();
      assert.equal(await page.locator('#h5-learn-spell-input').inputValue(), 'd');
      await page.keyboard.type('eploy');
      await page.keyboard.press('Enter');
      await page.locator('#h5-learn-feedback[data-correct="true"]').waitFor();
      assert.equal(await page.locator('#h5-learn-grade-hard').evaluate(el => el.classList.contains('MuiButton-contained')), true, 'right with help: Hard');
      await page.keyboard.press('Enter');
      await waitFor(() => mock.posts(/\/answer$/).length === 4, 'the second spell answer');
      assert.deepEqual(lastAnswer(mock), { id: '2', mode: 'spell', grade: 'hard', correct: true, answer: 'deploy' });
      await page.locator('#h5-learn-done').waitFor();
      // The link to the translator closes Learn and opens Settings on Voice and translation.
      await page.locator('#h5-learn-again').click();
      await page.locator('#h5-learn-meaning').waitFor();
      await page.locator('#h5-learn-skip').count();
      await page.keyboard.type('expire');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.locator('#h5-learn-open-translator').click();
      await waitFor(async () => (await ui(page, 'settingsOpen')) && !(await ui(page, 'learnOpen')), 'Settings instead of Learn');
      await page.locator('#h5-close-settings').click();
      await waitFor(async () => !(await ui(page, 'settingsOpen')), 'Settings closed');

      // ── Dictation: read at the normal and the slow rate; a missing article ──
      await learn.click();
      await page.locator('#h5-learn-mode-dictation').click();
      await page.locator('#h5-learn-dictation-input').waitFor();
      await waitFor(() => page.evaluate(() => window.spoken.some(item => item.text === 'Please fix the login redirect loop after the session cookie expires.' && item.rate === 1)), 'read on start');
      await page.locator('#h5-learn-slow').click();
      assert.equal(await page.evaluate(() => window.spoken.at(-1).rate), 0.65);
      await page.locator('#h5-learn-dictation-input').fill('Please fix login redirect loop after the session cookie expires');
      await page.locator('#h5-learn-check').click();
      await page.locator('#h5-learn-feedback').waitFor();
      assert.match(await text(page, '.h5-learn-summary'), /10 of 11 right · "the": article missing/);
      assert.equal(await text(page, '#h5-learn-chinese'), ZH_LOOP, 'the Chinese after Check');
      await page.locator('#h5-learn-grade-good').click();
      await waitFor(() => mock.posts(/\/answer$/).length === 6, 'the dictation answer');
      assert.deepEqual(lastAnswer(mock), { id: '10', mode: 'dictation', grade: 'good', correct: false, answer: 'Please fix login redirect loop after the session cookie expires' });
      // Escape closes the mode (the page stays), then the page.
      await page.keyboard.press('Escape');
      await page.locator('#h5-learn-how-card').waitFor();
      assert.equal(await ui(page, 'learnOpen'), true);

      // ── Fill the gap ──
      await page.locator('#h5-learn-mode-fill').click();
      await page.locator('#h5-learn-gap-input').waitFor();
      const gap = await page.locator('.h5-learn-gap').evaluate(el => { const input = el.querySelector('input'); let before = ''; let after = ''; let seen = false; for (const node of el.childNodes) { if (node.contains(input)) { seen = true; continue; } if (seen) after += node.textContent; else before += node.textContent; } return { before, after }; });
      const sentence = SENTENCES[0].en;
      const word = sentence.slice(gap.before.length, sentence.length - gap.after.length);
      assert.ok(/^[a-z]+$/i.test(word), `the gap is one word: ${word}`);
      await page.locator('#h5-learn-gap-input').fill(word.toUpperCase());
      await page.keyboard.press('Enter');
      await page.locator('#h5-learn-feedback[data-correct="true"]').waitFor();
      await page.keyboard.press('3');
      await waitFor(() => mock.posts(/\/answer$/).length === 7, 'the fill answer');
      assert.deepEqual(lastAnswer(mock), { id: '10', mode: 'fill', grade: 'good', correct: true, answer: word.toUpperCase() });
      await page.locator('#h5-learn-back').click();

      // ── Say it: the voice box can also be typed in ──
      await page.locator('#h5-learn-mode-say').click();
      await page.locator('#h5-learn-say-text').waitFor();
      assert.equal(await page.locator('#h5-learn-mic').count(), 1, 'the microphone button');
      await page.locator('#h5-learn-say-input').fill('Please fix the login redirect loop after the session cookie expires');
      await page.locator('#h5-learn-check').click();
      await page.locator('#h5-learn-feedback[data-correct="true"]').waitFor();
      await page.keyboard.press('Enter');
      await waitFor(() => mock.posts(/\/answer$/).length === 8, 'the say answer');
      assert.equal(lastAnswer(mock).mode, 'say');
      await page.locator('#h5-learn-back').click();

      // ── Mistakes ──
      await page.locator('#h5-learn-mode-mistakes').click();
      await page.locator('#h5-learn-mistakes').waitFor();
      assert.equal(await page.locator('.h5-learn-mistake').count(), 3);
      await page.locator('#h5-learn-practise-mistakes').click();
      await page.locator('#h5-learn-meaning').waitFor();
      assert.equal(await text(page, '#h5-learn-view-title'), 'Mistakes');
      assert.equal(await text(page, '.h5-learn-subtitle'), '1 / 3');
      await page.locator('#h5-learn-back').click();

      // ── Your material: search, kind, edit meaning, suspend and restore ──
      await page.locator('#h5-learn-material').click();
      await page.locator('#h5-learn-cards').waitFor();
      assert.equal(await page.locator('.h5-learn-card-row').count(), 5);
      assert.equal(await text(page, '#h5-learn-total'), '5 cards');
      await page.locator('#h5-learn-search').fill('dep');
      await waitFor(async () => (await page.locator('.h5-learn-card-row').count()) === 2, 'the search');
      assert.equal(mock.requests.filter(item => item.path === '/api/learn/cards').at(-1).search.includes('q=dep'), true);
      await page.locator('#h5-learn-search').fill('');
      await page.locator('#h5-learn-kind button[value="word"]').click();
      await waitFor(async () => (await page.locator('.h5-learn-card-row').count()) === 2, 'words only');
      assert.equal(mock.requests.filter(item => item.path === '/api/learn/cards').at(-1).search.includes('kind=word'), true);
      const row = page.locator('.h5-learn-card-row[data-id="2"]');
      assert.equal(await text(page, '.h5-learn-card-row[data-id="2"] .h5-learn-card-zh'), 'No meaning yet');
      await row.locator('.h5-learn-edit').click();
      await page.locator('#h5-learn-edit-zh').fill('bushu');
      await page.locator('#h5-learn-save-zh').click();
      await waitFor(async () => (await text(page, '.h5-learn-card-row[data-id="2"] .h5-learn-card-zh')) === 'bushu', 'the new meaning');
      assert.deepEqual(mock.posts(/\/cards\/2$/).at(-1).body, { zh: 'bushu' });
      await row.locator('.h5-learn-suspend').click();
      await waitFor(async () => (await row.getAttribute('data-suspended')) === '', 'suspended');
      assert.deepEqual(mock.posts(/\/cards\/2$/).at(-1).body, { suspended: true });
      assert.equal(await text(page, '.h5-learn-card-row[data-id="2"] .h5-learn-suspend'), 'Restore');
      await row.locator('.h5-learn-suspend').click();
      await waitFor(async () => (await row.getAttribute('data-suspended')) === null, 'restored');
      assert.equal(mock.requests.some(item => item.method === 'DELETE'), false, 'no hard delete');

      // ── Learn settings ──
      await page.locator('#h5-learn-settings').click();
      await page.locator('#h5-learn-collect').waitFor();
      await page.locator('#h5-learn-collect').click();
      await waitFor(() => mock.posts(/\/settings$/).length === 1, 'collect saved');
      assert.deepEqual(mock.posts(/\/settings$/)[0].body, { collect: false });
      await waitFor(async () => (await page.evaluate(() => window.collectCalls.length)) === 1, 'window.LearnCollect.set');
      assert.deepEqual(await page.evaluate(() => window.collectCalls), [false], 'the page stops collecting at once');
      await page.locator('#h5-learn-goal-input').fill('30');
      await page.locator('#h5-learn-goal-input').press('Enter');
      await waitFor(() => mock.posts(/\/settings$/).length === 2, 'goal saved');
      assert.deepEqual(mock.posts(/\/settings$/)[1].body, { daily_goal: 30 });
      await page.waitForTimeout(300); // the saved goal comes back first
      await page.locator('#h5-learn-goal-input').fill('500');
      await waitFor(async () => /from 1 to 200/.test(await text(page, '#h5-learn-goal-input-helper-text')), 'an invalid goal is named');
      await page.locator('#h5-learn-goal-input').fill('30');
      await page.locator('#h5-learn-starter').click();
      await waitFor(() => mock.posts(/\/settings$/).length === 3, 'starter saved');
      assert.deepEqual(mock.posts(/\/settings$/)[2].body, { starter: null });

      // Escape closes the open panel, then the page; Sessions also leaves it.
      await page.keyboard.press('Escape');
      await page.locator('#h5-learn-how-card').waitFor();
      await page.keyboard.press('Escape');
      await waitFor(async () => !(await ui(page, 'learnOpen')), 'Escape closes Learn');
      await learn.click();
      await page.locator('#h5-learn').waitFor();
      await page.locator('#h5-nav-sessions').click();
      await waitFor(async () => !(await ui(page, 'learnOpen')), 'Sessions closes Learn');
      assert.equal(await page.locator('#h5-learn').count(), 0);
      assert.equal(await page.locator('#h5-nav-sessions').getAttribute('aria-current'), 'page');

      // ── Empty states: nothing due (free practice), then no cards (the starter list) ──
      mock.summary = { ...SUMMARY, due: 0 };
      await learn.click();
      await page.locator('#h5-learn-free').waitFor();
      assert.equal(await text(page, '#h5-learn-due'), 'Nothing due today');
      await page.locator('#h5-learn-free').click();
      await page.locator('#h5-learn-meaning').waitFor();
      assert.equal(await text(page, '#h5-learn-view-title'), 'Practice');
      assert.ok(mock.requests.some(item => item.search.includes('mode=spell')) && mock.requests.some(item => item.search.includes('mode=build')), 'words and sentences mixed');
      await page.locator('#h5-nav-sessions').click();
      mock.summary = { ...SUMMARY, due: 0, words: 0, sentences: 0, mistakes: 0, starter: null };
      await learn.click();
      await page.locator('#h5-learn-empty').waitFor();
      assert.match(await text(page, '#h5-learn-empty'), /translated|Chinese → English/);
      mock.summary = { ...SUMMARY };
      await page.locator('#h5-learn-add-starter').click();
      await waitFor(() => mock.posts(/\/starter$/).length === 1, 'the starter list');
      assert.deepEqual(mock.posts(/\/starter$/)[0].body, { list: 'dev' });
      await page.locator('#h5-learn-start').waitFor();
      await context.close();
    }

    // ── A browser without speech output or voice input: no Dictation, no Say it, no Hear it ──
    {
      const { context, page } = await openPage(browser, { viewport: { width: 1440, height: 900 }, speech: false });
      await page.locator('#h5-nav-learn').click();
      await page.locator('#h5-learn-mode-build').waitFor();
      assert.equal(await page.locator('#h5-learn-mode-dictation').count(), 0);
      assert.equal(await page.locator('#h5-learn-mode-say').count(), 0);
      await page.locator('#h5-learn-mode-build').click();
      await page.locator('#h5-learn-chinese').waitFor();
      assert.equal(await page.locator('#h5-learn-hear').count(), 0, 'no Hear it');
      await context.close();
    }

    // ── 390x844 (touch) ──
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 390, height: 844 }, touch: true });
      await page.locator('.h5-header').waitFor({ state: 'visible' });
      if (!(await page.locator('#h5-tasks').isVisible())) await page.locator('#h5-open-tasks').tap();
      await page.locator('#h5-tasks').waitFor({ state: 'visible' });
      const row = page.locator('#h5-tasks .h5-terminal-main', { hasText: 'Claude: login fix' });
      if (!(await row.count())) await page.locator('.h5-task-item', { hasText: 'Fix login' }).tap();
      await row.tap();
      await page.waitForFunction(() => !document.body.classList.contains('h5-tasks-open'));
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-bnav'));
      const item = page.locator('#h5-bnav-learn');
      assert.equal(await item.getAttribute('aria-label'), 'Learn');
      await item.tap();
      await page.locator('#h5-learn .h5-learn-home').waitFor({ state: 'visible' });
      assert.equal(await item.getAttribute('aria-current'), 'page');
      const paper = await rect(page, '#h5-learn .MuiDialog-paper');
      assert.equal(paper.y, 0);
      assert.equal(paper.bottom, 844 - 56, 'the page ends at the bottom navigation');
      assert.equal(await page.locator('#h5-bnav').evaluate(el => getComputedStyle(el).display), 'flex', 'the bar stays');
      await page.locator('#h5-learn-due').waitFor();

      // Spell the word: a page with a back arrow; the system keyboard does not cover the field or Check.
      await page.locator('#h5-learn-mode-spell').tap();
      await page.locator('#h5-learn-meaning').waitFor();
      await page.waitForTimeout(400);
      assert.equal(await text(page, '#h5-learn-mode .h5-learn-subtitle'), '1 / 2 · from words you looked up');
      const check = await rect(page, '#h5-learn-check');
      assert.ok(check.bottom <= 844 - 56 && check.bottom > 844 - 56 - 80, `Check is pinned just above the bar (${check.bottom})`);
      await page.locator('#h5-learn-spell-input').focus();
      await page.keyboard.type('expi');
      await shot(page, 'learn-phone-spell.png');
      await page.setViewportSize({ width: 390, height: 480 });
      await page.waitForFunction(() => window.H5UI.get().softKeyboard === true, null, { timeout: 5000 });
      await page.waitForTimeout(300);
      const visible = await page.evaluate(() => (window.visualViewport ? window.visualViewport.height : window.innerHeight));
      const checkUp = await rect(page, '#h5-learn-check');
      const field = await rect(page, '.h5-learn-letters');
      assert.ok(checkUp.bottom <= visible, `Check above the keyboard (${checkUp.bottom} <= ${visible})`);
      assert.ok(field.y >= 0 && field.bottom <= checkUp.y, 'the letters are in sight above Check');
      await page.evaluate(() => document.activeElement.blur());
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => window.H5UI.get().softKeyboard === false, null, { timeout: 5000 });
      // The back button closes the mode, then the page.
      await page.evaluate(() => history.back());
      await page.locator('#h5-learn-mode').waitFor({ state: 'hidden' });
      assert.equal(await ui(page, 'learnOpen'), true);

      // Build the sentence: tap tiles, Check, the grades pinned at the bottom.
      await page.locator('#h5-learn-mode-build').tap();
      await page.locator('#h5-learn-chinese').waitFor();
      await page.waitForTimeout(400);
      for (const word of ['Please', 'fix', 'the', 'login']) await page.locator('.h5-learn-pool .h5-learn-tile:not([disabled])', { hasText: new RegExp(`^${word}$`) }).first().tap();
      await shot(page, 'learn-phone-build.png');
      for (const word of ['redirect', 'loop', 'after', 'the', 'session', 'cookie', 'expires']) await page.locator('.h5-learn-pool .h5-learn-tile:not([disabled])', { hasText: new RegExp(`^${word}$`) }).first().tap();
      await page.locator('#h5-learn-check').tap();
      await page.locator('#h5-learn-feedback[data-correct="true"]').waitFor();
      assert.equal(await page.locator('.h5-learn-footer #h5-learn-grade-good').count(), 1, 'the grades are in the pinned actions');
      for (const id of ['again', 'hard', 'good']) assert.ok((await rect(page, `#h5-learn-grade-${id}`)).h >= 44, `${id}: a 44px target`);
      await page.locator('#h5-learn-grade-good').tap();
      await waitFor(() => mock.posts(/\/answer$/).length === 1, 'the phone answer');
      assert.deepEqual(lastAnswer(mock), { id: '10', mode: 'build', grade: 'good', correct: true, answer: 'Please fix the login redirect loop after the session cookie expires' });
      await page.locator('#h5-learn-back').tap();
      await page.locator('#h5-learn-mode').waitFor({ state: 'hidden' });

      // Dictation.
      await page.locator('#h5-learn-mode-dictation').tap();
      await page.locator('#h5-learn-dictation-input').waitFor();
      await page.waitForTimeout(400);
      await page.locator('#h5-learn-dictation-input').fill('Please fix the login');
      await shot(page, 'learn-phone-dictation.png');
      await page.evaluate(() => history.back());
      await page.locator('#h5-learn-mode').waitFor({ state: 'hidden' });
      await page.evaluate(() => history.back());
      await waitFor(async () => !(await ui(page, 'learnOpen')), 'back closes Learn');
      assert.equal(await page.locator('#h5-bnav-sessions').getAttribute('aria-current'), 'page');
      // Another destination leaves Learn.
      await item.tap();
      await page.locator('#h5-learn .h5-learn-home').waitFor({ state: 'visible' });
      await page.locator('#h5-bnav-settings').tap();
      await waitFor(async () => (await ui(page, 'settingsOpen')) && !(await ui(page, 'learnOpen')), 'Settings replaces Learn');
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const errors = pageErrors.filter(message => !/ResizeObserver loop/.test(message));
  assert.deepEqual(errors, [], 'no page errors');
  console.log('Learn page browser test passed');
})().catch(error => { console.error(error); process.exit(1); });
