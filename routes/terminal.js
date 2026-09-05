const os = require('os');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { prepareTerminalHistoryBuffer } = require('../lib/terminal-history');
const { repairSpawnHelperPermissions } = require('../lib/node-pty-runtime');

// per-task sessions: Map<taskId, { pty, buffer, ws, flushTimer, pendingSince }>
const sessions = new Map();

const MAX_BUFFER = 5 * 1024 * 1024;   // 5MB
const FLUSH_INTERVAL = 5000;           // 5s
const FLUSH_SIZE = 50 * 1024;          // 50KB

function flushToDB(taskId) {
  const s = sessions.get(taskId);
  if (!s) return;
  db.prepare(`
    INSERT INTO terminal_logs (task_id, buffer, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(task_id) DO UPDATE SET buffer = excluded.buffer, updated_at = excluded.updated_at
  `).run(taskId, s.buffer);
  s.pendingSince = 0;
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

function getOrCreateSession(taskId, workDir, dirWarning) {
  if (sessions.has(taskId)) return sessions.get(taskId);

  // 从 DB 恢复历史 buffer
  const row = db.prepare('SELECT buffer FROM terminal_logs WHERE task_id = ?').get(taskId);
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
    pty,
    buffer: savedBuffer,
    ws: null,
    flushTimer: setInterval(() => flushToDB(taskId), FLUSH_INTERVAL),
    pendingSince: 0,
  };
  sessions.set(taskId, s);

  pty.onData(data => {
    appendBuffer(taskId, data);
    if (s.ws && s.ws.readyState === 1) {
      s.ws.send(data);
    }
  });

  pty.onExit(() => {
    clearInterval(s.flushTimer);
    flushToDB(taskId);
    sessions.delete(taskId);
  });

  return s;
}

/**
 * Handle WebSocket upgrade for /terminal/ws?taskId=:id
 * Called from server.js with (ws, req, sessionData)
 */
function handleWs(ws, req, sessionUser, requestedTaskId = null) {
  const taskId = parseInt(requestedTaskId || new URL(req.url, 'http://x').searchParams.get('taskId'));
  if (!taskId) { ws.close(1008, 'missing taskId'); return; }

  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(taskId, sessionUser.login);
  if (!task) {
    console.error('[terminal] task not found, taskId:', taskId, 'user:', sessionUser.login);
    ws.send('\r\n\x1b[31m[任务不存在或无权限]\x1b[0m\r\n');
    ws.close(1008, 'task not found');
    return;
  }

  const workDir = task.work_dir || os.homedir();
  // 检查目录是否存在，不存在时回退到 $HOME 并记录告警
  let actualDir = workDir;
  let dirWarning = null;
  if (!fs.existsSync(workDir)) {
    actualDir = os.homedir();
    dirWarning = `\r\n\x1b[33m[⚠ 工作目录不存在: ${workDir}]\x1b[0m\r\n\x1b[33m[已回退到 ${actualDir}，请编辑任务更新工作路径]\x1b[0m\r\n\r\n`;
  }
  const s = getOrCreateSession(taskId, actualDir, dirWarning);
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

  // 原样恢复终端状态，只剥离会触发 xterm 响应的 DA/DSR 查询。
  // 不可追加换行或移除 h/l 模式指令，否则全屏 TUI 的光标与备用屏幕会错位。
  if (s.buffer) {
    ws.send(JSON.stringify({
      type: 'history',
      data: prepareTerminalHistoryBuffer(s.buffer),
    }));
  }

  ws.on('message', (msg) => {
    const str = msg.toString();
    // 只有以 '{' 开头的消息才尝试作为控制指令解析（如 resize）
    // 数字字符（0-9）是合法 JSON，若不做此判断会被 parse 后静默丢弃
    if (str.charCodeAt(0) === 123 /* '{' */) {
      try {
        const data = JSON.parse(str);
        if (data.type === 'resize') {
          s.pty.resize(Math.max(1, data.cols), Math.max(1, data.rows));
          return;
        }
      } catch { /* 非合法 JSON，fall through 写入 PTY */ }
    }
    s.pty.write(str);
  });

  ws.on('close', () => {
    if (s.ws === ws) {
      s.ws = null;
      // 立即 flush 到 DB
      clearInterval(s.flushTimer);
      flushToDB(taskId);
      s.flushTimer = setInterval(() => flushToDB(taskId), FLUSH_INTERVAL);
    }
  });

  ws.on('error', (err) => {
    console.error('[terminal] ws error:', err.message);
  });
}

module.exports = { handleWs };
