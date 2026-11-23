// The HTTP API of Shell notebooks with the real routes: a notebook made through POST …/terminals (agent 'notebook'), its document, operations, runs
// and the order of its events (real shell), the errors, paths that try to leave the task folder, the terminal WebSocket that refuses a notebook row,
// the row controls (restart, delete), the Engine's /v1 routes with a token, and the Client's forwarding to an Engine. Temporary data folder and HOME.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-notebook-routes-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'notebook-routes-test-secret-notebook-routes-test-secret';
process.env.HOME = path.join(root, 'home');
process.env.ZDOTDIR = process.env.HOME;
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.HOME, '.zshrc'), '');
fs.writeFileSync(path.join(process.env.HOME, '.bash_profile'), '');
for (const name of ['TA_HOOK_URL', 'TA_HOOK_TOKEN', 'TA_ATTENTION_URL', 'TA_ATTENTION_TOKEN', 'TA_SESSION_NAME', 'TA_PEER_URL', 'TA_TCLI']) delete process.env[name];
const workRoot = path.join(root, 'tasks');
fs.mkdirSync(workRoot, { recursive: true });

const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports(req, res, next) { req.session = { user: { login: 'owner', work_dir: workRoot } }; next(); },
};

const express = require('express');
const db = require('../db');
const terminal = require('../routes/terminal');
const engineTasks = require('../services/engine-tasks');
const { createAccessToken } = require('../services/engine-auth');
const { encryptToken } = require('../lib/token-crypto');
const { getNotebookKernels } = require('../services/notebook-kernels');

const servers = [];
const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); servers.push(server); });
let local, engine, proxy, auth, remoteId, oldRemoteId;

test.before(async () => {
  const localApp = express();
  localApp.use(express.json({ limit: '32mb' }));
  localApp.use('/api/tasks/:id/notebooks', require('../routes/notebooks').createNotebookRouter());
  localApp.use('/api/tasks', require('../routes/tasks'));
  local = await listen(localApp);

  const engineApp = express();
  engineApp.use(express.json({ limit: '32mb' }));
  engineApp.use('/v1', require('../routes/engine-v1'));
  engine = await listen(engineApp);
  const token = createAccessToken(db, { principalId: 'owner' }).token;
  auth = { Authorization: `Bearer ${token}` };

  const oldApp = express();
  oldApp.get('/v1/info', (req, res) => res.json({ capabilities: ['tasks:read', 'terminal:execute'] }));
  const old = await listen(oldApp);
  const remote = base => db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
    .run('owner', base, base, encryptToken(token, process.env.SESSION_SECRET)).lastInsertRowid;
  remoteId = remote(engine);
  oldRemoteId = remote(old);
  const proxyApp = express();
  proxyApp.use(express.json({ limit: '32mb' }));
  proxyApp.use('/api/remote-servers', require('../routes/remote-servers'));
  proxy = await listen(proxyApp);
});

test.after(async () => {
  terminal.shutdownTerminals();
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); })));
  db.close();
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a shell that is still ending */ }
});

async function call(method, url, body, headers = {}) {
  const response = await fetch(url, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: parsed };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, what, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(30);
  }
}

// Reads Server-Sent Events: events() is every data event so far (parsed), pings counts the comment lines.
async function follow(url, headers = {}) {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const stream = { status: response.status, type: response.headers.get('content-type'), list: [], close: () => controller.abort() };
  if (response.status !== 200) { stream.body = await response.json(); return stream; }
  (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (block.startsWith('data: ')) stream.list.push(JSON.parse(block.slice(6)));
        }
      }
    } catch { /* closed */ }
    stream.ended = true;
  })();
  return stream;
}

const newTask = (title, owner = 'owner') => engineTasks.createTask(owner, { title });
const api = taskId => `${local}/api/tasks/${taskId}`;

