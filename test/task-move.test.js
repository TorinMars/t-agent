// Moving a task to another engine (services/task-move.js, routes/task-move.js; docs/design/task-move.md): two engines in this process, each with its
// own database, data folder, tasks folder and agent homes (all temporary), joined by a service link over real HTTP. The whole move (folder with
// nested folders, links, an executable, .git, a large file in chunks; Claude Code and Codex session files; rows), the tier rule, the refusals,
// a failure injected at each step (the source keeps its task, the target keeps nothing) and a crash at each step followed by the recovery of a start
// (the task ends on exactly one engine). The real ~/.claude and ~/.codex are never touched: the agent homes are injected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-task-move-data-'));
delete process.env.TAGENT_HOME;
const express = require('express');
const Database = require('better-sqlite3');
const { createTaskMove, repointAttention, HOLD_PREFIX } = require('../services/task-move');
const routes = require('../routes/task-move');
const workspaceTools = require('../services/workspace-tools');
const taskRename = require('../services/task-rename');
const { claudeProjectName } = require('../lib/agent-sessions');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const ZH = '\u7b14\u8bb0';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await settle(25);
  }
}
const crash = () => Object.assign(new Error('CRASH'), { crash: true });

// The columns db/index.js adds to an older database (schema.sql alone has the oldest shape).
function migrate(db) {
  db.exec(SCHEMA);
  const add = (table, column, type) => { if (!db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`); };
  for (const column of ['user_id', 'share_token', 'work_dir', 'technical_path', 'readme_path', 'agent_path', 'archived_at']) add('tasks', column, 'TEXT');
  for (const [column, type] of [['agent', 'TEXT'], ['agent_session_id', 'TEXT'], ['agent_started_at', 'INTEGER'], ['title_custom', 'INTEGER'], ['work_dir', 'TEXT']]) add('task_terminals', column, type);
  for (const column of ['model', 'effort', 'queue']) add('agent_conversations', column, 'TEXT');
  for (const column of ['opened_web', 'opened_h5', 'translate', 'collapse_keyboard']) add('agent_conversations', column, 'INTEGER');
  add('attention_items', 'context', 'TEXT');
}

function makeService(side) {
  return createTaskMove({
    db: side.db, dataDir: side.dataDir, identity: () => ({ instance_id: side.instanceId, name: side.name }), owner: () => 'me',
    tasksBase: () => side.tasksBase, agentDirs: () => ({ claude: [side.claudeDir], codex: [side.codexDir] }),
    serviceLinks: { peers: () => side.peers, linkForToken: token => side.linkByToken.get(token) || null },
    request: side.request, isCompany: () => side.company, limitBytes: () => side.limit,
    terminals: { live: id => side.live.get(Number(id)) || [], busy: id => (side.live.get(Number(id)) || []).length ? 1 : 0, close: id => { side.closed.push(Number(id)); side.live.delete(Number(id)); } },
    chat: { busy: () => false, stop: () => {} },
    folderGuard: task => workspaceTools.taskDirectoryGuard(side.db, 'me', task, side.tasksBase),
    worktreeReason: dir => taskRename.worktreeReason(dir),
    visibility: {
      isDenied: (taskId, linkId) => Boolean(side.denied.get(Number(taskId)) && side.denied.get(Number(taskId)).has(linkId)),
      deniedLinks: taskId => [...(side.denied.get(Number(taskId)) || [])],
      setDenied: (login, taskId, list) => side.denied.set(Number(taskId), new Set(list)),
      forgetTask: taskId => side.denied.delete(Number(taskId)),
    },
    taskOrder: { replace: (login, from, to) => { side.order = side.order.map(key => (key === from ? to : key)); } },
    pageState: { recordMove: (login, move) => side.moves.push(move) },
    attention: { repoint: (taskId, to) => repointAttention(side.db, taskId, to) },
    lock: { add: id => side.locked.add(Number(id)), delete: id => side.locked.delete(Number(id)) },
    settleMs: 0, chunkBytes: 256 * 1024, concurrency: 3, retryMs: 0,
    hooks: { at: (point, record) => { if (side.at) side.at(point, record); } },
    log: { warn: message => side.logs.push(message), info() {} },
  });
}

async function makeEngine(t, name, { company = false, limit = 64 * 1024 * 1024 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `t-agent-move-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const side = {
    name, root, instanceId: crypto.randomUUID(), company, limit, peers: [], linkByToken: new Map(), live: new Map(), closed: [], denied: new Map(),
    order: [], moves: [], locked: new Set(), logs: [], at: null,
    dataDir: path.join(root, 'data'), tasksBase: path.join(root, 'tasks'), claudeDir: path.join(root, 'home', '.claude'), codexDir: path.join(root, 'home', '.codex'),
    capabilities: ['tasks:read', 'tasks:move'],
  };
  fs.mkdirSync(side.tasksBase, { recursive: true });
  side.db = new Database(path.join(root, 'db.sqlite'));
  migrate(side.db);
  t.after(() => side.db.close());
  side.request = async (baseUrl, route, token, opts = {}) => {
    const peer = side.peers.find(candidate => candidate.baseUrl === baseUrl);
    if (!peer || !peer.online) throw Object.assign(new Error('REMOTE_OFFLINE'), { statusCode: 502 });
    const response = await fetch(baseUrl + route, {
      method: opts.method || 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: AbortSignal.timeout(opts.timeoutMs || 15000),
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!response.ok) throw Object.assign(new Error(body && /^[A-Z0-9_]+$/.test(body.error || '') ? body.error : `REMOTE_HTTP_${response.status}`), { statusCode: response.status, peerBody: body });
    return body;
  };
  side.service = makeService(side);
  side.restart = () => { side.service.stop(); side.service = makeService(side); return side.service; };
  const app = express();
  app.use(express.json());
  const engineAuth = (req, res, next) => {
    const token = (req.get('Authorization') || '').replace(/^Bearer /, '');
    if (token !== 'not-a-link' && !side.linkByToken.has(token)) return res.status(401).json({ error: 'ENGINE_TOKEN_INVALID' });
    req.engineAuth = { tokenId: token };
    next();
  };
  app.get('/v1/info', engineAuth, (req, res) => res.json({ engine_id: side.instanceId, name, company_computer: side.company, capabilities: side.capabilities }));
  app.use('/v1/task-move', routes.createPeerRouter({ service: () => side.service, authenticate: engineAuth }));
  const page = express.Router();
  routes.addPageRoutes(page, { service: () => side.service, owner: () => 'me' });
  app.use('/api/tasks', page);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { side.service.stop(); server.closeAllConnections(); server.close(resolve); }));
  side.base = `http://127.0.0.1:${server.address().port}`;
  side.page = async (method, route, body) => {
    const response = await fetch(`${side.base}/api/tasks${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return side;
}

let serial = 0;
function link(x, y) {
  serial += 1;
  const id = `link-${serial}`;
  const tokenXY = `tae_${crypto.randomBytes(16).toString('hex')}`; // x calls y with it
  const tokenYX = `tae_${crypto.randomBytes(16).toString('hex')}`;
  x.peers.push({ id, name: y.name, online: true, remoteServerId: serial, instanceId: y.instanceId, baseUrl: y.base, token: tokenXY });
  y.peers.push({ id, name: x.name, online: true, remoteServerId: serial, instanceId: x.instanceId, baseUrl: x.base, token: tokenYX });
  y.linkByToken.set(tokenXY, { id, revoked: false, peer_instance_id: x.instanceId });
  x.linkByToken.set(tokenYX, { id, revoked: false, peer_instance_id: y.instanceId });
  return id;
}

const CLAUDE_ID = '11111111-2222-4333-8444-555555555555';
const CODEX_ID = '019a0000-1111-7222-8333-444444444444';
// A task on `side`: its folder (nested folders, a hidden file, .git, an executable, three kinds of links, a 1.5 MB file), its terminals (a Claude
// one, a Codex one, a plain one), their session files, another project's session file (never touched), a to-do, a chat, a document kept outside the
// folder and a T-Attention item of its Claude terminal.
function seedTask(side, { title = 'Notes', folder = 'notes' } = {}) {
  const dir = path.join(side.tasksBase, folder);
  fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.git', 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'main'), 'a'.repeat(40) + '\n');
  fs.writeFileSync(path.join(dir, 'DESIGN.md'), `# ${title}\n`);
  fs.writeFileSync(path.join(dir, '.hidden'), 'secret-ish\n');
  fs.writeFileSync(path.join(dir, 'src', 'deep', `${ZH}.txt`), 'nested');
  fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\necho hi\n');
  fs.chmodSync(path.join(dir, 'run.sh'), 0o755);
  fs.writeFileSync(path.join(dir, 'big.bin'), crypto.randomBytes(1536 * 1024 + 7));
  fs.symlinkSync('src/deep', path.join(dir, 'shortcut'));
  fs.symlinkSync(path.join(dir, 'DESIGN.md'), path.join(dir, 'abs-inside'));
  fs.symlinkSync('/etc/hosts', path.join(dir, 'abs-outside'));
  fs.utimesSync(path.join(dir, 'DESIGN.md'), 1_700_000_000, 1_700_000_000);
  const outside = path.join(side.root, 'notes-elsewhere');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'README.md'), '# Kept outside\n');
  const info = side.db.prepare(`INSERT INTO tasks (title, status, md_path, work_dir, user_id, readme_path, created_at) VALUES (?, 'todo', ?, ?, 'me', ?, '2026-11-01 10:00:00')`)
    .run(title, path.join(dir, 'DESIGN.md'), dir, path.join(outside, 'README.md'));
  const taskId = Number(info.lastInsertRowid);
  const insertTerminal = side.db.prepare('INSERT INTO task_terminals (task_id, terminal_id, title, agent, agent_session_id, title_custom, work_dir) VALUES (?, ?, ?, ?, ?, ?, ?)');
  insertTerminal.run(taskId, 'term-claude', 'Claude 1', 'claude', CLAUDE_ID, 0, dir);
  insertTerminal.run(taskId, 'term-codex', 'Codex 1', 'codex', CODEX_ID, 0, dir);
  insertTerminal.run(taskId, 'term-plain', ZH, null, null, 1, path.join(dir, 'src'));
  side.db.prepare("INSERT INTO task_todos (task_id, content, completed, sort_order) VALUES (?, 'write tests', 0, 1)").run(taskId);
  side.db.prepare("INSERT INTO agent_conversations (id, task_id, agent, title, mode) VALUES (?, ?, 'claude', 'Chat', 'default')").run(crypto.randomUUID(), taskId);
  // Claude Code names the project after the real path (/private/var/... on macOS).
  const real = fs.realpathSync(dir);
  const project = path.join(side.claudeDir, 'projects', claudeProjectName(real));
  fs.mkdirSync(path.join(project, CLAUDE_ID, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(project, `${CLAUDE_ID}.jsonl`), [JSON.stringify({ type: 'user', cwd: real, message: { content: `look at ${real}/src` } }), JSON.stringify({ type: 'assistant', cwd: `${real}/src` }), ''].join('\n'));
  fs.writeFileSync(path.join(project, CLAUDE_ID, 'subagents', 'agent-a1.jsonl'), JSON.stringify({ type: 'user', cwd: real }) + '\n');
  const other = path.join(side.claudeDir, 'projects', '-other-project');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'zzzzzzzz-0000-4000-8000-000000000000.jsonl'), JSON.stringify({ cwd: '/other' }) + '\n');
  const rollouts = path.join(side.codexDir, 'sessions', '2026', '11', '20');
  fs.mkdirSync(rollouts, { recursive: true });
  fs.writeFileSync(path.join(rollouts, `rollout-2026-11-20T10-00-00-${CODEX_ID}.jsonl`), [
    JSON.stringify({ type: 'session_meta', payload: { id: CODEX_ID, cwd: dir } }),
    JSON.stringify({ type: 'turn_context', payload: { cwd: dir, writable_roots: [dir] } }), ''].join('\n'));
  side.db.prepare("INSERT INTO attention_items (title, created_at, updated_at, context) VALUES ('Needs you', '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z', ?)")
    .run(JSON.stringify({ tagent: { task_id: String(taskId), terminal_id: 'term-claude' } }));
  side.order = [`${side.instanceId}:99`, `${side.instanceId}:${taskId}`, `other:1`];
  return { taskId, dir, real, project, rollout: path.join(rollouts, `rollout-2026-11-20T10-00-00-${CODEX_ID}.jsonl`), other: path.join(other, 'zzzzzzzz-0000-4000-8000-000000000000.jsonl') };
}

