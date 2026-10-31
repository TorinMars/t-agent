// Fork a conversation from one of its messages, and the time every item carries (shown under the message): locating the message in the agent's own record,
// the Claude and Codex forks, the service, the route.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-chat-fork-'));
process.env.T_AGENT_DATA_DIR = root;
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
const db = require('../db');
const tasks = require('../services/engine-tasks');
const { createAgentChat } = require('../services/agent-chat');
const { createAgentChatRouter } = require('../routes/agent-chat');
const { locateFork, same } = require('../lib/agent-chat/fork-point');
const claude = require('../lib/agent-chat/claude');
const codex = require('../lib/agent-chat/codex');

const task = tasks.createTask('owner', { title: 'fork' });
test.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
const wait = async condition => { for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(condition(), 'timed out'); };

const user = (id, text, extra = {}) => ({ id, kind: 'user', text, ...extra });
const text = (id, body) => ({ id, kind: 'text', text: body });
const ITEMS = [user('u1', 'first'), text('a1', 'answer 1'), { id: 't1', kind: 'tool', name: 'Bash' }, user('u2', 'second'), text('a2', 'answer 2'), user('u3', 'third'), text('a3', 'answer 3')];

test('locating an item: the turn it belongs to, and whether it is the message of the person itself', () => {
  assert.deepEqual([locateFork(ITEMS, 'a1').turn, locateFork(ITEMS, 'a1').own], [1, false], 'an answer belongs to the message before it');
  assert.equal(locateFork(ITEMS, 't1').turn, 1, 'so does a tool call');
  assert.deepEqual([locateFork(ITEMS, 'u2').turn, locateFork(ITEMS, 'u2').own], [2, true]);
  assert.equal(locateFork(ITEMS, 'a3').turn, 3);
  assert.deepEqual(locateFork(ITEMS, 'a3').users.map(item => item.id), ['u1', 'u2', 'u3'], 'with the messages of the person up to it, for checking the count');
  assert.equal(locateFork(ITEMS, 'nope'), null, 'an item that is not there');
  assert.equal(locateFork([text('x', 'a notice before any message'), user('u', 'hi')], 'x'), null, 'an item before any message of the person has nothing to belong to');
});

test('a message sent while the agent works starts a turn for Claude and joins its turn for Codex', () => {
  const items = [user('u1', 'first'), text('a1', 'working'), user('u2', 'sent meanwhile', { steered: true }), text('a2', 'done'), user('u3', 'next')];
  assert.equal(locateFork(items, 'a2', { countSteered: true }).turn, 2, 'Claude: its own message in the session');
  assert.equal(locateFork(items, 'a2', { countSteered: false }).turn, 1, 'Codex: part of turn 1');
  assert.equal(locateFork(items, 'u3', { countSteered: false }).turn, 2);
});

test('the text check lets white space and added attachment names pass, and refuses another message', () => {
  assert.equal(same('fix  the\n bug', 'fix the bug'), true);
  assert.equal(same('fix the bug', 'fix the bug\n[a.png]'), true, 'one contains the other');
  assert.equal(same('', ''), true, 'two messages with no text (only images)');
  assert.equal(same('', 'something'), false);
  assert.equal(same('fix the bug', 'write the docs'), false);
});

