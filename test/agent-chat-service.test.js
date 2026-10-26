const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-chat-'));
process.env.T_AGENT_DATA_DIR = root;
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
const db = require('../db');
const tasks = require('../services/engine-tasks');
const { createAgentChat } = require('../services/agent-chat');
const claude = require('../lib/agent-chat/claude');
const codex = require('../lib/agent-chat/codex');

const task = tasks.createTask('owner', { title: 'chat' });
test.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

const wait = async condition => { for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(condition(), 'timed out'); };

// A fake adapter that scripts a turn: it records its inputs and can ask for a permission.
function fakeAdapter(script) {
  const calls = [];
  return {
    MODES: { ask: {}, full: {} }, DEFAULT_MODE: 'ask', calls,
    loadHistory: async () => [{ id: 'h1', kind: 'user', text: 'earlier' }, { id: 'h2', kind: 'text', text: 'answer' }],
    runTurn: async args => { calls.push(args); return script(args); },
  };
}

test('a turn streams items, remembers the session and finishes idle', async () => {
  const adapter = fakeAdapter(async ({ ctx }) => {
    ctx.setSession('sess-12345678');
    ctx.upsert({ id: 'm1', kind: 'text', text: 'Hel' });
    ctx.append('m1', 'lo');
    return { ok: true, usage: { input: 1, output: 2 } };
  });
  const chat = createAgentChat({ db, adapters: { claude: adapter } });
  const conversation = chat.create(task, { agent: 'claude' });
  const seen = [];
  const stop = chat.subscribe(task, conversation.id, 0, event => seen.push(event));
  await chat.sendMessage(task, conversation.id, { text: 'hi there' });
  await wait(() => seen.some(event => event.op === 'status' && event.status === 'idle'));
  stop();
  const state = await chat.snapshot(task, conversation.id);
  assert.deepEqual(state.items.map(item => [item.kind, item.text]), [['user', 'hi there'], ['text', 'Hello']]);
  assert.equal(state.conversation.session_id, 'sess-12345678');
  assert.equal(state.conversation.title, 'hi there', 'the first prompt names a new chat');
  assert.equal(state.status, 'idle');
  assert.deepEqual(seen.map(event => event.seq), seen.map((_, index) => index + 1), 'events are numbered without gaps');
  // The next turn resumes the session the first one reported.
  await chat.sendMessage(task, conversation.id, { text: 'again' });
  await wait(() => adapter.calls.length === 2 && chat.list(task.id)[0].running === false);
  assert.equal(adapter.calls[1].sessionId, 'sess-12345678');
});

