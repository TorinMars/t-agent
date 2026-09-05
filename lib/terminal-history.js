// Remove terminal capability/status queries before replaying recorded PTY output.
// Replaying these queries would make xterm answer them again and leak the answer
// into the live shell. All other control sequences must remain byte-for-byte
// intact because full-screen TUIs depend on cursor and alternate-screen modes.
function prepareTerminalHistoryBuffer(buffer) {
  return String(buffer || '')
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*c/g, '')
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*n/g, '');
}

module.exports = { prepareTerminalHistoryBuffer };
