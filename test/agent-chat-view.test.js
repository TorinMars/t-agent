const test = require('node:test');
const assert = require('node:assert/strict');

const load = async () => ({ ...(await import('../scripts/agent-chat/convert.mjs')), ...(await import('../scripts/agent-chat/store.mjs')) });

test('items become one user message per prompt and one assistant message per turn, in order', async () => {
  const { toMessages } = await load();
  const messages = toMessages([
    { id: 'u1', kind: 'user', text: 'hi', attachments: ['a.txt'] },
    { id: 'th', kind: 'thinking', text: 'plan' },
    { id: 'th2', kind: 'thinking', text: '' },
    { id: 't1', kind: 'tool', name: 'Bash', input: { command: 'ls' }, output: 'x', status: 'done' },
    { id: 't2', kind: 'tool', name: 'Bash', input: { command: 'sleep 9' }, output: '', status: 'running' },
    { id: 't3', kind: 'tool', name: 'Bash', input: 'raw', output: 'boom', status: 'error' },
    { id: 'm1', kind: 'text', text: 'done' },
    { id: 'e1', kind: 'error', text: 'failed' },
    { id: 'u2', kind: 'user', text: 'again' },
  ]);
  assert.deepEqual(messages.map(message => [message.role, message.content.length]), [['user', 2], ['assistant', 4], ['user', 1]]);
  assert.deepEqual(messages[0].content[1], { type: 'data', name: 'attachments', data: ['a.txt'] });
  const parts = messages[1].content;
  assert.deepEqual(parts.map(part => part.type), ['reasoning', 'data', 'text', 'data'], 'an empty thinking block is dropped, and the three calls are one group');
  assert.equal(parts[1].name, 'tools');
  const calls = parts[1].data.calls;
  assert.deepEqual(calls.map(call => [call.id, call.status, call.output]), [['t1', 'done', 'x'], ['t2', 'running', ''], ['t3', 'error', 'boom']], 'a running call has no output yet and a failed one keeps its message');
  assert.deepEqual(calls[2].args, { value: 'raw' }, 'a plain-text input still has object arguments');
  assert.equal(parts[1].id, 'tools-t1', 'the group keeps the id of its first call while more calls join it');
  assert.deepEqual(parts[3].data, { kind: 'error', text: 'failed' });
});

test('calls separated by text are separate groups, and a call that arrives later joins the group it follows', async () => {
  const { toMessages } = await load();
  const items = [
    { id: 'u', kind: 'user', text: 'go' },
    { id: 'a', kind: 'tool', name: 'Bash', input: {}, output: '', status: 'done' },
    { id: 'm', kind: 'text', text: 'then' },
    { id: 'b', kind: 'tool', name: 'Edit', input: {}, output: '', status: 'done' },
  ];
  const groups = toMessages(items)[1].content.filter(part => part.name === 'tools');
  assert.deepEqual(groups.map(group => group.data.calls.map(call => call.id)), [['a'], ['b']]);
  const more = toMessages([...items, { id: 'c', kind: 'tool', name: 'Edit', input: {}, output: '', status: 'running' }])[1].content.filter(part => part.name === 'tools');
  assert.deepEqual(more.map(group => group.data.calls.map(call => call.id)), [['a'], ['b', 'c']]);
});

test('a turn that produced nothing yet has no assistant message', async () => {
  const { toMessages } = await load();
  assert.deepEqual(toMessages([{ id: 'u', kind: 'user', text: 'hi' }]).map(message => message.role), ['user']);
});

function harness({ snapshot, answerFails = false } = {}) {
  const calls = [];
  const sources = [];
  class FakeSource {
    constructor(url) { this.url = url; this.listeners = {}; this.closed = false; sources.push(this); }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    close() { this.closed = true; }
    emit(event) { this.onmessage({ data: JSON.stringify(event) }); }
  }
  const api = {
    get: async url => { calls.push(['get', url]); return snapshot; },
    post: async (url, body) => { calls.push(['post', url, body]); if (answerFails && /permissions/.test(url)) throw new Error('GONE'); return {}; },
    patch: async (url, body) => { calls.push(['patch', url, body]); return {}; },
  };
  const notices = [];
  return { api, calls, sources, notices, options: { api, base: '/b', conversation: { id: 'c1', title: 'T', mode: 'ask' }, notify: message => notices.push(message), EventSourceImpl: FakeSource } };
}

