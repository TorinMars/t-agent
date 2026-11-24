// Learn: "Type it yourself" after every Spell answer and English input while spelling (scripts/h5-shell/Learn.jsx, learn-practice.mjs,
// learn-input.mjs), in real Chromium with every route mocked. No model is ever called. See "Type it yourself" and "English input" in
// docs/design/learn-spell-practice.md. Learn is the coach (GET /api/learn/coach answers): Spell and Review are opened the way the coach opens them,
// ui.actions.openLearn(name).
// - 390x844 (touch, the page's letter keyboard): the row after a right answer (meaning layout), a wrong one, "I don't know" in the sentence layout and
//   a phrase; the focus in the row with inputmode="none" and the keyboard open; a right letter kept, a wrong key shown in its slot in the error
//   colour and not kept, "Not that letter", Backspace, the word typed in full counted ("Typed right 1 time", read out politely) and the row empty
//   again; nothing sent while practising; the grades tapped; the row above the keyboard; no sideways scroll.
// - 1440x900 (mouse and keys): the row between the result and the grades with "Enter takes Good \u00b7 1 2 3 grade", letters typed there never grade, 2
//   grades Hard, Enter takes the offered grade, Review uses the row; an input method simulated with CDP (Input.imeSetComposition / insertText: the
//   pinyin letters count, the Chinese it commits is dropped) and with dispatched composition events (WeType-like: Chinese shown at once, the keys'
//   letters count), in the answer field and in the row; the notice once per Learn session with OK; the Mac app's `tagentInputSource` stubbed:
//   'english' on the focus, no switch between the answer and the row, 'restore' on blur and when Learn closes, and no notice in the app.
// H5_SHOT_DIR=<dir> saves learn-practice-phone.png, learn-practice-wrong-key.png, learn-practice-desktop.png and learn-practice-ime.png.
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
const AT = '2026-11-20T08:00:00.000Z';

const TASKS = [{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }];
const TERMINALS = { 1: [{ terminal_id: 'c1', title: 'Claude: login fix', agent: 'claude' }] };
// The Chinese of the cards and of the input method is user content (escaped: Chinese is allowed only in the dictionaries and CJK fixtures).
const ZH = '\u5fc5\u8981\u7684';
const ZH_SENTENCE = '\u4f1a\u8bdd cookie \u4e09\u5341\u5206\u949f\u540e\u8fc7\u671f\u3002';
const NE = '\u5462';
const SENTENCE = 'The session cookie expires after thirty minutes.';
const card = (id, en, extra = {}) => ({
  id, kind: 'word', en, zh: ZH, source: 'starter', context: 'Programmer English', context_zh: '', phonetic: '', due_at: AT, interval_days: 0, ease: 2.5, reps: 0,
  lapses: 0, last_result: null, last_at: null, suspended: false, created_at: AT, ...extra,
});
const NECESSARY = card(1, 'necessary');
const INCIDENT = card(2, 'incident');
const EXPIRES = card(3, 'expires', { source: 'translation', context: SENTENCE, context_zh: ZH_SENTENCE });
const LOOK_UP = card(4, 'look up');
const LATENCY = card(5, 'latency');
const MERGE = card(6, 'merge');
const SUMMARY = { due: 4, new_today: 1, done_today: 3, goal: 20, streak: 2, words: 60, sentences: 10, mistakes: 0, collecting: true, starter: 'dev' };
const pageErrors = [];

function learnMock(spell) {
  const mock = { spell, review: [INCIDENT], requests: [] };
  mock.handle = (p, method, url, body) => {
    mock.requests.push({ method, path: p, search: url.search, body });
    if (p === '/api/learn/summary') return SUMMARY;
    if (p === '/api/learn/settings') return { collect: true, daily_goal: 20, starter: 'dev', analysis_auto: true, report_lang: 'en', audio_words: 'off', audio_sentences: 'off' };
    if (p === '/api/learn/queue') {
      const mode = url.searchParams.get('mode');
      if (mode === 'spell') return { cards: mock.spell };
      if (mode === 'review') return { cards: mock.review };
      return { cards: [] };
    }
    if (/^\/api\/learn\/cards\/\d+\/answer$/.test(p)) return { card: { ...NECESSARY, reps: 1 } };
    // The coach: Learn is only her, and the screens open from her.
    if (p === '/api/learn/coach' && method === 'GET') return { messages: [], has_more: false, tools_ok: true, translator: true, settings: { memory: true, read_answers: true, read_text: true, economy: false } };
    return [404, { error: 'not mocked' }];
  };
  mock.answers = () => mock.requests.filter(item => item.method === 'POST' && /\/answer$/.test(item.path)).map(item => ({ id: item.path.match(/cards\/(\d+)/)[1], ...item.body }));
  return mock;
}

