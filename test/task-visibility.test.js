// Per-task visibility for linked services (services/task-visibility.js, middleware/task-visibility.js). The first half is the state over an in-memory database and
// the route inventory; the second half runs real server.js processes linked to each other, each with a throwaway data folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-task-visibility-'));
process.env.T_AGENT_DATA_DIR = root;
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const Database = require('better-sqlite3');
const WebSocket = require('ws');
const { createTaskVisibility, STATE_KEY, MAX_DENIED, MISSING_TASK_ID } = require('../services/task-visibility');
const { createActivityStream } = require('../lib/terminal-activity-stream');
const { checkTunnelTarget } = require('../lib/service-link-tunnel');
const { createAccessToken } = require('../services/engine-auth');
const { decryptToken } = require('../lib/token-crypto');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const SECRET = 'task-visibility-test-secret-'.repeat(3);

function fixture(t, { database } = {}) {
  const db = database || new Database(':memory:');
  if (!database) { db.exec(SCHEMA); t.after(() => db.close()); }
  const links = new Map();
  const listeners = new Set();
  const serviceLinks = {
    ids: () => [...links.keys()],
    list: () => [...links.values()],
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const addLink = (id, extra = {}) => { links.set(id, { id, name: id, online: false, state: 'offline', created_at: new Date(1000 + links.size).toISOString(), ...extra }); };
  const changeLink = id => listeners.forEach(fn => fn(id));
  const removeLink = id => { links.delete(id); changeLink(id); };
  const addTask = title => Number(db.prepare('INSERT INTO tasks (title) VALUES (?)').run(title).lastInsertRowid);
  const stored = () => { const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY); return row ? JSON.parse(row.value) : null; };
  return { db, serviceLinks, addLink, changeLink, removeLink, addTask, stored, visibility: createTaskVisibility({ db, serviceLinks }) };
}

test('nothing is denied by default, and a link added later is allowed too', t => {
  const f = fixture(t);
  const task = f.addTask('a');
  f.addLink('first');
  assert.equal(f.visibility.isDenied(task, 'first'), false);
  f.visibility.setDenied('local', task, ['first']);
  f.addLink('second');
  assert.equal(f.visibility.isDenied(task, 'first'), true);
  assert.equal(f.visibility.isDenied(task, 'second'), false);
  assert.deepEqual(f.visibility.devices('local', task).map(device => [device.link_id, device.allowed]), [['first', false], ['second', true]]);
});

test('denied links are stored as a map of task id to link ids, an empty list removes the entry, and the state survives a restart', t => {
  const f = fixture(t);
  const task = f.addTask('a');
  f.addLink('one');
  f.addLink('two');
  f.visibility.setDenied('local', task, ['one', 'two', 'one']);
  assert.deepEqual(f.stored(), { [task]: ['one', 'two'] });

  const again = createTaskVisibility({ db: f.db, serviceLinks: f.serviceLinks });
  assert.equal(again.isDenied(task, 'two'), true);

  f.visibility.setDenied('local', task, []);
  assert.deepEqual(f.stored(), {});
  assert.equal(f.visibility.isDenied(task, 'one'), false);
});

test('a bad denied list is refused and changes nothing', t => {
  const f = fixture(t);
  const task = f.addTask('a');
  f.addLink('one');
  f.visibility.setDenied('local', task, ['one']);
  const refuse = value => assert.throws(() => f.visibility.setDenied('local', task, value), error => error.message === 'INVALID_VISIBILITY' && error.statusCode === 400);
  for (const value of [undefined, null, 'one', {}, [1], ['unknown'], Array(MAX_DENIED + 1).fill('one')]) refuse(value);
  assert.deepEqual(f.stored(), { [task]: ['one'] });
  assert.equal(f.visibility.isDenied(task, 'one'), true);
});

test('a task entry goes with the task, a link id goes with the link from every entry', t => {
  const f = fixture(t);
  const [one, two] = [f.addTask('one'), f.addTask('two')];
  f.addLink('keep');
  f.addLink('gone');
  f.visibility.setDenied('local', one, ['keep', 'gone']);
  f.visibility.setDenied('local', two, ['gone']);

  f.removeLink('gone');
  assert.deepEqual(f.stored(), { [one]: ['keep'] }, 'the entry left empty is removed as well');
  assert.equal(f.visibility.isDenied(two, 'gone'), false);

  f.visibility.forgetTask(one);
  assert.deepEqual(f.stored(), {});
});

test('a change of a link that still exists keeps its entries', t => {
  const f = fixture(t);
  const task = f.addTask('a');
  f.addLink('one');
  f.visibility.setDenied('local', task, ['one']);
  // Presence and revoked changes call the same listeners with an id that is still there.
  f.changeLink('one');
  assert.deepEqual(f.stored(), { [task]: ['one'] });
  assert.equal(f.visibility.isDenied(task, 'one'), true);
});

