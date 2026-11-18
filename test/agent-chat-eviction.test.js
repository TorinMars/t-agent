// Idle chats leave the memory (services/agent-chat.js `evictIdle`) and load again as a chat that was never opened; a chat that still has something
// only the memory holds stays. Fake adapters only: no agent is started.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-chat-evict-'));
process.env.T_AGENT_DATA_DIR = root;
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
const db = require('../db');
const tasks = require('../services/engine-tasks');
const { createAgentChat } = require('../services/agent-chat');

const task = tasks.createTask('owner', { title: 'eviction' });
test.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

const IDLE = 10 * 60 * 1000;
const wait = async condition => { for (let i = 0; i < 400 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(condition(), 'timed out'); };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

// An adapter with sessions that are kept outside the service, as an agent keeps its session file: what a turn says is recorded there, and
// loadHistory reads it back. `loads` counts the readings (the expensive call a chat in memory saves).
function sessionAdapter(script = async () => ({ ok: true })) {
  const sessions = new Map(); // session id -> items
  const adapter = {
    MODES: { ask: {}, full: {} }, DEFAULT_MODE: 'ask', sessions, loads: [], calls: [],
    record(sessionId, item) { sessions.set(sessionId, [...(sessions.get(sessionId) || []), item]); },
    loadHistory: async ({ sessionId }) => { adapter.loads.push(sessionId); return (sessions.get(sessionId) || []).map(item => ({ ...item })); },
    loadMeta: async () => ({ model: 'model-from-session', context: { used: 1200, window: 200000 } }),
    runTurn: async args => { adapter.calls.push(args); return script(args, adapter); },
  };
  return adapter;
}

// A service on a clock the test moves; nothing is swept by a timer unless the test asks for one.
function service(adapter, extra = {}) {
  const clock = { now: 5000000 };
  const chat = createAgentChat({ db, adapters: { claude: adapter, codex: adapter }, idleMs: IDLE, sweepMs: 0, now: () => clock.now, ...extra });
  return { chat, clock };
}
const view = snapshot => ({ ...snapshot, seq: null }); // the event number is the only thing that tells a chat built again from one never opened

test('an idle chat leaves the memory after the idle time, and loads again exactly as a chat that was never opened', async () => {
  // A turn answers and records both sides in the session, as Claude Code and Codex do.
  const adapter = sessionAdapter(async ({ ctx, prompt }, self) => {
    ctx.setSession('sess-evict-0001');
    self.record('sess-evict-0001', { id: 'user:1', kind: 'user', text: prompt.display, at: 1700000000000 });
    ctx.upsert({ id: 'msg:0', kind: 'text', text: 'Hello', at: 1700000001000 });
    ctx.upsert({ id: 'tool-1', kind: 'tool', name: 'Bash', input: { command: 'ls' }, output: 'a.txt', status: 'done', at: 1700000002000 });
    self.record('sess-evict-0001', { id: 'msg:0', kind: 'text', text: 'Hello', at: 1700000001000 });
    self.record('sess-evict-0001', { id: 'tool-1', kind: 'tool', name: 'Bash', input: { command: 'ls' }, output: 'a.txt', status: 'done', at: 1700000002000 });
    return { ok: true };
  });
  const { chat, clock } = service(adapter);
  const conversation = chat.create(task, { agent: 'claude' });
  chat.setPreferences(task, conversation.id, { model: 'opus', effort: 'high' });
  chat.setMode(task, conversation.id, 'full');
  chat.setTranslate(task, conversation.id, true);
  await chat.sendMessage(task, conversation.id, { text: 'hi there' });
  await wait(() => !chat.list(task.id).find(row => row.id === conversation.id).running);
  const before = await chat.snapshot(task, conversation.id);
  assert.deepEqual(before.items.map(item => [item.kind, item.text || item.output]), [['user', 'hi there'], ['text', 'Hello'], ['tool', 'a.txt']]);
  assert.equal(chat.loadedCount(), 1);
  assert.deepEqual(adapter.loads, [], 'a chat that started here was never read from its session');

  assert.deepEqual(chat.evictIdle(), [], 'just used: it stays');
  clock.now += IDLE - 1;
  assert.deepEqual(chat.evictIdle(), [], 'one millisecond short of the idle time');
  clock.now += 1;
  assert.deepEqual(chat.evictIdle(), [conversation.id]);
  assert.equal(chat.loadedCount(), 0, 'nothing of it is left in memory');
  assert.deepEqual(chat.evictIdle(), [], 'nothing to drop twice');

  // The list still shows it (from the database), as it shows a chat that was never opened.
  const row = chat.list(task.id).find(entry => entry.id === conversation.id);
  assert.deepEqual([row.title, row.mode, row.session_id, row.running, row.pending, row.translate], ['hi there', 'full', 'sess-evict-0001', false, false, true]);

  const after = await chat.snapshot(task, conversation.id);
  assert.deepEqual(adapter.loads, ['sess-evict-0001'], 'opening it reads the session once');
  assert.deepEqual(after.items.map(item => [item.kind, item.text || item.output, item.status]), before.items.map(item => [item.kind, item.text || item.output, item.status]), 'the same messages');
  assert.deepEqual([after.status, after.pending, after.queue, after.suggestion], ['idle', [], [], null]);
  assert.deepEqual([after.conversation.title, after.conversation.mode, after.conversation.session_id, after.conversation.translate, after.conversation.collapseKeyboard], ['hi there', 'full', 'sess-evict-0001', true, true]);
  assert.deepEqual([after.conversation.model, after.conversation.effort], ['opus', 'high'], 'the model and effort the person chose');
  assert.deepEqual(after.conversation.context, { used: 1200, window: 200000 }, 'the context use comes from the session');

  // The same as a Client that was restarted and opens the chat for the first time.
  const restartedAdapter = sessionAdapter();
  restartedAdapter.sessions.set('sess-evict-0001', adapter.sessions.get('sess-evict-0001'));
  const never = await service(restartedAdapter).chat.snapshot(task, conversation.id);
  assert.deepEqual(view(after), view(never));

  // And the next turn resumes the session with the chosen model, as before.
  await chat.sendMessage(task, conversation.id, { text: 'again' });
  await wait(() => adapter.calls.length === 2 && !chat.list(task.id).find(entry => entry.id === conversation.id).running);
  assert.deepEqual([adapter.calls[1].sessionId, adapter.calls[1].model, adapter.calls[1].effort, adapter.calls[1].mode], ['sess-evict-0001', 'opus', 'high', 'full']);
  assert.deepEqual(adapter.loads, ['sess-evict-0001'], 'in memory again: not read a second time');
});

test('a chat that was only looked at is dropped too, and every one that is opened again is read from its session again', async () => {
  const adapter = sessionAdapter();
  const { chat, clock } = service(adapter);
  const ids = [];
  for (let n = 0; n < 5; n++) {
    const sessionId = `sess-looked-000${n}`;
    adapter.sessions.set(sessionId, [{ id: 'h1', kind: 'user', text: `earlier ${n}` }, { id: 'h2', kind: 'text', text: 'answer' }]);
    const conversation = chat.create(task, { agent: 'codex', session_id: sessionId });
    ids.push(conversation.id);
    await chat.snapshot(task, conversation.id);
  }
  assert.equal(chat.loadedCount(), 5);
  clock.now += IDLE / 2;
  await chat.snapshot(task, ids[4]); // used again: its idle time starts over
  clock.now += IDLE / 2;
  assert.deepEqual(chat.evictIdle().sort(), ids.slice(0, 4).sort());
  assert.equal(chat.loadedCount(), 1);
  assert.equal(adapter.loads.length, 5);
  assert.deepEqual((await chat.snapshot(task, ids[0])).items.map(item => item.text), ['earlier 0', 'answer']);
  assert.equal(adapter.loads.length, 6);
  // Listing the chats of the task does not bring them back, and does not count as using them.
  clock.now += IDLE;
  chat.list(task.id);
  assert.equal(chat.evictIdle().length, 2);
  assert.equal(chat.loadedCount(), 0);
});

test('a chat stays in memory while a turn runs, a request waits for the person, or earlier messages are being read', async () => {
  let release;
  let ask = false;
  let askLater = null;
  const adapter = sessionAdapter(async ({ ctx, requestPermission }) => {
    ctx.setSession('sess-working-001');
    if (ask === 'later') { askLater = requestPermission; return { ok: true }; }
    if (ask) await requestPermission({ tool: 'Bash', input: { command: 'ls' }, title: 'Run ls' });
    else await new Promise(resolve => { release = resolve; });
    return { ok: true };
  });
  const { chat, clock } = service(adapter);
  const conversation = chat.create(task, { agent: 'claude' });
  const running = () => chat.list(task.id).find(row => row.id === conversation.id).running;

  await chat.sendMessage(task, conversation.id, { text: 'work' });
  await wait(() => release);
  clock.now += 10 * IDLE;
  assert.deepEqual(chat.evictIdle(), [], 'a turn is running');
  release();
  await wait(() => !running());
  assert.deepEqual(chat.evictIdle(), [], 'the idle time starts when the turn ends');
  clock.now += IDLE;
  assert.deepEqual(chat.evictIdle(), [conversation.id]);

  ask = true;
  await chat.sendMessage(task, conversation.id, { text: 'ask me' });
  await wait(() => chat.list(task.id).find(row => row.id === conversation.id).pending);
  const request = (await chat.snapshot(task, conversation.id)).pending[0];
  assert.equal(request.tool, 'Bash');
  clock.now += 10 * IDLE;
  assert.deepEqual(chat.evictIdle(), [], 'a request waits for the person');
  chat.answerPermission(task, conversation.id, request.id, { allow: true });
  await wait(() => !running());
  clock.now += IDLE;
  assert.deepEqual(chat.evictIdle(), [conversation.id]);

  // A request that comes after the turn (an agent that goes on by itself, for a background task that finished) waits for the person all the same.
  ask = 'later';
  await chat.sendMessage(task, conversation.id, { text: 'ask me later' });
  await wait(() => askLater && !running());
  const answered = askLater({ tool: 'Edit', input: {}, title: 'Change a file' });
  const late = (await chat.snapshot(task, conversation.id)).pending[0];
  assert.equal(late.tool, 'Edit');
  clock.now += 10 * IDLE;
  assert.deepEqual(chat.evictIdle(), [], 'no turn runs, but a request waits for the person');
  chat.answerPermission(task, conversation.id, late.id, { allow: false });
  assert.equal((await answered).allow, false);
  assert.deepEqual(chat.evictIdle(), [conversation.id]);

  // Earlier messages that are being read: the reading must not end in a runtime nobody can reach any more.
  let loaded;
  adapter.loadHistory = () => new Promise(resolve => { loaded = () => resolve([{ id: 'h1', kind: 'user', text: 'slow history' }]); });
  const opening = chat.snapshot(task, conversation.id);
  await wait(() => loaded);
  clock.now += 10 * IDLE;
  assert.deepEqual(chat.evictIdle(), [], 'its earlier messages are being read');
  loaded();
  assert.deepEqual((await opening).items.map(item => item.text), ['slow history']);
  assert.deepEqual(chat.evictIdle(), [conversation.id], 'read, and idle for long');
});

test('a chat stays in memory while a page follows it; the idle time starts when the last page has gone', async () => {
  const adapter = sessionAdapter();
  adapter.sessions.set('sess-followed-01', [{ id: 'h1', kind: 'user', text: 'earlier' }]);
  const { chat, clock } = service(adapter);
  const conversation = chat.create(task, { agent: 'claude', session_id: 'sess-followed-01' });
  const snapshot = await chat.snapshot(task, conversation.id);
  const first = chat.subscribe(task, conversation.id, snapshot.seq, () => {}, { viewer: 'page-viewer-0001' });
  const second = chat.subscribe(task, conversation.id, snapshot.seq, () => {});
  clock.now += 10 * IDLE;
  assert.deepEqual(chat.evictIdle(), [], 'two pages follow it');
  first();
  assert.deepEqual(chat.evictIdle(), [], 'one page still follows it');
  second();
  assert.deepEqual(chat.evictIdle(), [], 'the last page has just gone');
  clock.now += IDLE - 1;
  assert.deepEqual(chat.evictIdle(), []);
  clock.now += 1;
  assert.deepEqual(chat.evictIdle(), [conversation.id]);
});

test('a chat stays in memory while its agent process outlives the turn, and what that process still says reaches the chat', async () => {
  let turn;
  const adapter = sessionAdapter(async ({ ctx }) => {
    ctx.setSession('sess-linger-0001');
    turn = ctx;
    ctx.linger(true); // Claude Code is kept alive for a background task
    return { ok: true };
  });
  const { chat, clock } = service(adapter);
  const conversation = chat.create(task, { agent: 'claude' });
  await chat.sendMessage(task, conversation.id, { text: 'start it in the background' });
  await wait(() => turn && !chat.list(task.id).find(row => row.id === conversation.id).running);
  clock.now += 10 * IDLE;
  assert.deepEqual(chat.evictIdle(), [], 'the turn has ended, the process has not');
  turn.upsert({ id: 'late', kind: 'text', text: 'the background task finished' });
  assert.ok((await chat.snapshot(task, conversation.id)).items.some(item => item.id === 'late'), 'the late answer is in the chat a page loads');
  clock.now += 10 * IDLE;
  assert.deepEqual(chat.evictIdle(), []);
  turn.linger(false);
  turn.linger(false); // said twice: harmless
  assert.deepEqual(chat.evictIdle(), [], 'the idle time starts when the process has ended');
  clock.now += IDLE;
  assert.deepEqual(chat.evictIdle(), [conversation.id]);
});

test('a chat with queued messages stays in memory; an empty queue lets it go, and queue numbers are not used twice after it came back', async () => {
  const adapter = sessionAdapter(async ({ ctx }) => { ctx.setSession('sess-queued-0001'); return { ok: true }; });
  const { chat, clock } = service(adapter);
  const conversation = chat.create(task, { agent: 'claude' });
  // The first one is sent at once (nothing runs); it took number 1.
  assert.equal(chat.queueAdd(task, conversation.id, { body: { text: 'first' } }).id, 1);
  await wait(() => adapter.calls.length === 1 && !chat.list(task.id).find(row => row.id === conversation.id).running);
  await tick();
  chat.setQueue(task, conversation.id, [{ id: 2, body: { text: 'waits for the person' } }]);
  clock.now += 10 * IDLE;
  assert.deepEqual(chat.evictIdle(), [], 'a message waits in the queue');
  assert.equal(chat.loadedCount(), 1);
  chat.queueRemove(task, conversation.id, 2);
  clock.now += IDLE;
  assert.deepEqual(chat.evictIdle(), [conversation.id]);
  // Built again: the next number is above every one that was given, so a page that is behind cannot mean another message with an old number.
  let hold;
  adapter.runTurn = () => new Promise(resolve => { hold = resolve; });
  await chat.sendMessage(task, conversation.id, { text: 'busy now' });
  assert.equal(chat.queueAdd(task, conversation.id, { body: { text: 'later' } }).id, 3);
  assert.deepEqual((await chat.snapshot(task, conversation.id)).queue.map(entry => [entry.id, entry.body.text]), [[3, 'later']]);
  chat.queueRemove(task, conversation.id, 3);
  hold({ ok: true });
  await wait(() => !chat.list(task.id).find(row => row.id === conversation.id).running);
});

test('what only the memory holds keeps a chat there: messages of a chat without a session, a steered message, an error nobody has loaded', async () => {
  // 1. No session yet: nothing on disk could bring the messages back.
  const plain = sessionAdapter(async () => ({ ok: true }));
  const one = service(plain);
  const unsaved = one.chat.create(task, { agent: 'claude' });
  await one.chat.sendMessage(task, unsaved.id, { text: 'never reached a session' });
  await wait(() => !one.chat.list(task.id).find(row => row.id === unsaved.id).running);
  one.clock.now += 100 * IDLE;
  assert.deepEqual(one.chat.evictIdle(), []);
  assert.deepEqual((await one.chat.snapshot(task, unsaved.id)).items.map(item => item.text), ['never reached a session']);
  // A chat without a session and without messages has nothing to lose.
  const empty = one.chat.create(task, { agent: 'claude' });
  await one.chat.snapshot(task, empty.id);
  one.clock.now += IDLE;
  assert.deepEqual(one.chat.evictIdle(), [empty.id]);

  // 2. A message that joined a running turn: the session does not say which one did, and a fork counts turns with it.
  let release;
  const steering = sessionAdapter(async ({ ctx }) => {
    ctx.setSession('sess-steered-001');
    ctx.setControl({ steer: async () => {} });
    await new Promise(resolve => { release = resolve; });
    return { ok: true };
  });
  const two = service(steering);
  const steered = two.chat.create(task, { agent: 'codex' });
  await two.chat.sendMessage(task, steered.id, { text: 'start' });
  await wait(() => release);
  assert.deepEqual(await two.chat.sendMessage(task, steered.id, { text: 'and also this' }), { success: true, steered: true });
  release();
  await wait(() => !two.chat.list(task.id).find(row => row.id === steered.id).running);
  await two.chat.snapshot(task, steered.id);
  two.clock.now += 100 * IDLE;
  assert.deepEqual(two.chat.evictIdle(), []);
  assert.deepEqual((await two.chat.snapshot(task, steered.id)).items.filter(item => item.kind === 'user').map(item => Boolean(item.steered)), [false, true]);

  // 3. A turn that failed with no page open: the reason is in memory only, so it waits for a page.
  const failing = sessionAdapter(async ({ ctx, prompt }, self) => {
    ctx.setSession('sess-failed-0001');
    self.record('sess-failed-0001', { id: 'user:1', kind: 'user', text: prompt.display });
    return { ok: false, error: 'The usage limit was reached' };
  });
  const three = service(failing);
  const failed = three.chat.create(task, { agent: 'claude' });
  await three.chat.sendMessage(task, failed.id, { text: 'do it' });
  await wait(() => !three.chat.list(task.id).find(row => row.id === failed.id).running);
  three.clock.now += 100 * IDLE;
  assert.deepEqual(three.chat.evictIdle(), [], 'nobody has seen why it failed');
  const shown = await three.chat.snapshot(task, failed.id);
  assert.deepEqual(shown.items.map(item => [item.kind, item.text]), [['user', 'do it'], ['error', 'The usage limit was reached']]);
  assert.deepEqual(three.chat.evictIdle(), [], 'a page has just loaded it');
  three.clock.now += IDLE;
  assert.deepEqual(three.chat.evictIdle(), [failed.id], 'a page has loaded it since');
  assert.deepEqual((await three.chat.snapshot(task, failed.id)).items.map(item => [item.kind, item.text]), [['user', 'do it']], 'what the session has, as after a restart');

  // A queued message that could not be sent says so in the chat: the same.
  const four = service(sessionAdapter(async ({ ctx }) => { ctx.setSession('sess-unsent-0001'); return { ok: true }; }));
  const gone = tasks.createTask('owner', { title: 'eviction unsent' });
  const unsent = four.chat.create(gone, { agent: 'claude', session_id: 'sess-unsent-0001' });
  four.chat.queueAdd({ ...gone, work_dir: path.join(root, 'no-such-folder') }, unsent.id, { body: { text: 'cannot go' } });
  await tick(); // the Client tries to send it, cannot, and puts it back
  await tick();
  four.chat.queueRemove(gone, unsent.id, 1);
  four.clock.now += 100 * IDLE;
  assert.deepEqual(four.chat.evictIdle(), [], 'the chat says the message could not be sent, and nobody has read it');
  assert.ok((await four.chat.snapshot(gone, unsent.id)).items.some(item => item.kind === 'error' && /Could not send the queued message/.test(item.text)));
  four.clock.now += IDLE;
  assert.deepEqual(four.chat.evictIdle(), [unsent.id]);
});

test('a chat whose row is gone (its task was deleted) is dropped whatever it holds', async () => {
  const { chat, clock } = service(sessionAdapter(async () => ({ ok: true })));
  const own = tasks.createTask('owner', { title: 'eviction deleted' });
  const conversation = chat.create(own, { agent: 'claude' });
  await chat.sendMessage(own, conversation.id, { text: 'kept only in memory' });
  await wait(() => !chat.list(own.id).find(row => row.id === conversation.id).running);
  clock.now += IDLE;
  assert.deepEqual(chat.evictIdle(), [], 'it has messages and no session');
  db.prepare('DELETE FROM agent_conversations WHERE id = ?').run(conversation.id);
  assert.deepEqual(chat.evictIdle(), [conversation.id]);
  assert.equal(chat.loadedCount(), 0);
});

test('a page that followed a chat before it left the memory is told to reload, and never takes new events for old ones', async () => {
  const adapter = sessionAdapter(async ({ ctx, prompt }, self) => {
    ctx.setSession('sess-pages-0001');
    self.record('sess-pages-0001', { id: `user:${self.calls.length}`, kind: 'user', text: prompt.display });
    ctx.upsert({ id: `m${self.calls.length}`, kind: 'text', text: 'ok' });
    self.record('sess-pages-0001', { id: `m${self.calls.length}`, kind: 'text', text: 'ok' });
    return { ok: true };
  });
  const { chat, clock } = service(adapter);
  const conversation = chat.create(task, { agent: 'claude' });
  const seen = [];
  const stop = chat.subscribe(task, conversation.id, 0, event => seen.push(event));
  await chat.sendMessage(task, conversation.id, { text: 'one' });
  await wait(() => seen.some(event => event.op === 'status' && event.status === 'idle'));
  stop();
  const last = seen[seen.length - 1].seq;
  assert.ok(last >= 4);
  clock.now += IDLE;
  assert.deepEqual(chat.evictIdle(), [conversation.id]);

  // The page comes back with the number it had: it must load the chat again.
  assert.equal(chat.subscribe(task, conversation.id, last, () => {}), null, 'a page that had every event');
  assert.equal(chat.subscribe(task, conversation.id, last - 2, () => {}), null, 'a page that was behind');
  const snapshot = await chat.snapshot(task, conversation.id);
  assert.ok(snapshot.seq > last, 'the numbers go on above the ones the page knows');
  const next = [];
  const again = chat.subscribe(task, conversation.id, snapshot.seq, event => next.push(event));
  assert.equal(typeof again, 'function');
  await chat.sendMessage(task, conversation.id, { text: 'two' });
  await wait(() => next.some(event => event.op === 'status' && event.status === 'idle'));
  again();
  assert.ok(next.every(event => event.seq > last), 'no new event carries a number the page has seen');
  assert.deepEqual(next.map(event => event.seq), next.map((_, index) => snapshot.seq + 1 + index), 'and they are numbered without gaps');
  // Even when the chat built again has given out more numbers than the page had, the page is not let in.
  assert.equal(chat.subscribe(task, conversation.id, last, () => {}), null);

  // Another chat, opened for the first time after that, starts above too: its page loads it first and follows from there.
  const other = chat.create(task, { agent: 'claude' });
  const first = await chat.snapshot(task, other.id);
  const follow = chat.subscribe(task, other.id, first.seq, () => {});
  assert.equal(typeof follow, 'function');
  follow();
});

test('after a restart: the cut turn shows what its session recorded, nothing says "running", the queue waits, and an open page reloads', async () => {
  let reached;
  const adapter = sessionAdapter(async ({ ctx, prompt }, self) => {
    ctx.setSession('sess-restart-001');
    self.record('sess-restart-001', { id: 'user:1', kind: 'user', text: prompt.display });
    ctx.upsert({ id: 'msg:0', kind: 'text', text: 'Let me run it' });
    self.record('sess-restart-001', { id: 'msg:0', kind: 'text', text: 'Let me run it' });
    ctx.upsert({ id: 'tool-1', kind: 'tool', name: 'Bash', input: { command: 'sleep 600' }, output: '', status: 'running' });
    self.record('sess-restart-001', { id: 'tool-1', kind: 'tool', name: 'Bash', input: { command: 'sleep 600' }, output: '', status: 'running' });
    reached = true;
    return new Promise(() => {}); // the server goes down while the tool runs
  });
  const before = service(adapter).chat;
  const conversation = before.create(task, { agent: 'claude' });
  const seen = [];
  before.subscribe(task, conversation.id, 0, event => seen.push(event));
  await before.sendMessage(task, conversation.id, { text: 'run the long thing' });
  await wait(() => reached);
  before.queueAdd(task, conversation.id, { body: { text: 'and then this' } });
  const pageSeq = seen[seen.length - 1].seq;
  assert.equal((await before.snapshot(task, conversation.id)).status, 'running');

  // The restarted Client: a new service on the same database, the same session on disk.
  const restarted = sessionAdapter();
  restarted.sessions.set('sess-restart-001', adapter.sessions.get('sess-restart-001'));
  const after = service(restarted).chat;
  assert.equal(after.subscribe(task, conversation.id, pageSeq, () => {}), null, 'the page that stayed open reloads instead of showing a turn that runs for ever');
  const snapshot = await after.snapshot(task, conversation.id);
  assert.equal(snapshot.status, 'idle');
  assert.equal(snapshot.runningMs, 0);
  assert.deepEqual(snapshot.items.map(item => [item.kind, item.text || item.name, item.status]), [['user', 'run the long thing', undefined], ['text', 'Let me run it', undefined], ['tool', 'Bash', 'error']]);
  assert.deepEqual(snapshot.queue.map(entry => entry.body.text), ['and then this'], 'the queued message is kept');
  assert.deepEqual(snapshot.pending, []);
  await tick();
  assert.equal(restarted.calls.length, 0, 'and it is not sent by itself: it waits for the person');
  const row = after.list(task.id).find(entry => entry.id === conversation.id);
  assert.deepEqual([row.running, row.pending], [false, true]);
  after.queueRemove(task, conversation.id, 1);
});

test('opening a chat twice at once reads its session once, and both get the whole conversation', { timeout: 10000 }, async () => { // a reading nobody waits for must fail the test, not hang it
  const adapter = sessionAdapter();
  let finish;
  adapter.loadHistory = ({ sessionId }) => { adapter.loads.push(sessionId); return new Promise(resolve => { finish = () => resolve([{ id: 'h1', kind: 'user', text: 'earlier' }, { id: 'h2', kind: 'text', text: 'answer' }]); }); };
  const { chat } = service(adapter);
  const conversation = chat.create(task, { agent: 'claude', session_id: 'sess-twice-0001' });
  const first = chat.snapshot(task, conversation.id);
  const second = chat.snapshot(task, conversation.id);
  await wait(() => finish);
  finish();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a.items.map(item => item.id), ['h1', 'h2']);
  assert.deepEqual(b.items.map(item => item.id), ['h1', 'h2'], 'the second one waited for the reading instead of going on with nothing');
  assert.equal(adapter.loads.length, 1);
});

