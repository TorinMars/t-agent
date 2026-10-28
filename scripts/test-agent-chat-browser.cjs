// Browser test of the chat-style agent view: the real router and UI files, with scripted agents behind them.
const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const express = require('express');

const root = path.resolve(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-chat-browser-'));
process.env.T_AGENT_DATA_DIR = data;
process.env.TASKS_BASE_DIR = path.join(data, 'tasks');
const db = require('../db');
const tasks = require('../services/engine-tasks');
const { createAgentChat } = require('../services/agent-chat');
const { createAgentChatRouter } = require('../routes/agent-chat');

const task = tasks.createTask('owner', { title: 'chat' });
const received = [];
const reviewSeen = [];
const adapter = {
  MODES: { ask: {}, edits: {}, plan: {}, full: {} }, DEFAULT_MODE: 'ask', CAPABILITIES: { models: true, commands: true },
  listCommands: async () => [
    { name: 'clear', description: 'Start a new session with empty context', argumentHint: '' },
    { name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '[instructions]' },
    { name: 'context', description: 'Show current context usage', argumentHint: '' },
  ],
  listModels: async () => [
    { value: 'sonnet', label: 'Sonnet 5.5', description: 'Everyday tasks', efforts: ['low', 'high'], defaultEffort: '' },
    { value: 'opus', label: 'Opus 5.5', description: 'Hardest tasks', efforts: ['high', 'max'], defaultEffort: '' },
  ],
  loadHistory: async () => [],
  async runTurn({ prompt, ctx, requestPermission, signal, sessionId }) {
    received.push(prompt);
    if (/review/.test(prompt.text)) {
      ctx.upsert({ id: 'r1', kind: 'tool', name: 'Bash', input: { command: 'ls' }, output: 'a', status: 'done' });
      ctx.upsert({ id: 'r2', kind: 'tool', name: 'Bash', input: { command: 'make' }, output: 'boom', status: 'error' });
      const ask = request => requestPermission(request).then(answer => { reviewSeen.push(answer); return answer; });
      await ask({ kind: 'question', tool: 'AskUserQuestion', input: {}, title: 'Claude has a question', questions: [
        { id: '0', header: 'Features', question: 'Which features?', multiSelect: true, isOther: true, options: [{ label: 'Caching', description: 'Keep results' }, { label: 'Telemetry', description: '' }] },
        { id: '1', header: 'Library', question: 'Which library?', multiSelect: false, isOther: true, options: [{ label: 'date-fns', description: 'Small' }, { label: 'dayjs', description: 'Familiar', preview: 'dayjs()' }] },
      ] });
      await ask({ kind: 'plan', tool: 'ExitPlanMode', input: {}, title: 'Review the plan', plan: '# The plan\n\n- first **step**\n\n| a | b |\n|---|---|\n| 1 | 2 |' });
      await ask({ kind: 'plan', tool: 'ExitPlanMode', input: {}, title: 'Review the plan', plan: '# The revised plan' });
      await ask({ tool: 'Edit', input: { file_path: '/work/a.js', old_string: 'const x = 1;\nlog(x);', new_string: 'const x = 2;\nlog(x);' }, title: 'Edit /work/a.js', canRemember: true });
      ctx.upsert({ id: 'rm', kind: 'text', text: 'Reviewed everything.' });
      return { ok: true };
    }
    ctx.setSession('session-abcdef12');
    ctx.setMeta({
      model: 'claude-sonnet-5-5', effort: 'medium', context: { used: 42000, window: 200000 },
      limits: [{ id: '5h', label: '5h', usedPercent: 37.5, resetsAt: Date.now() + 4.2 * 3600000 }, { id: '7d', label: '7d', usedPercent: 20, resetsAt: Date.now() + 3.5 * 24 * 3600000 }],
    });
    if (!sessionId) ctx.upsert({ id: 'init:1', kind: 'init', text: 'Initialized session', details: [['Model', 'claude-sonnet-5-5'], ['Session', 'session-abcdef12']] });
    if (prompt.text === '/clear') { // what Claude Code does: the chat is reset, then the new session is announced
      ctx.resetConversation();
      ctx.upsert({ id: 'reset:1', kind: 'notice', text: 'Started a new session' });
      return { ok: true };
    }
    if (/^queued/.test(prompt.text)) { ctx.upsert({ id: 'q1', kind: 'text', text: 'Got the queued message.' }); return { ok: true }; }
    if (/slow/.test(prompt.text)) {
      ctx.upsert({ id: 's1', kind: 'text', text: 'Thinking about it' });
      await new Promise(resolve => signal.addEventListener('abort', resolve));
      return { ok: false, error: '' };
    }
    ctx.upsert({ id: 'th', kind: 'thinking', text: 'plan the answer' });
    ctx.upsert({ id: 'm1', kind: 'text', text: 'Here is **bold**, `code` and a list:\n- one\n- two\n\n```js\nconsole.log(1)\n```\n<img src=x onerror=window.pwned=1>' });
    ctx.upsert({ id: 't1', kind: 'tool', name: 'Bash', input: { command: 'rm -rf build' }, output: '', status: 'running' });
    const answer = await requestPermission({ tool: 'Bash', input: { command: 'rm -rf build' }, title: 'Run rm -rf build', description: 'rm -rf build' });
    ctx.upsert({ id: 't1', kind: 'tool', name: 'Bash', input: { command: 'rm -rf build' }, output: answer.allow ? 'removed' : 'denied', status: answer.allow ? 'done' : 'error' });
    ctx.upsert({ id: 'm2', kind: 'text', text: answer.allow ? 'Done.' : 'Skipped.' });
    return { ok: true };
  },
};
// Codex: asks a question, then for a command (which can be allowed for the session), and takes input while it works.
const codexSeen = { answers: [], approvals: [], steers: [] };
const codexAdapter = {
  MODES: { readonly: {}, write: {}, full: {} }, DEFAULT_MODE: 'write', CAPABILITIES: { steer: true, models: true },
  loadHistory: async () => [],
  async runTurn({ ctx, requestPermission }) {
    let release;
    const steered = new Promise(resolve => { release = resolve; });
    ctx.setControl({ steer: async prompt => { codexSeen.steers.push(prompt.text); release(); } });
    ctx.upsert({ id: 'c1', kind: 'text', text: 'Working on it' });
    codexSeen.answers.push(await requestPermission({ kind: 'question', tool: 'Question', title: 'Codex has a question', input: {},
      questions: [{ id: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'red', description: '' }, { label: 'blue', description: '' }], isOther: true, isSecret: false }] }));
    codexSeen.approvals.push(await requestPermission({ tool: 'Shell', input: { command: 'touch x' }, title: 'Run touch x', description: 'touch x', canRemember: true }));
    await steered;
    return { ok: true };
  },
};
const chat = createAgentChat({ db, adapters: { claude: adapter, codex: codexAdapter } });
const app = express();
app.use(express.json());
app.use('/api/tasks/:id/agent', createAgentChatRouter({ service: chat, authenticate: (req, res, next) => { req.session = { user: { login: 'owner' } }; next(); } }));
app.use(express.static(path.join(root, 'public')));
app.get('/harness', (req, res) => res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/css/agent-chat.css"><link rel="stylesheet" href="/css/themes.css"><style>html,body,#host{height:100%;margin:0}</style><div id="host"></div>
<script src="/js/agent-chat.js"></script>
<script>
const call = (method, url, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; });
window.api = { get: u => call('GET', u), post: (u, b) => call('POST', u, b), patch: (u, b) => call('PATCH', u, b), del: u => call('DELETE', u) };
window.base = '/api/tasks/${task.id}/agent';
window.notices = [];
window.closes = 0;
window.titles = [];
AgentChat.setOpenHandler(data => window.opened.push(data));
window.openChat = async (agent, choice) => { const conversation = await AgentChat.open(window.api, base, agent, choice); window.conversation = conversation; window.view = AgentChat.mount(document.getElementById('host'), { api: window.api, base, conversation, onClose: () => { window.closes++; }, onTitle: title => window.titles.push(title), notify: m => window.notices.push(m) }); return conversation; };
</script>`));
const server = http.createServer(app);

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
    // A stand-in recognizer that records what the page does to it.
    await page.addInitScript(() => {
      // The page's speech model (voice-input.js) is replaced by a fake with the same attach() contract: a click toggles the recording, the
      // text goes into the textarea it was given (and an input event), and the button gets the class "listening" while it records.
      // Notifications: the page is hidden when window.away is set; the notifications the page makes are collected.
      window.away = false;
      window.notes = [];
      window.opened = [];
      window.Notification = class { static permission = 'granted'; static requestPermission() { return Promise.resolve('granted'); } constructor(title, options) { this.title = title; this.options = options; window.notes.push(this); } close() {} };
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.away });
      document.hasFocus = () => !window.away;
      window.voice = { attached: 0, started: 0, stopped: 0, textarea: null, base: '' };
      window.SpeechRecognition = class { start() { window.voice.browser = true; } };
      window.VoiceInput = {
        attach({ textarea, button }) {
          window.voice.attached += 1;
          window.voice.textarea = textarea;
          let state = 'idle';
          button.addEventListener('click', () => {
            if (state === 'idle') { state = 'listening'; window.voice.started += 1; window.voice.base = textarea.value; button.classList.add('listening'); }
            else { state = 'idle'; window.voice.stopped += 1; button.classList.remove('listening'); }
          });
          // finish(): what the send button calls while recording; the recording ends and the last words arrive a moment later.
          const finish = async () => { if (state === 'idle') return; state = 'idle'; window.voice.stopped += 1; button.classList.remove('listening'); await new Promise(resolve => setTimeout(resolve, 50)); window.VoiceInput.say(window.voice.said + ' now'); };
          return { finish, stop() { return finish(); }, cancel() { state = 'idle'; button.classList.remove('listening'); }, get state() { return state; } };
        },
        say(text) { window.voice.said = text.replace(/ now$/, ''); const box = window.voice.textarea; box.value = window.voice.base + text; box.dispatchEvent(new Event('input', { bubbles: true })); },
      };
    });
    page.on('pageerror', error => { throw error; });
    await page.goto(`${origin}/harness`);
    await page.evaluate(() => openChat('claude', null));
    await page.waitForSelector('.agent-chat');
    // The themes style every textarea (the tech theme gives it a background and a border colour); the one of the composer stays part of the box.
    for (const theme of ['tech', 'dark']) {
      await page.evaluate(name => { document.documentElement.dataset.theme = name; }, theme);
      assert.deepEqual(await page.locator('.ac-input').evaluate(node => { const style = getComputedStyle(node); return [style.backgroundColor, style.borderTopWidth]; }), ['rgba(0, 0, 0, 0)', '0px'], `${theme} theme`);
    }
    await page.evaluate(() => { delete document.documentElement.dataset.theme; });
    assert.equal(await page.locator('.ac-badge').textContent(), '✳');
    assert.deepEqual(await page.locator('.ac-mode option').allTextContents(), ['Ask before changes', 'Accept edits', 'Plan only', 'Full access (no prompts)']);

    // A turn: the answer streams in, the tool waits for approval, and the page never runs markup the agent wrote.
    await page.fill('.ac-input', 'clean the build');
    await page.click('.ac-send');
    await page.waitForSelector('.ac-request');
    assert.equal(await page.locator('.ac-user .ac-bubble').textContent(), 'clean the build');
    assert.equal(await page.locator('.ac-request-title').textContent(), 'Run rm -rf build');
    assert.equal(await page.locator('.ac-stop').isVisible(), true, 'Stop is there while the turn runs');
    assert.equal(await page.locator('.ac-send').count(), 0, 'and Send only when there is something to send');
    // The turn shows how long it has run, the session start folds away, and the model is next to the composer.
    assert.match(await page.locator('.ac-working .ac-elapsed').textContent(), /^\d+s$/);
    assert.equal(await page.locator('.ac-init summary').textContent(), 'Initialized session');
    assert.equal(await page.locator('.ac-init').evaluate(node => node.open), false);
    await page.locator('.ac-init summary').click();
    assert.deepEqual(await page.locator('.ac-init-body dt').allTextContents(), ['Model', 'Session']);
    assert.equal(await page.locator('.ac-model').textContent(), 'Sonnet 5.5 Medium');
    // The ring says how much of the context window is used, and changes colour as it fills.
    assert.equal(await page.locator('.ac-context').getAttribute('aria-label'), 'Context: 21% used (42k of 200k tokens)');
    // What is left of the plan windows and when they reset: one unit, decimals allowed.
    assert.deepEqual(await page.locator('.ac-limit').allTextContents(), ['62.5% · 4.2h', '80% · 3.5d']);
    assert.equal(await page.locator('.ac-limit').first().getAttribute('title'), '5h limit: 62.5% left, resets in 4.2h');
    // A click on the usage asks the server to read it again; it stays shown and usable afterwards.
    const [refreshRequest] = await Promise.all([page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/limits/refresh')), page.click('.ac-limits')]);
    assert.ok(refreshRequest, 'clicking the usage asks for a fresh reading');
    await page.waitForFunction(() => !document.querySelector('.ac-limits').disabled);
    assert.deepEqual(await page.locator('.ac-limit').allTextContents(), ['62.5% · 4.2h', '80% · 3.5d']);
    // The composer icons keep a real size (they were specks on an iPhone).
    for (const selector of ['.ac-attach svg', '.ac-mic svg']) {
      const box = await page.locator(selector).first().boundingBox();
      assert.deepEqual([box.width, box.height], [18, 18], `${selector} is 18px`);
    }
    // The usage is its own row below the input box and above the footer that holds the access level and the model.
    const [composerBox, limitsBox, footBox] = await Promise.all([page.locator('.ac-composer').boundingBox(), page.locator('.agent-chat > .ac-meta').boundingBox(), page.locator('.ac-foot').boundingBox()]);
    assert.ok(limitsBox.y >= composerBox.y + composerBox.height - 1 && limitsBox.y + limitsBox.height <= footBox.y + 1, 'usage sits between the input box and the footer');
    // The usage is right-aligned, on the same side as the model: its right edge matches the footer's content edge.
    const lastLimitBox = await page.locator('.ac-limit').last().boundingBox();
    assert.ok(Math.abs((lastLimitBox.x + lastLimitBox.width) - (footBox.x + footBox.width - 24)) <= 1, 'usage is right-aligned');
    // The translation switch shares that row: on the left edge of the footer content, left of the usage, above the access level.
    const [switchBox, firstLimitBox, modeBox] = await Promise.all([page.locator('.ac-options-button').boundingBox(), page.locator('.ac-limit').first().boundingBox(), page.locator('.ac-mode-label').boundingBox()]);
    assert.ok(Math.abs(switchBox.x - modeBox.x) <= 1, 'the switch is left-aligned with the access level');
    assert.ok(switchBox.x + switchBox.width <= firstLimitBox.x, 'the switch is left of the usage');
    assert.ok(switchBox.y + switchBox.height <= footBox.y + 1 && switchBox.y >= composerBox.y + composerBox.height - 1, 'the switch sits between the input box and the footer');
    assert.equal(await page.locator('.ac-context').getAttribute('class'), 'ac-context');
    assert.equal(await page.locator('.ac-context-value').getAttribute('stroke-dasharray'), `${2 * Math.PI * 8 * 0.21} ${2 * Math.PI * 8}`);
    assert.match(await page.locator('.ac-mode-text').textContent(), /Ask before changes/);
    assert.equal(await page.locator('.ac-text strong').textContent(), 'bold');
    assert.deepEqual(await page.locator('.ac-text li').allTextContents(), ['one', 'two']);
    assert.equal(await page.locator('.ac-text pre code').textContent(), 'console.log(1)');
    assert.equal(await page.locator('.ac-text img').count(), 0, 'agent text is never parsed as HTML');
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    assert.equal(await page.locator('.ac-tool.running').count(), 1);
    assert.equal(await page.locator('.ac-toolgroup > summary').textContent(), '1 running · 0 finished', 'while a call runs the line only counts them');
    assert.equal(await page.locator('.ac-toolgroup > summary .ac-step-icon.running').count(), 1);
    await page.click('.ac-allow');
    await page.waitForSelector('.ac-tool.done', { state: 'attached' });
    await page.waitForSelector('.ac-stop', { state: 'detached' });
    assert.equal(await page.locator('.ac-request').count(), 0);
    assert.equal(await page.locator('.ac-toolgroup > summary').textContent(), 'Ran 1 command', 'the calls of a turn are one folded line');
    assert.equal(await page.locator('.ac-steps').isVisible(), false);
    await page.locator('.ac-toolgroup > summary').click();
    assert.equal(await page.locator('.ac-steps .ac-step-icon.done').count(), 1);
    await page.locator('.ac-tool summary').click();
    assert.equal(await page.locator('.ac-tool-output').textContent(), 'removed');
    assert.equal(await page.locator('.ac-text').last().textContent(), 'Done.');
    assert.equal(await page.locator('.ac-title').textContent(), 'clean the build', 'the first prompt names the chat');

    // Stop interrupts a long turn; the access level and attachments reach the server.
    await page.fill('.ac-input', 'slow task');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.ac-stop:visible');
    // Claude cannot take input mid-turn, so Enter and Ctrl+Enter both queue a message; it waits, and goes out when the turn ends or is stopped.
    assert.match(await page.locator('.ac-input').getAttribute('placeholder'), /to queue for later/);
    await page.fill('.ac-input', 'queued one');
    await page.keyboard.press('Control+Enter');
    await page.fill('.ac-input', 'queued two');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.locator('.ac-queued > span:first-child').allTextContents(), ['queued one', 'queued two']);
    assert.equal(await page.locator('.ac-input').inputValue(), '');
    await page.getByLabel('Remove from the queue').nth(1).click();
    assert.deepEqual(await page.locator('.ac-queued > span:first-child').allTextContents(), ['queued one']);
    // A queued message can be edited: the pencil turns it into an input, Enter keeps the change and Escape drops it.
    await page.getByLabel('Edit the queued message').click();
    await page.locator('.ac-queued-input').fill('thrown away');
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.locator('.ac-queued > span:first-child').allTextContents(), ['queued one'], 'Escape keeps the old text');
    await page.getByLabel('Edit the queued message').click();
    await page.locator('.ac-queued-input').fill('queued edited');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.locator('.ac-queued > span:first-child').allTextContents(), ['queued edited']);
    assert.equal(await page.locator('.ac-queued .ac-chip-force').count(), 1, 'the agent cannot take input mid-turn, so the send button stops it first');
    // The queue is kept with the chat: after a refresh the chat is opened again with the same queue, and the turn is still running.
    await page.waitForFunction(() => api.get(`${base}/conversations/${conversation.id}`).then(snapshot => snapshot.queue.length === 1));
    const reopened = await page.evaluate(() => conversation);
    await page.goto(`${origin}/harness`);
    await page.evaluate(row => openChat('claude', { conversation: row }), reopened);
    await page.waitForSelector('.ac-queued');
    assert.deepEqual(await page.locator('.ac-queued > span:first-child').allTextContents(), ['queued edited'], 'the queue, with the edit, is still there after a refresh');
    await page.waitForSelector('.ac-stop:visible');
    await page.click('.ac-stop');
    await page.waitForSelector('.ac-notice');
    assert.equal(await page.locator('.ac-notice').textContent(), 'Stopped');
    await page.waitForFunction(() => document.querySelectorAll('.ac-user').length === 3 && !document.querySelector('.ac-queued'));
    assert.equal(received.at(-1).text, 'queued edited', 'Stop goes on with the queue: the next message is sent');
    await page.waitForSelector('.ac-stop', { state: 'detached' });
    // Force send: the running turn is stopped and the chosen message goes out at once, ahead of the one queued before it.
    await page.fill('.ac-input', 'slow again');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.ac-stop:visible');
    await page.fill('.ac-input', 'queued first');
    await page.keyboard.press('Enter');
    await page.fill('.ac-input', 'queued second');
    await page.keyboard.press('Enter');
    await page.locator('.ac-queued', { hasText: 'queued second' }).locator('.ac-chip-force').click();
    // The forced message's turn ends normally, so the queue goes on with the one that was queued first.
    for (let i = 0; i < 100 && received.at(-1).text !== 'queued first'; i += 1) await page.waitForTimeout(50);
    assert.deepEqual(received.slice(-2).map(prompt => prompt.text), ['queued second', 'queued first'], 'the chosen message went first');
    await page.waitForFunction(() => !document.querySelector('.ac-queued') && !document.querySelector('.ac-stop'));
    // The expanded input box: Enter is a new line there, and only the send button sends (no key does). Collapsed, Enter sends again.
    const input = page.locator('.ac-input');
    await page.fill('.ac-input', 'queued one');
    const smallHeight = (await input.boundingBox()).height;
    assert.equal(await page.getByLabel('Expand the input box').getAttribute('aria-pressed'), 'false');
    await page.getByLabel('Expand the input box').click();
    assert.equal(await page.getByLabel('Collapse the input box').getAttribute('aria-pressed'), 'true');
    assert.match(await input.getAttribute('placeholder'), /new line; use the send button/);
    assert.ok((await input.boundingBox()).height >= smallHeight + 60, 'the box is taller');
    const sentBefore = received.length;
    await input.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('two');
    assert.equal(await input.inputValue(), 'queued one\ntwo', 'Enter is a new line');
    await page.keyboard.press('Control+Enter');
    await page.keyboard.press('Meta+Enter');
    await page.waitForTimeout(300);
    assert.equal(received.length, sentBefore, 'no key sends from the expanded box');
    await page.click('.ac-send');
    for (let i = 0; i < 100 && received.length === sentBefore; i += 1) await page.waitForTimeout(50);
    assert.equal(received.at(-1).text, 'queued one\ntwo', 'the button sends, line break and all');
    await page.waitForSelector('.ac-stop', { state: 'detached' });
    assert.equal(await page.evaluate(() => notes.length), 0, 'no notification while the person is looking at the chat, nor for the turns that were stopped');
    await page.getByLabel('Collapse the input box').click();
    assert.equal(await page.getByLabel('Expand the input box').getAttribute('aria-pressed'), 'false');
    // The Enter that picks an IME candidate must not send: WebKit reports it with isComposing already false and keyCode 229.
    await page.fill('.ac-input', 'nihao');
    const sentBeforeIme = received.length;
    await page.evaluate(() => {
      const box = document.querySelector('.ac-input');
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: false, bubbles: true, cancelable: true }));
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, isComposing: true, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(300);
    assert.equal(received.length, sentBeforeIme, 'an IME Enter does not send');
    assert.equal(await input.inputValue(), 'nihao', 'and the text stays');
    await page.evaluate(() => { window.away = true; }); // the next turn ends while the app page is hidden
    await page.fill('.ac-input', 'queued plain');
    await page.keyboard.press('Enter');
    for (let i = 0; i < 100 && received.at(-1).text !== 'queued plain'; i += 1) await page.waitForTimeout(50);
    assert.equal(received.at(-1).text, 'queued plain', 'collapsed, Enter sends');
    await page.waitForSelector('.ac-stop', { state: 'detached' });
    // The notification: the chat, the last thing the agent said, one per chat; a click shows the chat.
    await page.waitForFunction(() => notes.length === 1);
    const note = await page.evaluate(() => ({ title: notes[0].title, body: notes[0].options.body, tag: notes[0].options.tag, data: notes[0].options.data }));
    assert.match(note.title, /^Claude: /);
    assert.equal(note.body, 'Got the queued message.');
    assert.match(note.tag, /^agent-chat:/);
    assert.deepEqual([note.data.taskId, note.data.remote, note.data.page], [task.id, false, '/harness']);
    await page.evaluate(() => notes[0].onclick());
    assert.deepEqual(await page.evaluate(() => opened.map(data => data.conversationId)), [note.data.conversationId], 'a click asks the page to show that chat');
    await page.evaluate(() => { window.away = false; });
    await page.selectOption('.ac-mode', 'edits');
    await page.waitForFunction(() => document.querySelector('.ac-mode').value === 'edits');
    await page.setInputFiles('.agent-chat input[type=file]', [
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('remember this') },
      { name: 'pic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgo=', 'base64') },
      { name: 'tool.exe', mimeType: 'application/octet-stream', buffer: Buffer.alloc(300 * 1024) },
    ]);
    await page.waitForSelector('.ac-attachments .ac-chip');
    assert.deepEqual(await page.locator('.ac-attachments .ac-chip span:first-child').allTextContents(), ['notes.txt', 'pic.png']);
    assert.ok((await page.evaluate(() => notices)).some(message => /tool\.exe is too large/.test(message)));
    // An image pasted while the focus is in the message list (not in the input box) is attached too, and so is one that only the clipboard items list.
    const pasteImage = (selector, viaItems) => page.evaluate(({ selector, viaItems }) => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgo='), char => char.charCodeAt(0));
      const file = new File([bytes], 'shot.png', { type: 'image/png' });
      const data = new DataTransfer();
      data.items.add(file);
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      if (viaItems) Object.defineProperty(event.clipboardData, 'files', { value: [] });
      document.querySelector(selector).dispatchEvent(event);
      return event.defaultPrevented;
    }, { selector, viaItems });
    assert.equal(await pasteImage('.ac-messages', false), true, 'a paste outside the input box is taken');
    assert.equal(await pasteImage('.ac-input', true), true, 'a paste whose files list is empty is read from the items');
    await page.waitForFunction(() => document.querySelectorAll('.ac-attachments .ac-chip').length === 4);
    await page.locator('.ac-attachments .ac-chip').nth(3).locator('.ac-chip-remove').click();
    await page.locator('.ac-attachments .ac-chip').nth(2).locator('.ac-chip-remove').click();
    assert.equal(await page.locator('.ac-attachments .ac-chip').count(), 2);
    await page.fill('.ac-input', 'use these');
    await page.click('.ac-send');
    await page.waitForFunction(() => document.querySelectorAll('.ac-user').length === 9);
    assert.equal(received.at(-1).images.length, 1);
    assert.match(received.at(-1).text, /Attached file notes\.txt:[\s\S]*remember this/);
    // The page clears them when the request returns, which can be after the message arrived over the event stream.
    await page.waitForSelector('.ac-attachments .ac-chip', { state: 'detached' });
    assert.equal(await page.locator('.ac-attachments .ac-chip').count(), 0, 'attachments are cleared after sending');

    // The title opens a menu: rename the chat or close it.
    await page.click('.ac-title-button');
    assert.deepEqual(await page.locator('.ac-menu button').allTextContents(), ['Rename…', 'Close chat']);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.ac-menu').count(), 0);
    for (const name of ['Renamed chat', 'clean the build']) {
      page.once('dialog', dialog => dialog.accept(name));
      await page.click('.ac-title-button');
      await page.getByRole('menuitem', { name: 'Rename…' }).click();
      await page.waitForFunction(expected => document.querySelector('.ac-title').textContent === expected, name);
    }
    assert.deepEqual((await page.evaluate(() => window.titles)).slice(-2), ['Renamed chat', 'clean the build'], 'the page that holds the chat is told each new title');

    // The model and effort in the footer open a list of both; a choice is saved for the next messages.
    await page.click('.ac-picker-button');
    await page.waitForSelector('.ac-picker-item');
    assert.deepEqual(await page.locator('.ac-picker-name').allTextContents(), ['Default', 'Sonnet 5.5', 'Opus 5.5']);
    assert.equal(await page.locator('.ac-picker-item[aria-checked="true"] .ac-picker-name').textContent(), 'Default');
    assert.deepEqual(await page.locator('.ac-picker-effort').allTextContents(), ['Default', 'Low', 'High', 'Max']);
    await page.locator('.ac-picker-item', { hasText: 'Opus 5.5' }).click();
    await page.waitForFunction(() => document.querySelector('.ac-picker-button').textContent === 'Opus');
    assert.deepEqual(await page.locator('.ac-picker-effort').allTextContents(), ['Default', 'High', 'Max'], 'only the efforts of the chosen model');
    await page.locator('.ac-picker-effort', { hasText: 'Max' }).click();
    await page.waitForFunction(() => document.querySelector('.ac-picker-button').textContent === 'Opus Max');
    assert.equal(await page.locator('.ac-picker-effort[aria-checked="true"]').textContent(), 'Max');
    let row = await page.evaluate(async () => (await api.get(`${base}/conversations`))[0]);
    assert.deepEqual([row.model, row.effort], ['opus', 'max'], 'the choice is saved on the server');
    await page.locator('.ac-picker-item', { hasText: 'Sonnet 5.5' }).click();
    await page.waitForFunction(() => document.querySelector('.ac-picker-button').textContent === 'Sonnet');
    row = await page.evaluate(async () => (await api.get(`${base}/conversations`))[0]);
    assert.deepEqual([row.model, row.effort], ['sonnet', undefined], 'an effort the new model does not offer is cleared');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.ac-picker').count(), 0);
    await page.click('.ac-picker-button');
    await page.locator('.ac-messages').click({ position: { x: 5, y: 5 } });
    assert.equal(await page.locator('.ac-picker').count(), 0, 'a click elsewhere closes it');

    // Reopening the conversation shows what was said, and closing calls the host.
    const state = await page.evaluate(async () => (await api.get(`${base}/conversations`))[0]);
    assert.equal(state.session_id, 'session-abcdef12');
    await page.evaluate(() => view.destroy());
    await page.evaluate(async id => { const conversation = (await api.get(`${base}/conversations`)).find(row => row.id === id); window.view = AgentChat.mount(document.getElementById('host'), { api, base, conversation, onClose: () => { window.closes++; }, notify: () => {} }); }, state.id);
    await page.waitForSelector('.ac-text');
    assert.equal(await page.locator('.ac-user').count(), 9);
    await page.click('.ac-back');
    assert.equal(await page.evaluate(() => closes), 1);

    // The choices list the task's conversations first.
    const choices = await page.evaluate(() => AgentChat.choices(api, base, 'claude'));
    assert.equal(choices.length, 1);
    assert.equal(choices[0].conversation.title, 'clean the build');
    // Codex: a question with an "Other…" answer, "Allow for this session", and input sent while the turn runs.
    // Slash commands: "/" at the start of a message opens a menu of the commands; the arrows, Tab and Enter choose; /clear starts the chat again.
    await page.evaluate(() => { view.destroy(); return openChat('claude', null); });
    await page.waitForSelector('.ac-input');
    const menuNames = () => page.locator('.ac-command-name').allTextContents();
    await page.fill('.ac-input', '/');
    await page.waitForSelector('.ac-command');
    assert.deepEqual(await menuNames(), ['/clear', '/compact [instructions]', '/context'], 'every command, with its argument hint');
    assert.match(await page.locator('.ac-command-desc').first().textContent(), /new session/);
    await page.fill('.ac-input', '/co');
    assert.deepEqual(await menuNames(), ['/compact [instructions]', '/context'], 'what matches');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('.ac-command.active .ac-command-name').textContent(), '/context');
    await page.keyboard.press('Tab');
    assert.equal(await page.inputValue('.ac-input'), '/context ', 'Tab takes the highlighted command');
    assert.equal(await page.locator('.ac-commands').count(), 0, 'the menu closes once the name is there');
    await page.fill('.ac-input', '/c');
    await page.waitForSelector('.ac-command');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.ac-commands').count(), 0, 'Escape closes the menu');
    assert.equal(await page.inputValue('.ac-input'), '/c', 'and leaves the text');
    await page.fill('.ac-input', '/cl');
    const receivedBeforeMenu = received.length;
    await page.keyboard.press('Enter');
    assert.equal(await page.inputValue('.ac-input'), '/clear ', 'Enter takes the highlighted command first');
    assert.equal(received.length, receivedBeforeMenu, 'it does not send yet');
    await page.fill('.ac-input', '/');
    await page.locator('.ac-command', { hasText: '/compact' }).click();
    assert.equal(await page.inputValue('.ac-input'), '/compact ', 'a click takes it too');
    await page.fill('.ac-input', 'queued hi');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.ac-user');
    await page.waitForSelector('.ac-stop', { state: 'detached' });
    await page.fill('.ac-input', '/clear');
    assert.equal(await page.locator('.ac-command').count(), 1, 'the command typed in full is still listed');
    await page.keyboard.press('Enter'); // typed in full: Enter sends it
    await page.waitForFunction(() => !document.querySelector('.ac-user') && document.querySelector('.ac-notice') && document.querySelector('.ac-notice').textContent === 'Started a new session');
    assert.equal(await page.locator('.ac-user').count(), 0, 'what was said before is gone');
    await page.evaluate(() => { view.destroy(); return openChat('codex', null); });
    await page.waitForSelector('.ac-input');
    await page.fill('.ac-input', '/cl');
    await page.waitForSelector('.ac-commands-note');
    assert.match(await page.locator('.ac-commands-note').textContent(), /not available in Codex chats/, 'Codex has no slash commands: the person is told, not given a menu');
    assert.equal(await page.locator('.ac-command').count(), 0);
    await page.fill('.ac-input', '/usr/bin is missing');
    assert.equal(await page.locator('.ac-commands').count(), 0, 'a path is not a command');
    await page.fill('.ac-input', '');
    assert.equal(await page.locator('.ac-badge svg.agent-logo path').count(), 1, 'Codex shows the OpenAI logo');
    assert.deepEqual(await page.locator('.ac-mode option').allTextContents(), ['Read-only', 'Workspace write', 'Full access']);
    assert.deepEqual([await page.locator('.ac-model').textContent(), await page.locator('.ac-context').count(), await page.locator('.ac-limit').count()], ['Model', 0, 0], 'a choosable model shows its name only once it is known; no ring or limits until reported');
    await page.fill('.ac-input', 'start');
    await page.click('.ac-send');
    await page.waitForSelector('.ac-question');
    assert.equal(await page.locator('.ac-request-title').textContent(), 'Codex has a question');
    assert.deepEqual(await page.locator('.ac-option-label').allTextContents(), ['red', 'blue', 'Other…']);
    await page.locator('.ac-option', { hasText: 'Other' }).click();
    await page.fill('.ac-option input.ac-question-input', 'green');
    await page.click('.ac-request .ac-allow');
    await page.waitForFunction(() => document.querySelector('.ac-request-title') && document.querySelector('.ac-request-title').textContent === 'Run touch x');
    assert.deepEqual(codexSeen.answers.map(answer => [answer.allow, answer.answers]), [[true, { color: 'green' }]]);
    assert.deepEqual(await page.locator('.ac-request-actions button').allTextContents(), ['Allow', 'Allow for this session', 'Deny']);
    await page.click('.ac-remember');
    await page.waitForFunction(() => !document.querySelector('.ac-request'));
    assert.deepEqual(codexSeen.approvals.map(answer => [answer.allow, answer.remember]), [[true, true]]);
    assert.equal(await page.locator('.ac-stop').isVisible(), true);
    assert.match(await page.locator('.ac-input').getAttribute('placeholder'), /to send, .* to queue for later/, 'Enter steers a Codex turn, Cmd/Ctrl+Enter queues');
    await page.fill('.ac-input', 'one more thing');
    assert.equal(await page.locator('.ac-send').isVisible(), true, 'Send stays available while Codex works');
    await page.click('.ac-send');
    await page.waitForFunction(() => document.querySelectorAll('.ac-user').length === 2);
    assert.deepEqual(codexSeen.steers, ['one more thing']);
    await page.waitForFunction(() => !document.querySelector('.ac-stop'));
    assert.match(await page.locator('.ac-input').getAttribute('placeholder'), /to send, Shift\+Enter for a new line/);
    // The agent asks the person to choose and to review: options to pick (one or several, or an answer of one's own), a plan to approve or
    // send back, and the changes of an edit.
    await page.evaluate(() => { view.destroy(); return openChat('claude', null); });
    await page.fill('.ac-input', 'please review');
    await page.click('.ac-send');
    await page.waitForSelector('.ac-request.question');
    assert.deepEqual(await page.locator('.ac-question-chip').allTextContents(), ['Features', 'Library']);
    assert.equal(await page.locator('.ac-question-hint').textContent(), 'Select all that apply');
    assert.equal(await page.locator('.ac-request .ac-allow').isDisabled(), true, 'nothing is answered yet');
    assert.equal(await page.locator('.ac-option-preview').textContent(), 'dayjs()');
    await page.locator('.ac-option', { hasText: 'Caching' }).click();
    assert.equal(await page.locator('.ac-request .ac-allow').isDisabled(), true, 'one of two questions answered');
    await page.locator('.ac-option', { hasText: 'Telemetry' }).click();
    await page.locator('.ac-option', { hasText: 'dayjs' }).click();
    assert.equal(await page.locator('.ac-request .ac-allow').isDisabled(), false);
    await page.locator('.ac-option', { hasText: 'date-fns' }).click(); // a single choice replaces the one before
    assert.deepEqual(await page.locator('.ac-option.on .ac-option-label').allTextContents(), ['Caching', 'Telemetry', 'date-fns']);
    await page.locator('.ac-option', { hasText: 'Telemetry' }).click(); // and a pick can be taken back
    await page.locator('.ac-options').nth(1).locator('.ac-option', { hasText: 'Other' }).click();
    assert.equal(await page.locator('.ac-request .ac-allow').isDisabled(), true, 'writing an answer needs the text');
    await page.locator('.ac-options').nth(1).locator('input.ac-question-input').fill('luxon');
    await page.locator('.ac-options').nth(0).locator('.ac-option', { hasText: 'Other' }).click();
    await page.locator('.ac-options').nth(0).locator('input.ac-question-input').fill('Search');
    await page.click('.ac-request .ac-allow');
    await page.waitForSelector('.ac-request.plan');
    assert.deepEqual(reviewSeen[0], { allow: true, remember: false, message: undefined, answers: { 0: ['Caching', 'Search'], 1: 'luxon' } }, 'the picks, with the written answers, go back');

    assert.equal(await page.locator('.ac-plan h1').textContent(), 'The plan');
    assert.equal(await page.locator('.ac-plan strong').textContent(), 'step');
    assert.equal(await page.locator('.ac-plan td').first().textContent(), '1');
    assert.equal(await page.getByRole('button', { name: 'Approve plan' }).count(), 1);
    await page.fill('.ac-plan-feedback', 'Also cover the tests');
    await page.getByRole('button', { name: 'Keep planning' }).click();
    await page.waitForFunction(() => document.querySelector('.ac-plan h1') && document.querySelector('.ac-plan h1').textContent === 'The revised plan');
    assert.deepEqual([reviewSeen[1].allow, reviewSeen[1].message], [false, 'Also cover the tests'], 'the comments go back with the refusal');
    await page.getByRole('button', { name: 'Approve plan' }).click();
    await page.waitForSelector('.ac-diff');
    assert.deepEqual([reviewSeen[2].allow, reviewSeen[2].message], [true, undefined]);

    assert.equal(await page.locator('.ac-request-title').textContent(), 'Edit /work/a.js');
    assert.deepEqual(await page.locator('.ac-request .ac-diff-line').evaluateAll(lines => lines.map(line => [line.className.replace('ac-diff-line ', ''), line.textContent])),
      [['file', '/work/a.js'], ['del', '-const x = 1;'], ['add', '+const x = 2;'], ['ctx', ' log(x);']], 'the edit is shown as what goes and what comes');
    await page.click('.ac-request .ac-allow');
    await page.waitForSelector('.ac-stop', { state: 'detached' });
    assert.equal(reviewSeen[3].allow, true);
    assert.equal(await page.locator('.ac-toolgroup > summary').textContent(), 'Ran 2 commands· 1 failed');
    assert.equal(await page.locator('.ac-failed').textContent(), '· 1 failed');
    assert.equal(await page.locator('.ac-steps .ac-step-icon.error').count(), 1);
    // Dictation uses the page's speech model, not the browser's recognizer: a tap starts recording, the next tap stops it, and the recognized
    // text lands in the chat box after what was typed. The page is told nothing is typed yet, then something is.
    const mic = page.locator('.ac-mic');
    assert.ok(await page.evaluate(() => window.voice.attached) >= 1, 'the button is attached to the speech model');
    await page.fill('.ac-input', 'before');
    await mic.click();
    await page.waitForSelector('.ac-mic.listening');
    assert.equal(await page.evaluate(() => window.voice.started), 1, 'a tap starts the recording');
    await page.evaluate(() => window.VoiceInput.say('hello'));
    assert.equal(await page.inputValue('.ac-input'), 'before hello', 'live text follows what was typed, with a space between');
    await page.evaluate(() => window.VoiceInput.say('hello there'));
    assert.equal(await page.inputValue('.ac-input'), 'before hello there', 'the live text is replaced, not appended');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.ac-mic.listening').count(), 1, 'it keeps recording without holding');
    await mic.click();
    await page.waitForSelector('.ac-mic:not(.listening)');
    assert.deepEqual(await page.evaluate(() => [window.voice.started, window.voice.stopped, window.voice.browser || false]), [1, 1, false], 'the second tap stops it; the browser recognizer is never used');
    assert.equal(await page.inputValue('.ac-input'), 'before hello there', 'the text stays after stopping');
    await mic.click();
    await page.waitForSelector('.ac-mic.listening');
    await page.evaluate(() => window.VoiceInput.say('x'));
    await page.evaluate(() => { window.voice.textarea.value = ''; window.voice.textarea.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await page.inputValue('.ac-input'), 'before hello there', 'a cancelled recording puts the box back as it was');
    await mic.click();
    await page.waitForSelector('.ac-mic:not(.listening)');
    await page.fill('.ac-input', '');
    // The send button while recording: the recording ends first, and everything spoken up to then (the last words included) is sent.
    const stoppedBefore = await page.evaluate(() => window.voice.stopped);
    const receivedBefore = received.length;
    await mic.click();
    await page.waitForSelector('.ac-mic.listening');
    await page.evaluate(() => window.VoiceInput.say('queued by voice'));
    await page.click('.ac-send');
    await page.waitForSelector('.ac-mic:not(.listening)');
    await page.waitForFunction(() => document.querySelector('.ac-input').value === '');
    assert.equal(await page.evaluate(() => window.voice.stopped), stoppedBefore + 1, 'the send button ended the recording');
    assert.equal(received.length, receivedBefore + 1, 'and sent once');
    assert.equal(received.at(-1).text, 'queued by voice now', 'with the words that came in while it was ending');
    await page.waitForSelector('.ac-stop', { state: 'detached' });
    // The translation switch is shared by desktop and phone, before the microphone.
    // The switches live in the options menu under the input box: open it, act, close it again.
    const inMenu = async action => {
      if (!(await page.locator('.ac-options-list').count())) await page.click('.ac-options-button');
      const result = await action();
      if (await page.locator('.ac-options-list').count()) await page.click('.ac-options-button');
      return result;
    };
    const translation = page.getByRole('switch', { name: 'Translate to English' });
    const translationOn = () => inMenu(() => translation.getAttribute('aria-checked'));
    const flipTranslation = () => inMenu(() => translation.click());
    assert.equal(await translationOn(), 'false');
    assert.equal(await inMenu(() => page.getByRole('switch', { name: 'Collapse the keyboard after sending' }).getAttribute('aria-checked')), 'true', 'collapsing the keyboard after sending is on by default');
    const translatedCalls = [];
    const messageCalls = [];
    let failTranslation = false;
    await page.route('**/api/translate', async route => {
      translatedCalls.push(route.request().postDataJSON());
      await new Promise(resolve => setTimeout(resolve, 150));
      await route.fulfill({ status: failTranslation ? 502 : 200, contentType: 'application/json',
        body: JSON.stringify(failTranslation ? { error: 'Translation timed out; please retry' } : { text: 'Fix the issue\nKeep `a.js`.' }) });
    });
    await page.route('**/conversations/*/messages', async route => {
      messageCalls.push(route.request().postDataJSON());
      await route.fulfill({ contentType: 'application/json', body: '{}' });
    });
    const source = '\u4fee\u590d\u95ee\u9898';
    await page.fill('.ac-input', source);
    await page.locator('.ac-input').press('Enter');
    await page.waitForFunction(() => document.querySelector('.ac-input').value === '');
    assert.equal(messageCalls.at(-1).text, source);
    assert.equal(translatedCalls.length, 0);
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.ac-input')), false, 'the input box is left after sending, so the keyboard folds');
    // With the switch off the box keeps the focus.
    const collapseSwitch = page.getByRole('switch', { name: 'Collapse the keyboard after sending' });
    await inMenu(() => collapseSwitch.click());
    await page.fill('.ac-input', source);
    await page.locator('.ac-input').press('Enter');
    await page.waitForFunction(() => document.querySelector('.ac-input').value === '');
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.ac-input')), true, 'with the switch off the keyboard stays');
    await inMenu(() => collapseSwitch.click());
    await flipTranslation();
    assert.equal(await translationOn(), 'true');
    await page.fill('.ac-input', source);
    await page.locator('input[type=file]').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('original file') });
    await page.waitForSelector('.ac-attachments .ac-chip');
    await page.click('.ac-send');
    await page.waitForSelector('.ac-composer[aria-busy="true"]');
    assert.equal(await page.locator('.ac-input').getAttribute('readonly'), '');
    await page.waitForFunction(() => document.querySelector('.ac-input').value === '');
    assert.equal(messageCalls.at(-1).text, 'Fix the issue\nKeep `a.js`.');
    assert.equal(messageCalls.at(-1).files[0].text, 'original file');
    assert.deepEqual(translatedCalls, [{ text: source }]);
    failTranslation = true;
    const sentCount = messageCalls.length;
    await page.fill('.ac-input', source);
    await page.click('.ac-send');
    await page.waitForFunction(() => window.notices.includes('Translation timed out; please retry'));
    assert.equal(await page.inputValue('.ac-input'), source, 'failed translation keeps the draft');
    assert.equal(messageCalls.length, sentCount, 'failed translation sends nothing');
    await flipTranslation();
    await page.locator('.ac-input').press('Enter');
    await page.waitForFunction(() => document.querySelector('.ac-input').value === '');
    assert.equal(messageCalls.at(-1).text, source, 'turning translation off restores direct sending');
    await flipTranslation();
    // Each chat keeps its own translation switch: it is saved on the server, a new chat starts with it off, and the chat that had it on has it on again.
    assert.equal(await translationOn(), 'true');
    const rowsWithSwitch = async () => (await page.evaluate(() => api.get(`${base}/conversations`))).filter(row => row.translate);
    await page.waitForFunction(() => api.get(`${base}/conversations`).then(rows => rows.some(row => row.translate)));
    const [onRow] = await rowsWithSwitch();
    assert.equal((await rowsWithSwitch()).length, 1, 'only this chat has the switch on');
    await page.evaluate(() => { view.destroy(); return openChat('claude', null); });
    await page.waitForSelector('.ac-options-button');
    assert.equal(await translationOn(), 'false', 'a new chat starts with the switch off');
    await page.evaluate(row => { view.destroy(); return openChat('claude', { conversation: row }); }, onRow);
    await page.waitForSelector('.ac-options-button');
    assert.equal(await translationOn(), 'true', 'the chat that had the switch on has it on again');
    await flipTranslation();
    await page.waitForFunction(() => api.get(`${base}/conversations`).then(rows => rows.every(row => !row.translate)));
    assert.equal((await rowsWithSwitch()).length, 0, 'turning it off is saved too');
    for (const width of [390, 1024]) {
      await page.setViewportSize({ width, height: 780 });
      assert.equal(await page.locator('.ac-options-button').isVisible(), true);
      assert.equal(await page.locator('.ac-box').evaluate(node => node.scrollWidth <= node.clientWidth), true, 'the input row fits');
      await page.screenshot({ path: `/tmp/t-agent-translate-${width}.png` });
    }
    console.log('Agent chat view: streaming, permissions, stop, access level, attachments, reopen, Codex questions and steering, tool steps, choices and reviews passed.');
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
    db.close();
    fs.rmSync(data, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