test('entries of a task or link that went away while the server was down are dropped on load', t => {
  const f = fixture(t);
  const task = f.addTask('a');
  f.addLink('one');
  f.db.prepare('INSERT INTO system_state (key, value) VALUES (?, ?)').run(STATE_KEY, JSON.stringify({ [task]: ['one', 'stale'], 987654: ['one'] }));
  const fresh = createTaskVisibility({ db: f.db, serviceLinks: f.serviceLinks });
  assert.equal(fresh.isDenied(task, 'one'), true);
  assert.deepEqual(f.stored(), { [task]: ['one'] });
});

test('what a link has open closes at the moment it loses that task, and only then', t => {
  const f = fixture(t);
  const [one, two] = [f.addTask('one'), f.addTask('two')];
  f.addLink('a');
  f.addLink('b');
  const closed = [];
  const untrack = f.visibility.track('a', one, () => closed.push('a-one'));
  f.visibility.track('a', two, () => closed.push('a-two'));
  f.visibility.track('b', one, () => closed.push('b-one'));
  f.visibility.track('a', null, () => closed.push('a-any'));
  f.visibility.track('b', null, () => { throw new Error('a failing close must not keep the others open'); });

  f.visibility.setDenied('local', one, ['a']);
  assert.deepEqual(closed.sort(), ['a-any', 'a-one']);

  // Saving the same list again closes nothing: the link did not lose anything new.
  closed.length = 0;
  f.visibility.track('a', one, () => closed.push('a-one-again'));
  f.visibility.setDenied('local', one, ['a']);
  assert.deepEqual(closed, []);

  f.visibility.setDenied('local', one, ['a', 'b']);
  assert.deepEqual(closed, ['b-one']);
  assert.equal(untrack(), false, 'already ended by the denial');
});

test('the list filter leaves out denied tasks for that link only, and is a no-op without a link', t => {
  const f = fixture(t);
  const [one, two] = [f.addTask('one'), f.addTask('two')];
  f.addLink('a');
  f.addLink('b');
  f.visibility.setDenied('local', one, ['a']);
  assert.deepEqual(f.visibility.visible('a', [one, two]), [two]);
  assert.deepEqual(f.visibility.visible('b', [one, two]), [one, two]);
  const items = [{ id: one }, { id: two }];
  assert.equal(f.visibility.visible(null, items, item => item.id), items);
  assert.equal(f.visibility.hiddenFrom('a')(one), true);
  assert.equal(f.visibility.hiddenFrom(null)(one), false);
});

test('a request value is resolved the way SQLite compares it, so another spelling of the id cannot slip through', t => {
  const f = fixture(t);
  const task = f.addTask('a');
  for (const value of [task, String(task), `0${task}`, `${task}.0`, ` ${task}`, `+${task}`]) assert.equal(f.visibility.taskIdOf(value), task, JSON.stringify(value));
  for (const value of ['reorder', 'validate-path', null, undefined, {}, [], true, 987654]) assert.equal(f.visibility.taskIdOf(value), null, JSON.stringify(value));
  assert.equal(f.visibility.taskIdOf(MISSING_TASK_ID), null, 'the id that hidden tasks are turned into is never a task');
});

test('the activity stream reads the visible tasks for every message of each connection', async t => {
  const f = fixture(t);
  const [one, two] = [f.addTask('one'), f.addTask('two')];
  f.addLink('a');
  const stream = createActivityStream({ activity: ids => Object.fromEntries(ids.map(id => [id, { default: 'running' }])), subagents: () => ({}), debounceMs: 1 });
  const res = () => ({ written: [], setHeader() {}, flushHeaders() {}, on() {}, write(text) { this.written.push(text); } });
  const req = { on() {} };
  const forLink = res();
  const forOwner = res();
  stream.serve(req, forLink, () => f.visibility.visible('a', [one, two]));
  stream.serve(req, forOwner, () => f.visibility.visible(null, [one, two]));
  f.visibility.setDenied('local', one, ['a']);
  stream.notify();
  await new Promise(resolve => setTimeout(resolve, 20));
  const last = target => JSON.parse(target.written.filter(text => text.startsWith('event: activity')).at(-1).split('data: ')[1]);
  assert.deepEqual(Object.keys(last(forLink).activity), [String(two)]);
  assert.deepEqual(Object.keys(last(forOwner).activity).sort(), [String(one), String(two)].sort());
});

