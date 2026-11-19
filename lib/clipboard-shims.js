// Clipboard shims for terminal PTYs (scripts/clipboard-shims): pbcopy, xclip, xsel and wl-copy that also send the copied
// text to the browser clipboard as OSC 52, and a codex wrapper that sets SSH_TTY so Codex sends its copies as OSC 52 too.
// The same folder holds the link shims (open, xdg-open and ta-browser, which is set as $BROWSER): a web link a program opens goes
// to the page that shows the terminal (routes/open-link.js). routes/terminal.js puts the folder first in PATH and sets
// TA_CLIPBOARD_OSC52=1. See "Clipboard (OSC 52)" and "Links opened by programs" in docs/design/terminals.md.
const fs = require('fs');
const path = require('path');
const { userCanEnter } = require('./terminal-user');

const SHIM_DIR = path.resolve(__dirname, '..', 'scripts', 'clipboard-shims');
const SHIMS = ['pbcopy', 'xclip', 'xsel', 'wl-copy', 'codex', 'open', 'xdg-open', 'ta-browser'];
const SHIM_LIBS = ['osc52-lib.sh', 'open-link-lib.sh'];
const BROWSER_SHIM = 'ta-browser';

// An update copies files without git (services/archive-updater.js) and a checkout with core.fileMode=false may drop the
// executable bit, so it is put back before a terminal uses the folder. Returns false when the folder cannot be used.
function ensureShimModes(dir = SHIM_DIR) {
  try {
    for (const name of [...SHIMS, ...SHIM_LIBS]) {
      const file = path.join(dir, name);
      const mode = fs.statSync(file).mode & 0o7777;
      const wanted = SHIM_LIBS.includes(name) ? 0o644 : 0o755;
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
    && SHIM_LIBS.every(name => userHasBits(path.join(dir, name), user, 0o4, stat));
}

const warned = new Set(); // one log line per folder and user

// Codex (checked on 0.166) also sends its copies to the terminal as OSC 52 when HERDR_ENV=1 (the marker of the Herdr
// multiplexer); in that version it changes nothing else. It does not need the shim folder, so it is set even when the
// folder is skipped, and never over an inherited value (a real Herdr). Undocumented: re-check when Codex is upgraded.
function codexOsc52Env(inherited) {
  return Object.prototype.hasOwnProperty.call(inherited || {}, 'HERDR_ENV') ? {} : { HERDR_ENV: '1' };
}

// $BROWSER of a terminal is the link shim; a browser the environment already names is kept in TA_BROWSER_REAL, where the shim
// sends what it does not hand to the page. A BROWSER that is already a link shim (a server started inside a T-Agent terminal)
// is not kept, so the shim never calls itself.
function browserEnv(dir, inherited) {
  const before = inherited && typeof inherited.BROWSER === 'string' ? inherited.BROWSER.trim() : '';
  const own = before && path.basename(before.split(/\s+/)[0]) === BROWSER_SHIM;
  return { BROWSER: path.join(dir, BROWSER_SHIM), ...(before && !own ? { TA_BROWSER_REAL: before } : {}) };
}

// The PATH and markers for a new PTY. `basePath` is the PATH the terminal would get without the shims; `env` is the
// environment the PTY inherits (to keep an existing HERDR_ENV and BROWSER).
function clipboardShimEnv(basePath, user = null, { dir = SHIM_DIR, log = console.warn, stat = fs.statSync, env = process.env } = {}) {
  const codex = codexOsc52Env(env);
  if (!ensureShimModes(dir) || !shimsUsableBy(user, dir, stat)) {
    const key = `${dir}:${user ? user.name : ''}`;
    if (!warned.has(key)) {
      warned.add(key);
      log(`[terminal] clipboard shims in ${dir} are not usable${user ? ` by ${user.name}` : ''}; copies from programs in terminals stay on the server clipboard and links they open open on the server`);
    }
    return { PATH: basePath, ...codex };
  }
  return { PATH: [dir, basePath].filter(Boolean).join(':'), TA_CLIPBOARD_OSC52: '1', ...codex, ...browserEnv(dir, env) };
}

module.exports = { SHIM_DIR, SHIMS, SHIM_LIBS, ensureShimModes, shimsUsableBy, clipboardShimEnv };
