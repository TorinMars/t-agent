// Foreground presence of terminals, as reported by the page over the terminal WebSocket (routes/terminal.js, control message
// { type: 'presence', foreground: boolean }), and of agent chats (services/agent-chat.js, POST .../presence tied to the chat's event stream).
// A key is in the foreground while at least one of its OPEN sockets last reported foreground: true AND was heard from (any frame: the page
// pings every 15 s, a chat page repeats its report every 20 s) in the last `staleMs`. A page that is frozen (a locked phone, a suspended app)
// stops talking, so its last "true" runs out by itself even when the socket stays open. A socket that closes (or is no longer open) drops out
// at once. Each socket may send at most `max` presence messages per `windowMs`; the rest are ignored (a flood keeps the last accepted value).
// seenSince(key, since): the key was in the foreground at some moment at or after `since` (now included), for a delayed notification.
// The T-Attention notifiers ask isForeground() / seenSince() before they send (services/attention-notify.js).
const OPEN = 1;
const SEEN_MAX = 2000; // keys whose last foreground moment is remembered after their sockets are gone

function createPresence({ now = () => Date.now(), windowMs = 10000, max = 20, staleMs = 50000 } = {}) {
  const byKey = new Map(); // key -> Map(socket -> { foreground, heard })
  const seen = new Map(); // key -> the last moment a socket that is gone or turned false was in the foreground
  const rate = new WeakMap(); // socket -> [times inside the window]

  function allowed(socket) {
    const at = now();
    const list = (rate.get(socket) || []).filter(time => at - time < windowMs);
    if (list.length >= max) { rate.set(socket, list); return false; }
    list.push(at);
    rate.set(socket, list);
    return true;
  }
  // The last moment this record counted as foreground (null: it did not).
  const lastForeground = record => (record && record.foreground ? Math.min(now(), record.heard + staleMs) : null);
  function remember(key, record) {
    const at = lastForeground(record);
    if (at === null) return;
    seen.delete(key); // re-inserted last, so the oldest key is the first one
    seen.set(key, Math.max(at, seen.get(key) || 0));
    if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value);
  }

  // Returns false when the message was ignored (malformed or over the rate cap).
  function report(key, socket, foreground) {
    if (typeof foreground !== 'boolean' || !socket) return false;
    if (!allowed(socket)) return false;
    let sockets = byKey.get(key);
    if (!sockets) byKey.set(key, sockets = new Map());
    remember(key, sockets.get(socket));
    sockets.set(socket, { foreground, heard: now() });
    return true;
  }

  // Any frame from the socket: the page is alive, so its last report still holds.
  function touch(key, socket) {
    const sockets = byKey.get(key);
    const record = sockets && sockets.get(socket);
    if (record) record.heard = now();
  }

  function drop(key, socket) {
    const sockets = byKey.get(key);
    if (!sockets) return;
    remember(key, sockets.get(socket));
    sockets.delete(socket);
    if (!sockets.size) byKey.delete(key);
  }

  // The open sockets of a key, the closed ones removed (their last foreground moment is remembered).
  function openSockets(key) {
    const sockets = byKey.get(key);
    if (!sockets) return null;
    for (const [socket, record] of sockets) {
      if (socket.readyState !== OPEN) { remember(key, record); sockets.delete(socket); } // closing or closed: never counted
    }
    if (!sockets.size) { byKey.delete(key); return null; }
    return sockets;
  }

  function isForeground(key) {
    const sockets = openSockets(key);
    if (!sockets) return false;
    const at = now();
    for (const record of sockets.values()) if (record.foreground && at - record.heard <= staleMs) return true;
    return false;
  }

  function seenSince(key, since) {
    if (isForeground(key)) return true;
    if (!Number.isFinite(since)) return false;
    let last = seen.has(key) ? seen.get(key) : null;
    const sockets = byKey.get(key);
    if (sockets) for (const record of sockets.values()) { const at = lastForeground(record); if (at !== null) last = Math.max(last === null ? at : last, at); }
    return last !== null && last >= since;
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

  return { report, touch, drop, isForeground, seenSince, snapshot };
}

module.exports = { createPresence };
