const path = require('path');
const { createPollClock, sharedClock } = require('./terminal-poll');

// Programs that crash or are killed cannot turn off the terminal modes they
// enabled, so mouse reports keep flowing into the shell as garbage text.
const RESET_INPUT_MODES = ['9', '1000', '1001', '1002', '1003', '1004', '1005', '1006', '1015', '1016']
  .map(mode => `\x1b[?${mode}l`).join('') + '\x1b[?25h';

/**
 * Calls onShellReturn when the PTY foreground changes from a program back to the shell. Polled by the shared clock of
 * lib/terminal-poll.js (the same tick, and the same read of pty.process, as the terminal's activity tracker); `every` is an own
 * period in ms (tests) or another poll clock. Answers the function that stops the watch.
 */
function watchShellReturn(pty, shell, onShellReturn, every) {
  const clock = typeof every === 'number' ? createPollClock({ fastMs: every, slowMs: every }) : (every || sharedClock);
  const shellName = path.basename(shell);
  let inShell = true;
  return clock.subscribe(() => {
    let name;
    try { name = path.basename(String(clock.processOf(pty) || '')).replace(/^-/, ''); } catch { return; }
    if (!name) return;
    const nowInShell = name === shellName;
    if (nowInShell && !inShell) onShellReturn();
    inShell = nowInShell;
  });
}

module.exports = { RESET_INPUT_MODES, watchShellReturn };
