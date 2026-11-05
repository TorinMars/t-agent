// Terminal WebSocket protocol of the page (public/js/h5.js).
//
// Terminal output and typed input travel in text frames. Control messages (history snapshot, history pages, resize,
// ping/pong) travel in BINARY frames that hold JSON, so program output or pasted text can never be mistaken for a
// control message. The client asks for this with `proto=2` in the WebSocket URL.
//   - New server + new client: controls are binary in both directions; every text frame is plain data.
//   - Old server (ignores proto=2): it sends the history as a text frame and accepts binary JSON controls too (it only
//     looks at the text of the message), so the client falls back to the old text parsing for that connection.
//   - Old client (no proto=2): the server keeps the old behaviour for that connection.
// The mode of a connection is decided by the first control message the server sends (the history snapshot).
const TerminalProtocol = (() => {
  const PING_MS = 15000;      // how often a ping is sent while the connection is quiet
  const TIMEOUT_MS = 40000;   // no frame at all for this long: the connection is half open
  const PROBE_MS = 5000;      // after the page comes back, the server must answer within this time
  const states = new WeakMap();
  const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

  function state(ws) {
    let value = states.get(ws);
    if (!value) states.set(ws, value = { mode: null }); // null: unknown yet, 'binary': new server, 'text': old server
    return value;
  }
  const query = () => '&proto=2';

  function send(ws, message) {
    ws.send(encoder.encode(JSON.stringify(message)));
  }

  // Returns the control message in a frame, or null when the frame is terminal output.
  function parse(ws, data) {
    const st = state(ws);
    if (typeof data === 'string') {
      if (st.mode === 'binary' || !data.startsWith('{')) return null;
      let message;
      try { message = JSON.parse(data); } catch { return null; }
      // An old server sends its history and history pages as text. Nothing else is a control message there.
      if (!message || (message.type !== 'history' && message.type !== 'history-page')) return null;
      if (st.mode === null && message.type !== 'history') return null;
      st.mode = 'text';
      return message;
    }
    if (st.mode === 'text' || !data || !decoder) return null;
    try {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      const message = JSON.parse(decoder.decode(bytes));
      if (!message || typeof message.type !== 'string') return null;
      st.mode = 'binary';
      return message;
    } catch { return null; }
  }

  // Liveness check. Only a server that speaks the binary protocol answers pings, so nothing is sent to an old one.
  // `onDead` runs once when the connection looks half open; the caller closes it and reconnects.
  function heartbeat(ws, onDead, { pingMs = PING_MS, timeoutMs = TIMEOUT_MS, probeMs = PROBE_MS, now = Date.now,
    doc = typeof document !== 'undefined' ? document : null } = {}) {
    let last = now(), stopped = false, probe = null;
    const dead = () => { if (stopped) return; stop(); onDead(); };
    const ping = () => { try { if (ws.readyState === 1) send(ws, { type: 'ping' }); } catch { /* closing */ } };
    const timer = setInterval(() => {
      if (state(ws).mode !== 'binary') return;
      if (now() - last > timeoutMs) { dead(); return; }
      ping();
    }, pingMs);
    function onVisible() {
      if (doc.visibilityState !== 'visible' || state(ws).mode !== 'binary' || probe) return;
      const asked = now();
      ping();
      probe = setTimeout(() => { probe = null; if (last < asked) dead(); }, probeMs);
    }
    doc?.addEventListener?.('visibilitychange', onVisible);
    function stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(probe);
      doc?.removeEventListener?.('visibilitychange', onVisible);
    }
    return { touch() { last = now(); }, stop, probe: onVisible };
  }

  return { query, send, parse, state, heartbeat, PING_MS, TIMEOUT_MS, PROBE_MS };
})();
if (typeof module !== 'undefined') module.exports = TerminalProtocol;