// What a folder holds: path -> type, SHA-256, mode and link text.
function snapshot(dir) {
  const out = {};
  const walk = (folder, rel) => {
    for (const name of fs.readdirSync(folder).sort()) {
      const full = path.join(folder, name);
      const p = rel ? `${rel}/${name}` : name;
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) { out[p] = 'd'; walk(full, p); }
      else if (stat.isSymbolicLink()) out[p] = `l:${fs.readlinkSync(full)}`;
      else out[p] = `f:${sha(fs.readFileSync(full))}:${(stat.mode & 0o777).toString(8)}`;
    }
  };
  walk(dir, '');
  return out;
}
const liveTasks = side => side.db.prepare('SELECT * FROM tasks WHERE archived_at IS NULL').all();
const heldTasks = side => side.db.prepare(`SELECT * FROM tasks WHERE archived_at LIKE '${HOLD_PREFIX}%'`).all();
const stagingLeft = side => fs.readdirSync(side.tasksBase).filter(name => name.startsWith('.t-agent-incoming-'));
async function finished(source, taskId) {
  return until(async () => {
    const { body } = await source.page('GET', `/${taskId}/move/progress`);
    return body && body.move && ['done', 'failed', 'cancelled'].includes(body.move.phase) ? body.move : null;
  }, 'the move to end');
}
// The source keeps its task exactly as it was; the target keeps nothing of it.
function assertUntouched(A, B, seed, before) {
  assert.equal(liveTasks(A).length, 1, 'the source still has its task');
  assert.deepEqual(snapshot(seed.dir), before, 'the source folder is as it was');
  assert.ok(fs.existsSync(seed.rollout) && fs.existsSync(path.join(seed.project, `${CLAUDE_ID}.jsonl`)), 'the session files are where they were');
  assert.equal(A.locked.size, 0, 'the task is unlocked');
  assert.equal(liveTasks(B).length + heldTasks(B).length, 0, 'the target has no row');
  assert.deepEqual(stagingLeft(B), [], 'no staging folder is left');
  assert.ok(!fs.existsSync(path.join(B.tasksBase, 'notes')), 'no copy of the folder is left');
  assert.ok(!fs.existsSync(path.join(B.claudeDir, 'projects')) || !fs.readdirSync(path.join(B.claudeDir, 'projects')).length, 'no session file was left on the target');
}

