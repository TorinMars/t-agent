// Renaming a task and its folder (services/task-rename.js, lib/agent-session-move.js): the folder, its Claude Code and Codex sessions and the task's
// records move together, or nothing does. The local routes, the Engine routes and the Client's remote proxy are the real ones; the home folder is a
// throwaway one, so ~/.claude and ~/.codex here are crafted copies; the PTY and the chat agent are fakes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

// A real path (macOS keeps temporary folders behind the /var symbolic link), so the sessions are named the way Claude Code names them.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-rename-')));
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
process.env.HOME = home; // os.homedir(): the sessions of the terminals and of the rename are read here, never in the real home
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'task-rename-test-secret-task-rename-test-secret';
const workRoot = path.join(root, 'tasks');
fs.mkdirSync(workRoot, { recursive: true });

const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports(req, res, next) { req.session = { user: { login: 'owner', work_dir: workRoot } }; next(); },
};
const shells = [];
const stubModule = (name, exports) => { const file = require.resolve(name); require.cache[file] = { id: file, filename: file, loaded: true, exports }; };
stubModule('../lib/node-pty-runtime', { repairSpawnHelperPermissions() {} });
stubModule('node-pty', { spawn(shell, args, options) {
  const pty = { pid: process.pid, options, killed: false, written: [], onData() {}, onExit(fn) { this.exit = fn; }, write(text) { this.written.push(text); }, pause() {}, resume() {}, resize() {}, kill() { this.killed = true; this.exit?.(); } };
  shells.push(pty);
  return pty;
} });

const turns = [];
const chatModule = require('../services/agent-chat');
const db = require('../db');
const chat = chatModule.createAgentChat({ db, adapters: { claude: {
  MODES: { ask: {}, full: {} }, DEFAULT_MODE: 'ask',
  loadHistory: async () => [],
  listModels: async () => [],
  runTurn: ({ signal }) => new Promise(resolve => { turns.push(signal); signal.addEventListener('abort', () => resolve({ ok: false })); }),
} } });
chatModule.getAgentChat = () => chat;

const express = require('express');
const Database = require('better-sqlite3');
const { createAccessToken } = require('../services/engine-auth');
const { encryptToken } = require('../lib/token-crypto');
const engineTasks = require('../services/engine-tasks');
const terminal = require('../routes/terminal');
const taskRename = require('../services/task-rename');
const { claudeProjectName, listSessions } = require('../lib/agent-sessions');

const servers = [];
const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); servers.push(server); });
let local, engine, proxy, oldProxyId, remoteId, auth;

test.before(async () => {
  const localApp = express();
  localApp.use(express.json());
  localApp.use('/api/tasks/:id/agent', require('../routes/agent-chat').createAgentChatRouter({ service: chat }));
  localApp.use('/api/tasks', require('../routes/tasks'));
  local = await listen(localApp);
  const engineApp = express();
  engineApp.use(express.json());
  engineApp.use('/v1', require('../routes/engine-v1'));
  engine = await listen(engineApp);
  const token = createAccessToken(db, { principalId: 'owner' }).token;
  auth = { Authorization: `Bearer ${token}` };
  // An Engine from before folder renaming: its capabilities do not list it.
  const oldApp = express();
  oldApp.get('/v1/info', (req, res) => res.json({ capabilities: ['tasks:read', 'tasks:write'] }));
  oldApp.post('/v1/tasks/:id/rename-folder', (req, res) => res.status(500).json({ error: 'MUST_NOT_BE_CALLED' }));
  const old = await listen(oldApp);
  const remote = base => db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
    .run('owner', base, base, encryptToken(token, process.env.SESSION_SECRET)).lastInsertRowid;
  remoteId = remote(engine);
  oldProxyId = remote(old);
  const proxyApp = express();
  proxyApp.use(express.json());
  proxyApp.use('/api/remote-servers', require('../routes/remote-servers'));
  proxy = await listen(proxyApp);
});

