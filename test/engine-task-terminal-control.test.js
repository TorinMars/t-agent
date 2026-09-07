const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-engine-task-'));
const dataDir = path.join(root, 'data');
const workspace = path.join(root, 'workspace');
process.env.T_AGENT_DATA_DIR = dataDir;
process.env.TASKS_BASE_DIR = workspace;
process.env.ENGINE_WORKSPACE_ROOTS = workspace;

const db = require('../db');
const tasks = require('../services/engine-tasks');
const terminal = require('../routes/terminal');

test.after(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('远程 Engine 新建任务时使用指定工作目录', () => {
  const requestedDir = path.join(workspace, 'customer-a', 'project-one');
  const created = tasks.createTask('owner', {
    title: '指定目录任务',
    work_dir: requestedDir,
  });

  assert.equal(created.work_dir, requestedDir);
  assert.equal(created.md_path, path.join(requestedDir, 'DESIGN.md'));
  assert.equal(fs.existsSync(path.join(requestedDir, 'DESIGN.md')), true);
  assert.equal(fs.existsSync(path.join(requestedDir, 'README.md')), true);
  assert.equal(fs.existsSync(path.join(requestedDir, 'AGENT.md')), true);
});

test('从工作目录重新打开会清除旧终端历史', () => {
  db.prepare('INSERT INTO terminal_logs (task_id, buffer) VALUES (?, ?)').run(9001, 'old terminal output');

  const result = terminal.controlSession(9001, 'restart-workdir');

  assert.deepEqual(result, { success: true, action: 'restart-workdir', had_session: false });
  assert.equal(db.prepare('SELECT buffer FROM terminal_logs WHERE task_id = ?').get(9001), undefined);
});

test('终端控制拒绝未知操作', () => {
  assert.throws(() => terminal.controlSession(9001, 'destroy-everything'), /INVALID_TERMINAL_ACTION/);
});
