const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { TerminalSnapshot, createHistoryArchive } = require('../lib/terminal-snapshot');
const { RESET_INPUT_MODES, watchShellReturn } = require('../lib/terminal-input-modes');
const { createActivityTracker } = require('../lib/terminal-activity');
const { createActivityStream } = require('../lib/terminal-activity-stream');
const { repairSpawnHelperPermissions } = require('../lib/node-pty-runtime');
const { utf8LocaleEnv } = require('../lib/terminal-locale');
const { listSessions, startupCommand, newClaudeCommand, runningSubagents, SESSION_ID } = require('../lib/agent-sessions');
const { resolveTerminalUser, userCanEnter, terminalEnvFor } = require('../lib/terminal-user');
const { processCwd, cwdInRoot } = require('../lib/terminal-cwd');

// Sessions are keyed by task ID and terminal ID; omitted IDs use the legacy shell.
const sessions = new Map();
// Close codes the browser uses to tell "someone else is using this terminal" from a lost connection.
const TERMINAL_IN_USE_CLOSE = 4009;
const TERMINAL_TAKEN_CLOSE = 4010;

const MAX_BUFFER = 5 * 1024 * 1024;   // 5MB
// Flow control: pause the PTY while this much output is unsent (socket buffer) or unparsed (headless xterm queue).
const FLOW_HIGH = 1024 * 1024;
const FLOW_LOW = 256 * 1024;
const FLOW_POLL_MS = 20;
const AUTH_CACHE_MS = 1000;            // how long a successful access check is trusted

// Agent hooks (Claude Code / Codex) report activity back through this endpoint.
// The token is an HMAC of task + terminal, so it needs no storage and is only
// ever present in the environment of that terminal's PTY.
const hookSecret = crypto.randomBytes(32);
let hookEndpoint = null;

function setHookEndpoint(url) { hookEndpoint = url; }

function hookToken(taskId, id) {
  return crypto.createHmac('sha256', hookSecret).update(`${Number(taskId)}:${id}`).digest('hex');
}

// Claude terminals follow the session Claude really runs (after /clear, /resume, a fork): Claude is started with
// `--settings "$TA_CLAUDE_SETTINGS"`, a JSON string in the PTY environment that adds one SessionStart hook for that
// process only (the person's own Claude settings and hooks are not touched and still apply). The hook
// (scripts/claude-session-hook.js) posts { session_id, source, cwd } to the hook endpoint with event=session.
const SESSION_HOOK_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'claude-session-hook.js');
const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
function claudeSettings() {
  const command = `${shellQuote(process.execPath)} ${shellQuote(SESSION_HOOK_SCRIPT)} >/dev/null 2>&1 || true`;
  return JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command, timeout: 10 }] }] } });
}

// The command typed for a Claude terminal, with the session hook when the hook endpoint is known (the same condition
// that puts TA_CLAUDE_SETTINGS into the PTY environment).
function withSessionHook(agent, command) {
  if (!command || agent !== 'claude' || !hookEndpoint) return command;
  return `${command} --settings "$TA_CLAUDE_SETTINGS"`;
}

const HOOK_ENV_KEYS = ['TA_HOOK_URL', 'TA_HOOK_TOKEN', 'TA_CLAUDE_SETTINGS'];
// The server's own environment may already hold these (a server started from inside a t-agent terminal): they belong to
// that outer terminal and are never passed on.
function withoutInheritedHookEnv(env) {
  const next = { ...env };
  for (const key of HOOK_ENV_KEYS) delete next[key];
  return next;
}

function hookEnv(taskId, id) {
  if (!hookEndpoint) return {};
  return {
    TA_HOOK_URL: `${hookEndpoint}?task=${Number(taskId)}&terminal=${encodeURIComponent(id)}`,
    TA_HOOK_TOKEN: hookToken(taskId, id),
    TA_CLAUDE_SETTINGS: claudeSettings(),
  };
}

function realDir(dir) {
  try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
}

