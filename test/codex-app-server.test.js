const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const codex = require('../lib/agent-chat/codex');
const { AppServerClient } = require('../lib/agent-chat/codex-app-server');

const FAKE = path.join(__dirname, '..', 'test-support', 'fake-codex-app-server.js');
fs.chmodSync(FAKE, 0o755);

// Collects what a turn does to the conversation, like the service's turn context.
function collector() {
  const items = new Map();
  const ctx = {
    items, control: null, sessions: [],
    upsert: item => items.set(item.id, item),
    append: (id, text) => { const item = items.get(id); if (item) item.text = (item.text || '') + text; },
    getItem: id => items.get(id),
    setSession(id) { ctx.sessions.push(id); },
    setControl(control) { ctx.control = control; },
  };
  return ctx;
}

function run(text, { mode = 'write', sessionId, requestPermission = async () => ({ allow: true }), signal = new AbortController().signal, ctx = collector(), images } = {}) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-fake-codex-')), 'log.jsonl');
  process.env.FAKE_CODEX_LOG = log;
  const promise = codex.runTurn({ cwd: os.tmpdir(), sessionId, mode, prompt: { text, images }, signal, ctx, requestPermission, deps: { executable: FAKE } });
  const requests = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []);
  return { promise, ctx, requests };
}

const wait = async condition => { for (let i = 0; i < 400 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(condition(), 'timed out'); };

test('notifications become items: streamed text, shell commands, file changes, plans', () => {
  const ctx = collector();
  const normalizer = codex.createNormalizer(ctx);
  const turn = 't1';
  normalizer.handle('item/started', { turnId: turn, item: { type: 'agentMessage', id: 'a', text: '' } });
  normalizer.handle('item/agentMessage/delta', { turnId: turn, itemId: 'a', delta: 'Hel' });
  normalizer.handle('item/agentMessage/delta', { turnId: turn, itemId: 'a', delta: 'lo' });
  assert.equal(ctx.items.get('t1:a').text, 'Hello');
  normalizer.handle('item/completed', { turnId: turn, item: { type: 'agentMessage', id: 'a', text: 'Hello!' } });
  assert.equal(ctx.items.get('t1:a').text, 'Hello!', 'the completed item replaces the streamed text');

  normalizer.handle('item/started', { turnId: turn, item: { type: 'commandExecution', id: 'c', command: 'echo ok', cwd: '/w', status: 'inProgress', aggregatedOutput: null, exitCode: null } });
  normalizer.handle('item/commandExecution/outputDelta', { turnId: turn, itemId: 'c', delta: 'ok\n' });
  assert.deepEqual([ctx.items.get('t1:c').status, ctx.items.get('t1:c').output], ['running', 'ok\n']);
  normalizer.handle('item/completed', { turnId: turn, item: { type: 'commandExecution', id: 'c', command: 'echo ok', cwd: '/w', status: 'completed', aggregatedOutput: 'ok\n', exitCode: 0 } });
  normalizer.handle('item/completed', { turnId: turn, item: { type: 'commandExecution', id: 'f', command: 'false', cwd: '/w', status: 'completed', aggregatedOutput: '', exitCode: 1 } });
  normalizer.handle('item/completed', { turnId: turn, item: { type: 'commandExecution', id: 'd', command: 'rm x', cwd: '/w', status: 'declined', aggregatedOutput: null, exitCode: null } });
  assert.deepEqual(['c', 'f', 'd'].map(id => ctx.items.get(`t1:${id}`).status), ['done', 'error', 'error']);
  assert.equal(ctx.items.get('t1:d').output, 'Declined');

  normalizer.handle('item/completed', { turnId: turn, item: { type: 'fileChange', id: 'p', status: 'completed', changes: [{ path: 'a.txt', kind: { type: 'add' }, diff: '+x' }] } });
  assert.equal(ctx.items.get('t1:p').output, 'add a.txt');
  normalizer.handle('turn/plan/updated', { turnId: turn, explanation: null, plan: [{ step: 'one', status: 'completed' }, { step: 'two', status: 'pending' }] });
  assert.equal(ctx.items.get('t1:plan').output, '[x] one\n[ ] two');

  // Reasoning shows the summary when Codex streams one, and not the raw reasoning on top of it.
  normalizer.handle('item/started', { turnId: turn, item: { type: 'reasoning', id: 'r', summary: [], content: [] } });
  normalizer.handle('item/reasoning/summaryTextDelta', { turnId: turn, itemId: 'r', delta: 'plan' });
  normalizer.handle('item/reasoning/textDelta', { turnId: turn, itemId: 'r', delta: 'raw' });
  assert.equal(ctx.items.get('t1:r').text, 'plan');

  assert.equal(normalizer.handle('turn/completed', { turn: { status: 'failed', error: { message: 'boom' } } }).error, 'boom');
  assert.deepEqual(normalizer.handle('turn/completed', { turn: { status: 'interrupted' } }), { ok: false, error: '', usage: null });
  assert.equal(normalizer.handle('turn/completed', { turn: { status: 'completed' } }).ok, true);
});

test('a turn starts a thread with the access level, streams the reply and reports usage', async () => {
  const { promise, ctx, requests } = run('say hi', { mode: 'readonly' });
  const outcome = await promise;
  assert.deepEqual(outcome, { ok: true, error: '', usage: { input: 3, output: 4 } });
  assert.deepEqual(ctx.sessions, ['thread-fake0001']);
  assert.equal(ctx.items.get('turn-1:m1').text, 'hello');
  const start = requests().find(row => row.method === 'thread/start');
  assert.deepEqual([start.params.sandbox, start.params.approvalPolicy, start.params.approvalsReviewer, start.params.cwd], ['read-only', 'on-request', 'user', os.tmpdir()]);
  assert.equal(ctx.control, null, 'the steering hook is removed when the turn ends');
});

test('an existing session is resumed, and full access never asks', async () => {
  const { promise, requests } = run('again', { mode: 'full', sessionId: 'thread-old00001' });
  assert.equal((await promise).ok, true);
  const resume = requests().find(row => row.method === 'thread/resume');
  assert.deepEqual([resume.params.threadId, resume.params.sandbox, resume.params.approvalPolicy], ['thread-old00001', 'danger-full-access', 'never']);
  assert.equal(requests().some(row => row.method === 'thread/start'), false);
});

test('images are sent as local files that are removed after the turn', async () => {
  const { promise, requests } = run('look', { images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }] });
  await promise;
  const input = requests().find(row => row.method === 'turn/start').params.input;
  assert.deepEqual(input.map(part => part.type), ['text', 'localImage']);
  assert.equal(fs.existsSync(input[1].path), false);
});