// Every route of /v1. A new one fails here until someone has decided whether it exposes a task: under /tasks/:id or /terminal-sessions/:id it is covered by the guard,
// anywhere else it needs the one filter (`visibleTo`) or a reason to stay as it is.
const REVIEWED_ROUTES = new Set([
  // No task in the answer.
  'GET /health', 'POST /pair', 'GET /info', 'GET /capabilities', 'PUT /engine-name', 'GET /update/status', 'POST /update/check', 'POST /update/apply',
  'GET /pm2/status', 'GET /pm2/:id/logs', 'POST /pm2/:id/:action',
  'POST /service-links/join', 'POST /service-links/:id/unlink', 'POST /service-link-notice/:id/unlink',
  'POST /tasks/validate-path', 'POST /tasks', 'POST /task-groups', 'DELETE /task-groups/:id',
  'GET /tokens', 'POST /tokens', 'DELETE /tokens/:id',
  'GET /workspace/unmanaged', 'POST /workspace/import',
  // Filtered with visibleTo / hiddenFrom / withVisibleCounts.
  'GET /tasks', 'GET /task-groups', 'PUT /task-groups/:id', 'GET /terminal-activity', 'GET /terminal-activity/stream', 'GET /terminal-subagents',
  'GET /workspace/cleanup', 'POST /workspace/cleanup', 'POST /workspace/restore',
  // Task ids in the body, rewritten by the guard.
  'PUT /tasks/reorder', 'POST /terminal-sessions',
]);
const REVIEWED_MOUNTS = new Set(['/file-sync', '/linked-services', '/apps', '/agent-config', '/fs']);
const GUARDED = /^\/(tasks|terminal-sessions)\/:id(\/|$)/;

test('every /v1 route has been reviewed, and the guard runs before all of them', () => {
  const router = require('../routes/engine-v1');
  const firstRoute = router.stack.findIndex(layer => layer.route);
  const guard = router.stack.findIndex(layer => layer.name === 'taskVisibilityGuard');
  assert.equal(guard, 0, 'the guard is the first layer of the router');
  assert.ok(guard < firstRoute);
  const mountOf = layer => {
    const match = /^\^\\\/(.+?)\\\/\?\(\?=\\\/\|\$\)$/.exec(layer.regexp.source);
    return match ? `/${match[1].replace(/\\\//g, '/').replace('(?:/([^/]+?))', '/:id')}` : layer.regexp.source;
  };
  for (const layer of router.stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        const label = `${method.toUpperCase()} ${layer.route.path}`;
        assert.ok(GUARDED.test(layer.route.path) || REVIEWED_ROUTES.has(label), `review this route for task visibility: ${label}`);
      }
    } else if (layer.keys.length) {
      assert.match(mountOf(layer), GUARDED, 'a mount with a parameter must be under a guarded path');
    } else if (layer.name !== 'taskVisibilityGuard' && layer.regexp.source !== '^\\/?(?=\\/|$)') {
      assert.ok(REVIEWED_MOUNTS.has(mountOf(layer)), `review this mount for task visibility: ${mountOf(layer)}`);
    }
  }
});

test('the page API is out of reach of the tunnel', () => {
  assert.throws(() => checkTunnelTarget('/api/tasks/1/visibility'), /TUNNEL_PATH_FORBIDDEN/);
  assert.equal(checkTunnelTarget('/v1/tasks/1/todos'), '/v1/tasks/1/todos');
});

// ---- Real services ----
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
const until = async (check, label, ms = 8000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
};

