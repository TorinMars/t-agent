const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { TerminalSnapshot, createHistoryArchive } = require('../lib/terminal-snapshot');
const { RESET_INPUT_MODES, watchShellReturn } = require('../lib/terminal-input-modes');
const { createActivityTracker } = require('../lib/terminal-activity');
const { repairSpawnHelperPermissions } = require('../lib/node-pty-runtime');
const { utf8LocaleEnv } = require('../lib/terminal-locale');
const { listSessions, startupCommand, newClaudeCommand } = require('../lib/agent-sessions');
const { resolveTerminalUser, userCanEnter, terminalEnvFor } = require('../lib/terminal-user');

// Sessions are keyed by task ID and terminal ID; omitted IDs use the legacy shell.
const sessions = new Map();
// Close codes the browser uses to tell "someone else is using this terminal" from a lost connection.
const TERMINAL_IN_USE_CLOSE = 4009;
const TERMINAL_TAKEN_CLOSE = 4010;

const MAX_BUFFER = 5 * 1024 * 1024;   // 5MB
const FLUSH_INTERVAL = 5000;           // 5s
const FLUSH_SIZE = 50 * 1024;          // 50KB

// Agent hooks (Claude Code / Codex) report activity back through this endpoint.
// The token is an HMAC of task + terminal, so it needs no storage and is only
// ever present in the environment of that terminal's PTY.
const hookSecret = crypto.randomBytes(32);
let hookEndpoint = null;

function setHookEndpoint(url) { hookEndpoint = url; }

function hookToken(taskId, id) {
  return crypto.createHmac('sha256', hookSecret).update(`${Number(taskId)}:${id}`).digest('hex');
}

function hookEnv(taskId, id) {
  if (!hookEndpoint) return {};
  return {
    TA_HOOK_URL: `${hookEndpoint}?task=${Number(taskId)}&terminal=${encodeURIComponent(id)}`,
    TA_HOOK_TOKEN: hookToken(taskId, id),
  };
}

