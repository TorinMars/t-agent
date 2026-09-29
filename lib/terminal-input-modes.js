const path = require('path');

// Programs that crash or are killed cannot turn off the terminal modes they
// enabled, so mouse reports keep flowing into the shell as garbage text.
const RESET_INPUT_MODES = ['9', '1000', '1001', '1002', '1003', '1004', '1005', '1006', '1015', '1016']
  .map(mode => `\x1b[?${mode}l`).join('') + '\x1b[?25h';

/** Calls onShellReturn when the PTY foreground changes from a program back to the shell. */
function watchShellReturn(pty, shell, onShellReturn, intervalMs = 500) {
  const shellName = path.basename(shell);
  let inShell = true;
  const timer = setInterval(() => {
    let name;
    try { name = path.basename(String(pty.process || '')).replace(/^-/, ''); } catch { return; }
    if (!name) return;
    const nowInShell = name === shellName;
    if (nowInShell && !inShell) onShellReturn();
    inShell = nowInShell;
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = { RESET_INPUT_MODES, watchShellReturn };