test('permission requests wait for an answer; interrupt denies them and stops the turn', async () => {
  let answer;
  const adapter = fakeAdapter(async ({ requestPermission, signal }) => {
    answer = await requestPermission({ tool: 'Bash', input: { command: 'ls' }, title: 'Run ls' });
    if (!answer.allow) return { ok: true };
    await new Promise(resolve => signal.addEventListener('abort', resolve));
    return { ok: false, error: '' };
  });
  const chat = createAgentChat({ db, adapters: { claude: adapter } });
  const conversation = chat.create(task, { agent: 'claude' });
  await chat.sendMessage(task, conversation.id, { text: 'run it' });
  let pending;
  for (let i = 0; i < 200 && !pending; i++) {
    pending = (await chat.snapshot(task, conversation.id)).pending[0];
    if (!pending) await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(pending, 'the permission request is listed');
  assert.equal(pending.tool, 'Bash');
  await assert.rejects(chat.sendMessage(task, conversation.id, { text: 'second' }), /CONVERSATION_BUSY/);
  chat.answerPermission(task, conversation.id, pending.id, { allow: true });
  await wait(() => answer);
  assert.equal(answer.allow, true);
  chat.interrupt(task, conversation.id);
  await wait(() => !chat.list(task.id).find(row => row.id === conversation.id).running);
  const final = await chat.snapshot(task, conversation.id);
  assert.ok(final.items.some(item => item.kind === 'notice' && item.text === 'Stopped'));
  assert.deepEqual(final.pending, []);
  assert.throws(() => chat.answerPermission(task, conversation.id, 'nope', { allow: true }), /REQUEST_NOT_FOUND/);
});

test('a resumed session shows its earlier messages; the same session reuses one conversation', async () => {
  const adapter = fakeAdapter(async () => ({ ok: true }));
  const chat = createAgentChat({ db, adapters: { codex: adapter } });
  const first = chat.create(task, { agent: 'codex', session_id: 'thread-abcdef12', title: 'Old thread' });
  assert.equal(chat.create(task, { agent: 'codex', session_id: 'thread-abcdef12' }).id, first.id);
  const state = await chat.snapshot(task, first.id);
  assert.deepEqual(state.items.map(item => item.id), ['h1', 'h2']);
  assert.equal(state.conversation.title, 'Old thread');
});

test('attachments are validated and text files are quoted into the prompt', async () => {
  const adapter = fakeAdapter(async () => ({ ok: true }));
  const chat = createAgentChat({ db, adapters: { claude: adapter } });
  const { id } = chat.create(task, { agent: 'claude' });
  await assert.rejects(chat.sendMessage(task, id, { text: '' }), /EMPTY_MESSAGE/);
  await assert.rejects(chat.sendMessage(task, id, { text: 'x', images: [{ type: 'image/svg+xml', data: 'AAAA' }] }), /INVALID_IMAGE/);
  await assert.rejects(chat.sendMessage(task, id, { text: 'x', images: [{ type: 'image/png', data: 'not base64!' }] }), /INVALID_IMAGE/);
  await chat.sendMessage(task, id, { text: 'look', images: [{ type: 'image/png', data: 'iVBORw0KGgo=', name: 'a.png' }], files: [{ name: 'n.txt', text: 'hello file' }] });
  await wait(() => adapter.calls.length === 1);
  assert.equal(adapter.calls[0].prompt.images.length, 1);
  assert.match(adapter.calls[0].prompt.text, /Attached file n\.txt:[\s\S]*hello file/);
  await assert.rejects(chat.snapshot({ id: task.id + 99, work_dir: task.work_dir }, 'missing'), /CONVERSATION_NOT_FOUND/);
});

test('an unknown agent, mode or session id is rejected and the title can be renamed', () => {
  const chat = createAgentChat({ db, adapters: { claude: fakeAdapter(async () => ({ ok: true })) } });
  assert.throws(() => chat.create(task, { agent: 'bash' }), /INVALID_AGENT/);
  assert.throws(() => chat.create(task, { agent: 'claude', session_id: 'x; rm' }), /INVALID_SESSION_ID/);
  const row = chat.create(task, { agent: 'claude', mode: 'nonsense' });
  assert.equal(row.mode, 'ask', 'an unknown mode falls back to the default');
  assert.throws(() => chat.setMode(task, row.id, 'nonsense'), /INVALID_MODE/);
  assert.equal(chat.setMode(task, row.id, 'full').mode, 'full');
  assert.equal(chat.rename(task, row.id, '  My   chat ').title, 'My chat');
});

// ── Adapters: SDK messages as recorded from the real SDKs ──
function collector() {
  const items = new Map();
  let session = null;
  return {
    items, get session() { return session; },
    upsert: item => items.set(item.id, item),
    append: (id, text) => { items.get(id).text += text; },
    getItem: id => items.get(id),
    setSession: id => { session = id; },
  };
}

test('Claude messages become text, thinking and tool items; streamed text is replaced by the final message', () => {
  const ctx = collector();
  const normalizer = claude.createNormalizer(ctx);
  normalizer.handle({ type: 'system', subtype: 'init', session_id: 's-1' });
  normalizer.handle({ type: 'stream_event', api_message_id: 'msg_1', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  normalizer.handle({ type: 'stream_event', api_message_id: 'msg_1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } });
  assert.equal(ctx.items.get('msg_1:0').text, 'hi');
  normalizer.handle({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'hi there' }] } });
  assert.equal(ctx.items.size, 1);
  assert.equal(ctx.items.get('msg_1:0').text, 'hi there');
  normalizer.handle({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo ok' } }] } });
  assert.equal(ctx.items.get('toolu_1').status, 'running');
  normalizer.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', is_error: false }] } });
  assert.deepEqual([ctx.items.get('toolu_1').status, ctx.items.get('toolu_1').output], ['done', 'ok']);
  normalizer.handle({ type: 'assistant', parent_tool_use_id: 'toolu_x', message: { id: 'msg_sub', content: [{ type: 'text', text: 'subagent' }] } });
  assert.equal(ctx.items.size, 2, 'subagent chatter is not shown');
  const result = normalizer.handle({ type: 'result', subtype: 'success', session_id: 's-1', total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 4 } });
  assert.deepEqual([result.ok, result.usage, ctx.session], [true, { input: 3, output: 4 }, 's-1']);
  assert.equal(normalizer.handle({ type: 'result', subtype: 'error_max_turns' }).ok, false);
});

test('Claude runTurn passes the mode, resume id and permission callback to the SDK and builds image prompts', async () => {
  let captured;
  const sdk = { query(args) { captured = args; return (async function* () { yield { type: 'result', subtype: 'success', session_id: 's-9' }; }()); } };
  const ctx = collector();
  const outcome = await claude.runTurn({
    cwd: '/work', sessionId: 's-old', mode: 'plan', prompt: { text: 'go', images: [{ mediaType: 'image/png', data: 'AAAA' }] }, signal: new AbortController().signal, ctx,
    requestPermission: async request => ({ allow: request.tool === 'Read' }), deps: { loadSdk: async () => sdk, executable: '/bin/claude' },
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual([captured.options.cwd, captured.options.resume, captured.options.permissionMode, captured.options.pathToClaudeCodeExecutable], ['/work', 's-old', 'plan', '/bin/claude']);
  assert.deepEqual(captured.options.settingSources, ['user', 'project', 'local']);
  assert.deepEqual(await captured.options.canUseTool('Read', { file_path: '/a' }, {}), { behavior: 'allow', updatedInput: { file_path: '/a' } });
  assert.equal((await captured.options.canUseTool('Bash', {}, {})).behavior, 'deny');
  const first = await captured.prompt.next();
  assert.deepEqual(first.value.message.content.map(part => part.type), ['image', 'text']);
  const full = await claude.runTurn({ cwd: '/w', mode: 'full', prompt: { text: 'x' }, signal: new AbortController().signal, ctx, requestPermission: async () => ({ allow: true }), deps: { loadSdk: async () => sdk, executable: undefined } });
  assert.equal(full.ok, true);
  assert.deepEqual([captured.options.permissionMode, captured.options.allowDangerouslySkipPermissions, captured.prompt], ['bypassPermissions', true, 'x']);
});

test('Codex history is read from the rollout file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-codex-'));
  const day = path.join(home, '.codex', 'sessions', '2026', '10', '26');
  fs.mkdirSync(day, { recursive: true });
  const rows = [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /work\n\n<INSTRUCTIONS>rules</INSTRUCTIONS>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'c1' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'a.txt' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'one file' }] } },
  ];
  fs.writeFileSync(path.join(day, 'rollout-2026-10-26T01-00-00-thread-abcdef12.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
  const items = codex.historyFromRollout(codex.findRollout('thread-abcdef12', home));
  assert.deepEqual(items.map(item => [item.kind, item.name || item.text, item.output || '']), [['user', 'list files', ''], ['tool', 'Shell', 'a.txt'], ['text', 'one file', '']]);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a message sent while the agent works steers the running turn when the agent supports it', async () => {
  const steered = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const adapter = {
    ...fakeAdapter(async ({ ctx }) => {
      ctx.setControl({ steer: async prompt => { steered.push(prompt.text); } });
      await gate;
      return { ok: true };
    }),
    CAPABILITIES: { steer: true },
  };
  const chat = createAgentChat({ db, adapters: { codex: adapter } });
  const conversation = chat.create(task, { agent: 'codex' });
  assert.deepEqual((await chat.snapshot(task, conversation.id)).capabilities, { steer: true });
  await chat.sendMessage(task, conversation.id, { text: 'start' });
  await wait(() => adapter.calls.length === 1);
  const result = await chat.sendMessage(task, conversation.id, { text: 'and also this' });
  assert.deepEqual([result.steered, steered], [true, ['and also this']]);
  const state = await chat.snapshot(task, conversation.id);
  assert.deepEqual(state.items.filter(item => item.kind === 'user').map(item => item.text), ['start', 'and also this']);
  assert.equal(adapter.calls.length, 1, 'steering does not start another turn');
  release();
  await wait(() => chat.list(task.id).find(row => row.id === conversation.id).running === false);
});