test('the store loads the snapshot, follows events after its sequence number and ignores replayed ones', async () => {
  const { createChatStore } = await load();
  const { options, sources } = harness({ snapshot: { items: [{ id: 'm1', kind: 'text', text: 'Hel' }], pending: [{ id: 'p1', tool: 'Bash' }], status: 'running', seq: 5, capabilities: { steer: true } } });
  const store = createChatStore(options);
  await store.load();
  assert.equal(sources[0].url, '/b/conversations/c1/events?after=5');
  assert.deepEqual([store.getState().status, store.getState().canSteer, store.getState().pending.length], ['running', true, 1]);
  sources[0].emit({ seq: 5, op: 'append', id: 'm1', text: 'REPLAY' });
  sources[0].emit({ seq: 6, op: 'append', id: 'm1', text: 'lo' });
  sources[0].emit({ seq: 7, op: 'upsert', item: { id: 'm2', kind: 'text', text: 'next' } });
  sources[0].emit({ seq: 8, op: 'permission', request: { id: 'p1', tool: 'Bash' } });
  sources[0].emit({ seq: 9, op: 'permission', request: { id: 'p2', tool: 'Edit' } });
  sources[0].emit({ seq: 10, op: 'permission_done', id: 'p1' });
  sources[0].emit({ seq: 11, op: 'meta', title: 'Renamed', mode: 'full' });
  sources[0].emit({ seq: 12, op: 'status', status: 'idle' });
  const state = store.getState();
  assert.deepEqual(state.items.map(item => item.text), ['Hello', 'next']);
  assert.deepEqual(state.pending.map(request => request.id), ['p2'], 'a request is shown once and removed when answered');
  assert.deepEqual([state.title, state.mode, state.status], ['Renamed', 'full', 'idle']);
  store.destroy();
  assert.equal(sources[0].closed, true);
});

test('each update gives subscribers a new state object, and unsubscribing stops them', async () => {
  const { createChatStore } = await load();
  const { options, sources } = harness({ snapshot: { items: [], pending: [], status: 'idle', seq: 0 } });
  const store = createChatStore(options);
  await store.load();
  let count = 0;
  const off = store.subscribe(() => { count++; });
  const before = store.getState();
  sources[0].emit({ seq: 1, op: 'status', status: 'running' });
  assert.notEqual(store.getState(), before);
  off();
  sources[0].emit({ seq: 2, op: 'status', status: 'idle' });
  assert.equal(count, 1);
  store.destroy();
});

test('a failed answer keeps the request pending and tells the person; a second answer can follow', async () => {
  const { createChatStore } = await load();
  const { options, notices, calls } = harness({ snapshot: { items: [], pending: [{ id: 'p1' }], status: 'running', seq: 1 }, answerFails: true });
  const store = createChatStore(options);
  await store.load();
  assert.equal(await store.answer('p1', { allow: true }), false);
  assert.deepEqual(notices, ['Could not answer: GONE']);
  assert.equal(store.getState().pending.length, 1);
  assert.deepEqual(calls.at(-1), ['post', '/b/conversations/c1/permissions/p1', { allow: true }]);
  store.destroy();
});

test('sending maps a busy conversation to a plain notice, and the access level is updated only when the server accepts it', async () => {
  const { createChatStore } = await load();
  const { options, notices, api } = harness({ snapshot: { items: [], pending: [], status: 'idle', seq: 0 } });
  const store = createChatStore({ ...options, api: { ...api, post: async () => { throw new Error('CONVERSATION_BUSY'); } } });
  assert.equal(await store.send({ text: 'x' }), false);
  assert.deepEqual(notices, ['The agent is still working']);
  assert.equal(await store.setMode('plan'), true);
  assert.equal(store.getState().mode, 'plan');
  store.destroy();
});

test('an "Initialized session" item becomes a data part of the assistant message, with its details', async () => {
  const { toMessages } = await load();
  const messages = toMessages([{ id: 'u', kind: 'user', text: 'hi' }, { id: 'init:1', kind: 'init', text: 'Initialized session', details: [['Model', 'm']] }, { id: 'm', kind: 'text', text: 'ok' }]);
  assert.deepEqual(messages[1].content.map(part => part.type), ['data', 'text']);
  assert.deepEqual(messages[1].content[0].data, { text: 'Initialized session', details: [['Model', 'm']] });
  assert.deepEqual(toMessages([{ id: 'x', kind: 'init', text: 'Initialized session' }])[0].content[0].data.details, [], 'missing details are an empty list');
});

test('the model, the effort and how long the turn has run come from the snapshot and the events', async () => {
  const { createChatStore } = await load();
  const before = Date.now();
  const { options, sources } = harness({ snapshot: { items: [], pending: [], status: 'running', seq: 0, runningMs: 5000, conversation: { model: 'claude-sonnet-5-5', effort: 'high' } } });
  const store = createChatStore(options);
  await store.load();
  const state = store.getState();
  assert.deepEqual([state.model, state.effort], ['claude-sonnet-5-5', 'high']);
  assert.ok(state.runningSince <= Date.now() - 5000 && state.runningSince >= before - 5000, 'the start is counted back from the server\'s elapsed time');
  sources[0].emit({ seq: 1, op: 'meta', model: 'gpt-fake' });
  assert.deepEqual([store.getState().model, store.getState().effort], ['gpt-fake', 'high']);
  sources[0].emit({ seq: 2, op: 'status', status: 'idle', ok: true });
  assert.equal(store.getState().runningSince, null);
  sources[0].emit({ seq: 3, op: 'status', status: 'running', runningMs: 0 });
  assert.ok(Math.abs(store.getState().runningSince - Date.now()) < 1000);
});