async function openPage(browser, { viewport, touch = false, spell, app = false }) {
  const context = await browser.newContext({ viewport, timezoneId: 'Asia/Taipei', ...(touch ? { isMobile: true, hasTouch: true } : {}), ...(SHOTS ? { deviceScaleFactor: 3 } : {}) });
  const page = await context.newPage();
  const mock = learnMock(spell);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(inApp => {
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
    // The Mac app's script message handlers (MainWindow.swift): the input source switch is recorded.
    window.inputSourceCalls = [];
    if (inApp) window.webkit = { messageHandlers: { tagentInputSource: { postMessage: what => window.inputSourceCalls.push(what) } } };
  }, app);
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
const active = page => page.evaluate(() => document.activeElement && document.activeElement.id);
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(300); await page.screenshot({ path: path.join(SHOTS, name) }); } };
const waitFor = async (check, message, timeout = 5000) => {
  const end = Date.now() + timeout;
  for (;;) { if (await check()) return; if (Date.now() > end) throw new Error(`timed out: ${message}`); await new Promise(resolve => setTimeout(resolve, 50)); }
};
// The practice slots: their letters ('_' for an empty one) and kinds (first letter: k kept, f flash, c caret, e empty, a auto).
const slots = page => page.evaluate(() => {
  const list = [...document.querySelectorAll('.h5-learn-practice-slot')];
  return { letters: list.map(el => el.textContent || '_').join(''), kinds: list.map(el => el.dataset.kind[0]).join('') };
});
const answerLetters = page => page.evaluate(() => [...document.querySelectorAll('.h5-learn-letters .h5-learn-letter')].map(el => el.textContent || '_').join(''));
async function tapKeys(page, keys) {
  for (const key of keys.match(/\{\w+\}|./g)) {
    const name = /^\{(\w+)\}$/.exec(key);
    await page.locator(name ? `#h5-learn-keys button[data-key="${name[1]}"]` : `#h5-learn-keys button[data-char="${key}"]`).tap();
  }
}
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
// The row is there with the focus and empty slots.
async function rowReady(page, word) {
  await page.locator('.h5-learn-practice').waitFor();
  await waitFor(async () => (await active(page)) === 'h5-learn-practice-input', 'the focus goes to the row at once');
  assert.equal(await page.locator('.h5-learn-practice').getAttribute('aria-label'), 'Type the word yourself');
  assert.equal(await page.locator('#h5-learn-practice-input').getAttribute('aria-label'), 'Type the word yourself');
  assert.equal(await page.locator('#h5-learn-practice-count').getAttribute('aria-live'), 'polite');
  assert.equal((await slots(page)).letters.length, word.length);
}
// An input method's composition through CDP (Chromium's own IME path): each text as the marked text, then the committed text.
async function compose(cdp, steps, commit) {
  for (const step of steps) await cdp.send('Input.imeSetComposition', { text: step, selectionStart: step.length, selectionEnd: step.length });
  await cdp.send('Input.insertText', { text: commit });
}
// A WeType-like input method that shows Chinese at once: a "Process" key with the letter's code, then a composition whose text is Chinese.
const weType = (page, selector, letter) => page.locator(selector).evaluate((el, [code, zh]) => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', code, bubbles: true }));
  el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
  el.dispatchEvent(new CompositionEvent('compositionupdate', { data: zh, bubbles: true }));
  el.dispatchEvent(new CompositionEvent('compositionend', { data: zh, bubbles: true }));
}, [`Key${letter.toUpperCase()}`, NE]);