test('a message to a running turn that cannot be steered is refused, and a failed steer is not shown', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const plain = fakeAdapter(async () => { await gate; return { ok: true }; });
  const chat = createAgentChat({ db, adapters: { claude: plain, codex: { ...plain, CAPABILITIES: { steer: true } } } });
  const busy = chat.create(task, { agent: 'claude' });
  await chat.sendMessage(task, busy.id, { text: 'go' });
  await assert.rejects(chat.sendMessage(task, busy.id, { text: 'more' }), error => error.message === 'CONVERSATION_BUSY' && error.statusCode === 409);

  const failing = fakeAdapter(async ({ ctx }) => { ctx.setControl({ steer: async () => { throw new Error('turn is over'); } }); await gate; return { ok: true }; });
  const chat2 = createAgentChat({ db, adapters: { codex: { ...failing, CAPABILITIES: { steer: true } } } });
  const conversation = chat2.create(task, { agent: 'codex' });
  await chat2.sendMessage(task, conversation.id, { text: 'go' });
  await wait(() => failing.calls.length === 1);
  await assert.rejects(chat2.sendMessage(task, conversation.id, { text: 'more' }), error => error.message === 'STEER_FAILED');
  assert.deepEqual((await chat2.snapshot(task, conversation.id)).items.filter(item => item.kind === 'user').map(item => item.text), ['go']);
  release();
});

test('questions carry their fields to the client and the answers are cleaned; "remember" only applies where offered', async () => {
  const received = [];
  const adapter = fakeAdapter(async ({ requestPermission }) => {
    received.push(await requestPermission({ kind: 'question', tool: 'Question', input: {}, title: 'Q', questions: [{ id: 'a', question: 'Which?', options: null, isOther: true }] }));
    received.push(await requestPermission({ tool: 'Shell', input: {}, canRemember: true }));
    received.push(await requestPermission({ tool: 'Edit files', input: {} }));
    return { ok: true };
  });
  const chat = createAgentChat({ db, adapters: { codex: adapter } });
  const conversation = chat.create(task, { agent: 'codex' });
  await chat.sendMessage(task, conversation.id, { text: 'go' });
  await wait(() => chat.list(task.id).length && adapter.calls.length === 1);
  // The oldest request that is waiting for an answer.
  const nextPending = async () => {
    for (let i = 0; i < 200; i++) {
      const [request] = (await chat.snapshot(task, conversation.id)).pending;
      if (request) return request;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('no request arrived');
  };
  let question = await nextPending();
  assert.deepEqual([question.kind, question.questions[0].id], ['question', 'a']);
  chat.answerPermission(task, conversation.id, question.id, { allow: true, remember: true, answers: { a: 'x'.repeat(5000), b: ['one', { nested: 1 }, 2] } });
  await wait(() => received.length === 1);
  assert.equal(received[0].answers.a.length, 2000);
  assert.deepEqual(received[0].answers.b, ['one', '2']);
  assert.equal(received[0].remember, false, 'a question has nothing to remember');

  question = await nextPending();
  assert.equal(question.canRemember, true);
  chat.answerPermission(task, conversation.id, question.id, { allow: true, remember: true, answers: { ignored: 'x' } });
  await wait(() => received.length === 2);
  assert.deepEqual([received[1].allow, received[1].remember, received[1].answers], [true, true, undefined]);

  const last = await nextPending();
  chat.answerPermission(task, conversation.id, last.id, { allow: true, remember: true });
  await wait(() => received.length === 3);
  assert.equal(received[2].remember, false, 'a request that does not offer "remember" never remembers');
});

test('the model and effort an agent reports reach the page; a running turn tells how long it has run', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const adapter = fakeAdapter(async ({ ctx }) => {
    ctx.setMeta({ model: 'gpt-fake', effort: 'high' });
    ctx.setMeta({ model: 'gpt-fake', effort: 'high' }); // unchanged: no second event
    ctx.setMeta({ effort: 42, model: '   ' }); // not strings: ignored
    await gate;
    return { ok: true };
  });
  const chat = createAgentChat({ db, adapters: { codex: adapter } });
  const conversation = chat.create(task, { agent: 'codex' });
  const seen = [];
  const stop = chat.subscribe(task, conversation.id, 0, event => seen.push(event));
  await chat.sendMessage(task, conversation.id, { text: 'go' });
  await wait(() => adapter.calls.length === 1 && seen.some(event => event.model));
  assert.deepEqual(seen.filter(event => event.model || event.effort).map(({ model, effort }) => [model, effort]), [['gpt-fake', 'high']], 'one event, none for an unchanged or invalid value');
  assert.equal(seen.find(event => event.op === 'status').runningMs, 0);
  await new Promise(resolve => setTimeout(resolve, 30));
  const running = await chat.snapshot(task, conversation.id);
  assert.deepEqual([running.conversation.model, running.conversation.effort], ['gpt-fake', 'high']);
  assert.ok(running.runningMs >= 20, 'the snapshot says how long the turn has been running');
  release();
  await wait(() => chat.list(task.id).find(row => row.id === conversation.id).running === false);
  stop();
  assert.equal((await chat.snapshot(task, conversation.id)).runningMs, 0);
});