/** Handles one hook report; returns an HTTP status code. */
function reportHook(taskId, requestedTerminalId, token, event) {
  let id;
  try { id = terminalId(requestedTerminalId); } catch { return 400; }
  const expected = Buffer.from(hookToken(taskId, id));
  const given = Buffer.from(String(token || ''));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return 403;
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

function assertTerminal(taskId, value) {
  const id = terminalId(value);
  if (id !== 'default' && !db.prepare('SELECT 1 FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(taskId, id)) {
    throw Object.assign(new Error('TERMINAL_NOT_FOUND'), { statusCode: 404 });
  }
  return id;
}

const MAX_TERMINAL_TITLE = 40;

// Phone (H5) and desktop share the same terminals; only one client at a time may be attached to each (see handleWs).
// Terminals whose ids start with "h5-" were phone-only shells from earlier versions: they are no longer listed.

// Agent terminals show the name of their session, read from the agent's own files on every listing so a rename done inside Claude / Codex follows.
// A Codex session only gets an id once it has a first message, so it is bound here: the oldest unbound Codex terminal takes the oldest unclaimed
// session of the task directory that started after the terminal did.
function withAgentSessions(taskId, rows) {
  const meta = db.prepare("SELECT terminal_id, agent, agent_session_id, agent_started_at FROM task_terminals WHERE task_id = ? AND agent IS NOT NULL ORDER BY rowid").all(taskId);
  if (!meta.length) return rows;
  const task = db.prepare('SELECT work_dir FROM tasks WHERE id = ?').get(taskId);
  const dir = task && task.work_dir;
  const byAgent = {};
  const sessionsOf = agent => (byAgent[agent] ||= listSessions(agent, dir, undefined, 200));
  const claimed = new Set(meta.map(item => item.agent_session_id).filter(Boolean));
  const info = new Map(meta.map(item => [item.terminal_id, item]));
  for (const item of meta) {
    if (item.agent_session_id || item.agent !== 'codex') continue;
    const found = sessionsOf('codex').filter(row => !claimed.has(row.id) && row.started_at >= item.agent_started_at - 2000).sort((x, y) => x.started_at - y.started_at)[0];
    if (!found) continue;
    claimed.add(found.id);
    item.agent_session_id = found.id;
    db.prepare('UPDATE task_terminals SET agent_session_id = ? WHERE task_id = ? AND terminal_id = ?').run(found.id, taskId, item.terminal_id);
  }
  return rows.map(row => {
    const item = info.get(row.terminal_id);
    if (!item) return row;
    const session = item.agent_session_id && sessionsOf(item.agent).find(entry => entry.id === item.agent_session_id);
    return { ...row, agent: item.agent, title: session ? session.title : row.title };
  });
}

function listTerminals(taskId) {
  const stored = db.prepare('SELECT title FROM task_default_terminal_titles WHERE task_id = ?').get(taskId);
  return withAgentSessions(taskId, [{ terminal_id: 'default', title: stored ? stored.title : 'Terminal 1' }, ...db.prepare(
    "SELECT terminal_id, title FROM task_terminals WHERE task_id = ? AND substr(terminal_id, 1, 3) != 'h5-' ORDER BY rowid"
  ).all(taskId)]);
}

// A terminal created for an agent session types its command once, when its shell is first spawned.
const pendingStartup = new Map();
const AGENT_LABELS = { claude: 'Claude', codex: 'Codex' };

function createTerminal(taskId, options = {}) {
  const id = require('crypto').randomUUID();
  const agent = options && options.agent;
  let sessionId = options && options.session_id ? String(options.session_id) : null;
  let command = startupCommand(agent, sessionId);
  if (command && !sessionId && agent === 'claude') {
    sessionId = crypto.randomUUID();
    command = newClaudeCommand(sessionId);
  }
  const count = listTerminals(taskId).length + 1;
  const title = command ? `${AGENT_LABELS[agent]} ${count}` : `Terminal ${count}`;
  if (command) pendingStartup.set(sessionKey(taskId, id), command);
  db.prepare('INSERT INTO task_terminals (task_id, terminal_id, title, agent, agent_session_id, agent_started_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(taskId, id, title, command ? agent : null, sessionId, command ? Date.now() : null);
  return { terminal_id: id, title, agent: command ? agent : null };
}

// A new shell for an agent terminal that was closed or restarted resumes the session it is bound to.
// A Claude session that never got a message has no file to resume, and a Codex session that was never bound starts fresh.
function reopenCommand(taskId, id, workDir) {
  const row = id === 'default' ? null : db.prepare('SELECT agent, agent_session_id FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(taskId, id);
  if (!row || !row.agent) return null;
  if (!row.agent_session_id) {
    withAgentSessions(taskId, [{ terminal_id: id, title: '' }]); // binds a Codex session that has appeared since
    const bound = db.prepare('SELECT agent_session_id FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(taskId, id);
    row.agent_session_id = bound && bound.agent_session_id;
  }
  if (!row.agent_session_id) return startupCommand(row.agent);
  const exists = listSessions(row.agent, workDir, undefined, 200).some(entry => entry.id === row.agent_session_id);
  if (exists) return startupCommand(row.agent, row.agent_session_id);
  return row.agent === 'claude' ? newClaudeCommand(row.agent_session_id) : startupCommand(row.agent);
}

// Sessions of an agent CLI that were run in the task's working directory (newest first).
function listAgentSessions(task, agent) {
  return listSessions(agent, task && task.work_dir);
}

function renameTerminal(taskId, value, requestedTitle) {
  const id = assertTerminal(taskId, value);
  const title = String(requestedTitle ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!title) throw Object.assign(new Error('TERMINAL_TITLE_REQUIRED'), { statusCode: 400 });
  if (title.length > MAX_TERMINAL_TITLE) throw Object.assign(new Error('TERMINAL_TITLE_TOO_LONG'), { statusCode: 400 });
  if (id === 'default') {
    db.prepare(`
      INSERT INTO task_default_terminal_titles (task_id, title) VALUES (?, ?)
      ON CONFLICT(task_id) DO UPDATE SET title = excluded.title
    `).run(taskId, title);
  } else {
    db.prepare('UPDATE task_terminals SET title = ? WHERE task_id = ? AND terminal_id = ?').run(title, taskId, id);
  }
  return { terminal_id: id, title };
}

function clearBuffer(taskId, id) {
  if (id === 'default') db.prepare('DELETE FROM terminal_logs WHERE task_id = ?').run(taskId);
  else db.prepare("UPDATE task_terminals SET buffer = '', updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND terminal_id = ?").run(taskId, id);
}

function flushToDB(taskId) {
  const s = sessions.get(taskId);
  if (!s) return;
  persistBuffer(s.taskId, s.buffer, s.terminalId);
  s.pendingSince = 0;
}

function persistBuffer(taskId, buffer, id = 'default') {
  if (id !== 'default') {
    db.prepare('UPDATE task_terminals SET buffer = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND terminal_id = ?').run(buffer || '', taskId, id);
    return;
  }
  db.prepare(`
    INSERT INTO terminal_logs (task_id, buffer, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(task_id) DO UPDATE SET buffer = excluded.buffer, updated_at = excluded.updated_at
  `).run(taskId, buffer || '');
}

function appendBuffer(taskId, data) {
  const s = sessions.get(taskId);
  if (!s) return;
  s.buffer += data;
  // when over the limit, truncate and keep the last 5MB
  if (s.buffer.length > MAX_BUFFER) {
    s.buffer = s.buffer.slice(s.buffer.length - MAX_BUFFER);
  }
  s.pendingSince += data.length;
  // flush immediately once more than 50KB has accumulated
  if (s.pendingSince >= FLUSH_SIZE) {
    clearInterval(s.flushTimer);
    flushToDB(taskId);
    s.flushTimer = setInterval(() => flushToDB(taskId), FLUSH_INTERVAL);
  }
}

function getOrCreateSession(ownerTaskId, workDir, dirWarning, id = 'default') {
  const taskId = sessionKey(ownerTaskId, id);
  if (sessions.has(taskId)) return sessions.get(taskId);

  // restore the history buffer from the DB
  const row = id === 'default'
    ? db.prepare('SELECT buffer FROM terminal_logs WHERE task_id = ?').get(ownerTaskId)
    : db.prepare('SELECT buffer FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(ownerTaskId, id);
  // The restored history comes from a PTY that no longer exists (service restart, crash, manual close). The killed program had no chance to turn off the
  // mouse/focus reporting modes it had enabled; if replayed unchanged, the browser terminal keeps feeding mouse movement into the new shell as input,
  // which shows up as characters like 35;39;58M after the prompt. So these input modes are always reset when restoring.
  const staleModes = row && row.buffer ? RESET_INPUT_MODES : '';
  const savedBuffer = (dirWarning || '') + (row ? row.buffer : '') + staleModes;

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
        ...(runAs ? { ...terminalEnvFor(runAs, process.env), SHELL: shell } : process.env),
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
    buffer: savedBuffer,
    ws: null,
    snapshot: new TerminalSnapshot(),
    ready: false,
    flushTimer: setInterval(() => flushToDB(taskId), FLUSH_INTERVAL),
    pendingSince: 0,
  };
  sessions.set(taskId, s);
  s.snapshot.write(savedBuffer);

  const emit = data => {
    if (sessions.get(taskId) !== s) return;
    appendBuffer(taskId, data);
    s.snapshot.write(data, () => {
      if (s.ready && s.ws && s.authorized && s.authorized()) s.ws.send(data);
    });
  };
  pty.onData(data => {
    s.activity?.noteOutput();
    emit(data);
  });
  // Also goes through the history buffer so replays do not re-enable mouse reporting.
  s.stopShellWatch = watchShellReturn(pty, shell, () => emit(RESET_INPUT_MODES));
  s.activity = createActivityTracker(pty, shell);

  pty.onExit(() => {
    // The parser queue also owns live delivery. Drain its last bytes before
    // closing a naturally exited shell; explicit control remains immediate.
    s.exiting = true;
    s.stopShellWatch();
    s.activity.stop();
    s.snapshot.enqueue(() => {
      if (sessions.get(taskId) !== s) return;
      clearInterval(s.flushTimer);
      persistBuffer(s.taskId, s.buffer, s.terminalId);
      sessions.delete(taskId);
      s.snapshot.dispose();
      const activeWs = s.ws;
      s.ws = null;
      if (activeWs && activeWs.readyState === 1) activeWs.close(1000, 'terminal exited');
    });
  });

  return s;
}

/**
 * Terminate the task's server-side PTY. restart-workdir also clears the old history and the next connection creates a brand-new shell from the
 * task work_dir; close keeps the history; delete also removes the extra terminal record.
 */
function controlSession(taskId, action, requestedTerminalId) {
  const id = Number.parseInt(taskId, 10);
  if (!id || !['close', 'restart-workdir', 'delete'].includes(action)) {
    const error = new Error('INVALID_TERMINAL_ACTION');
    error.statusCode = 400;
    throw error;
  }

  const selectedId = assertTerminal(id, requestedTerminalId);
  if (action === 'delete' && selectedId === 'default') {
    throw Object.assign(new Error('DEFAULT_TERMINAL_CANNOT_DELETE'), { statusCode: 400 });
  }
  const key = sessionKey(id, selectedId);
  const session = sessions.get(key);
  const clearHistory = action === 'restart-workdir' || action === 'delete';
  if (session) {
    sessions.delete(key);
    session.snapshot.dispose();
    clearInterval(session.flushTimer);
    session.stopShellWatch?.();
    session.activity?.stop();
    if (clearHistory) clearBuffer(id, selectedId);
    else persistBuffer(id, session.buffer, selectedId);
    session.pendingSince = 0;

    const activeWs = session.ws;
    session.ws = null;
    try { session.pty.kill(); } catch {}
    if (activeWs && activeWs.readyState === 1) activeWs.close(1000, `terminal ${action}`);
  } else if (clearHistory) {
    clearBuffer(id, selectedId);
  }

  if (action === 'delete') {
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
  const workDir = task.work_dir || os.homedir();
  // Check that the directory exists; if not, fall back to $HOME and log a warning
  let actualDir = workDir;
  let dirWarning = null;
  if (!fs.existsSync(workDir)) {
    actualDir = os.homedir();
    dirWarning = `\r\n\x1b[33m[⚠ Working directory does not exist: ${workDir}]\x1b[0m\r\n\x1b[33m[Fell back to ${actualDir}; edit the task to update the working path]\x1b[0m\r\n\r\n`;
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
  const archive = createHistoryArchive(s.buffer);
  const authorized = () => {
    if (ws.readyState !== 1 || sessions.get(key) !== s || s.ws !== ws) return false;
    if (req.sessionID && !require('../services/client-auth').getClientAuth().sessionActive(req.sessionID)) {
      ws.close(1008, 'Authentication required');
      return false;
    }
    if (!db.prepare('SELECT 1 FROM tasks WHERE id = ? AND user_id = ?').get(taskId, sessionUser.login)) {
      ws.close(1008, 'task not found');
      return false;
    }
    return true;
  };
  s.authorized = authorized;
  s.snapshot.snapshot(snapshot => {
    if (!authorized()) return;
    ws.send(JSON.stringify({ type: 'history', ...snapshot, archive: archive.metadata() }));
    s.ready = true;
  });

  ws.on('message', (msg) => {
    if (!authorized()) return;
    const str = msg.toString();
    // Only try to parse messages starting with '{' as control commands (such as resize)
    // digit characters (0-9) are valid JSON and would be parsed and silently dropped without this check
    if (/^\s*\{/.test(str)) {
      try {
        const data = JSON.parse(str);
        if (typeof data.type === 'string' && data.type.startsWith('history')) {
          if (data.type === 'history-page') ws.send(JSON.stringify(archive.page(data)));
          return;
        }
        if (data.type === 'resize') {
          if (!Number.isInteger(data.cols) || !Number.isInteger(data.rows) || data.cols < 1 || data.rows < 1 || data.cols > 1000 || data.rows > 1000) return;
          s.activity?.noteInput();
          s.pty.resize(data.cols, data.rows);
          s.snapshot.resize(data.cols, data.rows);
          return;
        }
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
      // flush to the DB immediately
      clearInterval(s.flushTimer);
      flushToDB(key);
      s.flushTimer = setInterval(() => flushToDB(key), FLUSH_INTERVAL);
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

module.exports = { setHookEndpoint, reportHook, activitySnapshot, acknowledgeActivity, controlSession, handleWs, listTerminals, createTerminal, listAgentSessions, reopenCommand, renameTerminal, assertTerminal, closeTaskTerminals };