// Each terminal keeps the directory it was started in (option A of the start-directory change, schema 8): a change of the task's working
// directory only affects terminals created afterwards. task_terminals.work_dir is set when the terminal is created (NULL on a row that has
// none: it follows the task); the default terminal, which has no row, records its directory in task_default_terminal_dirs the first time its
// shell starts (before that it follows the task). Answers the configured directory (null when neither the terminal nor the task has one).
function terminalWorkDir(task, id) {
  const row = id === 'default'
    ? db.prepare('SELECT work_dir FROM task_default_terminal_dirs WHERE task_id = ?').get(task.id)
    : db.prepare('SELECT work_dir FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(task.id, id);
  return (row && row.work_dir) || task.work_dir || null;
}

// event=session: the Claude session the terminal now runs. Only a Claude terminal of this task takes it, only a
// well-formed id, and only one that Claude started in the directory the terminal's shell starts in (its own directory, or the directory
// its live shell really started in when that one was missing and the shell fell back to the task's).
function bindReportedSession(taskId, id, report) {
  if (!report || typeof report !== 'object') return 400;
  const sessionId = report.session_id;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return 400;
  const row = db.prepare('SELECT t.agent, t.agent_session_id, COALESCE(t.work_dir, k.work_dir) AS work_dir FROM task_terminals t JOIN tasks k ON k.id = t.task_id WHERE t.task_id = ? AND t.terminal_id = ?').get(taskId, id);
  if (!row || row.agent !== 'claude') return 404;
  if (typeof report.cwd !== 'string' || !path.isAbsolute(report.cwd)) return 400;
  const live = sessions.get(sessionKey(taskId, id));
  const allowed = [row.work_dir || os.homedir(), live && live.startDir].filter(Boolean).map(realDir);
  if (!allowed.includes(realDir(report.cwd))) return 400;
  if (row.agent_session_id !== sessionId) {
    db.prepare('UPDATE task_terminals SET agent_session_id = ? WHERE task_id = ? AND terminal_id = ?').run(sessionId, taskId, id);
    activityStream.notify(); // the sub-agent count now follows the new session
  }
  return 204;
}

/** Handles one hook report; returns an HTTP status code. `body` is the parsed JSON body (event=session only). */
function reportHook(taskId, requestedTerminalId, token, event, body) {
  let id;
  try { id = terminalId(requestedTerminalId); } catch { return 400; }
  const expected = Buffer.from(hookToken(taskId, id));
  const given = Buffer.from(String(token || ''));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return 403;
  if (event === 'session') return bindReportedSession(Number(taskId), id, body);
  const session = sessions.get(sessionKey(taskId, id));
  if (!session || !session.activity) return 404;
  return session.activity.report(event) ? 204 : 400;
}

function terminalId(value) {
  const id = value == null ? 'default' : value;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    throw Object.assign(new Error('INVALID_TERMINAL_ID'), { statusCode: 400 });
  }
  return id;
}

function sessionKey(taskId, id = 'default') { return `${Number(taskId)}:${id}`; }

function defaultRemoved(taskId) {
  return Boolean(db.prepare('SELECT 1 FROM task_default_terminal_removed WHERE task_id = ?').get(taskId));
}

