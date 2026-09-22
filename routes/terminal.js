const os = require('os');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { TerminalSnapshot, createHistoryArchive } = require('../lib/terminal-snapshot');
const { repairSpawnHelperPermissions } = require('../lib/node-pty-runtime');

// Sessions are keyed by task ID and terminal ID; omitted IDs use the legacy shell.
const sessions = new Map();

const MAX_BUFFER = 5 * 1024 * 1024;   // 5MB
const FLUSH_INTERVAL = 5000;           // 5s
const FLUSH_SIZE = 50 * 1024;          // 50KB

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

function listTerminals(taskId) {
  return [{ terminal_id: 'default', title: '终端 1' }, ...db.prepare(
    'SELECT terminal_id, title FROM task_terminals WHERE task_id = ? ORDER BY rowid'
  ).all(taskId)];
}

function createTerminal(taskId) {
  const id = require('crypto').randomUUID();
  const title = `终端 ${listTerminals(taskId).length + 1}`;
  db.prepare('INSERT INTO task_terminals (task_id, terminal_id, title) VALUES (?, ?, ?)').run(taskId, id, title);
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
  // 超限时截断保留后 5MB
  if (s.buffer.length > MAX_BUFFER) {
    s.buffer = s.buffer.slice(s.buffer.length - MAX_BUFFER);
  }
  s.pendingSince += data.length;
  // 累积超 50KB 立即 flush
  if (s.pendingSince >= FLUSH_SIZE) {
    clearInterval(s.flushTimer);
    flushToDB(taskId);
    s.flushTimer = setInterval(() => flushToDB(taskId), FLUSH_INTERVAL);
  }
}

function getOrCreateSession(ownerTaskId, workDir, dirWarning, id = 'default') {
  const taskId = sessionKey(ownerTaskId, id);
  if (sessions.has(taskId)) return sessions.get(taskId);

  // 从 DB 恢复历史 buffer
  const row = id === 'default'
    ? db.prepare('SELECT buffer FROM terminal_logs WHERE task_id = ?').get(ownerTaskId)
    : db.prepare('SELECT buffer FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(ownerTaskId, id);
  const savedBuffer = (dirWarning || '') + (row ? row.buffer : '');

  let pty;
  try {
    repairSpawnHelperPermissions(path.resolve(__dirname, '..'));
    const nodePty = require('node-pty');
    // LaunchAgent 启动时 PATH 很精简，手动补全常用路径确保 node/brew/工具可用
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
    // macOS 通常使用 zsh，而 Linux 服务器常只有 bash/sh。选择实际存在的
    // shell，避免 node-pty 因固定的 /bin/zsh 路径不存在而启动失败。
    const shell = ['/bin/zsh', '/bin/bash', '/bin/sh'].find(candidate => fs.existsSync(candidate));
    if (!shell) throw new Error('未找到可用的 shell（/bin/zsh、/bin/bash、/bin/sh）');

    pty = nodePty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      cwd: workDir || os.homedir(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        PATH: fullPath,
        // 使用服务器实际可用的 UTF-8 locale。部分 Linux 最小安装没有
        // zh_CN.UTF-8，强制设置会导致 bash 报错并让中文路径显示乱码。
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        LC_CTYPE: 'C.UTF-8',
      },
    });
  } catch (e) {
    console.error('[terminal] node-pty spawn error:', e.message, '\ncwd:', workDir, '\nenv.HOME:', process.env.HOME);
    return { startupError: e };
  }

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

  pty.onData(data => {
    if (sessions.get(taskId) !== s) return;
    appendBuffer(taskId, data);
    s.snapshot.write(data, () => {
      if (s.ready && s.ws && s.authorized && s.authorized()) s.ws.send(data);
    });
  });

  pty.onExit(() => {
    // The parser queue also owns live delivery. Drain its last bytes before
    // closing a naturally exited shell; explicit control remains immediate.
    s.exiting = true;
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
 * 终止任务的服务端 PTY。restart-workdir 同时清空旧历史，下一次连接会从
 * 任务 work_dir 创建全新 Shell；close 保留历史，delete 同时删除额外终端记录。
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
    ws.send('\r\n\x1b[31m[任务不存在或无权限]\x1b[0m\r\n');
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
  // 检查目录是否存在，不存在时回退到 $HOME 并记录告警
  let actualDir = workDir;
  let dirWarning = null;
  if (!fs.existsSync(workDir)) {
    actualDir = os.homedir();
    dirWarning = `\r\n\x1b[33m[⚠ 工作目录不存在: ${workDir}]\x1b[0m\r\n\x1b[33m[已回退到 ${actualDir}，请编辑任务更新工作路径]\x1b[0m\r\n\r\n`;
  }
  const s = getOrCreateSession(taskId, actualDir, dirWarning, selectedId);
  if (s.startupError) {
    const details = String(s.startupError.message || '未知错误')
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .slice(0, 500);
    ws.send(`\r\n\x1b[31m[终端启动失败]\x1b[0m\r\n${details}\r\n`);
    ws.close();
    return;
  }

  // 断开旧连接（同 task 的旧 ws）
  if (s.ws && s.ws.readyState === 1) {
    s.ws.close(1000, 'replaced by new connection');
  }
  s.ws = ws;

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
    // 只有以 '{' 开头的消息才尝试作为控制指令解析（如 resize）
    // 数字字符（0-9）是合法 JSON，若不做此判断会被 parse 后静默丢弃
    if (/^\s*\{/.test(str)) {
      try {
        const data = JSON.parse(str);
        if (typeof data.type === 'string' && data.type.startsWith('history')) {
          if (data.type === 'history-page') ws.send(JSON.stringify(archive.page(data)));
          return;
        }
        if (data.type === 'resize') {
          if (!Number.isInteger(data.cols) || !Number.isInteger(data.rows) || data.cols < 1 || data.rows < 1 || data.cols > 1000 || data.rows > 1000) return;
          s.pty.resize(data.cols, data.rows);
          s.snapshot.resize(data.cols, data.rows);
          return;
        }
      } catch {
        // Malformed history controls must never become shell input.
        if (/\"type\"\s*:\s*\"history/.test(str)) return;
      }
    }
    if (!s.exiting) s.pty.write(str);
  });

  ws.on('close', () => {
    if (s.ws === ws) {
      s.ws = null;
      // 立即 flush 到 DB
      clearInterval(s.flushTimer);
      flushToDB(key);
      s.flushTimer = setInterval(() => flushToDB(key), FLUSH_INTERVAL);
    }
  });

  ws.on('error', (err) => {
    console.error('[terminal] ws error:', err.message);
  });
}

function closeTaskTerminals(taskId) {
  for (const item of listTerminals(taskId)) controlSession(taskId, 'close', item.terminal_id);
}

module.exports = { controlSession, handleWs, listTerminals, createTerminal, assertTerminal, closeTaskTerminals };
