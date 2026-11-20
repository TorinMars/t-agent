// Moving a task to another engine ("Move to another machine…" in the task menu). See docs/design/task-move.md for the whole design; in short:
//
// - The SOURCE (the engine that has the task) checks the move, closes the task's terminals, scans and hashes its folder (lib/task-move-files.js),
//   finds the Claude Code / Codex session files of its terminals and chats, and offers the move to the TARGET over the service link.
// - The TARGET pulls the manifest and every file from the source (`/v1/task-move/...`, link tokens only, through the tunnel when the link has one),
//   in chunks with Range, into a staging folder in its tasks folder; verifies every size and SHA-256 again from its disk; then puts the folder in
//   place and creates the task rows HELD (archived_at = 'moving:<move id>', so the task is inert and listed nowhere) and asks the source to commit.
// - The source's commit is the one point of no return: it is written to its journal, then the source moves the folder to
//   `<data folder>/trash/moved-<task>-<time>/` (kept 7 days, `sweepTrash`), removes the task rows, re-points the shared task order, writes the
//   "moved" record of the shared page state (services/page-state.js) and re-points its T-Attention items. The target then releases its hold.
// - Every step is journaled on both sides (`<data folder>/task-moves/<move id>.json`); a start after a crash finishes or undoes each move
//   (`recover`): before the source's commit everything is undone (the source keeps its task, the target removes its copy); after it, both finish.
//   So the task is never live on both engines and never lost.
//
// Everything outside (the database, the links, the terminals, the clock) is passed in, so two engines run in one test process over real HTTP.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const files = require('../lib/task-move-files');
const { claudeProjectName, SESSION_ID } = require('../lib/agent-sessions');
const { rewriteCwd, CODEX_ROOT_KEYS } = require('../lib/agent-session-move');

const CAPABILITY = 'tasks:move';
const HOLD_PREFIX = 'moving:';
const LIMIT_DEFAULT = 2 * 1024 * 1024 * 1024;
const CHUNK_BYTES = 8 * 1024 * 1024;
const CONCURRENCY = 4;
const RETRIES = 3;
const SETTLE_MS = 1500; // the agents of closed terminals write their last lines
const IDLE_MS = 3 * 60 * 1000; // a source gives up a move the target has not touched for this long
const RETRY_MS = 30 * 1000; // a held target task asks its source again
const KEEP_RECORDS_MS = 30 * 24 * 60 * 60 * 1000;
const SPACE_MARGIN = 64 * 1024 * 1024;
const MANIFEST_MAX = 128 * 1024 * 1024;
const PROGRESS_GAP_MS = 400;
const SWEEP_MS = 6 * 60 * 60 * 1000;
const DOC_KINDS = { technical: 'technical_path', readme: 'readme_path', agent: 'agent_path' };
const ACTIVE = new Set(['preparing', 'offered']);
const TARGET_OPEN = new Set(['pulling', 'placed', 'created']);

const fault = (code, statusCode = 409, extra = {}) => Object.assign(new Error(code), { statusCode, ...extra });
const codeOf = error => (error && /^[A-Z0-9_]{1,64}$/.test(error.message || '') ? error.message : 'MOVE_FAILED');
const reasonOf = error => (error && typeof error.reason === 'string' ? error.reason.slice(0, 500) : (error && !/^[A-Z0-9_]+$/.test(error.message || '') ? String(error.message || '').slice(0, 500) : null));
const inside = (value, dir) => typeof value === 'string' && typeof dir === 'string' && (value === dir || value.startsWith(dir + path.sep));
const realOr = target => { try { return fs.realpathSync(target); } catch { return null; } };
const wait = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); if (timer.unref) timer.unref(); });
const columnsOf = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
const relOf = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

// A path of the old folder (as stored or its real path) in the new folder; any other value as it is.
function swapPath(value, fromDirs, to) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return value;
  const resolved = path.resolve(value);
  for (const from of fromDirs.filter(Boolean)) if (inside(resolved, from)) return to + resolved.slice(from.length);
  return value;
}

// A GET from a peer as a stream (the body is not read here): over the tunnel for a link that has one, like services/remote-stream.js.
function openStreamDefault(baseUrl, route, token, { headers = {}, timeoutMs = 60_000, signal = null } = {}) {
  const target = new URL(route, `${baseUrl}/`);
  const { TUNNEL_PROTOCOL, getHub } = require('../lib/service-link-tunnel');
  const client = target.protocol === TUNNEL_PROTOCOL ? getHub() : target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(target, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: '*/*', ...headers }, timeout: timeoutMs }, res => {
      if (res.statusCode >= 200 && res.statusCode < 300) { resolve(res); return; }
      const chunks = [];
      res.on('data', chunk => { if (chunks.length < 16) chunks.push(chunk); });
      res.on('end', () => {
        let code = `REMOTE_HTTP_${res.statusCode}`;
        try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (/^[A-Z0-9_]+$/.test(body.error || '')) code = body.error; } catch { /* not JSON */ }
        reject(fault(code, res.statusCode));
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('REMOTE_TIMEOUT')));
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) req.destroy(fault('MOVE_CANCELLED'));
      else signal.addEventListener('abort', () => req.destroy(fault('MOVE_CANCELLED')), { once: true });
    }
    req.end();
  });
}

