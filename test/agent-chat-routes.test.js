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
const { createAgentChatRouter, createAgentChatSummaryRouter } = require('../routes/agent-chat');

const mine = tasks.createTask('owner', { title: 'mine' });
const theirs = tasks.createTask('someone-else', { title: 'theirs' });
const adapter = {
  MODES: { ask: {}, full: {} }, DEFAULT_MODE: 'ask',
  loadHistory: async () => [],
  runTurn: async ({ ctx }) => { ctx.upsert({ id: 'a1', kind: 'text', text: 'pong' }); return { ok: true }; },
  listModels: async () => [{ value: 'sonnet', label: 'Sonnet 5.5', description: '', efforts: ['low', 'high'], defaultEffort: '' }],
};
const app = express();
app.use(express.json());
const service = createAgentChat({ db, adapters: { claude: adapter } });
app.use('/api/agent-chat', createAgentChatSummaryRouter({ service, authenticate: (req, res, next) => { req.session = { user: { login: 'owner' } }; next(); } }));
app.use('/api/tasks/:id/agent', createAgentChatRouter({ service, authenticate: (req, res, next) => { req.session = { user: { login: 'owner' } }; next(); } }));
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

test('the model and effort of a chat are chosen with PATCH and the model list is read with GET', async () => {
  const url = `/api/tasks/${mine.id}/agent`;
  const id = (await call('POST', `${url}/conversations`, { agent: 'claude' })).body.id;
  const models = await call('GET', `${url}/conversations/${id}/models`);
  assert.equal(models.status, 200);
  assert.deepEqual(models.body.models.map(model => model.value), ['', 'sonnet']);
  assert.deepEqual(models.body.chosen, { model: '', effort: '' });

  const saved = await call('PATCH', `${url}/conversations/${id}`, { model: 'sonnet', effort: 'high' });
  assert.deepEqual([saved.status, saved.body.model, saved.body.effort], [200, 'sonnet', 'high']);
  assert.deepEqual((await call('GET', `${url}/conversations/${id}/models`)).body.chosen, { model: 'sonnet', effort: 'high' });
  assert.deepEqual((await call('GET', `${url}/conversations/${id}`)).body.conversation.model, 'sonnet');
  const invalid = await call('PATCH', `${url}/conversations/${id}`, { model: 'not valid!' });
  assert.deepEqual([invalid.status, invalid.body.error], [400, 'INVALID_MODEL']);
  assert.equal((await call('PATCH', `${url}/conversations/${id}`, { effort: 'Max!' })).body.error, 'INVALID_EFFORT');
  const both = await call('PATCH', `${url}/conversations/${id}`, { title: 'Chosen', mode: 'full', model: '' });
  assert.deepEqual([both.body.title, both.body.mode, both.body.model], ['Chosen', 'full', undefined], 'title, mode and model can change in one request');

  assert.equal((await call('GET', `/api/tasks/${theirs.id}/agent/conversations/${id}/models`)).status, 404, 'a task of someone else');
  assert.equal((await call('GET', `${url}/conversations/missing/models`)).body.error, 'CONVERSATION_NOT_FOUND');
});

test('a chat is opened and closed on a page with PATCH, and the list says where it is open', async () => {
  const url = `/api/tasks/${mine.id}/agent`;
  const id = (await call('POST', `${url}/conversations`, { agent: 'claude' })).body.id;
  assert.deepEqual((await call('GET', `${url}/conversations`)).body.find(row => row.id === id).opened, { web: null, h5: null });
  const opened = await call('PATCH', `${url}/conversations/${id}`, { opened: true, surface: 'h5' });
  assert.deepEqual([opened.status, opened.body.opened.web, opened.body.opened.h5 > 0], [200, null, true]);
  assert.equal((await call('GET', `${url}/conversations`)).body.find(row => row.id === id).opened.h5 > 0, true);
  assert.equal((await call('PATCH', `${url}/conversations/${id}`, { opened: false, surface: 'h5' })).body.opened.h5, null);
  assert.equal((await call('PATCH', `${url}/conversations/${id}`, { opened: true, surface: 'tablet' })).body.error, 'INVALID_SURFACE');
  assert.equal((await call('PATCH', `${url}/conversations/${id}`, { opened: 'yes', surface: 'web' })).body.error, 'INVALID_OPENED');
  assert.equal((await call('PATCH', `/api/tasks/${theirs.id}/agent/conversations/${id}`, { opened: true, surface: 'web' })).status, 404);
});

