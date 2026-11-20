const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { createPollClock, sharedClock } = require('./terminal-poll');

// Terminal activity states: 'idle' -> 'running' -> 'done' (until acknowledged) -> 'idle'.
//
// Two ways to decide "running", chosen by what owns the PTY foreground:
//  - shell:       idle.
//  - batch job (make, npm test, sleep ...): running while it stays in the
//    foreground, even if silent; done when the shell prompt returns.
//  - interactive program (claude, codex, ssh, tmux, vim ...): it never leaves
//    the foreground, so "working" is judged by output. Agents animate a spinner
//    while working and go quiet while waiting for the user, so running means a
//    sustained burst of output, and done means it has gone quiet.
//  - agent with hooks: Claude Code / Codex hooks report start / stop / attention /
//    end through report(). Once a hook has been seen the agent's own events are
//    authoritative; output only recovers from missed events (see staleMs).
//    An attention carries the kind of the wait ("Two waiting kinds" in docs/design/terminals.md): 'select' (the agent asks the
//    person to choose or enter something) or 'accept' (it waits for an approval). A wait from a tool hook (`tool`: the
//    AskUserQuestion / ExitPlanMode PreToolUse) ends with that tool's PostToolUse ('start'), so output does not end it.
const INTERACTIVE = new Set([
  'claude', 'codex', 'gemini', 'opencode', 'aider', 'cursor-agent', 'amp', 'qwen', 'crush', 'goose',
  'ssh', 'mosh-client', 'tmux', 'screen', 'vim', 'vi', 'nvim', 'nano', 'less', 'man', 'top', 'htop',
]);

// The polls come from the shared clock of lib/terminal-poll.js (every 500 ms, every 2 s while nobody watches this server's terminals),
// one timer for all terminals. A tracker that is given its own `pollMs` (tests) gets a clock of its own with that period.
const DEFAULTS = {
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
  childProcess.execFile('ps', ['-axo', 'tty=,pgid=,tpgid=,command='], { encoding: 'utf8', timeout: 2000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
    psSnapshot.pending = false;
    psSnapshot.at = Date.now();
    if (!error) psSnapshot.byTty = parsePs(stdout);
  });
}

// /proc is asked once, at the first poll: where it does not exist (macOS) every poll of every terminal would otherwise try two reads that
// always fail.
let procFs = null;
function hasProcFs() {
  if (procFs === null) {
    try { procFs = fs.existsSync('/proc/self/stat'); } catch { procFs = false; }
  }
  return procFs;
}

