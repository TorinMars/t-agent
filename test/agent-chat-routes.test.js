const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-chat-routes-'));
process.env.T_AGENT_DATA_DIR = root;
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
const db = require('../db');
const tasks = require('../services/engine-tasks');
const { createAgentChat } = require('../services/agent-chat');
const { createAgentChatRouter } = require('../routes/agent-chat');

const mine = tasks.createTask('owner', { title: 'mine' });
const theirs = tasks.createTask('someone-else', { title: 'theirs' });
const adapter = {
  MODES: { ask: {}, full: {} }, DEFAULT_MODE: 'ask',
  loadHistory: async () => [],
  runTurn: async ({ ctx }) => { ctx.upsert({ id: 'a1', kind: 'text', text: 'pong' }); return { ok: true }; },
};
const app = express();
app.use(express.json());
app.use('/api/tasks/:id/agent', createAgentChatRouter({ service: createAgentChat({ db, adapters: { claude: adapter } }), authenticate: (req, res, next) => { req.session = { user: { login: 'owner' } }; next(); } }));
const server = http.createServer(app);
let base;
test.before(async () => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test('conversations are created, listed, messaged and renamed through the API', async () => {
  const url = `/api/tasks/${mine.id}/agent`;
  const created = await call('POST', `${url}/conversations`, { agent: 'claude' });
  assert.equal(created.status, 200);
  const id = created.body.id;
  assert.deepEqual((await call('GET', `${url}/conversations`)).body.map(row => row.id), [id]);

  // Follow the events like the browser does: snapshot first, then the stream after its sequence number.
  const snapshot = (await call('GET', `${url}/conversations/${id}`)).body;
  const response = await fetch(`${base}${url}/conversations/${id}/events?after=${snapshot.seq}`);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body.getReader();
  assert.equal((await call('POST', `${url}/conversations/${id}/messages`, { text: 'ping' })).status, 200);
  let streamed = '';
  const decoder = new TextDecoder();
  while (!/"status":"idle"/.test(streamed)) {
    const { value, done } = await reader.read();
    if (done) break;
    streamed += decoder.decode(value);
  }
  await reader.cancel();
  assert.match(streamed, /"op":"upsert"[^\n]*"text":"ping"/);
  assert.match(streamed, /"text":"pong"/);

  assert.equal((await call('PATCH', `${url}/conversations/${id}`, { title: 'Renamed', mode: 'full' })).body.mode, 'full');
  assert.equal((await call('GET', `${url}/conversations/${id}`)).body.conversation.title, 'Renamed');
  assert.equal((await call('POST', `${url}/conversations/${id}/messages`, { text: '' })).body.error, 'EMPTY_MESSAGE');
  assert.equal((await call('POST', `${url}/conversations`, { agent: 'bash' })).body.error, 'INVALID_AGENT');
  assert.equal((await call('DELETE', `${url}/conversations/${id}`)).status, 200);
  assert.equal((await call('GET', `${url}/conversations/${id}`)).status, 404, 'a deleted conversation is gone');
});

test('another person\'s task is not reachable', async () => {
  const res = await call('GET', `/api/tasks/${theirs.id}/agent/conversations`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'TASK_NOT_FOUND');
});

test('the event stream of an unknown conversation says so', async () => {
  const text = await (await fetch(`${base}/api/tasks/${mine.id}/agent/conversations/missing/events`)).text();
  assert.match(text, /event: gone/);
});