test('a notebook is a terminal row: made by POST terminals, listed with its file, opened as a document', async () => {
  const task = newTask('Notebook task');
  const created = await call('POST', `${api(task.id)}/terminals`, { agent: 'notebook' });
  assert.equal(created.status, 201);
  assert.equal(created.body.agent, 'notebook');
  assert.equal(created.body.notebook, 'notebooks/notebook.ipynb');
  assert.match(created.body.title, /^Notebook \d+$/);
  assert.ok(fs.existsSync(path.join(task.work_dir, 'notebooks', 'notebook.ipynb')));
  const named = await call('POST', `${api(task.id)}/terminals`, { agent: 'notebook', title: 'Release check' });
  assert.deepEqual([named.body.title, named.body.notebook], ['Release check', 'notebooks/Release-check.ipynb']);

  const listed = (await call('GET', `${api(task.id)}/terminals`)).body.find(row => row.terminal_id === created.body.terminal_id);
  assert.deepEqual([listed.agent, listed.notebook], ['notebook', 'notebooks/notebook.ipynb']);

  const notebook = (await call('GET', `${api(task.id)}/notebooks/${created.body.terminal_id}`)).body;
  assert.deepEqual(Object.keys(notebook).sort(), ['cells', 'folder', 'id', 'kernel', 'path', 'revision', 'task_id', 'title']);
  assert.equal(notebook.id, created.body.terminal_id);
  assert.equal(notebook.task_id, task.id);
  assert.equal(notebook.path, 'notebooks/notebook.ipynb');
  assert.equal(notebook.folder, task.work_dir);
  assert.equal(notebook.kernel.state, 'stopped', 'opening does not start the shell');
  assert.deepEqual(notebook.kernel.queue, []);
  assert.deepEqual(notebook.cells.map(cell => [cell.type, cell.source, cell.state, cell.count]), [['code', '', 'idle', null]]);

  // An existing file of the folder, by its path; the list of the New session dialog.
  fs.writeFileSync(path.join(task.work_dir, 'top level.ipynb'), JSON.stringify({ nbformat: 4, nbformat_minor: 4, metadata: {}, cells: [{ cell_type: 'markdown', metadata: {}, source: ['# Hi'] }] }));
  const sessions = (await call('GET', `${api(task.id)}/agent-sessions?agent=notebook`)).body;
  assert.deepEqual(sessions.map(row => row.id).sort(), ['notebooks/Release-check.ipynb', 'notebooks/notebook.ipynb', 'top level.ipynb']);
  assert.ok(sessions.every(row => typeof row.title === 'string' && Number.isFinite(row.updated_at)));
  const opened = await call('POST', `${api(task.id)}/terminals`, { agent: 'notebook', session_id: 'top level.ipynb' });
  assert.deepEqual([opened.status, opened.body.title, opened.body.notebook], [201, 'top level', 'top level.ipynb']);
  const again = await call('POST', `${api(task.id)}/terminals`, { agent: 'notebook', session_id: './top level.ipynb' });
  assert.equal(again.body.terminal_id, opened.body.terminal_id, 'a file that is open already is not opened twice');
  const doc = (await call('GET', `${api(task.id)}/notebooks/${opened.body.terminal_id}`)).body;
  assert.deepEqual(doc.cells.map(cell => [cell.type, cell.source]), [['markdown', '# Hi']]);
});

