// The open T-Agent pages of this machine that can be told to show a terminal in place ("Open session" of the desktop window, POST
// /api/attention/widget/open-terminal in routes/attention-widget.js). Kept only in memory.
//
// A page registers through the stream it already keeps open: the session stream of T-Attention, GET /api/attention/stream?tab=1 (routes/attention.js,
// scripts/h5-shell/attention-feed.mjs). Only a top-level page asks with tab=1 (the columns of the multi-column view open no stream), and the route
// registers it only when it comes from this machine (lib/terminal-relay-auth.js fromThisMachine), so phones and other devices are never told.
// The stream stays open while the page is hidden, so a background tab can be switched too.
//
// The page says when it was last seen: on connect when it is visible, and again when it becomes visible or gets the focus (POST
// /api/attention/stream/seen). openTerminal tells exactly one page: the one seen last; among pages never seen, the one that connected last.
const crypto = require('node:crypto');

function createPageChannel({ now = Date.now, randomId = () => crypto.randomBytes(12).toString('base64url') } = {}) {
  const streams = new Map(); // id -> { write, origin, connectedAt, seenAt, order }
  let order = 0;

  // stream: { write(event, data), origin }. Returns the stream's id, which the page gets in its `hello` event.
  function add({ write, origin = null } = {}) {
    if (typeof write !== 'function') throw new Error('A page stream needs write(event, data)');
    let id = randomId();
    while (streams.has(id)) id = randomId();
    order += 1;
    streams.set(id, { write, origin: typeof origin === 'string' && origin ? origin : null, connectedAt: now(), seenAt: 0, order });
    return id;
  }

  function remove(id) { return streams.delete(id); }

  function seen(id) {
    const stream = typeof id === 'string' ? streams.get(id) : null;
    if (!stream) return false;
    stream.seenAt = now();
    return true;
  }

  // The page seen last (a page never seen counts as seen at 0), then the one that connected last.
  function latest() {
    let best = null;
    for (const [id, stream] of streams) {
      if (!best || stream.seenAt > best.stream.seenAt || (stream.seenAt === best.stream.seenAt
        && (stream.connectedAt > best.stream.connectedAt || (stream.connectedAt === best.stream.connectedAt && stream.order > best.stream.order)))) {
        best = { id, stream };
      }
    }
    return best;
  }

  // Tells one page to open this terminal: { delivered: 1, origin } or { delivered: 0, origin: null } when no page is open (or its write fails).
  function openTerminal({ engine, task_id: taskId, terminal_id: terminalId }) {
    const best = latest();
    if (!best) return { delivered: 0, origin: null };
    try {
      best.stream.write('open-terminal', { engine, task_id: String(taskId), terminal_id: terminalId });
    } catch {
      streams.delete(best.id);
      return { delivered: 0, origin: null };
    }
    return { delivered: 1, origin: best.stream.origin };
  }

  return { add, remove, seen, openTerminal, size: () => streams.size };
}

let shared = null;
const getPageChannel = () => { if (!shared) shared = createPageChannel(); return shared; };

module.exports = { createPageChannel, getPageChannel };
