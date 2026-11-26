#!/usr/bin/env node
// The English coach end to end: the REAL server (its own data folder, port 0, a temporary HOME) and the REAL page in headless Chromium, with a FAKE
// OpenAI-compatible model (a local http server answering POST /chat/completions with streamed tool calls, scripted per scenario). The learning data
// is made through the real routes (cards, answers); the coach's tools run on the server (the SQL snapshot, the practice plans, the proposals, the
// T-Attention reminder, the notes). Checked: what the page shows (390x844 touch and 1440x900) and what the fake model receives (the prompt order, the
// tools, the notes, the summary, the budgets, the stable prefix). The whole run sends fewer than 30 questions (the coach's limit a minute). See docs/design/learn-english-coach.md and docs/design/learn-english-coach-page.md.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
const { chromium } = require('playwright');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const { encryptToken } = require(path.join(ROOT, 'lib', 'token-crypto'));
const SECRET = 'coach-e2e-test-secret-'.repeat(3);
const OWNER = 'local';
const WAIT = { timeout: 60000 };
const LIMIT_MS = 540000;
const META = '<<meta>>';
const XHR = { 'X-Requested-With': 'XMLHttpRequest' };
const log = (...args) => { if (process.env.COACH_E2E_VERBOSE) console.log(...args); };

// ---- The fake model ----
// Every request is kept (`requests`: { kind: 'tools' | 'fold' | 'plain', body }). A tools request is answered by `responder(body)` when set, else by
// the next item of `queue`, else with a plain answer. An item: { content?, tools?: [[name, args]], delay? } or a function of the request body.
const answerText = (text, meta = {}) => `${text}\n${META}${JSON.stringify({ cards: [], mistakes: [], journal: false, suggestions: [], ...meta })}`;
function fakeModel() {
  const state = { requests: [], queue: [], responder: null, refuse: false, folds: 0, plain: [] };
  let calls = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', async () => {
      if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) { res.writeHead(404); res.end('{}'); return; }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* empty */ }
      const system = (body.messages && body.messages[0] && body.messages[0].content) || '';
      // 'other': the server's own calls that are not the coach's (the meanings of new cards), answered as a dictionary.
      const kind = body.tools ? 'tools' : /^You keep the running summary/.test(system) ? 'fold' : body.stream ? 'plain' : 'other';
      state.requests.push({ kind, body, auth: req.headers.authorization });
      if (kind === 'tools' && state.refuse) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'tools is not supported by this model', type: 'invalid_request_error' } }));
        return;
      }
      let reply;
      if (kind === 'fold') { state.folds += 1; reply = { content: `SUMMARY-${state.folds}: the learner practises spelling every day and asked which words are weak; agreed to retest receive.` }; }
      else if (kind === 'tools') reply = state.responder ? state.responder(body) : state.queue.length ? state.queue.shift() : { content: answerText('All right.') };
      else if (kind === 'other') {
        // The word dictionary (services/translator.js WORD_PROMPT): a meaning for each new card, so Spell can show them.
        let word = '';
        try { word = JSON.parse(lastUser({ body })).word || ''; } catch { /* not a word question */ }
        reply = { content: /^You are a dictionary/.test(system) ? JSON.stringify({ base: word, phonetic: '', pos: 'n.', meaning: '\u610f\u601d' }) : '{}' };
      }
      else reply = state.plain.length ? state.plain.shift() : { content: answerText('Here is my plain answer.') };
      if (typeof reply === 'function') reply = reply(body);
      if (reply.delay) await new Promise(resolve => setTimeout(resolve, reply.delay));
      calls += 1;
      const toolCalls = (reply.tools || []).map(([name, args], index) => ({ id: `call_${calls}_${index}`, name, arguments: JSON.stringify(args || {}) }));
      const usage = { prompt_tokens: 1000, completion_tokens: 50 };
      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply.content || '', ...(toolCalls.length ? { tool_calls: toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}) } }], usage }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const event = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
      const content = reply.content || '';
      const half = Math.ceil(content.length / 2);
      for (const piece of content ? [content.slice(0, half), content.slice(half)] : []) {
        if (piece) event({ choices: [{ index: 0, delta: { content: piece } }] });
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      toolCalls.forEach((call, index) => {
        const cutAt = Math.ceil(call.arguments.length / 2);
        event({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments.slice(0, cutAt) } }] } }] });
        event({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: call.arguments.slice(cutAt) } }] } }] });
      });
      event({ choices: [], usage });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(Object.assign(state, { server, port: server.address().port }))));
}
const toolsOf = request => request.body.tools.map(tool => tool.function.name);
const toolResults = request => request.body.messages.filter(one => one.role === 'tool').map(one => one.content);
const lastUser = request => [...request.body.messages].reverse().find(one => one.role === 'user').content;

