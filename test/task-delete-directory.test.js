const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-delete-dir-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'task-delete-dir-test-secret-task-delete-dir-test';
const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: (req, res, next) => { req.session = { user: { login: 'owner', work_dir: path.join(root, 'tasks') } }; next(); } };
const express = require('express');
const db = require('../db');
const engine = require('../services/engine-tasks');

const app = express();
app.use(express.json());
app.use('/tasks', require('../routes/tasks'));
let server;
let base;
test.before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

const post = async (body) => (await fetch(`${base}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const remove = (id, query = '') => fetch(`${base}/tasks/${id}${query}`, { method: 'DELETE' });
const taskExists = id => Boolean(db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id));

test('By default only the task is deleted and the directory is kept', async () => {
  const dir = path.join(root, 'tasks', 'keep-dir');
  const task = await post({ title: 'keep', work_dir: dir });
  fs.writeFileSync(path.join(dir, 'data.txt'), 'important');
  const res = await remove(task.id);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });
  assert.equal(taskExists(task.id), false);
  assert.equal(fs.readFileSync(path.join(dir, 'data.txt'), 'utf8'), 'important');
});

test('Tick “also delete the directory”: the task and the directory are deleted together', async () => {
  const dir = path.join(root, 'tasks', 'drop-dir');
  const task = await post({ title: 'drop', work_dir: dir });
  fs.writeFileSync(path.join(dir, 'data.txt'), 'bye');
  const res = await remove(task.id, '?delete_directory=1');
  assert.deepEqual(await res.json(), { success: true, directory_deleted: true });
  assert.equal(taskExists(task.id), false);
  assert.equal(fs.existsSync(dir), false);
});

test('A directory shared with other tasks or a protected directory refuses deletion, and the task is not deleted either', async () => {
  const shared = path.join(root, 'tasks', 'shared-dir');
  const first = await post({ title: 'first', work_dir: shared });
  const second = await post({ title: 'second', work_dir: shared });
  const res = await remove(first.id, '?delete_directory=1');
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, 'DIRECTORY_NOT_SAFE_TO_DELETE');
  assert.match(body.reason, /Other task/);
  assert.equal(taskExists(first.id), true);
  assert.equal(fs.existsSync(shared), true);

  // The working directory itself / the directory of this program
  const rootTask = await post({ title: 'root', work_dir: path.join(root, 'tasks') });
  assert.equal((await remove(rootTask.id, '?delete_directory=1')).status, 409);
  const appTask = db.prepare("INSERT INTO tasks (title, work_dir, user_id) VALUES ('app', ?, 'owner')").run(path.resolve(__dirname, '..')).lastInsertRowid;
  assert.equal((await remove(appTask, '?delete_directory=1')).status, 409);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'server.js')), true);

  // Once the sharing is removed it can be deleted
  await remove(second.id);
  assert.equal((await remove(first.id, '?delete_directory=1')).status, 200);
  assert.equal(fs.existsSync(shared), false);
});

test('The Engine supports deleteDirectory as well and returns the reason', () => {
  const dir = path.join(root, 'tasks', 'engine-dir');
  const task = engine.createTask('owner', { title: 'engine', work_dir: dir });
  const result = engine.deleteTask('owner', task.id, { deleteDirectory: true });
  assert.deepEqual(result, { success: true, directory_deleted: true });
  assert.equal(fs.existsSync(dir), false);
  const other = engine.createTask('owner', { title: 'e2', work_dir: path.join(root, 'tasks') });
  assert.throws(() => engine.deleteTask('owner', other.id, { deleteDirectory: true }), error => error.message === 'DIRECTORY_NOT_SAFE_TO_DELETE' && Boolean(error.reason));
  assert.equal(taskExists(other.id), true);
});
