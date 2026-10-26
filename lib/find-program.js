// Finds a program the way the person's own terminal would, for a service that was started with a short PATH (pm2, systemd, launchd).
//
// Looked at, in this order: an explicit variable (CODEX_PATH ...), PATH, the usual install folders of the user (npm, bun, volta, cargo, pnpm,
// the newest nvm node) and the system folders, and last the login shell of the user, asked once with `command -v <name>` (the PATH of a shell
// profile has what nvm, bun or a custom prefix set up). The answer of the shell is remembered while that file stays executable.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SHELL_TIMEOUT_MS = 4000;

const isExecutable = file => {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
};

// `extra`: folders that only this program is installed to (the standalone installer of Codex ...).
function searchDirs(env = process.env, extra = []) {
  const home = env.HOME || os.homedir();
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  let versions = [];
  try { versions = fs.readdirSync(nvm).sort((x, y) => y.localeCompare(x, undefined, { numeric: true })).map(name => path.join(nvm, name, 'bin')); } catch { /* no nvm */ }
  const dirs = [
    ...String(env.PATH || '').split(path.delimiter),
    path.join(home, '.local', 'bin'), ...extra.map(dir => path.join(home, dir)), path.join(home, '.bun', 'bin'), path.join(home, '.npm-global', 'bin'),
    path.join(home, '.volta', 'bin'), path.join(home, '.cargo', 'bin'), path.join(home, '.local', 'share', 'pnpm'), path.join(home, 'Library', 'pnpm'),
    ...versions, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin',
  ];
  return [...new Set(dirs.filter(Boolean))];
}

// What the login shell resolves `name` to. It is asked as a login shell first, then as an interactive one (nvm is usually set up in .zshrc /
// .bashrc) and given a few seconds each. `name` is a plain program name; the shell gets it as an argument, never as part of the script.
function shellLookup(name, env) {
  const shell = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : '/bin/sh';
  const ask = flags => new Promise(resolve => {
    execFile(shell, [flags, 'command -v "$1"', 'find-program', name], { env, timeout: SHELL_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
      const line = String(stdout || '').split('\n').map(entry => entry.trim()).filter(entry => path.isAbsolute(entry)).pop();
      resolve(line && isExecutable(line) ? line : null);
    });
  });
  return ask('-lc').then(found => found || ask('-ilc'));
}

// A finder for one program: { executablePath(env), find(env), forget() }.
function makeFinder(name, { envVar, extraDirs = [] } = {}) {
  let fromShell = null;
  const executablePath = (env = process.env) => {
    if (envVar && env[envVar] && isExecutable(env[envVar])) return env[envVar];
    for (const dir of searchDirs(env, extraDirs)) {
      const file = path.join(dir, name);
      if (isExecutable(file)) return file;
    }
    return null;
  };
  return {
    executablePath,
    async find(env = process.env) {
      const direct = executablePath(env);
      if (direct) return direct;
      if (fromShell && isExecutable(fromShell)) return fromShell;
      fromShell = await shellLookup(name, env);
      return fromShell;
    },
    forget() { fromShell = null; },
    dirs: (env = process.env) => searchDirs(env, extraDirs),
  };
}

module.exports = { makeFinder, searchDirs, shellLookup, isExecutable };