// ── Claude ──
const claudeRows = [
  { type: 'system', uuid: 's0', message: {}, timestamp: '2026-10-30T08:00:00.000Z' },
  { type: 'user', uuid: 'r1', message: { content: 'first' }, timestamp: '2026-10-30T08:01:00.000Z' },
  { type: 'assistant', uuid: 'r2', message: { id: 'm1', content: [{ type: 'text', text: 'answer 1' }] }, timestamp: '2026-10-30T08:01:05.000Z' },
  { type: 'user', uuid: 'r3', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] }, timestamp: '2026-10-30T08:01:06.000Z' },
  { type: 'user', uuid: 'r4', message: { content: 'second' }, timestamp: '2026-10-30T08:02:00.000Z' },
  { type: 'assistant', uuid: 'r5', message: { id: 'm2', content: [{ type: 'text', text: 'answer 2' }] }, timestamp: '2026-10-30T08:02:05.000Z' },
];
function claudeSdk(rows = claudeRows) {
  const forks = [];
  return { forks, sdk: { getSessionMessages: async () => rows, forkSession: async (sessionId, options) => { forks.push({ sessionId, ...options }); return { sessionId: `forked-${forks.length}` }; } } };
}
const claudeItems = [user('user:r1', 'first'), text('m1:0', 'answer 1'), user('user:r4', 'second'), text('m2:0', 'answer 2')];

test('Claude history: every item carries the time of the session row it came from', async () => {
  const { sdk } = claudeSdk();
  const items = await claude.loadHistory({ cwd: '/w', sessionId: 's', deps: { loadSdk: async () => sdk } });
  assert.deepEqual(items.map(item => [item.kind, item.at]), [
    ['user', Date.parse('2026-10-30T08:01:00.000Z')], ['text', Date.parse('2026-10-30T08:01:05.000Z')], ['user', Date.parse('2026-10-30T08:02:00.000Z')], ['text', Date.parse('2026-10-30T08:02:05.000Z')],
  ]);
});

test('Claude fork: from an answer it keeps its turn; from a message of the person it keeps what is before it and hands back the text as a draft', async () => {
  const one = claudeSdk();
  const deps = sdk => ({ loadSdk: async () => sdk.sdk });
  const answer = await claude.fork({ cwd: '/w', sessionId: 's', items: claudeItems, itemId: 'm1:0', title: 'T (fork)', deps: deps(one) });
  assert.deepEqual(one.forks, [{ sessionId: 's', dir: '/w', upToMessageId: 'r3', title: 'T (fork)' }], 'up to the last row before the next message of the person (the tool result)');
  assert.deepEqual(answer, { sessionId: 'forked-1', draft: '' });
  const two = claudeSdk();
  const message = await claude.fork({ cwd: '/w', sessionId: 's', items: claudeItems, itemId: 'user:r4', deps: deps(two) });
  assert.equal(two.forks[0].upToMessageId, 'r3', 'everything before the message');
  assert.equal('title' in two.forks[0], false, 'the SDK names it when no title is given');
  assert.deepEqual(message, { sessionId: 'forked-1', draft: 'second' });
  const three = claudeSdk();
  await claude.fork({ cwd: '/w', sessionId: 's', items: claudeItems, itemId: 'm2:0', deps: deps(three) });
  assert.equal(three.forks[0].upToMessageId, 'r5', 'the last answer: up to the end of the session');
});

test('Claude fork: refused at the first message, when the messages do not match the session, and for an item that is not there', async () => {
  const { sdk, forks } = claudeSdk();
  const deps = { loadSdk: async () => sdk };
  await assert.rejects(claude.fork({ cwd: '/w', sessionId: 's', items: claudeItems, itemId: 'user:r1', deps }), /FORK_AT_FIRST_MESSAGE/, 'the set-up rows before the first message are not a conversation');
  await assert.rejects(claude.fork({ cwd: '/w', sessionId: 's', items: [user('user:r1', 'first'), text('m1:0', 'a'), user('user:r4', 'something else'), text('m2:0', 'b')], itemId: 'm2:0', deps }), /FORK_MISMATCH/);
  await assert.rejects(claude.fork({ cwd: '/w', sessionId: 's', items: claudeItems, itemId: 'nope', deps }), /FORK_NOT_POSSIBLE/);
  await assert.rejects(claude.fork({ cwd: '/w', sessionId: 's', items: [user('u', 'one'), user('v', 'two'), text('w', 'x')], itemId: 'w', deps }), /FORK_MISMATCH/, 'more messages than the session has');
  assert.deepEqual(forks, [], 'nothing was forked');
  assert.equal((await claude.fork({ cwd: '/w', sessionId: 's', items: claudeItems, itemId: 'm1:0', deps }).catch(error => error)).sessionId, 'forked-1');
});