test('a command approval waits for the person; allow, allow for the session and deny map to decisions', async () => {
  const seen = [];
  const answers = [{ allow: true }, { allow: true, remember: true }, { allow: false }];
  const decisions = [];
  for (const answer of answers) {
    const { promise, requests } = run('approve it', { requestPermission: async request => { seen.push(request); return answer; } });
    const outcome = await promise;
    assert.equal(outcome.ok, true);
    decisions.push(requests().find(row => row.answer === 'commandExecution').result.decision);
  }
  assert.deepEqual(decisions, ['accept', 'acceptForSession', 'decline']);
  assert.equal(seen[0].tool, 'Shell');
  assert.equal(seen[0].canRemember, true);
  assert.equal(seen[0].input.command, 'touch x');
  assert.match(seen[0].description, /Needs to write x/);
});

test('questions from Codex are put to the person and the answers go back', async () => {
  const asked = [];
  const { promise, requests, ctx } = run('question please', { requestPermission: async request => { asked.push(request); return { allow: true, answers: { color: 'blue' } }; } });
  assert.equal((await promise).ok, true);
  assert.equal(asked[0].kind, 'question');
  assert.deepEqual(asked[0].questions.map(question => [question.id, question.question, question.isOther]), [['color', 'Which color?', true]]);
  assert.deepEqual(requests().find(row => row.answer === 'userInput').result, { answers: { color: { answers: ['blue'] } } });
  assert.match(ctx.items.get('turn-1:m1').text, /blue/);
});

test('skipping a question answers with nothing', async () => {
  const { promise, requests } = run('question please', { requestPermission: async () => ({ allow: false }) });
  await promise;
  assert.deepEqual(requests().find(row => row.answer === 'userInput').result, { answers: {} });
});