function createTaskMove(options) {
  const {
    db, dataDir,
    identity, // () => { instance_id, name }
    owner = () => require('./single-user').ensureSingleUser().login,
    tasksBase, // () => the folder new task folders go in
    agentDirs = () => require('./task-rename').defaultAgentDirs(), // () => { claude: [...], codex: [...] }
    serviceLinks, // { peers(), linkForToken(tokenId), onChange? }
    request, // JSON requests to a peer (services/remote-client.js `request`)
    openStream = openStreamDefault,
    isCompany = () => false,
    limitBytes = () => LIMIT_DEFAULT,
    maxFiles = files.MAX_FILES_DEFAULT,
    terminals = { live: () => [], busy: () => 0, close: () => {} },
    chat = { busy: () => false, stop: () => {} },
    folderGuard = () => null, // (task) => why the folder may not leave this engine, or null (the delete rules of workspace-tools)
    worktreeReason = () => null, // (dir) => why moving it would break a Git link, or null (services/task-rename.js)
    visibility = { isDenied: () => false, deniedLinks: () => [], setDenied: () => {}, forgetTask: () => {} },
    taskOrder = { replace: () => {} }, // (owner, oldKey, newKey)
    pageState = { recordMove: () => {} }, // (owner, { from, to, title })
    attention = null, // { repoint(fromTaskId, to) }: this engine's T-Attention items that name the task
    forgetTask = () => {}, // (taskId): the in-memory state of a removed task (terminal order, visibility)
    lock = { add: () => {}, delete: () => {} }, // the tasks routes/terminal.js refuses terminals for (TASK_MOVING)
    now = Date.now, log = console,
    settleMs = SETTLE_MS, chunkBytes = CHUNK_BYTES, concurrency = CONCURRENCY, idleMs = IDLE_MS, retryMs = RETRY_MS,
    hooks = {}, // tests: `at(point, record)` may throw; an error with `crash: true` stops as a crash would (no clean-up)
  } = options;

  const journal = files.createJournal(path.join(dataDir, 'task-moves'));
  const trashDir = path.join(dataDir, 'trash');
  const live = new Map(); // move id -> { controller, progress, lastSeen, blobs (source: private absolute paths) }
  const me = () => identity().instance_id;
  const at = (point, record) => { if (hooks.at) hooks.at(point, record); };
  const isCrash = error => Boolean(error && error.crash);

  function liveOf(id) {
    if (!live.has(id)) live.set(id, { controller: new AbortController(), progress: {}, lastSeen: now(), blobs: null });
    return live.get(id);
  }
  function setProgress(id, change) {
    const entry = liveOf(id);
    entry.progress = { ...entry.progress, ...change };
  }

  // ---- Peers ----
  const peers = () => { try { return serviceLinks.peers(); } catch { return []; } };
  const peerByInstance = instanceId => peers().find(peer => peer.instanceId && peer.instanceId === instanceId) || null;
  const peerByLink = linkId => peers().find(peer => peer.id === linkId) || null;
  function call(peer, route, opts = {}) {
    if (!peer) return Promise.reject(fault('MOVE_PEER_GONE', 502));
    return request(peer.baseUrl, route, peer.token, { timeoutMs: 15_000, ...opts });
  }
  // The link of a request from a peer: a live link's token only.
  function linkOfToken(tokenId) {
    const link = serviceLinks.linkForToken(tokenId);
    if (!link || link.revoked) throw fault('LINKED_ONLY', 403);
    return link;
  }

  // ---- Tasks of this engine ----
  const ownedTask = (login, id) => db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, login);
  const isHeld = task => typeof task.archived_at === 'string' && task.archived_at.startsWith(HOLD_PREFIX);

  // Why this task's folder cannot move, or null: { error, reason }.
  function folderProblem(task) {
    if (!task.work_dir) return { error: 'MOVE_FOLDER_NOT_MOVABLE', reason: 'The task has no working directory' };
    const dir = path.resolve(task.work_dir);
    let stat;
    try { stat = fs.lstatSync(dir); } catch { return { error: 'MOVE_FOLDER_MISSING', reason: 'The working directory does not exist' }; }
    if (stat.isSymbolicLink()) return { error: 'MOVE_FOLDER_NOT_MOVABLE', reason: 'The working directory is a symbolic link' };
    if (!stat.isDirectory()) return { error: 'MOVE_FOLDER_NOT_MOVABLE', reason: 'The working directory is not a folder' };
    const guard = folderGuard(task);
    if (guard) return { error: 'MOVE_FOLDER_NOT_MOVABLE', reason: String(guard).replace(/; it cannot be deleted$/, '') };
    const worktree = worktreeReason(dir);
    if (worktree) return { error: 'MOVE_FOLDER_NOT_MOVABLE', reason: String(worktree).replace(/renaming/g, 'moving') };
    return null;
  }

  // The session files of the task's terminals and chats: { items: [{ area: 'session', agent, id, p, t: 'f', s, m, mt }], abs: [...], carried, missing }.
  // Only sessions started in the task's folder (or a folder inside it): their path is rewritten on the target. Nothing of another project is read.
  function findSessions(task, folderDirs) {
    const wanted = new Map();
    const terminalColumns = columnsOf(db, 'task_terminals');
    if (terminalColumns.has('agent') && terminalColumns.has('agent_session_id')) {
      const rows = db.prepare(`SELECT agent, agent_session_id AS id, ${terminalColumns.has('work_dir') ? 'work_dir' : 'NULL AS work_dir'} FROM task_terminals
        WHERE task_id = ? AND agent IN ('claude', 'codex') AND agent_session_id IS NOT NULL`).all(task.id);
      for (const row of rows) wanted.set(`${row.agent}:${row.id}`, { agent: row.agent, id: String(row.id), dir: row.work_dir || task.work_dir });
    }
    for (const row of db.prepare("SELECT agent, session_id AS id FROM agent_conversations WHERE task_id = ? AND session_id IS NOT NULL AND agent IN ('claude', 'codex')").all(task.id)) {
      if (!wanted.has(`${row.agent}:${row.id}`)) wanted.set(`${row.agent}:${row.id}`, { agent: row.agent, id: String(row.id), dir: task.work_dir });
    }
    const dirs = agentDirs();
    const items = [];
    const abs = [];
    const carried = [];
    const missing = [];
    const add = (agent, id, root, file, stat) => {
      items.push({ area: 'session', agent, id, p: relOf(root, file), t: 'f', s: stat.size, m: stat.mode & 0o7777, mt: Math.round(stat.mtimeMs) });
      abs.push(file);
    };
    let codexIndex = null;
    const codexFiles = () => {
      if (codexIndex) return codexIndex;
      codexIndex = new Map();
      for (const root of dirs.codex || []) {
        for (const sub of ['sessions', 'archived_sessions']) {
          const walk = (dir, depth) => {
            let entries = [];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
              const full = path.join(dir, entry.name);
              if (entry.isDirectory() && depth > 0) walk(full, depth - 1);
              else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
                const match = /-([A-Za-z0-9_-]{8,80})\.jsonl$/.exec(entry.name);
                const id = match && /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(match[1]);
                const key = id ? id[0] : null;
                if (key && !codexIndex.has(key)) codexIndex.set(key, { root, file: full });
              }
            }
          };
          walk(path.join(root, sub), 3);
        }
      }
      return codexIndex;
    };
    for (const { agent, id, dir } of wanted.values()) {
      if (!SESSION_ID.test(id)) { missing.push({ agent, id, why: 'not a session id' }); continue; }
      const resolved = dir ? path.resolve(dir) : null;
      if (!resolved || !folderDirs.some(folder => inside(resolved, folder) || inside(realOr(resolved) || '', folder))) {
        missing.push({ agent, id, why: 'started outside the folder' });
        continue;
      }
      let found = false;
      if (agent === 'claude') {
        const names = [...new Set([claudeProjectName(resolved), realOr(resolved) && claudeProjectName(realOr(resolved))].filter(Boolean))];
        for (const root of dirs.claude || []) {
          for (const name of names) {
            const file = path.join(root, 'projects', name, `${id}.jsonl`);
            let stat;
            try { stat = fs.lstatSync(file); } catch { continue; }
            if (!stat.isFile()) continue;
            add(agent, id, root, file, stat);
            // Its sub-agents and tool results: <id>/..., plain files only, never through a link.
            const walk = (folder, depth) => {
              let entries = [];
              try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
              for (const entry of entries) {
                const full = path.join(folder, entry.name);
                if (entry.isDirectory() && depth > 0) walk(full, depth - 1);
                else if (entry.isFile()) { try { add(agent, id, root, full, fs.lstatSync(full)); } catch { /* gone */ } }
              }
            };
            walk(path.join(root, 'projects', name, id), 4);
            found = true;
            break;
          }
          if (found) break;
        }
      } else {
        const hit = codexFiles().get(id);
        if (hit) {
          let cwd = null;
          try {
            const fd = fs.openSync(hit.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
            try {
              const buffer = Buffer.alloc(256 * 1024);
              const first = buffer.toString('utf8', 0, fs.readSync(fd, buffer, 0, buffer.length, 0)).split('\n')[0];
              const meta = JSON.parse(first);
              cwd = meta && meta.payload && meta.payload.cwd;
            } finally { fs.closeSync(fd); }
          } catch { cwd = null; }
          if (cwd && folderDirs.some(folder => inside(path.resolve(cwd), folder))) {
            add(agent, id, hit.root, hit.file, fs.lstatSync(hit.file));
            found = true;
          } else if (cwd) { missing.push({ agent, id, why: 'started outside the folder' }); continue; }
        }
      }
      if (found) carried.push({ agent, id });
      else missing.push({ agent, id, why: 'no session file' });
    }
    return { items, abs, carried, missing };
  }

  // The task's documents kept outside its folder (a technical, readme or agent document at another path): copied, the originals stay.
  function findDocuments(task, folderDirs) {
    const documents = require('./task-documents');
    const items = [];
    const abs = [];
    for (const kind of Object.keys(DOC_KINDS)) {
      const file = documents.documentPath(task, kind);
      if (!file || folderDirs.some(dir => inside(path.resolve(file), dir))) continue;
      let stat;
      try { stat = fs.lstatSync(file); } catch { continue; }
      if (!stat.isFile()) continue;
      items.push({ area: 'document', kind, p: path.basename(file), t: 'f', s: stat.size, m: stat.mode & 0o7777, mt: Math.round(stat.mtimeMs) });
      abs.push(file);
    }
    return { items, abs };
  }

  // The rows the target needs to make the task again (no ids of this engine except terminal and chat ids, which are random).
  function payloadOf(task, folderDirs) {
    const terminalColumns = columnsOf(db, 'task_terminals');
    const pick = ['terminal_id', 'title', 'agent', 'agent_session_id', 'agent_started_at', 'title_custom', 'work_dir'].filter(name => terminalColumns.has(name));
    const terminalsRows = db.prepare(`SELECT ${pick.join(', ')} FROM task_terminals WHERE task_id = ? ORDER BY rowid`).all(task.id);
    const chatColumns = columnsOf(db, 'agent_conversations');
    const chatPick = ['id', 'agent', 'session_id', 'title', 'mode', 'model', 'effort', 'translate', 'collapse_keyboard', 'queue', 'created_at', 'updated_at'].filter(name => chatColumns.has(name));
    const group = db.prepare('SELECT group_key, name FROM task_groups WHERE owner_id = ? AND group_key = ?').get(task.user_id, task.status) || null;
    let order = [];
    try {
      const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(`terminal_order_v1:${Number(task.id)}`);
      const parsed = row ? JSON.parse(row.value) : [];
      order = Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [];
    } catch { order = []; }
    const instances = new Map(peers().map(peer => [peer.id, peer.instanceId]));
    let denied = [];
    try { denied = visibility.deniedLinks(task.id) || []; } catch { denied = []; }
    return {
      task: {
        title: task.title, status: task.status, group: group ? { key: group.group_key, name: group.name } : null, priority: task.priority, due_date: task.due_date,
        created_at: task.created_at, work_dir: task.work_dir, md_path: task.md_path, technical_path: task.technical_path, readme_path: task.readme_path, agent_path: task.agent_path,
      },
      terminals: terminalsRows,
      default_terminal: {
        title: (db.prepare('SELECT title FROM task_default_terminal_titles WHERE task_id = ?').get(task.id) || {}).title || null,
        removed: Boolean(db.prepare('SELECT 1 FROM task_default_terminal_removed WHERE task_id = ?').get(task.id)),
        work_dir: (db.prepare('SELECT work_dir FROM task_default_terminal_dirs WHERE task_id = ?').get(task.id) || {}).work_dir || null,
      },
      terminal_order: order,
      todos: db.prepare('SELECT content, completed, sort_order, created_at, updated_at FROM task_todos WHERE task_id = ? ORDER BY sort_order, id').all(task.id),
      chats: db.prepare(`SELECT ${chatPick.join(', ')} FROM agent_conversations WHERE task_id = ?`).all(task.id),
      repo_cleanups: db.prepare('SELECT path, remote, branch, commit_sha, size_bytes, cleaned_at FROM repo_cleanups WHERE task_id = ?').all(task.id),
      // Per-task visibility, by the instance of the machine each denied link leads to: the target denies its own link to the same machine.
      hidden_from: denied.map(linkId => instances.get(linkId)).filter(Boolean),
      old_dirs: folderDirs,
    };
  }

  // ---- Progress, as the page reads it ----
  function view(record) {
    if (!record) return null;
    const entry = live.get(record.id);
    const progress = entry ? entry.progress : {};
    const phase = record.state === 'done' ? 'done' : record.state === 'aborted' ? (record.cancelled ? 'cancelled' : 'failed')
      : record.state === 'committed' ? 'finishing' : (progress.phase || (record.state === 'offered' ? 'copying' : 'closing'));
    return {
      id: record.id, task_id: record.task_id, title: record.title, phase,
      target: record.target ? { instance_id: record.target.instance_id, name: record.target.name } : null,
      files_total: progress.files_total ?? record.files_total ?? null, files_done: progress.files_done ?? (phase === 'done' ? record.files_total ?? null : 0),
      bytes_total: progress.bytes_total ?? record.bytes_total ?? null, bytes_done: progress.bytes_done ?? 0,
      cancellable: ACTIVE.has(record.state) && !['creating'].includes(progress.phase),
      error: record.error || null, reason: record.reason || null, new_task_id: record.new_task_id || null,
      sessions: record.sessions || null, folder_on_target: record.folder_on_target || null,
      started_at: record.started_at, finished_at: record.finished_at || null,
    };
  }
  // The newest move of this engine's task (also after it left: the page reads how it ended).
  function latestFor(taskId) {
    const rows = journal.all().filter(record => record.role === 'source' && String(record.task_id) === String(taskId));
    rows.sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
    return rows[0] || null;
  }
  const activeFor = taskId => {
    const record = latestFor(taskId);
    return record && (ACTIVE.has(record.state) || record.state === 'committed') ? record : null;
  };

  // ---- Source: preview ----
  async function preview(login, taskId) {
    const task = ownedTask(login, taskId);
    if (!task) throw fault('TASK_NOT_FOUND', 404);
    const self = { instance_id: me(), name: identity().name, company_computer: Boolean(isCompany()) };
    const limit = limitBytes();
    let refusal = isHeld(task) ? { error: 'TASK_MOVING', reason: null } : task.archived_at ? { error: 'TASK_ARCHIVED', reason: null } : folderProblem(task);
    let folder = null;
    let sessions = { claude: 0, codex: 0, missing: 0 };
    if (!refusal || refusal.error !== 'MOVE_FOLDER_MISSING') {
      try {
        const scan = files.scanFolder(task.work_dir, { maxFiles, maxBytes: limit });
        folder = { path: path.resolve(task.work_dir), files: scan.totals.files, dirs: scan.totals.dirs, links: scan.totals.links, bytes: scan.totals.bytes, skipped: scan.skipped.length, truncated: scan.truncated };
        if (!refusal && scan.truncated === 'bytes') refusal = { error: 'MOVE_TOO_LARGE', reason: null };
        if (!refusal && scan.truncated === 'files') refusal = { error: 'MOVE_TOO_MANY_FILES', reason: null };
        const dirs = [path.resolve(task.work_dir), realOr(task.work_dir)].filter((dir, index, list) => dir && list.indexOf(dir) === index);
        const found = findSessions(task, dirs);
        sessions = { claude: found.carried.filter(item => item.agent === 'claude').length, codex: found.carried.filter(item => item.agent === 'codex').length, missing: found.missing.length };
        if (folder) folder.bytes += found.items.reduce((sum, item) => sum + item.s, 0);
      } catch (error) { if (!refusal) refusal = { error: codeOf(error), reason: reasonOf(error) }; }
    }
    const running = terminals.live(task.id) || [];
    const busy = Number(terminals.busy(task.id)) || 0;
    const targets = await Promise.all(peers().map(async peer => {
      const base = { instance_id: peer.instanceId || null, name: peer.name, online: Boolean(peer.online), supported: null, company_computer: null, free_bytes: null, refusal: null };
      if (!peer.instanceId) return { ...base, refusal: { error: 'MOVE_TARGET_UNSUPPORTED' } };
      if (!peer.online) return { ...base, refusal: { error: 'MOVE_TARGET_OFFLINE' } };
      let denied = false;
      try { denied = visibility.isDenied(task.id, peer.id); } catch { denied = false; }
      try {
        const capacity = await call(peer, '/v1/task-move/capacity', { timeoutMs: 4000 });
        const out = { ...base, supported: true, company_computer: Boolean(capacity.company_computer), free_bytes: Number.isFinite(capacity.free_bytes) ? capacity.free_bytes : null, limit_bytes: capacity.limit_bytes || null };
        if (denied) return { ...out, refusal: { error: 'MOVE_TASK_HIDDEN' } };
        if (folder && out.free_bytes !== null && folder.bytes + SPACE_MARGIN > out.free_bytes) return { ...out, refusal: { error: 'MOVE_NO_SPACE' } };
        if (folder && out.limit_bytes && folder.bytes > out.limit_bytes) return { ...out, refusal: { error: 'MOVE_TOO_LARGE' } };
        return out;
      } catch (error) {
        if (error && (error.statusCode === 404 || error.statusCode === 501)) return { ...base, supported: false, refusal: { error: 'MOVE_TARGET_UNSUPPORTED' } };
        return { ...base, refusal: { error: 'MOVE_TARGET_OFFLINE' } };
      }
    }));
    return {
      task: { id: task.id, title: task.title }, self, folder, sessions, limit_bytes: limit, refusal,
      terminals: { running: running.length, busy }, targets, active: view(activeFor(task.id)),
    };
  }

  // ---- Source: start ----
  async function start(login, taskId, body = {}) {
    const task = ownedTask(login, taskId);
    if (!task) throw fault('TASK_NOT_FOUND', 404);
    if (activeFor(task.id)) throw fault('MOVE_IN_PROGRESS');
    if (isHeld(task)) throw fault('TASK_MOVING');
    if (task.archived_at) throw fault('TASK_ARCHIVED');
    const problem = folderProblem(task);
    if (problem) throw fault(problem.error, 409, { reason: problem.reason });
    const targetId = typeof body.target === 'string' ? body.target : '';
    if (targetId === me()) throw fault('MOVE_TARGET_SELF', 400);
    const peer = peerByInstance(targetId);
    if (!peer) throw fault('MOVE_TARGET_UNKNOWN', 404);
    if (!peer.online) throw fault('MOVE_TARGET_OFFLINE');
    let denied = false;
    try { denied = visibility.isDenied(task.id, peer.id); } catch { denied = false; }
    if (denied) throw fault('MOVE_TASK_HIDDEN');
    let info;
    try { info = await call(peer, '/v1/info', { timeoutMs: 5000 }); } catch { throw fault('MOVE_TARGET_OFFLINE'); }
    if (!info || !Array.isArray(info.capabilities) || !info.capabilities.includes(CAPABILITY)) throw fault('MOVE_TARGET_UNSUPPORTED');
    // Between a company computer and a normal machine the person must tick "I understand, move it anyway" (checked here, not only on the page).
    if (Boolean(info.company_computer) !== Boolean(isCompany()) && body.tier_ack !== true) throw fault('MOVE_TIER_CONFIRMATION_REQUIRED');
    const limit = limitBytes();
    const scan = files.scanFolder(task.work_dir, { maxFiles, maxBytes: limit });
    if (scan.truncated === 'bytes') throw fault('MOVE_TOO_LARGE', 413);
    if (scan.truncated === 'files') throw fault('MOVE_TOO_MANY_FILES', 413);
    let capacity;
    try { capacity = await call(peer, '/v1/task-move/capacity', { timeoutMs: 5000 }); } catch { throw fault('MOVE_TARGET_OFFLINE'); }
    if (Number.isFinite(capacity.free_bytes) && scan.totals.bytes + SPACE_MARGIN > capacity.free_bytes) throw fault('MOVE_NO_SPACE');
    if (capacity.limit_bytes && scan.totals.bytes > capacity.limit_bytes) throw fault('MOVE_TOO_LARGE', 413);
    if (activeFor(task.id)) throw fault('MOVE_IN_PROGRESS'); // a second request that got here during the awaits
    const record = journal.write({
      id: crypto.randomUUID(), role: 'source', state: 'preparing', task_id: task.id, title: task.title, owner: login,
      target: { instance_id: peer.instanceId, name: peer.name, link_id: peer.id, company_computer: Boolean(info.company_computer) },
      tier_ack: body.tier_ack === true, started_at: now(), files_total: scan.totals.files, bytes_total: scan.totals.bytes,
    });
    lock.add(task.id);
    setProgress(record.id, { phase: 'closing', files_total: scan.totals.files, bytes_total: scan.totals.bytes, files_done: 0, bytes_done: 0 });
    runSource(record).catch(error => { if (!isCrash(error)) log.warn(`[task-move] ${record.id}: ${codeOf(error)}`); });
    return view(record);
  }

  async function runSource(record) {
    const entry = liveOf(record.id);
    const { signal } = entry.controller;
    try {
      at('source:start', record);
      terminals.close(record.task_id);
      try { chat.stop(record.task_id); } catch { /* no chat */ }
      if (settleMs) await wait(settleMs);
      if (signal.aborted) throw fault('MOVE_CANCELLED');
      setProgress(record.id, { phase: 'scanning' });
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(record.task_id);
      if (!task) throw fault('TASK_NOT_FOUND', 404);
      const dir = path.resolve(task.work_dir);
      const folderDirs = [dir, realOr(dir)].filter((item, index, list) => item && list.indexOf(item) === index);
      const scan = files.scanFolder(dir, { maxFiles, maxBytes: limitBytes() });
      if (scan.truncated) throw fault(scan.truncated === 'bytes' ? 'MOVE_TOO_LARGE' : 'MOVE_TOO_MANY_FILES', 413);
      await files.hashEntries(dir, scan.entries, { signal });
      at('source:scanned', record);
      const sessions = findSessions(task, folderDirs);
      const docs = findDocuments(task, folderDirs);
      const blobs = [];
      const items = [
        ...scan.entries.map(item => ({ area: 'folder', ...item })),
        ...sessions.items, ...docs.items,
      ];
      items.forEach(item => { if (item.t === 'f') blobs.push(null); });
      // Private: where each file of the manifest is on this machine (never sent).
      let blobIndex = 0;
      let sessionIndex = 0;
      let docIndex = 0;
      for (const item of items) {
        if (item.t !== 'f') continue;
        item.i = blobIndex;
        blobs[blobIndex] = item.area === 'folder' ? files.joinInside(dir, item.p) : item.area === 'session' ? sessions.abs[sessionIndex++] : docs.abs[docIndex++];
        blobIndex += 1;
      }
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (item.area !== 'folder' && item.t === 'f') item.h = await files.hashFile(blobs[item.i], { expectedSize: item.s, signal });
      }
      const totals = { files: blobs.length, bytes: items.reduce((sum, item) => sum + (item.t === 'f' ? item.s : 0), 0) };
      const manifest = {
        version: files.MANIFEST_VERSION, id: record.id, root_name: path.basename(dir), top: { m: scan.mode, mt: scan.mt },
        items, totals, skipped: scan.skipped, payload: payloadOf(task, folderDirs),
        source: { instance_id: me(), name: identity().name },
      };
      files.writeJsonAtomic(path.join(journal.dir, `${record.id}.manifest`), manifest);
      entry.blobs = blobs;
      entry.items = items;
      const sessionNote = { carried: sessions.carried.length, not_carried: sessions.missing };
      const now_ = journal.read(record.id);
      if (!now_ || now_.state !== 'preparing' || signal.aborted) throw fault('MOVE_CANCELLED');
      Object.assign(record, journal.update(record.id, {
        state: 'offered', files_total: totals.files, bytes_total: totals.bytes, sessions: sessionNote,
        // What goes to the trash after the commit, also when this engine restarted in between.
        work_dir: dir, session_files: items.filter(item => item.area === 'session').map(item => blobs[item.i]),
      }));
      setProgress(record.id, { phase: 'copying', files_total: totals.files, bytes_total: totals.bytes });
      at('source:offering', record);
      entry.lastSeen = now();
      const peer = peerByLink(record.target.link_id);
      const answer = await call(peer, '/v1/task-move/offer', {
        method: 'POST', timeoutMs: 20_000,
        body: { move_id: record.id, title: record.title, root_name: manifest.root_name, totals, tier_ack: record.tier_ack, source: { instance_id: me(), name: identity().name, company_computer: Boolean(isCompany()) } },
      });
      if (answer && typeof answer.folder === 'string') Object.assign(record, journal.update(record.id, { folder_on_target: answer.folder }));
      entry.lastSeen = now();
      at('source:offered', record);
    } catch (error) {
      if (isCrash(error)) throw error;
      abortSource(record.id, error, { tell: true });
      throw error;
    }
  }

  // Ends a move of this engine's task before its commit: the task stays here, unlocked. `tell`: the target drops its copy (best effort).
  function abortSource(id, error, { tell = false, cancelled = false } = {}) {
    const record = journal.read(id);
    if (!record || !ACTIVE.has(record.state)) return record;
    const next = journal.update(id, { state: 'aborted', cancelled, error: cancelled ? 'MOVE_CANCELLED' : codeOf(error), reason: cancelled ? null : reasonOf(error), finished_at: now() });
    const entry = live.get(id);
    if (entry) entry.controller.abort();
    lock.delete(record.task_id);
    try { fs.unlinkSync(path.join(journal.dir, `${id}.manifest`)); } catch { /* not written */ }
    if (tell && record.state === 'offered') {
      const peer = peerByLink(record.target.link_id);
      if (peer) call(peer, `/v1/task-move/${id}/cancel`, { method: 'POST', body: {}, timeoutMs: 5000 }).catch(() => { /* the target's own recovery asks */ });
    }
    return next;
  }

  function cancel(login, taskId) {
    const record = activeFor(taskId);
    if (!record || record.owner !== login) throw fault('MOVE_NOT_FOUND', 404);
    if (record.state === 'committed') throw fault('MOVE_FINISHING');
    const entry = live.get(record.id);
    if (entry && entry.progress.phase === 'creating') throw fault('MOVE_FINISHING');
    return view(abortSource(record.id, null, { tell: true, cancelled: true }));
  }

  function progress(login, taskId) {
    const record = latestFor(taskId);
    if (!record || record.owner !== login) return null;
    return view(record);
  }

  // ---- Source: what the target asks ----
  function sourceRecordFor(link, id) {
    const record = journal.isId(id) ? journal.read(id) : null;
    if (!record || record.role !== 'source' || record.target.link_id !== link.id) throw fault('MOVE_NOT_FOUND', 404);
    return record;
  }
  // A task this link may not see is not given to it, whatever it asks.
  function assertVisible(record, link) {
    let denied = false;
    try { denied = visibility.isDenied(record.task_id, link.id); } catch { denied = false; }
    if (denied) throw fault('MOVE_NOT_FOUND', 404);
  }
  function servingRecord(tokenId, id) {
    const link = linkOfToken(tokenId);
    const record = sourceRecordFor(link, id);
    if (record.state !== 'offered') throw fault(record.state === 'aborted' ? 'MOVE_CANCELLED' : 'MOVE_NOT_OPEN');
    assertVisible(record, link);
    const entry = live.get(id);
    if (!entry || !entry.blobs) throw fault('MOVE_NOT_OPEN');
    entry.lastSeen = now();
    return { record, entry };
  }
  function manifestFile(tokenId, id) {
    servingRecord(tokenId, id);
    return path.join(journal.dir, `${id}.manifest`);
  }
  // The file `index` of the manifest: { path, size } (the route streams it, with Range).
  function blob(tokenId, id, index) {
    const { entry } = servingRecord(tokenId, id);
    const number = Number(index);
    if (!Number.isInteger(number) || number < 0 || number >= entry.blobs.length) throw fault('MOVE_BAD_INDEX', 400);
    const item = entry.items.find(candidate => candidate.i === number);
    return { path: entry.blobs[number], size: item.s };
  }
  function noteProgress(tokenId, id, body = {}) {
    const { record } = servingRecord(tokenId, id);
    const phases = new Set(['copying', 'verifying', 'creating']);
    const change = {};
    if (phases.has(body.phase)) change.phase = body.phase;
    for (const key of ['files_done', 'bytes_done']) if (Number.isSafeInteger(body[key]) && body[key] >= 0) change[key] = body[key];
    setProgress(record.id, change);
    return { ok: true };
  }
  function peerFailed(tokenId, id, body = {}) {
    const link = linkOfToken(tokenId);
    const record = sourceRecordFor(link, id);
    if (ACTIVE.has(record.state)) abortSource(id, fault(/^[A-Z0-9_]{1,64}$/.test(body.error || '') ? body.error : 'MOVE_TARGET_FAILED', 409, { reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : null }));
    return { state: journal.read(id).state };
  }
  function statusForPeer(tokenId, id) {
    const link = linkOfToken(tokenId);
    const record = journal.isId(id) ? journal.read(id) : null;
    if (!record) throw fault('MOVE_NOT_FOUND', 404);
    const peerLink = record.role === 'source' ? record.target.link_id : record.source.link_id;
    if (peerLink !== link.id) throw fault('MOVE_NOT_FOUND', 404);
    return { state: record.state, role: record.role };
  }

  // The commit (the target has the task, held): the point of no return. Written to the journal before anything else; then finished.
  function commit(tokenId, id, body = {}) {
    const link = linkOfToken(tokenId);
    const record = sourceRecordFor(link, id);
    if (record.state === 'committed' || record.state === 'done') return { state: record.state };
    if (record.state !== 'offered') throw fault(record.state === 'aborted' ? 'MOVE_CANCELLED' : 'MOVE_NOT_OPEN');
    assertVisible(record, link);
    const newTaskId = Number(body.task_id);
    if (!Number.isSafeInteger(newTaskId) || newTaskId < 1) throw fault('MOVE_BAD_TASK', 400);
    at('source:before-commit', record);
    const committed = journal.update(id, { state: 'committed', new_task_id: newTaskId, folder_on_target: typeof body.folder === 'string' ? body.folder : record.folder_on_target || null });
    setProgress(id, { phase: 'finishing', files_done: committed.files_total, bytes_done: committed.bytes_total });
    try { finishSource(committed); } catch (error) {
      if (isCrash(error)) throw error;
      // Committed is committed: the rest is tried again (retry timer, next start); the target may release its hold.
      log.warn(`[task-move] ${id}: finishing after the commit failed: ${codeOf(error)} ${reasonOf(error) || ''}`);
    }
    return { state: 'committed' };
  }

  // After the commit, idempotent: the folder and the session files to the trash, the rows away, the order, the moved record, T-Attention.
  function finishSource(input) {
    let record = journal.read(input.id) || input;
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(record.task_id);
    const entry = live.get(record.id);
    if (!record.trash) record = journal.update(record.id, { trash: path.join(trashDir, `moved-${record.task_id}-${now()}`), work_dir: record.work_dir || (task ? task.work_dir : null) });
    fs.mkdirSync(record.trash, { recursive: true, mode: 0o700 });
    const info = path.join(record.trash, 'moved.json');
    if (!fs.existsSync(info)) files.writeJsonAtomic(info, { moved_at: now(), task_id: record.task_id, title: record.title, to: { instance_id: record.target.instance_id, name: record.target.name, task_id: record.new_task_id }, from_dir: record.work_dir });
    at('source:trash', record);
    const folderTrash = path.join(record.trash, 'folder');
    if (record.work_dir && fs.existsSync(record.work_dir) && !fs.existsSync(folderTrash) && !record.elsewhere) {
      try { fs.renameSync(record.work_dir, folderTrash); } catch (error) {
        if (error.code !== 'EXDEV') throw error;
        // Another file system: kept next to the folder under a name the sweeper knows, and named in moved.json.
        const elsewhere = path.join(path.dirname(record.work_dir), `.t-agent-trash-moved-${record.task_id}-${now()}`);
        record = journal.update(record.id, { elsewhere });
        files.writeJsonAtomic(info, { ...JSON.parse(fs.readFileSync(info, 'utf8')), elsewhere });
        fs.renameSync(record.work_dir, elsewhere);
      }
    }
    at('source:folder-trashed', record);
    const sessionsTrash = path.join(record.trash, 'sessions');
    (record.session_files || []).forEach((file, index) => {
      if (!file || !fs.existsSync(file)) return;
      fs.mkdirSync(sessionsTrash, { recursive: true, mode: 0o700 });
      try { fs.renameSync(file, path.join(sessionsTrash, `${index}-${path.basename(file)}`)); } catch (error) {
        if (error.code !== 'EXDEV') throw error;
        fs.copyFileSync(file, path.join(sessionsTrash, `${index}-${path.basename(file)}`));
        fs.unlinkSync(file);
      }
    });
    at('source:sessions-trashed', record);
    if (task) {
      db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
      try { forgetTask(task.id); } catch { /* in memory only */ }
      try { visibility.forgetTask(task.id); } catch { /* in memory only */ }
    }
    at('source:rows-removed', record);
    const from = { instance: me(), task: String(record.task_id) };
    const to = { instance: record.target.instance_id, task: String(record.new_task_id) };
    try { taskOrder.replace(record.owner, `${from.instance}:${from.task}`, `${to.instance}:${to.task}`); } catch (error) { log.warn(`[task-move] task order: ${codeOf(error)}`); }
    try { pageState.recordMove(record.owner, { from, to, title: record.title }); } catch (error) { log.warn(`[task-move] moved record: ${codeOf(error)}`); }
    try { if (attention) attention.repoint(record.task_id, { instance: to.instance, task_id: to.task }); } catch (error) { log.warn(`[task-move] T-Attention: ${codeOf(error)}`); }
    at('source:repointed', record);
    lock.delete(record.task_id);
    try { fs.unlinkSync(path.join(journal.dir, `${record.id}.manifest`)); } catch { /* gone */ }
    journal.update(record.id, { state: 'done', finished_at: now() });
    if (entry) entry.blobs = null;
  }

  // ---- Target ----
  function capacityFor(tokenId) {
    linkOfToken(tokenId);
    const base = tasksBase();
    return { free_bytes: files.freeBytes(base), limit_bytes: limitBytes(), company_computer: Boolean(isCompany()), max_files: maxFiles };
  }

  async function acceptOffer(tokenId, body = {}) {
    const link = linkOfToken(tokenId);
    const peer = peerByLink(link.id);
    if (!peer) throw fault('LINKED_ONLY', 403);
    const id = String(body.move_id || '');
    if (!journal.isId(id)) throw fault('MOVE_BAD_OFFER', 400);
    if (journal.read(id)) throw fault('MOVE_EXISTS');
    const source = body.source || {};
    if (link.peer_instance_id && source.instance_id !== link.peer_instance_id) throw fault('MOVE_BAD_OFFER', 400);
    const totals = body.totals || {};
    if (!Number.isSafeInteger(totals.files) || !Number.isSafeInteger(totals.bytes) || totals.files < 0 || totals.bytes < 0) throw fault('MOVE_BAD_OFFER', 400);
    if (totals.bytes > limitBytes()) throw fault('MOVE_TOO_LARGE', 413);
    if (totals.files > maxFiles) throw fault('MOVE_TOO_MANY_FILES', 413);
    // The tier rule again, on this side: the source's own word on its tier is read from its /v1/info, not taken from the offer.
    let info;
    try { info = await call(peer, '/v1/info', { timeoutMs: 5000 }); } catch { throw fault('MOVE_SOURCE_OFFLINE'); }
    if (!info || !Array.isArray(info.capabilities) || !info.capabilities.includes(CAPABILITY)) throw fault('MOVE_SOURCE_UNSUPPORTED');
    if (Boolean(info.company_computer) !== Boolean(isCompany()) && body.tier_ack !== true) throw fault('MOVE_TIER_CONFIRMATION_REQUIRED');
    const base = path.resolve(tasksBase());
    fs.mkdirSync(base, { recursive: true });
    const free = files.freeBytes(base);
    if (free !== null && totals.bytes + SPACE_MARGIN > free) throw fault('MOVE_NO_SPACE');
    const folder = files.targetFolder(base, String(body.root_name || ''));
    const staging = path.join(base, `.t-agent-incoming-${id}`);
    if (path.dirname(staging) !== base) throw fault('MOVE_PATH_ESCAPES');
    const record = journal.write({
      id, role: 'target', state: 'pulling', owner: owner(), title: typeof body.title === 'string' ? body.title.slice(0, 500) : '',
      source: { instance_id: source.instance_id || null, name: typeof source.name === 'string' ? source.name.slice(0, 120) : peer.name, link_id: link.id },
      staging, planned_folder: folder, started_at: now(), totals,
    });
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    runTarget(record).catch(error => { if (!isCrash(error)) log.warn(`[task-move] incoming ${id}: ${codeOf(error)} ${reasonOf(error) || ''}`); });
    return { accepted: true, folder };
  }

  let lastReport = 0;
  function report(record, change, force = false) {
    setProgress(record.id, change);
    if (!force && now() - lastReport < PROGRESS_GAP_MS) return Promise.resolve();
    lastReport = now();
    const peer = peerByLink(record.source.link_id);
    return call(peer, `/v1/task-move/${record.id}/progress`, { method: 'POST', body: liveOf(record.id).progress, timeoutMs: 5000 }).catch(() => { /* progress is best effort */ });
  }

  // One file from the source into `file`, in chunks with Range; a failed chunk is asked again from where it stopped (the hash goes back to the last
  // whole chunk). Throws MOVE_HASH_MISMATCH when the bytes are not those of the manifest.
  async function pullBlob(record, peer, item, file, signal, onBytes) {
    fs.writeFileSync(file, '', { mode: 0o600 });
    let good = crypto.createHash('sha256');
    let offset = 0;
    while (offset < item.s) {
      const end = Math.min(item.s, offset + chunkBytes) - 1;
      for (let attempt = 0; ; attempt += 1) {
        const working = good.copy();
        let received = 0;
        try {
          at('target:chunk', { ...record, item, offset });
          const res = await openStream(peer.baseUrl, `/v1/task-move/${record.id}/blob/${item.i}`, peer.token, { headers: { Range: `bytes=${offset}-${end}` }, signal });
          const counter = new Transform({ transform(chunk, encoding, done) { received += chunk.length; working.update(chunk); onBytes(chunk.length); done(null, chunk); } });
          await pipeline(res, counter, fs.createWriteStream(file, { flags: 'r+', start: offset }));
          if (received !== end - offset + 1) throw fault('MOVE_SHORT_READ', 502);
          good = working;
          break;
        } catch (error) {
          onBytes(-received);
          if (signal.aborted || error.message === 'MOVE_CANCELLED') throw fault('MOVE_CANCELLED');
          if (isCrash(error)) throw error;
          const permanent = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 && ![408, 429].includes(error.statusCode);
          if (permanent || attempt >= RETRIES) throw error;
          fs.truncateSync(file, offset);
          await wait(200 * (attempt + 1));
        }
      }
      offset = end + 1;
    }
    if (good.digest('hex') !== item.h) throw fault('MOVE_HASH_MISMATCH', 409, { reason: item.p });
  }

  const stagedBlob = (record, item) => path.join(record.staging, item.area === 'folder' ? 'folder' : 'blobs', ...(item.area === 'folder' ? files.safeRelative(item.p) : [String(item.i)]));

  async function readManifest(record, peer, signal) {
    const file = path.join(record.staging, 'manifest.json');
    if (!fs.existsSync(file)) {
      const res = await openStream(peer.baseUrl, `/v1/task-move/${record.id}/manifest`, peer.token, { signal });
      let size = 0;
      const limit = new Transform({ transform(chunk, encoding, done) { size += chunk.length; done(size > MANIFEST_MAX ? fault('MOVE_MANIFEST_TOO_LARGE', 413) : null, chunk); } });
      await pipeline(res, limit, fs.createWriteStream(`${file}.part`, { mode: 0o600 }));
      fs.renameSync(`${file}.part`, file);
    }
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!manifest || manifest.version !== files.MANIFEST_VERSION || manifest.id !== record.id || !Array.isArray(manifest.items)) throw fault('MOVE_BAD_MANIFEST', 400);
    files.checkFolderName(manifest.root_name);
    let blobs = 0;
    let bytes = 0;
    for (const item of manifest.items) {
      if (!['folder', 'session', 'document'].includes(item.area) || !['f', 'd', 'l'].includes(item.t)) throw fault('MOVE_BAD_MANIFEST', 400);
      files.safeRelative(item.p);
      if (item.area !== 'folder' && item.t !== 'f') throw fault('MOVE_BAD_MANIFEST', 400);
      if (item.area === 'session' && !['claude', 'codex'].includes(item.agent)) throw fault('MOVE_BAD_MANIFEST', 400);
      if (item.area === 'document' && !DOC_KINDS[item.kind]) throw fault('MOVE_BAD_MANIFEST', 400);
      if (item.t === 'f') {
        if (item.i !== blobs || !Number.isSafeInteger(item.s) || item.s < 0 || !/^[a-f0-9]{64}$/.test(item.h || '')) throw fault('MOVE_BAD_MANIFEST', 400);
        blobs += 1;
        bytes += item.s;
      }
    }
    if (blobs !== record.totals.files || bytes !== record.totals.bytes) throw fault('MOVE_BAD_MANIFEST', 400, { reason: 'the manifest does not match the offer' });
    return manifest;
  }

  async function runTarget(record) {
    const entry = liveOf(record.id);
    const { signal } = entry.controller;
    const peer = () => peerByLink(record.source.link_id);
    try {
      at('target:start', record);
      const manifest = await readManifest(record, peer(), signal);
      const folderItems = manifest.items.filter(item => item.area === 'folder');
      const fromDirs = manifest.payload.old_dirs || [];
      files.createSkeleton(path.join(record.staging, 'folder'), folderItems, { fromDirs, toDir: record.planned_folder });
      fs.mkdirSync(path.join(record.staging, 'blobs'), { recursive: true, mode: 0o700 });
      const blobs = manifest.items.filter(item => item.t === 'f');
      const totals = { files_total: blobs.length, bytes_total: blobs.reduce((sum, item) => sum + item.s, 0), files_done: 0, bytes_done: 0 };
      report(record, { phase: 'copying', ...totals }, true);
      let next = 0;
      const worker = async () => {
        while (next < blobs.length) {
          if (signal.aborted) throw fault('MOVE_CANCELLED');
          const item = blobs[next++];
          await pullBlob(record, peer(), item, stagedBlob(record, item), signal, bytes => { totals.bytes_done += bytes; report(record, { bytes_done: totals.bytes_done }); });
          totals.files_done += 1;
          report(record, { files_done: totals.files_done, bytes_done: totals.bytes_done });
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, blobs.length)) }, worker));
      at('target:pulled', record);
      report(record, { phase: 'verifying' }, true);
      files.applyMeta(path.join(record.staging, 'folder'), folderItems, manifest.top);
      const problems = await files.verifyCopy(path.join(record.staging, 'folder'), folderItems, { fromDirs, toDir: record.planned_folder, signal });
      for (const item of blobs.filter(blob => blob.area !== 'folder')) {
        const file = stagedBlob(record, item);
        try { if (await files.hashFile(file, { expectedSize: item.s, signal }) !== item.h) problems.push(`${item.area} ${item.i}: SHA-256 differs`); }
        catch (error) { if (error.message === 'MOVE_CANCELLED') throw error; problems.push(`${item.area} ${item.i}: ${error.message}`); }
      }
      if (problems.length) throw fault('MOVE_VERIFY_FAILED', 409, { reason: problems.slice(0, 5).join('; ') });
      at('target:verified', record);
      if (signal.aborted) throw fault('MOVE_CANCELLED');
      // Awaited: from the moment the source has heard this, it refuses a cancel (MOVE_FINISHING), so "cancel until verified" is exact.
      await report(record, { phase: 'creating' }, true);
      await createAndCommit(record, manifest);
    } catch (error) {
      if (isCrash(error)) throw error;
      // Anything that escapes here happened before the source's commit (resolveHeld keeps its own failures), so this side is undone.
      const current = journal.read(record.id);
      if (current && TARGET_OPEN.has(current.state)) {
        rollbackTarget(current, error);
        const source = peer();
        if (source && error.message !== 'MOVE_CANCELLED') call(source, `/v1/task-move/${record.id}/failed`, { method: 'POST', body: { error: codeOf(error), reason: reasonOf(error) }, timeoutMs: 5000 }).catch(() => {});
      }
      throw error;
    }
  }

  // Creates the task here (held), then asks the source to commit. Idempotent, so a start after a crash runs it again from the journal.
  async function createAndCommit(input, manifest) {
    let record = journal.read(input.id) || input;
    const staged = path.join(record.staging, 'folder');
    if (record.state === 'pulling') {
      // The planned folder may have been taken meanwhile: another name, and the links into the folder point there.
      let folder = record.planned_folder;
      if (fs.existsSync(folder)) {
        folder = files.targetFolder(path.dirname(folder), manifest.root_name);
        for (const item of manifest.items.filter(entry => entry.area === 'folder' && entry.t === 'l')) {
          const link = files.joinInside(staged, item.p);
          fs.unlinkSync(link);
          fs.symlinkSync(files.movedLink(item.l, manifest.payload.old_dirs || [], folder), link);
        }
      }
      record = journal.update(record.id, { state: 'placed', folder });
      at('target:before-place', record);
    }
    if (record.state === 'placed') {
      if (!fs.existsSync(record.folder) && fs.existsSync(staged)) fs.renameSync(staged, record.folder);
      at('target:placed', record);
      if (!record.documents) {
        const documents = {};
        for (const doc of manifest.items.filter(item => item.area === 'document')) documents[doc.kind] = documentPlace(record, doc);
        record = journal.update(record.id, { documents });
      }
      const taskId = ensureHeldTask(record, manifest);
      record = journal.update(record.id, { state: 'created', task_id: taskId });
      at('target:created', record);
    }
    if (record.state === 'created' && !record.extras_done) {
      const placed = placeExtras(record, manifest);
      record = journal.update(record.id, { placed: placed.files, sessions: placed.sessions, extras_done: true });
      at('target:extras', record);
    }
    if (record.state === 'created') await resolveHeld(record);
  }

  // The task rows, held until the source has committed (archived_at = 'moving:<id>': inert and listed nowhere). Returns the task id.
  function ensureHeldTask(record, manifest) {
    const marker = `${HOLD_PREFIX}${record.id}`;
    const existing = db.prepare('SELECT id FROM tasks WHERE archived_at = ?').get(marker);
    if (existing) return existing.id;
    const payload = manifest.payload;
    const fromDirs = payload.old_dirs || [];
    const to = record.folder;
    const login = record.owner;
    const taskColumns = columnsOf(db, 'tasks');
    const status = groupFor(login, payload.task);
    const documents = record.documents || {};
    // A path in the old folder moves with it; a document kept outside it was copied into the new folder (`documents`); any other path of the old
    // machine means nothing here, so the default is used.
    const pathOf = (value, kind) => {
      if (kind && documents[kind] && typeof value === 'string' && value) return documents[kind];
      if (typeof value !== 'string' || !path.isAbsolute(value)) return value || null;
      const moved = swapPath(value, fromDirs, to);
      return moved === value ? null : moved;
    };
    const row = {
      title: payload.task.title, status, priority: payload.task.priority || 'normal', due_date: payload.task.due_date || null,
      md_path: documents.technical || pathOf(payload.task.md_path), work_dir: to, sort_order: 0, user_id: login,
      technical_path: documents.technical || pathOf(payload.task.technical_path), readme_path: documents.readme || pathOf(payload.task.readme_path),
      agent_path: documents.agent || pathOf(payload.task.agent_path), created_at: payload.task.created_at || null, archived_at: marker,
    };
    const insertRow = (table, values) => {
      const columns = columnsOf(db, table);
      const names = Object.keys(values).filter(name => columns.has(name) && values[name] !== undefined && !(name === 'created_at' && !values[name]));
      return db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map(name => values[name]));
    };
    return db.transaction(() => {
      const taskId = Number(insertRow('tasks', Object.fromEntries(Object.entries(row).filter(([name]) => taskColumns.has(name)))).lastInsertRowid);
      for (const terminal of payload.terminals || []) insertRow('task_terminals', { ...terminal, task_id: taskId, work_dir: terminal.work_dir ? swapPath(terminal.work_dir, fromDirs, to) : terminal.work_dir });
      const def = payload.default_terminal || {};
      if (def.title) db.prepare('INSERT OR REPLACE INTO task_default_terminal_titles (task_id, title) VALUES (?, ?)').run(taskId, def.title);
      if (def.removed) db.prepare('INSERT OR IGNORE INTO task_default_terminal_removed (task_id) VALUES (?)').run(taskId);
      if (def.work_dir) db.prepare('INSERT OR REPLACE INTO task_default_terminal_dirs (task_id, work_dir) VALUES (?, ?)').run(taskId, swapPath(def.work_dir, fromDirs, to));
      if (Array.isArray(payload.terminal_order) && payload.terminal_order.length) {
        db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(`terminal_order_v1:${taskId}`, JSON.stringify(payload.terminal_order.slice(0, 500)));
      }
      for (const todo of payload.todos || []) insertRow('task_todos', { ...todo, task_id: taskId });
      for (const chatRow of payload.chats || []) {
        const taken = chatRow.id && db.prepare('SELECT 1 FROM agent_conversations WHERE id = ?').get(chatRow.id);
        insertRow('agent_conversations', { ...chatRow, id: taken || !chatRow.id ? crypto.randomUUID() : chatRow.id, task_id: taskId });
      }
      for (const cleanup of payload.repo_cleanups || []) {
        const moved = swapPath(cleanup.path, fromDirs, to);
        if (!db.prepare('SELECT 1 FROM repo_cleanups WHERE path = ?').get(moved)) insertRow('repo_cleanups', { ...cleanup, path: moved, task_id: taskId });
      }
      return taskId;
    })();
  }

  // The task's group here: the same key, else a group of the same name, else a new group with that name, else To do.
  function groupFor(login, task) {
    const groups = require('./task-groups');
    try { groups.ensureGroups(db, login); } catch { return 'todo'; }
    if (db.prepare('SELECT 1 FROM task_groups WHERE owner_id = ? AND group_key = ?').get(login, task.status)) return task.status;
    const name = task.group && task.group.name;
    if (!name) return 'todo';
    const same = db.prepare('SELECT group_key FROM task_groups WHERE owner_id = ? AND name = ?').get(login, name);
    if (same) return same.group_key;
    try { return groups.createGroup(db, login, { name }).key; } catch { return 'todo'; }
  }

  // Where a document kept outside the old folder goes: into the new folder under its own name, or `moved-<kind>-<name>` when that is taken.
  function documentPlace(record, doc) {
    const plain = path.join(record.folder, files.checkFolderName(doc.p));
    return fs.existsSync(plain) ? path.join(record.folder, `moved-${doc.kind}-${doc.p}`) : plain;
  }

  // The session files (into this machine's agent homes, with the folder's path rewritten) and the documents. A file that is already there is never
  // overwritten. Returns { files: [placed paths], sessions: { carried, skipped: [{ agent, id, why }] } }.
  function placeExtras(record, manifest) {
    const placed = new Set(record.placed || []);
    const homes = agentDirs();
    const fromDirs = (manifest.payload.old_dirs || []).filter(Boolean);
    const newReal = realOr(record.folder) || record.folder;
    const pairs = fromDirs.map((from, index) => [from, index === 0 ? record.folder : newReal]);
    if (pairs.length === 1 && newReal !== record.folder) pairs.push([fromDirs[0], newReal]);
    const needles = pairs.map(([from]) => JSON.stringify(from).slice(1, -1));
    const skipped = [];
    const carried = new Set();
    const write = (from, to, item, rewrite) => {
      if (placed.has(to)) return true;
      if (fs.existsSync(to)) return false;
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      let text = fs.readFileSync(from);
      if (rewrite) {
        const source = text.toString('utf8');
        if (needles.some(needle => source.includes(needle))) {
          text = Buffer.from(source.split('\n').map(line => {
            if (!needles.some(needle => line.includes(needle))) return line;
            let row;
            try { row = JSON.parse(line); } catch { return line; }
            return rewrite(row) ? JSON.stringify(row) : line;
          }).join('\n'));
        }
      }
      const temp = `${to}.t-agent-move-${process.pid}.tmp`;
      fs.writeFileSync(temp, text, { mode: item.m & 0o777, flag: 'wx' });
      fs.utimesSync(temp, item.mt / 1000, item.mt / 1000);
      fs.renameSync(temp, to);
      placed.add(to);
      journal.update(record.id, { placed: [...placed] });
      return true;
    };
    for (const item of manifest.items.filter(entry => entry.area === 'session')) {
      const from = stagedBlob(record, item);
      const parts = files.safeRelative(item.p);
      let to;
      if (item.agent === 'claude') {
        const root = (homes.claude || [])[0];
        if (!root || parts[0] !== 'projects' || parts.length < 3) { skipped.push({ agent: item.agent, id: item.id, why: 'no Claude Code folder here' }); continue; }
        to = path.join(root, 'projects', claudeProjectName(newReal), ...parts.slice(2));
      } else {
        const root = (homes.codex || [])[0];
        if (!root || !['sessions', 'archived_sessions'].includes(parts[0])) { skipped.push({ agent: item.agent, id: item.id, why: 'no Codex folder here' }); continue; }
        to = path.join(root, ...parts);
      }
      const rewrite = item.agent === 'claude' ? row => rewriteCwd(row, pairs) : row => rewriteCwd(row, pairs, CODEX_ROOT_KEYS);
      if (write(from, to, item, to.endsWith('.jsonl') ? rewrite : null)) carried.add(`${item.agent}:${item.id}`);
      else skipped.push({ agent: item.agent, id: item.id, why: 'a session file with this name is already here' });
    }
    for (const doc of manifest.items.filter(entry => entry.area === 'document')) {
      const to = (record.documents || {})[doc.kind];
      if (to) write(stagedBlob(record, doc), to, doc, null);
    }
    return { files: [...placed], sessions: { carried: carried.size, skipped } };
  }

  // A held task: ask the source. Committed: release the hold. Still open there: commit. Aborted or unknown there: undo here. Unreachable: later.
  async function resolveHeld(input) {
    let record = journal.read(input.id) || input;
    if (record.state !== 'created') return record.state;
    const peer = peerByLink(record.source.link_id);
    let state = null;
    try {
      at('target:before-commit', record);
      const answer = await call(peer, `/v1/task-move/${record.id}/commit`, { method: 'POST', body: { task_id: record.task_id, folder: record.folder }, timeoutMs: 60_000 });
      state = answer && answer.state;
    } catch (error) {
      if (isCrash(error)) throw error;
      if (['MOVE_CANCELLED', 'MOVE_NOT_FOUND', 'MOVE_NOT_OPEN'].includes(error.message) && error.statusCode && error.statusCode < 500) {
        rollbackTarget(record, error);
        return 'aborted';
      }
      schedule(record.id);
      return 'created';
    }
    if (state !== 'committed' && state !== 'done') { schedule(record.id); return 'created'; }
    try {
      at('target:committed', record);
      releaseHold(record);
    } catch (error) {
      if (isCrash(error)) throw error;
      schedule(record.id); // committed on the source: only finishing here is left, tried again (the commit answers 'committed' again)
      return 'created';
    }
    return 'done';
  }

  function releaseHold(record) {
    const marker = `${HOLD_PREFIX}${record.id}`;
    db.prepare('UPDATE tasks SET archived_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE archived_at = ?').run(marker);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(record.staging, 'manifest.json'), 'utf8'));
      const hidden = new Set(manifest.payload.hidden_from || []);
      const denied = peers().filter(peer => peer.instanceId && hidden.has(peer.instanceId)).map(peer => peer.id);
      if (denied.length) visibility.setDenied(record.owner, record.task_id, denied);
    } catch (error) { log.warn(`[task-move] visibility of the moved task: ${codeOf(error)}`); }
    journal.update(record.id, { state: 'done', finished_at: now() });
    fs.rmSync(record.staging, { recursive: true, force: true });
  }

  // Undoes this side of a move that will not be committed: the held rows, the placed folder (a copy: the source has the original), the session files
  // and documents put here, the staging folder.
  function rollbackTarget(record, error) {
    const entry = live.get(record.id);
    if (entry) entry.controller.abort();
    const marker = `${HOLD_PREFIX}${record.id}`;
    db.prepare('DELETE FROM tasks WHERE archived_at = ?').run(marker);
    // The session files and documents put here, and the folders made for them that are empty again (never the agent homes' own folders).
    const homes = agentDirs();
    const keep = new Set([...(homes.claude || []).flatMap(root => [root, path.join(root, 'projects')]), ...(homes.codex || []).flatMap(root => [root, path.join(root, 'sessions'), path.join(root, 'archived_sessions')])].map(dir => path.resolve(dir)));
    const roots = [...(homes.claude || []), ...(homes.codex || [])].map(dir => path.resolve(dir));
    for (const file of record.placed || []) {
      try { fs.unlinkSync(file); } catch { /* gone */ }
      let dir = path.dirname(path.resolve(file));
      while (roots.some(root => inside(dir, root)) && !keep.has(dir)) {
        try { fs.rmdirSync(dir); } catch { break; } // not empty: it was there before, or holds something else
        dir = path.dirname(dir);
      }
    }
    const base = path.resolve(path.dirname(record.staging));
    if (record.folder && path.dirname(path.resolve(record.folder)) === base && fs.existsSync(record.folder) && ['placed', 'created'].includes(record.state)) {
      fs.rmSync(record.folder, { recursive: true, force: true });
    }
    fs.rmSync(record.staging, { recursive: true, force: true });
    journal.update(record.id, { state: 'aborted', error: codeOf(error), reason: reasonOf(error), finished_at: now() });
  }

  function cancelIncoming(tokenId, id) {
    const link = linkOfToken(tokenId);
    const record = journal.isId(id) ? journal.read(id) : null;
    if (!record || record.role !== 'target' || record.source.link_id !== link.id) throw fault('MOVE_NOT_FOUND', 404);
    if (record.state === 'pulling') { rollbackTarget(record, fault('MOVE_CANCELLED')); return { state: 'aborted' }; }
    return { state: record.state }; // a held task is resolved by asking the source, which answers MOVE_CANCELLED
  }

  // ---- Timers, recovery, the sweeper ----
  const timers = new Map();
  function schedule(id) {
    if (timers.has(id) || !retryMs) return;
    const timer = setTimeout(() => {
      timers.delete(id);
      const record = journal.read(id);
      if (record && record.role === 'target' && (record.state === 'created' || record.state === 'placed')) recoverTarget(record).catch(() => schedule(id));
      if (record && record.role === 'source' && record.state === 'committed') { try { finishSource(record); } catch { schedule(id); } }
    }, retryMs);
    if (timer.unref) timer.unref();
    timers.set(id, timer);
  }

  // A target move that stopped after its folder was placed: ask the source. Open there: create what is missing and commit. Committed there: the
  // commit answers 'committed' again and the hold goes. Aborted or unknown there: undo here. No answer: later.
  async function recoverTarget(input) {
    const record = journal.read(input.id) || input;
    if (record.state !== 'placed' && record.state !== 'created') return record.state;
    const peer = peerByLink(record.source.link_id);
    let state = null;
    try { state = (await call(peer, `/v1/task-move/${record.id}`, { timeoutMs: 5000 })).state; } catch (error) {
      if (error && error.statusCode === 404 && error.message === 'MOVE_NOT_FOUND') state = 'unknown';
    }
    if (state === null) { schedule(record.id); return 'waiting'; }
    if (state === 'aborted' || state === 'unknown') { rollbackTarget(record, fault('MOVE_CANCELLED')); return 'aborted'; }
    const manifest = JSON.parse(fs.readFileSync(path.join(record.staging, 'manifest.json'), 'utf8'));
    try { await createAndCommit(record, manifest); } catch (error) {
      if (isCrash(error)) throw error;
      const current = journal.read(record.id);
      if (state !== 'committed' && state !== 'done' && current && TARGET_OPEN.has(current.state)) rollbackTarget(current, error);
      else schedule(record.id);
    }
    return journal.read(record.id).state;
  }

  // At start: every move stopped by a crash is finished or undone (see the head of this file).
  async function recover() {
    const results = [];
    for (const record of journal.all()) {
      try {
        if (record.role === 'source') {
          if (ACTIVE.has(record.state)) { abortSource(record.id, fault('MOVE_INTERRUPTED'), { tell: true }); results.push([record.id, 'aborted']); }
          else if (record.state === 'committed') { lock.add(record.task_id); finishSource(record); results.push([record.id, 'done']); }
        } else if (record.role === 'target') {
          if (record.state === 'pulling') {
            rollbackTarget(record, fault('MOVE_INTERRUPTED'));
            const peer = peerByLink(record.source.link_id);
            if (peer) call(peer, `/v1/task-move/${record.id}/failed`, { method: 'POST', body: { error: 'MOVE_INTERRUPTED' }, timeoutMs: 5000 }).catch(() => {});
            results.push([record.id, 'aborted']);
          } else if (record.state === 'placed' || record.state === 'created') {
            results.push([record.id, await recoverTarget(record)]);
          }
        }
      } catch (error) {
        if (isCrash(error)) throw error;
        log.warn(`[task-move] recovery of ${record.id}: ${codeOf(error)} ${reasonOf(error) || ''}`);
        results.push([record.id, 'error']);
      }
    }
    return results;
  }

  // Old records (done or aborted for 30 days) and old trash (7 days). `at` is the time to sweep at.
  function sweep(atTime = now()) {
    const removed = files.sweepTrash(trashDir, { now: atTime, log });
    for (const record of journal.all()) {
      if (['done', 'aborted'].includes(record.state) && atTime - (record.finished_at || record.started_at || 0) > KEEP_RECORDS_MS) journal.remove(record.id);
    }
    return removed;
  }

  // The watchdog of offered moves: one the target has not touched for idleMs is given up (safe at any time before the commit).
  function watch() {
    for (const record of journal.all()) {
      if (record.role !== 'source' || record.state !== 'offered') continue;
      const entry = live.get(record.id);
      if (!entry || now() - entry.lastSeen > idleMs) abortSource(record.id, fault('MOVE_TARGET_SILENT'), { tell: true });
    }
  }

  let intervals = [];
  async function startService() {
    for (const record of journal.all()) if (record.role === 'source' && (ACTIVE.has(record.state) || record.state === 'committed')) lock.add(record.task_id);
    await recover();
    sweep();
    const a = setInterval(() => sweep(), SWEEP_MS);
    const b = setInterval(() => watch(), 30_000);
    for (const timer of [a, b]) if (timer.unref) timer.unref();
    intervals = [a, b];
  }
  function stop() {
    intervals.forEach(clearInterval);
    intervals = [];
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const entry of live.values()) entry.controller.abort();
  }

  return {
    preview, start, cancel, progress, capacityFor, acceptOffer, manifestFile, blob, noteProgress, peerFailed, statusForPeer, commit, cancelIncoming,
    recover, sweep, watch, startService, stop, journal, trashDir, isHeldTask: isHeld,
    // Tests and the routes: the journal record of a move.
    record: id => journal.read(id),
  };
}