// ---- The server ----
async function startServer(temp) {
  const data = path.join(temp, 'server-data');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', ACCESS_MODE: 'local', SESSION_SECRET: SECRET, TZ: 'Asia/Taipei',
      T_AGENT_DATA_DIR: data, TAGENT_HOME: data, T_AGENT_DB_PATH: path.join(data, 'db.sqlite'), TASKS_BASE_DIR: path.join(temp, 'tasks'),
      SINGLE_USER_ID: OWNER, UPDATE_CHECK_ENABLED: 'false', HOME: path.join(temp, 'home'), ZDOTDIR: path.join(temp, 'home'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server startup timed out: ${output}`)), 60000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`server exited: ${output}`)); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      const found = output.match(/Server running at http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timer); resolve(Number(found[1])); }
    });
  });
  return { base: `http://127.0.0.1:${port}`, child, dbPath: path.join(data, 'db.sqlite'), log: () => output };
}
// The translator configuration as services/translator.js stores it (system_state `translator:<owner>`, encrypted with the session secret). Written
// here because the settings route takes only an https endpoint; the fake model is plain http on this machine. The key is a dummy.
function configureModel(dbPath, port, model = 'fake-model') {
  const db = new Database(dbPath);
  try {
    db.pragma('busy_timeout = 5000');
    const value = {
      enabled: true, provider: 'deepseek',
      providers: { deepseek: { apiKey: 'dummy-test-key', baseUrl: `http://127.0.0.1:${port}`, model }, glm: { apiKey: '', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash' } },
    };
    db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(`translator:${OWNER}`, encryptToken(JSON.stringify(value), SECRET));
  } finally { db.close(); }
}
const readDb = (dbPath, fn) => { const db = new Database(dbPath, { readonly: true }); try { db.pragma('busy_timeout = 5000'); return fn(db); } finally { db.close(); } };

// ---- The page ----
const pageErrors = [];
async function openPage(browser, base, { viewport, touch = false, url = '/h5' }) {
  const context = await browser.newContext({ viewport, timezoneId: 'Asia/Taipei', ...(touch ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    try { localStorage.setItem('h5-columns', JSON.stringify({ on: false })); } catch { /* none */ }
    // No speech output: Dictation is left out of a series (as on a browser without voices).
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: undefined });
  });
  const traffic = [];
  page.on('request', request => {
    const u = new URL(request.url());
    if (u.pathname.startsWith('/api/learn/')) {
      let body = null;
      try { body = request.postData() ? JSON.parse(request.postData()) : null; } catch { body = null; }
      traffic.push({ method: request.method(), path: u.pathname, search: u.search, body });
    }
  });
  const responses = [];
  page.on('response', async response => {
    const u = new URL(response.url());
    if (/\/api\/learn\/coach\/plans\/start$/.test(u.pathname)) { try { responses.push({ path: u.pathname, body: await response.json() }); } catch { /* gone */ } }
  });
  await page.goto(`${base}${url}`);
  return { context, page, traffic, responses, of: (method, pattern) => traffic.filter(one => one.method === method && pattern.test(one.path)) };
}
const api = (page, method, url, body) => page.evaluate(async ([m, u, b, headers]) => {
  const res = await fetch(u, { method: m, headers: { ...headers, ...(b ? { 'Content-Type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}, [method, url, body, XHR]);

const text = (page, selector) => page.locator(selector).first().evaluate(el => el.textContent.replace(/\s+/g, ' ').trim());
const texts = (page, selector) => page.locator(selector).evaluateAll(list => list.map(el => el.textContent.replace(/\s+/g, ' ').trim()));
const waitFor = async (check, message, timeout = 15000) => {
  const end = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error(`Timed out: ${message}`);
    await new Promise(resolve => setTimeout(resolve, 60));
  }
};
const press = (page, target, touch) => { const loc = typeof target === 'string' ? page.locator(target).first() : target; return touch ? loc.tap() : loc.click(); };
const answers = page => page.locator('#h5-learn-coach .h5-learn-coach-answer');
// Sends a text and waits until her answer is in (one more answer, nothing streaming).
// Nothing on the way: no answer streaming, no status line.
const quiet = page => waitFor(async () => !(await page.locator('#h5-learn-coach [data-streaming], #h5-learn-coach-status').count()), 'no answer on the way', 25000);
async function say(page, value, touch) {
  await quiet(page);
  const before = await answers(page).count();
  await page.locator('#h5-learn-coach-input').fill(value);
  await press(page, '#h5-learn-coach-send', touch);
  await settle(page, before);
}
async function settle(page, before) {
  await waitFor(async () => (await answers(page).count()) > before && !(await page.locator('#h5-learn-coach [data-streaming]').count()), 'her answer is in', 25000);
}
const lastAnswer = page => answers(page).last();
// Answers the current card of a series with `value`, then the grade; returns whether it was right.
async function answerCard(page, one, value, touch) {
  const before = one.of('POST', /\/cards\/\d+\/answer$/).length;
  const exercise = await page.locator('#h5-learn-series').getAttribute('data-exercise');
  const field = exercise === 'fill' ? '#h5-learn-gap-input' : exercise === 'dictation' ? '#h5-learn-dictation-input' : '#h5-learn-spell-input';
  await page.locator(field).fill(value);
  const feedback = page.locator('#h5-learn-feedback');
  try { await feedback.waitFor({ timeout: 1500 }); } catch { await press(page, '#h5-learn-check', touch); await feedback.waitFor(WAIT); }
  const right = (await feedback.getAttribute('data-correct')) === 'true';
  await press(page, right ? '#h5-learn-grade-good' : '#h5-learn-grade-again', touch);
  await waitFor(() => one.of('POST', /\/cards\/\d+\/answer$/).length === before + 1, 'the answer is posted');
  return right;
}
// The text the current item asks for, from the plan the page started (`cards` by id) and the answer the exercise needs.
async function currentCard(page, plan) {
  const ids = plan.steps.flatMap(step => step.cards);
  await page.locator('#h5-learn-series').waitFor(WAIT);
  const exercise = await page.locator('#h5-learn-series').getAttribute('data-exercise');
  if (exercise === 'fill') {
    // The gap's word: the sentence card's gap is read from the page (the shown sentence without the gap) and matched to a card.
    const shown = await text(page, '.h5-learn-gap');
    for (const card of ids) {
      if (card.kind === 'sentence' && card.gap && shown === `${card.gap.before}${card.gap.after}`.replace(/\s+/g, ' ').trim()) return { card, value: card.gap.word, exercise };
    }
    return { card: null, value: '', exercise, shown };
  }
  return { card: null, value: '', exercise };
}
const wrongOf = word => (word[0] === 'x' ? `y${word.slice(1)}` : `x${word.slice(1)}`);

async function openLearn(page, touch) {
  if (touch) {
    const nav = page.locator('#h5-bnav-learn');
    try { await nav.waitFor({ state: 'visible', timeout: 4000 }); await nav.tap(); } catch { await page.evaluate(() => window.H5UI.actions.openLearn()); }
  } else await page.locator('#h5-nav-learn').click();
  // Learn is only the coach: she is the page at once, with no home.
  await page.locator('[data-coach="only"] #h5-learn-coach').waitFor(WAIT);
  assert.equal(await page.locator('.h5-learn-home, #h5-learn-mode-chat').count(), 0, 'no Learn home');
}
async function openCoachSettings(page, touch) {
  await press(page, '#h5-learn-coach-more', touch);
  await press(page, '#h5-learn-coach-settings-open', touch);
  await page.locator('#h5-learn-coach-settings').waitFor(WAIT);
}
async function backToCoach(page, touch) {
  await press(page, '#h5-learn-back', touch);
  await page.locator('#h5-learn-coach').waitFor(WAIT);
}
const settingsNow = async page => (await api(page, 'GET', '/api/learn/settings')).data;

// ---- The learning data, through the real routes ----
const WORDS = ['receive', 'necessary', 'separate', 'definitely', 'accommodate', 'rhythm', 'embarrass', 'occurrence', 'tomorrow', 'beginning'];
const SENTENCES = ['I will receive the parcel tomorrow.', 'It is necessary to sleep well.'];
async function seed(page) {
  const ids = {};
  for (const en of WORDS) {
    const made = await api(page, 'POST', '/api/learn/cards', { kind: 'word', en, source: 'manual', zh: `\u8bcd ${en}` });
    assert.ok([200, 201].includes(made.status), `card ${en}: ${JSON.stringify(made)}`);
    ids[en] = made.data.card.id;
  }
  for (const en of SENTENCES) {
    const made = await api(page, 'POST', '/api/learn/cards', { kind: 'sentence', en, source: 'manual', zh: '\u53e5\u5b50' });
    assert.ok([200, 201].includes(made.status), `sentence ${en}: ${JSON.stringify(made)}`);
    ids[en] = made.data.card.id;
  }
  const answer = (en, correct, typed) => api(page, 'POST', `/api/learn/cards/${ids[en]}/answer`, { mode: 'spell', grade: correct ? 'good' : 'again', correct, answer: typed });
  for (const [en, correct, typed] of [['receive', false, 'recieve'], ['receive', false, 'receeve'], ['necessary', false, 'neccesary'], ['separate', false, 'seperate'],
    ['separate', true, 'separate'], ['definitely', true, 'definitely'], ['accommodate', true, 'accommodate']]) {
    const done = await answer(en, correct, typed);
    assert.equal(done.status, 200, `answer ${en}: ${JSON.stringify(done)}`);
  }
  return ids;
}

// ---- Phone: 390x844, touch ----
async function phoneRun(browser, server, fake) {
  const touch = true;
  const one = await openPage(browser, server.base, { viewport: { width: 390, height: 844 }, touch });
  const { page } = one;
  const ids = await seed(page);
  // An earlier chat (the old English chat route, answered by the fake model).
  fake.plain.push({ content: answerText('Hello! "Break a leg" means good luck.') });
  const old = await api(page, 'POST', '/api/learn/chats/send', { chat: null, question: 'What does "break a leg" mean?' });
  assert.equal(old.status, 200, `the old chat: ${JSON.stringify(old)}`);
  const chats = await api(page, 'GET', '/api/learn/chats');
  assert.equal(chats.data.chats.length, 1, 'one earlier chat; the coach is not in the chats list');

  // Learn is the coach.
  await page.reload();
  await openLearn(page, touch);
  await page.locator('#h5-learn-coach[data-layout="phone"]').waitFor(WAIT);
  await page.locator('#h5-learn-coach-start').waitFor(WAIT);
  const probe = one.traffic.find(item => item.path === '/api/learn/coach' && /limit=1(&|$)/.test(item.search));
  assert.ok(probe, 'the page asks GET /api/learn/coach?limit=1 to find the coach');

  // -- "Give me today's spelling practice": propose_practice -> the plan card (the server's numbers) -> Start -> the series -> the result --
  const queue = (await api(page, 'GET', '/api/learn/queue?mode=spell&limit=50')).data.cards;
  fake.queue.push({ content: 'Let me make a plan.', tools: [['propose_practice', { kind: 'today_spelling' }]] });
  fake.queue.push(body => {
    const result = JSON.parse(toolResults({ body }).at(-1));
    return { content: answerText(`Here is today's spelling: **${result.words} words**, about ${result.minutes} min.`, { suggestions: ['Start now', 'Later'] }) };
  });
  let mark = fake.requests.length;
  await say(page, "Give me today's spelling practice", touch);
  const sent = fake.requests.slice(mark).filter(item => item.kind === 'tools');
  assert.equal(sent.length, 2, 'two rounds: the tool call, then the answer');
  assert.deepEqual(toolsOf(sent[0]), ['learn_schema', 'learn_sql', 'select_practice_words', 'propose_practice', 'propose_settings', 'propose_cards', 'propose_reminder', 'remember', 'open_screen'], 'the tools list');
  assert.equal(sent[0].body.tool_choice, 'auto');
  assert.equal(sent[0].auth, 'Bearer dummy-test-key');
  assert.equal(sent[0].body.model, 'fake-model');
  assert.equal(sent[0].body.messages[0].role, 'system');
  assert.match(sent[0].body.messages[0].content, /^You are the English coach/);
  assert.doesNotMatch(sent[0].body.messages[0].content, /Today is \d{4}/, 'no date in the stable system message');
  assert.match(lastUser(sent[0]), /^Today is \d{4}-\d{2}-\d{2}\. Learning now: \d+ due words including new words scheduled for today, .*\n\nGive me today's spelling practice$/s, 'today\'s numbers go with the newest message');
  // The second round: the model's tool call and its result follow the question.
  const second = sent[1].body.messages;
  assert.equal(second.at(-2).role, 'assistant');
  assert.equal(second.at(-2).tool_calls[0].function.name, 'propose_practice');
  assert.equal(second.at(-1).role, 'tool');
  const planResult = JSON.parse(second.at(-1).content);
  assert.equal(planResult.words, queue.length, 'the plan has the words of the real spell queue');
  const planCard = lastAnswer(page).locator('.h5-learn-coach-card[data-type="plan"]');
  await planCard.waitFor(WAIT);
  assert.equal(await text(page, '.h5-learn-coach-answer:last-of-type .h5-learn-coach-plan-title'), "Today's spelling");
  assert.equal(await planCard.locator('.h5-learn-coach-plan-caption').evaluate(el => el.textContent.trim()),
    `${queue.length} words · ${planResult.minutes === 1 ? 'about 1 minute' : `about ${planResult.minutes} minutes`}`);
  assert.match(await lastAnswer(page).locator('.h5-learn-chat-msg').last().textContent(), new RegExp(`${queue.length} words`));
  assert.ok(!(await lastAnswer(page).locator('.h5-learn-chat-msg').last().textContent()).includes(META), 'the meta line never shows');
  assert.deepEqual(await texts(page, '.h5-learn-coach-suggestion'), ['Start now', 'Later']);
  // The usage caption: its first part in one line, all of it after a tap.
  assert.equal(await text(page, '.h5-learn-coach-answer:last-of-type .h5-learn-coach-usage'), 'Looked at your data once');
  await press(page, lastAnswer(page).locator('.h5-learn-coach-usage'), touch);
  assert.equal(await text(page, '.h5-learn-coach-answer:last-of-type .h5-learn-coach-usage'), 'Looked at your data once · 2 calls · 2,100 tokens');
  await press(page, planCard.locator('.h5-learn-coach-start'), touch);
  await page.locator('#h5-learn-series').waitFor(WAIT);
  const started = one.responses.at(-1).body.plan;
  assert.equal(started.steps.length, 1);
  assert.deepEqual(started.steps[0].cards.map(card => card.id), queue.map(card => card.id), 'Start reads the same queue');
  assert.ok(started.steps[0].cards.every(card => card.next && 'is_new' in card), 'full queue cards');
  const spelled = started.steps[0].cards.map(card => card.en);
  const missed = spelled[0];
  assert.equal(await answerCard(page, one, wrongOf(missed), touch), false);
  for (const word of spelled.slice(1)) assert.equal(await answerCard(page, one, word, touch), true, word);
  // The missed word comes back at the end.
  assert.equal(await answerCard(page, one, missed, touch), true);
  fake.queue.push({ content: answerText(`Nice work: ${spelled.length - 1} of ${spelled.length} right.`) });
  await page.locator('#h5-learn-coach').waitFor(WAIT);
  await page.locator('.h5-learn-coach-divider', { hasText: `Spelling finished · ${spelled.length} words · 1 min` }).waitFor(WAIT);
  await page.locator('.h5-learn-chat-msg[data-role="assistant"]', { hasText: 'Nice work' }).waitFor(WAIT);
  const result = one.of('POST', /practice-result$/).at(-1).body;
  assert.deepEqual([result.total, result.done, result.right, result.stopped], [spelled.length, spelled.length, spelled.length - 1, undefined]);
  assert.deepEqual(result.missed, [{ en: missed, typed: wrongOf(missed) }]);
  const resultAsked = fake.requests.filter(item => item.kind === 'tools').at(-1);
  assert.match(lastUser(resultAsked), new RegExp(`\\[Practice result, sent by the app, not typed by the person\\] Today's spelling finished: ${spelled.length} words, ${spelled.length - 1} of ${spelled.length} right`));
  const answered = readDb(server.dbPath, db => db.prepare("SELECT COUNT(*) AS n FROM learn_reviews WHERE owner = ? AND at > ? AND mode = 'spell'").get(OWNER, Date.now() - 120000).n);
  assert.ok(answered >= spelled.length + 1, 'the answers went through the real answer route');
  log('phone: spelling series ok');

  // -- Leaving early: a mistakes series, "Stopped after 1 of M" and her reply --
  fake.queue.push({ tools: [['propose_practice', { kind: 'mistakes_series' }]] });
  fake.queue.push(body => { const r = JSON.parse(toolResults({ body }).at(-1)); return { content: answerText(`Your mistakes: ${r.words} cards in ${r.steps.length} steps.`) }; });
  await say(page, 'I want to practise my wrong answers', touch);
  const mistakesCard = lastAnswer(page).locator('.h5-learn-coach-card[data-type="plan"]');
  await mistakesCard.waitFor(WAIT);
  const steps = await mistakesCard.locator('.h5-learn-coach-plan-steps li').evaluateAll(list => list.map(el => el.dataset.mode));
  assert.equal(steps[0], 'spell');
  assert.equal(steps.at(-1), 'retest');
  await press(page, mistakesCard.locator('.h5-learn-coach-start'), touch);
  await page.locator('#h5-learn-series').waitFor(WAIT);
  const mistakesPlan = one.responses.at(-1).body.plan;
  const distinct = new Set(mistakesPlan.steps.filter(step => step.mode !== 'retest' && step.mode !== 'dictation').flatMap(step => step.cards.map(card => card.id))).size;
  const first = mistakesPlan.steps[0].cards[0];
  assert.equal(await answerCard(page, one, first.en, touch), true);
  fake.queue.push({ content: answerText('Stopped early, that is fine.') });
  await press(page, '#h5-learn-back', touch);
  await page.locator('.h5-learn-coach-divider[data-stopped="true"]', { hasText: `Stopped after 1 of ${distinct}` }).waitFor(WAIT);
  await page.locator('.h5-learn-chat-msg[data-role="assistant"]', { hasText: 'Stopped early' }).waitFor(WAIT);
  const stoppedBody = one.of('POST', /practice-result$/).at(-1).body;
  assert.deepEqual([stoppedBody.stopped, stoppedBody.done, stoppedBody.total], [true, 1, distinct]);
  assert.match(lastUser(fake.requests.filter(item => item.kind === 'tools').at(-1)), new RegExp(`Your mistakes: stopped after 1 of ${distinct}`));
  log('phone: stopped series ok');

  // -- "Which words do I keep getting wrong?": learn_sql (the status line), the rows from the seeded data; a hostile query is refused --
  fake.queue.push({ delay: 300, tools: [['learn_sql', { query: 'SELECT en, wrong_count FROM coach_mistakes ORDER BY wrong_count DESC, en LIMIT 5' }], ['learn_sql', { query: 'SELECT * FROM learn_cards' }]] });
  fake.queue.push(body => {
    const [rows, refused] = toolResults({ body }).map(item => JSON.parse(item));
    const top = rows.rows[0];
    const [en, count] = Array.isArray(top) ? top : [top.en, top.wrong_count];
    return { delay: 600, content: answerText(`You keep missing **${en}** (${count} times).${refused.error ? '' : ' LEAK'}`) };
  });
  await quiet(page);
  const before = await answers(page).count();
  await page.locator('#h5-learn-coach-input').fill('Which words do I keep getting wrong?');
  await press(page, '#h5-learn-coach-send', touch);
  await page.locator('#h5-learn-coach-status').waitFor(WAIT);
  assert.equal(await text(page, '#h5-learn-coach-status'), 'Looking at your answers…');
  await settle(page, before);
  assert.equal(await page.locator('#h5-learn-coach-status').count(), 0, 'the status line goes');
  const sqlAsked = fake.requests.filter(item => item.kind === 'tools').at(-1);
  const [sqlRows, sqlRefused] = toolResults(sqlAsked).slice(-2).map(item => JSON.parse(item));
  log('sql rows', JSON.stringify(sqlRows));
  assert.ok(Array.isArray(sqlRows.columns) && sqlRows.columns.includes('en'), 'columns');
  assert.ok(JSON.stringify(sqlRows.rows).includes('receive'), 'the most missed word is from the seeded answers');
  assert.ok(sqlRefused.error, `the base table is refused: ${JSON.stringify(sqlRefused)}`);
  assert.match(await lastAnswer(page).locator('.h5-learn-chat-msg').last().textContent(), /You keep missing receive \(\d+ times\)\.$/);

  // -- "How many words have I learned?" via learn_sql; the journal and chats are readable (the switch is on) --
  const learned = readDb(server.dbPath, db => db.prepare("SELECT COUNT(*) AS n FROM learn_cards WHERE owner = ? AND kind = 'word' AND reps > 0 AND suspended = 0").get(OWNER).n);
  const messagesQuery = "SELECT COUNT(*) AS n FROM coach_messages";
  fake.queue.push({ tools: [['learn_sql', { query: "SELECT COUNT(*) AS words FROM coach_cards WHERE kind = 'word' AND reps > 0" }], ['learn_sql', { query: messagesQuery }]] });
  fake.queue.push(body => {
    const [words, msgs] = toolResults({ body }).map(item => JSON.parse(item));
    const n = Array.isArray(words.rows[0]) ? words.rows[0][0] : words.rows[0].words;
    const m = Array.isArray(msgs.rows[0]) ? msgs.rows[0][0] : msgs.rows[0].n;
    return { content: answerText(`You have learned ${n} words. (${m} messages)`) };
  });
  await say(page, 'How many words have I learned so far?', touch);
  const countText = await lastAnswer(page).locator('.h5-learn-chat-msg').last().textContent();
  assert.match(countText, new RegExp(`^You have learned ${learned} words\\.`));
  const messagesBefore = Number(/\((\d+) messages\)/.exec(countText)[1]);
  assert.ok(messagesBefore > 0, 'coach_messages has the person\'s messages while the switch is on');
  log('phone: sql ok');

  // -- propose_settings -> card -> Change -> the setting changes -> Undo restores --
  const was = (await settingsNow(page)).new_per_day;
  const want = was === 15 ? 20 : 15;
  fake.queue.push({ tools: [['propose_settings', { changes: { new_per_day: want } }]] });
  fake.queue.push({ content: answerText(`I suggest ${want} new words a day.`) });
  await say(page, 'More new words each day, please', touch);
  const setCard = lastAnswer(page).locator('.h5-learn-coach-card[data-type="settings"]');
  await setCard.waitFor(WAIT);
  assert.equal(await setCard.locator('.h5-learn-coach-setting').evaluate(el => el.textContent.trim()), `New words a day: ${was} → ${want}`);
  // A settings change is small: the page runs it at once, with no tap, and shows Changed / Undo.
  await setCard.locator('.h5-learn-coach-undo').waitFor(WAIT);
  assert.equal((await settingsNow(page)).new_per_day, want, 'the setting changed with no tap');
  await press(page, setCard.locator('.h5-learn-coach-undo'), touch);
  await page.locator('.h5-learn-coach-answer:last-of-type .h5-learn-coach-card[data-type="settings"][data-state="undone"]').waitFor(WAIT);
  assert.equal((await settingsNow(page)).new_per_day, was, 'Undo put it back');

  // -- propose_cards: add and remove, applied only after the tap --
  fake.queue.push({ tools: [['propose_cards', { add: [{ kind: 'word', en: 'resilient', zh: '\u6709\u97e7\u6027\u7684' }, { kind: 'word', en: 'meticulous', zh: '\u4e00\u4e1d\u4e0d\u82df\u7684' }], update: [{ id: ids.separate, zh: '\u5206\u5f00\u7684' }], remove: [ids.rhythm] }]] });
  fake.queue.push({ content: answerText('Two words to add and one to remove.') });
  await say(page, 'Add resilient and meticulous, change separate, and remove rhythm', touch);
  const cardCards = lastAnswer(page).locator('.h5-learn-coach-card[data-type="cards"]');
  await waitFor(async () => (await cardCards.count()) === 2, 'an add card and a remove card');
  const cardState = () => readDb(server.dbPath, db => ({
    resilient: db.prepare("SELECT suspended FROM learn_cards WHERE owner = ? AND norm = 'resilient'").get(OWNER),
    rhythm: db.prepare('SELECT suspended FROM learn_cards WHERE owner = ? AND id = ?').get(OWNER, ids.rhythm).suspended,
    separate: db.prepare('SELECT zh FROM learn_cards WHERE owner = ? AND id = ?').get(OWNER, ids.separate).zh,
  }));
  // Adding and changing cards is small: applied at once with no tap; the removal waits for its tap.
  assert.deepEqual(await cardCards.nth(0).locator('.h5-learn-coach-cards').evaluateAll(list => list.map(el => el.dataset.part)), ['add', 'update']);
  assert.deepEqual(await cardCards.nth(0).locator('.h5-learn-coach-chip').evaluateAll(list => list.map(el => el.textContent)), ['resilient', 'meticulous', 'separate']);
  await waitFor(async () => (await cardCards.nth(0).getAttribute('data-state')) === 'done', 'added with no tap');
  assert.deepEqual(cardState(), { resilient: { suspended: 0 }, rhythm: 0, separate: '\u5206\u5f00\u7684' }, 'added and changed, the removal not yet');
  assert.equal(await cardCards.nth(1).locator('.h5-learn-coach-run').evaluate(el => el.textContent), 'Remove');
  assert.deepEqual(await cardCards.nth(1).locator('.h5-learn-coach-chip').evaluateAll(list => list.map(el => el.textContent)), ['rhythm'], 'the removal names the card by its text');
  await press(page, cardCards.nth(1).locator('.h5-learn-coach-run'), touch);
  await waitFor(async () => (await cardCards.nth(1).getAttribute('data-state')) === 'done', 'removed');
  assert.deepEqual(cardState(), { resilient: { suspended: 0 }, rhythm: 1, separate: '\u5206\u5f00\u7684' });
  log('phone: settings and cards ok');

  // -- propose_reminder -> a recurring T-Attention task on tap --
  fake.queue.push({ tools: [['propose_reminder', { time: '20:00', text: 'Time for English practice' }]] });
  fake.queue.push({ content: answerText('Shall I remind you every day at 20:00?') });
  await say(page, 'Remind me every evening at 8', touch);
  const remCard = lastAnswer(page).locator('.h5-learn-coach-card[data-type="reminder"]');
  await remCard.waitFor(WAIT);
  assert.equal(await remCard.locator('.h5-learn-coach-reminder').evaluate(el => el.textContent.replace(/\s+/g, ' ').trim()),
    'Every day at 20:00 (Taipei time): "Time for English practice". Tapping it opens this chat.');
  const tasks = async () => ((await api(page, 'GET', '/api/attention')).data.items || []).filter(item => item.title === 'Time for English practice');
  assert.equal((await tasks()).length, 0, 'no task before the tap');
  await press(page, remCard.locator('.h5-learn-coach-run'), touch);
  await waitFor(async () => (await remCard.getAttribute('data-state')) === 'done', 'Reminder set');
  const [task] = await tasks();
  assert.ok(task, 'the T-Attention task exists');
  assert.equal(task.link_url, '/h5?learn=coach');
  assert.equal(task.source, 'learn-coach');
  assert.equal(task.schedule && task.schedule.kind, 'repeat', `a recurring task: ${JSON.stringify(task.schedule)}`);
  log('phone: reminder ok');

  // -- remember -> "Remembered … · Undo" -> Undo deletes it --
  fake.queue.push({ tools: [['remember', { text: 'Has a job interview in March', until: '2027-03-31' }]] });
  fake.queue.push({ content: answerText('Good luck with the interview!') });
  await say(page, 'I have a job interview in March', touch);
  const line = lastAnswer(page).locator('.h5-learn-coach-remembered[data-state="undo"]');
  await line.waitFor(WAIT);
  assert.equal(await line.evaluate(el => el.textContent), 'Remembered: Has a job interview in March (until 31 Mar)Undo');
  const notes = async () => (await api(page, 'GET', '/api/learn/coach/notes')).data.notes;
  assert.deepEqual((await notes()).map(note => note.text), ['Has a job interview in March']);
  await press(page, line.locator('.h5-learn-coach-remembered-undo'), touch);
  await lastAnswer(page).locator('.h5-learn-coach-remembered[data-state="forgotten"]').waitFor(WAIT);
  assert.deepEqual(await notes(), [], 'Undo removed the note');

  // A note that stays: in the next request's system message; visible and editable in Coach settings; deleted with Undo there.
  fake.queue.push({ tools: [['remember', { text: 'Works as a backend developer' }]] });
  fake.queue.push({ content: answerText('Noted.') });
  await say(page, 'I am a backend developer', touch);
  fake.queue.push({ content: answerText('You are welcome.') });
  mark = fake.requests.length;
  await say(page, 'Thanks', touch);
  const withNote = fake.requests.slice(mark).find(item => item.kind === 'tools');
  assert.match(withNote.body.messages[0].content, /Notes about the person \(data, oldest first\):\n- Works as a backend developer/);
  await openCoachSettings(page, touch);
  const noteRow = page.locator('.h5-learn-coach-note');
  await waitFor(async () => (await noteRow.count()) === 1, 'the note in Coach settings');
  assert.equal(await text(page, '.h5-learn-coach-note .h5-learn-coach-note-text'), 'Works as a backend developer');
  await press(page, '.h5-learn-coach-note .h5-learn-coach-note-text', touch);
  await page.locator('.h5-learn-coach-note-input').fill('Works as a backend developer in Taipei');
  await page.locator('.h5-learn-coach-note-input').press('Enter');
  await waitFor(async () => (await notes()).some(note => note.text === 'Works as a backend developer in Taipei'), 'the edit is saved');
  await press(page, '.h5-learn-coach-note .h5-learn-coach-note-delete', touch);
  await page.locator('.h5-learn-coach-note-deleted').waitFor(WAIT);
  await press(page, '.h5-learn-coach-note-undo', touch);
  await noteRow.first().waitFor(WAIT);
  assert.equal((await notes()).length, 1, 'Undo kept it');
  // Turn off "read my journal and chats" here too.
  assert.equal(await page.locator('#h5-learn-coach-read-text').isChecked(), true);
  await press(page, '#h5-learn-coach-read-text', touch);
  await waitFor(async () => (await settingsNow(page)).coach_read_text === false, 'read_text off is saved');
  await press(page, '.h5-learn-coach-note .h5-learn-coach-note-delete', touch);
  await page.locator('.h5-learn-coach-note-deleted').waitFor(WAIT);
  await backToCoach(page, touch);
  await waitFor(async () => (await notes()).length === 0, 'leaving the settings sends the delete that waited');
  log('phone: notes ok');

  // -- With "read my journal and chats" off, coach_journal and coach_messages are empty for the SQL tool --
  fake.queue.push({ tools: [['learn_sql', { query: messagesQuery }], ['learn_sql', { query: 'SELECT COUNT(*) AS n FROM coach_journal' }]] });
  fake.queue.push(body => {
    const [msgs, journal] = toolResults({ body }).map(item => JSON.parse(item));
    const n = rows => (Array.isArray(rows.rows[0]) ? rows.rows[0][0] : rows.rows[0].n);
    return { content: answerText(`Now: ${n(msgs)} messages, ${n(journal)} journal entries.`) };
  });
  mark = fake.requests.length;
  await say(page, 'How many messages have I sent you?', touch);
  assert.equal(await lastAnswer(page).locator('.h5-learn-chat-msg').last().textContent(), 'Now: 0 messages, 0 journal entries.');
  assert.match(fake.requests.slice(mark).find(item => item.kind === 'tools').body.messages[0].content, /coach_journal and coach_messages are empty/);

  // -- "Save tokens": at most 3 lookups per answer (6 without), then tool_choice none --
  const loop = body => (body.tool_choice === 'none' ? { content: answerText('Done looking.') } : { tools: [['learn_schema', {}]] });
  await openCoachSettings(page, touch);
  await press(page, '#h5-learn-coach-read-text', touch);
  await press(page, '#h5-learn-coach-economy', touch);
  await waitFor(async () => { const now = await settingsNow(page); return now.coach_economy === true && now.coach_read_text === true; }, 'Save tokens on');
  await backToCoach(page, touch);
  fake.responder = loop;
  mark = fake.requests.length;
  await say(page, 'Look at everything', touch);
  let rounds = fake.requests.slice(mark).filter(item => item.kind === 'tools');
  assert.deepEqual(rounds.map(item => item.body.tool_choice), ['auto', 'auto', 'auto', 'none'], 'economy: 3 rounds');
  await openCoachSettings(page, touch);
  await press(page, '#h5-learn-coach-economy', touch);
  await waitFor(async () => (await settingsNow(page)).coach_economy === false, 'Save tokens off');
  await backToCoach(page, touch);
  mark = fake.requests.length;
  await say(page, 'Look at everything again', touch);
  rounds = fake.requests.slice(mark).filter(item => item.kind === 'tools');
  assert.deepEqual(rounds.map(item => item.body.tool_choice), ['auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'none'], 'normal: 6 rounds');
  fake.responder = null;
  log('phone: economy ok');

  // -- A provider that answers 400 for tools: the no-tools notice and an answer from the short summary --
  configureModel(server.dbPath, fake.port, 'fake-notools');
  fake.refuse = true;
  fake.plain.push({ content: answerText('From the summary: you have some words due.') });
  mark = fake.requests.length;
  await say(page, 'How many are due?', touch);
  await page.locator('#h5-learn-coach-no-tools').waitFor(WAIT);
  assert.equal(await text(page, '#h5-learn-coach-no-tools'), 'This service cannot look up your data; she answers from a short summary.');
  const noTools = fake.requests.slice(mark).filter(item => item.kind !== 'other');
  assert.deepEqual(noTools.map(item => item.kind), ['tools', 'plain'], 'one refused tools call, then the answer without tools');
  assert.match(noTools[1].body.messages[0].content, /This service cannot look up the data/);
  assert.match(lastUser(noTools[1]), /Words often wrong: receive \(\d+\)/);
  assert.equal(await lastAnswer(page).locator('.h5-learn-chat-msg').last().textContent(), 'From the summary: you have some words due.');
  fake.refuse = false;
  configureModel(server.dbPath, fake.port, 'fake-model');

  // -- Earlier chats: read-only --
  await press(page, '#h5-learn-coach-more', touch);
  await press(page, '#h5-learn-coach-earlier', touch);
  await page.locator('#h5-learn-chats .h5-learn-chat-row').first().waitFor(WAIT);
  assert.equal(await page.locator('#h5-learn-chats .h5-learn-chat-row').count(), 1);
  assert.equal(await page.locator('#h5-learn-chat-new').count(), 0, 'no New chat');
  await press(page, '#h5-learn-chats .h5-learn-chat-row', touch);
  await page.locator('#h5-learn-chat .h5-learn-chat-msg[data-role="assistant"]', { hasText: 'means good luck' }).waitFor(WAIT);
  assert.equal(await page.locator('#h5-learn-chat-input').count(), 0, 'read-only: no input');
  await press(page, '#h5-learn-back', touch);
  await page.locator('#h5-learn-chats .h5-learn-chat-row').first().waitFor(WAIT);
  await backToCoach(page, touch);
  log('phone: no tools and earlier chats ok');

  // -- "Show my mistakes": open_screen -> a button under her answer -> Mistakes, whose back returns to her --
  fake.queue.push({ tools: [['open_screen', { screen: 'mistakes' }], ['open_screen', { screen: 'nowhere' }]] });
  fake.queue.push(body => { const results = toolResults({ body }).map(item => JSON.parse(item)); return { content: answerText(results[0].ok && results[1].error ? 'Your mistakes are here.' : 'Unexpected.') }; });
  mark = fake.requests.length;
  await say(page, 'Show my mistakes', touch);
  const opened = fake.requests.slice(mark).filter(item => item.kind === 'tools');
  assert.match(opened[0].body.messages[0].content, /call open_screen/, 'the prompt asks for open_screen');
  await lastAnswer(page).locator('.h5-learn-coach-screen[data-screen="mistakes"]').waitFor(WAIT);
  assert.match(await lastAnswer(page).evaluate(el => el.textContent), /Your mistakes are here\./);
  await press(page, lastAnswer(page).locator('.h5-learn-coach-screen[data-screen="mistakes"]'), touch);
  await page.waitForFunction(() => document.getElementById('h5-learn-view-title')?.textContent === 'Mistakes', null, WAIT);
  await backToCoach(page, touch);
  log('phone: open_screen ok');

  // -- /h5?learn=coach (the reminder's link) opens the coach --
  await page.goto(`${server.base}/h5?learn=coach`);
  await page.locator('#h5-learn-coach[data-layout="phone"]').waitFor(WAIT);
  await waitFor(async () => (await answers(page).count()) > 0, 'the persisted conversation');
  assert.equal(await page.evaluate(() => location.search), '', 'the link is taken out of the address');
  await one.context.close();
  return ids;
}

// ---- Computer: 1440x900, mouse ----
async function wideRun(browser, server, fake) {
  const touch = false;
  const one = await openPage(browser, server.base, { viewport: { width: 1440, height: 900 } });
  const { page } = one;
  await openLearn(page, touch);
  await page.locator('#h5-learn .h5-learn-pane #h5-learn-coach[data-layout="wide"]').waitFor(WAIT);
  // The persisted conversation of the phone.
  await page.locator('.h5-learn-chat-msg[data-role="assistant"]', { hasText: 'From the summary: you have some words due.' }).waitFor(WAIT);
  assert.equal(await page.locator('#h5-learn-coach-no-tools').count(), 0, 'another model: tools again');
  // Today's queue is used up on the phone: 3 more new words (the allowance is raised only by Start).
  const newLeft = async () => (await api(page, 'GET', '/api/learn/summary')).data.new_left;
  const leftBefore = await newLeft();
  fake.queue.push({ tools: [['propose_practice', { kind: 'more_new_words', count: 3 }]] });
  fake.queue.push(body => { const r = JSON.parse(toolResults({ body }).at(-1)); return { content: answerText(r.empty ? 'Nothing new.' : `${r.words} new words.`) }; });
  await page.locator('#h5-learn-coach-input').click();
  await page.keyboard.type('Give me 3 more new words');
  await quiet(page);
  const before = await answers(page).count();
  await page.keyboard.press('Enter');
  await settle(page, before);
  await lastAnswer(page).locator('.h5-learn-coach-card[data-type="plan"]').waitFor(WAIT);
  // The card of this answer by its uid: her reply to the practice result may come after it.
  const planUid = await lastAnswer(page).getAttribute('data-uid');
  const card = page.locator(`#h5-learn-coach .h5-learn-coach-answer[data-uid="${planUid}"] .h5-learn-coach-card[data-type="plan"]`);
  assert.equal(await card.locator('.h5-learn-coach-plan-caption').evaluate(el => el.textContent.trim()), '3 words · about 1 minute');
  assert.equal(await newLeft(), leftBefore, 'the allowance is not raised before Start');
  await card.locator('.h5-learn-coach-start').click();
  await page.locator('#h5-learn .h5-learn-pane #h5-learn-series').waitFor(WAIT);
  assert.equal(await page.locator('#h5-learn .h5-learn-home, #h5-learn-coach').count(), 0, 'the series takes her place; no home');
  const plan = one.responses.at(-1).body.plan;
  const words = plan.steps[0].cards.map(item => item.en);
  assert.equal(words.length, 3, `3 new words: ${words}`);
  assert.ok(plan.steps[0].cards.every(item => item.is_new), 'new words');
  assert.equal(await newLeft(), leftBefore + 3, 'Start raised today\'s allowance');
  fake.queue.push({ content: answerText('All right on the computer too.') });
  for (const word of words) assert.equal(await answerCard(page, one, word, touch), true);
  await page.locator('.h5-learn-coach-divider', { hasText: `Spelling finished · ${words.length === 1 ? '1 word' : `${words.length} words`} · 1 min` }).waitFor(WAIT);
  await page.locator('.h5-learn-chat-msg[data-role="assistant"]', { hasText: 'All right on the computer too.' }).waitFor(WAIT);
  // Escape leaves a series early: the same plan started again (it reads the queue again).
  fake.queue.push({ content: answerText('Stopped on the computer.') });
  await card.locator('.h5-learn-coach-start').click();
  const again = await Promise.race([
    page.locator('#h5-learn-series').waitFor(WAIT).then(() => 'series'),
    card.locator('.h5-learn-coach-plan-empty').waitFor(WAIT).then(() => 'empty'),
  ]);
  if (again === 'series') {
    const replan = one.responses.at(-1).body.plan;
    await answerCard(page, one, replan.steps[0].cards[0].en, touch);
    await page.locator('#h5-learn-spell-input').blur().catch(() => {});
    await page.keyboard.press('Escape');
    await page.locator('.h5-learn-coach-divider[data-stopped="true"]').last().waitFor(WAIT);
    await page.locator('.h5-learn-chat-msg[data-role="assistant"]', { hasText: 'Stopped on the computer.' }).waitFor(WAIT);
  } else fake.queue.shift();
  // Use the same word in a sentence gap and then in ungraded study followed by direct spelling.
  const practice = () => lastAnswer(page).locator('.h5-learn-coach-card[data-type="plan"]').locator('.h5-learn-coach-start');
  fake.queue.push(
    { tools: [['select_practice_words', { source: 'selected', words: ['receive'] }]] },
    { tools: [['propose_practice', { kind: 'word_practice', method: 'sentence_gap', examples: [
      { word: 'receive', sentence: 'Did you receive the package this morning?', zh: '\u4f60\u4eca\u65e9\u6536\u5230\u5305\u88f9\u4e86\u5417\uff1f' },
    ] }]] },
    { content: answerText('Here is a sentence gap.') },
  );
  await say(page, 'Give me a sentence gap for receive', touch);
  await practice().click();
  await page.locator('#h5-learn-series[data-exercise="fill"]').waitFor(WAIT);
  assert.match(await page.locator('.h5-learn-gap').innerText(), /Did you\s+the package this morning/);
  assert.ok(!(await page.locator('#h5-learn-series').innerText()).includes('Did you receive'));
  fake.queue.push({ content: answerText('Sentence gap done.') });
  assert.equal(await answerCard(page, one, 'receive', touch), true);
  await lastAnswer(page).getByText('Sentence gap done.').waitFor(WAIT);

  fake.queue.push(
    { tools: [['select_practice_words', { source: 'previous' }]] },
    { tools: [['propose_practice', { kind: 'word_practice', method: 'study_then_spell' }]] },
    { content: answerText('Study it first, then spell it.') },
  );
  await say(page, 'Use the same word and show it before spelling', touch);
  await practice().click();
  await page.locator('#h5-learn-series[data-step="study"]').getByText('receive', { exact: true }).waitFor(WAIT);
  const graded = one.of('POST', /\/cards\/\d+\/answer$/).length;
  await page.getByRole('button', { name: 'Start spelling' }).click();
  await page.locator('#h5-learn-series[data-step="direct_spell"] #h5-learn-spell-input').waitFor(WAIT);
  assert.equal(one.of('POST', /\/cards\/\d+\/answer$/).length, graded);
  fake.queue.push({ content: answerText('Spelling after study is done.') });
  assert.equal(await answerCard(page, one, 'receive', touch), true);
  await lastAnswer(page).getByText('Spelling after study is done.').waitFor(WAIT);

  // A standalone fill session uses the same word card as the coach and keeps the example masked.
  const allowance = await api(page, 'POST', '/api/learn/new-words', { count: 5 });
  assert.ok(allowance.data.new_left > 0, JSON.stringify(allowance.data));
  const example = 'The rear weight will counterbalance the heavy motor.';
  const made = await api(page, 'POST', '/api/learn/cards', { kind: 'word', en: 'counterbalance', zh: '\u62b5\u6d88', context: example });
  assert.equal(made.data.created, true);
  assert.equal(made.data.card.context, example);
  const queue = await api(page, 'GET', '/api/learn/queue?mode=fill');
  assert.deepEqual(queue.data.cards.map(card => [card.id, card.kind]), [[made.data.card.id, 'word']]);
  fake.queue.push(
    { tools: [['open_screen', { screen: 'fill' }]] },
    { content: answerText('Open Fill the gap.') },
  );
  await say(page, 'Open Fill the gap', touch);
  await lastAnswer(page).getByRole('button', { name: 'Fill the gap' }).click();
  await page.locator('#h5-learn-gap-input').fill('counterbalance');
  assert.doesNotMatch(await page.locator('.h5-learn-gap').innerText(), /counterbalance/);
  await page.locator('#h5-learn-feedback[data-correct="true"]').waitFor(WAIT);
  await page.locator('#h5-learn-grade-good').click();
  await waitFor(() => one.of('POST', new RegExp(`/cards/${made.data.card.id}/answer$`)).length === 1, 'the word card received the grade');
  await page.locator('#h5-learn-done').waitFor(WAIT);
  await page.locator('#h5-learn-back').click();
  await page.locator('#h5-learn-coach').waitFor(WAIT);

  // Earlier chats in the pane, read-only; Close returns to the coach.
  await page.locator('#h5-learn-coach-more').click();
  await page.locator('#h5-learn-coach-earlier').click();
  await page.locator('#h5-learn-chat[data-readonly="true"]').waitFor(WAIT);
  await page.locator('#h5-learn-chat .h5-learn-chat-row').first().click();
  await page.locator('#h5-learn-chat .h5-learn-chat-msg[data-role="assistant"]', { hasText: 'means good luck' }).waitFor(WAIT);
  assert.equal(await page.locator('#h5-learn-chat-input, #h5-learn-chat-new').count(), 0);
  await page.locator('#h5-learn-back').click();
  await page.locator('#h5-learn-coach').waitFor(WAIT);
  log('wide: ok');
  return one;
}

// ---- A long conversation: 160 older messages; the budgets, the fold into the summary and the stable prefix ----
async function longRun(one, server, fake) {
  const { page } = one;
  const oldest = readDb(server.dbPath, db => db.prepare("SELECT MIN(at) AS at FROM learn_convo_messages WHERE owner = ? AND convo_uid = 'coach'").get(OWNER).at);
  const db = new Database(server.dbPath);
  try {
    db.pragma('busy_timeout = 5000');
    const insert = db.prepare("INSERT INTO learn_convo_messages (owner, uid, convo_uid, role, text, at, meta, by, sync_seq) VALUES (?, ?, 'coach', ?, ?, ?, ?, '', 0)");
    db.transaction(() => {
      for (let index = 0; index < 160; index += 1) {
        const role = index % 2 ? 'assistant' : 'user';
        const body = `${role === 'user' ? 'Question' : 'Answer'} ${index}: ${'practice makes perfect, '.repeat(14)}`;
        insert.run(OWNER, crypto.randomUUID(), role, body, oldest - (160 - index) * 60000, role === 'user' ? '' : '{}');
      }
    })();
  } finally { db.close(); }
  await page.reload();
  await openLearn(page, false);
  await waitFor(async () => (await answers(page).count()) > 0, 'the newest page');
  const shown = await page.locator('#h5-learn-coach .h5-learn-chat-msg, #h5-learn-coach .h5-learn-coach-divider').count();
  assert.ok(shown <= 50, `the newest page only (${shown})`);
  const folds = fake.folds;
  const ask = async question => {
    fake.queue.push({ content: answerText(`Reply to ${question}.`) });
    const mark = fake.requests.length;
    await quiet(page);
    const before = await answers(page).count();
    await page.locator('#h5-learn-coach-input').fill(question);
    await page.locator('#h5-learn-coach-send').click();
    await settle(page, before);
    return fake.requests.slice(mark).find(item => item.kind === 'tools');
  };
  const size = request => request.body.messages.slice(1, -1).reduce((sum, item) => sum + String(item.content || '').length, 0);
  // The backlog (about 56,000 characters) is folded over the next sends, one batch (at most 24,000 characters of input) after each answer, until the
  // messages after the summary fit; every request stays within the history budget meanwhile.
  const asked = [];
  for (let round = 1; round <= 6; round += 1) {
    const before = fake.folds;
    const request = await ask(`Long ${round}`);
    assert.ok(size(request) <= 18000, `the history is within its budget (${size(request)})`);
    assert.ok(request.body.messages[0].content.length <= 6500, `the system message is within its budgets (${request.body.messages[0].content.length})`);
    asked.push(request);
    await new Promise(resolve => setTimeout(resolve, 800)); // the fold runs after the answer
    if (fake.folds === before) break;
  }
  const foldRequests = fake.requests.filter(item => item.kind === 'fold').slice(-(fake.folds - folds));
  assert.ok(foldRequests.length >= 2, `the backlog takes more than one fold (${foldRequests.length})`);
  assert.equal(foldRequests[0].body.temperature, 0.2);
  assert.match(foldRequests[0].body.messages[1].content, /^Summary so far:\n\(none\)\n\nNew messages:\nPerson: Question 0:/, 'the first fold starts at the oldest message');
  assert.ok(foldRequests.every(item => item.body.messages[1].content.length <= 24000 + 2000 + 200), 'each fold reads at most its input cap');
  assert.match(foldRequests[1].body.messages[1].content, new RegExp(`^Summary so far:\\nSUMMARY-${folds + 1}:`), 'the next fold builds on the summary');
  const latest = asked.at(-1);
  assert.match(latest.body.messages[0].content, new RegExp(`Summary of the earlier conversation \\(data\\):\\nSUMMARY-${fake.folds}:`));
  // Two requests without a fold between them: the stable prefix (the same system message and older messages); only the newest message differs.
  const next = await ask('Long after');
  assert.equal(next.body.messages[0].content, latest.body.messages[0].content, 'the system message is the same bytes');
  const shared = latest.body.messages.length - 1;
  assert.deepEqual(next.body.messages.slice(0, shared), latest.body.messages.slice(0, shared), 'the older messages are the same');
  assert.equal(next.body.messages[shared].content, `Long ${asked.length}`, 'the earlier question goes without today\'s line');
  assert.deepEqual(next.body.tools, latest.body.tools, 'the same tools');
  // Scrolling up reads the older page.
  await page.locator('#h5-learn-coach-scroll').evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  await waitFor(() => one.traffic.some(item => item.path === '/api/learn/coach' && /before=/.test(item.search)), 'the older page is read');
  log('long: ok');
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-coach-e2e-'));
  fs.mkdirSync(path.join(temp, 'home'), { recursive: true });
  const fake = await fakeModel();
  const server = await startServer(temp);
  configureModel(server.dbPath, fake.port);
  const browser = await chromium.launch({ headless: true });
  try {
    await phoneRun(browser, server, fake);
    const wide = await wideRun(browser, server, fake);
    await longRun(wide, server, fake);
    await wide.context.close();
    assert.deepEqual(pageErrors, [], 'no page errors');
    console.log('Learn coach e2e: all checks passed');
  } catch (error) {
    if (process.env.COACH_E2E_VERBOSE) console.error(server.log().slice(-4000));
    throw error;
  } finally {
    await browser.close();
    server.child.kill('SIGTERM');
    fake.server.close();
    await new Promise(resolve => setTimeout(resolve, 500));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const limit = setTimeout(() => { console.error(`Learn coach e2e: over ${LIMIT_MS / 1000} s`); process.exit(1); }, LIMIT_MS);
main().then(() => { clearTimeout(limit); }, error => { console.error(error); process.exit(1); });