test('the chats in memory are looked over by one timer that does not keep the process alive, and it stops when none is left', async () => {
  const made = [];
  const cleared = [];
  const realSet = global.setInterval;
  const realClear = global.clearInterval;
  global.setInterval = (run, ms, ...rest) => { const timer = realSet(run, ms, ...rest); if (ms === 15) made.push(timer); return timer; };
  global.clearInterval = timer => { if (made.includes(timer)) cleared.push(timer); return realClear(timer); };
  let chat = null;
  try {
    const adapter = sessionAdapter();
    chat = createAgentChat({ db, adapters: { claude: adapter, codex: adapter }, idleMs: 40, sweepMs: 15 });
    const ids = [];
    for (let n = 0; n < 4; n++) {
      const conversation = chat.create(task, { agent: 'claude', session_id: `sess-timer-000${n}` });
      ids.push(conversation.id);
      await chat.snapshot(task, conversation.id);
    }
    assert.equal(chat.loadedCount(), 4);
    assert.equal(made.length, 1, 'one timer for all of them');
    assert.equal(made[0].hasRef(), false, 'it never keeps the process alive');
    await wait(() => chat.loadedCount() === 0);
    assert.equal(cleared.length, 1, 'with nothing in memory there is nothing to look over');
    await chat.snapshot(task, ids[0]);
    assert.equal(made.length, 2, 'and it starts again with the next chat');
    await wait(() => chat.loadedCount() === 0);
  } finally {
    global.setInterval = realSet;
    global.clearInterval = realClear;
    if (chat) chat.shutdown(); // stops the timer even when an assertion failed (this adapter starts no process)
  }
});