async function startService(t, { dir, env = {} } = {}) {
  const temp = dir || fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-task-visibility-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', SESSION_SECRET: SECRET, T_AGENT_DATA_DIR: temp, T_AGENT_DB_PATH: path.join(temp, 'db.sqlite'), TASKS_BASE_DIR: path.join(temp, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false', ACCESS_MODE: 'local', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no start: ${output}`)), 20000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Server running at http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once('exit', code => reject(new Error(`exited ${code}: ${output}`)));
  });
  const stop = () => (child.exitCode !== null ? Promise.resolve() : new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); }));
  const service = {
    port, temp, stop, url: `http://127.0.0.1:${port}`,
    async call(method, route, body, headers = HEADERS) {
      const response = await fetch(`${service.url}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      return { status: response.status, body: parsed, text };
    },
    database(options = { readonly: true }) {
      const database = new Database(path.join(temp, 'db.sqlite'), options);
      t.after(() => database.close());
      return database;
    },
  };
  t.after(async () => {
    await stop();
    if (!dir) fs.rmSync(temp, { recursive: true, force: true });
  });
  return service;
}

// Links the joiner to the initiator and returns what each side needs: the link id, and the token the joiner holds for the initiator, which is the token of that link there.
async function link(initiator, joiner) {
  const made = await initiator.call('POST', '/api/service-links/code', {});
  assert.equal(made.status, 201);
  const joined = await joiner.call('POST', '/api/service-links/join', { url: initiator.url, code: made.body.code, confirm: true });
  assert.equal(joined.status, 201, joined.text);
  const linkOf = async side => (await side.call('GET', '/api/service-links')).body.links.find(item => item.id === joined.body.id);
  await until(async () => (await linkOf(initiator))?.online && (await linkOf(joiner))?.online, 'both sides online');
  const row = joiner.database().prepare('SELECT token_cipher FROM remote_servers WHERE base_url = ?').get(initiator.url);
  return { id: joined.body.id, token: decryptToken(row.token_cipher, SECRET), linkOf };
}

const bearer = token => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const newTask = async (service, title) => {
  const created = await service.call('POST', '/api/tasks', { title, work_dir: path.join(service.temp, 'tasks', title) });
  assert.equal(created.status, 201, created.text);
  return created.body.id;
};
const plainToken = async service => (await service.call('POST', '/api/remote-tokens', { name: 'Plain client' })).body.token;
const setDenied = (service, taskId, denied) => service.call('PUT', `/api/tasks/${taskId}/visibility`, { denied });

const openSocket = (service, path_, onClose = () => {}) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`${service.url.replace('http', 'ws')}${path_}`);
  const closed = new Promise(done => socket.once('close', (code, reason) => { onClose(); done({ code, reason: reason.toString() }); }));
  const messages = [];
  socket.on('message', (data, binary) => messages.push(binary ? Buffer.from(data).toString() : String(data)));
  socket.once('open', () => resolve({ socket, closed, messages }));
  socket.once('error', reject);
});

// An open server-sent-events request; `ended` settles when the server ends it.
async function openStream(service, route, token) {
  const controller = new AbortController();
  const response = await fetch(`${service.url}${route}`, { headers: bearer(token), signal: controller.signal });
  assert.equal(response.status, 200, route);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const chunks = [];
  const ended = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return 'ended';
        chunks.push(Buffer.from(value).toString());
      }
    } catch { return 'error'; }
  })();
  return { ended, chunks, abort: () => controller.abort() };
}

// Every route under a task, with a body that would be accepted. Each entry: [method, path for a task id, body].
const TASK_ROUTES = [
  ['PATCH', id => `/v1/tasks/${id}`, { title: 'changed' }],
  ['PUT', id => `/v1/tasks/${id}`, { title: 'changed' }],
  ['POST', id => `/v1/tasks/${id}/archive`, {}],
  ['POST', id => `/v1/tasks/${id}/restore`, {}],
  ['DELETE', id => `/v1/tasks/${id}`],
  ['GET', id => `/v1/tasks/${id}/documents/technical`],
  ['GET', id => `/v1/tasks/${id}/document/technical`],
  ['PUT', id => `/v1/tasks/${id}/documents/technical`, { content: 'x' }],
  ['PUT', id => `/v1/tasks/${id}/document/technical`, { content: 'x' }],
  ['POST', id => `/v1/tasks/${id}/document/readme`, {}],
  ['GET', id => `/v1/tasks/${id}/document/technical/watch`],
  ['GET', id => `/v1/tasks/${id}/file?path=a.png`],
  ['GET', id => `/v1/tasks/${id}/files`],
  ['GET', id => `/v1/tasks/${id}/files/content?path=DESIGN.md`],
  ['GET', id => `/v1/tasks/${id}/files/image?path=a.png`],
  ['GET', id => `/v1/tasks/${id}/files/raw?path=a.pdf`],
  ['PUT', id => `/v1/tasks/${id}/files/content`, { path: 'x.txt', content: '' }],
  ['POST', id => `/v1/tasks/${id}/files`, { path: 'x.txt', type: 'file' }],
  ['PATCH', id => `/v1/tasks/${id}/files`, { path: 'x.txt', newPath: 'y.txt' }],
  ['DELETE', id => `/v1/tasks/${id}/files`, { path: 'x.txt' }],
  ['GET', id => `/v1/tasks/${id}/todos`],
  ['POST', id => `/v1/tasks/${id}/todos`, { content: 'x' }],
  ['PATCH', id => `/v1/tasks/${id}/todos/1`, { completed: true }],
  ['PUT', id => `/v1/tasks/${id}/todos/1`, { content: 'x' }],
  ['DELETE', id => `/v1/tasks/${id}/todos/1`],
  ['GET', id => `/v1/tasks/${id}/terminals`],
  ['POST', id => `/v1/tasks/${id}/terminals`, {}],
  ['PATCH', id => `/v1/tasks/${id}/terminals/default`, { title: 'x' }],
  ['GET', id => `/v1/tasks/${id}/terminals/default/cwd`],
  ['GET', id => `/v1/tasks/${id}/agent-sessions?agent=claude`],
  ['POST', id => `/v1/tasks/${id}/terminal/ack`, { terminal_id: 'default' }],
  ['POST', id => `/v1/terminal-sessions/${id}/control`, { action: 'restart', terminal_id: 'default' }],
  ['GET', id => `/v1/tasks/${id}/agent/conversations`],
  ['POST', id => `/v1/tasks/${id}/agent/conversations`, { agent: 'claude' }],
  ['GET', id => `/v1/tasks/${id}/agent/sessions?agent=claude`],
  ['GET', id => `/v1/tasks/${id}/agent/conversations/none`],
  ['GET', id => `/v1/tasks/${id}/agent/conversations/none/events`],
  ['POST', id => `/v1/tasks/${id}/agent/conversations/none/messages`, { text: 'x' }],
  // A route nobody has written yet: the answer must still be that of a task that does not exist.
  ['GET', id => `/v1/tasks/${id}/no-such-route`],
  ['POST', id => `/v1/tasks/${id}/agent/no-such-route`, {}],
];
const MISSING = 987654;

test('three real services: hidden tasks answer exactly like missing ones, for that link only', { timeout: 120000 }, async t => {
  const owner = await startService(t);
  const peer = await startService(t);
  const other = await startService(t);
  const peerLink = await link(owner, peer);
  const hidden = await newTask(owner, 'hidden-task');
  const shown = await newTask(owner, 'shown-task');
  const plain = await plainToken(owner);
  const repo = path.join(owner.temp, 'tasks', 'hidden-task');
  execFileSync('git', ['init', '-q', repo]);

  assert.equal((await setDenied(owner, hidden, [peerLink.id])).status, 200);

  // A link made after the denial is allowed, for the same task.
  const otherLink = await link(owner, other);
  assert.equal((await owner.call('GET', `/api/tasks/${hidden}/visibility`)).body.devices.find(device => device.link_id === otherLink.id).allowed, true);

  for (const [method, route, body] of TASK_ROUTES) {
    const label = `${method} ${route(':id')}`;
    const missing = await owner.call(method, route(MISSING), body, bearer(peerLink.token));
    const refused = await owner.call(method, route(hidden), body, bearer(peerLink.token));
    assert.equal(refused.status, missing.status, label);
    // Express's own "Cannot GET <the address you sent>" page repeats the address, so the id the caller wrote is the one thing allowed to differ.
    assert.equal(refused.text.replace(`/tasks/${hidden}/`, '/tasks/ID/'), missing.text.replace(`/tasks/${MISSING}/`, '/tasks/ID/'), label);
    assert.ok(refused.status === 404, `${label}: ${refused.status} ${refused.text}`);
  }

  // Tokens the denial is not about keep working on the same task: another link and a plain token.
  for (const token of [otherLink.token, plain]) {
    for (const route of [`/v1/tasks/${hidden}/documents/technical`, `/v1/tasks/${hidden}/todos`, `/v1/tasks/${hidden}/files`, `/v1/tasks/${hidden}/terminals`, `/v1/tasks/${hidden}/agent/conversations`]) {
      assert.equal((await owner.call('GET', route, undefined, bearer(token))).status, 200, route);
    }
  }

  // Other spellings of the id must be read the way the route reads them.
  const reference = await owner.call('GET', `/v1/tasks/${MISSING}/documents/technical`, undefined, bearer(peerLink.token));
  for (const spelling of [`0${hidden}`, `${hidden}.0`, `%2B${hidden}`, `%20${hidden}`, `%${Number(String(hidden)[0].charCodeAt(0)).toString(16)}${String(hidden).slice(1)}`]) {
    const refused = await owner.call('GET', `/v1/tasks/${spelling}/documents/technical`, undefined, bearer(peerLink.token));
    assert.equal(refused.text, reference.text, spelling);
    assert.equal(refused.status, 404, spelling);
  }
  for (const route of [`/V1/TASKS/${hidden}/documents/technical`, `/v1/tasks/${hidden}/documents/technical/`]) {
    const refused = await owner.call('GET', route, undefined, bearer(peerLink.token));
    assert.equal(refused.status, 404, route);
  }
  // The absolute form of a request target, which Express also routes.
  const absolute = await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: owner.port, method: 'GET', path: `http://x.test/v1/tasks/${hidden}/documents/technical`, headers: { Host: `127.0.0.1:${owner.port}`, Authorization: `Bearer ${peerLink.token}` } }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(absolute.status, 404);
  assert.equal(absolute.text, reference.text);

  // Tickets, with the id in the body.
  const missingTicket = await owner.call('POST', '/v1/terminal-sessions', { task_id: MISSING, terminal_id: 'default' }, bearer(peerLink.token));
  for (const value of [hidden, String(hidden), `0${hidden}`]) {
    const refused = await owner.call('POST', '/v1/terminal-sessions', { task_id: value, terminal_id: 'default' }, bearer(peerLink.token));
    assert.equal(refused.status, 404);
    assert.equal(refused.text, missingTicket.text);
  }

  // Lists.
  const listed = async (service, token, query = '') => (await service.call('GET', `/v1/tasks${query}`, undefined, bearer(token))).body.map(task => task.id);
  assert.deepEqual(await listed(owner, peerLink.token), [shown]);
  assert.deepEqual((await listed(owner, plain)).sort(), [hidden, shown].sort(), 'a token that is not a link is not affected');
  assert.deepEqual((await listed(owner, otherLink.token)).sort(), [hidden, shown].sort(), 'another link is not affected');

  // Archived tasks: the denial stays through archive and restore.
  assert.equal((await owner.call('POST', `/api/tasks/${hidden}/archive`, {})).status, 200);
  assert.deepEqual(await listed(owner, peerLink.token, '?archived=1'), []);
  assert.deepEqual(await listed(owner, plain, '?archived=1'), [hidden]);
  assert.equal((await owner.call('POST', `/api/tasks/${hidden}/restore`, {})).status, 200);
  assert.deepEqual(await listed(owner, peerLink.token), [shown]);

  // Reorder neither touches nor reveals a hidden task.
  const orderOf = id => owner.database().prepare('SELECT sort_order FROM tasks WHERE id = ?').get(id).sort_order;
  const hiddenOrder = orderOf(hidden);
  const reorder = (items, token = peerLink.token) => owner.call('PUT', '/v1/tasks/reorder', items, bearer(token));
  assert.equal((await reorder([{ id: hidden, sort_order: 777 }, { id: `0${hidden}`, sort_order: 778 }, { id: shown, sort_order: 55 }])).status, 200);
  assert.equal(orderOf(hidden), hiddenOrder);
  assert.equal(orderOf(shown), 55);
  const reorderMissing = await reorder([{ id: MISSING, sort_order: 'x' }]);
  const reorderHidden = await reorder([{ id: hidden, sort_order: 'x' }]);
  assert.equal(reorderHidden.status, 400);
  assert.equal(reorderHidden.text, reorderMissing.text);
  assert.equal((await reorder([{ id: hidden, sort_order: 901 }], plain)).status, 200);
  assert.equal(orderOf(hidden), 901, 'a plain token still reorders it');

  // Group counts.
  const todo = async token => (await owner.call('GET', '/v1/task-groups', undefined, bearer(token))).body.find(group => group.key === 'todo').task_count;
  assert.equal(await todo(plain), 2);
  assert.equal(await todo(peerLink.token), 1);
  const custom = (await owner.call('POST', '/v1/task-groups', { name: 'Custom' }, bearer(plain))).body;
  assert.equal((await owner.call('PATCH', `/v1/tasks/${hidden}`, { status: custom.key }, bearer(plain))).status, 200);
  assert.equal((await owner.call('PUT', `/v1/task-groups/${custom.id}`, { name: 'Renamed' }, bearer(peerLink.token))).body.task_count, 0);
  assert.equal((await owner.call('PUT', `/v1/task-groups/${custom.id}`, { name: 'Renamed' }, bearer(plain))).body.task_count, 1);
  await owner.call('PATCH', `/v1/tasks/${hidden}`, { status: 'todo' }, bearer(plain));

  // Workspace: the overview, cleaning and restoring name tasks too.
  const overview = async token => (await owner.call('GET', '/v1/workspace/cleanup', undefined, bearer(token))).body.items.map(item => item.task_id);
  assert.deepEqual(await overview(plain), [hidden]);
  assert.deepEqual(await overview(peerLink.token), []);
  const cleaned = await owner.call('POST', '/v1/workspace/cleanup', { confirm: true, repos: [{ task_id: hidden, path: repo }] }, bearer(peerLink.token));
  assert.deepEqual(cleaned.body, [{ task_id: hidden, path: repo, ok: false, error: 'TASK_NOT_FOUND' }]);
  assert.ok(fs.existsSync(repo));
  const record = owner.database({}).prepare("INSERT INTO repo_cleanups (task_id, path, remote, branch, commit_sha, size_bytes) VALUES (?, ?, 'r', 'main', 'c', 1)").run(hidden, path.join(repo, 'gone')).lastInsertRowid;
  const restore = await owner.call('POST', '/v1/workspace/restore', { id: Number(record) }, bearer(peerLink.token));
  const restoreMissing = await owner.call('POST', '/v1/workspace/restore', { id: 987654 }, bearer(peerLink.token));
  assert.equal(restore.status, 404);
  assert.equal(restore.text, restoreMissing.text);
  assert.deepEqual((await owner.call('GET', '/v1/workspace/cleanup', undefined, bearer(peerLink.token))).body.archived, []);

  // Allowed again: the same token reaches it at once.
  assert.equal((await owner.call('GET', `/v1/tasks/${hidden}/documents/technical`, undefined, bearer(peerLink.token))).status, 404);
  assert.equal((await setDenied(owner, hidden, [])).status, 200);
  assert.equal((await owner.call('GET', `/v1/tasks/${hidden}/documents/technical`, undefined, bearer(peerLink.token))).status, 200);
  assert.deepEqual((await listed(owner, peerLink.token)).sort(), [hidden, shown].sort());

  // Removing a link removes its id from every entry.
  await setDenied(owner, hidden, [peerLink.id, otherLink.id]);
  const stored = () => { const row = owner.database().prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY); return row ? JSON.parse(row.value) : null; };
  assert.deepEqual(stored(), { [hidden]: [peerLink.id, otherLink.id] });
  assert.equal((await owner.call('DELETE', `/api/service-links/${otherLink.id}`)).status, 204);
  assert.deepEqual(stored(), { [hidden]: [peerLink.id] });

  // Deleting the task removes its entry, on both delete paths.
  assert.equal((await owner.call('DELETE', `/api/tasks/${hidden}`)).status, 200);
  assert.deepEqual(stored(), {});
  const second = await newTask(owner, 'second-hidden');
  await setDenied(owner, second, [peerLink.id]);
  assert.equal((await owner.call('DELETE', `/v1/tasks/${second}`, undefined, bearer(plain))).status, 200);
  assert.deepEqual(stored(), {});
});

