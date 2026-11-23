// The plan usage bars, server side (services/agent-usage.js, routes/agent-usage.js; docs/design/plan-usage.md): readings shared with the agent chat,
// GET / refresh, account hashes, states, the schedule, the reads after terminal turns, /v1 with a token, the forward and the 501 of an older engine.
// Every agent is a fake adapter (loadLimits); the account files live in a temporary home.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-usage-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'agent-usage-test-secret-agent-usage-test-secret';

const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports(req, res, next) { req.session = { user: { login: 'owner' } }; next(); },
};

const express = require('express');
const db = require('../db');
const { createAgentChat, signedOutError } = require('../services/agent-chat');
const usageLib = require('../services/agent-usage');
const { createAgentUsage, createAccountReader, accountFiles, hashAccount, cleanAnswer, scheduleEnabled, CAPABILITY } = usageLib;
const { createTurnEndWatch } = require('../lib/agent-turn-end');

const MIN = 60 * 1000;
const flush = async (times = 6) => { for (let i = 0; i < times; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; let reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };
const windows = (five, seven) => [
  { id: '5h', label: '5h', usedPercent: five, resetsAt: Date.now() + 3 * 3600 * 1000 },
  { id: '7d', label: '7d', usedPercent: seven, resetsAt: Date.now() + 4 * 86400 * 1000 },
];

// A fake agent: counts its readings; `next()` gives what the next reading answers (a value, a promise or a thrown error).
function fakeAgent(next = () => windows(10, 20)) {
  const agent = { reads: 0, next };
  agent.adapter = {
    MODES: { ask: {} }, DEFAULT_MODE: 'ask', loadHistory: async () => [], runTurn: async () => ({ ok: true }),
    loadLimits: async () => { agent.reads += 1; return agent.next(); },
  };
  return agent;
}

function setup({ claude = fakeAgent(), codex = fakeAgent(), installed = { claude: true, codex: true }, accounts = { claude: 'aaaaaaaaaaaa', codex: 'bbbbbbbbbbbb' }, ...options } = {}) {
  const chat = createAgentChat({ db, adapters: { claude: claude.adapter, codex: codex.adapter }, limitsPollMs: 0 });
  const usage = createAgentUsage({
    chat,
    installed: { claude: async () => installed.claude, codex: async () => installed.codex },
    account: agent => accounts[agent] || null,
    identity: () => ({ engine_id: 'engine-1', name: 'T01' }),
    busyAgents: () => [],
    ...options,
  });
  return { chat, usage, claude, codex };
}

test.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('GET answers at once and starts one background reading per agent when the last one is old', async () => {
  const gate = deferred();
  const claude = fakeAgent(() => gate.promise);
  const codex = fakeAgent(() => gate.promise);
  let offset = 0;
  const { usage } = setup({ claude, codex, now: () => Date.now() + offset });
  const first = await usage.get();
  assert.deepEqual(first, {
    engine: { instance_id: 'engine-1', name: 'T01' },
    agents: [
      { agent: 'claude', state: 'not_read', account: 'aaaaaaaaaaaa', read_at: null, windows: [] },
      { agent: 'codex', state: 'not_read', account: 'bbbbbbbbbbbb', read_at: null, windows: [] },
    ],
  });
  assert.equal(claude.reads, 1);
  assert.equal(codex.reads, 1);
  await usage.get(); // a reading is under way: no second one
  assert.equal(claude.reads, 1);
  gate.resolve(windows(62, 81));
  await flush();
  const read = await usage.get();
  assert.equal(read.agents[0].state, 'ok');
  assert.deepEqual(read.agents[0].windows.map(entry => [entry.id, entry.label, entry.usedPercent]), [['5h', '5h', 62], ['7d', '7d', 81]]);
  assert.ok(Number.isFinite(read.agents[0].windows[0].resetsAt));
  assert.ok(read.agents[0].read_at > 0);
  assert.equal(claude.reads, 1, 'a fresh reading is not repeated');
  offset = 6 * MIN; // older than 5 minutes
  await usage.get();
  await flush();
  assert.equal(claude.reads, 2);
  assert.equal(codex.reads, 2);
});

test('refresh forces a reading, at most once per 10 s per agent, and answers after it', async () => {
  let used = 0;
  const claude = fakeAgent(() => windows(used += 5, 1));
  let offset = 0;
  const { usage } = setup({ claude, installed: { claude: true, codex: false }, now: () => Date.now() + offset });
  const first = await usage.refresh();
  assert.equal(claude.reads, 1);
  assert.deepEqual(first.agents.map(entry => entry.agent), ['claude'], 'an agent that is not installed is left out');
  assert.equal(first.agents[0].windows[0].usedPercent, 5);
  const again = await usage.refresh();
  assert.equal(claude.reads, 1, 'a second refresh within 10 s answers the last reading');
  assert.equal(again.agents[0].windows[0].usedPercent, 5);
  offset = 11 * 1000;
  assert.equal((await usage.refresh()).agents[0].windows[0].usedPercent, 10);
  assert.equal(claude.reads, 2);
});

test('refresh answers the last reading when the reading takes longer than its time limit', async () => {
  const claude = fakeAgent(() => new Promise(() => {}));
  const { usage } = setup({ claude, installed: { claude: true, codex: false }, refreshTimeoutMs: 30 });
  const started = Date.now();
  const answer = await usage.refresh();
  assert.ok(Date.now() - started < 1000);
  assert.equal(answer.agents[0].state, 'not_read');
});

test('readings are shared with the chat: one at a time per agent, and the chat sees what the bars read', async () => {
  const gate = deferred();
  const codex = fakeAgent(() => gate.promise);
  const { chat, usage } = setup({ codex, installed: { claude: false, codex: true } });
  const chatReading = chat.refreshLimits('codex', { force: true });
  const answer = usage.refresh();
  await usage.get();
  await flush();
  assert.equal(codex.reads, 1, 'the refresh waits for the chat reading instead of starting another');
  gate.resolve(windows(30, 40));
  await chatReading;
  assert.equal((await answer).agents[0].windows[0].usedPercent, 30);
  codex.next = () => windows(50, 60);
  await usage.refresh(); // within 10 s of the refresh above: nothing new is read
  assert.equal(codex.reads, 1);
  await chat.refreshLimits('codex', { force: true });
  assert.equal((await usage.get()).agents[0].windows[0].usedPercent, 50, 'a reading of the chat is the bars\' reading');
  assert.deepEqual(chat.limitsReading('codex').last.limits.map(entry => entry.usedPercent), [50, 60]);
});

test('states: signed_out from the agent or from no login, error otherwise; windows only when ok', async () => {
  const claude = fakeAgent(() => { throw new Error('network down'); });
  const codex = fakeAgent(() => { throw new Error('codex account authentication required to read rate limits'); });
  const { usage } = setup({ claude, codex });
  const answer = await usage.refresh();
  assert.deepEqual(answer.agents.map(entry => [entry.agent, entry.state, entry.windows.length]), [['claude', 'error', 0], ['codex', 'signed_out', 0]]);
  assert.ok(answer.agents[0].read_at > 0);
  const noLogin = setup({ claude: fakeAgent(() => { throw new Error('exit code 1'); }), accounts: {}, installed: { claude: true, codex: false } });
  assert.equal((await noLogin.usage.refresh()).agents[0].state, 'signed_out', 'a failed reading without a login in the files is signed out');
  assert.equal((await setup({ installed: { claude: false, codex: false } }).usage.get()).agents.length, 0);
  for (const message of ['Not logged in · Please run /login', 'Invalid API key · Please run /login', 'HTTP 401 Unauthorized']) assert.ok(signedOutError(new Error(message)), message);
  for (const message of ['ETIMEDOUT', 'socket hang up']) assert.equal(signedOutError(new Error(message)), false, message);
});

test('account hash: 12 hex of the id in the terminal user\'s files; no email, raw id or token in the answer', async () => {
  const home = path.join(root, 'home-dev');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-claude-123', emailAddress: 'person@example.com', organizationUuid: 'org-9' }, projects: {} }));
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { account_id: 'acct-codex-456', id_token: 'id-token-secret', access_token: 'access-secret' } }));
  const files = () => accountFiles({ env: { PATH: '' }, homedir: () => path.join(root, 'service-home'), terminalUser: () => ({ user: { name: 'dev', uid: 1000, gid: 1000, home } }) });
  assert.deepEqual(files(), { claude: path.join(home, '.claude.json'), codex: path.join(home, '.codex', 'auth.json') });
  const custom = accountFiles({ env: { CLAUDE_CONFIG_DIR: '/x/claude', CODEX_HOME: '/x/codex' }, homedir: () => home, terminalUser: () => ({ user: null }) });
  assert.deepEqual(custom, { claude: '/x/claude/.claude.json', codex: '/x/codex/auth.json' });

  const account = createAccountReader({ files });
  const expected = id => crypto.createHash('sha256').update(id).digest('hex').slice(0, 12);
  assert.equal(account('claude'), expected('uuid-claude-123'));
  assert.equal(account('codex'), expected('acct-codex-456'));
  assert.equal(hashAccount('uuid-claude-123'), expected('uuid-claude-123'));
  const { usage } = setup({ account });
  const body = JSON.stringify(await usage.refresh());
  for (const secret of ['uuid-claude-123', 'person@example.com', 'org-9', 'acct-codex-456', 'id-token-secret', 'access-secret']) assert.ok(!body.includes(secret), secret);
  assert.ok(body.includes(expected('uuid-claude-123')));

  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'org-only' } }));
  assert.equal(account('claude'), expected('org-only'), 'a changed file is read again');
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{ broken');
  assert.equal(account('codex'), null);
  fs.rmSync(path.join(home, '.claude.json'));
  assert.equal(account('claude'), null);
});