test('input added while the turn runs steers it; stopping interrupts it', async () => {
  const { promise, ctx, requests } = run('hang on');
  await wait(() => ctx.control && ctx.items.has('turn-1:r1'));
  await ctx.control.steer({ text: 'also this', images: [] });
  const outcome = await promise;
  assert.equal(outcome.ok, true);
  const steer = requests().find(row => row.method === 'turn/steer');
  assert.deepEqual([steer.params.threadId, steer.params.expectedTurnId, steer.params.input[0].text], ['thread-fake0001', 'turn-1', 'also this']);
  assert.equal(ctx.items.get('turn-1:m1').text, 'steered: also this');

  const controller = new AbortController();
  const stopped = run('hang on', { signal: controller.signal });
  await wait(() => stopped.ctx.control);
  controller.abort();
  assert.deepEqual(await stopped.promise, { ok: false, error: '', usage: { input: 3, output: 4 } });
  assert.deepEqual(stopped.requests().find(row => row.method === 'turn/interrupt').params, { threadId: 'thread-fake0001', turnId: 'turn-1' });
});

test('a stop before the turn exists still ends the turn', async () => {
  const controller = new AbortController();
  controller.abort();
  const { promise } = run('hang on', { signal: controller.signal });
  assert.deepEqual(await promise, { ok: false, error: '' });
});

test('a missing CLI or a crashing app server is reported, not thrown', async () => {
  const missing = await codex.runTurn({ cwd: os.tmpdir(), mode: 'write', prompt: { text: 'x' }, signal: new AbortController().signal, ctx: collector(), requestPermission: async () => ({ allow: true }), deps: { executable: null } });
  assert.match(missing.error, /Codex CLI was not found/);
  const turn = executable => codex.runTurn({ cwd: os.tmpdir(), mode: 'write', prompt: { text: 'x' }, signal: new AbortController().signal, ctx: collector(), requestPermission: async () => ({ allow: true }), deps: { executable } });
  const crashed = await turn('/usr/bin/false');
  assert.equal(crashed.ok, false);
  assert.match(crashed.error, /Codex app server stopped/);
  const unspawnable = await turn(path.join(os.tmpdir(), 'no-such-codex'));
  assert.equal(unspawnable.ok, false);
  assert.match(unspawnable.error, /ENOENT/);
});

test('other requests from Codex: extra permissions, MCP forms, dynamic tools and unknown methods', async () => {
  const ctx = collector();
  const ask = (method, params, answer) => codex.answerRequest(method, params, { ctx, requestPermission: async () => answer });
  const permissions = { network: { enabled: true }, fileSystem: null };
  assert.deepEqual(await ask('item/permissions/requestApproval', { permissions }, { allow: true, remember: true }), { permissions: { network: { enabled: true } }, scope: 'session' });
  assert.deepEqual(await ask('item/permissions/requestApproval', { permissions }, { allow: false }), { permissions: {}, scope: 'turn' });

  const form = { mode: 'form', serverName: 'srv', message: 'Need details', requestedSchema: { properties: { count: { type: 'integer', title: 'Count' }, ok: { type: 'boolean' }, name: { type: 'string' } } } };
  assert.deepEqual(await ask('mcpServer/elicitation/request', form, { allow: true, answers: { count: '3', ok: 'true', name: 'x' } }), { action: 'accept', content: { count: 3, ok: true, name: 'x' }, _meta: null });
  assert.deepEqual(await ask('mcpServer/elicitation/request', form, { allow: false }), { action: 'decline', content: null, _meta: null });
  assert.equal((await ask('item/tool/call', { tool: 'x' }, {})).success, false);
  await assert.rejects(ask('applyPatchApproval', {}, {}), /Unsupported request/);
});

test('the client answers requests, ignores partial lines and fails pending requests when the process exits', async () => {
  const client = new AppServerClient({ command: FAKE });
  client.onRequest = async () => ({});
  await client.start();
  const result = await client.request('thread/start', { cwd: '/w' });
  assert.equal(result.thread.id, 'thread-fake0001');
  await assert.rejects(client.request('nope', {}), /unknown nope/);
  const pending = client.request('turn/steer', { threadId: 'x', expectedTurnId: 'y', input: [] });
  client.child.kill();
  await assert.rejects(pending.then(() => client.request('again', {})), /stopped|closed|not running/);
  client.close();
});
