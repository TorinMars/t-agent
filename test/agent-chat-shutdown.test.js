// The agent processes of the chat mode must not outlive the server (services/agent-chat.js `shutdown`, lib/agent-chat/processes.js): Claude Code runs
// in its own process group and is kept alive after a turn for background tasks, `codex app-server` is a plain child. Only what the chat mode started
// is ended. The real CLIs are never run: the SDK is a fake, the processes are plain `node -e` scripts and the fake app server of the tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-chat-shutdown-'));
process.env.T_AGENT_DATA_DIR = root;
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
const db = require('../db');
const tasks = require('../services/engine-tasks');
const agentChat = require('../services/agent-chat');
const claude = require('../lib/agent-chat/claude');
const codex = require('../lib/agent-chat/codex');
const { createRegistry, endSync, readStates } = require('../lib/agent-chat/processes');

const { createAgentChat } = agentChat;
const task = tasks.createTask('owner', { title: 'shutdown' });
test.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

const posix = process.platform === 'win32' ? 'POSIX process groups only' : false;
const FAKE_CODEX = path.join(__dirname, '..', 'test-support', 'fake-codex-app-server.js');
const wait = async (condition, what = 'timed out') => { for (let i = 0; i < 800 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(condition(), what); };

// A child process as Node hands it out, without a process behind it.
function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.kill = () => true;
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  return child;
}
// A `kill` that records what it is asked, over a set of processes that are "alive"; `stubborn` ones ignore SIGTERM.
function fakeKill({ alive, stubborn = new Set() }) {
  const sent = [];
  const kill = (target, signal) => {
    sent.push([target, signal]);
    if (!alive.has(target)) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    if (signal === 'SIGKILL' || (signal === 'SIGTERM' && !stubborn.has(target))) alive.delete(target);
    return true;
  };
  return { kill, sent };
}
const noSleep = () => {};

test('a registry knows the children it was given until Node has reaped them, and nothing else', () => {
  const registry = createRegistry();
  const leader = fakeChild(41001);
  const plain = fakeChild(41002);
  assert.equal(registry.track(leader, { group: true }), leader, 'the child is handed back');
  registry.track(plain);
  registry.track(fakeChild(undefined)); // it did not start
  registry.track(fakeChild(1));
  registry.track(null);
  assert.deepEqual(registry.list(), [{ pid: 41001, group: true }, { pid: 41002, group: false }]);
  registry.list()[0].pid = 7; // a copy: the registry cannot be changed from outside
  assert.equal(registry.list()[0].pid, 41001);
  leader.emit('exit', 0, null);
  assert.deepEqual(registry.list(), [{ pid: 41002, group: false }], 'an ended child is forgotten: its pid can belong to anything now');
  plain.emit('exit', null, 'SIGKILL');
  assert.deepEqual(registry.list(), []);
});

