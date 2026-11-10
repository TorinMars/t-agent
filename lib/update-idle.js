// Decides whether the service may restart for an automatic update. Pure: the caller gives a snapshot of what is going on and gets the reasons not to restart.
// A restart ends every PTY and loses the in-memory terminal text, so anything that cannot come back afterwards blocks it.
const { INTERACTIVE, isShellForeground } = require('./terminal-activity');

// The agent of the terminal owns the foreground, and no other interactive program does (a vim opened from inside the agent shows up beside it).
function agentInForeground(terminal) {
  const names = terminal.foreground;
  return Boolean(terminal.agent) && names.includes(terminal.agent)
    && !names.some(name => INTERACTIVE.has(name) && name !== terminal.agent);
}

function isRunning(terminal) {
  return terminal.state === 'running' || terminal.subagents > 0 || terminal.awaiting === true;
}

function blocksAsProgram(terminal) {
  // An unknown foreground is treated as a program: nothing restarts blind.
  if (!terminal.foreground.length) return true;
  if (isShellForeground(terminal.foreground, terminal.shell)) return false;
  return !(agentInForeground(terminal) && terminal.resumable === true);
}

/**
 * snapshot: {
 *   terminals: [{ state, subagents, awaiting, foreground: [names], shell, agent, resumable }],
 *   chat: { running, queued },
 *   inputs: [ms timestamps of the last input, one per terminal],
 * }
 * Returns [{ code, count }]; an empty list means the service may restart. Throws on a snapshot of the wrong shape.
 */
function idleBlockers(snapshot, { quietMs, now }) {
  if (!snapshot || !Array.isArray(snapshot.terminals) || !snapshot.chat || !Array.isArray(snapshot.inputs)) throw new TypeError('INVALID_IDLE_SNAPSHOT');
  const terminals = snapshot.terminals.map(terminal => ({ ...terminal, foreground: terminal.foreground || [] }));
  const counts = [
    ['terminal_running', terminals.filter(isRunning).length],
    ['terminal_program', terminals.filter(blocksAsProgram).length],
    ['chat_running', (snapshot.chat.running || 0) + (snapshot.chat.queued || 0)],
    ['recent_input', snapshot.inputs.filter(at => now - at < quietMs).length],
  ];
  return counts.filter(([, count]) => count > 0).map(([code, count]) => ({ code, count }));
}

module.exports = { idleBlockers };