test('queued messages wait for the turn: the next one is sent when it ends normally or the person stops it, and kept after a failure', async () => {
  const { createChatStore } = await load();
  const { options, sources, calls } = harness({ snapshot: { items: [], pending: [], status: 'running', seq: 0 } });
  const store = createChatStore(options);
  await store.load();
  store.enqueue({ text: 'first   queued\nmessage', images: [], files: [] });
  store.enqueue({ text: '', images: [{ name: 'a.png' }], files: [{ name: 'b.txt' }] });
  store.enqueue({ text: 'third' });
  assert.deepEqual(store.getState().queue.map(entry => entry.label), ['first queued message', 'a.png, b.txt', 'third']);
  const sent = () => calls.filter(call => call[0] === 'post' && /\/messages$/.test(call[1])).map(call => call[2].text);
  assert.deepEqual(sent(), [], 'nothing is sent while the turn runs');

  sources[0].emit({ seq: 1, op: 'status', status: 'idle', ok: false }); // a failure
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.getState().queue.length, 3, 'a failed turn does not send the queue by itself');

  sources[0].emit({ seq: 2, op: 'status', status: 'running' });
  await store.stop(); // the person presses Stop
  assert.ok(calls.some(call => call[0] === 'post' && /\/interrupt$/.test(call[1])));
  sources[0].emit({ seq: 3, op: 'status', status: 'idle', ok: false }); // the stopped turn ends
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent(), ['first   queued\nmessage'], 'the turn the person stopped goes on with the queue');
  assert.equal(store.getState().queue.length, 2);

  sources[0].emit({ seq: 4, op: 'status', status: 'idle', ok: false }); // the next turn fails (without a stop)
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent().length, 1, 'the stop was for one turn only');

  sources[0].emit({ seq: 5, op: 'status', status: 'idle', ok: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent().length, 2);
  assert.equal(store.getState().queue.length, 1);
  sources[0].emit({ seq: 6, op: 'status', status: 'idle', ok: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.getState().queue.length, 0);
  assert.equal(sent().length, 3, 'one queued message per finished turn');
});

