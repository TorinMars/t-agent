const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');
const Database = require('better-sqlite3');
const { createTaskListPrefsRouter, STATE_KEY } = require('../routes/task-list-prefs');
const { totp } = require('../services/client-auth');

function database() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE remote_servers (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);`);
  const add = (owner, name) => Number(db.prepare('INSERT INTO remote_servers (owner_id, name) VALUES (?, ?)').run(owner, name).lastInsertRowid);
  return { db, add };
}
async function serve(db, login = 'me') {
  const app = express();
  app.use(express.json());
  app.use('/api/task-list/hidden-devices', createTaskListPrefsRouter({ db, requireAuth: (req, res, next) => { req.session = { user: { login } }; next(); } }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api/task-list/hidden-devices`;
  const call = async (method, body) => {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { call, close: () => new Promise(resolve => server.close(resolve)) };
}

test('starts empty, saves the hidden devices and keeps them per owner', async () => {
  const { db, add } = database();
  const one = add('me', 'One');
  add('me', 'Two');
  const other = add('someone', 'Theirs');
  const { call, close } = await serve(db);
  try {
    assert.deepEqual(await call('GET'), { status: 200, body: { hidden: [] } });
    assert.deepEqual(await call('PUT', { hidden: ['local', `remote:${one}`, `remote:${one}`] }), { status: 200, body: { hidden: ['local', `remote:${one}`] } }, 'duplicates collapse');
    assert.deepEqual((await call('GET')).body, { hidden: ['local', `remote:${one}`] });
    assert.deepEqual(Object.keys(JSON.parse(db.prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY).value)), ['me'], 'one key, per owner');
    assert.deepEqual((await call('PUT', { hidden: [`remote:${other}`] })).body, { hidden: [] }, "another owner's device is not one of mine");
  } finally { await close(); }
});

test('refuses anything but a list of real device keys, with the agreed code', async () => {
  const { db, add } = database();
  add('me', 'One');
  const { call, close } = await serve(db);
  try {
    for (const body of [{}, { hidden: 'local' }, { hidden: null }, { hidden: [1] }, { hidden: [''] }, { hidden: ['remote:'] }, { hidden: ['remote:0'] }, { hidden: ['remote:01'] }, { hidden: ['remote:1x'] }, { hidden: ['local '] }, { hidden: ['Local'] }, { hidden: Array.from({ length: 201 }, (_, i) => `remote:${i + 1}`) }]) {
      assert.deepEqual(await call('PUT', body), { status: 400, body: { error: 'INVALID_HIDDEN_DEVICES' } }, JSON.stringify(body).slice(0, 60));
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM system_state').get().c, 0, 'nothing was saved');
    assert.equal((await call('PUT', { hidden: Array.from({ length: 200 }, (_, i) => `remote:${i + 2}`) })).status, 200, 'exactly 200 is allowed');
  } finally { await close(); }
});

test('at least one device stays visible, and a removed device is ignored and dropped on the next save', async () => {
  const { db, add } = database();
  const one = add('me', 'One');
  const two = add('me', 'Two');
  const { call, close } = await serve(db);
  try {
    assert.deepEqual(await call('PUT', { hidden: ['local', `remote:${one}`, `remote:${two}`] }), { status: 400, body: { error: 'LAST_DEVICE_VISIBLE' } });
    assert.deepEqual((await call('PUT', { hidden: ['local', `remote:${one}`] })).body, { hidden: ['local', `remote:${one}`] });
    db.prepare('DELETE FROM remote_servers WHERE id = ?').run(one);
    assert.deepEqual((await call('GET')).body, { hidden: ['local'] }, 'the removed device is ignored');
    assert.deepEqual((await call('PUT', { hidden: ['local', `remote:${one}`] })).body, { hidden: ['local'] }, 'and dropped on the next save');
    assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY).value), { me: ['local'] });
    // The only visible device is removed: what is left must not all be hidden.
    db.prepare('DELETE FROM remote_servers WHERE id = ?').run(two);
    assert.deepEqual((await call('GET')).body, { hidden: [] }, 'nothing is hidden when that would hide every device');
    assert.deepEqual(await call('PUT', { hidden: ['local'] }), { status: 400, body: { error: 'LAST_DEVICE_VISIBLE' } }, 'this machine alone cannot be hidden');
  } finally { await close(); }
});

test('in the real server the route is behind the login and the same-origin rule', { timeout: 120000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-task-list-prefs-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, TAGENT_HOME: '', HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', CLIENT_ALLOW_HTTP: 'false', SESSION_SECRET: 'integration-test-secret-'.repeat(3), T_AGENT_DATA_DIR: temp, T_AGENT_DB_PATH: path.join(temp, 'db.sqlite'), TASKS_BASE_DIR: path.join(temp, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) await new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); });
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Client startup timed out')), 15000);
    child.once('error', reject);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Client exited before becoming ready: ${output}`)); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = output.match(/Server running at http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  const url = `http://127.0.0.1:${port}/api/task-list/hidden-devices`;
  const put = (headers = {}, cookie = '') => fetch(url, { method: 'PUT', redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: JSON.stringify({ hidden: [] }) });

  // Logged out: the same 404 as any protected address.
  assert.equal((await fetch(url, { redirect: 'manual' })).status, 404);
  assert.equal((await put({ 'X-Requested-With': 'XMLHttpRequest' })).status, 404);

  // Logged in (the same setup as the other real-server tests).
  const LOGIN = '/torin/hide/login';
  const post = (route, body, cookie) => fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const start = await post(`${LOGIN}/setup/start`, {});
  assert.equal(start.status, 200);
  const setup = await start.json();
  const confirm = await post(`${LOGIN}/setup/confirm`, { code: totp(setup.secret, Math.floor(Date.now() / 30000)), return_to: '/h5' }, /(?:^|[,\s])(connect\.sid=[^;]+)/.exec(start.headers.get('set-cookie'))[1]);
  assert.equal(confirm.status, 200);
  const cookie = /(?:^|[,\s])(connect\.sid=[^;]+)/.exec(confirm.headers.get('set-cookie'))[1];

  const foreign = await put({ Origin: 'https://attacker.test' }, cookie);
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error, 'CLIENT_ORIGIN_REQUIRED');
  const noProof = await put({}, cookie);
  assert.equal(noProof.status, 403, 'a write without same-origin proof is refused');
  assert.deepEqual(await (await fetch(url, { headers: { Cookie: cookie } })).json(), { hidden: [] });
  const saved = await put({ 'X-Requested-With': 'XMLHttpRequest' }, cookie);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { hidden: [] });
  const last = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', Cookie: cookie }, body: JSON.stringify({ hidden: ['local'] }) });
  assert.equal(last.status, 400);
  assert.equal((await last.json()).error, 'LAST_DEVICE_VISIBLE');
});