test('endSync: SIGTERM to the group of a leader and to a plain child itself, SIGKILL only for what stays alive, and it never throws', () => {
  const alive = new Set([-500, 600, -700]);
  const { kill, sent } = fakeKill({ alive, stubborn: new Set([-700]) });
  const slept = [];
  const result = endSync([{ pid: 500, group: true }, { pid: 600, group: false }, { pid: 700, group: true }, { pid: 800, group: true }],
    { graceMs: 60, kill, sleep: ms => { slept.push(ms); const until = Date.now() + ms; while (Date.now() < until); }, table: () => null });
  assert.deepEqual(sent.slice(0, 4), [[-500, 'SIGTERM'], [600, 'SIGTERM'], [-700, 'SIGTERM'], [-800, 'SIGTERM']]);
  assert.deepEqual(result.signalled, [{ pid: 500, group: true }, { pid: 600, group: false }, { pid: 700, group: true }], 'the one that was gone already is not counted');
  assert.deepEqual(result.killed, [{ pid: 700, group: true }]);
  assert.deepEqual(sent.filter(([, signal]) => signal === 'SIGKILL'), [[-700, 'SIGKILL']], 'only the one that ignored SIGTERM');
  assert.ok(slept.length >= 1 && slept.every(ms => ms > 0 && ms <= 60), 'the wait is short and bounded');

  // Everything ended at SIGTERM: one look, no more waiting, no SIGKILL.
  const polite = fakeKill({ alive: new Set([-900]) });
  const naps = [];
  assert.deepEqual(endSync([{ pid: 900, group: true }], { graceMs: 5000, kill: polite.kill, sleep: ms => naps.push(ms), table: () => null }), { signalled: [{ pid: 900, group: true }], killed: [] });
  assert.equal(naps.length, 1);
  assert.deepEqual(polite.sent, [[-900, 'SIGTERM'], [-900, 0]]);

  // Nothing to end: nothing is signalled and nothing waits.
  const none = fakeKill({ alive: new Set() });
  assert.deepEqual(endSync([], { kill: none.kill, sleep: () => assert.fail('no wait') }), { signalled: [], killed: [] });
  assert.deepEqual(none.sent, []);

  // Never the server itself, never "every process", never the same one twice, never something that is not a process id.
  const careful = fakeKill({ alive: new Set([process.pid, -process.pid, 0, 1, -1, 321]) });
  endSync([{ pid: process.pid, group: true }, { pid: process.pid }, { pid: 0, group: true }, { pid: 1 }, { pid: -5 }, { pid: '321' }, { pid: 1.5 }, null, { pid: 321 }, { pid: 321, group: true }],
    { graceMs: 0, kill: careful.kill, sleep: noSleep, table: () => null });
  assert.deepEqual(careful.sent[0], [321, 'SIGTERM']);
  assert.ok(careful.sent.every(([target]) => target === 321), 'only the one real process, by itself, as it was first named');

  // Whatever goes wrong, the exit handler goes on.
  assert.doesNotThrow(() => endSync([{ pid: 4242, group: true }], { kill: () => { throw new Error('EPERM'); }, sleep: () => { throw new Error('no sleep'); }, table: () => { throw new Error('no ps'); } }));
  assert.deepEqual(endSync('nonsense'), { signalled: [], killed: [] });
});

test('endSync: a child that ended but is not reaped yet (a zombie) is not waited for and not killed', () => {
  // Inside the exit handler nothing is reaped: an ended child still answers signal 0, so the process table decides.
  const alive = new Set([-500, 600, -700]);
  const { kill, sent } = fakeKill({ alive, stubborn: new Set([-500, 600, -700]) }); // all three keep answering
  const states = new Map([
    [500, { pgid: 500, zombie: true }], // the leader ended, and so did its group
    [600, { pgid: 77, zombie: true }],
    [700, { pgid: 700, zombie: true }], [701, { pgid: 700, zombie: false }], // the leader ended, a command it started did not
  ]);
  const naps = [];
  const result = endSync([{ pid: 500, group: true }, { pid: 600 }, { pid: 700, group: true }], { graceMs: 40, kill, sleep: ms => { naps.push(ms); const until = Date.now() + ms; while (Date.now() < until); }, table: () => states });
  assert.deepEqual(result.killed, [{ pid: 700, group: true }], 'only the group that still has a live member');
  assert.deepEqual(sent.filter(([, signal]) => signal === 'SIGKILL'), [[-700, 'SIGKILL']]);
  // With only zombies left the wait ends at the first look.
  const quick = fakeKill({ alive: new Set([-500]), stubborn: new Set([-500]) });
  const looks = [];
  endSync([{ pid: 500, group: true }], { graceMs: 5000, kill: quick.kill, sleep: ms => looks.push(ms), table: () => states });
  assert.equal(looks.length, 1);
});

test('readStates lists this process with its group', { skip: posix }, () => {
  const states = readStates();
  assert.ok(states instanceof Map);
  const mine = states.get(process.pid);
  assert.ok(mine, 'the table has a row for this process');
  assert.equal(mine.zombie, false);
  assert.ok(Number.isInteger(mine.pgid) && mine.pgid > 0);
});