test('cleanAnswer keeps only the known fields of another engine\'s answer', () => {
  const answer = cleanAnswer({
    engine: { instance_id: 'k01', name: 'K01', email: 'x@y' },
    agents: [
      { agent: 'codex', state: 'ok', account: 'cccccccccccc', read_at: 5, windows: [{ id: '5h', label: '5h', usedPercent: 140, resetsAt: 9, extra: 1 }, { id: '1m', usedPercent: 1 }], email: 'a@b' },
      { agent: 'claude', state: 'weird', account: 'raw-account-id', read_at: null, windows: [{ id: '5h', usedPercent: 1 }] },
      { agent: 'opencode', state: 'ok' },
    ],
  });
  assert.deepEqual(answer, {
    engine: { instance_id: 'k01', name: 'K01' },
    agents: [
      { agent: 'claude', state: 'error', account: null, read_at: null, windows: [] },
      { agent: 'codex', state: 'ok', account: 'cccccccccccc', read_at: 5, windows: [{ id: '5h', label: '5h', usedPercent: 100, resetsAt: 9 }] },
    ],
  });
});

test('the schedule switch: off in tests, in CI and with AGENT_USAGE_SCHEDULE=off', () => {
  assert.equal(scheduleEnabled({}), true);
  assert.equal(scheduleEnabled({ NODE_ENV: 'test' }), false);
  assert.equal(scheduleEnabled({ CI: 'true' }), false);
  for (const value of ['off', 'OFF', '0', 'false', 'no']) assert.equal(scheduleEnabled({ AGENT_USAGE_SCHEDULE: value }), false, value);
  assert.equal(scheduleEnabled({ AGENT_USAGE_SCHEDULE: 'on' }), true);
  assert.equal(process.env.NODE_ENV === 'test' ? scheduleEnabled() : false, false);
});

