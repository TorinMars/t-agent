// "Run a script" of T-Attention schedules with real terminals (routes/terminal.js runScript: a new terminal of the task, the exit status read from the
// wrapper's markers, the time limit) and through the service (services/attention.js: script_done / script_failed, the last 5 terminals kept).
// A temporary data folder and HOME (an empty .zshrc, so the user's shell setup is never read), a task in a temporary folder, short scripts.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-attention-script-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.HOME = path.join(root, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.HOME, '.zshrc'), '');
fs.writeFileSync(path.join(process.env.HOME, '.bashrc'), '');
for (const name of ['TA_HOOK_URL', 'TA_HOOK_TOKEN', 'TA_ATTENTION_URL', 'TA_ATTENTION_TOKEN', 'TA_SESSION_NAME', 'TA_PEER_URL', 'TA_TCLI']) delete process.env[name];

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const db = require('../db');
const terminal = require('../routes/terminal');
const { createAttentionService } = require('../services/attention');

const work = path.join(root, 'work');
fs.mkdirSync(work);
const taskId = Number(db.prepare("INSERT INTO tasks (title, work_dir) VALUES ('Scripts', ?)").run(work).lastInsertRowid);
const run = (script, options = {}) => new Promise((resolve, reject) => {
  try {
    const started = terminal.runScript(taskId, { title: 'Run', script, ...options, onEnd: result => resolve({ started, result }) });
    if (!started.terminal_id) reject(new Error('no terminal'));
  } catch (error) { reject(error); }
});

test.after(() => {
  terminal.shutdownTerminals();
  db.close();
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a shell that is still ending writes its history */ }
});

test('a script runs in a new terminal of the task, in its folder, and its exit status is known (0 and 2); the terminal stays with its output', async () => {
  const ok = await run('echo "made in $(pwd)" > out.txt; exit 0');
  assert.deepEqual([ok.result.outcome, ok.result.exit], ['exit', 0]);
  assert.equal(fs.realpathSync(fs.readFileSync(path.join(work, 'out.txt'), 'utf8').trim().replace(/^made in /, '')), fs.realpathSync(work));
  const failed = await run('echo before; exit 2');
  assert.deepEqual([failed.result.outcome, failed.result.exit], ['exit', 2]);
  assert.ok(failed.result.duration_ms >= 0);
  const rows = db.prepare('SELECT terminal_id, title FROM task_terminals WHERE task_id = ?').all(taskId).map(row => row.terminal_id);
  assert.ok(rows.includes(ok.started.terminal_id) && rows.includes(failed.started.terminal_id), 'normal terminals of the task');
  assert.equal(terminal.terminalInfo(taskId, failed.started.terminal_id).live, true, 'the shell stays at its prompt');
  assert.deepEqual(fs.readdirSync(path.join(process.env.T_AGENT_DATA_DIR, 'attention-scripts')), [], 'the script files are removed');
});

test('the time limit stops the script\'s process group', async () => {
  const marker = `sleep ${40 + Math.floor(Math.random() * 50)}`;
  const { result } = await run(`${marker}; echo never`, { timeoutMs: 1500 });
  assert.equal(result.outcome, 'timeout');
  await new Promise(resolve => setTimeout(resolve, 500));
  const table = execFileSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8' });
  assert.ok(!table.split('\n').some(line => line.trim() === marker), `${marker} is not running any more`);
});

test('through the service: exit 0 is done, exit 2 is Needs you with its terminal, and an item keeps its last 5 script terminals', async () => {
  const service = createAttentionService({ db, timeZone: () => 'Asia/Taipei' });
  service.setSessions({ check: terminal.promptState, send: terminal.sendPrompt, scriptTask: terminal.scriptTaskState, runScript: terminal.runScript, removeTerminal: terminal.removeScriptTerminal });
  const ended = id => new Promise(resolve => {
    const stop = service.onChange(change => {
      if (change.item.id === id && change.event && ['script_done', 'script_failed'].includes(change.event.type)) { stop(); resolve(change); }
    });
  });
  const item = service.create({ title: 'Check', then_action: { kind: 'script', task_id: taskId, script: 'exit 2' } });
  let done = ended(item.id);
  service.runNow(item.id, { actor: 'user' });
  let change = await done;
  assert.equal(change.event.type, 'script_failed');
  assert.match(change.item.attention_reason, /^Script failed \(exit 2\) at \d\d:\d\d$/);
  assert.equal(change.item.context.tagent.terminal_id, change.item.script_runs[0].terminal_id);

  const repeat = service.create({ title: 'Nightly', schedule: { kind: 'repeat', rule: { freq: 'daily', time: '03:00' } }, then_action: { kind: 'script', task_id: taskId, script: 'exit 0' } });
  const terminals = [];
  for (let index = 0; index < 6; index += 1) {
    done = ended(repeat.id);
    service.runNow(repeat.id, { actor: 'user' });
    change = await done;
    assert.equal(change.event.type, 'script_done');
    terminals.push(change.event.data.terminal_id);
  }
  assert.deepEqual([change.item.status, change.item.schedule_state], ['todo', 'waiting']);
  assert.deepEqual(change.item.script_runs.map(entry => entry.terminal_id), terminals.slice(1));
  const left = db.prepare('SELECT terminal_id FROM task_terminals WHERE task_id = ?').all(taskId).map(row => row.terminal_id);
  assert.ok(!left.includes(terminals[0]), 'the oldest terminal of the item is removed');
  for (const id of terminals.slice(1)) assert.ok(left.includes(id));
});