test.after(async () => {
  for (const row of db.prepare('SELECT id FROM tasks').all()) { terminal.closeTaskTerminals(row.id); chat.stopTask(row.id); }
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); })));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function call(method, url, body, headers = {}) {
  const response = await fetch(url, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: parsed };
}
const row = id => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
const jsonl = rows => rows.map(item => JSON.stringify(item)).join('\n') + '\n';
const claudeDir = path.join(home, '.claude');
const codexDir = path.join(home, '.codex');
const projectFolder = dir => path.join(claudeDir, 'projects', claudeProjectName(dir));
let serial = 0;

// A task with a folder under the tasks folder, a Claude session (with a sub-agent) in the folder and one in a subfolder, a Codex rollout and its state row,
// terminal rows, a default terminal folder and a cleaned repository record. Also two neighbours that must never change: a sibling folder whose name starts
// the same way, and its Claude and Codex sessions.
function fixture(title = null) {
  serial += 1;
  const task = engineTasks.createTask('owner', { title: title || `Rename me ${serial}` });
  const dir = task.work_dir;
  const id = `aaaaaaaa-0000-4000-8000-${String(serial).padStart(12, '0')}`;
  const codexId = `cccccccc-0000-4000-8000-${String(serial).padStart(12, '0')}`;
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  const claudeRows = [
    { type: 'permission-mode', permissionMode: 'default', sessionId: id },
    { type: 'user', cwd: dir, sessionId: id, message: { role: 'user', content: `look at ${dir}/src please` } },
    { type: 'assistant', cwd: path.join(dir, 'sub'), sessionId: id, message: { role: 'assistant', content: [{ type: 'text', text: `done in ${dir}` }] } },
  ];
  fs.mkdirSync(path.join(projectFolder(dir), id, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(projectFolder(dir), `${id}.jsonl`), jsonl(claudeRows) + '{"partial":');
  fs.writeFileSync(path.join(projectFolder(dir), id, 'subagents', 'agent-x.jsonl'), jsonl([{ type: 'user', cwd: dir, isSidechain: true, message: { role: 'user', content: 'sub' } }]));
  const subId = `bbbbbbbb-0000-4000-8000-${String(serial).padStart(12, '0')}`;
  fs.mkdirSync(projectFolder(path.join(dir, 'sub')), { recursive: true });
  fs.writeFileSync(path.join(projectFolder(path.join(dir, 'sub')), `${subId}.jsonl`), jsonl([{ type: 'user', cwd: path.join(dir, 'sub'), message: { role: 'user', content: 'in sub' } }]));
  const sibling = `${dir}-other`;
  fs.mkdirSync(sibling, { recursive: true });
  fs.mkdirSync(projectFolder(sibling), { recursive: true });
  fs.writeFileSync(path.join(projectFolder(sibling), 'dddddddd-0000-4000-8000-000000000001.jsonl'), jsonl([{ type: 'user', cwd: sibling, message: { role: 'user', content: 'sibling' } }]));
  const old = new Date('2026-01-02T03:04:05Z');
  fs.utimesSync(path.join(projectFolder(dir), `${id}.jsonl`), old, old);

  const day = path.join(codexDir, 'sessions', '2026', '11', String(serial).padStart(2, '0'));
  fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, `rollout-2026-11-11T00-00-00-${codexId}.jsonl`);
  fs.writeFileSync(rollout, jsonl([
    { type: 'session_meta', payload: { id: codexId, cwd: dir, runtime_workspace_roots: [dir], timestamp: '2026-11-11T00:00:00Z' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<environment_context>\n  <cwd>${dir}</cwd>\n</environment_context>` }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex prompt' }] } },
    { type: 'turn_context', payload: { cwd: dir, sandbox_policy: { type: 'workspace-write', writable_roots: [path.join(dir, 'out'), '/elsewhere'] } } },
    { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { cwd: dir, runtime_workspace_roots: [dir] } } },
  ]));
  const otherRollout = path.join(day, `rollout-2026-11-11T00-00-01-${codexId.replace('cccc', 'eeee')}.jsonl`);
  fs.writeFileSync(otherRollout, jsonl([{ type: 'session_meta', payload: { id: codexId.replace('cccc', 'eeee'), cwd: sibling } }]));
  const state = new Database(path.join(codexDir, 'state_5.sqlite'));
  state.exec('CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL DEFAULT \'\')');
  state.exec('CREATE TABLE IF NOT EXISTS project_roots (project_id TEXT NOT NULL, position INTEGER NOT NULL, path TEXT NOT NULL, PRIMARY KEY (project_id, position))');
  state.prepare('INSERT INTO threads (id, rollout_path, cwd) VALUES (?, ?, ?)').run(codexId, rollout, dir);
  state.prepare('INSERT INTO threads (id, rollout_path, cwd) VALUES (?, ?, ?)').run(codexId.replace('cccc', 'eeee'), otherRollout, sibling);
  state.prepare('INSERT INTO project_roots (project_id, position, path) VALUES (?, 0, ?)').run(`p${serial}`, dir);
  state.close();

  db.prepare("INSERT INTO task_terminals (task_id, terminal_id, title, agent, agent_session_id, work_dir) VALUES (?, 'c1', 'Claude', 'claude', ?, ?)").run(task.id, id, dir);
  db.prepare("INSERT INTO task_terminals (task_id, terminal_id, title, agent, work_dir) VALUES (?, 'x1', 'Shell', NULL, ?)").run(task.id, path.join(dir, 'sub'));
  db.prepare('INSERT OR REPLACE INTO task_default_terminal_dirs (task_id, work_dir) VALUES (?, ?)').run(task.id, dir);
  db.prepare("INSERT INTO repo_cleanups (task_id, path, remote, branch, commit_sha) VALUES (?, ?, 'git@x:y.git', 'main', 'abc')").run(task.id, path.join(dir, 'repo'));
  db.prepare('UPDATE tasks SET readme_path = ? WHERE id = ?').run(path.join(dir, 'docs', 'README.md'), task.id);
  return { task: row(task.id), dir, id, subId, codexId, rollout, otherRollout, sibling };
}

// Every file under the home and the tasks folder (path -> bytes) and the rows that name folders: what a refused or rolled back rename must leave as it was.
function snapshot() {
  const files = {};
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && !/\.sqlite(-wal|-shm|-journal)?$/.test(entry.name)) files[full] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(home);
  walk(workRoot);
  const state = new Database(path.join(codexDir, 'state_5.sqlite'), { readonly: true });
  const codex = { threads: state.prepare('SELECT * FROM threads ORDER BY id').all(), roots: state.prepare('SELECT * FROM project_roots ORDER BY project_id').all() };
  state.close();
  return {
    files, codex,
    tasks: db.prepare('SELECT id, title, work_dir, md_path, technical_path, readme_path, agent_path FROM tasks ORDER BY id').all(),
    terminals: db.prepare('SELECT task_id, terminal_id, work_dir FROM task_terminals ORDER BY task_id, terminal_id').all(),
    defaults: db.prepare('SELECT * FROM task_default_terminal_dirs ORDER BY task_id').all(),
    cleanups: db.prepare('SELECT task_id, path FROM repo_cleanups ORDER BY id').all(),
  };
}
const renameLocal = (id, body) => call('POST', `${local}/api/tasks/${id}/rename-folder`, body);
const rowsOf = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return line; } });

test('the folder, the Claude and Codex sessions and the task records move together; text and neighbours stay', async () => {
  const f = fixture('Old title');
  const newDir = path.join(workRoot, 'New-title');
  const answer = await renameLocal(f.task.id, { name: 'New-title', title: '  New title  ' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.old_dir, f.dir);
  assert.equal(answer.body.new_dir, newDir);
  assert.deepEqual(answer.body.moved, { claude_folders: 2, claude_files: 3, codex_rollouts: 1, codex_threads: 1 });
  assert.equal(fs.existsSync(f.dir), false);
  assert.ok(fs.existsSync(path.join(newDir, 'DESIGN.md')), 'the folder content moved');

  // Claude: the project folders have the new names, the cwd values follow, the message text and an unreadable line keep their bytes, the time stays.
  assert.equal(fs.existsSync(projectFolder(f.dir)), false);
  const file = path.join(projectFolder(newDir), `${f.id}.jsonl`);
  const text = fs.readFileSync(file, 'utf8');
  const rows = rowsOf(file);
  assert.equal(rows[1].cwd, newDir);
  assert.equal(rows[2].cwd, path.join(newDir, 'sub'));
  assert.equal(rows[1].message.content, `look at ${f.dir}/src please`, 'conversation text is never changed');
  assert.ok(text.endsWith('{"partial":'), 'a partial last line is kept as it is');
  assert.equal(fs.statSync(file).mtime.toISOString(), '2026-01-02T03:04:05.000Z', 'the session keeps its place in the lists');
  assert.equal(rowsOf(path.join(projectFolder(newDir), f.id, 'subagents', 'agent-x.jsonl'))[0].cwd, newDir, 'sub-agent logs too');
  assert.equal(rowsOf(path.join(projectFolder(path.join(newDir, 'sub')), `${f.subId}.jsonl`))[0].cwd, path.join(newDir, 'sub'), 'a session of a subfolder too');
  assert.deepEqual(listSessions('claude', newDir, home).map(item => item.id), [f.id], 'found by the new folder');
  assert.deepEqual(listSessions('claude', f.dir, home), [], 'nothing left under the old one');
  assert.equal(rowsOf(path.join(projectFolder(f.sibling), 'dddddddd-0000-4000-8000-000000000001.jsonl'))[0].cwd, f.sibling, 'the sibling folder is not inside');
  const leftovers = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { if (entry.isDirectory()) walk(path.join(dir, entry.name)); else if (/\.(bak|tmp)$/.test(entry.name)) leftovers.push(entry.name); } };
  walk(home);
  assert.deepEqual(leftovers, [], 'no backup or temporary file is left');

  // Codex: the rollout stays where it is with its folder fields rewritten; the state rows follow; the sibling's do not.
  const codexRows = rowsOf(f.rollout);
  assert.equal(codexRows[0].payload.cwd, newDir);
  assert.deepEqual(codexRows[0].payload.runtime_workspace_roots, [newDir]);
  assert.match(codexRows[1].payload.content[0].text, new RegExp(`<cwd>${f.dir}</cwd>`), 'the environment text of the conversation is kept');
  assert.equal(codexRows[3].payload.cwd, newDir);
  assert.deepEqual(codexRows[3].payload.sandbox_policy.writable_roots, [path.join(newDir, 'out'), '/elsewhere']);
  assert.equal(codexRows[4].payload.thread_settings.cwd, newDir);
  assert.deepEqual(listSessions('codex', newDir, home).map(item => item.id), [f.codexId]);
  assert.equal(rowsOf(f.otherRollout)[0].payload.cwd, f.sibling);
  const state = new Database(path.join(codexDir, 'state_5.sqlite'), { readonly: true });
  assert.equal(state.prepare('SELECT cwd FROM threads WHERE id = ?').get(f.codexId).cwd, newDir);
  assert.equal(state.prepare('SELECT cwd FROM threads WHERE id = ?').get(f.codexId.replace('cccc', 'eeee')).cwd, f.sibling);
  assert.equal(state.prepare('SELECT path FROM project_roots WHERE project_id = ?').get(`p${serial}`).path, newDir);
  state.close();

  // T-Agent: the task's paths and title, the terminal folders, the default terminal folder, the cleaned repository; the agent session ids stay.
  const task = row(f.task.id);
  assert.equal(task.title, 'New title');
  assert.equal(task.work_dir, newDir);
  assert.equal(task.md_path, path.join(newDir, 'DESIGN.md'));
  assert.equal(task.readme_path, path.join(newDir, 'docs', 'README.md'));
  assert.equal(answer.body.task.title, 'New title');
  const terminals = db.prepare('SELECT terminal_id, work_dir, agent_session_id FROM task_terminals WHERE task_id = ? ORDER BY terminal_id').all(f.task.id);
  assert.deepEqual(terminals, [{ terminal_id: 'c1', work_dir: newDir, agent_session_id: f.id }, { terminal_id: 'x1', work_dir: path.join(newDir, 'sub'), agent_session_id: null }]);
  assert.equal(db.prepare('SELECT work_dir FROM task_default_terminal_dirs WHERE task_id = ?').get(f.task.id).work_dir, newDir);
  assert.equal(db.prepare('SELECT path FROM repo_cleanups WHERE task_id = ?').get(f.task.id).path, path.join(newDir, 'repo'));

  // A terminal opened again starts in the new folder and resumes its Claude session there.
  const before = shells.length;
  attach(f.task, 'c1');
  assert.equal(shells.length, before + 1);
  assert.equal(shells.at(-1).options.cwd, newDir);
  assert.ok(shells.at(-1).written.some(line => line.includes(`claude --resume ${f.id}`)), shells.at(-1).written.join('|'));
  terminal.closeTaskTerminals(f.task.id);
});

class Socket extends EventEmitter {
  readyState = 1;
  send() {}
  ping() {}
  terminate() { this.close(1006); }
  close(code, reason) { this.readyState = 3; this.code = code; this.reason = reason; this.emit('close'); }
}
function attach(task, id) {
  const ws = new Socket();
  terminal.handleWs(ws, { url: `/terminal/ws?taskId=${task.id}&terminalId=${id}&clientId=test` }, { login: 'owner' });
  return ws;
}

test('a live terminal or a running chat turn refuses with TASK_BUSY and the terminal ids; after closing them the rename goes through', async () => {
  const f = fixture();
  attach(f.task, 'c1');
  const before = snapshot();
  const busy = await renameLocal(f.task.id, { name: 'busy-renamed' });
  assert.equal(busy.status, 409);
  assert.deepEqual(busy.body, { error: 'TASK_BUSY', terminals: ['c1'], chat: false });
  assert.deepEqual(snapshot(), before, 'nothing changed');
  const closed = await call('POST', `${local}/api/tasks/${f.task.id}/terminal/control`, { action: 'close', terminal_id: 'c1' });
  assert.equal(closed.status, 200);

  const conversation = chat.create(row(f.task.id), { agent: 'claude' });
  const sending = chat.sendMessage(row(f.task.id), conversation.id, { text: 'work' });
  await new Promise(resolve => setTimeout(resolve, 20));
  const chatting = await renameLocal(f.task.id, { name: 'busy-renamed' });
  assert.deepEqual([chatting.status, chatting.body.error, chatting.body.chat], [409, 'TASK_BUSY', true]);
  chat.stopTask(f.task.id);
  await sending.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 20));

  const done = await renameLocal(f.task.id, { name: 'busy-renamed' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(row(f.task.id).work_dir, path.join(workRoot, 'busy-renamed'));
});

test('names that are not one plain path segment are refused with 400, an existing target with 409, and nothing changes', async () => {
  const f = fixture();
  const before = snapshot();
  for (const name of ['', ' ', ' lead', 'trail ', '.', '..', 'a/b', 'a\\b', 'tab\there', 'x'.repeat(256), 42, null]) {
    const answer = await renameLocal(f.task.id, { name });
    assert.deepEqual([answer.status, answer.body.error], [400, 'INVALID_FOLDER_NAME'], JSON.stringify(name));
  }
  assert.deepEqual((await renameLocal(f.task.id, { name: path.basename(f.dir) })).body.error, 'FOLDER_NAME_UNCHANGED');
  assert.deepEqual((await renameLocal(f.task.id, { name: 'ok', title: '   ' })).body.error, 'TITLE_REQUIRED');
  const taken = await renameLocal(f.task.id, { name: path.basename(f.sibling) });
  assert.deepEqual([taken.status, taken.body.error, taken.body.path], [409, 'FOLDER_EXISTS', f.sibling]);
  assert.equal((await renameLocal(999999, { name: 'x' })).status, 404);
  assert.deepEqual(snapshot(), before);
});

test('protected folders, folders holding another task, Git worktrees and repositories with worktrees are refused; a plain repository moves', async () => {
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  const reason = async (task, name = 'renamed-x') => { const answer = await renameLocal(task.id, { name }); assert.equal(answer.status, 409, JSON.stringify(answer.body)); assert.equal(answer.body.error, 'FOLDER_NOT_RENAMABLE'); return answer.body.reason; };

  const outer = engineTasks.createTask('owner', { title: 'outer task' });
  engineTasks.createTask('owner', { title: 'inner', work_dir: path.join(outer.work_dir, 'inner') });
  assert.equal(await reason(outer), 'Contains directories of other tasks');
  const rootTask = engineTasks.createTask('owner', { title: 'the tasks folder', work_dir: workRoot });
  assert.equal(await reason(rootTask), 'Protected directory');

  const main = engineTasks.createTask('owner', { title: 'main repo' });
  git(main.work_dir, 'init', '-q', '-b', 'main');
  git(main.work_dir, 'commit', '-q', '--allow-empty', '-m', 'first');
  const worktreeDir = path.join(workRoot, 'linked-worktree');
  git(main.work_dir, 'worktree', 'add', '-q', worktreeDir);
  const linked = engineTasks.createTask('owner', { title: 'linked', work_dir: worktreeDir });
  assert.match(await reason(linked), /is a Git worktree/);
  assert.match(await reason(main), /linked worktrees/);
  const holder = engineTasks.createTask('owner', { title: 'holder' });
  git(main.work_dir, 'worktree', 'add', '-q', path.join(holder.work_dir, 'nested', 'wt'));
  assert.match(await reason(holder), /^A Git worktree or submodule inside the folder would break: nested\/wt$/);

  const plain = engineTasks.createTask('owner', { title: 'plain repo' });
  git(plain.work_dir, 'init', '-q');
  const moved = await renameLocal(plain.id, { name: 'plain-repo-moved' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.ok(fs.existsSync(path.join(workRoot, 'plain-repo-moved', '.git')));
});

for (const failAt of ['folder', 'claude', 'codex']) {
  test(`a failure after the ${failAt} step puts everything back`, () => {
    const f = fixture();
    const before = snapshot();
    assert.throws(() => taskRename.renameTaskFolder({
      db, owner: 'owner', taskId: f.task.id, body: { name: `fail-${failAt}`, title: 'never' }, workRoot,
      busy: () => ({ terminals: [], chat: false }), hooks: { afterStep(name) { if (name === failAt) throw new Error('boom'); } },
    }), error => error.message === 'RENAME_FAILED' && /boom/.test(error.reason));
    assert.deepEqual(snapshot(), before);
  });
}

test('a failure inside a step puts everything back: a clash in the Claude projects, an unreadable Codex state, the task records', () => {
  const opts = (f, name) => ({ db, owner: 'owner', taskId: f.task.id, body: { name }, workRoot, busy: () => ({ terminals: [], chat: false }) });

  const clash = fixture();
  fs.mkdirSync(projectFolder(path.join(workRoot, 'clash-target')), { recursive: true });
  let before = snapshot();
  assert.throws(() => taskRename.renameTaskFolder(opts(clash, 'clash-target')), error => error.message === 'RENAME_FAILED' && /SESSION_FOLDER_CONFLICT/.test(error.reason));
  assert.deepEqual(snapshot(), before);

  const codexBroken = fixture();
  const brokenState = path.join(codexDir, 'state_9.sqlite');
  fs.writeFileSync(brokenState, 'this is not a database');
  before = snapshot();
  assert.throws(() => taskRename.renameTaskFolder(opts(codexBroken, 'codex-broken')), error => error.message === 'RENAME_FAILED' && /CODEX_STATE/.test(error.reason));
  assert.deepEqual(snapshot(), before);
  fs.rmSync(brokenState);

  const records = fixture();
  db.exec("CREATE TRIGGER refuse_rename BEFORE UPDATE OF work_dir ON task_terminals BEGIN SELECT RAISE(ABORT, 'records refused'); END");
  before = snapshot();
  try {
    assert.throws(() => taskRename.renameTaskFolder(opts(records, 'records-refused')), error => error.message === 'RENAME_FAILED' && /records refused/.test(error.reason));
  } finally { db.exec('DROP TRIGGER refuse_rename'); }
  assert.deepEqual(snapshot(), before, 'the task row is untouched too: the records are one transaction');
});

test('a folder reached through a symbolic link: the sessions under its real path move too', () => {
  const realParent = path.join(root, 'real-parent');
  const linkParent = path.join(workRoot, 'linked-parent');
  fs.mkdirSync(path.join(realParent, 'proj'), { recursive: true });
  fs.symlinkSync(realParent, linkParent);
  const task = engineTasks.createTask('owner', { title: 'via link', work_dir: path.join(linkParent, 'proj') });
  const realDir = path.join(realParent, 'proj');
  fs.mkdirSync(projectFolder(realDir), { recursive: true });
  fs.writeFileSync(path.join(projectFolder(realDir), 'ffffffff-0000-4000-8000-000000000001.jsonl'), jsonl([{ type: 'user', cwd: realDir, message: { role: 'user', content: 'x' } }]));
  const result = taskRename.renameTaskFolder({ db, owner: 'owner', taskId: task.id, body: { name: 'proj2' }, workRoot, busy: () => ({ terminals: [], chat: false }) });
  assert.equal(result.new_dir, path.join(linkParent, 'proj2'));
  assert.equal(rowsOf(path.join(projectFolder(path.join(realParent, 'proj2')), 'ffffffff-0000-4000-8000-000000000001.jsonl'))[0].cwd, path.join(realParent, 'proj2'));
});

test('a title rename through PUT follows the creation rule, here and on an Engine', async () => {
  const f = fixture('Plain title');
  assert.deepEqual([(await call('PUT', `${local}/api/tasks/${f.task.id}`, { title: '   ' })).status], [400]);
  const saved = await call('PUT', `${local}/api/tasks/${f.task.id}`, { title: '  Better title ' });
  assert.equal(saved.body.title, 'Better title');
  assert.equal(row(f.task.id).work_dir, f.dir, 'a title rename leaves the folder');
  const remote = await call('PUT', `${proxy}/api/remote-servers/${remoteId}/tasks/${f.task.id}`, { title: 'Remote title' });
  assert.equal(remote.status, 200);
  assert.equal(row(f.task.id).title, 'Remote title');
  const empty = await call('PUT', `${proxy}/api/remote-servers/${remoteId}/tasks/${f.task.id}`, { title: '' });
  assert.deepEqual([empty.status, empty.body.error], [400, 'TITLE_REQUIRED']);
});

test('the Engine route, its capability and the Client proxy: success, a refusal with its details, and an older Engine', async () => {
  const info = await call('GET', `${engine}/v1/info`, undefined, auth);
  assert.ok(info.body.capabilities.includes('tasks:rename-folder'));
  const f = fixture();
  const direct = await call('POST', `${engine}/v1/tasks/${f.task.id}/rename-folder`, { name: 'via-engine' }, auth);
  assert.equal(direct.status, 200, JSON.stringify(direct.body));
  assert.equal(direct.body.task.work_dir, path.join(workRoot, 'via-engine'));
  assert.equal(direct.body.task.user_id, undefined, 'the public task shape');
  assert.equal((await call('POST', `${engine}/v1/tasks/${f.task.id}/rename-folder`, { name: 'x' })).status, 401);

  const g = fixture();
  const proxied = await call('POST', `${proxy}/api/remote-servers/${remoteId}/tasks/${g.task.id}/rename-folder`, { name: 'via-proxy', title: 'Proxied' });
  assert.equal(proxied.status, 200, JSON.stringify(proxied.body));
  assert.equal(row(g.task.id).work_dir, path.join(workRoot, 'via-proxy'));
  assert.equal(row(g.task.id).title, 'Proxied');
  assert.deepEqual(listSessions('claude', path.join(workRoot, 'via-proxy'), home).map(item => item.id), [g.id]);

  attach(row(g.task.id), 'c1');
  const busy = await call('POST', `${proxy}/api/remote-servers/${remoteId}/tasks/${g.task.id}/rename-folder`, { name: 'again' });
  assert.deepEqual([busy.status, busy.body], [409, { error: 'TASK_BUSY', terminals: ['c1'], chat: false }]);
  terminal.closeTaskTerminals(g.task.id);
  const taken = await call('POST', `${proxy}/api/remote-servers/${remoteId}/tasks/${g.task.id}/rename-folder`, { name: path.basename(g.sibling) });
  assert.deepEqual([taken.status, taken.body.error, taken.body.path], [409, 'FOLDER_EXISTS', g.sibling]);
  const bad = await call('POST', `${proxy}/api/remote-servers/${remoteId}/tasks/${g.task.id}/rename-folder`, { name: '../x' });
  assert.deepEqual([bad.status, bad.body.error], [400, 'INVALID_FOLDER_NAME']);

  const older = await call('POST', `${proxy}/api/remote-servers/${oldProxyId}/tasks/1/rename-folder`, { name: 'x' });
  assert.deepEqual([older.status, older.body.error], [501, 'RENAME_FOLDER_UNSUPPORTED']);
});
