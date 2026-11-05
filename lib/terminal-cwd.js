// The live current directory of a terminal's shell, for terminal file links whose shell did not report it with OSC 7.
// Read-only: Linux reads /proc/<pid>/cwd, macOS asks lsof. Only the shell process itself is asked (not its foreground child): a program started
// from the shell (Claude Code, an editor) runs in the directory the shell was in, and prints paths relative to that.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const LSOF_TIMEOUT_MS = 2000;

// Resolves to the absolute current directory of process `pid`, or null when it cannot be read (gone, no permission, no lsof).
function processCwd(pid, { platform = process.platform, run = execFile } = {}) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return Promise.resolve(null);
  if (platform === 'linux') {
    return fs.promises.readlink(`/proc/${id}/cwd`).then(value => (path.isAbsolute(value) ? value : null), () => null);
  }
  return new Promise(resolve => {
    run('lsof', ['-a', '-d', 'cwd', '-p', String(id), '-Fn'], { encoding: 'utf8', timeout: LSOF_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error && !stdout) return resolve(null);
      resolve(parseLsofCwd(stdout));
    });
  });
}

// lsof -Fn prints one field per line: "p<pid>", "f<fd>", "n<name>". The cwd is the name line.
function parseLsofCwd(output) {
  for (const line of String(output || '').split('\n')) {
    if (line.startsWith('n/')) return line.slice(1);
  }
  return null;
}

function realpath(value) {
  try { return fs.realpathSync(value); } catch { return null; }
}

// The directory `cwd` relative to the task root ('' for the root itself), or null when it is outside the root. Both sides are compared as real paths,
// so a symbolic link out of the root is outside, and a root reached through a link (/tmp on macOS) still matches.
function cwdInRoot(cwd, root) {
  if (!cwd || !root || !path.isAbsolute(cwd) || !path.isAbsolute(root)) return null;
  const realCwd = realpath(cwd);
  const realRoot = realpath(root);
  if (!realCwd || !realRoot) return null;
  const relative = path.relative(realRoot, realCwd);
  if (relative === '') return '';
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

module.exports = { processCwd, parseLsofCwd, cwdInRoot };
