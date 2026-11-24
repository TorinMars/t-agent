// Learn: "Ask about this question" (scripts/h5-shell/LearnAsk.jsx), in real Chromium with every route mocked; /api/learn/cards/:id/ask follows
// the contract of "Ask about this question" in docs/design/learn-english-page.md (GET: the card's stored messages and `translator`; POST: an NDJSON
// stream of `{"delta"}` lines and a last `{"done","messages"}` or `{"error","status"}` line, or plain JSON from a company computer). No model is
// ever called. A streamed answer the test feeds piece by piece goes through a fetch stand-in (Playwright routes cannot keep a response open).
// - 390x844 (touch): Spell inside its sentence: Ask at the end of the helper row; the bottom sheet (top at about 150px, title, caption, Close, the
//   hint chips, the earlier messages with `lang` and **bold**, the hints note); typing in the sheet never reaches the letters; a chip streams its
//   answer into a growing bubble, then the stored messages replace it; Close gives the focus back to the field. After Check: the caption with the
//   answer, "Why was my answer wrong?" first, a typed follow-up answered as JSON (company computer), an error mid-stream with Try again, and the
//   503 translator notice. A sentence in Review (Fill the gap, since Build the sentence is hidden): Ask in the card, the sentence chips.
// - 1440x900 (mouse): a sentence in Review (Fill the gap) with the 380px side panel next to the card (the card makes room and stays usable); Enter in the panel sends the
//   question and never checks the exercise; Escape closes the panel, not the mode, and the focus goes back to the answer field.
// Learn is the coach (GET /api/learn/coach answers): each practice is opened the way the coach opens it (ui.actions.openLearn(name), the same as
// her buttons and the links /h5?learn=<name>).
// H5_SHOT_DIR=<dir> saves learn-ask-sheet.png, learn-ask-checked.png and learn-ask-desktop.png.
const { chromium } = require('playwright');
// Opens a screen of Learn the way the coach does (her buttons, the links): ui.actions.openLearn(name).
const openScreen = (page, name) => page.evaluate(screen => window.H5UI.actions.openLearn(screen), name);
const COACH = '[data-coach="only"] #h5-learn-coach';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

process.env.T_AGENT_DATA_DIR = process.env.T_AGENT_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-learn-ask-browser-'));

