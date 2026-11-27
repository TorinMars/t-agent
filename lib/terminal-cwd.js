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
    // A UTF-8 locale for lsof: under LC_ALL=C (a service started by launchd or in the background) it escapes every non-ASCII byte of a directory name
    // as \xNN; parseLsofCwd undoes that escape as well, for a machine where this locale is missing.
    run('lsof', ['-a', '-d', 'cwd', '-p', String(id), '-Fn'], { encoding: 'utf8', timeout: LSOF_TIMEOUT_MS, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: 'en_US.UTF-8' } }, (error, stdout) => {
      if (error && !stdout) return resolve(null);
      resolve(parseLsofCwd(stdout));
    });
  });
}

// lsof escapes what it does not print as it is: a backslash as \\, \b \f \n \r \t, a control character as \^X and, outside a UTF-8 locale, every byte of
// a non-ASCII character as \xNN. The text of a name line with those escapes undone: runs of \xNN are bytes read together as UTF-8.
const LSOF_SIMPLE = { '\\': '\\', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
function unescapeLsof(text) {
  if (!text.includes('\\')) return text;
  let out = '';
  for (let at = 0; at < text.length;) {
    if (text[at] !== '\\') { out += text[at]; at += 1; continue; }
    const hex = /^(?:\\x[0-9a-fA-F]{2})+/.exec(text.slice(at));
    if (hex) {
      out += Buffer.from(hex[0].replace(/\\x/g, ''), 'hex').toString('utf8');
      at += hex[0].length;
    } else if (Object.hasOwn(LSOF_SIMPLE, text[at + 1])) {
      out += LSOF_SIMPLE[text[at + 1]];
      at += 2;
    } else if (text[at + 1] === '^' && text[at + 2]) {
      out += String.fromCharCode(text.charCodeAt(at + 2) & 0x1f);
      at += 3;
    } else {
      out += text[at];
      at += 1;
    }
  }
  return out;
}

// lsof -Fn prints one field per line: "p<pid>", "f<fd>", "n<name>". The cwd is the name line, with lsof's escapes undone.
function parseLsofCwd(output) {
  for (const line of String(output || '').split('\n')) {
    if (line.startsWith('n/')) return unescapeLsof(line.slice(1));
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
