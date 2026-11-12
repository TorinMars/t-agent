// Each terminal keeps the directory it was started in (schema 8): changing the task's working directory only affects terminals created
// afterwards. The real claude / codex binaries are never started: node-pty is mocked and the agents' session files are written by hand
// under a fake HOME inside a temporary data folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-start-dir-'));
process.env.T_AGENT_DATA_DIR = root;
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
const home = path.join(root, 'home');
fs.mkdirSync(home);
process.env.HOME = home;
const db = require('../db');
// Peer file access off: these commands are the ones without the `t-agent-peers` MCP server (test/terminal-peer-mcp.test.js has those).
require('../services/peer-fs-settings').peerFsSettings().setEnabled(false);
const tasks = require('../test-support/older-tasks').olderTasks(require('../services/engine-tasks'), db);
const shells = [];
const terminalPath = path.resolve(__dirname, '../routes/terminal.js');
const mod = { exports: {} };
vm.runInNewContext(fs.readFileSync(terminalPath, 'utf8'), {
  module: mod, __dirname: path.dirname(terminalPath), process, console: { ...console, warn() {} }, URL,
  setInterval, clearInterval, Buffer,
  require(name) {
    if (name === '../lib/node-pty-runtime') return { repairSpawnHelperPermissions() {} };
    if (name === 'node-pty') return { spawn(shell, args, options) {
      const pty = { options, input: [], killed: false,
        onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; },
        write(text) { this.input.push(text); }, pause() {}, resume() {}, resize() {},
        kill() { this.killed = true; this.exit(); },
      };
      shells.push(pty);
      return pty;
    } };
    return require(name.startsWith('.') ? path.resolve(path.dirname(terminalPath), name) : name);
  },
});
const terminal = mod.exports;
class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.emit('close'); }
}
const HOOK = '--settings "$TA_CLAUDE_SETTINGS"';
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const projectFolder = dir => path.join(home, '.claude', 'projects', path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-'));
const boundSession = id => db.prepare('SELECT agent_session_id FROM task_terminals WHERE terminal_id = ?').get(id).agent_session_id;
const rowOf = (taskId, id) => terminal.listTerminals(taskId).find(item => item.terminal_id === id);

function open(taskId, id) {
  const ws = new Socket();
  terminal.handleWs(ws, { url: `/terminal/ws?taskId=${taskId}&terminalId=${id}&clientId=test` }, { login: 'owner' });
  return { pty: shells[shells.length - 1], ws };
}

const task = tasks.createTask('owner', { title: 'start dir' });
const oldDir = task.work_dir;
const newDir = path.join(root, 'tasks', 'moved-here');
fs.mkdirSync(newDir, { recursive: true });

test.after(() => {
  terminal.closeTaskTerminals(task.id);
  terminal.setHookEndpoint(null);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('terminals keep their own directory after the task working directory changes', async () => {
  terminal.setHookEndpoint('http://127.0.0.1:9/hooks/terminal-activity');
  // Before the change: the default terminal, a Claude terminal and a Codex terminal, all in the old directory.
  const first = open(task.id, 'default').pty;
  assert.equal(first.options.cwd, oldDir);
  const claude = terminal.createTerminal(task.id, { agent: 'claude' });
  assert.equal(claude.work_dir, oldDir, 'the create answer names the directory');
  const claudePty = open(task.id, claude.terminal_id).pty;
  assert.equal(claudePty.options.cwd, oldDir);
  const token = claudePty.options.env.TA_HOOK_TOKEN;
  const sessionId = boundSession(claude.terminal_id);
  fs.mkdirSync(projectFolder(oldDir), { recursive: true });
  fs.writeFileSync(path.join(projectFolder(oldDir), `${sessionId}.jsonl`), jsonl([{ type: 'user', message: { content: 'first prompt' } }, { type: 'custom-title', customTitle: 'Old dir session' }]));
  const subagents = path.join(projectFolder(oldDir), sessionId, 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  fs.writeFileSync(path.join(subagents, 'agent-one.jsonl'), jsonl([{ type: 'user', message: { content: 'work' } }]));
  const codex = terminal.createTerminal(task.id, { agent: 'codex' });
  open(task.id, codex.terminal_id);

  tasks.updateTask('owner', task.id, { work_dir: newDir });
  assert.equal(db.prepare('SELECT work_dir FROM tasks WHERE id = ?').get(task.id).work_dir, newDir);

  // The session name is still found, from the terminal's own directory.
  const listed = rowOf(task.id, claude.terminal_id);
  assert.equal(listed.title, 'Old dir session');
  assert.equal(listed.work_dir, oldDir);
  assert.equal(rowOf(task.id, 'default').work_dir, oldDir, 'the default terminal recorded the directory it first started in');

  // The Codex terminal binds the session Codex started in its own (old) directory.
  const day = path.join(home, '.codex', 'sessions', '2026', '11', '07');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, 'rollout-old-dir.jsonl'), jsonl([{ type: 'session_meta', payload: { id: 'cccccccc-0001', cwd: oldDir, timestamp: new Date(Date.now() + 1000).toISOString() } }]));
  fs.writeFileSync(path.join(day, 'rollout-new-dir.jsonl'), jsonl([{ type: 'session_meta', payload: { id: 'cccccccc-0002', cwd: newDir, timestamp: new Date(Date.now() + 1000).toISOString() } }]));
  terminal.listTerminals(task.id);
  assert.equal(boundSession(codex.terminal_id), 'cccccccc-0001');

  // Sub-agents are counted from the old directory.
  assert.deepEqual(JSON.parse(JSON.stringify(terminal.subagentSnapshot([task.id], home))), { [task.id]: { [claude.terminal_id]: 1 } });

  // The /clear hook: the old directory is this terminal's directory, the task's new one is not.
  const cleared = '0f0e0d0c-1111-4222-8333-444455556666';
  assert.equal(terminal.reportHook(task.id, claude.terminal_id, token, 'session', { session_id: cleared, source: 'clear', cwd: newDir }), 400);
  assert.equal(boundSession(claude.terminal_id), sessionId);
  assert.equal(terminal.reportHook(task.id, claude.terminal_id, token, 'session', { session_id: cleared, source: 'clear', cwd: oldDir }), 204);
  assert.equal(boundSession(claude.terminal_id), cleared);
  fs.writeFileSync(path.join(projectFolder(oldDir), `${cleared}.jsonl`), jsonl([{ type: 'user', message: { content: 'after clear' } }]));

  // A respawned shell starts in the old directory and resumes the conversation there.
  terminal.controlSession(task.id, 'restart-workdir', claude.terminal_id);
  const again = open(task.id, claude.terminal_id).pty;
  assert.equal(again.options.cwd, oldDir);
  assert.deepEqual(again.input, [`claude --resume ${cleared} ${HOOK}\r`]);
  assert.equal(terminal.reopenCommand(task.id, claude.terminal_id, oldDir), `claude --resume ${cleared} ${HOOK}`);
  terminal.controlSession(task.id, 'restart-workdir', 'default');
  assert.equal(open(task.id, 'default').pty.options.cwd, oldDir, 'the default terminal also stays');

  // A terminal created now uses the new directory, and so does the list of sessions to resume.
  const fresh = terminal.createTerminal(task.id, { agent: 'claude' });
  assert.equal(fresh.work_dir, newDir);
  assert.equal(open(task.id, fresh.terminal_id).pty.options.cwd, newDir);
  assert.equal(rowOf(task.id, fresh.terminal_id).work_dir, newDir);
  assert.equal(terminal.listAgentSessions({ work_dir: newDir }, 'claude').length, 0);
  const freshToken = shells[shells.length - 1].options.env.TA_HOOK_TOKEN;
  assert.equal(terminal.reportHook(task.id, fresh.terminal_id, freshToken, 'session', { session_id: cleared, source: 'clear', cwd: oldDir }), 400, 'the old directory is not the new terminal\'s');
  terminal.controlSession(task.id, 'delete', fresh.terminal_id);
});

test('file reads with ?terminal= use that terminal\'s directory; the file browser stays on the task', async () => {
  const express = require('express');
  const { createTaskFilesRouter } = require('../routes/task-files');
  fs.writeFileSync(path.join(oldDir, 'old.txt'), 'in the old directory\n');
  fs.writeFileSync(path.join(newDir, 'new.txt'), 'in the new directory\n');
  const app = express();
  app.use(express.json());
  app.use('/tasks/:id/files', createTaskFilesRouter({ getTask: req => db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/tasks/${task.id}/files`;
  const get = async url => { const res = await fetch(url); return [res.status, await res.json()]; };
  try {
    const claude = db.prepare("SELECT terminal_id FROM task_terminals WHERE task_id = ? AND agent = 'claude'").get(task.id).terminal_id;
    assert.deepEqual((await get(`${base}/content?path=new.txt`))[1].content, 'in the new directory\n');
    assert.equal((await get(`${base}/content?path=old.txt`))[0], 404, 'the task root is the new directory');
    assert.equal((await get(`${base}/content?terminal=${claude}&path=old.txt`))[1].content, 'in the old directory\n');
    assert.equal((await get(`${base}/content?terminal=default&path=old.txt`))[1].content, 'in the old directory\n');
    assert.equal((await get(`${base}/content?terminal=no-such&path=old.txt`))[0], 404);
    assert.equal((await get(`${base}/content?terminal=${claude}&path=../moved-here/new.txt`))[0], 400, 'still confined to the root');
    const listing = (await get(`${base}?terminal=${claude}&path=&offset=0`))[1];
    assert.ok(listing.entries.some(entry => entry.name === 'old.txt'));
    const put = await fetch(`${base}/content?terminal=${claude}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'old.txt', content: 'x' }) });
    assert.notEqual(put.status, 200, 'writes ignore ?terminal= and use the task root (no old.txt there)');
    assert.equal(fs.readFileSync(path.join(oldDir, 'old.txt'), 'utf8'), 'in the old directory\n');
  } finally {
    server.close();
  }
});

