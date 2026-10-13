const test = require('node:test');
const assert = require('node:assert/strict');
const groups = require('../services/task-groups');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const taskStore = require('../services/task-store');

const roots = [];
// 分组与任务都保存在工作目录的文件里，每个用例用独立的临时工作目录。
function testDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-groups-'));
  roots.push(root);
  process.env.TASKS_BASE_DIR = root;
  return { root, close() {} };
}
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

test('首次读取会建立四个兼容分组，三个状态分组不可修改', () => {
  const database = testDb();
  const initial = groups.listGroups(database, 'owner');
  assert.deepEqual(initial.map(group => group.key), ['personal', 'doing', 'todo', 'done']);
  assert.deepEqual(initial.filter(group => group.is_system).map(group => group.key), ['doing', 'todo', 'done']);

  const todo = initial.find(group => group.key === 'todo');
  assert.throws(() => groups.updateGroup(database, 'owner', todo.id, { name: '新的待办' }), /SYSTEM_GROUP_IMMUTABLE/);
  assert.throws(() => groups.deleteGroup(database, 'owner', todo.id), /SYSTEM_GROUP_IMMUTABLE/);
  database.close();
});

test('自定义分组支持新建、重命名和空分组删除', () => {
  const database = testDb();
  const created = groups.createGroup(database, 'owner', { name: '客户项目' });
  assert.equal(created.name, '客户项目');
  assert.equal(created.is_system, false);
  assert.match(created.key, /^group_[a-f0-9]{32}$/);

  const renamed = groups.updateGroup(database, 'owner', created.id, { name: '重点客户' });
  assert.equal(renamed.name, '重点客户');
  groups.deleteGroup(database, 'owner', created.id);
  assert.equal(groups.listGroups(database, 'owner').some(group => group.id === created.id), false);
  database.close();
});

test('有任务的自定义分组不能删除', () => {
  const database = testDb();
  const created = groups.createGroup(database, 'owner', { name: '有任务' });
  const taskDir = path.join(database.root, 'a-task');
  taskStore.forOwner(null, 'owner').createTask({ title: '测试任务', status: created.key, work_dir: taskDir });

  const listed = groups.listGroups(database, 'owner').find(group => group.id === created.id);
  assert.equal(listed.task_count, 1);
  assert.throws(() => groups.deleteGroup(database, 'owner', created.id), /TASK_GROUP_NOT_EMPTY/);

  taskStore.forOwner(null, 'owner').updateTask(taskStore.forOwner(null, 'owner').listTasks()[0].id, { status: 'todo' });
  groups.deleteGroup(database, 'owner', created.id);
  database.close();
});

test('分组保存在工作目录的 .t-agent/groups.json，重新加载仍然存在', () => {
  const database = testDb();
  const created = groups.createGroup(database, 'owner', { name: '持久化' });
  assert.ok(fs.existsSync(path.join(database.root, '.t-agent', 'groups.json')));
  assert.equal(groups.listGroups(database, 'owner').some(group => group.key === created.key), true);
});