test('ops, run and the events stream: snapshot first, then ops, cell states and output in order', async () => {
  const task = newTask('Events');
  const { terminal_id: id } = (await call('POST', `${api(task.id)}/terminals`, { agent: 'notebook' })).body;
  const base = `${api(task.id)}/notebooks/${id}`;
  const first = (await call('GET', base)).body.cells[0].id;
  const stream = await follow(`${base}/events`);
  assert.equal(stream.status, 200);
  assert.equal(stream.type, 'text/event-stream');
  await waitFor(() => stream.list.length, 'the snapshot');
  assert.equal(stream.list[0].type, 'snapshot');
  assert.equal(stream.list[0].notebook.id, id);

  const ops = await call('POST', `${base}/ops`, { client: 'page-1', ops: [
    { op: 'set', id: first, source: 'echo one; printf "\\033[31mtwo\\033[0m\\n"' },
    { op: 'insert', index: 1, cell: { id: 'b0b0b0b0', type: 'markdown', source: '## Notes' } },
    { op: 'insert', index: 2, cell: { type: 'code', source: 'echo three' } },
    { op: 'set', id: 'missing1', source: 'skipped' },
  ] });
  assert.equal(ops.status, 200);
  assert.equal(ops.body.revision, 4, 'one more per applied change');
  const after = (await call('GET', base)).body;
  const third = after.cells[2].id;
  assert.match(third, /^[0-9a-f]{8}$/, 'the server makes an id when none is sent');
  assert.deepEqual(after.cells.map(cell => cell.type), ['code', 'markdown', 'code']);

  const ran = await call('POST', `${base}/run`, { ids: [first, 'b0b0b0b0', third], client: 'page-1' });
  assert.equal(ran.status, 200);
  assert.deepEqual(ran.body.kernel.queue, [first, third], 'markdown is skipped');
  assert.equal(ran.body.kernel.state, 'starting');
  await waitFor(async () => {
    const now = (await call('GET', base)).body;
    return now.cells[2].state === 'done' && now;
  }, 'both cells to run');
  const done = (await call('GET', base)).body;
  assert.deepEqual(done.cells[0].lines, ['one', '\x1b[31mtwo\x1b[0m']);
  assert.deepEqual([done.cells[0].count, done.cells[2].count, done.kernel.counter, done.kernel.state], [1, 2, 2, 'idle']);
  await waitFor(() => stream.list.some(event => event.type === 'cell' && event.id === third && event.patch.state === 'done'), 'the last cell event');

  const types = stream.list.map(event => event.type);
  const opsEvent = stream.list.find(event => event.type === 'ops');
  assert.equal(opsEvent.by, 'page-1');
  assert.equal(opsEvent.revision, 4);
  assert.deepEqual(opsEvent.ops.map(op => op.op), ['set', 'insert', 'insert'], 'an op on a missing cell is not sent');
  assert.equal(opsEvent.ops[2].cell.id, third);
  const index = (predicate, what) => { const at = stream.list.findIndex(predicate); assert.ok(at >= 0, what); return at; };
  const queued = index(event => event.type === 'cell' && event.id === first && event.patch.state === 'queued', 'queued');
  const running = index(event => event.type === 'cell' && event.id === first && event.patch.state === 'running', 'running');
  const output = index(event => event.type === 'output' && event.id === first && event.lines.includes('one'), 'output');
  const finished = index(event => event.type === 'cell' && event.id === first && event.patch.state === 'done', 'done');
  assert.ok(types.indexOf('ops') < queued && queued < running && running < output && output < finished, types.join(','));
  const doneEvent = stream.list[finished];
  assert.equal(doneEvent.patch.exit, 0);
  assert.ok(Number.isInteger(doneEvent.patch.duration_ms));
  assert.ok(stream.list.some(event => event.type === 'kernel' && event.kernel.state === 'busy' && event.kernel.running === first));
  const cleared = stream.list.find(event => event.type === 'output' && event.id === first && event.from === 0 && event.lines.length === 0);
  assert.ok(cleared, 'a run starts by clearing the old lines');

  // Clear: outputs go, counts stay, the revision does not move.
  const clear = await call('POST', `${base}/clear`, { ids: [first] });
  assert.deepEqual(clear.body, { revision: 4 });
  const afterClear = (await call('GET', base)).body.cells[0];
  assert.deepEqual([afterClear.lines, afterClear.count, afterClear.state], [[], 1, 'idle']);
  await waitFor(() => stream.list.some(event => event.type === 'output' && event.id === first && event.from === 0 && !event.lines.length && stream.list.indexOf(event) > finished), 'the clear event');

  // The file holds the outputs, and a change made on disk while nothing runs is read again (a new snapshot).
  const file = path.join(task.work_dir, 'notebooks', 'notebook.ipynb');
  await waitFor(() => /three/.test(fs.readFileSync(file, 'utf8')), 'the outputs in the file');
  await sleep(400); // the clear is saved too
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.cells.push({ cell_type: 'markdown', id: 'fromdisk', metadata: {}, source: ['edited elsewhere'] });
  fs.writeFileSync(file, JSON.stringify(data));
  const reloaded = (await call('GET', base)).body;
  assert.equal(reloaded.cells[reloaded.cells.length - 1].source, 'edited elsewhere');
  assert.ok(reloaded.revision > 4);
  await waitFor(() => stream.list.filter(event => event.type === 'snapshot').length === 2, 'a second snapshot');

  // Stop, interrupt and input answer with the kernel; a stream ends when the row is deleted.
  assert.equal((await call('POST', `${base}/interrupt`)).body.kernel.state, 'idle');
  assert.equal((await call('POST', `${base}/input`, { text: 'x' })).body.error, 'NO_RUNNING_CELL');
  assert.equal((await call('POST', `${base}/stop`)).body.kernel.state, 'stopped');
  const deleted = await call('POST', `${api(task.id)}/terminal/control`, { action: 'delete', terminal_id: id });
  assert.equal(deleted.status, 200);
  await waitFor(() => stream.ended, 'the stream to end');
  assert.ok(fs.existsSync(file), 'the file is kept');
  assert.equal((await call('GET', base)).body.error, 'NOTEBOOK_NOT_FOUND');
});

