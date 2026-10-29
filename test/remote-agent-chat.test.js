// Exercise the actual Engine router and Client proxy with an adapter that never calls a paid CLI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-remote-chat-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'remote-chat-test-secret-remote-chat-test-secret';
const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports(req, res, next) { req.session = { user: { login: 'owner' } }; next(); } };
const express = require('express');
const db = require('../db');
const tasks = require('../services/engine-tasks');
const chatModule = require('../services/agent-chat');
const { createAccessToken } = require('../services/engine-auth');
const { encryptToken } = require('../lib/token-crypto');
const calls = [];
const adapter = {
  MODES: { ask: {}, full: {} }, DEFAULT_MODE: 'ask',
  loadHistory: async () => [{ id: 'history', kind: 'text', text: 'remote history' }],
  listModels: async () => [{ value: 'test-model', label: 'Test model', efforts: ['high'] }],
  runTurn: async ({ ctx, prompt, cwd, signal, requestPermission }) => {
    calls.push({ prompt, workDir: cwd, signal });
    ctx.upsert({ id: 'reply', kind: 'text', text: 'remote reply' });
    const answer = await requestPermission({ tool: 'Bash', input: { command: 'pwd' } });
    if (!signal.aborted) ctx.upsert({ id: 'answer', kind: 'text', text: answer.allow ? 'allowed' : 'denied' });
    return { ok: !signal.aborted };
  },
};
const service = chatModule.createAgentChat({ db, adapters: { claude: adapter, codex: adapter } });
chatModule.getAgentChat = () => service;
const servers = [];
const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); servers.push(server); });
let engine, proxy, token, remoteId, privateRemoteId;
const mine = tasks.createTask('owner', { title: 'remote chat' });
const second = tasks.createTask('owner', { title: 'another task' });
const theirs = tasks.createTask('other', { title: 'private' });
test.before(async () => {
  const app = express(); app.use(express.json()); app.use('/v1', require('../routes/engine-v1')); engine = await listen(app);
  token = createAccessToken(db, { principalId: 'owner' }).token;
  const insert = owner => db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)').run(owner, 'Engine', engine, encryptToken(token, process.env.SESSION_SECRET)).lastInsertRowid;
  remoteId = insert('owner'); privateRemoteId = insert('other');
  const client = express(); client.use(express.json()); client.use('/api/remote-servers', require('../routes/remote-servers')); proxy = await listen(client);
});
test.after(async () => {
  service.stopTask(mine.id);
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});
const targets = () => [
  { base: engine, prefix: '/v1', headers: { Authorization: `Bearer ${token}` } },
  { base: proxy, prefix: `/api/remote-servers/${remoteId}`, headers: {} },
];
async function call(target, method, suffix, body) {
  const response = await fetch(target.base + target.prefix + suffix, { method, headers: { ...target.headers, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000) });
  return { status: response.status, body: await response.json() };
}
async function snapshotWhen(target, url, predicate) {
  for (let i = 0; i < 100; i++) {
    const state = (await call(target, 'GET', url)).body;
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for conversation state');
}

test('Engine and proxy support creation, history, model selection, approvals, replay and interruption for both agents', async () => {
  for (const target of targets()) {
    assert.ok((await call(target, 'GET', '/info')).body.capabilities.includes('agent-chat:manage'));
    for (const agent of ['claude', 'codex']) {
      const base = `/tasks/${mine.id}/agent`;
      const created = await call(target, 'POST', `${base}/conversations`, { agent });
      assert.equal(created.status, 200);
      const id = created.body.id;
      const url = `${base}/conversations/${id}`;
      assert.ok((await call(target, 'GET', `${base}/conversations`)).body.some(row => row.id === id));
      assert.equal((await call(target, 'GET', `${base}/sessions?agent=${agent}`)).status, 200);
      assert.equal((await call(target, 'GET', `${url}/models`)).body.models[1].value, 'test-model');
      assert.equal((await call(target, 'PATCH', url, { model: 'test-model', effort: 'high', mode: 'full', title: 'Remote' })).status, 200);
      assert.equal((await call(target, 'GET', url)).body.conversation.title, 'Remote');
      await call(target, 'PATCH', url, { opened: true, surface: 'web' });
      assert.ok((await call(target, 'GET', url)).body.conversation.opened.web > 0);
      await call(target, 'PATCH', url, { opened: false, surface: 'web' });
      assert.equal((await call(target, 'GET', url)).body.conversation.opened.web, null);
      const reset = await fetch(target.base + target.prefix + `${url}/events?after=-1`, { headers: target.headers, signal: AbortSignal.timeout(8000) });
      assert.match(await reset.text(), /event: reset/);
      assert.equal((await call(target, 'POST', `${url}/messages`, { text: 'remote prompt' })).status, 200);
      const pending = await snapshotWhen(target, url, state => state.pending?.length);
      assert.equal(calls.at(-1).workDir, mine.work_dir, 'the Engine task supplies the working directory');
      // Reconnect after an existing sequence: old prompt events must not be replayed.
      const response = await fetch(target.base + target.prefix + `${url}/events?after=${pending.seq}`, { headers: target.headers, signal: AbortSignal.timeout(8000) });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/event-stream');
      assert.equal((await call(target, 'POST', `${url}/permissions/${pending.pending[0].id}`, { allow: true })).status, 200);
      const reader = response.body.getReader(); let received = '';
      while (!received.includes('"status":"idle"')) { const { value, done } = await reader.read(); if (done) break; received += new TextDecoder().decode(value); }
      await reader.cancel();
      assert.match(received, /allowed/);
      assert.doesNotMatch(received, /remote prompt/);
      assert.equal((await call(target, 'POST', `${url}/messages`, { text: 'stop this' })).status, 200);
      await snapshotWhen(target, url, state => state.pending?.length);
      assert.equal((await call(target, 'POST', `${url}/interrupt`, {})).status, 200);
      const stopped = await snapshotWhen(target, url, state => state.status === 'idle');
      assert.deepEqual(stopped.pending, []);
      assert.equal((await call(target, 'GET', `/tasks/${second.id}/agent/conversations/${id}`)).status, 404);
      assert.equal((await call(target, 'DELETE', url)).status, 200);
      assert.equal((await call(target, 'GET', url)).body.error, 'CONVERSATION_NOT_FOUND');
      const resumed = await call(target, 'POST', `${base}/conversations`, { agent, session_id: `session-${agent}-${target.prefix.replace(/\W/g, '')}` });
      const history = await call(target, 'GET', `${base}/conversations/${resumed.body.id}`);
      assert.equal(history.body.items[0].text, 'remote history');
    }
  }
});

test('the queue operations reach the Engine through the Client proxy too', async () => {
  const [direct, viaProxy] = targets();
  for (const target of [direct, viaProxy]) {
    const base = `/tasks/${mine.id}/agent`;
    const id = (await call(target, 'POST', `${base}/conversations`, { agent: 'claude' })).body.id;
    const url = `${base}/conversations/${id}`;
    assert.equal((await call(target, 'GET', url)).body.capabilities.serverQueue, true);
    await call(target, 'POST', `${url}/queue`, { queue: [{ id: 1, body: { text: 'one' } }, { id: 2, body: { text: 'two' } }, { id: 3, body: { text: 'three' } }] });
    assert.deepEqual((await call(target, 'POST', `${url}/queue/1/edit`, { text: 'uno' })).body, { success: true });
    assert.deepEqual((await call(target, 'POST', `${url}/queue/2/remove`, {})).body, { success: true });
    assert.deepEqual((await call(target, 'POST', `${url}/queue/add`, { body: { text: 'four' } })).body.success, true);
    assert.deepEqual((await call(target, 'GET', url)).body.queue.map(entry => [entry.id, entry.body.text]), [[1, 'uno'], [3, 'three'], [4, 'four']]);
    assert.equal((await call(target, 'POST', `${url}/queue/99/send`, {})).status, 404);
    await call(target, 'POST', `${url}/queue`, { queue: [] });
    assert.equal((await call(target, 'DELETE', url)).status, 200);
  }
});

test('tokens, connection ownership and task ownership are enforced, including streams', async () => {
  const [direct, proxied] = targets();
  const noToken = await fetch(`${engine}/v1/tasks/${mine.id}/agent/conversations`);
  assert.equal(noToken.status, 401);
  const badToken = await fetch(`${engine}/v1/tasks/${mine.id}/agent/conversations/x/events`, { headers: { Authorization: 'Bearer invalid' } });
  assert.equal(badToken.status, 401);
  assert.equal((await call({ ...proxied, prefix: `/api/remote-servers/${privateRemoteId}` }, 'POST', `/tasks/${mine.id}/agent/conversations`, { agent: 'claude' })).status, 404);
  for (const target of [direct, proxied]) {
    assert.equal((await call(target, 'POST', `/tasks/${theirs.id}/agent/conversations`, { agent: 'claude' })).status, 404);
    assert.equal((await call(target, 'GET', `/tasks/${theirs.id}/agent/conversations/x/events`)).status, 404);
    const response = await fetch(target.base + target.prefix + `/tasks/${mine.id}/agent/conversations/missing/events`, { headers: target.headers });
    assert.match(await response.text(), /event: gone/);
  }
});

test('deleting a task through the Engine interrupts pending chat work', async () => {
  const target = targets()[1];
  const base = `/tasks/${mine.id}/agent/conversations`;
  const id = (await call(target, 'POST', base, { agent: 'claude' })).body.id;
  await call(target, 'POST', `${base}/${id}/messages`, { text: 'pending' });
  await snapshotWhen(target, `${base}/${id}`, state => state.pending?.length);
  const running = calls.at(-1);
  assert.equal(running.signal.aborted, false);
  assert.equal((await call(target, 'DELETE', `/tasks/${mine.id}`)).status, 200);
  assert.equal(running.signal.aborted, true, 'deletion aborts the adapter on the Engine');
  assert.equal((await call(target, 'GET', `${base}/${id}`)).status, 404);
});