// ---- The one service of this server ----
const lockedTasks = new Set();
const isMoving = taskId => lockedTasks.has(Number(taskId));

let singleton = null;
function getTaskMove() {
  if (singleton) return singleton;
  const db = require('../db');
  const config = require('../config');
  const serviceLinks = require('./service-links').getServiceLinks();
  const workspaceTools = require('./workspace-tools');
  const taskRename = require('./task-rename');
  const terminal = require('../routes/terminal');
  const visibility = require('./task-visibility').getTaskVisibility();
  const DEFAULT_BASE = require('./engine-tasks').DEFAULT_BASE || path.resolve(process.env.TASKS_BASE_DIR || path.join(require('os').homedir(), 'tasks'));
  const base = () => { try { return require('./single-user').ensureSingleUser(db).work_dir || DEFAULT_BASE; } catch { return DEFAULT_BASE; } };
  singleton = createTaskMove({
    db, dataDir: require('../lib/data-home').paths().root,
    identity: () => { const { engine_id: instanceId, name } = require('./engine-identity').getEngineIdentity(); return { instance_id: instanceId, name }; },
    tasksBase: base,
    serviceLinks,
    request: (...args) => require('./remote-client').request(...args),
    isCompany: () => require('./device-tier').getDeviceTier().isCompany(),
    limitBytes: () => config.taskMoveMaxBytes || LIMIT_DEFAULT,
    terminals: {
      live: taskId => terminal.liveTerminalIds(taskId),
      // Terminals whose agent is in the middle of a turn (the activity of a live shell that is not idle or done).
      busy: taskId => Object.values(terminal.activitySnapshot([taskId])[taskId] || {}).filter(state => state === 'running').length,
      close: taskId => terminal.closeTaskTerminals(taskId),
    },
    chat: { busy: taskId => require('./agent-chat').getAgentChat().taskBusy(taskId), stop: taskId => require('./agent-chat').getAgentChat().stopTask(taskId) },
    folderGuard: task => workspaceTools.taskDirectoryGuard(db, task.user_id, task, base()),
    worktreeReason: dir => taskRename.worktreeReason(dir),
    visibility: {
      isDenied: (taskId, linkId) => visibility.isDenied(taskId, linkId),
      deniedLinks: taskId => serviceLinks.ids().filter(linkId => visibility.isDenied(taskId, linkId)),
      setDenied: (login, taskId, denied) => visibility.setDenied(login, taskId, denied),
      forgetTask: taskId => visibility.forgetTask(taskId),
    },
    taskOrder: { replace: (login, oldKey, newKey) => replaceOrderKey(require('./task-order').getTaskOrder(), login, oldKey, newKey) },
    pageState: { recordMove: (login, move) => require('./page-state').getPageState().recordMove(login, move) },
    attention: { repoint: (taskId, to) => repointAttention(db, taskId, to) },
    forgetTask: taskId => terminal.forgetTerminalOrder(taskId),
    lock: { add: taskId => lockedTasks.add(Number(taskId)), delete: taskId => lockedTasks.delete(Number(taskId)) },
  });
  return singleton;
}