// ── Codex ──
const turn = (id, ...written) => ({ id, items: [{ type: 'userMessage', content: written.map(body => ({ type: 'text', text: body })) }, { type: 'agentMessage', text: 'reply' }] });
function codexClient(turns, calls = []) {
  return { calls, deps: { executable: 'codex', createClient: () => ({ start: async () => {}, close() {}, request: async (method, params) => {
    calls.push([method, params]);
    if (method === 'thread/turns/list') { const from = Number(params.cursor || 0); const page = turns.slice(from, from + params.limit); return { data: page, nextCursor: from + page.length < turns.length ? String(from + page.length) : null }; }
    if (method === 'thread/fork') return { thread: { id: 'thread-fork-1' } };
    throw new Error(`unexpected ${method}`);
  } }) } };
}
const codexItems = [user('h0', 'first'), text('h1', 'answer 1'), user('h2', 'second'), user('h3', 'added while working', { steered: true }), text('h4', 'answer 2'), user('h5', 'third')];
const codexTurns = [turn('t1', 'first'), turn('t2', 'second'), turn('t3', 'third')];

test('Codex history: items carry the time of their line in the rollout file', () => {
  const file = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(file, [
    { timestamp: '2026-10-30T08:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'hello' }] } },
    { timestamp: '2026-10-30T08:00:09.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'hi' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'no time on this line' }] } },
  ].map(row => JSON.stringify(row)).join('\n'));
  assert.deepEqual(codex.historyFromRollout(file).map(item => item.at), [Date.parse('2026-10-30T08:00:00.000Z'), Date.parse('2026-10-30T08:00:09.000Z'), undefined]);
});

test('Codex fork: the thread is forked through the last turn that is kept; a message sent into a turn does not count as a turn', async () => {
  const answer = codexClient(codexTurns);
  assert.deepEqual(await codex.fork({ sessionId: 'thread-1', items: codexItems, itemId: 'h4', deps: answer.deps }), { sessionId: 'thread-fork-1', draft: '' });
  assert.deepEqual(answer.calls.at(-1), ['thread/fork', { threadId: 'thread-1', lastTurnId: 't2', excludeTurns: true }], 'the answer of turn 2 (its steered message is part of it): through t2');
  const message = codexClient(codexTurns);
  assert.deepEqual(await codex.fork({ sessionId: 'thread-1', items: codexItems, itemId: 'h5', deps: message.deps }), { sessionId: 'thread-fork-1', draft: 'third' });
  assert.equal(message.calls.at(-1)[1].lastTurnId, 't2', 'a message of the person: through the turn before it');
});

test('Codex fork: pages of turns are read to the end, and a fork that cannot be placed is refused before anything is forked', async () => {
  const many = Array.from({ length: 230 }, (_, index) => turn(`t${index + 1}`, `message ${index + 1}`));
  const items = [...many.flatMap((entry, index) => [user(`u${index}`, `message ${index + 1}`), text(`a${index}`, 'reply')])];
  const client = codexClient(many);
  assert.equal((await codex.fork({ sessionId: 'thread-1', items, itemId: 'a229', deps: client.deps })).sessionId, 'thread-fork-1');
  assert.equal(client.calls.filter(call => call[0] === 'thread/turns/list').length, 3, '230 turns in pages of 100');
  assert.equal(client.calls.at(-1)[1].lastTurnId, 't230');
  const bad = codexClient(codexTurns);
  await assert.rejects(codex.fork({ sessionId: 'thread-1', items: codexItems, itemId: 'h0', deps: bad.deps }), /FORK_AT_FIRST_MESSAGE/);
  await assert.rejects(codex.fork({ sessionId: 'thread-1', items: [user('h0', 'first'), text('h1', 'x'), user('h2', 'other words'), text('h3', 'y')], itemId: 'h3', deps: bad.deps }), /FORK_MISMATCH/);
  await assert.rejects(codex.fork({ sessionId: 'thread-1', items: codexItems, itemId: 'nope', deps: bad.deps }), /FORK_NOT_POSSIBLE/);
  assert.equal(bad.calls.some(call => call[0] === 'thread/fork'), false);
});

test('both agents offer to fork', () => {
  assert.equal(claude.CAPABILITIES.fork, true);
  assert.equal(codex.CAPABILITIES.fork, true);
});

// ── The service ──
function forkingAdapter(script = async () => ({ ok: true })) {
  const adapter = {
    MODES: { ask: {}, full: {} }, DEFAULT_MODE: 'ask', CAPABILITIES: { fork: true }, forks: [], calls: [],
    loadHistory: async () => [{ id: 'h1', kind: 'user', text: 'earlier', at: 1000 }, { id: 'h2', kind: 'text', text: 'answer', at: 2000 }],
    runTurn: async args => { adapter.calls.push(args); return script(args); },
    fork: async args => { adapter.forks.push(args); return { sessionId: `forked-session-${adapter.forks.length}`, draft: args.itemId === 'h1' ? 'earlier' : '' }; }, // a new session each time
  };
  return adapter;
}

test('items carry the time they first appeared; an update keeps it; history keeps the time the agent recorded; a steered message is marked', async () => {
  let release;
  const adapter = forkingAdapter(async ({ ctx }) => {
    ctx.upsert({ id: 'x1', kind: 'text', text: 'Hel' });
    await new Promise(resolve => setTimeout(resolve, 15));
    ctx.upsert({ id: 'x1', kind: 'text', text: 'Hello' });
    await new Promise(resolve => { release = resolve; });
    return { ok: true };
  });
  adapter.CAPABILITIES = { fork: true, steer: true };
  const chat = createAgentChat({ db, adapters: { claude: adapter } });
  const conversation = chat.create(task, { agent: 'claude', session_id: 'source-session-time' }); // with a session, its history is loaded
  const before = Date.now();
  await chat.sendMessage(task, conversation.id, { text: 'go' });
  await wait(() => release);
  let state = await chat.snapshot(task, conversation.id);
  const item = state.items.find(entry => entry.id === 'x1');
  assert.equal(item.text, 'Hello');
  assert.ok(item.at >= before && item.at <= Date.now(), 'stamped when it first appeared');
  assert.ok(state.items.find(entry => entry.kind === 'user' && entry.text === 'go').at >= before, 'the message of the person too');
  assert.deepEqual(state.items.filter(entry => entry.id === 'h1' || entry.id === 'h2').map(entry => entry.at), [1000, 2000], 'history keeps the time of the agent\'s record');
  const first = item.at;
  assert.equal(state.items.find(entry => entry.id === 'x1').at, first, 'the update did not move it');
  release({ ok: true });
  await wait(() => chat.list(task.id).find(row => row.id === conversation.id).running === false);
});

test('service fork: a new conversation in the same task, with the same agent, access level and a title, resuming the forked session', async () => {
  const adapter = forkingAdapter();
  const chat = createAgentChat({ db, adapters: { claude: adapter } });
  const source = chat.create(task, { agent: 'claude', mode: 'full', title: 'Build the thing', session_id: 'source-session-1' });
  assert.equal((await chat.snapshot(task, source.id)).capabilities.fork, true, 'the page learns that it can offer fork');
  const answer = await chat.fork(task, source.id, { itemId: 'h2' });
  assert.deepEqual(answer.draft, '');
  assert.deepEqual([answer.conversation.agent, answer.conversation.mode, answer.conversation.title, answer.conversation.session_id], ['claude', 'full', 'Build the thing (fork)', 'forked-session-1']);
  assert.notEqual(answer.conversation.id, source.id);
  assert.deepEqual(adapter.forks.at(-1).items.map(item => item.id), ['h1', 'h2'], 'the adapter gets the items in order');
  assert.deepEqual([adapter.forks.at(-1).sessionId, adapter.forks.at(-1).itemId, adapter.forks.at(-1).title], ['source-session-1', 'h2', 'Build the thing (fork)']);
  assert.equal((await chat.fork(task, source.id, { itemId: 'h1' })).draft, 'earlier', 'a message of the person comes back as a draft');
  const history = await chat.snapshot(task, answer.conversation.id);
  assert.equal(history.conversation.session_id, 'forked-session-1');
  assert.equal(chat.list(task.id).filter(row => row.title === 'Build the thing (fork)').length, 2, 'both forks are conversations of the task');
});

test('service fork: not while the agent works, not before it has a session, not for an unknown item or an agent that cannot fork', async () => {
  let release;
  const adapter = forkingAdapter(async () => new Promise(resolve => { release = resolve; }));
  const chat = createAgentChat({ db, adapters: { claude: adapter, codex: { ...forkingAdapter(), fork: undefined, CAPABILITIES: {} } } });
  const fresh = chat.create(task, { agent: 'claude' });
  await assert.rejects(chat.fork(task, fresh.id, { itemId: 'h1' }), /NOTHING_TO_FORK/, 'no session yet');
  const source = chat.create(task, { agent: 'claude', session_id: 'source-session-2' });
  await assert.rejects(chat.fork(task, source.id, { itemId: 'zzz' }), /ITEM_NOT_FOUND/);
  await assert.rejects(chat.fork(task, source.id, {}), /ITEM_NOT_FOUND/);
  await assert.rejects(chat.fork(task, 'no-such-conversation', { itemId: 'h1' }), /CONVERSATION_NOT_FOUND/);
  const plain = chat.create(task, { agent: 'codex', session_id: 'codex-session-1' });
  await assert.rejects(chat.fork(task, plain.id, { itemId: 'h1' }), /FORK_NOT_SUPPORTED/);
  await chat.sendMessage(task, source.id, { text: 'work' });
  await wait(() => release);
  await assert.rejects(chat.fork(task, source.id, { itemId: 'h1' }), /CONVERSATION_BUSY/, 'while it works');
  assert.equal(adapter.forks.length, 0);
  release({ ok: true });
  await wait(() => chat.list(task.id).find(row => row.id === source.id).running === false);
});

test('the fork route: { itemId } gives the new conversation and the draft; refusals come back as errors with their code', async () => {
  const adapter = forkingAdapter();
  adapter.fork = async ({ itemId }) => { if (itemId === 'h1') throw Object.assign(new Error('FORK_AT_FIRST_MESSAGE'), { statusCode: 409 }); return { sessionId: 'forked-session-9', draft: 'hello' }; };
  const service = createAgentChat({ db, adapters: { claude: adapter } });
  const app = express();
  app.use(express.json());
  app.use('/api/tasks/:id/agent', createAgentChatRouter({ service, authenticate: (req, res, next) => { req.session = { user: { login: 'owner' } }; next(); } }));
  const server = await new Promise(resolve => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api/tasks/${task.id}/agent/conversations`;
  const call = async (suffix, body) => { const response = await fetch(url + suffix, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  try {
    const source = (await call('', { agent: 'claude', session_id: 'source-session-3' })).body;
    const ok = await call(`/${source.id}/fork`, { itemId: 'h2' });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.body.draft, ok.body.conversation.session_id, ok.body.conversation.agent], ['hello', 'forked-session-9', 'claude']);
    const refused = await call(`/${source.id}/fork`, { itemId: 'h1' });
    assert.deepEqual([refused.status, refused.body.error], [409, 'FORK_AT_FIRST_MESSAGE']);
    assert.equal((await call(`/${source.id}/fork`, {})).body.error, 'ITEM_NOT_FOUND');
  } finally { server.closeAllConnections(); server.close(); }
});
