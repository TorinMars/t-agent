const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-terminal-api-'));
process.env.T_AGENT_DATA_DIR = root;
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
const db = require('../db');
const { createEngineApp } = require('../apps/engine/app');
const { createAccessToken } = require('../services/engine-auth');
const { consumeTerminalTicket } = require('../services/terminal-tickets');
const { assertRemoteTerminal } = require('../services/remote-client');
const tasks = require('../services/engine-tasks');

test('Engine terminal API enforces ownership and scopes, persists tabs and binds tickets', async () => {
  const server = createEngineApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const owner = createAccessToken(db, { role: 'operator', principalId: 'owner' }).token;
    const reader = createAccessToken(db, { role: 'readonly', principalId: 'owner' }).token;
    const stranger = createAccessToken(db, { role: 'operator', principalId: 'stranger' }).token;
    const task = tasks.createTask('owner', { title: 'API task' });
    const url = `/v1/tasks/${task.id}/terminals`;
    const request = (route, token = owner, body) => fetch(base + route, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal((await request(url, reader, {})).status, 403);
    assert.equal((await request(url, stranger, {})).status, 404);
    assert.equal((await request(url, 'invalid')).status, 401);
    const response = await request(url, owner, {});
    assert.equal(response.status, 201);
    const added = await response.json();
    assert.equal(added.title, '终端 2');
    assert.equal((await (await request(url)).json()).length, 2);
    await assertRemoteTerminal(base, owner, task.id, added.terminal_id);
    await assert.rejects(assertRemoteTerminal(base, owner, task.id, 'unknown'), /TERMINAL_NOT_FOUND/);
    const ticketResponse = await request('/v1/terminal-sessions', owner, { task_id: task.id, terminal_id: added.terminal_id });
    assert.equal(ticketResponse.status, 201);
    const { ticket } = await ticketResponse.json();
    assert.equal(consumeTerminalTicket(ticket).terminalId, added.terminal_id);
    assert.equal((await request('/v1/terminal-sessions', owner, { task_id: task.id, terminal_id: 'unknown' })).status, 404);
    assert.equal((await request(`/v1/terminal-sessions/${task.id}/control`, owner, { action: 'close', terminal_id: added.terminal_id })).status, 200);
    const controlUrl = `/v1/terminal-sessions/${task.id}/control`;
    const deletion = { action: 'delete', terminal_id: added.terminal_id };
    assert.equal((await request(controlUrl, reader, deletion)).status, 403);
    assert.equal((await request(controlUrl, stranger, deletion)).status, 404);
    assert.equal((await request(controlUrl, owner, deletion)).status, 200);
    assert.equal((await (await request(url)).json()).length, 1);
    assert.equal((await request('/v1/terminal-sessions', owner, { task_id: task.id, terminal_id: added.terminal_id })).status, 404);
    assert.equal((await request(controlUrl, owner, { action: 'delete', terminal_id: 'default' })).status, 400);
    tasks.deleteTask('owner', task.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_terminals').get().n, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