// The shared task order keeps the moved task's place: its key is replaced where it stands (services/task-order.js pushes the list to the peers).
function replaceOrderKey(order, login, oldKey, newKey) {
  const current = order.get(login);
  if (!current.order.includes(oldKey)) return false;
  order.setLocal(login, current.order.map(key => (key === oldKey ? newKey : key)).filter((key, index, list) => list.indexOf(key) === index));
  return true;
}

// This engine's T-Attention items whose session was in the moved task: `context.tagent.moved_to` names the new place ({ instance, task_id,
// terminal_id }); task_id and terminal_id stay, so a page that does not know `moved_to` finds no task here and offers the resume command instead
// of opening another task with the same id. Returns the number of items changed.
function repointAttention(db, taskId, to) {
  let rows = [];
  try { rows = db.prepare("SELECT id, context FROM attention_items WHERE context LIKE '%\"tagent\"%'").all(); } catch { return 0; }
  const update = db.prepare('UPDATE attention_items SET context = ? WHERE id = ?');
  let changed = 0;
  for (const row of rows) {
    let context;
    try { context = JSON.parse(row.context); } catch { continue; }
    const tagent = context && context.tagent;
    if (!tagent || String(tagent.task_id) !== String(taskId) || tagent.moved_to) continue;
    tagent.moved_to = { instance: to.instance, task_id: String(to.task_id), terminal_id: tagent.terminal_id == null ? null : String(tagent.terminal_id) };
    update.run(JSON.stringify(context), row.id);
    changed += 1;
  }
  return changed;
}

module.exports = { createTaskMove, getTaskMove, isMoving, replaceOrderKey, repointAttention, swapPath, openStreamDefault, CAPABILITY, HOLD_PREFIX, LIMIT_DEFAULT };