test('a move: folder, links, modes, .git, a large file in chunks, sessions, rows, documents, order, moved record and T-Attention follow; the source keeps it 7 days in the trash', async t => {
  const A = await makeEngine(t, 'T01');
  const B = await makeEngine(t, 'K01');
  link(A, B);
  const seed = seedTask(A);
  const before = snapshot(seed.dir);
  A.live.set(seed.taskId, ['term-claude']);
  const preview = await A.page('GET', `/${seed.taskId}/move`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.refusal, null);
  assert.equal(preview.body.terminals.running, 1);
  assert.equal(preview.body.folder.files, 7);
  assert.deepEqual({ claude: preview.body.sessions.claude, codex: preview.body.sessions.codex }, { claude: 1, codex: 1 });
  assert.deepEqual(preview.body.targets.map(target => [target.name, target.supported, target.refusal]), [['K01', true, null]]);
  const started = await A.page('POST', `/${seed.taskId}/move`, { target: B.instanceId });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const again = await A.page('POST', `/${seed.taskId}/move`, { target: B.instanceId });
  assert.equal(again.body.error, 'MOVE_IN_PROGRESS', 'one move at a time per task');
  const move = await finished(A, seed.taskId);
  assert.equal(move.phase, 'done', JSON.stringify(move));
  assert.deepEqual(A.closed, [seed.taskId], 'running terminals were closed first');

  // The target: one live task, its folder byte for byte (the absolute link into the folder points into the new one).
  const [task] = liveTasks(B);
  assert.ok(task, 'the target has the task');
  assert.equal(task.title, 'Notes');
  assert.equal(task.status, 'todo');
  const newDir = path.join(B.tasksBase, 'notes');
  assert.equal(task.work_dir, newDir);
  assert.equal(move.new_task_id, task.id);
  const after = snapshot(newDir);
  const expected = { ...before, 'abs-inside': `l:${path.join(newDir, 'DESIGN.md')}`, 'README.md': after['README.md'] };
  assert.deepEqual(after, expected);
  assert.match(after['run.sh'], /:755$/);
  assert.equal(Math.round(fs.statSync(path.join(newDir, 'DESIGN.md')).mtimeMs), 1_700_000_000_000, 'times are kept');
  assert.equal(fs.readFileSync(path.join(newDir, 'README.md'), 'utf8'), '# Kept outside\n', 'a document kept outside the folder is copied into it');
  assert.equal(task.readme_path, path.join(newDir, 'README.md'));
  assert.equal(task.md_path, path.join(newDir, 'DESIGN.md'));
  // Rows: terminals (their folders moved), to-do, chat.
  const terminals = B.db.prepare('SELECT * FROM task_terminals WHERE task_id = ? ORDER BY rowid').all(task.id);
  assert.deepEqual(terminals.map(row => [row.terminal_id, row.agent_session_id, row.work_dir]), [
    ['term-claude', CLAUDE_ID, newDir], ['term-codex', CODEX_ID, newDir], ['term-plain', null, path.join(newDir, 'src')],
  ]);
  assert.equal(terminals[2].title, ZH);
  assert.equal(B.db.prepare('SELECT COUNT(*) AS n FROM task_todos WHERE task_id = ?').get(task.id).n, 1);
  assert.equal(B.db.prepare('SELECT COUNT(*) AS n FROM agent_conversations WHERE task_id = ?').get(task.id).n, 1);
  // Sessions: in the project folder of the new path, their cwd rewritten (message text kept); Codex at the same place under its home.
  const newReal = fs.realpathSync(newDir);
  const claudeFile = path.join(B.claudeDir, 'projects', claudeProjectName(newReal), `${CLAUDE_ID}.jsonl`);
  const rows = fs.readFileSync(claudeFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows[0].cwd, newReal);
  assert.equal(rows[1].cwd, `${newReal}/src`);
  assert.equal(rows[0].message.content, `look at ${seed.real}/src`, 'the conversation text is not changed');
  assert.ok(fs.existsSync(path.join(B.claudeDir, 'projects', claudeProjectName(newReal), CLAUDE_ID, 'subagents', 'agent-a1.jsonl')));
  const codexRows = fs.readFileSync(path.join(B.codexDir, path.relative(A.codexDir, seed.rollout)), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(codexRows[0].payload.cwd, newDir);
  assert.deepEqual(codexRows[1].payload.writable_roots, [newDir]);
  assert.ok(!fs.existsSync(path.join(B.claudeDir, 'projects', '-other-project')), 'another project is not carried');

  // The source: no row, the folder and the session files in the trash, the other project untouched; the moved record, the order, T-Attention.
  assert.equal(A.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
  assert.equal(A.db.prepare('SELECT COUNT(*) AS n FROM task_terminals').get().n, 0);
  assert.ok(!fs.existsSync(seed.dir));
  const [trashName] = fs.readdirSync(path.join(A.dataDir, 'trash'));
  assert.match(trashName, new RegExp(`^moved-${seed.taskId}-\\d+$`));
  assert.deepEqual(snapshot(path.join(A.dataDir, 'trash', trashName, 'folder')), before);
  assert.equal(fs.readdirSync(path.join(A.dataDir, 'trash', trashName, 'sessions')).length, 3);
  assert.ok(!fs.existsSync(seed.rollout) && !fs.existsSync(path.join(seed.project, `${CLAUDE_ID}.jsonl`)));
  assert.ok(fs.existsSync(seed.other), 'another project\'s session file is never touched');
  assert.ok(fs.existsSync(path.join(seed.dir, '..', '..', 'notes-elsewhere', 'README.md')), 'the document kept outside stays on the source');
  assert.deepEqual(A.moves, [{ from: { instance: A.instanceId, task: String(seed.taskId) }, to: { instance: B.instanceId, task: String(task.id) }, title: 'Notes' }]);
  assert.deepEqual(A.order, [`${A.instanceId}:99`, `${B.instanceId}:${task.id}`, 'other:1'], 'the task keeps its place in the shared order');
  const item = JSON.parse(A.db.prepare('SELECT context FROM attention_items').get().context);
  assert.deepEqual(item.tagent, { task_id: String(seed.taskId), terminal_id: 'term-claude', moved_to: { instance: B.instanceId, task_id: String(task.id), terminal_id: 'term-claude' } });
  assert.equal(A.locked.size, 0);
  assert.deepEqual(stagingLeft(B), []);
  // The trash is swept after 7 days (fake clock).
  assert.deepEqual(A.service.sweep(Date.now() + 6 * 24 * 3600 * 1000), []);
  assert.deepEqual(A.service.sweep(Date.now() + 7 * 24 * 3600 * 1000 + 60_000), [trashName]);
});

test('between tiers the tick is required, on the source and again on the target; refusals: too large, no space for it, a shared folder, a worktree, a hidden task, a non-link token', async t => {
  const A = await makeEngine(t, 'T01');
  const B = await makeEngine(t, 'K01', { company: true });
  link(A, B);
  const seed = seedTask(A);
  const preview = await A.page('GET', `/${seed.taskId}/move`);
  assert.equal(preview.body.targets[0].company_computer, true, 'the dialog knows to ask');
  const refused = await A.page('POST', `/${seed.taskId}/move`, { target: B.instanceId });
  assert.deepEqual([refused.status, refused.body.error], [409, 'MOVE_TIER_CONFIRMATION_REQUIRED']);
  // The target checks it itself: an offer without the tick from a normal machine is refused.
  const [tokenAB] = [...B.linkByToken.keys()];
  const offer = await fetch(`${B.base}/v1/task-move/offer`, { method: 'POST', headers: { Authorization: `Bearer ${tokenAB}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ move_id: crypto.randomUUID(), root_name: 'notes', totals: { files: 0, bytes: 0 }, source: { instance_id: A.instanceId } }) });
  assert.equal((await offer.json()).error, 'MOVE_TIER_CONFIRMATION_REQUIRED');
  // Too large for the source's limit, then for the target's.
  A.limit = 1024;
  assert.equal((await A.page('POST', `/${seed.taskId}/move`, { target: B.instanceId, tier_ack: true })).body.error, 'MOVE_TOO_LARGE');
  assert.equal((await A.page('GET', `/${seed.taskId}/move`)).body.refusal.error, 'MOVE_TOO_LARGE', 'the dialog says so before Move');
  A.limit = 64 * 1024 * 1024;
  B.limit = 1024;
  assert.equal((await A.page('GET', `/${seed.taskId}/move`)).body.targets[0].refusal.error, 'MOVE_TOO_LARGE');
  assert.equal((await A.page('POST', `/${seed.taskId}/move`, { target: B.instanceId, tier_ack: true })).body.error, 'MOVE_TOO_LARGE');
  B.limit = 64 * 1024 * 1024;
  // A hidden task cannot be pulled by the link that may not see it.
  A.denied.set(seed.taskId, new Set([A.peers[0].id]));
  assert.equal((await A.page('POST', `/${seed.taskId}/move`, { target: B.instanceId, tier_ack: true })).body.error, 'MOVE_TASK_HIDDEN');
  A.denied.clear();
  // A folder another task uses too stays (the delete rules): refused with the reason.
  const shared = A.db.prepare("INSERT INTO tasks (title, status, work_dir, user_id) VALUES ('Other', 'todo', ?, 'me')").run(seed.dir).lastInsertRowid;
  const sharedPreview = await A.page('GET', `/${seed.taskId}/move`);
  assert.deepEqual([sharedPreview.body.refusal.error, sharedPreview.body.refusal.reason], ['MOVE_FOLDER_NOT_MOVABLE', 'Other tasks also use this directory']);
  A.db.prepare('DELETE FROM tasks WHERE id = ?').run(shared);
  // An unknown target.
  assert.equal((await A.page('POST', `/${seed.taskId}/move`, { target: crypto.randomUUID(), tier_ack: true })).body.error, 'MOVE_TARGET_UNKNOWN');
  // A folder that is a Git worktree: moving it would break its link to the repository.
  fs.rmSync(path.join(seed.dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(seed.dir, '.git'), 'gitdir: /somewhere/.git/worktrees/notes\n');
  assert.equal((await A.page('POST', `/${seed.taskId}/move`, { target: B.instanceId, tier_ack: true })).body.error, 'MOVE_FOLDER_NOT_MOVABLE');
  fs.rmSync(path.join(seed.dir, '.git'));
  // An offline target, and the peer routes for a token that is not a link's.
  const forbidden = await fetch(`${B.base}/v1/task-move/capacity`, { headers: { Authorization: 'Bearer not-a-link' } });
  assert.deepEqual([forbidden.status, (await forbidden.json()).error], [403, 'LINKED_ONLY']);
  B.peers[0].online = false;
  A.peers[0].online = false;
  assert.equal((await A.page('POST', `/${seed.taskId}/move`, { target: B.instanceId, tier_ack: true })).body.error, 'MOVE_TARGET_OFFLINE');
  assert.equal(liveTasks(A).length, 1, 'nothing moved');
});

test('with the tick, a move to a company computer goes through', async t => {
  const A = await makeEngine(t, 'T01');
  const B = await makeEngine(t, 'K01', { company: true });
  link(A, B);
  const seed = seedTask(A);
  assert.equal((await A.page('POST', `/${seed.taskId}/move`, { target: B.instanceId, tier_ack: true })).status, 202);
  assert.equal((await finished(A, seed.taskId)).phase, 'done');
  assert.equal(liveTasks(B).length, 1);
});

test('a chunk that fails is asked again from where it stopped (the hash goes back to the last whole chunk)', async t => {
  const A = await makeEngine(t, 'T01');
  const B = await makeEngine(t, 'K01');
  link(A, B);
  const seed = seedTask(A);
  let failed = 0;
  B.at = (point, record) => { if (point === 'target:chunk' && record.offset > 0 && failed < 2) { failed += 1; throw Object.assign(new Error('REMOTE_TIMEOUT'), { statusCode: 504 }); } };
  await A.page('POST', `/${seed.taskId}/move`, { target: B.instanceId });
  assert.equal((await finished(A, seed.taskId)).phase, 'done');
  assert.equal(failed, 2);
  assert.equal(sha(fs.readFileSync(path.join(B.tasksBase, 'notes', 'big.bin'))), sha(fs.readFileSync(path.join(A.dataDir, 'trash', fs.readdirSync(path.join(A.dataDir, 'trash'))[0], 'folder', 'big.bin'))));
});

// A failure at each step before the source's commit: the source keeps its task and folder, the target keeps nothing.
for (const [side, point] of [
  ['A', 'source:start'], ['A', 'source:scanned'], ['A', 'source:offering'],
  ['B', 'target:start'], ['B', 'target:chunk'], ['B', 'target:pulled'], ['B', 'target:verified'], ['B', 'target:before-place'], ['B', 'target:placed'],
  ['B', 'target:created'], ['B', 'target:extras'],
]) {
  test(`a failure at ${point} changes nothing`, async t => {
    const engines = { A: await makeEngine(t, 'T01'), B: await makeEngine(t, 'K01') };
    const { A, B } = engines;
    link(A, B);
    const seed = seedTask(A);
    const before = snapshot(seed.dir);
    engines[side].at = name => { if (name === point) throw Object.assign(new Error('DISK_FULL'), { statusCode: 507 }); };
    await A.page('POST', `/${seed.taskId}/move`, { target: B.instanceId });
    const move = await finished(A, seed.taskId);
    assert.equal(move.phase, 'failed');
    await until(() => !B.service.journal.all().some(record => ['pulling', 'placed', 'created'].includes(record.state)), 'the target to clean up');
    assertUntouched(A, B, seed, before);
  });
}

test('a changed source file, a corrupted copy and a cancel before verification each end the move with nothing changed', async t => {
  for (const kind of ['changed', 'corrupted', 'cancelled']) {
    const A = await makeEngine(t, `T01${kind}`);
    const B = await makeEngine(t, `K01${kind}`);
    link(A, B);
    const seed = seedTask(A);
    let before = snapshot(seed.dir);
    let done = false;
    if (kind === 'changed') A.at = point => { if (point === 'source:offered' && !done) { done = true; fs.appendFileSync(path.join(seed.dir, 'big.bin'), 'x'); before = snapshot(seed.dir); } };
    if (kind === 'corrupted') B.at = (point, record) => { if (point === 'target:pulled') fs.writeFileSync(path.join(record.staging, 'folder', 'run.sh'), '#!/bin/sh\necho evil\n'); };
    if (kind === 'cancelled') {
      B.at = (point, record) => {
        if (point === 'target:chunk' && !done) {
          done = true;
          return A.page('POST', `/${seed.taskId}/move/cancel`).then(answer => { assert.equal(answer.body.move.phase, 'cancelled'); });
        }
        return undefined;
      };
    }
    await A.page('POST', `/${seed.taskId}/move`, { target: B.instanceId });
    const move = await finished(A, seed.taskId);
    assert.equal(move.phase, kind === 'cancelled' ? 'cancelled' : 'failed', kind);
    if (kind === 'corrupted') assert.equal(move.error, 'MOVE_VERIFY_FAILED');
    if (kind === 'changed') assert.equal(move.error, 'MOVE_FILE_CHANGED');
    await until(() => !B.service.journal.all().some(record => ['pulling', 'placed', 'created'].includes(record.state)), `the target to clean up (${kind})`);
    assertUntouched(A, B, seed, before);
  }
});

test('after the verification the move cannot be cancelled any more', async t => {
  const A = await makeEngine(t, 'T01');
  const B = await makeEngine(t, 'K01');
  link(A, B);
  const seed = seedTask(A);
  let answer = null;
  B.at = async point => { if (point === 'target:placed' && !answer) answer = await A.page('POST', `/${seed.taskId}/move/cancel`); };
  await A.page('POST', `/${seed.taskId}/move`, { target: B.instanceId });
  await until(() => answer, 'the cancel answer');
  assert.equal(answer.body.error, 'MOVE_FINISHING');
});

// A crash at each step, then a start (recovery) of the engine that crashed: the task ends on exactly one engine, live, with its folder.
const CRASHES = [
  // [engine that crashes, point, where the task ends]
  ['A', 'source:scanned', 'A'], ['A', 'source:offered', 'A'], ['A', 'source:before-commit', 'A'],
  ['A', 'source:trash', 'B'], ['A', 'source:folder-trashed', 'B'], ['A', 'source:sessions-trashed', 'B'], ['A', 'source:rows-removed', 'B'], ['A', 'source:repointed', 'B'],
  ['B', 'target:pulled', 'A'], ['B', 'target:verified', 'A'], ['B', 'target:placed', 'B'], ['B', 'target:created', 'B'], ['B', 'target:extras', 'B'],
  ['B', 'target:before-commit', 'B'], ['B', 'target:committed', 'B'],
];
for (const [who, point, ends] of CRASHES) {
  test(`a crash of ${who === 'A' ? 'the source' : 'the target'} at ${point} is recovered at start: the task ends on ${ends === 'A' ? 'the source' : 'the target'} only`, async t => {
    const engines = { A: await makeEngine(t, 'T01'), B: await makeEngine(t, 'K01') };
    const { A, B } = engines;
    link(A, B);
    const seed = seedTask(A);
    const before = snapshot(seed.dir);
    let crashed = false;
    engines[who].at = name => { if (name === point && !crashed) { crashed = true; throw crash(); } };
    await A.page('POST', `/${seed.taskId}/move`, { target: B.instanceId });
    await until(() => crashed, `the crash at ${point}`);
    await settle(150);
    // The engine that crashed starts again: a new service on the same database and data folder.
    engines[who].at = null;
    const restarted = engines[who].restart();
    await restarted.recover();
    // The other engine notices on its own next round (its retry timer or its next start): run that round now.
    const other = engines[who === 'A' ? 'B' : 'A'];
    await settle(150);
    await other.service.recover();
    await until(() => ![...A.service.journal.all(), ...B.service.journal.all()].some(record => ['pulling', 'placed', 'created', 'preparing', 'offered', 'committed'].includes(record.state)), 'every journal to settle');
    const onA = liveTasks(A).length;
    const onB = liveTasks(B).length;
    assert.equal(onA + onB, 1, `live on exactly one engine (A ${onA}, B ${onB})`);
    assert.equal(heldTasks(B).length, 0, 'nothing held');
    if (ends === 'A') assertUntouched(A, B, seed, before);
    else {
      assert.equal(onB, 1);
      assert.equal(A.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
      const newDir = liveTasks(B)[0].work_dir;
      const after = snapshot(newDir);
      assert.deepEqual(after, { ...before, 'abs-inside': after['abs-inside'], 'README.md': after['README.md'] });
      assert.ok(!fs.existsSync(seed.dir), 'the source folder went to the trash');
      assert.deepEqual(stagingLeft(B), []);
    }
    assert.equal(A.locked.size, 0, 'nothing stays locked');
  });
}
