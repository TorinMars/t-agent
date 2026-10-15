// Terminal privilege drop: when the service runs as root, make the shell in the web terminal use an ordinary user.
// Tools such as Claude Code refuse the "skip permission prompts" mode when running as root.
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

// Returns { user } or { user: null, reason }. Privileges are only dropped on Linux when running as root;
// setting TERMINAL_USER explicitly to an empty string means no drop; when the default user does not exist, silently keep root (compatible with old installs).
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

// Roughly decide from the permission bits whether the user can enter the directory (supplementary groups and ACLs are not handled; good enough to decide whether to fall back to the home directory).
function userCanEnter(dir, user, stat = fs.statSync) {
  try {
    const info = stat(dir);
    if (!info.isDirectory()) return false;
    const bit = info.uid === user.uid ? 0o100 : info.gid === user.gid ? 0o010 : 0o001;
    return (info.mode & bit) !== 0;
  } catch { return false; }
}

// After dropping privileges, the service's own secrets must not be carried along.
function terminalEnvFor(user, baseEnv) {
  const env = { ...baseEnv };
  delete env.SESSION_SECRET;
  return { ...env, HOME: user.home, USER: user.name, LOGNAME: user.name };
}

module.exports = { DEFAULT_TERMINAL_USER, lookupUser, resolveTerminalUser, userCanEnter, terminalEnvFor };