test('real services: terminals and event streams end at the moment of denial, and do not come back', { timeout: 60000 }, async t => {
  const owner = await startService(t);
  const peer = await startService(t);
  const peerLink = await link(owner, peer);
  const hidden = await newTask(owner, 'stream-hidden');
  const shown = await newTask(owner, 'stream-shown');
  const plain = await plainToken(owner);

  const terminalId = (await owner.call('POST', `/v1/tasks/${hidden}/terminals`, {}, bearer(plain))).body.terminal_id;
  const ticket = async (taskId, terminal, token = peerLink.token) => (await owner.call('POST', '/v1/terminal-sessions', { task_id: taskId, terminal_id: terminal }, bearer(token))).body;

  const open = await openSocket(owner, (await ticket(hidden, terminalId)).websocket_path);
  await until(() => open.messages.length, 'the terminal answered');
  // A ticket taken while the link could still see the task, used after it could not.
  const lateTicket = await ticket(hidden, terminalId);

  // A plain token's terminal on the same task must stay.
  const plainTerminal = (await owner.call('POST', `/v1/tasks/${hidden}/terminals`, {}, bearer(plain))).body.terminal_id;
  const stays = await openSocket(owner, (await ticket(hidden, plainTerminal, plain)).websocket_path);
  await until(() => stays.messages.length, 'the other terminal answered');

  // A terminal of another task must also stay.
  const shownTerminal = (await owner.call('POST', `/v1/tasks/${shown}/terminals`, {}, bearer(plain))).body.terminal_id;
  const shownSocket = await openSocket(owner, (await ticket(shown, shownTerminal)).websocket_path);
  await until(() => shownSocket.messages.length, 'the shown terminal answered');

  const conversation = (await owner.call('POST', `/v1/tasks/${hidden}/agent/conversations`, { agent: 'claude' }, bearer(plain))).body.id;
  const chat = await openStream(owner, `/v1/tasks/${hidden}/agent/conversations/${conversation}/events`, peerLink.token);
  const watch = await openStream(owner, `/v1/tasks/${hidden}/document/technical/watch`, peerLink.token);
  const activity = await openStream(owner, '/v1/terminal-activity/stream', peerLink.token);
  const plainActivity = await openStream(owner, '/v1/terminal-activity/stream', plain);
  t.after(() => { for (const stream of [chat, watch, activity, plainActivity]) stream.abort(); });

  assert.equal((await setDenied(owner, hidden, [peerLink.id])).status, 200);

  assert.deepEqual(await Promise.race([open.closed, new Promise(resolve => setTimeout(resolve, 3000, 'still open'))]), { code: 1008, reason: 'task not found' });
  for (const [stream, name] of [[chat, 'chat'], [watch, 'watch'], [activity, 'activity']]) {
    assert.equal(await Promise.race([stream.ended, new Promise(resolve => setTimeout(resolve, 3000, 'still open'))]), 'ended', name);
  }

  // What stays open: a plain token's socket and stream, and this link's socket on a task it can still see.
  assert.equal(stays.socket.readyState, WebSocket.OPEN);
  assert.equal(shownSocket.socket.readyState, WebSocket.OPEN);
  assert.equal(await Promise.race([plainActivity.ended, new Promise(resolve => setTimeout(resolve, 200, 'open'))]), 'open');

  const late = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`${owner.url.replace('http', 'ws')}${lateTicket.websocket_path}`);
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    socket.once('error', reject);
  });
  assert.deepEqual(late, { code: 1008, reason: 'task not found' });

  // Running state: the link's snapshot leaves the hidden task out, the plain token's has it.
  stays.socket.send('sleep 30\r');
  const running = async token => (await owner.call('GET', '/v1/terminal-activity', undefined, bearer(token))).body;
  await until(async () => (await running(plain))[hidden], 'the plain token sees the running terminal', 10000);
  assert.equal((await running(peerLink.token))[hidden], undefined);
  const reconnected = await openStream(owner, '/v1/terminal-activity/stream', peerLink.token);
  t.after(() => reconnected.abort());
  await until(() => reconnected.chunks.join('').includes('event: activity'), 'first snapshot');
  assert.equal(reconnected.chunks.join('').includes(`"${hidden}"`), false, 'the reconnected stream has no trace of the hidden task');
  assert.equal(JSON.stringify((await owner.call('GET', '/v1/terminal-subagents', undefined, bearer(peerLink.token))).body).includes(`"${hidden}"`), false);

  stays.socket.terminate();
  shownSocket.socket.terminate();

  // After a restart the denial is still there.
  await owner.stop();
  const restarted = await startService(t, { dir: owner.temp });
  const refused = await restarted.call('GET', `/v1/tasks/${hidden}/documents/technical`, undefined, bearer(peerLink.token));
  const missing = await restarted.call('GET', `/v1/tasks/${MISSING}/documents/technical`, undefined, bearer(peerLink.token));
  assert.equal(refused.status, 404);
  assert.equal(refused.text, missing.text);
});

