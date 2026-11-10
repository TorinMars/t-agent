// When each terminal last got input from a person, local or through the remote terminal proxy. The automatic update waits for a quiet time (services/auto-update.js).
const MAX_TERMINALS = 2048;
const lastInput = new Map();

function noteTerminalInput(key, at = Date.now()) {
  lastInput.delete(key); // re-inserted, so the Map stays ordered from the oldest input to the newest
  lastInput.set(key, at);
  if (lastInput.size > MAX_TERMINALS) lastInput.delete(lastInput.keys().next().value);
}

function recentInputTimes() { return [...lastInput.values()]; }

// Whether a frame sent to a terminal socket is input for the shell, by the same rules as routes/terminal.js: with proto=2 only binary frames are control messages;
// older clients send control messages as JSON text with a `type`.
function isTerminalInputFrame(data, isBinary, binaryControl) {
  if (binaryControl) return !isBinary;
  const text = String(data);
  if (!/^\s*\{/.test(text)) return true;
  try {
    const message = JSON.parse(text);
    return !(message && typeof message.type === 'string');
  } catch { return true; }
}

module.exports = { noteTerminalInput, recentInputTimes, isTerminalInputFrame };