test('Claude announces a new session once, with what it was started with, and keeps its model', () => {
  const run = announce => {
    const items = new Map(); const meta = [];
    const normalizer = claude.createNormalizer({ upsert: item => items.set(item.id, item), append() {}, getItem: id => items.get(id), setSession() {}, setMeta: value => meta.push(value) }, { announce });
    normalizer.handle({ type: 'system', subtype: 'init', session_id: 'sess-12345678', model: 'claude-sonnet-5-5', cwd: '/w', permissionMode: 'default', tools: ['Bash', 'Read'], mcp_servers: [{ name: 'docs', status: 'connected' }] });
    return { items, meta };
  };
  const fresh = run(true);
  assert.deepEqual(fresh.meta, [{ model: 'claude-sonnet-5-5' }]);
  const init = fresh.items.get('init:sess-12345678');
  assert.deepEqual([init.kind, init.text], ['init', 'Initialized session']);
  assert.deepEqual(init.details, [['Model', 'claude-sonnet-5-5'], ['Working directory', '/w'], ['Permission mode', 'default'], ['Tools', '2'], ['MCP servers', 'docs (connected)'], ['Session', 'sess-12345678']]);
  const resumed = run(false);
  assert.equal(resumed.items.size, 0, 'a resumed session is not announced again');
  assert.deepEqual(resumed.meta, [{ model: 'claude-sonnet-5-5' }]);
});

test('Codex: the model, effort and context use of a session come from the end of its rollout file', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-codex-meta-'));
  const day = path.join(home, '.codex', 'sessions', '2026', '10', '26');
  fs.mkdirSync(day, { recursive: true });
  const row = (type, payload) => JSON.stringify({ type, payload });
  fs.writeFileSync(path.join(day, 'rollout-2026-10-26T01-00-00-thread-meta0001.jsonl'), [
    row('turn_context', { model: 'old-model', effort: 'low' }),
    row('event_msg', { type: 'token_count', info: { last_token_usage: { total_tokens: 10 }, model_context_window: 100 } }),
    row('turn_context', { model: 'gpt-fake', effort: 'high' }),
    'not json',
    row('event_msg', { type: 'token_count', info: null }),
    row('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, output_tokens: 34 }, model_context_window: 258400 } }),
  ].join('\n'));
  assert.deepEqual(await codex.loadMeta({ sessionId: 'thread-meta0001', home }), { model: 'gpt-fake', effort: 'high', context: { used: 1034, window: 258400 } });
  assert.equal(await codex.loadMeta({ sessionId: 'thread-unknown1', home }), null);
  fs.rmSync(home, { recursive: true, force: true });
});

test('Claude: context use follows each request, the real window comes with the result, and a later chat reads both from the session', async () => {
  const meta = [];
  const items = new Map();
  const normalizer = claude.createNormalizer({ upsert: item => items.set(item.id, item), append() {}, getItem: id => items.get(id), setSession() {}, setMeta: value => meta.push(value) });
  normalizer.handle({ type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: 2, cache_read_input_tokens: 40000, cache_creation_input_tokens: 3000, output_tokens: 500 } } });
  assert.deepEqual(meta.at(-1), { model: 'claude-sonnet-5-5', context: { used: 43502, window: 200000 } });
  normalizer.handle({ type: 'assistant', message: { id: 'm2', model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: 1, cache_read_input_tokens: 450000, output_tokens: 9 } } });
  assert.equal(meta.at(-1).context.window, 1000000, 'a request that held more than 200k ran on a larger window');
  normalizer.handle({ type: 'result', subtype: 'success', is_error: false, modelUsage: { 'claude-sonnet-5-5': { contextWindow: 1000000 }, 'claude-haiku-5-5': { contextWindow: 200000 } } });
  assert.deepEqual(meta.at(-1), { context: { used: 450010, window: 1000000 } }, 'the largest reported window, with the use of the last request');
  normalizer.handle({ type: 'assistant', message: { id: 'sub', parent_tool_use_id: 'x', content: [] } }); // no usage: nothing reported

  const sdk = { getSessionMessages: async () => [
    { type: 'user', message: { content: 'hi' } },
    { type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 5, cache_read_input_tokens: 995, output_tokens: 100 } } },
    { type: 'assistant', message: { content: [] } },
  ] };
  assert.deepEqual(await claude.loadMeta({ cwd: '/w', sessionId: 's-1', deps: { loadSdk: async () => sdk } }), { model: 'claude-opus-5-5', context: { used: 1100, window: 200000 } });
  assert.equal(await claude.loadMeta({ cwd: '/w', sessionId: 's-2', deps: { loadSdk: async () => ({ getSessionMessages: async () => [] }) } }), null);
});

test('a chat opened later gets its model, effort and context from the session, without replacing what a live turn reported', async () => {
  const adapter = {
    ...fakeAdapter(async ({ ctx }) => { ctx.setMeta({ context: { used: 50, window: 100 } }); return { ok: true }; }),
    loadMeta: async () => ({ model: 'from-file', effort: 'low', context: { used: 10, window: 100 } }),
  };
  const chat = createAgentChat({ db, adapters: { codex: adapter } });
  const reopened = chat.create(task, { agent: 'codex', session_id: 'thread-reopen01' });
  const first = await chat.snapshot(task, reopened.id);
  assert.deepEqual([first.conversation.model, first.conversation.effort, first.conversation.context], ['from-file', 'low', { used: 10, window: 100 }]);
  assert.equal(first.seq, 0, 'what is read from the session is not an event');

  const live = chat.create(task, { agent: 'codex', session_id: 'thread-reopen02' });
  await chat.sendMessage(task, live.id, { text: 'go' });
  await wait(() => adapter.calls.length === 1 && chat.list(task.id).find(row => row.id === live.id).running === false);
  const state = await chat.snapshot(task, live.id);
  assert.deepEqual(state.conversation.context, { used: 50, window: 100 }, 'the live report stays');
  assert.deepEqual([state.conversation.model, state.conversation.effort], ['from-file', 'low'], 'and what it did not report is filled in');

  const failing = createAgentChat({ db, adapters: { codex: { ...adapter, loadMeta: async () => { throw new Error('unreadable'); } } } });
  const unreadable = failing.create(task, { agent: 'codex', session_id: 'thread-reopen03' });
  assert.equal((await failing.snapshot(task, unreadable.id)).conversation.model, undefined, 'an unreadable session just leaves the footer empty');
  for (const bad of [{ used: -1, window: 100 }, { used: 1, window: 0 }, { used: 'x', window: 5 }, null]) {
    const rt = createAgentChat({ db, adapters: { codex: fakeAdapter(async ({ ctx }) => { ctx.setMeta({ context: bad }); return { ok: true }; }) } });
    const chat2 = rt.create(task, { agent: 'codex' });
    await rt.sendMessage(task, chat2.id, { text: 'x' });
    await wait(() => rt.list(task.id).find(row => row.id === chat2.id).running === false);
    assert.equal((await rt.snapshot(task, chat2.id)).conversation.context, undefined);
  }
});