test('real services through the tunnel: the joiner\'s hidden task is out of the initiator\'s list', { timeout: 60000 }, async t => {
  const initiator = await startService(t);
  const joiner = await startService(t);
  const made = await link(initiator, joiner);
  const onInitiator = (await initiator.call('GET', '/api/service-links')).body.links.find(item => item.id === made.id);
  const hidden = await newTask(joiner, 'joiner-hidden');
  const shown = await newTask(joiner, 'joiner-shown');
  const listing = async () => (await initiator.call('GET', `/api/remote-servers/${onInitiator.remote_server_id}/tasks`)).body.map(task => task.id).sort();
  assert.deepEqual(await listing(), [hidden, shown].sort());
  assert.equal((await setDenied(joiner, hidden, [made.id])).status, 200);
  assert.deepEqual(await listing(), [shown]);
  const remote = await initiator.call('GET', `/api/remote-servers/${onInitiator.remote_server_id}/tasks/${hidden}/todos`);
  assert.equal(remote.status, 404);
});

test('real services: the page API', { timeout: 60000 }, async t => {
  const owner = await startService(t);
  const first = await startService(t);
  const second = await startService(t);
  const firstLink = await link(owner, first);
  const secondLink = await link(owner, second);
  const task = await newTask(owner, 'page-task');

  const devices = (await owner.call('GET', `/api/tasks/${task}/visibility`)).body.devices;
  assert.deepEqual(devices.map(device => device.link_id), [firstLink.id, secondLink.id], 'oldest link first');
  assert.deepEqual(Object.keys(devices[0]).sort(), ['allowed', 'link_id', 'name', 'online']);
  assert.equal(devices[0].allowed, true);
  assert.equal(devices[0].online, true);
  assert.doesNotMatch(JSON.stringify(devices), /tae_|tsl_|https?:|tunnel:/, 'no token and no address');

  const saved = await setDenied(owner, task, [secondLink.id]);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.devices.map(device => [device.link_id, device.allowed]), [[firstLink.id, true], [secondLink.id, false]]);
  assert.deepEqual((await owner.call('GET', `/api/tasks/${task}/visibility`)).body, saved.body);

  const put = body => owner.call('PUT', `/api/tasks/${task}/visibility`, body);
  for (const body of [{}, { denied: 'x' }, { denied: [1] }, { denied: ['00000000-0000-4000-8000-000000000000'] }, { denied: Array(MAX_DENIED + 1).fill(firstLink.id) }]) {
    const refused = await put(body);
    assert.equal(refused.status, 400, JSON.stringify(body).slice(0, 80));
    assert.deepEqual(refused.body, { error: 'INVALID_VISIBILITY' });
  }
  assert.deepEqual((await owner.call('GET', `/api/tasks/${task}/visibility`)).body, saved.body, 'a refused change stores nothing');

  for (const method of ['GET', 'PUT']) {
    const body = method === 'PUT' ? { denied: [] } : undefined;
    const answer = await owner.call(method, `/api/tasks/${MISSING}/visibility`, body);
    assert.equal(answer.status, 404);
    assert.deepEqual(answer.body, { error: 'TASK_NOT_FOUND' });
  }
  // The routes around it still mean what they did.
  assert.equal((await owner.call('PUT', `/api/tasks/${task}`, { title: 'Renamed' })).status, 200);
  assert.equal((await owner.call('PUT', '/api/tasks/reorder', [])).status, 200);

  // The same-origin gate of /api.
  assert.equal((await owner.call('GET', `/api/tasks/${task}/visibility`, undefined, { Origin: 'http://evil.example.test' })).status, 403);
  assert.equal((await owner.call('PUT', `/api/tasks/${task}/visibility`, { denied: [] }, { 'Content-Type': 'application/json' })).status, 403);

  // The peer cannot change or read it: from another address it has no way in, and a request that looks remote is refused.
  const { token } = firstLink;
  const fromElsewhere = await owner.call('GET', `/api/tasks/${task}/visibility`, undefined, { ...HEADERS, Authorization: `Bearer ${token}`, 'X-Forwarded-For': '203.0.113.5' });
  assert.equal(fromElsewhere.status, 404);
  assert.equal((await owner.call('PUT', `/v1/tasks/${task}/visibility`, { denied: [] }, bearer(token))).status, 404, 'no such route under /v1');

  // With an authenticator, a token is no session.
  const remote = await startService(t, { env: { ACCESS_MODE: 'remote' } });
  const created = createAccessToken(remote.database({}), { name: 'Service link: x', principalId: 'local' }).token;
  const refused = await remote.call('GET', '/api/tasks/1/visibility', undefined, { ...HEADERS, Authorization: `Bearer ${created}` });
  const anonymous = await remote.call('GET', '/api/tasks/1/visibility', undefined, HEADERS);
  assert.notEqual(refused.status, 200);
  assert.equal(refused.status, anonymous.status);
});