test('Stop when nothing runs, or when the server refuses, does not make the next failure send the queue', async () => {
  const { createChatStore } = await load();
  const { options, sources, calls, notices } = harness({ snapshot: { items: [], pending: [], status: 'idle', seq: 0 } });
  options.api.post = async (url, body) => { calls.push(['post', url, body]); if (/interrupt/.test(url)) return { success: true, running: false }; return {}; };
  const store = createChatStore(options);
  await store.load();
  store.enqueue({ text: 'waiting' });
  await store.stop();
  sources[0].emit({ seq: 1, op: 'status', status: 'idle', ok: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.getState().queue.length, 1, 'the stop found nothing to stop');
  options.api.post = async () => { throw new Error('down'); };
  await store.stop();
  assert.ok(notices.some(message => /Could not stop/.test(message)));
  sources[0].emit({ seq: 2, op: 'status', status: 'idle', ok: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.getState().queue.length, 1, 'a refused stop does not count');
});

test('a queued message can be removed or sent now, and one the server refuses stays queued', async () => {
  const { createChatStore } = await load();
  const { options, notices } = harness({ snapshot: { items: [], pending: [], status: 'idle', seq: 0 } });
  let refuse = true;
  options.api.post = async () => { if (refuse) throw new Error('CONVERSATION_BUSY'); return {}; };
  const store = createChatStore(options);
  await store.load();
  store.enqueue({ text: 'a' });
  store.enqueue({ text: 'b' });
  store.unqueue(store.getState().queue[1].id);
  assert.deepEqual(store.getState().queue.map(entry => entry.label), ['a']);
  assert.equal(await store.sendQueued(store.getState().queue[0].id), false);
  assert.deepEqual(store.getState().queue.map(entry => entry.label), ['a'], 'a refused message stays queued');
  assert.deepEqual(notices, ['The agent is still working']);
  refuse = false;
  assert.equal(await store.sendQueued(store.getState().queue[0].id), true);
  assert.equal(store.getState().queue.length, 0);
});

test('renaming the chat goes to the server, and a failure is reported', async () => {
  const { createChatStore } = await load();
  const { options, calls, notices } = harness({ snapshot: { items: [], pending: [], status: 'idle', seq: 0 } });
  const store = createChatStore(options);
  assert.equal(await store.rename('New name'), true);
  assert.deepEqual(calls.find(call => call[0] === 'patch'), ['patch', '/b/conversations/c1', { title: 'New name' }]);
  options.api.patch = async () => { throw new Error('nope'); };
  assert.equal(await store.rename('x'), false);
  assert.match(notices[0], /Could not rename the chat: nope/);
});

test('the context use comes from the snapshot and follows meta events; nothing is invented when it is unknown', async () => {
  const { createChatStore } = await load();
  const unknown = harness({ snapshot: { items: [], pending: [], status: 'idle', seq: 0, conversation: {} } });
  const empty = createChatStore(unknown.options);
  await empty.load();
  assert.deepEqual([empty.getState().context, empty.getState().model, empty.getState().effort], [null, '', '']);

  const { options, sources } = harness({ snapshot: { items: [], pending: [], status: 'idle', seq: 0, conversation: { model: 'gpt-fake', effort: 'high', context: { used: 10, window: 100 } } } });
  const store = createChatStore(options);
  assert.equal(store.getState().context, null);
  await store.load();
  assert.deepEqual(store.getState().context, { used: 10, window: 100 });
  sources[0].emit({ seq: 1, op: 'meta', context: { used: 80, window: 100 } });
  assert.deepEqual([store.getState().context, store.getState().model, store.getState().effort], [{ used: 80, window: 100 }, 'gpt-fake', 'high'], 'a context update leaves the model and effort alone');
  sources[0].emit({ seq: 2, op: 'meta', title: 'Renamed' });
  assert.deepEqual(store.getState().context, { used: 80, window: 100 }, 'an unrelated meta event keeps it');

  const fromRow = createChatStore({ ...options, conversation: { id: 'c1', title: 'T', mode: 'ask', model: 'm', effort: 'e', context: { used: 1, window: 2 } } });
  assert.deepEqual([fromRow.getState().model, fromRow.getState().context], ['m', { used: 1, window: 2 }], 'a chat row from the list already carries them');
});

test('durations use a single unit with at most one decimal, and percentages drop a trailing .0', async () => {
  const { duration, num, limitText, visibleLimits, modelName, tokens } = await import('../scripts/agent-chat/format.mjs');
  const H = 3600000;
  assert.deepEqual([30000, 0.5 * 60000, 35 * 60000, 59.96 * 60000, 1 * H, 1.5 * H, 4.2 * H, 23.4 * H, 24 * H, 60 * H, 166.9 * H].map(duration), ['<1m', '<1m', '35m', '60m', '1h', '1.5h', '4.2h', '23.4h', '1d', '2.5d', '7d']);
  assert.deepEqual([2, 4.25, 4.2, 62.5, 0, 99.96].map(num), ['2', '4.3', '4.2', '62.5', '0', '100']);
  const now = 1000000;
  assert.deepEqual(limitText({ label: '5h', usedPercent: 37.5, resetsAt: now + 4.2 * H }, now), { left: '62.5', reset: '4.2h', text: '62.5% · 4.2h' });
  assert.equal(limitText({ label: '7d', usedPercent: 20, resetsAt: now + 3.5 * 24 * H }, now).text, '80% · 3.5d');
  assert.equal(limitText({ label: '5h', usedPercent: 120, resetsAt: null }, now).text, '0%', 'over the limit is 0% left, and no reset time is not invented');
  assert.deepEqual(visibleLimits([{ id: 'a', resetsAt: now - 1 }, { id: 'b', resetsAt: now + 1 }, { id: 'c', resetsAt: null }, { id: 'd' }], now).map(entry => entry.id), ['b', 'c', 'd'], 'a window that has reset is not shown');
  assert.deepEqual(visibleLimits(undefined, now), []);
  assert.deepEqual(['claude-sonnet-5-5', 'claude-opus-4-1-20250805', 'sonnet', 'gpt-6.1-sol', '', undefined].map(modelName), ['Sonnet 5.5', 'Opus 4.1', 'Sonnet', 'gpt-6.1-sol', '', '']);
  assert.deepEqual([999, 1000, 43502, 258400, 1000000, 1450000].map(tokens), ['999', '1k', '44k', '258k', '1M', '1.5M']);
});

test('the model list is read once per open picker, the choice is saved and shown, and a failure can be retried', async () => {
  const { createChatStore } = await load();
  const offered = [{ value: '', label: 'Default', efforts: ['low', 'high'] }, { value: 'a', label: 'A', efforts: ['low'] }];
  const { options, calls, notices } = harness({ snapshot: { items: [], pending: [], status: 'idle', seq: 0, capabilities: { models: true }, conversation: {} } });
  let fail = true;
  options.api.get = async url => { calls.push(['get', url]); if (/\/models$/.test(url)) { if (fail) throw new Error('down'); return { models: offered, chosen: { model: 'a', effort: 'low' } }; } return { items: [], pending: [], status: 'idle', seq: 0, capabilities: { models: true }, conversation: {} }; };
  options.api.patch = async (url, body) => { calls.push(['patch', url, body]); return { model: body.model || undefined, effort: body.effort || undefined }; };
  const store = createChatStore(options);
  await store.load();
  assert.equal(store.getState().canChoose, true);
  assert.equal(store.getState().models.status, 'idle');
  await store.loadModels();
  assert.equal(store.getState().models.status, 'error', 'the failure is shown, not hidden');
  fail = false;
  await store.loadModels();
  assert.deepEqual([store.getState().models.status, store.getState().models.list.length, store.getState().choice], ['ready', 2, { model: 'a', effort: 'low' }]);
  await store.loadModels();
  assert.equal(calls.filter(call => /\/models$/.test(call[1])).length, 2, 'a loaded list is not read again');

  assert.equal(await store.choose({ model: '', effort: 'high' }), true);
  assert.deepEqual(calls.find(call => call[0] === 'patch'), ['patch', '/b/conversations/c1', { model: '', effort: 'high' }]);
  assert.deepEqual([store.getState().model, store.getState().effort, store.getState().choice], ['', 'high', { model: '', effort: 'high' }]);
  options.api.patch = async () => { throw new Error('INVALID_MODEL'); };
  assert.equal(await store.choose({ model: 'x' }), false);
  assert.deepEqual(notices.at(-1), 'Could not change the model: INVALID_MODEL');
  assert.equal(store.getState().choice.model, '', 'a refused choice changes nothing');
});

test('a meta event can clear the model and effort, and the plan limits replace the old ones', async () => {
  const { createChatStore } = await load();
  const { options, sources } = harness({ snapshot: { items: [], pending: [], status: 'idle', seq: 0, conversation: { model: 'm', effort: 'high', limits: [{ id: '5h', label: '5h', usedPercent: 1, resetsAt: null }] } } });
  const store = createChatStore(options);
  await store.load();
  assert.deepEqual([store.getState().model, store.getState().limits.length], ['m', 1]);
  sources[0].emit({ seq: 1, op: 'meta', model: '', effort: '' });
  assert.deepEqual([store.getState().model, store.getState().effort], ['', ''], 'an empty value clears it');
  sources[0].emit({ seq: 2, op: 'meta', context: { used: 1, window: 2 } });
  assert.deepEqual([store.getState().model, store.getState().effort], ['', ''], 'an event without them leaves them alone');
  sources[0].emit({ seq: 3, op: 'meta', limits: [{ id: '5h', label: '5h', usedPercent: 50, resetsAt: null }, { id: '7d', label: '7d', usedPercent: 5, resetsAt: null }] });
  assert.deepEqual(store.getState().limits.map(entry => [entry.id, entry.usedPercent]), [['5h', 50], ['7d', 5]]);
});

test('the folded line of a group says what ran, or what is running, and how many failed', async () => {
  const { groupLabel, callBrief } = await import('../scripts/agent-chat/format.mjs');
  const call = (name, status = 'done', args = {}) => ({ name, status, args });
  assert.deepEqual(groupLabel([call('Bash')]), { text: 'Ran 1 command', failed: 0, running: false });
  assert.equal(groupLabel([call('Bash'), call('Shell'), call('Bash')]).text, 'Ran 3 commands');
  assert.equal(groupLabel([call('Edit')]).text, 'Edited 1 file');
  assert.equal(groupLabel([call('Edit'), call('Write')]).text, 'Edited 2 files');
  assert.equal(groupLabel([call('Read')]).text, 'Used 1 tool');
  assert.equal(groupLabel([call('Bash'), call('Edit')]).text, 'Used 2 tools', 'a mix is just tools');
  assert.deepEqual(groupLabel([call('Bash'), call('Bash', 'error'), call('Bash', 'error')]), { text: 'Ran 3 commands', failed: 2, running: false });
  assert.deepEqual(groupLabel([call('Bash'), call('Bash', 'running', { command: 'make test\nmore' })]), { text: '1 running · 1 finished', failed: 0, running: true }, 'only the counts show while a call runs, not the command');
  assert.equal(groupLabel([call('Bash', 'running'), call('Bash', 'running'), call('Bash')]).text, '2 running · 1 finished');
  assert.equal(callBrief({ file_path: '/a/b.js', old_string: 'x' }), '/a/b.js');
  assert.equal(callBrief({}), '');
  assert.equal(callBrief('raw'), '');
});

test('the changes of an edit are shown as lines to review: Codex diffs, Claude edits and writes', async () => {
  const { diffLines } = await import('../scripts/agent-chat/format.mjs');
  const kinds = lines => lines.map(line => `${line.type}:${line.text}`);
  assert.deepEqual(kinds(diffLines({ file_path: '/a.txt', old_string: 'one\ntwo\nthree', new_string: 'one\n2\nthree' })), ['file:/a.txt', 'ctx:one', 'del:two', 'add:2', 'ctx:three']);
  assert.deepEqual(kinds(diffLines({ file_path: '/a.txt', old_string: '', new_string: 'new' })), ['file:/a.txt', 'add:new'], 'an insertion has nothing removed');
  assert.deepEqual(kinds(diffLines({ file_path: '/a.txt', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] })), ['file:/a.txt', 'hunk:…', 'del:a', 'add:b', 'hunk:…', 'del:c', 'add:d']);
  assert.deepEqual(kinds(diffLines({ file_path: '/n.txt', content: 'x\ny\n' })), ['file:/n.txt', 'add:x', 'add:y'], 'a written file is all added');
  assert.deepEqual(kinds(diffLines({ changes: [{ path: 'x.js', kind: 'update', diff: '@@ -1,2 +1,2 @@\n-old\n+new\n same' }, { path: 'n.js', kind: 'add', diff: 'whole file' }] })),
    ['file:x.js (update)', 'hunk:@@ -1,2 +1,2 @@', 'del:old', 'add:new', 'ctx: same', 'file:n.js (add)', 'add:whole file']);
  for (const other of [null, undefined, 'text', {}, { command: 'ls' }, { changes: [] }, { changes: [{ nopath: 1 }] }, { file_path: '/a' }]) assert.equal(diffLines(other), null);
  const big = diffLines({ file_path: '/big', content: Array.from({ length: 1000 }, (_, index) => `line ${index}`).join('\n') });
  assert.equal(big.length, 401, 'a long diff is cut, and says how much is left');
  assert.deepEqual(big.at(-1), { type: 'hunk', text: '… 601 more lines' });
});

test('a warning notice keeps its level so the view can style it apart from a plain notice', async () => {
  const { toMessages } = await load();
  const [message] = toMessages([
    { id: 'w1', kind: 'notice', level: 'warn', text: 'Under-development features enabled' },
    { id: 'n1', kind: 'notice', text: 'Stopped' },
  ]);
  const notices = message.content.filter(part => part.name === 'notice').map(part => part.data);
  assert.deepEqual(notices.map(data => data.level), ['warn', undefined]);
  assert.deepEqual(notices.map(data => data.kind), ['notice', 'notice']);
});


test('translation prepares only the message text on the Client before remote send or queue', async () => {
  const { createChatStore } = await load();
  const h = harness();
  h.options.base = '/api/remote-servers/7/tasks/2/agent';
  h.options.api.post = async (url, body) => {
    h.calls.push(['post', url, body]);
    return url === '/api/translate' ? { text: 'Fix the issue\nKeep `a.js`.' } : {};
  };
  const store = createChatStore(h.options);
  const body = { text: '\u4fee\u590d\u95ee\u9898', images: [{ name: 'a.png', data: 'raw' }], files: [{ name: 'a.js', text: 'original' }] };
  assert.equal(await store.prepareMessage(body, false), body);
  assert.equal(h.calls.length, 0, 'disabled translation makes no request');
  const prepared = await store.prepareMessage(body, true);
  assert.deepEqual(h.calls[0], ['post', '/api/translate', { text: body.text }]);
  assert.equal(prepared.text, 'Fix the issue\nKeep `a.js`.');
  assert.equal(prepared.images, body.images);
  assert.equal(prepared.files, body.files);
  assert.equal(body.text, '\u4fee\u590d\u95ee\u9898', 'the draft is unchanged');
  store.enqueue(prepared);
  await store.sendQueued(store.getState().queue[0].id);
  assert.deepEqual(h.calls[1], ['post', '/api/remote-servers/7/tasks/2/agent/conversations/c1/messages', prepared]);
  assert.equal(h.calls.filter(call => !/\/queue$/.test(call[1])).length, 2, 'sending a queued message does not translate it again (the saves of the queue are not messages)');
  const empty = { text: '', images: body.images };
  assert.equal(await store.prepareMessage(empty, true), empty, 'image-only messages bypass translation');
  store.destroy();
});

test('failed, empty or unfinished translation never sends a message', async () => {
  const { createChatStore } = await load();
  for (const result of [null, { text: '' }, { text: '   ' }, { text: 7 }]) {
    const h = harness();
    h.options.api.post = async () => result;
    const store = createChatStore(h.options);
    await assert.rejects(store.prepareMessage({ text: 'source' }, true), /Translation result is empty/);
    assert.equal(h.calls.length, 0);
    store.destroy();
  }
  const h = harness();
  h.options.api.post = async () => { throw new Error('Translation timed out; please retry'); };
  const store = createChatStore(h.options);
  await assert.rejects(store.prepareMessage({ text: 'source' }, true), /Translation timed out/);
  let resolve;
  h.options.api.post = () => new Promise(done => { resolve = done; });
  const pending = store.prepareMessage({ text: 'source' }, true);
  store.destroy();
  resolve({ text: 'translated' });
  assert.equal(await pending, null, 'closing a chat during translation cancels dispatch');
});

test('the translation switch comes with the chat, moves at once, is saved, follows another page, and goes back when it cannot be saved', async () => {
  const { createChatStore } = await load();
  const { options, calls, notices, sources } = harness({ snapshot: { items: [], pending: [], status: 'idle', seq: 0, conversation: { translate: true } } });
  options.conversation = { ...options.conversation, translate: false };
  const store = createChatStore(options);
  assert.equal(store.getState().translate, false, 'the row the chat was opened with');
  await store.load();
  assert.equal(store.getState().translate, true, 'the saved state arrives with the snapshot');

  options.api.patch = async (url, body) => { calls.push(['patch', url, body]); return {}; };
  const turnedOff = store.setTranslate(false);
  assert.equal(store.getState().translate, false, 'it moves before the server answers');
  assert.equal(await turnedOff, true);
  assert.deepEqual(calls.filter(call => call[0] === 'patch').at(-1), ['patch', '/b/conversations/c1', { translate: false }]);

  sources[0].emit({ seq: 1, op: 'meta', translate: true });
  assert.equal(store.getState().translate, true, 'another page turned it on');

  options.api.patch = async () => { throw new Error('nope'); };
  assert.equal(await store.setTranslate(false), false);
  assert.equal(store.getState().translate, true, 'it goes back');
  assert.ok(notices.some(message => /translation switch/.test(message)));
  store.dispose && store.dispose();
});

test('the queue is kept on the server: it comes back with the chat, every change is saved in order, and a failure is shown once', async () => {
  const { createChatStore } = await load();
  const saved = [];
  const first = harness({ snapshot: { items: [], pending: [], status: 'running', seq: 0, queue: [{ id: 4, label: 'from before', body: { text: 'from before' } }] } });
  first.options.api.post = async (url, body) => { first.calls.push(['post', url, body]); if (/\/queue$/.test(url)) saved.push(body.queue.map(entry => entry.id)); return {}; };
  const store = createChatStore(first.options);
  await store.load();
  assert.deepEqual(store.getState().queue.map(entry => entry.label), ['from before'], 'a refresh gets the queue back');
  store.enqueue({ text: 'next' });
  assert.deepEqual(store.getState().queue.map(entry => entry.id), [4, 5], 'new ids go on after the saved ones');
  store.unqueue(4);
  store.enqueue({ text: 'last' });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(saved, [[4, 5], [5], [5, 6]], 'each change saves the whole list, in order');
  assert.equal(first.calls.filter(call => call[0] === 'post' && /\/queue$/.test(call[1]))[0][2].queue[1].body.text, 'next', 'with the message itself');

  // What this page already changed is newer than what a reload of the chat brings.
  await store.load();
  assert.deepEqual(store.getState().queue.map(entry => entry.id), [5, 6]);

  const broken = harness({ snapshot: { items: [], pending: [], status: 'running', seq: 0 } });
  broken.options.api.post = async () => { throw new Error('down'); };
  const other = createChatStore(broken.options);
  await other.load();
  other.enqueue({ text: 'a' });
  other.enqueue({ text: 'b' });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(broken.notices.filter(message => /queued messages/.test(message)).length, 1, 'shown once');
  assert.equal(other.getState().queue.length, 2, 'the page keeps the queue anyway');
});

test('a queued message can be edited (its attachments stay), and cannot be emptied', async () => {
  const { createChatStore } = await load();
  const saved = [];
  const { options } = harness({ snapshot: { items: [], pending: [], status: 'running', seq: 0 } });
  options.api.post = async (url, body) => { if (/\/queue$/.test(url)) saved.push(body.queue.map(entry => [entry.id, entry.label, entry.body.text])); return {}; };
  const store = createChatStore(options);
  await store.load();
  store.enqueue({ text: 'old', images: [], files: [] });
  store.enqueue({ text: '', images: [{ name: 'a.png', type: 'image/png', data: 'x' }], files: [] });
  assert.equal(store.editQueued(1, '  new   text  '), true);
  assert.deepEqual(store.getState().queue.map(entry => [entry.label, entry.body.text]), [['new text', 'new   text'], ['a.png', '']], 'trimmed, and the label follows');
  assert.equal(store.editQueued(1, '   '), false, 'a message with nothing left is refused');
  assert.equal(store.getState().queue[0].body.text, 'new   text', 'and stays as it was');
  assert.equal(store.editQueued(2, ''), true, 'one with an attachment may lose its text');
  assert.equal(store.editQueued(2, 'with words'), true);
  assert.equal(store.getState().queue[1].body.images.length, 1, 'the attachment is kept');
  assert.equal(store.editQueued(99, 'x'), false, 'an unknown message');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(saved.at(-1), [[1, 'new text', 'new   text'], [2, 'with words', 'with words']], 'the edit is saved with the queue');
});

test('a queued message can be force-sent: a running agent that cannot take input is stopped and the chosen message goes first; one that can takes it at once', async () => {
  const { createChatStore } = await load();
  const posts = calls => calls.filter(call => call[0] === 'post').map(call => (/\/messages$/.test(call[1]) ? `message:${call[2].text}` : /\/interrupt$/.test(call[1]) ? 'interrupt' : null)).filter(Boolean);

  // An agent that cannot take input mid-turn.
  const plain = harness({ snapshot: { items: [], pending: [], status: 'running', seq: 0 } });
  const store = createChatStore(plain.options);
  await store.load();
  store.enqueue({ text: 'first' });
  store.enqueue({ text: 'urgent' });
  assert.equal(await store.forceSend(2), true);
  assert.deepEqual(posts(plain.calls), ['interrupt'], 'it is stopped first; the message is not sent into the running turn');
  assert.equal(store.getState().queue.length, 2, 'and stays queued until then');
  plain.sources[0].emit({ seq: 1, op: 'status', status: 'idle', ok: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(posts(plain.calls), ['interrupt', 'message:urgent'], 'the chosen message goes out when the turn has ended, not the head of the queue');
  assert.deepEqual(store.getState().queue.map(entry => entry.label), ['first'], 'the rest waits');
  plain.sources[0].emit({ seq: 2, op: 'status', status: 'idle', ok: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posts(plain.calls).length, 2, 'a later failed turn sends nothing: the force was for one message');

  // An agent that can: the message goes into the running turn, nothing is stopped.
  const steer = harness({ snapshot: { items: [], pending: [], status: 'running', seq: 0, capabilities: { steer: true } } });
  const steered = createChatStore(steer.options);
  await steered.load();
  steered.enqueue({ text: 'now' });
  assert.equal(await steered.forceSend(1), true);
  assert.deepEqual(posts(steer.calls), ['message:now']);

  // Nothing is running (the page was behind): it is sent at once.
  const late = harness({ snapshot: { items: [], pending: [], status: 'running', seq: 0 } });
  late.options.api.post = async (url, body) => { late.calls.push(['post', url, body]); return /interrupt/.test(url) ? { success: true, running: false } : {}; };
  const behind = createChatStore(late.options);
  await behind.load();
  behind.enqueue({ text: 'go' });
  assert.equal(await behind.forceSend(1), true);
  assert.deepEqual(posts(late.calls), ['interrupt', 'message:go'].filter(Boolean));

  // The stop is refused: nothing is sent, and the message stays queued.
  const refused = harness({ snapshot: { items: [], pending: [], status: 'running', seq: 0 } });
  refused.options.api.post = async () => { throw new Error('down'); };
  const failing = createChatStore(refused.options);
  await failing.load();
  failing.enqueue({ text: 'stuck' });
  assert.equal(await failing.forceSend(1), false);
  assert.equal(failing.getState().queue.length, 1);
  refused.sources[0].emit({ seq: 1, op: 'status', status: 'idle', ok: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failing.getState().queue.length, 1, 'a refused stop leaves no force behind');
  assert.equal(await failing.forceSend(42), false, 'an unknown message');
});

test('the store reports a turn that ended while the page watched, and whether the person stopped it', async () => {
  const { createChatStore } = await load();
  const { options, sources } = harness({ snapshot: { items: [{ id: 'm1', kind: 'text', text: 'All done.' }], pending: [], status: 'idle', seq: 0 } });
  const store = createChatStore(options);
  await store.load();
  assert.equal(store.getState().lastTurn, null);
  sources[0].emit({ seq: 1, op: 'status', status: 'idle', ok: true });
  assert.equal(store.getState().lastTurn, null, 'idle without a turn running here is not an ended turn');

  sources[0].emit({ seq: 2, op: 'status', status: 'running' });
  sources[0].emit({ seq: 3, op: 'status', status: 'idle', ok: true });
  assert.deepEqual(store.getState().lastTurn, { n: 1, ok: true, stopped: false });

  sources[0].emit({ seq: 4, op: 'status', status: 'running' });
  sources[0].emit({ seq: 5, op: 'status', status: 'idle', ok: false });
  assert.deepEqual(store.getState().lastTurn, { n: 2, ok: false, stopped: false }, 'a failure');

  sources[0].emit({ seq: 6, op: 'status', status: 'running' });
  await store.stop();
  sources[0].emit({ seq: 7, op: 'status', status: 'idle', ok: false });
  assert.deepEqual(store.getState().lastTurn, { n: 3, ok: false, stopped: true }, 'the person stopped it');
});

test('the slash commands are read once in the background when the agent has them, can be retried, and /clear empties the chat', async () => {
  const { createChatStore } = await load();
  const reads = [];
  let fail = true;
  const withCommands = harness({ snapshot: { items: [{ id: 'm1', kind: 'text', text: 'before' }], pending: [], status: 'idle', seq: 0, capabilities: { commands: true } } });
  const baseGet = withCommands.options.api.get;
  withCommands.options.api.get = async url => {
    if (/\/commands$/.test(url)) { reads.push(url); if (fail) throw new Error('down'); return { supported: true, commands: [{ name: 'clear', description: 'new', argumentHint: '' }] }; }
    return baseGet(url);
  };
  const store = createChatStore(withCommands.options);
  assert.deepEqual([store.getState().commandsSupported, store.getState().commands.status], [false, 'idle']);
  await store.load();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.getState().commandsSupported, true);
  assert.equal(store.getState().commands.status, 'error', 'a failure is shown, not hidden');
  fail = false;
  await store.loadCommands();
  assert.deepEqual([store.getState().commands.status, store.getState().commands.list.map(command => command.name)], ['ready', ['clear']]);
  await store.loadCommands();
  assert.equal(reads.length, 2, 'a list that is loaded is not read again');

  assert.equal(store.getState().items.length, 1);
  withCommands.sources[0].emit({ seq: 1, op: 'reset' });
  assert.equal(store.getState().items.length, 0, 'the chat starts again from nothing');
  withCommands.sources[0].emit({ seq: 2, op: 'upsert', item: { id: 'n1', kind: 'notice', text: 'Started a new session' } });
  assert.deepEqual(store.getState().items.map(item => item.text), ['Started a new session']);

  const plain = harness({ snapshot: { items: [], pending: [], status: 'idle', seq: 0 } });
  const without = createChatStore(plain.options);
  await without.load();
  assert.deepEqual([without.getState().commandsSupported, plain.calls.some(call => /commands/.test(call[1] || ''))], [false, false], 'an agent without commands is not asked');
});

test('a slash command is not translated, other text that starts with a slash is', async () => {
  const { createChatStore } = await load();
  const h = harness();
  h.options.api.post = async (url, body) => { h.calls.push(['post', url, body]); return url === '/api/translate' ? { text: 'translated' } : {}; };
  const store = createChatStore(h.options);
  for (const text of ['/clear', '/compact keep the plan', '/code-review --fix', '/fewer-permission-prompts']) {
    const body = { text };
    assert.equal(await store.prepareMessage(body, true), body, `${text} is sent as it is`);
  }
  assert.equal(h.calls.length, 0, 'nothing was translated');
  assert.equal((await store.prepareMessage({ text: '/usr/bin is missing' }, true)).text, 'translated', 'a path is prose');
  assert.equal((await store.prepareMessage({ text: 'run /clear please' }, true)).text, 'translated', 'only a message that starts with the command');
});