test('Claude: the chosen model and effort go to the SDK, the model list comes from a query that runs no turn, and plan windows are reported', async () => {
  let options;
  const sdk = { query: args => { options = args.options; return (async function* () { yield { type: 'result', subtype: 'success', is_error: false }; }()); } };
  const run = extra => claude.runTurn({ cwd: '/w', mode: 'ask', prompt: { text: 'x' }, signal: new AbortController().signal, ctx: { upsert() {}, append() {}, getItem() {}, setSession() {} }, requestPermission: async () => ({ allow: true }), deps: { loadSdk: async () => sdk, executable: undefined }, ...extra });
  await run({ model: 'sonnet', effort: 'high' });
  assert.deepEqual([options.model, options.effort], ['sonnet', 'high']);
  await run({ model: 'opus', effort: 'turbo' });
  assert.deepEqual([options.model, 'effort' in options], ['opus', false], 'an effort the SDK does not know is not passed on');
  await run({});
  assert.equal('model' in options, false);

  let closed = false;
  const lister = { query: args => { assert.equal(typeof args.prompt.next, 'function', 'the prompt never yields, so no turn runs'); return { supportedModels: async () => [
    { value: 'default', displayName: 'Default (recommended)', description: 'd', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
    { value: 'haiku', displayName: 'Haiku 5.5', description: 'h', supportsEffort: false },
  ], close: () => { closed = true; } }; } };
  assert.deepEqual(await claude.listModels({ deps: { loadSdk: async () => lister, executable: undefined } }), [
    { value: '', label: 'Default (recommended)', description: 'd', efforts: ['low', 'high'], defaultEffort: '' },
    { value: 'haiku', label: 'Haiku 5.5', description: 'h', efforts: [], defaultEffort: '' },
  ]);
  assert.equal(closed, true);

  const usageSdk = usage => ({ query: () => ({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async options => { assert.equal(options.skipBehaviors, true); return usage; }, close() {} }) });
  assert.deepEqual(await claude.loadLimits({ deps: { loadSdk: async () => usageSdk({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 66, resets_at: '2026-10-26T14:00:00+00:00' }, seven_day: { utilization: 29, resets_at: null }, seven_day_sonnet: { utilization: 5, resets_at: null }, other: { utilization: 1 },
  } }), executable: undefined } }), [
    { id: '5h', label: '5h', usedPercent: 66, resetsAt: Date.parse('2026-10-26T14:00:00+00:00') },
    { id: '7d', label: '7d', usedPercent: 29, resetsAt: null },
  ], 'the plan windows come as percents with their reset times');
  assert.deepEqual(await claude.loadLimits({ deps: { loadSdk: async () => usageSdk({ rate_limits_available: false, rate_limits: null }), executable: undefined } }), [], 'an API-key account has no plan limits');
  assert.deepEqual(await claude.loadLimits({ deps: { loadSdk: async () => ({ query: () => ({ close() {} }) }), executable: undefined } }), [], 'an SDK without the usage call gives none');

  const meta = [];
  const normalizer = claude.createNormalizer({ upsert() {}, append() {}, getItem() {}, setSession() {}, setMeta: value => meta.push(value) });
  normalizer.handle({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.42, resetsAt: 1000 } });
  normalizer.handle({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.9 } });
  normalizer.handle({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'overage', utilization: 0.1 } });
  normalizer.handle({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' } });
  assert.equal(meta.length, 2, 'other meters and events without a use are ignored');
  assert.deepEqual(meta[0].limits, [{ id: '5h', label: '5h', usedPercent: 42, resetsAt: 1000000 }]);
  assert.deepEqual([meta[1].limits[0].label, meta[1].limits[0].usedPercent, meta[1].limits[0].resetsAt], ['7d', 90, null]);
});

