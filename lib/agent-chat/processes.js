'use strict';
// The agent processes the chat mode started and that are still alive, and how they are ended when the server exits.
//
// Claude Code runs as the leader of its own process group (lib/agent-chat/claude.js) and can be kept alive for half an hour after its turn, for
// background tasks; `codex app-server` is a plain child (lib/agent-chat/codex-app-server.js). Neither ends just because the server does: an agent
// that is left behind keeps working with nobody to read it and keeps the lock of its session, so the chat cannot resume it after the restart.
//
// A registry knows only the children it was given, and forgets each one when Node has reaped it: from then on the pid can belong to anything.
const { spawnSync } = require('child_process');

const POLL_MS = 50;
const PS_ARGS = ['-axo', 'pid=,pgid=,stat='];

function createRegistry() {
  const live = new Map(); // pid -> { pid, group }
  return {
    // `group`: the child leads a process group of its own (it was spawned detached), so the whole group is ended with it.
    track(child, { group = false } = {}) {
      const pid = child && child.pid;
      if (!Number.isInteger(pid) || pid <= 1 || typeof child.once !== 'function') return child; // it did not start
      live.set(pid, { pid, group: Boolean(group) });
      child.once('exit', () => { live.delete(pid); });
      return child;
    },
    list: () => [...live.values()].map(entry => ({ ...entry })),
  };
}

// pid -> { pgid, zombie } of every process, or null when `ps` cannot say (Windows, a minimal ps).
function readStates() {
  if (process.platform === 'win32') return null;
  try {
    const out = spawnSync('ps', PS_ARGS, { encoding: 'utf8', timeout: 1500, maxBuffer: 16 * 1024 * 1024 });
    if (out.error || out.status !== 0) return null;
    const rows = new Map();
    for (const line of String(out.stdout || '').split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
      if (match) rows.set(Number(match[1]), { pgid: Number(match[2]), zombie: match[3].startsWith('Z') });
    }
    return rows.size ? rows : null;
  } catch {
    return null;
  }
}

// Sends a signal to the process, or to its whole group; false when it is gone or not ours (ESRCH / EPERM / anything else).
function send(kill, target, signal) {
  try {
    kill(target.group ? -target.pid : target.pid, signal);
    return true;
  } catch {
    return false;
  }
}

// A child that has ended stays a zombie until its parent reaps it, and nothing is reaped inside the exit handler: it still answers signal 0, so the
// process table decides. Without a table, signal 0 is all there is.
function ended(target, states) {
  if (!states) return false;
  if (!target.group) { const row = states.get(target.pid); return !row || row.zombie; }
  for (const row of states.values()) if (row.pgid === target.pid && !row.zombie) return false;
  return true;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Ends `targets` ([{ pid, group }]) for the exit handler, where nothing asynchronous runs any more: SIGTERM, a short wait, SIGKILL for what is
// still alive. It never throws. Returns what was signalled and what had to be killed.
function endSync(targets, { graceMs = 700, kill = process.kill, sleep = sleepSync, table = readStates } = {}) {
  try {
    const own = [];
    const seen = new Set();
    for (const target of Array.isArray(targets) ? targets : []) {
      const pid = target && target.pid;
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || seen.has(pid)) continue; // never the server itself, never "every process"
      seen.add(pid);
      own.push({ pid, group: Boolean(target.group) });
    }
    const signalled = own.filter(target => send(kill, target, 'SIGTERM'));
    let alive = signalled;
    const deadline = Date.now() + graceMs;
    while (alive.length && Date.now() < deadline) {
      sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
      alive = alive.filter(target => send(kill, target, 0));
      if (!alive.length) break;
      let states = null;
      try { states = table(); } catch { states = null; }
      alive = alive.filter(target => !ended(target, states));
    }
    const killed = alive.filter(target => send(kill, target, 'SIGKILL'));
    return { signalled, killed };
  } catch {
    return { signalled: [], killed: [] };
  }
}

module.exports = { createRegistry, endSync, readStates };