test('errors: unknown task, not a notebook, bad ops, unknown cells, archived task, no folder, paths out of the folder', async () => {
  const task = newTask('Errors');
  const { terminal_id: id } = (await call('POST', `${api(task.id)}/terminals`, { agent: 'notebook' })).body;
  const plain = (await call('POST', `${api(task.id)}/terminals`, {})).body.terminal_id;
  const theirs = newTask('Theirs', 'someone-else');
  const base = `${api(task.id)}/notebooks/${id}`;
  const expect = async (method, url, body, status, error) => {
    const answer = await call(method, url, body);
    assert.deepEqual([answer.status, answer.body.error], [status, error], `${method} ${url}`);
  };
  await expect('GET', `${api(theirs.id)}/notebooks/${id}`, undefined, 404, 'TASK_NOT_FOUND');
  await expect('GET', `${api(task.id)}/notebooks/${plain}`, undefined, 404, 'NOTEBOOK_NOT_FOUND');
  await expect('GET', `${api(task.id)}/notebooks/nope`, undefined, 404, 'NOTEBOOK_NOT_FOUND');
  await expect('GET', `${api(task.id)}/notebooks/${plain}/events`, undefined, 404, 'NOTEBOOK_NOT_FOUND');
  await expect('POST', `${base}/ops`, { ops: [{ op: 'explode' }] }, 400, 'INVALID_NOTEBOOK_OPS');
  await expect('POST', `${base}/ops`, { ops: 'no' }, 400, 'INVALID_NOTEBOOK_OPS');
  await expect('POST', `${base}/ops`, { ops: Array.from({ length: 201 }, () => ({ op: 'delete', id: 'x' })) }, 400, 'INVALID_NOTEBOOK_OPS');
  await expect('POST', `${base}/ops`, { ops: [{ op: 'set', id: 'x', source: 'y'.repeat(1024 * 1024 + 1) }] }, 400, 'INVALID_NOTEBOOK_OPS');
  await expect('POST', `${base}/run`, { ids: ['nothere1'] }, 404, 'CELL_NOT_FOUND');
  await expect('POST', `${base}/input`, { text: 'y' }, 409, 'NO_RUNNING_CELL');

  // Paths that leave the folder, are not notebooks or do not exist.
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'x.ipynb'), '');
  fs.symlinkSync(path.join(outside, 'x.ipynb'), path.join(task.work_dir, 'link.ipynb'));
  fs.writeFileSync(path.join(task.work_dir, 'notes.txt'), '');
  for (const sessionId of ['../outside/x.ipynb', path.join(outside, 'x.ipynb'), 'link.ipynb', 'notes.txt', 'missing.ipynb']) {
    await expect('POST', `${api(task.id)}/terminals`, { agent: 'notebook', session_id: sessionId }, 400, 'INVALID_NOTEBOOK_PATH');
  }
  assert.ok(!(await call('GET', `${api(task.id)}/agent-sessions?agent=notebook`)).body.some(row => row.id === 'link.ipynb'));

  // A file that is not a notebook, and one too large.
  fs.writeFileSync(path.join(task.work_dir, 'broken.ipynb'), '{"nbformat": 3}');
  const broken = (await call('POST', `${api(task.id)}/terminals`, { agent: 'notebook', session_id: 'broken.ipynb' })).body.terminal_id;
  await expect('GET', `${api(task.id)}/notebooks/${broken}`, undefined, 422, 'NOTEBOOK_FILE_UNREADABLE');
  const big = path.join(task.work_dir, 'big.ipynb');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, 20 * 1024 * 1024 + 1);
  const large = (await call('POST', `${api(task.id)}/terminals`, { agent: 'notebook', session_id: 'big.ipynb' })).body.terminal_id;
  await expect('GET', `${api(task.id)}/notebooks/${large}`, undefined, 413, 'NOTEBOOK_TOO_LARGE');

  // A task without a folder.
  const bare = Number(db.prepare("INSERT INTO tasks (title, user_id) VALUES ('No folder', 'owner')").run().lastInsertRowid);
  await expect('POST', `${api(bare)}/terminals`, { agent: 'notebook' }, 409, 'TASK_HAS_NO_FOLDER');

  // An archived task: reading works, changing and running do not.
  assert.equal((await call('POST', `${api(task.id)}/archive`)).status, 200);
  assert.equal((await call('GET', base)).status, 200);
  await expect('POST', `${base}/ops`, { ops: [] }, 409, 'TASK_ARCHIVED');
  await expect('POST', `${base}/run`, { ids: [] }, 409, 'TASK_ARCHIVED');
  await expect('POST', `${base}/restart`, {}, 409, 'TASK_ARCHIVED');
  await expect('POST', `${api(task.id)}/terminals`, { agent: 'notebook' }, 409, 'TASK_ARCHIVED');
});

