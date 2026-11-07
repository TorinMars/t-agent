// Clipboard shims for terminal PTYs (scripts/clipboard-shims): pbcopy, xclip, xsel and wl-copy that also send the copied
// text to the browser clipboard as OSC 52, and a codex wrapper that sets SSH_TTY so Codex sends its copies as OSC 52 too.
// routes/terminal.js puts the folder first in PATH and sets TA_CLIPBOARD_OSC52=1.
// See "Clipboard (OSC 52)" in DESIGN.md.
const fs = require('fs');
const path = require('path');
const { userCanEnter } = require('./terminal-user');

const SHIM_DIR = path.resolve(__dirname, '..', 'scripts', 'clipboard-shims');
const SHIMS = ['pbcopy', 'xclip', 'xsel', 'wl-copy', 'codex'];
const SHIM_LIB = 'osc52-lib.sh';

// An update copies files without git (services/archive-updater.js) and a checkout with core.fileMode=false may drop the
// executable bit, so it is put back before a terminal uses the folder. Returns false when the folder cannot be used.
function ensureShimModes(dir = SHIM_DIR) {
  try {
    for (const name of [...SHIMS, SHIM_LIB]) {
      const file = path.join(dir, name);
      const mode = fs.statSync(file).mode & 0o7777;
      const wanted = name === SHIM_LIB ? 0o644 : 0o755;
      if ((mode & wanted) !== wanted) fs.chmodSync(file, mode | wanted);
    }
    return true;
  } catch {
    return false;
  }
}

// Permission bits only (supplementary groups and ACLs are not handled), like userCanEnter.
function userHasBits(file, user, bits, stat = fs.statSync) {
  try {
    const info = stat(file);
    const shift = info.uid === user.uid ? 6 : info.gid === user.gid ? 3 : 0;
    return ((info.mode >> shift) & bits) === bits;
  } catch { return false; }
}

// When the terminal drops to another user, that user must reach the folder (every parent directory) and run the shims.
function shimsUsableBy(user, dir = SHIM_DIR, stat = fs.statSync) {
  if (!user) return true;
  for (let current = dir; ; current = path.dirname(current)) {
    if (!userCanEnter(current, user, stat)) return false;
    if (path.dirname(current) === current) break;
  }
  return SHIMS.every(name => userHasBits(path.join(dir, name), user, 0o5, stat))
    && userHasBits(path.join(dir, SHIM_LIB), user, 0o4, stat);
}

const warned = new Set(); // one log line per folder and user
// The PATH and marker for a new PTY. `basePath` is the PATH the terminal would get without the shims.
function clipboardShimEnv(basePath, user = null, { dir = SHIM_DIR, log = console.warn, stat = fs.statSync } = {}) {
  if (!ensureShimModes(dir) || !shimsUsableBy(user, dir, stat)) {
    const key = `${dir}:${user ? user.name : ''}`;
    if (!warned.has(key)) {
      warned.add(key);
      log(`[terminal] clipboard shims in ${dir} are not usable${user ? ` by ${user.name}` : ''}; copies from programs in terminals stay on the server clipboard`);
    }
    return { PATH: basePath };
  }
  return { PATH: [dir, basePath].filter(Boolean).join(':'), TA_CLIPBOARD_OSC52: '1' };
}

module.exports = { SHIM_DIR, SHIMS, ensureShimModes, shimsUsableBy, clipboardShimEnv };
