// The Learn page (scripts/h5-shell/Learn.jsx, the "Learn" destination), in real Chromium with every route mocked, /api/learn following the contract
// of docs/design/learn-english.md. See "The Learn page" in docs/design/learn-english-page.md.
// The engine here has no coach (GET /api/learn/coach answers 404), so this is the test that the Learn home of such an engine still works
// ("Learn is the coach" in docs/design/learn-english-coach-page.md: with the coach there is no home).
// - 1440x900 (mouse): the rail's Learn destination and the page right of it; the home numbers (due, estimate, streak, goal, mode counts) without
//   Build the sentence (hidden on purpose, BUILD_HIDDEN in learn-model.mjs); Review with a word spelled and a sentence as Fill the gap (the diff,
//   the grades posted with the keys 3 and 2, the end of a session), a sentence without a content word as Dictation and Skip;
//   Spell the word (wrong letters, "I don't know"-free flow with the first letter, no translator configured and its link to Settings); Dictation (speech
//   at the normal and the slow rate, an article hint); Fill the gap; Say it; Mistakes; Your material (search, kind, edit meaning, suspend); Learn
//   settings (collect with window.LearnCollect, daily goal, starter list); Escape; Sessions closing the page; the empty states (no cards, nothing due);
//   a browser without speech output or voice input (no Dictation, no Say it, no Hear it; in Review a sentence is Fill the gap, one without a content
//   word gets its longest word as the gap, one without any word "no word to fill in" with Skip).
//   The buttons that play or help (Hear it, Show first letter, Hint, Slow) leave the focus in the answer field; no page keyboard on a computer.
// - 390x844 (touch): the bottom navigation's Learn; the home and the modes as pages above the bar; the page's own keyboard instead of the system one
//   (inputmode="none"; letters for Spell and Fill the gap, the full layout for Dictation; keys type at the caret, Shift, Backspace and its repeat, Hide and a tap
//   that opens it again, the bottom navigation away while it is open, Check right above it, the focus kept by Hear it and Show first letter); the
//   system keyboard not covering Say it's box or Check; the grades in the pinned actions; the back button closing the mode, then the page.
// - A company computer (390, touch): the banner while its home cannot be reached (`device.cache_only` and not `home_online`), none while the home
//   is online, and a 503 of the Learn settings shown in the panel with the switch put back.
// H5_SHOT_DIR=<dir> saves the screenshots (computer: home, Review's Fill the gap after Check, Spell; phone: Spell with the letters, Fill the gap, Dictation with the full keyboard).
const { chromium } = require('playwright');
const { bnavTap } = require('./h5-bottom-nav-tap.cjs');
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
const IPA_EXPIRE = '/\u026ak\u02c8spa\u026a\u0259r/';
const card = (id, kind, en, zh, source, extra = {}) => ({
  id, kind, en, zh, source, context: '', due_at: AT, interval_days: 0, ease: 2.5, reps: 0, lapses: 0, last_result: null, last_at: null, suspended: false, created_at: AT, ...extra,
});
const WORDS = [
  card(1, 'word', 'expire', ZH_EXPIRE, 'lookup', { context: 'after the session cookie expires', phonetic: IPA_EXPIRE }),
  card(2, 'word', 'deploy', '', 'starter'),
];
const SENTENCES = [
  card(10, 'sentence', 'Please fix the login redirect loop after the session cookie expires.', ZH_LOOP, 'translation', { context: 'SELF-TAGENT', created_at: '2026-11-19T08:00:00.000Z' }),
  card(11, 'sentence', 'Run the tests again before you merge.', ZH_TESTS, 'translation'),
  card(12, 'sentence', 'Deploy the staging server tonight.', ZH_DEPLOY, 'manual'),
];
const SUMMARY = { due: 18, new_today: 2, done_today: 7, goal: 20, streak: 5, words: 42, sentences: 26, mistakes: 3, chats: 2, collecting: true, starter: 'dev' };
// A sentence without a content word (Fill the gap has nothing to take out) and one without any word at all.
const PLAIN = card(13, 'sentence', 'I am here.', ZH_DEPLOY, 'manual');
const NO_WORD = card(14, 'sentence', '2 + 2 = 4', ZH_DEPLOY, 'manual');
const pageErrors = [];

