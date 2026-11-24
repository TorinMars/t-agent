// Learn: "English chat" (scripts/h5-shell/LearnChat.jsx), in real Chromium with every route mocked; /api/learn/chats follows the contract of
// "English chat on the page" in docs/design/learn-english-chat.md (GET /chats: the list and `translator`, `offline` / `home_older` on a company computer whose
// home cannot answer; GET /chats/:uid: the chat and its messages with their cards; POST /chats/send: an NDJSON stream of a first `{"chat"}` line,
// `{"delta"}` lines and a last `{"done","chat","messages"}` or `{"error","status"}` line, or plain JSON from a company computer; PATCH and DELETE
// /chats/:uid). Cards are added with POST /api/learn/cards. No model is ever called. A streamed answer the test feeds piece by piece goes through a
// fetch stand-in (Playwright routes cannot keep a response open).
// The engine here has no coach (GET /api/learn/coach answers 404): the old chat behind the home card of such an engine.
// - 390x844 (touch): the home entry with its count (read from GET /chats when the summary has none); a new chat: the starter chips (three fill
//   the input with the caret in place, two send with their topic), the privacy line; Enter on a touch screen never sends; a streamed answer whose
//   first `chat` line names the chat, a trailing `<<meta>>` never shown, `done` replacing the temporary bubbles and naming the chat; the menu (mark
//   and unmark as a journal entry, rename, delete with its confirmation); Earlier chats (rows, Journal tags, the note, back to the chat);
//   "Add to my cards" (a card already added starts as ✓; a tap adds one and turns it ✓; an error); corrections drawn from `[-x-]{+y+}`; a JSON error
//   before the first piece with Try again; a full chat (409) with New chat keeping the question; a company computer's JSON answer; the translator
//   notice; a company computer whose home is offline.
// - 1440x900 (mouse): the count from the summary; the 260px chats list and the conversation in the right pane; Shift+Enter is a new line and
//   Enter sends; Escape closes the chat.
// H5_SHOT_DIR=<dir> saves learn-chat-*.png.
const { chromium } = require('playwright');
const { bnavTap } = require('./h5-bottom-nav-tap.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

process.env.T_AGENT_DATA_DIR = process.env.T_AGENT_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-learn-chat-browser-'));

const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';

const TASKS = [{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }];
const TERMINALS = { 1: [{ terminal_id: 'c1', title: 'Claude: login fix', agent: 'claude' }] };
// Chinese user content, escaped (Chinese is allowed only in the dictionaries).
const ZH_SCHEDULE = '"\u8fd9\u4e2a\u9700\u6c42\u6211\u4eec\u6392\u671f\u5230\u4e0b\u5468" \u7528\u82f1\u8bed\u600e\u4e48\u8bf4\u6bd4\u8f83\u81ea\u7136\uff1f';
const ZH_SLOT = 'slot \u5f53\u52a8\u8bcd\u8fd8\u6709\u522b\u7684\u7528\u6cd5\u5417\uff1f';
const ZH_SCHEDULED = '\u6211\u4eec\u5df2\u7ecf\u628a\u5b83\u6392\u5230\u4e0b\u5468\u4e86\u3002';
const ZH_SLOTTED = '\u88ab\u5b89\u6392\u5728';
const ZH_SLOT_IN = '\u628a…\u5b89\u6392\u8fdb\u53bb';
// Times in UTC; the page shows them in Taipei time (the browser's zone here).
const T = (day, hh, mm) => new Date(Date.UTC(2026, 10, day, hh - 8, mm)).toISOString();
const SCHEDULE_ANSWER = "A natural way: **We've scheduled this for next week.** More casual: **We'll get to this next week.** In a planning meeting: **This is slotted for next week's sprint.**";
const SLOT_ANSWER = 'Yes: **slot in** = fit something into a free time.\nCan you slot me in at 3?';
const JOURNAL_ANSWER = 'Today I [-have deployed-]{+deployed+} the new login page on Friday. It was [-very-] slow because the tests [-was-]{+were+} flaky.\n**Why:** with a past time (*on Friday*) use the simple past.';

function seed() {
  const msg = (uid, role, text, at, extra = {}) => ({ uid, role, text, at, ...(role === 'assistant' ? { cards: [], mistakes: [] } : {}), ...extra });
  return {
    c1: {
      chat: { uid: 'c1', title: 'A slow Friday deploy', journal: true, journal_by: 'model', created_at: T(21, 22, 0), updated_at: T(21, 22, 5) },
      messages: [msg('c1q', 'user', 'Today I have deployed the new login page on Friday. It was very slow because the tests was flaky.', T(21, 22, 0)), msg('c1a', 'assistant', JOURNAL_ANSWER, T(21, 22, 5))],
    },
    c2: {
      chat: { uid: 'c2', title: 'Scheduling words', journal: false, journal_by: '', created_at: T(21, 20, 10), updated_at: T(21, 20, 14) },
      messages: [
        msg('c2q1', 'user', ZH_SCHEDULE, T(21, 20, 10)),
        msg('c2a1', 'assistant', SCHEDULE_ANSWER, T(21, 20, 11), { cards: [{ kind: 'sentence', en: "We've scheduled this for next week.", zh: ZH_SCHEDULED, added: true }, { kind: 'word', en: 'slotted for', zh: ZH_SLOTTED, added: false }] }),
        msg('c2q2', 'user', ZH_SLOT, T(21, 20, 13)),
        msg('c2a2', 'assistant', SLOT_ANSWER, T(21, 20, 14), { cards: [{ kind: 'word', en: 'slot in', zh: ZH_SLOT_IN, added: false }] }),
      ],
    },
    c3: {
      chat: { uid: 'c3', title: 'Code review with Lin', journal: true, journal_by: 'person', created_at: T(19, 23, 0), updated_at: T(19, 23, 10) },
      messages: [msg('c3q', 'user', 'Yesterday I review the code of Lin.', T(19, 23, 0)), msg('c3a', 'assistant', 'Yesterday I [-review-]{+reviewed+} Lin\'s code.', T(19, 23, 10))],
    },
  };
}
const pageErrors = [];

function learnMock({ summaryChats = null } = {}) {
  const mock = { chats: seed(), translator: true, away: '', sendMode: 'stream', cardsMode: 'ok', patchMode: 'ok', requests: [], seq: 1, clock: Date.parse(T(21, 23, 0)) };
  const summary = { due: 2, new_today: 0, done_today: 3, goal: 20, streak: 5, words: 421, sentences: 110, mistakes: 14, collecting: true, starter: null, ...(summaryChats === null ? {} : { chats: summaryChats }) };
  const out = chat => ({ ...chat.chat, count: chat.messages.length });
  mock.list = () => Object.values(mock.chats).map(out).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  // An answer stored as the server would: a new chat for `chat: null` (titled from the meta), the question and the answer.
  mock.store = (uid, question, answer, { title = 'My journaling', cards = [] } = {}) => {
    const at = () => { mock.clock += 1000; return new Date(mock.clock).toISOString(); };
    let id = uid;
    if (!id) {
      id = `n${mock.seq++}`;
      mock.chats[id] = { chat: { uid: id, title: '', journal: false, journal_by: '', created_at: new Date(mock.clock).toISOString(), updated_at: new Date(mock.clock).toISOString() }, messages: [] };
    }
    const entry = mock.chats[id];
    const messages = [{ uid: `${id}-q${entry.messages.length}`, role: 'user', text: question, at: at() }, { uid: `${id}-a${entry.messages.length}`, role: 'assistant', text: answer, at: at(), cards, mistakes: [] }];
    entry.messages.push(...messages);
    if (!entry.chat.title) entry.chat.title = title;
    entry.chat.updated_at = messages[1].at;
    return { chat: out(entry), messages };
  };
  mock.handle = (p, method, url, body) => {
    mock.requests.push({ method, path: p, body });
    if (p === '/api/learn/summary') return summary;
    if (p === '/api/learn/settings') return { collect: true, daily_goal: 20, starter: null, report_lang: 'en' };
    if (p === '/api/learn/cards' && method === 'POST') {
      if (mock.cardsMode === 'error') return [400, { error: 'The word is too long' }];
      return { card: { id: 900 + mock.requests.length, kind: body.kind, en: body.en, zh: body.zh }, created: true };
    }
    if (p === '/api/learn/chats' && method === 'GET') {
      if (mock.away === 'offline') return { chats: [], translator: false, offline: true };
      return { chats: mock.list(), translator: mock.translator };
    }
    if (p === '/api/learn/chats/send' && method === 'POST') {
      if (mock.sendMode === '503') return [503, { error: 'Translation service not configured yet' }];
      if (mock.sendMode === '502') return [502, { error: 'The translation service rejected the key' }];
      if (mock.sendMode === '409') return [409, { error: 'This chat is full. Start a new one.' }];
      if (mock.sendMode === 'json') return mock.store(body.chat, body.question, 'Use **the simple past** here.', { title: 'Simple past' });
      const answer = 'Because the subject is plural.';
      const temp = body.chat ? out(mock.chats[body.chat]) : { uid: `n${mock.seq}`, title: '', journal: false, journal_by: '', created_at: new Date(mock.clock).toISOString(), updated_at: new Date(mock.clock).toISOString(), count: 0 };
      const stored = mock.store(body.chat, body.question, answer, { title: 'Subject and verb' });
      return { ndjson: [{ chat: temp }, { delta: 'Because the ' }, { delta: 'subject is plural.' }, { done: true, ...stored }] };
    }
    const one = p.match(/^\/api\/learn\/chats\/([^/]+)$/);
    if (one) {
      const entry = mock.chats[one[1]];
      if (!entry) return [404, { error: 'Chat not found' }];
      if (method === 'GET') return { chat: out(entry), messages: entry.messages };
      if (method === 'PATCH') {
        if (mock.patchMode === 'title-error' && typeof body.title === 'string') return [400, { error: 'A chat title has 1 to 60 characters' }];
        // Unmarked, it is one non-journal chat too many: pruned at once and answered as deleted.
        if (mock.patchMode === 'pruned' && body.journal === false) { delete mock.chats[one[1]]; return { chat: { ...out(entry), journal: false, deleted: true } }; }
        if (typeof body.title === 'string') entry.chat.title = body.title;
        if (typeof body.journal === 'boolean') { entry.chat.journal = body.journal; entry.chat.journal_by = 'person'; }
        return { chat: out(entry) };
      }
      if (method === 'DELETE') { delete mock.chats[one[1]]; return { ok: true }; }
    }
    return [404, { error: 'not mocked' }];
  };
  mock.sends = () => mock.requests.filter(item => item.method === 'POST' && item.path === '/api/learn/chats/send');
  mock.of = (method, re) => mock.requests.filter(item => item.method === method && re.test(item.path));
  return mock;
}

// A fetch stand-in for the answer the test feeds: `window.chatFeed.manual = true`, then `chatFeed.push(line)` and `chatFeed.end()`.
function chatFeedMock() {
  const encoder = new TextEncoder();
  const realFetch = window.fetch.bind(window);
  window.chatFeed = { manual: false, bodies: [], controller: null, push(item) { this.controller.enqueue(encoder.encode(`${JSON.stringify(item)}\n`)); }, end() { this.controller.close(); } };
  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (window.chatFeed.manual && /\/api\/learn\/chats\/send$/.test(url) && init.method === 'POST') {
      window.chatFeed.bodies.push(JSON.parse(init.body));
      const body = new ReadableStream({ start(controller) { window.chatFeed.controller = controller; } });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } }));
    }
    return realFetch(input, init);
  };
}

