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

const db = require('../db');
const tasks = require('../services/engine-tasks');
const terminal = require('../routes/terminal');

test.after(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('A remote Engine can use a specified working directory outside the default root and creates DESIGN.md by default', () => {
  const requestedDir = path.join(root, 'external-projects', 'customer-a', 'project-one');
  const created = tasks.createTask('owner', {
    title: 'Specified directory task',
    work_dir: requestedDir,
  });

  assert.equal(created.work_dir, requestedDir);
  assert.equal(created.md_path, path.join(requestedDir, 'DESIGN.md'));
  assert.equal(fs.existsSync(path.join(requestedDir, 'DESIGN.md')), true);
  assert.equal(fs.existsSync(path.join(requestedDir, 'README.md')), true);
  assert.equal(fs.existsSync(path.join(requestedDir, 'AGENTS.md')), true);
});

test('A remote Engine rejects a relative working directory', () => {
  assert.throws(() => tasks.createTask('owner', {
    title: 'Relative directory task',
    work_dir: 'relative/project',
  }), /WORKSPACE_PATH_MUST_BE_ABSOLUTE/);
});

test('Reopening from the working directory clears the old terminal history', () => {
  db.prepare('INSERT INTO terminal_logs (task_id, buffer) VALUES (?, ?)').run(9001, 'old terminal output');

  const result = terminal.controlSession(9001, 'restart-workdir');

  assert.deepEqual(result, { success: true, action: 'restart-workdir', had_session: false });
  assert.equal(db.prepare('SELECT buffer FROM terminal_logs WHERE task_id = ?').get(9001), undefined);
});

test('Terminal control rejects unknown actions', () => {
  assert.throws(() => terminal.controlSession(9001, 'destroy-everything'), /INVALID_TERMINAL_ACTION/);
});

test('A terminal can be renamed, including the default one, and the name is validated', () => {
  const task = tasks.createTask('owner', { title: 'Rename terminals', work_dir: path.join(root, 'rename-terminals') });
  const extra = terminal.createTerminal(task.id);

  assert.deepEqual(terminal.renameTerminal(task.id, extra.terminal_id, '  Build   server '), { terminal_id: extra.terminal_id, title: 'Build server' });
  assert.deepEqual(terminal.renameTerminal(task.id, 'default', 'Main shell'), { terminal_id: 'default', title: 'Main shell' });
  assert.deepEqual(terminal.listTerminals(task.id).map(row => row.title), ['Main shell', 'Build server']);

  assert.throws(() => terminal.renameTerminal(task.id, 'default', '   '), /TERMINAL_TITLE_REQUIRED/);
  assert.throws(() => terminal.renameTerminal(task.id, 'default', 'x'.repeat(41)), /TERMINAL_TITLE_TOO_LONG/);
  assert.throws(() => terminal.renameTerminal(task.id, '00000000-0000-4000-8000-000000000000', 'Nope'), /TERMINAL_NOT_FOUND/);
  assert.equal(terminal.listTerminals(task.id)[0].title, 'Main shell');
});
