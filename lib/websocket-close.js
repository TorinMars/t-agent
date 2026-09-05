const FORBIDDEN_CLOSE_CODES = new Set([1004, 1005, 1006, 1015]);

function isSendableCloseCode(code) {
  const value = Number(code);
  if (!Number.isInteger(value)) return false;
  if (value >= 3000 && value <= 4999) return true;
  return value >= 1000 && value <= 1014 && !FORBIDDEN_CLOSE_CODES.has(value);
}

function closeWebSocket(socket, code, reason = '') {
  if (!socket || socket.readyState !== 1) return false;
  if (!isSendableCloseCode(code)) socket.close();
  else socket.close(Number(code), reason.toString());
  return true;
}

module.exports = { isSendableCloseCode, closeWebSocket };
