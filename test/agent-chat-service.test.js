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

test('Codex events become items, and a turn resumes a thread with the chosen sandbox', async () => {
  const ctx = collector();
  const normalizer = codex.createNormalizer(ctx);
  normalizer.handle({ type: 'thread.started', thread_id: 't-1' });
  normalizer.handle({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'echo ok', aggregated_output: '', status: 'in_progress' } });
  normalizer.handle({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'echo ok', aggregated_output: 'ok\n', exit_code: 0, status: 'completed' } });
  normalizer.handle({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'done' } });
  normalizer.handle({ type: 'item.completed', item: { id: 'i3', type: 'command_execution', command: 'false', aggregated_output: '', exit_code: 1, status: 'completed' } });
  assert.deepEqual([ctx.items.get('i1').status, ctx.items.get('i1').output, ctx.items.get('i2').text, ctx.items.get('i3').status], ['done', 'ok\n', 'done', 'error']);
  assert.equal(normalizer.handle({ type: 'turn.failed', error: { message: 'boom' } }).error, 'boom');

  const started = [];
  class Codex {
    startThread(options) { started.push(['start', options]); return this.thread(null); }
    resumeThread(id, options) { started.push(['resume', id, options]); return this.thread(id); }
    thread(id) { return { id, runStreamed: async input => { started.push(['input', input]); return { events: (async function* () { yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }; }()) }; } }; }
  }
  const outcome = await codex.runTurn({ cwd: '/w', sessionId: 't-old', mode: 'readonly', prompt: { text: 'go', images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }] }, signal: new AbortController().signal, ctx: collector(), deps: { loadSdk: async () => ({ Codex }) } });
  assert.equal(outcome.ok, true);
  assert.deepEqual(started[0], ['resume', 't-old', { workingDirectory: '/w', skipGitRepoCheck: true, approvalPolicy: 'never', sandboxMode: 'read-only' }]);
  assert.equal(started[1][1][1].type, 'local_image');
  assert.equal(fs.existsSync(started[1][1][1].path), false, 'the temporary image is removed after the turn');
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
