// The OpenCode plugin of T-Agent terminals (scripts/opencode-session-plugin.js, docs/design/opencode-terminals.md), loaded the way opencode 1.19.6
// loads a file:// plugin: a dynamic import of the ES module, then every exported function is called with the plugin context and its `event` hook gets
// { event }. The events below have the shapes opencode 1.19.6 sent in a temp home. fetch is faked; no opencode and no server is started.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-opencode-plugin-'));
process.env.T_AGENT_DATA_DIR = root;
const PLUGIN = path.resolve(__dirname, '..', 'scripts', 'opencode-session-plugin.js');
const URL_ = 'http://127.0.0.1:9/hooks/terminal-activity?task=7&terminal=abc-123';
const DIR = '/work/proj';

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// A fake fetch that records every call; `reach(n)` resolves once n calls were made (no polling).
function fakeFetch({ fail = false } = {}) {
  const calls = [];
  const waiting = [];
  const fetch = async (url, init) => {
    const target = new URL(url);
    calls.push({ path: target.pathname, query: Object.fromEntries(target.searchParams), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    for (const entry of waiting.filter(item => calls.length >= item.n)) { waiting.splice(waiting.indexOf(entry), 1); entry.resolve(); }
    if (fail) throw new Error('ECONNREFUSED');
    return { body: { cancel: async () => {} } };
  };
  return { calls, fetch, reach: n => (calls.length >= n ? Promise.resolve() : new Promise(resolve => waiting.push({ n, resolve }))) };
}

// A fake SDK client in the v1 form opencode 1.19.6 gives plugins: session.get / session.update take { path: { id }, body }.
function fakeClient(sessions = {}) {
  const updates = [];
  return {
    updates,
    session: {
      async get({ path: { id } }) { return sessions[id] ? { data: sessions[id] } : { error: { name: 'NotFoundError' } }; },
      async update({ path: { id }, body }) { updates.push({ id, ...body }); if (sessions[id]) Object.assign(sessions[id], body); return { data: sessions[id] }; },
    },
  };
}

async function load(env, client) {
  const saved = {};
  for (const key of ['TA_HOOK_URL', 'TA_HOOK_TOKEN', 'TA_SESSION_NAME']) { saved[key] = process.env[key]; delete process.env[key]; }
  Object.assign(process.env, env);
  try {
    const mod = await import(`${pathToFileURL(PLUGIN).href}?v=${Math.random()}`);
    const factories = Object.values(mod).filter(value => typeof value === 'function');
    assert.equal(factories.length, 1, 'one plugin function is exported');
    return await factories[0]({ client, project: {}, worktree: '/', directory: DIR, experimental_workspace: {}, serverUrl: new URL('http://opencode.internal'), $: null });
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

const created = (id, extra = {}) => ({ type: 'session.created', properties: { sessionID: id, info: { id, directory: DIR, title: 'New session - 2026-11-22T19:53:07.462Z', ...extra } } });
const status = (id, type) => ({ type: 'session.status', properties: { sessionID: id, status: { type } } });
const event = (type, id, extra = {}) => ({ type, properties: { sessionID: id, ...extra } });
const short = call => [call.query.event, call.query.kind, call.query.via].filter(Boolean).join(':');

let originalFetch;
test.beforeEach(() => { originalFetch = globalThis.fetch; });
test.afterEach(() => { globalThis.fetch = originalFetch; });

test('outside a T-Agent terminal the plugin has no hooks and sends nothing', async () => {
  const net = fakeFetch();
  globalThis.fetch = net.fetch;
  assert.deepEqual(await load({}, fakeClient()), {});
  assert.deepEqual(await load({ TA_HOOK_URL: URL_ }, fakeClient()), {}, 'no token');
  assert.deepEqual(await load({ TA_HOOK_URL: 'not a url', TA_HOOK_TOKEN: 't' }, fakeClient()), {});
  assert.deepEqual(await load({ TA_HOOK_URL: 'file:///etc/passwd', TA_HOOK_TOKEN: 't' }, fakeClient()), {});
  assert.equal(net.calls.length, 0);
});

test('the session, the turns, a permission and a question are reported in order, with the token header', async () => {
  const net = fakeFetch();
  globalThis.fetch = net.fetch;
  const client = fakeClient({ ses_a: { id: 'ses_a', directory: DIR } });
  const hooks = await load({ TA_HOOK_URL: URL_, TA_HOOK_TOKEN: 'secret-token' }, client);
  assert.deepEqual(Object.keys(hooks), ['event']);
  for (const item of [
    created('ses_a'), event('session.updated', 'ses_a', { info: { id: 'ses_a' } }), status('ses_a', 'busy'), event('message.part.delta', 'ses_a'),
    event('permission.asked', 'ses_a', { id: 'per_1', permission: 'bash' }), event('permission.replied', 'ses_a', { requestID: 'per_1', reply: 'once' }),
    status('ses_a', 'busy'), status('ses_a', 'idle'), event('session.idle', 'ses_a'),
    status('ses_a', 'busy'), event('question.asked', 'ses_a', { id: 'que_1' }), event('question.replied', 'ses_a', { requestID: 'que_1', answers: [['Red']] }),
    event('question.asked', 'ses_a', { id: 'que_2' }), event('question.rejected', 'ses_a', { requestID: 'que_2' }), event('session.idle', 'ses_a'),
  ]) await hooks.event({ event: item });
  await net.reach(12);
  assert.deepEqual(net.calls.map(short), ['session', 'start', 'attention:accept', 'start', 'start', 'stop', 'start', 'attention:select:tool', 'start',
    'attention:select:tool', 'start', 'stop']);
  const [first] = net.calls;
  assert.deepEqual(first, {
    path: '/hooks/terminal-activity', query: { task: '7', terminal: 'abc-123', event: 'session' }, method: 'POST',
    headers: { 'X-TA-Token': 'secret-token', 'Content-Type': 'application/json' }, body: { session_id: 'ses_a', source: 'startup', cwd: DIR },
  });
  assert.ok(net.calls.slice(1).every(call => call.body === null && call.headers['X-TA-Token'] === 'secret-token' && !call.headers['Content-Type']));
  assert.deepEqual(client.updates, [], 'an unnamed terminal never renames the session');
});

test('/new is source "new", a session picked with /sessions is "resume", and sub-agent sessions never bind', async () => {
  const net = fakeFetch();
  globalThis.fetch = net.fetch;
  const sessions = { ses_old: { id: 'ses_old', directory: '/work/proj' }, ses_child_known: { id: 'ses_child_known', parentID: 'ses_a' } };
  const hooks = await load({ TA_HOOK_URL: URL_, TA_HOOK_TOKEN: 't' }, fakeClient(sessions));
  await hooks.event({ event: created('ses_a') });
  await hooks.event({ event: created('ses_child', { parentID: 'ses_a', title: 'Child session - 2026-11-22T19:53:07.462Z' }) });
  await hooks.event({ event: status('ses_child', 'busy') });
  await hooks.event({ event: event('session.idle', 'ses_child') });
  await hooks.event({ event: status('ses_child_known', 'busy') }); // a child made before this process: asked once
  await hooks.event({ event: event('permission.asked', 'ses_child') }); // a sub-agent's request still needs the person
  await hooks.event({ event: created('ses_b') });
  await hooks.event({ event: status('ses_b', 'busy') });
  await hooks.event({ event: status('ses_old', 'busy') });
  await hooks.event({ event: status('ses_old', 'busy') });
  await net.reach(7);
  assert.deepEqual(net.calls.map(call => (call.body ? `session:${call.body.session_id}:${call.body.source}` : short(call))), [
    'session:ses_a:startup', 'attention:accept', 'session:ses_b:new', 'start', 'session:ses_old:resume', 'start', 'start']);
});

test('a named terminal names the sessions it makes and the one it was started with, but not one picked later', async () => {
  const net = fakeFetch();
  globalThis.fetch = net.fetch;
  const sessions = {
    ses_resumed: { id: 'ses_resumed', directory: DIR, title: 'Generated title' },
    ses_picked: { id: 'ses_picked', directory: DIR, title: 'Another one' },
    ses_same: { id: 'ses_same', directory: DIR, title: 'Named \u540d "q" $x' },
  };
  const client = fakeClient(sessions);
  const name = 'Named \u540d "q" $x';
  const resumed = await load({ TA_HOOK_URL: URL_, TA_HOOK_TOKEN: 't', TA_SESSION_NAME: name }, client);
  await resumed.event({ event: status('ses_resumed', 'busy') }); // `opencode -s ses_resumed`
  await resumed.event({ event: status('ses_picked', 'busy') });
  await resumed.event({ event: created('ses_new') });
  await resumed.event({ event: event('session.idle', 'ses_new') }); // sent after the rename of ses_new
  await net.reach(6);
  assert.deepEqual(client.updates, [{ id: 'ses_resumed', title: name }, { id: 'ses_new', title: name }]);
  assert.equal(sessions.ses_picked.title, 'Another one');

  const same = await load({ TA_HOOK_URL: URL_, TA_HOOK_TOKEN: 't', TA_SESSION_NAME: name }, client);
  await same.event({ event: status('ses_same', 'busy') });
  await net.reach(8);
  assert.equal(client.updates.length, 2, 'a session that already has the name is not written again');
});

test('a failing network, a failing client and odd events never throw into opencode', async () => {
  const down = fakeFetch({ fail: true });
  globalThis.fetch = down.fetch;
  const client = { session: { get: async () => { throw new Error('boom'); }, update: async () => { throw new Error('boom'); } } };
  const hooks = await load({ TA_HOOK_URL: URL_, TA_HOOK_TOKEN: 't', TA_SESSION_NAME: 'X' }, client);
  for (const item of [undefined, null, {}, { type: 'session.created' }, { type: 'session.created', properties: { info: { id: 5 } } }, { type: 'session.status', properties: {} },
    created('ses_a'), status('ses_unknown', 'busy'), event('session.idle', 'ses_a')]) {
    await hooks.event({ event: item });
  }
  await hooks.event(undefined);
  await down.reach(4); // session, resume (a session the client cannot read counts as a root one), start, stop
  assert.deepEqual(down.calls.map(call => (call.body ? call.body.source : short(call))), ['startup', 'resume', 'start', 'stop']);
  const net = fakeFetch();
  globalThis.fetch = net.fetch;
  await hooks.event({ event: event('session.idle', 'ses_a') });
  await net.reach(1);
  assert.deepEqual(net.calls.map(short), ['stop'], 'the queue goes on after failures');
});