// ── The schedule, with fake timers (setInterval, setTimeout and Date) ──

async function withClock(run) {
  test.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_700_000_000_000 });
  const advance = async minutes => { for (let i = 0; i < minutes; i++) { test.mock.timers.tick(MIN); await flush(); } };
  try { await run(advance); } finally { test.mock.timers.reset(); }
}
// The minutes (since start) at which the agent was read.
function recorder(agent, start, answer) {
  const at = [];
  agent.next = () => { at.push(Math.round((Date.now() - start) / MIN)); return answer(); };
  return at;
}

test('schedule: a reading at start, then before it is 10 minutes old; none for an agent that is not installed; stops on stop', () => withClock(async advance => {
  const start = Date.now();
  const claude = fakeAgent();
  const codex = fakeAgent();
  const at = recorder(claude, start, () => windows(1, 2));
  const { usage } = setup({ claude, codex, installed: { claude: true, codex: false } });
  usage.start();
  await flush();
  assert.deepEqual(at, [0]);
  await advance(9);
  assert.deepEqual(at, [0], 'a reading younger than 10 minutes is not repeated');
  await advance(21);
  assert.deepEqual(at, [0, 10, 20, 30]);
  assert.equal(codex.reads, 0, 'an agent that is not installed is not read');
  usage.stop();
  assert.equal(usage.running(), false);
  await advance(30);
  assert.deepEqual(at, [0, 10, 20, 30]);
}));