test('a chat is also opened and closed on a page with POST .../opened, which the phone page uses first', async () => {
  const url = `/api/tasks/${mine.id}/agent`;
  const id = (await call('POST', `${url}/conversations`, { agent: 'claude' })).body.id;
  const opened = await call('POST', `${url}/conversations/${id}/opened`, { opened: true, surface: 'h5' });
  assert.deepEqual([opened.status, opened.body.opened.h5 > 0], [200, true]);
  assert.equal((await call('GET', `${url}/conversations`)).body.find(row => row.id === id).opened.h5 > 0, true);
  assert.equal((await call('POST', `${url}/conversations/${id}/opened`, { opened: false, surface: 'h5' })).body.opened.h5, null);
  assert.equal((await call('POST', `${url}/conversations/${id}/opened`, { opened: true, surface: 'tablet' })).body.error, 'INVALID_SURFACE');
  assert.equal((await call('POST', `/api/tasks/${theirs.id}/agent/conversations/${id}/opened`, { opened: true, surface: 'h5' })).status, 404);
});

test('the translation switch of a chat is saved with PATCH and comes back with the chat', async () => {
  const url = `/api/tasks/${mine.id}/agent`;
  const id = (await call('POST', `${url}/conversations`, { agent: 'claude' })).body.id;
  assert.equal((await call('GET', `${url}/conversations/${id}`)).body.conversation.translate, false);
  const on = await call('PATCH', `${url}/conversations/${id}`, { translate: true });
  assert.deepEqual([on.status, on.body.translate], [200, true]);
  assert.equal((await call('GET', `${url}/conversations/${id}`)).body.conversation.translate, true);
  assert.equal((await call('PATCH', `${url}/conversations/${id}`, { translate: 'on' })).body.error, 'INVALID_TRANSLATE');
  assert.equal((await call('PATCH', `${url}/conversations/${id}`, { translate: false })).body.translate, false);
});

test('the queue of a chat is saved with POST and comes back with the chat', async () => {
  const url = `/api/tasks/${mine.id}/agent`;
  const id = (await call('POST', `${url}/conversations`, { agent: 'claude' })).body.id;
  assert.deepEqual((await call('GET', `${url}/conversations/${id}`)).body.queue, []);
  const saved = await call('POST', `${url}/conversations/${id}/queue`, { queue: [{ id: 3, label: 'later', body: { text: 'later' } }] });
  assert.deepEqual([saved.status, saved.body], [200, { success: true, count: 1 }]);
  assert.deepEqual((await call('GET', `${url}/conversations/${id}`)).body.queue.map(entry => [entry.id, entry.body.text]), [[3, 'later']]);
  assert.equal((await call('POST', `${url}/conversations/${id}/queue`, { queue: 'x' })).body.error, 'INVALID_QUEUE');
  assert.equal((await call('POST', `${url}/conversations/${id}/queue`, {})).body.error, 'INVALID_QUEUE');
  assert.deepEqual((await call('POST', `${url}/conversations/${id}/queue`, { queue: [] })).body, { success: true, count: 0 });
});