test('a terminal whose directory is gone starts in the task directory, and its hook accepts that one', () => {
  terminal.setHookEndpoint('http://127.0.0.1:9/hooks/terminal-activity');
  const gone = path.join(root, 'tasks', 'gone');
  fs.mkdirSync(gone);
  tasks.updateTask('owner', task.id, { work_dir: gone });
  const row = terminal.createTerminal(task.id, { agent: 'claude' });
  tasks.updateTask('owner', task.id, { work_dir: newDir });
  fs.rmSync(gone, { recursive: true, force: true });
  const { pty, ws } = open(task.id, row.terminal_id);
  assert.equal(pty.options.cwd, newDir);
  assert.ok(pty.input.length === 1 && ws.readyState === 1);
  const token = pty.options.env.TA_HOOK_TOKEN;
  assert.equal(terminal.reportHook(task.id, row.terminal_id, token, 'session', { session_id: '0f0e0d0c-2222-4222-8333-444455556666', source: 'clear', cwd: newDir }), 204);
  assert.equal(rowOf(task.id, row.terminal_id).work_dir, gone, 'the terminal still names its own directory');
  terminal.controlSession(task.id, 'delete', row.terminal_id);
});

test('a default terminal that never started follows the task; a deleted one forgets its directory', () => {
  const other = tasks.createTask('owner', { title: 'never started' });
  const moved = path.join(root, 'tasks', 'other-moved');
  fs.mkdirSync(moved);
  tasks.updateTask('owner', other.id, { work_dir: moved });
  assert.equal(rowOf(other.id, 'default').work_dir, moved);
  assert.equal(open(other.id, 'default').pty.options.cwd, moved);
  assert.equal(db.prepare('SELECT work_dir FROM task_default_terminal_dirs WHERE task_id = ?').get(other.id).work_dir, moved);
  terminal.controlSession(other.id, 'delete', 'default');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_default_terminal_dirs WHERE task_id = ?').get(other.id).n, 0);
});
