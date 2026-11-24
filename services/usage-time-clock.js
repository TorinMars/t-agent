// The session clocks of this engine ("Session clocks" in docs/design/usage-time.md): agent_working (a session is Running, from the same activity
// state the task list shows; also with no page open) and waiting_you (from the moment a session needs the person, an approval, a selection or a
// question, until their next input to that terminal or until it stops waiting). Seconds per (UTC hour, task, session, kind), kept in memory and
// written to usage_time every 60 s, when a terminal ends and at shutdown (services/usage-time.js recordSession). No page is needed.
//
// The feed (routes/terminal.js clockSnapshot) lists the terminals that are running or waiting now: [{ task_id, terminal_id, state, agent }]. It is
// read on every activity change (observe), on every input to a terminal (input) and every `pollMs` (a missed change cannot leave a clock running
// wrong for long). Between two reads a terminal is in the state of the earlier read, so the time of a change is the time it is observed.
// An agent turn longer than 30 minutes (one stretch of Running) is told to `onLongTurn` when it ends.
const HOUR = 60 * 60 * 1000;
const FLUSH_MS = 60 * 1000;
const POLL_MS = 15 * 1000;
const LONG_TURN_MS = 30 * 60 * 1000;
const AGENT_KINDS = new Set(['claude', 'codex', 'opencode', 'notebook']);
const kindOf = agent => (AGENT_KINDS.has(agent) ? agent : 'terminal');

function createUsageClock({
  feed, record, instanceId, now = Date.now, onLongTurn = null, flushMs = FLUSH_MS, pollMs = POLL_MS, longTurnMs = LONG_TURN_MS,
  timers = { setInterval, clearInterval }, log = console,
} = {}) {
  const terminals = new Map(); // `${task}|${terminal}` -> { task, session, kind, state, last, waitStart, answered, runStart }
  const pending = new Map(); // `${hourStart}|${session}` -> { start, task, session, kind, working, waiting, waits: [] } (ms)

  const ids = (taskId, terminalId) => {
    const instance = instanceId();
    if (!instance) return null;
    return { task: `${instance}|${Number(taskId)}`, session: `${instance}|${Number(taskId)}|${terminalId}` };
  };
  function bucket(start, term) {
    const key = `${start}|${term.session}`;
    let entry = pending.get(key);
    if (!entry) { entry = { start, task: term.task, session: term.session, kind: term.kind, working: 0, waiting: 0, waits: [] }; pending.set(key, entry); }
    entry.kind = term.kind;
    return entry;
  }
  // Adds the time from the terminal's last account to `to` to its state, split at the hours.
  function account(term, to) {
    let from = term.last;
    const counting = term.state === 'running' || (term.state === 'waiting' && !term.answered);
    while (counting && from < to) {
      const start = Math.floor(from / HOUR) * HOUR;
      const end = Math.min(to, start + HOUR);
      const entry = bucket(start, term);
      if (term.state === 'running') entry.working += end - from; else entry.waiting += end - from;
      from = end;
    }
    term.last = Math.max(term.last, to);
  }
  // A wait ends (an input, or the terminal stopped waiting): its length goes to the hour it ended in.
  function endWait(term, at) {
    if (term.waitStart === null) return;
    const seconds = Math.round((at - term.waitStart) / 1000);
    if (seconds >= 1) bucket(Math.floor(at / HOUR) * HOUR, term).waits.push(seconds);
    term.waitStart = null;
  }
  function endRun(term, at, key) {
    if (term.runStart === null) return;
    const length = at - term.runStart;
    term.runStart = null;
    if (length >= longTurnMs && typeof onLongTurn === 'function') {
      const [taskId, terminalId] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
      try { onLongTurn({ task_id: Number(taskId), terminal_id: terminalId, task: term.task, session: term.session, kind: term.kind, seconds: Math.round(length / 1000), at }); } catch { /* a memory is never the clock's problem */ }
    }
  }
  function setState(term, state, at, key) {
    if (term.state === state) return;
    if (term.state === 'waiting') endWait(term, at);
    if (term.state === 'running') endRun(term, at, key);
    term.state = state;
    term.answered = false;
    if (state === 'waiting') term.waitStart = at;
    if (state === 'running') term.runStart = at;
  }

  // Reads the feed: every known terminal is accounted up to now under its old state, then takes its new one; a terminal no longer listed is idle.
  function observe() {
    const at = now();
    let live;
    try { live = feed() || []; } catch (error) { log.warn(`Usage time: the session clocks could not read the terminals (${error.message})`); return; }
    const seen = new Set();
    for (const entry of live) {
      const key = `${Number(entry.task_id)}|${entry.terminal_id}`;
      const refs = ids(entry.task_id, entry.terminal_id);
      if (!refs) continue;
      seen.add(key);
      const state = entry.state === 'running' ? 'running' : entry.state === 'waiting' ? 'waiting' : 'idle';
      let term = terminals.get(key);
      if (!term) {
        term = { ...refs, kind: kindOf(entry.agent), state: 'idle', last: at, waitStart: null, answered: false, runStart: null };
        terminals.set(key, term);
      }
      account(term, at);
      term.kind = kindOf(entry.agent);
      setState(term, state, at, key);
    }
    for (const [key, term] of terminals) {
      if (seen.has(key)) continue;
      account(term, at);
      setState(term, 'idle', at, key);
      terminals.delete(key);
    }
  }
  // Input to a terminal: a wait there is answered from now on.
  function input(taskId, terminalId) {
    const key = `${Number(taskId)}|${terminalId}`;
    const term = terminals.get(key);
    if (!term || term.state !== 'waiting' || term.answered) return;
    const at = now();
    account(term, at);
    endWait(term, at);
    term.answered = true;
  }

  // Writes the whole seconds of every pending hour; the rest of a second stays for the next write (a past hour is rounded and done).
  function flush() {
    observe();
    const current = Math.floor(now() / HOUR) * HOUR;
    for (const [key, entry] of pending) {
      const past = entry.start < current;
      const working = past ? Math.round(entry.working / 1000) : Math.floor(entry.working / 1000);
      const waiting = past ? Math.round(entry.waiting / 1000) : Math.floor(entry.waiting / 1000);
      if (working || waiting || entry.waits.length) {
        try { record({ at: entry.start, task: entry.task, session: entry.session, kind: entry.kind, working, waiting, waits: entry.waits }); } catch (error) { log.warn(`Usage time: the session clocks could not be written (${error.message})`); }
      }
      entry.working -= working * 1000;
      entry.waiting -= waiting * 1000;
      entry.waits = [];
      if (past) pending.delete(key);
    }
  }

  let flushTimer = null;
  let pollTimer = null;
  function start() {
    if (flushTimer) return;
    observe();
    flushTimer = timers.setInterval(flush, flushMs);
    pollTimer = timers.setInterval(observe, pollMs);
    if (flushTimer && flushTimer.unref) flushTimer.unref();
    if (pollTimer && pollTimer.unref) pollTimer.unref();
  }
  // Shutdown: the last seconds are written (synchronous, so it works inside process.on('exit')).
  function stop() {
    if (flushTimer) timers.clearInterval(flushTimer);
    if (pollTimer) timers.clearInterval(pollTimer);
    flushTimer = null;
    pollTimer = null;
    try { flush(); } catch { /* shutting down anyway */ }
  }

  return { start, stop, observe, input, flush, ended: () => { observe(); flush(); }, state: () => [...terminals.values()].map(term => ({ ...term })), pendingCount: () => pending.size };
}

module.exports = { createUsageClock, kindOf, FLUSH_MS, POLL_MS, LONG_TURN_MS };