test('the person picks the model and effort of a chat: validated, saved, shown at once, and used by the next turns after a restart', async () => {
  const adapter = fakeAdapter(async () => ({ ok: true }));
  const chat = createAgentChat({ db, adapters: { codex: adapter } });
  const conversation = chat.create(task, { agent: 'codex' });
  const seen = [];
  chat.subscribe(task, conversation.id, 0, event => seen.push(event));
  let row = chat.setPreferences(task, conversation.id, { model: 'gpt-6.1-sol', effort: 'high' });
  assert.deepEqual([row.model, row.effort], ['gpt-6.1-sol', 'high'], 'the footer shows the choice before a turn reports its own');
  assert.deepEqual(seen.at(-1), { op: 'meta', model: 'gpt-6.1-sol', effort: 'high', seq: seen.at(-1).seq });
  assert.deepEqual(db.prepare('SELECT model, effort FROM agent_conversations WHERE id = ?').get(conversation.id), { model: 'gpt-6.1-sol', effort: 'high' });
  for (const bad of [{ model: 'bad model!' }, { model: '../x' }, { effort: 'Very High' }, { effort: 'x' }, { model: 'm'.repeat(81) }]) {
    assert.throws(() => chat.setPreferences(task, conversation.id, bad), /INVALID_(MODEL|EFFORT)/);
  }
  assert.throws(() => chat.setPreferences(task, 'missing', { model: 'a' }), /CONVERSATION_NOT_FOUND/);
  chat.setPreferences(task, conversation.id, { effort: 'low' });
  assert.equal(chat.snapshot && (await chat.snapshot(task, conversation.id)).conversation.model, 'gpt-6.1-sol', 'changing one leaves the other');

  await chat.sendMessage(task, conversation.id, { text: 'go' });
  await wait(() => adapter.calls.length === 1);
  assert.deepEqual([adapter.calls[0].model, adapter.calls[0].effort], ['gpt-6.1-sol', 'low']);

  // After a restart (a new service on the same database) the choice is still there.
  const restarted = createAgentChat({ db, adapters: { codex: adapter } });
  const state = await restarted.snapshot(task, conversation.id);
  assert.deepEqual([state.conversation.model, state.conversation.effort], ['gpt-6.1-sol', 'low']);
  const cleared = restarted.setPreferences(task, conversation.id, { model: '', effort: null });
  assert.deepEqual([cleared.model, cleared.effort], [undefined, undefined]);
  assert.deepEqual(db.prepare('SELECT model, effort FROM agent_conversations WHERE id = ?').get(conversation.id), { model: null, effort: null });
  await wait(() => restarted.list(task.id).find(entry => entry.id === conversation.id).running === false);
  await restarted.sendMessage(task, conversation.id, { text: 'again' });
  await wait(() => adapter.calls.length === 2);
  assert.deepEqual([adapter.calls[1].model, adapter.calls[1].effort], [undefined, undefined], 'cleared: the agent decides');
});

test('the model list is read from the agent once for a while, starts with "Default", and a failure is reported without being kept', async () => {
  let reads = 0;
  let fail = false;
  const adapter = { ...fakeAdapter(async () => ({ ok: true })), listModels: async () => { reads++; if (fail) throw new Error('boom'); return [{ value: 'a', label: 'A', description: '', efforts: ['low', 'high'], defaultEffort: 'low' }, { value: 'b', label: 'B', description: '', efforts: ['high', 'max'], defaultEffort: 'high' }]; } };
  const chat = createAgentChat({ db, adapters: { codex: adapter, claude: fakeAdapter(async () => ({ ok: true })) } });
  const conversation = chat.create(task, { agent: 'codex' });
  chat.setPreferences(task, conversation.id, { model: 'b' });
  const [first, second] = await Promise.all([chat.listModels(task, conversation.id), chat.listModels(task, conversation.id)]);
  assert.equal(reads, 1, 'one read serves both requests, and the next ones');
  await chat.listModels(task, conversation.id);
  assert.equal(reads, 1);
  assert.deepEqual(first.models.map(model => model.value), ['', 'a', 'b']);
  assert.deepEqual(first.models[0], { value: '', label: 'Default', description: '', efforts: ['low', 'high', 'max'], defaultEffort: '' });
  assert.deepEqual([first.current.model, first.chosen.model, second.models.length], ['b', 'b', 3]);
  const plain = chat.create(task, { agent: 'claude' });
  await assert.rejects(chat.listModels(task, plain.id), /MODELS_UNAVAILABLE/);
  const other = createAgentChat({ db, adapters: { codex: { ...adapter, listModels: async () => { throw new Error('offline'); } } } });
  const broken = other.create(task, { agent: 'codex' });
  await assert.rejects(other.listModels(task, broken.id), error => error.message === 'MODELS_UNAVAILABLE' && error.statusCode === 502);
  fail = false;
});

test('plan limits: the last reading is shown at once, an old one is read again in the background, partial updates merge, and a failure waits', async () => {
  let reads = 0;
  let reading = [{ id: '5h', label: '5h', usedPercent: 10, resetsAt: Date.now() + 3600000 }, { id: '7d', label: '7d', usedPercent: 20, resetsAt: Date.now() + 86400000 }];
  const adapter = { ...fakeAdapter(async ({ ctx }) => { ctx.setMeta({ limits: [{ id: '5h', label: '5h', usedPercent: 15.55, resetsAt: Date.now() + 3000000 }, { id: 'x', label: '', usedPercent: 1 }, { id: 'y', label: 'y', usedPercent: -1 }] }); return { ok: true }; }), loadLimits: async () => { reads++; return reading; } };
  const chat = createAgentChat({ db, adapters: { codex: adapter } });
  const first = chat.create(task, { agent: 'codex', session_id: 'thread-limits01' });
  const second = chat.create(task, { agent: 'codex', session_id: 'thread-limits02' });
  const seen = [];
  chat.subscribe(task, second.id, 0, event => seen.push(event));
  const opened = await chat.snapshot(task, first.id);
  assert.equal(opened.conversation.limits, undefined, 'nothing is known before the first reading');
  await wait(() => reads === 1);
  await chat.refreshLimits('codex');
  assert.equal((await chat.snapshot(task, first.id)).conversation.limits.length, 2);
  assert.equal(reads, 1, 'a recent reading is not repeated');

  // Another chat opens later and shows what was read; the reading also reached the chat that was already subscribed.
  await chat.snapshot(task, second.id);
  assert.deepEqual((await chat.snapshot(task, second.id)).conversation.limits.map(entry => entry.id), ['5h', '7d']);
  assert.ok(seen.some(event => event.op === 'meta' && event.limits));

  // A turn that reports one window changes only that one; bad entries are dropped and the percentage keeps one decimal.
  await chat.sendMessage(task, first.id, { text: 'go' });
  await wait(() => chat.list(task.id).find(entry => entry.id === first.id).running === false && adapter.calls.length >= 1);
  const limits = (await chat.snapshot(task, first.id)).conversation.limits;
  assert.deepEqual(limits.map(entry => [entry.id, entry.usedPercent]), [['5h', 15.6], ['7d', 20]]);

  const broken = createAgentChat({ db, adapters: { codex: { ...adapter, loadLimits: async () => { reads++; throw new Error('offline'); } } } });
  const before = reads;
  const chat3 = broken.create(task, { agent: 'codex', session_id: 'thread-limits03' });
  await broken.snapshot(task, chat3.id);
  await broken.refreshLimits('codex');
  await broken.snapshot(task, chat3.id);
  assert.equal(reads - before, 1, 'after a failure it waits before asking again');
  assert.equal((await broken.snapshot(task, chat3.id)).conversation.limits, undefined);
});

