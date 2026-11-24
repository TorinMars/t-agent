// Learn: the English coach (scripts/h5-shell/LearnCoach.jsx and the practice series of Learn.jsx), in real Chromium with every route mocked by a
// stub that follows the coach contract ("Learn English: the coach, the page" in docs/design/learn-english-coach-page.md): GET /api/learn/coach (pages
// with `before`, `has_more`, `tools_ok`), POST /coach/send and /coach/practice-result (NDJSON: `status`, `delta`, `proposals`, `remembered`, `done`
// with the stored messages, `tools` and `usage`), /coach/proposals/:id/run|cancel, /coach/undo, /coach/plans/start, /coach/notes, /coach/summary/reset;
// answers go to the existing POST /cards/:id/answer. No model is ever called; one answer is fed piece by piece through a fetch stand-in.
// - 390x844 (touch): Learn is only the coach (no home; her back arrow closes Learn); the chat without the bottom navigation and with a message list of at least 55% of the window; the conversation with older pages read when scrolled to the top; a streamed answer with the status line, the
//   plan card in one row and the usage line (one line, opened by a tap); Start runs the series (Spell; a miss comes back at the end) and returns with the result and her reply; the
//   mistakes series (Spell, Fill the gap, Dictation left out without speech output, the retest) with its header; leaving early; the settings,
//   cards and reminder cards (Cancel, run, Undo); the Remembered line and its Undo; suggestions as a strip of chips above the input; "tools: false"; the buttons of open_screen
//   (Mistakes, Progress, How learning works) whose back returns to her; the menu with Learn settings (the coach group: switches, the notes edited and
//   deleted with Undo, Save tokens, Reset the summary); Earlier chats read-only.
// - 1440x900 (mouse): the coach fills the page (no home column), the series in the same place and back, Escape leaves a series early, a screen
//   button and a link (/h5?learn=progress) open a screen whose × returns to her, Earlier chats read-only, Escape from her closes Learn.
// - A company computer whose home is away: the coach says so; the menu still opens Learn settings.
// - An engine without the coach (GET /coach answers 404): the old English chat, unchanged.
// H5_SHOT_DIR=<dir> saves learn-coach-*.png.
const { chromium } = require('playwright');
const { bnavTap } = require('./h5-bottom-nav-tap.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

process.env.T_AGENT_DATA_DIR = process.env.T_AGENT_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-learn-coach-browser-'));

const { activityStreamMock } = require('./h5-activity-stream-mock.cjs');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const TASKS = [{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }];
const TERMINALS = { 1: [{ terminal_id: 'c1', title: 'Claude: login fix', agent: 'claude' }] };
const ZH = '\u5fc5\u8981\u7684'; // Chinese user content, escaped (Chinese is allowed only in the dictionaries)
const pageErrors = [];

const word = (id, en, extra = {}) => ({ id, kind: 'word', en, zh: ZH, source: 'manual', context: '', reps: 1, lapses: 0, suspended: false, ...extra });
const sentence = (id, en) => ({ id, kind: 'sentence', en, zh: ZH, source: 'translation', context: '', reps: 1, suspended: false });
const SPELLING = [word(1, 'separate'), word(2, 'receive'), word(3, 'necessary')];
const MISTAKES = [word(4, 'occurred'), word(5, 'committee', { context: 'The committee met on Monday.' })];
const LONG = Array.from({ length: 25 }, (_, i) => word(100 + i, `word${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}x`));

function coachMock({ coach = true, away = '' } = {}) {
  const mock = { requests: [], clock: Date.parse('2026-11-24T10:00:00.000Z'), seq: 0, settings: { collect: true, daily_goal: 20, starter: null, new_per_day: 10, coach_memory: true, coach_read_answers: true, coach_read_text: true, coach_economy: false } };
  const at = () => { mock.clock += 1000; return new Date(mock.clock).toISOString(); };
  // 60 earlier messages: the first page has the newest 50.
  mock.messages = Array.from({ length: 60 }, (_, i) => ({ uid: `h${i}`, role: i % 2 ? 'assistant' : 'user', text: `Old message ${i}`, at: new Date(Date.parse('2026-11-20T00:00:00.000Z') + i * 60000).toISOString(), meta: {} }));
  mock.notes = [{ uid: 'n1', text: 'Goal: spoken English for work meetings', until: null, created_at: '2026-11-20T02:00:00.000Z' }, { uid: 'n2', text: 'Prefers short answers', until: null, created_at: '2026-11-22T02:00:00.000Z' }];
  mock.plans = {};
  const answerOf = (text, meta = {}) => ({ uid: `a${++mock.seq}`, role: 'assistant', text, at: at(), meta });
  const questionOf = text => ({ uid: `q${++mock.seq}`, role: 'user', text, at: at(), meta: {} });
  const plan = (id, kind, title, steps, minutes) => ({ id, kind: 'practice', plan: { kind, title, steps: steps.map(([mode, cards]) => ({ mode, card_ids: cards.map(one => one.id) })), words: new Set(steps.flatMap(([, cards]) => cards.map(one => one.id))).size, minutes, notes: '' }, state: 'open', _cards: steps });
  // The answer to a question: [stream lines before done, the stored answer].
  mock.reply = text => {
    if (/today's spelling/i.test(text)) {
      const proposal = plan('p-spell', 'today_spelling', "Today's spelling", [['spell', SPELLING]], 1);
      mock.plans[proposal.id] = proposal;
      const clean = { ...proposal }; delete clean._cards;
      return { lines: [{ type: 'status', text: 'Looking at your answers' }, { delta: 'You have **3 words** due. ' }, { delta: 'About a minute.' }, { type: 'proposals', proposals: [clean] }],
        answer: answerOf('You have **3 words** due. About a minute.', { proposals: [clean], usage: { calls: 3, tool_rounds: 2, prompt_tokens: 18000, completion_tokens: 400 } }), usage: { calls: 3, tool_rounds: 2, prompt_tokens: 18000, completion_tokens: 400 } };
    }
    if (/wrong answers/i.test(text)) {
      const proposal = plan('p-mistakes', 'mistakes_series', 'Your mistakes', [['spell', MISTAKES], ['fill', [MISTAKES[1]]], ['dictation', [sentence(9, 'We shipped it on time.')]], ['retest', []]], 4);
      mock.plans[proposal.id] = proposal;
      const clean = { ...proposal }; delete clean._cards;
      return { lines: [{ delta: 'A series for your mistakes.' }], answer: answerOf('A series for your mistakes.', { proposals: [clean], usage: { calls: 1, tool_rounds: 0 } }) };
    }
    if (/25 words/i.test(text)) {
      const proposal = plan('p-long', 'today_spelling', 'Spelling', [['spell', LONG]], 8);
      mock.plans[proposal.id] = proposal;
      const clean = { ...proposal }; delete clean._cards;
      return { lines: [], answer: answerOf('Here you go.', { proposals: [clean] }) };
    }
    if (/15 new words/i.test(text)) {
      const proposals = [
        { id: 'p-set', kind: 'settings', changes: { new_per_day: 15 }, state: 'open' },
        { id: 'p-cards', kind: 'cards', add: ['reconcile', 'mitigate', 'ambiguous', 'leverage', 'deprecate', 'idempotent'].map(en => ({ kind: 'word', en, zh: ZH })), state: 'open' },
        { id: 'p-rem', kind: 'reminder', time: '20:00', days: [], text: "Today's English practice", time_zone: 'Asia/Taipei', state: 'open' },
      ];
      return { lines: [{ type: 'proposals', proposals }], answer: answerOf('Three things. Nothing changes until you tap each one:', { proposals }) };
    }
    if (/interview/i.test(text)) {
      const note = { uid: 'n9', text: 'job interview in March', until: '2027-03-31', created_at: new Date(mock.clock).toISOString() };
      mock.notes.push(note);
      return { lines: [{ delta: 'Good to know.' }, { type: 'remembered', note }], answer: answerOf('Good to know. We can practise interview answers.') };
    }
    if (/show my mistakes/i.test(text)) return { lines: [{ delta: 'Here are your mistakes and your progress.' }], answer: answerOf('Here are your mistakes and your progress.', { screens: ['mistakes', 'progress', 'dictation'] }) };
    if (/how does learning work/i.test(text)) return { lines: [{ delta: 'It is all explained here.' }], answer: answerOf('It is all explained here.', { screens: ['how'] }) };
    if (/tools off/i.test(text)) return { lines: [{ delta: 'From the summary: 12 due.' }], answer: answerOf('From the summary: 12 due.'), tools: false };
    return { lines: [{ delta: 'Sure.' }], answer: answerOf('Sure.') };
  };
  mock.stream = (lines, done) => ({ ndjson: [...lines, { type: 'done', ...done }] });
  mock.handle = (p, method, url, body) => {
    mock.requests.push({ method, path: p, search: url.search, body });
    if (p === '/api/learn/summary') return { due: 3, new_today: 0, done_today: 0, goal: 20, streak: 2, words: 40, sentences: 5, mistakes: 2, chats: 2, collecting: true };
    if (p === '/api/learn/settings' && method === 'GET') return mock.settings;
    if (p === '/api/learn/settings' && method === 'PUT') { mock.settings = { ...mock.settings, ...body }; return mock.settings; }
    if (p === '/api/learn/chats' && method === 'GET') return { chats: [{ uid: 'c1', title: 'Scheduling words', journal: false, journal_by: '', created_at: '2026-11-19T02:00:00.000Z', updated_at: '2026-11-19T02:05:00.000Z', count: 2 }, { uid: 'c2', title: 'A slow deploy', journal: true, journal_by: 'model', created_at: '2026-11-18T02:00:00.000Z', updated_at: '2026-11-18T02:05:00.000Z', count: 2 }], translator: true };
    const old = p.match(/^\/api\/learn\/chats\/(c\d)$/);
    if (old) return { chat: { uid: old[1], title: old[1] === 'c1' ? 'Scheduling words' : 'A slow deploy', journal: false, count: 2 }, messages: [{ uid: `${old[1]}q`, role: 'user', text: 'How do I say it?', at: '2026-11-19T02:00:00.000Z' }, { uid: `${old[1]}a`, role: 'assistant', text: 'Say **we scheduled it**.', at: '2026-11-19T02:05:00.000Z', cards: [], mistakes: [] }] };
    if (p === '/api/learn/mistakes') return { mistakes: [], total: 0 };
    if (p === '/api/learn/reports' && method === 'GET') return { reports: [], since: { from: null, mistakes: 0, answers: 0 }, model: { ready: false, label: '', name: '' }, running: false, auto: true };
    const answered = p.match(/^\/api\/learn\/cards\/(\d+)\/answer$/);
    if (answered) return { card: { id: Number(answered[1]) } };
    if (!p.startsWith('/api/learn/coach')) return [404, { error: 'not mocked' }];
    if (!coach) return [404, { error: 'Not found' }];
    if (p === '/api/learn/coach' && method === 'GET') {
      const before = url.searchParams.get('before');
      const limit = Number(url.searchParams.get('limit')) || 50;
      const older = mock.messages.filter(one => !before || Date.parse(one.at) < Date.parse(before));
      const page = older.slice(-limit);
      // A company computer whose home is away: no messages, said as such (routes/learn.js GET /coach).
      if (away) return { messages: [], has_more: false, tools_ok: false, translator: false, settings: { memory: true, read_answers: true, read_text: true, economy: false }, offline: away === 'offline', home_older: away === 'older' };
      return { messages: page, has_more: older.length > page.length, tools_ok: true, settings: { memory: true, read_answers: true, read_text: true, economy: false } };
    }
    if (p === '/api/learn/coach/send') {
      const question = questionOf(body.text);
      const reply = mock.reply(body.text);
      mock.messages.push(question, reply.answer);
      return mock.stream(reply.lines, { message: reply.answer, user: question, tools: reply.tools !== false, ...(reply.usage ? { usage: reply.usage } : {}) });
    }
    if (p === '/api/learn/coach/practice-result') {
      const planned = Object.values(mock.plans).find(one => one.id === String(body.plan_id).replace(/^run-/, ''));
      const practice = { uid: `r${++mock.seq}`, role: 'practice', text: '', at: at(), meta: { practice: { ...body, kind: planned ? planned.plan.kind : '' } } };
      const answer = answerOf(body.stopped ? 'You stopped early. Go on later?' : `Nice work: ${body.right} of ${body.total} right.`, { suggestions: ['Practise the 1 I missed', '5 more new words', "That's enough for today"] });
      mock.messages.push(practice, answer);
      return mock.stream([{ delta: answer.text }], { messages: [practice, answer], tools: true });
    }
    if (p === '/api/learn/coach/plans/start') {
      const found = mock.plans[body.proposal_id];
      if (!found) return { empty: true };
      return { plan: { id: `run-${found.id}`, steps: found._cards.map(([mode, cards]) => ({ mode, cards })), minutes: found.plan.minutes } };
    }
    const action = p.match(/^\/api\/learn\/coach\/proposals\/([^/]+)\/(run|cancel)$/);
    if (action) {
      if (action[2] === 'cancel') return { ok: true, proposal: { id: action[1], state: 'cancelled' } };
      if (action[1] === 'p-set') mock.settings = { ...mock.settings, new_per_day: 15 };
      return { ok: true, proposal: { id: action[1], state: 'done' }, ...(action[1] === 'p-set' ? { undo: { token: 'tok-set', expires_at: new Date(Date.now() + 10000).toISOString() } } : {}) };
    }
    if (p === '/api/learn/coach/undo') { if (body.token === 'tok-set') mock.settings = { ...mock.settings, new_per_day: 10 }; return { ok: true }; }
    if (p === '/api/learn/coach/notes' && method === 'GET') return { notes: mock.notes };
    const note = p.match(/^\/api\/learn\/coach\/notes\/([^/]+)$/);
    if (note && method === 'PATCH') { const one = mock.notes.find(item => item.uid === note[1]); Object.assign(one, body); return { note: one }; }
    if (note && method === 'DELETE') { mock.notes = mock.notes.filter(item => item.uid !== note[1]); return { ok: true }; }
    if (p === '/api/learn/coach/summary/reset') return { ok: true };
    return [404, { error: 'not mocked' }];
  };
  mock.of = (method, re) => mock.requests.filter(item => item.method === method && re.test(item.path));
  return mock;
}

// A fetch stand-in for the answer the test feeds: `window.coachFeed.manual = true`, then `coachFeed.push(line)` and `coachFeed.end()`.
function coachFeedMock() {
  const encoder = new TextEncoder();
  const realFetch = window.fetch.bind(window);
  window.coachFeed = { manual: false, bodies: [], controller: null, push(item) { this.controller.enqueue(encoder.encode(`${JSON.stringify(item)}\n`)); }, end() { this.controller.close(); } };
  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (window.coachFeed.manual && /\/api\/learn\/coach\/send$/.test(url) && init.method === 'POST') {
      window.coachFeed.bodies.push(JSON.parse(init.body));
      const body = new ReadableStream({ start(controller) { window.coachFeed.controller = controller; } });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } }));
    }
    return realFetch(input, init);
  };
}