test('shutdown signals exactly what the adapters started, once, and goes on when an adapter fails', () => {
  const adapter = (list, extra = {}) => ({ MODES: { ask: {} }, DEFAULT_MODE: 'ask', loadHistory: async () => [], runTurn: async () => ({ ok: true }), liveProcesses: list, ...extra });
  const alive = new Set([-7001, 7002, -7003]);
  const { kill, sent } = fakeKill({ alive, stubborn: new Set([7002]) });
  const claudeLike = adapter(() => [{ pid: 7001, group: true }, { pid: 7003, group: true }]);
  const chat = createAgentChat({ db, sweepMs: 0, adapters: {
    claude: claudeLike, again: claudeLike, // one adapter under two names is asked once
    codex: adapter(() => [{ pid: 7002, group: false }]),
    broken: adapter(() => { throw new Error('no list'); }),
    old: { MODES: { ask: {} }, DEFAULT_MODE: 'ask', loadHistory: async () => [], runTurn: async () => ({ ok: true }) }, // an adapter that starts nothing
  } });
  const result = chat.shutdown({ graceMs: 30, kill, sleep: ms => { const until = Date.now() + ms; while (Date.now() < until); }, table: () => null });
  assert.deepEqual(sent.filter(([, signal]) => signal === 'SIGTERM'), [[-7001, 'SIGTERM'], [-7003, 'SIGTERM'], [7002, 'SIGTERM']]);
  assert.deepEqual(sent.filter(([, signal]) => signal === 'SIGKILL'), [[7002, 'SIGKILL']]);
  assert.deepEqual(result, { signalled: [{ pid: 7001, group: true }, { pid: 7003, group: true }, { pid: 7002, group: false }], killed: [{ pid: 7002, group: false }] });
  assert.ok(sent.every(([target]) => [-7001, 7002, -7003].includes(target)), 'nothing else is ever signalled');

  // Nothing alive: nothing is signalled, and nothing waits.
  const idle = createAgentChat({ db, sweepMs: 0, adapters: { claude: adapter(() => []) } });
  const quiet = fakeKill({ alive: new Set() });
  assert.deepEqual(idle.shutdown({ kill: quiet.kill, sleep: () => assert.fail('no wait') }), { signalled: [], killed: [] });
  assert.deepEqual(quiet.sent, []);
  assert.doesNotThrow(() => idle.shutdown({ kill: () => { throw new Error('boom'); } }));
});

test('the server ends the chat processes in its exit handler, and the call does nothing when no chat was used', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const handler = source.split('\n').find(line => line.startsWith("process.on('exit'"));
  assert.ok(handler, 'server.js has an exit handler');
  assert.match(handler, /require\('\.\/services\/agent-chat'\)\.shutdown\(\);/);
  // This file never made the shared instance: there is nothing to end, and the call must not make one (it would open the database on the way out).
  assert.deepEqual(agentChat.shutdown(), { signalled: [], killed: [] });
  assert.doesNotThrow(() => agentChat.shutdown({ kill: () => { throw new Error('boom'); } }));
});

test('the exit handler also ends an app server that was started without a chat (the environment check starts one)', async () => {
  const { AppServerClient } = require('../lib/agent-chat/codex-app-server');
  const child = fakeChild(62001);
  child.stderr = new EventEmitter();
  child.stdin.writable = true;
  child.stdin.write = () => true;
  const client = new AppServerClient({ command: 'codex', cwd: os.tmpdir(), spawnProcess: () => child });
  const started = client.start().catch(() => { /* ended below */ });
  const { kill, sent } = fakeKill({ alive: new Set([62001]) });
  const result = agentChat.shutdown({ graceMs: 30, kill, sleep: noSleep, table: () => null });
  assert.deepEqual(result, { signalled: [{ pid: 62001, group: false }], killed: [] });
  assert.deepEqual(sent, [[62001, 'SIGTERM'], [62001, 0]], 'the app server by itself, and nothing else');
  child.emit('exit', null, 'SIGTERM');
  await started;
  assert.ok(!codex.liveProcesses().some(entry => entry.pid === 62001));
});