test('the queue is changed with operations: add, edit, remove and send now, and the chat says the Client sends the queue itself', async () => {
  const url = `/api/tasks/${mine.id}/agent`;
  const id = (await call('POST', `${url}/conversations`, { agent: 'claude' })).body.id;
  assert.equal((await call('GET', `${url}/conversations/${id}`)).body.capabilities.serverQueue, true, 'a page learns it need not send the queue itself');
  // Nothing is running, so the first message goes out at once and the queue stays empty.
  const first = await call('POST', `${url}/conversations/${id}/queue/add`, { body: { text: 'goes at once' } });
  assert.deepEqual([first.status, first.body.success, typeof first.body.id], [200, true, 'number']);
  for (let i = 0; i < 200 && (await call('GET', `${url}/conversations/${id}`)).body.items.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual((await call('GET', `${url}/conversations/${id}`)).body.queue, []);
  // Bad input is refused like a message that is sent.
  assert.equal((await call('POST', `${url}/conversations/${id}/queue/add`, { body: { text: '' } })).status, 400);
  assert.equal((await call('POST', `${url}/conversations/${id}/queue/add`, {})).body.error, 'INVALID_QUEUE');
  // Edit, remove and send now on an entry that is waiting (put there with the whole-list call, which does not send).
  await call('POST', `${url}/conversations/${id}/queue`, { queue: [{ id: 5, body: { text: 'old text' } }, { id: 6, body: { text: 'other' } }] });
  assert.deepEqual((await call('POST', `${url}/conversations/${id}/queue/5/edit`, { text: 'new text' })).body, { success: true });
  assert.equal((await call('POST', `${url}/conversations/${id}/queue/5/edit`, { text: '  ' })).body.error, 'INVALID_QUEUE');
  assert.equal((await call('POST', `${url}/conversations/${id}/queue/77/edit`, { text: 'x' })).status, 404);
  assert.deepEqual((await call('GET', `${url}/conversations/${id}`)).body.queue.map(entry => entry.body.text), ['new text', 'other']);
  assert.deepEqual((await call('POST', `${url}/conversations/${id}/queue/6/remove`, {})).body, { success: true });
  assert.deepEqual((await call('POST', `${url}/conversations/${id}/queue/5/send`, {})).body, { success: true });
  assert.equal((await call('POST', `${url}/conversations/${id}/queue/5/send`, {})).status, 404, 'the entry is gone');
  for (let i = 0; i < 200 && (await call('GET', `${url}/conversations/${id}`)).body.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual((await call('GET', `${url}/conversations/${id}`)).body.queue, []);
  // Someone else's chat cannot be reached.
  const other = (await call('POST', `/api/tasks/${theirs.id}/agent/conversations`, { agent: 'claude' })).status;
  assert.equal(other, 404);
});

test('the summary of what the agents are doing is read with GET, for the signed-in person only', async () => {
  const base0 = (await call('GET', '/api/agent-chat/summary')).body;
  assert.deepEqual(Object.keys(base0).sort(), ['queued', 'running', 'submitted']);
  const id = (await call('POST', `/api/tasks/${mine.id}/agent/conversations`, { agent: 'claude' })).body.id;
  await call('POST', `/api/tasks/${mine.id}/agent/conversations/${id}/queue`, { queue: [{ id: 1, body: { text: 'one' } }, { id: 2, body: { text: 'two' } }] });
  const other = service.create(theirs, { agent: 'claude' });
  service.setQueue(theirs, other.id, [{ id: 1, body: { text: 'theirs' } }]);
  const after = (await call('GET', '/api/agent-chat/summary')).body;
  assert.equal(after.queued - base0.queued, 2, 'only the signed-in person\'s messages are counted');
  assert.equal(after.submitted, after.running + after.queued);
  assert.equal((await fetch(`${base}/api/agent-chat/summary`)).headers.get('cache-control'), 'no-store');
});

test('the slash commands of a chat are read with GET', async () => {
  const url = `/api/tasks/${mine.id}/agent`;
  const id = (await call('POST', `${url}/conversations`, { agent: 'claude' })).body.id;
  const answer = await call('GET', `${url}/conversations/${id}/commands`);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { supported: false, commands: [] }, 'the test agent has no commands');
  assert.equal((await call('GET', `${url}/conversations/nope/commands`)).status, 404);
});
