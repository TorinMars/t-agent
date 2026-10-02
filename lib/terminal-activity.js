const path = require('path');

// Terminal activity is derived from the PTY foreground process: anything other
// than the login shell counts as a running job. Output cadence is not used, so
// silent long-running commands stay "running" and chatty prompts stay "idle".
// States: 'idle' -> 'running' -> 'done' (until acknowledged) -> 'idle'.
const POLL_MS = 500;
// Foreground must differ from the shell for this many polls in a row, so
// instant commands (ls, cd) do not flash the indicator.
const MIN_BUSY_POLLS = 2;

function foregroundName(pty) {
  try { return path.basename(String(pty.process || '')).replace(/^-/, ''); } catch { return ''; }
}

function createActivityTracker(pty, shell, onChange = () => {}, intervalMs = POLL_MS) {
  const shellName = path.basename(shell);
  let state = 'idle';
  let busyPolls = 0;

  const set = next => {
    if (next === state) return;
    state = next;
    onChange(state);
  };

  const timer = setInterval(() => {
    const name = foregroundName(pty);
    if (!name) return;
    if (name !== shellName) {
      busyPolls += 1;
      if (busyPolls >= MIN_BUSY_POLLS) set('running');
    } else {
      busyPolls = 0;
      if (state === 'running') set('done');
    }
  }, intervalMs);
  timer.unref?.();

  return {
    state: () => state,
    // The user opened the terminal and saw the result.
    acknowledge() { if (state === 'done') set('idle'); },
    stop() { clearInterval(timer); },
  };
}

module.exports = { createActivityTracker, MIN_BUSY_POLLS };
