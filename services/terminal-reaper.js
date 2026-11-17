'use strict';
// Terminates the foreground job of each terminal's tty when a terminal closes or the server exits.
// node-pty's kill() only sends SIGHUP to the shell. Agent CLIs such as Codex ignore SIGHUP, survive as
// orphans and keep holding their session lock (~/.codex/thread-writer-locks/<id>.lock), so the reopened
// terminal's `codex resume` reports "This conversation is open in another app".
// Only the foreground process group is signalled: background jobs (`cmd &`, `nohup`) live in other
// groups and are left alone, so whatever the user detached on purpose keeps running.
const { spawnSync } = require('child_process');

const PS_ARGS = ['-axo', 'pid=,ppid=,pgid=,tpgid='];
const POLL_MS = 50;

function parseTable(psOutput) {
  const rows = new Map();
  for (const line of String(psOutput || '').split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length !== 4 || !cols.every(c => /^-?\d+$/.test(c))) continue;
    const [pid, ppid, pgid, tpgid] = cols.map(Number);
    rows.set(pid, { ppid, pgid, tpgid });
  }
  return rows;
}

// For each shell, the foreground group of its terminal (its tpgid), unless that is the shell itself,
// pgid <= 1, or the server's own group.
function foregroundGroups(shellPids, psOutput) {
  const rows = parseTable(psOutput);
  const own = rows.get(process.pid);
  const ownGroup = own ? own.pgid : null;
  const groups = new Set();
  for (const raw of shellPids || []) {
    const pid = Number(raw);
    const row = rows.get(pid);
    if (!row) continue;
    const group = row.tpgid;
    if (!Number.isInteger(group) || group <= 1 || group === pid || group === ownGroup) continue;
    groups.add(group);
  }
  return [...groups];
}

function readProcessTable() {
  if (process.platform === 'win32') return null;
  try {
    const out = spawnSync('ps', PS_ARGS, { encoding: 'utf8', timeout: 1500, maxBuffer: 16 * 1024 * 1024 });
    if (out.error || out.status !== 0) return null;
    return out.stdout;
  } catch {
    return null;
  }
}

// Sends a signal to a group; false when the group is gone or not ours (ESRCH / EPERM / anything else).
function signal(kill, group, sig) {
  try {
    kill(-group, sig);
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function groupsFor(shellPids, table) {
  if (!Array.isArray(shellPids) || !shellPids.length) return [];
  let text = null;
  try { text = table(); } catch { text = null; }
  return text == null ? [] : foregroundGroups(shellPids, text);
}

// For the exit handler, where nothing asynchronous runs any more.
function reapSync(shellPids, { graceMs = 700, kill = process.kill, table = readProcessTable, sleep = sleepSync } = {}) {
  try {
    const groups = groupsFor(shellPids, table);
    let alive = groups.filter(g => signal(kill, g, 'SIGTERM'));
    const deadline = Date.now() + graceMs;
    while (alive.length && Date.now() < deadline) {
      sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
      alive = alive.filter(g => signal(kill, g, 0));
    }
    const killed = alive.filter(g => signal(kill, g, 'SIGKILL'));
    return { groups, killed };
  } catch {
    return { groups: [], killed: [] };
  }
}

// For closing or restarting one terminal while the server keeps running.
function reap(shellPids, { graceMs = 3000, kill = process.kill, table = readProcessTable } = {}) {
  return new Promise(resolve => {
    try {
      const groups = groupsFor(shellPids, table);
      const alive = groups.filter(g => signal(kill, g, 'SIGTERM'));
      if (!alive.length) return resolve({ groups, killed: [] });
      const timer = setTimeout(() => {
        try {
          const killed = alive.filter(g => signal(kill, g, 0) && signal(kill, g, 'SIGKILL'));
          resolve({ groups, killed });
        } catch {
          resolve({ groups, killed: [] });
        }
      }, graceMs);
      if (timer.unref) timer.unref();
    } catch {
      resolve({ groups: [], killed: [] });
    }
  });
}

module.exports = { foregroundGroups, readProcessTable, reapSync, reap };