function assertTerminal(taskId, value) {
  const id = terminalId(value);
  const exists = id === 'default'
    ? !defaultRemoved(taskId)
    : db.prepare('SELECT 1 FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(taskId, id);
  if (!exists) {
    throw Object.assign(new Error('TERMINAL_NOT_FOUND'), { statusCode: 404 });
  }
  return id;
}

const MAX_TERMINAL_TITLE = 40;

// Every open page (computer or phone) and other Clients share the same terminals; only one client at a time may be attached to each (see handleWs).
// Terminals whose ids start with "h5-" were phone-only shells from earlier versions: they are no longer listed.

// Agent terminals show the name of their session (unless the person named the terminal: title_custom), read from the agent's own files on every listing so a rename done inside Claude / Codex follows.
// A Codex session only gets an id once it has a first message, so it is bound here: the oldest unbound Codex terminal takes the oldest unclaimed
// session of the terminal's own directory that started after the terminal did. Sessions are read per directory: each terminal keeps the
// directory it was started in (terminalWorkDir), which may differ from the task's current one.
function withAgentSessions(taskId, rows) {
  const meta = db.prepare("SELECT t.terminal_id, t.agent, t.agent_session_id, t.agent_started_at, t.title_custom, COALESCE(t.work_dir, k.work_dir) AS work_dir FROM task_terminals t JOIN tasks k ON k.id = t.task_id WHERE t.task_id = ? AND t.agent IS NOT NULL ORDER BY t.rowid").all(taskId);
  if (!meta.length) return rows;
  const lists = new Map();
  const sessionsOf = (agent, dir) => {
    const key = `${agent}\0${dir || ''}`;
    if (!lists.has(key)) lists.set(key, listSessions(agent, dir, undefined, 200));
    return lists.get(key);
  };
  const claimed = new Set(meta.map(item => item.agent_session_id).filter(Boolean));
  const info = new Map(meta.map(item => [item.terminal_id, item]));
  for (const item of meta) {
    if (item.agent_session_id || item.agent !== 'codex') continue;
    const found = sessionsOf('codex', item.work_dir).filter(row => !claimed.has(row.id) && row.started_at >= item.agent_started_at - 2000).sort((x, y) => x.started_at - y.started_at)[0];
    if (!found) continue;
    claimed.add(found.id);
    item.agent_session_id = found.id;
    db.prepare('UPDATE task_terminals SET agent_session_id = ? WHERE task_id = ? AND terminal_id = ?').run(found.id, taskId, item.terminal_id);
  }
  return rows.map(row => {
    const item = info.get(row.terminal_id);
    if (!item) return row;
    if (item.title_custom) return { ...row, agent: item.agent }; // a name the person gave (at creation or by a rename) wins over the session's name
    const session = item.agent_session_id && sessionsOf(item.agent, item.work_dir).find(entry => entry.id === item.agent_session_id);
    return { ...row, agent: item.agent, title: session ? session.title : row.title };
  });
}

// Each row also has work_dir: the terminal's own directory (terminalWorkDir), so the page can resolve file links against it and show it
// when it is not the task's current one.
function listTerminals(taskId) {
  const stored = db.prepare('SELECT title FROM task_default_terminal_titles WHERE task_id = ?').get(taskId);
  const task = db.prepare('SELECT id, work_dir FROM tasks WHERE id = ?').get(taskId) || { id: taskId, work_dir: null };
  const defaultDir = defaultRemoved(taskId) ? null : terminalWorkDir(task, 'default');
  return withAgentSessions(taskId, [...(defaultRemoved(taskId) ? [] : [{ terminal_id: 'default', title: stored ? stored.title : 'Terminal 1', work_dir: defaultDir }]), ...db.prepare(
    "SELECT terminal_id, title, work_dir FROM task_terminals WHERE task_id = ? AND substr(terminal_id, 1, 3) != 'h5-' ORDER BY rowid"
  ).all(taskId).map(row => ({ ...row, work_dir: row.work_dir || task.work_dir || null }))]);
}

// A terminal created for an agent session types its command once, when its shell is first spawned.
const pendingStartup = new Map();
const AGENT_LABELS = { claude: 'Claude', codex: 'Codex' };

// A terminal name as the person typed it: control characters and runs of whitespace become one space, the ends are trimmed. Any script is kept.
function cleanTitle(value) {
  const title = String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (title.length > MAX_TERMINAL_TITLE) throw Object.assign(new Error('TERMINAL_TITLE_TOO_LONG'), { statusCode: 400 });
  return title;
}

// options.title: an optional name, validated like a rename and kept like one (title_custom); empty keeps the default "Terminal N" / "Claude N".
function createTerminal(taskId, options = {}) {
  const id = require('crypto').randomUUID();
  const agent = options && options.agent;
  const named = cleanTitle(options && typeof options.title === 'string' ? options.title : '');
  let sessionId = options && options.session_id ? String(options.session_id) : null;
  let command = startupCommand(agent, sessionId);
  if (command && !sessionId && agent === 'claude') {
    sessionId = crypto.randomUUID();
    command = newClaudeCommand(sessionId);
  }
  const count = listTerminals(taskId).length + 1;
  const title = named || (command ? `${AGENT_LABELS[agent]} ${count}` : `Terminal ${count}`);
  if (command) pendingStartup.set(sessionKey(taskId, id), withSessionHook(agent, command));
  // The terminal keeps the task's working directory of this moment, whatever the task's directory becomes later.
  const task = db.prepare('SELECT work_dir FROM tasks WHERE id = ?').get(taskId);
  const workDir = (task && task.work_dir) || null;
  db.prepare('INSERT INTO task_terminals (task_id, terminal_id, title, agent, agent_session_id, agent_started_at, title_custom, work_dir) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(taskId, id, title, command ? agent : null, sessionId, command ? Date.now() : null, named ? 1 : null, workDir);
  return { terminal_id: id, title, agent: command ? agent : null, work_dir: workDir };
}

// A new shell for an agent terminal that was closed or restarted resumes the session it is bound to.
// A Claude session that never got a message has no file to resume, and a Codex session that was never bound starts fresh.
// `workDir` is the directory the new shell starts in (the terminal's own directory), where the agent looks for the session.
function reopenCommand(taskId, id, workDir) {
  const row = id === 'default' ? null : db.prepare('SELECT agent, agent_session_id FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(taskId, id);
  if (!row || !row.agent) return null;
  if (!row.agent_session_id) {
    withAgentSessions(taskId, [{ terminal_id: id, title: '' }]); // binds a Codex session that has appeared since
    const bound = db.prepare('SELECT agent_session_id FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(taskId, id);
    row.agent_session_id = bound && bound.agent_session_id;
  }
  if (!row.agent_session_id) return withSessionHook(row.agent, startupCommand(row.agent));
  const exists = listSessions(row.agent, workDir, undefined, 200).some(entry => entry.id === row.agent_session_id);
  if (exists) return withSessionHook(row.agent, startupCommand(row.agent, row.agent_session_id));
  return withSessionHook(row.agent, row.agent === 'claude' ? newClaudeCommand(row.agent_session_id) : startupCommand(row.agent));
}

// Sessions of an agent CLI that were run in the task's working directory (newest first). A new terminal starts there, so the list of
// sessions to resume is read from the task's current directory.
function listAgentSessions(task, agent) {
  return listSessions(agent, task && task.work_dir);
}

// The live current directory of a terminal's shell, for file links (read-only). `task` has work_dir / md_path. Answers
// { cwd, relative }: cwd null when no shell runs (or it cannot be read), relative null when the directory is outside the terminal's root (real
// paths, so a symbolic link out of the root is outside). The root is the terminal's own directory (terminalWorkDir; the task's when it has none).
// The browser then resolves relative paths against that directory, or opens nothing when outside.
async function terminalCwd(task, value) {
  const id = assertTerminal(task.id, value);
  const s = sessions.get(sessionKey(task.id, id));
  const cwd = s && s.pty && !s.startupError ? await processCwd(s.pty.pid) : null;
  if (!cwd) return { cwd: null, relative: null };
  const configured = terminalWorkDir(task, id) || (task.md_path && path.dirname(task.md_path));
  return { cwd, relative: configured && path.isAbsolute(configured) ? cwdInRoot(cwd, configured) : null };
}

function renameTerminal(taskId, value, requestedTitle) {
  const id = assertTerminal(taskId, value);
  const title = cleanTitle(requestedTitle);
  if (!title) throw Object.assign(new Error('TERMINAL_TITLE_REQUIRED'), { statusCode: 400 });
  if (id === 'default') {
    db.prepare(`
      INSERT INTO task_default_terminal_titles (task_id, title) VALUES (?, ?)
      ON CONFLICT(task_id) DO UPDATE SET title = excluded.title
    `).run(taskId, title);
  } else {
    db.prepare('UPDATE task_terminals SET title = ?, title_custom = 1 WHERE task_id = ? AND terminal_id = ?').run(title, taskId, id);
  }
  return { terminal_id: id, title };
}

// The history is a list of chunks, so a PTY chunk is an O(1) push. Whole chunks
// are dropped from the front once the total is well above the limit; the exact
// MAX_BUFFER cut is made only when the text is read (snapshot archive). The history lives in memory only; it is never written to the database.
function bufferText(s) {
  if (s.chunks.length !== 1) s.chunks = [s.chunks.join('')];
  if (s.chunks[0].length > MAX_BUFFER) s.chunks[0] = s.chunks[0].slice(s.chunks[0].length - MAX_BUFFER);
  s.size = s.chunks[0].length;
  return s.chunks[0];
}

function appendBuffer(taskId, data) {
  const s = sessions.get(taskId);
  if (!s) return;
  s.chunks.push(data);
  s.size += data.length;
  if (s.size > MAX_BUFFER * 1.25) {
    let drop = 0;
    while (drop < s.chunks.length - 1 && s.size - s.chunks[drop].length >= MAX_BUFFER) s.size -= s.chunks[drop++].length;
    s.chunks.splice(0, drop);
  }
}

function getOrCreateSession(ownerTaskId, workDir, dirWarning, id = 'default') {
  const taskId = sessionKey(ownerTaskId, id);
  if (sessions.has(taskId)) return sessions.get(taskId);

  // The history is not persisted: after a service restart (or a close / restart) a terminal starts empty with a new shell.
  // No old text is replayed, so the stale mouse/focus mode reset of a restored history is not needed here.
  const savedBuffer = dirWarning || '';

  let pty;
  let shell;
  try {
    repairSpawnHelperPermissions(path.resolve(__dirname, '..'));
    const nodePty = require('node-pty');
    // A LaunchAgent starts with a slim PATH, so add the common paths by hand to make sure node/brew/tools are available
    const fullPath = [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      process.env.PATH,
    ].filter(Boolean).join(':');
    // macOS usually uses zsh while Linux servers often only have bash/sh. Pick the shell that
    // actually exists, so node-pty does not fail to start because the fixed /bin/zsh path is missing.
    shell = ['/bin/zsh', '/bin/bash', '/bin/sh'].find(candidate => fs.existsSync(candidate));
    if (!shell) throw new Error('No usable shell found (/bin/zsh, /bin/bash, /bin/sh)');

    // When the service runs as root, drop to TERMINAL_USER (default dev), otherwise Claude Code refuses the mode that skips permission prompts.
    const dropped = resolveTerminalUser();
    if (!dropped.user && (dropped.reason === 'missing-explicit' || dropped.reason === 'missing-default')) {
      console.warn(`[terminal] terminal user ${dropped.name} does not exist; the terminal still runs as the service user (root). Create that user or set TERMINAL_USER= in .env to silence this message`);
    }
    const runAs = dropped.user;
    let cwd = workDir || os.homedir();
    if (runAs && !userCanEnter(cwd, runAs)) {
      console.warn(`[terminal] user ${runAs.name} cannot enter ${cwd}; the terminal starts from its home directory ${runAs.home} instead. Adjust the owner or permissions of that directory`);
      cwd = runAs.home;
    }
    pty = nodePty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      cwd,
      ...(runAs ? { uid: runAs.uid, gid: runAs.gid } : {}),
      env: {
        ...withoutInheritedHookEnv(runAs ? { ...terminalEnvFor(runAs, process.env), SHELL: shell } : process.env),
        TERM: 'xterm-256color',
        PATH: fullPath,
        // Pick UTF-8 from the locales actually installed on this machine (C.UTF-8 / en_US / zh_CN ...),
        // otherwise zsh shows Chinese directory names as \M-^ garbage.
        ...utf8LocaleEnv(process.env),
        ...hookEnv(ownerTaskId, id),
      },
    });
  } catch (e) {
    console.error('[terminal] node-pty spawn error:', e.message, '\ncwd:', workDir, '\nenv.HOME:', process.env.HOME);
    return { startupError: e };
  }

  const startup = pendingStartup.get(taskId) || reopenCommand(ownerTaskId, id, workDir);
  pendingStartup.delete(taskId);
  if (startup) pty.write(`${startup}\r`);

  const s = {
    taskId: ownerTaskId,
    terminalId: id,
    pty,
    chunks: [savedBuffer],
    size: savedBuffer.length,
    get buffer() { return bufferText(this); },
    ws: null,
    snapshot: new TerminalSnapshot(),
    ready: false,
    startDir: workDir, // the directory this shell was started in (the hook check also accepts it)
  };
  sessions.set(taskId, s);
  s.snapshot.write(savedBuffer);

  // Backpressure: bytes the browser socket has not sent yet plus bytes the parser has not consumed.
  const backlog = () => (s.ws && s.ws.readyState === 1 ? s.ws.bufferedAmount || 0 : 0) + s.snapshot.pendingBytes;
  const stopFlowWatch = () => { clearInterval(s.flowTimer); s.flowTimer = null; };
  s.stopFlowWatch = stopFlowWatch;
  const updateFlow = () => {
    if (s.flowTimer || sessions.get(taskId) !== s || backlog() <= FLOW_HIGH || typeof pty.pause !== 'function') return;
    try { pty.pause(); } catch { return; }
    // A closed socket reports no backlog, so a socket that dies while paused also ends the pause.
    s.flowTimer = setInterval(() => {
      const gone = sessions.get(taskId) !== s;
      if (!gone && backlog() > FLOW_LOW) return;
      stopFlowWatch();
      if (!gone) { try { pty.resume(); } catch {} }
    }, FLOW_POLL_MS);
  };
  const deliver = batch => {
    if (s.ready && s.ws && s.authorized && s.authorized()) s.ws.send(batch);
    updateFlow();
  };
  const emit = data => {
    if (sessions.get(taskId) !== s) return;
    appendBuffer(taskId, data);
    s.snapshot.write(data, deliver);
    updateFlow();
  };
  pty.onData(data => {
    s.activity?.noteOutput();
    emit(data);
  });
  // Also goes through the history buffer so replays do not re-enable mouse reporting.
  s.stopShellWatch = watchShellReturn(pty, shell, () => emit(RESET_INPUT_MODES));
  s.activity = createActivityTracker(pty, shell, () => activityStream.notify());

  pty.onExit(() => {
    // The parser queue also owns live delivery. Drain its last bytes before
    // closing a naturally exited shell; explicit control remains immediate.
    s.exiting = true;
    stopFlowWatch();
    s.stopShellWatch();
    s.activity.stop();
    s.snapshot.enqueue(() => {
      if (sessions.get(taskId) !== s) return;
      sessions.delete(taskId);
      activityStream.notify(); // a terminal that ends is idle from now on
      s.snapshot.dispose();
      const activeWs = s.ws;
      s.ws = null;
      if (activeWs && activeWs.readyState === 1) activeWs.close(1000, 'terminal exited');
    });
  });

  return s;
}

/**
 * Terminate the task's server-side PTY. restart-workdir: the next connection creates a brand-new shell in the
 * terminal's own directory (terminalWorkDir: the task work_dir when the terminal was created); close also ends the shell (the history lives in memory only, so every action leaves the next terminal empty); delete also removes the terminal record (the default terminal is marked removed instead).
 */
function controlSession(taskId, action, requestedTerminalId) {
  const id = Number.parseInt(taskId, 10);
  if (!id || !['close', 'restart-workdir', 'delete'].includes(action)) {
    const error = new Error('INVALID_TERMINAL_ACTION');
    error.statusCode = 400;
    throw error;
  }

  const selectedId = assertTerminal(id, requestedTerminalId);
  const key = sessionKey(id, selectedId);
  const session = sessions.get(key);
  if (session) {
    sessions.delete(key);
    activityStream.notify();
    session.snapshot.dispose();
    session.stopShellWatch?.();
    session.stopFlowWatch?.();
    session.activity?.stop();

    const activeWs = session.ws;
    session.ws = null;
    try { session.pty.kill(); } catch {}
    if (activeWs && activeWs.readyState === 1) activeWs.close(1000, `terminal ${action}`);
  }

  if (action === 'delete' && selectedId === 'default') {
    db.prepare('INSERT OR IGNORE INTO task_default_terminal_removed (task_id) VALUES (?)').run(id);
    db.prepare('DELETE FROM task_default_terminal_titles WHERE task_id = ?').run(id);
    db.prepare('DELETE FROM task_default_terminal_dirs WHERE task_id = ?').run(id);
  } else if (action === 'delete') {
    db.prepare('DELETE FROM task_terminals WHERE task_id = ? AND terminal_id = ?').run(id, selectedId);
  }
  return { success: true, action, had_session: Boolean(session) };
}

/**
 * Handle WebSocket upgrade for /terminal/ws?taskId=:id
 * Called from server.js with (ws, req, sessionData)
 */
function handleWs(ws, req, sessionUser, requestedTaskId = null, requestedTerminalId = null) {
  const taskId = parseInt(requestedTaskId || new URL(req.url, 'http://x').searchParams.get('taskId'));
  if (!taskId) { ws.close(1008, 'missing taskId'); return; }

  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(taskId, sessionUser.login);
  if (!task) {
    console.error('[terminal] task not found, taskId:', taskId, 'user:', sessionUser.login);
    ws.send('\r\n\x1b[31m[Task does not exist or access denied]\x1b[0m\r\n');
    ws.close(1008, 'task not found');
    return;
  }

  let selectedId;
  try {
    selectedId = assertTerminal(taskId, requestedTerminalId ?? new URL(req.url, 'http://x').searchParams.get('terminalId'));
  } catch (error) {
    ws.close(1008, error.message);
    return;
  }
  const key = sessionKey(taskId, selectedId);
  // The shell starts in the terminal's own directory. When that one is gone (and it is not the task's current one), the task's directory is
  // used; when that is missing too, $HOME. Each fallback is logged and shown in the terminal.
  const ownDir = terminalWorkDir(task, selectedId) || os.homedir();
  let actualDir = ownDir;
  let dirWarning = null;
  if (!sessions.has(key) && !fs.existsSync(ownDir)) {
    const taskDir = task.work_dir || os.homedir();
    if (taskDir !== ownDir && fs.existsSync(taskDir)) {
      actualDir = taskDir;
      console.warn(`[terminal] the directory of terminal ${selectedId} of task ${taskId} does not exist (${ownDir}); its shell starts in the task's working directory ${taskDir}`);
      dirWarning = `\r\n\x1b[33m[⚠ Session directory does not exist: ${ownDir}]\x1b[0m\r\n\x1b[33m[Started in the task's working directory ${taskDir}]\x1b[0m\r\n\r\n`;
    } else {
      actualDir = os.homedir();
      dirWarning = `\r\n\x1b[33m[⚠ Working directory does not exist: ${ownDir}]\x1b[0m\r\n\x1b[33m[Fell back to ${actualDir}; edit the task to update the working path]\x1b[0m\r\n\r\n`;
    }
  }
  // The default terminal has no row: it keeps the directory its shell first started in from now on.
  if (selectedId === 'default' && !sessions.has(key) && task.work_dir && actualDir === task.work_dir) {
    db.prepare('INSERT OR IGNORE INTO task_default_terminal_dirs (task_id, work_dir) VALUES (?, ?)').run(taskId, task.work_dir);
  }
  const s = getOrCreateSession(taskId, actualDir, dirWarning, selectedId);
  if (s.startupError) {
    const details = String(s.startupError.message || 'unknown error')
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .slice(0, 500);
    ws.send(`\r\n\x1b[31m[Terminal failed to start]\x1b[0m\r\n${details}\r\n`);
    ws.close();
    return;
  }

  // One client owns a terminal at a time. A different client is refused until it asks to take over;
  // the same client (page refresh, reconnect after a dropped network) simply replaces its old socket.
  const query = new URL(req.url, 'http://x').searchParams;
  const clientId = (query.get('clientId') || '').slice(0, 64);
  const takeover = query.get('takeover') === '1';
  if (s.ws && s.ws.readyState === 1) {
    const sameClient = Boolean(clientId) && s.wsClientId === clientId;
    if (!sameClient && !takeover) {
      ws.close(TERMINAL_IN_USE_CLOSE, 'terminal in use');
      return;
    }
    s.ws.close(sameClient ? 1000 : TERMINAL_TAKEN_CLOSE, sameClient ? 'replaced by new connection' : 'terminal taken over');
  }
  s.ws = ws;
  s.wsClientId = clientId;

  s.ready = false;
  // proto=2: control messages are binary frames; every text frame is terminal input (see public/js/terminal-protocol.js).
  const binaryControl = query.get('proto') === '2';
  const sendControl = message => ws.send(binaryControl ? Buffer.from(JSON.stringify(message)) : JSON.stringify(message));
  // Drop connections that vanished without a close (a phone that went to sleep), so they do not keep the terminal owned.
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const aliveTimer = setInterval(() => {
    if (!alive) { ws.terminate(); return; }
    alive = false;
    try { ws.ping(); } catch { /* closing */ }
  }, 30000);
  aliveTimer.unref?.();
  ws.on('close', () => clearInterval(aliveTimer));
  const archive = createHistoryArchive(s.buffer);
  let checkedAt = 0;
  const authorized = () => {
    if (ws.readyState !== 1 || sessions.get(key) !== s || s.ws !== ws) return false;
    // The database and session checks run at most once per AUTH_CACHE_MS, not per PTY chunk.
    const now = Date.now();
    if (checkedAt && now - checkedAt < AUTH_CACHE_MS) return true;
    if (req.sessionID && !require('../services/client-auth').getClientAuth().sessionActive(req.sessionID)) {
      ws.close(1008, 'Authentication required');
      return false;
    }
    if (!db.prepare('SELECT 1 FROM tasks WHERE id = ? AND user_id = ?').get(taskId, sessionUser.login)) {
      ws.close(1008, 'task not found');
      return false;
    }
    checkedAt = now;
    return true;
  };
  s.authorized = authorized;
  s.snapshot.snapshot(snapshot => {
    if (!authorized()) return;
    sendControl({ type: 'history', ...snapshot, archive: archive.metadata() });
    s.ready = true;
  });

  // Returns true when the message was a control message and must not reach the shell.
  const handleControl = data => {
    if (!data || typeof data.type !== 'string') return false;
    if (data.type.startsWith('history')) {
      if (data.type === 'history-page') sendControl(archive.page(data));
      return true;
    }
    if (data.type === 'ping' && binaryControl) { sendControl({ type: 'pong' }); return true; }
    if (data.type === 'resize') {
      if (!Number.isInteger(data.cols) || !Number.isInteger(data.rows) || data.cols < 1 || data.rows < 1 || data.cols > 1000 || data.rows > 1000) return true;
      s.activity?.noteInput();
      s.pty.resize(data.cols, data.rows);
      s.snapshot.resize(data.cols, data.rows);
      return true;
    }
    return false;
  };

  ws.on('message', (msg, isBinary) => {
    if (!authorized()) return;
    const str = msg.toString();
    if (binaryControl) {
      // Only binary frames are control messages; text is always terminal input, whatever it looks like.
      if (isBinary) {
        try { handleControl(JSON.parse(str)); } catch { /* malformed control: ignore */ }
        return;
      }
    } else if (/^\s*\{/.test(str)) {
      // Old clients: control messages are text frames. Only try messages starting with '{' (digits are valid JSON too).
      try {
        if (handleControl(JSON.parse(str))) return;
      } catch {
        // Malformed history controls must never become shell input.
        if (/\"type\"\s*:\s*\"history/.test(str)) return;
      }
    }
    if (!s.exiting) {
      s.activity?.noteInput();
      s.pty.write(str);
    }
  });

  ws.on('close', () => {
    if (s.ws === ws) {
      s.ws = null;
    }
  });

  ws.on('error', (err) => {
    console.error('[terminal] ws error:', err.message);
  });
}

/** Activity of every live terminal of the given tasks: { [taskId]: { [terminalId]: state } }. */
function activitySnapshot(taskIds) {
  const result = {};
  for (const taskId of taskIds) {
    for (const item of listTerminals(taskId)) {
      const session = sessions.get(sessionKey(taskId, item.terminal_id));
      const state = session && session.activity ? session.activity.state() : 'idle';
      if (state === 'idle') continue;
      (result[taskId] ||= {})[item.terminal_id] = state;
    }
  }
  return result;
}

/** Running sub-agents of the live Claude terminals of the given tasks: { [taskId]: { [terminalId]: count } } (terminals with none are left out).
 *  Only a terminal whose shell is alive and that is bound to a Claude session (agent_session_id) can have one; see runningSubagents. */
function subagentSnapshot(taskIds, home) {
  const result = {};
  const wanted = taskIds ? new Set(taskIds.map(String)) : null; // null: every task (the push stream's shared refresh)
  // The sub-agent logs live under the directory the terminal's Claude runs in (its own directory, not the task's current one).
  const rows = db.prepare("SELECT t.task_id, t.terminal_id, t.agent_session_id, COALESCE(t.work_dir, k.work_dir) AS work_dir FROM task_terminals t JOIN tasks k ON k.id = t.task_id WHERE t.agent = 'claude' AND t.agent_session_id IS NOT NULL").all();
  for (const row of rows) {
    const live = sessions.get(sessionKey(row.task_id, row.terminal_id));
    if ((wanted && !wanted.has(String(row.task_id))) || !live) continue;
    const count = runningSubagents(live.startDir || row.work_dir, row.agent_session_id, home);
    if (count) (result[row.task_id] ||= {})[row.terminal_id] = count;
  }
  return result;
}

// Pushed activity (lib/terminal-activity-stream.js): GET /api/tasks/terminal-activity/stream and Engine /v1/terminal-activity/stream.
// The sub-agent counts of all live Claude terminals are read once per refresh, whatever the number of open streams.
// The agent chat counters of the owner travel with it (required when used: services/agent-chat is not loaded before a stream opens).
const agentChat = () => require('../services/agent-chat').getAgentChat();
const activityStream = createActivityStream({
  activity: activitySnapshot,
  subagents: () => subagentSnapshot(null),
  agents: owner => agentChat().summary(owner),
  watchAgents: listener => agentChat().onSummaryChange(listener),
});
function serveActivityStream(req, res, taskIds, owner) { activityStream.serve(req, res, taskIds, owner); }

function acknowledgeActivity(taskId, requestedTerminalId) {
  const id = assertTerminal(taskId, requestedTerminalId);
  const session = sessions.get(sessionKey(taskId, id));
  if (session && session.activity) session.activity.acknowledge();
  return { success: true };
}

function closeTaskTerminals(taskId) {
  // Legacy phone-only shells are not listed any more, but one may still be running.
  const phone = db.prepare("SELECT terminal_id FROM task_terminals WHERE task_id = ? AND substr(terminal_id, 1, 3) = 'h5-'").all(taskId);
  for (const item of [...listTerminals(taskId), ...phone]) controlSession(taskId, 'close', item.terminal_id);
}

module.exports = { terminalWorkDir, setHookEndpoint, reportHook, activitySnapshot, subagentSnapshot, serveActivityStream, acknowledgeActivity, controlSession, handleWs, listTerminals, createTerminal, listAgentSessions, reopenCommand, renameTerminal, terminalCwd, assertTerminal, closeTaskTerminals };