class Socket extends EventEmitter {
  readyState = 1;
  send() {}
  ping() {}
  terminate() { this.close(1006); }
  close(code, reason) { this.readyState = 3; this.code = code; this.reason = reason; this.emit('close'); }
}

test('the terminal WebSocket refuses a notebook row before any shell starts; the row controls restart and stop its kernel', async () => {
  const task = newTask('Socket');
  const { terminal_id: id } = (await call('POST', `${api(task.id)}/terminals`, { agent: 'notebook' })).body;
  const ws = new Socket();
  terminal.handleWs(ws, { url: `/terminal/ws?taskId=${task.id}&terminalId=${id}&clientId=test` }, { login: 'owner' }, task.id, id);
  assert.deepEqual([ws.code, ws.reason], [1008, 'NOTEBOOK_NOT_A_TERMINAL']);
  assert.deepEqual(terminal.liveTerminalIds(task.id), [], 'no shell runs for it');

  const restarted = await call('POST', `${api(task.id)}/terminal/control`, { action: 'restart-workdir', terminal_id: id });
  assert.deepEqual(restarted.body, { success: true, action: 'restart-workdir', had_session: false });
  const base = `${api(task.id)}/notebooks/${id}`;
  await waitFor(async () => (await call('GET', base)).body.kernel.state === 'idle', 'the kernel the control started');
  assert.deepEqual(terminal.liveTerminalIds(task.id), [id], 'the kernel has the folder open');
  const cell = (await call('GET', base)).body.cells[0].id;
  await call('POST', `${base}/ops`, { ops: [{ op: 'set', id: cell, source: 'sleep 20' }] });
  await call('POST', `${base}/run`, { ids: [cell] });
  await waitFor(() => terminal.activitySnapshot([task.id])[task.id], 'the running cell in the activity');
  assert.equal(terminal.activitySnapshot([task.id])[task.id][id], 'running');
  assert.ok(terminal.updateIdleTerminals().some(item => item.state === 'running'), 'a running cell blocks an automatic update');
  await call('POST', `${api(task.id)}/terminal/control`, { action: 'close', terminal_id: id });
  const closed = (await call('GET', base)).body;
  assert.deepEqual([closed.kernel.state, closed.cells[0].state], ['stopped', 'interrupted']);
  assert.equal(terminal.activitySnapshot([task.id])[task.id], undefined);
  // Renaming goes through the terminal path and shows in the document.
  assert.equal((await call('PATCH', `${api(task.id)}/terminals/${id}`, { title: 'Renamed book' })).status, 200);
  assert.equal((await call('GET', base)).body.title, 'Renamed book');
  assert.ok(getNotebookKernels().size() >= 1);
});

