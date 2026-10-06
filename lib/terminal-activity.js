const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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

// One ps run serves every terminal: at most once per PS_REFRESH_MS, never blocking the event
// loop. Polling reads the latest snapshot, so it can lag by one refresh, which is fine for a status light.
const PS_REFRESH_MS = 400;
const psSnapshot = { at: 0, pending: false, byTty: new Map() };

// Rows are "tty pgid tpgid command"; a process is in the foreground when pgid equals tpgid.
function parsePs(output) {
  const byTty = new Map();
  for (const row of String(output).split('\n')) {
    const match = row.match(/^\s*(\S+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match || match[2] !== match[3]) continue;
    byTty.set(match[1], [...(byTty.get(match[1]) || []), ...match[4].split(/\s+/).slice(0, 2).map(baseName)]);
  }
  return byTty;
}

function refreshPs() {
  if (psSnapshot.pending || Date.now() - psSnapshot.at < PS_REFRESH_MS) return;
  psSnapshot.pending = true;
  execFile('ps', ['-axo', 'tty=,pgid=,tpgid=,command='], { encoding: 'utf8', timeout: 2000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
    psSnapshot.pending = false;
    psSnapshot.at = Date.now();
    if (!error) psSnapshot.byTty = parsePs(stdout);
  });
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
  // so read the foreground process groups' argv from a shared, asynchronous ps snapshot.
  if (!names.length && process.platform !== 'linux' && pty.ptsName) {
    refreshPs();
    names.push(...(psSnapshot.byTty.get(String(pty.ptsName).replace(/^\/dev\//, '')) || []));
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

module.exports = { createActivityTracker, foregroundCommand, parsePs, INTERACTIVE };
