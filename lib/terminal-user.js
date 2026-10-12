// 终端降权：服务以 root 运行时，让网页终端里的 shell 改用普通用户。
// Claude Code 等工具在 root 下会拒绝“跳过权限确认”的模式。
const fs = require('fs');

const DEFAULT_TERMINAL_USER = 'dev';

function readPasswd(file = '/etc/passwd') {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function lookupUser(name, passwdText) {
  for (const line of String(passwdText).split('\n')) {
    const fields = line.split(':');
    if (fields.length >= 7 && fields[0] === name) {
      return { name, uid: Number(fields[2]), gid: Number(fields[3]), home: fields[5] || '/', shell: fields[6] || '' };
    }
  }
  return null;
}

// 返回 { user } 或 { user: null, reason }。只有 Linux 上以 root 运行时才降权；
// TERMINAL_USER 显式设为空字符串表示不降权；默认用户不存在时静默沿用 root（兼容旧安装）。
function resolveTerminalUser({ env = process.env, platform = process.platform, uid = typeof process.getuid === 'function' ? process.getuid() : -1, passwd = readPasswd } = {}) {
  if (platform !== 'linux' || uid !== 0) return { user: null, reason: 'not-root' };
  const explicit = Object.prototype.hasOwnProperty.call(env, 'TERMINAL_USER');
  const name = explicit ? String(env.TERMINAL_USER).trim() : DEFAULT_TERMINAL_USER;
  if (!name) return { user: null, reason: 'disabled' };
  if (name === 'root') return { user: null, reason: 'root' };
  const user = lookupUser(name, typeof passwd === 'function' ? passwd() : passwd);
  if (!user) return { user: null, reason: explicit ? 'missing-explicit' : 'missing-default', name };
  if (user.uid === 0) return { user: null, reason: 'root' };
  return { user };
}

// 按权限位粗略判断该用户能否进入目录（不处理附加组与 ACL，够用于决定是否回退到家目录）。
function userCanEnter(dir, user, stat = fs.statSync) {
  try {
    const info = stat(dir);
    if (!info.isDirectory()) return false;
    const bit = info.uid === user.uid ? 0o100 : info.gid === user.gid ? 0o010 : 0o001;
    return (info.mode & bit) !== 0;
  } catch { return false; }
}

// 降权后不应带着服务自己的密钥。
function terminalEnvFor(user, baseEnv) {
  const env = { ...baseEnv };
  delete env.SESSION_SECRET;
  return { ...env, HOME: user.home, USER: user.name, LOGNAME: user.name };
}

module.exports = { DEFAULT_TERMINAL_USER, lookupUser, resolveTerminalUser, userCanEnter, terminalEnvFor };