test('the Engine serves the same API with a token and lists terminal:notebook; the Client forwards it, and refuses an Engine without it', async () => {
  const info = await call('GET', `${engine}/v1/info`, undefined, auth);
  assert.ok(info.body.capabilities.includes('terminal:notebook'));
  const task = newTask('Remote');
  const created = await call('POST', `${proxy}/api/remote-servers/${remoteId}/tasks/${task.id}/terminals`, { agent: 'notebook', title: 'Far' });
  assert.equal(created.status, 201);
  assert.equal(created.body.notebook, 'notebooks/Far.ipynb');
  const id = created.body.terminal_id;
  const direct = await call('GET', `${engine}/v1/tasks/${task.id}/notebooks/${id}`, undefined, auth);
  assert.equal(direct.body.title, 'Far');
  assert.equal((await call('GET', `${engine}/v1/tasks/${task.id}/notebooks/${id}`)).status, 401, 'a token is needed');
  const base = `${proxy}/api/remote-servers/${remoteId}/tasks/${task.id}/notebooks/${id}`;
  const doc = (await call('GET', base)).body;
  assert.equal(doc.id, id);
  const stream = await follow(`${base}/events`);
  assert.equal(stream.type, 'text/event-stream');
  await waitFor(() => stream.list.length, 'the forwarded snapshot');
  const ops = await call('POST', `${base}/ops`, { client: 'far-page', ops: [{ op: 'set', id: doc.cells[0].id, source: 'echo far away' }] });
  assert.equal(ops.body.revision, 2);
  await call('POST', `${base}/run`, { ids: [doc.cells[0].id] });
  await waitFor(() => stream.list.some(event => event.type === 'cell' && event.patch.state === 'done'), 'the forwarded run');
  assert.deepEqual((await call('GET', base)).body.cells[0].lines, ['far away']);
  assert.equal((await call('POST', `${base}/input`, { text: 'x' })).body.error, 'NO_RUNNING_CELL', 'errors keep their codes');
  assert.equal((await call('GET', `${proxy}/api/remote-servers/${remoteId}/tasks/${task.id}/agent-sessions?agent=notebook`)).body[0].id, 'notebooks/Far.ipynb');
  stream.close();
  await call('POST', `${base}/stop`);
  const refused = await call('POST', `${proxy}/api/remote-servers/${oldRemoteId}/tasks/${task.id}/terminals`, { agent: 'notebook' });
  assert.deepEqual([refused.status, refused.body.error], [501, 'NOTEBOOK_UNSUPPORTED']);
});