// Foreground command of the PTY: argv from /proc when available (a node-based
// CLI shows up as "node"), otherwise just pty.process. `processOf` reads pty.process (the poll clock reads it once per tick for all
// the watchers of a terminal).
function foregroundCommand(pty, processOf = terminal => terminal.process) {
  const names = [];
  if (hasProcFs()) {
    try {
      const stat = fs.readFileSync(`/proc/${pty.pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const foregroundGroup = Number(fields[5]);
      if (foregroundGroup > 0) {
        const argv = fs.readFileSync(`/proc/${foregroundGroup}/cmdline`, 'utf8').split('\0').filter(Boolean);
        names.push(...argv.slice(0, 2).map(baseName));
      }
    } catch { /* process already gone */ }
  }
  // macOS has no /proc: a node-based CLI (codex, claude) would only show up as "node",
  // so read the foreground process groups' argv from a shared, asynchronous ps snapshot.
  if (!names.length && process.platform !== 'linux' && pty.ptsName) {
    refreshPs();
    names.push(...(psSnapshot.byTty.get(String(pty.ptsName).replace(/^\/dev\//, '')) || []));
  }
  try { names.push(baseName(processOf(pty))); } catch {}
  return names.filter(Boolean);
}

// The shell itself owns the PTY: `names` is what foregroundCommand() returned.
function isShellForeground(names, shellName) {
  return names[names.length - 1] === shellName && !names.some(name => INTERACTIVE.has(name));
}

// options: a number (an own poll period) or { pollMs, clock, ...DEFAULTS }. `clock` is a poll clock of lib/terminal-poll.js.
function createActivityTracker(pty, shell, onChange = () => {}, options = {}) {
  const given = typeof options === 'number' ? { pollMs: options } : (options || {});
  const config = { ...DEFAULTS, ...given };
  const clock = given.clock || (given.pollMs === undefined ? sharedClock : createPollClock({ fastMs: given.pollMs, slowMs: given.pollMs }));
  const shellName = baseName(shell);
  let state = 'idle';
  let changedAt = Date.now(); // when `state` last changed (the tracker's start until the first change)
  let busyPolls = 0;
  let lastOutput = 0;
  let lastEcho = 0;
  let hooked = false;     // a hook event was received from the program in the foreground
  let resumable = false;  // 'done' came from a permission prompt: more work follows once answered
  let kind = null;        // while resumable: 'select' | 'accept', the kind of the wait
  let toolWait = false;   // while resumable: the wait came from a tool hook, so only a hook event ends it
  // burstChunks chunks came within burstMs at some moment since the last poll. Judged when the output arrives, so a burst is not missed
  // when the next poll comes later than burstMs (the slow clock while nobody watches).
  let burst = false;
  const chunks = [];

  const set = next => {
    if (next === state) return;
    state = next;
    changedAt = Date.now();
    onChange(state);
  };

  const stopPolling = clock.subscribe(() => {
    const names = foregroundCommand(pty, clock.processOf);
    if (!names.length) return;
    const now = Date.now();
    const sawBurst = burst;
    burst = false;

    if (isShellForeground(names, shellName)) {
      busyPolls = 0;
      hooked = false;
      resumable = false;
      toolWait = false;
      chunks.length = 0;
      if (state === 'running') set('done');
      return;
    }

    while (chunks.length && now - chunks[0] > config.burstMs) chunks.shift();
    const bursting = sawBurst || chunks.length >= config.burstChunks;

    if (hooked) {
      if (state === 'running' && now - lastOutput > config.staleMs) set('done');
      else if (state === 'done' && resumable && !toolWait && bursting) {
        resumable = false;
        set('running');
      }
      return;
    }

    if (names.some(name => INTERACTIVE.has(name))) {
      if (state !== 'running' && bursting) set('running');
      else if (state === 'running' && now - lastOutput > config.quietMs) { chunks.length = 0; set('done'); }
      return;
    }

    busyPolls += 1;
    if (busyPolls >= config.minBusyPolls) set('running');
  });

  return {
    state: () => state,
    // The time (ms since the epoch) of the last state change; the tracker's start while it never changed.
    since: () => changedAt,
    // The agent stopped at a question for the person (a permission prompt) and goes on once it is answered.
    awaitingAnswer: () => state === 'done' && resumable,
    // The kind of that question: 'select' or 'accept'; null while the agent does not wait for an answer.
    waitingKind: () => (state === 'done' && resumable ? kind : null),
    // PTY output. Echo of the user's own typing and redraws after a resize are ignored.
    noteOutput() {
      const now = Date.now();
      if (now - lastEcho < config.echoMs) return;
      lastOutput = now;
      chunks.push(now);
      while (now - chunks[0] > config.burstMs) chunks.shift();
      if (chunks.length >= config.burstChunks) burst = true;
    },
    noteInput() { lastEcho = Date.now(); },
    // Event reported by the agent's own hook: start | stop | attention | end. An attention takes { kind, tool }: kind 'select' | 'accept'
    // (anything else is none); without a kind it keeps the kind of a wait that is already open, else it is 'accept' (an older hook: its only
    // prompts were permissions). Two hooks of one wait (an older Notification entry beside the current one, a Notification during a tool's
    // question) never turn a known kind into a guess, and the kind of a tool's wait is kept until that tool is done.
    report(event, { kind: given = null, tool = false } = {}) {
      const now = Date.now();
      burst = false; // only output that comes after the event counts as a new burst
      if (event !== 'attention' && event !== 'start' && event !== 'stop' && event !== 'end') return false;
      if (event !== 'attention') toolWait = false;
      if (event === 'start') {
        hooked = true; resumable = false; lastOutput = now; chunks.length = 0;
        set('running');
      } else if (event === 'stop') {
        hooked = true; resumable = false;
        set('done');
      } else if (event === 'attention') {
        const named = given === 'select' || given === 'accept' ? given : null;
        const open = state === 'done' && resumable;
        const next = open && (toolWait || !named) ? kind : named || 'accept';
        const changed = next !== (open ? kind : null);
        hooked = true; resumable = true; kind = next;
        if (tool) toolWait = true; else if (!open) toolWait = false;
        if (state !== 'done') set('done');
        else if (changed) onChange(state); // the same state with another kind: the activity feeds tell it too
      } else if (event === 'end') {
        hooked = false; resumable = false;
        if (state === 'running') set('done');
      } else {
        return false;
      }
      return true;
    },
    // The user opened the terminal and saw the result. A question that waits for an answer stays until it is answered: seeing it does not
    // answer it.
    acknowledge() { if (state === 'done' && !resumable) set('idle'); },
    stop() { stopPolling(); },
  };
}

module.exports = { createActivityTracker, foregroundCommand, isShellForeground, baseName, parsePs, INTERACTIVE };