// A screen of Learn opened the way the coach opens it (her buttons, the links /h5?learn=<name>).
const openScreen = (page, name) => page.evaluate(view => window.H5UI.actions.openLearn(view), name);

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    // \u2500\u2500 390x844 (touch): the page's letter keyboard types into the row \u2500\u2500
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 390, height: 844 }, touch: true, spell: [NECESSARY, INCIDENT, EXPIRES, LOOK_UP] });
      await toTerminal(page);
      await bnavTap(page, '#h5-bnav-learn');
      await page.locator('[data-coach="only"] #h5-learn-coach').waitFor();
      await openScreen(page, 'spell');
      await page.locator('#h5-learn-keys[data-kind="letters"]').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.h5-learn-practice').count(), 0, 'no row before the answer');
      // Compact practice on a phone with the letter keyboard open: the header on one line (56px), the four rows of the letter keyboard with its Hide key, and
      // the page's content area (above the pinned actions) at least 38% of the screen.
      const layout = await page.evaluate(() => {
        const scroll = document.querySelector('#h5-learn-mode .h5-learn-scroll');
        const footer = scroll.querySelector('.h5-learn-footer');
        return {
          area: scroll.clientHeight - (footer ? footer.offsetHeight : 0),
          bar: document.querySelector('#h5-learn-mode header').getBoundingClientRect().height,
          rows: document.querySelectorAll('#h5-learn-keys .h5-osk-row').length,
          key: document.querySelector('#h5-learn-keys button[data-char="q"]').getBoundingClientRect().height,
          hide: Boolean(document.querySelector('#h5-learn-keys [data-key="Hide"]')),
        };
      });
      assert.ok(layout.area >= 0.38 * 844, `the content area is at least 38% of the screen (${layout.area}px)`);
      assert.ok(layout.bar <= 57, `the header is one line (${layout.bar}px)`);
      assert.equal(layout.rows, 4, 'the four letter rows');
      assert.ok(layout.hide, 'the keyboard has its Hide key');
      await shot(page, 'learn-practice-compact.png');
      // A right answer (the meaning layout): the row under the result, the focus in it, the page keyboard still open, no system keyboard.
      await tapKeys(page, 'necessary');
      await page.locator('#h5-learn-feedback[data-correct="true"]').waitFor();
      await rowReady(page, 'necessary');
      assert.equal(await page.locator('#h5-learn-practice-input').getAttribute('inputmode'), 'none');
      assert.equal(await page.locator('#h5-learn-keys').isVisible(), true, 'the letter keyboard stays open for the row');
      assert.equal(await text(page, '.h5-learn-practice p'), 'Type it yourself');
      assert.equal(await text(page, '#h5-learn-practice-note'), 'Practice only, not graded', 'no keys on a phone');
      assert.equal(await text(page, '#h5-learn-practice-count'), '');
      assert.deepEqual(await slots(page), { letters: '_________', kinds: 'ceeeeeeee' });
      await page.waitForTimeout(200);
      const row = await page.locator('.h5-learn-practice').boundingBox();
      const keysBox = await page.locator('#h5-learn-keys').boundingBox();
      const footer = await page.locator('.h5-learn-footer').boundingBox();
      assert.ok(row.y + row.height <= keysBox.y + 1, `the row is above the keyboard (${row.y + row.height} / ${keysBox.y})`);
      assert.ok(row.y + row.height <= footer.y + 1, `the row is in sight above the pinned grades (${row.y + row.height} / ${footer.y})`);
      const feedback = await page.locator('#h5-learn-feedback > [role="status"]').boundingBox();
      assert.ok(row.y >= feedback.y + feedback.height, 'the row under the result');
      const slot = await page.locator('.h5-learn-practice-slot').first().boundingBox();
      const answerSlot = await page.locator('.h5-learn-letters .h5-learn-letter').first().boundingBox();
      assert.ok(Math.abs(slot.width - answerSlot.width) <= 6, `the same slot sizing as the answer (${slot.width} / ${answerSlot.width})`);
      // A right letter stays (success); a wrong key shows in its slot in the error colour and is not kept.
      await tapKeys(page, 'nec');
      assert.deepEqual(await slots(page), { letters: 'nec______', kinds: 'kkkceeeee' });
      assert.equal(await page.locator('#h5-learn-practice-input').inputValue(), 'nec');
      await tapKeys(page, 'a');
      assert.deepEqual(await slots(page), { letters: 'neca_____', kinds: 'kkkfeeeee' });
      assert.equal(await page.locator('#h5-learn-practice-input').inputValue(), 'nec', 'the wrong key is not kept');
      assert.equal(await text(page, '#h5-learn-practice-note'), 'Not that letter');
      const flash = await color(page, '.h5-learn-practice-slot[data-kind="flash"]');
      const kept = await color(page, '.h5-learn-practice-slot[data-kind="kept"]');
      assert.equal(await color(page, '#h5-learn-practice-note'), flash, 'the note in the error colour');
      assert.notEqual(flash, kept);
      assert.equal(kept, await color(page, '.h5-learn-letters .h5-learn-letter'), 'kept letters in the success colour of a right answer');
      await shot(page, 'learn-practice-wrong-key.png');
      await waitFor(async () => (await slots(page)).kinds === 'kkkceeeee', 'the wrong key goes after a moment', 1500);
      // Backspace takes the last kept letter back; the word typed in full is counted, then the row empties for another round.
      await tapKeys(page, '{Backspace}');
      assert.equal((await slots(page)).letters, 'ne_______');
      await tapKeys(page, 'cessary');
      assert.deepEqual(await slots(page), { letters: 'necessary', kinds: 'kkkkkkkkk' });
      assert.equal(await text(page, '#h5-learn-practice-count'), 'Typed right 1 time');
      assert.equal(await page.locator('#h5-learn-practice-count').getAttribute('role'), 'status');
      assert.equal(await color(page, '#h5-learn-practice-count'), kept, 'the count in the success colour just after a round');
      assert.equal(await text(page, '#h5-learn-practice-note'), 'Again? Just keep typing');
      await shot(page, 'learn-practice-phone.png');
      await waitFor(async () => (await slots(page)).letters === '_________', 'the row empties for another round', 1500);
      await tapKeys(page, 'necessary');
      assert.equal(await text(page, '#h5-learn-practice-count'), 'Typed right 2 times');
      assert.deepEqual(mock.answers(), [], 'practice sends nothing');
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('#h5-learn-mode .h5-learn-scroll, #h5-learn-mode .MuiCard-root')].every(el => el.scrollWidth <= el.clientWidth + 1)), true, 'no sideways scroll');
      await page.locator('#h5-learn-grade-good').tap();
      await waitFor(() => mock.answers().length === 1, 'graded with a tap');
      assert.deepEqual(mock.answers()[0], { id: '1', mode: 'spell', grade: 'good', correct: true, answer: 'necessary' });
      // A wrong answer: the two rows as today, then the row of the right word.
      await page.locator('#h5-learn-spell-input').waitFor();
      await tapKeys(page, 'insident');
      await page.locator('#h5-learn-feedback[data-correct="false"]').waitFor();
      await rowReady(page, 'incident');
      await tapKeys(page, 'ins');
      assert.equal((await slots(page)).kinds.slice(0, 3), 'kkf');
      await tapKeys(page, 'cident');
      assert.equal(await text(page, '#h5-learn-practice-count'), 'Typed right 1 time', 'a new card starts at zero');
      await page.locator('#h5-learn-grade-again').tap();
      await waitFor(() => mock.answers().length === 2, 'graded');
      assert.equal(mock.answers()[1].grade, 'again');
      // I don't know, in the sentence layout: the row under the result.
      await page.locator('#h5-learn-sentence').waitFor();
      await page.locator('#h5-learn-dont-know').tap();
      await page.locator('#h5-learn-sentence-word').waitFor();
      await rowReady(page, 'expires');
      const result = await page.locator('#h5-learn-feedback').boundingBox();
      assert.ok((await page.locator('.h5-learn-practice').boundingBox()).y >= result.y + result.height, 'under the result');
      await tapKeys(page, 'expires');
      assert.equal(await text(page, '#h5-learn-practice-count'), 'Typed right 1 time');
      await page.locator('#h5-learn-grade-again').tap();
      await waitFor(() => mock.answers().length === 3, 'graded');
      // A phrase: its space fills in by itself (the letter keyboard has no Space).
      await page.locator('#h5-learn-spell-input').waitFor();
      await page.locator('#h5-learn-dont-know').tap();
      await rowReady(page, 'look up');
      await tapKeys(page, 'look');
      assert.deepEqual(await slots(page), { letters: 'look___', kinds: 'kkkkace' });
      await tapKeys(page, 'up');
      assert.equal(await text(page, '#h5-learn-practice-count'), 'Typed right 1 time');
      assert.equal(mock.answers().length, 3, 'still nothing sent by the practice');
      await context.close();
    }

    // \u2500\u2500 1440x900: keys, grades, input methods and the notice \u2500\u2500
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 1440, height: 900 }, spell: [NECESSARY, INCIDENT, LATENCY, MERGE] });
      const cdp = await context.newCDPSession(page);
      await page.locator('#h5-nav-learn').click();
      await page.locator('[data-coach="only"] #h5-learn-coach').waitFor();
      await openScreen(page, 'spell');
      await page.locator('#h5-learn-spell-input').waitFor();
      await waitFor(async () => (await active(page)) === 'h5-learn-spell-input', 'the answer field has the focus');
      await page.keyboard.type('necessary');
      await page.locator('#h5-learn-feedback[data-correct="true"]').waitFor();
      await rowReady(page, 'necessary');
      assert.equal(await page.locator('#h5-learn-keys').count(), 0, 'no page keyboard on a computer');
      assert.equal(await text(page, '#h5-learn-practice-note'), 'Practice only, not graded \u00b7 Enter takes Good \u00b7 1 2 3 grade');
      assert.equal(await page.locator('#h5-learn-practice-note kbd').count(), 4);
      // Frame 4: the row between the result and the grades.
      const status = await page.locator('#h5-learn-feedback > [role="status"]').boundingBox();
      const row = await page.locator('.h5-learn-practice').boundingBox();
      const grades = await page.locator('#h5-learn-feedback .h5-learn-grades').boundingBox();
      assert.ok(row.y >= status.y + status.height && grades.y >= row.y + row.height, 'result, row, grades');
      assert.match(await page.locator('#h5-learn-grade-good').getAttribute('class'), /MuiButton-contained/, 'the offered grade stays marked');
      // Letters typed in the row never grade (not even the letters of a grade's name); a wrong key flashes.
      await page.keyboard.type('nec');
      await page.keyboard.type('x');
      assert.equal((await slots(page)).kinds.slice(0, 4), 'kkkf');
      await page.keyboard.type('essary');
      assert.equal(await text(page, '#h5-learn-practice-count'), 'Typed right 1 time');
      await page.keyboard.type('gha');
      assert.deepEqual(mock.answers(), [], 'letters in the row are nothing to the grades');
      await shot(page, 'learn-practice-desktop.png');
      // 2 in the row grades Hard.
      await page.keyboard.press('2');
      await waitFor(() => mock.answers().length === 1, 'graded with 2');
      assert.equal(mock.answers()[0].grade, 'hard');
      // A wrong answer: Enter in the row takes the offered grade (Again).
      await page.locator('#h5-learn-spell-input').waitFor();
      await waitFor(async () => (await active(page)) === 'h5-learn-spell-input', 'the next card has the focus');
      await page.keyboard.type('insidant');
      await page.locator('#h5-learn-feedback[data-correct="false"]').waitFor();
      await rowReady(page, 'incident');
      await page.keyboard.type('inc');
      await page.keyboard.press('Enter');
      await waitFor(() => mock.answers().length === 2, 'graded with Enter');
      assert.equal(mock.answers()[1].grade, 'again');
      assert.equal(mock.answers()[1].answer, 'insidant', 'the answer, not the practice');
      // An input method composes (macOS Pinyin / Sogou through Chromium's IME path): the letters count, the Chinese it commits is dropped.
      await page.locator('#h5-learn-spell-input').waitFor();
      await waitFor(async () => (await active(page)) === 'h5-learn-spell-input', 'the next card has the focus');
      assert.equal(await page.locator('#h5-learn-ime-notice').count(), 0, 'no notice before an input method is seen');
      await compose(cdp, ['l', 'la', 'lat'], NE);
      await waitFor(async () => (await answerLetters(page)) === 'lat____', 'the pinyin letters count');
      assert.equal(await page.locator('#h5-learn-spell-input').inputValue(), 'lat', 'the Chinese is dropped');
      await page.locator('#h5-learn-ime-notice').waitFor();
      assert.equal(await page.locator('#h5-learn-ime-notice').getAttribute('role'), 'status');
      assert.equal(await text(page, '#h5-learn-ime-notice .MuiAlert-message'), 'Chinese input is on. Your letters still count; to switch, press Ctrl+Space (on a Mac Caps Lock or Ctrl+Space).');
      const notice = await page.locator('#h5-learn-ime-notice').boundingBox();
      assert.ok(notice.y + notice.height <= (await page.locator('.h5-learn-letters').boundingBox()).y, 'the notice above the letters');
      await shot(page, 'learn-practice-ime.png');
      // Enter commits the letters themselves; the rest typed as usual checks by itself.
      await compose(cdp, ['e', 'en'], 'en');
      assert.equal(await page.locator('#h5-learn-spell-input').inputValue(), 'laten');
      await page.keyboard.type('cy');
      await page.locator('#h5-learn-feedback[data-correct="true"]').waitFor();
      await rowReady(page, 'latency');
      // In the row: composed letters are keys, a wrong one flashes and is not kept, the committed Chinese is dropped.
      await compose(cdp, ['l', 'la', 'lax'], NE);
      await waitFor(async () => (await slots(page)).letters.startsWith('lax'), 'the composed letters in the row, the wrong x flashing');
      assert.equal(await page.locator('#h5-learn-practice-input').inputValue(), 'la');
      await compose(cdp, ['t', 'te', 'ten', 'tenc', 'tency'], NE);
      await waitFor(async () => (await text(page, '#h5-learn-practice-count')) === 'Typed right 1 time', 'the word typed through the input method');
      assert.deepEqual(mock.answers().length, 2, 'nothing sent');
      // OK hides the notice for the rest of this Learn session.
      await page.locator('#h5-learn-ime-ok').click();
      await page.locator('#h5-learn-ime-notice').waitFor({ state: 'detached' });
      assert.equal(await active(page), 'h5-learn-practice-input', 'OK keeps the focus in the row');
      await page.keyboard.press('Enter');
      await waitFor(() => mock.answers().length === 3, 'graded');
      assert.equal(mock.answers()[2].answer, 'latency');
      // WeType-like: the input method shows Chinese at once; the letters of the keys pressed count. No notice again.
      await page.locator('#h5-learn-spell-input').waitFor();
      await waitFor(async () => (await active(page)) === 'h5-learn-spell-input', 'the next card has the focus');
      await weType(page, '#h5-learn-spell-input', 'm');
      await weType(page, '#h5-learn-spell-input', 'e');
      await waitFor(async () => (await page.locator('#h5-learn-spell-input').inputValue()) === 'me', 'the keys\' letters');
      assert.equal(await page.locator('#h5-learn-ime-notice').count(), 0, 'once per Learn session');
      await page.keyboard.type('rge');
      await page.locator('#h5-learn-feedback[data-correct="true"]').waitFor();
      await rowReady(page, 'merge');
      await weType(page, '#h5-learn-practice-input', 'm');
      await weType(page, '#h5-learn-practice-input', 'x');
      assert.deepEqual(await slots(page), { letters: 'mx___', kinds: 'kfeee' });
      await page.keyboard.press('3');
      await waitFor(() => mock.answers().length === 4, 'graded with 3');
      assert.equal(mock.answers()[3].grade, 'good');
      // Review uses the same exercise, so the same row.
      await openScreen(page, 'review');
      await page.locator('#h5-learn-spell-input').waitFor();
      await waitFor(async () => (await active(page)) === 'h5-learn-spell-input', 'the review card has the focus');
      await page.keyboard.type('incident');
      await rowReady(page, 'incident');
      assert.deepEqual(await page.evaluate(() => window.inputSourceCalls), [], 'nothing to switch outside the app');
      await context.close();
    }

    // \u2500\u2500 1440x900 in the Mac app (the tagentInputSource handler stubbed) \u2500\u2500
    {
      const { context, page } = await openPage(browser, { viewport: { width: 1440, height: 900 }, spell: [NECESSARY, INCIDENT], app: true });
      const cdp = await context.newCDPSession(page);
      const calls = () => page.evaluate(() => window.inputSourceCalls.slice());
      await page.locator('#h5-nav-learn').click();
      await page.locator('[data-coach="only"] #h5-learn-coach').waitFor();
      await openScreen(page, 'spell');
      await page.locator('#h5-learn-spell-input').waitFor();
      await waitFor(async () => (await calls()).length === 1, 'english on the focus');
      assert.deepEqual(await calls(), ['english']);
      // Leaving the field puts the person's input source back; the field again switches to English.
      await page.locator('#h5-learn-view-title').click();
      await waitFor(async () => (await calls()).length === 2, 'restore on blur');
      assert.deepEqual(await calls(), ['english', 'restore']);
      await page.locator('.h5-learn-letters').click();
      await waitFor(async () => (await calls()).length === 3, 'english again');
      // The answer field to the row: no switch in between. An input method in the app: no notice (the app switches).
      await compose(cdp, ['ne'], NE);
      await page.keyboard.type('cessary');
      await rowReady(page, 'necessary');
      await page.waitForTimeout(300);
      assert.deepEqual(await calls(), ['english', 'restore', 'english']);
      assert.equal(await page.locator('#h5-learn-ime-notice').count(), 0, 'no notice in the app');
      // Learn closes (the rail's Learn again, ui.actions.closeLearn) with the focus in the row: restore at once.
      await page.evaluate(() => window.H5UI.actions.closeLearn());
      await waitFor(async () => (await calls()).length === 4, 'restore when Learn closes');
      assert.deepEqual(await calls(), ['english', 'restore', 'english', 'restore']);
      await context.close();
    }

    assert.deepEqual(pageErrors, []);
    console.log('Learn practice browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