test('choosing another model drops the effort the last turn reported, but keeps one the person chose', async () => {
  const adapter = fakeAdapter(async ({ ctx }) => { ctx.setMeta({ model: 'gpt-old', effort: 'medium' }); return { ok: true }; });
  const chat = createAgentChat({ db, adapters: { codex: adapter } });
  const conversation = chat.create(task, { agent: 'codex' });
  const seen = [];
  chat.subscribe(task, conversation.id, 0, event => seen.push(event));
  await chat.sendMessage(task, conversation.id, { text: 'go' });
  await wait(() => chat.list(task.id).find(row => row.id === conversation.id).running === false && adapter.calls.length === 1);
  assert.deepEqual([chat.list(task.id)[0].model, chat.list(task.id).find(row => row.id === conversation.id).effort], ['gpt-old', 'medium']);

  const switched = chat.setPreferences(task, conversation.id, { model: 'gpt-new' });
  assert.deepEqual([switched.model, switched.effort], ['gpt-new', undefined], 'the reported effort belonged to the old model');
  assert.equal(seen.at(-1).effort, '', 'the page is told to clear it');
  chat.setPreferences(task, conversation.id, { effort: 'high' });
  const again = chat.setPreferences(task, conversation.id, { model: 'gpt-third' });
  assert.deepEqual([again.model, again.effort], ['gpt-third', 'high'], 'an effort the person chose stays');
});

test('which chats are open is saved per page: the desktop keeps every open chat, the phone one per task, and opening does not reorder the list', async () => {
  const task = tasks.createTask('owner', { title: 'open flags' }); // its own task: the chats of the other tests are not in this list
  const chat = createAgentChat({ db, adapters: { codex: fakeAdapter(async () => ({ ok: true })) } });
  const other = tasks.createTask('owner', { title: 'other task' });
  const a = chat.create(task, { agent: 'codex', title: 'A' });
  const b = chat.create(task, { agent: 'codex', title: 'B' });
  const c = chat.create(task, { agent: 'codex', title: 'C' });
  const elsewhere = chat.create(other, { agent: 'codex', title: 'Elsewhere' });
  assert.deepEqual(chat.list(task.id).map(row => row.opened), Array(3).fill({ web: null, h5: null }), 'nothing is open at first');
  const order = chat.list(task.id).map(row => row.id);

  const first = chat.setOpened(task, a.id, { surface: 'web', opened: true });
  assert.ok(first.opened.web > 0 && first.opened.h5 === null);
  await new Promise(resolve => setTimeout(resolve, 5));
  chat.setOpened(task, b.id, { surface: 'web', opened: true });
  const again = chat.setOpened(task, a.id, { surface: 'web', opened: true });
  assert.equal(again.opened.web, first.opened.web, 'opening again keeps the place among the tabs');
  assert.deepEqual(chat.list(task.id).map(row => row.id), order, 'the list keeps its order');
  assert.deepEqual(chat.list(task.id).filter(row => row.opened.web).sort((x, y) => x.opened.web - y.opened.web).map(row => row.title), ['A', 'B']);

  // The phone shows one chat at a time: opening one closes the other of the task, but not the desktop's tabs or another task's chat.
  chat.setOpened(task, a.id, { surface: 'h5', opened: true });
  chat.setOpened(other, elsewhere.id, { surface: 'h5', opened: true });
  chat.setOpened(task, c.id, { surface: 'h5', opened: true });
  const rows = Object.fromEntries(chat.list(task.id).map(row => [row.title, row.opened]));
  assert.deepEqual([rows.A.h5, rows.B.h5 === null, rows.C.h5 > 0], [null, true, true]);
  assert.ok(rows.A.web && rows.B.web, 'the desktop tabs are not touched by the phone');
  assert.ok(chat.list(other.id)[0].opened.h5, 'another task is not touched');

  chat.setOpened(task, a.id, { surface: 'web', opened: false });
  assert.equal(chat.list(task.id).find(row => row.title === 'A').opened.web, null);
  // It survives a restart (a new service on the same database).
  const restarted = createAgentChat({ db, adapters: { codex: fakeAdapter(async () => ({ ok: true })) } });
  assert.deepEqual(restarted.list(task.id).filter(row => row.opened.web).map(row => row.title), ['B']);
  assert.deepEqual((await restarted.snapshot(task, c.id)).conversation.opened.h5 > 0, true);

  for (const bad of [{ surface: 'tablet', opened: true }, { surface: 'web', opened: 'yes' }, { surface: 'web' }, {}, undefined]) {
    assert.throws(() => chat.setOpened(task, a.id, bad), /INVALID_(SURFACE|OPENED)/);
  }
  assert.throws(() => chat.setOpened(task, 'missing', { surface: 'web', opened: true }), /CONVERSATION_NOT_FOUND/);
  assert.throws(() => chat.setOpened(other, a.id, { surface: 'web', opened: true }), /CONVERSATION_NOT_FOUND/, 'a chat of another task cannot be opened through this one');
});

// The canUseTool callback Claude Code calls for every tool, as runTurn hands it to the SDK.
async function claudeCanUseTool(requestPermission) {
  let options;
  const sdk = { query: args => { options = args.options; return (async function* () { yield { type: 'result', subtype: 'success', is_error: false }; }()); } };
  await claude.runTurn({ cwd: '/w', mode: 'ask', prompt: { text: 'x' }, signal: new AbortController().signal, ctx: { upsert() {}, append() {}, getItem() {}, setSession() {} }, requestPermission, deps: { loadSdk: async () => sdk, executable: undefined } });
  return options;
}

