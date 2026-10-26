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
const adapter = {
  MODES: { ask: {}, edits: {}, plan: {}, full: {} }, DEFAULT_MODE: 'ask',
  loadHistory: async () => [],
  async runTurn({ prompt, ctx, requestPermission, signal }) {
    received.push(prompt);
    ctx.setSession('session-abcdef12');
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
  MODES: { readonly: {}, write: {}, full: {} }, DEFAULT_MODE: 'write', CAPABILITIES: { steer: true },
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
<link rel="stylesheet" href="/css/agent-chat.css"><style>html,body,#host{height:100%;margin:0}</style><div id="host"></div>
<script src="/js/agent-chat.js"></script>
<script>
const call = (method, url, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; });
window.api = { get: u => call('GET', u), post: (u, b) => call('POST', u, b), patch: (u, b) => call('PATCH', u, b), del: u => call('DELETE', u) };
window.base = '/api/tasks/${task.id}/agent';
window.notices = [];
window.closes = 0;
window.openChat = async (agent, choice) => { const conversation = await AgentChat.open(window.api, base, agent, choice); window.view = AgentChat.mount(document.getElementById('host'), { api: window.api, base, conversation, onClose: () => { window.closes++; }, notify: m => window.notices.push(m) }); return conversation; };
</script>`));
const server = http.createServer(app);

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
    page.on('pageerror', error => { throw error; });
    await page.goto(`${origin}/harness`);
    await page.evaluate(() => openChat('claude', null));
    await page.waitForSelector('.agent-chat');
    assert.equal(await page.locator('.ac-badge').textContent(), '✳');
    assert.deepEqual(await page.locator('.ac-mode option').allTextContents(), ['Ask before changes', 'Accept edits', 'Plan only', 'Full access (no prompts)']);

    // A turn: the answer streams in, the tool waits for approval, and the page never runs markup the agent wrote.
    await page.fill('.ac-input', 'clean the build');
    await page.click('.ac-send');
    await page.waitForSelector('.ac-request');
    assert.equal(await page.locator('.ac-user .ac-bubble').textContent(), 'clean the build');
    assert.equal(await page.locator('.ac-request-title').textContent(), 'Run rm -rf build');
    assert.equal(await page.locator('.ac-stop').isVisible(), true, 'Stop replaces Send while the turn runs');
    assert.equal(await page.locator('.ac-send').isVisible(), false);
    assert.equal(await page.locator('.ac-text strong').textContent(), 'bold');
    assert.deepEqual(await page.locator('.ac-text li').allTextContents(), ['one', 'two']);
    assert.equal(await page.locator('.ac-text pre code').textContent(), 'console.log(1)');
    assert.equal(await page.locator('.ac-text img').count(), 0, 'agent text is never parsed as HTML');
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    assert.equal(await page.locator('.ac-tool.running').count(), 1);
    await page.click('.ac-allow');
    await page.waitForSelector('.ac-tool.done');
    await page.waitForFunction(() => document.querySelector('.ac-send') && !document.querySelector('.ac-send').hidden);
    assert.equal(await page.locator('.ac-request').count(), 0);
    await page.locator('.ac-tool summary').click();
    assert.equal(await page.locator('.ac-tool-output').textContent(), 'removed');
    assert.equal(await page.locator('.ac-text').last().textContent(), 'Done.');
    assert.equal(await page.locator('.ac-title').textContent(), 'clean the build', 'the first prompt names the chat');

    // Stop interrupts a long turn; the access level and attachments reach the server.
    await page.fill('.ac-input', 'slow task');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.ac-stop:visible');
    await page.click('.ac-stop');
    await page.waitForSelector('.ac-notice');
    assert.equal(await page.locator('.ac-notice').textContent(), 'Stopped');
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
    await page.fill('.ac-input', 'use these');
    await page.click('.ac-send');
    await page.waitForFunction(() => document.querySelectorAll('.ac-user').length === 3);
    assert.equal(received.at(-1).images.length, 1);
    assert.match(received.at(-1).text, /Attached file notes\.txt:[\s\S]*remember this/);
    assert.equal(await page.locator('.ac-attachments .ac-chip').count(), 0, 'attachments are cleared after sending');

    // Reopening the conversation shows what was said, and closing calls the host.
    const state = await page.evaluate(async () => (await api.get(`${base}/conversations`))[0]);
    assert.equal(state.session_id, 'session-abcdef12');
    await page.evaluate(() => view.destroy());
    await page.evaluate(async id => { const conversation = (await api.get(`${base}/conversations`)).find(row => row.id === id); window.view = AgentChat.mount(document.getElementById('host'), { api, base, conversation, onClose: () => { window.closes++; }, notify: () => {} }); }, state.id);
    await page.waitForSelector('.ac-text');
    assert.equal(await page.locator('.ac-user').count(), 3);
    await page.click('.ac-back');
    assert.equal(await page.evaluate(() => closes), 1);

    // The choices list the task's conversations first.
    const choices = await page.evaluate(() => AgentChat.choices(api, base, 'claude'));
    assert.equal(choices.length, 1);
    assert.equal(choices[0].conversation.title, 'clean the build');
    // Codex: a question with an "Other…" answer, "Allow for this session", and input sent while the turn runs.
    await page.evaluate(() => { view.destroy(); return openChat('codex', null); });
    assert.equal(await page.locator('.ac-badge').textContent(), '◎');
    assert.deepEqual(await page.locator('.ac-mode option').allTextContents(), ['Read-only', 'Workspace write', 'Full access']);
    await page.fill('.ac-input', 'start');
    await page.click('.ac-send');
    await page.waitForSelector('.ac-question');
    assert.equal(await page.locator('.ac-request-title').textContent(), 'Codex has a question');
    assert.deepEqual(await page.locator('.ac-question select option').allTextContents(), ['red', 'blue', 'Other…']);
    await page.selectOption('.ac-question select', '');
    await page.fill('.ac-question input', 'green');
    await page.click('.ac-request .ac-allow');
    await page.waitForFunction(() => document.querySelector('.ac-request-title') && document.querySelector('.ac-request-title').textContent === 'Run touch x');
    assert.deepEqual(codexSeen.answers.map(answer => [answer.allow, answer.answers]), [[true, { color: 'green' }]]);
    assert.deepEqual(await page.locator('.ac-request-actions button').allTextContents(), ['Allow', 'Allow for this session', 'Deny']);
    await page.click('.ac-remember');
    await page.waitForFunction(() => !document.querySelector('.ac-request'));
    assert.deepEqual(codexSeen.approvals.map(answer => [answer.allow, answer.remember]), [[true, true]]);
    assert.equal(await page.locator('.ac-send').isVisible(), true, 'Send stays available while Codex works');
    assert.equal(await page.locator('.ac-stop').isVisible(), true);
    assert.equal(await page.locator('.ac-input').getAttribute('placeholder'), 'Add to what Codex is doing');
    await page.fill('.ac-input', 'one more thing');
    await page.click('.ac-send');
    await page.waitForFunction(() => document.querySelectorAll('.ac-user').length === 2);
    assert.deepEqual(codexSeen.steers, ['one more thing']);
    await page.waitForFunction(() => document.querySelector('.ac-stop').hidden);
    assert.equal(await page.locator('.ac-input').getAttribute('placeholder'), 'Message Codex');
    console.log('Agent chat view: streaming, permissions, stop, access level, attachments, reopen, and Codex questions and steering passed.');
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
    db.close();
    fs.rmSync(data, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