test('schedule: after a failure again in 1 minute, then 5, then every 10; a signed-out agent every 60 minutes', () => withClock(async advance => {
  const start = Date.now();
  const claude = fakeAgent();
  const codex = fakeAgent();
  const failed = recorder(claude, start, () => { throw new Error('network down'); });
  const signedOut = recorder(codex, start, () => { throw new Error('codex account authentication required to read rate limits'); });
  const { usage } = setup({ claude, codex });
  usage.start();
  await flush();
  await advance(130);
  assert.deepEqual(failed.slice(0, 6), [0, 1, 6, 16, 26, 36]);
  assert.deepEqual(signedOut, [0, 60, 120]);
  usage.stop();
}));

test('schedule: every minute while a session of that agent runs, per agent; back to 10 minutes when it is idle; failures still wait', () => withClock(async advance => {
  const start = Date.now();
  const claude = fakeAgent();
  const codex = fakeAgent();
  const claudeAt = recorder(claude, start, () => windows(1, 2));
  const codexAt = recorder(codex, start, () => windows(3, 4));
  const busy = new Set(['claude']);
  const { usage } = setup({ claude, codex, busyAgents: () => busy });
  usage.start();
  await flush();
  await advance(4);
  assert.deepEqual(claudeAt, [0, 1, 2, 3, 4], 'a running Claude session: a reading each minute');
  assert.deepEqual(codexAt, [0], 'Codex has no running session');
  busy.delete('claude');
  await advance(10);
  assert.deepEqual(claudeAt, [0, 1, 2, 3, 4, 14], 'idle again: before the reading is 10 minutes old');
  busy.add('codex');
  await advance(2);
  assert.deepEqual(codexAt, [0, 10, 15, 16], 'Codex kept its 10-minute rhythm, then each minute once its session runs');
  const failing = recorder(claude, start, () => { throw new Error('network down'); });
  busy.add('claude');
  await advance(4);
  // 17: the reading fails; 18: again after 1 minute (fails); then it waits 5 minutes although the session runs.
  assert.deepEqual(failing, [17, 18]);
  await advance(3);
  assert.deepEqual(failing, [17, 18, 23]);
  usage.stop();
}));

test('schedule: a fresh reading from elsewhere is not repeated', () => withClock(async advance => {
  const start = Date.now();
  const claude = fakeAgent();
  const at = recorder(claude, start, () => windows(1, 2));
  const { chat, usage } = setup({ claude, installed: { claude: true, codex: false } });
  await chat.refreshLimits('claude', { force: true }); // a chat reading at 0
  await advance(3);
  usage.start();
  await flush();
  assert.deepEqual(at, [0], 'the tick at start skips a 3-minute-old reading');
  await advance(7);
  assert.deepEqual(at, [0, 10]);
  usage.stop();
}));

test('a terminal turn reads the agent at most once a minute, only while the automatic readings run', () => withClock(async advance => {
  const start = Date.now();
  const claude = fakeAgent();
  const at = recorder(claude, start, () => windows(1, 2));
  const { usage } = setup({ claude, installed: { claude: true, codex: false } });
  assert.equal(usage.turnEnded('claude'), false, 'nothing before start');
  usage.start();
  await flush();
  await advance(2);
  assert.equal(usage.turnEnded('claude'), true);
  await flush();
  assert.deepEqual(at, [0, 2]);
  test.mock.timers.tick(30 * 1000);
  assert.equal(usage.turnEnded('claude'), false, 'within a minute of the last turn read');
  await advance(1);
  assert.equal(usage.turnEnded('claude'), true);
  await flush();
  assert.deepEqual(at, [0, 2, 4]);
  assert.equal(usage.turnEnded('opencode'), false);
  usage.stop();
}));

test('the turn-end watch: running -> done or idle of a Claude or Codex terminal', () => {
  const ended = [];
  let agent = 'claude';
  const watch = createTurnEndWatch({ agentOf: () => agent, onTurnEnd: name => ended.push(name) });
  for (const state of ['running', 'done', 'idle', 'running', 'idle']) watch(state);
  assert.deepEqual(ended, ['claude', 'claude']);
  agent = 'codex';
  watch('running'); watch('done');
  agent = 'opencode';
  watch('running'); watch('done');
  agent = null;
  watch('running'); watch('done');
  assert.deepEqual(ended, ['claude', 'claude', 'codex']);
  const broken = createTurnEndWatch({ agentOf: () => { throw new Error('x'); }, onTurnEnd: () => { throw new Error('never'); } });
  broken('running');
  assert.equal(broken('done'), null);
  const throwing = createTurnEndWatch({ agentOf: () => 'claude', onTurnEnd: () => { throw new Error('reading failed'); } });
  throwing('running');
  assert.equal(throwing('done'), 'claude', 'a failing listener never reaches the terminal');
});

