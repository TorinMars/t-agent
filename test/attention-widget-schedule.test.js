// The T-Attention desktop window and scheduled tasks (routes/attention-widget.js): the schedule fields of every item as the owner sends them (this
// machine and a connected service), the name of a prompt's session and of a script's task on this machine, `schedules` on the engines, and the
// window's routes for Send now / Run again (run-now), "Next: ..." (schedule preview) and the form's pop-ups (targets), routed to the item's engine.
// The attention service is a stub here (the server's part of schedules is built separately); nothing depends on the real clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-attention-widget-schedule-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'attention-widget-schedule-secret-attention-widget-schedule';
fs.mkdirSync(process.env.TASKS_BASE_DIR, { recursive: true });

const express = require('express');
const db = require('../db');
const { AttentionError } = require('../services/attention');
const { RemoteAttentionError } = require('../services/remote-attention');
const { createWidgetSettings } = require('../services/attention-widget');
const { createAttentionWidgetRoutes, widgetItem } = require('../routes/attention-widget');

const OWNER = 'owner';
const TOKEN = 'widget-schedule-token-0123456789-abcdefghijkl';
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const servers = [];
test.after(() => { for (const server of servers) server.close(); fs.rmSync(root, { recursive: true, force: true }); });

async function call(method, url, body) {
  const response = await fetch(url, { method, headers: { ...AUTH, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const WEEKLY = { kind: 'repeat', rule: { freq: 'weekly', days: [1], time: '09:00' }, tz: 'Asia/Taipei' };
const ONCE = { kind: 'once', at: '2026-12-01T10:00', tz: 'Asia/Taipei' };

// This machine's T-Attention as a stub with the calls the routes make; `items` as services/attention.js would answer them with schedules.
function stubService(items) {
  const calls = [];
  return {
    calls,
    items,
    list: () => items,
    get: id => items.find(item => item.id === id) || null,
    create: (body, options) => { calls.push(['create', body, options]); const item = { id: 99, status: 'todo', ...body }; return item; },
    update: (id, body) => { calls.push(['update', id, body]); return { ...items.find(item => item.id === id), ...body }; },
    move: () => {},
    remove: () => {},
  };
}

// A connected service answering like services/remote-attention.js `call`.
function stubRemote(items) {
  const calls = [];
  return {
    calls,
    remote: {
      async call(row, { method, path: pathname = '', body }) {
        calls.push({ method, path: pathname, body });
        if (method === 'GET' && pathname.startsWith('?')) return { items, recent_finished: 50 };
        if (method === 'POST' && pathname === '/3/run-now') return { ok: true };
        if (method === 'POST' && pathname === '/4/run-now') throw new RemoteAttentionError(409, { error: 'SESSION_BUSY', message: 'The session is busy' });
        if (method === 'POST' && pathname === '/schedule/preview') return { next: ['2026-11-23T01:00:00.000Z', 'x'.repeat(3), 5], text: 'Every Monday at 09:00' };
        throw new RemoteAttentionError(404, { error: 'NOT_FOUND', message: 'Task not found' });
      },
    },
  };
}

async function widgetApp({ service, remote = stubRemote([]).remote, ...rest }) {
  const routes = createAttentionWidgetRoutes({
    service, remote, db, owner: () => OWNER, settings: createWidgetSettings({ db }),
    launcher: { verifyToken: value => value === TOKEN, setEnabled: async () => {}, status: async () => ({}) },
    localName: () => 'Studio Mac', localInstanceId: () => 'local-instance', remoteInstanceId: row => `instance-${row.name}`,
    copies: () => null, liveTerminals: () => [], liveActivity: () => [],
    ...rest,
  });
  const app = express();
  app.use('/api/attention/widget', routes.bearer);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/api/attention/widget`;
}

const reset = () => {
  db.prepare('DELETE FROM remote_servers').run();
  db.prepare('DELETE FROM task_terminals').run();
  db.prepare('DELETE FROM tasks').run();
};
const remoteRow = name => Number(db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher, enabled) VALUES (?, ?, ?, ?, 1)').run(OWNER, name, `http://${name.toLowerCase()}.test`, 'x').lastInsertRowid);
const task = (id, title) => db.prepare('INSERT INTO tasks (id, title) VALUES (?, ?)').run(id, title);
const terminal = (taskId, terminalId, title) => db.prepare('INSERT INTO task_terminals (task_id, terminal_id, title) VALUES (?, ?, ?)').run(taskId, terminalId, title);

test('widgetItem: the schedule fields as the owner sends them, none for an owner without schedules', () => {
  const plain = widgetItem('local', { id: 1, title: 'Old', status: 'todo' });
  assert.equal('schedule' in plain, false);
  assert.equal('then_target' in plain, false);
  const due = widgetItem('remote:7', {
    id: 2, title: 'Weekly review', status: 'todo', schedule: JSON.stringify(WEEKLY), then_action: null, next_at: '2026-11-23T01:00:00.000Z',
    schedule_state: 'due', runs: 3, last_fired_at: '2026-11-16T01:00:00.000Z', last_done_at: null, schedule_text: 'Every Monday at 09:00',
  });
  assert.deepEqual(due.schedule, WEEKLY, 'a JSON string is read');
  assert.equal(due.then_action, null);
  assert.equal(due.schedule_state, 'due');
  assert.equal(due.runs, 3);
  assert.equal(due.schedule_text, 'Every Monday at 09:00');
  assert.equal(due.then_target, null);
  const prompt = widgetItem('remote:7', { id: 3, title: 'Nightly', status: 'waiting_user', schedule: WEEKLY, then_action: { kind: 'prompt', task_id: 12, terminal_id: 't1', text: 'Run the tests' }, schedule_state: 'due' });
  assert.deepEqual(prompt.then_action, { kind: 'prompt', task_id: '12', terminal_id: 't1', text: 'Run the tests' });
  assert.deepEqual(prompt.then_target, { engine: 'remote:7', task_id: '12', terminal_id: 't1', name: null, open_path: '/?openTerminal=remote:7:12:t1' });
  const script = widgetItem('local', { id: 4, title: 'Back up', status: 'todo', schedule: WEEKLY, then_action: { kind: 'script', task_id: '5', script: './backup.sh', timeout_min: 10 }, last_exit: 0 });
  assert.deepEqual(script.then_action, { kind: 'script', task_id: '5', script: './backup.sh', timeout_min: 10 });
  assert.deepEqual(script.then_target, { engine: 'local', task_id: '5', name: null });
  assert.equal(script.last_exit, 0);
  // Bad values are none: an unknown kind, a session that is not one, a state the window does not know.
  const bad = widgetItem('local', { id: 5, title: 'Bad', schedule: { kind: 'sometimes' }, then_action: { kind: 'prompt', task_id: 'x', terminal_id: 't 1' }, schedule_state: 'later', runs: -2 });
  assert.equal(bad.schedule, null);
  assert.equal(bad.then_action, null);
  assert.equal(bad.schedule_state, null);
  assert.equal(bad.runs, 0);
});

test('the list: schedule fields of both engines, the names of a prompt session and a script task here, and `schedules` on the engines', async () => {
  reset();
  task(12, 'ONCALL');
  terminal(12, 't1', 'ONCALL-CC');
  task(5, 'Notes');
  const service = stubService([
    { id: 1, title: 'Nightly test run', status: 'todo', sort_order: 3, schedule: WEEKLY, then_action: { kind: 'prompt', task_id: '12', terminal_id: 't1', text: 'Go' }, schedule_state: 'waiting', next_at: '2026-11-23T01:00:00.000Z' },
    { id: 2, title: 'Back up notes', status: 'todo', sort_order: 2, schedule: WEEKLY, then_action: { kind: 'script', task_id: '5', script: './b.sh', timeout_min: 30 }, schedule_state: 'waiting' },
    { id: 3, title: 'Renew', status: 'todo', sort_order: 1, schedule: ONCE, then_action: null, schedule_state: 'waiting' },
  ]);
  const fake = stubRemote([{ id: 8, title: 'Remote weekly', status: 'todo', sort_order: 1, schedule: WEEKLY, schedule_state: 'waiting', then_action: null }]);
  const laptop = remoteRow('Laptop');
  const older = stubRemote([{ id: 9, title: 'No schedules there', status: 'todo', sort_order: 1 }]);
  remoteRow('Older');
  const remote = { call: (row, options) => (row.name === 'Laptop' ? fake.remote.call(row, options) : older.remote.call(row, options)) };
  const base = await widgetApp({ service, remote, localSchedules: () => true });
  const { body } = await call('GET', `${base}/tick`);
  const byKey = new Map(body.list.items.map(item => [item.key, item]));
  assert.equal(byKey.get('local:1').then_target.name, 'ONCALL-CC');
  assert.equal(byKey.get('local:2').then_target.name, 'Notes');
  assert.equal(byKey.get('local:3').then_target, null);
  assert.deepEqual(byKey.get(`remote:${laptop}:8`).schedule, WEEKLY);
  assert.equal('schedule' in [...byKey.values()].find(item => item.title === 'No schedules there'), false);
  assert.deepEqual(body.list.engines.map(engine => [engine.name, engine.schedules === true]), [['Studio Mac', true], ['Laptop', true], ['Older', false]]);
  // GET /items says the same.
  const items = await call('GET', `${base}/items`);
  assert.equal(items.body.items.find(item => item.key === 'local:1').then_target.name, 'ONCALL-CC');
  // This machine without the server's part of schedules: no flag (its items carry none either).
  const before = await widgetApp({ service: stubService([{ id: 1, title: 'Plain', status: 'todo' }]), remote, localSchedules: () => false });
  assert.equal((await call('GET', `${before}/items`)).body.engines[0].schedules, undefined);
});

test('run-now: this machine through the server part, a connected service through its /v1/attention, errors as they came', async () => {
  reset();
  const service = stubService([{ id: 1, title: 'Nightly', status: 'waiting_user', schedule: WEEKLY }]);
  const ran = [];
  const fake = stubRemote([]);
  const laptop = remoteRow('Laptop');
  const base = await widgetApp({
    service, remote: fake.remote,
    runNow: (id, options) => { ran.push([id, options]); if (id === 2) throw new AttentionError('SESSION_BUSY', 'The session is busy', 409); return { ok: true }; },
  });
  assert.deepEqual(await call('POST', `${base}/items/local:1/run-now`, {}), { status: 200, body: { ok: true } });
  assert.deepEqual(ran, [[1, { actor: 'user' }]]);
  const busy = await call('POST', `${base}/items/local:2/run-now`, {});
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error, 'SESSION_BUSY');
  assert.equal((await call('POST', `${base}/items/remote:${laptop}:3/run-now`, {})).status, 200);
  assert.deepEqual(fake.calls.filter(entry => entry.method === 'POST').map(entry => entry.path), ['/3/run-now']);
  const remoteBusy = await call('POST', `${base}/items/remote:${laptop}:4/run-now`, {});
  assert.deepEqual([remoteBusy.status, remoteBusy.body.error, remoteBusy.body.message], [409, 'SESSION_BUSY', 'The session is busy']);
  assert.equal((await call('POST', `${base}/items/nothing/run-now`, {})).status, 404);
  // A server without its part of schedules (no service.runNow): 501.
  const older = await widgetApp({ service: stubService([]) });
  const refused = await call('POST', `${older}/items/local:1/run-now`, {});
  assert.deepEqual([refused.status, refused.body.error], [501, 'SCHEDULES_UNSUPPORTED']);
});

test('schedule preview: the owner answers "Next", checked; bad bodies are 400', async () => {
  reset();
  const asked = [];
  const fake = stubRemote([]);
  const laptop = remoteRow('Laptop');
  const base = await widgetApp({
    service: stubService([]), remote: fake.remote,
    previewSchedule: schedule => { asked.push(schedule); return schedule.kind === 'once' ? { next: [], text: null, error: 'schedule.at must be a date' } : { next: ['2026-11-23T01:00:00.000Z'], text: 'Every Monday at 09:00' }; },
  });
  assert.deepEqual((await call('POST', `${base}/schedule/preview`, { engine: 'local', schedule: WEEKLY })).body, { next: ['2026-11-23T01:00:00.000Z'], text: 'Every Monday at 09:00' });
  assert.deepEqual((await call('POST', `${base}/schedule/preview`, { engine: 'local', schedule: ONCE })).body, { next: [], text: null, error: 'schedule.at must be a date' });
  assert.deepEqual(asked, [WEEKLY, ONCE]);
  const remote = await call('POST', `${base}/schedule/preview`, { engine: `remote:${laptop}`, schedule: WEEKLY });
  assert.deepEqual(remote.body, { next: ['2026-11-23T01:00:00.000Z', 'xxx'], text: 'Every Monday at 09:00' }, 'at most three strings');
  assert.deepEqual(fake.calls.at(-1), { method: 'POST', path: '/schedule/preview', body: { schedule: WEEKLY } });
  for (const body of [{ schedule: WEEKLY }, { engine: 'there', schedule: WEEKLY }, { engine: 'local' }, { engine: 'local', schedule: [1] }]) {
    assert.equal((await call('POST', `${base}/schedule/preview`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call('POST', `${base}/schedule/preview`, { engine: 'remote:999', schedule: WEEKLY })).status, 404);
});

test('targets: the sessions and tasks of this machine and of a connected service for the form, checked', async () => {
  reset();
  const laptop = remoteRow('Laptop');
  const base = await widgetApp({
    service: stubService([]),
    localTargets: () => ({ sessions: [{ task_id: 12, terminal_id: 't1', name: 'ONCALL-CC', task_title: 'ONCALL', agent: 'claude' }, { task_id: 'x', terminal_id: 't1' }], tasks: [{ id: 5, title: 'Notes' }, { id: 0 }] }),
    remoteTargets: row => (row.name === 'Laptop' ? { sessions: [], tasks: [{ id: 3, title: 'Remote task' }] } : null),
  });
  assert.deepEqual((await call('GET', `${base}/targets?engine=local`)).body, {
    sessions: [{ task_id: '12', terminal_id: 't1', name: 'ONCALL-CC', task_title: 'ONCALL', agent: 'claude' }], tasks: [{ id: '5', title: 'Notes' }],
  });
  assert.deepEqual((await call('GET', `${base}/targets?engine=remote:${laptop}`)).body, { sessions: [], tasks: [{ id: '3', title: 'Remote task' }] });
  assert.equal((await call('GET', `${base}/targets?engine=remote:999`)).status, 404);
  assert.equal((await call('GET', `${base}/targets?engine=nope`)).status, 400);
  const unreachable = await widgetApp({ service: stubService([]), remoteTargets: () => { throw new Error('ECONNREFUSED'); } });
  const failed = await call('GET', `${unreachable}/targets?engine=remote:${laptop}`);
  assert.deepEqual([failed.status, failed.body.error], [502, 'REMOTE_CONNECTION_FAILED']);
});

test('targets on this machine: tasks in use and their agent terminals', async () => {
  reset();
  task(12, 'ONCALL');
  terminal(12, 't1', 'ONCALL-CC');
  db.prepare("UPDATE task_terminals SET agent = 'claude', title_custom = 1 WHERE task_id = 12").run();
  terminal(12, 'shell', 'A shell');
  task(5, 'Notes');
  db.prepare("INSERT INTO tasks (id, title, archived_at) VALUES (6, 'Archived', '2026-01-01T00:00:00.000Z')").run();
  const base = await widgetApp({ service: stubService([]) });
  const { body } = await call('GET', `${base}/targets`);
  assert.deepEqual(body.sessions, [{ task_id: '12', terminal_id: 't1', name: 'ONCALL-CC', task_title: 'ONCALL', agent: 'claude' }]);
  assert.deepEqual(body.tasks, [{ id: '12', title: 'ONCALL' }, { id: '5', title: 'Notes' }]);
});

test('create from the window passes the schedule and the action to this machine', async () => {
  reset();
  const service = stubService([]);
  const base = await widgetApp({ service });
  const created = await call('POST', `${base}/items`, { engine: 'local', title: 'Back up notes', schedule: WEEKLY, then_action: { kind: 'script', task_id: '5', script: './b.sh' } });
  assert.equal(created.status, 201);
  assert.deepEqual(service.calls[0][1], { title: 'Back up notes', schedule: WEEKLY, then_action: { kind: 'script', task_id: '5', script: './b.sh' } });
});