function learnMock() {
  const mock = { summary: { ...SUMMARY }, settings: { collect: true, daily_goal: 20, starter: 'dev' }, translator: false, requests: [], material: [...WORDS, ...SENTENCES].map(item => ({ ...item })) };
  mock.handle = (p, method, url, body) => {
    mock.requests.push({ method, path: p, search: url.search, body });
    if (p === '/api/learn/summary') return mock.summary;
    if (p === '/api/learn/settings' && method === 'GET') return mock.settings;
    if (p === '/api/learn/settings' && method === 'PUT' && mock.settingsFail) return [503, { error: 'LEARN_HOME_OFFLINE', message: 'Learning settings are kept on a normal computer, which cannot be reached right now' }];
    if (p === '/api/learn/settings' && method === 'PUT') { mock.settings = { ...mock.settings, ...body }; return mock.settings; }
    if (p === '/api/learn/starter') return { added: 120 };
    if (p === '/api/learn/meaning') return mock.translator ? { zh: 'zh' } : [503, { error: 'No translator is configured' }];
    if (p === '/api/learn/queue') {
      const mode = url.searchParams.get('mode');
      if (mode === 'spell') return { cards: mock.spellCards || WORDS };
      if (mode === 'review') return { cards: mock.reviewCards || [WORDS[0], SENTENCES[0]] };
      if (mode === 'mistakes') return { cards: [WORDS[0], SENTENCES[1], SENTENCES[2]] };
      return { cards: SENTENCES };
    }
    // The Mistakes page (scripts/test-h5-learn-mistakes-browser.cjs checks it in detail).
    if (p === '/api/learn/mistakes') return { mistakes: ['expire', 'Run the tests again before you merge.', 'Deploy the staging server tonight.'].map((en, index) => ({ uid: `m${index}`, at: AT, mode: index ? 'build' : 'spell', tag: 'other', hinted: false, expected: en, written: 'x', card: { id: index + 1, kind: index ? 'sentence' : 'word', en } })), more: false };
    if (p === '/api/learn/reports' && method === 'GET') return { reports: [], since: { from: null, mistakes: 3, answers: 9 }, model: { ready: false, label: '', name: '' }, running: false, auto: true };
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
      // A reading starts at once and ends after window.speechMs (60 ms); window.refuseSpeech answers 'not-allowed' like iOS before the first tap.
      window.speechMs = 60;
      window.spokenAt = [];
      window.cancels = 0;
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
        speak(u) {
          window.spoken.push({ text: u.text, rate: u.rate, lang: u.lang });
          window.spokenAt.push({ text: u.text, at: performance.now() });
          if (window.refuseSpeech) { setTimeout(() => u.onerror && u.onerror({ error: 'not-allowed' }), 0); return; }
          setTimeout(() => u.onstart && u.onstart(), 0);
          setTimeout(() => u.onend && u.onend(), window.speechMs);
        },
        cancel() { window.cancels += 1; }, getVoices: () => [{ lang: 'en-US', name: 'Test', localService: true }], addEventListener() {}, removeEventListener() {},
      } });
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    } else {
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: undefined });
      Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
      Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: undefined });
      localStorage.setItem('voice-enabled', '0');
    }
    // The haptic tick of the page's keyboard (key-feedback.mjs) through navigator.vibrate, counted.
    window.vibrations = [];
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: ms => { window.vibrations.push(ms); return true; } });
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
const active = page => page.evaluate(() => document.activeElement && document.activeElement.id);
const value = (page, selector) => page.locator(selector).inputValue();
// Taps keys of the page's keyboard (`#h5-learn-keys`) by their character, or by their name in braces: {Shift}, {Backspace}, {Space}, {Hide}.
async function tapKeys(page, keys) {
  for (const key of keys.match(/\{\w+\}|./g)) {
    const name = /^\{(\w+)\}$/.exec(key);
    const selector = name ? (name[1] === 'Shift' ? '#h5-learn-keys button[data-shift]' : `#h5-learn-keys button[data-key="${name[1]}"]`) : `#h5-learn-keys button[data-char="${key.toLowerCase()}"]`;
    await page.locator(selector).tap();
  }
}
// The two rows of a wrong spelling: per row, the letters ('_' for an empty slot) and the kinds (first letters), with the left edge of every slot.
async function spellRows(page) {
  return page.evaluate(() => {
    const side = name => {
      const cells = [...document.querySelectorAll(`.h5-learn-letter-${name}`)];
      return { text: cells.map(el => el.textContent || '_').join(''), kinds: cells.map(el => el.dataset.kind[0]).join(''), lefts: cells.map(el => Math.round(el.getBoundingClientRect().left)), colors: cells.map(el => getComputedStyle(el).color), lines: cells.map(el => `${getComputedStyle(el).borderBottomStyle} ${getComputedStyle(el).borderBottomColor}`) };
    };
    return { want: side('want'), got: side('got'), pairs: document.querySelectorAll('.h5-learn-letter-pair').length, note: (document.querySelector('#h5-learn-spell-note') || {}).textContent || '' };
  });
}
const lastAnswer = mock => { const list = mock.posts(/\/answer$/); return list.length ? { id: list.at(-1).path.match(/cards\/(\d+)/)[1], ...list.at(-1).body } : null; };
// On a phone: picks the terminal in the task drawer (open at first), so the bottom navigation is there.
async function toTerminal(page) {
  await page.locator('.h5-header').waitFor({ state: 'visible' });
  if (!(await page.locator('#h5-tasks').isVisible())) await page.locator('#h5-open-tasks').tap();
  await page.locator('#h5-tasks').waitFor({ state: 'visible' });
  const row = page.locator('#h5-tasks .h5-terminal-main', { hasText: 'Claude: login fix' });
  if (!(await row.count())) await page.locator('.h5-task-item', { hasText: 'Fix login' }).tap();
  await row.tap();
  await page.waitForFunction(() => !document.body.classList.contains('h5-tasks-open'));
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-bnav-handle')); // the bar is behind its pull handle on the session page
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
      assert.deepEqual(await page.locator('.h5-learn-mode .h5-learn-count').allTextContents(), ['42 words', '26 sentences', '26 sentences', '26 sentences', '3 cards', '2 chats']);
      assert.deepEqual(await page.locator('.h5-learn-mode .MuiTypography-subtitle1').allTextContents(), ['Spell the word', 'Dictation', 'Say it', 'Fill the gap', 'Mistakes', 'English chat']);
      assert.equal(await page.locator('#h5-learn-mode-build').count(), 0, 'Build the sentence is hidden');
      assert.match(await text(page, '#h5-learn-material'), /From your translations · 26 sentences, 42 words/);
      assert.equal(await page.locator('#h5-learn-home-away').count(), 0, 'a normal machine has no banner');
      await page.locator('#h5-learn-how-card').waitFor({ state: 'visible' });
      assert.match(await text(page, '#h5-learn-how-card'), /Four ways to practise/);
      assert.doesNotMatch(await text(page, '#h5-learn-how-card'), /Build/, 'How learning works does not name Build');
      await shot(page, 'learn-desktop-home.png');

      // ── Review: a word is spelled, a sentence is Fill the gap (not Build); the diff, the grades with the keys 3 and 2, the end of a session ──
      const { gapFor } = await import(path.join(root, 'scripts/h5-shell/learn-model.mjs'));
      await page.locator('#h5-learn-start').click();
      await page.locator('#h5-learn-meaning').waitFor();
      assert.equal(await text(page, '#h5-learn-view-title'), 'Daily review');
      assert.equal(await text(page, '.h5-learn-subtitle'), '1 / 2');
      await page.locator('#h5-learn-spell-input').fill('expire');
      await page.locator('#h5-learn-feedback[data-correct="true"]').waitFor();
      await page.keyboard.press('3');
      await waitFor(() => mock.posts(/\/answer$/).length === 1, 'the word is answered');
      assert.deepEqual(lastAnswer(mock), { id: '1', mode: 'spell', grade: 'good', correct: true, answer: 'expire' });
      await waitFor(async () => (await text(page, '.h5-learn-subtitle')) === '2 / 2', 'the sentence card');
      await page.locator('#h5-learn-gap-input').waitFor();
      assert.equal(await page.locator('.h5-learn-pool').count(), 0, 'no word tiles: Build is hidden');
      assert.equal(await page.locator('#h5-learn-build-input').count(), 0);
      assert.equal(await text(page, '#h5-learn-chinese'), ZH_LOOP);
      assert.equal(await active(page), 'h5-learn-gap-input', 'the gap has the focus on a computer');
      const reviewGap = gapFor(SENTENCES[0]).word;
      assert.equal(await text(page, '.h5-learn-gap'), SENTENCES[0].en.replace(reviewGap, '').replace(/\s+/g, ' '), 'the sentence around the gap');
      await page.locator('#h5-learn-gap-input').fill('zz');
      await page.locator('#h5-learn-check').click();
      await page.locator('#h5-learn-feedback').waitFor();
      assert.equal(await page.locator('#h5-learn-feedback').getAttribute('data-correct'), 'false');
      assert.equal(await text(page, '.h5-learn-del'), 'zz');
      assert.equal(await text(page, '.h5-learn-ins'), reviewGap);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'h5-learn-grade-again', 'the offered grade (wrong: Again) has the focus');
      await shot(page, 'learn-desktop-review-fill.png');
      await page.keyboard.press('2');
      await waitFor(() => mock.posts(/\/answer$/).length === 2, 'the sentence is answered');
      const { tag: reviewTag, ...reviewAnswer } = lastAnswer(mock);
      assert.deepEqual(reviewAnswer, { id: '10', mode: 'fill', grade: 'hard', correct: false, answer: 'zz', expected: reviewGap, hinted: false }, 'posted as Fill the gap, the gap word asked for');
      assert.equal(typeof reviewTag, 'string');
      await page.locator('#h5-learn-done').waitFor();
      assert.match(await text(page, '#h5-learn-done'), /2 answered · 1 right/);
      await page.locator('#h5-learn-finish').click();
      await page.locator('#h5-learn-how-card').waitFor();
      // A sentence without a content word in Review: Dictation, since this browser can speak (a weak gap like "I" would teach little); Skip posts nothing.
      mock.reviewCards = [PLAIN];
      await page.locator('#h5-learn-start').click();
      await page.locator('#h5-learn-dictation-input').waitFor();
      assert.equal(await text(page, '#h5-learn-view-title'), 'Daily review');
      assert.equal(await page.locator('#h5-learn-gap-input').count(), 0);
      await page.locator('#h5-learn-skip').click();
      await page.locator('#h5-learn-done').waitFor();
      assert.equal(mock.posts(/\/answer$/).length, 2, 'Skip posts no answer');
      mock.reviewCards = null;
      await page.locator('#h5-learn-finish').click();
      await page.locator('#h5-learn-how-card').waitFor();

      // ── Spell the word: wrong letters with the key 1; no translator; the first letter and Hard ──
      await page.locator('#h5-learn-mode-spell').click();
      await page.locator('#h5-learn-meaning').waitFor();
      assert.equal(await text(page, '#h5-learn-meaning'), ZH_EXPIRE);
      assert.match(await text(page, '.h5-learn-prompt'), /Used in "after the session cookie ___"/);
      assert.equal(await page.locator('.h5-learn-letter').count(), 6, 'a box per letter');
      assert.equal(await active(page), 'h5-learn-spell-input', 'the letters have the focus on start');
      await page.locator('#h5-learn-hear').click();
      assert.deepEqual(await page.evaluate(() => window.spoken.at(-1)), { text: 'expire', rate: 1, lang: 'en-US' });
      assert.equal(await active(page), 'h5-learn-spell-input', 'Hear it leaves the focus in the letters');
      await page.locator('.h5-learn-letters').click();
      await page.keyboard.type('expi');
      await page.locator('#h5-learn-hear').click();
      assert.equal(await active(page), 'h5-learn-spell-input', 'Hear it after typing: the caret stays');
      assert.equal(await page.locator('#h5-learn-spell-input').evaluate(el => el.selectionStart), 4);
      assert.equal(await page.locator('#h5-learn-keys').count(), 0, 'no page keyboard on a computer');
      assert.equal(await page.locator('#h5-learn-spell-input').getAttribute('inputmode'), null);
      await shot(page, 'learn-desktop-spell.png');
      await page.keyboard.type('er');
      await page.keyboard.press('Enter');
      await page.locator('#h5-learn-feedback[data-correct="false"]').waitFor();
      assert.match(await text(page, '#h5-learn-feedback'), /expire.*You wrote: expier.*4 of 6 letters right/);
      // The right spelling above the typed one, letter by letter: the same length lines up by position.
      const wrongRows = await spellRows(page);
      assert.equal(wrongRows.pairs, 1, 'one pair of rows');
      assert.equal(wrongRows.want.text, 'expire');
      assert.equal(wrongRows.got.text, 'expier');
      assert.equal(wrongRows.want.kinds, 'ssssww');
      assert.equal(wrongRows.got.kinds, 'ssssww');
      assert.deepEqual(wrongRows.want.lefts, wrongRows.got.lefts, 'each letter in the same column');
      assert.equal(wrongRows.note, '2 letters different');
      assert.equal(await page.locator('.h5-learn-letters').getAttribute('data-aligned'), 'true');
      const [same, differs] = [wrongRows.want.colors[0], wrongRows.want.colors[4]];
      assert.notEqual(same, differs, 'the top row: a differing letter in green, not the text colour');
      assert.equal(wrongRows.got.colors[0], differs, 'the bottom row: a right letter green, as the differing one above');
      assert.notEqual(wrongRows.got.colors[4], differs, 'the bottom row: a wrong letter red');
      assert.equal(wrongRows.want.lines[4], `solid ${differs}`, 'a green line under a differing letter');
      await page.keyboard.press('1');
      await waitFor(() => mock.posts(/\/answer$/).length === 3, 'the spell answer');
      assert.deepEqual(lastAnswer(mock), { id: '1', mode: 'spell', grade: 'again', correct: false, answer: 'expier', expected: 'expire', tag: 'letter-order', hinted: false });
      await page.locator('#h5-learn-no-translator').waitFor();
      assert.match(await text(page, '#h5-learn-no-translator'), /Word meanings need a translator/);
      assert.deepEqual(mock.posts(/\/meaning$/).at(-1).body, { word: 'deploy' });
      await page.locator('#h5-learn-first').click();
      assert.equal(await page.locator('#h5-learn-spell-input').inputValue(), 'd');
      assert.equal(await active(page), 'h5-learn-spell-input', 'Show first letter leaves the focus in the letters');
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
      assert.equal(await active(page), 'h5-learn-dictation-input', 'Slow leaves the focus in the field');
      await page.locator('#h5-learn-dictation-input').fill('Please fix login redirect loop after the session cookie expires');
      await page.locator('#h5-learn-check').click();
      await page.locator('#h5-learn-feedback').waitFor();
      assert.match(await text(page, '.h5-learn-summary'), /10 of 11 right · "the": article missing/);
      assert.equal(await text(page, '#h5-learn-chinese'), ZH_LOOP, 'the Chinese after Check');
      await page.locator('#h5-learn-grade-good').click();
      await waitFor(() => mock.posts(/\/answer$/).length === 6, 'the dictation answer');
      assert.deepEqual(lastAnswer(mock), { id: '10', mode: 'dictation', grade: 'good', correct: false, answer: 'Please fix login redirect loop after the session cookie expires', expected: SENTENCES[0].en, tag: 'article', hinted: false });
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
      assert.equal(await active(page), 'h5-learn-gap-input');
      await page.locator('#h5-learn-hear').click();
      assert.equal(await active(page), 'h5-learn-gap-input', 'Hear it leaves the focus in the gap');
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
      assert.ok(mock.requests.some(item => item.search.includes('mode=spell')) && mock.requests.some(item => item.search.includes('mode=fill')), 'words and sentences mixed');
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

    // ── A browser without speech output or voice input: no Dictation, no Say it, no Hear it; Review's sentences are Fill the gap ──
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 1440, height: 900 }, speech: false });
      await page.locator('#h5-nav-learn').click();
      await page.locator('#h5-learn-mode-fill').waitFor();
      assert.equal(await page.locator('#h5-learn-mode-dictation').count(), 0);
      assert.equal(await page.locator('#h5-learn-mode-say').count(), 0);
      assert.equal(await page.locator('#h5-learn-mode-build').count(), 0, 'no Build to fall back to either');
      mock.reviewCards = [SENTENCES[2], PLAIN, NO_WORD];
      await page.locator('#h5-learn-start').click();
      // A sentence: Fill the gap (before, Build the sentence was the fallback).
      await page.locator('#h5-learn-gap-input').waitFor();
      assert.equal(await text(page, '#h5-learn-chinese'), ZH_DEPLOY);
      assert.equal(await page.locator('#h5-learn-hear').count(), 0, 'no Hear it');
      await page.locator('#h5-learn-skip').click();
      // No content word and no speech: Fill the gap with the longest word ("here").
      await waitFor(async () => (await text(page, '.h5-learn-subtitle')) === '2 / 3', 'the second card');
      await page.locator('#h5-learn-gap-input').waitFor();
      assert.equal(await text(page, '.h5-learn-gap'), 'I am .');
      await page.locator('#h5-learn-gap-input').fill('here');
      await page.locator('#h5-learn-feedback[data-correct="true"]').waitFor();
      await page.keyboard.press('3');
      await waitFor(() => mock.posts(/\/answer$/).length === 1, 'the loose gap is answered');
      assert.deepEqual(lastAnswer(mock), { id: '13', mode: 'fill', grade: 'good', correct: true, answer: 'here' });
      // No word at all: the card says so and Skip goes on.
      await waitFor(async () => (await text(page, '.h5-learn-subtitle')) === '3 / 3', 'the third card');
      await page.getByText('This sentence has no word to fill in.').waitFor();
      await page.locator('#h5-learn-skip').click();
      await page.locator('#h5-learn-done').waitFor();
      assert.equal(mock.posts(/\/answer$/).length, 1);
      await context.close();
    }

    // ── A company computer (390, touch): the banner while its home cannot be reached; a 503 of the settings in view ──
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 390, height: 844 }, touch: true });
      const device = { company_computer: true, cache_only: true, home_name: 'T01', home_online: false, waiting: 3, offline_copy_at: AT };
      mock.summary = { ...SUMMARY, device };
      await toTerminal(page);
      await bnavTap(page, '#h5-bnav-learn');
      await page.locator('#h5-learn-home-away').waitFor();
      assert.equal(await text(page, '#h5-learn-home-away'), "T01 can't be reached. Your answers are kept on this computer for now and moved to T01 when it is back.");
      assert.equal(await page.locator('#h5-learn-home-away').evaluate(el => el.classList.contains('MuiAlert-colorInfo')), true, 'an info alert');
      const banner = await rect(page, '#h5-learn-home-away');
      assert.ok(banner.y < (await rect(page, '#h5-learn-today')).y, 'above the numbers');
      assert.ok(banner.x >= 16 && banner.x + banner.w <= 390 - 16, 'inside the page');
      assert.equal(await text(page, '#h5-learn-offline-counts'), 'The counts are those of the last copy from T01 plus what you answered here.');
      await shot(page, 'learn-phone-home-away.png');
      // Learn settings: the server's 503 stays in view and the switch shows the stored value again.
      mock.settingsFail = true;
      await page.locator('#h5-learn-settings').tap();
      await page.locator('#h5-learn-collect').waitFor();
      await page.locator('#h5-learn-collect').tap();
      await page.locator('#h5-learn-settings-error').waitFor();
      assert.equal(await text(page, '#h5-learn-settings-error'), 'Learning settings are kept on a normal computer, which cannot be reached right now');
      assert.equal(await page.locator('#h5-learn-collect').isChecked(), true, 'the switch goes back');
      mock.settingsFail = false;
      await page.locator('#h5-learn-collect').tap();
      await waitFor(async () => (await page.locator('#h5-learn-settings-error').count()) === 0, 'a change that works clears it');
      await context.close();
      // The home online again (answers still waiting are handed over by the server): no banner.
      const online = await openPage(browser, { viewport: { width: 390, height: 844 }, touch: true });
      online.mock.summary = { ...SUMMARY, device: { ...device, home_online: true, offline_copy_at: null } };
      await toTerminal(online.page);
      await bnavTap(online.page, '#h5-bnav-learn');
      await online.page.locator('#h5-learn-due').waitFor();
      assert.equal(await online.page.locator('#h5-learn-home-away').count(), 0);
      assert.equal(await online.page.locator('#h5-learn-offline-counts').count(), 0);
      await online.context.close();
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
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-bnav-handle')); // the bar is behind its pull handle on the session page
      const item = page.locator('#h5-bnav-learn');
      assert.equal(await item.getAttribute('aria-label'), 'Learn');
      await bnavTap(page, '#h5-bnav-learn');
      await page.locator('#h5-learn .h5-learn-home').waitFor({ state: 'visible' });
      assert.equal(await item.getAttribute('aria-current'), 'page');
      const paper = await rect(page, '#h5-learn .MuiDialog-paper');
      assert.equal(paper.y, 0);
      assert.equal(paper.bottom, 844 - 56, 'the page ends at the bottom navigation');
      assert.equal(await page.locator('#h5-bnav').evaluate(el => getComputedStyle(el).display), 'flex', 'the bar stays');
      await page.locator('#h5-learn-due').waitFor();

      // Spell the word: a page with a back arrow; the page's letter keyboard instead of the system one, where the system keyboard would be.
      await page.locator('#h5-learn-mode-spell').tap();
      await page.locator('#h5-learn-meaning').waitFor();
      await page.waitForTimeout(400);
      assert.equal(await text(page, '#h5-learn-mode .h5-learn-subtitle'), '1 / 2');
      assert.equal(await text(page, '#h5-learn-mode .h5-learn-subtitle-note'), 'from words you looked up', 'the source small on the same line');
      const spell = '#h5-learn-spell-input';
      assert.equal(await page.locator(spell).getAttribute('inputmode'), 'none', 'the system keyboard never opens');
      assert.equal(await active(page), 'h5-learn-spell-input', 'the field has the focus (and the caret) on start');
      await page.locator('#h5-learn-keys[data-kind="letters"]').waitFor({ state: 'visible' });
      assert.equal(await ui(page, 'softKeyboard'), false);
      const rows = await page.locator('#h5-learn-keys .h5-osk-row').evaluateAll(list => list.map(row => [...row.children].map(key => key.dataset.char || key.dataset.key || (key.hasAttribute('data-shift') ? 'Shift' : '?')).join(' ')));
      assert.deepEqual(rows, ['q w e r t y u i o p', "a s d f g h j k l '", 'Shift z x c v b n m - Backspace'], 'the phone letter layout: three rows, no Space, no digits');
      assert.equal(await page.locator('#h5-learn-keys button[data-char="-"]').getAttribute('aria-label'), 'Hyphen');
      assert.equal(await page.locator('#h5-learn-keys-hide').getAttribute('aria-label'), 'Hide keyboard');
      assert.equal(await page.locator('.h5-learn-footer #h5-learn-keys-hide').count(), 1, 'Hide in the pinned actions');
      assert.equal(await page.locator('#h5-learn-keys button[data-char="\'"]').getAttribute('aria-label'), 'Apostrophe');
      assert.equal(await page.locator('#h5-learn-keys button[data-key="Backspace"]').getAttribute('aria-label'), 'Backspace');
      assert.equal(await page.locator('#h5-learn-keys button[data-shift]').getAttribute('aria-label'), 'Shift');
      assert.equal(await page.locator('#h5-learn-keys button[data-char]').first().getAttribute('tabindex'), '-1', 'a key never takes the focus');
      // The bottom navigation steps aside; the page reaches the bottom; the keyboard is at the bottom and Check right above it.
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-bnav'));
      assert.equal(await page.locator('#h5-bnav').isVisible(), false, 'the bottom navigation is hidden while the keyboard is open');
      assert.equal(await ui(page, 'learnKeys'), true);
      await page.waitForTimeout(100);
      const keyboard = await rect(page, '#h5-learn-keys');
      assert.equal((await rect(page, '#h5-learn-mode .MuiDialog-paper')).bottom, 844, 'the page reaches the bottom of the screen');
      assert.ok(keyboard.bottom <= 844 && keyboard.bottom >= 844 - 16, `the keyboard sits at the bottom (${keyboard.bottom})`);
      const check = await rect(page, '#h5-learn-check');
      assert.ok(check.bottom <= keyboard.y && check.bottom > keyboard.y - 80, `Check is right above the keyboard (${check.bottom}, ${keyboard.y})`);
      // Show first letter (a hint icon in the "I don't know" row) and Hear it (an icon of the audio row) keep the focus in the field.
      assert.equal(await page.locator('.h5-learn-footer #h5-learn-first').getAttribute('aria-label'), 'Show first letter');
      assert.match(await page.locator('#h5-learn-hear').getAttribute('title'), /^(Hear it|Playing \d of \d)$/);
      assert.equal(await page.locator('#h5-learn-stop').getAttribute('aria-label'), 'Stop');
      assert.equal(await page.locator('#h5-learn-slow').getAttribute('aria-label'), 'Play slowly');
      await page.locator('#h5-learn-first').tap();
      assert.equal(await value(page, spell), 'e');
      assert.equal(await active(page), 'h5-learn-spell-input', 'Show first letter keeps the focus');
      await page.locator('#h5-learn-hear').tap();
      assert.equal(await active(page), 'h5-learn-spell-input', 'Hear it keeps the focus');
      assert.equal(await page.evaluate(() => window.spoken.at(-1).text), 'expire');
      // Keys type at the caret; Backspace deletes; Shift is one-shot; the field keeps the focus.
      await tapKeys(page, 'xpir');
      assert.equal(await value(page, spell), 'expir');
      await tapKeys(page, '{Backspace}');
      assert.equal(await value(page, spell), 'expi');
      await tapKeys(page, '{Shift}');
      assert.equal(await page.locator('#h5-learn-keys').getAttribute('data-shift'), 'once');
      assert.equal(await text(page, '#h5-learn-keys button[data-char="q"]'), 'Q', 'the letters show upper case while Shift is on');
      await tapKeys(page, 'r');
      assert.equal(await value(page, spell), 'expiR');
      assert.equal(await page.locator('#h5-learn-keys').getAttribute('data-shift'), 'off', 'one-shot');
      assert.equal(await text(page, '#h5-learn-keys button[data-char="q"]'), 'q');
      await tapKeys(page, '{Backspace}');
      assert.equal(await active(page), 'h5-learn-spell-input', 'the keys never take the focus');
      // Backspace repeats while it is held (400 ms, then every 60 ms).
      const back = page.locator('#h5-learn-keys button[data-key="Backspace"]');
      await back.dispatchEvent('pointerdown', { button: 0, pointerId: 7, pointerType: 'touch', isPrimary: true });
      await page.waitForTimeout(650);
      await back.dispatchEvent('pointerup', { button: 0, pointerId: 7, pointerType: 'touch', isPrimary: true });
      assert.equal(await value(page, spell), '', 'a held Backspace deleted every letter');
      await tapKeys(page, 'expi');
      assert.equal(await value(page, spell), 'expi');
      await shot(page, 'learn-phone-spell.png');
      // Hide closes it (the bottom navigation comes back); a tap on the letters opens it again.
      await page.locator('#h5-learn-keys-hide').tap();
      await page.locator('#h5-learn-keys').waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-bnav'));
      assert.equal(await page.locator('#h5-bnav').isVisible(), true);
      await page.locator('.h5-learn-letters').tap();
      await page.locator('#h5-learn-keys[data-kind="letters"]').waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-bnav'));
      await tapKeys(page, 're');
      assert.equal(await value(page, spell), 'expire');
      await page.locator('#h5-learn-check').tap();
      await page.locator('#h5-learn-feedback[data-correct="true"]').waitFor();
      assert.equal(await page.locator('.h5-learn-letter-pair').count(), 0, 'a right answer stays one row');
      assert.equal(await page.locator('.h5-learn-letter').count(), 6);
      assert.equal(await page.locator('#h5-learn-spell-note').count(), 0);
      const grades = await rect(page, '.h5-learn-footer .h5-learn-grades');
      assert.ok(grades.bottom <= (await rect(page, '#h5-learn-keys')).y, 'the grades stay above the keyboard');
      assert.equal(await ui(page, 'hasKeyboard'), false, 'the page keys are not a hardware keyboard');
      // The back button closes the mode (and its keyboard: the bottom navigation comes back), then the page.
      await page.evaluate(() => history.back());
      await page.locator('#h5-learn-mode').waitFor({ state: 'hidden' });
      assert.equal(await ui(page, 'learnOpen'), true);
      await waitFor(async () => (await ui(page, 'learnKeys')) === false, 'the keyboard went with the mode');
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-bnav'));

      // Fill the gap: the letters open by themselves, the gap checks itself at its last letter, the grades pinned at the bottom.
      const { gapFor: phoneGap } = await import(path.join(root, 'scripts/h5-shell/learn-model.mjs'));
      await page.locator('#h5-learn-mode-fill').tap();
      await page.locator('#h5-learn-gap-input').waitFor();
      assert.equal(await page.locator('#h5-learn-gap-input').getAttribute('inputmode'), 'none');
      await page.locator('#h5-learn-keys[data-kind="letters"]').waitFor({ state: 'visible' });
      const phoneWord = phoneGap(SENTENCES[0]).word;
      await tapKeys(page, phoneWord);
      assert.equal(await active(page), 'h5-learn-gap-input', 'the keys never take the focus');
      await shot(page, 'learn-phone-fill.png');
      await page.locator('#h5-learn-feedback[data-correct="true"]').waitFor({ timeout: 2000 });
      assert.equal(await page.locator('.h5-learn-footer #h5-learn-grade-good').count(), 1, 'the grades are in the pinned actions');
      for (const id of ['again', 'hard', 'good']) assert.ok((await rect(page, `#h5-learn-grade-${id}`)).h >= 44, `${id}: a 44px target`);
      await page.locator('#h5-learn-grade-good').tap();
      await waitFor(() => mock.posts(/\/answer$/).length === 1, 'the phone answer');
      assert.deepEqual(lastAnswer(mock), { id: '10', mode: 'fill', grade: 'good', correct: true, answer: phoneWord });
      await page.locator('#h5-learn-back').tap();
      await page.locator('#h5-learn-mode').waitFor({ state: 'hidden' });

      // Dictation.
      await page.locator('#h5-learn-mode-dictation').tap();
      await page.locator('#h5-learn-dictation-input').waitFor();
      await page.waitForTimeout(400);
      const dictation = '#h5-learn-dictation-input';
      assert.equal(await page.locator(dictation).getAttribute('inputmode'), 'none');
      assert.equal(await active(page), 'h5-learn-dictation-input');
      await page.locator('#h5-learn-keys[data-kind="full"]').waitFor({ state: 'visible' });
      const bottomRow = await page.locator('#h5-learn-keys .h5-osk-row').last().evaluate(row => [...row.children].map(key => key.dataset.layer || key.dataset.key).join(' '));
      assert.equal(bottomRow, 'num Space Hide');
      await page.locator('#h5-learn-play').tap();
      assert.equal(await active(page), 'h5-learn-dictation-input', 'Play keeps the focus');
      await tapKeys(page, '{Shift}please{Space}fix');
      await page.locator('#h5-learn-keys button[data-layer="num"]').tap();
      await page.locator('#h5-learn-keys button[data-char="1"]').tap();
      assert.equal(await value(page, dictation), 'Please fix1');
      await page.locator('#h5-learn-keys button[data-key="Backspace"]').tap();
      await page.locator('#h5-learn-keys button[data-layer="abc"]').tap();
      assert.equal(await value(page, dictation), 'Please fix');
      // A key goes in at the caret.
      await page.locator(dictation).evaluate(el => el.setSelectionRange(0, 0));
      await tapKeys(page, 'a');
      assert.equal(await value(page, dictation), 'aPlease fix');
      assert.equal(await page.locator(dictation).evaluate(el => el.selectionStart), 1, 'the caret is after the new letter');
      await page.locator(dictation).fill('Please fix the login');
      assert.equal(await page.locator('#h5-bnav').isVisible(), false);
      const footer = await rect(page, '.h5-learn-footer');
      assert.ok(footer.bottom <= (await rect(page, '#h5-learn-keys')).y + 1, 'Check stays right above the keyboard');
      await shot(page, 'learn-phone-dictation.png');
      await page.evaluate(() => history.back());
      await page.locator('#h5-learn-mode').waitFor({ state: 'hidden' });

      // Say it keeps the system keyboard: it does not cover the box or Check.
      await page.locator('#h5-learn-mode-say').tap();
      await page.locator('#h5-learn-say-text').waitFor();
      await page.waitForTimeout(400);
      assert.equal(await page.locator('#h5-learn-keys').count(), 0, 'no page keyboard in Say it');
      await page.locator('#h5-learn-say-input').focus();
      await page.setViewportSize({ width: 390, height: 480 });
      await page.waitForFunction(() => window.H5UI.get().softKeyboard === true, null, { timeout: 5000 });
      await page.waitForTimeout(300);
      const visible = await page.evaluate(() => (window.visualViewport ? window.visualViewport.height : window.innerHeight));
      const checkUp = await rect(page, '#h5-learn-check');
      assert.ok(checkUp.bottom <= visible, `Check above the keyboard (${checkUp.bottom} <= ${visible})`);
      await page.evaluate(() => document.activeElement.blur());
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => window.H5UI.get().softKeyboard === false, null, { timeout: 5000 });
      await page.evaluate(() => history.back());
      await page.locator('#h5-learn-mode').waitFor({ state: 'hidden' });
      await page.evaluate(() => history.back());
      await waitFor(async () => !(await ui(page, 'learnOpen')), 'back closes Learn');
      assert.equal(await page.locator('#h5-bnav-sessions').getAttribute('aria-current'), 'page');
      // Another destination leaves Learn.
      await bnavTap(page, '#h5-bnav-learn');
      await page.locator('#h5-learn .h5-learn-home').waitFor({ state: 'visible' });
      await bnavTap(page, '#h5-bnav-settings');
      await waitFor(async () => (await ui(page, 'settingsOpen')) && !(await ui(page, 'learnOpen')), 'Settings replaces Learn');
      await context.close();
    }

    // ── Auto-check at the last letter, the phonetic transcription, the audio with repeat, the key bubble and haptic, one-line letters ──
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 390, height: 844 }, touch: true });
      mock.translator = true;
      mock.settings = { ...mock.settings, audio_words: true, audio_sentences: true, audio_sentences_at: 'after', audio_repeat: 2, audio_pause: 1, audio_speed: 'normal', audio_stop_on_typing: true };
      await toTerminal(page);
      await bnavTap(page, '#h5-bnav-learn');
      await page.locator('#h5-learn-due').waitFor();
      const spell = '#h5-learn-spell-input';
      const spokenOf = word => page.evaluate(w => window.spokenAt.filter(item => item.text === w), word);
      await page.locator('#h5-learn-mode-spell').tap();
      await page.locator('#h5-learn-meaning').waitFor();
      // The word plays when its card appears, twice with a pause of 1 s; the button says so, with Stop.
      await waitFor(async () => (await spokenOf('expire')).length >= 1, 'the word plays when the card appears');
      await page.locator('#h5-learn-hear[data-playing="true"]').waitFor();
      // On a phone the sound is a row of icons: the name (aria-label and title) says it plays, Stop is enabled.
      assert.match(await page.locator('#h5-learn-hear').getAttribute('aria-label'), /^Playing [12] of 2$/);
      assert.equal(await page.locator('#h5-learn-stop').isEnabled(), true, 'Stop while it plays');
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'learn-phone-spell-playing.png') }); }
      await waitFor(async () => (await spokenOf('expire')).length === 2, 'the repeat', 4000);
      const [first, second] = await spokenOf('expire');
      assert.ok(second.at - first.at >= 1000 && second.at - first.at < 1800, `the pause between repeats (${Math.round(second.at - first.at)} ms)`);
      await waitFor(async () => (await page.locator('#h5-learn-hear[data-playing]').count()) === 0, 'idle after the repeats');
      assert.equal(await page.locator('#h5-learn-hear').getAttribute('aria-label'), 'Hear it');
      assert.equal(await page.locator('#h5-learn-hear').getAttribute('title'), 'Hear it');
      assert.equal(await page.locator('#h5-learn-stop').isDisabled(), true, 'Stop waits for a play');
      // Play, Stop and Play slowly in one row, each a 44px target.
      const audioRow = await page.locator('.h5-learn-audio button').evaluateAll(list => list.map(el => { const r = el.getBoundingClientRect(); return [el.id, Math.round(r.width), Math.round(r.height), Math.round(r.top)]; }));
      assert.deepEqual(audioRow.map(item => item[0]), ['h5-learn-hear', 'h5-learn-stop', 'h5-learn-slow']);
      assert.ok(audioRow.every(([, w, h, top]) => w >= 44 && h >= 44 && top === audioRow[0][3]), `one row of 44px targets (${JSON.stringify(audioRow)})`);
      // The transcription next to Hear it (the sound is offered there), as user content.
      assert.equal(await text(page, '#h5-learn-phonetic'), '/ɪkˈspaɪər/');
      assert.equal(await page.locator('#h5-learn-phonetic').getAttribute('translate'), 'no');
      await shot(page, 'learn-phone-spell-phonetic.png');
      // Hear it by hand plays again with the same repeat; typing a letter skips the rest (Stop when I start typing).
      const before = (await spokenOf('expire')).length;
      await page.locator('#h5-learn-hear').tap();
      await tapKeys(page, 'e');
      await page.waitForTimeout(1600);
      assert.equal((await spokenOf('expire')).length, before + 1, 'typing skipped the repeat');
      // Stop cancels the pending repeat.
      await page.locator('#h5-learn-hear').tap();
      await page.locator('#h5-learn-stop').tap();
      await page.waitForTimeout(1500);
      assert.equal((await spokenOf('expire')).length, before + 2, 'Stop: no repeat');
      assert.equal(await page.locator('#h5-learn-stop').isDisabled(), true);
      assert.equal(await active(page), 'h5-learn-spell-input', 'Hear it and Stop leave the focus in the letters');
      // The key bubble: on pointerdown over a character key, the character larger above it, inside the keyboard; away on pointerup. One haptic tick a press.
      const vibrations = await page.evaluate(() => window.vibrations.length);
      const qKey = page.locator('#h5-learn-keys button[data-char="q"]');
      await qKey.dispatchEvent('pointerdown', { button: 0, pointerId: 3, pointerType: 'touch', isPrimary: true });
      await page.locator('.h5-key-bubble').waitFor({ state: 'visible' });
      assert.equal(await text(page, '.h5-key-bubble'), 'q');
      assert.equal(await page.locator('.h5-key-bubble').getAttribute('aria-hidden'), 'true');
      const bubble = await rect(page, '.h5-key-bubble');
      const qRect = await rect(page, '#h5-learn-keys button[data-char="q"]');
      const keysRect = await rect(page, '#h5-learn-keys');
      assert.ok(bubble.bottom <= qRect.y && bubble.bottom >= qRect.y - 8, `the bubble sits just above the key (${bubble.bottom}, ${qRect.y})`);
      assert.ok(bubble.x >= keysRect.x && bubble.x + bubble.w <= keysRect.x + keysRect.w + 1, 'clamped inside the keyboard at the left edge');
      assert.ok(bubble.y < keysRect.y, 'above the top row, outside the keyboard box (not clipped)');
      assert.ok(bubble.w > qRect.w && bubble.h > qRect.h, 'larger than the key');
      await shot(page, 'learn-phone-key-bubble.png');
      await qKey.dispatchEvent('pointerup', { button: 0, pointerId: 3, pointerType: 'touch', isPrimary: true });
      await page.locator('.h5-key-bubble').waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => window.vibrations.length), vibrations + 1, 'one haptic tick for the press');
      assert.deepEqual(await page.evaluate(() => window.vibrations.at(-1)), 8);
      assert.equal(await value(page, spell), 'eq');
      const pRect = await page.locator('#h5-learn-keys button[data-char="p"]').evaluate(el => { const r = el.getBoundingClientRect(); return { right: r.right }; });
      await page.locator('#h5-learn-keys button[data-char="p"]').dispatchEvent('pointerdown', { button: 0, pointerId: 4, pointerType: 'touch', isPrimary: true });
      const right = await rect(page, '.h5-key-bubble');
      assert.ok(right.x + right.w <= keysRect.x + keysRect.w + 1 && right.x + right.w >= pRect.right - 30, 'clamped inside the keyboard at the right edge');
      await page.locator('#h5-learn-keys button[data-char="p"]').dispatchEvent('pointercancel', { button: 0, pointerId: 4, pointerType: 'touch', isPrimary: true });
      await page.locator('.h5-key-bubble').waitFor({ state: 'hidden' });
      // No bubble for Backspace; a held Backspace ticks once, not on each repeat.
      const ticks = await page.evaluate(() => window.vibrations.length);
      const back = page.locator('#h5-learn-keys button[data-key="Backspace"]');
      await back.dispatchEvent('pointerdown', { button: 0, pointerId: 5, pointerType: 'touch', isPrimary: true });
      await page.waitForTimeout(650);
      assert.equal(await page.locator('.h5-key-bubble').isVisible(), false, 'no bubble for Backspace');
      await back.dispatchEvent('pointerup', { button: 0, pointerId: 5, pointerType: 'touch', isPrimary: true });
      assert.equal(await page.evaluate(() => window.vibrations.length), ticks + 1, 'a held Backspace ticks once');
      assert.equal(await value(page, spell), '');
      assert.equal(await active(page), 'h5-learn-spell-input', 'the keys never take the focus');
      // Auto-check at the last letter: a short answer waits; Backspace in the pause cancels; the last letter checks by itself after a moment.
      await tapKeys(page, 'expir');
      await page.waitForTimeout(500);
      assert.equal(await page.locator('#h5-learn-feedback').count(), 0, 'a shorter answer waits for Check');
      await tapKeys(page, 'e{Backspace}');
      await page.waitForTimeout(500);
      assert.equal(await page.locator('#h5-learn-feedback').count(), 0, 'Backspace in the pause cancels the check');
      assert.equal(await value(page, spell), 'expir');
      const spokenBefore = (await spokenOf('expire')).length;
      await tapKeys(page, 'e');
      assert.equal(await page.locator('#h5-learn-feedback').count(), 0, 'the last letter is seen first');
      await page.locator('#h5-learn-feedback[data-correct="true"]').waitFor({ timeout: 2000 });
      assert.equal(mock.posts(/\/answer$/).length, 0, 'checked, not graded: the grade is still the person\'s');
      assert.equal(await text(page, '#h5-learn-feedback-phonetic'), '/ɪkˈspaɪər/', 'the transcription with the word after the answer');
      await waitFor(async () => (await spokenOf('expire')).length === spokenBefore + 1, 'the word plays once more after the answer');
      await page.waitForTimeout(1300);
      assert.equal((await spokenOf('expire')).length, spokenBefore + 1, 'once, not repeated');
      await shot(page, 'learn-phone-spell-answer.png');
      await page.locator('#h5-learn-grade-good').tap();
      await waitFor(() => mock.posts(/\/answer$/).length === 1, 'the grade');
      // Leaving the card cancels its audio: the next word plays, never the last one over it.
      await page.locator('#h5-learn-letters, .h5-learn-letters').first().waitFor();
      await page.locator('#h5-learn-back').tap();
      await page.locator('#h5-learn-mode').waitFor({ state: 'hidden' });

      // Fill the gap: the sentence plays after the answer by default, never before (it would give the answer away).
      const sentence = SENTENCES[0].en;
      const { gapFor } = await import(path.join(root, 'scripts/h5-shell/learn-model.mjs'));
      await page.locator('#h5-learn-mode-fill').tap();
      await page.locator('#h5-learn-gap-input').waitFor();
      await page.waitForTimeout(600);
      assert.equal((await spokenOf(sentence)).length, 0, 'Fill the gap: nothing before the answer');
      const gapWord = gapFor(SENTENCES[0]).word;
      await tapKeys(page, gapWord.slice(0, -1));
      await page.waitForTimeout(450);
      assert.equal(await page.locator('#h5-learn-feedback').count(), 0);
      await tapKeys(page, gapWord.slice(-1));
      await page.locator('#h5-learn-feedback[data-correct="true"]').waitFor({ timeout: 2000 });
      await waitFor(async () => (await spokenOf(sentence)).length === 1, 'the sentence plays after the answer');
      await page.locator('#h5-learn-back').tap();
      await page.locator('#h5-learn-mode').waitFor({ state: 'hidden' });

      // Learn settings → Audio: each choice is saved at once.
      await page.locator('#h5-learn-settings').tap();
      await page.locator('#h5-learn-audio-card').waitFor();
      assert.equal(await page.locator('#h5-learn-audio-repeat button[data-value="2"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#h5-learn-audio-pause button[data-value="1"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#h5-learn-audio-when button[data-value="after"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#h5-learn-audio-speed button[data-value="normal"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#h5-learn-audio-words').isChecked(), true);
      assert.equal(await page.locator('#h5-learn-audio-stop').isChecked(), true);
      await shot(page, 'learn-phone-audio-settings.png');
      await page.locator('#h5-learn-audio-stop').scrollIntoViewIfNeeded();
      await shot(page, 'learn-phone-audio-settings-2.png');
      await page.locator('#h5-learn-audio-repeat button[data-value="3"]').tap();
      await waitFor(() => mock.posts(/\/settings$/).some(item => item.body.audio_repeat === 3), 'repeat saved');
      await page.locator('#h5-learn-audio-when button[data-value="start"]').tap();
      await waitFor(() => mock.posts(/\/settings$/).some(item => item.body.audio_sentences_at === 'start'), 'when saved');
      await page.locator('#h5-learn-audio-speed button[data-value="slow"]').tap();
      await waitFor(() => mock.posts(/\/settings$/).some(item => item.body.audio_speed === 'slow'), 'speed saved');
      await page.locator('#h5-learn-audio-words').tap();
      await waitFor(() => mock.posts(/\/settings$/).some(item => item.body.audio_words === false), 'words switch saved');
      await page.locator('#h5-learn-audio-sentences').tap();
      await waitFor(async () => await page.locator('#h5-learn-audio-when button[data-value="start"]').isDisabled(), 'the choice is off with the sentences');
      await page.locator('#h5-learn-audio-sentences').tap();
      await page.locator('#h5-learn-back').tap();
      await page.locator('#h5-learn-mode').waitFor({ state: 'hidden' });
      // "When the card appears" and Slow: Fill the gap now plays at the start, slowly.
      await page.locator('#h5-learn-mode-fill').tap();
      await page.locator('#h5-learn-gap-input').waitFor();
      await waitFor(async () => (await spokenOf(sentence)).length === 2, 'Fill the gap plays at the start when chosen');
      assert.equal(await page.evaluate(() => window.spoken.at(-1).rate), 0.65, 'slow');
      await page.locator('#h5-learn-back').tap();
      await page.locator('#h5-learn-mode').waitFor({ state: 'hidden' });

      // A 16-letter word stays on one line at 390px (the slots shrink); at 320px it wraps into two even rows.
      mock.spellCards = [card(7, 'word', 'responsibilities', ZH_EXPIRE, 'lookup', { phonetic: '/rɪˌspɑnsəˈbɪlətiz/' })];
      await page.locator('#h5-learn-mode-spell').tap();
      await page.locator('.h5-learn-letter').first().waitFor();
      await page.waitForTimeout(200);
      const tops = async () => page.locator('.h5-learn-letter').evaluateAll(list => [...new Set(list.map(el => Math.round(el.getBoundingClientRect().top)))]);
      assert.equal((await tops()).length, 1, 'one line at 390px');
      const slots = await page.locator('.h5-learn-letter').evaluateAll(list => list.map(el => el.getBoundingClientRect()));
      assert.ok(slots[0].width >= 18 && slots.at(-1).right <= 390 - 16 + 1 && slots[0].left >= 16 - 1, `inside the page (${slots[0].width})`);
      await shot(page, 'learn-phone-spell-long-390.png');
      await page.setViewportSize({ width: 320, height: 700 });
      await page.waitForTimeout(300);
      const rows320 = await page.locator('.h5-learn-letter-row').evaluateAll(list => list.map(row => row.children.length));
      assert.deepEqual(rows320, [8, 8], 'two even rows at 320px');
      const width320 = await page.locator('.h5-learn-letter').evaluateAll(list => Math.max(...list.map(el => el.getBoundingClientRect().right)));
      assert.ok(width320 <= 320 - 16 + 1, 'inside the page at 320px');
      await shot(page, 'learn-phone-spell-long-320.png');
      // Wrong with an extra and a missing letter: 17 columns for the 16 letters, wrapped as two pairs of rows that keep the columns.
      await tapKeys(page, 'responsibbilitie');
      await page.locator('#h5-learn-feedback[data-correct="false"]').waitFor({ timeout: 2000 });
      const longRows = await spellRows(page);
      assert.equal(longRows.pairs, 2, 'two pairs of rows at 320px');
      assert.equal(longRows.want.text, 'responsib_ilities');
      assert.equal(longRows.got.text, 'responsibbilitie_');
      assert.equal(longRows.want.kinds, 'sssssssssessssssm');
      assert.deepEqual(longRows.want.lefts, longRows.got.lefts, 'the columns stay aligned across the wrap');
      assert.equal(longRows.note, '1 extra letter, 1 missing');
      assert.equal(longRows.want.lines[9].split(' ')[0], 'dashed', 'an empty dashed slot above the extra letter');
      assert.equal(longRows.got.lines[16].split(' ')[0], 'dashed', 'an empty dashed slot for the missing letter');
      assert.notEqual(longRows.got.lines[16], longRows.want.lines[9], 'the missing slot in red, the extra one quiet');
      const widthPairs = await page.locator('.h5-learn-letter').evaluateAll(list => Math.max(...list.map(el => el.getBoundingClientRect().right)));
      assert.ok(widthPairs <= 320 - 16 + 1, 'the pairs stay inside the page at 320px');
      await shot(page, 'learn-phone-spell-wrong-long-320.png');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('#h5-learn-back').tap();
      await page.locator('#h5-learn-mode').waitFor({ state: 'hidden' });
      // A missing letter at 390px: its own empty column, the rest of the word stays green.
      mock.spellCards = [card(8, 'word', 'environment', ZH_EXPIRE, 'lookup', { phonetic: '/\u026an\u02c8va\u026ar\u0259nm\u0259nt/' })];
      await page.locator('#h5-learn-mode-spell').tap();
      await page.locator('.h5-learn-letter').first().waitFor();
      await tapKeys(page, 'enviroment');
      await page.locator('#h5-learn-check').tap();
      await page.locator('#h5-learn-feedback[data-correct="false"]').waitFor();
      const missingRows = await spellRows(page);
      assert.equal(missingRows.pairs, 1, 'one pair of rows at 390px');
      assert.equal(missingRows.want.text, 'environment');
      assert.equal(missingRows.got.text, 'enviro_ment');
      assert.equal(missingRows.got.kinds, 'ssssssmssss', 'one missing letter does not turn the rest red');
      assert.deepEqual(missingRows.want.lefts, missingRows.got.lefts);
      assert.equal(missingRows.note, '1 letter missing');
      assert.match(await text(page, '#h5-learn-feedback'), /environment.*You wrote: enviroment.*10 of 11 letters right/, 'counted as the rows show, not by position');
      assert.equal(await page.locator('.h5-learn-letter-want').first().getAttribute('aria-hidden'), 'true', 'the rows are hidden from screen readers; the card says it');
      await shot(page, 'learn-phone-spell-wrong-390.png');
      await page.locator('#h5-learn-back').tap();
      await page.locator('#h5-learn-mode').waitFor({ state: 'hidden' });
      await context.close();
    }
    // ── A browser that refuses sound before the first tap: "Tap to play" once ──
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 390, height: 844 }, touch: true });
      mock.translator = true;
      await toTerminal(page);
      await page.evaluate(() => { window.refuseSpeech = true; });
      await bnavTap(page, '#h5-bnav-learn');
      await page.locator('#h5-learn-mode-spell').tap();
      await page.locator('#h5-learn-tap-play').waitFor({ timeout: 4000 });
      assert.equal(await page.locator('#h5-learn-hear').count(), 0);
      await page.evaluate(() => { window.refuseSpeech = false; });
      await page.locator('#h5-learn-tap-play').tap();
      await page.locator('#h5-learn-hear[data-playing="true"]').waitFor();
      await context.close();
    }
    // ── A computer: the hardware keyboard checks by itself at the last letter too; Backspace in the pause cancels ──
    {
      const { context, page } = await openPage(browser, { viewport: { width: 1440, height: 900 } });
      await page.locator('#h5-nav-learn').click();
      await page.locator('#h5-learn-mode-spell').click();
      await page.locator('#h5-learn-meaning').waitFor();
      await page.locator('.h5-learn-letters').click();
      await page.keyboard.type('expire');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(500);
      assert.equal(await page.locator('#h5-learn-feedback').count(), 0, 'Backspace in the pause cancels');
      await page.keyboard.type('a');
      await page.locator('#h5-learn-feedback[data-correct="false"]').waitFor({ timeout: 2000 });
      assert.match(await text(page, '#h5-learn-feedback'), /You wrote: expira/);
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const errors = pageErrors.filter(message => !/ResizeObserver loop/.test(message));
  assert.deepEqual(errors, [], 'no page errors');
  console.log('Learn page browser test passed');
})().catch(error => { console.error(error); process.exit(1); });
