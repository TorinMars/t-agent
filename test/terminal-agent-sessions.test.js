const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-agent-terminals-'));
process.env.T_AGENT_DATA_DIR = root;
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
const home = path.join(root, 'home');
fs.mkdirSync(home);
process.env.HOME = home;
const db = require('../db');
const tasks = require('../services/engine-tasks');
const terminal = require('../routes/terminal');

const task = tasks.createTask('owner', { title: 'agents' });
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const claudeFolder = path.join(home, '.claude', 'projects', task.work_dir.replace(/[^A-Za-z0-9]/g, '-'));
const titles = () => Object.fromEntries(terminal.listTerminals(task.id, 'h5').map(row => [row.terminal_id, [row.agent || null, row.title]]));

test.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('a Claude terminal keeps its session id and follows the session title', () => {
  const row = terminal.createTerminal(task.id, 'h5', { agent: 'claude' });
  assert.equal(row.agent, 'claude');
  const stored = db.prepare('SELECT agent_session_id FROM task_terminals WHERE terminal_id = ?').get(row.terminal_id);
  assert.match(stored.agent_session_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(titles()[row.terminal_id], ['claude', 'Claude 2'], 'no session file yet: the stored name');
  fs.mkdirSync(claudeFolder, { recursive: true });
  const file = path.join(claudeFolder, `${stored.agent_session_id}.jsonl`);
  fs.writeFileSync(file, jsonl([{ type: 'user', message: { content: 'first prompt' } }, { type: 'ai-title', aiTitle: 'Generated name' }]));
  assert.deepEqual(titles()[row.terminal_id], ['claude', 'Generated name']);
  fs.appendFileSync(file, jsonl([{ type: 'custom-title', customTitle: 'Renamed in Claude' }]));
  assert.deepEqual(titles()[row.terminal_id], ['claude', 'Renamed in Claude']);
  assert.deepEqual(titles()['h5-default'], [null, 'Terminal 1']);
});

test('a new Codex terminal binds the session started after it and takes its thread name', () => {
  const row = terminal.createTerminal(task.id, 'h5', { agent: 'codex' });
  const day = path.join(home, '.codex', 'sessions', '2026', '10', '25');
  fs.mkdirSync(day, { recursive: true });
  const meta = (id, timestamp) => ({ type: 'session_meta', payload: { id, cwd: task.work_dir, timestamp } });
  fs.writeFileSync(path.join(day, 'rollout-old.jsonl'), jsonl([meta('dddddddd-0000', new Date(Date.now() - 3600_000).toISOString())]));
  assert.equal(titles()[row.terminal_id][1], 'Codex 3', 'an older session is not claimed');
  fs.writeFileSync(path.join(day, 'rollout-new.jsonl'), jsonl([meta('eeeeeeee-1111', new Date(Date.now() + 1000).toISOString())]));
  fs.writeFileSync(path.join(home, '.codex', 'session_index.jsonl'), jsonl([{ id: 'eeeeeeee-1111', thread_name: 'Thread one' }, { id: 'eeeeeeee-1111', thread_name: 'Thread renamed' }]));
  assert.deepEqual(titles()[row.terminal_id], ['codex', 'Thread renamed']);
  assert.equal(db.prepare('SELECT agent_session_id FROM task_terminals WHERE terminal_id = ?').get(row.terminal_id).agent_session_id, 'eeeeeeee-1111');
});

test('a reopened agent terminal resumes its bound session', () => {
  const claude = db.prepare("SELECT terminal_id, agent_session_id FROM task_terminals WHERE agent = 'claude'").get();
  const codex = db.prepare("SELECT terminal_id, agent_session_id FROM task_terminals WHERE agent = 'codex'").get();
  assert.equal(terminal.reopenCommand(task.id, claude.terminal_id, task.work_dir), `claude --resume ${claude.agent_session_id}`);
  assert.equal(terminal.reopenCommand(task.id, codex.terminal_id, task.work_dir), 'codex resume eeeeeeee-1111');
  fs.rmSync(path.join(claudeFolder, `${claude.agent_session_id}.jsonl`));
  assert.equal(terminal.reopenCommand(task.id, claude.terminal_id, task.work_dir), `claude --session-id ${claude.agent_session_id}`, 'no file yet: start it again');
  assert.equal(terminal.reopenCommand(task.id, 'h5-default', task.work_dir), null);
});