// The Claude Agent SDK as runTurn uses it: `query()` starts the process through the hook runTurn passes (spawnClaudeCodeProcess), and the stream is
// what the test pushes. `command`: what to start instead of Claude Code.
function fakeSdk({ command = process.execPath, args }) {
  const sdk = {
    children: [], queries: [],
    query({ options }) {
      const child = options.spawnClaudeCodeProcess({ command, args, cwd: os.tmpdir(), env: process.env });
      sdk.children.push(child);
      const queue = [];
      let wake = null;
      let done = false;
      const stir = () => { if (wake) wake(); };
      if (child.once) child.once('exit', () => { done = true; stir(); });
      const query = {
        push(message) { queue.push({ session_id: 'sess-shutdown-1', ...message }); stir(); },
        close() { done = true; child.kill('SIGTERM'); stir(); },
        [Symbol.asyncIterator]() {
          return { next: async () => { while (!queue.length && !done) await new Promise(resolve => { wake = resolve; }); return queue.length ? { value: queue.shift(), done: false } : { value: undefined, done: true }; } };
        },
      };
      sdk.queries.push(query);
      return query;
    },
  };
  return sdk;
}
const turnContext = () => ({ lingers: [], upsert() {}, append() {}, getItem() {}, setSession() {}, linger(active) { this.lingers.push(active); } });

test('Claude: the process of a turn is started as a group leader and listed while it lives, also after the turn, and the chat is told how long it can add to it', { skip: posix }, async () => {
  const spawned = [];
  const child = fakeChild(51001);
  const sdk = fakeSdk({ args: ['-e', ''] });
  const ctx = turnContext();
  const turn = claude.runTurn({
    cwd: '/w', mode: 'ask', prompt: { text: 'x' }, signal: new AbortController().signal, ctx, requestPermission: async () => ({ allow: true }),
    deps: { loadSdk: async () => sdk, executable: undefined, suggestionWaitMs: 20, backgroundWaitMs: 5000, spawn: (command, args, options) => { spawned.push({ command, args, options }); return child; } },
  });
  await wait(() => sdk.queries.length === 1);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].options.detached, true, 'its own process group');
  assert.deepEqual(claude.liveProcesses().filter(entry => entry.pid === 51001), [{ pid: 51001, group: true }], 'listed while the turn runs');
  assert.deepEqual(ctx.lingers, [], 'during the turn the chat is running anyway');
  // A background task is still running when the turn ends: Claude Code is kept alive.
  sdk.queries[0].push({ type: 'system', subtype: 'task_started', task_id: 'bg-1', is_backgrounded: true });
  sdk.queries[0].push({ type: 'result', subtype: 'success', is_error: false });
  assert.equal((await turn).ok, true);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(ctx.lingers, [true], 'from the result on, the process can still add to the chat');
  assert.deepEqual(claude.liveProcesses().filter(entry => entry.pid === 51001), [{ pid: 51001, group: true }], 'still listed after the turn: it lingers');
  // The process ends: the stream ends with it, the chat is released, and the pid is forgotten.
  child.emit('exit', 0, null);
  await wait(() => ctx.lingers.length === 2);
  assert.deepEqual(ctx.lingers, [true, false]);
  assert.deepEqual(claude.liveProcesses().filter(entry => entry.pid === 51001), []);
});

test('Codex: the app server of a turn is listed while the turn runs, as a plain child, and forgotten when it has ended', { timeout: 30000 }, async t => {
  fs.chmodSync(FAKE_CODEX, 0o755);
  process.env.FAKE_CODEX_LOG = path.join(root, 'fake-codex.jsonl');
  const before = new Set(codex.liveProcesses().map(entry => entry.pid));
  const controller = new AbortController();
  t.after(() => controller.abort()); // the fake app server ends with the turn, also when an assertion failed
  const items = new Map();
  let control = null;
  const ctx = { upsert: item => items.set(item.id, item), append() {}, getItem: id => items.get(id), setSession() {}, setMeta() {}, setControl: value => { control = value; } };
  const turn = codex.runTurn({ cwd: os.tmpdir(), mode: 'write', prompt: { text: 'hang on' }, signal: controller.signal, ctx, requestPermission: async () => ({ allow: true }), deps: { executable: FAKE_CODEX } });
  await wait(() => control, 'the turn did not start');
  const mine = codex.liveProcesses().filter(entry => !before.has(entry.pid));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].group, false, 'it shares the process group of the server: only the process itself may be signalled');
  assert.ok(Number.isInteger(mine[0].pid) && mine[0].pid !== process.pid);
  controller.abort();
  await turn;
  await wait(() => !codex.liveProcesses().some(entry => entry.pid === mine[0].pid), 'the ended app server is still listed');
});