async function openPage(browser, { viewport, touch = false, summaryChats = null }) {
  const context = await browser.newContext({ viewport, timezoneId: 'Asia/Taipei', ...(touch ? { isMobile: true, hasTouch: true } : {}), ...(SHOTS ? { deviceScaleFactor: 3 } : {}) });
  const page = await context.newPage();
  const mock = learnMock({ summaryChats });
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
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: undefined });
  });
  await page.addInitScript(activityStreamMock);
  await page.addInitScript(chatFeedMock);
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
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, name) }); } };
const bubbles = page => page.locator('#h5-learn-chat .h5-learn-chat-msg').evaluateAll(list => list.map(el => ({ role: el.dataset.role, text: el.textContent, lang: el.getAttribute('lang'), streaming: el.dataset.streaming === 'true' })));
const waitBubbles = (page, count) => page.waitForFunction(n => document.querySelectorAll('#h5-learn-chat .h5-learn-chat-msg:not([data-streaming])').length === n && !document.querySelector('#h5-learn-chat [data-streaming]'), count);
const waitText = (page, selector, want) => page.waitForFunction(([sel, value]) => (document.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim() === value, [selector, want]);
// The back press of a phone (back.mjs): an Escape keydown dispatched on the top modal, which is not a trusted key (no hardware keyboard is seen).
const backPress = page => page.evaluate(() => {
  const modals = [...document.body.children].filter(el => el.classList.contains('MuiModal-root') && !el.classList.contains('MuiModal-hidden'));
  modals.at(-1).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
});
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
async function openMenu(page) {
  await page.locator('#h5-learn-chat-more').tap();
  await page.locator('#h5-learn-chat-menu .MuiMenuItem-root').first().waitFor({ state: 'visible' });
  return texts(page, '#h5-learn-chat-menu .MuiMenuItem-root');
}
const menuGone = page => page.waitForFunction(() => !document.querySelector('#h5-learn-chat-menu .MuiMenuItem-root'));

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    // ── 390x844 (touch) ──
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 390, height: 844 }, touch: true });
      await toTerminal(page);
      await bnavTap(page, '#h5-bnav-learn');
      // Frame 1: after Mistakes, the overline "Ask" and the English chat card with its count (read from GET /chats: the summary has none).
      const entry = page.locator('#h5-learn-mode-chat');
      await entry.waitFor();
      await waitText(page, '#h5-learn-mode-chat .h5-learn-count', '3 chats');
      assert.ok(mock.of('GET', /^\/api\/learn\/chats$/).length >= 1, 'the count is read from the chats list');
      const homeOrder = await page.locator('#h5-learn .h5-learn-home').evaluate(el => [...el.querySelectorAll('h2, .h5-learn-mode button, .h5-learn-mode a, [id^="h5-learn-mode-"]')].map(node => node.id || node.textContent.trim()));
      const at = name => homeOrder.indexOf(name);
      assert.ok(at('h5-learn-mode-mistakes') >= 0 && at('Ask') > at('h5-learn-mode-mistakes') && at('h5-learn-mode-chat') > at('Ask'), `Ask after Mistakes (${homeOrder.join(', ')})`);
      assert.equal(await text(page, '#h5-learn-mode-chat'), 'English chatAsk anything about English: words, grammar, how to say something3 chats'.replace(/\s+/g, ' '));
      assert.equal(await page.locator('#h5-learn-mode-chat svg').count(), 1, 'the message icon');
      await shot(page, 'learn-chat-home.png');

      // Frame 3: a new chat.
      await entry.tap();
      const view = page.locator('#h5-learn-chat[data-layout="phone"]');
      await view.waitFor();
      await page.locator('#h5-learn-chat-start').waitFor();
      assert.equal(await text(page, '#h5-learn-view-title'), 'English chat');
      assert.equal(await text(page, '#h5-learn-chat-title'), 'New chat');
      for (const [id, label] of [['#h5-learn-chat-history', 'Earlier chats'], ['#h5-learn-chat-new', 'New chat'], ['#h5-learn-back', 'Back'], ['#h5-learn-chat-send', 'Send']]) {
        assert.equal(await page.locator(id).getAttribute('aria-label'), label);
        assert.equal(await page.locator(id).getAttribute('title'), label);
      }
      const historyBox = await page.locator('#h5-learn-chat-history').boundingBox();
      assert.ok(historyBox.width >= 44 && historyBox.height >= 44, 'a 44px target in touch mode');
      assert.equal(await page.locator('#h5-learn-chat-more').count(), 0, 'no menu before the chat exists');
      assert.equal(await text(page, '#h5-learn-chat-start h3'), 'Ask anything about English');
      assert.deepEqual(await texts(page, '.h5-learn-chat-chip'), ['Review my journal entry', 'How is my journaling going?', 'How do I say … in English?', 'Check my sentence', 'Words I keep getting wrong']);
      assert.equal(await text(page, '#h5-learn-chat-privacy'), 'Your questions and your level go to the translation model you set up. A short summary of your recent mistakes or your journal is added only when you ask about them.');
      assert.equal(await page.locator('#h5-learn-chat-input').getAttribute('placeholder'), 'Ask anything about English');
      assert.equal(await page.locator('#h5-learn-chat-input').evaluate(el => el.tagName), 'TEXTAREA', 'a multiline input');
      assert.equal(await page.locator('#h5-learn-keys').count(), 0, 'the Learn keyboard is not used here');
      await shot(page, 'learn-chat-new.png');

      // The fill chips put their text into the input (caret in place) and send nothing.
      const input = page.locator('#h5-learn-chat-input');
      const caret = () => input.evaluate(el => [el.value, el.selectionStart, document.activeElement === el]);
      await page.locator('.h5-learn-chat-chip[data-chip="journal-review"]').tap();
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'h5-learn-chat-input');
      assert.deepEqual(await caret(), ['Please review my journal entry:\n', 32, true]);
      await page.locator('.h5-learn-chat-chip[data-chip="how-say"]').tap();
      await page.waitForFunction(() => document.getElementById('h5-learn-chat-input').value.startsWith('How do I say'));
      assert.deepEqual(await caret(), ['How do I say "" in English?', 14, true], 'the caret between the quotes');
      await page.locator('.h5-learn-chat-chip[data-chip="check"]').tap();
      await page.waitForFunction(() => document.getElementById('h5-learn-chat-input').value.startsWith('Please check'));
      assert.deepEqual(await caret(), ['Please check my sentence: ', 26, true]);
      // Enter on a touch screen is a new line: it never sends.
      await input.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })));
      await page.waitForTimeout(100);
      assert.equal(mock.sends().length, 0, 'nothing sent by a fill chip or by Enter');
      await input.fill('');

      // A send chip streams its answer: the first line names the new chat, the meta line never shows, done names the chat.
      await page.evaluate(() => { window.chatFeed.manual = true; });
      await page.locator('.h5-learn-chat-chip[data-chip="journal-habit"]').tap();
      await page.locator('#h5-learn-chat [data-streaming="true"]').waitFor();
      assert.deepEqual(await page.evaluate(() => window.chatFeed.bodies.at(-1)), { chat: null, question: 'How is my journaling going?', topic: 'journal' });
      assert.equal(await page.locator('.h5-learn-chat-chip').count(), 0, 'the start screen is gone while the answer comes');
      await page.evaluate(() => window.chatFeed.push({ chat: { uid: 'n1', title: '', journal: false, journal_by: '', created_at: '2026-11-21T15:00:00.000Z', updated_at: '2026-11-21T15:00:00.000Z', count: 0 } }));
      await page.locator('#h5-learn-chat-more').waitFor();
      assert.equal(await text(page, '#h5-learn-chat-title'), 'New chat', 'no title before the first answer is done');
      await page.evaluate(() => window.chatFeed.push({ delta: 'From your 9 journal entries: **Rhythm:** 5 entries in 3 weeks.' }));
      await page.waitForFunction(() => document.querySelector('#h5-learn-chat [data-streaming="true"] strong')?.textContent === 'Rhythm:');
      await page.evaluate(() => window.chatFeed.push({ delta: '\n<<me' }));
      await page.waitForTimeout(100);
      assert.equal(await page.locator('#h5-learn-chat [data-streaming="true"]').evaluate(el => el.textContent), 'From your 9 journal entries: Rhythm: 5 entries in 3 weeks.', 'a possible start of <<meta>> is held back');
      await page.evaluate(() => window.chatFeed.push({ delta: 'ta>>{"cards":[],"mistakes":[],"journal":false,"title":"My journaling"}' }));
      await page.waitForTimeout(100);
      assert.ok(!(await page.locator('#h5-learn-chat [data-streaming="true"]').evaluate(el => el.textContent)).includes('meta'), 'the meta line never shows');
      await shot(page, 'learn-chat-streaming.png');
      const n1 = mock.store(null, 'How is my journaling going?', 'From your 9 journal entries: **Rhythm:** 5 entries in 3 weeks.\nGood plan.', { title: 'My journaling' });
      assert.equal(n1.chat.uid, 'n1');
      await page.evaluate(done => { window.chatFeed.push({ done: true, ...done }); window.chatFeed.end(); }, n1);
      await waitBubbles(page, 2);
      assert.deepEqual((await bubbles(page)).map(item => [item.role, item.text]), [['user', 'How is my journaling going?'], ['assistant', 'From your 9 journal entries: Rhythm: 5 entries in 3 weeks.\nGood plan.']]);
      await waitText(page, '#h5-learn-chat-title', 'My journaling');
      assert.equal(await page.locator('#h5-learn-chat-input').getAttribute('placeholder'), 'Reply or write more');
      await page.evaluate(() => { window.chatFeed.manual = false; });

      // The menu: mark as a journal entry and back, rename.
      assert.deepEqual(await openMenu(page), ['Mark as journal entry', 'Rename', 'Delete']);
      await page.locator('#h5-learn-chat-journal').tap();
      await page.locator('#h5-learn-mode .h5-learn-subtitle .h5-learn-chat-journal').waitFor();
      assert.deepEqual(mock.of('PATCH', /^\/api\/learn\/chats\/n1$/).at(-1).body, { journal: true });
      assert.equal(await text(page, '#h5-learn-mode .h5-learn-subtitle'), 'JournalMy journaling');
      await menuGone(page);
      assert.deepEqual(await openMenu(page), ['Not a journal entry', 'Rename', 'Delete']);
      await page.locator('#h5-learn-chat-journal').tap();
      await page.waitForFunction(() => !document.querySelector('#h5-learn-mode .h5-learn-subtitle .h5-learn-chat-journal'));
      assert.deepEqual(mock.of('PATCH', /^\/api\/learn\/chats\/n1$/).at(-1).body, { journal: false });
      await menuGone(page);
      await openMenu(page);
      await page.locator('#h5-learn-chat-rename').tap();
      const rename = page.locator('#h5-learn-chat-rename-dialog');
      await rename.waitFor({ state: 'visible' });
      assert.equal(await text(page, '#h5-learn-chat-rename-title'), 'Rename chat');
      assert.equal(await page.locator('#h5-learn-chat-title-input').inputValue(), 'My journaling', 'the title is filled in');
      assert.deepEqual(await rename.locator('.MuiDialogActions-root button').allTextContents(), ['Cancel', 'Save']);
      await page.locator('#h5-learn-chat-title-input').fill('Journal habit');
      await page.locator('#h5-learn-chat-rename-save').tap();
      await rename.waitFor({ state: 'detached' });
      assert.deepEqual(mock.of('PATCH', /^\/api\/learn\/chats\/n1$/).at(-1).body, { title: 'Journal habit' });
      await waitText(page, '#h5-learn-chat-title', 'Journal habit');

      // Frame 4: Earlier chats, its own screen; back returns to the chat.
      await page.locator('#h5-learn-chat-history').tap();
      await page.locator('#h5-learn-chats .h5-learn-chat-row').first().waitFor();
      assert.equal(await text(page, '#h5-learn-view-title'), 'Earlier chats');
      assert.deepEqual(await texts(page, '#h5-learn-chats .h5-learn-chat-row-title'), ['Journal habit', 'A slow Friday deploy', 'Scheduling words', 'Code review with Lin']);
      assert.deepEqual(await page.locator('#h5-learn-chats .h5-learn-chat-row').evaluateAll(rows => rows.map(row => Boolean(row.querySelector('.h5-learn-chat-journal')))), [false, true, false, true], 'Journal tags');
      assert.deepEqual((await texts(page, '#h5-learn-chats .h5-learn-chat-row-line')).slice(1), ['11-21 22:05 · 2 messages', '11-21 20:14 · 4 messages', '11-19 23:10 · 2 messages']);
      assert.equal(await page.locator('#h5-learn-chats .h5-learn-chat-row[aria-current="true"]').getAttribute('data-uid'), 'n1', 'the open chat is marked');
      assert.equal(await text(page, '#h5-learn-chats-note'), 'Kept on the server and on your other machines.');
      await shot(page, 'learn-chat-earlier.png');
      await backPress(page);
      await page.locator('#h5-learn-chat[data-layout="phone"]').waitFor();
      await waitText(page, '#h5-learn-chat-title', 'Journal habit');
      assert.equal(await page.locator('#h5-learn-mode').count(), 1, 'back on Earlier chats returns to the chat, not the home');

      // Frame 2: a chat with "Add to my cards"; an added card starts as ✓, a tap adds one.
      await page.locator('#h5-learn-chat-history').tap();
      await page.locator('#h5-learn-chats .h5-learn-chat-row[data-uid="c2"]').tap();
      await waitBubbles(page, 4);
      await waitText(page, '#h5-learn-chat-title', 'Scheduling words');
      const two = await bubbles(page);
      assert.deepEqual(two.map(item => [item.role, item.lang]), [['user', 'zh'], ['assistant', 'en'], ['user', 'zh'], ['assistant', 'en']]);
      assert.deepEqual(await page.locator('.h5-learn-chat-cards[data-for="c2a1"] .h5-learn-chat-card').evaluateAll(list => list.map(el => [el.textContent, el.dataset.added])), [["✓ We've scheduled this for next week.", 'true'], ['+ slotted for', 'false']]);
      assert.deepEqual(await texts(page, '.h5-learn-chat-cards[data-for="c2a1"] > p'), ['Add to my cards'], 'the caption once per message');
      await page.locator('.h5-learn-chat-cards[data-for="c2a1"] .h5-learn-chat-card[data-added="false"]').tap();
      await page.waitForFunction(() => [...document.querySelectorAll('.h5-learn-chat-cards[data-for="c2a1"] .h5-learn-chat-card')].every(el => el.dataset.added === 'true'));
      assert.deepEqual(mock.of('POST', /^\/api\/learn\/cards$/).at(-1).body, { kind: 'word', en: 'slotted for', zh: ZH_SLOTTED, context: "In a planning meeting: This is slotted for next week's sprint.", source: 'manual' });
      assert.equal(await text(page, '.h5-learn-chat-cards[data-for="c2a1"] .h5-learn-chat-card:last-child'), '✓ slotted for');
      await shot(page, 'learn-chat-conversation.png');
      // A card that cannot be added: the error under its chips, the chip stays "+".
      mock.cardsMode = 'error';
      await page.locator('.h5-learn-chat-cards[data-for="c2a2"] .h5-learn-chat-card').tap();
      await page.locator('.h5-learn-chat-cards[data-for="c2a2"] .h5-learn-chat-card-error').waitFor();
      assert.equal(await text(page, '.h5-learn-chat-cards[data-for="c2a2"] .h5-learn-chat-card-error'), 'The word is too long');
      assert.equal(await text(page, '.h5-learn-chat-cards[data-for="c2a2"] .h5-learn-chat-card'), '+ slot in');
      mock.cardsMode = 'ok';

      // Delete: the confirmation (Cancel first, Delete in the error colour); Cancel keeps the chat, Delete removes it and opens a new chat.
      await openMenu(page);
      await page.locator('#h5-learn-chat-delete').tap();
      const confirm = page.locator('#h5-learn-chat-delete-dialog');
      await confirm.waitFor({ state: 'visible' });
      assert.equal(await text(page, '#h5-learn-chat-delete-title'), 'Delete this chat?');
      assert.deepEqual(await confirm.locator('.MuiDialogActions-root button').allTextContents(), ['Cancel', 'Delete']);
      assert.ok((await page.locator('#h5-learn-chat-delete-confirm').getAttribute('class')).includes('MuiButton-colorError'), 'Delete in the error colour');
      await confirm.locator('.MuiDialogActions-root button', { hasText: 'Cancel' }).tap();
      await confirm.waitFor({ state: 'detached' });
      assert.equal(mock.of('DELETE', /chats/).length, 0);
      await openMenu(page);
      await page.locator('#h5-learn-chat-delete').tap();
      await confirm.waitFor({ state: 'visible' });
      await page.locator('#h5-learn-chat-delete-confirm').tap();
      await confirm.waitFor({ state: 'detached' });
      await page.locator('#h5-learn-chat-start').waitFor();
      assert.equal(mock.of('DELETE', /^\/api\/learn\/chats\/c2$/).length, 1);
      assert.equal(await text(page, '#h5-learn-chat-title'), 'New chat');

      // Frame 5: a reviewed journal entry, its corrections drawn.
      await page.locator('#h5-learn-chat-history').tap();
      await page.locator('#h5-learn-chats .h5-learn-chat-row').first().waitFor();
      assert.deepEqual(await texts(page, '#h5-learn-chats .h5-learn-chat-row-title'), ['Journal habit', 'A slow Friday deploy', 'Code review with Lin'], 'the deleted chat is gone');
      await page.locator('#h5-learn-chats .h5-learn-chat-row[data-uid="c1"]').tap();
      await waitBubbles(page, 2);
      assert.equal(await text(page, '#h5-learn-mode .h5-learn-subtitle'), 'JournalA slow Friday deploy');
      assert.deepEqual(await page.locator('#h5-learn-chat .h5-learn-chat-del').allTextContents(), ['have deployed', 'very', 'was']);
      assert.deepEqual(await page.locator('#h5-learn-chat .h5-learn-chat-ins').allTextContents(), ['deployed', 'were']);
      const del = await page.locator('#h5-learn-chat .h5-learn-chat-del').first().evaluate(el => ({ line: getComputedStyle(el).textDecorationLine, color: getComputedStyle(el).color }));
      const ins = await page.locator('#h5-learn-chat .h5-learn-chat-ins').first().evaluate(el => ({ line: getComputedStyle(el).textDecorationLine, color: getComputedStyle(el).color }));
      assert.equal(del.line, 'line-through');
      assert.equal(ins.line, 'underline');
      assert.notEqual(del.color, ins.color, 'error and success colours');
      assert.ok(!(await bubbles(page))[1].text.includes('[-'), 'no markup left in the text');
      await shot(page, 'learn-chat-journal.png');

      // A model failure before its first piece: a JSON error with Try again; Try again sends the same question.
      mock.sendMode = '502';
      await input.fill('Is "on Friday" right here?');
      await page.locator('#h5-learn-chat-send').tap();
      await page.locator('#h5-learn-chat-error').waitFor();
      assert.equal(await text(page, '#h5-learn-chat-error .MuiAlert-message'), 'The translation service rejected the key');
      assert.deepEqual((await bubbles(page)).at(-1), { role: 'user', text: 'Is "on Friday" right here?', lang: 'en', streaming: false });
      mock.sendMode = 'stream';
      await page.locator('#h5-learn-chat-retry').tap();
      await waitBubbles(page, 4);
      assert.deepEqual(mock.sends().at(-1).body, { chat: 'c1', question: 'Is "on Friday" right here?' });
      assert.equal(await page.locator('#h5-learn-chat-error').count(), 0);

      // A full chat (409): the server's message with New chat, which keeps the question for the new chat.
      mock.sendMode = '409';
      await input.fill('One more line about Friday.');
      await page.locator('#h5-learn-chat-send').tap();
      await page.locator('#h5-learn-chat-full').waitFor();
      assert.equal(await text(page, '#h5-learn-chat-full .MuiAlert-message'), 'This chat is full. Start a new one.');
      assert.equal(await input.inputValue(), 'One more line about Friday.', 'the question waits in the input');
      assert.equal(await page.locator('#h5-learn-chat-send').isDisabled(), true);
      await page.locator('#h5-learn-chat-full-new').tap();
      await page.locator('#h5-learn-chat-start').waitFor();
      assert.equal(await text(page, '#h5-learn-chat-title'), 'New chat');
      assert.equal(await page.locator('#h5-learn-chat-input').inputValue(), 'One more line about Friday.');

      // A company computer answers plain JSON (from its home): the chat and its messages at once.
      mock.sendMode = 'json';
      await page.locator('#h5-learn-chat-send').tap();
      await waitBubbles(page, 2);
      assert.deepEqual((await bubbles(page)).map(item => item.text), ['One more line about Friday.', 'Use the simple past here.']);
      await waitText(page, '#h5-learn-chat-title', 'Simple past');
      assert.deepEqual(mock.sends().at(-1).body, { chat: null, question: 'One more line about Friday.' });

      // A typed question about mistakes names its topic; no translator: the notice, the question back in the input, the chips off.
      await page.locator('#h5-learn-chat-new').tap();
      await page.locator('#h5-learn-chat-start').waitFor();
      mock.sendMode = '503';
      await page.locator('#h5-learn-chat-input').fill('Which words do I keep getting wrong?');
      await page.locator('#h5-learn-chat-send').tap();
      await page.locator('#h5-learn-chat-no-translator').waitFor();
      assert.deepEqual(mock.sends().at(-1).body, { chat: null, question: 'Which words do I keep getting wrong?', topic: 'mistakes' });
      assert.equal(await text(page, '#h5-learn-chat-no-translator .MuiAlert-message'), 'English chat needs a translator. Set one up in Settings → Voice and translation.');
      assert.equal(await page.locator('#h5-learn-chat-input').inputValue(), 'Which words do I keep getting wrong?');
      assert.equal(await page.locator('.h5-learn-chat-chip').first().isDisabled(), true);
      assert.equal(await text(page, '#h5-learn-chat-title'), 'New chat', 'no chat was made');

      // A chat deleted on another machine (404 "Chat not found" when it opens): a new chat in its place and the list read again.
      mock.sendMode = 'stream';
      await page.locator('#h5-learn-chat-history').tap();
      await page.locator('#h5-learn-chats .h5-learn-chat-row[data-uid="c3"]').waitFor();
      delete mock.chats.c3;
      const listReads = mock.of('GET', /^\/api\/learn\/chats$/).length;
      await page.locator('#h5-learn-chats .h5-learn-chat-row[data-uid="c3"]').tap();
      await page.locator('#h5-learn-chat-start').waitFor();
      assert.equal(await text(page, '#h5-learn-chat-title'), 'New chat');
      assert.ok(mock.of('GET', /^\/api\/learn\/chats\/c3$/).length >= 1);
      await page.waitForTimeout(200);
      assert.ok(mock.of('GET', /^\/api\/learn\/chats$/).length > listReads, 'the list is read again');
      assert.equal(await page.locator('#h5-learn-chat-load-error').count(), 0, 'no error for a chat that is gone');

      // Rename refused by the server: its message in the dialog. Unmarking a journal entry that gets pruned: a notice and a new chat.
      await page.locator('#h5-learn-chat-history').tap();
      await page.locator('#h5-learn-chats .h5-learn-chat-row[data-uid="c1"]').tap();
      await waitBubbles(page, 4);
      mock.patchMode = 'title-error';
      await openMenu(page);
      await page.locator('#h5-learn-chat-rename').tap();
      await page.locator('#h5-learn-chat-rename-dialog').waitFor({ state: 'visible' });
      await page.locator('#h5-learn-chat-title-input').fill('Friday');
      await page.locator('#h5-learn-chat-rename-save').tap();
      await page.locator('#h5-learn-chat-rename-error').waitFor();
      assert.equal(await text(page, '#h5-learn-chat-rename-error .MuiAlert-message'), 'A chat title has 1 to 60 characters');
      await page.locator('#h5-learn-chat-rename-dialog .MuiDialogActions-root button', { hasText: 'Cancel' }).tap();
      await page.locator('#h5-learn-chat-rename-dialog').waitFor({ state: 'detached' });
      mock.patchMode = 'pruned';
      assert.deepEqual(await openMenu(page), ['Not a journal entry', 'Rename', 'Delete']);
      await page.locator('#h5-learn-chat-journal').tap();
      await page.getByText('This chat was removed: only the newest 50 chats are kept.').waitFor();
      await page.locator('#h5-learn-chat-start').waitFor();
      assert.equal(await text(page, '#h5-learn-chat-title'), 'New chat');
      mock.patchMode = 'ok';
      await page.locator('#h5-learn-chat-history').tap();
      await page.locator('#h5-learn-chats .h5-learn-chat-row').first().waitFor();
      assert.equal(await page.locator('#h5-learn-chats .h5-learn-chat-row[data-uid="c1"]').count(), 0, 'the pruned chat is gone');
      await page.locator('#h5-learn-chat-new').tap();
      await page.locator('#h5-learn-chat-start').waitFor();

      // A company computer whose home is offline: the line instead of the notice; nothing can be sent.
      mock.away = 'offline';
      mock.sendMode = 'stream';
      await page.locator('#h5-learn-chat-new').tap();
      await page.locator('#h5-learn-chat-away').waitFor();
      assert.equal(await text(page, '#h5-learn-chat-away'), 'Questions are answered by your normal computer, which cannot be reached right now.');
      assert.equal(await page.locator('#h5-learn-chat-no-translator').count(), 0);
      assert.equal(await page.locator('.h5-learn-chat-chip').first().isDisabled(), true);
      await page.locator('#h5-learn-chat-input').fill('Hello');
      assert.equal(await page.locator('#h5-learn-chat-send').isDisabled(), true);
      mock.away = '';

      // Back closes the chat: the home again.
      await backPress(page);
      await page.locator('#h5-learn-mode').waitFor({ state: 'detached' });
      await entry.waitFor();
      await context.close();
    }

    // ── 1440x900 (mouse) ──
    {
      const { context, page, mock } = await openPage(browser, { viewport: { width: 1440, height: 900 }, summaryChats: 3 });
      await page.locator('#h5-nav-learn').click();
      const entry = page.locator('#h5-learn-mode-chat');
      await entry.waitFor();
      await waitText(page, '#h5-learn-mode-chat .h5-learn-count', '3 chats');
      assert.equal(mock.of('GET', /^\/api\/learn\/chats$/).length, 0, 'the count of the summary is used');
      await entry.click();
      const view = page.locator('#h5-learn-chat[data-layout="wide"]');
      await view.waitFor();
      await page.locator('#h5-learn-chats .h5-learn-chat-row').first().waitFor();
      const list = await page.locator('#h5-learn-chats').boundingBox();
      assert.equal(Math.round(list.width), 260, 'a 260px chats list');
      const pane = await page.locator('#h5-learn .h5-learn-pane').boundingBox();
      assert.ok(Math.abs(list.x - pane.x) <= 1, 'the list at the start of the right pane');
      assert.ok(Math.abs(list.height - 900) <= 1, 'the list fills the height');
      assert.equal(await text(page, '#h5-learn-chats h2'), 'Chats');
      assert.equal(await text(page, '#h5-learn-chat-new'), 'New chat');
      assert.equal(await page.locator('#h5-learn-chat-new svg').count(), 1, 'the plus icon');
      assert.equal(await text(page, '#h5-learn-view-title'), 'New chat');
      await page.locator('#h5-learn-chat-start').waitFor();
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'h5-learn-chat-input');
      assert.equal(await page.locator('#h5-learn-mode-chat').getAttribute('aria-current'), 'true', 'the home card is selected');

      await page.locator('#h5-learn-chats .h5-learn-chat-row[data-uid="c2"]').click();
      await waitBubbles(page, 4);
      await waitText(page, '#h5-learn-view-title', 'Scheduling words');
      assert.equal(await page.locator('#h5-learn-chats .h5-learn-chat-row[aria-current="true"]').getAttribute('data-uid'), 'c2');
      const inputBox = await page.locator('#h5-learn-chat-input').boundingBox();
      assert.ok(inputBox.y + inputBox.height > 820, 'the input at the bottom of the pane');
      // Shift+Enter is a new line, Enter sends.
      await page.locator('#h5-learn-chat-input').click();
      await page.keyboard.type('Why "were"?');
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type('And not "was"?');
      assert.equal(await page.locator('#h5-learn-chat-input').inputValue(), 'Why "were"?\nAnd not "was"?');
      assert.equal(mock.sends().length, 0);
      await page.keyboard.press('Enter');
      await waitBubbles(page, 6);
      assert.deepEqual(mock.sends().at(-1).body, { chat: 'c2', question: 'Why "were"?\nAnd not "was"?' });
      assert.equal(await page.locator('#h5-learn-chat-input').inputValue(), '');
      assert.deepEqual(await texts(page, '#h5-learn-chats .h5-learn-chat-row-title'), ['Scheduling words', 'A slow Friday deploy', 'Code review with Lin'], 'the chat moves to the top');
      // The menu is there too.
      await page.locator('#h5-learn-chat-more').click();
      assert.deepEqual(await texts(page, '#h5-learn-chat-menu .MuiMenuItem-root'), ['Mark as journal entry', 'Rename', 'Delete']);
      await page.keyboard.press('Escape');
      await menuGone(page);
      assert.equal(await view.count(), 1, 'Escape closes the menu first');
      await page.locator('#h5-learn-chats .h5-learn-chat-row[data-uid="c1"]').click();
      await waitBubbles(page, 2);
      await shot(page, 'learn-chat-desktop.png');
      // New chat in the list: the start screen in the same pane.
      await page.locator('#h5-learn-chat-new').click();
      await page.locator('#h5-learn-chat-start').waitFor();
      assert.equal(await page.locator('#h5-learn-chats .h5-learn-chat-row[aria-current="true"]').count(), 0);
      // Escape closes the chat.
      await page.locator('#h5-learn-chat-input').focus();
      await page.keyboard.press('Escape');
      await view.waitFor({ state: 'detached' });
      assert.equal(await text(page, '#h5-learn-view-title'), 'How learning works');
      await context.close();
    }

    assert.deepEqual(pageErrors, []);
    console.log('Learn chat browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
