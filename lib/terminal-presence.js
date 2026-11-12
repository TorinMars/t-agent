// Foreground presence of terminals, as reported by the page over the terminal WebSocket (routes/terminal.js, control message
// { type: 'presence', foreground: boolean }). A terminal is in the foreground while at least one of its OPEN sockets last reported
// foreground: true. The value lives with the socket only: a socket that closes (or is no longer open) drops out at once, so nothing is
// trusted beyond the socket's life. Each socket may send at most `max` presence messages per `windowMs`; the rest are ignored (a flood
// keeps the last accepted value). The T-Attention notifiers ask isForeground() before they send (services/attention-notify.js).
const OPEN = 1;

function createPresence({ now = () => Date.now(), windowMs = 10000, max = 20 } = {}) {
  const byKey = new Map(); // key -> Map(socket -> foreground)
  const rate = new WeakMap(); // socket -> [times inside the window]

  function allowed(socket) {
    const at = now();
    const list = (rate.get(socket) || []).filter(time => at - time < windowMs);
    if (list.length >= max) { rate.set(socket, list); return false; }
    list.push(at);
    rate.set(socket, list);
    return true;
  }

  // Returns false when the message was ignored (malformed or over the rate cap).
  function report(key, socket, foreground) {
    if (typeof foreground !== 'boolean' || !socket) return false;
    if (!allowed(socket)) return false;
    let sockets = byKey.get(key);
    if (!sockets) byKey.set(key, sockets = new Map());
    sockets.set(socket, foreground);
    return true;
  }

  function drop(key, socket) {
    const sockets = byKey.get(key);
    if (!sockets) return;
    sockets.delete(socket);
    if (!sockets.size) byKey.delete(key);
  }

  function isForeground(key) {
    const sockets = byKey.get(key);
    if (!sockets) return false;
    for (const [socket, foreground] of sockets) {
      if (socket.readyState !== OPEN) { sockets.delete(socket); continue; } // closing or closed: never counted
      if (foreground) return true;
    }
    if (!sockets.size) byKey.delete(key);
    return false;
  }

  // { [key]: { sockets, foreground } } for tests and debugging.
  function snapshot() {
    const out = {};
    for (const key of [...byKey.keys()]) {
      const foreground = isForeground(key);
      const sockets = byKey.get(key);
      if (sockets) out[key] = { sockets: sockets.size, foreground };
    }
    return out;
  }

  return { report, drop, isForeground, snapshot };
}

module.exports = { createPresence };