test('Claude asks the person to choose: the questions reach the page with their options, and the picked answers go back as the SDK expects', async () => {
  const seen = [];
  let reply = { allow: true, answers: { 0: 'Red', 1: ['Caching', 'Dark mode', 'my own'] } };
  const options = await claudeCanUseTool(async request => { seen.push(request); return reply; });
  assert.equal('disallowedTools' in options, false, 'the agent may ask now');
  const input = { questions: [
    { question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool', preview: 'x'.repeat(5000) }] },
    { question: 'Which features?', header: 'Features', multiSelect: true, options: [{ label: 'Caching', description: '' }, { label: 'Dark mode', description: '' }] },
    { question: 'Unanswered?', header: 'Skip', options: [{ label: 'a', description: '' }, { label: 'b', description: '' }] },
  ] };
  const allowed = await options.canUseTool('AskUserQuestion', input, {});
  assert.deepEqual(allowed, { behavior: 'allow', updatedInput: { ...input, answers: { 'Which color?': 'Red', 'Which features?': 'Caching, Dark mode, my own' } } }, 'several picks are joined with ", "; a question without an answer is left out');
  const request = seen[0];
  assert.deepEqual([request.kind, request.tool, request.title], ['question', 'AskUserQuestion', 'Claude has a question']);
  assert.deepEqual(request.questions.map(question => [question.id, question.header, question.multiSelect, question.isOther]), [['0', 'Color', false, true], ['1', 'Features', true, true], ['2', 'Skip', false, true]]);
  assert.deepEqual(request.questions[0].options.map(option => option.label), ['Red', 'Blue']);
  assert.equal(request.questions[0].options[1].preview.length, 4000, 'a long preview is cut');
  assert.equal('preview' in request.questions[0].options[0], false);

  reply = { allow: false };
  assert.deepEqual(await options.canUseTool('AskUserQuestion', input, {}), { behavior: 'deny', message: 'The person skipped the question' });
  reply = { allow: true, answers: {} };
  assert.deepEqual((await options.canUseTool('AskUserQuestion', { questions: [] }, {})).updatedInput.answers, {}, 'no questions, no answers');
});

test('Claude proposes a plan: the plan text reaches the page, approving ends plan mode and declining sends the comments back', async () => {
  const seen = [];
  let reply = { allow: true };
  const options = await claudeCanUseTool(async request => { seen.push(request); return reply; });
  const input = { plan: '# Plan\n- step' };
  assert.deepEqual(await options.canUseTool('ExitPlanMode', input, {}), { behavior: 'allow', updatedInput: input });
  assert.deepEqual([seen[0].kind, seen[0].tool, seen[0].plan, seen[0].title], ['plan', 'ExitPlanMode', '# Plan\n- step', 'Review the plan']);
  reply = { allow: false, message: 'Use clang instead' };
  assert.deepEqual(await options.canUseTool('ExitPlanMode', input, {}), { behavior: 'deny', message: 'Use clang instead' });
  reply = { allow: false };
  assert.equal((await options.canUseTool('ExitPlanMode', input, {})).message, 'The person wants the plan revised');
  assert.equal(await options.canUseTool('ExitPlanMode', {}, {}).then(() => seen.at(-1).plan), '', 'no plan text is passed on as empty');
  // Other tools still go through the plain permission card.
  reply = { allow: true };
  assert.deepEqual(await options.canUseTool('Bash', { command: 'ls' }, { title: 'Run ls' }), { behavior: 'allow', updatedInput: { command: 'ls' } });
  assert.deepEqual([seen.at(-1).kind, seen.at(-1).tool, seen.at(-1).title], [undefined, 'Bash', 'Run ls']);
});

test('a plan to review reaches the client, and approving it leaves plan mode while declining does not', async () => {
  let release;
  const adapter = { ...fakeAdapter(async ({ requestPermission }) => { release = await requestPermission({ kind: 'plan', tool: 'ExitPlanMode', input: {}, plan: 'p'.repeat(70000), title: 'Review the plan' }); return { ok: true }; }), MODES: { ask: {}, plan: {} }, DEFAULT_MODE: 'ask' };
  const chat = createAgentChat({ db, adapters: { claude: adapter } });
  const conversation = chat.create(task, { agent: 'claude', mode: 'plan' });
  const seen = [];
  chat.subscribe(task, conversation.id, 0, event => seen.push(event));
  const pending = async () => { for (let i = 0; i < 200; i++) { const [request] = (await chat.snapshot(task, conversation.id)).pending; if (request) return request; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('no request'); };

  await chat.sendMessage(task, conversation.id, { text: 'plan it' });
  let request = await pending();
  assert.deepEqual([request.kind, request.tool, request.plan.length], ['plan', 'ExitPlanMode', 60000], 'the plan text is bounded');
  chat.answerPermission(task, conversation.id, request.id, { allow: false, message: 'more detail' });
  await wait(() => chat.list(task.id).find(row => row.id === conversation.id).running === false);
  assert.deepEqual([release.allow, release.message], [false, 'more detail']);
  assert.equal(chat.list(task.id).find(row => row.id === conversation.id).mode, 'plan', 'declining keeps the chat in plan mode');

  await chat.sendMessage(task, conversation.id, { text: 'again' });
  request = await pending();
  chat.answerPermission(task, conversation.id, request.id, { allow: true });
  await wait(() => chat.list(task.id).find(row => row.id === conversation.id).running === false);
  assert.equal(release.allow, true);
  assert.equal(chat.list(task.id).find(row => row.id === conversation.id).mode, 'ask', 'approving ends plan mode for the next messages');
  assert.equal(db.prepare('SELECT mode FROM agent_conversations WHERE id = ?').get(conversation.id).mode, 'ask');
  assert.ok(seen.some(event => event.op === 'meta' && event.mode === 'ask'), 'the page is told');
});