const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const { bnavTap } = require('./h5-bottom-nav-tap.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const AT = '2026-11-20T08:00:00.000Z';

const TASKS = [{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }];
const TERMINALS = { 1: [{ terminal_id: 'c1', title: 'Claude: login fix', agent: 'claude' }] };
// Chinese user content, escaped (Chinese is allowed only in the dictionaries).
const ZH_EXPIRE = '\u8fc7\u671f\uff1b\u5230\u671f';
const ZH_SENTENCE = '\u4f1a\u8bdd cookie \u4e09\u5341\u5206\u949f\u540e\u8fc7\u671f\uff0c\u6240\u4ee5\u8bf7\u91cd\u65b0\u767b\u5f55\u3002';
const ZH_MERGE = '\u5982\u679c\u6d4b\u8bd5\u5931\u8d25\uff0c\u8bf7\u4e0d\u8981\u5408\u5e76\u8fd9\u4e2a\u5206\u652f\u3002';
const ZH_WHY_S = '\u4e3a\u4ec0\u4e48\u8fd9\u91cc\u8981\u52a0 s\uff1f';
const SENTENCE = 'The session cookie expires after thirty minutes, so please log in again.';
const MERGE = 'Please do not merge this branch if the tests fail.';
const card = (id, kind, en, zh, extra = {}) => ({
  id, kind, en, zh, source: 'translation', context: '', context_zh: '', phonetic: '', due_at: AT, interval_days: 0, ease: 2.5, reps: 0, lapses: 0, last_result: null, last_at: null, suspended: false, created_at: AT, ...extra,
});
const WORD = card(31, 'word', 'expires', ZH_EXPIRE, { context: SENTENCE, context_zh: ZH_SENTENCE });
const SENTENCE_CARD = card(40, 'sentence', MERGE, ZH_MERGE);
// `at` is an ISO time, as the server sends it; `n` seconds after the start.
const msg = (uid, role, text, n) => ({ uid, role, text, at: new Date(Date.parse(AT) + n * 1000).toISOString() });
const EARLIER = [msg('e1', 'user', ZH_WHY_S, 1), msg('e2', 'assistant', 'The subject is **the session cookie**: one thing,\npresent tense, so the verb takes **-s**.', 2)];
const SUMMARY = { due: 2, new_today: 0, done_today: 3, goal: 20, streak: 2, words: 1, sentences: 1, mistakes: 0, collecting: true, starter: null };
const pageErrors = [];

function learnMock() {
  const mock = { chats: { 31: EARLIER.slice(), 40: [] }, translator: true, askMode: 'stream', requests: [], seq: 10 };
  const stored = (id, question, answer) => {
    const out = [msg(`q${mock.seq}`, 'user', question, mock.seq), msg(`a${mock.seq}`, 'assistant', answer, mock.seq + 1)];
    mock.seq += 2;
    mock.chats[id] = [...(mock.chats[id] || []), ...out];
    return out;
  };
  mock.handle = (p, method, url, body) => {
    mock.requests.push({ method, path: p, body });
    if (p === '/api/learn/summary') return SUMMARY;
    if (p === '/api/learn/settings') return { collect: true, daily_goal: 20, starter: null, report_lang: 'en' };
    if (p === '/api/learn/queue') return { cards: url.searchParams.get('mode') === 'spell' ? [WORD] : [SENTENCE_CARD] };
    if (/^\/api\/learn\/cards\/\d+\/answer$/.test(p)) return { card: WORD };
    const ask = p.match(/^\/api\/learn\/cards\/(\d+)\/ask$/);
    if (ask && method === 'GET') {
      // A company computer whose home cannot answer (offline) or is too old (home_older).
      if (mock.away === 'offline') return { messages: [], translator: false, offline: true };
      if (mock.away === 'older') return { messages: [], translator: false, home_older: true };
      return { messages: mock.chats[ask[1]] || [], translator: mock.translator };
    }
    if (ask && method === 'POST') {
      if (mock.askMode === '503') return [503, { error: 'Translation service not configured yet' }];
      if (mock.askMode === '503-away') return [503, { error: 'Questions about a card are answered on a normal computer, which cannot be reached right now' }];
      // A model failure before its first piece of text: a plain JSON error, no stream.
      if (mock.askMode === '502') return [502, { error: 'The translation service rejected the key' }];
      if (mock.askMode === '429') return [429, { error: 'Too many questions in a minute. Wait a moment and ask again.' }];
      if (mock.askMode === 'json') return { messages: stored(ask[1], body.question, 'You swapped **r** and **e**.') };
      if (mock.askMode === 'error-mid') return { ndjson: [{ delta: 'Half an ans' }, { error: 'The translation service did not answer in time', status: 504 }] };
      const answer = 'Because the subject is singular.';
      return { ndjson: [{ delta: 'Because the ' }, { delta: 'subject is singular.' }, { done: true, messages: stored(ask[1], body.question, answer) }] };
    }
    if (p === '/api/learn/coach' && method === 'GET') return { messages: [], has_more: false, tools_ok: true, translator: true, settings: { memory: true, read_answers: true, read_text: true, economy: false } };
    return [404, { error: 'not mocked' }];
  };
  mock.asks = () => mock.requests.filter(item => item.method === 'POST' && /\/ask$/.test(item.path));
  mock.answers = () => mock.requests.filter(item => item.method === 'POST' && /\/answer$/.test(item.path));
  return mock;
}

// A fetch stand-in for the ask that the test feeds: `window.askFeed.manual = true`, then `askFeed.push(line)` and `askFeed.end()`.
function askFeedMock() {
  const encoder = new TextEncoder();
  const realFetch = window.fetch.bind(window);
  window.askFeed = { manual: false, bodies: [], controller: null, push(item) { this.controller.enqueue(encoder.encode(`${JSON.stringify(item)}\n`)); }, end() { this.controller.close(); } };
  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (window.askFeed.manual && /\/api\/learn\/cards\/\d+\/ask$/.test(url) && init.method === 'POST') {
      window.askFeed.bodies.push(JSON.parse(init.body));
      const body = new ReadableStream({ start(controller) { window.askFeed.controller = controller; } });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } }));
    }
    return realFetch(input, init);
  };
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
    // No speech output: the cards stay silent and Hear it is not drawn.
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: undefined });
  });
  await page.addInitScript(activityStreamMock);
  await page.addInitScript(askFeedMock);
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
      if (out && out.ndjson) return route.fulfill({ status: 200, contentType: 'application/x-ndjson; charset=utf-8', body: out.ndjson.map(item => `${JSON.stringify(item)}\n`).join('') });
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
const texts = (page, selector) => page.locator(selector).evaluateAll(list => list.map(el => el.textContent.replace(/\s+/g, ' ').trim()));
const active = page => page.evaluate(() => document.activeElement && document.activeElement.id);
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, name) }); } };
const bubbles = page => page.locator('#h5-learn-ask .h5-learn-ask-msg').evaluateAll(list => list.map(el => ({ role: el.dataset.role, text: el.textContent, lang: el.getAttribute('lang'), streaming: el.dataset.streaming === 'true' })));
const waitBubbles = (page, count) => page.waitForFunction(n => document.querySelectorAll('#h5-learn-ask .h5-learn-ask-msg:not([data-streaming])').length === n && !document.querySelector('#h5-learn-ask [data-streaming]'), count);
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
async function tapKeys(page, keys) {
  for (const key of keys) await page.locator(`#h5-learn-keys button[data-char="${key}"]`).tap();
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    // \u2500\u2500 390x844 (touch): Spell inside its sentence \u2500\u2500
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 390, height: 844 }, touch: true });
      await toTerminal(page);
      await bnavTap(page, '#h5-bnav-learn');
      await page.locator(COACH).waitFor();
      await openScreen(page, 'spell');
      await page.locator('#h5-learn-sentence').waitFor();
      await page.locator('#h5-learn-keys[data-kind="letters"]').waitFor({ state: 'visible' });
      await tapKeys(page, 'exp');
      // Frame 1: Ask at the end of the helper row, after Show first letter, with the message icon.
      const ask = page.locator('#h5-learn-ask-open');
      assert.equal(await text(page, '#h5-learn-ask-open'), 'Ask');
      assert.equal(await page.locator('#h5-learn-ask-open svg').count(), 1, 'the message icon');
      const first = await page.locator('#h5-learn-first').boundingBox();
      const askBox = await ask.boundingBox();
      assert.ok(askBox.x > first.x + first.width, 'Ask after Show first letter');
      assert.ok(askBox.height >= 44, `a 44px target in touch mode (${askBox.height})`);
      assert.equal(await page.locator('#h5-learn-ask').count(), 0, 'no sheet before Ask');

      // Frame 2: the sheet before Check, with the earlier messages of the card.
      await ask.tap();
      const sheet = page.locator('#h5-learn-ask[data-layout="sheet"]');
      await sheet.waitFor({ state: 'visible' });
      await waitBubbles(page, 2);
      await page.waitForTimeout(400); // the slide-in
      const box = await sheet.boundingBox();
      assert.ok(box.y >= 120 && box.y <= 160, `the top of the sheet at about 150px (${box.y})`);
      assert.ok(Math.abs(box.y + box.height - 844) <= 1, 'the sheet reaches the bottom of the screen');
      assert.equal(await sheet.evaluate(el => getComputedStyle(el).borderTopLeftRadius), '8px');
      assert.equal(await page.locator('.MuiBackdrop-root').last().evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0.32)', 'a 32% scrim');
      assert.equal(await sheet.getAttribute('role'), 'dialog');
      assert.equal(await text(page, '#h5-learn-ask-title'), 'Ask about this question');
      assert.equal(await text(page, '#h5-learn-ask-caption'), 'The sentence with the gap \u00b7 your answer is not shown yet');
      assert.equal(await text(page, '#h5-learn-ask-close'), 'Close');
      assert.deepEqual(await texts(page, '.h5-learn-ask-chip'), ['Give me a hint', 'What part of speech fits?', 'Other example sentences', 'How do I remember it?']);
      assert.equal(await text(page, '#h5-learn-ask-hints-note'), 'Before you check, the answer is not given away, only hints.');
      assert.equal(await page.locator('#h5-learn-ask-input').getAttribute('placeholder'), 'Ask about this word or sentence');
      assert.equal(await page.locator('#h5-learn-ask-send').getAttribute('aria-label'), 'Send');
      assert.equal(await page.locator('#h5-learn-ask-send').getAttribute('title'), 'Send');
      assert.equal(await text(page, '#h5-learn-ask-earlier'), '1 earlier question');
      const earlier = await bubbles(page);
      assert.deepEqual(earlier.map(item => [item.role, item.lang]), [['user', 'zh'], ['assistant', 'en']]);
      assert.equal(earlier[0].text, ZH_WHY_S);
      assert.deepEqual(await page.locator('#h5-learn-ask .h5-learn-ask-msg strong').allTextContents(), ['the session cookie', '-s'], '**bold** drawn');
      assert.equal(await page.locator('#h5-learn-ask .h5-learn-ask-msg[data-role="assistant"]').evaluate(el => getComputedStyle(el).whiteSpace), 'pre-wrap', 'line breaks kept');
      const mine = await page.locator('#h5-learn-ask .h5-learn-ask-msg[data-role="user"]').boundingBox();
      const theirs = await page.locator('#h5-learn-ask .h5-learn-ask-msg[data-role="assistant"]').boundingBox();
      assert.ok(mine.x + mine.width > theirs.x + theirs.width - 1 && mine.x > theirs.x, 'the person on the right, the model on the left');

      // Typing in the sheet never reaches the exercise.
      await page.locator('#h5-learn-ask-input').tap();
      await page.keyboard.type('ires');
      assert.equal(await page.locator('#h5-learn-ask-input').inputValue(), 'ires');
      assert.equal(await page.locator('#h5-learn-spell-input').inputValue(), 'exp', 'the letters are untouched');
      assert.equal(await page.locator('#h5-learn-sentence-word').count(), 0, 'not checked');
      await page.locator('#h5-learn-ask-input').fill('');

      // A chip streams its answer: a growing bubble, then the stored messages.
      await page.evaluate(() => { window.askFeed.manual = true; });
      await page.locator('.h5-learn-ask-chip', { hasText: 'Give me a hint' }).tap();
      await page.locator('#h5-learn-ask [data-streaming="true"]').waitFor();
      assert.deepEqual(await page.evaluate(() => window.askFeed.bodies.at(-1)), { question: 'Give me a hint', mode: 'spell', state: { checked: false } });
      assert.equal(await page.locator('.h5-learn-ask-chip').first().isDisabled(), true, 'the chips wait while an answer comes');
      await page.evaluate(() => window.askFeed.push({ delta: 'It starts with ' }));
      await page.waitForFunction(() => document.querySelector('#h5-learn-ask [data-streaming="true"]').textContent === 'It starts with ');
      await page.evaluate(() => window.askFeed.push({ delta: '**ex-**.' }));
      await page.waitForFunction(() => document.querySelector('#h5-learn-ask [data-streaming="true"] strong')?.textContent === 'ex-');
      await shot(page, 'learn-ask-sheet.png');
      await page.evaluate(() => {
        window.askFeed.push({ done: true, messages: [{ uid: 'q1', role: 'user', text: 'Give me a hint', at: '2026-11-20T08:00:05.000Z' }, { uid: 'a1', role: 'assistant', text: 'It starts with **ex-**.', at: '2026-11-20T08:00:06.000Z' }] });
        window.askFeed.end();
      });
      await waitBubbles(page, 4);
      assert.deepEqual((await bubbles(page)).slice(2).map(item => [item.role, item.text]), [['user', 'Give me a hint'], ['assistant', 'It starts with ex-.']]);
      await page.evaluate(() => { window.askFeed.manual = false; });

      // Close gives the focus back to the field.
      await page.locator('#h5-learn-ask-close').tap();
      await sheet.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'h5-learn-spell-input');

      // After Check (frame 3): the caption with the answer, the chips about the mistake, a follow-up answered as JSON (a company computer).
      // (The keys typed into the sheet were a hardware keyboard's, so the page's keyboard has stepped aside; the field takes them now.)
      await page.keyboard.type('iers');
      await page.locator('#h5-learn-sentence-word').waitFor();
      assert.equal(await page.locator('#h5-learn-sentence-word').getAttribute('data-correct'), 'false');
      await page.locator('#h5-learn-ask-open').tap();
      await sheet.waitFor({ state: 'visible' });
      await waitBubbles(page, 4);
      assert.equal(await text(page, '#h5-learn-ask-caption'), 'Your answer: expiers \u00b7 wrong');
      assert.deepEqual(await texts(page, '.h5-learn-ask-chip'), ['Why was my answer wrong?', 'Explain the grammar', 'Other example sentences', 'How do I remember it?']);
      assert.equal(await page.locator('#h5-learn-ask-hints-note').count(), 0, 'no hints note after Check');
      assert.equal(await page.locator('#h5-learn-ask-input').getAttribute('placeholder'), 'Ask a follow-up');
      mock.askMode = 'json';
      await page.locator('#h5-learn-ask-input').tap();
      await page.keyboard.type(ZH_WHY_S);
      await page.keyboard.press('Enter');
      await waitBubbles(page, 6);
      assert.deepEqual(mock.asks().at(-1).body, { question: ZH_WHY_S, mode: 'spell', state: { checked: true, answer: 'expiers', correct: false, helped: false } });
      assert.equal(await page.locator('#h5-learn-ask-input').inputValue(), '', 'the input is emptied');
      assert.equal((await bubbles(page)).at(-1).text, 'You swapped r and e.');
      assert.equal(mock.answers().length, 0, 'Enter in the sheet never grades the card');
      await shot(page, 'learn-ask-checked.png');

      // A model failure before the stream starts (a plain JSON 502), then too many questions (429): the server's message with Try again.
      mock.askMode = '502';
      await page.locator('.h5-learn-ask-chip', { hasText: 'Explain the grammar' }).tap();
      await page.locator('#h5-learn-ask-error').waitFor();
      assert.equal(await text(page, '#h5-learn-ask-error .MuiAlert-message'), 'The translation service rejected the key');
      assert.equal(await page.locator('#h5-learn-ask-no-translator').count(), 0);
      mock.askMode = '429';
      await page.locator('#h5-learn-ask-retry').tap();
      await page.waitForFunction(() => document.querySelector('#h5-learn-ask-error .MuiAlert-message')?.textContent === 'Too many questions in a minute. Wait a moment and ask again.');
      assert.equal(mock.asks().at(-1).body.question, 'Explain the grammar', 'Try again asked the same question');
      // A company computer whose home went away: the server's 503 message, not the translator notice.
      mock.askMode = '503-away';
      await page.locator('#h5-learn-ask-retry').tap();
      await page.waitForFunction(() => /^Questions about a card are answered on a normal computer/.test(document.querySelector('#h5-learn-ask-error .MuiAlert-message')?.textContent || ''));
      assert.equal(await page.locator('#h5-learn-ask-no-translator').count(), 0);
      assert.equal(await waitBubbles(page, 7).then(() => true), true, 'the question stays in view, nothing stored');

      // An error in the middle of the stream: the Learn error style with Try again, which asks again.
      mock.askMode = 'error-mid';
      await page.locator('.h5-learn-ask-chip', { hasText: 'Why was my answer wrong?' }).tap();
      await page.locator('#h5-learn-ask-error').waitFor();
      assert.equal(await text(page, '#h5-learn-ask-error .MuiAlert-message'), 'The translation service did not answer in time');
      assert.equal(await page.locator('#h5-learn-ask [data-streaming]').count(), 0, 'the half answer is gone');
      assert.equal((await bubbles(page)).at(-1).text, 'Why was my answer wrong?', 'the question stays in view');
      mock.askMode = 'stream';
      await page.locator('#h5-learn-ask-retry').tap();
      await page.locator('#h5-learn-ask-error').waitFor({ state: 'detached' });
      await waitBubbles(page, 8);
      assert.equal(mock.asks().at(-1).body.question, 'Why was my answer wrong?');
      assert.deepEqual((await bubbles(page)).slice(-2).map(item => item.text), ['Why was my answer wrong?', 'Because the subject is singular.']);

      // No translator: the translator notice with its button; the typed question stays in the input.
      mock.askMode = '503';
      await page.locator('#h5-learn-ask-input').tap();
      await page.keyboard.type('And here?');
      await page.locator('#h5-learn-ask-send').tap();
      await page.locator('#h5-learn-ask-no-translator').waitFor();
      assert.match(await text(page, '#h5-learn-ask-no-translator'), /^Asking about a question needs a translator\. Set one up in Settings/);
      assert.equal(await page.locator('#h5-learn-ask-no-translator #h5-learn-open-translator').count(), 1);
      assert.equal(await page.locator('#h5-learn-ask-input').inputValue(), 'And here?');
      assert.equal(await page.locator('.h5-learn-ask-chip').first().isDisabled(), true);
      await page.keyboard.press('Escape');
      await sheet.waitFor({ state: 'detached' });
      assert.equal(await page.locator('#h5-learn-mode').isVisible(), true, 'Escape closed only the sheet');
      await context.close();
    }

    // \u2500\u2500 390x844 (touch): a sentence in Review (Fill the gap) \u2500\u2500
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 390, height: 844 }, touch: true });
      mock.translator = false;
      await toTerminal(page);
      await bnavTap(page, '#h5-bnav-learn');
      await page.locator(COACH).waitFor();
      await openScreen(page, 'review');
      await page.locator('#h5-learn-gap-input').waitFor();
      assert.equal(await page.locator('.h5-learn-pool').count(), 0, 'Fill the gap, not Build');
      const prompt = await page.locator('#h5-learn-mode .h5-learn-prompt').boundingBox();
      const askBox = await page.locator('#h5-learn-ask-open').boundingBox();
      assert.ok(askBox.y > prompt.y && askBox.y + askBox.height <= prompt.y + prompt.height + 1, 'Ask in the card');
      await page.locator('#h5-learn-ask-open').tap();
      await page.locator('#h5-learn-ask[data-layout="sheet"]').waitFor({ state: 'visible' });
      assert.equal(await text(page, '#h5-learn-ask-caption'), 'The sentence with the gap \u00b7 your answer is not shown yet');
      assert.deepEqual(await texts(page, '.h5-learn-ask-chip'), ['Give me a hint', 'Explain the grammar', 'Other example sentences', 'How do I remember it?']);
      await page.locator('#h5-learn-ask-no-translator').waitFor();
      assert.equal(await page.locator('#h5-learn-ask-earlier').count(), 0, 'no earlier questions');
      // While the sheet is open the card's keys are off (a hardware Enter would check the card otherwise).
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#h5-learn-feedback').count(), 0);
      assert.equal(mock.asks().length, 0);
      await context.close();
    }

    // \u2500\u2500 1440x900 (mouse): a sentence in Review (Fill the gap) with the side panel \u2500\u2500
    {
      const { gapFor } = await import(path.join(root, 'scripts/h5-shell/learn-model.mjs'));
      const gapWord = gapFor(SENTENCE_CARD).word;
      const { context, page, mock } = await openPage(browser, { viewport: { width: 1440, height: 900 } });
      await page.locator('#h5-nav-learn').click();
      await page.locator(COACH).waitFor();
      await openScreen(page, 'review');
      await page.locator('#h5-learn-gap-input').waitFor();
      assert.equal(await active(page), 'h5-learn-gap-input');
      await page.locator('#h5-learn-ask-open').click();
      const panel = page.locator('#h5-learn-ask[data-layout="side"]');
      await panel.waitFor();
      const box = await panel.boundingBox();
      assert.equal(box.width, 380);
      assert.equal(box.x + box.width, 1440);
      assert.equal(box.y, 0);
      assert.equal(box.height, 900);
      assert.equal(await page.locator('.MuiBackdrop-root:visible').count(), 0, 'no scrim: the card stays usable');
      const cardBox = await page.locator('#h5-learn .h5-learn-prompt').boundingBox();
      assert.ok(cardBox.x + cardBox.width <= box.x, 'the card makes room for the panel');
      assert.equal(await active(page), 'h5-learn-ask-input', 'the panel input has the focus');
      assert.equal(await text(page, '#h5-learn-ask-caption'), 'The sentence with the gap \u00b7 your answer is not shown yet');
      // Enter sends the question and never checks the exercise.
      await page.keyboard.type('Why "do not" and not "not do"?');
      await page.keyboard.press('Enter');
      await waitBubbles(page, 2);
      assert.deepEqual(mock.asks().at(-1).body, { question: 'Why "do not" and not "not do"?', mode: 'fill', state: { checked: false, expected: gapWord } });
      assert.equal(await page.locator('#h5-learn-feedback').count(), 0, 'the card is not checked');
      assert.equal(await page.locator('#h5-learn-gap-input').inputValue(), '', 'nothing typed into the answer');
      // The card stays usable: a letter is typed into the gap while the panel is open.
      await page.locator('#h5-learn-gap-input').fill(gapWord.slice(0, 1));
      assert.equal(await page.locator('#h5-learn-gap-input').inputValue(), gapWord.slice(0, 1));
      assert.equal(await panel.count(), 1, 'the panel stays');
      await shot(page, 'learn-ask-desktop.png');
      // Escape closes the panel, not the mode; the focus goes back to the answer field.
      await page.locator('#h5-learn-ask-input').focus();
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'detached' });
      assert.equal(await text(page, '#h5-learn-view-title'), 'Daily review');
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'h5-learn-gap-input');
      // Opened again: the conversation is still there (read again from the server).
      const gets = mock.requests.filter(item => item.method === 'GET' && /\/ask$/.test(item.path)).length;
      await page.locator('#h5-learn-ask-open').click();
      await panel.waitFor();
      await waitBubbles(page, 2);
      assert.ok(mock.requests.filter(item => item.method === 'GET' && /\/ask$/.test(item.path)).length > gets, 'the messages are read again when it opens');
      await page.locator('#h5-learn-ask-close').click();
      await panel.waitFor({ state: 'detached' });

      // Fill the gap sends the gap word as `expected` (the server cannot know it).
      await openScreen(page, 'fill');
      await page.locator('#h5-learn-gap-input').waitFor();
      await page.locator('#h5-learn-ask-open').click();
      await panel.waitFor();
      await page.locator('.h5-learn-ask-chip', { hasText: 'Give me a hint' }).click();
      await page.waitForFunction(() => document.querySelectorAll('#h5-learn-ask .h5-learn-ask-msg:not([data-streaming])').length >= 4);
      const fill = mock.asks().at(-1).body;
      assert.equal(fill.mode, 'fill');
      assert.equal(fill.state.checked, false);
      assert.ok(fill.state.expected && MERGE.split(/\W+/).includes(fill.state.expected), `the gap word is sent (${fill.state.expected})`);
      assert.equal(await text(page, '#h5-learn-ask-caption'), 'The sentence with the gap \u00b7 your answer is not shown yet');
      // A company computer whose home cannot answer: a short line instead of the translator notice; nothing can be asked.
      await page.locator('#h5-learn-ask-close').click();
      mock.away = 'offline';
      await page.locator('#h5-learn-ask-open').click();
      await page.locator('#h5-learn-ask-away').waitFor();
      assert.equal(await text(page, '#h5-learn-ask-away'), 'Questions are answered by your normal computer, which cannot be reached right now.');
      assert.equal(await page.locator('#h5-learn-ask-no-translator').count(), 0);
      assert.equal(await page.locator('.h5-learn-ask-chip').first().isDisabled(), true);
      await page.locator('#h5-learn-ask-close').click();
      mock.away = 'older';
      await page.locator('#h5-learn-ask-open').click();
      await page.waitForFunction(() => document.querySelector('#h5-learn-ask-away')?.textContent === 'Your normal computer needs an update to answer questions.');
      assert.equal(await page.locator('#h5-learn-ask-no-translator').count(), 0);
      await page.locator('#h5-learn-ask-close').click();
      await panel.waitFor({ state: 'detached' });
      await context.close();
    }

    assert.deepEqual(pageErrors, []);
    console.log('Learn ask browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
