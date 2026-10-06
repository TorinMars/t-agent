const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Terminal activity states: 'idle' -> 'running' -> 'done' (until acknowledged) -> 'idle'.
//
// Two ways to decide "running", chosen by what owns the PTY foreground:
//  - shell:        idle.
//  - batch job (make, npm test, sleep ...): running while it stays in the
//    foreground, even if silent; done when the shell prompt returns.
//  - interactive program (claude, codex, ssh, tmux, vim ...): it never leaves
//    the foreground, so "working" is judged by output. Agents animate a spinner
//    while working and go quiet while waiting for the user, so running means a
//    sustained burst of output, and done means it has gone quiet.
//  - agent with hooks: Claude Code / Codex hooks report start / stop / attention /
//    end through report(). Once a hook has been seen the agent's own events are
//    authoritative; output only recovers from missed events (see staleMs).
const INTERACTIVE = new Set([
  'claude', 'codex', 'gemini', 'opencode', 'aider', 'cursor-agent', 'amp', 'qwen', 'crush', 'goose',
  'ssh', 'mosh-client', 'tmux', 'screen', 'vim', 'vi', 'nvim', 'nano', 'less', 'man', 'top', 'htop',
]);

const DEFAULTS = {
  pollMs: 500,
  // Batch jobs must hold the foreground this many polls so ls/cd do not flash.
  minBusyPolls: 2,
  // Interactive programs: this many output chunks within burstMs start "running"...
  burstChunks: 4,
  burstMs: 1500,
  // ...and this long without output means they are waiting for the user.
  quietMs: 3000,
  // Output right after keystrokes or a resize is echo/redraw, not work.
  echoMs: 200,
  // A hooked agent still "running" but silent this long was interrupted (Esc /
  // Ctrl+C fire no Stop hook), so it is treated as finished.
  staleMs: 20000,
};

function baseName(value) {
  return path.basename(String(value || '')).replace(/^-/, '').replace(/\.(js|mjs|cjs|py|exe)$/i, '').toLowerCase();
}

// Foreground command of the PTY: argv from /proc when available (a node-based
// CLI shows up as "node"), otherwise just pty.process.
function foregroundCommand(pty) {
  const names = [];
  try {
    const stat = fs.readFileSync(`/proc/${pty.pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const foregroundGroup = Number(fields[5]);
    if (foregroundGroup > 0) {
      const argv = fs.readFileSync(`/proc/${foregroundGroup}/cmdline`, 'utf8').split('\0').filter(Boolean);
      names.push(...argv.slice(0, 2).map(baseName));
    }
  } catch { /* not Linux or process already gone */ }
  // macOS has no /proc: a node-based CLI (codex, claude) would only show up as "node",
  // so read the foreground process group's argv from ps instead.
  if (!names.length && process.platform !== 'linux' && pty.ptsName) {
    try {
      const tty = String(pty.ptsName).replace(/^\/dev\//, '');
      const rows = execFileSync('ps', ['-t', tty, '-o', 'pgid=,tpgid=,command='], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n');
      for (const row of rows) {
        const match = row.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        if (match && match[1] === match[2]) names.push(...match[3].split(/\s+/).slice(0, 2).map(baseName));
      }
    } catch { /* ps unavailable */ }
  }
  try { names.push(baseName(pty.process)); } catch {}
  return names.filter(Boolean);
}

function createActivityTracker(pty, shell, onChange = () => {}, options = {}) {
  const config = { ...DEFAULTS, ...(typeof options === 'number' ? { pollMs: options } : options) };
  const shellName = baseName(shell);
  let state = 'idle';
  let busyPolls = 0;
  let lastOutput = 0;
  let lastEcho = 0;
  let hooked = false;     // a hook event was received from the program in the foreground
  let resumable = false;  // 'done' came from a permission prompt: more work follows once answered
  const chunks = [];

  const set = next => {
    if (next === state) return;
    state = next;
    onChange(state);
  };

  const timer = setInterval(() => {
    const names = foregroundCommand(pty);
    if (!names.length) return;
    const now = Date.now();

    if (names[names.length - 1] === shellName && !names.some(name => INTERACTIVE.has(name))) {
      busyPolls = 0;
      hooked = false;
      resumable = false;
      chunks.length = 0;
      if (state === 'running') set('done');
      return;
    }

    while (chunks.length && now - chunks[0] > config.burstMs) chunks.shift();

    if (hooked) {
      if (state === 'running' && now - lastOutput > config.staleMs) set('done');
      else if (state === 'done' && resumable && chunks.length >= config.burstChunks) {
        resumable = false;
        set('running');
      }
      return;
    }

    if (names.some(name => INTERACTIVE.has(name))) {
      if (state !== 'running' && chunks.length >= config.burstChunks) set('running');
      else if (state === 'running' && now - lastOutput > config.quietMs) { chunks.length = 0; set('done'); }
      return;
    }

    busyPolls += 1;
    if (busyPolls >= config.minBusyPolls) set('running');
  }, config.pollMs);
  timer.unref?.();

  return {
    state: () => state,
    // PTY output. Echo of the user's own typing and redraws after a resize are ignored.
    noteOutput() {
      const now = Date.now();
      if (now - lastEcho < config.echoMs) return;
      lastOutput = now;
      chunks.push(now);
    },
    noteInput() { lastEcho = Date.now(); },
    // Event reported by the agent's own hook: start | stop | attention | end.
    report(event) {
      const now = Date.now();
      if (event === 'start') {
        hooked = true; resumable = false; lastOutput = now; chunks.length = 0;
        set('running');
      } else if (event === 'stop') {
        hooked = true; resumable = false;
        set('done');
      } else if (event === 'attention') {
        hooked = true; resumable = true;
        set('done');
      } else if (event === 'end') {
        hooked = false; resumable = false;
        if (state === 'running') set('done');
      } else {
        return false;
      }
      return true;
    },
    // The user opened the terminal and saw the result.
    acknowledge() { if (state === 'done') set('idle'); },
    stop() { clearInterval(timer); },
  };
}

module.exports = { createActivityTracker, foregroundCommand, INTERACTIVE };