async function openPage(browser, { viewport, touch = false, coach = true, away = '', at = '/h5' }) {
  const context = await browser.newContext({ viewport, timezoneId: 'Asia/Taipei', ...(touch ? { isMobile: true, hasTouch: true } : {}), ...(SHOTS ? { deviceScaleFactor: 3 } : {}) });
  const page = await context.newPage();
  const mock = coachMock({ coach, away });
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
    // No speech output: Dictation is left out of a series.
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: undefined });
  });
  await page.addInitScript(activityStreamMock);
  await page.addInitScript(coachFeedMock);
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
  await page.goto(`${ORIGIN}${at}`);
  return { context, page, mock };
}

const text = (page, selector) => page.locator(selector).first().evaluate(el => el.textContent.replace(/\s+/g, ' ').trim());
const texts = (page, selector) => page.locator(selector).evaluateAll(list => list.map(el => el.textContent.replace(/\s+/g, ' ').trim()));
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, name) }); } };
const waitFor = async (check, message, timeout = 8000) => {
  const end = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error(`Timed out: ${message}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
const waitText = (page, selector, want) => page.waitForFunction(([sel, value]) => (document.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim() === value, [selector, want]);
const settled = page => page.waitForFunction(() => document.querySelector('#h5-learn-coach') && !document.querySelector('#h5-learn-coach [data-streaming]'));
const press = (page, selector, touch) => (touch ? page.locator(selector).first().tap() : page.locator(selector).first().click());

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

// Send a text through the input.
async function say(page, value, touch) {
  await page.locator('#h5-learn-coach-input').fill(value);
  await press(page, '#h5-learn-coach-send', touch);
}

// Answer the current card of a series with `value` and take the offered grade; returns whether it was right.
async function answer(page, mock, value, touch) {
  const before = mock.of('POST', /\/answer$/).length;
  const exercise = await page.locator('#h5-learn-series').getAttribute('data-exercise');
  const field = exercise === 'fill' ? '#h5-learn-gap-input' : exercise === 'dictation' ? '#h5-learn-dictation-input' : '#h5-learn-spell-input';
  await page.locator(field).fill(value);
  const feedback = page.locator('#h5-learn-feedback');
  try { await feedback.waitFor({ timeout: 1500 }); } catch { await press(page, '#h5-learn-check', touch); await feedback.waitFor(); }
  const right = (await feedback.getAttribute('data-correct')) === 'true';
  await press(page, right ? '#h5-learn-grade-good' : '#h5-learn-grade-again', touch);
  await waitFor(() => mock.of('POST', /\/answer$/).length === before + 1, 'the answer is posted');
  return right;
}
const subtitle = (page, phone) => text(page, phone ? '#h5-learn-mode .h5-learn-subtitle' : '#h5-learn .h5-learn-subtitle');
// A phone's header line: the small text before the counter ("Step 1 of 3 \u00b7 from your chat").
const note = page => text(page, '#h5-learn-mode .h5-learn-subtitle-note');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    // ── 390x844 (touch) ──
    {
      const touch = true;
      const { context, page, mock } = await openPage(browser, { viewport: { width: 390, height: 844 }, touch });
      await toTerminal(page);
      await bnavTap(page, '#h5-bnav-learn');
      // Learn is only the coach: no home under her, no card or button of the old home anywhere.
      await page.locator('#h5-learn[data-coach="only"] #h5-learn-coach[data-layout="phone"]').waitFor();
      assert.equal(await page.locator('.h5-learn-home, #h5-learn-mode-chat, #h5-learn-today, #h5-learn-settings, #h5-learn-how, #h5-learn-material').count(), 0, 'no Learn home');
      await waitFor(async () => (await page.locator('#h5-learn-coach .h5-learn-chat-msg').count()) === 50, 'the newest page of 50 messages');
      assert.equal(await text(page, '#h5-learn-coach-title'), 'English chat');
      // The chat takes the whole window on a phone: no bottom navigation, the input at the bottom, the message list at least 55% of the height.
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-bnav'));
      assert.equal(await page.locator('#h5-bnav').isVisible(), false, 'no bottom navigation in the coach chat');
      const room = await page.evaluate(() => {
        const list = document.getElementById('h5-learn-coach-scroll').getBoundingClientRect();
        const form = document.getElementById('h5-learn-coach-input').closest('form').getBoundingClientRect();
        return { list: list.height, bottom: form.bottom, height: window.innerHeight };
      });
      assert.ok(room.list >= room.height * 0.55, `the message list is ${room.list}px of ${room.height}px`);
      assert.ok(room.height - room.bottom <= 1, `the input sits at the bottom (${room.bottom} of ${room.height})`);
      assert.equal(await page.locator('#h5-learn-chat-new, #h5-learn-chats, #h5-learn-chat-history').count(), 0, 'no New chat, no chats list');
      assert.equal(await page.locator('#h5-learn-coach-input').getAttribute('placeholder'), 'Reply or write more');
      const more = await page.locator('#h5-learn-coach-more').boundingBox();
      assert.ok(more.width >= 44 && more.height >= 44, 'a 44px target');
      // The view starts at the newest message; scrolled to the top it reads the page before it.
      assert.ok(await page.locator('#h5-learn-coach-scroll').evaluate(el => el.scrollTop > 100), 'starts at the bottom');
      await page.locator('#h5-learn-coach-scroll').evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
      await waitFor(async () => (await page.locator('#h5-learn-coach .h5-learn-chat-msg').count()) === 60, 'the older messages');
      const pages = mock.of('GET', /^\/api\/learn\/coach$/).map(one => one.search);
      assert.ok(pages.some(search => /before=2026-11-20T00%3A10%3A00.000Z/.test(search) || /before=2026-11-20T00:10:00.000Z/.test(decodeURIComponent(search))), `read before the oldest (${pages.join(' ')})`);
      assert.ok(await page.locator('#h5-learn-coach-scroll').evaluate(el => el.scrollTop > 50), 'what was in view stays in view');
      await shot(page, 'learn-coach-phone.png');

      // Frame 1: the status line while she looks things up, the streamed answer, the plan card and the usage line.
      await page.evaluate(() => { window.coachFeed.manual = true; });
      await say(page, "Give me today's spelling practice", touch);
      await waitFor(() => page.evaluate(() => window.coachFeed.bodies.length === 1), 'the question is sent');
      assert.deepEqual(await page.evaluate(() => window.coachFeed.bodies[0]), { text: "Give me today's spelling practice" });
      const fed = mock.reply("Give me today's spelling practice");
      mock.messages.push({ uid: 'qf', role: 'user', text: "Give me today's spelling practice", at: fed.answer.at }, fed.answer);
      await page.evaluate(line => window.coachFeed.push(line), fed.lines[0]);
      await waitText(page, '#h5-learn-coach-status', 'Looking at your answers…');
      await page.evaluate(line => window.coachFeed.push(line), fed.lines[1]);
      await page.waitForFunction(() => document.querySelector('#h5-learn-coach [data-streaming="true"] strong')?.textContent === '3 words');
      assert.equal(await page.locator('#h5-learn-coach-status').count(), 0, 'the status line goes when the answer comes');
      await page.evaluate(lines => { for (const line of lines) window.coachFeed.push(line); }, fed.lines.slice(2));
      await page.evaluate(done => { window.coachFeed.push({ type: 'done', message: done.answer, tools: true, usage: done.usage }); window.coachFeed.end(); }, fed);
      await settled(page);
      await page.evaluate(() => { window.coachFeed.manual = false; });
      const planCard = page.locator('.h5-learn-coach-card[data-type="plan"][data-id="p-spell"]');
      await planCard.waitFor();
      assert.equal(await text(page, '.h5-learn-coach-card[data-id="p-spell"] .h5-learn-coach-plan-title'), "Today's spelling");
      assert.equal(await text(page, '.h5-learn-coach-card[data-id="p-spell"] .h5-learn-coach-plan-caption'), '3 words · about 1 minute');
      // The plan card is one row: the icon, the title and its caption, Start at the right.
      const row = await planCard.evaluate(card => {
        const box = el => card.querySelector(el).getBoundingClientRect();
        return { card: card.getBoundingClientRect().height, start: box('.h5-learn-coach-start'), title: box('.h5-learn-coach-plan-title') };
      });
      assert.ok(row.card <= 72, `a compact card (${row.card}px)`);
      assert.ok(row.start.left > row.title.right && row.start.height >= 44, 'Start at the right of the title, 44px high');
      // The usage caption: one line of its first part; a tap shows all of it.
      const usage = page.locator('.h5-learn-coach-answer:last-of-type .h5-learn-coach-usage');
      assert.equal(await text(page, '.h5-learn-coach-answer:last-of-type .h5-learn-coach-usage'), 'Looked at your data 2 times');
      assert.equal(await usage.getAttribute('aria-expanded'), 'false');
      await usage.tap();
      assert.equal(await text(page, '.h5-learn-coach-answer:last-of-type .h5-learn-coach-usage'), 'Looked at your data 2 times · 3 calls · 18,400 tokens');
      assert.equal(await usage.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('.h5-learn-coach-start').count(), 1, 'one Start button');
      // The question the stream did not send back stays as the page's own copy, before the answer.
      const lastRoles = await page.locator('#h5-learn-coach .h5-learn-chat-msg').evaluateAll(list => list.slice(-2).map(el => [el.dataset.role, el.textContent]));
      assert.deepEqual(lastRoles, [['user', "Give me today's spelling practice"], ['assistant', 'You have 3 words due. About a minute.']]);
      await shot(page, 'learn-coach-plan.png');

      // Frames 2 and 3: Start runs the series (a miss comes back at the end) and returns with the result and her reply.
      await planCard.locator('.h5-learn-coach-start').tap();
      await page.locator('#h5-learn-series').waitFor();
      assert.deepEqual(mock.of('POST', /plans\/start$/).at(-1).body, { message_uid: fed.answer.uid, proposal_id: 'p-spell' });
      assert.equal(await text(page, '#h5-learn-view-title'), 'Spell the word');
      assert.equal(await subtitle(page, true), '1 / 3');
      assert.equal(await note(page), 'from your chat');
      // One header line: the title, the small note and the counter side by side; the arrow is named "Back to chat"; no chip row.
      const line = await page.evaluate(() => ['#h5-learn-view-title', '#h5-learn-mode .h5-learn-subtitle-note', '#h5-learn-mode .h5-learn-subtitle'].map(sel => {
        const box = document.querySelector(sel).getBoundingClientRect();
        return Math.round(box.top + box.height / 2);
      }));
      assert.ok(Math.max(...line) - Math.min(...line) <= 3, `the header is one line (${line})`);
      assert.equal(await page.locator('#h5-learn-back').getAttribute('aria-label'), 'Back to chat');
      assert.equal(await page.locator('#h5-learn-back').getAttribute('title'), 'Back to chat');
      assert.equal(await page.locator('#h5-learn-series-note').count(), 0, 'no "Back to chat when done" row');
      await shot(page, 'learn-coach-series.png');
      assert.equal(await answer(page, mock, 'separate', touch), true);
      assert.equal(await answer(page, mock, 'recieve', touch), false);
      assert.equal(await answer(page, mock, 'necessary', touch), true);
      await waitFor(async () => (await subtitle(page, true)) === '4 / 4', 'the missed word at the end');
      assert.equal(await answer(page, mock, 'receive', touch), true);
      await page.locator('#h5-learn-coach').waitFor();
      await page.locator('.h5-learn-coach-divider', { hasText: 'Spelling finished · 3 words · 1 min' }).waitFor();
      await settled(page);
      const result = mock.of('POST', /practice-result$/).at(-1).body;
      assert.equal(result.plan_id, 'run-p-spell');
      assert.equal(result.message_uid, fed.answer.uid);
      assert.deepEqual([result.done, result.total, result.right, result.stopped], [3, 3, 2, undefined]);
      assert.deepEqual(result.missed, [{ en: 'receive', typed: 'recieve' }]);
      assert.deepEqual(result.steps, [{ mode: 'spell', total: 4, done: 4, right: 3 }]);
      assert.deepEqual(mock.of('POST', /\/answer$/).map(one => [one.path.split('/')[4], one.body.mode, one.body.correct]), [['1', 'spell', true], ['2', 'spell', false], ['3', 'spell', true], ['2', 'spell', true]]);
      await page.locator('.h5-learn-chat-msg[data-role="assistant"]', { hasText: 'Nice work: 2 of 3 right.' }).waitFor();
      assert.deepEqual(await texts(page, '.h5-learn-coach-suggestion'), ['Practise the 1 I missed', '5 more new words', "That's enough for today"]);
      // "What next?": one line of 44px chips right above the input, outside the message list, scrolling sideways; the first in the primary colour.
      const strip = await page.evaluate(() => {
        const next = document.getElementById('h5-learn-coach-next');
        const chips = [...next.querySelectorAll('.h5-learn-coach-suggestion')].map(el => el.getBoundingClientRect());
        const form = document.getElementById('h5-learn-coach-input').closest('form').getBoundingClientRect();
        return {
          inList: Boolean(next.closest('#h5-learn-coach-scroll')), tops: [...new Set(chips.map(one => Math.round(one.top)))], heights: chips.map(one => one.height),
          above: next.getBoundingClientRect().bottom <= form.top + 1, overflow: getComputedStyle(next).overflowX, label: next.getAttribute('aria-label'),
          primary: next.querySelector('.h5-learn-coach-suggestion').classList.contains('MuiChip-colorPrimary'),
        };
      });
      assert.deepEqual([strip.inList, strip.tops.length, strip.above, strip.overflow, strip.label, strip.primary], [false, 1, true, 'auto', 'What next?', true], JSON.stringify(strip));
      assert.ok(strip.heights.every(one => one >= 44), `44px chips (${strip.heights})`);
      await shot(page, 'learn-coach-result.png');
      // A suggestion sends its text.
      await page.locator('.h5-learn-coach-suggestion').nth(2).tap();
      await waitFor(() => mock.of('POST', /coach\/send$/).at(-1).body.text === "That's enough for today", 'the suggestion is sent');
      await settled(page);
      assert.equal(await page.locator('.h5-learn-coach-suggestion').count(), 0, 'suggestions only under the newest answer');

      // The mistakes series: Spell, Fill the gap, Dictation left out without speech output, the retest of what was missed.
      await say(page, 'I want to practise my wrong answers', touch);
      const mistakes = page.locator('.h5-learn-coach-card[data-id="p-mistakes"]');
      await mistakes.waitFor();
      assert.deepEqual(await texts(page, '.h5-learn-coach-card[data-id="p-mistakes"] .h5-learn-coach-plan-steps li'), ['Spell each word', 'Fill the gap inside a sentence', 'Dictation', 'A final retest of the words you missed again']);
      await mistakes.locator('.h5-learn-coach-start').tap();
      await page.locator('#h5-learn-series').waitFor();
      assert.equal(await subtitle(page, true), '1 / 2');
      assert.equal(await note(page), 'Step 1 of 3 · from your chat');
      assert.equal(await answer(page, mock, 'ocurred', touch), false);
      assert.equal(await answer(page, mock, 'committee', touch), true);
      await waitFor(async () => (await page.locator('#h5-learn-series').getAttribute('data-exercise')) === 'fill', 'Fill the gap');
      assert.equal(await subtitle(page, true), '1 / 1');
      assert.equal(await note(page), 'Step 2 of 3 · from your chat');
      assert.equal(await text(page, '#h5-learn-view-title'), 'Fill the gap');
      assert.equal(await text(page, '.h5-learn-gap'), 'The met on Monday.', 'the word asked inside its own sentence');
      assert.equal(await answer(page, mock, 'committee', touch), true);
      await waitFor(async () => (await text(page, '#h5-learn-view-title')) === 'Final retest', 'the retest');
      assert.equal(await subtitle(page, true), '1 / 1');
      assert.equal(await note(page), 'Step 3 of 3 · from your chat');
      assert.equal(await answer(page, mock, 'occurred', touch), true);
      await page.locator('.h5-learn-coach-divider', { hasText: 'Practice finished · 2 words · 1 min' }).waitFor();
      await settled(page);
      const series = mock.of('POST', /\/answer$/).slice(-4).map(one => [one.path.split('/')[4], one.body.mode]);
      assert.deepEqual(series, [['4', 'spell'], ['5', 'spell'], ['5', 'fill'], ['4', 'spell']]);
      assert.deepEqual(mock.of('POST', /practice-result$/).at(-1).body.steps.map(one => one.mode), ['spell', 'fill', 'retest']);

      // Leaving early: what was answered is kept; "Stopped after 2 of 25".
      await say(page, 'Spell 25 words', touch);
      await page.locator('.h5-learn-coach-card[data-id="p-long"] .h5-learn-coach-start').tap();
      await page.locator('#h5-learn-series').waitFor();
      await answer(page, mock, LONG[0].en, touch);
      await answer(page, mock, LONG[1].en, touch);
      await page.locator('#h5-learn-back').tap();
      await page.locator('.h5-learn-coach-divider[data-stopped="true"]', { hasText: 'Stopped after 2 of 25' }).waitFor();
      await settled(page);
      const stopped = mock.of('POST', /practice-result$/).at(-1).body;
      assert.deepEqual([stopped.stopped, stopped.done, stopped.total, stopped.right], [true, 2, 25, 2]);

      // Frame 3c: settings, cards and reminder cards; nothing changes until a tap; Undo for 10 s.
      await say(page, 'Make it 15 new words a day, and add these words. Remind me at 8 pm every day.', touch);
      await page.locator('.h5-learn-coach-card[data-id="p-rem"]').waitFor();
      assert.equal(await text(page, '.h5-learn-coach-card[data-id="p-set"] .h5-learn-coach-setting'), 'New words a day: 10 → 15');
      assert.equal(await text(page, '.h5-learn-coach-card[data-id="p-cards"] .MuiTypography-overline'), 'Add 6 words');
      assert.deepEqual(await texts(page, '.h5-learn-coach-card[data-id="p-cards"] .h5-learn-coach-chip'), ['reconcile', 'mitigate', 'ambiguous', '+3']);
      assert.equal(await text(page, '.h5-learn-coach-card[data-id="p-rem"] .h5-learn-coach-reminder'), 'Every day at 20:00 (Taipei time): "Today\'s English practice". Tapping it opens this chat.');
      assert.deepEqual(await texts(page, '.h5-learn-coach-card[data-id="p-set"] button'), ['Cancel', 'Change']);
      assert.equal(mock.of('POST', /proposals\//).length, 0, 'nothing is run before a tap');
      await shot(page, 'learn-coach-proposals.png');
      await page.locator('.h5-learn-coach-card[data-id="p-cards"] .h5-learn-coach-cancel').tap();
      await page.locator('.h5-learn-coach-card[data-id="p-cards"][data-state="cancelled"]').waitFor();
      assert.equal(await text(page, '.h5-learn-coach-card[data-id="p-cards"] .h5-learn-coach-state'), 'Cancelled');
      await page.locator('.h5-learn-coach-card[data-id="p-set"] .h5-learn-coach-run').tap();
      await page.locator('.h5-learn-coach-card[data-id="p-set"] .h5-learn-coach-undo').waitFor();
      assert.equal(await text(page, '.h5-learn-coach-card[data-id="p-set"] .h5-learn-coach-state'), 'ChangedUndo');
      assert.deepEqual(mock.of('POST', /proposals\/p-set\/run$/).at(-1).body, { message_uid: mock.messages.at(-1).uid });
      await page.locator('.h5-learn-coach-card[data-id="p-set"] .h5-learn-coach-undo').tap();
      await page.locator('.h5-learn-coach-card[data-id="p-set"][data-state="undone"]').waitFor();
      assert.deepEqual(mock.of('POST', /coach\/undo$/).at(-1).body, { token: 'tok-set' });
      await page.locator('.h5-learn-coach-card[data-id="p-rem"] .h5-learn-coach-run').tap();
      await page.locator('.h5-learn-coach-card[data-id="p-rem"][data-state="done"]').waitFor();
      assert.equal(await text(page, '.h5-learn-coach-card[data-id="p-rem"] .h5-learn-coach-state'), 'Reminder set', 'no Undo without a token');

      // Frame 3d: "Remembered: … · Undo".
      await say(page, 'I have a job interview in March, in English.', touch);
      const remembered = page.locator('.h5-learn-coach-remembered[data-state="undo"]');
      await remembered.waitFor();
      assert.equal(await text(page, '.h5-learn-coach-remembered[data-state="undo"]'), 'Remembered: job interview in March (until 31 Mar)Undo');
      await remembered.locator('.h5-learn-coach-remembered-undo').tap();
      await page.locator('.h5-learn-coach-remembered[data-state="forgotten"]').waitFor();
      assert.equal(mock.of('DELETE', /coach\/notes\/n9$/).length, 1);

      // A service without tools.
      assert.equal(await page.locator('#h5-learn-coach-no-tools').count(), 0);
      await say(page, 'tools off: how many are due?', touch);
      await waitText(page, '#h5-learn-coach-no-tools', 'This service cannot look up your data; she answers from a short summary.');
      await settled(page);

      // The buttons of open_screen: one per screen this browser can open (no Dictation without speech output), 44px high; each opens its screen,
      // whose back arrow returns to her.
      await say(page, 'Show my mistakes', touch);
      await page.locator('.h5-learn-coach-screens').waitFor();
      await settled(page);
      assert.deepEqual(await texts(page, '.h5-learn-coach-screen'), ['Mistakes', 'Progress']);
      assert.ok((await page.locator('.h5-learn-coach-screen').first().boundingBox()).height >= 44, 'a 44px button');
      await shot(page, 'learn-coach-screens.png');
      for (const [screen, title] of [['mistakes', 'Mistakes'], ['progress', 'Progress']]) {
        await page.locator(`.h5-learn-coach-screen[data-screen="${screen}"]`).tap();
        await waitText(page, '#h5-learn-view-title', title);
        // The screen slides in over her as a page of its own (she stays under it, so her conversation is kept).
        assert.equal(await page.locator('#h5-learn-mode #h5-learn-view-title').isVisible(), true, `${title} over the coach`);
        await page.locator('#h5-learn-back').tap();
        await page.locator('#h5-learn-mode').waitFor({ state: 'detached' });
        await page.locator('#h5-learn-coach').waitFor();
        await settled(page);
      }
      await say(page, 'How does learning work?', touch);
      await page.locator('.h5-learn-coach-screen[data-screen="how"]').waitFor();
      await settled(page);
      await page.locator('.h5-learn-coach-screen[data-screen="how"]').tap();
      await waitText(page, '#h5-learn-view-title', 'How learning works');
      await page.locator('#h5-learn-back').tap();
      await page.locator('#h5-learn-coach').waitFor();
      await settled(page);

      // The menu: Reset the summary, Earlier chats, Learn settings (no other way in to the screens).
      await page.locator('#h5-learn-coach-more').tap();
      assert.deepEqual(await texts(page, '#h5-learn-coach-menu .MuiMenuItem-root'), ['Reset the summary', 'Earlier chats', 'Learn settings']);
      await page.locator('#h5-learn-coach-reset').tap();
      await waitFor(() => mock.of('POST', /summary\/reset$/).length === 1, 'the summary is reset');

      // Learn settings with the coach group: its switches (synced learn settings), the notes edited and deleted with Undo.
      await page.locator('#h5-learn-coach-more').tap();
      await page.locator('#h5-learn-coach-settings-open').tap();
      await waitText(page, '#h5-learn-view-title', 'Learn settings');
      await page.locator('#h5-learn-coach-settings').waitFor();
      await waitFor(async () => (await page.locator('.h5-learn-coach-note').count()) === 2, 'the notes');
      assert.equal(await text(page, '#h5-learn-coach-notes-count'), '2 of 40 notes. Tap a line to edit it, × deletes it (with Undo). Secrets such as passwords are never kept.');
      assert.equal(await text(page, '#h5-learn-coach-privacy'), 'What she reads is sent to your translation service to write the answer.');
      for (const [id, on] of [['#h5-learn-coach-memory', true], ['#h5-learn-coach-read-answers', true], ['#h5-learn-coach-read-text', true], ['#h5-learn-coach-economy', false]]) {
        assert.equal(await page.locator(id).isChecked(), on, id);
      }
      await page.locator('#h5-learn-coach-read-text').tap();
      await waitFor(() => mock.of('PUT', /\/api\/learn\/settings$/).some(one => one.body.coach_read_text === false), 'read_text off');
      await page.locator('#h5-learn-coach-economy').tap();
      await waitFor(() => mock.of('PUT', /\/api\/learn\/settings$/).some(one => one.body.coach_economy === true), 'Save tokens on');
      await page.locator('.h5-learn-coach-note[data-uid="n2"] .h5-learn-coach-note-text').tap();
      await page.locator('.h5-learn-coach-note-input').fill('Prefers short answers, with examples');
      await page.locator('.h5-learn-coach-note-input').press('Enter');
      await waitFor(() => mock.of('PATCH', /coach\/notes\/n2$/).length === 1, 'the note is saved');
      assert.deepEqual(mock.of('PATCH', /coach\/notes\/n2$/)[0].body, { text: 'Prefers short answers, with examples' });
      await waitText(page, '.h5-learn-coach-note[data-uid="n2"] .h5-learn-coach-note-text', 'Prefers short answers, with examples');
      await page.locator('.h5-learn-coach-note[data-uid="n1"] .h5-learn-coach-note-delete').tap();
      await page.locator('.h5-learn-coach-note-deleted[data-uid="n1"]').waitFor();
      await page.locator('.h5-learn-coach-note-undo').tap();
      await page.locator('.h5-learn-coach-note[data-uid="n1"]').waitFor();
      await page.locator('.h5-learn-coach-note[data-uid="n1"] .h5-learn-coach-note-delete').tap();
      await page.locator('#h5-learn-coach-reset-summary').tap();
      await waitFor(() => mock.of('POST', /summary\/reset$/).length === 2, 'Reset the summary from the settings');
      assert.equal(mock.of('DELETE', /coach\/notes\/n1$/).length, 0, 'the delete waits for its Undo');
      await shot(page, 'learn-coach-settings.png');
      // Back returns to the coach; leaving the settings sends the delete that waited.
      await page.locator('#h5-learn-back').tap();
      await page.locator('#h5-learn-coach').waitFor();
      await waitFor(() => mock.of('DELETE', /coach\/notes\/n1$/).length === 1, 'the delete is sent');

      // Earlier chats: the old chats, read-only.
      await page.locator('#h5-learn-coach-more').tap();
      await page.locator('#h5-learn-coach-earlier').tap();
      await page.locator('#h5-learn-chats .h5-learn-chat-row').first().waitFor();
      assert.equal(await page.locator('#h5-learn-chat-new').count(), 0, 'no New chat');
      await page.locator('.h5-learn-chat-row[data-uid="c1"]').tap();
      await page.locator('#h5-learn-chat .h5-learn-chat-msg').first().waitFor();
      assert.equal(await page.locator('#h5-learn-chat-input, #h5-learn-chat-more, #h5-learn-chat-history').count(), 0, 'read-only: no input, no menu');
      await page.locator('#h5-learn-back').tap();
      await page.locator('#h5-learn-chats .h5-learn-chat-row').first().waitFor();
      await page.locator('#h5-learn-back').tap();
      await page.locator('#h5-learn-coach').waitFor();
      // The back arrow of the coach closes Learn: the terminal and the bottom navigation are back, and no home was in between.
      await page.locator('#h5-learn-coach-back').tap();
      await page.locator('#h5-learn').waitFor({ state: 'detached' });
      // Back on the session page the navigation is behind its pull handle (nothing resizes), and no home was in between.
      await page.locator('#h5-bnav-handle').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.h5-learn-home').count(), 0);
      // The bottom navigation opens her again.
      await bnavTap(page, '#h5-bnav-learn');
      await page.locator('#h5-learn[data-coach="only"] #h5-learn-coach').waitFor();
      await context.close();
    }

    // ── 1440x900 (mouse) ──
    {
      const touch = false;
      const { context, page, mock } = await openPage(browser, { viewport: { width: 1440, height: 900 } });
      await page.locator('#h5-nav-learn').click();
      // The coach fills the page right of the rail: no home column.
      await page.locator('#h5-learn[data-coach="only"] .h5-learn-pane #h5-learn-coach[data-layout="wide"]').waitFor();
      await settled(page);
      assert.equal(await page.locator('.h5-learn-home, #h5-learn-mode-chat').count(), 0, 'no Learn home');
      const fill = await page.evaluate(() => ({ learn: document.getElementById('h5-learn').getBoundingClientRect(), coach: document.getElementById('h5-learn-coach').getBoundingClientRect() }));
      assert.ok(Math.abs(fill.coach.width - fill.learn.width) <= 1 && Math.abs(fill.coach.left - fill.learn.left) <= 1, `the coach fills the page (${fill.coach.width} of ${fill.learn.width})`);
      await page.locator('#h5-learn-coach-input').click();
      await page.keyboard.type("Give me today's spelling practice");
      await page.keyboard.press('Enter');
      const card = page.locator('.h5-learn-coach-card[data-id="p-spell"]');
      await card.waitFor();
      await shot(page, 'learn-coach-desktop.png');
      // The series takes the coach's place.
      await card.locator('.h5-learn-coach-start').click();
      await page.locator('#h5-learn .h5-learn-pane #h5-learn-series').waitFor();
      assert.equal(await page.locator('#h5-learn .h5-learn-home, #h5-learn-coach').count(), 0);
      assert.equal(await subtitle(page, false), '1 / 3 · from your chat');
      for (const one of SPELLING) await answer(page, mock, one.en, touch);
      await page.locator('.h5-learn-coach-divider', { hasText: 'Spelling finished · 3 words · 1 min' }).waitFor();
      await settled(page);
      await shot(page, 'learn-coach-desktop-result.png');
      // Escape leaves a series early, back to the coach.
      await page.locator('.h5-learn-coach-card[data-id="p-spell"] .h5-learn-coach-start').last().click();
      await page.locator('#h5-learn-series').waitFor();
      await answer(page, mock, 'separate', touch);
      await page.locator('#h5-learn-spell-input').blur();
      await page.keyboard.press('Escape');
      await page.locator('.h5-learn-coach-divider[data-stopped="true"]', { hasText: 'Stopped after 1 of 3' }).waitFor();
      await settled(page);
      // Earlier chats: the read-only list and conversation in the pane; Close returns to the coach.
      await page.locator('#h5-learn-coach-more').click();
      await page.locator('#h5-learn-coach-earlier').click();
      await page.locator('#h5-learn-chat[data-readonly="true"]').waitFor();
      await page.locator('#h5-learn-chat-pick').waitFor();
      await page.locator('.h5-learn-chat-row[data-uid="c2"]').click();
      await page.locator('#h5-learn-chat .h5-learn-chat-msg').first().waitFor();
      assert.equal(await page.locator('#h5-learn-chat-input, #h5-learn-chat-new').count(), 0);
      await page.locator('#h5-learn-back').click();
      await page.locator('#h5-learn-coach').waitFor();
      await settled(page);
      // A screen button opens Mistakes in the page; its × returns to her.
      await page.locator('#h5-learn-coach-input').click();
      await page.keyboard.type('Show my mistakes');
      await page.keyboard.press('Enter');
      await page.locator('.h5-learn-coach-screen[data-screen="mistakes"]').waitFor();
      await settled(page);
      await page.locator('.h5-learn-coach-screen[data-screen="mistakes"]').click();
      await waitText(page, '#h5-learn-view-title', 'Mistakes');
      await shot(page, 'learn-coach-desktop-mistakes.png');
      await page.locator('#h5-learn-back').click();
      await page.locator('#h5-learn-coach').waitFor();
      await settled(page);
      // Escape from the coach closes Learn.
      await page.locator('#h5-learn-coach-input').blur();
      await page.keyboard.press('Escape');
      await page.locator('#h5-learn').waitFor({ state: 'detached' });
      await context.close();
    }

    // ── A link into Learn (/h5?learn=progress): Progress opens, its × returns to the coach ──
    {
      const { context, page } = await openPage(browser, { viewport: { width: 1440, height: 900 }, at: '/h5?learn=progress' });
      await waitText(page, '#h5-learn-view-title', 'Progress');
      assert.equal(await page.evaluate(() => location.search), '', 'the link is taken out of the address');
      await page.locator('#h5-learn-back').click();
      await page.locator('#h5-learn[data-coach="only"] #h5-learn-coach').waitFor();
      await context.close();
    }

    // ── A company computer whose home is away: the coach says so and takes no question ──
    {
      const { context, page } = await openPage(browser, { viewport: { width: 1440, height: 900 }, away: 'offline' });
      await page.locator('#h5-nav-learn').click();
      await waitText(page, '#h5-learn-coach-away', 'Your English coach is on a normal computer, which cannot be reached right now');
      assert.equal(await page.locator('#h5-learn-coach-start, #h5-learn-coach-no-translator').count(), 0, 'no starters and no translator notice while away');
      await page.locator('#h5-learn-coach-input').fill('Hello');
      assert.equal(await page.locator('#h5-learn-coach-send').isDisabled(), true, 'nothing can be sent');
      // She cannot answer, but the menu still opens Learn settings.
      await page.locator('#h5-learn-coach-more').click();
      await page.locator('#h5-learn-coach-settings-open').click();
      await waitText(page, '#h5-learn-view-title', 'Learn settings');
      await context.close();
    }

    // ── An engine without the coach: the Learn home and the old English chat, unchanged ──
    {
      const { context, page } = await openPage(browser, { viewport: { width: 1440, height: 900 }, coach: false });
      await page.locator('#h5-nav-learn').click();
      await waitText(page, '#h5-learn-mode-chat .h5-learn-count', '2 chats');
      assert.match(await text(page, '#h5-learn-mode-chat'), /Ask anything about English: words, grammar, how to say something/);
      await page.locator('#h5-learn-mode-chat').click();
      await page.locator('#h5-learn-chat[data-layout="wide"] #h5-learn-chat-start').waitFor();
      assert.equal(await page.locator('#h5-learn-coach').count(), 0);
      assert.equal(await page.locator('#h5-learn-chat-new').count(), 1, 'the old chat with New chat');
      await context.close();
    }

    assert.deepEqual(pageErrors, []);
    console.log('Learn coach browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