// A zombie counts as gone: it has ended and only waits for its parent.
function alive(pid) {
  try { return !/^Z/.test(execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()); } catch { return false; }
}
const READY = "process.stdout.write('ready\\n');setInterval(()=>{},1000)";
const ready = child => new Promise((resolve, reject) => {
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; if (out.includes('ready')) resolve(); });
  child.once('error', reject);
  setTimeout(() => reject(new Error('the test process did not start')), 10000).unref();
});

test('shutdown ends real chat processes: one that ignores SIGTERM is killed, a kept-alive one ends at SIGTERM, a process the chat did not start lives on', { skip: posix, timeout: 60000 }, async t => {
  const strays = new Set();
  t.after(() => { for (const pid of strays) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } });

  // Two chats on the real Claude adapter with a fake SDK; the usage is not read (that would start the real Claude Code).
  const adapter = { ...claude, POLL_LIMITS: false, loadLimits: undefined, loadMeta: undefined, loadHistory: async () => [] };
  const chat = createAgentChat({ db, adapters: { claude: adapter }, sweepMs: 0 });
  const start = async (script, title) => {
    const sdk = fakeSdk({ args: ['-e', script] });
    const conversation = chat.create(task, { agent: 'claude', title });
    await chat.sendMessage(task, conversation.id, { text: 'go' }, { claude: { loadSdk: async () => sdk, executable: undefined, suggestionWaitMs: 60000, backgroundWaitMs: 60000 } });
    await wait(() => sdk.children.length === 1, 'the process was not started');
    const child = sdk.children[0];
    strays.add(child.pid);
    await ready(child);
    return { sdk, child, conversation };
  };
  // A turn that is still running, in a process that ignores SIGTERM (and SIGHUP, as Codex does).
  const stubborn = await start(`process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});${READY}`, 'stubborn');
  // A turn that has ended, with Claude Code kept alive for a background task.
  const lingering = await start(READY, 'lingering');
  lingering.sdk.queries[0].push({ type: 'system', subtype: 'task_started', task_id: 'bg-1', is_backgrounded: true });
  lingering.sdk.queries[0].push({ type: 'result', subtype: 'success', is_error: false });
  await wait(() => !chat.list(task.id).find(row => row.id === lingering.conversation.id).running, 'the turn did not end');
  assert.equal(chat.list(task.id).find(row => row.id === stubborn.conversation.id).running, true);
  // A process in a group of its own that the chat mode did not start: a job the person runs.
  const bystander = spawn(process.execPath, ['-e', READY], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  strays.add(bystander.pid);
  await ready(bystander);

  const mine = [stubborn.child.pid, lingering.child.pid];
  assert.deepEqual(claude.liveProcesses().filter(entry => mine.includes(entry.pid)), [{ pid: mine[0], group: true }, { pid: mine[1], group: true }]);
  assert.ok(mine.every(alive) && alive(bystander.pid));

  const started = Date.now();
  const result = chat.shutdown({ graceMs: 400 });
  const took = Date.now() - started;
  assert.ok(took < 3000, `shutdown must finish within its short grace period (took ${took} ms)`);
  assert.deepEqual(result.signalled.filter(entry => mine.includes(entry.pid)), [{ pid: mine[0], group: true }, { pid: mine[1], group: true }]);
  assert.deepEqual(result.killed.filter(entry => mine.includes(entry.pid)), [{ pid: mine[0], group: true }], 'only the one that ignored SIGTERM needed SIGKILL');
  assert.ok(!result.signalled.some(entry => entry.pid === bystander.pid));
  // SIGKILL has been sent when it returns; allow a moment for the kernel to end the process.
  await wait(() => !alive(stubborn.child.pid), 'the process that ignores SIGTERM is still alive');
  assert.equal(alive(lingering.child.pid), false, 'the kept-alive process ended at SIGTERM');
  assert.equal(alive(bystander.pid), true, 'a process the chat mode did not start is left alone');
  await wait(() => !claude.liveProcesses().some(entry => mine.includes(entry.pid)), 'the ended processes are still listed');
  assert.doesNotThrow(() => chat.shutdown({ graceMs: 50 }), 'a second call finds nothing');
});