// ── HTTP: /api/agent-usage, /v1/agent-usage with a token, /api/remote-servers/:id/agent-usage ──

const servers = [];
function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('listening', () => { servers.push(server); resolve(`http://127.0.0.1:${server.address().port}`); });
    server.once('error', reject);
  });
}

test('HTTP: the local route, /v1 with a token, the forward, and 501 for an older engine', async t => {
  t.after(async () => {
    usageLib.setAgentUsage(null);
    await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); })));
  });
  const claude = fakeAgent(() => windows(25, 50));
  const { usage } = setup({ claude, installed: { claude: true, codex: false } });
  usageLib.setAgentUsage(usage);
  const { createAccessToken } = require('../services/engine-auth');
  const { encryptToken } = require('../lib/token-crypto');
  const localApp = express();
  localApp.use(express.json());
  localApp.use('/api/agent-usage', require('../routes/agent-usage').createAgentUsageRouter());
  const localBase = await listen(localApp);
  const engineApp = express();
  engineApp.use(express.json());
  engineApp.use('/v1', require('../routes/engine-v1'));
  const engineBase = await listen(engineApp);
  const token = createAccessToken(db, { role: 'operator', principalId: 'owner' }).token;
  const remoteId = db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
    .run('owner', 'engine', engineBase, encryptToken(token, process.env.SESSION_SECRET)).lastInsertRowid;
  const oldApp = express();
  const oldHits = [];
  oldApp.use((req, res, next) => { oldHits.push(`${req.method} ${req.path}`); next(); });
  oldApp.get('/v1/info', (req, res) => res.json({ capabilities: ['tasks:read'] }));
  const oldId = db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
    .run('owner', 'old', await listen(oldApp), encryptToken(token, process.env.SESSION_SECRET)).lastInsertRowid;
  const proxyApp = express();
  proxyApp.use(express.json());
  proxyApp.use('/api/remote-servers', require('../routes/remote-servers'));
  const proxyBase = await listen(proxyApp);
  const bearer = { Authorization: `Bearer ${token}` };

  const local = await fetch(`${localBase}/api/agent-usage/refresh`, { method: 'POST' });
  assert.equal(local.status, 200);
  assert.equal(local.headers.get('cache-control'), 'no-store');
  const body = await local.json();
  assert.deepEqual(body.engine, { instance_id: 'engine-1', name: 'T01' });
  assert.deepEqual(body.agents.map(entry => [entry.agent, entry.state, entry.windows.map(win => win.usedPercent)]), [['claude', 'ok', [25, 50]]]);
  assert.deepEqual(await (await fetch(`${localBase}/api/agent-usage`)).json(), body);

  assert.equal((await fetch(`${engineBase}/v1/agent-usage`)).status, 401);
  const info = await (await fetch(`${engineBase}/v1/info`, { headers: bearer })).json();
  assert.ok(info.capabilities.includes(CAPABILITY));
  assert.deepEqual(await (await fetch(`${engineBase}/v1/agent-usage`, { headers: bearer })).json(), body);
  const engineRefresh = await fetch(`${engineBase}/v1/agent-usage/refresh`, { method: 'POST', headers: bearer });
  assert.equal(engineRefresh.status, 200);

  assert.deepEqual(await (await fetch(`${proxyBase}/api/remote-servers/${remoteId}/agent-usage`)).json(), body);
  const forwarded = await fetch(`${proxyBase}/api/remote-servers/${remoteId}/agent-usage/refresh`, { method: 'POST' });
  assert.equal(forwarded.status, 200);
  assert.equal((await forwarded.json()).agents[0].agent, 'claude');
  for (const [method, suffix] of [['GET', ''], ['POST', '/refresh']]) {
    const old = await fetch(`${proxyBase}/api/remote-servers/${oldId}/agent-usage${suffix}`, { method });
    assert.equal(old.status, 501);
    assert.deepEqual(await old.json(), { error: 'AGENT_USAGE_UNSUPPORTED' });
  }
  assert.ok(!oldHits.some(hit => hit.includes('agent-usage')), 'nothing is sent to an engine without the capability');
  assert.equal((await fetch(`${proxyBase}/api/remote-servers/999999/agent-usage`)).status, 404);
});
